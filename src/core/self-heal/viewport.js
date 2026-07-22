import {
  getNodeBox,
  querySelector,
  sleep
} from "../browser/index.js";

export const VIEWPORT_COLLAPSE_RATIO_THRESHOLD = 0.6;
export const VIEWPORT_COLLAPSE_MIN_EXPECTED_WIDTH = 1000;
export const VIEWPORT_COLLAPSE_NEAR_FULLSCREEN_RATIO = 0.85;

// Desktop visual viewports are stable to roughly a pixel. A small absolute
// floor filters rounding noise while the ratio catches cumulative losses long
// before they grow into the old catastrophic-collapse thresholds.
const VIEWPORT_BASELINE_MIN_RATIO = 0.995;
const VIEWPORT_BASELINE_MIN_LOSS_PX = 4;
const WINDOW_BOUNDS_CHANGE_TOLERANCE_PX = 2;

const ABSOLUTE_COLLAPSE_LIMITS = Object.freeze({
  clientHeight: 260,
  clientWidth: 280,
  frameHeight: 320,
  frameWidth: 460,
  viewportHeight: 260,
  viewportWidth: 360
});

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function getPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function rootNodeId(roots = {}, name) {
  for (const root of [roots?.[name], roots?.rootNodes?.[name], roots?.roots?.[name]]) {
    if (typeof root === "number" && root > 0) return root;
    if (root?.nodeId) return root.nodeId;
    if (root?.documentNodeId) return root.documentNodeId;
  }
  return 0;
}

function getFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactRect(rect = {}) {
  return {
    width: getPositiveNumber(rect.width),
    height: getPositiveNumber(rect.height)
  };
}

function pickViewportSize(layoutMetrics = {}, axis = "width") {
  const clientKey = axis === "width" ? "clientWidth" : "clientHeight";
  return getPositiveNumber(
    layoutMetrics?.cssVisualViewport?.[clientKey],
    layoutMetrics?.cssLayoutViewport?.[clientKey],
    layoutMetrics?.visualViewport?.[clientKey],
    layoutMetrics?.layoutViewport?.[clientKey]
  );
}

const BASELINE_DIMENSIONS = Object.freeze([
  ["clientWidth", (state) => state?.clientWidth],
  ["clientHeight", (state) => state?.clientHeight],
  ["frameWidth", (state) => state?.frameRect?.width],
  ["frameHeight", (state) => state?.frameRect?.height],
  ["viewportWidth", (state) => state?.viewport?.width],
  ["viewportHeight", (state) => state?.viewport?.height]
]);

function readDimensionSnapshot(state = {}) {
  return Object.fromEntries(BASELINE_DIMENSIONS.map(([name, read]) => [
    name,
    getPositiveNumber(read(state))
  ]));
}

function readWindowSnapshot(state = {}) {
  const info = state?.windowInfo || {};
  const bounds = info?.bounds || {};
  return {
    ok: Boolean(info.ok && info.windowId != null && getPositiveNumber(bounds.width) && getPositiveNumber(bounds.height)),
    windowId: info.windowId ?? null,
    left: getFiniteNumber(bounds.left),
    top: getFiniteNumber(bounds.top),
    width: getPositiveNumber(bounds.width),
    height: getPositiveNumber(bounds.height),
    windowState: normalizeText(bounds.windowState || "").toLowerCase() || null
  };
}

function createViewportBaseline(state, {
  reason = "initial_healthy_viewport",
  stableSamples = 1,
  establishedAt = new Date().toISOString()
} = {}) {
  return {
    version: 1,
    establishedAt,
    reason,
    stableSamples: Math.max(1, Number(stableSamples) || 1),
    dimensions: readDimensionSnapshot(state),
    window: readWindowSnapshot(state)
  };
}

function mergeStableBaselineSamples(firstState, secondState, options = {}) {
  const baseline = createViewportBaseline(firstState, {
    ...options,
    stableSamples: 2
  });
  const second = readDimensionSnapshot(secondState);
  for (const [name] of BASELINE_DIMENSIONS) {
    baseline.dimensions[name] = Math.max(
      getPositiveNumber(baseline.dimensions[name]),
      getPositiveNumber(second[name])
    );
  }
  baseline.window = readWindowSnapshot(secondState);
  return baseline;
}

function compareViewportToBaseline(state, baseline) {
  if (!baseline?.dimensions) {
    return {
      available: false,
      drifted: false,
      dimensions: {}
    };
  }

  const current = readDimensionSnapshot(state);
  const dimensions = {};
  const driftedDimensions = [];
  const missingDimensions = [];
  for (const [name] of BASELINE_DIMENSIONS) {
    const expected = getPositiveNumber(baseline.dimensions[name]);
    const actual = getPositiveNumber(current[name]);
    const missing = expected > 0 && actual <= 0;
    const lossPx = expected > 0 && actual > 0
      ? Math.max(0, expected - actual)
      : expected > 0
        ? expected
        : 0;
    const ratio = expected > 0 && actual > 0 ? actual / expected : null;
    const drifted = Boolean(
      missing
      || (
        lossPx > VIEWPORT_BASELINE_MIN_LOSS_PX
        && ratio !== null
        && ratio < VIEWPORT_BASELINE_MIN_RATIO
      )
    );
    dimensions[name] = {
      expected,
      actual,
      lossPx,
      ratio,
      missing,
      drifted
    };
    if (missing) missingDimensions.push(name);
    if (drifted) driftedDimensions.push(name);
  }

  return {
    available: true,
    thresholdRatio: VIEWPORT_BASELINE_MIN_RATIO,
    minLossPx: VIEWPORT_BASELINE_MIN_LOSS_PX,
    drifted: driftedDimensions.length > 0,
    driftedDimensions,
    missingDimensions,
    dimensions
  };
}

