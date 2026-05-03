import crypto from "node:crypto";
import {
  getNodeBox,
  scrollNodeIntoView,
  sleep
} from "../browser/index.js";

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
  keyForCandidate = candidateKeyFromProfile,
  maxScrolls = 20,
  stableSignatureLimit = 2,
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

    if (signature.stable_signature_count >= Math.max(1, Number(stableSignatureLimit) || 1)) {
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
