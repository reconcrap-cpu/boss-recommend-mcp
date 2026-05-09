import { captureScrolledNodeScreenshots } from "../../core/capture/index.js";
import { waitForCvCaptureTarget } from "../../core/cv-capture-target/index.js";
import {
  clickPoint,
  getNodeBox,
  scrollNodeIntoView,
  sleep
} from "../../core/browser/index.js";
import {
  compactCvAcquisitionState,
  countParsedNetworkProfiles,
  createCvAcquisitionState,
  DEFAULT_MAX_IMAGE_PAGES,
  getCvNetworkWaitPlan,
  recordCvImageFallback,
  recordCvNetworkHit,
  recordCvNetworkMiss,
  summarizeImageEvidence,
  waitForCvNetworkEvents
} from "../../core/cv-acquisition/index.js";
import {
  compactInfiniteListState,
  createInfiniteListState,
  detectInfiniteListBottomMarker,
  getNextInfiniteListCandidate,
  markInfiniteListCandidateProcessed,
  resetInfiniteListForRefreshRound,
  resolveInfiniteListFallbackPoint
} from "../../core/infinite-list/index.js";
import { createViewportRunGuard } from "../../core/self-heal/index.js";
import { createRunLifecycleManager } from "../../core/run/index.js";
import {
  addTiming,
  imageEvidenceFilePath,
  measureTiming
} from "../../core/run/timing.js";
import {
  callScreeningLlm,
  normalizeText,
  screenCandidate
} from "../../core/screening/index.js";
import {
  CHAT_BOTTOM_MARKER_SELECTORS,
  CHAT_CARD_SELECTORS,
  CHAT_LIST_CONTAINER_SELECTORS,
  CHAT_TARGET_URL
} from "./constants.js";
import {
  chatCandidateKeyFromProfile,
  findChatCandidateNodeIdById,
  readChatCardCandidate,
  waitForChatCandidateNodeIds
} from "./cards.js";
import {
  closeChatResumeModal,
  createChatProfileNetworkRecorder,
  extractChatProfileCandidate,
  isUnsafeChatOnlineResumeLinkError,
  openChatOnlineResume,
  quickChatResumeModalOpenProbe,
  readChatConversationReadyState,
  requestChatResumeForPassedCandidate,
  selectChatMessageFilter,
  selectChatPrimaryLabel,
  waitForChatOnlineResumeButton,
  waitForChatProfileNetworkEvents,
  waitForChatResumeContent
} from "./detail.js";
import { selectChatJob } from "./jobs.js";
import {
  getChatTopLevelState,
  isForbiddenChatResumeNavigationError,
  makeForbiddenChatResumeNavigationError,
  recoverChatShell
} from "./page-guard.js";
import { getChatRoots } from "./roots.js";

const DETAIL_SOURCES = new Set(["cascade", "network", "dom", "image"]);

function normalizeDetailSource(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return DETAIL_SOURCES.has(normalized) ? normalized : "cascade";
}

function compactScreening(screening) {
  return {
    status: screening.status,
    passed: screening.passed,
    score: screening.score,
    reasons: screening.reasons,
    candidate: {
      domain: screening.candidate?.domain || "chat",
      source: screening.candidate?.source || "",
      id: screening.candidate?.id || null,
      identity: screening.candidate?.identity || {}
    }
  };
}

function compactLlmResult(llmResult) {
  if (!llmResult) return null;
  return {
    ok: Boolean(llmResult.ok),
    provider: llmResult.provider || null,
    passed: llmResult.passed,
    cot: llmResult.cot || llmResult.decision_cot || "",
    reasoning_content: llmResult.reasoning_content || "",
    raw_model_output: llmResult.raw_model_output || "",
    evidence_count: llmResult.evidence?.length || 0,
    usage: llmResult.usage || null,
    finish_reason: llmResult.finish_reason || null,
    image_input_count: llmResult.image_input_count || 0,
    attempt_count: llmResult.attempt_count || 0,
    fallback_count: llmResult.fallback_count || 0,
    llm_model_failures: Array.isArray(llmResult.llm_model_failures) ? llmResult.llm_model_failures : [],
    error: llmResult.error || null
  };
}

function compactCandidate(candidate) {
  return {
    id: candidate?.id || null,
    identity: candidate?.identity || {},
    text_length: candidate?.text?.raw?.length || 0,
    tag_count: candidate?.tags?.length || 0
  };
}

function compactChatJobGuard(result = null) {
  if (!result || typeof result !== "object") return null;
  return {
    selected: Boolean(result.selected),
    verified: Boolean(result.verified),
    already_current: Boolean(result.already_current),
    requested: result.requested || null,
    reason: result.reason || null,
    selected_label: result.selected_label || result.selected_option?.label || null,
    selected_value: result.selected_option?.value || result.active_option?.value || null,
    active_label: result.active_option?.label || null,
    active_value: result.active_option?.value || null,
    menu_close: result.menu_close || null
  };
}

function compactDetail(detailResult) {
  if (!detailResult) return null;
  return {
    popup_text_length: detailResult.detail?.popup_text?.length || 0,
    content_text_length: detailResult.detail?.content_text?.length || 0,
    resume_iframe_text_length: detailResult.detail?.resume_iframe_text?.length || 0,
    network_body_count: detailResult.network_bodies?.filter((item) => item.body).length || 0,
    parsed_network_profile_count: detailResult.parsed_network_profiles?.filter((item) => item.ok).length || 0,
    cv_acquisition: detailResult.cv_acquisition || null,
    image_evidence: summarizeImageEvidence(detailResult.image_evidence),
    llm_screening: compactLlmResult(detailResult.llm_result),
    close_result: detailResult.close_result
  };
}

function resultOpenedDetail(result) {
  return Boolean(result?.detail && !result.detail?.cv_acquisition?.skipped);
}

export function countChatResultStatuses(results = []) {
  return {
    processed: results.length,
    screened: results.length,
    detail_opened: results.filter(resultOpenedDetail).length,
    llm_screened: results.filter((item) => item.detail?.llm_screening || item.llm_screening).length,
    passed: results.filter((item) => item.screening?.passed).length,
    skipped: results.filter((item) => item.screening?.status === "skip").length
  };
}

export function chatDetailSkipReasonFromReadyState(state = {}) {
  if (state?.attachment_resume_enabled) return "attachment_resume_already_available";
  return "";
}

export function makeChatResumeModalOpenBeforeCandidateClickError(closeResult = null) {
  const error = new Error("CHAT_RESUME_MODAL_OPEN_BEFORE_CANDIDATE_CLICK");
  error.code = "CHAT_RESUME_MODAL_OPEN_BEFORE_CANDIDATE_CLICK";
  error.close_result = closeResult || null;
  return error;
}

export function isChatResumeModalCloseFailureError(error) {
  return error?.code === "CHAT_RESUME_MODAL_OPEN_BEFORE_CANDIDATE_CLICK"
    || /CHAT_RESUME_MODAL_OPEN_BEFORE_CANDIDATE_CLICK/i.test(String(error?.message || error || ""));
}

export async function ensureNoOpenChatResumeModalBeforeCandidateClick(client, {
  closeAttempts = 3
} = {}) {
  const probe = await quickChatResumeModalOpenProbe(client);
  if (!probe.open) {
    return {
      closed: true,
      already_closed: true,
      probe
    };
  }
  const closeResult = await closeChatResumeModal(client, { attemptsLimit: closeAttempts });
  if (closeResult?.closed) {
    return {
      closed: true,
      already_closed: false,
      probe,
      close_result: closeResult
    };
  }
  throw makeChatResumeModalOpenBeforeCandidateClickError(closeResult);
}

function llmToScreening(llmResult, candidate) {
  return {
    status: llmResult?.passed ? "pass" : "fail",
    passed: Boolean(llmResult?.passed),
    score: llmResult?.passed ? 100 : 0,
    reasons: llmResult?.error ? ["llm_invalid_response"] : [],
    candidate
  };
}

export function captureNodeIdFromResumeState(resumeState) {
  return resumeState?.content?.node_id
    || resumeState?.resumeIframe?.node_id
    || resumeState?.popup?.node_id
    || null;
}

