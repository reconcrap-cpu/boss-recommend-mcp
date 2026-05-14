import crypto from "node:crypto";
import {
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  scrollNodeIntoView,
  sleep
} from "../browser/index.js";

export const DEFAULT_BOTTOM_HINT_KEYWORDS = Object.freeze([
  "没有更多",
  "已显示全部",
  "已经到底",
  "暂无更多",
  "推荐完了",
  "没有更多人选",
  "没有更多了",
  "已到底"
]);

export const DEFAULT_LOAD_MORE_HINT_KEYWORDS = Object.freeze([
  "滚动加载更多",
  "下滑加载更多",
  "继续下滑",
  "继续滑动",
  "滑动加载",
  "正在加载",
  "加载中"
]);

export const DEFAULT_BOTTOM_MARKER_SELECTORS = Object.freeze([
  ".finished-wrap",
  ".loadmore",
  ".load-tips",
  "div[role=\"tfoot\"] .load-tips",
  ".no-data-refresh",
  ".empty-tip",
  ".empty-text",
  ".no-data",
  ".tip-nodata",
  "[class*=\"finished\"]",
  "[class*=\"loadmore\"]",
  "[class*=\"load-tips\"]",
  "[class*=\"no-more\"]",
  "[class*=\"no_more\"]"
]);

export const DEFAULT_BOTTOM_TEXT_SCAN_SELECTORS = Object.freeze([
  "div",
  "span",
  "p",
  "li",
  "button",
  "a"
]);

