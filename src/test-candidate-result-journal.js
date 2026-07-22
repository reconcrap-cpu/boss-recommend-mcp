import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCandidateResultJournalCheckpointTail,
  createCandidateResultJournal,
  createCandidateResultJournalRunId,
  getCandidateResultJournalPath,
  readCandidateResultJournal
} from "./core/run/candidate-result-journal.js";

function withTemporaryRunDirectory(test) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-candidate-result-journal-"));
  try {
    test(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function appendFixture(journal, resultIndex, candidateKey, patch = {}) {
  return journal.append({
    resultIndex,
    candidateKey,
    result: {
      candidate_id: candidateKey,
      candidate_name: `Candidate ${candidateKey}`,
      passed: false,
      ...patch
    }
  });
}

function testControlledPathAndUniqueRunIds() {
  withTemporaryRunDirectory((runDir) => {
    const ids = new Set();
    for (let index = 0; index < 250; index += 1) {
      ids.add(createCandidateResultJournalRunId("recommend"));
    }
    assert.equal(ids.size, 250);

    const [firstRunId, secondRunId] = [...ids];
    const firstPath = getCandidateResultJournalPath({ runDir, runId: firstRunId });
    const secondPath = getCandidateResultJournalPath({ runDir, runId: secondRunId });
    assert.equal(path.isAbsolute(firstPath), true);
    assert.equal(path.dirname(firstPath), path.resolve(runDir));
    assert.notEqual(firstPath, secondPath);

    assert.throws(
      () => getCandidateResultJournalPath({ runDir: "relative/run", runId: firstRunId }),
      (error) => error.code === "CANDIDATE_RESULT_JOURNAL_PATH_INVALID"
    );
    assert.throws(
      () => getCandidateResultJournalPath({ runDir, runId: "../escape" }),
      (error) => error.code === "CANDIDATE_RESULT_JOURNAL_RUN_ID_INVALID"
    );
  });
}

function testSynchronousAppendAndImmediateReconstruction() {
  withTemporaryRunDirectory((runDir) => {
    let clock = 0;
    let recordId = 0;
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_sync",
      now: () => `2026-07-22T00:00:0${clock++}.000Z`,
      createRecordId: () => `record-${recordId++}`
    });
    const first = appendFixture(journal, 0, "candidate-a", { passed: true });
    assert.equal(fs.existsSync(journal.path), true);
    assert.equal(first.result_index, 0);

    const afterFirstAppend = journal.read();
    assert.equal(afterFirstAppend.committed_count, 1);
    assert.deepEqual(afterFirstAppend.results, [{
      candidate_id: "candidate-a",
      candidate_name: "Candidate candidate-a",
      passed: true
    }]);

    appendFixture(journal, 1, "candidate-b");
    const lines = fs.readFileSync(journal.path, "utf8").split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[2], "");
    assert.equal(journal.read().committed_count, 2);
  });
}

function testAppendFlushesBeforeReturning() {
  withTemporaryRunDirectory((runDir) => {
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_fsync"
    });
    const originalFsyncSync = fs.fsyncSync;
    let fsyncCalls = 0;
    fs.fsyncSync = (descriptor) => {
      fsyncCalls += 1;
      return originalFsyncSync(descriptor);
    };
    try {
      appendFixture(journal, 0, "candidate-a");
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
    assert.equal(fsyncCalls, 1);
    assert.equal(journal.read().committed_count, 1);
  });
}

