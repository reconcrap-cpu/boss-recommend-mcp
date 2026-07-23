#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables } from "./index.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "./core/cv-acquisition/index.js";

const {
  handleRequest,
  resetRecruitMcpStateForTests,
  setRecruitMcpConnectorForTests,
  setRecruitMcpWorkflowForTests
} = __testables;

const TOOL_RUN = "run_recruit_pipeline";
const TOOL_START = "start_recruit_pipeline_run";
const TOOL_GET = "get_recruit_pipeline_run";
const TOOL_PAUSE = "pause_recruit_pipeline_run";
const TOOL_RESUME = "resume_recruit_pipeline_run";
const TOOL_CANCEL = "cancel_recruit_pipeline_run";

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

async function waitForRecruitRun(runId, predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const payload = await callTool(TOOL_GET, { run_id: runId }, 900);
    if (predicate(payload?.run)) return payload.run;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for recruit run ${runId}`);
}

function readyArgs(extra = {}) {
  return {
    instruction: "搜索关键词算法工程师，目标筛选3位",
    confirmation: {
      final_confirmed: true
    },
    overrides: {
      job: "海外用户增长运营专家（AI产品）",
      keyword: "算法工程师",
      filter_recent_viewed: false,
      target_count: 3,
      criteria: "候选人需有算法工程师相关经历"
    },
    human_behavior: {
      restLevel: "medium"
    },
    reset_search: false,
    ...extra
  };
}

function installFakeConnector({ onConnect = null } = {}) {
  let closeCount = 0;
  setRecruitMcpConnectorForTests(async (options = {}) => {
    if (typeof onConnect === "function") onConnect(options);
    return {
      client: { guarded: true },
      target: {
        id: "fake-recruit-target",
        url: "https://www.zhipin.com/web/chat/search",
        type: "page"
      },
      methodLog: [
        { method: "DOM.getDocument", at: new Date().toISOString() },
        { method: "Input.dispatchMouseEvent", at: new Date().toISOString() }
      ],
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

async function testToolListIncludesRecruitTools() {
  const response = await handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  }, process.cwd());
  const tools = response?.result?.tools || [];
  const names = new Set(tools.map((tool) => tool.name));
  assert.equal(names.has(TOOL_RUN), true);
  assert.equal(names.has(TOOL_START), true);
  assert.equal(names.has(TOOL_GET), true);
  assert.equal(names.has(TOOL_PAUSE), true);
  assert.equal(names.has(TOOL_RESUME), true);
  assert.equal(names.has("cancel_recruit_pipeline_run"), true);
  const startTool = tools.find((tool) => tool.name === TOOL_START);
  assert.equal(startTool.inputSchema.properties.confirmation.properties.final_confirmed.type, "boolean");
  assert.equal(startTool.inputSchema.properties.confirmation.properties.job_value.type, "string");
  assert.equal(startTool.inputSchema.properties.confirmation.properties.criteria_value.type, "string");
  assert.equal(startTool.inputSchema.properties.overrides.properties.job.type, "string");
  assert.ok(startTool.inputSchema.properties.overrides.properties.degrees);
  assert.ok(startTool.inputSchema.properties.overrides.properties.school_tag);
  assert.ok(startTool.inputSchema.properties.overrides.properties.experience);
  assert.ok(startTool.inputSchema.properties.overrides.properties.experience_range);
  assert.ok(startTool.inputSchema.properties.overrides.properties.gender);
  assert.ok(startTool.inputSchema.properties.overrides.properties.age);
  assert.ok(startTool.inputSchema.properties.overrides.properties.age_range);
  assert.ok(startTool.inputSchema.properties.overrides.properties.filter_recent_colleague_contacted);
  assert.ok(startTool.inputSchema.properties.overrides.properties.recent_colleague_contacted);
  assert.ok(startTool.inputSchema.properties.confirmation.properties.filter_recent_colleague_contacted_value);
  assert.deepEqual(startTool.inputSchema.properties.overrides.properties.post_action.enum, ["greet", "none"]);
  assert.deepEqual(startTool.inputSchema.properties.human_behavior.properties.restLevel.enum, ["low", "medium", "high"]);
  assert.deepEqual(startTool.inputSchema.properties.human_behavior.properties.rest_level.enum, ["low", "medium", "high"]);
  const runTool = tools.find((tool) => tool.name === TOOL_RUN);
  assert.deepEqual(runTool.inputSchema.properties.human_behavior.properties.restLevel.enum, ["low", "medium", "high"]);
}

async function testRecruitGateBeforeBrowserConnect() {
  let connectorCalled = false;
  setRecruitMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("should not connect before gate");
  });
  const payload = await callTool(TOOL_RUN, {
    instruction: "帮我找算法候选人"
  }, 2);
  assert.equal(payload.status, "NEED_INPUT");
  assert.equal(connectorCalled, false);
}

async function testRecruitRequiresExplicitCriteria() {
  let connectorCalled = false;
  setRecruitMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("should not connect before criteria gate");
  });
  const payload = await callTool(TOOL_RUN, {
    instruction: [
      "岗位 (job): 海外用户增长运营专家（AI产品） _ 上海",
      "关键词 (keyword): 用户运营，增长运营，国际化",
      "城市 (city): 上海",
      "学历 (degree): 本科及以上",
      "学校类型 (school_tag): 不限",
      "只看未查看 (recent_not_view): 不限",
      "目标筛选人数 (target_count): 20"
    ].join("\n"),
    confirmation: {
      final_confirmed: true
    },
    human_behavior: {
      restLevel: "medium"
    }
  }, 23);
  assert.equal(payload.status, "NEED_INPUT");
  assert.equal(connectorCalled, false);
  assert.equal(payload.missing_fields.includes("criteria"), true);
  assert.equal(payload.screen_params.criteria, null);
  assert.equal(payload.review.criteria_source, "missing");
  assert.equal(payload.pending_questions.some((question) => question.field === "criteria"), true);
}

async function testRecruitAsksSkipRecentColleagueContactedBeforeRun() {
  let connectorCalled = false;
  setRecruitMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("should not connect before skip-contact gate");
  });
  const payload = await callTool(TOOL_RUN, {
    ...readyArgs(),
    confirmation: {
      search_params_confirmed: true,
      criteria_confirmed: true,
      use_default_for_missing: true
    }
  }, 25);
  assert.equal(payload.status, "NEED_CONFIRMATION");
  assert.equal(connectorCalled, false);
  assert.deepEqual(payload.required_confirmations, ["filter_recent_colleague_contacted"]);
  assert.deepEqual(payload.pending_questions.map((question) => question.field), ["filter_recent_colleague_contacted"]);
  assert.equal(payload.pending_questions[0].value, true);
  assert.equal(payload.pending_questions[0].options[0].value, true);
  assert.equal(payload.pending_questions[0].options[1].value, false);
}

async function testRecruitFullUpfrontArgsFinalConfirmStarts() {
  let observedOptions = null;
  installFakeConnector();
  setRecruitMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recruit:test-full-upfront");
    runControl.updateProgress({ processed: 1, screened: 1, passed: 0 });
    return {
      domain: "recruit",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      passed: 0,
      results: []
    };
  });
  const instruction = [
    "岗位 (job): 海外用户增长运营专家（AI产品） _ 上海",
    "关键词 (keyword): 用户运营，增长运营，国际化",
    "城市 (city): 上海",
    "学历 (degree): 本科及以上",
    "学校类型 (school_tag): 不限",
    "经验 (experience): 5-10年",
    "性别 (gender): 女",
    "年龄 (age): 25-35",
    "只看未查看 (recent_not_view): 不限",
    "目标筛选人数 (target_count): 20",
    "休息强度 (rest_level): medium",
    "筛选条件：筛选海外用户增长运营负责人。只依据简历真实可见信息判断；证据不足、业务线无法判断、任期无法判断、学校无法判断时，一律 passed=false。只有同时满足以下全部硬条件才 passed=true：",
    "",
    "1. 学历：若简历只有中国大陆学历，则至少来自强双非 / 顶尖双非、双一流、211、985等院校；若简历出现海外或香港、澳门学历，则passed=true。",
    "2. 经验年限和稳定性：累计至少 3 年软件产品的增长、用户增长、用户运营、产品运营、内容运营、平台运营、海外市场运营、国际化运营或海外运营经验。",
    "3. 产品/行业匹配：硬件、消费电子、IoT、智能设备、机器人、汽车、能源设备等公司不通过。",
    "4. 海外适配能力：满足二选一即可：A 简历可见面向海外用户、海外市场或海外渠道的增长/运营经验；B 若没有海外经验，则必须有强英语能力证据。"
  ].join("\n");
  const payload = await callTool(TOOL_RUN, {
    instruction,
    confirmation: {
      final_confirmed: true
    },
    human_behavior: {
      restLevel: "medium"
    },
    execution_mode: "sync"
  }, 24);
  assert.equal(payload.status, "COMPLETED");
  assert.equal(observedOptions.searchParams.job, "海外用户增长运营专家（AI产品） _ 上海");
  assert.equal(observedOptions.searchParams.keyword, "用户运营，增长运营，国际化");
  assert.equal(observedOptions.searchParams.city, "上海");
  assert.equal(observedOptions.searchParams.degree, "本科");
  assert.deepEqual(observedOptions.searchParams.schools, []);
  assert.deepEqual(observedOptions.searchParams.experience, {
    mode: "option",
    label: "5-10年",
    unlimited: false
  });
  assert.deepEqual(observedOptions.searchParams.gender, {
    label: "女",
    unlimited: false
  });
  assert.deepEqual(observedOptions.searchParams.age, {
    mode: "custom",
    min: 25,
    max: 35,
    label: "25-35"
  });
  assert.equal(observedOptions.searchParams.filter_recent_viewed, false);
  assert.equal(observedOptions.searchParams.skip_recent_colleague_contacted, false);
  assert.equal(observedOptions.maxCandidates, 20);
  assert.match(observedOptions.criteria, /只有同时满足以下全部硬条件/);
  assert.match(observedOptions.criteria, /产品\/行业匹配/);
}

async function testRecruitColleagueContactFilterAliasPassThrough() {
  let observedOptions = null;
  installFakeConnector();
  setRecruitMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recruit:test-colleague-contact-filter");
    runControl.updateProgress({ processed: 1, screened: 1, passed: 0 });
    return {
      domain: "recruit",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      passed: 0,
      results: []
    };
  });
  const baseArgs = readyArgs();
  const payload = await callTool(TOOL_RUN, {
    ...baseArgs,
    overrides: {
      ...baseArgs.overrides,
      filter_recent_colleague_contacted: true
    },
    execution_mode: "sync"
  }, 26);
  assert.equal(payload.status, "COMPLETED");
  assert.equal(observedOptions.searchParams.filter_recent_viewed, false);
  assert.equal(observedOptions.searchParams.skip_recent_colleague_contacted, true);
}

async function testRecruitDefaultsUseScreeningConfig() {
  let connectOptions = null;
  let observedOptions = null;
  installFakeConnector({
    onConnect(options) {
      connectOptions = options;
    }
  });
  setRecruitMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recruit:test-config-port");
    runControl.updateProgress({ processed: 1, screened: 1, passed: 0 });
    return {
      domain: "recruit",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      passed: 0,
      results: []
    };
  });

  const payload = await callTool(TOOL_RUN, {
    ...readyArgs(),
    execution_mode: "sync"
  }, 20);
  assert.equal(payload.status, "COMPLETED");
  assert.equal(connectOptions.port, 9444);
  assert.equal(payload.chrome.port, 9444);
  assert.equal(observedOptions.screeningMode, "llm");
  assert.equal(observedOptions.detailLimit, 3);
  assert.equal(observedOptions.maxImagePages, DEFAULT_MAX_IMAGE_PAGES);
  assert.equal(observedOptions.llmConfig.apiKey, "sk-test-key");
  assert.equal(observedOptions.llmConfig.baseUrl, "https://api.example.com/v1");
  assert.equal(observedOptions.llmConfig.model, "gpt-4.1-mini");
  assert.equal(observedOptions.llmConfig.llmThinkingLevel, "low");
  assert.equal(observedOptions.llmConfig.llmScreeningStrategy, "fast_first_verified");
  assert.equal(observedOptions.llmConfig.llmFastThinkingLevel, "current");
  assert.equal(observedOptions.llmConfig.llmVerifyThinkingLevel, "medium");
  assert.equal(observedOptions.llmConfig.llmFastMaxTokens, 320);
  assert.equal(observedOptions.llmConfig.llmVerifyMaxTokens, 1536);
  assert.equal(observedOptions.llmConfig.llmMaxTokens, 384);
  assert.equal(observedOptions.llmConfig.llmMaxRetries, 2);
  assert.equal(observedOptions.llmConfig.llmTimeoutMs, 70000);
  assert.equal(observedOptions.llmConfig.llmImageLimit, 6);
  assert.equal(observedOptions.llmConfig.llmImageDetail, "high");
  assert.equal(observedOptions.llmConfig.openaiOrganization, "org-test");
  assert.equal(observedOptions.llmConfig.openaiProject, "proj-test");
  assert.equal(observedOptions.llmConfig.temperature, 0);
  assert.equal(observedOptions.llmConfig.topP, 0.2);
  assert.equal(observedOptions.llmConfig.outputDir, process.env.TEST_BOSS_OUTPUT_DIR);
  assert.equal(observedOptions.llmConfig.humanRestEnabled, true);
  assert.equal(observedOptions.searchParams.job, "海外用户增长运营专家（AI产品）");
  assert.deepEqual(observedOptions.searchParams.schools, []);
  assert.equal(observedOptions.postAction, "none");
  assert.equal(observedOptions.humanRestEnabled, true);
  assert.equal(observedOptions.humanBehavior.profile, "paced_with_rests");
  assert.equal(observedOptions.humanBehavior.listScrollJitter, true);
  assert.equal(observedOptions.humanBehavior.restLevel, "medium");
}

async function testRecruitPostActionArgsPassThrough() {
  let observedOptions = null;
  installFakeConnector();
  setRecruitMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recruit:test-post-action");
    runControl.updateProgress({ processed: 1, screened: 1, passed: 1, greet_count: 1 });
    return {
      domain: "recruit",
      processed: 1,
      screened: 1,
      detail_opened: 1,
      passed: 1,
      greet_count: 1,
      post_action_clicked: 1,
      results: []
    };
  });
  const args = readyArgs({
    execution_mode: "sync",
    debug_test_mode: true,
    dry_run_post_action: true
  });
  args.confirmation.post_action_confirmed = true;
  args.confirmation.post_action_value = "greet";
  args.overrides.post_action = "greet";
  args.overrides.max_greet_count = 2;
  const payload = await callTool(TOOL_RUN, args, 22);
  assert.equal(payload.status, "COMPLETED");
  assert.equal(observedOptions.postAction, "greet");
  assert.equal(observedOptions.maxGreetCount, 2);
  assert.equal(observedOptions.executePostAction, false);
  assert.equal(observedOptions.actionTimeoutMs, 8000);
}

async function testRecruitHumanBehaviorArgsOverrideConfig() {
  let observedOptions = null;
  installFakeConnector();
  setRecruitMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recruit:test-human-behavior");
    runControl.updateProgress({ processed: 1, screened: 1, passed: 0 });
    return {
      domain: "recruit",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      passed: 0,
      results: []
    };
  });
  const payload = await callTool(TOOL_RUN, {
    ...readyArgs({
      safe_pacing: true,
      batch_rest_enabled: false
    }),
    execution_mode: "sync"
  }, 21);
  assert.equal(payload.status, "COMPLETED");
  assert.equal(observedOptions.humanBehavior.profile, "paced");
  assert.equal(observedOptions.humanBehavior.enabled, true);
  assert.equal(observedOptions.humanBehavior.restLevel, "medium");
  assert.equal(observedOptions.humanBehavior.restEnabled, false);
  assert.equal(observedOptions.humanRestEnabled, false);
}

async function testRecruitSyncRun() {
  const connector = installFakeConnector();
  setRecruitMcpWorkflowForTests(async (_options, runControl) => {
    runControl.setPhase("recruit:test");
    runControl.updateProgress({ processed: 1, screened: 1, passed: 1 });
    return {
      domain: "recruit",
      processed: 1,
      screened: 1,
      detail_opened: 0,
      passed: 1,
      results: []
    };
  });
  const payload = await callTool(TOOL_RUN, {
    ...readyArgs(),
    execution_mode: "sync"
  }, 3);
  assert.equal(payload.status, "COMPLETED");
  assert.equal(payload.summary.domain, "recruit");
  assert.equal(typeof payload.result.run_id, "string");
  assert.equal(payload.result.processed_count, 1);
  assert.equal(typeof payload.result.output_csv, "string");
  assert.equal(fs.existsSync(payload.result.output_csv), true);
  assert.equal(path.dirname(payload.result.output_csv), process.env.TEST_BOSS_OUTPUT_DIR);
  assert.equal(typeof payload.result.report_json, "string");
  assert.equal(fs.existsSync(payload.result.report_json), true);
  assert.equal(path.dirname(payload.result.report_json), process.env.TEST_BOSS_OUTPUT_DIR);
  assert.equal(typeof payload.result.checkpoint_path, "string");
  assert.equal(fs.existsSync(payload.result.checkpoint_path), true);
  assert.equal(payload.run.result.processed_count, 1);
  assert.equal(payload.run.stage, "recruit:test");
  assert.equal(payload.run.context.instruction.includes("算法工程师"), true);
  assert.equal(fs.existsSync(payload.run.artifacts.run_state_path), true);
  const persisted = JSON.parse(fs.readFileSync(payload.run.artifacts.run_state_path, "utf8"));
  assert.equal(persisted.state, "completed");
  assert.equal(persisted.result.processed_count, 1);
  resetRecruitMcpStateForTests();
  const diskPayload = await callTool(TOOL_GET, { run_id: payload.result.run_id }, 31);
  assert.equal(diskPayload.status, "RUN_STATUS");
  assert.equal(diskPayload.run.state, "completed");
  assert.equal(diskPayload.persistence.source, "disk");
  assert.equal(diskPayload.persistence.active_control_available, false);
  assert.equal(payload.runtime_evaluate_used, false);
  assert.equal(payload.method_summary["DOM.getDocument"], 1);
  assert.equal(connector.closeCount >= 1, true);
}

async function testRecruitAsyncPauseResume() {
  installFakeConnector();
  setRecruitMcpWorkflowForTests(async (_options, runControl) => {
    for (let index = 0; index < 3; index += 1) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("recruit:test");
      runControl.updateProgress({
        processed: index + 1,
        screened: index + 1,
        passed: index
      });
      await runControl.sleep(120);
    }
    return {
      domain: "recruit",
      processed: 3,
      screened: 3,
      detail_opened: 0,
      passed: 2,
      results: []
    };
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 120 }), 4);
  assert.equal(started.status, "ACCEPTED");
  const runId = started.run_id;

  await waitForRecruitRun(runId, (run) => run?.progress?.processed >= 1);
  const pausePayload = await callTool(TOOL_PAUSE, { run_id: runId }, 5);
  assert.equal(pausePayload.status, "PAUSE_REQUESTED");

  const paused = await waitForRecruitRun(runId, (run) => run?.status === "paused");
  assert.equal(paused.canResume, true);
  assert.equal(fs.existsSync(paused.artifacts.run_state_path), true);

  const resumePayload = await callTool(TOOL_RESUME, { run_id: runId }, 6);
  assert.equal(resumePayload.status, "RESUME_REQUESTED");

  const completed = await waitForRecruitRun(runId, (run) => run?.status === "completed");
  assert.equal(completed.summary.domain, "recruit");
  assert.equal(completed.summary.processed, 3);

  const terminalPause = await callTool(TOOL_PAUSE, { run_id: runId }, 7);
  assert.equal(terminalPause.status, "PAUSE_IGNORED");
  const terminalCancel = await callTool(TOOL_CANCEL, { run_id: runId }, 8);
  assert.equal(terminalCancel.status, "CANCEL_IGNORED");
  const terminalResume = await callTool(TOOL_RESUME, { run_id: runId }, 9);
  assert.equal(terminalResume.status, "FAILED");
  assert.equal(terminalResume.error.code, "RUN_ALREADY_TERMINATED");
}

async function testStaleDiskReconciliationPreservesCheckpoint() {
  resetRecruitMcpStateForTests();
  const runId = "mcp_recruit_stale_checkpoint_regression";
  const runsDir = path.join(process.env.BOSS_RECRUIT_HOME, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const checkpointPath = path.join(runsDir, `${runId}.checkpoint.json`);
  const checkpoint = {
    updatedAt: "2026-01-01T00:00:02.000Z",
    results: [
      {
        index: 0,
        candidate_key: "search:test:one",
        candidate: { identity: { name: "checkpoint-preserved" } },
        screening: {
          status: "pass",
          passed: true,
          score: 90,
          reasons: ["checkpoint overwrite regression"]
        }
      }
    ]
  };
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
  fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify({
    run_id: runId,
    mode: "async",
    state: "running",
    status: "running",
    stage: "recruit:screening",
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:02.000Z",
    heartbeat_at: "2026-01-01T00:00:02.000Z",
    completed_at: null,
    pid: 2147483647,
    progress: {
      target_count: 2,
      processed: 1,
      screened: 1,
      passed: 1,
      skipped: 0
    },
    context: {},
    control: { cancel_requested: false },
    resume: { checkpoint_path: checkpointPath },
    error: null,
    result: null,
    summary: null
  }, null, 2));

  const payload = await callTool(TOOL_GET, { run_id: runId }, 41);
  assert.equal(payload.status, "RUN_STATUS");
  assert.equal(payload.persistence.stale_finalized, true);
  assert.equal(payload.run.result.processed_count, 1);
  assert.equal(payload.run.result.passed_count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(checkpointPath, "utf8")), checkpoint);
}

async function testRecruitMonitorStorageFailureDoesNotFailLegacyRun() {
  const previousMonitorHome = process.env.BOSS_MONITOR_HOME;
  const previousMonitorRuntimeHome = process.env.RECRUITING_MONITOR_HOME;
  const invalidMonitorHome = path.join(process.env.BOSS_RECRUIT_HOME, "monitor-home-is-a-file");
  fs.writeFileSync(invalidMonitorHome, "not a directory", "utf8");
  process.env.BOSS_MONITOR_HOME = invalidMonitorHome;
  process.env.RECRUITING_MONITOR_HOME = path.join(
    process.env.BOSS_RECRUIT_HOME,
    "monitor-runtime-unavailable"
  );
  installFakeConnector();
  setRecruitMcpWorkflowForTests(async (options, runControl) => {
    runControl.setPhase("recruit:monitor-storage-unavailable");
    runControl.updateProgress({
      target_count: options.maxCandidates,
      processed: 1,
      screened: 1,
      passed: 0
    });
    return {
      domain: "recruit",
      processed: 1,
      screened: 1,
      passed: 0,
      results: []
    };
  });
  try {
    const started = await callTool(TOOL_START, readyArgs({ delay_ms: 0 }), 42);
    assert.equal(started.status, "ACCEPTED");
    assert.equal(started.monitoring.availability, "monitor_unavailable");
    assert.equal(started.run.monitoring_v1, undefined);
    const completed = await waitForRecruitRun(
      started.run_id,
      (run) => run?.status === "completed"
    );
    assert.equal(completed.status, "completed");
    const persisted = JSON.parse(fs.readFileSync(completed.artifacts.run_state_path, "utf8"));
    assert.equal(persisted.state, "completed");
    assert.equal(persisted.monitoring_v1, undefined);
  } finally {
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

async function main() {
  const previousHome = process.env.BOSS_RECRUIT_HOME;
  const previousScreenConfig = process.env.BOSS_RECOMMEND_SCREEN_CONFIG;
  const previousOutputDir = process.env.TEST_BOSS_OUTPUT_DIR;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recruit-mcp-test-"));
  const outputDir = path.join(tempHome, "configured-output");
  const configPath = path.join(tempHome, "screening-config.json");
  process.env.BOSS_RECRUIT_HOME = tempHome;
  process.env.TEST_BOSS_OUTPUT_DIR = outputDir;
  fs.writeFileSync(configPath, JSON.stringify({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test-key",
    model: "gpt-4.1-mini",
    debugPort: 9444,
    outputDir,
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
      restLevel: "medium"
    }
  }, null, 2));
  process.env.BOSS_RECOMMEND_SCREEN_CONFIG = configPath;
  try {
    await testToolListIncludesRecruitTools();
    await testRecruitGateBeforeBrowserConnect();
    resetRecruitMcpStateForTests();
    await testRecruitRequiresExplicitCriteria();
    resetRecruitMcpStateForTests();
    await testRecruitAsksSkipRecentColleagueContactedBeforeRun();
    resetRecruitMcpStateForTests();
    await testRecruitFullUpfrontArgsFinalConfirmStarts();
    resetRecruitMcpStateForTests();
    await testRecruitColleagueContactFilterAliasPassThrough();
    resetRecruitMcpStateForTests();
    await testRecruitDefaultsUseScreeningConfig();
    resetRecruitMcpStateForTests();
    await testRecruitHumanBehaviorArgsOverrideConfig();
    resetRecruitMcpStateForTests();
    await testRecruitPostActionArgsPassThrough();
    resetRecruitMcpStateForTests();
    await testRecruitSyncRun();
    resetRecruitMcpStateForTests();
    await testRecruitAsyncPauseResume();
    resetRecruitMcpStateForTests();
    await testStaleDiskReconciliationPreservesCheckpoint();
    resetRecruitMcpStateForTests();
    await testRecruitMonitorStorageFailureDoesNotFailLegacyRun();
    console.log("recruit MCP tests passed");
  } finally {
    resetRecruitMcpStateForTests();
    if (previousHome === undefined) {
      delete process.env.BOSS_RECRUIT_HOME;
    } else {
      process.env.BOSS_RECRUIT_HOME = previousHome;
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