function compareWindowToBaseline(state, baseline) {
  const expected = baseline?.window || null;
  const actual = readWindowSnapshot(state);
  if (!expected?.ok || !actual.ok) {
    return {
      verified: false,
      changed: false,
      reason: "window_bounds_unreadable",
      expected,
      actual
    };
  }
  if (expected.windowId !== actual.windowId) {
    return {
      verified: false,
      changed: false,
      reason: "window_id_changed",
      expected,
      actual
    };
  }
  const widthDelta = actual.width - expected.width;
  const heightDelta = actual.height - expected.height;
  const changed = Boolean(
    Math.abs(widthDelta) > WINDOW_BOUNDS_CHANGE_TOLERANCE_PX
    || Math.abs(heightDelta) > WINDOW_BOUNDS_CHANGE_TOLERANCE_PX
  );
  return {
    verified: true,
    changed,
    reason: changed ? "verified_browser_bounds_change" : "browser_bounds_unchanged",
    widthDelta,
    heightDelta,
    stateChanged: expected.windowState !== actual.windowState,
    expected,
    actual
  };
}

async function getLayoutMetrics(client) {
  if (typeof client?.Page?.getLayoutMetrics !== "function") return null;
  try {
    return await client.Page.getLayoutMetrics();
  } catch {
    return null;
  }
}

export async function getCurrentWindowInfo(client) {
  if (typeof client?.Browser?.getWindowForTarget !== "function") {
    return {
      ok: false,
      unsupported: true,
      error: "Browser.getWindowForTarget is not available"
    };
  }

  try {
    const targetWindow = await client.Browser.getWindowForTarget({});
    let bounds = targetWindow?.bounds || null;
    if (
      targetWindow?.windowId != null
      && typeof client?.Browser?.getWindowBounds === "function"
    ) {
      const currentBounds = await client.Browser.getWindowBounds({
        windowId: targetWindow.windowId
      });
      bounds = currentBounds?.bounds || bounds;
    }
    return {
      ok: true,
      windowId: targetWindow?.windowId ?? null,
      bounds
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error)
    };
  }
}

async function readBox(client, nodeId) {
  if (!nodeId) return null;
  try {
    return await getNodeBox(client, nodeId);
  } catch {
    return null;
  }
}

async function readBestContentBox(client, rootNodeIdValue) {
  const directBox = await readBox(client, rootNodeIdValue);
  if (directBox?.rect?.width && directBox?.rect?.height) return directBox;

  for (const selector of ["body", "html"]) {
    const nodeId = await querySelector(client, rootNodeIdValue, selector).catch(() => 0);
    const box = await readBox(client, nodeId);
    if (box?.rect?.width && box?.rect?.height) return box;
  }
  return directBox;
}

export function buildViewportHealthDiagnostics(state, windowInfo = null, layoutMetrics = null) {
  const topViewport = state?.topViewport || {};
  const bounds = windowInfo?.bounds || null;
  const windowState = normalizeText(bounds?.windowState || "").toLowerCase() || null;
  const browserWindowWidth = getPositiveNumber(
    bounds?.width,
    topViewport.browserWindowWidth,
    topViewport.outerWidth
  );
  const browserWindowHeight = getPositiveNumber(
    bounds?.height,
    topViewport.browserWindowHeight,
    topViewport.outerHeight
  );
  const topOuterWidth = getPositiveNumber(topViewport.outerWidth);
  const actualWidth = getPositiveNumber(
    layoutMetrics?.cssVisualViewport?.clientWidth,
    layoutMetrics?.cssLayoutViewport?.clientWidth,
    topViewport.visualWidth,
    topViewport.innerWidth,
    state?.viewport?.width,
    state?.clientWidth,
    state?.frameRect?.width
  );
  const actualHeight = getPositiveNumber(
    layoutMetrics?.cssVisualViewport?.clientHeight,
    layoutMetrics?.cssLayoutViewport?.clientHeight,
    topViewport.visualHeight,
    topViewport.innerHeight,
    state?.viewport?.height,
    state?.clientHeight,
    state?.frameRect?.height
  );
  const nearFullscreen = Boolean(
    windowState === "maximized"
    || windowState === "fullscreen"
  );
  const expectedWidth = getPositiveNumber(browserWindowWidth, topOuterWidth);
  const expectedHeight = getPositiveNumber(browserWindowHeight, topViewport.outerHeight);
  const widthRatio = actualWidth > 0 && expectedWidth > 0
    ? actualWidth / expectedWidth
    : null;
  const heightRatio = actualHeight > 0 && expectedHeight > 0
    ? actualHeight / expectedHeight
    : null;
  const relativeWidthCollapsed = Boolean(
    expectedWidth >= VIEWPORT_COLLAPSE_MIN_EXPECTED_WIDTH
    && actualWidth > 0
    && widthRatio !== null
    && widthRatio <= VIEWPORT_COLLAPSE_RATIO_THRESHOLD
  );
  const relativeCollapsed = relativeWidthCollapsed;

  return {
    threshold: VIEWPORT_COLLAPSE_RATIO_THRESHOLD,
    minExpectedWidth: VIEWPORT_COLLAPSE_MIN_EXPECTED_WIDTH,
    nearFullscreen,
    windowState,
    browserWindowWidth,
    browserWindowHeight,
    topOuterWidth,
    actualWidth,
    actualHeight,
    expectedWidth,
    expectedHeight,
    widthRatio,
    heightRatio,
    relativeWidthCollapsed,
    relativeCollapsed
  };
}

