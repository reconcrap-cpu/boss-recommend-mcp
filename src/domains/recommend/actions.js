import {
  clickPoint,
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
  const continueChat = labelText.length <= 40 && /继续沟通/.test(labelText);
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
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
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
    selector,
    node_id: nodeId,
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
        found: true,
        active: favorite.active,
        disabled: favorite.disabled,
        label: favorite.label,
        selector: favorite.selector,
        root: favorite.root,
        node_id: favorite.node_id,
        center: favorite.center
      }
      : { found: false },
    greet: greet
      ? {
        found: true,
        available: greet.available,
        continue_chat: greet.continue_chat,
        disabled: greet.disabled,
        label: greet.label,
        greet_quota: greet.greet_quota || null,
        selector: greet.selector,
        root: greet.root,
        node_id: greet.node_id,
        center: greet.center
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
  requireAny = true
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
        if (!requireAny || hasControl) {
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

export async function clickRecommendActionControl(client, control, {
  allowDisabled = false
} = {}) {
  let clickCenter = control?.center || null;
  let clickRect = control?.rect || null;
  if (control?.node_id) {
    try {
      await scrollNodeIntoView(client, control.node_id);
      await sleep(150);
      const box = await getNodeBox(client, control.node_id);
      clickCenter = box.center;
      clickRect = box.rect;
    } catch {
      // Fall back to the discovered center below; callers still get a clear
      // error if no usable click point exists.
    }
  }
  if (!clickCenter) {
    throw new Error("Action control has no clickable center");
  }
  const greetQuota = control.kind === "greet"
    ? assertGreetQuotaAvailable(control.greet_quota || control.label || "")
    : null;
  if (control.disabled && !allowDisabled) {
    throw new Error(`Action control is disabled: ${control.kind}`);
  }
  await clickPoint(client, clickCenter.x, clickCenter.y);
  return {
    clicked: true,
    kind: control.kind,
    label: control.label,
    greet_quota: greetQuota?.found ? greetQuota : null,
    selector: control.selector,
    root: control.root,
    node_id: control.node_id,
    center: clickCenter,
    rect: clickRect
  };
}
