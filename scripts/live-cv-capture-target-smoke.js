#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  clickPoint,
  connectToChromeTargetOrOpen,
  enableDomains,
  getMainFrameUrl,
  sleep
} from "../src/core/browser/index.js";
import { captureScrolledNodeScreenshots } from "../src/core/capture/index.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "../src/core/cv-acquisition/index.js";
import { waitForCvCaptureTarget } from "../src/core/cv-capture-target/index.js";
import {
  verifyCaptureEvidenceSafety,
  verifyScreenshotMethodSafety
} from "./live-helpers/capture-safety-proof.js";
import { candidateKeyFromProfile } from "../src/core/infinite-list/index.js";
import {
  closeRecommendDetail,
  openRecommendCardDetailWithFreshRetry,
  readRecommendCardCandidate,
  waitForRecommendCardNodeIds,
  waitForRecommendDetail,
  waitForRecommendRoots
} from "../src/domains/recommend/index.js";
import {
  applyRecruitSearchParams,
  closeRecruitDetail,
  openRecruitCardDetail,
  readRecruitCardCandidate,
  waitForRecruitCardNodeIds,
  waitForRecruitDetail,
  waitForRecruitRoots
} from "../src/domains/recruit/index.js";
import {
  closeChatResumeModal,
  ensureNoOpenChatResumeModalBeforeCandidateClick,
  findChatCandidateNodeIdById,
  getChatRoots,
  openChatOnlineResume,
  readChatCardCandidate,
  selectChatCandidate,
  waitForChatCandidateNodeIds,
  waitForChatResumeContent
} from "../src/domains/chat/index.js";

const DOMAIN_CONFIG = Object.freeze({
  recommend: {
    targetUrl: "https://www.zhipin.com/web/chat/recommend",
    targetUrlIncludes: "/web/chat/recommend",
    captureViewport: false,
    padding: 0
  },
  search: {
    targetUrl: "https://www.zhipin.com/web/chat/search",
    targetUrlIncludes: "/web/chat/search",
    captureViewport: false,
    padding: 0
  },
  chat: {
    targetUrl: "https://www.zhipin.com/web/chat/index",
    targetUrlIncludes: "/web/chat/index",
    captureViewport: false,
    padding: 0
  }
});

const CHAT_RESUME_IMAGE_STOP_BOUNDARY_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "p",
  "span",
  "section",
  "article",
  "div",
  "[class*='privacy']",
  "[class*='recommend']",
  "[class*='similar']"
].join(",");

const CHAT_RESUME_IMAGE_STOP_BOUNDARY_TEXT = Object.freeze([
  /其他名企大厂/,
  /其他.*牛人/,
  /毕业的牛人/,
  /经历牛人/,
  /为妥善保护/,
  /查看全部.*项分析/,
  /牛人分析器/
]);

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    domains: ["recommend", "search", "chat"],
    host: "127.0.0.1",
    port: 9222,
    maxScreenshots: DEFAULT_MAX_IMAGE_PAGES,
    outputDir: path.resolve(".live-artifacts", "cv-capture-target-smoke", timestampForPath()),
    searchKeyword: "算法工程师",
    chatScanLimit: 10
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--domain" && next) {
      parsed.domains = next === "all" ? ["recommend", "search", "chat"] : next.split(",");
      index += 1;
    } else if (arg === "--port" && next) {
      parsed.port = Number(next) || parsed.port;
      index += 1;
    } else if (arg === "--host" && next) {
      parsed.host = next;
      index += 1;
    } else if (arg === "--max-screenshots" && next) {
      parsed.maxScreenshots = Number(next) || parsed.maxScreenshots;
      index += 1;
    } else if (arg === "--output-dir" && next) {
      parsed.outputDir = path.resolve(next);
      index += 1;
    } else if (arg === "--search-keyword" && next) {
      parsed.searchKeyword = next;
      index += 1;
    } else if (arg === "--chat-scan-limit" && next) {
      parsed.chatScanLimit = Number(next) || parsed.chatScanLimit;
      index += 1;
    }
  }
  parsed.domains = parsed.domains.map((item) => String(item || "").trim()).filter(Boolean);
  return parsed;
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function connectDomain(domain, options) {
  const config = DOMAIN_CONFIG[domain];
  if (!config) throw new Error(`Unknown domain: ${domain}`);
  const session = await connectToChromeTargetOrOpen({
    host: options.host,
    port: options.port,
    targetUrlIncludes: config.targetUrlIncludes,
    targetUrl: config.targetUrl,
    allowNavigate: true,
    slowLive: true,
    launchIfMissing: false
  });
  await enableDomains(session.client, ["Page", "DOM", "Input", "Network"]);
  await bringPageToFront(session.client);
  await sleep(1200);
  return session;
}

