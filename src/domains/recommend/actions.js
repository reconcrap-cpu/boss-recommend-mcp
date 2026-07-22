import {
  clickPoint,
  describeNode,
  getFrameDocumentNodeId,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  scrollNodeIntoView,
  sleep
} from "../../core/browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../../core/screening/index.js";
import {
  assertGreetQuotaAvailable,
  parseGreetQuota
} from "../../core/greet-quota/index.js";
import {
  FAVORITE_BUTTON_SELECTORS,
  GREET_BUTTON_RECOMMEND_SELECTORS
} from "./constants.js";
import { waitForRecommendDetail } from "./detail.js";
import { getRecommendRoots } from "./roots.js";

const POST_ACTIONS = new Set(["none", "greet"]);
const GREET_EXACT_LABEL_PATTERN = /^(?:打招呼|聊一聊|立即沟通(?:[\(（]\d+\s*[/／]\s*\d+[\)）])?|沟通)$/i;
const RECOMMEND_NON_REPLAYABLE_INPUT_TIMEOUT_MS = 15_000;
const RECOMMEND_INPUT_CLOSE_TIMEOUT_MS = 4_000;
const RECOMMEND_INPUT_SETTLEMENT_TIMEOUT_MS = 2_000;
export const RECOMMEND_DETAIL_ACTION_TEXT_SELECTORS = Object.freeze([
  "button",
  ".btn",
  '[role="button"]',
  "a",
  "span",
  "div"
]);

function uniqueSelectors(...selectorGroups) {
  return [...new Set(selectorGroups.flat().filter(Boolean))];
}

