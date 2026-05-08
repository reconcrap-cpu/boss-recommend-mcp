import { createRunLifecycleManager } from "../../core/run/index.js";
import {
  addTiming,
  imageEvidenceFilePath,
  measureTiming
} from "../../core/run/timing.js";
import { captureScrolledNodeScreenshots } from "../../core/capture/index.js";
import { waitForCvCaptureTarget } from "../../core/cv-capture-target/index.js";
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
  imageOutputDir = ""
} = {}, runControl) {
  if (!client) throw new Error("runRecruitWorkflow requires a guarded CDP client");
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
  let cardNodeIds = [];
  let listEndReason = "";
  const listFallbackResolver = listFallbackPoint || (async ({ items = [] } = {}) => resolveInfiniteListFallbackPoint(client, {
    rootNodeId: rootState?.iframe?.documentNodeId,
    containerSelectors: RECRUIT_LIST_CONTAINER_SELECTORS,
    itemNodeIds: items.map((item) => item.node_id).filter(Boolean),
    itemSelectors: [RECRUIT_CARD_SELECTOR],
    viewportPoint: { xRatio: 0.28, yRatio: 0.5 },
    validateViewportPoint: true
  }));

  runControl.setPhase("recruit:cleanup");
  await closeRecruitDetail(client, { attemptsLimit: 2 });

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recruit:roots");
  let rootState = await getRecruitRoots(client);
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

  runControl.updateProgress({
    card_count: cardNodeIds.length,
    target_count: limit,
    processed: 0,
    screened: 0,
    detail_opened: 0,
    passed: 0,
    screening_mode: normalizedScreeningMode,
    llm_screened: 0,
    unique_seen: compactInfiniteListState(listState).seen_count,
    scroll_count: 0,
    refresh_rounds: 0,
    refresh_attempts: 0,
    viewport_checks: viewportGuard.getStats().checks,
    viewport_recoveries: viewportGuard.getStats().recoveries
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
        nextCandidateResult.end_reached
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
        runControl.updateProgress({
          card_count: refreshResult.card_count || cardNodeIds.length,
          target_count: limit,
          processed: results.length,
          screened: results.length,
          detail_opened: results.filter((item) => item.detail).length,
          passed: results.filter((item) => item.screening.passed).length,
          llm_screened: results.filter((item) => item.detail?.llm_screening || item.llm_screening).length,
          unique_seen: compactInfiniteListState(listState).seen_count,
          scroll_count: compactInfiniteListState(listState).scroll_count,
          refresh_rounds: refreshRounds,
          refresh_attempts: refreshAttempts.length,
          refresh_method: refreshResult.method || null,
          refresh_forced_recent_viewed: true,
          list_end_reason: listEndReason,
          viewport_checks: viewportGuard.getStats().checks,
          viewport_recoveries: viewportGuard.getStats().recoveries
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
      }
      break;
    }

    const index = results.length;
    const cardNodeId = nextCandidateResult.item.node_id;
    const candidateKey = nextCandidateResult.item.key;
    const cardCandidate = nextCandidateResult.item.candidate;

    let screeningCandidate = cardCandidate;
    let detailResult = null;
    if (index < detailCountLimit) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("recruit:detail");
      rootState = await ensureRecruitViewport(rootState, "detail");
      networkRecorder.clear();
      const openedDetail = await openRecruitCardDetail(client, cardNodeId);
      addTiming(timings, "candidate_click_ms", openedDetail.timings?.candidate_click_ms);
      addTiming(timings, "detail_open_ms", openedDetail.timings?.detail_open_ms);
      const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState);
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
        captureTargetWait = await waitForCvCaptureTarget(client, openedDetail.detail_state, {
          domain: "recruit",
          timeoutMs: 6000,
          intervalMs: 250
        });
        captureTarget = captureTargetWait.target || null;
        const captureNodeId = captureTarget?.node_id || null;
        if (captureNodeId) {
          imageEvidence = await measureTiming(timings, "screenshot_capture_ms", () => captureScrolledNodeScreenshots(client, captureNodeId, {
            filePath: imageEvidenceFilePath({
              imageOutputDir,
              domain: "recruit",
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

      let closeResult = null;
      if (closeDetail) {
        closeResult = await measureTiming(timings, "close_detail_ms", () => closeRecruitDetail(client));
      }
      detailResult.close_result = closeResult;
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
    }

    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recruit:screening");
    let llmResult = null;
    if (useLlmScreening) {
      if (!llmConfig) {
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
    const screening = useLlmScreening
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
      timings
    };
    results.push(compactResult);
    markInfiniteListCandidateProcessed(listState, candidateKey, {
      metadata: {
        result_index: index,
        candidate_id: screeningCandidate.id || null
      }
    });

    runControl.updateProgress({
      card_count: cardNodeIds.length,
      target_count: limit,
      processed: results.length,
      screened: results.length,
      detail_opened: results.filter((item) => item.detail).length,
      passed: results.filter((item) => item.screening.passed).length,
      llm_screened: results.filter((item) => item.detail?.llm_screening || item.llm_screening).length,
      unique_seen: compactInfiniteListState(listState).seen_count,
      scroll_count: compactInfiniteListState(listState).scroll_count,
      refresh_rounds: refreshRounds,
      refresh_attempts: refreshAttempts.length,
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
      last_candidate: {
        id: screeningCandidate.id || null,
        key: candidateKey,
        identity: screeningCandidate.identity || {},
        screening: {
          status: screening.status,
          passed: screening.passed,
          score: screening.score
        },
        llm_screening: compactScreeningLlmResult(llmResult)
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
    list_end_reason: listEndReason || null,
    refresh_rounds: refreshRounds,
    refresh_attempts: refreshAttempts,
    processed: results.length,
    screened: results.length,
    detail_opened: results.filter((item) => item.detail).length,
    llm_screened: results.filter((item) => item.detail?.llm_screening || item.llm_screening).length,
    passed: results.filter((item) => item.screening.passed).length,
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
    name = "recruit-domain-run"
  } = {}) {
    if (!client) throw new Error("startRecruitRun requires a guarded CDP client");
    const normalizedSearchParams = normalizeSearchParams(searchParams);
    const normalizedScreeningMode = normalizeScreeningMode(screeningMode);
    const candidateLimit = Math.max(1, Number(maxCandidates) || 1);
    const normalizedDetailLimit = detailLimit == null ? candidateLimit : Math.max(0, Number(detailLimit) || 0);
    return manager.startRun({
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
        image_output_dir: imageOutputDir || ""
      },
      progress: {
        card_count: 0,
        target_count: candidateLimit,
        processed: 0,
        screened: 0,
        detail_opened: 0,
        llm_screened: 0,
        passed: 0
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
        imageOutputDir
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
