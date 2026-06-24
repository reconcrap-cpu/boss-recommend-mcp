#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  bringPageToFront,
  connectToChromeTarget,
  createHumanRestController,
  enableDomains,
  normalizeHumanBehaviorOptions,
  sleep
} from "../src/core/browser/index.js";
import { captureScrolledNodeScreenshots } from "../src/core/capture/index.js";
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
  compactInfiniteListState,
  createInfiniteListState,
  getNextInfiniteListCandidate,
  markInfiniteListCandidateProcessed,
  resetInfiniteListForRefreshRound
} from "../src/core/infinite-list/index.js";
import {
  callScreeningLlm,
  normalizeText
} from "../src/core/screening/index.js";
import {
  describeGreetQuotaAfterSpend,
  parseGreetQuota
} from "../src/core/greet-quota/index.js";
import {
  buildLegacyScreenInputRows,
  cloneReportInput,
  defaultLegacyCsvPathForReport,
  writeLegacyScreenCsv
} from "../src/core/reporting/legacy-csv.js";
import {
  clickRecruitActionControl,
  closeRecruitDetail,
  createRecruitDetailNetworkRecorder,
  extractRecruitDetailCandidate,
  getRecruitRoots,
  openRecruitCardDetail,
  applyRecruitSearchParams,
  readRecruitCardCandidate,
  refreshRecruitSearchAtEnd,
  RECRUIT_TARGET_URL,
  waitForRecruitCardNodeIds,
  waitForRecruitDetail,
  waitForRecruitDetailActionControls,
  waitForRecruitDetailContent,
  waitForRecruitDetailNetworkEvents,
  waitForRecruitSearchControls
} from "../src/domains/recruit/index.js";

const DEFAULT_CRITERIA = "必须有ccf-a论文或会议成果，本科学历必须至少211及以上或者海外qs200院校";

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

function normalizeSchoolLabel(value) {
  const text = normalizeText(value);
  if (/^qs\s*100$/i.test(text)) return "QS100";
  if (/^qs\s*200$/i.test(text)) return "QS200";
  return text;
}

function parseList(raw) {
  if (Array.isArray(raw)) return raw.map(normalizeText).filter(Boolean);
  return String(raw || "")
    .split(/[，,、|/]/)
    .map(normalizeText)
    .filter(Boolean);
}

