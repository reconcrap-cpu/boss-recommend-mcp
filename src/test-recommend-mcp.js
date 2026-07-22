#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables } from "./index.js";
import { recordDetachedWorkerExit } from "./detached-worker.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "./core/cv-acquisition/index.js";
import { resolveHumanBehaviorForRun } from "./chat-runtime-config.js";
import {
  acceptRecommendEmptyBootstrapHealth,
  compactRecommendRunForStatus,
  getRecommendEmptyBootstrapPreflightAction,
  isRecommendConnectorHealthAccepted,
  resolveRecommendActionJournalScope,
  shouldPreserveRecommendDetailOnTerminal
} from "./recommend-mcp.js";

const {
  createToolsSchema,
  handleRequest,
  isMainModulePath,
  normalizeMcpToolset,
  resetRecommendMcpStateForTests,
  runDetachedWorkerForTests,
  runScheduledRecommendWorkerForTests,
  setRecommendMcpConnectorForTests,
  setRecommendMcpJobReaderForTests,
  setRecommendMcpWorkflowForTests,
  setRecommendSchedulerSpawnForTests,
  setRecommendDetachedWorkerLauncherForTests,
  setSpawnProcessImplForTests
} = __testables;

const TOOL_LIST_JOBS = "list_recommend_jobs";
const TOOL_PREPARE = "prepare_recommend_pipeline_run";
const TOOL_SCHEDULE = "schedule_recommend_pipeline_run";
const TOOL_GET_SCHEDULE = "get_recommend_scheduled_run";
const TOOL_RUN_RECOMMEND = "run_recommend";
const TOOL_START = "start_recommend_pipeline_run";
const TOOL_GET = "get_recommend_pipeline_run";

function testRecommendStatusPreservesWorkflowCompletionSemantics() {
  const compact = compactRecommendRunForStatus({
    status: "failed",
    result: {
      results_count: 4,
      results: [{ candidate_id: "tail-only" }]
    },
    checkpoint: {
      results_count: 4,
      results: [{ candidate_id: "tail-only" }]
    },
    summary: {
      domain: "recommend",
      target_count: 10,
      results_count: 4,
      results: [{ candidate_id: "tail-only" }],
      results_truncated: true,
      completion_reason: "source_unverified_underfill",
      target_reached: false,
      source_exhausted: false,
      source_exhaustion_verified: false,
      source_unverified_underfill: true,
      post_action_stopped: false,
      clean_completion: false,
      refresh_rounds: 9,
      consecutive_refresh_attempts_without_progress: 3,
      candidate_result_journal: {
        journal_file: "candidate-results.test.ndjson",
        raw_record_count: 5,
        committed_count: 4,
        duplicate_count: 1,
        tail_truncated: true
      }
    }
  });

  assert.equal(compact.result.results_count, 4);
  assert.equal(compact.result.results_available, true);
  assert.equal(Object.hasOwn(compact.result, "results"), false);
  assert.equal(compact.checkpoint.results_count, 4);
  assert.equal(compact.summary.results_count, 4);
  assert.equal(compact.summary.target_count, 10);
  assert.equal(compact.summary.completion_reason, "source_unverified_underfill");
  assert.equal(compact.summary.source_unverified_underfill, true);
  assert.equal(compact.summary.source_exhaustion_verified, false);
  assert.equal(compact.summary.clean_completion, false);
  assert.equal(compact.summary.results_truncated, true);
  assert.equal(compact.summary.refresh_rounds, 9);
  assert.equal(compact.summary.consecutive_refresh_attempts_without_progress, 3);
  assert.deepEqual(compact.summary.candidate_result_journal, {
    journal_file: "candidate-results.test.ndjson",
    raw_record_count: 5,
    committed_count: 4,
    superseded_record_count: 1,
    tail_truncated: true
  });
}

function testExplicitHumanRestLevelAliasOverridesConfigDefault() {
  const config = {
    humanBehavior: {
      profile: "paced_with_rests",
      restLevel: "low"
    }
  };
  assert.equal(resolveHumanBehaviorForRun({
    human_behavior: {
      rest_level: "high"
    }
  }, config).restLevel, "high");
  assert.equal(resolveHumanBehaviorForRun({
    human_behavior: {
      restLevel: "medium",
      rest_level: "high"
    }
  }, config).restLevel, "medium");
}

function testRecommendTerminalCleanupPreservesUnpersistedPostActionDetail() {
  assert.equal(shouldPreserveRecommendDetailOnTerminal({
    checkpoint: {
      preserve_detail_on_terminal: true,
      action_result_critical_persisted: false
    }
  }), true);
  assert.equal(shouldPreserveRecommendDetailOnTerminal({
    checkpoint: {
      preserve_detail_on_terminal: true,
      action_result_critical_persisted: true
    }
  }), false);
  assert.equal(shouldPreserveRecommendDetailOnTerminal({ checkpoint: {} }), false);
}

function degradedRecommendHealth(failedRequiredIds = ["candidate_cards"]) {
  return {
    status: "degraded",
    summary: {
      status: "degraded",
      failed_required_ids: failedRequiredIds,
      blocked_required_ids: []
    },
    probes: []
  };
}

function exactRecommendFilteredEmptyState() {
  return {
    verified: true,
    reason: "exact_visible_filtered_empty_state",
    text: "没有相关数据",
    node_id: 42,
    accessibility: {
      verified: true,
      reason: "exact_accessible_text"
    }
  };
}

function successfulRecommendEmptyBootstrapRefresh() {
  return {
    attempted: true,
    completed: true,
    ok: true,
    method: "Page.navigate",
    target_url: "https://www.zhipin.com/web/chat/recommend",
    before: {
      health: degradedRecommendHealth(),
      empty_state: exactRecommendFilteredEmptyState()
    }
  };
}

function testRecommendConnectorRefreshesBeforeExactEmptyBootstrap() {
  const health = degradedRecommendHealth();
  const emptyState = exactRecommendFilteredEmptyState();
  assert.equal(
    getRecommendEmptyBootstrapPreflightAction(health, emptyState),
    "refresh"
  );
  assert.equal(acceptRecommendEmptyBootstrapHealth(health, emptyState), null);
}

function testRecommendConnectorAcceptsHealthyAfterEmptyBootstrapRefresh() {
  const health = {
    status: "healthy",
    summary: {
      status: "healthy",
      failed_required_ids: [],
      blocked_required_ids: []
    }
  };
  assert.equal(
    getRecommendEmptyBootstrapPreflightAction(
      health,
      null,
      successfulRecommendEmptyBootstrapRefresh()
    ),
    "accept_healthy"
  );
  assert.equal(isRecommendConnectorHealthAccepted(health), true);
}

function testRecommendConnectorAcceptsExactEmptyAfterBootstrapRefresh() {
  const health = degradedRecommendHealth();
  const refresh = successfulRecommendEmptyBootstrapRefresh();
  const accepted = acceptRecommendEmptyBootstrapHealth(
    health,
    exactRecommendFilteredEmptyState(),
    refresh
  );
  assert.ok(accepted);
  assert.equal(accepted.status, "degraded");
  assert.equal(accepted.summary, health.summary);
  assert.equal(accepted.accepted_empty_bootstrap.accepted, true);
  assert.equal(accepted.accepted_empty_bootstrap.original_health_status, "degraded");
  assert.deepEqual(accepted.accepted_empty_bootstrap.failed_required_ids, ["candidate_cards"]);
  assert.equal(accepted.accepted_empty_bootstrap.empty_state.accessibility.verified, true);
  assert.equal(accepted.empty_bootstrap_refresh.method, "Page.navigate");
  assert.equal(accepted.empty_bootstrap_refresh.before.health.status, "degraded");
  assert.equal(accepted.empty_bootstrap_refresh.after.health.status, "degraded");
  assert.equal(accepted.empty_bootstrap_refresh.after.empty_state.verified, true);
  assert.equal(isRecommendConnectorHealthAccepted(accepted), true);
}

function testRecommendConnectorRejectsUnverifiedEmptyBootstrap() {
  const health = degradedRecommendHealth();
  const unverified = {
    ...exactRecommendFilteredEmptyState(),
    verified: false,
    reason: "exact_empty_text_not_visible_or_accessible"
  };
  assert.equal(
    getRecommendEmptyBootstrapPreflightAction(
      health,
      unverified,
      successfulRecommendEmptyBootstrapRefresh()
    ),
    "wait"
  );
  assert.equal(
    acceptRecommendEmptyBootstrapHealth(
      health,
      unverified,
      successfulRecommendEmptyBootstrapRefresh()
    ),
    null
  );
  assert.equal(isRecommendConnectorHealthAccepted(health), false);
}

function testRecommendConnectorRejectsAdditionalRequiredFailure() {
  const health = degradedRecommendHealth(["candidate_cards", "filter_trigger"]);
  assert.equal(
    getRecommendEmptyBootstrapPreflightAction(
      health,
      exactRecommendFilteredEmptyState()
    ),
    "wait"
  );
  assert.equal(
    acceptRecommendEmptyBootstrapHealth(
      health,
      exactRecommendFilteredEmptyState(),
      successfulRecommendEmptyBootstrapRefresh()
    ),
    null
  );
  assert.equal(isRecommendConnectorHealthAccepted(health), false);
}

async function testRecommendActionJournalScopeCanonicalizesLoopbackAndBindsProfile() {
  const session = {
    profile_identity: {
      verified: true,
      user_data_dir: process.cwd(),
      profile_directory: "src"
    }
  };
  const localhost = await resolveRecommendActionJournalScope({ host: "localhost", port: 9222, session });
  const ipv4 = await resolveRecommendActionJournalScope({ host: "127.0.0.1", port: 9333, session });
  assert.equal(localhost.scope, ipv4.scope);
  assert.match(localhost.scope, /^boss-recommend-profile-v2:127\.0\.0\.1:profile-sha256:[0-9a-f]{64}$/u);
  assert.equal(Object.prototype.hasOwnProperty.call(localhost.identity, "user_data_dir"), false);
  await assert.rejects(
    () => resolveRecommendActionJournalScope({
      host: "127.0.0.1",
      port: 9222,
      session: {
        profile_identity: {
          verified: true,
          user_data_dir: process.cwd(),
          profile_directory: "missing-profile"
        }
      }
    }),
    (error) => error?.code === "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED"
      || error?.code === "ENOENT"
  );

  await assert.rejects(
    () => resolveRecommendActionJournalScope({
      host: "127.0.0.1",
      port: 9222,
      session,
      strictFresh: true,
      inspectCommandLine: async () => ({
        ok: false,
        source: "process_list",
        arguments: [],
        error: "process inspection unavailable"
      })
    }),
    (error) => error?.code === "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED"
  );

  const freshScope = await resolveRecommendActionJournalScope({
    host: "127.0.0.1",
    port: 9222,
    session: {
      profile_identity: {
        verified: true,
        user_data_dir: process.cwd(),
        profile_directory: "docs"
      }
    },
    strictFresh: true,
    inspectCommandLine: async () => ({
      ok: true,
      source: "process_list",
      arguments: [
        "chrome.exe",
        "--remote-debugging-port=9222",
        `--user-data-dir=${process.cwd()}`,
        "--profile-directory=src"
      ]
    })
  });
  assert.equal(freshScope.scope, localhost.scope);
  assert.equal(freshScope.identity.source, "fresh_process_list");

  const takeoverScope = await resolveRecommendActionJournalScope({
    host: "127.0.0.1",
    port: 9222,
    session,
    strictFresh: true,
    inspectCommandLine: async () => ({
      ok: true,
      source: "process_list",
      arguments: [
        "chrome.exe",
        "--remote-debugging-port=9222",
        `--user-data-dir=${process.cwd()}`,
        "--profile-directory=docs"
      ]
    })
  });
  assert.notEqual(takeoverScope.scope, localhost.scope);

  await assert.rejects(
    () => resolveRecommendActionJournalScope({
      host: "127.0.0.1",
      port: 9222,
      session,
      strictFresh: true,
      inspectCommandLine: async () => ({
        ok: true,
        source: "process_list",
        arguments: [
          "chrome.exe",
          "--remote-debugging-port=9333",
          `--user-data-dir=${process.cwd()}`,
          "--profile-directory=src"
        ]
      })
    }),
    (error) => error?.code === "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED"
  );
}
const TOOL_LIST_RUNS = "list_recommend_pipeline_runs";
const TOOL_PAUSE = "pause_recommend_pipeline_run";
const TOOL_RESUME = "resume_recommend_pipeline_run";
const TOOL_CANCEL = "cancel_recommend_pipeline_run";
const TOOL_CHAT_START = "start_boss_chat_run";
const TOOL_CHAT_LIST_JOBS = "list_boss_chat_jobs";
const TOOL_RECRUIT_START = "start_recruit_pipeline_run";

function testMainModulePathAcceptsWindowsJunction(tempHome) {
  const targetDir = path.join(tempHome, "worker-real");
  const linkDir = path.join(tempHome, "worker-link");
  fs.mkdirSync(targetDir, { recursive: true });
  const targetFile = path.join(targetDir, "index.js");
  fs.writeFileSync(targetFile, "// worker fixture\n", "utf8");
  fs.symlinkSync(targetDir, linkDir, process.platform === "win32" ? "junction" : "dir");
  assert.equal(isMainModulePath(path.join(linkDir, "index.js"), targetFile), true);
  assert.equal(isMainModulePath(path.join(linkDir, "missing.js"), targetFile), false);
}

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

