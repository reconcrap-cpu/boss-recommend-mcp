import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureFeaturedCalibrationReady,
  runPipelinePreflight,
  runRecommendSearchCli,
  runRecommendScreenCli,
  resolveSharedLlmTransportConfig,
  __testables as adapterTestables
} from "./adapters.js";

const {
  runProcess,
  parseJsonOutput,
  parseScreenProgressLine,
  resolveRecommendScreenTimeoutMs,
  buildRecommendScreenProcessError
} = adapterTestables;

async function testRunProcessHeartbeatAndOutput() {
  const heartbeats = [];
  const lines = [];
  const result = await runProcess({
    command: "node",
    args: [
      "-e",
      "let i=0; const t=setInterval(()=>{console.error(`tick ${++i}`); if(i===3){clearInterval(t); console.log('{\"status\":\"COMPLETED\"}');}}, 120);"
    ],
    timeoutMs: 5000,
    heartbeatIntervalMs: 40,
    onHeartbeat: (event) => {
      heartbeats.push(event?.source || "unknown");
    },
    onLine: (event) => {
      lines.push(event?.line || "");
    }
  });

  assert.equal(result.code, 0);
  assert.equal(result.error_code, undefined);
  assert.equal(heartbeats.length >= 3, true);
  assert.equal(lines.some((line) => line.includes("tick 1")), true);
  assert.equal(lines.some((line) => line.includes("\"status\":\"COMPLETED\"")), true);
}

async function testRunProcessAbortSignal() {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 120);

  const result = await runProcess({
    command: "node",
    args: ["-e", "setTimeout(() => console.log('done'), 5000);"],
    timeoutMs: 6000,
    signal: controller.signal
  });

  assert.equal(result.code, -1);
  assert.equal(result.error_code, "ABORTED");
  assert.equal(String(result.stderr || "").includes("aborted"), true);
}

function testParsePausedStructuredOutput() {
  const parsed = parseJsonOutput(`
    [log] doing work
    {"status":"PAUSED","result":{"processed_count":3,"output_csv":"C:/tmp/test.csv"}}
  `);
  assert.equal(parsed?.status, "PAUSED");
  assert.equal(parsed?.result?.processed_count, 3);
}

function testParseScreenProgressLineShouldCountFavoriteFailureAsSkipped() {
  let progress = { processed: 0, passed: 0, skipped: 0, greet_count: 0 };
  let tracker = {};
  const feed = (line) => {
    const parsed = parseScreenProgressLine(line, progress, tracker);
    if (!parsed) return;
    progress = parsed.progress;
    tracker = parsed.tracker;
  };

  feed("处理第 1 位候选人: 甲");
  feed("筛选结果: 通过");
  feed("[关闭详情] 成功: no popup or detail signal visible");
  feed("处理第 2 位候选人: 乙");
  feed("筛选结果: 通过");
  feed("候选人处理失败: FAVORITE_BUTTON_FAILED");
  feed("[关闭详情] 成功: no popup or detail signal visible");

  assert.equal(progress.processed, 2);
  assert.equal(progress.passed, 1);
  assert.equal(progress.skipped, 1);
}

function testResolveScreenTimeoutDefaultsTo24Hours() {
  const previous = process.env.BOSS_RECOMMEND_SCREEN_TIMEOUT_MS;
  delete process.env.BOSS_RECOMMEND_SCREEN_TIMEOUT_MS;
  try {
    assert.equal(resolveRecommendScreenTimeoutMs(null), 24 * 60 * 60 * 1000);
    assert.equal(resolveRecommendScreenTimeoutMs({ timeoutMs: 1234 }), 1234);
  } finally {
    if (previous === undefined) {
      delete process.env.BOSS_RECOMMEND_SCREEN_TIMEOUT_MS;
    } else {
      process.env.BOSS_RECOMMEND_SCREEN_TIMEOUT_MS = previous;
    }
  }
}

