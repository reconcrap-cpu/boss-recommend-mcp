import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
  ensureChromeDebugPort,
  getDocumentRoot,
  querySelector,
  sleep as sleepMs
} from "./core/browser/index.js";
import {
  bossChatHealthCheckTool,
  cancelBossChatRunTool,
  getBossChatRunTool,
  pauseBossChatRunTool,
  prepareBossChatRunTool,
  resumeBossChatRunTool
} from "./chat-mcp.js";
import {
  listRecommendJobsTool,
  startRecommendPipelineRunTool
} from "./recommend-mcp.js";
import {
  getBossScreenConfigResolution,
  resolveBossChatRuntimeLayout as resolveCdpBossChatRuntimeLayout,
  resolveBossScreeningConfig
} from "./chat-runtime-config.js";
import { startServer } from "./index.js";

const require = createRequire(import.meta.url);
const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
const packageJsonPath = path.join(packageRoot, "package.json");
const skillName = "boss-recommend-pipeline";
const recruitSkillName = "boss-recruit-pipeline";
const chatSkillName = "boss-chat";
const bundledSkillNames = [skillName, recruitSkillName, chatSkillName];
const exampleConfigPath = path.join(packageRoot, "config", "screening-config.example.json");
const bossUrl = "https://www.zhipin.com/web/chat/recommend";
const bossLoginUrl = "https://www.zhipin.com/web/user/?ka=bticket";
const chromeOnboardingUrlPattern = /^chrome:\/\/(welcome|intro|newtab|signin|history-sync|settings\/syncSetup)/i;
const bossLoginUrlPattern = /(?:zhipin\.com\/web\/user(?:\/|\?|$)|passport\.zhipin\.com)/i;
const bossLoginTitlePattern = /登录|signin|扫码登录|BOSS直聘登录/i;
const supportedMcpClients = ["generic", "cursor", "trae", "claudecode", "openclaw", "qclaw"];
const defaultMcpServerName = "boss-recommend";
const defaultMcpCommand = "npx";
const recommendMcpPackageName = "@reconcrap/boss-recommend-mcp";
const recommendMcpBinaryName = "boss-recommend-mcp";
const autoSyncSkipCommands = new Set(["install", "install-skill", "where", "help", "--help", "-h", "list-jobs", "jobs", "recommend-jobs"]);
const externalMcpTargetsEnv = "BOSS_RECOMMEND_MCP_CONFIG_TARGETS";
const externalSkillDirsEnv = "BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS";
const installConfigDefaults = Object.freeze({
  greetingMessage: "Hi同学，能麻烦发下简历吗？",
  llmThinkingLevel: "low",
  llmMaxTokens: 512,
  llmMaxRetries: 3,
  llmImageLimit: 8,
  llmImageDetail: "low",
  humanRestEnabled: true,
  humanBehavior: {
    enabled: true,
    profile: "paced_with_rests",
    restLevel: "low"
  }
});
const bossChatRuntimeChildDirs = ["logs", "runs", "profiles", "reports", "artifacts", "state"];
const bossChatCliUnsupportedStartCode = "CHAT_CLI_ASYNC_UNSUPPORTED_CDP_ONLY";
const calibrateUnsupportedCode = "CALIBRATE_UNSUPPORTED_CDP_ONLY";
const detachedRecommendRunChildEnv = "BOSS_RECOMMEND_DETACHED_RUN_CHILD";

function getSkillSourceDir(name = skillName) {
  return path.join(packageRoot, "skills", name);
}

function getPackageVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return typeof parsed?.version === "string" ? parsed.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const packageVersion = getPackageVersion();
const detachedRecommendMcpEnv = {
  BOSS_RECOMMEND_CDP_DETACHED: "1",
  BOSS_RECOMMEND_RUN_HEARTBEAT_MS: "10000"
};

function isInstalledPackageRoot(rootPath = packageRoot) {
  const normalized = path.resolve(String(rootPath || ""))
    .replace(/\\/g, "/")
    .toLowerCase();
  return (
    normalized.includes("/appdata/local/npm-cache/_npx/")
    || normalized.includes("/node_modules/@reconcrap/boss-recommend-mcp")
  );
}

function getDefaultMcpPackageSpecifier(options = {}) {
  const version = String(options.packageVersion || packageVersion).trim();
  const rootPath = options.packageRootPath || packageRoot;
  if (version && version !== "0.0.0" && isInstalledPackageRoot(rootPath)) {
    return `${recommendMcpPackageName}@${version}`;
  }
  return `${recommendMcpPackageName}@latest`;
}

function buildDefaultMcpArgs(options = {}) {
  return ["-y", getDefaultMcpPackageSpecifier(options), "start"];
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

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isUnsafeRuntimeDirectory(targetPath) {
  const resolved = path.resolve(String(targetPath || ""));
  if (!resolved) return true;
  if (path.parse(resolved).root.toLowerCase() === resolved.toLowerCase()) return true;
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  if (process.platform === "win32") {
    return (
      normalized.endsWith("/windows")
      || normalized.endsWith("/windows/system32")
      || normalized.endsWith("/windows/syswow64")
      || normalized.endsWith("/program files")
      || normalized.endsWith("/program files (x86)")
    );
  }
  return ["/system", "/usr", "/bin", "/sbin"].some((prefix) => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ));
}

function getBossChatRuntimeDirectories(runtime) {
  return [
    runtime.data_dir,
    ...bossChatRuntimeChildDirs.map((name) => path.join(runtime.data_dir, name))
  ];
}

function ensureBossChatRuntimeReadyLocal(workspaceRoot) {
  const runtime = resolveCdpBossChatRuntimeLayout(workspaceRoot);
  const runtimeDirectories = getBossChatRuntimeDirectories(runtime);
  const created = [];
  const existed = [];
  const failed = [];
  let migration = {
    attempted: false,
    performed: false,
    source: runtime.migration_source_dir,
    target: runtime.data_dir,
    message: runtime.migration_source_dir
      ? `Pending legacy boss-chat migration from ${runtime.migration_source_dir}`
      : ""
  };

  if (isUnsafeRuntimeDirectory(runtime.data_dir)) {
    return {
      ...runtime,
      directories: runtimeDirectories,
      created,
      existed,
      failed: [
        {
          path: runtime.data_dir,
          message: `Refusing unsafe boss-chat runtime path: ${runtime.data_dir}. Please use BOSS_CHAT_HOME in a writable user directory.`
        }
      ],
      migration,
      blocked_reason: "UNSAFE_DATA_DIR"
    };
  }

  if (runtime.migration_source_dir) {
    try {
      fs.cpSync(runtime.migration_source_dir, runtime.data_dir, {
        recursive: true,
        force: false,
        errorOnExist: false
      });
      migration = {
        attempted: true,
        performed: true,
        source: runtime.migration_source_dir,
        target: runtime.data_dir,
        message: `Migrated legacy boss-chat runtime from ${runtime.migration_source_dir} to ${runtime.data_dir}. Legacy source was preserved.`
      };
    } catch (error) {
      migration = {
        attempted: true,
        performed: false,
        source: runtime.migration_source_dir,
        target: runtime.data_dir,
        message: error?.message || "Legacy boss-chat migration failed."
      };
      failed.push({
        path: runtime.data_dir,
        message: `Legacy migration failed: ${migration.message}`
      });
    }
  }

  for (const directory of runtimeDirectories) {
    try {
      const existedBefore = pathExists(directory);
      ensureDir(directory);
      if (existedBefore) {
        existed.push(directory);
      } else {
        created.push(directory);
      }
    } catch (error) {
      failed.push({
        path: directory,
        message: error?.message || String(error)
      });
    }
  }

  return {
    ...runtime,
    directories: runtimeDirectories,
    created,
    existed,
    failed,
    migration
  };
}

