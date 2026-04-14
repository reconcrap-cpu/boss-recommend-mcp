import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  getFeaturedCalibrationResolution,
  runRecommendCalibration
} from "./adapters.js";
import {
  cancelBossChatRun,
  getBossChatHealthCheck,
  getBossChatRun,
  pauseBossChatRun,
  resumeBossChatRun,
  startBossChatRun
} from "./boss-chat.js";
import { runRecommendPipeline } from "./pipeline.js";
import { runRecommendSelfHeal } from "./self-heal.js";
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

const TOOL_START_RUN = "start_recommend_pipeline_run";
const TOOL_GET_RUN = "get_recommend_pipeline_run";
const TOOL_CANCEL_RUN = "cancel_recommend_pipeline_run";
const TOOL_PAUSE_RUN = "pause_recommend_pipeline_run";
const TOOL_RESUME_RUN = "resume_recommend_pipeline_run";
const TOOL_RUN_FEATURED_CALIBRATION = "run_featured_calibration";
const TOOL_GET_FEATURED_CALIBRATION_STATUS = "get_featured_calibration_status";
const TOOL_RUN_RECOMMEND_SELF_HEAL = "run_recommend_self_heal";
const TOOL_BOSS_CHAT_HEALTH_CHECK = "boss_chat_health_check";
const TOOL_BOSS_CHAT_START_RUN = "start_boss_chat_run";
const TOOL_BOSS_CHAT_GET_RUN = "get_boss_chat_run";
const TOOL_BOSS_CHAT_PAUSE_RUN = "pause_boss_chat_run";
const TOOL_BOSS_CHAT_RESUME_RUN = "resume_boss_chat_run";
const TOOL_BOSS_CHAT_CANCEL_RUN = "cancel_boss_chat_run";

const SERVER_NAME = "boss-recommend-mcp";
const FRAMING_UNKNOWN = "unknown";
const FRAMING_HEADER = "header";
const FRAMING_LINE = "line";
const DETACHED_WORKER_FLAG = "--detached-worker";
const DETACHED_WORKER_RUN_ID_FLAG = "--run-id";
const DETACHED_WORKER_RESUME_FLAG = "--resume";

let runPipelineImpl = runRecommendPipeline;
let runSelfHealImpl = runRecommendSelfHeal;
let spawnProcessImpl = spawn;
const TERMINAL_RUN_STATES = new Set([RUN_STATE_COMPLETED, RUN_STATE_FAILED, RUN_STATE_CANCELED]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isUnlimitedTargetCountToken(value) {
  const token = normalizeText(value).toLowerCase();
  if (!token) return false;
  return [
    "all",
    "unlimited",
    "infinity",
    "inf",
    "max",
    "full",
    "全部",
    "全量",
    "不限",
    "扫到底",
    "直到完成所有人选"
  ].includes(token);
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
    checkpoint_path: path.join(getRunsDir(), `${normalizedRunId}.checkpoint.json`)
  };
}

function buildRunContext(workspaceRoot, args = {}) {
  return {
    workspace_root: path.resolve(workspaceRoot),
    instruction: String(args?.instruction || ""),
    confirmation: args?.confirmation && typeof args.confirmation === "object" ? args.confirmation : {},
    overrides: args?.overrides && typeof args.overrides === "object" ? args.overrides : {},
    follow_up: args?.follow_up && typeof args.follow_up === "object" ? args.follow_up : null
  };
}

