import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables } from "./index.js";

const {
  handleRequest,
  runDetachedWorkerForTests,
  setSpawnProcessImplForTests,
  setRunPipelineImplForTests
} = __testables;

const TOOL_START_RUN = "start_recommend_pipeline_run";
const TOOL_GET_RUN = "get_recommend_pipeline_run";
const TOOL_CANCEL_RUN = "cancel_recommend_pipeline_run";
const TOOL_PAUSE_RUN = "pause_recommend_pipeline_run";
const TOOL_RESUME_RUN = "resume_recommend_pipeline_run";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeToolCall(id, name, args = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args
    }
  };
}

async function readToolPayload(response) {
  return response?.result?.structuredContent;
}

async function callTool(name, args, id = 1) {
  const response = await handleRequest(
    makeToolCall(id, name, args),
    process.cwd()
  );
  return readToolPayload(response);
}

async function waitForRunState(runId, acceptedStates, timeoutMs = 6000) {
  const accepted = new Set(acceptedStates.map((item) => String(item).toLowerCase()));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await callTool(TOOL_GET_RUN, { run_id: runId }, 1001);
    const state = String(payload?.run?.state || "").toLowerCase();
    if (accepted.has(state)) return payload.run;
    await sleep(80);
  }
  throw new Error(`Timed out waiting run state (${Array.from(accepted).join(", ")}) for run_id=${runId}`);
}

async function startAcceptedRun(instruction, idSeed = 1) {
  const payload = await callTool(TOOL_START_RUN, {
    instruction,
    confirmation: {
      job_confirmed: true,
      job_value: "mock job",
      final_confirmed: true
    }
  }, idSeed);
  assert.equal(payload.status, "ACCEPTED");
  assert.equal(typeof payload.run_id, "string");
  return payload.run_id;
}

function setupPipelineMock() {
  const checkpointStore = new Map();
  setRunPipelineImplForTests(async (input, _deps, runtime) => {
    if (input.confirmation?.job_confirmed !== true) {
      return {
        status: "NEED_CONFIRMATION",
        required_confirmations: ["job"],
        pending_questions: [{ field: "job", question: "请确认岗位" }]
      };
    }
    if (input.confirmation?.final_confirmed !== true) {
      return {
        status: "NEED_CONFIRMATION",
        required_confirmations: ["final_review"],
        pending_questions: [{ field: "final_review", question: "请最终确认" }]
      };
    }

    runtime?.onStage?.({ stage: "preflight", message: "preflight started" });
    await sleep(30);
    runtime?.onStage?.({ stage: "screen", message: "screen running" });

    const checkpointPath = String(input.resume?.checkpoint_path || "mem://default");
    const outputCsv = String(input.resume?.output_csv || "C:/tmp/mock.csv");
    const total = 12;
    let processed = input.resume?.resume === true ? Number(checkpointStore.get(checkpointPath) || 0) : 0;
    if (!Number.isInteger(processed) || processed < 0) processed = 0;

    while (processed < total) {
      processed += 1;
      runtime?.onProgress?.({
        stage: "screen",
        processed,
        passed: Math.floor(processed / 3),
        skipped: processed - Math.floor(processed / 3),
        greet_count: 0,
        line: `处理第 ${processed} 位候选人`
      });
      await sleep(25);
      if (runtime?.isPauseRequested?.() === true) {
        checkpointStore.set(checkpointPath, processed);
        return {
          status: "PAUSED",
          result: {
            processed_count: processed,
            passed_count: Math.floor(processed / 3),
            skipped_count: processed - Math.floor(processed / 3),
            greet_count: 0,
            output_csv: outputCsv,
            checkpoint_path: checkpointPath,
            completion_reason: "paused"
          }
        };
      }
    }

    checkpointStore.delete(checkpointPath);
    return {
      status: "COMPLETED",
      result: {
        processed_count: total,
        passed_count: Math.floor(total / 3),
        skipped_count: total - Math.floor(total / 3),
        greet_count: 0,
        output_csv: outputCsv,
        completion_reason: "screen_completed"
      }
    };
  });
}

function parseDetachedSpawnArgs(argv = []) {
  const normalized = Array.isArray(argv) ? argv.map((item) => String(item || "")) : [];
  const runIdFlagIndex = normalized.indexOf("--run-id");
  return {
    runId: runIdFlagIndex >= 0 ? String(normalized[runIdFlagIndex + 1] || "").trim() : "",
    resumeRun: normalized.includes("--resume")
  };
}

