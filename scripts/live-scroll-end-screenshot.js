#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
  getAttributesMap,
  sleep
} from "../src/core/browser/index.js";
import {
  compactInfiniteListState,
  createInfiniteListState,
  readVisibleInfiniteListItems,
  scrollInfiniteListByVisibleItems,
  updateInfiniteListVisibleSignature
} from "../src/core/infinite-list/index.js";
import {
  closeChatResumeModal,
  getChatRoots,
  readChatCardCandidate,
  CHAT_TARGET_URL,
  waitForChatCandidateNodeIds
} from "../src/domains/chat/index.js";
import {
  closeRecommendDetail,
  getRecommendRoots,
  readRecommendCardCandidate,
  RECOMMEND_TARGET_URL,
  waitForRecommendCardNodeIds
} from "../src/domains/recommend/index.js";
import {
  closeRecruitDetail,
  getRecruitRoots,
  readRecruitCardCandidate,
  RECRUIT_TARGET_URL,
  waitForRecruitCardNodeIds
} from "../src/domains/recruit/index.js";

const DOMAIN_CONFIGS = {
  chat: {
    targetUrl: CHAT_TARGET_URL,
    listName: "chat-candidates",
    fallbackPoint: { x: 320, y: 620 },
    async cleanup(client) {
      return closeChatResumeModal(client, { attemptsLimit: 2 });
    },
    async findNodeIds(client, timeoutMs) {
      const roots = await getChatRoots(client);
      const result = await waitForChatCandidateNodeIds(client, roots.rootNodes.top, {
        timeoutMs,
        intervalMs: 700
      });
      return result.nodeIds;
    },
    async readCandidate(client, nodeId, { visibleIndex, targetUrl }) {
      return readChatCardCandidate(client, nodeId, {
        targetUrl,
        source: "chat-scroll-end-live",
        metadata: { visible_index: visibleIndex }
      });
    }
  },
  recruit: {
    targetUrl: RECRUIT_TARGET_URL,
    listName: "search-results",
    fallbackPoint: { x: 700, y: 620 },
    async cleanup(client) {
      return closeRecruitDetail(client, { attemptsLimit: 2 });
    },
    async findNodeIds(client, timeoutMs) {
      const roots = await getRecruitRoots(client);
      return waitForRecruitCardNodeIds(client, roots.iframe.documentNodeId, {
        timeoutMs,
        intervalMs: 700
      });
    },
    async readCandidate(client, nodeId, { visibleIndex, targetUrl }) {
      return readRecruitCardCandidate(client, nodeId, {
        targetUrl,
        source: "recruit-scroll-end-live",
        metadata: { visible_index: visibleIndex }
      });
    }
  },
  recommend: {
    targetUrl: RECOMMEND_TARGET_URL,
    listName: "recommend-candidates",
    fallbackPoint: { x: 700, y: 620 },
    async cleanup(client) {
      return closeRecommendDetail(client, { attemptsLimit: 2 });
    },
    async findNodeIds(client, timeoutMs) {
      const roots = await getRecommendRoots(client);
      return waitForRecommendCardNodeIds(client, roots.iframe.documentNodeId, {
        timeoutMs,
        intervalMs: 700
      });
    },
    async readCandidate(client, nodeId, { visibleIndex, targetUrl }) {
      return readRecommendCardCandidate(client, nodeId, {
        targetUrl,
        source: "recommend-scroll-end-live",
        metadata: { visible_index: visibleIndex }
      });
    }
  }
};

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    domain: "chat",
    maxScrolls: 80,
    stableSignatureLimit: 3,
    wheelDeltaY: 1100,
    settleMs: 1800,
    cardTimeoutMs: 120000,
    navigateSettleMs: 10000,
    allowNavigate: true,
    readCandidates: false,
    saveMethodLog: false,
    saveImage: "",
    saveReport: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--domain") result.domain = argv[++index];
    if (arg === "--max-scrolls") result.maxScrolls = parsePositiveInt(argv[++index], result.maxScrolls);
    if (arg === "--stable-signature-limit") {
      result.stableSignatureLimit = parsePositiveInt(argv[++index], result.stableSignatureLimit);
    }
    if (arg === "--wheel-delta-y") result.wheelDeltaY = parsePositiveInt(argv[++index], result.wheelDeltaY);
    if (arg === "--settle-ms") result.settleMs = parsePositiveInt(argv[++index], result.settleMs);
    if (arg === "--card-timeout-ms") result.cardTimeoutMs = parsePositiveInt(argv[++index], result.cardTimeoutMs);
    if (arg === "--navigate-settle-ms") result.navigateSettleMs = parsePositiveInt(argv[++index], result.navigateSettleMs);
    if (arg === "--slow-live") {
      result.cardTimeoutMs = 180000;
      result.navigateSettleMs = 14000;
      result.settleMs = 2400;
    }
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--read-candidates") result.readCandidates = true;
    if (arg === "--save-method-log") result.saveMethodLog = true;
    if (arg === "--save-image") result.saveImage = argv[++index];
    if (arg === "--save-report") result.saveReport = argv[++index];
  }

  if (!DOMAIN_CONFIGS[result.domain]) {
    throw new Error(`Unsupported --domain ${result.domain}; expected chat, recruit, or recommend`);
  }
  if (!result.saveImage) result.saveImage = `.live-artifacts/${result.domain}-scroll-end.png`;
  if (!result.saveReport) result.saveReport = `.live-artifacts/${result.domain}-scroll-end.json`;
  return result;
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

