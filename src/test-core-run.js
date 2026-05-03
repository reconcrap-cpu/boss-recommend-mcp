import assert from "node:assert/strict";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_COMPLETED,
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

await testRunCompletes();
await testPauseResumeCancel();

console.log("Core run lifecycle tests passed");
