#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  buildRecommendSelfHealConfig,
  buildViewportHealthDiagnostics,
  classifyBossTargets,
  createAccessibilityProbe,
  createNetworkProbe,
  createSelectorProbe,
  createViewportRunGuard,
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
  heightSequence = [585],
  windowState = "maximized",
  windowWidthSequence = [1440],
  windowHeightSequence = [900],
  windowId = 7,
  windowLeft = 120,
  windowTop = 80,
  restorationReadbackBounds = null,
  unreadableAt = []
} = {}) {
  const calls = [];
  let sampleIndex = 0;
  let windowMutationCount = 0;
  const sample = (sequence) => sequence[Math.min(sampleIndex, sequence.length - 1)];
  const unreadableSamples = new Set(unreadableAt);
  const currentWindowBounds = () => {
    if (windowMutationCount >= 2 && restorationReadbackBounds) {
      return {
        windowState,
        left: windowLeft,
        top: windowTop,
        width: sample(windowWidthSequence),
        height: sample(windowHeightSequence),
        ...restorationReadbackBounds
      };
    }
    return {
      windowState,
      left: windowLeft,
      top: windowTop,
      width: sample(windowWidthSequence),
      height: sample(windowHeightSequence)
    };
  };
  return {
    calls,
    DOM: {
      async getBoxModel({ nodeId }) {
        calls.push({ method: "DOM.getBoxModel", nodeId });
        const index = sampleIndex;
        const width = sample(widthSequence);
        const height = sample(heightSequence);
        sampleIndex += 1;
        if (unreadableSamples.has(index)) {
          throw new Error("Could not find node with given id");
        }
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
        const width = sample(widthSequence);
        const height = sample(heightSequence);
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
          windowId,
          bounds: currentWindowBounds()
        };
      },
      async getWindowBounds(params) {
        calls.push({ method: "Browser.getWindowBounds", params });
        return {
          bounds: currentWindowBounds()
        };
      },
      async setWindowBounds(params) {
        calls.push({ method: "Browser.setWindowBounds", params });
        windowMutationCount += 1;
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
      browserWindowWidth: 1440,
      outerWidth: 1454
    }
  };
  state.viewportDiagnostics = buildViewportHealthDiagnostics(state, {
    bounds: {
      windowState: "maximized",
      width: 1440,
      height: 900
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
  assert.equal(state.viewportDiagnostics.browserWindowWidth, 1440);
  assert.equal("screenAvailWidth" in state.viewportDiagnostics, false);

  const normalWindow = {
    ...state,
    topViewport: {
      browserWindowWidth: 800,
      outerWidth: 800
    }
  };
  normalWindow.viewportDiagnostics = buildViewportHealthDiagnostics(normalWindow, {
    bounds: {
      windowState: "normal",
      width: 800,
      height: 700
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
    widthSequence: [785, 1280, 1280],
    windowState: "maximized",
    windowWidthSequence: [1440]
  });
  const reacquiredRootIds = [20, 30];
  const result = await runViewportCollapseProbe(client, { frame: 10 }, createViewportCollapseProbe({
    id: "viewport",
    root: "frame",
    required: true,
    repair: true
  }), {
    reacquireRoots: async () => ({
      rootNodes: { frame: reacquiredRootIds.shift() }
    })
  });
  assert.equal(result.status, PROBE_STATUS.PASS);
  assert.equal(result.viewport_health.recovered, true);
  assert.equal(result.viewport_health.before.collapsed, true);
  assert.equal(result.viewport_health.state.collapsed, false);
  assert.equal(result.viewport_health.rootReacquisition.verified, true);
  assert.deepEqual(
    result.viewport_health.rootReacquisition.samples.map((sample) => sample.targetRootNodeId),
    [20, 30]
  );
  assert.deepEqual(
    client.calls
      .filter((call) => call.method === "Browser.setWindowBounds")
      .map((call) => call.params.bounds.windowState),
    ["normal", "maximized"]
  );
}

async function testViewportRecoveryRestoresNormalWindowState() {
  const client = makeViewportFakeClient({
    widthSequence: [785, 1280, 1280],
    windowState: "normal",
    windowWidthSequence: [1440]
  });
  const result = await runViewportCollapseProbe(client, { frame: 10 }, createViewportCollapseProbe({
    id: "viewport-normal-window",
    root: "frame",
    required: true,
    repair: true
  }), {
    reacquireRoots: async () => ({ rootNodes: { frame: 10 } })
  });
  assert.equal(result.status, PROBE_STATUS.PASS);
  assert.equal(result.viewport_health.recovered, true);
  assert.deepEqual(
    client.calls
      .filter((call) => call.method === "Browser.setWindowBounds")
      .map((call) => call.params.bounds.windowState),
    ["maximized", "normal"]
  );
  assert.equal(result.viewport_health.repair.original_state_restored, true);
  assert.equal(result.viewport_health.repair.restoration.verified, true);
  const restoreCall = client.calls
    .filter((call) => call.method === "Browser.setWindowBounds")
    .at(-1);
  assert.deepEqual(restoreCall.params, {
    windowId: 7,
    bounds: {
      windowState: "normal",
      left: 120,
      top: 80,
      width: 1440,
      height: 900
    }
  });
}

async function testViewportGuardDetectsCumulativeWidthLoss() {
  const client = makeViewportFakeClient({
    widthSequence: [1280, 1280, 1277, 1275, 1273],
    heightSequence: [720]
  });
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: false
  });
  const rootState = { frame: 10 };

  const established = await guard.ensure(rootState, { phase: "baseline" });
  assert.equal(established.health.baselineEstablished, true);
  assert.equal(guard.getBaseline().stableSamples, 2);
  await guard.ensure(rootState, { phase: "width_loss_3" });
  await guard.ensure(rootState, { phase: "width_loss_5" });

  await assert.rejects(
    () => guard.ensure(rootState, { phase: "width_loss_7" }),
    (error) => {
      assert.equal(error.code, "LIST_VIEWPORT_COLLAPSED");
      assert.equal(
        error.viewport_health.state.baselineComparison.dimensions.viewportWidth.expected,
        1280
      );
      assert.equal(
        error.viewport_health.state.baselineComparison.dimensions.viewportWidth.actual,
        1273
      );
      assert.equal(error.viewport_health.state.collapseEvidence.baselineDrift, true);
      return true;
    }
  );
  assert.equal(guard.getStats().baseline_drift_detections, 1);
}

async function testViewportGuardDetectsCumulativeHeightLoss() {
  const client = makeViewportFakeClient({
    widthSequence: [1280],
    heightSequence: [720, 720, 718, 716, 715]
  });
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: false
  });
  const rootState = { frame: 10 };

  await guard.ensure(rootState, { phase: "baseline" });
  await guard.ensure(rootState, { phase: "height_loss_2" });
  await guard.ensure(rootState, { phase: "height_loss_4" });
  await assert.rejects(
    () => guard.ensure(rootState, { phase: "height_loss_5" }),
    (error) => {
      assert.equal(error.code, "LIST_VIEWPORT_COLLAPSED");
      assert.equal(
        error.viewport_health.state.baselineComparison.dimensions.viewportHeight.expected,
        720
      );
      assert.equal(
        error.viewport_health.state.baselineComparison.dimensions.viewportHeight.actual,
        715
      );
      assert.equal(error.viewport_health.state.collapseEvidence.baselineDrift, true);
      return true;
    }
  );
}

