import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRunLifecycleManager } from "../../core/run/index.js";
import { createCandidateResultJournal } from "../../core/run/candidate-result-journal.js";
import {
  addTiming,
  imageEvidenceFilePath,
  measureTiming
} from "../../core/run/timing.js";
import { captureScrolledNodeScreenshots } from "../../core/capture/index.js";
import { waitForCvCaptureTarget } from "../../core/cv-capture-target/index.js";
import {
  configureHumanInteraction,
  createBossLoginRequiredError,
  createHumanRestController,
  detectBossLoginState,
  getMainFrameUrl,
  humanDelay,
  normalizeHumanBehaviorOptions,
  sleep
} from "../../core/browser/index.js";
import {
  isBossSecurityVerificationUrl,
  makeBossSecurityVerificationRequiredError
} from "../chat/page-guard.js";
import { GREET_CREDITS_EXHAUSTED_CODE } from "../../core/greet-quota/index.js";
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
  isFailedClosedImageAcquisition,
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
import { createChatActionJournal } from "../chat/action-journal.js";
import {
  callScreeningLlm,
  compactScreeningLlmResult,
  createFatalLlmRunError,
  createFailedLlmScreeningResult,
  isFatalLlmProviderError,
  llmResultToScreening,
  screenCandidate
} from "../../core/screening/index.js";
import {
  closeRecommendBlockingPanels,
  closeRecommendAvatarPreview,
  closeRecommendDetail,
  compactRecommendDetailCandidateBinding,
  createRecommendDetailCandidateBindingError,
  createRecommendDetailNetworkRecorder,
  extractRecommendDetailCandidate,
  isRecommendDetailCandidateBindingError,
  isRecommendDetailOpenMissError,
  isRecommendPreClickStaleNoActionError,
  isStaleRecommendNodeError,
  openRecommendCardDetailWithFreshRetry,
  verifyExactCardClickToNewResumeRootCausality,
  verifyRecommendDetailCandidateBinding,
  waitForRecommendDetail,
  waitForRecommendDetailNetworkEvents
} from "./detail.js";
import {
  readRecommendCardCandidate,
  waitForRecommendCardNodeIds
} from "./cards.js";
import { selectAndConfirmFirstSafeFilter } from "./filters.js";
import { ensureRecommendCurrentCityOnly } from "./location.js";
import {
  applyRecommendFilterEnvelopeStages,
  buildRecommendFilterSelectionOptions,
  inspectRecommendFilteredEmptyState,
  isVerifiedRecommendFilterApplication,
  isVerifiedRecommendRefreshExhaustion,
  refreshRecommendListAtEnd,
  selectRecommendJobWithRootRefresh
} from "./refresh.js";
import {
  normalizeRecommendPageScope,
  selectRecommendPageScope
} from "./scopes.js";
import { inspectRecentColleagueContact } from "./colleague-contact.js";
import {
  RECOMMEND_BOTTOM_MARKER_SELECTORS,
  RECOMMEND_CARD_SELECTOR,
  RECOMMEND_END_REFRESH_SELECTOR,
  RECOMMEND_LIST_CONTAINER_SELECTORS,
  RECOMMEND_TARGET_URL
} from "./constants.js";
import {
  clickRecommendActionControl,
  normalizeRecommendPostAction,
  resolveRecommendPostAction,
  verifyRecommendActionControlIdentity,
  waitForRecommendDetailActionControls
} from "./actions.js";
import { getRecommendRoots, waitForRecommendRoots } from "./roots.js";

const RECOMMEND_GREETING_ACTION_FINGERPRINT = "boss-recommend-greet-action-v1";
const RECOMMEND_GREETING_ASSUMED_SENT_STATE = "greeting_assumed_sent";
const RECOMMEND_GREETING_ASSUMPTION_POLICY = "at_most_once_assume_sent_continue_v1";
const RECOMMEND_MAX_REFRESH_ROUNDS = 2;
const RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS = 2;
const RECOMMEND_CONTEXT_RECOVERY_BACKOFF_MS = Object.freeze([0, 300]);
const RECOMMEND_RESULT_MEMORY_TAIL_LIMIT = 50;
const RECOMMEND_REFRESH_DIAGNOSTIC_TAIL_LIMIT = 24;
const RECOMMEND_STALE_DIAGNOSTIC_TAIL_LIMIT = 12;

function isRecommendScreeningIdentityMismatchError(error) {
  return error?.code === "RECOMMEND_SCREENING_CANDIDATE_IDENTITY_MISMATCH";
}

function isCandidateLocalRecommendPreOutboundActionError(error) {
  if (!error || error?.recommend_input_dispatched === true) return false;
  if (error?.recommend_pre_input_aborted === true) return true;
  const code = String(error?.code || "").trim();
  return code === "RECOMMEND_ACTION_DETAIL_ROOT_MISMATCH"
    || code.startsWith("RECOMMEND_ACTION_CONTROL_");
}

function isRecommendContextRecoveryNonRetryable(error) {
  const code = String(error?.code || "").trim();
  const text = `${code} ${error?.message || ""}`;
  return /(?:LOGIN_REQUIRED|SECURITY|HUMAN[_\s-]*VERIFICATION|ACCOUNT[_\s-]*RISK|ACTION_SCOPE_DRIFT|ACTION_SCOPE_UNVERIFIED)/i.test(text);
}

function defaultRecommendActionJournalDir() {
  const configuredHome = String(process.env.BOSS_RECOMMEND_HOME || "").trim();
  const root = configuredHome
    ? path.resolve(configuredHome)
    : path.join(os.homedir(), ".boss-recommend-mcp");
  return path.join(root, "recommend-action-journal");
}

export function createRecommendGreetingActionJournal(options = {}) {
  return createChatActionJournal({
    baseDir: options.baseDir || defaultRecommendActionJournalDir(),
    now: options.now
  });
}

const RECOMMEND_DEBUG_BOUNDARY_MODES = Object.freeze({
  list_end: "debug_force_list_end_after_processed",
  context_recovery: "debug_force_context_recovery_after_processed",
  cdp_reconnect: "debug_force_cdp_reconnect_after_processed"
});

function hasOwn(source, key) {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
}

function readDebugBoundaryValue(source, snakeKey, camelKey) {
  if (hasOwn(source, snakeKey)) return source[snakeKey];
  if (hasOwn(source, camelKey)) return source[camelKey];
  return null;
}

function normalizeDebugBoundaryThreshold(raw, field) {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    const error = new Error(`${field} must be a positive integer`);
    error.code = "INVALID_RECOMMEND_DEBUG_BOUNDARY";
    throw error;
  }
  return parsed;
}

export function normalizeRecommendDebugBoundaryOptions(source = {}) {
  const debugTestMode = source.debugTestMode === true || source.debug_test_mode === true;
  const thresholds = {
    list_end: normalizeDebugBoundaryThreshold(
      readDebugBoundaryValue(
        source,
        RECOMMEND_DEBUG_BOUNDARY_MODES.list_end,
        "debugForceListEndAfterProcessed"
      ),
      RECOMMEND_DEBUG_BOUNDARY_MODES.list_end
    ),
    context_recovery: normalizeDebugBoundaryThreshold(
      readDebugBoundaryValue(
        source,
        RECOMMEND_DEBUG_BOUNDARY_MODES.context_recovery,
        "debugForceContextRecoveryAfterProcessed"
      ),
      RECOMMEND_DEBUG_BOUNDARY_MODES.context_recovery
    ),
    cdp_reconnect: normalizeDebugBoundaryThreshold(
      readDebugBoundaryValue(
        source,
        RECOMMEND_DEBUG_BOUNDARY_MODES.cdp_reconnect,
        "debugForceCdpReconnectAfterProcessed"
      ),
      RECOMMEND_DEBUG_BOUNDARY_MODES.cdp_reconnect
    )
  };
  const configured = Object.entries(thresholds).filter(([, threshold]) => threshold !== null);
  if (configured.length > 1) {
    const error = new Error(
      `${configured.map(([mode]) => RECOMMEND_DEBUG_BOUNDARY_MODES[mode]).join(", ")} are mutually exclusive`
    );
    error.code = "RECOMMEND_DEBUG_BOUNDARIES_MUTUALLY_EXCLUSIVE";
    throw error;
  }
  if (configured.length && !debugTestMode) {
    const error = new Error(
      `${RECOMMEND_DEBUG_BOUNDARY_MODES[configured[0][0]]} requires debug_test_mode=true`
    );
    error.code = "DEBUG_TEST_MODE_REQUIRED";
    throw error;
  }
  const [configuredEntry = null] = configured;
  return {
    debugTestMode,
    mode: configuredEntry?.[0] || null,
    field: configuredEntry ? RECOMMEND_DEBUG_BOUNDARY_MODES[configuredEntry[0]] : null,
    threshold: configuredEntry?.[1] ?? null,
    debugForceListEndAfterProcessed: thresholds.list_end,
    debugForceContextRecoveryAfterProcessed: thresholds.context_recovery,
    debugForceCdpReconnectAfterProcessed: thresholds.cdp_reconnect
  };
}

export function createRecommendDebugBoundaryController(source = {}) {
  const config = normalizeRecommendDebugBoundaryOptions(source);
  let triggered = false;
  let triggerCount = 0;
  return {
    config,
    take(processedCount) {
      const processed = Math.max(0, Number(processedCount) || 0);
      if (triggered || !config.mode || processed < config.threshold) return null;
      triggered = true;
      triggerCount += 1;
      return {
        mode: config.mode,
        field: config.field,
        threshold: config.threshold,
        processed,
        trigger_count: triggerCount
      };
    },
    getState() {
      return {
        ...config,
        triggered,
        trigger_count: triggerCount
      };
    }
  };
}

function readErrorChainField(error, key) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if ((typeof current === "object" || typeof current === "function") && seen.has(current)) break;
    if (typeof current === "object" || typeof current === "function") seen.add(current);
    if (current?.[key] !== undefined && current?.[key] !== null) return current[key];
    current = current?.cause || null;
  }
  return undefined;
}

function compactCdpFailureDiagnostic(error, {
  fallbackCode = "RECOMMEND_DOM_STALE",
  fallbackPhase = ""
} = {}) {
  const message = String(readErrorChainField(error, "message") || error || "DOM node became stale");
  const diagnostic = {
    name: String(readErrorChainField(error, "name") || "Error").slice(0, 100),
    code: String(readErrorChainField(error, "code") || fallbackCode).slice(0, 160),
    message: message.slice(0, 500),
    phase: String(readErrorChainField(error, "phase") || fallbackPhase || "").slice(0, 200) || null,
    cdp_method: String(readErrorChainField(error, "cdp_method") || "").slice(0, 200) || null,
    cdp_at: String(readErrorChainField(error, "cdp_at") || "").slice(0, 100) || null,
    cdp_search_id: String(readErrorChainField(error, "cdp_search_id") || "").slice(0, 200) || null,
    cdp_replay_policy: String(readErrorChainField(error, "cdp_replay_policy") || "").slice(0, 100) || null,
    cdp_reconnect_error: String(readErrorChainField(error, "cdp_reconnect_error") || "").slice(0, 300) || null
  };
  for (const key of [
    "cdp_node_id",
    "cdp_backend_node_id",
    "cdp_connection_epoch",
    "cdp_reconnected_epoch"
  ]) {
    const value = Number(readErrorChainField(error, key));
    diagnostic[key] = Number.isInteger(value) && value >= 0 ? value : null;
  }
  for (const key of [
    "cdp_reconnected",
    "cdp_replayed_after_reconnect",
    "cdp_replay_suppressed",
    "cdp_outcome_unknown"
  ]) {
    const value = readErrorChainField(error, key);
    diagnostic[key] = typeof value === "boolean" ? value : null;
  }
  const paramKeys = readErrorChainField(error, "cdp_param_keys");
  diagnostic.cdp_param_keys = Array.isArray(paramKeys)
    ? paramKeys
      .map((key) => String(key || "").trim())
      .filter((key) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key))
      .slice(0, 20)
    : [];
  return diagnostic;
}

export function compactRecommendDomRootIdentity(rootState = null, connectionEpoch = null) {
  const epoch = Number(connectionEpoch);
  const topNodeId = Number(rootState?.rootNodes?.top || rootState?.topRoot?.nodeId || 0);
  const frameOwnerNodeId = Number(rootState?.rootNodes?.frameOwner || rootState?.iframe?.nodeId || 0);
  const frameDocumentNodeId = Number(
    rootState?.rootNodes?.frame || rootState?.iframe?.documentNodeId || 0
  );
  return {
    connection_epoch: Number.isInteger(epoch) && epoch > 0 ? epoch : null,
    top_document_node_id: Number.isInteger(topNodeId) && topNodeId > 0 ? topNodeId : null,
    iframe_owner_node_id: Number.isInteger(frameOwnerNodeId) && frameOwnerNodeId > 0
      ? frameOwnerNodeId
      : null,
    iframe_document_node_id: Number.isInteger(frameDocumentNodeId) && frameDocumentNodeId > 0
      ? frameDocumentNodeId
      : null,
    iframe_selector: String(rootState?.iframe?.selector || "").slice(0, 300) || null
  };
}

function latestInfiniteListReadError(listState = null) {
  const ledger = Array.isArray(listState?.ledger) ? listState.ledger : [];
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const item = ledger[index];
    if (item?.event !== "candidate_read_error") continue;
    return {
      at: item.at || null,
      node_id: Number.isInteger(item.node_id) ? item.node_id : null,
      visible_index: Number.isInteger(item.visible_index) ? item.visible_index : null,
      error: String(item.error || "").slice(0, 500) || null
    };
  }
  return null;
}

export function createRecommendDomStaleForensicEvent(error, {
  eventId = "",
  phase = "",
  operation = "",
  detailStep = "",
  candidateIndex = null,
  candidateKey = "",
  cardNodeId = null,
  rootState = null,
  connectionEpoch = null,
  listState = null,
  counters = null,
  timeline = []
} = {}) {
  const at = new Date().toISOString();
  const listReadError = latestInfiniteListReadError(listState);
  return {
    schema_version: 1,
    event_id: String(eventId || `recommend_dom_stale_${Date.now()}`).slice(0, 160),
    event_type: "dom_stale",
    at,
    phase: String(phase || "").slice(0, 200) || null,
    operation: String(operation || "").slice(0, 200) || null,
    detail_step: String(detailStep || "").slice(0, 200) || null,
    candidate: {
      index: Number.isInteger(candidateIndex) && candidateIndex >= 0 ? candidateIndex : null,
      key: String(candidateKey || "").slice(0, 300) || null,
      card_node_id: Number.isInteger(cardNodeId) && cardNodeId > 0 ? cardNodeId : null,
      visible_index: listReadError?.visible_index ?? null,
      failing_list_node_id: listReadError?.node_id ?? null
    },
    error: compactCdpFailureDiagnostic(error, {
      fallbackCode: "RECOMMEND_DOM_STALE",
      fallbackPhase: phase
    }),
    pre_recovery_roots: compactRecommendDomRootIdentity(rootState, connectionEpoch),
    candidate_list: compactInfiniteListState(listState || {}),
    counters: counters && typeof counters === "object" ? counters : null,
    lifecycle_timeline: Array.isArray(timeline) ? timeline.slice(-20) : []
  };
}

function compactListReadStaleDiagnostic(error, {
  attempt = 0,
  exhausted = false
} = {}) {
  const cdp = compactCdpFailureDiagnostic(error, {
    fallbackCode: "RECOMMEND_LIST_READ_STALE_NODE",
    fallbackPhase: "recommend:list-read"
  });
  return {
    ...cdp,
    code: error?.code || cdp.code || "RECOMMEND_LIST_READ_STALE_NODE",
    message: String(error?.message || cdp.message || error || "Stale recommend list node").slice(0, 500),
    phase: "recommend:list-read",
    attempt,
    exhausted: Boolean(exhausted),
    at: new Date().toISOString()
  };
}

function annotateListReadStaleFailure(error, diagnostics, {
  exhausted = false,
  recoveryFailed = false
} = {}) {
  if (!error || typeof error !== "object") return error;
  error.phase = error.phase || "recommend:list-read";
  error.list_read_stale_recovery_attempts = diagnostics;
  if (exhausted) error.list_read_stale_recovery_exhausted = true;
  if (recoveryFailed) error.list_read_stale_recovery_failed = true;
  return error;
}

export async function acquireRecommendListReadWithStaleRecovery({
  acquire,
  recover,
  maxRetries = 2,
  onStale = null,
  onRecoveryApplied = null,
  onRecovered = null,
  onExhausted = null
} = {}) {
  if (typeof acquire !== "function") {
    throw new Error("acquireRecommendListReadWithStaleRecovery requires acquire");
  }
  if (typeof recover !== "function") {
    throw new Error("acquireRecommendListReadWithStaleRecovery requires recover");
  }
  const retryLimit = Math.max(0, Number.isInteger(maxRetries) ? maxRetries : 2);
  const diagnostics = [];
  let acquireAttempt = 0;
  let pendingRecoveryDiagnostic = null;
  while (true) {
    acquireAttempt += 1;
    try {
      const result = await acquire({
        acquireAttempt,
        recoveryCount: diagnostics.filter((item) => item.recovered === true).length
      });
      if (pendingRecoveryDiagnostic) {
        pendingRecoveryDiagnostic.recovered = true;
        pendingRecoveryDiagnostic.recovered_at = new Date().toISOString();
        if (typeof onRecovered === "function") {
          await onRecovered({
            diagnostic: pendingRecoveryDiagnostic,
            diagnostics: diagnostics.slice()
          });
        }
        pendingRecoveryDiagnostic = null;
      }
      return {
        result,
        acquire_attempts: acquireAttempt,
        stale_diagnostics: diagnostics
      };
    } catch (error) {
      if (!isStaleRecommendNodeError(error)) throw error;
      pendingRecoveryDiagnostic = null;
      const staleAttempt = diagnostics.length + 1;
      const exhausted = staleAttempt > retryLimit;
      const diagnostic = compactListReadStaleDiagnostic(error, {
        attempt: staleAttempt,
        exhausted
      });
      diagnostics.push(diagnostic);
      if (exhausted) {
        if (typeof onExhausted === "function") {
          await onExhausted({ error, diagnostic, diagnostics: diagnostics.slice() });
        }
        throw annotateListReadStaleFailure(error, diagnostics, { exhausted: true });
      }
      if (typeof onStale === "function") {
        await onStale({ error, diagnostic, diagnostics: diagnostics.slice() });
      }
      let recoveryResult = null;
      try {
        recoveryResult = await recover({ error, diagnostic, diagnostics: diagnostics.slice() });
      } catch (recoveryError) {
        if (recoveryError && typeof recoveryError === "object" && !recoveryError.cause) {
          recoveryError.cause = error;
        }
        throw annotateListReadStaleFailure(recoveryError, diagnostics, {
          recoveryFailed: true
        });
      }
      diagnostic.recovery_applied = true;
      diagnostic.recovery_mode = recoveryResult?.recovery_mode || "unknown";
      diagnostic.recovery_applied_at = new Date().toISOString();
      pendingRecoveryDiagnostic = diagnostic;
      if (typeof onRecoveryApplied === "function") {
        await onRecoveryApplied({
          error,
          diagnostic,
          recoveryResult,
          diagnostics: diagnostics.slice()
        });
      }
    }
  }
}

export async function recoverRecommendListReadStaleContext({
  staleAttempt = 1,
  listState,
  contextReapply
} = {}) {
  if (typeof contextReapply !== "function") {
    throw new Error("recoverRecommendListReadStaleContext requires contextReapply");
  }
  const processedKeys = new Set(listState?.processed_keys || []);
  try {
    const contextResult = await contextReapply({ rootReacquireError: null });
    return {
      recovery_mode: "context_reapply",
      escalated_from: Number(staleAttempt) <= 1
        ? "root_only_recovery_disallowed"
        : "repeated_stale",
      context_reapply: contextResult || null
    };
  } finally {
    for (const key of processedKeys) listState?.processed_keys?.add(key);
  }
}

function normalizeLabels(labels = []) {
  return labels.map((label) => String(label || "").trim()).filter(Boolean);
}

function isRecommendTechnicalListStall(reason = "") {
  return new Set([
    "max_scrolls_exhausted",
    "scroll_failed",
    "scroll_anchor_unavailable",
    "empty_visible_list",
    "stable_visible_signature"
  ]).has(String(reason || ""));
}

export function normalizeRecommendRefreshRoundLimit(
  value = RECOMMEND_MAX_REFRESH_ROUNDS
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return RECOMMEND_MAX_REFRESH_ROUNDS;
  return Math.min(
    RECOMMEND_MAX_REFRESH_ROUNDS,
    Math.max(0, Math.floor(parsed))
  );
}

export function isVerifiedRecommendSourceEndResult(result = null) {
  const reason = String(result?.reason || "").trim();
  if (reason === "filtered_list_exhausted") return true;
  if (reason === "bottom_marker") {
    return result?.end_reached === true && result?.bottom_marker?.found === true;
  }
  return result?.end_reached === true && reason === "debug_forced_list_end";
}

export function resolveRecommendTechnicalRecoveryBudget({
  attemptsWithoutProgress = 0,
  requestedAttempts = RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS
} = {}) {
  const used = Math.max(0, Math.floor(Number(attemptsWithoutProgress) || 0));
  const requested = Math.min(
    RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS,
    Math.max(1, Math.floor(Number(requestedAttempts) || RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS))
  );
  const remaining = Math.max(0, RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS - used);
  return {
    used,
    remaining,
    attempt_limit: Math.min(requested, remaining),
    exhausted: remaining === 0,
    max_attempts: RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS
  };
}

export function resolveRecommendSourceRefreshDecision({
  targetReached = false,
  refreshOnEnd = true,
  sourceEndVerified = false,
  refreshRounds = 0,
  maxRefreshRounds = RECOMMEND_MAX_REFRESH_ROUNDS
} = {}) {
  const effectiveMaxRefreshRounds = normalizeRecommendRefreshRoundLimit(maxRefreshRounds);
  const completedRefreshRounds = Math.max(0, Math.floor(Number(refreshRounds) || 0));
  if (targetReached) {
    return {
      action: "complete_target",
      refresh_rounds: completedRefreshRounds,
      max_refresh_rounds: effectiveMaxRefreshRounds
    };
  }
  if (!sourceEndVerified) {
    return {
      action: "fail_unverified_underfill",
      refresh_rounds: completedRefreshRounds,
      max_refresh_rounds: effectiveMaxRefreshRounds
    };
  }
  if (refreshOnEnd && completedRefreshRounds < effectiveMaxRefreshRounds) {
    return {
      action: "refresh",
      refresh_rounds: completedRefreshRounds,
      next_refresh_round: completedRefreshRounds + 1,
      max_refresh_rounds: effectiveMaxRefreshRounds
    };
  }
  return {
    action: "complete_exhausted",
    refresh_rounds: completedRefreshRounds,
    max_refresh_rounds: effectiveMaxRefreshRounds
  };
}

function normalizeFilter(filter = {}) {
  const filterGroups = Array.isArray(filter.filterGroups)
    ? filter.filterGroups
    : Array.isArray(filter.groups)
      ? filter.groups
      : [];
  return {
    enabled: filter.enabled !== false,
    currentCityOnly: filter.currentCityOnly === true || filter.current_city_only === true,
    group: String(filter.group || ""),
    labels: normalizeLabels(filter.labels || filter.filterLabels || []),
    selectAllLabels: Boolean(filter.selectAllLabels),
    allowUnlimited: filter.allowUnlimited === true,
    verifySticky: true,
    filterGroups: filterGroups.map((group) => ({
      group: String(group?.group || ""),
      labels: normalizeLabels(group?.labels || group?.filterLabels || []),
      selectAllLabels: group?.selectAllLabels !== false,
      allowUnlimited: group?.allowUnlimited === true,
      verifySticky: true
    })).filter((group) => group.group || group.labels.length)
  };
}

export function compactFilterResult(filterResult) {
  if (!filterResult) return null;
  return {
    opened_panel: Boolean(filterResult.opened_panel),
    requested_groups: (filterResult.requested_groups || []).map((group) => ({
      group: group.group,
      labels: group.labels || [],
      select_all_labels: group.select_all_labels !== false,
      allow_unlimited: Boolean(group.allow_unlimited),
      verify_sticky: Boolean(group.verify_sticky)
    })),
    effective_groups: (filterResult.sticky_verification?.groups || []).map((group) => ({
      group: group.group,
      requested_labels: group.requested_labels || [],
      active_labels: group.active_labels || [],
      verified: Boolean(group.verified),
      unavailable: Boolean(group.unavailable),
      reason: group.reason || null
    })),
    selected_option: filterResult.selected_option
      ? {
          group: filterResult.selected_option.group,
          label: filterResult.selected_option.label,
          was_active: Boolean(filterResult.selected_option.was_active),
          clicked: filterResult.selected_option.clicked !== false
        }
      : null,
    selected_options: (filterResult.selected_options || []).map((option) => ({
      group: option.group,
      label: option.label,
      was_active: Boolean(option.was_active),
      clicked: option.clicked !== false
    })),
    unavailable: Boolean(filterResult.unavailable),
    unavailable_groups: filterResult.unavailable_groups || [],
    confirmed: Boolean(filterResult.confirmed),
    sticky_verification: filterResult.sticky_verification || null,
    attempts: {
      initial_close: filterResult.initial_close_attempts || [],
      open: (filterResult.open_attempts || []).map((attempt) => ({
        selector: attempt.selector || null,
        node_id: attempt.node_id || null,
        click_target: attempt.click_target || null
      })),
      confirmation: (filterResult.confirm_attempts || []).map((attempt) => ({
        node_id: attempt.node_id || null,
        label: attempt.label || null,
        clicked: Boolean(attempt.clicked),
        errors: (attempt.errors || []).map((error) => ({
          node_id: error.node_id || null,
          message: error.message || String(error)
        }))
      }))
    },
    before_counts: filterResult.before_counts,
    after_confirm_counts: filterResult.after_confirm_counts
  };
}

function compactCurrentCityOnlyResult(result) {
  if (!result) return null;
  return {
    requested: Boolean(result.requested),
    effective: typeof result.effective === "boolean" ? result.effective : null,
    available: result.available !== false,
    unavailable: Boolean(result.unavailable),
    reason: result.reason || null,
    clicked: Boolean(result.clicked),
    current_city_label: result.current_city_label || null,
    before: result.before || null,
    after_toggle: result.after_toggle || null,
    confirmation: result.confirmation || null,
    sticky_verification: result.sticky_verification
      ? {
          verified: Boolean(result.sticky_verification.verified),
          expected: Boolean(result.sticky_verification.expected),
          actual: typeof result.sticky_verification.actual === "boolean"
            ? result.sticky_verification.actual
            : null,
          state_source: result.sticky_verification.state_source || null,
          close_confirmation: result.sticky_verification.close_confirmation || null
        }
      : null,
    attempts: Array.isArray(result.attempts) ? result.attempts : [],
    evidence: result.evidence || null
  };
}

function compactJobSelection(jobSelection) {
  if (!jobSelection) return null;
  return {
    requested: jobSelection.requested || "",
    selected: Boolean(jobSelection.selected),
    already_current: Boolean(jobSelection.already_current),
    reason: jobSelection.reason || null,
    selected_option: jobSelection.selected_option || null,
    menu_close: jobSelection.menu_close
      ? {
          ok: Boolean(jobSelection.menu_close.ok),
          closed: Boolean(jobSelection.menu_close.closed),
          reason: jobSelection.menu_close.reason || ""
        }
      : null,
    sticky_verification: jobSelection.sticky_verification
      ? {
          verified: Boolean(jobSelection.sticky_verification.verified),
          current_label: jobSelection.sticky_verification.current_label_without_salary
            || jobSelection.sticky_verification.current_label
            || "",
          visible_option_count: jobSelection.sticky_verification.visible_option_count || 0,
          menu_close: jobSelection.sticky_verification.menu_close
            ? {
                ok: Boolean(jobSelection.sticky_verification.menu_close.ok),
                closed: Boolean(jobSelection.sticky_verification.menu_close.closed),
                reason: jobSelection.sticky_verification.menu_close.reason || ""
              }
            : null
        }
      : null,
    options: (jobSelection.options || []).map((option) => ({
      label: option.label,
      label_without_salary: option.label_without_salary,
      current: Boolean(option.current),
      visible: Boolean(option.visible),
      class_name: option.class_name
    }))
  };
}