export function isListViewportCollapsed(state) {
  if (!state?.ok) return false;
  if (state.viewportDiagnostics?.relativeCollapsed === true) return true;
  const clientHeight = Number(state.clientHeight || 0);
  const clientWidth = Number(state.clientWidth || 0);
  const frameWidth = Number(state.frameRect?.width || 0);
  const frameHeight = Number(state.frameRect?.height || 0);
  const viewportWidth = Number(state.viewport?.width || 0);
  const viewportHeight = Number(state.viewport?.height || 0);

  return (
    (clientHeight > 0 && clientHeight < ABSOLUTE_COLLAPSE_LIMITS.clientHeight)
    || (clientWidth > 0 && clientWidth < ABSOLUTE_COLLAPSE_LIMITS.clientWidth)
    || (frameHeight > 0 && frameHeight < ABSOLUTE_COLLAPSE_LIMITS.frameHeight)
    || (frameWidth > 0 && frameWidth < ABSOLUTE_COLLAPSE_LIMITS.frameWidth)
    || (viewportHeight > 0 && viewportHeight < ABSOLUTE_COLLAPSE_LIMITS.viewportHeight)
    || (viewportWidth > 0 && viewportWidth < ABSOLUTE_COLLAPSE_LIMITS.viewportWidth)
  );
}

export async function readViewportState(client, {
  roots = {},
  root = "frame",
  frameOwnerRoot = "frameOwner"
} = {}) {
  const targetRootNodeId = rootNodeId(roots, root);
  if (!targetRootNodeId) {
    return {
      ok: false,
      root,
      error: `Root not found: ${root}`
    };
  }

  const layoutMetrics = await getLayoutMetrics(client);
  const windowInfo = await getCurrentWindowInfo(client);
  const contentBox = await readBestContentBox(client, targetRootNodeId);
  const ownerNodeId = rootNodeId(roots, frameOwnerRoot);
  const ownerBox = ownerNodeId ? await readBox(client, ownerNodeId) : null;
  const contentRectReadable = Boolean(
    getPositiveNumber(contentBox?.rect?.width)
    && getPositiveNumber(contentBox?.rect?.height)
  );
  const ownerRectReadable = Boolean(
    !ownerNodeId
    || (
      getPositiveNumber(ownerBox?.rect?.width)
      && getPositiveNumber(ownerBox?.rect?.height)
    )
  );
  const measurementEvidence = {
    targetRootNodeId,
    contentRectReadable,
    frameOwnerNodeId: ownerNodeId || null,
    ownerRectReadable,
    layoutMetricsReadable: Boolean(layoutMetrics),
    browserWindowReadable: Boolean(windowInfo?.ok)
  };
  if (!contentRectReadable || !ownerRectReadable) {
    return {
      ok: false,
      root,
      rootNodeId: targetRootNodeId,
      frameOwnerRoot,
      frameOwnerNodeId: ownerNodeId || null,
      windowInfo,
      measurementEvidence,
      error: !contentRectReadable
        ? `Viewport root geometry is unreadable: ${root}`
        : `Viewport frame-owner geometry is unreadable: ${frameOwnerRoot}`
    };
  }
  const frameRect = compactRect(ownerBox?.rect || contentBox?.rect || {});
  const clientWidth = getPositiveNumber(
    contentBox?.rect?.width,
    frameRect.width,
    pickViewportSize(layoutMetrics, "width")
  );
  const clientHeight = getPositiveNumber(
    contentBox?.rect?.height,
    frameRect.height,
    pickViewportSize(layoutMetrics, "height")
  );
  const viewportWidth = pickViewportSize(layoutMetrics, "width") || clientWidth;
  const viewportHeight = pickViewportSize(layoutMetrics, "height") || clientHeight;
  const bounds = windowInfo?.bounds || {};
  const topViewport = {
    innerWidth: viewportWidth,
    innerHeight: viewportHeight,
    outerWidth: getPositiveNumber(bounds.width, viewportWidth),
    outerHeight: getPositiveNumber(bounds.height, viewportHeight),
    visualWidth: getPositiveNumber(layoutMetrics?.cssVisualViewport?.clientWidth, viewportWidth),
    visualHeight: getPositiveNumber(layoutMetrics?.cssVisualViewport?.clientHeight, viewportHeight),
    browserWindowWidth: getPositiveNumber(bounds.width),
    browserWindowHeight: getPositiveNumber(bounds.height),
    visualViewportScale: getPositiveNumber(layoutMetrics?.cssVisualViewport?.scale, 1)
  };
  const state = {
    ok: true,
    root,
    rootNodeId: targetRootNodeId,
    frameOwnerRoot,
    frameOwnerNodeId: ownerNodeId || null,
    clientWidth,
    clientHeight,
    frameRect,
    viewport: {
      width: viewportWidth,
      height: viewportHeight
    },
    topViewport,
    windowInfo,
    measurementEvidence
  };
  state.viewportDiagnostics = buildViewportHealthDiagnostics(state, windowInfo, layoutMetrics);
  state.collapsed = isListViewportCollapsed(state);
  return state;
}

export async function setWindowStateIfPossible(client, windowState, reason = "viewport_recovery") {
  const windowInfo = await getCurrentWindowInfo(client);
  if (!windowInfo.ok || windowInfo.windowId == null || typeof client?.Browser?.setWindowBounds !== "function") {
    return {
      ok: false,
      reason,
      windowState,
      error: windowInfo.error || "Browser.setWindowBounds is not available"
    };
  }

  try {
    await client.Browser.setWindowBounds({
      windowId: windowInfo.windowId,
      bounds: {
        windowState
      }
    });
    return {
      ok: true,
      reason,
      windowState,
      windowId: windowInfo.windowId,
      before: windowInfo.bounds || null
    };
  } catch (error) {
    return {
      ok: false,
      reason,
      windowState,
      windowId: windowInfo.windowId,
      error: error?.message || String(error)
    };
  }
}

function captureRestorableWindowSnapshot(windowInfo = {}) {
  const bounds = windowInfo?.bounds || {};
  const windowState = normalizeText(bounds.windowState || "").toLowerCase();
  const width = getPositiveNumber(bounds.width);
  const height = getPositiveNumber(bounds.height);
  const restorableState = ["normal", "maximized", "fullscreen"].includes(windowState);
  return {
    ok: Boolean(
      windowInfo?.ok
      && windowInfo.windowId != null
      && restorableState
      && width
      && height
    ),
    windowId: windowInfo?.windowId ?? null,
    windowState: restorableState ? windowState : null,
    left: getFiniteNumber(bounds.left),
    top: getFiniteNumber(bounds.top),
    width,
    height
  };
}

