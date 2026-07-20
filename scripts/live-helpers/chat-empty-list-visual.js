import {
  getOuterHTML,
  querySelectorAll
} from "../../src/core/browser/index.js";
import { captureViewportScreenshot } from "../../src/core/capture/index.js";
import {
  htmlToText,
  normalizeText
} from "../../src/core/screening/index.js";
import { CHAT_CARD_SELECTORS } from "../../src/domains/chat/constants.js";

const EMPTY_LIST_HINT_PATTERNS = Object.freeze([
  /暂无(?:未读)?(?:消息|沟通|聊天|会话|候选|人选|牛人|数据)?/u,
  /暂时(?:没有|无)(?:未读)?(?:消息|沟通|聊天|会话|候选|人选|牛人|数据)?/u,
  /没有(?:未读)?(?:消息|沟通|聊天|会话|候选|人选|牛人|数据|更多)/u,
  /无(?:未读)?(?:消息|沟通|聊天|会话|候选|人选|牛人|数据)/u,
  /当前(?:暂无|没有|无)/u,
  /空空如也/u,
  /no (?:unread |more )?(?:messages|candidates|conversations|data)/i,
  /empty/i
]);

function axValueText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(axValueText).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    if (value.value != null) return axValueText(value.value);
    if (value.name != null) return axValueText(value.name);
  }
  return "";
}

function accessibilityText(tree) {
  const tokens = [];
  for (const node of tree?.nodes || []) {
    tokens.push(axValueText(node.name));
    tokens.push(axValueText(node.value));
    tokens.push(axValueText(node.description));
    for (const property of node.properties || []) {
      tokens.push(axValueText(property?.value));
    }
  }
  return normalizeText(tokens.filter(Boolean).join(" "));
}

function findEmptyHints(text) {
  const normalized = normalizeText(text);
  const hints = [];
  for (const pattern of EMPTY_LIST_HINT_PATTERNS) {
    const match = normalized.match(pattern);
    if (match?.[0]) hints.push(match[0]);
  }
  return Array.from(new Set(hints));
}

async function countCandidateSelectors(client, rootNodeId, selectors = CHAT_CARD_SELECTORS) {
  const counts = {};
  let total = 0;
  for (const selector of selectors) {
    try {
      const nodeIds = await querySelectorAll(client, rootNodeId, selector);
      counts[selector] = nodeIds.length;
      total += nodeIds.length;
    } catch (error) {
      counts[selector] = {
        error: error?.message || String(error)
      };
    }
  }
  return {
    total,
    selectors: counts
  };
}

async function readDomText(client, rootNodeId) {
  try {
    const outerHTML = await getOuterHTML(client, rootNodeId);
    return {
      ok: true,
      text: normalizeText(htmlToText(outerHTML)),
      outer_html_length: outerHTML.length
    };
  } catch (error) {
    return {
      ok: false,
      text: "",
      error: error?.message || String(error)
    };
  }
}

async function readAxText(client) {
  try {
    const tree = await client.Accessibility.getFullAXTree({});
    return {
      ok: true,
      text: accessibilityText(tree),
      node_count: tree?.nodes?.length || 0
    };
  } catch (error) {
    return {
      ok: false,
      text: "",
      error: error?.message || String(error)
    };
  }
}

export async function inspectEmptyChatListVisually(client, rootNodeId, {
  startFrom = "unread",
  runId = "",
  selectors = CHAT_CARD_SELECTORS
} = {}) {
  if (!client) throw new Error("inspectEmptyChatListVisually requires a CDP client");
  if (!rootNodeId) throw new Error("inspectEmptyChatListVisually requires rootNodeId");

  const beforeCounts = await countCandidateSelectors(client, rootNodeId, selectors);
  const screenshot = await captureViewportScreenshot(client, {
    captureBeyondViewport: false,
    metadata: {
      domain: "chat",
      capture_reason: "empty_chat_list_visual_inspection",
      requested_start_from: startFrom,
      run_id: runId || null
    }
  });
  const [afterCounts, domText, axText] = await Promise.all([
    countCandidateSelectors(client, rootNodeId, selectors),
    readDomText(client, rootNodeId),
    readAxText(client)
  ]);
  const combinedText = normalizeText(`${domText.text || ""} ${axText.text || ""}`);
  const emptyHintMatches = findEmptyHints(combinedText);
  const verifiedEmpty = (
    screenshot.byte_length > 0
    && afterCounts.total === 0
    && emptyHintMatches.length > 0
  );

  return {
    schema_version: 1,
    domain: "chat",
    inspected_at: new Date().toISOString(),
    requested_start_from: startFrom,
    run_id: runId || null,
    screenshot,
    selector_counts_before: beforeCounts,
    selector_counts_after: afterCounts,
    empty_hint_found: emptyHintMatches.length > 0,
    empty_hint_matches: emptyHintMatches,
    verified_empty: verifiedEmpty,
    review_required: !verifiedEmpty,
    dom_text: {
      ok: domText.ok,
      outer_html_length: domText.outer_html_length || 0,
      sample: domText.text.slice(0, 600),
      error: domText.error || null
    },
    accessibility_text: {
      ok: axText.ok,
      node_count: axText.node_count || 0,
      sample: axText.text.slice(0, 600),
      error: axText.error || null
    }
  };
}
