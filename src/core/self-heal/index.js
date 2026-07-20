import {
  findIframeDocument,
  getAccessibilityTree,
  getDocumentRoot,
  querySelectorAll,
  sleep
} from "../browser/index.js";
import {
  compactViewportHealthResult,
  ensureHealthyViewport
} from "./viewport.js";

export {
  buildViewportHealthDiagnostics,
  compactViewportHealthResult,
  compactViewportState,
  createViewportRunGuard,
  ensureHealthyViewport,
  getCurrentWindowInfo,
  isListViewportCollapsed,
  readViewportState,
  setWindowStateIfPossible,
  toggleWindowStateForViewportRecovery,
  VIEWPORT_COLLAPSE_MIN_EXPECTED_WIDTH,
  VIEWPORT_COLLAPSE_NEAR_FULLSCREEN_RATIO,
  VIEWPORT_COLLAPSE_RATIO_THRESHOLD
} from "./viewport.js";

export const PROBE_STATUS = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  BLOCKED: "blocked",
  OPTIONAL_ABSENT: "optional_absent",
  ERROR: "error"
});

export const HEALTH_STATUS = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  BLOCKED: "blocked"
});

export const DOMAIN_TARGET_HINTS = Object.freeze({
  recommend: ["/web/chat/recommend"],
  recruit: ["/web/chat/search"],
  chat: ["/web/chat/index", "/web/chat"]
});

const FALLBACK_RECOMMEND_SELECTORS = Object.freeze({
  top: {
    recommend_iframe: [
      'iframe[name="recommendFrame"]',
      'iframe[src*="/web/frame/recommend/"]',
      "iframe"
    ]
  },
  frame: {
    filter_trigger: [
      ".filter-label-wrap",
      ".recommend-filter.op-filter"
    ],
    filter_panel: [
      ".recommend-filter.op-filter .filter-panel",
      ".recommend-filter .filter-panel",
      ".filter-panel"
    ],
    tab_items: [
      "li.tab-item[data-status]",
      'li[data-status][class*="tab"]'
    ],
    candidate_cards: [
      ".candidate-card-wrap .card-inner[data-geek]",
      ".candidate-card-wrap [data-geek]",
      "ul.card-list > li.card-item",
      ".card-inner[data-geekid]",
      "li.geek-info-card",
      "a[data-geekid]",
      ".candidate-card-wrap"
    ]
  },
  detail: {
    popup: [
      ".dialog-wrap.active",
      ".boss-popup__wrapper",
      ".boss-popup_wrapper",
      ".boss-dialog_wrapper",
      ".boss-dialog",
      ".resume-item-detail",
      ".geek-detail-modal",
      '[class*="popup"][class*="wrapper"]',
      '[class*="dialog"][class*="wrapper"]'
    ]
  }
});

const FALLBACK_RECRUIT_SELECTORS = Object.freeze({
  top: {
    search_iframe: [
      'iframe[name="searchFrame"]',
      'iframe[src*="/web/frame/search/"]',
      "iframe"
    ]
  },
  frame: {
    candidate_cards: [
      "li.geek-info-card a[data-jid]",
      "li.geek-info-card a[data-geekid]",
      ".geek-info-card a[data-jid]",
      ".geek-info-card a[data-geekid]",
      ".geek-info-card a",
      "a[data-jid]",
      "a[data-geekid]"
    ],
    no_data: [
      "i.tip-nodata",
      ".tip-nodata",
      ".empty-tip",
      ".empty-text"
    ]
  },
  detail: {
    popup: [
      ".dialog-wrap.active",
      ".boss-popup__wrapper",
      ".boss-popup_wrapper",
      ".boss-dialog_wrapper",
      ".boss-dialog",
      ".resume-item-detail",
      ".geek-detail-modal",
      ".resume-container",
      '[class*="popup"][class*="wrapper"]',
      '[class*="dialog"][class*="wrapper"]'
    ]
  }
});