function uniqueByNode(candidates = []) {
  const seen = new Set();
  const result = [];
  for (const item of candidates) {
    const key = `${item.kind}:${item.root}:${item.node_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function lowerText(...parts) {
  return normalizeText(parts.filter(Boolean).join(" ")).toLowerCase();
}

function settleWithin(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ settled: true, fulfilled: true, value }),
      (error) => ({ settled: true, fulfilled: false, error })
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runRecommendNonReplayableInputWithDeadline(client, action, {
  timeoutMs = RECOMMEND_NON_REPLAYABLE_INPUT_TIMEOUT_MS,
  closeTimeoutMs = RECOMMEND_INPUT_CLOSE_TIMEOUT_MS,
  settlementTimeoutMs = RECOMMEND_INPUT_SETTLEMENT_TIMEOUT_MS
} = {}) {
  if (typeof action !== "function") {
    const error = new Error("Recommend non-replayable input action must be a function");
    error.code = "RECOMMEND_ACTION_INPUT_INVALID";
    throw error;
  }
  const normalizedTimeoutMs = Math.max(1, Number(timeoutMs) || RECOMMEND_NON_REPLAYABLE_INPUT_TIMEOUT_MS);
  const startedAt = Date.now();
  let timer = null;
  let actionSettled = false;
  const actionPromise = Promise.resolve()
    .then(action)
    .then(
      (value) => {
        actionSettled = true;
        return value;
      },
      (error) => {
        actionSettled = true;
        throw error;
      }
    );
  const first = await Promise.race([
    actionPromise.then(
      (value) => ({ type: "fulfilled", value }),
      (error) => ({ type: "rejected", error })
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ type: "timeout" }), normalizedTimeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (first.type === "fulfilled") return first.value;
  if (first.type === "rejected") throw first.error;

  // The Input outcome is now unknown. Never replay it. Close the exact old
  // transport, wait for the pending call to settle, and only then allow a new
  // session. If containment cannot be proven, the caller must stop the run so
  // a late release cannot land on a different candidate.
  let closeResult = null;
  let closeError = null;
  if (typeof client?.close === "function") {
    const close = await settleWithin(
      Promise.resolve().then(() => client.close()),
      Math.max(1, Number(closeTimeoutMs) || RECOMMEND_INPUT_CLOSE_TIMEOUT_MS)
    );
    if (close.settled && close.fulfilled && close.value !== false) {
      closeResult = close.value ?? true;
    } else {
      closeError = close.settled
        ? close.error || new Error("CDP close did not confirm containment")
        : new Error("CDP close did not settle before the containment deadline");
    }
  } else {
    closeError = new Error("CDP client does not expose a bounded close operation");
  }

  const settlement = actionSettled
    ? { settled: true }
    : await settleWithin(
        actionPromise,
        Math.max(1, Number(settlementTimeoutMs) || RECOMMEND_INPUT_SETTLEMENT_TIMEOUT_MS)
      );
  const transportContained = closeError == null && settlement.settled === true;
  let reconnectResult = null;
  let reconnectError = null;
  if (transportContained && typeof client?.__abandonAndReconnect === "function") {
    try {
      reconnectResult = await client.__abandonAndReconnect({
        reason: "recommend_non_replayable_input_timeout"
      });
    } catch (error) {
      reconnectError = error;
    }
  }

  const timeoutError = new Error(
    `Recommend non-replayable Input did not settle within ${normalizedTimeoutMs}ms`
  );
  timeoutError.code = "RECOMMEND_ACTION_INPUT_TIMEOUT";
  timeoutError.phase = "recommend:post-action-input";
  timeoutError.cdp_method = "Input.dispatchMouseEvent";
  timeoutError.cdp_timeout = true;
  timeoutError.cdp_timeout_ms = normalizedTimeoutMs;
  timeoutError.cdp_outcome_unknown = true;
  timeoutError.cdp_replay_suppressed = true;
  timeoutError.cdp_reconnect_required = reconnectResult == null;
  timeoutError.recommend_input_dispatched = true;
  timeoutError.recommend_input_transport_contained = transportContained;
  timeoutError.recommend_input_transport_abandon_failed = !transportContained;
  timeoutError.input_timeout_diagnostic = {
    elapsed_ms: Date.now() - startedAt,
    transport_close_confirmed: closeError == null,
    pending_input_settled_after_close: settlement.settled === true,
    reconnect_succeeded: reconnectResult?.reconnected === true,
    reconnect_error: reconnectError?.message || null,
    close_error: closeError?.message || null,
    replay_suppressed: true
  };
  throw timeoutError;
}

function hasActiveClass(text) {
  return /(?:^|\s)(?:active|curr|current|selected|checked)(?:\s|$)/i.test(text);
}

function hasDisabledSignal(text) {
  return /(?:^|\s)(?:disabled|disable|forbidden|is-disabled)(?:\s|$)/i.test(text);
}

function rectArea(control) {
  const rect = control?.rect || {};
  return Math.max(0, Number(rect.width) || 0) * Math.max(0, Number(rect.height) || 0);
}

function isCompactLabel(control, limit = 80) {
  const label = normalizeText(control?.label || "");
  return label.length > 0 && label.length <= limit;
}

function controlRank(control, exactLabelPattern) {
  const label = normalizeText(control?.label || "");
  const selector = String(control?.selector || "");
  const className = String(control?.class_name || "");
  let score = 0;
  if (exactLabelPattern.test(label)) score -= 1000;
  if (/button|\[role=|\.btn/.test(selector) || /btn|button/i.test(className)) score -= 250;
  if (selector === "div") score += 300;
  if (!isCompactLabel(control)) score += 500;
  score += Math.min(rectArea(control), 100000) / 1000;
  score += label.length / 10;
  return score;
}

function bestControl(controls, exactLabelPattern) {
  return [...controls].sort((left, right) => (
    controlRank(left, exactLabelPattern) - controlRank(right, exactLabelPattern)
  ))[0] || null;
}

export function normalizeRecommendPostAction(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["", "none", "skip", "no", "不执行", "无"].includes(normalized)) return "none";
  if (["greet", "chat", "打招呼", "直接沟通", "沟通"].includes(normalized)) return "greet";
  return POST_ACTIONS.has(normalized) ? normalized : "";
}

export function resolveRecommendPostAction({
  postAction = "none",
  greetCount = 0,
  maxGreetCount = null
} = {}) {
  const requested = normalizeRecommendPostAction(postAction) || "none";
  const currentGreetCount = Number.isInteger(greetCount) && greetCount >= 0 ? greetCount : 0;
  const limit = Number.isInteger(maxGreetCount) && maxGreetCount > 0 ? maxGreetCount : null;
  if (requested === "greet" && limit !== null && currentGreetCount >= limit) {
    return {
      requested,
      effective: "none",
      reason: "greet_limit_reached",
      greet_count: currentGreetCount,
      max_greet_count: limit
    };
  }
  return {
    requested,
    effective: requested,
    reason: "requested_action",
    greet_count: currentGreetCount,
    max_greet_count: limit
  };
}

export function classifyFavoriteControl({
  outerHTML = "",
  attributes = {}
} = {}) {
  const label = htmlToText(outerHTML);
  const labelText = normalizeText(label);
  const className = normalizeText(attributes.class || "");
  const title = normalizeText(attributes.title || attributes["aria-label"] || "");
  const combined = lowerText(className, title);
  const labelMatches = /^(?:收藏|已收藏|感兴趣|已感兴趣)$/.test(labelText);
  const classMatches = /favorite|collect|interest|like/.test(combined);
  const matches = labelMatches || classMatches;
  const active = (
    /已收藏|已感兴趣/.test(label)
    || /like-icon-active|favorite-active|collect-active/i.test(outerHTML)
    || hasActiveClass(className)
  );
  const disabled = (
    Object.prototype.hasOwnProperty.call(attributes, "disabled")
    || hasDisabledSignal(className)
    || /disabled/i.test(outerHTML)
  );
  return {
    kind: "favorite",
    matches,
    active,
    disabled,
    label: label || title || null,
    class_name: className || null
  };
}

export function classifyGreetControl({
  outerHTML = "",
  attributes = {}
} = {}) {
  const label = htmlToText(outerHTML);
  const labelText = normalizeText(label);
  const className = normalizeText(attributes.class || "");
  const title = normalizeText(attributes.title || attributes["aria-label"] || "");
  const combined = lowerText(className, title);
  const continueChat = labelText === "继续沟通";
  const greetQuota = parseGreetQuota(labelText || title);
  const greetEntry = (
    GREET_EXACT_LABEL_PATTERN.test(labelText)
    || greetQuota.found
    || /greet/i.test(combined)
  );
  const disabled = (
    Object.prototype.hasOwnProperty.call(attributes, "disabled")
    || hasDisabledSignal(className)
    || /disabled/i.test(outerHTML)
  );
  return {
    kind: "greet",
    matches: greetEntry || continueChat,
    available: greetEntry && !continueChat && !disabled,
    continue_chat: continueChat,
    disabled,
    label: label || title || null,
    greet_quota: greetQuota.found ? greetQuota : null,
    class_name: className || null
  };
}

async function readActionNode(client, {
  root,
  selector,
  nodeId,
  kind
}) {
  const [attributes, outerHTML, described, describedRoot] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId),
    describeNode(client, nodeId),
    describeNode(client, root.nodeId, { depth: 0, pierce: true })
  ]);
  let box = null;
  let visible = false;
  try {
    box = await getNodeBox(client, nodeId);
    visible = box.rect.width > 2 && box.rect.height > 2;
  } catch {}
  const classification = kind === "favorite"
    ? classifyFavoriteControl({ outerHTML, attributes })
    : classifyGreetControl({ outerHTML, attributes });
  return {
    kind,
    root: root.name,
    root_node_id: root.nodeId,
    root_backend_node_id: Number.isInteger(Number(describedRoot?.backendNodeId))
      ? Number(describedRoot.backendNodeId)
      : null,
    selector,
    node_id: nodeId,
    backend_node_id: Number.isInteger(Number(described?.backendNodeId))
      ? Number(described.backendNodeId)
      : null,
    visible,
    center: box?.center || null,
    rect: box?.rect || null,
    attributes,
    outer_html_length: outerHTML.length,
    html_preview: outerHTML.slice(0, 500),
    ...classification
  };
}

export async function collectRecommendActionControls(client, roots, {
  favoriteSelectors = FAVORITE_BUTTON_SELECTORS,
  greetSelectors = GREET_BUTTON_RECOMMEND_SELECTORS,
  detailTextFallback = false
} = {}) {
  const candidates = [];
  const favoriteScanSelectors = detailTextFallback
    ? uniqueSelectors(favoriteSelectors, RECOMMEND_DETAIL_ACTION_TEXT_SELECTORS)
    : favoriteSelectors;
  const greetScanSelectors = detailTextFallback
    ? uniqueSelectors(greetSelectors, RECOMMEND_DETAIL_ACTION_TEXT_SELECTORS)
    : greetSelectors;
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const [kind, selectors] of [
      ["favorite", favoriteScanSelectors],
      ["greet", greetScanSelectors]
    ]) {
      for (const selector of selectors) {
        const nodeIds = await querySelectorAll(client, root.nodeId, selector);
        for (const nodeId of nodeIds) {
          candidates.push(await readActionNode(client, {
            root,
            selector,
            nodeId,
            kind
          }));
        }
      }
    }
  }
  return uniqueByNode(candidates);
}

export function summarizeRecommendActionControls(controls = []) {
  const visibleControls = controls.filter((item) => item.visible && item.matches);
  const favoriteControls = visibleControls.filter((item) => item.kind === "favorite");
  const greetControls = visibleControls.filter((item) => item.kind === "greet");
  const favorite = bestControl(
    favoriteControls.filter((item) => item.matches),
    /^(?:收藏|已收藏|感兴趣|已感兴趣)$/i
  );
  const greet = bestControl(
    greetControls.filter((item) => item.available),
    GREET_EXACT_LABEL_PATTERN
  ) || bestControl(
    greetControls.filter((item) => item.continue_chat),
    /^继续沟通$/i
  );
  return {
    favorite: favorite
      ? {
        kind: "favorite",
        found: true,
        active: favorite.active,
        disabled: favorite.disabled,
        label: favorite.label,
        selector: favorite.selector,
        root: favorite.root,
        root_node_id: favorite.root_node_id,
        root_backend_node_id: favorite.root_backend_node_id,
        node_id: favorite.node_id,
        backend_node_id: favorite.backend_node_id,
        center: favorite.center,
        rect: favorite.rect
      }
      : { found: false },
    greet: greet
      ? {
        kind: "greet",
        found: true,
        available: greet.available,
        continue_chat: greet.continue_chat,
        disabled: greet.disabled,
        label: greet.label,
        greet_quota: greet.greet_quota || null,
        selector: greet.selector,
        root: greet.root,
        root_node_id: greet.root_node_id,
        root_backend_node_id: greet.root_backend_node_id,
        node_id: greet.node_id,
        backend_node_id: greet.backend_node_id,
        center: greet.center,
        rect: greet.rect
      }
      : { found: false },
    counts: {
      total: controls.length,
      visible_matching: visibleControls.length,
      favorite: favoriteControls.length,
      greet: greetControls.length
    }
  };
}

export async function discoverRecommendActionControls(client, {
  roots = null,
  selectors = {},
  detailTextFallback = false
} = {}) {
  const rootState = roots ? { roots } : await getRecommendRoots(client);
  const controls = await collectRecommendActionControls(client, rootState.roots, {
    ...selectors,
    detailTextFallback
  });
  return {
    controls,
    summary: summarizeRecommendActionControls(controls)
  };
}

export async function waitForRecommendActionControls(client, {
  timeoutMs = 6000,
  intervalMs = 250,
  requireAny = true,
  ...discoveryOptions
} = {}) {
  const started = Date.now();
  let lastDiscovery = null;
  while (Date.now() - started <= timeoutMs) {
    lastDiscovery = await discoverRecommendActionControls(client, discoveryOptions);
    const hasControl = Boolean(
      lastDiscovery.summary.favorite.found
      || lastDiscovery.summary.greet.found
    );
    if (!requireAny || hasControl) {
      return {
        ...lastDiscovery,
        elapsed_ms: Date.now() - started,
        timed_out: false
      };
    }
    await sleep(intervalMs);
  }
  return {
    ...(lastDiscovery || { controls: [], summary: summarizeRecommendActionControls([]) }),
    elapsed_ms: Date.now() - started,
    timed_out: true
  };
}

export async function getRecommendDetailActionRoots(client, detailState) {
  const roots = [];
  if (detailState?.popup?.node_id) {
    roots.push({
      name: `${detailState.popup.root || "unknown"}:detail-popup`,
      nodeId: detailState.popup.node_id
    });
  }
  if (detailState?.resumeIframe?.node_id) {
    try {
      roots.push({
        name: `${detailState.resumeIframe.root || "unknown"}:resume-iframe-document`,
        nodeId: await getFrameDocumentNodeId(client, detailState.resumeIframe.node_id)
      });
    } catch {
      roots.push({
        name: `${detailState.resumeIframe.root || "unknown"}:resume-iframe-node`,
        nodeId: detailState.resumeIframe.node_id
      });
    }
  }
  return roots;
}

export async function waitForRecommendDetailActionControls(client, {
  timeoutMs = 8000,
  intervalMs = 350,
  selectors = {},
  requireAny = true,
  requireContinueChat = false
} = {}) {
  const started = Date.now();
  let lastDiscovery = null;
  let lastError = null;
  let lastRootCount = 0;
  while (Date.now() - started <= timeoutMs) {
    const detailState = await waitForRecommendDetail(client, {
      timeoutMs: Math.min(intervalMs, 500),
      intervalMs: 100
    });
    const roots = await getRecommendDetailActionRoots(client, detailState);
    lastRootCount = roots.length;
    if (roots.length) {
      try {
        lastDiscovery = await discoverRecommendActionControls(client, {
          roots,
          selectors,
          detailTextFallback: true
        });
        const hasControl = Boolean(
          lastDiscovery.summary.favorite.found
          || lastDiscovery.summary.greet.found
        );
        const hasExactContinueChat = Boolean(
          lastDiscovery.summary.greet?.continue_chat === true
          && normalizeText(lastDiscovery.summary.greet?.label) === "继续沟通"
        );
        if (requireContinueChat ? hasExactContinueChat : (!requireAny || hasControl)) {
          return {
            ...lastDiscovery,
            elapsed_ms: Date.now() - started,
            timed_out: false,
            detail_root_count: roots.length
          };
        }
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }
    await sleep(intervalMs);
  }
  return {
    ...(lastDiscovery || { controls: [], summary: summarizeRecommendActionControls([]) }),
    elapsed_ms: Date.now() - started,
    timed_out: true,
    detail_root_count: lastRootCount,
    last_error: lastError
  };
}

async function verifyRecommendActionControlScope(client, control, { maxDepth = 160 } = {}) {
  const nodeId = Number(control?.node_id);
  const expectedBackendNodeId = Number(control?.backend_node_id);
  const rootNodeId = Number(control?.root_node_id);
  const expectedRootBackendNodeId = Number(control?.root_backend_node_id);
  if (
    !Number.isInteger(nodeId)
    || nodeId <= 0
    || !Number.isInteger(expectedBackendNodeId)
    || expectedBackendNodeId <= 0
    || !Number.isInteger(rootNodeId)
    || rootNodeId <= 0
    || !Number.isInteger(expectedRootBackendNodeId)
    || expectedRootBackendNodeId <= 0
    || rootNodeId === nodeId
  ) {
    const error = new Error(
      "Recommend action control exact detail-root frontend/backend identity is missing"
    );
    error.code = "RECOMMEND_ACTION_CONTROL_SCOPE_REQUIRED";
    throw error;
  }
  const root = await describeNode(client, rootNodeId, { depth: 0, pierce: true });
  if (Number(root?.backendNodeId) !== expectedRootBackendNodeId) {
    const error = new Error("Recommend action control detail root identity changed");
    error.code = "RECOMMEND_ACTION_CONTROL_SCOPE_MISMATCH";
    error.expected_root_node_id = rootNodeId;
    error.expected_root_backend_node_id = expectedRootBackendNodeId;
    error.observed_root_backend_node_id = Number(root?.backendNodeId) || null;
    throw error;
  }
  const seen = new Set();
  let currentNodeId = nodeId;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (seen.has(currentNodeId)) break;
    seen.add(currentNodeId);
    const described = await describeNode(client, currentNodeId, { depth: 0, pierce: true });
    if (depth === 0 && Number(described?.backendNodeId) !== expectedBackendNodeId) {
      const error = new Error("Recommend action control backend identity changed within detail scope");
      error.code = "RECOMMEND_ACTION_CONTROL_IDENTITY_MISMATCH";
      error.expected_backend_node_id = expectedBackendNodeId;
      error.observed_backend_node_id = Number(described?.backendNodeId) || null;
      throw error;
    }
    const parentNodeId = Number(described?.parentId);
    if (parentNodeId === rootNodeId) {
      return {
        verified: true,
        node_id: nodeId,
        backend_node_id: expectedBackendNodeId,
        root_node_id: rootNodeId,
        root_backend_node_id: expectedRootBackendNodeId,
        ancestry_depth: depth + 1
      };
    }
    if (!Number.isInteger(parentNodeId) || parentNodeId <= 0) break;
    currentNodeId = parentNodeId;
  }

  // DOM.pushNodesByBackendIdsToFrontend can restore the exact control/root
  // frontend ids while describeNode still omits parentId for the pushed
  // control. That is not evidence that the control left the detail root.
  // Re-prove containment from the already backend-verified root itself. Prefer
  // exact frontend membership, then tolerate a Chrome frontend alias only when
  // exactly one descendant has the already verified immutable control backend.
  // This is not selector/label rediscovery and cannot switch to another
  // same-labelled control or a control outside the exact detail root.
  const rootDescendantNodeIds = await querySelectorAll(client, rootNodeId, "*");
  if (rootDescendantNodeIds.some((candidateNodeId) => Number(candidateNodeId) === nodeId)) {
    return {
      verified: true,
      method: "root_scoped_exact_frontend_membership",
      node_id: nodeId,
      backend_node_id: expectedBackendNodeId,
      root_node_id: rootNodeId,
      root_backend_node_id: expectedRootBackendNodeId,
      ancestry_depth: null,
      root_scoped_descendant_count: rootDescendantNodeIds.length
    };
  }
  const rootScopedBackendMatches = [];
  for (const candidateNodeId of rootDescendantNodeIds) {
    try {
      const candidate = await describeNode(client, candidateNodeId, { depth: 0, pierce: true });
      if (Number(candidate?.backendNodeId) === expectedBackendNodeId) {
        rootScopedBackendMatches.push(Number(candidateNodeId));
      }
    } catch {
      // Ignore unrelated stale descendants. The exact backend must still have
      // one and only one readable member inside the exact root below.
    }
  }
  if (rootScopedBackendMatches.length === 1) {
    return {
      verified: true,
      method: "root_scoped_exact_backend_membership",
      node_id: rootScopedBackendMatches[0],
      backend_node_id: expectedBackendNodeId,
      root_node_id: rootNodeId,
      root_backend_node_id: expectedRootBackendNodeId,
      ancestry_depth: null,
      root_scoped_descendant_count: rootDescendantNodeIds.length,
      root_scoped_backend_match_count: 1
    };
  }
  const error = new Error(
    "Recommend action control is no longer a descendant of the exact current detail root"
  );
  error.code = "RECOMMEND_ACTION_CONTROL_SCOPE_MISMATCH";
  error.expected_root_node_id = rootNodeId;
  error.expected_root_backend_node_id = expectedRootBackendNodeId;
  error.observed_control_node_id = nodeId;
  error.root_scoped_descendant_count = rootDescendantNodeIds.length;
  error.root_scoped_backend_match_count = rootScopedBackendMatches.length;
  error.cdp_method = "DOM.querySelectorAll";
  error.cdp_node_id = rootNodeId;
  error.cdp_param_keys = ["nodeId", "selector"];
  throw error;
}

async function rebindRecommendActionControlFrontendIds(client, control) {
  const expectedBackendNodeId = Number(control?.backend_node_id);
  const expectedRootBackendNodeId = Number(control?.root_backend_node_id);
  if (
    !Number.isInteger(expectedBackendNodeId)
    || expectedBackendNodeId <= 0
    || !Number.isInteger(expectedRootBackendNodeId)
    || expectedRootBackendNodeId <= 0
  ) {
    const error = new Error(
      "Recommend action control requires exact control/root backend identities for frontend rebind"
    );
    error.code = "RECOMMEND_ACTION_CONTROL_REBIND_REQUIRED";
    throw error;
  }

  // Candidate reproof deliberately calls DOM.getDocument. Chrome may then
  // replace every frontend node id even though the immutable backend nodes are
  // unchanged. Push only the two exact backend identities into the refreshed
  // frontend namespace; never rediscover by label or reuse a cached center.
  await client.DOM.getDocument({ depth: 0, pierce: true });
  const pushed = await client.DOM.pushNodesByBackendIdsToFrontend({
    backendNodeIds: [expectedBackendNodeId, expectedRootBackendNodeId]
  });
  const nodeId = Number(pushed?.nodeIds?.[0]);
  const rootNodeId = Number(pushed?.nodeIds?.[1]);
  if (
    !Number.isInteger(nodeId)
    || nodeId <= 0
    || !Number.isInteger(rootNodeId)
    || rootNodeId <= 0
    || nodeId === rootNodeId
  ) {
    const error = new Error(
      "Recommend action control/root backend identities could not be rebound to live frontend nodes"
    );
    error.code = "RECOMMEND_ACTION_CONTROL_REBIND_FAILED";
    error.expected_backend_node_id = expectedBackendNodeId;
    error.expected_root_backend_node_id = expectedRootBackendNodeId;
    error.observed_node_id = Number.isInteger(nodeId) && nodeId > 0 ? nodeId : null;
    error.observed_root_node_id = Number.isInteger(rootNodeId) && rootNodeId > 0
      ? rootNodeId
      : null;
    error.cdp_method = "DOM.pushNodesByBackendIdsToFrontend";
    error.cdp_param_keys = ["backendNodeIds"];
    error.cdp_backend_node_id = expectedBackendNodeId;
    throw error;
  }
  const [node, root] = await Promise.all([
    describeNode(client, nodeId, { depth: 0, pierce: true }),
    describeNode(client, rootNodeId, { depth: 0, pierce: true })
  ]);
  if (
    Number(node?.backendNodeId) !== expectedBackendNodeId
    || Number(root?.backendNodeId) !== expectedRootBackendNodeId
  ) {
    const error = new Error(
      "Recommend action control/root backend identities changed during frontend rebind"
    );
    error.code = "RECOMMEND_ACTION_CONTROL_REBIND_MISMATCH";
    error.expected_backend_node_id = expectedBackendNodeId;
    error.observed_backend_node_id = Number(node?.backendNodeId) || null;
    error.expected_root_backend_node_id = expectedRootBackendNodeId;
    error.observed_root_backend_node_id = Number(root?.backendNodeId) || null;
    error.cdp_method = "DOM.describeNode";
    error.cdp_param_keys = ["nodeId"];
    error.cdp_node_id = nodeId;
    error.cdp_backend_node_id = expectedBackendNodeId;
    throw error;
  }
  return {
    ...control,
    node_id: nodeId,
    root_node_id: rootNodeId
  };
}

export async function verifyRecommendActionControlIdentity(client, control, {
  requireContinueChat = false,
  requireGeometry = true,
  allowScroll = true,
  settleMs = 100
} = {}) {
  const originalNodeId = Number(control?.node_id);
  const expectedBackendNodeId = Number(control?.backend_node_id);
  if (
    !Number.isInteger(originalNodeId)
    || originalNodeId <= 0
    || !Number.isInteger(expectedBackendNodeId)
    || expectedBackendNodeId <= 0
  ) {
    const error = new Error("Recommend action control exact frontend/backend identity is missing");
    error.code = "RECOMMEND_ACTION_CONTROL_IDENTITY_REQUIRED";
    throw error;
  }
  const activeControl = await rebindRecommendActionControlFrontendIds(client, control);
  const nodeId = Number(activeControl.node_id);
  const scopeBefore = await verifyRecommendActionControlScope(client, activeControl);
  const described = await describeNode(client, nodeId);
  if (Number(described?.backendNodeId) !== expectedBackendNodeId) {
    const error = new Error("Recommend action control backend identity no longer matches discovery");
    error.code = "RECOMMEND_ACTION_CONTROL_IDENTITY_MISMATCH";
    error.expected_backend_node_id = expectedBackendNodeId;
    error.observed_backend_node_id = Number(described?.backendNodeId) || null;
    throw error;
  }
  if (allowScroll) {
    await scrollNodeIntoView(client, nodeId);
    if (settleMs > 0) await sleep(settleMs);
  }
  const rebound = await describeNode(client, nodeId);
  if (Number(rebound?.backendNodeId) !== expectedBackendNodeId) {
    const error = new Error(
      allowScroll
        ? "Recommend action control backend identity changed after fresh scroll"
        : "Recommend action control backend identity changed during no-scroll refresh"
    );
    error.code = "RECOMMEND_ACTION_CONTROL_IDENTITY_MISMATCH";
    error.expected_backend_node_id = expectedBackendNodeId;
    error.observed_backend_node_id = Number(rebound?.backendNodeId) || null;
    throw error;
  }
  const scopeAfter = await verifyRecommendActionControlScope(client, activeControl);
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
  ]);
  const classification = activeControl?.kind === "favorite"
    ? classifyFavoriteControl({ outerHTML, attributes })
    : classifyGreetControl({ outerHTML, attributes });
  const expectedLabel = normalizeText(activeControl?.label || "");
  const observedLabel = normalizeText(classification?.label || "");
  const exactContinueChat = Boolean(
    classification?.continue_chat === true
    && observedLabel === "继续沟通"
  );
  const exactExpectedState = requireContinueChat
    ? exactContinueChat
    : activeControl?.kind === "greet"
      ? classification.available === true
        && classification.continue_chat === false
        && observedLabel === expectedLabel
      : classification.matches === true && observedLabel === expectedLabel;
  if (!expectedLabel || !exactExpectedState || classification.disabled === true) {
    const error = new Error("Recommend action control exact visible label/state is not verified");
    error.code = "RECOMMEND_ACTION_CONTROL_LABEL_MISMATCH";
    error.expected_label = requireContinueChat ? "继续沟通" : expectedLabel || null;
    error.observed_label = observedLabel || null;
    throw error;
  }
  let geometry = null;
  if (requireGeometry) {
    const box = await getNodeBox(client, nodeId);
    const valid = [box?.center?.x, box?.center?.y, box?.rect?.width, box?.rect?.height]
      .every((value) => Number.isFinite(Number(value)))
      && Number(box.rect.width) > 2
      && Number(box.rect.height) > 2;
    if (!valid) {
      const error = new Error("Recommend action control fresh geometry is unreadable");
      error.code = "RECOMMEND_ACTION_CONTROL_GEOMETRY_UNREADABLE";
      throw error;
    }
    geometry = { center: box.center, rect: box.rect };
  }
  return {
    verified: true,
    node_id: nodeId,
    backend_node_id: expectedBackendNodeId,
    root: activeControl?.root || null,
    root_node_id: scopeAfter.root_node_id,
    root_backend_node_id: scopeAfter.root_backend_node_id,
    root_ancestry_depth: scopeAfter.ancestry_depth,
    root_scope_stable: scopeBefore.root_backend_node_id === scopeAfter.root_backend_node_id,
    scroll_allowed: allowScroll === true,
    settle_ms: allowScroll ? Math.max(0, Number(settleMs) || 0) : 0,
    label: observedLabel,
    continue_chat: exactContinueChat,
    center: geometry?.center || null,
    rect: geometry?.rect || null
  };
}

function positiveActionNodeId(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function resolveRecommendActionClickPointCandidates(rect) {
  const left = Number(rect?.x);
  const top = Number(rect?.y);
  const width = Number(rect?.width);
  const height = Number(rect?.height);
  if (
    !Number.isFinite(left)
    || !Number.isFinite(top)
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 2
    || height <= 2
  ) return [];
  const candidates = [
    { name: "center", x: left + width * 0.5, y: top + height * 0.5 },
    { name: "left_inset", x: left + width * 0.25, y: top + height * 0.5 },
    { name: "right_inset", x: left + width * 0.75, y: top + height * 0.5 },
    { name: "upper_inset", x: left + width * 0.5, y: top + height * 0.35 },
    { name: "lower_inset", x: left + width * 0.5, y: top + height * 0.65 }
  ];
  const seen = new Set();
  return candidates.flatMap((point) => {
    const rounded = {
      name: point.name,
      x: Math.round(point.x),
      y: Math.round(point.y)
    };
    const key = `${rounded.x}:${rounded.y}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [rounded];
  });
}

