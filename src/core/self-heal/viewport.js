import {
  getNodeBox,
  querySelector,
  sleep
} from "../browser/index.js";

export const VIEWPORT_COLLAPSE_RATIO_THRESHOLD = 0.6;
export const VIEWPORT_COLLAPSE_MIN_EXPECTED_WIDTH = 1000;
export const VIEWPORT_COLLAPSE_NEAR_FULLSCREEN_RATIO = 0.85;

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
  const root = roots[name];
  if (typeof root === "number") return root;
  if (root?.nodeId) return root.nodeId;
  if (root?.documentNodeId) return root.documentNodeId;
  return 0;
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
      targetWindow?.windowId
      && typeof client?.Browser?.getWindowBounds === "function"
    ) {
      const currentBounds = await client.Browser.getWindowBounds({
        windowId: targetWindow.windowId
      });
      bounds = currentBounds?.bounds || bounds;
    }
    return {
      ok: true,
      windowId: targetWindow?.windowId || null,
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
  const windowWidth = getPositiveNumber(bounds?.width);
  const screenAvailWidth = getPositiveNumber(topViewport.screenAvailWidth);
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
  const hasScreenWidth = screenAvailWidth > 0;
  const nearFullscreen = Boolean(
    windowState === "maximized"
    || (
      windowWidth > 0
      && hasScreenWidth
      && windowWidth >= screenAvailWidth * VIEWPORT_COLLAPSE_NEAR_FULLSCREEN_RATIO
    )
    || (
      topOuterWidth > 0
      && hasScreenWidth
      && topOuterWidth >= screenAvailWidth * VIEWPORT_COLLAPSE_NEAR_FULLSCREEN_RATIO
    )
  );
  const fallbackExpectedWidth = getPositiveNumber(screenAvailWidth, windowWidth, topOuterWidth);
  let expectedWidth = 0;
  if (windowWidth > 0) {
    expectedWidth = hasScreenWidth && windowWidth >= screenAvailWidth * VIEWPORT_COLLAPSE_NEAR_FULLSCREEN_RATIO
      ? Math.min(windowWidth, screenAvailWidth)
      : windowWidth;
  } else if (topOuterWidth > 0) {
    expectedWidth = hasScreenWidth && topOuterWidth >= screenAvailWidth * VIEWPORT_COLLAPSE_NEAR_FULLSCREEN_RATIO
      ? Math.min(topOuterWidth, screenAvailWidth)
      : topOuterWidth;
  } else {
    expectedWidth = fallbackExpectedWidth;
  }
  const widthRatio = actualWidth > 0 && expectedWidth > 0
    ? actualWidth / expectedWidth
    : null;
  const relativeCollapsed = Boolean(
    nearFullscreen
    && expectedWidth >= VIEWPORT_COLLAPSE_MIN_EXPECTED_WIDTH
    && actualWidth > 0
    && widthRatio !== null
    && widthRatio <= VIEWPORT_COLLAPSE_RATIO_THRESHOLD
  );

  return {
    threshold: VIEWPORT_COLLAPSE_RATIO_THRESHOLD,
    minExpectedWidth: VIEWPORT_COLLAPSE_MIN_EXPECTED_WIDTH,
    nearFullscreen,
    windowState,
    windowWidth,
    screenAvailWidth,
    topOuterWidth,
    actualWidth,
    actualHeight,
    expectedWidth,
    widthRatio,
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
    screenAvailWidth: getPositiveNumber(bounds.width),
    screenAvailHeight: getPositiveNumber(bounds.height),
    devicePixelRatio: getPositiveNumber(layoutMetrics?.cssVisualViewport?.scale, 1)
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
    windowInfo
  };
  state.viewportDiagnostics = buildViewportHealthDiagnostics(state, windowInfo, layoutMetrics);
  state.collapsed = isListViewportCollapsed(state);
  return state;
}

