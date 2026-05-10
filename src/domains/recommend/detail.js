import {
  clickNodeCenter,
  clickPoint,
  getFrameDocumentNodeId,
  getNodeBox,
  getOuterHTML,
  pressKey,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import { candidateKeyFromProfile } from "../../core/infinite-list/index.js";
import {
  buildScreeningCandidateFromDetail,
  htmlToText
} from "../../core/screening/index.js";
import {
  DETAIL_CLOSE_SELECTORS,
  DETAIL_NETWORK_PATTERNS,
  DETAIL_POPUP_SELECTORS,
  DETAIL_RESUME_IFRAME_SELECTORS
} from "./constants.js";
import {
  getRecommendRoots
} from "./roots.js";
import {
  findRecommendCardNodeIds,
  readRecommendCardCandidate
} from "./cards.js";

export function matchesRecommendDetailNetwork(url) {
  return DETAIL_NETWORK_PATTERNS.some((pattern) => pattern.test(String(url || "")));
}

export function createRecommendDetailNetworkRecorder(client) {
  const events = [];
  client.Network.responseReceived((event) => {
    const url = event?.response?.url || "";
    if (!matchesRecommendDetailNetwork(url)) return;
    events.push({
      requestId: event.requestId,
      url,
      status: event.response?.status,
      mimeType: event.response?.mimeType,
      type: event.type
    });
  });
  if (typeof client.Network.loadingFinished === "function") {
    client.Network.loadingFinished((event) => {
      const found = events.find((item) => item.requestId === event.requestId);
      if (!found) return;
      found.loading_finished = true;
      found.encodedDataLength = event.encodedDataLength;
    });
  }
  if (typeof client.Network.loadingFailed === "function") {
    client.Network.loadingFailed((event) => {
      const found = events.find((item) => item.requestId === event.requestId);
      if (!found) return;
      found.loading_failed = true;
      found.loading_error = event.errorText || event.blockedReason || "Network loading failed";
    });
  }
  return {
    events,
    clear() {
      events.length = 0;
    }
  };
}

export async function waitForRecommendDetailNetworkEvents(recorder, {
  minCount = 1,
  requireLoaded = true,
  timeoutMs = 3500,
  intervalMs = 100
} = {}) {
  const started = Date.now();
  const events = Array.isArray(recorder) ? recorder : recorder?.events || [];
  let matching = [];
  while (Date.now() - started <= timeoutMs) {
    matching = events.filter((event) => (
      !requireLoaded
      || event.loading_finished === true
      || event.loading_failed === true
    ));
    if (matching.length >= minCount) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        count: matching.length,
        events: matching
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    count: matching.length,
    events: matching,
    total_event_count: events.length
  };
}

export async function readRecommendDetailNetworkBodies(client, events = [], {
  limit = 10
} = {}) {
  const bodies = [];
  for (const event of events.slice(0, limit)) {
    try {
      const body = await client.Network.getResponseBody({ requestId: event.requestId });
      bodies.push({
        ...event,
        body,
        body_length: String(body?.body || "").length
      });
    } catch (error) {
      bodies.push({
        ...event,
        body_error: error?.message || String(error)
      });
    }
  }
  return bodies;
}

export async function waitForRecommendDetail(client, {
  timeoutMs = 10000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    lastState = await readRecommendDetailState(client);
    if (lastState?.popup || lastState?.resumeIframe) return lastState;
    await sleep(intervalMs);
  }
  return lastState;
}

async function readRecommendDetailState(client) {
  const rootState = await getRecommendRoots(client);
  const popup = await findVisibleDetailTarget(client, rootState.roots, DETAIL_POPUP_SELECTORS);
  const resumeIframe = await findVisibleDetailTarget(client, rootState.roots, DETAIL_RESUME_IFRAME_SELECTORS);
  return {
    iframe: rootState.iframe,
    roots: rootState.roots,
    popup,
    resumeIframe
  };
}

export async function waitForRecommendDetailClosed(client, {
  timeoutMs = 4000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    lastState = await readRecommendDetailState(client);
    if (!lastState?.popup && !lastState?.resumeIframe) {
      return {
        closed: true,
        elapsed_ms: Date.now() - started,
        state: lastState
      };
    }
    await sleep(intervalMs);
  }
  return {
    closed: false,
    elapsed_ms: Date.now() - started,
    state: lastState
  };
}

async function findVisibleDetailTarget(client, roots, selectors) {
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      const nodeIds = await querySelectorAll(client, root.nodeId, selector);
      for (const nodeId of nodeIds) {
        try {
          const box = await getNodeBox(client, nodeId);
          if (box.rect.width > 2 && box.rect.height > 2) {
            return {
              root: root.name,
              root_node_id: root.nodeId,
              selector,
              node_id: nodeId,
              center: box.center,
              rect: box.rect
            };
          }
        } catch {}
      }
    }
  }
  return null;
}

