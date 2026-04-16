import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import CDP from "chrome-remote-interface";
import {
  buildFirstSelectorLookupExpression,
  getRecommendSelectorRule
} from "./recommend-healing-config.js";

const currentFilePath = fileURLToPath(import.meta.url);
const packagedMcpDir = path.resolve(path.dirname(currentFilePath), "..");
const bossRecommendUrl = "https://www.zhipin.com/web/chat/recommend";
const bossLoginUrl = "https://www.zhipin.com/web/user/?ka=bticket";
const chromeOnboardingUrlPattern = /^chrome:\/\/(welcome|intro|newtab|signin|history-sync|settings\/syncSetup)/i;
const bossLoginUrlPattern = /(?:zhipin\.com\/web\/user(?:\/|\?|$)|passport\.zhipin\.com)/i;
const bossLoginTitlePattern = /登录|signin|扫码登录|BOSS直聘登录/i;
const screenConfigTemplateDefaults = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "replace-with-openai-api-key",
  model: "gpt-4.1-mini"
};
const LLM_THINKING_LEVEL_FIELDS = [
  "llmThinkingLevel",
  "thinkingLevel",
  "reasoningEffort",
  "reasoning_effort"
];
const DEFAULT_RECOMMEND_SCREEN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const PAGE_SCOPE_TO_TAB_STATUS = {
  recommend: "0",
  latest: "1",
  featured: "3"
};
const RECOMMEND_IFRAME_SELECTORS = getRecommendSelectorRule(
  ["top", "recommend_iframe"],
  ['iframe[name="recommendFrame"]', 'iframe[src*="/web/frame/recommend/"]', "iframe"]
);
const RECOMMEND_TAB_SELECTORS = getRecommendSelectorRule(
  ["frame", "tab_items"],
  ['li.tab-item[data-status]', 'li[data-status][class*="tab"]']
);
const RECOMMEND_CARD_SELECTORS = getRecommendSelectorRule(["frame", "recommend_cards"], ['ul.card-list > li.card-item']);
const FEATURED_CARD_SELECTORS = getRecommendSelectorRule(["frame", "featured_cards"], ['li.geek-info-card']);
const LATEST_CARD_SELECTORS = getRecommendSelectorRule(["frame", "latest_cards"], ['.candidate-card-wrap .card-inner[data-geek]', '.candidate-card-wrap [data-geek]']);
const DETAIL_POPUP_SELECTORS = getRecommendSelectorRule(
  ["detail", "popup"],
  [
    ".dialog-wrap.active",
    ".boss-popup__wrapper",
    ".boss-popup_wrapper",
    ".boss-dialog_wrapper",
    ".boss-dialog",
    ".resume-item-detail",
    ".geek-detail-modal",
    '[class*="popup"][class*="wrapper"]',
    '[class*="dialog"][class*="wrapper"]'
  ]
);
const DETAIL_RESUME_IFRAME_SELECTORS = getRecommendSelectorRule(
  ["detail", "resume_iframe"],
  ['iframe[src*="/web/frame/c-resume/"]', 'iframe[name*="resume"]']
);
const REFRESH_FINISHED_WRAP_SELECTORS = getRecommendSelectorRule(["frame", "refresh_finished_wrap"], [".finished-wrap"]);
const REFRESH_BUTTON_SELECTORS = getRecommendSelectorRule(
  ["frame", "refresh_button"],
  [".finished-wrap .btn.btn-refresh", ".finished-wrap .btn-refresh", ".no-data-refresh .btn-refresh"]
);

function buildRecommendIframeLookupExpression(rootExpr = "document") {
  return buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS, rootExpr);
}

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function getStateHome() {
  return process.env.BOSS_RECOMMEND_HOME
    ? path.resolve(process.env.BOSS_RECOMMEND_HOME)
    : path.join(os.homedir(), ".boss-recommend-mcp");
}

function getUserConfigPath() {
  return path.join(getStateHome(), "screening-config.json");
}

function getLegacyUserConfigPath() {
  return path.join(getCodexHome(), "boss-recommend-mcp", "screening-config.json");
}

function getUserCalibrationPath() {
  return path.join(getCodexHome(), "boss-recommend-mcp", "favorite-calibration.json");
}

function getDesktopDir() {
  return path.join(os.homedir(), "Desktop");
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function parsePositiveInteger(raw) {
  const value = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function serializeInputSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function normalizePageScope(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (["recommend", "推荐", "推荐页", "推荐页面"].includes(normalized)) return "recommend";
  if (["latest", "最新", "最新页", "最新页面"].includes(normalized)) return "latest";
  if (["featured", "精选", "精选页", "精选页面", "精选牛人"].includes(normalized)) return "featured";
  return null;
}

function shouldBringChromeToFront() {
  const envValue = normalizeText(process.env.BOSS_RECOMMEND_BRING_TO_FRONT || "").toLowerCase();
  if (envValue) {
    if (["1", "true", "yes", "y", "on"].includes(envValue)) return true;
    if (["0", "false", "no", "n", "off"].includes(envValue)) return false;
  }
  return false;
}

function isRootDirectory(targetPath) {
  const resolved = path.resolve(String(targetPath || ""));
  const parsed = path.parse(resolved);
  return resolved.toLowerCase() === String(parsed.root || "").toLowerCase();
}

function isSystemDirectoryWorkspaceRoot(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || ""));
  const normalized = root.replace(/\\/g, "/").toLowerCase();
  if (process.platform === "win32") {
    return (
      normalized.endsWith("/windows")
      || normalized.endsWith("/windows/system32")
      || normalized.endsWith("/windows/syswow64")
      || normalized.endsWith("/program files")
      || normalized.endsWith("/program files (x86)")
    );
  }
  return (
    normalized === "/system"
    || normalized.startsWith("/system/")
    || normalized === "/usr"
    || normalized.startsWith("/usr/")
    || normalized === "/bin"
    || normalized.startsWith("/bin/")
    || normalized === "/sbin"
    || normalized.startsWith("/sbin/")
  );
}

function shouldIgnoreWorkspaceConfigRoot(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || process.cwd()));
  const home = path.resolve(os.homedir());
  return (
    isEphemeralNpxWorkspaceRoot(root)
    || isRootDirectory(root)
    || root.toLowerCase() === home.toLowerCase()
    || isSystemDirectoryWorkspaceRoot(root)
  );
}

function resolveWorkspaceConfigCandidates(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || process.cwd()));
  if (shouldIgnoreWorkspaceConfigRoot(root)) {
    return [];
  }
  const directPath = path.join(root, "config", "screening-config.json");
  const nestedPath = path.join(root, "boss-recommend-mcp", "config", "screening-config.json");
  const candidates = [directPath];
  if (path.basename(root).toLowerCase() !== "boss-recommend-mcp") {
    candidates.push(nestedPath);
  }
  return Array.from(new Set(candidates));
}

function serializeDegreeSelection(value) {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item || "").trim()).filter(Boolean);
    return normalized.length ? normalized.join(",") : "不限";
  }
  const normalized = String(value || "").trim();
  return normalized || "不限";
}

function serializeSchoolTagSelection(value) {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item || "").trim()).filter(Boolean);
    if (!normalized.length) return "不限";
    if (normalized.includes("不限")) {
      return normalized.length === 1
        ? "不限"
        : normalized.filter((item) => item !== "不限").join(",");
    }
    return normalized.join(",");
  }
  const normalized = String(value || "").trim();
  return normalized || "不限";
}

function isEphemeralNpxWorkspaceRoot(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || ""));
  const normalized = root.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/appdata/local/npm-cache/_npx/")
    || normalized.includes("/node_modules/@reconcrap/boss-recommend-mcp")
  );
}

function buildScreenConfigCandidateMap(workspaceRoot) {
  return {
    env_path: process.env.BOSS_RECOMMEND_SCREEN_CONFIG
      ? path.resolve(process.env.BOSS_RECOMMEND_SCREEN_CONFIG)
      : null,
    workspace_paths: resolveWorkspaceConfigCandidates(workspaceRoot),
    user_path: getUserConfigPath(),
    legacy_path: getLegacyUserConfigPath()
  };
}

function resolveScreenConfigCandidates(workspaceRoot) {
  const candidateMap = buildScreenConfigCandidateMap(workspaceRoot);
  return [
    candidateMap.env_path,
    candidateMap.user_path,
    ...candidateMap.workspace_paths,
    candidateMap.legacy_path
  ].filter(Boolean);
}

