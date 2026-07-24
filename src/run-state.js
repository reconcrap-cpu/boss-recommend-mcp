import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withRunStateFileLockSync } from "./core/run/state-file-lock.js";

export const RUN_MODE_SYNC = "sync";
export const RUN_MODE_ASYNC = "async";

export const RUN_STATE_QUEUED = "queued";
export const RUN_STATE_RUNNING = "running";
export const RUN_STATE_PAUSED = "paused";
export const RUN_STATE_CANCELING = "canceling";
export const RUN_STATE_COMPLETED = "completed";
export const RUN_STATE_FAILED = "failed";
export const RUN_STATE_CANCELED = "canceled";

export const RUN_STAGE_PREFLIGHT = "preflight";
export const RUN_STAGE_PAGE_READY = "page_ready";
export const RUN_STAGE_JOB_LIST = "job_list";
export const RUN_STAGE_SEARCH = "search";
export const RUN_STAGE_SCREEN = "screen";
export const RUN_STAGE_CHAT_FOLLOWUP = "chat_followup";
export const RUN_STAGE_FINALIZE = "finalize";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 120_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RETENTION_PROTECTED_RUN_STATES = new Set([
  RUN_STATE_QUEUED,
  RUN_STATE_RUNNING,
  RUN_STATE_PAUSED,
  "canceling"
]);

const VALID_RUN_MODES = new Set([RUN_MODE_SYNC, RUN_MODE_ASYNC]);
const VALID_RUN_STATES = new Set([
  RUN_STATE_QUEUED,
  RUN_STATE_RUNNING,
  RUN_STATE_PAUSED,
  RUN_STATE_CANCELING,
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED,
  RUN_STATE_CANCELED
]);
const VALID_RUN_STAGES = new Set([
  RUN_STAGE_PREFLIGHT,
  RUN_STAGE_PAGE_READY,
  RUN_STAGE_JOB_LIST,
  RUN_STAGE_SEARCH,
  RUN_STAGE_SCREEN,
  RUN_STAGE_CHAT_FOLLOWUP,
  RUN_STAGE_FINALIZE
]);

function toIsoNow() {
  return new Date().toISOString();
}

