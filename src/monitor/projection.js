import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertProviderDescriptorV1,
  assertRunEventV1,
  assertRunSnapshotV1
} from "@reconcrap/recruiting-run-monitor-contract";
import { readCandidateResultJournal } from "../core/run/candidate-result-journal.js";
import { acquireFileLockSync } from "../core/run/state-file-lock.js";

export const BOSS_MONITOR_CONTRACT_VERSION = "1.0";
export const BOSS_MONITOR_SCHEMA_VERSION = 1;
export const BOSS_MONITOR_PROVIDER = "boss";
export const BOSS_MONITOR_KINDS = Object.freeze(["recommend", "search", "chat"]);

const VALID_KINDS = new Set(BOSS_MONITOR_KINDS);
const TERMINAL_STATES = new Set(["completed", "failed", "canceled"]);
const SNAPSHOT_MAX_BYTES = 256 * 1024;
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_AFTER_MS = 20_000;
const WRITER_LOCK_WAIT_MS = 5_000;
const WRITER_LOCK_RETRY_MS = 10;
const WRITER_LOCK_DEAD_OWNER_GRACE_MS = 2_000;
const WRITER_LOCK_UNREADABLE_GRACE_MS = 10_000;
const WRITER_LOCK_MAX_LEASE_MS = 120_000;
const WRITER_RECOVERY_LOCK_MAX_LEASE_MS = 10_000;
const CANDIDATE_JOURNAL_READ_MAX_BYTES = 128 * 1024 * 1024;
const PROCESS_INSTANCE_ID = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : crypto.randomBytes(16).toString("hex");
const MONITOR_MODULE_LOADED_AT = new Date().toISOString();
const activeSources = new Map();
let heartbeatTimer = null;
let exitHooksInstalled = false;

function isoNow() {
  return new Date().toISOString();
}

