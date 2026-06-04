import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  getFeaturedCalibrationResolution,
  getBossChatTargetCountValue,
  normalizeTargetCountInput,
  resolveBossScreeningConfig
} from "./chat-runtime-config.js";
import {
  __resetChatMcpStateForTests,
  __setChatMcpConnectorForTests,
  __setChatMcpJobReaderForTests,
  __setChatMcpWorkflowForTests,
  bossChatHealthCheckTool,
  cancelBossChatRunTool,
  getBossChatRunTool,
  pauseBossChatRunTool,
  prepareBossChatRunTool,
  resumeBossChatRunTool,
  startBossChatDetachedRunTool,
  startBossChatRunTool
} from "./chat-mcp.js";
import {
  __resetRecruitMcpStateForTests,
  __setRecruitMcpConnectorForTests,
  __setRecruitMcpWorkflowForTests,
  cancelRecruitPipelineRunTool,
  createRecruitPipelineInputSchema,
  createRecruitRunIdInputSchema,
  getRecruitPipelineRunTool,
  pauseRecruitPipelineRunTool,
  resumeRecruitPipelineRunTool,
  runRecruitPipelineTool,
  startRecruitPipelineDetachedRunTool,
  startRecruitPipelineRunTool,
  validateRecruitPipelineArgs
} from "./recruit-mcp.js";
import {
  __setRecommendSchedulerSpawnForTests,
  getRecommendScheduledRunTool,
  runScheduledRecommendWorker,
  scheduleRecommendPipelineRunTool
} from "./recommend-scheduler.js";
import {
  __resetRecommendMcpStateForTests,
  __setRecommendMcpConnectorForTests,
  __setRecommendMcpJobReaderForTests,
  __setRecommendMcpWorkflowForTests,
  cancelRecommendPipelineRunTool,
  getRecommendPipelineRunTool,
  listRecommendJobsTool,
  pauseRecommendPipelineRunTool,
  prepareRecommendPipelineRunTool,
  resumeRecommendPipelineRunTool,
  startRecommendPipelineRunTool
} from "./recommend-mcp.js";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
  sleep as sleepMs
} from "./core/browser/index.js";
import {
  buildRecommendSelfHealConfig,
  HEALTH_STATUS,
  resolveRecommendSelfHealRoots,
  runSelfHealCheck
} from "./core/self-heal/index.js";
import {
  RUN_MODE_ASYNC,
  RUN_STAGE_CHAT_FOLLOWUP,
  RUN_STAGE_PREFLIGHT,
  RUN_STATE_CANCELED,
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED,
  RUN_STATE_PAUSED,
  RUN_STATE_RUNNING,
  cleanupExpiredRuns,
  createRunId,
  createRunStateSnapshot,
  getRunHeartbeatIntervalMs,
  getRunsDir,
  readRunState,
  touchRunHeartbeat,
  updateRunProgress,
  updateRunState,
  writeRunState
} from "./run-state.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json");

const TOOL_PREPARE_RUN = "prepare_recommend_pipeline_run";
const TOOL_SCHEDULE_RUN = "schedule_recommend_pipeline_run";
const TOOL_GET_SCHEDULED_RUN = "get_recommend_scheduled_run";
const TOOL_RUN_RECOMMEND = "run_recommend";
const TOOL_START_RUN = "start_recommend_pipeline_run";
const TOOL_GET_RUN = "get_recommend_pipeline_run";
const TOOL_CANCEL_RUN = "cancel_recommend_pipeline_run";
const TOOL_PAUSE_RUN = "pause_recommend_pipeline_run";
const TOOL_RESUME_RUN = "resume_recommend_pipeline_run";
const TOOL_LIST_RECOMMEND_JOBS = "list_recommend_jobs";
const TOOL_RUN_FEATURED_CALIBRATION = "run_featured_calibration";
const TOOL_GET_FEATURED_CALIBRATION_STATUS = "get_featured_calibration_status";
const TOOL_RUN_RECOMMEND_SELF_HEAL = "run_recommend_self_heal";
const TOOL_BOSS_CHAT_HEALTH_CHECK = "boss_chat_health_check";
const TOOL_BOSS_CHAT_PREPARE_RUN = "prepare_boss_chat_run";
const TOOL_BOSS_CHAT_START_RUN = "start_boss_chat_run";
const TOOL_BOSS_CHAT_GET_RUN = "get_boss_chat_run";
const TOOL_BOSS_CHAT_PAUSE_RUN = "pause_boss_chat_run";
const TOOL_BOSS_CHAT_RESUME_RUN = "resume_boss_chat_run";
const TOOL_BOSS_CHAT_CANCEL_RUN = "cancel_boss_chat_run";
const TOOL_RUN_RECRUIT_PIPELINE = "run_recruit_pipeline";
const TOOL_START_RECRUIT_PIPELINE_RUN = "start_recruit_pipeline_run";
const TOOL_GET_RECRUIT_PIPELINE_RUN = "get_recruit_pipeline_run";
const TOOL_CANCEL_RECRUIT_PIPELINE_RUN = "cancel_recruit_pipeline_run";
const TOOL_PAUSE_RECRUIT_PIPELINE_RUN = "pause_recruit_pipeline_run";
const TOOL_RESUME_RECRUIT_PIPELINE_RUN = "resume_recruit_pipeline_run";

const SERVER_NAME = "boss-recommend-mcp";
const FRAMING_UNKNOWN = "unknown";
const FRAMING_HEADER = "header";
const FRAMING_LINE = "line";
const DETACHED_WORKER_FLAG = "--detached-worker";
const DETACHED_WORKER_RUN_ID_FLAG = "--run-id";
const DETACHED_WORKER_RESUME_FLAG = "--resume";
const AGENT_RUNTIME_HINT_KEYS = [
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "CODEX_HOME",
  "OPENCLAW_HOME",
  "OPENCLAW",
  "TRAE_CN",
  "TRAE_HOME",
  "TRAE_AGENT"
];
const featuredCalibrationUnsupportedCode = "FEATURED_CALIBRATION_UNSUPPORTED_CDP_ONLY";
const recommendSelfHealApplyUnsupportedCode = "RECOMMEND_SELF_HEAL_APPLY_UNSUPPORTED_CDP_ONLY";
const detachedLegacyPipelineUnsupportedCode = "DETACHED_LEGACY_PIPELINE_UNSUPPORTED_CDP_ONLY";
const recommendTargetUrl = "https://www.zhipin.com/web/chat/recommend";

let runPipelineImpl = null;
let runSelfHealImpl = null;
let spawnProcessImpl = spawn;
let forceChatInProcForTests = false;
let forceRecruitInProcForTests = false;
const TERMINAL_RUN_STATES = new Set([RUN_STATE_COMPLETED, RUN_STATE_FAILED, RUN_STATE_CANCELED]);

