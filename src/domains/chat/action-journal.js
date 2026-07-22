import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHAT_ACTION_JOURNAL_SCHEMA_VERSION = 1;

export const CHAT_ACTION_STATES = Object.freeze([
  "pre_action",
  "greeting_send_in_flight",
  "greeting_assumed_sent",
  "greeting_confirmed",
  "request_in_flight",
  "request_confirmed",
  "outcome_unknown"
]);

const CHAT_ACTION_STATE_SET = new Set(CHAT_ACTION_STATES);
const RETRYABLE_WINDOWS_FILE_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EPERM"
]);
const RELEASED_LOCK_TOKENS = new Map();
const DEFAULT_LOCK_OPTIONS = Object.freeze({
  acquireTimeoutMs: 2_000,
  retryMinMs: 20,
  retryMaxMs: 200,
  staleMinAgeMs: 30_000,
  fileOperationAttempts: 6,
  fileOperationRetryMinMs: 10,
  fileOperationRetryMaxMs: 200
});
const INITIAL_STATE = "pre_action";
const ALLOWED_TRANSITIONS = Object.freeze({
  pre_action: new Set(["greeting_send_in_flight"]),
  greeting_send_in_flight: new Set([
    "greeting_assumed_sent",
    "greeting_confirmed",
    "outcome_unknown"
  ]),
  greeting_assumed_sent: new Set(["greeting_confirmed"]),
  greeting_confirmed: new Set(["request_in_flight"]),
  request_in_flight: new Set(["request_confirmed", "outcome_unknown"]),
  request_confirmed: new Set(),
  outcome_unknown: new Set([
    "greeting_assumed_sent",
    "greeting_confirmed",
    "request_confirmed"
  ])
});

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeGreeting(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function journalError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function requireScope(scope) {
  const normalized = normalizeText(scope);
  if (!normalized) {
    throw journalError(
      "CHAT_ACTION_SCOPE_REQUIRED",
      "A stable Boss chat account/profile scope is required for the action journal."
    );
  }
  return normalized;
}

function requireCandidateId(candidateId) {
  const normalized = normalizeText(candidateId);
  if (!normalized) {
    throw journalError(
      "CHAT_ACTION_CANDIDATE_ID_REQUIRED",
      "A stable Boss candidate ID is required before an outbound chat action can be journaled."
    );
  }
  return normalized;
}

function requireState(state) {
  const normalized = normalizeText(state);
  if (!CHAT_ACTION_STATE_SET.has(normalized)) {
    throw journalError(
      "CHAT_ACTION_STATE_INVALID",
      `Unsupported Boss chat action journal state: ${normalized || "<empty>"}.`,
      { state: normalized || null }
    );
  }
  return normalized;
}

function defaultBaseDir() {
  const configuredHome = normalizeText(process.env.BOSS_CHAT_HOME);
  const chatHome = configuredHome || path.join(os.homedir(), ".boss-recommend-mcp", "boss-chat");
  return path.join(chatHome, "action-journal");
}

function nowIso(now) {
  const raw = now();
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw journalError(
      "CHAT_ACTION_JOURNAL_CLOCK_INVALID",
      `Boss chat action journal clock returned an invalid value: ${String(raw)}.`
    );
  }
  return date.toISOString();
}

function cloneRecord(record) {
  return record == null ? null : JSON.parse(JSON.stringify(record));
}

