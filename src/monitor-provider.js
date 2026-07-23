import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  assertEventPageV1,
  assertProviderDescriptorV1,
  assertRunCommandResultV1,
  assertRunPageV1,
  assertRunSnapshotV1
} from "@reconcrap/recruiting-run-monitor-contract";
import {
  BOSS_MONITOR_CONTRACT_VERSION,
  BOSS_MONITOR_KINDS,
  BOSS_MONITOR_PROVIDER,
  createBossMonitoringBlock,
  getBossMonitorRunDir,
  getBossMonitorV1Root,
  writeBossMonitorProjectionNonfatal
} from "./monitor/projection.js";
import {
  getCandidateResultJournalPath,
  readCandidateResultJournal
} from "./core/run/candidate-result-journal.js";

const VALID_KINDS = new Set(BOSS_MONITOR_KINDS);
const VALID_COMMANDS = new Set(["pause", "resume", "cancel"]);
const MAX_EVENT_LIMIT = 1_000;
const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_RAW_OUTPUT_BYTES = 2 * 1024 * 1024;
const EVIDENCE_ID_PATTERN = /^[a-f0-9]{32}$/;
const COMMAND_LOCK_RETRY_MS = 20;
const COMMAND_LOCK_TIMEOUT_MS = 15_000;
const COMMAND_LOCK_STALE_MS = 30_000;
const COMMAND_LOCK_INVALID_GRACE_MS = 2_000;

function normalizeText(value, maxLength = 4_000) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, maxLength) : "";
}

function redactFilesystemPaths(value, maxLength = 2_000) {
  let text = normalizeText(value, maxLength * 2);
  const configuredRoots = [
    process.env.BOSS_RECOMMEND_HOME,
    process.env.BOSS_RECRUIT_HOME,
    process.env.BOSS_MONITOR_HOME,
    process.env.RECRUITING_MONITOR_HOME,
    os.homedir()
  ].map((entry) => normalizeText(entry, 8_000)).filter(Boolean);
  for (const root of configuredRoots.sort((left, right) => right.length - left.length)) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escaped, "gi"), "[redacted-path]");
  }
  text = text
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/g, "[redacted-path]")
    .replace(/\\\\[^\\\s]+\\[^\s"'<>]*/g, "[redacted-path]")
    .replace(/\/(?:Users|home|tmp|var\/tmp)\/[^\s"'<>]*/g, "[redacted-path]");
  return normalizeText(text, maxLength);
}

function sanitizeProviderError(error) {
  const original = error && typeof error === "object" ? error : null;
  const message = redactFilesystemPaths(original?.message || error || "Boss provider request failed.");
  let sanitized = original;
  try {
    if (sanitized) sanitized.message = message;
  } catch {
    sanitized = null;
  }
  if (!sanitized || sanitized.message !== message) {
    sanitized = new Error(message);
    if (original?.name) sanitized.name = original.name;
    if (original?.code) sanitized.code = original.code;
    if (original?.ref) sanitized.ref = original.ref;
  }
  if (sanitized?.code === "EVIDENCE_UNAVAILABLE") sanitized.statusCode = 404;
  else if (Number.isInteger(original?.statusCode)) sanitized.statusCode = original.statusCode;
  return sanitized;
}

function sanitizeCommandResultMessages(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeCommandResultMessages(entry, key));
  }
  if (!value || typeof value !== "object") {
    if (
      typeof value === "string"
      && (key === "message" || key === "error" || key.endsWith("_message"))
    ) {
      return redactFilesystemPaths(value);
    }
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entry]) => [
      entryKey,
      sanitizeCommandResultMessages(entry, entryKey.toLowerCase())
    ])
  );
}

function normalizeRunId(value) {
  const normalized = normalizeText(value, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function normalizeKind(value) {
  const normalized = normalizeText(value, 32).toLowerCase();
  return normalized === "recruit" ? "search" : VALID_KINDS.has(normalized) ? normalized : "";
}

function assertRef(ref) {
  const provider = normalizeText(ref?.provider || BOSS_MONITOR_PROVIDER, 32).toLowerCase();
  const kind = normalizeKind(ref?.kind);
  const runId = normalizeRunId(ref?.run_id || ref?.runId);
  if (provider !== BOSS_MONITOR_PROVIDER || !kind || !runId) {
    const error = new Error("Invalid Boss monitoring run reference");
    error.code = "INVALID_RUN_REF";
    throw error;
  }
  return { provider, kind, run_id: runId };
}

function readJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The unique temp file may not have been created.
    }
    throw error;
  }
}

function isPidAlive(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  if (normalized === process.pid) return true;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(milliseconds) || 0));
  });
}

function lockOwnerMatches(lockPath, nonce) {
  const owner = readJson(lockPath);
  return Boolean(owner?.nonce && owner.nonce === nonce);
}

