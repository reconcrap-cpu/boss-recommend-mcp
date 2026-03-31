import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startServer } from "./index.js";
import {
  ensureBossRecommendPageReady,
  inspectBossRecommendPageState,
  runPipelinePreflight
} from "./adapters.js";
import { runRecommendPipeline } from "./pipeline.js";

const require = createRequire(import.meta.url);
const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
const packageJsonPath = path.join(packageRoot, "package.json");
const skillName = "boss-recommend-pipeline";
const skillSourceDir = path.join(packageRoot, "skills", skillName);
const exampleConfigPath = path.join(packageRoot, "config", "screening-config.example.json");
const bossUrl = "https://www.zhipin.com/web/chat/recommend";
const chromeOnboardingUrlPattern = /^chrome:\/\/(welcome|intro|newtab|signin|history-sync|settings\/syncSetup)/i;
const supportedMcpClients = ["generic", "cursor", "trae", "claudecode", "openclaw"];
const defaultMcpServerName = "boss-recommend";
const defaultMcpCommand = "npx";
const defaultMcpArgs = ["-y", "@reconcrap/boss-recommend-mcp@latest", "start"];
const autoSyncSkipCommands = new Set(["install", "install-skill", "where", "help", "--help", "-h"]);
const externalMcpTargetsEnv = "BOSS_RECOMMEND_MCP_CONFIG_TARGETS";
const externalSkillDirsEnv = "BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS";

function getPackageVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return typeof parsed?.version === "string" ? parsed.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const packageVersion = getPackageVersion();

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
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
    const resolved = path.resolve(String(item || ""));
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function getDesktopDir() {
  return path.join(os.homedir(), "Desktop");
}

function getUserConfigPath() {
  return path.join(getCodexHome(), "boss-recommend-mcp", "screening-config.json");
}

function getSkillTargetDir() {
  return path.join(getCodexHome(), "skills", skillName);
}

function getSkillVersionMarkerPath() {
  return path.join(getSkillTargetDir(), ".installed-version");
}