function readJsonObjectFileSafe(filePath) {
  if (!pathExists(filePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fallback below.
  }
  return {};
}

function dedupePaths(items) {
  const result = [];
  const seen = new Set();
  for (const item of items || []) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function dedupeLower(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function discoverAppDataDirsByPattern(baseDir, pattern) {
  try {
    if (!pathExists(baseDir)) return [];
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function getDesktopDir() {
  return path.join(os.homedir(), "Desktop");
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

function isUsableCalibrationFile(filePath) {
  if (!filePath || !pathExists(filePath)) return false;
  const parsed = readJsonObjectFileSafe(filePath);
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

  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const screenConfigPath = configResolution.config_path || getUserConfigPath();
  const screenConfig = readJsonObjectFileSafe(screenConfigPath);
  const calibrationFile = normalizeText(screenConfig?.calibrationFile || "");
  if (calibrationFile && screenConfigPath) {
    return path.resolve(path.dirname(screenConfigPath), calibrationFile);
  }
  return getUserCalibrationPath();
}

function resolveRecruitCalibrationScriptPath(workspaceRoot) {
  const fromEnv = normalizeText(process.env.BOSS_RECOMMEND_RECRUIT_CALIBRATION_SCRIPT || "");
  const workspaceResolved = path.resolve(String(workspaceRoot || process.cwd()));
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    fromEnv,
    path.join(workspaceResolved, "..", "..", "boss recruit pipeline", "boss-recruit-mcp", "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs"),
    path.join(packageRoot, "..", "..", "boss recruit pipeline", "boss-recruit-mcp", "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs"),
    path.join(appData, "npm", "node_modules", "@reconcrap", "boss-recruit-mcp", "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs"),
    path.join(workspaceResolved, "..", "boss-recruit-mcp-main", "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs"),
    path.join(packageRoot, "..", "boss-recruit-mcp-main", "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs")
  ].filter(Boolean).map((item) => path.resolve(item));

  for (const candidate of new Set(candidates)) {
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

function getFeaturedCalibrationResolutionLocal(workspaceRoot) {
  const calibrationPath = resolveFavoriteCalibrationPath(workspaceRoot);
  return {
    calibration_path: calibrationPath,
    calibration_exists: pathExists(calibrationPath),
    calibration_usable: isUsableCalibrationFile(calibrationPath),
    calibration_script_path: resolveRecruitCalibrationScriptPath(workspaceRoot)
  };
}

function runProcessSyncLocal({ command, args = [], cwd = process.cwd() } = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      env: process.env,
      shell: false,
      windowsHide: true
    });
    const stdout = String(result.stdout || "").trim();
    const stderr = String(result.stderr || "").trim();
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      ok: result.status === 0 && !result.error,
      status: Number.isInteger(result.status) ? result.status : -1,
      stdout,
      stderr,
      output,
      error_code: result.error?.code || null,
      error_message: result.error?.message || ""
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

function buildNodeCommandCheckLocal() {
  const probe = runProcessSyncLocal({
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

function buildNodePackageCheckLocal({ key, moduleName, cwd, missingMessage }) {
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
  const probe = runProcessSyncLocal({
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

function buildRuntimeDependencyChecksLocal({ dependencyDir = packageRoot } = {}) {
  return [
    buildNodeCommandCheckLocal(),
    buildNodePackageCheckLocal({
      key: "npm_dep_chrome_remote_interface",
      moduleName: "chrome-remote-interface",
      cwd: dependencyDir,
      missingMessage: "无法校验 chrome-remote-interface：boss-recommend-mcp package 目录不存在。"
    }),
    buildNodePackageCheckLocal({
      key: "npm_dep_ws",
      moduleName: "ws",
      cwd: dependencyDir,
      missingMessage: "无法校验 ws：boss-recommend-mcp package 目录不存在。"
    }),
    buildNodePackageCheckLocal({
      key: "npm_dep_sharp",
      moduleName: "sharp",
      cwd: dependencyDir,
      missingMessage: "无法校验 sharp：boss-recommend-mcp package 目录不存在。"
    })
  ];
}

function resolveWorkspaceDebugPortLocal(workspaceRoot) {
  const fromEnv = parsePositivePort(process.env.BOSS_RECOMMEND_CHROME_PORT);
  if (fromEnv) return fromEnv;
  const configResolution = getBossScreenConfigResolution(workspaceRoot);
  const config = readJsonObjectFileSafe(configResolution.resolved_path);
  return parsePositivePort(config?.debugPort) || 9222;
}

function buildScreenConfigCheckLocal(workspaceRoot, configResolution) {
  const screenConfig = resolveBossScreeningConfig(workspaceRoot);
  const pathForMessage = screenConfig.config_path || configResolution.resolved_path || configResolution.writable_path;
  return {
    key: "screen_config",
    ok: screenConfig.ok,
    path: pathForMessage,
    reason: screenConfig.ok ? "OK" : (screenConfig.error?.code || "SCREEN_CONFIG_ERROR"),
    message: screenConfig.ok ? "screening-config.json 可用" : (screenConfig.error?.message || "screening-config.json 不可用")
  };
}

function runPipelinePreflightLocal(workspaceRoot, options = {}) {
  const pageScope = normalizePageScope(options.pageScope) || "recommend";
  const configResolution = getBossScreenConfigResolution(workspaceRoot);
  const calibrationResolution = getFeaturedCalibrationResolutionLocal(workspaceRoot);
  const checks = [
    buildScreenConfigCheckLocal(workspaceRoot, configResolution),
    {
      key: "favorite_calibration",
      ok: calibrationResolution.calibration_usable,
      path: calibrationResolution.calibration_path,
      optional: pageScope !== "featured",
      message: calibrationResolution.calibration_usable
        ? "favorite-calibration.json 可用"
        : "favorite-calibration.json 不存在或无效（精选页收藏仅支持校准坐标点击）"
    }
  ];
  checks.push(...buildRuntimeDependencyChecksLocal({ dependencyDir: packageRoot }));

  const requiredCheckKeys = new Set([
    "screen_config",
    "node_cli",
    "npm_dep_chrome_remote_interface",
    "npm_dep_ws",
    "npm_dep_sharp"
  ]);
  if (pageScope === "featured") {
    requiredCheckKeys.add("favorite_calibration");
  }

  return {
    ok: checks.every((item) => !requiredCheckKeys.has(item.key) || item.ok),
    checks,
    debug_port: resolveWorkspaceDebugPortLocal(workspaceRoot),
    config_resolution: configResolution,
    calibration_path: calibrationResolution.calibration_path,
    page_scope: pageScope
  };
}

function getSkillTargetDir(name = skillName) {
  return path.join(getCodexHome(), "skills", name);
}

function getSkillVersionMarkerPath(name = skillName) {
  return path.join(getSkillTargetDir(name), ".installed-version");
}

function readInstalledSkillVersion(name = skillName) {
  const markerPath = getSkillVersionMarkerPath(name);
  if (!fs.existsSync(markerPath)) return null;
  try {
    return fs.readFileSync(markerPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeInstalledSkillVersion(name, version) {
  const markerPath = getSkillVersionMarkerPath(name);
  ensureDir(path.dirname(markerPath));
  fs.writeFileSync(markerPath, `${version}\n`, "utf8");
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function parsePositivePort(raw) {
  const port = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function parseNonNegativeInteger(raw, fallback = undefined) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBossChatTargetCountOption(raw) {
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const parsed = parsePositivePort(text);
  return parsed ?? text;
}

function parseBooleanOption(raw, fallback = undefined) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (raw === true) return true;
  const normalized = String(raw).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parseRestLevelOption(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const normalized = String(raw).trim().toLowerCase();
  return ["low", "medium", "high"].includes(normalized) ? normalized : undefined;
}

function normalizePageScope(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["recommend", "推荐", "推荐页", "推荐页面"].includes(normalized)) return "recommend";
  if (["latest", "最新", "最新页", "最新页面"].includes(normalized)) return "latest";
  if (["featured", "精选", "精选页", "精选页面", "精选牛人"].includes(normalized)) return "featured";
  return null;
}

function isEphemeralWorkspaceRoot(rootPath) {
  const normalized = path.resolve(String(rootPath || ""))
    .replace(/\\/g, "/")
    .toLowerCase();
  return (
    normalized.includes("/appdata/local/npm-cache/_npx/")
    || normalized.includes("/node_modules/@reconcrap/boss-recommend-mcp")
  );
}

function getWorkspaceRoot(options) {
  const fromOption = String(options["workspace-root"] || "").trim();
  if (fromOption) return path.resolve(fromOption);

  const fromEnv = String(process.env.BOSS_WORKSPACE_ROOT || "").trim();
  if (fromEnv) return path.resolve(fromEnv);

  const cwd = path.resolve(process.cwd());
  const initCwd = String(process.env.INIT_CWD || "").trim();
  if (isEphemeralWorkspaceRoot(cwd) && initCwd) {
    return path.resolve(initCwd);
  }
  return cwd;
}

function readTextFile(filePath, label) {
  const resolved = path.resolve(String(filePath));
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${label} file: ${resolved}. ${error.message}`);
  }
}

function parseJsonOption(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error.message}`);
  }
}

function getRunInstruction(options) {
  if (typeof options.instruction === "string" && options.instruction.trim()) {
    return options.instruction.trim();
  }
  if (typeof options["instruction-file"] === "string" && options["instruction-file"].trim()) {
    return readTextFile(options["instruction-file"], "instruction").trim();
  }
  throw new Error("Missing required --instruction or --instruction-file");
}

function getRunConfirmation(options) {
  const filePath = options["confirmation-file"] || options["confirmation-json-path"];
  if (typeof filePath === "string" && filePath.trim()) {
    return parseJsonOption(readTextFile(filePath, "confirmation"), "confirmation");
  }
  return parseJsonOption(options["confirmation-json"], "confirmation");
}

function getRunOverrides(options) {
  const filePath = options["overrides-file"] || options["overrides-json-path"];
  if (typeof filePath === "string" && filePath.trim()) {
    return parseJsonOption(readTextFile(filePath, "overrides"), "overrides");
  }
  return parseJsonOption(options["overrides-json"], "overrides");
}

function getRunFollowUp(options) {
  const filePath = options["follow-up-file"] || options["follow-up-json-path"];
  if (typeof filePath === "string" && filePath.trim()) {
    return parseJsonOption(readTextFile(filePath, "follow_up"), "follow_up");
  }
  return parseJsonOption(options["follow-up-json"], "follow_up");
}

function normalizeMcpClientName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "claude-code") return "claudecode";
  if (raw === "trae-cn") return "trae";
  if (raw === "q-claw" || raw === "qclaw-win" || raw === "qclaw_win") return "qclaw";
  return raw;
}

function parseMcpClientTargets(rawValue) {
  if (!rawValue) return supportedMcpClients.slice();
  const raw = String(rawValue).trim().toLowerCase();
  if (!raw || raw === "all") return supportedMcpClients.slice();
  const candidates = raw.split(",").map(normalizeMcpClientName).filter(Boolean);
  const unique = [...new Set(candidates)];
  const invalid = unique.filter((item) => !supportedMcpClients.includes(item));
  if (invalid.length) {
    throw new Error(`Unsupported --client value: ${invalid.join(", ")}. Supported: ${supportedMcpClients.join(", ")}`);
  }
  return unique;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function shouldDefaultRecommendDetachedMcpEnv(options = {}) {
  const client = normalizeMcpClientName(options.client);
  const agent = normalizeAgentName(options.agent);
  return client === "openclaw"
    || client === "qclaw"
    || agent === "openclaw"
    || agent === "qclaw";
}

function getDefaultMcpEnv(options = {}) {
  return shouldDefaultRecommendDetachedMcpEnv(options)
    ? { ...detachedRecommendMcpEnv }
    : {};
}

function getAgentConfigOutputDir(options = {}) {
  if (typeof options["output-dir"] === "string" && options["output-dir"].trim()) {
    return path.resolve(options["output-dir"]);
  }
  return path.join(getStateHome(), "agent-mcp-configs");
}

function buildMcpLaunchConfig(options = {}) {
  const command = typeof options.command === "string" && options.command.trim()
    ? options.command.trim()
    : defaultMcpCommand;
  const args = parseJsonOption(options["args-json"], "args-json");
  const env = parseJsonOption(options["env-json"], "env-json");
  const launchArgs = Array.isArray(args) && args.length > 0
    ? args
    : command === "boss-recommend-mcp"
      ? ["start"]
      : buildDefaultMcpArgs(options);
  const launchConfig = { command, args: launchArgs };
  const mergedEnv = {
    ...getDefaultMcpEnv(options),
    ...(isPlainObject(env) ? env : {})
  };
  if (Object.keys(mergedEnv).length > 0) {
    launchConfig.env = mergedEnv;
  }
  return launchConfig;
}

function mergeExistingMcpEntryEnv(existingEntry, launchConfig) {
  if (!isPlainObject(existingEntry?.env) || !isPlainObject(launchConfig)) {
    return launchConfig;
  }
  return {
    ...launchConfig,
    env: {
      ...existingEntry.env,
      ...(isPlainObject(launchConfig.env) ? launchConfig.env : {})
    }
  };
}

function buildMcpConfigFileContent(options = {}) {
  const serverName = typeof options["server-name"] === "string" && options["server-name"].trim()
    ? options["server-name"].trim()
    : defaultMcpServerName;
  const launchConfig = buildMcpLaunchConfig(options);
  if (normalizeMcpClientName(options.client) === "qclaw") {
    return {
      mcp: {
        servers: {
          [serverName]: launchConfig
        }
      }
    };
  }
  return {
    mcpServers: {
      [serverName]: launchConfig
    }
  };
}

function writeMcpConfigFiles(options = {}) {
  const clients = parseMcpClientTargets(options.client);
  const outputDir = getAgentConfigOutputDir(options);
  ensureDir(outputDir);
  const files = [];
  for (const client of clients) {
    const filePath = path.join(outputDir, `mcp.${client}.json`);
    fs.writeFileSync(filePath, JSON.stringify(buildMcpConfigFileContent({ ...options, client }), null, 2), "utf8");
    files.push({ client, file: filePath });
  }
  return { outputDir, files };
}

function parsePathListFromEnv(raw) {
  if (!raw) return [];
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return dedupePaths(parsed.filter(Boolean));
    }
  } catch {
    // Fallback to delimiter split.
  }
  return dedupePaths(text.split(path.delimiter).map((item) => item.trim()).filter(Boolean));
}

const supportedExternalAgents = ["cursor", "trae", "trae-cn", "claude", "openclaw", "qclaw"];

function normalizeAgentName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "claude-code") return "claude";
  if (raw === "q-claw" || raw === "qclaw-win" || raw === "qclaw_win") return "qclaw";
  return raw;
}

function parseAgentTargets(rawValue) {
  if (!rawValue) return supportedExternalAgents.slice();
  const raw = String(rawValue).trim().toLowerCase();
  if (!raw || raw === "all") return supportedExternalAgents.slice();
  const candidates = raw.split(",").map(normalizeAgentName).filter(Boolean);
  const unique = [...new Set(candidates)];
  const invalid = unique.filter((item) => !supportedExternalAgents.includes(item));
  if (invalid.length > 0) {
    throw new Error(`Unsupported --agent value: ${invalid.join(", ")}. Supported: ${supportedExternalAgents.join(", ")}, all`);
  }
  return unique;
}

function getExternalAppSupportBaseDirs() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return dedupePaths([
      process.env.APPDATA || "",
      path.join(home, "AppData", "Roaming")
    ]);
  }
  if (process.platform === "darwin") {
    return dedupePaths([
      path.join(home, "Library", "Application Support")
    ]);
  }
  return dedupePaths([
    process.env.XDG_CONFIG_HOME || "",
    path.join(home, ".config")
  ]);
}

function buildAppUserPaths({ dirNames = [], tail = [] } = {}) {
  const paths = [];
  for (const baseDir of getExternalAppSupportBaseDirs()) {
    const discovered = discoverAppDataDirsByPattern(baseDir, /^trae(?:[\s\-_]?cn)?$/i);
    const names = dedupeLower([...dirNames, ...discovered]);
    for (const dirName of names) {
      paths.push(path.join(baseDir, dirName, "User", ...tail));
    }
  }
  return dedupePaths(paths);
}

function getKnownExternalMcpConfigPathsByAgent() {
  const home = os.homedir();
  const appBases = getExternalAppSupportBaseDirs();
  const traeDirNames = [
    "Trae",
    "Trae CN",
    "TraeCN",
    "trae-cn",
    "trae_cn"
  ];
  const traeConfigPaths = buildAppUserPaths({ dirNames: traeDirNames, tail: ["mcp.json"] });
  const cursorConfigPaths = appBases.map((baseDir) => path.join(baseDir, "Cursor", "User", "mcp.json"));
  const openClawConfigPaths = appBases.map((baseDir) => path.join(baseDir, "OpenClaw", "User", "mcp.json"));
  return {
    cursor: [...cursorConfigPaths, path.join(home, ".cursor", "mcp.json")],
    trae: [...traeConfigPaths, path.join(home, ".trae", "mcp.json"), path.join(home, ".trae-cn", "mcp.json")],
    "trae-cn": [...traeConfigPaths, path.join(home, ".trae-cn", "mcp.json"), path.join(home, ".trae", "mcp.json")],
    claude: [path.join(home, ".claude", "mcp.json")],
    openclaw: [path.join(home, ".openclaw", "mcp.json"), path.join(home, ".openclaw", "openclaw.json"), ...openClawConfigPaths],
    qclaw: [path.join(home, ".qclaw", "openclaw.json")]
  };
}

function resolveExternalMcpConfigTargets(options = {}) {
  const fromEnv = parsePathListFromEnv(process.env[externalMcpTargetsEnv]);
  const pathMap = getKnownExternalMcpConfigPathsByAgent();
  const agents = parseAgentTargets(options.agent);
  const knownCandidates = agents.flatMap((agent) => pathMap[agent] || []);
  const known = dedupePaths(knownCandidates).filter((filePath) => {
    if (options.agent) return true;
    if (pathExists(filePath)) return true;
    return pathExists(path.dirname(filePath));
  });
  return dedupePaths([...fromEnv, ...known]);
}

function isQClawMcpConfigTarget(filePath, options = {}, current = null) {
  if (normalizeAgentName(options.agent) === "qclaw" || normalizeMcpClientName(options.client) === "qclaw") {
    return true;
  }
  const normalized = path.resolve(String(filePath || "")).replace(/\\/g, "/").toLowerCase();
  if (normalized.endsWith("/.qclaw/openclaw.json")) {
    return true;
  }
  return Boolean(
    current?.mcp?.servers
    && typeof current.mcp.servers === "object"
    && !Array.isArray(current.mcp.servers)
    && !current?.mcpServers
  );
}

function getMcpServersFromConfig(config = {}, useQClawShape = false) {
  const servers = useQClawShape ? config?.mcp?.servers : config?.mcpServers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    return servers;
  }
  return {};
}

function mergeMcpServerConfigFile(filePath, options = {}) {
  const current = readJsonObjectFileSafe(filePath);
  const useQClawShape = isQClawMcpConfigTarget(filePath, options, current);
  const nextConfig = buildMcpConfigFileContent({ ...options, client: useQClawShape ? "qclaw" : options.client });
  const nextServers = useQClawShape ? nextConfig.mcp?.servers : nextConfig.mcpServers;
  const serverName = Object.keys(nextServers || {})[0] || defaultMcpServerName;
  const existingServers = getMcpServersFromConfig(current, useQClawShape);
  const existingEntry = existingServers[serverName];
  const launchConfig = mergeExistingMcpEntryEnv(
    existingEntry,
    nextServers?.[serverName] || buildMcpLaunchConfig(options)
  );
  const retainedServers = {};
  const migratedLegacyServers = [];
  for (const [name, config] of Object.entries(existingServers)) {
    if (name === serverName) continue;
    if (isBossMcpServerEntry(name, config)) {
      migratedLegacyServers.push(name);
      continue;
    }
    retainedServers[name] = config;
  }
  const merged = useQClawShape
    ? {
        ...current,
        mcp: {
          ...(current?.mcp && typeof current.mcp === "object" && !Array.isArray(current.mcp) ? current.mcp : {}),
          servers: {
            ...retainedServers,
            [serverName]: launchConfig
          }
        }
      }
    : {
        ...current,
        mcpServers: {
          ...retainedServers,
          [serverName]: launchConfig
        }
      };

  ensureDir(path.dirname(filePath));
  const before = pathExists(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const next = JSON.stringify(merged, null, 2);
  let backupFile = null;
  if (before && before.trim() !== next.trim()) {
    backupFile = `${filePath}.boss-mcp-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    fs.writeFileSync(backupFile, before, "utf8");
  }
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  const updated = before.trim() !== next.trim() || JSON.stringify(existingEntry || null) !== JSON.stringify(launchConfig);
  return {
    file: filePath,
    server: serverName,
    config_shape: useQClawShape ? "qclaw" : "mcpServers",
    updated,
    migrated_legacy_servers: migratedLegacyServers,
    backup_file: backupFile
  };
}

function installExternalMcpConfigs(options = {}) {
  const targets = resolveExternalMcpConfigTargets(options);
  const applied = [];
  const skipped = [];
  for (const target of targets) {
    try {
      const existed = pathExists(target);
      const merged = mergeMcpServerConfigFile(target, options);
      applied.push({
        file: target,
        server: merged.server,
        created: !existed,
        updated: merged.updated,
        migrated_legacy_servers: merged.migrated_legacy_servers,
        backup_file: merged.backup_file
      });
    } catch (error) {
      skipped.push({
        file: target,
        reason: error.message
      });
    }
  }
  return { targets, applied, skipped };
}

function getKnownExternalSkillBaseDirsByAgent() {
  const home = os.homedir();
  const appBases = getExternalAppSupportBaseDirs();
  const traeDirNames = [
    "Trae",
    "Trae CN",
    "TraeCN",
    "trae-cn",
    "trae_cn"
  ];
  const traeSkillDirs = buildAppUserPaths({ dirNames: traeDirNames, tail: ["skills"] });
  const cursorSkillDirs = appBases.map((baseDir) => path.join(baseDir, "Cursor", "User", "skills"));
  const openClawSkillDirs = appBases.map((baseDir) => path.join(baseDir, "OpenClaw", "User", "skills"));
  return {
    cursor: [path.join(home, ".cursor", "skills"), ...cursorSkillDirs],
    trae: [path.join(home, ".trae", "skills"), path.join(home, ".trae-cn", "skills"), ...traeSkillDirs],
    "trae-cn": [path.join(home, ".trae-cn", "skills"), path.join(home, ".trae", "skills"), ...traeSkillDirs],
    claude: [path.join(home, ".claude", "skills")],
    openclaw: [path.join(home, ".openclaw", "skills"), ...openClawSkillDirs],
    qclaw: [path.join(home, ".qclaw", "skills")]
  };
}

function serializeMcpLaunchConfig(launchConfig) {
  return JSON.stringify(launchConfig || {}).toLowerCase().replace(/\\/g, "/");
}

function isRecommendMcpLaunchConfig(launchConfig) {
  if (!launchConfig || typeof launchConfig !== "object") return false;
  const command = String(launchConfig.command || "").toLowerCase();
  const args = Array.isArray(launchConfig.args) ? launchConfig.args : [];
  const joined = `${command} ${args.map((item) => String(item || "")).join(" ")}`.toLowerCase();
  return (
    joined.includes(recommendMcpPackageName.toLowerCase())
    || joined.includes(`${recommendMcpBinaryName} start`)
    || (command.endsWith(recommendMcpBinaryName) && args.includes("start"))
    || command === recommendMcpBinaryName
  );
}

function isBossMcpServerEntry(name, launchConfig) {
  const lowerName = String(name || "").toLowerCase();
  const serialized = serializeMcpLaunchConfig(launchConfig);
  return (
    /boss[-_\s]?(recommend|recruit|chat)/i.test(lowerName)
    || serialized.includes(recommendMcpPackageName.toLowerCase())
    || serialized.includes("@reconcrap/boss-recruit-mcp")
    || serialized.includes("@reconcrap/boss-chat")
    || serialized.includes("boss-recommend-mcp")
    || serialized.includes("boss-recruit-mcp")
    || serialized.includes("boss-chat")
    || serialized.includes("boss recommend pipeline")
    || serialized.includes("boss recruit pipeline")
  );
}

function inspectMcpServerEntries(filePath) {
  if (!pathExists(filePath)) {
    return {
      exists: false,
      has_boss_recommend: false,
      has_boss_recruit: false,
      has_boss_chat: false,
      recommend_server_names: [],
      recruit_server_names: [],
      chat_server_names: [],
      boss_server_names: []
    };
  }
  const parsed = readJsonObjectFileSafe(filePath);
  const rootServers = getMcpServersFromConfig(parsed, false);
  const qclawServers = getMcpServersFromConfig(parsed, true);
  const servers = { ...rootServers, ...qclawServers };
  const recommendNames = [];
  const recruitNames = [];
  const chatNames = [];
  const bossNames = [];
  for (const [name, config] of Object.entries(servers)) {
    const lowerName = String(name || "").toLowerCase();
    if (isBossMcpServerEntry(name, config)) {
      bossNames.push(name);
    }
    if (isRecommendMcpLaunchConfig(config) || lowerName.includes("boss-recommend")) {
      recommendNames.push(name);
    }
    const serialized = JSON.stringify(config || {}).toLowerCase();
    if (
      lowerName.includes("boss-recruit")
      || serialized.includes("@reconcrap/boss-recruit-mcp")
      || serialized.includes("boss-recruit-mcp")
    ) {
      recruitNames.push(name);
    }
    if (
      lowerName.includes("boss-chat")
      || serialized.includes("@reconcrap/boss-chat")
      || serialized.includes("boss-chat")
    ) {
      chatNames.push(name);
    }
  }
  return {
    exists: true,
    has_boss_recommend: recommendNames.length > 0,
    has_boss_recruit: recruitNames.length > 0,
    has_boss_chat: chatNames.length > 0,
    recommend_server_names: recommendNames,
    recruit_server_names: recruitNames,
    chat_server_names: chatNames,
    boss_server_names: bossNames
  };
}

function resolveExternalSkillBaseDirs(options = {}) {
  const fromEnv = parsePathListFromEnv(process.env[externalSkillDirsEnv]);
  const pathMap = getKnownExternalSkillBaseDirsByAgent();
  const agents = parseAgentTargets(options.agent);
  const knownCandidates = agents.flatMap((agent) => pathMap[agent] || []);
  const known = dedupePaths(knownCandidates).filter((dirPath) => {
    if (options.agent) return true;
    return pathExists(dirPath);
  });
  return dedupePaths([...fromEnv, ...known]);
}

function mirrorSkillToExternalDirs(options = {}) {
  const baseDirs = resolveExternalSkillBaseDirs(options);
  const mirrored = [];
  const skipped = [];
  for (const baseDir of baseDirs) {
    for (const bundledSkillName of bundledSkillNames) {
      try {
        const targetDir = path.join(baseDir, bundledSkillName);
        const legacyBeforeCopy = isLegacyBossSkillDir(targetDir);
        ensureDir(path.dirname(targetDir));
        fs.cpSync(getSkillSourceDir(bundledSkillName), targetDir, { recursive: true, force: true });
        fs.writeFileSync(path.join(targetDir, ".installed-version"), `${packageVersion}\n`, "utf8");
        mirrored.push({
          base_dir: baseDir,
          target_dir: targetDir,
          skill: bundledSkillName,
          replaced_legacy: legacyBeforeCopy
        });
      } catch (error) {
        skipped.push({ base_dir: baseDir, skill: bundledSkillName, reason: error.message });
      }
    }
  }
  return { baseDirs, mirrored, skipped };
}

function isLegacyBossSkillDir(targetDir) {
  const skillFile = path.join(targetDir, "SKILL.md");
  if (!pathExists(skillFile)) return false;
  try {
    const content = fs.readFileSync(skillFile, "utf8").toLowerCase();
    return (
      content.includes("@reconcrap/boss-recruit-mcp")
      || content.includes("@reconcrap/boss-chat")
      || content.includes("boss-screen-cli")
      || content.includes(`runtime.${"evaluate"}`)
      || content.includes("page js")
    );
  } catch {
    return false;
  }
}

function syncSkillAssets(options = {}) {
  const force = options.force === true;
  const results = [];
  for (const bundledSkillName of bundledSkillNames) {
    const targetDir = getSkillTargetDir(bundledSkillName);
    const skillEntry = path.join(targetDir, "SKILL.md");
    const installedVersion = readInstalledSkillVersion(bundledSkillName);
    const needsSync = force || !fs.existsSync(skillEntry) || installedVersion !== packageVersion;
    if (needsSync) {
      ensureDir(path.dirname(targetDir));
      fs.cpSync(getSkillSourceDir(bundledSkillName), targetDir, { recursive: true, force: true });
      writeInstalledSkillVersion(bundledSkillName, packageVersion);
    }
    results.push({
      skill: bundledSkillName,
      targetDir,
      updated: needsSync,
      installedVersion,
      packageVersion
    });
  }
  return {
    primaryTargetDir: results[0]?.targetDir || null,
    results
  };
}

function ensureAssetsUpToDate(command) {
  if (autoSyncSkipCommands.has(command)) return;
  try {
    syncSkillAssets({ force: false });
  } catch {
    // Keep runtime commands stable even if sync fails.
  }
}

function installSkill() {
  return syncSkillAssets({ force: true }).results;
}

function pathStartsWith(filePath, rootPath) {
  const file = path.resolve(String(filePath || ""));
  const root = path.resolve(String(rootPath || ""));
  if (process.platform === "win32") {
    return file.toLowerCase().startsWith(root.toLowerCase());
  }
  return file.startsWith(root);
}

async function resolveCliConfigTarget(options = {}) {
  const workspaceRoot = getWorkspaceRoot(options);
  const resolution = getBossScreenConfigResolution(workspaceRoot);
  const workspacePreferred = (resolution.candidate_paths || []).find((item) => pathStartsWith(item, workspaceRoot)) || null;
  const configPath = resolution.writable_path || resolution.resolved_path || workspacePreferred || getUserConfigPath();
  return {
    workspaceRoot,
    resolution,
    configPath,
    workspacePreferred
  };
}

function applyMissingInstallConfigDefaults(config = {}) {
  const nextConfig = { ...config };
  const patchedKeys = [];
  for (const [key, defaultValue] of Object.entries(installConfigDefaults)) {
    if (!Object.prototype.hasOwnProperty.call(nextConfig, key)) {
      nextConfig[key] = defaultValue;
      patchedKeys.push(key);
    }
  }
  if (
    nextConfig.humanBehavior
    && typeof nextConfig.humanBehavior === "object"
    && !Array.isArray(nextConfig.humanBehavior)
    && !Object.prototype.hasOwnProperty.call(nextConfig.humanBehavior, "restLevel")
    && !Object.prototype.hasOwnProperty.call(nextConfig.humanBehavior, "rest_level")
  ) {
    nextConfig.humanBehavior = {
      ...nextConfig.humanBehavior,
      restLevel: "low"
    };
    patchedKeys.push("humanBehavior.restLevel");
  }
  return {
    nextConfig,
    patchedKeys
  };
}

async function ensureUserConfig(options = {}) {
  const { configPath, workspacePreferred } = await resolveCliConfigTarget(options);
  const writeTargets = dedupePaths([configPath, workspacePreferred]).filter(Boolean);
  let lastError = null;
  for (const targetPath of writeTargets) {
    try {
      ensureDir(path.dirname(targetPath));
      if (!fs.existsSync(targetPath)) {
        const template = JSON.parse(fs.readFileSync(exampleConfigPath, "utf8"));
        template.outputDir = getDesktopDir();
        template.debugPort = 9222;
        fs.writeFileSync(targetPath, JSON.stringify(template, null, 2), "utf8");
        return { path: targetPath, created: true };
      }
      const stat = fs.statSync(targetPath);
      if (stat.isFile()) {
        try {
          const existingConfig = readJsonObjectFile(targetPath);
          const patched = applyMissingInstallConfigDefaults(existingConfig);
          if (patched.patchedKeys.length > 0) {
            fs.writeFileSync(targetPath, JSON.stringify(patched.nextConfig, null, 2), "utf8");
          }
          return {
            path: targetPath,
            created: false,
            patched: patched.patchedKeys.length > 0,
            patched_keys: patched.patchedKeys
          };
        } catch (error) {
          return {
            path: targetPath,
            created: false,
            patched: false,
            patched_keys: [],
            patch_error: error?.message || "screening-config.json 解析失败，跳过自动补字段。"
          };
        }
      }
      lastError = new Error(`Config target is a directory and cannot be used as file: ${targetPath}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No writable target for screening-config.json");
}

async function collectRuntimeDirectories(options = {}) {
  const workspaceRoot = getWorkspaceRoot(options);
  const stateHome = getStateHome();
  const runtime = resolveCdpBossChatRuntimeLayout(workspaceRoot);
  const bossChatRoot = runtime.data_dir;
  const recommendRuntimeDirs = [
    stateHome,
    path.join(stateHome, "runs")
  ];
  const bossChatRuntimeDirs = getBossChatRuntimeDirectories(runtime);
  return {
    workspaceRoot,
    stateHome,
    bossChatRoot,
    legacyBossChatRoot: runtime.legacy_workspace_dir,
    migrationPending: runtime.migration_pending,
    directories: dedupePaths([
      ...recommendRuntimeDirs,
      ...bossChatRuntimeDirs
    ]).filter(Boolean)
  };
}

async function ensureRuntimeDirectories(options = {}) {
  const { workspaceRoot, stateHome } = await collectRuntimeDirectories(options);
  const runtime = ensureBossChatRuntimeReadyLocal(workspaceRoot);
  const recommendCreated = [];
  const recommendExisted = [];
  const failed = [...runtime.failed];

  for (const directory of [stateHome, path.join(stateHome, "runs")]) {
    try {
      const existedBefore = fs.existsSync(directory);
      ensureDir(directory);
      if (existedBefore) {
        recommendExisted.push(directory);
      } else {
        recommendCreated.push(directory);
      }
    } catch (error) {
      failed.push({
        path: directory,
        message: error?.message || String(error)
      });
    }
  }

  return {
    workspaceRoot,
    stateHome,
    bossChatRoot: runtime.data_dir,
    legacyBossChatRoot: runtime.legacy_workspace_dir,
    migrationPending: runtime.migration_pending,
    migration: runtime.migration,
    created: dedupePaths([...recommendCreated, ...runtime.created]),
    existed: dedupePaths([...recommendExisted, ...runtime.existed]),
    failed
  };
}

function readJsonObjectFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config content must be a JSON object");
  }
  return parsed;
}

async function loadBestExistingUserConfig(options = {}) {
  const { resolution, configPath, workspacePreferred } = await resolveCliConfigTarget(options);
  const candidates = dedupePaths([
    ...(resolution.candidate_paths || []),
    configPath,
    workspacePreferred,
    getLegacyUserConfigPath()
  ]).filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) {
          continue;
        }
      } catch {
        continue;
      }
      return { path: candidate, config: readJsonObjectFile(candidate) };
    }
  }
  return { path: configPath, config: {} };
}

async function writeConfigWithFallback(nextConfig, options = {}) {
  const { configPath, workspacePreferred } = await resolveCliConfigTarget(options);
  const targets = dedupePaths([configPath, workspacePreferred]).filter(Boolean);
  let lastError = null;
  for (const target of targets) {
    try {
      ensureDir(path.dirname(target));
      if (fs.existsSync(target)) {
        const stat = fs.statSync(target);
        if (!stat.isFile()) {
          lastError = new Error(`Config target is a directory and cannot be used as file: ${target}`);
          continue;
        }
      }
      fs.writeFileSync(target, JSON.stringify(nextConfig, null, 2), "utf8");
      return target;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No writable target for screening-config.json");
}

async function persistDebugPortSelection(port, options = {}) {
  const { config } = await loadBestExistingUserConfig(options);
  config.debugPort = port;
  const configPath = await writeConfigWithFallback(config, options);
  return { port, configPath };
}

async function setDebugPort(options = {}) {
  const selected = parsePositivePort(options.port);
  if (!selected) {
    throw new Error("Missing required --port <number> for set-port.");
  }
  process.env.BOSS_RECOMMEND_CHROME_PORT = String(selected);
  return persistDebugPortSelection(selected, options);
}

async function setScreeningConfig(options = {}) {
  const baseUrl = String(options["base-url"] || options.baseUrl || "").trim();
  const apiKey = String(options["api-key"] || options.apiKey || "").trim();
  const model = String(options.model || "").trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Missing required fields: --base-url, --api-key, --model");
  }

  const { config: existing } = await loadBestExistingUserConfig(options);
  const nextConfig = {
    ...existing,
    baseUrl,
    apiKey,
    model
  };
  delete nextConfig.llmModels;
  delete nextConfig.models;
  if (typeof options["thinking-level"] === "string" && options["thinking-level"].trim()) {
    nextConfig.llmThinkingLevel = options["thinking-level"].trim();
  } else if (typeof options.llmThinkingLevel === "string" && options.llmThinkingLevel.trim()) {
    nextConfig.llmThinkingLevel = options.llmThinkingLevel.trim();
  }
  if (typeof options["openai-organization"] === "string") {
    nextConfig.openaiOrganization = options["openai-organization"];
  }
  if (typeof options["openai-project"] === "string") {
    nextConfig.openaiProject = options["openai-project"];
  }
  if (typeof options["output-dir"] === "string" && options["output-dir"].trim()) {
    nextConfig.outputDir = options["output-dir"].trim();
  }
  const greetingMessage = String(
    options["greeting-message"]
    ?? options.greetingMessage
    ?? options.greeting_text
    ?? options.greetingText
    ?? ""
  ).trim();
  if (greetingMessage) {
    nextConfig.greetingMessage = greetingMessage;
  }
  const debugPort = parsePositivePort(options.port || options["debug-port"]);
  if (debugPort) {
    nextConfig.debugPort = debugPort;
  }
  const configPath = await writeConfigWithFallback(nextConfig, options);
  return { path: configPath, updated: true };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function stripDetachedRunArgs(args = []) {
  const booleanKeys = new Set(["--detached", "--background"]);
  const valueKeys = new Set(["--detached-start-timeout-ms"]);
  const nextArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (booleanKeys.has(token)) continue;
    if (valueKeys.has(token)) {
      index += 1;
      continue;
    }
    nextArgs.push(token);
  }
  return nextArgs;
}

function extractFirstJsonObject(text = "") {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function readFirstJsonObjectFromFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const jsonText = extractFirstJsonObject(text);
    return jsonText ? JSON.parse(jsonText) : null;
  } catch {
    return null;
  }
}

function createDetachedRecommendRunPaths() {
  const dir = path.join(getStateHome(), "detached-runs");
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const nonce = Math.random().toString(36).slice(2, 8);
  const base = `recommend-run-${stamp}-${nonce}`;
  return {
    dir,
    stdoutPath: path.join(dir, `${base}.stdout.json`),
    stderrPath: path.join(dir, `${base}.stderr.log`)
  };
}

function appendDetachedCliMeta(payload, meta) {
  return {
    ...payload,
    cli: {
      ...(payload?.cli || {}),
      command: "run",
      cdp_only: true,
      detached: true,
      detached_parent: true,
      child_pid: meta.childPid || null,
      stdout_path: meta.stdoutPath,
      stderr_path: meta.stderrPath
    }
  };
}

async function waitForDetachedRecommendRunStart({
  child,
  stdoutPath,
  stderrPath,
  timeoutMs
}) {
  const deadline = Date.now() + timeoutMs;
  let childExit = null;
  child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });

  while (Date.now() <= deadline) {
    const parsed = readFirstJsonObjectFromFile(stdoutPath);
    if (parsed) return appendDetachedCliMeta(parsed, {
      childPid: child.pid,
      stdoutPath,
      stderrPath
    });
    if (childExit) break;
    await sleepMs(500);
  }

  const stderrPreview = (() => {
    try {
      return fs.readFileSync(stderrPath, "utf8").slice(-2000);
    } catch {
      return "";
    }
  })();

  return appendDetachedCliMeta({
    status: "FAILED",
    error: {
      code: childExit ? "DETACHED_RECOMMEND_RUN_CHILD_EXITED" : "DETACHED_RECOMMEND_RUN_START_TIMEOUT",
      message: childExit
        ? `Detached recommend run child exited before producing a JSON result (code=${childExit.code ?? "null"}, signal=${childExit.signal ?? "null"}).`
        : `Timed out waiting ${timeoutMs}ms for detached recommend run start output.`,
      retryable: true,
      child_exit: childExit,
      stderr_preview: stderrPreview || null
    }
  }, {
    childPid: child.pid,
    stdoutPath,
    stderrPath
  });
}