async function ensureRecommendDetail(client) {
  const existing = await waitForRecommendDetail(client, { timeoutMs: 1200, intervalMs: 150 });
  if (existing?.popup || existing?.resumeIframe) {
    return {
      detailState: existing,
      openedFromCard: false,
      cardCount: null,
      candidateKey: null
    };
  }

  const roots = await waitForRecommendRoots(client, { timeoutMs: 20000, intervalMs: 500 });
  const frameNodeId = roots?.iframe?.documentNodeId;
  if (!frameNodeId) throw new Error("recommend iframe was not ready");
  const cardNodeIds = await waitForRecommendCardNodeIds(client, frameNodeId, {
    timeoutMs: 20000,
    intervalMs: 500
  });
  if (!cardNodeIds.length) throw new Error("recommend candidate cards were not found");

  const cardCandidate = await readRecommendCardCandidate(client, cardNodeIds[0], {
    source: "recommend-live-cv-capture-target-smoke"
  });
  const candidateKey = candidateKeyFromProfile(cardCandidate, { nodeId: cardNodeIds[0] });
  const opened = await openRecommendCardDetailWithFreshRetry(client, {
    cardNodeId: cardNodeIds[0],
    candidateKey,
    cardCandidate,
    rootState: roots,
    maxAttempts: 2,
    timeoutMs: 15000
  });
  return {
    detailState: opened.detail_state,
    openedFromCard: true,
    cardCount: cardNodeIds.length,
    candidateKey
  };
}

async function ensureSearchDetail(client, { searchKeyword }) {
  const existing = await waitForRecruitDetail(client, { timeoutMs: 1200, intervalMs: 150 });
  if (existing?.popup || existing?.resumeIframe) {
    return {
      detailState: existing,
      openedFromCard: false,
      cardCount: null
    };
  }

  let roots = await waitForRecruitRoots(client, { timeoutMs: 20000, intervalMs: 500 });
  let frameNodeId = roots?.iframe?.documentNodeId;
  if (!frameNodeId) throw new Error("search iframe was not ready");
  let cardNodeIds = await waitForRecruitCardNodeIds(client, frameNodeId, {
    timeoutMs: 10000,
    intervalMs: 500
  });

  if (!cardNodeIds.length) {
    await applyRecruitSearchParams(client, {
      searchParams: {
        keyword: searchKeyword,
        degree: "不限"
      },
      requireCards: true,
      resetBeforeApply: false,
      searchTimeoutMs: 90000
    });
    roots = await waitForRecruitRoots(client, { timeoutMs: 20000, intervalMs: 500 });
    frameNodeId = roots?.iframe?.documentNodeId;
    cardNodeIds = await waitForRecruitCardNodeIds(client, frameNodeId, {
      timeoutMs: 20000,
      intervalMs: 500
    });
  }

  if (!cardNodeIds.length) throw new Error("search candidate cards were not found");
  await readRecruitCardCandidate(client, cardNodeIds[0], {
    source: "search-live-cv-capture-target-smoke"
  });
  const opened = await openRecruitCardDetail(client, cardNodeIds[0], {
    timeoutMs: 15000
  });
  return {
    detailState: opened.detail_state,
    openedFromCard: true,
    cardCount: cardNodeIds.length
  };
}

