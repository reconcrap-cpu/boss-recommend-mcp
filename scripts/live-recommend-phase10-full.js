#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
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
import { parseGreetQuota } from "../src/core/greet-quota/index.js";
import {
  buildLegacyScreenInputRows,
  cloneReportInput,
  defaultLegacyCsvPathForReport,
  writeLegacyScreenCsv
} from "../src/core/reporting/legacy-csv.js";
import {
  buildRecommendFilterSelectionOptions,
  clickRecommendActionControl,
  closeRecommendDetail,
  createRecommendDetailNetworkRecorder,
  extractRecommendDetailCandidate,
  getRecommendRoots,
  openRecommendCardDetail,
  readRecommendCardCandidate,
  refreshRecommendListAtEnd,
  RECOMMEND_TARGET_URL,
  resolveRecommendPostAction,
  selectAndConfirmFirstSafeFilter,
  selectRecommendJob,
  selectRecommendPageScope,
  waitForRecommendCardNodeIds,
  waitForRecommendDetailActionControls
} from "../src/domains/recommend/index.js";

const DEFAULT_CRITERIA = [
  "必须同时满足全部条件：",
  "1）如果有本科学历，本科学历必须为 211 及以上或 QS 前 500 海外院校；",
  "2）至少一段学历（可以是本科、硕士、博士）必须为 985、QS 前 100 海外院校或中科院；",
  "3）具备大模型 / AI / 图形学 / 图像 / 计算机视觉 / 3D相关的算法经验（工作、实习、项目、论文、科研、在校经历、自我介绍内有相关经验均可。必须是算法经验，纯产品、工程等不涉及算法的经验不算）。学校是否是985、211、qs排名等判断如果简历内没有明确标明，需要通过学校名称来判断，必须根据事实不能猜测排名，qs排名可以是过往任何一年的排名；",
  "4）必须是24年到27年应届生，需要通过人选最高学历的求学年份判断（比如：本科简历里写了2021 - 2025，应该理解为25年毕业，属于25年应届生）"
].join("\n");

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECOMMEND_TARGET_URL,
    configPath: "C:/Users/yaolin/.boss-recommend-mcp/screening-config.json",
    saveReport: ".live-artifacts/phase10-recommend-full-live.json",
    saveCsv: "",
    saveCsvEnabled: true,
    candidateInputDir: ".live-artifacts/phase10-recommend-llm-inputs",
    imageDir: ".live-artifacts/phase10-recommend-cv-images",
    job: "算法工程师 23-27届实习/校招/早期职业 _ 杭州",
    pageScope: "recommend",
    criteria: DEFAULT_CRITERIA,
    filters: [
      { group: "recentNotView", labels: ["近14天没有"], selectAllLabels: true },
      { group: "school", labels: ["985", "211", "国内外名校"], selectAllLabels: true },
      { group: "degree", labels: ["本科", "硕士", "博士"], selectAllLabels: true },
      { group: "gender", labels: ["男"], selectAllLabels: true }
    ],
    targetCount: 5,
    maxScreened: 20,
    postAction: "greet",
    maxGreetCount: null,
    initialGreetCount: 0,
    executePostAction: false,
    allowNavigate: true,
    detailTimeoutMs: 20000,
    cardTimeoutMs: 45000,
    networkIntervalMs: 150,
    maxImagePages: 10,
    imageFormat: "png",
    imageQuality: null,
    forceImageFallback: false,
    imageWheelDeltaY: 650,
    listMaxScrolls: 40,
    listStableSignatureLimit: 3,
    listWheelDeltaY: 850,
    listSettleMs: 2200,
    listFallbackPoint: { x: 700, y: 620 },
    refreshOnEnd: true,
    maxRefreshRounds: 2,
    refreshButtonSettleMs: 12000,
    refreshReloadSettleMs: 15000,
    llmTimeoutMs: 120000,
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
    if (arg === "--page-scope") result.pageScope = argv[++index];
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--filter") {
      const raw = String(argv[++index] || "");
      const [group, labelsRaw = ""] = raw.split(/[:=]/);
      result.filters.push({
        group: group.trim(),
        labels: labelsRaw.split(/[,，、|/]/).map((item) => item.trim()).filter(Boolean),
        selectAllLabels: true
      });
    }
    if (arg === "--replace-default-filters") result.filters = [];
    if (arg === "--target-count") result.targetCount = Number(argv[++index]);
    if (arg === "--max-screened") result.maxScreened = Number(argv[++index]);
    if (arg === "--post-action") result.postAction = argv[++index];
    if (arg === "--max-greet-count") result.maxGreetCount = Number(argv[++index]);
    if (arg === "--initial-greet-count") result.initialGreetCount = Number(argv[++index]);
    if (arg === "--execute-post-action") result.executePostAction = true;
    if (arg === "--dry-run-post-action") result.executePostAction = false;
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--detail-timeout-ms") result.detailTimeoutMs = Number(argv[++index]);
    if (arg === "--card-timeout-ms") result.cardTimeoutMs = Number(argv[++index]);
    if (arg === "--max-image-pages") result.maxImagePages = Number(argv[++index]);
    if (arg === "--image-format") result.imageFormat = argv[++index];
    if (arg === "--image-quality") result.imageQuality = Number(argv[++index]);
    if (arg === "--force-image-fallback") result.forceImageFallback = true;
    if (arg === "--list-max-scrolls") result.listMaxScrolls = Number(argv[++index]);
    if (arg === "--list-settle-ms") result.listSettleMs = Number(argv[++index]);
    if (arg === "--llm-timeout-ms") result.llmTimeoutMs = Number(argv[++index]);
    if (arg === "--delay-ms") result.delayMs = Number(argv[++index]);
    if (arg === "--no-refresh-on-end") result.refreshOnEnd = false;
    if (arg === "--max-refresh-rounds") result.maxRefreshRounds = Number(argv[++index]);
    if (arg === "--slow-live") {
      result.slowLive = true;
      result.cardTimeoutMs = Math.max(result.cardTimeoutMs, 90000);
      result.detailTimeoutMs = Math.max(result.detailTimeoutMs, 30000);
      result.listSettleMs = Math.max(result.listSettleMs, 3000);
      result.refreshButtonSettleMs = Math.max(result.refreshButtonSettleMs, 18000);
      result.refreshReloadSettleMs = Math.max(result.refreshReloadSettleMs, 22000);
      result.llmTimeoutMs = Math.max(result.llmTimeoutMs, 180000);
    }
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