function isoOr(value, fallback = isoNow()) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function clone(value, fallback = null) {
  try {
    return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeText(value, maxLength = 2_000) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
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
  ].map((entry) => normalizeText(entry, 4_000)).filter(Boolean);
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

function numberAtLeastZero(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function integerAtLeastZero(value, fallback = 0) {
  return Math.floor(numberAtLeastZero(value, fallback));
}

function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function monitoringEnabled() {
  const value = normalizeText(process.env.BOSS_MONITORING_ENABLED || "true").toLowerCase();
  return !["0", "false", "off", "disabled", "no"].includes(value);
}

export function getBossMonitorHome() {
  const configured = normalizeText(process.env.BOSS_MONITOR_HOME || "");
  if (configured) return path.resolve(configured);
  const recommendHome = normalizeText(process.env.BOSS_RECOMMEND_HOME || "");
  if (recommendHome) return path.join(path.resolve(recommendHome), "monitor-projection");
  return path.join(os.homedir(), ".boss-recommend-mcp", "monitor-projection");
}

export function getBossMonitorV1Root() {
  return path.join(getBossMonitorHome(), "v1");
}

function getProviderPath() {
  return path.join(getBossMonitorV1Root(), "provider.json");
}

function getProviderInstallationPath() {
  return path.join(getBossMonitorV1Root(), ".provider-installation.json");
}

export function getBossMonitorRunDir(kind, runId) {
  const normalizedKind = normalizeKind(kind);
  const normalizedRunId = normalizeRunId(runId);
  if (!normalizedKind || !normalizedRunId) return null;
  return path.join(getBossMonitorV1Root(), "runs", normalizedKind, normalizedRunId);
}

function readJson(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function refreshActiveSourceFromRunState(entry) {
  const source = clone(entry?.source, {});
  const runId = normalizeRunId(entry?.runId);
  const controlPath = normalizeText(source?.resume?.pause_control_path || "", 8_000);
  if (
    !runId
    || !controlPath
    || !path.isAbsolute(controlPath)
    || path.basename(controlPath) !== `${runId}.json`
  ) {
    return source;
  }
  const persisted = readJson(controlPath);
  if (!persisted) return source;
  const persistedRunId = normalizeRunId(persisted.run_id || persisted.runId);
  if (persistedRunId !== runId) return source;

  const producerLaunchId = normalizeText(source?.resume?.worker_launch_id || "", 240);
  const persistedLaunchId = normalizeText(persisted?.resume?.worker_launch_id || "", 240);
  if (producerLaunchId && persistedLaunchId && producerLaunchId !== persistedLaunchId) {
    // A superseded worker must never heartbeat over the replacement launch.
    return null;
  }
  return {
    ...source,
    ...persisted,
    progress: {
      ...plainRecord(source.progress),
      ...plainRecord(persisted.progress)
    },
    context: {
      ...plainRecord(source.context),
      ...plainRecord(persisted.context)
    },
    control: {
      ...plainRecord(source.control),
      ...plainRecord(persisted.control)
    },
    resume: {
      ...plainRecord(source.resume),
      ...plainRecord(persisted.resume)
    },
    monitoring_v1: plainRecord(persisted.monitoring_v1).contract_version === "1.0"
      ? persisted.monitoring_v1
      : source.monitoring_v1
  };
}

function serializedPayload(payload, maxBytes = SNAPSHOT_MAX_BYTES) {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    const error = new Error(`Monitor payload exceeds ${maxBytes} bytes`);
    error.code = "MONITOR_PAYLOAD_TOO_LARGE";
    throw error;
  }
  return serialized;
}

function writeJsonAtomic(filePath, payload, maxBytes = SNAPSHOT_MAX_BYTES) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const serialized = serializedPayload(payload, maxBytes);
  let fd = null;
  try {
    fd = fs.openSync(tempPath, "wx");
    fs.writeFileSync(fd, serialized, "utf8");
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
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  if (value === process.pid) return true;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireRunWriterLock(runDir) {
  fs.mkdirSync(runDir, { recursive: true });
  const lockPath = path.join(runDir, ".writer.lock");
  const recoveryPath = path.join(runDir, ".writer.recovery.lock");
  return acquireFileLockSync(lockPath, {
    timeoutMs: WRITER_LOCK_WAIT_MS,
    retryMs: WRITER_LOCK_RETRY_MS,
    deadOwnerGraceMs: WRITER_LOCK_DEAD_OWNER_GRACE_MS,
    unreadableGraceMs: WRITER_LOCK_UNREADABLE_GRACE_MS,
    maxLeaseMs: WRITER_LOCK_MAX_LEASE_MS,
    recoveryMaxLeaseMs: WRITER_RECOVERY_LOCK_MAX_LEASE_MS,
    recoveryPath,
    timeoutCode: "MONITOR_WRITER_LOCK_TIMEOUT",
    timeoutMessage: "Timed out acquiring Boss monitor projection writer lock",
    ownerMetadata: {
      worker_instance_id: PROCESS_INSTANCE_ID
    }
  });
}

export function createBossMonitorSourceMarker(createdAt = isoNow()) {
  if (!monitoringEnabled()) return null;
  try {
    const normalizedCreatedAt = isoOr(createdAt);
    providerDescriptor(normalizedCreatedAt);
    const installationEpoch = providerInstallationEpoch(normalizedCreatedAt);
    if (
      !installationEpoch
      || Date.parse(normalizedCreatedAt) < Date.parse(installationEpoch)
    ) {
      return null;
    }
    return {
      contract_version: BOSS_MONITOR_CONTRACT_VERSION,
      created_at: normalizedCreatedAt,
      provider_installed_at: installationEpoch
    };
  } catch {
    // Monitoring is an additive observer. Provider/installation marker I/O
    // must never make the authoritative recruiting state fail to persist.
    // Returning no marker also prevents a partially initialized run from
    // becoming visible as a V1 run if the projection root is unavailable.
    return null;
  }
}

function prepareNdjsonAppendBoundary(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) return;
  const fd = fs.openSync(filePath, "r+");
  try {
    const finalByte = Buffer.alloc(1);
    fs.readSync(fd, finalByte, 0, 1, stat.size - 1);
    if (finalByte[0] === 0x0a) return;
    const bytesToRead = Math.min(stat.size, 64 * 1024);
    const tail = Buffer.alloc(bytesToRead);
    const tailStart = stat.size - bytesToRead;
    fs.readSync(fd, tail, 0, bytesToRead, tailStart);
    const lastNewline = tail.lastIndexOf(0x0a);
    const trailingStart = lastNewline >= 0 ? tailStart + lastNewline + 1 : 0;
    const trailing = Buffer.alloc(stat.size - trailingStart);
    fs.readSync(fd, trailing, 0, trailing.length, trailingStart);
    try {
      JSON.parse(trailing.toString("utf8"));
      fs.writeSync(fd, Buffer.from("\n"), 0, 1, stat.size);
    } catch {
      fs.ftruncateSync(fd, trailingStart);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function appendNdjson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  prepareNdjsonAppendBoundary(filePath);
  const line = `${JSON.stringify(payload)}\n`;
  const fd = fs.openSync(filePath, "a");
  try {
    fs.writeSync(fd, line, null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readLastEventSeq(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return 0;
    const bytesToRead = Math.min(stat.size, 64 * 1024);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buffer.toString("utf8").trim().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]);
        if (Number.isSafeInteger(parsed?.seq) && parsed.seq >= 0) return parsed.seq;
      } catch {
        // Ignore an incomplete trailing record left by an interrupted append.
      }
    }
  } catch {
    // The next successful projection can recover from the public snapshot cursor.
  }
  return 0;
}

function validIsoTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function providerInstallationEpoch(installationEpochHint = "") {
  const filePath = getProviderInstallationPath();
  const existing = readJson(filePath);
  const existingEpoch = validIsoTimestamp(existing?.installed_at);
  if (
    existing?.schema_version === 1
    && existing?.provider === BOSS_MONITOR_PROVIDER
    && existing?.contract_version === BOSS_MONITOR_CONTRACT_VERSION
    && existingEpoch
  ) {
    return existingEpoch;
  }
  const legacyDescriptor = readJson(getProviderPath());
  const installationEpoch = validIsoTimestamp(
    legacyDescriptor?.extensions?.installation_epoch
    || legacyDescriptor?.extensions?.installed_at
  )
    || validIsoTimestamp(legacyDescriptor?.generated_at)
    || MONITOR_MODULE_LOADED_AT
    || validIsoTimestamp(installationEpochHint)
    || isoNow();
  const payload = {
    schema_version: 1,
    provider: BOSS_MONITOR_PROVIDER,
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    installed_at: installationEpoch
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const fd = fs.openSync(filePath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const concurrent = readJson(filePath);
    const concurrentEpoch = validIsoTimestamp(concurrent?.installed_at);
    if (
      concurrent?.schema_version === 1
      && concurrent?.provider === BOSS_MONITOR_PROVIDER
      && concurrent?.contract_version === BOSS_MONITOR_CONTRACT_VERSION
      && concurrentEpoch
    ) {
      return concurrentEpoch;
    }
    writeJsonAtomic(filePath, payload, 16 * 1024);
  }
  return installationEpoch;
}

function providerDescriptor(installationEpochHint = "") {
  const filePath = getProviderPath();
  const existing = readJson(filePath);
  providerInstallationEpoch(installationEpochHint);
  if (existing) {
    try {
      assertProviderDescriptorV1(existing);
      return existing;
    } catch {
      // Repair pre-release descriptors that carried provider-private metadata.
    }
  }
  const descriptor = {
    contract: "recruiting-run-monitor",
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    schema: "provider_descriptor",
    schema_version: BOSS_MONITOR_SCHEMA_VERSION,
    provider: BOSS_MONITOR_PROVIDER,
    display_name: "Boss 直聘",
    kinds: [...BOSS_MONITOR_KINDS],
    capabilities: {
      watch: true,
      controls: ["pause", "resume", "cancel"],
      evidence: ["resume_screenshot", "model_output"]
    },
    generated_at: validIsoTimestamp(existing?.generated_at) || isoNow()
  };
  assertProviderDescriptorV1(descriptor);
  writeJsonAtomic(filePath, descriptor, 32 * 1024);
  return descriptor;
}

function isPostInstallationV1Marker(marker) {
  if (marker?.contract_version !== BOSS_MONITOR_CONTRACT_VERSION) return false;
  const createdAt = validIsoTimestamp(marker?.created_at);
  if (!createdAt) return false;
  providerDescriptor(createdAt);
  const installationEpoch = providerInstallationEpoch(createdAt);
  if (!installationEpoch || Date.parse(createdAt) < Date.parse(installationEpoch)) {
    return false;
  }
  const markerEpoch = validIsoTimestamp(marker?.provider_installed_at);
  return !markerEpoch || markerEpoch === installationEpoch;
}

function normalizeState(source) {
  const raw = normalizeText(source?.state || source?.status || "unknown", 64).toLowerCase();
  if (raw === "cancelled") return "canceled";
  if (["queued", "running", "paused", "canceling", "completed", "failed", "canceled"].includes(raw)) {
    return raw;
  }
  return "unknown";
}

function normalizeStage(source, state) {
  if (TERMINAL_STATES.has(state)) return "done";
  const raw = normalizeText(source?.stage || source?.phase || "", 160).toLowerCase();
  if (!raw || raw === "queued") return "initializing";
  if (/final|done|cleanup|complete/.test(raw)) return "finalizing";
  if (/action|greet|follow|collect_cv|request|favorite/.test(raw)) return "acting";
  if (/screen|detail|candidate/.test(raw)) return "screening";
  if (/card|list|search|filter|job|root|context|page|refresh/.test(raw)) return "discovering";
  if (/preflight|recover|connect|login/.test(raw)) return "initializing";
  return "unknown";
}

function normalizeCondition(source, state) {
  if (TERMINAL_STATES.has(state)) return "normal";
  if (source?.error) return "degraded";
  const raw = normalizeText(source?.stage || source?.phase || "", 160).toLowerCase();
  if (/recover|retry|backoff/.test(raw)) return "recovering";
  if (state === "paused" || /wait|login/.test(raw)) return "waiting";
  return "normal";
}

function normalizeCounters(kind, progress = {}) {
  const universal = {
    processed: integerAtLeastZero(progress.processed),
    screened: integerAtLeastZero(progress.screened, integerAtLeastZero(progress.processed)),
    passed: integerAtLeastZero(progress.passed),
    skipped: integerAtLeastZero(progress.skipped),
    failed: integerAtLeastZero(progress.failed ?? progress.error_count)
  };
  const workflow = {};
  const candidates = {
    recommend: ["greet_count", "favorite_count", "request_cv_count", "detail_opened", "llm_screened"],
    search: ["greet_count", "detail_opened", "llm_screened", "refresh_rounds"],
    chat: ["greet_count", "request_cv_count", "collected_cv_count", "detail_opened", "llm_screened"]
  }[kind] || [];
  for (const key of candidates) {
    if (progress[key] !== undefined) workflow[key] = integerAtLeastZero(progress[key]);
  }
  return { universal, workflow };
}

function normalizeGoal(source, counters) {
  const progress = plainRecord(source?.progress);
  const context = plainRecord(source?.context);
  const rawTarget = progress.target_count
    ?? context.target_count
    ?? context.max_candidates
    ?? source?.result?.target_count
    ?? null;
  const numericTarget = Number(rawTarget);
  const scanToEnd = rawTarget === null
    || rawTarget === undefined
    || ["all", "全部", "扫到底", "-1"].includes(normalizeText(rawTarget, 32).toLowerCase());
  return scanToEnd || !Number.isFinite(numericTarget) || numericTarget <= 0
    ? {
        mode: "scan_to_end",
        scanned: counters.universal.processed,
        complete: TERMINAL_STATES.has(normalizeState(source))
      }
    : {
        mode: "passed_target",
        target: Math.floor(numericTarget),
        current: counters.universal.passed,
        complete: counters.universal.passed >= Math.floor(numericTarget)
      };
}

function safeCandidate(value) {
  const record = plainRecord(value);
  const candidate = plainRecord(record.candidate);
  const identity = plainRecord(record.identity);
  const profile = plainRecord(candidate.profile || record.profile);
  const screening = plainRecord(record.screening);
  const rawScore = Number(screening.score ?? record.score);
  return {
    candidate_ref: normalizeText(
      record.candidate_key
      || record.key
      || candidate.id
      || record.id
      || `candidate-${record.index ?? "unknown"}`,
      220
    ),
    display: {
      name: normalizeText(
        candidate.name
        || candidate.display_name
        || candidate.identity?.name
        || identity.name
        || record.name
        || record.title
        || "候选人",
        120
      ),
      ...(normalizeText(
        candidate.headline || profile.headline || record.headline || "",
        240
      ) ? {
          headline: normalizeText(
            candidate.headline || profile.headline || record.headline,
            240
          )
        } : {}),
      ...(normalizeText(
        candidate.location || profile.location || record.location || "",
        160
      ) ? {
          location: normalizeText(
            candidate.location || profile.location || record.location,
            160
          )
        } : {})
    },
    decision: (() => {
      if (screening.passed === true) return "passed";
      if (screening.passed === false) return "rejected";
      const raw = normalizeText(screening.status || record.decision || "unknown", 40).toLowerCase();
      if (["pass", "passed", "accepted"].includes(raw)) return "passed";
      if (["reject", "rejected", "fail", "failed"].includes(raw)) return "rejected";
      if (["skip", "skipped"].includes(raw)) return "skipped";
      if (["error", "errored"].includes(raw)) return "error";
      return "unknown";
    })(),
    score: Number.isFinite(rawScore)
      ? Math.min(100, Math.max(0, rawScore))
      : null
  };
}

function normalizeCurrentCandidate(source) {
  const checkpoint = plainRecord(source?.checkpoint);
  const value = checkpoint.in_progress_candidate || checkpoint.current_candidate || null;
  if (!value) return null;
  const candidate = safeCandidate(value);
  return {
    candidate_ref: candidate.candidate_ref,
    display: candidate.display,
    decision: candidate.decision
  };
}

function normalizeLastCandidate(source) {
  const checkpoint = plainRecord(source?.checkpoint);
  const value = checkpoint.last_candidate || source?.progress?.last_candidate || null;
  if (!value) return null;
  const candidate = safeCandidate(value);
  return {
    candidate_ref: candidate.candidate_ref,
    display: candidate.display,
    decision: candidate.decision
  };
}

function safeError(error, at = isoNow()) {
  if (!error) return null;
  return {
    code: normalizeText(error.code || error.name || "RUN_ERROR", 120),
    message: redactFilesystemPaths(error.message || error, 1_500),
    at: isoOr(error.at || error.occurred_at || at),
    retryable: error.retryable === true
  };
}

function controlsFor(source, state, runId, at) {
  const control = plainRecord(source?.control);
  const available = [];
  if (state === "running") available.push("pause");
  if (state === "paused") available.push("resume");
  if (!TERMINAL_STATES.has(state) && state !== "canceling") available.push("cancel");
  const pending = [];
  if (control.pause_requested === true && state !== "paused") {
    pending.push({
      command: "pause",
      idempotency_key: `source-${runId}-pause`,
      requested_at: isoOr(control.pause_requested_at || at)
    });
  }
  if (control.pause_requested === false && state === "paused") {
    pending.push({
      command: "resume",
      idempotency_key: `source-${runId}-resume`,
      requested_at: isoOr(at)
    });
  }
  if (control.cancel_requested === true || state === "canceling") {
    pending.push({
      command: "cancel",
      idempotency_key: `source-${runId}-cancel`,
      requested_at: isoOr(control.cancel_requested_at || control.pause_requested_at || at)
    });
  }
  return {
    available,
    pending
  };
}

function opaqueArtifacts(source) {
  const artifacts = plainRecord(source?.artifacts);
  return Object.entries(artifacts)
    .filter(([, value]) => typeof value === "string" && value)
    .slice(0, 30)
    .map(([key, value]) => ({
      artifact_id: crypto.createHash("sha256").update(`${key}:${value}`).digest("hex").slice(0, 24),
      kind: key,
      availability: fs.existsSync(value) ? "available" : "pending"
    }));
}

function sourceResults(source) {
  const journalPath = normalizeText(
    source?.artifacts?.candidate_result_journal_path
    || source?.checkpoint?.candidate_result_journal?.journal_path
    || source?.summary?.candidate_result_journal?.journal_path
    || "",
    4_000
  );
  const runId = normalizeRunId(source?.run_id || source?.runId);
  if (journalPath && runId && fs.existsSync(journalPath)) {
    try {
      const journal = readCandidateResultJournal({
        runDir: path.dirname(journalPath),
        runId
      });
      if (Array.isArray(journal?.results)) return journal.results;
    } catch {
      // A checkpoint tail remains a safe fallback while the producer repairs a partial journal.
    }
  }
  const checkpoint = plainRecord(source?.checkpoint);
  if (Array.isArray(checkpoint.results)) return checkpoint.results;
  if (Array.isArray(checkpoint?.candidate_result_journal?.tail)) {
    return checkpoint.candidate_result_journal.tail
      .map((record) => record?.result)
      .filter((result) => result && typeof result === "object");
  }
  if (Array.isArray(source?.summary?.results)) return source.summary.results;
  return [];
}

function sourceCandidateJournal(source) {
  const journalPath = findCandidateJournalPath(source);
  const runId = normalizeRunId(source?.run_id || source?.runId);
  if (!journalPath || !runId || !fs.existsSync(journalPath)) return null;
  try {
    const stat = fs.statSync(journalPath);
    if (!stat.isFile() || stat.size > CANDIDATE_JOURNAL_READ_MAX_BYTES) return null;
    const snapshot = readCandidateResultJournal({
      runDir: path.dirname(journalPath),
      runId
    });
    const records = [];
    const lines = fs.readFileSync(journalPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (
          record?.run_id === runId
          && Number.isSafeInteger(record?.result_index)
          && record.result_index >= 0
          && record?.result
          && typeof record.result === "object"
          && !Array.isArray(record.result)
        ) {
          records.push(record);
        }
      } catch {
        // The journal reader above already rejects corrupt committed records.
      }
    }
    return {
      records,
      results: Array.isArray(snapshot?.results) ? snapshot.results : [],
      raw_record_count: integerAtLeastZero(snapshot?.raw_record_count, records.length)
    };
  } catch {
    return null;
  }
}

function collectStringPaths(value, keys, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const entry of value) collectStringPaths(entry, keys, output);
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (keys.has(key)) {
      if (typeof entry === "string" && entry) output.push(entry);
      if (Array.isArray(entry)) {
        for (const item of entry) {
          if (typeof item === "string" && item) output.push(item);
        }
      }
    } else if (entry && typeof entry === "object") {
      collectStringPaths(entry, keys, output);
    }
  }
  return output;
}

