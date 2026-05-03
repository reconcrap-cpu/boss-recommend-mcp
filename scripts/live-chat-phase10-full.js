#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { __testables } from "../src/index.js";

const { handleRequest, resetChatMcpStateForTests } = __testables;

const TOOL_START = "start_boss_chat_run";
const TOOL_PREPARE = "prepare_boss_chat_run";
const TOOL_HEALTH = "boss_chat_health_check";
const TOOL_GET = "get_boss_chat_run";
const TOOL_CANCEL = "cancel_boss_chat_run";

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readTextFile(filePath) {
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    saveReport: ".live-artifacts/phase10-chat-full-live.json",
    job: "",
    startFrom: "unread",
    targetCount: 30,
    criteria: "",
    maxCandidates: 100000,
    detailLimit: null,
    detailSource: "cascade",
    delayMs: 1800,
    slowLive: true,
    allowNavigate: true,
    requestCv: true,
    dryRunRequestCv: false,
    useLlm: true,
    llmTimeoutMs: 180000,
    onlineResumeButtonTimeoutMs: null,
    maxImagePages: 8,
    listMaxScrolls: 240,
    timeoutMs: 7200000,
    pollIntervalMs: 5000,
    healthFirst: false,
    prepareFirst: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    else if (arg === "--port") result.port = Number(argv[++index]);
    else if (arg === "--save-report") result.saveReport = argv[++index];
    else if (arg === "--no-save-report") result.saveReport = "";
    else if (arg === "--job") result.job = argv[++index];
    else if (arg === "--start-from") result.startFrom = argv[++index];
    else if (arg === "--target-count") result.targetCount = argv[++index];
    else if (arg === "--criteria") result.criteria = argv[++index];
    else if (arg === "--criteria-file") result.criteria = readTextFile(argv[++index]).trim();
    else if (arg === "--max-candidates") result.maxCandidates = parsePositiveInt(argv[++index], result.maxCandidates);
    else if (arg === "--detail-limit") result.detailLimit = parseNonNegativeInt(argv[++index], result.detailLimit);
    else if (arg === "--detail-source") result.detailSource = argv[++index];
    else if (arg === "--delay-ms") result.delayMs = parseNonNegativeInt(argv[++index], result.delayMs);
    else if (arg === "--slow-live") result.slowLive = true;
    else if (arg === "--no-slow-live") result.slowLive = false;
    else if (arg === "--no-navigate") result.allowNavigate = false;
    else if (arg === "--request-cv") result.requestCv = true;
    else if (arg === "--no-request-cv") result.requestCv = false;
    else if (arg === "--dry-run-request-cv") result.dryRunRequestCv = true;
    else if (arg === "--use-llm") result.useLlm = true;
    else if (arg === "--no-llm") result.useLlm = false;
    else if (arg === "--llm-timeout-ms") result.llmTimeoutMs = parsePositiveInt(argv[++index], result.llmTimeoutMs);
    else if (arg === "--online-resume-button-timeout-ms") result.onlineResumeButtonTimeoutMs = parsePositiveInt(argv[++index], result.onlineResumeButtonTimeoutMs);
    else if (arg === "--max-image-pages") result.maxImagePages = parsePositiveInt(argv[++index], result.maxImagePages);
    else if (arg === "--list-max-scrolls") result.listMaxScrolls = parsePositiveInt(argv[++index], result.listMaxScrolls);
    else if (arg === "--empty-list-evidence-dir") index += 1;
    else if (arg === "--timeout-ms") result.timeoutMs = parsePositiveInt(argv[++index], result.timeoutMs);
    else if (arg === "--poll-interval-ms") result.pollIntervalMs = parsePositiveInt(argv[++index], result.pollIntervalMs);
    else if (arg === "--health-first") result.healthFirst = true;
    else if (arg === "--no-prepare-first") result.prepareFirst = false;
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
  if (response?.error) {
    throw new Error(`Tool ${name} failed: ${response.error.message || JSON.stringify(response.error)}`);
  }
  const payload = response?.result?.structuredContent;
  if (!payload) throw new Error(`Tool ${name} did not return structuredContent`);
  return payload;
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeMethods(methodLog = []) {
  const summary = {};
  for (const entry of methodLog || []) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function sampleMethodLog(methodLog = [], edgeCount = 25) {
  const safeLog = Array.isArray(methodLog) ? methodLog : [];
  if (safeLog.length <= edgeCount * 2) return safeLog;
  return [
    ...safeLog.slice(0, edgeCount),
    { method: "...", omitted: safeLog.length - edgeCount * 2 },
    ...safeLog.slice(-edgeCount)
  ];
}

function compactChatContext(context = null) {
  if (!context || typeof context !== "object") return context || null;
  const jobSelection = context.job_selection || null;
  const primaryLabel = context.primary_label || null;
  const startFilter = context.start_filter || null;
  return {
    requested_start_from: context.requested_start_from || null,
    primary_label: primaryLabel ? {
      ok: primaryLabel.ok,
      changed: primaryLabel.changed,
      active_label: primaryLabel.active_label
    } : null,
    job_selection: jobSelection ? {
      selected: jobSelection.selected,
      verified: jobSelection.verified,
      requested: jobSelection.requested,
      selected_label: jobSelection.selected_label,
      selected_value: jobSelection.selected_option?.value || null,
      option_count: Array.isArray(jobSelection.options) ? jobSelection.options.length : undefined,
      reason: jobSelection.reason || null
    } : null,
    start_filter: startFilter ? {
      ok: startFilter.ok,
      changed: startFilter.changed,
      verified: startFilter.verified,
      active_label: startFilter.active_label,
      error: startFilter.error || null
    } : null
  };
}

function compactCandidateList(list = null) {
  if (!list || typeof list !== "object") return list || null;
  const signature = String(list.last_visible_signature || "");
  return {
    domain: list.domain,
    list_name: list.list_name,
    seen_count: list.seen_count,
    queued_count: list.queued_count,
    processed_count: list.processed_count,
    skipped_duplicate_count: list.skipped_duplicate_count,
    read_error_count: list.read_error_count,
    scroll_count: list.scroll_count,
    stable_signature_count: list.stable_signature_count,
    last_visible_signature_sample: signature.slice(0, 240),
    last_visible_signature_length: signature.length,
    last_result: list.last_result || null
  };
}

function compactLlmScreening(llm = null) {
  if (!llm || typeof llm !== "object") return llm || null;
  return {
    ok: llm.ok,
    provider: llm.provider,
    passed: llm.passed,
    cot_length: String(llm.cot || "").length,
    reasoning_content_length: String(llm.reasoning_content || "").length,
    raw_model_output_length: String(llm.raw_model_output || "").length,
    evidence_count: llm.evidence_count,
    usage: llm.usage || null,
    finish_reason: llm.finish_reason || null,
    image_input_count: llm.image_input_count || 0
  };
}

function compactSummary(summary = null) {
  if (!summary || typeof summary !== "object") return summary || null;
  const results = Array.isArray(summary.results) ? summary.results : [];
  return {
    ...summary,
    context_setup: compactChatContext(summary.context_setup),
    empty_list_state: summary.empty_list_state || null,
    candidate_list: compactCandidateList(summary.candidate_list),
    results: results.slice(0, 3).map((item) => ({
      index: item.index,
      candidate_key: item.candidate_key,
      candidate: item.candidate,
      screening: item.screening,
      post_action: item.post_action,
      detail: item.detail ? {
        cv_acquisition: item.detail.cv_acquisition,
        llm_screening: compactLlmScreening(item.detail.llm_screening),
        image_evidence: item.detail.image_evidence
      } : null
    })),
    result_count: results.length,
    results_truncated: results.length > 3
  };
}

function compactRun(run = null) {
  if (!run || typeof run !== "object") return run || null;
  const result = run.result && typeof run.result === "object"
    ? {
        run_id: run.result.run_id,
        status: run.result.status,
        completion_reason: run.result.completion_reason,
        processed_count: run.result.processed_count,
        screened_count: run.result.screened_count,
        passed_count: run.result.passed_count,
        requested_count: run.result.requested_count,
        detail_opened: run.result.detail_opened,
        llm_screened: run.result.llm_screened,
        output_csv: run.result.output_csv,
        report_json: run.result.report_json,
        checkpoint_path: run.result.checkpoint_path
      }
    : run.result || null;
  return {
    run_id: run.run_id || run.runId || null,
    state: run.state || run.status || null,
    status: run.status || null,
    stage: run.stage || run.phase || null,
    progress: run.progress || null,
    context: run.context ? {
      job: run.context.job,
      start_from: run.context.start_from,
      target_count: run.context.target_count,
      target_count_semantics: run.context.target_count_semantics,
      shared_run_context: run.context.shared_run_context
        ? {
            detail_source: run.context.shared_run_context.detail_source,
            detail_limit: run.context.shared_run_context.detail_limit,
            request_resume_for_passed: run.context.shared_run_context.request_resume_for_passed
          }
        : null
    } : null,
    checkpoint: run.checkpoint ? {
      chat_context: compactChatContext(run.checkpoint.chat_context),
      empty_list_state: run.checkpoint.empty_list_state || null,
      terminal_empty_list_state: run.checkpoint.terminal_empty_list_state || null
    } : null,
    result,
    resume: run.resume || null,
    artifacts: run.artifacts || null,
    error: run.error || null
  };
}

function compactPayload(payload = null) {
  if (!payload || typeof payload !== "object") return payload || null;
  return {
    status: payload.status,
    stage: payload.stage,
    run_id: payload.run_id,
    state: payload.state,
    page_url: payload.page_url,
    selected_job_label: payload.selected_job_label,
    selected_job: payload.selected_job,
    missing_fields: payload.missing_fields,
    job_options_count: Array.isArray(payload.job_options) ? payload.job_options.length : undefined,
    runtime_evaluate_used: payload.runtime_evaluate_used,
    method_summary: payload.method_summary || summarizeMethods(payload.method_log || []),
    method_log_count: Array.isArray(payload.method_log) ? payload.method_log.length : 0,
    method_log_sample: sampleMethodLog(payload.method_log || [], 8),
    chrome: payload.chrome || null,
    run: compactRun(payload.run),
    error: payload.error || null
  };
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
  const args = {
    job: options.job,
    start_from: options.startFrom,
    target_count: options.targetCount,
    criteria: options.criteria,
    host: options.host,
    port: options.port,
    slow_live: options.slowLive,
    allow_navigate: options.allowNavigate,
    max_candidates: options.maxCandidates,
    detail_source: options.detailSource,
    delay_ms: options.delayMs,
    request_cv: options.requestCv,
    dry_run_request_cv: options.dryRunRequestCv,
    use_llm: options.useLlm,
    llm_timeout_ms: options.llmTimeoutMs,
    online_resume_button_timeout_ms: options.onlineResumeButtonTimeoutMs,
    max_image_pages: options.maxImagePages,
    list_max_scrolls: options.listMaxScrolls,
    test_visual_empty_list_note: "Visual empty-list inspection is test-only and not passed into the product run path."
  };
  if (options.detailLimit !== null && options.detailLimit !== undefined) {
    args.detail_limit = options.detailLimit;
  }
  return args;
}

async function waitForTerminal(runId, options, result) {
  const started = Date.now();
  let lastPayload = null;
  while (Date.now() - started <= options.timeoutMs) {
    lastPayload = await callTool(TOOL_GET, { run_id: runId }, 2000);
    const status = lastPayload?.run?.status || lastPayload?.run?.state;
    result.last_progress = lastPayload?.run?.progress || null;
    if (["completed", "failed", "canceled"].includes(status)) return lastPayload;
    await sleep(options.pollIntervalMs);
  }
  try {
    result.timeout_cancel = await callTool(TOOL_CANCEL, { run_id: runId }, 9000);
  } catch (error) {
    result.timeout_cancel_error = error?.message || String(error);
  }
  throw new Error(`Timed out waiting for chat run ${runId}; last=${JSON.stringify(lastPayload?.run?.progress || null)}`);
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
    options: {
      ...options,
      criteria: options.criteria ? "[provided]" : ""
    }
  };

  try {
    if (!options.job) throw new Error("--job is required");
    if (!options.criteria) throw new Error("--criteria or --criteria-file is required");

    if (options.healthFirst) {
      const healthPayload = await callTool(TOOL_HEALTH, {
        host: options.host,
        port: options.port,
        slow_live: options.slowLive,
        allow_navigate: options.allowNavigate
      }, 4);
      if (healthPayload.status !== "OK") throw new Error(`Unexpected health status: ${healthPayload.status}`);
      assertNoRuntime(healthPayload.method_log || []);
      result.health = compactPayload(healthPayload);
    }

    if (options.prepareFirst) {
      const preparePayload = await callTool(TOOL_PREPARE, {
        host: options.host,
        port: options.port,
        slow_live: options.slowLive,
        allow_navigate: options.allowNavigate,
        job: options.job,
        start_from: options.startFrom,
        target_count: options.targetCount,
        criteria: options.criteria
      }, 5);
      if (!["READY", "NEED_INPUT"].includes(preparePayload.status)) {
        throw new Error(`Unexpected prepare status: ${preparePayload.status}`);
      }
      assertNoRuntime(preparePayload.method_log || []);
      result.prepare = compactPayload(preparePayload);
    }

    const startPayload = await callTool(TOOL_START, buildChatArgs(options), 10);
    result.started = compactPayload(startPayload);
    if (startPayload.status !== "ACCEPTED") {
      throw new Error(`Expected ACCEPTED from start tool, got ${startPayload.status}`);
    }
    assertNoRuntime(startPayload.method_log || []);

    const finalPayload = await waitForTerminal(startPayload.run_id, options, result);
    result.final = compactPayload(finalPayload);
    const finalRun = finalPayload.run || {};
    const finalStatus = finalRun.status || finalRun.state;
    const methodLog = [
      ...(startPayload.method_log || []),
      ...(finalPayload.method_log || [])
    ];
    assertNoRuntime(methodLog);
    result.runtime_evaluate_used = false;
    result.method_summary = summarizeMethods(methodLog);
    result.method_log_count = methodLog.length;
    result.method_log_sample = sampleMethodLog(methodLog);
    result.output_csv = finalRun.result?.output_csv || finalRun.resume?.output_csv || null;
    result.report_json = finalRun.result?.report_json || null;
    result.final_progress = finalRun.progress || null;
    result.final_summary = compactSummary(finalRun.summary || finalRun.result || null);

    if (finalStatus !== "completed") {
      throw new Error(`Expected completed chat run, got ${finalStatus}: ${finalRun.error?.message || ""}`);
    }

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
