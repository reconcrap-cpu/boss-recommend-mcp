import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUN_MODE_ASYNC,
  RUN_STATE_PAUSED,
  RUN_STAGE_SCREEN,
  RUN_STATE_COMPLETED,
  RUN_STATE_QUEUED,
  RUN_STATE_RUNNING,
  cleanupExpiredRuns,
  createRunId,
  createRunStateSnapshot,
  getRunsDir,
  readRunState,
  touchRunHeartbeat,
  updateRunProgress,
  updateRunState,
  writeRunState
} from "./run-state.js";

function withTempHome(testFn) {
  const previous = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-run-state-"));
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  try {
    testFn(tempHome);
  } finally {
    if (previous === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previous;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

function testRunStateLifecycle() {
  withTempHome(() => {
    const runId = createRunId();
    const queued = writeRunState(createRunStateSnapshot({
      runId,
      mode: RUN_MODE_ASYNC,
      state: RUN_STATE_QUEUED,
      stage: "preflight",
      context: {
        workspace_root: "C:/workspace",
        instruction: "筛选有 MCP 经验候选人",
        confirmation: {
          final_confirmed: true
        }
      },
      control: {
        pause_requested: false
      },
      resume: {
        checkpoint_path: `C:/workspace/.state/${runId}.checkpoint.json`,
        pause_control_path: `C:/workspace/.state/${runId}.json`,
        output_csv: "C:/workspace/result.csv"
      }
    }));
    assert.equal(queued.run_id, runId);
    assert.equal(queued.state, RUN_STATE_QUEUED);
    assert.equal(queued.context.workspace_root, "C:/workspace");
    assert.equal(queued.resume.output_csv, "C:/workspace/result.csv");
    assert.equal(queued.control.cancel_requested, false);

    const running = updateRunState(runId, {
      state: RUN_STATE_RUNNING,
      stage: RUN_STAGE_SCREEN,
      last_message: "screening in progress"
    });
    assert.equal(running.state, RUN_STATE_RUNNING);
    assert.equal(running.stage, RUN_STAGE_SCREEN);
    const heartbeatBeforeProgress = running.heartbeat_at;

    const progressed = updateRunProgress(runId, {
      processed: 7,
      passed: 2,
      skipped: 5,
      greet_count: 1
    });
    assert.equal(progressed.progress.processed, 7);
    assert.equal(progressed.progress.passed, 2);
    assert.equal(progressed.progress.skipped, 5);
    assert.equal(progressed.progress.greet_count, 1);
    assert.equal(progressed.heartbeat_at, heartbeatBeforeProgress);

    const paused = updateRunState(runId, {
      state: RUN_STATE_PAUSED,
      control: {
        pause_requested: true,
        pause_requested_at: "2026-01-01T00:00:00.000Z",
        pause_requested_by: "pause_recommend_pipeline_run",
        cancel_requested: true
      },
      resume: {
        output_csv: "C:/workspace/result-partial.csv",
        last_paused_at: "2026-01-01T00:00:01.000Z"
      }
    });
    assert.equal(paused.state, RUN_STATE_PAUSED);
    assert.equal(paused.control.pause_requested, true);
    assert.equal(paused.control.pause_requested_by, "pause_recommend_pipeline_run");
    assert.equal(paused.control.cancel_requested, true);
    assert.equal(paused.resume.output_csv, "C:/workspace/result-partial.csv");

    const heartbeated = touchRunHeartbeat(runId, "still running");
    assert.equal(heartbeated.last_message, "still running");
    assert.equal(Date.parse(heartbeated.heartbeat_at) >= Date.parse(heartbeatBeforeProgress), true);

    const completed = updateRunState(runId, {
      state: RUN_STATE_COMPLETED,
      stage: "finalize",
      result: {
        status: "COMPLETED",
        result: {
          processed_count: 7
        }
      }
    });
    assert.equal(completed.state, RUN_STATE_COMPLETED);
    assert.equal(completed.result.status, "COMPLETED");

    const reloaded = readRunState(runId);
    assert.equal(reloaded.state, RUN_STATE_COMPLETED);
    assert.equal(reloaded.progress.processed, 7);
  });
}

function testRunStateCleanup() {
  withTempHome(() => {
    const runId = createRunId();
    writeRunState(createRunStateSnapshot({ runId, mode: RUN_MODE_ASYNC }));
    const runFile = path.join(getRunsDir(), `${runId}.json`);
    const oldSeconds = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000);
    fs.utimesSync(runFile, oldSeconds, oldSeconds);

    const cleaned = cleanupExpiredRuns(1000);
    assert.equal(cleaned.removed.some((item) => item.endsWith(`${runId}.json`)), true);
    assert.equal(fs.existsSync(runFile), false);
  });
}

function main() {
  testRunStateLifecycle();
  testRunStateCleanup();
  console.log("run-state tests passed");
}

main();
