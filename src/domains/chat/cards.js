import { candidateKeyFromProfile } from "../../core/infinite-list/index.js";
import {
  getAttributesMap,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import {
  htmlToText,
  normalizeCandidateProfile,
  normalizeText
} from "../../core/screening/index.js";
import { CHAT_CARD_SELECTORS } from "./constants.js";

function firstCandidateId(attributes = {}) {
  return normalizeText(
    attributes["data-id"]
    || attributes["data-geekid"]
    || attributes["data-geek"]
    || attributes["data-uid"]
    || attributes.key
    || attributes.id
    || ""
  ) || null;
}

export async function findChatCandidateNodeIds(client, rootNodeId, {
  selectors = CHAT_CARD_SELECTORS
} = {}) {
  for (const selector of selectors) {
    let nodeIds = [];
    try {
      nodeIds = await querySelectorAll(client, rootNodeId, selector);
    } catch {
      nodeIds = [];
    }
    if (nodeIds.length) {
      return {
        selector,
        nodeIds
      };
    }
  }
  return {
    selector: "",
    nodeIds: []
  };
}

export function chatCandidateKeyFromProfile(candidate = {}, options = {}) {
  const id = normalizeText(candidate.id);
  if (id) return `${candidate.domain || "chat"}:id:${id}`;
  return candidateKeyFromProfile(candidate, options);
}

export async function findChatCandidateNodeIdById(client, rootNodeId, candidateId, {
  selectors = CHAT_CARD_SELECTORS
} = {}) {
  const expectedId = normalizeText(candidateId);
  if (!expectedId) return 0;
  const result = await findChatCandidateNodeIds(client, rootNodeId, { selectors });
  for (const nodeId of result.nodeIds || []) {
    try {
      const attributes = await getAttributesMap(client, nodeId);
      if (firstCandidateId(attributes) === expectedId) return nodeId;
    } catch {
      // Boss can remount chat cards while the list is active; keep scanning.
    }
  }
  return 0;
}

export async function waitForChatCandidateNodeIds(client, rootNodeId, {
  selectors = CHAT_CARD_SELECTORS,
  timeoutMs = 12000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let result = {
    selector: "",
    nodeIds: []
  };
  while (Date.now() - started <= timeoutMs) {
    result = await findChatCandidateNodeIds(client, rootNodeId, { selectors });
    if (result.nodeIds.length) return result;
    await sleep(intervalMs);
  }
  return result;
}

export async function readChatCardCandidate(client, cardNodeId, {
  targetUrl = "",
  source = "chat-domain-card",
  metadata = {}
} = {}) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, cardNodeId),
    getOuterHTML(client, cardNodeId)
  ]);
  return normalizeCandidateProfile({
    domain: "chat",
    source,
    id: firstCandidateId(attributes),
    text: htmlToText(outerHTML),
    attributes,
    metadata: {
      target_url: targetUrl,
      card_node_id: cardNodeId,
      html_length: outerHTML.length,
      ...metadata
    }
  });
}

export async function readFirstChatCardCandidate(client, rootNodeId, options = {}) {
  const cardResult = await findChatCandidateNodeIds(client, rootNodeId, options);
  if (!cardResult.nodeIds.length) {
    throw new Error("No chat candidate conversation cards found");
  }

  const candidate = await readChatCardCandidate(client, cardResult.nodeIds[0], options);
  return {
    card_count: cardResult.nodeIds.length,
    selector: cardResult.selector,
    first_card_node_id: cardResult.nodeIds[0],
    card_node_ids: cardResult.nodeIds,
    candidate
  };
}