function hasRawModelOutput(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasRawModelOutput);
  for (const [key, entry] of Object.entries(value)) {
    if (["raw_model_output", "reasoning_content", "cot"].includes(key) && normalizeText(entry, 4)) {
      return true;
    }
    if (entry && typeof entry === "object" && hasRawModelOutput(entry)) return true;
  }
  return false;
}

function findCheckpointPath(source) {
  return normalizeText(
    source?.resume?.checkpoint_path
    || source?.artifacts?.checkpoint_path
    || source?.result?.checkpoint_path
    || "",
    4_000
  );
}

function findCandidateJournalPath(source) {
  return normalizeText(
    source?.artifacts?.candidate_result_journal_path
    || source?.checkpoint?.candidate_result_journal?.journal_path
    || source?.summary?.candidate_result_journal?.journal_path
    || "",
    4_000
  );
}

function evidenceForCandidate(kind, runId, result, source, index, evidenceIndex) {
  const candidate = safeCandidate(result);
  const descriptors = [];
  const screenshotPaths = [...new Set(collectStringPaths(
    result,
    new Set(["file_paths", "llm_file_paths", "screenshot_paths", "screenshots"])
  ))];
  for (const [screenshotIndex, sourcePath] of screenshotPaths.entries()) {
    const evidenceId = crypto.createHash("sha256")
      .update(`${kind}:${runId}:${candidate.candidate_ref}:screenshot:${screenshotIndex}:${sourcePath}`)
      .digest("hex")
      .slice(0, 32);
    evidenceIndex[evidenceId] = {
      kind: "resume_screenshot",
      source_type: "file",
      source_path: sourcePath,
      candidate_ref: candidate.candidate_ref
    };
    descriptors.push({
      evidence_id: evidenceId,
      type: "resume_screenshot",
      available: fs.existsSync(sourcePath),
      label: `简历截图 ${screenshotIndex + 1}`
    });
  }
  const candidateJournalPath = findCandidateJournalPath(source);
  const checkpointPath = findCheckpointPath(source);
  const modelSourcePath = candidateJournalPath && fs.existsSync(candidateJournalPath)
    ? candidateJournalPath
    : checkpointPath;
  if (modelSourcePath && hasRawModelOutput(result)) {
    const evidenceId = crypto.createHash("sha256")
      .update(`${kind}:${runId}:${candidate.candidate_ref}:model-output:${index}`)
      .digest("hex")
      .slice(0, 32);
    evidenceIndex[evidenceId] = {
      kind: "model_output",
      source_type: candidateJournalPath && modelSourcePath === candidateJournalPath
        ? "candidate_result_journal"
        : "checkpoint_candidate",
      source_path: modelSourcePath,
      candidate_ref: candidate.candidate_ref,
      result_index: Number.isInteger(result?.index) ? result.index : index
    };
    descriptors.push({
      evidence_id: evidenceId,
      type: "model_output",
      available: fs.existsSync(modelSourcePath),
      label: "模型原始输出"
    });
  }
  return descriptors;
}