function canWriteDirectory(targetDir) {
  try {
    ensureDir(targetDir);
    fs.accessSync(targetDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveWritableScreenConfigPath(workspaceRoot) {
  const candidateMap = buildScreenConfigCandidateMap(workspaceRoot);
  const workspacePreferred = candidateMap.workspace_paths?.[0] || null;
  if (candidateMap.env_path) {
    return candidateMap.env_path;
  }
  if (candidateMap.user_path && canWriteDirectory(path.dirname(candidateMap.user_path))) {
    return candidateMap.user_path;
  }
  if (workspacePreferred && canWriteDirectory(path.dirname(workspacePreferred))) {
    return workspacePreferred;
  }
  if (workspacePreferred) {
    return workspacePreferred;
  }
  return candidateMap.user_path || candidateMap.legacy_path;
}

function resolveScreenConfigPath(workspaceRoot) {
  const candidateMap = buildScreenConfigCandidateMap(workspaceRoot);
  if (candidateMap.env_path) {
    return candidateMap.env_path;
  }
  if (candidateMap.user_path && pathExists(candidateMap.user_path)) {
    return candidateMap.user_path;
  }
  const existingWorkspacePath = candidateMap.workspace_paths.find((item) => pathExists(item));
  if (existingWorkspacePath) {
    return existingWorkspacePath;
  }
  const writablePath = resolveWritableScreenConfigPath(workspaceRoot);
  if (writablePath) {
    return writablePath;
  }
  return candidateMap.legacy_path;
}

export function getScreenConfigResolution(workspaceRoot) {
  const candidateMap = buildScreenConfigCandidateMap(workspaceRoot);
  const candidate_paths = resolveScreenConfigCandidates(workspaceRoot);
  const resolved_path = resolveScreenConfigPath(workspaceRoot) || null;
  const workspace_root = path.resolve(String(workspaceRoot || process.cwd()));
  return {
    resolved_path,
    candidate_paths,
    workspace_root,
    workspace_ephemeral: isEphemeralNpxWorkspaceRoot(workspaceRoot),
    workspace_ignored_for_config: shouldIgnoreWorkspaceConfigRoot(workspace_root),
    writable_path: resolveWritableScreenConfigPath(workspaceRoot),
    legacy_path: candidateMap.legacy_path
  };
}

function readJsonFile(filePath) {
  if (!filePath || !pathExists(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function validateScreenConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {
      ok: false,
      reason: "INVALID_OR_MISSING_CONFIG",
      message: "screening-config.json 缺失或格式无效。请填写 baseUrl、apiKey、model。"
    };
  }
  const baseUrl = String(config.baseUrl || "").trim();
  const apiKey = String(config.apiKey || "").trim();
  const model = String(config.model || "").trim();
  const missing = [];
  if (!baseUrl) missing.push("baseUrl");
  if (!apiKey) missing.push("apiKey");
  if (!model) missing.push("model");
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "MISSING_REQUIRED_FIELDS",
      message: `screening-config.json 缺少必填字段：${missing.join(", ")}。`
    };
  }
  if (/^replace-with/i.test(apiKey) || apiKey === screenConfigTemplateDefaults.apiKey) {
    return {
      ok: false,
      reason: "PLACEHOLDER_API_KEY",
      message: "screening-config.json 的 apiKey 仍是模板占位符，请填写真实 API Key。"
    };
  }
  if (
    baseUrl === screenConfigTemplateDefaults.baseUrl
    && apiKey === screenConfigTemplateDefaults.apiKey
    && model === screenConfigTemplateDefaults.model
  ) {
    return {
      ok: false,
      reason: "PLACEHOLDER_TEMPLATE_VALUES",
      message: "screening-config.json 仍是默认模板值，请填写 baseUrl、apiKey、model。"
    };
  }
  return { ok: true, reason: "OK", message: "screening-config.json 校验通过。" };
}

function resolveLlmThinkingLevel(config = {}) {
  if (!config || typeof config !== "object") return "";
  for (const field of LLM_THINKING_LEVEL_FIELDS) {
    const value = String(config[field] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function resolveWorkspaceDebugPort(workspaceRoot) {
  const fromEnv = parsePositiveInteger(process.env.BOSS_RECOMMEND_CHROME_PORT);
  if (fromEnv) return fromEnv;
  const config = readJsonFile(resolveScreenConfigPath(workspaceRoot));
  return parsePositiveInteger(config?.debugPort) || 9222;
}

function getDefaultChromeExecutableCandidates() {
  const candidates = [process.env.BOSS_RECOMMEND_CHROME_PATH].filter(Boolean);
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium"
    );
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function getChromeExecutable() {
  const candidates = getDefaultChromeExecutableCandidates();
  return candidates.find((candidate) => pathExists(candidate)) || null;
}

function getChromeUserDataDir(port) {
  const profileDir = resolveDefaultChromeUserDataDir(port);
  ensureDir(profileDir);
  return profileDir;
}

function getSharedChromeUserDataDir(port) {
  return path.join(getCodexHome(), "boss-mcp", `chrome-profile-${port}`);
}

function getLegacyRecruitChromeUserDataDir(port) {
  return path.join(getCodexHome(), "boss-recruit-mcp", `chrome-profile-${port}`);
}

function getLegacyRecommendChromeUserDataDir(port) {
  return path.join(getStateHome(), `chrome-profile-${port}`);
}

function resolveDefaultChromeUserDataDir(port) {
  const sharedPath = getSharedChromeUserDataDir(port);
  if (pathExists(sharedPath)) {
    return sharedPath;
  }
  const legacyPaths = [
    getLegacyRecruitChromeUserDataDir(port),
    getLegacyRecommendChromeUserDataDir(port)
  ];
  const legacyExisting = legacyPaths.find((candidate) => pathExists(candidate));
  return legacyExisting || sharedPath;
}

function launchChromeWithDebugPort(port) {
  const chromePath = getChromeExecutable();
  if (!chromePath) {
    return {
      ok: false,
      code: "CHROME_EXECUTABLE_NOT_FOUND",
      message: "未找到 Chrome 可执行文件，请安装 Chrome 或设置 BOSS_RECOMMEND_CHROME_PATH。"
    };
  }
  const userDataDir = getChromeUserDataDir(port);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    bossRecommendUrl
  ];

  try {
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.unref();
    return {
      ok: true,
      code: "CHROME_LAUNCHED",
      chrome_path: chromePath,
      user_data_dir: userDataDir
    };
  } catch (error) {
    return {
      ok: false,
      code: "CHROME_LAUNCH_FAILED",
      message: error.message || "Chrome 启动失败。"
    };
  }
}

function resolveRecommendSearchCliDir(workspaceRoot) {
  const localDir = path.join(workspaceRoot, "boss-recommend-search-cli");
  if (pathExists(localDir)) return localDir;
  const vendoredDir = path.join(packagedMcpDir, "vendor", "boss-recommend-search-cli");
  if (pathExists(vendoredDir)) return vendoredDir;
  return null;
}

function resolveRecommendScreenCliDir(workspaceRoot) {
  const localDir = path.join(workspaceRoot, "boss-recommend-screen-cli");
  if (pathExists(localDir)) return localDir;
  const vendoredDir = path.join(packagedMcpDir, "vendor", "boss-recommend-screen-cli");
  if (pathExists(vendoredDir)) return vendoredDir;
  return null;
}

function resolveRecommendScreenCliEntry(screenDir) {
  const candidates = [
    path.join(screenDir, "boss-recommend-screen-cli.cjs"),
    path.join(screenDir, "boss-recommend-screen-cli.js")
  ];
  return candidates.find((candidate) => pathExists(candidate)) || candidates[0];
}

function resolveRecommendSearchCliEntry(searchDir) {
  const candidates = [
    path.join(searchDir, "src", "cli.js"),
    path.join(searchDir, "src", "cli.cjs")
  ];
  return candidates.find((candidate) => pathExists(candidate)) || candidates[0];
}

function parseKeyValueOutput(text) {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=");
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const value = trimmed.slice(sep + 1).trim();
    if (!key) continue;
    result[key] = value;
  }
  return result;
}

function runBossRecruitWhere() {
  const direct = runProcessSync({
    command: "boss-recruit-mcp",
    args: ["where"]
  });
  if (direct.ok) {
    return parseKeyValueOutput(direct.stdout);
  }

  if (process.platform !== "win32") {
    return null;
  }

  const fallback = runProcessSync({
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "boss-recruit-mcp where"]
  });
  if (!fallback.ok) return null;
  return parseKeyValueOutput(fallback.stdout);
}

function resolveRecruitCalibrationScriptPath(workspaceRoot) {
  const fromEnv = normalizeText(process.env.BOSS_RECOMMEND_RECRUIT_CALIBRATION_SCRIPT || "");
  const fromWhere = runBossRecruitWhere();
  const packageRootFromWhere = normalizeText(fromWhere?.package_root || "");
  const workspaceResolved = path.resolve(String(workspaceRoot || process.cwd()));
  const candidates = [
    fromEnv,
    packageRootFromWhere
      ? path.join(packageRootFromWhere, "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs")
      : null,
    path.join(workspaceResolved, "..", "boss-recruit-mcp-main", "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs"),
    path.join(packagedMcpDir, "..", "boss-recruit-mcp-main", "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs")
  ].filter(Boolean).map((item) => path.resolve(item));

  for (const candidate of new Set(candidates)) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getCalibrationTimeoutMs(raw) {
  const parsed = parsePositiveInteger(raw);
  if (!parsed) return 60000;
  return Math.max(5000, parsed);
}

function safeInvokeCallback(callback, payload) {
  if (typeof callback !== "function") return;
  try {
    callback(payload);
  } catch {
    // Ignore callback errors to keep pipeline runtime stable.
  }
}

function runProcess({
  command,
  args,
  cwd,
  timeoutMs,
  onOutput,
  onLine,
  onHeartbeat,
  heartbeatIntervalMs = 10_000,
  signal
}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";
    let settled = false;
    let timer = null;
    let heartbeatTimer = null;
    let abortedBySignal = Boolean(signal?.aborted);
    let abortListener = null;

    function notifyHeartbeat(source) {
      safeInvokeCallback(onHeartbeat, {
        source,
        command,
        args,
        cwd,
        at: new Date().toISOString()
      });
    }

    function emitLine(stream, line) {
      const normalized = String(line ?? "").replace(/\r$/, "");
      if (!normalized) return;
      safeInvokeCallback(onLine, {
        stream,
        line: normalized,
        at: new Date().toISOString()
      });
    }

    function pushLineBuffer(stream, chunkText) {
      if (stream === "stdout") {
        stdoutLineBuffer += chunkText;
      } else {
        stderrLineBuffer += chunkText;
      }
      let buffer = stream === "stdout" ? stdoutLineBuffer : stderrLineBuffer;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        emitLine(stream, buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
      if (stream === "stdout") {
        stdoutLineBuffer = buffer;
      } else {
        stderrLineBuffer = buffer;
      }
    }

    function finish(payload) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (signal && typeof signal.removeEventListener === "function" && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      emitLine("stdout", stdoutLineBuffer);
      emitLine("stderr", stderrLineBuffer);
      stdoutLineBuffer = "";
      stderrLineBuffer = "";
      resolve(payload);
    }

    if (abortedBySignal) {
      finish({
        code: -1,
        stdout,
        stderr: "Process aborted before spawn",
        error_code: "ABORTED"
      });
      return;
    }

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        shell: false,
        env: process.env
      });
    } catch (error) {
      finish({
        code: -1,
        stdout,
        stderr: error.message,
        error_code: error.code || "SPAWN_FAILED"
      });
      return;
    }

    if (signal && typeof signal.addEventListener === "function") {
      abortListener = () => {
        abortedBySignal = true;
        try {
          child.kill();
        } catch {}
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish({
          code: -1,
          stdout,
          stderr: `${stderr}\nProcess timed out after ${timeoutMs}ms`.trim(),
          error_code: "TIMEOUT"
        });
      }, timeoutMs);
    }

    if (Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        notifyHeartbeat("timer");
      }, heartbeatIntervalMs);
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pushLineBuffer("stdout", text);
      safeInvokeCallback(onOutput, {
        stream: "stdout",
        text,
        at: new Date().toISOString()
      });
      notifyHeartbeat("stdout");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      pushLineBuffer("stderr", text);
      safeInvokeCallback(onOutput, {
        stream: "stderr",
        text,
        at: new Date().toISOString()
      });
      notifyHeartbeat("stderr");
    });
    child.on("close", (code) => {
      if (abortedBySignal) {
        finish({
          code: -1,
          stdout,
          stderr: `${stderr}\nProcess aborted by signal`.trim(),
          error_code: "ABORTED"
        });
        return;
      }
      finish({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      finish({
        code: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        error_code: error.code || "SPAWN_FAILED"
      });
    });
  });
}

function runProcessSync({ command, args, cwd }) {
  try {
    const result = spawnSync(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: process.env,
      encoding: "utf8"
    });
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    return {
      ok: result.status === 0,
      status: result.status,
      stdout,
      stderr,
      output: [stdout, stderr].filter(Boolean).join("\n").trim(),
      error_code: result.error?.code || null,
      error_message: result.error?.message || null
    };
  } catch (error) {
    return {
      ok: false,
      status: -1,
      stdout: "",
      stderr: "",
      output: "",
      error_code: error.code || "SPAWN_FAILED",
      error_message: error.message || String(error)
    };
  }
}

