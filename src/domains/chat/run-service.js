import {
  captureScrolledNodeScreenshots,
  captureViewportScreenshot
} from "../../core/capture/index.js";
import { waitForCvCaptureTarget } from "../../core/cv-capture-target/index.js";
import {
  clickPoint,
  configureHumanInteraction,
  createHumanRestController,
  getNodeBox,
  humanDelay,
  normalizeHumanBehaviorOptions,
  scrollNodeIntoView,
  sleep
} from "../../core/browser/index.js";
import {
  attemptImageCaptureCheckpointResume,
  compactCvAcquisitionState,
  createImageCaptureWorkflowRetryTracker,
  createRequiredImageEvidenceFailure,
  imageCaptureResumeCheckpoint,
  countParsedNetworkProfiles,
  createCvAcquisitionState,
  DEFAULT_MAX_IMAGE_PAGES,
  getCvNetworkWaitPlan,
  isIncompleteImageEvidence,
  isRecoverableImageCaptureWorkflowError,
  recordCvImageFallback,
  recordCvNetworkHit,
  recordCvNetworkMiss,
  reacquireImageCaptureResumeTarget,
  requireCompleteImageEvidence,
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
import {
  createRunLifecycleManager,
  RunCanceledError
} from "../../core/run/index.js";
import {
  addTiming,
  imageEvidenceFilePath,
  measureTiming
} from "../../core/run/timing.js";
import {
  callScreeningLlm,
  createFatalLlmRunError,
  isFatalLlmProviderError,
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
import { createChatActionJournal } from "./action-journal.js";
import {
  closeChatBlockingPanels,
  closeChatResumeModal,
  createChatProfileNetworkRecorder,
  extractChatProfileCandidate,
  isChatOnlineResumeModalOpenFailureError,
  isUnsafeChatOnlineResumeLinkError,
  openChatOnlineResume,
  quickChatResumeModalOpenProbe,
  readChatActiveCandidateState,
  readChatConversationReadyState,
  readChatRequestVerificationEvidence,
  getChatGreetingMessageState,
  requestChatResumeForPassedCandidate,
  selectChatMessageFilter,
  selectChatPrimaryLabel,
  waitForChatOnlineResumeButton,
  waitForChatProfileNetworkEvents,
  waitForChatResumeModal,
  waitForChatResumeContent
} from "./detail.js";
import { selectChatJob } from "./jobs.js";
import {
  getChatTopLevelState,
  makeBossSecurityVerificationRequiredError,
  isForbiddenChatResumeNavigationError,
  makeForbiddenChatResumeNavigationError,
  recoverChatShell
} from "./page-guard.js";
import { getChatRoots } from "./roots.js";

const DETAIL_SOURCES = new Set(["cascade", "network", "dom", "image"]);
export const CHAT_COLLECT_CV_PROCESSING_FLOOR_MIN_MS = 10000;
export const CHAT_COLLECT_CV_PROCESSING_FLOOR_MAX_MS = 15000;
export const CHAT_EDITOR_PRE_ACTION_RETRY_LIMIT = 1;
export const CHAT_EDITOR_PRE_ACTION_RETRY_SETTLE_MS = 1500;

export function shouldRetryChatEditorPreAction(error, journalRecord, retryCount = 0, {
  retryLimit = CHAT_EDITOR_PRE_ACTION_RETRY_LIMIT
} = {}) {
  const code = String(error?.code || error?.message || "").trim();
  const state = String(journalRecord?.state || "").trim();
  const count = Math.max(0, Math.floor(Number(retryCount) || 0));
  const limit = Math.max(0, Math.floor(Number(retryLimit) || 0));
  return code === "CHAT_EDITOR_MESSAGE_MISMATCH"
    && state === "pre_action"
    && count < limit;
}

export function sampleChatCollectCvProcessingFloorMs({
  minMs = CHAT_COLLECT_CV_PROCESSING_FLOOR_MIN_MS,
  maxMs = CHAT_COLLECT_CV_PROCESSING_FLOOR_MAX_MS,
  random = Math.random
} = {}) {
  const lower = Math.max(0, Math.round(Number(minMs) || 0));
  const upper = Math.max(lower, Math.round(Number(maxMs) || lower));
  const raw = typeof random === "function" ? Number(random()) : Number.NaN;
  const unit = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
  return Math.round(lower + (upper - lower) * unit);
}

export async function enforceChatCollectCvProcessingFloor({
  enabled = true,
  candidateStartedAt,
  targetMs = null,
  minMs = CHAT_COLLECT_CV_PROCESSING_FLOOR_MIN_MS,
  maxMs = CHAT_COLLECT_CV_PROCESSING_FLOOR_MAX_MS,
  random = Math.random,
  nowFn = Date.now,
  sleepFn = sleep
} = {}) {
  if (!enabled) {
    return {
      enabled: false,
      target_ms: 0,
      elapsed_before_ms: 0,
      delay_requested_ms: 0,
      delay_elapsed_ms: 0,
      elapsed_after_ms: 0,
      verified: true
    };
  }
  const readNow = typeof nowFn === "function" ? nowFn : Date.now;
  const sleeper = typeof sleepFn === "function" ? sleepFn : sleep;
  const startedAt = Number(candidateStartedAt);
  if (!Number.isFinite(startedAt)) {
    throw new Error("enforceChatCollectCvProcessingFloor requires candidateStartedAt");
  }
  const sampledTarget = targetMs == null
    ? sampleChatCollectCvProcessingFloorMs({ minMs, maxMs, random })
    : sampleChatCollectCvProcessingFloorMs({ minMs: targetMs, maxMs: targetMs, random });
  const elapsedBefore = Math.max(0, Number(readNow()) - startedAt);
  const delayStartedAt = Number(readNow());
  let delayRequestedMs = 0;
  let elapsedAfter = elapsedBefore;
  let stagnantReads = 0;
  while (elapsedAfter < sampledTarget) {
    const remainingMs = Math.max(1, Math.ceil(sampledTarget - elapsedAfter));
    delayRequestedMs += remainingMs;
    await sleeper(remainingMs);
    const nextElapsed = Math.max(0, Number(readNow()) - startedAt);
    stagnantReads = nextElapsed > elapsedAfter ? 0 : stagnantReads + 1;
    elapsedAfter = nextElapsed;
    if (stagnantReads >= 3) {
      const error = new Error("Chat collect-CV processing-floor clock did not advance after sleep");
      error.code = "CHAT_COLLECT_CV_PROCESSING_FLOOR_CLOCK_STALLED";
      error.target_ms = sampledTarget;
      error.elapsed_ms = elapsedAfter;
      throw error;
    }
  }
  const delayElapsedMs = Math.max(0, Number(readNow()) - delayStartedAt);
  return {
    enabled: true,
    target_ms: sampledTarget,
    elapsed_before_ms: Math.round(elapsedBefore),
    delay_requested_ms: Math.round(delayRequestedMs),
    delay_elapsed_ms: Math.round(delayElapsedMs),
    elapsed_after_ms: Math.round(elapsedAfter),
    verified: elapsedAfter >= sampledTarget
  };
}

function compactChatActionJournalRecord(record = null, filePath = null) {
  if (!record) return null;
  return {
    schema_version: record.schema_version || 1,
    action_key: record.action_key || null,
    candidate_id: record.candidate_id || null,
    state: record.state || null,
    evidence: record.evidence || {},
    created_at: record.created_at || null,
    updated_at: record.updated_at || null,
    first_run_id: record.first_run_id || null,
    last_run_id: record.last_run_id || null,
    file_path: filePath || null
  };
}

function chatActionUnknownOrigin(record = null) {
  const history = Array.isArray(record?.history) ? record.history : [];
  const last = history[history.length - 1];
  return record?.state === "outcome_unknown" ? last?.from_state || null : null;
}

export function reconcileChatRequestJournalFromExactExistingState({
  actionJournal = null,
  actionJournalScope = "",
  actionJournalRecord = null,
  candidateId = "",
  selectionReadyState = null,
  readyState = null,
  runId = "",
  greeting = "",
  checkpointCritical = null
} = {}) {
  const normalizedCandidateId = normalizeText(candidateId);
  const expectedCandidateId = normalizeText(selectionReadyState?.expected_candidate_id || "");
  const activeCandidateId = normalizeText(selectionReadyState?.active_candidate_id || "");
  const exactCandidateBound = Boolean(
    normalizedCandidateId
    && selectionReadyState?.candidate_selection_verified === true
    && expectedCandidateId === normalizedCandidateId
    && activeCandidateId === normalizedCandidateId
  );
  const exactExistingRequestState = Boolean(
    readyState?.already_requested_resume
    || readyState?.attachment_resume_enabled
  );
  const recoverableRequestJournal = Boolean(
    actionJournalRecord?.state === "request_in_flight"
    || (
      actionJournalRecord?.state === "outcome_unknown"
      && chatActionUnknownOrigin(actionJournalRecord) === "request_in_flight"
    )
  );
  if (
    !exactCandidateBound
    || !exactExistingRequestState
    || !recoverableRequestJournal
    || actionJournalRecord?.candidate_id !== normalizedCandidateId
    || typeof actionJournal?.transition !== "function"
    || typeof checkpointCritical !== "function"
  ) {
    return null;
  }

  const confirmationSource = readyState.already_requested_resume
    ? "exact_requested_resume_state"
    : "attachment_resume_available";
  const transitioned = actionJournal.transition({
    scope: actionJournalScope,
    candidateId: normalizedCandidateId,
    state: "request_confirmed",
    runId,
    greeting,
    evidence: {
      active_candidate_id: activeCandidateId,
      reason: "recovered_from_exact_existing_request_state_before_screening",
      message_observed: Boolean(readyState.already_requested_resume),
      request_ready_state_observed: true,
      request_confirmation_source: confirmationSource
    }
  });
  const actionTransaction = compactChatActionJournalRecord(
    transitioned.record,
    transitioned.file_path
  );
  checkpointCritical({ action_transaction: actionTransaction });
  return {
    requested: false,
    skipped: true,
    satisfied: true,
    reason: "request_confirmed_from_exact_existing_state",
    initial_state: readyState,
    journal_reconciled_existing_state: true,
    action_transaction: actionTransaction
  };
}

export function preserveChatRequestOutcomeUnknownWithoutReplay({
  actionJournalRecord = null,
  candidateId = "",
  activeCandidateId = "",
  readyEvidence = null,
  messageEvidence = null
} = {}) {
  const normalizedCandidateId = normalizeText(candidateId);
  const normalizedActiveCandidateId = normalizeText(activeCandidateId);
  const exactCandidateBound = Boolean(
    normalizedCandidateId
    && normalizedActiveCandidateId === normalizedCandidateId
    && normalizeText(actionJournalRecord?.candidate_id || "") === normalizedCandidateId
  );
  if (
    !exactCandidateBound
    || actionJournalRecord?.state !== "outcome_unknown"
    || chatActionUnknownOrigin(actionJournalRecord) !== "request_in_flight"
  ) {
    return null;
  }

  const requestMessageCount = Number(messageEvidence?.count);
  const resumeAttachmentCount = Number(messageEvidence?.resume_attachment_count);
  return {
    requested: false,
    skipped: true,
    satisfied: false,
    reason: "outcome_unknown_preserved_no_replay",
    initial_state: readyEvidence || null,
    journal_preserved_outcome_unknown: true,
    no_replay: true,
    action_unknown_origin: "request_in_flight",
    request_verification: {
      ready_state_readable: Boolean(readyEvidence),
      message_state_readable: messageEvidence?.ok === true,
      request_message_count: Number.isFinite(requestMessageCount) ? requestMessageCount : null,
      resume_attachment_count: Number.isFinite(resumeAttachmentCount) ? resumeAttachmentCount : null,
      request_marker_observed: Boolean(readyEvidence?.already_requested_resume),
      attachment_resume_observed: Boolean(readyEvidence?.attachment_resume_enabled)
    },
    action_transaction: compactChatActionJournalRecord(actionJournalRecord)
  };
}

export function applyChatProtectedOutcomeSkip(screening = null, postAction = null, candidate = null) {
  if (postAction?.journal_preserved_outcome_unknown !== true) return screening;
  return {
    status: "skip",
    passed: false,
    score: 0,
    reasons: [postAction.reason || "outcome_unknown_preserved_no_replay"],
    candidate: candidate || screening?.candidate || null
  };
}

function makeChatPostActionOutcomeUnknownError(candidateId, record, evidence = {}) {
  const error = new Error(`POST_ACTION_OUTCOME_UNKNOWN: candidate=${candidateId || "unknown"}; state=${record?.state || "unknown"}`);
  error.code = "POST_ACTION_OUTCOME_UNKNOWN";
  error.retryable = false;
  error.candidate_id = candidateId || null;
  error.action_state = record?.state || null;
  error.action_unknown_origin = chatActionUnknownOrigin(record);
  error.action_evidence = evidence;
  return error;
}

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
    review_required: typeof llmResult.review_required === "boolean" ? llmResult.review_required : null,
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
    screening_strategy: llmResult.screening_strategy || "",
    fast_thinking_level: llmResult.fast_thinking_level || "",
    verify_thinking_level: llmResult.verify_thinking_level || "",
    verified: typeof llmResult.verified === "boolean" ? llmResult.verified : null,
    verification_reason: llmResult.verification_reason || "",
    decision_source: llmResult.decision_source || "",
    fast_result: llmResult.fast_result || null,
    verify_result: llmResult.verify_result || null,
    error_code: llmResult.error_code || null,
    fatal: Boolean(llmResult.fatal),
    fatal_reason: llmResult.fatal_reason || "",
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

export function consumeChatDetailRecoveryBudget(recoveryCounts, candidateKey, {
  retryLimit = 1
} = {}) {
  if (!(recoveryCounts instanceof Map)) {
    throw new TypeError("consumeChatDetailRecoveryBudget requires a recovery-count Map");
  }
  const key = String(candidateKey || "").trim() || "__unknown_candidate__";
  const limit = Math.max(0, Math.floor(Number(retryLimit) || 0));
  const previousCount = Math.max(0, Math.floor(Number(recoveryCounts.get(key)) || 0));
  if (previousCount >= limit) {
    return {
      allowed: false,
      previous_count: previousCount,
      count: previousCount,
      retry_limit: limit
    };
  }
  const count = previousCount + 1;
  recoveryCounts.set(key, count);
  return {
    allowed: true,
    previous_count: previousCount,
    count,
    retry_limit: limit
  };
}

export function compactChatCandidateSelectionReadyState(selectionReadyState = null) {
  if (!selectionReadyState) return null;
  const activeCandidate = selectionReadyState.activeCandidate || selectionReadyState.active_candidate || null;
  return {
    ok: selectionReadyState.ok === true,
    reason: selectionReadyState.reason || null,
    elapsed_ms: Number.isFinite(Number(selectionReadyState.elapsed_ms))
      ? Number(selectionReadyState.elapsed_ms)
      : null,
    expected_candidate_id: normalizeText(selectionReadyState.expected_candidate_id || "") || null,
    active_candidate_id: normalizeText(selectionReadyState.active_candidate_id || "") || null,
    candidate_selection_verified: selectionReadyState.candidate_selection_verified === true,
    active_candidate: activeCandidate
      ? {
          node_id: activeCandidate.node_id || null,
          selector: activeCandidate.selector || null,
          candidate_id: normalizeText(activeCandidate.candidate_id || "") || null,
          label: normalizeText(activeCandidate.label || "") || null,
          outer_html_length: activeCandidate.outer_html_length || 0
        }
      : null
  };
}

export function makeChatCandidateSelectionMismatchError(selected = null, candidate = null) {
  const expectedId = candidate?.id || selected?.ready?.expected_candidate_id || "";
  const activeId = selected?.ready?.active_candidate_id || "";
  const error = new Error(`CHAT_ACTIVE_CANDIDATE_MISMATCH: expected=${expectedId || "unknown"} active=${activeId || "unknown"}`);
  error.code = "CHAT_ACTIVE_CANDIDATE_MISMATCH";
  error.selection = selected || null;
  error.selection_ready_state = selected?.ready || null;
  error.candidate = candidate || null;
  return error;
}

export function isChatCandidateSelectionMismatchError(error) {
  return error?.code === "CHAT_ACTIVE_CANDIDATE_MISMATCH"
    || /CHAT_ACTIVE_CANDIDATE_MISMATCH/i.test(String(error?.message || error || ""));
}

export function requireExactChatCandidateSelection(selected = null, candidate = null) {
  const candidateId = normalizeText(candidate?.id || "");
  const selectionReadyState = selected?.ready || null;
  const expectedCandidateId = normalizeText(selectionReadyState?.expected_candidate_id || "");
  const activeCandidateId = normalizeText(selectionReadyState?.active_candidate_id || "");
  const exactCandidateBound = Boolean(
    candidateId
    && selectionReadyState?.candidate_selection_verified === true
    && expectedCandidateId === candidateId
    && activeCandidateId === candidateId
  );
  if (!exactCandidateBound) {
    throw makeChatCandidateSelectionMismatchError(selected, candidate);
  }
  return selectionReadyState;
}

export async function ensureNoOpenChatResumeModalBeforeCandidateClick(client, {
  closeAttempts = 3
} = {}) {
  const probe = await quickChatResumeModalOpenProbe(client);
  if (!probe.open) {
    const panelCloseResult = await closeChatBlockingPanels(client, { attemptsLimit: closeAttempts });
    if (panelCloseResult?.closed) {
      return {
        closed: true,
        already_closed: panelCloseResult.already_closed,
        probe,
        blocking_panel_close_result: panelCloseResult
      };
    }
    throw makeChatResumeModalOpenBeforeCandidateClickError({
      closed: false,
      reason: "blocking_panel_open_before_candidate_click",
      resume_modal_probe: probe,
      blocking_panel_close_result: panelCloseResult
    });
  }
  const closeResult = await closeChatResumeModal(client, { attemptsLimit: closeAttempts });
  if (closeResult?.closed) {
    const panelCloseResult = await closeChatBlockingPanels(client, { attemptsLimit: closeAttempts });
    if (!panelCloseResult?.closed) {
      throw makeChatResumeModalOpenBeforeCandidateClickError({
        closed: false,
        reason: "blocking_panel_open_after_resume_modal_close",
        close_result: closeResult,
        blocking_panel_close_result: panelCloseResult
      });
    }
    return {
      closed: true,
      already_closed: false,
      probe,
      close_result: closeResult,
      blocking_panel_close_result: panelCloseResult
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
    error_code: error?.code || null,
    fatal: Boolean(isFatalLlmProviderError(error)),
    fatal_reason: error?.llm_fatal_reason || "",
    error: error?.message || String(error || "unknown"),
    screened_at: new Date().toISOString()
  };
}

export function isRecoverableChatImageCaptureError(error) {
  return isRecoverableImageCaptureWorkflowError(error);
}

function normalizeScreeningMode(value) {
  const normalized = String(value || "llm").trim().toLowerCase();
  if (["collect_cv", "collect-cv", "cv_collection", "request_cv", "request_resume"].includes(normalized)) {
    return "collect_cv";
  }
  return ["deterministic", "local", "local_scorer"].includes(normalized)
    ? "deterministic"
    : "llm";
}

function isCvAcquiredOrAvailable(detailResult = null, preActionState = null) {
  return Boolean(
    preActionState?.attachment_resume_enabled
    || detailResult?.cv_acquisition?.full_cv_evidence?.full_cv_acquired
  );
}

function isChatResumeRequestAvailable(preActionState = null) {
  return Boolean(preActionState?.ask_resume?.node_id && !preActionState.ask_resume.disabled);
}

function shouldSkipCvCollectionForDetailReason(reason = "") {
  const normalized = normalizeText(reason);
  return [
    "active_candidate_mismatch",
    "forbidden_top_level_resume_navigation",
    "online_resume_modal_did_not_open",
    "unsafe_online_resume_navigation_link"
  ].includes(normalized)
    || normalized.startsWith("recoverable_cdp_node_stale:")
    || normalized.startsWith("resume_modal_close_failed:");
}

export function createCvCollectionScreening(screeningCandidate, {
  detailResult = null,
  detailUnavailableReason = "",
  preActionState = null
} = {}) {
  if (preActionState?.already_requested_resume) {
    return {
      status: "skip",
      passed: false,
      score: 0,
      reasons: ["resume_request_already_pending"],
      candidate: screeningCandidate
    };
  }
  if (isCvAcquiredOrAvailable(detailResult, preActionState)) {
    const reason = preActionState?.attachment_resume_enabled
      ? "attachment_resume_already_available"
      : "online_cv_already_available";
    return {
      status: "skip",
      passed: false,
      score: 0,
      reasons: [reason],
      candidate: screeningCandidate
    };
  }
  if (isChatResumeRequestAvailable(preActionState)) {
    const reason = detailUnavailableReason || "request_cv_available";
    return {
      status: "pass",
      passed: true,
      score: 100,
      reasons: [`collect_cv:${reason}`],
      candidate: screeningCandidate
    };
  }
  if (shouldSkipCvCollectionForDetailReason(detailUnavailableReason)) {
    return {
      status: "skip",
      passed: false,
      score: 0,
      reasons: [detailUnavailableReason],
      candidate: screeningCandidate
    };
  }
  const reason = detailUnavailableReason || "cv_collection_missing_online_cv";
  return {
    status: "pass",
    passed: true,
    score: 100,
    reasons: [`collect_cv:${reason}`],
    candidate: screeningCandidate
  };
}

export function shouldOpenOnlineResumeForChatDetail({
  collectCvOnly = false,
  detailResult = null
} = {}) {
  return !collectCvOnly && !detailResult;
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
    retryable: typeof error.retryable === "boolean" ? error.retryable : null,
    attempts: Array.isArray(error.attempts) ? error.attempts : null,
    close_result: error.close_result || null,
    selection_ready_state: error.selection_ready_state || null,
    page_state: error.page_state || null
  };
}

async function captureChatFinalFailureArtifact(client, {
  runControl,
  imageOutputDir = "",
  error = null
} = {}) {
  if (!client || !imageOutputDir || !runControl?.runId) return null;
  const artifact = {
    schema_version: 1,
    kind: "chat_final_failure_page",
    captured_at: new Date().toISOString(),
    run_id: runControl.runId,
    error: compactChatRuntimeError(error),
    page_state: null,
    active_candidate_state: null,
    conversation_ready_state: null,
    screenshot: null,
    screenshot_error: null
  };
  try {
    artifact.page_state = await getChatTopLevelState(client);
  } catch (pageError) {
    artifact.page_state = {
      error: pageError?.message || String(pageError)
    };
  }
  try {
    artifact.active_candidate_state = await readChatActiveCandidateState(client);
  } catch (activeCandidateError) {
    artifact.active_candidate_state = {
      error: activeCandidateError?.message || String(activeCandidateError)
    };
  }
  try {
    artifact.conversation_ready_state = await readChatConversationReadyState(client);
  } catch (conversationError) {
    artifact.conversation_ready_state = {
      error: conversationError?.message || String(conversationError)
    };
  }
  try {
    artifact.screenshot = await captureViewportScreenshot(client, {
      format: "jpeg",
      quality: 72,
      metadata: {
        domain: "chat",
        run_id: runControl.runId,
        reason: "final_failure"
      }
    });
  } catch (screenshotError) {
    artifact.screenshot_error = screenshotError?.message || String(screenshotError);
  }
  return artifact;
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
  if (
    !imageEvidence
    || imageEvidence.ok === false
    || imageEvidence.coverage_complete !== true
    || isIncompleteImageEvidence(imageEvidence)
  ) return false;
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
  settleMs = 1200,
  onlineResumeProbe = true
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
      const ready = onlineResumeProbe
        ? await waitForChatOnlineResumeButton(client, {
            timeoutMs,
            expectedCandidateId: candidate?.id || ""
          })
        : await readSelectedChatCandidateState(client, candidate);
      const selected = {
        card_box: box,
        ready,
        card_node_id: freshNodeId,
        refreshed_node: freshNodeId !== cardNodeId,
        modal_guard: modalGuard,
        attempt: attempt + 1
      };
      if (!ready?.forbidden_top_level_navigation) {
        requireExactChatCandidateSelection(selected, candidate);
      }
      return selected;
    } catch (error) {
      lastError = error;
      if (!isRecoverableCdpNodeError(error)) throw error;
      await sleep(350);
    }
  }
  throw lastError || new Error("Chat candidate selection failed");
}

