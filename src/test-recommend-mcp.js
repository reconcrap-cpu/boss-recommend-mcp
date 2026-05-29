#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables } from "./index.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "./core/cv-acquisition/index.js";

const {
  handleRequest,
  resetRecommendMcpStateForTests,
  runDetachedWorkerForTests,
  setRecommendMcpConnectorForTests,
  setRecommendMcpJobReaderForTests,
  setRecommendMcpWorkflowForTests,
  setSpawnProcessImplForTests
} = __testables;

const TOOL_LIST_JOBS = "list_recommend_jobs";
const TOOL_PREPARE = "prepare_recommend_pipeline_run";
const TOOL_START = "start_recommend_pipeline_run";
const TOOL_GET = "get_recommend_pipeline_run";
const TOOL_PAUSE = "pause_recommend_pipeline_run";
const TOOL_RESUME = "resume_recommend_pipeline_run";
const TOOL_CANCEL = "cancel_recommend_pipeline_run";

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

async function waitForRecommendRun(runId, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const payload = await callTool(TOOL_GET, { run_id: runId }, 900);
    if (predicate(payload?.run)) return payload.run;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for recommend run ${runId}`);
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  }
  throw new Error("Timed out waiting for condition");
}

function readyArgs(extra = {}) {
  return {
    instruction: "推荐页筛选算法候选人，目标处理3位",
    confirmation: {
      page_confirmed: true,
      page_value: "recommend",
      filters_confirmed: true,
      school_tag_confirmed: true,
      school_tag_value: "不限",
      degree_confirmed: true,
      degree_value: "不限",
      gender_confirmed: true,
      gender_value: "不限",
      recent_not_view_confirmed: true,
      recent_not_view_value: "不限",
      criteria_confirmed: true,
      target_count_confirmed: true,
      target_count_value: 3,
      post_action_confirmed: true,
      post_action_value: "none",
      job_confirmed: true,
      job_value: "算法工程师",
      final_confirmed: true
    },
    overrides: {
      page_scope: "recommend",
      school_tag: "不限",
      degree: "不限",
      gender: "不限",
      recent_not_view: "不限",
      criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
      target_count: 3,
      post_action: "none",
      job: "算法工程师"
    },
    delay_ms: 120,
    no_filter: false,
    ...extra
  };
}

function installFakeConnector({ onConnect = null } = {}) {
  let closeCount = 0;
  setRecommendMcpConnectorForTests(async (options = {}) => {
    if (typeof onConnect === "function") onConnect(options);
    return {
      client: { guarded: true },
      target: {
        id: "fake-recommend-target",
        url: "https://www.zhipin.com/web/chat/recommend",
        type: "page"
      },
      methodLog: [
        { method: "DOM.getDocument", at: new Date().toISOString() },
        { method: "DOM.querySelectorAll", at: new Date().toISOString() },
        { method: "Input.dispatchMouseEvent", at: new Date().toISOString() }
      ],
      navigation: {
        navigated: false,
        url: "https://www.zhipin.com/web/chat/recommend"
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

async function testToolListIncludesRecommendTools() {
  const response = await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  }, process.cwd());
  const tools = response?.result?.tools || [];
  const names = new Set(tools.map((tool) => tool.name));
  assert.equal(names.has(TOOL_LIST_JOBS), true);
  assert.equal(names.has(TOOL_PREPARE), true);
  assert.equal(names.has(TOOL_START), true);
  assert.equal(names.has(TOOL_GET), true);
  assert.equal(names.has(TOOL_PAUSE), true);
  assert.equal(names.has(TOOL_RESUME), true);
  assert.equal(names.has(TOOL_CANCEL), true);
  const startTool = tools.find((tool) => tool.name === TOOL_START);
  assert.deepEqual(startTool.inputSchema.properties.human_behavior.properties.restLevel.enum, ["low", "medium", "high"]);
  assert.deepEqual(startTool.inputSchema.properties.human_behavior.properties.rest_level.enum, ["low", "medium", "high"]);
  const prepareTool = tools.find((tool) => tool.name === TOOL_PREPARE);
  assert.deepEqual(prepareTool.inputSchema.properties.confirmation.properties.final_confirmed.type, "boolean");
}

async function testRecommendJobListTool() {
  const connector = installFakeConnector();
  let observedContext = null;
  setRecommendMcpJobReaderForTests(async (session, context) => {
    assert.equal(session.client.guarded, true);
    observedContext = context;
    return {
      source: "test-reader",
      selector: ".job-item",
      selected_job: {
        index: 0,
        name: "算法工程师 23-27届实习/校招/早期职业 _ 杭州",
        label: "算法工程师 23-27届实习/校招/早期职业 _ 杭州 25-50K",
        label_without_salary: "算法工程师 23-27届实习/校招/早期职业 _ 杭州",
        current: true,
        visible: true
      },
      job_options: [
        {
          index: 0,
          name: "算法工程师 23-27届实习/校招/早期职业 _ 杭州",
          label: "算法工程师 23-27届实习/校招/早期职业 _ 杭州 25-50K",
          label_without_salary: "算法工程师 23-27届实习/校招/早期职业 _ 杭州",
          current: true,
          visible: true
        },
        {
          index: 1,
          name: "数据分析实习生 _ 杭州",
          label: "数据分析实习生 _ 杭州 100-150元/天",
          label_without_salary: "数据分析实习生 _ 杭州",
          current: false,
          visible: true
        }
      ]
    };
  });

  const payload = await callTool(TOOL_LIST_JOBS, {
    port: 9222,
    slow_live: true
  }, 12);
  assert.equal(payload.status, "OK");
  assert.equal(payload.stage, "recommend_job_list");
  assert.equal(payload.runtime_evaluate_used, false);
  assert.equal(payload.job_count, 2);
  assert.deepEqual(payload.job_names, [
    "算法工程师 23-27届实习/校招/早期职业 _ 杭州",
    "数据分析实习生 _ 杭州"
  ]);
  assert.equal(payload.job_full_labels[0], "算法工程师 23-27届实习/校招/早期职业 _ 杭州 25-50K");
  assert.equal(payload.selected_job.name, "算法工程师 23-27届实习/校招/早期职业 _ 杭州");
  assert.equal(payload.source, "test-reader");
  assert.equal(payload.method_summary["DOM.getDocument"], 1);
  assert.equal(observedContext.normalized.port, 9222);
  assert.equal(observedContext.normalized.slowLive, true);
  assert.equal(connector.closeCount, 1);
}

async function testRecommendDefaultsUseScreeningConfig() {
  let connectOptions = null;
  installFakeConnector({
    onConnect(options) {
      connectOptions = options;
    }
  });
  setRecommendMcpJobReaderForTests(async () => ({
    source: "test-reader",
    selector: ".job-item",
    selected_job: null,
    job_options: []
  }));

  const payload = await callTool(TOOL_LIST_JOBS, {}, 120);
  assert.equal(payload.status, "OK");
  assert.equal(connectOptions.port, 9333);
  assert.equal(payload.chrome.port, 9333);
}

async function testRecommendGateBeforeBrowserConnect() {
  let connectorCalled = false;
  setRecommendMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("should not connect before confirmation gate");
  });
  const payload = await callTool(TOOL_START, {
    instruction: "推荐页帮我筛候选人"
  }, 2);
  assert.equal(["NEED_INPUT", "NEED_CONFIRMATION"].includes(payload.status), true);
  assert.equal(connectorCalled, false);
}

async function testRecommendPrepareGateBeforeBrowserConnect() {
  let connectorCalled = false;
  setRecommendMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("prepare should not connect before confirmation gate");
  });
  const payload = await callTool(TOOL_PREPARE, {
    instruction: "推荐页帮我筛候选人"
  }, 3);
  assert.equal(["NEED_INPUT", "NEED_CONFIRMATION"].includes(payload.status), true);
  assert.equal(payload.cron_ready, false);
  assert.equal(connectorCalled, false);
}

async function testRecommendPrepareReadyDoesNotStartRun() {
  let connectorCalled = false;
  setRecommendMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("prepare should not start or connect");
  });
  const payload = await callTool(TOOL_PREPARE, readyArgs({
    human_behavior: {
      restLevel: "medium"
    }
  }), 4);
  assert.equal(payload.status, "READY");
  assert.equal(payload.cron_ready, true);
  assert.equal(payload.post_action.requested, "none");
  assert.equal(payload.review.current_screen_params.criteria, readyArgs().overrides.criteria);
  assert.equal(connectorCalled, false);
}

async function testRecommendPreparedCronPayloadStartsAccepted() {
  installFakeConnector();
  let observedOptions = null;
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recommend:cron-ready");
    runControl.updateProgress({
      target_count: options.maxCandidates,
      processed: 1,
      screened: 1,
      passed: 0
    });
    return {
      domain: "recommend",
      processed: 1,
      screened: 1,
      detail_opened: 1,
      passed: 0,
      results: []
    };
  });

  const args = readyArgs({
    delay_ms: 0,
    human_behavior: {
      restLevel: "high"
    }
  });
  const prepared = await callTool(TOOL_PREPARE, args, 5);
  assert.equal(prepared.status, "READY");
  assert.equal(prepared.cron_ready, true);
  const started = await callTool(TOOL_START, args, 6);
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.run.context.confirmation.final_confirmed, true);
  assert.equal(started.run.context.confirmation.job_confirmed, true);
  await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(observedOptions.humanBehavior.restLevel, "high");
}

async function testRecommendJobListLoginRequiredBlocksCronSetup() {
  setRecommendMcpConnectorForTests(async () => {
    const error = new Error("Boss login is required");
    error.code = "BOSS_LOGIN_REQUIRED";
    error.requires_login = true;
    error.login_url = "https://www.zhipin.com/web/user/?ka=bticket";
    error.current_url = "https://www.zhipin.com/web/user/?ka=bticket";
    error.target_url = "https://www.zhipin.com/web/chat/recommend";
    error.chrome = {
      launched: true,
      port: 9222
    };
    throw error;
  });
  const payload = await callTool(TOOL_LIST_JOBS, {
    port: 9222,
    slow_live: true
  }, 7);
  assert.equal(payload.status, "FAILED");
  assert.equal(payload.error.code, "BOSS_LOGIN_REQUIRED");
  assert.equal(payload.error.requires_login, true);
  assert.equal(payload.chrome.auto_launch.launched, true);
}

async function testRecommendPreparePreservesCriteriaVerbatim() {
  const criteria = "必须同时满足：1）学历门槛：简历可见的任一学历来自双一流建设高校；2）英语可以作为工作语言。";
  const args = readyArgs({
    instruction: criteria,
    overrides: {
      ...readyArgs().overrides,
      criteria
    }
  });
  const prepared = await callTool(TOOL_PREPARE, args, 15);
  assert.equal(prepared.status, "READY");
  assert.equal(prepared.cron_ready, true);
  assert.equal(prepared.review.current_screen_params.criteria, criteria);
  assert.equal(prepared.review.extracted_screen_params.criteria, criteria);
}

async function observeRecommendWorkflowOptions(args, id) {
  installFakeConnector();
  let observedOptions = null;
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recommend:test-options");
    runControl.updateProgress({
      card_count: options.maxCandidates,
      target_count: options.maxCandidates,
      processed: 1,
      screened: 1,
      detail_opened: Math.min(1, options.detailLimit)
    });
    return {
      domain: "recommend",
      processed: 1,
      screened: 1,
      detail_opened: Math.min(1, options.detailLimit),
      passed: 0,
      results: []
    };
  });

  const started = await callTool(TOOL_START, args, id);
  assert.equal(started.status, "ACCEPTED");
  await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(Boolean(observedOptions), true);
  return observedOptions;
}

async function testRecommendDetailLimitDefaultsToTargetCount() {
  const observedOptions = await observeRecommendWorkflowOptions(readyArgs(), 12);
  assert.equal(observedOptions.maxCandidates, 3);
  assert.equal(observedOptions.detailLimit, 3);
  assert.equal(observedOptions.maxImagePages, DEFAULT_MAX_IMAGE_PAGES);
}

async function testRecommendDetailLimitZeroRequiresDebugFlag() {
  const blocked = await callTool(TOOL_START, readyArgs({
    detail_limit: 0
  }), 13);
  assert.equal(blocked.status, "FAILED");
  assert.equal(blocked.error.code, "DEBUG_TEST_MODE_REQUIRED");

  resetRecommendMcpStateForTests();
  const observedOptions = await observeRecommendWorkflowOptions(readyArgs({
    detail_limit: 0,
    debug_test_mode: true,
    allow_card_only_screening: true
  }), 14);
  assert.equal(observedOptions.detailLimit, 0);
}

async function testRecommendLoadsLlmConfigByDefault() {
  const observedOptions = await observeRecommendWorkflowOptions(readyArgs({ delay_ms: 0 }), 15);
  assert.equal(observedOptions.screeningMode, "llm");
  assert.equal(observedOptions.llmConfig.apiKey, "sk-test-key");
  assert.equal(observedOptions.llmConfig.baseUrl, "https://api.example.com/v1");
  assert.equal(observedOptions.llmConfig.model, "gpt-4.1-mini");
  assert.equal(observedOptions.llmConfig.llmThinkingLevel, "low");
  assert.equal(observedOptions.llmConfig.llmMaxTokens, 384);
  assert.equal(observedOptions.llmConfig.llmMaxRetries, 2);
  assert.equal(observedOptions.llmConfig.llmTimeoutMs, 70000);
  assert.equal(observedOptions.llmConfig.llmImageLimit, 6);
  assert.equal(observedOptions.llmConfig.llmImageDetail, "high");
  assert.equal(observedOptions.llmConfig.openaiOrganization, "org-test");
  assert.equal(observedOptions.llmConfig.openaiProject, "proj-test");
  assert.equal(observedOptions.llmConfig.temperature, 0);
  assert.equal(observedOptions.llmConfig.topP, 0.2);
  assert.equal(observedOptions.llmConfig.outputDir, outputDirForTests());
  assert.equal(observedOptions.llmConfig.humanRestEnabled, true);
  assert.equal(observedOptions.humanRestEnabled, true);
  assert.equal(observedOptions.humanBehavior.profile, "paced_with_rests");
  assert.equal(observedOptions.humanBehavior.textEntry, true);
  assert.equal(observedOptions.humanBehavior.listScrollJitter, true);
  assert.equal(observedOptions.humanBehavior.restLevel, "medium");
  assert.equal(observedOptions.llmConfig.llmModels.length, 2);
  assert.equal(observedOptions.llmConfig.llmModels[1].model, "gpt-4.1-nano");
  assert.equal(observedOptions.llmConfig.llmModels[1].apiKey, "sk-backup-key");
}

async function testRecommendHumanBehaviorArgsOverrideConfig() {
  const observedOptions = await observeRecommendWorkflowOptions(readyArgs({
    delay_ms: 0,
    human_behavior_profile: "paced",
    batch_rest_enabled: false
  }), 16);
  assert.equal(observedOptions.humanBehavior.profile, "paced");
  assert.equal(observedOptions.humanBehavior.enabled, true);
  assert.equal(observedOptions.humanBehavior.listScrollJitter, true);
  assert.equal(observedOptions.humanBehavior.restLevel, "medium");
  assert.equal(observedOptions.humanBehavior.restEnabled, false);
  assert.equal(observedOptions.humanRestEnabled, false);
}

function outputDirForTests() {
  return process.env.TEST_BOSS_OUTPUT_DIR;
}

async function testRecommendAsyncPauseResumeCancel() {
  const connector = installFakeConnector();
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    for (let index = 0; index < 4; index += 1) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("recommend:test");
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
      domain: "recommend",
      processed: 4,
      screened: 4,
      detail_opened: 0,
      passed: 3,
      results: []
    };
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 120 }), 3);
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.runtime_evaluate_used, false);
  assert.equal(started.method_summary["DOM.getDocument"], 1);
  assert.equal(started.run.context.overrides.job, "算法工程师");
  assert.equal(started.run.context.max_candidates, 3);
  const runId = started.run_id;

  await waitForRecommendRun(runId, (run) => run?.progress?.processed >= 1);
  const pausePayload = await callTool(TOOL_PAUSE, { run_id: runId }, 4);
  assert.equal(pausePayload.status, "PAUSE_REQUESTED");

  const paused = await waitForRecommendRun(runId, (run) => run?.status === "paused");
  assert.equal(paused.canResume, true);
  assert.equal(fs.existsSync(paused.artifacts.run_state_path), true);

  const resumePayload = await callTool(TOOL_RESUME, { run_id: runId }, 5);
  assert.equal(resumePayload.status, "RESUME_REQUESTED");

  const resumed = await waitForRecommendRun(runId, (run) => run?.progress?.processed > paused.progress.processed);
  assert.equal(resumed.status, "running");

  const cancelPayload = await callTool(TOOL_CANCEL, { run_id: runId }, 6);
  assert.equal(cancelPayload.status, "CANCEL_REQUESTED");

  const canceled = await waitForRecommendRun(runId, (run) => run?.status === "canceled");
  assert.equal(canceled.result.completion_reason, "canceled_by_user");
  assert.equal(canceled.result.processed_count >= resumed.progress.processed, true);

  resetRecommendMcpStateForTests();
  const diskPayload = await callTool(TOOL_GET, { run_id: runId }, 7);
  assert.equal(diskPayload.status, "RUN_STATUS");
  assert.equal(diskPayload.run.state, "canceled");
  assert.equal(diskPayload.persistence.source, "disk");
  assert.equal(diskPayload.persistence.active_control_available, false);
  assert.equal(connector.closeCount >= 1, true);
}

async function testRecommendActiveRunPersistsProgressToDisk() {
  installFakeConnector();
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    runControl.setPhase("recommend:test-active-persist");
    runControl.updateProgress({
      card_count: 2,
      target_count: options.maxCandidates,
      processed: 1,
      screened: 1,
      passed: 0
    });
    runControl.checkpoint({
      results: [
        {
          index: 0,
          candidate: { identity: { name: "候选人A" } },
          screening: { passed: false, status: "screened", score: 0 }
        }
      ]
    });
    await runControl.sleep(300);
    return {
      domain: "recommend",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      passed: 0,
      results: []
    };
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 0 }), 31);
  assert.equal(started.status, "ACCEPTED");
  const statePath = started.run.artifacts.run_state_path;
  const checkpointPath = started.run.artifacts.checkpoint_path;
  const diskState = await waitUntil(() => {
    if (!fs.existsSync(statePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return parsed.progress?.processed >= 1 && parsed.state === "running" ? parsed : null;
  });
  assert.equal(diskState.progress.processed, 1);
  assert.equal(diskState.stage, "recommend:test-active-persist");

  const checkpoint = await waitUntil(() => {
    if (!fs.existsSync(checkpointPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    return Array.isArray(parsed.results) && parsed.results.length === 1 ? parsed : null;
  });
  assert.equal(checkpoint.results[0].candidate.identity.name, "候选人A");

  const completed = await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(completed.progress.processed, 1);
}

async function testRecommendDiskRunningRunWithDeadPidIsReconciled() {
  resetRecommendMcpStateForTests();
  const runId = "mcp_recommend_deadpid_test";
  const runsDir = path.join(process.env.BOSS_RECOMMEND_HOME, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const statePath = path.join(runsDir, `${runId}.json`);
  const checkpointPath = path.join(runsDir, `${runId}.checkpoint.json`);
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const checkpoint = {
    updatedAt: startedAt,
    results: [
      {
        index: 0,
        candidate: { identity: { name: "候选人Z" } },
        screening: { passed: true, status: "pass", score: 92 }
      }
    ]
  };
  fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  fs.writeFileSync(statePath, `${JSON.stringify({
    run_id: runId,
    state: "running",
    status: "running",
    stage: "recommend:detail",
    started_at: startedAt,
    updated_at: startedAt,
    heartbeat_at: startedAt,
    pid: 987654321,
    progress: {
      target_count: 3,
      processed: 1,
      screened: 1,
      passed: 1,
      skipped: 0,
      greet_count: 1
    },
    context: {
      instruction: "推荐页筛选算法候选人",
      confirmation: { job_value: "算法工程师" },
      overrides: {
        job: "算法工程师",
        criteria: "候选人具备算法经验",
        target_count: 3,
        post_action: "greet",
        max_greet_count: 3
      }
    },
    resume: {
      checkpoint_path: checkpointPath
    },
    result: null,
    error: null
  }, null, 2)}\n`, "utf8");

  const payload = await callTool(TOOL_GET, { run_id: runId }, 32);
  assert.equal(payload.status, "RUN_STATUS");
  assert.equal(payload.run.state, "failed");
  assert.equal(payload.run.pid, 987654321);
  assert.equal(payload.run.error.code, "RUN_PROCESS_EXITED");
  assert.equal(payload.persistence.source, "disk");
  assert.equal(payload.persistence.active_control_available, false);
  assert.equal(payload.persistence.stale_process_reconciled, true);
  assert.equal(payload.run.result.status, "FAILED");
  assert.equal(payload.run.result.processed_count, 1);
  assert.equal(payload.run.result.passed_count, 1);
  assert.equal(fs.existsSync(payload.run.result.output_csv), true);
  assert.equal(fs.existsSync(payload.run.result.report_json), true);
}

async function testRecommendDetachedStartUsesWorkerProcess() {
  const previousDetached = process.env.BOSS_RECOMMEND_CDP_DETACHED;
  const previousInproc = process.env.BOSS_RECOMMEND_CDP_INPROC;
  process.env.BOSS_RECOMMEND_CDP_INPROC = "0";
  process.env.BOSS_RECOMMEND_CDP_DETACHED = "1";
  let spawnCall = null;
  let unrefCalled = false;
  let connectOptions = null;
  let workflowOptions = null;
  setSpawnProcessImplForTests((command, args, options) => {
    spawnCall = { command, args, options };
    return {
      pid: 456789,
      unref() {
        unrefCalled = true;
      }
    };
  });
  try {
    installFakeConnector({
      onConnect(options) {
        connectOptions = options;
      }
    });
    setRecommendMcpWorkflowForTests(async (options, runControl) => {
      workflowOptions = options;
      runControl.setPhase("recommend:detached-test");
      runControl.updateProgress({
        card_count: 1,
        target_count: options.maxCandidates,
        processed: 1,
        screened: 1,
        passed: 1,
        greet_count: 0
      });
      return {
        domain: "recommend",
        processed: 1,
        screened: 1,
        detail_opened: 0,
        passed: 1,
        results: []
      };
    });

    const startArgs = readyArgs({
      host: "127.0.0.1",
      port: 9777,
      slow_live: true,
      delay_ms: 0,
      debug_test_mode: true,
      screening_mode: "deterministic",
      no_filter: true,
      detail_limit: 1,
      list_settle_ms: 3456,
      execute_post_action: false
    });
    const started = await callTool(TOOL_START, startArgs, 33);
    assert.equal(started.status, "ACCEPTED");
    assert.equal(started.run.pid, 456789);
    assert.equal(started.run.state, "queued");
    assert.ok(started.run.resume.worker_stdout_path.endsWith(`${started.run_id}.worker.stdout.log`));
    assert.ok(started.run.resume.worker_stderr_path.endsWith(`${started.run_id}.worker.stderr.log`));
    assert.equal(fs.existsSync(started.run.resume.worker_stdout_path), true);
    assert.equal(fs.existsSync(started.run.resume.worker_stderr_path), true);
    assert.equal(unrefCalled, true);
    assert.equal(spawnCall.args.includes("--detached-worker"), true);
    assert.equal(spawnCall.args.includes(started.run_id), true);
    assert.equal(spawnCall.options.detached, true);
    assert.equal(spawnCall.options.stdio[0], "ignore");

    const workerResult = await runDetachedWorkerForTests({
      runId: started.run_id,
      workerPid: 456789
    });
    assert.equal(workerResult.ok, true);
    assert.equal(connectOptions.port, 9777);
    assert.equal(connectOptions.slowLive, true);
    assert.equal(workflowOptions.screeningMode, "deterministic");
    assert.equal(workflowOptions.detailLimit, 1);
    assert.equal(workflowOptions.listSettleMs, 3456);
    assert.equal(workflowOptions.executePostAction, false);
    const completed = await callTool(TOOL_GET, { run_id: started.run_id }, 34);
    assert.equal(completed.run.state, "completed");
    assert.equal(completed.run.pid, process.pid);
    assert.equal(completed.run.progress.processed, 1);
  } finally {
    setSpawnProcessImplForTests(null);
    if (previousDetached === undefined) {
      delete process.env.BOSS_RECOMMEND_CDP_DETACHED;
    } else {
      process.env.BOSS_RECOMMEND_CDP_DETACHED = previousDetached;
    }
    if (previousInproc === undefined) {
      delete process.env.BOSS_RECOMMEND_CDP_INPROC;
    } else {
      process.env.BOSS_RECOMMEND_CDP_INPROC = previousInproc;
    }
  }
}

async function testRecommendOpenClawWorkspaceForcesDetachedWorker() {
  const previousDetached = process.env.BOSS_RECOMMEND_CDP_DETACHED;
  const previousInproc = process.env.BOSS_RECOMMEND_CDP_INPROC;
  const previousWorkspaceRoot = process.env.BOSS_WORKSPACE_ROOT;
  process.env.BOSS_RECOMMEND_CDP_INPROC = "0";
  delete process.env.BOSS_RECOMMEND_CDP_DETACHED;
  process.env.BOSS_WORKSPACE_ROOT = "/tmp/.openclaw/workspace";
  let spawnCall = null;
  let unrefCalled = false;
  setSpawnProcessImplForTests((command, args, options) => {
    spawnCall = { command, args, options };
    return {
      pid: 567890,
      unref() {
        unrefCalled = true;
      }
    };
  });
  try {
    const startArgs = readyArgs({
      delay_ms: 0,
      debug_test_mode: true,
      screening_mode: "deterministic",
      no_filter: true,
      detail_limit: 1,
      execute_post_action: false
    });
    const prepared = await callTool(TOOL_PREPARE, startArgs, 35);
    assert.equal(prepared.status, "READY");
    assert.equal(prepared.cron_ready, true);
    const started = await callTool(TOOL_START, startArgs, 36);
    assert.equal(started.status, "ACCEPTED");
    assert.equal(started.run.pid, 567890);
    assert.equal(started.run.state, "queued");
    assert.equal(unrefCalled, true);
    assert.equal(spawnCall.args.includes("--detached-worker"), true);
    assert.equal(spawnCall.args.includes(started.run_id), true);
    assert.equal(spawnCall.options.detached, true);
  } finally {
    setSpawnProcessImplForTests(null);
    if (previousDetached === undefined) {
      delete process.env.BOSS_RECOMMEND_CDP_DETACHED;
    } else {
      process.env.BOSS_RECOMMEND_CDP_DETACHED = previousDetached;
    }
    if (previousInproc === undefined) {
      delete process.env.BOSS_RECOMMEND_CDP_INPROC;
    } else {
      process.env.BOSS_RECOMMEND_CDP_INPROC = previousInproc;
    }
    if (previousWorkspaceRoot === undefined) {
      delete process.env.BOSS_WORKSPACE_ROOT;
    } else {
      process.env.BOSS_WORKSPACE_ROOT = previousWorkspaceRoot;
    }
  }
}

async function testRecommendFailedRunIncludesConstrainedRecoveryGuidance() {
  installFakeConnector();
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    runControl.setPhase("recommend:detail");
    runControl.updateProgress({
      card_count: 2,
      target_count: options.maxCandidates,
      processed: 1,
      screened: 1,
      passed: 0
    });
    runControl.checkpoint({
      results: [
        {
          index: 0,
          candidate_key: "recommend:id:test-stale",
          candidate: { identity: { name: "候选人A" } },
          screening: { passed: false, status: "fail", score: 0 }
        }
      ]
    });
    throw new Error("Could not find node with given id");
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 0 }), 32);
  assert.equal(started.status, "ACCEPTED");
  const failed = await waitForRecommendRun(started.run_id, (run) => run?.status === "failed");
  assert.equal(failed.recovery.classification, "transient_stale_dom");
  assert.equal(failed.recovery.recommended_action, "restart_same_recommend_request_only");
  assert.equal(failed.recovery.safe_for_outer_ai_agent, true);
  assert.equal(failed.recovery.same_request_sources.instruction, "run.context.instruction");
  assert.equal(failed.recovery.constraints.some((item) => item.includes("Do not switch")), true);
  assert.equal(failed.result.recovery.classification, "transient_stale_dom");
  const report = JSON.parse(fs.readFileSync(failed.result.report_json, "utf8"));
  assert.equal(report.recovery.classification, "transient_stale_dom");
  assert.equal(report.recovery.package_requirement, "@reconcrap/boss-recommend-mcp@>=2.0.30");
}

async function testRecommendMultiSelectFilterMapping() {
  installFakeConnector();
  let observedFilter = null;
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    observedFilter = options.filter;
    runControl.setPhase("recommend:test-filter");
    runControl.updateProgress({ processed: 1, screened: 1, passed: 1 });
    return {
      domain: "recommend",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      passed: 1,
      results: []
    };
  });

  const started = await callTool(TOOL_START, readyArgs({
    no_filter: false,
    confirmation: {
      ...readyArgs().confirmation,
      degree_value: ["本科", "硕士", "博士"],
      recent_not_view_value: "近14天没有"
    },
    overrides: {
      ...readyArgs().overrides,
      degree: ["本科", "硕士", "博士"],
      recent_not_view: "近14天没有"
    }
  }), 8);
  assert.equal(started.status, "ACCEPTED");
  await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.deepEqual(observedFilter.filterGroups, [
    { group: "recentNotView", labels: ["近14天没有"], selectAllLabels: true },
    { group: "degree", labels: ["本科", "硕士", "博士"], selectAllLabels: true }
  ]);
}

async function testRecommendPostActionWiresIntoRunService() {
  installFakeConnector();
  let observedOptions = null;
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recommend:test-post-action");
    runControl.updateProgress({
      processed: 1,
      screened: 1,
      passed: 1,
      greet_count: 0,
      post_action_clicked: 0
    });
    return {
      domain: "recommend",
      processed: 1,
      screened: 1,
      detail_opened: 1,
      passed: 1,
      greet_count: 0,
      post_action_clicked: 0,
      results: []
    };
  });

  const base = readyArgs();
  const started = await callTool(TOOL_START, readyArgs({
    debug_test_mode: true,
    dry_run_post_action: true,
    confirmation: {
      ...base.confirmation,
      post_action_value: "greet",
      max_greet_count_confirmed: true,
      max_greet_count_value: 2
    },
    overrides: {
      ...base.overrides,
      post_action: "greet",
      max_greet_count: 2
    }
  }), 9);
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.post_action.requested, "greet");
  assert.equal(started.post_action.execute_post_action, false);
  assert.equal(started.post_action.max_greet_count, 2);

  const completed = await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(completed.context.post_action, "greet");
  assert.equal(completed.context.max_greet_count, 2);
  assert.equal(completed.context.execute_post_action, false);
  assert.equal(observedOptions.postAction, "greet");
  assert.equal(observedOptions.maxGreetCount, 2);
  assert.equal(observedOptions.executePostAction, false);
}

async function testRecommendPageScopeWiresIntoRunService() {
  installFakeConnector();
  let observedOptions = null;
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recommend:test-page-scope");
    runControl.updateProgress({
      processed: 1,
      screened: 1,
      passed: 1
    });
    return {
      domain: "recommend",
      page_scope: {
        requested_scope: options.pageScope,
        effective_scope: options.pageScope,
        fallback_applied: false,
        selected: true
      },
      processed: 1,
      screened: 1,
      detail_opened: 0,
      passed: 1,
      results: []
    };
  });

  const base = readyArgs();
  const started = await callTool(TOOL_START, readyArgs({
    confirmation: {
      ...base.confirmation,
      page_value: "featured"
    },
    overrides: {
      ...base.overrides,
      page_scope: "featured"
    }
  }), 10);
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.run.context.requested_page_scope, "featured");

  const completed = await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(observedOptions.jobLabel, "算法工程师");
  assert.equal(observedOptions.pageScope, "featured");
  assert.equal(observedOptions.fallbackPageScope, "recommend");
  assert.equal(completed.result.selected_page_scope.effective_scope, "featured");
}

async function testRecommendFollowUpChatRemainsFenced() {
  let connectorCalled = false;
  setRecommendMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("should not connect for fenced follow_up.chat");
  });

  const payload = await callTool(TOOL_START, readyArgs({
    follow_up: {
      chat: {
        criteria: "继续筛选",
        start_from: "unread",
        target_count: 1
      }
    }
  }), 11);
  assert.equal(payload.status, "FAILED");
  assert.equal(payload.error.code, "FOLLOW_UP_CHAT_NOT_CDP_REWRITTEN");
  assert.equal(connectorCalled, false);
}

async function testRecommendArtifactsUseConfiguredOutputDir(outputDir) {
  installFakeConnector();
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    runControl.setPhase("recommend:test-output-dir");
    runControl.updateProgress({
      target_count: options.maxCandidates,
      processed: 1,
      screened: 1,
      passed: 0
    });
    return {
      domain: "recommend",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      passed: 0,
      results: []
    };
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 0 }), 121);
  assert.equal(started.status, "ACCEPTED");
  const completed = await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(path.dirname(completed.result.output_csv), outputDir);
  assert.equal(path.dirname(completed.result.report_json), outputDir);
  assert.equal(fs.existsSync(completed.result.output_csv), true);
  assert.equal(fs.existsSync(completed.result.report_json), true);
}

async function main() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const previousScreenConfig = process.env.BOSS_RECOMMEND_SCREEN_CONFIG;
  const previousOutputDir = process.env.TEST_BOSS_OUTPUT_DIR;
  const previousInproc = process.env.BOSS_RECOMMEND_CDP_INPROC;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-mcp-test-"));
  const outputDir = path.join(tempHome, "configured-output");
  const configPath = path.join(tempHome, "screening-config.json");
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  process.env.TEST_BOSS_OUTPUT_DIR = outputDir;
  process.env.BOSS_RECOMMEND_CDP_INPROC = "1";
  fs.writeFileSync(configPath, JSON.stringify({
    llmModels: [
      {
        name: "primary",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test-key",
        model: "gpt-4.1-mini"
      },
      {
        name: "backup",
        baseUrl: "https://backup.example.com/v1",
        apiKey: "sk-backup-key",
        model: "gpt-4.1-nano"
      }
    ],
    debugPort: 9333,
    outputDir,
    llmThinkingLevel: "low",
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
      restLevel: "medium"
    }
  }, null, 2));
  process.env.BOSS_RECOMMEND_SCREEN_CONFIG = configPath;
  try {
    await testToolListIncludesRecommendTools();
    resetRecommendMcpStateForTests();
    await testRecommendJobListTool();
    resetRecommendMcpStateForTests();
    await testRecommendDefaultsUseScreeningConfig();
    await testRecommendGateBeforeBrowserConnect();
    resetRecommendMcpStateForTests();
    await testRecommendPrepareGateBeforeBrowserConnect();
    resetRecommendMcpStateForTests();
    await testRecommendPrepareReadyDoesNotStartRun();
    resetRecommendMcpStateForTests();
    await testRecommendPreparedCronPayloadStartsAccepted();
    resetRecommendMcpStateForTests();
    await testRecommendJobListLoginRequiredBlocksCronSetup();
    resetRecommendMcpStateForTests();
    await testRecommendPreparePreservesCriteriaVerbatim();
    resetRecommendMcpStateForTests();
    await testRecommendDetailLimitDefaultsToTargetCount();
    resetRecommendMcpStateForTests();
    await testRecommendDetailLimitZeroRequiresDebugFlag();
    resetRecommendMcpStateForTests();
    await testRecommendLoadsLlmConfigByDefault();
    resetRecommendMcpStateForTests();
    await testRecommendHumanBehaviorArgsOverrideConfig();
    resetRecommendMcpStateForTests();
    await testRecommendAsyncPauseResumeCancel();
    resetRecommendMcpStateForTests();
    await testRecommendActiveRunPersistsProgressToDisk();
    resetRecommendMcpStateForTests();
    await testRecommendDiskRunningRunWithDeadPidIsReconciled();
    resetRecommendMcpStateForTests();
    await testRecommendDetachedStartUsesWorkerProcess();
    resetRecommendMcpStateForTests();
    await testRecommendOpenClawWorkspaceForcesDetachedWorker();
    resetRecommendMcpStateForTests();
    await testRecommendFailedRunIncludesConstrainedRecoveryGuidance();
    resetRecommendMcpStateForTests();
    await testRecommendMultiSelectFilterMapping();
    resetRecommendMcpStateForTests();
    await testRecommendPostActionWiresIntoRunService();
    resetRecommendMcpStateForTests();
    await testRecommendPageScopeWiresIntoRunService();
    resetRecommendMcpStateForTests();
    await testRecommendFollowUpChatRemainsFenced();
    resetRecommendMcpStateForTests();
    await testRecommendArtifactsUseConfiguredOutputDir(outputDir);
    console.log("recommend MCP tests passed");
  } finally {
    resetRecommendMcpStateForTests();
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
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
    if (previousInproc === undefined) {
      delete process.env.BOSS_RECOMMEND_CDP_INPROC;
    } else {
      process.env.BOSS_RECOMMEND_CDP_INPROC = previousInproc;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

await main();
