import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

import {
  cancelBossChatRun,
  getBossChatHealthCheck,
  getBossChatRun,
  pauseBossChatRun,
  prepareBossChatRun,
  resumeBossChatRun,
  startBossChatRun
} from "./boss-chat.js";
import { __testables as cliTestables } from "./cli.js";
import { __testables as indexTestables } from "./index.js";
import { BossChatApp } from "../vendor/boss-chat-cli/src/app.js";
import { __testables as vendorCliTestables } from "../vendor/boss-chat-cli/src/cli.js";
import { BossChatPage } from "../vendor/boss-chat-cli/src/browser/chat-page.js";
import { LlmClient, parseLlmJson } from "../vendor/boss-chat-cli/src/services/llm.js";

const { handleRequest } = indexTestables;

const TOOL_BOSS_CHAT_HEALTH_CHECK = "boss_chat_health_check";
const TOOL_BOSS_CHAT_PREPARE_RUN = "prepare_boss_chat_run";
const TOOL_BOSS_CHAT_START_RUN = "start_boss_chat_run";
const TOOL_BOSS_CHAT_GET_RUN = "get_boss_chat_run";
const TOOL_BOSS_CHAT_PAUSE_RUN = "pause_boss_chat_run";
const TOOL_BOSS_CHAT_RESUME_RUN = "resume_boss_chat_run";
const TOOL_BOSS_CHAT_CANCEL_RUN = "cancel_boss_chat_run";

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

async function callTool(workspaceRoot, name, args = {}, id = 1) {
  const response = await handleRequest(makeToolCall(id, name, args), workspaceRoot);
  return response?.result?.structuredContent;
}

function createBossChatTestWorkspace() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-boss-chat-"));
  const configDir = path.join(workspaceRoot, "config");
  const cliDir = path.join(workspaceRoot, "boss-chat-cli", "src");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });

  fs.writeFileSync(path.join(configDir, "screening-config.json"), JSON.stringify({
    baseUrl: "https://api.example.com/v1",
    apiKey: "sk-test-key",
    model: "gpt-4.1-mini",
    debugPort: 9666
  }, null, 2));

  fs.writeFileSync(path.join(cliDir, "cli.js"), [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const cwd = process.cwd();",
    "const statePath = path.join(cwd, '.boss-chat', 'stub-state.json');",
    "fs.mkdirSync(path.dirname(statePath), { recursive: true });",
    "const raw = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '{}';",
    "const state = JSON.parse(raw || '{}');",
    "state.counter = Number.isInteger(state.counter) ? state.counter : 0;",
    "state.prepare_calls = Number.isInteger(state.prepare_calls) ? state.prepare_calls : 0;",
    "if (!Number.isInteger(state.prepare_fail_budget)) {",
    "  const configured = Number.parseInt(process.env.BOSS_CHAT_STUB_PREPARE_FAILS || '0', 10);",
    "  state.prepare_fail_budget = Number.isFinite(configured) && configured > 0 ? configured : 0;",
    "}",
    "state.runs = state.runs && typeof state.runs === 'object' ? state.runs : {};",
    "state.get_calls = state.get_calls && typeof state.get_calls === 'object' ? state.get_calls : {};",
    "const argv = process.argv.slice(2);",
    "const command = String(argv[0] || '').trim();",
    "const options = {};",
    "for (let index = 1; index < argv.length; index += 1) {",
    "  const token = String(argv[index] || '');",
    "  if (!token.startsWith('--')) continue;",
    "  const key = token.slice(2);",
    "  const next = argv[index + 1];",
    "  if (next && !String(next).startsWith('--')) {",
    "    options[key] = String(next);",
    "    index += 1;",
    "  } else {",
    "    options[key] = true;",
    "  }",
    "}",
    "function saveAndPrint(payload) {",
    "  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));",
    "  process.stdout.write(`${JSON.stringify(payload)}\\n`);",
    "}",
    "if (command === 'prepare-run') {",
    "  state.prepare_calls += 1;",
    "  if (state.prepare_fail_budget > 0) {",
    "    state.prepare_fail_budget -= 1;",
    "    saveAndPrint({ status: 'FAILED', error: { code: 'CHAT_PAGE_NOT_READY', message: 'chat page is still loading' } });",
    "    process.exit(1);",
    "  }",
    "  state.last_prepare_args = options;",
    "  saveAndPrint({",
    "    status: 'NEED_INPUT',",
    "    stage: 'chat_run_setup',",
    "    page_url: 'https://www.zhipin.com/web/chat/index',",
    "    required_fields: ['job', 'start_from', 'target_count', 'criteria'],",
    "    job_options: [",
    "      { index: 1, label: '算法工程师', value: '算法工程师', active: true },",
    "      { index: 2, label: '大模型算法', value: '大模型算法', active: false }",
    "    ],",
    "    pending_questions: [",
    "      { field: 'job', question: '请选择岗位（必须从岗位列表中选择）', required: true },",
    "      { field: 'start_from', question: '请选择起始范围', required: true },",
    "      { field: 'target_count', question: '请输入目标数量（正整数）', required: true },",
    "      { field: 'criteria', question: '请输入筛选标准（自然语言）', required: true }",
    "    ],",
    "    message: 'prepared'",
    "  });",
    "  process.exit(0);",
    "}",
    "if (command === 'start-run') {",
    "  state.counter += 1;",
    "  const runId = `chat-${state.counter}`;",
    "  state.last_start_args = options;",
    "  state.runs[runId] = { state: 'queued' };",
    "  state.get_calls[runId] = 0;",
    "  saveAndPrint({ status: 'ACCEPTED', run_id: runId, message: 'chat started' });",
    "  process.exit(0);",
    "}",
    "const runId = String(options['run-id'] || '');",
    "const current = state.runs[runId] || { state: 'queued' };",
    "if (command === 'get-run') {",
    "  state.get_calls[runId] = (state.get_calls[runId] || 0) + 1;",
    "  if (!['paused', 'canceled'].includes(current.state)) {",
    "    current.state = state.get_calls[runId] >= 2 ? 'completed' : 'running';",
    "  }",
    "  state.runs[runId] = current;",
    "  saveAndPrint({",
    "    status: 'RUN_STATUS',",
    "    run: {",
    "      runId,",
    "      state: current.state,",
    "      lastMessage: `state=${current.state}`,",
    "      progress: { inspected: state.get_calls[runId], passed: current.state === 'completed' ? 1 : 0, requested: current.state === 'completed' ? 1 : 0, skipped: 0, errors: 0 },",
    "      result: current.state === 'completed' ? { requested_count: 1 } : null",
    "    }",
    "  });",
    "  process.exit(0);",
    "}",
    "if (command === 'pause-run') {",
    "  current.state = 'paused';",
    "  state.runs[runId] = current;",
    "  saveAndPrint({ status: 'PAUSE_REQUESTED', run: { runId, state: 'paused' } });",
    "  process.exit(0);",
    "}",
    "if (command === 'resume-run') {",
    "  current.state = 'running';",
    "  state.runs[runId] = current;",
    "  saveAndPrint({ status: 'RESUME_REQUESTED', run: { runId, state: 'running' } });",
    "  process.exit(0);",
    "}",
    "if (command === 'cancel-run') {",
    "  current.state = 'canceled';",
    "  state.runs[runId] = current;",
    "  saveAndPrint({ status: 'CANCEL_REQUESTED', run: { runId, state: 'canceled' } });",
    "  process.exit(0);",
    "}",
    "saveAndPrint({ status: 'FAILED', error: { code: 'UNKNOWN_COMMAND', message: command || 'missing command' } });",
    "process.exit(1);"
  ].join("\n"), "utf8");

  return workspaceRoot;
}

