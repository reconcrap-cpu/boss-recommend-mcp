#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  bringPageToFront,
  clickNodeCenter,
  connectToChromeTarget,
  enableDomains,
  findIframeDocument,
  getAttributesMap,
  getDocumentRoot,
  getFrameDocumentNodeId,
  getOuterHTML,
  pressKey,
  querySelector,
  querySelectorAll,
  sleep
} from "../src/core/browser/index.js";
import {
  captureNodeHtml,
  captureScrolledNodeScreenshots
} from "../src/core/capture/index.js";
import {
  compactCvAcquisitionState,
  countParsedNetworkProfiles,
  createCvAcquisitionState,
  getCvNetworkWaitPlan,
  recordCvImageFallback,
  recordCvNetworkHit,
  recordCvNetworkMiss,
  summarizeImageEvidence,
  waitForCvNetworkEvents
} from "../src/core/cv-acquisition/index.js";
import {
  buildScreeningCandidateFromDetail,
  callScreeningLlm,
  htmlToText,
  normalizeCandidateFromHtml,
  screenCandidate
} from "../src/core/screening/index.js";

const RECOMMEND_TARGET_URL = "https://www.zhipin.com/web/chat/recommend";
const RECOMMEND_IFRAME_SELECTORS = [
  'iframe[name="recommendFrame"]',
  'iframe[src*="/web/frame/recommend/"]',
  "iframe"
];
const RECOMMEND_CARD_SELECTOR = [
  ".candidate-card-wrap .card-inner[data-geek]",
  ".candidate-card-wrap [data-geek]",
  "li.geek-info-card a[data-geekid]",
  "a[data-geekid]"
].join(", ");
const DETAIL_POPUP_SELECTORS = [
  ".dialog-wrap.active",
  ".boss-popup__wrapper",
  ".boss-popup_wrapper",
  ".boss-dialog_wrapper",
  ".boss-dialog",
  ".resume-item-detail",
  ".geek-detail-modal",
  '[class*="popup"][class*="wrapper"]',
  '[class*="dialog"][class*="wrapper"]'
];
const DETAIL_RESUME_IFRAME_SELECTORS = [
  'iframe[src*="/web/frame/c-resume/"]',
  'iframe[name*="resume"]'
];
const DETAIL_CLOSE_SELECTORS = [
  ".boss-popup__close",
  ".popup-close",
  ".modal-close",
  ".dialog-close",
  ".close-btn",
  'button[aria-label*="关闭"]',
  'button[title*="关闭"]',
  ".icon-close",
  '[aria-label*="关闭"]',
  '[title*="关闭"]',
  '[class*="close"]'
];
const NETWORK_DETAIL_PATTERNS = [
  /\/wapi\/zpjob\/view\/geek\/info\b/i,
  /\/wapi\/zpitem\/web\/boss\/[^?#]*\/geek\/info\b/i,
  /\/boss\/[^?#]*\/geek\/info\b/i,
  /\/geek\/info\b/i,
  /\/web\/frame\/c-resume\//i,
  /resume/i
];

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECOMMEND_TARGET_URL,
    criteria: "",
    savePayload: ".live-artifacts/recommend-first-card-detail-payload.json",
    detailSource: "cascade",
    saveImage: "",
    closeDetail: true,
    callLlm: false,
    configPath: path.join(process.env.USERPROFILE || "C:\\Users\\yaolin", ".boss-recommend-mcp", "screening-config.json"),
    maxImagePages: 8,
    imageWheelDeltaY: 650,
    cvAcquisitionMode: "unknown",
    networkWaitMs: 4200,
    networkRetryWaitMs: 2000,
    imageModeGraceMs: 1000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--save-payload") result.savePayload = argv[++index];
    if (arg === "--detail-source") result.detailSource = argv[++index];
    if (arg === "--save-image") result.saveImage = argv[++index];
    if (arg === "--leave-detail-open") result.closeDetail = false;
    if (arg === "--call-llm") result.callLlm = true;
    if (arg === "--config") result.configPath = argv[++index];
    if (arg === "--max-image-pages") result.maxImagePages = parsePositiveInt(argv[++index], result.maxImagePages);
    if (arg === "--image-wheel-delta-y") {
      result.imageWheelDeltaY = parsePositiveInt(argv[++index], result.imageWheelDeltaY);
    }
    if (arg === "--cv-acquisition-mode") result.cvAcquisitionMode = argv[++index];
    if (arg === "--network-wait-ms") result.networkWaitMs = parsePositiveInt(argv[++index], result.networkWaitMs);
    if (arg === "--network-retry-wait-ms") {
      result.networkRetryWaitMs = parsePositiveInt(argv[++index], result.networkRetryWaitMs);
    }
    if (arg === "--image-mode-grace-ms") {
      result.imageModeGraceMs = parsePositiveInt(argv[++index], result.imageModeGraceMs);
    }
  }
  const validSources = new Set(["cascade", "network", "dom", "image"]);
  if (!validSources.has(result.detailSource)) {
    throw new Error(`Unsupported --detail-source: ${result.detailSource}`);
  }
  return result;
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function defaultImagePathForPayload(payloadPath) {
  const resolved = path.resolve(payloadPath || ".live-artifacts/recommend-detail-image-fallback.json");
  const parsed = path.parse(resolved);
  return path.join(parsed.dir, `${parsed.name}.png`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function redactIdentity(identity = {}) {
  return {
    ...identity,
    name: identity?.name ? "[redacted]" : null
  };
}

function matchesDetailNetwork(url) {
  return NETWORK_DETAIL_PATTERNS.some((pattern) => pattern.test(String(url || "")));
}

async function queryFirstAcrossRoots(client, roots, selectors) {
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      const nodeId = await querySelector(client, root.nodeId, selector);
      if (nodeId) {
        return {
          root: root.name,
          root_node_id: root.nodeId,
          selector,
          node_id: nodeId
        };
      }
    }
  }
  return null;
}

async function getRecommendRoots(client) {
  const topRoot = await getDocumentRoot(client);
  const iframe = await findIframeDocument(client, topRoot.nodeId, RECOMMEND_IFRAME_SELECTORS);
  if (!iframe) throw new Error("recommendFrame iframe was not found");
  return {
    topRoot,
    iframe,
    roots: [
      { name: "top", nodeId: topRoot.nodeId },
      { name: "recommend-frame", nodeId: iframe.documentNodeId }
    ]
  };
}

async function waitForDetail(client, timeoutMs = 10000) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    const rootState = await getRecommendRoots(client);
    const popup = await queryFirstAcrossRoots(client, rootState.roots, DETAIL_POPUP_SELECTORS);
    const resumeIframe = await queryFirstAcrossRoots(client, rootState.roots, DETAIL_RESUME_IFRAME_SELECTORS);
    lastState = {
      iframe: rootState.iframe,
      popup,
      resumeIframe
    };
    if (popup || resumeIframe) return lastState;
    await sleep(250);
  }
  return lastState;
}