function buildOriginalWindowRestoreBounds(snapshot = {}) {
  const bounds = {
    windowState: snapshot.windowState
  };
  if (snapshot.windowState === "normal") {
    if (snapshot.left !== null) bounds.left = snapshot.left;
    if (snapshot.top !== null) bounds.top = snapshot.top;
    bounds.width = snapshot.width;
    bounds.height = snapshot.height;
  }
  return bounds;
}

function verifyOriginalWindowRestoration(original, currentInfo) {
  const actual = captureRestorableWindowSnapshot(currentInfo);
  if (!original?.ok || !actual.ok) {
    return {
      verified: false,
      reason: "window_restoration_readback_unavailable",
      expected: original || null,
      actual
    };
  }
  if (actual.windowId !== original.windowId) {
    return {
      verified: false,
      reason: "window_restoration_target_changed",
      expected: original,
      actual
    };
  }

  const deltas = {
    left: original.left !== null && actual.left !== null ? actual.left - original.left : null,
    top: original.top !== null && actual.top !== null ? actual.top - original.top : null,
    width: actual.width - original.width,
    height: actual.height - original.height
  };
  const stateMatches = actual.windowState === original.windowState;
  const positionMatches = Boolean(
    (
      original.left === null
      || (actual.left !== null && Math.abs(deltas.left) <= WINDOW_BOUNDS_CHANGE_TOLERANCE_PX)
    )
    && (
      original.top === null
      || (actual.top !== null && Math.abs(deltas.top) <= WINDOW_BOUNDS_CHANGE_TOLERANCE_PX)
    )
  );
  const sizeMatches = Boolean(
    Math.abs(deltas.width) <= WINDOW_BOUNDS_CHANGE_TOLERANCE_PX
    && Math.abs(deltas.height) <= WINDOW_BOUNDS_CHANGE_TOLERANCE_PX
  );
  const verified = stateMatches && positionMatches && sizeMatches;
  return {
    verified,
    reason: verified
      ? "original_window_state_and_bounds_verified"
      : !stateMatches
        ? "original_window_state_not_restored"
        : !positionMatches
          ? "original_window_position_not_restored"
          : "original_window_size_not_restored",
    stateMatches,
    positionMatches,
    sizeMatches,
    tolerancePx: WINDOW_BOUNDS_CHANGE_TOLERANCE_PX,
    deltas,
    expected: original,
    actual
  };
}

async function setExactWindowBounds(client, {
  windowId,
  bounds,
  reason,
  step
}) {
  if (windowId == null || typeof client?.Browser?.setWindowBounds !== "function") {
    return {
      ok: false,
      reason,
      step,
      windowId: windowId ?? null,
      bounds,
      windowState: bounds?.windowState || null,
      error: "Browser.setWindowBounds is not available"
    };
  }
  try {
    await client.Browser.setWindowBounds({ windowId, bounds });
    return {
      ok: true,
      reason,
      step,
      windowId,
      bounds,
      windowState: bounds?.windowState || null
    };
  } catch (error) {
    return {
      ok: false,
      reason,
      step,
      windowId,
      bounds,
      windowState: bounds?.windowState || null,
      error: error?.message || String(error)
    };
  }
}

export async function toggleWindowStateForViewportRecovery(client, {
  reason = "viewport_recovery",
  settleMs = 520,
  bringToFront = true
} = {}) {
  const currentInfo = await getCurrentWindowInfo(client);
  const original = captureRestorableWindowSnapshot(currentInfo);
  const currentState = original.windowState;
  const sequence = currentState === "normal"
    ? ["maximized", "normal"]
    : ["normal", currentState].filter(Boolean);
  const attempts = [];

  if (original.ok) {
    const perturb = await setExactWindowBounds(client, {
      windowId: original.windowId,
      bounds: { windowState: sequence[0] },
      reason,
      step: "perturb_window_state"
    });
    attempts.push(perturb);
    if (perturb.ok && settleMs > 0) await sleep(settleMs);

    const restore = await setExactWindowBounds(client, {
      windowId: original.windowId,
      bounds: buildOriginalWindowRestoreBounds(original),
      reason,
      step: "restore_original_window"
    });
    attempts.push(restore);
    if (restore.ok && settleMs > 0) await sleep(settleMs);
  }

  if (bringToFront && typeof client?.Page?.bringToFront === "function") {
    await client.Page.bringToFront();
  }

  const restoredInfo = original.ok ? await getCurrentWindowInfo(client) : null;
  const restoration = verifyOriginalWindowRestoration(original, restoredInfo);
  const applied = attempts.some((attempt) => attempt.ok);

  return {
    ok: Boolean(applied && restoration.verified),
    applied,
    reason,
    current_state: currentState || null,
    restored_state: sequence[sequence.length - 1] || null,
    original_window: original,
    restored_window: captureRestorableWindowSnapshot(restoredInfo || {}),
    original_state_restored: Boolean(restoration.verified),
    restoration,
    sequence,
    attempts,
    error: original.ok
      ? restoration.verified
        ? null
        : restoration.reason
      : "original window state and bounds are unreadable"
  };
}

export function compactViewportState(state = null) {
  if (!state) return null;
  return {
    ok: Boolean(state.ok),
    root: state.root || null,
    error: state.error || null,
    clientWidth: state.clientWidth || 0,
    clientHeight: state.clientHeight || 0,
    frameRect: state.frameRect || null,
    viewport: state.viewport || null,
    topViewport: state.topViewport
      ? {
          innerWidth: state.topViewport.innerWidth || 0,
          innerHeight: state.topViewport.innerHeight || 0,
          outerWidth: state.topViewport.outerWidth || 0,
          outerHeight: state.topViewport.outerHeight || 0,
          visualWidth: state.topViewport.visualWidth || 0,
          visualHeight: state.topViewport.visualHeight || 0,
          browserWindowWidth: state.topViewport.browserWindowWidth || 0,
          browserWindowHeight: state.topViewport.browserWindowHeight || 0,
          visualViewportScale: state.topViewport.visualViewportScale || 0
        }
      : null,
    measurementEvidence: state.measurementEvidence || null,
    viewportDiagnostics: state.viewportDiagnostics || null,
    baselineComparison: state.baselineComparison || null,
    collapseEvidence: state.collapseEvidence || null,
    collapsed: Boolean(state.collapsed)
  };
}

