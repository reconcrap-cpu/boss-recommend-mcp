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
  getFeaturedCalibrationResolution,
  getScreenConfigResolution,
  inspectBossRecommendPageState,
  runRecommendCalibration,
  runPipelinePreflight,
  switchRecommendTab,
  waitRecommendFeaturedDetailReady
} from "./adapters.js";
import {
  cancelBossChatRun,
  getBossChatHealthCheck,
  getBossChatRun,
  pauseBossChatRun,
  prepareBossChatRun,
  resumeBossChatRun,
  startBossChatRun
} from "./boss-chat.js";
import { runRecommendPipeline } from "./pipeline.js";

const require = createRequire(import.meta.url);
const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
const packageJsonPath = path.join(packageRoot, "package.json");
const skillName = "boss-recommend-pipeline";
const bundledSkillNames = [skillName, "boss-chat"];
const exampleConfigPath = path.join(packageRoot, "config", "screening-config.example.json");
const bossUrl = "https://www.zhipin.com/web/chat/recommend";
const chromeOnboardingUrlPattern = /^chrome:\/\/(welcome|intro|newtab|signin|history-sync|settings\/syncSetup)/i;
const supportedMcpClients = ["generic", "cursor", "trae", "claudecode", "openclaw"];
const defaultMcpServerName = "boss-recommend";
const defaultMcpCommand = "npx";
const defaultMcpArgs = ["-y", "@reconcrap/boss-recommend-mcp@latest", "start"];
const recommendMcpPackageName = "@reconcrap/boss-recommend-mcp";
const recommendMcpBinaryName = "boss-recommend-mcp";
const autoSyncSkipCommands = new Set(["install", "install-skill", "where", "help", "--help", "-h"]);
const externalMcpTargetsEnv = "BOSS_RECOMMEND_MCP_CONFIG_TARGETS";
const externalSkillDirsEnv = "BOSS_RECOMMEND_EXTERNAL_SKILL_DIRS";

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

function getRunFollowUp(options) {
  if (typeof options["follow-up-file"] === "string" && options["follow-up-file"].trim()) {
    return parseJsonOption(readTextFile(options["follow-up-file"], "follow_up"), "follow_up");
  }
  return parseJsonOption(options["follow-up-json"], "follow_up");
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

const supportedExternalAgents = ["cursor", "trae", "trae-cn", "claude", "openclaw"];

function normalizeAgentName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "claude-code") return "claude";
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

