import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const packagedMcpDir = path.resolve(path.dirname(currentFilePath), "..");
const bossRecommendUrl = "https://www.zhipin.com/web/chat/recommend";
const chromeOnboardingUrlPattern = /^chrome:\/\/(welcome|intro|newtab|signin|history-sync|settings\/syncSetup)/i;

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function getUserConfigPath() {
  return path.join(getCodexHome(), "boss-recommend-mcp", "screening-config.json");
}

function getDesktopDir() {
  return path.join(os.homedir(), "Desktop");
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

function serializeDegreeSelection(value) {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item || "").trim()).filter(Boolean);
    return normalized.length ? normalized.join(",") : "不限";
  }
  const normalized = String(value || "").trim();
  return normalized || "不限";
}

function resolveScreenConfigPath(workspaceRoot) {
  const envConfigPath = process.env.BOSS_RECOMMEND_SCREEN_CONFIG
    ? path.resolve(process.env.BOSS_RECOMMEND_SCREEN_CONFIG)
    : null;
  const workspaceConfigPath = path.join(workspaceRoot, "boss-recommend-mcp", "config", "screening-config.json");
  const userConfigPath = getUserConfigPath();
  const packagedConfigPath = path.join(packagedMcpDir, "config", "screening-config.json");
  const candidates = [
    envConfigPath,
    workspaceConfigPath,
    userConfigPath,
    packagedConfigPath
  ].filter(Boolean);
  return candidates.find((candidate) => pathExists(candidate)) || candidates[0];
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

function resolveWorkspaceDebugPort(workspaceRoot) {
  const fromEnv = parsePositiveInteger(process.env.BOSS_RECOMMEND_CHROME_PORT);
  if (fromEnv) return fromEnv;
  const config = readJsonFile(resolveScreenConfigPath(workspaceRoot));
  return parsePositiveInteger(config?.debugPort) || 9222;
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

function runProcess({ command, args, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    function finish(payload) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
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

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));
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

function detectPythonCommand() {
  const python = runProcessSync({
    command: "python",
    args: ["--version"]
  });
  if (python.ok) {
    return {
      ok: true,
      command: "python",
      probe: python
    };
  }
  const python3 = runProcessSync({
    command: "python3",
    args: ["--version"]
  });
  if (python3.ok) {
    return {
      ok: false,
      command: null,
      probe: python,
      fallback: python3
    };
  }
  return {
    ok: false,
    command: null,
    probe: python,
    fallback: null
  };
}

function buildPythonCommandCheck() {
  const detected = detectPythonCommand();
  if (detected.ok) {
    return {
      key: "python_cli",
      ok: true,
      path: "python --version",
      message: `Python 命令可用 (${detected.probe.output || "unknown version"})`
    };
  }
  if (detected.fallback) {
    return {
      key: "python_cli",
      ok: false,
      path: "python --version",
      message: `检测到 ${detected.fallback.output || "python3"}，但当前流程依赖 python 命令；请创建 python 别名后重试。`
    };
  }
  return {
    key: "python_cli",
    ok: false,
    path: "python --version",
    message: "未找到 python 命令，请安装 Python 并确保 python 在 PATH 中。"
  };
}

function buildPillowCheck() {
  const detected = detectPythonCommand();
  if (!detected.ok || !detected.command) {
    return {
      key: "python_pillow",
      ok: false,
      path: "python -c \"import PIL\"",
      message: "无法校验 Pillow：python 命令不可用。"
    };
  }
  const probe = runProcessSync({
    command: detected.command,
    args: ["-c", "import PIL, PIL.Image; print(PIL.__version__)"]
  });
  return {
    key: "python_pillow",
    ok: probe.ok,
    path: `${detected.command} -c "import PIL"`,
    message: probe.ok
      ? `Pillow 可用 (${probe.output || "version unknown"})`
      : "Pillow 未安装。请执行 `python -m pip install pillow`。"
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
    buildPythonCommandCheck(),
    buildPillowCheck(),
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

function loadScreenConfig(configPath) {
  const parsed = readJsonFile(configPath);
  if (!parsed) {
    return {
      ok: false,
      error: `Screen config file not found or invalid: ${configPath}`
    };
  }
  if (!parsed.baseUrl || !parsed.apiKey || !parsed.model) {
    return {
      ok: false,
      error: "Invalid screen config: baseUrl/apiKey/model are required"
    };
  }
  return { ok: true, config: parsed };
}

function localDirHint(workspaceRoot, dirName) {
  return path.join(workspaceRoot, dirName);
}

export function runPipelinePreflight(workspaceRoot) {
  const searchDir = resolveRecommendSearchCliDir(workspaceRoot);
  const screenDir = resolveRecommendScreenCliDir(workspaceRoot);
  const screenConfigPath = resolveScreenConfigPath(workspaceRoot);
  const checks = [
    {
      key: "recommend_search_cli_dir",
      ok: Boolean(searchDir && pathExists(searchDir)),
      path: searchDir || localDirHint(workspaceRoot, "boss-recommend-search-cli"),
      message: "boss-recommend-search-cli 目录不存在"
    },
    {
      key: "recommend_search_cli_entry",
      ok: Boolean(searchDir && pathExists(resolveRecommendSearchCliEntry(searchDir))),
      path: searchDir ? resolveRecommendSearchCliEntry(searchDir) : path.join(localDirHint(workspaceRoot, "boss-recommend-search-cli"), "src", "cli.js"),
      message: "boss-recommend-search-cli 入口文件缺失"
    },
    {
      key: "recommend_screen_cli_dir",
      ok: Boolean(screenDir && pathExists(screenDir)),
      path: screenDir || localDirHint(workspaceRoot, "boss-recommend-screen-cli"),
      message: "boss-recommend-screen-cli 目录不存在"
    },
    {
      key: "recommend_screen_cli_entry",
      ok: Boolean(screenDir && pathExists(resolveRecommendScreenCliEntry(screenDir))),
      path: screenDir ? resolveRecommendScreenCliEntry(screenDir) : path.join(localDirHint(workspaceRoot, "boss-recommend-screen-cli"), "boss-recommend-screen-cli.cjs"),
      message: "boss-recommend-screen-cli 入口文件缺失"
    },
    {
      key: "screen_config",
      ok: pathExists(screenConfigPath),
      path: screenConfigPath,
      message: "screening-config.json 不存在"
    }
  ];
  checks.push(...buildRuntimeDependencyChecks({ searchDir, screenDir }));

  return {
    ok: checks.every((item) => item.ok),
    checks,
    debug_port: resolveWorkspaceDebugPort(workspaceRoot)
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
      const exactTab = tabs.find(
        (tab) => typeof tab?.url === "string" && tab.url.includes("/web/chat/recommend")
      );
      if (exactTab) {
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

      const bossTab = tabs.find(
        (tab) => typeof tab?.url === "string" && tab.url.includes("zhipin.com")
      );
      if (bossTab) {
        return buildBossPageState({
          ok: false,
          state: "LOGIN_REQUIRED",
          path: bossTab.url,
          current_url: bossTab.url,
          title: bossTab.title || null,
          requires_login: true,
          expected_url: expectedUrl,
          message: "Boss 页面没有停留在 recommend 页面，通常表示需要重新登录。"
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
      expected_url,
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
      expected_url,
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
    return recheck;
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
  if (pageState.state === "LOGIN_REQUIRED") {
    return {
      ok: false,
      debug_port: debugPort,
      state: pageState.state,
      page_state: pageState
    };
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (pageState.state === "DEBUG_PORT_UNREACHABLE") {
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
        page_state: stableState
      };
    }
    if (pageState.state === "LOGIN_REQUIRED") {
      return {
        ok: false,
        debug_port: debugPort,
        state: pageState.state,
        page_state: pageState
      };
    }
  }

  return {
    ok: false,
    debug_port: debugPort,
    state: pageState.state || "UNKNOWN",
    page_state: pageState
  };
}

export async function runRecommendSearchCli({ workspaceRoot, searchParams }) {
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
    searchParams.school_tag,
    "--degree",
    serializeDegreeSelection(searchParams.degree),
    "--gender",
    searchParams.gender,
    "--recent-not-view",
    searchParams.recent_not_view,
    "--port",
    String(resolveWorkspaceDebugPort(workspaceRoot))
  ];
  const result = await runProcess({
    command: "node",
    args,
    cwd: searchDir,
    timeoutMs: 180000
  });
  const structured = parseJsonOutput(result.stdout);
  return {
    ok: result.code === 0 && structured?.status === "COMPLETED",
    stdout: result.stdout,
    stderr: result.stderr,
    structured,
    summary: structured?.result || null,
    error: structured?.error || (
      result.code === 0
        ? null
        : {
            code: "RECOMMEND_SEARCH_FAILED",
            message: "推荐页筛选命令执行失败。"
          }
    )
  };
}

export async function runRecommendScreenCli({ workspaceRoot, screenParams }) {
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

  const outputName = `recommend_screen_result_${Date.now()}.csv`;
  let outputPath = outputName;
  if (loaded.config.outputDir) {
    const resolvedOutputDir = path.resolve(path.dirname(configPath), loaded.config.outputDir);
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
    outputPath = path.join(resolvedOutputDir, outputName);
  } else {
    const desktopDir = getDesktopDir();
    fs.mkdirSync(desktopDir, { recursive: true });
    outputPath = path.join(desktopDir, outputName);
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

  if (loaded.config.openaiOrganization) {
    args.push("--openai-organization", loaded.config.openaiOrganization);
  }
  if (loaded.config.openaiProject) {
    args.push("--openai-project", loaded.config.openaiProject);
  }
  if (Number.isInteger(screenParams.target_count) && screenParams.target_count > 0) {
    args.push("--targetCount", String(screenParams.target_count));
  }
  if (screenParams.post_action === "greet"
    && Number.isInteger(screenParams.max_greet_count)
    && screenParams.max_greet_count > 0) {
    args.push("--max-greet-count", String(screenParams.max_greet_count));
  }

  const result = await runProcess({
    command: "node",
    args,
    cwd: screenDir,
    timeoutMs: 60 * 60 * 1000
  });
  const structured = parseJsonOutput(result.stdout);
  return {
    ok: result.code === 0 && structured?.status === "COMPLETED",
    stdout: result.stdout,
    stderr: result.stderr,
    structured,
    summary: structured?.result || null,
    error: structured?.error || (
      result.code === 0
        ? null
        : {
            code: "RECOMMEND_SCREEN_FAILED",
            message: "推荐页筛选命令执行失败。"
          }
    )
  };
}