function parseSchools(raw) {
  return parseList(raw).map(normalizeSchoolLabel).filter(Boolean);
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECRUIT_TARGET_URL,
    configPath: "C:/Users/yaolin/.boss-recommend-mcp/screening-config.json",
    saveReport: ".live-artifacts/phase10-search-criteria-greet-live.json",
    saveCsv: "",
    saveCsvEnabled: true,
    candidateInputDir: ".live-artifacts/phase10-search-llm-inputs",
    imageDir: ".live-artifacts/phase10-search-cv-images",
    job: "",
    city: "杭州",
    degrees: ["硕士"],
    schools: ["985", "211", "QS100"],
    schoolsExplicit: false,
    experience: null,
    gender: null,
    age: null,
    keyword: "算法",
    filterRecentViewed: true,
    filterRecentColleagueContacted: null,
    criteria: DEFAULT_CRITERIA,
    targetCount: 3,
    maxScreened: 20,
    postAction: "greet",
    maxGreetCount: null,
    initialGreetCount: 0,
    executePostAction: false,
    restLevel: "low",
    allowNavigate: true,
    resetSearch: true,
    detailTimeoutMs: 30000,
    detailContentTimeoutMs: 30000,
    cardTimeoutMs: 60000,
    networkWaitMs: 4200,
    networkRetryWaitMs: 2000,
    imageModeGraceMs: 1000,
    networkIntervalMs: 150,
    maxImagePages: 10,
    imageFormat: "png",
    imageQuality: null,
    imageWheelDeltaY: 650,
    listMaxScrolls: 45,
    listStableSignatureLimit: 3,
    listWheelDeltaY: 850,
    listSettleMs: 2200,
    listFallbackPoint: null,
    refreshOnEnd: true,
    maxRefreshRounds: 2,
    resetTimeoutMs: 180000,
    resetSettleMs: 5000,
    searchTimeoutMs: 90000,
    cityOptionTimeoutMs: 30000,
    llmTimeoutMs: 120000,
    llmMaxRetries: null,
    llmAttempts: 2,
    delayMs: 800,
    slowLive: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--config") result.configPath = argv[++index];
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--save-csv") result.saveCsv = argv[++index];
    if (arg === "--no-save-csv") result.saveCsvEnabled = false;
    if (arg === "--candidate-input-dir") result.candidateInputDir = argv[++index];
    if (arg === "--image-dir") result.imageDir = argv[++index];
    if (arg === "--job") result.job = argv[++index];
    if (arg === "--city") result.city = argv[++index];
    if (arg === "--degree") result.degrees = parseList(argv[++index]);
    if (arg === "--degrees") result.degrees = parseList(argv[++index]);
    if (arg === "--school") {
      result.schoolsExplicit = true;
      result.schools.push(normalizeSchoolLabel(argv[++index]));
    }
    if (arg === "--schools") {
      result.schoolsExplicit = true;
      result.schools = parseSchools(argv[++index]);
    }
    if (arg === "--no-schools") {
      result.schoolsExplicit = true;
      result.schools = [];
    }
    if (arg === "--experience") result.experience = argv[++index];
    if (arg === "--gender") result.gender = argv[++index];
    if (arg === "--age") result.age = argv[++index];
    if (arg === "--age-min") {
      result.age = {
        ...(result.age && typeof result.age === "object" ? result.age : {}),
        min: argv[++index]
      };
    }
    if (arg === "--age-max") {
      result.age = {
        ...(result.age && typeof result.age === "object" ? result.age : {}),
        max: argv[++index]
      };
    }
    if (arg === "--keyword") result.keyword = argv[++index];
    if (arg === "--filter-recent-viewed") {
      const parsed = parseBoolean(argv[++index]);
      if (parsed !== null) result.filterRecentViewed = parsed;
    }
    if (arg === "--filter-recent-colleague-contacted" || arg === "--skip-recent-colleague-contacted") {
      const parsed = parseBoolean(argv[++index]);
      if (parsed !== null) result.filterRecentColleagueContacted = parsed;
    }
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--target-count") result.targetCount = parsePositiveInt(argv[++index], result.targetCount);
    if (arg === "--max-screened") result.maxScreened = parsePositiveInt(argv[++index], result.maxScreened);
    if (arg === "--post-action") result.postAction = argv[++index];
    if (arg === "--max-greet-count") result.maxGreetCount = parsePositiveInt(argv[++index], result.maxGreetCount);
    if (arg === "--initial-greet-count") result.initialGreetCount = Math.max(0, Number(argv[++index]) || 0);
    if (arg === "--execute-post-action") result.executePostAction = true;
    if (arg === "--dry-run-post-action") result.executePostAction = false;
    if (arg === "--rest-level") result.restLevel = argv[++index];
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--no-reset-search") result.resetSearch = false;
    if (arg === "--detail-timeout-ms") result.detailTimeoutMs = parsePositiveInt(argv[++index], result.detailTimeoutMs);
    if (arg === "--detail-content-timeout-ms") {
      result.detailContentTimeoutMs = parsePositiveInt(argv[++index], result.detailContentTimeoutMs);
    }
    if (arg === "--card-timeout-ms") result.cardTimeoutMs = parsePositiveInt(argv[++index], result.cardTimeoutMs);
    if (arg === "--network-wait-ms") result.networkWaitMs = parsePositiveInt(argv[++index], result.networkWaitMs);
    if (arg === "--network-retry-wait-ms") {
      result.networkRetryWaitMs = parsePositiveInt(argv[++index], result.networkRetryWaitMs);
    }
    if (arg === "--image-mode-grace-ms") {
      result.imageModeGraceMs = parsePositiveInt(argv[++index], result.imageModeGraceMs);
    }
    if (arg === "--max-image-pages") result.maxImagePages = parsePositiveInt(argv[++index], result.maxImagePages);
    if (arg === "--image-format") result.imageFormat = argv[++index];
    if (arg === "--image-quality") result.imageQuality = Number(argv[++index]);
    if (arg === "--image-wheel-delta-y") {
      result.imageWheelDeltaY = parsePositiveInt(argv[++index], result.imageWheelDeltaY);
    }
    if (arg === "--list-max-scrolls") result.listMaxScrolls = parsePositiveInt(argv[++index], result.listMaxScrolls);
    if (arg === "--list-settle-ms") result.listSettleMs = parsePositiveInt(argv[++index], result.listSettleMs);
    if (arg === "--list-fallback-point") {
      const [x, y] = String(argv[++index] || "").split(/[,:]/).map((part) => Number(part.trim()));
      result.listFallbackPoint = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    }
    if (arg === "--no-refresh-on-end") result.refreshOnEnd = false;
    if (arg === "--max-refresh-rounds") result.maxRefreshRounds = Math.max(0, Number(argv[++index]) || 0);
    if (arg === "--reset-timeout-ms") result.resetTimeoutMs = parsePositiveInt(argv[++index], result.resetTimeoutMs);
    if (arg === "--reset-settle-ms") result.resetSettleMs = parsePositiveInt(argv[++index], result.resetSettleMs);
    if (arg === "--search-timeout-ms") result.searchTimeoutMs = parsePositiveInt(argv[++index], result.searchTimeoutMs);
    if (arg === "--city-option-timeout-ms") {
      result.cityOptionTimeoutMs = parsePositiveInt(argv[++index], result.cityOptionTimeoutMs);
    }
    if (arg === "--llm-timeout-ms") result.llmTimeoutMs = parsePositiveInt(argv[++index], result.llmTimeoutMs);
    if (arg === "--llm-max-retries") result.llmMaxRetries = Math.max(0, Number(argv[++index]) || 0);
    if (arg === "--llm-attempts") result.llmAttempts = parsePositiveInt(argv[++index], result.llmAttempts);
    if (arg === "--delay-ms") result.delayMs = Math.max(0, Number(argv[++index]) || 0);
    if (arg === "--slow-live") {
      result.slowLive = true;
      result.resetTimeoutMs = Math.max(result.resetTimeoutMs, 300000);
      result.searchTimeoutMs = Math.max(result.searchTimeoutMs, 180000);
      result.cityOptionTimeoutMs = Math.max(result.cityOptionTimeoutMs, 60000);
      result.cardTimeoutMs = Math.max(result.cardTimeoutMs, 120000);
      result.detailTimeoutMs = Math.max(result.detailTimeoutMs, 60000);
      result.detailContentTimeoutMs = Math.max(result.detailContentTimeoutMs, 60000);
      result.listSettleMs = Math.max(result.listSettleMs, 3200);
      result.llmTimeoutMs = Math.max(result.llmTimeoutMs, 180000);
    }
  }

  result.degrees = parseList(result.degrees).length ? parseList(result.degrees) : ["硕士"];
  const parsedSchools = parseSchools(result.schools);
  result.schools = result.schoolsExplicit
    ? parsedSchools
    : parsedSchools.length
      ? parsedSchools
      : ["985", "211", "QS100"];
  return result;
}

function searchParamsFromOptions(options) {
  const params = {
    job: options.job || null,
    city: options.city,
    degrees: options.degrees,
    degree: options.degrees[0] || "不限",
    schools: options.schools,
    keyword: options.keyword,
    filter_recent_viewed: options.filterRecentViewed
  };
  if (typeof options.filterRecentColleagueContacted === "boolean") {
    params.skip_recent_colleague_contacted = options.filterRecentColleagueContacted;
  }
  if (options.experience) params.experience = options.experience;
  if (options.gender) params.gender = options.gender;
  if (options.age) params.age = options.age;
  return params;
}

