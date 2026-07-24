import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RUN_MODE_ASYNC,
  RUN_STATE_CANCELING,
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
import { acquireFileLockSync } from "./core/run/state-file-lock.js";

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

async function withTempHomeAsync(testFn) {
  const previous = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-run-state-"));
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  try {
    await testFn(tempHome);
  } finally {
    if (previous === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previous;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

function waitForPath(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${filePath}`));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`child exited code=${code} signal=${signal || ""}: ${stderr}`));
    });
  });
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
    assert.equal(Object.hasOwn(queued, "monitoring_v1"), false);
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
    assert.equal(Object.hasOwn(reloaded, "monitoring_v1"), false);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(getRunsDir(), `${runId}.json`), "utf8")
    );
    assert.equal(Object.hasOwn(persisted, "monitoring_v1"), false);
  });
}

function testMonitoringMarkerIsAdditiveAndLegacyStateRoundTripsWithoutIt() {
  withTempHome(() => {
    const legacyRunId = createRunId();
    const legacy = createRunStateSnapshot({
      runId: legacyRunId,
      mode: RUN_MODE_ASYNC,
      state: RUN_STATE_QUEUED
    });
    assert.equal(Object.hasOwn(legacy, "monitoring_v1"), false);
    const writtenLegacy = writeRunState(legacy);
    assert.equal(Object.hasOwn(writtenLegacy, "monitoring_v1"), false);
    assert.equal(Object.hasOwn(readRunState(legacyRunId), "monitoring_v1"), false);

    const monitoredRunId = createRunId();
    const marker = {
      contract_version: "1.0",
      schema_version: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      provider_installed_at: "2026-01-01T00:00:00.000Z"
    };
    const monitored = writeRunState(createRunStateSnapshot({
      runId: monitoredRunId,
      mode: RUN_MODE_ASYNC,
      state: RUN_STATE_QUEUED,
      monitoringV1: marker
    }));
    assert.deepEqual(monitored.monitoring_v1, marker);
    assert.deepEqual(readRunState(monitoredRunId).monitoring_v1, marker);
  });
}

function testRunStateCleanup() {
  withTempHome(() => {
    const terminalRunId = createRunId();
    writeRunState(createRunStateSnapshot({
      runId: terminalRunId,
      mode: RUN_MODE_ASYNC,
      state: RUN_STATE_COMPLETED
    }));
    const terminalRunFile = path.join(getRunsDir(), `${terminalRunId}.json`);
    const activeStates = [RUN_STATE_QUEUED, RUN_STATE_RUNNING, RUN_STATE_PAUSED, RUN_STATE_CANCELING];
    const activeFiles = [];
    for (const state of activeStates) {
      const runId = createRunId();
      const runFile = path.join(getRunsDir(), `${runId}.json`);
      const snapshot = writeRunState(createRunStateSnapshot({ runId, mode: RUN_MODE_ASYNC, state }));
      assert.equal(snapshot.state, state);
      const checkpointFile = path.join(getRunsDir(), `${runId}.checkpoint.json`);
      const exitStatusFile = path.join(getRunsDir(), `${runId}.worker.exit.json`);
      fs.writeFileSync(checkpointFile, `${JSON.stringify({ run_id: runId, cursor: 3 })}\n`, "utf8");
      fs.writeFileSync(exitStatusFile, `${JSON.stringify({ run_id: runId, exit_code: null })}\n`, "utf8");
      activeFiles.push(runFile, checkpointFile, exitStatusFile);
    }
    const oldSeconds = Math.floor((Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000);
    for (const filePath of [terminalRunFile, ...activeFiles]) {
      fs.utimesSync(filePath, oldSeconds, oldSeconds);
    }

    const cleaned = cleanupExpiredRuns(1000);
    assert.equal(cleaned.removed.includes(terminalRunFile), true);
    assert.equal(fs.existsSync(terminalRunFile), false);
    assert.equal(cleaned.preserved_active.length, activeFiles.length);
    for (const filePath of activeFiles) {
      assert.equal(fs.existsSync(filePath), true, `${filePath} should be preserved for an active run`);
      assert.equal(cleaned.preserved_active.includes(filePath), true);
    }
  });
}

async function testCrossProcessControlUpdateIsNotLost() {
  await withTempHomeAsync(async (tempHome) => {
    const runId = createRunId();
    writeRunState(createRunStateSnapshot({
      runId,
      mode: RUN_MODE_ASYNC,
      state: RUN_STATE_RUNNING
    }));
    const statePath = path.join(getRunsDir(), `${runId}.json`);
    const readyPath = path.join(tempHome, "worker-lock-ready");
    const lockModuleUrl = pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "core", "run", "state-file-lock.js")
    ).href;
    const childCode = `
      import fs from "node:fs";
      const [{ withRunStateFileLockSync }] = await Promise.all([import(process.argv[1])]);
      const statePath = process.argv[2];
      const readyPath = process.argv[3];
      withRunStateFileLockSync(statePath, () => {
        const snapshot = JSON.parse(fs.readFileSync(statePath, "utf8"));
        fs.writeFileSync(readyPath, "ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
        snapshot.progress = { ...snapshot.progress, processed: 9 };
        const tempPath = statePath + "." + process.pid + ".child.tmp";
        fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2) + "\\n");
        fs.renameSync(tempPath, statePath);
      });
    `;
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      childCode,
      lockModuleUrl,
      statePath,
      readyPath
    ], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    const childDone = waitForChild(child);
    await waitForPath(readyPath);
    const startedAt = Date.now();
    const updated = updateRunState(runId, {
      control: {
        pause_requested: true,
        pause_requested_at: "2026-07-24T00:00:00.000Z",
        pause_requested_by: "cross_process_test"
      }
    });
    const waitedMs = Date.now() - startedAt;
    await childDone;
    assert.equal(waitedMs >= 200, true, `state update should wait for worker lock, waited ${waitedMs}ms`);
    assert.equal(updated.progress.processed, 9);
    assert.equal(updated.control.pause_requested, true);
    const reloaded = readRunState(runId);
    assert.equal(reloaded.progress.processed, 9);
    assert.equal(reloaded.control.pause_requested, true);
    assert.equal(fs.existsSync(`${statePath}.state.lock`), false);
    assert.equal(fs.existsSync(`${statePath}.state.lock.recovery`), false);
  });
}

async function testTwoContendersRecoverOneStaleLockWithoutOverlap() {
  await withTempHomeAsync(async (tempHome) => {
    const statePath = path.join(tempHome, "runs", "stale-recovery.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, "{}\n");
    const lockPath = `${statePath}.state.lock`;
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema_version: 1,
      pid: 2_147_483_647,
      nonce: "dead-owner",
      acquired_at: "2000-01-01T00:00:00.000Z"
    })}\n`);
    const tracePath = path.join(tempHome, "critical-sections.ndjson");
    const lockModuleUrl = pathToFileURL(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "core", "run", "state-file-lock.js")
    ).href;
    const childCode = `
      import fs from "node:fs";
      const { withRunStateFileLockSync } = await import(process.argv[1]);
      const statePath = process.argv[2];
      const tracePath = process.argv[3];
      const label = process.argv[4];
      withRunStateFileLockSync(statePath, () => {
        fs.appendFileSync(tracePath, JSON.stringify({ label, phase: "start", at: Date.now() }) + "\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        fs.appendFileSync(tracePath, JSON.stringify({ label, phase: "end", at: Date.now() }) + "\\n");
      });
    `;
    const children = ["a", "b"].map((label) => spawn(process.execPath, [
      "--input-type=module",
      "-e",
      childCode,
      lockModuleUrl,
      statePath,
      tracePath,
      label
    ], {
      stdio: ["ignore", "ignore", "pipe"]
    }));
    await Promise.all(children.map(waitForChild));
    const records = fs.readFileSync(tracePath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 4);
    assert.deepEqual(records.map((record) => record.phase), ["start", "end", "start", "end"]);
    assert.notEqual(records[0].label, records[2].label);
    assert.equal(records[1].label, records[0].label);
    assert.equal(records[3].label, records[2].label);
    assert.equal(records[2].at >= records[1].at, true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.recovery`), false);
  });
}

async function testReusedLivePidCannotPinExpiredStateLock() {
  await withTempHomeAsync(async () => {
    const runId = createRunId();
    writeRunState(createRunStateSnapshot({
      runId,
      mode: RUN_MODE_ASYNC,
      state: RUN_STATE_RUNNING
    }));
    const statePath = path.join(getRunsDir(), `${runId}.json`);
    const lockPath = `${statePath}.state.lock`;
    fs.writeFileSync(lockPath, `${JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      nonce: "simulated-reused-live-pid",
      acquired_at: "2000-01-01T00:00:00.000Z"
    })}\n`);
    const updated = updateRunState(runId, {
      last_message: "expired reused PID lock recovered"
    });
    assert.equal(updated.last_message, "expired reused PID lock recovered");
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(`${lockPath}.recovery`), false);
  });
}

async function testTransientWindowsReleaseFailureIsRetriedSafely() {
  await withTempHomeAsync(async (tempHome) => {
    const lockPath = path.join(tempHome, "release-retry", ".writer.lock");
    let unlinkAttempts = 0;
    const observedDelays = [];
    const release = acquireFileLockSync(lockPath, {
      releaseUnlinkSyncImpl(filePath) {
        unlinkAttempts += 1;
        if (unlinkAttempts <= 2) {
          const error = new Error("injected transient Windows unlink failure");
          error.code = unlinkAttempts === 1 ? "EPERM" : "EBUSY";
          throw error;
        }
        fs.unlinkSync(filePath);
      },
      releaseSleepSyncImpl(milliseconds) {
        observedDelays.push(milliseconds);
      }
    });
    assert.equal(fs.existsSync(lockPath), true);
    release();
    assert.equal(unlinkAttempts, 3);
    assert.deepEqual(observedDelays, [10, 25]);
    assert.equal(fs.existsSync(lockPath), false);
  });
}

async function main() {
  testRunStateLifecycle();
  testMonitoringMarkerIsAdditiveAndLegacyStateRoundTripsWithoutIt();
  testRunStateCleanup();
  await testCrossProcessControlUpdateIsNotLost();
  await testTwoContendersRecoverOneStaleLockWithoutOverlap();
  await testReusedLivePidCannotPinExpiredStateLock();
  await testTransientWindowsReleaseFailureIsRetriedSafely();
  console.log("run-state tests passed");
}

await main();