async function runPipelineDetached(rawArgs = [], options = {}) {
  const timeoutMs = parseNonNegativeInteger(options["detached-start-timeout-ms"], 180000);
  const childArgs = stripDetachedRunArgs(rawArgs);
  const { stdoutPath, stderrPath } = createDetachedRecommendRunPaths();
  const stdoutFd = fs.openSync(stdoutPath, "a");
  const stderrFd = fs.openSync(stderrPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [currentFilePath, "run", ...childArgs], {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        [detachedRecommendRunChildEnv]: "1"
      },
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  child.unref();

  const result = await waitForDetachedRecommendRunStart({
    child,
    stdoutPath,
    stderrPath,
    timeoutMs
  });
  printJson(result);
  if (result.status !== "ACCEPTED") {
    process.exitCode = 1;
  }
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

function isBossRecommendTab(tab) {
  return typeof tab?.url === "string" && tab.url.includes("/web/chat/recommend");
}

function findBossRecommendTab(tabs = []) {
  return tabs.find((tab) => isBossRecommendTab(tab)) || null;
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

function findBossPageTab(tabs = []) {
  return tabs.find((tab) => typeof tab?.url === "string" && tab.url.includes("zhipin.com")) || null;
}

function getNodeAttribute(node, name) {
  const attributes = node?.attributes || [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === name) return attributes[index + 1] || "";
  }
  return "";
}

function uniqueMethodNames(methodLog = []) {
  return Array.from(new Set(methodLog.map((entry) => entry?.method).filter(Boolean)));
}

async function inspectBossRecommendPageStateCdp(port, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 1000;
  const expectedUrl = options.expectedUrl || bossUrl;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastTabs = [];

  while (Date.now() <= deadline) {
    try {
      const tabs = await listChromeTabs(port);
      lastTabs = tabs;
      const recommendTab = findBossRecommendTab(tabs);
      if (recommendTab) {
        if (isBossLoginTab(recommendTab)) {
          return buildBossPageState({
            ok: false,
            state: "LOGIN_REQUIRED",
            path: recommendTab.url || bossLoginUrl,
            current_url: recommendTab.url || bossLoginUrl,
            title: recommendTab.title || null,
            requires_login: true,
            expected_url: expectedUrl,
            login_url: bossLoginUrl,
            message: "当前标签页虽在 recommend 路径，但检测到登录态页面特征，请先完成 Boss 登录。"
          });
        }
        return buildBossPageState({
          ok: true,
          state: "RECOMMEND_READY",
          path: recommendTab.url,
          current_url: recommendTab.url,
          title: recommendTab.title || null,
          requires_login: false,
          expected_url: expectedUrl,
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

      const bossTab = findBossPageTab(tabs);
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
          login_url: requiresLogin ? bossLoginUrl : undefined,
          message: requiresLogin
            ? "Boss 页面未登录，需先完成登录后再进入 recommend 页面。"
            : "Boss 已登录但当前不在 recommend 页面，将尝试自动跳转。"
        });
      }
    } catch (error) {
      lastError = error;
    }

    await sleepMs(pollMs);
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
    expected_url: expectedUrl,
    message: "未检测到 Boss 推荐页标签页。",
    sample_urls: extractSampleUrls(lastTabs)
  });
}

async function withRecommendTargetCdp(port, callback) {
  const connection = await connectToChromeTarget({
    port,
    targetPredicate: (target) => isBossRecommendTab(target)
  });
  try {
    return await callback(connection);
  } finally {
    await connection.close();
  }
}

async function bringBossRecommendTabToFrontCdp(port) {
  try {
    return await withRecommendTargetCdp(port, async ({ client, methodLog }) => {
      await enableDomains(client, ["Page"]);
      await bringPageToFront(client);
      assertNoForbiddenCdpCalls(methodLog);
      return {
        ok: true,
        method_log: uniqueMethodNames(methodLog)
      };
    });
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error)
    };
  }
}