function safeReasons(result) {
  const screening = plainRecord(result?.screening);
  const llm = plainRecord(result?.llm_screening);
  const raw = screening.reasons || llm.reasons || result?.reasons || [];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values.map((item) => redactFilesystemPaths(item, 500)).filter(Boolean).slice(0, 12);
}

function safeAction(result) {
  const action = plainRecord(result?.post_action || result?.action);
  const requested = normalizeText(action.requested || action.action || action.type || "none", 80);
  const rawStatus = normalizeText(
    action.outcome || action.status || action.reason || "not_requested",
    120
  ).toLowerCase();
  const message = redactFilesystemPaths(
    action.reason || (rawStatus && rawStatus !== "not_requested" ? rawStatus : ""),
    500
  );
  let status = "unknown";
  if (!requested || requested === "none") status = "not_requested";
  else if (["disabled", "dry_run"].includes(rawStatus)) status = "disabled";
  else if (["success", "succeeded", "sent", "confirmed", "completed"].includes(rawStatus)) status = "succeeded";
  else if (["failed", "error", "outcome_unknown"].includes(rawStatus)) status = "failed";
  else if (["skip", "skipped", "not_needed", "already_done"].includes(rawStatus)) status = "skipped";
  return {
    action: requested || "none",
    status,
    ...(message && message !== status ? { message } : {})
  };
}