function labelsWithoutUnlimited(labels = []) {
  return (labels || [])
    .map((label) => normalizeText(label))
    .filter((label) => label && label !== "不限" && label !== "全部" && label.toLowerCase() !== "all");
}

function recommendFiltersToSearchParams(filters = []) {
  const params = {
    school_tag: "不限",
    degree: "不限",
    gender: "不限",
    recent_not_view: "不限"
  };
  for (const filter of filters || []) {
    const labels = labelsWithoutUnlimited(filter.labels || filter.filterLabels);
    if (!labels.length) continue;
    if (filter.group === "school") params.school_tag = labels;
    if (filter.group === "degree") params.degree = labels;
    if (filter.group === "gender") params.gender = labels.length === 1 ? labels[0] : labels;
    if (filter.group === "recentNotView") params.recent_not_view = labels.length === 1 ? labels[0] : labels;
  }
  return params;
}

function selectedJobForCsv(result = {}, options = {}) {
  const option = result.job_selection?.selected_option || {};
  const fallback = normalizeText(options.job);
  return {
    value: option.value || option.id || "",
    title: option.title || option.label || fallback,
    label: option.label || option.title || fallback
  };
}

function buildPhase10CsvInputRows(result = {}, options = {}) {
  const searchParams = recommendFiltersToSearchParams(options.filters);
  return buildLegacyScreenInputRows({
    instruction: "Boss recommend Phase 10 live criteria run",
    selectedPage: "recommend",
    selectedJob: selectedJobForCsv(result, options),
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
    inputRows: buildPhase10CsvInputRows(result, options),
    results: result.results || []
  });
}

