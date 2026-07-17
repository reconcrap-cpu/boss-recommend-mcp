#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
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

function parseRequiredPositiveInt(raw, label) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseLabelList(raw) {
  const protectedSlashLabel = "__BOSS_MCP_DEGREE_ZHONGZHUAN_ZHONGJI__";
  return String(raw || "")
    .replaceAll("中专/中技", protectedSlashLabel)
    .split(/[,，、|/;；]/)
    .map((item) => item.replaceAll(protectedSlashLabel, "中专/中技").trim())
    .filter(Boolean);
}

function readTextFile(filePath, label) {
  const resolved = path.resolve(String(filePath || ""));
  const content = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/, "").trim();
  if (!content) throw new Error(`${label} file is empty: ${resolved}`);
  return content;
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    saveReport: ".live-artifacts/recommend-mcp-lifecycle-live.json",
    job: "算法工程师",
    pageScope: "recommend",
    targetCount: 8,
    instruction: "推荐页筛选算法候选人，目标处理候选人",
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    detailLimit: 0,
    delayMs: 1600,
    pauseAfterProcessed: 1,
    restLevel: "medium",
    slowLive: true,
    allowNavigate: true,
    timeoutMs: 360000,
    noFilter: true,
    schoolTags: [],
    degreeLabels: [],
    gender: "不限",
    recentNotView: "不限",
    currentCityOnly: false,
    activityLevel: "不限",
    skipRecentColleagueContacted: true,
    postAction: "none",
    maxGreetCount: null,
    executePostAction: true,
    dryRunPostAction: false,
    actionTimeoutMs: null,
    actionIntervalMs: null,
    actionAfterClickDelayMs: null,
    stopAfterProcessed: null,
    debugForceListEndAfterProcessed: null,
    debugForceContextRecoveryAfterProcessed: null,
    debugForceCdpReconnectAfterProcessed: null,
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
    if (arg === "--criteria-file") result.criteria = readTextFile(argv[++index], "criteria");
    if (arg === "--instruction") result.instruction = argv[++index];
    if (arg === "--instruction-file") result.instruction = readTextFile(argv[++index], "instruction");
    if (arg === "--detail-limit") result.detailLimit = Math.max(0, Number(argv[++index]));
    if (arg === "--delay-ms") result.delayMs = Math.max(0, Number(argv[++index]));
    if (arg === "--pause-after-processed") {
      result.pauseAfterProcessed = parsePositiveInt(argv[++index], result.pauseAfterProcessed);
    }
    if (arg === "--rest-level") result.restLevel = String(argv[++index] || "").trim().toLowerCase();
    if (arg === "--slow-live") result.slowLive = true;
    if (arg === "--no-slow-live") result.slowLive = false;
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--timeout-ms") result.timeoutMs = parsePositiveInt(argv[++index], result.timeoutMs);
    if (arg === "--stop-after-processed") {
      result.stopAfterProcessed = parseRequiredPositiveInt(argv[++index], "--stop-after-processed");
    }
    if (arg === "--debug-force-list-end-after-processed") {
      result.debugForceListEndAfterProcessed = parseRequiredPositiveInt(
        argv[++index],
        "--debug-force-list-end-after-processed"
      );
    }
    if (arg === "--debug-force-context-recovery-after-processed") {
      result.debugForceContextRecoveryAfterProcessed = parseRequiredPositiveInt(
        argv[++index],
        "--debug-force-context-recovery-after-processed"
      );
    }
    if (arg === "--debug-force-cdp-reconnect-after-processed") {
      result.debugForceCdpReconnectAfterProcessed = parseRequiredPositiveInt(
        argv[++index],
        "--debug-force-cdp-reconnect-after-processed"
      );
    }
    if (arg === "--no-filter") result.noFilter = true;
    if (arg === "--filter") result.noFilter = false;
    if (arg === "--school-tags" || arg === "--school-tag") {
      result.schoolTags = parseLabelList(argv[++index]);
      result.noFilter = false;
    }
    if (arg === "--gender") {
      result.gender = String(argv[++index] || "").trim() || "不限";
      result.noFilter = false;
    }
    if (arg === "--recent-not-view") {
      result.recentNotView = String(argv[++index] || "").trim() || "不限";
      result.noFilter = false;
    }
    if (arg === "--current-city-only") {
      result.currentCityOnly = true;
      result.noFilter = false;
    }
    if (arg === "--no-current-city-only") {
      result.currentCityOnly = false;
      result.noFilter = false;
    }
    if (arg === "--activity-level") {
      result.activityLevel = String(argv[++index] || "").trim() || "不限";
      result.noFilter = false;
    }
    if (arg === "--skip-recent-colleague-contacted") {
      result.skipRecentColleagueContacted = true;
    }
    if (arg === "--no-skip-recent-colleague-contacted") {
      result.skipRecentColleagueContacted = false;
    }
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
    if (arg === "--degree-labels" || arg === "--degree") {
      result.degreeLabels = parseLabelList(argv[++index]);
      result.noFilter = false;
    }
  }
  const debugBoundaries = [
    result.debugForceListEndAfterProcessed,
    result.debugForceContextRecoveryAfterProcessed,
    result.debugForceCdpReconnectAfterProcessed
  ].filter((value) => value !== null);
  if (debugBoundaries.length > 1) {
    throw new Error("debug force boundary flags are mutually exclusive");
  }
  if (debugBoundaries.length === 1) {
    result.stopAfterProcessed = Math.max(
      result.stopAfterProcessed || 0,
      debugBoundaries[0] + 1
    );
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
  assertNoRuntime(payload.method_log || []);
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
    if (["failed", "canceled", "completed"].includes(lastPayload.run?.status)) {
      const terminalError = lastPayload.run?.error?.message || lastPayload.run?.result?.error?.message || "terminal state reached";
      const error = new Error(`Recommend MCP run ${runId} ended as ${lastPayload.run.status}: ${terminalError}`);
      error.runPayload = lastPayload;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for recommend MCP run ${runId}; last=${JSON.stringify(lastPayload?.run || null)}`);
}

function isTerminalRun(run) {
  return ["failed", "canceled", "completed"].includes(run?.status);
}

function compactCancelObservation(kind, payload, sequence) {
  return {
    kind,
    sequence,
    at: new Date().toISOString(),
    tool_status: payload?.status || null,
    run_status: payload?.run?.status || payload?.run?.state || null,
    processed: Number(payload?.run?.progress?.processed) || 0,
    phase: payload?.run?.phase || payload?.run?.stage || null
  };
}

async function cancelRunUntilTerminal(runId, {
  timeoutMs = 60000,
  intervalMs = 2000,
  callToolImpl = callTool,
  sleepImpl = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  nowImpl = Date.now
} = {}) {
  const started = nowImpl();
  const events = [];
  const payloads = [];
  let retryCount = 0;
  let pollCount = 0;

  const initial = await callToolImpl(TOOL_CANCEL, { run_id: runId }, 50);
  payloads.push(initial);
  events.push(compactCancelObservation("cancel", initial, events.length + 1));
  if (!["CANCEL_REQUESTED", "CANCEL_IGNORED"].includes(initial.status)) {
    const error = new Error(`Unexpected initial cancel status: ${initial.status}`);
    error.cancelFollowup = {
      interval_ms: intervalMs,
      timeout_ms: timeoutMs,
      retry_count: retryCount,
      poll_count: pollCount,
      events
    };
    throw error;
  }
  if (isTerminalRun(initial.run)) {
    return {
      initial,
      final: initial,
      payloads,
      summary: {
        interval_ms: intervalMs,
        timeout_ms: timeoutMs,
        retry_count: retryCount,
        poll_count: pollCount,
        terminal_status: initial.run.status,
        events
      }
    };
  }

  let lastPayload = initial;
  while (nowImpl() - started < timeoutMs) {
    const remainingMs = timeoutMs - (nowImpl() - started);
    await sleepImpl(Math.min(intervalMs, Math.max(0, remainingMs)));

    const statusPayload = await callToolImpl(
      TOOL_GET,
      { run_id: runId },
      60 + pollCount + retryCount
    );
    pollCount += 1;
    lastPayload = statusPayload;
    payloads.push(statusPayload);
    events.push(compactCancelObservation("poll", statusPayload, events.length + 1));
    if (isTerminalRun(statusPayload.run)) {
      return {
        initial,
        final: statusPayload,
        payloads,
        summary: {
          interval_ms: intervalMs,
          timeout_ms: timeoutMs,
          retry_count: retryCount,
          poll_count: pollCount,
          terminal_status: statusPayload.run.status,
          events
        }
      };
    }

    const retryPayload = await callToolImpl(
      TOOL_CANCEL,
      { run_id: runId },
      600 + retryCount
    );
    retryCount += 1;
    lastPayload = retryPayload;
    payloads.push(retryPayload);
    events.push(compactCancelObservation("cancel_retry", retryPayload, events.length + 1));
    if (!["CANCEL_REQUESTED", "CANCEL_IGNORED"].includes(retryPayload.status)) {
      const error = new Error(`Unexpected cancel retry status: ${retryPayload.status}`);
      error.runPayload = retryPayload;
      error.cancelFollowup = {
        interval_ms: intervalMs,
        timeout_ms: timeoutMs,
        retry_count: retryCount,
        poll_count: pollCount,
        events
      };
      throw error;
    }
    if (isTerminalRun(retryPayload.run)) {
      return {
        initial,
        final: retryPayload,
        payloads,
        summary: {
          interval_ms: intervalMs,
          timeout_ms: timeoutMs,
          retry_count: retryCount,
          poll_count: pollCount,
          terminal_status: retryPayload.run.status,
          events
        }
      };
    }
  }

  const error = new Error(`Timed out canceling recommend MCP run ${runId} after ${timeoutMs}ms`);
  error.runPayload = lastPayload;
  error.cancelFollowup = {
    interval_ms: intervalMs,
    timeout_ms: timeoutMs,
    retry_count: retryCount,
    poll_count: pollCount,
    terminal_status: null,
    events
  };
  throw error;
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
  const forbiddenMethods = methodLog
    .map((entry) => entry.method)
    .filter((method) => {
      const canonical = String(method || "").replace(/:retry_after_reconnect$/, "");
      return canonical.startsWith("Runtime.")
        || canonical.startsWith("Page.addScript");
    });
  if (forbiddenMethods.length) {
    throw new Error(`Forbidden Runtime/script-injection CDP calls observed: ${forbiddenMethods.join(", ")}`);
  }
}

function recordCdpEvidence(result, ...payloads) {
  const candidates = payloads
    .filter(Boolean)
    .map((payload) => ({
      methodLog: Array.isArray(payload.method_log) ? payload.method_log : [],
      methodLogTotal: Number(payload.method_log_total) || payload.method_log?.length || 0
    }));
  for (const candidate of candidates) assertNoRuntime(candidate.methodLog);
  const selected = candidates.sort((left, right) => right.methodLogTotal - left.methodLogTotal)[0] || {
    methodLog: [],
    methodLogTotal: 0
  };
  result.runtime_evaluate_used = false;
  result.script_injection_used = false;
  result.method_summary = summarizeMethods(selected.methodLog);
  result.method_log = selected.methodLog;
  result.method_log_total = selected.methodLogTotal;
}

function buildDiagnosticEvidence(payload) {
  if (!payload || typeof payload !== "object") return null;
  const run = payload.run && typeof payload.run === "object" ? payload.run : {};
  const runResult = run.result && typeof run.result === "object" ? run.result : {};
  const error = run.error || runResult.error || payload.error || null;
  const errorRecord = error && typeof error === "object" ? error : {};
  const diagnostics = run.diagnostics && typeof run.diagnostics === "object" ? run.diagnostics : {};
  return {
    run_id: run.id || run.runId || run.run_id || payload.run_id || null,
    status: run.status || run.state || payload.status || null,
    phase: errorRecord.phase || run.phase || run.stage || diagnostics.phase || null,
    cdp_method: errorRecord.cdp_method
      || errorRecord.method
      || errorRecord.cdp?.method
      || diagnostics.cdp_method
      || null,
    cdp_at: errorRecord.cdp_at || diagnostics.cdp_at || null,
    node_id: errorRecord.cdp_node_id
      || errorRecord.cdp_backend_node_id
      || errorRecord.node_id
      || errorRecord.nodeId
      || errorRecord.card_node_id
      || errorRecord.backend_node_id
      || diagnostics.node_id
      || null,
    checkpoint: run.checkpoint || runResult.checkpoint || null,
    progress: run.progress || null,
    last_human_event: run.progress?.last_human_event || null,
    error,
    method_log_total: Number(payload.method_log_total) || payload.method_log?.length || 0,
    method_log_tail: Array.isArray(payload.method_log) ? payload.method_log : []
  };
}

function debugBoundaryRequirementSatisfied(run, options) {
  const progress = run?.progress || {};
  if (options.debugForceListEndAfterProcessed !== null) {
    return Number(progress.refresh_rounds || 0) >= 1
      && Number(progress.debug_force_list_end_count || 0) >= 1;
  }
  if (options.debugForceContextRecoveryAfterProcessed !== null) {
    return Number(progress.context_recoveries || 0) >= 1
      && Number(progress.debug_force_context_recovery_count || 0) >= 1;
  }
  if (options.debugForceCdpReconnectAfterProcessed !== null) {
    return Number(progress.debug_force_cdp_reconnect_count || 0) >= 1;
  }
  return true;
}

function buildRecommendArgs(options) {
  const schoolValue = options.schoolTags.length ? options.schoolTags : "不限";
  const degreeValue = options.degreeLabels.length ? options.degreeLabels : "不限";
  const schoolTags = new Set(["不限", "985", "211", "双一流院校", "留学", "国内外名校", "公办本科"]);
  const degrees = new Set(["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]);
  const genders = new Set(["不限", "男", "女"]);
  const recentNotViewValues = new Set(["不限", "近14天没有"]);
  const activityLevels = new Set(["不限", "刚刚活跃", "今日活跃", "3日内活跃", "本周活跃", "本月活跃"]);
  const invalidSchoolTags = (Array.isArray(schoolValue) ? schoolValue : [schoolValue])
    .filter((value) => !schoolTags.has(value));
  const invalidDegrees = (Array.isArray(degreeValue) ? degreeValue : [degreeValue])
    .filter((value) => !degrees.has(value));
  if (invalidSchoolTags.length) {
    throw new Error(`Unsupported school tag(s): ${invalidSchoolTags.join(", ")}`);
  }
  if (invalidDegrees.length) {
    throw new Error(`Unsupported degree label(s): ${invalidDegrees.join(", ")}`);
  }
  if (!genders.has(options.gender)) {
    throw new Error(`Unsupported gender: ${options.gender}`);
  }
  if (!recentNotViewValues.has(options.recentNotView)) {
    throw new Error(`Unsupported recent-not-view value: ${options.recentNotView}`);
  }
  if (!activityLevels.has(options.activityLevel)) {
    throw new Error(`Unsupported activity level: ${options.activityLevel}`);
  }
  if (!["greet", "none"].includes(options.postAction)) {
    throw new Error(`Unsupported recommend post action: ${options.postAction}. Use greet or none.`);
  }
  if (!["low", "medium", "high"].includes(options.restLevel)) {
    throw new Error(`Unsupported rest level: ${options.restLevel}. Use low, medium, or high.`);
  }
  const maxGreetCount = options.maxGreetCount;
  const postAction = options.postAction;
  const confirmation = {
    page_confirmed: true,
    page_value: options.pageScope,
    filters_confirmed: true,
    school_tag_confirmed: true,
    school_tag_value: schoolValue,
    degree_confirmed: true,
    degree_value: degreeValue,
    gender_confirmed: true,
    gender_value: options.gender,
    recent_not_view_confirmed: true,
    recent_not_view_value: options.recentNotView,
    skip_recent_colleague_contacted_confirmed: true,
    skip_recent_colleague_contacted_value: options.skipRecentColleagueContacted,
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
    school_tag: schoolValue,
    degree: degreeValue,
    gender: options.gender,
    recent_not_view: options.recentNotView,
    current_city_only: options.currentCityOnly,
    activity_level: options.activityLevel,
    criteria: options.criteria,
    target_count: options.targetCount,
    post_action: postAction,
    skip_recent_colleague_contacted: options.skipRecentColleagueContacted,
    job: options.job
  };
  if (postAction === "greet" && maxGreetCount !== null) {
    confirmation.max_greet_count_confirmed = true;
    confirmation.max_greet_count_value = maxGreetCount;
    overrides.max_greet_count = maxGreetCount;
  }
  const args = {
    instruction: options.instruction,
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
    dry_run_post_action: options.dryRunPostAction,
    human_behavior: {
      restLevel: options.restLevel
    }
  };
  if (options.actionTimeoutMs !== null) args.action_timeout_ms = options.actionTimeoutMs;
  if (options.actionIntervalMs !== null) args.action_interval_ms = options.actionIntervalMs;
  if (options.actionAfterClickDelayMs !== null) {
    args.action_after_click_delay_ms = options.actionAfterClickDelayMs;
  }
  if (options.debugForceListEndAfterProcessed !== null) {
    args.debug_test_mode = true;
    args.debug_force_list_end_after_processed = options.debugForceListEndAfterProcessed;
  }
  if (options.debugForceContextRecoveryAfterProcessed !== null) {
    args.debug_test_mode = true;
    args.debug_force_context_recovery_after_processed = options.debugForceContextRecoveryAfterProcessed;
  }
  if (options.debugForceCdpReconnectAfterProcessed !== null) {
    args.debug_test_mode = true;
    args.debug_force_cdp_reconnect_after_processed = options.debugForceCdpReconnectAfterProcessed;
  }
  return args;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.stopAfterProcessed !== null && options.completeWithoutCancel) {
    throw new Error("--stop-after-processed cannot be combined with --complete-without-cancel");
  }
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port
    },
    requested: {
      instruction: options.instruction,
      criteria: options.criteria,
      job: options.job,
      page_scope: options.pageScope,
      school_tag: options.schoolTags.length ? options.schoolTags : ["不限"],
      degree: options.degreeLabels.length ? options.degreeLabels : ["不限"],
      gender: options.gender,
      recent_not_view: options.recentNotView,
      current_city_only: options.currentCityOnly,
      activity_level: options.activityLevel,
      skip_recent_colleague_contacted: options.skipRecentColleagueContacted,
      target_count: options.targetCount,
      post_action: options.postAction,
      max_greet_count: options.maxGreetCount,
      rest_level: options.restLevel,
      stop_after_processed: options.stopAfterProcessed,
      debug_force_list_end_after_processed: options.debugForceListEndAfterProcessed,
      debug_force_context_recovery_after_processed: options.debugForceContextRecoveryAfterProcessed,
      debug_force_cdp_reconnect_after_processed: options.debugForceCdpReconnectAfterProcessed
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

    if (options.stopAfterProcessed !== null) {
      const boundary = await waitForRun(
        runId,
        (run) => (
          (
            (run?.progress?.processed || 0) >= options.stopAfterProcessed
            && debugBoundaryRequirementSatisfied(run, options)
          )
          || isTerminalRun(run)
        ),
        { timeoutMs: options.timeoutMs }
      );
      result.lifecycle.stop_boundary = boundary;
      result.stop_boundary_evidence = buildDiagnosticEvidence(boundary);
      recordCdpEvidence(result, startPayload, boundary);

      if (isTerminalRun(boundary.run)) {
        result.lifecycle.final = boundary;
        result.failure_evidence = buildDiagnosticEvidence(boundary);
        const terminalError = boundary.run?.error?.message
          || boundary.run?.result?.error?.message
          || "terminal state reached before the stop boundary could be canceled";
        throw new Error(`Recommend MCP run ${runId} ended as ${boundary.run.status}: ${terminalError}`);
      }

      const cancellation = await cancelRunUntilTerminal(runId, {
        timeoutMs: options.timeoutMs,
        intervalMs: 2000
      });
      const cancelPayload = cancellation.initial;
      const final = cancellation.final;
      result.lifecycle.cancel_requested = cancelPayload;
      result.lifecycle.cancel_followup = cancellation.summary;
      result.lifecycle.final = final;
      result.final_evidence = buildDiagnosticEvidence(final);
      recordCdpEvidence(result, startPayload, boundary, ...cancellation.payloads);
      if (final.run.status !== "canceled") {
        throw new Error(`Expected canceled final status after stop boundary, got ${final.run.status}`);
      }
      result.status = "PASS";

      if (options.saveReport) {
        result.saved_report_path = writeJsonFile(options.saveReport, result);
      }
      console.log(JSON.stringify(result, null, 2));
      return;
    }

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
      recordCdpEvidence(result, startPayload, final);
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

    const cancellation = await cancelRunUntilTerminal(runId, {
      timeoutMs: options.timeoutMs,
      intervalMs: 2000
    });
    const cancelPayload = cancellation.initial;
    const final = cancellation.final;
    result.lifecycle.cancel_requested = cancelPayload;
    result.lifecycle.cancel_followup = cancellation.summary;
    result.lifecycle.final = final;
    if (final.run.status !== "canceled") {
      throw new Error(`Expected canceled final status, got ${final.run.status}`);
    }

    recordCdpEvidence(result, startPayload, resumed, ...cancellation.payloads);
    result.status = "PASS";

    if (options.saveReport) {
      result.saved_report_path = writeJsonFile(options.saveReport, result);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error?.cancelFollowup) {
      result.lifecycle.cancel_followup = error.cancelFollowup;
    }
    if (error?.runPayload) {
      result.lifecycle.failure_snapshot = error.runPayload;
      result.failure_evidence = buildDiagnosticEvidence(error.runPayload);
    } else if (!result.failure_evidence) {
      const terminalPayload = Object.values(result.lifecycle)
        .find((payload) => isTerminalRun(payload?.run));
      if (terminalPayload) result.failure_evidence = buildDiagnosticEvidence(terminalPayload);
    }
    recordCdpEvidence(result, ...Object.values(result.lifecycle));
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

const isMain = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) await run();

export {
  assertNoRuntime,
  buildRecommendArgs,
  cancelRunUntilTerminal,
  parseArgs,
  parseLabelList
};
