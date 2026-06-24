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
  buildRecruitSelfHealConfig,
  HEALTH_STATUS,
  resolveRecruitSelfHealRoots,
  runSelfHealCheck
} from "../src/core/self-heal/index.js";
import {
  closeRecruitDetail,
  createRecruitDetailNetworkRecorder,
  extractRecruitDetailCandidate,
  getRecruitRoots,
  openRecruitCardDetail,
  applyRecruitSearchParams,
  normalizeRecruitAgeFilter,
  normalizeRecruitGenderFilter,
  parseRecruitInstruction,
  readRecruitCardCandidate,
  RECRUIT_TARGET_URL,
  waitForRecruitSearchControls,
  waitForRecruitDetailContent,
  waitForRecruitDetailNetworkEvents,
  waitForRecruitCardNodeIds
} from "../src/domains/recruit/index.js";

function parseBoolean(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "on", "是", "要", "需要", "过滤"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off", "否", "不要", "不需要", "不过滤", "不限"].includes(normalized)) return false;
  return null;
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECRUIT_TARGET_URL,
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    savePayload: ".live-artifacts/recruit-domain-first-card-detail.json",
    detailSource: "network",
    saveImage: "",
    closeDetail: true,
    allowNavigate: true,
    applySearch: true,
    searchOnly: false,
    allowNoCards: false,
    resetSearch: true,
    instruction: "搜索关键词算法工程师，目标筛选1位",
    overrides: {},
    callLlm: false,
    configPath: path.join(process.env.USERPROFILE || "C:\\Users\\yaolin", ".boss-recommend-mcp", "screening-config.json"),
    resetTimeoutMs: 180000,
    resetSettleMs: 5000,
    searchTimeoutMs: 90000,
    cityOptionTimeoutMs: 30000,
    healthTimeoutMs: 90000,
    cardTimeoutMs: 60000,
    detailNetworkTimeoutMs: 30000,
    detailDomTimeoutMs: 30000,
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
    if (arg === "--no-save-payload") result.savePayload = "";
    if (arg === "--detail-source") result.detailSource = argv[++index];
    if (arg === "--save-image") result.saveImage = argv[++index];
    if (arg === "--leave-detail-open") result.closeDetail = false;
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--no-apply-search") result.applySearch = false;
    if (arg === "--search-only") result.searchOnly = true;
    if (arg === "--allow-no-cards") result.allowNoCards = true;
    if (arg === "--no-reset-search") result.resetSearch = false;
    if (arg === "--instruction") result.instruction = argv[++index];
    if (arg === "--keyword") result.overrides.keyword = argv[++index];
    if (arg === "--city") result.overrides.city = argv[++index];
    if (arg === "--degree") {
      const degreeValues = String(argv[++index] || "").split(/[，,、|/]/).map((item) => item.trim()).filter(Boolean);
      result.overrides.degrees = [
        ...(Array.isArray(result.overrides.degrees) ? result.overrides.degrees : []),
        ...degreeValues
      ];
      result.overrides.degree = result.overrides.degrees[0];
    }
    if (arg === "--degrees") {
      result.overrides.degrees = String(argv[++index] || "").split(/[，,、|/]/).map((item) => item.trim()).filter(Boolean);
      result.overrides.degree = result.overrides.degrees[0];
    }
    if (arg === "--school") {
      result.overrides.schools = [
        ...(Array.isArray(result.overrides.schools) ? result.overrides.schools : []),
        argv[++index]
      ];
    }
    if (arg === "--schools") result.overrides.schools = argv[++index];
    if (arg === "--experience") result.overrides.experience = argv[++index];
    if (arg === "--experience-start") {
      result.overrides.experience = {
        ...(result.overrides.experience && typeof result.overrides.experience === "object" ? result.overrides.experience : {}),
        start: argv[++index]
      };
    }
    if (arg === "--experience-end") {
      result.overrides.experience = {
        ...(result.overrides.experience && typeof result.overrides.experience === "object" ? result.overrides.experience : {}),
        end: argv[++index]
      };
    }
    if (arg === "--gender") result.overrides.gender = argv[++index];
    if (arg === "--age") result.overrides.age = argv[++index];
    if (arg === "--age-min") {
      result.overrides.age = {
        ...(result.overrides.age && typeof result.overrides.age === "object" ? result.overrides.age : {}),
        min: argv[++index]
      };
    }
    if (arg === "--age-max") {
      result.overrides.age = {
        ...(result.overrides.age && typeof result.overrides.age === "object" ? result.overrides.age : {}),
        max: argv[++index]
      };
    }
    if (arg === "--filter-recent-viewed") {
      const parsed = parseBoolean(argv[++index]);
      if (parsed !== null) result.overrides.filter_recent_viewed = parsed;
    }
    if (arg === "--filter-recent-colleague-contacted" || arg === "--skip-recent-colleague-contacted") {
      const parsed = parseBoolean(argv[++index]);
      if (parsed !== null) result.overrides.filter_recent_colleague_contacted = parsed;
    }
    if (arg === "--slow-live") {
      result.resetTimeoutMs = 300000;
      result.searchTimeoutMs = 180000;
      result.cityOptionTimeoutMs = 60000;
      result.healthTimeoutMs = 180000;
      result.cardTimeoutMs = 120000;
      result.detailNetworkTimeoutMs = 60000;
      result.detailDomTimeoutMs = 60000;
    }
    if (arg === "--reset-timeout-ms") result.resetTimeoutMs = parsePositiveInt(argv[++index], result.resetTimeoutMs);
    if (arg === "--reset-settle-ms") result.resetSettleMs = parsePositiveInt(argv[++index], result.resetSettleMs);
    if (arg === "--search-timeout-ms") result.searchTimeoutMs = parsePositiveInt(argv[++index], result.searchTimeoutMs);
    if (arg === "--city-option-timeout-ms") {
      result.cityOptionTimeoutMs = parsePositiveInt(argv[++index], result.cityOptionTimeoutMs);
    }
    if (arg === "--health-timeout-ms") result.healthTimeoutMs = parsePositiveInt(argv[++index], result.healthTimeoutMs);
    if (arg === "--card-timeout-ms") result.cardTimeoutMs = parsePositiveInt(argv[++index], result.cardTimeoutMs);
    if (arg === "--detail-network-timeout-ms") {
      result.detailNetworkTimeoutMs = parsePositiveInt(argv[++index], result.detailNetworkTimeoutMs);
    }
    if (arg === "--detail-dom-timeout-ms") {
      result.detailDomTimeoutMs = parsePositiveInt(argv[++index], result.detailDomTimeoutMs);
    }
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
    if (arg === "--call-llm") result.callLlm = true;
    if (arg === "--config") result.configPath = argv[++index];
  }

  const validSources = new Set(["cascade", "network", "dom", "image"]);
  if (!validSources.has(result.detailSource)) {
    throw new Error(`Unsupported --detail-source: ${result.detailSource}`);
  }
  return result;
}