function ensureDir(dirPath) {
  const resolved = path.resolve(dirPath);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function compactCandidate(candidate = {}) {
  return {
    schema_version: candidate.schema_version || 1,
    domain: candidate.domain || "recommend",
    source: candidate.source || "",
    id: candidate.id || null,
    identity: candidate.identity || {},
    tags: candidate.tags || [],
    text_length: candidate.text?.raw?.length || 0,
    text_summary: candidate.text?.summary || ""
  };
}

function compactFilterResult(filterResult) {
  if (!filterResult) return null;
  return {
    opened_panel: Boolean(filterResult.opened_panel),
    selected_option: compactFilterOption(filterResult.selected_option),
    selected_options: (filterResult.selected_options || []).map(compactFilterOption),
    confirmed: Boolean(filterResult.confirmed),
    before_counts: filterResult.before_counts,
    after_open_counts: filterResult.after_open_counts,
    after_confirm_counts: filterResult.after_confirm_counts
  };
}

function compactFilterOption(option) {
  if (!option) return null;
  return {
    group: option.group,
    label: option.label,
    was_active: Boolean(option.was_active),
    clicked: option.clicked !== false,
    node_id: option.node_id
  };
}

function compactDetail(detailResult) {
  if (!detailResult) return null;
  return {
    popup_text_length: detailResult.detail?.popup_text?.length || 0,
    resume_text_length: detailResult.detail?.resume_text?.length || 0,
    network_body_count: detailResult.network_bodies?.filter((item) => item.body).length || 0,
    parsed_network_profile_count: detailResult.parsed_network_profiles?.filter((item) => item.ok).length || 0,
    cv_acquisition: detailResult.cv_acquisition || null,
    image_evidence: summarizeImageEvidence(detailResult.image_evidence),
    close_result: detailResult.close_result || null
  };
}

function compactActionDiscovery(discovery) {
  if (!discovery) return null;
  return {
    elapsed_ms: discovery.elapsed_ms,
    timed_out: Boolean(discovery.timed_out),
    detail_root_count: discovery.detail_root_count || 0,
    last_error: discovery.last_error || null,
    summary: discovery.summary,
    controls: (discovery.controls || [])
      .filter((control) => control.matches)
      .map((control) => ({
        kind: control.kind,
        root: control.root,
        selector: control.selector,
        node_id: control.node_id,
        visible: control.visible,
        matches: control.matches,
        active: control.active,
        available: control.available,
        continue_chat: control.continue_chat,
        disabled: control.disabled,
        greet_quota: control.greet_quota || null,
        label: control.label,
        class_name: control.class_name,
        center: control.center,
        rect: control.rect
      }))
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

function compactConsoleResult(result) {
  return {
    status: result.status,
    generated_at: result.generated_at,
    chrome: result.chrome,
    request: result.request,
    llm_config: result.llm_config,
    runtime_guard_probe: result.runtime_guard_probe,
    job_selection: result.job_selection
      ? {
        selected: result.job_selection.selected,
        already_current: Boolean(result.job_selection.already_current),
        selected_option: result.job_selection.selected_option,
        option_labels: (result.job_selection.options || []).map((option) => option.label)
      }
      : null,
    filter: result.filter
      ? {
        confirmed: result.filter.confirmed,
        selected_options: result.filter.selected_options,
        before_counts: result.filter.before_counts,
        after_confirm_counts: result.filter.after_confirm_counts
      }
      : null,
    summary: result.summary,
    hard_failures: result.hard_failures,
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

async function connectToRecommendSession(options) {
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
  const openedDetail = await openRecommendCardDetail(client, cardNodeId, {
    timeoutMs: options.detailTimeoutMs
  });
  const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState);
  const networkWait = await waitForCvNetworkEvents(
    waitForRecommendDetailNetworkEventsCompat,
    networkRecorder,
    {
      waitPlan,
      minCount: 1,
      requireLoaded: true,
      intervalMs: options.networkIntervalMs
    }
  );
  const detailResult = await extractRecommendDetailCandidate(client, {
    cardCandidate,
    cardNodeId,
    detailState: openedDetail.detail_state,
    networkEvents: networkRecorder.events,
    targetUrl,
    closeDetail: false
  });

  const parsedNetworkProfileCount = countParsedNetworkProfiles(detailResult);
  let source = "network";
  let imageEvidence = null;
  if (parsedNetworkProfileCount > 0 && !options.forceImageFallback) {
    recordCvNetworkHit(cvAcquisitionState, {
      parsedNetworkProfileCount,
      waitResult: networkWait
    });
  } else {
    const captureNodeId = openedDetail.detail_state?.popup?.node_id
      || openedDetail.detail_state?.resumeIframe?.node_id
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
          domain: "recommend",
          capture_mode: "scroll_sequence",
          acquisition_reason: options.forceImageFallback
            ? "forced_image_fallback_probe"
            : "network_miss_image_fallback",
          phase: "phase10",
          run_candidate_index: index,
          candidate_key: candidateKey
        }
      });
      source = "image";
      recordCvImageFallback(cvAcquisitionState, {
        reason: options.forceImageFallback ? "forced_image_fallback_probe" : "network_miss_image_fallback",
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
      force_image_fallback: Boolean(options.forceImageFallback),
      mode_after: compactCvAcquisitionState(cvAcquisitionState).mode,
    wait_plan: waitPlan,
    network_wait: networkWait,
    parsed_network_profile_count: parsedNetworkProfileCount,
    image_evidence: summarizeImageEvidence(imageEvidence)
  };
  return {
    openedDetail,
    detailResult
  };
}

async function waitForRecommendDetailNetworkEventsCompat(recorder, options) {
  const mod = await import("../src/domains/recommend/detail.js");
  return mod.waitForRecommendDetailNetworkEvents(recorder, options);
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
    domain: "recommend",
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

async function runPostAction({
  client,
  options,
  greetCount,
  llm,
  actionDiscovery
}) {
  const plan = resolveRecommendPostAction({
    postAction: options.postAction,
    greetCount,
    maxGreetCount: Number.isInteger(options.maxGreetCount) ? options.maxGreetCount : null
  });
  const result = {
    requested: options.postAction,
    execute_post_action: Boolean(options.executePostAction),
    plan,
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
  if (plan.effective === "none") {
    result.reason = plan.reason === "greet_limit_reached" ? "greet_limit_reached" : "post_action_none";
    return result;
  }

  const summary = actionDiscovery?.summary || {};
  const control = summary.greet;
  if (!control?.found) {
    result.reason = `${plan.effective}_control_not_found`;
    return result;
  }
  if (plan.effective === "greet" && control.continue_chat) {
    result.reason = "already_connected_continue_chat";
    result.already_connected = true;
    result.control = control;
    return result;
  }
  if (plan.effective === "greet") {
    const greetQuota = control.greet_quota || parseGreetQuota(control.label || "");
    result.greet_quota = greetQuota.found ? greetQuota : null;
    if (greetQuota.exhausted) {
      result.reason = "greet_credits_exhausted";
      result.out_of_greet_credits = true;
      result.stop_run = true;
      result.control = {
        ...control,
        greet_quota: result.greet_quota
      };
      return result;
    }
  }
  if (plan.effective === "greet" && control.available === false) {
    result.reason = "greet_control_not_available";
    result.control = control;
    return result;
  }
  if (control.disabled) {
    result.reason = `${plan.effective}_control_disabled`;
    return result;
  }
  if (!options.executePostAction) {
    result.reason = "dry_run_post_action";
    result.would_click = true;
    result.control = control;
    return result;
  }

  result.action_attempted = true;
  result.control_before = control;
  const clickResult = await clickRecommendActionControl(client, {
    ...control,
    kind: plan.effective
  });
  result.click_result = clickResult;
  result.action_clicked = true;
  await sleep(1800);
  const afterDiscovery = await waitForRecommendDetailActionControls(client, {
    timeoutMs: 6000,
    intervalMs: 400,
    requireAny: false
  });
  result.after_click_discovery = compactActionDiscovery(afterDiscovery);
  result.counted_as_greet = plan.effective === "greet";
  result.reason = "clicked";
  return result;
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

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (!["greet", "none"].includes(options.postAction)) {
    throw new Error(`Unsupported recommend post action: ${options.postAction}. Use greet or none.`);
  }
  const startedAt = Date.now();
  let session;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    },
    request: {
      page: "推荐页",
      page_scope: options.pageScope,
      job: options.job,
      filters: options.filters,
      target_count: options.targetCount,
      max_screened: options.maxScreened,
      post_action: options.postAction,
      max_greet_count: options.maxGreetCount,
      initial_greet_count: options.initialGreetCount,
      execute_post_action: options.executePostAction,
      force_image_fallback: options.forceImageFallback,
      criteria: options.criteria
    }
  };

  try {
    const llmConfig = readJsonFile(options.configPath);
    result.llm_config = {
      path: path.resolve(options.configPath),
      baseUrl: String(llmConfig.baseUrl || "").replace(/\/\/[^/]+/, "//[redacted-host]"),
      model: llmConfig.model || null,
      has_api_key: Boolean(llmConfig.apiKey)
    };
    session = await connectToRecommendSession(options);
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };

    await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
    await bringPageToFront(client);
    if (options.allowNavigate && !String(target.url || "").includes(options.targetUrlIncludes)) {
      await client.Page.navigate({ url: RECOMMEND_TARGET_URL });
      await sleep(options.slowLive ? 12000 : 5000);
      result.chrome.navigated_to = RECOMMEND_TARGET_URL;
    }

    await closeRecommendDetail(client, { attemptsLimit: 2 });
    let rootState = await getRecommendRoots(client);

    result.job_selection = await selectRecommendJob(client, rootState.iframe.documentNodeId, {
      jobLabel: options.job,
      settleMs: options.slowLive ? 12000 : 6000
    });
    if (!result.job_selection.selected) {
      throw new Error(`Requested recommend job was not selected: ${result.job_selection.reason}`);
    }
    rootState = await getRecommendRoots(client);
    result.page_scope = await selectRecommendPageScope(client, rootState.iframe.documentNodeId, {
      pageScope: options.pageScope,
      fallbackScope: "recommend",
      settleMs: options.slowLive ? 3000 : 1200,
      timeoutMs: options.slowLive ? 60000 : 20000
    });
    if (!result.page_scope.selected) {
      throw new Error(`Requested recommend page scope was not selected: ${result.page_scope.reason || options.pageScope}`);
    }
    rootState = await getRecommendRoots(client);

    const filterResult = await selectAndConfirmFirstSafeFilter(
      client,
      rootState.iframe.documentNodeId,
      buildRecommendFilterSelectionOptions({ filterGroups: options.filters })
    );
    result.filter = compactFilterResult(filterResult);
    if (!filterResult.confirmed) {
      throw new Error("Recommend filters were not confirmed");
    }

    let cardNodeIds = await waitForRecommendCardNodeIds(client, rootState.iframe.documentNodeId, {
      timeoutMs: options.cardTimeoutMs,
      intervalMs: 500
    });
    if (!cardNodeIds.length) {
      throw new Error("No recommend cards found after job/filter selection");
    }

    const networkRecorder = createRecommendDetailNetworkRecorder(client);
    const cvAcquisitionState = createCvAcquisitionState({ mode: "unknown" });
    const listState = createInfiniteListState({
      domain: "recommend",
      listName: "phase10-recommend-full"
    });
    const results = [];
    const refreshAttempts = [];
    let greetCount = Math.max(0, Number(options.initialGreetCount) || 0);
    let newGreetCount = 0;
    let refreshRounds = 0;
    let listEndReason = "";
    let stopRunReason = "";

    while (
      results.length < Math.max(1, Number(options.maxScreened) || 1)
      && greetCount < Math.max(1, Number(options.targetCount) || 1)
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
          const currentRootState = await getRecommendRoots(client);
          const currentCardNodeIds = await waitForRecommendCardNodeIds(client, currentRootState.iframe.documentNodeId, {
            timeoutMs: Math.min(options.cardTimeoutMs, 15000),
            intervalMs: 500
          });
          cardNodeIds = currentCardNodeIds;
          return currentCardNodeIds;
        },
        readCandidate: async (nodeId, { visibleIndex }) => readRecommendCardCandidate(client, nodeId, {
          targetUrl: target.url,
          source: "phase10-recommend-card",
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
          const refreshResult = await refreshRecommendListAtEnd(client, {
            rootState,
            jobLabel: options.job,
            pageScope: result.page_scope.effective_scope || options.pageScope,
            fallbackPageScope: "recommend",
            filter: { filterGroups: options.filters },
            forceRecentNotView: true,
            cardTimeoutMs: options.cardTimeoutMs,
            buttonSettleMs: options.refreshButtonSettleMs,
            reloadSettleMs: options.refreshReloadSettleMs
          });
          refreshAttempts.push({
            ok: Boolean(refreshResult.ok),
            method: refreshResult.method,
            forced_recent_not_view: Boolean(refreshResult.forced_recent_not_view),
            card_count: refreshResult.card_count || 0,
            page_scope: refreshResult.page_scope || null,
            filter: compactFilterResult(refreshResult.filter)
          });
          if (refreshResult.ok) {
            rootState = refreshResult.root_state || await getRecommendRoots(client);
            resetInfiniteListForRefreshRound(listState, {
              reason: listEndReason,
              round: refreshRounds,
              method: refreshResult.method,
              metadata: {
                forced_recent_not_view: true
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
      let candidateResult = {
        index,
        candidate_key: candidateKey,
        card_node_id: cardNodeId,
        card_candidate: compactCandidate(cardCandidate),
        detail: null,
        llm: null,
        action_discovery: null,
        post_action: null
      };

      try {
        const { detailResult } = await acquireCandidateDetail({
          client,
          networkRecorder,
          cvAcquisitionState,
          cardCandidate,
          cardNodeId,
          candidateKey,
          index,
          targetUrl: target.url,
          options
        });
        candidateResult.detail = compactDetail(detailResult);
        candidateResult.candidate = compactCandidate(detailResult.candidate);
        candidateResult.llm_input_path = saveCandidateLlmInput({
          options,
          index,
          candidate: detailResult.candidate,
          criteria: options.criteria,
          detailResult
        });

        const llm = await callScreeningLlmWithRetry({
          candidate: detailResult.candidate,
          criteria: options.criteria,
          config: llmConfig,
          timeoutMs: options.llmTimeoutMs,
          imageEvidence: detailResult.image_evidence,
          maxImages: options.maxImagePages,
          imageDetail: llmConfig.llmImageDetail || "high",
          attempts: 2
        });
        candidateResult.llm = compactLlmResult(llm);

        const actionDiscovery = await waitForRecommendDetailActionControls(client, {
          timeoutMs: options.slowLive ? 12000 : 8000,
          intervalMs: 500,
          requireAny: false
        });
        candidateResult.action_discovery = compactActionDiscovery(actionDiscovery);
        const actionResult = await runPostAction({
          client,
          options,
          greetCount,
          llm,
          actionDiscovery
        });
        candidateResult.post_action = actionResult;
        if (actionResult.counted_as_greet && actionResult.action_clicked) {
          greetCount += 1;
          newGreetCount += 1;
        }
      } catch (error) {
        candidateResult.error = {
          name: error?.name || "Error",
          message: error?.message || String(error)
        };
      } finally {
        try {
          candidateResult.close_result = await closeRecommendDetail(client);
        } catch (error) {
          candidateResult.close_result = {
            closed: false,
            error: error?.message || String(error)
          };
        }
      }

      results.push(candidateResult);
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
      required_greet_count: requiredGreetCount,
      max_greet_count: maxGreetCount,
      list_end_reason: listEndReason || null,
      stop_run_reason: stopRunReason || null,
      greet_credit_exhausted: stopRunReason === "greet_credits_exhausted",
      refresh_rounds: refreshRounds,
      refresh_attempts: refreshAttempts.length,
      candidate_list: compactInfiniteListState(listState),
      cv_acquisition: compactCvAcquisitionState(cvAcquisitionState),
      elapsed_ms: Date.now() - startedAt
    };
    result.refresh_attempts = refreshAttempts;
    result.results = results;

    result.runtime_guard_probe = assertNoForbiddenCdpCalls(methodLog);
    result.runtime_evaluate_used = false;
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;

    const hardFailures = [];
    if (detailOpenedCount < Math.min(results.length, targetCount)) hardFailures.push("detail_opened_below_target");
    if (llmScreenedCount < Math.min(results.length, targetCount)) hardFailures.push("llm_screened_below_target");
    if (stopRunReason === "greet_credits_exhausted") {
      hardFailures.push("greet_credits_exhausted");
    } else if (requiredGreetCount > 0 && greetCount < requiredGreetCount) {
      hardFailures.push("greet_target_not_met");
    }
    if (results.some((item) => item.error)) hardFailures.push("candidate_errors_present");

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
      message: error?.message || String(error)
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