function compactViewportBaseline(baseline = null) {
  if (!baseline) return null;
  return {
    version: baseline.version || 1,
    establishedAt: baseline.establishedAt || null,
    reason: baseline.reason || null,
    stableSamples: Number(baseline.stableSamples || 0),
    dimensions: baseline.dimensions || null,
    window: baseline.window || null
  };
}

export function compactViewportHealthResult(result = null) {
  if (!result) return null;
  return {
    ok: Boolean(result.ok),
    collapsed: Boolean(result.collapsed),
    recovered: Boolean(result.recovered),
    recoveryMode: result.recoveryMode || null,
    reason: result.reason || null,
    baselineEstablished: Boolean(result.baselineEstablished),
    rebaselined: Boolean(result.rebaselined),
    baseline: compactViewportBaseline(result.baseline),
    baselineComparison: result.baselineComparison || null,
    windowBoundsChange: result.windowBoundsChange || null,
    stability: result.stability || null,
    state: compactViewportState(result.state),
    before: compactViewportState(result.before),
    repair: result.repair
      ? {
          ok: Boolean(result.repair.ok),
          applied: Boolean(result.repair.applied),
          current_state: result.repair.current_state || null,
          restored_state: result.repair.restored_state || null,
          original_state_restored: Boolean(result.repair.original_state_restored),
          original_window: result.repair.original_window || null,
          restored_window: result.repair.restored_window || null,
          restoration: result.repair.restoration || null,
          sequence: result.repair.sequence || [],
          attempts: (result.repair.attempts || []).map((attempt) => ({
            ok: Boolean(attempt.ok),
            step: attempt.step || null,
            windowId: attempt.windowId ?? null,
            windowState: attempt.windowState,
            bounds: attempt.bounds || null,
            error: attempt.error || null
          })),
          error: result.repair.error || null
        }
      : null,
    rootReacquisition: result.rootReacquisition || null,
    failureConfirmation: result.failureConfirmation || null,
    error: result.error || null
  };
}

function annotateViewportState(state, baseline = null) {
  if (!state?.ok) {
    if (state) {
      state.collapseEvidence = {
        unreadable: true,
        catastrophic: false,
        baselineDrift: false
      };
    }
    return state;
  }
  const catastrophic = isListViewportCollapsed(state);
  const baselineComparison = compareViewportToBaseline(state, baseline);
  const baselineDrift = Boolean(baselineComparison.drifted);
  state.baselineComparison = baselineComparison;
  state.collapseEvidence = {
    unreadable: false,
    catastrophic,
    baselineDrift,
    driftedDimensions: baselineComparison.driftedDimensions || []
  };
  state.collapsed = catastrophic || baselineDrift;
  return state;
}

function buildStabilityEvidence(firstState, secondState) {
  const reference = createViewportBaseline(firstState, {
    reason: "stability_reference"
  });
  const comparison = compareViewportToBaseline(secondState, reference);
  const windowBounds = compareWindowToBaseline(secondState, reference);
  return {
    required: true,
    verified: Boolean(
      secondState?.ok
      && !comparison.drifted
      && windowBounds.verified
      && !windowBounds.changed
    ),
    sampleCount: 2,
    comparison,
    windowBounds
  };
}

async function reacquireViewportRoots(reacquireRoots, {
  phase,
  root,
  frameOwnerRoot
}) {
  if (typeof reacquireRoots !== "function") {
    return {
      ok: false,
      phase,
      error: "viewport root reacquisition is unavailable"
    };
  }
  try {
    const roots = await reacquireRoots({ phase, root, frameOwnerRoot });
    const targetRootNodeId = rootNodeId(roots, root);
    if (!targetRootNodeId) {
      return {
        ok: false,
        phase,
        error: `Reacquired viewport root was not found: ${root}`
      };
    }
    return {
      ok: true,
      phase,
      roots,
      targetRootNodeId,
      frameOwnerNodeId: rootNodeId(roots, frameOwnerRoot) || null
    };
  } catch (error) {
    return {
      ok: false,
      phase,
      error: error?.message || String(error)
    };
  }
}

function compactRootReacquisition(samples = []) {
  return {
    required: true,
    verified: samples.length === 2 && samples.every((sample) => sample?.ok),
    samples: samples.map((sample) => ({
      ok: Boolean(sample?.ok),
      phase: sample?.phase || null,
      targetRootNodeId: sample?.targetRootNodeId || null,
      frameOwnerNodeId: sample?.frameOwnerNodeId || null,
      error: sample?.error || null
    }))
  };
}