function readStubState(workspaceRoot) {
  const statePath = path.join(workspaceRoot, ".boss-chat", "stub-state.json");
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

async function withBossChatWorkspace(testFn) {
  const workspaceRoot = createBossChatTestWorkspace();
  const previousScreenConfig = process.env.BOSS_RECOMMEND_SCREEN_CONFIG;
  process.env.BOSS_RECOMMEND_SCREEN_CONFIG = path.join(workspaceRoot, "config", "screening-config.json");
  try {
    await testFn(workspaceRoot);
  } finally {
    if (previousScreenConfig === undefined) {
      delete process.env.BOSS_RECOMMEND_SCREEN_CONFIG;
    } else {
      process.env.BOSS_RECOMMEND_SCREEN_CONFIG = previousScreenConfig;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function captureConsoleLogs(fn) {
  const messages = [];
  const originalLog = console.log;
  console.log = (...args) => {
    messages.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return messages;
}

async function testBossChatAdapterShouldResolveSharedConfigAndInvokeLocalCli() {
  await withBossChatWorkspace(async (workspaceRoot) => {
    const health = getBossChatHealthCheck(workspaceRoot);
    assert.equal(health.status, "OK");
    assert.equal(health.shared_llm_config, true);
    assert.equal(health.debug_port, 9666);

    const prepared = await prepareBossChatRun({
      workspaceRoot,
      input: {}
    });
    assert.equal(prepared.status, "NEED_INPUT");
    assert.deepEqual(prepared.missing_fields, ["job", "start_from", "target_count", "criteria"]);
    const preparedTargetQuestion = prepared.pending_questions.find((item) => item.field === "target_count");
    assert.equal(preparedTargetQuestion.argument_name, "target_count");
    assert.equal(preparedTargetQuestion.recommended_value, "all");
    assert.equal(preparedTargetQuestion.recommended_argument_patch.target_count, "all");
    assert.equal(preparedTargetQuestion.options.some((item) => item.label.includes('target_count="all"')), true);
    assert.equal(prepared.next_call_example.target_count, "all");

    const preflight = await startBossChatRun({
      workspaceRoot,
      input: {}
    });
    assert.equal(preflight.status, "NEED_INPUT");
    assert.deepEqual(preflight.required_fields, ["job", "start_from", "target_count", "criteria"]);
    assert.equal(Array.isArray(preflight.job_options), true);
    assert.equal(preflight.job_options.length, 2);
    assert.equal(Array.isArray(preflight.pending_questions), true);
    const preflightTargetQuestion = preflight.pending_questions.find((item) => item.field === "target_count");
    assert.equal(Boolean(preflightTargetQuestion), true);
    assert.equal(preflightTargetQuestion.argument_name, "target_count");
    assert.equal(preflightTargetQuestion.recommended_argument_patch.target_count, "all");
    assert.equal(Array.isArray(preflightTargetQuestion.options), true);

    const stateAfterPrepare = readStubState(workspaceRoot);
    assert.equal(stateAfterPrepare.last_prepare_args.profile, "default");
    assert.equal(stateAfterPrepare.last_prepare_args.port, "9666");
    assert.equal(stateAfterPrepare.last_prepare_args.baseurl, "https://api.example.com/v1");
    assert.equal(stateAfterPrepare.last_prepare_args.apikey, "sk-test-key");
    assert.equal(stateAfterPrepare.last_prepare_args.model, "gpt-4.1-mini");

    const started = await startBossChatRun({
      workspaceRoot,
      input: {
        profile: "default",
        job: "算法工程师",
        start_from: "unread",
        criteria: "有 AI Agent 经验",
        target_count: 2
      }
    });
    assert.equal(started.status, "ACCEPTED");
    assert.equal(Boolean(started.run_id), true);

    const stateAfterStart = readStubState(workspaceRoot);
    assert.equal(stateAfterStart.last_start_args.profile, "default");
    assert.equal(stateAfterStart.last_start_args.job, "算法工程师");
    assert.equal(stateAfterStart.last_start_args["start-from"], "unread");
    assert.equal(stateAfterStart.last_start_args.criteria, "有 AI Agent 经验");
    assert.equal(stateAfterStart.last_start_args.targetCount, "2");
    assert.equal(stateAfterStart.last_start_args.baseurl, "https://api.example.com/v1");
    assert.equal(stateAfterStart.last_start_args.apikey, "sk-test-key");
    assert.equal(stateAfterStart.last_start_args.model, "gpt-4.1-mini");
    assert.equal(stateAfterStart.last_start_args.port, "9666");

    const startedAll = await startBossChatRun({
      workspaceRoot,
      input: {
        profile: "default",
        job: "算法工程师",
        start_from: "all",
        criteria: "全部候选人都过一遍",
        target_count: "全部候选人"
      }
    });
    assert.equal(startedAll.status, "ACCEPTED");
    const stateAfterStartAll = readStubState(workspaceRoot);
    assert.equal(stateAfterStartAll.last_start_args.targetCount, "-1");

    for (const target_count of ["all", -1, "-1", { value: "all" }, "all（扫到底）"]) {
      const startedVariant = await startBossChatRun({
        workspaceRoot,
        input: {
          profile: "default",
          job: "算法工程师",
          start_from: "all",
          criteria: "全部候选人都过一遍",
          target_count
        }
      });
      assert.equal(startedVariant.status, "ACCEPTED");
      assert.equal(readStubState(workspaceRoot).last_start_args.targetCount, "-1");
    }

    const startedCamelCase = await startBossChatRun({
      workspaceRoot,
      input: {
        profile: "default",
        job: "算法工程师",
        start_from: "all",
        criteria: "全部候选人都过一遍",
        targetCount: { targetCount: "all" }
      }
    });
    assert.equal(startedCamelCase.status, "ACCEPTED");
    assert.equal(readStubState(workspaceRoot).last_start_args.targetCount, "-1");

    const invalidTarget = await startBossChatRun({
      workspaceRoot,
      input: {
        profile: "default",
        job: "算法工程师",
        start_from: "all",
        criteria: "全部候选人都过一遍",
        target_count: "not a target"
      }
    });
    assert.equal(invalidTarget.status, "NEED_INPUT");
    assert.deepEqual(invalidTarget.missing_fields, ["target_count"]);
    assert.equal(invalidTarget.received_target_count, "not a target");
    assert.equal(Boolean(invalidTarget.target_count_parse_error), true);
    assert.equal(invalidTarget.next_call_example.target_count, "all");
    assert.equal(invalidTarget.accepted_examples.includes("all"), true);
    assert.equal(invalidTarget.recommended_argument_patch.target_count, "all");

    const running = await getBossChatRun({
      workspaceRoot,
      input: {
        profile: "default",
        run_id: started.run_id
      }
    });
    assert.equal(running.run.state, "running");

    const paused = await pauseBossChatRun({
      workspaceRoot,
      input: {
        profile: "default",
        run_id: started.run_id
      }
    });
    assert.equal(paused.run.state, "paused");

    const resumed = await resumeBossChatRun({
      workspaceRoot,
      input: {
        profile: "default",
        run_id: started.run_id
      }
    });
    assert.equal(resumed.run.state, "running");

    const canceled = await cancelBossChatRun({
      workspaceRoot,
      input: {
        profile: "default",
        run_id: started.run_id
      }
    });
    assert.equal(canceled.run.state, "canceled");
  });
}

async function testBossChatPrepareShouldRetryWhenChatPageIsNotReady() {
  await withBossChatWorkspace(async (workspaceRoot) => {
    const previousPrepareFails = process.env.BOSS_CHAT_STUB_PREPARE_FAILS;
    process.env.BOSS_CHAT_STUB_PREPARE_FAILS = "2";
    try {
      const prepared = await prepareBossChatRun({
        workspaceRoot,
        input: {}
      });
      assert.equal(prepared.status, "NEED_INPUT");
      const state = readStubState(workspaceRoot);
      assert.equal(state.prepare_calls, 3);
      assert.equal(state.prepare_fail_budget, 0);
    } finally {
      if (previousPrepareFails === undefined) {
        delete process.env.BOSS_CHAT_STUB_PREPARE_FAILS;
      } else {
        process.env.BOSS_CHAT_STUB_PREPARE_FAILS = previousPrepareFails;
      }
    }
  });
}

async function testBossChatPageShouldTreatBlankChatShellAsOnChatPage() {
  const fakeChromeClient = {
    async callFunction() {
      return {
        href: "https://www.zhipin.com/web/chat/index",
        readyState: "complete",
        hasListContainer: false,
        listItemCount: 0
      };
    }
  };

  const page = new BossChatPage(fakeChromeClient);
  const pageState = await page.ensureOnChatPage();
  assert.equal(pageState.href, "https://www.zhipin.com/web/chat/index");

  await assert.rejects(
    () => page.ensureReady(),
    /CHAT_LIST_CONTAINER_NOT_FOUND/
  );
}

async function testBossChatRecoverToChatIndexShouldForceNavigateAndWaitForCompleteLoad() {
  const calls = [];
  let stateIndex = 0;
  const states = [
    {
      href: "https://www.zhipin.com/web/chat/index",
      readyState: "loading",
      hasListContainer: false,
      listItemCount: 0
    },
    {
      href: "https://www.zhipin.com/web/chat/index",
      readyState: "interactive",
      hasListContainer: false,
      listItemCount: 0
    },
    {
      href: "https://www.zhipin.com/web/chat/index",
      readyState: "complete",
      hasListContainer: false,
      listItemCount: 0
    }
  ];

  const fakeChromeClient = {
    async callFunction(fn, arg) {
      calls.push({ name: fn.name, arg });
      if (fn.name === "browserGetCurrentHref") {
        return { href: "https://www.zhipin.com/web/chat/index" };
      }
      if (fn.name === "browserNavigateToChatIndex") {
        return { ok: true, changed: true, href: "https://www.zhipin.com/web/chat/index" };
      }
      if (fn.name === "browserGetPageState") {
        const value = states[Math.min(stateIndex, states.length - 1)];
        stateIndex += 1;
        return value;
      }
      throw new Error(`unexpected function: ${fn.name}`);
    }
  };

  const page = new BossChatPage(fakeChromeClient);
  const result = await page.recoverToChatIndex({
    forceNavigate: true,
    waitForReadyState: "complete",
    maxAttempts: 5,
    delayMs: 0
  });

  assert.equal(result.changed, true);
  assert.equal(result.href, "https://www.zhipin.com/web/chat/index");
  assert.equal(
    calls.some((entry) => entry.name === "browserNavigateToChatIndex" && entry.arg?.force === true),
    true
  );
  assert.equal(
    calls.filter((entry) => entry.name === "browserGetPageState").length >= 3,
    true
  );
}

async function testBossChatPageShouldFallbackToEscapeWhenClosingCandidateDetail() {
  const calls = [];
  const mouseEvents = [];
  let stateIndex = 0;
  const states = [
    {
      open: true,
      panelCount: 1,
      closeCount: 1,
      topPanelClass: "base-info-single-top-detail",
      topPanelScore: 520,
      panelRect: {
        left: 940,
        top: 60,
        width: 360,
        height: 720,
        right: 1300,
        bottom: 780
      },
      closeRect: {
        left: 1274,
        top: 12,
        width: 30,
        height: 30,
        right: 1304,
        bottom: 42
      }
    },
    {
      open: true,
      panelCount: 1,
      closeCount: 1,
      topPanelClass: "base-info-single-top-detail",
      topPanelScore: 520,
      panelRect: {
        left: 940,
        top: 60,
        width: 360,
        height: 720,
        right: 1300,
        bottom: 780
      },
      closeRect: {
        left: 1274,
        top: 12,
        width: 30,
        height: 30,
        right: 1304,
        bottom: 42
      }
    },
    {
      open: false,
      panelCount: 0,
      closeCount: 0,
      topPanelClass: "",
      topPanelScore: 0,
      panelRect: null,
      closeRect: null
    }
  ];

  const fakeChromeClient = {
    Input: {
      async dispatchMouseEvent(payload) {
        mouseEvents.push(payload);
      }
    },
    async pressEscape() {
      calls.push("pressEscape");
    },
    async callFunction(fn) {
      calls.push(fn.name);
      if (fn.name === "browserIsCandidateDetailOpen") {
        const value = states[Math.min(stateIndex, states.length - 1)];
        stateIndex += 1;
        return value;
      }
      if (fn.name === "browserCloseCandidateDetailDomOnce") {
        return {
          ok: true,
          selector: ".close-btn",
          method: "dom-click-once"
        };
      }
      throw new Error(`unexpected function: ${fn.name}`);
    }
  };

  const page = new BossChatPage(fakeChromeClient);
  const result = await page.closeCandidateDetail({
    maxAttempts: 1,
    ensureDismiss: true
  });

  assert.equal(result.closed, true);
  assert.equal(calls.includes("pressEscape"), true);
  assert.equal(mouseEvents.length > 0, true);
}

async function testBossChatMcpToolsShouldValidateAndRoute() {
  await withBossChatWorkspace(async (workspaceRoot) => {
    const toolsResponse = await handleRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
      params: {}
    }, workspaceRoot);
    const tools = toolsResponse.result.tools;
    const prepareToolSchema = tools.find((item) => item.name === TOOL_BOSS_CHAT_PREPARE_RUN).inputSchema;
    const startToolSchema = tools.find((item) => item.name === TOOL_BOSS_CHAT_START_RUN).inputSchema;
    assert.equal(prepareToolSchema.required, undefined);
    assert.deepEqual(startToolSchema.required, ["job", "start_from", "criteria"]);
    assert.equal(startToolSchema.anyOf.some((item) => item.required?.includes("target_count")), true);
    assert.equal(startToolSchema.anyOf.some((item) => item.required?.includes("targetCount")), true);
    assert.equal(startToolSchema.properties.target_count.examples.includes("all"), true);
    assert.equal(startToolSchema.examples.some((item) => item.target_count === "all"), true);

    const prepared = await callTool(workspaceRoot, TOOL_BOSS_CHAT_PREPARE_RUN, {}, 101);
    assert.equal(prepared.status, "NEED_INPUT");
    assert.deepEqual(prepared.missing_fields, ["job", "start_from", "target_count", "criteria"]);
    const preparedTargetCountQuestion = prepared.pending_questions.find((item) => item.field === "target_count");
    assert.equal(preparedTargetCountQuestion.argument_name, "target_count");
    assert.equal(preparedTargetCountQuestion.recommended_argument_patch.target_count, "all");

    const needInput = await callTool(workspaceRoot, TOOL_BOSS_CHAT_START_RUN, {}, 11);
    assert.equal(needInput.status, "NEED_INPUT");
    assert.deepEqual(needInput.required_fields, ["job", "start_from", "target_count", "criteria"]);
    assert.equal(Array.isArray(needInput.job_options), true);
    assert.equal(needInput.job_options.length, 2);
    const targetQuestion = needInput.pending_questions.find((item) => item.field === "target_count");
    assert.equal(Boolean(targetQuestion), true);
    assert.equal(targetQuestion.argument_name, "target_count");
    assert.equal(targetQuestion.recommended_argument_patch.target_count, "all");
    assert.equal(targetQuestion.options.some((item) => item.value === "all"), true);
    assert.equal(targetQuestion.options.some((item) => item.label.includes('target_count="all"')), true);

    const missingTargetOnly = await callTool(workspaceRoot, TOOL_BOSS_CHAT_START_RUN, {
      job: "算法工程师",
      start_from: "all",
      criteria: "全部候选人都过一遍"
    }, 111);
    assert.equal(missingTargetOnly.status, "NEED_INPUT");
    assert.deepEqual(missingTargetOnly.missing_fields, ["target_count"]);
    assert.equal(missingTargetOnly.next_call_example.target_count, "all");
    assert.equal(missingTargetOnly.accepted_examples.includes(-1), true);

    const invalidTargetOnly = await callTool(workspaceRoot, TOOL_BOSS_CHAT_START_RUN, {
      job: "算法工程师",
      start_from: "all",
      criteria: "全部候选人都过一遍",
      target_count: "not a target"
    }, 112);
    assert.equal(invalidTargetOnly.status, "NEED_INPUT");
    assert.deepEqual(invalidTargetOnly.missing_fields, ["target_count"]);
    assert.equal(invalidTargetOnly.received_target_count, "not a target");
    assert.equal(Boolean(invalidTargetOnly.target_count_parse_error), true);
    assert.equal(invalidTargetOnly.next_call_example.target_count, "all");
    assert.equal(invalidTargetOnly.recommended_argument_patch.target_count, "all");

    const invalidStartResponse = await handleRequest(
      makeToolCall(11, TOOL_BOSS_CHAT_START_RUN, {
        start_from: "invalid-value"
      }),
      workspaceRoot
    );
    assert.equal(invalidStartResponse.error.code, -32602);

    const invalidGetResponse = await handleRequest(
      makeToolCall(12, TOOL_BOSS_CHAT_GET_RUN, {}),
      workspaceRoot
    );
    assert.equal(invalidGetResponse.error.code, -32602);

    const health = await callTool(workspaceRoot, TOOL_BOSS_CHAT_HEALTH_CHECK, {}, 13);
    assert.equal(health.status, "OK");

    const started = await callTool(workspaceRoot, TOOL_BOSS_CHAT_START_RUN, {
      job: "算法工程师",
      start_from: "unread",
      criteria: "有 AI Agent 经验",
      target_count: 2
    }, 14);
    assert.equal(started.status, "ACCEPTED");

    const startedAll = await callTool(workspaceRoot, TOOL_BOSS_CHAT_START_RUN, {
      job: "算法工程师",
      start_from: "all",
      criteria: "全部候选人都过一遍",
      target_count: "全部候选人"
    }, 140);
    assert.equal(startedAll.status, "ACCEPTED");
    const stateAfterStartAll = readStubState(workspaceRoot);
    assert.equal(stateAfterStartAll.last_start_args.targetCount, "-1");

    const startedCamelCase = await callTool(workspaceRoot, TOOL_BOSS_CHAT_START_RUN, {
      job: "算法工程师",
      start_from: "all",
      criteria: "全部候选人都过一遍",
      targetCount: "all"
    }, 141);
    assert.equal(startedCamelCase.status, "ACCEPTED");
    assert.equal(readStubState(workspaceRoot).last_start_args.targetCount, "-1");

    const running = await callTool(workspaceRoot, TOOL_BOSS_CHAT_GET_RUN, {
      run_id: started.run_id,
      profile: "default"
    }, 15);
    assert.equal(running.run.state, "running");

    const paused = await callTool(workspaceRoot, TOOL_BOSS_CHAT_PAUSE_RUN, {
      run_id: started.run_id,
      profile: "default"
    }, 16);
    assert.equal(paused.run.state, "paused");

    const resumed = await callTool(workspaceRoot, TOOL_BOSS_CHAT_RESUME_RUN, {
      run_id: started.run_id,
      profile: "default"
    }, 17);
    assert.equal(resumed.run.state, "running");

    const canceled = await callTool(workspaceRoot, TOOL_BOSS_CHAT_CANCEL_RUN, {
      run_id: started.run_id,
      profile: "default"
    }, 18);
    assert.equal(canceled.run.state, "canceled");
  });
}

async function testBossChatCliShouldSupportRunAndFollowUpParsing() {
  const followUpJson = cliTestables.getRunFollowUp({
    "follow-up-json": JSON.stringify({
      chat: {
        criteria: "有 AI Agent 经验",
        start_from: "unread",
        target_count: 2
      }
    })
  });
  assert.equal(followUpJson.chat.criteria, "有 AI Agent 经验");
  assert.equal(followUpJson.chat.target_count, 2);

  const tempFile = path.join(os.tmpdir(), `boss-recommend-follow-up-${Date.now()}.json`);
  fs.writeFileSync(tempFile, JSON.stringify({
    chat: {
      criteria: "熟悉 MCP",
      start_from: "all",
      target_count: 3
    }
  }, null, 2));
  try {
    const followUpFile = cliTestables.getRunFollowUp({
      "follow-up-file": tempFile
    });
    assert.equal(followUpFile.chat.criteria, "熟悉 MCP");
    assert.equal(followUpFile.chat.start_from, "all");
  } finally {
    fs.rmSync(tempFile, { force: true });
  }

  await withBossChatWorkspace(async (workspaceRoot) => {
    const prepareLogs = await captureConsoleLogs(async () => {
      await cliTestables.runBossChatCliCommand("prepare-run", {
        "workspace-root": workspaceRoot
      });
    });
    const prepared = JSON.parse(prepareLogs[0]);
    assert.equal(prepared.status, "NEED_INPUT");
    assert.equal(prepared.pending_questions.find((item) => item.field === "target_count").argument_name, "target_count");

    const logs = await captureConsoleLogs(async () => {
      await cliTestables.runBossChatCliCommand("run", {
        "workspace-root": workspaceRoot,
        job: "算法工程师",
        "start-from": "unread",
        criteria: "有 AI Agent 经验",
        targetCount: "2"
      });
    });
    assert.equal(logs.length > 0, true);
    const payload = JSON.parse(logs[0]);
    assert.equal(payload.status, "ACCEPTED");
    assert.equal(typeof payload.run_id, "string");
    const state = readStubState(workspaceRoot);
    assert.equal(state.get_calls[payload.run_id] || 0, 0);

    await captureConsoleLogs(async () => {
      await cliTestables.runBossChatCliCommand("run", {
        "workspace-root": workspaceRoot,
        job: "算法工程师",
        "start-from": "all",
        criteria: "全部候选人都过一遍",
        targetCount: "全部候选人"
      });
    });
    const allState = readStubState(workspaceRoot);
    assert.equal(allState.last_start_args.targetCount, "-1");
  });
}

async function testVendorBossChatCliShouldWaitForHydratedChatShell() {
  const pageStates = [
    { href: "https://www.zhipin.com/web/chat/index", hasListContainer: false, listItemCount: 0 },
    { href: "https://www.zhipin.com/web/chat/index", hasListContainer: false, listItemCount: 0 },
    { href: "https://www.zhipin.com/web/chat/index", hasListContainer: true, listItemCount: 40 },
  ];
  const jobsPerAttempt = [
    [],
    [],
    [{ value: "job-1", label: "AI应用开发工程师（2026） _ 杭州", active: false }],
  ];
  let ensureCallCount = 0;
  let listJobsCallCount = 0;
  const page = {
    async ensureOnChatPage() {
      const next = pageStates[Math.min(ensureCallCount, pageStates.length - 1)];
      ensureCallCount += 1;
      return next;
    },
    async listJobs() {
      const next = jobsPerAttempt[Math.min(listJobsCallCount, jobsPerAttempt.length - 1)];
      listJobsCallCount += 1;
      return next;
    },
  };

  const hydrated = await vendorCliTestables.waitForChatShellHydration({
    page,
    maxAttempts: 4,
    delayMs: 0,
  });
  assert.equal(Array.isArray(hydrated.jobs), true);
  assert.equal(hydrated.jobs.length, 1);
  assert.equal(hydrated.pageState.listItemCount, 40);
  assert.equal(ensureCallCount >= 3, true);
}

async function testVendorBossChatCliShouldRetryJobListDuringPromptRunProfile() {
  const page = {
    _attempt: 0,
    async ensureOnChatPage() {
      return {
        href: "https://www.zhipin.com/web/chat/index",
        hasListContainer: this._attempt >= 1,
        listItemCount: this._attempt >= 1 ? 10 : 0,
      };
    },
    async listJobs() {
      this._attempt += 1;
      if (this._attempt < 2) {
        return [];
      }
      return [
        {
          value: "job-1",
          label: "AI应用开发工程师（2026） _ 杭州",
          active: false,
        },
      ];
    },
  };

  const profile = await vendorCliTestables.promptRunProfile({
    page,
    persistentProfile: {
      llm: {
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test-key",
        model: "gpt-4.1-mini",
      },
      chrome: {
        port: 9222,
      },
      runtime: {},
    },
    overrides: {
      jobSelection: "AI应用开发工程师（2026） _ 杭州",
      startFrom: "unread",
      screeningCriteria: "小样本联通性验证",
      targetCount: 1,
    },
  });
  assert.equal(profile.jobSelection.label, "AI应用开发工程师（2026） _ 杭州");
  assert.equal(profile.startFrom, "unread");
  assert.equal(profile.targetCount, 1);
}

function testCliShouldPinInstalledPackageVersionInGeneratedMcpConfig() {
  const installedSpecifier = cliTestables.getDefaultMcpPackageSpecifier({
    packageVersion: "1.3.25",
    packageRootPath: "C:\\Users\\yaolin\\AppData\\Roaming\\npm\\node_modules\\@reconcrap\\boss-recommend-mcp",
  });
  assert.equal(installedSpecifier, "@reconcrap/boss-recommend-mcp@1.3.25");

  const cachedSpecifier = cliTestables.getDefaultMcpPackageSpecifier({
    packageVersion: "1.3.25",
    packageRootPath: "C:\\Users\\yaolin\\AppData\\Local\\npm-cache\\_npx\\abcd1234\\node_modules\\@reconcrap\\boss-recommend-mcp",
  });
  assert.equal(cachedSpecifier, "@reconcrap/boss-recommend-mcp@1.3.25");

  const sourceSpecifier = cliTestables.getDefaultMcpPackageSpecifier({
    packageVersion: "1.3.25-dev",
    packageRootPath: "C:\\Users\\yaolin\\Documents\\codex_projects\\boss recommend pipeline\\boss-recommend-mcp",
  });
  assert.equal(sourceSpecifier, "@reconcrap/boss-recommend-mcp@latest");

  const launchConfig = cliTestables.buildMcpLaunchConfig({});
  assert.equal(launchConfig.command, "npx");
  assert.equal(Array.isArray(launchConfig.args), true);
  assert.equal(launchConfig.args[0], "-y");
}

function testBossChatLlmEvidenceGateShouldDemoteMissingEvidence() {
  const parsed = parseLlmJson(
    JSON.stringify({
      passed: true,
      reason: "命中标准",
      summary: "命中",
      evidence: [],
    }),
    {
      evidenceCorpus: "南京大学 机器学习 项目经历",
    },
  );
  assert.equal(parsed.rawPassed, true);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.evidenceGateDemoted, true);
  assert.equal(parsed.evidenceMatchedCount, 0);
}

function testBossChatLlmEvidenceGateShouldDemoteUnmatchedEvidence() {
  const parsed = parseLlmJson(
    JSON.stringify({
      passed: true,
      reason: "命中标准",
      summary: "命中",
      evidence: ["十年金融风控投研经验"],
    }),
    {
      evidenceCorpus: "南京大学 机器学习 项目经历",
    },
  );
  assert.equal(parsed.rawPassed, true);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.evidenceGateDemoted, true);
  assert.equal(parsed.evidenceRawCount, 1);
  assert.equal(parsed.evidenceMatchedCount, 0);
}

async function testBossChatLlmTextChunkFallbackShouldWork() {
  const originalChunkSize = process.env.BOSS_CHAT_TEXT_CHUNK_SIZE_CHARS;
  const originalChunkOverlap = process.env.BOSS_CHAT_TEXT_CHUNK_OVERLAP_CHARS;
  const originalMaxChunks = process.env.BOSS_CHAT_TEXT_MAX_CHUNKS;
  process.env.BOSS_CHAT_TEXT_CHUNK_SIZE_CHARS = "1000";
  process.env.BOSS_CHAT_TEXT_CHUNK_OVERLAP_CHARS = "120";
  process.env.BOSS_CHAT_TEXT_MAX_CHUNKS = "6";
  try {
    class FakeChunkFallbackClient extends LlmClient {
      constructor() {
        super({
          baseUrl: "https://api.example.com/v1",
          apiKey: "sk-test",
          model: "gpt-test",
        });
        this.calls = [];
      }

      async requestByPreference(payload) {
        this.calls.push(payload);
        if (payload.chunkTotal === 1 && !payload.imageDataUrl) {
          const error = new Error("maximum context length exceeded");
          throw error;
        }
        if (payload.chunkTotal > 1) {
          if (payload.chunkIndex === 2) {
            return {
              passed: true,
              rawPassed: true,
              reason: "命中分段证据",
              summary: "命中",
              evidence: ["PASS_MARKER_ABC"],
              evidenceRawCount: 1,
              evidenceMatchedCount: 1,
              evidenceGateDemoted: false,
              chunkIndex: payload.chunkIndex,
              chunkTotal: payload.chunkTotal,
            };
          }
          return {
            passed: false,
            rawPassed: false,
            reason: "本段证据不足",
            summary: "不足",
            evidence: [],
            evidenceRawCount: 0,
            evidenceMatchedCount: 0,
            evidenceGateDemoted: false,
            chunkIndex: payload.chunkIndex,
            chunkTotal: payload.chunkTotal,
          };
        }
        return {
          passed: false,
          rawPassed: false,
          reason: "unexpected",
          summary: "unexpected",
          evidence: [],
          evidenceRawCount: 0,
          evidenceMatchedCount: 0,
          evidenceGateDemoted: false,
          chunkIndex: 1,
          chunkTotal: 1,
        };
      }
    }

    const client = new FakeChunkFallbackClient();
    const longResume = `${"A".repeat(1200)} PASS_MARKER_ABC ${"B".repeat(1200)} PASS_MARKER_DEF`;
    const result = await client.evaluateResume({
      screeningCriteria: "有 AI 项目经验",
      candidate: {
        name: "候选人A",
        sourceJob: "算法工程师",
        resumeText: longResume,
        evidenceCorpus: longResume,
      },
      imagePath: null,
    });
    assert.equal(result.passed, true);
    assert.equal(result.evaluationMode, "text");
    assert.equal(result.chunkIndex, 2);
    assert.equal(Number(result.chunkTotal) > 1, true);
  } finally {
    if (originalChunkSize === undefined) delete process.env.BOSS_CHAT_TEXT_CHUNK_SIZE_CHARS;
    else process.env.BOSS_CHAT_TEXT_CHUNK_SIZE_CHARS = originalChunkSize;
    if (originalChunkOverlap === undefined) delete process.env.BOSS_CHAT_TEXT_CHUNK_OVERLAP_CHARS;
    else process.env.BOSS_CHAT_TEXT_CHUNK_OVERLAP_CHARS = originalChunkOverlap;
    if (originalMaxChunks === undefined) delete process.env.BOSS_CHAT_TEXT_MAX_CHUNKS;
    else process.env.BOSS_CHAT_TEXT_MAX_CHUNKS = originalMaxChunks;
  }
}

async function testBossChatLlmShouldApplyThinkingDefaultsAndOverrides() {
  const completionResponse = {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [
          {
            message: {
              content: "{\"passed\": false, \"reason\": \"not matched\", \"summary\": \"not matched\", \"evidence\": [\"resume\"]}"
            }
          }
        ]
      };
    }
  };
  const responsesResponse = {
    ok: true,
    status: 200,
    async json() {
      return {
        output_text: "{\"passed\": false, \"reason\": \"not matched\", \"summary\": \"not matched\", \"evidence\": [\"resume\"]}"
      };
    }
  };

  let volcCompletionPayload = null;
  const volcClient = new LlmClient({
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "sk-test",
    model: "doubao-seed-2-0-mini-260215",
  }, {
    fetchImpl: async (_url, options = {}) => {
      volcCompletionPayload = JSON.parse(String(options.body || "{}"));
      return completionResponse;
    },
  });
  await volcClient.requestCompletions({ prompt: "prompt", evidenceCorpus: "resume" });
  assert.deepEqual(volcCompletionPayload.thinking, { type: "enabled" });
  assert.equal(volcCompletionPayload.reasoning_effort, "low");

  let lowCompletionPayload = null;
  const lowClient = new LlmClient({
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKey: "sk-test",
    model: "doubao-seed-2-0-mini-260215",
    thinkingLevel: "low",
  }, {
    fetchImpl: async (_url, options = {}) => {
      lowCompletionPayload = JSON.parse(String(options.body || "{}"));
      return completionResponse;
    },
  });
  await lowClient.requestCompletions({ prompt: "prompt", evidenceCorpus: "resume" });
  assert.deepEqual(lowCompletionPayload.thinking, { type: "enabled" });
  assert.equal(lowCompletionPayload.reasoning_effort, "low");

  let openaiCompletionPayload = null;
  const openaiClient = new LlmClient({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-test",
  }, {
    fetchImpl: async (_url, options = {}) => {
      openaiCompletionPayload = JSON.parse(String(options.body || "{}"));
      return completionResponse;
    },
  });
  await openaiClient.requestCompletions({ prompt: "prompt", evidenceCorpus: "resume" });
  assert.equal(openaiCompletionPayload.thinking, undefined);
  assert.equal(openaiCompletionPayload.reasoning_effort, "low");

  let responsesPayload = null;
  const responsesClient = new LlmClient({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    model: "gpt-test",
    thinkingLevel: "low",
  }, {
    fetchImpl: async (_url, options = {}) => {
      responsesPayload = JSON.parse(String(options.body || "{}"));
      return responsesResponse;
    },
  });
  await responsesClient.requestResponses({ prompt: "prompt", evidenceCorpus: "resume" });
  assert.deepEqual(responsesPayload.reasoning, { effort: "low" });
}