function parseMajorVersion(raw) {
  const match = String(raw || "").match(/v?(\d+)(?:\.\d+){0,2}/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

function buildNodeCommandCheck() {
  const probe = runProcessSync({
    command: "node",
    args: ["--version"]
  });
  const major = parseMajorVersion(probe.output);
  const versionOk = Number.isInteger(major) && major >= 18;
  return {
    key: "node_cli",
    ok: probe.ok && versionOk,
    path: "node --version",
    message: probe.ok
      ? (versionOk
        ? `Node 命令可用 (${probe.output || "unknown version"})`
        : `Node 版本过低 (${probe.output || "unknown version"})，要求 >= 18`)
      : `未找到 node 命令，请先安装 Node.js >= 18。${probe.error_message ? ` (${probe.error_message})` : ""}`
  };
}

function buildNodePackageCheck({ key, moduleName, cwd, missingMessage }) {
  if (!cwd || !pathExists(cwd)) {
    return {
      key,
      ok: false,
      path: moduleName,
      module: moduleName,
      install_cwd: null,
      message: missingMessage
    };
  }
  const probe = runProcessSync({
    command: "node",
    args: ["-e", `require.resolve(${JSON.stringify(moduleName)});`],
    cwd
  });
  return {
    key,
    ok: probe.ok,
    path: moduleName,
    module: moduleName,
    install_cwd: cwd,
    message: probe.ok
      ? `${moduleName} npm 依赖可用`
      : `缺少 npm 依赖 ${moduleName}，请在 boss-recommend-mcp 目录执行 npm install。`
  };
}

function buildRuntimeDependencyChecks({ searchDir, screenDir }) {
  return [
    buildNodeCommandCheck(),
    buildNodePackageCheck({
      key: "npm_dep_chrome_remote_interface_search",
      moduleName: "chrome-remote-interface",
      cwd: searchDir,
      missingMessage: "无法校验 chrome-remote-interface：boss-recommend-search-cli 目录不存在。"
    }),
    buildNodePackageCheck({
      key: "npm_dep_chrome_remote_interface_screen",
      moduleName: "chrome-remote-interface",
      cwd: screenDir,
      missingMessage: "无法校验 chrome-remote-interface：boss-recommend-screen-cli 目录不存在。"
    }),
    buildNodePackageCheck({
      key: "npm_dep_ws",
      moduleName: "ws",
      cwd: screenDir,
      missingMessage: "无法校验 ws：boss-recommend-screen-cli 目录不存在。"
    }),
    buildNodePackageCheck({
      key: "npm_dep_sharp",
      moduleName: "sharp",
      cwd: screenDir,
      missingMessage: "无法校验 sharp：boss-recommend-screen-cli 目录不存在。"
    })
  ];
}

function parseJsonOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      continue;
    }
  }
  return null;
}

function createScreenProgressTracker(currentTracker = {}) {
  const outcome = String(currentTracker.outcome || "").trim();
  return {
    candidate_index: Number.isInteger(currentTracker.candidate_index) ? currentTracker.candidate_index : null,
    outcome: outcome === "pass" || outcome === "skip" ? outcome : null,
    action_failed: currentTracker.action_failed === true
  };
}

function finalizeCandidateProgress(progress, tracker) {
  if (!Number.isInteger(tracker.candidate_index)) {
    return false;
  }

  let changed = false;
  if (tracker.action_failed === true) {
    progress.skipped += 1;
    changed = true;
  } else if (tracker.outcome === "pass") {
    progress.passed += 1;
    changed = true;
  } else if (tracker.outcome === "skip") {
    progress.skipped += 1;
    changed = true;
  }

  tracker.candidate_index = null;
  tracker.outcome = null;
  tracker.action_failed = false;
  return changed;
}

function parseScreenProgressLine(line, currentProgress = {}, currentTracker = {}) {
  const normalizedLine = String(line || "").replace(/\s+/g, " ").trim();
  if (!normalizedLine) return null;

  const nextProgress = {
    processed: Number.isInteger(currentProgress.processed) ? currentProgress.processed : 0,
    passed: Number.isInteger(currentProgress.passed) ? currentProgress.passed : 0,
    skipped: Number.isInteger(currentProgress.skipped) ? currentProgress.skipped : 0,
    greet_count: Number.isInteger(currentProgress.greet_count) ? currentProgress.greet_count : 0
  };
  const nextTracker = createScreenProgressTracker(currentTracker);

  let changed = false;
  const processedMatch = normalizedLine.match(/处理第\s*(\d+)\s*位候选人/u);
  if (processedMatch) {
    if (finalizeCandidateProgress(nextProgress, nextTracker)) {
      changed = true;
    }
    const processed = Number.parseInt(processedMatch[1], 10);
    if (Number.isInteger(processed) && processed >= 0 && processed !== nextProgress.processed) {
      nextProgress.processed = processed;
      changed = true;
    }
    nextTracker.candidate_index = processed;
    nextTracker.outcome = null;
    nextTracker.action_failed = false;
  }

  if (/筛选结果:\s*通过/u.test(normalizedLine)) {
    if (nextTracker.outcome !== "pass" || nextTracker.action_failed) {
      changed = true;
    }
    nextTracker.outcome = "pass";
    nextTracker.action_failed = false;
  } else if (/筛选结果:\s*不通过/u.test(normalizedLine)) {
    if (nextTracker.outcome !== "skip" || nextTracker.action_failed) {
      changed = true;
    }
    nextTracker.outcome = "skip";
    nextTracker.action_failed = false;
  }

  if (/候选人处理失败\s*:/u.test(normalizedLine)) {
    if (!nextTracker.action_failed) {
      changed = true;
    }
    nextTracker.action_failed = true;
  }

  if (/^\[关闭详情\].*成功/u.test(normalizedLine)) {
    if (finalizeCandidateProgress(nextProgress, nextTracker)) {
      changed = true;
    }
  }

  const finalStateLine = /Process timed out after|status"\s*:\s*"(?:COMPLETED|PAUSED|FAILED)"/iu.test(normalizedLine);
  if (finalStateLine) {
    if (finalizeCandidateProgress(nextProgress, nextTracker)) {
      changed = true;
    }
  }

  const greetMatch = normalizedLine.match(/greet[_\s-]*count\s*[:=]\s*(\d+)/iu);
  if (greetMatch) {
    const greetCount = Number.parseInt(greetMatch[1], 10);
    if (Number.isInteger(greetCount) && greetCount >= 0 && greetCount !== nextProgress.greet_count) {
      nextProgress.greet_count = greetCount;
      changed = true;
    }
  }

  if (!changed) return null;
  return {
    line: normalizedLine,
    progress: nextProgress,
    tracker: nextTracker
  };
}

function resolveRecommendScreenTimeoutMs(runtime = null) {
  const runtimeTimeoutMs = parsePositiveInteger(runtime?.timeoutMs);
  const envTimeoutMs = parsePositiveInteger(process.env.BOSS_RECOMMEND_SCREEN_TIMEOUT_MS);
  return runtimeTimeoutMs || envTimeoutMs || DEFAULT_RECOMMEND_SCREEN_TIMEOUT_MS;
}

function buildRecommendScreenProcessError(result, screenTimeoutMs) {
  if (result.code === 0) return null;
  if (result.error_code === "TIMEOUT") {
    return {
      code: "TIMEOUT",
      message: `推荐页筛选命令执行超时（${screenTimeoutMs}ms）。`
    };
  }
  if (result.error_code === "ABORTED") {
    return {
      code: "PROCESS_ABORTED",
      message: "推荐页筛选命令已取消。"
    };
  }
  return {
    code: "RECOMMEND_SCREEN_FAILED",
    message: "推荐页筛选命令执行失败。"
  };
}

function loadScreenConfig(configPath) {
  const parsed = readJsonFile(configPath);
  const validation = validateScreenConfig(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      error: `${validation.message} (path: ${configPath})`
    };
  }
  return { ok: true, config: parsed };
}

function localDirHint(workspaceRoot, dirName) {
  return path.join(workspaceRoot, dirName);
}

export function getFeaturedCalibrationResolution(workspaceRoot) {
  const calibration_path = resolveFavoriteCalibrationPath(workspaceRoot);
  const calibration_exists = pathExists(calibration_path);
  const calibration_usable = isUsableCalibrationFile(calibration_path);
  const calibration_script_path = resolveRecruitCalibrationScriptPath(workspaceRoot);
  return {
    calibration_path,
    calibration_exists,
    calibration_usable,
    calibration_script_path
  };
}

export async function runRecommendCalibration(
  workspaceRoot,
  options = {}
) {
  const debugPort = parsePositiveInteger(options.port) || resolveWorkspaceDebugPort(workspaceRoot);
  const calibrationPath = options.output
    ? path.resolve(String(options.output))
    : resolveFavoriteCalibrationPath(workspaceRoot);
  const timeoutMs = getCalibrationTimeoutMs(options.timeoutMs);
  const calibrationScriptPath = resolveRecruitCalibrationScriptPath(workspaceRoot);

  if (!calibrationScriptPath) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      calibration_path: calibrationPath,
      calibration_script_path: null,
      debug_port: debugPort,
      error: {
        code: "CALIBRATION_SCRIPT_MISSING",
        message: "未找到 boss-recruit-mcp 校准脚本 calibrate-favorite-position-v2.cjs。"
      }
    };
  }

  ensureDir(path.dirname(calibrationPath));
  const result = await runProcess({
    command: "node",
    args: [
      calibrationScriptPath,
      "--port",
      String(debugPort),
      "--output",
      calibrationPath,
      "--timeout-ms",
      String(timeoutMs)
    ],
    cwd: path.dirname(calibrationScriptPath),
    timeoutMs: timeoutMs + 15_000,
    heartbeatIntervalMs: options.runtime?.heartbeatIntervalMs,
    signal: options.runtime?.signal,
    onOutput: (event) => {
      safeInvokeCallback(options.runtime?.onOutput, event);
    },
    onHeartbeat: (event) => {
      safeInvokeCallback(options.runtime?.onHeartbeat, event);
    }
  });

  const usable = isUsableCalibrationFile(calibrationPath);
  const ok = result.code === 0 && usable;
  return {
    ok,
    stdout: result.stdout,
    stderr: result.stderr,
    calibration_path: calibrationPath,
    calibration_script_path: calibrationScriptPath,
    debug_port: debugPort,
    auto_started: true,
    error: ok
      ? null
      : {
          code: result.error_code === "ABORTED"
            ? "CALIBRATION_ABORTED"
            : result.error_code === "TIMEOUT"
              ? "CALIBRATION_TIMEOUT"
              : "CALIBRATION_FAILED",
          message: usable
            ? "校准脚本执行异常。"
            : "校准脚本未生成可用的 favorite-calibration.json。"
        }
  };
}

export async function ensureFeaturedCalibrationReady(
  workspaceRoot,
  options = {}
) {
  const calibrationPath = resolveFavoriteCalibrationPath(workspaceRoot);
  if (isUsableCalibrationFile(calibrationPath)) {
    return {
      ok: true,
      calibration_path: calibrationPath,
      auto_started: false
    };
  }
  if (options.autoCalibrate === false) {
    return {
      ok: false,
      calibration_path: calibrationPath,
      auto_started: false,
      error: {
        code: "CALIBRATION_REQUIRED",
        message: "精选页收藏缺少可用校准文件，需先在推荐页精选 tab 完成校准。"
      }
    };
  }
  const calibrationRun = await runRecommendCalibration(workspaceRoot, options);
  if (calibrationRun.ok) {
    return calibrationRun;
  }
  return {
    ...calibrationRun,
    ok: false,
    error: {
      code: "CALIBRATION_REQUIRED",
      message: calibrationRun.error?.message || "精选页收藏校准失败，请在推荐页精选 tab 重试校准。"
    }
  };
}