async function probeRecommendIframeStateCdp(port, options = {}) {
  const expectedUrl = options.expectedUrl || bossUrl;
  try {
    return await withRecommendTargetCdp(port, async ({ client, target, methodLog }) => {
      await enableDomains(client, ["Page", "DOM"]);
      const root = await getDocumentRoot(client, { depth: 1, pierce: true });
      const iframeNodeId = await querySelector(client, root.nodeId, 'iframe[name="recommendFrame"]');
      if (!iframeNodeId) {
        assertNoForbiddenCdpCalls(methodLog);
        return buildBossPageState({
          ok: false,
          state: "NO_RECOMMEND_IFRAME",
          path: target.url || expectedUrl,
          current_url: target.url || null,
          title: target.title || null,
          expected_url: expectedUrl,
          message: "recommend iframe 尚未挂载。",
          method_log: uniqueMethodNames(methodLog)
        });
      }

      const described = await client.DOM.describeNode({
        nodeId: iframeNodeId,
        depth: 1,
        pierce: true
      });
      const iframeNode = described.node || {};
      const frameDocument = iframeNode.contentDocument || null;
      const frameUrl = frameDocument?.documentURL || getNodeAttribute(iframeNode, "src") || null;
      assertNoForbiddenCdpCalls(methodLog);
      if (!frameDocument?.nodeId) {
        return buildBossPageState({
          ok: false,
          state: "RECOMMEND_IFRAME_DOCUMENT_PENDING",
          path: target.url || expectedUrl,
          current_url: target.url || null,
          title: target.title || null,
          expected_url: expectedUrl,
          frame_url: frameUrl,
          message: "recommend iframe 已挂载但文档尚未就绪。",
          method_log: uniqueMethodNames(methodLog)
        });
      }

      return buildBossPageState({
        ok: true,
        state: "RECOMMEND_IFRAME_READY",
        path: target.url || expectedUrl,
        current_url: target.url || null,
        title: target.title || null,
        expected_url: expectedUrl,
        frame_url: frameUrl,
        iframe_node_id: iframeNodeId,
        frame_document_node_id: frameDocument.nodeId,
        message: "recommend iframe 已通过 CDP DOM 检测就绪。",
        method_log: uniqueMethodNames(methodLog)
      });
    });
  } catch (error) {
    return buildBossPageState({
      ok: false,
      state: "RECOMMEND_IFRAME_PROBE_FAILED",
      path: expectedUrl,
      current_url: null,
      title: null,
      expected_url: expectedUrl,
      message: "recommend iframe CDP DOM 检测失败。",
      error: error.message || String(error)
    });
  }
}