async function getRunPipelineImpl() {
  if (typeof runPipelineImpl === "function") return runPipelineImpl;
  const error = new Error("Detached legacy recommend workers are fenced during the CDP-only rewrite. Active recommend execution must use start_recommend_pipeline_run, which routes through the shared CDP-only recommend run service.");
  error.code = detachedLegacyPipelineUnsupportedCode;
  error.retryable = false;
  throw error;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clonePlain(value, fallback = null) {
  try {
    return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function hasAgentPathHint(value = "") {
  const hint = normalizeText(value).toLowerCase();
  return /(^|[/\\])\.(openclaw|codex)([/\\]|$)|qclaw|openclaw|codex|trae/.test(hint);
}

function isLikelyAgentRuntime({ workspaceRoot = "" } = {}) {
  for (const key of AGENT_RUNTIME_HINT_KEYS) {
    if (normalizeText(process.env[key] || "")) return true;
  }
  const originHints = [
    normalizeText(process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || ""),
    normalizeText(process.env.TERM_PROGRAM || "")
  ].join(" ").toLowerCase();
  if (/codex|openclaw|trae/.test(originHints)) return true;
  return [
    workspaceRoot,
    process.env.BOSS_WORKSPACE_ROOT || "",
    process.env.PWD || "",
    process.cwd()
  ].some(hasAgentPathHint);
}

function shouldStartRecommendDetached({ workspaceRoot = "" } = {}) {
  if (normalizeText(process.env.BOSS_RECOMMEND_CDP_INPROC || "") === "1") return false;
  if (normalizeText(process.env.BOSS_RECOMMEND_CDP_DETACHED || "") === "1") return true;
  return isLikelyAgentRuntime({ workspaceRoot });
}

function shouldStartChatDetached({ workspaceRoot = "" } = {}) {
  if (forceChatInProcForTests) return false;
  if (normalizeText(process.env.BOSS_CHAT_CDP_INPROC || "") === "1") return false;
  if (normalizeText(process.env.BOSS_CHAT_CDP_DETACHED || "") === "1") return true;
  return isLikelyAgentRuntime({ workspaceRoot });
}

function shouldStartRecruitDetached({ workspaceRoot = "" } = {}) {
  if (forceRecruitInProcForTests) return false;
  if (normalizeText(process.env.BOSS_RECRUIT_CDP_INPROC || "") === "1") return false;
  if (normalizeText(process.env.BOSS_RECRUIT_CDP_DETACHED || "") === "1") return true;
  return isLikelyAgentRuntime({ workspaceRoot });
}

function isUnlimitedTargetCountToken(value) {
  const token = normalizeText(value).toLowerCase();
  if (!token) return false;
  const compact = token.replace(/\s+/g, "");
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
  if (knownTokens.has(token) || knownTokens.has(compact)) return true;
  if (/^(?:all|unlimited|infinity|inf|max|full)(?:candidate|candidates)?$/i.test(compact)) return true;
  if (/^(?:全部|所有|全量|不限)(?:候选人|人选|牛人|人才|人员)?$/u.test(compact)) return true;
  return false;
}

function parsePositiveInteger(raw, fallback) {
  const value = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getDefaultPollAfterSec() {
  const fromEnv = parsePositiveInteger(process.env.BOSS_RECOMMEND_POLL_AFTER_SEC, 1800);
  return Math.max(60, fromEnv);
}

function getLongRunPollAfterSec() {
  const fromEnv = parsePositiveInteger(process.env.BOSS_RECOMMEND_LONG_POLL_AFTER_SEC, 1800);
  return Math.max(60, fromEnv);
}

function createTargetCountInputSchema(description) {
  return {
    oneOf: [
      {
        type: "integer",
        minimum: 1
      },
      {
        type: "integer",
        enum: [-1]
      },
      {
        type: "string",
        enum: ["all", "unlimited", "-1", "全部", "不限", "扫到底", "全量", "全部候选人", "所有候选人"]
      },
      {
        type: "object",
        properties: {
          value: {
            oneOf: [
              { type: "integer", minimum: 1 },
              { type: "integer", enum: [-1] },
              { type: "string" }
            ]
          },
          target_count: {
            oneOf: [
              { type: "integer", minimum: 1 },
              { type: "integer", enum: [-1] },
              { type: "string" }
            ]
          },
          targetCount: {
            oneOf: [
              { type: "integer", minimum: 1 },
              { type: "integer", enum: [-1] },
              { type: "string" }
            ]
          }
        },
        additionalProperties: true
      }
    ],
    description: `${description} 若用户选择扫到底/不限/全部候选人，优先字面传 "all"。`,
    examples: ["all", 20, { value: "all" }]
  };
}

function createHumanBehaviorInputSchema(description = "可选，启用可靠性实验用的人类节奏配置；默认 paced_with_rests/on") {
  return {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      profile: {
        type: "string",
        enum: ["baseline", "paced", "paced_with_rests"]
      },
      clickMovement: { type: "boolean" },
      textEntry: { type: "boolean" },
      listScrollJitter: { type: "boolean" },
      shortRest: { type: "boolean" },
      batchRest: { type: "boolean" },
      actionCooldown: { type: "boolean" },
      restLevel: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "本次 run 的休息强度：low 保持旧策略；medium 约 5 小时/700 人累计休息 30 分钟；high 约 5 小时/700 人累计休息 1 小时"
      },
      rest_level: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "兼容字段；优先使用 restLevel"
      }
    },
    additionalProperties: false,
    description
  };
}

function getRecommendedPollAfterSec(args = {}) {
  return hasFollowUpChatRequest(args)
    ? getLongRunPollAfterSec()
    : getDefaultPollAfterSec();
}

function hasFollowUpChatRequest(args = {}) {
  const directChat = args?.follow_up?.chat && typeof args.follow_up.chat === "object"
    ? args.follow_up.chat
    : null;
  const overrideChat = args?.overrides?.follow_up?.chat && typeof args.overrides.follow_up.chat === "object"
    ? args.overrides.follow_up.chat
    : null;
  return Boolean(directChat || overrideChat);
}

function getDefaultAcceptedMessage(args = {}) {
  if (hasFollowUpChatRequest(args)) {
    return "异步流水线已启动（detached）。recommend+chat 联动任务可能耗时较长，默认建议至少每 30 分钟查询一次 get_recommend_pipeline_run；若手动查询时已完成，将立即进入聊天衔接。";
  }
  const fromEnv = parsePositiveInteger(process.env.BOSS_RECOMMEND_POLL_AFTER_SEC, 1800);
  const recommendedSeconds = Math.max(60, fromEnv);
  const recommendedMinutes = Math.max(1, Math.round(recommendedSeconds / 60));
  return `异步流水线已启动（detached）。默认不自动轮询；如需进度请按需调用 get_recommend_pipeline_run（建议至少每 ${recommendedMinutes} 分钟查询一次）。`;
}

function getRunArtifacts(runId) {
  const normalizedRunId = normalizeText(runId);
  return {
    run_state_path: path.join(getRunsDir(), `${normalizedRunId}.json`),
    checkpoint_path: path.join(getRunsDir(), `${normalizedRunId}.checkpoint.json`),
    worker_stdout_path: path.join(getRunsDir(), `${normalizedRunId}.worker.stdout.log`),
    worker_stderr_path: path.join(getRunsDir(), `${normalizedRunId}.worker.stderr.log`)
  };
}

function writeRawRunState(runId, payload) {
  const artifacts = getRunArtifacts(runId);
  fs.mkdirSync(path.dirname(artifacts.run_state_path), { recursive: true });
  const tempPath = `${artifacts.run_state_path}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, artifacts.run_state_path);
  return payload;
}

function readRawRunState(runId) {
  const artifacts = getRunArtifacts(runId);
  try {
    const parsed = JSON.parse(fs.readFileSync(artifacts.run_state_path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function patchRawRunState(runId, patch) {
  const current = readRawRunState(runId);
  if (!current) return null;
  const now = new Date().toISOString();
  const next = {
    ...current,
    ...patch,
    run_id: current.run_id || runId,
    updated_at: now,
    heartbeat_at: current.heartbeat_at || now,
    control: {
      ...(current.control || {}),
      ...(patch.control || {})
    },
    resume: {
      ...(current.resume || {}),
      ...(patch.resume || {})
    }
  };
  return writeRawRunState(runId, next);
}

function createDetachedRecommendRunId() {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `mcp_recommend_${Date.now().toString(36)}_${suffix}`;
}

function buildRunContext(workspaceRoot, args = {}) {
  const clonedArgs = clonePlain(args, {});
  return {
    workspace_root: path.resolve(workspaceRoot),
    args: clonedArgs,
    instruction: String(args?.instruction || ""),
    confirmation: args?.confirmation && typeof args.confirmation === "object" ? args.confirmation : {},
    overrides: args?.overrides && typeof args.overrides === "object" ? args.overrides : {},
    follow_up: args?.follow_up && typeof args.follow_up === "object" ? args.follow_up : null
  };
}

function resolveRunContext(snapshot) {
  const workspaceRoot = normalizeText(snapshot?.context?.workspace_root || "");
  const storedArgs = snapshot?.context?.args && typeof snapshot.context.args === "object" && !Array.isArray(snapshot.context.args)
    ? clonePlain(snapshot.context.args, {})
    : null;
  const instruction = typeof storedArgs?.instruction === "string"
    ? storedArgs.instruction
    : typeof snapshot?.context?.instruction === "string"
      ? snapshot.context.instruction
      : "";
  const confirmation = storedArgs?.confirmation && typeof storedArgs.confirmation === "object" && !Array.isArray(storedArgs.confirmation)
    ? storedArgs.confirmation
    : snapshot?.context?.confirmation && typeof snapshot.context.confirmation === "object"
      ? snapshot.context.confirmation
      : {};
  const overrides = storedArgs?.overrides && typeof storedArgs.overrides === "object" && !Array.isArray(storedArgs.overrides)
    ? storedArgs.overrides
    : snapshot?.context?.overrides && typeof snapshot.context.overrides === "object"
      ? snapshot.context.overrides
      : {};
  const followUp = storedArgs && Object.prototype.hasOwnProperty.call(storedArgs, "follow_up")
    ? storedArgs.follow_up
    : snapshot?.context?.follow_up && typeof snapshot.context.follow_up === "object"
      ? snapshot.context.follow_up
      : null;
  if (!workspaceRoot || !instruction.trim()) return null;
  return {
    workspaceRoot,
    args: {
      ...(storedArgs || {}),
      instruction,
      confirmation,
      overrides,
      follow_up: followUp
    }
  };
}

function isRunPauseRequested(runId) {
  const snapshot = readRunState(runId);
  return snapshot?.control?.pause_requested === true;
}

function isRunCancelRequested(runId) {
  const snapshot = readRunState(runId);
  return snapshot?.control?.cancel_requested === true;
}

function getOutputCsvFromResult(result) {
  const direct = normalizeText(result?.result?.output_csv || "");
  if (direct) return direct;
  const partial = normalizeText(result?.partial_result?.output_csv || "");
  if (partial) return partial;
  return null;
}

function getCompletionReasonFromResult(result) {
  const direct = normalizeText(result?.result?.completion_reason || "");
  if (direct) return direct;
  const partial = normalizeText(result?.partial_result?.completion_reason || "");
  if (partial) return partial;
  return null;
}

function writeMessage(message, framing = FRAMING_LINE) {
  const body = JSON.stringify(message);
  if (framing === FRAMING_HEADER) {
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    process.stdout.write(header + body);
    return;
  }
  process.stdout.write(`${body}\n`);
}

function createJsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  };
}

function createRunInputSchema() {
  return {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description: "用户自然语言推荐筛选指令"
      },
      confirmation: {
        type: "object",
        description: "推荐页确认状态。新流程推荐只在用户看过总览后传 final_confirmed=true；逐字段 *_confirmed 为兼容旧调用保留。",
        properties: {
          page_confirmed: { type: "boolean" },
          page_value: {
            type: "string",
            enum: ["recommend", "featured", "latest"]
          },
          filters_confirmed: { type: "boolean" },
          school_tag_confirmed: { type: "boolean" },
          school_tag_value: {
            oneOf: [
              {
                type: "string",
                enum: ["不限", "985", "211", "双一流院校", "留学", "国内外名校", "公办本科"]
              },
              {
                type: "array",
                items: {
                  type: "string",
                  enum: ["不限", "985", "211", "双一流院校", "留学", "国内外名校", "公办本科"]
                },
                minItems: 1,
                uniqueItems: true
              }
            ]
          },
          degree_confirmed: { type: "boolean" },
          degree_value: {
            oneOf: [
              {
                type: "string",
                enum: ["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]
              },
              {
                type: "array",
                items: {
                  type: "string",
                  enum: ["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]
                },
                minItems: 1,
                uniqueItems: true
              }
            ]
          },
          gender_confirmed: { type: "boolean" },
          gender_value: {
            type: "string",
            enum: ["不限", "男", "女"]
          },
          recent_not_view_confirmed: { type: "boolean" },
          recent_not_view_value: {
            type: "string",
            enum: ["不限", "近14天没有"]
          },
          criteria_confirmed: { type: "boolean" },
          target_count_confirmed: { type: "boolean" },
          target_count_value: {
            type: "integer",
            minimum: 1
          },
          post_action_confirmed: { type: "boolean" },
          post_action_value: {
            type: "string",
            enum: ["greet", "none"]
          },
          final_confirmed: {
            type: "boolean",
            description: "用户已确认包含岗位、筛选项、criteria、目标、动作、可选最大招呼数和 restLevel 的总览。"
          },
          job_confirmed: { type: "boolean" },
          job_value: { type: "string" },
          max_greet_count_confirmed: { type: "boolean" },
          max_greet_count_value: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: false
      },
      overrides: {
        type: "object",
        properties: {
          page_scope: {
            type: "string",
            enum: ["recommend", "featured", "latest"]
          },
          school_tag: {
            oneOf: [
              {
                type: "string",
                enum: ["不限", "985", "211", "双一流院校", "留学", "国内外名校", "公办本科"]
              },
              {
                type: "array",
                items: {
                  type: "string",
                  enum: ["不限", "985", "211", "双一流院校", "留学", "国内外名校", "公办本科"]
                },
                minItems: 1,
                uniqueItems: true
              }
            ]
          },
          degree: {
            oneOf: [
              {
                type: "string",
                enum: ["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]
              },
              {
                type: "array",
                items: {
                  type: "string",
                  enum: ["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]
                },
                minItems: 1,
                uniqueItems: true
              }
            ]
          },
          gender: {
            type: "string",
            enum: ["不限", "男", "女"]
          },
          recent_not_view: {
            type: "string",
            enum: ["不限", "近14天没有"]
          },
          criteria: { type: "string" },
          job: { type: "string" },
          target_count: { type: "integer", minimum: 1 },
          max_greet_count: { type: "integer", minimum: 1 },
          post_action: {
            type: "string",
            enum: ["greet", "none"]
          }
        },
        additionalProperties: false
      },
      follow_up: {
        type: "object",
        properties: {
          chat: {
            type: "object",
            properties: {
              profile: { type: "string" },
              criteria: { type: "string" },
              start_from: {
                type: "string",
                enum: ["unread", "all"]
              },
              greeting_text: {
                type: "string",
                description: "可选，首条打招呼消息；未传时按 profile 历史值/默认值自动回退"
              },
              greetingText: {
                type: "string",
                description: "兼容字段；优先使用 greeting_text。可选首条打招呼消息"
              },
              target_count: createTargetCountInputSchema("boss-chat follow-up 本次处理人数上限；支持正整数、all 或 -1（扫到底）"),
              dry_run: { type: "boolean" },
              no_state: { type: "boolean" },
              human_behavior: createHumanBehaviorInputSchema("可选，follow-up chat 节奏配置；默认 paced_with_rests/on"),
              humanBehavior: createHumanBehaviorInputSchema("兼容字段；优先使用 human_behavior"),
              human_behavior_enabled: { type: "boolean" },
              human_behavior_profile: {
                type: "string",
                enum: ["baseline", "paced", "paced_with_rests"]
              },
              safe_pacing: { type: "boolean" },
              batch_rest_enabled: { type: "boolean" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      },
      host: {
        type: "string",
        description: "可选，Chrome 调试 host；默认 127.0.0.1"
      },
      port: {
        type: "integer",
        minimum: 1,
        description: "可选，Chrome 调试端口；默认 9222"
      },
      target_url_includes: {
        type: "string",
        description: "可选，Chrome target URL 匹配片段；默认 Boss recommend 页"
      },
      allow_navigate: {
        type: "boolean",
        description: "可选，未在 recommend 页时允许通过 Page.navigate 切换；默认 true"
      },
      slow_live: {
        type: "boolean",
        description: "可选，VPN/慢页面 live 测试模式，放宽等待时间"
      },
      human_behavior: createHumanBehaviorInputSchema("recommend 运行必须显式包含本次用户确认的 restLevel: low|medium|high；其他节奏配置可选"),
      humanBehavior: createHumanBehaviorInputSchema("兼容字段；优先使用 human_behavior；recommend 运行同样必须显式包含 restLevel"),
      human_behavior_enabled: {
        type: "boolean",
        description: "兼容字段；true 等同启用 paced 默认配置，false 等同 baseline"
      },
      human_behavior_profile: {
        type: "string",
        enum: ["baseline", "paced", "paced_with_rests"],
        description: "可选实验 profile：baseline/paced/paced_with_rests"
      },
      safe_pacing: {
        type: "boolean",
        description: "兼容字段；true 启用 paced，false 关闭"
      },
      batch_rest_enabled: {
        type: "boolean",
        description: "兼容字段；true 启用 paced_with_rests 的候选人短休/批次休息"
      },
      max_candidates: createTargetCountInputSchema("本次最多处理候选人数；默认使用确认后的 target_count，未设置时为 5"),
      detail_limit: {
        type: "integer",
        minimum: 0,
        description: "打开详情/CV 的人数上限；默认跟随 target_count/max_candidates。生产筛选不应传 0；detail_limit=0 需要 debug_test_mode=true 且 allow_card_only_screening=true"
      },
      allow_card_only_screening: {
        type: "boolean",
        description: "高级调试开关；默认 false。只有同时显式 debug_test_mode=true 时，recommend 才会尊重 detail_limit=0"
      },
      debug_test_mode: {
        type: "boolean",
        description: "高级测试开关；默认 false。只有显式为 true 时才允许 deterministic/local scorer、跳过筛选器、card-only、dry-run 后置动作等调试路径"
      },
      screening_mode: {
        type: "string",
        enum: ["llm", "deterministic"],
        description: "筛选引擎；默认 llm。deterministic 仅限 debug_test_mode=true 的明确测试场景"
      },
      use_llm: {
        type: "boolean",
        description: "兼容字段；默认 true。use_llm=false 等同 deterministic，仅限 debug_test_mode=true"
      },
      llm_timeout_ms: {
        type: "integer",
        minimum: 1000,
        description: "可选，单个候选人的 LLM 调用超时"
      },
      llm_image_limit: {
        type: "integer",
        minimum: 1,
        description: "可选，传给 LLM 的图片简历截图页数上限"
      },
      llm_image_detail: {
        type: "string",
        description: "可选，图片输入 detail，默认 low"
      },
      delay_ms: {
        type: "integer",
        minimum: 0,
        description: "候选人之间的延迟；live pause/resume 测试可增大它"
      },
      execute_post_action: {
        type: "boolean",
        description: "可选，是否实际执行通过后的 recommend 后置动作 greet；默认 true"
      },
      dry_run_post_action: {
        type: "boolean",
        description: "可选，只验证 recommend 打招呼动作发现/配额/可点击路径，不实际点击"
      },
      action_timeout_ms: {
        type: "integer",
        minimum: 1000,
        description: "可选，等待详情页 greet 控件出现的超时时间"
      },
      action_interval_ms: {
        type: "integer",
        minimum: 100,
        description: "可选，轮询详情页 greet 控件的间隔"
      },
      action_after_click_delay_ms: {
        type: "integer",
        minimum: 0,
        description: "可选，点击 greet 后等待页面状态稳定的时间"
      },
      no_filter: {
        type: "boolean",
        description: "开发/live gate 专用：跳过本次筛选器点击，默认 false；正式 run 需要 debug_test_mode=true 才允许"
      },
      filter_enabled: {
        type: "boolean",
        description: "开发/live gate 专用：false 时跳过本次筛选器点击；正式 run 需要 debug_test_mode=true 才允许"
      },
      refresh_on_end: {
        type: "boolean",
        description: "列表到底且目标数未达成时是否刷新/重新应用筛选；默认 true"
      },
      max_refresh_rounds: {
        type: "integer",
        minimum: 0,
        description: "列表到底后的最大刷新轮数；默认 2"
      }
    },
    required: ["instruction"],
    additionalProperties: false
  };
}

function createBossChatStartInputSchema({ requireFullInput = false } = {}) {
  const schema = {
    type: "object",
    properties: {
      profile: {
        type: "string",
        description: "可选，boss-chat profile 名称，默认 default"
      },
      job: {
        type: "string",
        description: "岗位，支持岗位名/编号/value"
      },
      start_from: {
        type: "string",
        enum: ["unread", "all"],
        description: "从未读或全部聊天列表开始"
      },
      criteria: {
        type: "string",
        description: "boss-chat 的筛选 criteria"
      },
      greeting_text: {
        type: "string",
        description: "可选，首条打招呼消息；未传时按 profile 历史值/默认值自动回退"
      },
      greetingText: {
        type: "string",
        description: "兼容字段；优先使用 greeting_text。可选首条打招呼消息"
      },
      target_count: createTargetCountInputSchema("通过筛选的人数目标；数字表示通过人数目标，未达标但列表扫到底也算完成；all/全部/扫到底 表示处理完整列表"),
      targetCount: createTargetCountInputSchema("兼容字段；优先使用 target_count。数字表示通过人数目标，all/全部/扫到底 表示处理完整列表"),
      port: {
        type: "integer",
        minimum: 1,
        description: "可选，覆盖 Chrome 调试端口；未传时读取 screening-config.json.debugPort"
      },
      host: {
        type: "string",
        description: "可选，Chrome 调试 host；默认 127.0.0.1"
      },
      target_url_includes: {
        type: "string",
        description: "可选，Chrome target URL 匹配片段；默认 Boss chat index"
      },
      allow_navigate: {
        type: "boolean",
        description: "可选，未在 chat index 时允许通过 Page.navigate 切换到 chat 页面；默认 true"
      },
      slow_live: {
        type: "boolean",
        description: "可选，VPN/慢页面 live 测试模式，放宽等待时间"
      },
      max_candidates: {
        type: "integer",
        minimum: 1,
        description: "可选，仅用于 target_count=all 时给 CDP-only run 设置安全上限"
      },
      detail_limit: {
        type: "integer",
        minimum: 0,
        description: "可选，打开在线简历详情的人数上限；LLM 或求简历任务默认跟随安全处理上限"
      },
      detail_source: {
        type: "string",
        enum: ["cascade", "network", "dom", "image"],
        description: "可选，详情/CV 抽取来源；默认 cascade"
      },
      delay_ms: {
        type: "integer",
        minimum: 0,
        description: "可选，每个候选人之间的等待毫秒数"
      },
      use_llm: {
        type: "boolean",
        description: "可选，默认 true。use_llm=false 等同 deterministic/local scorer，仅限 debug_test_mode=true 的明确测试场景"
      },
      screening_mode: {
        type: "string",
        enum: ["llm", "deterministic"],
        description: "筛选引擎；默认 llm。deterministic 仅限 debug_test_mode=true"
      },
      debug_test_mode: {
        type: "boolean",
        description: "高级测试开关；默认 false。只有显式为 true 时才允许 deterministic/local scorer、detail_limit=0、dry-run 求简历等调试路径"
      },
      request_cv: {
        type: "boolean",
        description: "可选，通过筛选后发送消息并点击求简历"
      },
      request_resume: {
        type: "boolean",
        description: "request_cv 的兼容别名"
      },
      ask_cv: {
        type: "boolean",
        description: "request_cv 的兼容别名"
      },
      execute_post_action: {
        type: "boolean",
        description: "可选，执行通过后的后置动作；chat 中等同 request_cv"
      },
      post_action: {
        type: "string",
        description: "可选，支持 request_cv / ask_cv / request_resume / 求简历"
      },
      dry_run_request_cv: {
        type: "boolean",
        description: "可选，只验证求简历动作路径，不实际发送消息或点击求简历"
      },
      llm_timeout_ms: {
        type: "integer",
        minimum: 1000,
        description: "可选，单个候选人的 LLM 调用超时"
      },
      llm_image_limit: {
        type: "integer",
        minimum: 1,
        description: "可选，传给 LLM 的图片简历截图页数上限"
      },
      llm_image_detail: {
        type: "string",
        description: "可选，图片输入 detail，默认 low"
      },
      online_resume_button_timeout_ms: {
        type: "integer",
        minimum: 1000,
        description: "可选，选中 chat 候选人后等待在线简历按钮出现的毫秒数；慢 VPN 默认 30000"
      },
      max_image_pages: {
        type: "integer",
        minimum: 1,
        description: "可选，图片简历 fallback 的滚动截图页数上限，默认 24"
      },
      list_max_scrolls: {
        type: "integer",
        minimum: 1,
        description: "可选，聊天列表无限滚动最大次数"
      },
      dry_run: { type: "boolean" },
      no_state: { type: "boolean" },
      human_behavior: createHumanBehaviorInputSchema("可选，chat 可靠性实验用节奏配置；默认 paced_with_rests/on"),
      humanBehavior: createHumanBehaviorInputSchema("兼容字段；优先使用 human_behavior"),
      human_behavior_enabled: {
        type: "boolean",
        description: "兼容字段；true 等同启用 paced 默认配置，false 等同 baseline"
      },
      human_behavior_profile: {
        type: "string",
        enum: ["baseline", "paced", "paced_with_rests"],
        description: "可选实验 profile：baseline/paced/paced_with_rests"
      },
      safe_pacing: { type: "boolean" },
      batch_rest_enabled: { type: "boolean" }
    },
    additionalProperties: false,
    examples: [
      {
        job: "530272634",
        start_from: "unread",
        target_count: "all",
        criteria: "请扫到底筛选符合条件的人选"
      },
      {
        job: "530272634",
        start_from: "unread",
        target_count: 20,
        criteria: "请筛选 20 位符合条件的人选"
      }
    ]
  };
  if (requireFullInput) {
    schema.required = ["job", "start_from", "criteria"];
    schema.anyOf = [
      { required: ["target_count"] },
      { required: ["targetCount"] }
    ];
  }
  return schema;
}

function createRunFeaturedCalibrationInputSchema() {
  return {
    type: "object",
    properties: {
      port: {
        type: "integer",
        minimum: 1,
        description: "可选，Boss Chrome 远程调试端口（默认读取配置或 9222）"
      },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        description: "可选，等待收藏点击的超时时间（毫秒）"
      },
      output: {
        type: "string",
        description: "可选，校准文件输出路径（默认 favorite-calibration.json）"
      }
    },
    additionalProperties: false
  };
}

function createRunRecommendSelfHealInputSchema() {
  return {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["scan", "apply"],
        description: "scan=扫描漂移；apply=按 repair_session_id 应用高置信度修复"
      },
      scope: {
        type: "string",
        enum: ["full", "search_screen", "selectors_only"],
        description: "扫描范围，默认 full"
      },
      validation_profile: {
        type: "string",
        enum: ["safe", "full"],
        description: "校验强度，默认 full"
      },
      port: {
        type: "integer",
        minimum: 1,
        description: "可选，Boss Chrome 远程调试端口"
      },
      repair_session_id: {
        type: "string",
        description: "apply 模式必填，来自 scan 返回值"
      },
      confirm_apply: {
        type: "boolean",
        description: "apply 模式必填，必须显式传 true"
      }
    },
    additionalProperties: false
  };
}

function createListRecommendJobsInputSchema() {
  return {
    type: "object",
    properties: {
      host: {
        type: "string",
        description: "可选，Chrome 调试 host；默认 127.0.0.1"
      },
      port: {
        type: "integer",
        minimum: 1,
        description: "可选，Chrome 调试端口；默认 9222"
      },
      target_url_includes: {
        type: "string",
        description: "可选，Chrome target URL 匹配片段；默认 Boss recommend 页"
      },
      allow_navigate: {
        type: "boolean",
        description: "可选，未在 recommend 页时允许通过 Page.navigate 切换；默认 true"
      },
      slow_live: {
        type: "boolean",
        description: "可选，VPN/慢页面模式，放宽等待时间"
      }
    },
    additionalProperties: false
  };
}

function createScheduleRunInputSchema() {
  const base = createRunInputSchema();
  return {
    ...base,
    properties: {
      ...base.properties,
      schedule_id: {
        type: "string",
        description: "可选，自定义定时任务 id；默认自动生成"
      },
      schedule_run_at: {
        type: "string",
        description: "ISO 时间字符串；到点后由 package-owned detached scheduler 启动已准备好的 payload"
      },
      schedule_delay_minutes: {
        type: "number",
        minimum: 0,
        description: "从现在开始延迟多少分钟后启动；适合 OpenClaw cron/定时任务设置"
      },
      schedule_delay_seconds: {
        type: "number",
        minimum: 0,
        description: "从现在开始延迟多少秒后启动；主要用于短延迟或测试"
      }
    },
    required: ["instruction"],
    additionalProperties: false
  };
}

function createToolsSchema() {
  return [
    {
      name: TOOL_LIST_RECOMMEND_JOBS,
      description: "CDP-only 读取 Boss 推荐页岗位下拉框，返回所有可用岗位完整名称，方便 cron/一次性任务提前填写 job 参数。不会启动筛选任务。",
      inputSchema: createListRecommendJobsInputSchema()
    },
    {
      name: TOOL_PREPARE_RUN,
      description: "只校验 Boss 推荐页流水线参数是否完整；不会启动筛选任务。若用户要现在运行，返回 READY/cron_ready=true 后必须继续调用本 MCP server 的 run_recommend 或 start_recommend_pipeline_run；只有定时/稍后运行才调用 schedule_recommend_pipeline_run。prepare 能返回结果就证明原生 MCP 可用，禁止改用 terminal/shell/run_command/CLI/manual JSON-RPC。",
      inputSchema: createRunInputSchema()
    },
    {
      name: TOOL_RUN_RECOMMEND,
      description: "立即通过原生 MCP 启动 Boss 推荐页筛选。它是 start_recommend_pipeline_run 的短别名，适合 Trae/Trae-CN 等代理在 prepare_recommend_pipeline_run 返回 READY 后继续正式运行；必须作为 MCP tool call 调用，禁止通过 terminal/shell/run_command/CLI/manual JSON-RPC 代替，也不要用 schedule_recommend_pipeline_run 冒充立即启动。",
      inputSchema: createRunInputSchema()
    },
    {
      name: TOOL_START_RUN,
      description: "立即通过原生 MCP 异步启动 Boss 推荐页流水线（含同步门禁预检）；prepare_recommend_pipeline_run 返回 READY 后，如果用户要现在运行就调用本工具或 run_recommend。必须作为 MCP tool call 调用，禁止通过 terminal/shell/run_command/CLI/manual JSON-RPC 代替，也不要用 schedule_recommend_pipeline_run 冒充立即启动。",
      inputSchema: createRunInputSchema()
    },
    {
      name: TOOL_SCHEDULE_RUN,
      description: "只用于用户明确要求稍后/cron/定时启动的 package-owned Boss 推荐页定时任务。若用户要现在运行，必须调用 run_recommend 或 start_recommend_pipeline_run，不要用短延迟 schedule 冒充立即启动。schedule 会先校验 READY/cron_ready，再保存完整 payload，并由 detached scheduler 到点直接启动，不依赖 AI harness 自己拼 shell cron。",
      inputSchema: createScheduleRunInputSchema()
    },
    {
      name: TOOL_GET_SCHEDULED_RUN,
      description: "查询 package-owned 推荐页定时任务状态；返回 schedule_id、worker 状态、到点后启动的 run_id 与运行快照。",
      inputSchema: {
        type: "object",
        properties: {
          schedule_id: { type: "string" }
        },
        required: ["schedule_id"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_GET_RUN,
      description: "按 run_id 查询异步/同步流水线运行状态快照。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" }
        },
        required: ["run_id"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_CANCEL_RUN,
      description: "取消指定 run_id 的运行中流水线。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" }
        },
        required: ["run_id"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_PAUSE_RUN,
      description: "请求暂停指定 run_id 的流水线；会在当前候选人处理完成后进入 paused。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" }
        },
        required: ["run_id"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_RESUME_RUN,
      description: "继续指定 run_id 的 paused 流水线；沿用原 CSV 与 checkpoint 续跑。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" }
        },
        required: ["run_id"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_RUN_FEATURED_CALIBRATION,
      description: "手动执行精选页收藏按钮校准。执行前请先在 Boss 推荐页切换到精选 tab 并打开任意候选人详情页。",
      inputSchema: createRunFeaturedCalibrationInputSchema()
    },
    {
      name: TOOL_GET_FEATURED_CALIBRATION_STATUS,
      description: "查询精选页收藏校准文件与校准脚本可用性。",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: TOOL_RUN_RECOMMEND_SELF_HEAL,
      description: "手动运维自愈工具：扫描 Boss recommend 相关 selector / network 规则漂移，并在确认后应用高置信度修复。",
      inputSchema: createRunRecommendSelfHealInputSchema()
    },
    {
      name: TOOL_BOSS_CHAT_HEALTH_CHECK,
      description: "CDP-only 检查 Boss chat 页面、自愈 probes、共享 screening-config.json 与 chat runtime 目录是否可用。",
      inputSchema: {
        type: "object",
        properties: {
          host: {
            type: "string",
            description: "可选，Chrome 调试 host；默认 127.0.0.1"
          },
          port: {
            type: "integer",
            minimum: 1,
            description: "可选，Chrome 调试端口；默认读取 screening-config.json.debugPort 或 9222"
          },
          target_url_includes: {
            type: "string",
            description: "可选，Chrome target URL 匹配片段；默认 Boss chat 页"
          },
          allow_navigate: {
            type: "boolean",
            description: "可选，未在 chat 页时允许通过 Page.navigate 切换；默认 true"
          },
          slow_live: {
            type: "boolean",
            description: "可选，VPN/慢页面 live 测试模式，放宽等待时间"
          }
        },
        additionalProperties: false
      }
    },
    {
      name: TOOL_BOSS_CHAT_PREPARE_RUN,
      description: "预备一次 boss-chat 任务：只导航聊天页并返回岗位列表与待补字段，不会启动任务。用它先获取 job_options。",
      inputSchema: createBossChatStartInputSchema()
    },
    {
      name: TOOL_BOSS_CHAT_START_RUN,
      description: "异步启动一次 boss-chat 任务。必须一次性提供 job、start_from、target_count、criteria；若用户选择扫到底/不限/全部候选人，必须字面传 target_count=\"all\"。",
      inputSchema: createBossChatStartInputSchema({ requireFullInput: true })
    },
    {
      name: TOOL_BOSS_CHAT_GET_RUN,
      description: "查询 boss-chat run_id 的当前状态。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          profile: { type: "string" }
        },
        required: ["run_id"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_BOSS_CHAT_PAUSE_RUN,
      description: "暂停运行中的 boss-chat 任务。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          profile: { type: "string" }
        },
        required: ["run_id"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_BOSS_CHAT_RESUME_RUN,
      description: "继续已暂停的 boss-chat 任务。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          profile: { type: "string" }
        },
        required: ["run_id"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_BOSS_CHAT_CANCEL_RUN,
      description: "取消运行中的 boss-chat 任务。",
      inputSchema: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          profile: { type: "string" }
        },
        required: ["run_id"],
        additionalProperties: false
      }
    },
    {
      name: TOOL_RUN_RECRUIT_PIPELINE,
      description: "兼容 Boss recruit 入口：默认 async；sync 模式会等待终态。所有浏览器动作走共享 CDP-only recruit service。",
      inputSchema: createRecruitPipelineInputSchema()
    },
    {
      name: TOOL_START_RECRUIT_PIPELINE_RUN,
      description: "异步启动 Boss recruit 流水线；先完成参数/criteria/default 确认门禁，再连接 Chrome search 页执行。",
      inputSchema: createRecruitPipelineInputSchema()
    },
    {
      name: TOOL_GET_RECRUIT_PIPELINE_RUN,
      description: "查询 Boss recruit run_id 的当前状态。",
      inputSchema: createRecruitRunIdInputSchema()
    },
    {
      name: TOOL_CANCEL_RECRUIT_PIPELINE_RUN,
      description: "取消运行中的 Boss recruit 任务。",
      inputSchema: createRecruitRunIdInputSchema()
    },
    {
      name: TOOL_PAUSE_RECRUIT_PIPELINE_RUN,
      description: "暂停运行中的 Boss recruit 任务。",
      inputSchema: createRecruitRunIdInputSchema()
    },
    {
      name: TOOL_RESUME_RECRUIT_PIPELINE_RUN,
      description: "继续已暂停的 Boss recruit 任务。",
      inputSchema: createRecruitRunIdInputSchema()
    }
  ];
}

function createToolResultResponse(id, payload, isError = false) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2)
        }
      ],
      structuredContent: payload,
      ...(isError ? { isError: true } : {})
    }
  };
}

function validateRunArgs(args) {
  if (!args || typeof args !== "object") {
    return "arguments must be an object";
  }
  if (!args.instruction || typeof args.instruction !== "string") {
    return "instruction is required and must be a string";
  }
  return null;
}

function validateBossChatStartArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be an object";
  }
  if (Object.prototype.hasOwnProperty.call(args, "job")) {
    if (typeof args.job !== "string" || !normalizeText(args.job)) {
      return "job must be a non-empty string when provided";
    }
  }
  if (Object.prototype.hasOwnProperty.call(args, "start_from")) {
    const startFrom = normalizeText(args.start_from).toLowerCase();
    if (!["unread", "all"].includes(startFrom)) {
      return "start_from must be one of: unread, all";
    }
  }
  if (Object.prototype.hasOwnProperty.call(args, "criteria")) {
    if (typeof args.criteria !== "string" || !normalizeText(args.criteria)) {
      return "criteria must be a non-empty string when provided";
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(args, "greeting_text")
    && typeof args.greeting_text !== "string"
  ) {
    return "greeting_text must be a string when provided";
  }
  if (
    Object.prototype.hasOwnProperty.call(args, "greetingText")
    && typeof args.greetingText !== "string"
  ) {
    return "greetingText must be a string when provided";
  }
  if (
    Object.prototype.hasOwnProperty.call(args, "target_count")
    || Object.prototype.hasOwnProperty.call(args, "targetCount")
  ) {
    normalizeTargetCountInput(getBossChatTargetCountValue(args));
  }
  if (Object.prototype.hasOwnProperty.call(args, "port")) {
    const port = Number.parseInt(String(args.port), 10);
    if (!Number.isFinite(port) || port <= 0) {
      return "port must be a positive integer";
    }
  }
  return null;
}

function validateRunFeaturedCalibrationArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be an object";
  }

  if (Object.prototype.hasOwnProperty.call(args, "port")) {
    const port = Number.parseInt(String(args.port), 10);
    if (!Number.isFinite(port) || port <= 0) {
      return "port must be a positive integer";
    }
  }

  if (Object.prototype.hasOwnProperty.call(args, "timeout_ms")) {
    const timeoutMs = Number.parseInt(String(args.timeout_ms), 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
      return "timeout_ms must be an integer >= 1000";
    }
  }

  if (Object.prototype.hasOwnProperty.call(args, "output")) {
    if (typeof args.output !== "string" || !normalizeText(args.output)) {
      return "output must be a non-empty string when provided";
    }
  }

  return null;
}

function validateRunRecommendSelfHealArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be an object";
  }

  if (Object.prototype.hasOwnProperty.call(args, "mode")) {
    const mode = normalizeText(args.mode).toLowerCase();
    if (!["scan", "apply"].includes(mode)) {
      return "mode must be one of: scan, apply";
    }
  }

  if (Object.prototype.hasOwnProperty.call(args, "scope")) {
    const scope = normalizeText(args.scope).toLowerCase();
    if (!["full", "search_screen", "selectors_only"].includes(scope)) {
      return "scope must be one of: full, search_screen, selectors_only";
    }
  }

  if (Object.prototype.hasOwnProperty.call(args, "validation_profile")) {
    const profile = normalizeText(args.validation_profile).toLowerCase();
    if (!["safe", "full"].includes(profile)) {
      return "validation_profile must be one of: safe, full";
    }
  }

  if (Object.prototype.hasOwnProperty.call(args, "port")) {
    const port = Number.parseInt(String(args.port), 10);
    if (!Number.isFinite(port) || port <= 0) {
      return "port must be a positive integer";
    }
  }

  return null;
}

function getLastOutputLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

function buildCdpMethodSummary(methodLog = []) {
  const summary = {};
  for (const entry of methodLog) {
    const method = typeof entry === "string" ? entry : entry?.method;
    if (!method) continue;
    summary[method] = (summary[method] || 0) + 1;
  }
  return summary;
}

function compactSelfHealCheck(check) {
  return {
    domain: check?.domain || null,
    status: check?.status || null,
    summary: check?.summary || null,
    probes: Array.isArray(check?.probes)
      ? check.probes.map((probe) => ({
        id: probe.id,
        type: probe.type,
        status: probe.status,
        ok: probe.ok,
        required: probe.required,
        count: probe.count,
        root: probe.root || null,
        matched_selectors: probe.matched_selectors || undefined,
        selector_counts: probe.selector_counts || undefined,
        total_ax_nodes: probe.total_ax_nodes || undefined,
        error: probe.error || undefined
      }))
      : [],
    drift_report: check?.drift_report || null
  };
}

function normalizeRequiredConfirmations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function hasExplicitFinalConfirmation(args) {
  return args?.confirmation?.final_confirmed === true;
}

function buildAsyncPrecheckConfirmation(confirmation) {
  if (!confirmation || typeof confirmation !== "object") {
    return {
      final_confirmed: false
    };
  }
  return {
    ...confirmation,
    final_confirmed: false
  };
}

function buildAsyncPrecheckArgs(args) {
  return {
    instruction: args.instruction,
    confirmation: buildAsyncPrecheckConfirmation(args.confirmation),
    overrides: args.overrides,
    follow_up: args.follow_up
  };
}

function isFinalReviewOnlyConfirmation(result) {
  if (result?.status !== "NEED_CONFIRMATION") return false;
  const required = normalizeRequiredConfirmations(result.required_confirmations);
  return required.length > 0 && required.every((item) => item === "final_review");
}

function safeUpdateRunState(runId, updater) {
  try {
    return updateRunState(runId, updater);
  } catch {
    return null;
  }
}

function safeUpdateRunProgress(runId, patch, message = null) {
  try {
    return updateRunProgress(runId, patch, message);
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readCheckpointProgress(checkpointPath) {
  const normalized = normalizeText(checkpointPath || "");
  if (!normalized) return null;
  try {
    const raw = fs.readFileSync(normalized, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      processed_count: Number.isInteger(parsed.processed_count) ? parsed.processed_count : 0,
      passed_count: Array.isArray(parsed.passed_candidates) ? parsed.passed_candidates.length : 0,
      skipped_count: Number.isInteger(parsed.skipped_count) ? parsed.skipped_count : 0,
      output_csv: normalizeText(parsed.output_csv || "") || null,
      checkpoint_path: normalized
    };
  } catch {
    return null;
  }
}

function getBossChatRunIdFromSnapshot(snapshot) {
  return normalizeText(
    snapshot?.resume?.chat_run_id
    || snapshot?.result?.follow_up?.chat?.run_id
    || ""
  );
}

function mergeFollowUpResult(currentResult, event = {}) {
  const currentBase = currentResult && typeof currentResult === "object" ? currentResult : {};
  const recommendPayload = event?.recommend_payload && typeof event.recommend_payload === "object"
    ? event.recommend_payload
    : null;
  const baseResult = recommendPayload
    ? {
        ...currentBase,
        ...recommendPayload
      }
    : { ...currentBase };
  const followUp = event?.follow_up && typeof event.follow_up === "object" ? event.follow_up : {};
  const currentFollowUp = baseResult.follow_up && typeof baseResult.follow_up === "object"
    ? baseResult.follow_up
    : {};
  const nextChat = followUp.chat && typeof followUp.chat === "object"
    ? {
        ...(currentFollowUp.chat && typeof currentFollowUp.chat === "object" ? currentFollowUp.chat : {}),
        ...followUp.chat
      }
    : currentFollowUp.chat;
  return {
    ...baseResult,
    ...(event?.recommend_result ? { result: event.recommend_result } : {}),
    follow_up: {
      ...currentFollowUp,
      ...followUp,
      ...(nextChat ? { chat: nextChat } : {})
    }
  };
}

function reconcileOrphanRunIfNeeded(runId, snapshot) {
  if (!snapshot || TERMINAL_RUN_STATES.has(snapshot.state)) {
    return snapshot;
  }
  if (snapshot.state === RUN_STATE_PAUSED) {
    return snapshot;
  }
  if (isProcessAlive(snapshot.pid)) {
    return snapshot;
  }

  const checkpointPath = normalizeText(snapshot?.resume?.checkpoint_path || getRunArtifacts(runId).checkpoint_path);
  const checkpointProgress = readCheckpointProgress(checkpointPath);
  const partialResult = checkpointProgress
    ? {
        processed_count: checkpointProgress.processed_count,
        passed_count: checkpointProgress.passed_count,
        skipped_count: checkpointProgress.skipped_count,
        output_csv: checkpointProgress.output_csv,
        checkpoint_path: checkpointProgress.checkpoint_path
      }
    : null;
  const error = {
    code: "RUN_PROCESS_EXITED",
    message: `检测到运行进程已退出（pid=${snapshot.pid || "unknown"}），已自动纠正状态。`,
    retryable: true
  };
  const recovered = safeUpdateRunState(runId, {
    state: RUN_STATE_FAILED,
    stage: snapshot.stage || RUN_STAGE_PREFLIGHT,
    last_message: "运行进程已退出，状态已自动标记为失败。",
    resume: {
      ...snapshot.resume,
      checkpoint_path: checkpointPath,
      output_csv: checkpointProgress?.output_csv || snapshot?.resume?.output_csv || null
    },
    error,
    result: {
      status: "FAILED",
      error,
      partial_result: partialResult
    }
  });
  return recovered || readRunState(runId) || snapshot;
}

function parseDetachedWorkerOptions(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || !argv.includes(DETACHED_WORKER_FLAG)) {
    return null;
  }
  const runIdFlagIndex = argv.indexOf(DETACHED_WORKER_RUN_ID_FLAG);
  const runId = runIdFlagIndex >= 0 ? normalizeText(argv[runIdFlagIndex + 1]) : "";
  return {
    runId,
    resumeRun: argv.includes(DETACHED_WORKER_RESUME_FLAG)
  };
}

function launchDetachedRunWorker({ runId, resumeRun = false }) {
  const childArgs = [thisFilePath, DETACHED_WORKER_FLAG, DETACHED_WORKER_RUN_ID_FLAG, String(runId)];
  if (resumeRun) {
    childArgs.push(DETACHED_WORKER_RESUME_FLAG);
  }
  const artifacts = getRunArtifacts(runId);
  fs.mkdirSync(path.dirname(artifacts.worker_stdout_path), { recursive: true });
  const stdoutFd = fs.openSync(artifacts.worker_stdout_path, "a");
  const stderrFd = fs.openSync(artifacts.worker_stderr_path, "a");
  let child;
  try {
    child = spawnProcessImpl(process.execPath, childArgs, {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      env: process.env
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  child.workerLogPaths = {
    stdoutPath: artifacts.worker_stdout_path,
    stderrPath: artifacts.worker_stderr_path
  };
  if (typeof child?.unref === "function") {
    child.unref();
  }
  return child;
}

function errorToDetachedWorkerPayload(error, fallbackMessage = "detached recommend worker exited unexpectedly") {
  const message = normalizeText(error?.message || error || fallbackMessage) || fallbackMessage;
  const payload = {
    code: normalizeText(error?.code || "") || "RUN_WORKER_UNHANDLED_EXCEPTION",
    message,
    retryable: true
  };
  if (normalizeText(error?.name || "")) {
    payload.name = normalizeText(error.name);
  }
  if (normalizeText(error?.stack || "")) {
    payload.stack = String(error.stack).slice(0, 8000);
  }
  return payload;
}

function markDetachedWorkerFailed(runId, error, options = {}) {
  const normalizedRunId = normalizeText(runId);
  if (!normalizedRunId) return null;
  const existing = readRawRunState(normalizedRunId) || {};
  const existingState = normalizeText(existing.state || existing.status);
  if (TERMINAL_RUN_STATES.has(existingState)) return existing;

  const now = new Date().toISOString();
  const artifacts = getRunArtifacts(normalizedRunId);
  const errorPayload = {
    ...errorToDetachedWorkerPayload(error, options.message),
    ...(options.code ? { code: options.code } : {})
  };
  const previousResult = existing.result && typeof existing.result === "object" ? existing.result : {};
  const result = {
    ...previousResult,
    status: "FAILED",
    completion_reason: "failed",
    error: errorPayload,
    worker_stdout_path: artifacts.worker_stdout_path,
    worker_stderr_path: artifacts.worker_stderr_path
  };

  return writeRawRunState(normalizedRunId, {
    ...existing,
    run_id: normalizedRunId,
    mode: existing.mode || RUN_MODE_ASYNC,
    state: RUN_STATE_FAILED,
    status: RUN_STATE_FAILED,
    stage: existing.stage || RUN_STAGE_PREFLIGHT,
    started_at: existing.started_at || now,
    updated_at: now,
    heartbeat_at: now,
    completed_at: now,
    pid: Number.isInteger(existing.pid) && existing.pid > 0 ? existing.pid : process.pid,
    progress: existing.progress || {},
    last_message: errorPayload.message,
    context: existing.context || {},
    control: existing.control || {
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    },
    resume: {
      ...(existing.resume && typeof existing.resume === "object" ? existing.resume : {}),
      checkpoint_path: existing.resume?.checkpoint_path || artifacts.checkpoint_path,
      pause_control_path: existing.resume?.pause_control_path || artifacts.run_state_path,
      worker_stdout_path: artifacts.worker_stdout_path,
      worker_stderr_path: artifacts.worker_stderr_path
    },
    artifacts: {
      ...(existing.artifacts && typeof existing.artifacts === "object" ? existing.artifacts : {}),
      worker_stdout_path: artifacts.worker_stdout_path,
      worker_stderr_path: artifacts.worker_stderr_path
    },
    error: errorPayload,
    result
  });
}

function installDetachedWorkerFailureHandlers(runId) {
  let handled = false;
  const failOnce = (error, options = {}) => {
    if (handled) return;
    handled = true;
    try {
      markDetachedWorkerFailed(runId, error, options);
    } catch (markError) {
      console.error("[boss-recommend-mcp] failed to persist detached worker failure", markError);
    }
  };

  process.on("uncaughtException", (error) => {
    console.error("[boss-recommend-mcp] detached worker uncaught exception", error);
    failOnce(error, { code: "RUN_WORKER_UNCAUGHT_EXCEPTION" });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[boss-recommend-mcp] detached worker unhandled rejection", reason);
    const error = reason instanceof Error ? reason : new Error(normalizeText(reason) || "Unhandled promise rejection");
    failOnce(error, { code: "RUN_WORKER_UNHANDLED_REJECTION" });
    process.exit(1);
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      const error = new Error(`detached recommend worker received ${signal}`);
      console.error("[boss-recommend-mcp] detached worker received signal", signal);
      failOnce(error, { code: "RUN_WORKER_SIGNAL" });
      const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
      process.exit(signalExitCodes[signal] || 1);
    });
  }
}

function buildWorkerLaunchFailedPayload(message) {
  return {
    status: "FAILED",
    error: {
      code: "RUN_WORKER_LAUNCH_FAILED",
      message,
      retryable: true
    }
  };
}

function finalizeCanceledRun(runId, snapshot) {
  const canceledResult = {
    status: "FAILED",
    error: {
      code: "PIPELINE_CANCELED",
      message: "流水线已取消。",
      retryable: true
    },
    partial_result: snapshot?.result?.partial_result || snapshot?.result?.result || null
  };
  return safeUpdateRunState(runId, {
    state: RUN_STATE_CANCELED,
    stage: snapshot?.stage || RUN_STAGE_PREFLIGHT,
    last_message: "流水线已取消。",
    control: {
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    },
    error: canceledResult.error,
    result: canceledResult
  }) || readRunState(runId) || snapshot;
}

function createRuntimeCallbacks(runId, heartbeatIntervalMs) {
  let lastStage = RUN_STAGE_PREFLIGHT;
  let lastOutputPersistAt = 0;
  return {
    heartbeatIntervalMs,
    onStage(event) {
      const stage = normalizeText(event?.stage) || RUN_STAGE_PREFLIGHT;
      lastStage = stage;
      safeUpdateRunState(runId, {
        state: RUN_STATE_RUNNING,
        stage,
        last_message: normalizeText(event?.message || "")
      });
    },
    onHeartbeat(event) {
      const stage = normalizeText(event?.stage) || lastStage;
      lastStage = stage || lastStage;
      const detailsMessage = normalizeText(event?.details?.message || "");
      const patch = { stage: lastStage };
      if (detailsMessage) {
        patch.last_message = detailsMessage;
      }
      safeUpdateRunState(runId, patch);
      try {
        touchRunHeartbeat(runId, detailsMessage || undefined);
      } catch {
        // Ignore heartbeat persistence failures here; state updates above already best-effort.
      }
    },
    onOutput(event) {
      const stage = normalizeText(event?.stage) || lastStage;
      lastStage = stage || lastStage;
      const now = Date.now();
      if (now - lastOutputPersistAt < 1000) return;
      lastOutputPersistAt = now;
      const message = getLastOutputLine(event?.text);
      if (!message) return;
      safeUpdateRunState(runId, {
        stage: lastStage,
        last_message: message
      });
    },
    onProgress(event) {
      const stage = normalizeText(event?.stage) || lastStage;
      lastStage = stage || lastStage;
      safeUpdateRunState(runId, { stage: lastStage });
      safeUpdateRunProgress(
        runId,
        {
          processed: Number.isInteger(event?.processed) ? event.processed : undefined,
          passed: Number.isInteger(event?.passed) ? event.passed : undefined,
          skipped: Number.isInteger(event?.skipped) ? event.skipped : undefined,
          greet_count: Number.isInteger(event?.greet_count) ? event.greet_count : undefined
        },
        normalizeText(event?.line || "")
      );
    },
    onFollowUp(event) {
      const stage = normalizeText(event?.stage) || RUN_STAGE_CHAT_FOLLOWUP;
      lastStage = stage || lastStage;
      safeUpdateRunState(runId, (current) => ({
        state: RUN_STATE_RUNNING,
        stage: lastStage,
        last_message: normalizeText(event?.last_message || current?.last_message || ""),
        resume: {
          ...current?.resume,
          follow_up_phase: RUN_STAGE_CHAT_FOLLOWUP,
          chat_run_id: normalizeText(
            event?.follow_up?.chat?.run_id
            || getBossChatRunIdFromSnapshot(current)
            || ""
          ) || null,
          chat_state: normalizeText(event?.follow_up?.chat?.state || current?.resume?.chat_state || "") || null
        },
        result: mergeFollowUpResult(current?.result, event)
      }));
    },
    getLastStage() {
      return lastStage;
    }
  };
}


async function executeTrackedPipeline({
  runId,
  mode,
  workspaceRoot,
  args,
  signal,
  resumeRun = false
}) {
  const heartbeatIntervalMs = getRunHeartbeatIntervalMs();
  const runtimeCallbacks = createRuntimeCallbacks(runId, heartbeatIntervalMs);
  const artifacts = getRunArtifacts(runId);
  const existingSnapshot = readRunState(runId);
  const resumeConfig = {
    resume: resumeRun === true,
    checkpoint_path: normalizeText(existingSnapshot?.resume?.checkpoint_path || artifacts.checkpoint_path),
    pause_control_path: normalizeText(existingSnapshot?.resume?.pause_control_path || artifacts.run_state_path),
    output_csv: normalizeText(existingSnapshot?.resume?.output_csv || "") || null,
    follow_up_phase: normalizeText(existingSnapshot?.resume?.follow_up_phase || "") || null,
    chat_run_id: normalizeText(existingSnapshot?.resume?.chat_run_id || "") || null,
    chat_state: normalizeText(existingSnapshot?.resume?.chat_state || "") || null,
    recommend_result: existingSnapshot?.result?.result || null,
    recommend_search_params: existingSnapshot?.result?.search_params || null,
    recommend_screen_params: existingSnapshot?.result?.screen_params || null,
    previous_completion_reason: getCompletionReasonFromResult(existingSnapshot?.result || null)
  };
  safeUpdateRunState(runId, {
    state: RUN_STATE_RUNNING,
    stage: resumeConfig.follow_up_phase === RUN_STAGE_CHAT_FOLLOWUP ? RUN_STAGE_CHAT_FOLLOWUP : RUN_STAGE_PREFLIGHT,
    last_message: resumeRun
      ? (
        resumeConfig.follow_up_phase === RUN_STAGE_CHAT_FOLLOWUP
          ? "流水线继续执行中，准备恢复 boss-chat follow-up。"
          : "流水线继续执行中，等待 preflight。"
      )
      : "流水线已启动，等待 preflight。",
    resume: resumeConfig
  });

  let result;
  try {
    const pipelineImpl = await getRunPipelineImpl();
    result = await pipelineImpl(
      {
        workspaceRoot,
        instruction: args.instruction,
        confirmation: args.confirmation,
        overrides: args.overrides,
        followUp: args.follow_up,
        resume: resumeConfig
      },
      undefined,
      {
        signal,
        heartbeatIntervalMs,
        isPauseRequested: () => isRunPauseRequested(runId),
        isCancelRequested: () => isRunCancelRequested(runId),
        onStage: runtimeCallbacks.onStage,
        onHeartbeat: runtimeCallbacks.onHeartbeat,
        onOutput: runtimeCallbacks.onOutput,
        onProgress: runtimeCallbacks.onProgress,
        onFollowUp: runtimeCallbacks.onFollowUp
      }
    );
  } catch (error) {
    const canceled = Boolean(signal?.aborted) || error?.code === "PIPELINE_ABORTED";
    if (canceled) {
      const canceledResult = {
        status: "FAILED",
        error: {
          code: "PIPELINE_CANCELED",
          message: "流水线已取消。",
          retryable: true
        }
      };
      safeUpdateRunState(runId, {
        mode,
        state: RUN_STATE_CANCELED,
        stage: runtimeCallbacks.getLastStage(),
        last_message: "流水线已取消。",
        control: {
          pause_requested: false,
          pause_requested_at: null,
          pause_requested_by: null,
          cancel_requested: false
        },
        resume: {
          ...resumeConfig,
          output_csv: getOutputCsvFromResult(canceledResult) || resumeConfig.output_csv
        },
        error: canceledResult.error,
        result: canceledResult
      });
      return {
        result: canceledResult,
        lastStage: runtimeCallbacks.getLastStage(),
        state: RUN_STATE_CANCELED
      };
    }

    const failedResult = {
      status: "FAILED",
      error: {
        code: error?.code || "UNEXPECTED_ERROR",
        message: error?.message || "Unexpected error",
        retryable: error?.retryable !== false
      }
    };
    safeUpdateRunState(runId, {
      mode,
      state: RUN_STATE_FAILED,
      stage: runtimeCallbacks.getLastStage(),
      last_message: failedResult.error.message,
      error: failedResult.error,
      result: failedResult
    });
    return {
      result: failedResult,
      lastStage: runtimeCallbacks.getLastStage(),
      state: RUN_STATE_FAILED
    };
  }

  const terminalState = result?.status === "FAILED"
    ? RUN_STATE_FAILED
    : result?.status === "PAUSED"
      ? (isRunCancelRequested(runId) ? RUN_STATE_CANCELED : RUN_STATE_PAUSED)
      : RUN_STATE_COMPLETED;
  const outputCsv = getOutputCsvFromResult(result) || resumeConfig.output_csv;
  const checkpointPath = normalizeText(result?.result?.checkpoint_path || resumeConfig.checkpoint_path);
  const canceledError = terminalState === RUN_STATE_CANCELED
    ? {
        code: "PIPELINE_CANCELED",
        message: "流水线已取消。",
        retryable: true
      }
    : null;
  safeUpdateRunState(runId, {
    mode,
    state: terminalState,
    stage: runtimeCallbacks.getLastStage(),
    last_message: terminalState === RUN_STATE_COMPLETED
      ? "流水线执行完成。"
      : terminalState === RUN_STATE_CANCELED
        ? "流水线已取消（已在边界安全停靠）。"
      : terminalState === RUN_STATE_PAUSED
        ? "流水线已暂停。"
        : (result?.error?.message || "流水线执行失败。"),
    control: {
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    },
    resume: {
      checkpoint_path: checkpointPath,
      pause_control_path: resumeConfig.pause_control_path,
      output_csv: outputCsv,
      last_paused_at: terminalState === RUN_STATE_PAUSED ? new Date().toISOString() : null
    },
    error: terminalState === RUN_STATE_FAILED
      ? (result?.error || null)
      : terminalState === RUN_STATE_CANCELED
        ? canceledError
        : null,
    result: result || null
  });
  return {
    result,
    lastStage: runtimeCallbacks.getLastStage(),
    state: terminalState
  };
}

function initializeRunStateOrThrow(runId, mode, workspaceRoot, args, pid = process.pid) {
  const artifacts = getRunArtifacts(runId);
  const snapshot = createRunStateSnapshot({
    runId,
    mode,
    state: "queued",
    stage: RUN_STAGE_PREFLIGHT,
    pid,
    lastMessage: "流水线任务已创建，等待执行。",
    context: buildRunContext(workspaceRoot, args),
    control: {
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    },
    resume: {
      checkpoint_path: artifacts.checkpoint_path,
      pause_control_path: artifacts.run_state_path,
      output_csv: null,
      resume_count: 0,
      last_resumed_at: null,
      last_paused_at: null
    }
  });
  return writeRunState(snapshot);
}

async function runDetachedWorker({ runId, resumeRun = false, workerPid = process.pid }) {
  const normalizedRunId = normalizeText(runId);
  if (!normalizedRunId) {
    return { ok: false, error: "run_id is required" };
  }
  const snapshot = readRunState(normalizedRunId);
  if (!snapshot) {
    return { ok: false, error: `run_id=${normalizedRunId} not found` };
  }

  const executionContext = resolveRunContext(snapshot);
  if (!executionContext) {
    const failedPayload = {
      code: "RUN_CONTEXT_MISSING",
      message: "run 缺少可恢复的执行上下文，无法继续。",
      retryable: false
    };
    safeUpdateRunState(normalizedRunId, {
      state: RUN_STATE_FAILED,
      stage: snapshot.stage || RUN_STAGE_PREFLIGHT,
      last_message: failedPayload.message,
      error: failedPayload,
      result: {
        status: "FAILED",
        error: failedPayload
      }
    });
    return { ok: false, error: failedPayload.message };
  }

  safeUpdateRunState(normalizedRunId, {
    pid: Number.isInteger(workerPid) && workerPid > 0 ? workerPid : process.pid,
    mode: RUN_MODE_ASYNC,
    state: "queued",
    last_message: resumeRun
      ? "detached worker 已启动，准备恢复执行。"
      : "detached worker 已启动，准备执行。"
  });

  const started = await startRecommendPipelineRunTool({
    workspaceRoot: executionContext.workspaceRoot,
    args: executionContext.args,
    runId: normalizedRunId
  });
  if (started?.status !== "ACCEPTED") {
    const failedPayload = started?.error || {
      code: "RUN_WORKER_START_FAILED",
      message: started?.status || "detached recommend worker failed to start",
      retryable: true
    };
    safeUpdateRunState(normalizedRunId, {
      state: RUN_STATE_FAILED,
      stage: snapshot.stage || RUN_STAGE_PREFLIGHT,
      last_message: failedPayload.message,
      error: failedPayload,
      result: {
        status: "FAILED",
        error: failedPayload
      }
    });
    return { ok: false, error: failedPayload.message };
  }

  while (true) {
    const payload = getRecommendPipelineRunTool({ args: { run_id: normalizedRunId } });
    const state = normalizeText(payload?.run?.state || payload?.run?.status || "");
    if (TERMINAL_RUN_STATES.has(state)) break;
    const persisted = readRawRunState(normalizedRunId);
    if (persisted?.control?.cancel_requested === true) {
      cancelRecommendPipelineRunTool({ args: { run_id: normalizedRunId } });
    } else if (persisted?.control?.pause_requested === true && state === RUN_STATE_RUNNING) {
      pauseRecommendPipelineRunTool({ args: { run_id: normalizedRunId } });
    } else if (persisted?.control?.pause_requested === false && state === RUN_STATE_PAUSED) {
      resumeRecommendPipelineRunTool({ args: { run_id: normalizedRunId } });
    }
    await sleepMs(1000);
  }
  return { ok: true };
}

async function handleStartRunTool({ workspaceRoot, args }) {
  if (!shouldStartRecommendDetached({ workspaceRoot })) {
    return startRecommendPipelineRunTool({ workspaceRoot, args });
  }

  const prepared = prepareRecommendPipelineRunTool({ workspaceRoot, args });
  if (prepared.status !== "READY") return prepared;

  cleanupExpiredRuns();
  const runId = createDetachedRecommendRunId();
  try {
    initializeRunStateOrThrow(runId, RUN_MODE_ASYNC, workspaceRoot, args, process.pid);
  } catch (error) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_STATE_IO_ERROR",
        message: `无法写入运行状态目录：${error.message || "unknown"}`,
        retryable: false
      }
    };
  }

  let worker;
  try {
    worker = launchDetachedRunWorker({ runId });
    const workerLogPaths = worker.workerLogPaths || {};
    safeUpdateRunState(runId, {
      pid: worker.pid || process.pid,
      resume: {
        worker_stdout_path: workerLogPaths.stdoutPath || getRunArtifacts(runId).worker_stdout_path,
        worker_stderr_path: workerLogPaths.stderrPath || getRunArtifacts(runId).worker_stderr_path
      }
    });
  } catch (error) {
    const failed = buildWorkerLaunchFailedPayload(error?.message || "无法启动 detached recommend worker。");
    safeUpdateRunState(runId, {
      state: RUN_STATE_FAILED,
      stage: RUN_STAGE_PREFLIGHT,
      last_message: failed.error.message,
      error: failed.error,
      result: failed
    });
    return failed;
  }

  const run = readRunState(runId);
  return {
    status: "ACCEPTED",
    run_id: runId,
    state: "queued",
    run,
    poll_after_sec: getRecommendedPollAfterSec(args),
    message: getDefaultAcceptedMessage(args),
    post_action: prepared.post_action,
    target_count_semantics: prepared.target_count_semantics,
    review: prepared.review
  };
}

function handleGetRunTool(args) {
  return getRecommendPipelineRunTool({ args });
}

function patchDetachedRecommendControl(args, controlPatch, {
  status,
  message,
  lastMessage
} = {}) {
  const runId = normalizeText(args?.run_id || args?.runId || "");
  if (!runId) return null;
  const current = readRawRunState(runId);
  const state = normalizeText(current?.state || current?.status || "");
  if (!current || TERMINAL_RUN_STATES.has(state)) return null;
  const patched = patchRawRunState(runId, {
    last_message: lastMessage || message || current.last_message || "",
    control: controlPatch
  });
  if (!patched) return null;
  return {
    status,
    run: patched,
    message,
    persistence: {
      source: "disk",
      active_control_available: false,
      detached_control_requested: true
    },
    runtime_evaluate_used: false,
    method_summary: {},
    method_log: [],
    chrome: null
  };
}

function handleCancelRunTool(args) {
  const result = cancelRecommendPipelineRunTool({ args });
  if (result?.status === "RUN_STATUS" && result?.persistence?.active_control_available === false) {
    return patchDetachedRecommendControl(args, {
      pause_requested: true,
      pause_requested_at: new Date().toISOString(),
      pause_requested_by: TOOL_CANCEL_RUN,
      cancel_requested: true
    }, {
      status: "CANCEL_REQUESTED",
      message: "已收到取消请求，将由 detached worker 在下一个安全边界停止。",
      lastMessage: "已收到取消请求，将由 detached worker 在下一个安全边界停止。"
    }) || result;
  }
  return result;
}

function handlePauseRunTool(args) {
  const result = pauseRecommendPipelineRunTool({ args });
  if (result?.status === "RUN_STATUS" && result?.persistence?.active_control_available === false) {
    return patchDetachedRecommendControl(args, {
      pause_requested: true,
      pause_requested_at: new Date().toISOString(),
      pause_requested_by: TOOL_PAUSE_RUN,
      cancel_requested: false
    }, {
      status: "PAUSE_REQUESTED",
      message: "暂停请求已写入 detached run 控制文件。",
      lastMessage: "暂停请求已写入 detached run 控制文件。"
    }) || result;
  }
  return result;
}

function handleResumeRunTool(args) {
  const result = resumeRecommendPipelineRunTool({ args });
  if (result?.status === "FAILED" && result?.error?.code === "RUN_NOT_ACTIVE") {
    return patchDetachedRecommendControl(args, {
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    }, {
      status: "RESUME_REQUESTED",
      message: "恢复请求已写入 detached run 控制文件。",
      lastMessage: "恢复请求已写入 detached run 控制文件。"
    }) || result;
  }
  return result;
}

function handleGetFeaturedCalibrationStatusTool(workspaceRoot) {
  const resolution = getFeaturedCalibrationResolution(workspaceRoot);
  return {
    status: "CALIBRATION_STATUS",
    ready: resolution.calibration_usable === true,
    calibration_path: resolution.calibration_path,
    calibration_exists: resolution.calibration_exists,
    calibration_usable: resolution.calibration_usable,
    calibration_script_path: resolution.calibration_script_path,
    message: resolution.calibration_usable
      ? "精选页收藏校准文件可用。"
      : "精选页收藏校准文件不存在或无效。"
  };
}

async function handleRunFeaturedCalibrationTool({ workspaceRoot, args }) {
  return {
    status: "FAILED",
    error: {
      code: featuredCalibrationUnsupportedCode,
      message: "run_featured_calibration is fenced during the CDP-only rewrite because the legacy handler delegates to Runtime/page-JS adapter calibration. A replacement must discover and validate featured detail/action controls with CDP DOM/Input only and pass a user-approved live safe-action gate before this tool is re-enabled.",
      retryable: false
    },
    cdp_only: true,
    runtime_evaluate_used: false,
    method_summary: {},
    method_log: [],
    port: args.port ?? null,
    timeout_ms: args.timeout_ms ?? null,
    output: args.output ?? null,
    calibration_resolution: getFeaturedCalibrationResolution(workspaceRoot),
    guidance: {
      current_workaround: "Use an existing favorite-calibration.json if present; get_featured_calibration_status reports whether it is usable.",
      next_development_task: "Implement CDP-only featured calibration with explicit user approval for any calibration click."
    }
  };
}

async function resolveRecommendSelfHealRootsWithRetry(client, config, {
  timeoutMs = 30000,
  intervalMs = 1000
} = {}) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt <= timeoutMs) {
    lastState = await resolveRecommendSelfHealRoots(client, config);
    if (lastState?.roots?.top && lastState?.roots?.frame) return lastState;
    await sleepMs(intervalMs);
  }
  return lastState;
}

async function handleRunRecommendSelfHealTool({ workspaceRoot, args }) {
  if (typeof runSelfHealImpl === "function") {
    return runSelfHealImpl({ workspaceRoot, args });
  }

  const mode = normalizeText(args.mode || "scan").toLowerCase() || "scan";
  if (mode === "apply") {
    return {
      status: "FAILED",
      error: {
        code: recommendSelfHealApplyUnsupportedCode,
        message: "run_recommend_self_heal apply mode is fenced during the CDP-only rewrite. The shared CDP self-heal scan route is available, but repair application needs a dedicated safe-action/live-review gate before it can mutate browser or project state.",
        retryable: false
      },
      cdp_only: true,
      runtime_evaluate_used: false,
      method_summary: {},
      method_log: [],
      guidance: {
        supported_mode: "scan",
        next_development_task: "Add config-driven CDP-only repair sessions with explicit user approval and live verification before re-enabling apply mode."
      }
    };
  }

  const host = "127.0.0.1";
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const port = parsePositiveInteger(args.port, configResolution.ok ? configResolution.config.debugPort : 9222);
  let session = null;
  try {
    session = await connectToChromeTarget({
      host,
      port,
      targetUrlIncludes: recommendTargetUrl
    });
    const { client, methodLog, target } = session;
    await enableDomains(client, ["Page", "DOM", "Accessibility"]);
    await bringPageToFront(client);

    const config = buildRecommendSelfHealConfig();
    const rootState = await resolveRecommendSelfHealRootsWithRetry(client, config);
    const check = await runSelfHealCheck({
      client,
      domain: "recommend",
      roots: rootState?.roots || {},
      selectorProbes: config.selectorProbes,
      accessibilityProbes: config.accessibilityProbes,
      viewportProbes: config.viewportProbes
    });
    assertNoForbiddenCdpCalls(methodLog);

    const healthy = check.status === HEALTH_STATUS.HEALTHY;
    return {
      status: healthy ? "OK" : "DEGRADED",
      cdp_only: true,
      runtime_evaluate_used: false,
      workspace_root: workspaceRoot,
      chrome: {
        host,
        port,
        target: {
          id: target?.id || null,
          type: target?.type || null,
          url: target?.url || null,
          title: target?.title || null
        }
      },
      mode,
      scope: normalizeText(args.scope || "full") || "full",
      validation_profile: normalizeText(args.validation_profile || "full") || "full",
      self_heal: {
        recommend: compactSelfHealCheck(check)
      },
      method_summary: buildCdpMethodSummary(methodLog),
      method_log: methodLog
    };
  } catch (error) {
    const methodLog = session?.methodLog || [];
    return {
      status: "FAILED",
      error: {
        code: "RECOMMEND_SELF_HEAL_CDP_FAILED",
        message: error?.message || String(error),
        retryable: true
      },
      cdp_only: true,
      runtime_evaluate_used: methodLog.some((entry) => String(entry?.method || entry).startsWith("Runtime.")),
      method_summary: buildCdpMethodSummary(methodLog),
      method_log: methodLog,
      chrome: { host, port, target_url_includes: recommendTargetUrl }
    };
  } finally {
    if (session) await session.close();
  }
}

async function handleBossChatHealthCheckTool(workspaceRoot, args) {
  return bossChatHealthCheckTool({ workspaceRoot, args });
}

async function handleBossChatPrepareRunTool({ workspaceRoot, args }) {
  return prepareBossChatRunTool({ workspaceRoot, args });
}

async function handleBossChatStartRunTool({ workspaceRoot, args }) {
  if (shouldStartChatDetached({ workspaceRoot })) {
    return startBossChatDetachedRunTool({ workspaceRoot, args });
  }
  return startBossChatRunTool({ workspaceRoot, args });
}

async function handleBossChatGetRunTool({ workspaceRoot, args }) {
  return getBossChatRunTool({ workspaceRoot, args });
}

async function handleBossChatPauseRunTool({ workspaceRoot, args }) {
  return pauseBossChatRunTool({ workspaceRoot, args });
}

async function handleBossChatResumeRunTool({ workspaceRoot, args }) {
  return resumeBossChatRunTool({ workspaceRoot, args });
}

async function handleBossChatCancelRunTool({ workspaceRoot, args }) {
  return cancelBossChatRunTool({ workspaceRoot, args });
}

async function handleRequest(message, workspaceRoot) {
  if (!message || message.jsonrpc !== "2.0") {
    return createJsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }

  const { id, method, params } = message;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      }
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: createToolsSchema()
      }
    };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if ([TOOL_RUN_RECOMMEND, TOOL_START_RUN].includes(toolName)) {
      const inputError = validateRunArgs(args);
      if (inputError) {
        return createJsonRpcError(id, -32602, inputError);
      }
    }

    if ([TOOL_RUN_RECRUIT_PIPELINE, TOOL_START_RECRUIT_PIPELINE_RUN].includes(toolName)) {
      const inputError = validateRecruitPipelineArgs(args);
      if (inputError) {
        return createJsonRpcError(id, -32602, inputError);
      }
    }

    if (toolName === TOOL_RUN_FEATURED_CALIBRATION) {
      const inputError = validateRunFeaturedCalibrationArgs(args);
      if (inputError) {
        return createJsonRpcError(id, -32602, inputError);
      }
    }

    if (toolName === TOOL_RUN_RECOMMEND_SELF_HEAL) {
      const inputError = validateRunRecommendSelfHealArgs(args);
      if (inputError) {
        return createJsonRpcError(id, -32602, inputError);
      }
    }

    if ([TOOL_BOSS_CHAT_PREPARE_RUN, TOOL_BOSS_CHAT_START_RUN].includes(toolName)) {
      const inputError = validateBossChatStartArgs(args);
      if (inputError) {
        return createJsonRpcError(id, -32602, inputError);
      }
    }

    if ([
      TOOL_GET_RUN,
      TOOL_CANCEL_RUN,
      TOOL_PAUSE_RUN,
      TOOL_RESUME_RUN,
      TOOL_BOSS_CHAT_GET_RUN,
      TOOL_BOSS_CHAT_CANCEL_RUN,
      TOOL_BOSS_CHAT_PAUSE_RUN,
      TOOL_BOSS_CHAT_RESUME_RUN,
      TOOL_GET_RECRUIT_PIPELINE_RUN,
      TOOL_CANCEL_RECRUIT_PIPELINE_RUN,
      TOOL_PAUSE_RECRUIT_PIPELINE_RUN,
      TOOL_RESUME_RECRUIT_PIPELINE_RUN
    ].includes(toolName)) {
      if (!args || typeof args.run_id !== "string" || !normalizeText(args.run_id)) {
        return createJsonRpcError(id, -32602, "run_id is required and must be a string");
      }
    }

    try {
      let payload;
      if (toolName === TOOL_LIST_RECOMMEND_JOBS) {
        payload = await listRecommendJobsTool({ workspaceRoot, args });
      } else if (toolName === TOOL_PREPARE_RUN) {
        payload = prepareRecommendPipelineRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_SCHEDULE_RUN) {
        payload = await scheduleRecommendPipelineRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_GET_SCHEDULED_RUN) {
        payload = getRecommendScheduledRunTool({ args });
      } else if ([TOOL_RUN_RECOMMEND, TOOL_START_RUN].includes(toolName)) {
        payload = await handleStartRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_GET_RUN) {
        payload = handleGetRunTool(args);
      } else if (toolName === TOOL_CANCEL_RUN) {
        payload = handleCancelRunTool(args);
      } else if (toolName === TOOL_PAUSE_RUN) {
        payload = handlePauseRunTool(args);
      } else if (toolName === TOOL_RESUME_RUN) {
        payload = handleResumeRunTool(args);
      } else if (toolName === TOOL_GET_FEATURED_CALIBRATION_STATUS) {
        payload = await handleGetFeaturedCalibrationStatusTool(workspaceRoot);
      } else if (toolName === TOOL_RUN_FEATURED_CALIBRATION) {
        payload = await handleRunFeaturedCalibrationTool({ workspaceRoot, args });
      } else if (toolName === TOOL_RUN_RECOMMEND_SELF_HEAL) {
        payload = await handleRunRecommendSelfHealTool({ workspaceRoot, args });
      } else if (toolName === TOOL_BOSS_CHAT_HEALTH_CHECK) {
        payload = await handleBossChatHealthCheckTool(workspaceRoot, args);
      } else if (toolName === TOOL_BOSS_CHAT_PREPARE_RUN) {
        payload = await handleBossChatPrepareRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_BOSS_CHAT_START_RUN) {
        payload = await handleBossChatStartRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_BOSS_CHAT_GET_RUN) {
        payload = await handleBossChatGetRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_BOSS_CHAT_PAUSE_RUN) {
        payload = await handleBossChatPauseRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_BOSS_CHAT_RESUME_RUN) {
        payload = await handleBossChatResumeRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_BOSS_CHAT_CANCEL_RUN) {
        payload = await handleBossChatCancelRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_RUN_RECRUIT_PIPELINE) {
        payload = normalizeText(args.execution_mode || "").toLowerCase() === "sync"
          ? await runRecruitPipelineTool({ workspaceRoot, args })
          : shouldStartRecruitDetached({ workspaceRoot })
            ? await startRecruitPipelineDetachedRunTool({ workspaceRoot, args })
            : await runRecruitPipelineTool({ workspaceRoot, args });
      } else if (toolName === TOOL_START_RECRUIT_PIPELINE_RUN) {
        payload = shouldStartRecruitDetached({ workspaceRoot })
          ? await startRecruitPipelineDetachedRunTool({ workspaceRoot, args })
          : await startRecruitPipelineRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_GET_RECRUIT_PIPELINE_RUN) {
        payload = getRecruitPipelineRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_CANCEL_RECRUIT_PIPELINE_RUN) {
        payload = cancelRecruitPipelineRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_PAUSE_RECRUIT_PIPELINE_RUN) {
        payload = pauseRecruitPipelineRunTool({ workspaceRoot, args });
      } else if (toolName === TOOL_RESUME_RECRUIT_PIPELINE_RUN) {
        payload = resumeRecruitPipelineRunTool({ workspaceRoot, args });
      } else {
        return createJsonRpcError(id, -32602, `Unknown tool: ${toolName || ""}`);
      }
      const isError = payload?.status === "FAILED";
      return createToolResultResponse(id, payload, isError);
    } catch (error) {
      const failed = {
        status: "FAILED",
        error: {
          code: "UNEXPECTED_ERROR",
          message: error?.message || "Unexpected error",
          retryable: true
        }
      };
      return createToolResultResponse(id, failed, true);
    }
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (id === undefined || id === null) {
    return null;
  }
  return createJsonRpcError(id, -32601, `Method not found: ${method}`);
}

export function startServer() {
  const envRoot = process.env.BOSS_WORKSPACE_ROOT;
  const workspaceRoot = envRoot
    ? path.resolve(envRoot)
    : process.env.INIT_CWD
      ? path.resolve(process.env.INIT_CWD)
      : path.resolve(process.cwd());
  let buffer = Buffer.alloc(0);
  let framing = FRAMING_UNKNOWN;

  process.stdin.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      buffer = buffer.slice(3);
    }

    while (true) {
      const crlfHeaderEnd = buffer.indexOf("\r\n\r\n");
      const lfHeaderEnd = buffer.indexOf("\n\n");
      const crHeaderEnd = buffer.indexOf("\r\r");
      let headerEnd = -1;
      let headerSeparatorLength = 0;
      if (
        crlfHeaderEnd !== -1
        && (lfHeaderEnd === -1 || crlfHeaderEnd < lfHeaderEnd)
        && (crHeaderEnd === -1 || crlfHeaderEnd < crHeaderEnd)
      ) {
        headerEnd = crlfHeaderEnd;
        headerSeparatorLength = 4;
      } else if (lfHeaderEnd !== -1 && (crHeaderEnd === -1 || lfHeaderEnd < crHeaderEnd)) {
        headerEnd = lfHeaderEnd;
        headerSeparatorLength = 2;
      } else if (crHeaderEnd !== -1) {
        headerEnd = crHeaderEnd;
        headerSeparatorLength = 2;
      }
      if (headerEnd !== -1) {
        const headerText = buffer.slice(0, headerEnd).toString("utf8");
        const contentLengthLine = headerText
          .split(/\r\n|\n|\r/)
          .find((line) => line.toLowerCase().startsWith("content-length:"));

        if (!contentLengthLine) {
          buffer = buffer.slice(headerEnd + headerSeparatorLength);
          continue;
        }

        const contentLength = Number.parseInt(contentLengthLine.split(":")[1].trim(), 10);
        if (!Number.isFinite(contentLength) || contentLength < 0) {
          buffer = buffer.slice(headerEnd + headerSeparatorLength);
          continue;
        }

        const bodyStart = headerEnd + headerSeparatorLength;
        const bodyEnd = bodyStart + contentLength;
        if (buffer.length < bodyEnd) break;

        const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
        buffer = buffer.slice(bodyEnd);
        framing = FRAMING_HEADER;

        let message;
        try {
          message = JSON.parse(body);
        } catch {
          writeMessage(createJsonRpcError(null, -32700, "Parse error"), FRAMING_HEADER);
          continue;
        }

        const response = await handleRequest(message, workspaceRoot);
        if (response) writeMessage(response, framing);
        continue;
      }

      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const rawLine = buffer.slice(0, newlineIndex).toString("utf8").replace(/\r$/, "");
      if (/^\s*content-length:/i.test(rawLine)) break;
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.trim();
      if (!line) continue;
      framing = FRAMING_LINE;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        writeMessage(createJsonRpcError(null, -32700, "Parse error"), FRAMING_LINE);
        continue;
      }

      const response = await handleRequest(message, workspaceRoot);
      if (response) writeMessage(response, framing);
    }
  });
}

export const __testables = {
  handleRequest,
  runDetachedWorkerForTests(options = {}) {
    return runDetachedWorker(options);
  },
  setSpawnProcessImplForTests(nextImpl) {
    spawnProcessImpl = typeof nextImpl === "function" ? nextImpl : spawn;
  },
  setRunPipelineImplForTests(nextImpl) {
    runPipelineImpl = typeof nextImpl === "function" ? nextImpl : null;
  },
  setRunSelfHealImplForTests(nextImpl) {
    runSelfHealImpl = typeof nextImpl === "function" ? nextImpl : null;
  },
  setRecommendMcpConnectorForTests(nextImpl) {
    __setRecommendMcpConnectorForTests(nextImpl);
  },
  setRecommendMcpJobReaderForTests(nextImpl) {
    __setRecommendMcpJobReaderForTests(nextImpl);
  },
  setRecommendMcpWorkflowForTests(nextImpl) {
    __setRecommendMcpWorkflowForTests(nextImpl);
  },
  resetRecommendMcpStateForTests() {
    __resetRecommendMcpStateForTests();
  },
  setRecommendSchedulerSpawnForTests(nextImpl) {
    __setRecommendSchedulerSpawnForTests(nextImpl);
  },
  runScheduledRecommendWorkerForTests(options = {}) {
    return runScheduledRecommendWorker(options);
  },
  setChatMcpConnectorForTests(nextImpl) {
    forceChatInProcForTests = typeof nextImpl === "function";
    __setChatMcpConnectorForTests(nextImpl);
  },
  setChatMcpJobReaderForTests(nextImpl) {
    __setChatMcpJobReaderForTests(nextImpl);
  },
  setChatMcpWorkflowForTests(nextImpl) {
    forceChatInProcForTests = typeof nextImpl === "function";
    __setChatMcpWorkflowForTests(nextImpl);
  },
  resetChatMcpStateForTests() {
    forceChatInProcForTests = false;
    __resetChatMcpStateForTests();
  },
  setRecruitMcpConnectorForTests(nextImpl) {
    forceRecruitInProcForTests = typeof nextImpl === "function";
    __setRecruitMcpConnectorForTests(nextImpl);
  },
  setRecruitMcpWorkflowForTests(nextImpl) {
    forceRecruitInProcForTests = typeof nextImpl === "function";
    __setRecruitMcpWorkflowForTests(nextImpl);
  },
  resetRecruitMcpStateForTests() {
    forceRecruitInProcForTests = false;
    __resetRecruitMcpStateForTests();
  }
};

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFilePath) {
  const detachedWorkerOptions = parseDetachedWorkerOptions(process.argv.slice(2));
  if (detachedWorkerOptions) {
    installDetachedWorkerFailureHandlers(detachedWorkerOptions.runId);
    runDetachedWorker({
      runId: detachedWorkerOptions.runId,
      resumeRun: detachedWorkerOptions.resumeRun
    }).then((result) => {
      if (!result?.ok) {
        process.exitCode = 1;
      }
    }).catch((error) => {
      console.error("[boss-recommend-mcp] detached worker failed", error);
      markDetachedWorkerFailed(detachedWorkerOptions.runId, error);
      process.exitCode = 1;
    });
  } else {
    startServer();
  }
}