function parsePositiveInteger(raw, fallback) {
  const value = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getRunHeartbeatIntervalMs() {
  return parsePositiveInteger(process.env.BOSS_RECOMMEND_RUN_HEARTBEAT_MS, DEFAULT_HEARTBEAT_INTERVAL_MS);
}

export function getRunRetentionMs() {
  return parsePositiveInteger(process.env.BOSS_RECOMMEND_RUN_RETENTION_MS, DEFAULT_RETENTION_MS);
}

export function getStateHome() {
  return process.env.BOSS_RECOMMEND_HOME
    ? path.resolve(process.env.BOSS_RECOMMEND_HOME)
    : path.join(os.homedir(), ".boss-recommend-mcp");
}

export function getRunsDir() {
  return path.join(getStateHome(), "runs");
}

function ensureRunsDir() {
  fs.mkdirSync(getRunsDir(), { recursive: true });
}

function normalizeRunId(runId) {
  return String(runId || "").trim();
}

function getRunStatePath(runId) {
  const normalized = normalizeRunId(runId);
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error("Invalid run_id");
  }
  return path.join(getRunsDir(), `${normalized}.json`);
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeWriteJson(filePath, payload) {
  ensureRunsDir();
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function defaultProgress(progress = {}) {
  return {
    processed: Number.isInteger(progress.processed) && progress.processed >= 0 ? progress.processed : 0,
    passed: Number.isInteger(progress.passed) && progress.passed >= 0 ? progress.passed : 0,
    skipped: Number.isInteger(progress.skipped) && progress.skipped >= 0 ? progress.skipped : 0,
    greet_count: Number.isInteger(progress.greet_count) && progress.greet_count >= 0 ? progress.greet_count : 0
  };
}

function normalizeRunMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  return VALID_RUN_MODES.has(normalized) ? normalized : RUN_MODE_SYNC;
}

function normalizeRunState(state) {
  const normalized = String(state || "").trim().toLowerCase();
  return VALID_RUN_STATES.has(normalized) ? normalized : RUN_STATE_QUEUED;
}

function normalizeRunStage(stage) {
  const normalized = String(stage || "").trim().toLowerCase();
  return VALID_RUN_STAGES.has(normalized) ? normalized : RUN_STAGE_PREFLIGHT;
}

function normalizeMessage(message) {
  const normalized = String(message || "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function defaultContext(context = null) {
  return clonePlainObject(context);
}

function defaultControl(control = {}) {
  return {
    pause_requested: control?.pause_requested === true,
    pause_requested_at: normalizeMessage(control?.pause_requested_at || ""),
    pause_requested_by: normalizeMessage(control?.pause_requested_by || ""),
    cancel_requested: control?.cancel_requested === true
  };
}

function defaultResume(resume = {}) {
  return {
    checkpoint_path: normalizeMessage(resume?.checkpoint_path || ""),
    pause_control_path: normalizeMessage(resume?.pause_control_path || ""),
    output_csv: normalizeMessage(resume?.output_csv || ""),
    worker_stdout_path: normalizeMessage(resume?.worker_stdout_path || ""),
    worker_stderr_path: normalizeMessage(resume?.worker_stderr_path || ""),
    worker_exit_status_path: normalizeMessage(resume?.worker_exit_status_path || ""),
    worker_launcher: normalizeMessage(resume?.worker_launcher || ""),
    worker_launch_id: normalizeMessage(resume?.worker_launch_id || ""),
    worker_supervisor_pid: Number.isInteger(resume?.worker_supervisor_pid) && resume.worker_supervisor_pid > 0
      ? resume.worker_supervisor_pid
      : null,
    worker_node_pid: Number.isInteger(resume?.worker_node_pid) && resume.worker_node_pid > 0
      ? resume.worker_node_pid
      : null,
    worker_launched_at: normalizeMessage(resume?.worker_launched_at || ""),
    worker_started_at: normalizeMessage(resume?.worker_started_at || ""),
    worker_launch_committed: resume?.worker_launch_committed === true,
    follow_up_phase: normalizeMessage(resume?.follow_up_phase || ""),
    chat_run_id: normalizeMessage(resume?.chat_run_id || ""),
    chat_state: normalizeMessage(resume?.chat_state || ""),
    resume_count: Number.isInteger(resume?.resume_count) && resume.resume_count >= 0 ? resume.resume_count : 0,
    last_resumed_at: normalizeMessage(resume?.last_resumed_at || ""),
    last_paused_at: normalizeMessage(resume?.last_paused_at || "")
  };
}

export function createRunId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

export function createRunStateSnapshot({
  runId,
  mode = RUN_MODE_SYNC,
  state = RUN_STATE_QUEUED,
  stage = RUN_STAGE_PREFLIGHT,
  pid = process.pid,
  lastMessage = null,
  context = null,
  control = null,
  resume = null,
  monitoringV1 = null
} = {}) {
  const now = toIsoNow();
  const normalizedMonitoringV1 = clonePlainObject(monitoringV1);
  return {
    run_id: normalizeRunId(runId) || createRunId(),
    mode: normalizeRunMode(mode),
    state: normalizeRunState(state),
    stage: normalizeRunStage(stage),
    started_at: now,
    updated_at: now,
    heartbeat_at: now,
    pid: Number.isInteger(pid) && pid > 0 ? pid : process.pid,
    progress: defaultProgress(),
    last_message: normalizeMessage(lastMessage),
    context: defaultContext(context),
    control: defaultControl(control),
    resume: defaultResume(resume),
    ...(normalizedMonitoringV1 ? { monitoring_v1: normalizedMonitoringV1 } : {}),
    error: null,
    result: null
  };
}

function writeRunStateUnlocked(snapshot) {
  const runId = normalizeRunId(snapshot?.run_id);
  if (!runId) {
    throw new Error("run_id is required");
  }
  const now = toIsoNow();
  const normalizedMonitoringV1 = clonePlainObject(snapshot.monitoring_v1);
  const payload = {
    run_id: runId,
    mode: normalizeRunMode(snapshot.mode),
    state: normalizeRunState(snapshot.state),
    stage: normalizeRunStage(snapshot.stage),
    started_at: String(snapshot.started_at || now),
    updated_at: String(snapshot.updated_at || now),
    heartbeat_at: String(snapshot.heartbeat_at || now),
    pid: Number.isInteger(snapshot.pid) && snapshot.pid > 0 ? snapshot.pid : process.pid,
    progress: defaultProgress(snapshot.progress),
    last_message: normalizeMessage(snapshot.last_message),
    context: defaultContext(snapshot.context),
    control: defaultControl(snapshot.control),
    resume: defaultResume(snapshot.resume),
    ...(normalizedMonitoringV1 ? { monitoring_v1: normalizedMonitoringV1 } : {}),
    error: snapshot.error || null,
    result: snapshot.result || null
  };
  safeWriteJson(getRunStatePath(runId), payload);
  return payload;
}

export function writeRunState(snapshot) {
  const runId = normalizeRunId(snapshot?.run_id);
  if (!runId) {
    throw new Error("run_id is required");
  }
  const statePath = getRunStatePath(runId);
  return withRunStateFileLockSync(
    statePath,
    () => writeRunStateUnlocked(snapshot)
  );
}

export function readRunState(runId) {
  const payload = safeReadJson(getRunStatePath(runId));
  if (!payload) return null;
  const normalizedMonitoringV1 = clonePlainObject(payload.monitoring_v1);
  return {
    run_id: normalizeRunId(payload.run_id),
    mode: normalizeRunMode(payload.mode),
    state: normalizeRunState(payload.state),
    stage: normalizeRunStage(payload.stage),
    started_at: String(payload.started_at || ""),
    updated_at: String(payload.updated_at || ""),
    heartbeat_at: String(payload.heartbeat_at || ""),
    pid: Number.isInteger(payload.pid) && payload.pid > 0 ? payload.pid : process.pid,
    progress: defaultProgress(payload.progress),
    last_message: normalizeMessage(payload.last_message),
    context: defaultContext(payload.context),
    control: defaultControl(payload.control),
    resume: defaultResume(payload.resume),
    ...(normalizedMonitoringV1 ? { monitoring_v1: normalizedMonitoringV1 } : {}),
    error: payload.error || null,
    result: payload.result || null
  };
}

export function updateRunState(runId, updater) {
  const statePath = getRunStatePath(runId);
  return withRunStateFileLockSync(statePath, () => {
    const current = readRunState(runId);
    if (!current) return null;
    const patch = typeof updater === "function" ? updater({ ...current }) : updater;
    if (!patch || typeof patch !== "object") {
      return current;
    }
    const now = toIsoNow();
    const next = {
      ...current,
      ...patch,
      run_id: current.run_id,
      mode: normalizeRunMode(patch.mode ?? current.mode),
      state: normalizeRunState(patch.state ?? current.state),
      stage: normalizeRunStage(patch.stage ?? current.stage),
      progress: defaultProgress({
        ...current.progress,
        ...(patch.progress || {})
      }),
      context: Object.prototype.hasOwnProperty.call(patch, "context")
        ? defaultContext(patch.context)
        : current.context,
      control: defaultControl({
        ...current.control,
        ...(patch.control || {})
      }),
      resume: defaultResume({
        ...current.resume,
        ...(patch.resume || {})
      }),
      last_message: normalizeMessage(
        Object.prototype.hasOwnProperty.call(patch, "last_message")
          ? patch.last_message
          : current.last_message
      ),
      updated_at: now,
      heartbeat_at: String(
        Object.prototype.hasOwnProperty.call(patch, "heartbeat_at")
          ? (patch.heartbeat_at || now)
          : current.heartbeat_at
      )
    };
    return writeRunStateUnlocked(next);
  });
}

export function touchRunHeartbeat(runId, message = null) {
  return updateRunState(runId, (current) => ({
    heartbeat_at: toIsoNow(),
    last_message: message ?? current.last_message
  }));
}

export function updateRunProgress(runId, progressPatch = {}, message = null) {
  const patch = {
    progress: {}
  };
  if (Number.isInteger(progressPatch.processed) && progressPatch.processed >= 0) {
    patch.progress.processed = progressPatch.processed;
  }
  if (Number.isInteger(progressPatch.passed) && progressPatch.passed >= 0) {
    patch.progress.passed = progressPatch.passed;
  }
  if (Number.isInteger(progressPatch.skipped) && progressPatch.skipped >= 0) {
    patch.progress.skipped = progressPatch.skipped;
  }
  if (Number.isInteger(progressPatch.greet_count) && progressPatch.greet_count >= 0) {
    patch.progress.greet_count = progressPatch.greet_count;
  }
  if (message !== null) {
    patch.last_message = message;
  }
  return updateRunState(runId, patch);
}

export function cleanupExpiredRuns(retentionMs = getRunRetentionMs()) {
  ensureRunsDir();
  const removed = [];
  const failed = [];
  const preservedActive = [];
  const now = Date.now();
  const entries = fs.readdirSync(getRunsDir(), { withFileTypes: true });
  const activeRunIds = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(getRunsDir(), entry.name);
    const persisted = safeReadJson(filePath);
    const runId = normalizeRunId(persisted?.run_id || persisted?.runId || "");
    const state = (normalizeMessage(persisted?.state || persisted?.status || "") || "").toLowerCase();
    if (
      runId
      && entry.name === `${runId}.json`
      && RETENTION_PROTECTED_RUN_STATES.has(state)
    ) {
      activeRunIds.add(runId);
    }
  }
  const protectedArtifactNames = new Set();
  for (const runId of activeRunIds) {
    protectedArtifactNames.add(`${runId}.json`);
    protectedArtifactNames.add(`${runId}.checkpoint.json`);
    protectedArtifactNames.add(`${runId}.worker.exit.json`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(getRunsDir(), entry.name);
    try {
      const stat = fs.statSync(filePath);
      const age = now - Number(stat.mtimeMs || 0);
      if (age < retentionMs) continue;
      if (protectedArtifactNames.has(entry.name)) {
        preservedActive.push(filePath);
        continue;
      }
      fs.unlinkSync(filePath);
      removed.push(filePath);
    } catch (error) {
      failed.push({
        file: filePath,
        reason: error.message || String(error)
      });
    }
  }
  return { removed, failed, preserved_active: preservedActive };
}