async function testBossChatAppShouldResetPrimaryChatLabelBeforeInitialPrime() {
  const calls = [];
  const page = {
    async ensureReady() {
      calls.push("ensureReady");
      return { hasListContainer: true, listItemCount: 1 };
    },
    async activatePrimaryChatLabel(label) {
      calls.push(`activatePrimaryChatLabel:${label}`);
      return { changed: false, verified: true, activeLabel: label };
    },
    async selectJob(jobSelection) {
      calls.push(`selectJob:${jobSelection.label}`);
      return jobSelection;
    },
    async activateUnreadFilter() {
      calls.push("activateUnreadFilter");
      return { changed: false, verified: true, activeLabel: "未读" };
    },
    async primeConversationByFirstCandidate() {
      calls.push("primeConversationByFirstCandidate:1");
      return {
        candidate: {
          customerId: "1001",
          name: "候选人A",
          sourceJob: "算法工程师",
          domIndex: 0,
        },
        totalVisibleCandidates: 1,
        readyState: {
          hasOnlineResume: true,
          hasAskResume: true,
          hasAttachmentResume: false,
        },
      };
    },
    async getLoadedCustomers() {
      calls.push("getLoadedCustomers:1");
      return [];
    },
    async closeResumeModalDomOnce() {
      return {
        closed: true,
        method: "already-closed",
        finalState: { scopeCount: 0, iframeCount: 0, closeCount: 0, topScopeClass: "" },
      };
    },
  };
  const stateStore = {
    async load() {},
    hasAny() {
      return false;
    },
    async record() {},
  };
  const app = new BossChatApp({
    page,
    llmClient: {},
    interaction: {
      async sleepRange() {},
      async maybeRest() {},
    },
    resumeCaptureService: {},
    stateStore,
    reportStore: {
      async write() {
        return "report.json";
      },
    },
    logger: { log() {} },
    dryRun: true,
    artifactRootDir: os.tmpdir(),
    resumeOpenCooldownMs: 0,
  });
  app.waitForCandidateList = async ({ reason } = {}) => {
    calls.push(`waitForCandidateList:${reason || "unknown"}`);
    return {
      ready: true,
      waitedMs: 0,
      attempts: 1,
      listItemCount: 1,
      lastError: "",
    };
  };
  app.processCustomer = async (_customer, _profile, _runId, options = {}) => {
    calls.push(`processCustomer:${options.skipCardClick === true ? "skip" : "click"}`);
    return {
      name: "候选人A",
      passed: false,
      requested: false,
      reason: "skip",
      error: "",
      artifacts: {},
    };
  };

  const summary = await app.run({
    screeningCriteria: "有 AI 项目经验",
    targetCount: 1,
    startFrom: "unread",
    jobSelection: { label: "算法工程师", value: "job-1" },
    chrome: { port: 9222 },
    llm: { model: "gpt-test" },
  });

  assert.deepEqual(calls.slice(0, 4), [
    "ensureReady",
    "activatePrimaryChatLabel:全部",
    "selectJob:算法工程师",
    "activateUnreadFilter",
  ]);
  assert.equal(calls.includes("primeConversationByFirstCandidate:1"), true);
  assert.equal(calls.includes("processCustomer:skip"), true);
  assert.equal(summary.inspected, 1);
  assert.equal(summary.skipped, 1);
}