function resolveRunContext(snapshot) {
  const workspaceRoot = normalizeText(snapshot?.context?.workspace_root || "");
  const instruction = typeof snapshot?.context?.instruction === "string"
    ? snapshot.context.instruction
    : "";
  if (!workspaceRoot || !instruction.trim()) return null;
  return {
    workspaceRoot,
    args: {
      instruction,
      confirmation: snapshot?.context?.confirmation && typeof snapshot.context.confirmation === "object"
        ? snapshot.context.confirmation
        : {},
      overrides: snapshot?.context?.overrides && typeof snapshot.context.overrides === "object"
        ? snapshot.context.overrides
        : {},
      follow_up: snapshot?.context?.follow_up && typeof snapshot.context.follow_up === "object"
        ? snapshot.context.follow_up
        : null
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
            enum: ["favorite", "greet", "none"]
          },
          final_confirmed: { type: "boolean" },
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
            enum: ["favorite", "greet", "none"]
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
              target_count: {
                oneOf: [
                  {
                    type: "integer",
                    minimum: 1
                  },
                  {
                    type: "string",
                    enum: ["all", "unlimited", "全部", "不限", "扫到底", "全量"]
                  }
                ]
              },
              dry_run: { type: "boolean" },
              no_state: { type: "boolean" },
              safe_pacing: { type: "boolean" },
              batch_rest_enabled: { type: "boolean" }
            },
            additionalProperties: false
          }
        },
        additionalProperties: false
      }
    },
    required: ["instruction"],
    additionalProperties: false
  };
}

function createBossChatStartInputSchema() {
  return {
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
      target_count: {
        oneOf: [
          {
            type: "integer",
            minimum: 1
          },
          {
            type: "string",
            enum: ["all", "unlimited", "全部", "不限", "扫到底", "全量"]
          }
        ],
        description: "本次处理人数上限；支持正整数或 all/不限（扫到底）"
      },
      port: {
        type: "integer",
        minimum: 1,
        description: "可选，覆盖 Chrome 调试端口；未传时读取 screening-config.json.debugPort"
      },
      dry_run: { type: "boolean" },
      no_state: { type: "boolean" },
      safe_pacing: { type: "boolean" },
      batch_rest_enabled: { type: "boolean" }
    },
    additionalProperties: false
  };
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

function createToolsSchema() {
  return [
    {
      name: TOOL_START_RUN,
      description: "异步启动 Boss 推荐页流水线（含同步门禁预检）；只有在前置确认与页面就绪通过后才返回 run_id。",
      inputSchema: createRunInputSchema()
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
      description: "检查内置 boss-chat 运行时与共享 screening-config.json 是否可用。",
      inputSchema: {
        type: "object",
        properties: {
          port: {
            type: "integer",
            minimum: 1
          }
        },
        additionalProperties: false
      }
    },
    {
      name: TOOL_BOSS_CHAT_START_RUN,
      description: "异步启动一次 boss-chat 任务。若缺少必填参数会先返回 NEED_INPUT（含岗位列表与待确认字段）。",
      inputSchema: createBossChatStartInputSchema()
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
  if (Object.prototype.hasOwnProperty.call(args, "target_count")) {
    const rawTargetCount = args.target_count;
    const targetCount = Number.parseInt(String(rawTargetCount), 10);
    const tokenAllowed =
      typeof rawTargetCount === "string" && isUnlimitedTargetCountToken(rawTargetCount);
    const numericUnlimited = Number.isFinite(targetCount) && targetCount === -1;
    if ((!Number.isFinite(targetCount) || targetCount <= 0) && !tokenAllowed && !numericUnlimited) {
      return "target_count must be a positive integer or one of: all, unlimited, 全部, 不限, 扫到底, 全量";
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
  const child = spawnProcessImpl(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env
  });
  if (typeof child?.unref === "function") {
    child.unref();
  }
  return child;
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
    result = await runPipelineImpl(
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
        code: "UNEXPECTED_ERROR",
        message: error?.message || "Unexpected error",
        retryable: true
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

  await executeTrackedPipeline({
    runId: normalizedRunId,
    mode: RUN_MODE_ASYNC,
    workspaceRoot: executionContext.workspaceRoot,
    args: executionContext.args,
    signal: new AbortController().signal,
    resumeRun
  });
  return { ok: true };
}

async function handleStartRunTool({ workspaceRoot, args }) {
  const precheckArgs = buildAsyncPrecheckArgs(args);
  let precheckResult;
  try {
    precheckResult = await runPipelineImpl(
      {
        workspaceRoot,
        instruction: precheckArgs.instruction,
        confirmation: precheckArgs.confirmation,
        overrides: precheckArgs.overrides,
        followUp: precheckArgs.follow_up
      },
      undefined,
      null
    );
  } catch (error) {
    precheckResult = {
      status: "FAILED",
      error: {
        code: "UNEXPECTED_ERROR",
        message: error?.message || "Unexpected error",
        retryable: true
      }
    };
  }

  if (precheckResult?.status !== "NEED_CONFIRMATION") {
    return precheckResult;
  }
  if (!hasExplicitFinalConfirmation(args) || !isFinalReviewOnlyConfirmation(precheckResult)) {
    return precheckResult;
  }

  cleanupExpiredRuns();
  const runId = createRunId();
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
    worker = launchDetachedRunWorker({
      runId,
      resumeRun: false
    });
  } catch (error) {
    const failedMessage = `无法启动 detached 运行进程：${error?.message || "unknown"}`;
    safeUpdateRunState(runId, {
      state: RUN_STATE_FAILED,
      stage: RUN_STAGE_PREFLIGHT,
      last_message: failedMessage,
      error: {
        code: "RUN_WORKER_LAUNCH_FAILED",
        message: failedMessage,
        retryable: true
      },
      result: buildWorkerLaunchFailedPayload(failedMessage)
    });
    return buildWorkerLaunchFailedPayload(failedMessage);
  }

  safeUpdateRunState(runId, {
    pid: worker?.pid,
    state: "queued",
    last_message: "异步流水线已启动（detached）。"
  });

  return {
    status: "ACCEPTED",
    run_id: runId,
    state: "queued",
    poll_after_sec: getRecommendedPollAfterSec(args),
    message: getDefaultAcceptedMessage(args)
  };
}

function handleGetRunTool(args) {
  cleanupExpiredRuns();
  const runId = normalizeText(args?.run_id);
  if (!runId) {
    return {
      status: "FAILED",
      error: {
        code: "INVALID_RUN_ID",
        message: "run_id is required",
        retryable: false
      }
    };
  }
  const snapshot = readRunState(runId);
  if (!snapshot) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_NOT_FOUND",
        message: `未找到 run_id=${runId} 的运行记录。`,
        retryable: false
      }
    };
  }
  const reconciled = reconcileOrphanRunIfNeeded(runId, snapshot);
  return {
    status: "RUN_STATUS",
    run: reconciled
  };
}

