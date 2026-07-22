import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const JOURNAL_SCHEMA_VERSION = 1;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const JOURNAL_FILE_PREFIX = "candidate-results";
const DEFAULT_TAIL_MAX_ENTRIES = 20;
const DEFAULT_TAIL_MAX_BYTES = 64 * 1024;
const JOURNAL_READ_CHUNK_BYTES = 64 * 1024;
const MUTABLE_SLOT_COMPACTION_MIN_TOMBSTONES = 256;

function createJournalError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function assertAbsoluteRunDirectory(runDir) {
  const input = String(runDir || "");
  if (!input || !path.isAbsolute(input)) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_PATH_INVALID",
      "runDir must be an absolute path"
    );
  }
  if (/[\0\r\n]/.test(input)) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_PATH_INVALID",
      "runDir contains unsupported characters"
    );
  }
  return path.resolve(input);
}

function assertSafeRunId(runId) {
  const normalized = String(runId || "");
  if (!SAFE_RUN_ID_PATTERN.test(normalized)) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_RUN_ID_INVALID",
      "runId must contain only safe filename characters and be at most 128 characters"
    );
  }
  return normalized;
}

function assertContainedPath(runDir, journalPath) {
  const relative = path.relative(runDir, journalPath);
  if (!relative || relative === "." || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_PATH_INVALID",
      "Candidate result journal path must remain inside runDir"
    );
  }
  return journalPath;
}

function assertJournalIsRegularFile(journalPath) {
  if (!fs.existsSync(journalPath)) return null;
  const stats = fs.lstatSync(journalPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_PATH_INVALID",
      "Candidate result journal must be a regular file inside runDir"
    );
  }
  return stats;
}

function normalizeResultIndex(resultIndex) {
  const normalized = Number(resultIndex);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_RECORD_INVALID",
      "resultIndex must be a non-negative safe integer"
    );
  }
  return normalized;
}

function normalizeCandidateKey(candidateKey) {
  const normalized = String(candidateKey ?? "").trim();
  if (!normalized || normalized.length > 1024 || /[\0\r\n]/.test(normalized)) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_RECORD_INVALID",
      "candidateKey must be non-empty, single-line, and at most 1024 characters"
    );
  }
  return normalized;
}

function normalizeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_RECORD_INVALID",
      "result must be a non-null object"
    );
  }
  try {
    return JSON.parse(JSON.stringify(result));
  } catch (error) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_RECORD_INVALID",
      "result must be JSON serializable",
      error
    );
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateJournalRecord(record, { runId, lineNumber }) {
  const invalid = (reason) => {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_CORRUPT",
      `Candidate result journal line ${lineNumber} is invalid: ${reason}`
    );
  };
  if (!record || typeof record !== "object" || Array.isArray(record)) invalid("record must be an object");
  if (record.schema_version !== JOURNAL_SCHEMA_VERSION) invalid("unsupported schema_version");
  if (record.run_id !== runId) invalid("run_id does not match the requested run");
  if (
    typeof record.record_id !== "string"
    || !record.record_id
    || record.record_id.length > 256
    || /[\0\r\n]/.test(record.record_id)
  ) invalid("record_id is invalid");
  if (!Number.isSafeInteger(record.result_index) || record.result_index < 0) invalid("result_index is invalid");
  if (
    typeof record.candidate_key !== "string"
    || !record.candidate_key
    || record.candidate_key.length > 1024
    || /[\0\r\n]/.test(record.candidate_key)
  ) invalid("candidate_key is invalid");
  if (typeof record.recorded_at !== "string" || !record.recorded_at) invalid("recorded_at is invalid");
  if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) invalid("result is invalid");
  return record;
}

function findLastNewlineOffset(descriptor, fileSize) {
  const buffer = Buffer.allocUnsafe(Math.min(JOURNAL_READ_CHUNK_BYTES, fileSize));
  let cursor = fileSize;
  while (cursor > 0) {
    const bytesToRead = Math.min(buffer.length, cursor);
    const position = cursor - bytesToRead;
    const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, position);
    if (bytesRead !== bytesToRead) {
      throw createJournalError(
        "CANDIDATE_RESULT_JOURNAL_REPAIR_FAILED",
        "Could not inspect the candidate result journal append boundary"
      );
    }
    const relativeOffset = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (relativeOffset >= 0) return position + relativeOffset;
    cursor = position;
  }
  return -1;
}

