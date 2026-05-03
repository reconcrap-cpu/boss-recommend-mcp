#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildRecommendSelfHealConfig,
  classifyBossTargets,
  createAccessibilityProbe,
  createNetworkProbe,
  createSelectorProbe,
  HEALTH_STATUS,
  PROBE_STATUS,
  runAccessibilityProbe,
  runNetworkProbe,
  runRepairAction,
  runSelfHealCheck,
  runSelectorProbe
} from "./core/self-heal/index.js";

function makeFakeClient(selectorCounts = {}) {
  const calls = [];
  return {
    calls,
    DOM: {
      async querySelectorAll({ nodeId, selector }) {
        calls.push({ method: "DOM.querySelectorAll", nodeId, selector });
        const count = selectorCounts[`${nodeId}:${selector}`] ?? selectorCounts[selector] ?? 0;
        return {
          nodeIds: Array.from({ length: count }, (_, index) => index + 1)
        };
      }
    },
    Accessibility: {
      async getFullAXTree() {
        calls.push({ method: "Accessibility.getFullAXTree" });
        return {
          nodes: [
            { role: { value: "RootWebArea" }, name: { value: "Boss" } },
            { role: { value: "button" }, name: { value: "Confirm" } }
          ]
        };
      }
    },
    Page: {
      async reload(params) {
        calls.push({ method: "Page.reload", params });
        return {};
      }
    }
  };
}

async function testSelectorProbePasses() {
  const client = makeFakeClient({ ".ready": 2 });
  const result = await runSelectorProbe(client, { frame: 10 }, createSelectorProbe({
    id: "ready",
    selectors: [".ready"],
    required: true
  }));
  assert.equal(result.status, PROBE_STATUS.PASS);
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
}

async function testSelectorProbeFailureAffectsSummary() {
  const client = makeFakeClient();
  const check = await runSelfHealCheck({
    client,
    domain: "recommend",
    roots: { frame: 10 },
    selectorProbes: [
      createSelectorProbe({
        id: "missing_required",
        selectors: [".missing"],
        required: true
      }),
      createSelectorProbe({
        id: "missing_optional",
        selectors: [".optional"],
        required: false
      })
    ]
  });
  assert.equal(check.status, HEALTH_STATUS.DEGRADED);
  assert.deepEqual(check.summary.failed_required_ids, ["missing_required"]);
  assert.deepEqual(check.summary.optional_absent_ids, ["missing_optional"]);
  assert.equal(check.drift_report.length, 1);
}

async function testMissingRootBlocksRequiredProbe() {
  const client = makeFakeClient();
  const result = await runSelectorProbe(client, {}, createSelectorProbe({
    id: "needs_frame",
    root: "frame",
    selectors: [".ready"],
    required: true
  }));
  assert.equal(result.status, PROBE_STATUS.BLOCKED);
  assert.equal(result.ok, false);
}

async function testAccessibilityAndNetworkProbes() {
  const client = makeFakeClient();
  const ax = await runAccessibilityProbe(client, createAccessibilityProbe({
    id: "buttons",
    required: true,
    roleIncludes: ["button"]
  }));
  assert.equal(ax.status, PROBE_STATUS.PASS);
  assert.equal(ax.count, 1);

  const network = runNetworkProbe([
    { url: "https://www.zhipin.com/wapi/example" },
    { url: "https://example.com" }
  ], createNetworkProbe({
    id: "boss_network",
    required: true,
    urlPatterns: ["zhipin.com"]
  }));
  assert.equal(network.status, PROBE_STATUS.PASS);
  assert.equal(network.count, 1);
}

async function testRepairAction() {
  const client = makeFakeClient();
  const result = await runRepairAction(client, {
    id: "refresh",
    type: "page_reload",
    ignoreCache: true,
    waitMs: 0
  });
  assert.equal(result.ok, true);
  assert.deepEqual(client.calls.at(-1), {
    method: "Page.reload",
    params: { ignoreCache: true }
  });
}

function testTargetClassificationAndConfig() {
  const targets = classifyBossTargets([
    {
      id: "recommend",
      type: "page",
      url: "https://www.zhipin.com/web/chat/recommend",
      title: "recommend"
    },
    {
      id: "search",
      type: "page",
      url: "https://www.zhipin.com/web/chat/search",
      title: "search"
    },
    {
      id: "chat",
      type: "page",
      url: "https://www.zhipin.com/web/chat/index",
      title: "chat"
    }
  ]);
  assert.equal(targets.recommend.status, "available");
  assert.equal(targets.recruit.status, "available");
  assert.equal(targets.chat.status, "available");

  const config = buildRecommendSelfHealConfig();
  assert.equal(config.domain, "recommend");
  assert.ok(config.selectorProbes.some((probe) => probe.id === "candidate_cards" && probe.required));
  assert.ok(config.accessibilityProbes.length > 0);
  assert.ok(config.networkProbes.length > 0);
}

await testSelectorProbePasses();
await testSelectorProbeFailureAffectsSummary();
await testMissingRootBlocksRequiredProbe();
await testAccessibilityAndNetworkProbes();
await testRepairAction();
testTargetClassificationAndConfig();

console.log("core self-heal tests passed");