export function resolveChatDomFallbackWait({
  normalizedDetailSource = "cascade",
  parsedNetworkProfileCount = 0,
  waitPlan = null,
  resumeDomTimeoutMs = 60000
} = {}) {
  const detailSource = normalizeDetailSource(normalizedDetailSource);
  const configuredTimeoutMs = Math.max(0, Number(resumeDomTimeoutMs) || 0);
  if (detailSource === "image") {
    return {
      skipped: false,
      timeout_ms: Math.min(configuredTimeoutMs, 3500),
      configured_timeout_ms: configuredTimeoutMs,
      short_probe: true,
      reason: "forced_image_modal_probe"
    };
  }
  if (detailSource === "dom") {
    return {
      skipped: false,
      timeout_ms: configuredTimeoutMs,
      configured_timeout_ms: configuredTimeoutMs,
      short_probe: false,
      reason: "dom_source_full_wait"
    };
  }

  const profileCount = Math.max(0, Number(parsedNetworkProfileCount) || 0);
  const previousImageMode = waitPlan?.mode_before === "image";
  if (profileCount > 0) {
    return {
      skipped: false,
      timeout_ms: Math.min(configuredTimeoutMs, previousImageMode ? 1500 : 3500),
      configured_timeout_ms: configuredTimeoutMs,
      short_probe: true,
      reason: previousImageMode
        ? "previous_image_mode_profile_only_network_short_dom_probe"
        : "profile_only_network_short_dom_probe"
    };
  }
  if (previousImageMode) {
    return {
      skipped: false,
      timeout_ms: Math.min(configuredTimeoutMs, 2500),
      configured_timeout_ms: configuredTimeoutMs,
      short_probe: true,
      reason: "previous_image_mode_network_miss_short_dom_probe"
    };
  }
  return {
    skipped: false,
    timeout_ms: configuredTimeoutMs,
    configured_timeout_ms: configuredTimeoutMs,
    short_probe: false,
    reason: "cascade_full_dom_wait"
  };
}

function isRecoverableCdpNodeError(error) {
  return /(?:Could not find node|No node with given id|Cannot find node|Could not compute box model)/i
    .test(String(error?.message || error || ""));
}

function isRecoverableLlmScreeningError(error) {
  return /(?:LLM response missing boolean passed decision|LLM response was not valid JSON)/i
    .test(String(error?.message || error || ""));
}

function createFailedLlmResult(error) {
  return {
    ok: false,
    passed: false,
    reason: "",
    evidence: [],
    cot: "",
    decision_cot: "",
    reasoning_content: "",
    raw_model_output: "",
    attempt_count: Number(error?.llm_attempt_count) || 0,
    fallback_count: Array.isArray(error?.llm_model_failures) ? error.llm_model_failures.length : 0,
    llm_model_failures: Array.isArray(error?.llm_model_failures) ? error.llm_model_failures : [],
    error: error?.message || String(error || "unknown"),
    screened_at: new Date().toISOString()
  };
}

function normalizeScreeningMode(value) {
  const normalized = String(value || "llm").trim().toLowerCase();
  return ["deterministic", "local", "local_scorer"].includes(normalized)
    ? "deterministic"
    : "llm";
}

function createMissingLlmConfigResult() {
  return createFailedLlmResult(new Error("LLM screening config is required for production chat runs"));
}

function createSkippedDetailResult(cardCandidate, reason, error = null) {
  return {
    candidate: cardCandidate,
    parsed_network_profiles: [],
    network_bodies: [],
    detail: {},
    cv_acquisition: {
      source: reason,
      skipped: true,
      error: error?.message || null,
      error_code: error?.code || null
    },
    close_result: null
  };
}

function compactChatRuntimeError(error) {
  if (!error) return null;
  return {
    name: error.name || "Error",
    code: error.code || null,
    message: error.message || String(error),
    close_result: error.close_result || null,
    page_state: error.page_state || null
  };
}

const CHAT_FULL_CV_DOM_MIN_TEXT_LENGTH = 500;
const CHAT_FULL_CV_DOM_MIN_SECTION_TEXT_LENGTH = 180;
const CHAT_FULL_CV_NETWORK_MIN_TEXT_LENGTH = 650;
const CHAT_FULL_CV_NETWORK_MIN_RICH_ITEM_COUNT = 3;
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
const CHAT_FULL_CV_SECTION_PATTERNS = Object.freeze([
  /教育(?:经历|背景|经验)?/i,
  /工作(?:经历|经验)?/i,
  /项目(?:经历|经验)?/i,
  /实习(?:经历|经验)?/i,
  /科研(?:经历|经验)?/i,
  /论文|会议|专利/i,
  /个人(?:优势|总结|介绍|评价)/i,
  /专业技能|技能(?:特长|标签)?/i,
  /求职(?:期望|意向)/i,
  /校园经历|在校经历|竞赛|证书/i
]);

function detailTextForFullCvCheck(detailResult = {}) {
  return [
    detailResult?.detail?.popup_text,
    detailResult?.detail?.content_text,
    detailResult?.detail?.resume_iframe_text
  ].filter(Boolean).join("\n\n");
}

function resumeSectionMatchCount(text = "") {
  const normalized = normalizeText(text);
  if (!normalized) return 0;
  return CHAT_FULL_CV_SECTION_PATTERNS
    .filter((pattern) => pattern.test(normalized))
    .length;
}

function hasResumeLikeDomText(text = "") {
  const normalized = normalizeText(text);
  if (normalized.length >= CHAT_FULL_CV_DOM_MIN_TEXT_LENGTH) return true;
  return normalized.length >= CHAT_FULL_CV_DOM_MIN_SECTION_TEXT_LENGTH
    && resumeSectionMatchCount(normalized) >= 2;
}

function networkProfileTextLength(profileResult = {}) {
  return normalizeText(profileResult?.profile?.text || "").length;
}

function isFullCvNetworkProfile(profileResult = {}) {
  if (!profileResult?.ok) return false;
  const sourceKeys = profileResult.profile?.source_keys || {};
  const textLength = networkProfileTextLength(profileResult);
  const sectionCount = resumeSectionMatchCount(profileResult.profile?.text || "");
  const richItemCount = [
    "education_count",
    "work_count",
    "project_count",
    "expectation_count",
    "certification_count"
  ].reduce((sum, key) => sum + (Number(sourceKeys[key]) || 0), 0);
  const hasResumeSections = sectionCount >= 3 || (sectionCount >= 2 && richItemCount >= 2);
  const hasEnoughNetworkText = textLength >= CHAT_FULL_CV_NETWORK_MIN_TEXT_LENGTH;

  if (sourceKeys.geek_detail_info || sourceKeys.geek_detail) {
    return hasEnoughNetworkText && (
      hasResumeSections
      || richItemCount >= CHAT_FULL_CV_NETWORK_MIN_RICH_ITEM_COUNT
    );
  }
  if (sourceKeys.network_html_text) {
    return textLength >= CHAT_FULL_CV_NETWORK_MIN_TEXT_LENGTH
      && sectionCount >= 2;
  }
  if (sourceKeys.chat_history_resume) {
    const educationCount = Number(sourceKeys.education_count) || 0;
    const workCount = Number(sourceKeys.work_count) || 0;
    return (educationCount + workCount) >= 2
      && textLength >= CHAT_FULL_CV_NETWORK_MIN_TEXT_LENGTH
      && sectionCount >= 2;
  }
  return false;
}

function hasUsableImageEvidence(imageEvidence = null) {
  if (!imageEvidence || imageEvidence.ok === false) return false;
  return Boolean(
    (Array.isArray(imageEvidence.llm_file_paths) && imageEvidence.llm_file_paths.length)
    || (Array.isArray(imageEvidence.file_paths) && imageEvidence.file_paths.length)
    || Number(imageEvidence.llm_screenshot_count) > 0
    || Number(imageEvidence.unique_screenshot_count) > 0
    || Number(imageEvidence.screenshot_count) > 0
    || Number(imageEvidence.capture_count) > 0
  );
}

