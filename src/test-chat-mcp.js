#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables } from "./index.js";
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
    const completed = await waitForChatRun(started.run_id, (run) => run?.status === "completed");
    assert.equal(completed.result.requested_count, 1);
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
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify({
    run_id: runId,
    mode: "async",
    state: "running",
    status: "running",
    stage: "chat:cleanup",
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    heartbeat_at: "2026-01-01T00:00:01.000Z",
    completed_at: null,
    pid: -1,
    progress: {
      processed: 0,
      screened: 0,
      passed: 0,
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
    resume: {},
    error: null,
    result: null,
    artifacts: null
  }, null, 2));

  const payload = await callTool(TOOL_GET, { run_id: runId }, 13);
  assert.equal(payload.status, "RUN_STATUS");
  assert.equal(payload.run.status, "failed");
  assert.equal(payload.run.error.code, "STALE_RUN_PROCESS_EXITED");
  assert.equal(payload.persistence.source, "disk");
  assert.equal(payload.persistence.stale_finalized, true);
  assert.equal(fs.existsSync(payload.run.result.output_csv), true);
  assert.equal(fs.existsSync(payload.run.result.report_json), true);
  const csv = fs.readFileSync(payload.run.result.output_csv, "utf8");
  assert.equal(csv.includes("screen_params.post_action"), true);
  assert.equal(csv.includes("request_cv"), true);
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
