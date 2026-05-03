import { createRunLifecycleManager } from "../../core/run/index.js";
import { captureScrolledNodeScreenshots } from "../../core/capture/index.js";
import { sleep } from "../../core/browser/index.js";
import { GREET_CREDITS_EXHAUSTED_CODE } from "../../core/greet-quota/index.js";
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
} from "../../core/cv-acquisition/index.js";
import {
  compactInfiniteListState,
  createInfiniteListState,
  getNextInfiniteListCandidate,
  markInfiniteListCandidateProcessed,
  resetInfiniteListForRefreshRound
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
  closeRecommendDetail,
  createRecommendDetailNetworkRecorder,
  extractRecommendDetailCandidate,
  openRecommendCardDetailWithFreshRetry,
  waitForRecommendDetailNetworkEvents
} from "./detail.js";
import {
  readRecommendCardCandidate,
  waitForRecommendCardNodeIds
} from "./cards.js";
import { selectAndConfirmFirstSafeFilter } from "./filters.js";
import {
  buildRecommendFilterSelectionOptions,
  refreshRecommendListAtEnd
} from "./refresh.js";
import { selectRecommendJob } from "./jobs.js";
import {
  normalizeRecommendPageScope,
  selectRecommendPageScope
} from "./scopes.js";
import {
  clickRecommendActionControl,
  normalizeRecommendPostAction,
  resolveRecommendPostAction,
  waitForRecommendDetailActionControls
} from "./actions.js";
import { getRecommendRoots } from "./roots.js";

function normalizeLabels(labels = []) {
  return labels.map((label) => String(label || "").trim()).filter(Boolean);
}

function normalizeFilter(filter = {}) {
  const filterGroups = Array.isArray(filter.filterGroups)
    ? filter.filterGroups
    : Array.isArray(filter.groups)
      ? filter.groups
      : [];
  return {
    enabled: filter.enabled !== false,
    group: String(filter.group || ""),
    labels: normalizeLabels(filter.labels || filter.filterLabels || []),
    selectAllLabels: Boolean(filter.selectAllLabels),
    filterGroups: filterGroups.map((group) => ({
      group: String(group?.group || ""),
      labels: normalizeLabels(group?.labels || group?.filterLabels || []),
      selectAllLabels: group?.selectAllLabels !== false
    })).filter((group) => group.group || group.labels.length)
  };
}