async function testMcpToolsetFilteringKeepsRecommendSmallAndFirst() {
  assert.equal(normalizeMcpToolset("boss-recommend"), "recommend");
  assert.equal(normalizeMcpToolset("chat-only"), "chat");
  assert.equal(normalizeMcpToolset("search-page"), "recruit");
  assert.equal(normalizeMcpToolset("unknown"), "all");

  const recommendTools = createToolsSchema("recommend");
  const recommendNames = recommendTools.map((tool) => tool.name);
  assert.ok(JSON.stringify(recommendTools).length < 15000);
  assert.deepEqual(recommendNames, [
    TOOL_LIST_JOBS,
    TOOL_RUN_RECOMMEND,
    TOOL_START,
    TOOL_PREPARE,
    TOOL_SCHEDULE,
    TOOL_GET_SCHEDULE,
    TOOL_GET,
    TOOL_LIST_RUNS,
    TOOL_CANCEL,
    TOOL_PAUSE,
    TOOL_RESUME
  ]);
  assert.equal(recommendNames.includes(TOOL_CHAT_START), false);
  assert.equal(recommendNames.includes(TOOL_RECRUIT_START), false);
  const compactStartTool = recommendTools.find((tool) => tool.name === TOOL_START);
  assert.equal(compactStartTool.inputSchema.properties.overrides.properties.current_city_only.type, "boolean");
  const compactActivitySchema = compactStartTool.inputSchema.properties.overrides.properties.activity_level;
  assert.equal(compactActivitySchema.type, "string");
  assert.equal(compactActivitySchema.enum, undefined);
  assert.match(compactActivitySchema.description, /最靠近.*用户意图/);
  assert.match(compactActivitySchema.description, /无法理解时默认 不限/);
  for (const field of [
    "debug_force_list_end_after_processed",
    "debug_force_context_recovery_after_processed",
    "debug_force_cdp_reconnect_after_processed"
  ]) {
    assert.equal(compactStartTool.inputSchema.properties[field].type, "integer");
    assert.equal(compactStartTool.inputSchema.properties[field].minimum, 1);
  }
  const fullTools = createToolsSchema("all");
  const fullStartTool = fullTools.find((tool) => tool.name === TOOL_START);
  for (const field of [
    "debug_force_list_end_after_processed",
    "debug_force_context_recovery_after_processed",
    "debug_force_cdp_reconnect_after_processed"
  ]) {
    assert.equal(fullStartTool.inputSchema.properties[field].type, "integer");
    assert.equal(fullStartTool.inputSchema.properties[field].minimum, 1);
  }
  const compactScheduleTool = recommendTools.find((tool) => tool.name === TOOL_SCHEDULE);
  for (const field of [
    "debug_test_mode",
    "debug_force_list_end_after_processed",
    "debug_force_context_recovery_after_processed",
    "debug_force_cdp_reconnect_after_processed"
  ]) {
    assert.equal(compactScheduleTool.inputSchema.properties[field], undefined);
  }
  const fullScheduleTool = fullTools.find((tool) => tool.name === TOOL_SCHEDULE);
  for (const field of [
    "debug_test_mode",
    "debug_force_list_end_after_processed",
    "debug_force_context_recovery_after_processed",
    "debug_force_cdp_reconnect_after_processed"
  ]) {
    assert.equal(fullScheduleTool.inputSchema.properties[field], undefined);
  }
  assert.deepEqual(fullScheduleTool.inputSchema.properties.screening_mode.enum, ["llm"]);
  assert.deepEqual(fullScheduleTool.inputSchema.properties.use_llm.enum, [true]);
  assert.equal(fullScheduleTool.inputSchema.properties.detail_limit.minimum, 1);
  assert.deepEqual(fullScheduleTool.inputSchema.properties.allow_card_only_screening.enum, [false]);
  assert.deepEqual(fullScheduleTool.inputSchema.properties.dry_run_post_action.enum, [false]);
  assert.deepEqual(fullScheduleTool.inputSchema.properties.no_filter.enum, [false]);
  assert.deepEqual(fullScheduleTool.inputSchema.properties.filter_enabled.enum, [true]);
  assert.equal(compactScheduleTool.inputSchema.properties.detail_limit.minimum, 1);
  assert.deepEqual(compactScheduleTool.inputSchema.properties.no_filter.enum, [false]);
  assert.deepEqual(compactScheduleTool.inputSchema.properties.dry_run.enum, [false]);

  const chatNames = createToolsSchema("chat").map((tool) => tool.name);
  assert.deepEqual(chatNames, [
    "boss_chat_health_check",
    TOOL_CHAT_LIST_JOBS,
    "prepare_boss_chat_run",
    TOOL_CHAT_START,
    "get_boss_chat_run",
    "pause_boss_chat_run",
    "resume_boss_chat_run",
    "cancel_boss_chat_run"
  ]);
  assert.equal(chatNames.includes(TOOL_START), false);

  const recruitNames = createToolsSchema("recruit").map((tool) => tool.name);
  assert.deepEqual(recruitNames, [
    "run_recruit_pipeline",
    TOOL_RECRUIT_START,
    "get_recruit_pipeline_run",
    "cancel_recruit_pipeline_run",
    "pause_recruit_pipeline_run",
    "resume_recruit_pipeline_run"
  ]);
  assert.equal(recruitNames.includes(TOOL_START), false);

  const previousToolset = process.env.BOSS_RECOMMEND_MCP_TOOLSET;
  process.env.BOSS_RECOMMEND_MCP_TOOLSET = "chat";
  try {
    const response = await handleRequest({
      jsonrpc: "2.0",
      id: 1001,
      method: "tools/list"
    }, process.cwd());
    assert.deepEqual(response.result.tools.map((tool) => tool.name), chatNames);
    const rejected = await handleRequest(makeToolCall(1002, TOOL_START, readyArgs()), process.cwd());
    assert.equal(rejected.error.code, -32602);
    assert.match(rejected.error.message, /not available in the chat boss-recommend-mcp toolset/);
  } finally {
    if (previousToolset === undefined) {
      delete process.env.BOSS_RECOMMEND_MCP_TOOLSET;
    } else {
      process.env.BOSS_RECOMMEND_MCP_TOOLSET = previousToolset;
    }
  }
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
    human_behavior: {
      restLevel: "medium"
    },
    delay_ms: 120,
    no_filter: false,
    ...extra
  };
}

function makeLargeRecommendResults(count = 20, marker = "large status payload should not appear") {
  return Array.from({ length: count }, (_, index) => ({
    candidate: {
      identity: {
        name: `候选人${index}`,
        marker,
        oversized_text: `${marker} ${index} `.repeat(80)
      }
    },
    detail: {
      llm_screening: true,
      evidence: `${marker} detail ${index} `.repeat(80)
    },
    screening: {
      passed: index % 2 === 0,
      status: index % 2 === 0 ? "pass" : "fail",
      reasons: [marker]
    }
  }));
}

function singleReviewArgs(extra = {}) {
  return {
    instruction: "推荐页运行",
    confirmation: {
      final_confirmed: true
    },
    overrides: {
      page_scope: "recommend",
      school_tag: ["985", "211", "双一流院校", "国内外名校"],
      degree: ["本科", "硕士", "博士"],
      gender: "不限",
      recent_not_view: "不限",
      criteria: "必须同时满足全部条件：1）有算法经验；2）有 AI 项目经历",
      target_count: 200,
      post_action: "greet",
      max_greet_count: 200,
      job: "AI算法实习生 _ 杭州"
    },
    human_behavior: {
      restLevel: "high"
    },
    delay_ms: 0,
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
      profile_identity: {
        verified: true,
        user_data_dir: process.cwd(),
        profile_directory: "src"
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
  assert.equal(names.has(TOOL_SCHEDULE), true);
  assert.equal(names.has(TOOL_GET_SCHEDULE), true);
  assert.equal(names.has(TOOL_RUN_RECOMMEND), true);
  assert.equal(names.has(TOOL_START), true);
  assert.equal(names.has(TOOL_GET), true);
  assert.equal(names.has(TOOL_LIST_RUNS), true);
  assert.equal(names.has(TOOL_PAUSE), true);
  assert.equal(names.has(TOOL_RESUME), true);
  assert.equal(names.has(TOOL_CANCEL), true);
  const toolOrder = tools.map((tool) => tool.name);
  assert.equal(toolOrder.indexOf(TOOL_RUN_RECOMMEND) < toolOrder.indexOf(TOOL_PREPARE), true);
  assert.equal(toolOrder.indexOf(TOOL_START) < toolOrder.indexOf(TOOL_PREPARE), true);
  assert.equal(toolOrder.indexOf(TOOL_RUN_RECOMMEND) < toolOrder.indexOf(TOOL_SCHEDULE), true);
  assert.equal(toolOrder.indexOf(TOOL_START) < toolOrder.indexOf(TOOL_SCHEDULE), true);
  assert.equal(toolOrder.indexOf(TOOL_GET) < toolOrder.indexOf(TOOL_LIST_RUNS), true);
  const startTool = tools.find((tool) => tool.name === TOOL_START);
  const runRecommendTool = tools.find((tool) => tool.name === TOOL_RUN_RECOMMEND);
  assert.equal(runRecommendTool.description.includes("start_recommend_pipeline_run"), true);
  assert.equal(runRecommendTool.description.includes("原生 MCP"), true);
  assert.equal(runRecommendTool.description.includes("terminal/shell/run_command"), true);
  assert.equal(runRecommendTool.description.includes("不需要先调用 prepare_recommend_pipeline_run"), true);
  assert.equal(runRecommendTool.description.includes("不要用 schedule_recommend_pipeline_run 冒充立即启动"), true);
  assert.equal(runRecommendTool.description.includes("CLI fallback"), false);
  assert.equal(runRecommendTool.inputSchema.properties.confirmation.properties.final_confirmed.type, "boolean");
  assert.equal(runRecommendTool.inputSchema.properties.human_behavior.properties.restLevel.enum[1], "medium");
  assert.equal(startTool.description.includes("run_recommend"), true);
  assert.equal(startTool.description.includes("原生 MCP"), true);
  assert.equal(startTool.description.includes("terminal/shell/run_command"), true);
  assert.equal(startTool.description.includes("不需要先调用 prepare_recommend_pipeline_run"), true);
  assert.equal(startTool.description.includes("不要用 schedule_recommend_pipeline_run 冒充立即启动"), true);
  assert.equal(startTool.description.includes("CLI fallback"), false);
  assert.deepEqual(startTool.inputSchema.properties.human_behavior.properties.restLevel.enum, ["low", "medium", "high"]);
  assert.deepEqual(startTool.inputSchema.properties.human_behavior.properties.rest_level.enum, ["low", "medium", "high"]);
  assert.deepEqual(startTool.inputSchema.properties.confirmation.properties.post_action_value.enum, ["greet", "none"]);
  assert.deepEqual(startTool.inputSchema.properties.overrides.properties.post_action.enum, ["greet", "none"]);
  assert.equal(startTool.inputSchema.properties.overrides.properties.current_city_only.type, "boolean");
  const fullActivitySchema = startTool.inputSchema.properties.overrides.properties.activity_level;
  assert.equal(fullActivitySchema.type, "string");
  assert.equal(fullActivitySchema.enum, undefined);
  assert.match(fullActivitySchema.description, /最靠近用户意图/);
  assert.match(fullActivitySchema.description, /无法理解时默认 不限/);
  const prepareTool = tools.find((tool) => tool.name === TOOL_PREPARE);
  assert.equal(prepareTool.description.includes("run_recommend"), true);
  assert.equal(prepareTool.description.includes("start_recommend_pipeline_run"), true);
  assert.equal(prepareTool.description.includes("原生 MCP"), true);
  assert.equal(prepareTool.description.includes("terminal/shell/run_command"), true);
  assert.equal(prepareTool.description.includes("再次调用 prepare"), true);
  assert.equal(prepareTool.description.includes("CLI fallback"), false);
  assert.deepEqual(prepareTool.inputSchema.properties.confirmation.properties.final_confirmed.type, "boolean");
  const listRunsTool = tools.find((tool) => tool.name === TOOL_LIST_RUNS);
  assert.equal(listRunsTool.description.includes("latest_run"), true);
  assert.equal(listRunsTool.description.includes("Get-Content"), true);
  assert.equal(listRunsTool.inputSchema.properties.limit.maximum, 100);
  const scheduleTool = tools.find((tool) => tool.name === TOOL_SCHEDULE);
  assert.equal(scheduleTool.description.includes("只用于用户明确要求稍后/cron/定时启动"), true);
  assert.equal(scheduleTool.description.includes("不要用短延迟 schedule 冒充立即启动"), true);
  assert.equal(scheduleTool.inputSchema.properties.schedule_delay_minutes.type, "number");
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

async function testRecommendToolsRejectChatOnlyMisrouteBeforeBrowserConnect() {
  let connectorCalled = false;
  setRecommendMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("chat-only misroutes must not connect to recommend page");
  });
  const started = await callTool(TOOL_START, {
    instruction: "Chat-only 任务"
  }, 3_1);
  assert.equal(started.status, "FAILED");
  assert.equal(started.route_guard, true);
  assert.equal(started.error.code, "WRONG_BOSS_TOOL_FOR_CHAT");
  assert.equal(started.detected_domain, "chat");
  assert.equal(started.recommended_tool_sequence.includes("boss-chat/prepare_boss_chat_run"), true);

  const prepared = await callTool(TOOL_PREPARE, {
    instruction: "Chat-only 筛选「海外用户增长运营专家（AI产品） _ 上海」岗位的未读候选人"
  }, 3_2);
  assert.equal(prepared.status, "FAILED");
  assert.equal(prepared.cron_ready, false);
  assert.equal(prepared.error.code, "WRONG_BOSS_TOOL_FOR_CHAT");
  assert.equal(connectorCalled, false);
}

async function testRecommendToolsRejectSearchMisrouteBeforeBrowserConnect() {
  let connectorCalled = false;
  setRecommendMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("search misroutes must not connect to recommend page");
  });
  const payload = await callTool(TOOL_START, {
    instruction: "请在 Boss 搜索页筛选算法工程师候选人"
  }, 3_3);
  assert.equal(payload.status, "FAILED");
  assert.equal(payload.route_guard, true);
  assert.equal(payload.error.code, "WRONG_BOSS_TOOL_FOR_SEARCH");
  assert.equal(payload.detected_domain, "search");
  assert.equal(payload.recommended_server, "boss-recruit");
  assert.equal(payload.recommended_tool_sequence.includes("boss-recruit/start_recruit_pipeline_run"), true);
  assert.equal(connectorCalled, false);

  const confirmationScopePayload = await callTool(TOOL_START, {
    instruction: "现在启动筛选任务",
    confirmation: {
      final_confirmed: true,
      page_value: "search",
      job_value: "海外用户增长运营专家（AI产品） _ 上海"
    },
    overrides: {
      criteria: "x",
      target_count: 1,
      post_action: "greet"
    },
    human_behavior: {
      restLevel: "medium"
    }
  }, 3_31);
  assert.equal(confirmationScopePayload.status, "FAILED");
  assert.equal(confirmationScopePayload.error.code, "WRONG_BOSS_TOOL_FOR_SEARCH");
  assert.equal(confirmationScopePayload.detected_signals.includes("confirmation.page_value:search"), true);

  const topLevelScopePayload = await callTool(TOOL_START, {
    instruction: "现在启动筛选任务",
    page_scope: "search",
    confirmation: {
      final_confirmed: true,
      job_value: "海外用户增长运营专家（AI产品） _ 上海"
    },
    overrides: {
      criteria: "x",
      target_count: 1,
      post_action: "greet"
    },
    human_behavior: {
      restLevel: "medium"
    }
  }, 3_32);
  assert.equal(topLevelScopePayload.status, "FAILED");
  assert.equal(topLevelScopePayload.error.code, "WRONG_BOSS_TOOL_FOR_SEARCH");
  assert.equal(topLevelScopePayload.detected_signals.includes("page_scope:search"), true);
  assert.equal(connectorCalled, false);

  const recruitArgPayload = await callTool(TOOL_START, {
    instruction: "岗位：海外用户增长运营专家（AI产品）_ 上海；关键词：用户运营，增长运营，国际化；城市：上海；学历：本科及以上",
    confirmation: {
      final_confirmed: true,
      job_value: "海外用户增长运营专家（AI产品） _ 上海"
    },
    overrides: {
      keyword: "用户运营，增长运营，国际化",
      city: "上海",
      school_tag: "不限",
      criteria: "x",
      target_count: 20,
      post_action: "greet"
    },
    human_behavior: {
      restLevel: "medium"
    }
  }, 3_33);
  assert.equal(recruitArgPayload.status, "FAILED");
  assert.equal(recruitArgPayload.error.code, "WRONG_BOSS_TOOL_FOR_SEARCH");
  assert.equal(recruitArgPayload.detected_signals.includes("overrides.keyword:recruit_arg"), true);
  assert.equal(recruitArgPayload.detected_signals.includes("overrides.city:recruit_arg"), true);
  assert.equal(connectorCalled, false);
}