async function waitForRecommendIframeReadyCdp(port, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 800;
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() <= deadline) {
    lastState = await probeRecommendIframeStateCdp(port, options);
    if (lastState?.state === "RECOMMEND_IFRAME_READY") return lastState;
    await sleepMs(pollMs);
  }

  return lastState || buildBossPageState({
    ok: false,
    state: "NO_RECOMMEND_IFRAME",
    path: options.expectedUrl || bossUrl,
    current_url: null,
    title: null,
    expected_url: options.expectedUrl || bossUrl,
    message: "recommend iframe 尚未就绪。"
  });
}

async function verifyRecommendPageStableCdp(port, options = {}) {
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 1000;
  const recheckTimeoutMs = Number.isFinite(options.recheckTimeoutMs) ? options.recheckTimeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 800;

  await sleepMs(settleMs);
  const recheck = await inspectBossRecommendPageStateCdp(port, {
    timeoutMs: recheckTimeoutMs,
    pollMs
  });
  if (recheck.state !== "RECOMMEND_READY") return recheck;

  const iframeState = await waitForRecommendIframeReadyCdp(port, {
    timeoutMs: recheckTimeoutMs,
    pollMs
  });
  if (iframeState.state === "RECOMMEND_IFRAME_READY") {
    return buildBossPageState({
      ...recheck,
      ok: true,
      state: "RECOMMEND_READY",
      frame_url: iframeState.frame_url || null,
      iframe_state: iframeState,
      method_log: iframeState.method_log || []
    });
  }

  return buildBossPageState({
    ...iframeState,
    state: iframeState.state || "NO_RECOMMEND_IFRAME",
    message: iframeState.message || "Boss recommend 页面已打开，但 iframe 尚未就绪。"
  });
}

async function navigateExistingTargetToBossRecommendCdp(port) {
  let connection = null;
  try {
    connection = await connectToChromeTarget({
      port,
      targetPredicate: (target) => target?.type === "page"
    });
    await enableDomains(connection.client, ["Page"]);
    await connection.client.Page.navigate({ url: bossUrl });
    assertNoForbiddenCdpCalls(connection.methodLog);
    return {
      ok: true,
      via: "cdp_page_navigate",
      target_id: connection.target?.id || null,
      method_log: uniqueMethodNames(connection.methodLog)
    };
  } catch (error) {
    return {
      ok: false,
      via: "cdp_page_navigate",
      error: error.message || String(error)
    };
  } finally {
    if (connection) await connection.close();
  }
}

async function openBossRecommendTabCdp(port) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(bossUrl)}`;
  const attempts = ["PUT", "GET"];
  let lastError = null;

  for (const method of attempts) {
    try {
      const response = await fetch(endpoint, { method });
      if (response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {}
        return {
          ok: true,
          via: "devtools_http_new_tab",
          method,
          target_id: payload?.id || null,
          current_url: payload?.url || bossUrl
        };
      }
      lastError = new Error(`DevTools /json/new returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }

  const fallback = await navigateExistingTargetToBossRecommendCdp(port);
  if (fallback.ok) return fallback;
  return {
    ok: false,
    via: "devtools_http_new_tab",
    error: lastError?.message || fallback.error || "Failed to open Boss recommend tab via DevTools"
  };
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
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getChromeUserDataDir(port) {
  const targetPath = resolveDefaultChromeUserDataDir(port);
  ensureDir(targetPath);
  return targetPath;
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

function getLaunchChromeTiming(options = {}) {
  if (options["slow-live"] || options.slowLive) {
    return {
      initialTimeoutMs: 5000,
      inspectTimeoutMs: 20000,
      pollMs: 1000,
      settleMs: 2000
    };
  }
  return {
    initialTimeoutMs: 1500,
    inspectTimeoutMs: 6000,
    pollMs: 800,
    settleMs: 1000
  };
}

async function ensureBossRecommendPageReadyCdp(port, options = {}) {
  const attempts = Number.isFinite(options.attempts) ? Math.max(0, options.attempts) : 3;
  const inspectTimeoutMs = Number.isFinite(options.inspectTimeoutMs) ? options.inspectTimeoutMs : 6000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 800;
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 1000;

  let pageState = await inspectBossRecommendPageStateCdp(port, {
    timeoutMs: inspectTimeoutMs,
    pollMs
  });
  if (pageState.state === "RECOMMEND_READY") {
    const stableState = await verifyRecommendPageStableCdp(port, {
      settleMs,
      recheckTimeoutMs: inspectTimeoutMs,
      pollMs
    });
    return {
      ok: stableState.state === "RECOMMEND_READY",
      debug_port: port,
      state: stableState.state,
      page_state: stableState
    };
  }

  if (pageState.state === "LOGIN_REQUIRED") {
    return {
      ok: false,
      debug_port: port,
      state: pageState.state,
      page_state: pageState
    };
  }

  let openAttempt = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (pageState.state === "DEBUG_PORT_UNREACHABLE" || pageState.state === "LOGIN_REQUIRED") break;
    openAttempt = await openBossRecommendTabCdp(port);
    await sleepMs(settleMs);
    pageState = await inspectBossRecommendPageStateCdp(port, {
      timeoutMs: inspectTimeoutMs,
      pollMs
    });
    if (pageState.state === "RECOMMEND_READY") {
      const stableState = await verifyRecommendPageStableCdp(port, {
        settleMs,
        recheckTimeoutMs: inspectTimeoutMs,
        pollMs
      });
      return {
        ok: stableState.state === "RECOMMEND_READY",
        debug_port: port,
        state: stableState.state,
        page_state: {
          ...stableState,
          open_attempt: openAttempt
        }
      };
    }
    if (pageState.state === "LOGIN_REQUIRED") break;
  }

  return {
    ok: false,
    debug_port: port,
    state: pageState.state || "UNKNOWN",
    page_state: {
      ...pageState,
      open_attempt: openAttempt
    }
  };
}

