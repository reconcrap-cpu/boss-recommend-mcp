#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
  getAttributesMap,
  getOuterHTML,
  sleep
} from "../src/core/browser/index.js";
import {
  compactInfiniteListState,
  createInfiniteListState,
  detectInfiniteListBottomMarker,
  resolveInfiniteListFallbackPoint,
  updateInfiniteListVisibleSignature
} from "../src/core/infinite-list/index.js";
import {
  CHAT_BOTTOM_MARKER_SELECTORS,
  CHAT_CARD_SELECTORS,
  CHAT_LIST_CONTAINER_SELECTORS,
  CHAT_TARGET_URL,
  closeChatResumeModal,
  getChatRoots,
  waitForChatCandidateNodeIds
} from "../src/domains/chat/index.js";
import {
  RECOMMEND_BOTTOM_MARKER_SELECTORS,
  RECOMMEND_CARD_SELECTOR,
  RECOMMEND_END_REFRESH_SELECTOR,
  RECOMMEND_LIST_CONTAINER_SELECTORS,
  RECOMMEND_TARGET_URL,
  closeRecommendDetail,
  getRecommendRoots,
  waitForRecommendCardNodeIds
} from "../src/domains/recommend/index.js";
import {
  RECRUIT_BOTTOM_MARKER_SELECTORS,
  RECRUIT_BOTTOM_REFRESH_SELECTORS,
  RECRUIT_CARD_SELECTOR,
  RECRUIT_LIST_CONTAINER_SELECTORS,
  RECRUIT_TARGET_URL,
  closeRecruitDetail,
  getRecruitRoots,
  waitForRecruitCardNodeIds
} from "../src/domains/recruit/index.js";

const FALLBACK_METHODS = Object.freeze(["container", "item_union", "viewport_ratio"]);