export async function readRecommendDetailHtml(client, detailState) {
  let popupHTML = "";
  let resumeHTML = "";
  let resumeIframeDocumentNodeId = null;
  const errors = [];

  if (detailState?.popup?.node_id) {
    try {
      popupHTML = await getOuterHTML(client, detailState.popup.node_id);
    } catch (error) {
      errors.push({
        source: "popup",
        node_id: detailState.popup.node_id,
        stale_node: isStaleRecommendNodeError(error),
        error: error?.message || String(error)
      });
    }
  }

  if (detailState?.resumeIframe?.node_id) {
    try {
      resumeIframeDocumentNodeId = await getFrameDocumentNodeId(client, detailState.resumeIframe.node_id);
      resumeHTML = await getOuterHTML(client, resumeIframeDocumentNodeId);
    } catch (error) {
      errors.push({
        source: "resume_iframe",
        node_id: detailState.resumeIframe.node_id,
        document_node_id: resumeIframeDocumentNodeId,
        stale_node: isStaleRecommendNodeError(error),
        error: error?.message || String(error)
      });
      resumeIframeDocumentNodeId = null;
      resumeHTML = "";
    }
  }

  return {
    popupHTML,
    resumeHTML,
    resumeIframeDocumentNodeId,
    popupText: htmlToText(popupHTML),
    resumeText: htmlToText(resumeHTML),
    errors
  };
}

export function isStaleRecommendNodeError(error) {
  const message = String(error?.message || error || "");
  return /Could not find node with given id|No node with given id|Node is detached|Cannot find node/i.test(message);
}