async function launchChrome(options = {}) {
  const port = parsePositivePort(options.port) || parsePositivePort(process.env.BOSS_RECOMMEND_CHROME_PORT) || 9222;
  process.env.BOSS_RECOMMEND_CHROME_PORT = String(port);
  const timing = getLaunchChromeTiming(options);
  const userDataDir = getChromeUserDataDir(port);
  let chromeGuard = null;
  try {
    chromeGuard = await ensureChromeDebugPort({
      port,
      url: bossUrl,
      slowLive: Boolean(options["slow-live"] || options.slowLive),
      launchIfMissing: true,
      userDataDir
    });
  } catch (error) {
    console.error(error?.message || String(error || "Chrome launch failed"));
    if (error?.chrome_guard) {
      console.error(JSON.stringify(error.chrome_guard, null, 2));
    }
    process.exitCode = 1;
    return;
  }

  if (chromeGuard.replaced) {
    console.log(`Replaced Chrome debug instance on port ${port} because required flags were missing: ${chromeGuard.missing_flags.join(", ")}`);
  } else if (chromeGuard.launched) {
    console.log(`Chrome launched with remote debugging port ${port}`);
  } else {
    console.log(`Reusing existing Chrome debug instance on port ${port} with required flags`);
  }
  console.log(`User data dir: ${chromeGuard.user_data_dir || userDataDir}`);
  if (chromeGuard.launched || chromeGuard.replaced) {
    await sleepMs(timing.settleMs + 1200);
  }
  const pageState = await ensureBossRecommendPageReadyCdp(port, {
    attempts: chromeGuard.launched || chromeGuard.replaced ? 6 : 2,
    inspectTimeoutMs: timing.inspectTimeoutMs,
    pollMs: timing.pollMs,
    settleMs: timing.settleMs
  });
  if (pageState.ok) {
    console.log("Boss recommend page is ready.");
    const frontResult = await bringBossRecommendTabToFrontCdp(port);
    if (frontResult.ok) {
      console.log(`CDP methods: ${frontResult.method_log.join(", ") || "none"}`);
    }
  } else {
    console.log(pageState.page_state?.message || "Boss recommend page is not ready.");
  }
}

function getCalibrationTimeoutMs(options = {}) {
  const parsed = Number.parseInt(String(options["timeout-ms"] || options.timeoutMs || options.timeout || ""), 10);
  if (!Number.isFinite(parsed)) return 60000;
  return Math.max(5000, parsed);
}

function buildUnsupportedCalibrateResponse(options = {}) {
  const workspaceRoot = getWorkspaceRoot(options);
  const port = parsePositivePort(options.port) || parsePositivePort(process.env.BOSS_RECOMMEND_CHROME_PORT) || 9222;
  const timeoutMs = getCalibrationTimeoutMs(options);
  const outputPath = String(options.output || "").trim()
    ? path.resolve(String(options.output))
    : null;
  return {
    status: "FAILED",
    error: {
      code: calibrateUnsupportedCode,
      message: "boss-recommend-mcp calibrate is fenced during the CDP-only rewrite because the old calibration route delegated to page-JS/Runtime-based adapter behavior and an external calibration script. A replacement must use CDP DOM/Input only and pass a live safe calibration gate before this command is re-enabled.",
      retryable: false
    },
    cdp_only: true,
    runtime_evaluate_used: false,
    method_summary: {},
    method_log: [],
    port,
    timeout_ms: timeoutMs,
    output: outputPath,
    calibration_resolution: getFeaturedCalibrationResolutionLocal(workspaceRoot),
    guidance: {
      current_workaround: "Use an existing favorite-calibration.json if present; `doctor --page-scope featured` will report whether it is usable.",
      next_development_task: "Implement CDP-only featured detail/action discovery and a user-approved live calibration gate before restoring this command."
    }
  };
}

async function calibrate(options = {}) {
  printJson(buildUnsupportedCalibrateResponse(options));
  process.exitCode = 1;
}

function inspectAgentIntegration(agentRaw) {
  const agent = normalizeAgentName(agentRaw);
  if (!supportedExternalAgents.includes(agent)) {
    throw new Error(`Unsupported --agent value for doctor: ${agentRaw}. Supported: ${supportedExternalAgents.join(", ")}`);
  }

  const mcpPathMap = getKnownExternalMcpConfigPathsByAgent();
  const skillPathMap = getKnownExternalSkillBaseDirsByAgent();
  const mcp_paths = dedupePaths([
    ...(mcpPathMap[agent] || []),
    ...parsePathListFromEnv(process.env[externalMcpTargetsEnv])
  ]);
  const skill_bases = dedupePaths([
    ...(skillPathMap[agent] || []),
    ...parsePathListFromEnv(process.env[externalSkillDirsEnv])
  ]);

  const mcp_checks = mcp_paths.map((mcpPath) => {
    const detail = inspectMcpServerEntries(mcpPath);
    return {
      path: mcpPath,
      ...detail
    };
  });

  const hasRecommendIntent = (content) => /(recommend|推荐页|boss recommend|recommend page)/i.test(content);
  const hasSearchIntent = (content) => /(search|搜索页|boss search|search page)/i.test(content);
  const hasRecommendPipelineRoute = (content) => /(boss-recommend-pipeline|start_recommend_pipeline_run)/i.test(content);
  const hasRecruitPipelineRoute = (content) => /(boss-recruit-pipeline|run_recruit_pipeline)/i.test(content);

  const skill_checks = skill_bases.map((baseDir) => {
    const targetDir = path.join(baseDir, skillName);
    const skillFile = path.join(targetDir, "SKILL.md");
    const recruitSkillFile = path.join(baseDir, "boss-recruit-pipeline", "SKILL.md");
    const recommendContent = pathExists(skillFile) ? fs.readFileSync(skillFile, "utf8") : "";
    const recruitContent = pathExists(recruitSkillFile) ? fs.readFileSync(recruitSkillFile, "utf8") : "";
    const recruitRouteGuard = hasRecommendIntent(recruitContent) && hasRecommendPipelineRoute(recruitContent);
    const recommendRouteGuard = hasSearchIntent(recommendContent) && hasRecruitPipelineRoute(recommendContent);
    return {
      base_dir: baseDir,
      target_dir: targetDir,
      exists: pathExists(skillFile),
      recruit_skill_exists: pathExists(recruitSkillFile),
      recruit_route_guard: recruitRouteGuard,
      recommend_route_guard: recommendRouteGuard
    };
  });

  const route_guard_ok = skill_checks.every(
    (item) => (
      (!item.recruit_skill_exists || item.recruit_route_guard)
      && (!item.exists || item.recommend_route_guard)
    )
  );

  return {
    agent,
    mcp_checks,
    skill_checks,
    route_guard_ok,
    ok: mcp_checks.some((item) => item.has_boss_recommend) && skill_checks.some((item) => item.exists) && route_guard_ok
  };
}

async function printDoctor(options = {}) {
  const port = parsePositivePort(options.port) || parsePositivePort(process.env.BOSS_RECOMMEND_CHROME_PORT) || 9222;
  const workspaceRoot = getWorkspaceRoot(options);
  const pageScope = normalizePageScope(options["page-scope"] || options.pageScope) || "recommend";
  const preflight = runPipelinePreflightLocal(workspaceRoot, { pageScope });
  const checks = preflight.checks.slice();
  const configResolution = getBossScreenConfigResolution(workspaceRoot);
  const calibrationResolution = getFeaturedCalibrationResolutionLocal(workspaceRoot);
  const timing = getLaunchChromeTiming(options);
  const slowLive = Boolean(options["slow-live"] || options.slowLive);
  let chromeGuard = null;
  let chromeGuardError = null;
  try {
    chromeGuard = await ensureChromeDebugPort({
      port,
      url: bossUrl,
      slowLive,
      launchIfMissing: true,
      userDataDir: getChromeUserDataDir(port)
    });
  } catch (error) {
    chromeGuardError = error;
    chromeGuard = error?.chrome_guard || null;
  }
  let pageState = await inspectBossRecommendPageStateCdp(port, {
    timeoutMs: slowLive ? timing.initialTimeoutMs : 2000,
    pollMs: slowLive ? timing.pollMs : 500
  });
  if (pageState.state === "RECOMMEND_READY") {
    pageState = await verifyRecommendPageStableCdp(port, {
      settleMs: slowLive ? timing.settleMs : 800,
      recheckTimeoutMs: slowLive ? timing.inspectTimeoutMs : 3000,
      pollMs: slowLive ? timing.pollMs : 500
    });
  }
  const resolvedConfigPath = configResolution.resolved_path || configResolution.writable_path;
  const userConfigExists = (
    (resolvedConfigPath && fs.existsSync(resolvedConfigPath))
    || fs.existsSync(configResolution.writable_path)
    || fs.existsSync(configResolution.legacy_path)
  );
  checks.push({
    key: "user_config",
    ok: userConfigExists,
    path: resolvedConfigPath,
    message: userConfigExists
      ? `检测到配置文件（resolved_path）：${resolvedConfigPath}`
      : "用户配置不存在（可通过 `boss-recommend-mcp init-config` 创建模板，或 `boss-recommend-mcp config set` 写入真实值）"
  });
  const requiredFlags = chromeGuard?.required_flags || [];
  const missingFlags = chromeGuard?.missing_flags || [];
  const chromeFlagsOk = Boolean(chromeGuard && !chromeGuardError && chromeGuard.required_flags_ok);
  checks.push({
    key: "chrome_required_flags",
    ok: chromeFlagsOk,
    path: `http://localhost:${port}`,
    required_flags: requiredFlags,
    missing_flags: missingFlags,
    replaced: Boolean(chromeGuard?.replaced),
    close_method: chromeGuard?.close_method || null,
    relaunch: chromeGuard?.relaunch || null,
    message: chromeFlagsOk
      ? chromeGuard?.replaced
        ? `Chrome 调试端口 ${port} 原实例缺少必需 flags，已自动关闭并用正确 flags 重新启动。`
        : chromeGuard?.launched
          ? `Chrome 调试端口 ${port} 已用必需 flags 启动。`
          : `Chrome 调试端口 ${port} 已确认包含必需 flags。`
      : chromeGuardError
        ? `Chrome 必需 flags 检查失败：${chromeGuardError.message}`
        : `Chrome 调试端口 ${port} 未确认包含必需 flags。`
  });
  checks.push({
    key: "chrome_debug_port",
    ok: pageState.state !== "DEBUG_PORT_UNREACHABLE",
    path: `http://localhost:${port}`,
    message: pageState.state === "DEBUG_PORT_UNREACHABLE"
      ? `无法连接 Chrome 调试端口 ${port}`
      : `Chrome 调试端口 ${port} 可连接`
  });
  checks.push({
    key: "featured_calibration_script",
    ok: Boolean(calibrationResolution.calibration_script_path),
    optional: true,
    path: calibrationResolution.calibration_script_path,
    message: calibrationResolution.calibration_script_path
      ? "已检测到 boss-recruit-mcp 校准脚本。"
      : "未检测到 boss-recruit-mcp 校准脚本；CDP-only package 已禁用旧精选页自动校准。"
  });
  checks.push({
    key: "featured_calibration_file",
    ok: calibrationResolution.calibration_usable,
    path: calibrationResolution.calibration_path,
    optional: pageScope !== "featured",
    message: calibrationResolution.calibration_usable
      ? "favorite-calibration.json 可用。"
      : "favorite-calibration.json 不存在或无效。"
  });
  checks.push(pageState);

  let agentIntegration = null;
  if (typeof options.agent === "string" && options.agent.trim()) {
    agentIntegration = inspectAgentIntegration(options.agent.trim());
    const agentMcpOk = agentIntegration.mcp_checks.some((item) => item.has_boss_recommend);
    const agentRecruitOnly = (
      !agentMcpOk
      && agentIntegration.mcp_checks.some((item) => item.has_boss_recruit)
    );
    const agentSkillOk = agentIntegration.skill_checks.some((item) => item.exists);
    const agentRecruitRouteGuardOk = agentIntegration.skill_checks.every(
      (item) => !item.recruit_skill_exists || item.recruit_route_guard
    );
    const agentRecommendRouteGuardOk = agentIntegration.skill_checks.every(
      (item) => !item.exists || item.recommend_route_guard
    );
    const agentRouteGuardOk = agentIntegration.route_guard_ok;
    checks.push({
      key: `agent_${agentIntegration.agent}_mcp`,
      ok: agentMcpOk,
      path: agentIntegration.mcp_checks.map((item) => item.path).join(" | "),
      message: agentMcpOk
        ? "目标 Agent MCP 配置已检测到 boss-recommend。"
        : agentRecruitOnly
          ? "目标 Agent MCP 配置未检测到 boss-recommend，但检测到 boss-recruit（可能导致错误调用 recruit pipeline）。"
          : "目标 Agent MCP 配置未检测到 boss-recommend。"
    });
    checks.push({
      key: `agent_${agentIntegration.agent}_skill`,
      ok: agentSkillOk,
      path: agentIntegration.skill_checks.map((item) => item.target_dir).join(" | "),
      message: agentSkillOk
        ? "目标 Agent skills 目录已检测到 boss-recommend-pipeline。"
        : "目标 Agent skills 目录未检测到 boss-recommend-pipeline。"
    });
    checks.push({
      key: `agent_${agentIntegration.agent}_recruit_route_guard`,
      ok: agentRecruitRouteGuardOk,
      path: agentIntegration.skill_checks.map((item) => item.base_dir).join(" | "),
      message: agentRecruitRouteGuardOk
        ? "recruit skill 路由保护检查通过（recommend 请求不会误触发 recruit pipeline）。"
        : "检测到 boss-recruit-pipeline 但未发现 recommend 路由保护，可能误触发 recruit pipeline。"
    });
    checks.push({
      key: `agent_${agentIntegration.agent}_recommend_route_guard`,
      ok: agentRecommendRouteGuardOk,
      path: agentIntegration.skill_checks.map((item) => item.base_dir).join(" | "),
      message: agentRecommendRouteGuardOk
        ? "recommend skill 路由保护检查通过（search 请求会转交 recruit pipeline）。"
        : "检测到 boss-recommend-pipeline 但未发现 search 路由保护，可能误触发 recommend pipeline。"
    });
    checks.push({
      key: `agent_${agentIntegration.agent}_route_guard`,
      ok: agentRouteGuardOk,
      path: agentIntegration.skill_checks.map((item) => item.base_dir).join(" | "),
      message: agentRouteGuardOk
        ? "双向路由保护检查通过（recommend 与 search 语义已正确分流）。"
        : "双向路由保护未完全通过，可能出现 recommend/recruit 串路由。"
    });
  }

  printJson({
    ok: checks.every((item) => item.ok || item.optional),
    port,
    checks,
    config_resolution: configResolution,
    preflight: {
      debug_port: preflight.debug_port,
      config_resolution: preflight.config_resolution,
      calibration_path: preflight.calibration_path,
      page_scope: preflight.page_scope
    },
    calibration_resolution: calibrationResolution,
    agent_integration: agentIntegration
  });
}

