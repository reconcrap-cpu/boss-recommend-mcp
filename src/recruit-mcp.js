import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  connectToChromeTargetOrOpen,
  createBossLoginRequiredError,
  detectBossLoginState,
  enableDomains,
  getMainFrameUrl,
  isBossLoginUrl,
  waitForMainFrameUrl,
  sleep
} from "./core/browser/index.js";
import {
  RUN_STATUS_CANCELING,
  RUN_STATUS_CANCELED,
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_PAUSED,
  RUN_STATUS_RUNNING
} from "./core/run/index.js";
import {
  buildLegacyScreenInputRows,
  cloneReportInput,
  writeLegacyScreenCsv
} from "./core/reporting/legacy-csv.js";
import {
  createRecruitRunService,
  parseRecruitInstruction,
  RECRUIT_TARGET_URL,
  runRecruitWorkflow,
  waitForRecruitSearchControls
} from "./domains/recruit/index.js";
import {
  resolveBossConfiguredOutputDir,
  resolveHumanBehaviorForRun,
  resolveBossScreeningConfig
} from "./chat-runtime-config.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "./core/cv-acquisition/index.js";
import {
  createBossMonitorSourceMarker,
  createBossMonitoringBlock,
  writeBossMonitorProjectionNonfatal
} from "./monitor/projection.js";
import {
  boundedWorkflowCheckpoint,
  compactWorkflowResultForState,
  getWorkflowCandidateJournalPath,
  reconstructWorkflowCandidateResults
} from "./core/run/workflow-candidate-journal.js";

const RUN_MODE_ASYNC = "async";
const RUN_MODE_SYNC = "sync";
const DEFAULT_RECRUIT_POLL_AFTER_SEC = 10;
const DEFAULT_RECRUIT_HOST = "127.0.0.1";
const DEFAULT_RECRUIT_PORT = 9222;
const TARGET_COUNT_SEMANTICS = "target_count means candidates that pass screening; scan continues until that many candidates pass or the list ends";
const DEFAULT_RECRUIT_HOME_DIR = ".boss-recruit-mcp";
const DETACHED_WORKER_SCRIPT = fileURLToPath(new URL("./detached-worker.js", import.meta.url));
const DETACHED_WORKER_POLL_MS = 1000;

const TERMINAL_STATUSES = new Set([
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_CANCELED
]);
const STALE_PROCESS_STATUSES = new Set([
  "queued",
  "running",
  RUN_STATUS_CANCELING
]);

