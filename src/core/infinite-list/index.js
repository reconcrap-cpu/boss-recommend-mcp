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
  ".load-tips",
  "div[role=\"tfoot\"] .load-tips",
  ".no-data-refresh",
  ".empty-tip",
  ".empty-text",
  ".no-data",
  ".tip-nodata",
  "[class*=\"finished\"]",
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
  fallbackPoint = null
} = {}) {
  const candidates = items.filter((item) => item?.node_id);
  if (!candidates.length) {
    return {
      ok: false,
      reason: "no_visible_items"
    };
  }

  const errors = [];
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
        deltaY: Math.max(1, Number(wheelDeltaY) || 850)
      });
      if (settleMs > 0) await sleep(settleMs);
      return {
        ok: true,
        anchor_key: anchor.key,
        anchor_node_id: anchor.node_id,
        point: { x, y },
        wheel_delta_y: Math.max(1, Number(wheelDeltaY) || 850),
        settle_ms: settleMs,
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

  if (fallbackPoint && Number.isFinite(Number(fallbackPoint.x)) && Number.isFinite(Number(fallbackPoint.y))) {
    const x = Number(fallbackPoint.x);
    const y = Number(fallbackPoint.y);
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
    await client.Input.dispatchMouseEvent({
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: Math.max(1, Number(wheelDeltaY) || 850)
    });
    if (settleMs > 0) await sleep(settleMs);
    return {
      ok: true,
      mode: "fallback_point",
      point: { x, y },
      wheel_delta_y: Math.max(1, Number(wheelDeltaY) || 850),
      settle_ms: settleMs,
      skipped_stale_anchor_count: errors.length,
      stale_anchor_errors: errors
    };
  }

  return {
    ok: false,
    reason: "scroll_anchor_unavailable",
    errors
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
  fallbackPoint = null
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
      fallbackPoint
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