function testPartialAppendFailureIsRepairedBeforeRetry() {
  withTemporaryRunDirectory((runDir) => {
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_partial_append_retry"
    });
    const originalWriteSync = fs.writeSync;
    let partialWriteInjected = false;
    fs.writeSync = (descriptor, buffer, offset, length, position) => {
      if (!partialWriteInjected && Buffer.isBuffer(buffer)) {
        partialWriteInjected = true;
        const partialLength = Math.max(1, Math.floor(length / 2));
        return originalWriteSync(descriptor, buffer, offset, partialLength, position);
      }
      return originalWriteSync(descriptor, buffer, offset, length, position);
    };
    try {
      assert.throws(
        () => appendFixture(journal, 0, "candidate-a", { attempt: "partial" }),
        (error) => error.code === "CANDIDATE_RESULT_JOURNAL_APPEND_PARTIAL"
      );
    } finally {
      fs.writeSync = originalWriteSync;
    }

    appendFixture(journal, 0, "candidate-a", { attempt: "retry" });
    const recovered = readCandidateResultJournal({
      runDir,
      runId: "recommend_run_partial_append_retry"
    });
    assert.equal(partialWriteInjected, true);
    assert.equal(recovered.raw_record_count, 1);
    assert.equal(recovered.committed_count, 1);
    assert.equal(recovered.ignored_partial_trailing_line, false);
    assert.equal(recovered.results[0].attempt, "retry");
  });
}

function testPartialTrailingLineIsIgnoredButInteriorCorruptionFails() {
  withTemporaryRunDirectory((runDir) => {
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_partial"
    });
    appendFixture(journal, 0, "candidate-a");
    fs.appendFileSync(journal.path, '{"schema_version":1,"run_id":"recommend_run_partial"');

    const recovered = readCandidateResultJournal({
      runDir,
      runId: "recommend_run_partial"
    });
    assert.equal(recovered.committed_count, 1);
    assert.equal(recovered.ignored_partial_trailing_line, true);

    fs.appendFileSync(journal.path, "\n");
    assert.throws(
      () => readCandidateResultJournal({
        runDir,
        runId: "recommend_run_partial"
      }),
      (error) => error.code === "CANDIDATE_RESULT_JOURNAL_CORRUPT"
    );
  });

  withTemporaryRunDirectory((runDir) => {
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_valid_no_newline"
    });
    appendFixture(journal, 0, "candidate-a");
    const complete = fs.readFileSync(journal.path, "utf8").replace(/\n$/, "");
    fs.writeFileSync(journal.path, complete);
    const recovered = readCandidateResultJournal({
      runDir,
      runId: "recommend_run_valid_no_newline"
    });
    assert.equal(recovered.committed_count, 1);
    assert.equal(recovered.ignored_partial_trailing_line, false);
  });
}

function testFirstAppendAfterRestartRepairsOnlyTheTrailingBoundary() {
  withTemporaryRunDirectory((runDir) => {
    const runId = "recommend_run_restart_partial";
    const initial = createCandidateResultJournal({ runDir, runId });
    appendFixture(initial, 0, "candidate-a");
    fs.appendFileSync(initial.path, '{"schema_version":1,"run_id":"recommend_run_restart_partial"');

    const restarted = createCandidateResultJournal({ runDir, runId });
    assert.equal(restarted.read().ignored_partial_trailing_line, true);
    appendFixture(restarted, 1, "candidate-b");
    const recovered = restarted.read();
    assert.equal(recovered.ignored_partial_trailing_line, false);
    assert.equal(recovered.raw_record_count, 2);
    assert.deepEqual(
      recovered.result_records.map((record) => record.candidate_key),
      ["candidate-a", "candidate-b"]
    );
  });

  withTemporaryRunDirectory((runDir) => {
    const runId = "recommend_run_restart_complete";
    const initial = createCandidateResultJournal({ runDir, runId });
    appendFixture(initial, 0, "candidate-a");
    const completeWithoutNewline = fs.readFileSync(initial.path, "utf8").replace(/\n$/, "");
    fs.writeFileSync(initial.path, completeWithoutNewline);

    const restarted = createCandidateResultJournal({ runDir, runId });
    appendFixture(restarted, 1, "candidate-b");
    const recovered = restarted.read();
    assert.equal(recovered.raw_record_count, 2);
    assert.deepEqual(
      recovered.result_records.map((record) => record.candidate_key),
      ["candidate-a", "candidate-b"]
    );
  });
}