let recruitWorkflowImpl = runRecruitWorkflow;
let recruitConnectorImpl = connectRecruitChromeSession;
let recruitRunService = createRecruitRunService({
  idPrefix: "mcp_recruit",
  workflow: (...args) => recruitWorkflowImpl(...args),
  onSnapshot: persistRecruitLifecycleSnapshot
});
const recruitRunMeta = new Map();

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parsePositiveInteger(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isDebugTestMode(args = {}) {
  return args.debug_test_mode === true || args.allow_debug_test_mode === true;
}

function normalizeScreeningModeArg(args = {}) {
  const raw = normalizeText(args.screening_mode || args.screeningMode || "");
  if (args.use_llm === false) return "deterministic";
  return ["deterministic", "local", "local_scorer"].includes(raw.toLowerCase())
    ? "deterministic"
    : "llm";
}

function collectRecruitDebugTestOptions(args = {}) {
  const reasons = [];
  if (normalizeScreeningModeArg(args) === "deterministic") reasons.push("deterministic_screening");
  if (parseNonNegativeInteger(args.detail_limit, null) === 0) reasons.push("detail_limit=0");
  if (args.dry_run_post_action === true) reasons.push("dry_run_post_action");
  if (args.execute_post_action === false) reasons.push("execute_post_action=false");
  return reasons;
}

function methodSummary(methodLog = []) {
  const summary = {};
  for (const entry of methodLog || []) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function normalizeExecutionMode(value) {
  return normalizeText(value).toLowerCase() === RUN_MODE_SYNC ? RUN_MODE_SYNC : RUN_MODE_ASYNC;
}

function clonePlain(value, fallback = null) {
  try {
    return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeRunId(runId) {
  const normalized = normalizeText(runId);
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) return "";
  return normalized;
}

function getRecruitStateHome() {
  const fromEnv = normalizeText(globalThis.process?.env?.BOSS_RECRUIT_HOME || "");
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), DEFAULT_RECRUIT_HOME_DIR);
}

function getRecruitRunsDir() {
  return path.join(getRecruitStateHome(), "runs");
}

function getRecruitRunArtifacts(runId) {
  const normalized = normalizeRunId(runId);
  if (!normalized) return null;
  const runsDir = getRecruitRunsDir();
  const outputDir = resolveBossConfiguredOutputDir("", runsDir);
  return {
    runs_dir: runsDir,
    output_dir: outputDir,
    run_state_path: path.join(runsDir, `${normalized}.json`),
    detached_args_path: path.join(runsDir, `${normalized}.detached-args.json`),
    worker_stdout_path: path.join(runsDir, `${normalized}.worker.stdout.log`),
    worker_stderr_path: path.join(runsDir, `${normalized}.worker.stderr.log`),
    checkpoint_path: path.join(runsDir, `${normalized}.checkpoint.json`),
    candidate_result_journal_path: getWorkflowCandidateJournalPath({
      runDir: runsDir,
      runId: normalized
    }),
    output_csv: path.join(outputDir, `${normalized}.results.csv`),
    report_json: path.join(outputDir, `${normalized}.report.json`)
  };
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function selectedRecruitJobForCsv(meta = {}) {
  const keyword = normalizeText(
    meta.parsed?.proposed_keyword
    || meta.parsed?.searchParams?.keyword
    || meta.args?.confirmation?.keyword_value
    || meta.args?.overrides?.keyword
    || ""
  );
  return {
    value: keyword,
    title: keyword,
    label: keyword
  };
}

function buildRecruitCsvInputRows(snapshot = {}, meta = {}) {
  const searchParams = meta.parsed?.searchParams || snapshot.summary?.search_params || {};
  const screenParams = meta.parsed?.screenParams || {};
  return buildLegacyScreenInputRows({
    instruction: meta.args?.instruction || "",
    selectedPage: "search",
    selectedJob: selectedRecruitJobForCsv(meta),
    userSearchParams: cloneReportInput(searchParams, {}),
    effectiveSearchParams: cloneReportInput(searchParams, {}),
    screenParams: {
      criteria: screenParams.criteria || "",
      target_count: screenParams.target_count || snapshot.progress?.target_count || snapshot.context?.max_candidates || "",
      post_action: screenParams.post_action || "none",
      max_greet_count: screenParams.max_greet_count ?? ""
    },
    followUp: meta.args?.follow_up || meta.args?.overrides?.follow_up || null
  });
}

function writeRecruitLegacyCsvAtomic(filePath, rows = [], snapshot = {}, meta = {}) {
  writeLegacyScreenCsv(filePath, {
    inputRows: buildRecruitCsvInputRows(snapshot, meta),
    results: rows
  });
}

function readRecruitRunState(runId) {
  const artifacts = getRecruitRunArtifacts(runId);
  if (!artifacts) return null;
  return readJsonFile(artifacts.run_state_path);
}

function writeRecruitRunState(runId, payload) {
  const artifacts = getRecruitRunArtifacts(runId);
  if (!artifacts) return null;
  writeJsonAtomic(artifacts.run_state_path, {
    ...payload,
    result: compactWorkflowResultForState(payload?.result),
    summary: compactWorkflowResultForState(payload?.summary)
  });
  return payload;
}

function createDetachedRecruitRunId() {
  return `mcp_recruit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isPidAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  if (numericPid === globalThis.process?.pid) return true;
  try {
    globalThis.process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function buildInitialRecruitDetachedState(runId, {
  workspaceRoot = "",
  args = {},
  parsed = {},
  pid = globalThis.process?.pid
} = {}) {
  const artifacts = getRecruitRunArtifacts(runId);
  const now = new Date().toISOString();
  const targetCount = parsePositiveInteger(args.max_candidates, parsed.screenParams?.target_count || 10);
  return {
    run_id: runId,
    mode: RUN_MODE_ASYNC,
    state: "queued",
    status: "queued",
    stage: "queued",
    started_at: now,
    updated_at: now,
    heartbeat_at: now,
    completed_at: null,
    pid: Number.isInteger(pid) && pid > 0 ? pid : globalThis.process?.pid || null,
    progress: {
      target_count: targetCount,
      processed: 0,
      screened: 0,
      detail_opened: 0,
      llm_screened: 0,
      passed: 0,
      skipped: 0,
      greet_count: 0
    },
    last_message: "Boss search detached worker is queued.",
    context: {
      domain: "recruit",
      target_url: RECRUIT_TARGET_URL,
      workspace_root: normalizeText(workspaceRoot) || globalThis.process?.cwd?.() || "",
      instruction: args.instruction || "",
      confirmation: clonePlain(args.confirmation || {}, {}),
      overrides: clonePlain(args.overrides || {}, {}),
      search_params: clonePlain(parsed.searchParams || {}, {}),
      criteria_present: Boolean(parsed.screenParams?.criteria),
      max_candidates: targetCount,
      target_count_semantics: TARGET_COUNT_SEMANTICS,
      detached_worker: true,
      rounds: []
    },
    control: {
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    },
    resume: {
      checkpoint_path: artifacts?.checkpoint_path || null,
      pause_control_path: artifacts?.run_state_path || null,
      output_csv: null,
      worker_stdout_path: artifacts?.worker_stdout_path || null,
      worker_stderr_path: artifacts?.worker_stderr_path || null,
      resume_count: 0,
      last_resumed_at: null,
      last_paused_at: null
    },
    error: null,
    result: null,
    summary: null,
    artifacts
  };
}

function patchPersistedRecruitControl(runId, controlPatch = {}, {
  status = "RUN_STATUS",
  message = "",
  lastMessage = ""
} = {}) {
  const current = readRecruitRunState(runId);
  if (!current) return null;
  const state = normalizeText(current.state || current.status);
  if (TERMINAL_STATUSES.has(state)) return null;
  const now = new Date().toISOString();
  const patched = {
    ...current,
    updated_at: now,
    heartbeat_at: now,
    last_message: lastMessage || message || current.last_message || "",
    control: {
      ...(current.control || {}),
      ...controlPatch
    }
  };
  writeRecruitRunState(runId, patched);
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

function launchDetachedRecruitWorker(runId) {
  const artifacts = getRecruitRunArtifacts(runId);
  if (!artifacts) throw new Error("Invalid recruit run_id");
  fs.mkdirSync(path.dirname(artifacts.worker_stdout_path), { recursive: true });
  const stdoutFd = fs.openSync(artifacts.worker_stdout_path, "a");
  const stderrFd = fs.openSync(artifacts.worker_stderr_path, "a");
  let child;
  try {
    child = spawn(globalThis.process.execPath, [
      DETACHED_WORKER_SCRIPT,
      "--domain",
      "recruit",
      "--run-id",
      runId
    ], {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      env: globalThis.process.env
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  if (typeof child?.unref === "function") child.unref();
  return child;
}

function ensureRecruitRunArtifacts(snapshot) {
  const artifacts = getRecruitRunArtifacts(snapshot?.runId || snapshot?.run_id);
  if (!artifacts) return null;

  const meta = getRecruitRunMeta(snapshot?.runId || snapshot?.run_id);
  const sourceCheckpoint = snapshot?.checkpoint && typeof snapshot.checkpoint === "object"
    ? snapshot.checkpoint
    : {};
  const checkpoint = boundedWorkflowCheckpoint({
    runDir: artifacts.runs_dir,
    runId: snapshot?.runId || snapshot?.run_id,
    checkpoint: sourceCheckpoint
  });
  writeJsonAtomic(artifacts.checkpoint_path, checkpoint);
  if (meta) meta.checkpointPath = artifacts.checkpoint_path;

  const summary = snapshot?.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const journalResults = reconstructWorkflowCandidateResults({
    runDir: artifacts.runs_dir,
    runId: snapshot?.runId || snapshot?.run_id
  });
  const checkpointResults = journalResults.length
    ? journalResults
    : Array.isArray(sourceCheckpoint.results)
      ? sourceCheckpoint.results
      : Array.isArray(checkpoint.results)
        ? checkpoint.results
        : [];
  const artifactSummary = summary || (checkpointResults.length ? {
    domain: "recruit",
    partial: true,
    partial_reason: snapshot?.status || snapshot?.state || "non_terminal",
    results: checkpointResults
  } : null);
  if (artifactSummary) {
    const rows = Array.isArray(artifactSummary.results) ? artifactSummary.results : [];
    writeRecruitLegacyCsvAtomic(artifacts.output_csv, rows, snapshot, meta);
    writeJsonAtomic(artifacts.report_json, {
      run_id: snapshot.runId || snapshot.run_id,
      status: snapshot.status || snapshot.state,
      phase: snapshot.phase || snapshot.stage,
      progress: snapshot.progress || {},
      context: snapshot.context || {},
      checkpoint,
      summary: artifactSummary,
      generated_at: new Date().toISOString()
    });
    if (meta) {
      meta.outputCsvPath = artifacts.output_csv;
      meta.reportJsonPath = artifacts.report_json;
    }
  }

  return artifacts;
}

function persistRecruitCheckpointSnapshot(normalized) {
  const artifacts = getRecruitRunArtifacts(normalized?.run_id || normalized?.runId);
  if (!artifacts) return;
  const sourceCheckpoint = normalized?.checkpoint && typeof normalized.checkpoint === "object"
    ? normalized.checkpoint
    : {};
  const checkpoint = boundedWorkflowCheckpoint({
    runDir: artifacts.runs_dir,
    runId: normalized?.run_id || normalized?.runId,
    checkpoint: sourceCheckpoint
  });
  writeJsonAtomic(artifacts.checkpoint_path, checkpoint);
  const meta = getRecruitRunMeta(normalized?.run_id || normalized?.runId);
  if (meta) meta.checkpointPath = artifacts.checkpoint_path;
}

function toIsoOrNull(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function secondsBetween(startedAt, endedAt) {
  const startMs = Date.parse(startedAt || "");
  const endMs = Date.parse(endedAt || "") || Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.max(1, Math.round((endMs - startMs) / 1000));
}

function normalizeLegacyProgress(progress = {}, summary = null) {
  const processed = Number.isInteger(progress.processed)
    ? progress.processed
    : Number.isInteger(summary?.processed)
      ? summary.processed
      : 0;
  const passed = Number.isInteger(progress.passed)
    ? progress.passed
    : Number.isInteger(summary?.passed)
      ? summary.passed
      : 0;
  return {
    ...progress,
    processed,
    passed,
    skipped: Number.isInteger(progress.skipped) ? progress.skipped : Math.max(processed - passed, 0),
    greet_count: Number.isInteger(progress.greet_count) ? progress.greet_count : 0
  };
}

function completionReason(status) {
  if (status === RUN_STATUS_COMPLETED) return "completed";
  if (status === RUN_STATUS_CANCELED) return "canceled_by_user";
  if (status === RUN_STATUS_FAILED) return "failed";
  if (status === RUN_STATUS_PAUSED) return "paused";
  return null;
}

function snapshotFromPersistedRecruitRun(persisted = {}) {
  const artifacts = getRecruitRunArtifacts(persisted.run_id || persisted.runId);
  const checkpoint = persisted.checkpoint || readJsonFile(artifacts?.checkpoint_path) || {};
  const journalResults = artifacts
    ? reconstructWorkflowCandidateResults({
        runDir: artifacts.runs_dir,
        runId: persisted.run_id || persisted.runId
      })
    : [];
  const {
    candidate_result_journal: _candidateResultJournal,
    results_count: _resultsCount,
    results_truncated: _resultsTruncated,
    ...legacyCheckpoint
  } = checkpoint;
  return {
    runId: persisted.run_id || persisted.runId,
    name: persisted.name || persisted.run_id || persisted.runId,
    status: persisted.status || persisted.state,
    phase: persisted.stage || persisted.phase,
    progress: persisted.progress || {},
    context: persisted.context || {},
    checkpoint: journalResults.length
      ? { ...legacyCheckpoint, results: journalResults }
      : legacyCheckpoint,
    startedAt: persisted.started_at || persisted.startedAt,
    updatedAt: persisted.updated_at || persisted.updatedAt,
    completedAt: persisted.completed_at || persisted.completedAt || null,
    error: persisted.error || null,
    summary: persisted.summary || null
  };
}

function attachLegacyArtifactsToPersistedRecruitRun(persisted = {}) {
  const runId = normalizeRunId(persisted.run_id || persisted.runId);
  if (!runId) return persisted;
  const snapshot = snapshotFromPersistedRecruitRun(persisted);
  const result = buildLegacyRunResult(snapshot);
  const artifacts = getRecruitRunArtifacts(runId);
  const next = {
    ...persisted,
    result,
    resume: {
      ...(persisted.resume || {}),
      checkpoint_path: result?.checkpoint_path || persisted.resume?.checkpoint_path || artifacts?.checkpoint_path || null,
      output_csv: result?.output_csv || persisted.resume?.output_csv || artifacts?.output_csv || null,
      worker_stdout_path: artifacts?.worker_stdout_path || persisted.resume?.worker_stdout_path || null,
      worker_stderr_path: artifacts?.worker_stderr_path || persisted.resume?.worker_stderr_path || null
    },
    artifacts: artifacts || persisted.artifacts || null
  };
  return writeRecruitRunState(runId, next);
}

function finalizePersistedRecruitRun(persisted = {}, {
  status = RUN_STATUS_FAILED,
  error = null,
  message = ""
} = {}) {
  const runId = normalizeRunId(persisted.run_id || persisted.runId);
  if (!runId) return persisted;
  const now = new Date().toISOString();
  const normalizedError = status === RUN_STATUS_FAILED
    ? {
        name: error?.name || "Error",
        code: error?.code || "STALE_RUN_PROCESS_EXITED",
        message: error?.message || message || "Boss search run process exited before it wrote a terminal state."
      }
    : null;
  const next = {
    ...persisted,
    run_id: runId,
    state: status,
    status,
    stage: persisted.stage || persisted.phase || "recruit:stale",
    updated_at: now,
    heartbeat_at: now,
    completed_at: persisted.completed_at || now,
    last_message: normalizedError?.message || message || status,
    control: {
      ...(persisted.control || {}),
      cancel_requested: false
    },
    error: normalizedError,
    summary: persisted.summary || null
  };
  return attachLegacyArtifactsToPersistedRecruitRun(next);
}

function reconcilePersistedRecruitRun(persisted = {}, { cancelStale = false } = {}) {
  const status = persisted.status || persisted.state;
  if (STALE_PROCESS_STATUSES.has(status) && !isPidAlive(persisted.pid)) {
    const shouldCancel = cancelStale || status === RUN_STATUS_CANCELING || persisted.control?.cancel_requested === true;
    return {
      run: finalizePersistedRecruitRun(persisted, {
        status: shouldCancel ? RUN_STATUS_CANCELED : RUN_STATUS_FAILED,
        error: shouldCancel ? null : {
          code: "STALE_RUN_PROCESS_EXITED",
          message: `Boss search run process is no longer alive for pid=${persisted.pid || "unknown"}.`
        },
        message: shouldCancel
          ? "Boss search run was canceled after its worker process was no longer active."
          : `Boss search run process is no longer alive for pid=${persisted.pid || "unknown"}.`
      }),
      stale_finalized: true
    };
  }
  return { run: persisted };
}

export function markBossRecruitDetachedWorkerFailed(runId, error, options = {}) {
  const normalizedRunId = normalizeRunId(runId);
  if (!normalizedRunId) return null;
  const persisted = readRecruitRunState(normalizedRunId) || buildInitialRecruitDetachedState(normalizedRunId, {});
  const state = normalizeText(persisted.state || persisted.status);
  if (TERMINAL_STATUSES.has(state)) return persisted;
  const errorPayload = {
    name: error?.name || "Error",
    code: options.code || error?.code || "RECRUIT_WORKER_UNHANDLED_EXCEPTION",
    message: normalizeText(error?.message || error || options.message) || "Boss search detached worker exited unexpectedly."
  };
  if (normalizeText(error?.stack || "")) {
    errorPayload.stack = String(error.stack).slice(0, 8000);
  }
  return finalizePersistedRecruitRun(persisted, {
    status: RUN_STATUS_FAILED,
    error: errorPayload,
    message: errorPayload.message
  });
}

function buildLegacyRunResult(snapshot) {
  if (!snapshot) return null;
  const artifacts = ensureRecruitRunArtifacts(snapshot);
  const meta = getRecruitRunMeta(snapshot.runId);
  const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const checkpoint = snapshot.checkpoint && typeof snapshot.checkpoint === "object" ? snapshot.checkpoint : {};
  const resultRows = Array.isArray(summary?.results)
    ? summary.results
    : Array.isArray(checkpoint.results)
      ? checkpoint.results
      : [];
  const progress = normalizeLegacyProgress(snapshot.progress, summary);
  const targetCount = Number.isInteger(progress.target_count)
    ? progress.target_count
    : Number.isInteger(snapshot.context?.max_candidates)
      ? snapshot.context.max_candidates
      : null;
  return {
    target_count: targetCount,
    processed_count: progress.processed,
    passed_count: progress.passed,
    screened_count: Number.isInteger(progress.screened)
      ? progress.screened
      : Number.isInteger(summary?.screened)
        ? summary.screened
        : progress.processed,
    detail_opened: Number.isInteger(progress.detail_opened)
      ? progress.detail_opened
      : Number.isInteger(summary?.detail_opened)
        ? summary.detail_opened
        : 0,
    duration_sec: secondsBetween(snapshot.startedAt, snapshot.completedAt || snapshot.updatedAt),
    output_csv: summary?.output_csv || meta.outputCsvPath || artifacts?.output_csv || null,
    report_json: summary?.report_json || meta.reportJsonPath || artifacts?.report_json || null,
    worker_stdout_path: artifacts?.worker_stdout_path || null,
    worker_stderr_path: artifacts?.worker_stderr_path || null,
    round_count: 1,
    current_round_index: 1,
    checkpoint_path: snapshot.checkpoint?.checkpoint_path
      || snapshot.checkpoint?.path
      || meta.checkpointPath
      || artifacts?.checkpoint_path
      || null,
    completion_reason: completionReason(snapshot.status),
    target_count_semantics: TARGET_COUNT_SEMANTICS,
    run_id: snapshot.runId,
    results: resultRows
  };
}

function createTargetCountSchema(description) {
  return {
    oneOf: [
      { type: "integer", minimum: 1 },
      { type: "string", pattern: "^[1-9][0-9]*$" }
    ],
    description
  };
}

function createHumanBehaviorInputSchema(description = "可选，search/recruit 可靠性实验用节奏配置；默认 paced_with_rests/on") {
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

export function createRecruitPipelineInputSchema() {
  return {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description: "用户自然语言招聘指令"
      },
      execution_mode: {
        type: "string",
        enum: [RUN_MODE_ASYNC, RUN_MODE_SYNC],
        description: "执行模式；默认 async。"
      },
      confirmation: {
        type: "object",
        description: "搜索页确认状态。新流程建议在用户看过总览后传 final_confirmed=true；逐字段 *_confirmed 为兼容旧调用保留。",
        properties: {
          final_confirmed: {
            type: "boolean",
            description: "用户已确认包含岗位、关键词、城市、学历/院校、是否过滤已看、criteria、目标人数、动作和 restLevel 的总览。"
          },
          job_confirmed: { type: "boolean" },
          job_value: { type: "string" },
          keyword_confirmed: { type: "boolean" },
          keyword_value: { type: "string" },
          search_params_confirmed: { type: "boolean" },
          criteria_confirmed: { type: "boolean" },
          criteria_value: { type: "string" },
          skip_recent_colleague_contacted_confirmed: { type: "boolean" },
          skip_recent_colleague_contacted_value: { type: "boolean" },
          filter_recent_colleague_contacted_confirmed: { type: "boolean" },
          filter_recent_colleague_contacted_value: {
            type: "boolean",
            description: "是否过滤近期已被同事触达的人选；true 会开启搜索页“近30天未和同事交换简历”。"
          },
          post_action_confirmed: { type: "boolean" },
          post_action_value: {
            type: "string",
            enum: ["greet", "none"]
          },
          max_greet_count_value: { type: "integer", minimum: 1 },
          use_default_for_missing: { type: "boolean" }
        },
        additionalProperties: false
      },
      overrides: {
        type: "object",
        properties: {
          job: { type: "string" },
          job_title: { type: "string" },
          selected_job: { type: "string" },
          city: { type: "string" },
          degree: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" }, minItems: 1 }
            ]
          },
          degrees: {
            anyOf: [
              { type: "string" },
              { type: "array", items: { type: "string" }, minItems: 1 }
            ]
          },
          filter_recent_viewed: { type: "boolean" },
          skip_recent_colleague_contacted: {
            type: "boolean",
            description: "显式 true 时开启 Boss 的“近30天未和同事交换简历”过滤；false 会确保该过滤取消；未提供时不默认开启。"
          },
          filter_recent_colleague_contacted: {
            type: "boolean",
            description: "是否过滤近期已被同事触达的人选；true 会开启搜索页“近30天未和同事交换简历”；false 会确保该过滤取消。"
          },
          recent_colleague_contacted: {
            anyOf: [
              { type: "boolean" },
              { type: "string" }
            ],
            description: "同事近期触达筛选别名；可填 不限/不过滤/过滤。"
          },
          recent_not_view: {
            anyOf: [
              { type: "boolean" },
              { type: "string" }
            ]
          },
          schools: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "string" }
            ]
          },
          school_tag: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "string" }
            ]
          },
          school_tags: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "string" }
            ]
          },
          experience: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  mode: { type: "string" },
                  label: { type: "string" },
                  option: { type: "string" },
                  start: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  end: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  min: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  max: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  from: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  to: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  start_value: { type: "integer" },
                  end_value: { type: "integer" }
                },
                additionalProperties: false
              }
            ]
          },
          experiences: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "string" }
            ]
          },
          experience_range: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  mode: { type: "string" },
                  label: { type: "string" },
                  option: { type: "string" },
                  start: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  end: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  min: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  max: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  from: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  to: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  start_value: { type: "integer" },
                  end_value: { type: "integer" }
                },
                additionalProperties: false
              }
            ]
          },
          experience_start: {
            anyOf: [
              { type: "string" },
              { type: "integer" }
            ]
          },
          experience_end: {
            anyOf: [
              { type: "string" },
              { type: "integer" }
            ]
          },
          gender: { type: "string" },
          age: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  mode: { type: "string" },
                  label: { type: "string" },
                  option: { type: "string" },
                  min: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  max: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  start: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  end: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  from: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  to: { anyOf: [{ type: "string" }, { type: "integer" }] }
                },
                additionalProperties: false
              }
            ]
          },
          ages: {
            anyOf: [
              { type: "array", items: { type: "string" } },
              { type: "string" }
            ]
          },
          age_range: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  mode: { type: "string" },
                  label: { type: "string" },
                  option: { type: "string" },
                  min: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  max: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  start: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  end: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  from: { anyOf: [{ type: "string" }, { type: "integer" }] },
                  to: { anyOf: [{ type: "string" }, { type: "integer" }] }
                },
                additionalProperties: false
              }
            ]
          },
          age_min: {
            anyOf: [
              { type: "string" },
              { type: "integer" }
            ]
          },
          age_max: {
            anyOf: [
              { type: "string" },
              { type: "integer" }
            ]
          },
          min_age: {
            anyOf: [
              { type: "string" },
              { type: "integer" }
            ]
          },
          max_age: {
            anyOf: [
              { type: "string" },
              { type: "integer" }
            ]
          },
          keyword: { type: "string" },
          target_count: { type: "integer", minimum: 1 },
          criteria: { type: "string" },
          post_action: {
            type: "string",
            enum: ["greet", "none"]
          },
          max_greet_count: { type: "integer", minimum: 1 }
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
        description: "可选，Chrome target URL 匹配片段；默认 Boss search 页"
      },
      allow_navigate: {
        type: "boolean",
        description: "找不到 search target 时，是否允许复用 Boss chat target 并导航到 search；默认 true"
      },
      reset_search: {
        type: "boolean",
        description: "执行前是否重置 Boss search frame；默认 true"
      },
      slow_live: {
        type: "boolean",
        description: "VPN/慢页面模式：放宽 live DOM 等待时间"
      },
      human_behavior: createHumanBehaviorInputSchema("可选，search/recruit 可靠性实验用节奏配置；默认 paced_with_rests/on"),
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
      safe_pacing: {
        type: "boolean",
        description: "兼容字段；true 启用 paced，false 关闭"
      },
      batch_rest_enabled: {
        type: "boolean",
        description: "兼容字段；true 启用 paced_with_rests 的候选人短休/批次休息"
      },
      max_candidates: createTargetCountSchema("本次最多处理候选人数；默认使用解析出的 target_count"),
      detail_limit: {
        type: "integer",
        minimum: 0,
        description: "打开详情/CV 的人数上限；默认跟随 max_candidates。detail_limit=0 属于调试路径，需要 debug_test_mode=true"
      },
      debug_test_mode: {
        type: "boolean",
        description: "高级测试开关；默认 false。只有显式为 true 时才允许 deterministic/local scorer、detail_limit=0 等调试路径"
      },
      screening_mode: {
        type: "string",
        enum: ["llm", "deterministic"],
        description: "筛选引擎；默认 llm。deterministic 仅限 debug_test_mode=true"
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
        description: "可选，是否实际执行通过后的 search 后置动作 greet；默认 true"
      },
      dry_run_post_action: {
        type: "boolean",
        description: "可选，只验证 search 打招呼动作发现/配额/可点击路径，不实际点击"
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
      }
    },
    required: ["instruction"],
    additionalProperties: false
  };
}

export function createRecruitRunIdInputSchema() {
  return {
    type: "object",
    properties: {
      run_id: { type: "string" }
    },
    required: ["run_id"],
    additionalProperties: false
  };
}

export function validateRecruitPipelineArgs(args) {
  if (!args || typeof args !== "object") return "arguments must be an object";
  if (!args.instruction || typeof args.instruction !== "string") {
    return "instruction is required and must be a string";
  }
  return null;
}

function buildRequiredConfirmations(parsedResult) {
  const confirmations = [];
  if (parsedResult.needs_search_params_confirmation) confirmations.push("search_params");
  if (parsedResult.needs_keyword_confirmation) confirmations.push("keyword");
  if (parsedResult.needs_recent_viewed_filter_confirmation) confirmations.push("filter_recent_viewed");
  if (parsedResult.needs_skip_recent_colleague_contacted_confirmation) confirmations.push("filter_recent_colleague_contacted");
  if (parsedResult.needs_criteria_confirmation) confirmations.push("criteria");
  if (parsedResult.has_unresolved_missing_fields) confirmations.push("missing_fields_or_defaults");
  if ((parsedResult.suspicious_fields || []).length) confirmations.push("suspicious_fields");
  return confirmations;
}

function buildNeedInputResponse(parsedResult) {
  return {
    status: "NEED_INPUT",
    missing_fields: parsedResult.missing_fields,
    proposed_keyword: parsedResult.proposed_keyword,
    required_confirmations: buildRequiredConfirmations(parsedResult),
    search_params: parsedResult.searchParams,
    screen_params: parsedResult.screenParams,
    pending_questions: parsedResult.pending_questions,
    review: parsedResult.review,
    error: {
      code: "MISSING_REQUIRED_FIELDS",
      message: "缺少必要字段。请先补齐缺失项；若要按默认值继续，必须先明确确认默认值及其风险。",
      retryable: true
    }
  };
}

function buildNeedConfirmationResponse(parsedResult) {
  return {
    status: "NEED_CONFIRMATION",
    proposed_keyword: parsedResult.proposed_keyword,
    required_confirmations: buildRequiredConfirmations(parsedResult),
    search_params: {
      ...parsedResult.searchParams,
      keyword: parsedResult.proposed_keyword || parsedResult.searchParams.keyword
    },
    screen_params: parsedResult.screenParams,
    pending_questions: parsedResult.pending_questions,
    review: parsedResult.review
  };
}

function parseRecruitPipelineRequest(args = {}) {
  const parsed = parseRecruitInstruction({
    instruction: args.instruction,
    confirmation: args.confirmation,
    overrides: args.overrides
  });
  const criteriaOverride = normalizeText(args.overrides?.criteria || "");
  if (criteriaOverride) {
    parsed.screenParams = {
      ...parsed.screenParams,
      criteria: criteriaOverride
    };
    parsed.review = {
      ...parsed.review,
      current_screen_params: {
        ...(parsed.review?.current_screen_params || {}),
        criteria: criteriaOverride
      }
    };
  }
  return parsed;
}

function evaluateRecruitPipelineGate(parsed) {
  if (parsed.has_unresolved_missing_fields) return buildNeedInputResponse(parsed);
  if (
    parsed.needs_keyword_confirmation
    || parsed.needs_recent_viewed_filter_confirmation
    || parsed.needs_skip_recent_colleague_contacted_confirmation
    || parsed.needs_criteria_confirmation
    || parsed.needs_search_params_confirmation
    || (parsed.suspicious_fields || []).length > 0
  ) {
    return buildNeedConfirmationResponse(parsed);
  }
  return null;
}

function normalizeRunSnapshot(snapshot) {
  if (!snapshot) return null;
  const meta = getRecruitRunMeta(snapshot.runId);
  const artifacts = getRecruitRunArtifacts(snapshot.runId);
  const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const progress = normalizeLegacyProgress(snapshot.progress, summary);
  const legacyResult = (
    TERMINAL_STATUSES.has(snapshot.status)
    || snapshot.status === RUN_STATUS_PAUSED
  ) ? buildLegacyRunResult({ ...snapshot, progress }) : null;
  const oldContext = {
    workspace_root: meta.workspaceRoot || null,
    instruction: meta.args?.instruction || "",
    confirmation: clonePlain(meta.args?.confirmation || {}, {}),
    overrides: clonePlain(meta.args?.overrides || {}, {}),
    rounds: []
  };
  return {
    ...snapshot,
    progress,
    run_id: snapshot.runId,
    mode: meta.mode || RUN_MODE_ASYNC,
    state: snapshot.status,
    stage: snapshot.phase,
    started_at: snapshot.startedAt,
    updated_at: snapshot.updatedAt,
    completed_at: toIsoOrNull(snapshot.completedAt),
    heartbeat_at: snapshot.updatedAt,
    pid: globalThis.process?.pid || null,
    last_message: snapshot.error?.message || snapshot.phase || null,
    context: {
      ...(snapshot.context || {}),
      ...oldContext,
      shared_run_context: snapshot.context || {}
    },
    control: {
      pause_requested: snapshot.status === RUN_STATUS_PAUSED,
      pause_requested_at: snapshot.status === RUN_STATUS_PAUSED ? snapshot.updatedAt : null,
      pause_requested_by: snapshot.status === RUN_STATUS_PAUSED ? "pause_recruit_pipeline_run" : null,
      cancel_requested: snapshot.status === RUN_STATUS_CANCELING
    },
    resume: {
      checkpoint_path: legacyResult?.checkpoint_path || meta.checkpointPath || artifacts?.checkpoint_path || null,
      pause_control_path: artifacts?.run_state_path || null,
      output_csv: legacyResult?.output_csv || null,
      worker_stdout_path: artifacts?.worker_stdout_path || null,
      worker_stderr_path: artifacts?.worker_stderr_path || null,
      resume_count: meta.resumeCount || 0,
      last_resumed_at: meta.lastResumedAt || null,
      last_paused_at: snapshot.status === RUN_STATUS_PAUSED ? snapshot.updatedAt : null
    },
    result: legacyResult,
    artifacts
  };
}

function persistRecruitRunSnapshot(snapshot, {
  persistActiveCheckpoint = false,
  monitorEvent = {}
} = {}) {
  const normalized = normalizeRunSnapshot(snapshot);
  if (!normalized?.run_id) return normalized;
  const artifacts = getRecruitRunArtifacts(normalized.run_id);
  if (!artifacts) return normalized;
  const existing = readJsonFile(artifacts.run_state_path);
  const existingMonitorMarker = plainRecord(existing?.monitoring_v1);
  const normalizedMonitorMarker = plainRecord(normalized?.monitoring_v1);
  const monitorMarker = existingMonitorMarker.contract_version === "1.0"
    ? existingMonitorMarker
    : normalizedMonitorMarker.contract_version === "1.0"
      ? normalizedMonitorMarker
      : monitorEvent?.v1_created === true
        ? createBossMonitorSourceMarker(normalized.started_at || normalized.updated_at)
        : null;
  if (monitorMarker) normalized.monitoring_v1 = monitorMarker;
  if (persistActiveCheckpoint) {
    persistRecruitCheckpointSnapshot(normalized);
  }
  const payload = {
    run_id: normalized.run_id,
    mode: normalized.mode,
    state: normalized.state,
    status: normalized.status,
    stage: normalized.stage,
    started_at: normalized.started_at,
    updated_at: normalized.updated_at,
    heartbeat_at: normalized.heartbeat_at,
    completed_at: normalized.completed_at,
    pid: normalized.pid,
    progress: normalized.progress,
    last_message: normalized.last_message,
    context: normalized.context,
    control: normalized.control,
    resume: normalized.resume,
    error: normalized.error,
    result: compactWorkflowResultForState(normalized.result),
    summary: compactWorkflowResultForState(normalized.summary),
    monitoring_v1: normalized.monitoring_v1,
    artifacts: normalized.artifacts
  };
  writeJsonAtomic(artifacts.run_state_path, payload);
  writeBossMonitorProjectionNonfatal("search", normalized, monitorEvent);
  return normalized;
}

function persistRecruitLifecycleSnapshot(snapshot, event = {}) {
  return persistRecruitRunSnapshot(snapshot, {
    persistActiveCheckpoint: event?.type === "checkpoint",
    monitorEvent: { ...event, producer: true }
  });
}

function getRecruitRunMeta(runId) {
  return recruitRunMeta.get(runId) || {};
}

function attachMethodEvidence(payload, runId) {
  const meta = getRecruitRunMeta(runId);
  return {
    ...payload,
    runtime_evaluate_used: false,
    method_summary: methodSummary(meta.methodLog || []),
    method_log: meta.methodLog || [],
    chrome: meta.chrome || null
  };
}

async function waitForRecruitSearchControlsOrLogin(client, {
  timeoutMs = 90000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let lastControls = null;
  while (Date.now() - started <= timeoutMs) {
    const loginDetection = await detectBossLoginState(client).catch(() => null);
    if (loginDetection?.requires_login) {
      return {
        ok: false,
        reason: "login_required",
        loginDetection
      };
    }
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - started));
    lastControls = await waitForRecruitSearchControls(client, {
      timeoutMs: Math.min(remainingMs, 1500),
      intervalMs
    });
    if (lastControls.ok) return lastControls;
    await sleep(intervalMs);
  }
  return lastControls || { ok: false, reason: "timeout" };
}

async function connectRecruitChromeSession({
  host = DEFAULT_RECRUIT_HOST,
  port = DEFAULT_RECRUIT_PORT,
  targetUrlIncludes = RECRUIT_TARGET_URL,
  allowNavigate = true,
  slowLive = false
} = {}) {
  const session = await connectToChromeTargetOrOpen({
    host,
    port,
    targetUrlIncludes,
    targetUrl: RECRUIT_TARGET_URL,
    allowNavigate,
    slowLive,
    fallbackTargetPredicate: (target) => (
      target?.type === "page"
      && String(target?.url || "").includes("zhipin.com")
    )
  });

  const { client, target } = session;
  await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
  if (typeof client?.Network?.setCacheDisabled === "function") {
    await client.Network.setCacheDisabled({ cacheDisabled: true });
  }
  await bringPageToFront(client);

  const targetUrl = String(target?.url || "");
  let navigation = {
    navigated: false,
    url: targetUrl
  };
  if (allowNavigate && !targetUrl.includes(targetUrlIncludes)) {
    await client.Page.navigate({ url: RECRUIT_TARGET_URL });
    const settleMs = slowLive ? 8000 : 3000;
    const waited = await waitForMainFrameUrl(
      client,
      (url) => isBossLoginUrl(url) || String(url || "").includes(RECRUIT_TARGET_URL),
      { timeoutMs: settleMs, intervalMs: 500 }
    );
    navigation = {
      navigated: true,
      url: RECRUIT_TARGET_URL,
      settle_ms: settleMs,
      observed_url: waited.url || null,
      observed_url_ok: waited.ok
    };
  }
  let currentUrl = await getMainFrameUrl(client).catch(() => targetUrl);
  if (allowNavigate && !String(currentUrl || "").includes(RECRUIT_TARGET_URL) && !isBossLoginUrl(currentUrl)) {
    await client.Page.navigate({ url: RECRUIT_TARGET_URL });
    const settleMs = slowLive ? 8000 : 3000;
    const waited = await waitForMainFrameUrl(
      client,
      (url) => isBossLoginUrl(url) || String(url || "").includes(RECRUIT_TARGET_URL),
      { timeoutMs: settleMs, intervalMs: 500 }
    );
    navigation = {
      navigated: true,
      url: RECRUIT_TARGET_URL,
      settle_ms: settleMs,
      observed_url: waited.url || null,
      observed_url_ok: waited.ok,
      reason: "observed_url_mismatch"
    };
    currentUrl = await getMainFrameUrl(client).catch(() => waited.url || currentUrl);
  }
  const loginDetection = await detectBossLoginState(client, { currentUrl }).catch(() => ({
    requires_login: isBossLoginUrl(currentUrl),
    reason: "login_detection_failed",
    current_url: currentUrl
  }));
  if (loginDetection.requires_login) {
    await session.close?.();
    throw createBossLoginRequiredError({
      domain: "search",
      currentUrl: loginDetection.current_url || currentUrl,
      targetUrl: RECRUIT_TARGET_URL,
      loginDetection,
      chrome: session.chrome || null
    });
  }
  if (!String(currentUrl || "").includes(RECRUIT_TARGET_URL)) {
    await session.close?.();
    throw new Error(`Boss search page did not navigate to ${RECRUIT_TARGET_URL}; current URL: ${currentUrl || "unknown"}`);
  }

  const controls = await waitForRecruitSearchControlsOrLogin(client, {
    timeoutMs: slowLive ? 180000 : 90000,
    intervalMs: 300
  });
  if (controls.loginDetection?.requires_login) {
    await session.close?.();
    throw createBossLoginRequiredError({
      domain: "search",
      currentUrl: controls.loginDetection.current_url || currentUrl,
      targetUrl: RECRUIT_TARGET_URL,
      loginDetection: controls.loginDetection,
      chrome: session.chrome || null
    });
  }
  if (!controls.ok) {
    const latestUrl = await getMainFrameUrl(client).catch(() => currentUrl);
    const latestLoginDetection = await detectBossLoginState(client, { currentUrl: latestUrl }).catch(() => ({
      requires_login: isBossLoginUrl(latestUrl),
      reason: "login_detection_failed",
      current_url: latestUrl
    }));
    if (latestLoginDetection.requires_login) {
      await session.close?.();
      throw createBossLoginRequiredError({
        domain: "search",
        currentUrl: latestLoginDetection.current_url || latestUrl,
        targetUrl: RECRUIT_TARGET_URL,
        loginDetection: latestLoginDetection,
        chrome: session.chrome || null
      });
    }
    throw new Error("Boss recruit search page did not expose ready search controls");
  }

  return {
    ...session,
    navigation,
    controls
  };
}

function getRunOptions(args, parsed, session, configResolution = null) {
  const slowLive = args.slow_live === true;
  const targetCount = parsePositiveInteger(args.max_candidates, parsed.screenParams.target_count || 10);
  const screeningMode = normalizeScreeningModeArg(args);
  const humanBehavior = resolveHumanBehaviorForRun(args, configResolution?.config || {});
  const executePostAction = args.dry_run_post_action === true
    ? false
    : args.execute_post_action !== false;
  return {
    client: session.client,
    targetUrl: RECRUIT_TARGET_URL,
    criteria: parsed.screenParams.criteria,
    searchParams: parsed.searchParams,
    maxCandidates: targetCount,
    detailLimit: parseNonNegativeInteger(args.detail_limit, targetCount),
    closeDetail: true,
    delayMs: Math.max(0, parsePositiveInteger(args.delay_ms, 0)),
    cardTimeoutMs: slowLive ? 180000 : 90000,
    resetBeforeSearch: args.reset_search !== false,
    resetTimeoutMs: slowLive ? 300000 : 180000,
    cityOptionTimeoutMs: slowLive ? 60000 : 30000,
    maxImagePages: parsePositiveInteger(args.max_image_pages, DEFAULT_MAX_IMAGE_PAGES),
    screeningMode,
    llmConfig: screeningMode === "llm" && configResolution?.ok ? {
      ...configResolution.config
    } : null,
    llmTimeoutMs: parsePositiveInteger(
      args.llm_timeout_ms,
      parsePositiveInteger(configResolution?.config?.llmTimeoutMs || configResolution?.config?.timeoutMs, slowLive ? 180000 : 120000)
    ),
    llmImageLimit: parsePositiveInteger(
      args.llm_image_limit,
      parsePositiveInteger(configResolution?.config?.llmImageLimit || configResolution?.config?.imageLimit, 8)
    ),
    llmImageDetail: normalizeText(
      args.llm_image_detail || configResolution?.config?.llmImageDetail || configResolution?.config?.imageDetail
    ) || "low",
    imageOutputDir: resolveBossConfiguredOutputDir("", getRecruitRunsDir()),
    humanRestEnabled: humanBehavior.restEnabled,
    humanBehavior,
    postAction: parsed.screenParams?.post_action || "none",
    maxGreetCount: Number.isInteger(parsed.screenParams?.max_greet_count)
      ? parsed.screenParams.max_greet_count
      : null,
    executePostAction,
    actionTimeoutMs: parsePositiveInteger(args.action_timeout_ms, slowLive ? 12000 : 8000),
    actionIntervalMs: parsePositiveInteger(args.action_interval_ms, 400),
    actionAfterClickDelayMs: parseNonNegativeInteger(args.action_after_click_delay_ms, 900),
    name: "mcp-recruit-pipeline-run"
  };
}

async function closeRecruitRunSession(runId) {
  const meta = recruitRunMeta.get(runId);
  if (!meta || meta.closed) return;
  try {
    assertNoForbiddenCdpCalls(meta.methodLog || []);
  } finally {
    meta.closed = true;
    try {
      await meta.session?.close?.();
    } catch {
      // Nothing actionable for the caller once the run has settled.
    }
  }
}

async function waitForRecruitRunTerminal(runId) {
  while (true) {
    try {
      const snapshot = recruitRunService.getRecruitRun(runId);
      if (TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    } catch {
      return null;
    }
    await sleep(1000);
  }
}

function trackRecruitRun(runId) {
  waitForRecruitRunTerminal(runId)
    .then((terminal) => {
      if (terminal) persistRecruitRunSnapshot(terminal);
    })
    .catch(() => null)
    .finally(() => {
      closeRecruitRunSession(runId).catch(() => {});
    });
}

async function startRecruitPipelineRunInternal(args = {}, { workspaceRoot = "", runId = "" } = {}) {
  const parsed = parseRecruitPipelineRequest(args);
  const gate = evaluateRecruitPipelineGate(parsed);
  if (gate) return gate;
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const screeningMode = normalizeScreeningModeArg(args);
  const debugTestOptions = collectRecruitDebugTestOptions(args);
  if (debugTestOptions.length && !isDebugTestMode(args)) {
    return {
      status: "FAILED",
      error: {
        code: "DEBUG_TEST_MODE_REQUIRED",
        message: `这些参数属于调试/测试路径，正式 live run 不会默认启用：${debugTestOptions.join(", ")}。如确需测试，请显式传 debug_test_mode=true。`,
        retryable: false
      },
      debug_test_options: debugTestOptions
    };
  }
  if (screeningMode === "llm" && !configResolution.ok) {
    return {
      status: "FAILED",
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: configResolution.error?.message || "screening-config.json is required for LLM screening.",
        retryable: true
      },
      config_path: configResolution.config_path || null,
      candidate_paths: configResolution.candidate_paths || []
    };
  }
  const host = normalizeText(args.host) || DEFAULT_RECRUIT_HOST;
  const port = parsePositiveInteger(
    args.port,
    configResolution.ok ? configResolution.config.debugPort : DEFAULT_RECRUIT_PORT
  );

  let session;
  try {
    session = await recruitConnectorImpl({
      host,
      port,
      targetUrlIncludes: normalizeText(args.target_url_includes) || RECRUIT_TARGET_URL,
      allowNavigate: args.allow_navigate !== false,
      slowLive: args.slow_live === true
    });
  } catch (error) {
    const loginRequired = error?.code === "BOSS_LOGIN_REQUIRED";
    return {
      status: "FAILED",
      error: {
        code: loginRequired ? "BOSS_LOGIN_REQUIRED" : "BOSS_SEARCH_PAGE_NOT_READY",
        message: error?.message || "Boss recruit search page is not ready",
        requires_login: Boolean(error?.requires_login),
        login_url: error?.login_url || null,
        login_detection: error?.login_detection || null,
        chrome: error?.chrome || null,
        current_url: error?.current_url || null,
        target_url: error?.target_url || RECRUIT_TARGET_URL,
        retryable: true
      },
      chrome: error?.chrome || null
    };
  }

  let started;
  try {
    started = recruitRunService.startRecruitRun({
      ...getRunOptions(args, parsed, session, configResolution),
      runId
    });
  } catch (error) {
    await session.close?.();
    return {
      status: "FAILED",
      error: {
        code: "RECRUIT_RUN_START_FAILED",
        message: error?.message || "Failed to start recruit run",
        retryable: true
      }
    };
  }

  recruitRunMeta.set(started.runId, {
    session,
    methodLog: session.methodLog || [],
    mode: normalizeExecutionMode(args.execution_mode),
    workspaceRoot: normalizeText(workspaceRoot) || globalThis.process?.cwd?.() || "",
    args: clonePlain(args, {}),
    chrome: {
      host,
      port,
      target_url: session.target?.url || RECRUIT_TARGET_URL,
      target_id: session.target?.id || null,
      auto_launch: session.chrome || null
    },
    parsed
  });
  trackRecruitRun(started.runId);
  const persistedStarted = persistRecruitRunSnapshot(started, {
    monitorEvent: { type: "created", producer: true, v1_created: true }
  });

  return {
    status: "ACCEPTED",
    run_id: persistedStarted.run_id,
    state: persistedStarted.state,
    run: persistedStarted,
    poll_after_sec: DEFAULT_RECRUIT_POLL_AFTER_SEC,
    review: parsed.review,
    message: parsed.screenParams?.post_action === "greet"
      ? `Recruit pipeline run started through shared CDP-only recruit service with post_action=greet${args.dry_run_post_action === true ? " in dry-run mode" : ""}.`
      : "Recruit pipeline run started through shared CDP-only recruit service.",
    post_action: {
      requested: parsed.screenParams?.post_action || "none",
      execute_post_action: args.dry_run_post_action === true ? false : args.execute_post_action !== false,
      max_greet_count: Number.isInteger(parsed.screenParams?.max_greet_count) ? parsed.screenParams.max_greet_count : null
    }
  };
}

export async function runRecruitPipelineTool({ workspaceRoot = "", args = {} } = {}) {
  const mode = normalizeExecutionMode(args.execution_mode);
  const started = await startRecruitPipelineRunInternal({
    ...args,
    execution_mode: mode
  }, { workspaceRoot });
  if (started.status !== "ACCEPTED") return started;
  if (mode !== RUN_MODE_SYNC) return attachMethodEvidence(started, started.run_id);

  const final = await waitForRecruitRunTerminal(started.run_id);
  await closeRecruitRunSession(started.run_id);
  const normalizedFinal = persistRecruitRunSnapshot(final);
  const legacyResult = normalizedFinal?.result || buildLegacyRunResult(final);
  const finalStatus = final?.status === RUN_STATUS_COMPLETED
    ? "COMPLETED"
    : final?.status === RUN_STATUS_CANCELED
      ? "CANCELED"
      : "FAILED";
  return attachMethodEvidence({
    status: finalStatus,
    run_id: started.run_id,
    run: normalizedFinal,
    result: legacyResult,
    partial_result: finalStatus === "CANCELED" ? legacyResult : undefined,
    diagnostics: finalStatus === "FAILED"
      ? {
          run_id: started.run_id,
          last_stage: normalizedFinal?.stage || "recruit:unknown"
        }
      : undefined,
    summary: final?.summary || null,
    error: finalStatus === "CANCELED"
      ? {
          code: "PIPELINE_CANCELED",
          message: "流水线已取消。",
          retryable: true
        }
      : final?.error || null
  }, started.run_id);
}

export async function startRecruitPipelineRunTool({ workspaceRoot = "", args = {} } = {}) {
  const started = await startRecruitPipelineRunInternal({
    ...args,
    execution_mode: RUN_MODE_ASYNC
  }, { workspaceRoot });
  if (started.status !== "ACCEPTED") return started;
  return {
    ...attachMethodEvidence(started, started.run_id),
    monitoring: createBossMonitoringBlock("search", started.run_id)
  };
}

export async function startRecruitPipelineDetachedRunTool({ workspaceRoot = "", args = {} } = {}) {
  const normalizedArgs = {
    ...args,
    execution_mode: RUN_MODE_ASYNC
  };
  const parsed = parseRecruitPipelineRequest(normalizedArgs);
  const gate = evaluateRecruitPipelineGate(parsed);
  if (gate) return gate;
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const screeningMode = normalizeScreeningModeArg(normalizedArgs);
  const debugTestOptions = collectRecruitDebugTestOptions(normalizedArgs);
  if (debugTestOptions.length && !isDebugTestMode(normalizedArgs)) {
    return {
      status: "FAILED",
      error: {
        code: "DEBUG_TEST_MODE_REQUIRED",
        message: `这些参数属于调试/测试路径，正式 live run 不会默认启用：${debugTestOptions.join(", ")}。如确需测试，请显式传 debug_test_mode=true。`,
        retryable: false
      },
      debug_test_options: debugTestOptions
    };
  }
  if (screeningMode === "llm" && !configResolution.ok) {
    return {
      status: "FAILED",
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: configResolution.error?.message || "screening-config.json is required for LLM screening.",
        retryable: true
      },
      config_path: configResolution.config_path || null,
      candidate_paths: configResolution.candidate_paths || []
    };
  }

  const runId = createDetachedRecruitRunId();
  const artifacts = getRecruitRunArtifacts(runId);
  const initial = buildInitialRecruitDetachedState(runId, {
    workspaceRoot,
    args: normalizedArgs,
    parsed,
    pid: globalThis.process?.pid
  });
  try {
    writeJsonAtomic(artifacts.detached_args_path, {
      domain: "recruit",
      run_id: runId,
      workspace_root: normalizeText(workspaceRoot) || globalThis.process?.cwd?.() || "",
      args: clonePlain(normalizedArgs, {})
    });
    writeRecruitRunState(runId, initial);
  } catch (error) {
    return {
      status: "FAILED",
      error: {
        code: "RECRUIT_RUN_STATE_IO_ERROR",
        message: `Unable to write Boss search detached run state: ${error?.message || error}`,
        retryable: false
      }
    };
  }

  try {
    const child = launchDetachedRecruitWorker(runId);
    const now = new Date().toISOString();
    const latest = readRecruitRunState(runId) || initial;
    const latestState = normalizeText(latest.state || latest.status);
    if (TERMINAL_STATUSES.has(latestState)) {
      return {
        status: "FAILED",
        error: latest.error || {
          code: "RECRUIT_WORKER_LAUNCH_FAILED",
          message: "Boss search detached worker exited during launch.",
          retryable: true
        },
        run: latest,
        runtime_evaluate_used: false,
        method_summary: {},
        method_log: [],
        chrome: null
      };
    }
    const queuedMonitorMarker = latest.monitoring_v1
      || createBossMonitorSourceMarker(latest.started_at || now);
    const queued = {
      ...latest,
      ...(queuedMonitorMarker ? { monitoring_v1: queuedMonitorMarker } : {}),
      pid: child.pid || globalThis.process?.pid || null,
      updated_at: now,
      heartbeat_at: now,
      last_message: "Boss search detached worker launched."
    };
    writeRecruitRunState(runId, queued);
    writeBossMonitorProjectionNonfatal("search", queued, {
      type: "created",
      v1_created: true
    });
    return {
      status: "ACCEPTED",
      run_id: runId,
      state: "queued",
      run: queued,
      poll_after_sec: DEFAULT_RECRUIT_POLL_AFTER_SEC,
      review: parsed.review,
      message: "Boss search run started in a detached worker. It can continue after the MCP host returns or is recycled.",
      target_count_semantics: TARGET_COUNT_SEMANTICS,
      detached_worker: true,
      runtime_evaluate_used: false,
      method_summary: {},
      method_log: [],
      chrome: null,
      monitoring: createBossMonitoringBlock("search", runId)
    };
  } catch (error) {
    const failed = markBossRecruitDetachedWorkerFailed(runId, error, {
      code: "RECRUIT_WORKER_LAUNCH_FAILED",
      message: "Unable to launch Boss search detached worker."
    });
    return {
      status: "FAILED",
      error: failed?.error || {
        code: "RECRUIT_WORKER_LAUNCH_FAILED",
        message: error?.message || "Unable to launch Boss search detached worker.",
        retryable: true
      },
      run: failed || readRecruitRunState(runId),
      runtime_evaluate_used: false,
      method_summary: {},
      method_log: [],
      chrome: null
    };
  }
}

export async function runBossRecruitDetachedWorker({ runId } = {}) {
  const normalizedRunId = normalizeRunId(runId);
  if (!normalizedRunId) return { ok: false, error: "run_id is required" };
  const artifacts = getRecruitRunArtifacts(normalizedRunId);
  const spec = readJsonFile(artifacts?.detached_args_path || "");
  if (!spec) {
    const error = new Error(`Boss search detached args were not found for run_id=${normalizedRunId}`);
    markBossRecruitDetachedWorkerFailed(normalizedRunId, error, { code: "RECRUIT_WORKER_ARGS_MISSING" });
    return { ok: false, error: error.message };
  }

  const started = await startRecruitPipelineRunInternal({
    ...(spec.args || {}),
    execution_mode: RUN_MODE_ASYNC
  }, {
    workspaceRoot: spec.workspace_root || "",
    runId: normalizedRunId
  });
  if (started?.status !== "ACCEPTED") {
    const failedError = started?.error || {
      code: "RECRUIT_WORKER_START_FAILED",
      message: started?.status || "Boss search detached worker failed to start.",
      retryable: true
    };
    markBossRecruitDetachedWorkerFailed(normalizedRunId, failedError, {
      code: failedError.code || "RECRUIT_WORKER_START_FAILED"
    });
    return { ok: false, error: failedError.message || "Boss search detached worker failed to start." };
  }

  while (true) {
    const payload = getRecruitPipelineRunTool({ args: { run_id: normalizedRunId } });
    const state = normalizeText(payload?.run?.state || payload?.run?.status || "");
    if (TERMINAL_STATUSES.has(state)) break;
    const persisted = readRecruitRunState(normalizedRunId);
    if (persisted?.control?.cancel_requested === true) {
      cancelRecruitPipelineRunTool({ args: { run_id: normalizedRunId } });
    } else if (persisted?.control?.pause_requested === true && state === RUN_STATUS_RUNNING) {
      pauseRecruitPipelineRunTool({ args: { run_id: normalizedRunId } });
    } else if (persisted?.control?.pause_requested === false && state === RUN_STATUS_PAUSED) {
      resumeRecruitPipelineRunTool({ args: { run_id: normalizedRunId } });
    }
    await sleep(DETACHED_WORKER_POLL_MS);
  }
  return { ok: true };
}

export function getRecruitPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeText(args.run_id);
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
  try {
    const run = recruitRunService.getRecruitRun(runId);
    const normalizedRun = persistRecruitRunSnapshot(run);
    return attachMethodEvidence({
      status: "RUN_STATUS",
      run: normalizedRun,
      monitoring: createBossMonitoringBlock("search", runId)
    }, runId);
  } catch {
    const persisted = readRecruitRunState(runId);
    if (persisted) {
      const reconciled = reconcilePersistedRecruitRun(persisted);
      const hydrated = snapshotFromPersistedRecruitRun(reconciled.run);
      writeBossMonitorProjectionNonfatal(
        "search",
        { ...reconciled.run, checkpoint: hydrated.checkpoint },
        { type: "backfill" }
      );
      return {
        status: "RUN_STATUS",
        run: reconciled.run,
        monitoring: createBossMonitoringBlock("search", runId),
        persistence: {
          source: "disk",
          active_control_available: false,
          stale_finalized: reconciled.stale_finalized === true
        },
        runtime_evaluate_used: false,
        method_summary: {},
        method_log: [],
        chrome: null
      };
    }
    return {
      status: "FAILED",
      error: {
        code: "RUN_NOT_FOUND",
        message: `No recruit run found for run_id=${runId}`,
        retryable: false
      }
    };
  }
}

export function pauseRecruitPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeText(args.run_id);
  try {
    const before = recruitRunService.getRecruitRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistRecruitRunSnapshot(before);
      return attachMethodEvidence({
        status: "PAUSE_IGNORED",
        run: normalizedBefore,
        message: "目标任务已结束，无需暂停。"
      }, runId);
    }
    if (before.status === RUN_STATUS_PAUSED) {
      const normalizedBefore = persistRecruitRunSnapshot(before);
      return attachMethodEvidence({
        status: "PAUSE_IGNORED",
        run: normalizedBefore,
        message: "目标任务已经处于 paused 状态。"
      }, runId);
    }
    const run = recruitRunService.pauseRecruitRun(runId);
    const normalizedRun = persistRecruitRunSnapshot(run);
    return attachMethodEvidence({
      status: "PAUSE_REQUESTED",
      run: normalizedRun,
      message: "暂停请求已接收，将在当前候选人处理完成后进入 paused。"
    }, runId);
  } catch {
    const persisted = readRecruitRunState(runId);
    if (persisted && TERMINAL_STATUSES.has(persisted.state)) {
      return {
        status: "PAUSE_IGNORED",
        run: persisted,
        message: "目标任务已结束，无需暂停。",
        runtime_evaluate_used: false,
        method_summary: {},
        method_log: [],
        chrome: null
      };
    }
    if (persisted) {
      const reconciled = reconcilePersistedRecruitRun(persisted);
      if (reconciled.stale_finalized) return getRecruitPipelineRunTool({ args });
      return patchPersistedRecruitControl(runId, {
        pause_requested: true,
        pause_requested_at: new Date().toISOString(),
        pause_requested_by: "pause_recruit_pipeline_run",
        cancel_requested: false
      }, {
        status: "PAUSE_REQUESTED",
        message: "暂停请求已写入 detached search run 控制文件。",
        lastMessage: "暂停请求已写入 detached search run 控制文件。"
      }) || getRecruitPipelineRunTool({ args });
    }
    return getRecruitPipelineRunTool({ args });
  }
}

export function resumeRecruitPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeText(args.run_id);
  try {
    const before = recruitRunService.getRecruitRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistRecruitRunSnapshot(before);
      return attachMethodEvidence({
        status: "FAILED",
        error: {
          code: "RUN_ALREADY_TERMINATED",
          message: "目标任务已结束，无法继续。",
          retryable: false
        },
        run: normalizedBefore
      }, runId);
    }
    if (before.status !== RUN_STATUS_PAUSED) {
      const normalizedBefore = persistRecruitRunSnapshot(before);
      return attachMethodEvidence({
        status: "FAILED",
        error: {
          code: "RUN_NOT_PAUSED",
          message: "仅 paused 状态的 run 才能继续。",
          retryable: true
        },
        run: normalizedBefore
      }, runId);
    }
    const run = recruitRunService.resumeRecruitRun(runId);
    const meta = getRecruitRunMeta(runId);
    if (meta) {
      meta.resumeCount = (meta.resumeCount || 0) + 1;
      meta.lastResumedAt = new Date().toISOString();
    }
    const normalizedRun = persistRecruitRunSnapshot(run);
    return attachMethodEvidence({
      status: "RESUME_REQUESTED",
      run: normalizedRun,
      poll_after_sec: DEFAULT_RECRUIT_POLL_AFTER_SEC,
      message: "已恢复 Boss 招聘流水线，请使用 get_recruit_pipeline_run 按需轮询。"
    }, runId);
  } catch {
    const persisted = readRecruitRunState(runId);
    if (persisted) {
      const reconciled = reconcilePersistedRecruitRun(persisted);
      const reconciledState = reconciled.run?.state || reconciled.run?.status;
      if (!TERMINAL_STATUSES.has(reconciledState)) {
        return patchPersistedRecruitControl(runId, {
          pause_requested: false,
          pause_requested_at: null,
          pause_requested_by: null,
          cancel_requested: false
        }, {
          status: "RESUME_REQUESTED",
          message: "恢复请求已写入 detached search run 控制文件。",
          lastMessage: "恢复请求已写入 detached search run 控制文件。"
        }) || getRecruitPipelineRunTool({ args });
      }
      return {
        status: TERMINAL_STATUSES.has(persisted.state) ? "FAILED" : "FAILED",
        error: {
          code: TERMINAL_STATUSES.has(reconciledState) ? "RUN_ALREADY_TERMINATED" : "RUN_NOT_ACTIVE",
          message: TERMINAL_STATUSES.has(reconciledState)
            ? "目标任务已结束，无法继续。"
            : "该 run 只有磁盘快照，没有当前进程内的活动 CDP 会话，无法安全继续。",
          retryable: !TERMINAL_STATUSES.has(reconciledState)
        },
        run: reconciled.run,
        persistence: {
          source: "disk",
          active_control_available: false,
          stale_finalized: reconciled.stale_finalized === true
        },
        runtime_evaluate_used: false,
        method_summary: {},
        method_log: [],
        chrome: null
      };
    }
    return getRecruitPipelineRunTool({ args });
  }
}

export function cancelRecruitPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeText(args.run_id);
  try {
    const before = recruitRunService.getRecruitRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistRecruitRunSnapshot(before);
      return attachMethodEvidence({
        status: "CANCEL_IGNORED",
        run: normalizedBefore,
        message: "目标任务已结束，无需取消。"
      }, runId);
    }
    const run = recruitRunService.cancelRecruitRun(runId);
    const normalizedRun = persistRecruitRunSnapshot(run);
    return attachMethodEvidence({
      status: "CANCEL_REQUESTED",
      run: normalizedRun,
      message: "已收到取消请求，将在当前候选人处理完成后安全停止。"
    }, runId);
  } catch {
    const persisted = readRecruitRunState(runId);
    if (persisted && TERMINAL_STATUSES.has(persisted.state)) {
      return {
        status: "CANCEL_IGNORED",
        run: persisted,
        message: "目标任务已结束，无需取消。",
        runtime_evaluate_used: false,
        method_summary: {},
        method_log: [],
        chrome: null
      };
    }
    if (persisted) {
      const reconciled = reconcilePersistedRecruitRun(persisted, { cancelStale: true });
      if (reconciled.stale_finalized) {
        return {
          status: "CANCEL_REQUESTED",
          run: reconciled.run,
          message: "该 search run 的后台进程已经不在，已将磁盘状态安全标记为 canceled 并生成结果文件。",
          persistence: {
            source: "disk",
            active_control_available: false,
            stale_finalized: true
          },
          runtime_evaluate_used: false,
          method_summary: {},
          method_log: [],
          chrome: null
        };
      }
      return patchPersistedRecruitControl(runId, {
        pause_requested: true,
        pause_requested_at: new Date().toISOString(),
        pause_requested_by: "cancel_recruit_pipeline_run",
        cancel_requested: true
      }, {
        status: "CANCEL_REQUESTED",
        message: "取消请求已写入 detached search run 控制文件。",
        lastMessage: "取消请求已写入 detached search run 控制文件。"
      }) || getRecruitPipelineRunTool({ args });
    }
    return getRecruitPipelineRunTool({ args });
  }
}

export function __setRecruitMcpConnectorForTests(nextConnector) {
  recruitConnectorImpl = typeof nextConnector === "function" ? nextConnector : connectRecruitChromeSession;
}

export function __setRecruitMcpWorkflowForTests(nextWorkflow) {
  recruitWorkflowImpl = typeof nextWorkflow === "function" ? nextWorkflow : runRecruitWorkflow;
  recruitRunService = createRecruitRunService({
    idPrefix: "mcp_recruit",
    workflow: (...args) => recruitWorkflowImpl(...args),
    onSnapshot: persistRecruitLifecycleSnapshot
  });
}

export function __resetRecruitMcpStateForTests() {
  for (const meta of recruitRunMeta.values()) {
    try {
      meta.session?.close?.();
    } catch {
      // Best-effort test cleanup.
    }
  }
  recruitRunMeta.clear();
  __setRecruitMcpConnectorForTests(null);
  __setRecruitMcpWorkflowForTests(null);
}
