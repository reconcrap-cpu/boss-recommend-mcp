import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cancelBossChatRun,
  getBossChatHealthCheck,
  getBossChatRun,
  pauseBossChatRun,
  resumeBossChatRun,
  startBossChatRun
} from "./boss-chat.js";
import { __testables as cliTestables } from "./cli.js";
import { __testables as indexTestables } from "./index.js";

const { handleRequest } = indexTestables;

const TOOL_BOSS_CHAT_HEALTH_CHECK = "boss_chat_health_check";
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

async function testBossChatMcpToolsShouldValidateAndRoute() {
  await withBossChatWorkspace(async (workspaceRoot) => {
    const needInput = await callTool(workspaceRoot, TOOL_BOSS_CHAT_START_RUN, {}, 11);
    assert.equal(needInput.status, "NEED_INPUT");
    assert.deepEqual(needInput.required_fields, ["job", "start_from", "target_count", "criteria"]);
    assert.equal(Array.isArray(needInput.job_options), true);
    assert.equal(needInput.job_options.length, 2);
    const targetQuestion = needInput.pending_questions.find((item) => item.field === "target_count");
    assert.equal(Boolean(targetQuestion), true);
    assert.equal(targetQuestion.argument_name, "target_count");
    assert.equal(targetQuestion.options.some((item) => item.value === "all"), true);

    const missingTargetOnly = await callTool(workspaceRoot, TOOL_BOSS_CHAT_START_RUN, {
      job: "算法工程师",
      start_from: "all",
      criteria: "全部候选人都过一遍"
    }, 111);
    assert.equal(missingTargetOnly.status, "NEED_INPUT");
    assert.deepEqual(missingTargetOnly.missing_fields, ["target_count"]);
    assert.equal(missingTargetOnly.next_call_example.target_count, "all");

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

async function main() {
  await testBossChatAdapterShouldResolveSharedConfigAndInvokeLocalCli();
  await testBossChatMcpToolsShouldValidateAndRoute();
  await testBossChatCliShouldSupportRunAndFollowUpParsing();
  console.log("boss-chat tests passed");
}

await main();