async function acquireCommandRunLock(commandDir) {
  fs.mkdirSync(commandDir, { recursive: true });
  const lockPath = path.join(commandDir, ".run.lock");
  const nonce = crypto.randomBytes(18).toString("base64url");
  const startedAt = Date.now();

  while (Date.now() - startedAt < COMMAND_LOCK_TIMEOUT_MS) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      const owner = {
        schema_version: 1,
        nonce,
        pid: process.pid,
        acquired_at: new Date().toISOString()
      };
      fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      const lease = setInterval(() => {
        try {
          if (!lockOwnerMatches(lockPath, nonce)) return;
          const now = new Date();
          fs.utimesSync(lockPath, now, now);
        } catch {
          // Losing the lease will be detected by the nonce check on release.
        }
      }, Math.max(1_000, Math.floor(COMMAND_LOCK_STALE_MS / 3)));
      lease.unref?.();

      return () => {
        clearInterval(lease);
        try {
          if (lockOwnerMatches(lockPath, nonce)) fs.unlinkSync(lockPath);
        } catch {
          // A stale-lock recovery or process cleanup may already have removed it.
        }
      };
    } catch (error) {
      if (fd !== null) {
        let fdStat = null;
        try {
          fdStat = fs.fstatSync(fd);
        } catch {
          // The descriptor may already be unusable after a failed write.
        }
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore cleanup errors while preserving the original failure.
        }
        try {
          const pathStat = fs.statSync(lockPath);
          const sameFile = fdStat
            && fdStat.dev === pathStat.dev
            && fdStat.ino === pathStat.ino;
          if (lockOwnerMatches(lockPath, nonce) || sameFile) fs.unlinkSync(lockPath);
        } catch {
          // The lock may not have reached a readable owner record.
        }
      }
      if (error?.code !== "EEXIST") throw error;
    }

    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
      const owner = readJson(lockPath);
      const validOwner = Boolean(
        owner
        && typeof owner.nonce === "string"
        && owner.nonce
        && Number.isInteger(Number(owner.pid))
      );
      const abandonedOwner = validOwner
        ? !isPidAlive(owner.pid) && ageMs > COMMAND_LOCK_INVALID_GRACE_MS
        : ageMs > COMMAND_LOCK_STALE_MS;
      if (abandonedOwner) {
        fs.unlinkSync(lockPath);
        continue;
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
    }
    await delay(COMMAND_LOCK_RETRY_MS);
  }

  const error = new Error("Timed out acquiring Boss monitor command lock");
  error.code = "COMMAND_IN_PROGRESS";
  throw error;
}

function runPaths(ref) {
  const runDir = getBossMonitorRunDir(ref.kind, ref.run_id);
  return {
    runDir,
    snapshot: path.join(runDir, "snapshot.json"),
    events: path.join(runDir, "events.ndjson"),
    evidenceIndex: path.join(runDir, ".evidence-index.json"),
    evidenceDir: path.join(runDir, ".evidence"),
    commandDir: path.join(runDir, ".commands")
  };
}

function runNotFound(ref) {
  const error = new Error(`No Boss monitor projection found for ${ref.kind}/${ref.run_id}`);
  error.code = "RUN_NOT_FOUND";
  error.ref = ref;
  return error;
}

function withObservedLiveness(snapshot, runDir) {
  if (!snapshot) return snapshot;
  const heartbeatAt = Date.parse(snapshot?.liveness?.heartbeat_at || "");
  const ageMs = Number.isFinite(heartbeatAt) ? Math.max(0, Date.now() - heartbeatAt) : null;
  const staleAfterMs = Math.max(1_000, Number(snapshot?.liveness?.stale_after_ms) || 20_000);
  const exit = readJson(path.join(runDir, "worker-exit.json"));
  const sameWorkerExited = Boolean(
    exit
    && exit.worker_instance_id
    && exit.worker_instance_id === snapshot?.liveness?.worker_instance_id
  );
  const terminal = ["completed", "failed", "canceled"].includes(snapshot.state);
  return {
    ...snapshot,
    liveness: {
      ...snapshot.liveness,
      status: terminal || sameWorkerExited
        ? "exited"
        : ageMs !== null && ageMs > staleAfterMs
          ? "stale"
          : "alive",
      observed_at: new Date().toISOString(),
      ...(ageMs === null ? {} : { update_age_ms: ageMs }),
      ...(sameWorkerExited
        ? {
            exit: {
              at: exit.exited_at || new Date().toISOString(),
              ...(Number.isInteger(exit.exit_code) ? { code: exit.exit_code } : {}),
              ...(normalizeText(exit.signal || "", 64) ? { signal: normalizeText(exit.signal, 64) } : {})
            }
          }
        : {})
    }
  };
}

function parseEvents(filePath, afterSeq, limit) {
  if (!fs.existsSync(filePath)) return [];
  const events = [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (Number(event?.seq) <= afterSeq) continue;
    events.push(event);
    if (events.length >= limit) break;
  }
  return events;
}

