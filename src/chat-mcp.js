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
  buildChatSelfHealConfig,
  HEALTH_STATUS,
  resolveChatSelfHealRoots,
  runSelfHealCheck
} from "./core/self-heal/index.js";
import {
  CHAT_TARGET_URL,
  closeChatResumeModal,
  closeChatJobDropdown,
  createChatRunService,
  getChatRoots,
  isForbiddenChatResumeTopLevelUrl,
  readChatJobOptions,
  runChatWorkflow
} from "./domains/chat/index.js";
import {
  buildTargetCountCompatibilityHints,
  getBossChatDataDir,
  getBossChatTargetCountValue,
  normalizeTargetCountInput,
  resolveBossConfiguredOutputDir,
  resolveBossChatRuntimeLayout,
  resolveHumanBehaviorForRun,
  resolveBossScreeningConfig
} from "./chat-runtime-config.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "./core/cv-acquisition/index.js";

const DEFAULT_CHAT_HOST = "127.0.0.1";
const DEFAULT_CHAT_PORT = 9222;
const DEFAULT_CHAT_POLL_AFTER_SEC = 10;
const DEFAULT_CHAT_GREETING_TEXT = "Hi同学，能麻烦发下简历吗？";
const CHAT_ALL_MAX_CANDIDATES = 100000;
const TARGET_COUNT_SEMANTICS = "target_count means candidates that pass screening; numeric targets scan until that many candidates pass or the list ends; all/全部/扫到底 scans to the end";
const RUN_MODE_ASYNC = "async";

const CHAT_REQUIRED_FIELDS = Object.freeze([
  "job",
  "start_from",
  "target_count",
  "criteria"
]);

const TERMINAL_STATUSES = new Set([
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_CANCELED
]);

const ARTIFACT_STATUSES = new Set([
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_CANCELED,
  RUN_STATUS_PAUSED
]);

const STALE_PROCESS_STATUSES = new Set([
  "queued",
  "running",
  RUN_STATUS_CANCELING
]);

const CHAT_REQUEST_RESUME_ACTIONS = new Set([
  "request_cv",
  "ask_cv",
  "request_resume",
  "求简历",
  "索要简历"
]);

const CHAT_DISABLE_REQUEST_RESUME_ACTIONS = new Set([
  "none",
  "no",
  "false",
  "off",
  "skip",
  "do_nothing",
  "nothing",
  "不做",
  "什么都不做",
  "无",
  "不用",
  "不求简历",
  "不请求简历"
]);

let chatWorkflowImpl = runChatWorkflow;
let chatConnectorImpl = connectChatChromeSession;
let chatJobReaderImpl = readChatJobOptionsFromSession;
let chatRunService = createChatRunService({
  idPrefix: "mcp_chat",
  workflow: (...args) => chatWorkflowImpl(...args),
  onSnapshot: persistChatLifecycleSnapshot
});
const chatRunMeta = new Map();

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

function normalizeRunId(runId) {
  const normalized = normalizeText(runId);
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) return "";
  return normalized;
}

function getChatRunsDir() {
  return path.join(getBossChatDataDir(), "runs");
}

