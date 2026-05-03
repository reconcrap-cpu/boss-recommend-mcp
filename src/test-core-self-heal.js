#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildRecommendSelfHealConfig,
  buildViewportHealthDiagnostics,
  classifyBossTargets,
  createAccessibilityProbe,
  createNetworkProbe,
  createSelectorProbe,
  createViewportCollapseProbe,
  HEALTH_STATUS,
  isListViewportCollapsed,
  PROBE_STATUS,
  runAccessibilityProbe,
  runNetworkProbe,
  runRepairAction,
  runSelfHealCheck,
  runSelectorProbe,
  runViewportCollapseProbe
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
      async getLayoutMetrics() {
        calls.push({ method: "Page.getLayoutMetrics" });
        return {
          cssVisualViewport: {
            clientWidth: selectorCounts.layoutWidth || 1280,
            clientHeight: selectorCounts.layoutHeight || 720,
            scale: 1
          },
          cssLayoutViewport: {
            clientWidth: selectorCounts.layoutWidth || 1280,
            clientHeight: selectorCounts.layoutHeight || 720
          }
        };
      },
      async bringToFront() {
        calls.push({ method: "Page.bringToFront" });
        return {};
      },
      async reload(params) {
        calls.push({ method: "Page.reload", params });
        return {};
      }
    },
    Browser: {
      async getWindowForTarget() {
        calls.push({ method: "Browser.getWindowForTarget" });
        return {
          windowId: 7,
          bounds: {
            windowState: selectorCounts.windowState || "maximized",
            width: selectorCounts.windowWidth || 1440,
            height: selectorCounts.windowHeight || 900
          }
        };
      },
      async getWindowBounds(params) {
        calls.push({ method: "Browser.getWindowBounds", params });
        return {
          bounds: {
            windowState: selectorCounts.windowState || "maximized",
            width: selectorCounts.windowWidth || 1440,
            height: selectorCounts.windowHeight || 900
          }
        };
      },
      async setWindowBounds(params) {
        calls.push({ method: "Browser.setWindowBounds", params });
        return {};
      }
    }
  };
}

function makeViewportFakeClient({
  widthSequence = [785, 1280],
  height = 585,
  windowState = "maximized",
  windowWidth = 1440
} = {}) {
  const calls = [];
  let boxIndex = 0;
  return {
    calls,
    DOM: {
      async getBoxModel({ nodeId }) {
        calls.push({ method: "DOM.getBoxModel", nodeId });
        const width = widthSequence[Math.min(boxIndex, widthSequence.length - 1)];
        boxIndex += 1;
        return {
          model: {
            border: [0, 0, width, 0, width, height, 0, height],
            content: [0, 0, width, 0, width, height, 0, height]
          }
        };
      }
    },
    Page: {
      async getLayoutMetrics() {
        calls.push({ method: "Page.getLayoutMetrics" });
        const width = widthSequence[Math.min(boxIndex, widthSequence.length - 1)];
        return {
          cssVisualViewport: {
            clientWidth: width,
            clientHeight: height,
            scale: 1
          },
          cssLayoutViewport: {
            clientWidth: width,
            clientHeight: height
          }
        };
      },
      async bringToFront() {
        calls.push({ method: "Page.bringToFront" });
        return {};
      }
    },
    Browser: {
      async getWindowForTarget() {
        calls.push({ method: "Browser.getWindowForTarget" });
        return {
          windowId: 7,
          bounds: {
            windowState,
            width: windowWidth,
            height: 900
          }
        };
      },
      async getWindowBounds(params) {
        calls.push({ method: "Browser.getWindowBounds", params });
        return {
          bounds: {
            windowState,
            width: windowWidth,
            height: 900
          }
        };
      },
      async setWindowBounds(params) {
        calls.push({ method: "Browser.setWindowBounds", params });
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

async function testViewportCollapseDiagnosticsCopyLegacyThresholds() {
  const state = {
    ok: true,
    clientWidth: 785,
    clientHeight: 585,
    frameRect: {
      width: 785,
      height: 585
    },
    viewport: {
      width: 785,
      height: 585
    },
    topViewport: {
      screenAvailWidth: 1440,
      outerWidth: 1454
    }
  };
  state.viewportDiagnostics = buildViewportHealthDiagnostics(state, {
    bounds: {
      windowState: "maximized",
      width: 1454
    }
  }, {
    cssVisualViewport: {
      clientWidth: 785,
      clientHeight: 585
    }
  });
  assert.equal(state.viewportDiagnostics.relativeCollapsed, true);
  assert.equal(isListViewportCollapsed(state), true);
  assert.equal(Math.round(state.viewportDiagnostics.widthRatio * 1000), 545);

  const normalWindow = {
    ...state,
    topViewport: {
      screenAvailWidth: 1440,
      outerWidth: 800
    }
  };
  normalWindow.viewportDiagnostics = buildViewportHealthDiagnostics(normalWindow, {
    bounds: {
      windowState: "normal",
      width: 800
    }
  }, {
    cssVisualViewport: {
      clientWidth: 785,
      clientHeight: 585
    }
  });
  assert.equal(normalWindow.viewportDiagnostics.nearFullscreen, false);
  assert.equal(normalWindow.viewportDiagnostics.relativeCollapsed, false);
  assert.equal(isListViewportCollapsed(normalWindow), false);
}

async function testViewportCollapseProbeRepairs() {
  const client = makeViewportFakeClient({
    widthSequence: [785, 1280],
    windowState: "maximized",
    windowWidth: 1440
  });
  const result = await runViewportCollapseProbe(client, { frame: 10 }, createViewportCollapseProbe({
    id: "viewport",
    root: "frame",
    required: true,
    repair: true
  }));
  assert.equal(result.status, PROBE_STATUS.PASS);
  assert.equal(result.viewport_health.recovered, true);
  assert.equal(result.viewport_health.before.collapsed, true);
  assert.equal(result.viewport_health.state.collapsed, false);
  assert.deepEqual(
    client.calls
      .filter((call) => call.method === "Browser.setWindowBounds")
      .map((call) => call.params.bounds.windowState),
    ["normal", "maximized"]
  );
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
  assert.ok(config.viewportProbes.some((probe) => probe.id === "recommend_viewport_collapse" && probe.required));
  assert.ok(config.accessibilityProbes.length > 0);
  assert.ok(config.networkProbes.length > 0);
}

await testSelectorProbePasses();
await testSelectorProbeFailureAffectsSummary();
await testMissingRootBlocksRequiredProbe();
await testAccessibilityAndNetworkProbes();
await testRepairAction();
await testViewportCollapseDiagnosticsCopyLegacyThresholds();
await testViewportCollapseProbeRepairs();
testTargetClassificationAndConfig();

console.log("core self-heal tests passed");