async function testBossChatAppShouldCloseCandidateDetailDuringRunCleanup() {
  const calls = [];
  const page = {
    async ensureReady() {
      calls.push("ensureReady");
      return { hasListContainer: true, listItemCount: 1 };
    },
    async activatePrimaryChatLabel(label) {
      calls.push(`activatePrimaryChatLabel:${label}`);
      return { changed: false, verified: true, activeLabel: label };
    },
    async selectJob(jobSelection) {
      calls.push(`selectJob:${jobSelection.label}`);
      return jobSelection;
    },
    async activateUnreadFilter() {
      calls.push("activateUnreadFilter");
      return { changed: false, verified: true, activeLabel: "未读" };
    },
    async primeConversationByFirstCandidate() {
      calls.push("primeConversationByFirstCandidate:1");
      return {
        candidate: {
          customerId: "1008",
          name: "候选人清理",
          sourceJob: "算法工程师",
          domIndex: 0
        },
        totalVisibleCandidates: 1,
        readyState: {
          hasOnlineResume: true,
          hasAskResume: true,
          hasAttachmentResume: false
        }
      };
    },
    async getLoadedCustomers() {
      calls.push("getLoadedCustomers:1");
      return [];
    },
    async closeResumeModalDomOnce() {
      calls.push("closeResumeModalDomOnce");
      return {
        closed: true,
        method: "already-closed",
        finalState: { scopeCount: 0, iframeCount: 0, closeCount: 0, topScopeClass: "" }
      };
    },
    async closeCandidateDetailDomOnce() {
      calls.push("closeCandidateDetailDomOnce");
      return {
        closed: true,
        method: "dom-close-once:.close-btn",
        finalState: { panelCount: 0, closeCount: 0, topPanelClass: "" }
      };
    }
  };
  const stateStore = {
    async load() {},
    hasAny() {
      return false;
    },
    async record() {}
  };
  const app = new BossChatApp({
    page,
    llmClient: {},
    interaction: {
      async sleepRange() {},
      async maybeRest() {}
    },
    resumeCaptureService: {},
    stateStore,
    reportStore: {
      async write() {
        return "report.json";
      }
    },
    logger: { log() {} },
    dryRun: true,
    artifactRootDir: os.tmpdir(),
    resumeOpenCooldownMs: 0
  });
  app.waitForCandidateList = async ({ reason } = {}) => {
    calls.push(`waitForCandidateList:${reason || "unknown"}`);
    return {
      ready: true,
      waitedMs: 0,
      attempts: 1,
      listItemCount: 1,
      lastError: ""
    };
  };
  app.processCustomer = async () => ({
    name: "候选人清理",
    passed: false,
    requested: false,
    reason: "skip",
    error: "",
    artifacts: {}
  });

  const summary = await app.run({
    screeningCriteria: "有 AI 项目经验",
    targetCount: 1,
    startFrom: "unread",
    jobSelection: { label: "算法工程师", value: "job-1" },
    chrome: { port: 9222 },
    llm: { model: "gpt-test" }
  });

  assert.equal(summary.inspected, 1);
  assert.equal(calls.includes("closeCandidateDetailDomOnce"), true);
  assert.equal(calls.lastIndexOf("closeCandidateDetailDomOnce") > calls.indexOf("getLoadedCustomers:1"), true);
}

