import fs from "node:fs";
import path from "node:path";
import process from "node:process";
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
  RUN_STATUS_PAUSED
} from "./core/run/index.js";
import {
  buildLegacyScreenInputRows,
  cloneReportInput,
  writeLegacyScreenCsv
} from "./core/reporting/legacy-csv.js";
import {
  buildRecommendSelfHealConfig,
  HEALTH_STATUS,
  resolveRecommendSelfHealRoots,
  runSelfHealCheck
} from "./core/self-heal/index.js";
import {
  closeRecommendJobDropdown,
  closeRecommendDetail,
  createRecommendRunService,
  getRecommendRoots,
  listRecommendJobOptions,
  RECOMMEND_TARGET_URL,
  runRecommendWorkflow
} from "./domains/recommend/index.js";
import {
  parseRecommendInstruction
} from "./parser.js";
import { getRunsDir } from "./run-state.js";
import {
  resolveBossConfiguredOutputDir,
  resolveHumanBehaviorForRun,
  resolveBossScreeningConfig
} from "./chat-runtime-config.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "./core/cv-acquisition/index.js";

const DEFAULT_RECOMMEND_HOST = "127.0.0.1";
const DEFAULT_RECOMMEND_PORT = 9222;
const DEFAULT_RECOMMEND_POLL_AFTER_SEC = 10;
const TARGET_COUNT_SEMANTICS = "target_count means candidates that pass screening; scan continues until that many candidates pass or the list ends";
const RUN_MODE_ASYNC = "async";
const REST_LEVEL_OPTIONS = ["low", "medium", "high"];
const REST_LEVEL_SET = new Set(REST_LEVEL_OPTIONS);

const TERMINAL_STATUSES = new Set([
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_CANCELED
]);

let recommendWorkflowImpl = runRecommendWorkflow;
let recommendConnectorImpl = connectRecommendChromeSession;
let recommendJobReaderImpl = readRecommendJobOptionsFromSession;
let recommendRunService = createRecommendRunService({
  idPrefix: "mcp_recommend",
  workflow: (...args) => recommendWorkflowImpl(...args),
  onSnapshot: persistRecommendLifecycleSnapshot
});
const recommendRunMeta = new Map();

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

function collectRecommendDebugTestOptions(args = {}, normalized = {}) {
  const reasons = [];
  if (normalizeScreeningModeArg(args) === "deterministic") reasons.push("deterministic_screening");
  if (args.allow_card_only_screening === true) reasons.push("allow_card_only_screening");
  if (parseNonNegativeInteger(args.detail_limit, null) === 0) reasons.push("detail_limit=0");
  if (args.no_filter === true) reasons.push("no_filter");
  if (args.filter_enabled === false) reasons.push("filter_enabled=false");
  if (args.dry_run_post_action === true) reasons.push("dry_run_post_action");
  if (args.execute_post_action === false && normalized.postAction && normalized.postAction !== "none") {
    reasons.push("execute_post_action=false");
  }
  return reasons;
}

function resolveRecommendDetailLimit(args = {}, normalized = {}) {
  const fallback = parsePositiveInteger(normalized.targetCount, 5);
  const requested = parseNonNegativeInteger(args.detail_limit, fallback);
  if (requested === 0 && !isDebugTestMode(args)) {
    return fallback;
  }
  if (requested === 0 && args.allow_card_only_screening !== true) {
    return fallback;
  }
  return requested;
}

function methodSummary(methodLog = []) {
  const summary = {};
  for (const entry of methodLog || []) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
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

function nonEmptyRecord(value) {
  const record = plainRecord(value);
  return Object.keys(record).length ? record : null;
}

function normalizeRunId(runId) {
  const normalized = normalizeText(runId);
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) return "";
  return normalized;
}