export function runPipelinePreflight(workspaceRoot, options = {}) {
  const pageScope = normalizePageScope(options.pageScope) || "recommend";
  const searchDir = resolveRecommendSearchCliDir(workspaceRoot);
  const screenDir = resolveRecommendScreenCliDir(workspaceRoot);
  const searchDirExists = Boolean(searchDir && pathExists(searchDir));
  const searchEntryPath = searchDir
    ? resolveRecommendSearchCliEntry(searchDir)
    : path.join(localDirHint(workspaceRoot, "boss-recommend-search-cli"), "src", "cli.js");
  const searchEntryExists = Boolean(searchDir && pathExists(searchEntryPath));
  const screenDirExists = Boolean(screenDir && pathExists(screenDir));
  const screenEntryPath = screenDir
    ? resolveRecommendScreenCliEntry(screenDir)
    : path.join(localDirHint(workspaceRoot, "boss-recommend-screen-cli"), "boss-recommend-screen-cli.cjs");
  const screenEntryExists = Boolean(screenDir && pathExists(screenEntryPath));
  const configResolution = getScreenConfigResolution(workspaceRoot);
  const screenConfigPath = configResolution.resolved_path;
  const screenConfigParsed = readJsonFile(screenConfigPath);
  const screenConfigValidation = validateScreenConfig(screenConfigParsed);
  const calibrationPath = resolveFavoriteCalibrationPath(workspaceRoot);
  const calibrationUsable = isUsableCalibrationFile(calibrationPath);
  const checks = [
    {
      key: "recommend_search_cli_dir",
      ok: searchDirExists,
      path: searchDir || localDirHint(workspaceRoot, "boss-recommend-search-cli"),
      message: searchDirExists
        ? "boss-recommend-search-cli 目录可用"
        : "boss-recommend-search-cli 目录不存在"
    },
    {
      key: "recommend_search_cli_entry",
      ok: searchEntryExists,
      path: searchEntryPath,
      message: searchEntryExists
        ? "boss-recommend-search-cli 入口文件可用"
        : "boss-recommend-search-cli 入口文件缺失"
    },
    {
      key: "recommend_screen_cli_dir",
      ok: screenDirExists,
      path: screenDir || localDirHint(workspaceRoot, "boss-recommend-screen-cli"),
      message: screenDirExists
        ? "boss-recommend-screen-cli 目录可用"
        : "boss-recommend-screen-cli 目录不存在"
    },
    {
      key: "recommend_screen_cli_entry",
      ok: screenEntryExists,
      path: screenEntryPath,
      message: screenEntryExists
        ? "boss-recommend-screen-cli 入口文件可用"
        : "boss-recommend-screen-cli 入口文件缺失"
    },
    {
      key: "screen_config",
      ok: screenConfigValidation.ok,
      path: screenConfigPath,
      reason: screenConfigValidation.reason || null,
      message: screenConfigValidation.ok ? "screening-config.json 可用" : screenConfigValidation.message
    },
    {
      key: "favorite_calibration",
      ok: calibrationUsable,
      path: calibrationPath,
      optional: pageScope !== "featured",
      message: calibrationUsable
        ? "favorite-calibration.json 可用"
        : "favorite-calibration.json 不存在或无效（精选页收藏仅支持校准坐标点击）"
    }
  ];
  checks.push(...buildRuntimeDependencyChecks({ searchDir, screenDir }));

  const requiredCheckKeys = new Set([
    "recommend_search_cli_dir",
    "recommend_search_cli_entry",
    "recommend_screen_cli_dir",
    "recommend_screen_cli_entry",
    "screen_config",
    "node_cli",
    "npm_dep_chrome_remote_interface_search",
    "npm_dep_chrome_remote_interface_screen",
    "npm_dep_ws",
    "npm_dep_sharp"
  ]);
  if (pageScope === "featured") {
    requiredCheckKeys.add("favorite_calibration");
  }

  return {
    ok: checks.every((item) => !requiredCheckKeys.has(item.key) || item.ok),
    checks,
    debug_port: resolveWorkspaceDebugPort(workspaceRoot),
    config_resolution: configResolution,
    calibration_path: calibrationPath,
    page_scope: pageScope
  };
}

function collectFailedCheckKeys(checks = []) {
  return new Set(
    checks
      .filter((item) => item && item.ok === false && typeof item.key === "string")
      .map((item) => item.key)
  );
}

function collectNpmInstallDirsFromChecks(checks = [], workspaceRoot) {
  const npmKeys = new Set([
    "npm_dep_chrome_remote_interface_search",
    "npm_dep_chrome_remote_interface_screen",
    "npm_dep_ws",
    "npm_dep_sharp"
  ]);
  const dirs = checks
    .filter((item) => item && item.ok === false && npmKeys.has(item.key))
    .map((item) => item.install_cwd)
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => path.resolve(item));
  if (dirs.length > 0) {
    return [...new Set(dirs)];
  }
  return [path.resolve(workspaceRoot)];
}

function installNpmDependencies(checks, workspaceRoot) {
  const dirs = collectNpmInstallDirsFromChecks(checks, workspaceRoot);
  const commandResults = [];
  let allOk = true;
  for (const cwd of dirs) {
    const result = runProcessSync({
      command: "npm",
      args: ["install"],
      cwd
    });
    commandResults.push({
      cwd,
      ok: result.ok,
      output: result.output || result.error_message || ""
    });
    if (!result.ok) allOk = false;
  }
  return {
    ok: allOk,
    action: "install_npm_dependencies",
    changed: true,
    command_results: commandResults,
    message: allOk ? "npm 依赖自动安装完成。" : "npm 依赖自动安装失败。"
  };
}

export function attemptPipelineAutoRepair(workspaceRoot, preflight = {}) {
  const checks = Array.isArray(preflight.checks) ? preflight.checks : [];
  const failed = collectFailedCheckKeys(checks);
  const actions = [];

  if (
    failed.has("npm_dep_chrome_remote_interface_search")
    || failed.has("npm_dep_chrome_remote_interface_screen")
    || failed.has("npm_dep_ws")
    || failed.has("npm_dep_sharp")
  ) {
    if (!failed.has("node_cli")) {
      actions.push(installNpmDependencies(checks, workspaceRoot));
    } else {
      actions.push({
        ok: false,
        action: "install_npm_dependencies",
        changed: false,
        message: "Node 命令不可用，跳过 npm 自动安装。"
      });
    }
  }

  const attempted = actions.length > 0;
  const nextPreflight = runPipelinePreflight(workspaceRoot, {
    pageScope: preflight?.page_scope
  });
  return {
    attempted,
    actions,
    preflight: nextPreflight
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listChromeTabs(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`DevTools endpoint returned ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function buildBossPageState(payload) {
  return {
    key: "boss_page_state",
    ...payload
  };
}

function extractSampleUrls(tabs, limit = 5) {
  return tabs
    .map((tab) => tab?.url)
    .filter(Boolean)
    .slice(0, limit);
}

function findChromeOnboardingUrl(tabs) {
  for (const tab of tabs) {
    if (typeof tab?.url === "string" && chromeOnboardingUrlPattern.test(tab.url)) {
      return tab.url;
    }
  }
  return null;
}

function isBossLoginTab(tab) {
  const url = String(tab?.url || "");
  const title = String(tab?.title || "");
  return (
    url === bossLoginUrl
    || bossLoginUrlPattern.test(url)
    || bossLoginTitlePattern.test(title)
  );
}

function findRecommendTab(tabs = []) {
  return tabs.find(
    (tab) => typeof tab?.url === "string" && tab.url.includes("/web/chat/recommend")
  ) || null;
}

export async function inspectBossRecommendPageState(port, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const expectedUrl = options.expectedUrl || bossRecommendUrl;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastTabs = [];

  while (Date.now() < deadline) {
    try {
      const tabs = await listChromeTabs(port);
      lastTabs = tabs;
      const exactTab = findRecommendTab(tabs);
      if (exactTab) {
        if (isBossLoginTab(exactTab)) {
          return buildBossPageState({
            ok: false,
            state: "LOGIN_REQUIRED",
            path: exactTab.url || bossLoginUrl,
            current_url: exactTab.url || bossLoginUrl,
            title: exactTab.title || null,
            requires_login: true,
            expected_url: expectedUrl,
            login_url: bossLoginUrl,
            message: "当前标签页虽在 recommend 路径，但检测到登录态页面特征，请先完成 Boss 登录。"
          });
        }
        return buildBossPageState({
          ok: true,
          state: "RECOMMEND_READY",
          path: exactTab.url,
          current_url: exactTab.url,
          title: exactTab.title || null,
          requires_login: false,
          message: "Boss 推荐页已打开，且当前仍停留在 recommend 页面。"
        });
      }

      const loginTab = tabs.find((tab) => isBossLoginTab(tab));
      if (loginTab) {
        return buildBossPageState({
          ok: false,
          state: "LOGIN_REQUIRED",
          path: loginTab.url || bossLoginUrl,
          current_url: loginTab.url || bossLoginUrl,
          title: loginTab.title || null,
          requires_login: true,
          expected_url: expectedUrl,
          login_url: bossLoginUrl,
          message: "Boss 页面未登录，需先完成登录后再进入 recommend 页面。"
        });
      }

      const bossTab = tabs.find(
        (tab) => typeof tab?.url === "string" && tab.url.includes("zhipin.com")
      );
      if (bossTab) {
        const requiresLogin = bossLoginUrlPattern.test(bossTab.url);
        return buildBossPageState({
          ok: false,
          state: requiresLogin ? "LOGIN_REQUIRED" : "BOSS_NOT_ON_RECOMMEND",
          path: bossTab.url,
          current_url: bossTab.url,
          title: bossTab.title || null,
          requires_login: requiresLogin,
          expected_url: expectedUrl,
          message: requiresLogin
            ? "Boss 页面未登录，需先完成登录后再进入 recommend 页面。"
            : "Boss 已登录但当前不在 recommend 页面，将尝试自动跳转。"
        });
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(pollMs);
  }

  if (lastError) {
    return buildBossPageState({
      ok: false,
      state: "DEBUG_PORT_UNREACHABLE",
      path: `http://127.0.0.1:${port}`,
      current_url: null,
      title: null,
      requires_login: false,
      expected_url: expectedUrl,
      message: `无法连接到 Chrome DevTools 端口 ${port}。请确认 Chrome 已以远程调试模式启动。`,
      error: lastError.message
    });
  }

  const onboardingUrl = findChromeOnboardingUrl(lastTabs);
  if (onboardingUrl) {
    return buildBossPageState({
      ok: false,
      state: "CHROME_ONBOARDING_INTERCEPTED",
      path: onboardingUrl,
      current_url: onboardingUrl,
      title: null,
      requires_login: false,
      expected_url: expectedUrl,
      message: "Chrome 当前停留在登录或引导页，尚未稳定到 Boss 推荐页。",
      sample_urls: extractSampleUrls(lastTabs)
    });
  }

  return buildBossPageState({
    ok: false,
    state: "BOSS_TAB_NOT_FOUND",
    path: expectedUrl,
    current_url: null,
    title: null,
    requires_login: false,
    expected_url,
    message: "未检测到 Boss 推荐页标签页。",
    sample_urls: extractSampleUrls(lastTabs)
  });
}