async function testViewportGuardRebaselinesOnlyForVerifiedWindowResize() {
  const client = makeViewportFakeClient({
    widthSequence: [1280, 1280, 1040, 1040],
    heightSequence: [720, 720, 640, 640],
    windowWidthSequence: [1440, 1440, 1200, 1200],
    windowHeightSequence: [900, 900, 800, 800]
  });
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: false
  });
  const rootState = { frame: 10 };

  await guard.ensure(rootState, { phase: "baseline" });
  const resized = await guard.ensure(rootState, { phase: "external_resize" });
  assert.equal(resized.health.rebaselined, true);
  assert.equal(resized.health.windowBoundsChange.verified, true);
  assert.equal(resized.health.windowBoundsChange.changed, true);
  assert.equal(resized.health.windowBoundsChange.widthDelta, -240);
  assert.equal(resized.health.windowBoundsChange.heightDelta, -100);
  assert.equal(guard.getBaseline().dimensions.viewportWidth, 1040);
  assert.equal(guard.getBaseline().dimensions.viewportHeight, 640);
  assert.equal(guard.getStats().rebaselines, 1);
}

async function testViewportGuardRejectsUnstableWindowResizeWithoutRatchetingBaseline() {
  const client = makeViewportFakeClient({
    widthSequence: [1280, 1280, 1040, 1020],
    heightSequence: [720, 720, 640, 620],
    windowWidthSequence: [1440, 1440, 1200, 1180],
    windowHeightSequence: [900, 900, 800, 780]
  });
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: true,
    recoveryDelayMs: 0,
    recoverySettleMs: 0,
    getRoots: async () => ({ rootNodes: { frame: 10 } })
  });
  const rootState = { rootNodes: { frame: 10 } };

  await guard.ensure(rootState, { phase: "baseline" });
  const originalBaseline = structuredClone(guard.getBaseline());
  await assert.rejects(
    () => guard.ensure(rootState, { phase: "unstable_external_resize" }),
    (error) => {
      assert.equal(error.code, "LIST_VIEWPORT_COLLAPSED");
      assert.equal(error.viewport_health.rebaselined, false);
      assert.equal(error.viewport_health.stability.verified, false);
      assert.match(error.viewport_health.error, /not stable across two healthy readings/i);
      return true;
    }
  );
  assert.deepEqual(guard.getBaseline(), originalBaseline);
  assert.equal(guard.getStats().rebaselines, 0);
}

