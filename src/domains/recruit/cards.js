import {
  getAttributesMap,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import { mergeBossCandidateCardFields } from "../../core/boss-cards/index.js";
import { normalizeCandidateFromHtml } from "../../core/screening/index.js";
import { RECRUIT_CARD_SELECTOR } from "./constants.js";

function mergeRecruitCardFields(candidate, outerHTML = "") {
  return mergeBossCandidateCardFields(candidate, outerHTML, {
    metadataKey: "search_card_fields"
  });
}

export async function findRecruitCardNodeIds(client, frameNodeId, {
  selector = RECRUIT_CARD_SELECTOR
} = {}) {
  return querySelectorAll(client, frameNodeId, selector);
}

export async function waitForRecruitCardNodeIds(client, frameNodeId, {
  selector = RECRUIT_CARD_SELECTOR,
  timeoutMs = 12000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let nodeIds = [];
  while (Date.now() - started <= timeoutMs) {
    nodeIds = await findRecruitCardNodeIds(client, frameNodeId, { selector });
    if (nodeIds.length) return nodeIds;
    await sleep(intervalMs);
  }
  return nodeIds;
}

export async function readRecruitCardCandidate(client, cardNodeId, {
  targetUrl = "",
  source = "recruit-domain-card",
  metadata = {}
} = {}) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, cardNodeId),
    getOuterHTML(client, cardNodeId)
  ]);
  const candidate = normalizeCandidateFromHtml({
    domain: "recruit",
    source,
    html: outerHTML,
    attributes,
    metadata: {
      target_url: targetUrl,
      card_node_id: cardNodeId,
      ...metadata
    }
  });
  return mergeRecruitCardFields(candidate, outerHTML);
}

export async function readFirstRecruitCardCandidate(client, frameNodeId, options = {}) {
  const cardNodeIds = await findRecruitCardNodeIds(client, frameNodeId, options);
  if (!cardNodeIds.length) {
    throw new Error("No recruit/search candidate cards found");
  }

  const candidate = await readRecruitCardCandidate(client, cardNodeIds[0], options);
  return {
    card_count: cardNodeIds.length,
    first_card_node_id: cardNodeIds[0],
    card_node_ids: cardNodeIds,
    candidate
  };
}