function handleCancelRunTool(args) {
  const runId = normalizeText(args?.run_id);
  if (!runId) {
    return {
      status: "FAILED",
      error: {
        code: "INVALID_RUN_ID",
        message: "run_id is required",
        retryable: false
      }
    };
  }
  const snapshot = readRunState(runId);
  if (!snapshot) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_NOT_FOUND",
        message: `未找到 run_id=${runId} 的运行记录。`,
        retryable: false
      }
    };
  }
  const reconciled = reconcileOrphanRunIfNeeded(runId, snapshot) || snapshot;

  if (TERMINAL_RUN_STATES.has(reconciled.state)) {
    return {
      status: "CANCEL_IGNORED",
      run: reconciled,
      message: "目标任务已结束，无需取消。"
    };
  }

  if (reconciled.state === RUN_STATE_PAUSED || !isProcessAlive(reconciled.pid)) {
    const canceledRun = finalizeCanceledRun(runId, reconciled);
    return {
      status: "CANCEL_REQUESTED",
      run: canceledRun
    };
  }
  safeUpdateRunState(runId, {
    stage: reconciled.stage || RUN_STAGE_PREFLIGHT,
    last_message: "已收到取消请求，将在当前候选人处理完成后安全停止并落盘 CSV。",
    control: {
      pause_requested: true,
      pause_requested_at: new Date().toISOString(),
      pause_requested_by: TOOL_CANCEL_RUN,
      cancel_requested: true
    }
  });

  const latest = readRunState(runId) || reconciled;
  return {
    status: "CANCEL_REQUESTED",
    run: latest
  };
}