function testLatestRecordWinsByResultIndexOrCandidateKey() {
  withTemporaryRunDirectory((runDir) => {
    let recordId = 0;
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_dedupe",
      createRecordId: () => `record-${recordId++}`
    });
    appendFixture(journal, 0, "candidate-a", { revision: 1 });
    appendFixture(journal, 1, "candidate-b", { revision: 1 });
    appendFixture(journal, 0, "candidate-c", { revision: 2 });
    appendFixture(journal, 2, "candidate-b", { revision: 2 });

    const reconstructed = journal.read();
    assert.equal(reconstructed.raw_record_count, 4);
    assert.equal(reconstructed.committed_count, 2);
    assert.equal(reconstructed.duplicate_count, 2);
    assert.deepEqual(
      reconstructed.result_records.map((record) => [record.result_index, record.candidate_key]),
      [[0, "candidate-c"], [2, "candidate-b"]]
    );
    assert.deepEqual(
      reconstructed.results.map((result) => [result.candidate_id, result.revision]),
      [["candidate-c", 2], ["candidate-b", 2]]
    );
  });
}

function testRunIdentityCannotBeMixed() {
  withTemporaryRunDirectory((runDir) => {
    const runId = "recommend_run_identity";
    const journal = createCandidateResultJournal({ runDir, runId });
    appendFixture(journal, 0, "candidate-a");
    const record = JSON.parse(fs.readFileSync(journal.path, "utf8").trim());
    record.run_id = "different-run";
    fs.appendFileSync(journal.path, `${JSON.stringify(record)}\n`);
    assert.throws(
      () => readCandidateResultJournal({ runDir, runId }),
      (error) => error.code === "CANDIDATE_RESULT_JOURNAL_CORRUPT"
    );
  });
}

function testCheckpointTailIsEntryAndByteBounded() {
  withTemporaryRunDirectory((runDir) => {
    let recordId = 0;
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_tail",
      createRecordId: () => `record-${recordId++}`
    });
    for (let index = 0; index < 12; index += 1) {
      appendFixture(journal, index, `candidate-${index}`, {
        detail: "x".repeat(index === 11 ? 5000 : 300)
      });
    }

    const metadata = journal.checkpointTail({ maxEntries: 4, maxBytes: 1800 });
    assert.equal(Buffer.byteLength(JSON.stringify(metadata), "utf8") <= 1800, true);
    assert.equal(metadata.committed_count, 12);
    assert.equal(metadata.tail.length <= 4, true);
    assert.equal(metadata.tail_truncated, true);
    assert.equal(metadata.tail.at(-1).result_index, 11);
    assert.equal(metadata.tail.at(-1).result_omitted, true);
    assert.equal(metadata.tail_omitted_count, 12 - metadata.tail.length);

    const emptyTail = buildCandidateResultJournalCheckpointTail(journal.read(), {
      maxEntries: 0,
      maxBytes: 1024
    });
    assert.deepEqual(emptyTail.tail, []);
    assert.equal(emptyTail.tail_omitted_count, 12);
  });
}

function testStatefulCheckpointTailDoesNotRescanTheGrowingFile() {
  withTemporaryRunDirectory((runDir) => {
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_cached_tail"
    });
    appendFixture(journal, 0, "candidate-a");
    appendFixture(journal, 1, "candidate-b");

    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = () => {
      throw new Error("checkpointTail unexpectedly rescanned the journal");
    };
    let metadata;
    try {
      metadata = journal.checkpointTail({ maxEntries: 2, maxBytes: 4096 });
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    assert.deepEqual(
      metadata.tail.map((record) => record.candidate_key),
      ["candidate-a", "candidate-b"]
    );
  });
}

