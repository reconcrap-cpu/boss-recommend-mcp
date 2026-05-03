#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { __testables } from "../src/index.js";

const { handleRequest, resetRecommendMcpStateForTests } = __testables;

const TOOL_START = "start_recommend_pipeline_run";
const TOOL_GET = "get_recommend_pipeline_run";
const TOOL_PAUSE = "pause_recommend_pipeline_run";
const TOOL_RESUME = "resume_recommend_pipeline_run";
const TOOL_CANCEL = "cancel_recommend_pipeline_run";

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    saveReport: ".live-artifacts/recommend-mcp-lifecycle-live.json",
    job: "算法工程师",
    pageScope: "recommend",
    targetCount: 8,
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    detailLimit: 0,
    delayMs: 1600,
    pauseAfterProcessed: 1,
    slowLive: true,
    allowNavigate: true,
    timeoutMs: 360000,
    noFilter: true,
    degreeLabels: [],
    postAction: "none",
    maxGreetCount: null,
    executePostAction: true,
    dryRunPostAction: false,
    actionTimeoutMs: null,
    actionIntervalMs: null,
    actionAfterClickDelayMs: null,
    completeWithoutCancel: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--no-save-report") result.saveReport = "";
    if (arg === "--job") result.job = argv[++index];
    if (arg === "--page-scope") result.pageScope = argv[++index];
    if (arg === "--target-count") result.targetCount = parsePositiveInt(argv[++index], result.targetCount);
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--detail-limit") result.detailLimit = Math.max(0, Number(argv[++index]));
    if (arg === "--delay-ms") result.delayMs = Math.max(0, Number(argv[++index]));
    if (arg === "--pause-after-processed") {
      result.pauseAfterProcessed = parsePositiveInt(argv[++index], result.pauseAfterProcessed);
    }
    if (arg === "--slow-live") result.slowLive = true;
    if (arg === "--no-slow-live") result.slowLive = false;
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--timeout-ms") result.timeoutMs = parsePositiveInt(argv[++index], result.timeoutMs);
    if (arg === "--no-filter") result.noFilter = true;
    if (arg === "--filter") result.noFilter = false;
    if (arg === "--post-action") result.postAction = String(argv[++index] || "none").trim() || "none";
    if (arg === "--max-greet-count") result.maxGreetCount = parsePositiveInt(argv[++index], result.maxGreetCount);
    if (arg === "--execute-post-action") {
      result.executePostAction = true;
      result.dryRunPostAction = false;
    }
    if (arg === "--no-execute-post-action") result.executePostAction = false;
    if (arg === "--dry-run-post-action") {
      result.dryRunPostAction = true;
      result.executePostAction = false;
    }
    if (arg === "--action-timeout-ms") result.actionTimeoutMs = parsePositiveInt(argv[++index], result.actionTimeoutMs);
    if (arg === "--action-interval-ms") result.actionIntervalMs = parsePositiveInt(argv[++index], result.actionIntervalMs);
    if (arg === "--action-after-click-delay-ms") {
      result.actionAfterClickDelayMs = Math.max(0, Number(argv[++index]));
    }
    if (arg === "--complete-without-cancel") result.completeWithoutCancel = true;
    if (arg === "--degree-labels") {
      result.degreeLabels = String(argv[++index] || "")
        .split(/[,，、|/]/)
        .map((item) => item.trim())
        .filter(Boolean);
      result.noFilter = false;
    }
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
  intervalMs = 1000
} = {}) {
  const started = Date.now();
  let lastPayload = null;
  while (Date.now() - started <= timeoutMs) {
    lastPayload = await callTool(TOOL_GET, { run_id: runId }, 2000);
    if (predicate(lastPayload.run, lastPayload)) return lastPayload;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for recommend MCP run ${runId}; last=${JSON.stringify(lastPayload?.run || null)}`);
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

function buildRecommendArgs(options) {
  const degreeValue = options.degreeLabels.length ? options.degreeLabels : "不限";
  const maxGreetCount = options.maxGreetCount || options.targetCount;
  const postAction = ["favorite", "greet", "none"].includes(options.postAction)
    ? options.postAction
    : "none";
  const confirmation = {
    page_confirmed: true,
    page_value: options.pageScope,
    filters_confirmed: true,
    school_tag_confirmed: true,
    school_tag_value: "不限",
    degree_confirmed: true,
    degree_value: degreeValue,
    gender_confirmed: true,
    gender_value: "不限",
    recent_not_view_confirmed: true,
    recent_not_view_value: "不限",
    criteria_confirmed: true,
    target_count_confirmed: true,
    target_count_value: options.targetCount,
    post_action_confirmed: true,
    post_action_value: postAction,
    job_confirmed: true,
    job_value: options.job,
    final_confirmed: true
  };
  const overrides = {
    page_scope: options.pageScope,
    school_tag: "不限",
    degree: degreeValue,
    gender: "不限",
    recent_not_view: "不限",
    criteria: options.criteria,
    target_count: options.targetCount,
    post_action: postAction,
    job: options.job
  };
  if (postAction === "greet") {
    confirmation.max_greet_count_confirmed = true;
    confirmation.max_greet_count_value = maxGreetCount;
    overrides.max_greet_count = maxGreetCount;
  }
  const args = {
    instruction: "推荐页筛选算法候选人，目标处理候选人",
    confirmation,
    overrides,
    host: options.host,
    port: options.port,
    slow_live: options.slowLive,
    allow_navigate: options.allowNavigate,
    max_candidates: options.targetCount,
    detail_limit: options.detailLimit,
    delay_ms: options.delayMs,
    no_filter: options.noFilter,
    execute_post_action: options.executePostAction,
    dry_run_post_action: options.dryRunPostAction
  };
  if (options.actionTimeoutMs !== null) args.action_timeout_ms = options.actionTimeoutMs;
  if (options.actionIntervalMs !== null) args.action_interval_ms = options.actionIntervalMs;
  if (options.actionAfterClickDelayMs !== null) {
    args.action_after_click_delay_ms = options.actionAfterClickDelayMs;
  }
  return args;
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
    for (const name of [TOOL_START, TOOL_GET, TOOL_PAUSE, TOOL_RESUME, TOOL_CANCEL]) {
      if (!toolNames.has(name)) throw new Error(`MCP tool not registered: ${name}`);
    }
    result.tools_registered = true;

    const startPayload = await callTool(TOOL_START, buildRecommendArgs(options), 10);
    result.lifecycle.started = startPayload;
    if (startPayload.status !== "ACCEPTED") {
      throw new Error(`Expected ACCEPTED from start tool, got ${startPayload.status}`);
    }
    const runId = startPayload.run_id;

    result.post_action = startPayload.post_action || null;

    if (options.completeWithoutCancel) {
      const final = await waitForRun(
        runId,
        (run) => ["completed", "failed", "canceled"].includes(run?.status),
        { timeoutMs: options.timeoutMs }
      );
      result.lifecycle.final = final;
      if (final.run.status !== "completed") {
        throw new Error(`Expected completed final status, got ${final.run.status}`);
      }
      const methodLog = final.method_log || startPayload.method_log || [];
      assertNoRuntime(methodLog);
      result.runtime_evaluate_used = false;
      result.method_summary = summarizeMethods(methodLog);
      result.method_log = methodLog;
      result.status = "PASS";

      if (options.saveReport) {
        result.saved_report_path = writeJsonFile(options.saveReport, result);
      }
      console.log(JSON.stringify(result, null, 2));
      return;
    }

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

    await new Promise((resolve) => setTimeout(resolve, Math.max(1000, options.delayMs + 300)));
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
      throw new Error("Recommend MCP run progress changed while paused");
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
    resetRecommendMcpStateForTests();
  }
}

await run();