function handlePauseRunTool(args) {
  const runId = normalizeText(args?.run_id);
  if (!runId) {
    return {
      status: "FAILED",
      error: {
        code: "INVALID_RUN_ID",
        message: "run_id is required",
        retryable: false
      }
    };
  }
  const snapshot = readRunState(runId);
  if (!snapshot) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_NOT_FOUND",
        message: `未找到 run_id=${runId} 的运行记录。`,
        retryable: false
      }
    };
  }
  const reconciled = reconcileOrphanRunIfNeeded(runId, snapshot) || snapshot;

  if (TERMINAL_RUN_STATES.has(reconciled.state)) {
    return {
      status: "PAUSE_IGNORED",
      run: reconciled,
      message: "目标任务已结束，无需暂停。"
    };
  }
  if (reconciled.state === RUN_STATE_PAUSED) {
    return {
      status: "PAUSE_IGNORED",
      run: reconciled,
      message: "目标任务已经处于 paused 状态。"
    };
  }

  const requestedRun = safeUpdateRunState(runId, {
    control: {
      pause_requested: true,
      pause_requested_at: new Date().toISOString(),
      pause_requested_by: TOOL_PAUSE_RUN,
      cancel_requested: false
    },
    last_message: "已收到暂停请求，将在当前候选人处理完成后暂停。"
  }) || readRunState(runId) || reconciled;
  return {
    status: "PAUSE_REQUESTED",
    run: requestedRun,
    message: "暂停请求已接收，将在当前候选人处理完成后进入 paused。"
  };
}

function handleResumeRunTool(args) {
  const runId = normalizeText(args?.run_id);
  if (!runId) {
    return {
      status: "FAILED",
      error: {
        code: "INVALID_RUN_ID",
        message: "run_id is required",
        retryable: false
      }
    };
  }
  const snapshot = readRunState(runId);
  if (!snapshot) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_NOT_FOUND",
        message: `未找到 run_id=${runId} 的运行记录。`,
        retryable: false
      }
    };
  }
  const reconciled = reconcileOrphanRunIfNeeded(runId, snapshot) || snapshot;
  if (TERMINAL_RUN_STATES.has(reconciled.state)) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_ALREADY_TERMINATED",
        message: "目标任务已结束，无法继续。",
        retryable: false
      }
    };
  }
  if (reconciled.state !== RUN_STATE_PAUSED) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_NOT_PAUSED",
        message: "仅 paused 状态的 run 才能继续。",
        retryable: true
      },
      run: reconciled
    };
  }

  const executionContext = resolveRunContext(reconciled);
  if (!executionContext) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_CONTEXT_MISSING",
        message: "run 缺少可恢复的执行上下文，无法继续。",
        retryable: false
      }
    };
  }

  const updated = safeUpdateRunState(runId, (current) => ({
    state: "queued",
    last_message: "已收到继续请求，准备恢复执行。",
    control: {
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    },
    resume: {
      checkpoint_path: current?.resume?.checkpoint_path || getRunArtifacts(runId).checkpoint_path,
      pause_control_path: current?.resume?.pause_control_path || getRunArtifacts(runId).run_state_path,
      output_csv: current?.resume?.output_csv || null,
      resume_count: Number.isInteger(current?.resume?.resume_count) ? current.resume.resume_count + 1 : 1,
      last_resumed_at: new Date().toISOString()
    }
  })) || readRunState(runId) || reconciled;

  let worker;
  try {
    worker = launchDetachedRunWorker({
      runId,
      resumeRun: true
    });
  } catch (error) {
    const failedMessage = `无法启动 detached 恢复进程：${error?.message || "unknown"}`;
    safeUpdateRunState(runId, {
      state: RUN_STATE_FAILED,
      stage: reconciled.stage || RUN_STAGE_PREFLIGHT,
      last_message: failedMessage,
      error: {
        code: "RUN_WORKER_LAUNCH_FAILED",
        message: failedMessage,
        retryable: true
      },
      result: buildWorkerLaunchFailedPayload(failedMessage)
    });
    return buildWorkerLaunchFailedPayload(failedMessage);
  }

  const started = safeUpdateRunState(runId, {
    pid: worker?.pid,
    state: "queued",
    last_message: "已恢复 Recommend 流水线（detached）。"
  }) || readRunState(runId) || updated;

  return {
    status: "RESUME_REQUESTED",
    run: started,
    poll_after_sec: getRecommendedPollAfterSec(executionContext?.args || {}),
    message: hasFollowUpChatRequest(executionContext?.args || {})
      ? "已恢复 Recommend 流水线（detached）。recommend+chat 联动任务建议按 30 分钟间隔查询状态；手动查询到完成时会立即衔接聊天流程。"
      : "已恢复 Recommend 流水线（detached）。默认不自动轮询；如需进度请按需调用 get_recommend_pipeline_run。"
  };
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
  const result = await runRecommendCalibration(workspaceRoot, {
    port: args.port,
    timeoutMs: args.timeout_ms,
    output: args.output
  });

  if (!result?.ok) {
    return {
      status: "FAILED",
      error: {
        code: result?.error?.code || "CALIBRATION_REQUIRED",
        message: result?.error?.message || "精选页收藏校准失败，请在推荐页精选 tab 打开候选人详情后点击收藏按钮再重试。",
        retryable: true
      },
      calibration_path: result?.calibration_path || null,
      calibration_script_path: result?.calibration_script_path || null,
      debug_port: result?.debug_port || null,
      diagnostics: {
        stdout_last_line: getLastOutputLine(result?.stdout),
        stderr_last_line: getLastOutputLine(result?.stderr)
      }
    };
  }

  return {
    status: "CALIBRATED",
    message: "精选页收藏按钮校准完成，可重新执行 start_recommend_pipeline_run。",
    calibration_path: result.calibration_path,
    calibration_script_path: result.calibration_script_path,
    debug_port: result.debug_port
  };
}