async function testRecommendJobListRejectsExplicitChatTarget() {
  let connectorCalled = false;
  setRecommendMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("chat target misroutes must not navigate to recommend page");
  });
  const payload = await callTool(TOOL_LIST_JOBS, {
    target_url_includes: "https://www.zhipin.com/web/chat/index"
  }, 3_4);
  assert.equal(payload.status, "FAILED");
  assert.equal(payload.route_guard, true);
  assert.equal(payload.stage, "recommend_job_list");
  assert.equal(payload.error.code, "WRONG_BOSS_TOOL_FOR_CHAT");
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
  assert.equal(payload.prepared_only, true);
  assert.equal(payload.run_started, false);
  assert.equal(payload.recommended_next_tool, TOOL_START);
  assert.equal(payload.alternate_next_tool, TOOL_RUN_RECOMMEND);
  assert.equal(payload.next_action.immediate_run.recommended_next_tool, TOOL_START);
  assert.equal(payload.next_action.immediate_run.alternate_next_tool, TOOL_RUN_RECOMMEND);
  assert.equal(payload.next_action.immediate_run.same_arguments, true);
  assert.equal(payload.next_action.immediate_run.native_mcp_required, true);
  assert.equal(payload.next_action.scheduled_run.recommended_next_tool, TOOL_SCHEDULE);
  assert.equal(payload.next_action.do_not_call_prepare_again, true);
  assert.equal(payload.next_action.do_not_use_cli_fallback_when_mcp_tools_available, true);
  assert.equal(payload.next_action.do_not_use_terminal_or_shell, true);
  assert.equal(payload.next_action.forbidden_fallbacks.includes("run_command"), true);
  assert.equal(payload.agent_guidance.native_mcp_required_after_prepare, true);
  assert.equal(payload.agent_guidance.trae_cn.never_use_terminal_fallback_after_prepare, true);
  assert.equal(payload.agent_guidance.immediate_run.tool, TOOL_START);
  assert.equal(payload.message.includes("did not start a run"), true);
  assert.equal(payload.message.includes("This response proves the MCP server is available"), true);
  assert.equal(payload.message.includes("Do not call prepare_recommend_pipeline_run again"), true);
  assert.equal(payload.post_action.requested, "none");
  assert.equal(payload.review.current_screen_params.criteria, readyArgs().overrides.criteria);
  assert.equal(payload.review.current_search_params.current_city_only, false);
  assert.equal(payload.review.current_search_params.activity_level, "不限");
  assert.equal(payload.review.pending_questions.some((item) => item.field === "current_city_only"), false);
  assert.equal(payload.review.pending_questions.some((item) => item.field === "activity_level"), false);
  assert.equal(connectorCalled, false);
}

async function testRecommendDebugBoundaryInputGate() {
  const missingGate = await handleRequest(makeToolCall(801, TOOL_PREPARE, {
    instruction: "筛选算法候选人",
    debug_force_list_end_after_processed: 10
  }), process.cwd());
  assert.equal(missingGate.error.code, -32602);
  assert.match(missingGate.error.message, /requires debug_test_mode=true/);

  const invalidThreshold = await handleRequest(makeToolCall(802, TOOL_PREPARE, {
    instruction: "筛选算法候选人",
    debug_test_mode: true,
    debug_force_context_recovery_after_processed: 0
  }), process.cwd());
  assert.equal(invalidThreshold.error.code, -32602);
  assert.match(invalidThreshold.error.message, /positive integer/);

  const mutuallyExclusive = await handleRequest(makeToolCall(803, TOOL_PREPARE, {
    instruction: "筛选算法候选人",
    debug_test_mode: true,
    debug_force_list_end_after_processed: 10,
    debug_force_cdp_reconnect_after_processed: 10
  }), process.cwd());
  assert.equal(mutuallyExclusive.error.code, -32602);
  assert.match(mutuallyExclusive.error.message, /mutually exclusive/);

  const valid = await handleRequest(makeToolCall(804, TOOL_PREPARE, {
    instruction: "筛选算法候选人",
    debug_test_mode: true,
    debug_force_cdp_reconnect_after_processed: 10
  }), process.cwd());
  assert.equal(valid.error, undefined);
  assert.ok(valid.result?.structuredContent);
}

async function testRecommendActivityIntentNormalizesWithoutBrowserConnect() {
  let connectorCalled = false;
  setRecommendMcpConnectorForTests(async () => {
    connectorCalled = true;
    throw new Error("prepare must not connect while normalizing activity intent");
  });
  const base = readyArgs();
  const cases = [
    ["active today", "今日活跃"],
    ["昨天活跃", "3日内活跃"],
    ["本舟活跃", "本周活跃"],
    ["very active", "刚刚活跃"],
    ["一般活跃", "本周活跃"],
    ["occasionally active", "本月活跃"],
    ["10 days", "本周活跃"],
    ["very active or occasionally active", "不限"],
    ["不限或今日活跃", "不限"],
    ["blue pineapple", "不限"]
  ];
  for (const [input, expected] of cases) {
    const payload = await callTool(TOOL_PREPARE, readyArgs({
      overrides: {
        ...base.overrides,
        activity_level: input
      }
    }), `4_1_${input}`);
    assert.equal(payload.status, "READY", input);
    assert.equal(payload.review.current_search_params.activity_level, expected, input);
    assert.equal(payload.review.suspicious_fields.some((item) => item.field === "activity_level"), false, input);
    assert.equal(payload.review.current_screen_params.criteria, base.overrides.criteria, input);
  }
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
      rest_level: "high"
    }
  });
  const prepared = await callTool(TOOL_PREPARE, args, 5);
  assert.equal(prepared.status, "READY");
  assert.equal(prepared.cron_ready, true);
  assert.equal(prepared.recommended_next_tool, TOOL_START);
  assert.equal(prepared.alternate_next_tool, TOOL_RUN_RECOMMEND);
  const started = await callTool(TOOL_START, args, 6);
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.run.context.confirmation.final_confirmed, true);
  assert.equal(started.run.context.confirmation.job_confirmed, true);
  const completed = await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(observedOptions.humanBehavior.restLevel, "high");
  assert.equal(completed.context.human_rest_level, "high");
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

async function testRecommendFullySpecifiedPayloadAsksSkipRecentColleagueContacted() {
  const payload = await callTool(TOOL_PREPARE, singleReviewArgs({
    confirmation: {}
  }), 151);
  assert.equal(payload.status, "NEED_CONFIRMATION");
  assert.deepEqual(payload.required_confirmations, ["skip_recent_colleague_contacted"]);
  assert.deepEqual(payload.pending_questions.map((item) => item.field), ["skip_recent_colleague_contacted"]);
  assert.equal(payload.pending_questions[0].value, true);
  assert.equal(payload.pending_questions[0].options[0].value, true);
  assert.equal(payload.pending_questions[0].options[1].value, false);
}

async function testRecommendOptionalFiltersUseOnlyFinalReviewGate() {
  const base = singleReviewArgs();
  const payload = await callTool(TOOL_PREPARE, singleReviewArgs({
    confirmation: {},
    overrides: {
      ...base.overrides,
      current_city_only: true,
      activity_level: "刚刚活跃",
      skip_recent_colleague_contacted: true
    }
  }), 151_1);
  assert.equal(payload.status, "NEED_CONFIRMATION");
  assert.deepEqual(payload.required_confirmations, ["final_review"]);
  assert.deepEqual(payload.pending_questions.map((item) => item.field), ["final_review"]);
  assert.equal(payload.pending_questions[0].value.search_params.current_city_only, true);
  assert.equal(payload.pending_questions[0].value.search_params.activity_level, "刚刚活跃");
}

async function testRecommendGreetWithoutMaxGreetCountIsReady() {
  const base = readyArgs();
  const payload = await callTool(TOOL_PREPARE, readyArgs({
    confirmation: {
      ...base.confirmation,
      post_action_value: "greet"
    },
    overrides: {
      ...base.overrides,
      post_action: "greet"
    }
  }), 154);
  assert.equal(payload.status, "READY");
  assert.equal(payload.post_action.requested, "greet");
  assert.equal(payload.post_action.max_greet_count, null);
}

async function testRecommendFinalConfirmedPayloadStartsAccepted() {
  installFakeConnector();
  let observedOptions = null;
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recommend:single-review");
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
  const started = await callTool(TOOL_START, singleReviewArgs(), 152);
  assert.equal(started.status, "ACCEPTED");
  await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(observedOptions.maxCandidates, 200);
  assert.equal(observedOptions.postAction, "greet");
  assert.equal(observedOptions.maxGreetCount, 200);
  assert.equal(observedOptions.humanBehavior.restLevel, "high");
}

async function testRunRecommendAliasStartsAccepted() {
  installFakeConnector();
  let observedOptions = null;
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recommend:run-alias");
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
  const started = await callTool(TOOL_RUN_RECOMMEND, singleReviewArgs(), 156);
  assert.equal(started.status, "ACCEPTED");
  await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(observedOptions.maxCandidates, 200);
  assert.equal(observedOptions.humanBehavior.restLevel, "high");
}