function pickAttribute(attributes = {}, names = []) {
  for (const name of names) {
    const value = String(attributes[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function writeBase64File(filePath, base64Data) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, Buffer.from(base64Data, "base64"));
  return resolved;
}

async function connectSession(options, config) {
  try {
    return await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes: config.targetUrl
    });
  } catch (error) {
    if (!options.allowNavigate) {
      return connectToChromeTarget({
        host: options.host,
        port: options.port,
        targetPredicate: (target) => (
          target?.type === "page"
          && String(target?.url || "").includes("zhipin.com/web/chat")
        )
      });
    }
    return connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetPredicate: (target) => (
        target?.type === "page"
        && String(target?.url || "").includes("zhipin.com/web/chat")
      )
    });
  }
}

async function ensureTargetPage(client, target, config, options) {
  if (!options.allowNavigate || String(target?.url || "").includes(config.targetUrl)) {
    return {
      navigated: false,
      url: target?.url || ""
    };
  }
  await client.Page.navigate({ url: config.targetUrl });
  await sleep(options.navigateSettleMs);
  return {
    navigated: true,
    url: config.targetUrl,
    settle_ms: options.navigateSettleMs
  };
}

function compactVisibleItems(items = []) {
  return items.slice(0, 8).map((item) => ({
    key: item.key,
    visible_index: item.visible_index,
    node_id: item.node_id,
    id: item.candidate?.id || null,
    text_length: item.candidate?.text?.raw?.length || 0,
    tag_count: item.candidate?.tags?.length || 0
  }));
}

async function readVisibleSignatureItems(client, config, options, nodeIds, state) {
  if (options.readCandidates) {
    return readVisibleInfiniteListItems({
      nodeIds,
      state,
      readCandidate: async (nodeId, metadata) => config.readCandidate(client, nodeId, {
        ...metadata,
        targetUrl: config.targetUrl
      })
    });
  }

  const items = [];
  for (let visibleIndex = 0; visibleIndex < nodeIds.length; visibleIndex += 1) {
    const nodeId = nodeIds[visibleIndex];
    try {
      const attributes = await getAttributesMap(client, nodeId);
      const attrKey = pickAttribute(attributes, [
        "data-geek",
        "data-geekid",
        "data-jid",
        "data-id",
        "data-uid",
        "data-securityid",
        "href",
        "key",
        "id",
        "class"
      ]);
      const key = attrKey
        ? `${options.domain}:attr:${shortHash(attrKey)}`
        : `${options.domain}:node:${nodeId}`;
      items.push({
        key,
        node_id: nodeId,
        visible_index: visibleIndex,
        candidate: {
          id: attrKey || null,
          attributes,
          tags: [],
          text: { raw: "" }
        }
      });
    } catch (error) {
      state.read_error_count = (state.read_error_count || 0) + 1;
      state.ledger?.push({
        at: new Date().toISOString(),
        event: "signature_read_error",
        node_id: nodeId,
        visible_index: visibleIndex,
        error: error?.message || String(error)
      });
    }
  }
  return items;
}