function prepareJournalAppendBoundary({ journalPath, runId }) {
  if (!fs.existsSync(journalPath)) return;
  const stats = assertJournalIsRegularFile(journalPath);
  if (!stats || stats.size === 0) return;
  const finalByte = Buffer.allocUnsafe(1);
  let readDescriptor = null;
  let trailingStart = 0;
  let trailing = "";
  try {
    readDescriptor = fs.openSync(journalPath, "r");
    const bytesRead = fs.readSync(readDescriptor, finalByte, 0, 1, stats.size - 1);
    if (bytesRead !== 1) {
      throw createJournalError(
        "CANDIDATE_RESULT_JOURNAL_REPAIR_FAILED",
        "Could not inspect the candidate result journal append boundary"
      );
    }
    if (finalByte[0] === 0x0a) return;
    const lastNewline = findLastNewlineOffset(readDescriptor, stats.size);
    trailingStart = lastNewline + 1;
    const trailingBytes = Buffer.allocUnsafe(stats.size - trailingStart);
    const trailingBytesRead = fs.readSync(
      readDescriptor,
      trailingBytes,
      0,
      trailingBytes.length,
      trailingStart
    );
    if (trailingBytesRead !== trailingBytes.length) {
      throw createJournalError(
        "CANDIDATE_RESULT_JOURNAL_REPAIR_FAILED",
        "Could not read the candidate result journal trailing record"
      );
    }
    trailing = trailingBytes.toString("utf8");
  } finally {
    if (readDescriptor !== null) fs.closeSync(readDescriptor);
  }
  let completeRecord = false;
  let parsedTrailing = null;
  let trailingParsed = false;
  try {
    parsedTrailing = JSON.parse(trailing);
    trailingParsed = true;
  } catch {
    // A syntactically incomplete final record is uncommitted crash residue.
  }
  if (trailingParsed) {
    validateJournalRecord(parsedTrailing, {
      runId,
      lineNumber: "trailing record"
    });
    completeRecord = true;
  }

  let descriptor = null;
  try {
    if (completeRecord) {
      descriptor = fs.openSync(journalPath, "a");
      const bytesWritten = fs.writeSync(descriptor, Buffer.from("\n"));
      if (bytesWritten !== 1) {
        throw createJournalError(
          "CANDIDATE_RESULT_JOURNAL_APPEND_PARTIAL",
          "Could not terminate the complete trailing candidate result record"
        );
      }
    } else {
      descriptor = fs.openSync(journalPath, "r+");
      fs.ftruncateSync(descriptor, trailingStart);
    }
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (error?.code?.startsWith?.("CANDIDATE_RESULT_JOURNAL_")) throw error;
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_REPAIR_FAILED",
      `Could not repair candidate result journal append boundary: ${error?.message || error}`,
      error
    );
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function createMutableJournalState({ runId, journalPath }) {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    journalPath,
    rawRecordCount: 0,
    duplicateCount: 0,
    ignoredPartialTrailingLine: false,
    activeCount: 0,
    tombstoneCount: 0,
    slots: [],
    activeByRecordId: new Map(),
    byResultIndex: new Map(),
    byCandidateKey: new Map(),
    seenRecordIds: new Set()
  };
}

function compactMutableJournalSlots(state) {
  if (
    state.tombstoneCount < MUTABLE_SLOT_COMPACTION_MIN_TOMBSTONES
    || state.tombstoneCount < state.activeCount
  ) {
    return;
  }
  const compacted = [];
  for (const entry of state.slots) {
    if (!entry) continue;
    entry.slotIndex = compacted.length;
    compacted.push(entry);
  }
  state.slots = compacted;
  state.tombstoneCount = 0;
}

function removeActiveMutableJournalEntry(state, recordId) {
  const entry = state.activeByRecordId.get(recordId);
  if (!entry) return false;
  state.activeByRecordId.delete(recordId);
  if (state.byResultIndex.get(entry.record.result_index) === recordId) {
    state.byResultIndex.delete(entry.record.result_index);
  }
  if (state.byCandidateKey.get(entry.record.candidate_key) === recordId) {
    state.byCandidateKey.delete(entry.record.candidate_key);
  }
  if (state.slots[entry.slotIndex] === entry) {
    state.slots[entry.slotIndex] = null;
    state.tombstoneCount += 1;
  }
  state.activeCount -= 1;
  state.duplicateCount += 1;
  return true;
}