const FALLBACK_CHAT_SELECTORS = Object.freeze({
  top: {
    candidate_cards: [
      ".geek-item[data-id]",
      'div[role="listitem"] .geek-item[data-id]',
      ".geek-item",
      ".geek-item-wrap",
      'div[role="listitem"]'
    ],
    selected_candidate: [
      ".geek-item.selected[data-id]",
      ".geek-item.selected",
      ".geek-item.active[data-id]",
      ".geek-item.active"
    ],
    online_resume_button: [
      "a.btn.resume-btn-online",
      "a.resume-btn-online",
      ".btn.resume-btn-online",
      ".resume-btn-online"
    ]
  },
  detail: {
    resume_modal: [
      ".boss-popup__wrapper",
      ".new-chat-resume-dialog-main-ui",
      ".dialog-wrap.active",
      ".boss-dialog",
      ".geek-detail-modal",
      ".modal",
      ".resume-container",
      ".resume-content-wrap",
      ".resume-common-wrap",
      ".resume-detail",
      ".resume-recommend"
    ],
    resume_iframe: [
      'iframe[src*="/web/frame/c-resume/"]',
      'iframe[src*="resume"]',
      'iframe[name*="resume"]'
    ]
  }
});

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

function selectorGroup(rules, scope, name, fallback = []) {
  return uniqueStrings(rules?.selectors?.[scope]?.[name] || fallback);
}

function mergeSelectorGroups(rules, scope, names = [], fallback = []) {
  const selectors = names.flatMap((name) => rules?.selectors?.[scope]?.[name] || []);
  return uniqueStrings(selectors.length ? selectors : fallback);
}

function rootNodeId(roots = {}, name) {
  for (const root of [roots?.[name], roots?.rootNodes?.[name], roots?.roots?.[name]]) {
    if (typeof root === "number" && root > 0) return root;
    if (root?.nodeId) return root.nodeId;
    if (root?.documentNodeId) return root.documentNodeId;
  }
  return 0;
}

function stringMatchesAnyPattern(value, patterns = []) {
  const text = String(value || "");
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(text);
    return text.includes(String(pattern || ""));
  });
}

export function createSelectorProbe({
  id,
  root = "frame",
  selectors = [],
  required = false,
  minCount = 1,
  description = ""
} = {}) {
  if (!id) throw new Error("Selector probe requires an id");
  return {
    type: "selector",
    id,
    root,
    selectors: uniqueStrings(selectors),
    required: Boolean(required),
    minCount,
    description
  };
}

export function createAccessibilityProbe({
  id,
  required = false,
  minCount = 1,
  roleIncludes = [],
  nameIncludes = [],
  description = ""
} = {}) {
  if (!id) throw new Error("Accessibility probe requires an id");
  return {
    type: "accessibility",
    id,
    required: Boolean(required),
    minCount,
    roleIncludes: uniqueStrings(roleIncludes),
    nameIncludes: uniqueStrings(nameIncludes),
    description
  };
}

export function createNetworkProbe({
  id,
  required = false,
  minCount = 1,
  urlPatterns = [],
  description = ""
} = {}) {
  if (!id) throw new Error("Network probe requires an id");
  return {
    type: "network",
    id,
    required: Boolean(required),
    minCount,
    urlPatterns,
    description
  };
}

export function createViewportCollapseProbe({
  id = "viewport_collapse",
  root = "frame",
  frameOwnerRoot = "frameOwner",
  required = true,
  repair = true,
  description = ""
} = {}) {
  if (!id) throw new Error("Viewport collapse probe requires an id");
  return {
    type: "viewport",
    id,
    root,
    frameOwnerRoot,
    required: Boolean(required),
    repair: Boolean(repair),
    description
  };
}

