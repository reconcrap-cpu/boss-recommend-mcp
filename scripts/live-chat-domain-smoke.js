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
  callScreeningLlm,
  screenCandidate
} from "../src/core/screening/index.js";
import {
  buildChatSelfHealConfig,
  HEALTH_STATUS,
  resolveChatSelfHealRoots,
  runSelfHealCheck
} from "../src/core/self-heal/index.js";
import {
  CHAT_TARGET_URL,
  captureNodeIdFromResumeState,
  closeChatResumeModal,
  createChatProfileNetworkRecorder,
  extractChatProfileCandidate,
  getChatRoots,
  openChatOnlineResume,
  readChatCardCandidate,
  selectChatCandidate,
  waitForChatCandidateNodeIds,
  waitForChatProfileNetworkEvents,
  waitForChatResumeContent
} from "../src/domains/chat/index.js";

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: CHAT_TARGET_URL,
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    savePayload: ".live-artifacts/chat-domain-first-candidate-resume.json",
    detailSource: "network",
    saveImage: "",
    closeResume: true,
    allowNavigate: true,
    callLlm: false,
    configPath: path.join(process.env.USERPROFILE || "C:\\Users\\yaolin", ".boss-recommend-mcp", "screening-config.json"),
    navigateSettleMs: 5000,
    healthTimeoutMs: 90000,
    cardTimeoutMs: 90000,
    readyTimeoutMs: 60000,
    resumeNetworkTimeoutMs: 60000,
    resumeDomTimeoutMs: 60000,
    candidateIndex: 0,
    maxImagePages: 6,
    imageWheelDeltaY: 650,
    llmImageLimit: 8,
    llmImageDetail: "high",
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
    if (arg === "--no-save-payload") result.savePayload = "";
    if (arg === "--detail-source") result.detailSource = argv[++index];
    if (arg === "--save-image") result.saveImage = argv[++index];
    if (arg === "--leave-resume-open") result.closeResume = false;
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--call-llm") result.callLlm = true;
    if (arg === "--config") result.configPath = argv[++index];
    if (arg === "--slow-live") {
      result.navigateSettleMs = 10000;
      result.healthTimeoutMs = 180000;
      result.cardTimeoutMs = 180000;
      result.readyTimeoutMs = 120000;
      result.resumeNetworkTimeoutMs = 120000;
      result.resumeDomTimeoutMs = 120000;
    }
    if (arg === "--navigate-settle-ms") result.navigateSettleMs = parsePositiveInt(argv[++index], result.navigateSettleMs);
    if (arg === "--health-timeout-ms") result.healthTimeoutMs = parsePositiveInt(argv[++index], result.healthTimeoutMs);
    if (arg === "--card-timeout-ms") result.cardTimeoutMs = parsePositiveInt(argv[++index], result.cardTimeoutMs);
    if (arg === "--ready-timeout-ms") result.readyTimeoutMs = parsePositiveInt(argv[++index], result.readyTimeoutMs);
    if (arg === "--resume-network-timeout-ms") {
      result.resumeNetworkTimeoutMs = parsePositiveInt(argv[++index], result.resumeNetworkTimeoutMs);
    }
    if (arg === "--resume-dom-timeout-ms") {
      result.resumeDomTimeoutMs = parsePositiveInt(argv[++index], result.resumeDomTimeoutMs);
    }
    if (arg === "--candidate-index") {
      const parsed = Number(argv[++index]);
      result.candidateIndex = Number.isInteger(parsed) && parsed >= 0 ? parsed : result.candidateIndex;
    }
    if (arg === "--max-image-pages") result.maxImagePages = parsePositiveInt(argv[++index], result.maxImagePages);
    if (arg === "--image-wheel-delta-y") {
      result.imageWheelDeltaY = parsePositiveInt(argv[++index], result.imageWheelDeltaY);
    }
    if (arg === "--llm-image-limit") result.llmImageLimit = parsePositiveInt(argv[++index], result.llmImageLimit);
    if (arg === "--llm-image-detail") result.llmImageDetail = argv[++index];
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