function setupDetachedWorkerStub() {
  setSpawnProcessImplForTests((command, argv = []) => {
    assert.equal(typeof command, "string");
    const { runId, resumeRun } = parseDetachedSpawnArgs(argv);
    assert.equal(Boolean(runId), true, "detached worker spawn must include --run-id");
    const pid = process.pid;
    setTimeout(() => {
      runDetachedWorkerForTests({
        runId,
        resumeRun,
        workerPid: pid
      }).catch(() => {});
    }, 0);
    return {
      pid,
      unref() {}
    };
  });
}

async function testPauseAndResumeFlow() {
  const runId = await startAcceptedRun("run for pause and resume", 11);
  await waitForRunState(runId, ["running"]);

  const pausePayload = await callTool(TOOL_PAUSE_RUN, { run_id: runId }, 12);
  assert.equal(pausePayload.status, "PAUSE_REQUESTED");

  const pausedRun = await waitForRunState(runId, ["paused"]);
  assert.equal(pausedRun.state, "paused");
  assert.equal(pausedRun.result?.status, "PAUSED");
  assert.equal(Boolean(pausedRun.resume?.output_csv), true);

  const resumePayload = await callTool(TOOL_RESUME_RUN, { run_id: runId }, 13);
  assert.equal(resumePayload.status, "RESUME_REQUESTED");
  assert.equal(resumePayload.run.run_id, runId);

  const completedRun = await waitForRunState(runId, ["completed"]);
  assert.equal(completedRun.state, "completed");
  assert.equal(completedRun.result?.status, "COMPLETED");
}

async function testResumeAfterProcessRestartSimulation() {
  const runId = await startAcceptedRun("run for restart resume", 21);
  await waitForRunState(runId, ["running"]);

  const pausePayload = await callTool(TOOL_PAUSE_RUN, { run_id: runId }, 22);
  assert.equal(pausePayload.status, "PAUSE_REQUESTED");
  await waitForRunState(runId, ["paused"]);

  const resumePayload = await callTool(TOOL_RESUME_RUN, { run_id: runId }, 23);
  assert.equal(resumePayload.status, "RESUME_REQUESTED");
  assert.equal(resumePayload.run.run_id, runId);

  const completedRun = await waitForRunState(runId, ["completed"]);
  assert.equal(completedRun.state, "completed");
}

async function testCancelPausedRun() {
  const runId = await startAcceptedRun("run for cancel paused", 31);
  await waitForRunState(runId, ["running"]);

  const pausePayload = await callTool(TOOL_PAUSE_RUN, { run_id: runId }, 32);
  assert.equal(pausePayload.status, "PAUSE_REQUESTED");
  await waitForRunState(runId, ["paused"]);

  const cancelPayload = await callTool(TOOL_CANCEL_RUN, { run_id: runId }, 33);
  assert.equal(cancelPayload.status, "CANCEL_REQUESTED");

  const canceledRun = await waitForRunState(runId, ["canceled"]);
  assert.equal(canceledRun.state, "canceled");
}

async function testCancelRunningRunKeepsCsv() {
  const runId = await startAcceptedRun("run for cancel while running", 41);
  await waitForRunState(runId, ["running"]);

  const cancelPayload = await callTool(TOOL_CANCEL_RUN, { run_id: runId }, 42);
  assert.equal(cancelPayload.status, "CANCEL_REQUESTED");

  const canceledRun = await waitForRunState(runId, ["canceled"]);
  assert.equal(canceledRun.state, "canceled");
  assert.equal(canceledRun.error?.code, "PIPELINE_CANCELED");
  assert.equal(Boolean(canceledRun.resume?.output_csv), true);
}

async function main() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-index-async-"));
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  setupPipelineMock();
  setupDetachedWorkerStub();

  try {
    await testPauseAndResumeFlow();
    await testResumeAfterProcessRestartSimulation();
    await testCancelPausedRun();
    await testCancelRunningRunKeepsCsv();
    console.log("index async tests passed");
  } finally {
    setRunPipelineImplForTests(null);
    setSpawnProcessImplForTests(null);
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

await main();