async function readSelectedChatCandidateState(client, candidate = null) {
  const topLevelState = await getChatTopLevelState(client);
  if (topLevelState.is_security_verification) {
    throw makeBossSecurityVerificationRequiredError(
      topLevelState,
      "chat_candidate_selection"
    );
  }
  if (topLevelState.is_forbidden_resume_top_level) {
    return {
      forbidden_top_level_navigation: true,
      top_level_state: topLevelState
    };
  }
  const activeState = await readChatActiveCandidateState(client);
  const expectedId = normalizeText(candidate?.id || "");
  const activeCandidateId = normalizeText(activeState?.active_candidate?.candidate_id || "");
  const candidateSelectionVerified = expectedId
    ? activeCandidateId === expectedId
    : undefined;
  return {
    ok: !expectedId || candidateSelectionVerified === true,
    reason: expectedId && candidateSelectionVerified !== true
      ? "active_candidate_mismatch"
      : "online_resume_probe_skipped",
    roots: activeState.roots,
    activeCandidate: activeState.active_candidate,
    expected_candidate_id: expectedId || null,
    active_candidate_id: activeCandidateId || null,
    candidate_selection_verified: candidateSelectionVerified
  };
}

export function hasScreenableChatFullCvEvidence(fullCvEvidence = null, imageEvidence = null) {
  if (fullCvEvidence?.source === "image") {
    return Boolean(fullCvEvidence.full_cv_acquired && hasUsableImageEvidence(imageEvidence));
  }
  return Boolean(
    fullCvEvidence?.full_cv_acquired
    && !isIncompleteImageEvidence(imageEvidence)
  );
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
  imageOutputDir = "",
  humanRestEnabled = false,
  humanBehavior = null,
  actionJournal = null,
  actionJournalScope = "boss-chat:default"
} = {}, runControl) {
  if (!client) throw new Error("runChatWorkflow requires a guarded CDP client");
  const effectiveHumanBehavior = normalizeHumanBehaviorOptions(humanBehavior, {
    legacyEnabled: humanRestEnabled === true || llmConfig?.humanRestEnabled === true
  });
  const normalizedDetailSource = normalizeDetailSource(detailSource);
  const normalizedScreeningMode = normalizeText(criteria) ? normalizeScreeningMode(screeningMode) : "collect_cv";
  const collectCvOnly = normalizedScreeningMode === "collect_cv" || !normalizeText(criteria);
  const useLlmScreening = normalizedScreeningMode === "llm" && !collectCvOnly;
  const collectCvProcessingFloorEnabled = collectCvOnly;
  const collectCvPerCandidateRestEnabled = false;
  const effectiveHumanRestEnabled = effectiveHumanBehavior.restEnabled;
  const effectiveActionJournal = requestResumeForPassed
    ? actionJournal || createChatActionJournal()
    : actionJournal;
  configureHumanInteraction(client, {
    enabled: effectiveHumanBehavior.enabled,
    clickMovementEnabled: effectiveHumanBehavior.clickMovement,
    textEntryEnabled: effectiveHumanBehavior.textEntry,
    safeClickPointEnabled: effectiveHumanBehavior.clickMovement,
    actionCooldownEnabled: effectiveHumanBehavior.actionCooldown
  });
  const humanRestController = createHumanRestController({
    enabled: effectiveHumanRestEnabled,
    shortRestEnabled: effectiveHumanBehavior.shortRest,
    batchRestEnabled: effectiveHumanBehavior.batchRest,
    restLevel: effectiveHumanBehavior.restLevel
  });
  const collectCvProcessingFloorState = {
    enabled: collectCvProcessingFloorEnabled,
    min_ms: collectCvProcessingFloorEnabled ? CHAT_COLLECT_CV_PROCESSING_FLOOR_MIN_MS : null,
    max_ms: collectCvProcessingFloorEnabled ? CHAT_COLLECT_CV_PROCESSING_FLOOR_MAX_MS : null,
    count: 0,
    total_delay_requested_ms: 0,
    total_delay_elapsed_ms: 0,
    last: null
  };
  const collectCvProcessingFloorSnapshot = () => ({
    ...collectCvProcessingFloorState,
    last: collectCvProcessingFloorState.last
      ? { ...collectCvProcessingFloorState.last }
      : null
  });
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
  let contextRecoveryAttempts = 0;
  const candidateRecoveryCounts = new Map();
  const imageCaptureWorkflowRetries = createImageCaptureWorkflowRetryTracker();
  let lastHumanEvent = null;

  function recordHumanEvent(event = null) {
    if (!event) return lastHumanEvent;
    lastHumanEvent = {
      at: new Date().toISOString(),
      ...event
    };
    return lastHumanEvent;
  }

  async function maybeHumanActionCooldown(phase, timings = {}) {
    if (!effectiveHumanBehavior.actionCooldown) return null;
    const pauseMs = humanDelay(280, 90, {
      minMs: 80,
      maxMs: 720
    });
    if (pauseMs > 0) {
      await runControl.sleep(pauseMs);
      addTiming(timings, `human_${phase}_pause_ms`, pauseMs);
    }
    return recordHumanEvent({
      kind: "action_cooldown",
      phase,
      pause_ms: pauseMs
    });
  }

  runControl.setPhase("chat:cleanup");
  let initialTopLevelState = await getChatTopLevelState(client);
  if (initialTopLevelState.is_security_verification) {
    throw makeBossSecurityVerificationRequiredError(
      initialTopLevelState,
      "chat_run_setup"
    );
  }
  if (!initialTopLevelState.is_chat_shell) {
    const recovery = await recoverChatShell(client, {
      targetUrl,
      timeoutMs: readyTimeoutMs,
      settleAfterNavigate: true
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
  await closeChatBlockingPanels(client, { attemptsLimit: 2 });

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
    contextRecoveryAttempts += 1;
    const shellRecovery = await recoverChatShell(client, {
      targetUrl,
      timeoutMs: readyTimeoutMs,
      forceNavigate: forceRefresh,
      settleAfterNavigate: true
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
    await closeChatBlockingPanels(client, { attemptsLimit: 2 });
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
      attempt: contextRecoveryAttempts,
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
      context_recoveries: contextRecoveryAttempts,
      list_end_reason: listEndReason,
      viewport_checks: viewportGuard.getStats().checks,
      viewport_recoveries: viewportGuard.getStats().recoveries,
      human_behavior_enabled: effectiveHumanBehavior.enabled,
      human_behavior_profile: effectiveHumanBehavior.profile,
      human_rest_level: effectiveHumanBehavior.restLevel,
      human_rest_enabled: effectiveHumanRestEnabled,
      human_rest_per_candidate_enabled: collectCvPerCandidateRestEnabled,
      human_rest_per_candidate_min_ms: null,
      human_rest_per_candidate_max_ms: null,
      collect_cv_processing_floor_enabled: collectCvProcessingFloorEnabled,
      collect_cv_processing_floor_min_ms: collectCvProcessingFloorState.min_ms,
      collect_cv_processing_floor_max_ms: collectCvProcessingFloorState.max_ms,
      collect_cv_processing_floor_count: collectCvProcessingFloorState.count,
      collect_cv_processing_floor_delay_requested_ms: collectCvProcessingFloorState.total_delay_requested_ms,
      collect_cv_processing_floor_delay_ms: collectCvProcessingFloorState.total_delay_elapsed_ms,
      human_rest_count: humanRestController.getState().rest_count,
      human_rest_ms: humanRestController.getState().total_rest_ms,
      last_human_event: lastHumanEvent
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
      human_behavior: effectiveHumanBehavior,
      human_rest: humanRestController.getState(),
      collect_cv_processing_floor: collectCvProcessingFloorSnapshot(),
      last_human_event: lastHumanEvent,
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
      context_recoveries: contextRecoveryAttempts,
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
    context_recoveries: contextRecoveryAttempts,
    viewport_checks: viewportGuard.getStats().checks,
    viewport_recoveries: viewportGuard.getStats().recoveries,
    human_behavior_enabled: effectiveHumanBehavior.enabled,
    human_behavior_profile: effectiveHumanBehavior.profile,
    human_rest_level: effectiveHumanBehavior.restLevel,
    human_rest_enabled: effectiveHumanRestEnabled,
    human_rest_per_candidate_enabled: collectCvPerCandidateRestEnabled,
    human_rest_per_candidate_min_ms: null,
    human_rest_per_candidate_max_ms: null,
    collect_cv_processing_floor_enabled: collectCvProcessingFloorEnabled,
    collect_cv_processing_floor_min_ms: collectCvProcessingFloorState.min_ms,
    collect_cv_processing_floor_max_ms: collectCvProcessingFloorState.max_ms,
    collect_cv_processing_floor_count: collectCvProcessingFloorState.count,
    collect_cv_processing_floor_delay_requested_ms: collectCvProcessingFloorState.total_delay_requested_ms,
    collect_cv_processing_floor_delay_ms: collectCvProcessingFloorState.total_delay_elapsed_ms,
    collect_cv_processing_floor_current: null,
    human_rest_count: humanRestController.getState().rest_count,
    human_rest_ms: humanRestController.getState().total_rest_ms,
    last_human_event: lastHumanEvent
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
    rootState = await ensureChatViewport(await getChatRoots(client), "candidate_loop");
    const loopTopLevelState = await getChatTopLevelState(client);
    if (loopTopLevelState.is_security_verification) {
      throw makeBossSecurityVerificationRequiredError(
        loopTopLevelState,
        "chat_candidate_loop"
      );
    }
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
        runControl.checkpoint({
          chat_context_step: "job_guard_failed",
          job_guard: compactChatJobGuard(jobGuard),
          error: {
            code: error.code,
            message: error.message
          }
        });
        if (contextRecoveryAttempts < 2) {
          await recoverAndReapplyChatContext("job_guard_failed", error, { forceRefresh: true });
          continue;
        }
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
      listScrollJitterEnabled: effectiveHumanBehavior.listScrollJitter,
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
      if (endTopLevelState.is_security_verification) {
        throw makeBossSecurityVerificationRequiredError(
          endTopLevelState,
          "chat_candidate_list_end"
        );
      }
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
    const candidateProcessingStarted = Date.now();
    const candidateProcessingFloorTargetMs = collectCvProcessingFloorEnabled
      ? sampleChatCollectCvProcessingFloorMs()
      : 0;

    let screeningCandidate = cardCandidate;
    let detailResult = null;
    let preActionState = null;
    let selectionReadyState = null;
    let preScreeningActionReconciliation = null;
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
        checkpointInProgressCandidate({ event: "detail_start" });
        rootState = await ensureChatViewport(rootState, "detail");

        detailStep = "select_candidate";
        networkRecorder.clear();
        await maybeHumanActionCooldown("before_detail_open", timings);
        const selected = await measureTiming(timings, "candidate_click_ms", () => selectFreshChatCandidate(client, {
          cardNodeId,
          candidate: cardCandidate,
          timeoutMs: onlineResumeButtonTimeoutMs,
          onlineResumeProbe: !collectCvOnly
        }));
        if (selected.ready?.forbidden_top_level_navigation) {
          throw makeForbiddenChatResumeNavigationError(selected.ready.top_level_state);
        }
        selectionReadyState = selected.ready || null;
        effectiveCardNodeId = selected.card_node_id || cardNodeId;
        checkpointInProgressCandidate({
          event: "candidate_selection_verified",
          selection_ready_state: compactChatCandidateSelectionReadyState(selectionReadyState)
        });
        const selectionNetworkEvents = networkRecorder.events.slice();
        try {
          preActionState = await readChatConversationReadyState(client);
        } catch (error) {
          preActionState = {
            error: error?.message || String(error)
          };
        }
        if (
          requestResumeForPassed
          && !dryRunRequestCv
          && effectiveActionJournal
          && (preActionState?.already_requested_resume || preActionState?.attachment_resume_enabled)
        ) {
          const candidateId = normalizeText(cardCandidate.id || "");
          const actionJournalRecord = candidateId
            ? effectiveActionJournal.read({
                scope: actionJournalScope,
                candidateId
              })
            : null;
          preScreeningActionReconciliation = reconcileChatRequestJournalFromExactExistingState({
            actionJournal: effectiveActionJournal,
            actionJournalScope,
            actionJournalRecord,
            candidateId,
            selectionReadyState: selected.ready,
            readyState: preActionState,
            runId: runControl.runId,
            greeting: greetingText,
            checkpointCritical: (patch) => runControl.checkpointCritical(patch)
          });
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
            throw makeChatCandidateSelectionMismatchError(selected, cardCandidate);
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
        if (collectCvOnly && !detailResult) {
          detailUnavailableReason = preActionState?.has_online_resume
            ? "collect_cv_request_candidate"
            : "collect_cv_missing_online_resume";
        }

        if (shouldOpenOnlineResumeForChatDetail({ collectCvOnly, detailResult })) {
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
            await maybeHumanActionCooldown("before_resume_open", timings);
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
              const imageEvidencePath = imageEvidenceFilePath({
                imageOutputDir,
                domain: "chat",
                runId: runControl?.runId,
                index,
                extension: "jpg"
              });
              const captureImageForTarget = (target, targetWait, resumeCheckpoint = null) => captureScrolledNodeScreenshots(
                client,
                target.node_id,
                {
                  filePath: imageEvidencePath,
                  format: "jpeg",
                  quality: 72,
                  optimize: true,
                  resizeMaxWidth: 1100,
                  captureViewport: false,
                  iframeOwnerNodeId: target?.iframe_node_id || null,
                  padding: 0,
                  maxScreenshots: maxImagePages,
                  wheelDeltaY: imageWheelDeltaY,
                  settleMs: 350,
                  scrollMethod: "dom-anchor-fallback-input",
                  scrollDeltaJitterEnabled: effectiveHumanBehavior.listScrollJitter,
                  stepTimeoutMs: 45000,
                  totalTimeoutMs: 90000,
                  duplicateStopCount: 2,
                  skipDuplicateScreenshots: true,
                  requireTerminalProof: true,
                  composeForLlm: true,
                  llmPagesPerImage: 3,
                  llmResizeMaxWidth: 1100,
                  llmQuality: 72,
                  stopBoundarySelector: CHAT_RESUME_IMAGE_STOP_BOUNDARY_SELECTOR,
                  stopBoundaryTextPatterns: CHAT_RESUME_IMAGE_STOP_BOUNDARY_TEXT,
                  stopBoundaryMaxProbeNodes: 360,
                  stopBoundaryTopPadding: 10,
                  stopBoundaryMinCaptureHeight: 180,
                  resumeCheckpoint,
                  metadata: {
                    domain: "chat",
                    capture_mode: "scroll_sequence",
                    capture_scope: "resume_modal_clip",
                    acquisition_reason: normalizedDetailSource === "image"
                      ? "forced_image"
                      : "network_miss_image_fallback",
                    run_candidate_index: index,
                    candidate_key: candidateKey,
                    capture_target: target,
                    capture_target_wait: targetWait,
                    resumed_from_checkpoint: Boolean(resumeCheckpoint)
                  }
                }
              );
              detailStep = "capture_image_fallback";
              try {
                imageEvidence = await measureTiming(
                  timings,
                  "screenshot_capture_ms",
                  () => captureImageForTarget(captureTarget, captureTargetWait)
                );
                imageEvidence = requireCompleteImageEvidence(imageEvidence, {
                  code: "IMAGE_CAPTURE_EVIDENCE_MISSING",
                  message: "Chat CV capture returned no complete persisted evidence",
                  metadata: { domain: "chat", candidate_key: candidateKey }
                });
              } catch (error) {
                if (!isRecoverableChatImageCaptureError(error)) throw error;
                const retryReservation = imageCaptureWorkflowRetries.consume(candidateKey);
                const resumeCheckpoint = retryReservation.allowed
                  ? imageCaptureResumeCheckpoint(error)
                  : null;
                timings.image_capture_workflow_retry = retryReservation;
                if (!resumeCheckpoint) {
                  imageEvidence = createRequiredImageEvidenceFailure({
                    code: error?.code || "IMAGE_CAPTURE_CHECKPOINT_UNAVAILABLE",
                    message: error?.message || "Chat CV capture failed without a resumable checkpoint",
                    metadata: {
                      domain: "chat",
                      candidate_key: candidateKey,
                      image_capture_workflow_retry: retryReservation
                    }
                  });
                  timings.image_capture_resume = {
                    attempted: false,
                    ok: false,
                    phase: "checkpoint",
                    error: compactChatRuntimeError(error)
                  };
                } else {
                  checkpointInProgressCandidate({
                    event: "resume_image_capture_reacquire",
                    error: compactChatRuntimeError(error),
                    checkpoint_id: resumeCheckpoint.checkpoint_id || null
                  });
                  detailStep = "resume_image_capture_reacquire";
                  const resumeAttempt = await attemptImageCaptureCheckpointResume({
                  checkpoint: resumeCheckpoint,
                  reacquire: () => reacquireImageCaptureResumeTarget({
                    domain: "chat",
                    getRoots: () => getChatRoots(client),
                    ensureViewport: (freshRoots) => ensureChatViewport(
                      freshRoots,
                      "image_capture_resume_reacquire"
                    ),
                    getDetailState: () => waitForChatResumeModal(client, {
                      timeoutMs: 4000,
                      intervalMs: 200
                    }),
                    isDetailAvailable: (state) => Boolean(
                      !state?.forbidden_top_level_navigation
                      && (state?.popup || state?.content || state?.resumeIframe)
                    ),
                    waitForTarget: (detailState) => waitForCvCaptureTarget(client, detailState, {
                      domain: "chat",
                      timeoutMs: 4000,
                      intervalMs: 200
                    })
                  }),
                  capture: (reacquired) => {
                    rootState = reacquired.root_state;
                    resumeState = reacquired.detail_state;
                    captureTarget = reacquired.target;
                    captureTargetWait = reacquired.target_wait;
                    detailStep = "resume_image_capture";
                    return measureTiming(
                      timings,
                      "screenshot_capture_ms",
                      () => captureImageForTarget(captureTarget, captureTargetWait, resumeCheckpoint)
                    );
                  }
                  });
                  if (resumeAttempt.outcome === "reacquire_failed") {
                    const reacquireError = resumeAttempt.error;
                    imageEvidence = createRequiredImageEvidenceFailure({
                      code: reacquireError?.code || "IMAGE_CAPTURE_RESUME_REACQUIRE_FAILED",
                      message: reacquireError?.message || "Chat CV target reacquisition failed",
                      metadata: {
                        domain: "chat",
                        candidate_key: candidateKey,
                        resumed_from_checkpoint: true,
                        resume_checkpoint_id: resumeCheckpoint.checkpoint_id || null
                      }
                    });
                    imageEvidence.resumed_from_checkpoint = true;
                    imageEvidence.resume_checkpoint_id = resumeCheckpoint.checkpoint_id || null;
                    imageEvidence.coverage_checkpoint = resumeCheckpoint;
                    timings.image_capture_resume = {
                      attempted: true,
                      ok: false,
                      phase: "reacquire",
                      checkpoint_id: resumeCheckpoint.checkpoint_id || null,
                      error: compactChatRuntimeError(reacquireError)
                    };
                  }
                  if (resumeAttempt.outcome === "completed") {
                    imageEvidence = requireCompleteImageEvidence(resumeAttempt.evidence, {
                      code: "IMAGE_CAPTURE_RESUME_EVIDENCE_MISSING",
                      message: "Chat resumed CV capture returned no complete persisted evidence",
                      metadata: { domain: "chat", candidate_key: candidateKey }
                    });
                    timings.image_capture_resume = {
                      attempted: true,
                      ok: !isIncompleteImageEvidence(imageEvidence),
                      phase: "capture",
                      checkpoint_id: resumeCheckpoint.checkpoint_id || null,
                      confirmed_screenshot_count: resumeCheckpoint.unique_screenshot_count || 0
                    };
                  } else if (resumeAttempt.outcome === "capture_failed") {
                    const resumeError = resumeAttempt.error;
                    const failedCheckpoint = resumeError.capture_checkpoint || resumeCheckpoint;
                    const failedScreenshots = Array.isArray(failedCheckpoint?.screenshots)
                      ? failedCheckpoint.screenshots
                      : [];
                    imageEvidence = {
                      schema_version: 1,
                      ok: false,
                      source: "image-scroll-sequence",
                      elapsed_ms: timings.screenshot_capture_ms || 0,
                      capture_count: failedCheckpoint?.confirmed_capture_count || failedScreenshots.length,
                      screenshot_count: failedScreenshots.length,
                      unique_screenshot_count: failedCheckpoint?.unique_screenshot_count || 0,
                      coverage_complete: false,
                      resumed_from_checkpoint: true,
                      resume_checkpoint_id: resumeCheckpoint.checkpoint_id || null,
                      error_code: resumeError?.code || "IMAGE_CAPTURE_RESUME_FAILED",
                      error: resumeError?.message || String(resumeError),
                      file_paths: failedScreenshots.map((item) => item?.file_path).filter(Boolean),
                      llm_file_paths: [],
                      coverage_checkpoint: failedCheckpoint
                    };
                    timings.image_capture_resume = {
                      attempted: true,
                      ok: false,
                      phase: "capture",
                      checkpoint_id: resumeCheckpoint.checkpoint_id || null,
                      error: compactChatRuntimeError(resumeError)
                    };
                  }
                }
              }
              source = isIncompleteImageEvidence(imageEvidence) ? "image_capture_failed" : "image";
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
              if (
                callLlmOnImage
                && hasScreenableChatFullCvEvidence(fullCvEvidence, imageEvidence)
              ) {
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
                    if (isFatalLlmProviderError(error)) {
                      throw createFatalLlmRunError(error, {
                        domain: "chat",
                        candidate: detailResult.candidate
                      });
                    }
                    llmResult = createFailedLlmResult(error);
                  }
                }
              }
            } else {
              source = "missing_capture_node";
              imageEvidence = createRequiredImageEvidenceFailure({
                code: "IMAGE_CAPTURE_TARGET_UNAVAILABLE",
                message: "Chat CV capture target was unavailable after the network fallback missed",
                metadata: {
                  domain: "chat",
                  candidate_key: candidateKey,
                  capture_target_wait: captureTargetWait || null
                }
              });
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
            if (!hasScreenableChatFullCvEvidence(fullCvEvidence, imageEvidence)) {
              if (isIncompleteImageEvidence(imageEvidence)) {
              detailUnavailableReason = `image_capture_failed:${String(
                imageEvidence?.error_code || "coverage_incomplete"
              ).toLowerCase()}`;
              } else {
                detailUnavailableReason = "full_cv_not_acquired";
              }
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
                  if (isFatalLlmProviderError(error)) {
                    throw createFatalLlmRunError(error, {
                      domain: "chat",
                      candidate: detailResult.candidate
                    });
                  }
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
            await maybeHumanActionCooldown("after_detail_close", timings);
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
          const retryReservation = consumeChatDetailRecoveryBudget(
            candidateRecoveryCounts,
            candidateKey
          );
          if (retryReservation.allowed) {
            const recoveryReason = `resume_modal_close_failed:${detailStep}`;
            const recovery = await recoverAndReapplyChatContext(recoveryReason, error, { forceRefresh: true });
            checkpointInProgressCandidate({
              event: "retry_after_modal_recovery",
              recovery,
              retry: retryReservation
            });
            continue;
          }
          detailUnavailableReason = "resume_modal_close_failed";
          detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason, error);
          detailResult.cv_acquisition.recovery_attempted = true;
          detailResult.cv_acquisition.recovery_attempt_count = retryReservation.count;
          detailResult.cv_acquisition.recovery_retry_limit = retryReservation.retry_limit;
        } else if (isChatCandidateSelectionMismatchError(error)) {
          const retryCount = candidateRecoveryCounts.get(candidateKey) || 0;
          if (retryCount < 1) {
            candidateRecoveryCounts.set(candidateKey, retryCount + 1);
            const recovery = await recoverAndReapplyChatContext(
              "active_candidate_mismatch",
              error,
              { forceRefresh: true }
            );
            checkpointInProgressCandidate({
              event: "retry_after_active_candidate_mismatch_recovery",
              recovery
            });
            continue;
          }
          error.retryable = false;
          checkpointInProgressCandidate({
            event: "active_candidate_mismatch_exhausted",
            selection_ready_state: compactChatCandidateSelectionReadyState(error.selection_ready_state),
            recovery_attempted: true,
            recovery_attempt_count: retryCount
          });
          throw error;
        } else if (isChatOnlineResumeModalOpenFailureError(error)) {
          const retryCount = candidateRecoveryCounts.get(candidateKey) || 0;
          if (retryCount < 1) {
            candidateRecoveryCounts.set(candidateKey, retryCount + 1);
            const recovery = await recoverAndReapplyChatContext(
              "online_resume_modal_did_not_open",
              error,
              { forceRefresh: true }
            );
            checkpointInProgressCandidate({
              event: "retry_after_online_resume_modal_open_failure",
              recovery
            });
            continue;
          }
          detailUnavailableReason = "online_resume_modal_did_not_open";
          detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason, error);
          detailResult.cv_acquisition.attempts = error.attempts || null;
          detailResult.cv_acquisition.recovery_attempted = true;
          detailResult.cv_acquisition.recovery_attempt_count = retryCount;
        } else if (isUnsafeChatOnlineResumeLinkError(error)) {
          detailUnavailableReason = "unsafe_online_resume_navigation_link";
          detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason, error);
          detailResult.cv_acquisition.blocked_pre_click = true;
          detailResult.cv_acquisition.button_href = error.href || null;
          detailResult.cv_acquisition.button_selector = error.button_selector || null;
          detailResult.cv_acquisition.attempts = error.attempts || null;
        } else if (isRecoverableChatImageCaptureError(error)) {
          detailUnavailableReason = `image_capture_failed:${String(error?.code || "unknown").toLowerCase()}`;
          detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason, error);
          detailResult.cv_acquisition.recovery_attempted = true;
          detailResult.cv_acquisition.recovery_attempt_count = imageCaptureWorkflowRetries.count(candidateKey);
          detailResult.image_evidence = createRequiredImageEvidenceFailure({
            code: error?.code || "IMAGE_CAPTURE_FAILED",
            message: error?.message || "Chat CV image capture failed",
            metadata: { domain: "chat", candidate_key: candidateKey }
          });
        } else {
          if (!isRecoverableCdpNodeError(error)) throw error;
          detailUnavailableReason = `recoverable_cdp_node_stale:${detailStep}`;
          detailResult = createSkippedDetailResult(cardCandidate, detailUnavailableReason, error);
          await closeChatResumeModal(client, { attemptsLimit: 2 });
          await closeChatBlockingPanels(client, { attemptsLimit: 2 });
        }
      }
      screeningCandidate = detailResult?.candidate || cardCandidate;
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
    let screening = collectCvOnly
      ? createCvCollectionScreening(screeningCandidate, {
          detailResult,
          detailUnavailableReason,
          preActionState
        })
      : detailUnavailableReason
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
    let postAction = preScreeningActionReconciliation;
    if (requestResumeForPassed && screening.passed) {
      await maybeHumanActionCooldown("before_post_action", timings);
      postAction = await measureTiming(timings, "post_action_ms", async () => {
        if (dryRunRequestCv) {
          return requestChatResumeForPassedCandidate(client, {
            greetingText,
            dryRun: true
          });
        }

        const candidateId = normalizeText(screeningCandidate.id || cardCandidate.id || "");
        if (!candidateId) {
          const error = new Error("CHAT_ACTION_CANDIDATE_ID_REQUIRED: refusing outbound action without a stable Boss candidate ID");
          error.code = "CHAT_ACTION_CANDIDATE_ID_REQUIRED";
          error.retryable = false;
          throw error;
        }
        if (!effectiveActionJournal) {
          const error = new Error("CHAT_ACTION_JOURNAL_REQUIRED: durable outbound action journal is unavailable");
          error.code = "CHAT_ACTION_JOURNAL_REQUIRED";
          error.retryable = false;
          throw error;
        }
        if (typeof runControl.checkpointCritical !== "function") {
          const error = new Error("CHAT_CRITICAL_CHECKPOINT_UNAVAILABLE: refusing outbound action without required checkpoint persistence");
          error.code = "CHAT_CRITICAL_CHECKPOINT_UNAVAILABLE";
          error.retryable = false;
          throw error;
        }

        const activeState = await readChatActiveCandidateState(client);
        const activeCandidateId = normalizeText(activeState?.active_candidate?.candidate_id || "");
        if (!activeCandidateId || activeCandidateId !== candidateId) {
          const error = new Error(`CHAT_ACTIVE_CANDIDATE_MISMATCH: expected=${candidateId}; active=${activeCandidateId || "unknown"}`);
          error.code = "CHAT_ACTIVE_CANDIDATE_MISMATCH";
          error.retryable = false;
          throw error;
        }

        let journalRecord = effectiveActionJournal.read({
          scope: actionJournalScope,
          candidateId
        });
        const transitionAction = async (state, evidence = {}) => {
          const transitioned = effectiveActionJournal.transition({
            scope: actionJournalScope,
            candidateId,
            state,
            runId: runControl.runId,
            greeting: greetingText,
            evidence: {
              ...evidence,
              active_candidate_id: activeCandidateId
            }
          });
          journalRecord = transitioned.record;
          runControl.checkpointCritical({
            action_transaction: compactChatActionJournalRecord(
              transitioned.record,
              transitioned.file_path
            )
          });
          return transitioned.record;
        };

        const currentReadyState = await readChatConversationReadyState(client);
        if (!journalRecord && (
          currentReadyState.attachment_resume_enabled
          || currentReadyState.already_requested_resume
        )) {
          return {
            requested: false,
            skipped: true,
            reason: currentReadyState.attachment_resume_enabled
              ? "attachment_resume_already_available"
              : "resume_request_already_pending",
            initial_state: currentReadyState,
            journal_bypassed_existing_state: true
          };
        }

        if (!journalRecord) {
          journalRecord = await transitionAction("pre_action", {
            active_candidate_id: activeCandidateId
          });
          const existingGreeting = await getChatGreetingMessageState(client, greetingText);
          if (existingGreeting.ok && existingGreeting.exact_count > 0) {
            journalRecord = await transitionAction("greeting_send_in_flight", {
              greeting_baseline_count: Math.max(0, existingGreeting.exact_count - 1),
              greeting_evidence_readable: true,
              reason: "preexisting_exact_greeting_detected"
            });
            journalRecord = await transitionAction("greeting_confirmed", {
              greeting_baseline_count: Math.max(0, existingGreeting.exact_count - 1),
              greeting_evidence_readable: true,
              reason: "preexisting_exact_greeting_detected"
            });
          }
        }

        if (journalRecord.state === "request_confirmed") {
          return {
            requested: false,
            skipped: true,
            satisfied: true,
            reason: "request_confirmed_by_durable_journal",
            action_transaction: compactChatActionJournalRecord(journalRecord)
          };
        }

        if (
          journalRecord.state === "greeting_confirmed"
          && (currentReadyState.attachment_resume_enabled || currentReadyState.already_requested_resume)
        ) {
          await transitionAction("request_in_flight", {
            request_baseline_count: 0,
            resume_attachment_baseline_count: 0,
            reason: "existing_request_state_before_input"
          });
          journalRecord = await transitionAction("request_confirmed", {
            reason: currentReadyState.attachment_resume_enabled
              ? "attachment_resume_already_available"
              : "resume_request_already_pending"
          });
          return {
            requested: false,
            skipped: true,
            satisfied: true,
            reason: "request_confirmed_from_existing_state",
            action_transaction: compactChatActionJournalRecord(journalRecord)
          };
        }

        const unknownOrigin = chatActionUnknownOrigin(journalRecord);
        if (
          journalRecord.state === "request_in_flight"
          || (journalRecord.state === "outcome_unknown" && unknownOrigin === "request_in_flight")
        ) {
          const {
            ready_state: readyEvidence,
            message_state: messageEvidence
          } = await readChatRequestVerificationEvidence(client);
          const baselineCount = Number(journalRecord.evidence?.request_baseline_count) || 0;
          const baselineAttachmentCount = Number(journalRecord.evidence?.resume_attachment_baseline_count) || 0;
          const requestConfirmed = Boolean(
            readyEvidence.attachment_resume_enabled
            || readyEvidence.already_requested_resume
            || messageEvidence.count > baselineCount
            || messageEvidence.resume_attachment_count > baselineAttachmentCount
          );
          if (requestConfirmed) {
            journalRecord = await transitionAction("request_confirmed", {
              reason: "recovered_from_exact_request_evidence",
              message_observed: messageEvidence.count > baselineCount,
              request_after_count: messageEvidence.count,
              resume_attachment_after_count: messageEvidence.resume_attachment_count
            });
            return {
              requested: false,
              skipped: true,
              satisfied: true,
              reason: "request_confirmed_after_in_flight_recovery",
              action_transaction: compactChatActionJournalRecord(journalRecord)
            };
          }
          const preservedUnknown = preserveChatRequestOutcomeUnknownWithoutReplay({
            actionJournalRecord: journalRecord,
            candidateId,
            activeCandidateId,
            readyEvidence,
            messageEvidence
          });
          if (preservedUnknown) return preservedUnknown;
          if (journalRecord.state !== "outcome_unknown") {
            journalRecord = await transitionAction("outcome_unknown", {
              action: "request_resume",
              reason: "in_flight_request_not_provable"
            });
          }
          throw makeChatPostActionOutcomeUnknownError(candidateId, journalRecord, {
            ready_state_readable: Boolean(readyEvidence),
            message_state_readable: Boolean(messageEvidence.ok)
          });
        }

        let skipGreeting = journalRecord.state === "greeting_confirmed";
        if (
          journalRecord.state === "greeting_send_in_flight"
          || (journalRecord.state === "outcome_unknown" && unknownOrigin === "greeting_send_in_flight")
        ) {
          const greetingEvidence = await getChatGreetingMessageState(client, greetingText);
          const baselineCount = Number(journalRecord.evidence?.greeting_baseline_count) || 0;
          if (greetingEvidence.ok && greetingEvidence.exact_count > baselineCount) {
            journalRecord = await transitionAction("greeting_confirmed", {
              reason: "recovered_from_exact_greeting_delta",
              greeting_baseline_count: baselineCount,
              greeting_evidence_readable: true
            });
            skipGreeting = true;
          } else {
            if (journalRecord.state !== "outcome_unknown") {
              journalRecord = await transitionAction("outcome_unknown", {
                action: "greeting_send",
                reason: greetingEvidence.ok
                  ? "in_flight_greeting_delta_absent"
                  : "in_flight_greeting_evidence_unreadable",
                greeting_baseline_count: baselineCount,
                greeting_evidence_readable: greetingEvidence.ok
              });
            }
            throw makeChatPostActionOutcomeUnknownError(candidateId, journalRecord, {
              greeting_evidence_readable: greetingEvidence.ok,
              greeting_exact_count: greetingEvidence.exact_count,
              greeting_baseline_count: baselineCount
            });
          }
        }

        if (journalRecord.state === "outcome_unknown") {
          throw makeChatPostActionOutcomeUnknownError(candidateId, journalRecord);
        }
        let editorPreActionRetryCount = 0;
        while (true) {
          try {
            const result = await requestChatResumeForPassedCandidate(client, {
              greetingText,
              dryRun: false,
              skipGreeting,
              actionTransition: transitionAction
            });
            if (editorPreActionRetryCount > 0) {
              return {
                ...result,
                editor_pre_action_recovery: {
                  recovered: true,
                  retry_count: editorPreActionRetryCount,
                  settle_ms: CHAT_EDITOR_PRE_ACTION_RETRY_SETTLE_MS
                }
              };
            }
            return result;
          } catch (error) {
            if (!shouldRetryChatEditorPreAction(
              error,
              journalRecord,
              editorPreActionRetryCount
            )) {
              throw error;
            }

            editorPreActionRetryCount += 1;
            runControl.checkpoint({
              chat_editor_pre_action_recovery: {
                candidate_id: candidateId,
                retry_count: editorPreActionRetryCount,
                settle_ms: CHAT_EDITOR_PRE_ACTION_RETRY_SETTLE_MS,
                reason: error?.code || error?.message || "CHAT_EDITOR_MESSAGE_MISMATCH",
                action_state: journalRecord.state,
                attempts: Array.isArray(error?.attempts) ? error.attempts : []
              }
            });
            await runControl.sleep(CHAT_EDITOR_PRE_ACTION_RETRY_SETTLE_MS);
            runControl.throwIfCanceled();

            const topLevelState = await getChatTopLevelState(client);
            if (topLevelState.is_security_verification) {
              throw makeBossSecurityVerificationRequiredError(
                topLevelState,
                "chat_editor_pre_action_recovery"
              );
            }
            const latestJournalRecord = effectiveActionJournal.read({
              scope: actionJournalScope,
              candidateId
            });
            if (latestJournalRecord?.state !== "pre_action") {
              throw error;
            }
            journalRecord = latestJournalRecord;

            const retryActiveState = await readChatActiveCandidateState(client);
            const retryActiveCandidateId = normalizeText(
              retryActiveState?.active_candidate?.candidate_id || ""
            );
            if (!retryActiveCandidateId || retryActiveCandidateId !== candidateId) {
              const mismatchError = new Error(
                `CHAT_ACTIVE_CANDIDATE_MISMATCH: expected=${candidateId}; active=${retryActiveCandidateId || "unknown"}`
              );
              mismatchError.code = "CHAT_ACTIVE_CANDIDATE_MISMATCH";
              mismatchError.retryable = false;
              throw mismatchError;
            }

            const retryReadyState = await readChatConversationReadyState(client);
            if (
              retryReadyState.attachment_resume_enabled
              || retryReadyState.already_requested_resume
            ) {
              return {
                requested: false,
                skipped: true,
                reason: retryReadyState.attachment_resume_enabled
                  ? "attachment_resume_already_available"
                  : "resume_request_already_pending",
                initial_state: retryReadyState,
                editor_pre_action_recovery: {
                  recovered: true,
                  retry_count: editorPreActionRetryCount,
                  settle_ms: CHAT_EDITOR_PRE_ACTION_RETRY_SETTLE_MS,
                  converged_to_existing_state: true
                }
              };
            }
          }
        }
      });
      screening = applyChatProtectedOutcomeSkip(screening, postAction, screeningCandidate);
      if (postAction?.requested) requestSatisfiedCount += 1;
      if (postAction?.satisfied && !postAction?.requested) requestSatisfiedCount += 1;
      if (postAction?.skipped) requestSkippedCount += 1;
      if (postAction?.requested && !postAction?.skipped) requestedCount += 1;
      if (!postAction?.requested && !postAction?.skipped && !dryRunRequestCv) {
        const verificationError = new Error(
          `REQUEST_CV_NOT_VERIFIED:${postAction?.reason || "unknown"}`
        );
        verificationError.code = "REQUEST_CV_NOT_VERIFIED";
        verificationError.retryable = false;
        verificationError.attempts = Array.isArray(postAction?.attempts)
          ? postAction.attempts
          : [];
        throw verificationError;
      }
    }
    // Every committed collect-CV outcome converges here: existing attachment/online CV,
    // an already-pending request, or a newly requested CV. Human-rest and delayMs remain later layers.
    let processingFloor = null;
    if (collectCvProcessingFloorEnabled) {
      const elapsedBeforeFloor = Math.max(0, Date.now() - candidateProcessingStarted);
      const floorCurrent = {
        candidate_id: screeningCandidate.id || null,
        candidate_key: candidateKey,
        target_ms: candidateProcessingFloorTargetMs,
        elapsed_before_ms: elapsedBeforeFloor,
        remaining_ms: Math.max(0, candidateProcessingFloorTargetMs - elapsedBeforeFloor)
      };
      runControl.setPhase("chat:collect_cv_processing_floor");
      runControl.updateProgress({
        collect_cv_processing_floor_current: floorCurrent
      });
      runControl.checkpoint({
        collect_cv_processing_floor_current: floorCurrent
      });
      processingFloor = await enforceChatCollectCvProcessingFloor({
        candidateStartedAt: candidateProcessingStarted,
        targetMs: candidateProcessingFloorTargetMs,
        sleepFn: (ms) => runControl.sleep(ms)
      });
      collectCvProcessingFloorState.count += 1;
      collectCvProcessingFloorState.total_delay_requested_ms += processingFloor.delay_requested_ms;
      collectCvProcessingFloorState.total_delay_elapsed_ms += processingFloor.delay_elapsed_ms;
      collectCvProcessingFloorState.last = {
        candidate_id: screeningCandidate.id || null,
        candidate_key: candidateKey,
        ...processingFloor
      };
      timings.collect_cv_processing_target_ms = processingFloor.target_ms;
      timings.collect_cv_processing_elapsed_before_floor_ms = processingFloor.elapsed_before_ms;
      timings.collect_cv_processing_floor_delay_requested_ms = processingFloor.delay_requested_ms;
      timings.collect_cv_processing_floor_delay_ms = processingFloor.delay_elapsed_ms;
      timings.collect_cv_processing_elapsed_after_floor_ms = processingFloor.elapsed_after_ms;
      runControl.updateProgress({
        collect_cv_processing_floor_count: collectCvProcessingFloorState.count,
        collect_cv_processing_floor_delay_requested_ms: collectCvProcessingFloorState.total_delay_requested_ms,
        collect_cv_processing_floor_delay_ms: collectCvProcessingFloorState.total_delay_elapsed_ms,
        collect_cv_processing_floor_last: collectCvProcessingFloorState.last,
        collect_cv_processing_floor_current: null
      });
      runControl.checkpoint({
        collect_cv_processing_floor_current: null,
        collect_cv_processing_floor_last: collectCvProcessingFloorState.last,
        collect_cv_processing_floor: collectCvProcessingFloorSnapshot()
      });
    }
    timings.total_ms = Date.now() - candidateStarted;
    if (index < detailCountLimit && preActionState) {
      requireExactChatCandidateSelection({ ready: selectionReadyState }, cardCandidate);
    }
    const compactResult = {
      index,
      candidate_key: candidateKey,
      card_node_id: effectiveCardNodeId,
      candidate: compactCandidate(screeningCandidate),
      selection_ready_state: compactChatCandidateSelectionReadyState(selectionReadyState),
      detail: compactDetail(detailResult),
      llm_screening: detailResult ? null : compactLlmResult(cardOnlyLlmResult),
      screening: compactScreening(screening),
      post_action: postAction,
      pre_action_state: preActionState,
      collect_cv_processing_floor: processingFloor,
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
      context_recoveries: contextRecoveryAttempts,
      list_end_reason: listEndReason || null,
      viewport_checks: viewportGuard.getStats().checks,
      viewport_recoveries: viewportGuard.getStats().recoveries,
      human_behavior_enabled: effectiveHumanBehavior.enabled,
      human_behavior_profile: effectiveHumanBehavior.profile,
      human_rest_level: effectiveHumanBehavior.restLevel,
      human_rest_enabled: effectiveHumanRestEnabled,
      human_rest_per_candidate_enabled: collectCvPerCandidateRestEnabled,
      human_rest_per_candidate_min_ms: null,
      human_rest_per_candidate_max_ms: null,
      collect_cv_processing_floor_enabled: collectCvProcessingFloorEnabled,
      collect_cv_processing_floor_min_ms: collectCvProcessingFloorState.min_ms,
      collect_cv_processing_floor_max_ms: collectCvProcessingFloorState.max_ms,
      collect_cv_processing_floor_count: collectCvProcessingFloorState.count,
      collect_cv_processing_floor_delay_requested_ms: collectCvProcessingFloorState.total_delay_requested_ms,
      collect_cv_processing_floor_delay_ms: collectCvProcessingFloorState.total_delay_elapsed_ms,
      collect_cv_processing_floor_last: collectCvProcessingFloorState.last,
      collect_cv_processing_floor_current: null,
      human_rest_count: humanRestController.getState().rest_count,
      human_rest_ms: humanRestController.getState().total_rest_ms,
      last_human_event: lastHumanEvent,
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

    if (effectiveHumanRestEnabled) {
      const restStarted = Date.now();
      const restResult = await humanRestController.takeBreakIfNeeded({
        sleepFn: (ms) => runControl.sleep(ms)
      });
      const restElapsed = Date.now() - restStarted;
      if (restResult.rested) {
        recordHumanEvent({
          kind: "rest",
          pause_ms: restResult.pause_ms || restElapsed,
          events: restResult.events || []
        });
        compactResult.human_rest = restResult;
        addTiming(compactResult.timings, "human_rest_ms", restElapsed);
        compactResult.timings.total_ms = Date.now() - candidateStarted;
        runControl.updateProgress({
          human_rest_enabled: effectiveHumanRestEnabled,
          human_rest_level: effectiveHumanBehavior.restLevel,
          human_rest_per_candidate_enabled: collectCvPerCandidateRestEnabled,
          human_rest_count: humanRestController.getState().rest_count,
          human_rest_ms: humanRestController.getState().total_rest_ms,
          human_rest_last: restResult,
          context_recoveries: contextRecoveryAttempts,
          last_human_event: lastHumanEvent
        });
      }
    }

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
    human_behavior: effectiveHumanBehavior,
    human_rest: humanRestController.getState(),
    collect_cv_processing_floor: collectCvProcessingFloorSnapshot(),
    last_human_event: lastHumanEvent,
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
    context_recoveries: contextRecoveryAttempts,
    results
  };
}