function applyRecordToMutableJournalState(state, record, {
  lineNumber,
  recordIdAlreadyChecked = false
}) {
  if (!recordIdAlreadyChecked && state.seenRecordIds.has(record.record_id)) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_CORRUPT",
      `Candidate result journal record_id is duplicated: ${record.record_id}`
    );
  }

  const resultIndexConflict = state.byResultIndex.get(record.result_index);
  const candidateKeyConflict = state.byCandidateKey.get(record.candidate_key);
  if (resultIndexConflict) {
    removeActiveMutableJournalEntry(state, resultIndexConflict);
  }
  if (candidateKeyConflict && candidateKeyConflict !== resultIndexConflict) {
    removeActiveMutableJournalEntry(state, candidateKeyConflict);
  }

  const entry = {
    record,
    lineNumber,
    slotIndex: state.slots.length
  };
  state.slots.push(entry);
  state.activeByRecordId.set(record.record_id, entry);
  state.byResultIndex.set(record.result_index, record.record_id);
  state.byCandidateKey.set(record.candidate_key, record.record_id);
  state.seenRecordIds.add(record.record_id);
  state.rawRecordCount += 1;
  state.activeCount += 1;
  state.ignoredPartialTrailingLine = false;
  compactMutableJournalSlots(state);
}

function collectActiveRecordsInAppendOrder(state) {
  const records = [];
  for (const entry of state.slots) {
    if (entry) records.push(entry.record);
  }
  return records;
}

function collectActiveTailRecords(state, maxEntries) {
  if (maxEntries === 0 || state.activeCount === 0) return [];
  const reverseTail = [];
  for (let index = state.slots.length - 1; index >= 0; index -= 1) {
    const entry = state.slots[index];
    if (!entry) continue;
    reverseTail.push(entry.record);
    if (reverseTail.length >= maxEntries) break;
  }
  reverseTail.reverse();
  return reverseTail;
}

function materializeMutableJournalSnapshot(state) {
  const records = collectActiveRecordsInAppendOrder(state);
  const resultRecords = [...records].sort((left, right) => (
    left.result_index - right.result_index
  ));
  return {
    schema_version: state.schemaVersion,
    run_id: state.runId,
    journal_path: state.journalPath,
    raw_record_count: state.rawRecordCount,
    committed_count: state.activeCount,
    duplicate_count: state.duplicateCount,
    ignored_partial_trailing_line: state.ignoredPartialTrailingLine,
    records,
    result_records: resultRecords,
    results: resultRecords.map((entry) => entry.result)
  };
}

function normalizeTailLimit(value, fallback, { min, max, label }) {
  if (value === undefined || value === null) return fallback;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_TAIL_LIMIT_INVALID",
      `${label} must be an integer between ${min} and ${max}`
    );
  }
  return normalized;
}

function utf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function compactTailRecord(record) {
  return {
    schema_version: record.schema_version,
    run_id: record.run_id,
    record_id: record.record_id,
    result_index: record.result_index,
    candidate_key: record.candidate_key,
    recorded_at: record.recorded_at,
    result_omitted: true,
    result_bytes: utf8Bytes(record.result)
  };
}

export function createCandidateResultJournalRunId(prefix = "recommend") {
  const normalizedPrefix = String(prefix || "");
  if (!SAFE_PREFIX_PATTERN.test(normalizedPrefix)) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_RUN_ID_INVALID",
      "run ID prefix must begin with a letter and contain only letters, digits, underscore, or hyphen"
    );
  }
  return `${normalizedPrefix}_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "")}`;
}

export function getCandidateResultJournalPath({ runDir, runId }) {
  const controlledRunDir = assertAbsoluteRunDirectory(runDir);
  const controlledRunId = assertSafeRunId(runId);
  const journalPath = path.resolve(
    controlledRunDir,
    `${JOURNAL_FILE_PREFIX}.${controlledRunId}.ndjson`
  );
  return assertContainedPath(controlledRunDir, journalPath);
}

function parseJournalLineIntoState({ state, line, lineNumber }) {
  if (!line.trim()) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_CORRUPT",
      `Candidate result journal line ${lineNumber} is unexpectedly empty`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_CORRUPT",
      `Candidate result journal line ${lineNumber} is not valid JSON`,
      error
    );
  }
  const record = validateJournalRecord(parsed, {
    runId: state.runId,
    lineNumber
  });
  applyRecordToMutableJournalState(state, record, { lineNumber });
}

