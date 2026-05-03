#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
  sleep
} from "../src/core/browser/index.js";
import {
  compactInfiniteListState,
  createInfiniteListState,
  getNextInfiniteListCandidate,
  markInfiniteListCandidateProcessed
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
        intervalMs: 500
      });
    },
    async readCandidate(client, nodeId, { visibleIndex, targetUrl }) {
      return readRecommendCardCandidate(client, nodeId, {
        targetUrl,
        source: "recommend-infinite-list-live",
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
        intervalMs: 500
      });
    },
    async readCandidate(client, nodeId, { visibleIndex, targetUrl }) {
      return readRecruitCardCandidate(client, nodeId, {
        targetUrl,
        source: "recruit-infinite-list-live",
        metadata: { visible_index: visibleIndex }
      });
    }
  },
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
        intervalMs: 500
      });
      return result.nodeIds;
    },
    async readCandidate(client, nodeId, { visibleIndex, targetUrl }) {
      return readChatCardCandidate(client, nodeId, {
        targetUrl,
        source: "chat-infinite-list-live",
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
    domain: "recommend",
    targetUrlIncludes: "",
    targetUnique: 18,
    maxScrollsPerCandidate: 4,
    stableSignatureLimit: 2,
    wheelDeltaY: 850,
    settleMs: 1200,
    cardTimeoutMs: 90000,
    navigateSettleMs: 5000,
    allowNavigate: true,
    saveReport: ".live-artifacts/infinite-list-smoke.json"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--domain") result.domain = argv[++index];
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--target-unique") result.targetUnique = parsePositiveInt(argv[++index], result.targetUnique);
    if (arg === "--max-scrolls-per-candidate") {
      result.maxScrollsPerCandidate = parsePositiveInt(argv[++index], result.maxScrollsPerCandidate);
    }
    if (arg === "--stable-signature-limit") {
      result.stableSignatureLimit = parsePositiveInt(argv[++index], result.stableSignatureLimit);
    }
    if (arg === "--wheel-delta-y") result.wheelDeltaY = parsePositiveInt(argv[++index], result.wheelDeltaY);
    if (arg === "--settle-ms") result.settleMs = parsePositiveInt(argv[++index], result.settleMs);
    if (arg === "--card-timeout-ms") result.cardTimeoutMs = parsePositiveInt(argv[++index], result.cardTimeoutMs);
    if (arg === "--navigate-settle-ms") result.navigateSettleMs = parsePositiveInt(argv[++index], result.navigateSettleMs);
    if (arg === "--slow-live") {
      result.cardTimeoutMs = 180000;
      result.navigateSettleMs = 10000;
      result.settleMs = 1800;
    }
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--no-save-report") result.saveReport = "";
  }

  if (!DOMAIN_CONFIGS[result.domain]) {
    throw new Error(`Unsupported --domain ${result.domain}; expected recommend, recruit, or chat`);
  }
  return result;
}

function methodSummary(methodLog) {
  const summary = {};
  for (const entry of methodLog) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function redactIdentity(identity = {}) {
  return {
    ...identity,
    name: identity?.name ? "[redacted]" : null
  };
}

function compactCandidate(candidate) {
  return {
    domain: candidate?.domain || "",
    source: candidate?.source || "",
    id: candidate?.id || null,
    identity: redactIdentity(candidate?.identity || {}),
    text_length: candidate?.text?.raw?.length || 0,
    tag_count: candidate?.tags?.length || 0
  };
}

async function connectSession(options, config) {
  const targetUrlIncludes = options.targetUrlIncludes || config.targetUrl;
  try {
    return await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes
    });
  } catch (error) {
    if (!options.allowNavigate) throw error;
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
  const targetUrl = config.targetUrl;
  if (!options.allowNavigate || String(target?.url || "").includes(targetUrl)) {
    return {
      navigated: false,
      url: target?.url || ""
    };
  }
  await client.Page.navigate({ url: targetUrl });
  await sleep(options.navigateSettleMs);
  return {
    navigated: true,
    url: targetUrl,
    settle_ms: options.navigateSettleMs
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
    target_unique: options.targetUnique,
    slow_live: options.cardTimeoutMs >= 180000,
    chrome: {
      host: options.host,
      port: options.port
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

    const state = createInfiniteListState({
      domain: options.domain,
      listName: config.listName
    });
    const processed = [];
    let endResult = null;
    while (processed.length < options.targetUnique) {
      const next = await getNextInfiniteListCandidate({
        client,
        state,
        maxScrolls: options.maxScrollsPerCandidate,
        stableSignatureLimit: options.stableSignatureLimit,
        wheelDeltaY: options.wheelDeltaY,
        settleMs: options.settleMs,
        fallbackPoint: config.fallbackPoint,
        findNodeIds: async () => config.findNodeIds(client, options.cardTimeoutMs),
        readCandidate: async (nodeId, metadata) => config.readCandidate(client, nodeId, {
          ...metadata,
          targetUrl: config.targetUrl
        })
      });
      if (!next.ok) {
        endResult = next;
        break;
      }
      processed.push({
        key: next.item.key,
        node_id: next.item.node_id,
        visible_index: next.item.visible_index,
        candidate: compactCandidate(next.item.candidate)
      });
      markInfiniteListCandidateProcessed(state, next.item.key, {
        metadata: {
          processed_index: processed.length - 1,
          candidate_id: next.item.candidate?.id || null
        }
      });
    }

    assertNoForbiddenCdpCalls(methodLog);
    result.runtime_evaluate_used = false;
    result.infinite_list = {
      processed_count: processed.length,
      unique_key_count: new Set(processed.map((item) => item.key)).size,
      duplicate_processed: processed.length !== new Set(processed.map((item) => item.key)).size,
      target_reached: processed.length >= options.targetUnique,
      end_reached: Boolean(endResult?.end_reached),
      end_reason: endResult?.reason || null,
      final_state: compactInfiniteListState(state),
      candidates: processed,
      end_attempts: endResult?.attempts || []
    };
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;
    if (result.infinite_list.duplicate_processed) {
      throw new Error("Infinite-list cursor processed a duplicate candidate key");
    }
    result.status = "PASS";
    if (options.saveReport) {
      result.saved_report_path = writeJsonFile(options.saveReport, result);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    result.status = "FAIL";
    result.error = {
      name: error?.name || "Error",
      message: error?.message || String(error)
    };
    if (session?.methodLog) {
      result.method_summary = methodSummary(session.methodLog);
      result.method_log = session.methodLog;
      result.runtime_evaluate_used = session.methodLog.some((entry) => /^Runtime\./.test(entry.method));
    }
    if (options.saveReport) {
      result.saved_report_path = writeJsonFile(options.saveReport, result);
    }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