function getKnownExternalMcpConfigPathsByAgent() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const traeDirNames = dedupeLower([
    "Trae",
    "Trae CN",
    "TraeCN",
    "trae-cn",
    "trae_cn",
    ...discoverAppDataDirsByPattern(appData, /^trae(?:[\s\-_]?cn)?$/i)
  ]);
  const traeConfigPaths = traeDirNames.map((dir) => path.join(appData, dir, "User", "mcp.json"));
  return {
    cursor: [path.join(appData, "Cursor", "User", "mcp.json"), path.join(home, ".cursor", "mcp.json")],
    trae: [...traeConfigPaths, path.join(home, ".trae", "mcp.json"), path.join(home, ".trae-cn", "mcp.json")],
    "trae-cn": [...traeConfigPaths, path.join(home, ".trae-cn", "mcp.json"), path.join(home, ".trae", "mcp.json")],
    claude: [path.join(home, ".claude", "mcp.json")],
    openclaw: [path.join(home, ".openclaw", "mcp.json")]
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

function getKnownExternalSkillBaseDirsByAgent() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const traeDirNames = dedupeLower([
    "Trae",
    "Trae CN",
    "TraeCN",
    "trae-cn",
    "trae_cn",
    ...discoverAppDataDirsByPattern(appData, /^trae(?:[\s\-_]?cn)?$/i)
  ]);
  const traeSkillDirs = traeDirNames.map((dir) => path.join(appData, dir, "User", "skills"));
  return {
    cursor: [path.join(home, ".cursor", "skills"), path.join(appData, "Cursor", "User", "skills")],
    trae: [path.join(home, ".trae", "skills"), path.join(home, ".trae-cn", "skills"), ...traeSkillDirs],
    "trae-cn": [path.join(home, ".trae-cn", "skills"), path.join(home, ".trae", "skills"), ...traeSkillDirs],
    claude: [path.join(home, ".claude", "skills")],
    openclaw: [path.join(home, ".openclaw", "skills"), path.join(appData, "OpenClaw", "User", "skills")]
  };
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

function inspectMcpServerEntries(filePath) {
  if (!pathExists(filePath)) {
    return {
      exists: false,
      has_boss_recommend: false,
      has_boss_recruit: false,
      recommend_server_names: [],
      recruit_server_names: []
    };
  }
  const parsed = readJsonObjectFileSafe(filePath);
  const servers = parsed?.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
    ? parsed.mcpServers
    : {};
  const recommendNames = [];
  const recruitNames = [];
  for (const [name, config] of Object.entries(servers)) {
    const lowerName = String(name || "").toLowerCase();
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
  }
  return {
    exists: true,
    has_boss_recommend: recommendNames.length > 0,
    has_boss_recruit: recruitNames.length > 0,
    recommend_server_names: recommendNames,
    recruit_server_names: recruitNames
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
        ensureDir(path.dirname(targetDir));
        fs.cpSync(getSkillSourceDir(bundledSkillName), targetDir, { recursive: true, force: true });
        mirrored.push({ base_dir: baseDir, target_dir: targetDir, skill: bundledSkillName });
      } catch (error) {
        skipped.push({ base_dir: baseDir, skill: bundledSkillName, reason: error.message });
      }
    }
  }
  return { baseDirs, mirrored, skipped };
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

function resolveCliConfigTarget(options = {}) {
  const workspaceRoot = getWorkspaceRoot(options);
  const resolution = getScreenConfigResolution(workspaceRoot);
  const workspacePreferred = (resolution.candidate_paths || []).find((item) => pathStartsWith(item, workspaceRoot)) || null;
  const configPath = resolution.writable_path || resolution.resolved_path || workspacePreferred || getUserConfigPath();
  return {
    workspaceRoot,
    resolution,
    configPath,
    workspacePreferred
  };
}

