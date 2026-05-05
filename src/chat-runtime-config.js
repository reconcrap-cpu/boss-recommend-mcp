import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const BOSS_CHAT_RUNTIME_SUBDIR = "boss-chat";
const TARGET_COUNT_WRAPPER_KEYS = ["target_count", "targetCount", "value", "count", "limit"];
const SCREEN_CONFIG_TEMPLATE_DEFAULTS = Object.freeze({
  baseUrl: "https://api.openai.com/v1",
  apiKey: "replace-with-your-api-key",
  model: "gpt-4.1-mini"
});
const LLM_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "auto", "current"]);

export const TARGET_COUNT_CANONICAL_ALL = "all";
export const TARGET_COUNT_ACCEPTED_EXAMPLES = [TARGET_COUNT_CANONICAL_ALL, -1, 20, "全部候选人"];

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getStateHome() {
  return process.env.BOSS_RECOMMEND_HOME
    ? path.resolve(process.env.BOSS_RECOMMEND_HOME)
    : path.join(os.homedir(), ".boss-recommend-mcp");
}

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function pathExists(targetPath) {
  try {
    return Boolean(targetPath) && fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function isRootDirectory(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || ""));
  return path.parse(root).root.toLowerCase() === root.toLowerCase();
}

function isEphemeralNpxWorkspaceRoot(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || ""));
  const normalized = root.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/appdata/local/npm-cache/_npx/")
    || normalized.includes("/node_modules/@reconcrap/boss-recommend-mcp")
  );
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
  if (shouldIgnoreWorkspaceConfigRoot(root)) return [];
  const directPath = path.join(root, "config", "screening-config.json");
  const nestedPath = path.join(root, "boss-recommend-mcp", "config", "screening-config.json");
  const candidates = [directPath];
  if (path.basename(root).toLowerCase() !== "boss-recommend-mcp") {
    candidates.push(nestedPath);
  }
  return Array.from(new Set(candidates));
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
    fs.mkdirSync(targetDir, { recursive: true });
    fs.accessSync(targetDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveWritableScreenConfigPath(workspaceRoot) {
  const candidateMap = buildScreenConfigCandidateMap(workspaceRoot);
  const workspacePreferred = candidateMap.workspace_paths?.[0] || null;
  if (candidateMap.env_path) return candidateMap.env_path;
  if (candidateMap.user_path && canWriteDirectory(path.dirname(candidateMap.user_path))) {
    return candidateMap.user_path;
  }
  if (workspacePreferred && canWriteDirectory(path.dirname(workspacePreferred))) {
    return workspacePreferred;
  }
  if (workspacePreferred) return workspacePreferred;
  return candidateMap.user_path || candidateMap.legacy_path;
}

function resolveScreenConfigPath(workspaceRoot) {
  const candidateMap = buildScreenConfigCandidateMap(workspaceRoot);
  if (candidateMap.env_path) return candidateMap.env_path;
  if (candidateMap.user_path && pathExists(candidateMap.user_path)) return candidateMap.user_path;
  const existingWorkspacePath = candidateMap.workspace_paths.find((item) => pathExists(item));
  if (existingWorkspacePath) return existingWorkspacePath;
  return resolveWritableScreenConfigPath(workspaceRoot) || candidateMap.legacy_path;
}

function readJsonFile(filePath) {
  if (!filePath || !pathExists(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isUsableFeaturedCalibrationFile(filePath) {
  const parsed = readJsonFile(filePath);
  return Boolean(
    parsed
    && typeof parsed === "object"
    && !Array.isArray(parsed)
    && parsed.favoritePosition
    && Number.isFinite(parsed.favoritePosition.pageX)
    && Number.isFinite(parsed.favoritePosition.pageY)
  );
}

function resolveFeaturedCalibrationPath(workspaceRoot) {
  const fromEnv = normalizeText(process.env.BOSS_RECOMMEND_CALIBRATION_FILE || "");
  if (fromEnv) return path.resolve(fromEnv);

  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const configPath = configResolution.config_path || resolveScreenConfigPath(workspaceRoot) || getUserConfigPath();
  const config = readJsonFile(configPath);
  const calibrationFile = normalizeText(config?.calibrationFile || "");
  if (calibrationFile && configPath) {
    return path.resolve(path.dirname(configPath), calibrationFile);
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
    path.join(workspaceResolved, "..", "boss recruit pipeline", "boss-recruit-mcp", "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs"),
    path.join(appData, "npm", "node_modules", "@reconcrap", "boss-recruit-mcp", "vendor", "boss-screen-cli", "calibrate-favorite-position-v2.cjs")
  ].filter(Boolean).map((item) => path.resolve(item));

  for (const candidate of new Set(candidates)) {
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

function parsePositiveInteger(raw, fallback = null) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseConfigNumber(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseConfigBoolean(raw, fallback = false) {
  if (typeof raw === "boolean") return raw;
  const normalized = normalizeText(raw).toLowerCase();
  if (["true", "1", "yes", "y", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function normalizeLlmThinkingLevel(raw, fallback = "low") {
  const normalized = normalizeText(raw).toLowerCase();
  return LLM_THINKING_LEVELS.has(normalized) ? normalized : fallback;
}

function resolveConfigPathValue(raw, configDir) {
  const normalized = normalizeText(raw);
  if (!normalized) return "";
  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(configDir || process.cwd(), normalized);
}

function validateScreeningConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {
      ok: false,
      reason: "INVALID_OR_MISSING_CONFIG",
      message: "screening-config.json 缺失或格式无效。请填写 baseUrl、apiKey、model。"
    };
  }
  const baseUrl = normalizeText(config.baseUrl).replace(/\/+$/, "");
  const apiKey = normalizeText(config.apiKey);
  const model = normalizeText(config.model);
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
  if (/^replace-with/i.test(apiKey) || apiKey === SCREEN_CONFIG_TEMPLATE_DEFAULTS.apiKey) {
    return {
      ok: false,
      reason: "PLACEHOLDER_API_KEY",
      message: "screening-config.json 的 apiKey 仍是模板占位符，请填写真实 API Key。"
    };
  }
  if (
    baseUrl === SCREEN_CONFIG_TEMPLATE_DEFAULTS.baseUrl
    && apiKey === SCREEN_CONFIG_TEMPLATE_DEFAULTS.apiKey
    && model === SCREEN_CONFIG_TEMPLATE_DEFAULTS.model
  ) {
    return {
      ok: false,
      reason: "PLACEHOLDER_TEMPLATE_VALUES",
      message: "screening-config.json 仍是默认模板值，请填写 baseUrl、apiKey、model。"
    };
  }
  return { ok: true, reason: "OK", message: "screening-config.json 校验通过。" };
}

export function resolveBossChatDataDir() {
  if (process.env.BOSS_CHAT_HOME) {
    return {
      data_dir: path.resolve(process.env.BOSS_CHAT_HOME),
      data_dir_source: "env:BOSS_CHAT_HOME"
    };
  }
  const stateHome = getStateHome();
  const source = process.env.BOSS_RECOMMEND_HOME
    ? "default:env:BOSS_RECOMMEND_HOME"
    : "default:user_home";
  return {
    data_dir: path.join(stateHome, BOSS_CHAT_RUNTIME_SUBDIR),
    data_dir_source: source
  };
}

export function getBossChatDataDir() {
  return resolveBossChatDataDir().data_dir;
}

export function getLegacyBossChatWorkspaceDataDir(workspaceRoot) {
  const root = path.resolve(String(workspaceRoot || ""));
  if (!root || isRootDirectory(root) || isSystemDirectoryWorkspaceRoot(root)) return null;
  return path.join(root, ".boss-chat");
}

export function resolveBossChatRuntimeLayout(workspaceRoot) {
  const resolvedDataDir = resolveBossChatDataDir();
  const legacyWorkspaceDir = getLegacyBossChatWorkspaceDataDir(workspaceRoot);
  const migrationSourceDir = legacyWorkspaceDir && pathExists(legacyWorkspaceDir) && !pathExists(resolvedDataDir.data_dir)
    ? legacyWorkspaceDir
    : null;
  return {
    workspace_root: workspaceRoot ? path.resolve(String(workspaceRoot)) : null,
    data_dir: resolvedDataDir.data_dir,
    data_dir_source: resolvedDataDir.data_dir_source,
    legacy_workspace_dir: legacyWorkspaceDir,
    migration_source_dir: migrationSourceDir,
    migration_pending: Boolean(migrationSourceDir)
  };
}

export function getBossScreenConfigResolution(workspaceRoot) {
  const candidateMap = buildScreenConfigCandidateMap(workspaceRoot);
  const workspaceRootResolved = path.resolve(String(workspaceRoot || process.cwd()));
  return {
    resolved_path: resolveScreenConfigPath(workspaceRoot) || null,
    candidate_paths: resolveScreenConfigCandidates(workspaceRoot),
    workspace_root: workspaceRootResolved,
    workspace_ephemeral: isEphemeralNpxWorkspaceRoot(workspaceRootResolved),
    workspace_ignored_for_config: shouldIgnoreWorkspaceConfigRoot(workspaceRootResolved),
    writable_path: resolveWritableScreenConfigPath(workspaceRoot),
    legacy_path: candidateMap.legacy_path
  };
}

export function getFeaturedCalibrationResolution(workspaceRoot) {
  const calibrationPath = resolveFeaturedCalibrationPath(workspaceRoot);
  return {
    calibration_path: calibrationPath,
    calibration_exists: pathExists(calibrationPath),
    calibration_usable: isUsableFeaturedCalibrationFile(calibrationPath),
    calibration_script_path: resolveRecruitCalibrationScriptPath(workspaceRoot)
  };
}

export function resolveBossScreeningConfig(workspaceRoot) {
  const candidatePaths = resolveScreenConfigCandidates(workspaceRoot);
  const configPath = resolveScreenConfigPath(workspaceRoot) || null;
  const configDir = configPath ? path.dirname(configPath) : null;
  if (!configPath || !pathExists(configPath)) {
    return {
      ok: false,
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: `screening-config.json 不存在。请先完成 recommend 配置。${configPath ? ` (path: ${configPath})` : ""}`,
        retryable: true
      },
      config_path: configPath,
      config_dir: configDir,
      candidate_paths: candidatePaths
    };
  }
  const parsed = readJsonFile(configPath);
  const validation = validateScreeningConfig(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: `${validation.message} (path: ${configPath})`,
        retryable: true
      },
      config_path: configPath,
      config_dir: configDir,
      candidate_paths: candidatePaths
    };
  }
  return {
    ok: true,
    config: {
      baseUrl: normalizeText(parsed.baseUrl).replace(/\/+$/, ""),
      apiKey: normalizeText(parsed.apiKey),
      model: normalizeText(parsed.model),
      openaiOrganization: normalizeText(parsed.openaiOrganization || parsed.organization),
      openaiProject: normalizeText(parsed.openaiProject || parsed.project),
      debugPort: parsePositiveInteger(parsed.debugPort, 9222),
      llmThinkingLevel: normalizeLlmThinkingLevel(parsed.llmThinkingLevel || parsed.thinkingLevel || parsed.reasoningEffort, "low"),
      llmTimeoutMs: parsePositiveInteger(parsed.llmTimeoutMs || parsed.timeoutMs, null),
      llmMaxRetries: parsePositiveInteger(parsed.llmMaxRetries || parsed.maxRetries, null),
      llmMaxTokens: parsePositiveInteger(parsed.llmMaxTokens || parsed.maxTokens, null),
      llmMaxCompletionTokens: parsePositiveInteger(parsed.llmMaxCompletionTokens || parsed.maxCompletionTokens, null),
      llmImageLimit: parsePositiveInteger(parsed.llmImageLimit || parsed.imageLimit, null),
      llmImageDetail: normalizeText(parsed.llmImageDetail || parsed.imageDetail),
      temperature: parseConfigNumber(parsed.temperature, null),
      topP: parseConfigNumber(parsed.topP || parsed.top_p, null),
      outputDir: resolveConfigPathValue(parsed.outputDir, configDir),
      humanRestEnabled: parseConfigBoolean(parsed.humanRestEnabled, false)
    },
    config_path: configPath,
    config_dir: configDir,
    candidate_paths: candidatePaths
  };
}

export function resolveBossConfiguredOutputDir(workspaceRoot, fallbackDir = "") {
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const configuredDir = configResolution.ok ? normalizeText(configResolution.config.outputDir) : "";
  if (configuredDir) return configuredDir;
  return fallbackDir ? path.resolve(fallbackDir) : "";
}

function isUnlimitedTargetCountToken(value) {
  const token = normalizeText(value).toLowerCase();
  if (!token) return false;
  const compact = token.replace(/\s+/g, "");
  const withoutAnnotation = compact.replace(/[（(【[].*?[）)】\]]/gu, "");
  const knownTokens = new Set([
    "all",
    "unlimited",
    "infinity",
    "inf",
    "max",
    "full",
    "allcandidates",
    "全部",
    "全量",
    "不限",
    "扫到底",
    "全部候选人",
    "所有候选人",
    "全部人选",
    "所有人选",
    "直到完成所有人选"
  ]);
  if (knownTokens.has(token) || knownTokens.has(compact) || knownTokens.has(withoutAnnotation)) return true;
  if (/^(?:all|unlimited|infinity|inf|max|full)(?:candidate|candidates)?$/i.test(compact)) return true;
  if (/^(?:all|unlimited|infinity|inf|max|full)(?:候选人|人选|牛人|人才|人员)?$/iu.test(withoutAnnotation)) return true;
  if (/^(?:全部|所有|全量|不限)(?:候选人|人选|牛人|人才|人员)?$/u.test(compact)) return true;
  if (!/\d/.test(compact) && /(?:扫到底|全部候选人|所有候选人|全部人选|所有人选)/u.test(compact)) return true;
  return false;
}

function getWrappedTargetCountValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  for (const key of TARGET_COUNT_WRAPPER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return value[key];
    }
  }
  return value;
}

export function getBossChatTargetCountValue(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  if (Object.prototype.hasOwnProperty.call(input, "target_count") && input.target_count !== undefined && input.target_count !== null) {
    return input.target_count;
  }
  if (Object.prototype.hasOwnProperty.call(input, "targetCount") && input.targetCount !== undefined && input.targetCount !== null) {
    return input.targetCount;
  }
  if (Object.prototype.hasOwnProperty.call(input, "target_count")) return input.target_count;
  if (Object.prototype.hasOwnProperty.call(input, "targetCount")) return input.targetCount;
  return undefined;
}

function cloneForDiagnostics(value) {
  if (value === undefined) return undefined;
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export function buildTargetCountCompatibilityHints({
  argumentName = "target_count",
  recommendedArgumentPatch = { target_count: TARGET_COUNT_CANONICAL_ALL },
  includeOptions = true
} = {}) {
  const normalizedArgumentName = normalizeText(argumentName) || "target_count";
  const clonedRecommendedPatch = cloneForDiagnostics(recommendedArgumentPatch)
    || { target_count: TARGET_COUNT_CANONICAL_ALL };
  const literal = `${normalizedArgumentName}="${TARGET_COUNT_CANONICAL_ALL}"`;
  const base = {
    argument_name: normalizedArgumentName,
    answer_format: `${normalizedArgumentName} = 正整数 | "${TARGET_COUNT_CANONICAL_ALL}"`,
    canonical_unlimited_value: TARGET_COUNT_CANONICAL_ALL,
    recommended_value: TARGET_COUNT_CANONICAL_ALL,
    recommended_argument_patch: clonedRecommendedPatch,
    accepted_examples: TARGET_COUNT_ACCEPTED_EXAMPLES.slice()
  };
  if (!includeOptions) return base;
  return {
    ...base,
    options: [
      {
        label: `扫到底（必须传 ${literal}，推荐）`,
        value: TARGET_COUNT_CANONICAL_ALL,
        canonical_value: TARGET_COUNT_CANONICAL_ALL,
        argument_patch: cloneForDiagnostics(clonedRecommendedPatch)
      },
      {
        label: `不限（等价于 ${literal}）`,
        value: "unlimited",
        canonical_value: TARGET_COUNT_CANONICAL_ALL,
        argument_patch: cloneForDiagnostics(clonedRecommendedPatch)
      },
      {
        label: `全部候选人（等价于 ${literal}）`,
        value: "全部候选人",
        canonical_value: TARGET_COUNT_CANONICAL_ALL,
        argument_patch: cloneForDiagnostics(clonedRecommendedPatch)
      },
      {
        label: `所有候选人（等价于 ${literal}）`,
        value: "所有候选人",
        canonical_value: TARGET_COUNT_CANONICAL_ALL,
        argument_patch: cloneForDiagnostics(clonedRecommendedPatch)
      }
    ]
  };
}

export function normalizeTargetCountInput(value) {
  if (value === undefined || value === null) {
    return {
      provided: false,
      targetCount: null,
      cliArg: null,
      publicValue: null,
      rawValue: value,
      parseError: null
    };
  }
  const unwrapped = getWrappedTargetCountValue(value);
  if (unwrapped !== value) {
    return normalizeTargetCountInput(unwrapped);
  }
  const raw = normalizeText(unwrapped);
  if (!raw) {
    return {
      provided: false,
      targetCount: null,
      cliArg: null,
      publicValue: null,
      rawValue: value,
      parseError: null
    };
  }
  if (isUnlimitedTargetCountToken(raw)) {
    return {
      provided: true,
      targetCount: null,
      cliArg: "-1",
      publicValue: TARGET_COUNT_CANONICAL_ALL,
      rawValue: cloneForDiagnostics(value),
      parseError: null
    };
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (Number.isFinite(parsed) && parsed === -1) {
    return {
      provided: true,
      targetCount: null,
      cliArg: "-1",
      publicValue: TARGET_COUNT_CANONICAL_ALL,
      rawValue: cloneForDiagnostics(value),
      parseError: null
    };
  }
  if (Number.isFinite(parsed) && parsed > 0) {
    return {
      provided: true,
      targetCount: parsed,
      cliArg: String(parsed),
      publicValue: parsed,
      rawValue: cloneForDiagnostics(value),
      parseError: null
    };
  }
  return {
    provided: false,
    targetCount: null,
    cliArg: null,
    publicValue: null,
    rawValue: cloneForDiagnostics(value),
    parseError: "target_count must be a positive integer, -1, or one of: all, unlimited, 全部, 不限, 扫到底, 全量, 全部候选人, 所有候选人"
  };
}