const DOMAIN_CONFIGS = Object.freeze({
  chat: {
    targetUrl: CHAT_TARGET_URL,
    listName: "chat-candidates",
    containerSelectors: CHAT_LIST_CONTAINER_SELECTORS,
    itemSelectors: CHAT_CARD_SELECTORS,
    markerSelectors: CHAT_BOTTOM_MARKER_SELECTORS,
    refreshSelectors: [],
    viewportPoint: { xRatio: 0.16, yRatio: 0.4 },
    async cleanup(client) {
      return closeChatResumeModal(client, { attemptsLimit: 2 });
    },
    async roots(client) {
      const roots = await getChatRoots(client);
      return {
        roots,
        rootNodeId: roots.rootNodes.top
      };
    },
    async findNodeIds(client, rootNodeId, options) {
      const result = await waitForChatCandidateNodeIds(client, rootNodeId, {
        timeoutMs: options.cardTimeoutMs,
        intervalMs: 700
      });
      return {
        selector: result.selector,
        nodeIds: result.nodeIds
      };
    }
  },
  recommend: {
    targetUrl: RECOMMEND_TARGET_URL,
    listName: "recommend-candidates",
    containerSelectors: RECOMMEND_LIST_CONTAINER_SELECTORS,
    itemSelectors: [RECOMMEND_CARD_SELECTOR],
    markerSelectors: RECOMMEND_BOTTOM_MARKER_SELECTORS,
    refreshSelectors: [RECOMMEND_END_REFRESH_SELECTOR],
    viewportPoint: { xRatio: 0.28, yRatio: 0.5 },
    async cleanup(client) {
      return closeRecommendDetail(client, { attemptsLimit: 2 });
    },
    async roots(client) {
      const roots = await getRecommendRoots(client);
      return {
        roots,
        rootNodeId: roots.iframe.documentNodeId
      };
    },
    async findNodeIds(client, rootNodeId, options) {
      const nodeIds = await waitForRecommendCardNodeIds(client, rootNodeId, {
        timeoutMs: options.cardTimeoutMs,
        intervalMs: 700
      });
      return {
        selector: RECOMMEND_CARD_SELECTOR,
        nodeIds
      };
    }
  },
  search: {
    targetUrl: RECRUIT_TARGET_URL,
    listName: "search-results",
    containerSelectors: RECRUIT_LIST_CONTAINER_SELECTORS,
    itemSelectors: [RECRUIT_CARD_SELECTOR],
    markerSelectors: RECRUIT_BOTTOM_MARKER_SELECTORS,
    refreshSelectors: RECRUIT_BOTTOM_REFRESH_SELECTORS,
    viewportPoint: { xRatio: 0.28, yRatio: 0.5 },
    async cleanup(client) {
      return closeRecruitDetail(client, { attemptsLimit: 2 });
    },
    async roots(client) {
      const roots = await getRecruitRoots(client);
      return {
        roots,
        rootNodeId: roots.iframe.documentNodeId
      };
    },
    async findNodeIds(client, rootNodeId, options) {
      const nodeIds = await waitForRecruitCardNodeIds(client, rootNodeId, {
        timeoutMs: options.cardTimeoutMs,
        intervalMs: 700
      });
      return {
        selector: RECRUIT_CARD_SELECTOR,
        nodeIds
      };
    }
  }
});

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 9222,
    domains: ["chat", "recommend", "search"],
    methods: [...FALLBACK_METHODS],
    maxScrolls: 140,
    stableSignatureLimit: 4,
    minScrollsBeforeStableEnd: 3,
    bottomCheckInterval: 5,
    maxReadNodes: 80,
    wheelDeltaY: 1600,
    settleMs: 1600,
    cardTimeoutMs: 120000,
    navigateSettleMs: 10000,
    resetTopWheels: 12,
    resetSettleMs: 500,
    saveReport: `.live-artifacts/scroll-fallback-methods-${Date.now()}.json`
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") options.host = argv[++index];
    if (arg === "--port") options.port = Number(argv[++index]);
    if (arg === "--domain") options.domains = [argv[++index]];
    if (arg === "--domains") options.domains = String(argv[++index] || "").split(",").map((item) => item.trim()).filter(Boolean);
    if (arg === "--method") options.methods = [argv[++index]];
    if (arg === "--methods") options.methods = String(argv[++index] || "").split(",").map((item) => item.trim()).filter(Boolean);
    if (arg === "--max-scrolls") options.maxScrolls = parsePositiveInt(argv[++index], options.maxScrolls);
    if (arg === "--stable-signature-limit") {
      options.stableSignatureLimit = parsePositiveInt(argv[++index], options.stableSignatureLimit);
    }
    if (arg === "--min-scrolls-before-stable-end") {
      options.minScrollsBeforeStableEnd = parsePositiveInt(argv[++index], options.minScrollsBeforeStableEnd);
    }
    if (arg === "--bottom-check-interval") {
      options.bottomCheckInterval = parsePositiveInt(argv[++index], options.bottomCheckInterval);
    }
    if (arg === "--max-read-nodes") options.maxReadNodes = parsePositiveInt(argv[++index], options.maxReadNodes);
    if (arg === "--wheel-delta-y") options.wheelDeltaY = parsePositiveInt(argv[++index], options.wheelDeltaY);
    if (arg === "--settle-ms") options.settleMs = parsePositiveInt(argv[++index], options.settleMs);
    if (arg === "--card-timeout-ms") options.cardTimeoutMs = parsePositiveInt(argv[++index], options.cardTimeoutMs);
    if (arg === "--navigate-settle-ms") options.navigateSettleMs = parsePositiveInt(argv[++index], options.navigateSettleMs);
    if (arg === "--reset-top-wheels") options.resetTopWheels = parsePositiveInt(argv[++index], options.resetTopWheels);
    if (arg === "--reset-settle-ms") options.resetSettleMs = parsePositiveInt(argv[++index], options.resetSettleMs);
    if (arg === "--slow-live") {
      options.cardTimeoutMs = 180000;
      options.navigateSettleMs = 14000;
      options.settleMs = 2200;
      options.resetSettleMs = 800;
    }
    if (arg === "--save-report") options.saveReport = argv[++index];
    if (arg === "--no-save-report") options.saveReport = "";
  }

  for (const domain of options.domains) {
    if (!DOMAIN_CONFIGS[domain]) {
      throw new Error(`Unsupported domain "${domain}". Expected: ${Object.keys(DOMAIN_CONFIGS).join(", ")}`);
    }
  }
  for (const method of options.methods) {
    if (!FALLBACK_METHODS.includes(method)) {
      throw new Error(`Unsupported fallback method "${method}". Expected: ${FALLBACK_METHODS.join(", ")}`);
    }
  }
  return options;
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function methodSummary(methodLog = []) {
  const summary = {};
  for (const entry of methodLog) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function pickAttribute(attributes = {}, names = []) {
  for (const name of names) {
    const value = normalizeText(attributes[name]);
    if (value) return value;
  }
  return "";
}

async function candidateKeyForNode(client, domain, nodeId) {
  const attributes = await getAttributesMap(client, nodeId);
  const attrKey = pickAttribute(attributes, [
    "data-geek",
    "data-geekid",
    "data-jid",
    "data-expect",
    "data-id",
    "data-uid",
    "data-securityid",
    "href",
    "key",
    "id"
  ]);
  if (attrKey) {
    return {
      key: `${domain}:attr:${shortHash(attrKey)}`,
      attr_key_hash: shortHash(attrKey),
      attributes
    };
  }
  const outerHTML = await getOuterHTML(client, nodeId);
  return {
    key: `${domain}:html:${shortHash(outerHTML.slice(0, 1200))}`,
    attr_key_hash: null,
    attributes,
    html_length: outerHTML.length
  };
}

async function readVisibleItems(client, domain, nodeIds, state, options) {
  const items = [];
  const readNodeIds = nodeIds.slice(0, Math.max(1, Number(options.maxReadNodes) || 80));
  for (let visibleIndex = 0; visibleIndex < readNodeIds.length; visibleIndex += 1) {
    const nodeId = readNodeIds[visibleIndex];
    try {
      const keyed = await candidateKeyForNode(client, domain, nodeId);
      items.push({
        key: keyed.key,
        node_id: nodeId,
        visible_index: visibleIndex,
        attr_key_hash: keyed.attr_key_hash,
        html_length: keyed.html_length || null
      });
    } catch (error) {
      state.read_error_count = (state.read_error_count || 0) + 1;
      state.ledger?.push({
        at: new Date().toISOString(),
        event: "visible_item_read_error",
        node_id: nodeId,
        visible_index: visibleIndex,
        error: error?.message || String(error)
      });
    }
  }
  return items;
}

async function connectSession(options) {
  try {
    return await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetPredicate: (target) => (
        target?.type === "page"
        && String(target?.url || "").includes("zhipin.com/web/chat")
      )
    });
  } catch {
    return connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetPredicate: (target) => target?.type === "page"
    });
  }
}