async function testBossChatAppShouldRestoreListContextAfterRecovery() {
  const calls = [];
  let primeCount = 0;
  let loadedCount = 0;
  const page = {
    async ensureReady() {
      return { hasListContainer: true, listItemCount: 1 };
    },
    async activatePrimaryChatLabel(label) {
      calls.push(`activatePrimaryChatLabel:${label}`);
      return { changed: false, verified: true, activeLabel: label };
    },
    async selectJob(jobSelection) {
      calls.push(`selectJob:${jobSelection.label}`);
      return jobSelection;
    },
    async activateUnreadFilter() {
      calls.push("activateUnreadFilter");
      return { changed: false, verified: true, activeLabel: "未读" };
    },
    async primeConversationByFirstCandidate() {
      primeCount += 1;
      calls.push(`primeConversationByFirstCandidate:${primeCount}`);
      if (primeCount === 1) {
        throw new Error("NO_FIRST_CANDIDATE");
      }
      return {
        candidate: {
          customerId: "1002",
          name: "候选人B",
          sourceJob: "算法工程师",
          domIndex: 0,
        },
        totalVisibleCandidates: 1,
        readyState: {
          hasOnlineResume: true,
          hasAskResume: true,
          hasAttachmentResume: false,
        },
      };
    },
    async getLoadedCustomers() {
      loadedCount += 1;
      calls.push(`getLoadedCustomers:${loadedCount}`);
      if (loadedCount === 1) {
        throw new Error("CHAT_CARD_LIST_NOT_FOUND");
      }
      return [];
    },
    async recoverToChatIndex() {
      calls.push("recoverToChatIndex");
      return { changed: true, href: "https://www.zhipin.com/web/chat/index" };
    },
    async closeResumeModalDomOnce() {
      return {
        closed: true,
        method: "already-closed",
        finalState: { scopeCount: 0, iframeCount: 0, closeCount: 0, topScopeClass: "" },
      };
    },
  };
  const stateStore = {
    async load() {},
    hasAny() {
      return false;
    },
    async record() {},
  };
  const app = new BossChatApp({
    page,
    llmClient: {},
    interaction: {
      async sleepRange() {},
      async maybeRest() {},
    },
    resumeCaptureService: {},
    stateStore,
    reportStore: {
      async write() {
        return "report.json";
      },
    },
    logger: { log() {} },
    dryRun: true,
    artifactRootDir: os.tmpdir(),
    resumeOpenCooldownMs: 0,
  });
  app.waitForCandidateList = async ({ reason } = {}) => {
    calls.push(`waitForCandidateList:${reason || "unknown"}`);
    return {
      ready:
        reason === "initial-context-restore" ||
        reason === "post-recovery-context-restore",
      waitedMs: 0,
      attempts: 1,
      listItemCount:
        reason === "initial-context-restore" ||
        reason === "post-recovery-context-restore"
          ? 1
          : 0,
      lastError: "",
    };
  };
  app.processCustomer = async (_customer, _profile, _runId, options = {}) => {
    calls.push(`processCustomer:${options.skipCardClick === true ? "skip" : "click"}`);
    return {
      name: "候选人B",
      passed: false,
      requested: false,
      reason: "skip",
      error: "",
      artifacts: {},
    };
  };

  const summary = await app.run({
    screeningCriteria: "有 AI 项目经验",
    targetCount: 1,
    startFrom: "unread",
    jobSelection: { label: "算法工程师", value: "job-1" },
    chrome: { port: 9222 },
    llm: { model: "gpt-test" },
  });

  assert.equal(calls.filter((item) => item === "activatePrimaryChatLabel:全部").length, 2);
  const recoverIndex = calls.indexOf("recoverToChatIndex");
  assert.equal(recoverIndex >= 0, true);
  assert.equal(calls[recoverIndex + 1], "activatePrimaryChatLabel:全部");
  assert.equal(calls[recoverIndex + 2], "selectJob:算法工程师");
  assert.equal(calls[recoverIndex + 3], "activateUnreadFilter");
  assert.equal(calls[recoverIndex + 4], "waitForCandidateList:post-recovery-context-restore");
  assert.equal(calls[recoverIndex + 5], "primeConversationByFirstCandidate:2");
  assert.equal(calls.includes("processCustomer:skip"), true);
  assert.equal(summary.inspected, 1);
  assert.equal(summary.skipped, 1);
}