function ensureUserConfig(options = {}) {
  const { configPath, workspacePreferred } = resolveCliConfigTarget(options);
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
        return { path: targetPath, created: false };
      }
      lastError = new Error(`Config target is a directory and cannot be used as file: ${targetPath}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No writable target for screening-config.json");
}

function readJsonObjectFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config content must be a JSON object");
  }
  return parsed;
}

function loadBestExistingUserConfig(options = {}) {
  const { resolution, configPath, workspacePreferred } = resolveCliConfigTarget(options);
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

function writeConfigWithFallback(nextConfig, options = {}) {
  const { configPath, workspacePreferred } = resolveCliConfigTarget(options);
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

function persistDebugPortSelection(port, options = {}) {
  const { config } = loadBestExistingUserConfig(options);
  config.debugPort = port;
  const configPath = writeConfigWithFallback(config, options);
  return { port, configPath };
}

function setDebugPort(options = {}) {
  const selected = parsePositivePort(options.port);
  if (!selected) {
    throw new Error("Missing required --port <number> for set-port.");
  }
  process.env.BOSS_RECOMMEND_CHROME_PORT = String(selected);
  return persistDebugPortSelection(selected, options);
}

function setScreeningConfig(options = {}) {
  const baseUrl = String(options["base-url"] || options.baseUrl || "").trim();
  const apiKey = String(options["api-key"] || options.apiKey || "").trim();
  const model = String(options.model || "").trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Missing required fields: --base-url, --api-key, --model");
  }

  const { config: existing } = loadBestExistingUserConfig(options);
  const nextConfig = {
    ...existing,
    baseUrl,
    apiKey,
    model
  };
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
  const debugPort = parsePositivePort(options.port || options["debug-port"]);
  if (debugPort) {
    nextConfig.debugPort = debugPort;
  }
  const configPath = writeConfigWithFallback(nextConfig, options);
  return { path: configPath, updated: true };
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

function getCalibrationTimeoutMs(options = {}) {
  const parsed = Number.parseInt(String(options["timeout-ms"] || options.timeoutMs || options.timeout || ""), 10);
  if (!Number.isFinite(parsed)) return 60000;
  return Math.max(5000, parsed);
}

async function calibrate(options = {}) {
  const workspaceRoot = getWorkspaceRoot(options);
  const port = parsePositivePort(options.port) || parsePositivePort(process.env.BOSS_RECOMMEND_CHROME_PORT) || 9222;
  process.env.BOSS_RECOMMEND_CHROME_PORT = String(port);
  persistDebugPortSelection(port, options);
  const timeoutMs = getCalibrationTimeoutMs(options);
  const outputPath = String(options.output || "").trim()
    ? path.resolve(String(options.output))
    : null;

  console.log("Calibration checklist:");
  console.log("0. 本校准仅用于推荐页“精选(tab)”的收藏点击定位。");
  console.log("1. 工具会优先复用当前调试端口 Chrome，并确保 recommend 页面可访问。");
  console.log("2. 工具会尝试自动切换到推荐页“精选”tab；校准过程中请不要再切换 tab。");
  console.log("3. 先点一次收藏，再点一次取消收藏。");
  console.log("4. 关闭详情页。");
  console.log(`5. 校准监听窗口约 ${Math.round(timeoutMs / 1000)} 秒。`);
  console.log("");

  const preState = await inspectBossRecommendPageState(port, { timeoutMs: 2000, pollMs: 500 });
  if (preState.state === "DEBUG_PORT_UNREACHABLE") {
    await launchChrome({ ...options, port: String(port) });
    if (process.exitCode && process.exitCode !== 0) {
      return;
    }
  } else {
    console.log(`Detected existing Chrome debug instance on port ${port}; calibration will reuse it.`);
  }

  const pageReady = await ensureBossRecommendPageReady(workspaceRoot, {
    port,
    attempts: 4
  });
  if (pageReady.ok) {
    const switchResult = await switchRecommendTab(workspaceRoot, {
      port,
      target_status: "3"
    });
    if (switchResult?.ok) {
      console.log("已自动切换到推荐页“精选”tab，请直接在当前页面打开人选详情并完成收藏/取消收藏。");
    } else {
      console.log("未能自动切换到“精选”tab，请手动切换到精选后再执行收藏/取消收藏。");
    }
  } else {
    console.log("未能确认 recommend 页面就绪，请手动进入推荐页并切换到精选 tab 后再继续校准操作。");
  }

  console.log(`等待你打开“精选”候选人详情页（最多 ${Math.round(timeoutMs / 1000)} 秒），检测到后自动开始校准监听...`);
  const detailReady = await waitRecommendFeaturedDetailReady(workspaceRoot, {
    port,
    timeoutMs,
    pollMs: 400
  });
  if (!detailReady.ok) {
    console.error(detailReady.message || "未检测到可校准的精选详情页。");
    console.error("请先打开任意精选候选人详情页并保持在前台，然后重新运行 calibrate。");
    process.exitCode = 1;
    return;
  }
  const detailSource = detailReady.detail_state?.source || "unknown";
  const detailSelector = detailReady.detail_state?.selector || "unknown";
  console.log(`已检测到详情页（source=${detailSource}, selector=${detailSelector}），即将启动校准脚本。`);
  await new Promise((resolve) => setTimeout(resolve, 600));

  const result = await runRecommendCalibration(workspaceRoot, {
    port,
    output: outputPath,
    timeoutMs,
    runtime: {
      onOutput: (event) => {
        const text = String(event?.text || "");
        if (!text) return;
        if (event?.stream === "stderr") {
          process.stderr.write(text);
        } else {
          process.stdout.write(text);
        }
      }
    }
  });
  if (result.ok) {
    console.log(`Calibration saved: ${result.calibration_path}`);
    return;
  }

  console.error(result.error?.message || "Calibration failed.");
  console.error("如果你在校准开始后才从推荐切到精选，请先切到精选 tab 后重新运行 calibrate。");
  if (result.calibration_script_path) {
    console.error(`Calibration script: ${result.calibration_script_path}`);
  }
  if (result.calibration_path) {
    console.error(`Calibration target: ${result.calibration_path}`);
  }
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
  const preflight = runPipelinePreflight(workspaceRoot, { pageScope });
  const checks = preflight.checks.slice();
  const configResolution = getScreenConfigResolution(workspaceRoot);
  const calibrationResolution = getFeaturedCalibrationResolution(workspaceRoot);
  const pageState = await inspectBossRecommendPageState(port, { timeoutMs: 2000, pollMs: 500 });
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
    path: calibrationResolution.calibration_script_path,
    message: calibrationResolution.calibration_script_path
      ? "已检测到 boss-recruit-mcp 校准脚本。"
      : "未检测到 boss-recruit-mcp 校准脚本，精选页自动校准不可用。"
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
    ok: checks.every((item) => item.ok),
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
  const calibrationResolution = getFeaturedCalibrationResolution(process.cwd());
  console.log(`package_root=${packageRoot}`);
  console.log(`skill_sources=${bundledSkillNames.map((name) => getSkillSourceDir(name)).join(" | ")}`);
  console.log(`codex_home=${codexHome}`);
  console.log(`state_home=${stateHome}`);
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
  console.log("  boss-recommend-mcp run          Run the recommend pipeline once via CLI and print JSON");
  console.log("  boss-recommend-mcp chat <subcommand>  Run bundled boss-chat commands via the recommend package");
  console.log("  boss-recommend-mcp install      Install skill/MCP templates and auto-init screening-config.json (supports --agent trae-cn/cursor/...)");
  console.log("  boss-recommend-mcp install-skill Install bundled Codex skills");
  console.log("  boss-recommend-mcp init-config  Create screening-config.json if missing (prefer workspace config/, fallback ~/.boss-recommend-mcp)");
  console.log("  boss-recommend-mcp config set   Write baseUrl/apiKey/model (prefer workspace config/, fallback ~/.boss-recommend-mcp)");
  console.log("  boss-recommend-mcp set-port     Persist preferred Chrome debug port to screening-config.json");
  console.log("  boss-recommend-mcp mcp-config   Generate MCP config JSON for Cursor/Trae(含 trae-cn)/Claude Code/OpenClaw");
  console.log("  boss-recommend-mcp doctor       Check config/runtime/calibration prerequisites (supports --agent trae-cn/cursor/...)");
  console.log("  boss-recommend-mcp calibrate    Run featured favorite calibration via recruit calibration script");
  console.log("  boss-recommend-mcp launch-chrome Launch or reuse Chrome debug instance and open Boss recommend page");
  console.log("  boss-recommend-mcp where        Print installed package, skill, and config paths");
  console.log("");
  console.log("Run command:");
  console.log("  boss-recommend-mcp run --instruction \"推荐页上筛选211男生，近14天没有，有大模型平台经验\" [--confirmation-json '{...}'] [--overrides-json '{...}'] [--follow-up-json '{...}']");
  console.log("  boss-recommend-mcp chat run --job \"算法工程师\" --start-from unread --criteria \"有 AI Agent 经验\" --targetCount 20    # 后台启动，不自动轮询");
  console.log("  boss-recommend-mcp config set --base-url <url> --api-key <key> --model <model> [--thinking-level off|low|medium|high|current] [--openai-organization <id>] [--openai-project <id>]");
  console.log("  boss-recommend-mcp install --agent trae-cn");
  console.log("  boss-recommend-mcp doctor --agent trae-cn --page-scope featured");
  console.log("  boss-recommend-mcp calibrate --port 9222 [--timeout-ms 60000] [--output <path>]");
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

function installAll(options = {}) {
  const skillResults = installSkill();
  const configResult = ensureUserConfig(options);
  const mcpTemplateResult = writeMcpConfigFiles({ client: "all" });
  const externalMcpResult = installExternalMcpConfigs(options);
  const externalSkillResult = mirrorSkillToExternalDirs(options);
  console.log(`Bundled skills installed: ${skillResults.length}`);
  for (const item of skillResults) {
    console.log(`- ${item.skill}: ${item.targetDir}`);
  }
  console.log(
    configResult.created
      ? `screening-config.json created: ${configResult.path}`
      : `screening-config.json already exists: ${configResult.path}`
  );
  console.log(`请在该目录修改 baseUrl/apiKey/model 并替换占位词后再运行：${path.dirname(configResult.path)}`);
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
  if (typeof options.agent === "string" && options.agent.trim()) {
    console.log(`Target agent filter: ${options.agent.trim()}`);
  }
}

async function runPipelineOnce(options) {
  const instruction = getRunInstruction(options);
  const confirmation = getRunConfirmation(options);
  const overrides = getRunOverrides(options);
  const followUp = getRunFollowUp(options);
  const workspaceRoot = getWorkspaceRoot(options);
  const explicitPort = parsePositivePort(options.port);
  if (explicitPort) {
    process.env.BOSS_RECOMMEND_CHROME_PORT = String(explicitPort);
    persistDebugPortSelection(explicitPort, options);
  }

  const result = await runRecommendPipeline({
    workspaceRoot,
    instruction,
    confirmation,
    overrides,
    followUp
  });
  printJson(result);
}

function buildBossChatCliInput(options = {}) {
  return {
    profile: typeof options.profile === "string" ? options.profile.trim() : undefined,
    job: typeof options.job === "string" ? options.job.trim() : undefined,
    start_from: String(options["start-from"] || options.start_from || "").trim().toLowerCase() || undefined,
    criteria: typeof options.criteria === "string" ? options.criteria.trim() : undefined,
    target_count: parseBossChatTargetCountOption(options.targetCount || options["target-count"] || options.target_count),
    port: parsePositivePort(options.port),
    dry_run: options["dry-run"] === true || options.dryRun === true,
    no_state: options["no-state"] === true || options.noState === true,
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

async function runBossChatCliCommand(subcommand, options = {}) {
  const workspaceRoot = getWorkspaceRoot(options);
  if (subcommand === "health-check") {
    printJson(getBossChatHealthCheck(workspaceRoot, {
      port: parsePositivePort(options.port)
    }));
    return;
  }

  if (subcommand === "prepare-run") {
    printJson(await prepareBossChatRun({
      workspaceRoot,
      input: buildBossChatCliInput(options)
    }));
    return;
  }

  if (subcommand === "run") {
    printJson(await startBossChatRun({
      workspaceRoot,
      input: buildBossChatCliInput(options)
    }));
    return;
  }

  if (subcommand === "start-run") {
    printJson(await startBossChatRun({
      workspaceRoot,
      input: buildBossChatCliInput(options)
    }));
    return;
  }

  if (subcommand === "get-run") {
    printJson(await getBossChatRun({
      workspaceRoot,
      input: getBossChatCliRunTarget(options)
    }));
    return;
  }

  if (subcommand === "pause-run") {
    printJson(await pauseBossChatRun({
      workspaceRoot,
      input: getBossChatCliRunTarget(options)
    }));
    return;
  }

  if (subcommand === "resume-run") {
    printJson(await resumeBossChatRun({
      workspaceRoot,
      input: getBossChatCliRunTarget(options)
    }));
    return;
  }

  if (subcommand === "cancel-run") {
    printJson(await cancelBossChatRun({
      workspaceRoot,
      input: getBossChatCliRunTarget(options)
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
        installAll(options);
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
      const result = ensureUserConfig(options);
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
    case "set-config": {
      try {
        const result = setScreeningConfig(options);
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
          const result = setScreeningConfig(configOptions);
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
}

export const __testables = {
  buildBossChatCliInput,
  getBossChatCliRunTarget,
  getRunFollowUp,
  installSkill,
  runBossChatCliCommand,
  runPipelineOnce
};

if (process.argv[1] && path.resolve(process.argv[1]) === currentFilePath) {
  await runCli(process.argv);
}
