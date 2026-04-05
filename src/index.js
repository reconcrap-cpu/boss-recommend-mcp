import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runRecommendPipeline } from "./pipeline.js";
import {
  RUN_MODE_ASYNC,
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

const SERVER_NAME = "boss-recommend-mcp";
const FRAMING_UNKNOWN = "unknown";
const FRAMING_HEADER = "header";
const FRAMING_LINE = "line";

const activeAsyncRuns = new Map();
let runPipelineImpl = runRecommendPipeline;
const TERMINAL_RUN_STATES = new Set([RUN_STATE_COMPLETED, RUN_STATE_FAILED, RUN_STATE_CANCELED]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parsePositiveInteger(raw, fallback) {
  const value = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getDefaultPollAfterSec() {
  const fromEnv = parsePositiveInteger(process.env.BOSS_RECOMMEND_POLL_AFTER_SEC, 10);
  return Math.max(5, Math.min(15, fromEnv));
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
    overrides: args?.overrides && typeof args.overrides === "object" ? args.overrides : {}
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
        : {}
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
            enum: ["recommend", "featured"]
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
            enum: ["recommend", "featured"]
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
      }
    },
    required: ["instruction"],
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
    overrides: args.overrides
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

function reconcileOrphanRunIfNeeded(runId, snapshot) {
  if (!snapshot || TERMINAL_RUN_STATES.has(snapshot.state)) {
    return snapshot;
  }
  if (snapshot.state === RUN_STATE_PAUSED) {
    return snapshot;
  }
  if (activeAsyncRuns.has(runId)) {
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
    previous_completion_reason: getCompletionReasonFromResult(existingSnapshot?.result || null)
  };
  safeUpdateRunState(runId, {
    state: RUN_STATE_RUNNING,
    stage: RUN_STAGE_PREFLIGHT,
    last_message: resumeRun
      ? "流水线继续执行中，等待 preflight。"
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
        resume: resumeConfig
      },
      undefined,
      {
        signal,
        heartbeatIntervalMs,
        isPauseRequested: () => isRunPauseRequested(runId),
        onStage: runtimeCallbacks.onStage,
        onHeartbeat: runtimeCallbacks.onHeartbeat,
        onOutput: runtimeCallbacks.onOutput,
        onProgress: runtimeCallbacks.onProgress
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

function initializeRunStateOrThrow(runId, mode, workspaceRoot, args) {
  const artifacts = getRunArtifacts(runId);
  const snapshot = createRunStateSnapshot({
    runId,
    mode,
    state: "queued",
    stage: RUN_STAGE_PREFLIGHT,
    pid: process.pid,
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

function launchAsyncRun({ runId, mode, workspaceRoot, args, resumeRun = false }) {
  const abortController = new AbortController();
  const promise = executeTrackedPipeline({
    runId,
    mode,
    workspaceRoot,
    args,
    signal: abortController.signal,
    resumeRun
  }).finally(() => {
    activeAsyncRuns.delete(runId);
  });
  activeAsyncRuns.set(runId, {
    abortController,
    promise
  });
  return { abortController, promise };
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
        overrides: precheckArgs.overrides
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
    initializeRunStateOrThrow(runId, RUN_MODE_ASYNC, workspaceRoot, args);
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

  launchAsyncRun({
    runId,
    mode: RUN_MODE_ASYNC,
    workspaceRoot,
    args
  });

  return {
    status: "ACCEPTED",
    run_id: runId,
    state: "queued",
    poll_after_sec: getDefaultPollAfterSec(),
    message: "异步流水线已启动。默认不自动轮询；如需进度请按需调用 get_recommend_pipeline_run。"
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

  if (TERMINAL_RUN_STATES.has(snapshot.state)) {
    return {
      status: "CANCEL_IGNORED",
      run: snapshot,
      message: "目标任务已结束，无需取消。"
    };
  }

  if (snapshot.state === RUN_STATE_PAUSED) {
    const canceledResult = {
      status: "FAILED",
      error: {
        code: "PIPELINE_CANCELED",
        message: "流水线已取消。",
        retryable: true
      },
      partial_result: snapshot.result?.partial_result || snapshot.result?.result || null
    };
    const canceledRun = safeUpdateRunState(runId, {
      state: RUN_STATE_CANCELED,
      stage: snapshot.stage || RUN_STAGE_PREFLIGHT,
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
    return {
      status: "CANCEL_REQUESTED",
      run: canceledRun
    };
  }

  const activeRun = activeAsyncRuns.get(runId);
  if (!activeRun) {
    const canceledResult = {
      status: "FAILED",
      error: {
        code: "PIPELINE_CANCELED",
        message: "流水线已取消。",
        retryable: true
      },
      partial_result: snapshot.result?.partial_result || snapshot.result?.result || null
    };
    const canceledRun = safeUpdateRunState(runId, {
      state: RUN_STATE_CANCELED,
      stage: snapshot.stage || RUN_STAGE_PREFLIGHT,
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
    return {
      status: "CANCEL_REQUESTED",
      run: canceledRun
    };
  }
  safeUpdateRunState(runId, {
    stage: snapshot.stage || RUN_STAGE_PREFLIGHT,
    last_message: "已收到取消请求，将在当前候选人处理完成后安全停止并落盘 CSV。",
    control: {
      pause_requested: true,
      pause_requested_at: new Date().toISOString(),
      pause_requested_by: TOOL_CANCEL_RUN,
      cancel_requested: true
    }
  });

  const latest = readRunState(runId) || snapshot;
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

  if (TERMINAL_RUN_STATES.has(snapshot.state)) {
    return {
      status: "PAUSE_IGNORED",
      run: snapshot,
      message: "目标任务已结束，无需暂停。"
    };
  }
  if (snapshot.state === RUN_STATE_PAUSED) {
    return {
      status: "PAUSE_IGNORED",
      run: snapshot,
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
  }) || readRunState(runId) || snapshot;
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
  if (TERMINAL_RUN_STATES.has(snapshot.state)) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_ALREADY_TERMINATED",
        message: "目标任务已结束，无法继续。",
        retryable: false
      }
    };
  }
  if (snapshot.state !== RUN_STATE_PAUSED) {
    return {
      status: "FAILED",
      error: {
        code: "RUN_NOT_PAUSED",
        message: "仅 paused 状态的 run 才能继续。",
        retryable: true
      },
      run: snapshot
    };
  }
  if (activeAsyncRuns.has(runId)) {
    return {
      status: "RESUME_IGNORED",
      run: snapshot,
      message: "该 run 当前已在执行，无需继续。"
    };
  }

  const executionContext = resolveRunContext(snapshot);
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
  })) || readRunState(runId) || snapshot;

  launchAsyncRun({
    runId,
    mode: RUN_MODE_ASYNC,
    workspaceRoot: executionContext.workspaceRoot,
    args: executionContext.args,
    resumeRun: true
  });

  return {
    status: "RESUME_REQUESTED",
    run: updated,
    poll_after_sec: getDefaultPollAfterSec(),
    message: "已恢复 Recommend 流水线。默认不自动轮询；如需进度请按需调用 get_recommend_pipeline_run。"
  };
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

    if ([TOOL_GET_RUN, TOOL_CANCEL_RUN, TOOL_PAUSE_RUN, TOOL_RESUME_RUN].includes(toolName)) {
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
  activeAsyncRuns,
  setRunPipelineImplForTests(nextImpl) {
    runPipelineImpl = typeof nextImpl === "function" ? nextImpl : runRecommendPipeline;
  }
};

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFilePath) {
  startServer();
}