function candidateEventData(result, evidence, resultIndex) {
  const candidate = safeCandidate(result);
  const completedAt = isoOr(
    result?.completed_at
    || result?.screening?.screened_at
    || result?.llm_screening?.screened_at
    || result?.updated_at
  );
  const durationMs = Number(result?.timings?.total_ms ?? result?.timings?.duration_ms);
  return {
    candidate_ref: candidate.candidate_ref,
    display: candidate.display,
    decision: candidate.decision,
    ...(candidate.score === null ? {} : { score: candidate.score }),
    reasons: safeReasons(result),
    action_outcome: safeAction(result),
    timings: {
      completed_at: completedAt,
      ...(Number.isFinite(durationMs) ? { duration_ms: integerAtLeastZero(durationMs) } : {})
    },
    evidence
  };
}

function baseEvent(kind, runId, seq, type, revision, payload = {}) {
  return {
    contract: "recruiting-run-monitor",
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    schema: "run_event",
    schema_version: BOSS_MONITOR_SCHEMA_VERSION,
    ref: { provider: BOSS_MONITOR_PROVIDER, kind, run_id: runId },
    seq,
    event_id: `${runId}:${seq}`,
    revision,
    type,
    occurred_at: isoNow(),
    payload
  };
}

function buildSnapshot(kind, source, existing, {
  revision,
  lastEventSeq,
  projectedCandidateCount,
  projectedJournalRecordCount,
  heartbeatAt,
  workerInstanceId
}) {
  const state = normalizeState(source);
  const counters = normalizeCounters(kind, source?.progress);
  const observedAt = isoNow();
  const sourceUpdatedAt = isoOr(
    source?.updated_at || source?.updatedAt || source?.heartbeat_at,
    observedAt
  );
  const startedAt = isoOr(source?.started_at || source?.startedAt, sourceUpdatedAt);
  const completedAt = source?.completed_at || source?.completedAt
    ? isoOr(source.completed_at || source.completedAt)
    : null;
  const currentCandidate = normalizeCurrentCandidate(source);
  const lastCandidate = normalizeLastCandidate(source);
  const normalizedError = safeError(source?.error, sourceUpdatedAt);
  const runId = normalizeRunId(source?.run_id || source?.runId);
  return {
    contract: "recruiting-run-monitor",
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    schema: "run_snapshot",
    schema_version: BOSS_MONITOR_SCHEMA_VERSION,
    ref: {
      provider: BOSS_MONITOR_PROVIDER,
      kind,
      run_id: runId
    },
    revision,
    last_event_seq: lastEventSeq,
    source: {
      state: normalizeText(source?.state || source?.status || "unknown", 80),
      stage: normalizeText(source?.stage || source?.phase || "unknown", 128)
    },
    state,
    stage: normalizeStage(source, state),
    condition: normalizeCondition(source, state),
    timestamps: {
      created_at: startedAt,
      started_at: startedAt,
      updated_at: sourceUpdatedAt,
      ...(completedAt ? { ended_at: completedAt } : {})
    },
    liveness: {
      status: TERMINAL_STATES.has(state) ? "exited" : "alive",
      observed_at: observedAt,
      heartbeat_at: isoOr(heartbeatAt, observedAt),
      update_age_ms: Math.max(0, Date.now() - Date.parse(sourceUpdatedAt)),
      stale_after_ms: STALE_AFTER_MS,
      worker_instance_id: workerInstanceId,
      pid: Number.isInteger(source?.pid) && source.pid > 0 ? source.pid : process.pid
    },
    goal: normalizeGoal(source, counters),
    counters,
    ...(currentCandidate ? { current_candidate: currentCandidate } : {}),
    ...(lastCandidate ? { last_candidate: lastCandidate } : {}),
    controls: controlsFor(source, state, runId, sourceUpdatedAt),
    errors: normalizedError ? [normalizedError] : [],
    artifacts: opaqueArtifacts(source),
    extensions: {
      boss: {
        projected_candidate_count: projectedCandidateCount,
        projected_journal_record_count: projectedJournalRecordCount,
        worker_instance_id: workerInstanceId,
        source_revision: existing?.extensions?.boss?.source_revision
          ? existing.extensions.boss.source_revision + 1
          : 1
      }
    }
  };
}