async function testViewportGuardTreatsUnreadableRootAsUnsafe() {
  const client = makeViewportFakeClient({
    widthSequence: [1280],
    heightSequence: [720],
    unreadableAt: [2]
  });
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: false
  });
  const rootState = { frame: 10 };

  await guard.ensure(rootState, { phase: "baseline" });
  await assert.rejects(
    () => guard.ensure(rootState, { phase: "unreadable_root" }),
    (error) => {
      assert.equal(error.code, "LIST_VIEWPORT_COLLAPSED");
      assert.equal(error.viewport_health.state.ok, false);
      assert.equal(error.viewport_health.state.measurementEvidence.contentRectReadable, false);
      assert.match(error.viewport_health.error, /geometry is unreadable/i);
      return true;
    }
  );
  assert.equal(guard.getStats().unreadable_measurements, 1);
}

async function testViewportGuardReacquiresUnreadableRootsBeforeFailing() {
  const client = makeViewportFakeClient({
    widthSequence: [1280],
    heightSequence: [720],
    unreadableAt: [2]
  });
  const freshRootStates = [
    { rootNodes: { frame: 20 } },
    { rootNodes: { frame: 30 } }
  ];
  let getRootsCalls = 0;
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: true,
    recoveryDelayMs: 0,
    recoverySettleMs: 0,
    getRoots: async () => {
      const state = freshRootStates[Math.min(getRootsCalls, freshRootStates.length - 1)];
      getRootsCalls += 1;
      return state;
    }
  });
  const staleRootState = { rootNodes: { frame: 10 } };

  await guard.ensure(staleRootState, { phase: "baseline" });
  const recovered = await guard.ensure(staleRootState, { phase: "unreadable_root" });

  assert.equal(recovered.health.ok, true);
  assert.equal(recovered.health.recovered, true);
  assert.equal(recovered.health.recoveryMode, "root_reacquisition");
  assert.equal(recovered.health.before.collapseEvidence.unreadable, true);
  assert.equal(recovered.health.stability.verified, true);
  assert.equal(recovered.health.rootReacquisition.verified, true);
  assert.equal(getRootsCalls, 2);
  assert.deepEqual(
    recovered.health.rootReacquisition.samples.map((sample) => sample.targetRootNodeId),
    [20, 30]
  );
  assert.deepEqual(
    client.calls
      .filter((call) => call.method === "DOM.getBoxModel")
      .slice(-3)
      .map((call) => call.nodeId),
    [10, 20, 30]
  );
  assert.equal(
    client.calls.some((call) => call.method === "Browser.setWindowBounds"),
    false
  );
  assert.equal(recovered.rootState, freshRootStates[1]);
  assert.equal(guard.getStats().recoveries, 1);
  assert.equal(guard.getStats().unreadable_measurements, 1);
}

async function testViewportGuardAcceptsFreshRootWithoutFalseRecovery() {
  const client = makeViewportFakeClient({
    widthSequence: [1280],
    heightSequence: [720]
  });
  const originalGetBoxModel = client.DOM.getBoxModel.bind(client.DOM);
  let oldRootInvalid = false;
  client.DOM.getBoxModel = async (params) => {
    if (oldRootInvalid && params.nodeId === 10) {
      throw new Error("Could not find node with given id");
    }
    return originalGetBoxModel(params);
  };
  let getRootsCalls = 0;
  const guard = createViewportRunGuard({
    client,
    domain: "chat",
    repair: true,
    recoveryDelayMs: 0,
    recoverySettleMs: 0,
    getRoots: async () => {
      getRootsCalls += 1;
      return { rootNodes: { frame: 30 } };
    }
  });

  await guard.ensure({ rootNodes: { frame: 10 } }, { phase: "baseline" });
  oldRootInvalid = true;
  const callsBeforeFreshCheck = client.calls.filter((call) => call.method === "DOM.getBoxModel").length;
  const fresh = await guard.ensure({ rootNodes: { frame: 20 } }, { phase: "candidate_loop" });
  const freshBoxCalls = client.calls
    .filter((call) => call.method === "DOM.getBoxModel")
    .slice(callsBeforeFreshCheck);

  assert.equal(fresh.health.ok, true);
  assert.equal(fresh.health.recovered, false);
  assert.equal(getRootsCalls, 0);
  assert.deepEqual(freshBoxCalls.map((call) => call.nodeId), [20]);
  assert.equal(guard.getStats().recoveries, 0);
  assert.equal(guard.getStats().unreadable_measurements, 0);
}