export async function ensureHealthyViewport(client, {
  roots = {},
  root = "frame",
  frameOwnerRoot = "frameOwner",
  reason = "viewport_recovery",
  repair = true,
  recoveryDelayMs = 900,
  recoverySettleMs = 520,
  baseline = null,
  allowVerifiedWindowRebaseline = true,
  reacquireRoots = null
} = {}) {
  let before = await readViewportState(client, {
    roots,
    root,
    frameOwnerRoot
  });
  if (!before.ok) {
    annotateViewportState(before, baseline);
    const unreadableBefore = before;
    const rootSamples = [];
    const firstRoots = await reacquireViewportRoots(reacquireRoots, {
      phase: "unreadable_root_sample_1",
      root,
      frameOwnerRoot
    });
    rootSamples.push(firstRoots);
    if (!firstRoots.ok) {
      return {
        ok: false,
        collapsed: false,
        recovered: false,
        reason,
        before: unreadableBefore,
        state: unreadableBefore,
        rootReacquisition: compactRootReacquisition(rootSamples),
        baseline,
        baselineEstablished: false,
        rebaselined: false,
        error: unreadableBefore.error || firstRoots.error || "viewport state could not be read"
      };
    }

    const firstFreshState = await readViewportState(client, {
      roots: firstRoots.roots,
      root,
      frameOwnerRoot
    });
    annotateViewportState(firstFreshState, baseline);
    if (!firstFreshState.ok) {
      return {
        ok: false,
        collapsed: false,
        recovered: false,
        reason,
        before: unreadableBefore,
        state: firstFreshState,
        rootReacquisition: compactRootReacquisition(rootSamples),
        baseline,
        baselineEstablished: false,
        rebaselined: false,
        baselineComparison: firstFreshState.baselineComparison || null,
        error: firstFreshState.error || "reacquired viewport state could not be read"
      };
    }
    if (firstFreshState.collapsed) {
      // The stale handle was replaced successfully and the fresh geometry now
      // proves a real collapse. Continue through the normal window-repair path
      // with that fresh root instead of misclassifying it as unreadable.
      before = firstFreshState;
      roots = firstRoots.roots;
    } else {
      const secondRoots = await reacquireViewportRoots(reacquireRoots, {
        phase: "unreadable_root_sample_2",
        root,
        frameOwnerRoot
      });
      rootSamples.push(secondRoots);
      if (!secondRoots.ok) {
        return {
          ok: false,
          collapsed: false,
          recovered: false,
          reason,
          before: unreadableBefore,
          state: firstFreshState,
          rootReacquisition: compactRootReacquisition(rootSamples),
          baseline,
          baselineEstablished: false,
          rebaselined: false,
          baselineComparison: firstFreshState.baselineComparison || null,
          error: secondRoots.error || "viewport roots could not be reacquired for stability verification"
        };
      }

      const secondFreshState = await readViewportState(client, {
        roots: secondRoots.roots,
        root,
        frameOwnerRoot
      });
      annotateViewportState(secondFreshState, baseline);
      const stability = secondFreshState.ok
        ? buildStabilityEvidence(firstFreshState, secondFreshState)
        : {
            required: true,
            verified: false,
            sampleCount: 2,
            error: secondFreshState.error || "reacquired viewport stability sample could not be read"
          };
      const rootsRecovered = Boolean(
        secondFreshState.ok
        && !secondFreshState.collapsed
        && stability.verified
        && rootSamples.every((sample) => sample.ok)
      );
      const nextBaseline = rootsRecovered
        ? baseline || mergeStableBaselineSamples(firstFreshState, secondFreshState, {
            reason: "reacquired_healthy_viewport"
          })
        : baseline;
      return {
        ok: rootsRecovered,
        collapsed: Boolean(secondFreshState.collapsed),
        recovered: rootsRecovered,
        recoveryMode: rootsRecovered ? "root_reacquisition" : null,
        reason,
        before: unreadableBefore,
        state: secondFreshState,
        rootReacquisition: compactRootReacquisition(rootSamples),
        baseline: nextBaseline,
        baselineEstablished: Boolean(rootsRecovered && !baseline),
        rebaselined: false,
        windowBoundsChange: compareWindowToBaseline(secondFreshState, baseline),
        baselineComparison: secondFreshState.baselineComparison || null,
        stability,
        error: rootsRecovered
          ? null
          : secondFreshState.ok && !secondFreshState.collapsed
            ? "reacquired viewport roots did not stabilize across two healthy readings"
            : secondFreshState.error || "reacquired viewport state is unsafe"
      };
    }
  }

  let effectiveBaseline = baseline;
  const windowBoundsChange = compareWindowToBaseline(before, baseline);
  const windowResizeCandidate = Boolean(
    baseline
    && allowVerifiedWindowRebaseline
    && windowBoundsChange.verified
    && windowBoundsChange.changed
  );
  if (windowResizeCandidate) {
    const candidateBaseline = createViewportBaseline(before, {
      reason: "verified_browser_bounds_change"
    });
    annotateViewportState(before, candidateBaseline);
    const confirmation = await readViewportState(client, {
      roots,
      root,
      frameOwnerRoot
    });
    if (!confirmation.ok) {
      annotateViewportState(confirmation, candidateBaseline);
      return {
        ok: false,
        collapsed: false,
        recovered: false,
        reason,
        before,
        state: confirmation,
        baseline,
        baselineEstablished: false,
        rebaselined: false,
        windowBoundsChange,
        stability: {
          required: true,
          verified: false,
          sampleCount: 2,
          error: confirmation.error || "viewport stability sample could not be read"
        },
        error: confirmation.error || "external browser resize verification could not be read"
      };
    }
    const stability = buildStabilityEvidence(before, confirmation);
    annotateViewportState(confirmation, candidateBaseline);
    if (!before.collapsed && !confirmation.collapsed && stability.verified) {
      const nextBaseline = mergeStableBaselineSamples(before, confirmation, {
        reason: "verified_browser_bounds_change"
      });
      return {
        ok: true,
        collapsed: false,
        recovered: false,
        reason,
        before,
        state: confirmation,
        baseline: nextBaseline,
        baselineEstablished: false,
        rebaselined: true,
        windowBoundsChange,
        baselineComparison: confirmation.baselineComparison,
        stability
      };
    }
    return {
      ok: false,
      collapsed: Boolean(before.collapsed || confirmation.collapsed),
      recovered: false,
      reason,
      before,
      state: confirmation,
      baseline,
      baselineEstablished: false,
      rebaselined: false,
      windowBoundsChange,
      baselineComparison: confirmation.baselineComparison,
      stability,
      error: "external browser resize was not stable across two healthy readings"
    };
  }

  const rebaselined = false;
  annotateViewportState(before, effectiveBaseline);

  if (!before.collapsed && !baseline) {
    const confirmation = await readViewportState(client, {
      roots,
      root,
      frameOwnerRoot
    });
    if (!confirmation.ok) {
      annotateViewportState(confirmation, effectiveBaseline);
      return {
        ok: false,
        collapsed: false,
        recovered: false,
        reason,
        before,
        state: confirmation,
        baseline,
        baselineEstablished: false,
        rebaselined: false,
        windowBoundsChange,
        stability: {
          required: true,
          verified: false,
          sampleCount: 2,
          error: confirmation.error || "viewport stability sample could not be read"
        },
        error: confirmation.error || "viewport stability sample could not be read"
      };
    }
    const stability = buildStabilityEvidence(before, confirmation);
    const candidateBaseline = createViewportBaseline(before, {
      reason: "initial_healthy_viewport"
    });
    annotateViewportState(confirmation, candidateBaseline);
    if (!confirmation.collapsed && stability.verified) {
      const nextBaseline = mergeStableBaselineSamples(before, confirmation, {
        reason: "initial_healthy_viewport"
      });
      return {
        ok: true,
        collapsed: false,
        recovered: false,
        reason,
        before,
        state: confirmation,
        baseline: nextBaseline,
        baselineEstablished: true,
        rebaselined: false,
        windowBoundsChange,
        baselineComparison: confirmation.baselineComparison,
        stability
      };
    }
    if (!stability.verified && !confirmation.collapsed) {
      return {
        ok: false,
        collapsed: false,
        recovered: false,
        reason,
        before,
        state: confirmation,
        baseline,
        baselineEstablished: false,
        rebaselined: false,
        windowBoundsChange,
        baselineComparison: confirmation.baselineComparison,
        stability,
        error: "viewport baseline did not stabilize across consecutive readings"
      };
    }
    before = confirmation;
    effectiveBaseline = candidateBaseline;
  }

  if (!before.collapsed) {
    return {
      ok: true,
      collapsed: false,
      recovered: false,
      reason,
      state: before,
      baseline: effectiveBaseline,
      baselineEstablished: false,
      rebaselined: false,
      windowBoundsChange,
      baselineComparison: before.baselineComparison,
      stability: {
        required: false,
        verified: true,
        sampleCount: 1
      }
    };
  }

  if (!repair) {
    return {
      ok: false,
      collapsed: true,
      recovered: false,
      reason,
      before,
      state: before,
      baseline: effectiveBaseline,
      baselineEstablished: false,
      rebaselined,
      windowBoundsChange,
      baselineComparison: before.baselineComparison,
      error: "viewport collapsed and repair disabled"
    };
  }

  const repairResult = await toggleWindowStateForViewportRecovery(client, {
    reason,
    settleMs: recoverySettleMs
  });
  if (!repairResult.ok || !repairResult.original_state_restored) {
    return {
      ok: false,
      collapsed: true,
      recovered: false,
      reason,
      before,
      state: before,
      repair: repairResult,
      baseline: effectiveBaseline,
      baselineEstablished: false,
      rebaselined,
      windowBoundsChange,
      baselineComparison: before.baselineComparison || null,
      error: "original browser window state and bounds were not verified after recovery"
    };
  }
  if (recoveryDelayMs > 0) await sleep(recoveryDelayMs);
  const rootSamples = [];
  const firstRoots = await reacquireViewportRoots(reacquireRoots, {
    phase: "post_repair_sample_1",
    root,
    frameOwnerRoot
  });
  rootSamples.push(firstRoots);
  if (!firstRoots.ok) {
    return {
      ok: false,
      collapsed: true,
      recovered: false,
      reason,
      before,
      state: before,
      repair: repairResult,
      rootReacquisition: compactRootReacquisition(rootSamples),
      baseline: effectiveBaseline,
      baselineEstablished: false,
      rebaselined,
      windowBoundsChange,
      baselineComparison: before.baselineComparison || null,
      error: firstRoots.error || "viewport roots could not be reacquired after recovery"
    };
  }
  const after = await readViewportState(client, {
    roots: firstRoots.roots,
    root,
    frameOwnerRoot
  });
  annotateViewportState(after, effectiveBaseline);
  if (!after.ok || after.collapsed) {
    return {
      ok: false,
      collapsed: Boolean(after.collapsed),
      recovered: false,
      reason,
      before,
      state: after,
      repair: repairResult,
      rootReacquisition: compactRootReacquisition(rootSamples),
      baseline: effectiveBaseline,
      baselineEstablished: false,
      rebaselined,
      windowBoundsChange,
      baselineComparison: after.baselineComparison || null,
      error: after.ok
        ? "viewport collapsed after recovery attempt"
        : after.error || "viewport state could not be read after recovery"
    };
  }

  const secondRoots = await reacquireViewportRoots(reacquireRoots, {
    phase: "post_repair_sample_2",
    root,
    frameOwnerRoot
  });
  rootSamples.push(secondRoots);
  if (!secondRoots.ok) {
    return {
      ok: false,
      collapsed: false,
      recovered: false,
      reason,
      before,
      state: after,
      repair: repairResult,
      rootReacquisition: compactRootReacquisition(rootSamples),
      baseline: effectiveBaseline,
      baselineEstablished: false,
      rebaselined,
      windowBoundsChange,
      baselineComparison: after.baselineComparison || null,
      error: secondRoots.error || "viewport roots could not be reacquired for recovery verification"
    };
  }
  const verification = await readViewportState(client, {
    roots: secondRoots.roots,
    root,
    frameOwnerRoot
  });
  annotateViewportState(verification, effectiveBaseline);
  const stability = verification.ok
    ? buildStabilityEvidence(after, verification)
    : {
        required: true,
        verified: false,
        sampleCount: 2,
        error: verification.error || "viewport recovery verification could not be read"
      };
  const recovered = Boolean(
    verification.ok
    && !verification.collapsed
    && stability.verified
    && repairResult.original_state_restored
    && rootSamples.every((sample) => sample.ok)
  );
  const nextBaseline = recovered
    ? effectiveBaseline || mergeStableBaselineSamples(after, verification, {
        reason: "recovered_healthy_viewport"
      })
    : effectiveBaseline;
  return {
    ok: recovered,
    collapsed: Boolean(verification.collapsed),
    recovered,
    reason,
    before,
    state: verification,
    repair: repairResult,
    rootReacquisition: compactRootReacquisition(rootSamples),
    baseline: nextBaseline,
    baselineEstablished: Boolean(recovered && !baseline),
    rebaselined,
    windowBoundsChange,
    baselineComparison: verification.baselineComparison || null,
    stability,
    error: recovered
      ? null
      : verification.ok && !verification.collapsed
        ? "viewport did not stabilize after recovery attempt with verified window restoration"
        : verification.error || "viewport collapsed after recovery attempt"
  };
}