export function summarizeChatFullCvEvidence({
  detailResult = null,
  contentWait = null,
  imageEvidence = null
} = {}) {
  const parsedProfiles = (detailResult?.parsed_network_profiles || []).filter((item) => item?.ok);
  const fullNetworkProfiles = parsedProfiles.filter(isFullCvNetworkProfile);
  const profileOnlyCount = Math.max(0, parsedProfiles.length - fullNetworkProfiles.length);
  const detailText = detailTextForFullCvCheck(detailResult);
  const domTextLength = detailText.length;
  const domSectionCount = resumeSectionMatchCount(detailText);
  const domFullCv = Boolean(contentWait?.ok) && hasResumeLikeDomText(detailText);
  const imageFullCv = hasUsableImageEvidence(imageEvidence);
  const source = fullNetworkProfiles.length
    ? "network"
    : domFullCv
      ? "dom"
      : imageFullCv
        ? "image"
        : null;
  return {
    full_cv_acquired: Boolean(source),
    source,
    network_full_cv_count: fullNetworkProfiles.length,
    network_profile_only_count: profileOnlyCount,
    parsed_network_profile_count: parsedProfiles.length,
    dom_full_cv: domFullCv,
    dom_text_length: domTextLength,
    dom_section_count: domSectionCount,
    content_wait_ok: Boolean(contentWait?.ok),
    image_full_cv: imageFullCv,
    image_summary: summarizeImageEvidence(imageEvidence)
  };
}

async function resolveFreshChatCardNodeId(client, {
  fallbackNodeId,
  candidate,
  rootNodeId = null
} = {}) {
  const candidateId = candidate?.id || "";
  if (!candidateId) return fallbackNodeId;
  let currentRootNodeId = rootNodeId;
  if (!currentRootNodeId) {
    const rootState = await getChatRoots(client);
    currentRootNodeId = rootState.rootNodes.top;
  }
  const freshNodeId = await findChatCandidateNodeIdById(client, currentRootNodeId, candidateId);
  return freshNodeId || fallbackNodeId;
}

async function selectFreshChatCandidate(client, {
  cardNodeId,
  candidate,
  timeoutMs,
  settleMs = 1200
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modalGuard = await ensureNoOpenChatResumeModalBeforeCandidateClick(client);
    const rootState = await getChatRoots(client);
    const freshNodeId = await resolveFreshChatCardNodeId(client, {
      fallbackNodeId: cardNodeId,
      candidate,
      rootNodeId: rootState.rootNodes.top
    });
    try {
      await scrollNodeIntoView(client, freshNodeId);
      await sleep(250);
      const box = await getNodeBox(client, freshNodeId);
      await clickPoint(client, box.center.x, box.center.y);
      if (settleMs > 0) await sleep(settleMs);
      const ready = await waitForChatOnlineResumeButton(client, {
        timeoutMs,
        expectedCandidateId: candidate?.id || ""
      });
      return {
        card_box: box,
        ready,
        card_node_id: freshNodeId,
        refreshed_node: freshNodeId !== cardNodeId,
        modal_guard: modalGuard,
        attempt: attempt + 1
      };
    } catch (error) {
      lastError = error;
      if (!isRecoverableCdpNodeError(error)) throw error;
      await sleep(350);
    }
  }
  throw lastError || new Error("Chat candidate selection failed");
}

function selectedDetailNetworkEvents(detailSource, selectionEvents, resumeEvents) {
  if (detailSource !== "network" && detailSource !== "cascade") return [];
  return [
    ...(selectionEvents || []),
    ...(resumeEvents || [])
  ];
}

async function setupChatRunContext(client, {
  job,
  normalizedStartFrom,
  readyTimeoutMs,
  listSettleMs,
  runControl,
  ensureViewport = null
} = {}) {
  let rootState = await getChatRoots(client);
  if (ensureViewport) {
    rootState = await ensureViewport(rootState, "context_roots");
  }
  runControl.checkpoint({
    top_document_node_id: rootState.rootNodes.top
  });

  const primaryLabel = await selectChatPrimaryLabel(client, {
    label: "全部",
    timeoutMs: readyTimeoutMs,
    settleMs: listSettleMs
  });
  runControl.checkpoint({
    chat_context_step: "primary_label",
    primary_label: primaryLabel
  });

  const jobSelection = normalizeText(job)
    ? await selectChatJob(client, rootState.rootNodes.top, {
        jobLabel: job,
        timeoutMs: readyTimeoutMs,
        settleMs: listSettleMs
      })
    : {
        selected: false,
        reason: "job_not_requested"
      };
  if (normalizeText(job) && !jobSelection.selected) {
    throw new Error(`Chat job selection failed: ${jobSelection.reason || "unknown"}`);
  }
  if (normalizeText(job) && jobSelection.verified !== true) {
    throw new Error(`Chat job selection was not verified: requested=${jobSelection.requested || job}; selected=${jobSelection.selected_label || "unknown"}`);
  }
  rootState = await getChatRoots(client);
  if (ensureViewport) {
    rootState = await ensureViewport(rootState, "context_job");
  }
  runControl.checkpoint({
    chat_context_step: "job_selection",
    primary_label: primaryLabel,
    job_selection: jobSelection
  });

  const startFilter = await selectChatMessageFilter(client, {
    startFrom: normalizedStartFrom,
    timeoutMs: readyTimeoutMs,
    settleMs: listSettleMs
  });
  if (!startFilter.ok) {
    throw new Error(`Chat start filter selection failed: ${startFilter.error || "unknown"}`);
  }
  rootState = await getChatRoots(client);
  if (ensureViewport) {
    rootState = await ensureViewport(rootState, "context_start_filter");
  }
  runControl.checkpoint({
    chat_context_step: "start_filter",
    primary_label: primaryLabel,
    job_selection: jobSelection,
    start_filter: startFilter
  });

  return {
    rootState,
    contextSetup: {
      primary_label: primaryLabel,
      job_selection: jobSelection,
      start_filter: startFilter,
      requested_start_from: normalizedStartFrom
    }
  };
}