async function ensureChatResume(client, { chatScanLimit }) {
  await closeChatResumeModal(client, { attemptsLimit: 2 }).catch(() => null);
  const attempts = [];
  const seenKeys = new Set();
  const limit = Math.max(1, chatScanLimit);
  let lastCardCount = 0;
  for (let index = 0; index < limit; index += 1) {
    await ensureNoOpenChatResumeModalBeforeCandidateClick(client).catch(() => null);
    const roots = await getChatRoots(client);
    const cards = await waitForChatCandidateNodeIds(client, roots.rootNodes.top, {
      timeoutMs: 20000,
      intervalMs: 500
    });
    const nodeIds = cards.nodeIds || [];
    lastCardCount = Math.max(lastCardCount, nodeIds.length);
    if (!nodeIds.length) throw new Error("chat candidate cards were not found");

    let nodeId = 0;
    let candidate = null;
    let candidateKey = "";
    for (const candidateNodeId of nodeIds) {
      try {
        const readCandidate = await readChatCardCandidate(client, candidateNodeId, {
          source: "chat-live-cv-capture-target-smoke"
        });
        const readKey = candidateKeyFromProfile(readCandidate, { nodeId: candidateNodeId });
        if (seenKeys.has(readKey)) continue;
        nodeId = candidateNodeId;
        candidate = readCandidate;
        candidateKey = readKey;
        seenKeys.add(readKey);
        break;
      } catch {}
    }
    if (!nodeId) {
      attempts.push({
        index,
        error: "no_unseen_visible_chat_candidate",
        visible_card_count: nodeIds.length
      });
      break;
    }

    try {
      const freshRoots = await getChatRoots(client);
      const freshNodeId = candidate?.id
        ? await findChatCandidateNodeIdById(client, freshRoots.rootNodes.top, candidate.id)
        : 0;
      const clickNodeId = freshNodeId || nodeId;
      const selected = await selectChatCandidate(client, clickNodeId, {
        timeoutMs: 9000,
        settleMs: 1000
      });
      attempts.push({
        index,
        node_id: nodeId,
        ready_ok: Boolean(selected.ready?.ok),
        ready_reason: selected.ready?.reason || null
      });
      if (!selected.ready?.ok) continue;
      const opened = await openChatOnlineResume(client, {
        timeoutMs: 15000
      });
      const contentWait = await waitForChatResumeContent(client, {
        minTextLength: 80,
        timeoutMs: 15000,
        intervalMs: 500
      }).catch((error) => ({
        ok: false,
        error: error?.message || String(error),
        resume_state: opened.resume_state
      }));
      return {
        detailState: contentWait.resume_state || opened.resume_state,
        openedFromCard: true,
        cardCount: lastCardCount,
        candidateKey,
        attempts,
        contentWait
      };
    } catch (error) {
      attempts.push({
        index,
        node_id: nodeId,
        error: error?.message || String(error)
      });
      await closeChatResumeModal(client, { attemptsLimit: 1 }).catch(() => null);
    }
  }

  throw new Error(`No chat candidate with an openable online resume found; attempts=${JSON.stringify(attempts.slice(0, 8))}`);
}