async function testBossChatAppShouldWaitForCandidateListBeforePriming() {
  const calls = [];
  let pageStateCall = 0;
  const page = {
    async ensureReady() {
      calls.push("ensureReady");
      return { hasListContainer: false, listItemCount: 0 };
    },
    async activatePrimaryChatLabel(label) {
      calls.push(`activatePrimaryChatLabel:${label}`);
      return { changed: false, verified: true, activeLabel: label };
    },
    async selectJob(jobSelection) {
      calls.push(`selectJob:${jobSelection.label}`);
      return jobSelection;
    },
    async activateUnreadFilter() {
      calls.push("activateUnreadFilter");
      return { changed: true, verified: true, activeLabel: "未读" };
    },
    async getPageState() {
      pageStateCall += 1;
      calls.push(`getPageState:${pageStateCall}`);
      return {
        href: "https://www.zhipin.com/web/chat/index",
        readyState: "complete",
        hasListContainer: pageStateCall >= 3,
        listItemCount: pageStateCall >= 3 ? 2 : 0,
      };
    },
    async primeConversationByFirstCandidate() {
      calls.push("primeConversationByFirstCandidate:1");
      return {
        candidate: {
          customerId: "1003",
          name: "候选人C",
          sourceJob: "算法工程师",
          domIndex: 0,
        },
        totalVisibleCandidates: 2,
        readyState: {
          hasOnlineResume: true,
          hasAskResume: true,
          hasAttachmentResume: false,
        },
      };
    },
    async getLoadedCustomers() {
      calls.push("getLoadedCustomers:1");
      return [];
    },
    async closeResumeModalDomOnce() {
      return {
        closed: true,
        method: "already-closed",
        finalState: { scopeCount: 0, iframeCount: 0, closeCount: 0, topScopeClass: "" },
      };
    },
  };
  const stateStore = {
    async load() {},
    hasAny() {
      return false;
    },
    async record() {},
  };
  const app = new BossChatApp({
    page,
    llmClient: {},
    interaction: {
      async sleepRange() {},
      async maybeRest() {},
    },
    resumeCaptureService: {},
    stateStore,
    reportStore: {
      async write() {
        return "report.json";
      },
    },
    logger: { log() {} },
    dryRun: true,
    artifactRootDir: os.tmpdir(),
    resumeOpenCooldownMs: 0,
  });
  app.processCustomer = async (_customer, _profile, _runId, options = {}) => {
    calls.push(`processCustomer:${options.skipCardClick === true ? "skip" : "click"}`);
    return {
      name: "候选人C",
      passed: false,
      requested: false,
      reason: "skip",
      error: "",
      artifacts: {},
    };
  };

  const summary = await app.run({
    screeningCriteria: "有 AI 项目经验",
    targetCount: 1,
    startFrom: "unread",
    jobSelection: { label: "算法工程师", value: "job-1" },
    chrome: { port: 9222 },
    llm: { model: "gpt-test" },
  });

  const primeIndex = calls.indexOf("primeConversationByFirstCandidate:1");
  const thirdStateIndex = calls.indexOf("getPageState:3");
  assert.equal(thirdStateIndex >= 0, true);
  assert.equal(primeIndex > thirdStateIndex, true);
  assert.equal(summary.inspected, 1);
  assert.equal(summary.skipped, 1);
}

