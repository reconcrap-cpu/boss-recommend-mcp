import assert from "node:assert/strict";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_PAUSED,
  createRunLifecycleManager
} from "./core/run/index.js";

async function waitUntil(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

async function testSnapshotHookPersistsProgressAndCheckpointEvents() {
  const events = [];
  const manager = createRunLifecycleManager({
    idPrefix: "test",
    onSnapshot(snapshot, event) {
      events.push({
        type: event.type,
        status: snapshot.status,
        progress: snapshot.progress,
        checkpoint: snapshot.checkpoint
      });
    }
  });
  const started = manager.startRun({
    name: "snapshot-hook",
    task: async (run) => {
      run.updateProgress({ processed: 1 });
      run.checkpoint({ results: [{ index: 0 }] });
      return { processed: 1 };
    }
  });
  const final = await manager.waitForRun(started.runId);
  assert.equal(final.status, RUN_STATUS_COMPLETED);
  assert.equal(events.some((event) => event.type === "progress" && event.progress.processed === 1), true);
  assert.equal(events.some((event) => event.type === "checkpoint" && event.checkpoint.results?.length === 1), true);
  assert.equal(events.some((event) => event.type === "status" && event.status === RUN_STATUS_COMPLETED), true);
}

async function testRunCompletes() {
  const manager = createRunLifecycleManager({ idPrefix: "test" });
  const started = manager.startRun({
    name: "complete",
    task: async (run) => {
      run.setPhase("work");
      run.updateProgress({ processed: 1 });
      return { processed: 1 };
    }
  });
  const final = await manager.waitForRun(started.runId);
  assert.equal(final.status, RUN_STATUS_COMPLETED);
  assert.equal(final.progress.processed, 1);
  assert.equal(final.summary.processed, 1);
}

async function testPauseResumeCancel() {
  const manager = createRunLifecycleManager({ idPrefix: "test" });
  const started = manager.startRun({
    name: "pause-resume-cancel",
    task: async (run) => {
      let processed = 0;
      while (processed < 20) {
        await run.waitIfPaused();
        run.throwIfCanceled();
        processed += 1;
        run.updateProgress({ processed });
        await run.sleep(25);
      }
      return { processed };
    }
  });

  await waitUntil(() => manager.getRun(started.runId).progress.processed >= 2);
  manager.pauseRun(started.runId);
  const paused = await waitUntil(() => manager.getRun(started.runId).status === RUN_STATUS_PAUSED && manager.getRun(started.runId));
  const processedWhilePaused = paused.progress.processed;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(manager.getRun(started.runId).progress.processed, processedWhilePaused);

  manager.resumeRun(started.runId);
  await waitUntil(() => manager.getRun(started.runId).progress.processed > processedWhilePaused);
  manager.cancelRun(started.runId);
  const final = await manager.waitForRun(started.runId);
  assert.equal(final.status, RUN_STATUS_CANCELED);
}

async function testFailureSnapshotPreservesCdpDiagnostics() {
  const manager = createRunLifecycleManager({ idPrefix: "test" });
  const started = manager.startRun({
    name: "cdp-diagnostic",
    task: async (run) => {
      run.setPhase("recommend:list-read");
      const error = new Error("Could not find node with given id");
      error.cdp_method = "DOM.querySelectorAll";
      error.cdp_at = "2026-07-17T02:00:00.000Z";
      error.cdp_node_id = 77;
      error.cdp_param_keys = ["nodeId", "selector"];
      throw error;
    }
  });
  const final = await manager.waitForRun(started.runId);
  assert.equal(final.status, RUN_STATUS_FAILED);
  assert.equal(final.phase, "recommend:list-read");
  assert.equal(final.error.cdp_method, "DOM.querySelectorAll");
  assert.equal(final.error.cdp_at, "2026-07-17T02:00:00.000Z");
  assert.equal(final.error.cdp_node_id, 77);
  assert.deepEqual(final.error.cdp_param_keys, ["nodeId", "selector"]);
  assert.match(final.error.stack, /Could not find node with given id/);
}

await testRunCompletes();
await testSnapshotHookPersistsProgressAndCheckpointEvents();
await testPauseResumeCancel();
await testFailureSnapshotPreservesCdpDiagnostics();

console.log("Core run lifecycle tests passed");