export async function runSelectorProbe(client, roots, probe) {
  const nodeId = rootNodeId(roots, probe.root);
  if (!nodeId) {
    return {
      ...probe,
      ok: !probe.required,
      status: probe.required ? PROBE_STATUS.BLOCKED : PROBE_STATUS.OPTIONAL_ABSENT,
      count: 0,
      selector_counts: [],
      error: `Root not found: ${probe.root}`
    };
  }

  const selectorCounts = [];
  try {
    for (const selector of probe.selectors) {
      const nodeIds = await querySelectorAll(client, nodeId, selector);
      selectorCounts.push({
        selector,
        count: nodeIds.length
      });
    }
  } catch (error) {
    return {
      ...probe,
      ok: !probe.required,
      status: probe.required ? PROBE_STATUS.ERROR : PROBE_STATUS.OPTIONAL_ABSENT,
      count: 0,
      selector_counts: selectorCounts,
      error: error?.message || String(error)
    };
  }

  const count = selectorCounts.reduce((max, item) => Math.max(max, item.count), 0);
  const ok = count >= probe.minCount;
  return {
    ...probe,
    ok: probe.required ? ok : true,
    status: ok ? PROBE_STATUS.PASS : probe.required ? PROBE_STATUS.FAIL : PROBE_STATUS.OPTIONAL_ABSENT,
    count,
    selector_counts: selectorCounts,
    matched_selectors: selectorCounts.filter((item) => item.count > 0)
  };
}

export async function runAccessibilityProbe(client, probe) {
  try {
    const tree = await getAccessibilityTree(client);
    const nodes = tree?.nodes || [];
    const matches = nodes.filter((node) => {
      const role = String(node?.role?.value || "");
      const name = String(node?.name?.value || "");
      const roleOk = probe.roleIncludes.length === 0
        || probe.roleIncludes.some((value) => role.includes(value));
      const nameOk = probe.nameIncludes.length === 0
        || probe.nameIncludes.some((value) => name.includes(value));
      return roleOk && nameOk;
    });
    const ok = matches.length >= probe.minCount;
    return {
      ...probe,
      ok: probe.required ? ok : true,
      status: ok ? PROBE_STATUS.PASS : probe.required ? PROBE_STATUS.FAIL : PROBE_STATUS.OPTIONAL_ABSENT,
      count: matches.length,
      total_ax_nodes: nodes.length
    };
  } catch (error) {
    return {
      ...probe,
      ok: !probe.required,
      status: probe.required ? PROBE_STATUS.ERROR : PROBE_STATUS.OPTIONAL_ABSENT,
      count: 0,
      total_ax_nodes: 0,
      error: error?.message || String(error)
    };
  }
}

export function runNetworkProbe(networkEvents = [], probe) {
  const matches = networkEvents.filter((event) => {
    if (!probe.urlPatterns.length) return true;
    return stringMatchesAnyPattern(event?.url || event?.response?.url, probe.urlPatterns);
  });
  const ok = matches.length >= probe.minCount;
  return {
    ...probe,
    ok: probe.required ? ok : true,
    status: ok ? PROBE_STATUS.PASS : probe.required ? PROBE_STATUS.FAIL : PROBE_STATUS.OPTIONAL_ABSENT,
    count: matches.length,
    sample_urls: matches.slice(0, 5).map((event) => event?.url || event?.response?.url || "")
  };
}

export async function runViewportCollapseProbe(client, roots, probe, {
  reacquireRoots = null
} = {}) {
  const nodeId = rootNodeId(roots, probe.root);
  if (!nodeId) {
    return {
      ...probe,
      ok: !probe.required,
      status: probe.required ? PROBE_STATUS.BLOCKED : PROBE_STATUS.OPTIONAL_ABSENT,
      count: 0,
      collapsed: false,
      recovered: false,
      error: `Root not found: ${probe.root}`
    };
  }

  try {
    const health = await ensureHealthyViewport(client, {
      roots,
      root: probe.root,
      frameOwnerRoot: probe.frameOwnerRoot,
      reason: probe.id,
      repair: probe.repair,
      reacquireRoots
    });
    const ok = Boolean(health.ok);
    return {
      ...probe,
      ok: probe.required ? ok : true,
      status: ok ? PROBE_STATUS.PASS : probe.required ? PROBE_STATUS.FAIL : PROBE_STATUS.OPTIONAL_ABSENT,
      count: ok ? 1 : 0,
      collapsed: Boolean(health.collapsed),
      recovered: Boolean(health.recovered),
      viewport_health: compactViewportHealthResult(health),
      error: health.error || null
    };
  } catch (error) {
    return {
      ...probe,
      ok: !probe.required,
      status: probe.required ? PROBE_STATUS.ERROR : PROBE_STATUS.OPTIONAL_ABSENT,
      count: 0,
      collapsed: false,
      recovered: false,
      error: error?.message || String(error)
    };
  }
}