async function connectToChatSession(options) {
  try {
    return await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes: options.targetUrlIncludes
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

function shouldNavigateToChat(url) {
  const text = String(url || "");
  return !text.includes("/web/chat/index")
    || text.includes("/web/chat/recommend")
    || text.includes("/web/chat/search");
}

async function ensureChatPage(client, target, options) {
  if (!options.allowNavigate || !shouldNavigateToChat(target?.url)) {
    return {
      navigated: false,
      url: target?.url || ""
    };
  }
  await client.Page.navigate({ url: CHAT_TARGET_URL });
  await sleep(options.navigateSettleMs);
  return {
    navigated: true,
    url: CHAT_TARGET_URL,
    settle_ms: options.navigateSettleMs
  };
}

async function waitForHealthyChat(client, config, {
  timeoutMs = 90000,
  intervalMs = 1000
} = {}) {
  const started = Date.now();
  let lastCheck = null;
  while (Date.now() - started <= timeoutMs) {
    const roots = await resolveChatSelfHealRoots(client, config);
    lastCheck = await runSelfHealCheck({
      client,
      domain: "chat",
      roots: roots.roots,
      selectorProbes: config.selectorProbes,
      accessibilityProbes: config.accessibilityProbes,
      viewportProbes: config.viewportProbes
    });
    if (lastCheck.status === HEALTH_STATUS.HEALTHY) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        roots,
        check: lastCheck
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    roots: await resolveChatSelfHealRoots(client, config),
    check: lastCheck
  };
}

function compactCheck(check) {
  return {
    domain: check?.domain,
    status: check?.status,
    summary: check?.summary,
    probes: (check?.probes || []).map((probe) => ({
      id: probe.id,
      type: probe.type,
      status: probe.status,
      ok: probe.ok,
      required: probe.required,
      count: probe.count,
      root: probe.root || null,
      collapsed: probe.collapsed,
      recovered: probe.recovered,
      viewport_health: probe.viewport_health || undefined,
      matched_selectors: probe.matched_selectors || undefined,
      total_ax_nodes: probe.total_ax_nodes || undefined,
      error: probe.error || undefined
    })),
    drift_report: check?.drift_report
  };
}

function compactCandidate(candidate) {
  return {
    domain: candidate?.domain || "chat",
    source: candidate?.source || "",
    id: candidate?.id || null,
    identity: candidate?.identity || {},
    text_length: candidate?.text?.raw?.length || 0,
    tag_count: candidate?.tags?.length || 0
  };
}

function compactScreening(screening) {
  return {
    status: screening.status,
    passed: screening.passed,
    score: screening.score,
    reasons: screening.reasons,
    matched: screening.matched,
    candidate: screening.candidate
  };
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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function defaultImagePathForPayload(payloadPath) {
  const resolved = path.resolve(payloadPath || ".live-artifacts/chat-detail-image-fallback.json");
  const parsed = path.parse(resolved);
  return path.join(parsed.dir, `${parsed.name}.png`);
}

function redactIdentity(identity = {}) {
  return {
    ...identity,
    name: identity?.name ? "[redacted]" : null
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let session;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    },
    detail_source: options.detailSource
  };

  try {
    session = await connectToChatSession(options);
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
    result.navigation = await ensureChatPage(client, target, options);

    const selfHealConfig = buildChatSelfHealConfig();
    const health = await waitForHealthyChat(client, selfHealConfig, {
      timeoutMs: options.healthTimeoutMs
    });
    result.self_heal = {
      initial: compactCheck(health.check),
      elapsed_ms: health.elapsed_ms
    };
    if (!health.ok) {
      throw new Error(`Chat self-heal health check did not pass live gate: ${health.check?.status || "unknown"}`);
    }

    const rootState = await getChatRoots(client);
    const cardResult = await waitForChatCandidateNodeIds(client, rootState.rootNodes.top, {
      timeoutMs: options.cardTimeoutMs,
      intervalMs: 500
    });
    if (!cardResult.nodeIds.length) {
      throw new Error("No chat candidate conversation cards found");
    }

    if (options.candidateIndex >= cardResult.nodeIds.length) {
      throw new Error(`Requested chat candidate index ${options.candidateIndex} but only found ${cardResult.nodeIds.length} cards`);
    }

    const selectedCardNodeId = cardResult.nodeIds[options.candidateIndex];
    const cardCandidate = await readChatCardCandidate(client, selectedCardNodeId, {
      targetUrl: CHAT_TARGET_URL,
      source: "chat-live-card",
      metadata: {
        selector: cardResult.selector,
        candidate_index: options.candidateIndex
      }
    });
    result.cards = {
      selector: cardResult.selector,
      count: cardResult.nodeIds.length,
      selected_candidate_index: options.candidateIndex,
      selected_card_node_id: selectedCardNodeId,
      selected_card_candidate: {
        ...compactCandidate(cardCandidate),
        identity: redactIdentity(cardCandidate.identity)
      }
    };

    const networkRecorder = createChatProfileNetworkRecorder(client);
    const selected = await selectChatCandidate(client, selectedCardNodeId, {
      timeoutMs: options.readyTimeoutMs
    });
    const selectionNetworkEvents = networkRecorder.events.slice();
    result.selection = {
      online_resume_ready: selected.ready?.ok === true,
      ready_elapsed_ms: selected.ready?.elapsed_ms,
      active_candidate_selector: selected.ready?.activeCandidate?.selector || null,
      online_resume_selector: selected.ready?.target?.selector || null,
      network_event_count: selectionNetworkEvents.length
    };
    if (!selected.ready?.ok) {
      throw new Error("Selected chat candidate did not expose an online resume button");
    }

    networkRecorder.clear();
    const openedResume = await openChatOnlineResume(client, {
      timeoutMs: options.readyTimeoutMs
    });
    const cvAcquisitionState = createCvAcquisitionState({ mode: options.cvAcquisitionMode });
    const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState, {
      networkWaitMs: options.networkWaitMs,
      networkRetryWaitMs: options.networkRetryWaitMs,
      imageModeGraceMs: options.imageModeGraceMs
    });
    const networkWait = ["network", "cascade"].includes(options.detailSource)
      ? await waitForCvNetworkEvents(waitForChatProfileNetworkEvents, networkRecorder, {
          waitPlan,
          minCount: 1,
          requireLoaded: true,
          intervalMs: 200
        })
      : null;
    const contentWait = await waitForChatResumeContent(client, {
      timeoutMs: options.resumeDomTimeoutMs,
      intervalMs: 300
    });
    const resumeState = contentWait.resume_state || openedResume.resume_state;
    const resumeHtml = contentWait.resume_html || null;
    const captureNodeId = captureNodeIdFromResumeState(resumeState);
    const domEvidence = captureNodeId
      ? await captureNodeHtml(client, captureNodeId, {
        domain: "chat",
        source: "chat-resume-dom",
        metadata: {
          detail_source: options.detailSource
        }
      })
      : null;
    const imagePath = options.saveImage || (
      options.detailSource === "image" ? defaultImagePathForPayload(options.savePayload) : ""
    );
    let imageEvidence = imagePath && captureNodeId && options.detailSource === "image"
      ? await captureScrolledNodeScreenshots(client, captureNodeId, {
          filePath: imagePath,
          padding: 0,
          captureViewport: false,
          maxScreenshots: options.maxImagePages,
          wheelDeltaY: options.imageWheelDeltaY,
          settleMs: 1200,
          metadata: {
            detail_source: options.detailSource,
            capture_mode: "scroll_sequence",
            capture_scope: "resume_modal_clip",
            candidate_index: options.candidateIndex
          }
        })
      : null;

    const resumeNetworkEvents = networkRecorder.events.slice();
    const networkEventsForExtraction = ["network", "cascade"].includes(options.detailSource)
      ? [...selectionNetworkEvents, ...resumeNetworkEvents]
      : [];
    const detailResult = await extractChatProfileCandidate(client, {
      cardCandidate,
      cardNodeId: selectedCardNodeId,
      resumeState,
      resumeHtml,
      networkEvents: networkEventsForExtraction,
      targetUrl: CHAT_TARGET_URL,
      closeResume: false
    });

    let parsedProfiles = detailResult.parsed_network_profiles.filter((item) => item.ok);
    let effectiveDetailSource = options.detailSource;
    if (options.detailSource === "cascade") {
      if (parsedProfiles.length > 0) {
        effectiveDetailSource = "network";
      } else {
        effectiveDetailSource = "image";
        if (captureNodeId) {
          imageEvidence = await captureScrolledNodeScreenshots(client, captureNodeId, {
            filePath: options.saveImage || defaultImagePathForPayload(options.savePayload),
            padding: 0,
            captureViewport: false,
            maxScreenshots: options.maxImagePages,
            wheelDeltaY: options.imageWheelDeltaY,
            settleMs: 1200,
            metadata: {
              detail_source: effectiveDetailSource,
              capture_mode: "scroll_sequence",
              capture_scope: "resume_modal_clip",
              acquisition_reason: "network_miss_image_fallback",
              candidate_index: options.candidateIndex
            }
          });
        }
      }
    }
    result.detail_source = effectiveDetailSource;
    result.requested_detail_source = options.detailSource;
    const parsedNetworkProfileCount = countParsedNetworkProfiles(detailResult);
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
    let closeResult = null;
    if (options.closeResume) {
      closeResult = await closeChatResumeModal(client);
      detailResult.close_result = closeResult;
    }
    parsedProfiles = detailResult.parsed_network_profiles.filter((item) => item.ok);
    const screening = screenCandidate(detailResult.candidate, {
      criteria: options.criteria
    });
    let llmResult = null;
    if (options.callLlm) {
      const config = readJsonFile(options.configPath);
      llmResult = await callScreeningLlm({
        candidate: detailResult.candidate,
        criteria: options.criteria,
        config,
        timeoutMs: Number(config.llmTimeoutMs || 120000),
        imageEvidence: effectiveDetailSource === "image" ? imageEvidence : null,
        maxImages: options.llmImageLimit,
        imageDetail: options.llmImageDetail
      });
    }

    result.resume = {
      opened: true,
      source: effectiveDetailSource,
      requested_source: options.detailSource,
      cv_acquisition: {
        state: compactCvAcquisitionState(cvAcquisitionState),
        wait_plan: waitPlan,
        network_wait: networkWait,
        image_evidence: summarizeImageEvidence(imageEvidence)
      },
      button_selector: openedResume.button?.selector || null,
      network_wait: {
        ok: networkWait?.ok || false,
        elapsed_ms: networkWait?.elapsed_ms || 0,
        count: networkWait?.count || 0,
        total_event_count: resumeNetworkEvents.length
      },
      selection_network_event_count: selectionNetworkEvents.length,
      resume_network_event_count: resumeNetworkEvents.length,
      network_events: resumeNetworkEvents.map((event) => ({
        url: event.url,
        status: event.status,
        mimeType: event.mimeType,
        type: event.type,
        loading_finished: event.loading_finished,
        loading_failed: event.loading_failed,
        encodedDataLength: event.encodedDataLength
      })),
      content_wait: {
        ok: contentWait.ok,
        elapsed_ms: contentWait.elapsed_ms,
        text_length: contentWait.text_length
      },
      network_body_count: detailResult.network_bodies.filter((item) => item.body).length,
      network_bodies: detailResult.network_bodies.map((item) => ({
        url: item.url,
        status: item.status,
        mimeType: item.mimeType,
        body_length: item.body_length,
        body_error: item.body_error || null,
        body_preview: String(item.body?.body || "").slice(0, 300)
      })),
      parsed_network_profile_count: parsedProfiles.length,
      parsed_network_profiles: detailResult.parsed_network_profiles.map((item) => ({
        ok: item.ok,
        url: item.url,
        status: item.status,
        error: item.error || null,
        text_length: item.text_length,
        source_keys: item.profile?.source_keys || null
      })),
      detail_text_lengths: {
        popup: detailResult.detail.popup_text.length,
        content: detailResult.detail.content_text.length,
        resume_iframe: detailResult.detail.resume_iframe_text.length
      },
      dom_evidence: domEvidence
        ? {
          node_id: domEvidence.node_id,
          text_length: domEvidence.text_length,
          outer_html_length: domEvidence.outer_html_length
        }
        : null,
      image_evidence: imageEvidence,
      close_result: detailResult.close_result
    };
    result.candidate = {
      ...compactCandidate(detailResult.candidate),
      identity: redactIdentity(detailResult.candidate.identity),
      raw_text_preview: detailResult.candidate.text?.raw?.slice(0, 800) || ""
    };
    result.screening = compactScreening(screening);
    result.llm_result = llmResult;

    if (options.detailSource === "network" && parsedProfiles.length < 1) {
      throw new Error("Forced chat Network detail source did not produce a parsed Boss profile");
    }
    if (options.detailSource === "dom" && !(domEvidence?.text_length > 0 || contentWait.text_length > 0)) {
      throw new Error("Forced chat DOM detail source did not produce DOM evidence");
    }
    if (effectiveDetailSource === "image") {
      const uniqueCount = imageEvidence?.unique_screenshot_count
        ?? (imageEvidence?.byte_length > 1000 ? 1 : 0);
      if (uniqueCount < 2) {
        throw new Error(`Forced chat image detail source did not produce multi-page scroll screenshot evidence (unique=${uniqueCount})`);
      }
    }
    if (options.detailSource === "cascade" && parsedProfiles.length < 1 && !imageEvidence) {
      throw new Error("Chat resume opened, but neither Network CV nor full-CV image fallback was extracted");
    }

    result.runtime_guard = {
      blocked: true,
      used_forbidden_runtime: false
    };
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;
    assertNoForbiddenCdpCalls(methodLog);

    result.status = "PASS";
    if (options.savePayload) {
      result.saved_payload_path = path.resolve(options.savePayload);
      writeJsonFile(options.savePayload, result);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    result.status = "FAIL";
    result.error = {
      name: error?.name || "Error",
      message: error?.message || String(error),
      attempts: error?.attempts || undefined
    };
    if (session?.methodLog) {
      result.method_summary = methodSummary(session.methodLog);
      result.method_log = session.methodLog;
      result.runtime_guard = {
        blocked: true,
        used_forbidden_runtime: session.methodLog.some((entry) => /^Runtime\./.test(entry.method))
      };
    }
    try {
      if (session?.client && options.closeResume) {
        await closeChatResumeModal(session.client, { attemptsLimit: 2 });
      }
    } catch {}
    if (options.savePayload) {
      result.saved_payload_path = path.resolve(options.savePayload);
      writeJsonFile(options.savePayload, result);
    }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