async function closeDetail(client) {
  const attempts = [];
  for (let index = 0; index < 3; index += 1) {
    const rootState = await getRecommendRoots(client);
    const closeTarget = await queryFirstAcrossRoots(client, rootState.roots, DETAIL_CLOSE_SELECTORS);
    if (closeTarget) {
      await clickNodeCenter(client, closeTarget.node_id);
      attempts.push({ mode: "close-selector", selector: closeTarget.selector, root: closeTarget.root });
      await sleep(700);
    } else {
      await pressKey(client, "Escape", {
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27
      });
      attempts.push({ mode: "Escape" });
      await sleep(700);
    }
    const state = await waitForDetail(client, 1000);
    if (!state?.popup && !state?.resumeIframe) {
      return { closed: true, attempts };
    }
  }
  return { closed: false, attempts };
}

async function readDetailHtml(client, detailState) {
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
    resumeIframeDocumentNodeId
  };
}

async function waitForRecordedNetworkEvents(events, {
  minCount = 1,
  requireLoaded = true,
  timeoutMs = 3500,
  intervalMs = 100
} = {}) {
  const started = Date.now();
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

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let session;
  const networkEvents = [];
  const networkBodies = [];
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    }
  };

  try {
    session = await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes: options.targetUrlIncludes
    });
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };
    result.runtime_guard_probe = await assertRuntimeEvaluateBlocked(client);

    await enableDomains(client, ["Page", "DOM", "Input", "Network"]);
    client.Network.responseReceived((event) => {
      const url = event?.response?.url || "";
      if (matchesDetailNetwork(url)) {
        networkEvents.push({
          requestId: event.requestId,
          url,
          status: event.response?.status,
          mimeType: event.response?.mimeType
        });
      }
    });
    client.Network.loadingFinished((event) => {
      const found = networkEvents.find((item) => item.requestId === event.requestId);
      if (!found) return;
      found.loading_finished = true;
      found.encodedDataLength = event.encodedDataLength;
    });
    client.Network.loadingFailed((event) => {
      const found = networkEvents.find((item) => item.requestId === event.requestId);
      if (!found) return;
      found.loading_failed = true;
      found.loading_error = event.errorText || event.blockedReason || "Network loading failed";
    });
    await bringPageToFront(client);

    await pressKey(client, "Escape", {
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    });
    await sleep(300);

    const rootState = await getRecommendRoots(client);
    const cardNodeIds = await querySelectorAll(client, rootState.iframe.documentNodeId, RECOMMEND_CARD_SELECTOR);
    if (!cardNodeIds.length) throw new Error("No recommend candidate cards found");

    const firstCardNodeId = cardNodeIds[0];
    const [cardAttributes, cardHTML] = await Promise.all([
      getAttributesMap(client, firstCardNodeId),
      getOuterHTML(client, firstCardNodeId)
    ]);
    const cardCandidate = normalizeCandidateFromHtml({
      domain: "recommend",
      source: "live-cdp-card",
      html: cardHTML,
      attributes: cardAttributes,
      metadata: {
        target_url: target.url,
        card_node_id: firstCardNodeId
      }
    });

    await clickNodeCenter(client, firstCardNodeId);
    const detailState = await waitForDetail(client, 12000);
    if (!detailState?.popup && !detailState?.resumeIframe) {
      throw new Error("Candidate detail did not open or no known detail selectors mounted");
    }

    const cvAcquisitionState = createCvAcquisitionState({ mode: options.cvAcquisitionMode });
    const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState, {
      networkWaitMs: options.networkWaitMs,
      networkRetryWaitMs: options.networkRetryWaitMs,
      imageModeGraceMs: options.imageModeGraceMs
    });
    const networkWait = ["network", "cascade"].includes(options.detailSource)
      ? await waitForCvNetworkEvents(waitForRecordedNetworkEvents, networkEvents, {
          waitPlan,
          minCount: 1,
          requireLoaded: true,
          intervalMs: 120
        })
      : null;
    for (const event of networkEvents.slice(0, 10)) {
      try {
        const body = await client.Network.getResponseBody({ requestId: event.requestId });
        networkBodies.push({
          ...event,
          body,
          body_length: String(body?.body || "").length
        });
      } catch (error) {
        networkBodies.push({
          ...event,
          body_error: error?.message || String(error)
        });
      }
    }

    const detailHtml = await readDetailHtml(client, detailState);
    const detailText = [
      htmlToText(detailHtml.popupHTML),
      htmlToText(detailHtml.resumeHTML)
    ].filter(Boolean).join("\n\n");
    const captureNodeId = detailState?.popup?.node_id || detailState?.resumeIframe?.node_id || null;
    let domEvidence = null;
    if (captureNodeId && (options.detailSource === "dom" || options.detailSource === "cascade")) {
      domEvidence = await captureNodeHtml(client, captureNodeId, {
        domain: "recommend",
        source: "live-cdp-detail-dom",
        metadata: {
          detail_popup_selector: detailState.popup?.selector || null,
          resume_iframe_selector: detailState.resumeIframe?.selector || null
        }
      });
    }
    let imageEvidence = null;
    if (captureNodeId && options.detailSource === "image") {
      imageEvidence = await captureScrolledNodeScreenshots(client, captureNodeId, {
        filePath: options.saveImage || defaultImagePathForPayload(options.savePayload),
        padding: 4,
        maxScreenshots: options.maxImagePages,
        wheelDeltaY: options.imageWheelDeltaY,
        settleMs: 1200,
        metadata: {
          domain: "recommend",
          capture_mode: "scroll_sequence",
          detail_popup_selector: detailState.popup?.selector || null,
          resume_iframe_selector: detailState.resumeIframe?.selector || null
        }
      });
    }
    let effectiveDetailSource = options.detailSource;
    let networkBodiesForCandidate = (options.detailSource === "dom" || options.detailSource === "image")
      ? []
      : networkBodies;
    let detailTextForCandidate = (options.detailSource === "network" || options.detailSource === "image")
      ? ""
      : detailText;
    let detailCandidateResult = buildScreeningCandidateFromDetail({
      cardCandidate,
      detailText: detailTextForCandidate,
      networkBodies: networkBodiesForCandidate,
      metadata: {
        target_url: target.url,
        card_node_id: firstCardNodeId,
        detail_source: options.detailSource,
        detail_popup_selector: detailState.popup?.selector || null,
        detail_popup_root: detailState.popup?.root || null,
        resume_iframe_selector: detailState.resumeIframe?.selector || null,
        resume_iframe_root: detailState.resumeIframe?.root || null,
        resume_iframe_document_node_id: detailHtml.resumeIframeDocumentNodeId
      }
    });
    let parsedNetworkProfileCount = countParsedNetworkProfiles(detailCandidateResult);
    if (options.detailSource === "cascade") {
      if (parsedNetworkProfileCount > 0) {
        effectiveDetailSource = "network";
        detailTextForCandidate = "";
      } else {
        effectiveDetailSource = "image";
        detailTextForCandidate = "";
        networkBodiesForCandidate = [];
        if (captureNodeId) {
          imageEvidence = await captureScrolledNodeScreenshots(client, captureNodeId, {
            filePath: options.saveImage || defaultImagePathForPayload(options.savePayload),
            padding: 4,
            maxScreenshots: options.maxImagePages,
            wheelDeltaY: options.imageWheelDeltaY,
            settleMs: 1200,
            metadata: {
              domain: "recommend",
              capture_mode: "scroll_sequence",
              acquisition_reason: "network_miss_image_fallback",
              detail_popup_selector: detailState.popup?.selector || null,
              resume_iframe_selector: detailState.resumeIframe?.selector || null
            }
          });
        }
      }
      detailCandidateResult = buildScreeningCandidateFromDetail({
        cardCandidate,
        detailText: detailTextForCandidate,
        networkBodies: networkBodiesForCandidate,
        metadata: {
          target_url: target.url,
          card_node_id: firstCardNodeId,
          detail_source: effectiveDetailSource,
          detail_popup_selector: detailState.popup?.selector || null,
          detail_popup_root: detailState.popup?.root || null,
          resume_iframe_selector: detailState.resumeIframe?.selector || null,
          resume_iframe_root: detailState.resumeIframe?.root || null,
          resume_iframe_document_node_id: detailHtml.resumeIframeDocumentNodeId
        }
      });
      parsedNetworkProfileCount = countParsedNetworkProfiles(detailCandidateResult);
    }
    if (effectiveDetailSource === "image" && imageEvidence) {
      recordCvImageFallback(cvAcquisitionState, {
        parsedNetworkProfileCount,
        waitResult: networkWait,
        imageEvidence
      });
    } else if (parsedNetworkProfileCount > 0) {
      recordCvNetworkHit(cvAcquisitionState, {
        parsedNetworkProfileCount,
        waitResult: networkWait
      });
    } else {
      recordCvNetworkMiss(cvAcquisitionState, {
        reason: "network_miss_without_image_evidence",
        parsedNetworkProfileCount,
        waitResult: networkWait
      });
    }
    const combinedCandidate = detailCandidateResult.candidate;
    const screening = screenCandidate(combinedCandidate, {
      criteria: options.criteria
    });
    let llmScreening = null;
    if (options.callLlm) {
      const config = readJsonFile(options.configPath);
      llmScreening = await callScreeningLlm({
        candidate: combinedCandidate,
        criteria: options.criteria,
        config,
        timeoutMs: Number(config.llmTimeoutMs || 120000),
        imageEvidence: effectiveDetailSource === "image" ? imageEvidence : null,
        maxImages: options.maxImagePages,
        imageDetail: "high"
      });
    }

    if (options.detailSource === "network" && parsedNetworkProfileCount === 0) {
      throw new Error("Forced network extraction did not produce a parsed Boss profile");
    }
    if (options.detailSource === "dom" && !detailTextForCandidate) {
      throw new Error("Forced DOM extraction did not produce detail text");
    }
    if (effectiveDetailSource === "image") {
      const uniqueCount = imageEvidence?.unique_screenshot_count || 0;
      if (uniqueCount < 2) {
        throw new Error(`Forced recommend image extraction did not produce full-CV scroll evidence (unique=${uniqueCount})`);
      }
    }
    if (options.detailSource === "cascade" && parsedNetworkProfileCount === 0 && !imageEvidence) {
      throw new Error("Detail opened, but neither Network CV nor full-CV image fallback was extracted");
    }

    let closeResult = null;
    if (options.closeDetail) {
      closeResult = await closeDetail(client);
    }

    assertNoForbiddenCdpCalls(methodLog);

    let savedPayloadPath = null;
    if (options.savePayload) {
      savedPayloadPath = writeJsonFile(options.savePayload, {
        generated_at: new Date().toISOString(),
        note: "Unredacted local artifact. This is the first-card detail payload intended for screening/LLM input review.",
        chrome: {
          target_url: target.url,
          target_title: target.title
        },
        extraction: {
          domain: "recommend",
          source: "live-cdp-detail",
          detail_source: effectiveDetailSource,
          requested_detail_source: options.detailSource,
          cv_acquisition: {
            state: compactCvAcquisitionState(cvAcquisitionState),
            wait_plan: waitPlan,
            network_wait: networkWait,
            image_evidence: summarizeImageEvidence(imageEvidence)
          },
          iframe_selector: rootState.iframe.selector,
          card_selector: RECOMMEND_CARD_SELECTOR,
          first_card_node_id: firstCardNodeId,
          card_count: cardNodeIds.length,
          detail_state: {
            popup: detailState.popup,
            resumeIframe: detailState.resumeIframe
          },
          close_result: closeResult,
          cdp_methods: methodLog.map((entry) => entry.method)
        },
        capture: {
          dom_evidence: domEvidence
            ? {
              ...domEvidence,
              outer_html: undefined
            }
            : null,
          image_evidence: imageEvidence
        },
        card_candidate: cardCandidate,
        detail: {
          popup_text: htmlToText(detailHtml.popupHTML),
          resume_text: htmlToText(detailHtml.resumeHTML),
          popup_html_length: detailHtml.popupHTML.length,
          resume_html_length: detailHtml.resumeHTML.length
        },
        parsed_network_profiles: detailCandidateResult.parsed_network_profiles,
        network_bodies: networkBodies,
        llm_screening_payload: {
          schema_version: 1,
          criteria: options.criteria,
          candidate: combinedCandidate
        },
        deterministic_screening_result: screening,
        llm_screening_result: llmScreening
      });
    }

    result.status = "PASS";
    result.runtime_evaluate_used = false;
    result.recommend = {
      detail_source: effectiveDetailSource,
      requested_detail_source: options.detailSource,
      cv_acquisition: {
        state: compactCvAcquisitionState(cvAcquisitionState),
        wait_plan: waitPlan,
        network_wait: networkWait,
        image_evidence: summarizeImageEvidence(imageEvidence)
      },
      card_count: cardNodeIds.length,
      first_card_node_id: firstCardNodeId,
      detail_opened: true,
      detail_popup_found: Boolean(detailState.popup),
      resume_iframe_found: Boolean(detailState.resumeIframe),
      detail_text_length: detailText.length,
      forced_detail_text_length: detailTextForCandidate.length,
      network_detail_event_count: networkEvents.length,
      network_body_count: networkBodies.filter((item) => item.body).length,
      parsed_network_profile_count: parsedNetworkProfileCount,
      parsed_network_profile_source_keys: detailCandidateResult.parsed_network_profiles
        .filter((item) => item.ok)
        .map((item) => item.profile?.source_keys || null),
      dom_evidence: domEvidence
        ? {
          text_length: domEvidence.text_length,
          outer_html_length: domEvidence.outer_html_length
        }
        : null,
      image_evidence: imageEvidence
        ? {
          source: imageEvidence.source,
          screenshot_count: imageEvidence.screenshot_count,
          unique_screenshot_count: imageEvidence.unique_screenshot_count,
          file_paths: imageEvidence.file_paths,
          first_clip: imageEvidence.screenshots?.[0]?.clip || null
        }
        : null,
      combined_candidate: {
        schema_version: combinedCandidate.schema_version,
        domain: combinedCandidate.domain,
        source: combinedCandidate.source,
        has_id: Boolean(combinedCandidate.id),
        text_length: combinedCandidate.text.raw.length,
        identity: redactIdentity(combinedCandidate.identity)
      },
      screening: {
        schema_version: screening.schema_version,
        status: screening.status,
        passed: screening.passed,
        score: screening.score,
        reasons: screening.reasons
      },
      llm_screening: llmScreening
        ? {
          ok: llmScreening.ok,
          model: llmScreening.provider?.model || null,
          passed: llmScreening.passed,
          reason_length: llmScreening.reason?.length || 0,
          evidence_count: llmScreening.evidence?.length || 0,
          finish_reason: llmScreening.finish_reason || null,
          usage: llmScreening.usage || null
        }
        : null,
      close_result: closeResult,
      saved_payload_path: savedPayloadPath
    };
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;
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
    }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