function sleepSync(milliseconds) {
  const duration = Math.max(0, Math.floor(Number(milliseconds) || 0));
  if (duration <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeLockOptions(options = {}) {
  const retryMinMs = finiteNonNegative(options.retryMinMs, DEFAULT_LOCK_OPTIONS.retryMinMs);
  const retryMaxMs = Math.max(
    retryMinMs,
    finiteNonNegative(options.retryMaxMs, DEFAULT_LOCK_OPTIONS.retryMaxMs)
  );
  const fileOperationRetryMinMs = finiteNonNegative(
    options.fileOperationRetryMinMs,
    DEFAULT_LOCK_OPTIONS.fileOperationRetryMinMs
  );
  const fileOperationRetryMaxMs = Math.max(
    fileOperationRetryMinMs,
    finiteNonNegative(
      options.fileOperationRetryMaxMs,
      DEFAULT_LOCK_OPTIONS.fileOperationRetryMaxMs
    )
  );
  return Object.freeze({
    acquireTimeoutMs: finiteNonNegative(
      options.acquireTimeoutMs,
      DEFAULT_LOCK_OPTIONS.acquireTimeoutMs
    ),
    retryMinMs,
    retryMaxMs,
    staleMinAgeMs: finiteNonNegative(
      options.staleMinAgeMs,
      DEFAULT_LOCK_OPTIONS.staleMinAgeMs
    ),
    fileOperationAttempts: positiveInteger(
      options.fileOperationAttempts,
      DEFAULT_LOCK_OPTIONS.fileOperationAttempts
    ),
    fileOperationRetryMinMs,
    fileOperationRetryMaxMs,
    sleep: typeof options.sleep === "function" ? options.sleep : sleepSync,
    isProcessAlive: typeof options.isProcessAlive === "function"
      ? options.isProcessAlive
      : (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return error?.code !== "ESRCH";
        }
      }
  });
}

function retryDelay(attempt, minimum, maximum) {
  return Math.min(maximum, minimum * (2 ** Math.max(0, attempt - 1)));
}

function retryWindowsFileOperation(operation, {
  attempts,
  retryMinMs,
  retryMaxMs,
  sleep,
  enoentIsSuccess = false
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (enoentIsSuccess && error?.code === "ENOENT") return undefined;
      lastError = error;
      if (
        !RETRYABLE_WINDOWS_FILE_ERROR_CODES.has(error?.code)
        || attempt >= attempts
      ) {
        throw error;
      }
      sleep(retryDelay(attempt, retryMinMs, retryMaxMs));
    }
  }
  throw lastError;
}

function readJsonRecord(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("journal payload is not an object");
    }
    return parsed;
  } catch (error) {
    throw journalError(
      "CHAT_ACTION_JOURNAL_CORRUPT",
      `Unable to read Boss chat action journal record: ${error?.message || error}.`,
      { file_path: filePath }
    );
  }
}

function writeJsonAtomic(filePath, payload, lockOptions) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fileHandle = null;
  try {
    fileHandle = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fileHandle, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(fileHandle);
    fs.closeSync(fileHandle);
    fileHandle = null;
    retryWindowsFileOperation(
      () => fs.renameSync(tempPath, filePath),
      {
        attempts: lockOptions.fileOperationAttempts,
        retryMinMs: lockOptions.fileOperationRetryMinMs,
        retryMaxMs: lockOptions.fileOperationRetryMaxMs,
        sleep: lockOptions.sleep
      }
    );

    // Directory fsync is unsupported on some Windows/filesystem combinations.
    // The record itself has already been atomically replaced, so this is best-effort.
    let directoryHandle = null;
    try {
      directoryHandle = fs.openSync(directory, "r");
      fs.fsyncSync(directoryHandle);
    } catch {
      // Keep the portable temp+rename guarantee when directory fsync is unavailable.
    } finally {
      if (directoryHandle != null) fs.closeSync(directoryHandle);
    }
  } finally {
    if (fileHandle != null) fs.closeSync(fileHandle);
    try {
      if (fs.existsSync(tempPath)) {
        retryWindowsFileOperation(
          () => fs.unlinkSync(tempPath),
          {
            attempts: lockOptions.fileOperationAttempts,
            retryMinMs: lockOptions.fileOperationRetryMinMs,
            retryMaxMs: lockOptions.fileOperationRetryMaxMs,
            sleep: lockOptions.sleep,
            enoentIsSuccess: true
          }
        );
      }
    } catch {
      // A leftover temp file is never treated as a committed journal record.
    }
  }
}

function parseLockRecord(raw) {
  const text = normalizeText(raw);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const pid = Number(parsed.pid);
    return {
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      token: normalizeText(parsed.token) || null,
      released: parsed.released === true
    };
  } catch {
    const pid = Number(text);
    return {
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      token: null,
      released: false
    };
  }
}

