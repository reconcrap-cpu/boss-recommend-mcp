import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPipelinePreflight, runRecommendScreenCli, __testables as adapterTestables } from "./adapters.js";

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

function testPreflightShouldCheckSharpInsteadOfPython() {
  const preflight = runPipelinePreflight(process.cwd());
  const keys = new Set((preflight.checks || []).map((item) => item?.key));
  assert.equal(keys.has("npm_dep_sharp"), true);
  assert.equal(keys.has("python_cli"), false);
  assert.equal(keys.has("python_pillow"), false);
}

async function main() {
  await testRunProcessHeartbeatAndOutput();
  await testRunProcessAbortSignal();
  testParsePausedStructuredOutput();
  testParseScreenProgressLineShouldCountFavoriteFailureAsSkipped();
  testResolveScreenTimeoutDefaultsTo24Hours();
  testBuildRecommendScreenProcessErrorMapsTimeout();
  await testResumeRequiresCheckpointFile();
  testPreflightShouldCheckSharpInsteadOfPython();
  console.log("adapters runtime tests passed");
}

await main();