async function navigateToDomain(client, config, options) {
  await client.Page.navigate({ url: config.targetUrl });
  await sleep(options.navigateSettleMs);
  return {
    url: config.targetUrl,
    settle_ms: options.navigateSettleMs
  };
}

async function getCurrentRootAndCards(client, config, options) {
  const rootState = await config.roots(client);
  const cards = await config.findNodeIds(client, rootState.rootNodeId, options);
  return {
    ...rootState,
    card_selector: cards.selector || "",
    nodeIds: cards.nodeIds || []
  };
}

async function resolveFallback(client, config, rootAndCards, method, options) {
  return resolveInfiniteListFallbackPoint(client, {
    rootNodeId: rootAndCards.rootNodeId,
    containerSelectors: config.containerSelectors,
    itemNodeIds: rootAndCards.nodeIds,
    itemSelectors: config.itemSelectors,
    allowedSources: [method],
    viewportPoint: config.viewportPoint,
    validateViewportPoint: true,
    maxProbeNodes: options.maxReadNodes
  });
}

async function dispatchWheel(client, point, deltaY, settleMs, { assistNodeId = 0 } = {}) {
  const wheelDelta = Number(deltaY) || 1;
  let assist = null;
  if (assistNodeId) {
    try {
      await client.DOM.scrollIntoViewIfNeeded({ nodeId: assistNodeId });
      await sleep(150);
      assist = { ok: true, node_id: assistNodeId };
    } catch (error) {
      assist = { ok: false, node_id: assistNodeId, error: error?.message || String(error) };
    }
  }
  await client.Input.dispatchMouseEvent({
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none"
  });
  await client.Input.dispatchMouseEvent({
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: 0,
    deltaY: wheelDelta
  });
  let gesture = null;
  if (typeof client?.Input?.synthesizeScrollGesture === "function") {
    try {
      const yDistance = -Math.sign(wheelDelta) * Math.min(1200, Math.abs(wheelDelta));
      await client.Input.synthesizeScrollGesture({
        x: point.x,
        y: point.y,
        yDistance,
        speed: 800,
        repeatCount: 1
      });
      gesture = { ok: true, y_distance: yDistance };
    } catch (error) {
      gesture = { ok: false, error: error?.message || String(error) };
    }
  }
  if (settleMs > 0) await sleep(settleMs);
  return { gesture, assist };
}