async function testRecommendScheduleFinalConfirmedPayloadUsesPackageScheduler() {
  let spawnCall = null;
  setRecommendSchedulerSpawnForTests((command, args, options) => {
    spawnCall = { command, args, options };
    return {
      pid: process.pid,
      unref() {}
    };
  });
  try {
    const base = singleReviewArgs();
    const payload = await callTool(TOOL_SCHEDULE, singleReviewArgs({
      schedule_delay_seconds: 60,
      overrides: {
        ...base.overrides,
        current_city_only: true,
        activity_level: "3日内活跃"
      }
    }), 153);
    assert.equal(payload.status, "SCHEDULED");
    assert.equal(payload.schedule_created, true);
    assert.equal(payload.cron_ready, true);
    assert.equal(payload.prepare.status, "READY");
    assert.ok(spawnCall.args.includes("--schedule-worker"));
    assert.equal(payload.schedule.args.confirmation.final_confirmed, true);
    assert.equal(payload.schedule.args.confirmation.page_confirmed, undefined);
    assert.equal(payload.schedule.args.human_behavior.restLevel, "high");
    assert.equal(payload.schedule.args.overrides.current_city_only, true);
    assert.equal(payload.schedule.args.overrides.activity_level, "3日内活跃");
    assert.equal(payload.prepare.review.current_search_params.current_city_only, true);
    assert.equal(payload.prepare.review.current_search_params.activity_level, "3日内活跃");
  } finally {
    setRecommendSchedulerSpawnForTests(null);
  }
}

async function testRecommendMissingRestLevelBlocksWithRestQuestion() {
  const args = singleReviewArgs();
  delete args.human_behavior;
  const payload = await callTool(TOOL_PREPARE, args, 154);
  assert.equal(payload.status, "NEED_CONFIRMATION");
  assert.deepEqual(payload.required_confirmations, ["rest_level"]);
  assert.deepEqual(payload.pending_questions.map((item) => item.field), ["rest_level"]);
  assert.deepEqual(payload.pending_questions[0].options.map((item) => item.value), ["low", "medium", "high"]);
}

async function testRecommendMissingJobStillBlocksBeforeFinalReview() {
  const args = singleReviewArgs();
  delete args.overrides.job;
  const payload = await callTool(TOOL_PREPARE, args, 155);
  assert.equal(payload.status, "NEED_CONFIRMATION");
  assert.deepEqual(payload.required_confirmations, ["job"]);
  assert.deepEqual(payload.pending_questions.map((item) => item.field), ["job"]);
}

async function testRecommendScheduleIncompletePayloadDoesNotSpawn() {
  let spawnCalled = false;
  setRecommendSchedulerSpawnForTests(() => {
    spawnCalled = true;
    throw new Error("should not spawn for incomplete schedule");
  });
  try {
    const payload = await callTool(TOOL_SCHEDULE, {
      instruction: "推荐页帮我筛候选人",
      schedule_delay_seconds: 60
    }, 16);
    assert.equal(["NEED_INPUT", "NEED_CONFIRMATION"].includes(payload.status), true);
    assert.equal(payload.schedule_created, false);
    assert.equal(payload.cron_ready, false);
    assert.equal(spawnCalled, false);
  } finally {
    setRecommendSchedulerSpawnForTests(null);
  }
}

async function testRecommendScheduleReadyPayloadUsesPackageOwnedWorker() {
  let spawnCall = null;
  let unrefCalled = false;
  setRecommendSchedulerSpawnForTests((command, args, options) => {
    spawnCall = { command, args, options };
    return {
      pid: process.pid,
      unref() {
        unrefCalled = true;
      }
    };
  });
  try {
    const args = readyArgs({
      schedule_delay_seconds: 60,
      human_behavior: {
        restLevel: "high"
      }
    });
    const payload = await callTool(TOOL_SCHEDULE, args, 17);
    assert.equal(payload.status, "SCHEDULED");
    assert.equal(payload.schedule_created, true);
    assert.equal(payload.cron_ready, true);
    assert.equal(payload.prepare.status, "READY");
    assert.equal(unrefCalled, true);
    assert.ok(spawnCall.args.includes("--schedule-worker"));
    assert.ok(spawnCall.args.includes(payload.schedule_id));
    assert.equal(spawnCall.options.detached, true);
    assert.equal(payload.schedule.args.confirmation.final_confirmed, true);
    assert.equal(payload.schedule.args.confirmation.job_confirmed, true);
    assert.equal(payload.schedule.args.human_behavior.restLevel, "high");

    const status = await callTool(TOOL_GET_SCHEDULE, {
      schedule_id: payload.schedule_id
    }, 18);
    assert.equal(status.status, "OK");
    assert.equal(status.schedule.state, "scheduled");
    assert.equal(status.schedule.args.overrides.criteria, readyArgs().overrides.criteria);
  } finally {
    setRecommendSchedulerSpawnForTests(null);
  }
}

async function testRecommendScheduleWorkerStartsSavedPayload() {
  setRecommendSchedulerSpawnForTests(() => ({
    pid: process.pid,
    unref() {}
  }));
  installFakeConnector();
  let observedOptions = null;
  const marker = "scheduled status oversized result marker";
  const results = makeLargeRecommendResults(25, marker);
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    observedOptions = options;
    runControl.setPhase("recommend:scheduled-worker");
    runControl.updateProgress({
      target_count: options.maxCandidates,
      processed: results.length,
      screened: results.length,
      detail_opened: results.length,
      passed: 0
    });
    runControl.checkpoint({
      results,
      checkpoint_marker: marker
    });
    return {
      domain: "recommend",
      processed: results.length,
      screened: results.length,
      detail_opened: results.length,
      passed: 0,
      candidate_list: {
        card_count: results.length,
        cards: results
      },
      viewport_health: {
        stats: {
          total: results.length
        },
        events: results
      },
      results
    };
  });
  try {
    const payload = await callTool(TOOL_SCHEDULE, readyArgs({
      delay_ms: 0,
      schedule_delay_seconds: 0,
      human_behavior: {
        restLevel: "medium"
      }
    }), 19);
    assert.equal(payload.status, "SCHEDULED");
    const workerResult = await runScheduledRecommendWorkerForTests({
      scheduleId: payload.schedule_id
    });
    assert.equal(workerResult.ok, true);
    const status = await callTool(TOOL_GET_SCHEDULE, {
      schedule_id: payload.schedule_id
    }, 20);
    assert.equal(status.status, "OK");
    assert.equal(status.schedule.state, "completed");
    assert.ok(status.schedule.run_id);
    assert.equal(status.schedule.run.state, "completed");
    assert.equal(status.schedule.run.result.results_count, results.length);
    assert.equal(Object.prototype.hasOwnProperty.call(status.schedule.run.result, "results"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(status.schedule.run.summary, "results"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(status.schedule.run.checkpoint, "results"), false);
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes(marker), false);
    assert.ok(serialized.length < 30000);
    assert.equal(observedOptions.humanBehavior.restLevel, "medium");
  } finally {
    setRecommendSchedulerSpawnForTests(null);
  }
}