function writeExitSidecar(kind, runId, snapshot, reason) {
  const runDir = getBossMonitorRunDir(kind, runId);
  if (!runDir) return;
  writeJsonAtomic(path.join(runDir, "worker-exit.json"), {
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    ref: { provider: BOSS_MONITOR_PROVIDER, kind, run_id: runId },
    worker_instance_id: normalizeText(
      snapshot?.liveness?.worker_instance_id || PROCESS_INSTANCE_ID,
      160
    ),
    pid: Number.isInteger(snapshot?.liveness?.pid) && snapshot.liveness.pid > 0
      ? snapshot.liveness.pid
      : process.pid,
    state: snapshot?.state || "unknown",
    reason: normalizeText(reason || snapshot?.state || "process_exit", 160),
    exited_at: isoNow()
  }, 32 * 1024);
}

function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.once("exit", () => {
    for (const [key, entry] of activeSources.entries()) {
      try {
        writeExitSidecar(entry.kind, entry.runId, entry.snapshot, "process_exit");
      } catch {
        // Monitoring persistence is nonfatal by design.
      }
      activeSources.delete(key);
    }
  });
}

function ensureHeartbeatTimer() {
  installExitHooks();
  if (heartbeatTimer || activeSources.size === 0) return;
  heartbeatTimer = setInterval(() => {
    for (const entry of activeSources.values()) {
      try {
        writeBossMonitorProjection(entry.kind, entry.source, {
          type: "heartbeat",
          producer: true
        });
      } catch {
        // Monitoring persistence is nonfatal by design.
      }
    }
    if (activeSources.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

export function writeBossMonitorProjection(kind, sourceSnapshot, eventContext = {}) {
  if (!monitoringEnabled()) return null;
  const normalizedKind = normalizeKind(kind);
  const runId = normalizeRunId(sourceSnapshot?.run_id || sourceSnapshot?.runId);
  if (!normalizedKind || !runId) return null;
  const runDir = getBossMonitorRunDir(normalizedKind, runId);
  const snapshotPath = path.join(runDir, "snapshot.json");
  const eventsPath = path.join(runDir, "events.ndjson");
  const evidenceDir = path.join(runDir, ".evidence");
  const isProducer = eventContext?.producer === true;
  const key = `${normalizedKind}:${runId}`;
  let desiredState = normalizeState(sourceSnapshot);
  let hasV1Marker = isPostInstallationV1Marker(sourceSnapshot?.monitoring_v1);
  if (!hasV1Marker && eventContext?.v1_created === true) {
    hasV1Marker = isPostInstallationV1Marker(
      createBossMonitorSourceMarker(
        sourceSnapshot?.started_at
        || sourceSnapshot?.startedAt
        || sourceSnapshot?.updated_at
        || sourceSnapshot?.updatedAt
      )
    );
  }
  const mayCreateV1Run = hasV1Marker;
  if (!fs.existsSync(snapshotPath) && !mayCreateV1Run) return null;

  if (isProducer) {
    const previousActive = activeSources.get(key);
    activeSources.set(key, {
      kind: normalizedKind,
      runId,
      source: clone(sourceSnapshot, {}),
      snapshot: previousActive?.snapshot || { state: desiredState },
      desiredState
    });
    ensureHeartbeatTimer();
  }

  const releaseWriterLock = acquireRunWriterLock(runDir);
  try {
    const existing = readJson(snapshotPath);
    if (isProducer && eventContext?.type === "heartbeat") {
      const refreshedSource = refreshActiveSourceFromRunState({
        kind: normalizedKind,
        runId,
        source: sourceSnapshot
      });
      if (!refreshedSource) {
        activeSources.delete(key);
        return existing;
      }
      sourceSnapshot = refreshedSource;
      desiredState = normalizeState(sourceSnapshot);
    }
    if (!existing && !mayCreateV1Run) return null;
    if (
      existing
      && TERMINAL_STATES.has(existing.state)
      && !TERMINAL_STATES.has(desiredState)
    ) {
      if (isProducer) activeSources.delete(key);
      return existing;
    }

    providerDescriptor();
    const evidenceIndex = {};
    const revision = integerAtLeastZero(existing?.revision) + 1;
    const workerInstanceId = isProducer
      ? PROCESS_INSTANCE_ID
      : normalizeText(
          existing?.liveness?.worker_instance_id
          || sourceSnapshot?.worker_instance_id
          || sourceSnapshot?.resume?.worker_launch_id
          || `boss-${normalizedKind}-${sourceSnapshot?.pid || "unknown"}-${sourceSnapshot?.started_at || sourceSnapshot?.startedAt || runId}`,
          160
        );
    let seq = Math.max(
      integerAtLeastZero(existing?.last_event_seq),
      readLastEventSeq(eventsPath)
    );
    const events = [];
    const append = (type, payload) => {
      seq += 1;
      events.push(baseEvent(normalizedKind, runId, seq, type, revision, payload));
    };
    const nextState = desiredState;
    const nextStage = normalizeStage(sourceSnapshot, nextState);
    const counters = normalizeCounters(normalizedKind, sourceSnapshot?.progress);
    const goal = normalizeGoal(sourceSnapshot, counters);
    const currentCandidate = normalizeCurrentCandidate(sourceSnapshot);
    if (!existing) append("run.created", { state: nextState, stage: nextStage, goal });
    if (existing && existing.state !== nextState) {
      append("run.state_changed", {
        from: existing.state,
        to: nextState,
        source_state: normalizeText(sourceSnapshot?.state || sourceSnapshot?.status || nextState, 128)
      });
    }
    if (existing && existing.stage !== nextStage) {
      append("run.stage_changed", {
        from: existing.stage,
        to: nextStage,
        source_stage: normalizeText(sourceSnapshot?.stage || sourceSnapshot?.phase || nextStage, 128)
      });
    }
    if (eventContext?.type === "command") {
      const rawStatus = normalizeText(eventContext.status || "accepted", 40).toLowerCase();
      append("run.command", {
        command: normalizeText(eventContext.command || "unknown", 40),
        status: ["accepted", "applied", "rejected", "conflict", "duplicate"].includes(rawStatus)
          ? rawStatus
          : "accepted",
        idempotency_key: normalizeText(eventContext.idempotency_key || "", 200)
      });
    }
    if (
      sourceSnapshot?.error
      && existing?.errors?.[0]?.code !== normalizeText(sourceSnapshot.error.code || sourceSnapshot.error.name)
    ) {
      append("run.error", { error: safeError(sourceSnapshot.error) });
    }

    const nextArtifacts = opaqueArtifacts(sourceSnapshot);
    const previouslyAvailableArtifacts = new Set(
      (Array.isArray(existing?.artifacts) ? existing.artifacts : [])
        .filter((artifact) => artifact?.availability === "available")
        .map((artifact) => artifact.artifact_id)
    );
    for (const artifact of nextArtifacts) {
      if (
        artifact.availability === "available"
        && !previouslyAvailableArtifacts.has(artifact.artifact_id)
      ) {
        append("artifact.available", { artifact });
      }
    }

    const journal = sourceCandidateJournal(sourceSnapshot);
    const results = journal?.results || sourceResults(sourceSnapshot);
    // Retry/backfill locator metadata from the authoritative candidate journal
    // on every projection. A transient locator write failure must not become
    // permanent merely because the snapshot cursor already advanced.
    for (const [resultOffset, result] of results.entries()) {
      if (!result || typeof result !== "object") continue;
      evidenceForCandidate(
        normalizedKind,
        runId,
        result,
        sourceSnapshot,
        Number.isInteger(result?.index) ? result.index : resultOffset,
        evidenceIndex
      );
    }
    const previousCandidateCount = integerAtLeastZero(
      existing?.extensions?.boss?.projected_candidate_count
    );
    const storedJournalRecordCount = existing?.extensions?.boss?.projected_journal_record_count;
    const previousJournalRecordCount = journal
      ? Number.isSafeInteger(storedJournalRecordCount)
        ? integerAtLeastZero(storedJournalRecordCount)
        : Math.min(previousCandidateCount, journal.raw_record_count)
      : 0;
    const candidateEntries = journal
      ? journal.records.slice(previousJournalRecordCount).map((record) => ({
          result: record.result,
          resultIndex: record.result_index
        }))
      : results.slice(previousCandidateCount).map((result, offset) => ({
          result,
          resultIndex: previousCandidateCount + offset
        }));
    for (const { result, resultIndex } of candidateEntries) {
      if (!result || typeof result !== "object") continue;
      const evidence = evidenceForCandidate(
        normalizedKind,
        runId,
        result,
        sourceSnapshot,
        resultIndex,
        evidenceIndex
      );
      append("candidate.completed", {
        candidate: candidateEventData(result, evidence, resultIndex)
      });
    }
    const projectedCandidateCount = Math.max(previousCandidateCount, results.length);
    const projectedJournalRecordCount = journal
      ? Math.max(previousJournalRecordCount, journal.raw_record_count)
      : integerAtLeastZero(existing?.extensions?.boss?.projected_journal_record_count);
    append("run.progress", {
      goal,
      counters,
      ...(currentCandidate ? { current_candidate: currentCandidate } : {})
    });

    const heartbeatAt = isProducer
      ? isoNow()
      : isoOr(
          existing?.liveness?.heartbeat_at
          || sourceSnapshot?.heartbeat_at
          || sourceSnapshot?.updated_at
          || sourceSnapshot?.updatedAt
        );
    const snapshot = buildSnapshot(normalizedKind, sourceSnapshot, existing, {
      revision,
      lastEventSeq: seq,
      projectedCandidateCount,
      projectedJournalRecordCount,
      heartbeatAt,
      workerInstanceId
    });
    for (const event of events) assertRunEventV1(event);
    assertRunSnapshotV1(snapshot);
    for (const event of events) appendNdjson(eventsPath, event);
    writeJsonAtomic(snapshotPath, snapshot);
    for (const [evidenceId, locator] of Object.entries(evidenceIndex)) {
      try {
        writeJsonAtomic(path.join(evidenceDir, `${evidenceId}.json`), locator, 32 * 1024);
      } catch {
        // Missing evidence is candidate-scoped and never fails recruiting or the run projection.
      }
    }

    if (TERMINAL_STATES.has(snapshot.state)) {
      activeSources.delete(key);
      const exitSidecarPath = path.join(runDir, "worker-exit.json");
      if (
        isProducer
        || !TERMINAL_STATES.has(existing?.state)
        || !fs.existsSync(exitSidecarPath)
      ) {
        try {
          writeExitSidecar(normalizedKind, runId, snapshot, snapshot.state);
        } catch {
          // The public terminal snapshot remains authoritative.
        }
      }
    } else if (isProducer) {
      activeSources.set(key, {
        kind: normalizedKind,
        runId,
        source: clone(sourceSnapshot, {}),
        snapshot,
        desiredState: snapshot.state
      });
    }
    return snapshot;
  } finally {
    releaseWriterLock();
  }
}

export function writeBossMonitorProjectionNonfatal(kind, sourceSnapshot, eventContext = {}) {
  try {
    return writeBossMonitorProjection(kind, sourceSnapshot, eventContext);
  } catch {
    return null;
  }
}

function normalizeMonitorBaseUrl(value) {
  try {
    const parsed = new URL(normalizeText(value, 500));
    const loopback = parsed.hostname === "127.0.0.1"
      || parsed.hostname === "localhost"
      || parsed.hostname === "[::1]";
    if (
      parsed.protocol !== "http:"
      || !loopback
      || !parsed.port
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function recruitingMonitorHome() {
  const configured = normalizeText(process.env.RECRUITING_MONITOR_HOME || "", 4_000);
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), ".recruiting-run-monitor");
}

function readHealthyMonitorDaemon(expectedBaseUrl, monitorRuntimeHome, expectedSecretHash) {
  const daemon = readJson(path.join(monitorRuntimeHome, "daemon.json"));
  const heartbeatAt = validIsoTimestamp(daemon?.heartbeat_at);
  const heartbeatAgeMs = heartbeatAt ? Date.now() - Date.parse(heartbeatAt) : Number.POSITIVE_INFINITY;
  if (
    !daemon
    || !Number.isSafeInteger(daemon.pid)
    || daemon.pid <= 0
    || typeof daemon.instance_id !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(daemon.instance_id)
    || !validIsoTimestamp(daemon.started_at)
    || !heartbeatAt
    || heartbeatAgeMs > 15_000
    || heartbeatAgeMs < -5_000
    || !Array.isArray(daemon.providers)
    || new Set(daemon.providers).size !== daemon.providers.length
    || !daemon.providers.every((provider) => (
      typeof provider === "string"
      && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)
    ))
    || !daemon.providers.includes(BOSS_MONITOR_PROVIDER)
    || typeof daemon.link_secret_sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(daemon.link_secret_sha256)
    || daemon.link_secret_sha256 !== expectedSecretHash
    || !isPidAlive(daemon.pid)
  ) {
    return null;
  }
  const daemonBaseUrl = normalizeMonitorBaseUrl(daemon.base_url);
  if (!daemonBaseUrl || daemonBaseUrl !== expectedBaseUrl) return null;
  return {
    pid: daemon.pid,
    instance_id: daemon.instance_id,
    started_at: validIsoTimestamp(daemon.started_at),
    heartbeat_at: heartbeatAt,
    base_url: daemonBaseUrl,
    providers: [...daemon.providers],
    link_secret_sha256: daemon.link_secret_sha256
  };
}

export function createBossMonitoringBlock(kind, runId) {
  const normalizedKind = normalizeKind(kind);
  const normalizedRunId = normalizeRunId(runId);
  if (!monitoringEnabled() || !normalizedKind || !normalizedRunId) {
    return {
      ref: {
        provider: BOSS_MONITOR_PROVIDER,
        kind: normalizedKind || normalizeText(kind, 32),
        run_id: normalizedRunId || normalizeText(runId, 180)
      },
      contract_version: BOSS_MONITOR_CONTRACT_VERSION,
      availability: "disabled",
      dashboard_url: null
    };
  }
  const baseUrl = normalizeMonitorBaseUrl(
    process.env.RECRUITING_MONITOR_URL || "http://127.0.0.1:47831",
  );
  const configuredSecret = normalizeText(process.env.RECRUITING_MONITOR_LINK_SECRET || "", 4_000);
  const monitorRuntimeHome = recruitingMonitorHome();
  const secretPath = path.join(monitorRuntimeHome, "ticket-secret");
  let secret = configuredSecret;
  if (!secret) {
    try {
      secret = normalizeText(fs.readFileSync(secretPath, "utf8"), 4_000);
    } catch {
      secret = "";
    }
  }
  const secretHash = secret && Buffer.byteLength(secret, "utf8") >= 32
    ? crypto.createHash("sha256").update(secret, "utf8").digest("hex")
    : "";
  const daemon = baseUrl && secretHash
    ? readHealthyMonitorDaemon(baseUrl, monitorRuntimeHome, secretHash)
    : null;
  if (!baseUrl || !daemon || !secret || Buffer.byteLength(secret, "utf8") < 32) {
    return {
      ref: {
        provider: BOSS_MONITOR_PROVIDER,
        kind: normalizedKind,
        run_id: normalizedRunId
      },
      contract_version: BOSS_MONITOR_CONTRACT_VERSION,
      availability: "monitor_unavailable",
      dashboard_url: null
    };
  }
  const payload = {
    type: "ticket",
    id: crypto.randomBytes(18).toString("base64url"),
    exp: Date.now() + 60_000,
    ref: {
      provider: BOSS_MONITOR_PROVIDER,
      kind: normalizedKind,
      run_id: normalizedRunId
    }
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const token = `${body}.${signature}`;
  return {
    ref: payload.ref,
    contract_version: BOSS_MONITOR_CONTRACT_VERSION,
    availability: "ready",
    dashboard_url: `${baseUrl}/access/${token}`
  };
}

export const __test = {
  normalizeKind,
  normalizeState,
  normalizeStage,
  normalizeCounters,
  normalizeGoal,
  safeCandidate,
  sourceResults,
  recruitingMonitorHome,
  readHealthyMonitorDaemon,
  isPostInstallationV1Marker
};