async function resetTowardTop(client, config, options) {
  const attempts = [];
  for (let index = 0; index < options.resetTopWheels; index += 1) {
    const rootAndCards = await getCurrentRootAndCards(client, config, {
      ...options,
      cardTimeoutMs: Math.min(options.cardTimeoutMs, 12000)
    });
    const fallback = await resolveInfiniteListFallbackPoint(client, {
      rootNodeId: rootAndCards.rootNodeId,
      containerSelectors: config.containerSelectors,
      itemNodeIds: rootAndCards.nodeIds,
      itemSelectors: config.itemSelectors,
      allowedSources: ["container", "item_union", "viewport_ratio"],
      viewportPoint: config.viewportPoint,
      validateViewportPoint: true
    });
    attempts.push({
      iteration: index,
      ok: Boolean(fallback.ok),
      source: fallback.source || null,
      point: fallback.point || null,
      visible_node_count: rootAndCards.nodeIds.length
    });
    if (!fallback.ok) break;
    await dispatchWheel(client, fallback.point, -Math.abs(options.wheelDeltaY), options.resetSettleMs);
  }
  return attempts;
}

async function detectBottom(client, config, rootNodeId) {
  return detectInfiniteListBottomMarker(client, {
    rootNodeId,
    markerSelectors: config.markerSelectors,
    refreshSelectors: config.refreshSelectors,
    maxMarkerNodes: 300,
    maxTextScanNodes: 900,
    textMaxLength: 120
  });
}

function shouldCheckBottom(iteration, options) {
  if (iteration === 0) return true;
  if (iteration < options.minScrollsBeforeStableEnd) return false;
  return iteration % Math.max(1, Number(options.bottomCheckInterval) || 5) === 0;
}

function compactIterations(iterations = []) {
  return iterations.map((iteration) => ({
    iteration: iteration.iteration,
    visible_node_count: iteration.visible_node_count,
    visible_item_count: iteration.visible_item_count,
    new_seen_count: iteration.new_seen_count,
    seen_count: iteration.seen_count,
    stable_signature_count: iteration.stable_signature_count,
    bottom_found: iteration.bottom?.found || false,
    bottom_reason: iteration.bottom?.reason || null,
    fallback_source: iteration.fallback?.source || null,
    fallback_ok: iteration.fallback?.ok || false,
    end_reason: iteration.end_reason || null
  }));
}