function printPaths() {
  const codexHome = getCodexHome();
  const stateHome = getStateHome();
  const calibrationResolution = getFeaturedCalibrationResolutionLocal(process.cwd());
  const bossChatRuntime = resolveCdpBossChatRuntimeLayout(getWorkspaceRoot({}));
  console.log(`package_root=${packageRoot}`);
  console.log(`skill_sources=${bundledSkillNames.map((name) => getSkillSourceDir(name)).join(" | ")}`);
  console.log(`codex_home=${codexHome}`);
  console.log(`state_home=${stateHome}`);
  console.log(`boss_chat_runtime=${bossChatRuntime.data_dir}`);
  console.log(`boss_chat_legacy_workspace_runtime=${bossChatRuntime.legacy_workspace_dir || ""}`);
  console.log(`skill_targets=${bundledSkillNames.map((name) => path.join(codexHome, "skills", name)).join(" | ")}`);
  console.log(`config_target=${getUserConfigPath()}`);
  console.log(`legacy_config_target=${getLegacyUserConfigPath()}`);
  console.log(`calibration_target=${calibrationResolution.calibration_path}`);
  console.log(`calibration_script=${calibrationResolution.calibration_script_path || ""}`);
  console.log(`desktop_output_default=${getDesktopDir()}`);
}

function printHelp() {
  console.log("boss-recommend-mcp");
  console.log("");
  console.log("Usage:");
  console.log("  boss-recommend-mcp              Start the MCP server");
  console.log("  boss-recommend-mcp start        Start the MCP server");
  console.log("  boss-recommend-mcp run          Start a CDP-only recommend run through the shared run service");
  console.log("  boss-recommend-mcp list-jobs    CDP-only list of exact recommend job names for cron/one-shot inputs");
  console.log("  boss-recommend-mcp chat <subcommand>  Run CDP-only boss-chat health/prepare/status commands");
  console.log("  boss-recommend-mcp install      Install/migrate skills and MCP configs; replaces legacy Boss MCP routes (supports --agent trae-cn/openclaw/qclaw/...)");
  console.log("  boss-recommend-mcp install-skill Install bundled Codex skills (recommend/recruit/chat)");
  console.log("  boss-recommend-mcp init-config  Create screening-config.json if missing (prefer workspace config/, fallback ~/.boss-recommend-mcp)");
  console.log("  boss-recommend-mcp config set   Write baseUrl/apiKey/model (prefer workspace config/, fallback ~/.boss-recommend-mcp)");
  console.log("  boss-recommend-mcp set-port     Persist preferred Chrome debug port to screening-config.json");
  console.log("  boss-recommend-mcp mcp-config   Generate MCP config JSON for Cursor/Trae(含 trae-cn)/Claude Code/OpenClaw/QClaw");
  console.log("  boss-recommend-mcp doctor       Check config/runtime/calibration prerequisites (supports --agent trae-cn/qclaw/cursor/...)");
  console.log("  boss-recommend-mcp calibrate    Disabled until CDP-only featured calibration is live-verified");
  console.log("  boss-recommend-mcp launch-chrome Launch or reuse Chrome debug instance and open Boss recommend page");
  console.log("  boss-recommend-mcp where        Print installed package, skill, and config paths");
  console.log("");
  console.log("Run command:");
  console.log("  boss-recommend-mcp run --instruction \"推荐页上筛选211男生，近14天没有，有大模型平台经验\" --overrides-file overrides.json --confirmation-file confirmation.json");
  console.log("  boss-recommend-mcp run --detached --instruction \"...\" --overrides-file overrides.json --confirmation-file confirmation.json");
  console.log("  boss-recommend-mcp list-jobs --slow-live --port 9222");
  console.log("  boss-recommend-mcp chat prepare-run --slow-live --port 9222    # CDP-only preflight; start runs through MCP start_boss_chat_run");
  console.log("  boss-recommend-mcp config set --base-url <url> --api-key <key> --model <model> [--thinking-level off|low|medium|high|current] [--greeting-message <text>] [--openai-organization <id>] [--openai-project <id>]");
  console.log("  boss-recommend-mcp install --agent trae-cn");
  console.log("  boss-recommend-mcp install --agent qclaw    # updates ~/.qclaw/openclaw.json mcp.servers and mirrors skills");
  console.log("  boss-recommend-mcp doctor --agent trae-cn --page-scope featured");
  console.log("  boss-recommend-mcp calibrate --port 9222    # returns CALIBRATE_UNSUPPORTED_CDP_ONLY during rewrite");
}

function printMcpConfig(options = {}) {
  const clients = parseMcpClientTargets(options.client);
  if (clients.length === 1 && !options["output-dir"]) {
    printJson(buildMcpConfigFileContent(options));
    return;
  }
  const result = writeMcpConfigFiles(options);
  console.log(`MCP config templates exported to: ${result.outputDir}`);
  for (const item of result.files) {
    console.log(`- ${item.client}: ${item.file}`);
  }
}

async function installAll(options = {}) {
  const runtimeDirsResult = await ensureRuntimeDirectories(options);
  const skillResults = installSkill();
  const configResult = await ensureUserConfig(options);
  const mcpTemplateResult = writeMcpConfigFiles({ client: "all" });
  const externalMcpResult = installExternalMcpConfigs(options);
  const externalSkillResult = mirrorSkillToExternalDirs(options);
  console.log(
    `Runtime directories prepared: created=${runtimeDirsResult.created.length}, existing=${runtimeDirsResult.existed.length}, failed=${runtimeDirsResult.failed.length}`
  );
  console.log(`- recommend runtime: ${runtimeDirsResult.stateHome}`);
  console.log(`- boss-chat runtime: ${runtimeDirsResult.bossChatRoot}`);
  if (runtimeDirsResult.migration?.performed) {
    console.log(`- boss-chat migration: ${runtimeDirsResult.migration.message}`);
  }
  if (runtimeDirsResult.failed.length > 0) {
    for (const item of runtimeDirsResult.failed) {
      console.warn(`Runtime dir warning: ${item.path} -> ${item.message}`);
    }
  }
  console.log(`Bundled skills installed: ${skillResults.length}`);
  for (const item of skillResults) {
    console.log(`- ${item.skill}: ${item.targetDir}`);
  }
  console.log(
    configResult.created
      ? `screening-config.json created: ${configResult.path}`
      : `screening-config.json already exists: ${configResult.path}`
  );
  if (Array.isArray(configResult.patched_keys) && configResult.patched_keys.length > 0) {
    console.log(`screening-config.json patched missing defaults: ${configResult.patched_keys.join(", ")}`);
  } else if (configResult.patch_error) {
    console.warn(`screening-config.json skip default patch: ${configResult.patch_error}`);
  }
  console.log(`请在该目录修改 baseUrl/apiKey/model 并替换占位词后再运行：${path.dirname(configResult.path)}`);
  console.log(`MCP config templates exported to: ${mcpTemplateResult.outputDir}`);
  for (const item of mcpTemplateResult.files) {
    console.log(`- ${item.client}: ${item.file}`);
  }
  if (externalMcpResult.targets.length > 0) {
    console.log(`Auto-configured external MCP files: ${externalMcpResult.applied.length}`);
    for (const item of externalMcpResult.applied) {
      const action = item.created ? "created" : item.updated ? "updated" : "unchanged";
      const migrated = Array.isArray(item.migrated_legacy_servers) && item.migrated_legacy_servers.length > 0
        ? `; migrated legacy servers: ${item.migrated_legacy_servers.join(", ")}`
        : "";
      const backup = item.backup_file ? `; backup: ${item.backup_file}` : "";
      console.log(`- ${item.file} (${action}${migrated}${backup})`);
    }
    for (const item of externalMcpResult.skipped) {
      console.warn(`External MCP warning: ${item.file} -> ${item.reason}`);
    }
  } else {
    console.log("No external MCP config target detected. Set BOSS_RECOMMEND_MCP_CONFIG_TARGETS to auto-configure custom agents.");
  }
  if (externalSkillResult.baseDirs.length > 0) {
    console.log(`Mirrored skill to external dirs: ${externalSkillResult.mirrored.length}`);
    for (const item of externalSkillResult.mirrored) {
      console.log(`- ${item.target_dir}${item.replaced_legacy ? " (replaced legacy skill)" : ""}`);
    }
    for (const item of externalSkillResult.skipped) {
      console.warn(`External skill warning: ${item.base_dir} / ${item.skill} -> ${item.reason}`);
    }
  } else {
    console.log("No external skill dir detected. Set BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS to mirror skill for non-Codex agents.");
  }
  if (typeof options.agent === "string" && options.agent.trim()) {
    console.log(`Target agent filter: ${options.agent.trim()}`);
  }
}

async function runPipelineOnce(options = {}) {
  const instruction = getRunInstruction(options);
  const confirmation = getRunConfirmation(options);
  const overrides = getRunOverrides(options);
  const followUp = getRunFollowUp(options);
  const workspaceRoot = getWorkspaceRoot(options);
  const port = parsePositivePort(options.port) || parsePositivePort(process.env.BOSS_RECOMMEND_CHROME_PORT) || 9222;

  const args = {
    instruction,
    confirmation: confirmation ?? undefined,
    overrides: overrides ?? undefined,
    follow_up: followUp ?? undefined,
    host: typeof options.host === "string" && options.host.trim() ? options.host.trim() : undefined,
    port,
    target_url_includes: typeof options["target-url-includes"] === "string" && options["target-url-includes"].trim()
      ? options["target-url-includes"].trim()
      : undefined,
    allow_navigate: !(options["no-navigate"] === true || options.noNavigate === true || options.allow_navigate === false),
    slow_live: options["slow-live"] === true || options.slowLive === true || options.slow_live === true
  };
  const restLevel = parseRestLevelOption(
    options["rest-level"]
    ?? options.rest_level
    ?? options["human-behavior-rest-level"]
    ?? options.human_behavior_rest_level
  );
  if (restLevel) {
    args.human_behavior = {
      restLevel
    };
  }

  const optionalPassthrough = [
    "detail_limit",
    "allow_card_only_screening",
    "debug_test_mode",
    "screening_mode",
    "use_llm",
    "delay_ms",
    "max_image_pages",
    "image_wheel_delta_y",
    "cv_acquisition_mode",
    "list_max_scrolls",
    "list_stable_signature_limit",
    "list_wheel_delta_y",
    "list_settle_ms",
    "refresh_on_end",
    "max_refresh_rounds",
    "refresh_button_settle_ms",
    "refresh_reload_settle_ms",
    "dry_run_post_action",
    "execute_post_action",
    "action_timeout_ms",
    "action_interval_ms",
    "action_after_click_delay_ms",
    "human_behavior_enabled",
    "human_behavior_profile",
    "safe_pacing",
    "batch_rest_enabled",
    "llm_timeout_ms",
    "llm_image_limit",
    "llm_image_detail"
  ];
  for (const key of optionalPassthrough) {
    const kebab = key.replace(/_/g, "-");
    if (options[key] !== undefined) args[key] = options[key];
    else if (options[kebab] !== undefined) args[key] = options[kebab];
  }

  const result = await startRecommendPipelineRunTool({
    workspaceRoot,
    args
  });
  printJson({
    ...result,
    cli: {
      command: "run",
      cdp_only: true,
      shared_run_service: true,
      workspace_root: workspaceRoot,
      port
    }
  });
  if (result.status !== "ACCEPTED") {
    process.exitCode = 1;
  }
}

