#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildRecommendArgs,
  cancelRunUntilTerminal,
  parseArgs
} from "../scripts/live-recommend-mcp-smoke.js";

function testDebugBoundaryHarnessFlags() {
  const cases = [
    [
      "--debug-force-list-end-after-processed",
      "debugForceListEndAfterProcessed",
      "debug_force_list_end_after_processed"
    ],
    [
      "--debug-force-context-recovery-after-processed",
      "debugForceContextRecoveryAfterProcessed",
      "debug_force_context_recovery_after_processed"
    ],
    [
      "--debug-force-cdp-reconnect-after-processed",
      "debugForceCdpReconnectAfterProcessed",
      "debug_force_cdp_reconnect_after_processed"
    ]
  ];
  for (const [flag, optionField, inputField] of cases) {
    const options = parseArgs([flag, "10"]);
    assert.equal(options[optionField], 10);
    assert.equal(options.stopAfterProcessed, 11);
    const args = buildRecommendArgs(options);
    assert.equal(args.debug_test_mode, true);
    assert.equal(args[inputField], 10);
  }

  const explicitLaterStop = parseArgs([
    "--debug-force-context-recovery-after-processed", "10",
    "--stop-after-processed", "15"
  ]);
  assert.equal(explicitLaterStop.stopAfterProcessed, 15);

  assert.throws(
    () => parseArgs([
      "--debug-force-list-end-after-processed", "10",
      "--debug-force-cdp-reconnect-after-processed", "10"
    ]),
    /mutually exclusive/
  );
  assert.throws(
    () => parseArgs(["--debug-force-cdp-reconnect-after-processed", "0"]),
    /positive integer/
  );
}

async function testCancelRunUntilTerminalRetriesOverwrittenControl() {
  let now = 0;
  const calls = [];
  const scripted = [
    [
      "cancel_recommend_pipeline_run",
      {
        status: "CANCEL_REQUESTED",
        run: {
          status: "running",
          phase: "recommend:candidate",
          progress: { processed: 12 }
        }
      }
    ],
    [
      "get_recommend_pipeline_run",
      {
        status: "RUN_STATUS",
        run: {
          status: "running",
          phase: "recommend:candidate",
          progress: { processed: 13 }
        }
      }
    ],
    [
      "cancel_recommend_pipeline_run",
      {
        status: "CANCEL_REQUESTED",
        run: {
          status: "running",
          phase: "recommend:candidate",
          progress: { processed: 13 }
        }
      }
    ],
    [
      "get_recommend_pipeline_run",
      {
        status: "RUN_STATUS",
        run: {
          status: "running",
          phase: "recommend:candidate",
          progress: { processed: 16 }
        }
      }
    ],
    [
      "cancel_recommend_pipeline_run",
      {
        status: "CANCEL_REQUESTED",
        run: {
          status: "canceling",
          phase: "recommend:candidate",
          progress: { processed: 16 }
        }
      }
    ],
    [
      "get_recommend_pipeline_run",
      {
        status: "RUN_STATUS",
        run: {
          status: "canceled",
          phase: "recommend:canceled",
          progress: { processed: 16 }
        }
      }
    ]
  ];

  const cancellation = await cancelRunUntilTerminal("run-overwrite-race", {
    timeoutMs: 10000,
    intervalMs: 2000,
    nowImpl: () => now,
    sleepImpl: async (delayMs) => {
      now += delayMs;
    },
    callToolImpl: async (name) => {
      calls.push(name);
      const next = scripted.shift();
      assert.ok(next, `Unexpected extra tool call: ${name}`);
      const [expectedName, payload] = next;
      assert.equal(name, expectedName);
      return payload;
    }
  });

  assert.equal(scripted.length, 0);
  assert.equal(cancellation.final.run.status, "canceled");
  assert.equal(cancellation.summary.retry_count, 2);
  assert.equal(cancellation.summary.poll_count, 3);
  assert.equal(cancellation.summary.terminal_status, "canceled");
  assert.deepEqual(cancellation.summary.events.map((event) => event.kind), [
    "cancel",
    "poll",
    "cancel_retry",
    "poll",
    "cancel_retry",
    "poll"
  ]);
  assert.deepEqual(
    cancellation.summary.events
      .filter((event) => event.kind === "cancel_retry")
      .map((event) => event.processed),
    [13, 16]
  );
  assert.equal(
    calls.filter((name) => name === "cancel_recommend_pipeline_run").length,
    3
  );
}

async function testCancelRunUntilTerminalAcceptsImmediateTerminal() {
  let callCount = 0;
  let sleepCount = 0;
  const cancellation = await cancelRunUntilTerminal("run-already-canceled", {
    timeoutMs: 10000,
    intervalMs: 2000,
    sleepImpl: async () => {
      sleepCount += 1;
    },
    callToolImpl: async (name) => {
      callCount += 1;
      assert.equal(name, "cancel_recommend_pipeline_run");
      return {
        status: "CANCEL_IGNORED",
        run: {
          status: "canceled",
          progress: { processed: 12 }
        }
      };
    }
  });

  assert.equal(callCount, 1);
  assert.equal(sleepCount, 0);
  assert.equal(cancellation.final.run.status, "canceled");
  assert.equal(cancellation.summary.retry_count, 0);
  assert.equal(cancellation.summary.poll_count, 0);
  assert.deepEqual(cancellation.summary.events.map((event) => event.kind), ["cancel"]);
}

async function testCancelRunUntilTerminalTimeoutPreservesEvidence() {
  let now = 0;
  await assert.rejects(
    cancelRunUntilTerminal("run-timeout", {
      timeoutMs: 4000,
      intervalMs: 2000,
      nowImpl: () => now,
      sleepImpl: async (delayMs) => {
        now += delayMs;
      },
      callToolImpl: async (name) => ({
        status: name === "get_recommend_pipeline_run"
          ? "RUN_STATUS"
          : "CANCEL_REQUESTED",
        run: {
          status: "running",
          phase: "recommend:candidate",
          progress: { processed: 20 }
        }
      })
    }),
    (error) => {
      assert.match(error.message, /Timed out canceling recommend MCP run run-timeout after 4000ms/);
      assert.equal(error.runPayload.run.status, "running");
      assert.equal(error.runPayload.run.progress.processed, 20);
      assert.equal(error.cancelFollowup.retry_count, 2);
      assert.equal(error.cancelFollowup.poll_count, 2);
      assert.equal(error.cancelFollowup.terminal_status, null);
      assert.deepEqual(error.cancelFollowup.events.map((event) => event.kind), [
        "cancel",
        "poll",
        "cancel_retry",
        "poll",
        "cancel_retry"
      ]);
      assert.deepEqual(
        error.cancelFollowup.events.map((event) => event.run_status),
        ["running", "running", "running", "running", "running"]
      );
      return true;
    }
  );
}

testDebugBoundaryHarnessFlags();
await testCancelRunUntilTerminalRetriesOverwrittenControl();
await testCancelRunUntilTerminalAcceptsImmediateTerminal();
await testCancelRunUntilTerminalTimeoutPreservesEvidence();
console.log("live recommend MCP smoke tests passed");
