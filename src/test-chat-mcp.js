#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables } from "./index.js";
import {
  __setChatMcpSpawnForTests,
  __writeChatJsonAtomicForTests,
  runBossChatDetachedWorker,
  startBossChatDetachedRunTool
} from "./chat-mcp.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "./core/cv-acquisition/index.js";

const {
  handleRequest,
  resetChatMcpStateForTests,
  setChatMcpConnectorForTests,
  setChatMcpJobReaderForTests,
  setChatMcpWorkflowForTests
} = __testables;

const TOOL_LIST_CHAT_JOBS = "list_boss_chat_jobs";
const TOOL_PREPARE = "prepare_boss_chat_run";
const TOOL_HEALTH = "boss_chat_health_check";
const TOOL_START = "start_boss_chat_run";
const TOOL_GET = "get_boss_chat_run";
const TOOL_PAUSE = "pause_boss_chat_run";
const TOOL_RESUME = "resume_boss_chat_run";
const TOOL_CANCEL = "cancel_boss_chat_run";
const TOOL_LIST_RECOMMEND_JOBS = "list_recommend_jobs";
const TOOL_START_RECOMMEND = "start_recommend_pipeline_run";

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

async function callTool(name, args = {}, id = 1) {
  const response = await handleRequest(makeToolCall(id, name, args), process.cwd());
  return response?.result?.structuredContent;
}