async function openBossRecommendTab(port) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(bossRecommendUrl)}`;
  const attempts = ["PUT", "GET"];
  let lastError = null;

  for (const method of attempts) {
    try {
      const response = await fetch(endpoint, { method });
      if (response.ok) {
        return { ok: true, method };
      }
      lastError = new Error(`DevTools /json/new returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    error: lastError?.message || "Failed to open Boss recommend tab via DevTools /json/new"
  };
}

async function verifyRecommendPageStable(port, options = {}) {
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 1500;
  const recheckTimeoutMs = Number.isFinite(options.recheckTimeoutMs) ? options.recheckTimeoutMs : 2500;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 600;

  await sleep(settleMs);
  const recheck = await inspectBossRecommendPageState(port, {
    timeoutMs: recheckTimeoutMs,
    pollMs
  });
  if (recheck.state === "RECOMMEND_READY") {
    const iframeState = await waitForRecommendIframeReady(port, {
      timeoutMs: recheckTimeoutMs,
      pollMs
    });
    if (iframeState.state === "RECOMMEND_IFRAME_READY") {
      return buildBossPageState({
        ...recheck,
        ok: true,
        state: "RECOMMEND_READY",
        frame_url: iframeState.frame_url || null,
        iframe_state: iframeState
      });
    }
    if (iframeState.state === "LOGIN_REQUIRED") {
      return buildBossPageState({
        ...iframeState,
        state: "LOGIN_REQUIRED_AFTER_REDIRECT",
        message: "Boss 页面曾进入 recommend 但 iframe 不可用且出现登录态特征，通常表示登录态失效。"
      });
    }
    if (iframeState.state === "NO_RECOMMEND_IFRAME") {
      return buildBossPageState({
        ...recheck,
        ok: false,
        state: "NO_RECOMMEND_IFRAME",
        current_url: iframeState.current_url || recheck.current_url || null,
        title: iframeState.title || recheck.title || null,
        frame_url: iframeState.frame_url || null,
        iframe_state: iframeState,
        message: "Boss recommend 页面已打开，但 recommend iframe 尚未就绪。"
      });
    }
    return iframeState;
  }
  if (recheck.state === "LOGIN_REQUIRED") {
    return buildBossPageState({
      ...recheck,
      state: "LOGIN_REQUIRED_AFTER_REDIRECT",
      message: "Boss 页面曾进入 recommend 但随后跳转到其他页面，通常表示登录态失效。"
    });
  }
  return recheck;
}

function buildRecommendIframeProbeExpression() {
  return `(() => {
    const currentUrl = (() => {
      try { return String(window.location.href || ""); } catch { return ""; }
    })();
    const title = (() => {
      try { return String(document.title || ""); } catch { return ""; }
    })();
    const isLogin = ${bossLoginUrlPattern}.test(currentUrl)
      || ${bossLoginTitlePattern}.test(title);
    if (isLogin) {
      return {
        ok: false,
        error: "LOGIN_REQUIRED",
        current_url: currentUrl || ${JSON.stringify(bossLoginUrl)},
        title
      };
    }
    const frame = ${buildRecommendIframeLookupExpression()};
    const frameUrl = (() => {
      try {
        return String(frame?.contentWindow?.location?.href || frame?.src || "");
      } catch {
        return String(frame?.src || "");
      }
    })();
    const iframeCount = document.querySelectorAll("iframe").length;
    if (!frame || !frame.contentDocument) {
      return {
        ok: false,
        error: "NO_RECOMMEND_IFRAME",
        current_url: currentUrl,
        title,
        frame_url: frameUrl,
        frame_present: Boolean(frame),
        iframe_count: iframeCount
      };
    }
    return {
      ok: true,
      current_url: currentUrl,
      title,
      frame_url: frameUrl,
      frame_present: true,
      iframe_count: iframeCount
    };
  })()`;
}

async function probeRecommendIframeState(port, options = {}) {
  const expectedUrl = options.expectedUrl || bossRecommendUrl;
  let client = null;
  try {
    const tabs = await listChromeTabs(port);
    const exactTab = findRecommendTab(tabs);
    if (!exactTab) {
      const loginTab = tabs.find((tab) => isBossLoginTab(tab));
      if (loginTab) {
        return buildBossPageState({
          ok: false,
          state: "LOGIN_REQUIRED",
          path: loginTab.url || bossLoginUrl,
          current_url: loginTab.url || bossLoginUrl,
          title: loginTab.title || null,
          requires_login: true,
          expected_url: expectedUrl,
          login_url: bossLoginUrl,
          message: "Boss 页面未登录，需先完成登录后再进入 recommend 页面。"
        });
      }
      const bossTab = tabs.find(
        (tab) => typeof tab?.url === "string" && tab.url.includes("zhipin.com")
      );
      if (bossTab) {
        return buildBossPageState({
          ok: false,
          state: "BOSS_NOT_ON_RECOMMEND",
          path: bossTab.url,
          current_url: bossTab.url,
          title: bossTab.title || null,
          requires_login: false,
          expected_url: expectedUrl,
          message: "Boss 已登录但当前不在 recommend 页面。"
        });
      }
      return buildBossPageState({
        ok: false,
        state: "BOSS_TAB_NOT_FOUND",
        path: expectedUrl,
        current_url: null,
        title: null,
        requires_login: false,
        expected_url: expectedUrl,
        message: "未检测到 Boss 推荐页标签页。",
        sample_urls: extractSampleUrls(tabs)
      });
    }
    if (isBossLoginTab(exactTab)) {
      return buildBossPageState({
        ok: false,
        state: "LOGIN_REQUIRED",
        path: exactTab.url || bossLoginUrl,
        current_url: exactTab.url || bossLoginUrl,
        title: exactTab.title || null,
        requires_login: true,
        expected_url: expectedUrl,
        login_url: bossLoginUrl,
        message: "当前标签页虽在 recommend 路径，但检测到登录态页面特征，请先完成 Boss 登录。"
      });
    }

    client = await CDP({ port, target: exactTab });
    const { Runtime, Page } = client;
    if (Runtime && typeof Runtime.enable === "function") {
      await Runtime.enable();
    }
    if (Page && typeof Page.enable === "function") {
      await Page.enable();
    }
    const frameProbe = await evaluateCdpExpression(client, buildRecommendIframeProbeExpression());
    if (frameProbe?.ok) {
      return buildBossPageState({
        ok: true,
        state: "RECOMMEND_IFRAME_READY",
        path: frameProbe.current_url || exactTab.url || expectedUrl,
        current_url: frameProbe.current_url || exactTab.url || null,
        title: frameProbe.title || exactTab.title || null,
        expected_url: expectedUrl,
        frame_url: frameProbe.frame_url || null,
        frame_present: frameProbe.frame_present === true,
        iframe_count: Number.isFinite(Number(frameProbe.iframe_count))
          ? Number(frameProbe.iframe_count)
          : null,
        message: "Boss 推荐页 iframe 已就绪。"
      });
    }
    if (frameProbe?.error === "LOGIN_REQUIRED") {
      return buildBossPageState({
        ok: false,
        state: "LOGIN_REQUIRED",
        path: frameProbe.current_url || exactTab.url || bossLoginUrl,
        current_url: frameProbe.current_url || exactTab.url || bossLoginUrl,
        title: frameProbe.title || exactTab.title || null,
        requires_login: true,
        expected_url: expectedUrl,
        login_url: bossLoginUrl,
        message: "页面检测到登录态特征，请先完成 Boss 登录。"
      });
    }
    return buildBossPageState({
      ok: false,
      state: frameProbe?.error || "NO_RECOMMEND_IFRAME",
      path: frameProbe?.current_url || exactTab.url || expectedUrl,
      current_url: frameProbe?.current_url || exactTab.url || null,
      title: frameProbe?.title || exactTab.title || null,
      expected_url: expectedUrl,
      frame_url: frameProbe?.frame_url || null,
      frame_present: frameProbe?.frame_present === true,
      iframe_count: Number.isFinite(Number(frameProbe?.iframe_count))
        ? Number(frameProbe.iframe_count)
        : null,
      message: "recommend iframe 暂不可用。"
    });
  } catch (error) {
    return buildBossPageState({
      ok: false,
      state: "DEBUG_PORT_UNREACHABLE",
      path: `http://127.0.0.1:${port}`,
      current_url: null,
      title: null,
      requires_login: false,
      expected_url: expectedUrl,
      message: `无法连接到 Chrome DevTools 端口 ${port}。请确认 Chrome 已以远程调试模式启动。`,
      error: error?.message || String(error)
    });
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {}
    }
  }
}

async function waitForRecommendIframeReady(port, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 3000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 600;
  const expectedUrl = options.expectedUrl || bossRecommendUrl;
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await probeRecommendIframeState(port, { expectedUrl });
    if (lastState?.state === "RECOMMEND_IFRAME_READY") {
      return lastState;
    }
    if (
      lastState?.state === "LOGIN_REQUIRED"
      || lastState?.state === "LOGIN_REQUIRED_AFTER_REDIRECT"
      || lastState?.state === "DEBUG_PORT_UNREACHABLE"
      || lastState?.state === "BOSS_TAB_NOT_FOUND"
      || lastState?.state === "BOSS_NOT_ON_RECOMMEND"
    ) {
      return lastState;
    }
    await sleep(pollMs);
  }

  return lastState || buildBossPageState({
    ok: false,
    state: "NO_RECOMMEND_IFRAME",
    path: expectedUrl,
    current_url: null,
    title: null,
    expected_url: expectedUrl,
    message: "recommend iframe 尚未就绪。"
  });
}

function pickBossRecommendReloadTarget(tabs = []) {
  return findRecommendTab(tabs) || tabs.find(
    (tab) => typeof tab?.url === "string" && tab.url.includes("zhipin.com")
  ) || null;
}