function createRecommendActionControlHitTestError(reason, evidence = null) {
  const error = new Error(`Recommend action control hit-test proof failed: ${reason}`);
  error.code = "RECOMMEND_ACTION_CONTROL_HIT_TEST_UNVERIFIED";
  error.phase = "recommend:post-action-pre-input";
  error.recommend_pre_input_aborted = true;
  error.recommend_input_dispatched = false;
  error.recommend_action_control_hit_test = evidence;
  if (reason === "layout_metrics_unavailable" || reason === "layout_metrics_invalid") {
    error.cdp_method = "Page.getLayoutMetrics";
    error.cdp_param_keys = [];
  } else if (reason === "control_descendants_unavailable") {
    error.cdp_method = "DOM.querySelectorAll";
    error.cdp_param_keys = ["nodeId", "selector"];
  } else {
    error.cdp_method = "DOM.getNodeForLocation";
    error.cdp_param_keys = ["x", "y", "includeUserAgentShadowDOM"];
  }
  return error;
}

async function readRecommendActionControlHitTestEvidence(client, control) {
  const controlNodeId = positiveActionNodeId(control?.node_id);
  const expectedControlBackendNodeId = positiveActionNodeId(control?.backend_node_id);
  const expectedRootBackendNodeId = positiveActionNodeId(control?.root_backend_node_id);
  const baseEvidence = {
    verified: false,
    exact_control_hit_verified: false,
    control_node_id: controlNodeId || null,
    control_backend_node_id: expectedControlBackendNodeId || null,
    root_backend_node_id: expectedRootBackendNodeId || null,
    viewport: null,
    control_descendant_backend_count: 0,
    selected: null,
    attempts: []
  };
  if (typeof client?.Page?.getLayoutMetrics !== "function") {
    throw createRecommendActionControlHitTestError("layout_metrics_unavailable", baseEvidence);
  }
  if (typeof client?.DOM?.querySelectorAll !== "function") {
    throw createRecommendActionControlHitTestError("control_descendants_unavailable", baseEvidence);
  }
  if (typeof client?.DOM?.getNodeForLocation !== "function") {
    throw createRecommendActionControlHitTestError("node_location_unavailable", baseEvidence);
  }

  const metrics = await client.Page.getLayoutMetrics();
  const viewport = metrics?.cssVisualViewport
    || metrics?.visualViewport
    || metrics?.cssLayoutViewport
    || metrics?.layoutViewport
    || null;
  const viewportWidth = Number(viewport?.clientWidth || viewport?.width || 0);
  const viewportHeight = Number(viewport?.clientHeight || viewport?.height || 0);
  const viewportEvidence = {
    width: viewportWidth,
    height: viewportHeight,
    page_x: Number(viewport?.pageX || 0),
    page_y: Number(viewport?.pageY || 0),
    scale: Number(viewport?.scale || 1),
    source: metrics?.cssVisualViewport
      ? "cssVisualViewport"
      : metrics?.visualViewport
      ? "visualViewport"
      : metrics?.cssLayoutViewport
      ? "cssLayoutViewport"
      : metrics?.layoutViewport
      ? "layoutViewport"
      : null
  };
  baseEvidence.viewport = viewportEvidence;
  if (
    !Number.isFinite(viewportWidth)
    || viewportWidth <= 4
    || !Number.isFinite(viewportHeight)
    || viewportHeight <= 4
  ) {
    throw createRecommendActionControlHitTestError("layout_metrics_invalid", baseEvidence);
  }

  const descendantNodeIds = await querySelectorAll(client, controlNodeId, "*");
  if (descendantNodeIds.length > 256) {
    const evidence = {
      ...baseEvidence,
      control_descendant_count: descendantNodeIds.length
    };
    throw createRecommendActionControlHitTestError("control_descendant_set_too_large", evidence);
  }
  const ownedBackendNodeIds = new Set([expectedControlBackendNodeId]);
  for (const descendantNodeId of descendantNodeIds) {
    const described = await describeNode(client, descendantNodeId, { depth: 0, pierce: true });
    const backendNodeId = positiveActionNodeId(described?.backendNodeId);
    if (backendNodeId) ownedBackendNodeIds.add(backendNodeId);
  }
  baseEvidence.control_descendant_backend_count = Math.max(0, ownedBackendNodeIds.size - 1);

  const margin = 2;
  const attempts = [];
  for (const point of resolveRecommendActionClickPointCandidates(control?.rect)) {
    const insideViewport = Boolean(
      point.x >= margin
      && point.x <= viewportWidth - margin
      && point.y >= margin
      && point.y <= viewportHeight - margin
    );
    if (!insideViewport) {
      attempts.push({
        point,
        inside_viewport: false,
        exact_control_hit: false,
        hit_node_id: null,
        hit_backend_node_id: null,
        hit_frame_id: null,
        reason: "action_click_point_outside_viewport"
      });
      continue;
    }
    // This must remain the last CDP read before Input whenever it succeeds.
    // Exact ownership is established only from backend IDs proven inside the
    // freshly rebound control subtree; root-only or same-label hits fail.
    const hit = await client.DOM.getNodeForLocation({
      x: point.x,
      y: point.y,
      includeUserAgentShadowDOM: true
    });
    const hitNodeId = positiveActionNodeId(hit?.nodeId);
    const hitBackendNodeId = positiveActionNodeId(hit?.backendNodeId);
    const exactControlHit = Boolean(
      hitBackendNodeId
      && ownedBackendNodeIds.has(hitBackendNodeId)
    );
    const attempt = {
      point,
      inside_viewport: true,
      exact_control_hit: exactControlHit,
      hit_node_id: hitNodeId || null,
      hit_backend_node_id: hitBackendNodeId || null,
      hit_frame_id: hit?.frameId || null,
      reason: exactControlHit ? null : "action_click_point_not_owned_by_exact_control"
    };
    attempts.push(attempt);
    if (exactControlHit) {
      return {
        ...baseEvidence,
        verified: true,
        exact_control_hit_verified: true,
        selected: point,
        attempts
      };
    }
  }
  const evidence = {
    ...baseEvidence,
    attempts
  };
  const reason = attempts.some((attempt) => attempt.inside_viewport)
    ? "action_click_point_not_owned_by_exact_control"
    : "action_click_point_outside_viewport";
  throw createRecommendActionControlHitTestError(reason, evidence);
}