async function testRecommendScheduleStatusCompactsPersistedInlineRun() {
  const scheduleId = "mcp_recommend_schedule_compact_status_test";
  const runId = "mcp_recommend_schedule_compact_run_test";
  const marker = "persisted schedule oversized marker";
  const results = makeLargeRecommendResults(30, marker);
  const schedulesDir = path.join(process.env.BOSS_RECOMMEND_HOME, "schedules");
  fs.mkdirSync(schedulesDir, { recursive: true });
  fs.writeFileSync(path.join(schedulesDir, `${scheduleId}.json`), `${JSON.stringify({
    schedule_id: scheduleId,
    state: "completed",
    status: "completed",
    run_id: runId,
    run: {
      run_id: runId,
      state: "completed",
      status: "completed",
      progress: {
        processed: results.length,
        screened: results.length,
        passed: 0
      },
      result: {
        status: "COMPLETED",
        completion_reason: "completed",
        output_csv: "C:/tmp/schedule.csv",
        report_json: "C:/tmp/schedule.report.json",
        results
      },
      summary: {
        domain: "recommend",
        processed: results.length,
        screened: results.length,
        passed: 0,
        candidate_list: {
          card_count: results.length,
          cards: results
        },
        viewport_health: {
          stats: { total: results.length },
          events: results
        },
        results
      },
      checkpoint: {
        updatedAt: new Date().toISOString(),
        results
      }
    },
    launch_payload: {
      run: {
        run_id: runId,
        state: "completed",
        result: {
          status: "COMPLETED",
          results
        }
      }
    }
  }, null, 2)}\n`, "utf8");

  const status = await callTool(TOOL_GET_SCHEDULE, { schedule_id: scheduleId }, 328);
  const serialized = JSON.stringify(status);
  assert.equal(status.status, "OK");
  assert.equal(status.schedule.run.result.results_count, results.length);
  assert.equal(status.schedule.run.summary.results_count, results.length);
  assert.equal(status.schedule.run.checkpoint.results_count, results.length);
  assert.equal(status.schedule.launch_payload.run.result.results_count, results.length);
  assert.equal(Object.prototype.hasOwnProperty.call(status.schedule.run.result, "results"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status.schedule.run.summary, "results"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status.schedule.run.checkpoint, "results"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status.schedule.launch_payload.run.result, "results"), false);
  assert.equal(serialized.includes(marker), false);
  assert.ok(serialized.length < 25000);
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

async function testRecommendScheduleRejectsDiagnosticOptionsBeforePersistOrSpawn() {
  let spawnCount = 0;
  setRecommendSchedulerSpawnForTests(() => {
    spawnCount += 1;
    throw new Error("diagnostic schedule must not launch a worker");
  });
  const base = readyArgs();
  const cases = [
    { extra: { debug_test_mode: true }, expected: "debug_test_mode" },
    { extra: { allow_debug_test_mode: true }, expected: "allow_debug_test_mode" },
    {
      extra: { debug_test_mode: true, debug_force_list_end_after_processed: 2 },
      expected: "debug_force_list_end_after_processed"
    },
    {
      extra: { debug_test_mode: true, debug_force_context_recovery_after_processed: 2 },
      expected: "debug_force_context_recovery_after_processed"
    },
    {
      extra: { debug_test_mode: true, debug_force_cdp_reconnect_after_processed: 2 },
      expected: "debug_force_cdp_reconnect_after_processed"
    },
    { extra: { screening_mode: "deterministic" }, expected: "screening_mode=deterministic" },
    { extra: { screening_mode: "local_scorer" }, expected: "screening_mode=local_scorer" },
    { extra: { use_llm: false }, expected: "use_llm=false" },
    { extra: { allow_card_only_screening: true }, expected: "allow_card_only_screening" },
    { extra: { detail_limit: 0 }, expected: "detail_limit=0" },
    { extra: { no_filter: true }, expected: "no_filter" },
    { extra: { filter_enabled: false }, expected: "filter_enabled=false" },
    { extra: { dry_run_post_action: true }, expected: "dry_run_post_action" },
    { extra: { dry_run: true }, expected: "dry_run" },
    {
      extra: {
        confirmation: {
          ...base.confirmation,
          post_action_value: "greet"
        },
        overrides: {
          ...base.overrides,
          post_action: "greet"
        },
        execute_post_action: false
      },
      expected: "execute_post_action=false"
    }
  ];

  try {
    for (let index = 0; index < cases.length; index += 1) {
      const { extra, expected } = cases[index];
      const scheduleId = `mcp_recommend_schedule_debug_forbidden_${index}`;
      const schedulePath = path.join(
        process.env.BOSS_RECOMMEND_HOME,
        "schedules",
        `${scheduleId}.json`
      );
      const payload = await callTool(TOOL_SCHEDULE, readyArgs({
        ...extra,
        schedule_id: scheduleId,
        schedule_delay_seconds: 60
      }), 1700 + index);
      assert.equal(payload.status, "FAILED");
      assert.equal(payload.schedule_created, false);
      assert.equal(payload.cron_ready, false);
      assert.equal(payload.error.code, "RECOMMEND_SCHEDULE_DEBUG_OPTIONS_FORBIDDEN");
      assert.equal(payload.error.retryable, false);
      assert.equal(payload.forbidden_debug_options.includes(expected), true);
      assert.equal(fs.existsSync(schedulePath), false);
    }
    assert.equal(spawnCount, 0);
  } finally {
    setRecommendSchedulerSpawnForTests(null);
  }
}

async function testRecommendDebugBoundaryOptionsReachWorkflow() {
  const cases = [
    ["debug_force_list_end_after_processed", "debugForceListEndAfterProcessed"],
    ["debug_force_context_recovery_after_processed", "debugForceContextRecoveryAfterProcessed"],
    ["debug_force_cdp_reconnect_after_processed", "debugForceCdpReconnectAfterProcessed"]
  ];
  for (let index = 0; index < cases.length; index += 1) {
    if (index > 0) resetRecommendMcpStateForTests();
    const [inputField, workflowField] = cases[index];
    const observedOptions = await observeRecommendWorkflowOptions(readyArgs({
      debug_test_mode: true,
      [inputField]: 10
    }), 140 + index);
    assert.equal(observedOptions.debugTestMode, true);
    assert.equal(observedOptions[workflowField], 10);
  }
}

async function testRecommendLoadsLlmConfigByDefault() {
  const observedOptions = await observeRecommendWorkflowOptions(readyArgs({ delay_ms: 0 }), 15);
  assert.equal(observedOptions.screeningMode, "llm");
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
  assert.equal(observedOptions.llmConfig.outputDir, outputDirForTests());
  assert.equal(observedOptions.llmConfig.humanRestEnabled, true);
  assert.equal(observedOptions.humanRestEnabled, true);
  assert.equal(observedOptions.humanBehavior.profile, "paced_with_rests");
  assert.equal(observedOptions.humanBehavior.textEntry, true);
  assert.equal(observedOptions.humanBehavior.listScrollJitter, true);
  assert.equal(observedOptions.humanBehavior.restLevel, "medium");
  assert.equal(observedOptions.llmConfig.llmModels.length, 2);
  assert.equal(observedOptions.llmConfig.llmModels[0].llmScreeningStrategy, "fast_first_verified");
  assert.equal(observedOptions.llmConfig.llmModels[0].llmFastThinkingLevel, "current");
  assert.equal(observedOptions.llmConfig.llmModels[0].llmVerifyThinkingLevel, "medium");
  assert.equal(observedOptions.llmConfig.llmModels[0].llmFastMaxTokens, 320);
  assert.equal(observedOptions.llmConfig.llmModels[0].llmVerifyMaxTokens, 1536);
  assert.equal(observedOptions.llmConfig.llmModels[1].model, "gpt-4.1-nano");
  assert.equal(observedOptions.llmConfig.llmModels[1].apiKey, "sk-backup-key");
  assert.equal(observedOptions.llmConfig.llmModels[1].llmScreeningStrategy, "fast_first_verified");
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

async function testRecommendStaleDiagnosticsSurviveStatusAndDiskCompaction() {
  installFakeConnector();
  const privateMarker = "must-not-persist";
  const diagnostics = Array.from({ length: 15 }, (_, index) => ({
    code: "RECOMMEND_LIST_READ_STALE_NODE",
    message: "Could not find node with given id",
    phase: "recommend:list-read",
    cdp_method: "DOM.querySelectorAll:retry_after_reconnect",
    cdp_at: `2026-07-17T10:00:${String(index).padStart(2, "0")}.000Z`,
    cdp_node_id: 1000 + index,
    cdp_backend_node_id: 2000 + index,
    cdp_search_id: `search-${index}`,
    cdp_connection_epoch: index,
    cdp_reconnected_epoch: index + 1,
    cdp_replay_policy: "safe_read_only",
    cdp_replay_suppressed: index % 2 === 0,
    cdp_outcome_unknown: index % 2 === 1,
    cdp_reconnected: true,
    cdp_replayed_after_reconnect: true,
    cdp_reconnect_error: {
      code: "ECONNRESET",
      message: "connection reset",
      candidate_name: privateMarker
    },
    cdp_param_keys: ["nodeId", "selector", "unsafe-key!"],
    attempt: index + 1,
    exhausted: index === 14,
    recovery_mode: index === 0 ? "root_reacquire" : "context_reapply",
    candidate_name: privateMarker
  }));
  const forensicEvents = Array.from({ length: 15 }, (_, index) => ({
    schema_version: 1,
    event_id: `dom-stale-${index}`,
    event_type: "dom_stale",
    at: `2026-07-17T10:01:${String(index).padStart(2, "0")}.000Z`,
    phase: "recommend:detail",
    operation: "capture_candidate_detail",
    detail_step: "open_detail",
    candidate: {
      index,
      key: `recommend:id:${index}`,
      card_node_id: 3000 + index,
      visible_index: index % 4,
      failing_list_node_id: 4000 + index,
      name: privateMarker,
      resume_content: privateMarker
    },
    error: {
      ...diagnostics[index],
      name: "ProtocolError"
    },
    pre_recovery_roots: {
      connection_epoch: index,
      top_document_node_id: 5000 + index,
      iframe_owner_node_id: 6000 + index,
      iframe_document_node_id: 7000 + index,
      iframe_selector: "iframe[name=recommendFrame]",
      candidate_name: privateMarker
    },
    candidate_list: {
      seen_count: index + 1,
      queued_count: 2,
      processed_count: index,
      resume_content: privateMarker
    },
    counters: {
      processed: index,
      screened: index,
      candidate_name: privateMarker
    },
    lifecycle_timeline: Array.from({ length: 25 }, (_, timelineIndex) => ({
      at: new Date(Date.UTC(2026, 6, 17, 10, 2, timelineIndex)).toISOString(),
      type: timelineIndex % 2 === 0 ? "frameNavigated" : "documentUpdated",
      operation: "capture_candidate_detail",
      connection_epoch: index,
      frame_id: `frame-${timelineIndex}`,
      parent_frame_id: "main-frame",
      loader_id: `loader-${timelineIndex}`,
      url: `https://www.zhipin.com/web/chat/recommend?candidate=${privateMarker}`,
      resume_content: privateMarker
    })),
    recovery: {
      status: "recovered",
      at: `2026-07-17T10:03:${String(index).padStart(2, "0")}.000Z`,
      mode: "context_reapply",
      escalated_from: "root_reacquire",
      ok: true,
      method: "Page.reload",
      card_count: 12,
      candidate_name: privateMarker
    },
    post_recovery_roots: {
      connection_epoch: index + 1,
      top_document_node_id: 8000 + index,
      iframe_owner_node_id: 9000 + index,
      iframe_document_node_id: 10000 + index,
      iframe_selector: "iframe[name=recommendFrame]"
    },
    candidate_name: privateMarker,
    resume: { content: privateMarker }
  }));
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    runControl.setPhase("recommend:list-read");
    runControl.updateProgress({
      target_count: options.maxCandidates,
      processed: 10,
      screened: 10,
      list_read_stale_recovery_attempts: 3,
      list_read_stale_recovery_applied: 2,
      list_read_stale_recoveries: 1,
      last_list_read_recovery_mode: "context_reapply",
      last_list_read_stale_diagnostic: diagnostics.at(-1),
      dom_stale_forensic: forensicEvents.at(-1),
      dom_stale_forensics: forensicEvents
    });
    runControl.checkpoint({
      list_read_stale_recovery_exhausted: {
        diagnostic: diagnostics.at(-1),
        recent_diagnostics: diagnostics,
        candidate_list: {
          seen_count: 10,
          queued_count: 0,
          processed_count: 10
        },
        candidate_name: privateMarker
      },
      dom_stale_forensic: forensicEvents.at(-1),
      dom_stale_forensics: forensicEvents
    });
    return {
      domain: "recommend",
      processed: 10,
      screened: 10,
      passed: 0,
      list_read_stale_recovery_attempts: 3,
      list_read_stale_recovery_applied: 2,
      list_read_stale_recoveries: 1,
      last_list_read_recovery_mode: "context_reapply",
      last_list_read_stale_diagnostic: diagnostics.at(-1),
      list_read_stale_diagnostics: diagnostics,
      dom_stale_forensic: forensicEvents.at(-1),
      dom_stale_forensics: forensicEvents,
      results: []
    };
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 0 }), 311);
  assert.equal(started.status, "ACCEPTED");
  const statePath = started.run.artifacts.run_state_path;
  await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  const status = await callTool(TOOL_GET, { run_id: started.run_id }, 312);
  assert.equal(status.run.summary.list_read_stale_recovery_attempts, 3);
  assert.equal(status.run.summary.list_read_stale_recovery_applied, 2);
  assert.equal(status.run.summary.list_read_stale_recoveries, 1);
  assert.equal(status.run.summary.last_list_read_recovery_mode, "context_reapply");
  assert.equal(status.run.summary.list_read_stale_diagnostics.length, 12);
  assert.deepEqual(
    status.run.summary.last_list_read_stale_diagnostic.cdp_param_keys,
    ["nodeId", "selector"]
  );
  assert.equal(status.run.summary.last_list_read_stale_diagnostic.cdp_search_id, "search-14");
  assert.equal(status.run.summary.last_list_read_stale_diagnostic.cdp_connection_epoch, 14);
  assert.equal(status.run.summary.last_list_read_stale_diagnostic.cdp_reconnected_epoch, 15);
  assert.equal(status.run.summary.last_list_read_stale_diagnostic.cdp_replay_policy, "safe_read_only");
  assert.equal(status.run.summary.last_list_read_stale_diagnostic.cdp_replay_suppressed, true);
  assert.equal(status.run.summary.last_list_read_stale_diagnostic.cdp_outcome_unknown, false);
  assert.equal(status.run.summary.last_list_read_stale_diagnostic.cdp_reconnected, true);
  assert.equal(status.run.summary.last_list_read_stale_diagnostic.cdp_replayed_after_reconnect, true);
  assert.equal(
    status.run.summary.last_list_read_stale_diagnostic.cdp_reconnect_error.code,
    "ECONNRESET"
  );
  assert.equal(
    status.run.checkpoint.list_read_stale_recovery_exhausted.recent_diagnostics.length,
    12
  );
  assert.equal(status.run.progress.dom_stale_forensics.length, 12);
  assert.equal(status.run.summary.dom_stale_forensics.length, 12);
  assert.equal(status.run.checkpoint.dom_stale_forensics.length, 12);
  assert.equal(status.run.summary.dom_stale_forensics[0].event_id, "dom-stale-3");
  const latestForensic = status.run.summary.dom_stale_forensic;
  assert.equal(latestForensic.candidate.index, 14);
  assert.equal(latestForensic.candidate.key, "recommend:id:14");
  assert.equal(latestForensic.candidate.failing_list_node_id, 4014);
  assert.equal(latestForensic.pre_recovery_roots.top_document_node_id, 5014);
  assert.equal(latestForensic.post_recovery_roots.connection_epoch, 15);
  assert.equal(latestForensic.recovery.status, "recovered");
  assert.equal(latestForensic.recovery.ok, true);
  assert.equal(latestForensic.lifecycle_timeline.length, 20);
  assert.equal(latestForensic.lifecycle_timeline[0].frame_id, "frame-5");
  assert.equal(
    latestForensic.lifecycle_timeline.at(-1).url,
    "https://www.zhipin.com/web/chat/recommend"
  );
  assert.equal(JSON.stringify(status.run).includes(privateMarker), false);

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.summary.list_read_stale_diagnostics.length, 12);
  assert.equal(
    persisted.checkpoint.list_read_stale_recovery_exhausted.diagnostic.cdp_node_id,
    1014
  );
  assert.equal(persisted.summary.dom_stale_forensics.length, 12);
  assert.equal(persisted.checkpoint.dom_stale_forensic.candidate.card_node_id, 3014);
  assert.equal(JSON.stringify(persisted).includes(privateMarker), false);
}