async function testBossChatAppShouldPersistEvidenceArtifacts() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-artifacts-"));
  await mkdir(tempDir, { recursive: true });
  const records = [];
  const page = {
    async closeResumeModalDomOnce() {
      return {
        closed: true,
        method: "dom",
        finalState: { scopeCount: 0, iframeCount: 0, closeCount: 0, topScopeClass: "" },
      };
    },
    async waitForConversationReady() {
      return {
        hasOnlineResume: true,
        hasAskResume: true,
        hasAttachmentResume: false,
        attachmentResumeEnabled: false,
      };
    },
    async openOnlineResume() {
      return { clicked: true, detectedOpen: true, by: "dom" };
    },
    async getResumeRateLimitWarning() {
      return { hit: false, text: "" };
    },
    async getResumeProfileFromDom() {
      return {
        ok: true,
        primarySchool: "南京大学",
        schools: ["南京大学"],
        major: "计算机",
        majors: ["计算机"],
        company: "OpenAI",
        position: "工程师",
        resumeText: "南京大学 计算机 PASS_MARKER_ABC",
        evidenceCorpus: "南京大学 计算机 PASS_MARKER_ABC",
      };
    },
    async getResumeModalState() {
      return { open: true, iframeCount: 1, scopeCount: 1, closeCount: 1 };
    },
  };
  const llmClient = {
    async evaluateResume() {
      return {
        passed: false,
        rawPassed: true,
        reason: "模型未给出可在简历原文中校验的证据，按安全策略判为不通过。",
        summary: "降级",
        evidence: [],
        evidenceRawCount: 1,
        evidenceMatchedCount: 0,
        evidenceGateDemoted: true,
        evaluationMode: "text",
        chunkIndex: 1,
        chunkTotal: 1,
      };
    },
  };
  const interaction = {
    async sleepRange() {},
    async clickRect() {},
  };
  const resumeCaptureService = {
    async captureResume({ artifactDir }) {
      return {
        stitchedImage: path.join(artifactDir, "resume.png"),
        metadataFile: path.join(artifactDir, "chunks.json"),
        chunkDir: path.join(artifactDir, "chunks"),
        chunkCount: 1,
        quality: { likelyBlank: false },
      };
    },
  };
  const stateStore = {
    async record(_key, result) {
      records.push(result);
    },
  };
  const app = new BossChatApp({
    page,
    llmClient,
    interaction,
    resumeCaptureService,
    stateStore,
    reportStore: { async write() { return ""; } },
    dryRun: true,
    artifactRootDir: tempDir,
    resumeOpenCooldownMs: 0,
    logger: { log() {} },
  });
  app.waitResumeOpenCooldown = async () => {};

  const result = await app.processCustomer(
    {
      customerKey: "candidate-key",
      name: "候选人A",
      sourceJob: "算法工程师",
      domIndex: 0,
      customerId: "1001",
      textSnippet: "",
    },
    {
      screeningCriteria: "有 AI 项目经验",
    },
    "run-test",
    { skipCardClick: true },
  );

  assert.equal(result.passed, false);
  assert.equal(result.artifacts.rawPassed, true);
  assert.equal(result.artifacts.finalPassed, false);
  assert.equal(result.artifacts.evidenceRawCount, 1);
  assert.equal(result.artifacts.evidenceMatchedCount, 0);
  assert.equal(result.artifacts.evidenceGateDemoted, true);
  assert.equal(result.artifacts.evaluationMode, "text");
  assert.equal(Array.isArray(records), true);
  assert.equal(records.length, 1);
}