function loadCandidateResultJournalState({ runDir, runId }) {
  const controlledRunId = assertSafeRunId(runId);
  const journalPath = getCandidateResultJournalPath({ runDir, runId: controlledRunId });
  const state = createMutableJournalState({
    runId: controlledRunId,
    journalPath
  });
  if (!fs.existsSync(journalPath)) {
    return state;
  }
  const stats = assertJournalIsRegularFile(journalPath);
  if (!stats || stats.size === 0) return state;

  const descriptor = fs.openSync(journalPath, "r");
  const buffer = Buffer.allocUnsafe(JOURNAL_READ_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineNumber = 0;
  let position = 0;
  try {
    while (position < stats.size) {
      const bytesToRead = Math.min(buffer.length, stats.size - position);
      const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) {
        throw createJournalError(
          "CANDIDATE_RESULT_JOURNAL_READ_FAILED",
          "Candidate result journal ended before its reported file size"
        );
      }
      position += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        lineNumber += 1;
        parseJournalLineIntoState({ state, line, lineNumber });
        newlineIndex = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
  } finally {
    fs.closeSync(descriptor);
  }

  if (pending.length > 0) {
    lineNumber += 1;
    if (!pending.trim()) {
      throw createJournalError(
        "CANDIDATE_RESULT_JOURNAL_CORRUPT",
        `Candidate result journal line ${lineNumber} is unexpectedly empty`
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(pending);
    } catch (error) {
      state.ignoredPartialTrailingLine = true;
      return state;
    }
    const record = validateJournalRecord(parsed, {
      runId: controlledRunId,
      lineNumber
    });
    applyRecordToMutableJournalState(state, record, { lineNumber });
  }
  return state;
}

export function readCandidateResultJournal({ runDir, runId }) {
  return materializeMutableJournalSnapshot(
    loadCandidateResultJournalState({ runDir, runId })
  );
}

export function buildCandidateResultJournalCheckpointTail(snapshot, {
  maxEntries = DEFAULT_TAIL_MAX_ENTRIES,
  maxBytes = DEFAULT_TAIL_MAX_BYTES
} = {}) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.records)) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_TAIL_INPUT_INVALID",
      "snapshot must be returned by readCandidateResultJournal"
    );
  }
  const entryLimit = normalizeTailLimit(maxEntries, DEFAULT_TAIL_MAX_ENTRIES, {
    min: 0,
    max: 1000,
    label: "maxEntries"
  });
  const byteLimit = normalizeTailLimit(maxBytes, DEFAULT_TAIL_MAX_BYTES, {
    min: 1024,
    max: 1024 * 1024,
    label: "maxBytes"
  });
  const source = entryLimit === 0 ? [] : snapshot.records.slice(-entryLimit);
  return buildCandidateResultJournalCheckpointTailFromSource({
    snapshot,
    source,
    totalRecordCount: snapshot.records.length,
    byteLimit
  });
}

function buildCandidateResultJournalCheckpointTailFromSource({
  snapshot,
  source,
  totalRecordCount,
  byteLimit
}) {
  const selected = [];
  const base = {
    schema_version: JOURNAL_SCHEMA_VERSION,
    run_id: snapshot.run_id,
    journal_file: path.basename(String(snapshot.journal_path || "")),
    raw_record_count: Number(snapshot.raw_record_count) || 0,
    committed_count: Number(snapshot.committed_count) || 0,
    duplicate_count: Number(snapshot.duplicate_count) || 0,
    ignored_partial_trailing_line: snapshot.ignored_partial_trailing_line === true,
    tail_truncated: totalRecordCount > source.length,
    tail_omitted_count: totalRecordCount,
    tail: []
  };

  for (let index = source.length - 1; index >= 0; index -= 1) {
    const record = source[index];
    let candidate = record;
    let proposed = [candidate, ...selected];
    let envelope = {
      ...base,
      tail_truncated: base.tail_truncated,
      tail_omitted_count: totalRecordCount - proposed.length,
      tail: proposed
    };
    if (utf8Bytes(envelope) > byteLimit) {
      candidate = compactTailRecord(record);
      proposed = [candidate, ...selected];
      envelope = {
        ...base,
        tail_truncated: true,
        tail_omitted_count: totalRecordCount - proposed.length,
        tail: proposed
      };
      if (utf8Bytes(envelope) > byteLimit) break;
    }
    selected.unshift(candidate);
  }

  const metadata = {
    ...base,
    tail_truncated: base.tail_truncated
      || selected.length < source.length
      || selected.some((record) => record.result_omitted === true),
    tail_omitted_count: totalRecordCount - selected.length,
    tail: selected
  };
  if (utf8Bytes(metadata) > byteLimit) {
    throw createJournalError(
      "CANDIDATE_RESULT_JOURNAL_TAIL_LIMIT_INVALID",
      "Candidate result checkpoint metadata could not be bounded by maxBytes"
    );
  }
  return metadata;
}

