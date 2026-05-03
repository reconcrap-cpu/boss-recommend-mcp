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
  DETAIL_CLOSE_SELECTORS,
  DETAIL_NETWORK_PATTERNS,
  DETAIL_POPUP_SELECTORS,
  DETAIL_RESUME_IFRAME_SELECTORS
} from "./constants.js";
import {
  getRecommendRoots,
  queryFirstAcrossRoots
} from "./roots.js";

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
    const rootState = await getRecommendRoots(client);
    const popup = await queryFirstAcrossRoots(client, rootState.roots, DETAIL_POPUP_SELECTORS);
    const resumeIframe = await queryFirstAcrossRoots(client, rootState.roots, DETAIL_RESUME_IFRAME_SELECTORS);
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

export async function readRecommendDetailHtml(client, detailState) {
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

export async function openRecommendCardDetail(client, cardNodeId, {
  timeoutMs = 12000,
  scrollIntoView = true
} = {}) {
  const cardBox = await clickNodeCenter(client, cardNodeId, { scrollIntoView });
  const detailState = await waitForRecommendDetail(client, { timeoutMs });
  if (!detailState?.popup && !detailState?.resumeIframe) {
    throw new Error("Candidate detail did not open or no known detail selectors mounted");
  }

  return {
    card_box: cardBox,
    detail_state: detailState
  };
}

export async function closeRecommendDetail(client, {
  attemptsLimit = 3
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
      await sleep(700);
    } else {
      await pressEscape(client);
      attempts.push({ mode: "Escape" });
      await sleep(700);
    }

    let state = await waitForRecommendDetail(client, { timeoutMs: 1000 });
    if (!state?.popup && !state?.resumeIframe) {
      return {
        closed: true,
        attempts
      };
    }

    await pressEscape(client);
    attempts.push({ mode: "Escape-fallback" });
    await sleep(700);

    state = await waitForRecommendDetail(client, { timeoutMs: 1000 });
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

export async function extractRecommendDetailCandidate(client, {
  cardCandidate,
  cardNodeId,
  detailState,
  networkEvents = [],
  targetUrl = "",
  closeDetail = true
} = {}) {
  await sleep(1000);
  const networkBodies = await readRecommendDetailNetworkBodies(client, networkEvents);
  const detailHtml = await readRecommendDetailHtml(client, detailState);
  const detailText = [
    detailHtml.popupText,
    detailHtml.resumeText
  ].filter(Boolean).join("\n\n");

  const detailCandidateResult = buildScreeningCandidateFromDetail({
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

  let closeResult = null;
  if (closeDetail) {
    closeResult = await closeRecommendDetail(client);
  }

  return {
    candidate: detailCandidateResult.candidate,
    parsed_network_profiles: detailCandidateResult.parsed_network_profiles,
    network_bodies: networkBodies,
    detail: {
      popup_text: detailHtml.popupText,
      resume_text: detailHtml.resumeText,
      popup_html_length: detailHtml.popupHTML.length,
      resume_html_length: detailHtml.resumeHTML.length
    },
    close_result: closeResult
  };
}