function compactFilterResult(filterResult) {
  if (!filterResult) return null;
  return {
    opened_panel: Boolean(filterResult.opened_panel),
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
    confirmed: Boolean(filterResult.confirmed),
    before_counts: filterResult.before_counts,
    after_confirm_counts: filterResult.after_confirm_counts
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

async function runRecommendPostAction({
  client,
  screening,
  actionDiscovery,
  postAction = "none",
  greetCount = 0,
  maxGreetCount = null,
  executePostAction = true,
  afterClickDelayMs = 900
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
    reason: ""
  };

  if (!screening?.passed) {
    result.reason = "screening_not_passed";
    return result;
  }
  if (plan.effective === "none") {
    result.reason = "post_action_none";
    return result;
  }

  const summary = actionDiscovery?.summary || {};
  const control = plan.effective === "favorite" ? summary.favorite : summary.greet;
  if (!control?.found) {
    result.reason = `${plan.effective}_control_not_found`;
    return result;
  }
  result.control = control;

  if (plan.effective === "greet" && control.continue_chat) {
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
  if (plan.effective === "greet" && control.available === false) {
    result.reason = "greet_control_not_available";
    return result;
  }
  if (plan.effective === "favorite" && control.active) {
    result.reason = "already_favorited";
    result.already_favorited = true;
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

  result.action_attempted = true;
  result.control_before = control;
  let clickResult;
  try {
    clickResult = await clickRecommendActionControl(client, {
      ...control,
      kind: plan.effective
    });
  } catch (error) {
    if (error?.code === GREET_CREDITS_EXHAUSTED_CODE) {
      result.reason = "greet_credits_exhausted";
      result.out_of_greet_credits = true;
      result.stop_run = true;
      result.greet_quota = error.greet_quota || control.greet_quota || null;
      return result;
    }
    throw error;
  }
  result.click_result = clickResult;
  result.action_clicked = true;
  result.counted_as_greet = plan.effective === "greet";
  result.reason = "clicked";
  if (afterClickDelayMs > 0) await sleep(afterClickDelayMs);
  try {
    const afterDiscovery = await waitForRecommendDetailActionControls(client, {
      timeoutMs: 2500,
      intervalMs: 300,
      requireAny: false
    });
    const afterSummary = afterDiscovery?.summary || {};
    const afterControl = plan.effective === "favorite" ? afterSummary.favorite : afterSummary.greet;
    result.action_discovery_after = compactActionDiscovery(afterDiscovery);
    result.control_after = afterControl || null;
    if (plan.effective === "greet") {
      result.verified_after_click = Boolean(
        afterControl?.continue_chat
        || String(afterControl?.label || "").includes("继续沟通")
      );
    } else if (plan.effective === "favorite") {
      result.verified_after_click = Boolean(
        afterControl?.active
        || String(afterControl?.label || "").includes("已")
      );
    }
  } catch (error) {
    result.verify_error = {
      message: error?.message || String(error)
    };
  }
  return result;
}

function compactRefreshAttempt(refreshAttempt) {
  if (!refreshAttempt) return null;
  return {
    ok: Boolean(refreshAttempt.ok),
    method: refreshAttempt.method || "",
    forced_recent_not_view: Boolean(refreshAttempt.forced_recent_not_view),
    card_count: refreshAttempt.card_count || 0,
    attempts: (refreshAttempt.attempts || []).map((attempt) => ({
      ok: Boolean(attempt.ok),
      method: attempt.method || "",
      reason: attempt.reason || null,
      label: attempt.label || null,
      before_card_count: attempt.before_card_count || 0,
      after_card_count: attempt.after_card_count || 0
    })),
    page_scope: compactPageScopeSelection(refreshAttempt.page_scope),
    filter: compactFilterResult(refreshAttempt.filter)
  };
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
  maxImagePages = 8,
  imageWheelDeltaY = 650,
  cvAcquisitionMode = "unknown",
  listMaxScrolls = 20,
  listStableSignatureLimit = 2,
  listWheelDeltaY = 850,
  listSettleMs = 1200,
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
  screeningMode = "llm",
  llmConfig = null,
  llmTimeoutMs = 120000,
  llmImageLimit = 8,
  llmImageDetail = "high"
} = {}, runControl) {
  if (!client) throw new Error("runRecommendWorkflow requires a guarded CDP client");
  const normalizedFilter = normalizeFilter(filter);
  const normalizedPostAction = normalizeRecommendPostAction(postAction) || "none";
  const requestedPageScope = normalizeRecommendPageScope(pageScope) || "recommend";
  const normalizedFallbackPageScope = normalizeRecommendPageScope(fallbackPageScope) || "recommend";
  const normalizedScreeningMode = normalizeScreeningMode(screeningMode);
  const useLlmScreening = normalizedScreeningMode !== "deterministic";
  const postActionEnabled = normalizedPostAction !== "none";
  const limit = Math.max(1, Number(maxCandidates) || 1);
  const detailCountLimit = detailLimit == null ? limit : Math.max(0, Number(detailLimit) || 0);
  const effectiveDetailLimit = postActionEnabled ? limit : detailCountLimit;
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
  const refreshAttempts = [];
  let refreshRounds = 0;
  let greetCount = 0;
  let jobSelection = null;
  let pageScopeSelection = null;
  let filterResult = null;
  let cardNodeIds = [];
  let listEndReason = "";

  runControl.setPhase("recommend:cleanup");
  await closeRecommendDetail(client, { attemptsLimit: 2 });

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recommend:roots");
  let rootState = await getRecommendRoots(client);
  rootState = await ensureRecommendViewport(rootState, "roots");
  runControl.checkpoint({
    iframe_selector: rootState.iframe.selector,
    iframe_document_node_id: rootState.iframe.documentNodeId
  });

  if (jobLabel) {
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recommend:job");
    jobSelection = await selectRecommendJob(client, rootState.iframe.documentNodeId, {
      jobLabel,
      settleMs: cardTimeoutMs > 45000 ? 12000 : 6000
    });
    if (!jobSelection.selected) {
      throw new Error(`Requested recommend job was not selected: ${jobSelection.reason}`);
    }
    rootState = await getRecommendRoots(client);
    rootState = await ensureRecommendViewport(rootState, "job");
    runControl.checkpoint({
      job_selection: compactJobSelection(jobSelection)
    });
  }

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recommend:page-scope");
  pageScopeSelection = await selectRecommendPageScope(client, rootState.iframe.documentNodeId, {
    pageScope: requestedPageScope,
    fallbackScope: normalizedFallbackPageScope,
    settleMs: cardTimeoutMs > 45000 ? 3000 : 1200,
    timeoutMs: Math.min(Math.max(cardTimeoutMs, 10000), 60000)
  });
  if (!pageScopeSelection.selected) {
    throw new Error(`Recommend page scope was not selected: ${pageScopeSelection.reason || pageScopeSelection.effective_scope || requestedPageScope}`);
  }
  rootState = await getRecommendRoots(client);
  rootState = await ensureRecommendViewport(rootState, "page_scope");
  runControl.checkpoint({
    page_scope: compactPageScopeSelection(pageScopeSelection)
  });

  if (normalizedFilter.enabled) {
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recommend:filter");
    filterResult = await selectAndConfirmFirstSafeFilter(
      client,
      rootState.iframe.documentNodeId,
      buildRecommendFilterSelectionOptions(normalizedFilter)
    );
    if (!filterResult.confirmed) {
      throw new Error("Recommend run filter selection was not confirmed");
    }
    rootState = await getRecommendRoots(client);
    rootState = await ensureRecommendViewport(rootState, "filter");
    runControl.checkpoint({
      filter: compactFilterResult(filterResult)
    });
  }

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recommend:cards");
  rootState = await ensureRecommendViewport(rootState, "cards");
  cardNodeIds = await waitForRecommendCardNodeIds(client, rootState.iframe.documentNodeId, {
    timeoutMs: cardTimeoutMs,
    intervalMs: 300
  });
  if (!cardNodeIds.length) {
    throw new Error("No recommend candidate cards found for run service");
  }

  runControl.updateProgress({
    card_count: cardNodeIds.length,
    target_count: limit,
    processed: 0,
    screened: 0,
    detail_opened: 0,
    passed: 0,
    greet_count: 0,
    post_action_clicked: 0,
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
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recommend:candidate");
    rootState = await ensureRecommendViewport(rootState, "candidate_loop");

    const nextCandidateResult = await getNextInfiniteListCandidate({
      client,
      state: listState,
      maxScrolls: listMaxScrolls,
      stableSignatureLimit: listStableSignatureLimit,
      wheelDeltaY: listWheelDeltaY,
      settleMs: listSettleMs,
      fallbackPoint: listFallbackPoint,
      findNodeIds: async () => {
        let currentRootState = await getRecommendRoots(client);
        currentRootState = await ensureRecommendViewport(currentRootState, "candidate_find_nodes");
        rootState = currentRootState;
        const currentCardNodeIds = await waitForRecommendCardNodeIds(client, currentRootState.iframe.documentNodeId, {
          timeoutMs: Math.min(cardTimeoutMs, 5000),
          intervalMs: 300
        });
        cardNodeIds = currentCardNodeIds;
        return currentCardNodeIds;
      },
      readCandidate: async (nodeId, { visibleIndex }) => readRecommendCardCandidate(client, nodeId, {
        targetUrl,
        source: "recommend-run-card",
        metadata: {
          run_candidate_index: results.length,
          visible_index: visibleIndex
        }
      })
    });
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
        runControl.setPhase("recommend:refresh");
        refreshRounds += 1;
        const refreshResult = await refreshRecommendListAtEnd(client, {
          rootState,
          jobLabel,
          pageScope: pageScopeSelection?.effective_scope || requestedPageScope,
          fallbackPageScope: normalizedFallbackPageScope,
          filter: normalizedFilter,
          forceRecentNotView: true,
          cardTimeoutMs,
          buttonSettleMs: refreshButtonSettleMs,
          reloadSettleMs: refreshReloadSettleMs
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
          refresh_forced_recent_not_view: true,
          list_end_reason: listEndReason,
          viewport_checks: viewportGuard.getStats().checks,
          viewport_recoveries: viewportGuard.getStats().recoveries
        });
        if (refreshResult.ok) {
          rootState = refreshResult.root_state || await getRecommendRoots(client);
          rootState = await ensureRecommendViewport(rootState, "refresh_after");
          cardNodeIds = await waitForRecommendCardNodeIds(client, rootState.iframe.documentNodeId, {
            timeoutMs: cardTimeoutMs,
            intervalMs: 300
          });
          resetInfiniteListForRefreshRound(listState, {
            reason: listEndReason,
            round: refreshRounds,
            method: refreshResult.method,
            metadata: {
              card_count: cardNodeIds.length,
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
    let cardNodeId = nextCandidateResult.item.node_id;
    const candidateKey = nextCandidateResult.item.key;
    let cardCandidate = nextCandidateResult.item.candidate;

    let screeningCandidate = cardCandidate;
    let detailResult = null;
    if (index < effectiveDetailLimit) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("recommend:detail");
      rootState = await ensureRecommendViewport(rootState, "detail");
      networkRecorder.clear();
      const openedDetail = await openRecommendCardDetailWithFreshRetry(client, {
        cardNodeId,
        candidateKey,
        cardCandidate,
        rootState,
        targetUrl,
        maxAttempts: 2
      });
      cardNodeId = openedDetail.card_node_id || cardNodeId;
      cardCandidate = openedDetail.card_candidate || cardCandidate;
      screeningCandidate = cardCandidate;
      const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState);
      const networkWait = await waitForCvNetworkEvents(
        waitForRecommendDetailNetworkEvents,
        networkRecorder,
        {
          waitPlan,
          minCount: 1,
          requireLoaded: true,
          intervalMs: 120
        }
      );
      detailResult = await extractRecommendDetailCandidate(client, {
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
      if (parsedNetworkProfileCount > 0) {
        recordCvNetworkHit(cvAcquisitionState, {
          parsedNetworkProfileCount,
          waitResult: networkWait
        });
      } else {
        const captureNodeId = openedDetail.detail_state?.popup?.node_id
          || openedDetail.detail_state?.resumeIframe?.node_id
          || null;
        if (captureNodeId) {
          imageEvidence = await captureScrolledNodeScreenshots(client, captureNodeId, {
            padding: 4,
            maxScreenshots: maxImagePages,
            wheelDeltaY: imageWheelDeltaY,
            settleMs: 1200,
            metadata: {
              domain: "recommend",
              capture_mode: "scroll_sequence",
              acquisition_reason: "network_miss_image_fallback",
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
        image_evidence: summarizeImageEvidence(imageEvidence)
      };
      screeningCandidate = detailResult.candidate;
    }

    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recommend:screening");
    let llmResult = null;
    if (useLlmScreening) {
      if (!llmConfig) {
        llmResult = createMissingLlmConfigResult();
      } else {
        try {
          llmResult = await callScreeningLlm({
            candidate: screeningCandidate,
            criteria,
            config: llmConfig,
            timeoutMs: llmTimeoutMs,
            imageEvidence: detailResult?.image_evidence || null,
            maxImages: llmImageLimit,
            imageDetail: llmImageDetail
          });
        } catch (error) {
          llmResult = createFailedLlmScreeningResult(error);
        }
      }
      if (detailResult) detailResult.llm_result = llmResult;
    }
    const screening = useLlmScreening
      ? llmResultToScreening(llmResult, screeningCandidate)
      : screenCandidate(screeningCandidate, { criteria });
    let actionDiscovery = null;
    let postActionResult = null;
    if (postActionEnabled && detailResult) {
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("recommend:post-action");
      actionDiscovery = await waitForRecommendDetailActionControls(client, {
        timeoutMs: actionTimeoutMs,
        intervalMs: actionIntervalMs,
        requireAny: true
      });
      postActionResult = await runRecommendPostAction({
        client,
        screening,
        actionDiscovery,
        postAction: normalizedPostAction,
        greetCount,
        maxGreetCount: Number.isInteger(maxGreetCount) ? maxGreetCount : null,
        executePostAction,
        afterClickDelayMs: actionAfterClickDelayMs
      });
      if (postActionResult.counted_as_greet && postActionResult.action_clicked) {
        greetCount += 1;
      }
    }
    if (detailResult && closeDetail) {
      detailResult.close_result = await closeRecommendDetail(client);
    }
    const compactResult = {
      index,
      candidate_key: candidateKey,
      card_node_id: cardNodeId,
      candidate: compactCandidate(screeningCandidate),
      detail: compactDetail(detailResult),
      llm_screening: detailResult ? null : compactScreeningLlmResult(llmResult),
      screening: compactScreening(screening),
      action_discovery: compactActionDiscovery(actionDiscovery),
      post_action: postActionResult
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
      greet_count: greetCount,
      post_action_clicked: results.filter((item) => item.post_action?.action_clicked).length,
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
        post_action: postActionResult
      }
    });

    if (postActionResult?.stop_run) {
      listEndReason = postActionResult.reason || "post_action_stop";
      break;
    }

    if (delayMs > 0) {
      await runControl.sleep(delayMs);
    }
  }

  runControl.setPhase("recommend:done");
  return {
    domain: "recommend",
    target_url: targetUrl,
    job_selection: compactJobSelection(jobSelection),
    page_scope: compactPageScopeSelection(pageScopeSelection),
    filter: compactFilterResult(filterResult),
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
    greet_count: greetCount,
    post_action_clicked: results.filter((item) => item.post_action?.action_clicked).length,
    results
  };
}

export function createRecommendRunService({
  lifecycle,
  idPrefix = "recommend",
  workflow = runRecommendWorkflow
} = {}) {
  const manager = lifecycle || createRunLifecycleManager({ idPrefix });

  function startRecommendRun({
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
    maxImagePages = 8,
    imageWheelDeltaY = 650,
    cvAcquisitionMode = "unknown",
    listMaxScrolls = 20,
    listStableSignatureLimit = 2,
    listWheelDeltaY = 850,
    listSettleMs = 1200,
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
    screeningMode = "llm",
    llmConfig = null,
    llmTimeoutMs = 120000,
    llmImageLimit = 8,
    llmImageDetail = "high",
    name = "recommend-domain-run"
  } = {}) {
    if (!client) throw new Error("startRecommendRun requires a guarded CDP client");
    const normalizedFilter = normalizeFilter(filter);
    const normalizedPostAction = normalizeRecommendPostAction(postAction) || "none";
    const requestedPageScope = normalizeRecommendPageScope(pageScope) || "recommend";
    const normalizedFallbackPageScope = normalizeRecommendPageScope(fallbackPageScope) || "recommend";
    const normalizedScreeningMode = normalizeScreeningMode(screeningMode);
    const candidateLimit = Math.max(1, Number(maxCandidates) || 1);
    const normalizedDetailLimit = detailLimit == null ? candidateLimit : Math.max(0, Number(detailLimit) || 0);
    return manager.startRun({
      name,
      context: {
        domain: "recommend",
        target_url: targetUrl,
        criteria_present: Boolean(criteria),
        job_label: jobLabel || "",
        requested_page_scope: requestedPageScope,
        fallback_page_scope: normalizedFallbackPageScope,
        filter: normalizedFilter,
        max_candidates: maxCandidates,
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
        max_refresh_rounds: maxRefreshRounds,
        refresh_button_settle_ms: refreshButtonSettleMs,
        refresh_reload_settle_ms: refreshReloadSettleMs,
        post_action: normalizedPostAction,
        max_greet_count: Number.isInteger(maxGreetCount) ? maxGreetCount : null,
        execute_post_action: Boolean(executePostAction),
        action_timeout_ms: actionTimeoutMs,
        screening_mode: normalizedScreeningMode,
        llm_configured: Boolean(llmConfig),
        llm_timeout_ms: llmTimeoutMs,
        llm_image_limit: llmImageLimit,
        llm_image_detail: llmImageDetail
      },
      progress: {
        card_count: 0,
        target_count: candidateLimit,
        processed: 0,
        screened: 0,
        detail_opened: 0,
        llm_screened: 0,
        passed: 0,
        greet_count: 0,
        post_action_clicked: 0
      },
      checkpoint: {},
      task: (runControl) => workflow({
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
        maxRefreshRounds,
        refreshButtonSettleMs,
        refreshReloadSettleMs,
        postAction: normalizedPostAction,
        maxGreetCount,
        executePostAction,
        actionTimeoutMs,
        actionIntervalMs,
        actionAfterClickDelayMs,
        screeningMode: normalizedScreeningMode,
        llmConfig,
        llmTimeoutMs,
        llmImageLimit,
        llmImageDetail
      }, runControl)
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
