import {
  createCandidateResultJournal,
  getCandidateResultJournalPath,
  readCandidateResultJournal
} from "./candidate-result-journal.js";

const DEFAULT_RESULT_TAIL_LIMIT = 20;
const DEFAULT_RESULT_TAIL_BYTES = 64 * 1024;
const journalCache = new Map();

function normalizeResultIndex(result, fallback) {
  const value = Number(result?.index);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeCandidateKey(result, resultIndex) {
  const value = String(
    result?.candidate_key
    || result?.key
    || result?.candidate?.id
    || result?.id
    || `candidate-${resultIndex}`
  ).trim();
  return value || `candidate-${resultIndex}`;
}

function stableJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function getJournal(runDir, runId) {
  const key = `${runDir}\0${runId}`;
  let journal = journalCache.get(key);
  if (!journal) {
    journal = createCandidateResultJournal({ runDir, runId });
    journalCache.set(key, journal);
  }
  return journal;
}

export function getWorkflowCandidateJournalPath({ runDir, runId }) {
  return getCandidateResultJournalPath({ runDir, runId });
}

export function synchronizeWorkflowCandidateResults({
  runDir,
  runId,
  results = [],
  maxEntries = DEFAULT_RESULT_TAIL_LIMIT,
  maxBytes = DEFAULT_RESULT_TAIL_BYTES
}) {
  const journal = getJournal(runDir, runId);
  let snapshot = journal.read();
  const existingByIndex = new Map(
    snapshot.records.map((record) => [record.result_index, record])
  );
  for (let arrayIndex = 0; arrayIndex < results.length; arrayIndex += 1) {
    const result = results[arrayIndex];
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const resultIndex = normalizeResultIndex(result, arrayIndex);
    const candidateKey = normalizeCandidateKey(result, resultIndex);
    const existing = existingByIndex.get(resultIndex);
    if (
      existing
      && existing.candidate_key === candidateKey
      && stableJson(existing.result) === stableJson(result)
    ) {
      continue;
    }
    const record = journal.append({
      resultIndex,
      candidateKey,
      result
    });
    existingByIndex.set(resultIndex, record);
  }
  snapshot = journal.read();
  const metadata = journal.checkpointTail({ maxEntries, maxBytes });
  return {
    snapshot,
    metadata,
    results: metadata.tail.map((record) => record.result).filter(Boolean)
  };
}

export function boundedWorkflowCheckpoint({
  runDir,
  runId,
  checkpoint = {},
  maxEntries = DEFAULT_RESULT_TAIL_LIMIT,
  maxBytes = DEFAULT_RESULT_TAIL_BYTES
}) {
  const results = Array.isArray(checkpoint?.results) ? checkpoint.results : [];
  if (!results.length && !checkpoint?.candidate_result_journal) return checkpoint;
  const synchronized = synchronizeWorkflowCandidateResults({
    runDir,
    runId,
    results,
    maxEntries,
    maxBytes
  });
  if (
    synchronized.snapshot.committed_count <= maxEntries
    && Buffer.byteLength(JSON.stringify(checkpoint), "utf8") <= maxBytes
  ) {
    return checkpoint;
  }
  return {
    ...checkpoint,
    results: synchronized.results,
    results_count: synchronized.snapshot.committed_count,
    results_truncated: synchronized.snapshot.committed_count > synchronized.results.length,
    candidate_result_journal: {
      ...synchronized.metadata,
      superseded_record_count: synchronized.snapshot.duplicate_count
    }
  };
}

export function reconstructWorkflowCandidateResults({ runDir, runId }) {
  try {
    return readCandidateResultJournal({ runDir, runId }).records
      .sort((left, right) => left.result_index - right.result_index)
      .map((record) => record.result);
  } catch {
    return [];
  }
}

export function compactWorkflowResultForState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const compacted = { ...value };
  if (Array.isArray(compacted.results)) {
    const resultCount = compacted.results.length;
    delete compacted.results;
    compacted.results_count = Math.max(
      Number.isSafeInteger(Number(compacted.results_count))
        ? Number(compacted.results_count)
        : 0,
      resultCount
    );
    compacted.results_truncated = resultCount > 0;
  }
  for (const key of ["summary", "checkpoint"]) {
    if (compacted[key] && typeof compacted[key] === "object" && !Array.isArray(compacted[key])) {
      compacted[key] = compactWorkflowResultForState(compacted[key]);
    }
  }
  return compacted;
}

export function __resetWorkflowCandidateJournalsForTests() {
  journalCache.clear();
}
