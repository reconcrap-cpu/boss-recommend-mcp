import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetWorkflowCandidateJournalsForTests,
  boundedWorkflowCheckpoint,
  compactWorkflowResultForState,
  getWorkflowCandidateJournalPath,
  reconstructWorkflowCandidateResults
} from "./core/run/workflow-candidate-journal.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "boss-workflow-journal-"));
const runId = "search-journal-fixture";

try {
  const results = Array.from({ length: 1_000 }, (_, index) => ({
    index,
    candidate_key: `candidate-${index}`,
    candidate: { name: `候选人 ${index}` },
    screening: {
      passed: index % 4 === 0,
      score: index % 100,
      reasons: [`reason-${index}`]
    }
  }));
  const checkpoint = boundedWorkflowCheckpoint({
    runDir: root,
    runId,
    checkpoint: {
      in_progress_candidate: null,
      results
    }
  });
  assert.equal(checkpoint.results_count, 1_000);
  assert.equal(checkpoint.results_truncated, true);
  assert.ok(checkpoint.results.length <= 20);
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), "utf8") < 64 * 1024);
  assert.equal(reconstructWorkflowCandidateResults({ runDir: root, runId }).length, 1_000);
  const compactedRunState = compactWorkflowResultForState({
    status: "COMPLETED",
    results,
    summary: { results }
  });
  assert.equal("results" in compactedRunState, false);
  assert.equal("results" in compactedRunState.summary, false);
  assert.equal(compactedRunState.results_count, 1_000);
  assert.equal(compactedRunState.summary.results_count, 1_000);
  assert.ok(Buffer.byteLength(JSON.stringify(compactedRunState), "utf8") < 4 * 1024);

  results[5] = {
    ...results[5],
    screening: {
      ...results[5].screening,
      score: 99
    }
  };
  const updated = boundedWorkflowCheckpoint({
    runDir: root,
    runId,
    checkpoint: { results }
  });
  assert.ok(updated.candidate_result_journal.superseded_record_count >= 1);
  assert.equal(
    reconstructWorkflowCandidateResults({ runDir: root, runId })[5].screening.score,
    99
  );

  const journalPath = getWorkflowCandidateJournalPath({ runDir: root, runId });
  fs.appendFileSync(journalPath, "{\"partial\":", "utf8");
  __resetWorkflowCandidateJournalsForTests();
  const afterRestart = boundedWorkflowCheckpoint({
    runDir: root,
    runId,
    checkpoint: {
      results: [
        ...results,
        {
          index: 1_000,
          candidate_key: "candidate-1000",
          screening: { passed: true, score: 88 }
        }
      ]
    }
  });
  assert.equal(afterRestart.results_count, 1_001);
  assert.equal(reconstructWorkflowCandidateResults({ runDir: root, runId }).length, 1_001);

  console.log("Search/chat candidate journal crash, restart, truncation, and 1,000-result tests passed.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