async function waitForChatRun(runId, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const payload = await callTool(TOOL_GET, { run_id: runId }, 900);
    if (predicate(payload?.run)) return payload.run;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for chat run ${runId}`);
}

function readyArgs(extra = {}) {
  return {
    job: "算法工程师",
    start_from: "all",
    target_count: 3,
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    delay_ms: 120,
    ...extra
  };
}

function installFakeConnector({ onConnect = null } = {}) {
  let closeCount = 0;
  setChatMcpConnectorForTests(async (options = {}) => {
    if (typeof onConnect === "function") onConnect(options);
    return {
      client: { guarded: true },
      target: {
        id: "fake-chat-target",
        url: "https://www.zhipin.com/web/chat/index",
        type: "page"
      },
      methodLog: [
        { method: "DOM.getDocument", at: new Date().toISOString() },
        { method: "DOM.querySelectorAll", at: new Date().toISOString() },
        { method: "Input.dispatchMouseEvent", at: new Date().toISOString() }
      ],
      navigation: {
        navigated: false,
        url: "https://www.zhipin.com/web/chat/index"
      },
      health: {
        status: "healthy"
      },
      async close() {
        closeCount += 1;
      }
    };
  });
  return {
    get closeCount() {
      return closeCount;
    }
  };
}

async function testToolListIncludesChatTools() {
  const response = await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  }, process.cwd());
  const tools = response?.result?.tools || [];
  const names = new Set(tools.map((tool) => tool.name));
  assert.equal(names.has(TOOL_HEALTH), true);
  assert.equal(names.has(TOOL_LIST_CHAT_JOBS), true);
  assert.equal(names.has(TOOL_PREPARE), true);
  assert.equal(names.has(TOOL_START), true);
  assert.equal(names.has(TOOL_GET), true);
  assert.equal(names.has(TOOL_PAUSE), true);
  assert.equal(names.has(TOOL_RESUME), true);
  assert.equal(names.has(TOOL_CANCEL), true);
  const toolOrder = tools.map((tool) => tool.name);
  assert.equal(toolOrder.indexOf(TOOL_LIST_CHAT_JOBS) < toolOrder.indexOf(TOOL_LIST_RECOMMEND_JOBS), true);
  assert.equal(toolOrder.indexOf(TOOL_PREPARE) < toolOrder.indexOf(TOOL_LIST_RECOMMEND_JOBS), true);
  assert.equal(toolOrder.indexOf(TOOL_START) < toolOrder.indexOf(TOOL_START_RECOMMEND), true);
  const listChatJobsTool = tools.find((tool) => tool.name === TOOL_LIST_CHAT_JOBS);
  const startTool = tools.find((tool) => tool.name === TOOL_START);
  assert.equal(listChatJobsTool.description.includes("prepare_boss_chat_run"), true);
  assert.equal(listChatJobsTool.description.includes("list_recommend_jobs"), true);
  assert.equal(startTool.description.includes("start_recommend_pipeline_run"), true);
  assert.deepEqual(startTool.inputSchema.required, ["job", "start_from"]);
  assert.deepEqual(startTool.inputSchema.properties.screening_mode.enum, ["llm", "deterministic", "collect_cv"]);
  assert.equal(startTool.inputSchema.properties.criteria.description.includes("collect_cv"), true);
  assert.deepEqual(startTool.inputSchema.properties.human_behavior.properties.restLevel.enum, ["low", "medium", "high"]);
  assert.deepEqual(startTool.inputSchema.properties.human_behavior.properties.rest_level.enum, ["low", "medium", "high"]);
}

async function testChatPrepareReadsJobOptions() {
  let connectorCalled = false;
  setChatMcpConnectorForTests(async () => {
    connectorCalled = true;
    return {
      client: { guarded: true },
      target: {
        id: "fake-chat-target",
        url: "https://www.zhipin.com/web/chat/index",
        type: "page"
      },
      methodLog: [
        { method: "DOM.getDocument", at: new Date().toISOString() },
        { method: "DOM.querySelectorAll", at: new Date().toISOString() }
      ],
      navigation: {
        navigated: false,
        url: "https://www.zhipin.com/web/chat/index"
      },
      health: {
        status: "healthy"
      },
      async close() {}
    };
  });
  setChatMcpJobReaderForTests(async () => ({
    selector: ".chat-job .ui-dropmenu-list li",
    source: "chat-job-list",
    selected_label: "全部职位",
    job_options: [
      { index: 1, label: "全部职位", value: "-1", active: true, is_all: true },
      { index: 2, label: "算法工程师 _ 杭州 25-50K", value: "job-1", active: false, is_all: false }
    ]
  }));

  const payload = await callTool(TOOL_PREPARE, {}, 22);
  assert.equal(connectorCalled, true);
  assert.equal(payload.status, "NEED_INPUT");
  assert.deepEqual(payload.missing_fields, ["job", "start_from", "target_count"]);
  assert.equal(payload.criteria_optional, true);
  assert.equal(payload.empty_criteria_mode, "collect_cv");
  assert.equal(payload.runtime_evaluate_used, false);
  assert.equal(payload.job_options.length, 2);
  assert.equal(payload.pending_questions.find((question) => question.field === "job").options.length, 2);
  assert.equal(payload.method_summary["DOM.getDocument"], 1);
}

async function testChatJobListAliasReadsJobOptions() {
  let connectorCalled = false;
  setChatMcpConnectorForTests(async () => {
    connectorCalled = true;
    return {
      client: { guarded: true },
      target: {
        id: "fake-chat-target",
        url: "https://www.zhipin.com/web/chat/index",
        type: "page"
      },
      methodLog: [
        { method: "DOM.getDocument", at: new Date().toISOString() }
      ],
      navigation: {
        navigated: false,
        url: "https://www.zhipin.com/web/chat/index"
      },
      health: {
        status: "healthy"
      },
      async close() {}
    };
  });
  setChatMcpJobReaderForTests(async () => ({
    selector: ".chat-job .ui-dropmenu-list li",
    source: "chat-job-list",
    selected_label: "全部职位",
    job_options: [
      { index: 1, label: "全部职位", value: "-1", active: true, is_all: true },
      { index: 2, label: "海外用户增长运营专家（AI产品） _ 上海 25-45K", value: "job-1", active: false, is_all: false }
    ]
  }));

  const payload = await callTool(TOOL_LIST_CHAT_JOBS, {}, 22_1);
  assert.equal(connectorCalled, true);
  assert.equal(payload.status, "NEED_INPUT");
  assert.equal(payload.stage, "chat_run_setup");
  assert.equal(payload.page_url, "https://www.zhipin.com/web/chat/index");
  assert.equal(payload.job_options.length, 2);
  assert.equal(payload.message.includes("Boss 聊天页岗位列表"), true);
}

async function testChatHealthCheckUsesCdpRoute() {
  let connectOptions = null;
  const connector = installFakeConnector({
    onConnect(options) {
      connectOptions = options;
    }
  });
  const payload = await callTool(TOOL_HEALTH, {}, 23);
  assert.equal(payload.status, "OK");
  assert.equal(payload.mode, "cdp-only");
  assert.equal(payload.cdp_only, true);
  assert.equal(payload.shared_llm_config, true);
  assert.equal(payload.runtime_evaluate_used, false);
  assert.equal(payload.method_summary["DOM.getDocument"], 1);
  assert.equal(payload.cli_path, null);
  assert.equal(connectOptions.port, 9555);
  assert.equal(payload.chrome.port, 9555);
  assert.equal(payload.debug_port, 9555);
  assert.equal(payload.output_dir, process.env.TEST_BOSS_OUTPUT_DIR);
  assert.equal(connector.closeCount, 1);
}

async function testChatInputValidationBeforeBrowserConnect() {
  let connectorCalled = false;
  setChatMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("should not connect before validation");
  });
  const response = await handleRequest(makeToolCall(2, TOOL_START, {
    start_from: "invalid-value"
  }), process.cwd());
  assert.equal(response.error.code, -32602);
  assert.equal(connectorCalled, false);
}

async function testChatNeedInputDoesNotConnect() {
  let connectorCalled = false;
  setChatMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("should not connect for missing input");
  });
  const payload = await callTool(TOOL_START, {
    start_from: "all"
  }, 21);
  assert.equal(payload.status, "NEED_INPUT");
  assert.deepEqual(payload.missing_fields, ["job", "target_count"]);
  assert.equal(payload.criteria_optional, true);
  assert.equal(payload.empty_criteria_mode, "collect_cv");
  assert.equal(payload.runtime_evaluate_used, undefined);
  assert.equal(payload.job_options.length, 0);
  assert.equal(payload.pending_questions.some((question) => question.field === "target_count"), true);
  assert.equal(connectorCalled, false);
}

async function testChatBlankCriteriaStartsCvCollectionWithoutLlmConfig() {
  installFakeConnector();
  const previousConfig = process.env.BOSS_RECOMMEND_SCREEN_CONFIG;
  process.env.BOSS_RECOMMEND_SCREEN_CONFIG = path.join(process.env.BOSS_CHAT_HOME, "missing-screening-config.json");
  setChatMcpWorkflowForTests(async (options, runControl) => {
    assert.equal(options.criteria, "");
    assert.equal(options.screeningMode, "collect_cv");
    assert.equal(options.requestResumeForPassed, true);
    assert.equal(options.detailLimit, 100000);
    assert.equal(options.llmConfig, null);
    runControl.setPhase("chat:test");
    runControl.updateProgress({
      processed: 1,
      screened: 1,
      passed: 1,
      requested: 1,
      target_count: options.targetPassCount
    });
    return {
      domain: "chat",
      processed: 1,
      screened: 1,
      detail_opened: 1,
      llm_screened: 0,
      passed: 1,
      requested: 1,
      results: []
    };
  });
  try {
    const started = await callTool(TOOL_START, {
      job: "算法工程师",
      start_from: "all",
      target_count: "all",
      criteria: "",
      delay_ms: 0
    }, 24);
    assert.equal(started.status, "ACCEPTED");
    assert.equal(started.run.context.criteria_present, false);
    assert.equal(started.run.context.screening_mode, "collect_cv");
    assert.equal(started.run.context.cv_collection_mode, true);
    assert.equal(started.run.context.llm_configured, false);
    assert.equal(started.run.context.human_rest_enabled, true);
    assert.equal(started.run.context.human_rest_per_candidate_enabled, false);
    assert.equal(started.run.context.human_rest_per_candidate_min_ms, null);
    assert.equal(started.run.context.human_rest_per_candidate_max_ms, null);
    assert.equal(started.run.context.collect_cv_processing_floor_enabled, true);
    assert.equal(started.run.context.collect_cv_processing_floor_min_ms, 10000);
    assert.equal(started.run.context.collect_cv_processing_floor_max_ms, 15000);
    const completed = await waitForChatRun(started.run_id, (run) => run?.status === "completed");
    assert.equal(completed.result.requested_count, 1);
    const csv = fs.readFileSync(completed.result.output_csv, "utf8");
    assert.equal(csv.includes("chat_params.collect_cv_processing_floor_enabled"), true);
    assert.equal(csv.includes("chat_params.collect_cv_processing_floor_min_ms"), true);
    assert.equal(csv.includes("10000"), true);
    assert.equal(csv.includes("chat_params.collect_cv_processing_floor_max_ms"), true);
    assert.equal(csv.includes("15000"), true);
    assert.equal(csv.includes("chat_params.collect_cv_processing_floor_count"), true);
    assert.equal(csv.includes("chat_params.collect_cv_processing_floor_delay_requested_ms"), true);
    assert.equal(csv.includes("chat_params.collect_cv_processing_floor_delay_ms"), true);
  } finally {
    if (previousConfig === undefined) {
      delete process.env.BOSS_RECOMMEND_SCREEN_CONFIG;
    } else {
      process.env.BOSS_RECOMMEND_SCREEN_CONFIG = previousConfig;
    }
  }
}

async function testChatAsyncPauseResumeCancel() {
  const connector = installFakeConnector();
  setChatMcpWorkflowForTests(async (options, runControl) => {
    assert.equal(options.targetPassCount, 3);
    assert.equal(options.processUntilListEnd, false);
    assert.equal(options.maxCandidates, 100000);
    assert.equal(options.detailLimit, 100000);
    assert.equal(options.screeningMode, "llm");
    assert.equal(options.maxImagePages, DEFAULT_MAX_IMAGE_PAGES);
    assert.equal(options.llmConfig.apiKey, "sk-test-key");
    for (let index = 0; index < 4; index += 1) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("chat:test");
      runControl.updateProgress({
        card_count: 4,
        target_count: options.maxCandidates,
        processed: index + 1,
        screened: index + 1,
        passed: index
      });
      await runControl.sleep(120);
    }
    return {
      domain: "chat",
      processed: 4,
      screened: 4,
      detail_opened: 0,
      llm_screened: 0,
      passed: 3,
      results: []
    };
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 120 }), 3);
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.runtime_evaluate_used, false);
  assert.equal(started.method_summary["DOM.getDocument"], 1);
  assert.equal(started.run.context.job, "算法工程师");
  assert.equal(started.run.context.start_from, "all");
  assert.equal(started.run.context.target_count, 3);
  const runId = started.run_id;

  await waitForChatRun(runId, (run) => run?.progress?.processed >= 1);
  const pausePayload = await callTool(TOOL_PAUSE, { run_id: runId }, 4);
  assert.equal(pausePayload.status, "PAUSE_REQUESTED");

  const paused = await waitForChatRun(runId, (run) => run?.status === "paused");
  assert.equal(paused.canResume, true);
  assert.equal(fs.existsSync(paused.artifacts.run_state_path), true);

  const resumePayload = await callTool(TOOL_RESUME, { run_id: runId }, 5);
  assert.equal(resumePayload.status, "RESUME_REQUESTED");

  const resumed = await waitForChatRun(runId, (run) => run?.progress?.processed > paused.progress.processed);
  assert.equal(resumed.status, "running");

  const cancelPayload = await callTool(TOOL_CANCEL, { run_id: runId }, 6);
  assert.equal(cancelPayload.status, "CANCEL_REQUESTED");

  const canceled = await waitForChatRun(runId, (run) => run?.status === "canceled");
  assert.equal(canceled.result.completion_reason, "canceled_by_user");
  assert.equal(canceled.result.processed_count >= resumed.progress.processed, true);

  resetChatMcpStateForTests();
  const diskPayload = await callTool(TOOL_GET, { run_id: runId }, 7);
  assert.equal(diskPayload.status, "RUN_STATUS");
  assert.equal(diskPayload.run.state, "canceled");
  assert.equal(diskPayload.persistence.source, "disk");
  assert.equal(diskPayload.persistence.active_control_available, false);
  assert.equal(connector.closeCount >= 1, true);
}

async function testChatDiskControlRequestsSurviveActiveSnapshotRefresh() {
  installFakeConnector();
  setChatMcpWorkflowForTests(async (options, runControl) => {
    for (let index = 0; index < 20; index += 1) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("chat:detached-control-test");
      runControl.updateProgress({
        card_count: 20,
        target_count: options.maxCandidates,
        processed: index + 1,
        screened: index + 1,
        passed: index + 1
      });
      await runControl.sleep(80);
    }
    return {
      domain: "chat",
      processed: 20,
      screened: 20,
      detail_opened: 0,
      llm_screened: 0,
      passed: 20,
      results: []
    };
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 80 }), 30);
  assert.equal(started.status, "ACCEPTED");
  const running = await waitForChatRun(started.run_id, (run) => run?.progress?.processed >= 1);
  const statePath = running.artifacts.run_state_path;

  const patchDiskControl = (patch) => {
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    persisted.control = {
      ...(persisted.control || {}),
      ...patch
    };
    fs.writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  };

  patchDiskControl({
    pause_requested: true,
    pause_requested_at: "2026-01-01T00:00:00.000Z",
    pause_requested_by: "pause_boss_chat_run",
    cancel_requested: false
  });
  const pauseRefresh = await callTool(TOOL_GET, { run_id: started.run_id }, 31);
  assert.equal(pauseRefresh.run.control.pause_requested, true);
  assert.equal(pauseRefresh.run.control.pause_requested_by, "pause_boss_chat_run");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).control.pause_requested, true);

  await callTool(TOOL_PAUSE, { run_id: started.run_id }, 32);
  const paused = await waitForChatRun(started.run_id, (run) => run?.status === "paused");
  assert.equal(paused.control.pause_requested, true);

  patchDiskControl({
    pause_requested: false,
    pause_requested_at: null,
    pause_requested_by: null,
    cancel_requested: false
  });
  const resumeRefresh = await callTool(TOOL_GET, { run_id: started.run_id }, 33);
  assert.equal(resumeRefresh.run.status, "paused");
  assert.equal(resumeRefresh.run.control.pause_requested, false);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).control.pause_requested, false);

  await callTool(TOOL_RESUME, { run_id: started.run_id }, 34);
  await waitForChatRun(started.run_id, (run) => run?.status === "running");

  patchDiskControl({
    pause_requested: true,
    pause_requested_at: "2026-01-01T00:01:00.000Z",
    pause_requested_by: "cancel_boss_chat_run",
    cancel_requested: true
  });
  const cancelRefresh = await callTool(TOOL_GET, { run_id: started.run_id }, 35);
  assert.equal(cancelRefresh.run.control.cancel_requested, true);
  assert.equal(cancelRefresh.run.control.pause_requested_by, "cancel_boss_chat_run");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).control.cancel_requested, true);

  await callTool(TOOL_CANCEL, { run_id: started.run_id }, 36);
  const canceled = await waitForChatRun(started.run_id, (run) => run?.status === "canceled");
  assert.equal(canceled.result.completion_reason, "canceled_by_user");
}

async function testChatAllTargetCountContext() {
  installFakeConnector();
  setChatMcpWorkflowForTests(async (options, runControl) => {
    assert.equal(options.targetPassCount, null);
    assert.equal(options.processUntilListEnd, true);
    assert.equal(options.maxCandidates, 2);
    runControl.setPhase("chat:test");
    runControl.updateProgress({ processed: 1, screened: 1, passed: 1, target_count: options.maxCandidates });
    return {
      domain: "chat",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      llm_screened: 0,
      passed: 1,
      results: []
    };
  });
  const started = await callTool(TOOL_START, readyArgs({
    targetCount: "all",
    max_candidates: 2,
    target_count: undefined,
    delay_ms: 0
  }), 8);
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.run.context.target_count, "all");
  assert.equal(started.run.context.max_candidates, 2);
  const completed = await waitForChatRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(completed.result.processed_count, 1);
}

async function testChatRequestCvLoadsLlmConfig() {
  installFakeConnector();
  setChatMcpWorkflowForTests(async (options, runControl) => {
    assert.equal(options.requestResumeForPassed, true);
    assert.equal(options.targetPassCount, 2);
    assert.equal(options.detailLimit, 100000);
    assert.equal(options.llmConfig.apiKey, "sk-test-key");
    assert.equal(options.llmConfig.baseUrl, "https://api.example.com/v1");
    assert.equal(options.llmConfig.model, "gpt-4.1-mini");
    assert.equal(options.llmConfig.llmThinkingLevel, "low");
    assert.equal(options.llmConfig.llmScreeningStrategy, "fast_first_verified");
    assert.equal(options.llmConfig.llmFastThinkingLevel, "current");
    assert.equal(options.llmConfig.llmVerifyThinkingLevel, "medium");
    assert.equal(options.llmConfig.llmFastMaxTokens, 320);
    assert.equal(options.llmConfig.llmVerifyMaxTokens, 1536);
    assert.equal(options.llmConfig.llmMaxTokens, 384);
    assert.equal(options.llmConfig.llmMaxRetries, 2);
    assert.equal(options.llmConfig.llmTimeoutMs, 70000);
    assert.equal(options.llmConfig.llmImageLimit, 6);
    assert.equal(options.llmConfig.llmImageDetail, "high");
    assert.equal(options.llmConfig.openaiOrganization, "org-test");
    assert.equal(options.llmConfig.openaiProject, "proj-test");
    assert.equal(options.llmConfig.temperature, 0);
    assert.equal(options.llmConfig.topP, 0.2);
    assert.equal(options.llmConfig.outputDir, process.env.TEST_BOSS_OUTPUT_DIR);
    assert.equal(options.llmConfig.humanRestEnabled, true);
    assert.equal(options.humanRestEnabled, true);
    assert.equal(options.humanBehavior.profile, "paced_with_rests");
    assert.equal(options.humanBehavior.textEntry, true);
    assert.equal(options.humanBehavior.listScrollJitter, true);
    assert.equal(options.humanBehavior.restLevel, "high");
    assert.equal(options.llmConfig.greetingMessage, "配置招呼语");
    assert.equal(options.greetingText, "配置招呼语");
    runControl.setPhase("chat:test");
    runControl.updateProgress({
      processed: 1,
      screened: 1,
      passed: 1,
      requested: 1,
      target_count: options.targetPassCount
    });
    return {
      domain: "chat",
      processed: 1,
      screened: 1,
      detail_opened: 1,
      llm_screened: 1,
      passed: 1,
      requested: 1,
      results: [
        {
          candidate: { identity: { name: "测试候选人" } },
          detail: {
            llm_screening: {
              passed: true,
              cot: "internal reasoning"
            },
            cv_acquisition: { source: "network" }
          },
          screening: {
            passed: true,
            candidate: { identity: { name: "测试候选人" } }
          },
          post_action: {
            requested: true,
            skipped: false,
            reason: "requested"
          }
        }
      ]
    };
  });
  const started = await callTool(TOOL_START, readyArgs({
    target_count: 2,
    detail_limit: undefined,
    use_llm: true,
    delay_ms: 0
  }), 9);
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.target_count_semantics.includes("pass"), true);
  const completed = await waitForChatRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(completed.result.passed_count, 1);
  assert.equal(completed.result.results[0].post_action.requested, true);
  assert.equal(path.dirname(completed.result.output_csv), process.env.TEST_BOSS_OUTPUT_DIR);
  assert.equal(path.dirname(completed.result.report_json), process.env.TEST_BOSS_OUTPUT_DIR);
  assert.equal(fs.existsSync(completed.result.output_csv), true);
  const csv = fs.readFileSync(completed.result.output_csv, "utf8");
  assert.equal(csv.includes("internal reasoning"), true);
  assert.equal(csv.includes("requested"), true);
}

async function testChatSafePacingCompatibilityControlsHumanBehavior() {
  installFakeConnector();
  let observedOptions = null;
  setChatMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("chat:test-human-behavior");
    runControl.updateProgress({
      processed: 1,
      screened: 1,
      passed: 0,
      target_count: options.targetPassCount
    });
    return {
      domain: "chat",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      llm_screened: 0,
      passed: 0,
      results: []
    };
  });
  const started = await callTool(TOOL_START, readyArgs({
    safe_pacing: true,
    batch_rest_enabled: false,
    delay_ms: 0
  }), 10);
  assert.equal(started.status, "ACCEPTED");
  await waitForChatRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(observedOptions.humanBehavior.profile, "paced");
  assert.equal(observedOptions.humanBehavior.enabled, true);
  assert.equal(observedOptions.humanBehavior.textEntry, true);
  assert.equal(observedOptions.humanBehavior.restLevel, "high");
  assert.equal(observedOptions.humanBehavior.restEnabled, false);
  assert.equal(observedOptions.humanRestEnabled, false);
}

async function testChatRequestCvCanBeExplicitlyDisabled() {
  installFakeConnector();
  setChatMcpWorkflowForTests(async (options, runControl) => {
    assert.equal(options.requestResumeForPassed, false);
    runControl.setPhase("chat:test");
    runControl.updateProgress({
      processed: 1,
      screened: 1,
      passed: 1,
      requested: 0,
      target_count: options.targetPassCount
    });
    return {
      domain: "chat",
      processed: 1,
      screened: 1,
      detail_opened: 1,
      llm_screened: 1,
      passed: 1,
      requested: 0,
      results: []
    };
  });
  const started = await callTool(TOOL_START, readyArgs({
    target_count: 1,
    post_action: "none",
    delay_ms: 0
  }), 10);
  assert.equal(started.status, "ACCEPTED");
  const completed = await waitForChatRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(completed.context.shared_run_context.request_resume_for_passed, false);
}

async function testChatCanceledZeroResultWritesArtifacts() {
  installFakeConnector();
  setChatMcpWorkflowForTests(async (options, runControl) => {
    assert.equal(options.requestResumeForPassed, true);
    runControl.setPhase("chat:test-zero-cancel");
    await runControl.sleep(2000);
    return {
      domain: "chat",
      processed: 0,
      screened: 0,
      passed: 0,
      requested: 0,
      results: []
    };
  });
  const started = await callTool(TOOL_START, readyArgs({
    target_count: 1,
    delay_ms: 0
  }), 11);
  assert.equal(started.status, "ACCEPTED");
  await callTool(TOOL_CANCEL, { run_id: started.run_id }, 12);
  const canceled = await waitForChatRun(started.run_id, (run) => run?.status === "canceled");
  assert.equal(canceled.result.completion_reason, "canceled_by_user");
  assert.equal(canceled.result.processed_count, 0);
  assert.equal(fs.existsSync(canceled.result.output_csv), true);
  assert.equal(fs.existsSync(canceled.result.report_json), true);
  const csv = fs.readFileSync(canceled.result.output_csv, "utf8");
  assert.equal(csv.includes("运行输入字段"), true);
  assert.equal(csv.includes("姓名"), true);
}

async function testChatStaleDiskRunIsFinalizedWithArtifacts() {
  const runId = "mcp_chat_stale_disk_test";
  const runsDir = path.join(process.env.BOSS_CHAT_HOME, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const checkpointPath = path.join(runsDir, `${runId}.checkpoint.json`);
  const workerHeartbeatAt = "2026-01-01T00:00:01.000Z";
  const checkpoint = {
    updatedAt: "2026-01-01T00:00:02.000Z",
    in_progress_candidate: {
      index: 1,
      key: "chat:test:pending",
      detail_step: "select_candidate"
    },
    results: [
      {
        index: 0,
        candidate: {
          identity: { name: "checkpoint-test-candidate" },
          profile: { headline: "算法工程师" }
        },
        screening: {
          status: "pass",
          passed: true,
          score: 90,
          reasons: ["checkpoint hydration test"]
        }
      }
    ]
  };
  fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify({
    run_id: runId,
    mode: "async",
    state: "running",
    status: "running",
    stage: "chat:cleanup",
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    heartbeat_at: workerHeartbeatAt,
    completed_at: null,
    pid: -1,
    progress: {
      processed: 1,
      screened: 1,
      passed: 1,
      requested: 0,
      target_count: "all"
    },
    context: {
      job: "算法工程师",
      start_from: "all",
      target_count: "all",
      criteria: "测试条件",
      request_resume_for_passed: true,
      greeting_text: "测试招呼"
    },
    control: {
      cancel_requested: false
    },
    resume: {
      checkpoint_path: checkpointPath
    },
    error: null,
    result: null,
    artifacts: null
  }, null, 2));

  const payload = await callTool(TOOL_GET, { run_id: runId }, 13);
  assert.equal(payload.status, "RUN_STATUS");
  assert.equal(payload.run.status, "failed");
  assert.equal(payload.run.error.code, "STALE_RUN_PROCESS_EXITED");
  assert.equal(payload.run.heartbeat_at, workerHeartbeatAt);
  assert.equal(payload.run.recovery.worker_last_heartbeat_at, workerHeartbeatAt);
  assert.equal(payload.run.recovery.reconciled_at !== workerHeartbeatAt, true);
  assert.equal(payload.run.recovery.reconciliation_reason, "STALE_RUN_PROCESS_EXITED");
  assert.equal(payload.persistence.source, "disk");
  assert.equal(payload.persistence.stale_finalized, true);
  assert.equal(payload.run.result.processed_count, 1);
  assert.equal(payload.run.result.passed_count, 1);
  assert.equal(fs.existsSync(payload.run.result.output_csv), true);
  assert.equal(fs.existsSync(payload.run.result.report_json), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(checkpointPath, "utf8")), checkpoint);
  const report = JSON.parse(fs.readFileSync(payload.run.result.report_json, "utf8"));
  assert.deepEqual(report.checkpoint, checkpoint);
  assert.equal(report.summary.results.length, 1);
  const csv = fs.readFileSync(payload.run.result.output_csv, "utf8");
  assert.equal(csv.includes("screen_params.post_action"), true);
  assert.equal(csv.includes("request_cv"), true);
}

function makeFilesystemError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function testChatAtomicJsonRenameRetriesTransientWindowsDenial() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-atomic-retry-"));
  const targetPath = path.join(directory, "checkpoint.json");
  fs.writeFileSync(targetPath, `${JSON.stringify({ generation: "old" })}\n`, "utf8");
  const waits = [];
  const sources = [];
  let renameCalls = 0;
  try {
    __writeChatJsonAtomicForTests(targetPath, { generation: "new" }, {
      randomUUIDImpl: () => "transient-retry",
      sleepSyncImpl: (delayMs) => waits.push(delayMs),
      renameSyncImpl: (sourcePath, destinationPath) => {
        renameCalls += 1;
        sources.push(sourcePath);
        if (renameCalls <= 2) {
          throw makeFilesystemError("EPERM", "synthetic transient Windows rename denial");
        }
        fs.renameSync(sourcePath, destinationPath);
      }
    });
    assert.equal(renameCalls, 3);
    assert.deepEqual(waits, [25, 50]);
    assert.deepEqual(JSON.parse(fs.readFileSync(targetPath, "utf8")), { generation: "new" });
    assert.equal(new Set(sources).size, 1);
    assert.match(sources[0], new RegExp(`checkpoint\\.json\\.${process.pid}\\.transient-retry\\.tmp$`));
    assert.equal(fs.existsSync(sources[0]), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testChatAtomicJsonRenameExhaustionPreservesOldCheckpoint() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-atomic-exhaust-"));
  const targetPath = path.join(directory, "checkpoint.json");
  fs.writeFileSync(targetPath, `${JSON.stringify({ generation: "old" })}\n`, "utf8");
  const waits = [];
  let renameCalls = 0;
  let tempPath = "";
  try {
    let error = null;
    try {
      __writeChatJsonAtomicForTests(targetPath, { generation: "new" }, {
        randomUUIDImpl: () => "exhausted-retry",
        sleepSyncImpl: (delayMs) => waits.push(delayMs),
        renameSyncImpl: (sourcePath) => {
          renameCalls += 1;
          tempPath = sourcePath;
          throw makeFilesystemError("EPERM", "synthetic persistent Windows rename denial");
        }
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(error.code, "EPERM");
    assert.equal(error.atomic_rename_attempts, 7);
    assert.deepEqual(error.atomic_rename_retry_delays_ms, [25, 50, 100, 200, 400, 500]);
    assert.equal(renameCalls, 7);
    assert.deepEqual(waits, [25, 50, 100, 200, 400, 500]);
    assert.deepEqual(JSON.parse(fs.readFileSync(targetPath, "utf8")), { generation: "old" });
    assert.equal(fs.existsSync(tempPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testChatAtomicJsonRenameDoesNotRetryNonTransientFailure() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-atomic-fatal-"));
  const targetPath = path.join(directory, "checkpoint.json");
  fs.writeFileSync(targetPath, `${JSON.stringify({ generation: "old" })}\n`, "utf8");
  const waits = [];
  let renameCalls = 0;
  let tempPath = "";
  try {
    let error = null;
    try {
      __writeChatJsonAtomicForTests(targetPath, { generation: "new" }, {
        randomUUIDImpl: () => "fatal-error",
        sleepSyncImpl: (delayMs) => waits.push(delayMs),
        renameSyncImpl: (sourcePath) => {
          renameCalls += 1;
          tempPath = sourcePath;
          throw makeFilesystemError("ENOSPC", "synthetic disk full");
        }
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(error.code, "ENOSPC");
    assert.equal(error.atomic_rename_attempts, 1);
    assert.deepEqual(error.atomic_rename_retry_delays_ms, []);
    assert.equal(renameCalls, 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(targetPath, "utf8")), { generation: "old" });
    assert.equal(fs.existsSync(tempPath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testChatDetachedChildAsyncErrorAndEarlyExitPersist() {
  const makeChild = () => {
    const child = new EventEmitter();
    child.pid = process.pid;
    child.unrefCalled = false;
    child.unref = () => {
      child.unrefCalled = true;
    };
    return child;
  };

  const errorChild = makeChild();
  __setChatMcpSpawnForTests(() => errorChild);
  const errorStarted = await startBossChatDetachedRunTool({
    workspaceRoot: process.cwd(),
    args: readyArgs({ delay_ms: 0 })
  });
  assert.equal(errorStarted.status, "ACCEPTED");
  assert.equal(errorStarted.run.context.cv_collection_mode, false);
  assert.equal(errorStarted.run.context.collect_cv_processing_floor_enabled, false);
  assert.equal(errorStarted.run.context.collect_cv_processing_floor_min_ms, null);
  assert.equal(errorStarted.run.context.collect_cv_processing_floor_max_ms, null);
  assert.equal(errorChild.unrefCalled, true);
  const asyncError = new Error("asynchronous spawn failure");
  asyncError.code = "EACCES";
  assert.doesNotThrow(() => errorChild.emit("error", asyncError));
  const errorState = JSON.parse(fs.readFileSync(errorStarted.run.artifacts.run_state_path, "utf8"));
  assert.equal(errorState.status, "failed");
  assert.equal(errorState.error.code, "CHAT_WORKER_PROCESS_ERROR");
  assert.equal(errorState.error.worker_error_code, "EACCES");
  assert.match(errorState.error.message, /asynchronous spawn failure/);
  assert.equal(errorState.heartbeat_at, errorStarted.run.heartbeat_at);
  assert.equal(errorState.recovery.worker_last_heartbeat_at, errorStarted.run.heartbeat_at);
  assert.equal(typeof errorState.recovery.reconciled_at, "string");

  const exitChild = makeChild();
  __setChatMcpSpawnForTests(() => exitChild);
  const exitStarted = await startBossChatDetachedRunTool({
    workspaceRoot: process.cwd(),
    args: readyArgs({ delay_ms: 0 })
  });
  assert.equal(exitStarted.status, "ACCEPTED");
  exitChild.emit("exit", 7, null);
  const exitState = JSON.parse(fs.readFileSync(exitStarted.run.artifacts.run_state_path, "utf8"));
  assert.equal(exitState.status, "failed");
  assert.equal(exitState.error.code, "CHAT_WORKER_EXITED_EARLY");
  assert.equal(exitState.error.worker_exit_code, 7);
  assert.match(exitState.error.message, /code=7/);
}

async function testChatDetachedCollectCvBootstrapIncludesProcessingFloor() {
  const child = new EventEmitter();
  child.pid = process.pid;
  child.unref = () => {};
  __setChatMcpSpawnForTests(() => child);

  const started = await startBossChatDetachedRunTool({
    workspaceRoot: process.cwd(),
    args: readyArgs({
      criteria: "",
      delay_ms: 0
    })
  });
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.run.context.criteria_present, false);
  assert.equal(started.run.context.screening_mode, "collect_cv");
  assert.equal(started.run.context.cv_collection_mode, true);
  assert.equal(started.run.context.collect_cv_processing_floor_enabled, true);
  assert.equal(started.run.context.collect_cv_processing_floor_min_ms, 10000);
  assert.equal(started.run.context.collect_cv_processing_floor_max_ms, 15000);
  assert.equal(started.run.progress.collect_cv_processing_floor_enabled, true);
  assert.equal(started.run.progress.collect_cv_processing_floor_count, 0);
  assert.equal(started.run.progress.collect_cv_processing_floor_delay_requested_ms, 0);
  assert.equal(started.run.progress.collect_cv_processing_floor_delay_ms, 0);

  child.emit("error", new Error("synthetic collect-CV bootstrap failure"));
  const failedState = JSON.parse(fs.readFileSync(started.run.artifacts.run_state_path, "utf8"));
  assert.equal(failedState.status, "failed");
  assert.equal(failedState.context.collect_cv_processing_floor_enabled, true);
  assert.equal(fs.existsSync(failedState.artifacts.output_csv), true);
  const csv = fs.readFileSync(failedState.artifacts.output_csv, "utf8");
  assert.equal(csv.includes("chat_params.collect_cv_processing_floor_enabled"), true);
  assert.match(csv, /chat_params\.collect_cv_processing_floor_enabled[^\r\n]*true/);
}

async function testChatDetachedChildExitDoesNotOverwriteTerminalState() {
  const child = new EventEmitter();
  child.pid = process.pid;
  child.unref = () => {};
  __setChatMcpSpawnForTests(() => child);
  const started = await startBossChatDetachedRunTool({
    workspaceRoot: process.cwd(),
    args: readyArgs({ delay_ms: 0 })
  });
  assert.equal(started.status, "ACCEPTED");

  const statePath = started.run.artifacts.run_state_path;
  const terminal = JSON.parse(fs.readFileSync(statePath, "utf8"));
  terminal.state = "completed";
  terminal.status = "completed";
  terminal.completed_at = "2026-01-01T00:00:03.000Z";
  terminal.error = null;
  fs.writeFileSync(statePath, `${JSON.stringify(terminal, null, 2)}\n`, "utf8");

  child.emit("exit", 9, "SIGTERM");
  const afterExit = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(afterExit.status, "completed");
  assert.equal(afterExit.completed_at, terminal.completed_at);
  assert.equal(afterExit.error, null);
}

async function testChatDetachedMonitorStorageFailureDoesNotFailQueuedRun() {
  const previousMonitorHome = process.env.BOSS_MONITOR_HOME;
  const previousMonitorRuntimeHome = process.env.RECRUITING_MONITOR_HOME;
  const invalidMonitorHome = path.join(process.env.BOSS_CHAT_HOME, "monitor-home-is-a-file");
  fs.writeFileSync(invalidMonitorHome, "not a directory", "utf8");
  process.env.BOSS_MONITOR_HOME = invalidMonitorHome;
  process.env.RECRUITING_MONITOR_HOME = path.join(
    process.env.BOSS_CHAT_HOME,
    "monitor-runtime-unavailable"
  );
  const child = new EventEmitter();
  child.pid = process.pid;
  child.unref = () => {};
  __setChatMcpSpawnForTests(() => child);
  try {
    const started = await startBossChatDetachedRunTool({
      workspaceRoot: process.cwd(),
      args: readyArgs({ delay_ms: 0 })
    });
    assert.equal(started.status, "ACCEPTED");
    assert.equal(started.state, "queued");
    assert.equal(started.monitoring.availability, "monitor_unavailable");
    assert.equal(started.run.monitoring_v1, undefined);
    const persisted = JSON.parse(fs.readFileSync(started.run.artifacts.run_state_path, "utf8"));
    assert.equal(persisted.state, "queued");
    assert.equal(persisted.monitoring_v1, undefined);
  } finally {
    __setChatMcpSpawnForTests(null);
    if (previousMonitorHome === undefined) {
      delete process.env.BOSS_MONITOR_HOME;
    } else {
      process.env.BOSS_MONITOR_HOME = previousMonitorHome;
    }
    if (previousMonitorRuntimeHome === undefined) {
      delete process.env.RECRUITING_MONITOR_HOME;
    } else {
      process.env.RECRUITING_MONITOR_HOME = previousMonitorRuntimeHome;
    }
  }
}

async function testChatDetachedWorkerSnapshotReplacesBootstrapPid() {
  installFakeConnector();
  setChatMcpWorkflowForTests(async (options, runControl) => {
    assert.equal(options.targetPassCount, 1);
    runControl.setPhase("chat:test-worker-pid");
    runControl.updateProgress({
      processed: 1,
      screened: 1,
      detail_opened: 0,
      llm_screened: 0,
      passed: 1,
      requested: 0,
      request_satisfied: 0,
      request_skipped: 0,
      target_count: options.targetPassCount
    });
    return {
      domain: "chat",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      llm_screened: 0,
      passed: 1,
      requested: 0,
      request_satisfied: 0,
      request_skipped: 0,
      results: []
    };
  });

  const bootstrapPid = 424242;
  const bootstrap = new EventEmitter();
  bootstrap.pid = bootstrapPid;
  bootstrap.unref = () => {};
  __setChatMcpSpawnForTests(() => bootstrap);

  const started = await startBossChatDetachedRunTool({
    workspaceRoot: process.cwd(),
    args: readyArgs({ target_count: 1, delay_ms: 0 })
  });
  assert.equal(started.status, "ACCEPTED");
  const statePath = started.run.artifacts.run_state_path;
  const bootstrapState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(bootstrapState.pid, bootstrapPid);

  const workerResult = await runBossChatDetachedWorker({ runId: started.run_id });
  assert.equal(workerResult.ok, true);
  const workerState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(workerState.pid, process.pid);
  assert.notEqual(workerState.pid, bootstrapPid);
  assert.equal(workerState.status, "completed");
}

async function main() {
  const previousHome = process.env.BOSS_CHAT_HOME;
  const previousScreenConfig = process.env.BOSS_RECOMMEND_SCREEN_CONFIG;
  const previousOutputDir = process.env.TEST_BOSS_OUTPUT_DIR;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-mcp-test-"));
  const outputDir = path.join(tempHome, "configured-output");
  process.env.BOSS_CHAT_HOME = tempHome;
  process.env.TEST_BOSS_OUTPUT_DIR = outputDir;
  const configPath = path.join(tempHome, "screening-config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test-key",
    model: "gpt-4.1-mini",
    debugPort: 9555,
    outputDir,
    greetingMessage: "配置招呼语",
    llmThinkingLevel: "low",
    llmScreeningStrategy: "fast_first_verified",
    llmFastThinkingLevel: "current",
    llmVerifyThinkingLevel: "medium",
    llmFastMaxTokens: 320,
    llmVerifyMaxTokens: 1536,
    llmMaxTokens: 384,
    llmMaxRetries: 2,
    llmTimeoutMs: 70000,
    llmImageLimit: 6,
    llmImageDetail: "high",
    openaiOrganization: "org-test",
    openaiProject: "proj-test",
    temperature: 0,
    topP: 0.2,
    humanRestEnabled: true,
    humanBehavior: {
      rest_level: "high"
    }
  }, null, 2));
  process.env.BOSS_RECOMMEND_SCREEN_CONFIG = configPath;
  try {
    testChatAtomicJsonRenameRetriesTransientWindowsDenial();
    testChatAtomicJsonRenameExhaustionPreservesOldCheckpoint();
    testChatAtomicJsonRenameDoesNotRetryNonTransientFailure();
    await testToolListIncludesChatTools();
    await testChatInputValidationBeforeBrowserConnect();
    resetChatMcpStateForTests();
    await testChatHealthCheckUsesCdpRoute();
    resetChatMcpStateForTests();
    await testChatPrepareReadsJobOptions();
    resetChatMcpStateForTests();
    await testChatJobListAliasReadsJobOptions();
    resetChatMcpStateForTests();
    await testChatNeedInputDoesNotConnect();
    resetChatMcpStateForTests();
    await testChatBlankCriteriaStartsCvCollectionWithoutLlmConfig();
    resetChatMcpStateForTests();
    await testChatAsyncPauseResumeCancel();
    resetChatMcpStateForTests();
    await testChatDiskControlRequestsSurviveActiveSnapshotRefresh();
    resetChatMcpStateForTests();
    await testChatAllTargetCountContext();
    resetChatMcpStateForTests();
    await testChatRequestCvLoadsLlmConfig();
    resetChatMcpStateForTests();
    await testChatSafePacingCompatibilityControlsHumanBehavior();
    resetChatMcpStateForTests();
    await testChatRequestCvCanBeExplicitlyDisabled();
    resetChatMcpStateForTests();
    await testChatCanceledZeroResultWritesArtifacts();
    resetChatMcpStateForTests();
    await testChatStaleDiskRunIsFinalizedWithArtifacts();
    resetChatMcpStateForTests();
    await testChatDetachedChildAsyncErrorAndEarlyExitPersist();
    resetChatMcpStateForTests();
    await testChatDetachedCollectCvBootstrapIncludesProcessingFloor();
    resetChatMcpStateForTests();
    await testChatDetachedChildExitDoesNotOverwriteTerminalState();
    resetChatMcpStateForTests();
    await testChatDetachedMonitorStorageFailureDoesNotFailQueuedRun();
    resetChatMcpStateForTests();
    await testChatDetachedWorkerSnapshotReplacesBootstrapPid();
    console.log("chat MCP tests passed");
  } finally {
    resetChatMcpStateForTests();
    if (previousHome === undefined) {
      delete process.env.BOSS_CHAT_HOME;
    } else {
      process.env.BOSS_CHAT_HOME = previousHome;
    }
    if (previousScreenConfig === undefined) {
      delete process.env.BOSS_RECOMMEND_SCREEN_CONFIG;
    } else {
      process.env.BOSS_RECOMMEND_SCREEN_CONFIG = previousScreenConfig;
    }
    if (previousOutputDir === undefined) {
      delete process.env.TEST_BOSS_OUTPUT_DIR;
    } else {
      process.env.TEST_BOSS_OUTPUT_DIR = previousOutputDir;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

await main();
