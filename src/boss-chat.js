import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getScreenConfigResolution } from "./adapters.js";

const currentFilePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
const VENDORED_BOSS_CHAT_DIR = path.join(packageRoot, "vendor", "boss-chat-cli");
const DEFAULT_BOSS_CHAT_POLL_MS = 1500;
const PREPARE_BOSS_CHAT_MAX_ATTEMPTS = 3;
const PREPARE_BOSS_CHAT_RETRY_DELAY_MS = 1200;
const BOSS_CHAT_TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);
const CHAT_REQUIRED_FIELDS = ["job", "start_from", "target_count", "criteria"];
export const TARGET_COUNT_ACCEPTED_EXAMPLES = ["all", -1, 20, "全部候选人"];
const TARGET_COUNT_WRAPPER_KEYS = ["target_count", "targetCount", "value", "count", "limit"];

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function parsePositiveInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
      publicValue: "all",
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
      publicValue: "all",
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBossChatCliDir(workspaceRoot) {
  const localDir = path.join(path.resolve(String(workspaceRoot || process.cwd())), "boss-chat-cli");
  if (pathExists(localDir)) return localDir;
  return pathExists(VENDORED_BOSS_CHAT_DIR) ? VENDORED_BOSS_CHAT_DIR : null;
}

function resolveBossChatCliPath(workspaceRoot) {
  const cliDir = resolveBossChatCliDir(workspaceRoot);
  if (!cliDir) return null;
  const cliPath = path.join(cliDir, "src", "cli.js");
  return pathExists(cliPath) ? cliPath : null;
}

function validateRecommendScreenConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return {
      ok: false,
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
      message: `screening-config.json 缺少必填字段：${missing.join(", ")}。`
    };
  }
  if (/^replace-with/i.test(apiKey)) {
    return {
      ok: false,
      message: "screening-config.json 的 apiKey 仍是模板占位符，请填写真实 API Key。"
    };
  }
  return { ok: true };
}

function resolveBossChatScreenConfig(workspaceRoot) {
  const resolution = getScreenConfigResolution(workspaceRoot);
  const configPath = resolution.resolved_path || resolution.writable_path || resolution.legacy_path || null;
  if (!configPath || !pathExists(configPath)) {
    return {
      ok: false,
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: `screening-config.json 不存在。请先完成 recommend 配置。${configPath ? ` (path: ${configPath})` : ""}`
      },
      config_path: configPath,
      config_dir: configPath ? path.dirname(configPath) : null
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: `screening-config.json 解析失败：${error.message || "unknown error"} (path: ${configPath})`
      },
      config_path: configPath,
      config_dir: path.dirname(configPath)
    };
  }
  const validation = validateRecommendScreenConfig(parsed);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: `${validation.message} (path: ${configPath})`
      },
      config_path: configPath,
      config_dir: path.dirname(configPath)
    };
  }
  return {
    ok: true,
    config: {
      baseUrl: normalizeText(parsed.baseUrl).replace(/\/+$/, ""),
      apiKey: normalizeText(parsed.apiKey),
      model: normalizeText(parsed.model),
      debugPort: parsePositiveInteger(parsed.debugPort, 9222)
    },
    config_path: configPath,
    config_dir: path.dirname(configPath)
  };
}

function normalizeBossChatStartInput(input = {}) {
  const profile = normalizeText(input.profile) || "default";
  const job = normalizeText(input.job);
  const startFromRaw = normalizeText(input.startFrom || input.start_from).toLowerCase();
  const startFrom = startFromRaw === "all" ? "all" : startFromRaw === "unread" ? "unread" : "";
  const criteria = normalizeText(input.criteria);
  const parsedTarget = normalizeTargetCountInput(getBossChatTargetCountValue(input));
  const port = parsePositiveInteger(input.port);
  return {
    profile,
    job,
    startFrom,
    criteria,
    targetCount: parsedTarget.targetCount,
    targetCountArg: parsedTarget.cliArg,
    targetCountProvided: parsedTarget.provided,
    targetCountPublicValue: parsedTarget.publicValue,
    targetCountRawValue: parsedTarget.rawValue,
    targetCountParseError: parsedTarget.parseError,
    port,
    dryRun: input.dryRun === true || input.dry_run === true,
    noState: input.noState === true || input.no_state === true,
    safePacing: typeof input.safePacing === "boolean" ? input.safePacing : (
      typeof input.safe_pacing === "boolean" ? input.safe_pacing : undefined
    ),
    batchRestEnabled: typeof input.batchRestEnabled === "boolean" ? input.batchRestEnabled : (
      typeof input.batch_rest_enabled === "boolean" ? input.batch_rest_enabled : undefined
    )
  };
}

