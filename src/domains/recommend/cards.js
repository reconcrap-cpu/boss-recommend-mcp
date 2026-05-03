import {
  clickNodeCenter,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import {
  mergeBossCandidateCardFields,
  parseBossCandidateCardFieldsFromHtml
} from "../../core/boss-cards/index.js";
import {
  htmlToText,
  normalizeCandidateFromHtml,
  normalizeText
} from "../../core/screening/index.js";
import {
  RECOMMEND_CARD_SELECTOR,
  RECOMMEND_END_REFRESH_SELECTOR
} from "./constants.js";

function uniqueNodeIds(nodeIds = []) {
  return Array.from(new Set(nodeIds.filter(Boolean)));
}

function normalizeRefreshButtonLabel(outerHTML = "") {
  return normalizeText(htmlToText(outerHTML)).replace(/\s+/g, "");
}

export function parseRecommendCardFieldsFromHtml(html = "") {
  return parseBossCandidateCardFieldsFromHtml(html);
}

function enrichRecommendCardCandidate(candidate, outerHTML = "") {
  return mergeBossCandidateCardFields(candidate, outerHTML, {
    metadataKey: "recommend_card_fields"
  });
}

function isRefreshButtonLabel(label = "") {
  const normalized = String(label || "").trim();
  if (!normalized || normalized.length > 80) return false;
  return /刷新|refresh/i.test(normalized);
}

function refreshButtonRank(candidate) {
  const label = String(candidate.label || "").toLowerCase();
  if (label === "刷新" || label === "refresh") return 0;
  if (/^刷新$|^refresh$/i.test(label)) return 0;
  if (/刷新/.test(label) || /refresh/i.test(label)) return 1;
  return 2;
}

async function searchTextNodeIds(client, query, {
  maxResults = 200
} = {}) {
  if (typeof client?.DOM?.performSearch !== "function") return [];
  const search = await client.DOM.performSearch({
    query,
    includeUserAgentShadowDOM: false
  });
  const searchId = search.searchId;
  const resultCount = Math.min(search.resultCount || 0, maxResults);
  if (!searchId || resultCount <= 0) return [];
  try {
    const results = await client.DOM.getSearchResults({
      searchId,
      fromIndex: 0,
      toIndex: resultCount
    });
    return results.nodeIds || [];
  } finally {
    await client.DOM.discardSearchResults({ searchId });
  }
}

export async function findRecommendCardNodeIds(client, frameNodeId, {
  selector = RECOMMEND_CARD_SELECTOR
} = {}) {
  return querySelectorAll(client, frameNodeId, selector);
}

export async function waitForRecommendCardNodeIds(client, frameNodeId, {
  selector = RECOMMEND_CARD_SELECTOR,
  timeoutMs = 10000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let nodeIds = [];
  while (Date.now() - started <= timeoutMs) {
    nodeIds = await findRecommendCardNodeIds(client, frameNodeId, { selector });
    if (nodeIds.length) return nodeIds;
    await sleep(intervalMs);
  }
  return nodeIds;
}

export async function readRecommendCardCandidate(client, cardNodeId, {
  targetUrl = "",
  source = "recommend-domain-card",
  metadata = {}
} = {}) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, cardNodeId),
    getOuterHTML(client, cardNodeId)
  ]);
  const candidate = normalizeCandidateFromHtml({
    domain: "recommend",
    source,
    html: outerHTML,
    attributes,
    metadata: {
      target_url: targetUrl,
      card_node_id: cardNodeId,
      ...metadata
    }
  });
  return enrichRecommendCardCandidate(candidate, outerHTML);
}

export async function readFirstRecommendCardCandidate(client, frameNodeId, options = {}) {
  const cardNodeIds = await findRecommendCardNodeIds(client, frameNodeId, options);
  if (!cardNodeIds.length) {
    throw new Error("No recommend candidate cards found");
  }

  const candidate = await readRecommendCardCandidate(client, cardNodeIds[0], options);
  return {
    card_count: cardNodeIds.length,
    first_card_node_id: cardNodeIds[0],
    card_node_ids: cardNodeIds,
    candidate
  };
}

export async function findRecommendEndRefreshButtons(client, frameNodeId, {
  selector = RECOMMEND_END_REFRESH_SELECTOR,
  maxCandidates = 1200
} = {}) {
  const textNodeIds = [
    ...await searchTextNodeIds(client, "刷新", { maxResults: 200 }),
    ...await searchTextNodeIds(client, "refresh", { maxResults: 50 })
  ];
  const selectorNodeIds = textNodeIds.length
    ? await querySelectorAll(client, frameNodeId, selector)
    : [];
  const nodeIds = uniqueNodeIds([...textNodeIds, ...selectorNodeIds]).slice(0, maxCandidates);
  const candidates = [];
  for (let index = 0; index < nodeIds.length; index += 1) {
    const nodeId = nodeIds[index];
    let outerHTML = "";
    try {
      outerHTML = await getOuterHTML(client, nodeId);
    } catch {
      continue;
    }
    const label = normalizeRefreshButtonLabel(outerHTML);
    if (!isRefreshButtonLabel(label)) continue;

    let box = null;
    try {
      box = await getNodeBox(client, nodeId);
    } catch {
      // Some text matches can be hidden or stale. Keep the label out of the click set.
      continue;
    }
    candidates.push({
      node_id: nodeId,
      index,
      label,
      box,
      rank: refreshButtonRank({ label })
    });
  }

  return candidates.sort((left, right) => {
    const rankDiff = left.rank - right.rank;
    if (rankDiff !== 0) return rankDiff;
    return (right.box?.rect?.y || 0) - (left.box?.rect?.y || 0);
  });
}

export async function clickRecommendEndRefreshButton(client, frameNodeId, {
  settleMs = 5000
} = {}) {
  const beforeCardCount = (await findRecommendCardNodeIds(client, frameNodeId)).length;
  const candidates = await findRecommendEndRefreshButtons(client, frameNodeId);
  if (!candidates.length) {
    return {
      ok: false,
      method: "end_refresh_button",
      reason: "refresh_button_not_found",
      before_card_count: beforeCardCount,
      candidates: []
    };
  }

  const attempts = [];
  for (const candidate of candidates) {
    try {
      const box = await clickNodeCenter(client, candidate.node_id, { scrollIntoView: true });
      if (settleMs > 0) await sleep(settleMs);
      const afterCardCount = (await findRecommendCardNodeIds(client, frameNodeId)).length;
      return {
        ok: true,
        method: "end_refresh_button",
        clicked: true,
        node_id: candidate.node_id,
        label: candidate.label,
        box,
        before_card_count: beforeCardCount,
        after_card_count: afterCardCount,
        settle_ms: settleMs,
        candidates: candidates.map((item) => ({
          node_id: item.node_id,
          label: item.label,
          y: item.box?.rect?.y || null
        })).slice(0, 10),
        attempts
      };
    } catch (error) {
      attempts.push({
        node_id: candidate.node_id,
        label: candidate.label,
        error: error?.message || String(error)
      });
    }
  }

  return {
    ok: false,
    method: "end_refresh_button",
    reason: "refresh_button_click_failed",
    before_card_count: beforeCardCount,
    attempts,
    candidates: candidates.map((item) => ({
      node_id: item.node_id,
      label: item.label,
      y: item.box?.rect?.y || null
    })).slice(0, 10)
  };
}
