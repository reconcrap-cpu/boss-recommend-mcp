import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CHAT_ACTION_JOURNAL_SCHEMA_VERSION = 1;

export const CHAT_ACTION_STATES = Object.freeze([
  "pre_action",
  "greeting_send_in_flight",
  "greeting_confirmed",
  "request_in_flight",
  "request_confirmed",
  "outcome_unknown"
]);

const CHAT_ACTION_STATE_SET = new Set(CHAT_ACTION_STATES);
const INITIAL_STATE = "pre_action";
const ALLOWED_TRANSITIONS = Object.freeze({
  pre_action: new Set(["greeting_send_in_flight"]),
  greeting_send_in_flight: new Set(["greeting_confirmed", "outcome_unknown"]),
  greeting_confirmed: new Set(["request_in_flight"]),
  request_in_flight: new Set(["request_confirmed", "outcome_unknown"]),
  request_confirmed: new Set(),
  outcome_unknown: new Set(["greeting_confirmed", "request_confirmed"])
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

function writeJsonAtomic(filePath, payload) {
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
    fs.renameSync(tempPath, filePath);

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
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // A leftover temp file is never treated as a committed journal record.
    }
  }
}

function acquireRecordLock(lockPath) {
  let handle = null;
  try {
    handle = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(handle, `${process.pid}\n`, "utf8");
    fs.fsyncSync(handle);
    return handle;
  } catch (error) {
    if (handle != null) {
      try {
        fs.closeSync(handle);
      } catch {}
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
    if (error?.code === "EEXIST") {
      throw journalError(
        "CHAT_ACTION_JOURNAL_BUSY",
        "The Boss chat action journal record is locked by another writer; outbound action must fail closed.",
        { lock_path: lockPath }
      );
    }
    throw error;
  }
}

function releaseRecordLock(lockPath, handle) {
  try {
    if (handle != null) fs.closeSync(handle);
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
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
      (origin === "greeting_send_in_flight" && nextState === "greeting_confirmed")
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
  "active_candidate_id",
  "ask_error",
  "ask_ok",
  "confirm_confirmed",
  "confirm_error",
  "greeting_baseline_count",
  "greeting_evidence_readable",
  "message_observed",
  "request_confirmation_source",
  "request_ready_state_observed",
  "reason",
  "request_after_count",
  "request_baseline_count",
  "resume_attachment_after_count",
  "resume_attachment_baseline_count",
  "send_method"
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
  now = () => new Date()
} = {}) {
  const resolvedBaseDir = path.resolve(normalizeText(baseDir) || defaultBaseDir());
  if (typeof now !== "function") {
    throw journalError(
      "CHAT_ACTION_JOURNAL_CLOCK_INVALID",
      "Boss chat action journal now must be a function."
    );
  }

  function entryPath(input = {}) {
    const identity = createChatActionIdentity(input);
    return path.join(resolvedBaseDir, `${identity.actionKey}.json`);
  }

  function read(input = {}) {
    const identity = createChatActionIdentity(input);
    const filePath = path.join(resolvedBaseDir, `${identity.actionKey}.json`);
    const stored = readJsonRecord(filePath);
    if (!stored) return null;
    return cloneRecord(validateStoredRecord(stored, identity, filePath));
  }

  function transition({
    scope,
    candidateId,
    state,
    runId = "",
    greeting,
    evidence = {}
  } = {}) {
    const identity = createChatActionIdentity({ scope, candidateId });
    const nextState = requireState(state);
    const filePath = path.join(resolvedBaseDir, `${identity.actionKey}.json`);
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(resolvedBaseDir, { recursive: true });
    const lockHandle = acquireRecordLock(lockPath);
    try {
      const stored = readJsonRecord(filePath);
      const existing = stored ? validateStoredRecord(stored, identity, filePath) : null;
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
      if (existing?.state === nextState) {
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
      writeJsonAtomic(filePath, record);
      return {
        changed: true,
        idempotent: false,
        file_path: filePath,
        record: cloneRecord(record)
      };
    } finally {
      releaseRecordLock(lockPath, lockHandle);
    }
  }

  return Object.freeze({
    base_dir: resolvedBaseDir,
    entryPath,
    read,
    transition
  });
}