function stepResult(searchApplication, stepName) {
  return (searchApplication?.steps || []).find((step) => step.step === stepName)?.result || null;
}

function validateSearchApplication(parsedInstruction, searchApplication) {
  const searchParams = parsedInstruction.searchParams || {};
  const failures = [];
  const checks = [];

  const keyword = String(searchParams.keyword || "").trim();
  const degrees = Array.isArray(searchParams.degrees)
    ? searchParams.degrees.map((item) => String(item || "").trim()).filter(Boolean)
    : [String(searchParams.degree || "").trim()].filter(Boolean);
  const schools = Array.isArray(searchParams.schools) ? searchParams.schools.filter(Boolean) : [];
  const city = String(searchParams.city || "").trim();
  const experience = searchParams.experience || null;
  const gender = normalizeRecruitGenderFilter(searchParams.gender);
  const age = normalizeRecruitAgeFilter(searchParams.age);

  if (keyword) {
    const result = stepResult(searchApplication, "keyword");
    const ok = result?.applied === true;
    checks.push({ field: "keyword", ok, result });
    if (!ok) failures.push("keyword");
  }
  if (degrees.some((degree) => degree && degree !== "不限")) {
    const result = stepResult(searchApplication, "degree");
    const ok = result?.applied === true
      && (result.selected || []).length >= degrees.filter((degree) => degree !== "不限").length;
    checks.push({ field: "degree", ok, result });
    if (!ok) failures.push("degree");
  }
  if (schools.length) {
    const result = stepResult(searchApplication, "schools");
    const ok = result?.applied === true && (result.selected || []).length === schools.length;
    checks.push({ field: "schools", ok, result });
    if (!ok) failures.push("schools");
  }
  if (city) {
    const result = stepResult(searchApplication, "city");
    const ok = result?.applied === true;
    checks.push({ field: "city", ok, result });
    if (!ok) failures.push("city");
  }
  if (experience) {
    const result = stepResult(searchApplication, "experience");
    const ok = result?.applied === true
      && (
        !experience.mode
        || result.mode === experience.mode
      );
    checks.push({ field: "experience", ok, result });
    if (!ok) failures.push("experience");
  }
  if (gender) {
    const result = stepResult(searchApplication, "gender");
    const ok = result?.applied === true && result.selected_label === gender.label;
    checks.push({ field: "gender", ok, result });
    if (!ok) failures.push("gender");
  }
  if (age) {
    const result = stepResult(searchApplication, "age");
    const ok = result?.applied === true
      && (
        !age.mode
        || result.mode === age.mode
      );
    checks.push({ field: "age", ok, result });
    if (!ok) failures.push("age");
  }
  if (typeof searchParams.filter_recent_viewed === "boolean") {
    const result = stepResult(searchApplication, "recent_viewed");
    const ok = result?.applied === true && result.requested === searchParams.filter_recent_viewed;
    checks.push({ field: "filter_recent_viewed", ok, result });
    if (!ok) failures.push("filter_recent_viewed");
  }
  if (typeof searchParams.skip_recent_colleague_contacted === "boolean") {
    const result = stepResult(searchApplication, "exchange_resume");
    const ok = result?.applied === true && result.requested === searchParams.skip_recent_colleague_contacted;
    checks.push({ field: "filter_recent_colleague_contacted", ok, result });
    if (!ok) failures.push("filter_recent_colleague_contacted");
  }

  if (failures.length) {
    throw new Error(`Recruit search application did not apply requested fields: ${failures.join(", ")}`);
  }
  return {
    ok: true,
    checks
  };
}