export async function runChatWorkflow({
  client,
  targetUrl = CHAT_TARGET_URL,
  job = "",
  startFrom = "all",
  criteria = "",
  maxCandidates = 5,
  targetPassCount = null,
  processUntilListEnd = false,
  detailLimit = null,
  detailSource = "cascade",
  closeResume = true,
  requestResumeForPassed = false,
  dryRunRequestCv = false,
  greetingText = "Hi同学，能麻烦发下简历吗？",
  delayMs = 0,
  cardTimeoutMs = 90000,
  readyTimeoutMs = 60000,
  onlineResumeButtonTimeoutMs = 30000,
  resumeDomTimeoutMs = 60000,
  maxImagePages = DEFAULT_MAX_IMAGE_PAGES,
  imageWheelDeltaY = 650,
  cvAcquisitionMode = "unknown",
  callLlmOnImage = false,
  llmConfig = null,
  llmTimeoutMs = 120000,
  llmImageLimit = 8,
  llmImageDetail = "high",
  screeningMode = "llm",
  listMaxScrolls = 20,
  listStableSignatureLimit = 5,
  listWheelDeltaY = 850,
  listSettleMs = 2200,
  listFallbackPoint = null,
  imageOutputDir = ""
} = {}, runControl) {
  if (!client) throw new Error("runChatWorkflow requires a guarded CDP client");
  const normalizedDetailSource = normalizeDetailSource(detailSource);
  const normalizedScreeningMode = normalizeScreeningMode(screeningMode);
  const useLlmScreening = normalizedScreeningMode !== "deterministic";
  const processedLimit = Math.max(1, Number(maxCandidates) || 1);
  const passTarget = Number.isFinite(Number(targetPassCount)) && Number(targetPassCount) > 0
    ? Number(targetPassCount)
    : null;
  const normalizedStartFrom = normalizeText(startFrom).toLowerCase() === "unread" ? "unread" : "all";
  const detailCountLimit = detailLimit == null ? processedLimit : Math.max(0, Number(detailLimit) || 0);
  const networkRecorder = detailCountLimit > 0
    ? createChatProfileNetworkRecorder(client)
    : null;
  const cvAcquisitionState = createCvAcquisitionState({ mode: cvAcquisitionMode });
  const listState = createInfiniteListState({
    domain: "chat",
    listName: "chat-candidates"
  });
  const viewportGuard = createViewportRunGuard({
    client,
    domain: "chat",
    root: "top",
    frameOwnerRoot: "top",
    runControl,
    getRoots: getChatRoots
  });
  async function ensureChatViewport(rootState, phase) {
    const result = await viewportGuard.ensure(rootState, { phase });
    return result.rootState || rootState;
  }
  const results = [];
  let cardNodeIds = [];
  let listEndReason = "";
  const listFallbackResolver = listFallbackPoint || (async ({ items = [] } = {}) => resolveInfiniteListFallbackPoint(client, {
    rootNodeId: rootState?.rootNodes?.top,
    containerSelectors: CHAT_LIST_CONTAINER_SELECTORS,
    itemNodeIds: items.map((item) => item.node_id).filter(Boolean),
    itemSelectors: CHAT_CARD_SELECTORS,
    viewportPoint: { xRatio: 0.16, yRatio: 0.4 },
    validateViewportPoint: true
  }));
  let requestedCount = 0;
  let requestSatisfiedCount = 0;
  let requestSkippedCount = 0;
  let contextSetup = {};

  runControl.setPhase("chat:cleanup");
  let initialTopLevelState = await getChatTopLevelState(client);
  if (!initialTopLevelState.is_chat_shell) {
    const recovery = await recoverChatShell(client, {
      targetUrl,
      timeoutMs: readyTimeoutMs
    });
    runControl.checkpoint({
      chat_shell_recovery: {
        reason: "initial_non_chat_shell",
        ...recovery
      }
    });
    if (!recovery.recovered) {
      throw new Error(`Chat shell recovery failed before run setup: ${recovery.after?.url || recovery.before?.url || "unknown"}`);
    }
    initialTopLevelState = recovery.after;
  }
  await closeChatResumeModal(client, { attemptsLimit: 2 });

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("chat:context");
  const setup = await setupChatRunContext(client, {
    job,
    normalizedStartFrom,
    readyTimeoutMs,
    listSettleMs,
    runControl,
    ensureViewport: ensureChatViewport
  });
  let rootState = setup.rootState;
  contextSetup = {
    ...setup.contextSetup,
    initial_top_level_state: initialTopLevelState
  };
  runControl.checkpoint({
    chat_context: contextSetup
  });

  async function recoverAndReapplyChatContext(reason, error = null, {
    forceRefresh = false
  } = {}) {
    runControl.setPhase("chat:recover_shell");
    const shellRecovery = await recoverChatShell(client, {
      targetUrl,
      timeoutMs: readyTimeoutMs,
      forceNavigate: forceRefresh
    });
    runControl.checkpoint({
      chat_shell_recovery: {
        reason,
        error: error?.message || null,
        total_refresh: Boolean(forceRefresh),
        ...shellRecovery
      }
    });
    if (!shellRecovery.recovered && !shellRecovery.after?.is_chat_shell) {
      throw new Error(`Chat shell recovery failed after ${reason}: ${shellRecovery.after?.url || shellRecovery.before?.url || "unknown"}`);
    }
    await closeChatResumeModal(client, { attemptsLimit: 2 });
    const recoveredSetup = await setupChatRunContext(client, {
      job,
      normalizedStartFrom,
      readyTimeoutMs,
      listSettleMs,
      runControl,
      ensureViewport: ensureChatViewport
    });
    rootState = recoveredSetup.rootState;
    const counters = countChatResultStatuses(results);
    const candidateList = resetInfiniteListForRefreshRound(listState, {
      reason,
      round: listState.ledger?.length || 0,
      method: forceRefresh ? "total_refresh_reapply_chat_context" : "reapply_chat_context",
      metadata: {
        processed: counters.processed,
        passed: counters.passed,
        skipped: counters.skipped
      }
    });
    const recovery = {
      reason,
      total_refresh: Boolean(forceRefresh),
      shell: shellRecovery,
      candidate_list: candidateList,
      counters
    };
    contextSetup = {
      ...recoveredSetup.contextSetup,
      recovered_from: reason,
      recovery,
      previous_context: contextSetup
    };
    runControl.checkpoint({
      chat_context: contextSetup,
      candidate_list: candidateList
    });
    return recovery;
  }

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("chat:cards");
  const cardRootState = await ensureChatViewport(await getChatRoots(client), "cards");
  const initialCards = await waitForChatCandidateNodeIds(client, cardRootState.rootNodes.top, {
    timeoutMs: cardTimeoutMs,
    intervalMs: 500
  });
  cardNodeIds = initialCards.nodeIds || [];
  if (!cardNodeIds.length) {
    runControl.checkpoint({
      empty_list_state: {
        method: "cdp_dom_selector_count",
        candidate_count: 0,
        requested_start_from: normalizedStartFrom
      }
    });
    listEndReason = "no_chat_candidates_found";
    runControl.updateProgress({
      card_count: 0,
      target_count: passTarget || (processUntilListEnd ? "all" : processedLimit),
      target_pass_count: passTarget,
      processed_limit: processedLimit,
      processed: 0,
      screened: 0,
      detail_opened: 0,
      llm_screened: 0,
      passed: 0,
      skipped: 0,
      requested: 0,
      request_satisfied: 0,
      request_skipped: 0,
      unique_seen: compactInfiniteListState(listState).seen_count,
      scroll_count: compactInfiniteListState(listState).scroll_count,
      list_end_reason: listEndReason,
      viewport_checks: viewportGuard.getStats().checks,
      viewport_recoveries: viewportGuard.getStats().recoveries
    });
    runControl.setPhase("chat:done");
    return {
      domain: "chat",
      target_url: targetUrl,
      card_count: 0,
      context_setup: contextSetup,
      empty_list_state: {
        method: "cdp_dom_selector_count",
        candidate_count: 0,
        requested_start_from: normalizedStartFrom
      },
      candidate_list: compactInfiniteListState(listState),
      viewport_health: {
        stats: viewportGuard.getStats(),
        events: viewportGuard.getEvents()
      },
      list_end_reason: listEndReason,
      target_pass_count: passTarget,
      process_until_list_end: Boolean(processUntilListEnd),
      processed_limit: processedLimit,
      detail_source: normalizedDetailSource,
      processed: 0,
      screened: 0,
      detail_opened: 0,
      llm_screened: 0,
      passed: 0,
      skipped: 0,
      requested: requestedCount,
      request_satisfied: requestSatisfiedCount,
      request_skipped: requestSkippedCount,
      results
    };
  }

  runControl.updateProgress({
    card_count: cardNodeIds.length,
    target_count: passTarget || (processUntilListEnd ? "all" : processedLimit),
    target_pass_count: passTarget,
    processed_limit: processedLimit,
    processed: 0,
    screened: 0,
    detail_opened: 0,
    llm_screened: 0,
    passed: 0,
    skipped: 0,
    requested: 0,
    request_satisfied: 0,
    request_skipped: 0,
    screening_mode: normalizedScreeningMode,
    unique_seen: compactInfiniteListState(listState).seen_count,
    scroll_count: 0,
    viewport_checks: viewportGuard.getStats().checks,
    viewport_recoveries: viewportGuard.getStats().recoveries
  });

  while (
    results.length < processedLimit
    && (
      !passTarget
      || results.filter((item) => item.screening?.passed).length < passTarget
    )
  ) {
    const candidateStarted = Date.now();
    const timings = {};
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("chat:candidate");
    rootState = await ensureChatViewport(rootState, "candidate_loop");
    const loopTopLevelState = await getChatTopLevelState(client);
    if (!loopTopLevelState.is_chat_shell) {
      await recoverAndReapplyChatContext("candidate_loop_non_chat_shell", {
        message: `Unexpected chat top-level URL: ${loopTopLevelState.url}`
      });
      continue;
    }
    if (normalizeText(job)) {
      const jobGuard = await selectChatJob(client, rootState.rootNodes.top, {
        jobLabel: job,
        timeoutMs: Math.min(readyTimeoutMs, 12000),
        settleMs: Math.min(listSettleMs, 800)
      });
      if (!jobGuard.selected || jobGuard.verified !== true) {
        const error = new Error(`CHAT_JOB_GUARD_FAILED: requested=${job}; selected=${jobGuard.selected_label || "unknown"}; reason=${jobGuard.reason || "unknown"}`);
        error.code = "CHAT_JOB_GUARD_FAILED";
        error.chat_job_guard = compactChatJobGuard(jobGuard);
        throw error;
      }
      if (!jobGuard.already_current) {
        runControl.checkpoint({
          chat_context_step: "job_guard_reselected",
          job_guard: compactChatJobGuard(jobGuard),
          candidate_list: resetInfiniteListForRefreshRound(listState, {
            reason: "chat_job_drift_repaired",
            round: listState.ledger?.length || 0,
            method: "selectChatJob",
            metadata: {
              requested_job: job,
              selected_label: jobGuard.selected_label || "",
              selected_value: jobGuard.selected_option?.value || ""
            }
          })
        });
        rootState = await ensureChatViewport(await getChatRoots(client), "candidate_job_guard_reselected");
        await sleep(Math.min(listSettleMs, 1200));
        continue;
      }
      if (jobGuard.menu_close?.closed) {
        runControl.checkpoint({
          chat_context_step: "job_guard_closed_dropdown",
          job_guard: compactChatJobGuard(jobGuard)
        });
      }
    }

    const nextCandidateResult = await measureTiming(timings, "card_read_ms", () => getNextInfiniteListCandidate({
      client,
      state: listState,
      maxScrolls: listMaxScrolls,
      stableSignatureLimit: listStableSignatureLimit,
      wheelDeltaY: listWheelDeltaY,
      settleMs: listSettleMs,
      fallbackPoint: listFallbackResolver,
      findNodeIds: async () => {
        const currentRootState = await ensureChatViewport(await getChatRoots(client), "candidate_find_nodes");
        rootState = currentRootState;
        const currentCards = await waitForChatCandidateNodeIds(client, currentRootState.rootNodes.top, {
          timeoutMs: Math.min(cardTimeoutMs, 8000),
          intervalMs: 500
        });
        cardNodeIds = currentCards.nodeIds || [];
        return cardNodeIds;
      },
      keyForCandidate: chatCandidateKeyFromProfile,
      readCandidate: async (nodeId, { visibleIndex }) => readChatCardCandidate(client, nodeId, {
        targetUrl,
        source: "chat-run-card",
        metadata: {
          run_candidate_index: results.length,
          visible_index: visibleIndex
        }
      }),
      detectBottomMarker: async ({ scrollAttempt = 0, signature = {} } = {}) => detectInfiniteListBottomMarker(client, {
        rootNodeId: rootState?.rootNodes?.top,
        markerSelectors: CHAT_BOTTOM_MARKER_SELECTORS,
        refreshSelectors: [],
        textScanSelectors: scrollAttempt > 0 || (signature?.stable_signature_count || 0) >= 2 ? undefined : [],
        maxTextScanNodes: 500
      })
    }));
    if (!nextCandidateResult.ok) {
      const endTopLevelState = await getChatTopLevelState(client);
      if (!endTopLevelState.is_chat_shell) {
        await recoverAndReapplyChatContext("candidate_list_end_non_chat_shell", {
          message: `Unexpected chat top-level URL at list end: ${endTopLevelState.url}`
        });
        continue;
      }
      if (nextCandidateResult.reason === "empty_visible_list") {
        runControl.checkpoint({
          terminal_empty_list_state: {
            method: "cdp_dom_selector_count",
            reason: nextCandidateResult.reason,
            requested_start_from: normalizedStartFrom
          }
        });
      }
      listEndReason = nextCandidateResult.reason || "list_exhausted";
      break;
    }

    const index = results.length;
    const cardNodeId = nextCandidateResult.item.node_id;
    let effectiveCardNodeId = cardNodeId;
    const candidateKey = nextCandidateResult.item.key;
    const cardCandidate = nextCandidateResult.item.candidate;

    let screeningCandidate = cardCandidate;
    let detailResult = null;
    let preActionState = null;
    let detailUnavailableReason = "";
    if (index < detailCountLimit) {
      let detailStep = "start";
      const checkpointInProgressCandidate = (patch = {}) => runControl.checkpoint({
        in_progress_candidate: {
          index,
          key: candidateKey,
          card_node_id: effectiveCardNodeId || cardNodeId,
          candidate: compactCandidate(cardCandidate),
          detail_step: detailStep,
          counters: countChatResultStatuses(results),
          ...patch
        }
      });
      try {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("chat:detail");
        rootState = await ensureChatViewport(rootState, "detail");
        checkpointInProgressCandidate({ event: "detail_start" });

        detailStep = "select_candidate";
        networkRecorder.clear();
        const selected = await measureTiming(timings, "candidate_click_ms", () => selectFreshChatCandidate(client, {
          cardNodeId,
          candidate: cardCandidate,
          timeoutMs: onlineResumeButtonTimeoutMs
        }));
        if (selected.ready?.forbidden_top_level_navigation) {
          throw makeForbiddenChatResumeNavigationError(selected.ready.top_level_state);
        }
        effectiveCardNodeId = selected.card_node_id || cardNodeId;
        const selectionNetworkEvents = networkRecorder.events.slice();
        try {
          preActionState = await readChatConversationReadyState(client);
        } catch (error) {
          preActionState = {
            error: error?.message || String(error)
          };
        }
        const preDetailSkipReason = chatDetailSkipReasonFromReadyState(preActionState);
        if (preDetailSkipReason) {
          detailUnavailableReason = preDetailSkipReason;
          detailResult = createSkippedDetailResult(cardCandidate, preDetailSkipReason);
          detailResult.cv_acquisition.pre_detail_state = preActionState;
          detailResult.cv_acquisition.selection_ready_state = selected.ready;
        }
        if (!selected.ready?.ok) {
          if (detailResult) {
            // Already classified by the pre-detail conversation state.
          } else if (selected.ready?.reason === "active_candidate_mismatch") {
            detailUnavailableReason = "active_candidate_mismatch";
            detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason);
            detailResult.cv_acquisition.selection_ready_state = selected.ready;
          } else {
            detailStep = "read_conversation_ready_state";
            if (preActionState.attachment_resume_enabled) {
              detailUnavailableReason = "attachment_resume_already_available";
              detailResult = createSkippedDetailResult(cardCandidate, "attachment_resume_already_available");
              detailResult.cv_acquisition.pre_detail_state = preActionState;
            } else {
              detailUnavailableReason = "online_resume_button_unavailable";
              detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason);
              detailResult.cv_acquisition.pre_detail_state = preActionState;
            }
          }
        }

        if (!detailResult) {
          const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState);
          let networkWait = null;
          let contentWait = {
            ok: false,
            skipped: false,
            reason: "not_started",
            elapsed_ms: 0,
            text_length: 0
          };
          let resumeState = null;
          let resumeHtml = null;
          let resumeNetworkEvents = [];
          let parsedNetworkProfileCount = 0;

          if (
            ["network", "cascade"].includes(normalizedDetailSource)
            && selectionNetworkEvents.length > 0
          ) {
            detailStep = "extract_selection_network_profile";
            detailResult = await extractChatProfileCandidate(client, {
              cardCandidate,
              cardNodeId: effectiveCardNodeId,
              resumeState: null,
              resumeHtml: null,
              networkEvents: selectionNetworkEvents,
              targetUrl,
              closeResume: false,
              networkParseRetryMs: waitPlan.mode_before === "image" ? 250 : 900,
              networkParseIntervalMs: 150
            });
            addTiming(timings, "late_network_retry_ms", detailResult.network_parse_retry_elapsed_ms);
            parsedNetworkProfileCount = countParsedNetworkProfiles(detailResult);
            const selectionNetworkEvidence = summarizeChatFullCvEvidence({ detailResult, contentWait });
            if (selectionNetworkEvidence.network_full_cv_count > 0) {
              networkWait = {
                ok: true,
                skipped: true,
                reason: "selection_network_full_cv_before_online_resume_click",
                elapsed_ms: detailResult.network_parse_retry_elapsed_ms,
                count: selectionNetworkEvents.length,
                total_event_count: selectionNetworkEvents.length,
                wait_plan: waitPlan
              };
              contentWait = {
                ok: true,
                skipped: true,
                reason: "selection_network_full_cv_before_online_resume_click",
                elapsed_ms: 0,
                text_length: 0
              };
            } else {
              detailResult = null;
            }
          }

          if (!detailResult) {
            detailStep = "open_online_resume";
            networkRecorder.clear();
            const openedResume = await measureTiming(timings, "detail_open_ms", () => openChatOnlineResume(client, {
              timeoutMs: readyTimeoutMs
            }));
            resumeState = openedResume.resume_state;
            detailStep = "wait_network";
            networkWait = ["network", "cascade"].includes(normalizedDetailSource)
              ? await measureTiming(timings, "network_cv_wait_ms", () => waitForCvNetworkEvents(
                  waitForChatProfileNetworkEvents,
                  networkRecorder,
                  {
                    waitPlan,
                    minCount: 1,
                    requireLoaded: true,
                    intervalMs: 200
                  }
                ))
              : null;
            if (networkWait?.elapsed_ms != null) {
              timings.network_cv_wait_ms = Math.round(Number(networkWait.elapsed_ms) || 0);
            }
            resumeNetworkEvents = networkRecorder.events.slice();

            if (
              ["network", "cascade"].includes(normalizedDetailSource)
              && networkWait?.count > 0
            ) {
              detailStep = "extract_network_profile";
              detailResult = await extractChatProfileCandidate(client, {
                cardCandidate,
                cardNodeId: effectiveCardNodeId,
                resumeState,
                resumeHtml,
                networkEvents: selectedDetailNetworkEvents(
                  normalizedDetailSource,
                  selectionNetworkEvents,
                  resumeNetworkEvents
                ),
                targetUrl,
                closeResume: false,
                networkParseRetryMs: waitPlan.mode_before === "image" ? 500 : 2200,
                networkParseIntervalMs: 250
              });
              addTiming(timings, "late_network_retry_ms", detailResult.network_parse_retry_elapsed_ms);
              parsedNetworkProfileCount = countParsedNetworkProfiles(detailResult);
              const networkEvidence = summarizeChatFullCvEvidence({ detailResult, contentWait });
              if (networkEvidence.network_full_cv_count > 0) {
                contentWait = {
                  ok: true,
                  skipped: true,
                  reason: "network_full_cv_parsed_before_dom_wait",
                  elapsed_ms: 0,
                  text_length: 0
                };
              } else {
                detailResult = null;
              }
            }

            if (!detailResult) {
              detailStep = "wait_resume_content";
              const domFallbackPlan = resolveChatDomFallbackWait({
                normalizedDetailSource,
                parsedNetworkProfileCount,
                waitPlan,
                resumeDomTimeoutMs
              });
              if (domFallbackPlan.skipped || domFallbackPlan.timeout_ms <= 0) {
                contentWait = {
                  ok: false,
                  skipped: true,
                  reason: domFallbackPlan.reason,
                  elapsed_ms: 0,
                  text_length: 0,
                  resume_state: openedResume.resume_state,
                  resume_html: null,
                  dom_fallback_plan: domFallbackPlan,
                  configured_timeout_ms: domFallbackPlan.configured_timeout_ms,
                  timeout_ms: domFallbackPlan.timeout_ms,
                  short_probe: Boolean(domFallbackPlan.short_probe)
                };
                addTiming(timings, "dom_fallback_ms", 0);
              } else {
                contentWait = await measureTiming(timings, "dom_fallback_ms", () => waitForChatResumeContent(client, {
                  timeoutMs: domFallbackPlan.timeout_ms,
                  intervalMs: 300
                }));
                contentWait.dom_fallback_plan = domFallbackPlan;
                contentWait.configured_timeout_ms = domFallbackPlan.configured_timeout_ms;
                contentWait.timeout_ms = domFallbackPlan.timeout_ms;
                contentWait.short_probe = Boolean(domFallbackPlan.short_probe);
                if (domFallbackPlan.short_probe && !contentWait.ok) {
                  contentWait.reason = contentWait.reason || domFallbackPlan.reason;
                }
              }
              resumeState = contentWait.resume_state || openedResume.resume_state;
              resumeHtml = contentWait.resume_html || null;
              resumeNetworkEvents = networkRecorder.events.slice();
              detailStep = "extract_resume_content";
              detailResult = await extractChatProfileCandidate(client, {
                cardCandidate,
                cardNodeId: effectiveCardNodeId,
                resumeState,
                resumeHtml,
                networkEvents: selectedDetailNetworkEvents(
                  normalizedDetailSource,
                  selectionNetworkEvents,
                  resumeNetworkEvents
                ),
                targetUrl,
                closeResume: false,
                networkParseRetryMs: waitPlan.mode_before === "image" ? 500 : 2200,
                networkParseIntervalMs: 250
              });
              addTiming(timings, "late_network_retry_ms", detailResult.network_parse_retry_elapsed_ms);
              parsedNetworkProfileCount = countParsedNetworkProfiles(detailResult);
            }
          }

          let source = normalizedDetailSource === "dom" ? "dom" : "network";
          let imageEvidence = null;
          let llmResult = null;
          let captureTarget = null;
          let captureTargetWait = null;
          let fullCvEvidence = summarizeChatFullCvEvidence({ detailResult, contentWait });
          const shouldCaptureImage = normalizedDetailSource === "image"
            || (normalizedDetailSource === "cascade" && !fullCvEvidence.full_cv_acquired);
          if (shouldCaptureImage) {
            captureTargetWait = await waitForCvCaptureTarget(client, resumeState, {
              domain: "chat",
              timeoutMs: 6000,
              intervalMs: 250
            });
            captureTarget = captureTargetWait.target || null;
            const captureNodeId = captureTarget?.node_id || null;
            if (captureNodeId) {
              detailStep = "capture_image_fallback";
              imageEvidence = await measureTiming(timings, "screenshot_capture_ms", () => captureScrolledNodeScreenshots(client, captureNodeId, {
                filePath: imageEvidenceFilePath({
                  imageOutputDir,
                  domain: "chat",
                  runId: runControl?.runId,
                  index,
                  extension: "jpg"
                }),
                format: "jpeg",
                quality: 72,
                optimize: true,
                resizeMaxWidth: 1100,
                captureViewport: false,
                padding: 0,
                maxScreenshots: maxImagePages,
                wheelDeltaY: imageWheelDeltaY,
                settleMs: 350,
                scrollMethod: "dom-anchor-fallback-input",
                stepTimeoutMs: 45000,
                totalTimeoutMs: 90000,
                duplicateStopCount: 1,
                skipDuplicateScreenshots: true,
                composeForLlm: true,
                llmPagesPerImage: 3,
                llmResizeMaxWidth: 1100,
                llmQuality: 72,
                stopBoundarySelector: CHAT_RESUME_IMAGE_STOP_BOUNDARY_SELECTOR,
                stopBoundaryTextPatterns: CHAT_RESUME_IMAGE_STOP_BOUNDARY_TEXT,
                stopBoundaryMaxProbeNodes: 360,
                stopBoundaryTopPadding: 10,
                stopBoundaryMinCaptureHeight: 180,
                metadata: {
                  domain: "chat",
                  capture_mode: "scroll_sequence",
                  capture_scope: "resume_modal_clip",
                  acquisition_reason: normalizedDetailSource === "image"
                    ? "forced_image"
                    : "network_miss_image_fallback",
                  run_candidate_index: index,
                  candidate_key: candidateKey,
                  capture_target: captureTarget,
                  capture_target_wait: captureTargetWait
                }
              }));
              source = "image";
              fullCvEvidence = summarizeChatFullCvEvidence({
                detailResult,
                contentWait,
                imageEvidence
              });
              recordCvImageFallback(cvAcquisitionState, {
                reason: fullCvEvidence.network_profile_only_count > 0
                  ? "profile_only_network_image_fallback"
                  : "network_miss_image_fallback",
                parsedNetworkProfileCount,
                waitResult: networkWait,
                imageEvidence
              });
              if (callLlmOnImage && fullCvEvidence.full_cv_acquired) {
                detailStep = "llm_image_screening";
                if (!llmConfig) {
                  llmResult = createMissingLlmConfigResult();
                } else {
                  try {
                    llmResult = await measureTiming(timings, "vision_model_ms", () => callScreeningLlm({
                      candidate: detailResult.candidate,
                      criteria,
                      config: llmConfig,
                      timeoutMs: llmTimeoutMs,
                      imageEvidence,
                      maxImages: llmImageLimit,
                      imageDetail: llmImageDetail
                    }));
                  } catch (error) {
                    llmResult = createFailedLlmResult(error);
                  }
                }
              }
            } else {
              source = "missing_capture_node";
              fullCvEvidence = summarizeChatFullCvEvidence({
                detailResult,
                contentWait,
                imageEvidence
              });
              recordCvNetworkMiss(cvAcquisitionState, {
                reason: "network_miss_no_capture_node",
                parsedNetworkProfileCount,
                waitResult: networkWait
              });
            }
          } else if (fullCvEvidence.network_full_cv_count > 0) {
            source = "network";
            recordCvNetworkHit(cvAcquisitionState, {
              reason: "full_cv_network_profile",
              parsedNetworkProfileCount,
              waitResult: networkWait
            });
          } else if (fullCvEvidence.dom_full_cv) {
            source = "dom";
            if (normalizedDetailSource !== "dom") {
              recordCvNetworkMiss(cvAcquisitionState, {
                reason: parsedNetworkProfileCount > 0
                  ? "profile_only_network_dom_fallback"
                  : "network_miss_dom_fallback",
                parsedNetworkProfileCount,
                waitResult: networkWait
              });
            }
          } else if (parsedNetworkProfileCount > 0) {
            source = "profile_only_network";
            recordCvNetworkMiss(cvAcquisitionState, {
              reason: "profile_only_network_not_full_cv",
              parsedNetworkProfileCount,
              waitResult: networkWait
            });
          } else if (normalizedDetailSource !== "dom") {
            source = "network_miss";
            recordCvNetworkMiss(cvAcquisitionState, {
              reason: "network_miss_without_image_fallback",
              parsedNetworkProfileCount,
              waitResult: networkWait
            });
          }

          if (useLlmScreening && !llmResult) {
            if (!fullCvEvidence.full_cv_acquired) {
              detailUnavailableReason = "full_cv_not_acquired";
            } else {
              detailStep = "llm_screening";
              if (!llmConfig) {
                llmResult = createMissingLlmConfigResult();
              } else {
                try {
                  const llmTimingKey = imageEvidence?.file_paths?.length
                    ? "vision_model_ms"
                    : "text_model_ms";
                  llmResult = await measureTiming(timings, llmTimingKey, () => callScreeningLlm({
                    candidate: detailResult.candidate,
                    criteria,
                    config: llmConfig,
                    timeoutMs: llmTimeoutMs,
                    imageEvidence,
                    maxImages: llmImageLimit,
                    imageDetail: llmImageDetail
                  }));
                } catch (error) {
                  llmResult = createFailedLlmResult(error);
                }
              }
            }
          }

          let closeResult = null;
          let closeRecovery = null;
          if (closeResume) {
            detailStep = "close_resume_modal";
            checkpointInProgressCandidate({
              event: "before_close_resume_modal",
              source,
              image_evidence: summarizeImageEvidence(imageEvidence),
              llm_screening: compactLlmResult(llmResult),
              full_cv_evidence: fullCvEvidence
            });
            closeResult = await measureTiming(timings, "close_detail_ms", () => closeChatResumeModal(client));
            if (!closeResult?.closed) {
              closeRecovery = await recoverAndReapplyChatContext(
                "resume_modal_close_failed:close_resume_modal",
                makeChatResumeModalOpenBeforeCandidateClickError(closeResult),
                { forceRefresh: true }
              );
            }
          }
          detailResult.close_result = closeResult;
          detailResult.image_evidence = imageEvidence;
          detailResult.llm_result = llmResult;
          detailResult.cv_acquisition = {
            source,
            mode_after: compactCvAcquisitionState(cvAcquisitionState).mode,
            wait_plan: waitPlan,
            network_wait: networkWait,
            selection_network_event_count: selectionNetworkEvents.length,
            resume_network_event_count: resumeNetworkEvents.length,
            content_wait: {
              ok: contentWait.ok,
              skipped: Boolean(contentWait.skipped),
              reason: contentWait.reason || null,
              elapsed_ms: contentWait.elapsed_ms,
              text_length: contentWait.text_length,
              timeout_ms: contentWait.timeout_ms ?? contentWait.dom_fallback_plan?.timeout_ms ?? null,
              configured_timeout_ms: contentWait.configured_timeout_ms
                ?? contentWait.dom_fallback_plan?.configured_timeout_ms
                ?? null,
              short_probe: Boolean(contentWait.short_probe)
            },
            parsed_network_profile_count: parsedNetworkProfileCount,
            image_evidence: summarizeImageEvidence(imageEvidence),
            capture_target: captureTarget || null,
            capture_target_wait: captureTargetWait,
            full_cv_evidence: fullCvEvidence,
            close_recovery: closeRecovery
          };
        }
      } catch (error) {
        checkpointInProgressCandidate({
          event: "detail_error",
          error: compactChatRuntimeError(error)
        });
        if (isForbiddenChatResumeNavigationError(error)) {
          detailUnavailableReason = "forbidden_top_level_resume_navigation";
          const recovery = await recoverAndReapplyChatContext(detailUnavailableReason, error);
          detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason, error);
          detailResult.cv_acquisition.recovery = recovery;
        } else if (isChatResumeModalCloseFailureError(error)) {
          const recoveryReason = `resume_modal_close_failed:${detailStep}`;
          const recovery = await recoverAndReapplyChatContext(recoveryReason, error, { forceRefresh: true });
          checkpointInProgressCandidate({
            event: "retry_after_modal_recovery",
            recovery
          });
          continue;
        } else if (isUnsafeChatOnlineResumeLinkError(error)) {
          detailUnavailableReason = "unsafe_online_resume_navigation_link";
          detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason, error);
          detailResult.cv_acquisition.blocked_pre_click = true;
          detailResult.cv_acquisition.button_href = error.href || null;
          detailResult.cv_acquisition.button_selector = error.button_selector || null;
          detailResult.cv_acquisition.attempts = error.attempts || null;
        } else {
          if (!isRecoverableCdpNodeError(error)) throw error;
          detailUnavailableReason = `recoverable_cdp_node_stale:${detailStep}`;
          detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason, error);
          await closeChatResumeModal(client, { attemptsLimit: 2 });
        }
      }
      screeningCandidate = detailResult.candidate;
    }

    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("chat:screening");
    let cardOnlyLlmResult = null;
    if (useLlmScreening && !detailUnavailableReason && !detailResult?.llm_result) {
      detailUnavailableReason = detailResult
        ? "full_cv_not_acquired"
        : "detail_not_opened_full_cv_required";
    }
    const effectiveLlmResult = detailResult?.llm_result || cardOnlyLlmResult;
    const screening = detailUnavailableReason
      ? {
          status: "skip",
          passed: false,
          score: 0,
          reasons: [detailUnavailableReason],
          candidate: screeningCandidate
        }
      : useLlmScreening
        ? llmToScreening(effectiveLlmResult, screeningCandidate)
        : screenCandidate(screeningCandidate, { criteria });
    let postAction = null;
    if (requestResumeForPassed && screening.passed) {
      postAction = await measureTiming(timings, "post_action_ms", () => requestChatResumeForPassedCandidate(client, {
        greetingText,
        dryRun: dryRunRequestCv
      }));
      if (postAction?.requested) requestSatisfiedCount += 1;
      if (postAction?.skipped) requestSkippedCount += 1;
      if (postAction?.requested && !postAction?.skipped) requestedCount += 1;
      if (!postAction?.requested && !postAction?.skipped && !dryRunRequestCv) {
        throw new Error(`REQUEST_CV_NOT_VERIFIED:${postAction?.reason || "unknown"}`);
      }
    }
    timings.total_ms = Date.now() - candidateStarted;
    const compactResult = {
      index,
      candidate_key: candidateKey,
      card_node_id: effectiveCardNodeId,
      candidate: compactCandidate(screeningCandidate),
      detail: compactDetail(detailResult),
      llm_screening: detailResult ? null : compactLlmResult(cardOnlyLlmResult),
      screening: compactScreening(screening),
      post_action: postAction,
      pre_action_state: preActionState,
      timings
    };
    results.push(compactResult);
    markInfiniteListCandidateProcessed(listState, candidateKey, {
      metadata: {
        result_index: index,
        candidate_id: screeningCandidate.id || null
      }
    });

    const counters = countChatResultStatuses(results);
    runControl.updateProgress({
      card_count: cardNodeIds.length,
      target_count: passTarget || (processUntilListEnd ? "all" : processedLimit),
      target_pass_count: passTarget,
      processed_limit: processedLimit,
      processed: counters.processed,
      screened: counters.screened,
      detail_opened: counters.detail_opened,
      llm_screened: counters.llm_screened,
      passed: counters.passed,
      skipped: counters.skipped,
      requested: requestedCount,
      request_satisfied: requestSatisfiedCount,
      request_skipped: requestSkippedCount,
      unique_seen: compactInfiniteListState(listState).seen_count,
      scroll_count: compactInfiniteListState(listState).scroll_count,
      list_end_reason: listEndReason || null,
      viewport_checks: viewportGuard.getStats().checks,
      viewport_recoveries: viewportGuard.getStats().recoveries,
      last_candidate_id: screeningCandidate.id || null,
      last_candidate_key: candidateKey,
      last_score: screening.score
    });
    const checkpointStarted = Date.now();
    runControl.checkpoint({
      results,
      in_progress_candidate: null,
      last_candidate: {
        id: screeningCandidate.id || null,
        key: candidateKey,
        identity: screeningCandidate.identity || {},
        screening: {
          status: screening.status,
          passed: screening.passed,
          score: screening.score
        },
        llm_screening: compactLlmResult(effectiveLlmResult)
      }
    });
    addTiming(compactResult.timings, "checkpoint_save_ms", Date.now() - checkpointStarted);

    if (delayMs > 0) {
      const sleepStarted = Date.now();
      await runControl.sleep(delayMs);
      addTiming(compactResult.timings, "sleep_ms", Date.now() - sleepStarted);
      compactResult.timings.total_ms = Date.now() - candidateStarted;
    }
  }

  runControl.setPhase("chat:done");
  const finalCounters = countChatResultStatuses(results);
  return {
    domain: "chat",
    target_url: targetUrl,
    card_count: cardNodeIds.length,
    context_setup: contextSetup,
    candidate_list: compactInfiniteListState(listState),
    viewport_health: {
      stats: viewportGuard.getStats(),
      events: viewportGuard.getEvents()
    },
    list_end_reason: listEndReason || null,
    target_pass_count: passTarget,
    process_until_list_end: Boolean(processUntilListEnd),
    processed_limit: processedLimit,
    detail_source: normalizedDetailSource,
    processed: finalCounters.processed,
    screened: finalCounters.screened,
    detail_opened: finalCounters.detail_opened,
    llm_screened: finalCounters.llm_screened,
    passed: finalCounters.passed,
    skipped: finalCounters.skipped,
    requested: requestedCount,
    request_satisfied: requestSatisfiedCount,
    request_skipped: requestSkippedCount,
    results
  };
}