async function testRecommendDiskRunningRunWithDeadPidIsReconciled() {
  resetRecommendMcpStateForTests();
  const runId = "mcp_recommend_deadpid_test";
  const runsDir = path.join(process.env.BOSS_RECOMMEND_HOME, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const statePath = path.join(runsDir, `${runId}.json`);
  const checkpointPath = path.join(runsDir, `${runId}.checkpoint.json`);
  const exitStatusPath = path.join(runsDir, `${runId}.worker.exit.json`);
  const expectedLaunchId = "current-deadpid-launch";
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
  fs.writeFileSync(exitStatusPath, `${JSON.stringify({
    schema_version: 1,
    domain: "recommend",
    run_id: runId,
    launch_id: "stale-deadpid-launch",
    wrapper_pid: 987654322,
    worker_pid: 987654321,
    started_at: startedAt,
    exited_at: new Date().toISOString(),
    exit_code: 23,
    nonzero: true,
    termination_kind: "observed_child_exit",
    wrapper_error: null
  }, null, 2)}\n`, "utf8");
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
      checkpoint_path: checkpointPath,
      worker_launch_id: expectedLaunchId,
      worker_supervisor_pid: 987654322
    },
    result: null,
    error: null
  }, null, 2)}\n`, "utf8");

  const payload = await callTool(TOOL_GET, { run_id: runId }, 32);
  assert.equal(payload.status, "RUN_STATUS");
  assert.equal(payload.run.state, "failed");
  assert.equal(payload.run.pid, 987654321);
  assert.equal(payload.run.error.code, "RUN_PROCESS_EXITED");
  assert.equal(payload.run.error.diagnostic_source, "pid_reconciliation");
  assert.equal(payload.run.recovery.classification, "worker_process_exited");
  assert.equal(payload.run.recovery.safe_for_outer_ai_agent, false);
  assert.equal(payload.run.recovery.automatic_restart_allowed, false);
  assert.equal(payload.run.recovery.requires_durable_action_journal_audit, true);
  assert.equal(payload.run.recovery.worker_last_heartbeat_at, startedAt);
  assert.equal(payload.run.recovery.resume_failed_run_in_place_allowed, false);
  assert.equal(payload.run.heartbeat_at, startedAt);
  assert.equal(payload.persistence.source, "disk");
  assert.equal(payload.persistence.active_control_available, false);
  assert.equal(payload.persistence.stale_process_reconciled, true);
  assert.equal(payload.run.result.status, "FAILED");
  assert.equal(payload.run.result.processed_count, 1);
  assert.equal(payload.run.result.passed_count, 1);
  assert.equal(fs.existsSync(payload.run.result.output_csv), true);
  assert.equal(fs.existsSync(payload.run.result.report_json), true);
}

async function testRecommendDeadPidUsesMatchingSupervisorExitSidecar() {
  resetRecommendMcpStateForTests();
  const runId = "mcp_recommend_exit_sidecar_test";
  const runsDir = path.join(process.env.BOSS_RECOMMEND_HOME, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const statePath = path.join(runsDir, `${runId}.json`);
  const checkpointPath = path.join(runsDir, `${runId}.checkpoint.json`);
  const exitStatusPath = path.join(runsDir, `${runId}.worker.exit.json`);
  const launchId = "recommend-exit-sidecar-launch";
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const exitedAt = new Date(Date.now() - 30_000).toISOString();
  fs.writeFileSync(checkpointPath, `${JSON.stringify({
    updatedAt: startedAt,
    in_progress_candidate: {
      key: "recommend:id:pre-action-only",
      detail_step: "open_detail",
      candidate_binding: null,
      action_state: null,
      error: null
    },
    results: []
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(exitStatusPath, `${JSON.stringify({
    schema_version: 1,
    domain: "recommend",
    run_id: runId,
    launch_id: launchId,
    wrapper_pid: 876540001,
    worker_pid: 876540002,
    started_at: startedAt,
    exited_at: exitedAt,
    exit_code: 23,
    nonzero: true,
    termination_kind: "observed_child_exit",
    wrapper_error: null
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(statePath, `${JSON.stringify({
    run_id: runId,
    state: "running",
    status: "running",
    stage: "recommend:detail",
    started_at: startedAt,
    updated_at: startedAt,
    heartbeat_at: startedAt,
    pid: process.pid,
    progress: {
      target_count: 10,
      processed: 4,
      screened: 4,
      passed: 0,
      skipped: 4,
      greet_count: 0
    },
    context: {
      instruction: "推荐页筛选算法候选人",
      confirmation: { job_value: "算法工程师" },
      overrides: {
        job: "算法工程师",
        criteria: "候选人具备算法经验",
        target_count: 10,
        post_action: "greet",
        max_greet_count: 10
      }
    },
    resume: {
      checkpoint_path: checkpointPath,
      worker_launch_id: launchId,
      worker_supervisor_pid: 876540001,
      worker_node_pid: 876540002,
      worker_exit_status_path: exitStatusPath
    },
    result: null,
    error: null
  }, null, 2)}\n`, "utf8");

  const payload = await callTool(TOOL_GET, { run_id: runId }, 322);
  assert.equal(payload.status, "RUN_STATUS");
  assert.equal(payload.run.state, "failed");
  assert.equal(payload.run.error.code, "RECOMMEND_WORKER_EXITED_NONZERO");
  assert.equal(payload.run.error.worker_exit_code, 23);
  assert.equal(payload.run.error.worker_launch_id, launchId);
  assert.equal(payload.run.error.worker_pid, 876540002);
  assert.equal(payload.run.error.supervisor_pid, 876540001);
  assert.equal(payload.run.error.worker_exited_at, exitedAt);
  assert.equal(payload.run.error.diagnostic_source, "windows_cim_exit_sidecar");
  assert.equal(payload.run.recovery.classification, "worker_process_exited");
  assert.equal(payload.run.recovery.safe_for_outer_ai_agent, false);
  assert.equal(payload.run.recovery.automatic_restart_allowed, false);
  assert.equal(payload.run.recovery.requires_durable_action_journal_audit, true);
  assert.equal(
    payload.run.recovery.recommended_action,
    "audit_durable_action_journals_then_start_one_reduced_target_replacement_only"
  );
  assert.equal(payload.run.recovery.worker_last_heartbeat_at, startedAt);
  assert.equal(payload.run.heartbeat_at, startedAt);
  assert.equal(payload.run.resume.worker_supervisor_pid, 876540001);
  assert.equal(payload.run.resume.worker_exit_status_path, exitStatusPath);
  assert.equal(
    payload.run.recovery.constraints.some((item) => item.includes("Never replay greeting_send_in_flight")),
    true
  );
}

async function testRecommendDiskCancelRequestedDeadPidIsReconciledAsCanceled() {
  resetRecommendMcpStateForTests();
  const runId = "mcp_recommend_deadpid_canceled_test";
  const runsDir = path.join(process.env.BOSS_RECOMMEND_HOME, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const statePath = path.join(runsDir, `${runId}.json`);
  const checkpointPath = path.join(runsDir, `${runId}.checkpoint.json`);
  const startedAt = new Date(Date.now() - 45_000).toISOString();
  fs.writeFileSync(checkpointPath, `${JSON.stringify({
    updatedAt: startedAt,
    results: [
      {
        index: 0,
        candidate: { identity: { name: "候选人C" } },
        screening: { passed: false, status: "fail", score: 10 }
      }
    ]
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(statePath, `${JSON.stringify({
    run_id: runId,
    state: "running",
    status: "running",
    stage: "recommend:detail",
    started_at: startedAt,
    updated_at: startedAt,
    heartbeat_at: startedAt,
    pid: 987654320,
    progress: {
      target_count: 3,
      processed: 1,
      screened: 1,
      passed: 0,
      skipped: 1,
      greet_count: 0
    },
    context: {
      instruction: "推荐页筛选算法候选人",
      confirmation: { job_value: "算法工程师" },
      overrides: {
        job: "算法工程师",
        criteria: "候选人具备算法经验",
        target_count: 3,
        post_action: "none"
      }
    },
    control: {
      pause_requested: true,
      pause_requested_at: startedAt,
      pause_requested_by: "cancel_recommend_pipeline_run",
      cancel_requested: true
    },
    resume: {
      checkpoint_path: checkpointPath
    },
    result: null,
    error: null
  }, null, 2)}\n`, "utf8");

  const payload = await callTool(TOOL_GET, { run_id: runId }, 321);
  assert.equal(payload.status, "RUN_STATUS");
  assert.equal(payload.run.state, "canceled");
  assert.equal(payload.run.status, "canceled");
  assert.equal(payload.run.result.status, "CANCELED");
  assert.equal(payload.run.result.completion_reason, "canceled_by_user");
  assert.equal(payload.run.error.code, "PIPELINE_CANCELED");
  assert.equal(payload.run.error.shutdown_error.code, "RUN_PROCESS_EXITED");
  assert.equal(payload.persistence.stale_process_reconciled, true);
}

async function testRecommendListRunsReturnsCompactLatest() {
  resetRecommendMcpStateForTests();
  const runsDir = path.join(process.env.BOSS_RECOMMEND_HOME, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const olderAt = new Date(Date.now() + 10_000).toISOString();
  const newerAt = new Date(Date.now() + 20_000).toISOString();
  const olderId = "mcp_recommend_list_old_test";
  const newerId = "mcp_recommend_list_new_test";
  for (const [runId, updatedAt] of [[olderId, olderAt], [newerId, newerAt]]) {
    fs.writeFileSync(path.join(runsDir, `${runId}.json`), `${JSON.stringify({
      run_id: runId,
      state: "paused",
      status: "paused",
      stage: "recommend:detail",
      started_at: updatedAt,
      updated_at: updatedAt,
      heartbeat_at: updatedAt,
      pid: process.pid,
      progress: {
        processed: runId === newerId ? 2 : 1,
        screened: runId === newerId ? 2 : 1,
        target_count: 50,
        card_count: 3,
        passed: 0,
        skipped: 0,
        greet_count: 0,
        last_human_event: "large progress should not appear".repeat(200),
        human_rest_last: {
          reason: "nested progress detail should not appear",
          samples: Array.from({ length: 50 }, (_, index) => ({ index, value: "oversized" }))
        }
      },
      control: {
        pause_requested: true,
        cancel_requested: false
      },
      result: {
        status: "PAUSED",
        completion_reason: "paused",
        results: [
          { candidate: { identity: { name: "large payload should not appear" } } }
        ],
        output_csv: `C:/tmp/${runId}.csv`
      }
    }, null, 2)}\n`, "utf8");
  }
  fs.writeFileSync(path.join(runsDir, `${newerId}.worker.exit.json`), `${JSON.stringify({
    run_id: `${newerId}.worker.exit`,
    state: "paused",
    updated_at: new Date(Date.now() + 60_000).toISOString()
  })}\n`, "utf8");

  const payload = await callTool(TOOL_LIST_RUNS, { state: "paused", limit: 1 }, 322);
  assert.equal(payload.status, "OK");
  assert.equal(payload.count, 1);
  assert.equal(payload.latest_run.run_id, newerId);
  assert.equal(payload.total_matching, 2);
  assert.equal(payload.runs[0].run_id, newerId);
  assert.equal(payload.runs[0].result.output_csv, `C:/tmp/${newerId}.csv`);
  assert.deepEqual(payload.runs[0].progress, {
    processed: 2,
    screened: 2,
    passed: 0,
    skipped: 0,
    target_count: 50,
    card_count: 3,
    greet_count: 0
  });
  assert.equal(Object.prototype.hasOwnProperty.call(payload.runs[0].result, "results"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.runs[0], "resume"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.runs[0], "run_state_path"), false);
  assert.equal(JSON.stringify(payload).includes("large payload should not appear"), false);
  assert.equal(JSON.stringify(payload).includes("large progress should not appear"), false);
  assert.ok(JSON.stringify(payload).length < 8000);
  assert.equal(payload.message.includes("PowerShell"), true);
}

async function testRecommendCompletedStatusOmitsInlineResults() {
  installFakeConnector();
  const marker = "completed status oversized result marker";
  const results = makeLargeRecommendResults(35, marker);
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    runControl.setPhase("recommend:large-result");
    runControl.updateProgress({
      card_count: results.length,
      target_count: options.maxCandidates,
      processed: results.length,
      screened: results.length,
      detail_opened: results.length,
      passed: results.filter((item) => item.screening.passed).length
    });
    runControl.checkpoint({
      results,
      checkpoint_marker: marker
    });
    return {
      domain: "recommend",
      processed: results.length,
      screened: results.length,
      detail_opened: results.length,
      passed: results.filter((item) => item.screening.passed).length,
      list_end_reason: "target_reached",
      candidate_list: {
        card_count: results.length,
        cards: results
      },
      viewport_health: {
        stats: {
          total: results.length
        },
        events: results
      },
      refresh_attempts: results,
      results
    };
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 0 }), 326);
  assert.equal(started.status, "ACCEPTED");
  await waitForRecommendRun(started.run_id, (run) => run?.state === "completed");
  const payload = await callTool(TOOL_GET, { run_id: started.run_id }, 327);
  const serialized = JSON.stringify(payload);

  assert.equal(payload.status, "RUN_STATUS");
  assert.equal(payload.run.state, "completed");
  assert.equal(payload.run.result.results_count, results.length);
  assert.equal(payload.run.result.results_available, true);
  assert.equal(payload.run.summary.results_count, results.length);
  assert.equal(payload.run.checkpoint.results_count, results.length);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.run.result, "results"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.run.summary, "results"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.run.checkpoint, "results"), false);
  assert.equal(serialized.includes(marker), false);
  assert.ok(serialized.length < 25000);

  const runStatePath = path.join(process.env.BOSS_RECOMMEND_HOME, "runs", `${started.run_id}.json`);
  const runStateRaw = fs.readFileSync(runStatePath, "utf8");
  assert.equal(runStateRaw.includes(marker), false);
  assert.ok(runStateRaw.length < 25000);

  const report = JSON.parse(fs.readFileSync(payload.run.result.report_json, "utf8"));
  assert.equal(report.summary.results.length, results.length);
  assert.equal(JSON.stringify(report).includes(marker), true);
  const checkpoint = JSON.parse(fs.readFileSync(payload.run.result.checkpoint_path, "utf8"));
  assert.equal(checkpoint.results.length, results.length);
  assert.equal(JSON.stringify(checkpoint).includes(marker), true);
}

async function testRecommendOptionalArtifactFailuresDoNotBlockTerminalState() {
  installFakeConnector();
  let releaseWorkflow;
  let markWorkflowEntered;
  const workflowEntered = new Promise((resolve) => {
    markWorkflowEntered = resolve;
  });
  const workflowRelease = new Promise((resolve) => {
    releaseWorkflow = resolve;
  });
  const results = [{
    index: 0,
    candidate: { id: "artifact-warning-candidate", identity: { name: "候选人-可选产物失败" } },
    screening: { passed: false, status: "screened", score: 0 }
  }];
  setRecommendMcpWorkflowForTests(async (options, runControl) => {
    runControl.setPhase("recommend:artifact-warning-test");
    runControl.updateProgress({
      card_count: 1,
      target_count: options.maxCandidates,
      processed: 1,
      screened: 1,
      passed: 0
    });
    runControl.checkpoint({ results, checkpoint_marker: "critical-checkpoint-survived" });
    markWorkflowEntered();
    await workflowRelease;
    return {
      domain: "recommend",
      processed: 1,
      screened: 1,
      detail_opened: 1,
      passed: 0,
      results
    };
  });

  const started = await callTool(TOOL_START, readyArgs({ delay_ms: 0 }), 327_1);
  assert.equal(started.status, "ACCEPTED");
  await workflowEntered;
  const outputDir = outputDirForTests();
  fs.mkdirSync(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, `${started.run_id}.results.csv`);
  const reportPath = path.join(outputDir, `${started.run_id}.report.json`);
  const blockers = [`${csvPath}.tmp`, `${reportPath}.tmp`];
  for (const blocker of blockers) fs.mkdirSync(blocker, { recursive: true });
  try {
    releaseWorkflow();
    const completed = await waitForRecommendRun(started.run_id, (run) => run?.state === "completed");
    assert.equal(completed.state, "completed");
    assert.deepEqual(
      completed.artifact_warnings.map((warning) => warning.artifact).sort(),
      ["report_json", "results_csv"]
    );
    assert.equal(
      completed.artifact_warnings.every((warning) => (
        warning.code === "RECOMMEND_OPTIONAL_ARTIFACT_WRITE_FAILED"
        && warning.retryable === true
      )),
      true
    );

    const statePath = path.join(process.env.BOSS_RECOMMEND_HOME, "runs", `${started.run_id}.json`);
    const checkpointPath = path.join(process.env.BOSS_RECOMMEND_HOME, "runs", `${started.run_id}.checkpoint.json`);
    const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(persisted.state, "completed");
    assert.equal(persisted.artifact_warnings.length, 2);
    assert.equal(persisted.artifacts.warnings.length, 2);
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    assert.equal(checkpoint.checkpoint_marker, "critical-checkpoint-survived");
    assert.equal(checkpoint.results.length, 1);
    assert.equal(fs.existsSync(csvPath), false);
    assert.equal(fs.existsSync(reportPath), false);
  } finally {
    releaseWorkflow();
    for (const blocker of blockers) fs.rmSync(blocker, { recursive: true, force: true });
  }
}

async function testRecommendDetachedCancelSocketFailureFinalizesCanceled() {
  const previousDetached = process.env.BOSS_RECOMMEND_CDP_DETACHED;
  const previousInproc = process.env.BOSS_RECOMMEND_CDP_INPROC;
  process.env.BOSS_RECOMMEND_CDP_INPROC = "0";
  process.env.BOSS_RECOMMEND_CDP_DETACHED = "1";
  setSpawnProcessImplForTests(() => ({
    pid: 456790,
    unref() {}
  }));
  try {
    installFakeConnector();
    setRecommendMcpWorkflowForTests(async (options, runControl) => {
      runControl.setPhase("recommend:detail");
      runControl.updateProgress({
        card_count: 1,
        target_count: options.maxCandidates,
        processed: 1,
        screened: 1,
        passed: 0,
        greet_count: 0
      });
      await sleep(20);
      const error = new Error("socket hang up");
      error.code = "ECONNRESET";
      throw error;
    });

    const started = await callTool(TOOL_START, readyArgs({
      delay_ms: 0,
      debug_test_mode: true,
      screening_mode: "deterministic",
      no_filter: true,
      detail_limit: 1,
      execute_post_action: false
    }), 323);
    assert.equal(started.status, "ACCEPTED");
    assert.equal(started.run.state, "queued");

    const cancelPayload = await callTool(TOOL_CANCEL, { run_id: started.run_id }, 324);
    assert.equal(cancelPayload.status, "CANCEL_REQUESTED");

    const workerResult = await runDetachedWorkerForTests({
      runId: started.run_id,
      workerPid: 456790,
      launchId: started.run.resume.worker_launch_id
    });
    assert.equal(workerResult.ok, true);
    const payload = await callTool(TOOL_GET, { run_id: started.run_id }, 325);
    assert.equal(payload.run.state, "canceled");
    assert.equal(payload.run.result.status, "CANCELED");
    assert.equal(payload.run.result.completion_reason, "canceled_by_user");
    assert.equal(payload.run.error.code, "PIPELINE_CANCELED");
    assert.equal(payload.run.error.shutdown_error.message, "socket hang up");
    assert.equal(payload.run.control.cancel_requested, false);
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

async function testRecommendSupervisorExitRecorderMarksFailureImmediately() {
  const previousDetached = process.env.BOSS_RECOMMEND_CDP_DETACHED;
  const previousInproc = process.env.BOSS_RECOMMEND_CDP_INPROC;
  process.env.BOSS_RECOMMEND_CDP_INPROC = "0";
  process.env.BOSS_RECOMMEND_CDP_DETACHED = "1";
  setSpawnProcessImplForTests(() => ({
    pid: process.pid,
    unref() {}
  }));
  try {
    const started = await callTool(TOOL_START, readyArgs({
      delay_ms: 0,
      debug_test_mode: true,
      screening_mode: "deterministic",
      no_filter: true,
      detail_limit: 1,
      execute_post_action: false
    }), 323_1);
    assert.equal(started.status, "ACCEPTED");
    assert.equal(started.run.state, "queued");

    const staleRecord = await recordDetachedWorkerExit({
      domain: "recommend",
      runId: started.run_id,
      workerExitCode: 137,
      workerPid: 476544,
      supervisorPid: process.pid,
      launchId: "stale-launch-id"
    });
    assert.deepEqual(staleRecord, { ok: true, persisted: false });
    const stillQueued = await callTool(TOOL_GET, { run_id: started.run_id }, 323_15);
    assert.equal(stillQueued.run.state, "queued");
    const staleWorker = await runDetachedWorkerForTests({
      runId: started.run_id,
      workerPid: 476545,
      launchId: "stale-launch-id"
    });
    assert.equal(staleWorker.ok, false);
    assert.match(staleWorker.error, /launch identity does not match/);

    const missingSupervisorRecord = await recordDetachedWorkerExit({
      domain: "recommend",
      runId: started.run_id,
      workerExitCode: 137,
      workerPid: 476544,
      launchId: started.run.resume.worker_launch_id
    });
    assert.deepEqual(missingSupervisorRecord, { ok: true, persisted: false });

    const recorded = await recordDetachedWorkerExit({
      domain: "recommend",
      runId: started.run_id,
      workerExitCode: 137,
      workerPid: 476544,
      supervisorPid: process.pid,
      launchId: started.run.resume.worker_launch_id
    });
    assert.deepEqual(recorded, { ok: true, persisted: true });

    const payload = await callTool(TOOL_GET, { run_id: started.run_id }, 323_2);
    assert.equal(payload.run.state, "failed");
    assert.equal(payload.run.error.code, "DETACHED_WORKER_EXITED_EARLY");
    assert.equal(payload.run.error.worker_exit_code, 137);
    assert.equal(payload.run.error.worker_pid, 476544);
    assert.equal(payload.run.error.supervisor_pid, process.pid);
    assert.equal(payload.run.error.diagnostic_source, "windows_cim_supervisor");
    assert.equal(payload.run.recovery.classification, "worker_process_exited");
    assert.equal(payload.run.recovery.automatic_restart_allowed, false);
    assert.equal(payload.run.recovery.requires_durable_action_journal_audit, true);
    const lateWorker = await runDetachedWorkerForTests({
      runId: started.run_id,
      workerPid: 476546,
      launchId: started.run.resume.worker_launch_id
    });
    assert.equal(lateWorker.ok, false);
    assert.match(lateWorker.error, /already terminal/);
    const stillFailed = await callTool(TOOL_GET, { run_id: started.run_id }, 323_3);
    assert.equal(stillFailed.run.state, "failed");
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

async function testRecommendDetachedStartUsesWorkerProcess() {
  const previousDetached = process.env.BOSS_RECOMMEND_CDP_DETACHED;
  const previousInproc = process.env.BOSS_RECOMMEND_CDP_INPROC;
  process.env.BOSS_RECOMMEND_CDP_INPROC = "0";
  process.env.BOSS_RECOMMEND_CDP_DETACHED = "1";
  let launcherOptions = null;
  let unrefCalled = false;
  let connectOptions = null;
  let workflowOptions = null;
  setRecommendDetachedWorkerLauncherForTests((options) => {
    launcherOptions = options;
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
    assert.ok(started.run.resume.worker_exit_status_path.endsWith(`${started.run_id}.worker.exit.json`));
    assert.equal(started.run.resume.worker_launcher, process.platform === "win32" ? "windows_cim_supervisor" : "posix_detached_spawn");
    assert.equal(started.run.resume.worker_launch_id, launcherOptions.launchId);
    assert.equal(started.run.resume.worker_supervisor_pid, process.platform === "win32" ? 456789 : null);
    assert.equal(fs.existsSync(started.run.resume.worker_stdout_path), true);
    assert.equal(fs.existsSync(started.run.resume.worker_stderr_path), true);
    assert.equal(unrefCalled, true);
    assert.equal(launcherOptions.domain, "recommend");
    assert.equal(launcherOptions.runId, started.run_id);
    assert.match(launcherOptions.workerScriptPath, /detached-worker\.js$/);
    assert.equal(launcherOptions.stdoutPath, started.run.resume.worker_stdout_path);
    assert.equal(launcherOptions.stderrPath, started.run.resume.worker_stderr_path);
    assert.equal(launcherOptions.exitStatusPath, started.run.resume.worker_exit_status_path);
    assert.equal(path.isAbsolute(launcherOptions.recommendRuntimeHomePath), true);
    assert.equal(path.isAbsolute(launcherOptions.screenConfigPath), true);
    assert.equal(started.run.context.args.overrides.job, startArgs.overrides.job);

    const workerResult = await runDetachedWorkerForTests({
      runId: started.run_id,
      workerPid: 456789,
      launchId: started.run.resume.worker_launch_id
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
    setRecommendDetachedWorkerLauncherForTests(null);
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

async function testRecommendAmbiguousLauncherFailureCannotReviveRun() {
  const previousDetached = process.env.BOSS_RECOMMEND_CDP_DETACHED;
  const previousInproc = process.env.BOSS_RECOMMEND_CDP_INPROC;
  process.env.BOSS_RECOMMEND_CDP_INPROC = "0";
  process.env.BOSS_RECOMMEND_CDP_DETACHED = "1";
  let workerAttempt = null;
  let capturedRunId = null;
  let workflowCalls = 0;
  setRecommendMcpWorkflowForTests(async () => {
    workflowCalls += 1;
    return { domain: "recommend", processed: 0, screened: 0, passed: 0, results: [] };
  });
  setRecommendDetachedWorkerLauncherForTests((options) => {
    capturedRunId = options.runId;
    workerAttempt = runDetachedWorkerForTests({
      runId: options.runId,
      workerPid: 456792,
      launchId: options.launchId
    });
    const error = new Error("CIM result was lost after process creation");
    error.code = "WINDOWS_CIM_RESULT_INVALID";
    throw error;
  });
  try {
    const failed = await callTool(TOOL_START, readyArgs({
      delay_ms: 0,
      debug_test_mode: true,
      screening_mode: "deterministic",
      no_filter: true,
      detail_limit: 1,
      execute_post_action: false
    }), 333_1);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.error.code, "RUN_WORKER_LAUNCH_FAILED");
    assert.ok(workerAttempt);
    const workerResult = await workerAttempt;
    assert.equal(workerResult.ok, false);
    assert.match(workerResult.error, /already terminal/);
    assert.equal(workflowCalls, 0);
    const persisted = await callTool(TOOL_GET, { run_id: capturedRunId }, 333_2);
    assert.equal(persisted.run.state, "failed");
  } finally {
    setRecommendDetachedWorkerLauncherForTests(null);
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
    assert.equal(spawnCall.args.includes("--domain"), true);
    assert.equal(spawnCall.args.includes("recommend"), true);
    assert.equal(spawnCall.args.includes(started.run_id), true);
    assert.match(spawnCall.args[0], /detached-worker\.js$/);
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
      recent_not_view: "近14天没有",
      current_city_only: true,
      activity_level: "本周活跃"
    }
  }), 8);
  assert.equal(started.status, "ACCEPTED");
  await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(observedFilter.enabled, true);
  assert.equal(observedFilter.currentCityOnly, true);
  assert.deepEqual(observedFilter.filterGroups, [
    {
      group: "activity",
      labels: ["本周活跃"],
      selectAllLabels: false,
      allowUnlimited: true,
      verifySticky: true
    },
    {
      group: "recentNotView",
      labels: ["近14天没有"],
      selectAllLabels: true,
      allowUnlimited: false,
      verifySticky: true
    },
    {
      group: "degree",
      labels: ["本科", "硕士", "博士"],
      selectAllLabels: true,
      allowUnlimited: false,
      verifySticky: true
    }
  ]);
}

async function testRecommendDetachedDiskFallbackPreservesSafeCdpEvidence() {
  const previousDetached = process.env.BOSS_RECOMMEND_CDP_DETACHED;
  const previousInproc = process.env.BOSS_RECOMMEND_CDP_INPROC;
  process.env.BOSS_RECOMMEND_CDP_INPROC = "0";
  process.env.BOSS_RECOMMEND_CDP_DETACHED = "1";
  setSpawnProcessImplForTests(() => ({
    pid: 456791,
    unref() {}
  }));
  const privateMarker = "candidate-private-marker-must-not-persist";
  const methodLog = Array.from({ length: 31 }, (_, index) => ({
    method: index % 2 === 0 ? "DOM.getDocument" : "Input.dispatchMouseEvent",
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    connection_epoch: Math.floor(index / 10),
    replay_of_connection_epoch: index === 30 ? 1 : undefined,
    replay_policy: index % 2 === 0 ? "safe_read_only" : "non_replayable",
    params: {
      candidate_name: privateMarker,
      nodeId: index + 1
    }
  }));
  try {
    setRecommendMcpConnectorForTests(async (options = {}) => ({
      client: { guarded: true },
      target: {
        id: "fake-evidence-target",
        url: `https://www.zhipin.com/web/chat/recommend?candidate=${privateMarker}`,
        type: "page"
      },
      methodLog,
      navigation: {
        navigated: false,
        url: `https://www.zhipin.com/web/chat/recommend?candidate=${privateMarker}`
      },
      chrome: {
        launched: false,
        reused: true,
        port: options.port,
        target_count: 2,
        required_flags_ok: true,
        unsafe_candidate_marker: privateMarker
      },
      health: { status: "healthy" },
      async close() {}
    }));
    setRecommendMcpWorkflowForTests(async (options, runControl) => {
      runControl.setPhase("recommend:detached-evidence-test");
      runControl.updateProgress({
        card_count: 1,
        target_count: options.maxCandidates,
        processed: 1,
        screened: 1,
        passed: 0
      });
      await runControl.sleep(10);
      return {
        domain: "recommend",
        processed: 1,
        screened: 1,
        detail_opened: 0,
        passed: 0,
        results: []
      };
    });

    const started = await callTool(TOOL_START, readyArgs({
      host: "127.0.0.1",
      port: 9778,
      delay_ms: 0,
      debug_test_mode: true,
      screening_mode: "deterministic",
      no_filter: true,
      detail_limit: 1,
      execute_post_action: false
    }), 341);
    assert.equal(started.status, "ACCEPTED");
    const workerResult = await runDetachedWorkerForTests({
      runId: started.run_id,
      workerPid: 456791,
      launchId: started.run.resume.worker_launch_id
    });
    assert.equal(workerResult.ok, true);

    const inMemory = await callTool(TOOL_GET, { run_id: started.run_id }, 342);
    assert.equal(inMemory.run.state, "completed");
    assert.equal(inMemory.method_log_total, 31);
    assert.equal(inMemory.method_log.length, 25);
    assert.equal(inMemory.method_summary["DOM.getDocument"], 16);
    assert.equal(inMemory.method_summary["Input.dispatchMouseEvent"], 15);
    assert.equal(inMemory.runtime_evaluate_used, false);
    assert.equal(inMemory.script_injection_used, false);

    const runStatePath = inMemory.run.artifacts.run_state_path;
    const persistedBeforeReset = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
    assert.equal(persistedBeforeReset.method_log_total, 31);
    assert.equal(persistedBeforeReset.method_log.length, 25);
    assert.equal(JSON.stringify(persistedBeforeReset).includes(privateMarker), false);

    resetRecommendMcpStateForTests();
    const diskPayload = await callTool(TOOL_GET, { run_id: started.run_id }, 343);
    const serialized = JSON.stringify(diskPayload);
    assert.equal(diskPayload.status, "RUN_STATUS");
    assert.equal(diskPayload.persistence.source, "disk");
    assert.equal(diskPayload.persistence.active_control_available, false);
    assert.equal(diskPayload.method_log_total, 31);
    assert.equal(diskPayload.method_log.length, 25);
    assert.equal(diskPayload.method_log[0].at, methodLog[6].at);
    assert.deepEqual(Object.keys(diskPayload.method_log[0]).sort(), [
      "at",
      "connection_epoch",
      "method",
      "replay_policy"
    ]);
    assert.equal(diskPayload.method_log[0].connection_epoch, 0);
    assert.equal(diskPayload.method_log[0].replay_policy, "safe_read_only");
    assert.equal(diskPayload.method_log.at(-1).connection_epoch, 3);
    assert.equal(diskPayload.method_log.at(-1).replay_of_connection_epoch, 1);
    assert.equal(diskPayload.method_log.at(-1).replay_policy, "safe_read_only");
    assert.equal(diskPayload.method_summary["DOM.getDocument"], 16);
    assert.equal(diskPayload.method_summary["Input.dispatchMouseEvent"], 15);
    assert.equal(diskPayload.runtime_evaluate_used, false);
    assert.equal(diskPayload.script_injection_used, false);
    assert.equal(diskPayload.chrome.host, "127.0.0.1");
    assert.equal(diskPayload.chrome.port, 9778);
    assert.equal(diskPayload.chrome.target_id, "fake-evidence-target");
    assert.equal(diskPayload.chrome.target_url, "https://www.zhipin.com/web/chat/recommend");
    assert.equal(diskPayload.chrome.auto_launch.reused, true);
    assert.equal(diskPayload.chrome.auto_launch.target_count, 2);
    assert.equal(diskPayload.method_log.some((entry) => Object.hasOwn(entry, "params")), false);
    assert.equal(serialized.includes(privateMarker), false);
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

async function testRecommendFilterBypassDisablesDeterministicResets() {
  const noFilterOptions = await observeRecommendWorkflowOptions(readyArgs({
    no_filter: true,
    debug_test_mode: true
  }), 8_1);
  assert.equal(noFilterOptions.filter.enabled, false);
  assert.deepEqual(noFilterOptions.filter.filterGroups, []);

  const disabledOptions = await observeRecommendWorkflowOptions(readyArgs({
    no_filter: false,
    filter_enabled: false,
    debug_test_mode: true
  }), 8_2);
  assert.equal(disabledOptions.filter.enabled, false);
  assert.deepEqual(disabledOptions.filter.filterGroups, []);
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

  const base = readyArgs();
  const started = await callTool(TOOL_START, readyArgs({
    delay_ms: 0,
    overrides: {
      ...base.overrides,
      current_city_only: true,
      activity_level: "本月活跃"
    }
  }), 121);
  assert.equal(started.status, "ACCEPTED");
  assert.equal(started.run.context.overrides.current_city_only, true);
  assert.equal(started.run.context.overrides.activity_level, "本月活跃");
  const completed = await waitForRecommendRun(started.run_id, (run) => run?.status === "completed");
  assert.equal(completed.result.search_params.current_city_only, true);
  assert.equal(completed.result.search_params.activity_level, "本月活跃");
  assert.equal(path.dirname(completed.result.output_csv), outputDir);
  assert.equal(path.dirname(completed.result.report_json), outputDir);
  assert.equal(fs.existsSync(completed.result.output_csv), true);
  assert.equal(fs.existsSync(completed.result.report_json), true);
  const csv = fs.readFileSync(completed.result.output_csv, "utf8");
  assert.equal(csv.includes('"user_search_params.current_city_only","true"'), true);
  assert.equal(csv.includes('"user_search_params.activity_level","本月活跃"'), true);
}

async function main() {
  testRecommendStatusPreservesWorkflowCompletionSemantics();
  testExplicitHumanRestLevelAliasOverridesConfigDefault();
  testRecommendTerminalCleanupPreservesUnpersistedPostActionDetail();
  testRecommendConnectorRefreshesBeforeExactEmptyBootstrap();
  testRecommendConnectorAcceptsHealthyAfterEmptyBootstrapRefresh();
  testRecommendConnectorAcceptsExactEmptyAfterBootstrapRefresh();
  testRecommendConnectorRejectsUnverifiedEmptyBootstrap();
  testRecommendConnectorRejectsAdditionalRequiredFailure();
  await testRecommendActionJournalScopeCanonicalizesLoopbackAndBindsProfile();
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
    testMainModulePathAcceptsWindowsJunction(tempHome);
    await testMcpToolsetFilteringKeepsRecommendSmallAndFirst();
    await testRecommendDebugBoundaryInputGate();
    await testToolListIncludesRecommendTools();
    resetRecommendMcpStateForTests();
    await testRecommendJobListTool();
    resetRecommendMcpStateForTests();
    await testRecommendDefaultsUseScreeningConfig();
    await testRecommendGateBeforeBrowserConnect();
    resetRecommendMcpStateForTests();
    await testRecommendPrepareGateBeforeBrowserConnect();
    resetRecommendMcpStateForTests();
    await testRecommendToolsRejectChatOnlyMisrouteBeforeBrowserConnect();
    resetRecommendMcpStateForTests();
    await testRecommendToolsRejectSearchMisrouteBeforeBrowserConnect();
    resetRecommendMcpStateForTests();
    await testRecommendJobListRejectsExplicitChatTarget();
    resetRecommendMcpStateForTests();
    await testRecommendPrepareReadyDoesNotStartRun();
    resetRecommendMcpStateForTests();
    await testRecommendActivityIntentNormalizesWithoutBrowserConnect();
    resetRecommendMcpStateForTests();
    await testRecommendPreparedCronPayloadStartsAccepted();
    resetRecommendMcpStateForTests();
    await testRecommendJobListLoginRequiredBlocksCronSetup();
    resetRecommendMcpStateForTests();
    await testRecommendPreparePreservesCriteriaVerbatim();
    resetRecommendMcpStateForTests();
    await testRecommendFullySpecifiedPayloadAsksSkipRecentColleagueContacted();
    resetRecommendMcpStateForTests();
    await testRecommendOptionalFiltersUseOnlyFinalReviewGate();
    resetRecommendMcpStateForTests();
    await testRecommendGreetWithoutMaxGreetCountIsReady();
    resetRecommendMcpStateForTests();
    await testRecommendFinalConfirmedPayloadStartsAccepted();
    resetRecommendMcpStateForTests();
    await testRunRecommendAliasStartsAccepted();
    resetRecommendMcpStateForTests();
    await testRecommendScheduleFinalConfirmedPayloadUsesPackageScheduler();
    resetRecommendMcpStateForTests();
    await testRecommendMissingRestLevelBlocksWithRestQuestion();
    resetRecommendMcpStateForTests();
    await testRecommendMissingJobStillBlocksBeforeFinalReview();
    resetRecommendMcpStateForTests();
    await testRecommendScheduleIncompletePayloadDoesNotSpawn();
    resetRecommendMcpStateForTests();
    await testRecommendScheduleRejectsDiagnosticOptionsBeforePersistOrSpawn();
    resetRecommendMcpStateForTests();
    await testRecommendScheduleReadyPayloadUsesPackageOwnedWorker();
    resetRecommendMcpStateForTests();
    await testRecommendScheduleWorkerStartsSavedPayload();
    resetRecommendMcpStateForTests();
    await testRecommendScheduleStatusCompactsPersistedInlineRun();
    resetRecommendMcpStateForTests();
    await testRecommendDetailLimitDefaultsToTargetCount();
    resetRecommendMcpStateForTests();
    await testRecommendDetailLimitZeroRequiresDebugFlag();
    resetRecommendMcpStateForTests();
    await testRecommendDebugBoundaryOptionsReachWorkflow();
    resetRecommendMcpStateForTests();
    await testRecommendLoadsLlmConfigByDefault();
    resetRecommendMcpStateForTests();
    await testRecommendHumanBehaviorArgsOverrideConfig();
    resetRecommendMcpStateForTests();
    await testRecommendAsyncPauseResumeCancel();
    resetRecommendMcpStateForTests();
    await testRecommendActiveRunPersistsProgressToDisk();
    resetRecommendMcpStateForTests();
    await testRecommendStaleDiagnosticsSurviveStatusAndDiskCompaction();
    resetRecommendMcpStateForTests();
    await testRecommendDiskRunningRunWithDeadPidIsReconciled();
    resetRecommendMcpStateForTests();
    await testRecommendDeadPidUsesMatchingSupervisorExitSidecar();
    resetRecommendMcpStateForTests();
    await testRecommendDiskCancelRequestedDeadPidIsReconciledAsCanceled();
    resetRecommendMcpStateForTests();
    await testRecommendListRunsReturnsCompactLatest();
    resetRecommendMcpStateForTests();
    await testRecommendCompletedStatusOmitsInlineResults();
    resetRecommendMcpStateForTests();
    await testRecommendOptionalArtifactFailuresDoNotBlockTerminalState();
    resetRecommendMcpStateForTests();
    await testRecommendSupervisorExitRecorderMarksFailureImmediately();
    resetRecommendMcpStateForTests();
    await testRecommendDetachedCancelSocketFailureFinalizesCanceled();
    resetRecommendMcpStateForTests();
    await testRecommendDetachedStartUsesWorkerProcess();
    resetRecommendMcpStateForTests();
    await testRecommendAmbiguousLauncherFailureCannotReviveRun();
    resetRecommendMcpStateForTests();
    await testRecommendDetachedDiskFallbackPreservesSafeCdpEvidence();
    resetRecommendMcpStateForTests();
    await testRecommendOpenClawWorkspaceForcesDetachedWorker();
    resetRecommendMcpStateForTests();
    await testRecommendFailedRunIncludesConstrainedRecoveryGuidance();
    resetRecommendMcpStateForTests();
    await testRecommendMultiSelectFilterMapping();
    resetRecommendMcpStateForTests();
    await testRecommendFilterBypassDisablesDeterministicResets();
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
