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
import {
  buildScreeningCandidateFromDetail,
  htmlToText
} from "../../core/screening/index.js";
import {
  RECRUIT_DETAIL_CLOSE_SELECTORS,
  RECRUIT_DETAIL_NETWORK_PATTERNS,
  RECRUIT_DETAIL_POPUP_SELECTORS,
  RECRUIT_DETAIL_RESUME_IFRAME_SELECTORS
} from "./constants.js";
import {
  getRecruitRoots,
  queryFirstAcrossRoots
} from "./roots.js";

export function matchesRecruitDetailNetwork(url) {
  return RECRUIT_DETAIL_NETWORK_PATTERNS.some((pattern) => pattern.test(String(url || "")));
}

export function createRecruitDetailNetworkRecorder(client) {
  const events = [];
  client.Network.responseReceived((event) => {
    const url = event?.response?.url || "";
    if (!matchesRecruitDetailNetwork(url)) return;
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

export async function waitForRecruitDetailNetworkEvents(recorder, {
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

export async function readRecruitDetailNetworkBodies(client, events = [], {
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

export async function waitForRecruitDetail(client, {
  timeoutMs = 12000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    const rootState = await getRecruitRoots(client);
    const popup = await queryFirstAcrossRoots(client, rootState.roots, RECRUIT_DETAIL_POPUP_SELECTORS);
    const resumeIframe = await queryFirstAcrossRoots(client, rootState.roots, RECRUIT_DETAIL_RESUME_IFRAME_SELECTORS);
    lastState = {
      iframe: rootState.iframe,
      roots: rootState.roots,
      popup,
      resumeIframe
    };
    if (popup || resumeIframe) return lastState;
    await sleep(intervalMs);
  }
  return lastState;
}

export async function readRecruitDetailHtml(client, detailState) {
  let popupHTML = "";
  let resumeHTML = "";
  let resumeIframeDocumentNodeId = null;

  if (detailState?.popup?.node_id) {
    popupHTML = await getOuterHTML(client, detailState.popup.node_id);
  }

  if (detailState?.resumeIframe?.node_id) {
    resumeIframeDocumentNodeId = await getFrameDocumentNodeId(client, detailState.resumeIframe.node_id);
    resumeHTML = await getOuterHTML(client, resumeIframeDocumentNodeId);
  }

  return {
    popupHTML,
    resumeHTML,
    resumeIframeDocumentNodeId,
    popupText: htmlToText(popupHTML),
    resumeText: htmlToText(resumeHTML)
  };
}

export async function waitForRecruitDetailContent(client, {
  minTextLength = 200,
  timeoutMs = 6000,
  intervalMs = 200
} = {}) {
  const started = Date.now();
  let lastState = null;
  let lastHtml = null;
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      lastState = await waitForRecruitDetail(client, {
        timeoutMs: 500,
        intervalMs: 100
      });
      if (lastState?.popup || lastState?.resumeIframe) {
        lastHtml = await readRecruitDetailHtml(client, lastState);
        const textLength = (lastHtml.popupText || "").length + (lastHtml.resumeText || "").length;
        if (textLength >= minTextLength) {
          return {
            ok: true,
            elapsed_ms: Date.now() - started,
            text_length: textLength,
            detail_state: lastState,
            detail_html: lastHtml
          };
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const textLength = (lastHtml?.popupText || "").length + (lastHtml?.resumeText || "").length;
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    text_length: textLength,
    detail_state: lastState,
    detail_html: lastHtml,
    error: lastError?.message || null
  };
}

export async function openRecruitCardDetail(client, cardNodeId, {
  timeoutMs = 12000
} = {}) {
  const openedStarted = Date.now();
  const attempts = [];
  const clickStarted = Date.now();
  const cardBox = await clickNodeCenter(client, cardNodeId, {
    scrollIntoView: true
  });
  let candidateClickMs = Date.now() - clickStarted;
  attempts.push({
    mode: "card-center",
    center: cardBox.center
  });
  const detailStarted = Date.now();
  let detailState = await waitForRecruitDetail(client, { timeoutMs });

  if (!detailState?.popup && !detailState?.resumeIframe) {
    const fallbackClickStarted = Date.now();
    const leftTitlePoint = {
      x: cardBox.rect.x + Math.min(140, Math.max(40, cardBox.rect.width * 0.2)),
      y: cardBox.rect.y + Math.min(42, Math.max(24, cardBox.rect.height * 0.28))
    };
    await clickPoint(client, leftTitlePoint.x, leftTitlePoint.y, {
      clickCount: 2,
      delayMs: 120
    });
    candidateClickMs += Date.now() - fallbackClickStarted;
    attempts.push({
      mode: "card-left-title-double-click",
      center: leftTitlePoint
    });
    detailState = await waitForRecruitDetail(client, {
      timeoutMs: Math.max(3000, Math.floor(timeoutMs / 2))
    });
  }

  if (!detailState?.popup && !detailState?.resumeIframe) {
    throw new Error("Recruit candidate detail did not open or no known detail selectors mounted");
  }

  return {
    card_box: cardBox,
    open_attempts: attempts,
    detail_state: detailState,
    timings: {
      candidate_click_ms: candidateClickMs,
      detail_open_ms: Date.now() - detailStarted,
      open_total_ms: Date.now() - openedStarted
    }
  };
}

export async function closeRecruitDetail(client, {
  attemptsLimit = 3
} = {}) {
  const attempts = [];
  for (let index = 0; index < attemptsLimit; index += 1) {
    const existingState = await waitForRecruitDetail(client, { timeoutMs: 500 });
    if (!existingState?.popup && !existingState?.resumeIframe) {
      return {
        closed: true,
        attempts
      };
    }

    const rootState = await getRecruitRoots(client);
    const closeTarget = await findVisibleCloseTarget(client, rootState.roots, RECRUIT_DETAIL_CLOSE_SELECTORS);
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
      await sleep(700);
    } else {
      await pressEscape(client);
      attempts.push({ mode: "Escape" });
      await sleep(700);
    }

    let state = await waitForRecruitDetail(client, { timeoutMs: 1000 });
    if (!state?.popup && !state?.resumeIframe) {
      return {
        closed: true,
        attempts
      };
    }

    await pressEscape(client);
    attempts.push({ mode: "Escape-fallback" });
    await sleep(700);

    state = await waitForRecruitDetail(client, { timeoutMs: 1000 });
    if (!state?.popup && !state?.resumeIframe) {
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

export async function extractRecruitDetailCandidate(client, {
  cardCandidate,
  cardNodeId,
  detailState,
  detailHtml: providedDetailHtml = null,
  networkEvents = [],
  targetUrl = "",
  closeDetail = true,
  networkParseRetryMs = 1800,
  networkParseIntervalMs = 250
} = {}) {
  const detailHtml = providedDetailHtml || await readRecruitDetailHtml(client, detailState);
  const detailText = [
    detailHtml.popupText,
    detailHtml.resumeText
  ].filter(Boolean).join("\n\n");

  const parseStarted = Date.now();
  let networkBodies = [];
  let detailCandidateResult = null;
  do {
    networkBodies = await readRecruitDetailNetworkBodies(client, networkEvents);
    detailCandidateResult = buildScreeningCandidateFromDetail({
      domain: "recruit",
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
        resume_iframe_document_node_id: detailHtml.resumeIframeDocumentNodeId
      }
    });
    if (detailCandidateResult.parsed_network_profiles.some((item) => item.ok)) break;
    if (Date.now() - parseStarted >= Math.max(0, Number(networkParseRetryMs) || 0)) break;
    await sleep(Math.max(50, Number(networkParseIntervalMs) || 250));
  } while (true);

  let closeResult = null;
  if (closeDetail) {
    closeResult = await closeRecruitDetail(client);
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
      resume_html_length: detailHtml.resumeHTML.length
    },
    close_result: closeResult
  };
}