export const DEFAULT_BOTTOM_REFRESH_SELECTORS = Object.freeze([
  ".finished-wrap .btn-refresh",
  ".finished-wrap .btn",
  ".no-data-refresh .btn-refresh",
  ".no-data-refresh .btn",
  "[class*=\"refresh\"]",
  "[ka*=\"refresh\"]",
  "button",
  "a"
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function decodeBasicHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
}

function plainTextFromHtml(html = "") {
  return normalizeText(decodeBasicHtmlEntities(String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")));
}

function isUsableBox(box) {
  return Number(box?.rect?.width || 0) > 2 && Number(box?.rect?.height || 0) > 2;
}

function isUsableRect(rect) {
  return Number(rect?.width || 0) > 2 && Number(rect?.height || 0) > 2;
}

function pointFromRect(rect, {
  xRatio = 0.5,
  yRatio = 0.75,
  inset = 8
} = {}) {
  if (!isUsableRect(rect)) return null;
  const safeInsetX = Math.min(Math.max(0, Number(inset) || 0), Math.max(0, rect.width / 2 - 1));
  const safeInsetY = Math.min(Math.max(0, Number(inset) || 0), Math.max(0, rect.height / 2 - 1));
  const minX = rect.x + safeInsetX;
  const maxX = rect.x + rect.width - safeInsetX;
  const minY = rect.y + safeInsetY;
  const maxY = rect.y + rect.height - safeInsetY;
  return {
    x: Math.min(maxX, Math.max(minX, rect.x + rect.width * (Number(xRatio) || 0.5))),
    y: Math.min(maxY, Math.max(minY, rect.y + rect.height * (Number(yRatio) || 0.75)))
  };
}

function unionRects(rects = []) {
  const usable = rects.filter(isUsableRect);
  if (!usable.length) return null;
  const left = Math.min(...usable.map((rect) => rect.x));
  const top = Math.min(...usable.map((rect) => rect.y));
  const right = Math.max(...usable.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...usable.map((rect) => rect.y + rect.height));
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function pointInsideRect(point, rect, {
  padding = 0
} = {}) {
  if (!point || !isUsableRect(rect)) return false;
  const pad = Math.max(0, Number(padding) || 0);
  return Number(point.x) >= rect.x + pad
    && Number(point.x) <= rect.x + rect.width - pad
    && Number(point.y) >= rect.y + pad
    && Number(point.y) <= rect.y + rect.height - pad;
}

function rectsIntersect(a, b, {
  padding = 0
} = {}) {
  if (!isUsableRect(a) || !isUsableRect(b)) return false;
  const pad = Math.max(0, Number(padding) || 0);
  return a.x + a.width >= b.x + pad
    && b.x + b.width >= a.x + pad
    && a.y + a.height >= b.y + pad
    && b.y + b.height >= a.y + pad;
}

function intersectRects(a, b) {
  if (!isUsableRect(a) || !isUsableRect(b)) return null;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right - left <= 2 || bottom - top <= 2) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  };
}

function normalizePoint(point) {
  if (!point) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function normalizeRandom(random) {
  return typeof random === "function" ? random : Math.random;
}

function randomBetween(random, min, max) {
  const lower = Number(min) || 0;
  const upper = Number(max) || lower;
  if (upper <= lower) return lower;
  return lower + random() * (upper - lower);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function resolveInfiniteListScrollTiming({
  wheelDeltaY = 850,
  settleMs = 1200,
  listScrollJitterEnabled = false,
  listScrollJitterMinRatio = 0.85,
  listScrollJitterMaxRatio = 1.15,
  listSettleJitterMinRatio = 0.75,
  listSettleJitterMaxRatio = 1.35,
  random = Math.random
} = {}) {
  const baseDeltaY = Math.max(1, Number(wheelDeltaY) || 850);
  const baseSettleMs = Math.max(0, Number(settleMs) || 0);
  if (listScrollJitterEnabled !== true) {
    return {
      wheelDeltaY: baseDeltaY,
      settleMs: baseSettleMs,
      wheel_delta_jitter: {
        enabled: false,
        base_delta_y: baseDeltaY,
        actual_delta_y: baseDeltaY
      },
      settle_jitter: {
        enabled: false,
        base_settle_ms: baseSettleMs,
        actual_settle_ms: baseSettleMs
      }
    };
  }
  const nextRandom = normalizeRandom(random);
  const minDeltaRatio = clampNumber(listScrollJitterMinRatio, 0.5, 1.5);
  const maxDeltaRatio = clampNumber(listScrollJitterMaxRatio, minDeltaRatio, 1.5);
  const minSettleRatio = clampNumber(listSettleJitterMinRatio, 0.4, 2);
  const maxSettleRatio = clampNumber(listSettleJitterMaxRatio, minSettleRatio, 2);
  const deltaRatio = randomBetween(nextRandom, minDeltaRatio, maxDeltaRatio);
  const settleRatio = randomBetween(nextRandom, minSettleRatio, maxSettleRatio);
  const actualDeltaY = Math.max(1, Math.round(baseDeltaY * deltaRatio));
  const actualSettleMs = Math.max(0, Math.round(baseSettleMs * settleRatio));
  return {
    wheelDeltaY: actualDeltaY,
    settleMs: actualSettleMs,
    wheel_delta_jitter: {
      enabled: true,
      preserve_coverage: true,
      base_delta_y: baseDeltaY,
      actual_delta_y: actualDeltaY,
      ratio: deltaRatio,
      min_ratio: minDeltaRatio,
      max_ratio: maxDeltaRatio
    },
    settle_jitter: {
      enabled: true,
      base_settle_ms: baseSettleMs,
      actual_settle_ms: actualSettleMs,
      ratio: settleRatio,
      min_ratio: minSettleRatio,
      max_ratio: maxSettleRatio
    }
  };
}

function resolveViewportPoint(viewportPoint, viewport) {
  if (!viewportPoint) return null;
  if (viewport && ("xRatio" in viewportPoint || "yRatio" in viewportPoint)) {
    const xRatio = Number(viewportPoint.xRatio ?? 0);
    const yRatio = Number(viewportPoint.yRatio ?? 0);
    if (Number.isFinite(xRatio) && Number.isFinite(yRatio)) {
      return {
        x: viewport.x + viewport.width * xRatio,
        y: viewport.y + viewport.height * yRatio
      };
    }
  }
  return normalizePoint(viewportPoint);
}

async function getViewportRect(client) {
  try {
    const metrics = await client.Page.getLayoutMetrics();
    const viewport = metrics.visualViewport || metrics.layoutViewport || metrics.cssVisualViewport || {};
    const width = Number(viewport.clientWidth || viewport.width || metrics.layoutViewport?.clientWidth || 0);
    const height = Number(viewport.clientHeight || viewport.height || metrics.layoutViewport?.clientHeight || 0);
    const x = Number(viewport.pageX || viewport.x || 0);
    const y = Number(viewport.pageY || viewport.y || 0);
    if (width > 0 && height > 0) {
      return { x, y, width, height };
    }
  } catch {
    // Page.getLayoutMetrics is optional for fallback only.
  }
  return null;
}

async function collectUsableNodeBoxes(client, nodeIds = [], {
  maxNodes = 80
} = {}) {
  const boxes = [];
  const errors = [];
  for (const nodeId of nodeIds.slice(0, Math.max(1, Number(maxNodes) || 80))) {
    try {
      const box = await getNodeBox(client, nodeId);
      if (isUsableBox(box)) {
        boxes.push({
          node_id: nodeId,
          box,
          rect: box.rect
        });
      }
    } catch (error) {
      errors.push({
        node_id: nodeId,
        error: error?.message || String(error)
      });
    }
  }
  return { boxes, errors };
}

async function querySelectorBoxes(client, rootNodeId, selectors = [], {
  maxNodes = 80
} = {}) {
  const attempts = [];
  if (!rootNodeId) return { boxes: [], attempts };
  for (const selector of selectors.filter(Boolean)) {
    let nodeIds = [];
    try {
      nodeIds = await querySelectorAll(client, rootNodeId, selector);
    } catch (error) {
      attempts.push({
        selector,
        error: error?.message || String(error),
        node_count: 0,
        box_count: 0
      });
      continue;
    }
    const measured = await collectUsableNodeBoxes(client, nodeIds, { maxNodes });
    attempts.push({
      selector,
      node_count: nodeIds.length,
      box_count: measured.boxes.length,
      errors: measured.errors
    });
    if (measured.boxes.length) {
      return {
        boxes: measured.boxes,
        selector,
        attempts
      };
    }
  }
  return { boxes: [], attempts };
}

export async function resolveInfiniteListFallbackPoint(client, {
  rootNodeId = 0,
  containerSelectors = [],
  itemNodeIds = [],
  itemSelectors = [],
  allowedSources = ["container", "item_union", "viewport_ratio"],
  containerXRatio = 0.5,
  containerYRatio = 0.5,
  itemXRatio = 0.5,
  itemYRatio = 0.5,
  viewportPoint = null,
  validateViewportPoint = true,
  maxProbeNodes = 80
} = {}) {
  const attempts = [];
  const allowed = new Set(Array.isArray(allowedSources) && allowedSources.length
    ? allowedSources.map((source) => String(source || ""))
    : ["container", "item_union", "viewport_ratio"]);

  const containerResult = await querySelectorBoxes(client, rootNodeId, containerSelectors, {
    maxNodes: maxProbeNodes
  });
  attempts.push({
    source: "container",
    selector: containerResult.selector || null,
    attempts: containerResult.attempts
  });
  const containerBox = containerResult.boxes
    .slice()
    .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
  const viewport = await getViewportRect(client);
  const inputViewportRect = viewport
    ? { x: 0, y: 0, width: viewport.width, height: viewport.height }
    : null;
  const visibleContainerRect = inputViewportRect && containerBox?.rect
    ? intersectRects(containerBox.rect, inputViewportRect) || containerBox.rect
    : containerBox?.rect;
  const containerPoint = pointFromRect(visibleContainerRect, {
    xRatio: containerXRatio,
    yRatio: containerYRatio
  });
  if (containerPoint && allowed.has("container")) {
    return {
      ok: true,
      source: "container",
      point: containerPoint,
      selector: containerResult.selector || null,
      node_id: containerBox.node_id,
      assist_node_id: itemNodeIds.slice(-1)[0] || null,
      rect: visibleContainerRect,
      full_rect: containerBox.rect,
      attempts
    };
  }

  let itemBoxes = [];
  const itemProbeNodeIds = itemNodeIds.length > maxProbeNodes
    ? itemNodeIds.slice(-maxProbeNodes)
    : itemNodeIds;
  const measuredItems = await collectUsableNodeBoxes(client, itemProbeNodeIds, { maxNodes: maxProbeNodes });
  itemBoxes = measuredItems.boxes;
  attempts.push({
    source: "visible_items",
    node_count: itemNodeIds.length,
    box_count: measuredItems.boxes.length,
    errors: measuredItems.errors
  });
  if (!itemBoxes.length) {
    const queriedItems = await querySelectorBoxes(client, rootNodeId, itemSelectors, {
      maxNodes: maxProbeNodes
    });
    itemBoxes = queriedItems.boxes;
    attempts.push({
      source: "item_selector",
      selector: queriedItems.selector || null,
      attempts: queriedItems.attempts
    });
  }
  const itemValidationRects = [
    inputViewportRect,
    visibleContainerRect || containerBox?.rect || null
  ].filter(isUsableRect);
  const visibleItemBoxes = itemValidationRects.length
    ? itemBoxes.filter((item) => itemValidationRects.every((rect) => rectsIntersect(item.rect, rect, { padding: 1 })))
    : itemBoxes;
  attempts.push({
    source: "visible_item_filter",
    input_box_count: itemBoxes.length,
    output_box_count: visibleItemBoxes.length,
    validation_rect_count: itemValidationRects.length
  });
  const unionSourceBoxes = visibleItemBoxes.length ? visibleItemBoxes : itemBoxes;
  const rawItemUnion = unionRects(unionSourceBoxes.map((item) => item.rect));
  const itemUnion = itemValidationRects.reduce(
    (rect, limit) => intersectRects(rect, limit) || rect,
    rawItemUnion
  );
  const itemPoint = pointFromRect(itemUnion, {
    xRatio: itemXRatio,
    yRatio: itemYRatio
  });
  if (itemPoint && allowed.has("item_union")) {
    const assistItem = unionSourceBoxes
      .slice()
      .sort((a, b) => ((b.rect.y + b.rect.height) - (a.rect.y + a.rect.height)))[0];
    return {
      ok: true,
      source: "item_union",
      point: itemPoint,
      rect: itemUnion,
      full_rect: rawItemUnion,
      item_box_count: unionSourceBoxes.length,
      visible_item_box_count: visibleItemBoxes.length,
      assist_node_id: assistItem?.node_id || itemNodeIds.slice(-1)[0] || null,
      attempts
    };
  }

  const viewportRatioPoint = resolveViewportPoint(viewportPoint, viewport);
  const normalizedViewportPoint = normalizePoint(viewportRatioPoint);
  if (normalizedViewportPoint && allowed.has("viewport_ratio")) {
    if (!validateViewportPoint) {
      return {
        ok: true,
        source: "viewport_ratio",
        point: normalizedViewportPoint,
        viewport,
        validated: false,
        attempts
      };
    }
    const validationRects = [
      ...containerResult.boxes.map((item) => item.rect),
      ...itemBoxes.map((item) => item.rect)
    ].filter(isUsableRect);
    const validatedRect = validationRects.find((rect) => pointInsideRect(normalizedViewportPoint, rect, { padding: 4 }));
    attempts.push({
      source: "viewport_ratio",
      point: normalizedViewportPoint,
      viewport,
      validation_rect_count: validationRects.length,
      validated: Boolean(validatedRect)
    });
    if (validatedRect) {
      return {
        ok: true,
        source: "viewport_ratio",
        point: normalizedViewportPoint,
        viewport,
        rect: validatedRect,
        validated: true,
        assist_node_id: itemNodeIds.slice(-1)[0] || null,
        attempts
      };
    }
  }

  return {
    ok: false,
    reason: "fallback_point_unavailable",
    attempts
  };
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function pickAttribute(attributes = {}, names = []) {
  for (const name of names) {
    const value = normalizeText(attributes[name]);
    if (value) return value;
  }
  return "";
}

export function candidateKeyFromProfile(candidate = {}, {
  nodeId = null,
  attributes = candidate.attributes || candidate.metadata?.attributes || {}
} = {}) {
  const text = normalizeText(candidate.text?.raw || candidate.text || "");
  const textSuffix = text ? `:text:${shortHash(text.slice(0, 1000))}` : "";
  const id = normalizeText(candidate.id);
  const stableAttrKey = pickAttribute(attributes, [
    "data-geek",
    "data-geekid",
    "data-expect",
    "data-uid",
    "data-securityid",
    "encryptgeekid",
    "geekid",
    "expect",
    "uid",
    "securityid"
  ]);
  if (id && stableAttrKey && id === stableAttrKey) return `${candidate.domain || "candidate"}:id:${id}`;
  if (id && !stableAttrKey) return `${candidate.domain || "candidate"}:id:${id}${textSuffix}`;
  if (id) return `${candidate.domain || "candidate"}:id:${id}${textSuffix}`;

  const attrKey = pickAttribute(attributes, [
    "data-geek",
    "data-geekid",
    "data-expect",
    "data-jid",
    "data-id",
    "data-uid",
    "data-securityid",
    "encryptgeekid",
    "href",
    "key",
    "id"
  ]);
  if (attrKey) return `${candidate.domain || "candidate"}:attr:${attrKey}${textSuffix}`;

  const identity = candidate.identity || {};
  const identityKey = [
    identity.name,
    identity.current_company,
    identity.current_position,
    identity.school,
    identity.major,
    identity.degree,
    identity.age,
    identity.gender
  ].map(normalizeText).filter(Boolean).join("|");
  if (identityKey) return `${candidate.domain || "candidate"}:identity:${shortHash(identityKey)}`;

  if (text) return `${candidate.domain || "candidate"}:text:${shortHash(text.slice(0, 1000))}`;

  return `${candidate.domain || "candidate"}:node:${nodeId || "unknown"}`;
}

export function createInfiniteListState({
  domain = "unknown",
  listName = "candidate-list"
} = {}) {
  return {
    schema_version: 1,
    domain,
    list_name: listName,
    created_at: nowIso(),
    seen_keys: new Set(),
    queued_keys: new Set(),
    processed_keys: new Set(),
    skipped_duplicate_count: 0,
    read_error_count: 0,
    scroll_count: 0,
    stable_signature_count: 0,
    last_visible_signature: "",
    last_result: null,
    ledger: []
  };
}

export function compactInfiniteListState(state = {}) {
  return {
    domain: state.domain || "unknown",
    list_name: state.list_name || "candidate-list",
    seen_count: state.seen_keys?.size || 0,
    queued_count: state.queued_keys?.size || 0,
    processed_count: state.processed_keys?.size || 0,
    skipped_duplicate_count: state.skipped_duplicate_count || 0,
    read_error_count: state.read_error_count || 0,
    scroll_count: state.scroll_count || 0,
    stable_signature_count: state.stable_signature_count || 0,
    last_visible_signature: state.last_visible_signature || "",
    last_result: state.last_result || null
  };
}

export function markInfiniteListCandidateProcessed(state, key, {
  status = "processed",
  metadata = {}
} = {}) {
  if (!state || !key) return compactInfiniteListState(state);
  state.queued_keys?.delete(key);
  state.processed_keys?.add(key);
  state.ledger?.push({
    at: nowIso(),
    event: "candidate_processed",
    key,
    status,
    metadata
  });
  return compactInfiniteListState(state);
}

export function markInfiniteListCandidateSkipped(state, key, {
  reason = "skipped",
  metadata = {}
} = {}) {
  if (!state || !key) return compactInfiniteListState(state);
  state.queued_keys?.delete(key);
  state.ledger?.push({
    at: nowIso(),
    event: "candidate_skipped",
    key,
    reason,
    metadata
  });
  return compactInfiniteListState(state);
}

export function resetInfiniteListForRefreshRound(state, {
  reason = "refresh_round",
  round = 0,
  method = "",
  metadata = {}
} = {}) {
  if (!state) return compactInfiniteListState(state);
  state.queued_keys?.clear();
  state.stable_signature_count = 0;
  state.last_visible_signature = "";
  state.last_result = null;
  state.ledger?.push({
    at: nowIso(),
    event: "refresh_round_started",
    reason,
    round,
    method,
    metadata
  });
  return compactInfiniteListState(state);
}

export function classifyInfiniteListBottomMarker({
  text = "",
  refreshButtonVisible = false,
  bottomKeywords = DEFAULT_BOTTOM_HINT_KEYWORDS,
  loadMoreKeywords = DEFAULT_LOAD_MORE_HINT_KEYWORDS
} = {}) {
  const normalizedText = normalizeText(text);
  const matchedBottomKeyword = bottomKeywords.find((keyword) => normalizedText.includes(keyword)) || null;
  if (matchedBottomKeyword) {
    return {
      is_bottom: true,
      reason: matchedBottomKeyword,
      matched_bottom_keyword: matchedBottomKeyword,
      matched_load_more_keyword: null
    };
  }

  const matchedLoadMoreKeyword = loadMoreKeywords.find((keyword) => normalizedText.includes(keyword)) || null;
  if (matchedLoadMoreKeyword) {
    return {
      is_bottom: false,
      reason: null,
      matched_bottom_keyword: null,
      matched_load_more_keyword: matchedLoadMoreKeyword
    };
  }

  if (refreshButtonVisible) {
    return {
      is_bottom: true,
      reason: "refresh_button_visible",
      matched_bottom_keyword: null,
      matched_load_more_keyword: null
    };
  }

  return {
    is_bottom: false,
    reason: null,
    matched_bottom_keyword: null,
    matched_load_more_keyword: null
  };
}

async function safeQuerySelectorAll(client, rootNodeId, selector) {
  try {
    return await querySelectorAll(client, rootNodeId, selector);
  } catch {
    return [];
  }
}

async function readVisibleMarkerNode(client, nodeId) {
  let box = null;
  try {
    box = await getNodeBox(client, nodeId);
  } catch {
    return null;
  }
  if (!isUsableBox(box)) return null;
  let outerHTML = "";
  try {
    outerHTML = await getOuterHTML(client, nodeId);
  } catch {
    return null;
  }
  return {
    node_id: nodeId,
    text: plainTextFromHtml(outerHTML),
    box
  };
}

function looksLikeRefreshLabel(text = "") {
  const normalized = normalizeText(text).replace(/\s+/g, "");
  return Boolean(normalized) && normalized.length <= 80 && /刷新|refresh/i.test(normalized);
}

export async function detectInfiniteListBottomMarker(client, {
  rootNodeId,
  markerSelectors = DEFAULT_BOTTOM_MARKER_SELECTORS,
  textScanSelectors = DEFAULT_BOTTOM_TEXT_SCAN_SELECTORS,
  refreshSelectors = DEFAULT_BOTTOM_REFRESH_SELECTORS,
  bottomKeywords = DEFAULT_BOTTOM_HINT_KEYWORDS,
  loadMoreKeywords = DEFAULT_LOAD_MORE_HINT_KEYWORDS,
  maxMarkerNodes = 300,
  maxTextScanNodes = 800,
  textMaxLength = 80
} = {}) {
  if (!client || !rootNodeId) {
    return {
      found: false,
      reason: "missing_client_or_root"
    };
  }

  const selectorCounts = {};
  const markerNodeIds = [];
  for (const selector of markerSelectors || []) {
    const nodeIds = await safeQuerySelectorAll(client, rootNodeId, selector);
    selectorCounts[selector] = nodeIds.length;
    markerNodeIds.push(...nodeIds);
  }

  const visibleMarkers = [];
  const markerIds = uniqueValues(markerNodeIds).slice(0, Math.max(0, Number(maxMarkerNodes) || 0));
  for (const nodeId of markerIds) {
    const marker = await readVisibleMarkerNode(client, nodeId);
    if (!marker?.text) continue;
    const classified = classifyInfiniteListBottomMarker({
      text: marker.text,
      bottomKeywords,
      loadMoreKeywords
    });
    const summary = {
      node_id: marker.node_id,
      text: marker.text.slice(0, 160),
      y: marker.box?.rect?.y || null,
      matched_bottom_keyword: classified.matched_bottom_keyword,
      matched_load_more_keyword: classified.matched_load_more_keyword
    };
    visibleMarkers.push(summary);
    if (classified.is_bottom) {
      return {
        found: true,
        reason: classified.reason,
        source: "marker_selector",
        marker: summary,
        selector_counts: selectorCounts,
        visible_marker_count: visibleMarkers.length,
        refresh_button_visible: false
      };
    }
  }

  const hasLoadMoreMarker = visibleMarkers.some((marker) => marker.matched_load_more_keyword);

  const refreshNodeIds = [];
  for (const selector of refreshSelectors || []) {
    const nodeIds = await safeQuerySelectorAll(client, rootNodeId, selector);
    selectorCounts[selector] = (selectorCounts[selector] || 0) + nodeIds.length;
    refreshNodeIds.push(...nodeIds);
  }
  const refreshButtons = [];
  for (const nodeId of uniqueValues(refreshNodeIds).slice(0, 300)) {
    const marker = await readVisibleMarkerNode(client, nodeId);
    if (!marker?.text || !looksLikeRefreshLabel(marker.text)) continue;
    refreshButtons.push({
      node_id: marker.node_id,
      text: marker.text.slice(0, 120),
      y: marker.box?.rect?.y || null
    });
  }
  if (refreshButtons.length && !hasLoadMoreMarker) {
    return {
      found: true,
      reason: "refresh_button_visible",
      source: "refresh_button",
      marker: refreshButtons[0],
      selector_counts: selectorCounts,
      visible_marker_count: visibleMarkers.length,
      refresh_button_visible: true,
      refresh_button_count: refreshButtons.length
    };
  }

  const scanNodeIds = [];
  for (const selector of textScanSelectors || []) {
    const nodeIds = await safeQuerySelectorAll(client, rootNodeId, selector);
    selectorCounts[selector] = (selectorCounts[selector] || 0) + nodeIds.length;
    scanNodeIds.push(...nodeIds);
  }
  let checkedTextNodeCount = 0;
  for (const nodeId of uniqueValues(scanNodeIds).slice(0, Math.max(0, Number(maxTextScanNodes) || 0))) {
    const marker = await readVisibleMarkerNode(client, nodeId);
    if (!marker?.text || marker.text.length > textMaxLength) continue;
    checkedTextNodeCount += 1;
    const classified = classifyInfiniteListBottomMarker({
      text: marker.text,
      bottomKeywords,
      loadMoreKeywords
    });
    if (classified.is_bottom) {
      return {
        found: true,
        reason: classified.reason,
        source: "text_scan",
        marker: {
          node_id: marker.node_id,
          text: marker.text.slice(0, 160),
          y: marker.box?.rect?.y || null,
          matched_bottom_keyword: classified.matched_bottom_keyword
        },
        selector_counts: selectorCounts,
        visible_marker_count: visibleMarkers.length,
        checked_text_node_count: checkedTextNodeCount,
        refresh_button_visible: refreshButtons.length > 0,
        refresh_button_count: refreshButtons.length
      };
    }
  }

  return {
    found: false,
    reason: hasLoadMoreMarker ? "load_more_marker_visible" : "bottom_marker_not_found",
    selector_counts: selectorCounts,
    visible_markers: visibleMarkers.slice(0, 20),
    visible_marker_count: visibleMarkers.length,
    checked_text_node_count: checkedTextNodeCount,
    refresh_button_visible: refreshButtons.length > 0,
    refresh_button_count: refreshButtons.length
  };
}

export async function readVisibleInfiniteListItems({
  nodeIds = [],
  readCandidate,
  keyForCandidate = candidateKeyFromProfile,
  state = null
} = {}) {
  if (typeof readCandidate !== "function") {
    throw new Error("readVisibleInfiniteListItems requires readCandidate");
  }
  const items = [];
  for (let visibleIndex = 0; visibleIndex < nodeIds.length; visibleIndex += 1) {
    const nodeId = nodeIds[visibleIndex];
    let candidate;
    try {
      candidate = await readCandidate(nodeId, { visibleIndex });
    } catch (error) {
      if (state) {
        state.read_error_count = (state.read_error_count || 0) + 1;
        state.ledger?.push({
          at: nowIso(),
          event: "candidate_read_error",
          node_id: nodeId,
          visible_index: visibleIndex,
          error: error?.message || String(error)
        });
      }
      continue;
    }
    const key = keyForCandidate(candidate, {
      nodeId,
      visibleIndex,
      attributes: candidate?.attributes || candidate?.metadata?.attributes || {}
    });
    items.push({
      key,
      node_id: nodeId,
      visible_index: visibleIndex,
      candidate
    });
  }
  return items;
}

export function updateInfiniteListVisibleSignature(state, items = []) {
  const signature = items.map((item) => item.key).filter(Boolean).join("|");
  const unchanged = Boolean(signature) && signature === state.last_visible_signature;
  state.stable_signature_count = unchanged ? (state.stable_signature_count || 0) + 1 : 0;
  state.last_visible_signature = signature;
  return {
    signature,
    unchanged,
    stable_signature_count: state.stable_signature_count
  };
}

export function firstUnseenInfiniteListItem(state, items = []) {
  for (const item of items) {
    if (!item.key) continue;
    if (state.processed_keys.has(item.key) || state.queued_keys.has(item.key)) {
      state.skipped_duplicate_count += 1;
      continue;
    }
    state.seen_keys.add(item.key);
    state.queued_keys.add(item.key);
    state.ledger.push({
      at: nowIso(),
      event: "candidate_queued",
      key: item.key,
      node_id: item.node_id,
      visible_index: item.visible_index
    });
    return item;
  }
  return null;
}

export async function scrollInfiniteListByVisibleItems(client, items = [], {
  wheelDeltaY = 850,
  settleMs = 1200,
  fallbackPoint = null,
  listScrollJitterEnabled = false,
  listScrollJitterMinRatio = 0.85,
  listScrollJitterMaxRatio = 1.15,
  listSettleJitterMinRatio = 0.75,
  listSettleJitterMaxRatio = 1.35,
  random = Math.random
} = {}) {
  const candidates = items.filter((item) => item?.node_id);
  if (!candidates.length) {
    return {
      ok: false,
      reason: "no_visible_items"
    };
  }

  const errors = [];
  const scrollTiming = resolveInfiniteListScrollTiming({
    wheelDeltaY,
    settleMs,
    listScrollJitterEnabled,
    listScrollJitterMinRatio,
    listScrollJitterMaxRatio,
    listSettleJitterMinRatio,
    listSettleJitterMaxRatio,
    random
  });
  const wheelDelta = scrollTiming.wheelDeltaY;
  const actualSettleMs = scrollTiming.settleMs;
  async function synthesizeGesture(x, y) {
    if (typeof client?.Input?.synthesizeScrollGesture !== "function") return null;
    try {
      const gestureDistance = -Math.min(1200, wheelDelta);
      await client.Input.synthesizeScrollGesture({
        x,
        y,
        yDistance: gestureDistance,
        speed: 800,
        repeatCount: 1
      });
      return {
        ok: true,
        y_distance: gestureDistance
      };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || String(error)
      };
    }
  }
  for (const anchor of candidates.slice().reverse()) {
    try {
      await scrollNodeIntoView(client, anchor.node_id);
      await sleep(150);
      const box = await getNodeBox(client, anchor.node_id);
      const x = box.center.x;
      const y = box.center.y;
      await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
      await client.Input.dispatchMouseEvent({
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: wheelDelta
      });
      const gesture = await synthesizeGesture(x, y);
      if (actualSettleMs > 0) await sleep(actualSettleMs);
      return {
        ok: true,
        anchor_key: anchor.key,
        anchor_node_id: anchor.node_id,
        point: { x, y },
        wheel_delta_y: wheelDelta,
        base_wheel_delta_y: Math.max(1, Number(wheelDeltaY) || 850),
        wheel_delta_jitter: scrollTiming.wheel_delta_jitter,
        gesture,
        settle_ms: actualSettleMs,
        base_settle_ms: Math.max(0, Number(settleMs) || 0),
        settle_jitter: scrollTiming.settle_jitter,
        skipped_stale_anchor_count: errors.length
      };
    } catch (error) {
      errors.push({
        anchor_key: anchor.key,
        anchor_node_id: anchor.node_id,
        error: error?.message || String(error)
      });
    }
  }

  const resolvedFallback = typeof fallbackPoint === "function"
    ? await fallbackPoint({ client, items, errors })
    : (fallbackPoint ? { ok: true, source: "static", point: fallbackPoint } : null);
  const resolvedPoint = normalizePoint(resolvedFallback?.point || resolvedFallback);
  if (resolvedPoint) {
    const x = resolvedPoint.x;
    const y = resolvedPoint.y;
    let assist = null;
    if (resolvedFallback?.assist_node_id) {
      try {
        await scrollNodeIntoView(client, resolvedFallback.assist_node_id);
        await sleep(150);
        assist = {
          ok: true,
          node_id: resolvedFallback.assist_node_id
        };
      } catch (error) {
        assist = {
          ok: false,
          node_id: resolvedFallback.assist_node_id,
          error: error?.message || String(error)
        };
      }
    }
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
    await client.Input.dispatchMouseEvent({
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: wheelDelta
    });
    const gesture = await synthesizeGesture(x, y);
    if (actualSettleMs > 0) await sleep(actualSettleMs);
    return {
      ok: true,
      mode: "fallback_point",
      fallback: {
        source: resolvedFallback?.source || "static",
        selector: resolvedFallback?.selector || null,
        node_id: resolvedFallback?.node_id || null,
        assist_node_id: resolvedFallback?.assist_node_id || null,
        rect: resolvedFallback?.rect || null,
        validated: resolvedFallback?.validated ?? null,
        reason: resolvedFallback?.reason || null
      },
      assist,
      point: { x, y },
      wheel_delta_y: wheelDelta,
      base_wheel_delta_y: Math.max(1, Number(wheelDeltaY) || 850),
      wheel_delta_jitter: scrollTiming.wheel_delta_jitter,
      gesture,
      settle_ms: actualSettleMs,
      base_settle_ms: Math.max(0, Number(settleMs) || 0),
      settle_jitter: scrollTiming.settle_jitter,
      skipped_stale_anchor_count: errors.length,
      stale_anchor_errors: errors
    };
  }

  return {
    ok: false,
    reason: "scroll_anchor_unavailable",
    errors,
    fallback: resolvedFallback || null
  };
}

export async function getNextInfiniteListCandidate({
  client,
  state,
  findNodeIds,
  readCandidate,
  detectBottomMarker = null,
  keyForCandidate = candidateKeyFromProfile,
  maxScrolls = 20,
  stableSignatureLimit = 2,
  minScrollsBeforeEnd = 3,
  wheelDeltaY = 850,
  settleMs = 1200,
  fallbackPoint = null,
  listScrollJitterEnabled = false,
  listScrollJitterMinRatio = 0.85,
  listScrollJitterMaxRatio = 1.15,
  listSettleJitterMinRatio = 0.75,
  listSettleJitterMaxRatio = 1.35,
  random = Math.random
} = {}) {
  if (!client) throw new Error("getNextInfiniteListCandidate requires client");
  if (!state) throw new Error("getNextInfiniteListCandidate requires state");
  if (typeof findNodeIds !== "function") throw new Error("getNextInfiniteListCandidate requires findNodeIds");
  if (typeof readCandidate !== "function") throw new Error("getNextInfiniteListCandidate requires readCandidate");

  const attempts = [];
  const maxAttempts = Math.max(0, Number(maxScrolls) || 0);
  for (let scrollAttempt = 0; scrollAttempt <= maxAttempts; scrollAttempt += 1) {
    const nodeIds = await findNodeIds();
    const items = await readVisibleInfiniteListItems({
      nodeIds,
      readCandidate,
      keyForCandidate,
      state
    });
    const signature = updateInfiniteListVisibleSignature(state, items);
    const next = firstUnseenInfiniteListItem(state, items);
    attempts.push({
      scroll_attempt: scrollAttempt,
      visible_count: items.length,
      signature: signature.signature,
      stable_signature_count: signature.stable_signature_count,
      found_next: Boolean(next)
    });

    if (next) {
      state.stable_signature_count = 0;
      const result = {
        ok: true,
        end_reached: false,
        item: next,
        attempts,
        state: compactInfiniteListState(state)
      };
      state.last_result = {
        at: nowIso(),
        ok: true,
        key: next.key,
        visible_index: next.visible_index
      };
      return result;
    }

    if (typeof detectBottomMarker === "function") {
      let bottomMarker = null;
      try {
        bottomMarker = await detectBottomMarker({
          scrollAttempt,
          items,
          signature,
          state: compactInfiniteListState(state)
        });
      } catch (error) {
        bottomMarker = {
          found: false,
          reason: "bottom_marker_probe_failed",
          error: error?.message || String(error)
        };
      }
      attempts[attempts.length - 1].bottom_marker = bottomMarker;
      if (bottomMarker?.found) {
        state.ledger?.push({
          at: nowIso(),
          event: "bottom_marker_detected",
          reason: bottomMarker.reason || "bottom_marker",
          source: bottomMarker.source || "",
          marker: bottomMarker.marker || null
        });
        const result = {
          ok: false,
          end_reached: true,
          reason: "bottom_marker",
          bottom_marker: bottomMarker,
          attempts,
          state: compactInfiniteListState(state)
        };
        state.last_result = {
          at: nowIso(),
          ok: false,
          end_reached: true,
          reason: result.reason,
          bottom_marker: {
            reason: bottomMarker.reason || null,
            source: bottomMarker.source || null,
            marker: bottomMarker.marker || null
          }
        };
        return result;
      }
    }

    if (!items.length) {
      const result = {
        ok: false,
        end_reached: true,
        reason: "empty_visible_list",
        attempts,
        state: compactInfiniteListState(state)
      };
      state.last_result = {
        at: nowIso(),
        ok: false,
        end_reached: true,
        reason: result.reason
      };
      return result;
    }

    const stableLimit = Math.max(1, Number(stableSignatureLimit) || 1);
    const minStableScrolls = Math.max(0, Number(minScrollsBeforeEnd) || 0);
    if (signature.stable_signature_count >= stableLimit && scrollAttempt >= minStableScrolls) {
      const result = {
        ok: false,
        end_reached: true,
        reason: "stable_visible_signature",
        attempts,
        state: compactInfiniteListState(state)
      };
      state.last_result = {
        at: nowIso(),
        ok: false,
        end_reached: true,
        reason: result.reason
      };
      return result;
    }
    if (signature.stable_signature_count >= stableLimit) {
      attempts[attempts.length - 1].stable_end_deferred = true;
      attempts[attempts.length - 1].min_scrolls_before_end = minStableScrolls;
    }

    const scrollResult = await scrollInfiniteListByVisibleItems(client, items, {
      wheelDeltaY,
      settleMs,
      fallbackPoint,
      listScrollJitterEnabled,
      listScrollJitterMinRatio,
      listScrollJitterMaxRatio,
      listSettleJitterMinRatio,
      listSettleJitterMaxRatio,
      random
    });
    state.scroll_count += scrollResult.ok ? 1 : 0;
    attempts[attempts.length - 1].scroll_result = scrollResult;
    if (!scrollResult.ok) {
      const result = {
        ok: false,
        end_reached: true,
        reason: scrollResult.reason || "scroll_failed",
        attempts,
        state: compactInfiniteListState(state)
      };
      state.last_result = {
        at: nowIso(),
        ok: false,
        end_reached: true,
        reason: result.reason
      };
      return result;
    }
  }

  const result = {
    ok: false,
    end_reached: false,
    reason: "max_scrolls_exhausted",
    attempts,
    state: compactInfiniteListState(state)
  };
  state.last_result = {
    at: nowIso(),
    ok: false,
    end_reached: false,
    reason: result.reason
  };
  return result;
}
