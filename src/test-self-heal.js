import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables as indexTestables } from "./index.js";
import { runRecommendSelfHeal, __testables as selfHealTestables } from "./self-heal.js";

const {
  handleRequest,
  setRunSelfHealImplForTests
} = indexTestables;

const TOOL_RUN_RECOMMEND_SELF_HEAL = "run_recommend_self_heal";

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

async function readToolPayload(response) {
  return response?.result?.structuredContent;
}

async function callTool(name, args, id = 1) {
  const response = await handleRequest(makeToolCall(id, name, args), process.cwd());
  return {
    payload: await readToolPayload(response),
    response
  };
}

async function testToolsListShouldIncludeSelfHeal() {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, process.cwd());
  const tools = response?.result?.tools || [];
  assert.equal(tools.some((tool) => tool?.name === TOOL_RUN_RECOMMEND_SELF_HEAL), true);
}

async function testIndexShouldRouteSelfHealTool() {
  setRunSelfHealImplForTests(async () => ({ status: "HEALTHY", message: "ok" }));
  try {
    const { payload } = await callTool(TOOL_RUN_RECOMMEND_SELF_HEAL, {}, 2);
    assert.equal(payload?.status, "HEALTHY");
  } finally {
    setRunSelfHealImplForTests(null);
  }
}

async function testScanShouldCreateRepairSession() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-self-heal-home-"));
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  try {
    const result = await runRecommendSelfHeal(
      { workspaceRoot: process.cwd(), args: { mode: "scan" } },
      {
        scanRuntimeSurface: async () => ({
          selector_checks: [
            {
              rule_id: "filter_trigger",
              path: ["frame", "filter_trigger"],
              root: "frame",
              matches: [
                { selector: ".filter-label-wrap", index: 0, count: 0 },
                { selector: ".recommend-filter.op-filter", index: 1, count: 1 }
              ]
            }
          ],
          network_checks: [],
          side_effect_summary: { opened_candidate_detail: false }
        })
      }
    );
    assert.equal(result.status, "NEED_CONFIRMATION");
    assert.equal(typeof result.repair_session_id, "string");
    assert.equal(result.proposed_repairs.length, 1);
    const sessionPath = path.join(selfHealTestables.getSelfHealSessionsDir(), `${result.repair_session_id}.json`);
    assert.equal(fs.existsSync(sessionPath), true);
  } finally {
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

async function testOptionalSelectorMissShouldNotBecomeDrift() {
  const drifts = selfHealTestables.analyzeSelectorChecks([
    {
      rule_id: "featured_cards",
      path: ["frame", "featured_cards"],
      root: "frame",
      required: false,
      report_on_no_match: false,
      skipped: false,
      matches: [
        { selector: "li.geek-info-card", index: 0, count: 0 }
      ]
    }
  ]);
  assert.equal(drifts.length, 0);
}

async function testApplyShouldRequireConfirmation() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-self-heal-apply-home-"));
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  try {
    const scanResult = await runRecommendSelfHeal(
      { workspaceRoot: process.cwd(), args: { mode: "scan" } },
      {
        scanRuntimeSurface: async () => ({
          selector_checks: [
            {
              rule_id: "filter_trigger",
              path: ["frame", "filter_trigger"],
              root: "frame",
              matches: [
                { selector: ".filter-label-wrap", index: 0, count: 0 },
                { selector: ".recommend-filter.op-filter", index: 1, count: 1 }
              ]
            }
          ],
          network_checks: [],
          side_effect_summary: null
        })
      }
    );
    const result = await runRecommendSelfHeal({
      workspaceRoot: process.cwd(),
      args: {
        mode: "apply",
        repair_session_id: scanResult.repair_session_id
      }
    });
    assert.equal(result.status, "FAILED");
    assert.equal(result.error?.code, "SELF_HEAL_CONFIRMATION_REQUIRED");
  } finally {
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

async function testApplyShouldUpdateRulesFile() {
  const previousHome = process.env.BOSS_RECOMMEND_HOME;
  const previousRulesPath = process.env.BOSS_RECOMMEND_HEALING_RULES_FILE;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-self-heal-rules-home-"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-self-heal-rules-"));
  const rulesSourcePath = path.join(process.cwd(), "src", "recommend-healing-rules.json");
  const tempRulesPath = path.join(tempDir, "recommend-healing-rules.json");
  fs.copyFileSync(rulesSourcePath, tempRulesPath);
  process.env.BOSS_RECOMMEND_HOME = tempHome;
  process.env.BOSS_RECOMMEND_HEALING_RULES_FILE = tempRulesPath;
  try {
    const scanResult = await runRecommendSelfHeal(
      { workspaceRoot: process.cwd(), args: { mode: "scan" } },
      {
        scanRuntimeSurface: async () => ({
          selector_checks: [
            {
              rule_id: "filter_trigger",
              path: ["frame", "filter_trigger"],
              root: "frame",
              matches: [
                { selector: ".filter-label-wrap", index: 0, count: 0 },
                { selector: ".recommend-filter.op-filter", index: 1, count: 1 }
              ]
            }
          ],
          network_checks: [],
          side_effect_summary: null
        })
      }
    );
    const result = await runRecommendSelfHeal({
      workspaceRoot: process.cwd(),
      args: {
        mode: "apply",
        repair_session_id: scanResult.repair_session_id,
        confirm_apply: true
      }
    });
    assert.equal(result.status, "REPAIRED");
    const updatedRules = JSON.parse(fs.readFileSync(tempRulesPath, "utf8"));
    assert.equal(updatedRules.selectors.frame.filter_trigger[0], ".recommend-filter.op-filter");
  } finally {
    if (previousHome === undefined) {
      delete process.env.BOSS_RECOMMEND_HOME;
    } else {
      process.env.BOSS_RECOMMEND_HOME = previousHome;
    }
    if (previousRulesPath === undefined) {
      delete process.env.BOSS_RECOMMEND_HEALING_RULES_FILE;
    } else {
      process.env.BOSS_RECOMMEND_HEALING_RULES_FILE = previousRulesPath;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  await testToolsListShouldIncludeSelfHeal();
  await testIndexShouldRouteSelfHealTool();
  await testScanShouldCreateRepairSession();
  await testOptionalSelectorMissShouldNotBecomeDrift();
  await testApplyShouldRequireConfirmation();
  await testApplyShouldUpdateRulesFile();
  console.log("self-heal tests passed");
}

await main();