async function captureDomainCv(client, domain, detailState, options) {
  const config = DOMAIN_CONFIG[domain];
  const captureTargetWait = await waitForCvCaptureTarget(client, detailState, {
    domain,
    timeoutMs: 10000,
    intervalMs: 250
  });
  const captureTarget = captureTargetWait.target || null;
  if (!captureTarget?.node_id) {
    throw new Error(`${domain} CV-only capture target was not found`);
  }

  const filePath = path.join(options.outputDir, `${domain}.jpg`);
  const evidence = await captureScrolledNodeScreenshots(client, captureTarget.node_id, {
    filePath,
    format: "jpeg",
    quality: 72,
    optimize: true,
    resizeMaxWidth: 1100,
    captureViewport: config.captureViewport,
    captureBeyondViewport: false,
    fromSurface: true,
    iframeOwnerNodeId: captureTarget.iframe_node_id || null,
    padding: config.padding,
    maxScreenshots: options.maxScreenshots,
    wheelDeltaY: 650,
    settleMs: 350,
    scrollMethod: "dom-anchor-fallback-input",
    stepTimeoutMs: 45000,
    totalTimeoutMs: 180000,
    duplicateStopCount: 2,
    skipDuplicateScreenshots: true,
    requireTerminalProof: true,
    composeForLlm: false,
    stopBoundarySelector: domain === "chat" ? CHAT_RESUME_IMAGE_STOP_BOUNDARY_SELECTOR : "",
    stopBoundaryTextPatterns: domain === "chat" ? CHAT_RESUME_IMAGE_STOP_BOUNDARY_TEXT : [],
    stopBoundaryMaxProbeNodes: domain === "chat" ? 360 : 180,
    stopBoundaryTopPadding: 10,
    stopBoundaryMinCaptureHeight: 180,
    metadata: {
      domain,
      capture_mode: "scroll_sequence",
      capture_scope: "cv_only_live_smoke",
      capture_target: captureTarget,
      capture_target_wait: captureTargetWait
    }
  });
  const safetyProof = verifyCaptureEvidenceSafety(evidence);
  if (!safetyProof.ok) {
    throw new Error(`${domain} capture safety proof failed: ${JSON.stringify(safetyProof.issues)}`);
  }
  if (evidence.optimization?.browser_clip_used) {
    throw new Error(`${domain} capture used a browser-side clip`);
  }
  if (evidence.optimization?.capture_beyond_viewport) {
    throw new Error(`${domain} capture enabled captureBeyondViewport`);
  }
  const fullScrollDetected = Boolean(
    evidence.ok === true
    && evidence.coverage_complete === true
    && evidence.screenshot_count > 0
    && (
      (evidence.capture_count || 0) < options.maxScreenshots
      || (evidence.dropped_duplicate_count || 0) > 0
      || evidence.stop_boundary_result?.action === "capture_then_stop"
      || evidence.stop_boundary_result?.action === "stop_before_capture"
    )
  );
  return {
    captureTarget,
    evidence,
    safetyProof,
    fullScrollDetected,
    captureTargetWait
  };
}

function summarizeResult(domain, data = {}) {
  return {
    domain,
    ok: true,
    url: data.url || null,
    opened_from_card: Boolean(data.detail?.openedFromCard),
    card_count: data.detail?.cardCount ?? null,
    target: {
      node_id: data.capture?.captureTarget?.node_id || null,
      source: data.capture?.captureTarget?.source || null,
      selector: data.capture?.captureTarget?.selector || null,
      cv_only: Boolean(data.capture?.captureTarget?.cv_only),
      rect: data.capture?.captureTarget?.rect || null
    },
    target_wait: {
      ok: Boolean(data.capture?.captureTargetWait?.ok),
      elapsed_ms: data.capture?.captureTargetWait?.elapsed_ms || 0
    },
    capture: {
      full_scroll_detected: Boolean(data.capture?.fullScrollDetected),
      capture_count: data.capture?.evidence?.capture_count || 0,
      screenshot_count: data.capture?.evidence?.screenshot_count || 0,
      dropped_duplicate_count: data.capture?.evidence?.dropped_duplicate_count || 0,
      max_screenshots: data.capture?.evidence?.options?.max_screenshots || null,
      scroll_anchor_ok: Boolean(data.capture?.evidence?.scroll_anchor_plan?.ok),
      scroll_anchor_count: data.capture?.evidence?.scroll_anchor_plan?.anchor_count || 0,
      stop_boundary_action: data.capture?.evidence?.stop_boundary_result?.action || null,
      capture_viewport_values: Array.from(new Set(
        (data.capture?.evidence?.screenshots || []).map((item) => Boolean(item.capture_viewport))
      )),
      first_clip: data.capture?.evidence?.screenshots?.[0]?.clip || null,
      file_paths: data.capture?.evidence?.file_paths || [],
      safety_proof: data.capture?.safetyProof || null
    },
    chat_attempts: data.detail?.attempts || undefined,
    chat_content_wait: data.detail?.contentWait
      ? {
        ok: Boolean(data.detail.contentWait.ok),
        text_length: data.detail.contentWait.text_length || 0,
        error: data.detail.contentWait.error || null
      }
      : undefined
  };
}