function methodSummary(methodLog) {
  const summary = {};
  for (const entry of methodLog) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function readJsonFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`JSON file not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function progress(event, data = {}) {
  console.error(JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...data
  }));
}

function ensureDir(dirPath) {
  const resolved = path.resolve(dirPath);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function safeHost(baseUrl = "") {
  return String(baseUrl || "").replace(/\/\/[^/]+/, "//[redacted-host]");
}

function stepResult(searchApplication, stepName) {
  return (searchApplication?.steps || []).find((step) => step.step === stepName)?.result || null;
}

function validateSearchApplication(searchParams, searchApplication) {
  const failures = [];
  const checks = [];
  const expectedDegrees = (searchParams.degrees || []).filter((degree) => degree && degree !== "不限");

  if (searchParams.job) {
    const result = stepResult(searchApplication, "job_title");
    const ok = result?.applied === true;
    checks.push({ field: "job", ok, result });
    if (!ok) failures.push("job");
  }
  if (searchParams.city) {
    const result = stepResult(searchApplication, "city");
    const ok = result?.applied === true;
    checks.push({ field: "city", ok, result });
    if (!ok) failures.push("city");
  }
  if (expectedDegrees.length) {
    const result = stepResult(searchApplication, "degree");
    const ok = result?.applied === true && (result.selected || []).length >= expectedDegrees.length;
    checks.push({ field: "degree", ok, result });
    if (!ok) failures.push("degree");
  }
  if ((searchParams.schools || []).length) {
    const result = stepResult(searchApplication, "schools");
    const ok = result?.applied === true && (result.selected || []).length >= searchParams.schools.length;
    checks.push({ field: "schools", ok, result });
    if (!ok) failures.push("schools");
  }
  if (searchParams.experience) {
    const result = stepResult(searchApplication, "experience");
    const ok = result?.applied === true;
    checks.push({ field: "experience", ok, result });
    if (!ok) failures.push("experience");
  }
  if (searchParams.gender) {
    const result = stepResult(searchApplication, "gender");
    const ok = result?.applied === true;
    checks.push({ field: "gender", ok, result });
    if (!ok) failures.push("gender");
  }
  if (searchParams.age) {
    const result = stepResult(searchApplication, "age");
    const ok = result?.applied === true;
    checks.push({ field: "age", ok, result });
    if (!ok) failures.push("age");
  }
  if (searchParams.keyword) {
    const result = stepResult(searchApplication, "keyword");
    const ok = result?.applied === true;
    checks.push({ field: "keyword", ok, result });
    if (!ok) failures.push("keyword");
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

function compactCandidate(candidate = {}) {
  return {
    schema_version: candidate.schema_version || 1,
    domain: candidate.domain || "recruit",
    source: candidate.source || "",
    id: candidate.id || null,
    identity: candidate.identity || {},
    tags: candidate.tags || [],
    text_length: candidate.text?.raw?.length || 0,
    text_summary: candidate.text?.summary || ""
  };
}

function compactDetail(detailResult) {
  if (!detailResult) return null;
  return {
    popup_text_length: detailResult.detail?.popup_text?.length || 0,
    resume_text_length: detailResult.detail?.resume_text?.length || 0,
    card_box: detailResult.card_box || null,
    open_attempts: detailResult.open_attempts || [],
    network_body_count: detailResult.network_bodies?.filter((item) => item.body).length || 0,
    parsed_network_profile_count: detailResult.parsed_network_profiles?.filter((item) => item.ok).length || 0,
    cv_acquisition: detailResult.cv_acquisition || null,
    image_evidence: summarizeImageEvidence(detailResult.image_evidence),
    close_result: detailResult.close_result || null
  };
}

function compactActionControl(control = null) {
  if (!control) return null;
  return {
    node_id: control.node_id,
    kind: control.kind,
    label: control.label,
    class_name: control.class_name,
    available: Boolean(control.available),
    continue_chat: Boolean(control.continue_chat),
    disabled: Boolean(control.disabled),
    greet_quota: control.greet_quota || null,
    center: control.center,
    rect: control.rect,
    attributes: control.attributes
  };
}

function compactActionDiscovery(discovery) {
  if (!discovery) return null;
  return {
    ok: Boolean(discovery.ok),
    elapsed_ms: discovery.elapsed_ms,
    summary: {
      greet: {
        found: Boolean(discovery.summary?.greet?.found),
        available: Boolean(discovery.summary?.greet?.available),
        continue_chat: Boolean(discovery.summary?.greet?.continue_chat),
        greet_quota: discovery.summary?.greet?.greet_quota || null,
        control: compactActionControl(discovery.summary?.greet?.control)
      },
      favorite: {
        found: Boolean(discovery.summary?.favorite?.found),
        available: Boolean(discovery.summary?.favorite?.available),
        control: compactActionControl(discovery.summary?.favorite?.control)
      }
    },
    controls: (discovery.controls || []).slice(0, 20).map(compactActionControl)
  };
}

function compactLlmResult(llm) {
  if (!llm) return null;
  return {
    ok: Boolean(llm.ok),
    provider: llm.provider,
    passed: Boolean(llm.passed),
    cot: llm.cot || llm.decision_cot || "",
    decision_cot: llm.decision_cot || llm.cot || "",
    reasoning_content: llm.reasoning_content || "",
    raw_model_output: llm.raw_model_output || "",
    evidence_count: llm.evidence?.length || 0,
    usage: llm.usage,
    finish_reason: llm.finish_reason,
    raw_content_length: llm.raw_content_length,
    image_input_count: llm.image_input_count,
    image_inputs: llm.image_inputs,
    attempt: llm.attempt || 1,
    retry_errors: llm.retry_errors || [],
    screened_at: llm.screened_at
  };
}

function isRecoverableCandidateError(error) {
  const message = String(error?.message || error || "");
  return /Could not find node with given id|No node with given id|stale/i.test(message);
}

function compactConsoleResult(result) {
  return {
    status: result.status,
    generated_at: result.generated_at,
    chrome: result.chrome,
    request: result.request,
    llm_config: result.llm_config,
    runtime_guard_probe: result.runtime_guard_probe,
    search_application: result.search_application
      ? {
        applied: result.search_application.applied,
        search_params: result.search_application.search_params,
        post_search_state: result.search_application.post_search_state,
        validation: result.search_application_validation
      }
      : null,
    summary: result.summary,
    hard_failures: result.hard_failures,
    refresh_attempts: result.refresh_attempts,
    error: result.error,
    result_rows: (result.results || []).map((item) => ({
      index: item.index,
      candidate_key: item.candidate_key,
      identity: item.candidate?.identity || item.card_candidate?.identity || {},
      detail: item.detail,
      llm: item.llm
        ? {
          ok: item.llm.ok,
          passed: item.llm.passed,
          cot_length: String(item.llm.cot || item.llm.decision_cot || item.llm.reasoning_content || "").length,
          raw_model_output_length: String(item.llm.raw_model_output || "").length,
          image_input_count: item.llm.image_input_count,
          attempt: item.llm.attempt,
          retry_errors: item.llm.retry_errors
        }
        : null,
      post_action: item.post_action,
      llm_input_path: item.llm_input_path,
      close_result: item.close_result,
      error: item.error
    })),
    method_summary: result.method_summary,
    runtime_evaluate_used: result.runtime_evaluate_used,
    saved_report_path: result.saved_report_path,
    saved_csv_path: result.saved_csv_path
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

function detailRootNodeIds(openedDetail, contentWait) {
  const candidates = [
    contentWait?.detail_state?.popup?.node_id,
    contentWait?.detail_state?.resumeIframe?.node_id,
    openedDetail?.detail_state?.popup?.node_id,
    openedDetail?.detail_state?.resumeIframe?.node_id
  ];
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function acquireCandidateDetail({
  client,
  networkRecorder,
  cvAcquisitionState,
  cardCandidate,
  cardNodeId,
  candidateKey,
  index,
  targetUrl,
  options
}) {
  networkRecorder.clear();
  const openedDetail = await openRecruitCardDetail(client, cardNodeId, {
    timeoutMs: options.detailTimeoutMs
  });
  const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState, {
    networkWaitMs: options.networkWaitMs,
    networkRetryWaitMs: options.networkRetryWaitMs,
    imageModeGraceMs: options.imageModeGraceMs
  });
  const networkWait = await waitForCvNetworkEvents(
    waitForRecruitDetailNetworkEvents,
    networkRecorder,
    {
      waitPlan,
      minCount: 1,
      requireLoaded: true,
      intervalMs: options.networkIntervalMs
    }
  );
  const contentWait = await waitForRecruitDetailContent(client, {
    minTextLength: 1,
    timeoutMs: options.detailContentTimeoutMs,
    intervalMs: 250
  });
  const effectiveDetailState = contentWait.detail_state || openedDetail.detail_state;
  const detailResult = await extractRecruitDetailCandidate(client, {
    cardCandidate,
    cardNodeId,
    detailState: effectiveDetailState,
    detailHtml: contentWait.ok ? contentWait.detail_html : null,
    networkEvents: networkRecorder.events,
    targetUrl,
    closeDetail: false
  });
  detailResult.card_box = openedDetail.card_box || null;
  detailResult.open_attempts = openedDetail.open_attempts || [];

  const parsedNetworkProfileCount = countParsedNetworkProfiles(detailResult);
  let source = "network";
  let imageEvidence = null;
  if (parsedNetworkProfileCount > 0) {
    recordCvNetworkHit(cvAcquisitionState, {
      parsedNetworkProfileCount,
      waitResult: networkWait
    });
  } else {
    const captureNodeId = effectiveDetailState?.popup?.node_id
      || effectiveDetailState?.resumeIframe?.node_id
      || null;
    if (captureNodeId) {
      const imageBase = path.join(
        ensureDir(options.imageDir),
        `candidate-${String(index + 1).padStart(2, "0")}.${options.imageFormat === "jpeg" ? "jpg" : "png"}`
      );
      imageEvidence = await captureScrolledNodeScreenshots(client, captureNodeId, {
        filePath: imageBase,
        format: options.imageFormat,
        quality: Number.isFinite(options.imageQuality) ? options.imageQuality : undefined,
        padding: 4,
        maxScreenshots: options.maxImagePages,
        wheelDeltaY: options.imageWheelDeltaY,
        settleMs: options.slowLive ? 1800 : 1200,
        metadata: {
          domain: "recruit",
          list: "search",
          capture_mode: "scroll_sequence",
          acquisition_reason: "network_miss_image_fallback",
          phase: "phase10-search",
          run_candidate_index: index,
          candidate_key: candidateKey
        }
      });
      source = "image";
      recordCvImageFallback(cvAcquisitionState, {
        parsedNetworkProfileCount,
        waitResult: networkWait,
        imageEvidence
      });
    } else {
      source = "missing_capture_node";
      recordCvNetworkMiss(cvAcquisitionState, {
        reason: "network_miss_no_capture_node",
        parsedNetworkProfileCount,
        waitResult: networkWait
      });
    }
  }

  detailResult.image_evidence = imageEvidence;
  detailResult.cv_acquisition = {
    source,
    mode_after: compactCvAcquisitionState(cvAcquisitionState).mode,
    wait_plan: waitPlan,
    network_wait: networkWait,
    parsed_network_profile_count: parsedNetworkProfileCount,
    image_evidence: summarizeImageEvidence(imageEvidence),
    content_wait: {
      ok: contentWait.ok,
      elapsed_ms: contentWait.elapsed_ms,
      text_length: contentWait.text_length,
      error: contentWait.error || null
    }
  };
  return {
    openedDetail,
    contentWait,
    detailResult
  };
}

function saveCandidateLlmInput({
  options,
  index,
  candidate,
  criteria,
  detailResult
}) {
  const dir = ensureDir(options.candidateInputDir);
  const filePath = path.join(dir, `candidate-${String(index + 1).padStart(2, "0")}-llm-input.json`);
  const payload = {
    schema_version: 1,
    saved_at: new Date().toISOString(),
    domain: "recruit",
    list: "search",
    phase: "phase10",
    index,
    criteria,
    candidate,
    cv_acquisition: detailResult?.cv_acquisition || null,
    image_evidence: summarizeImageEvidence(detailResult?.image_evidence || null),
    text_length_sent_to_llm: candidate?.text?.raw?.length || 0
  };
  return writeJsonFile(filePath, payload);
}

async function callScreeningLlmWithRetry({
  attempts = 2,
  ...args
} = {}) {
  const errors = [];
  const totalAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const result = await callScreeningLlm(args);
      return {
        ...result,
        attempt,
        retry_errors: errors
      };
    } catch (error) {
      const message = error?.message || String(error);
      errors.push({
        attempt,
        message
      });
      const retryable = /LLM response missing boolean passed decision|LLM response was not valid JSON|LLM request failed: 5\d\d|aborted|timeout|fetch failed/i.test(message);
      if (!retryable || attempt >= totalAttempts) {
        error.retry_errors = errors;
        throw error;
      }
      await sleep(1200 * attempt);
    }
  }
  throw new Error("LLM retry loop exhausted unexpectedly");
}

async function runPostAction({
  client,
  options,
  greetCount,
  llm,
  actionDiscovery,
  lastGreetQuotaAfterSpend = null
}) {
  const result = {
    requested: options.postAction,
    execute_post_action: Boolean(options.executePostAction),
    eligible: Boolean(llm?.passed),
    action_attempted: false,
    action_clicked: false,
    counted_as_greet: false,
    reason: ""
  };

  if (!llm?.passed) {
    result.reason = "llm_not_passed";
    return result;
  }
  if (options.postAction !== "greet") {
    result.reason = "post_action_none_or_unsupported";
    return result;
  }
  if (Number.isInteger(options.maxGreetCount) && options.maxGreetCount > 0 && greetCount >= options.maxGreetCount) {
    result.reason = "max_greet_count_reached";
    return result;
  }

  const greet = actionDiscovery?.summary?.greet || {};
  result.control = compactActionControl(greet.control);
  if (!greet.found) {
    if (lastGreetQuotaAfterSpend?.exhausted_after_spend) {
      result.reason = "greet_credits_exhausted";
      result.out_of_greet_credits = true;
      result.stop_run = true;
      result.greet_quota_after_last_click = lastGreetQuotaAfterSpend;
      return result;
    }
    result.reason = "greet_control_not_found";
    return result;
  }
  if (greet.continue_chat) {
    result.reason = "already_connected_continue_chat";
    result.already_connected = true;
    return result;
  }
  const greetQuota = greet.control?.greet_quota || parseGreetQuota(greet.control?.label || "");
  result.greet_quota = greetQuota.found ? greetQuota : null;
  if (greetQuota.exhausted) {
    result.reason = "greet_credits_exhausted";
    result.out_of_greet_credits = true;
    result.stop_run = true;
    return result;
  }
  if (!greet.available || greet.control?.disabled) {
    result.reason = "greet_control_not_available";
    return result;
  }
  if (!options.executePostAction) {
    result.reason = "dry_run_post_action";
    result.would_click = true;
    return result;
  }

  result.action_attempted = true;
  result.control_before = compactActionControl(greet.control);
  const clickResult = await clickRecruitActionControl(client, greet.control);
  result.click_result = clickResult;
  result.action_clicked = true;
  result.greet_quota_after_click = describeGreetQuotaAfterSpend(greetQuota.found ? greetQuota : greet.control?.label || "");
  await sleep(1800);
  const afterDiscovery = await waitForRecruitDetailActionControls(client, {
    rootNodeIds: [greet.control.node_id],
    timeoutMs: 3000,
    intervalMs: 500,
    requireAny: false
  });
  result.after_click_discovery = compactActionDiscovery(afterDiscovery);
  result.counted_as_greet = true;
  result.reason = "clicked";
  return result;
}

function buildPhase10CsvInputRows(options = {}) {
  const searchParams = searchParamsFromOptions(options);
  return buildLegacyScreenInputRows({
    instruction: "Boss search Phase 10 live criteria run",
    selectedPage: "search",
    selectedJob: {
      value: options.job || options.keyword,
      title: options.job || options.keyword,
      label: options.job || options.keyword
    },
    userSearchParams: cloneReportInput(searchParams, {}),
    effectiveSearchParams: cloneReportInput(searchParams, {}),
    screenParams: {
      criteria: options.criteria,
      target_count: options.targetCount,
      post_action: options.postAction,
      max_greet_count: options.maxGreetCount
    },
    followUp: null
  });
}

function writePhase10CsvFile(filePath, result = {}, options = {}) {
  return writeLegacyScreenCsv(filePath, {
    inputRows: buildPhase10CsvInputRows(options),
    results: result.results || []
  });
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (!["greet", "none"].includes(options.postAction)) {
    throw new Error(`Unsupported search post action: ${options.postAction}. Use greet or none.`);
  }
  const startedAt = Date.now();
  let session;
  const searchParams = searchParamsFromOptions(options);
  const humanBehavior = normalizeHumanBehaviorOptions({
    enabled: options.executePostAction && options.postAction === "greet",
    profile: "paced_with_rests",
    restLevel: options.restLevel
  });
  const humanRestController = createHumanRestController({
    enabled: humanBehavior.restEnabled,
    shortRestEnabled: humanBehavior.shortRest,
    batchRestEnabled: humanBehavior.batchRest,
    restLevel: humanBehavior.restLevel
  });
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    },
    request: {
      page: "搜索页",
      search_params: searchParams,
      target_count: options.targetCount,
      max_screened: options.maxScreened,
      post_action: options.postAction,
      max_greet_count: options.maxGreetCount,
      initial_greet_count: options.initialGreetCount,
      execute_post_action: options.executePostAction,
      human_behavior: humanBehavior,
      rest_level: humanBehavior.restLevel,
      criteria: options.criteria
    }
  };

  try {
    if (options.executePostAction && !normalizeText(options.job)) {
      throw new Error("Boss search mutating post-action requires an explicit --job value from the user; select the job next to the keyword input before greeting candidates.");
    }
    const llmConfig = readJsonFile(options.configPath);
    const effectiveLlmConfig = {
      ...llmConfig,
      llmTimeoutMs: options.llmTimeoutMs,
      timeoutMs: options.llmTimeoutMs
    };
    if (Number.isInteger(options.llmMaxRetries) && options.llmMaxRetries >= 0) {
      effectiveLlmConfig.llmMaxRetries = options.llmMaxRetries;
      effectiveLlmConfig.maxRetries = options.llmMaxRetries;
    }
    result.llm_config = {
      path: path.resolve(options.configPath),
      baseUrl: safeHost(effectiveLlmConfig.baseUrl),
      model: effectiveLlmConfig.model || null,
      has_api_key: Boolean(effectiveLlmConfig.apiKey),
      timeout_ms: effectiveLlmConfig.llmTimeoutMs,
      max_retries: effectiveLlmConfig.llmMaxRetries ?? effectiveLlmConfig.maxRetries ?? null,
      wrapper_attempts: options.llmAttempts
    };

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
    await bringPageToFront(client);
    if (options.allowNavigate && !String(target.url || "").includes(options.targetUrlIncludes)) {
      await client.Page.navigate({ url: RECRUIT_TARGET_URL });
      await sleep(options.slowLive ? 12000 : 5000);
      result.chrome.navigated_to = RECRUIT_TARGET_URL;
      const ready = await waitForRecruitSearchControls(client, {
        timeoutMs: options.searchTimeoutMs,
        intervalMs: 1000
      });
      result.chrome.navigate_ready = ready;
      if (!ready.ok) throw new Error("Recruit search page did not become ready after navigation");
    }

    await closeRecruitDetail(client, { attemptsLimit: 2 });
    result.search_application = await applyRecruitSearchParams(client, {
      searchParams,
      requireCards: true,
      resetBeforeApply: options.resetSearch,
      searchTimeoutMs: options.searchTimeoutMs,
      resetTimeoutMs: options.resetTimeoutMs,
      resetSettleMs: options.resetSettleMs,
      cityOptionTimeoutMs: options.cityOptionTimeoutMs
    });
    result.search_application_validation = validateSearchApplication(searchParams, result.search_application);
    progress("search_applied", {
      card_count: result.search_application.post_search_state?.counts?.candidate_card || 0,
      no_data: result.search_application.post_search_state?.counts?.no_data || 0
    });

    let rootState = await getRecruitRoots(client);
    let cardNodeIds = await waitForRecruitCardNodeIds(client, rootState.iframe.documentNodeId, {
      timeoutMs: options.cardTimeoutMs,
      intervalMs: 500
    });
    if (!cardNodeIds.length) {
      throw new Error("No recruit/search cards found after applying search criteria");
    }

    const networkRecorder = createRecruitDetailNetworkRecorder(client);
    const cvAcquisitionState = createCvAcquisitionState({ mode: "unknown" });
    const listState = createInfiniteListState({
      domain: "recruit",
      listName: "phase10-search-full"
    });
    const results = [];
    const refreshAttempts = [];
    let greetCount = Math.max(0, Number(options.initialGreetCount) || 0);
    let newGreetCount = 0;
    let lastGreetQuotaAfterSpend = null;
    let refreshRounds = 0;
    let listEndReason = "";
    let stopRunReason = "";
    const targetCountGoal = Math.max(1, Number(options.targetCount) || 1);
    const maxScreenedGoal = Math.max(1, Number(options.maxScreened) || 1);
    const targetAchievementMode = options.executePostAction && options.postAction === "greet"
      ? "greet_clicked"
      : "llm_passed";
    const countPassedResults = () => results.filter((item) => item.llm?.passed).length;
    const targetMet = () => (
      targetAchievementMode === "greet_clicked"
        ? newGreetCount >= targetCountGoal
        : countPassedResults() >= targetCountGoal
    );

    while (
      results.length < maxScreenedGoal
      && !targetMet()
      && (
        !Number.isInteger(options.maxGreetCount)
        || options.maxGreetCount <= 0
        || greetCount < options.maxGreetCount
      )
    ) {
      const nextCandidateResult = await getNextInfiniteListCandidate({
        client,
        state: listState,
        maxScrolls: options.listMaxScrolls,
        stableSignatureLimit: options.listStableSignatureLimit,
        wheelDeltaY: options.listWheelDeltaY,
        settleMs: options.listSettleMs,
        fallbackPoint: options.listFallbackPoint,
        findNodeIds: async () => {
          const currentRootState = await getRecruitRoots(client);
          const currentCardNodeIds = await waitForRecruitCardNodeIds(
            client,
            currentRootState.iframe.documentNodeId,
            {
              timeoutMs: Math.min(options.cardTimeoutMs, 15000),
              intervalMs: 500
            }
          );
          cardNodeIds = currentCardNodeIds;
          return currentCardNodeIds;
        },
        readCandidate: async (nodeId, { visibleIndex }) => readRecruitCardCandidate(client, nodeId, {
          targetUrl: result.chrome.navigated_to || target.url,
          source: "phase10-search-card",
          metadata: {
            visible_index: visibleIndex
          }
        })
      });

      if (!nextCandidateResult.ok) {
        listEndReason = nextCandidateResult.reason || "list_exhausted";
        if (
          nextCandidateResult.end_reached
          && options.refreshOnEnd
          && refreshRounds < Math.max(0, Number(options.maxRefreshRounds) || 0)
        ) {
          refreshRounds += 1;
          const refreshResult = await refreshRecruitSearchAtEnd(client, {
            searchParams,
            requireCards: true,
            searchTimeoutMs: options.searchTimeoutMs,
            resetTimeoutMs: options.resetTimeoutMs,
            resetSettleMs: options.resetSettleMs,
            cityOptionTimeoutMs: options.cityOptionTimeoutMs
          });
          refreshAttempts.push({
            ok: Boolean(refreshResult.ok),
            method: refreshResult.method,
            forced_recent_viewed: Boolean(refreshResult.forced_recent_viewed),
            card_count: refreshResult.card_count || 0,
            search_params: refreshResult.search_params,
            application_post_search_state: refreshResult.application?.post_search_state || null
          });
          if (refreshResult.ok) {
            rootState = await getRecruitRoots(client);
            resetInfiniteListForRefreshRound(listState, {
              reason: listEndReason,
              round: refreshRounds,
              method: refreshResult.method,
              metadata: {
                forced_recent_viewed: true
              }
            });
            listEndReason = "";
            continue;
          }
        }
        break;
      }

      const index = results.length;
      const cardNodeId = nextCandidateResult.item.node_id;
      const candidateKey = nextCandidateResult.item.key;
      const cardCandidate = nextCandidateResult.item.candidate;
      const candidateStartedAt = Date.now();
      const candidateResult = {
        index,
        candidate_key: candidateKey,
        card_node_id: cardNodeId,
        card_candidate: compactCandidate(cardCandidate),
        detail: null,
        llm: null,
        action_discovery: null,
        post_action: null,
        timings: {}
      };
      progress("candidate_started", {
        index,
        candidate_key: candidateKey,
        card_text_length: cardCandidate.text?.raw?.length || 0
      });

      try {
        const detailStartedAt = Date.now();
        const { openedDetail, contentWait, detailResult } = await acquireCandidateDetail({
          client,
          networkRecorder,
          cvAcquisitionState,
          cardCandidate,
          cardNodeId,
          candidateKey,
          index,
          targetUrl: result.chrome.navigated_to || target.url,
          options
        });
        candidateResult.timings.detail_open_ms = Date.now() - detailStartedAt;
        candidateResult.timings.network_cv_wait_ms = detailResult.cv_acquisition?.network_wait?.elapsed_ms || "";
        candidateResult.timings.screenshot_capture_ms = detailResult.image_evidence
          ? detailResult.image_evidence.screenshots?.reduce((sum, item) => sum + (item.elapsed_ms || 0), 0) || ""
          : "";
        candidateResult.detail = compactDetail(detailResult);
        candidateResult.candidate = compactCandidate(detailResult.candidate);
        progress("candidate_detail_acquired", {
          index,
          source: candidateResult.detail?.cv_acquisition?.source,
          parsed_network_profile_count: candidateResult.detail?.parsed_network_profile_count || 0,
          image_unique_screenshot_count: candidateResult.detail?.image_evidence?.unique_screenshot_count || 0
        });
        candidateResult.llm_input_path = saveCandidateLlmInput({
          options,
          index,
          candidate: detailResult.candidate,
          criteria: options.criteria,
          detailResult
        });

        const llmStartedAt = Date.now();
        const llm = await callScreeningLlmWithRetry({
          candidate: detailResult.candidate,
          criteria: options.criteria,
          config: effectiveLlmConfig,
          timeoutMs: options.llmTimeoutMs,
          imageEvidence: detailResult.image_evidence,
          maxImages: options.maxImagePages,
          imageDetail: effectiveLlmConfig.llmImageDetail || "high",
          attempts: options.llmAttempts
        });
        candidateResult.timings.text_model_ms = Date.now() - llmStartedAt;
        candidateResult.llm = compactLlmResult(llm);
        progress("candidate_llm_screened", {
          index,
          passed: Boolean(candidateResult.llm?.passed),
          model_ms: candidateResult.timings.text_model_ms
        });

        const currentDetailState = await waitForRecruitDetail(client, {
          timeoutMs: options.slowLive ? 8000 : 5000,
          intervalMs: 300
        });
        const rootNodeIds = detailRootNodeIds(
          { detail_state: currentDetailState || openedDetail.detail_state },
          { detail_state: currentDetailState || contentWait.detail_state }
        );
        const actionDiscovery = await waitForRecruitDetailActionControls(client, {
          rootNodeIds,
          timeoutMs: options.slowLive ? 12000 : 8000,
          intervalMs: 500,
          requireAny: false
        });
        candidateResult.action_discovery = compactActionDiscovery(actionDiscovery);
        progress("candidate_actions_discovered", {
          index,
          greet_found: Boolean(candidateResult.action_discovery?.summary?.greet?.found),
          greet_available: Boolean(candidateResult.action_discovery?.summary?.greet?.available),
          control_count: candidateResult.action_discovery?.controls?.length || 0
        });

        const actionStartedAt = Date.now();
        const actionResult = await runPostAction({
          client,
          options,
          greetCount,
          llm,
          actionDiscovery,
          lastGreetQuotaAfterSpend
        });
        candidateResult.timings.post_action_ms = Date.now() - actionStartedAt;
        candidateResult.post_action = actionResult;
        progress("candidate_post_action", {
          index,
          reason: actionResult.reason,
          clicked: Boolean(actionResult.action_clicked),
          counted_as_greet: Boolean(actionResult.counted_as_greet)
        });
        if (actionResult.counted_as_greet && actionResult.action_clicked) {
          greetCount += 1;
          newGreetCount += 1;
        }
        if (actionResult.greet_quota_after_click?.found) {
          lastGreetQuotaAfterSpend = actionResult.greet_quota_after_click;
        }
      } catch (error) {
        const recoverable = isRecoverableCandidateError(error);
        candidateResult.error = {
          name: error?.name || "Error",
          message: error?.message || String(error),
          retry_errors: error?.retry_errors || [],
          recoverable
        };
        candidateResult.skipped = recoverable;
        if (recoverable) {
          candidateResult.error_code = "recoverable_stale_candidate_node";
        }
        progress("candidate_error", {
          index,
          recoverable,
          message: candidateResult.error.message
        });
      } finally {
        const closeStartedAt = Date.now();
        try {
          candidateResult.close_result = await closeRecruitDetail(client);
        } catch (error) {
          candidateResult.close_result = {
            closed: false,
            error: error?.message || String(error)
          };
        }
        candidateResult.timings.close_detail_ms = Date.now() - closeStartedAt;
      }

      const restStartedAt = Date.now();
      const humanRest = await humanRestController.takeBreakIfNeeded({ sleepFn: sleep });
      candidateResult.human_rest = humanRest;
      if (humanRest.rested) {
        candidateResult.timings.human_rest_ms = Date.now() - restStartedAt;
        progress("human_rest", {
          index,
          rest_level: humanRest.rest_level,
          pause_ms: humanRest.pause_ms || candidateResult.timings.human_rest_ms,
          events: humanRest.events || []
        });
      }
      candidateResult.timings.total_ms = Date.now() - candidateStartedAt;
      results.push(candidateResult);
      result.status = "RUNNING";
      result.results = results;
      result.partial_summary = {
        processed: results.length,
        llm_passed: results.filter((item) => item.llm?.passed).length,
        new_greet_count: newGreetCount,
        target_count: targetCountGoal,
        max_screened: maxScreenedGoal,
        target_achievement_mode: targetAchievementMode,
        last_greet_quota_after_spend: lastGreetQuotaAfterSpend,
        human_rest: humanRestController.getState(),
        elapsed_ms: Date.now() - startedAt
      };
      result.saved_report_path = writeJsonFile(options.saveReport, result);
      markInfiniteListCandidateProcessed(listState, candidateKey, {
        status: candidateResult.error ? "error" : "processed",
        metadata: {
          result_index: index,
          candidate_id: candidateResult.candidate?.id || cardCandidate.id || null,
          llm_passed: Boolean(candidateResult.llm?.passed),
          action_clicked: Boolean(candidateResult.post_action?.action_clicked)
        }
      });

      if (candidateResult.post_action?.stop_run) {
        stopRunReason = candidateResult.post_action.reason || "post_action_stop";
        listEndReason = stopRunReason;
        break;
      }

      if (options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }

    const passedCount = results.filter((item) => item.llm?.passed).length;
    const detailOpenedCount = results.filter((item) => item.detail).length;
    const llmScreenedCount = results.filter((item) => item.llm?.ok).length;
    const actionAttemptedCount = results.filter((item) => item.post_action?.action_attempted).length;
    const actionClickedCount = results.filter((item) => item.post_action?.action_clicked).length;
    const targetCount = Math.max(1, Number(options.targetCount) || 1);
    const maxGreetCount = Number.isInteger(options.maxGreetCount) && options.maxGreetCount > 0
      ? options.maxGreetCount
      : null;
    const requiredGreetCount = options.executePostAction && options.postAction === "greet"
      ? Math.min(targetCount, maxGreetCount || targetCount)
      : 0;

    result.summary = {
      processed: results.length,
      detail_opened: detailOpenedCount,
      llm_screened: llmScreenedCount,
      llm_passed: passedCount,
      post_action_attempted: actionAttemptedCount,
      post_action_clicked: actionClickedCount,
      greet_count: greetCount,
      new_greet_count: newGreetCount,
      initial_greet_count: Math.max(0, Number(options.initialGreetCount) || 0),
      target_count: targetCount,
      target_achievement_mode: targetAchievementMode,
      target_met: targetAchievementMode === "greet_clicked"
        ? newGreetCount >= targetCount
        : passedCount >= targetCount,
      required_greet_count: requiredGreetCount,
      max_greet_count: maxGreetCount,
      last_greet_quota_after_spend: lastGreetQuotaAfterSpend,
      list_end_reason: listEndReason || null,
      stop_run_reason: stopRunReason || null,
      greet_credit_exhausted: stopRunReason === "greet_credits_exhausted",
      human_behavior: humanBehavior,
      human_rest: humanRestController.getState(),
      refresh_rounds: refreshRounds,
      refresh_attempts: refreshAttempts.length,
      candidate_list: compactInfiniteListState(listState),
      cv_acquisition: compactCvAcquisitionState(cvAcquisitionState),
      elapsed_ms: Date.now() - startedAt
    };
    result.refresh_attempts = refreshAttempts;
    result.results = results;

    assertNoForbiddenCdpCalls(methodLog);
    result.runtime_evaluate_used = false;
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;

    const hardFailures = [];
    if (detailOpenedCount < Math.min(results.length, targetCount)) hardFailures.push("detail_opened_below_target");
    if (llmScreenedCount < Math.min(results.length, targetCount)) hardFailures.push("llm_screened_below_target");
    if (stopRunReason === "greet_credits_exhausted") {
      hardFailures.push("greet_credits_exhausted");
    } else if (requiredGreetCount > 0 && newGreetCount < requiredGreetCount) {
      hardFailures.push("greet_target_not_met");
    }
    const unrecoveredErrors = results.filter((item) => item.error && !item.error.recoverable);
    const recoveredErrors = results.filter((item) => item.error?.recoverable);
    if (unrecoveredErrors.length) hardFailures.push("candidate_errors_present");
    if (recoveredErrors.length) {
      result.recovered_candidate_errors = recoveredErrors.map((item) => ({
        index: item.index,
        code: item.error_code || item.error?.name || "recoverable_candidate_error",
        message: item.error?.message || ""
      }));
    }

    result.status = hardFailures.length ? "FAIL" : "PASS";
    result.hard_failures = hardFailures;
    result.saved_report_path = writeJsonFile(options.saveReport, result);
    if (options.saveCsvEnabled) {
      result.saved_csv_path = writePhase10CsvFile(
        options.saveCsv || defaultLegacyCsvPathForReport(options.saveReport),
        result,
        options
      );
      result.saved_report_path = writeJsonFile(options.saveReport, result);
    }
    console.log(JSON.stringify(compactConsoleResult(result), null, 2));
    if (hardFailures.length) {
      process.exitCode = 1;
    }
  } catch (error) {
    result.status = "FAIL";
    result.error = {
      name: error?.name || "Error",
      message: error?.message || String(error),
      stack: error?.stack || "",
      cdp_method: error?.cdp_method || "",
      node_id: error?.node_id || null,
      discovered_dropdowns: error?.discovered_dropdowns || null,
      age_custom_attempts: error?.age_custom_attempts || null
    };
    if (session?.methodLog) {
      result.method_summary = methodSummary(session.methodLog);
      result.method_log = session.methodLog;
    }
    try {
      result.saved_report_path = writeJsonFile(options.saveReport, result);
      if (options.saveCsvEnabled && Array.isArray(result.results)) {
        result.saved_csv_path = writePhase10CsvFile(
          options.saveCsv || defaultLegacyCsvPathForReport(options.saveReport),
          result,
          options
        );
        result.saved_report_path = writeJsonFile(options.saveReport, result);
      }
    } catch {}
    console.error(JSON.stringify(compactConsoleResult(result), null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