function testLargeJournalReadStreamsAcrossUtf8ChunkBoundaries() {
  withTemporaryRunDirectory((runDir) => {
    const runId = "recommend_run_streaming_read";
    const journal = createCandidateResultJournal({ runDir, runId });
    appendFixture(journal, 0, "candidate-large", {
      detail: "中".repeat(30_000)
    });

    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = () => {
      throw new Error("journal reconstruction unexpectedly loaded the whole file");
    };
    let reconstructed;
    try {
      reconstructed = readCandidateResultJournal({ runDir, runId });
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    assert.equal(reconstructed.committed_count, 1);
    assert.equal(reconstructed.results[0].detail.length, 30_000);
    assert.equal(reconstructed.results[0].detail.at(-1), "中");
  });
}

function testHotAppendPathAvoidsGrowingArrayScansAndCompactsSupersededRows() {
  withTemporaryRunDirectory((runDir) => {
    let recordId = 0;
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_hot_append",
      createRecordId: () => `record-${recordId++}`
    });
    for (let index = 0; index < 64; index += 1) {
      appendFixture(journal, index, `candidate-${index}`, { revision: 0 });
    }

    const originalFilter = Array.prototype.filter;
    const originalSort = Array.prototype.sort;
    let filterCalls = 0;
    let sortCalls = 0;
    Array.prototype.filter = function (...args) {
      filterCalls += 1;
      return originalFilter.apply(this, args);
    };
    Array.prototype.sort = function (...args) {
      sortCalls += 1;
      return originalSort.apply(this, args);
    };
    try {
      for (let revision = 1; revision <= 270; revision += 1) {
        appendFixture(journal, 0, "candidate-0", { revision });
      }
      for (let index = 64; index < 96; index += 1) {
        appendFixture(journal, index, `candidate-${index}`, { revision: 0 });
      }
    } finally {
      Array.prototype.filter = originalFilter;
      Array.prototype.sort = originalSort;
    }

    assert.equal(filterCalls, 0);
    assert.equal(sortCalls, 0);
    const reconstructed = journal.read();
    assert.equal(reconstructed.raw_record_count, 366);
    assert.equal(reconstructed.committed_count, 96);
    assert.equal(reconstructed.duplicate_count, 270);
    assert.equal(reconstructed.results[0].candidate_id, "candidate-0");
    assert.equal(reconstructed.results[0].revision, 270);
  });
}

function testInvalidAppendDoesNotCreateARecord() {
  withTemporaryRunDirectory((runDir) => {
    const journal = createCandidateResultJournal({
      runDir,
      runId: "recommend_run_validation"
    });
    assert.throws(
      () => journal.append({ resultIndex: -1, candidateKey: "candidate-a", result: {} }),
      (error) => error.code === "CANDIDATE_RESULT_JOURNAL_RECORD_INVALID"
    );
    assert.throws(
      () => journal.append({ resultIndex: 0, candidateKey: "", result: {} }),
      (error) => error.code === "CANDIDATE_RESULT_JOURNAL_RECORD_INVALID"
    );
    assert.equal(fs.existsSync(journal.path), false);
  });
}

testControlledPathAndUniqueRunIds();
testSynchronousAppendAndImmediateReconstruction();
testAppendFlushesBeforeReturning();
testPartialAppendFailureIsRepairedBeforeRetry();
testPartialTrailingLineIsIgnoredButInteriorCorruptionFails();
testFirstAppendAfterRestartRepairsOnlyTheTrailingBoundary();
testLatestRecordWinsByResultIndexOrCandidateKey();
testRunIdentityCannotBeMixed();
testCheckpointTailIsEntryAndByteBounded();
testStatefulCheckpointTailDoesNotRescanTheGrowingFile();
testLargeJournalReadStreamsAcrossUtf8ChunkBoundaries();
testHotAppendPathAvoidsGrowingArrayScansAndCompactsSupersededRows();
testInvalidAppendDoesNotCreateARecord();

console.log("Candidate result journal tests passed");