function normalizeBossChatRunId(input = {}) {
  return normalizeText(input.runId || input.run_id);
}

function getMissingBossChatStartFields(input = {}) {
  const normalized = normalizeBossChatStartInput(input);
  const missing = [];
  if (!normalized.job) missing.push("job");
  if (!normalized.startFrom) missing.push("start_from");
  if (!normalized.targetCountProvided) missing.push("target_count");
  if (!normalized.criteria) missing.push("criteria");
  return missing;
}

function buildTargetCountQuestionHint(item = {}) {
  const next = { ...item };
  next.question = "请输入 target_count：正整数，或 all（扫到底）。";
  next.options = [
    { label: "扫到底（推荐）", value: "all" },
    { label: "不限", value: "unlimited" },
    { label: "全部候选人", value: "全部候选人" },
    { label: "所有候选人", value: "所有候选人" }
  ];
  next.examples = TARGET_COUNT_ACCEPTED_EXAMPLES.slice();
  next.argument_name = "target_count";
  return next;
}

function normalizePendingQuestions(pendingQuestions = []) {
  return pendingQuestions.map((item) => {
    if (String(item?.field || "") !== "target_count") return item;
    return buildTargetCountQuestionHint(item);
  });
}

function buildNextCallExample(input = {}, missingFields = []) {
  if (!Array.isArray(missingFields) || missingFields.length === 0) return null;
  const normalized = normalizeBossChatStartInput(input);
  const sample = {};
  if (normalized.job) sample.job = normalized.job;
  if (normalized.startFrom) sample.start_from = normalized.startFrom;
  if (normalized.criteria) sample.criteria = normalized.criteria;
  if (normalized.targetCountProvided) {
    sample.target_count = normalized.targetCountPublicValue || (normalized.targetCountArg === "-1" ? "all" : normalized.targetCount);
  } else if (missingFields.includes("target_count")) {
    sample.target_count = "all";
  }
  return Object.keys(sample).length > 0 ? sample : null;
}

function buildTargetCountNeedInputDiagnostics(input = {}, missingFields = []) {
  if (!Array.isArray(missingFields) || !missingFields.includes("target_count")) return {};
  const normalized = normalizeBossChatStartInput(input);
  return {
    accepted_examples: TARGET_COUNT_ACCEPTED_EXAMPLES.slice(),
    ...(normalized.targetCountRawValue !== undefined ? { received_target_count: normalized.targetCountRawValue } : {}),
    ...(normalized.targetCountParseError ? { target_count_parse_error: normalized.targetCountParseError } : {})
  };
}

function buildBossChatCliArgs(command, input, resolvedConfig) {
  const args = [command, "--json"];
  if (command === "prepare-run") {
    const normalized = normalizeBossChatStartInput(input);
    args.push("--profile", normalized.profile);
    if (normalized.job) args.push("--job", normalized.job);
    if (normalized.startFrom) args.push("--start-from", normalized.startFrom);
    if (normalized.criteria) args.push("--criteria", normalized.criteria);
    if (normalized.targetCountArg) args.push("--targetCount", normalized.targetCountArg);
    args.push("--port", String(normalized.port || resolvedConfig.debugPort || 9222));
    args.push("--baseurl", resolvedConfig.baseUrl);
    args.push("--apikey", resolvedConfig.apiKey);
    args.push("--model", resolvedConfig.model);
    return args;
  }

  if (command === "start-run") {
    const normalized = normalizeBossChatStartInput(input);
    args.push("--profile", normalized.profile);
    if (normalized.dryRun) args.push("--dry-run");
    if (normalized.noState) args.push("--no-state");
    args.push("--job", normalized.job);
    args.push("--start-from", normalized.startFrom);
    args.push("--criteria", normalized.criteria);
    if (normalized.targetCountArg) {
      args.push("--targetCount", normalized.targetCountArg);
    }
    args.push("--baseurl", resolvedConfig.baseUrl);
    args.push("--apikey", resolvedConfig.apiKey);
    args.push("--model", resolvedConfig.model);
    args.push("--port", String(normalized.port || resolvedConfig.debugPort || 9222));
    if (typeof normalized.safePacing === "boolean") {
      args.push("--safe-pacing", String(normalized.safePacing));
    }
    if (typeof normalized.batchRestEnabled === "boolean") {
      args.push("--batch-rest", String(normalized.batchRestEnabled));
    }
    return args;
  }

  const runId = normalizeBossChatRunId(input);
  args.push("--profile", normalizeText(input.profile) || "default");
  args.push("--run-id", runId);
  return args;
}