function getChatRunArtifacts(runId) {
  const normalized = normalizeRunId(runId);
  if (!normalized) return null;
  const runsDir = getChatRunsDir();
  const outputDir = resolveBossConfiguredOutputDir("", runsDir);
  return {
    runs_dir: runsDir,
    output_dir: outputDir,
    run_state_path: path.join(runsDir, `${normalized}.json`),
    checkpoint_path: path.join(runsDir, `${normalized}.checkpoint.json`),
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

function selectedChatJobForCsv(meta = {}, snapshot = {}) {
  const job = normalizeText(
    meta.normalized?.job
    || meta.args?.job
    || snapshot.context?.job
    || ""
  );
  return {
    value: job,
    title: job,
    label: job
  };
}

function buildChatCsvInputRows(snapshot = {}, meta = {}) {
  const normalized = meta.normalized || {};
  const context = snapshot.context || {};
  const postAction = shouldRequestChatResume(meta.args, context)
    ? "request_cv"
    : normalizeText(meta.args?.post_action || meta.args?.action || "") || "none";
  const searchParams = {
    job: normalized.job || meta.args?.job || context.job || "",
    start_from: normalized.startFrom || meta.args?.start_from || context.start_from || "",
    target_count: normalized.publicTargetCount ?? normalized.targetCount ?? snapshot.progress?.target_count ?? "",
    detail_source: meta.args?.detail_source || snapshot.summary?.detail_source || context.detail_source || ""
  };
  return buildLegacyScreenInputRows({
    instruction: meta.args?.instruction || "启动boss聊天任务",
    selectedPage: "chat",
    selectedJob: selectedChatJobForCsv(meta, snapshot),
    userSearchParams: cloneReportInput(searchParams, {}),
    effectiveSearchParams: cloneReportInput(searchParams, {}),
    screenParams: {
      criteria: normalized.criteria || meta.args?.criteria || context.criteria || "",
      target_count: searchParams.target_count,
      post_action: postAction,
      max_greet_count: meta.args?.max_greet_count ?? ""
    },
    followUp: meta.args?.follow_up || null,
    extraRows: [
      ["chat_params.greeting_text", normalized.greetingText || meta.args?.greeting_text || meta.args?.greetingText || context.greeting_text || DEFAULT_CHAT_GREETING_TEXT],
      ["chat_params.profile", normalized.profile || meta.args?.profile || context.profile || "default"]
    ]
  });
}

function writeChatLegacyCsvAtomic(filePath, rows = [], snapshot = {}, meta = {}) {
  writeLegacyScreenCsv(filePath, {
    inputRows: buildChatCsvInputRows(snapshot, meta),
    results: rows
  });
}

function readChatRunState(runId) {
  const artifacts = getChatRunArtifacts(runId);
  if (!artifacts) return null;
  return readJsonFile(artifacts.run_state_path);
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

function countPostActionResults(results = []) {
  let requested = 0;
  let requestSatisfied = 0;
  let requestSkipped = 0;
  for (const row of results || []) {
    const action = row?.post_action || {};
    if (action.requested) requestSatisfied += 1;
    if (action.skipped) requestSkipped += 1;
    if (action.requested && !action.skipped) requested += 1;
  }
  return {
    requested,
    request_satisfied: requestSatisfied,
    request_skipped: requestSkipped
  };
}

function normalizeLegacyProgress(progress = {}, summary = null) {
  const countedRequests = countPostActionResults(Array.isArray(summary?.results) ? summary.results : []);
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
  const requested = Number.isInteger(progress.requested)
    ? progress.requested
    : Number.isInteger(summary?.requested)
      ? summary.requested
      : countedRequests.requested;
  const requestSatisfied = Number.isInteger(progress.request_satisfied)
    ? progress.request_satisfied
    : Number.isInteger(summary?.request_satisfied)
      ? summary.request_satisfied
      : countedRequests.request_satisfied;
  const requestSkipped = Number.isInteger(progress.request_skipped)
    ? progress.request_skipped
    : Number.isInteger(summary?.request_skipped)
      ? summary.request_skipped
      : countedRequests.request_skipped;
  return {
    ...progress,
    processed,
    inspected: processed,
    screened,
    passed,
    requested,
    request_satisfied: requestSatisfied,
    request_skipped: requestSkipped,
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

function getChatRunMeta(runId) {
  return chatRunMeta.get(runId) || {};
}

function ensureChatRunArtifacts(snapshot) {
  const artifacts = getChatRunArtifacts(snapshot?.runId || snapshot?.run_id);
  if (!artifacts) return null;

  const meta = getChatRunMeta(snapshot?.runId || snapshot?.run_id);
  const checkpoint = snapshot?.checkpoint && typeof snapshot.checkpoint === "object"
    ? snapshot.checkpoint
    : {};
  writeJsonAtomic(artifacts.checkpoint_path, checkpoint);
  if (meta) meta.checkpointPath = artifacts.checkpoint_path;

  const summary = snapshot?.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const checkpointResults = Array.isArray(checkpoint.results) ? checkpoint.results : [];
  const artifactSummary = summary || (checkpointResults.length ? {
    domain: "chat",
    partial: true,
    partial_reason: snapshot?.status || snapshot?.state || "non_terminal",
    results: checkpointResults
  } : ARTIFACT_STATUSES.has(snapshot?.status || snapshot?.state) ? {
    domain: "chat",
    partial: (snapshot?.status || snapshot?.state) !== RUN_STATUS_COMPLETED,
    partial_reason: snapshot?.status || snapshot?.state || "unknown",
    completion_reason: completionReason(snapshot?.status || snapshot?.state),
    results: []
  } : null);
  if (artifactSummary) {
    const rows = Array.isArray(artifactSummary.results) ? artifactSummary.results : [];
    writeChatLegacyCsvAtomic(artifacts.output_csv, rows, snapshot, meta);
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

function persistChatCheckpointSnapshot(normalized) {
  const artifacts = getChatRunArtifacts(normalized?.run_id || normalized?.runId);
  if (!artifacts) return;
  const checkpoint = normalized?.checkpoint && typeof normalized.checkpoint === "object"
    ? normalized.checkpoint
    : {};
  writeJsonAtomic(artifacts.checkpoint_path, checkpoint);
  const meta = getChatRunMeta(normalized?.run_id || normalized?.runId);
  if (meta) meta.checkpointPath = artifacts.checkpoint_path;
}

function isPidAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  if (numericPid === process.pid) return true;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function snapshotFromPersistedChatRun(persisted = {}) {
  return {
    runId: persisted.run_id || persisted.runId,
    name: persisted.name || persisted.run_id || persisted.runId,
    status: persisted.status || persisted.state,
    phase: persisted.stage || persisted.phase,
    progress: persisted.progress || {},
    context: persisted.context || {},
    checkpoint: persisted.checkpoint || {},
    startedAt: persisted.started_at || persisted.startedAt,
    updatedAt: persisted.updated_at || persisted.updatedAt,
    completedAt: persisted.completed_at || persisted.completedAt || null,
    error: persisted.error || null,
    summary: persisted.summary || null
  };
}

function persistDiskChatRun(runId, payload) {
  const artifacts = getChatRunArtifacts(runId);
  if (!artifacts) return payload;
  writeJsonAtomic(artifacts.run_state_path, payload);
  return payload;
}

function attachLegacyArtifactsToPersistedChatRun(persisted = {}) {
  const runId = normalizeRunId(persisted.run_id || persisted.runId);
  if (!runId) return persisted;
  const snapshot = snapshotFromPersistedChatRun(persisted);
  const result = buildLegacyChatResult(snapshot);
  const artifacts = getChatRunArtifacts(runId);
  const next = {
    ...persisted,
    result,
    resume: {
      ...(persisted.resume || {}),
      checkpoint_path: result?.checkpoint_path || persisted.resume?.checkpoint_path || artifacts?.checkpoint_path || null,
      output_csv: result?.output_csv || persisted.resume?.output_csv || artifacts?.output_csv || null
    },
    artifacts: artifacts || persisted.artifacts || null
  };
  return persistDiskChatRun(runId, next);
}

function finalizePersistedChatRun(persisted = {}, {
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
        message: error?.message || message || "Boss chat run process exited before it wrote a terminal state."
      }
    : null;
  const next = {
    ...persisted,
    run_id: runId,
    state: status,
    status,
    stage: persisted.stage || persisted.phase || "chat:stale",
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
  return attachLegacyArtifactsToPersistedChatRun(next);
}

function persistedChatRunArtifactMissing(persisted = {}) {
  const runId = normalizeRunId(persisted.run_id || persisted.runId);
  const artifacts = getChatRunArtifacts(runId);
  const outputCsv = persisted.result?.output_csv
    || persisted.resume?.output_csv
    || persisted.artifacts?.output_csv
    || artifacts?.output_csv;
  const reportJson = persisted.result?.report_json
    || persisted.artifacts?.report_json
    || artifacts?.report_json;
  return Boolean(
    !outputCsv
    || !reportJson
    || !fs.existsSync(outputCsv)
    || !fs.existsSync(reportJson)
  );
}

function reconcilePersistedChatRun(persisted = {}, { cancelStale = false } = {}) {
  const status = persisted.status || persisted.state;
  if (STALE_PROCESS_STATUSES.has(status) && !isPidAlive(persisted.pid)) {
    const shouldCancel = cancelStale || status === RUN_STATUS_CANCELING || persisted.control?.cancel_requested === true;
    return {
      run: finalizePersistedChatRun(persisted, {
        status: shouldCancel ? RUN_STATUS_CANCELED : RUN_STATUS_FAILED,
        error: shouldCancel ? null : {
          code: "STALE_RUN_PROCESS_EXITED",
          message: `Boss chat run process is no longer alive for pid=${persisted.pid || "unknown"}.`
        },
        message: shouldCancel
          ? "Boss chat run was canceled after its worker process was no longer active."
          : `Boss chat run process is no longer alive for pid=${persisted.pid || "unknown"}.`
      }),
      stale_finalized: true
    };
  }
  if (ARTIFACT_STATUSES.has(status) && persistedChatRunArtifactMissing(persisted)) {
    return {
      run: attachLegacyArtifactsToPersistedChatRun(persisted),
      artifacts_repaired: true
    };
  }
  return {
    run: persisted
  };
}

function buildLegacyChatResult(snapshot) {
  if (!snapshot) return null;
  const artifacts = ensureChatRunArtifacts(snapshot);
  const meta = getChatRunMeta(snapshot.runId);
  const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const checkpoint = snapshot.checkpoint && typeof snapshot.checkpoint === "object" ? snapshot.checkpoint : {};
  const resultRows = Array.isArray(summary?.results)
    ? summary.results
    : Array.isArray(checkpoint.results)
      ? checkpoint.results
      : [];
  const progress = normalizeLegacyProgress(snapshot.progress, summary);
  return {
    run_id: snapshot.runId,
    state: snapshot.status,
    status: snapshot.status,
    completion_reason: completionReason(snapshot.status),
    requested_count: progress.requested,
    request_satisfied_count: progress.request_satisfied,
    request_skipped_count: progress.request_skipped,
    processed_count: progress.processed,
    inspected_count: progress.processed,
    screened_count: progress.screened,
    passed_count: progress.passed,
    skipped_count: progress.skipped,
    detail_opened: progress.detail_opened || summary?.detail_opened || 0,
    llm_screened: progress.llm_screened || summary?.llm_screened || 0,
    output_csv: artifacts?.output_csv || meta.outputCsvPath || null,
    report_json: artifacts?.report_json || meta.reportJsonPath || null,
    checkpoint_path: artifacts?.checkpoint_path || meta.checkpointPath || null,
    started_at: snapshot.startedAt,
    completed_at: snapshot.completedAt || null,
    duration_sec: secondsBetween(snapshot.startedAt, snapshot.completedAt),
    error: snapshot.error || null,
    results: resultRows
  };
}

function normalizeRunSnapshot(snapshot) {
  if (!snapshot) return null;
  const meta = getChatRunMeta(snapshot.runId);
  const artifacts = getChatRunArtifacts(snapshot.runId);
  const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const progress = normalizeLegacyProgress(snapshot.progress, summary);
  const legacyResult = (
    TERMINAL_STATUSES.has(snapshot.status)
    || snapshot.status === RUN_STATUS_PAUSED
  ) ? buildLegacyChatResult({ ...snapshot, progress }) : null;
  const oldContext = {
    workspace_root: meta.workspaceRoot || null,
    profile: meta.normalized?.profile || meta.args?.profile || "default",
    job: meta.normalized?.job || meta.args?.job || "",
    start_from: meta.normalized?.startFrom || meta.args?.start_from || "",
    criteria: meta.normalized?.criteria || meta.args?.criteria || "",
    greeting_text: meta.normalized?.greetingText || meta.args?.greeting_text || meta.args?.greetingText || DEFAULT_CHAT_GREETING_TEXT,
    target_count: meta.normalized?.publicTargetCount ?? null,
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
    pid: process.pid || null,
    last_message: snapshot.error?.message || snapshot.phase || null,
    context: {
      ...(snapshot.context || {}),
      ...oldContext,
      shared_run_context: snapshot.context || {}
    },
    control: {
      pause_requested: snapshot.status === RUN_STATUS_PAUSED,
      pause_requested_at: snapshot.status === RUN_STATUS_PAUSED ? snapshot.updatedAt : null,
      pause_requested_by: snapshot.status === RUN_STATUS_PAUSED ? "pause_boss_chat_run" : null,
      cancel_requested: snapshot.status === RUN_STATUS_CANCELING
    },
    resume: {
      checkpoint_path: legacyResult?.checkpoint_path || meta.checkpointPath || artifacts?.checkpoint_path || null,
      pause_control_path: artifacts?.run_state_path || null,
      output_csv: legacyResult?.output_csv || null,
      resume_count: meta.resumeCount || 0,
      last_resumed_at: meta.lastResumedAt || null,
      last_paused_at: snapshot.status === RUN_STATUS_PAUSED ? snapshot.updatedAt : null
    },
    result: legacyResult,
    artifacts
  };
}

function persistChatRunSnapshot(snapshot, {
  persistActiveCheckpoint = false
} = {}) {
  const normalized = normalizeRunSnapshot(snapshot);
  if (!normalized?.run_id) return normalized;
  const artifacts = getChatRunArtifacts(normalized.run_id);
  if (!artifacts) return normalized;
  if (persistActiveCheckpoint) {
    persistChatCheckpointSnapshot(normalized);
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
    result: normalized.result,
    summary: normalized.summary,
    artifacts: normalized.artifacts
  };
  writeJsonAtomic(artifacts.run_state_path, payload);
  return normalized;
}

function persistChatLifecycleSnapshot(snapshot, event = {}) {
  return persistChatRunSnapshot(snapshot, {
    persistActiveCheckpoint: event?.type === "checkpoint"
  });
}

function attachMethodEvidence(payload, runId) {
  const meta = getChatRunMeta(runId);
  assertNoForbiddenCdpCalls(meta.methodLog || []);
  return {
    ...payload,
    runtime_evaluate_used: false,
    method_summary: methodSummary(meta.methodLog || []),
    method_log: meta.methodLog || [],
    chrome: meta.chrome || null
  };
}

function shouldNavigateToChat(url) {
  const text = String(url || "");
  return !text.includes("/web/chat/index")
    || text.includes("/web/chat/recommend")
    || text.includes("/web/chat/search");
}

function isRecoverableChatTargetUrl(url) {
  const text = String(url || "");
  return text.includes("zhipin.com/web/chat")
    || isForbiddenChatResumeTopLevelUrl(text);
}

async function waitForHealthyChat(client, config, {
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
    const roots = await resolveChatSelfHealRoots(client, config);
    lastCheck = await runSelfHealCheck({
      client,
      domain: "chat",
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

async function connectChatChromeSession({
  host = DEFAULT_CHAT_HOST,
  port = DEFAULT_CHAT_PORT,
  targetUrlIncludes = CHAT_TARGET_URL,
  allowNavigate = true,
  slowLive = false
} = {}) {
  const session = await connectToChromeTargetOrOpen({
    host,
    port,
    targetUrlIncludes,
    targetUrl: CHAT_TARGET_URL,
    allowNavigate,
    slowLive,
    fallbackTargetPredicate: (target) => (
      target?.type === "page"
      && (isRecoverableChatTargetUrl(target?.url) || String(target?.url || "").includes("zhipin.com"))
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
  if (allowNavigate && shouldNavigateToChat(targetUrl)) {
    await client.Page.navigate({ url: CHAT_TARGET_URL });
    const settleMs = slowLive ? 10000 : 5000;
    const waited = await waitForMainFrameUrl(
      client,
      (url) => isBossLoginUrl(url) || !shouldNavigateToChat(url),
      { timeoutMs: settleMs, intervalMs: 500 }
    );
    navigation = {
      navigated: true,
      url: CHAT_TARGET_URL,
      settle_ms: settleMs,
      observed_url: waited.url || null,
      observed_url_ok: waited.ok
    };
  }
  let currentUrl = await getMainFrameUrl(client).catch(() => navigation.url || targetUrl);
  if (allowNavigate && shouldNavigateToChat(currentUrl) && !isBossLoginUrl(currentUrl)) {
    await client.Page.navigate({ url: CHAT_TARGET_URL });
    const settleMs = slowLive ? 10000 : 5000;
    const waited = await waitForMainFrameUrl(
      client,
      (url) => isBossLoginUrl(url) || !shouldNavigateToChat(url),
      { timeoutMs: settleMs, intervalMs: 500 }
    );
    navigation = {
      navigated: true,
      url: CHAT_TARGET_URL,
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
      domain: "chat",
      currentUrl: loginDetection.current_url || currentUrl,
      targetUrl: CHAT_TARGET_URL,
      loginDetection,
      chrome: session.chrome || null
    });
  }
  if (shouldNavigateToChat(currentUrl)) {
    await session.close?.();
    throw new Error(`Boss chat page did not navigate to ${CHAT_TARGET_URL}; current URL: ${currentUrl || "unknown"}`);
  }

  const selfHealConfig = buildChatSelfHealConfig();
  const health = await waitForHealthyChat(client, selfHealConfig, {
    timeoutMs: slowLive ? 180000 : 90000,
    intervalMs: slowLive ? 1200 : 800
  });
  if (health?.loginDetection?.requires_login) {
    await session.close?.();
    throw createBossLoginRequiredError({
      domain: "chat",
      currentUrl: health.loginDetection.current_url || currentUrl,
      targetUrl: CHAT_TARGET_URL,
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
        domain: "chat",
        currentUrl: latestLoginDetection.current_url || latestUrl,
        targetUrl: CHAT_TARGET_URL,
        loginDetection: latestLoginDetection,
        chrome: session.chrome || null
      });
    }
    throw new Error(`Boss chat page is not healthy: ${health?.status || "missing"}`);
  }

  return {
    ...session,
    navigation,
    health
  };
}

async function readChatJobOptionsFromSession(session) {
  const roots = await getChatRoots(session.client);
  const result = await readChatJobOptions(session.client, roots.rootNodes.top);
  try {
    result.menu_close = await closeChatJobDropdown(session.client, roots.rootNodes.top);
  } catch (error) {
    result.menu_close = {
      ok: false,
      closed: false,
      reason: "close_failed",
      error: error?.message || String(error)
    };
  }
  return result;
}

function normalizeChatStartInput(args = {}, configResolution = null) {
  const target = normalizeTargetCountInput(getBossChatTargetCountValue(args));
  const explicitGreetingText = normalizeText(args.greeting_text || args.greetingText || args.greeting);
  const configuredGreetingText = normalizeText(configResolution?.config?.greetingMessage || configResolution?.config?.greetingText);
  return {
    profile: normalizeText(args.profile) || "default",
    job: normalizeText(args.job),
    startFrom: normalizeText(args.start_from).toLowerCase(),
    criteria: normalizeText(args.criteria),
    greetingText: explicitGreetingText || configuredGreetingText,
    target,
    targetCount: target.targetCount,
    publicTargetCount: target.publicValue,
    host: normalizeText(args.host) || DEFAULT_CHAT_HOST,
    port: parsePositiveInteger(
      args.port,
      configResolution?.ok ? configResolution.config.debugPort : DEFAULT_CHAT_PORT
    ),
    targetUrlIncludes: normalizeText(args.target_url_includes) || CHAT_TARGET_URL,
    allowNavigate: args.allow_navigate !== false,
    slowLive: args.slow_live === true
  };
}

function buildChatNextCallExample(args, missingFields, normalized) {
  const example = {};
  if (normalized.job) example.job = normalized.job;
  if (normalized.startFrom) example.start_from = normalized.startFrom;
  if (normalized.target.provided && !normalized.target.parseError) {
    example.target_count = normalized.publicTargetCount ?? normalized.targetCount;
  } else if (missingFields.includes("target_count")) {
    example.target_count = "all";
  }
  if (normalized.criteria) example.criteria = normalized.criteria;
  if (normalizeText(args.greeting_text || args.greetingText || args.greeting)) {
    example.greeting_text = normalizeText(args.greeting_text || args.greetingText || args.greeting);
  }
  return Object.keys(example).length ? example : null;
}

function getMissingChatStartFields(args = {}, normalized = normalizeChatStartInput(args)) {
  const missing = [];
  if (!normalized.job) missing.push("job");
  if (!["unread", "all"].includes(normalized.startFrom)) missing.push("start_from");
  if (!normalized.target.provided || normalized.target.parseError) missing.push("target_count");
  if (!normalized.criteria) missing.push("criteria");
  return missing;
}

function buildTargetCountDiagnostics(args, missingFields, normalized) {
  if (!missingFields.includes("target_count")) return {};
  const hints = buildTargetCountCompatibilityHints({
    argumentName: "target_count",
    recommendedArgumentPatch: { target_count: "all" }
  });
  const received = getBossChatTargetCountValue(args);
  const nextCallExample = {
    ...(normalizeText(args.job) ? { job: normalizeText(args.job) } : {}),
    ...(normalizeText(args.start_from) ? { start_from: normalizeText(args.start_from).toLowerCase() } : {}),
    target_count: "all",
    ...(normalizeText(args.criteria) ? { criteria: normalizeText(args.criteria) } : {})
  };
  return {
    ...hints,
    received_target_count: received,
    target_count_parse_error: normalized.target.parseError || null,
    next_call_example: nextCallExample
  };
}

function buildJobQuestionOptions(jobOptions = []) {
  return (jobOptions || []).map((option) => ({
    label: option.label,
    value: option.value,
    index: option.index,
    active: option.active === true
  }));
}

function buildPendingChatQuestions({ args, missingFields, normalized, jobOptions = [] }) {
  const diagnostics = buildTargetCountDiagnostics(args, missingFields, normalized);
  return missingFields.map((field) => {
    if (field === "job") {
      return {
        field,
        question: "请提供 Boss chat 岗位，支持岗位名、编号或页面中的岗位 value。",
        value: normalized.job || null,
        options: buildJobQuestionOptions(jobOptions)
      };
    }
    if (field === "start_from") {
      return {
        field,
        question: "请确认 chat 起始范围。",
        value: normalized.startFrom || null,
        options: [
          { label: "未读", value: "unread" },
          { label: "全部", value: "all" }
        ]
      };
    }
    if (field === "target_count") {
      return {
        field,
        ...diagnostics,
        question: "请提供 target_count，使用正整数或 all（扫到底）。",
        value: normalized.publicTargetCount ?? null,
        options: Array.isArray(diagnostics.options) ? diagnostics.options : [],
        parse_error: normalized.target.parseError || null
      };
    }
    if (field === "criteria") {
      return {
        field,
        question: "请提供自然语言筛选 criteria。",
        value: normalized.criteria || null
      };
    }
    return {
      field,
      question: `请提供 ${field}。`,
      value: null
    };
  });
}

async function buildNeedInputResponse({ args, missingFields, normalized }) {
  const diagnostics = buildTargetCountDiagnostics(args, missingFields, normalized);
  return {
    status: "NEED_INPUT",
    required_fields: CHAT_REQUIRED_FIELDS.slice(),
    missing_fields: missingFields,
    ...diagnostics,
    pending_questions: buildPendingChatQuestions({ args, missingFields, normalized }),
    job_options: [],
    error: {
      code: "MISSING_REQUIRED_FIELDS",
      message: "缺少必要字段。请补齐 job、start_from、target_count、criteria 后再启动 Boss chat CDP-only run。",
      retryable: true
    }
  };
}

function shouldRequestChatResume(args = {}, context = {}) {
  const action = normalizeText(args.post_action || args.action).toLowerCase();
  if (
    args.request_cv === false
    || args.request_resume === false
    || args.ask_cv === false
    || args.execute_post_action === false
    || args.no_request_cv === true
    || args.no_request_resume === true
    || CHAT_DISABLE_REQUEST_RESUME_ACTIONS.has(action)
  ) {
    return false;
  }
  if (
    args.request_cv === true
    || args.request_resume === true
    || args.ask_cv === true
    || args.execute_post_action === true
    || CHAT_REQUEST_RESUME_ACTIONS.has(action)
  ) {
    return true;
  }
  if (typeof context.request_resume_for_passed === "boolean") {
    return context.request_resume_for_passed;
  }
  return true;
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

function collectChatDebugTestOptions(args = {}) {
  const reasons = [];
  if (normalizeScreeningModeArg(args) === "deterministic") reasons.push("deterministic_screening");
  if (parseNonNegativeInteger(args.detail_limit, null) === 0) reasons.push("detail_limit=0");
  if (args.dry_run === true || args.dry_run_request_cv === true) reasons.push("dry_run_request_cv");
  return reasons;
}

function shouldUseChatLlm(args = {}) {
  return normalizeScreeningModeArg(args) !== "deterministic";
}

function getRunOptions(args, normalized, session, { workspaceRoot = "", configResolution = null } = {}) {
  const slowLive = args.slow_live === true;
  const isAllTarget = normalized.publicTargetCount === "all";
  const processedLimit = parsePositiveInteger(
    args.max_candidates,
    isAllTarget ? CHAT_ALL_MAX_CANDIDATES : CHAT_ALL_MAX_CANDIDATES
  );
  const shouldRequestResume = shouldRequestChatResume(args);
  const useLlm = shouldUseChatLlm(args);
  const resolvedConfig = configResolution || (useLlm ? resolveBossScreeningConfig(workspaceRoot) : { ok: false });
  const humanBehavior = resolveHumanBehaviorForRun(args, resolvedConfig?.config || {});
  return {
    client: session.client,
    targetUrl: CHAT_TARGET_URL,
    job: normalized.job,
    startFrom: normalized.startFrom,
    criteria: normalized.criteria,
    maxCandidates: processedLimit,
    targetPassCount: isAllTarget ? null : normalized.targetCount,
    processUntilListEnd: isAllTarget,
    detailLimit: parseNonNegativeInteger(args.detail_limit, useLlm || shouldRequestResume ? processedLimit : 0),
    detailSource: normalizeText(args.detail_source) || "cascade",
    closeResume: true,
    requestResumeForPassed: shouldRequestResume,
    dryRunRequestCv: args.dry_run === true || args.dry_run_request_cv === true,
    greetingText: normalized.greetingText || DEFAULT_CHAT_GREETING_TEXT,
    delayMs: parseNonNegativeInteger(args.delay_ms, 0),
    cardTimeoutMs: slowLive ? 180000 : 90000,
    readyTimeoutMs: slowLive ? 120000 : 60000,
    onlineResumeButtonTimeoutMs: parsePositiveInteger(
      args.online_resume_button_timeout_ms,
      slowLive ? 30000 : 15000
    ),
    resumeDomTimeoutMs: slowLive ? 120000 : 60000,
    maxImagePages: parsePositiveInteger(args.max_image_pages, DEFAULT_MAX_IMAGE_PAGES),
    imageWheelDeltaY: parsePositiveInteger(args.image_wheel_delta_y, 650),
    llmConfig: resolvedConfig.ok ? {
      ...resolvedConfig.config
    } : null,
    llmTimeoutMs: parsePositiveInteger(
      args.llm_timeout_ms,
      parsePositiveInteger(resolvedConfig.config?.llmTimeoutMs || resolvedConfig.config?.timeoutMs, slowLive ? 180000 : 120000)
    ),
    llmImageLimit: parsePositiveInteger(
      args.llm_image_limit,
      parsePositiveInteger(resolvedConfig.config?.llmImageLimit || resolvedConfig.config?.imageLimit, 8)
    ),
    llmImageDetail: normalizeText(
      args.llm_image_detail || resolvedConfig.config?.llmImageDetail || resolvedConfig.config?.imageDetail
    ) || "low",
    screeningMode: normalizeScreeningModeArg(args),
    listMaxScrolls: parsePositiveInteger(args.list_max_scrolls, 200),
    listStableSignatureLimit: parsePositiveInteger(args.list_stable_signature_limit, 2),
    listWheelDeltaY: parsePositiveInteger(args.list_wheel_delta_y, 850),
    listSettleMs: parsePositiveInteger(args.list_settle_ms, slowLive ? 1800 : 1200),
    listFallbackPoint: null,
    imageOutputDir: resolveBossConfiguredOutputDir("", getChatRunsDir()),
    humanRestEnabled: humanBehavior.restEnabled,
    humanBehavior,
    name: "mcp-boss-chat-run"
  };
}

async function closeChatRunSession(runId) {
  const meta = chatRunMeta.get(runId);
  if (!meta || meta.closed) return;
  try {
    try {
      if (meta.session?.client) {
        await closeChatResumeModal(meta.session.client, { attemptsLimit: 2 });
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

async function waitForChatRunTerminal(runId) {
  while (true) {
    try {
      const snapshot = chatRunService.getChatRun(runId);
      if (TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    } catch {
      return null;
    }
    await sleep(1000);
  }
}

function trackChatRun(runId) {
  waitForChatRunTerminal(runId)
    .then((terminal) => {
      if (terminal) persistChatRunSnapshot(terminal);
    })
    .catch(() => null)
    .finally(() => {
      closeChatRunSession(runId).catch(() => {});
    });
}

async function startBossChatRunInternal(args = {}, { workspaceRoot = "" } = {}) {
  const defaultConfigResolution = resolveBossScreeningConfig(workspaceRoot);
  const normalized = normalizeChatStartInput(args, defaultConfigResolution);
  const missingFields = getMissingChatStartFields(args, normalized);
  if (missingFields.length) {
    return buildNeedInputResponse({
      args,
      missingFields,
      normalized
    });
  }

  const shouldRequestResume = shouldRequestChatResume(args);
  const useLlm = shouldUseChatLlm(args);
  const debugTestOptions = collectChatDebugTestOptions(args);
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
  const configResolution = useLlm ? resolveBossScreeningConfig(workspaceRoot) : null;
  if (useLlm && !configResolution?.ok) {
    return {
      status: "FAILED",
      error: {
        code: "SCREEN_CONFIG_ERROR",
        message: configResolution?.error?.message || "screening-config.json is required for chat LLM screening",
        retryable: true
      }
    };
  }

  let session;
  try {
    session = await chatConnectorImpl({
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
        code: loginRequired ? "BOSS_LOGIN_REQUIRED" : "BOSS_CHAT_PAGE_NOT_READY",
        message: error?.message || "Boss chat page is not ready",
        requires_login: Boolean(error?.requires_login),
        login_url: error?.login_url || null,
        login_detection: error?.login_detection || null,
        chrome: error?.chrome || null,
        current_url: error?.current_url || null,
        target_url: error?.target_url || CHAT_TARGET_URL,
        retryable: true
      },
      chrome: error?.chrome || null
    };
  }

  let started;
  try {
    started = chatRunService.startChatRun(getRunOptions(args, normalized, session, { workspaceRoot, configResolution }));
  } catch (error) {
    await session.close?.();
    return {
      status: "FAILED",
      error: {
        code: "CHAT_RUN_START_FAILED",
        message: error?.message || "Failed to start Boss chat run",
        retryable: true
      }
    };
  }

  chatRunMeta.set(started.runId, {
    session,
    methodLog: session.methodLog || [],
    workspaceRoot: normalizeText(workspaceRoot) || process.cwd(),
    args: clonePlain(args, {}),
    normalized,
    chrome: {
      host: normalized.host,
      port: normalized.port,
      target_url: session.navigation?.url || session.target?.url || CHAT_TARGET_URL,
      target_id: session.target?.id || null,
      auto_launch: session.chrome || null
    },
    health: session.health || null
  });
  trackChatRun(started.runId);
  const persistedStarted = persistChatRunSnapshot(started);

  return {
    status: "ACCEPTED",
    run_id: persistedStarted.run_id,
    state: persistedStarted.state,
    run: persistedStarted,
    poll_after_sec: DEFAULT_CHAT_POLL_AFTER_SEC,
    message: shouldRequestResume
      ? "Boss chat run started through the shared CDP-only chat service. Passed candidates will follow the configured request-CV sequence."
      : "Boss chat run started through the shared CDP-only chat service.",
    target_count_semantics: TARGET_COUNT_SEMANTICS
  };
}

export async function prepareBossChatRunTool({ workspaceRoot = "", args = {} } = {}) {
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const normalized = normalizeChatStartInput(args, configResolution);
  let session;
  try {
    session = await chatConnectorImpl({
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
      stage: "chat_run_setup",
      error: {
        code: loginRequired ? "BOSS_LOGIN_REQUIRED" : "BOSS_CHAT_PAGE_NOT_READY",
        message: error?.message || "Boss chat page is not ready",
        requires_login: Boolean(error?.requires_login),
        login_url: error?.login_url || null,
        login_detection: error?.login_detection || null,
        chrome: error?.chrome || null,
        current_url: error?.current_url || null,
        target_url: error?.target_url || CHAT_TARGET_URL,
        retryable: true
      },
      runtime_evaluate_used: false,
      method_summary: {},
      method_log: [],
      chrome: {
        host: normalized.host,
        port: normalized.port,
        target_url: CHAT_TARGET_URL,
        auto_launch: error?.chrome || null
      }
    };
  }

  try {
    const jobs = await chatJobReaderImpl(session, {
      workspaceRoot: normalizeText(workspaceRoot) || process.cwd(),
      args: clonePlain(args, {}),
      normalized
    });
    const jobOptions = Array.isArray(jobs?.job_options) ? jobs.job_options : [];
    const missingFields = getMissingChatStartFields(args, normalized);
    const diagnostics = buildTargetCountDiagnostics(args, missingFields, normalized);
    const nextCallExample = buildChatNextCallExample(args, missingFields, normalized);
    const selectedJob = jobOptions.find((option) => {
      const job = normalizeText(normalized.job).toLowerCase();
      if (!job) return option.active === true;
      return [option.value, option.label, option.title]
        .map((value) => normalizeText(value).toLowerCase())
        .includes(job);
    }) || null;

    assertNoForbiddenCdpCalls(session.methodLog || []);
    return {
      status: missingFields.length ? "NEED_INPUT" : "READY",
      stage: "chat_run_setup",
      page_url: session.navigation?.url || session.target?.url || CHAT_TARGET_URL,
      required_fields: CHAT_REQUIRED_FIELDS.slice(),
      missing_fields: missingFields,
      job_options: jobOptions,
      selected_job: selectedJob,
      selected_job_label: jobs?.selected_label || selectedJob?.label || "",
      job_options_source: jobs?.source || "",
      job_options_selector: jobs?.selector || "",
      pending_questions: buildPendingChatQuestions({
        args,
        missingFields,
        normalized,
        jobOptions
      }),
      ...diagnostics,
      ...(nextCallExample ? { next_call_example: nextCallExample } : {}),
      message: missingFields.length
        ? "已通过 CDP-only 读取 Boss 聊天页岗位列表，请补齐 job / start_from / target_count / criteria。"
        : "Boss chat CDP-only preflight is ready. Use start_boss_chat_run to start screening.",
      runtime_evaluate_used: false,
      method_summary: methodSummary(session.methodLog || []),
      method_log: session.methodLog || [],
      chrome: {
        host: normalized.host,
        port: normalized.port,
        target_url: session.navigation?.url || session.target?.url || CHAT_TARGET_URL,
        target_id: session.target?.id || null,
        auto_launch: session.chrome || null
      }
    };
  } catch (error) {
    const loginRequired = error?.code === "BOSS_LOGIN_REQUIRED";
    return {
      status: "FAILED",
      stage: "chat_run_setup",
      error: {
        code: loginRequired ? "BOSS_LOGIN_REQUIRED" : "BOSS_CHAT_PREPARE_FAILED",
        message: error?.message || "Boss chat CDP-only prepare failed",
        requires_login: Boolean(error?.requires_login),
        login_url: error?.login_url || null,
        login_detection: error?.login_detection || null,
        chrome: error?.chrome || null,
        current_url: error?.current_url || null,
        target_url: error?.target_url || CHAT_TARGET_URL,
        retryable: true
      },
      runtime_evaluate_used: false,
      method_summary: methodSummary(session.methodLog || []),
      method_log: session.methodLog || [],
      chrome: {
        host: normalized.host,
        port: normalized.port,
        target_url: session.navigation?.url || session.target?.url || CHAT_TARGET_URL,
        target_id: session.target?.id || null,
        auto_launch: session.chrome || null
      }
    };
  } finally {
    try {
      assertNoForbiddenCdpCalls(session.methodLog || []);
    } finally {
      await session.close?.();
    }
  }
}

export async function bossChatHealthCheckTool({ workspaceRoot = "", args = {} } = {}) {
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const runtimeLayout = resolveBossChatRuntimeLayout(workspaceRoot);
  const host = normalizeText(args.host) || DEFAULT_CHAT_HOST;
  const port = parsePositiveInteger(args.port, configResolution.ok ? configResolution.config.debugPort : DEFAULT_CHAT_PORT);
  const targetUrlIncludes = normalizeText(args.target_url_includes) || CHAT_TARGET_URL;
  const allowNavigate = args.allow_navigate !== false;
  const slowLive = args.slow_live === true;
  const basePayload = {
    server: "boss-chat",
    mode: "cdp-only",
    cdp_only: true,
    cli_dir: null,
    cli_path: null,
    config_path: configResolution.config_path || null,
    config_dir: configResolution.config_dir || null,
    output_dir: configResolution.ok ? configResolution.config.outputDir || null : null,
    debug_port: port,
    shared_llm_config: configResolution.ok === true,
    data_dir: runtimeLayout.data_dir,
    data_dir_source: runtimeLayout.data_dir_source,
    legacy_workspace_dir: runtimeLayout.legacy_workspace_dir,
    migration_source_dir: runtimeLayout.migration_source_dir,
    migration_pending: runtimeLayout.migration_pending
  };

  if (!configResolution.ok) {
    return {
      status: "FAILED",
      ...basePayload,
      error: configResolution.error,
      runtime_evaluate_used: false,
      method_summary: {},
      method_log: [],
      chrome: {
        host,
        port,
        target_url: targetUrlIncludes
      }
    };
  }

  let session;
  try {
    session = await chatConnectorImpl({
      host,
      port,
      targetUrlIncludes,
      allowNavigate,
      slowLive
    });
    assertNoForbiddenCdpCalls(session.methodLog || []);
    return {
      status: "OK",
      ...basePayload,
      page_url: session.navigation?.url || session.target?.url || CHAT_TARGET_URL,
      health: session.health || null,
      runtime_evaluate_used: false,
      method_summary: methodSummary(session.methodLog || []),
      method_log: session.methodLog || [],
      chrome: {
        host,
        port,
        target_url: session.navigation?.url || session.target?.url || CHAT_TARGET_URL,
        target_id: session.target?.id || null,
        auto_launch: session.chrome || null
      },
      message: "Boss chat CDP-only health check passed with shared self-heal probes."
    };
  } catch (error) {
    const loginRequired = error?.code === "BOSS_LOGIN_REQUIRED";
    return {
      status: "FAILED",
      ...basePayload,
      error: {
        code: loginRequired ? "BOSS_LOGIN_REQUIRED" : "BOSS_CHAT_PAGE_NOT_READY",
        message: error?.message || "Boss chat page is not ready",
        requires_login: Boolean(error?.requires_login),
        login_url: error?.login_url || null,
        login_detection: error?.login_detection || null,
        chrome: error?.chrome || null,
        current_url: error?.current_url || null,
        target_url: error?.target_url || CHAT_TARGET_URL,
        retryable: true
      },
      runtime_evaluate_used: false,
      method_summary: methodSummary(session?.methodLog || []),
      method_log: session?.methodLog || [],
      chrome: {
        host,
        port,
        target_url: session?.navigation?.url || session?.target?.url || targetUrlIncludes,
        target_id: session?.target?.id || null,
        auto_launch: error?.chrome || session?.chrome || null
      }
    };
  } finally {
    if (session?.methodLog) assertNoForbiddenCdpCalls(session.methodLog);
    await session?.close?.();
  }
}

export async function startBossChatRunTool({ workspaceRoot = "", args = {} } = {}) {
  const started = await startBossChatRunInternal(args, { workspaceRoot });
  if (started.status !== "ACCEPTED") return started;
  return attachMethodEvidence(started, started.run_id);
}

export function getBossChatRunTool({ args = {} } = {}) {
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
    const run = chatRunService.getChatRun(runId);
    const normalizedRun = persistChatRunSnapshot(run);
    return attachMethodEvidence({
      status: "RUN_STATUS",
      run: normalizedRun
    }, runId);
  } catch {
    const persisted = readChatRunState(runId);
    if (persisted) {
      const reconciled = reconcilePersistedChatRun(persisted);
      return {
        status: "RUN_STATUS",
        run: reconciled.run,
        persistence: {
          source: "disk",
          active_control_available: false,
          stale_finalized: reconciled.stale_finalized === true,
          artifacts_repaired: reconciled.artifacts_repaired === true
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
        message: `No Boss chat run found for run_id=${runId}`,
        retryable: false
      }
    };
  }
}

export function pauseBossChatRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  try {
    const before = chatRunService.getChatRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistChatRunSnapshot(before);
      return attachMethodEvidence({
        status: "PAUSE_IGNORED",
        run: normalizedBefore,
        message: "目标任务已结束，无需暂停。"
      }, runId);
    }
    if (before.status === RUN_STATUS_PAUSED) {
      const normalizedBefore = persistChatRunSnapshot(before);
      return attachMethodEvidence({
        status: "PAUSE_IGNORED",
        run: normalizedBefore,
        message: "目标任务已经处于 paused 状态。"
      }, runId);
    }
    const run = chatRunService.pauseChatRun(runId);
    const normalizedRun = persistChatRunSnapshot(run);
    return attachMethodEvidence({
      status: "PAUSE_REQUESTED",
      run: normalizedRun,
      message: "暂停请求已接收，将在当前候选人处理完成后进入 paused。"
    }, runId);
  } catch {
    const persisted = readChatRunState(runId);
    if (persisted && TERMINAL_STATUSES.has(persisted.state)) {
      const reconciled = reconcilePersistedChatRun(persisted);
      return {
        status: "PAUSE_IGNORED",
        run: reconciled.run,
        message: "目标任务已结束，无需暂停。",
        runtime_evaluate_used: false,
        method_summary: {},
        method_log: [],
        chrome: null
      };
    }
    return getBossChatRunTool({ args });
  }
}

export function resumeBossChatRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  try {
    const before = chatRunService.getChatRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistChatRunSnapshot(before);
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
      const normalizedBefore = persistChatRunSnapshot(before);
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
    const run = chatRunService.resumeChatRun(runId);
    const meta = getChatRunMeta(runId);
    if (meta) {
      meta.resumeCount = (meta.resumeCount || 0) + 1;
      meta.lastResumedAt = new Date().toISOString();
    }
    const normalizedRun = persistChatRunSnapshot(run);
    return attachMethodEvidence({
      status: "RESUME_REQUESTED",
      run: normalizedRun,
      poll_after_sec: DEFAULT_CHAT_POLL_AFTER_SEC,
      message: "已恢复 Boss chat run，请使用 get_boss_chat_run 按需轮询。"
    }, runId);
  } catch {
    const persisted = readChatRunState(runId);
    if (persisted) {
      const reconciled = reconcilePersistedChatRun(persisted);
      const reconciledStatus = reconciled.run?.status || reconciled.run?.state;
      return {
        status: "FAILED",
        error: {
          code: TERMINAL_STATUSES.has(reconciledStatus) ? "RUN_ALREADY_TERMINATED" : "RUN_NOT_ACTIVE",
          message: TERMINAL_STATUSES.has(reconciledStatus)
            ? "目标任务已结束，无法继续。"
            : "该 run 只有磁盘快照，没有当前进程内的活动 CDP 会话，无法安全继续。",
          retryable: !TERMINAL_STATUSES.has(reconciledStatus)
        },
        run: reconciled.run,
        persistence: {
          source: "disk",
          active_control_available: false,
          stale_finalized: reconciled.stale_finalized === true,
          artifacts_repaired: reconciled.artifacts_repaired === true
        },
        runtime_evaluate_used: false,
        method_summary: {},
        method_log: [],
        chrome: null
      };
    }
    return getBossChatRunTool({ args });
  }
}

export function cancelBossChatRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  try {
    const before = chatRunService.getChatRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistChatRunSnapshot(before);
      return attachMethodEvidence({
        status: "CANCEL_IGNORED",
        run: normalizedBefore,
        message: "目标任务已结束，无需取消。"
      }, runId);
    }
    const run = chatRunService.cancelChatRun(runId);
    const normalizedRun = persistChatRunSnapshot(run);
    return attachMethodEvidence({
      status: "CANCEL_REQUESTED",
      run: normalizedRun,
      message: "已收到取消请求，将在当前候选人处理完成后安全停止。"
    }, runId);
  } catch {
    const persisted = readChatRunState(runId);
    if (persisted && TERMINAL_STATUSES.has(persisted.state)) {
      const reconciled = reconcilePersistedChatRun(persisted);
      return {
        status: "CANCEL_IGNORED",
        run: reconciled.run,
        message: "目标任务已结束，无需取消。",
        runtime_evaluate_used: false,
        method_summary: {},
        method_log: [],
        chrome: null
      };
    }
    if (persisted) {
      const reconciled = reconcilePersistedChatRun(persisted, { cancelStale: true });
      if (reconciled.stale_finalized) {
        return {
          status: "CANCEL_REQUESTED",
          run: reconciled.run,
          message: "该 run 的后台进程已经不在，已将磁盘状态安全标记为 canceled 并生成结果文件。",
          persistence: {
            source: "disk",
            active_control_available: false,
            stale_finalized: true,
            artifacts_repaired: reconciled.artifacts_repaired === true
          },
          runtime_evaluate_used: false,
          method_summary: {},
          method_log: [],
          chrome: null
        };
      }
    }
    return getBossChatRunTool({ args });
  }
}

export function __setChatMcpConnectorForTests(nextConnector) {
  chatConnectorImpl = typeof nextConnector === "function" ? nextConnector : connectChatChromeSession;
}

export function __setChatMcpJobReaderForTests(nextReader) {
  chatJobReaderImpl = typeof nextReader === "function" ? nextReader : readChatJobOptionsFromSession;
}

export function __setChatMcpWorkflowForTests(nextWorkflow) {
  chatWorkflowImpl = typeof nextWorkflow === "function" ? nextWorkflow : runChatWorkflow;
  chatRunService = createChatRunService({
    idPrefix: "mcp_chat",
    workflow: (...args) => chatWorkflowImpl(...args),
    onSnapshot: persistChatLifecycleSnapshot
  });
}

export function __resetChatMcpStateForTests() {
  for (const meta of chatRunMeta.values()) {
    try {
      meta.session?.close?.();
    } catch {
      // Best-effort test cleanup.
    }
  }
  chatRunMeta.clear();
  __setChatMcpConnectorForTests(null);
  __setChatMcpJobReaderForTests(null);
  __setChatMcpWorkflowForTests(null);
}