function compactPageScopeSelection(pageScopeSelection) {
  if (!pageScopeSelection) return null;
  return {
    requested_scope: pageScopeSelection.requested_scope || null,
    effective_scope: pageScopeSelection.effective_scope || null,
    fallback_scope: pageScopeSelection.fallback_scope || null,
    fallback_applied: Boolean(pageScopeSelection.fallback_applied),
    selected: Boolean(pageScopeSelection.selected),
    already_current: Boolean(pageScopeSelection.already_current),
    reason: pageScopeSelection.reason || null,
    selected_tab: pageScopeSelection.selected_tab || null,
    available_scopes: pageScopeSelection.available_scopes || [],
    card_count: pageScopeSelection.after?.card_count || null
  };
}

function compactScreening(screening) {
  return {
    status: screening.status,
    passed: screening.passed,
    score: screening.score,
    reasons: screening.reasons,
    candidate: {
      domain: screening.candidate?.domain || "recommend",
      source: screening.candidate?.source || "",
      id: screening.candidate?.id || null,
      identity: screening.candidate?.identity || {}
    }
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

function normalizeRecommendScreeningIdentityValue(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().normalize("NFKC");
}

export function assertRecommendScreeningCandidateMatchesCard({
  cardCandidate = null,
  screeningCandidate = null,
  stage = "before_screening"
} = {}) {
  const expectedCandidateId = normalizeRecommendScreeningIdentityValue(cardCandidate?.id);
  const actualCandidateId = normalizeRecommendScreeningIdentityValue(screeningCandidate?.id);
  const expectedName = normalizeRecommendScreeningIdentityValue(cardCandidate?.identity?.name);
  const actualName = normalizeRecommendScreeningIdentityValue(screeningCandidate?.identity?.name);
  const diagnostic = {
    schema_version: 1,
    verified: Boolean(
      expectedCandidateId
      && actualCandidateId === expectedCandidateId
      && expectedName
      && actualName === expectedName
    ),
    stage,
    expected_candidate_id: expectedCandidateId || null,
    actual_candidate_id: actualCandidateId || null,
    exact_candidate_id: Boolean(expectedCandidateId && actualCandidateId === expectedCandidateId),
    expected_name: expectedName || null,
    actual_name: actualName || null,
    exact_name: Boolean(expectedName && actualName === expectedName)
  };
  if (diagnostic.verified) return diagnostic;

  const error = new Error(
    `RECOMMEND_SCREENING_CANDIDATE_IDENTITY_MISMATCH: stage=${stage}; expected=${expectedCandidateId || "missing"}/${expectedName || "missing"}; actual=${actualCandidateId || "missing"}/${actualName || "missing"}`
  );
  error.code = "RECOMMEND_SCREENING_CANDIDATE_IDENTITY_MISMATCH";
  error.phase = "recommend:screening-candidate-identity";
  error.screening_candidate_identity = diagnostic;
  throw error;
}

function compactDetail(detailResult) {
  if (!detailResult) return null;
  return {
    popup_text_length: detailResult.detail?.popup_text?.length || 0,
    resume_text_length: detailResult.detail?.resume_text?.length || 0,
    network_body_count: detailResult.network_bodies?.filter((item) => item.body).length || 0,
    parsed_network_profile_count: detailResult.parsed_network_profiles?.filter((item) => item.ok).length || 0,
    network_profile_binding: detailResult.network_profile_binding || null,
    screening_candidate_identity: detailResult.screening_candidate_identity || null,
    cv_acquisition: detailResult.cv_acquisition || null,
    candidate_binding: compactRecommendDetailCandidateBinding(detailResult.candidate_binding),
    colleague_contact: detailResult.colleague_contact || null,
    image_evidence: summarizeImageEvidence(detailResult.image_evidence),
    llm_screening: compactScreeningLlmResult(detailResult.llm_result),
    close_result: detailResult.close_result
  };
}

function normalizeScreeningMode(value) {
  const normalized = String(value || "llm").trim().toLowerCase();
  return ["deterministic", "local", "local_scorer"].includes(normalized)
    ? "deterministic"
    : "llm";
}

function createMissingLlmConfigResult() {
  return createFailedLlmScreeningResult(new Error("LLM screening config is required for production recommend runs"));
}

function compactActionDiscovery(discovery) {
  if (!discovery) return null;
  return {
    elapsed_ms: discovery.elapsed_ms,
    timed_out: Boolean(discovery.timed_out),
    detail_root_count: discovery.detail_root_count || 0,
    summary: discovery.summary || null
  };
}

export async function selectAndVerifyInitialRecommendJob(client, rootState, {
  jobLabel = "",
  settleMs = 6000,
  dropdownTimeoutMs = Math.max(8000, settleMs),
  totalTimeoutMs = Math.max(30000, dropdownTimeoutMs + settleMs + 4000),
  retryDelayMs = 1000,
  selectWithRootRefresh = selectRecommendJobWithRootRefresh
} = {}) {
  if (!jobLabel) {
    throw new Error("selectAndVerifyInitialRecommendJob requires a requested job label");
  }
  if (typeof selectWithRootRefresh !== "function") {
    throw new Error("selectAndVerifyInitialRecommendJob requires selectWithRootRefresh");
  }
  const result = await selectWithRootRefresh(client, rootState, {
    jobLabel,
    settleMs,
    dropdownTimeoutMs,
    totalTimeoutMs,
    retryDelayMs
  });
  const selection = result?.job_selection || null;
  const sticky = selection?.sticky_verification || null;
  if (
    selection?.selected !== true
    || sticky?.verified !== true
    || sticky?.menu_close?.ok === false
  ) {
    const error = new Error(
      `Requested recommend job was not independently sticky-verified: requested=${jobLabel}; current=${sticky?.current_label_without_salary || sticky?.current_label || "unknown"}`
    );
    error.code = "RECOMMEND_INITIAL_JOB_STICKY_VERIFICATION_FAILED";
    error.job_selection = compactJobSelection(selection);
    throw error;
  }
  return result;
}

function compactRecommendActionJournalRecord(record = null, filePath = null) {
  if (!record) return null;
  const history = Array.isArray(record.history) ? record.history : [];
  const last = history[history.length - 1] || null;
  const state = record.state || null;
  return {
    domain: "recommend",
    schema_version: record.schema_version || 1,
    action_key: record.action_key || null,
    candidate_id: record.candidate_id || null,
    state,
    revision: Number.isSafeInteger(Number(record.revision)) ? Number(record.revision) : history.length,
    unknown_origin: state === "outcome_unknown" ? last?.from_state || null : null,
    delivery_status: state === "greeting_confirmed"
      ? "confirmed"
      : state === RECOMMEND_GREETING_ASSUMED_SENT_STATE
        ? "assumed_sent"
        : state === "outcome_unknown" || state === "greeting_send_in_flight"
          ? "unknown"
          : null,
    protected_from_replay: [
      "greeting_send_in_flight",
      RECOMMEND_GREETING_ASSUMED_SENT_STATE,
      "greeting_confirmed",
      "outcome_unknown"
    ].includes(state),
    evidence: record.evidence || {},
    created_at: record.created_at || null,
    updated_at: record.updated_at || null,
    first_run_id: record.first_run_id || null,
    last_run_id: record.last_run_id || null,
    file_path: filePath || null
  };
}

function recommendGreetingUnknownOrigin(record = null) {
  const history = Array.isArray(record?.history) ? record.history : [];
  const last = history[history.length - 1];
  return record?.state === "outcome_unknown" ? last?.from_state || null : null;
}

function latestRecommendGreetingEvidence(record = null) {
  const history = Array.isArray(record?.history) ? record.history : [];
  return history[history.length - 1]?.evidence || {};
}

export function isVerifiedRecommendActionJournalScope(scope = "") {
  return /^boss-recommend-profile-v2:127\.0\.0\.1:profile-sha256:[0-9a-f]{64}$/u.test(
    String(scope || "").trim()
  );
}

function compactRecommendControlEvidence(control = null) {
  const rect = control?.rect || {};
  const center = control?.center || {};
  return {
    control_node_id: Number.isInteger(Number(control?.node_id)) ? Number(control.node_id) : null,
    control_backend_node_id: Number.isInteger(Number(control?.backend_node_id))
      ? Number(control.backend_node_id)
      : null,
    control_root: control?.root || null,
    control_label: String(control?.label || "").trim() || null,
    control_root_node_id: Number.isInteger(Number(control?.root_node_id))
      ? Number(control.root_node_id)
      : null,
    control_root_backend_node_id: Number.isInteger(Number(control?.root_backend_node_id))
      ? Number(control.root_backend_node_id)
      : null,
    control_center_x: Number.isFinite(Number(center.x)) ? Number(center.x) : null,
    control_center_y: Number.isFinite(Number(center.y)) ? Number(center.y) : null,
    control_rect_x: Number.isFinite(Number(rect.x)) ? Number(rect.x) : null,
    control_rect_y: Number.isFinite(Number(rect.y)) ? Number(rect.y) : null,
    control_rect_width: Number.isFinite(Number(rect.width)) ? Number(rect.width) : null,
    control_rect_height: Number.isFinite(Number(rect.height)) ? Number(rect.height) : null
  };
}

function compactRecommendPostActionError(error) {
  if (!error) return null;
  return {
    code: error.code || "RECOMMEND_GREETING_CLICK_FAILED",
    message: String(error.message || error).slice(0, 500),
    phase: error.phase || null,
    cdp_method: error.cdp_method || null,
    cdp_at: error.cdp_at || null,
    cdp_node_id: Number.isInteger(error.cdp_node_id) ? error.cdp_node_id : null,
    cdp_outcome_unknown: error.cdp_outcome_unknown === true,
    recommend_pre_input_aborted: error.recommend_pre_input_aborted === true,
    recommend_input_dispatched: error.recommend_input_dispatched === true,
    recommend_input_transport_contained: error.recommend_input_transport_contained === true,
    recommend_input_transport_abandon_failed: error.recommend_input_transport_abandon_failed === true,
    input_timeout_diagnostic: error.input_timeout_diagnostic || null,
    recommend_action_control_hit_test: error.recommend_action_control_hit_test || null
  };
}

export function checkpointRecommendPostActionStopResult(runControl, checkpoint = {}, {
  candidateResult = null,
  candidateId = "",
  actionState = null,
  resultIndex = null
} = {}) {
  try {
    return runControl.checkpointCritical(checkpoint);
  } catch (error) {
    const fallback = runControl.checkpoint({
      ...checkpoint,
      preserve_detail_on_terminal: checkpoint?.preserve_detail_on_terminal === true,
      action_result_critical_persisted: checkpoint?.action_result_critical_persisted === true,
      critical_checkpoint_degraded: true,
      terminal_preservation: {
        required: checkpoint?.action_result_critical_persisted !== true,
        reason: "post_action_candidate_result_critical_persistence_failed",
        candidate_id: String(candidateId || "").trim() || null,
        action_state: actionState || null,
        result_index: Number.isInteger(resultIndex) ? resultIndex : null,
        error: compactRecommendPostActionError(error)
      }
    });
    if (
      checkpoint?.action_result_critical_persisted === true
      && checkpoint?.preserve_detail_on_terminal !== true
    ) {
      return fallback;
    }
    error.code = error.code || "RECOMMEND_POST_ACTION_RESULT_PERSISTENCE_FAILED";
    error.phase = error.phase || "recommend:post-action-result-persistence";
    error.recommend_preserve_detail_on_terminal = true;
    error.recommend_candidate_result = candidateResult;
    throw error;
  }
}

export function isVerifiedRecommendPostActionCandidateBinding(binding = null, candidateId = "") {
  const expectedCandidateId = String(candidateId || "").trim();
  const root = binding?.detail?.root;
  const rootNodeId = Number(root?.node_id);
  const rootBackendNodeId = Number(root?.backend_node_id);
  const exactRoot = Boolean(
    root?.stable === true
    && root?.visible === true
    && root?.canonical === true
    && root?.action_root === true
    && Number.isInteger(rootNodeId)
    && rootNodeId > 0
    && Number.isInteger(rootBackendNodeId)
    && rootBackendNodeId > 0
  );
  const firstScopes = Array.isArray(binding?.detail?.first?.scopes)
    ? binding.detail.first.scopes
    : [];
  const secondScopes = Array.isArray(binding?.detail?.second?.scopes)
    ? binding.detail.second.scopes
    : [];
  const sampleMatchesRoot = (scopes) => {
    const visiblePopups = scopes.filter((scope) => (
      scope?.source === "popup" && scope?.visible === true
    ));
    const visibleIframes = scopes.filter((scope) => (
      scope?.source === "resume_iframe" && scope?.visible === true
    ));
    if (visiblePopups.length > 1 || visibleIframes.length > 1) return false;
    const canonicalScopes = root?.source === "popup" ? visiblePopups : visibleIframes;
    if (
      canonicalScopes.length !== 1
      || Number(canonicalScopes[0]?.node_id) !== rootNodeId
      || Number(canonicalScopes[0]?.backend_node_id) !== rootBackendNodeId
    ) {
      return false;
    }
    if (root?.source === "popup") {
      const contained = root?.contained_iframe || null;
      if (!contained) return visibleIframes.length === 0;
      if (visibleIframes.length !== 1) return false;
      const iframe = visibleIframes[0];
      return Boolean(
        contained?.stable === true
        && contained?.contained === true
        && iframe?.container_verified === true
        && Number(iframe?.node_id) === Number(contained?.node_id)
        && Number(iframe?.backend_node_id) === Number(contained?.backend_node_id)
        && Number(iframe?.iframe_node_id) === Number(contained?.iframe_node_id)
        && Number(iframe?.iframe_backend_node_id) === Number(contained?.iframe_backend_node_id)
        && Number(iframe?.container_node_id) === rootNodeId
        && Number(iframe?.container_backend_node_id) === rootBackendNodeId
        && iframe?.selector === contained?.selector
        && JSON.stringify(iframe?.ancestry?.path || [])
          === JSON.stringify(contained?.ancestry_path || [])
      );
    }
    return visiblePopups.length === 0 && visibleIframes.length === 1;
  };
  const exactStableRootSamples = Boolean(
    exactRoot
    && sampleMatchesRoot(firstScopes)
    && sampleMatchesRoot(secondScopes)
  );
  const method = binding?.method;
  const compactBeforeCard = binding?.card?.before;
  const provenanceBeforeCard = binding?.card?.pre_click_provenance?.card;
  const causalBeforeCard = compactBeforeCard && provenanceBeforeCard
    ? {
        ...compactBeforeCard,
        candidate_id: compactBeforeCard.candidate_id ?? provenanceBeforeCard.candidate_id,
        name: compactBeforeCard.name ?? provenanceBeforeCard.name
      }
    : compactBeforeCard || provenanceBeforeCard;
  const causalProof = method === "exact_card_click_and_new_resume_root"
    ? verifyExactCardClickToNewResumeRootCausality({
        cardNodeId: causalBeforeCard?.node_id,
        expectedCandidateId: binding?.expected_candidate_id,
        expectedName: binding?.expected_name,
        beforeCard: causalBeforeCard,
        afterCard: binding?.card?.after,
        cardPreClickProvenance: binding?.card?.pre_click_provenance,
        cardClickEvidence: binding?.card?.click_evidence,
        clickAttempts: binding?.card?.click_attempts,
        detailRoot: binding?.detail?.root,
        rootsBeforeWereCaptured: binding?.detail?.roots_before_capture?.captured === true,
        rootsBeforeCaptureComplete: binding?.detail?.roots_before_capture?.complete === true,
        newlyMounted: binding?.detail?.newly_mounted === true,
        rootMatchesExpected: binding?.detail?.root_matches_expected === true,
        hasCandidateIdEvidence: binding?.detail?.candidate_id_evidence_present === true,
        candidateIdProbeComplete: binding?.detail?.candidate_id_probe_complete === true
      })
    : null;
  const exactDetailIdentity = method === "exact_candidate_id_and_name"
    ? binding?.detail?.candidate_id_probe_complete === true
      && binding?.detail?.exact_candidate_id === true
      && binding?.detail?.exact_name === true
    : method === "exact_name_and_secondary_identity"
    ? binding?.detail?.candidate_id_probe_complete === true
      && binding?.detail?.candidate_id_evidence_present === false
      && binding?.detail?.exact_name === true
      && binding?.detail?.exact_secondary === true
    : method === "exact_card_click_and_new_resume_root"
    ? binding?.detail?.candidate_id_probe_complete === true
      && binding?.detail?.candidate_id_evidence_present === false
      && binding?.detail?.exact_name === false
      && binding?.card?.causal_proof?.verified === true
      && causalProof?.verified === true
    : false;
  return Boolean(
    expectedCandidateId
    && binding?.verified === true
    && binding?.stable === true
    && binding?.expected_candidate_id === expectedCandidateId
    && binding?.card?.stable === true
    && binding?.card?.candidate_id === expectedCandidateId
    && exactStableRootSamples
    && exactDetailIdentity
  );
}

export function assertRecommendControlMatchesCandidateDetailRoot(
  control,
  binding,
  stage = "post_action"
) {
  const boundRoot = binding?.detail?.root;
  const boundRootNodeId = Number(boundRoot?.node_id);
  const boundRootBackendNodeId = Number(boundRoot?.backend_node_id);
  const controlRootNodeId = Number(control?.root_node_id);
  const controlRootBackendNodeId = Number(control?.root_backend_node_id);
  const exact = Boolean(
    Number.isInteger(boundRootNodeId)
    && boundRootNodeId > 0
    && Number.isInteger(boundRootBackendNodeId)
    && boundRootBackendNodeId > 0
    && boundRoot?.stable === true
    && boundRoot?.visible === true
    && boundRoot?.canonical === true
    && boundRoot?.action_root === true
    && Number.isInteger(controlRootNodeId)
    && controlRootNodeId > 0
    && Number.isInteger(controlRootBackendNodeId)
    && controlRootBackendNodeId > 0
    // DOM.getDocument may remap a frontend node id while describeNode still
    // proves the same immutable backend node.  The action path re-describes
    // this control root and proves control ancestry again before every Input.
    && controlRootBackendNodeId === boundRootBackendNodeId
  );
  if (!exact) {
    const error = new Error(
      `RECOMMEND_ACTION_DETAIL_ROOT_MISMATCH: action control is not bound to the exact candidate detail root at ${stage}`
    );
    error.code = "RECOMMEND_ACTION_DETAIL_ROOT_MISMATCH";
    error.phase = "recommend:post-action-binding";
    error.expected_root_node_id = boundRootNodeId || null;
    error.expected_root_backend_node_id = boundRootBackendNodeId || null;
    error.observed_root_node_id = Number.isInteger(controlRootNodeId) ? controlRootNodeId : null;
    error.observed_root_backend_node_id = Number.isInteger(controlRootBackendNodeId)
      ? controlRootBackendNodeId
      : null;
    error.retryable = false;
    throw error;
  }
  return true;
}

export async function runRecommendPostAction({
  client,
  screening,
  actionDiscovery,
  postAction = "none",
  greetCount = 0,
  maxGreetCount = null,
  executePostAction = true,
  afterClickDelayMs = 900,
  candidateId = "",
  actionJournal = null,
  actionJournalScope = "boss-recommend:default",
  reverifyActionJournalScope = null,
  runId = "",
  candidateBinding = null,
  reverifyCandidateBinding = null,
  checkpointCritical = null
} = {}) {
  const plan = resolveRecommendPostAction({
    postAction,
    greetCount,
    maxGreetCount
  });
  const result = {
    requested: postAction,
    execute_post_action: Boolean(executePostAction),
    plan,
    eligible: Boolean(screening?.passed),
    action_attempted: false,
    action_clicked: false,
    counted_as_greet: false,
    greet_budget_consumed: false,
    assumed_sent: false,
    protected_from_replay: false,
    confirmation_status: "not_attempted",
    reason: ""
  };

  if (!screening?.passed) {
    result.reason = "screening_not_passed";
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
  result.control = control;

  if (plan.effective === "greet" && control.continue_chat && !executePostAction) {
    result.reason = "already_connected_continue_chat";
    result.already_connected = true;
    return result;
  }
  if (plan.effective === "greet" && control.greet_quota?.exhausted) {
    result.reason = "greet_credits_exhausted";
    result.out_of_greet_credits = true;
    result.stop_run = true;
    return result;
  }
  if (plan.effective === "greet" && control.available === false && !control.continue_chat) {
    result.reason = "greet_control_not_available";
    return result;
  }
  if (control.disabled) {
    result.reason = `${plan.effective}_control_disabled`;
    return result;
  }
  if (!executePostAction) {
    result.reason = "dry_run_post_action";
    result.would_click = true;
    return result;
  }

  const normalizedCandidateId = String(candidateId || "").trim();
  if (!normalizedCandidateId) {
    const error = new Error(
      "RECOMMEND_ACTION_CANDIDATE_ID_REQUIRED: refusing greeting without a stable Boss candidate ID"
    );
    error.code = "RECOMMEND_ACTION_CANDIDATE_ID_REQUIRED";
    error.retryable = false;
    throw error;
  }
  if (!isVerifiedRecommendPostActionCandidateBinding(candidateBinding, normalizedCandidateId)) {
    const error = createRecommendDetailCandidateBindingError(candidateBinding || {
      schema_version: 1,
      verified: false,
      reason: "post_action_candidate_binding_missing",
      expected_candidate_id: normalizedCandidateId
    });
    error.phase = "recommend:post-action-binding";
    throw error;
  }
  result.candidate_binding = compactRecommendDetailCandidateBinding(candidateBinding);
  assertRecommendControlMatchesCandidateDetailRoot(
    control,
    candidateBinding,
    "initial_control_binding"
  );
  if (!isVerifiedRecommendActionJournalScope(actionJournalScope)) {
    const error = new Error(
      "RECOMMEND_ACTION_SCOPE_UNVERIFIED: live greeting requires an exact canonical Chrome profile scope"
    );
    error.code = "RECOMMEND_ACTION_SCOPE_UNVERIFIED";
    error.retryable = false;
    throw error;
  }
  if (typeof reverifyCandidateBinding !== "function") {
    const error = new Error(
      "RECOMMEND_ACTION_CANDIDATE_REVERIFY_REQUIRED: live greeting requires fresh candidate binding"
    );
    error.code = "RECOMMEND_ACTION_CANDIDATE_REVERIFY_REQUIRED";
    error.retryable = false;
    throw error;
  }
  if (typeof reverifyActionJournalScope !== "function") {
    const error = new Error(
      "RECOMMEND_ACTION_SCOPE_REVERIFY_REQUIRED: live greeting requires fresh Chrome profile proof"
    );
    error.code = "RECOMMEND_ACTION_SCOPE_REVERIFY_REQUIRED";
    error.retryable = false;
    throw error;
  }
  if (!actionJournal || typeof actionJournal.read !== "function" || typeof actionJournal.transition !== "function") {
    const error = new Error(
      "RECOMMEND_ACTION_JOURNAL_REQUIRED: durable greeting action journal is unavailable"
    );
    error.code = "RECOMMEND_ACTION_JOURNAL_REQUIRED";
    error.retryable = false;
    throw error;
  }
  if (typeof checkpointCritical !== "function") {
    const error = new Error(
      "RECOMMEND_CRITICAL_CHECKPOINT_UNAVAILABLE: refusing greeting without required persistence"
    );
    error.code = "RECOMMEND_CRITICAL_CHECKPOINT_UNAVAILABLE";
    error.retryable = false;
    throw error;
  }

  const requireFreshActionJournalScope = async (stage) => {
    const fresh = await reverifyActionJournalScope(stage);
    const freshScope = String(fresh?.scope || fresh || "").trim();
    if (!isVerifiedRecommendActionJournalScope(freshScope) || freshScope !== actionJournalScope) {
      const error = new Error(
        `RECOMMEND_ACTION_SCOPE_DRIFT: exact Chrome profile scope changed at ${stage}`
      );
      error.code = "RECOMMEND_ACTION_SCOPE_DRIFT";
      error.expected_scope = actionJournalScope;
      error.observed_scope = freshScope || null;
      error.retryable = false;
      throw error;
    }
    return freshScope;
  };
  const operationId = `${String(runId || "recommend-run").trim() || "recommend-run"}:${crypto.randomUUID()}`;
  const requireFreshCandidateBinding = async (stage, boundControl = control, {
    allowScroll = true,
    settleMs = 120
  } = {}) => {
    const normalizedSettleMs = allowScroll
      ? Math.max(0, Number(settleMs) || 0)
      : 0;
    const freshBinding = await reverifyCandidateBinding(stage, {
      allowScroll: allowScroll === true,
      settleMs: normalizedSettleMs
    });
    if (!isVerifiedRecommendPostActionCandidateBinding(freshBinding, normalizedCandidateId)) {
      const error = createRecommendDetailCandidateBindingError(freshBinding || {
        schema_version: 1,
        verified: false,
        reason: `post_action_candidate_binding_lost_${stage}`,
        expected_candidate_id: normalizedCandidateId
      });
      error.phase = "recommend:post-action-binding";
      throw error;
    }
    if (
      allowScroll === false
      && (
        freshBinding?.allow_scroll !== false
        || Number(freshBinding?.settle_ms) !== 0
      )
    ) {
      const error = createRecommendDetailCandidateBindingError({
        ...freshBinding,
        verified: false,
        reason: "non_scrolling_candidate_reproof_unavailable"
      });
      error.phase = "recommend:post-action-binding";
      throw error;
    }
    assertRecommendControlMatchesCandidateDetailRoot(boundControl, freshBinding, stage);
    result.candidate_binding = compactRecommendDetailCandidateBinding(freshBinding);
    return freshBinding;
  };
  await requireFreshActionJournalScope("before_journal_read");
  let journalRecord = actionJournal.read({
    scope: actionJournalScope,
    candidateId: normalizedCandidateId
  });
  let journalFilePath = typeof actionJournal.entryPath === "function"
    ? actionJournal.entryPath({ scope: actionJournalScope, candidateId: normalizedCandidateId })
    : null;
  const transitionAction = (state, evidence = {}, {
    requireChanged = false,
    recordIdempotent = false,
    expectedUpdatedAt = null,
    expectedRevision = null
  } = {}) => {
    const transitioned = actionJournal.transition({
      scope: actionJournalScope,
      candidateId: normalizedCandidateId,
      state,
      runId,
      greeting: RECOMMEND_GREETING_ACTION_FINGERPRINT,
      recordIdempotent,
      expectedUpdatedAt,
      expectedRevision,
      evidence: {
        action: "recommend_greet",
        active_candidate_id: normalizedCandidateId,
        operation_id: operationId,
        ...evidence
      }
    });
    if (requireChanged && transitioned?.changed !== true) {
      const error = new Error(
        "RECOMMEND_ACTION_IN_FLIGHT_NOT_OWNED: journal transition was idempotent or owned elsewhere"
      );
      error.code = "RECOMMEND_ACTION_IN_FLIGHT_NOT_OWNED";
      error.retryable = false;
      throw error;
    }
    journalRecord = transitioned.record;
    journalFilePath = transitioned.file_path || journalFilePath;
    const transaction = compactRecommendActionJournalRecord(journalRecord, journalFilePath);
    try {
      checkpointCritical({ action_transaction: transaction });
    } catch (error) {
      if (state === "greeting_send_in_flight" && transitioned?.changed === true) {
        error.recommend_pre_input_checkpoint_failed = true;
        error.recommend_owned_operation_id = operationId;
        throw error;
      }
      if (
        state === "greeting_confirmed"
        || state === RECOMMEND_GREETING_ASSUMED_SENT_STATE
        || state === "outcome_unknown"
      ) {
        result.action_transaction_checkpoint_error = compactRecommendPostActionError(error);
        result.action_transaction_checkpoint_degraded = true;
        result.stop_run = false;
      } else {
        throw error;
      }
    }
    result.action_transaction = transaction;
    return journalRecord;
  };
  const retryFinalActionTransactionCheckpoint = async () => {
    if (!result.action_transaction_checkpoint_error) return true;
    let lastError = result.action_transaction_checkpoint_error;
    const retryDelaysMs = [100, 500, 1500, 3000];
    for (let attempt = 1; attempt <= retryDelaysMs.length; attempt += 1) {
      await sleep(retryDelaysMs[attempt - 1]);
      try {
        checkpointCritical({ action_transaction: result.action_transaction });
        result.action_transaction_checkpoint_recovered = true;
        result.action_transaction_checkpoint_retry_count = attempt;
        result.action_transaction_checkpoint_error = null;
        result.action_transaction_checkpoint_degraded = false;
        result.stop_run = false;
        return true;
      } catch (error) {
        lastError = compactRecommendPostActionError(error);
      }
    }
    result.action_transaction_checkpoint_error = lastError;
    result.action_transaction_checkpoint_retry_count = retryDelaysMs.length;
    result.action_transaction_checkpoint_degraded = true;
    result.stop_run = false;
    return false;
  };
  const checkpointProtectedActionTransaction = async () => {
    try {
      checkpointCritical({ action_transaction: result.action_transaction });
      return true;
    } catch (error) {
      result.action_transaction_checkpoint_error = compactRecommendPostActionError(error);
      result.action_transaction_checkpoint_degraded = true;
      return retryFinalActionTransactionCheckpoint();
    }
  };
  const preservePostInputJournalFailure = ({
    error,
    desiredState,
    reason,
    triggeringError = null,
    inputDispatched = true
  }) => {
    const journalError = compactRecommendPostActionError(error);
    const triggeringActionError = compactRecommendPostActionError(triggeringError);
    const lastDurableTransaction = compactRecommendActionJournalRecord(
      journalRecord,
      journalFilePath
    );
    const lastDurableState = String(lastDurableTransaction?.state || "").trim();
    const durableReplayProtection = [
      "greeting_send_in_flight",
      RECOMMEND_GREETING_ASSUMED_SENT_STATE,
      "greeting_confirmed",
      "outcome_unknown"
    ].includes(lastDurableState);
    const terminalPreservation = {
      required: !durableReplayProtection,
      warning_only: durableReplayProtection,
      reason: "post_input_action_journal_persistence_failed",
      candidate_id: normalizedCandidateId,
      operation_id: operationId,
      action: "recommend_greet",
      input_dispatched: inputDispatched === true,
      desired_action_state: desiredState || null,
      last_durable_action_state: lastDurableTransaction?.state || null,
      candidate_binding: result.candidate_binding
        || compactRecommendDetailCandidateBinding(candidateBinding),
      control: compactRecommendControlEvidence(result.control_confirmation || control),
      click_result: result.click_result || null,
      journal_error: journalError,
      triggering_error: triggeringActionError
    };
    result.reason = reason || "greet_post_input_journal_persistence_failed";
    result.counted_as_greet = durableReplayProtection && plan.effective === "greet";
    result.greet_budget_consumed = durableReplayProtection && plan.effective === "greet";
    result.outcome_unknown = !durableReplayProtection;
    result.assumed_sent = durableReplayProtection;
    result.protected_from_replay = durableReplayProtection;
    result.confirmation_status = durableReplayProtection
      ? "assumed_sent_journal_degraded"
      : "unknown";
    result.stop_run = !durableReplayProtection;
    result.preserve_detail_on_terminal = !durableReplayProtection;
    result.preserve_detail_until_result_persisted = !durableReplayProtection;
    result.post_input_journal_persistence_failed = true;
    result.action_transaction_checkpoint_degraded = durableReplayProtection;
    result.action_input_dispatched = inputDispatched === true;
    result.action_transaction = lastDurableTransaction;
    result.terminal_preservation = terminalPreservation;
    result.error = journalError;
    if (triggeringActionError) result.triggering_error = triggeringActionError;
    try {
      checkpointCritical({
        preserve_detail_on_terminal: !durableReplayProtection,
        action_result_critical_persisted: false,
        terminal_preservation: terminalPreservation,
        action_transaction: lastDurableTransaction
      });
      result.terminal_preservation_checkpointed = true;
    } catch (checkpointError) {
      result.terminal_preservation_checkpointed = false;
      result.terminal_preservation_checkpoint_error = compactRecommendPostActionError(
        checkpointError
      );
    }
    return result;
  };

  if (control.continue_chat) {
    await requireFreshCandidateBinding("before_continue_chat_reconciliation", control);
    const reconciledControl = await verifyRecommendActionControlIdentity(client, control, {
      requireContinueChat: true,
      requireGeometry: true
    });
    await requireFreshCandidateBinding("after_continue_chat_control_verification", reconciledControl);
    result.control_reconciliation = reconciledControl;
    const unknownOrigin = recommendGreetingUnknownOrigin(journalRecord);
    try {
      if (journalRecord?.state === "outcome_unknown" && unknownOrigin === "greeting_send_in_flight") {
        transitionAction(RECOMMEND_GREETING_ASSUMED_SENT_STATE, {
          reason: "legacy_unknown_migrated_before_exact_continue_chat_reconciliation",
          assumption_policy: RECOMMEND_GREETING_ASSUMPTION_POLICY,
          confirmation_status: "assumed_sent",
          protected_from_replay: true,
          input_dispatched: true
        });
      }
      if (
        journalRecord?.state === "greeting_send_in_flight"
        || journalRecord?.state === RECOMMEND_GREETING_ASSUMED_SENT_STATE
      ) {
        transitionAction("greeting_confirmed", {
          reason: "reconciled_from_exact_continue_chat_control",
          confirmation_status: "passively_confirmed",
          protected_from_replay: true
        });
        await retryFinalActionTransactionCheckpoint();
      }
    } catch (error) {
      result.passive_confirmation_journal_degraded = true;
      result.journal_error = compactRecommendPostActionError(error);
      result.action_transaction = compactRecommendActionJournalRecord(journalRecord, journalFilePath);
    }
    result.reason = journalRecord?.state === "greeting_confirmed"
      ? "greeting_confirmed_by_durable_journal"
      : result.passive_confirmation_journal_degraded
        ? "already_connected_continue_chat_journal_degraded"
        : "already_connected_continue_chat";
    result.already_connected = true;
    result.passively_confirmed = true;
    result.verified_after_click = true;
    result.protected_from_replay = true;
    result.confirmation_status = journalRecord?.state === "greeting_confirmed"
      ? "confirmed"
      : "passively_confirmed";
    return result;
  }

  if (journalRecord?.state === "greeting_confirmed") {
    result.reason = "greeting_confirmed_by_durable_journal";
    result.already_connected = true;
    result.verified_after_click = true;
    result.protected_from_replay = true;
    result.confirmation_status = "confirmed";
    result.action_transaction = compactRecommendActionJournalRecord(journalRecord, journalFilePath);
    return result;
  }

  const unknownOrigin = recommendGreetingUnknownOrigin(journalRecord);
  const latestGreetingReason = latestRecommendGreetingEvidence(journalRecord)?.reason;
  const replayablePreInputAbort = Boolean(
    journalRecord?.state === "greeting_send_in_flight"
    && (
      latestGreetingReason === "pre_input_checkpoint_aborted"
      || latestGreetingReason === "pre_input_abort"
    )
  );
  if (
    (journalRecord?.state === "greeting_send_in_flight" && !replayablePreInputAbort)
    || (journalRecord?.state === "outcome_unknown" && unknownOrigin === "greeting_send_in_flight")
  ) {
    transitionAction(RECOMMEND_GREETING_ASSUMED_SENT_STATE, {
      reason: journalRecord.state === "outcome_unknown"
        ? "legacy_unknown_assumed_sent_no_replay"
        : "in_flight_greeting_assumed_sent_no_replay",
      assumption_policy: RECOMMEND_GREETING_ASSUMPTION_POLICY,
      confirmation_status: "assumed_sent",
      protected_from_replay: true,
      input_dispatched: true
    });
    await retryFinalActionTransactionCheckpoint();
    result.reason = "greet_assumed_sent_preserved_no_replay";
    result.assumed_sent = true;
    result.protected_from_replay = true;
    result.confirmation_status = "assumed_sent";
    result.skipped = true;
    return result;
  }
  if (journalRecord?.state === RECOMMEND_GREETING_ASSUMED_SENT_STATE) {
    result.reason = "greet_assumed_sent_preserved_no_replay";
    result.assumed_sent = true;
    result.protected_from_replay = true;
    result.confirmation_status = "assumed_sent";
    result.skipped = true;
    result.action_transaction = compactRecommendActionJournalRecord(journalRecord, journalFilePath);
    await checkpointProtectedActionTransaction();
    return result;
  }
  if (journalRecord?.state === "outcome_unknown") {
    result.reason = "greet_outcome_unknown_preserved_no_replay";
    result.outcome_unknown = true;
    result.protected_from_replay = true;
    result.confirmation_status = "unknown";
    result.skipped = true;
    result.action_transaction = compactRecommendActionJournalRecord(journalRecord, journalFilePath);
    await checkpointProtectedActionTransaction();
    return result;
  }
  if (!journalRecord) {
    transitionAction("pre_action", { reason: "greeting_eligible" });
  }
  if (journalRecord?.state !== "pre_action" && !replayablePreInputAbort) {
    result.reason = "greet_journal_state_quarantined_no_replay";
    result.skipped = true;
    result.protected_from_replay = true;
    result.confirmation_status = "quarantined";
    result.journal_quarantined = true;
    result.action_transaction = compactRecommendActionJournalRecord(journalRecord, journalFilePath);
    await checkpointProtectedActionTransaction();
    return result;
  }

  result.action_attempted = true;
  result.control_before = control;
  let clickResult;
  let greetingInFlightPersisted = false;
  try {
    clickResult = await clickRecommendActionControl(client, {
      ...control,
      kind: plan.effective
    }, {
      beforeFinalRefresh: async () => {
        await requireFreshActionJournalScope("immediately_before_greeting_in_flight");
        await requireFreshCandidateBinding("immediately_before_greeting_control_refresh", control);
      },
      beforeClick: async (freshControl) => {
        const expectedUpdatedAt = journalRecord?.updated_at || null;
        const expectedRevision = Number(journalRecord?.revision);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
          const error = new Error(
            "RECOMMEND_ACTION_JOURNAL_REVISION_REQUIRED: exact journal ownership revision is missing"
          );
          error.code = "RECOMMEND_ACTION_JOURNAL_REVISION_REQUIRED";
          error.retryable = false;
          throw error;
        }
        transitionAction("greeting_send_in_flight", {
          send_method: "Input.dispatchMouseEvent",
          reason: "immediately_before_non_replayable_click",
          active_candidate_id: normalizedCandidateId,
          ...compactRecommendControlEvidence(freshControl)
        }, {
          requireChanged: true,
          recordIdempotent: replayablePreInputAbort,
          expectedUpdatedAt,
          expectedRevision
        });
        greetingInFlightPersisted = true;
      },
      beforeInput: async () => {
        await requireFreshActionJournalScope("before_final_greeting_control_verification");
        await requireFreshCandidateBinding("before_final_greeting_control_verification", control);
      },
      immediatelyBeforeInput: async (finalControl) => {
        await requireFreshActionJournalScope("immediately_before_greeting_input");
        await requireFreshCandidateBinding(
          "immediately_before_greeting_input",
          finalControl,
          { allowScroll: false, settleMs: 0 }
        );
      }
    });
  } catch (error) {
    if (error?.code === GREET_CREDITS_EXHAUSTED_CODE) {
      result.reason = "greet_credits_exhausted";
      result.out_of_greet_credits = true;
      result.stop_run = true;
      result.greet_quota = error.greet_quota || control.greet_quota || null;
      return result;
    }
    if (
      error?.recommend_pre_input_checkpoint_failed === true
      || (
        error?.recommend_pre_input_aborted === true
        && journalRecord?.state === "greeting_send_in_flight"
        && error?.code !== "RECOMMEND_ACTION_IN_FLIGHT_NOT_OWNED"
        && error?.code !== "CHAT_ACTION_JOURNAL_CONCURRENT_UPDATE"
      )
    ) {
      const abortReason = error?.recommend_pre_input_checkpoint_failed === true
        ? "pre_input_checkpoint_aborted"
        : "pre_input_abort";
      const hitTestEvidence = error?.recommend_action_control_hit_test || null;
      const hitTestAttempts = Array.isArray(hitTestEvidence?.attempts)
        ? hitTestEvidence.attempts
        : [];
      const lastHitTestAttempt = hitTestAttempts.at(-1) || null;
      const aborted = actionJournal.transition({
        scope: actionJournalScope,
        candidateId: normalizedCandidateId,
        state: "greeting_send_in_flight",
        runId,
        greeting: RECOMMEND_GREETING_ACTION_FINGERPRINT,
        recordIdempotent: true,
        expectedUpdatedAt: journalRecord?.updated_at || null,
        expectedRevision: journalRecord?.revision ?? null,
        evidence: {
          action: "recommend_greet",
          active_candidate_id: normalizedCandidateId,
          operation_id: operationId,
          reason: abortReason,
          send_method: "Input.dispatchMouseEvent",
          pre_input_cdp_method: error?.cdp_method || null,
          action_hit_test_reason: lastHitTestAttempt?.reason || null,
          action_hit_test_attempt_count: hitTestAttempts.length,
          action_hit_test_last_hit_backend_node_id: Number.isInteger(
            Number(lastHitTestAttempt?.hit_backend_node_id)
          ) ? Number(lastHitTestAttempt.hit_backend_node_id) : null
        }
      });
      journalRecord = aborted.record;
      journalFilePath = aborted.file_path || journalFilePath;
      result.action_transaction = compactRecommendActionJournalRecord(journalRecord, journalFilePath);
      result.reason = abortReason === "pre_input_checkpoint_aborted"
        ? "greet_pre_input_checkpoint_aborted_replayable"
        : "greet_pre_input_aborted_replayable";
      result.pre_input_aborted = true;
      result.replayable = true;
      result.skipped = true;
      result.stop_run = false;
      result.action_transaction_checkpoint_degraded = error?.recommend_pre_input_checkpoint_failed === true;
      result.error = compactRecommendPostActionError(error);
      return result;
    }
    if (
      error?.code === "RECOMMEND_ACTION_IN_FLIGHT_NOT_OWNED"
      || error?.code === "CHAT_ACTION_JOURNAL_CONCURRENT_UPDATE"
    ) {
      journalRecord = actionJournal.read({
        scope: actionJournalScope,
        candidateId: normalizedCandidateId
      }) || journalRecord;
      result.reason = "greet_in_flight_owned_by_another_operation";
      result.outcome_unknown = true;
      result.skipped = true;
      result.protected_from_replay = true;
      result.confirmation_status = "foreign_operation_protected";
      result.action_transaction = compactRecommendActionJournalRecord(journalRecord, journalFilePath);
      await checkpointProtectedActionTransaction();
      return result;
    }
    if (greetingInFlightPersisted || journalRecord?.state === "greeting_send_in_flight") {
      try {
        transitionAction(RECOMMEND_GREETING_ASSUMED_SENT_STATE, {
          reason: "non_replayable_click_failed_or_disconnected",
          send_method: error?.cdp_method || "Input.dispatchMouseEvent",
          assumption_policy: RECOMMEND_GREETING_ASSUMPTION_POLICY,
          confirmation_status: "assumed_sent",
          protected_from_replay: true,
          input_dispatched: true
        });
        await retryFinalActionTransactionCheckpoint();
      } catch (journalError) {
        return preservePostInputJournalFailure({
          error: journalError,
          desiredState: RECOMMEND_GREETING_ASSUMED_SENT_STATE,
          reason: "greet_post_input_assumed_sent_persistence_failed",
          triggeringError: error,
          inputDispatched: true
        });
      }
      result.reason = result.stop_run === true
        ? "greet_assumed_sent_checkpoint_failed"
        : "greet_assumed_sent";
      result.assumed_sent = true;
      result.protected_from_replay = true;
      result.confirmation_status = "assumed_sent";
      result.counted_as_greet = plan.effective === "greet";
      result.greet_budget_consumed = plan.effective === "greet";
      result.action_input_dispatched = true;
      result.error = compactRecommendPostActionError(error);
      if (error?.recommend_input_transport_abandon_failed === true) {
        result.reason = "greet_assumed_sent_input_transport_not_contained";
        result.stop_run = true;
        result.preserve_detail_on_terminal = true;
        result.terminal_preservation = {
          required: true,
          reason: "non_replayable_input_transport_not_contained",
          candidate_id: normalizedCandidateId,
          action_state: journalRecord?.state || null,
          input_timeout_diagnostic: error.input_timeout_diagnostic || null
        };
      }
      return result;
    }
    throw error;
  }
  result.click_result = clickResult;
  result.action_clicked = true;
  result.counted_as_greet = plan.effective === "greet";
  result.greet_budget_consumed = plan.effective === "greet";
  result.confirmation_status = "pending_readback";
  result.reason = "clicked";
  if (afterClickDelayMs > 0) await sleep(afterClickDelayMs);
  try {
    const afterDiscovery = await waitForRecommendDetailActionControls(client, {
      timeoutMs: 2500,
      intervalMs: 300,
      requireAny: false,
      requireContinueChat: plan.effective === "greet"
    });
    const afterSummary = afterDiscovery?.summary || {};
    const afterControl = afterSummary.greet;
    result.action_discovery_after = compactActionDiscovery(afterDiscovery);
    result.control_after = afterControl || null;
    if (plan.effective === "greet") {
      await requireFreshCandidateBinding("after_greeting_before_confirmation", afterControl);
      const confirmedControl = await verifyRecommendActionControlIdentity(client, afterControl, {
        requireContinueChat: true,
        requireGeometry: true
      });
      await requireFreshCandidateBinding("after_greeting_control_confirmation", confirmedControl);
      result.control_confirmation = confirmedControl;
      result.verified_after_click = confirmedControl.verified === true;
    }
  } catch (error) {
    result.verify_error = {
      message: error?.message || String(error)
    };
  }
  try {
    if (result.verified_after_click === true) {
      transitionAction("greeting_confirmed", {
        reason: "exact_continue_chat_control_after_click",
        send_method: "Input.dispatchMouseEvent",
        confirmation_status: "confirmed",
        protected_from_replay: true,
        input_dispatched: true
      });
      await retryFinalActionTransactionCheckpoint();
      result.counted_as_greet = plan.effective === "greet";
      result.greet_budget_consumed = plan.effective === "greet";
      result.protected_from_replay = true;
      result.confirmation_status = "confirmed";
      result.reason = "greeting_confirmed";
    } else {
      transitionAction(RECOMMEND_GREETING_ASSUMED_SENT_STATE, {
        reason: "post_click_confirmation_not_observed",
        send_method: "Input.dispatchMouseEvent",
        assumption_policy: RECOMMEND_GREETING_ASSUMPTION_POLICY,
        confirmation_status: "assumed_sent",
        protected_from_replay: true,
        input_dispatched: true
      });
      await retryFinalActionTransactionCheckpoint();
      result.counted_as_greet = plan.effective === "greet";
      result.greet_budget_consumed = plan.effective === "greet";
      result.reason = result.stop_run === true
        ? "greet_assumed_sent_checkpoint_failed"
        : "greet_confirmation_not_observed_assumed_sent";
      result.assumed_sent = true;
      result.protected_from_replay = true;
      result.confirmation_status = "assumed_sent";
    }
  } catch (journalError) {
    return preservePostInputJournalFailure({
      error: journalError,
      desiredState: result.verified_after_click === true
        ? "greeting_confirmed"
        : RECOMMEND_GREETING_ASSUMED_SENT_STATE,
      reason: "greet_post_input_terminal_state_persistence_failed",
      inputDispatched: true
    });
  }
  return result;
}

function compactRecommendFilteredEmptyState(emptyState) {
  if (!emptyState) return null;
  return {
    verified: Boolean(emptyState.verified),
    reason: emptyState.reason || null,
    text: emptyState.text || null,
    node_id: Number.isInteger(emptyState.node_id) ? emptyState.node_id : null,
    box: emptyState.box || null,
    accessibility: emptyState.accessibility || null,
    selector_counts: emptyState.selector_counts || null,
    checked_node_count: Number.isInteger(emptyState.checked_node_count)
      ? emptyState.checked_node_count
      : 0,
    candidate_node_count: Number.isInteger(emptyState.candidate_node_count)
      ? emptyState.candidate_node_count
      : 0,
    query_errors: Array.isArray(emptyState.query_errors) ? emptyState.query_errors.slice(0, 20) : []
  };
}

export function isVerifiedRecommendRefreshCompletion(refreshResult) {
  return Boolean(
    refreshResult?.ok === true
    && refreshResult?.exhausted === true
    && refreshResult?.empty_state?.verified === true
    && Number(refreshResult?.card_count) === 0
  );
}

function compactRefreshAttempt(refreshAttempt) {
  if (!refreshAttempt) return null;
  return {
    ok: Boolean(refreshAttempt.ok),
    exhausted: Boolean(refreshAttempt.exhausted),
    method: refreshAttempt.method || "",
    reason: refreshAttempt.reason || null,
    error: refreshAttempt.error || null,
    error_diagnostic: refreshAttempt.error_diagnostic || null,
    forced_recent_not_view: Boolean(refreshAttempt.forced_recent_not_view),
    target_url: refreshAttempt.target_url || null,
    card_count: Number.isInteger(refreshAttempt.card_count) ? refreshAttempt.card_count : 0,
    empty_state: compactRecommendFilteredEmptyState(refreshAttempt.empty_state),
    elapsed_ms: refreshAttempt.elapsed_ms || 0,
    recovery_settle: refreshAttempt.recovery_settle
      ? {
          ok: Boolean(refreshAttempt.recovery_settle.ok),
          status: refreshAttempt.recovery_settle.status || "",
          reason: refreshAttempt.recovery_settle.reason || "",
          elapsed_ms: refreshAttempt.recovery_settle.elapsed_ms || 0
        }
      : null,
    attempts: (refreshAttempt.attempts || []).map((attempt) => ({
      ok: Boolean(attempt.ok),
      method: attempt.method || "",
      reason: attempt.reason || null,
      error: attempt.error || null,
      error_diagnostic: attempt.error_diagnostic || null,
      label: attempt.label || null,
      before_card_count: attempt.before_card_count || 0,
      after_card_count: attempt.after_card_count || 0,
      card_count: Number.isInteger(attempt.card_count) ? attempt.card_count : 0,
      empty_state: compactRecommendFilteredEmptyState(attempt.empty_state),
      elapsed_ms: attempt.elapsed_ms || 0,
      current_city_only: compactCurrentCityOnlyResult(attempt.current_city_only),
      current_city_only_attempts: (attempt.current_city_only_attempts || []).map((cityAttempt) => ({
        ok: Boolean(cityAttempt.ok),
        method: cityAttempt.method || "current_city_only_reapply",
        reason: cityAttempt.reason || null,
        error: cityAttempt.error || null,
        error_diagnostic: cityAttempt.error_diagnostic || null,
        attempt: cityAttempt.attempt || 0,
        result: compactCurrentCityOnlyResult(cityAttempt.result)
      })),
      filter: compactFilterResult(attempt.filter)
    })),
    current_city_only_attempts: (refreshAttempt.current_city_only_attempts || []).map((attempt) => ({
      ok: Boolean(attempt.ok),
      method: attempt.method || "current_city_only_reapply",
      reason: attempt.reason || null,
      error: attempt.error || null,
      error_diagnostic: attempt.error_diagnostic || null,
      attempt: attempt.attempt || 0,
      result: compactCurrentCityOnlyResult(attempt.result)
    })),
    filter_reapply_attempts: (refreshAttempt.filter_reapply_attempts || []).map((attempt) => ({
      ok: Boolean(attempt.ok),
      method: attempt.method || "filter_reapply",
      reason: attempt.reason || null,
      error: attempt.error || null,
      error_diagnostic: attempt.error_diagnostic || null,
      attempt: attempt.attempt || 0
    })),
    job_selection_attempts: (refreshAttempt.job_selection_attempts || []).map((attempt) => ({
      ok: Boolean(attempt.ok),
      method: attempt.method || "job_select",
      reason: attempt.reason || null,
      error: attempt.error || null,
      error_diagnostic: attempt.error_diagnostic || null,
      attempt: attempt.attempt || 0,
      iframe_document_node_id: attempt.iframe_document_node_id || 0,
      selected: Boolean(attempt.selected),
      selection_reason: attempt.selection_reason || null
    })),
    job_selection: compactJobSelection(refreshAttempt.job_selection),
    page_scope: compactPageScopeSelection(refreshAttempt.page_scope),
    current_city_only: compactCurrentCityOnlyResult(refreshAttempt.current_city_only),
    filter: compactFilterResult(refreshAttempt.filter)
  };
}

export function countRecommendResultStatuses(results = [], {
  greetCount = 0
} = {}) {
  return {
    processed: results.length,
    screened: results.length,
    detail_opened: results.filter((item) => item.detail).length,
    passed: results.filter((item) => item.screening?.passed).length,
    skipped: results.filter((item) => item.screening?.passed === false).length,
    llm_screened: results.filter((item) => item.detail?.llm_screening || item.llm_screening).length,
    greet_count: greetCount,
    greet_confirmed_count: results.filter((item) => (
      item.post_action?.counted_as_greet === true
      && item.post_action?.action_transaction?.state === "greeting_confirmed"
    )).length,
    greet_assumed_sent_count: results.filter((item) => (
      item.post_action?.greet_budget_consumed === true
      && (
        item.post_action?.assumed_sent === true
        || item.post_action?.action_transaction?.state === RECOMMEND_GREETING_ASSUMED_SENT_STATE
      )
    )).length,
    greet_protected_no_replay_count: results.filter((item) => (
      item.post_action?.protected_from_replay === true
    )).length,
    post_action_clicked: results.filter((item) => item.post_action?.action_clicked).length,
    image_capture_failed: results.filter((item) => item.detail?.image_evidence?.ok === false).length,
    detail_open_failed: results.filter((item) => (
      item.error?.code === "DETAIL_STALE_NODE"
      || item.error?.code === "DETAIL_OPEN_FAILED"
      || item.error?.code === "RECOMMEND_DETAIL_CANDIDATE_MISMATCH"
    )).length,
    transient_recovered: results.filter((item) => (
      (
        item.timings?.image_capture_resume?.attempted === true
        && item.timings?.image_capture_resume?.ok === true
      )
      || item.detail?.cv_acquisition?.close_recovery?.ok === true
    )).length,
    colleague_contact_checked: results.filter((item) => item.detail?.colleague_contact?.checked).length,
    recent_colleague_contact_skipped: results.filter((item) => (
      item.screening?.status === "skip"
      && item.screening?.reasons?.includes("skipped_recent_colleague_contact")
    )).length,
    colleague_contact_panel_missing: results.filter((item) => (
      item.detail?.colleague_contact?.reason === "panel_missing"
    )).length
  };
}

function countPassedResults(results = []) {
  return countRecommendResultStatuses(results).passed;
}

function compactCloseResult(closeResult) {
  if (!closeResult) return null;
  const result = {
    closed: Boolean(closeResult.closed),
    reason: closeResult.reason || null,
    probe: closeResult.probe || null,
    attempts: closeResult.attempts || [],
    verification: closeResult.verification || null
  };
  if (closeResult.already_closed !== undefined) {
    result.already_closed = Boolean(closeResult.already_closed);
  }
  return result;
}

function compactError(error, fallbackCode = "RECOMMEND_RUN_ERROR") {
  if (!error) return null;
  const cdpDiagnostic = compactCdpFailureDiagnostic(error, {
    fallbackCode,
    fallbackPhase: error?.phase || ""
  });
  const result = {
    code: error.code || fallbackCode,
    message: error.message || String(error)
  };
  if (error.close_result) {
    result.close_result = compactCloseResult(error.close_result);
  }
  if (error.phase) {
    result.phase = error.phase;
  }
  if (error.refresh_attempt) {
    result.refresh_attempt = error.refresh_attempt;
  }
  if (error.error_diagnostic) {
    result.error_diagnostic = error.error_diagnostic;
  } else if (
    cdpDiagnostic.cdp_method
    || cdpDiagnostic.cdp_connection_epoch !== null
    || cdpDiagnostic.cdp_node_id !== null
  ) {
    result.error_diagnostic = cdpDiagnostic;
  }
  if (error.list_end_reason) {
    result.list_end_reason = error.list_end_reason;
  }
  if (error.target_count != null) {
    result.target_count = error.target_count;
  }
  if (error.screening_candidate_identity) {
    result.screening_candidate_identity = error.screening_candidate_identity;
  }
  if (error.passed_count != null) {
    result.passed_count = error.passed_count;
  }
  if (Array.isArray(error.recommend_detail_open_attempts)) {
    result.recommend_detail_open_attempts = error.recommend_detail_open_attempts;
  }
  if (error.recommend_pre_click_retry) {
    result.recommend_pre_click_retry = error.recommend_pre_click_retry;
  }
  if (error.recommend_pre_click_stale_no_action === true) {
    result.recommend_pre_click_stale_no_action = true;
    result.recommend_no_click_dispatched = error.recommend_no_click_dispatched === true;
    result.recommend_click_dispatched = error.recommend_click_dispatched === true;
    result.recommend_input_dispatched = error.recommend_input_dispatched === true;
    result.recommend_pre_click_stage = error.recommend_pre_click_stage || null;
    result.recommend_pre_click_retry_exhausted = error.recommend_pre_click_retry_exhausted === true;
    result.recommend_pre_click_reacquire_failed = error.recommend_pre_click_reacquire_failed === true;
  }
  if (error.recommend_input_dispatched === true) {
    result.recommend_click_dispatched = error.recommend_click_dispatched === true;
    result.recommend_input_dispatched = true;
    result.recommend_post_input_outcome_unknown = error.recommend_post_input_outcome_unknown === true;
    result.recommend_click_negative_outcome_observed = error.recommend_click_negative_outcome_observed === true;
    result.recommend_post_input_stage = error.recommend_post_input_stage || null;
  }
  if (Array.isArray(error.click_attempts)) {
    result.click_attempts = error.click_attempts;
  }
  if (error.avatar_preview) {
    result.avatar_preview = {
      open: Boolean(error.avatar_preview.open),
      selector: error.avatar_preview.preview?.selector || null,
      rect: error.avatar_preview.preview?.rect || null
    };
  }
  return result;
}

function createRecommendCloseFailureError(closeResult) {
  const error = new Error(closeResult?.reason || "Recommend detail did not close before recovery");
  error.code = "DETAIL_CLOSE_FAILED";
  error.close_result = closeResult || null;
  return error;
}

function createRecommendBlockingPanelCloseFailureError(closeResult, phase = "") {
  const error = new Error(closeResult?.reason || "Boss account-rights panel did not close before recovery");
  error.code = "ACCOUNT_RIGHTS_PANEL_CLOSE_FAILED";
  error.close_result = closeResult || null;
  error.phase = phase || null;
  return error;
}

function findRecommendRefreshErrorDiagnostic(refreshAttempt) {
  if (!refreshAttempt || typeof refreshAttempt !== "object") return null;
  if (refreshAttempt.error_diagnostic) return refreshAttempt.error_diagnostic;
  const candidates = [
    ...(refreshAttempt.attempts || []),
    ...(refreshAttempt.current_city_only_attempts || []),
    ...(refreshAttempt.filter_reapply_attempts || []),
    ...(refreshAttempt.job_selection_attempts || [])
  ].reverse();
  for (const attempt of candidates) {
    if (attempt?.error_diagnostic) return attempt.error_diagnostic;
    const nestedCityAttempts = (attempt?.current_city_only_attempts || []).slice().reverse();
    for (const cityAttempt of nestedCityAttempts) {
      if (cityAttempt?.error_diagnostic) return cityAttempt.error_diagnostic;
    }
  }
  return null;
}

function attachRecommendRefreshErrorDiagnostic(error, refreshAttempt) {
  const diagnostic = findRecommendRefreshErrorDiagnostic(refreshAttempt);
  if (!error || !diagnostic) return error;
  error.error_diagnostic = diagnostic;
  for (const key of [
    "cdp_method",
    "cdp_at",
    "cdp_node_id",
    "cdp_backend_node_id",
    "cdp_search_id",
    "cdp_param_keys"
  ]) {
    if (diagnostic[key] !== undefined && error[key] === undefined) {
      error[key] = diagnostic[key];
    }
  }
  return error;
}

export function createRecommendRefreshFailureError(refreshAttempt, {
  listEndReason = "",
  targetCount = 0,
  passedCount = 0
} = {}) {
  const reason = refreshAttempt?.reason || "refresh_failed";
  const detail = refreshAttempt?.error ? `: ${refreshAttempt.error}` : "";
  const error = new Error(`Recommend refresh failed before target was reached (${reason}${detail})`);
  error.code = "RECOMMEND_END_REFRESH_FAILED";
  error.refresh_attempt = refreshAttempt || null;
  error.list_end_reason = listEndReason || null;
  error.target_count = targetCount;
  error.passed_count = passedCount;
  return attachRecommendRefreshErrorDiagnostic(error, refreshAttempt);
}

export function isRecoverableImageCaptureError(error) {
  if (isRecoverableImageCaptureWorkflowError(error)) return true;
  if (isStaleRecommendNodeError(error)) return true;
  if (error?.code === "IMAGE_CAPTURE_TARGET_UNAVAILABLE") return true;
  return /Image fallback capture timed out/i.test(String(error?.message || error || ""));
}

export function shouldFailClosedRecommendImageAcquisition(detailResult = null) {
  return isFailedClosedImageAcquisition({
    source: detailResult?.cv_acquisition?.source,
    imageEvidence: detailResult?.image_evidence
  });
}

function collectPartialImageEvidencePaths(basePath = "", extension = "jpg", maxCount = 12) {
  const resolved = String(basePath || "").trim();
  if (!resolved) return [];
  const parsed = path.parse(resolved);
  const ext = parsed.ext || `.${String(extension || "jpg").replace(/^\./, "") || "jpg"}`;
  const files = [];
  for (let index = 0; index < Math.max(1, Number(maxCount) || 1); index += 1) {
    const page = String(index + 1).padStart(2, "0");
    const candidatePath = path.join(parsed.dir, `${parsed.name}-page-${page}${ext}`);
    if (fs.existsSync(candidatePath)) files.push(candidatePath);
  }
  return files;
}

export function createRecoverableImageCaptureEvidence(error, {
  elapsedMs = 0,
  filePath = "",
  extension = "jpg",
  maxScreenshots = DEFAULT_MAX_IMAGE_PAGES
} = {}) {
  const filePaths = collectPartialImageEvidencePaths(filePath, extension, maxScreenshots);
  return {
    schema_version: 1,
    ok: false,
    source: "image-scroll-sequence",
    elapsed_ms: Math.max(0, Math.round(Number(error?.elapsed_ms ?? elapsedMs) || 0)),
    capture_count: filePaths.length,
    screenshot_count: filePaths.length,
    unique_screenshot_count: filePaths.length,
    dropped_duplicate_count: 0,
    total_byte_length: 0,
    original_total_byte_length: 0,
    llm_screenshot_count: 0,
    llm_total_byte_length: 0,
    llm_original_total_byte_length: 0,
    llm_composition_error: null,
    error_code: error?.code || (isStaleRecommendNodeError(error) ? "IMAGE_CAPTURE_STALE_NODE" : "IMAGE_CAPTURE_FAILED"),
    error: error?.message || String(error || "Image capture failed"),
    file_paths: filePaths,
    llm_file_paths: []
  };
}

function createImageCaptureFailureScreening(candidate, error) {
  return {
    status: "fail",
    passed: false,
    score: 0,
    reasons: ["image_capture_failed"],
    error: compactError(error, "IMAGE_CAPTURE_FAILED"),
    candidate
  };
}

export function isRecoverableRecommendDetailError(error) {
  if (
    isCandidateLocalRecommendPostClickBindingTimeout(error)
    || isCandidateLocalRecommendPostCardClickError(error)
    || isRecommendScreeningIdentityMismatchError(error)
  ) return true;
  if (
    error?.recommend_input_dispatched === true
    && error?.recommend_click_negative_outcome_observed !== true
  ) return false;
  return isRecommendPreClickStaleNoActionError(error)
    || isStaleRecommendNodeError(error)
    || isRecommendDetailOpenMissError(error)
    || isRecommendDetailCandidateBindingError(error);
}

export function isCandidateLocalRecommendPostCardClickError(error) {
  const stage = String(error?.recommend_post_input_stage || "").trim();
  return Boolean(
    error?.recommend_input_dispatched === true
    && stage.startsWith("post_card_click_")
  );
}

export function isCandidateLocalRecommendPostClickBindingTimeout(error) {
  const binding = error?.detail_candidate_binding || null;
  const clickAttempts = Array.isArray(error?.click_attempts) ? error.click_attempts : [];
  const dispatchedAttempts = clickAttempts.filter(
    (attempt) => attempt?.input_dispatched === true
  );
  return Boolean(
    isRecommendDetailCandidateBindingError(error)
    && error?.recommend_clean_pre_action_detail_binding_timeout === true
    && error?.recommend_click_dispatched === true
    && error?.recommend_input_dispatched === true
    && error?.recommend_post_input_outcome_unknown === false
    && error?.recommend_post_input_stage === "post_card_click_binding"
    && binding?.reason === "detail_binding_readiness_timeout"
    && binding?.readiness?.exhausted === true
    && binding?.readiness?.terminal === false
    && binding?.readiness?.last_error == null
    && dispatchedAttempts.length === 1
    && dispatchedAttempts[0]?.outcome === "detail"
  );
}

export function getRecommendDetailFailureDisposition(error) {
  if (isCandidateLocalRecommendPostClickBindingTimeout(error)) {
    return {
      recoverable: true,
      candidate_local: true,
      context_recovery: false,
      allow_post_action: false,
      reason: "detail_binding_readiness_timeout_failed_closed"
    };
  }
  if (isCandidateLocalRecommendPostCardClickError(error)) {
    return {
      recoverable: true,
      candidate_local: true,
      context_recovery: false,
      allow_post_action: false,
      reason: "detail_card_click_uncertain_candidate_quarantined"
    };
  }
  if (isRecommendScreeningIdentityMismatchError(error)) {
    return {
      recoverable: true,
      candidate_local: true,
      context_recovery: false,
      allow_post_action: false,
      reason: "screening_identity_mismatch_candidate_quarantined"
    };
  }
  if (
    error?.recommend_input_dispatched === true
    && error?.recommend_click_negative_outcome_observed !== true
  ) {
    return {
      recoverable: false,
      candidate_local: false,
      context_recovery: false,
      allow_post_action: false,
      reason: "post_input_detail_outcome_unknown_terminal"
    };
  }
  if (isRecommendDetailCandidateBindingError(error)) {
    return {
      recoverable: true,
      candidate_local: true,
      context_recovery: false,
      allow_post_action: false,
      reason: "candidate_binding_failed_closed"
    };
  }
  if (
    isRecommendPreClickStaleNoActionError(error)
    && error?.recommend_pre_click_retry_exhausted === true
    && error?.recommend_pre_click_reacquire_failed !== true
    && error?.recommend_pre_click_retry?.candidate_local_exhaustion === true
  ) {
    return {
      recoverable: true,
      candidate_local: true,
      context_recovery: false,
      allow_post_action: false,
      reason: "pre_click_stale_no_action_failed_closed"
    };
  }
  if (isStaleRecommendNodeError(error) || isRecommendDetailOpenMissError(error)) {
    return {
      recoverable: true,
      candidate_local: false,
      context_recovery: true,
      allow_post_action: false,
      reason: "detail_context_recovery_required"
    };
  }
  return {
    recoverable: false,
    candidate_local: false,
    context_recovery: false,
    allow_post_action: false,
    reason: "fatal_detail_error"
  };
}

function compactRecoverableDetailError(error) {
  const compact = compactError(
    error,
    isRecommendPreClickStaleNoActionError(error)
      && error?.recommend_pre_click_retry_exhausted === true
      ? "RECOMMEND_PRE_CLICK_STALE_NO_ACTION"
      : isStaleRecommendNodeError(error)
      ? "DETAIL_STALE_NODE"
      : isRecommendDetailCandidateBindingError(error)
      ? "RECOMMEND_DETAIL_CANDIDATE_MISMATCH"
      : "DETAIL_OPEN_FAILED"
  );
  if (error?.detail_candidate_binding) {
    compact.candidate_binding = compactRecommendDetailCandidateBinding(error.detail_candidate_binding);
  }
  return compact;
}

export function preserveRecommendDetailCandidateBindingForRecovery(detailResult, binding = null) {
  const preservedBinding = binding || null;
  if (detailResult && typeof detailResult === "object") {
    detailResult.candidate_binding = preservedBinding;
  }
  return preservedBinding;
}

export function reserveRecommendDetailRecovery(recoveryCounts, candidateKey, limit = 1) {
  const boundedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const currentCount = Number(recoveryCounts?.get?.(candidateKey) || 0);
  if (currentCount >= boundedLimit) {
    return {
      allowed: false,
      current_count: currentCount,
      next_count: currentCount,
      limit: boundedLimit
    };
  }
  recoveryCounts.set(candidateKey, currentCount + 1);
  return {
    allowed: true,
    current_count: currentCount,
    next_count: currentCount + 1,
    limit: boundedLimit
  };
}

function createRecoverableDetailFailureScreening(candidate, error) {
  return {
    status: "fail",
    passed: false,
    score: 0,
    reasons: isRecommendPreClickStaleNoActionError(error)
      && error?.recommend_pre_click_retry_exhausted === true
      && error?.recommend_pre_click_reacquire_failed !== true
      ? ["detail_open_failed", "pre_click_stale_no_action"]
      : isStaleRecommendNodeError(error)
      ? ["detail_open_failed", "stale_node"]
      : isRecommendDetailCandidateBindingError(error)
      ? ["detail_open_failed", "detail_candidate_mismatch"]
      : isRecommendDetailOpenMissError(error)
      ? ["detail_open_failed", "detail_open_miss"]
      : ["detail_open_failed"],
    error: compactRecoverableDetailError(error),
    candidate
  };
}

function createRecentColleagueContactSkipScreening(candidate, colleagueContact) {
  const matched = colleagueContact?.matched_row || null;
  return {
    status: "skip",
    passed: false,
    score: 0,
    reasons: ["skipped_recent_colleague_contact"],
    reason: matched?.text || "Candidate has recent colleague contact history",
    matched_colleague_contact: matched,
    candidate
  };
}

export function isVerifiedColleagueContactInspection(colleagueContact) {
  const rows = Array.isArray(colleagueContact?.rows) ? colleagueContact.rows : [];
  const rowCount = Number(colleagueContact?.row_count);
  const sectionNodeId = Number(colleagueContact?.section_node_id);
  const sectionBackendNodeId = Number(colleagueContact?.section_backend_node_id);
  const reason = colleagueContact?.reason;
  if (reason === "panel_missing") {
    const absenceProbe = colleagueContact?.absence_probe;
    const backendNodeIds = Array.isArray(absenceProbe?.scope_backend_node_ids)
      ? absenceProbe.scope_backend_node_ids
      : [];
    return Boolean(
      colleagueContact?.checked === true
      && colleagueContact?.panel_found === false
      && colleagueContact?.recent === false
      && colleagueContact?.indeterminate === false
      && absenceProbe?.verified === true
      && absenceProbe?.selector === ".colleague-collaboration"
      && Number.isInteger(Number(absenceProbe?.scope_count))
      && Number(absenceProbe.scope_count) > 0
      && Number.isInteger(Number(absenceProbe?.stable_scope_count))
      && Number(absenceProbe.stable_scope_count) > 0
      && Number(absenceProbe.stable_scope_count) === backendNodeIds.length
      && backendNodeIds.every((backendNodeId) => (
        Number.isInteger(Number(backendNodeId)) && Number(backendNodeId) > 0
      ))
      && Number.isInteger(Number(absenceProbe?.poll_count))
      && Number(absenceProbe.poll_count) >= 2
      && Number(absenceProbe?.elapsed_ms) >= Number(absenceProbe?.timeout_ms)
      && absenceProbe?.full_window_elapsed === true
      && Number(absenceProbe?.query_error_count) === 0
      && absenceProbe?.scope_binding_lost === false
      && rows.length === 0
    );
  }
  const scrollProbe = colleagueContact?.scroll_probe;
  const scrollPositions = Array.isArray(scrollProbe?.positions) ? scrollProbe.positions : [];
  const requestedScrolls = Number(scrollProbe?.scrolls_requested);
  const completedScrolls = Number(scrollProbe?.scrolls_completed);
  const endProof = scrollProbe?.end_proof;
  const seenRowTexts = new Set();
  let priorRowSignature = null;
  let priorRowLayoutSignature = null;
  let recomputedStableSignatureCount = 0;
  let recomputedEffectiveScrollCount = 0;
  const scrollPositionsVerified = scrollPositions.every((position, index) => {
    const rowTexts = Array.isArray(position?.row_texts)
      ? position.row_texts.map((text) => String(text || "")).sort()
      : [];
    const rowIdentityKeys = Array.isArray(position?.row_identity_keys)
      ? position.row_identity_keys.map((key) => String(key || "")).sort()
      : [];
    const rowBackendNodeIds = Array.isArray(position?.row_backend_node_ids)
      ? position.row_backend_node_ids.map(Number)
      : [];
    const orderedRowLayout = Array.isArray(position?.ordered_row_layout)
      ? position.ordered_row_layout.map((row) => ({
          backend_node_id: Number(row?.backend_node_id),
          text: String(row?.text || ""),
          x: Number(row?.x),
          y: Number(row?.y),
          width: Number(row?.width),
          height: Number(row?.height)
        }))
      : [];
    const recomputedOrderedRowLayout = orderedRowLayout.slice().sort((left, right) => (
      left.y - right.y
      || left.x - right.x
      || left.backend_node_id - right.backend_node_id
    ));
    const orderedRowLayoutKeys = recomputedOrderedRowLayout.map((row) => (
      `${row.text}:${row.x}:${row.y}:${row.width}:${row.height}`
    ));
    const persistedOrderedRowLayoutKeys = Array.isArray(position?.ordered_row_layout_keys)
      ? position.ordered_row_layout_keys.map((key) => String(key || ""))
      : [];
    const expectedNewRowTexts = rowTexts.filter((text) => !seenRowTexts.has(text));
    const rowSignature = JSON.stringify(rowIdentityKeys);
    const rowLayoutSignature = JSON.stringify(orderedRowLayoutKeys);
    const expectedScrollEffectObserved = Boolean(
      index > 0
      && rowLayoutSignature !== priorRowLayoutSignature
    );
    if (expectedScrollEffectObserved) recomputedEffectiveScrollCount += 1;
    if (
      index > 0
      && rowSignature === priorRowSignature
      && expectedNewRowTexts.length === 0
    ) {
      recomputedStableSignatureCount += 1;
    } else {
      recomputedStableSignatureCount = 0;
    }
    const verified = Boolean(
      Number(position?.position_index) === index
      && Number(position?.sampled_after_scroll_count) === index
      && Number(position?.row_count) > 0
      && rowTexts.length === Number(position?.row_count)
      && new Set(rowTexts).size === rowTexts.length
      && rowIdentityKeys.length === Number(position?.row_count)
      && new Set(rowIdentityKeys).size === rowIdentityKeys.length
      && rowBackendNodeIds.length === Number(position?.row_count)
      && rowBackendNodeIds.every((backendNodeId) => Number.isInteger(backendNodeId) && backendNodeId > 0)
      && position?.row_signature === rowSignature
      && orderedRowLayout.length === Number(position?.row_count)
      && orderedRowLayout.every((row) => (
        Number.isInteger(row.backend_node_id)
        && row.backend_node_id > 0
        && rowBackendNodeIds.includes(row.backend_node_id)
        && row.text.length > 0
        && rowTexts.includes(row.text)
        && [row.x, row.y, row.width, row.height].every(Number.isFinite)
        && row.width > 0
        && row.height > 0
      ))
      && JSON.stringify(orderedRowLayout) === JSON.stringify(recomputedOrderedRowLayout)
      && orderedRowLayoutKeys.length === Number(position?.row_count)
      && new Set(orderedRowLayoutKeys).size === orderedRowLayoutKeys.length
      && JSON.stringify(persistedOrderedRowLayoutKeys) === JSON.stringify(orderedRowLayoutKeys)
      && position?.row_layout_signature === rowLayoutSignature
      && position?.scroll_effect_observed === expectedScrollEffectObserved
      && Number(position?.cumulative_effective_scroll_count) === recomputedEffectiveScrollCount
      && Number(position?.new_row_count) === expectedNewRowTexts.length
      && JSON.stringify(
        Array.isArray(position?.new_row_texts)
          ? position.new_row_texts.map((text) => String(text || "")).sort()
          : []
      ) === JSON.stringify([...expectedNewRowTexts].sort())
      && Number(position?.stable_signature_count) === recomputedStableSignatureCount
      && Number(position?.unreadable_row_count) === 0
      && position?.binding_before_verified === true
      && position?.binding_after_verified === true
    );
    for (const text of rowTexts) seenRowTexts.add(text);
    priorRowSignature = rowSignature;
    priorRowLayoutSignature = rowLayoutSignature;
    return verified;
  });
  const lastScrollPosition = scrollPositions[scrollPositions.length - 1] || null;
  const exactEndProofVerified = Boolean(
    endProof?.verified === true
    && endProof?.method === "effective_scroll_then_repeated_identical_rows"
    && Number(endProof?.stable_samples_required) === 2
    && Number(endProof?.stable_samples_observed) >= 2
    && Number(endProof?.additional_wheel_attempts_without_change) >= 2
    && endProof?.effective_scroll_observed === true
    && Number(endProof?.effective_scroll_count) === recomputedEffectiveScrollCount
    && recomputedEffectiveScrollCount > 0
    && Number(endProof?.end_position_index) === scrollPositions.length - 1
    && Number(endProof?.end_scroll_count) === completedScrolls
    && endProof?.row_signature === lastScrollPosition?.row_signature
    && Number(lastScrollPosition?.stable_signature_count) >= 2
    && scrollProbe?.cap_reached_without_end === false
  );
  const noRecentScanVerified = reason !== "no_recent_colleague_contact" || Boolean(
    scrollProbe?.completed === true
    && scrollProbe?.coverage_verified === true
    && Number.isInteger(requestedScrolls)
    && requestedScrolls >= 2
    && requestedScrolls <= 48
    && Number.isInteger(completedScrolls)
    && completedScrolls >= 2
    && completedScrolls <= requestedScrolls
    && Number(scrollProbe?.position_count) === completedScrolls + 1
    && scrollPositions.length === completedScrolls + 1
    && Number(scrollProbe?.step_delta_y) > 0
    && Number(scrollProbe?.overlap_ratio) > 0
    && Number(scrollProbe?.overlap_ratio) < 1
    && Number(scrollProbe?.effective_scroll_count) === recomputedEffectiveScrollCount
    && recomputedEffectiveScrollCount > 0
    && scrollPositionsVerified
    && exactEndProofVerified
  );
  const semanticResultMatchesRows = reason === "recent_colleague_contact_found"
    ? colleagueContact?.recent === true && rows.some((row) => row?.within_window === true)
    : reason === "no_recent_colleague_contact"
      ? colleagueContact?.recent === false && rows.every((row) => row?.within_window === false)
      : false;
  return Boolean(
    colleagueContact?.checked === true
    && colleagueContact?.panel_found === true
    && colleagueContact?.indeterminate !== true
    && typeof colleagueContact?.recent === "boolean"
    && semanticResultMatchesRows
    && noRecentScanVerified
    && String(colleagueContact?.selected_tab_text || "").replace(/\s+/g, "").trim() === "同事沟通进度"
    && colleagueContact?.selected_tab_count === 1
    && colleagueContact?.pane_binding_verified === true
    && colleagueContact?.binding?.verified === true
    && colleagueContact?.binding?.selection_reverified_after_rows === true
    && colleagueContact?.binding?.row_scope === "selected_section_descendants"
    && Number.isInteger(sectionNodeId)
    && sectionNodeId > 0
    && Number.isInteger(sectionBackendNodeId)
    && sectionBackendNodeId > 0
    && Number.isInteger(rowCount)
    && rowCount > 0
    && rows.length === rowCount
    && (
      reason !== "no_recent_colleague_contact"
      || (
        seenRowTexts.size === rowCount
        && rows.every((row) => seenRowTexts.has(String(row?.text || "")))
      )
    )
    && rows.every((row) => (
      Boolean(String(row?.text || "").trim())
      && Boolean(row?.parsed_date)
      && typeof row?.within_window === "boolean"
      && row?.visible === true
      && Number(row?.section_node_id) === sectionNodeId
      && Number(row?.section_backend_node_id) === sectionBackendNodeId
      && Number.isInteger(Number(row?.backend_node_id))
      && Number(row?.backend_node_id) > 0
      && (
        reason !== "no_recent_colleague_contact"
        || (
          Array.isArray(row?.observed_at_positions)
          && row.observed_at_positions.length > 0
          && row.observed_at_positions.every((position) => (
            Number.isInteger(Number(position))
            && Number(position) >= 0
            && Number(position) <= completedScrolls
          ))
        )
      )
    ))
  );
}

export function getColleagueContactSkipReason(colleagueContact) {
  if (!isVerifiedColleagueContactInspection(colleagueContact)) {
    return "colleague_contact_unverified";
  }
  return colleagueContact?.recent === true ? "skipped_recent_colleague_contact" : "";
}

export async function bindRecommendColleagueContactInspectionResult(
  colleagueContact,
  { reverifyCandidateBinding } = {}
) {
  if (typeof reverifyCandidateBinding !== "function") {
    const error = new Error("Recommend colleague-contact result requires fresh candidate binding verification");
    error.code = "RECOMMEND_DETAIL_CANDIDATE_BINDING_REQUIRED";
    throw error;
  }
  const candidateBinding = await reverifyCandidateBinding(
    "after_colleague_contact_before_result"
  );
  if (candidateBinding?.verified !== true) {
    throw createRecommendDetailCandidateBindingError(candidateBinding);
  }
  return {
    candidate_binding: candidateBinding,
    skip_reason: getColleagueContactSkipReason(colleagueContact)
  };
}

export function resolveEffectiveRecommendDetailLimit({
  detailLimit = Number.POSITIVE_INFINITY,
  postActionEnabled = false,
  requireColleagueContactInspection = false
} = {}) {
  if (postActionEnabled || requireColleagueContactInspection) return Number.POSITIVE_INFINITY;
  return detailLimit;
}

function createUnverifiedColleagueContactSkipScreening(candidate, colleagueContact) {
  return {
    status: "skip",
    passed: false,
    score: 0,
    reasons: ["colleague_contact_unverified"],
    reason: "Candidate colleague-contact status could not be verified",
    colleague_contact: colleagueContact,
    candidate
  };
}

export function classifyRecommendWorkflowCompletion({
  passedCount = 0,
  targetCount = 0,
  listEndReason = ""
} = {}) {
  const passed = Math.max(0, Number(passedCount) || 0);
  const target = Math.max(1, Number(targetCount) || 1);
  const reason = String(listEndReason || "").trim();
  const targetReached = passed >= target;
  const sourceExhausted = reason === "filtered_list_exhausted";
  const postActionStopped = Boolean(
    reason
    && (
      reason === "greet_credits_exhausted"
      || reason === "post_action_stop"
      || /^(?:greet|favorite|post_action).*(?:stop|failed|exhausted)/i.test(reason)
    )
  );
  const completionReason = postActionStopped
    ? "post_action_stopped"
    : targetReached
      ? "target_reached"
      : sourceExhausted
        ? "source_exhausted"
        : "source_unverified_underfill";
  return {
    completion_reason: completionReason,
    target_reached: targetReached,
    source_exhausted: sourceExhausted,
    source_exhaustion_verified: sourceExhausted,
    source_unverified_underfill: completionReason === "source_unverified_underfill",
    post_action_stopped: postActionStopped,
    clean_completion: !postActionStopped && (targetReached || sourceExhausted)
  };
}

export function createRecommendSourceUnverifiedUnderfillError(summary = null) {
  if (summary?.source_unverified_underfill !== true) return null;
  const passed = Math.max(0, Number(summary?.passed) || 0);
  const target = Math.max(1, Number(summary?.target_count) || 1);
  const error = new Error(
    `Recommend source ended without verified exhaustion before the target was reached (${passed}/${target})`
  );
  error.code = "RECOMMEND_SOURCE_UNVERIFIED_UNDERFILL";
  error.phase = "recommend:completion";
  error.retryable = true;
  error.run_summary = summary;
  return error;
}

export async function runRecommendWorkflow({
  client,
  targetUrl = "",
  criteria = "",
  jobLabel = "",
  pageScope = "recommend",
  fallbackPageScope = "recommend",
  filter = {},
  maxCandidates = 5,
  detailLimit,
  closeDetail = true,
  delayMs = 0,
  cardTimeoutMs = 10000,
  maxImagePages = DEFAULT_MAX_IMAGE_PAGES,
  imageWheelDeltaY = 650,
  cvAcquisitionMode = "unknown",
  listMaxScrolls = 20,
  listStableSignatureLimit = 5,
  listWheelDeltaY = 850,
  listSettleMs = 2200,
  listFallbackPoint = null,
  refreshOnEnd = true,
  maxRefreshRounds = 2,
  refreshButtonSettleMs = 8000,
  refreshReloadSettleMs = 8000,
  postAction = "none",
  maxGreetCount = null,
  executePostAction = true,
  actionTimeoutMs = 8000,
  actionIntervalMs = 500,
  actionAfterClickDelayMs = 900,
  actionJournal = null,
  actionJournalScope = "boss-recommend:default",
  reverifyActionJournalScope = null,
  screeningMode = "llm",
  llmConfig = null,
  llmTimeoutMs = 120000,
  llmImageLimit = 8,
  llmImageDetail = "high",
  imageOutputDir = "",
  candidateResultJournalDir = "",
  humanRestEnabled = false,
  humanBehavior = null,
  skipRecentColleagueContacted = true,
  colleagueContactWindowDays = 14,
  debugTestMode = false,
  debugForceListEndAfterProcessed = null,
  debugForceContextRecoveryAfterProcessed = null,
  debugForceCdpReconnectAfterProcessed = null
} = {}, runControl) {
  if (!client) throw new Error("runRecommendWorkflow requires a guarded CDP client");
  const debugBoundary = createRecommendDebugBoundaryController({
    debugTestMode,
    debugForceListEndAfterProcessed,
    debugForceContextRecoveryAfterProcessed,
    debugForceCdpReconnectAfterProcessed
  });
  const effectiveHumanBehavior = normalizeHumanBehaviorOptions(humanBehavior, {
    legacyEnabled: humanRestEnabled === true || llmConfig?.humanRestEnabled === true
  });
  const effectiveHumanRestEnabled = effectiveHumanBehavior.restEnabled;
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
  const normalizedFilter = normalizeFilter(filter);
  const normalizedPostAction = normalizeRecommendPostAction(postAction) || "none";
  const requestedPageScope = normalizeRecommendPageScope(pageScope) || "recommend";
  const normalizedFallbackPageScope = normalizeRecommendPageScope(fallbackPageScope) || "recommend";
  const normalizedScreeningMode = normalizeScreeningMode(screeningMode);
  const useLlmScreening = normalizedScreeningMode !== "deterministic";
  const postActionEnabled = normalizedPostAction !== "none";
  const screeningOnlyBindingEnabled = Boolean(
    normalizedPostAction === "none"
    && executePostAction === false
  );
  const effectiveActionJournal = postActionEnabled && executePostAction
    ? actionJournal || createRecommendGreetingActionJournal()
    : actionJournal;
  const shouldSkipRecentColleagueContacted = skipRecentColleagueContacted !== false;
  const normalizedColleagueContactWindowDays = Math.max(1, Number(colleagueContactWindowDays) || 14);
  const colleagueContactReferenceDate = new Date();
  const targetPassCount = Math.max(1, Number(maxCandidates) || 1);
  const effectiveMaxRefreshRounds = normalizeRecommendRefreshRoundLimit(maxRefreshRounds);
  const detailCountLimit = detailLimit == null ? Number.POSITIVE_INFINITY : Math.max(0, Number(detailLimit) || 0);
  const effectiveDetailLimit = resolveEffectiveRecommendDetailLimit({
    detailLimit: detailCountLimit,
    postActionEnabled,
    requireColleagueContactInspection: shouldSkipRecentColleagueContacted
  });
  const networkRecorder = effectiveDetailLimit > 0
    ? createRecommendDetailNetworkRecorder(client)
    : null;
  const cvAcquisitionState = createCvAcquisitionState({ mode: cvAcquisitionMode });
  const listState = createInfiniteListState({
    domain: "recommend",
    listName: "recommend-candidates"
  });
  const viewportGuard = createViewportRunGuard({
    client,
    domain: "recommend",
    root: "frame",
    frameOwnerRoot: "frameOwner",
    runControl,
    getRoots: getRecommendRoots
  });
  async function ensureRecommendViewport(rootState, phase) {
    const result = await viewportGuard.ensure(rootState, { phase });
    return result.rootState || rootState;
  }
  const results = [];
  const candidateResultJournal = candidateResultJournalDir
    ? createCandidateResultJournal({
        runDir: path.resolve(candidateResultJournalDir),
        runId: runControl.runId
      })
    : null;
  const candidateResultJournalInitialSnapshot = candidateResultJournal?.read() || null;
  if (candidateResultJournalInitialSnapshot?.committed_count > 0) {
    const error = new Error(
      `Candidate result journal for run ${runControl.runId} is not empty; refusing to mix run histories`
    );
    error.code = "CANDIDATE_RESULT_JOURNAL_NOT_EMPTY";
    throw error;
  }
  const resultStatusTotals = countRecommendResultStatuses([], { greetCount: 0 });
  function currentResultStatusCounts() {
    return {
      ...resultStatusTotals,
      greet_count: greetCount
    };
  }
  function currentResultCount() {
    return resultStatusTotals.processed;
  }
  function currentPassedCount() {
    return resultStatusTotals.passed;
  }
  function retainCommittedResult(result) {
    const delta = countRecommendResultStatuses([result], { greetCount: 0 });
    for (const [key, value] of Object.entries(delta)) {
      if (key === "greet_count" || !Number.isFinite(value)) continue;
      resultStatusTotals[key] = (Number(resultStatusTotals[key]) || 0) + value;
    }
    results.push(result);
    if (
      candidateResultJournal
      && results.length > RECOMMEND_RESULT_MEMORY_TAIL_LIMIT
    ) {
      results.splice(0, results.length - RECOMMEND_RESULT_MEMORY_TAIL_LIMIT);
    }
    return result;
  }
  const refreshAttempts = [];
  let refreshAttemptCount = 0;
  function retainRefreshAttempt(attempt) {
    refreshAttemptCount += 1;
    refreshAttempts.push(attempt);
    if (refreshAttempts.length > RECOMMEND_REFRESH_DIAGNOSTIC_TAIL_LIMIT) {
      refreshAttempts.splice(
        0,
        refreshAttempts.length - RECOMMEND_REFRESH_DIAGNOSTIC_TAIL_LIMIT
      );
    }
    return attempt;
  }
  let refreshRounds = 0;
  let contextRecoveryAttempts = 0;
  let contextRecoveryConsecutiveFailures = 0;
  let greetCount = 0;
  const candidateRecoveryCounts = new Map();
  const imageCaptureWorkflowRetries = createImageCaptureWorkflowRetryTracker();
  let jobSelection = null;
  let pageScopeSelection = null;
  let currentCityOnlyResult = null;
  let filterResult = null;
  let rootState = null;
  let cardNodeIds = [];
  let listEndReason = "";
  let lastHumanEvent = null;
  let debugForceReconnectPending = null;
  let listReadStaleRecoveryAttempts = 0;
  let listReadStaleRecoveryApplied = 0;
  let listReadStaleRecoveries = 0;
  let lastListReadStaleDiagnostic = null;
  let lastListReadRecoveryMode = null;
  let consecutiveListReadFailures = 0;
  let technicalRecoveryAttemptsWithoutProgress = 0;
  const listReadStaleDiagnostics = [];
  function retainListReadStaleDiagnostic(diagnostic) {
    listReadStaleDiagnostics.push(diagnostic);
    if (listReadStaleDiagnostics.length > RECOMMEND_STALE_DIAGNOSTIC_TAIL_LIMIT) {
      listReadStaleDiagnostics.splice(
        0,
        listReadStaleDiagnostics.length - RECOMMEND_STALE_DIAGNOSTIC_TAIL_LIMIT
      );
    }
    return diagnostic;
  }
  let domStaleEventCount = 0;
  let currentDomOperation = "recommend:initialize";
  let currentDetailCandidateBinding = null;
  const domLifecycleTimeline = [];
  const domStaleForensics = [];
  const listFallbackResolver = listFallbackPoint || (async ({ items = [] } = {}) => resolveInfiniteListFallbackPoint(client, {
    rootNodeId: rootState?.iframe?.documentNodeId,
    containerSelectors: RECOMMEND_LIST_CONTAINER_SELECTORS,
    itemNodeIds: items.map((item) => item.node_id).filter(Boolean),
    itemSelectors: [RECOMMEND_CARD_SELECTOR],
    viewportPoint: { xRatio: 0.28, yRatio: 0.5 },
    validateViewportPoint: true
  }));

  function candidateResultJournalCheckpointPatch() {
    if (!candidateResultJournal) return { results };
    const journal = candidateResultJournal.checkpointTail({
      maxEntries: 20,
      maxBytes: 64 * 1024
    });
    return {
      results_count: journal.committed_count,
      results_truncated: true,
      candidate_result_journal: {
        ...journal,
        superseded_record_count: journal.duplicate_count
      }
    };
  }

  async function persistCandidateResult(result, {
    resultIndex = result?.index,
    candidateKey = result?.candidate_key
  } = {}) {
    if (!candidateResultJournal) return null;
    const delays = [0, 100, 500, 1500];
    let lastError = null;
    for (const delay of delays) {
      if (delay > 0) await sleep(delay);
      try {
        const record = candidateResultJournal.append({
          resultIndex,
          candidateKey,
          result
        });
        return record;
      } catch (error) {
        lastError = error;
      }
    }
    const error = new Error(
      `Candidate result journal persistence failed after bounded retries: ${lastError?.message || lastError}`
    );
    error.code = "CANDIDATE_RESULT_JOURNAL_PERSIST_FAILED";
    error.phase = "recommend:candidate-result-persist";
    error.cause = lastError;
    throw error;
  }

  function currentConnectionEpoch() {
    const epoch = Number(client?.__connectionEpoch);
    return Number.isInteger(epoch) && epoch > 0 ? epoch : null;
  }

  function compactLifecycleUrl(value = "") {
    const text = String(value || "").trim();
    if (!text) return null;
    try {
      const parsed = new URL(text);
      return `${parsed.origin}${parsed.pathname}`.slice(0, 500);
    } catch {
      return text.split(/[?#]/, 1)[0].slice(0, 500) || null;
    }
  }

  function recordDomLifecycleEvent(type, payload = {}) {
    const frame = payload?.frame || payload || {};
    const event = {
      at: new Date().toISOString(),
      type: String(type || "unknown").slice(0, 100),
      operation: currentDomOperation,
      connection_epoch: currentConnectionEpoch(),
      frame_id: String(frame?.id || payload?.frameId || "").slice(0, 200) || null,
      parent_frame_id: String(frame?.parentId || "").slice(0, 200) || null,
      loader_id: String(frame?.loaderId || "").slice(0, 200) || null,
      url: compactLifecycleUrl(frame?.url || "")
    };
    domLifecycleTimeline.push(event);
    if (domLifecycleTimeline.length > 40) domLifecycleTimeline.splice(0, domLifecycleTimeline.length - 40);
    return event;
  }

  function subscribeDomLifecycleEvents() {
    const subscriptions = [
      [client?.DOM, "documentUpdated", "DOM.documentUpdated"],
      [client?.Page, "frameNavigated", "Page.frameNavigated"],
      [client?.Page, "frameDetached", "Page.frameDetached"],
      [client?.Page, "frameStartedLoading", "Page.frameStartedLoading"],
      [client?.Page, "frameStoppedLoading", "Page.frameStoppedLoading"]
    ];
    for (const [domain, eventName, label] of subscriptions) {
      if (typeof domain?.[eventName] !== "function") continue;
      try {
        domain[eventName]((payload = {}) => recordDomLifecycleEvent(label, payload));
      } catch {
        // Lifecycle observation is diagnostic-only and must not alter the run.
      }
    }
  }

  function checkpointDomStaleForensic(error, {
    phase = "",
    operation = currentDomOperation,
    detailStep = "",
    candidateIndex = null,
    candidateKey = "",
    cardNodeId = null
  } = {}) {
    if (!isStaleRecommendNodeError(error)) return null;
    domStaleEventCount += 1;
    const event = createRecommendDomStaleForensicEvent(error, {
      eventId: `recommend_dom_stale_${runControl?.runId || "run"}_${domStaleEventCount}`,
      phase,
      operation,
      detailStep,
      candidateIndex,
      candidateKey,
      cardNodeId,
      rootState,
      connectionEpoch: currentConnectionEpoch(),
      listState,
      counters: currentResultStatusCounts(),
      timeline: domLifecycleTimeline
    });
    domStaleForensics.push(event);
    if (domStaleForensics.length > 12) domStaleForensics.splice(0, domStaleForensics.length - 12);
    runControl.checkpoint({
      dom_stale_forensic: event,
      dom_stale_forensics: domStaleForensics.slice(),
      candidate_list: compactInfiniteListState(listState)
    });
    updateRecommendProgress({
      dom_stale_events: domStaleEventCount,
      last_dom_stale_phase: phase || null,
      last_dom_stale_operation: operation || null
    });
    return event;
  }

  function checkpointDomStaleRecovery(event, {
    status = "unknown",
    recoveryResult = null,
    recoveryError = null
  } = {}) {
    if (!event) return null;
    event.recovery = {
      status: String(status || "unknown").slice(0, 100),
      at: new Date().toISOString(),
      mode: String(recoveryResult?.recovery_mode || recoveryResult?.method || "").slice(0, 100) || null,
      escalated_from: String(recoveryResult?.escalated_from || "").slice(0, 100) || null,
      ok: recoveryResult?.ok === undefined ? null : Boolean(recoveryResult.ok),
      method: String(recoveryResult?.method || recoveryResult?.context_reapply?.method || "").slice(0, 100) || null,
      card_count: Number.isInteger(recoveryResult?.card_count)
        ? recoveryResult.card_count
        : Number.isInteger(recoveryResult?.root_reacquire?.card_count)
        ? recoveryResult.root_reacquire.card_count
        : Number.isInteger(recoveryResult?.context_reapply?.card_count)
        ? recoveryResult.context_reapply.card_count
        : null,
      error: recoveryError ? compactCdpFailureDiagnostic(recoveryError, {
        fallbackCode: "RECOMMEND_DOM_STALE_RECOVERY_FAILED",
        fallbackPhase: "recommend:recover-context"
      }) : null
    };
    event.post_recovery_roots = compactRecommendDomRootIdentity(rootState, currentConnectionEpoch());
    event.lifecycle_timeline = domLifecycleTimeline.slice(-20);
    runControl.checkpoint({
      dom_stale_forensic: event,
      dom_stale_forensics: domStaleForensics.slice(),
      candidate_list: compactInfiniteListState(listState)
    });
    return event;
  }

  subscribeDomLifecycleEvents();

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

  function updateRecommendProgress(extra = {}) {
    const counts = currentResultStatusCounts();
    const listSnapshot = compactInfiniteListState(listState);
    const humanRestState = humanRestController.getState();
    runControl.updateProgress({
      card_count: cardNodeIds.length,
      target_count: targetPassCount,
      target_count_semantics: "passed_candidates",
      ...counts,
      transient_recovered: counts.transient_recovered + listReadStaleRecoveries,
      screening_mode: normalizedScreeningMode,
      unique_seen: listSnapshot.seen_count,
      scroll_count: listSnapshot.scroll_count,
      refresh_rounds: refreshRounds,
      exhaustion_refresh_rounds: refreshRounds,
      consecutive_refresh_attempts_without_progress: refreshRounds,
      exhaustion_refresh_budget_scope: "run_lifetime",
      exhaustion_refresh_round_semantics: "source_exhaustion_recovery_cycle",
      exhaustion_refresh_budget_resets_on_candidate_progress: false,
      refresh_attempts: refreshAttemptCount,
      context_recoveries: contextRecoveryAttempts,
      context_recovery_consecutive_failures: contextRecoveryConsecutiveFailures,
      technical_recovery_attempts_without_progress: technicalRecoveryAttemptsWithoutProgress,
      technical_recovery_max_attempts: RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS,
      technical_recovery_budget_scope: "until_candidate_result_persisted",
      list_end_reason: listEndReason || null,
      viewport_checks: viewportGuard.getStats().checks,
      viewport_recoveries: viewportGuard.getStats().recoveries,
      human_behavior_enabled: effectiveHumanBehavior.enabled,
      human_behavior_profile: effectiveHumanBehavior.profile,
      human_rest_level: effectiveHumanBehavior.restLevel,
      human_rest_enabled: effectiveHumanRestEnabled,
      skip_recent_colleague_contacted: shouldSkipRecentColleagueContacted,
      colleague_contact_window_days: normalizedColleagueContactWindowDays,
      current_city_only_requested: normalizedFilter.currentCityOnly,
      current_city_only_effective: currentCityOnlyResult?.effective ?? null,
      current_city_only_unavailable: Boolean(currentCityOnlyResult?.unavailable),
      human_rest_count: humanRestState.rest_count,
      human_rest_ms: humanRestState.total_rest_ms,
      last_human_event: lastHumanEvent,
      debug_boundary_mode: debugBoundary.config.mode,
      debug_boundary_threshold: debugBoundary.config.threshold,
      debug_boundary_triggered: debugBoundary.getState().triggered,
      debug_boundary_trigger_count: debugBoundary.getState().trigger_count,
      list_read_stale_recovery_attempts: listReadStaleRecoveryAttempts,
      list_read_stale_recovery_applied: listReadStaleRecoveryApplied,
      list_read_stale_recoveries: listReadStaleRecoveries,
      last_list_read_recovery_mode: lastListReadRecoveryMode,
      last_list_read_stale_diagnostic: lastListReadStaleDiagnostic,
      ...extra
    });
  }

  function checkpointInProgressCandidate({
    index = currentResultCount(),
    candidateKey = "",
    cardNodeId = null,
    detailStep = "",
    error = null
  } = {}) {
    runControl.checkpoint({
      in_progress_candidate: {
        index,
        key: candidateKey,
        card_node_id: cardNodeId,
        detail_step: detailStep || null,
        candidate_binding: compactRecommendDetailCandidateBinding(currentDetailCandidateBinding),
        counters: currentResultStatusCounts(),
        error: compactError(error, "RECOMMEND_IN_PROGRESS_ERROR")
      },
      candidate_list: compactInfiniteListState(listState)
    });
  }

  async function closeRecommendBlockingPanelsForRun(phase = "cleanup") {
    const result = await closeRecommendBlockingPanels(client, {
      attemptsLimit: 2,
      rootState
    });
    if (!result?.closed) {
      throw createRecommendBlockingPanelCloseFailureError(result, phase);
    }
    return result;
  }

  async function assertRecommendRecoveryPageSafe(reason = "context_recovery") {
    const currentUrl = await getMainFrameUrl(client).catch(() => "");
    if (isBossSecurityVerificationUrl(currentUrl)) {
      throw makeBossSecurityVerificationRequiredError({
        url: currentUrl,
        is_security_verification: true
      }, `recommend:${reason}`);
    }
    const loginState = await detectBossLoginState(client, { currentUrl });
    if (loginState?.requires_login === true) {
      throw createBossLoginRequiredError({
        domain: "recommend",
        currentUrl: loginState.current_url || currentUrl,
        targetUrl: targetUrl || RECOMMEND_TARGET_URL,
        loginDetection: loginState
      });
    }
    return {
      current_url: currentUrl || null,
      login_state: loginState
    };
  }

  async function recoverRecommendContextOnce(reason = "context_recovery", error = null, {
    forceRecentNotView = true
  } = {}) {
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    const started = Date.now();
    runControl.setPhase("recommend:recover-context");
    contextRecoveryAttempts += 1;
    const effectiveForceRecentNotView = normalizedFilter.enabled && forceRecentNotView;
    const refreshResult = await refreshRecommendListAtEnd(client, {
      rootState,
      jobLabel,
      pageScope: pageScopeSelection?.effective_scope || requestedPageScope,
      fallbackPageScope: normalizedFallbackPageScope,
      filter: normalizedFilter,
      preferEndRefreshButton: false,
      forceNavigate: true,
      targetUrl: targetUrl || RECOMMEND_TARGET_URL,
      forceRecentNotView: effectiveForceRecentNotView,
      cardTimeoutMs,
      buttonSettleMs: refreshButtonSettleMs,
      reloadSettleMs: refreshReloadSettleMs
    });
    const verifiedExhaustion = isVerifiedRecommendRefreshCompletion(refreshResult);
    let blockingPanelClose = null;
    if (refreshResult.ok && !verifiedExhaustion) {
      blockingPanelClose = await closeRecommendBlockingPanels(client, {
        attemptsLimit: 2,
        rootState: refreshResult.root_state || rootState
      });
    }
    const compactRefresh = {
      ...compactRefreshAttempt(refreshResult),
      context_recovery: true,
      recovery_reason: reason,
      trigger_error: compactError(error, "RECOMMEND_CONTEXT_RECOVERY_TRIGGER"),
      account_rights_panel_close: compactCloseResult(blockingPanelClose),
      elapsed_ms: Date.now() - started
    };
    retainRefreshAttempt(compactRefresh);
    runControl.checkpoint({
      context_recovery: {
        attempt: contextRecoveryAttempts,
        reason,
        trigger_error: compactError(error, "RECOMMEND_CONTEXT_RECOVERY_TRIGGER"),
        refresh: compactRefresh,
        counters: currentResultStatusCounts()
      },
      candidate_list: compactInfiniteListState(listState)
    });
    if (!refreshResult.ok) {
      updateRecommendProgress({
        refresh_method: refreshResult.method || null,
        refresh_forced_recent_not_view: effectiveForceRecentNotView,
        recovery_reason: reason
      });
      const recoveryError = new Error(
        `Recommend context recovery failed after ${reason}: ${refreshResult.reason || refreshResult.error || "refresh returned no cards"}`
      );
      recoveryError.code = "RECOMMEND_CONTEXT_RECOVERY_FAILED";
      recoveryError.refresh_attempt = compactRefresh;
      recoveryError.recovery_reason = reason;
      throw attachRecommendRefreshErrorDiagnostic(recoveryError, compactRefresh);
    }
    if (refreshResult.job_selection) {
      jobSelection = refreshResult.job_selection;
    }
    if (refreshResult.page_scope) {
      pageScopeSelection = refreshResult.page_scope;
    }
    if (refreshResult.exhausted && !verifiedExhaustion) {
      updateRecommendProgress({
        refresh_method: refreshResult.method || null,
        refresh_forced_recent_not_view: effectiveForceRecentNotView,
        recovery_reason: reason,
        refresh_exhausted_unverified: true
      });
      const recoveryError = new Error(
        `Recommend context recovery returned unverified exhaustion after ${reason}`
      );
      recoveryError.code = "RECOMMEND_CONTEXT_RECOVERY_FAILED";
      recoveryError.refresh_attempt = compactRefresh;
      recoveryError.recovery_reason = reason;
      throw attachRecommendRefreshErrorDiagnostic(recoveryError, compactRefresh);
    }
    if (refreshResult.current_city_only) {
      currentCityOnlyResult = refreshResult.current_city_only;
    }
    if (refreshResult.filter) {
      filterResult = refreshResult.filter;
    }
    if (verifiedExhaustion) {
      rootState = refreshResult.root_state || rootState;
      cardNodeIds = [];
      listEndReason = "filtered_list_exhausted";
      updateRecommendProgress({
        card_count: 0,
        refresh_method: refreshResult.method || null,
        refresh_forced_recent_not_view: effectiveForceRecentNotView,
        recovery_reason: reason,
        list_end_reason: listEndReason,
        refresh_exhausted: true,
        empty_state_verified: true
      });
      runControl.checkpoint({
        context_recovery: {
          attempt: contextRecoveryAttempts,
          reason,
          refresh: compactRefresh,
          refresh_exhausted: true,
          list_end_reason: listEndReason,
          counters: currentResultStatusCounts()
        },
        candidate_list: compactInfiniteListState(listState)
      });
      return refreshResult;
    }
    if (!blockingPanelClose?.closed) {
      const panelError = createRecommendBlockingPanelCloseFailureError(blockingPanelClose, `recover:${reason}`);
      panelError.refresh_attempt = compactRefresh;
      throw panelError;
    }
    rootState = refreshResult.root_state || await getRecommendRoots(client);
    rootState = await ensureRecommendViewport(rootState, "recover_after");
    cardNodeIds = await waitForRecommendCardNodeIds(client, rootState.iframe.documentNodeId, {
      timeoutMs: cardTimeoutMs,
      intervalMs: 300
    });
    resetInfiniteListForRefreshRound(listState, {
      reason: `context_recovery:${reason}`,
      round: contextRecoveryAttempts,
      method: refreshResult.method,
      metadata: {
        card_count: cardNodeIds.length,
        forced_recent_not_view: effectiveForceRecentNotView,
        counters: currentResultStatusCounts()
      }
    });
    listEndReason = "";
    updateRecommendProgress({
      card_count: cardNodeIds.length,
      refresh_method: refreshResult.method || null,
      refresh_forced_recent_not_view: effectiveForceRecentNotView,
      recovery_reason: reason,
      context_recovery_consecutive_failures: 0
    });
    return refreshResult;
  }

  function createRecommendTechnicalRecoveryExhaustedError(reason, cause = null) {
    const exhausted = new Error(
      `Recommend technical recovery made no candidate progress after ${RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS} refresh/reapply attempts: ${reason}`
    );
    exhausted.code = "RECOMMEND_LIST_TECHNICAL_RECOVERY_EXHAUSTED";
    exhausted.phase = "recommend:recover-context";
    exhausted.recovery_reason = reason;
    exhausted.context_recovery_attempts_without_progress = technicalRecoveryAttemptsWithoutProgress;
    if (cause) exhausted.cause = cause;
    return exhausted;
  }

  async function recoverAndReapplyRecommendContext(reason = "context_recovery", error = null, {
    technicalBudget = false,
    maxAttempts = RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS,
    ...contextOptions
  } = {}) {
    let lastError = error;
    const technicalBudgetState = technicalBudget
      ? resolveRecommendTechnicalRecoveryBudget({
          attemptsWithoutProgress: technicalRecoveryAttemptsWithoutProgress,
          requestedAttempts: maxAttempts
        })
      : null;
    const attemptLimit = technicalBudgetState
      ? technicalBudgetState.attempt_limit
      : Math.min(
          RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS,
          Math.max(1, Math.floor(Number(maxAttempts) || RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS))
        );
    if (technicalBudgetState?.exhausted) {
      throw createRecommendTechnicalRecoveryExhaustedError(reason, error);
    }
    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      if (technicalBudget) technicalRecoveryAttemptsWithoutProgress += 1;
      try {
        await assertRecommendRecoveryPageSafe(reason);
        const recovery = await recoverRecommendContextOnce(reason, lastError, contextOptions);
        contextRecoveryConsecutiveFailures = 0;
        updateRecommendProgress({
          recovery_reason: reason,
          context_recovery_attempt_in_cycle: attempt,
          context_recovery_consecutive_failures: 0,
          technical_recovery_attempts_without_progress: technicalRecoveryAttemptsWithoutProgress
        });
        return recovery;
      } catch (recoveryError) {
        lastError = recoveryError;
        contextRecoveryConsecutiveFailures += 1;
        updateRecommendProgress({
          recovery_reason: reason,
          context_recovery_attempt_in_cycle: attempt,
          context_recovery_consecutive_failures: contextRecoveryConsecutiveFailures,
          context_recovery_last_error: compactError(
            recoveryError,
            "RECOMMEND_CONTEXT_RECOVERY_FAILED"
          )
        });
        runControl.checkpoint({
          context_recovery_retry: {
            reason,
            attempt,
            max_attempts: attemptLimit,
            consecutive_failures: contextRecoveryConsecutiveFailures,
            error: compactError(recoveryError, "RECOMMEND_CONTEXT_RECOVERY_FAILED")
          },
          candidate_list: compactInfiniteListState(listState)
        });
        if (
          attempt >= attemptLimit
          || isRecommendContextRecoveryNonRetryable(recoveryError)
        ) {
          if (
            technicalBudget
            && !isRecommendContextRecoveryNonRetryable(recoveryError)
            && technicalRecoveryAttemptsWithoutProgress >= RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS
          ) {
            throw createRecommendTechnicalRecoveryExhaustedError(reason, recoveryError);
          }
          recoveryError.context_recovery_attempts_in_cycle = attempt;
          recoveryError.context_recovery_consecutive_failures = contextRecoveryConsecutiveFailures;
          throw recoveryError;
        }
        const backoffMs = RECOMMEND_CONTEXT_RECOVERY_BACKOFF_MS[attempt] || 0;
        if (backoffMs > 0) {
          runControl.setPhase("recommend:recover-context-backoff");
          await runControl.sleep(backoffMs);
        }
      }
    }
    throw lastError;
  }

  runControl.setPhase("recommend:preflight");
  await assertRecommendRecoveryPageSafe("startup_preflight");
  runControl.setPhase("recommend:cleanup");
  try {
    await closeRecommendDetail(client, { attemptsLimit: 2 });
    await closeRecommendAvatarPreview(client, { attemptsLimit: 2 });
    await closeRecommendBlockingPanelsForRun("cleanup");
  } catch (error) {
    await recoverAndReapplyRecommendContext("startup_cleanup_failed", error, {
      forceRecentNotView: true
    });
  }

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recommend:roots");
  rootState = await waitForRecommendRoots(client, {
    timeoutMs: Math.min(Math.max(cardTimeoutMs, 10000), 60000),
    intervalMs: 500
  });
  if (!rootState?.iframe?.documentNodeId) {
    const rootError = new Error("Recommend iframe was not available after bounded startup wait");
    rootError.code = "RECOMMEND_STARTUP_ROOT_UNAVAILABLE";
    await recoverAndReapplyRecommendContext("startup_root_unavailable", rootError, {
      forceRecentNotView: true
    });
  }
  rootState = await ensureRecommendViewport(rootState, "roots");
  runControl.checkpoint({
    iframe_selector: rootState.iframe.selector,
    iframe_document_node_id: rootState.iframe.documentNodeId
  });

  if (jobLabel) {
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recommend:job");
    let initialJobSelection;
    try {
      initialJobSelection = await selectAndVerifyInitialRecommendJob(client, rootState, {
        jobLabel,
        settleMs: cardTimeoutMs > 45000 ? 12000 : 6000,
        dropdownTimeoutMs: Math.max(8000, Math.min(cardTimeoutMs, 60000)),
        totalTimeoutMs: Math.max(30000, Math.min(cardTimeoutMs + 15000, 90000)),
        retryDelayMs: 1000
      });
    } catch (error) {
      const recovery = await recoverAndReapplyRecommendContext(
        "startup_job_selection_failed",
        error,
        { forceRecentNotView: true }
      );
      initialJobSelection = {
        job_selection: recovery.job_selection,
        root_state: recovery.root_state || rootState
      };
    }
    jobSelection = initialJobSelection.job_selection;
    rootState = initialJobSelection.root_state || await getRecommendRoots(client);
    rootState = await ensureRecommendViewport(rootState, "job");
    runControl.checkpoint({
      job_selection: compactJobSelection(jobSelection)
    });
  }

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recommend:page-scope");
  try {
    pageScopeSelection = await selectRecommendPageScope(client, rootState.iframe.documentNodeId, {
      pageScope: requestedPageScope,
      fallbackScope: normalizedFallbackPageScope,
      settleMs: cardTimeoutMs > 45000 ? 3000 : 1200,
      timeoutMs: Math.min(Math.max(cardTimeoutMs, 10000), 60000)
    });
    if (!pageScopeSelection.selected) {
      throw new Error(`Recommend page scope was not selected: ${pageScopeSelection.reason || pageScopeSelection.effective_scope || requestedPageScope}`);
    }
  } catch (error) {
    const recovery = await recoverAndReapplyRecommendContext(
      "startup_page_scope_failed",
      error,
      { forceRecentNotView: true }
    );
    pageScopeSelection = recovery.page_scope || pageScopeSelection;
    if (!pageScopeSelection?.selected) throw error;
  }
  rootState = await getRecommendRoots(client);
  rootState = await ensureRecommendViewport(rootState, "page_scope");
  runControl.checkpoint({
    page_scope: compactPageScopeSelection(pageScopeSelection)
  });

  let initialFilterStages;
  try {
    initialFilterStages = await applyRecommendFilterEnvelopeStages(normalizedFilter, {
    applyCurrentCityOnly: async () => {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("recommend:current-city-only");
      const result = await ensureRecommendCurrentCityOnly(
        client,
        rootState.iframe.documentNodeId,
        { enabled: normalizedFilter.currentCityOnly }
      );
      rootState = await getRecommendRoots(client);
      rootState = await ensureRecommendViewport(rootState, "current_city_only");
      runControl.checkpoint({
        current_city_only: compactCurrentCityOnlyResult(result)
      });
      return result;
    },
    applyFilterPanel: async () => {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("recommend:filter");
      const result = await selectAndConfirmFirstSafeFilter(
        client,
        rootState.iframe.documentNodeId,
        buildRecommendFilterSelectionOptions(normalizedFilter)
      );
      if (!isVerifiedRecommendFilterApplication(
        result,
        buildRecommendFilterSelectionOptions(normalizedFilter)
      )) {
        throw new Error("Recommend run filter selection was not fully verified");
      }
      rootState = await getRecommendRoots(client);
      rootState = await ensureRecommendViewport(rootState, "filter");
      runControl.checkpoint({
        filter: compactFilterResult(result)
      });
      return result;
    }
  });
  currentCityOnlyResult = initialFilterStages.current_city_only;
  filterResult = initialFilterStages.filter;

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recommend:cards");
  rootState = await ensureRecommendViewport(rootState, "cards");
  cardNodeIds = await waitForRecommendCardNodeIds(client, rootState.iframe.documentNodeId, {
    timeoutMs: cardTimeoutMs,
    intervalMs: 300
    });
  } catch (error) {
    const recovery = await recoverAndReapplyRecommendContext(
      "startup_filter_failed",
      error,
      { forceRecentNotView: true }
    );
    initialFilterStages = {
      current_city_only: recovery.current_city_only || currentCityOnlyResult,
      filter: recovery.filter || filterResult
    };
  }
  let initialEmptyState = null;
  if (!cardNodeIds.length) {
    initialEmptyState = await inspectRecommendFilteredEmptyState(
      client,
      rootState.iframe.documentNodeId
    );
    const initialExhausted = isVerifiedRecommendRefreshExhaustion({
      cardCount: 0,
      filter: normalizedFilter,
      filterResult,
      pageScopeResult: pageScopeSelection,
      currentCityOnlyResult,
      emptyState: initialEmptyState
    });
    if (initialExhausted) {
      listEndReason = "filtered_list_exhausted";
      runControl.checkpoint({
        initial_list_exhausted: true,
        initial_list_exhaustion_verified: true,
        exhaustion_refresh_pending: effectiveMaxRefreshRounds > 0,
        list_end_reason: listEndReason,
        empty_state: compactRecommendFilteredEmptyState(initialEmptyState),
        counters: currentResultStatusCounts()
      });
    } else {
      const emptyError = new Error("No recommend candidate cards found for run service");
      emptyError.code = "RECOMMEND_INITIAL_LIST_EMPTY_UNVERIFIED";
      emptyError.empty_state = compactRecommendFilteredEmptyState(initialEmptyState);
      const recovery = await recoverAndReapplyRecommendContext(
        "initial_list_empty_unverified",
        emptyError,
        { forceRecentNotView: true }
      );
      if (isVerifiedRecommendRefreshCompletion(recovery)) {
        initialEmptyState = recovery.empty_state || initialEmptyState;
        listEndReason = "filtered_list_exhausted";
      }
    }
  }

  updateRecommendProgress({
    card_count: cardNodeIds.length,
    list_end_reason: listEndReason || null,
    initial_list_exhausted: listEndReason === "filtered_list_exhausted",
    empty_state_verified: initialEmptyState?.verified === true
  });

  while (currentPassedCount() < targetPassCount) {
    const candidateStarted = Date.now();
    const timings = {};
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recommend:list-read");
    currentDomOperation = "candidate:list-read";
    const debugBoundaryAction = debugBoundary.take(currentResultCount());
    let debugForcedListEnd = false;
    if (debugBoundaryAction) {
      const debugProgress = {
        debug_boundary_mode: debugBoundaryAction.mode,
        debug_boundary_threshold: debugBoundaryAction.threshold,
        debug_boundary_triggered: true,
        debug_boundary_trigger_count: debugBoundaryAction.trigger_count,
        debug_boundary_processed: debugBoundaryAction.processed
      };
      updateRecommendProgress(debugProgress);
      runControl.checkpoint({
        debug_boundary: {
          ...debugProgress,
          field: debugBoundaryAction.field,
          triggered_at: new Date().toISOString()
        }
      });
      if (debugBoundaryAction.mode === "context_recovery") {
        runControl.setPhase("recommend:debug-force-context-recovery");
        await recoverAndReapplyRecommendContext("debug_force_context_recovery_after_processed", null, {
          forceRecentNotView: true
        });
        updateRecommendProgress({
          debug_force_context_recovery_count: debugBoundaryAction.trigger_count
        });
        runControl.setPhase("recommend:list-read");
      } else if (debugBoundaryAction.mode === "cdp_reconnect") {
        debugForceReconnectPending = debugBoundaryAction;
        updateRecommendProgress({
          debug_force_cdp_reconnect_pending: true
        });
      } else if (debugBoundaryAction.mode === "list_end") {
        debugForcedListEnd = true;
        updateRecommendProgress({
          debug_force_list_end_count: debugBoundaryAction.trigger_count
        });
      }
    }
    let listReadAcquisition;
    try {
      listReadAcquisition = await acquireRecommendListReadWithStaleRecovery({
      maxRetries: 2,
      acquire: async () => {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("recommend:list-read");
        if (listEndReason === "filtered_list_exhausted") {
          return {
            ok: false,
            end_reached: true,
            reason: listEndReason
          };
        }
        rootState = await ensureRecommendViewport(rootState, "candidate_loop");
        if (debugForcedListEnd) {
          return {
            ok: false,
            end_reached: true,
            reason: "debug_forced_list_end"
          };
        }
        return measureTiming(timings, "card_read_ms", () => getNextInfiniteListCandidate({
          client,
          state: listState,
          maxScrolls: listMaxScrolls,
          stableSignatureLimit: listStableSignatureLimit,
          wheelDeltaY: listWheelDeltaY,
          settleMs: listSettleMs,
          listScrollJitterEnabled: effectiveHumanBehavior.listScrollJitter,
          fallbackPoint: listFallbackResolver,
          findNodeIds: async () => {
            currentDomOperation = "candidate:list-find-nodes";
            let currentRootState = await getRecommendRoots(client);
            currentRootState = await ensureRecommendViewport(currentRootState, "candidate_find_nodes");
            rootState = currentRootState;
            if (debugForceReconnectPending) {
              runControl.setPhase("recommend:debug-force-cdp-reconnect");
              const rawClient = client.__rawClient;
              if (!rawClient || typeof rawClient.close !== "function") {
                const error = new Error("Guarded CDP client does not expose a closable __rawClient");
                error.code = "RECOMMEND_DEBUG_RAW_CDP_UNAVAILABLE";
                throw error;
              }
              const forcedReconnectAction = debugForceReconnectPending;
              debugForceReconnectPending = null;
              await rawClient.close();
              runControl.checkpoint({
                debug_cdp_reconnect: {
                  raw_connection_closed: true,
                  processed: forcedReconnectAction.processed,
                  threshold: forcedReconnectAction.threshold,
                  closed_at: new Date().toISOString()
                }
              });
              updateRecommendProgress({
                debug_force_cdp_reconnect_pending: false,
                debug_force_cdp_reconnect_count: forcedReconnectAction.trigger_count
              });
              runControl.setPhase("recommend:list-read");
            }
            const currentCardNodeIds = await waitForRecommendCardNodeIds(
              client,
              currentRootState.iframe.documentNodeId,
              {
                timeoutMs: Math.min(cardTimeoutMs, 5000),
                intervalMs: 300
              }
            );
            cardNodeIds = currentCardNodeIds;
            return currentCardNodeIds;
          },
          readCandidate: async (nodeId, { visibleIndex }) => {
            currentDomOperation = "candidate:list-read-card";
            return readRecommendCardCandidate(client, nodeId, {
              targetUrl,
              source: "recommend-run-card",
              metadata: {
                run_candidate_index: currentResultCount(),
                visible_index: visibleIndex
              }
            });
          },
          shouldRethrowReadError: isStaleRecommendNodeError,
          detectBottomMarker: async ({ scrollAttempt = 0, signature = {} } = {}) => {
            currentDomOperation = "candidate:list-bottom-probe";
            return detectInfiniteListBottomMarker(client, {
              rootNodeId: rootState?.iframe?.documentNodeId,
              markerSelectors: RECOMMEND_BOTTOM_MARKER_SELECTORS,
              refreshSelectors: [RECOMMEND_END_REFRESH_SELECTOR],
              textScanSelectors: scrollAttempt > 0 || (signature?.stable_signature_count || 0) >= 2 ? undefined : [],
              maxTextScanNodes: 500
            });
          }
        }));
      },
      onStale: async ({ error, diagnostic }) => {
        listReadStaleRecoveryAttempts += 1;
        const forensic = checkpointDomStaleForensic(error, {
          phase: "recommend:list-read",
          operation: currentDomOperation,
          candidateIndex: currentResultCount()
        });
        if (forensic) {
          diagnostic.forensic_event_id = forensic.event_id;
          diagnostic.pre_recovery_roots = forensic.pre_recovery_roots;
          diagnostic.failing_candidate = forensic.candidate;
        }
        lastListReadStaleDiagnostic = diagnostic;
        retainListReadStaleDiagnostic(diagnostic);
        runControl.checkpoint({
          list_read_stale_recovery: {
            diagnostic,
            recent_diagnostics: listReadStaleDiagnostics.slice(-12),
            counters: currentResultStatusCounts(),
            candidate_list: compactInfiniteListState(listState)
          }
        });
        updateRecommendProgress();
      },
      recover: async ({ error, diagnostic }) => {
        try {
          return await recoverRecommendListReadStaleContext({
            staleAttempt: diagnostic.attempt,
            listState,
            contextReapply: async () => {
              await runControl.waitIfPaused();
              runControl.throwIfCanceled();
              const recovery = await recoverAndReapplyRecommendContext(
                "list_read_stale_node",
                error,
                { forceRecentNotView: true, technicalBudget: true }
              );
              return {
                ok: Boolean(recovery?.ok),
                method: recovery?.method || null,
                card_count: recovery?.card_count || 0,
                root_identity: compactRecommendDomRootIdentity(
                  rootState,
                  currentConnectionEpoch()
                )
              };
            }
          });
        } catch (recoveryError) {
          const forensic = domStaleForensics.find((item) => (
            item.event_id === diagnostic.forensic_event_id
          ));
          checkpointDomStaleRecovery(forensic, {
            status: "recovery_failed",
            recoveryError
          });
          updateRecommendProgress({
            list_read_stale_recovery_failed: true
          });
          runControl.checkpoint({
            list_read_stale_recovery_failed: {
              trigger: lastListReadStaleDiagnostic,
              recent_diagnostics: listReadStaleDiagnostics.slice(-12),
              recovery_error: compactError(recoveryError, "RECOMMEND_LIST_READ_RECOVERY_FAILED"),
              candidate_list: compactInfiniteListState(listState)
            }
          });
          throw recoveryError;
        }
      },
      onRecoveryApplied: async ({ diagnostic, recoveryResult }) => {
        listReadStaleRecoveryApplied += 1;
        lastListReadStaleDiagnostic = diagnostic;
        lastListReadRecoveryMode = diagnostic.recovery_mode || null;
        const forensic = domStaleForensics.find((item) => (
          item.event_id === diagnostic.forensic_event_id
        ));
        checkpointDomStaleRecovery(forensic, {
          status: "recovery_applied",
          recoveryResult
        });
        updateRecommendProgress();
        runControl.checkpoint({
          list_read_stale_recovery_applied: {
            diagnostic,
            recovery_applied_count: listReadStaleRecoveryApplied,
            candidate_list: compactInfiniteListState(listState)
          }
        });
      },
      onRecovered: async ({ diagnostic }) => {
        listReadStaleRecoveries += 1;
        lastListReadStaleDiagnostic = diagnostic;
        const forensic = domStaleForensics.find((item) => (
          item.event_id === diagnostic.forensic_event_id
        ));
        checkpointDomStaleRecovery(forensic, {
          status: "recovered",
          recoveryResult: {
            recovery_mode: diagnostic.recovery_mode,
            ok: true
          }
        });
        updateRecommendProgress();
        runControl.checkpoint({
          list_read_stale_recovered: {
            diagnostic,
            recovery_count: listReadStaleRecoveries,
            candidate_list: compactInfiniteListState(listState)
          }
        });
      },
      onExhausted: async ({ error, diagnostic }) => {
        listReadStaleRecoveryAttempts += 1;
        const forensic = checkpointDomStaleForensic(error, {
          phase: "recommend:list-read",
          operation: currentDomOperation,
          candidateIndex: currentResultCount()
        });
        if (forensic) {
          diagnostic.forensic_event_id = forensic.event_id;
          diagnostic.pre_recovery_roots = forensic.pre_recovery_roots;
          diagnostic.failing_candidate = forensic.candidate;
          checkpointDomStaleRecovery(forensic, { status: "exhausted" });
        }
        lastListReadStaleDiagnostic = diagnostic;
        retainListReadStaleDiagnostic(diagnostic);
        updateRecommendProgress({
          list_read_stale_recovery_exhausted: true
        });
        runControl.checkpoint({
          list_read_stale_recovery_exhausted: {
            diagnostic,
            recent_diagnostics: listReadStaleDiagnostics.slice(-12),
            candidate_list: compactInfiniteListState(listState)
          }
        });
      }
      });
      consecutiveListReadFailures = 0;
    } catch (error) {
      runControl.throwIfCanceled();
      if (isRecommendContextRecoveryNonRetryable(error)) throw error;
      consecutiveListReadFailures += 1;
      updateRecommendProgress({
        list_read_failure_recovery_attempts: consecutiveListReadFailures,
        list_read_failure_last_error: compactError(error, "RECOMMEND_LIST_READ_FAILED")
      });
      runControl.checkpoint({
        list_read_failure_recovery: {
          attempt: consecutiveListReadFailures,
          max_attempts: RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS,
          operation: currentDomOperation,
          error: compactError(error, "RECOMMEND_LIST_READ_FAILED"),
          counters: currentResultStatusCounts(),
          candidate_list: compactInfiniteListState(listState)
        }
      });
      if (consecutiveListReadFailures > RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS) {
        const exhausted = new Error(
          `Recommend list read failed ${consecutiveListReadFailures} consecutive times: ${error?.message || error}`
        );
        exhausted.code = "RECOMMEND_LIST_READ_RECOVERY_EXHAUSTED";
        exhausted.phase = "recommend:list-read";
        exhausted.cause = error;
        throw exhausted;
      }
      const recovery = await recoverAndReapplyRecommendContext(
        "list_read_transient_failure",
        error,
        { forceRecentNotView: true, technicalBudget: true }
      );
      if (isVerifiedRecommendRefreshCompletion(recovery)) {
        listEndReason = "filtered_list_exhausted";
      }
      continue;
    }
    const nextCandidateResult = listReadAcquisition.result;
    if (!nextCandidateResult.ok) {
      listEndReason = nextCandidateResult.reason || "list_exhausted";
      if (isRecommendTechnicalListStall(listEndReason)) {
        const nextTechnicalRecoveryAttempt = technicalRecoveryAttemptsWithoutProgress + 1;
        if (nextTechnicalRecoveryAttempt > RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS) {
          const exhausted = createRecommendTechnicalRecoveryExhaustedError(listEndReason);
          exhausted.phase = "recommend:list-read";
          exhausted.list_end_result = nextCandidateResult;
          throw exhausted;
        }
        const stallError = new Error(
          `Recommend list stalled before verified source exhaustion: ${listEndReason}`
        );
        stallError.code = "RECOMMEND_LIST_TECHNICAL_STALL";
        stallError.phase = "recommend:list-read";
        stallError.list_end_result = nextCandidateResult;
        updateRecommendProgress({
          technical_recovery_attempts_without_progress: nextTechnicalRecoveryAttempt,
          technical_recovery_max_attempts: RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS
        });
        runControl.checkpoint({
          technical_list_recovery: {
            attempt: nextTechnicalRecoveryAttempt,
            max_attempts: RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS,
            reason: listEndReason,
            counters: currentResultStatusCounts()
          }
        });
        const recovery = await recoverAndReapplyRecommendContext(
          `list_technical_stall:${listEndReason}`,
          stallError,
          { forceRecentNotView: true, technicalBudget: true }
        );
        if (isVerifiedRecommendRefreshCompletion(recovery)) {
          listEndReason = "filtered_list_exhausted";
        }
        continue;
      }

      const sourceEndVerified = isVerifiedRecommendSourceEndResult(nextCandidateResult);
      const sourceRefreshDecision = resolveRecommendSourceRefreshDecision({
        targetReached: currentPassedCount() >= targetPassCount,
        refreshOnEnd,
        sourceEndVerified,
        refreshRounds,
        maxRefreshRounds: effectiveMaxRefreshRounds
      });
      if (sourceRefreshDecision.action === "refresh") {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("recommend:source-exhaustion-refresh");
        currentDomOperation = "candidate:source-exhaustion-refresh";
        refreshRounds += 1;
        let refreshResult;
        try {
          refreshResult = await recoverAndReapplyRecommendContext(
            `source_exhaustion_refresh_round_${refreshRounds}`,
            null,
            { forceRecentNotView: true }
          );
        } catch (error) {
          checkpointDomStaleForensic(error, {
            phase: "recommend:source-exhaustion-refresh",
            operation: currentDomOperation,
            candidateIndex: currentResultCount()
          });
          error.exhaustion_refresh_round = refreshRounds;
          error.max_exhaustion_refresh_rounds = effectiveMaxRefreshRounds;
          throw error;
        }
        const compactRefresh = compactRefreshAttempt(refreshResult);
        runControl.checkpoint({
          refresh_round: refreshRounds,
          exhaustion_refresh_round: refreshRounds,
          max_exhaustion_refresh_rounds: effectiveMaxRefreshRounds,
          refresh: compactRefresh,
          source_end_before_refresh: {
            reason: nextCandidateResult.reason || null,
            verified: sourceEndVerified
          }
        });
        updateRecommendProgress({
          card_count: Number.isInteger(refreshResult.card_count)
            ? refreshResult.card_count
            : cardNodeIds.length,
          refresh_method: refreshResult.method || null,
          refresh_forced_recent_not_view: Boolean(refreshResult.forced_recent_not_view),
          exhaustion_refresh_rounds: refreshRounds,
          max_exhaustion_refresh_rounds: effectiveMaxRefreshRounds,
          list_end_reason: listEndReason
        });
        if (isVerifiedRecommendRefreshCompletion(refreshResult)) {
          cardNodeIds = [];
          listEndReason = "filtered_list_exhausted";
          updateRecommendProgress({
            card_count: 0,
            list_end_reason: listEndReason,
            refresh_exhausted: true,
            empty_state_verified: true,
            exhaustion_refresh_rounds: refreshRounds,
            exhaustion_refresh_budget_consumed: refreshRounds >= effectiveMaxRefreshRounds
          });
          runControl.checkpoint({
            refresh_round: refreshRounds,
            refresh: compactRefresh,
            refresh_exhausted: true,
            list_end_reason: listEndReason,
            exhaustion_refresh_budget_consumed: refreshRounds >= effectiveMaxRefreshRounds,
            counters: currentResultStatusCounts()
          });
          if (refreshRounds >= effectiveMaxRefreshRounds) break;
          continue;
        }
        if (refreshResult.ok) {
          listEndReason = "";
          continue;
        }
        throw createRecommendRefreshFailureError(compactRefresh, {
          listEndReason,
          targetCount: targetPassCount,
          passedCount: currentPassedCount()
        });
      }
      if (sourceRefreshDecision.action === "complete_exhausted") {
        cardNodeIds = [];
        listEndReason = "filtered_list_exhausted";
        updateRecommendProgress({
          card_count: 0,
          list_end_reason: listEndReason,
          refresh_exhausted: true,
          source_exhaustion_verified: true,
          exhaustion_refresh_rounds: refreshRounds,
          exhaustion_refresh_budget_consumed: refreshRounds >= effectiveMaxRefreshRounds
        });
        runControl.checkpoint({
          source_exhausted: {
            verified: true,
            original_list_end_reason: nextCandidateResult.reason || null,
            refresh_on_end: Boolean(refreshOnEnd),
            exhaustion_refresh_rounds: refreshRounds,
            max_exhaustion_refresh_rounds: effectiveMaxRefreshRounds,
            counters: currentResultStatusCounts()
          }
        });
        break;
      }
      if (currentPassedCount() < targetPassCount) {
        listEndReason = "source_unverified_underfill";
        updateRecommendProgress({
          list_end_reason: listEndReason,
          source_unverified_underfill: true,
          exhaustion_refresh_rounds: refreshRounds
        });
        runControl.checkpoint({
          source_unverified_underfill: {
            required: true,
            original_list_end_reason: nextCandidateResult.reason || "list_exhausted",
            refresh_on_end: Boolean(refreshOnEnd),
            source_end_verified: sourceEndVerified,
            exhaustion_refresh_rounds: refreshRounds,
            max_exhaustion_refresh_rounds: effectiveMaxRefreshRounds,
            counters: currentResultStatusCounts()
          }
        });
      }
      break;
    }

    runControl.setPhase("recommend:candidate");
    const index = currentResultCount();
    let cardNodeId = nextCandidateResult.item.node_id;
    const candidateKey = nextCandidateResult.item.key;
    let cardCandidate = nextCandidateResult.item.candidate;

    let screeningCandidate = cardCandidate;
    let detailResult = null;
    let recoverableDetailError = null;
    let candidateLocalDetailFailurePending = false;
    let candidateLocalDetailTerminalError = null;
    let colleagueContact = null;
    let colleagueContactSkipReason = "";
    let detailStep = "not_started";
    let openedDetailState = null;
    currentDetailCandidateBinding = null;

    async function requireCurrentDetailCandidateBinding(stage, {
      allowScroll = true,
      settleMs = 120
    } = {}) {
      const bindingContext = openedDetailState?.candidate_binding_context || {
        card_pre_click_provenance: currentDetailCandidateBinding?.card?.pre_click_provenance || null,
        detail_roots_before: currentDetailCandidateBinding?.detail?.roots_before_capture || null,
        expected_detail_root: currentDetailCandidateBinding?.detail?.root || null,
        allow_card_disappearance: true,
        card_click_evidence: currentDetailCandidateBinding?.card?.click_evidence || null,
        click_attempts: currentDetailCandidateBinding?.card?.click_attempts || []
      };
      const freshDetailState = await waitForRecommendDetail(client, {
        timeoutMs: 4000,
        intervalMs: 200
      });
      if (!freshDetailState?.popup && !freshDetailState?.resumeIframe) {
        throw createRecommendDetailCandidateBindingError({
          schema_version: 1,
          verified: false,
          reason: "detail_not_visible_during_reverification",
          method: null,
          expected_candidate_id: cardCandidate?.id || null,
          expected_name: cardCandidate?.identity?.name || null,
          card: currentDetailCandidateBinding?.card || null,
          detail: null
        });
      }
      openedDetailState = {
        ...freshDetailState,
        candidate_binding: currentDetailCandidateBinding,
        candidate_binding_context: bindingContext
      };
      const binding = await verifyRecommendDetailCandidateBinding(client, {
        cardNodeId,
        cardCandidate,
        detailState: freshDetailState,
        cardEvidenceBefore: bindingContext?.card_pre_click_provenance?.card || null,
        cardPreClickProvenance: bindingContext?.card_pre_click_provenance || null,
        detailRootsBefore: bindingContext?.detail_roots_before || null,
        // In zero-outbound screening mode Boss may replace the short-lived
        // loading dialog with the final resume popup.  Re-prove a stable CV
        // target in the fresh popup instead of requiring the loading root's
        // backend identity to survive that legitimate replacement.
        expectedDetailRoot: screeningOnlyBindingEnabled
          ? null
          : bindingContext?.expected_detail_root || null,
        allowCardDisappearance: bindingContext?.allow_card_disappearance === true,
        cardClickEvidence: bindingContext?.card_click_evidence || null,
        clickAttempts: Array.isArray(bindingContext?.click_attempts)
          ? bindingContext.click_attempts
          : [],
        settleMs: allowScroll ? Math.max(0, Number(settleMs) || 0) : 0,
        allowScroll: allowScroll === true
      });
      currentDetailCandidateBinding = binding;
      if (openedDetailState) {
        openedDetailState = {
          ...openedDetailState,
          candidate_binding: binding,
          candidate_binding_context: bindingContext
        };
      }
      if (detailResult) detailResult.candidate_binding = binding;
      checkpointInProgressCandidate({
        index,
        candidateKey,
        cardNodeId,
        detailStep: stage || detailStep
      });
      const acceptedCandidateBinding = Boolean(
        binding.verified === true
        || (
          screeningOnlyBindingEnabled
          && binding.screening_verified === true
        )
      );
      if (!acceptedCandidateBinding) {
        throw createRecommendDetailCandidateBindingError(binding);
      }
      return binding;
    }

    async function closeCandidateDetailWithRecovery(reason = "detail_close_failed") {
      let closeResult = null;
      let closeError = null;
      try {
        closeResult = await closeRecommendDetail(client);
      } catch (error) {
        closeError = error instanceof Error
          ? error
          : new Error(String(error || "Recommend detail close failed"));
      }
      if (closeResult?.closed === true) return closeResult;
      const failure = closeError || createRecommendCloseFailureError(closeResult);
      failure.code = failure.code || "DETAIL_CLOSE_FAILED";
      failure.phase = failure.phase || "recommend:close-detail";
      const recovery = await recoverAndReapplyRecommendContext(reason, failure, {
        forceRecentNotView: true,
        technicalBudget: true
      });
      return {
        ...(closeResult || {}),
        closed: true,
        recovered_by_context: true,
        original_close_error: closeError?.message || null,
        context_recovery: {
          ok: Boolean(recovery?.ok),
          method: recovery?.method || null,
          forced_recent_not_view: Boolean(recovery?.forced_recent_not_view),
          card_count: recovery?.card_count || 0,
          exhausted: isVerifiedRecommendRefreshCompletion(recovery)
        }
      };
    }

    async function containCandidateLocalDetailBindingFailure(error, {
      phase = "recommend:detail-binding",
      operation = currentDomOperation,
      forensic = null
    } = {}) {
      if (candidateLocalDetailFailurePending) return;
      if (error?.detail_candidate_binding) {
        currentDetailCandidateBinding = error.detail_candidate_binding;
      }
      currentDetailCandidateBinding = preserveRecommendDetailCandidateBindingForRecovery(
        detailResult,
        currentDetailCandidateBinding
      );
      candidateLocalDetailFailurePending = true;
      const localForensic = forensic || checkpointDomStaleForensic(error, {
        phase,
        operation,
        detailStep,
        candidateIndex: index,
        candidateKey,
        cardNodeId
      });
      checkpointDomStaleRecovery(localForensic, {
        status: "candidate_failed_closed_no_context_recovery"
      });
      recoverableDetailError = error;
      detailResult = null;
      timings.detail_recovered_error = compactRecoverableDetailError(error);

      let detailCleanup = null;
      let detailCleanupError = null;
      try {
        detailCleanup = await closeRecommendDetail(client, { attemptsLimit: 2 });
      } catch (cleanupError) {
        detailCleanupError = cleanupError;
      }
      let avatarCleanup = null;
      let avatarCleanupError = null;
      try {
        avatarCleanup = await closeRecommendAvatarPreview(client, { attemptsLimit: 2 });
      } catch (cleanupError) {
        avatarCleanupError = cleanupError;
      }
      let cleanupRootState = null;
      let cleanupRootError = null;
      try {
        cleanupRootState = await getRecommendRoots(client);
        cleanupRootState = await ensureRecommendViewport(
          cleanupRootState,
          "detail_binding_candidate_local_cleanup"
        );
      } catch (cleanupError) {
        cleanupRootError = cleanupError;
      }
      let panelCleanup = null;
      let panelCleanupError = null;
      try {
        panelCleanup = await closeRecommendBlockingPanels(client, {
          attemptsLimit: 2,
          rootState: cleanupRootState || rootState
        });
      } catch (cleanupError) {
        panelCleanupError = cleanupError;
      }
      timings.detail_candidate_local_cleanup = {
        detail: compactCloseResult(detailCleanup),
        detail_error: detailCleanupError?.message || null,
        avatar_preview: compactCloseResult(avatarCleanup),
        avatar_preview_error: avatarCleanupError?.message || null,
        blocking_panels: compactCloseResult(panelCleanup),
        blocking_panels_error: panelCleanupError?.message || null,
        root_reacquired: Boolean(cleanupRootState?.iframe?.documentNodeId),
        root_error: cleanupRootError?.message || null,
        card_count: null
      };
      if (
        detailCleanup?.closed !== true
        || avatarCleanup?.closed !== true
        || panelCleanup?.closed !== true
        || detailCleanupError
        || avatarCleanupError
        || panelCleanupError
        || cleanupRootError
        || !cleanupRootState?.iframe?.documentNodeId
      ) {
        const cleanupError = new Error(
          "Recommend candidate-local detail binding cleanup did not restore a closed page state"
        );
        cleanupError.code = "RECOMMEND_DETAIL_LOCAL_CLEANUP_FAILED";
        cleanupError.phase = "recommend:detail-binding-cleanup";
        cleanupError.cleanup = timings.detail_candidate_local_cleanup;
        cleanupError.detail_candidate_binding = currentDetailCandidateBinding;
        candidateLocalDetailTerminalError = cleanupError;
        checkpointInProgressCandidate({
          index,
          candidateKey,
          cardNodeId,
          detailStep: "detail_binding_cleanup_failed",
          error: cleanupError
        });
      }

      if (!candidateLocalDetailTerminalError) {
        try {
          const freshCardNodeIds = await waitForRecommendCardNodeIds(
            client,
            cleanupRootState.iframe.documentNodeId,
            {
              timeoutMs: Math.min(cardTimeoutMs, 5000),
              intervalMs: 300
            }
          );
          if (!Array.isArray(freshCardNodeIds) || freshCardNodeIds.length === 0) {
            throw new Error("Recommend candidate-local cleanup reacquired no candidate cards");
          }
          rootState = cleanupRootState;
          cardNodeIds = freshCardNodeIds;
          timings.detail_candidate_local_cleanup.card_count = freshCardNodeIds.length;
        } catch (reacquireError) {
          const cleanupError = new Error(
            "Recommend candidate-local detail cleanup could not reacquire the candidate list"
          );
          cleanupError.code = "RECOMMEND_DETAIL_LOCAL_CLEANUP_FAILED";
          cleanupError.phase = "recommend:detail-binding-cleanup";
          cleanupError.cause = reacquireError;
          cleanupError.cleanup = {
            ...timings.detail_candidate_local_cleanup,
            reacquire_error: reacquireError?.message || String(reacquireError)
          };
          cleanupError.detail_candidate_binding = currentDetailCandidateBinding;
          candidateLocalDetailTerminalError = cleanupError;
          checkpointInProgressCandidate({
            index,
            candidateKey,
            cardNodeId,
            detailStep: "detail_binding_list_reacquire_failed",
            error: cleanupError
          });
        }
      }

      if (candidateLocalDetailTerminalError) {
        const localCleanupError = candidateLocalDetailTerminalError;
        try {
          const recovery = await recoverAndReapplyRecommendContext(
            "candidate_local_detail_cleanup_failed",
            localCleanupError,
            { forceRecentNotView: true, technicalBudget: true }
          );
          candidateLocalDetailTerminalError = null;
          timings.detail_candidate_local_cleanup.context_recovery = {
            ok: true,
            method: recovery?.method || null,
            exhausted: isVerifiedRecommendRefreshCompletion(recovery)
          };
          checkpointInProgressCandidate({
            index,
            candidateKey,
            cardNodeId,
            detailStep: "detail_binding_context_recovered"
          });
        } catch (recoveryError) {
          localCleanupError.context_recovery_error = compactError(
            recoveryError,
            "RECOMMEND_CONTEXT_RECOVERY_FAILED"
          );
          localCleanupError.cleanup = {
            ...(localCleanupError.cleanup || timings.detail_candidate_local_cleanup),
            context_recovery: {
              ok: false,
              error: recoveryError?.message || String(recoveryError)
            }
          };
          candidateLocalDetailTerminalError = localCleanupError;
        }
      }
    }

    if (index < effectiveDetailLimit) {
      try {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("recommend:detail");
        detailStep = "ensure_viewport";
        currentDomOperation = "candidate:detail-ensure-viewport";
        rootState = await ensureRecommendViewport(rootState, "detail");
        currentDomOperation = "candidate:detail-close-blocking-panels";
        const blockingPanelClose = await closeRecommendBlockingPanels(client, {
          attemptsLimit: 2,
          rootState
        });
        if (!blockingPanelClose?.closed) {
          const panelError = createRecommendBlockingPanelCloseFailureError(
            blockingPanelClose,
            "before_detail_open"
          );
          timings.account_rights_panel_close = compactCloseResult(blockingPanelClose);
          checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep, error: panelError });
          await recoverAndReapplyRecommendContext("account_rights_panel_before_detail", panelError, {
            forceRecentNotView: true,
            technicalBudget: true
          });
          continue;
        }
        if (blockingPanelClose.already_closed === false) {
          timings.account_rights_panel_close = compactCloseResult(blockingPanelClose);
        }
        checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
        detailStep = "open_detail";
        currentDomOperation = "candidate:detail-open";
        checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
        networkRecorder.clear();
        await maybeHumanActionCooldown("before_detail_open", timings);
        const openedDetail = await openRecommendCardDetailWithFreshRetry(client, {
          cardNodeId,
          candidateKey,
          cardCandidate,
          rootState,
          targetUrl,
          retryTimeoutMs: 8000,
          acceptScreeningBinding: screeningOnlyBindingEnabled,
          maxAttempts: 3
        });
        addTiming(timings, "candidate_click_ms", openedDetail.timings?.candidate_click_ms);
        addTiming(timings, "detail_open_ms", openedDetail.timings?.detail_open_ms);
        cardNodeId = openedDetail.card_node_id || cardNodeId;
        cardCandidate = openedDetail.card_candidate || cardCandidate;
        screeningCandidate = cardCandidate;
        openedDetailState = openedDetail.detail_state;
        currentDetailCandidateBinding = openedDetail.candidate_binding || openedDetail.detail_state?.candidate_binding || null;
        checkpointInProgressCandidate({
          index,
          candidateKey,
          cardNodeId,
          detailStep: "detail_binding_verified"
        });
        if (shouldSkipRecentColleagueContacted) {
          detailStep = "check_colleague_contact";
          currentDomOperation = "candidate:detail-colleague-contact";
          await requireCurrentDetailCandidateBinding("before_colleague_contact");
          checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
          try {
            colleagueContact = await measureTiming(timings, "colleague_contact_check_ms", () => inspectRecentColleagueContact(
              client,
              openedDetailState,
              {
                referenceDate: colleagueContactReferenceDate,
                windowDays: normalizedColleagueContactWindowDays
              }
            ));
          } catch (error) {
            colleagueContact = {
              checked: false,
              panel_found: false,
              recent: null,
              indeterminate: true,
              reason: "inspection_failed",
              error: error?.message || String(error),
              window_days: normalizedColleagueContactWindowDays
            };
          }
          detailStep = "verify_after_colleague_contact";
          currentDomOperation = "candidate:detail-verify-after-colleague-contact";
          const boundColleagueResult = await bindRecommendColleagueContactInspectionResult(
            colleagueContact,
            { reverifyCandidateBinding: requireCurrentDetailCandidateBinding }
          );
          currentDetailCandidateBinding = boundColleagueResult.candidate_binding;
          colleagueContactSkipReason = boundColleagueResult.skip_reason;
          if (colleagueContactSkipReason) {
            detailStep = "colleague_contact_skip_result";
            currentDomOperation = "candidate:detail-colleague-contact-skip-result";
            await requireCurrentDetailCandidateBinding("before_colleague_contact_skip_result");
            detailResult = {
              candidate: screeningCandidate,
              candidate_binding: currentDetailCandidateBinding,
              detail: {
                popup_text: "",
                resume_text: ""
              },
              colleague_contact: colleagueContact,
              cv_acquisition: {
                source: colleagueContactSkipReason,
                skipped: true,
                reason: colleagueContactSkipReason
              }
            };
            detailStep = "colleague_contact_skip_close";
            currentDomOperation = "candidate:detail-colleague-contact-skip-close";
            await requireCurrentDetailCandidateBinding("before_colleague_contact_skip_close");
            detailResult.candidate_binding = currentDetailCandidateBinding;
            detailResult.close_result = await measureTiming(
              timings,
              "close_detail_ms",
              () => closeCandidateDetailWithRecovery("colleague_contact_skip_close_failed")
            );
            await maybeHumanActionCooldown("after_detail_close", timings);
          }
        }
        if (!colleagueContactSkipReason) {
          const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState);
        detailStep = "wait_network";
        currentDomOperation = "candidate:detail-network-wait";
        await requireCurrentDetailCandidateBinding("before_cv_network_wait");
        checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
        const networkWait = await measureTiming(timings, "network_cv_wait_ms", () => waitForCvNetworkEvents(
          waitForRecommendDetailNetworkEvents,
          networkRecorder,
          {
            waitPlan,
            minCount: 1,
            requireLoaded: true,
            intervalMs: 120
          }
        ));
        if (networkWait?.elapsed_ms != null) {
          timings.network_cv_wait_ms = Math.round(Number(networkWait.elapsed_ms) || 0);
        }
        detailStep = "extract_detail";
        currentDomOperation = "candidate:detail-extract";
        await requireCurrentDetailCandidateBinding("before_cv_extract");
        checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
        detailResult = await extractRecommendDetailCandidate(client, {
          cardCandidate,
          cardNodeId,
          detailState: openedDetailState,
          networkEvents: networkRecorder.events,
          targetUrl,
          closeDetail: false,
          networkParseRetryMs: waitPlan.mode_before === "image" ? 500 : 2200,
          networkParseIntervalMs: 250
        });
        addTiming(timings, "late_network_retry_ms", detailResult.network_parse_retry_elapsed_ms);
        if (colleagueContact) detailResult.colleague_contact = colleagueContact;

        const parsedNetworkProfileCount = countParsedNetworkProfiles(detailResult);
        let source = "network";
        let imageEvidence = null;
        let captureTarget = null;
        let captureTargetWait = null;
        if (parsedNetworkProfileCount > 0) {
          recordCvNetworkHit(cvAcquisitionState, {
            parsedNetworkProfileCount,
            waitResult: networkWait
          });
        } else {
          detailStep = "wait_capture_target";
          currentDomOperation = "candidate:detail-wait-capture-target";
          await requireCurrentDetailCandidateBinding("before_cv_capture_target");
          checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
          captureTargetWait = await waitForCvCaptureTarget(client, openedDetailState, {
            domain: "recommend",
            timeoutMs: 6000,
            intervalMs: 250
          });
          captureTarget = captureTargetWait.target || null;
          const captureNodeId = captureTarget?.node_id || null;
          if (captureNodeId) {
            const imageEvidencePath = imageEvidenceFilePath({
              imageOutputDir,
              domain: "recommend",
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
                resumeCheckpoint,
                metadata: {
                  domain: "recommend",
                  capture_mode: "scroll_sequence",
                  acquisition_reason: "network_miss_image_fallback",
                  run_candidate_index: index,
                  candidate_key: candidateKey,
                  capture_target: target,
                  capture_target_wait: targetWait,
                  resumed_from_checkpoint: Boolean(resumeCheckpoint)
                }
              }
            );
            const reacquireCaptureTargetAfterBinding = async ({
              timeoutMs = 4000,
              intervalMs = 200
            } = {}) => {
              const reboundWait = await waitForCvCaptureTarget(client, openedDetailState, {
                domain: "recommend",
                timeoutMs,
                intervalMs
              });
              const reboundTarget = reboundWait?.target || null;
              if (!reboundTarget?.node_id) {
                const error = new Error(
                  "Recommend CV capture target was unavailable after binding re-verification"
                );
                error.code = "IMAGE_CAPTURE_TARGET_UNAVAILABLE";
                error.capture_target_wait = reboundWait || null;
                throw error;
              }
              captureTargetWait = reboundWait;
              captureTarget = reboundTarget;
              return reboundTarget;
            };
            try {
              detailStep = "capture_image";
              currentDomOperation = "candidate:detail-capture-image";
              await requireCurrentDetailCandidateBinding("before_cv_image_capture");
              checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
              // Binding re-verification obtains a fresh document tree and can
              // invalidate frontend node ids returned by the earlier target
              // discovery.  Reacquire the contained CV node after that proof,
              // then capture it without any intervening DOM-root read.
              await reacquireCaptureTargetAfterBinding();
              imageEvidence = await measureTiming(
                timings,
                "screenshot_capture_ms",
                () => captureImageForTarget(captureTarget, captureTargetWait)
              );
              imageEvidence = requireCompleteImageEvidence(imageEvidence, {
                code: "IMAGE_CAPTURE_EVIDENCE_MISSING",
                message: "Recommend CV capture returned no complete persisted evidence",
                metadata: { domain: "recommend", candidate_key: candidateKey }
              });
              source = isIncompleteImageEvidence(imageEvidence) ? "image_capture_failed" : "image";
            } catch (error) {
              if (!isRecoverableImageCaptureError(error)) throw error;
              const retryReservation = imageCaptureWorkflowRetries.consume(candidateKey);
              if (retryReservation.allowed) {
                timings.image_capture_recovery_trigger = compactError(error, "IMAGE_CAPTURE_FAILED");
                timings.image_capture_workflow_retry = retryReservation;
                checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep, error });
                const resumeCheckpoint = imageCaptureResumeCheckpoint(error);
                if (resumeCheckpoint) {
                  detailStep = "resume_image_capture_reacquire";
                  const resumeAttempt = await attemptImageCaptureCheckpointResume({
                    checkpoint: resumeCheckpoint,
                    reacquire: () => reacquireImageCaptureResumeTarget({
                      domain: "recommend",
                      getRoots: () => getRecommendRoots(client),
                      ensureViewport: (freshRoots) => ensureRecommendViewport(
                        freshRoots,
                        "image_capture_resume_reacquire"
                      ),
                      getDetailState: () => waitForRecommendDetail(client, {
                        timeoutMs: 4000,
                        intervalMs: 200
                      }),
                      isDetailAvailable: (state) => Boolean(state?.popup || state?.resumeIframe),
                      waitForTarget: (detailState) => waitForCvCaptureTarget(client, detailState, {
                        domain: "recommend",
                        timeoutMs: 4000,
                        intervalMs: 200
                      })
                    }),
                    capture: async (reacquired) => {
                      rootState = reacquired.root_state;
                      openedDetailState = reacquired.detail_state;
                      captureTarget = reacquired.target;
                      captureTargetWait = reacquired.target_wait;
                      detailStep = "resume_image_capture";
                      currentDomOperation = "candidate:detail-resume-image-capture";
                      await requireCurrentDetailCandidateBinding("before_resumed_cv_image_capture");
                      await reacquireCaptureTargetAfterBinding();
                      return measureTiming(
                        timings,
                        "screenshot_capture_ms",
                        () => captureImageForTarget(captureTarget, captureTargetWait, resumeCheckpoint)
                      );
                    }
                  });
                  if (resumeAttempt.outcome === "reacquire_failed") {
                    const reacquireError = resumeAttempt.error;
                    imageEvidence = {
                      ...createRecoverableImageCaptureEvidence(reacquireError, {
                        elapsedMs: timings.screenshot_capture_ms,
                        filePath: imageEvidencePath,
                        extension: "jpg",
                        maxScreenshots: maxImagePages
                      }),
                      coverage_complete: false,
                      resumed_from_checkpoint: true,
                      resume_checkpoint_id: resumeCheckpoint.checkpoint_id || null,
                      coverage_checkpoint: resumeCheckpoint
                    };
                    source = "image_capture_failed";
                    timings.image_capture_resume = {
                      attempted: true,
                      ok: false,
                      phase: "reacquire",
                      checkpoint_id: resumeCheckpoint.checkpoint_id || null,
                      error: compactError(reacquireError, "IMAGE_CAPTURE_RESUME_REACQUIRE_FAILED")
                    };
                  }
                  if (resumeAttempt.outcome === "completed") {
                    imageEvidence = requireCompleteImageEvidence(resumeAttempt.evidence, {
                      code: "IMAGE_CAPTURE_RESUME_EVIDENCE_MISSING",
                      message: "Recommend resumed CV capture returned no complete persisted evidence",
                      metadata: { domain: "recommend", candidate_key: candidateKey }
                    });
                    source = isIncompleteImageEvidence(imageEvidence) ? "image_capture_failed" : "image";
                    timings.image_capture_resume = {
                      attempted: true,
                      ok: !isIncompleteImageEvidence(imageEvidence),
                      phase: "capture",
                      checkpoint_id: resumeCheckpoint.checkpoint_id || null,
                      confirmed_screenshot_count: resumeCheckpoint.unique_screenshot_count || 0
                    };
                  } else if (resumeAttempt.outcome === "capture_failed") {
                    const resumeError = resumeAttempt.error;
                    imageEvidence = {
                      ...createRecoverableImageCaptureEvidence(resumeError, {
                        elapsedMs: timings.screenshot_capture_ms,
                        filePath: imageEvidencePath,
                        extension: "jpg",
                        maxScreenshots: maxImagePages
                      }),
                      coverage_complete: false,
                      resumed_from_checkpoint: true,
                      resume_checkpoint_id: resumeCheckpoint.checkpoint_id || null,
                      coverage_checkpoint: resumeError.capture_checkpoint || resumeCheckpoint
                    };
                    source = "image_capture_failed";
                    timings.image_capture_resume = {
                      attempted: true,
                      ok: false,
                      phase: "capture",
                      checkpoint_id: resumeCheckpoint.checkpoint_id || null,
                      error: compactError(resumeError, "IMAGE_CAPTURE_RESUME_FAILED")
                    };
                  }
                } else {
                  imageEvidence = {
                    ...createRecoverableImageCaptureEvidence(error, {
                      elapsedMs: timings.screenshot_capture_ms,
                      filePath: imageEvidencePath,
                      extension: "jpg",
                      maxScreenshots: maxImagePages
                    }),
                    coverage_complete: false
                  };
                  source = "image_capture_failed";
                  timings.image_capture_resume = {
                    attempted: false,
                    ok: false,
                    phase: "checkpoint",
                    error: {
                      code: "IMAGE_CAPTURE_CHECKPOINT_UNAVAILABLE",
                      message: "Capture failed without a resumable checkpoint"
                    }
                  };
                }
              } else {
                imageEvidence = {
                  ...createRecoverableImageCaptureEvidence(error, {
                    elapsedMs: timings.screenshot_capture_ms,
                    filePath: imageEvidencePath,
                    extension: "jpg",
                    maxScreenshots: maxImagePages
                  }),
                  coverage_complete: false,
                  metadata: {
                    image_capture_workflow_retry: retryReservation
                  }
                };
                source = "image_capture_failed";
              }
            }
            recordCvImageFallback(cvAcquisitionState, {
              reason: source === "image_capture_failed"
                ? "network_miss_image_capture_failed"
                : "network_miss_image_fallback",
              parsedNetworkProfileCount,
              waitResult: networkWait,
              imageEvidence
            });
          } else {
            source = "missing_capture_node";
            imageEvidence = createRequiredImageEvidenceFailure({
              code: "IMAGE_CAPTURE_TARGET_UNAVAILABLE",
              message: "Recommend CV capture target was unavailable after the network fallback missed",
              metadata: {
                domain: "recommend",
                candidate_key: candidateKey,
                capture_target_wait: captureTargetWait || null
              }
            });
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
          network_profile_binding: detailResult.network_profile_binding || null,
          image_evidence: summarizeImageEvidence(imageEvidence),
          capture_target: captureTarget || null,
          capture_target_wait: captureTargetWait
        };
        detailStep = "verify_before_screening";
        currentDomOperation = "candidate:detail-verify-before-screening";
        await requireCurrentDetailCandidateBinding("before_llm_or_local_screening");
        detailResult.candidate_binding = currentDetailCandidateBinding;
        screeningCandidate = detailResult.candidate;
        detailResult.screening_candidate_identity = assertRecommendScreeningCandidateMatchesCard({
          cardCandidate,
          screeningCandidate,
          stage: "before_screening_candidate_assignment"
        });
        }
      } catch (error) {
        if (error?.detail_candidate_binding) {
          currentDetailCandidateBinding = error.detail_candidate_binding;
        }
        if (!isRecoverableRecommendDetailError(error)) throw error;
        const staleForensic = checkpointDomStaleForensic(error, {
          phase: "recommend:detail",
          operation: currentDomOperation,
          detailStep,
          candidateIndex: index,
          candidateKey,
          cardNodeId
        });
        currentDetailCandidateBinding = preserveRecommendDetailCandidateBindingForRecovery(
          detailResult,
          currentDetailCandidateBinding
        );
        const failureDisposition = getRecommendDetailFailureDisposition(error);
        if (failureDisposition.candidate_local) {
          await containCandidateLocalDetailBindingFailure(error, {
            phase: "recommend:detail",
            operation: currentDomOperation,
            forensic: staleForensic
          });
        } else {
          const recoveryReservation = reserveRecommendDetailRecovery(
            candidateRecoveryCounts,
            candidateKey,
            1
          );
          if (recoveryReservation.allowed) {
            timings.detail_recovery_trigger = compactRecoverableDetailError(error);
            checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep, error });
            await closeRecommendDetail(client, { attemptsLimit: 2 }).catch(() => null);
            await closeRecommendAvatarPreview(client, { attemptsLimit: 2 }).catch(() => null);
            await closeRecommendBlockingPanels(client, { attemptsLimit: 2, rootState }).catch(() => null);
            try {
              const recovery = await recoverAndReapplyRecommendContext(`detail:${detailStep}`, error, {
                forceRecentNotView: true,
                technicalBudget: true
              });
              checkpointDomStaleRecovery(staleForensic, {
                status: "recovered",
                recoveryResult: recovery
              });
            } catch (recoveryError) {
              checkpointDomStaleRecovery(staleForensic, {
                status: "recovery_failed",
                recoveryError
              });
              throw recoveryError;
            }
            continue;
          }
          checkpointDomStaleRecovery(staleForensic, { status: "candidate_failed_closed" });
          recoverableDetailError = error;
          detailResult = null;
          timings.detail_recovered_error = compactRecoverableDetailError(error);
          await closeRecommendDetail(client, { attemptsLimit: 2 }).catch(() => null);
          await closeRecommendAvatarPreview(client, { attemptsLimit: 2 }).catch(() => null);
          await closeRecommendBlockingPanels(client, { attemptsLimit: 2, rootState }).catch(() => null);
        }
      }
    }

    if (!candidateLocalDetailFailurePending) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
    }
    runControl.setPhase("recommend:screening");
    let llmResult = null;
    const imageAcquisitionFailed = shouldFailClosedRecommendImageAcquisition(detailResult);
    if (useLlmScreening) {
      if (colleagueContactSkipReason || recoverableDetailError || imageAcquisitionFailed) {
        llmResult = null;
      } else if (!llmConfig) {
        llmResult = createMissingLlmConfigResult();
      } else {
        try {
          detailStep = "llm_screening_binding";
          currentDomOperation = "candidate:detail-verify-before-llm";
          await requireCurrentDetailCandidateBinding("immediately_before_llm_screening");
          detailResult.candidate_binding = currentDetailCandidateBinding;
          detailResult.screening_candidate_identity = assertRecommendScreeningCandidateMatchesCard({
            cardCandidate,
            screeningCandidate,
            stage: "immediately_before_llm_screening"
          });
          const llmTimingKey = detailResult?.image_evidence?.file_paths?.length
            ? "vision_model_ms"
            : "text_model_ms";
          llmResult = await measureTiming(timings, llmTimingKey, () => callScreeningLlm({
            candidate: screeningCandidate,
            criteria,
            config: llmConfig,
            timeoutMs: llmTimeoutMs,
            imageEvidence: detailResult?.image_evidence || null,
            maxImages: llmImageLimit,
            imageDetail: llmImageDetail
          }));
          } catch (error) {
            if (
              isRecommendScreeningIdentityMismatchError(error)
              || isRecommendDetailCandidateBindingError(error)
            ) {
              await containCandidateLocalDetailBindingFailure(error, {
                phase: "recommend:llm-binding",
                operation: currentDomOperation
              });
              llmResult = null;
            } else if (isFatalLlmProviderError(error)) {
              throw createFatalLlmRunError(error, {
                domain: "recommend",
                candidate: screeningCandidate
              });
            } else {
              llmResult = createFailedLlmScreeningResult(error);
            }
          }
      }
      if (detailResult) detailResult.llm_result = llmResult;
    }
    let screening = colleagueContactSkipReason === "skipped_recent_colleague_contact"
      ? createRecentColleagueContactSkipScreening(screeningCandidate, colleagueContact)
      : colleagueContactSkipReason === "colleague_contact_unverified"
      ? createUnverifiedColleagueContactSkipScreening(screeningCandidate, colleagueContact)
      : recoverableDetailError
      ? createRecoverableDetailFailureScreening(screeningCandidate, recoverableDetailError)
      : imageAcquisitionFailed
      ? createImageCaptureFailureScreening(screeningCandidate, {
        code: detailResult?.image_evidence?.error_code || "IMAGE_CAPTURE_EVIDENCE_MISSING",
        message: detailResult?.image_evidence?.error || "Required CV image evidence is unavailable"
      })
      : useLlmScreening
        ? llmResultToScreening(llmResult, screeningCandidate)
        : screenCandidate(screeningCandidate, { criteria });
    let actionDiscovery = null;
    let postActionResult = null;
    let closeFailureError = null;
    let closeRecoveryFailure = null;
    if (
      postActionEnabled
      && screening?.passed === true
      && detailResult
      && !colleagueContactSkipReason
    ) {
      try {
        const postActionStarted = Date.now();
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("recommend:post-action");
        detailStep = "post_action_discovery";
        currentDomOperation = "candidate:post-action-discovery";
        await requireCurrentDetailCandidateBinding("before_post_action_discovery");
        detailResult.candidate_binding = currentDetailCandidateBinding;
        checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
        await maybeHumanActionCooldown("before_post_action", timings);
        actionDiscovery = await waitForRecommendDetailActionControls(client, {
          timeoutMs: actionTimeoutMs,
          intervalMs: actionIntervalMs,
          requireAny: true
        });
        detailStep = "post_action_execute";
        currentDomOperation = "candidate:post-action-execute";
        await requireCurrentDetailCandidateBinding("before_post_action_execute");
        detailResult.candidate_binding = currentDetailCandidateBinding;
        checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
        postActionResult = await runRecommendPostAction({
          client,
          screening,
          actionDiscovery,
          postAction: normalizedPostAction,
          greetCount,
          maxGreetCount: Number.isInteger(maxGreetCount) ? maxGreetCount : null,
          executePostAction,
          afterClickDelayMs: actionAfterClickDelayMs,
          candidateId: screeningCandidate.id || cardCandidate.id || "",
          candidateBinding: currentDetailCandidateBinding,
          reverifyCandidateBinding: async (stage, options = {}) => {
            await requireCurrentDetailCandidateBinding(stage, options);
            detailResult.candidate_binding = currentDetailCandidateBinding;
            checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep: stage });
            return currentDetailCandidateBinding;
          },
          actionJournal: effectiveActionJournal,
          actionJournalScope,
          reverifyActionJournalScope,
          runId: runControl.runId,
          checkpointCritical: (patch) => runControl.checkpointCritical(patch)
        });
        if (postActionResult.greet_budget_consumed === true) {
          greetCount += 1;
        }
        addTiming(timings, "post_action_ms", Date.now() - postActionStarted);
      } catch (error) {
        const postActionForensic = checkpointDomStaleForensic(error, {
          phase: "recommend:post-action",
          operation: currentDomOperation,
          detailStep,
          candidateIndex: index,
          candidateKey,
          cardNodeId
        });
        if (
          isRecommendDetailCandidateBindingError(error)
          || isCandidateLocalRecommendPreOutboundActionError(error)
          || (
            detailStep === "post_action_discovery"
            && error?.recommend_input_dispatched !== true
          )
        ) {
          await containCandidateLocalDetailBindingFailure(error, {
            phase: isRecommendDetailCandidateBindingError(error)
              ? "recommend:post-action-binding"
              : "recommend:post-action-pre-outbound",
            operation: currentDomOperation,
            forensic: postActionForensic
          });
          screening = createRecoverableDetailFailureScreening(screeningCandidate, error);
          actionDiscovery = null;
          postActionResult = null;
        } else {
          throw error;
        }
      }
    }
    if (postActionResult?.stop_run) {
      const preservePostInputDetail = postActionResult?.preserve_detail_on_terminal === true;
      timings.total_ms = Date.now() - candidateStarted;
      const stopResult = {
        index,
        candidate_key: candidateKey,
        card_node_id: cardNodeId,
        candidate_binding: compactRecommendDetailCandidateBinding(currentDetailCandidateBinding),
        candidate: compactCandidate(screeningCandidate),
        detail: compactDetail(detailResult),
        llm_screening: detailResult ? null : compactScreeningLlmResult(llmResult),
        screening: compactScreening(screening),
        action_discovery: compactActionDiscovery(actionDiscovery),
        post_action: postActionResult,
        error: recoverableDetailError
          ? compactRecoverableDetailError(recoverableDetailError)
          : detailResult?.image_evidence?.ok === false
          ? compactError({
            code: detailResult.image_evidence.error_code,
            message: detailResult.image_evidence.error
          }, "IMAGE_CAPTURE_FAILED")
          : null,
        timings
      };
      await persistCandidateResult(stopResult);
      retainCommittedResult(stopResult);
      markInfiniteListCandidateProcessed(listState, candidateKey, {
        metadata: {
          result_index: index,
          candidate_id: screeningCandidate.id || null
        }
      });
      updateRecommendProgress({
        last_candidate_id: screeningCandidate.id || null,
        last_candidate_key: candidateKey,
        last_score: screening.score
      });
      const terminalCandidateCheckpoint = {
        in_progress_candidate: null,
        ...candidateResultJournalCheckpointPatch(),
        preserve_detail_on_terminal: preservePostInputDetail,
        action_result_critical_persisted: !preservePostInputDetail,
        terminal_preservation: preservePostInputDetail
          ? postActionResult.terminal_preservation || {
              required: true,
              reason: "post_input_action_journal_persistence_failed",
              candidate_id: screeningCandidate.id || null,
              action_state: postActionResult?.action_transaction?.state || null,
              result_index: index
            }
          : null,
        last_candidate: {
          id: screeningCandidate.id || null,
          key: candidateKey,
          identity: screeningCandidate.identity || {},
          candidate_binding: compactRecommendDetailCandidateBinding(currentDetailCandidateBinding),
          screening: {
            status: screening.status,
            passed: screening.passed,
            score: screening.score
          },
          llm_screening: compactScreeningLlmResult(llmResult),
          error: stopResult.error,
          post_action: postActionResult
        }
      };
      checkpointRecommendPostActionStopResult(runControl, terminalCandidateCheckpoint, {
        candidateResult: stopResult,
        candidateId: screeningCandidate.id || "",
        actionState: postActionResult?.action_transaction?.state || null,
        resultIndex: index
      });
      listEndReason = postActionResult.reason || "post_action_stop";
      break;
    }
    const durablePostActionState = postActionResult?.action_transaction?.state || null;
    if (
      postActionResult?.greet_budget_consumed === true
      && ["greeting_confirmed", RECOMMEND_GREETING_ASSUMED_SENT_STATE].includes(
        durablePostActionState
      )
    ) {
      const durablePostActionResult = {
        index,
        candidate_key: candidateKey,
        card_node_id: cardNodeId,
        candidate_binding: compactRecommendDetailCandidateBinding(currentDetailCandidateBinding),
        candidate: compactCandidate(screeningCandidate),
        detail: compactDetail(detailResult),
        llm_screening: detailResult ? null : compactScreeningLlmResult(llmResult),
        screening: compactScreening(screening),
        action_discovery: compactActionDiscovery(actionDiscovery),
        post_action: postActionResult,
        error: recoverableDetailError
          ? compactRecoverableDetailError(recoverableDetailError)
          : detailResult?.image_evidence?.ok === false
          ? compactError({
              code: detailResult.image_evidence.error_code,
              message: detailResult.image_evidence.error
            }, "IMAGE_CAPTURE_FAILED")
          : null,
        timings: {
          ...timings,
          total_ms: Date.now() - candidateStarted
        },
        provisional_before_detail_cleanup: true
      };
      await persistCandidateResult(durablePostActionResult);
      checkpointRecommendPostActionStopResult(runControl, {
        in_progress_candidate: null,
        ...candidateResultJournalCheckpointPatch(),
        preserve_detail_on_terminal: false,
        action_result_critical_persisted: true,
        post_action_candidate_result_persisted: true,
        last_candidate: {
          id: screeningCandidate.id || null,
          key: candidateKey,
          identity: screeningCandidate.identity || {},
          candidate_binding: compactRecommendDetailCandidateBinding(currentDetailCandidateBinding),
          screening: {
            status: screening.status,
            passed: screening.passed,
            score: screening.score
          },
          llm_screening: compactScreeningLlmResult(llmResult),
          error: durablePostActionResult.error,
          post_action: postActionResult
        }
      }, {
        candidateResult: durablePostActionResult,
        candidateId: screeningCandidate.id || "",
        actionState: durablePostActionState,
        resultIndex: index
      });
    }
    if (detailResult && closeDetail && !detailResult.close_result?.closed) {
      runControl.setPhase("recommend:close-detail");
      detailStep = "close_detail";
      currentDomOperation = "candidate:close-detail";
      checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
      try {
        detailResult.close_result = await measureTiming(
          timings,
          "close_detail_ms",
          () => closeRecommendDetail(client)
        );
      } catch (error) {
        checkpointDomStaleForensic(error, {
          phase: "recommend:close-detail",
          operation: currentDomOperation,
          detailStep,
          candidateIndex: index,
          candidateKey,
          cardNodeId
        });
        closeFailureError = error instanceof Error
          ? error
          : new Error(String(error || "Recommend detail close failed"));
        closeFailureError.code = closeFailureError.code || "DETAIL_CLOSE_FAILED";
        closeFailureError.phase = closeFailureError.phase || "recommend:close-detail";
        detailResult.close_result = {
          closed: false,
          reason: "close_threw",
          error: closeFailureError.message
        };
      }
      await maybeHumanActionCooldown("after_detail_close", timings);
      if (!detailResult.close_result?.closed) {
        closeFailureError = closeFailureError || createRecommendCloseFailureError(detailResult.close_result);
        try {
          const recovery = await recoverAndReapplyRecommendContext("detail_close_failed", closeFailureError, {
            forceRecentNotView: true,
            technicalBudget: true
          });
          detailResult.cv_acquisition = {
            ...(detailResult.cv_acquisition || {}),
            close_recovery: {
              ok: Boolean(recovery.ok),
              method: recovery.method || "",
              forced_recent_not_view: Boolean(recovery.forced_recent_not_view),
              card_count: recovery.card_count || 0
            }
          };
        } catch (error) {
          closeRecoveryFailure = error;
          detailResult.cv_acquisition = {
            ...(detailResult.cv_acquisition || {}),
            close_recovery: {
              ok: false,
              reason: "context_recovery_failed",
              error: error?.message || String(error),
              forced_recent_not_view: Boolean(normalizedFilter.enabled)
            }
          };
        }
      }
    }
    timings.total_ms = Date.now() - candidateStarted;
    const compactResult = {
      index,
      candidate_key: candidateKey,
      card_node_id: cardNodeId,
      candidate_binding: compactRecommendDetailCandidateBinding(currentDetailCandidateBinding),
      candidate: compactCandidate(screeningCandidate),
      detail: compactDetail(detailResult),
      llm_screening: detailResult ? null : compactScreeningLlmResult(llmResult),
      screening: compactScreening(screening),
      action_discovery: compactActionDiscovery(actionDiscovery),
      post_action: postActionResult,
      error: recoverableDetailError
        ? compactRecoverableDetailError(recoverableDetailError)
        : closeRecoveryFailure
        ? compactError(closeFailureError, "DETAIL_CLOSE_FAILED")
        : detailResult?.image_evidence?.ok === false
        ? compactError({
          code: detailResult.image_evidence.error_code,
          message: detailResult.image_evidence.error
        }, "IMAGE_CAPTURE_FAILED")
        : null,
      timings
    };
    await persistCandidateResult(compactResult);
    retainCommittedResult(compactResult);
    technicalRecoveryAttemptsWithoutProgress = 0;
    markInfiniteListCandidateProcessed(listState, candidateKey, {
      metadata: {
        result_index: index,
        candidate_id: screeningCandidate.id || null
      }
    });
    candidateRecoveryCounts.delete(candidateKey);
    imageCaptureWorkflowRetries.release?.(candidateKey);

    updateRecommendProgress({
      last_candidate_id: screeningCandidate.id || null,
      last_candidate_key: candidateKey,
      last_score: screening.score
    });
    const checkpointStarted = Date.now();
    const completedCandidateCheckpoint = {
      in_progress_candidate: null,
      ...candidateResultJournalCheckpointPatch(),
      candidate_list: compactInfiniteListState(listState),
      candidate_local_detail_failure: candidateLocalDetailFailurePending
        ? {
            required: true,
            terminal: Boolean(candidateLocalDetailTerminalError),
            candidate_id: screeningCandidate.id || null,
            candidate_key: candidateKey,
            result_index: index,
            binding: compactRecommendDetailCandidateBinding(currentDetailCandidateBinding),
            cleanup: timings.detail_candidate_local_cleanup || null
          }
        : null,
      candidate_local_detail_terminal: candidateLocalDetailTerminalError
        ? {
            required: true,
            code: candidateLocalDetailTerminalError.code || null,
            phase: candidateLocalDetailTerminalError.phase || null,
            candidate_id: screeningCandidate.id || null,
            candidate_key: candidateKey,
            result_index: index,
            cleanup: candidateLocalDetailTerminalError.cleanup || null
          }
        : null,
      last_candidate: {
        id: screeningCandidate.id || null,
        key: candidateKey,
        identity: screeningCandidate.identity || {},
        candidate_binding: compactRecommendDetailCandidateBinding(currentDetailCandidateBinding),
        screening: {
          status: screening.status,
          passed: screening.passed,
          score: screening.score
        },
        llm_screening: compactScreeningLlmResult(llmResult),
        error: compactResult.error,
          post_action: postActionResult
        }
    };
    if (candidateLocalDetailFailurePending) {
      runControl.checkpointCritical(completedCandidateCheckpoint);
    } else {
      runControl.checkpoint(completedCandidateCheckpoint);
    }
    addTiming(compactResult.timings, "checkpoint_save_ms", Date.now() - checkpointStarted);

    if (candidateLocalDetailTerminalError) {
      candidateLocalDetailTerminalError.candidate_result_persisted = true;
      candidateLocalDetailTerminalError.candidate_result_index = index;
      throw candidateLocalDetailTerminalError;
    }

    if (candidateLocalDetailFailurePending) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
    }

    if (closeRecoveryFailure) {
      throw closeRecoveryFailure;
    }

    if (postActionResult?.stop_run) {
      listEndReason = postActionResult.reason || "post_action_stop";
      break;
    }

    if (effectiveHumanRestEnabled) {
      const restStarted = Date.now();
      try {
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
          updateRecommendProgress({
            human_rest_level: effectiveHumanBehavior.restLevel,
            human_rest_last: restResult
          });
        }
      } catch (restError) {
        runControl.throwIfCanceled();
        compactResult.human_rest = {
          rested: false,
          degraded: true,
          error: compactError(restError, "RECOMMEND_HUMAN_REST_FAILED")
        };
        updateRecommendProgress({
          human_rest_degraded: true,
          human_rest_last_error: compactResult.human_rest.error
        });
        runControl.checkpoint({
          human_rest_warning: {
            candidate_id: screeningCandidate.id || null,
            candidate_key: candidateKey,
            error: compactResult.human_rest.error
          }
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

  runControl.setPhase("recommend:done");
  const statusCounts = currentResultStatusCounts();
  const completion = classifyRecommendWorkflowCompletion({
    passedCount: statusCounts.passed,
    targetCount: targetPassCount,
    listEndReason
  });
  return {
    domain: "recommend",
    target_count: targetPassCount,
    target_url: targetUrl,
    job_selection: compactJobSelection(jobSelection),
    page_scope: compactPageScopeSelection(pageScopeSelection),
    current_city_only: compactCurrentCityOnlyResult(currentCityOnlyResult),
    filter: compactFilterResult(filterResult),
    card_count: cardNodeIds.length,
    candidate_list: compactInfiniteListState(listState),
    viewport_health: {
      stats: viewportGuard.getStats(),
      events: viewportGuard.getEvents()
    },
    human_behavior: effectiveHumanBehavior,
    human_rest: humanRestController.getState(),
    last_human_event: lastHumanEvent,
    list_end_reason: listEndReason || null,
    refresh_rounds: refreshRounds,
    exhaustion_refresh_rounds: refreshRounds,
    max_exhaustion_refresh_rounds: effectiveMaxRefreshRounds,
    consecutive_refresh_attempts_without_progress: refreshRounds,
    exhaustion_refresh_budget_scope: "run_lifetime",
    exhaustion_refresh_round_semantics: "source_exhaustion_recovery_cycle",
    exhaustion_refresh_budget_resets_on_candidate_progress: false,
    refresh_attempt_count: refreshAttemptCount,
    refresh_attempts_truncated: refreshAttemptCount > refreshAttempts.length,
    refresh_attempts: refreshAttempts,
    context_recoveries: contextRecoveryAttempts,
    technical_recovery_attempts_without_progress: technicalRecoveryAttemptsWithoutProgress,
    technical_recovery_max_attempts: RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS,
    technical_recovery_budget_scope: "until_candidate_result_persisted",
    debug_boundary: debugBoundary.getState(),
    list_read_stale_recovery_attempts: listReadStaleRecoveryAttempts,
    list_read_stale_recovery_applied: listReadStaleRecoveryApplied,
    list_read_stale_recoveries: listReadStaleRecoveries,
    last_list_read_recovery_mode: lastListReadRecoveryMode,
    last_list_read_stale_diagnostic: lastListReadStaleDiagnostic,
    list_read_stale_diagnostics: listReadStaleDiagnostics.slice(-12),
    dom_stale_events: domStaleEventCount,
    dom_stale_forensics: domStaleForensics.slice(-12),
    dom_lifecycle_timeline: domLifecycleTimeline.slice(-20),
    candidate_result_journal: candidateResultJournal
      ? candidateResultJournalCheckpointPatch().candidate_result_journal
      : null,
    ...completion,
    ...statusCounts,
    transient_recovered: statusCounts.transient_recovered
      + listReadStaleRecoveries,
    results_count: statusCounts.processed,
    results_truncated: statusCounts.processed > results.length,
    results_tail_limit: candidateResultJournal
      ? RECOMMEND_RESULT_MEMORY_TAIL_LIMIT
      : null,
    results
  };
}

function createRecommendPostActionTerminalFailure(summary = null) {
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const stoppedResult = [...results].reverse().find((result) => (
    result?.post_action?.stop_run === true
  )) || null;
  const postAction = stoppedResult?.post_action || null;
  if (!postAction) return null;
  if (
    postAction.out_of_greet_credits === true
    || postAction.reason === "greet_credits_exhausted"
  ) return null;
  const reason = String(postAction.reason || summary?.list_end_reason || "unknown").trim();
  const error = new Error(`Recommend post-action terminal failure: ${reason}`);
  error.code = postAction.outcome_unknown === true
    ? "RECOMMEND_GREET_OUTCOME_UNKNOWN"
    : postAction.pre_input_aborted === true
    ? "RECOMMEND_GREET_PRE_INPUT_ABORTED"
    : "RECOMMEND_POST_ACTION_TERMINAL_FAILURE";
  error.phase = "recommend:post-action-terminal";
  error.run_summary = summary;
  return error;
}

export function createRecommendRunService({
  lifecycle,
  idPrefix = "recommend",
  workflow = runRecommendWorkflow,
  onSnapshot = null
} = {}) {
  const manager = lifecycle || createRunLifecycleManager({ idPrefix, onSnapshot });

  function startRecommendRun({
    runId = "",
    pid = process.pid,
    client,
    targetUrl = "",
    criteria = "",
    jobLabel = "",
    pageScope = "recommend",
    fallbackPageScope = "recommend",
    filter = {},
    maxCandidates = 5,
    detailLimit,
    closeDetail = true,
    delayMs = 0,
    cardTimeoutMs = 10000,
    maxImagePages = DEFAULT_MAX_IMAGE_PAGES,
    imageWheelDeltaY = 650,
    cvAcquisitionMode = "unknown",
    listMaxScrolls = 20,
    listStableSignatureLimit = 5,
    listWheelDeltaY = 850,
    listSettleMs = 2200,
    listFallbackPoint = null,
    refreshOnEnd = true,
    maxRefreshRounds = 2,
    refreshButtonSettleMs = 8000,
    refreshReloadSettleMs = 8000,
    postAction = "none",
    maxGreetCount = null,
    executePostAction = true,
    actionTimeoutMs = 8000,
    actionIntervalMs = 500,
    actionAfterClickDelayMs = 900,
    actionJournal = null,
    actionJournalScope = "boss-recommend:default",
    reverifyActionJournalScope = null,
    screeningMode = "llm",
    llmConfig = null,
    llmTimeoutMs = 120000,
    llmImageLimit = 8,
    llmImageDetail = "high",
    imageOutputDir = "",
    candidateResultJournalDir = "",
    humanRestEnabled = false,
    humanBehavior = null,
    skipRecentColleagueContacted = true,
    colleagueContactWindowDays = 14,
    debugTestMode = undefined,
    debugForceListEndAfterProcessed = undefined,
    debugForceContextRecoveryAfterProcessed = undefined,
    debugForceCdpReconnectAfterProcessed = undefined,
    name = "recommend-domain-run"
  } = {}) {
    if (!client) throw new Error("startRecommendRun requires a guarded CDP client");
    const normalizedFilter = normalizeFilter(filter);
    const normalizedPostAction = normalizeRecommendPostAction(postAction) || "none";
    const requestedPageScope = normalizeRecommendPageScope(pageScope) || "recommend";
    const normalizedFallbackPageScope = normalizeRecommendPageScope(fallbackPageScope) || "recommend";
    const normalizedScreeningMode = normalizeScreeningMode(screeningMode);
    const shouldSkipRecentColleagueContacted = skipRecentColleagueContacted !== false;
    const normalizedColleagueContactWindowDays = Math.max(1, Number(colleagueContactWindowDays) || 14);
    const effectiveHumanBehavior = normalizeHumanBehaviorOptions(humanBehavior, {
      legacyEnabled: humanRestEnabled === true || llmConfig?.humanRestEnabled === true
    });
    const effectiveHumanRestEnabled = effectiveHumanBehavior.restEnabled;
    const candidateLimit = Math.max(1, Number(maxCandidates) || 1);
    const normalizedDetailLimit = detailLimit == null ? null : Math.max(0, Number(detailLimit) || 0);
    const effectiveMaxRefreshRounds = normalizeRecommendRefreshRoundLimit(maxRefreshRounds);
    const debugBoundaryOptions = normalizeRecommendDebugBoundaryOptions({
      debugTestMode: debugTestMode === true,
      debugForceListEndAfterProcessed: debugForceListEndAfterProcessed ?? null,
      debugForceContextRecoveryAfterProcessed: debugForceContextRecoveryAfterProcessed ?? null,
      debugForceCdpReconnectAfterProcessed: debugForceCdpReconnectAfterProcessed ?? null
    });
    return manager.startRun({
      runId,
      name,
      pid,
      context: {
        domain: "recommend",
        target_url: targetUrl,
        criteria_present: Boolean(criteria),
        job_label: jobLabel || "",
        requested_page_scope: requestedPageScope,
        fallback_page_scope: normalizedFallbackPageScope,
        filter: normalizedFilter,
        current_city_only_requested: normalizedFilter.currentCityOnly,
        max_candidates: maxCandidates,
        max_candidates_semantics: "passed_candidates",
        detail_limit: normalizedDetailLimit,
        close_detail: closeDetail,
        cv_acquisition_mode: cvAcquisitionMode,
        max_image_pages: maxImagePages,
        image_wheel_delta_y: imageWheelDeltaY,
        list_max_scrolls: listMaxScrolls,
        list_stable_signature_limit: listStableSignatureLimit,
        list_wheel_delta_y: listWheelDeltaY,
        list_settle_ms: listSettleMs,
        list_fallback_point: listFallbackPoint,
        refresh_on_end: refreshOnEnd,
        max_refresh_rounds: effectiveMaxRefreshRounds,
        exhaustion_refresh_budget_scope: "run_lifetime",
        exhaustion_refresh_budget_resets_on_candidate_progress: false,
        context_recovery_max_attempts: RECOMMEND_CONTEXT_RECOVERY_MAX_ATTEMPTS,
        refresh_button_settle_ms: refreshButtonSettleMs,
        refresh_reload_settle_ms: refreshReloadSettleMs,
        post_action: normalizedPostAction,
        max_greet_count: Number.isInteger(maxGreetCount) ? maxGreetCount : null,
        greeting_uncertainty_policy: RECOMMEND_GREETING_ASSUMPTION_POLICY,
        execute_post_action: Boolean(executePostAction),
        action_timeout_ms: actionTimeoutMs,
        action_journal_enabled: Boolean(normalizedPostAction !== "none" && executePostAction),
        action_journal_scope: actionJournalScope,
        screening_mode: normalizedScreeningMode,
        llm_configured: Boolean(llmConfig),
        llm_timeout_ms: llmTimeoutMs,
        llm_image_limit: llmImageLimit,
        llm_image_detail: llmImageDetail,
        image_output_dir: imageOutputDir || "",
        candidate_result_journal_enabled: Boolean(candidateResultJournalDir),
        skip_recent_colleague_contacted: shouldSkipRecentColleagueContacted,
        colleague_contact_window_days: normalizedColleagueContactWindowDays,
        human_behavior_enabled: effectiveHumanBehavior.enabled,
        human_behavior_profile: effectiveHumanBehavior.profile,
        human_behavior: effectiveHumanBehavior,
        human_rest_level: effectiveHumanBehavior.restLevel,
        human_rest_enabled: effectiveHumanRestEnabled,
        debug_test_mode: debugBoundaryOptions.debugTestMode,
        debug_boundary_mode: debugBoundaryOptions.mode,
        debug_boundary_threshold: debugBoundaryOptions.threshold
      },
      progress: {
        card_count: 0,
        target_count: candidateLimit,
        target_count_semantics: "passed_candidates",
        processed: 0,
        screened: 0,
        detail_opened: 0,
        llm_screened: 0,
        passed: 0,
        skipped: 0,
        greet_count: 0,
        greet_confirmed_count: 0,
        greet_assumed_sent_count: 0,
        greet_protected_no_replay_count: 0,
        post_action_clicked: 0,
        image_capture_failed: 0,
        detail_open_failed: 0,
        transient_recovered: 0,
        colleague_contact_checked: 0,
        recent_colleague_contact_skipped: 0,
        colleague_contact_panel_missing: 0,
        context_recoveries: 0,
        context_recovery_consecutive_failures: 0,
        current_city_only_requested: normalizedFilter.currentCityOnly,
        current_city_only_effective: null,
        current_city_only_unavailable: false,
        human_behavior_enabled: effectiveHumanBehavior.enabled,
        human_behavior_profile: effectiveHumanBehavior.profile,
        human_rest_level: effectiveHumanBehavior.restLevel,
        human_rest_enabled: effectiveHumanRestEnabled,
        human_rest_count: 0,
        human_rest_ms: 0,
        last_human_event: null,
        debug_boundary_mode: debugBoundaryOptions.mode,
        debug_boundary_threshold: debugBoundaryOptions.threshold,
        debug_boundary_triggered: false,
        debug_boundary_trigger_count: 0
      },
      checkpoint: {},
      task: async (runControl) => {
        const summary = await workflow({
          client,
          targetUrl,
          criteria,
          jobLabel,
          pageScope: requestedPageScope,
          fallbackPageScope: normalizedFallbackPageScope,
          filter: normalizedFilter,
          maxCandidates,
          detailLimit: normalizedDetailLimit,
          closeDetail,
          delayMs,
          cardTimeoutMs,
          maxImagePages,
          imageWheelDeltaY,
          cvAcquisitionMode,
          listMaxScrolls,
          listStableSignatureLimit,
          listWheelDeltaY,
          listSettleMs,
          listFallbackPoint,
          refreshOnEnd,
          maxRefreshRounds: effectiveMaxRefreshRounds,
          refreshButtonSettleMs,
          refreshReloadSettleMs,
          postAction: normalizedPostAction,
          maxGreetCount,
          executePostAction,
          actionTimeoutMs,
          actionIntervalMs,
          actionAfterClickDelayMs,
          actionJournal,
          actionJournalScope,
          reverifyActionJournalScope,
          screeningMode: normalizedScreeningMode,
          llmConfig,
          llmTimeoutMs,
          llmImageLimit,
          llmImageDetail,
          imageOutputDir,
          candidateResultJournalDir,
          humanRestEnabled: effectiveHumanRestEnabled,
          humanBehavior: effectiveHumanBehavior,
          skipRecentColleagueContacted: shouldSkipRecentColleagueContacted,
          colleagueContactWindowDays: normalizedColleagueContactWindowDays,
          debugTestMode: debugBoundaryOptions.debugTestMode,
          debugForceListEndAfterProcessed: debugBoundaryOptions.debugForceListEndAfterProcessed,
          debugForceContextRecoveryAfterProcessed: debugBoundaryOptions.debugForceContextRecoveryAfterProcessed,
          debugForceCdpReconnectAfterProcessed: debugBoundaryOptions.debugForceCdpReconnectAfterProcessed
        }, runControl);
        const terminalFailure = createRecommendPostActionTerminalFailure(summary);
        if (terminalFailure) throw terminalFailure;
        const underfillFailure = createRecommendSourceUnverifiedUnderfillError(summary);
        if (underfillFailure) throw underfillFailure;
        return summary;
      }
    });
  }

  return {
    startRecommendRun,
    getRecommendRun: manager.getRun,
    pauseRecommendRun: manager.pauseRun,
    resumeRecommendRun: manager.resumeRun,
    cancelRecommendRun: manager.cancelRun,
    waitForRecommendRun: manager.waitForRun,
    listRecommendRuns: manager.listRuns,
    manager
  };
}