async function spawnBossChatCli({ workspaceRoot, command, input = {} }) {
  const cliPath = resolveBossChatCliPath(workspaceRoot);
  if (!cliPath) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: "",
      payload: {
        status: "FAILED",
        error: {
          code: "BOSS_CHAT_CLI_MISSING",
          message: "未找到 vendored boss-chat CLI。"
        }
      }
    };
  }

  let configResolution = null;
  if (command === "start-run" || command === "prepare-run") {
    configResolution = resolveBossChatScreenConfig(workspaceRoot);
    if (!configResolution.ok) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        payload: {
          status: "FAILED",
          error: configResolution.error,
          config_path: configResolution.config_path,
          config_dir: configResolution.config_dir
        }
      };
    }
  }

  const args = [cliPath, ...buildBossChatCliArgs(command, input, configResolution?.config || {})];
  const cwd = path.resolve(String(workspaceRoot || process.cwd()));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr,
        payload: {
          status: "FAILED",
          error: {
            code: "BOSS_CHAT_CLI_SPAWN_FAILED",
            message: error?.message || "无法启动 vendored boss-chat CLI。"
          }
        }
      });
    });
    child.on("close", (code) => {
      const parsed = parseJsonOutput(stdout) || parseJsonOutput(stderr);
      if (parsed && typeof parsed === "object") {
        resolve({
          ok: Number(code) === 0 && String(parsed.status || "").toUpperCase() !== "FAILED",
          exitCode: Number.isInteger(code) ? code : 1,
          stdout,
          stderr,
          payload: parsed
        });
        return;
      }
      resolve({
        ok: Number(code) === 0,
        exitCode: Number.isInteger(code) ? code : 1,
        stdout,
        stderr,
        payload: Number(code) === 0
          ? {
              status: "OK",
              message: normalizeText(stdout) || `${command} 执行成功。`
            }
          : {
              status: "FAILED",
              error: {
                code: "BOSS_CHAT_CLI_EXECUTION_FAILED",
                message: normalizeText(stderr || stdout) || `${command} 执行失败。`
              }
            }
      });
    });
  });
}

export function getBossChatHealthCheck(workspaceRoot, input = {}) {
  const cliDir = resolveBossChatCliDir(workspaceRoot);
  const cliPath = resolveBossChatCliPath(workspaceRoot);
  const configResolution = resolveBossChatScreenConfig(workspaceRoot);
  const resolvedPort = parsePositiveInteger(input.port)
    || (configResolution.ok ? configResolution.config.debugPort : 9222);
  if (!cliDir || !cliPath) {
    return {
      status: "FAILED",
      error: {
        code: "BOSS_CHAT_CLI_MISSING",
        message: "未找到 vendored boss-chat CLI。"
      }
    };
  }
  if (!configResolution.ok) {
    return {
      status: "FAILED",
      error: configResolution.error,
      config_path: configResolution.config_path,
      config_dir: configResolution.config_dir,
      cli_dir: cliDir,
      cli_path: cliPath
    };
  }
  return {
    status: "OK",
    server: "boss-chat",
    cli_dir: cliDir,
    cli_path: cliPath,
    config_path: configResolution.config_path,
    debug_port: resolvedPort,
    shared_llm_config: true
  };
}