export function createViewportRunGuard({
  client,
  domain = "boss",
  root = "frame",
  frameOwnerRoot = "frameOwner",
  runControl = null,
  getRoots = null,
  rootNodesFromState = (rootState) => rootState?.rootNodes || rootState?.roots || rootState || {},
  repair = true,
  recoveryDelayMs = 900,
  recoverySettleMs = 520,
  failureConfirmationAttempts = 2,
  failureConfirmationDelayMs = 180,
  maxEvents = 10
} = {}) {
  if (!client) throw new Error("createViewportRunGuard requires a guarded CDP client");
  const events = [];
  let baseline = null;
  const stats = {
    checks: 0,
    recoveries: 0,
    failures: 0,
    baseline_establishments: 0,
    rebaselines: 0,
    baseline_drift_detections: 0,
    unreadable_measurements: 0
  };

  function recordEvent(phase, health) {
    const compact = compactViewportHealthResult(health);
    const shouldRecord = Boolean(
      health?.recovered
      || health?.rebaselined
      || !health?.ok
      || health?.collapsed
    );
    if (!shouldRecord) return compact;
    const event = {
      phase,
      at: new Date().toISOString(),
      ...compact
    };
    events.push(event);
    if (events.length > maxEvents) events.shift();
    if (runControl) {
      runControl.checkpoint({
        viewport_health: event,
        viewport_health_events: events.slice(),
        viewport_health_stats: { ...stats }
      });
    }
    return compact;
  }

  async function ensure(rootState, {
    phase = "run",
    reason = `${domain}:${phase}`
  } = {}) {
    let currentRootState = rootState;
    if (!currentRootState && typeof getRoots === "function") {
      currentRootState = await getRoots(client);
    }
    let roots = rootNodesFromState(currentRootState);
    let latestReacquiredRootState = null;
    const reacquireRoots = typeof getRoots === "function"
      ? async () => {
          const freshRootState = await getRoots(client);
          latestReacquiredRootState = freshRootState;
          return rootNodesFromState(freshRootState);
        }
      : null;
    stats.checks += 1;
    const maxFailureConfirmations = Math.max(1, Number(failureConfirmationAttempts) || 1);
    let health = null;
    let firstFailure = null;
    for (let attempt = 1; attempt <= maxFailureConfirmations; attempt += 1) {
      health = await ensureHealthyViewport(client, {
        roots,
        root,
        frameOwnerRoot,
        reason,
        repair,
        recoveryDelayMs,
        recoverySettleMs,
        baseline,
        reacquireRoots
      });
      if (health.ok) {
        if (firstFailure) {
          health.failureConfirmation = {
            attempted: true,
            attempts: attempt,
            transient_failure_recovered: true,
            first_error: firstFailure.error || null
          };
        }
        break;
      }
      if (!firstFailure) firstFailure = compactViewportHealthResult(health);
      const retryableUnreadableFailure = Boolean(
        !health.state?.ok
        || health.state?.collapseEvidence?.unreadable
        || health.before?.collapseEvidence?.unreadable
      );
      if (attempt >= maxFailureConfirmations || !retryableUnreadableFailure) {
        health.failureConfirmation = {
          attempted: true,
          attempts: attempt,
          transient_failure_recovered: false,
          first_error: firstFailure.error || null
        };
        break;
      }
      if (failureConfirmationDelayMs > 0) await sleep(failureConfirmationDelayMs);
      if (typeof getRoots === "function") {
        try {
          currentRootState = await getRoots(client);
          latestReacquiredRootState = currentRootState;
          roots = rootNodesFromState(currentRootState);
        } catch {
          // The next health attempt retains the original evidence and performs
          // its own bounded root reacquisition before declaring collapse.
        }
      }
    }
    if (health.baselineEstablished) stats.baseline_establishments += 1;
    if (health.rebaselined) stats.rebaselines += 1;
    if (health.before?.collapseEvidence?.baselineDrift) stats.baseline_drift_detections += 1;
    if (
      firstFailure?.state?.collapseEvidence?.unreadable
      || firstFailure?.before?.collapseEvidence?.unreadable
      || !health.state?.ok
      || health.state?.collapseEvidence?.unreadable
      || health.before?.collapseEvidence?.unreadable
    ) {
      stats.unreadable_measurements += 1;
    }
    if (health.ok && health.baseline) baseline = health.baseline;
    if (health.recovered) stats.recoveries += 1;
    if (!health.ok) stats.failures += 1;
    const compact = recordEvent(phase, health);
    if (!health.ok) {
      const error = new Error(`${String(domain).toUpperCase()}_LIST_VIEWPORT_COLLAPSED`);
      error.code = "LIST_VIEWPORT_COLLAPSED";
      error.domain = domain;
      error.phase = phase;
      error.viewport_health = compact;
      throw error;
    }
    if (health.recovered && latestReacquiredRootState) {
      currentRootState = latestReacquiredRootState;
    }
    return {
      rootState: currentRootState,
      health,
      compact,
      stats: { ...stats },
      events: events.slice()
    };
  }

  return {
    ensure,
    getStats() {
      return { ...stats };
    },
    getEvents() {
      return events.slice();
    },
    getBaseline() {
      return compactViewportBaseline(baseline);
    }
  };
}