export function createChatRunService({
  lifecycle,
  idPrefix = "chat",
  workflow = runChatWorkflow,
  onSnapshot = null,
  actionJournal = null
} = {}) {
  const manager = lifecycle || createRunLifecycleManager({ idPrefix, onSnapshot });
  const configuredActionJournal = actionJournal || null;

  function startChatRun({
    runId = "",
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
    humanRestEnabled = false,
    humanBehavior = null,
    actionJournalScope = "boss-chat:default",
    name = "chat-domain-run"
  } = {}) {
    if (!client) throw new Error("startChatRun requires a guarded CDP client");
    const normalizedDetailSource = normalizeDetailSource(detailSource);
    const normalizedScreeningMode = normalizeText(criteria) ? normalizeScreeningMode(screeningMode) : "collect_cv";
    const collectCvOnly = normalizedScreeningMode === "collect_cv" || !normalizeText(criteria);
    const processedLimit = Math.max(1, Number(maxCandidates) || 1);
    const normalizedDetailLimit = detailLimit == null ? processedLimit : Math.max(0, Number(detailLimit) || 0);
    const effectiveHumanBehavior = normalizeHumanBehaviorOptions(humanBehavior, {
      legacyEnabled: humanRestEnabled === true || llmConfig?.humanRestEnabled === true
    });
    const collectCvProcessingFloorEnabled = collectCvOnly;
    const collectCvPerCandidateRestEnabled = false;
    const effectiveHumanRestEnabled = effectiveHumanBehavior.restEnabled;
    return manager.startRun({
      runId,
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
        action_journal_enabled: Boolean(requestResumeForPassed),
        dry_run_request_cv: Boolean(dryRunRequestCv),
        greeting_text: greetingText,
        cv_acquisition_mode: cvAcquisitionMode,
        call_llm_on_image: Boolean(callLlmOnImage),
        screening_mode: normalizedScreeningMode,
        cv_collection_mode: normalizedScreeningMode === "collect_cv",
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
        image_output_dir: imageOutputDir || "",
        human_behavior_enabled: effectiveHumanBehavior.enabled,
        human_behavior_profile: effectiveHumanBehavior.profile,
        human_behavior: effectiveHumanBehavior,
        human_rest_level: effectiveHumanBehavior.restLevel,
        human_rest_enabled: effectiveHumanRestEnabled,
        human_rest_per_candidate_enabled: collectCvPerCandidateRestEnabled,
        human_rest_per_candidate_min_ms: null,
        human_rest_per_candidate_max_ms: null,
        collect_cv_processing_floor_enabled: collectCvProcessingFloorEnabled,
        collect_cv_processing_floor_min_ms: collectCvProcessingFloorEnabled ? CHAT_COLLECT_CV_PROCESSING_FLOOR_MIN_MS : null,
        collect_cv_processing_floor_max_ms: collectCvProcessingFloorEnabled ? CHAT_COLLECT_CV_PROCESSING_FLOOR_MAX_MS : null
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
        request_skipped: 0,
        context_recoveries: 0,
        human_behavior_enabled: effectiveHumanBehavior.enabled,
        human_behavior_profile: effectiveHumanBehavior.profile,
        human_rest_level: effectiveHumanBehavior.restLevel,
        human_rest_enabled: effectiveHumanRestEnabled,
        human_rest_per_candidate_enabled: collectCvPerCandidateRestEnabled,
        human_rest_per_candidate_min_ms: null,
        human_rest_per_candidate_max_ms: null,
        collect_cv_processing_floor_enabled: collectCvProcessingFloorEnabled,
        collect_cv_processing_floor_min_ms: collectCvProcessingFloorEnabled ? CHAT_COLLECT_CV_PROCESSING_FLOOR_MIN_MS : null,
        collect_cv_processing_floor_max_ms: collectCvProcessingFloorEnabled ? CHAT_COLLECT_CV_PROCESSING_FLOOR_MAX_MS : null,
        collect_cv_processing_floor_count: 0,
        collect_cv_processing_floor_delay_requested_ms: 0,
        collect_cv_processing_floor_delay_ms: 0,
        collect_cv_processing_floor_current: null,
        human_rest_count: 0,
        human_rest_ms: 0,
        last_human_event: null
      },
      checkpoint: {},
      task: async (runControl) => {
        try {
          return await workflow({
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
            imageOutputDir,
            humanRestEnabled: effectiveHumanRestEnabled,
            humanBehavior: effectiveHumanBehavior,
            actionJournal: configuredActionJournal || createChatActionJournal(),
            actionJournalScope
          }, runControl);
        } catch (error) {
          if (error instanceof RunCanceledError) throw error;
          const finalFailureArtifact = await captureChatFinalFailureArtifact(client, {
            runControl,
            imageOutputDir,
            error
          });
          if (finalFailureArtifact) {
            runControl.checkpoint({
              final_failure_artifact: finalFailureArtifact
            });
          }
          throw error;
        }
      }
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