async function runFallbackMode(client, domain, method, options) {
  const config = DOMAIN_CONFIGS[domain];
  const state = createInfiniteListState({
    domain,
    listName: `${config.listName}:${method}`
  });
  const result = {
    domain,
    method,
    status: "UNKNOWN",
    navigation: await navigateToDomain(client, config, options),
    cleanup: null,
    reset_top: [],
    iterations: [],
    fallback_sources_used: [],
    end_reason: "",
    bottom: null,
    state: null
  };

  result.cleanup = await config.cleanup(client);
  result.reset_top = await resetTowardTop(client, config, options);
  let initialSeenCount = null;

  for (let iteration = 0; iteration <= options.maxScrolls; iteration += 1) {
    const rootAndCards = await getCurrentRootAndCards(client, config, options);
    const items = await readVisibleItems(client, domain, rootAndCards.nodeIds, state, options);
    const signature = updateInfiniteListVisibleSignature(state, items);
    let newSeenCount = 0;
    for (const item of items) {
      if (!state.seen_keys.has(item.key)) newSeenCount += 1;
      state.seen_keys.add(item.key);
    }
    if (initialSeenCount === null) initialSeenCount = state.seen_keys.size;
    const bottom = shouldCheckBottom(iteration, options)
      ? await detectBottom(client, config, rootAndCards.rootNodeId)
      : { found: false, reason: "not_checked_this_iteration" };
    const entry = {
      iteration,
      root_node_id: rootAndCards.rootNodeId,
      card_selector: rootAndCards.card_selector,
      visible_node_count: rootAndCards.nodeIds.length,
      visible_item_count: items.length,
      new_seen_count: newSeenCount,
      seen_count: state.seen_keys.size,
      stable_signature_count: signature.stable_signature_count,
      signature: signature.signature,
      bottom
    };
    result.iterations.push(entry);
    console.log(`[live-scroll-fallbacks] ${domain}/${method} iteration=${iteration} nodes=${rootAndCards.nodeIds.length} read=${items.length} seen=${state.seen_keys.size} stable=${signature.stable_signature_count} bottom=${bottom.found ? bottom.reason : "no"}`);

    if (bottom.found) {
      result.status = "PASS";
      result.end_reason = "bottom_marker";
      result.bottom = bottom;
      entry.end_reason = result.end_reason;
      break;
    }

    if (
      iteration >= options.minScrollsBeforeStableEnd
      && signature.stable_signature_count >= options.stableSignatureLimit
    ) {
      const progressedBeyondInitialViewport = state.seen_keys.size > initialSeenCount + Math.max(5, Math.min(20, items.length));
      result.status = "FAIL";
      result.end_reason = progressedBeyondInitialViewport
        ? "stable_visible_signature_without_bottom_marker"
        : "stable_without_scroll_progress";
      result.bottom = bottom;
      entry.end_reason = result.end_reason;
      break;
    }

    if (!items.length) {
      result.status = "PARTIAL";
      result.end_reason = "empty_visible_items";
      result.bottom = bottom;
      entry.end_reason = result.end_reason;
      break;
    }

    const fallback = await resolveFallback(client, config, rootAndCards, method, options);
    entry.fallback = fallback.ok
      ? {
        ok: true,
        source: fallback.source,
        point: fallback.point,
        selector: fallback.selector || null,
        validated: fallback.validated ?? null,
        node_id: fallback.node_id || null,
        assist_node_id: fallback.assist_node_id || null
      }
      : {
        ok: false,
        reason: fallback.reason || "fallback_unavailable"
      };

    if (!fallback.ok) {
      result.status = "FAIL";
      result.end_reason = fallback.reason || "fallback_unavailable";
      result.bottom = bottom;
      entry.end_reason = result.end_reason;
      break;
    }

    result.fallback_sources_used.push(fallback.source);
    console.log(`[live-scroll-fallbacks] ${domain}/${method} wheel source=${fallback.source} x=${Math.round(fallback.point.x)} y=${Math.round(fallback.point.y)}`);
    const scrollDispatch = await dispatchWheel(client, fallback.point, Math.abs(options.wheelDeltaY), options.settleMs, {
      assistNodeId: fallback.assist_node_id || 0
    });
    entry.scroll_dispatch = scrollDispatch;
    state.scroll_count += 1;
  }

  if (result.status === "UNKNOWN") {
    const rootAndCards = await getCurrentRootAndCards(client, config, {
      ...options,
      cardTimeoutMs: Math.min(options.cardTimeoutMs, 12000)
    });
    const bottom = await detectBottom(client, config, rootAndCards.rootNodeId);
    result.bottom = bottom;
    if (bottom.found) {
      result.status = "PASS";
      result.end_reason = "bottom_marker_after_max_scrolls";
      result.state = compactInfiniteListState(state);
      return result;
    }
    result.status = "FAIL";
    result.end_reason = "max_scrolls_exhausted";
  }
  result.state = compactInfiniteListState(state);
  result.used_requested_method = result.fallback_sources_used.includes(method);
  if (result.status === "PASS" && !result.used_requested_method) {
    result.status = "FAIL";
    result.end_reason = "requested_fallback_method_was_not_used";
  }
  return result;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let session = null;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port
    },
    options: {
      domains: options.domains,
      methods: options.methods,
      max_scrolls: options.maxScrolls,
      stable_signature_limit: options.stableSignatureLimit,
      min_scrolls_before_stable_end: options.minScrollsBeforeStableEnd,
      bottom_check_interval: options.bottomCheckInterval,
      max_read_nodes: options.maxReadNodes,
      wheel_delta_y: options.wheelDeltaY,
      settle_ms: options.settleMs,
      card_timeout_ms: options.cardTimeoutMs,
      navigate_settle_ms: options.navigateSettleMs
    },
    runtime_evaluate_used: false,
    runs: []
  };

  try {
    session = await connectSession(options);
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };

    await enableDomains(client, ["Page", "DOM", "Input"]);
    await bringPageToFront(client);

    for (const domain of options.domains) {
      for (const method of options.methods) {
        console.log(`[live-scroll-fallbacks] ${domain}/${method} starting`);
        const runResult = await runFallbackMode(client, domain, method, options);
        result.runs.push({
          ...runResult,
          iterations: compactIterations(runResult.iterations),
          full_iteration_count: runResult.iterations.length
        });
        console.log(`[live-scroll-fallbacks] ${domain}/${method} ${runResult.status} ${runResult.end_reason} seen=${runResult.state?.seen_count || 0} scrolls=${runResult.state?.scroll_count || 0}`);
      }
    }

    result.runtime_guard_probe = assertNoForbiddenCdpCalls(methodLog);
    result.runtime_evaluate_used = false;
    result.method_summary = methodSummary(methodLog);
    result.method_log_count = methodLog.length;
    result.method_log_tail = methodLog.slice(-40);
    result.status = result.runs.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
    if (options.saveReport) result.saved_report_path = writeJsonFile(options.saveReport, result);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "PASS") process.exitCode = 2;
  } catch (error) {
    result.status = "FAIL";
    result.error = {
      name: error?.name || "Error",
      message: error?.message || String(error)
    };
    if (session?.methodLog) {
      result.method_summary = methodSummary(session.methodLog);
      result.method_log_count = session.methodLog.length;
      result.method_log_tail = session.methodLog.slice(-40);
      result.runtime_evaluate_used = session.methodLog.some((entry) => /^Runtime\./.test(entry.method));
    }
    if (options.saveReport) result.saved_report_path = writeJsonFile(options.saveReport, result);
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