function toRunSummary(snapshot) {
  return {
    ref: snapshot.ref,
    revision: snapshot.revision,
    last_event_seq: snapshot.last_event_seq,
    state: snapshot.state,
    stage: snapshot.stage,
    condition: snapshot.condition,
    timestamps: snapshot.timestamps,
    liveness: snapshot.liveness,
    goal: snapshot.goal,
    counters: snapshot.counters,
    controls: snapshot.controls,
    ...(snapshot.current_candidate ? { current_candidate: snapshot.current_candidate } : {}),
    ...(snapshot.last_candidate ? { last_candidate: snapshot.last_candidate } : {}),
    errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
    ...(snapshot.extensions ? { extensions: snapshot.extensions } : {})
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("Watch aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    let timer;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onTimer = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      const error = new Error("Watch aborted");
      error.name = "AbortError";
      reject(error);
    };
    timer = setTimeout(onTimer, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function configuredArtifactRoots() {
  const values = [
    process.env.BOSS_RECOMMEND_HOME,
    process.env.BOSS_RECRUIT_HOME,
    ...(normalizeText(process.env.BOSS_MONITOR_ARTIFACT_ROOTS || "")
      ? process.env.BOSS_MONITOR_ARTIFACT_ROOTS.split(path.delimiter)
      : [])
  ].filter(Boolean);
  if (!values.length) {
    values.push(
      path.join(os.homedir(), ".boss-recommend-mcp"),
      path.join(os.homedir(), ".boss-recruit-mcp")
    );
  }
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function isInsideRoot(filePath, rootPath) {
  const relative = path.relative(rootPath, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveSafeArtifactPath(sourcePath) {
  const requested = path.resolve(normalizeText(sourcePath, 8_000));
  if (!fs.existsSync(requested)) {
    const error = new Error("Evidence is no longer available");
    error.code = "EVIDENCE_UNAVAILABLE";
    throw error;
  }
  const real = fs.realpathSync.native(requested);
  const roots = configuredArtifactRoots()
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync.native(root));
  if (!roots.some((root) => isInsideRoot(real, root))) {
    const error = new Error("Evidence path is outside configured Boss artifact roots");
    error.code = "EVIDENCE_PATH_REJECTED";
    throw error;
  }
  return real;
}

function normalizeEvidenceId(value) {
  const evidenceId = String(value ?? "");
  if (!EVIDENCE_ID_PATTERN.test(evidenceId)) {
    const error = new Error("Evidence ID must be exactly 32 lowercase hexadecimal characters");
    error.code = "INVALID_EVIDENCE_ID";
    throw error;
  }
  return evidenceId;
}

function resolveEvidenceLocatorPath(evidenceDir, evidenceId) {
  const root = path.resolve(evidenceDir);
  const locatorPath = path.resolve(root, `${evidenceId}.json`);
  if (locatorPath === root || !isInsideRoot(locatorPath, root)) {
    const error = new Error("Evidence locator is outside the Boss monitor run");
    error.code = "EVIDENCE_PATH_REJECTED";
    throw error;
  }

  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return locatorPath;
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    const error = new Error("Evidence locator root is invalid");
    error.code = "EVIDENCE_PATH_REJECTED";
    throw error;
  }
  let locatorStat;
  try {
    locatorStat = fs.lstatSync(locatorPath);
  } catch (error) {
    if (error?.code === "ENOENT") return locatorPath;
    throw error;
  }
  if (!locatorStat.isFile() || locatorStat.isSymbolicLink()) {
    const error = new Error("Evidence locator is invalid");
    error.code = "EVIDENCE_PATH_REJECTED";
    throw error;
  }
  const realRoot = fs.realpathSync.native(root);
  const realLocator = fs.realpathSync.native(locatorPath);
  if (!isInsideRoot(realLocator, realRoot)) {
    const error = new Error("Evidence locator is outside the Boss monitor run");
    error.code = "EVIDENCE_PATH_REJECTED";
    throw error;
  }
  return realLocator;
}

function detectImageType(filePath) {
  const fd = fs.openSync(filePath, "r");
  const header = Buffer.alloc(16);
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const bytes = header.subarray(0, bytesRead);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  const error = new Error("Evidence image type is not allowed");
  error.code = "EVIDENCE_MIME_REJECTED";
  throw error;
}

function candidateRefFor(result, index) {
  return normalizeText(
    result?.candidate_key
    || result?.key
    || result?.candidate?.id
    || result?.id
    || `candidate-${result?.index ?? index}`,
    220
  );
}

function findCandidate(checkpoint, candidateRef, resultIndex) {
  const results = Array.isArray(checkpoint?.results)
    ? checkpoint.results
    : Array.isArray(checkpoint?.summary?.results)
      ? checkpoint.summary.results
      : [];
  if (
    Number.isInteger(resultIndex)
    && results[resultIndex]
    && candidateRefFor(results[resultIndex], resultIndex) === candidateRef
  ) {
    return results[resultIndex];
  }
  return results.find((result, index) => candidateRefFor(result, index) === candidateRef) || null;
}

function findJournalCandidate(journal, candidateRef, resultIndex) {
  const records = Array.isArray(journal?.records) ? journal.records : [];
  const hasResultIndex = Number.isSafeInteger(resultIndex) && resultIndex >= 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || typeof record !== "object") continue;
    if (hasResultIndex && record.result_index !== resultIndex) continue;
    const recordCandidateRef = normalizeText(record.candidate_key, 220);
    const resultCandidateRef = candidateRefFor(record.result, record.result_index);
    if (recordCandidateRef === candidateRef || resultCandidateRef === candidateRef) {
      return record.result;
    }
  }
  return null;
}

function collectRawModelFields(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectRawModelFields(item, output, seen);
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (["raw_model_output", "reasoning_content", "cot"].includes(key)) {
      const text = normalizeText(entry, MAX_RAW_OUTPUT_BYTES);
      if (text) output.push({ field: key, text });
    } else if (entry && typeof entry === "object") {
      collectRawModelFields(entry, output, seen);
    }
  }
  return output;
}

function rawModelEvidence(candidate) {
  const fields = collectRawModelFields(candidate);
  if (!fields.length) {
    const error = new Error("Model output is no longer available");
    error.code = "EVIDENCE_UNAVAILABLE";
    throw error;
  }
  const text = fields.map(({ field, text: value }) => `[${field}]\n${value}`).join("\n\n")
    .slice(0, MAX_RAW_OUTPUT_BYTES);
  return {
    content_type: "text/plain",
    content_length: Buffer.byteLength(text, "utf8"),
    stream: Readable.from([Buffer.from(text, "utf8")])
  };
}

function readJournalCandidate(sourcePath, ref, candidateRef, resultIndex) {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > MAX_CHECKPOINT_BYTES) {
    const error = new Error("Evidence journal is unavailable or too large");
    error.code = "EVIDENCE_UNAVAILABLE";
    throw error;
  }
  try {
    const runDir = path.dirname(sourcePath);
    const expectedPath = getCandidateResultJournalPath({
      runDir,
      runId: ref.run_id
    });
    if (path.relative(path.resolve(expectedPath), path.resolve(sourcePath)) !== "") {
      const error = new Error("Evidence journal does not match the requested run");
      error.code = "EVIDENCE_UNAVAILABLE";
      throw error;
    }
    const journal = readCandidateResultJournal({
      runDir,
      runId: ref.run_id
    });
    const candidate = findJournalCandidate(journal, candidateRef, resultIndex);
    if (!candidate) {
      const error = new Error("Model output is no longer available");
      error.code = "EVIDENCE_UNAVAILABLE";
      throw error;
    }
    return candidate;
  } catch (error) {
    if (error?.code === "EVIDENCE_UNAVAILABLE") throw error;
    const unavailable = new Error("Evidence journal is unavailable");
    unavailable.code = "EVIDENCE_UNAVAILABLE";
    throw unavailable;
  }
}

