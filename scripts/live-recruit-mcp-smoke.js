#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { __testables } from "../src/index.js";

const { handleRequest, resetRecruitMcpStateForTests } = __testables;

const TOOL_RUN = "run_recruit_pipeline";
const TOOL_START = "start_recruit_pipeline_run";
const TOOL_GET = "get_recruit_pipeline_run";
const TOOL_PAUSE = "pause_recruit_pipeline_run";
const TOOL_RESUME = "resume_recruit_pipeline_run";
const TOOL_CANCEL = "cancel_recruit_pipeline_run";

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    saveReport: ".live-artifacts/recruit-mcp-lifecycle-live.json",
    instruction: "搜索关键词算法工程师，目标筛选4位",
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    keyword: "算法工程师",
    city: "全国",
    maxCandidates: 4,
    detailLimit: 0,
    delayMs: 1600,
    pauseAfterProcessed: 1,
    syncSuccess: false,
    syncOnly: false,
    syncMaxCandidates: 1,
    verifyDiskGet: true,
    slowLive: true,
    resetSearch: false,
    timeoutMs: 360000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--no-save-report") result.saveReport = "";
    if (arg === "--instruction") result.instruction = argv[++index];
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--keyword") result.keyword = argv[++index];
    if (arg === "--city") result.city = argv[++index];
    if (arg === "--max-candidates") result.maxCandidates = parsePositiveInt(argv[++index], result.maxCandidates);
    if (arg === "--detail-limit") result.detailLimit = Math.max(0, Number(argv[++index]));
    if (arg === "--delay-ms") result.delayMs = Math.max(0, Number(argv[++index]));
    if (arg === "--sync-success") result.syncSuccess = true;
    if (arg === "--sync-only") {
      result.syncSuccess = true;
      result.syncOnly = true;
    }
    if (arg === "--sync-max-candidates") {
      result.syncMaxCandidates = parsePositiveInt(argv[++index], result.syncMaxCandidates);
    }
    if (arg === "--verify-disk-get") result.verifyDiskGet = true;
    if (arg === "--no-verify-disk-get") result.verifyDiskGet = false;
    if (arg === "--pause-after-processed") {
      result.pauseAfterProcessed = parsePositiveInt(argv[++index], result.pauseAfterProcessed);
    }
    if (arg === "--reset-search") result.resetSearch = true;
    if (arg === "--no-reset-search") result.resetSearch = false;
    if (arg === "--slow-live") result.slowLive = true;
    if (arg === "--no-slow-live") result.slowLive = false;
    if (arg === "--timeout-ms") result.timeoutMs = parsePositiveInt(argv[++index], result.timeoutMs);
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
  intervalMs = 500
} = {}) {
  const started = Date.now();
  let lastPayload = null;
  while (Date.now() - started <= timeoutMs) {
    lastPayload = await callTool(TOOL_GET, { run_id: runId }, 2000);
    if (predicate(lastPayload.run, lastPayload)) return lastPayload;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for recruit MCP run ${runId}; last=${JSON.stringify(lastPayload?.run || null)}`);
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

function buildRecruitArgs(options, extra = {}) {
  return {
    instruction: options.instruction,
    confirmation: {
      keyword_confirmed: true,
      search_params_confirmed: true,
      criteria_confirmed: true,
      use_default_for_missing: true
    },
    overrides: {
      keyword: options.keyword,
      city: options.city,
      criteria: options.criteria,
      target_count: options.maxCandidates,
      filter_recent_viewed: false
    },
    host: options.host,
    port: options.port,
    slow_live: options.slowLive,
    reset_search: options.resetSearch,
    max_candidates: options.maxCandidates,
    detail_limit: options.detailLimit,
    delay_ms: options.delayMs,
    ...extra
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
    for (const name of [TOOL_RUN, TOOL_START, TOOL_GET, TOOL_PAUSE, TOOL_RESUME, TOOL_CANCEL]) {
      if (!toolNames.has(name)) throw new Error(`MCP tool not registered: ${name}`);
    }
    result.tools_registered = true;

    let methodLog = [];

    if (!options.syncOnly) {
      const startPayload = await callTool(TOOL_START, buildRecruitArgs(options), 10);
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
        )
      };
      if (!result.lifecycle.paused_stability.stable) {
        throw new Error("Recruit MCP run progress changed while paused");
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
      methodLog = final.method_log || cancelPayload.method_log || resumed.method_log || [];
    }

    if (options.syncSuccess) {
      const syncPayload = await callTool(TOOL_RUN, buildRecruitArgs(options, {
        execution_mode: "sync",
        max_candidates: options.syncMaxCandidates,
        detail_limit: 0,
        delay_ms: 0,
        overrides: {
          keyword: options.keyword,
          city: options.city,
          criteria: options.criteria,
          target_count: options.syncMaxCandidates,
          filter_recent_viewed: false
        }
      }), 60);
      result.sync_success = syncPayload;
      if (syncPayload.status !== "COMPLETED") {
        throw new Error(`Expected COMPLETED from sync run, got ${syncPayload.status}`);
      }
      if (!syncPayload.result?.run_id || syncPayload.result.processed_count < 1) {
        throw new Error("Sync run did not return legacy result.run_id and processed_count");
      }
      const artifactChecks = {
        run_state_path: syncPayload.run?.artifacts?.run_state_path || "",
        output_csv: syncPayload.result.output_csv || "",
        report_json: syncPayload.result.report_json || "",
        checkpoint_path: syncPayload.result.checkpoint_path || ""
      };
      result.sync_artifacts = {
        ...artifactChecks,
        run_state_exists: Boolean(artifactChecks.run_state_path && fs.existsSync(artifactChecks.run_state_path)),
        output_csv_exists: Boolean(artifactChecks.output_csv && fs.existsSync(artifactChecks.output_csv)),
        report_json_exists: Boolean(artifactChecks.report_json && fs.existsSync(artifactChecks.report_json)),
        checkpoint_exists: Boolean(artifactChecks.checkpoint_path && fs.existsSync(artifactChecks.checkpoint_path))
      };
      if (
        !result.sync_artifacts.run_state_exists
        || !result.sync_artifacts.output_csv_exists
        || !result.sync_artifacts.report_json_exists
        || !result.sync_artifacts.checkpoint_exists
      ) {
        throw new Error("Sync run did not persist expected run/report artifacts");
      }
      if (options.verifyDiskGet) {
        resetRecruitMcpStateForTests();
        const diskPayload = await callTool(TOOL_GET, { run_id: syncPayload.result.run_id }, 70);
        result.disk_get_after_reset = diskPayload;
        if (diskPayload.status !== "RUN_STATUS" || diskPayload.run?.state !== "completed") {
          throw new Error("Persisted run was not readable after clearing in-memory MCP state");
        }
        if (diskPayload.persistence?.source !== "disk" || diskPayload.persistence?.active_control_available !== false) {
          throw new Error("Persisted run fallback did not report disk-only source");
        }
      }
      assertNoRuntime(syncPayload.method_log || []);
      methodLog = methodLog.concat(syncPayload.method_log || []);
    }

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
  }
}

await run();