async function evaluateCdpExpression(client, expression) {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

function buildRecommendTabStateExpression() {
  return `(() => {
    const frame = ${buildRecommendIframeLookupExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const tabs = Array.from(new Set(${JSON.stringify(RECOMMEND_TAB_SELECTORS)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      }))).map((node) => {
      const status = normalize(node.getAttribute('data-status'));
      const className = normalize(node.className);
      const active = (
        /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(className)
        || normalize(node.getAttribute('aria-selected')) === 'true'
        || normalize(node.getAttribute('data-selected')) === 'true'
      );
      return {
        status: status || null,
        title: normalize(node.getAttribute('title')) || null,
        label: normalize(node.textContent) || null,
        active,
        class_name: className || null
      };
    });
    const activeTab = tabs.find((item) => item.active && item.status) || null;
    const featuredCount = ${JSON.stringify(FEATURED_CARD_SELECTORS)}
      .reduce((sum, selector) => {
        try { return sum + doc.querySelectorAll(selector).length; } catch { return sum; }
      }, 0);
    const recommendCount = ${JSON.stringify(RECOMMEND_CARD_SELECTORS)}
      .reduce((sum, selector) => {
        try { return sum + doc.querySelectorAll(selector).length; } catch { return sum; }
      }, 0);
    const latestCount = ${JSON.stringify(LATEST_CARD_SELECTORS)}
      .reduce((sum, selector) => {
        try { return sum + doc.querySelectorAll(selector).length; } catch { return sum; }
      }, 0);
    let inferredStatus = activeTab?.status || null;
    if (!inferredStatus) {
      if (featuredCount > 0 && recommendCount === 0 && latestCount === 0) inferredStatus = '3';
      else if (latestCount > 0 && featuredCount === 0 && recommendCount === 0) inferredStatus = '1';
      else if (recommendCount > 0 && featuredCount === 0 && latestCount === 0) inferredStatus = '0';
    }
    return {
      ok: true,
      active_status: inferredStatus,
      tabs,
      layout: {
        featured_count: featuredCount,
        recommend_count: recommendCount,
        latest_count: latestCount
      }
    };
  })()`;
}

function buildRecommendTabSwitchExpression(targetStatus) {
  return `((targetStatus) => {
    const frame = ${buildRecommendIframeLookupExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, state: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const tabs = Array.from(new Set(${JSON.stringify(RECOMMEND_TAB_SELECTORS)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      })));
    const target = tabs.find((node) => normalize(node.getAttribute('data-status')) === String(targetStatus)) || null;
    if (!target) {
      return { ok: false, state: 'TAB_NOT_FOUND', target_status: String(targetStatus) };
    }
    try {
      target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    } catch {}
    try {
      target.click();
    } catch (error) {
      return {
        ok: false,
        state: 'TAB_CLICK_FAILED',
        message: error?.message || String(error),
        target_status: String(targetStatus)
      };
    }
    return {
      ok: true,
      state: 'TAB_CLICKED',
      target_status: String(targetStatus)
    };
  })(${JSON.stringify(String(targetStatus || ""))})`;
}

function buildRecommendDetailStateExpression() {
  return `(() => {
    const selectors = ${JSON.stringify([...DETAIL_POPUP_SELECTORS, ...DETAIL_RESUME_IFRAME_SELECTORS])};
    const isVisible = (node) => {
      if (!node || !node.getBoundingClientRect) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width < 4 || rect.height < 4) return false;
      const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
      if (style) {
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (Number(style.opacity || '1') <= 0) return false;
      }
      return true;
    };
    const findVisibleDetail = (doc, source) => {
      if (!doc) return null;
      for (const selector of selectors) {
        const nodes = doc.querySelectorAll(selector);
        for (const node of nodes) {
          if (isVisible(node)) {
            return {
              ok: true,
              open: true,
              source,
              selector
            };
          }
        }
      }
      return null;
    };

    const topDetail = findVisibleDetail(document, 'top');
    if (topDetail) return topDetail;

    const frame = ${buildRecommendIframeLookupExpression()} || null;
    if (!frame || !frame.contentDocument) {
      return { ok: true, open: false, reason: 'NO_RECOMMEND_IFRAME' };
    }
    const frameDetail = findVisibleDetail(frame.contentDocument, 'recommendFrame');
    if (frameDetail) return frameDetail;

    return { ok: true, open: false, reason: 'DETAIL_NOT_VISIBLE' };
  })()`;
}

export async function waitRecommendFeaturedDetailReady(workspaceRoot, options = {}) {
  const debugPort = Number.isFinite(options.port)
    ? options.port
    : resolveWorkspaceDebugPort(workspaceRoot);
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(5000, options.timeoutMs)
    : 120000;
  const pollMs = Number.isFinite(options.pollMs)
    ? Math.max(150, options.pollMs)
    : 400;

  let client = null;
  try {
    const tabs = await listChromeTabs(debugPort);
    const target = pickBossRecommendReloadTarget(tabs);
    if (!target) {
      return {
        ok: false,
        debug_port: debugPort,
        state: "BOSS_TAB_NOT_FOUND",
        message: "未找到可检测详情页状态的 Boss recommend 标签页。"
      };
    }
    client = await CDP({ port: debugPort, target });
    const { Runtime, Page } = client;
    if (Runtime && typeof Runtime.enable === "function") {
      await Runtime.enable();
    }
    if (Page && typeof Page.enable === "function") {
      await Page.enable();
    }
    if (shouldBringChromeToFront() && Page && typeof Page.bringToFront === "function") {
      await Page.bringToFront();
    }

    const deadline = Date.now() + timeoutMs;
    let lastState = null;
    while (Date.now() < deadline) {
      lastState = await evaluateCdpExpression(client, buildRecommendDetailStateExpression());
      if (lastState?.ok && lastState.open) {
        return {
          ok: true,
          debug_port: debugPort,
          state: "DETAIL_READY",
          detail_state: lastState
        };
      }
      await sleep(pollMs);
    }

    return {
      ok: false,
      debug_port: debugPort,
      state: "DETAIL_NOT_READY_TIMEOUT",
      message: "未在超时内检测到候选人详情页，请先打开精选候选人详情后重试。",
      detail_state: lastState || null
    };
  } catch (error) {
    return {
      ok: false,
      debug_port: debugPort,
      state: "DETAIL_STATE_CHECK_FAILED",
      message: error?.message || "检测候选人详情页状态失败。"
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {}
    }
  }
}

export async function readRecommendTabState(workspaceRoot, options = {}) {
  const debugPort = Number.isFinite(options.port)
    ? options.port
    : resolveWorkspaceDebugPort(workspaceRoot);

  let client = null;
  try {
    const tabs = await listChromeTabs(debugPort);
    const target = pickBossRecommendReloadTarget(tabs);
    if (!target) {
      return {
        ok: false,
        debug_port: debugPort,
        state: "BOSS_TAB_NOT_FOUND",
        message: "未找到可读取 tab 状态的 Boss recommend 标签页。"
      };
    }
    client = await CDP({ port: debugPort, target });
    const { Runtime } = client;
    if (Runtime && typeof Runtime.enable === "function") {
      await Runtime.enable();
    }
    const tabState = await evaluateCdpExpression(client, buildRecommendTabStateExpression());
    if (!tabState?.ok) {
      return {
        ok: false,
        debug_port: debugPort,
        state: tabState?.error || "RECOMMEND_TAB_STATE_FAILED",
        message: "读取 recommend tab 状态失败。",
        tab_state: tabState || null
      };
    }
    return {
      ok: true,
      debug_port: debugPort,
      active_status: normalizeText(tabState.active_status),
      tab_state: tabState
    };
  } catch (error) {
    return {
      ok: false,
      debug_port: debugPort,
      state: "RECOMMEND_TAB_STATE_FAILED",
      message: error?.message || "读取 recommend tab 状态失败。"
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {}
    }
  }
}

function isUsableCalibrationFile(filePath) {
  if (!filePath || !pathExists(filePath)) return false;
  const parsed = readJsonFile(filePath);
  return Boolean(
    parsed
    && parsed.favoritePosition
    && Number.isFinite(parsed.favoritePosition.pageX)
    && Number.isFinite(parsed.favoritePosition.pageY)
  );
}

function resolveFavoriteCalibrationPath(workspaceRoot) {
  const fromEnv = normalizeText(process.env.BOSS_RECOMMEND_CALIBRATION_FILE || "");
  if (fromEnv) return path.resolve(fromEnv);

  const screenConfigPath = resolveScreenConfigPath(workspaceRoot);
  const screenConfig = readJsonFile(screenConfigPath);
  const calibrationFile = normalizeText(screenConfig?.calibrationFile || "");
  if (calibrationFile) {
    return path.resolve(path.dirname(screenConfigPath), calibrationFile);
  }
  return getUserCalibrationPath();
}

export async function switchRecommendTab(workspaceRoot, options = {}) {
  const debugPort = Number.isFinite(options.port)
    ? options.port
    : resolveWorkspaceDebugPort(workspaceRoot);
  const targetScope = normalizePageScope(options.page_scope);
  const targetStatus = normalizeText(options.target_status || PAGE_SCOPE_TO_TAB_STATUS[targetScope] || "");
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 350;
  if (!targetStatus) {
    return {
      ok: false,
      debug_port: debugPort,
      state: "TAB_STATUS_REQUIRED",
      message: "切换 recommend tab 失败：缺少 target_status。"
    };
  }

  let client = null;
  try {
    const tabs = await listChromeTabs(debugPort);
    const target = pickBossRecommendReloadTarget(tabs);
    if (!target) {
      return {
        ok: false,
        debug_port: debugPort,
        state: "BOSS_TAB_NOT_FOUND",
        message: "未找到可操作的 Boss recommend 标签页。"
      };
    }
    client = await CDP({ port: debugPort, target });
    const { Runtime, Page } = client;
    if (Runtime && typeof Runtime.enable === "function") {
      await Runtime.enable();
    }
    if (Page && typeof Page.enable === "function") {
      await Page.enable();
    }
    if (shouldBringChromeToFront() && Page && typeof Page.bringToFront === "function") {
      await Page.bringToFront();
    }

    const beforeState = await evaluateCdpExpression(client, buildRecommendTabStateExpression());
    if (beforeState?.ok && normalizeText(beforeState.active_status) === targetStatus) {
      return {
        ok: true,
        debug_port: debugPort,
        state: "TAB_ALREADY_ACTIVE",
        active_status: targetStatus,
        tab_state: beforeState
      };
    }

    const clickResult = await evaluateCdpExpression(client, buildRecommendTabSwitchExpression(targetStatus));
    if (!clickResult?.ok) {
      return {
        ok: false,
        debug_port: debugPort,
        state: clickResult?.state || "TAB_CLICK_FAILED",
        message: clickResult?.message || "点击 tab 失败。",
        tab_state: beforeState || null
      };
    }

    const deadline = Date.now() + timeoutMs;
    let lastState = beforeState || null;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      lastState = await evaluateCdpExpression(client, buildRecommendTabStateExpression());
      if (lastState?.ok && normalizeText(lastState.active_status) === targetStatus) {
        return {
          ok: true,
          debug_port: debugPort,
          state: "TAB_SWITCHED",
          active_status: targetStatus,
          tab_state: lastState
        };
      }
    }

    return {
      ok: false,
      debug_port: debugPort,
      state: "TAB_SWITCH_NOT_APPLIED",
      message: "点击 tab 后未在超时内确认激活状态。",
      tab_state: lastState || null
    };
  } catch (error) {
    return {
      ok: false,
      debug_port: debugPort,
      state: "RECOMMEND_TAB_SWITCH_FAILED",
      message: error?.message || "切换 recommend tab 失败。"
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {}
    }
  }
}

function buildRecommendRefreshStateExpression() {
  return `(() => {
    const frame = ${buildRecommendIframeLookupExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const isVisible = (el) => {
      if (!el) return false;
      const win = doc.defaultView;
      if (!win) return el.offsetParent !== null;
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2 && el.offsetParent !== null;
    };
    const finishedWrap = ${JSON.stringify(REFRESH_FINISHED_WRAP_SELECTORS)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      })
      .find((el) => isVisible(el)) || null;
    const refreshButton = ${JSON.stringify(REFRESH_BUTTON_SELECTORS)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      })
      .find((el) => isVisible(el)) || null;
    const cards = ${JSON.stringify(RECOMMEND_CARD_SELECTORS)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      });
    const candidateCards = cards.filter((card) => card.querySelector('.card-inner[data-geekid]'));
    const latestCards = ${JSON.stringify(LATEST_CARD_SELECTORS)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      });
    const tabs = ${JSON.stringify(RECOMMEND_TAB_SELECTORS)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      });
    const activeTab = tabs.find((node) => /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(String(node.className || ''))) || null;
    const activeStatus = activeTab ? String(activeTab.getAttribute('data-status') || '') : '';
    const inferredStatus = activeStatus
      || (latestCards.length > 0 && candidateCards.length === 0 ? '1' : candidateCards.length > 0 ? '0' : '');
    const effectiveCandidates = inferredStatus === '1' ? latestCards : candidateCards;
    const finishedText = finishedWrap ? String(finishedWrap.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    const buttonText = refreshButton ? String(refreshButton.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    return {
      ok: true,
      frame_url: (() => {
        try { return String(frame.contentWindow.location.href || ''); } catch { return ''; }
      })(),
      finished_wrap_visible: Boolean(finishedWrap),
      finished_wrap_text: finishedText || null,
      refresh_button_visible: Boolean(refreshButton),
      refresh_button_text: buttonText || null,
      candidate_count: effectiveCandidates.length,
      recommend_candidate_count: candidateCards.length,
      latest_candidate_count: latestCards.length,
      total_card_count: Math.max(cards.length, latestCards.length),
      list_ready: effectiveCandidates.length > 0
    };
  })()`;
}