function getRecommendRunArtifacts(runId) {
  const normalized = normalizeRunId(runId);
  if (!normalized) return null;
  const runsDir = getRunsDir();
  const outputDir = resolveBossConfiguredOutputDir("", runsDir);
  return {
    runs_dir: runsDir,
    output_dir: outputDir,
    run_state_path: path.join(runsDir, `${normalized}.json`),
    checkpoint_path: path.join(runsDir, `${normalized}.checkpoint.json`),
    worker_stdout_path: path.join(runsDir, `${normalized}.worker.stdout.log`),
    worker_stderr_path: path.join(runsDir, `${normalized}.worker.stderr.log`),
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

function recommendSearchParamsForCsv(searchParams = {}) {
  return {
    school_tag: Object.prototype.hasOwnProperty.call(searchParams, "school_tag") ? searchParams.school_tag : "不限",
    degree: Object.prototype.hasOwnProperty.call(searchParams, "degree") ? searchParams.degree : "不限",
    gender: Object.prototype.hasOwnProperty.call(searchParams, "gender") ? searchParams.gender : "不限",
    recent_not_view: Object.prototype.hasOwnProperty.call(searchParams, "recent_not_view") ? searchParams.recent_not_view : "不限"
  };
}

function getSnapshotRequestContext(snapshot = {}) {
  const context = plainRecord(snapshot?.context);
  const shared = plainRecord(context.shared_run_context);
  return {
    context,
    confirmation: nonEmptyRecord(context.confirmation) || plainRecord(shared.confirmation),
    overrides: nonEmptyRecord(context.overrides) || plainRecord(shared.overrides),
    followUp: context.follow_up ?? shared.follow_up ?? null,
    shared
  };
}

function selectedRecommendJobForCsv(meta = {}, snapshot = {}) {
  const { confirmation, overrides, shared } = getSnapshotRequestContext(snapshot);
  const value = normalizeText(
    meta.args?.confirmation?.job_value
    || meta.normalized?.job
    || meta.args?.overrides?.job
    || confirmation.job_value
    || overrides.job
    || shared.confirmation?.job_value
    || shared.overrides?.job
    || shared.job_label
    || ""
  );
  return {
    value,
    title: value,
    label: value
  };
}

function buildRecommendCsvInputRows(snapshot = {}, meta = {}) {
  const { context, confirmation, overrides, followUp, shared } = getSnapshotRequestContext(snapshot);
  const searchParams = recommendSearchParamsForCsv(meta.parsed?.searchParams || {
    school_tag: overrides.school_tag ?? confirmation.school_tag_value,
    degree: overrides.degree ?? confirmation.degree_value,
    gender: overrides.gender ?? confirmation.gender_value,
    recent_not_view: overrides.recent_not_view ?? confirmation.recent_not_view_value
  });
  const parsedScreenParams = meta.parsed?.screenParams || {};
  const screenParams = {
    criteria: parsedScreenParams.criteria || meta.normalized?.criteria || overrides.criteria || "",
    target_count: parsedScreenParams.target_count || snapshot.progress?.target_count || meta.normalized?.targetCount || overrides.target_count || confirmation.target_count_value || shared.max_candidates || "",
    post_action: parsedScreenParams.post_action || overrides.post_action || confirmation.post_action_value || shared.post_action || "none",
    max_greet_count: parsedScreenParams.max_greet_count ?? overrides.max_greet_count ?? confirmation.max_greet_count_value ?? shared.max_greet_count ?? ""
  };
  return buildLegacyScreenInputRows({
    instruction: meta.args?.instruction || context.instruction || shared.instruction || "",
    selectedPage: "recommend",
    selectedJob: selectedRecommendJobForCsv(meta, snapshot),
    userSearchParams: cloneReportInput(searchParams, {}),
    effectiveSearchParams: cloneReportInput(searchParams, {}),
    screenParams,
    followUp: meta.args?.follow_up || meta.args?.overrides?.follow_up || followUp || overrides.follow_up || null
  });
}

function writeRecommendLegacyCsvAtomic(filePath, rows = [], snapshot = {}, meta = {}) {
  writeLegacyScreenCsv(filePath, {
    inputRows: buildRecommendCsvInputRows(snapshot, meta),
    results: rows
  });
}

function readRecommendRunState(runId) {
  const artifacts = getRecommendRunArtifacts(runId);
  if (!artifacts) return null;
  return readJsonFile(artifacts.run_state_path);
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

function getRecommendRunMeta(runId) {
  return recommendRunMeta.get(runId) || {};
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
  const screened = Number.isInteger(progress.screened)
    ? progress.screened
    : Number.isInteger(summary?.screened)
      ? summary.screened
      : processed;
  const passed = Number.isInteger(progress.passed)
    ? progress.passed
    : Number.isInteger(summary?.passed)
      ? summary.passed
      : 0;
  return {
    ...progress,
    processed,
    inspected: processed,
    screened,
    passed,
    skipped: Number.isInteger(progress.skipped) ? progress.skipped : Math.max(processed - passed, 0),
    greet_count: Number.isInteger(progress.greet_count) ? progress.greet_count : 0,
    post_action_clicked: Number.isInteger(progress.post_action_clicked) ? progress.post_action_clicked : 0
  };
}

function completionReason(status) {
  if (status === RUN_STATUS_COMPLETED) return "completed";
  if (status === RUN_STATUS_CANCELED) return "canceled_by_user";
  if (status === RUN_STATUS_FAILED) return "failed";
  if (status === RUN_STATUS_PAUSED) return "paused";
  return null;
}

function normalizeErrorText(error = {}) {
  return normalizeText([
    error?.code || "",
    error?.message || error || ""
  ].join(" "));
}

function classifyRecommendRecovery(error = {}) {
  const text = normalizeErrorText(error);
  if (!text) return null;
  if (/BOSS_LOGIN_REQUIRED/i.test(text)) return "login_required";
  if (/Could not find node with given id|No node with given id|Node is detached|Cannot find node|DETAIL_STALE_NODE|IMAGE_CAPTURE_STALE_NODE/i.test(text)) {
    return "transient_stale_dom";
  }
  if (/IMAGE_CAPTURE_TIMEOUT|IMAGE_CAPTURE_TOTAL_TIMEOUT|Image fallback capture timed out/i.test(text)) {
    return "transient_image_capture";
  }
  if (/(?:aborted|abort|timeout|timed out|fetch failed|socket|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/i.test(text)) {
    return "transient_network_or_llm";
  }
  return null;
}

function isCancelShutdownError(error = {}) {
  const text = normalizeErrorText(error);
  return /socket hang up|ECONNREFUSED|ECONNRESET|WebSocket is not open|Target closed|Session closed|Connection closed|RUN_PROCESS_EXITED|DETACHED_WORKER|RUN_WORKER/i.test(text);
}

function buildConstrainedAgentRecovery(snapshot = {}, meta = {}, artifacts = null) {
  const error = snapshot?.error || snapshot?.result?.error || null;
  const classification = classifyRecommendRecovery(error);
  if (!classification) return null;
  const canRestartSameRequest = classification !== "login_required";
  return {
    policy_version: 1,
    classification,
    safe_for_outer_ai_agent: true,
    recommended_action: canRestartSameRequest
      ? "restart_same_recommend_request_only"
      : "ask_user_to_login_then_retry_same_recommend_request",
    package_requirement: "@reconcrap/boss-recommend-mcp@>=2.0.30",
    run_id: snapshot?.runId || snapshot?.run_id || null,
    retryable: true,
    same_request_sources: {
      instruction: "run.context.instruction",
      confirmation: "run.context.confirmation",
      overrides: "run.context.overrides",
      follow_up: "run.context.follow_up"
    },
    constraints: [
      "Do not change instruction, criteria, filters, job, page_scope, target_count, post_action, or max_greet_count.",
      "Do not switch to search/recruit/chat and do not add follow_up.chat.",
      "Do not summarize, translate, or rewrite criteria.",
      "Do not ask the user to reconfirm business choices unless Boss login is required or the stored context is missing.",
      "Use the same Chrome debug port and recommend page route."
    ],
    artifacts: artifacts ? {
      run_state_path: artifacts.run_state_path || null,
      checkpoint_path: artifacts.checkpoint_path || null,
      report_json: artifacts.report_json || null,
      output_csv: artifacts.output_csv || null
    } : null
  };
}

function ensureRecommendRunArtifacts(snapshot) {
  const artifacts = getRecommendRunArtifacts(snapshot?.runId || snapshot?.run_id);
  if (!artifacts) return null;

  const meta = getRecommendRunMeta(snapshot?.runId || snapshot?.run_id);
  const checkpoint = snapshot?.checkpoint && typeof snapshot.checkpoint === "object"
    ? snapshot.checkpoint
    : {};
  writeJsonAtomic(artifacts.checkpoint_path, checkpoint);
  if (meta) meta.checkpointPath = artifacts.checkpoint_path;

  const summary = snapshot?.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const checkpointResults = Array.isArray(checkpoint.results) ? checkpoint.results : [];
  const artifactSummary = summary || (checkpointResults.length ? {
    domain: "recommend",
    partial: true,
    partial_reason: snapshot?.status || snapshot?.state || "non_terminal",
    results: checkpointResults
  } : null);
  if (artifactSummary) {
    const rows = Array.isArray(artifactSummary.results) ? artifactSummary.results : [];
    writeRecommendLegacyCsvAtomic(artifacts.output_csv, rows, snapshot, meta);
    writeJsonAtomic(artifacts.report_json, {
      run_id: snapshot.runId || snapshot.run_id,
      status: snapshot.status || snapshot.state,
      phase: snapshot.phase || snapshot.stage,
      progress: snapshot.progress || {},
      context: snapshot.context || {},
      checkpoint,
      error: snapshot.error || null,
      last_message: snapshot.error?.message || snapshot.phase || snapshot.stage || null,
      recovery: buildConstrainedAgentRecovery(snapshot, meta, artifacts),
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

function persistRecommendCheckpointSnapshot(normalized) {
  const artifacts = getRecommendRunArtifacts(normalized?.run_id || normalized?.runId);
  if (!artifacts) return;
  const checkpoint = normalized?.checkpoint && typeof normalized.checkpoint === "object"
    ? normalized.checkpoint
    : {};
  writeJsonAtomic(artifacts.checkpoint_path, checkpoint);
  const meta = getRecommendRunMeta(normalized?.run_id || normalized?.runId);
  if (meta) meta.checkpointPath = artifacts.checkpoint_path;
}

function buildLegacyRecommendResult(snapshot) {
  if (!snapshot) return null;
  const artifacts = ensureRecommendRunArtifacts(snapshot);
  const meta = getRecommendRunMeta(snapshot.runId);
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
      : meta.parsed?.screenParams?.target_count || null;
  return {
    status: snapshot.status === RUN_STATUS_COMPLETED
      ? "COMPLETED"
      : snapshot.status === RUN_STATUS_CANCELED
        ? "CANCELED"
        : snapshot.status === RUN_STATUS_PAUSED
          ? "PAUSED"
          : snapshot.status === RUN_STATUS_FAILED
            ? "FAILED"
            : snapshot.status,
    run_id: snapshot.runId,
    completion_reason: completionReason(snapshot.status),
    requested_count: targetCount,
    processed_count: progress.processed,
    inspected_count: progress.processed,
    screened_count: progress.screened,
    passed_count: progress.passed,
    skipped_count: progress.skipped,
    detail_opened: progress.detail_opened || summary?.detail_opened || 0,
    greet_count: progress.greet_count || 0,
    post_action_clicked: progress.post_action_clicked || summary?.post_action_clicked || 0,
    output_csv: artifacts?.output_csv || meta.outputCsvPath || null,
    report_json: artifacts?.report_json || meta.reportJsonPath || null,
    checkpoint_path: artifacts?.checkpoint_path || meta.checkpointPath || null,
    started_at: snapshot.startedAt,
    completed_at: snapshot.completedAt || null,
    duration_sec: secondsBetween(snapshot.startedAt, snapshot.completedAt),
    selected_job: {
      title: meta.normalized?.job || meta.args?.confirmation?.job_value || meta.args?.overrides?.job || ""
    },
    selected_page_scope: summary?.page_scope || {
      requested_scope: meta.normalized?.pageScope || meta.parsed?.page_scope || "recommend",
      effective_scope: meta.normalized?.pageScope || meta.parsed?.page_scope || "recommend"
    },
    search_params: clonePlain(meta.parsed?.searchParams || {}, {}),
    screen_params: clonePlain(meta.parsed?.screenParams || {}, {}),
    target_count_semantics: TARGET_COUNT_SEMANTICS,
    error: snapshot.error || null,
    recovery: buildConstrainedAgentRecovery(snapshot, meta, artifacts),
    results: resultRows
  };
}

function normalizeRunSnapshot(snapshot) {
  if (!snapshot) return null;
  const meta = getRecommendRunMeta(snapshot.runId);
  const artifacts = getRecommendRunArtifacts(snapshot.runId);
  const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const progress = normalizeLegacyProgress(snapshot.progress, summary);
  const legacyResult = (
    TERMINAL_STATUSES.has(snapshot.status)
    || snapshot.status === RUN_STATUS_PAUSED
  ) ? buildLegacyRecommendResult({ ...snapshot, progress }) : null;
  const recovery = buildConstrainedAgentRecovery(snapshot, meta, artifacts);
  const snapshotContext = plainRecord(snapshot.context);
  const metaArgs = plainRecord(meta.args);
  const oldContext = {
    workspace_root: meta.workspaceRoot || snapshotContext.workspace_root || null,
    instruction: metaArgs.instruction || snapshotContext.instruction || "",
    confirmation: clonePlain(metaArgs.confirmation ?? snapshotContext.confirmation ?? {}, {}),
    overrides: clonePlain(metaArgs.overrides ?? snapshotContext.overrides ?? {}, {}),
    follow_up: clonePlain(metaArgs.follow_up ?? snapshotContext.follow_up ?? null, null),
    target_count_semantics: TARGET_COUNT_SEMANTICS
  };
  return {
    ...snapshot,
    progress,
    run_id: snapshot.runId,
    mode: RUN_MODE_ASYNC,
    state: snapshot.status,
    stage: snapshot.phase,
    started_at: snapshot.startedAt,
    updated_at: snapshot.updatedAt,
    completed_at: toIsoOrNull(snapshot.completedAt),
    heartbeat_at: snapshot.updatedAt,
    pid: Number.isInteger(snapshot.pid) && snapshot.pid > 0 ? snapshot.pid : process.pid || null,
    last_message: snapshot.error?.message || snapshot.phase || null,
    context: {
      ...snapshotContext,
      ...oldContext,
      shared_run_context: snapshotContext
    },
    control: {
      pause_requested: snapshot.status === RUN_STATUS_PAUSED,
      pause_requested_at: snapshot.status === RUN_STATUS_PAUSED ? snapshot.updatedAt : null,
      pause_requested_by: snapshot.status === RUN_STATUS_PAUSED ? "pause_recommend_pipeline_run" : null,
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
    recovery,
    result: legacyResult,
    artifacts
  };
}

function mergePersistedControlRequest(normalized, existing) {
  const control = {
    ...(normalized?.control || {})
  };
  const existingControl = plainRecord(existing?.control);
  if (!normalized) return control;
  if (TERMINAL_STATUSES.has(normalized.state)) {
    if (
      normalized.state === RUN_STATUS_FAILED
      && existingControl.cancel_requested === true
      && isCancelShutdownError(normalized.error || normalized.result?.error || "")
    ) {
      return {
        ...control,
        pause_requested: true,
        pause_requested_at: existingControl.pause_requested_at || control.pause_requested_at || new Date().toISOString(),
        pause_requested_by: existingControl.pause_requested_by || control.pause_requested_by || "cancel_recommend_pipeline_run",
        cancel_requested: true
      };
    }
    return control;
  }
  if (existingControl.cancel_requested === true) {
    return {
      ...control,
      pause_requested: true,
      pause_requested_at: existingControl.pause_requested_at || control.pause_requested_at || new Date().toISOString(),
      pause_requested_by: existingControl.pause_requested_by || control.pause_requested_by || "cancel_recommend_pipeline_run",
      cancel_requested: true
    };
  }
  if (existingControl.pause_requested === true && normalized.state !== RUN_STATUS_PAUSED) {
    return {
      ...control,
      pause_requested: true,
      pause_requested_at: existingControl.pause_requested_at || control.pause_requested_at || new Date().toISOString(),
      pause_requested_by: existingControl.pause_requested_by || control.pause_requested_by || "pause_recommend_pipeline_run"
    };
  }
  if (existingControl.pause_requested === false && normalized.state === RUN_STATUS_PAUSED) {
    return {
      ...control,
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    };
  }
  return control;
}

function cancelErrorFromShutdown(shutdownError = null) {
  return {
    code: "PIPELINE_CANCELED",
    message: "流水线已取消。",
    retryable: true,
    shutdown_error: shutdownError || undefined
  };
}

function coerceCanceledTerminalSnapshot(normalized, existing) {
  const existingControl = plainRecord(existing?.control);
  const shutdownError = normalized?.error || normalized?.result?.error || null;
  const shouldWrapCanceledShutdown = (
    normalized
    && (
      (
        normalized.state === RUN_STATUS_FAILED
        && existingControl.cancel_requested === true
      )
      || normalized.state === RUN_STATUS_CANCELED
    )
    && isCancelShutdownError(shutdownError || "")
  );
  if (
    !shouldWrapCanceledShutdown
  ) {
    return normalized;
  }
  const canceledError = cancelErrorFromShutdown(shutdownError);
  return {
    ...normalized,
    state: RUN_STATUS_CANCELED,
    status: RUN_STATUS_CANCELED,
    last_message: "流水线已取消；取消收尾时浏览器连接已关闭。",
    control: {
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    },
    error: canceledError,
    result: normalized.result ? {
      ...normalized.result,
      status: "CANCELED",
      completion_reason: "canceled_by_user",
      error: canceledError
    } : {
      status: "CANCELED",
      completion_reason: "canceled_by_user",
      error: canceledError,
      run_id: normalized.run_id,
      processed_count: normalized.progress?.processed || 0,
      screened_count: normalized.progress?.screened || normalized.progress?.processed || 0,
      passed_count: normalized.progress?.passed || 0
    }
  };
}

function persistRecommendRunSnapshot(snapshot, {
  persistActiveCheckpoint = false
} = {}) {
  let normalized = normalizeRunSnapshot(snapshot);
  if (!normalized?.run_id) return normalized;
  const artifacts = getRecommendRunArtifacts(normalized.run_id);
  if (!artifacts) return normalized;
  const existing = readJsonFile(artifacts.run_state_path);
  normalized.control = mergePersistedControlRequest(normalized, existing);
  normalized = coerceCanceledTerminalSnapshot(normalized, existing);
  if (persistActiveCheckpoint) {
    persistRecommendCheckpointSnapshot(normalized);
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
    recovery: normalized.recovery,
    result: normalized.result,
    summary: normalized.summary,
    artifacts: normalized.artifacts
  };
  writeJsonAtomic(artifacts.run_state_path, payload);
  return normalized;
}

function patchPersistedRecommendRunControl(runId, controlPatch = {}, {
  message = ""
} = {}) {
  const artifacts = getRecommendRunArtifacts(runId);
  if (!artifacts) return null;
  const current = readJsonFile(artifacts.run_state_path);
  const state = normalizeText(current?.state || current?.status || "");
  if (!current || TERMINAL_STATUSES.has(state)) return null;
  const now = new Date().toISOString();
  const patched = {
    ...current,
    updated_at: now,
    heartbeat_at: current.heartbeat_at || now,
    last_message: message || current.last_message || "",
    control: {
      ...(current.control || {}),
      ...controlPatch
    }
  };
  writeJsonAtomic(artifacts.run_state_path, patched);
  return patched;
}

function reconcilePersistedRecommendRunIfNeeded(persisted) {
  if (!persisted || typeof persisted !== "object") return persisted;
  const persistedState = normalizeText(persisted.state || persisted.status);
  if (TERMINAL_STATUSES.has(persistedState)) return persisted;
  if (isProcessAlive(persisted.pid)) return persisted;

  const runId = normalizeRunId(persisted.run_id || persisted.runId);
  const artifacts = getRecommendRunArtifacts(runId);
  const checkpoint = artifacts?.checkpoint_path ? readJsonFile(artifacts.checkpoint_path) : null;
  const now = new Date().toISOString();
  const cancelRequested = persisted.control?.cancel_requested === true;
  const processExitedError = {
    code: "RUN_PROCESS_EXITED",
    message: `检测到推荐任务进程已退出（pid=${persisted.pid || "unknown"}）。`,
    retryable: true
  };
  const error = cancelRequested
    ? cancelErrorFromShutdown(processExitedError)
    : {
        ...processExitedError,
        message: `检测到推荐任务进程已退出（pid=${persisted.pid || "unknown"}），已自动标记为失败。`
      };
  return persistRecommendRunSnapshot({
    runId,
    name: persisted.name || runId,
    status: cancelRequested ? RUN_STATUS_CANCELED : RUN_STATUS_FAILED,
    phase: persisted.stage || persisted.phase || "recommend:orphaned",
    progress: persisted.progress || {},
    context: persisted.context || {},
    checkpoint: checkpoint || persisted.checkpoint || {},
    startedAt: persisted.started_at || persisted.startedAt || now,
    updatedAt: now,
    completedAt: now,
    pid: Number.isInteger(persisted.pid) && persisted.pid > 0 ? persisted.pid : null,
    error,
    summary: persisted.summary || null
  });
}

function persistRecommendLifecycleSnapshot(snapshot, event = {}) {
  return persistRecommendRunSnapshot(snapshot, {
    persistActiveCheckpoint: event?.type === "checkpoint"
  });
}

function attachMethodEvidence(payload, runId) {
  const meta = getRecommendRunMeta(runId);
  assertNoForbiddenCdpCalls(meta.methodLog || []);
  return {
    ...payload,
    runtime_evaluate_used: false,
    method_summary: methodSummary(meta.methodLog || []),
    method_log: meta.methodLog || [],
    chrome: meta.chrome || null
  };
}

function compactRecommendJobListOption(option, index) {
  const label = normalizeText(option?.label);
  const name = normalizeText(option?.label_without_salary || label);
  return {
    index,
    name,
    label,
    label_without_salary: name,
    current: Boolean(option?.current),
    visible: Boolean(option?.visible)
  };
}

async function readRecommendJobOptionsFromSession(session) {
  const client = session?.client;
  if (!client) throw new Error("Recommend Chrome session is missing a CDP client");
  const rootState = await getRecommendRoots(client);
  const frameNodeId = rootState?.iframe?.documentNodeId;
  if (!frameNodeId) throw new Error("recommendFrame iframe document was not found");

  let options = [];
  try {
    options = await listRecommendJobOptions(client, frameNodeId, {
      openDropdown: true
    });
  } finally {
    await closeRecommendJobDropdown(client).catch(() => {});
  }

  const compacted = [];
  const seen = new Set();
  for (const option of options) {
    const compact = compactRecommendJobListOption(option, compacted.length);
    if (!compact.name && !compact.label) continue;
    const key = `${compact.name}\n${compact.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push(compact);
  }

  return {
    source: "recommend_job_dropdown",
    selector: "recommend job selection dropdown",
    job_options: compacted,
    selected_job: compacted.find((option) => option.current) || null
  };
}

export async function listRecommendJobsTool({ workspaceRoot = "", args = {} } = {}) {
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const host = normalizeText(args.host) || DEFAULT_RECOMMEND_HOST;
  const port = parsePositiveInteger(
    args.port,
    configResolution.ok ? configResolution.config.debugPort : DEFAULT_RECOMMEND_PORT
  );
  const targetUrlIncludes = normalizeText(args.target_url_includes) || RECOMMEND_TARGET_URL;
  const allowNavigate = args.allow_navigate !== false;
  const slowLive = args.slow_live === true;
  let session;

  try {
    session = await recommendConnectorImpl({
      host,
      port,
      targetUrlIncludes,
      allowNavigate,
      slowLive
    });

    const jobs = await recommendJobReaderImpl(session, {
      workspaceRoot: normalizeText(workspaceRoot) || process.cwd(),
      args: clonePlain(args, {}),
      normalized: {
        host,
        port,
        targetUrlIncludes,
        allowNavigate,
        slowLive
      }
    });
    const jobOptions = Array.isArray(jobs?.job_options) ? jobs.job_options : [];
    assertNoForbiddenCdpCalls(session.methodLog || []);
    return {
      status: "OK",
      stage: "recommend_job_list",
      cdp_only: true,
      runtime_evaluate_used: false,
      page_url: session.navigation?.url || session.target?.url || RECOMMEND_TARGET_URL,
      job_count: jobOptions.length,
      job_names: jobOptions.map((option) => option.name || option.label).filter(Boolean),
      job_full_labels: jobOptions.map((option) => option.label || option.name).filter(Boolean),
      job_options: jobOptions,
      selected_job: jobs?.selected_job || jobOptions.find((option) => option.current) || null,
      source: jobs?.source || "recommend_job_dropdown",
      selector: jobs?.selector || "",
      message: "已通过 CDP-only 从推荐页岗位下拉框读取可用岗位。Cron/一次性任务里的 job 参数优先使用 job_names 中的完整岗位名。",
      chrome: {
        host,
        port,
        target_url: session.navigation?.url || session.target?.url || RECOMMEND_TARGET_URL,
        target_id: session.target?.id || null,
        auto_launch: session.chrome || null
      },
      method_summary: methodSummary(session.methodLog || []),
      method_log: session.methodLog || []
    };
  } catch (error) {
    const methodLog = session?.methodLog || [];
    const loginRequired = error?.code === "BOSS_LOGIN_REQUIRED";
    return {
      status: "FAILED",
      stage: "recommend_job_list",
      cdp_only: true,
      runtime_evaluate_used: methodLog.some((entry) => String(entry?.method || entry).startsWith("Runtime.")),
      error: {
        code: loginRequired ? "BOSS_LOGIN_REQUIRED" : "RECOMMEND_JOB_LIST_FAILED",
        message: error?.message || "Failed to read recommend job list",
        requires_login: Boolean(error?.requires_login),
        login_url: error?.login_url || null,
        login_detection: error?.login_detection || null,
        current_url: error?.current_url || null,
        target_url: error?.target_url || RECOMMEND_TARGET_URL,
        chrome: error?.chrome || null,
        retryable: true
      },
      chrome: {
        host,
        port,
        target_url: targetUrlIncludes,
        auto_launch: error?.chrome || session?.chrome || null
      },
      method_summary: methodSummary(methodLog),
      method_log: methodLog
    };
  } finally {
    if (session) {
      try {
        await session.close?.();
      } catch {
        // Best-effort cleanup after a read-only helper.
      }
    }
  }
}

function compactHealth(check) {
  if (!check) return null;
  return {
    status: check.status,
    summary: check.summary,
    drift_report: check.drift_report,
    probes: (check.probes || []).map((probe) => ({
      id: probe.id,
      type: probe.type,
      status: probe.status,
      count: probe.count,
      required: probe.required
    }))
  };
}

async function waitForHealthyRecommend(client, config, {
  timeoutMs = 90000,
  intervalMs = 1000
} = {}) {
  const started = Date.now();
  let lastCheck = null;
  while (Date.now() - started <= timeoutMs) {
    const loginDetection = await detectBossLoginState(client).catch(() => null);
    if (loginDetection?.requires_login) {
      return {
        status: "login_required",
        summary: "Boss login is required",
        loginDetection
      };
    }
    const roots = await resolveRecommendSelfHealRoots(client, config);
    lastCheck = await runSelfHealCheck({
      client,
      domain: "recommend",
      roots: roots.roots,
      selectorProbes: config.selectorProbes,
      accessibilityProbes: config.accessibilityProbes,
      viewportProbes: config.viewportProbes
    });
    if (lastCheck.status === HEALTH_STATUS.HEALTHY) return lastCheck;
    await sleep(intervalMs);
  }
  return lastCheck;
}

function shouldNavigateToRecommend(url) {
  return !String(url || "").includes("/web/chat/recommend");
}

async function connectRecommendChromeSession({
  host = DEFAULT_RECOMMEND_HOST,
  port = DEFAULT_RECOMMEND_PORT,
  targetUrlIncludes = RECOMMEND_TARGET_URL,
  allowNavigate = true,
  slowLive = false
} = {}) {
  const session = await connectToChromeTargetOrOpen({
    host,
    port,
    targetUrlIncludes,
    targetUrl: RECOMMEND_TARGET_URL,
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
  if (allowNavigate && shouldNavigateToRecommend(targetUrl)) {
    await client.Page.navigate({ url: RECOMMEND_TARGET_URL });
    const settleMs = slowLive ? 12000 : 5000;
    const waited = await waitForMainFrameUrl(
      client,
      (url) => isBossLoginUrl(url) || !shouldNavigateToRecommend(url),
      { timeoutMs: settleMs, intervalMs: 500 }
    );
    navigation = {
      navigated: true,
      url: RECOMMEND_TARGET_URL,
      settle_ms: settleMs,
      observed_url: waited.url || null,
      observed_url_ok: waited.ok
    };
  }
  let currentUrl = await getMainFrameUrl(client).catch(() => navigation.url || targetUrl);
  if (allowNavigate && shouldNavigateToRecommend(currentUrl) && !isBossLoginUrl(currentUrl)) {
    await client.Page.navigate({ url: RECOMMEND_TARGET_URL });
    const settleMs = slowLive ? 12000 : 5000;
    const waited = await waitForMainFrameUrl(
      client,
      (url) => isBossLoginUrl(url) || !shouldNavigateToRecommend(url),
      { timeoutMs: settleMs, intervalMs: 500 }
    );
    navigation = {
      navigated: true,
      url: RECOMMEND_TARGET_URL,
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
      domain: "recommend",
      currentUrl: loginDetection.current_url || currentUrl,
      targetUrl: RECOMMEND_TARGET_URL,
      loginDetection,
      chrome: session.chrome || null
    });
  }
  if (shouldNavigateToRecommend(currentUrl)) {
    await session.close?.();
    throw new Error(`Boss recommend page did not navigate to ${RECOMMEND_TARGET_URL}; current URL: ${currentUrl || "unknown"}`);
  }

  const selfHealConfig = buildRecommendSelfHealConfig();
  const health = await waitForHealthyRecommend(client, selfHealConfig, {
    timeoutMs: slowLive ? 180000 : 90000,
    intervalMs: slowLive ? 1200 : 800
  });
  if (health?.loginDetection?.requires_login) {
    await session.close?.();
    throw createBossLoginRequiredError({
      domain: "recommend",
      currentUrl: health.loginDetection.current_url || currentUrl,
      targetUrl: RECOMMEND_TARGET_URL,
      loginDetection: health.loginDetection,
      chrome: session.chrome || null
    });
  }
  if (!health || health.status !== HEALTH_STATUS.HEALTHY) {
    const latestUrl = await getMainFrameUrl(client).catch(() => currentUrl);
    const latestLoginDetection = await detectBossLoginState(client, { currentUrl: latestUrl }).catch(() => ({
      requires_login: isBossLoginUrl(latestUrl),
      reason: "login_detection_failed",
      current_url: latestUrl
    }));
    if (latestLoginDetection.requires_login) {
      await session.close?.();
      throw createBossLoginRequiredError({
        domain: "recommend",
        currentUrl: latestLoginDetection.current_url || latestUrl,
        targetUrl: RECOMMEND_TARGET_URL,
        loginDetection: latestLoginDetection,
        chrome: session.chrome || null
      });
    }
    throw new Error(`Boss recommend page is not healthy: ${health?.status || "missing"}`);
  }

  return {
    ...session,
    navigation,
    health
  };
}

function parseRecommendPipelineRequest(args = {}) {
  return parseRecommendInstruction({
    instruction: args.instruction,
    confirmation: args.confirmation,
    overrides: args.overrides
  });
}

function readOwn(source, keys = []) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function getExplicitRestLevel(args = {}) {
  const behavior = readOwn(args, ["human_behavior", "humanBehavior"]);
  const raw = readOwn(behavior, ["restLevel", "rest_level"]);
  const normalized = normalizeText(raw).toLowerCase();
  return {
    raw: raw ?? null,
    restLevel: REST_LEVEL_SET.has(normalized) ? normalized : null,
    valid: REST_LEVEL_SET.has(normalized),
    missing: raw === undefined || raw === null || normalizeText(raw) === ""
  };
}

function buildReviewScreenParams(parsed) {
  return {
    ...(parsed.screenParams || {}),
    criteria: parsed.screenParams?.criteria || null,
    criteria_normalized: parsed.criteria_normalized || null,
    target_count: parsed.screenParams?.target_count ?? parsed.proposed_target_count ?? null,
    post_action: parsed.screenParams?.post_action || parsed.proposed_post_action || null,
    max_greet_count: parsed.screenParams?.max_greet_count ?? parsed.proposed_max_greet_count ?? null
  };
}

function buildReviewPageScope(parsed) {
  return parsed.page_scope || parsed.proposed_page_scope || "recommend";
}

function buildReviewJob(args = {}) {
  return normalizeText(args.confirmation?.job_value || args.overrides?.job || "") || null;
}

function buildScheduleReview(args = {}) {
  const scheduleRunAt = normalizeText(args.schedule_run_at || args.scheduleRunAt || args.run_at || args.runAt);
  const scheduleDelayMinutes = args.schedule_delay_minutes ?? args.scheduleDelayMinutes;
  const scheduleDelaySeconds = args.schedule_delay_seconds ?? args.scheduleDelaySeconds;
  if (!scheduleRunAt && scheduleDelayMinutes === undefined && scheduleDelaySeconds === undefined) return null;
  return {
    schedule_run_at: scheduleRunAt || null,
    schedule_delay_minutes: scheduleDelayMinutes ?? null,
    schedule_delay_seconds: scheduleDelaySeconds ?? null
  };
}

function buildRequiredConfirmations(parsed, args = {}) {
  const required = [];
  if (parsed.needs_page_confirmation) required.push("page_scope");
  if (parsed.needs_filters_confirmation) required.push("filters");
  if (parsed.needs_school_tag_confirmation) required.push("school_tag");
  if (parsed.needs_degree_confirmation) required.push("degree");
  if (parsed.needs_gender_confirmation) required.push("gender");
  if (parsed.needs_recent_not_view_confirmation) required.push("recent_not_view");
  if (parsed.needs_criteria_confirmation) required.push("criteria");
  if (parsed.needs_target_count_confirmation) required.push("target_count");
  if (parsed.needs_post_action_confirmation) required.push("post_action");
  if ((parsed.suspicious_fields || []).length) required.push("suspicious_fields");

  const confirmation = args.confirmation || {};
  const jobValue = normalizeText(confirmation.job_value || args.overrides?.job || "");
  if (!jobValue) required.push("job");
  const restLevel = getExplicitRestLevel(args);
  if (!restLevel.valid) required.push("rest_level");
  const blocksFinalReview = required.some((field) => field !== "rest_level");
  if (confirmation.final_confirmed !== true && !blocksFinalReview) required.push("final_review");
  return Array.from(new Set(required));
}

function buildJobPendingQuestion(args = {}) {
  const value = normalizeText(args.confirmation?.job_value || args.overrides?.job || "");
  return {
    field: "job",
    question: "请确认推荐页岗位。CDP-only rewrite 会先切换到该岗位，再按所选页面范围执行筛选。",
    value: value || null
  };
}

function buildRestLevelPendingQuestion(args = {}) {
  const restLevel = getExplicitRestLevel(args);
  return {
    field: "rest_level",
    question: restLevel.missing
      ? "请确认本次运行休息强度 rest_level。"
      : "rest_level 只能是 low / medium / high，请重新确认本次运行休息强度。",
    value: restLevel.restLevel || restLevel.raw || null,
    options: REST_LEVEL_OPTIONS.map((value) => ({
      label: value,
      value
    }))
  };
}

function buildSuspiciousFieldsQuestion(parsed) {
  return {
    field: "suspicious_fields",
    question: "检测到需要修正或明确确认的异常字段，请先修正后再启动。",
    value: parsed.suspicious_fields || []
  };
}

function buildFinalReviewQuestion(parsed, args = {}) {
  const restLevel = getExplicitRestLevel(args);
  return {
    field: "final_review",
    question: "请最终确认本次推荐页筛选参数无误；确认后设置 final_confirmed=true 即可启动或创建定时任务。",
    value: {
      page_scope: buildReviewPageScope(parsed),
      job: buildReviewJob(args),
      search_params: parsed.searchParams,
      screen_params: buildReviewScreenParams(parsed),
      human_behavior: {
        restLevel: restLevel.restLevel || null
      },
      schedule: buildScheduleReview(args)
    }
  };
}

function buildNeedInputResponse(parsed, args = {}) {
  return {
    status: "NEED_INPUT",
    missing_fields: parsed.missing_fields,
    required_confirmations: buildRequiredConfirmations(parsed, args),
    search_params: parsed.searchParams,
    screen_params: parsed.screenParams,
    pending_questions: parsed.pending_questions,
    review: parsed.review,
    error: {
      code: "MISSING_REQUIRED_FIELDS",
      message: "缺少必要字段。请补齐推荐页 criteria 等必填字段后再启动 CDP-only recommend run。",
      retryable: true
    }
  };
}

function buildNeedConfirmationResponse(parsed, args, requiredConfirmations) {
  const pending = [...(parsed.pending_questions || [])];
  if (requiredConfirmations.includes("suspicious_fields") && !pending.some((item) => item.field === "suspicious_fields")) {
    pending.push(buildSuspiciousFieldsQuestion(parsed));
  }
  if (requiredConfirmations.includes("job") && !pending.some((item) => item.field === "job")) {
    pending.push(buildJobPendingQuestion(args));
  }
  if (requiredConfirmations.includes("rest_level") && !pending.some((item) => item.field === "rest_level")) {
    pending.push(buildRestLevelPendingQuestion(args));
  }
  if (requiredConfirmations.includes("final_review") && !pending.some((item) => item.field === "final_review")) {
    pending.push(buildFinalReviewQuestion(parsed, args));
  }
  return {
    status: "NEED_CONFIRMATION",
    required_confirmations: requiredConfirmations,
    page_scope: buildReviewPageScope(parsed),
    search_params: parsed.searchParams,
    screen_params: buildReviewScreenParams(parsed),
    pending_questions: pending,
    review: {
      ...(parsed.review || {}),
      required_confirmations: requiredConfirmations
    }
  };
}

function evaluateRecommendPipelineGate(parsed, args = {}) {
  if (parsed.missing_fields?.length) return buildNeedInputResponse(parsed, args);
  const requiredConfirmations = buildRequiredConfirmations(parsed, args);
  if (requiredConfirmations.length) {
    return buildNeedConfirmationResponse(parsed, args, requiredConfirmations);
  }

  if (args.follow_up?.chat || args.overrides?.follow_up?.chat) {
    return {
      status: "FAILED",
      error: {
        code: "FOLLOW_UP_CHAT_NOT_CDP_REWRITTEN",
        message: "recommend -> chat follow-up orchestration is legacy-only and intentionally fenced from the CDP-only MCP route. Run recommend first, then use the direct chat MCP route separately, or keep the old chained behavior in the archived legacy lane.",
        retryable: true
      },
      review: parsed.review
    };
  }

  return null;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function withoutUnlimited(values = []) {
  return toArray(values)
    .map((value) => normalizeText(value))
    .filter((value) => value && value !== "不限" && value.toLowerCase() !== "all" && value !== "全部");
}

function buildRecommendFilter(parsed, args = {}) {
  if (args.no_filter === true || args.filter_enabled === false) {
    return { enabled: false };
  }

  const groups = [];
  const recentNotView = withoutUnlimited(parsed.searchParams?.recent_not_view);
  if (recentNotView.length) {
    groups.push({
      group: "recentNotView",
      labels: recentNotView,
      selectAllLabels: true
    });
  }

  const degree = withoutUnlimited(parsed.searchParams?.degree);
  if (degree.length) {
    groups.push({
      group: "degree",
      labels: degree,
      selectAllLabels: true
    });
  }

  const gender = withoutUnlimited(parsed.searchParams?.gender);
  if (gender.length) {
    groups.push({
      group: "gender",
      labels: gender,
      selectAllLabels: true
    });
  }

  const school = withoutUnlimited(parsed.searchParams?.school_tag);
  if (school.length) {
    groups.push({
      group: "school",
      labels: school,
      selectAllLabels: true
    });
  }

  return groups.length ? { filterGroups: groups } : { enabled: false };
}

function normalizeRecommendStartInput(args = {}, parsed, configResolution = null) {
  const confirmation = args.confirmation || {};
  const overrides = args.overrides || {};
  const slowLive = args.slow_live === true;
  const targetCount = parsePositiveInteger(
    args.max_candidates,
    parsed.screenParams?.target_count || parsePositiveInteger(confirmation.target_count_value, 5)
  );
  return {
    host: normalizeText(args.host) || DEFAULT_RECOMMEND_HOST,
    port: parsePositiveInteger(
      args.port,
      configResolution?.ok ? configResolution.config.debugPort : DEFAULT_RECOMMEND_PORT
    ),
    targetUrlIncludes: normalizeText(args.target_url_includes) || RECOMMEND_TARGET_URL,
    allowNavigate: args.allow_navigate !== false,
    slowLive,
    criteria: parsed.screenParams?.criteria || normalizeText(overrides.criteria),
    targetCount,
    job: normalizeText(confirmation.job_value || overrides.job || ""),
    pageScope: parsed.page_scope || "recommend",
    filter: buildRecommendFilter(parsed, args),
    postAction: parsed.screenParams?.post_action || "none",
    maxGreetCount: Number.isInteger(parsed.screenParams?.max_greet_count)
      ? parsed.screenParams.max_greet_count
      : null,
    screeningMode: normalizeScreeningModeArg(args)
  };
}

function getRunOptions(args, parsed, normalized, session, configResolution = null) {
  const slowLive = args.slow_live === true;
  const executePostAction = args.dry_run_post_action === true
    ? false
    : args.execute_post_action !== false;
  const humanBehavior = resolveHumanBehaviorForRun(args, configResolution?.config || {});
  return {
    client: session.client,
    targetUrl: RECOMMEND_TARGET_URL,
    criteria: normalized.criteria,
    jobLabel: normalized.job,
    pageScope: normalized.pageScope,
    fallbackPageScope: "recommend",
    filter: normalized.filter,
    maxCandidates: normalized.targetCount,
    detailLimit: resolveRecommendDetailLimit(args, normalized),
    closeDetail: true,
    delayMs: parseNonNegativeInteger(args.delay_ms, 0),
    cardTimeoutMs: slowLive ? 180000 : 90000,
    maxImagePages: parsePositiveInteger(args.max_image_pages, DEFAULT_MAX_IMAGE_PAGES),
    imageWheelDeltaY: parsePositiveInteger(args.image_wheel_delta_y, 650),
    cvAcquisitionMode: normalizeText(args.cv_acquisition_mode) || "unknown",
    listMaxScrolls: parsePositiveInteger(args.list_max_scrolls, 20),
    listStableSignatureLimit: parsePositiveInteger(args.list_stable_signature_limit, 2),
    listWheelDeltaY: parsePositiveInteger(args.list_wheel_delta_y, 850),
    listSettleMs: parsePositiveInteger(args.list_settle_ms, slowLive ? 1800 : 1200),
    listFallbackPoint: null,
    refreshOnEnd: args.refresh_on_end !== false,
    maxRefreshRounds: parseNonNegativeInteger(args.max_refresh_rounds, 2),
    refreshButtonSettleMs: parsePositiveInteger(args.refresh_button_settle_ms, slowLive ? 10000 : 8000),
    refreshReloadSettleMs: parsePositiveInteger(args.refresh_reload_settle_ms, slowLive ? 12000 : 8000),
    postAction: normalized.postAction,
    maxGreetCount: normalized.maxGreetCount,
    executePostAction,
    actionTimeoutMs: parsePositiveInteger(args.action_timeout_ms, slowLive ? 12000 : 8000),
    actionIntervalMs: parsePositiveInteger(args.action_interval_ms, 500),
    actionAfterClickDelayMs: parseNonNegativeInteger(args.action_after_click_delay_ms, slowLive ? 1200 : 900),
    screeningMode: normalized.screeningMode,
    llmConfig: normalized.screeningMode === "llm" && configResolution?.ok ? {
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
    imageOutputDir: resolveBossConfiguredOutputDir("", getRunsDir()),
    humanRestEnabled: humanBehavior.restEnabled,
    humanBehavior,
    name: "mcp-recommend-pipeline-run",
    parsed
  };
}

function prepareRecommendPipelineStart(args = {}, { workspaceRoot = "" } = {}) {
  const parsed = parseRecommendPipelineRequest(args);
  const gate = evaluateRecommendPipelineGate(parsed, args);
  if (gate) return { response: gate };
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const normalized = normalizeRecommendStartInput(args, parsed, configResolution);
  const debugTestOptions = collectRecommendDebugTestOptions(args, normalized);
  if (debugTestOptions.length && !isDebugTestMode(args)) {
    return {
      response: {
        status: "FAILED",
        error: {
          code: "DEBUG_TEST_MODE_REQUIRED",
          message: `这些参数属于调试/测试路径，正式 live run 不会默认启用：${debugTestOptions.join(", ")}。如确需测试，请显式传 debug_test_mode=true。`,
          retryable: false
        },
        debug_test_options: debugTestOptions
      }
    };
  }
  if (normalized.screeningMode === "llm" && !configResolution.ok) {
    return {
      response: {
        status: "FAILED",
        error: {
          code: "SCREEN_CONFIG_ERROR",
          message: configResolution.error?.message || "screening-config.json is required for LLM screening.",
          retryable: true
        },
        config_path: configResolution.config_path || null,
        candidate_paths: configResolution.candidate_paths || []
      }
    };
  }
  return {
    parsed,
    configResolution,
    normalized
  };
}

async function closeRecommendRunSession(runId) {
  const meta = recommendRunMeta.get(runId);
  if (!meta || meta.closed) return;
  try {
    try {
      if (meta.session?.client) {
        await closeRecommendDetail(meta.session.client, { attemptsLimit: 2 });
      }
    } catch {
      // Cleanup is best-effort once the run has settled.
    }
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

async function waitForRecommendRunTerminal(runId) {
  while (true) {
    try {
      const snapshot = recommendRunService.getRecommendRun(runId);
      if (TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    } catch {
      return null;
    }
    await sleep(1000);
  }
}

function trackRecommendRun(runId) {
  waitForRecommendRunTerminal(runId)
    .then((terminal) => {
      if (terminal) persistRecommendRunSnapshot(terminal);
    })
    .catch(() => null)
    .finally(() => {
      closeRecommendRunSession(runId).catch(() => {});
    });
}

async function startRecommendPipelineRunInternal(args = {}, { workspaceRoot = "", runId = "" } = {}) {
  const prepared = prepareRecommendPipelineStart(args, { workspaceRoot });
  if (prepared.response) return prepared.response;
  const { parsed, configResolution, normalized } = prepared;
  const fixedRunId = normalizeRunId(runId);
  if (runId && !fixedRunId) {
    return {
      status: "FAILED",
      error: {
        code: "INVALID_RUN_ID",
        message: "run_id is invalid",
        retryable: false
      }
    };
  }

  let session;
  try {
    session = await recommendConnectorImpl({
      host: normalized.host,
      port: normalized.port,
      targetUrlIncludes: normalized.targetUrlIncludes,
      allowNavigate: normalized.allowNavigate,
      slowLive: normalized.slowLive
    });
  } catch (error) {
    const loginRequired = error?.code === "BOSS_LOGIN_REQUIRED";
    return {
      status: "FAILED",
      error: {
        code: loginRequired ? "BOSS_LOGIN_REQUIRED" : "BOSS_RECOMMEND_PAGE_NOT_READY",
        message: error?.message || "Boss recommend page is not ready",
        requires_login: Boolean(error?.requires_login),
        login_url: error?.login_url || null,
        login_detection: error?.login_detection || null,
        chrome: error?.chrome || null,
        current_url: error?.current_url || null,
        target_url: error?.target_url || RECOMMEND_TARGET_URL,
        retryable: true
      },
      chrome: error?.chrome || null
    };
  }

  let started;
  try {
    started = recommendRunService.startRecommendRun({
      ...getRunOptions(args, parsed, normalized, session, configResolution),
      runId: fixedRunId || undefined,
      pid: process.pid
    });
  } catch (error) {
    await session.close?.();
    return {
      status: "FAILED",
      error: {
        code: "RECOMMEND_RUN_START_FAILED",
        message: error?.message || "Failed to start recommend run",
        retryable: true
      }
    };
  }

  recommendRunMeta.set(started.runId, {
    session,
    methodLog: session.methodLog || [],
    workspaceRoot: normalizeText(workspaceRoot) || process.cwd(),
    args: clonePlain(args, {}),
    normalized,
    parsed,
    chrome: {
      host: normalized.host,
      port: normalized.port,
      target_url: session.navigation?.url || session.target?.url || RECOMMEND_TARGET_URL,
      target_id: session.target?.id || null,
      auto_launch: session.chrome || null
    },
    health: session.health || null
  });
  trackRecommendRun(started.runId);
  const persistedStarted = persistRecommendRunSnapshot(started);

  return {
    status: "ACCEPTED",
    run_id: persistedStarted.run_id,
    state: persistedStarted.state,
    run: persistedStarted,
    poll_after_sec: DEFAULT_RECOMMEND_POLL_AFTER_SEC,
    review: parsed.review,
    message: normalized.postAction === "none"
      ? "Recommend pipeline run started through the shared CDP-only recommend service. No post-action was requested."
      : `Recommend pipeline run started through the shared CDP-only recommend service with post_action=${normalized.postAction}${args.dry_run_post_action === true ? " in dry-run mode" : ""}.`,
    post_action: {
      requested: normalized.postAction,
      execute_post_action: args.dry_run_post_action === true ? false : args.execute_post_action !== false,
      max_greet_count: normalized.maxGreetCount
    },
    target_count_semantics: TARGET_COUNT_SEMANTICS
  };
}

export function prepareRecommendPipelineRunTool({ workspaceRoot = "", args = {} } = {}) {
  const prepared = prepareRecommendPipelineStart(args, { workspaceRoot });
  if (prepared.response) {
    return {
      ...prepared.response,
      cron_ready: false
    };
  }
  const { parsed, normalized } = prepared;
  const nextAction = {
    immediate_run: {
      recommended_next_tool: "start_recommend_pipeline_run",
      alternate_next_tool: "run_recommend",
      same_arguments: true,
      native_mcp_required: true
    },
    scheduled_run: {
      recommended_next_tool: "schedule_recommend_pipeline_run",
      same_arguments: true,
      requires_schedule_field: true
    },
    do_not_call_prepare_again: true,
    do_not_use_cli_fallback_when_mcp_tools_available: true,
    do_not_use_terminal_or_shell: true,
    forbidden_fallbacks: [
      "run_command",
      "terminal",
      "shell",
      "CLI detached fallback",
      "manual JSON-RPC over shell",
      "npx --stdio"
    ]
  };
  const agentGuidance = {
    host_has_native_mcp: true,
    native_mcp_required_after_prepare: true,
    proof: "This prepare_recommend_pipeline_run response was returned by the MCP server, so the host can call MCP tools from this server.",
    immediate_run: {
      tool: nextAction.immediate_run.recommended_next_tool,
      alternate_tool: nextAction.immediate_run.alternate_next_tool,
      same_arguments: true
    },
    scheduled_run: {
      tool: nextAction.scheduled_run.recommended_next_tool,
      same_arguments: true
    },
    trae_cn: {
      next_step: "Call boss-recommend/start_recommend_pipeline_run or boss-recommend/run_recommend through the native MCP tool interface.",
      never_use_terminal_fallback_after_prepare: true
    },
    forbidden_when_mcp_tools_are_available: nextAction.forbidden_fallbacks
  };
  return {
    status: "READY",
    cron_ready: true,
    prepared_only: true,
    run_started: false,
    recommended_next_tool: nextAction.immediate_run.recommended_next_tool,
    alternate_next_tool: nextAction.immediate_run.alternate_next_tool,
    next_action: nextAction,
    agent_guidance: agentGuidance,
    message: "READY only means the payload passed validation; prepare_recommend_pipeline_run did not start a run. This response proves the MCP server is available. To start now, call the native MCP tool start_recommend_pipeline_run or run_recommend with the same arguments. Do not call prepare_recommend_pipeline_run again, and do not use terminal, shell, CLI detached fallback, or manual JSON-RPC when MCP tools are available.",
    review: parsed.review,
    post_action: {
      requested: normalized.postAction,
      execute_post_action: args.dry_run_post_action === true ? false : args.execute_post_action !== false,
      max_greet_count: normalized.maxGreetCount
    },
    target_count_semantics: TARGET_COUNT_SEMANTICS
  };
}

export async function startRecommendPipelineRunTool({ workspaceRoot = "", args = {}, runId = "" } = {}) {
  const started = await startRecommendPipelineRunInternal(args, { workspaceRoot, runId });
  if (started.status !== "ACCEPTED") return started;
  return attachMethodEvidence(started, started.run_id);
}

export function getRecommendPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
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
    const run = recommendRunService.getRecommendRun(runId);
    const normalizedRun = persistRecommendRunSnapshot(run);
    return attachMethodEvidence({
      status: "RUN_STATUS",
      run: normalizedRun
    }, runId);
  } catch {
    const persisted = readRecommendRunState(runId);
    if (persisted) {
      const reconciled = reconcilePersistedRecommendRunIfNeeded(persisted);
      return {
        status: "RUN_STATUS",
        run: reconciled,
        persistence: {
          source: "disk",
          active_control_available: false,
          stale_process_reconciled: reconciled?.state !== persisted.state
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
        message: `No recommend run found for run_id=${runId}`,
        retryable: false
      }
    };
  }
}

export function pauseRecommendPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  try {
    const before = recommendRunService.getRecommendRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistRecommendRunSnapshot(before);
      return attachMethodEvidence({
        status: "PAUSE_IGNORED",
        run: normalizedBefore,
        message: "目标任务已结束，无需暂停。"
      }, runId);
    }
    if (before.status === RUN_STATUS_PAUSED) {
      const normalizedBefore = persistRecommendRunSnapshot(before);
      return attachMethodEvidence({
        status: "PAUSE_IGNORED",
        run: normalizedBefore,
        message: "目标任务已经处于 paused 状态。"
      }, runId);
    }
    const run = recommendRunService.pauseRecommendRun(runId);
    const normalizedRun = persistRecommendRunSnapshot(run);
    return attachMethodEvidence({
      status: "PAUSE_REQUESTED",
      run: normalizedRun,
      message: "暂停请求已接收，将在当前候选人处理完成后进入 paused。"
    }, runId);
  } catch {
    const persisted = readRecommendRunState(runId);
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
    return getRecommendPipelineRunTool({ args });
  }
}

export function resumeRecommendPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  try {
    const before = recommendRunService.getRecommendRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistRecommendRunSnapshot(before);
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
      const normalizedBefore = persistRecommendRunSnapshot(before);
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
    const run = recommendRunService.resumeRecommendRun(runId);
    const meta = getRecommendRunMeta(runId);
    if (meta) {
      meta.resumeCount = (meta.resumeCount || 0) + 1;
      meta.lastResumedAt = new Date().toISOString();
    }
    const normalizedRun = persistRecommendRunSnapshot(run);
    return attachMethodEvidence({
      status: "RESUME_REQUESTED",
      run: normalizedRun,
      poll_after_sec: DEFAULT_RECOMMEND_POLL_AFTER_SEC,
      message: "已恢复 Recommend run，请使用 get_recommend_pipeline_run 按需轮询。"
    }, runId);
  } catch {
    const persisted = readRecommendRunState(runId);
    if (persisted) {
      return {
        status: "FAILED",
        error: {
          code: TERMINAL_STATUSES.has(persisted.state) ? "RUN_ALREADY_TERMINATED" : "RUN_NOT_ACTIVE",
          message: TERMINAL_STATUSES.has(persisted.state)
            ? "目标任务已结束，无法继续。"
            : "该 run 只有磁盘快照，没有当前进程内的活动 CDP 会话，无法安全继续。",
          retryable: !TERMINAL_STATUSES.has(persisted.state)
        },
        run: persisted,
        persistence: {
          source: "disk",
          active_control_available: false
        },
        runtime_evaluate_used: false,
        method_summary: {},
        method_log: [],
        chrome: null
      };
    }
    return getRecommendPipelineRunTool({ args });
  }
}

export function cancelRecommendPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  try {
    const before = recommendRunService.getRecommendRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistRecommendRunSnapshot(before);
      return attachMethodEvidence({
        status: "CANCEL_IGNORED",
        run: normalizedBefore,
        message: "目标任务已结束，无需取消。"
      }, runId);
    }
    const run = recommendRunService.cancelRecommendRun(runId);
    const normalizedRun = persistRecommendRunSnapshot(run);
    return attachMethodEvidence({
      status: "CANCEL_REQUESTED",
      run: normalizedRun,
      message: "已收到取消请求，将在当前候选人处理完成后安全停止。"
    }, runId);
  } catch {
    const persisted = readRecommendRunState(runId);
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
    const cancelMessage = "已收到取消请求，将由 detached worker 在下一个安全边界停止。";
    const patched = patchPersistedRecommendRunControl(runId, {
      pause_requested: true,
      pause_requested_at: new Date().toISOString(),
      pause_requested_by: "cancel_recommend_pipeline_run",
      cancel_requested: true
    }, {
      message: cancelMessage
    });
    if (patched) {
      return {
        status: "CANCEL_REQUESTED",
        run: patched,
        message: cancelMessage,
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
    return getRecommendPipelineRunTool({ args });
  }
}

export function getRecommendMcpHealthSnapshot(runId) {
  const meta = getRecommendRunMeta(runId);
  return {
    health: compactHealth(meta.health || null),
    chrome: meta.chrome || null,
    method_summary: methodSummary(meta.methodLog || [])
  };
}

export function __setRecommendMcpConnectorForTests(nextConnector) {
  recommendConnectorImpl = typeof nextConnector === "function" ? nextConnector : connectRecommendChromeSession;
}

export function __setRecommendMcpJobReaderForTests(nextReader) {
  recommendJobReaderImpl = typeof nextReader === "function" ? nextReader : readRecommendJobOptionsFromSession;
}

export function __setRecommendMcpWorkflowForTests(nextWorkflow) {
  recommendWorkflowImpl = typeof nextWorkflow === "function" ? nextWorkflow : runRecommendWorkflow;
  recommendRunService = createRecommendRunService({
    idPrefix: "mcp_recommend",
    workflow: (...args) => recommendWorkflowImpl(...args),
    onSnapshot: persistRecommendLifecycleSnapshot
  });
}

export function __resetRecommendMcpStateForTests() {
  for (const meta of recommendRunMeta.values()) {
    try {
      meta.session?.close?.();
    } catch {
      // Best-effort test cleanup.
    }
  }
  recommendRunMeta.clear();
  __setRecommendMcpConnectorForTests(null);
  __setRecommendMcpJobReaderForTests(null);
  __setRecommendMcpWorkflowForTests(null);
}