export async function startBossChatRun({ workspaceRoot, input = {} }) {
  const missingFields = getMissingBossChatStartFields(input);
  if (missingFields.length > 0) {
    const prepared = await prepareBossChatRun({ workspaceRoot, input });
    if (prepared?.status === "FAILED") return prepared;
    const pendingQuestions = Array.isArray(prepared?.pending_questions)
      ? prepared.pending_questions.filter((item) => missingFields.includes(String(item?.field || "")))
      : [];
    const normalizedPendingQuestions = normalizePendingQuestions(pendingQuestions);
    const nextCallExample = buildNextCallExample(input, missingFields);
    const targetCountDiagnostics = buildTargetCountNeedInputDiagnostics(input, missingFields);
    return {
      ...prepared,
      status: "NEED_INPUT",
      required_fields: CHAT_REQUIRED_FIELDS.slice(),
      missing_fields: missingFields,
      pending_questions: normalizedPendingQuestions,
      ...targetCountDiagnostics,
      ...(nextCallExample ? { next_call_example: nextCallExample } : {}),
      message: prepared?.message
        || "已获取 Boss 聊天页岗位列表，请先补齐 job / start_from / target_count / criteria。"
    };
  }
  return (await spawnBossChatCli({ workspaceRoot, command: "start-run", input })).payload;
}

export async function prepareBossChatRun({ workspaceRoot, input = {} }) {
  let payload = null;
  for (let attempt = 1; attempt <= PREPARE_BOSS_CHAT_MAX_ATTEMPTS; attempt += 1) {
    payload = (await spawnBossChatCli({ workspaceRoot, command: "prepare-run", input })).payload;
    if (payload?.status !== "FAILED") break;
    if (attempt >= PREPARE_BOSS_CHAT_MAX_ATTEMPTS) break;
    await sleep(PREPARE_BOSS_CHAT_RETRY_DELAY_MS);
  }

  if (payload?.status !== "NEED_INPUT") return payload;

  const missingFields = getMissingBossChatStartFields(input);
  const pendingQuestions = Array.isArray(payload?.pending_questions)
    ? payload.pending_questions.filter((item) => (
      missingFields.length === 0 || missingFields.includes(String(item?.field || ""))
    ))
    : [];
  const nextCallExample = buildNextCallExample(input, missingFields);
  const targetCountDiagnostics = buildTargetCountNeedInputDiagnostics(input, missingFields);
  return {
    ...payload,
    required_fields: CHAT_REQUIRED_FIELDS.slice(),
    missing_fields: missingFields,
    pending_questions: normalizePendingQuestions(pendingQuestions),
    ...targetCountDiagnostics,
    ...(nextCallExample ? { next_call_example: nextCallExample } : {})
  };
}

export async function getBossChatRun({ workspaceRoot, input = {} }) {
  return (await spawnBossChatCli({ workspaceRoot, command: "get-run", input })).payload;
}

export async function pauseBossChatRun({ workspaceRoot, input = {} }) {
  return (await spawnBossChatCli({ workspaceRoot, command: "pause-run", input })).payload;
}

export async function resumeBossChatRun({ workspaceRoot, input = {} }) {
  return (await spawnBossChatCli({ workspaceRoot, command: "resume-run", input })).payload;
}

export async function cancelBossChatRun({ workspaceRoot, input = {} }) {
  return (await spawnBossChatCli({ workspaceRoot, command: "cancel-run", input })).payload;
}

export async function runBossChatSync({ workspaceRoot, input = {}, pollMs = DEFAULT_BOSS_CHAT_POLL_MS }) {
  const accepted = await startBossChatRun({ workspaceRoot, input });
  if (accepted?.status !== "ACCEPTED" || !normalizeText(accepted.run_id)) {
    return accepted;
  }
  const runId = normalizeText(accepted.run_id);
  while (true) {
    await sleep(pollMs);
    const statusPayload = await getBossChatRun({
      workspaceRoot,
      input: {
        profile: input.profile,
        runId
      }
    });
    const runState = normalizeText(statusPayload?.run?.state).toLowerCase();
    if (BOSS_CHAT_TERMINAL_STATES.has(runState)) {
      return statusPayload;
    }
  }
}