function buildRecommendRefreshClickExpression() {
  return `(() => {
    const frame = ${buildRecommendIframeLookupExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, state: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const isVisible = (el) => {
      if (!el) return false;
      const win = doc.defaultView;
      if (!win) return el.offsetParent !== null;
      const style = win.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2 && el.offsetParent !== null;
    };
    const refreshButton = ${JSON.stringify(REFRESH_BUTTON_SELECTORS)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      })
      .find((el) => isVisible(el)) || null;
    if (!refreshButton) {
      return { ok: false, state: 'REFRESH_BUTTON_NOT_FOUND' };
    }
    try {
      refreshButton.click();
      return {
        ok: true,
        state: 'REFRESH_BUTTON_CLICKED',
        refresh_button_text: String(refreshButton.textContent || '').replace(/\\s+/g, ' ').trim() || null
      };
    } catch (error) {
      return {
        ok: false,
        state: 'REFRESH_BUTTON_CLICK_FAILED',
        message: error?.message || String(error)
      };
    }
  })()`;
}

export async function refreshBossRecommendList(workspaceRoot, options = {}) {
  const debugPort = Number.isFinite(options.port)
    ? options.port
    : resolveWorkspaceDebugPort(workspaceRoot);
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 600;
  const reloadTimeoutMs = Number.isFinite(options.reloadTimeoutMs) ? options.reloadTimeoutMs : 10000;

  let client = null;
  try {
    const tabs = await listChromeTabs(debugPort);
    const target = pickBossRecommendReloadTarget(tabs);
    if (!target) {
      return {
        ok: false,
        action: "in_page_refresh",
        debug_port: debugPort,
        state: "BOSS_TAB_NOT_FOUND",
        message: "未找到可操作的 Boss recommend 标签页。",
        before_state: null,
        after_state: null
      };
    }

    client = await CDP({ port: debugPort, target });
    const { Page, Runtime } = client;
    if (Runtime && typeof Runtime.enable === "function") {
      await Runtime.enable();
    }
    if (Page && typeof Page.enable === "function") {
      await Page.enable();
    }
    if (shouldBringChromeToFront() && Page && typeof Page.bringToFront === "function") {
      await Page.bringToFront();
    }

    const beforeState = await evaluateCdpExpression(client, buildRecommendRefreshStateExpression());
    if (!beforeState?.ok) {
      return {
        ok: false,
        action: "in_page_refresh",
        debug_port: debugPort,
        state: beforeState?.error || "NO_RECOMMEND_IFRAME",
        message: "未能读取 recommend iframe，无法执行页内刷新。",
        before_state: beforeState || null,
        after_state: null
      };
    }
    if (!beforeState.refresh_button_visible) {
      return {
        ok: false,
        action: "in_page_refresh",
        debug_port: debugPort,
        state: "REFRESH_BUTTON_NOT_FOUND",
        message: "推荐列表到底后未发现可点击的刷新按钮。",
        before_state: beforeState,
        after_state: beforeState
      };
    }

    const clickResult = await evaluateCdpExpression(client, buildRecommendRefreshClickExpression());
    if (!clickResult?.ok) {
      return {
        ok: false,
        action: "in_page_refresh",
        debug_port: debugPort,
        state: clickResult?.state || "REFRESH_BUTTON_CLICK_FAILED",
        message: clickResult?.message || "页内刷新按钮点击失败。",
        before_state: beforeState,
        after_state: null
      };
    }

    const deadline = Date.now() + reloadTimeoutMs;
    let lastState = beforeState;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      lastState = await evaluateCdpExpression(client, buildRecommendRefreshStateExpression());
      if (lastState?.ok && lastState.finished_wrap_visible === false && lastState.list_ready === true) {
        return {
          ok: true,
          action: "in_page_refresh",
          debug_port: debugPort,
          state: "RECOMMEND_READY",
          message: "已点击页内刷新按钮并重新拿到候选人列表。",
          before_state: beforeState,
          after_state: lastState
        };
      }
    }

    return {
      ok: false,
      action: "in_page_refresh",
      debug_port: debugPort,
      state: "LIST_NOT_RELOADED",
      message: "已点击页内刷新按钮，但候选人列表未在超时内重新就绪。",
      before_state: beforeState,
      after_state: lastState
    };
  } catch (error) {
    return {
      ok: false,
      action: "in_page_refresh",
      debug_port: debugPort,
      state: "REFRESH_BUTTON_CLICK_FAILED",
      message: error?.message || "页内刷新失败。",
      before_state: null,
      after_state: null
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {}
    }
  }
}

export async function reloadBossRecommendPage(workspaceRoot, options = {}) {
  const debugPort = Number.isFinite(options.port)
    ? options.port
    : resolveWorkspaceDebugPort(workspaceRoot);
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 1200;
  const recheckTimeoutMs = Number.isFinite(options.recheckTimeoutMs) ? options.recheckTimeoutMs : 4000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 600;

  let client = null;
  try {
    const tabs = await listChromeTabs(debugPort);
    const target = pickBossRecommendReloadTarget(tabs);
    if (!target) {
      return {
        ok: false,
        debug_port: debugPort,
        state: "BOSS_TAB_NOT_FOUND",
        page_state: null,
        message: "未找到可刷新的 Boss 标签页。"
      };
    }

    client = await CDP({ port: debugPort, target });
    const { Page } = client;
    if (Page && typeof Page.enable === "function") {
      await Page.enable();
    }
    if (shouldBringChromeToFront() && Page && typeof Page.bringToFront === "function") {
      await Page.bringToFront();
    }
    await Page.reload({ ignoreCache: true });

    const stableState = await verifyRecommendPageStable(debugPort, {
      settleMs,
      recheckTimeoutMs,
      pollMs
    });
    return {
      ok: stableState.state === "RECOMMEND_READY",
      debug_port: debugPort,
      state: stableState.state,
      page_state: stableState,
      reloaded_url: target.url || null
    };
  } catch (error) {
    return {
      ok: false,
      debug_port: debugPort,
      state: "RELOAD_FAILED",
      page_state: null,
      message: error?.message || "刷新 Boss recommend 页面失败。"
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {}
    }
  }
}

export async function ensureBossRecommendPageReady(workspaceRoot, options = {}) {
  const debugPort = Number.isFinite(options.port)
    ? options.port
    : resolveWorkspaceDebugPort(workspaceRoot);
  const attempts = Number.isFinite(options.attempts) ? Math.max(0, options.attempts) : 3;
  const inspectTimeoutMs = Number.isFinite(options.inspectTimeoutMs) ? options.inspectTimeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 800;
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 800;

  let pageState = await inspectBossRecommendPageState(debugPort, {
    timeoutMs: inspectTimeoutMs,
    pollMs
  });
  if (pageState.state === "RECOMMEND_READY") {
    const stableState = await verifyRecommendPageStable(debugPort, { settleMs, pollMs });
    return {
      ok: stableState.state === "RECOMMEND_READY",
      debug_port: debugPort,
      state: stableState.state,
      page_state: stableState
    };
  }

  let launchAttempt = null;
  if (pageState.state === "LOGIN_REQUIRED" || pageState.state === "LOGIN_REQUIRED_AFTER_REDIRECT") {
    return {
      ok: false,
      debug_port: debugPort,
      state: pageState.state,
      page_state: {
        ...pageState,
        launch_attempt: launchAttempt
      }
    };
  }
  if (pageState.state === "DEBUG_PORT_UNREACHABLE") {
    launchAttempt = launchChromeWithDebugPort(debugPort);
    if (launchAttempt.ok) {
      await sleep(settleMs + 1200);
      pageState = await inspectBossRecommendPageState(debugPort, {
        timeoutMs: inspectTimeoutMs,
        pollMs
      });
      if (pageState.state === "LOGIN_REQUIRED" || pageState.state === "LOGIN_REQUIRED_AFTER_REDIRECT") {
        return {
          ok: false,
          debug_port: debugPort,
          state: pageState.state,
          page_state: {
            ...pageState,
            launch_attempt: launchAttempt
          }
        };
      }
      if (pageState.state === "RECOMMEND_READY") {
        const stableState = await verifyRecommendPageStable(debugPort, { settleMs, pollMs });
        return {
          ok: stableState.state === "RECOMMEND_READY",
          debug_port: debugPort,
          state: stableState.state,
          page_state: {
            ...stableState,
            launch_attempt: launchAttempt
          }
        };
      }
    } else {
      return {
        ok: false,
        debug_port: debugPort,
        state: pageState.state,
        page_state: {
          ...pageState,
          launch_attempt: launchAttempt
        }
      };
    }
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (
      pageState.state === "DEBUG_PORT_UNREACHABLE"
      || pageState.state === "LOGIN_REQUIRED"
      || pageState.state === "LOGIN_REQUIRED_AFTER_REDIRECT"
    ) {
      break;
    }
    await openBossRecommendTab(debugPort);
    await sleep(settleMs);
    pageState = await inspectBossRecommendPageState(debugPort, {
      timeoutMs: inspectTimeoutMs,
      pollMs
    });
    if (pageState.state === "RECOMMEND_READY") {
      const stableState = await verifyRecommendPageStable(debugPort, { settleMs, pollMs });
      return {
        ok: stableState.state === "RECOMMEND_READY",
        debug_port: debugPort,
        state: stableState.state,
        page_state: {
          ...stableState,
          launch_attempt: launchAttempt
        }
      };
    }
  }

  return {
    ok: false,
    debug_port: debugPort,
    state: pageState.state || "UNKNOWN",
    page_state: {
      ...pageState,
      launch_attempt: launchAttempt
    }
  };
}