export async function clickRecommendActionControl(client, control, {
  allowDisabled = false,
  beforeRefresh = null,
  beforeFinalRefresh = null,
  beforeClick = null,
  beforeInput = null,
  immediatelyBeforeInput = null,
  inputTimeoutMs = RECOMMEND_NON_REPLAYABLE_INPUT_TIMEOUT_MS
} = {}) {
  const greetQuota = control?.kind === "greet"
    ? assertGreetQuotaAvailable(control.greet_quota || control.label || "")
    : null;
  if (control?.disabled && !allowDisabled) {
    throw new Error(`Action control is disabled: ${control.kind}`);
  }

  const originalNodeId = Number(control?.node_id);
  const expectedBackendNodeId = Number(control?.backend_node_id);
  if (
    !Number.isInteger(originalNodeId)
    || originalNodeId <= 0
    || !Number.isInteger(expectedBackendNodeId)
    || expectedBackendNodeId <= 0
  ) {
    const error = new Error(
      "Recommend action control requires exact frontend/backend identity; cached centers are never clickable"
    );
    error.code = "RECOMMEND_ACTION_CONTROL_IDENTITY_REQUIRED";
    error.phase = "recommend:post-action-control-refresh";
    error.cached_center_ignored = Boolean(control?.center);
    throw error;
  }
  if (beforeRefresh != null) {
    if (typeof beforeRefresh !== "function") {
      const error = new Error("Recommend action beforeRefresh must be a function");
      error.code = "RECOMMEND_ACTION_BEFORE_REFRESH_INVALID";
      throw error;
    }
    await beforeRefresh();
  }

  let clickCenter = null;
  let clickRect = null;
  let clickTargetProof = null;
  let activeControl = control;
  let nodeId = originalNodeId;
  {
    let refreshStep = "rebind_before_scroll";
    try {
      activeControl = await rebindRecommendActionControlFrontendIds(client, activeControl);
      nodeId = Number(activeControl.node_id);
      refreshStep = "describe_before_scroll";
      await verifyRecommendActionControlScope(client, activeControl);
      const beforeNode = await describeNode(client, nodeId);
      if (Number(beforeNode?.backendNodeId) !== expectedBackendNodeId) {
        const error = new Error("Recommend action control backend identity changed before click");
        error.code = "RECOMMEND_ACTION_CONTROL_IDENTITY_MISMATCH";
        throw error;
      }
      refreshStep = "scroll_into_view";
      await scrollNodeIntoView(client, nodeId);
      await sleep(150);
      if (beforeFinalRefresh != null) {
        if (typeof beforeFinalRefresh !== "function") {
          const error = new Error("Recommend action beforeFinalRefresh must be a function");
          error.code = "RECOMMEND_ACTION_BEFORE_FINAL_REFRESH_INVALID";
          throw error;
        }
        refreshStep = "before_final_refresh";
        await beforeFinalRefresh();
      }
      refreshStep = "rebind_after_final_refresh";
      activeControl = await rebindRecommendActionControlFrontendIds(client, activeControl);
      nodeId = Number(activeControl.node_id);
      refreshStep = "describe_after_scroll";
      const afterNode = await describeNode(client, nodeId);
      if (Number(afterNode?.backendNodeId) !== expectedBackendNodeId) {
        const error = new Error("Recommend action control backend identity changed after scroll");
        error.code = "RECOMMEND_ACTION_CONTROL_IDENTITY_MISMATCH";
        throw error;
      }
      refreshStep = "verify_detail_scope_after_scroll";
      await verifyRecommendActionControlScope(client, activeControl);
      refreshStep = "read_exact_label";
      const [freshAttributes, freshOuterHTML] = await Promise.all([
        getAttributesMap(client, nodeId),
        getOuterHTML(client, nodeId)
      ]);
      const freshClassification = activeControl?.kind === "favorite"
        ? classifyFavoriteControl({ outerHTML: freshOuterHTML, attributes: freshAttributes })
        : classifyGreetControl({ outerHTML: freshOuterHTML, attributes: freshAttributes });
      const expectedLabel = normalizeText(activeControl?.label || "");
      const freshLabel = normalizeText(freshClassification?.label || "");
      const exactKindState = activeControl?.kind === "greet"
        ? activeControl?.continue_chat === true
          ? freshClassification.continue_chat === true && freshLabel === "继续沟通"
          : freshClassification.available === true && freshClassification.continue_chat === false
        : freshClassification.matches === true;
      if (
        !expectedLabel
        || freshLabel !== expectedLabel
        || !exactKindState
        || freshClassification.disabled === true
      ) {
        const error = new Error("Recommend action control exact label/state changed before click");
        error.code = "RECOMMEND_ACTION_CONTROL_LABEL_MISMATCH";
        error.expected_label = expectedLabel || null;
        error.observed_label = freshLabel || null;
        throw error;
      }
      refreshStep = "read_box_model";
      const box = await getNodeBox(client, nodeId);
      const centerX = Number(box?.center?.x);
      const centerY = Number(box?.center?.y);
      const width = Number(box?.rect?.width);
      const height = Number(box?.rect?.height);
      if (
        !Number.isFinite(centerX)
        || !Number.isFinite(centerY)
        || !Number.isFinite(width)
        || !Number.isFinite(height)
        || width <= 2
        || height <= 2
      ) {
        const error = new Error(
          `Could not compute box model for recommend action control nodeId=${nodeId}`
        );
        error.code = "RECOMMEND_ACTION_CONTROL_GEOMETRY_UNREADABLE";
        throw error;
      }
      clickCenter = box.center;
      clickRect = box.rect;
      refreshStep = "verify_detail_scope_before_journal";
      await verifyRecommendActionControlScope(client, activeControl);
    } catch (error) {
      const failure = error instanceof Error
        ? error
        : new Error(String(error || "Recommend action control refresh failed"));
      failure.code = failure.code || "RECOMMEND_ACTION_CONTROL_REFRESH_FAILED";
      failure.phase = failure.phase || "recommend:post-action-control-refresh";
      failure.action_control_refresh_step = failure.action_control_refresh_step || refreshStep;
      failure.action_control = failure.action_control || {
        kind: activeControl?.kind || null,
        label: activeControl?.label || null,
        selector: activeControl?.selector || null,
        root: activeControl?.root || null,
        root_node_id: Number(activeControl?.root_node_id) || null,
        root_backend_node_id: Number(activeControl?.root_backend_node_id) || null,
        node_id: nodeId
      };
      failure.cached_center_ignored = Boolean(control?.center);
      const refreshMethod = {
        rebind_before_scroll: "DOM.pushNodesByBackendIdsToFrontend",
        describe_before_scroll: "DOM.describeNode",
        scroll_into_view: "DOM.scrollIntoViewIfNeeded",
        rebind_after_final_refresh: "DOM.pushNodesByBackendIdsToFrontend",
        describe_after_scroll: "DOM.describeNode",
        verify_detail_scope_after_scroll: "DOM.describeNode",
        read_exact_label: "DOM.getOuterHTML",
        read_box_model: "DOM.getBoxModel",
        verify_detail_scope_before_journal: "DOM.describeNode"
      }[refreshStep] || null;
      if (refreshMethod) failure.cdp_method = failure.cdp_method || refreshMethod;
      failure.cdp_node_id = failure.cdp_node_id || nodeId;
      failure.cdp_param_keys = Array.isArray(failure.cdp_param_keys)
        ? failure.cdp_param_keys
        : refreshStep.startsWith("rebind_")
          ? ["backendNodeIds"]
          : ["nodeId"];
      throw failure;
    }
  }
  try {
    if (beforeClick != null) {
      if (typeof beforeClick !== "function") {
        const error = new Error("Recommend action beforeClick must be a function");
        error.code = "RECOMMEND_ACTION_BEFORE_CLICK_INVALID";
        throw error;
      }
      await beforeClick({
        kind: activeControl.kind,
        label: activeControl.label,
        selector: activeControl.selector,
        root: activeControl.root,
        root_node_id: Number(activeControl?.root_node_id) || null,
        root_backend_node_id: Number(activeControl?.root_backend_node_id) || null,
        node_id: nodeId,
        backend_node_id: expectedBackendNodeId,
        center: clickCenter,
        rect: clickRect
      });
    }
    if (beforeInput != null) {
      if (typeof beforeInput !== "function") {
        const error = new Error("Recommend action beforeInput must be a function");
        error.code = "RECOMMEND_ACTION_BEFORE_INPUT_INVALID";
        throw error;
      }
      await beforeInput();
    }
    const controlAfterFinalScroll = await verifyRecommendActionControlIdentity(client, activeControl, {
      requireContinueChat: activeControl?.continue_chat === true,
      requireGeometry: false,
      allowScroll: true,
      settleMs: 100
    });
    activeControl = { ...activeControl, ...controlAfterFinalScroll };
    if (immediatelyBeforeInput != null) {
      if (typeof immediatelyBeforeInput !== "function") {
        const error = new Error("Recommend action immediatelyBeforeInput must be a function");
        error.code = "RECOMMEND_ACTION_IMMEDIATELY_BEFORE_INPUT_INVALID";
        throw error;
      }
      await immediatelyBeforeInput(controlAfterFinalScroll);
    }
    // The candidate/root hook above must be non-scrolling. Re-read the exact
    // control/root/label/box after it with no scroll and no settle, then prove
    // a bounded point's topmost native hit belongs to this exact control.
    // A successful DOM.getNodeForLocation is the last CDP read before Input.
    const finalControl = await verifyRecommendActionControlIdentity(client, activeControl, {
      requireContinueChat: activeControl?.continue_chat === true,
      requireGeometry: true,
      allowScroll: false,
      settleMs: 0
    });
    clickCenter = finalControl.center;
    clickRect = finalControl.rect;
    activeControl = { ...activeControl, ...finalControl };
    clickTargetProof = await readRecommendActionControlHitTestEvidence(client, activeControl);
    clickCenter = {
      x: clickTargetProof.selected.x,
      y: clickTargetProof.selected.y
    };
  } catch (error) {
    const failure = error instanceof Error
      ? error
      : new Error(String(error || "Recommend action pre-Input verification failed"));
    failure.recommend_pre_input_aborted = true;
    failure.recommend_input_dispatched = false;
    failure.phase = failure.phase || "recommend:post-action-pre-input";
    throw failure;
  }
  try {
    await runRecommendNonReplayableInputWithDeadline(
      client,
      () => clickPoint(client, clickCenter.x, clickCenter.y, {
        humanRestEnabled: false,
        moveBeforePress: false
      }),
      { timeoutMs: inputTimeoutMs }
    );
  } catch (error) {
    if (error?.code === "RECOMMEND_ACTION_INPUT_TIMEOUT") {
      error.recommend_action_control_hit_test = clickTargetProof;
    }
    throw error;
  }
  return {
    clicked: true,
    kind: activeControl.kind,
    label: activeControl.label,
    greet_quota: greetQuota?.found ? greetQuota : null,
    selector: activeControl.selector,
    root: activeControl.root,
    root_node_id: Number(activeControl?.root_node_id) || null,
    root_backend_node_id: Number(activeControl?.root_backend_node_id) || null,
    node_id: Number(activeControl?.node_id) || null,
    backend_node_id: expectedBackendNodeId,
    center: clickCenter,
    rect: clickRect,
    click_target_proof: clickTargetProof
  };
}
