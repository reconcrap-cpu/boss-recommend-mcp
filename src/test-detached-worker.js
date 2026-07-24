import assert from "node:assert/strict";
import {
  markDetachedWorkerDomainFailed,
  recordDetachedWorkerExit,
  runDetachedWorkerDomain,
  runDetachedWorkerMain
} from "./detached-worker.js";

const calls = [];
let recommendModuleLoads = 0;
const dependencies = {
  runBossChatDetachedWorker: async (options) => {
    calls.push(["run-chat", options]);
    return { ok: true, domain: "chat" };
  },
  runBossRecruitDetachedWorker: async (options) => {
    calls.push(["run-recruit", options]);
    return { ok: true, domain: "recruit" };
  },
  markBossChatDetachedWorkerFailed: (runId, error, options) => {
    calls.push(["mark-chat", runId, error.message, options]);
    return { status: "failed", domain: "chat" };
  },
  markBossRecruitDetachedWorkerFailed: (runId, error, options) => {
    calls.push(["mark-recruit", runId, error.message, options]);
    return { status: "failed", domain: "recruit" };
  },
  async loadRecommendWorkerModule() {
    recommendModuleLoads += 1;
    return {
      async runDetachedRecommendWorker(options) {
        calls.push(["run-recommend", options]);
        return { ok: true, domain: "recommend" };
      },
      markDetachedRecommendWorkerFailed(runId, error, options) {
        calls.push(["mark-recommend", runId, error.message, options]);
        return { status: "failed", domain: "recommend" };
      }
    };
  }
};

assert.deepEqual(
  await runDetachedWorkerDomain({ domain: "chat", runId: "chat-run", launchId: "chat-launch" }, dependencies),
  { ok: true, domain: "chat" }
);
assert.deepEqual(
  await runDetachedWorkerDomain({ domain: "recruit", runId: "recruit-run", launchId: "recruit-launch" }, dependencies),
  { ok: true, domain: "recruit" }
);
assert.deepEqual(
  await runDetachedWorkerDomain({ domain: "recommend", runId: "recommend-run", launchId: "recommend-launch" }, dependencies),
  { ok: true, domain: "recommend" }
);
assert.equal(recommendModuleLoads, 1, "Recommend's index module should be loaded lazily");

const failure = new Error("worker failed");
const failureOptions = { code: "TEST_FAILURE" };
assert.deepEqual(
  await markDetachedWorkerDomainFailed("chat", "chat-run", failure, failureOptions, dependencies),
  { status: "failed", domain: "chat" }
);
assert.deepEqual(
  await markDetachedWorkerDomainFailed("recruit", "recruit-run", failure, failureOptions, dependencies),
  { status: "failed", domain: "recruit" }
);
assert.deepEqual(
  await markDetachedWorkerDomainFailed("recommend", "recommend-run", failure, failureOptions, dependencies),
  { status: "failed", domain: "recommend" }
);
assert.equal(recommendModuleLoads, 2);

assert.deepEqual(
  await recordDetachedWorkerExit({
    domain: "recommend",
    runId: "recommend-run",
    launchId: "recommend-launch",
    workerExitCode: 23,
    workerPid: 456,
    supervisorPid: 123
  }, dependencies),
  { ok: true, persisted: true }
);
assert.equal(recommendModuleLoads, 3);

assert.deepEqual(
  await runDetachedWorkerDomain({ domain: "unknown", runId: "unknown-run" }, dependencies),
  { ok: false, error: "Unsupported detached worker domain: unknown" }
);
assert.deepEqual(calls, [
  ["run-chat", { runId: "chat-run", launchId: "chat-launch" }],
  ["run-recruit", { runId: "recruit-run", launchId: "recruit-launch" }],
  ["run-recommend", { runId: "recommend-run", launchId: "recommend-launch" }],
  ["mark-chat", "chat-run", "worker failed", failureOptions],
  ["mark-recruit", "recruit-run", "worker failed", failureOptions],
  ["mark-recommend", "recommend-run", "worker failed", failureOptions],
  ["mark-recommend", "recommend-run", "Detached recommend worker exited before writing a terminal state (code=23).", {
    code: "DETACHED_WORKER_EXITED_EARLY",
    workerExitCode: 23,
    workerPid: 456,
    supervisorPid: 123,
    workerLaunchId: "recommend-launch",
    diagnosticSource: "windows_cim_supervisor"
  }]
]);

await assert.rejects(
  () => runDetachedWorkerDomain(
    { domain: "recommend", runId: "recommend-run" },
    { loadRecommendWorkerModule: async () => ({}) }
  ),
  (error) => error?.code === "DETACHED_RECOMMEND_WORKER_EXPORT_UNAVAILABLE"
);

const mainCalls = [];
const previousExitCode = process.exitCode;
try {
  process.exitCode = undefined;
  await runDetachedWorkerMain([
    "--domain",
    "chat",
    "--run-id",
    "chat-uncommitted-run",
    "--launch-id",
    "chat-current-launch"
  ], {
    runBossChatDetachedWorker: async (options) => {
      mainCalls.push(["run-chat-main", options]);
      return {
        ok: false,
        error: "run_id=chat-uncommitted-run detached worker launch was not committed"
      };
    },
    markBossChatDetachedWorkerFailed: async (runId, error, options) => {
      mainCalls.push(["mark-chat-main", runId, error.message, error.code, options]);
      // A domain marker may return an already-terminal state when the domain
      // worker persisted its own failure first. The main worker must make only
      // one idempotent reconciliation attempt and still exit nonzero.
      return { run_id: runId, state: "failed" };
    }
  });
  assert.equal(process.exitCode, 1);
} finally {
  process.exitCode = previousExitCode;
}
assert.deepEqual(mainCalls, [
  ["run-chat-main", {
    runId: "chat-uncommitted-run",
    launchId: "chat-current-launch"
  }],
  [
    "mark-chat-main",
    "chat-uncommitted-run",
    "run_id=chat-uncommitted-run detached worker launch was not committed",
    "DETACHED_WORKER_START_FAILED",
    {
      code: "DETACHED_WORKER_START_FAILED",
      workerLaunchId: "chat-current-launch",
      diagnosticSource: "detached_worker_non_ok_result"
    }
  ]
]);

console.log("detached worker dispatch tests passed");