async function scrollListToEnd(client, config, options) {
  const state = createInfiniteListState({
    domain: options.domain,
    listName: config.listName
  });
  const iterations = [];
  let lastItems = [];
  let endReason = "max_scrolls_exhausted";

  for (let iteration = 0; iteration <= options.maxScrolls; iteration += 1) {
    const nodeIds = await config.findNodeIds(client, options.cardTimeoutMs);
    const items = await readVisibleSignatureItems(client, config, options, nodeIds, state);
    lastItems = items;
    const signature = updateInfiniteListVisibleSignature(state, items);
    let newVisibleCount = 0;
    for (const item of items) {
      if (!item.key) continue;
      state.seen_keys.add(item.key);
      if (!state.processed_keys.has(item.key)) {
        newVisibleCount += 1;
        state.processed_keys.add(item.key);
      }
    }

    const entry = {
      iteration,
      visible_node_count: nodeIds.length,
      visible_item_count: items.length,
      new_visible_count: newVisibleCount,
      stable_signature_count: signature.stable_signature_count,
      seen_count: state.seen_keys.size,
      processed_count: state.processed_keys.size,
      scroll_count: state.scroll_count,
      signature: signature.signature
    };
    iterations.push(entry);

    if (!items.length) {
      endReason = "empty_visible_list";
      entry.end_reason = endReason;
      break;
    }

    if (
      newVisibleCount === 0
      && signature.stable_signature_count >= Math.max(1, options.stableSignatureLimit)
    ) {
      endReason = "stable_visible_signature";
      entry.end_reason = endReason;
      break;
    }

    const scrollResult = await scrollInfiniteListByVisibleItems(client, items, {
      wheelDeltaY: options.wheelDeltaY,
      settleMs: options.settleMs,
      fallbackPoint: config.fallbackPoint
    });
    entry.scroll_result = scrollResult;
    if (scrollResult.ok) {
      state.scroll_count += 1;
    } else {
      endReason = scrollResult.reason || "scroll_failed";
      entry.end_reason = endReason;
      break;
    }
  }

  return {
    end_reason: endReason,
    end_verified: endReason === "stable_visible_signature" || endReason === "empty_visible_list",
    final_visible_sample: compactVisibleItems(lastItems),
    final_visible_count: lastItems.length,
    iterations,
    state: compactInfiniteListState(state)
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const config = DOMAIN_CONFIGS[options.domain];
  let session;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    domain: options.domain,
    chrome: {
      host: options.host,
      port: options.port
    },
    options: {
      max_scrolls: options.maxScrolls,
      stable_signature_limit: options.stableSignatureLimit,
      wheel_delta_y: options.wheelDeltaY,
      settle_ms: options.settleMs,
      card_timeout_ms: options.cardTimeoutMs,
      read_candidates: options.readCandidates,
      save_method_log: options.saveMethodLog
    }
  };

  try {
    session = await connectSession(options, config);
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };

    result.runtime_guard_probe = await assertRuntimeEvaluateBlocked(client);
    await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
    await bringPageToFront(client);
    result.navigation = await ensureTargetPage(client, target, config, options);
    result.cleanup = await config.cleanup(client);
    result.scroll = await scrollListToEnd(client, config, options);

    const screenshot = await client.Page.captureScreenshot({
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });
    result.saved_image_path = writeBase64File(options.saveImage, screenshot.data || "");

    assertNoForbiddenCdpCalls(methodLog);
    result.runtime_evaluate_used = false;
    result.method_summary = methodSummary(methodLog);
    result.method_log_count = methodLog.length;
    result.method_log_tail = methodLog.slice(-30);
    if (options.saveMethodLog) result.method_log = methodLog;
    result.status = result.scroll.end_verified ? "PASS" : "PARTIAL";
    result.saved_report_path = writeJsonFile(options.saveReport, result);
    console.log(JSON.stringify({
      ...result,
      method_log: undefined,
      scroll: {
        ...result.scroll,
        iterations: result.scroll.iterations.slice(-8)
      }
    }, null, 2));
    if (!result.scroll.end_verified) process.exitCode = 2;
  } catch (error) {
    result.status = "FAIL";
    result.error = {
      name: error?.name || "Error",
      message: error?.message || String(error)
    };
    if (session?.methodLog) {
      result.method_summary = methodSummary(session.methodLog);
      result.method_log_count = session.methodLog.length;
      result.method_log_tail = session.methodLog.slice(-30);
      if (options.saveMethodLog) result.method_log = session.methodLog;
      result.runtime_evaluate_used = session.methodLog.some((entry) => /^Runtime\./.test(entry.method));
    }
    result.saved_report_path = writeJsonFile(options.saveReport, result);
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