async function testViewportGuardRepairsRealCollapseAfterUnreadableRoot() {
  const client = makeViewportFakeClient({
    widthSequence: [1280, 1280, 1280, 1250, 1280, 1280],
    heightSequence: [720],
    unreadableAt: [2]
  });
  const freshRootStates = [
    { rootNodes: { frame: 20 } },
    { rootNodes: { frame: 30 } },
    { rootNodes: { frame: 40 } }
  ];
  let getRootsCalls = 0;
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: true,
    recoveryDelayMs: 0,
    recoverySettleMs: 0,
    getRoots: async () => {
      const state = freshRootStates[Math.min(getRootsCalls, freshRootStates.length - 1)];
      getRootsCalls += 1;
      return state;
    }
  });
  const staleRootState = { rootNodes: { frame: 10 } };

  await guard.ensure(staleRootState, { phase: "baseline" });
  const recovered = await guard.ensure(staleRootState, { phase: "unreadable_then_collapsed" });

  assert.equal(recovered.health.ok, true);
  assert.equal(recovered.health.recovered, true);
  assert.equal(recovered.health.before.collapseEvidence.baselineDrift, true);
  assert.equal(recovered.health.state.collapsed, false);
  assert.equal(recovered.health.repair.original_state_restored, true);
  assert.equal(recovered.health.stability.verified, true);
  assert.equal(getRootsCalls, 3);
  assert.deepEqual(
    recovered.health.rootReacquisition.samples.map((sample) => sample.targetRootNodeId),
    [30, 40]
  );
  assert.deepEqual(
    client.calls
      .filter((call) => call.method === "Browser.setWindowBounds")
      .map((call) => call.params.bounds.windowState),
    ["normal", "maximized"]
  );
  assert.equal(recovered.rootState, freshRootStates[2]);
}

async function testViewportGuardRecoversBackToOriginalBaseline() {
  const client = makeViewportFakeClient({
    widthSequence: [1280, 1280, 1250, 1280, 1280],
    heightSequence: [720]
  });
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: true,
    recoveryDelayMs: 0,
    recoverySettleMs: 0,
    getRoots: async () => ({ rootNodes: { frame: 10 } })
  });
  const rootState = { frame: 10 };

  await guard.ensure(rootState, { phase: "baseline" });
  const recovered = await guard.ensure(rootState, { phase: "recover_width" });
  assert.equal(recovered.health.recovered, true);
  assert.equal(recovered.health.stability.verified, true);
  assert.equal(recovered.health.before.collapseEvidence.baselineDrift, true);
  assert.equal(recovered.health.state.baselineComparison.drifted, false);
  assert.equal(guard.getBaseline().dimensions.viewportWidth, 1280);
  assert.equal(guard.getStats().recoveries, 1);
}

async function testViewportAcceptsDomainRootStateShape() {
  const client = makeViewportFakeClient({
    widthSequence: [1280, 1280],
    heightSequence: [720, 720]
  });
  const result = await runViewportCollapseProbe(
    client,
    { rootNodes: { frame: 42 } },
    createViewportCollapseProbe({
      id: "domain-root-state-shape",
      root: "frame",
      required: true,
      repair: false
    })
  );
  assert.equal(result.status, PROBE_STATUS.PASS);
  assert.deepEqual(
    client.calls
      .filter((call) => call.method === "DOM.getBoxModel")
      .map((call) => call.nodeId),
    [42, 42]
  );
}