export function summarizeProbeResults(probes = []) {
  const required = probes.filter((probe) => probe.required);
  const blocked = required.filter((probe) => probe.status === PROBE_STATUS.BLOCKED);
  const failed = required.filter((probe) => !probe.ok && probe.status !== PROBE_STATUS.BLOCKED);
  const optionalAbsent = probes.filter((probe) => probe.status === PROBE_STATUS.OPTIONAL_ABSENT);
  const passed = probes.filter((probe) => probe.status === PROBE_STATUS.PASS);

  return {
    status: blocked.length
      ? HEALTH_STATUS.BLOCKED
      : failed.length
        ? HEALTH_STATUS.DEGRADED
        : HEALTH_STATUS.HEALTHY,
    required_count: required.length,
    passed_count: passed.length,
    failed_required_ids: failed.map((probe) => probe.id),
    blocked_required_ids: blocked.map((probe) => probe.id),
    optional_absent_ids: optionalAbsent.map((probe) => probe.id)
  };
}

export function buildDriftReport(probes = []) {
  return probes
    .filter((probe) => probe.required && !probe.ok)
    .map((probe) => ({
      probe_id: probe.id,
      probe_type: probe.type,
      status: probe.status,
      root: probe.root || null,
      expected_min_count: probe.minCount,
      observed_count: probe.count || 0,
      selectors: probe.selectors || [],
      viewport_health: probe.viewport_health || undefined,
      error: probe.error || null
    }));
}

export async function runSelfHealCheck({
  client,
  domain,
  roots = {},
  selectorProbes = [],
  accessibilityProbes = [],
  viewportProbes = [],
  networkProbes = [],
  networkEvents = [],
  reacquireRoots = null
} = {}) {
  const selectorResults = [];
  for (const probe of selectorProbes) {
    selectorResults.push(await runSelectorProbe(client, roots, probe));
  }

  const accessibilityResults = [];
  for (const probe of accessibilityProbes) {
    accessibilityResults.push(await runAccessibilityProbe(client, probe));
  }

  const viewportResults = [];
  const resolveViewportRoots = typeof reacquireRoots === "function"
    ? reacquireRoots
    : domain === "recommend"
      ? async () => (await resolveRecommendSelfHealRoots(client)).roots
      : domain === "recruit"
        ? async () => (await resolveRecruitSelfHealRoots(client)).roots
        : domain === "chat"
          ? async () => (await resolveChatSelfHealRoots(client)).roots
          : null;
  for (const probe of viewportProbes) {
    viewportResults.push(await runViewportCollapseProbe(client, roots, probe, {
      reacquireRoots: resolveViewportRoots
    }));
  }

  const networkResults = networkProbes.map((probe) => runNetworkProbe(networkEvents, probe));
  const probes = [...selectorResults, ...accessibilityResults, ...viewportResults, ...networkResults];
  const summary = summarizeProbeResults(probes);

  return {
    domain,
    status: summary.status,
    summary,
    probes,
    drift_report: buildDriftReport(probes)
  };
}