export async function findRecommendCardNodeForCandidateKey(client, {
  candidateKey = "",
  rootState = null,
  targetUrl = "",
  source = "recommend-run-card-retry",
  timeoutMs = 5000,
  intervalMs = 250
} = {}) {
  if (!candidateKey) {
    return {
      ok: false,
      reason: "candidate_key_required"
    };
  }

  const started = Date.now();
  let lastError = null;
  let lastCardCount = 0;
  while (Date.now() - started <= timeoutMs) {
    const currentRootState = rootState?.iframe?.documentNodeId
      ? rootState
      : await getRecommendRoots(client);
    const frameNodeId = currentRootState?.iframe?.documentNodeId;
    if (!frameNodeId) {
      return {
        ok: false,
        reason: "recommend_frame_not_found"
      };
    }

    const nodeIds = await findRecommendCardNodeIds(client, frameNodeId);
    lastCardCount = nodeIds.length;
    for (let visibleIndex = 0; visibleIndex < nodeIds.length; visibleIndex += 1) {
      const nodeId = nodeIds[visibleIndex];
      try {
        const candidate = await readRecommendCardCandidate(client, nodeId, {
          targetUrl,
          source,
          metadata: {
            visible_index: visibleIndex,
            retry_reason: "stale_detail_node"
          }
        });
        const key = candidateKeyFromProfile(candidate, {
          nodeId,
          visibleIndex,
          attributes: candidate?.attributes || candidate?.metadata?.attributes || {}
        });
        if (key === candidateKey) {
          return {
            ok: true,
            node_id: nodeId,
            visible_index: visibleIndex,
            candidate,
            key,
            root_state: currentRootState,
            card_count: nodeIds.length
          };
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (intervalMs > 0) await sleep(intervalMs);
    rootState = null;
  }

  return {
    ok: false,
    reason: "candidate_key_not_mounted",
    candidate_key: candidateKey,
    last_card_count: lastCardCount,
    error: lastError?.message || null
  };
}

export async function openRecommendCardDetail(client, cardNodeId, {
  timeoutMs = 12000,
  scrollIntoView = true
} = {}) {
  const started = Date.now();
  const clickStarted = Date.now();
  const cardBox = await clickNodeCenter(client, cardNodeId, { scrollIntoView });
  const candidateClickMs = Date.now() - clickStarted;
  const detailStarted = Date.now();
  const detailState = await waitForRecommendDetail(client, { timeoutMs });
  const detailOpenMs = Date.now() - detailStarted;
  if (!detailState?.popup && !detailState?.resumeIframe) {
    throw new Error("Candidate detail did not open or no known detail selectors mounted");
  }

  return {
    card_box: cardBox,
    detail_state: detailState,
    timings: {
      candidate_click_ms: candidateClickMs,
      detail_open_ms: detailOpenMs,
      open_total_ms: Date.now() - started
    }
  };
}

export async function openRecommendCardDetailWithFreshRetry(client, {
  cardNodeId,
  candidateKey = "",
  cardCandidate = null,
  rootState = null,
  targetUrl = "",
  timeoutMs = 12000,
  scrollIntoView = true,
  retryTimeoutMs = 5000,
  retryIntervalMs = 250,
  maxAttempts = 2
} = {}) {
  let currentNodeId = cardNodeId;
  let currentCandidate = cardCandidate;
  let currentRootState = rootState;
  const attempts = [];
  const limit = Math.max(1, Number(maxAttempts) || 1);

  for (let attemptIndex = 0; attemptIndex < limit; attemptIndex += 1) {
    try {
      const opened = await openRecommendCardDetail(client, currentNodeId, {
        timeoutMs,
        scrollIntoView
      });
      return {
        ...opened,
        card_node_id: currentNodeId,
        card_candidate: currentCandidate,
        retry_attempts: attempts
      };
    } catch (error) {
      const stale = isStaleRecommendNodeError(error);
      attempts.push({
        attempt: attemptIndex + 1,
        node_id: currentNodeId,
        stale_node: stale,
        error: error?.message || String(error)
      });
      if (!stale || attemptIndex >= limit - 1 || !candidateKey) {
        error.recommend_detail_open_attempts = attempts;
        throw error;
      }

      const resolved = await findRecommendCardNodeForCandidateKey(client, {
        candidateKey,
        rootState: currentRootState,
        targetUrl,
        timeoutMs: retryTimeoutMs,
        intervalMs: retryIntervalMs
      });
      attempts[attempts.length - 1].refresh_lookup = {
        ok: Boolean(resolved.ok),
        node_id: resolved.node_id || null,
        visible_index: resolved.visible_index ?? null,
        card_count: resolved.card_count || resolved.last_card_count || 0,
        reason: resolved.reason || null,
        error: resolved.error || null
      };
      if (!resolved.ok || !resolved.node_id) {
        error.recommend_detail_open_attempts = attempts;
        throw error;
      }
      currentNodeId = resolved.node_id;
      currentCandidate = resolved.candidate || currentCandidate;
      currentRootState = resolved.root_state || null;
    }
  }

  throw new Error("Recommend detail retry exhausted");
}

export async function closeRecommendDetail(client, {
  attemptsLimit = 4,
  closeWaitMs = 5000,
  escapeWaitMs = 3500
} = {}) {
  const attempts = [];
  for (let index = 0; index < attemptsLimit; index += 1) {
    const existingState = await waitForRecommendDetail(client, { timeoutMs: 500 });
    if (!existingState?.popup && !existingState?.resumeIframe) {
      return {
        closed: true,
        attempts
      };
    }

    const rootState = await getRecommendRoots(client);
    const closeTarget = await findVisibleCloseTarget(client, rootState.roots, DETAIL_CLOSE_SELECTORS);
    if (closeTarget) {
      try {
        if (closeTarget.center) {
          await clickPoint(client, closeTarget.center.x, closeTarget.center.y);
        } else {
          await clickNodeCenter(client, closeTarget.node_id);
        }
        attempts.push({
          mode: "close-selector",
          selector: closeTarget.selector,
          root: closeTarget.root
        });
      } catch (error) {
        attempts.push({
          mode: "close-selector-error",
          selector: closeTarget.selector,
          root: closeTarget.root,
          error: error?.message || String(error)
        });
        await pressEscape(client);
        attempts.push({ mode: "Escape-after-close-selector-error" });
      }
    } else {
      await pressEscape(client);
      attempts.push({ mode: "Escape" });
    }

    const closedAfterClick = await waitForRecommendDetailClosed(client, {
      timeoutMs: closeWaitMs,
      intervalMs: 250
    });
    attempts.push({
      mode: "wait-closed-after-primary",
      closed: closedAfterClick.closed,
      elapsed_ms: closedAfterClick.elapsed_ms
    });
    if (closedAfterClick.closed) {
      return {
        closed: true,
        attempts
      };
    }

    await pressEscape(client);
    attempts.push({ mode: "Escape-fallback" });

    const closedAfterEscape = await waitForRecommendDetailClosed(client, {
      timeoutMs: escapeWaitMs,
      intervalMs: 250
    });
    attempts.push({
      mode: "wait-closed-after-escape",
      closed: closedAfterEscape.closed,
      elapsed_ms: closedAfterEscape.elapsed_ms
    });
    if (closedAfterEscape.closed) {
      return {
        closed: true,
        attempts
      };
    }
  }

  return {
    closed: false,
    attempts
  };
}

async function findVisibleCloseTarget(client, roots, selectors) {
  let fallback = null;
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      const nodeIds = await querySelectorAll(client, root.nodeId, selector);
      for (const nodeId of nodeIds) {
        const target = {
          root: root.name,
          root_node_id: root.nodeId,
          selector,
          node_id: nodeId
        };
        if (!fallback) fallback = target;
        try {
          const box = await getNodeBox(client, nodeId);
          if (box.rect.width > 2 && box.rect.height > 2) {
            return {
              ...target,
              center: box.center,
              rect: box.rect
            };
          }
        } catch {}
      }
    }
  }
  return fallback;
}

async function pressEscape(client) {
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
}

export async function extractRecommendDetailCandidate(client, {
  cardCandidate,
  cardNodeId,
  detailState,
  networkEvents = [],
  targetUrl = "",
  closeDetail = true,
  networkParseRetryMs = 1800,
  networkParseIntervalMs = 250
} = {}) {
  const detailHtml = await readRecommendDetailHtml(client, detailState);
  const detailText = [
    detailHtml.popupText,
    detailHtml.resumeText
  ].filter(Boolean).join("\n\n");

  const parseStarted = Date.now();
  let networkBodies = [];
  let detailCandidateResult = null;
  do {
    networkBodies = await readRecommendDetailNetworkBodies(client, networkEvents);
    detailCandidateResult = buildScreeningCandidateFromDetail({
      cardCandidate,
      detailText,
      networkBodies,
      metadata: {
        target_url: targetUrl,
        card_node_id: cardNodeId,
        detail_popup_selector: detailState?.popup?.selector || null,
        detail_popup_root: detailState?.popup?.root || null,
        resume_iframe_selector: detailState?.resumeIframe?.selector || null,
        resume_iframe_root: detailState?.resumeIframe?.root || null,
        resume_iframe_document_node_id: detailHtml.resumeIframeDocumentNodeId,
        detail_html_errors: detailHtml.errors || []
      }
    });
    if (detailCandidateResult.parsed_network_profiles.some((item) => item.ok)) break;
    if (Date.now() - parseStarted >= Math.max(0, Number(networkParseRetryMs) || 0)) break;
    await sleep(Math.max(50, Number(networkParseIntervalMs) || 250));
  } while (true);

  let closeResult = null;
  if (closeDetail) {
    closeResult = await closeRecommendDetail(client);
  }

  return {
    candidate: detailCandidateResult.candidate,
    parsed_network_profiles: detailCandidateResult.parsed_network_profiles,
    network_bodies: networkBodies,
    network_parse_retry_elapsed_ms: Date.now() - parseStarted,
    network_event_count: networkEvents.length,
    detail: {
      popup_text: detailHtml.popupText,
      resume_text: detailHtml.resumeText,
      popup_html_length: detailHtml.popupHTML.length,
      resume_html_length: detailHtml.resumeHTML.length,
      html_errors: detailHtml.errors || []
    },
    close_result: closeResult
  };
}