export async function setWindowStateIfPossible(client, windowState, reason = "viewport_recovery") {
  const windowInfo = await getCurrentWindowInfo(client);
  if (!windowInfo.ok || !windowInfo.windowId || typeof client?.Browser?.setWindowBounds !== "function") {
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

export async function toggleWindowStateForViewportRecovery(client, {
  reason = "viewport_recovery",
  settleMs = 520,
  bringToFront = true
} = {}) {
  const currentInfo = await getCurrentWindowInfo(client);
  const currentState = normalizeText(currentInfo?.bounds?.windowState || "").toLowerCase();
  const sequence = currentState === "normal"
    ? ["maximized"]
    : ["normal", "maximized"];
  const attempts = [];

  for (const windowState of sequence) {
    const attempt = await setWindowStateIfPossible(client, windowState, reason);
    attempts.push(attempt);
    if (attempt.ok && settleMs > 0) await sleep(settleMs);
  }

  if (bringToFront && typeof client?.Page?.bringToFront === "function") {
    await client.Page.bringToFront();
  }

  return {
    ok: attempts.some((attempt) => attempt.ok),
    applied: attempts.some((attempt) => attempt.ok),
    reason,
    current_state: currentState || null,
    sequence,
    attempts
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
          screenAvailWidth: state.topViewport.screenAvailWidth || 0,
          screenAvailHeight: state.topViewport.screenAvailHeight || 0,
          devicePixelRatio: state.topViewport.devicePixelRatio || 0
        }
      : null,
    viewportDiagnostics: state.viewportDiagnostics || null,
    collapsed: Boolean(state.collapsed)
  };
}

export function compactViewportHealthResult(result = null) {
  if (!result) return null;
  return {
    ok: Boolean(result.ok),
    collapsed: Boolean(result.collapsed),
    recovered: Boolean(result.recovered),
    reason: result.reason || null,
    state: compactViewportState(result.state),
    before: compactViewportState(result.before),
    repair: result.repair
      ? {
          ok: Boolean(result.repair.ok),
          applied: Boolean(result.repair.applied),
          current_state: result.repair.current_state || null,
          sequence: result.repair.sequence || [],
          attempts: (result.repair.attempts || []).map((attempt) => ({
            ok: Boolean(attempt.ok),
            windowState: attempt.windowState,
            error: attempt.error || null
          }))
        }
      : null,
    error: result.error || null
  };
}

export async function ensureHealthyViewport(client, {
  roots = {},
  root = "frame",
  frameOwnerRoot = "frameOwner",
  reason = "viewport_recovery",
  repair = true,
  recoveryDelayMs = 900
} = {}) {
  const before = await readViewportState(client, {
    roots,
    root,
    frameOwnerRoot
  });
  if (!before.ok) {
    return {
      ok: false,
      collapsed: false,
      recovered: false,
      reason,
      state: before,
      error: before.error || "viewport state could not be read"
    };
  }

  if (!isListViewportCollapsed(before)) {
    return {
      ok: true,
      collapsed: false,
      recovered: false,
      reason,
      state: before
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
      error: "viewport collapsed and repair disabled"
    };
  }

  const repairResult = await toggleWindowStateForViewportRecovery(client, { reason });
  if (recoveryDelayMs > 0) await sleep(recoveryDelayMs);
  const after = await readViewportState(client, {
    roots,
    root,
    frameOwnerRoot
  });
  const stillCollapsed = isListViewportCollapsed(after);
  return {
    ok: after.ok && !stillCollapsed,
    collapsed: stillCollapsed,
    recovered: after.ok && !stillCollapsed && repairResult.applied,
    reason,
    before,
    state: after,
    repair: repairResult,
    error: after.ok && !stillCollapsed
      ? null
      : "viewport collapsed after recovery attempt"
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
  maxEvents = 10
} = {}) {
  if (!client) throw new Error("createViewportRunGuard requires a guarded CDP client");
  const events = [];
  const stats = {
    checks: 0,
    recoveries: 0,
    failures: 0
  };

  function recordEvent(phase, health) {
    const compact = compactViewportHealthResult(health);
    const shouldRecord = Boolean(health?.recovered || !health?.ok || health?.collapsed);
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
    const roots = rootNodesFromState(currentRootState);
    stats.checks += 1;
    const health = await ensureHealthyViewport(client, {
      roots,
      root,
      frameOwnerRoot,
      reason,
      repair
    });
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
    if (health.recovered && typeof getRoots === "function") {
      currentRootState = await getRoots(client);
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
    }
  };
}