export async function listRecommendJobs({ workspaceRoot, port, runtime = null }) {
  const searchDir = resolveRecommendSearchCliDir(workspaceRoot);
  if (!searchDir) {
    return {
      ok: false,
      stdout: "",
      stderr: "boss-recommend-search-cli package not found",
      error: {
        code: "RECOMMEND_SEARCH_CLI_MISSING",
        message: "boss-recommend-search-cli 目录不存在。"
      }
    };
  }
  const cliPath = resolveRecommendSearchCliEntry(searchDir);
  const args = [
    cliPath,
    "--list-jobs",
    "--port",
    String(parsePositiveInteger(port) || resolveWorkspaceDebugPort(workspaceRoot))
  ];
  const result = await runProcess({
    command: "node",
    args,
    cwd: searchDir,
    timeoutMs: 180000,
    heartbeatIntervalMs: runtime?.heartbeatIntervalMs,
    signal: runtime?.signal,
    onOutput: (event) => {
      safeInvokeCallback(runtime?.onOutput, event);
    },
    onHeartbeat: (event) => {
      safeInvokeCallback(runtime?.onHeartbeat, event);
    }
  });
  const structured = parseJsonOutput(result.stdout) || parseJsonOutput(result.stderr);
  const jobs = Array.isArray(structured?.result?.jobs) ? structured.result.jobs : [];
  const missingOutputError = result.code === 0 && !structured
    ? {
        code: "RECOMMEND_JOB_LIST_NO_OUTPUT",
        message: "岗位列表读取完成但未返回可解析结果。"
      }
    : null;
  return {
    ok: result.code === 0 && structured?.status === "COMPLETED" && jobs.length > 0,
    stdout: result.stdout,
    stderr: result.stderr,
    structured,
    jobs,
    error: structured?.error || missingOutputError || (
      result.code === 0
        ? {
            code: "RECOMMEND_JOB_LIST_EMPTY",
            message: "未读取到可选岗位。"
          }
        : result.error_code === "ABORTED"
          ? {
              code: "PROCESS_ABORTED",
              message: "岗位列表读取已取消。"
            }
          : {
              code: "RECOMMEND_JOB_LIST_FAILED",
              message: "岗位列表读取失败。"
            }
    )
  };
}

export async function runRecommendSearchCli({
  workspaceRoot,
  searchParams,
  selectedJob,
  pageScope = "recommend",
  runtime = null
}) {
  const searchDir = resolveRecommendSearchCliDir(workspaceRoot);
  if (!searchDir) {
    return {
      ok: false,
      stdout: "",
      stderr: "boss-recommend-search-cli package not found",
      error: {
        code: "RECOMMEND_SEARCH_CLI_MISSING",
        message: "boss-recommend-search-cli 目录不存在。"
      }
    };
  }
  const cliPath = resolveRecommendSearchCliEntry(searchDir);
  const args = [
    cliPath,
    "--school-tag",
    serializeSchoolTagSelection(searchParams.school_tag),
    "--degree",
    serializeDegreeSelection(searchParams.degree),
    "--gender",
    searchParams.gender,
    "--recent-not-view",
    searchParams.recent_not_view,
    "--port",
    String(resolveWorkspaceDebugPort(workspaceRoot))
  ];
  const normalizedPageScope = normalizePageScope(pageScope) || "recommend";
  args.push("--page-scope", normalizedPageScope);
  if (normalizedPageScope === "featured") {
    args.push("--calibration", resolveFavoriteCalibrationPath(workspaceRoot));
  }
  const normalizedSelectedJob = String(selectedJob || "").trim();
  if (normalizedSelectedJob) {
    args.push("--job", normalizedSelectedJob);
  }
  const result = await runProcess({
    command: "node",
    args,
    cwd: searchDir,
    timeoutMs: 180000,
    heartbeatIntervalMs: runtime?.heartbeatIntervalMs,
    signal: runtime?.signal,
    onOutput: (event) => {
      safeInvokeCallback(runtime?.onOutput, event);
    },
    onHeartbeat: (event) => {
      safeInvokeCallback(runtime?.onHeartbeat, event);
    }
  });
  const structured = parseJsonOutput(result.stdout) || parseJsonOutput(result.stderr);
  const missingOutputError = result.code === 0 && !structured
    ? {
        code: "RECOMMEND_SEARCH_NO_OUTPUT",
        message: "推荐页筛选命令执行结束但未返回可解析结果。"
      }
    : null;
  return {
    ok: result.code === 0 && structured?.status === "COMPLETED",
    stdout: result.stdout,
    stderr: result.stderr,
    structured,
    summary: structured?.result || null,
    error: structured?.error || missingOutputError || (
      result.code === 0
        ? null
        : result.error_code === "ABORTED"
          ? {
              code: "PROCESS_ABORTED",
              message: "推荐页筛选命令已取消。"
            }
          : {
              code: "RECOMMEND_SEARCH_FAILED",
              message: "推荐页筛选命令执行失败。"
            }
    )
  };
}

export async function runRecommendScreenCli({
  workspaceRoot,
  screenParams,
  pageScope = "recommend",
  inputSummary = null,
  resume = null,
  runtime = null
}) {
  const screenDir = resolveRecommendScreenCliDir(workspaceRoot);
  if (!screenDir) {
    return {
      ok: false,
      stdout: "",
      stderr: "boss-recommend-screen-cli package not found",
      error: {
        code: "RECOMMEND_SCREEN_CLI_MISSING",
        message: "boss-recommend-screen-cli 目录不存在。"
      }
    };
  }
  const configPath = resolveScreenConfigPath(workspaceRoot);
  const loaded = loadScreenConfig(configPath);
  if (!loaded.ok) {
    return {
      ok: false,
      stdout: "",
      stderr: loaded.error,
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: loaded.error
      }
    };
  }

  const fixedOutput = normalizeText(resume?.output_csv || "");
  const outputName = `recommend_screen_result_${Date.now()}.csv`;
  let outputPath = fixedOutput ? path.resolve(fixedOutput) : outputName;
  if (!fixedOutput) {
    if (loaded.config.outputDir) {
      const resolvedOutputDir = path.resolve(path.dirname(configPath), loaded.config.outputDir);
      fs.mkdirSync(resolvedOutputDir, { recursive: true });
      outputPath = path.join(resolvedOutputDir, outputName);
    } else {
      const desktopDir = getDesktopDir();
      fs.mkdirSync(desktopDir, { recursive: true });
      outputPath = path.join(desktopDir, outputName);
    }
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }

  const checkpointPath = normalizeText(resume?.checkpoint_path || "")
    ? path.resolve(String(resume.checkpoint_path))
    : null;
  const pauseControlPath = normalizeText(resume?.pause_control_path || "")
    ? path.resolve(String(resume.pause_control_path))
    : null;
  const resumeRequested = resume?.resume === true;
  const requireCheckpoint = resume?.require_checkpoint === true;
  if (resumeRequested && requireCheckpoint) {
    if (!checkpointPath) {
      return {
        ok: false,
        paused: false,
        stdout: "",
        stderr: "",
        structured: null,
        summary: null,
        error: {
          code: "RESUME_CHECKPOINT_MISSING",
          message: "恢复执行缺少 checkpoint_path，无法从上次进度继续。"
        }
      };
    }
    if (!fs.existsSync(checkpointPath)) {
      return {
        ok: false,
        paused: false,
        stdout: "",
        stderr: "",
        structured: null,
        summary: null,
        error: {
          code: "RESUME_CHECKPOINT_MISSING",
          message: `恢复执行未找到 checkpoint 文件：${checkpointPath}`
        }
      };
    }
  }

  const cliPath = resolveRecommendScreenCliEntry(screenDir);
  const args = [
    cliPath,
    "--baseurl",
    loaded.config.baseUrl,
    "--apikey",
    loaded.config.apiKey,
    "--model",
    loaded.config.model,
    "--port",
    String(resolveWorkspaceDebugPort(workspaceRoot)),
    "--criteria",
    screenParams.criteria,
    "--post-action",
    screenParams.post_action,
    "--post-action-confirmed",
    "true",
    "--output",
    outputPath
  ];
  const normalizedPageScope = normalizePageScope(pageScope) || "recommend";
  args.push("--page-scope", normalizedPageScope);

  if (loaded.config.openaiOrganization) {
    args.push("--openai-organization", loaded.config.openaiOrganization);
  }
  if (loaded.config.openaiProject) {
    args.push("--openai-project", loaded.config.openaiProject);
  }
  const llmThinkingLevel = resolveLlmThinkingLevel(loaded.config);
  if (llmThinkingLevel) {
    args.push("--thinking-level", llmThinkingLevel);
  }
  if (Number.isInteger(screenParams.target_count) && screenParams.target_count > 0) {
    args.push("--targetCount", String(screenParams.target_count));
  }
  if (screenParams.post_action === "greet"
    && Number.isInteger(screenParams.max_greet_count)
    && screenParams.max_greet_count > 0) {
    args.push("--max-greet-count", String(screenParams.max_greet_count));
  }
  if (checkpointPath) {
    args.push("--checkpoint-path", checkpointPath);
  }
  if (pauseControlPath) {
    args.push("--pause-control-path", pauseControlPath);
  }
  if (resumeRequested) {
    args.push("--resume");
  }
  const serializedInputSummary = serializeInputSummary(inputSummary);
  if (serializedInputSummary) {
    args.push("--input-summary-json", serializedInputSummary);
  }

  let inferredProgress = {
    processed: 0,
    passed: 0,
    skipped: 0,
    greet_count: 0
  };
  let inferredTracker = createScreenProgressTracker();
  const screenTimeoutMs = resolveRecommendScreenTimeoutMs(runtime);

  const result = await runProcess({
    command: "node",
    args,
    cwd: screenDir,
    timeoutMs: screenTimeoutMs,
    heartbeatIntervalMs: runtime?.heartbeatIntervalMs,
    signal: runtime?.signal,
    onOutput: (event) => {
      safeInvokeCallback(runtime?.onOutput, event);
    },
    onLine: (event) => {
      const parsed = parseScreenProgressLine(event?.line, inferredProgress, inferredTracker);
      if (!parsed) return;
      inferredProgress = parsed.progress;
      inferredTracker = parsed.tracker;
      safeInvokeCallback(runtime?.onProgress, {
        ...inferredProgress,
        line: parsed.line
      });
    },
    onHeartbeat: (event) => {
      safeInvokeCallback(runtime?.onHeartbeat, event);
    }
  });
  const structured = parseJsonOutput(result.stdout) || parseJsonOutput(result.stderr);
  const status = normalizeText(structured?.status || "").toUpperCase();
  const summary = structured?.result || null;
  if (summary) {
    safeInvokeCallback(runtime?.onProgress, {
      processed: Number.isInteger(summary.processed_count) ? summary.processed_count : inferredProgress.processed,
      passed: Number.isInteger(summary.passed_count) ? summary.passed_count : inferredProgress.passed,
      skipped: Number.isInteger(summary.skipped_count) ? summary.skipped_count : inferredProgress.skipped,
      greet_count: Number.isInteger(summary.greet_count) ? summary.greet_count : inferredProgress.greet_count
    });
  }
  const missingOutputError = result.code === 0 && !structured
    ? {
        code: "RECOMMEND_SCREEN_NO_OUTPUT",
        message: "推荐页筛选命令执行结束但未返回可解析结果。"
      }
    : null;
  return {
    ok: result.code === 0 && status === "COMPLETED",
    paused: result.code === 0 && status === "PAUSED",
    stdout: result.stdout,
    stderr: result.stderr,
    structured,
    summary,
    error: structured?.error || missingOutputError || buildRecommendScreenProcessError(result, screenTimeoutMs)
  };
}

export const __testables = {
  runProcess,
  parseJsonOutput,
  parseScreenProgressLine,
  resolveRecommendScreenTimeoutMs,
  buildRecommendScreenProcessError,
  normalizePageScope,
  buildRecommendTabStateExpression,
  buildRecommendTabSwitchExpression
};