export function buildRecommendSelfHealConfig(rules = {}) {
  const iframeSelectors = selectorGroup(
    rules,
    "top",
    "recommend_iframe",
    FALLBACK_RECOMMEND_SELECTORS.top.recommend_iframe
  );
  const cardSelectors = mergeSelectorGroups(
    rules,
    "frame",
    [
      "latest_card_inner",
      "recommend_card_inner",
      "featured_card_anchor",
      "recommend_cards",
      "featured_cards",
      "latest_cards"
    ],
    FALLBACK_RECOMMEND_SELECTORS.frame.candidate_cards
  );

  return {
    domain: "recommend",
    targetHints: DOMAIN_TARGET_HINTS.recommend,
    iframeSelectors,
    selectorProbes: [
      createSelectorProbe({
        id: "recommend_iframe",
        root: "top",
        selectors: iframeSelectors,
        required: true,
        description: "Recommend iframe can be discovered from the top document"
      }),
      createSelectorProbe({
        id: "filter_trigger",
        root: "frame",
        selectors: selectorGroup(
          rules,
          "frame",
          "filter_trigger",
          FALLBACK_RECOMMEND_SELECTORS.frame.filter_trigger
        ),
        required: true,
        description: "Filter trigger is mounted in the recommend frame"
      }),
      createSelectorProbe({
        id: "candidate_cards",
        root: "frame",
        selectors: cardSelectors,
        required: true,
        description: "At least one recommend candidate card is visible"
      }),
      createSelectorProbe({
        id: "tab_items",
        root: "frame",
        selectors: selectorGroup(
          rules,
          "frame",
          "tab_items",
          FALLBACK_RECOMMEND_SELECTORS.frame.tab_items
        ),
        required: false,
        description: "Recommend tab controls are mounted when this layout exposes them"
      }),
      createSelectorProbe({
        id: "filter_panel",
        root: "frame",
        selectors: selectorGroup(
          rules,
          "frame",
          "filter_panel",
          FALLBACK_RECOMMEND_SELECTORS.frame.filter_panel
        ),
        required: false,
        description: "Filter panel is optional because it is absent until opened"
      }),
      createSelectorProbe({
        id: "detail_popup_top",
        root: "top",
        selectors: selectorGroup(
          rules,
          "detail",
          "popup",
          FALLBACK_RECOMMEND_SELECTORS.detail.popup
        ),
        required: false,
        description: "Candidate detail popup may be absent during idle health checks"
      }),
      createSelectorProbe({
        id: "detail_popup_frame",
        root: "frame",
        selectors: selectorGroup(
          rules,
          "detail",
          "popup",
          FALLBACK_RECOMMEND_SELECTORS.detail.popup
        ),
        required: false,
        description: "Candidate detail popup may mount inside the recommend frame"
      })
    ],
    viewportProbes: [
      createViewportCollapseProbe({
        id: "recommend_viewport_collapse",
        root: "frame",
        frameOwnerRoot: "frameOwner",
        required: true,
        repair: true,
        description: "Recommend frame/list viewport has not collapsed relative to the Chrome window"
      })
    ],
    accessibilityProbes: [
      createAccessibilityProbe({
        id: "accessibility_tree",
        required: true,
        minCount: 1,
        description: "Accessibility tree is readable without page script"
      })
    ],
    networkProbes: [
      createNetworkProbe({
        id: "zhipin_network_after_refresh",
        required: true,
        minCount: 1,
        urlPatterns: ["zhipin.com"],
        description: "A controlled refresh produced observable Boss network traffic"
      })
    ],
    repairActions: [
      {
        id: "page_reload",
        type: "page_reload",
        ignoreCache: false,
        waitMs: 2500,
        description: "Refresh the current page through Page.reload"
      }
    ]
  };
}

