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
      keyword_confirmed: true,
      search_params_confirmed: true,
      criteria_confirmed: true,
      use_default_for_missing: true
    },
    overrides: {
      keyword: "算法工程师",
      filter_recent_viewed: false,
      target_count: 3
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
  assert.equal(observedOptions.humanRestEnabled, true);
  assert.equal(observedOptions.humanBehavior.profile, "paced_with_rests");
  assert.equal(observedOptions.humanBehavior.listScrollJitter, true);
  assert.equal(observedOptions.humanBehavior.restLevel, "medium");
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
    await testRecruitDefaultsUseScreeningConfig();
    resetRecruitMcpStateForTests();
    await testRecruitHumanBehaviorArgsOverrideConfig();
    resetRecruitMcpStateForTests();
    await testRecruitSyncRun();
    resetRecruitMcpStateForTests();
    await testRecruitAsyncPauseResume();
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