async function connectToRecruitSession(options) {
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
  const resolved = path.resolve(payloadPath || ".live-artifacts/recruit-detail-image-fallback.json");
  const parsed = path.parse(resolved);
  return path.join(parsed.dir, `${parsed.name}.png`);
}

function redactIdentity(identity = {}) {
  return {
    ...identity,
    name: identity?.name ? "[redacted]" : null
  };
}

function compactHealth(check) {
  return {
    status: check.status,
    summary: check.summary,
    drift_report: check.drift_report,
    probes: check.probes.map((probe) => ({
      id: probe.id,
      type: probe.type,
      status: probe.status,
      count: probe.count,
      required: probe.required,
      collapsed: probe.collapsed,
      recovered: probe.recovered,
      viewport_health: probe.viewport_health || undefined
    }))
  };
}

async function waitForHealthyRecruit(client, selfHealConfig, {
  timeoutMs = 20000,
  intervalMs = 800
} = {}) {
  const started = Date.now();
  let lastCheck = null;
  while (Date.now() - started <= timeoutMs) {
    const selfHealRoots = await resolveRecruitSelfHealRoots(client, selfHealConfig);
    lastCheck = await runSelfHealCheck({
      client,
      domain: "recruit",
      roots: selfHealRoots.roots,
      selectorProbes: selfHealConfig.selectorProbes,
      accessibilityProbes: selfHealConfig.accessibilityProbes,
      viewportProbes: selfHealConfig.viewportProbes
    });
    if (lastCheck.status === HEALTH_STATUS.HEALTHY) return lastCheck;
    await sleep(intervalMs);
  }
  return lastCheck;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let session;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    timeouts: {
      reset_timeout_ms: options.resetTimeoutMs,
      search_timeout_ms: options.searchTimeoutMs,
      city_option_timeout_ms: options.cityOptionTimeoutMs,
      health_timeout_ms: options.healthTimeoutMs,
      card_timeout_ms: options.cardTimeoutMs,
      detail_network_timeout_ms: options.detailNetworkTimeoutMs,
      detail_dom_timeout_ms: options.detailDomTimeoutMs
    },
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    }
  };

  try {
    session = await connectToRecruitSession(options);
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };
    result.runtime_guard_probe = await assertRuntimeEvaluateBlocked(client);

    await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
    await client.Network.setCacheDisabled({ cacheDisabled: true });
    const networkRecorder = createRecruitDetailNetworkRecorder(client);
    await bringPageToFront(client);
    if (options.allowNavigate && !String(target.url || "").includes(options.targetUrlIncludes)) {
      await client.Page.navigate({ url: RECRUIT_TARGET_URL });
      await sleep(3000);
      result.chrome.navigated_to = RECRUIT_TARGET_URL;
      result.chrome.navigate_ready = await waitForRecruitSearchControls(client, {
        timeoutMs: options.searchTimeoutMs,
        intervalMs: 1000
      });
      if (!result.chrome.navigate_ready.ok) {
        throw new Error("Recruit search page did not become ready after navigation");
      }
    }

    const parsedInstruction = parseRecruitInstruction({
      instruction: options.instruction || options.criteria,
      confirmation: {
        keyword_confirmed: true,
        criteria_confirmed: true,
        search_params_confirmed: true,
        use_default_for_missing: true
      },
      overrides: options.overrides
    });
    result.recruit_search_instruction = {
      instruction: options.instruction || options.criteria,
      search_params: parsedInstruction.searchParams,
      screen_params: parsedInstruction.screenParams,
      applied_defaults: parsedInstruction.applied_defaults,
      missing_fields: parsedInstruction.missing_fields
    };

    if (options.applySearch) {
      result.search_application = await applyRecruitSearchParams(client, {
        searchParams: parsedInstruction.searchParams,
        requireCards: !options.allowNoCards && !options.searchOnly,
        resetBeforeApply: options.resetSearch,
        searchTimeoutMs: options.searchTimeoutMs,
        resetTimeoutMs: options.resetTimeoutMs,
        resetSettleMs: options.resetSettleMs,
        cityOptionTimeoutMs: options.cityOptionTimeoutMs
      });
      result.search_application_validation = validateSearchApplication(parsedInstruction, result.search_application);
    }

    if (options.searchOnly) {
      assertNoForbiddenCdpCalls(methodLog);
      result.status = "PASS";
      result.runtime_evaluate_used = false;
      result.method_summary = methodSummary(methodLog);
      result.method_log = methodLog;
      if (options.savePayload) {
        result.saved_payload_path = writeJsonFile(options.savePayload, result);
      }
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const selfHealConfig = buildRecruitSelfHealConfig();
    const initialHealth = await waitForHealthyRecruit(client, selfHealConfig, {
      timeoutMs: options.healthTimeoutMs
    });
    result.self_heal = {
      initial: initialHealth ? compactHealth(initialHealth) : null
    };
    if (!initialHealth || initialHealth.status !== HEALTH_STATUS.HEALTHY) {
      throw new Error(`Recruit initial health is not healthy: ${initialHealth?.status || "missing"}`);
    }

    const preDetailCloseResult = await closeRecruitDetail(client, { attemptsLimit: 2 });
    await sleep(500);
    const rootState = await getRecruitRoots(client);
    const cardNodeIds = await waitForRecruitCardNodeIds(client, rootState.iframe.documentNodeId, {
      timeoutMs: options.cardTimeoutMs,
      intervalMs: 300
    });
    if (!cardNodeIds.length) {
      throw new Error("No recruit/search candidate cards found");
    }

    const firstCardNodeId = cardNodeIds[0];
    const cardCandidate = await readRecruitCardCandidate(client, firstCardNodeId, {
      targetUrl: result.chrome.navigated_to || target.url,
      source: "recruit-domain-card"
    });

    networkRecorder.clear();
    const openedDetail = await openRecruitCardDetail(client, firstCardNodeId);
    const cvAcquisitionState = createCvAcquisitionState({ mode: options.cvAcquisitionMode });
    const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState, {
      networkWaitMs: options.networkWaitMs,
      networkRetryWaitMs: options.networkRetryWaitMs,
      imageModeGraceMs: options.imageModeGraceMs
    });
    const networkWait = ["network", "cascade"].includes(options.detailSource)
      ? await waitForCvNetworkEvents(waitForRecruitDetailNetworkEvents, networkRecorder, {
          waitPlan,
          minCount: 1,
          requireLoaded: true,
          intervalMs: 120
        })
      : null;
    const contentWait = await waitForRecruitDetailContent(client, {
      minTextLength: options.detailSource === "dom" ? 200 : 1,
      timeoutMs: options.detailSource === "dom" ? options.detailDomTimeoutMs : options.detailNetworkTimeoutMs,
      intervalMs: 200
    });
    const effectiveDetailState = contentWait.detail_state || openedDetail.detail_state;
    const detailResult = await extractRecruitDetailCandidate(client, {
      cardCandidate,
      cardNodeId: firstCardNodeId,
      detailState: effectiveDetailState,
      detailHtml: contentWait.ok ? contentWait.detail_html : null,
      networkEvents: ["network", "cascade"].includes(options.detailSource) ? networkRecorder.events : [],
      targetUrl: result.chrome.navigated_to || target.url,
      closeDetail: false
    });

    const captureNodeId = effectiveDetailState?.popup?.node_id
      || effectiveDetailState?.resumeIframe?.node_id
      || null;
    let domEvidence = null;
    if (captureNodeId && (options.detailSource === "dom" || options.detailSource === "cascade")) {
      domEvidence = await captureNodeHtml(client, captureNodeId, {
        domain: "recruit",
        source: "live-cdp-recruit-detail-dom",
        metadata: {
          detail_popup_selector: openedDetail.detail_state.popup?.selector || null,
          resume_iframe_selector: openedDetail.detail_state.resumeIframe?.selector || null
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
          domain: "recruit",
          capture_mode: "scroll_sequence",
          detail_popup_selector: openedDetail.detail_state.popup?.selector || null,
          resume_iframe_selector: openedDetail.detail_state.resumeIframe?.selector || null
        }
      });
    }

    let parsedNetworkProfileCount = countParsedNetworkProfiles(detailResult);
    let effectiveDetailSource = options.detailSource;
    if (options.detailSource === "cascade") {
      if (parsedNetworkProfileCount > 0) {
        effectiveDetailSource = "network";
      } else {
        effectiveDetailSource = "image";
        if (captureNodeId) {
          imageEvidence = await captureScrolledNodeScreenshots(client, captureNodeId, {
            filePath: options.saveImage || defaultImagePathForPayload(options.savePayload),
            padding: 4,
            maxScreenshots: options.maxImagePages,
            wheelDeltaY: options.imageWheelDeltaY,
            settleMs: 1200,
            metadata: {
              domain: "recruit",
              capture_mode: "scroll_sequence",
              acquisition_reason: "network_miss_image_fallback",
              detail_popup_selector: openedDetail.detail_state.popup?.selector || null,
              resume_iframe_selector: openedDetail.detail_state.resumeIframe?.selector || null
            }
          });
        }
      }
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
    const networkBodyCount = detailResult.network_bodies.filter((item) => item.body).length;
    const detailTextLength = (detailResult.detail.popup_text || "").length
      + (detailResult.detail.resume_text || "").length;

    if (options.detailSource === "network" && parsedNetworkProfileCount === 0) {
      throw new Error("Forced recruit Network extraction did not produce a parsed Boss profile");
    }
    if (options.detailSource === "dom" && (!contentWait.ok || detailTextLength < 200)) {
      throw new Error(`Forced recruit DOM extraction did not produce loaded profile text; observed ${detailTextLength} chars`);
    }
    if (effectiveDetailSource === "image") {
      const uniqueCount = imageEvidence?.unique_screenshot_count || 0;
      if (uniqueCount < 2) {
        throw new Error(`Forced recruit image extraction did not produce full-CV scroll evidence (unique=${uniqueCount})`);
      }
    }
    if (options.detailSource === "cascade" && parsedNetworkProfileCount === 0 && !imageEvidence) {
      throw new Error("Recruit detail opened, but neither Network CV nor full-CV image fallback was extracted");
    }

    let closeResult = null;
    if (options.closeDetail) {
      closeResult = await closeRecruitDetail(client);
      detailResult.close_result = closeResult;
    }

    const screening = screenCandidate(detailResult.candidate, {
      criteria: options.criteria
    });
    let llmScreening = null;
    if (options.callLlm) {
      const config = readJsonFile(options.configPath);
      llmScreening = await callScreeningLlm({
        candidate: detailResult.candidate,
        criteria: options.criteria,
        config,
        timeoutMs: Number(config.llmTimeoutMs || 120000),
        imageEvidence: effectiveDetailSource === "image" ? imageEvidence : null,
        maxImages: options.maxImagePages,
        imageDetail: "high"
      });
    }

    assertNoForbiddenCdpCalls(methodLog);

    let savedPayloadPath = null;
    if (options.savePayload) {
      savedPayloadPath = writeJsonFile(options.savePayload, {
        generated_at: new Date().toISOString(),
        note: "Unredacted local artifact from Phase 6 recruit-domain modules. This is the first search-card detail candidate payload intended for screening/LLM input review.",
        chrome: {
          target_url: result.chrome.navigated_to || target.url,
          target_title: target.title
        },
        recruit_search_instruction: result.recruit_search_instruction,
        search_application: result.search_application || null,
        extraction: {
          domain: "recruit",
          source: "recruit-domain-live-smoke",
          detail_source: effectiveDetailSource,
          requested_detail_source: options.detailSource,
          cv_acquisition: {
            state: compactCvAcquisitionState(cvAcquisitionState),
            wait_plan: waitPlan,
            network_wait: networkWait,
            image_evidence: summarizeImageEvidence(imageEvidence)
          },
          iframe_selector: rootState.iframe.selector,
          first_card_node_id: firstCardNodeId,
          card_count: cardNodeIds.length,
          detail_state: {
            popup: openedDetail.detail_state.popup,
            resumeIframe: openedDetail.detail_state.resumeIframe
          },
          close_result: closeResult,
          pre_detail_close_result: preDetailCloseResult,
          network_wait: networkWait,
          content_wait: {
            ok: contentWait.ok,
            elapsed_ms: contentWait.elapsed_ms,
            text_length: contentWait.text_length,
            error: contentWait.error || null
          },
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
        detail: detailResult.detail,
        parsed_network_profiles: detailResult.parsed_network_profiles,
        network_bodies: detailResult.network_bodies,
        llm_screening_payload: {
          schema_version: 1,
          criteria: options.criteria,
          candidate: detailResult.candidate
        },
        deterministic_screening_result: screening,
        llm_screening_result: llmScreening
      });
    }

    result.status = "PASS";
    result.runtime_evaluate_used = false;
    result.recruit = {
      iframe: {
        selector: rootState.iframe.selector,
        document_node_id: rootState.iframe.documentNodeId
      },
      card_count: cardNodeIds.length,
      first_card_node_id: firstCardNodeId,
      first_card_candidate: {
        schema_version: cardCandidate.schema_version,
        has_id: Boolean(cardCandidate.id),
        identity: redactIdentity(cardCandidate.identity),
        text_length: cardCandidate.text.raw.length
      },
      detail: {
        source: effectiveDetailSource,
        requested_source: options.detailSource,
        cv_acquisition: {
          state: compactCvAcquisitionState(cvAcquisitionState),
          wait_plan: waitPlan,
          network_wait: networkWait,
          image_evidence: summarizeImageEvidence(imageEvidence)
        },
        opened: true,
        network_wait: {
          ok: networkWait?.ok || false,
          elapsed_ms: networkWait?.elapsed_ms || 0,
          count: networkWait?.count || 0,
          total_event_count: networkWait?.total_event_count ?? networkRecorder.events.length
        },
        content_wait: {
          ok: contentWait.ok,
          elapsed_ms: contentWait.elapsed_ms,
          text_length: contentWait.text_length,
          error: contentWait.error || null
        },
        popup_found: Boolean(effectiveDetailState?.popup),
        resume_iframe_found: Boolean(effectiveDetailState?.resumeIframe),
        popup_text_length: detailResult.detail.popup_text.length,
        resume_text_length: detailResult.detail.resume_text.length,
        network_detail_event_count: networkRecorder.events.length,
        network_body_count: networkBodyCount,
        parsed_network_profile_count: parsedNetworkProfileCount,
        parsed_network_profile_source_keys: detailResult.parsed_network_profiles
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
        close_result: detailResult.close_result
      },
      screening: {
        schema_version: screening.schema_version,
        status: screening.status,
        passed: screening.passed,
        score: screening.score,
        reasons: screening.reasons,
        candidate: {
          ...screening.candidate,
          identity: redactIdentity(screening.candidate.identity)
        }
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
    if (options.savePayload) {
      result.saved_failure_report_path = writeJsonFile(options.savePayload, result);
    }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
