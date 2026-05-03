#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { __testables } from "../src/index.js";

const { handleRequest, resetChatMcpStateForTests } = __testables;

const TOOL_HEALTH = "boss_chat_health_check";
const TOOL_START = "start_boss_chat_run";
const TOOL_PREPARE = "prepare_boss_chat_run";
const TOOL_GET = "get_boss_chat_run";
const TOOL_PAUSE = "pause_boss_chat_run";
const TOOL_RESUME = "resume_boss_chat_run";
const TOOL_CANCEL = "cancel_boss_chat_run";

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    saveReport: ".live-artifacts/chat-mcp-lifecycle-live.json",
    job: "算法工程师",
    startFrom: "all",
    targetCount: 8,
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    detailLimit: 0,
    detailSource: "cascade",
    delayMs: 1600,
    pauseAfterProcessed: 1,
    slowLive: true,
    allowNavigate: true,
    timeoutMs: 360000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--no-save-report") result.saveReport = "";
    if (arg === "--job") result.job = argv[++index];
    if (arg === "--start-from") result.startFrom = argv[++index];
    if (arg === "--target-count") result.targetCount = argv[++index];
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--detail-limit") result.detailLimit = Math.max(0, Number(argv[++index]));
    if (arg === "--detail-source") result.detailSource = argv[++index];
    if (arg === "--delay-ms") result.delayMs = Math.max(0, Number(argv[++index]));
    if (arg === "--pause-after-processed") {
      result.pauseAfterProcessed = parsePositiveInt(argv[++index], result.pauseAfterProcessed);
    }
    if (arg === "--slow-live") result.slowLive = true;
    if (arg === "--no-slow-live") result.slowLive = false;
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--timeout-ms") result.timeoutMs = parsePositiveInt(argv[++index], result.timeoutMs);
    if (arg === "--health-first") result.healthFirst = true;
    if (arg === "--prepare-first") result.prepareFirst = true;
  }
  return result;
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

async function callTool(name, args = {}, id = 1) {
  const response = await handleRequest(makeToolCall(id, name, args), process.cwd());
  const payload = response?.result?.structuredContent;
  if (!payload) {
    throw new Error(`Tool ${name} did not return structuredContent`);
  }
  return payload;
}