function readInstalledSkillVersion() {
  const markerPath = getSkillVersionMarkerPath();
  if (!fs.existsSync(markerPath)) return null;
  try {
    return fs.readFileSync(markerPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeInstalledSkillVersion(version) {
  const markerPath = getSkillVersionMarkerPath();
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

function getWorkspaceRoot(options) {
  const raw = options["workspace-root"] || process.env.BOSS_WORKSPACE_ROOT || process.cwd();
  return path.resolve(String(raw));
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
  if (typeof options["confirmation-file"] === "string" && options["confirmation-file"].trim()) {
    return parseJsonOption(readTextFile(options["confirmation-file"], "confirmation"), "confirmation");
  }
  return parseJsonOption(options["confirmation-json"], "confirmation");
}

function getRunOverrides(options) {
  if (typeof options["overrides-file"] === "string" && options["overrides-file"].trim()) {
    return parseJsonOption(readTextFile(options["overrides-file"], "overrides"), "overrides");
  }
  return parseJsonOption(options["overrides-json"], "overrides");
}

function normalizeMcpClientName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "claude-code") return "claudecode";
  if (raw === "trae-cn") return "trae";
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

function getAgentConfigOutputDir(options = {}) {
  if (typeof options["output-dir"] === "string" && options["output-dir"].trim()) {
    return path.resolve(options["output-dir"]);
  }
  return path.join(getCodexHome(), "boss-recommend-mcp", "agent-mcp-configs");
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
      : defaultMcpArgs.slice();
  const launchConfig = { command, args: launchArgs };
  if (env && typeof env === "object" && !Array.isArray(env) && Object.keys(env).length > 0) {
    launchConfig.env = env;
  }
  return launchConfig;
}

function buildMcpConfigFileContent(options = {}) {
  const serverName = typeof options["server-name"] === "string" && options["server-name"].trim()
    ? options["server-name"].trim()
    : defaultMcpServerName;
  return {
    mcpServers: {
      [serverName]: buildMcpLaunchConfig(options)
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
    fs.writeFileSync(filePath, JSON.stringify(buildMcpConfigFileContent(options), null, 2), "utf8");
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

function getKnownExternalMcpConfigPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return dedupePaths([
    path.join(appData, "Cursor", "User", "mcp.json"),
    path.join(appData, "Trae", "User", "mcp.json"),
    path.join(appData, "Trae CN", "User", "mcp.json"),
    path.join(home, ".trae", "mcp.json"),
    path.join(home, ".trae-cn", "mcp.json"),
    path.join(home, ".claude", "mcp.json"),
    path.join(home, ".openclaw", "mcp.json")
  ]);
}

function resolveExternalMcpConfigTargets() {
  const fromEnv = parsePathListFromEnv(process.env[externalMcpTargetsEnv]);
  const known = getKnownExternalMcpConfigPaths().filter((filePath) => {
    if (pathExists(filePath)) return true;
    return pathExists(path.dirname(filePath));
  });
  return dedupePaths([...fromEnv, ...known]);
}

function mergeMcpServerConfigFile(filePath, options = {}) {
  const nextConfig = buildMcpConfigFileContent(options);
  const serverName = Object.keys(nextConfig.mcpServers || {})[0] || defaultMcpServerName;
  const launchConfig = nextConfig.mcpServers?.[serverName] || buildMcpLaunchConfig(options);
  const current = readJsonObjectFileSafe(filePath);
  const existingServers =
    current?.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
      ? current.mcpServers
      : {};
  const existingEntry = existingServers[serverName];
  const merged = {
    ...current,
    mcpServers: {
      ...existingServers,
      [serverName]: launchConfig
    }
  };

  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  const updated = JSON.stringify(existingEntry || null) !== JSON.stringify(launchConfig);
  return {
    file: filePath,
    server: serverName,
    updated
  };
}

function installExternalMcpConfigs(options = {}) {
  const targets = resolveExternalMcpConfigTargets();
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
        updated: merged.updated
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

function getKnownExternalSkillBaseDirs() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return dedupePaths([
    path.join(home, ".cursor", "skills"),
    path.join(home, ".trae", "skills"),
    path.join(home, ".trae-cn", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".openclaw", "skills"),
    path.join(appData, "Cursor", "User", "skills"),
    path.join(appData, "Trae", "User", "skills"),
    path.join(appData, "Trae CN", "User", "skills"),
    path.join(appData, "OpenClaw", "User", "skills")
  ]);
}

function resolveExternalSkillBaseDirs() {
  const fromEnv = parsePathListFromEnv(process.env[externalSkillDirsEnv]);
  const known = getKnownExternalSkillBaseDirs().filter((dirPath) => pathExists(dirPath));
  return dedupePaths([...fromEnv, ...known]);
}

function mirrorSkillToExternalDirs() {
  const baseDirs = resolveExternalSkillBaseDirs();
  const mirrored = [];
  const skipped = [];
  for (const baseDir of baseDirs) {
    try {
      const targetDir = path.join(baseDir, skillName);
      ensureDir(path.dirname(targetDir));
      fs.cpSync(skillSourceDir, targetDir, { recursive: true, force: true });
      mirrored.push({ base_dir: baseDir, target_dir: targetDir });
    } catch (error) {
      skipped.push({ base_dir: baseDir, reason: error.message });
    }
  }
  return { baseDirs, mirrored, skipped };
}

function syncSkillAssets(options = {}) {
  const force = options.force === true;
  const targetDir = getSkillTargetDir();
  const skillEntry = path.join(targetDir, "SKILL.md");
  const installedVersion = readInstalledSkillVersion();
  const needsSync = force || !fs.existsSync(skillEntry) || installedVersion !== packageVersion;
  if (!needsSync) {
    return { targetDir, updated: false, installedVersion, packageVersion };
  }
  ensureDir(path.dirname(targetDir));
  fs.cpSync(skillSourceDir, targetDir, { recursive: true, force: true });
  writeInstalledSkillVersion(packageVersion);
  return { targetDir, updated: true, installedVersion, packageVersion };
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
  return syncSkillAssets({ force: true }).targetDir;
}

function ensureUserConfig() {
  const targetDir = path.join(getCodexHome(), "boss-recommend-mcp");
  const targetPath = getUserConfigPath();
  ensureDir(targetDir);
  if (!fs.existsSync(targetPath)) {
    const template = JSON.parse(fs.readFileSync(exampleConfigPath, "utf8"));
    template.outputDir = getDesktopDir();
    template.debugPort = 9222;
    fs.writeFileSync(targetPath, JSON.stringify(template, null, 2), "utf8");
    return { path: targetPath, created: true };
  }
  return { path: targetPath, created: false };
}

function readJsonObjectFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config content must be a JSON object");
  }
  return parsed;
}

function persistDebugPortSelection(port) {
  const configPath = getUserConfigPath();
  let config = {};
  if (fs.existsSync(configPath)) {
    config = readJsonObjectFile(configPath);
  }
  config.debugPort = port;
  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  return { port, configPath };
}

function setDebugPort(options = {}) {
  const selected = parsePositivePort(options.port);
  if (!selected) {
    throw new Error("Missing required --port <number> for set-port.");
  }
  process.env.BOSS_RECOMMEND_CHROME_PORT = String(selected);
  return persistDebugPortSelection(selected);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function listChromeTabs(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`DevTools endpoint returned ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function findChromeOnboardingUrl(tabs) {
  for (const tab of tabs) {
    if (typeof tab?.url === "string" && chromeOnboardingUrlPattern.test(tab.url)) {
      return tab.url;
    }
  }
  return null;
}

function getChromeExecutable() {
  const candidates = [
    process.env.BOSS_RECOMMEND_CHROME_PATH,
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe")
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function getChromeUserDataDir(port) {
  const targetPath = path.join(getCodexHome(), "boss-recommend-mcp", `chrome-profile-${port}`);
  ensureDir(targetPath);
  return targetPath;
}

async function launchChrome(options = {}) {
  const port = parsePositivePort(options.port) || parsePositivePort(process.env.BOSS_RECOMMEND_CHROME_PORT) || 9222;
  process.env.BOSS_RECOMMEND_CHROME_PORT = String(port);

  const initialState = await inspectBossRecommendPageState(port, { timeoutMs: 1500, pollMs: 400 });
  if (initialState.state !== "DEBUG_PORT_UNREACHABLE") {
    console.log(`Reusing existing Chrome debug instance on port ${port}`);
    const pageState = await ensureBossRecommendPageReady(getWorkspaceRoot(options), { port, attempts: 2 });
    if (pageState.ok) {
      console.log("Boss recommend page is ready.");
    } else {
      console.log(pageState.page_state?.message || "Boss recommend page is not ready.");
    }
    return;
  }

  const chromePath = getChromeExecutable();
  if (!chromePath) {
    console.error("Chrome executable not found. Set BOSS_RECOMMEND_CHROME_PATH or install Google Chrome.");
    process.exitCode = 1;
    return;
  }

  const userDataDir = getChromeUserDataDir(port);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    bossUrl
  ];
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  console.log(`Chrome launched with remote debugging port ${port}`);
  console.log(`User data dir: ${userDataDir}`);
  const pageState = await ensureBossRecommendPageReady(getWorkspaceRoot(options), { port, attempts: 6 });
  if (pageState.ok) {
    console.log("Boss recommend page is ready.");
  } else {
    console.log(pageState.page_state?.message || "Boss recommend page is not ready.");
  }
}

async function printDoctor(options = {}) {
  const port = parsePositivePort(options.port) || parsePositivePort(process.env.BOSS_RECOMMEND_CHROME_PORT) || 9222;
  const workspaceRoot = getWorkspaceRoot(options);
  const checks = runPipelinePreflight(workspaceRoot).checks.slice();
  const pageState = await inspectBossRecommendPageState(port, { timeoutMs: 2000, pollMs: 500 });
  checks.push({
    key: "user_config",
    ok: fs.existsSync(getUserConfigPath()),
    path: getUserConfigPath(),
    message: "用户配置不存在"
  });
  checks.push({
    key: "chrome_debug_port",
    ok: pageState.state !== "DEBUG_PORT_UNREACHABLE",
    path: `http://localhost:${port}`,
    message: pageState.state === "DEBUG_PORT_UNREACHABLE"
      ? `无法连接 Chrome 调试端口 ${port}`
      : `Chrome 调试端口 ${port} 可连接`
  });
  checks.push(pageState);
  printJson({ ok: checks.every((item) => item.ok), port, checks });
}

function printPaths() {
  const codexHome = getCodexHome();
  console.log(`package_root=${packageRoot}`);
  console.log(`skill_source=${skillSourceDir}`);
  console.log(`codex_home=${codexHome}`);
  console.log(`skill_target=${path.join(codexHome, "skills", skillName)}`);
  console.log(`config_target=${getUserConfigPath()}`);
  console.log(`desktop_output_default=${getDesktopDir()}`);
}

function printHelp() {
  console.log("boss-recommend-mcp");
  console.log("");
  console.log("Usage:");
  console.log("  boss-recommend-mcp              Start the MCP server");
  console.log("  boss-recommend-mcp start        Start the MCP server");
  console.log("  boss-recommend-mcp run          Run the recommend pipeline once via CLI and print JSON");
  console.log("  boss-recommend-mcp install      Install Codex skill and initialize user config");
  console.log("  boss-recommend-mcp install-skill Install only the Codex skill");
  console.log("  boss-recommend-mcp init-config  Create ~/.codex/boss-recommend-mcp/screening-config.json if missing");
  console.log("  boss-recommend-mcp set-port     Persist preferred Chrome debug port to screening-config.json");
  console.log("  boss-recommend-mcp mcp-config   Generate MCP config JSON for Cursor/Trae(含 trae-cn)/Claude Code/OpenClaw");
  console.log("  boss-recommend-mcp doctor       Check config and runtime prerequisites");
  console.log("  boss-recommend-mcp launch-chrome Launch or reuse Chrome debug instance and open Boss recommend page");
  console.log("  boss-recommend-mcp where        Print installed package, skill, and config paths");
  console.log("");
  console.log("Run command:");
  console.log("  boss-recommend-mcp run --instruction \"推荐页上筛选211男生，近14天没有，有大模型平台经验\" [--confirmation-json '{...}'] [--overrides-json '{...}']");
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

function installAll() {
  const skillTarget = installSkill();
  const configResult = ensureUserConfig();
  const mcpTemplateResult = writeMcpConfigFiles({ client: "all" });
  const externalMcpResult = installExternalMcpConfigs({});
  const externalSkillResult = mirrorSkillToExternalDirs();
  console.log(`Skill installed to: ${skillTarget}`);
  console.log(configResult.created ? `Config template created at: ${configResult.path}` : `Config already exists at: ${configResult.path}`);
  console.log(`MCP config templates exported to: ${mcpTemplateResult.outputDir}`);
  for (const item of mcpTemplateResult.files) {
    console.log(`- ${item.client}: ${item.file}`);
  }
  if (externalMcpResult.targets.length > 0) {
    console.log(`Auto-configured external MCP files: ${externalMcpResult.applied.length}`);
    for (const item of externalMcpResult.applied) {
      const action = item.created ? "created" : item.updated ? "updated" : "unchanged";
      console.log(`- ${item.file} (${action})`);
    }
  } else {
    console.log("No external MCP config target detected. Set BOSS_RECOMMEND_MCP_CONFIG_TARGETS to auto-configure custom agents.");
  }
  if (externalSkillResult.baseDirs.length > 0) {
    console.log(`Mirrored skill to external dirs: ${externalSkillResult.mirrored.length}`);
    for (const item of externalSkillResult.mirrored) {
      console.log(`- ${item.target_dir}`);
    }
  } else {
    console.log("No external skill dir detected. Set BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS to mirror skill for non-Codex agents.");
  }
}

async function runPipelineOnce(options) {
  const instruction = getRunInstruction(options);
  const confirmation = getRunConfirmation(options);
  const overrides = getRunOverrides(options);
  const workspaceRoot = getWorkspaceRoot(options);
  const explicitPort = parsePositivePort(options.port);
  if (explicitPort) {
    process.env.BOSS_RECOMMEND_CHROME_PORT = String(explicitPort);
    persistDebugPortSelection(explicitPort);
  }

  const result = await runRecommendPipeline({
    workspaceRoot,
    instruction,
    confirmation,
    overrides
  });
  printJson(result);
}

const command = process.argv[2] || "start";
const options = parseOptions(process.argv.slice(3));
ensureAssetsUpToDate(command);

switch (command) {
  case "start":
    startServer();
    break;
  case "run":
    try {
      await runPipelineOnce(options);
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
  case "install":
    installAll();
    break;
  case "install-skill":
    console.log(`Skill installed to: ${installSkill()}`);
    break;
  case "init-config": {
    const result = ensureUserConfig();
    console.log(result.created ? `Config template created at: ${result.path}` : `Config already exists at: ${result.path}`);
    break;
  }
  case "set-port": {
    try {
      const result = setDebugPort(options);
      console.log(`Preferred debug port saved: ${result.port}`);
      console.log(`Updated config: ${result.configPath}`);
      console.log("Port priority for runtime commands: --port > BOSS_RECOMMEND_CHROME_PORT > screening-config.json.debugPort > 9222");
    } catch (error) {
      console.error(error.message || "Failed to persist debug port.");
      process.exitCode = 1;
    }
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
  case "launch-chrome":
    await launchChrome(options);
    break;
  case "where":
    printPaths();
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
