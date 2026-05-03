import {
  clickNodeCenter,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../../core/screening/index.js";
import {
  RECOMMEND_CARD_SELECTOR,
  RECOMMEND_PAGE_SCOPE_DEFAULT,
  RECOMMEND_PAGE_SCOPE_LABELS,
  RECOMMEND_PAGE_SCOPE_STATUS,
  RECOMMEND_PAGE_SCOPE_TAB_SELECTOR
} from "./constants.js";

const SCOPE_ALIASES = Object.freeze({
  recommend: "recommend",
  "推荐": "recommend",
  "推荐页": "recommend",
  "推荐页面": "recommend",
  latest: "latest",
  "最新": "latest",
  "最新页": "latest",
  "最新页面": "latest",
  featured: "featured",
  "精选": "featured",
  "精选页": "featured",
  "精选页面": "featured",
  "精选牛人": "featured"
});

const STATUS_TO_SCOPE = Object.freeze(
  Object.fromEntries(
    Object.entries(RECOMMEND_PAGE_SCOPE_STATUS).map(([scope, status]) => [status, scope])
  )
);

function compactTab(tab) {
  return {
    scope: tab.scope,
    label: tab.label,
    title: tab.title,
    status: tab.status,
    current: Boolean(tab.current),
    visible: Boolean(tab.visible),
    class_name: tab.class_name,
    node_id: tab.node_id,
    center: tab.center,
    rect: tab.rect
  };
}

function inferScopeFromText(text = "") {
  const normalized = normalizeText(text).replace(/\s+/g, "");
  if (!normalized) return null;
  if (/^推荐/.test(normalized)) return "recommend";
  if (/^精选/.test(normalized)) return "featured";
  if (/^最新/.test(normalized)) return "latest";
  return null;
}

function isVisibleBox(box) {
  return Boolean(box && box.rect.width > 4 && box.rect.height > 4);
}

export function normalizeRecommendPageScope(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  return SCOPE_ALIASES[lower] || SCOPE_ALIASES[raw] || null;
}

export function getRecommendPageScopeStatus(scope) {
  const normalized = normalizeRecommendPageScope(scope) || RECOMMEND_PAGE_SCOPE_DEFAULT;
  return RECOMMEND_PAGE_SCOPE_STATUS[normalized] || RECOMMEND_PAGE_SCOPE_STATUS.recommend;
}

export function getRecommendPageScopeLabel(scope) {
  const normalized = normalizeRecommendPageScope(scope) || RECOMMEND_PAGE_SCOPE_DEFAULT;
  return RECOMMEND_PAGE_SCOPE_LABELS[normalized] || RECOMMEND_PAGE_SCOPE_LABELS.recommend;
}

async function readPageScopeTab(client, nodeId, index) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
  ]);
  const label = normalizeText(htmlToText(outerHTML));
  const status = attributes["data-status"] || "";
  const title = attributes.title || "";
  const scope = STATUS_TO_SCOPE[status] || inferScopeFromText(`${title} ${label}`);
  let box = null;
  try {
    box = await getNodeBox(client, nodeId);
  } catch {}
  const className = attributes.class || "";
  return {
    node_id: nodeId,
    index,
    scope,
    status,
    label,
    title,
    class_name: className,
    current: /\bcurr\b|\bactive\b|\bselected\b/.test(className),
    visible: isVisibleBox(box),
    center: box?.center || null,
    rect: box?.rect || null
  };
}

export async function listRecommendPageScopeTabs(client, frameNodeId, {
  selector = RECOMMEND_PAGE_SCOPE_TAB_SELECTOR
} = {}) {
  const nodeIds = await querySelectorAll(client, frameNodeId, selector);
  const tabs = [];
  const seen = new Set();
  for (let index = 0; index < nodeIds.length; index += 1) {
    const nodeId = nodeIds[index];
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const tab = await readPageScopeTab(client, nodeId, index);
    if (!tab.scope) continue;
    tabs.push(tab);
  }
  return tabs;
}

export async function getActiveRecommendPageScope(client, frameNodeId) {
  const tabs = await listRecommendPageScopeTabs(client, frameNodeId);
  const current = tabs.find((tab) => tab.current);
  return {
    scope: current?.scope || null,
    tab: current ? compactTab(current) : null,
    tabs: tabs.map(compactTab)
  };
}

async function waitForRecommendPageScope(client, frameNodeId, scope, {
  timeoutMs = 10000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    const active = await getActiveRecommendPageScope(client, frameNodeId);
    const cardCount = (await querySelectorAll(client, frameNodeId, RECOMMEND_CARD_SELECTOR)).length;
    lastState = {
      ...active,
      card_count: cardCount
    };
    if (active.scope === scope && cardCount > 0) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        ...lastState
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    ...lastState
  };
}

export async function selectRecommendPageScope(client, frameNodeId, {
  pageScope = RECOMMEND_PAGE_SCOPE_DEFAULT,
  fallbackScope = RECOMMEND_PAGE_SCOPE_DEFAULT,
  settleMs = 1200,
  timeoutMs = 15000
} = {}) {
  const requested = normalizeRecommendPageScope(pageScope) || RECOMMEND_PAGE_SCOPE_DEFAULT;
  const fallback = normalizeRecommendPageScope(fallbackScope) || RECOMMEND_PAGE_SCOPE_DEFAULT;
  const tabs = await listRecommendPageScopeTabs(client, frameNodeId);
  const availableScopes = Array.from(new Set(tabs.map((tab) => tab.scope)));
  const requestedTab = tabs.find((tab) => tab.scope === requested && tab.visible)
    || tabs.find((tab) => tab.scope === requested);
  const fallbackTab = tabs.find((tab) => tab.scope === fallback && tab.visible)
    || tabs.find((tab) => tab.scope === fallback);
  const targetTab = requestedTab || fallbackTab;
  const effectiveScope = requestedTab ? requested : fallback;

  if (!targetTab) {
    return {
      requested_scope: requested,
      effective_scope: null,
      fallback_scope: fallback,
      fallback_applied: !requestedTab,
      selected: false,
      reason: "scope_tab_not_found",
      available_scopes: availableScopes,
      tabs: tabs.map(compactTab)
    };
  }

  if (targetTab.current) {
    const active = await getActiveRecommendPageScope(client, frameNodeId);
    const cardCount = (await querySelectorAll(client, frameNodeId, RECOMMEND_CARD_SELECTOR)).length;
    return {
      requested_scope: requested,
      effective_scope: effectiveScope,
      fallback_scope: fallback,
      fallback_applied: requested !== effectiveScope,
      selected: true,
      already_current: true,
      selected_tab: compactTab(targetTab),
      available_scopes: availableScopes,
      tabs: tabs.map(compactTab),
      after: {
        ...active,
        card_count: cardCount
      }
    };
  }

  const clickBox = await clickNodeCenter(client, targetTab.node_id);
  if (settleMs > 0) await sleep(settleMs);
  const after = await waitForRecommendPageScope(client, frameNodeId, effectiveScope, {
    timeoutMs,
    intervalMs: Math.max(250, Math.min(500, Math.floor(timeoutMs / 30)))
  });
  return {
    requested_scope: requested,
    effective_scope: effectiveScope,
    fallback_scope: fallback,
    fallback_applied: requested !== effectiveScope,
    selected: after.ok,
    already_current: false,
    selected_tab: compactTab(targetTab),
    available_scopes: availableScopes,
    tabs: tabs.map(compactTab),
    click_box: {
      center: clickBox.center,
      rect: clickBox.rect
    },
    after
  };
}