async function handleRunRecommendSelfHealTool({ workspaceRoot, args }) {
  return runSelfHealImpl({ workspaceRoot, args });
}

function handleBossChatHealthCheckTool(workspaceRoot, args) {
  return getBossChatHealthCheck(workspaceRoot, args);
}

async function handleBossChatStartRunTool({ workspaceRoot, args }) {
  return startBossChatRun({ workspaceRoot, input: args });
}

async function handleBossChatGetRunTool({ workspaceRoot, args }) {
  return getBossChatRun({ workspaceRoot, input: args });
}

async function handleBossChatPauseRunTool({ workspaceRoot, args }) {
  return pauseBossChatRun({ workspaceRoot, input: args });
}

async function handleBossChatResumeRunTool({ workspaceRoot, args }) {
  return resumeBossChatRun({ workspaceRoot, input: args });
}

async function handleBossChatCancelRunTool({ workspaceRoot, args }) {
  return cancelBossChatRun({ workspaceRoot, input: args });
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

    if (toolName === TOOL_START_RUN) {
      const inputError = validateRunArgs(args);
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

    if (toolName === TOOL_BOSS_CHAT_START_RUN) {
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
      TOOL_BOSS_CHAT_RESUME_RUN
    ].includes(toolName)) {
      if (!args || typeof args.run_id !== "string" || !normalizeText(args.run_id)) {
        return createJsonRpcError(id, -32602, "run_id is required and must be a string");
      }
    }

    try {
      let payload;
      if (toolName === TOOL_START_RUN) {
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
        payload = handleGetFeaturedCalibrationStatusTool(workspaceRoot);
      } else if (toolName === TOOL_RUN_FEATURED_CALIBRATION) {
        payload = await handleRunFeaturedCalibrationTool({ workspaceRoot, args });
      } else if (toolName === TOOL_RUN_RECOMMEND_SELF_HEAL) {
        payload = await handleRunRecommendSelfHealTool({ workspaceRoot, args });
      } else if (toolName === TOOL_BOSS_CHAT_HEALTH_CHECK) {
        payload = handleBossChatHealthCheckTool(workspaceRoot, args);
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
    runPipelineImpl = typeof nextImpl === "function" ? nextImpl : runRecommendPipeline;
  },
  setRunSelfHealImplForTests(nextImpl) {
    runSelfHealImpl = typeof nextImpl === "function" ? nextImpl : runRecommendSelfHeal;
  }
};

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFilePath) {
  const detachedWorkerOptions = parseDetachedWorkerOptions(process.argv.slice(2));
  if (detachedWorkerOptions) {
    runDetachedWorker({
      runId: detachedWorkerOptions.runId,
      resumeRun: detachedWorkerOptions.resumeRun
    }).then((result) => {
      if (!result?.ok) {
        process.exitCode = 1;
      }
    }).catch(() => {
      process.exitCode = 1;
    });
  } else {
    startServer();
  }
}