async function loadLegacyWorkflowModule(kind) {
  if (kind === "recommend") return import("./recommend-mcp.js");
  if (kind === "search") return import("./recruit-mcp.js");
  if (kind === "chat") return import("./chat-mcp.js");
  const error = new Error(`Unsupported Boss workflow kind: ${kind}`);
  error.code = "COMMAND_NOT_SUPPORTED";
  throw error;
}

async function executeLegacyCommand(ref, command, moduleLoader = loadLegacyWorkflowModule) {
  const args = { run_id: ref.run_id };
  const module = await moduleLoader(ref.kind);
  let tool;
  if (ref.kind === "recommend") {
    tool = {
      pause: module.pauseRecommendPipelineRunTool,
      resume: module.resumeRecommendPipelineRunTool,
      cancel: module.cancelRecommendPipelineRunTool
    }[command];
  } else if (ref.kind === "search") {
    tool = {
      pause: module.pauseRecruitPipelineRunTool,
      resume: module.resumeRecruitPipelineRunTool,
      cancel: module.cancelRecruitPipelineRunTool
    }[command];
  } else {
    tool = {
      pause: module.pauseBossChatRunTool,
      resume: module.resumeBossChatRunTool,
      cancel: module.cancelBossChatRunTool
    }[command];
  }
  if (typeof tool !== "function") {
    const error = new Error(`Boss ${ref.kind} does not implement the ${command} command`);
    error.code = "COMMAND_NOT_SUPPORTED";
    throw error;
  }
  return tool({ args });
}

function commandResultFromLegacy(ref, command, idempotencyKey, legacy, snapshot) {
  const failed = legacy?.status === "FAILED";
  return sanitizeCommandResultMessages({
    contract: "recruiting-run-monitor",
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    schema: "run_command_result",
    schema_version: 1,
    ref,
    command,
    idempotency_key: idempotencyKey,
    status: failed ? "rejected" : "accepted",
    revision: snapshot.revision,
    ...(redactFilesystemPaths(legacy?.message || legacy?.error?.message || "", 1_000)
      ? { message: redactFilesystemPaths(legacy?.message || legacy?.error?.message, 1_000) }
      : {}),
    snapshot
  });
}

function commandRequestFingerprint(ref, command, expectedRevision) {
  return crypto.createHash("sha256").update(JSON.stringify({
    ref,
    command,
    expected_revision: Number.isInteger(expectedRevision) && expectedRevision >= 0
      ? expectedRevision
      : null
  })).digest("hex");
}

function commandRequestRecord(ref, command, idempotencyKey, expectedRevision, fingerprint) {
  return {
    schema_version: 1,
    ref,
    command,
    idempotency_key: idempotencyKey,
    expected_revision: Number.isInteger(expectedRevision) && expectedRevision >= 0
      ? expectedRevision
      : null,
    fingerprint,
    recorded_at: new Date().toISOString()
  };
}

function commandRevisionClaimPath(commandDir, revision) {
  if (!Number.isInteger(revision) || revision < 0) return "";
  return path.join(commandDir, ".revisions", `${revision}.json`);
}

function revisionClaimMatchesRequest(claim, request) {
  const expectedRevision = request?.expected_revision;
  const fingerprint = normalizeText(request?.fingerprint, 64);
  const idempotencyKey = normalizeText(request?.idempotency_key, 200);
  const command = normalizeText(request?.command, 32).toLowerCase();
  return Boolean(
    claim
    && Number.isInteger(expectedRevision)
    && expectedRevision >= 0
    && claim.revision === expectedRevision
    && fingerprint
    && normalizeText(claim.fingerprint, 64) === fingerprint
    && idempotencyKey
    && normalizeText(claim.idempotency_key, 200) === idempotencyKey
    && VALID_COMMANDS.has(command)
    && normalizeText(claim.command, 32).toLowerCase() === command
  );
}