async function testViewportRecoveryReacquiresRootsBeforeEveryStableSample() {
  const client = makeViewportFakeClient({
    widthSequence: [1280, 1280, 1250, 1280, 1280],
    heightSequence: [720]
  });
  const freshRootStates = [
    { rootNodes: { frame: 20 } },
    { rootNodes: { frame: 30 } }
  ];
  let getRootsCalls = 0;
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: true,
    recoveryDelayMs: 0,
    recoverySettleMs: 0,
    getRoots: async () => {
      const state = freshRootStates[Math.min(getRootsCalls, freshRootStates.length - 1)];
      getRootsCalls += 1;
      return state;
    }
  });
  const originalRootState = { rootNodes: { frame: 10 } };

  await guard.ensure(originalRootState, { phase: "baseline" });
  const recovered = await guard.ensure(originalRootState, { phase: "fresh_roots" });
  assert.equal(recovered.health.recovered, true);
  assert.equal(getRootsCalls, 2);
  assert.deepEqual(
    recovered.health.rootReacquisition.samples.map((sample) => sample.targetRootNodeId),
    [20, 30]
  );
  assert.deepEqual(
    client.calls
      .filter((call) => call.method === "DOM.getBoxModel")
      .slice(-2)
      .map((call) => call.nodeId),
    [20, 30]
  );
  assert.equal(recovered.rootState, freshRootStates[1]);
}

async function testViewportRecoveryPreservesWindowIdZero() {
  const client = makeViewportFakeClient({
    widthSequence: [785, 1280, 1280],
    heightSequence: [585],
    windowId: 0,
    windowState: "normal"
  });
  const result = await runViewportCollapseProbe(client, { frame: 10 }, createViewportCollapseProbe({
    id: "window-id-zero",
    root: "frame",
    required: true,
    repair: true
  }), {
    reacquireRoots: async () => ({ rootNodes: { frame: 10 } })
  });
  assert.equal(result.status, PROBE_STATUS.PASS);
  assert.equal(result.viewport_health.repair.original_state_restored, true);
  const windowCalls = client.calls.filter((call) => [
    "Browser.getWindowBounds",
    "Browser.setWindowBounds"
  ].includes(call.method));
  assert.ok(windowCalls.length > 0);
  assert.ok(windowCalls.every((call) => call.params.windowId === 0));
}

async function testViewportRecoveryRejectsPartialWindowRestorationWithoutRatchetingBaseline() {
  const client = makeViewportFakeClient({
    widthSequence: [1280, 1280, 1250, 1280, 1280],
    heightSequence: [720],
    restorationReadbackBounds: {
      windowState: "normal",
      width: 1320,
      height: 820
    }
  });
  let getRootsCalls = 0;
  const guard = createViewportRunGuard({
    client,
    domain: "recommend",
    repair: true,
    recoveryDelayMs: 0,
    recoverySettleMs: 0,
    getRoots: async () => {
      getRootsCalls += 1;
      return { rootNodes: { frame: 20 + getRootsCalls } };
    }
  });
  const rootState = { rootNodes: { frame: 10 } };

  await guard.ensure(rootState, { phase: "baseline" });
  const originalBaseline = structuredClone(guard.getBaseline());
  await assert.rejects(
    () => guard.ensure(rootState, { phase: "partial_window_restore" }),
    (error) => {
      assert.equal(error.code, "LIST_VIEWPORT_COLLAPSED");
      assert.equal(error.viewport_health.repair.original_state_restored, false);
      assert.equal(error.viewport_health.repair.restoration.verified, false);
      assert.match(error.viewport_health.error, /window state and bounds were not verified/i);
      return true;
    }
  );
  assert.equal(getRootsCalls, 0);
  assert.deepEqual(guard.getBaseline(), originalBaseline);
  assert.equal(guard.getBaseline().dimensions.viewportWidth, 1280);
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
await testViewportRecoveryRestoresNormalWindowState();
await testViewportGuardDetectsCumulativeWidthLoss();
await testViewportGuardDetectsCumulativeHeightLoss();
await testViewportGuardRebaselinesOnlyForVerifiedWindowResize();
await testViewportGuardRejectsUnstableWindowResizeWithoutRatchetingBaseline();
await testViewportGuardTreatsUnreadableRootAsUnsafe();
await testViewportGuardReacquiresUnreadableRootsBeforeFailing();
await testViewportGuardAcceptsFreshRootWithoutFalseRecovery();
await testViewportGuardRepairsRealCollapseAfterUnreadableRoot();
await testViewportGuardRecoversBackToOriginalBaseline();
await testViewportAcceptsDomainRootStateShape();
await testViewportRecoveryReacquiresRootsBeforeEveryStableSample();
await testViewportRecoveryPreservesWindowIdZero();
await testViewportRecoveryRejectsPartialWindowRestorationWithoutRatchetingBaseline();
testTargetClassificationAndConfig();

console.log("core self-heal tests passed");
