import fs from "node:fs";
import path from "node:path";
import { createRunLifecycleManager } from "../../core/run/index.js";
import {
  addTiming,
  imageEvidenceFilePath,
  measureTiming
} from "../../core/run/timing.js";
import { captureScrolledNodeScreenshots } from "../../core/capture/index.js";
import { waitForCvCaptureTarget } from "../../core/cv-capture-target/index.js";
import {
  configureHumanInteraction,
  createHumanRestController,
  humanDelay,
  normalizeHumanBehaviorOptions
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
import {
  callScreeningLlm,
  compactScreeningLlmResult,
  createFailedLlmScreeningResult,
  llmResultToScreening,
  screenCandidate
} from "../../core/screening/index.js";
import {
  closeRecruitBlockingPanels,
  closeRecruitDetail,
  createRecruitDetailNetworkRecorder,
  extractRecruitDetailCandidate,
  openRecruitCardDetail,
  waitForRecruitDetailNetworkEvents
} from "./detail.js";
import {
  readRecruitCardCandidate,
  waitForRecruitCardNodeIds
} from "./cards.js";
import {
  applyRecruitSearchParams,
  hasRecruitSearchParams,
  normalizeRecruitSearchParams
} from "./search.js";
import { refreshRecruitSearchAtEnd } from "./refresh.js";
import { getRecruitRoots } from "./roots.js";
import {
  RECRUIT_BOTTOM_MARKER_SELECTORS,
  RECRUIT_BOTTOM_REFRESH_SELECTORS,
  RECRUIT_CARD_SELECTOR,
  RECRUIT_LIST_CONTAINER_SELECTORS
} from "./constants.js";

function compactScreening(screening) {
  return {
    status: screening.status,
    passed: screening.passed,
    score: screening.score,
    reasons: screening.reasons,
    candidate: {
      domain: screening.candidate?.domain || "recruit",
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

function compactDetail(detailResult) {
  if (!detailResult) return null;
  return {
    popup_text_length: detailResult.detail?.popup_text?.length || 0,
    resume_text_length: detailResult.detail?.resume_text?.length || 0,
    network_body_count: detailResult.network_bodies?.filter((item) => item.body).length || 0,
    parsed_network_profile_count: detailResult.parsed_network_profiles?.filter((item) => item.ok).length || 0,
    cv_acquisition: detailResult.cv_acquisition || null,
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
  return createFailedLlmScreeningResult(new Error("LLM screening config is required for production search runs"));
}

function normalizeSearchParams(searchParams = {}) {
  return normalizeRecruitSearchParams(searchParams);
}

function compactRefreshAttempt(refreshAttempt) {
  if (!refreshAttempt) return null;
  return {
    ok: Boolean(refreshAttempt.ok),
    method: refreshAttempt.method || "",
    forced_recent_viewed: Boolean(refreshAttempt.forced_recent_viewed),
    card_count: refreshAttempt.card_count || 0,
    search_params: refreshAttempt.search_params || null,
    recovery_settle: refreshAttempt.recovery_settle
      ? {
          ok: Boolean(refreshAttempt.recovery_settle.ok),
          status: refreshAttempt.recovery_settle.status || "",
          reason: refreshAttempt.recovery_settle.reason || "",
          elapsed_ms: refreshAttempt.recovery_settle.elapsed_ms || 0
        }
      : null,
    application: refreshAttempt.application
      ? {
          applied: Boolean(refreshAttempt.application.applied),
          post_search_state: refreshAttempt.application.post_search_state,
          steps: (refreshAttempt.application.steps || []).map((step) => ({
            step: step.step,
            applied: step.result?.applied,
            clicked: step.result?.clicked,
            searched: step.result?.searched,
            reason: step.result?.reason || null
          }))
        }
      : null
  };
}

function compactError(error, fallbackCode = "RECRUIT_RUN_ERROR") {
  if (!error) return null;
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
  if (error.list_end_reason) {
    result.list_end_reason = error.list_end_reason;
  }
  if (error.target_count != null) {
    result.target_count = error.target_count;
  }
  if (error.processed_count != null) {
    result.processed_count = error.processed_count;
  }
  return result;
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

function createRecruitCloseFailureError(closeResult) {
  const error = new Error(closeResult?.reason || "Recruit detail did not close before recovery");
  error.code = "DETAIL_CLOSE_FAILED";
  error.close_result = closeResult || null;
  return error;
}

function createRecruitBlockingPanelCloseFailureError(closeResult, phase = "") {
  const error = new Error(closeResult?.reason || "Boss account-rights panel did not close before recovery");
  error.code = "ACCOUNT_RIGHTS_PANEL_CLOSE_FAILED";
  error.close_result = closeResult || null;
  error.phase = phase || null;
  return error;
}

function createRecruitRefreshFailureError(refreshAttempt, {
  listEndReason = "",
  targetCount = 0,
  processedCount = 0
} = {}) {
  const reason = refreshAttempt?.application?.post_search_state?.ok === false
    ? "search_result_not_ready"
    : refreshAttempt?.application?.post_search_state?.counts?.candidate_card === 0
      ? "no_cards_after_refresh"
      : "refresh_failed";
  const error = new Error(`Recruit/search refresh failed before target was reached (${reason})`);
  error.code = "RECRUIT_END_REFRESH_FAILED";
  error.refresh_attempt = refreshAttempt || null;
  error.list_end_reason = listEndReason || null;
  error.target_count = targetCount;
  error.processed_count = processedCount;
  return error;
}

function isRefreshableListStall(reason = "") {
  return new Set([
    "stable_visible_signature",
    "max_scrolls_exhausted",
    "scroll_failed",
    "scroll_anchor_unavailable"
  ]).has(String(reason || ""));
}

export function isStaleRecruitNodeError(error) {
  const message = String(error?.message || error || "");
  return /Could not find node with given id|No node with given id|Node is detached|Cannot find node/i.test(message);
}

export function isRecoverableRecruitImageCaptureError(error) {
  const code = String(error?.code || "");
  if (code === "IMAGE_CAPTURE_TIMEOUT" || code === "IMAGE_CAPTURE_TOTAL_TIMEOUT") return true;
  if (isStaleRecruitNodeError(error)) return true;
  return /Image fallback capture timed out/i.test(String(error?.message || error || ""));
}

export function isRecoverableRecruitDetailError(error) {
  return isStaleRecruitNodeError(error);
}

function compactRecoverableDetailError(error) {
  return compactError(error, isStaleRecruitNodeError(error) ? "DETAIL_STALE_NODE" : "DETAIL_OPEN_FAILED");
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

export function createRecoverableRecruitImageCaptureEvidence(error, {
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
    error_code: error?.code || (isStaleRecruitNodeError(error) ? "IMAGE_CAPTURE_STALE_NODE" : "IMAGE_CAPTURE_FAILED"),
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

function createRecoverableDetailFailureScreening(candidate, error) {
  return {
    status: "fail",
    passed: false,
    score: 0,
    reasons: isStaleRecruitNodeError(error)
      ? ["detail_open_failed", "stale_node"]
      : ["detail_open_failed"],
    error: compactRecoverableDetailError(error),
    candidate
  };
}

export function countRecruitResultStatuses(results = []) {
  return {
    processed: results.length,
    screened: results.length,
    detail_opened: results.filter((item) => item.detail).length,
    passed: results.filter((item) => item.screening?.passed).length,
    llm_screened: results.filter((item) => item.detail?.llm_screening || item.llm_screening).length,
    image_capture_failed: results.filter((item) => item.detail?.image_evidence?.ok === false).length,
    detail_open_failed: results.filter((item) => (
      item.error?.code === "DETAIL_STALE_NODE"
      || item.error?.code === "DETAIL_OPEN_FAILED"
    )).length,
    transient_recovered: results.filter((item) => (
      item.error?.code === "DETAIL_STALE_NODE"
      || item.error?.code === "IMAGE_CAPTURE_STALE_NODE"
      || item.error?.code === "IMAGE_CAPTURE_TIMEOUT"
      || item.error?.code === "IMAGE_CAPTURE_TOTAL_TIMEOUT"
    )).length
  };
}

export async function runRecruitWorkflow({
  client,
  targetUrl = "",
  criteria = "",
  searchParams = {},
  maxCandidates = 5,
  detailLimit = null,
  closeDetail = true,
  delayMs = 0,
  cardTimeoutMs = 90000,
  resetBeforeSearch = true,
  resetTimeoutMs = 180000,
  cityOptionTimeoutMs = 30000,
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
  refreshResetSettleMs = 5000,
  screeningMode = "llm",
  llmConfig = null,
  llmTimeoutMs = 120000,
  llmImageLimit = 8,
  llmImageDetail = "high",
  imageOutputDir = "",
  humanRestEnabled = false,
  humanBehavior = null
} = {}, runControl) {
  if (!client) throw new Error("runRecruitWorkflow requires a guarded CDP client");
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
    batchRestEnabled: effectiveHumanBehavior.batchRest
  });
  const normalizedSearchParams = normalizeSearchParams(searchParams);
  const normalizedScreeningMode = normalizeScreeningMode(screeningMode);
  const useLlmScreening = normalizedScreeningMode !== "deterministic";
  const limit = Math.max(1, Number(maxCandidates) || 1);
  const detailCountLimit = detailLimit == null ? limit : Math.max(0, Number(detailLimit) || 0);
  const networkRecorder = detailCountLimit > 0
    ? createRecruitDetailNetworkRecorder(client)
    : null;
  const cvAcquisitionState = createCvAcquisitionState({ mode: cvAcquisitionMode });
  const listState = createInfiniteListState({
    domain: "recruit",
    listName: "search-results"
  });
  const viewportGuard = createViewportRunGuard({
    client,
    domain: "recruit",
    root: "frame",
    frameOwnerRoot: "frameOwner",
    runControl,
    getRoots: getRecruitRoots
  });
  async function ensureRecruitViewport(rootState, phase) {
    const result = await viewportGuard.ensure(rootState, { phase });
    return result.rootState || rootState;
  }
  const results = [];
  const refreshAttempts = [];
  let refreshRounds = 0;
  let contextRecoveryAttempts = 0;
  const candidateRecoveryCounts = new Map();
  let rootState = null;
  let cardNodeIds = [];
  let listEndReason = "";
  let lastHumanEvent = null;
  const listFallbackResolver = listFallbackPoint || (async ({ items = [] } = {}) => resolveInfiniteListFallbackPoint(client, {
    rootNodeId: rootState?.iframe?.documentNodeId,
    containerSelectors: RECRUIT_LIST_CONTAINER_SELECTORS,
    itemNodeIds: items.map((item) => item.node_id).filter(Boolean),
    itemSelectors: [RECRUIT_CARD_SELECTOR],
    viewportPoint: { xRatio: 0.28, yRatio: 0.5 },
    validateViewportPoint: true
  }));

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

  function updateRecruitProgress(extra = {}) {
    const counts = countRecruitResultStatuses(results);
    const listSnapshot = compactInfiniteListState(listState);
    const humanRestState = humanRestController.getState();
    runControl.updateProgress({
      card_count: cardNodeIds.length,
      target_count: limit,
      ...counts,
      screening_mode: normalizedScreeningMode,
      unique_seen: listSnapshot.seen_count,
      scroll_count: listSnapshot.scroll_count,
      refresh_rounds: refreshRounds,
      refresh_attempts: refreshAttempts.length,
      context_recoveries: contextRecoveryAttempts,
      list_end_reason: listEndReason || null,
      viewport_checks: viewportGuard.getStats().checks,
      viewport_recoveries: viewportGuard.getStats().recoveries,
      human_behavior_enabled: effectiveHumanBehavior.enabled,
      human_behavior_profile: effectiveHumanBehavior.profile,
      human_rest_enabled: effectiveHumanRestEnabled,
      human_rest_count: humanRestState.rest_count,
      human_rest_ms: humanRestState.total_rest_ms,
      last_human_event: lastHumanEvent,
      ...extra
    });
  }

  function checkpointInProgressCandidate({
    index = results.length,
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
        counters: countRecruitResultStatuses(results),
        error: compactError(error, "RECRUIT_IN_PROGRESS_ERROR")
      },
      candidate_list: compactInfiniteListState(listState)
    });
  }

  async function closeRecruitBlockingPanelsForRun(phase = "cleanup") {
    const result = await closeRecruitBlockingPanels(client, {
      attemptsLimit: 2,
      rootState
    });
    if (!result?.closed) {
      throw createRecruitBlockingPanelCloseFailureError(result, phase);
    }
    return result;
  }

  async function recoverAndReapplyRecruitContext(reason = "context_recovery", error = null, {
    forceRecentViewed = true
  } = {}) {
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    const started = Date.now();
    runControl.setPhase("recruit:recover-context");
    contextRecoveryAttempts += 1;
    const refreshResult = await refreshRecruitSearchAtEnd(client, {
      searchParams: normalizedSearchParams,
      requireCards: true,
      searchTimeoutMs: cardTimeoutMs,
      resetTimeoutMs,
      resetSettleMs: refreshResetSettleMs,
      cityOptionTimeoutMs,
      forceRecentViewed
    });
    let blockingPanelClose = null;
    if (refreshResult.ok) {
      blockingPanelClose = await closeRecruitBlockingPanels(client, {
        attemptsLimit: 2
      });
    }
    const compactRefresh = {
      ...compactRefreshAttempt(refreshResult),
      context_recovery: true,
      recovery_reason: reason,
      trigger_error: compactError(error, "RECRUIT_CONTEXT_RECOVERY_TRIGGER"),
      account_rights_panel_close: compactCloseResult(blockingPanelClose),
      elapsed_ms: Date.now() - started
    };
    refreshAttempts.push(compactRefresh);
    runControl.checkpoint({
      context_recovery: {
        attempt: contextRecoveryAttempts,
        reason,
        trigger_error: compactError(error, "RECRUIT_CONTEXT_RECOVERY_TRIGGER"),
        refresh: compactRefresh,
        counters: countRecruitResultStatuses(results)
      },
      candidate_list: compactInfiniteListState(listState)
    });
    if (!refreshResult.ok) {
      updateRecruitProgress({
        refresh_method: refreshResult.method || null,
        refresh_forced_recent_viewed: forceRecentViewed,
        recovery_reason: reason
      });
      throw new Error(`Recruit context recovery failed after ${reason}: ${refreshResult.application?.reason || "refresh returned no cards"}`);
    }
    if (!blockingPanelClose?.closed) {
      const panelError = createRecruitBlockingPanelCloseFailureError(blockingPanelClose, `recover:${reason}`);
      panelError.refresh_attempt = compactRefresh;
      throw panelError;
    }
    rootState = await getRecruitRoots(client);
    rootState = await ensureRecruitViewport(rootState, "recover_after");
    cardNodeIds = await waitForRecruitCardNodeIds(client, rootState.iframe.documentNodeId, {
      timeoutMs: cardTimeoutMs,
      intervalMs: 300
    });
    resetInfiniteListForRefreshRound(listState, {
      reason: `context_recovery:${reason}`,
      round: contextRecoveryAttempts,
      method: refreshResult.method,
      metadata: {
        card_count: cardNodeIds.length,
        forced_recent_viewed: forceRecentViewed,
        counters: countRecruitResultStatuses(results)
      }
    });
    listEndReason = "";
    updateRecruitProgress({
      card_count: cardNodeIds.length,
      refresh_method: refreshResult.method || null,
      refresh_forced_recent_viewed: forceRecentViewed,
      recovery_reason: reason
    });
    return refreshResult;
  }

  runControl.setPhase("recruit:cleanup");
  await closeRecruitDetail(client, { attemptsLimit: 2 });
  await closeRecruitBlockingPanelsForRun("cleanup");

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recruit:roots");
  rootState = await getRecruitRoots(client);
  rootState = await ensureRecruitViewport(rootState, "roots");
  runControl.checkpoint({
    iframe_selector: rootState.iframe.selector,
    iframe_document_node_id: rootState.iframe.documentNodeId,
    search_params: normalizedSearchParams
  });

  if (hasRecruitSearchParams(normalizedSearchParams)) {
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recruit:search");
    const searchResult = await applyRecruitSearchParams(client, {
      searchParams: normalizedSearchParams,
      requireCards: true,
      resetBeforeApply: resetBeforeSearch,
      searchTimeoutMs: cardTimeoutMs,
      resetTimeoutMs,
      cityOptionTimeoutMs
    });
    runControl.checkpoint({
      search: {
        search_params: searchResult.search_params,
        before_counts: searchResult.before_counts,
        post_search_state: searchResult.post_search_state,
        steps: searchResult.steps.map((step) => ({
          step: step.step,
          applied: step.result?.applied,
          clicked: step.result?.clicked,
          searched: step.result?.searched,
          reason: step.result?.reason || null
        }))
      }
    });
    rootState = await getRecruitRoots(client);
    rootState = await ensureRecruitViewport(rootState, "search");
  }

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recruit:cards");
  rootState = await ensureRecruitViewport(rootState, "cards");
  cardNodeIds = await waitForRecruitCardNodeIds(client, rootState.iframe.documentNodeId, {
    timeoutMs: cardTimeoutMs,
    intervalMs: 300
  });
  if (!cardNodeIds.length) {
    throw new Error("No recruit/search candidate cards found for run service");
  }

  updateRecruitProgress({
    list_end_reason: null
  });

  while (results.length < limit) {
    const candidateStarted = Date.now();
    const timings = {};
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recruit:candidate");
    rootState = await ensureRecruitViewport(rootState, "candidate_loop");

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
        let currentRootState = await getRecruitRoots(client);
        currentRootState = await ensureRecruitViewport(currentRootState, "candidate_find_nodes");
        rootState = currentRootState;
        const currentCardNodeIds = await waitForRecruitCardNodeIds(client, currentRootState.iframe.documentNodeId, {
          timeoutMs: Math.min(cardTimeoutMs, 5000),
          intervalMs: 300
        });
        cardNodeIds = currentCardNodeIds;
        return currentCardNodeIds;
      },
      readCandidate: async (nodeId, { visibleIndex }) => readRecruitCardCandidate(client, nodeId, {
        targetUrl,
        source: "recruit-run-card",
        metadata: {
          run_candidate_index: results.length,
          visible_index: visibleIndex,
          search_params: normalizedSearchParams
        }
      }),
      detectBottomMarker: async ({ scrollAttempt = 0, signature = {} } = {}) => detectInfiniteListBottomMarker(client, {
        rootNodeId: rootState?.iframe?.documentNodeId,
        markerSelectors: RECRUIT_BOTTOM_MARKER_SELECTORS,
        refreshSelectors: RECRUIT_BOTTOM_REFRESH_SELECTORS,
        textScanSelectors: scrollAttempt > 0 || (signature?.stable_signature_count || 0) >= 2 ? undefined : [],
        maxTextScanNodes: 500
      })
    }));
    if (!nextCandidateResult.ok) {
      listEndReason = nextCandidateResult.reason || "list_exhausted";
      if (
        (nextCandidateResult.end_reached || isRefreshableListStall(nextCandidateResult.reason))
        && refreshOnEnd
        && results.length < limit
        && refreshRounds < Math.max(0, Number(maxRefreshRounds) || 0)
      ) {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("recruit:refresh");
        refreshRounds += 1;
        const refreshResult = await refreshRecruitSearchAtEnd(client, {
          searchParams: normalizedSearchParams,
          requireCards: true,
          searchTimeoutMs: cardTimeoutMs,
          resetTimeoutMs,
          resetSettleMs: refreshResetSettleMs,
          cityOptionTimeoutMs
        });
        const compactRefresh = compactRefreshAttempt(refreshResult);
        refreshAttempts.push(compactRefresh);
        runControl.checkpoint({
          refresh_round: refreshRounds,
          refresh: compactRefresh
        });
        updateRecruitProgress({
          card_count: refreshResult.card_count || cardNodeIds.length,
          refresh_method: refreshResult.method || null,
          refresh_forced_recent_viewed: true,
          list_end_reason: listEndReason
        });
        if (refreshResult.ok) {
          rootState = await getRecruitRoots(client);
          rootState = await ensureRecruitViewport(rootState, "refresh_after");
          cardNodeIds = await waitForRecruitCardNodeIds(client, rootState.iframe.documentNodeId, {
            timeoutMs: cardTimeoutMs,
            intervalMs: 300
          });
          resetInfiniteListForRefreshRound(listState, {
            reason: listEndReason,
            round: refreshRounds,
            method: refreshResult.method,
            metadata: {
              card_count: cardNodeIds.length,
              forced_recent_viewed: true
            }
          });
          listEndReason = "";
          continue;
        }
        throw createRecruitRefreshFailureError(compactRefresh, {
          listEndReason,
          targetCount: limit,
          processedCount: results.length
        });
      }
      break;
    }

    const index = results.length;
    const cardNodeId = nextCandidateResult.item.node_id;
    const candidateKey = nextCandidateResult.item.key;
    const cardCandidate = nextCandidateResult.item.candidate;

    let screeningCandidate = cardCandidate;
    let detailResult = null;
    let recoverableDetailError = null;
    let detailStep = "not_started";
    if (index < detailCountLimit) {
      try {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("recruit:detail");
        detailStep = "ensure_viewport";
        rootState = await ensureRecruitViewport(rootState, "detail");
        const blockingPanelClose = await closeRecruitBlockingPanels(client, {
          attemptsLimit: 2,
          rootState
        });
        if (!blockingPanelClose?.closed) {
          const panelError = createRecruitBlockingPanelCloseFailureError(
            blockingPanelClose,
            "before_detail_open"
          );
          timings.account_rights_panel_close = compactCloseResult(blockingPanelClose);
          checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep, error: panelError });
          await recoverAndReapplyRecruitContext("account_rights_panel_before_detail", panelError, {
            forceRecentViewed: true
          });
          continue;
        }
        if (blockingPanelClose.already_closed === false) {
          timings.account_rights_panel_close = compactCloseResult(blockingPanelClose);
        }
        checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep });
        detailStep = "open_detail";
        networkRecorder.clear();
        await maybeHumanActionCooldown("before_detail_open", timings);
        const openedDetail = await openRecruitCardDetail(client, cardNodeId);
        addTiming(timings, "candidate_click_ms", openedDetail.timings?.candidate_click_ms);
        addTiming(timings, "detail_open_ms", openedDetail.timings?.detail_open_ms);
        const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState);
        detailStep = "wait_network";
        const networkWait = await measureTiming(timings, "network_cv_wait_ms", () => waitForCvNetworkEvents(
          waitForRecruitDetailNetworkEvents,
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
        detailResult = await extractRecruitDetailCandidate(client, {
          cardCandidate,
          cardNodeId,
          detailState: openedDetail.detail_state,
          networkEvents: networkRecorder.events,
          targetUrl,
          closeDetail: false,
          networkParseRetryMs: waitPlan.mode_before === "image" ? 500 : 2200,
          networkParseIntervalMs: 250
        });
        addTiming(timings, "late_network_retry_ms", detailResult.network_parse_retry_elapsed_ms);
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
          captureTargetWait = await waitForCvCaptureTarget(client, openedDetail.detail_state, {
            domain: "recruit",
            timeoutMs: 6000,
            intervalMs: 250
          });
          captureTarget = captureTargetWait.target || null;
          const captureNodeId = captureTarget?.node_id || null;
          if (captureNodeId) {
            const imageEvidencePath = imageEvidenceFilePath({
              imageOutputDir,
              domain: "recruit",
              runId: runControl?.runId,
              index,
              extension: "jpg"
            });
            try {
              detailStep = "capture_image";
              imageEvidence = await measureTiming(timings, "screenshot_capture_ms", () => captureScrolledNodeScreenshots(client, captureNodeId, {
                filePath: imageEvidencePath,
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
                scrollDeltaJitterEnabled: effectiveHumanBehavior.listScrollJitter,
                stepTimeoutMs: 45000,
                totalTimeoutMs: 90000,
                duplicateStopCount: 1,
                skipDuplicateScreenshots: true,
                composeForLlm: true,
                llmPagesPerImage: 3,
                llmResizeMaxWidth: 1100,
                llmQuality: 72,
                metadata: {
                  domain: "recruit",
                  capture_mode: "scroll_sequence",
                  acquisition_reason: "network_miss_image_fallback",
                  run_candidate_index: index,
                  candidate_key: candidateKey,
                  capture_target: captureTarget,
                  capture_target_wait: captureTargetWait
                }
              }));
              source = "image";
            } catch (error) {
              if (!isRecoverableRecruitImageCaptureError(error)) throw error;
              const recoveryCount = candidateRecoveryCounts.get(candidateKey) || 0;
              if (recoveryCount < 1) {
                candidateRecoveryCounts.set(candidateKey, recoveryCount + 1);
                timings.image_capture_recovery_trigger = compactError(error, "IMAGE_CAPTURE_FAILED");
                checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep, error });
                await closeRecruitDetail(client, { attemptsLimit: 2 }).catch(() => null);
                await closeRecruitBlockingPanels(client, { attemptsLimit: 2, rootState }).catch(() => null);
                await recoverAndReapplyRecruitContext(`image_capture:${detailStep}`, error, {
                  forceRecentViewed: true
                });
                continue;
              }
              imageEvidence = createRecoverableRecruitImageCaptureEvidence(error, {
                elapsedMs: timings.screenshot_capture_ms,
                filePath: imageEvidencePath,
                extension: "jpg",
                maxScreenshots: maxImagePages
              });
              source = "image_capture_failed";
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
          capture_target: captureTarget || null,
          capture_target_wait: captureTargetWait
        };
        screeningCandidate = detailResult.candidate;
        if (closeDetail) {
          detailResult.close_result = await measureTiming(timings, "close_detail_ms", () => closeRecruitDetail(client));
          await maybeHumanActionCooldown("after_detail_close", timings);
          if (!detailResult.close_result?.closed) {
            const closeError = createRecruitCloseFailureError(detailResult.close_result);
            const recovery = await recoverAndReapplyRecruitContext("detail_close_failed", closeError, {
              forceRecentViewed: true
            });
            detailResult.cv_acquisition = {
              ...(detailResult.cv_acquisition || {}),
              close_recovery: {
                ok: Boolean(recovery.ok),
                method: recovery.method || "",
                forced_recent_viewed: Boolean(recovery.forced_recent_viewed),
                card_count: recovery.card_count || 0
              }
            };
          }
        } else {
          detailResult.close_result = null;
        }
      } catch (error) {
        if (!isRecoverableRecruitDetailError(error)) throw error;
        const recoveryCount = candidateRecoveryCounts.get(candidateKey) || 0;
        if (recoveryCount < 1) {
          candidateRecoveryCounts.set(candidateKey, recoveryCount + 1);
          timings.detail_recovery_trigger = compactRecoverableDetailError(error);
          checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep, error });
          await closeRecruitDetail(client, { attemptsLimit: 2 }).catch(() => null);
          await closeRecruitBlockingPanels(client, { attemptsLimit: 2, rootState }).catch(() => null);
          await recoverAndReapplyRecruitContext(`detail:${detailStep}`, error, {
            forceRecentViewed: true
          });
          continue;
        }
        recoverableDetailError = error;
        detailResult = null;
        timings.detail_recovered_error = compactRecoverableDetailError(error);
        await closeRecruitDetail(client, { attemptsLimit: 2 }).catch(() => null);
        await closeRecruitBlockingPanels(client, { attemptsLimit: 2, rootState }).catch(() => null);
      }
    }

    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recruit:screening");
    let llmResult = null;
    if (useLlmScreening) {
      if (recoverableDetailError || detailResult?.image_evidence?.ok === false) {
        llmResult = null;
      } else if (!llmConfig) {
        llmResult = createMissingLlmConfigResult();
      } else {
        try {
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
          llmResult = createFailedLlmScreeningResult(error);
        }
      }
      if (detailResult) detailResult.llm_result = llmResult;
    }
    const screening = recoverableDetailError
      ? createRecoverableDetailFailureScreening(screeningCandidate, recoverableDetailError)
      : detailResult?.image_evidence?.ok === false
      ? createImageCaptureFailureScreening(screeningCandidate, {
        code: detailResult.image_evidence.error_code,
        message: detailResult.image_evidence.error
      })
      : useLlmScreening
        ? llmResultToScreening(llmResult, screeningCandidate)
        : screenCandidate(screeningCandidate, { criteria });
    timings.total_ms = Date.now() - candidateStarted;
    const compactResult = {
      index,
      candidate_key: candidateKey,
      card_node_id: cardNodeId,
      candidate: compactCandidate(screeningCandidate),
      detail: compactDetail(detailResult),
      llm_screening: detailResult ? null : compactScreeningLlmResult(llmResult),
      screening: compactScreening(screening),
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
    results.push(compactResult);
    markInfiniteListCandidateProcessed(listState, candidateKey, {
      metadata: {
        result_index: index,
        candidate_id: screeningCandidate.id || null
      }
    });

    updateRecruitProgress({
      last_candidate_id: screeningCandidate.id || null,
      last_candidate_key: candidateKey,
      last_score: screening.score
    });
    const checkpointStarted = Date.now();
    runControl.checkpoint({
      results,
      last_candidate: {
        id: screeningCandidate.id || null,
        key: candidateKey,
        identity: screeningCandidate.identity || {},
        screening: {
          status: screening.status,
          passed: screening.passed,
          score: screening.score
        },
        llm_screening: compactScreeningLlmResult(llmResult),
        error: compactResult.error
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
        updateRecruitProgress({
          human_rest_last: restResult
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

  runControl.setPhase("recruit:done");
  return {
    domain: "recruit",
    target_url: targetUrl,
    search_params: normalizedSearchParams,
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
    refresh_attempts: refreshAttempts,
    context_recoveries: contextRecoveryAttempts,
    ...countRecruitResultStatuses(results),
    results
  };
}

export function createRecruitRunService({
  lifecycle,
  idPrefix = "recruit",
  workflow = runRecruitWorkflow,
  onSnapshot = null
} = {}) {
  const manager = lifecycle || createRunLifecycleManager({ idPrefix, onSnapshot });

  function startRecruitRun({
    runId = "",
    client,
    targetUrl = "",
    criteria = "",
    searchParams = {},
    maxCandidates = 5,
    detailLimit = null,
    closeDetail = true,
    delayMs = 0,
    cardTimeoutMs = 90000,
    resetBeforeSearch = true,
    resetTimeoutMs = 180000,
    cityOptionTimeoutMs = 30000,
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
    refreshResetSettleMs = 5000,
    screeningMode = "llm",
    llmConfig = null,
    llmTimeoutMs = 120000,
    llmImageLimit = 8,
    llmImageDetail = "high",
    imageOutputDir = "",
    humanRestEnabled = false,
    humanBehavior = null,
    name = "recruit-domain-run"
  } = {}) {
    if (!client) throw new Error("startRecruitRun requires a guarded CDP client");
    const normalizedSearchParams = normalizeSearchParams(searchParams);
    const normalizedScreeningMode = normalizeScreeningMode(screeningMode);
    const candidateLimit = Math.max(1, Number(maxCandidates) || 1);
    const normalizedDetailLimit = detailLimit == null ? candidateLimit : Math.max(0, Number(detailLimit) || 0);
    const effectiveHumanBehavior = normalizeHumanBehaviorOptions(humanBehavior, {
      legacyEnabled: humanRestEnabled === true || llmConfig?.humanRestEnabled === true
    });
    const effectiveHumanRestEnabled = effectiveHumanBehavior.restEnabled;
    return manager.startRun({
      runId,
      name,
      context: {
        domain: "recruit",
        target_url: targetUrl,
        criteria_present: Boolean(criteria),
        search_params: normalizedSearchParams,
        max_candidates: maxCandidates,
        detail_limit: normalizedDetailLimit,
        close_detail: closeDetail,
        reset_before_search: resetBeforeSearch,
        reset_timeout_ms: resetTimeoutMs,
        city_option_timeout_ms: cityOptionTimeoutMs,
        cv_acquisition_mode: cvAcquisitionMode,
        max_image_pages: maxImagePages,
        image_wheel_delta_y: imageWheelDeltaY,
        list_max_scrolls: listMaxScrolls,
        list_stable_signature_limit: listStableSignatureLimit,
        list_wheel_delta_y: listWheelDeltaY,
        list_settle_ms: listSettleMs,
        list_fallback_point: listFallbackPoint,
        refresh_on_end: refreshOnEnd,
        max_refresh_rounds: maxRefreshRounds,
        refresh_reset_settle_ms: refreshResetSettleMs,
        screening_mode: normalizedScreeningMode,
        llm_configured: Boolean(llmConfig),
        llm_timeout_ms: llmTimeoutMs,
        llm_image_limit: llmImageLimit,
        llm_image_detail: llmImageDetail,
        image_output_dir: imageOutputDir || "",
        human_behavior_enabled: effectiveHumanBehavior.enabled,
        human_behavior_profile: effectiveHumanBehavior.profile,
        human_behavior: effectiveHumanBehavior,
        human_rest_enabled: effectiveHumanRestEnabled
      },
      progress: {
        card_count: 0,
        target_count: candidateLimit,
        processed: 0,
        screened: 0,
        detail_opened: 0,
        llm_screened: 0,
        passed: 0,
        image_capture_failed: 0,
        detail_open_failed: 0,
        transient_recovered: 0,
        context_recoveries: 0,
        human_behavior_enabled: effectiveHumanBehavior.enabled,
        human_behavior_profile: effectiveHumanBehavior.profile,
        human_rest_enabled: effectiveHumanRestEnabled,
        human_rest_count: 0,
        human_rest_ms: 0,
        last_human_event: null
      },
      checkpoint: {},
      task: (runControl) => workflow({
        client,
        targetUrl,
        criteria,
        searchParams: normalizedSearchParams,
        maxCandidates,
        detailLimit: normalizedDetailLimit,
        closeDetail,
        delayMs,
        cardTimeoutMs,
        resetBeforeSearch,
        resetTimeoutMs,
        cityOptionTimeoutMs,
        maxImagePages,
        imageWheelDeltaY,
        cvAcquisitionMode,
        listMaxScrolls,
        listStableSignatureLimit,
        listWheelDeltaY,
        listSettleMs,
        listFallbackPoint,
        refreshOnEnd,
        maxRefreshRounds,
        refreshResetSettleMs,
        screeningMode: normalizedScreeningMode,
        llmConfig,
        llmTimeoutMs,
        llmImageLimit,
        llmImageDetail,
        imageOutputDir,
        humanRestEnabled: effectiveHumanRestEnabled,
        humanBehavior: effectiveHumanBehavior
      }, runControl)
    });
  }

  return {
    startRecruitRun,
    getRecruitRun: manager.getRun,
    pauseRecruitRun: manager.pauseRun,
    resumeRecruitRun: manager.resumeRun,
    cancelRecruitRun: manager.cancelRun,
    waitForRecruitRun: manager.waitForRun,
    listRecruitRuns: manager.listRuns,
    manager
  };
}