function findUnresolvedCommandReservation(commandDir) {
  let entries;
  try {
    entries = fs.readdirSync(commandDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.request\.json$/.test(entry.name)) continue;
    const digest = entry.name.slice(0, 64);
    if (readJson(path.join(commandDir, `${digest}.json`))) continue;
    const request = readJson(path.join(commandDir, entry.name));
    const claimPath = commandRevisionClaimPath(commandDir, request?.expected_revision);
    const claim = claimPath ? readJson(claimPath) : null;
    if (revisionClaimMatchesRequest(claim, request)) return { request, claim };
  }
  return null;
}

function reservationMatchesRun(reservation, ref) {
  const request = reservation?.request;
  const reservedCommand = normalizeText(request?.command, 32).toLowerCase();
  const reservedKey = normalizeText(request?.idempotency_key, 200);
  const reservedRevision = request?.expected_revision;
  const reservedRef = request?.ref;
  const fingerprint = normalizeText(request?.fingerprint, 64);
  return Boolean(
    VALID_COMMANDS.has(reservedCommand)
    && reservedKey
    && Number.isInteger(reservedRevision)
    && reservedRevision >= 0
    && reservedRef?.provider === ref.provider
    && reservedRef?.kind === ref.kind
    && reservedRef?.run_id === ref.run_id
    && fingerprint === commandRequestFingerprint(
      ref,
      reservedCommand,
      reservedRevision
    )
    && revisionClaimMatchesRequest(reservation?.claim, request)
  );
}

function commandEffectObserved(snapshot, command) {
  const state = normalizeText(snapshot?.state, 32).toLowerCase();
  const pending = Array.isArray(snapshot?.controls?.pending)
    ? snapshot.controls.pending
    : [];
  const pendingCommand = pending.some((entry) => (
    normalizeText(entry?.command, 32).toLowerCase() === command
  ));
  if (pendingCommand) return true;
  if (command === "pause") return state === "paused";
  if (command === "resume") return state === "running";
  if (command === "cancel") return state === "canceling" || state === "canceled";
  return false;
}

function commandDuplicateResult({
  ref,
  command,
  idempotencyKey,
  snapshot
}) {
  const result = sanitizeCommandResultMessages({
    contract: "recruiting-run-monitor",
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    schema: "run_command_result",
    schema_version: 1,
    ref,
    command,
    idempotency_key: idempotencyKey,
    status: "duplicate",
    revision: Math.max(0, Number.isInteger(snapshot?.revision) ? snapshot.revision : 0),
    message: "The command effect is already visible; its interrupted durable result was recovered.",
    ...(snapshot ? { snapshot } : {})
  });
  assertRunCommandResultV1(result);
  return result;
}

function commandConflictResult({
  ref,
  command,
  idempotencyKey,
  revision,
  message,
  snapshot
}) {
  const result = sanitizeCommandResultMessages({
    contract: "recruiting-run-monitor",
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    schema: "run_command_result",
    schema_version: 1,
    ref,
    command,
    idempotency_key: idempotencyKey,
    status: "conflict",
    revision: Math.max(0, Number.isInteger(revision) ? revision : 0),
    message: redactFilesystemPaths(message, 1_000),
    ...(snapshot ? { snapshot } : {})
  });
  assertRunCommandResultV1(result);
  return result;
}

function commandRejectedResult({
  ref,
  command,
  idempotencyKey,
  revision,
  message,
  snapshot
}) {
  const result = sanitizeCommandResultMessages({
    contract: "recruiting-run-monitor",
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    schema: "run_command_result",
    schema_version: 1,
    ref,
    command,
    idempotency_key: idempotencyKey,
    status: "rejected",
    revision: Math.max(0, Number.isInteger(revision) ? revision : 0),
    message: redactFilesystemPaths(message, 1_000) || "Boss command failed.",
    ...(snapshot ? { snapshot } : {})
  });
  assertRunCommandResultV1(result);
  return result;
}

export class BossRecruitingRunProviderV1 {
  constructor({
    watchIntervalMs = 500,
    legacyModuleLoader = loadLegacyWorkflowModule
  } = {}) {
    this.watchIntervalMs = Math.max(100, Number(watchIntervalMs) || 500);
    if (typeof legacyModuleLoader !== "function") {
      throw new TypeError("legacyModuleLoader must be a function");
    }
    this.legacyModuleLoader = legacyModuleLoader;
  }