export function createChatRunService({
  lifecycle,
  idPrefix = "chat",
  workflow = runChatWorkflow,
  onSnapshot = null
} = {}) {
  const manager = lifecycle || createRunLifecycleManager({ idPrefix, onSnapshot });

  function startChatRun({
    client,
    targetUrl = CHAT_TARGET_URL,
    job = "",
    startFrom = "all",
    criteria = "",
    maxCandidates = 5,
    targetPassCount = null,
    processUntilListEnd = false,
    detailLimit = null,
    detailSource = "cascade",
    closeResume = true,
    requestResumeForPassed = false,
    dryRunRequestCv = false,
    greetingText = "Hi同学，能麻烦发下简历吗？",
    delayMs = 0,
    cardTimeoutMs = 90000,
    readyTimeoutMs = 60000,
    onlineResumeButtonTimeoutMs = 30000,
    resumeDomTimeoutMs = 60000,
    maxImagePages = DEFAULT_MAX_IMAGE_PAGES,
    imageWheelDeltaY = 650,
    cvAcquisitionMode = "unknown",
    callLlmOnImage = false,
    llmConfig = null,
    llmTimeoutMs = 120000,
    llmImageLimit = 8,
    llmImageDetail = "high",
    screeningMode = "llm",
    listMaxScrolls = 20,
    listStableSignatureLimit = 5,
    listWheelDeltaY = 850,
    listSettleMs = 2200,
    listFallbackPoint = null,
    imageOutputDir = "",
    name = "chat-domain-run"
  } = {}) {
    if (!client) throw new Error("startChatRun requires a guarded CDP client");
    const normalizedDetailSource = normalizeDetailSource(detailSource);
    const normalizedScreeningMode = normalizeScreeningMode(screeningMode);
    const processedLimit = Math.max(1, Number(maxCandidates) || 1);
    const normalizedDetailLimit = detailLimit == null ? processedLimit : Math.max(0, Number(detailLimit) || 0);
    return manager.startRun({
      name,
      context: {
        domain: "chat",
        target_url: targetUrl,
        criteria_present: Boolean(criteria),
        job,
        start_from: startFrom,
        max_candidates: maxCandidates,
        target_pass_count: targetPassCount,
        process_until_list_end: Boolean(processUntilListEnd),
        detail_limit: normalizedDetailLimit,
        detail_source: normalizedDetailSource,
        close_resume: closeResume,
        request_resume_for_passed: Boolean(requestResumeForPassed),
        dry_run_request_cv: Boolean(dryRunRequestCv),
        greeting_text: greetingText,
        cv_acquisition_mode: cvAcquisitionMode,
        call_llm_on_image: Boolean(callLlmOnImage),
        screening_mode: normalizedScreeningMode,
        llm_configured: Boolean(llmConfig),
        llm_timeout_ms: llmTimeoutMs,
        llm_image_limit: llmImageLimit,
        llm_image_detail: llmImageDetail,
        max_image_pages: maxImagePages,
        image_wheel_delta_y: imageWheelDeltaY,
        list_max_scrolls: listMaxScrolls,
        list_stable_signature_limit: listStableSignatureLimit,
        list_wheel_delta_y: listWheelDeltaY,
        list_settle_ms: listSettleMs,
        list_fallback_point: listFallbackPoint,
        online_resume_button_timeout_ms: onlineResumeButtonTimeoutMs,
        image_output_dir: imageOutputDir || ""
      },
      progress: {
        card_count: 0,
        target_count: targetPassCount || (processUntilListEnd ? "all" : processedLimit),
        target_pass_count: targetPassCount,
        processed_limit: processedLimit,
        processed: 0,
        screened: 0,
        detail_opened: 0,
        llm_screened: 0,
        passed: 0,
        skipped: 0,
        requested: 0,
        request_satisfied: 0,
        request_skipped: 0
      },
      checkpoint: {},
      task: (runControl) => workflow({
        client,
        targetUrl,
        job,
        startFrom,
        criteria,
        maxCandidates,
        targetPassCount,
        processUntilListEnd,
        detailLimit: normalizedDetailLimit,
        detailSource: normalizedDetailSource,
        closeResume,
        requestResumeForPassed,
        dryRunRequestCv,
        greetingText,
        delayMs,
        cardTimeoutMs,
        readyTimeoutMs,
        onlineResumeButtonTimeoutMs,
        resumeDomTimeoutMs,
        maxImagePages,
        imageWheelDeltaY,
        cvAcquisitionMode,
        callLlmOnImage,
        llmConfig,
        llmTimeoutMs,
        llmImageLimit,
        llmImageDetail,
        screeningMode: normalizedScreeningMode,
        listMaxScrolls,
        listStableSignatureLimit,
        listWheelDeltaY,
        listSettleMs,
        listFallbackPoint,
        imageOutputDir
      }, runControl)
    });
  }

  return {
    startChatRun,
    getChatRun: manager.getRun,
    pauseChatRun: manager.pauseRun,
    resumeChatRun: manager.resumeRun,
    cancelChatRun: manager.cancelRun,
    waitForChatRun: manager.waitForRun,
    listChatRuns: manager.listRuns,
    manager
  };
}
