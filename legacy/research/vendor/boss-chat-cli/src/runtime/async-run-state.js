import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RUN_MODE_ASYNC = 'async';

export const RUN_STATE_QUEUED = 'queued';
export const RUN_STATE_RUNNING = 'running';
export const RUN_STATE_PAUSED = 'paused';
export const RUN_STATE_COMPLETED = 'completed';
export const RUN_STATE_FAILED = 'failed';
export const RUN_STATE_CANCELED = 'canceled';

const TERMINAL_RUN_STATES = new Set([
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED,
  RUN_STATE_CANCELED,
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeRunId(runId) {
  const normalized = String(runId || '').trim();
  if (!normalized || normalized.includes('/') || normalized.includes('\\')) {
    throw new Error('Invalid run_id');
  }
  return normalized;
}

function ensureRunsDir(baseDir) {
  const runsDir = path.join(baseDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

export function createRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

export function getRunStatePath(baseDir, runId) {
  const normalizedRunId = normalizeRunId(runId);
  return path.join(ensureRunsDir(baseDir), `${normalizedRunId}.json`);
}

export function getRunEventsPath(baseDir, runId) {
  const normalizedRunId = normalizeRunId(runId);
  return path.join(ensureRunsDir(baseDir), `${normalizedRunId}.events.jsonl`);
}

function writeJsonAtomic(filePath, payload) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function clonePlain(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeProgress(progress = {}) {
  return {
    inspected:
      Number.isInteger(progress.inspected) && progress.inspected >= 0
        ? progress.inspected
        : 0,
    passed:
      Number.isInteger(progress.passed) && progress.passed >= 0 ? progress.passed : 0,
    requested:
      Number.isInteger(progress.requested) && progress.requested >= 0
        ? progress.requested
        : 0,
    skipped:
      Number.isInteger(progress.skipped) && progress.skipped >= 0 ? progress.skipped : 0,
    errors:
      Number.isInteger(progress.errors) && progress.errors >= 0 ? progress.errors : 0,
  };
}

function normalizeControl(control = {}) {
  return {
    pauseRequested: control?.pauseRequested === true,
    cancelRequested: control?.cancelRequested === true,
  };
}

function normalizeState(state) {
  const normalized = String(state || '').trim().toLowerCase();
  if (
    [
      RUN_STATE_QUEUED,
      RUN_STATE_RUNNING,
      RUN_STATE_PAUSED,
      RUN_STATE_COMPLETED,
      RUN_STATE_FAILED,
      RUN_STATE_CANCELED,
    ].includes(normalized)
  ) {
    return normalized;
  }
  return RUN_STATE_QUEUED;
}

export function createRunStateSnapshot({
  runId,
  pid = null,
  request = null,
  state = RUN_STATE_QUEUED,
  stage = 'preflight',
  lastMessage = '任务已创建，等待执行。',
} = {}) {
  const createdAt = nowIso();
  return {
    runId: normalizeRunId(runId),
    mode: RUN_MODE_ASYNC,
    state: normalizeState(state),
    stage: String(stage || 'preflight'),
    createdAt,
    updatedAt: createdAt,
    heartbeatAt: createdAt,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    lastMessage: String(lastMessage || ''),
    progress: normalizeProgress(),
    control: normalizeControl(),
    request: clonePlain(request, null),
    error: null,
    result: null,
  };
}

export function writeRunState(baseDir, snapshot) {
  const normalizedSnapshot = {
    ...snapshot,
    runId: normalizeRunId(snapshot?.runId),
    mode: RUN_MODE_ASYNC,
    state: normalizeState(snapshot?.state),
    stage: String(snapshot?.stage || 'preflight'),
    createdAt: String(snapshot?.createdAt || nowIso()),
    updatedAt: String(snapshot?.updatedAt || nowIso()),
    heartbeatAt: String(snapshot?.heartbeatAt || nowIso()),
    pid:
      Number.isInteger(snapshot?.pid) && snapshot.pid > 0
        ? snapshot.pid
        : null,
    lastMessage: String(snapshot?.lastMessage || ''),
    progress: normalizeProgress(snapshot?.progress || {}),
    control: normalizeControl(snapshot?.control || {}),
    request: clonePlain(snapshot?.request, null),
    error: Object.prototype.hasOwnProperty.call(snapshot || {}, 'error')
      ? snapshot.error
      : null,
    result: Object.prototype.hasOwnProperty.call(snapshot || {}, 'result')
      ? snapshot.result
      : null,
  };
  writeJsonAtomic(getRunStatePath(baseDir, normalizedSnapshot.runId), normalizedSnapshot);
  return normalizedSnapshot;
}

export function readRunState(baseDir, runId) {
  try {
    const raw = fs.readFileSync(getRunStatePath(baseDir, runId), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return {
      ...parsed,
      runId: normalizeRunId(parsed.runId),
      state: normalizeState(parsed.state),
      progress: normalizeProgress(parsed.progress || {}),
      control: normalizeControl(parsed.control || {}),
      pid: Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
      mode: RUN_MODE_ASYNC,
      stage: String(parsed.stage || 'preflight'),
      lastMessage: String(parsed.lastMessage || ''),
      createdAt: String(parsed.createdAt || ''),
      updatedAt: String(parsed.updatedAt || ''),
      heartbeatAt: String(parsed.heartbeatAt || ''),
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function updateRunState(baseDir, runId, updater) {
  const current = readRunState(baseDir, runId);
  if (!current) return null;

  const patch =
    typeof updater === 'function' ? updater(clonePlain(current, current)) : updater;
  if (!patch || typeof patch !== 'object') {
    return current;
  }

  const now = nowIso();
  const next = {
    ...current,
    ...patch,
    runId: current.runId,
    mode: RUN_MODE_ASYNC,
    state: normalizeState(patch.state ?? current.state),
    stage: String(patch.stage ?? current.stage ?? 'preflight'),
    progress: normalizeProgress({
      ...current.progress,
      ...(patch.progress || {}),
    }),
    control: normalizeControl({
      ...current.control,
      ...(patch.control || {}),
    }),
    lastMessage: Object.prototype.hasOwnProperty.call(patch, 'lastMessage')
      ? String(patch.lastMessage || '')
      : current.lastMessage,
    pid: Object.prototype.hasOwnProperty.call(patch, 'pid')
      ? Number.isInteger(patch.pid) && patch.pid > 0
        ? patch.pid
        : null
      : current.pid,
    updatedAt: now,
    heartbeatAt: Object.prototype.hasOwnProperty.call(patch, 'heartbeatAt')
      ? String(patch.heartbeatAt || now)
      : current.heartbeatAt || now,
    error: Object.prototype.hasOwnProperty.call(patch, 'error')
      ? patch.error
      : current.error,
    result: Object.prototype.hasOwnProperty.call(patch, 'result')
      ? patch.result
      : current.result,
  };

  writeRunState(baseDir, next);
  return next;
}

export function appendRunEvent(baseDir, runId, event = {}) {
  const filePath = getRunEventsPath(baseDir, runId);
  const payload = {
    timestamp: nowIso(),
    runId: normalizeRunId(runId),
    ...clonePlain(event, {}),
  };
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  return payload;
}

export function isTerminalRunState(state) {
  return TERMINAL_RUN_STATES.has(normalizeState(state));
}