export function createCandidateResultJournal({
  runDir,
  runId,
  now = () => new Date().toISOString(),
  createRecordId = randomUUID
}) {
  const controlledRunDir = assertAbsoluteRunDirectory(runDir);
  const controlledRunId = assertSafeRunId(runId);
  const journalPath = getCandidateResultJournalPath({
    runDir: controlledRunDir,
    runId: controlledRunId
  });
  fs.mkdirSync(controlledRunDir, { recursive: true });
  let appendBoundaryPrepared = false;
  let cachedState = null;

  function ensureCachedState() {
    if (cachedState === null) {
      cachedState = loadCandidateResultJournalState({
        runDir: controlledRunDir,
        runId: controlledRunId
      });
    }
    return cachedState;
  }

  function append({ resultIndex, candidateKey, result }) {
    if (!appendBoundaryPrepared) {
      prepareJournalAppendBoundary({
        journalPath,
        runId: controlledRunId
      });
      appendBoundaryPrepared = true;
      cachedState = loadCandidateResultJournalState({
        runDir: controlledRunDir,
        runId: controlledRunId
      });
    }
    const record = {
      schema_version: JOURNAL_SCHEMA_VERSION,
      run_id: controlledRunId,
      record_id: String(createRecordId()),
      result_index: normalizeResultIndex(resultIndex),
      candidate_key: normalizeCandidateKey(candidateKey),
      recorded_at: String(now()),
      result: normalizeResult(result)
    };
    if (!record.record_id || record.record_id.length > 256 || /[\0\r\n]/.test(record.record_id)) {
      throw createJournalError(
        "CANDIDATE_RESULT_JOURNAL_RECORD_INVALID",
        "createRecordId must return a non-empty single-line identifier of at most 256 characters"
      );
    }
    if (!record.recorded_at) {
      throw createJournalError(
        "CANDIDATE_RESULT_JOURNAL_RECORD_INVALID",
        "now must return a non-empty timestamp"
      );
    }
    if (cachedState.seenRecordIds.has(record.record_id)) {
      throw createJournalError(
        "CANDIDATE_RESULT_JOURNAL_RECORD_INVALID",
        `createRecordId returned a duplicate identifier: ${record.record_id}`
      );
    }
    const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    let descriptor = null;
    try {
      descriptor = fs.openSync(journalPath, "a", 0o600);
      const bytesWritten = fs.writeSync(descriptor, line, 0, line.length);
      if (bytesWritten !== line.length) {
        throw createJournalError(
          "CANDIDATE_RESULT_JOURNAL_APPEND_PARTIAL",
          `Candidate result journal append wrote ${bytesWritten} of ${line.length} bytes`
        );
      }
      fs.fsyncSync(descriptor);
    } catch (error) {
      // The file may now end with a partially written record. Force the next
      // append attempt to inspect/repair the boundary and rebuild its cache
      // before writing anything else.
      appendBoundaryPrepared = false;
      cachedState = null;
      if (error?.code?.startsWith?.("CANDIDATE_RESULT_JOURNAL_")) throw error;
      throw createJournalError(
        "CANDIDATE_RESULT_JOURNAL_APPEND_FAILED",
        `Could not append candidate result journal: ${error?.message || error}`,
        error
      );
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
    applyRecordToMutableJournalState(cachedState, record, {
      lineNumber: cachedState.rawRecordCount + 1,
      recordIdAlreadyChecked: true
    });
    return cloneJson(record);
  }

  function read() {
    return cloneJson(materializeMutableJournalSnapshot(ensureCachedState()));
  }

  function checkpointTail(options = {}) {
    const state = ensureCachedState();
    const entryLimit = normalizeTailLimit(
      options.maxEntries,
      DEFAULT_TAIL_MAX_ENTRIES,
      { min: 0, max: 1000, label: "maxEntries" }
    );
    const byteLimit = normalizeTailLimit(
      options.maxBytes,
      DEFAULT_TAIL_MAX_BYTES,
      { min: 1024, max: 1024 * 1024, label: "maxBytes" }
    );
    return buildCandidateResultJournalCheckpointTailFromSource({
      snapshot: {
        run_id: state.runId,
        journal_path: state.journalPath,
        raw_record_count: state.rawRecordCount,
        committed_count: state.activeCount,
        duplicate_count: state.duplicateCount,
        ignored_partial_trailing_line: state.ignoredPartialTrailingLine
      },
      source: collectActiveTailRecords(state, entryLimit),
      totalRecordCount: state.activeCount,
      byteLimit
    });
  }

  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId: controlledRunId,
    path: journalPath,
    append,
    read,
    checkpointTail
  };
}