async function runDomain(domain, options) {
  const session = await connectDomain(domain, options);
  try {
    const client = session.client;
    const frameResizeEvents = [];
    client.Page.frameResized(() => {
      frameResizeEvents.push({
        at: new Date().toISOString(),
        at_ms: Date.now(),
        connection_epoch: client.__connectionEpoch ?? null
      });
    });
    let detail = null;
    if (domain === "recommend") {
      detail = await ensureRecommendDetail(client);
    } else if (domain === "search") {
      detail = await ensureSearchDetail(client, options);
    } else if (domain === "chat") {
      detail = await ensureChatResume(client, options);
    } else {
      throw new Error(`Unsupported domain: ${domain}`);
    }
    const captureStartedAt = Date.now();
    const capture = await captureDomainCv(client, domain, detail.detailState, options);
    const captureEndedAt = Date.now();
    const screenshotCorrelatedFrameResizeEvents = frameResizeEvents.filter((event) => (
      event.at_ms >= captureStartedAt && event.at_ms <= captureEndedAt
    ));
    if (screenshotCorrelatedFrameResizeEvents.length > 0) {
      throw new Error(`${domain} emitted Page.frameResized during CV screenshot capture`);
    }
    const url = await getMainFrameUrl(client).catch(() => "");
    if (!capture.fullScrollDetected) {
      throw new Error(`${domain} capture reached max screenshots without end-of-CV detection`);
    }
    const methodProof = assertNoForbiddenCdpCalls(session.methodLog || []);
    const screenshotMethodSafety = verifyScreenshotMethodSafety(session.methodLog || []);
    if (!screenshotMethodSafety.ok) {
      throw new Error(`${domain} screenshot replay safety failed: ${JSON.stringify(screenshotMethodSafety.issues)}`);
    }
    const methodLogPath = path.join(options.outputDir, `${domain}-cdp-method-log.json`);
    fs.writeFileSync(methodLogPath, `${JSON.stringify(session.methodLog || [], null, 2)}\n`);
    return {
      ...summarizeResult(domain, { url, detail, capture }),
      safety: {
        ...methodProof,
        screenshot_method_count: (session.methodLog || []).filter((entry) => (
          String(entry?.method || "").replace(/:retry_after_reconnect$/, "") === "Page.captureScreenshot"
        )).length,
        screenshot_retry_count: (session.methodLog || []).filter((entry) => (
          entry?.method === "Page.captureScreenshot:retry_after_reconnect"
        )).length,
        browser_clip_used: Boolean(capture.evidence?.optimization?.browser_clip_used),
        capture_beyond_viewport: Boolean(capture.evidence?.optimization?.capture_beyond_viewport),
        frame_resize_event_count: frameResizeEvents.length,
        screenshot_correlated_frame_resize_event_count: screenshotCorrelatedFrameResizeEvents.length,
        screenshot_correlated_frame_resize_events: screenshotCorrelatedFrameResizeEvents,
        screenshot_method_safety: screenshotMethodSafety,
        method_log_path: methodLogPath
      }
    };
  } finally {
    if (domain === "recommend") {
      await closeRecommendDetail(session.client, { attemptsLimit: 2 }).catch(() => null);
    } else if (domain === "search") {
      await closeRecruitDetail(session.client, { attemptsLimit: 2 }).catch(() => null);
    } else if (domain === "chat") {
      await closeChatResumeModal(session.client, { attemptsLimit: 2 }).catch(() => null);
    }
    await session.close();
  }
}

async function main() {
  const options = parseArgs();
  ensureDir(options.outputDir);
  const results = [];
  for (const domain of options.domains) {
    const started = Date.now();
    try {
      const result = await runDomain(domain, options);
      result.elapsed_ms = Date.now() - started;
      results.push(result);
      console.log(`[${domain}] ok target=${result.target.selector} screenshots=${result.capture.screenshot_count} captures=${result.capture.capture_count}`);
    } catch (error) {
      const failure = {
        domain,
        ok: false,
        elapsed_ms: Date.now() - started,
        error: error?.message || String(error)
      };
      results.push(failure);
      console.error(`[${domain}] failed: ${failure.error}`);
    }
  }

  const summary = {
    ok: results.every((item) => item.ok),
    output_dir: options.outputDir,
    max_screenshots: options.maxScreenshots,
    model_boundary: {
      live_evaluated: false,
      status: "not_live_evaluated",
      fail_closed_unit_tested: true,
      unit_test_command: "npm run test:core-cv-acquisition"
    },
    results
  };
  const summaryPath = path.join(options.outputDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