function testResolveSharedLlmTransportConfigShouldUseDefaultsAndOverrides() {
  assert.deepEqual(resolveSharedLlmTransportConfig({}), {
    llmTimeoutMs: 60000,
    llmMaxRetries: 3,
  });
  assert.deepEqual(
    resolveSharedLlmTransportConfig({
      llmTimeoutMs: 90000,
      llmMaxRetries: 5,
    }),
    {
      llmTimeoutMs: 90000,
      llmMaxRetries: 5,
    },
  );
}

function testBuildRecommendScreenProcessErrorMapsTimeout() {
  const error = buildRecommendScreenProcessError({ code: -1, error_code: "TIMEOUT" }, 86400000);
  assert.equal(error?.code, "TIMEOUT");
  assert.equal(String(error?.message || "").includes("86400000"), true);
}

async function testResumeRequiresCheckpointFile() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-resume-"));
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  try {
    const configPath = path.join(tempHome, "screening-config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-valid",
      model: "gpt-4.1-mini"
    }, null, 2));

    const missingCheckpoint = path.join(tempHome, "missing-checkpoint.json");
    const result = await runRecommendScreenCli({
      workspaceRoot: process.cwd(),
      screenParams: {
        criteria: "有MCP经验",
        target_count: 10,
        post_action: "favorite",
        max_greet_count: null
      },
      resume: {
        resume: true,
        require_checkpoint: true,
        checkpoint_path: missingCheckpoint,
        pause_control_path: path.join(tempHome, "run-state.json"),
        output_csv: path.join(tempHome, "resume.csv")
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "RESUME_CHECKPOINT_MISSING");
  } finally {
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

async function testRecommendScreenCliShouldPassSharedLlmTransportArgs() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-stub-"));
  const screenDir = path.join(workspaceRoot, "boss-recommend-screen-cli");
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-home-"));
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  fs.mkdirSync(screenDir, { recursive: true });
  fs.writeFileSync(
    path.join(screenDir, "boss-recommend-screen-cli.cjs"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const argv = process.argv.slice(2);",
      "const parsed = {};",
      "for (let i = 0; i < argv.length; i += 1) {",
      "  const token = argv[i];",
      "  if (!token.startsWith('--')) continue;",
      "  const next = argv[i + 1];",
      "  parsed[token.slice(2)] = next && !next.startsWith('--') ? next : true;",
      "  if (next && !next.startsWith('--')) i += 1;",
      "}",
      "const output = path.join(process.env.BOSS_RECOMMEND_HOME, 'screen-cli-args.json');",
      "fs.writeFileSync(output, JSON.stringify(parsed, null, 2));",
      "console.log(JSON.stringify({ status: 'COMPLETED', result: { processed_count: 0, output_csv: parsed.output || '' } }));",
    ].join("\n"),
    "utf8",
  );

  process.env.BOSS_RECOMMEND_HOME = tempHome;
  fs.writeFileSync(
    path.join(tempHome, "screening-config.json"),
    JSON.stringify(
      {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-valid-test",
        model: "gpt-4.1-mini",
        llmTimeoutMs: 75000,
        llmMaxRetries: 6,
      },
      null,
      2,
    ),
  );

  try {
    const result = await runRecommendScreenCli({
      workspaceRoot,
      screenParams: {
        criteria: "有 MCP 经验",
        target_count: null,
        post_action: "none",
        max_greet_count: null,
      },
      pageScope: "recommend",
    });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(fs.readFileSync(path.join(tempHome, "screen-cli-args.json"), "utf8"));
    assert.equal(parsed["llm-timeout-ms"], "75000");
    assert.equal(parsed["llm-max-retries"], "6");
  } finally {
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

function testPreflightShouldCheckSharpInsteadOfPython() {
  const preflight = runPipelinePreflight(process.cwd());
  const keys = new Set((preflight.checks || []).map((item) => item?.key));
  assert.equal(keys.has("npm_dep_sharp"), true);
  assert.equal(keys.has("python_cli"), false);
  assert.equal(keys.has("python_pillow"), false);
}

function testPreflightFeaturedShouldRequireFavoriteCalibration() {
  const preflight = runPipelinePreflight(process.cwd(), { pageScope: "featured" });
  const check = (preflight.checks || []).find((item) => item?.key === "favorite_calibration");
  assert.equal(Boolean(check), true);
  assert.equal(check.optional, false);
}

function testPreflightRecommendShouldKeepFavoriteCalibrationOptional() {
  const preflight = runPipelinePreflight(process.cwd(), { pageScope: "recommend" });
  const check = (preflight.checks || []).find((item) => item?.key === "favorite_calibration");
  assert.equal(Boolean(check), true);
  assert.equal(check.optional, true);
}

function testPreflightLatestShouldKeepFavoriteCalibrationOptional() {
  const preflight = runPipelinePreflight(process.cwd(), { pageScope: "latest" });
  const check = (preflight.checks || []).find((item) => item?.key === "favorite_calibration");
  assert.equal(Boolean(check), true);
  assert.equal(check.optional, true);
}

async function testEnsureFeaturedCalibrationReadyShouldAutoCalibrate() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousScript = process.env.BOSS_RECOMMEND_RECRUIT_CALIBRATION_SCRIPT;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-featured-cal-home-"));
  const tempCodex = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-featured-cal-codex-"));
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  process.env.CODEX_HOME = tempCodex;

  const configPath = path.join(tempHome, "screening-config.json");
  const scriptPath = path.join(tempHome, "fake-calibrate.cjs");
  fs.writeFileSync(configPath, JSON.stringify({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-valid",
    model: "gpt-4.1-mini",
    calibrationFile: "favorite-calibration.json"
  }, null, 2));
  fs.writeFileSync(scriptPath, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2).reduce((acc, token, idx, arr) => {",
    "  if (token.startsWith('--')) {",
    "    const key = token.slice(2);",
    "    const next = arr[idx + 1];",
    "    acc[key] = next && !next.startsWith('--') ? next : true;",
    "  }",
    "  return acc;",
    "}, {});",
    "const output = path.resolve(String(args.output || 'favorite-calibration.json'));",
    "fs.mkdirSync(path.dirname(output), { recursive: true });",
    "fs.writeFileSync(output, JSON.stringify({ favoritePosition: { pageX: 100, pageY: 200, canvasX: 0, canvasY: 0 } }, null, 2));",
    "console.log('calibrated');"
  ].join("\n"), "utf8");
  process.env.BOSS_RECOMMEND_RECRUIT_CALIBRATION_SCRIPT = scriptPath;

  try {
    const result = await ensureFeaturedCalibrationReady(process.cwd(), {
      port: 9222,
      timeoutMs: 5000
    });
    assert.equal(result.ok, true);
    assert.equal(result.auto_started, true);
    assert.equal(String(result.calibration_path || "").endsWith("favorite-calibration.json"), true);
    assert.equal(fs.existsSync(result.calibration_path), true);
  } finally {
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousScript === undefined) {
      delete process.env.BOSS_RECOMMEND_RECRUIT_CALIBRATION_SCRIPT;
    } else {
      process.env.BOSS_RECOMMEND_RECRUIT_CALIBRATION_SCRIPT = previousScript;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempCodex, { recursive: true, force: true });
  }
}

async function testSearchCliShouldPassPageScopeArgument() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-search-page-scope-"));
  const cliDir = path.join(workspaceRoot, "boss-recommend-search-cli", "src");
  fs.mkdirSync(cliDir, { recursive: true });
  const cliPath = path.join(cliDir, "cli.js");
  fs.writeFileSync(
    cliPath,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ status: 'COMPLETED', result: { argv: process.argv.slice(2) } }));"
    ].join("\n"),
    "utf8"
  );

  try {
    const result = await runRecommendSearchCli({
      workspaceRoot,
      searchParams: {
        school_tag: ["不限"],
        degree: ["不限"],
        gender: "不限",
        recent_not_view: "不限"
      },
      selectedJob: null,
      pageScope: "featured"
    });
    assert.equal(result.ok, true);
    const argv = result.summary?.argv || [];
    const pageScopeIndex = argv.indexOf("--page-scope");
    assert.equal(pageScopeIndex >= 0, true);
    assert.equal(argv[pageScopeIndex + 1], "featured");
    const calibrationIndex = argv.indexOf("--calibration");
    assert.equal(calibrationIndex >= 0, true);
    assert.equal(String(argv[calibrationIndex + 1] || "").includes("favorite-calibration.json"), true);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function testSearchCliShouldPassLatestPageScopeWithoutCalibration() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-search-page-scope-latest-"));
  const cliDir = path.join(workspaceRoot, "boss-recommend-search-cli", "src");
  fs.mkdirSync(cliDir, { recursive: true });
  const cliPath = path.join(cliDir, "cli.js");
  fs.writeFileSync(
    cliPath,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ status: 'COMPLETED', result: { argv: process.argv.slice(2) } }));"
    ].join("\n"),
    "utf8"
  );

  try {
    const result = await runRecommendSearchCli({
      workspaceRoot,
      searchParams: {
        school_tag: ["不限"],
        degree: ["不限"],
        gender: "不限",
        recent_not_view: "不限"
      },
      selectedJob: null,
      pageScope: "latest"
    });
    assert.equal(result.ok, true);
    const argv = result.summary?.argv || [];
    const pageScopeIndex = argv.indexOf("--page-scope");
    assert.equal(pageScopeIndex >= 0, true);
    assert.equal(argv[pageScopeIndex + 1], "latest");
    assert.equal(argv.includes("--calibration"), false);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function testScreenCliShouldPassPageScopeArgument() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-page-scope-home-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-page-scope-workspace-"));
  const cliDir = path.join(workspaceRoot, "boss-recommend-screen-cli");
  fs.mkdirSync(cliDir, { recursive: true });
  const cliPath = path.join(cliDir, "boss-recommend-screen-cli.cjs");
  fs.writeFileSync(
    cliPath,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({",
      "  status: 'COMPLETED',",
      "  result: {",
      "    processed_count: 0,",
      "    passed_count: 0,",
      "    skipped_count: 0,",
      "    argv: process.argv.slice(2),",
      "    resume_source: 'network',",
      "    active_tab_status: '3'",
      "  }",
      "}));"
    ].join("\n"),
    "utf8"
  );

  process.env.BOSS_RECOMMEND_HOME = tempHome;
  fs.writeFileSync(path.join(tempHome, "screening-config.json"), JSON.stringify({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-valid-test",
    model: "gpt-4.1-mini"
  }, null, 2));

  try {
    const result = await runRecommendScreenCli({
      workspaceRoot,
      screenParams: {
        criteria: "有 MCP 经验",
        target_count: null,
        post_action: "none",
        max_greet_count: null
      },
      pageScope: "featured"
    });
    assert.equal(result.ok, true);
    const argv = result.summary?.argv || [];
    const pageScopeIndex = argv.indexOf("--page-scope");
    assert.equal(pageScopeIndex >= 0, true);
    assert.equal(argv[pageScopeIndex + 1], "featured");
  } finally {
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function testScreenCliShouldPassLatestPageScopeArgument() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-page-scope-latest-home-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-page-scope-latest-workspace-"));
  const cliDir = path.join(workspaceRoot, "boss-recommend-screen-cli");
  fs.mkdirSync(cliDir, { recursive: true });
  const cliPath = path.join(cliDir, "boss-recommend-screen-cli.cjs");
  fs.writeFileSync(
    cliPath,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({",
      "  status: 'COMPLETED',",
      "  result: {",
      "    processed_count: 0,",
      "    passed_count: 0,",
      "    skipped_count: 0,",
      "    argv: process.argv.slice(2),",
      "    resume_source: 'image_fallback',",
      "    active_tab_status: '1'",
      "  }",
      "}));"
    ].join("\n"),
    "utf8"
  );

  process.env.BOSS_RECOMMEND_HOME = tempHome;
  fs.writeFileSync(path.join(tempHome, "screening-config.json"), JSON.stringify({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-valid-test",
    model: "gpt-4.1-mini"
  }, null, 2));

  try {
    const result = await runRecommendScreenCli({
      workspaceRoot,
      screenParams: {
        criteria: "有 MCP 经验",
        target_count: null,
        post_action: "none",
        max_greet_count: null
      },
      pageScope: "latest"
    });
    assert.equal(result.ok, true);
    const argv = result.summary?.argv || [];
    const pageScopeIndex = argv.indexOf("--page-scope");
    assert.equal(pageScopeIndex >= 0, true);
    assert.equal(argv[pageScopeIndex + 1], "latest");
  } finally {
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function testScreenCliShouldPassInputSummaryArgument() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-input-summary-home-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-input-summary-workspace-"));
  const cliDir = path.join(workspaceRoot, "boss-recommend-screen-cli");
  fs.mkdirSync(cliDir, { recursive: true });
  const cliPath = path.join(cliDir, "boss-recommend-screen-cli.cjs");
  fs.writeFileSync(
    cliPath,
    [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({",
      "  status: 'COMPLETED',",
      "  result: {",
      "    processed_count: 0,",
      "    passed_count: 0,",
      "    skipped_count: 0,",
      "    argv: process.argv.slice(2),",
      "    resume_source: 'network',",
      "    active_tab_status: '0'",
      "  }",
      "}));"
    ].join("\n"),
    "utf8"
  );

  process.env.BOSS_RECOMMEND_HOME = tempHome;
  fs.writeFileSync(path.join(tempHome, "screening-config.json"), JSON.stringify({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-valid-test",
    model: "gpt-4.1-mini"
  }, null, 2));

  try {
    const inputSummary = {
      instruction: "测试输入摘要",
      search_params: { school_tag: ["985"], gender: "男" },
      screen_params: { criteria: "有 MCP 经验" }
    };
    const result = await runRecommendScreenCli({
      workspaceRoot,
      screenParams: {
        criteria: "有 MCP 经验",
        target_count: null,
        post_action: "none",
        max_greet_count: null
      },
      inputSummary
    });
    assert.equal(result.ok, true);
    const argv = result.summary?.argv || [];
    const summaryIndex = argv.indexOf("--input-summary-json");
    assert.equal(summaryIndex >= 0, true);
    const parsedSummary = JSON.parse(String(argv[summaryIndex + 1] || "{}"));
    assert.equal(parsedSummary.instruction, "测试输入摘要");
    assert.equal(parsedSummary.search_params?.gender, "男");
    assert.equal(parsedSummary.screen_params?.criteria, "有 MCP 经验");
  } finally {
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

async function main() {
  await testRunProcessHeartbeatAndOutput();
  await testRunProcessAbortSignal();
  testParsePausedStructuredOutput();
  testParseScreenProgressLineShouldCountFavoriteFailureAsSkipped();
  testResolveScreenTimeoutDefaultsTo24Hours();
  testResolveSharedLlmTransportConfigShouldUseDefaultsAndOverrides();
  testBuildRecommendScreenProcessErrorMapsTimeout();
  await testResumeRequiresCheckpointFile();
  await testRecommendScreenCliShouldPassSharedLlmTransportArgs();
  testPreflightShouldCheckSharpInsteadOfPython();
  testPreflightFeaturedShouldRequireFavoriteCalibration();
  testPreflightRecommendShouldKeepFavoriteCalibrationOptional();
  testPreflightLatestShouldKeepFavoriteCalibrationOptional();
  await testEnsureFeaturedCalibrationReadyShouldAutoCalibrate();
  await testSearchCliShouldPassPageScopeArgument();
  await testSearchCliShouldPassLatestPageScopeWithoutCalibration();
  await testScreenCliShouldPassPageScopeArgument();
  await testScreenCliShouldPassLatestPageScopeArgument();
  await testScreenCliShouldPassInputSummaryArgument();
  console.log("adapters runtime tests passed");
}

await main();