async function waitForRun(runId, predicate, {
  timeoutMs = 60000,
  intervalMs = 800
} = {}) {
  const started = Date.now();
  let lastPayload = null;
  while (Date.now() - started <= timeoutMs) {
    lastPayload = await callTool(TOOL_GET, { run_id: runId }, 2000);
    if (predicate(lastPayload.run, lastPayload)) return lastPayload;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for chat MCP run ${runId}; last=${JSON.stringify(lastPayload?.run || null)}`);
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function summarizeMethods(methodLog = []) {
  const summary = {};
  for (const entry of methodLog || []) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function assertNoRuntime(methodLog = []) {
  const runtimeMethods = methodLog
    .map((entry) => entry.method)
    .filter((method) => String(method || "").startsWith("Runtime."));
  if (runtimeMethods.length) {
    throw new Error(`Forbidden Runtime CDP calls observed: ${runtimeMethods.join(", ")}`);
  }
}

function buildChatArgs(options) {
  return {
    job: options.job,
    start_from: options.startFrom,
    target_count: options.targetCount,
    criteria: options.criteria,
    host: options.host,
    port: options.port,
    slow_live: options.slowLive,
    allow_navigate: options.allowNavigate,
    detail_limit: options.detailLimit,
    detail_source: options.detailSource,
    delay_ms: options.delayMs
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port
    },
    lifecycle: {}
  };

  try {
    const toolsListResponse = await handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    }, process.cwd());
    const toolNames = new Set((toolsListResponse?.result?.tools || []).map((tool) => tool.name));
    for (const name of [TOOL_HEALTH, TOOL_PREPARE, TOOL_START, TOOL_GET, TOOL_PAUSE, TOOL_RESUME, TOOL_CANCEL]) {
      if (!toolNames.has(name)) throw new Error(`MCP tool not registered: ${name}`);
    }
    result.tools_registered = true;

    if (options.healthFirst) {
      const healthPayload = await callTool(TOOL_HEALTH, {
        host: options.host,
        port: options.port,
        slow_live: options.slowLive,
        allow_navigate: options.allowNavigate
      }, 4);
      result.lifecycle.health = healthPayload;
      if (healthPayload.status !== "OK") {
        throw new Error(`Unexpected health status: ${healthPayload.status}`);
      }
      assertNoRuntime(healthPayload.method_log || []);
    }

    if (options.prepareFirst) {
      const preparePayload = await callTool(TOOL_PREPARE, {
        host: options.host,
        port: options.port,
        slow_live: options.slowLive,
        allow_navigate: options.allowNavigate
      }, 5);
      result.lifecycle.prepared = preparePayload;
      if (!["NEED_INPUT", "READY"].includes(preparePayload.status)) {
        throw new Error(`Unexpected prepare status: ${preparePayload.status}`);
      }
      if (!Array.isArray(preparePayload.job_options) || preparePayload.job_options.length === 0) {
        throw new Error("Chat prepare did not return job_options");
      }
      assertNoRuntime(preparePayload.method_log || []);
    }

    const startPayload = await callTool(TOOL_START, buildChatArgs(options), 10);
    result.lifecycle.started = startPayload;
    if (startPayload.status !== "ACCEPTED") {
      throw new Error(`Expected ACCEPTED from start tool, got ${startPayload.status}`);
    }
    const runId = startPayload.run_id;

    const firstProgress = await waitForRun(
      runId,
      (run) => (run?.progress?.processed || 0) >= options.pauseAfterProcessed,
      { timeoutMs: options.timeoutMs }
    );
    result.lifecycle.first_progress = firstProgress;

    const pausePayload = await callTool(TOOL_PAUSE, { run_id: runId }, 20);
    result.lifecycle.pause_requested = pausePayload;
    if (!["PAUSE_REQUESTED", "PAUSE_IGNORED"].includes(pausePayload.status)) {
      throw new Error(`Unexpected pause status: ${pausePayload.status}`);
    }

    const paused = await waitForRun(
      runId,
      (run) => run?.status === "paused",
      { timeoutMs: options.timeoutMs }
    );
    result.lifecycle.paused = paused;

    await new Promise((resolve) => setTimeout(resolve, Math.max(900, options.delayMs + 250)));
    const stillPaused = await callTool(TOOL_GET, { run_id: runId }, 30);
    result.lifecycle.paused_stability = {
      before: paused.run.progress,
      after: stillPaused.run.progress,
      stable: (
        paused.run.progress.processed === stillPaused.run.progress.processed
        && paused.run.progress.screened === stillPaused.run.progress.screened
        && paused.run.progress.detail_opened === stillPaused.run.progress.detail_opened
      )
    };
    if (!result.lifecycle.paused_stability.stable) {
      throw new Error("Chat MCP run progress changed while paused");
    }

    const resumePayload = await callTool(TOOL_RESUME, { run_id: runId }, 40);
    result.lifecycle.resume_requested = resumePayload;
    if (resumePayload.status !== "RESUME_REQUESTED") {
      throw new Error(`Unexpected resume status: ${resumePayload.status}`);
    }

    const resumed = await waitForRun(
      runId,
      (run) => (run?.progress?.processed || 0) > (paused.run.progress.processed || 0),
      { timeoutMs: options.timeoutMs }
    );
    result.lifecycle.resumed = resumed;

    const cancelPayload = await callTool(TOOL_CANCEL, { run_id: runId }, 50);
    result.lifecycle.cancel_requested = cancelPayload;
    if (cancelPayload.status !== "CANCEL_REQUESTED") {
      throw new Error(`Unexpected cancel status: ${cancelPayload.status}`);
    }

    const final = await waitForRun(
      runId,
      (run) => ["canceled", "completed", "failed"].includes(run?.status),
      { timeoutMs: options.timeoutMs }
    );
    result.lifecycle.final = final;
    if (final.run.status !== "canceled") {
      throw new Error(`Expected canceled final status, got ${final.run.status}`);
    }

    const methodLog = final.method_log || cancelPayload.method_log || resumed.method_log || [];
    assertNoRuntime(methodLog);
    result.runtime_evaluate_used = false;
    result.method_summary = summarizeMethods(methodLog);
    result.method_log = methodLog;
    result.status = "PASS";

    if (options.saveReport) {
      result.saved_report_path = writeJsonFile(options.saveReport, result);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    result.status = "FAIL";
    result.error = {
      name: error?.name || "Error",
      message: error?.message || String(error)
    };
    if (options.saveReport) {
      result.saved_report_path = writeJsonFile(options.saveReport, result);
    }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    resetChatMcpStateForTests();
  }
}

await run();
