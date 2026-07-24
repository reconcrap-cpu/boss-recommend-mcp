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
        phase: snapshot.phase,
        progress: snapshot.progress,
        checkpoint: snapshot.checkpoint
      });
    }
  });
  const started = manager.startRun({
    name: "snapshot-hook",
    task: async (run) => {
      run.setPhase("test:phase");
      run.updateProgress({ processed: 1 });
      run.checkpoint({ results: [{ index: 0 }] });
      return { processed: 1 };
    }
  });
  const final = await manager.waitForRun(started.runId);
  assert.equal(final.status, RUN_STATUS_COMPLETED);
  assert.equal(events.some((event) => event.type === "progress" && event.progress.processed === 1), true);
  assert.equal(events.some((event) => event.type === "phase" && event.phase === "test:phase"), true);
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
      error.cdp_backend_node_id = 78;
      error.cdp_search_id = "search-9";
      error.cdp_connection_epoch = 3;
      error.cdp_replay_policy = "not_allowlisted";
      error.cdp_reconnected = true;
      error.cdp_reconnected_epoch = 4;
      error.cdp_replay_suppressed = true;
      error.cdp_outcome_unknown = true;
      error.cdp_reconnect_error = "replacement target unavailable";
      error.cdp_param_keys = ["nodeId", "selector"];
      error.params = { selector: ".candidate-card", token: "must-not-leak" };
      error.cdp_params = { nodeId: 77, selector: ".candidate-card" };
      const cause = new Error("guarded client source error");
      cause.cdp_method = "DOM.querySelectorAll";
      cause.cdp_node_id = 77;
      cause.cdp_connection_epoch = 3;
      cause.cdp_replay_policy = "not_allowlisted";
      cause.cdp_reconnected = true;
      cause.cdp_reconnected_epoch = 4;
      cause.cdp_replay_suppressed = true;
      cause.cdp_outcome_unknown = true;
      cause.cdp_param_keys = ["nodeId", "selector"];
      cause.params = { token: "cause-must-not-leak" };
      error.cause = cause;
      throw error;
    }
  });
  const final = await manager.waitForRun(started.runId);
  assert.equal(final.status, RUN_STATUS_FAILED);
  assert.equal(final.phase, "recommend:list-read");
  assert.equal(final.error.cdp_method, "DOM.querySelectorAll");
  assert.equal(final.error.cdp_at, "2026-07-17T02:00:00.000Z");
  assert.equal(final.error.cdp_node_id, 77);
  assert.equal(final.error.cdp_backend_node_id, 78);
  assert.equal(final.error.cdp_search_id, "search-9");
  assert.equal(final.error.cdp_connection_epoch, 3);
  assert.equal(final.error.cdp_replay_policy, "not_allowlisted");
  assert.equal(final.error.cdp_reconnected, true);
  assert.equal(final.error.cdp_reconnected_epoch, 4);
  assert.equal(final.error.cdp_replay_suppressed, true);
  assert.equal(final.error.cdp_outcome_unknown, true);
  assert.equal(final.error.cdp_reconnect_error, "replacement target unavailable");
  assert.deepEqual(final.error.cdp_param_keys, ["nodeId", "selector"]);
  assert.equal(final.error.phase, "recommend:list-read");
  assert.equal(final.error.params, undefined);
  assert.equal(final.error.cdp_params, undefined);
  assert.equal(final.error.cause.cdp_connection_epoch, 3);
  assert.equal(final.error.cause.cdp_replay_policy, "not_allowlisted");
  assert.equal(final.error.cause.cdp_reconnected, true);
  assert.equal(final.error.cause.cdp_reconnected_epoch, 4);
  assert.equal(final.error.cause.cdp_replay_suppressed, true);
  assert.equal(final.error.cause.cdp_outcome_unknown, true);
  assert.deepEqual(final.error.cause.cdp_param_keys, ["nodeId", "selector"]);
  assert.equal(final.error.cause.phase, "recommend:list-read");
  assert.equal(final.error.cause.params, undefined);
  assert.doesNotMatch(JSON.stringify(final.error), /must-not-leak/);
  assert.match(final.error.stack, /Could not find node with given id/);
}