export function buildRecruitSelfHealConfig(rules = {}) {
  const iframeSelectors = selectorGroup(
    rules,
    "top",
    "search_iframe",
    FALLBACK_RECRUIT_SELECTORS.top.search_iframe
  );
  const cardSelectors = mergeSelectorGroups(
    rules,
    "frame",
    [
      "search_candidate_cards",
      "recruit_candidate_cards",
      "candidate_cards"
    ],
    FALLBACK_RECRUIT_SELECTORS.frame.candidate_cards
  );

  return {
    domain: "recruit",
    targetHints: DOMAIN_TARGET_HINTS.recruit,
    iframeSelectors,
    selectorProbes: [
      createSelectorProbe({
        id: "search_iframe",
        root: "top",
        selectors: iframeSelectors,
        required: true,
        description: "Search iframe can be discovered from the top document"
      }),
      createSelectorProbe({
        id: "candidate_cards",
        root: "frame",
        selectors: cardSelectors,
        required: true,
        description: "At least one search candidate card is visible"
      }),
      createSelectorProbe({
        id: "no_data_tip",
        root: "frame",
        selectors: selectorGroup(
          rules,
          "frame",
          "no_data",
          FALLBACK_RECRUIT_SELECTORS.frame.no_data
        ),
        required: false,
        description: "Search no-data state is optional and blocks candidate extraction if present"
      }),
      createSelectorProbe({
        id: "detail_popup_top",
        root: "top",
        selectors: selectorGroup(
          rules,
          "detail",
          "popup",
          FALLBACK_RECRUIT_SELECTORS.detail.popup
        ),
        required: false,
        description: "Candidate detail popup may be absent during idle health checks"
      }),
      createSelectorProbe({
        id: "detail_popup_frame",
        root: "frame",
        selectors: selectorGroup(
          rules,
          "detail",
          "popup",
          FALLBACK_RECRUIT_SELECTORS.detail.popup
        ),
        required: false,
        description: "Candidate detail popup may mount inside the search frame"
      })
    ],
    viewportProbes: [
      createViewportCollapseProbe({
        id: "recruit_viewport_collapse",
        root: "frame",
        frameOwnerRoot: "frameOwner",
        required: true,
        repair: true,
        description: "Search frame/list viewport has not collapsed relative to the Chrome window"
      })
    ],
    accessibilityProbes: [
      createAccessibilityProbe({
        id: "accessibility_tree",
        required: true,
        minCount: 1,
        description: "Accessibility tree is readable without page script"
      })
    ],
    networkProbes: [
      createNetworkProbe({
        id: "zhipin_network_after_refresh",
        required: true,
        minCount: 1,
        urlPatterns: ["zhipin.com"],
        description: "A controlled refresh produced observable Boss network traffic"
      })
    ],
    repairActions: [
      {
        id: "page_reload",
        type: "page_reload",
        ignoreCache: false,
        waitMs: 2500,
        description: "Refresh the current search page through Page.reload"
      }
    ]
  };
}

export function buildChatSelfHealConfig(rules = {}) {
  const cardSelectors = mergeSelectorGroups(
    rules,
    "top",
    [
      "chat_candidate_cards",
      "candidate_cards",
      "conversation_cards"
    ],
    FALLBACK_CHAT_SELECTORS.top.candidate_cards
  );

  return {
    domain: "chat",
    targetHints: DOMAIN_TARGET_HINTS.chat,
    selectorProbes: [
      createSelectorProbe({
        id: "candidate_cards",
        root: "top",
        selectors: cardSelectors,
        required: true,
        description: "At least one chat conversation candidate is visible"
      }),
      createSelectorProbe({
        id: "selected_candidate",
        root: "top",
        selectors: selectorGroup(
          rules,
          "top",
          "selected_candidate",
          FALLBACK_CHAT_SELECTORS.top.selected_candidate
        ),
        required: false,
        description: "A selected chat candidate is optional before extraction starts"
      }),
      createSelectorProbe({
        id: "online_resume_button",
        root: "top",
        selectors: selectorGroup(
          rules,
          "top",
          "online_resume_button",
          FALLBACK_CHAT_SELECTORS.top.online_resume_button
        ),
        required: false,
        description: "Online resume button appears after a candidate conversation is selected"
      }),
      createSelectorProbe({
        id: "resume_modal",
        root: "top",
        selectors: selectorGroup(
          rules,
          "detail",
          "resume_modal",
          FALLBACK_CHAT_SELECTORS.detail.resume_modal
        ),
        required: false,
        description: "Resume modal is optional during idle chat health checks"
      }),
      createSelectorProbe({
        id: "resume_iframe",
        root: "top",
        selectors: selectorGroup(
          rules,
          "detail",
          "resume_iframe",
          FALLBACK_CHAT_SELECTORS.detail.resume_iframe
        ),
        required: false,
        description: "Resume iframe appears after the online resume is opened"
      })
    ],
    viewportProbes: [
      createViewportCollapseProbe({
        id: "chat_viewport_collapse",
        root: "top",
        frameOwnerRoot: "top",
        required: true,
        repair: true,
        description: "Chat list viewport has not collapsed relative to the Chrome window"
      })
    ],
    accessibilityProbes: [
      createAccessibilityProbe({
        id: "accessibility_tree",
        required: true,
        minCount: 1,
        description: "Accessibility tree is readable without page script"
      })
    ],
    networkProbes: [
      createNetworkProbe({
        id: "zhipin_network_after_refresh",
        required: true,
        minCount: 1,
        urlPatterns: ["zhipin.com"],
        description: "A controlled refresh produced observable Boss network traffic"
      })
    ],
    repairActions: [
      {
        id: "page_reload",
        type: "page_reload",
        ignoreCache: false,
        waitMs: 2500,
        description: "Refresh the current chat page through Page.reload"
      }
    ]
  };
}