function buildRecommendJobListCliInput(options = {}) {
  const targetUrlIncludes = String(options["target-url-includes"] || options.target_url_includes || "").trim();
  const host = String(options.host || "").trim();
  return {
    host: host || undefined,
    port: parsePositivePort(options.port),
    target_url_includes: targetUrlIncludes || undefined,
    allow_navigate: !(options["no-navigate"] === true || options.noNavigate === true || options.allow_navigate === false),
    slow_live: options["slow-live"] === true || options.slowLive === true || options.slow_live === true
  };
}

async function listRecommendJobsCli(options = {}) {
  printJson(await listRecommendJobsTool({
    workspaceRoot: getWorkspaceRoot(options),
    args: buildRecommendJobListCliInput(options)
  }));
}

function buildBossChatCliInput(options = {}) {
  const greetingTextRaw =
    options["greeting-text"]
    ?? options.greeting_text
    ?? options.greetingText
    ?? options.greeting;
  const greetingText = typeof greetingTextRaw === "string" ? greetingTextRaw.trim() : undefined;
  const targetUrlIncludes = String(options["target-url-includes"] || options.target_url_includes || "").trim();
  const host = String(options.host || "").trim();
  const restLevel = parseRestLevelOption(
    options["rest-level"]
    ?? options.rest_level
    ?? options["human-behavior-rest-level"]
    ?? options.human_behavior_rest_level
  );
  return {
    profile: typeof options.profile === "string" ? options.profile.trim() : undefined,
    job: typeof options.job === "string" ? options.job.trim() : undefined,
    start_from: String(options["start-from"] || options.start_from || "").trim().toLowerCase() || undefined,
    criteria: typeof options.criteria === "string" ? options.criteria.trim() : undefined,
    greeting_text: greetingText || undefined,
    target_count: parseBossChatTargetCountOption(options.targetCount || options["target-count"] || options.target_count),
    host: host || undefined,
    port: parsePositivePort(options.port),
    target_url_includes: targetUrlIncludes || undefined,
    allow_navigate: !(options["no-navigate"] === true || options.noNavigate === true || options.allow_navigate === false),
    slow_live: options["slow-live"] === true || options.slowLive === true || options.slow_live === true,
    detail_limit: parseNonNegativeInteger(options["detail-limit"] ?? options.detail_limit),
    delay_ms: parseNonNegativeInteger(options["delay-ms"] ?? options.delay_ms),
    max_candidates: parseNonNegativeInteger(options["max-candidates"] ?? options.max_candidates),
    dry_run: options["dry-run"] === true || options.dryRun === true,
    no_state: options["no-state"] === true || options.noState === true,
    human_behavior_enabled: parseBooleanOption(options["human-behavior-enabled"] ?? options.human_behavior_enabled),
    human_behavior_profile: typeof (options["human-behavior-profile"] ?? options.human_behavior_profile) === "string"
      ? (options["human-behavior-profile"] ?? options.human_behavior_profile).trim()
      : undefined,
    human_behavior: restLevel
      ? {
          restLevel
        }
      : undefined,
    safe_pacing: parseBooleanOption(options["safe-pacing"] ?? options.safe_pacing),
    batch_rest_enabled: parseBooleanOption(options["batch-rest"] ?? options.batch_rest_enabled)
  };
}

function getBossChatCliRunTarget(options = {}) {
  return {
    profile: typeof options.profile === "string" ? options.profile.trim() : undefined,
    run_id: String(options["run-id"] || options.runId || options.run_id || "").trim()
  };
}

function buildUnsupportedBossChatCliStartResponse(subcommand) {
  return {
    status: "FAILED",
    error: {
      code: bossChatCliUnsupportedStartCode,
      message: `boss-recommend-mcp chat ${subcommand} is fenced during the CDP-only rewrite because a one-shot CLI process cannot keep the live CDP session and run lifecycle alive after it exits. Use the MCP tool start_boss_chat_run, or the live chat harness, for CDP-only chat runs.`,
      retryable: false
    },
    cdp_only: true,
    runtime_evaluate_used: false,
    method_summary: {},
    method_log: []
  };
}

async function runBossChatCliCommand(subcommand, options = {}) {
  const workspaceRoot = getWorkspaceRoot(options);
  const input = buildBossChatCliInput(options);
  if (subcommand === "health-check") {
    printJson(await bossChatHealthCheckTool({
      workspaceRoot,
      args: input
    }));
    return;
  }

  if (subcommand === "prepare-run") {
    printJson(await prepareBossChatRunTool({
      workspaceRoot,
      args: input
    }));
    return;
  }

  if (subcommand === "run" || subcommand === "start-run") {
    printJson(buildUnsupportedBossChatCliStartResponse(subcommand));
    return;
  }

  if (subcommand === "get-run") {
    printJson(getBossChatRunTool({
      args: getBossChatCliRunTarget(options)
    }));
    return;
  }

  if (subcommand === "pause-run") {
    printJson(pauseBossChatRunTool({
      args: getBossChatCliRunTarget(options)
    }));
    return;
  }

  if (subcommand === "resume-run") {
    printJson(resumeBossChatRunTool({
      args: getBossChatCliRunTarget(options)
    }));
    return;
  }

  if (subcommand === "cancel-run") {
    printJson(cancelBossChatRunTool({
      args: getBossChatCliRunTarget(options)
    }));
    return;
  }

  throw new Error(`Unknown chat subcommand: ${subcommand || ""}`);
}

export async function runCli(argv = process.argv) {
  const command = argv[2] || "start";
  const options = parseOptions(argv.slice(3));
  ensureAssetsUpToDate(command);

  switch (command) {
    case "start":
    case "mcp":
      startServer();
      break;
    case "run":
      try {
        if (
          (options.detached === true || options.background === true)
          && process.env[detachedRecommendRunChildEnv] !== "1"
        ) {
          await runPipelineDetached(argv.slice(3), options);
        } else {
          await runPipelineOnce(options);
        }
      } catch (error) {
        printJson({
          status: "FAILED",
          error: {
            code: "INVALID_CLI_INPUT",
            message: error.message || "Invalid CLI input",
            retryable: false
          }
        });
        process.exitCode = 1;
      }
      break;
    case "list-jobs":
    case "jobs":
    case "recommend-jobs":
      try {
        await listRecommendJobsCli(options);
      } catch (error) {
        printJson({
          status: "FAILED",
          error: {
            code: "RECOMMEND_JOB_LIST_CLI_FAILED",
            message: error.message || "Failed to list recommend jobs",
            retryable: true
          }
        });
        process.exitCode = 1;
      }
      break;
    case "chat":
      try {
        const chatSubcommand = String(argv[3] || "").trim().toLowerCase();
        const chatOptions = parseOptions(argv.slice(4));
        await runBossChatCliCommand(chatSubcommand, chatOptions);
      } catch (error) {
        printJson({
          status: "FAILED",
          error: {
            code: "INVALID_CHAT_CLI_INPUT",
            message: error.message || "Invalid chat CLI input",
            retryable: false
          }
        });
        process.exitCode = 1;
      }
      break;
    case "install":
      try {
        await installAll(options);
      } catch (error) {
        console.error(error.message || "Install failed.");
        process.exitCode = 1;
      }
      break;
    case "install-skill":
      for (const item of installSkill()) {
        console.log(`Skill installed: ${item.skill} -> ${item.targetDir}`);
      }
      break;
    case "init-config": {
      const runtimeDirsResult = await ensureRuntimeDirectories(options);
      const result = await ensureUserConfig(options);
      console.log(
        `Runtime directories prepared: created=${runtimeDirsResult.created.length}, existing=${runtimeDirsResult.existed.length}, failed=${runtimeDirsResult.failed.length}`
      );
      console.log(`- recommend runtime: ${runtimeDirsResult.stateHome}`);
      console.log(`- boss-chat runtime: ${runtimeDirsResult.bossChatRoot}`);
      if (runtimeDirsResult.migration?.performed) {
        console.log(`- boss-chat migration: ${runtimeDirsResult.migration.message}`);
      }
      if (runtimeDirsResult.failed.length > 0) {
        for (const item of runtimeDirsResult.failed) {
          console.warn(`Runtime dir warning: ${item.path} -> ${item.message}`);
        }
      }
      console.log(result.created ? `Config template created at: ${result.path}` : `Config already exists at: ${result.path}`);
      if (Array.isArray(result.patched_keys) && result.patched_keys.length > 0) {
        console.log(`Config patched missing defaults: ${result.patched_keys.join(", ")}`);
      } else if (result.patch_error) {
        console.warn(`Config skip default patch: ${result.patch_error}`);
      }
      break;
    }
    case "set-port": {
      try {
        const result = await setDebugPort(options);
        console.log(`Preferred debug port saved: ${result.port}`);
        console.log(`Updated config: ${result.configPath}`);
        console.log("Port priority for runtime commands: --port > BOSS_RECOMMEND_CHROME_PORT > screening-config.json.debugPort > 9222");
      } catch (error) {
        console.error(error.message || "Failed to persist debug port.");
        process.exitCode = 1;
      }
      break;
    }
    case "set-config": {
        try {
          const result = await setScreeningConfig(options);
        console.log(`screening-config.json updated: ${result.path}`);
      } catch (error) {
        console.error(error.message || "Failed to write screening-config.json.");
        process.exitCode = 1;
      }
      break;
    }
    case "config": {
      const sub = String(argv[3] || "").trim().toLowerCase();
      if (!sub || sub.startsWith("--") || sub === "set") {
        const configOptions = sub === "set" ? parseOptions(argv.slice(4)) : options;
        try {
          const result = await setScreeningConfig(configOptions);
          console.log(`screening-config.json updated: ${result.path}`);
        } catch (error) {
          console.error(error.message || "Failed to write screening-config.json.");
          process.exitCode = 1;
        }
        break;
      }
      console.error(`Unknown config subcommand: ${sub}`);
      process.exitCode = 1;
      break;
    }
    case "mcp-config":
      try {
        printMcpConfig(options);
      } catch (error) {
        console.error(error.message || "Failed to generate MCP config template.");
        process.exitCode = 1;
      }
      break;
    case "doctor":
      await printDoctor(options);
      break;
    case "calibrate":
      await calibrate(options);
      break;
    case "launch-chrome":
      await launchChrome(options);
      break;
    case "where":
      await printPaths();
      break;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run `boss-recommend-mcp --help` for usage.");
      process.exitCode = 1;
  }
}

export const __testables = {
  buildRecommendJobListCliInput,
  buildBossChatCliInput,
  buildDefaultMcpArgs,
  buildMcpLaunchConfig,
  collectRuntimeDirectories,
  ensureBossChatRuntimeReady: ensureBossChatRuntimeReadyLocal,
  ensureRuntimeDirectories,
  getBossChatCliRunTarget,
  getDefaultMcpPackageSpecifier,
  getRunFollowUp,
  inspectMcpServerEntries,
  installSkill,
  isInstalledPackageRoot,
  mergeMcpServerConfigFile,
  resolveBossChatRuntimeLayout: resolveCdpBossChatRuntimeLayout,
  runBossChatCliCommand,
  runPipelineOnce
};

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  await runCli(process.argv);
}