async function testFailureSnapshotPreservesAttachedRunSummary() {
  const manager = createRunLifecycleManager({ idPrefix: "test" });
  const expectedSummary = {
    list_end_reason: "greet_outcome_unknown",
    results: [{ candidate_id: "candidate-unknown" }]
  };
  const started = manager.startRun({
    name: "attached-summary-failure",
    task: async () => {
      const error = new Error("terminal post-action failure");
      error.code = "RECOMMEND_GREET_OUTCOME_UNKNOWN";
      error.run_summary = expectedSummary;
      throw error;
    }
  });
  const final = await manager.waitForRun(started.runId);
  assert.equal(final.status, RUN_STATUS_FAILED);
  assert.equal(final.error.code, "RECOMMEND_GREET_OUTCOME_UNKNOWN");
  assert.deepEqual(final.summary, expectedSummary);
}

async function testSleepCleansAbortListenersAfterResolution() {
  const originalAddEventListener = AbortSignal.prototype.addEventListener;
  const originalRemoveEventListener = AbortSignal.prototype.removeEventListener;
  const activeAbortListeners = new Set();
  let addedAbortListeners = 0;
  let removedAbortListeners = 0;
  AbortSignal.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
    if (type === "abort") {
      addedAbortListeners += 1;
      activeAbortListeners.add(listener);
    }
    return originalAddEventListener.call(this, type, listener, options);
  };
  AbortSignal.prototype.removeEventListener = function patchedRemoveEventListener(type, listener, options) {
    if (type === "abort" && activeAbortListeners.delete(listener)) {
      removedAbortListeners += 1;
    }
    return originalRemoveEventListener.call(this, type, listener, options);
  };

  try {
    const manager = createRunLifecycleManager({ idPrefix: "test_listener_cleanup" });
    const started = manager.startRun({
      name: "sleep-listener-cleanup",
      task: async (run) => {
        for (let index = 0; index < 40; index += 1) {
          await run.sleep(1);
        }
        return { processed: 40 };
      }
    });
    const final = await manager.waitForRun(started.runId);
    assert.equal(final.status, RUN_STATUS_COMPLETED);

    const canceledSleep = manager.startRun({
      name: "sleep-listener-cleanup-on-cancel",
      task: async (run) => {
        run.updateProgress({ sleeping: true });
        await run.sleep(10000);
      }
    });
    await waitUntil(() => manager.getRun(canceledSleep.runId).progress.sleeping === true);
    manager.cancelRun(canceledSleep.runId);
    const canceledFinal = await manager.waitForRun(canceledSleep.runId);
    assert.equal(canceledFinal.status, RUN_STATUS_CANCELED);

    assert.equal(addedAbortListeners, 41);
    assert.equal(removedAbortListeners, 41);
    assert.equal(activeAbortListeners.size, 0);
  } finally {
    AbortSignal.prototype.addEventListener = originalAddEventListener;
    AbortSignal.prototype.removeEventListener = originalRemoveEventListener;
  }
}

async function testCriticalCheckpointPersistenceFailureStopsBeforeFollowingWork() {
  let sideEffectCount = 0;
  const manager = createRunLifecycleManager({
    idPrefix: "test",
    onSnapshot(_snapshot, event) {
      if (event.type === "checkpoint" && event.required === true) {
        throw new Error("checkpoint disk unavailable");
      }
    }
  });
  const started = manager.startRun({
    name: "critical-checkpoint",
    task: async (run) => {
      run.checkpointCritical({ action: { state: "greeting_send_in_flight" } });
      sideEffectCount += 1;
    }
  });
  const final = await manager.waitForRun(started.runId);
  assert.equal(final.status, RUN_STATUS_FAILED);
  assert.equal(sideEffectCount, 0);
  assert.match(final.error.message, /checkpoint disk unavailable/);
  assert.equal(final.checkpoint.action.state, "greeting_send_in_flight");
}

await testRunCompletes();
await testSnapshotHookPersistsProgressAndCheckpointEvents();
await testCriticalCheckpointPersistenceFailureStopsBeforeFollowingWork();
await testSleepCleansAbortListenersAfterResolution();
await testPauseResumeCancel();
await testFailureSnapshotPreservesCdpDiagnostics();
await testFailureSnapshotPreservesAttachedRunSummary();

console.log("Core run lifecycle tests passed");