export async function resolveRecommendSelfHealRoots(client, config = buildRecommendSelfHealConfig()) {
  const topRoot = await getDocumentRoot(client);
  const iframe = await findIframeDocument(client, topRoot.nodeId, config.iframeSelectors);
  if (!iframe) {
    return {
      roots: {
        top: topRoot.nodeId
      },
      topRoot,
      iframe: null
    };
  }

  return {
    roots: {
      top: topRoot.nodeId,
      frame: iframe.documentNodeId,
      frameOwner: iframe.nodeId
    },
    topRoot,
    iframe
  };
}

export async function resolveRecruitSelfHealRoots(client, config = buildRecruitSelfHealConfig()) {
  const topRoot = await getDocumentRoot(client);
  const iframe = await findIframeDocument(client, topRoot.nodeId, config.iframeSelectors);
  if (!iframe) {
    return {
      roots: {
        top: topRoot.nodeId
      },
      topRoot,
      iframe: null
    };
  }

  return {
    roots: {
      top: topRoot.nodeId,
      frame: iframe.documentNodeId,
      frameOwner: iframe.nodeId
    },
    topRoot,
    iframe
  };
}

export async function resolveChatSelfHealRoots(client, _config = buildChatSelfHealConfig()) {
  const topRoot = await getDocumentRoot(client);
  return {
    roots: {
      top: topRoot.nodeId
    },
    topRoot,
    iframe: null
  };
}

export async function runRepairAction(client, action = {}) {
  if (action.type === "page_reload") {
    await client.Page.reload({ ignoreCache: Boolean(action.ignoreCache) });
    if (action.waitMs > 0) await sleep(action.waitMs);
    return {
      id: action.id || action.type,
      type: action.type,
      ok: true
    };
  }

  return {
    id: action.id || action.type || "unknown",
    type: action.type || "unknown",
    ok: false,
    error: `Unsupported repair action: ${action.type || "unknown"}`
  };
}

export function classifyBossTargets(targets = []) {
  const pageTargets = targets.filter((target) => target?.type === "page");
  const byDomain = {};
  for (const [domain, hints] of Object.entries(DOMAIN_TARGET_HINTS)) {
    const target = pageTargets.find((item) => {
      const url = String(item?.url || "");
      if (domain === "chat") {
        return hints.some((hint) => url.includes(hint))
          && !url.includes("/web/chat/recommend")
          && !url.includes("/web/chat/search");
      }
      return hints.some((hint) => url.includes(hint));
    });
    byDomain[domain] = target
      ? {
        status: "available",
        target: {
          id: target.id,
          type: target.type,
          url: target.url,
          title: target.title
        }
      }
      : {
        status: "blocked",
        reason: `No live ${domain} target is open in Chrome`
      };
  }
  return byDomain;
}