async function main() {
  await testBossChatAdapterShouldResolveSharedConfigAndInvokeLocalCli();
  await testBossChatPrepareShouldRetryWhenChatPageIsNotReady();
  await testBossChatPageShouldTreatBlankChatShellAsOnChatPage();
  await testBossChatRecoverToChatIndexShouldForceNavigateAndWaitForCompleteLoad();
  await testBossChatPageShouldFallbackToEscapeWhenClosingCandidateDetail();
  await testBossChatMcpToolsShouldValidateAndRoute();
  await testBossChatCliShouldSupportRunAndFollowUpParsing();
  await testVendorBossChatCliShouldWaitForHydratedChatShell();
  await testVendorBossChatCliShouldRetryJobListDuringPromptRunProfile();
  testCliShouldPinInstalledPackageVersionInGeneratedMcpConfig();
  testBossChatLlmEvidenceGateShouldDemoteMissingEvidence();
  testBossChatLlmEvidenceGateShouldDemoteUnmatchedEvidence();
  await testBossChatLlmTextChunkFallbackShouldWork();
  await testBossChatLlmShouldApplyThinkingDefaultsAndOverrides();
  await testBossChatAppShouldResetPrimaryChatLabelBeforeInitialPrime();
  await testBossChatAppShouldCloseCandidateDetailDuringRunCleanup();
  await testBossChatAppShouldRestoreListContextAfterRecovery();
  await testBossChatAppShouldWaitForCandidateListBeforePriming();
  await testBossChatAppShouldPersistEvidenceArtifacts();
  console.log("boss-chat tests passed");
}

await main();