function lockSnapshot(lockPath) {
  try {
    const stat = fs.statSync(lockPath);
    const raw = fs.readFileSync(lockPath, "utf8");
    return {
      raw,
      record: parseLockRecord(raw),
      ageMs: Math.max(0, Date.now() - stat.mtimeMs),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { unreadable: true };
  }
}

function sameLockSnapshot(first, second) {
  if (!first || !second || first.unreadable || second.unreadable) return false;
  return (
    first.raw === second.raw
    && first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
  );
}

function canSafelyReclaimLock(lockPath, snapshot, lockOptions) {
  const record = snapshot?.record;
  if (!record) return false;
  if (
    record.released === true
    || (
      record.token
      && RELEASED_LOCK_TOKENS.get(lockPath) === record.token
    )
  ) {
    return true;
  }
  if (
    snapshot.ageMs < lockOptions.staleMinAgeMs
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || record.pid === process.pid
  ) {
    return false;
  }
  try {
    return lockOptions.isProcessAlive(record.pid) === false;
  } catch {
    return false;
  }
}

function tryReclaimRecordLock(lockPath, lockOptions) {
  const first = lockSnapshot(lockPath);
  if (!canSafelyReclaimLock(lockPath, first, lockOptions)) return false;
  const second = lockSnapshot(lockPath);
  if (!sameLockSnapshot(first, second)) return false;
  try {
    retryWindowsFileOperation(
      () => fs.unlinkSync(lockPath),
      {
        attempts: lockOptions.fileOperationAttempts,
        retryMinMs: lockOptions.fileOperationRetryMinMs,
        retryMaxMs: lockOptions.fileOperationRetryMaxMs,
        sleep: lockOptions.sleep,
        enoentIsSuccess: true
      }
    );
    if (second?.record?.token) RELEASED_LOCK_TOKENS.delete(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireRecordLock(lockPath, lockOptions) {
  const startedAt = Date.now();
  let retryAttempt = 0;
  while (true) {
    let handle = null;
    const token = crypto.randomUUID();
    try {
      handle = fs.openSync(lockPath, "wx", 0o600);
      const metadata = {
        schema_version: 1,
        pid: process.pid,
        token,
        created_at_ms: Date.now(),
        released: false
      };
      fs.writeFileSync(handle, `${JSON.stringify(metadata)}\n`, "utf8");
      fs.fsyncSync(handle);
      return { handle, token, metadata };
    } catch (error) {
      if (handle != null) {
        try {
          fs.closeSync(handle);
        } catch {}
        try {
          retryWindowsFileOperation(
            () => fs.unlinkSync(lockPath),
            {
              attempts: lockOptions.fileOperationAttempts,
              retryMinMs: lockOptions.fileOperationRetryMinMs,
              retryMaxMs: lockOptions.fileOperationRetryMaxMs,
              sleep: lockOptions.sleep,
              enoentIsSuccess: true
            }
          );
        } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
      if (tryReclaimRecordLock(lockPath, lockOptions)) continue;
      if (Date.now() - startedAt >= lockOptions.acquireTimeoutMs) {
        throw journalError(
          "CHAT_ACTION_JOURNAL_BUSY",
          "The Boss chat action journal record remained locked after bounded waiting; outbound action must fail closed.",
          {
            lock_path: lockPath,
            waited_ms: Date.now() - startedAt
          }
        );
      }
      retryAttempt += 1;
      lockOptions.sleep(retryDelay(
        retryAttempt,
        lockOptions.retryMinMs,
        lockOptions.retryMaxMs
      ));
    }
  }
}

function releaseRecordLock(lockPath, lockOwner, lockOptions) {
  const handle = lockOwner?.handle ?? null;
  let releasedMarkerWritten = false;
  try {
    if (handle != null) {
      try {
        fs.ftruncateSync(handle, 0);
        fs.writeSync(handle, `${JSON.stringify({
          ...lockOwner.metadata,
          released: true,
          released_at_ms: Date.now()
        })}\n`, 0, "utf8");
        fs.fsyncSync(handle);
        releasedMarkerWritten = true;
      } catch {
        // The process-local token still proves ownership for a later retry.
        if (lockOwner?.token) RELEASED_LOCK_TOKENS.set(lockPath, lockOwner.token);
      }
      fs.closeSync(handle);
    }
  } finally {
    try {
      retryWindowsFileOperation(
        () => fs.unlinkSync(lockPath),
        {
          attempts: lockOptions.fileOperationAttempts,
          retryMinMs: lockOptions.fileOperationRetryMinMs,
          retryMaxMs: lockOptions.fileOperationRetryMaxMs,
          sleep: lockOptions.sleep,
          enoentIsSuccess: true
        }
      );
      RELEASED_LOCK_TOKENS.delete(lockPath);
    } catch {
      // A released marker (and process-local token) makes the leftover lock
      // safely reclaimable by the next writer. The committed journal update
      // must not be converted into a global failure by Windows/AV cleanup lag.
      if (releasedMarkerWritten) RELEASED_LOCK_TOKENS.delete(lockPath);
    }
  }
}

function outcomeUnknownOrigin(record) {
  const history = Array.isArray(record?.history) ? record.history : [];
  const last = history[history.length - 1];
  return last?.state === "outcome_unknown" ? last.from_state : null;
}

function isAllowedTransition(record, nextState) {
  if (!record) return nextState === INITIAL_STATE;
  if (record.state === nextState) return true;
  if (record.state === "outcome_unknown") {
    const origin = outcomeUnknownOrigin(record);
    return (
      (
        origin === "greeting_send_in_flight"
        && ["greeting_assumed_sent", "greeting_confirmed"].includes(nextState)
      )
      || (origin === "request_in_flight" && nextState === "request_confirmed")
    );
  }
  return ALLOWED_TRANSITIONS[record.state]?.has(nextState) === true;
}

function validateStoredRecord(record, identity, filePath) {
  const valid = (
    record.schema_version === CHAT_ACTION_JOURNAL_SCHEMA_VERSION
    && record.action_key === identity.actionKey
    && record.scope_sha256 === identity.scopeSha256
    && record.candidate_id === identity.candidateId
    && CHAT_ACTION_STATE_SET.has(record.state)
    && typeof record.greeting_sha256 === "string"
    && record.greeting_sha256.length === 64
    && Array.isArray(record.history)
  );
  if (!valid) {
    throw journalError(
      "CHAT_ACTION_JOURNAL_IDENTITY_MISMATCH",
      "Boss chat action journal record identity or schema does not match the requested candidate.",
      { file_path: filePath }
    );
  }
  return record;
}

function appendRunId(runIds, runId) {
  const normalized = normalizeText(runId);
  const current = Array.isArray(runIds) ? runIds.filter(Boolean) : [];
  if (!normalized || current.includes(normalized)) return current;
  return [...current, normalized];
}

const EVIDENCE_KEYS = new Set([
  "action",
  "action_hit_test_attempt_count",
  "action_hit_test_last_hit_backend_node_id",
  "action_hit_test_reason",
  "active_candidate_id",
  "assumption_policy",
  "ask_error",
  "ask_ok",
  "confirmation_status",
  "confirm_confirmed",
  "confirm_error",
  "control_backend_node_id",
  "control_center_x",
  "control_center_y",
  "control_label",
  "control_node_id",
  "control_root_backend_node_id",
  "control_root_node_id",
  "control_rect_height",
  "control_rect_width",
  "control_rect_x",
  "control_rect_y",
  "control_root",
  "greeting_baseline_count",
  "greeting_evidence_readable",
  "message_observed",
  "operation_id",
  "pre_input_cdp_method",
  "protected_from_replay",
  "request_confirmation_source",
  "request_ready_state_observed",
  "reason",
  "request_after_count",
  "request_baseline_count",
  "resume_attachment_after_count",
  "resume_attachment_baseline_count",
  "send_method",
  "input_dispatched"
]);

function sanitizeEvidence(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!EVIDENCE_KEYS.has(key)) continue;
    if (typeof raw === "boolean" || typeof raw === "number" || raw === null) {
      result[key] = raw;
      continue;
    }
    if (typeof raw === "string") result[key] = raw.slice(0, 240);
  }
  return result;
}

function recordRevision(record) {
  if (!record) return 0;
  const historyLength = Array.isArray(record.history) ? record.history.length : 0;
  const storedRevision = record.revision;
  if (storedRevision == null) return historyLength;
  const normalizedRevision = Number(storedRevision);
  if (
    !Number.isSafeInteger(normalizedRevision)
    || normalizedRevision < 1
    || normalizedRevision !== historyLength
  ) {
    throw journalError(
      "CHAT_ACTION_JOURNAL_CORRUPT",
      "Boss chat action journal revision does not exactly match its append-only history.",
      {
        stored_revision: storedRevision,
        history_length: historyLength
      }
    );
  }
  return normalizedRevision;
}

function withRecordRevision(record) {
  if (!record) return null;
  return {
    ...record,
    revision: recordRevision(record)
  };
}

export function hashChatActionGreeting(greeting) {
  const normalized = normalizeGreeting(greeting);
  if (!normalized) {
    throw journalError(
      "CHAT_ACTION_GREETING_REQUIRED",
      "A non-empty greeting is required to initialize a Boss chat outbound action journal record."
    );
  }
  return sha256(`boss-chat-greeting-v1\u0000${normalized}`);
}

export function createChatActionIdentity({ scope, candidateId } = {}) {
  const normalizedScope = requireScope(scope);
  const normalizedCandidateId = requireCandidateId(candidateId);
  const scopeSha256 = sha256(`boss-chat-scope-v1\u0000${normalizedScope}`);
  const actionKey = sha256(
    `boss-chat-request-cv-v1\u0000${normalizedScope}\u0000${normalizedCandidateId}`
  );
  return {
    actionKey,
    scopeSha256,
    candidateId: normalizedCandidateId
  };
}

export function createChatActionJournal({
  baseDir = defaultBaseDir(),
  now = () => new Date(),
  lockOptions = {}
} = {}) {
  const resolvedBaseDir = path.resolve(normalizeText(baseDir) || defaultBaseDir());
  if (typeof now !== "function") {
    throw journalError(
      "CHAT_ACTION_JOURNAL_CLOCK_INVALID",
      "Boss chat action journal now must be a function."
    );
  }
  const resolvedLockOptions = normalizeLockOptions(lockOptions);

  function entryPath(input = {}) {
    const identity = createChatActionIdentity(input);
    return path.join(resolvedBaseDir, `${identity.actionKey}.json`);
  }

  function read(input = {}) {
    const identity = createChatActionIdentity(input);
    const filePath = path.join(resolvedBaseDir, `${identity.actionKey}.json`);
    const stored = readJsonRecord(filePath);
    if (!stored) return null;
    return cloneRecord(withRecordRevision(validateStoredRecord(stored, identity, filePath)));
  }

  function transition({
    scope,
    candidateId,
    state,
    runId = "",
    greeting,
    evidence = {},
    recordIdempotent = false,
    expectedUpdatedAt = null,
    expectedRevision = null
  } = {}) {
    const identity = createChatActionIdentity({ scope, candidateId });
    const nextState = requireState(state);
    const filePath = path.join(resolvedBaseDir, `${identity.actionKey}.json`);
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(resolvedBaseDir, { recursive: true });
    const lockHandle = acquireRecordLock(lockPath, resolvedLockOptions);
    try {
      const stored = readJsonRecord(filePath);
      const existing = stored
        ? withRecordRevision(validateStoredRecord(stored, identity, filePath))
        : null;
      const observedRevision = recordRevision(existing);
      if (expectedRevision != null) {
        const normalizedExpectedRevision = Number(expectedRevision);
        if (!Number.isSafeInteger(normalizedExpectedRevision) || normalizedExpectedRevision < 0) {
          throw journalError(
            "CHAT_ACTION_JOURNAL_REVISION_INVALID",
            "Boss action journal expected revision must be a non-negative safe integer.",
            { expected_revision: expectedRevision }
          );
        }
        if (observedRevision !== normalizedExpectedRevision) {
          throw journalError(
            "CHAT_ACTION_JOURNAL_CONCURRENT_UPDATE",
            "Boss action journal changed after it was read; this operation does not own the outbound action.",
            {
              action_key: identity.actionKey,
              expected_revision: normalizedExpectedRevision,
              observed_revision: observedRevision,
              expected_updated_at: normalizeText(expectedUpdatedAt) || null,
              observed_updated_at: normalizeText(existing?.updated_at) || null
            }
          );
        }
      }
      if (
        expectedUpdatedAt != null
        && normalizeText(existing?.updated_at) !== normalizeText(expectedUpdatedAt)
      ) {
        throw journalError(
          "CHAT_ACTION_JOURNAL_CONCURRENT_UPDATE",
          "Boss action journal changed after it was read; this operation does not own the outbound action.",
          {
            action_key: identity.actionKey,
            expected_updated_at: normalizeText(expectedUpdatedAt) || null,
            observed_updated_at: normalizeText(existing?.updated_at) || null
          }
        );
      }
      const suppliedGreeting = greeting == null ? "" : normalizeGreeting(greeting);
      const suppliedGreetingSha256 = suppliedGreeting ? hashChatActionGreeting(suppliedGreeting) : "";

      if (!existing && !suppliedGreetingSha256) {
        throw journalError(
          "CHAT_ACTION_GREETING_REQUIRED",
          "The initial Boss chat action journal transition must include the greeting to hash."
        );
      }
      if (
        existing
        && suppliedGreetingSha256
        && suppliedGreetingSha256 !== existing.greeting_sha256
      ) {
        throw journalError(
          "CHAT_ACTION_GREETING_HASH_CONFLICT",
          "The greeting does not match the greeting already journaled for this candidate.",
          { action_key: identity.actionKey }
        );
      }
      if (!isAllowedTransition(existing, nextState)) {
        throw journalError(
          "CHAT_ACTION_TRANSITION_INVALID",
          `Invalid Boss chat action journal transition: ${existing?.state || "<none>"} -> ${nextState}.`,
          {
            action_key: identity.actionKey,
            current_state: existing?.state || null,
            requested_state: nextState
          }
        );
      }
      if (existing?.state === nextState && recordIdempotent !== true) {
        return {
          changed: false,
          idempotent: true,
          file_path: filePath,
          record: cloneRecord(existing)
        };
      }

      const at = nowIso(now);
      const normalizedRunId = normalizeText(runId);
      const safeEvidence = sanitizeEvidence(evidence);
      const record = existing ? {
        ...existing,
        state: nextState,
        revision: observedRevision + 1,
        updated_at: at,
        evidence: {
          ...(existing.evidence && typeof existing.evidence === "object" ? existing.evidence : {}),
          ...safeEvidence
        },
        last_run_id: normalizedRunId || existing.last_run_id || null,
        run_ids: appendRunId(existing.run_ids, normalizedRunId),
        history: [
          ...existing.history,
          {
            from_state: existing.state,
            state: nextState,
            at,
            run_id: normalizedRunId || null,
            evidence: safeEvidence
          }
        ]
      } : {
        schema_version: CHAT_ACTION_JOURNAL_SCHEMA_VERSION,
        action_key: identity.actionKey,
        scope_sha256: identity.scopeSha256,
        candidate_id: identity.candidateId,
        state: nextState,
        revision: 1,
        greeting_sha256: suppliedGreetingSha256,
        evidence: safeEvidence,
        created_at: at,
        updated_at: at,
        first_run_id: normalizedRunId || null,
        last_run_id: normalizedRunId || null,
        run_ids: appendRunId([], normalizedRunId),
        history: [{
          from_state: null,
          state: nextState,
          at,
          run_id: normalizedRunId || null,
          evidence: safeEvidence
        }]
      };
      writeJsonAtomic(filePath, record, resolvedLockOptions);
      return {
        changed: true,
        idempotent: false,
        file_path: filePath,
        record: cloneRecord(record)
      };
    } finally {
      releaseRecordLock(lockPath, lockHandle, resolvedLockOptions);
    }
  }

  return Object.freeze({
    base_dir: resolvedBaseDir,
    entryPath,
    read,
    transition
  });
}
