#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables } from "./index.js";

const {
  handleRequest,
  resetRecommendMcpStateForTests,
  setRecommendMcpConnectorForTests,
  setRecommendMcpJobReaderForTests,
  setRecommendMcpWorkflowForTests
} = __testables;

const TOOL_LIST_JOBS = "list_recommend_jobs";
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
    detail_limit: 0,
    delay_ms: 120,
    no_filter: true,
    ...extra
  };
}

function installFakeConnector() {
  let closeCount = 0;
  setRecommendMcpConnectorForTests(async () => ({
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
  }));
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
  const names = new Set((response?.result?.tools || []).map((tool) => tool.name));
  assert.equal(names.has(TOOL_LIST_JOBS), true);
  assert.equal(names.has(TOOL_START), true);
  assert.equal(names.has(TOOL_GET), true);
  assert.equal(names.has(TOOL_PAUSE), true);
  assert.equal(names.has(TOOL_RESUME), true);
  assert.equal(names.has(TOOL_CANCEL), true);
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

async function main() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-mcp-test-"));
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  try {
    await testToolListIncludesRecommendTools();
    resetRecommendMcpStateForTests();
    await testRecommendJobListTool();
    await testRecommendGateBeforeBrowserConnect();
    resetRecommendMcpStateForTests();
    await testRecommendAsyncPauseResumeCancel();
    resetRecommendMcpStateForTests();
    await testRecommendMultiSelectFilterMapping();
    resetRecommendMcpStateForTests();
    await testRecommendPostActionWiresIntoRunService();
    resetRecommendMcpStateForTests();
    await testRecommendPageScopeWiresIntoRunService();
    resetRecommendMcpStateForTests();
    await testRecommendFollowUpChatRemainsFenced();
    console.log("recommend MCP tests passed");
  } finally {
    resetRecommendMcpStateForTests();
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

await main();