  async listRuns(input = {}) {
    const kind = normalizeKind(input.kind);
    if (!kind) {
      const error = new Error("Boss listRuns requires exactly one valid kind");
      error.code = "KIND_REQUIRED";
      throw error;
    }
    const kindRoot = path.join(getBossMonitorV1Root(), "runs", kind);
    const items = [];
    const requestedStates = Array.isArray(input.states) ? new Set(input.states) : null;
    if (fs.existsSync(kindRoot)) {
      for (const entry of fs.readdirSync(kindRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const runDir = path.join(kindRoot, entry.name);
        const snapshot = withObservedLiveness(
          readJson(path.join(runDir, "snapshot.json")),
          runDir
        );
        if (!snapshot || snapshot?.ref?.kind !== kind) continue;
        if (requestedStates && !requestedStates.has(snapshot.state)) continue;
        if (
          input.updated_after
          && Date.parse(snapshot?.timestamps?.updated_at || "") <= Date.parse(input.updated_after)
        ) continue;
        items.push(snapshot);
      }
    }
    items.sort((left, right) => (
      Date.parse(right?.timestamps?.updated_at || "")
      - Date.parse(left?.timestamps?.updated_at || "")
    ));
    const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
    const offset = Math.max(0, Number.parseInt(String(input.cursor || "0"), 10) || 0);
    const page = items.slice(offset, offset + limit);
    const stateCounts = {};
    for (const item of items) {
      stateCounts[item.state] = (stateCounts[item.state] || 0) + 1;
    }
    const result = {
      contract: "recruiting-run-monitor",
      contract_version: BOSS_MONITOR_CONTRACT_VERSION,
      schema: "run_page",
      schema_version: 1,
      provider: BOSS_MONITOR_PROVIDER,
      kind,
      observed_at: new Date().toISOString(),
      runs: page.map(toRunSummary),
      state_counts: stateCounts,
      ...(offset + page.length < items.length
        ? { next_cursor: String(offset + page.length) }
        : {})
    };
    assertRunPageV1(result);
    return result;
  }

  async getSnapshot(refInput) {
    const ref = assertRef(refInput);
    const paths = runPaths(ref);
    const snapshot = withObservedLiveness(readJson(paths.snapshot), paths.runDir);
    if (!snapshot) throw runNotFound(ref);
    assertRunSnapshotV1(snapshot);
    return snapshot;
  }

  async getEvents(refInput, afterSeq = 0, limit = 200) {
    const ref = assertRef(refInput);
    const paths = runPaths(ref);
    if (!fs.existsSync(paths.snapshot)) throw runNotFound(ref);
    const normalizedLimit = Math.min(
      MAX_EVENT_LIMIT,
      Math.max(1, Number.parseInt(String(limit), 10) || 200)
    );
    const events = parseEvents(paths.events, Math.max(0, Number(afterSeq) || 0), normalizedLimit);
    const projectedSnapshot = readJson(paths.snapshot);
    const pageLastSeq = events.length
      ? events[events.length - 1].seq
      : Math.max(0, Number(afterSeq) || 0);
    const result = {
      contract: "recruiting-run-monitor",
      contract_version: BOSS_MONITOR_CONTRACT_VERSION,
      schema: "event_page",
      schema_version: 1,
      ref,
      after_seq: Math.max(0, Number(afterSeq) || 0),
      events,
      last_seq: pageLastSeq,
      has_more: pageLastSeq < Number(projectedSnapshot?.last_event_seq || 0)
    };
    assertEventPageV1(result);
    return result;
  }

  async *watch(refInput, afterSeq = 0, signal = new AbortController().signal) {
    const ref = assertRef(refInput);
    let cursor = Math.max(0, Number(afterSeq) || 0);
    while (!signal.aborted) {
      const page = await this.getEvents(ref, cursor, MAX_EVENT_LIMIT);
      for (const event of page.events) {
        cursor = Math.max(cursor, Number(event.seq) || cursor);
        yield event;
      }
      try {
        await sleep(this.watchIntervalMs, signal);
      } catch (error) {
        if (error?.name === "AbortError") return;
        throw error;
      }
    }
  }

  async executeCommand(refInput, commandInput = {}) {
    try {
    const ref = assertRef(refInput);
    const command = normalizeText(commandInput.type || commandInput.command || "", 32).toLowerCase();
    const idempotencyKey = normalizeText(
      commandInput.idempotency_key || commandInput.idempotencyKey || "",
      200
    );
    if (!VALID_COMMANDS.has(command)) {
      const error = new Error("Unsupported Boss monitor command");
      error.code = "COMMAND_NOT_SUPPORTED";
      throw error;
    }
    if (!idempotencyKey) {
      const error = new Error("idempotency_key is required");
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }
    const paths = runPaths(ref);
    fs.mkdirSync(paths.commandDir, { recursive: true });
    const digest = crypto.createHash("sha256").update(idempotencyKey).digest("hex");
    const resultPath = path.join(paths.commandDir, `${digest}.json`);
    const expectedRevision = Number(
      commandInput.expected_revision ?? commandInput.expectedRevision
    );
    const fingerprint = commandRequestFingerprint(ref, command, expectedRevision);
    const requestPath = path.join(paths.commandDir, `${digest}.request.json`);
    const releaseLock = await acquireCommandRunLock(paths.commandDir);

    try {
      const existingRequest = readJson(requestPath);
      const existingResult = readJson(resultPath);
      const storedFingerprint = normalizeText(existingRequest?.fingerprint, 64);
      const sameStoredRequest = storedFingerprint
        ? storedFingerprint === fingerprint
        : existingResult?.command === command;
      const matchingStoredResult = existingResult?.command === command
        && existingResult?.idempotency_key === idempotencyKey
        && existingResult?.ref?.provider === ref.provider
        && existingResult?.ref?.kind === ref.kind
        && existingResult?.ref?.run_id === ref.run_id;

      if (existingResult) {
        const sanitizedExistingResult = sanitizeCommandResultMessages(existingResult);
        assertRunCommandResultV1(sanitizedExistingResult);
        if (sameStoredRequest && matchingStoredResult) return sanitizedExistingResult;
        return commandConflictResult({
          ref,
          command,
          idempotencyKey,
          revision: existingResult.revision,
          message: "IDEMPOTENCY_KEY_REUSED: this key is already bound to a different command request."
        });
      }
      if (existingRequest) {
        if (!sameStoredRequest) {
          return commandConflictResult({
            ref,
            command,
            idempotencyKey,
            revision: Number.isInteger(existingRequest.expected_revision)
              ? existingRequest.expected_revision
              : 0,
            message: "IDEMPOTENCY_KEY_REUSED: this key is already bound to a different command request."
          });
        }
        const snapshot = await this.getSnapshot(ref);
        const revisionPath = commandRevisionClaimPath(
          paths.commandDir,
          existingRequest.expected_revision
        );
        const revisionClaim = revisionPath ? readJson(revisionPath) : null;
        if (!revisionClaimMatchesRequest(revisionClaim, existingRequest)) {
          const conflict = commandConflictResult({
            ref,
            command,
            idempotencyKey,
            revision: snapshot.revision,
            message: "COMMAND_RESULT_UNAVAILABLE: the interrupted request has no matching durable revision reservation.",
            snapshot
          });
          writeJsonAtomic(resultPath, conflict);
          return conflict;
        }
        if (commandEffectObserved(snapshot, command)) {
          const duplicate = commandDuplicateResult({
            ref,
            command,
            idempotencyKey,
            snapshot
          });
          writeJsonAtomic(resultPath, duplicate);
          return duplicate;
        }
        // A matching request and revision claim prove that this exact command
        // was authorized before the interruption. Control commands are
        // state-setting and idempotent, so safely retry the reservation even
        // if heartbeat projections advanced the public snapshot revision.
      } else {
        const unresolvedReservation = findUnresolvedCommandReservation(paths.commandDir);
        if (unresolvedReservation) {
          let snapshot = await this.getSnapshot(ref);
          if (!reservationMatchesRun(unresolvedReservation, ref)) {
            return commandConflictResult({
              ref,
              command,
              idempotencyKey,
              revision: snapshot.revision,
              message: "COMMAND_RESERVATION_INVALID: the interrupted command reservation is corrupt or belongs to another run.",
              snapshot
            });
          }

          const reservedRequest = unresolvedReservation.request;
          const reservedCommand = normalizeText(
            reservedRequest.command,
            32
          ).toLowerCase();
          const reservedKey = normalizeText(
            reservedRequest.idempotency_key,
            200
          );
          const reservedDigest = crypto
            .createHash("sha256")
            .update(reservedKey)
            .digest("hex");
          const reservedResultPath = path.join(
            paths.commandDir,
            `${reservedDigest}.json`
          );
          let recoveredResult;
          if (commandEffectObserved(snapshot, reservedCommand)) {
            recoveredResult = commandDuplicateResult({
              ref,
              command: reservedCommand,
              idempotencyKey: reservedKey,
              snapshot
            });
          } else {
            let legacy;
            try {
              legacy = await executeLegacyCommand(
                ref,
                reservedCommand,
                this.legacyModuleLoader
              );
            } catch (error) {
              recoveredResult = commandRejectedResult({
                ref,
                command: reservedCommand,
                idempotencyKey: reservedKey,
                revision: snapshot.revision,
                message: error?.message || "Boss command failed.",
                snapshot
              });
            }
            if (!recoveredResult) {
              const source = legacy?.run;
              if (source) {
                writeBossMonitorProjectionNonfatal(ref.kind, source, {
                  type: "command",
                  command: reservedCommand,
                  status: legacy?.status === "FAILED" ? "rejected" : "accepted",
                  idempotency_key: reservedKey
                });
              }
              try {
                snapshot = await this.getSnapshot(ref);
              } catch {
                // The recovered legacy command remains authoritative.
              }
              recoveredResult = commandResultFromLegacy(
                ref,
                reservedCommand,
                reservedKey,
                legacy,
                snapshot
              );
              assertRunCommandResultV1(recoveredResult);
            }
          }
          writeJsonAtomic(reservedResultPath, recoveredResult);
          try {
            snapshot = await this.getSnapshot(ref);
          } catch {
            // Return the last validated snapshot if projection refresh failed.
          }
          return commandConflictResult({
            ref,
            command,
            idempotencyKey,
            revision: snapshot.revision,
            message: "COMMAND_RESERVATION_RECOVERED: the interrupted command was reconciled; retry this new command against the returned snapshot revision.",
            snapshot
          });
        }

        const initialSnapshot = await this.getSnapshot(ref);
        writeJsonAtomic(
          requestPath,
          commandRequestRecord(ref, command, idempotencyKey, expectedRevision, fingerprint)
        );
        if (
          !Number.isInteger(expectedRevision)
          || expectedRevision < 0
          || expectedRevision !== initialSnapshot.revision
        ) {
          const conflict = commandConflictResult({
            ref,
            command,
            idempotencyKey,
            revision: initialSnapshot.revision,
            message: "Snapshot revision has changed.",
            snapshot: initialSnapshot
          });
          writeJsonAtomic(resultPath, conflict);
          return conflict;
        }

        const revisionPath = commandRevisionClaimPath(paths.commandDir, expectedRevision);
        const consumedRevision = revisionPath ? readJson(revisionPath) : null;
        if (consumedRevision) {
          const conflict = commandConflictResult({
            ref,
            command,
            idempotencyKey,
            revision: initialSnapshot.revision,
            message: "COMMAND_REVISION_ALREADY_CONSUMED: another command already claimed this snapshot revision.",
            snapshot: initialSnapshot
          });
          writeJsonAtomic(resultPath, conflict);
          return conflict;
        }
        writeJsonAtomic(revisionPath, {
          schema_version: 1,
          revision: expectedRevision,
          fingerprint,
          idempotency_key: idempotencyKey,
          command,
          claimed_at: new Date().toISOString()
        });
      }

      const snapshot = await this.getSnapshot(ref);

      let legacy;
      try {
        legacy = await executeLegacyCommand(ref, command, this.legacyModuleLoader);
      } catch (error) {
        const rejected = commandRejectedResult({
          ref,
          command,
          idempotencyKey,
          revision: snapshot.revision,
          message: error?.message || "Boss command failed.",
          snapshot
        });
        writeJsonAtomic(resultPath, rejected);
        return rejected;
      }
      const source = legacy?.run;
      if (source) {
        writeBossMonitorProjectionNonfatal(ref.kind, source, {
          type: "command",
          command,
          status: legacy?.status === "FAILED" ? "rejected" : "accepted",
          idempotency_key: idempotencyKey
        });
      }
      let updatedSnapshot = snapshot;
      try {
        updatedSnapshot = await this.getSnapshot(ref);
      } catch {
        // The accepted legacy command is still authoritative if projection refresh fails.
      }
      const result = commandResultFromLegacy(
        ref,
        command,
        idempotencyKey,
        legacy,
        updatedSnapshot
      );
      assertRunCommandResultV1(result);
      writeJsonAtomic(resultPath, result);
      return result;
    } finally {
      releaseLock();
    }
    } catch (error) {
      throw sanitizeProviderError(error);
    }
  }

  async getEvidence(refInput, candidateRefInput, evidenceIdInput) {
    try {
    const ref = assertRef(refInput);
    const candidateRef = normalizeText(candidateRefInput, 220);
    const evidenceId = normalizeEvidenceId(evidenceIdInput);
    const paths = runPaths(ref);
    const index = readJson(paths.evidenceIndex) || {};
    const locatorPath = resolveEvidenceLocatorPath(paths.evidenceDir, evidenceId);
    const entry = readJson(locatorPath)
      || index[evidenceId];
    if (!entry || entry.candidate_ref !== candidateRef) {
      const error = new Error("Evidence is unavailable for this candidate");
      error.code = "EVIDENCE_UNAVAILABLE";
      throw error;
    }
    const sourcePath = resolveSafeArtifactPath(entry.source_path);
    if (entry.source_type === "file") {
      const mediaType = detectImageType(sourcePath);
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile() || stat.size > MAX_IMAGE_EVIDENCE_BYTES) {
        const error = new Error(
          stat.isFile()
            ? "Evidence image exceeds the size limit"
            : "Evidence source is not a file"
        );
        error.code = "EVIDENCE_UNAVAILABLE";
        throw error;
      }
      return {
        content_type: mediaType,
        content_length: stat.size,
        stream: fs.createReadStream(sourcePath)
      };
    }

    if (entry.source_type === "candidate_result_journal") {
      const candidate = readJournalCandidate(
        sourcePath,
        ref,
        candidateRef,
        entry.result_index
      );
      return rawModelEvidence(candidate);
    }
    if (entry.source_type !== "checkpoint_candidate") {
      const error = new Error("Evidence source type is unavailable");
      error.code = "EVIDENCE_UNAVAILABLE";
      throw error;
    }

    const stat = fs.statSync(sourcePath);
    if (!stat.isFile() || stat.size > MAX_CHECKPOINT_BYTES) {
      const error = new Error("Evidence checkpoint is unavailable or too large");
      error.code = "EVIDENCE_UNAVAILABLE";
      throw error;
    }
    const checkpoint = readJson(sourcePath);
    const candidate = findCandidate(checkpoint, candidateRef, entry.result_index);
    return rawModelEvidence(candidate);
    } catch (error) {
      throw sanitizeProviderError(error);
    }
  }
}

export function createBossRecruitingRunProvider(options = {}) {
  return new BossRecruitingRunProviderV1(options);
}

export function createMonitorProvider(options = {}) {
  return createBossRecruitingRunProvider(options);
}

export function getBossDashboardLink(ref) {
  const normalized = assertRef(ref);
  return createBossMonitoringBlock(normalized.kind, normalized.run_id).dashboard_url;
}

export const bossMonitorProviderDescriptor = Object.freeze({
  contract: "recruiting-run-monitor",
  contract_version: BOSS_MONITOR_CONTRACT_VERSION,
  schema: "provider_descriptor",
  schema_version: 1,
  provider: BOSS_MONITOR_PROVIDER,
  display_name: "Boss 直聘",
  kinds: [...BOSS_MONITOR_KINDS],
  capabilities: {
    watch: true,
    controls: ["pause", "resume", "cancel"],
    evidence: ["resume_screenshot", "model_output"]
  },
  generated_at: new Date(0).toISOString()
});
assertProviderDescriptorV1(bossMonitorProviderDescriptor);

export const __test = {
  assertRef,
  configuredArtifactRoots,
  detectImageType,
  findCandidate,
  collectRawModelFields,
  resolveSafeArtifactPath,
  withObservedLiveness
};
