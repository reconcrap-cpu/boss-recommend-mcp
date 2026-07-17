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
  normalizeHumanBehaviorOptions,
  sleep
} from "../../core/browser/index.js";
import { GREET_CREDITS_EXHAUSTED_CODE } from "../../core/greet-quota/index.js";
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
  createRecommendDetailNetworkRecorder,
  extractRecommendDetailCandidate,
  isRecommendDetailOpenMissError,
  isStaleRecommendNodeError,
  openRecommendCardDetailWithFreshRetry,
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
  refreshRecommendListAtEnd
} from "./refresh.js";
import { selectRecommendJob } from "./jobs.js";
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
  waitForRecommendDetailActionControls
} from "./actions.js";
import { getRecommendRoots } from "./roots.js";

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

function compactListReadStaleDiagnostic(error, {
  attempt = 0,
  exhausted = false
} = {}) {
  return {
    code: error?.code || "RECOMMEND_LIST_READ_STALE_NODE",
    message: String(error?.message || error || "Stale recommend list node").slice(0, 500),
    phase: "recommend:list-read",
    cdp_method: error?.cdp_method || null,
    cdp_at: error?.cdp_at ? String(error.cdp_at).slice(0, 100) : null,
    cdp_node_id: Number.isInteger(error?.cdp_node_id) ? error.cdp_node_id : null,
    cdp_backend_node_id: Number.isInteger(error?.cdp_backend_node_id)
      ? error.cdp_backend_node_id
      : null,
    cdp_param_keys: Array.isArray(error?.cdp_param_keys)
      ? error.cdp_param_keys
        .map((key) => String(key || "").trim())
        .filter((key) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key))
        .slice(0, 20)
      : [],
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
  rootReacquire,
  contextReapply
} = {}) {
  if (typeof rootReacquire !== "function") {
    throw new Error("recoverRecommendListReadStaleContext requires rootReacquire");
  }
  if (typeof contextReapply !== "function") {
    throw new Error("recoverRecommendListReadStaleContext requires contextReapply");
  }
  const processedKeys = new Set(listState?.processed_keys || []);
  try {
    if (Number(staleAttempt) <= 1) {
      try {
        const rootResult = await rootReacquire();
        if (Number(rootResult?.card_count) <= 0) {
          const noCardsError = new Error("Recommend list root reacquire returned no candidate cards");
          noCardsError.code = "RECOMMEND_LIST_ROOT_REACQUIRE_NO_CARDS";
          throw noCardsError;
        }
        resetInfiniteListForRefreshRound(listState, {
          reason: "list_read_stale_node_root_reacquire",
          round: 1,
          method: "root_reacquire",
          metadata: {
            card_count: Number(rootResult?.card_count) || 0,
            processed_count: processedKeys.size
          }
        });
        return {
          recovery_mode: "root_reacquire",
          root_reacquire: rootResult || null
        };
      } catch (rootReacquireError) {
        const contextResult = await contextReapply({ rootReacquireError });
        return {
          recovery_mode: "context_reapply",
          escalated_from: "root_reacquire",
          root_reacquire_error: compactListReadStaleDiagnostic(rootReacquireError, {
            attempt: 1
          }),
          context_reapply: contextResult || null
        };
      }
    }
    const contextResult = await contextReapply({ rootReacquireError: null });
    return {
      recovery_mode: "context_reapply",
      escalated_from: "repeated_stale",
      context_reapply: contextResult || null
    };
  } finally {
    for (const key of processedKeys) listState?.processed_keys?.add(key);
  }
}

function normalizeLabels(labels = []) {
  return labels.map((label) => String(label || "").trim()).filter(Boolean);
}

function isRefreshableListStall(reason = "") {
  return new Set([
    "stable_visible_signature",
    "max_scrolls_exhausted",
    "scroll_failed",
    "scroll_anchor_unavailable"
  ]).has(String(reason || ""));
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
    verifySticky: filter.verifySticky === true,
    filterGroups: filterGroups.map((group) => ({
      group: String(group?.group || ""),
      labels: normalizeLabels(group?.labels || group?.filterLabels || []),
      selectAllLabels: group?.selectAllLabels !== false,
      allowUnlimited: group?.allowUnlimited === true,
      verifySticky: group?.verifySticky === true
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

function compactDetail(detailResult) {
  if (!detailResult) return null;
  return {
    popup_text_length: detailResult.detail?.popup_text?.length || 0,
    resume_text_length: detailResult.detail?.resume_text?.length || 0,
    network_body_count: detailResult.network_bodies?.filter((item) => item.body).length || 0,
    parsed_network_profile_count: detailResult.parsed_network_profiles?.filter((item) => item.ok).length || 0,
    cv_acquisition: detailResult.cv_acquisition || null,
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
    const afterControl = afterSummary.greet;
    result.action_discovery_after = compactActionDiscovery(afterDiscovery);
    result.control_after = afterControl || null;
    if (plan.effective === "greet") {
      result.verified_after_click = Boolean(
        afterControl?.continue_chat
        || String(afterControl?.label || "").includes("继续沟通")
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
    reason: refreshAttempt.reason || null,
    error: refreshAttempt.error || null,
    error_diagnostic: refreshAttempt.error_diagnostic || null,
    forced_recent_not_view: Boolean(refreshAttempt.forced_recent_not_view),
    target_url: refreshAttempt.target_url || null,
    card_count: refreshAttempt.card_count || 0,
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
      card_count: attempt.card_count || 0,
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
    post_action_clicked: results.filter((item) => item.post_action?.action_clicked).length,
    image_capture_failed: results.filter((item) => item.detail?.image_evidence?.ok === false).length,
    detail_open_failed: results.filter((item) => (
      item.error?.code === "DETAIL_STALE_NODE"
      || item.error?.code === "DETAIL_OPEN_FAILED"
    )).length,
    transient_recovered: results.filter((item) => (
      item.error?.code === "DETAIL_STALE_NODE"
      || item.error?.code === "DETAIL_OPEN_FAILED"
      || item.error?.code === "IMAGE_CAPTURE_STALE_NODE"
      || item.error?.code === "IMAGE_CAPTURE_TIMEOUT"
      || item.error?.code === "IMAGE_CAPTURE_TOTAL_TIMEOUT"
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
  }
  if (error.list_end_reason) {
    result.list_end_reason = error.list_end_reason;
  }
  if (error.target_count != null) {
    result.target_count = error.target_count;
  }
  if (error.passed_count != null) {
    result.passed_count = error.passed_count;
  }
  if (Array.isArray(error.recommend_detail_open_attempts)) {
    result.recommend_detail_open_attempts = error.recommend_detail_open_attempts;
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
  const code = String(error?.code || "");
  if (code === "IMAGE_CAPTURE_TIMEOUT" || code === "IMAGE_CAPTURE_TOTAL_TIMEOUT") return true;
  if (isStaleRecommendNodeError(error)) return true;
  return /Image fallback capture timed out/i.test(String(error?.message || error || ""));
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
  return isStaleRecommendNodeError(error) || isRecommendDetailOpenMissError(error);
}

function compactRecoverableDetailError(error) {
  return compactError(error, isStaleRecommendNodeError(error) ? "DETAIL_STALE_NODE" : "DETAIL_OPEN_FAILED");
}

function createRecoverableDetailFailureScreening(candidate, error) {
  return {
    status: "fail",
    passed: false,
    score: 0,
    reasons: isStaleRecommendNodeError(error)
      ? ["detail_open_failed", "stale_node"]
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
  screeningMode = "llm",
  llmConfig = null,
  llmTimeoutMs = 120000,
  llmImageLimit = 8,
  llmImageDetail = "high",
  imageOutputDir = "",
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
  const shouldSkipRecentColleagueContacted = skipRecentColleagueContacted !== false;
  const normalizedColleagueContactWindowDays = Math.max(1, Number(colleagueContactWindowDays) || 14);
  const colleagueContactReferenceDate = new Date();
  const targetPassCount = Math.max(1, Number(maxCandidates) || 1);
  const detailCountLimit = detailLimit == null ? Number.POSITIVE_INFINITY : Math.max(0, Number(detailLimit) || 0);
  const effectiveDetailLimit = postActionEnabled ? Number.POSITIVE_INFINITY : detailCountLimit;
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
  let contextRecoveryAttempts = 0;
  let greetCount = 0;
  const candidateRecoveryCounts = new Map();
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
  const listReadStaleDiagnostics = [];
  const listFallbackResolver = listFallbackPoint || (async ({ items = [] } = {}) => resolveInfiniteListFallbackPoint(client, {
    rootNodeId: rootState?.iframe?.documentNodeId,
    containerSelectors: RECOMMEND_LIST_CONTAINER_SELECTORS,
    itemNodeIds: items.map((item) => item.node_id).filter(Boolean),
    itemSelectors: [RECOMMEND_CARD_SELECTOR],
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

  function updateRecommendProgress(extra = {}) {
    const counts = countRecommendResultStatuses(results, { greetCount });
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
      refresh_attempts: refreshAttempts.length,
      context_recoveries: contextRecoveryAttempts,
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
        counters: countRecommendResultStatuses(results, { greetCount }),
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

  async function recoverAndReapplyRecommendContext(reason = "context_recovery", error = null, {
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
    let blockingPanelClose = null;
    if (refreshResult.ok) {
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
    refreshAttempts.push(compactRefresh);
    runControl.checkpoint({
      context_recovery: {
        attempt: contextRecoveryAttempts,
        reason,
        trigger_error: compactError(error, "RECOMMEND_CONTEXT_RECOVERY_TRIGGER"),
        refresh: compactRefresh,
        counters: countRecommendResultStatuses(results, { greetCount })
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
    if (refreshResult.current_city_only) {
      currentCityOnlyResult = refreshResult.current_city_only;
    }
    if (refreshResult.filter) {
      filterResult = refreshResult.filter;
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
        counters: countRecommendResultStatuses(results, { greetCount })
      }
    });
    listEndReason = "";
    updateRecommendProgress({
      card_count: cardNodeIds.length,
      refresh_method: refreshResult.method || null,
      refresh_forced_recent_not_view: effectiveForceRecentNotView,
      recovery_reason: reason
    });
    return refreshResult;
  }

  runControl.setPhase("recommend:cleanup");
  await closeRecommendDetail(client, { attemptsLimit: 2 });
  await closeRecommendAvatarPreview(client, { attemptsLimit: 2 });
  await closeRecommendBlockingPanelsForRun("cleanup");

  await runControl.waitIfPaused();
  runControl.throwIfCanceled();
  runControl.setPhase("recommend:roots");
  rootState = await getRecommendRoots(client);
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

  const initialFilterStages = await applyRecommendFilterEnvelopeStages(normalizedFilter, {
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
      if (!result.confirmed) {
        throw new Error("Recommend run filter selection was not confirmed");
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
  if (!cardNodeIds.length) {
    throw new Error("No recommend candidate cards found for run service");
  }

  updateRecommendProgress({
    list_end_reason: null
  });

  while (countPassedResults(results) < targetPassCount) {
    const candidateStarted = Date.now();
    const timings = {};
    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recommend:list-read");
    const debugBoundaryAction = debugBoundary.take(results.length);
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
    const listReadAcquisition = await acquireRecommendListReadWithStaleRecovery({
      maxRetries: 2,
      acquire: async () => {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("recommend:list-read");
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
          readCandidate: async (nodeId, { visibleIndex }) => readRecommendCardCandidate(client, nodeId, {
            targetUrl,
            source: "recommend-run-card",
            metadata: {
              run_candidate_index: results.length,
              visible_index: visibleIndex
            }
          }),
          shouldRethrowReadError: isStaleRecommendNodeError,
          detectBottomMarker: async ({ scrollAttempt = 0, signature = {} } = {}) => detectInfiniteListBottomMarker(client, {
            rootNodeId: rootState?.iframe?.documentNodeId,
            markerSelectors: RECOMMEND_BOTTOM_MARKER_SELECTORS,
            refreshSelectors: [RECOMMEND_END_REFRESH_SELECTOR],
            textScanSelectors: scrollAttempt > 0 || (signature?.stable_signature_count || 0) >= 2 ? undefined : [],
            maxTextScanNodes: 500
          })
        }));
      },
      onStale: async ({ diagnostic }) => {
        listReadStaleRecoveryAttempts += 1;
        lastListReadStaleDiagnostic = diagnostic;
        listReadStaleDiagnostics.push(diagnostic);
        runControl.checkpoint({
          list_read_stale_recovery: {
            diagnostic,
            recent_diagnostics: listReadStaleDiagnostics.slice(-12),
            counters: countRecommendResultStatuses(results, { greetCount }),
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
            rootReacquire: async () => {
              await runControl.waitIfPaused();
              runControl.throwIfCanceled();
              runControl.setPhase("recommend:list-read-root-reacquire");
              let freshRootState = await getRecommendRoots(client);
              freshRootState = await ensureRecommendViewport(
                freshRootState,
                "list_read_stale_root_reacquire"
              );
              const freshCardNodeIds = await waitForRecommendCardNodeIds(
                client,
                freshRootState.iframe.documentNodeId,
                {
                  timeoutMs: Math.min(cardTimeoutMs, 10000),
                  intervalMs: 300
                }
              );
              rootState = freshRootState;
              cardNodeIds = freshCardNodeIds;
              return {
                card_count: freshCardNodeIds.length,
                iframe_document_node_id: freshRootState.iframe.documentNodeId
              };
            },
            contextReapply: async ({ rootReacquireError }) => {
              await runControl.waitIfPaused();
              runControl.throwIfCanceled();
              const recovery = await recoverAndReapplyRecommendContext(
                "list_read_stale_node",
                rootReacquireError || error,
                { forceRecentNotView: true }
              );
              return {
                ok: Boolean(recovery?.ok),
                method: recovery?.method || null,
                card_count: recovery?.card_count || 0
              };
            }
          });
        } catch (recoveryError) {
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
      onRecoveryApplied: async ({ diagnostic }) => {
        listReadStaleRecoveryApplied += 1;
        lastListReadStaleDiagnostic = diagnostic;
        lastListReadRecoveryMode = diagnostic.recovery_mode || null;
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
        updateRecommendProgress();
        runControl.checkpoint({
          list_read_stale_recovered: {
            diagnostic,
            recovery_count: listReadStaleRecoveries,
            candidate_list: compactInfiniteListState(listState)
          }
        });
      },
      onExhausted: async ({ diagnostic }) => {
        listReadStaleRecoveryAttempts += 1;
        lastListReadStaleDiagnostic = diagnostic;
        listReadStaleDiagnostics.push(diagnostic);
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
    const nextCandidateResult = listReadAcquisition.result;
    if (!nextCandidateResult.ok) {
      listEndReason = nextCandidateResult.reason || "list_exhausted";
      if (
          (nextCandidateResult.end_reached || isRefreshableListStall(nextCandidateResult.reason))
          && refreshOnEnd
          && countPassedResults(results) < targetPassCount
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
          preferEndRefreshButton: debugForcedListEnd ? false : undefined,
          forceRecentNotView: normalizedFilter.enabled,
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
        updateRecommendProgress({
          card_count: refreshResult.card_count || cardNodeIds.length,
          refresh_method: refreshResult.method || null,
          refresh_forced_recent_not_view: Boolean(refreshResult.forced_recent_not_view),
          list_end_reason: listEndReason
        });
        if (refreshResult.ok) {
          if (refreshResult.current_city_only) {
            currentCityOnlyResult = refreshResult.current_city_only;
          }
          if (refreshResult.filter) {
            filterResult = refreshResult.filter;
          }
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
              forced_recent_not_view: Boolean(refreshResult.forced_recent_not_view)
            }
          });
          listEndReason = "";
          continue;
        }
        throw createRecommendRefreshFailureError(compactRefresh, {
          listEndReason,
          targetCount: targetPassCount,
          passedCount: countPassedResults(results)
        });
      }
      break;
    }

    runControl.setPhase("recommend:candidate");
    const index = results.length;
    let cardNodeId = nextCandidateResult.item.node_id;
    const candidateKey = nextCandidateResult.item.key;
    let cardCandidate = nextCandidateResult.item.candidate;

    let screeningCandidate = cardCandidate;
    let detailResult = null;
    let recoverableDetailError = null;
    let colleagueContact = null;
    let skipRecentColleagueContact = false;
    let detailStep = "not_started";
    if (index < effectiveDetailLimit) {
      try {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("recommend:detail");
        detailStep = "ensure_viewport";
        rootState = await ensureRecommendViewport(rootState, "detail");
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
            forceRecentNotView: true
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
        const openedDetail = await openRecommendCardDetailWithFreshRetry(client, {
          cardNodeId,
          candidateKey,
          cardCandidate,
          rootState,
          targetUrl,
          retryTimeoutMs: 8000,
          maxAttempts: 3
        });
        addTiming(timings, "candidate_click_ms", openedDetail.timings?.candidate_click_ms);
        addTiming(timings, "detail_open_ms", openedDetail.timings?.detail_open_ms);
        cardNodeId = openedDetail.card_node_id || cardNodeId;
        cardCandidate = openedDetail.card_candidate || cardCandidate;
        screeningCandidate = cardCandidate;
        if (shouldSkipRecentColleagueContacted) {
          detailStep = "check_colleague_contact";
          try {
            colleagueContact = await measureTiming(timings, "colleague_contact_check_ms", () => inspectRecentColleagueContact(
              client,
              openedDetail.detail_state,
              {
                referenceDate: colleagueContactReferenceDate,
                windowDays: normalizedColleagueContactWindowDays
              }
            ));
            if (colleagueContact?.recent) {
              skipRecentColleagueContact = true;
              detailResult = {
                candidate: screeningCandidate,
                detail: {
                  popup_text: "",
                  resume_text: ""
                },
                colleague_contact: colleagueContact,
                cv_acquisition: {
                  source: "skipped_recent_colleague_contact",
                  skipped: true,
                  reason: "skipped_recent_colleague_contact"
                }
              };
              detailResult.close_result = await measureTiming(timings, "close_detail_ms", () => closeRecommendDetail(client));
              await maybeHumanActionCooldown("after_detail_close", timings);
            }
          } catch (error) {
            colleagueContact = {
              checked: false,
              recent: false,
              reason: "inspection_failed",
              error: error?.message || String(error),
              window_days: normalizedColleagueContactWindowDays
            };
          }
        }
        if (!skipRecentColleagueContact) {
          const waitPlan = getCvNetworkWaitPlan(cvAcquisitionState);
        detailStep = "wait_network";
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
        detailResult = await extractRecommendDetailCandidate(client, {
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
          captureTargetWait = await waitForCvCaptureTarget(client, openedDetail.detail_state, {
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
                  domain: "recommend",
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
              if (!isRecoverableImageCaptureError(error)) throw error;
              const recoveryCount = candidateRecoveryCounts.get(candidateKey) || 0;
              if (recoveryCount < 1) {
                candidateRecoveryCounts.set(candidateKey, recoveryCount + 1);
                timings.image_capture_recovery_trigger = compactError(error, "IMAGE_CAPTURE_FAILED");
                checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep, error });
                await closeRecommendDetail(client, { attemptsLimit: 2 }).catch(() => null);
                await closeRecommendAvatarPreview(client, { attemptsLimit: 2 }).catch(() => null);
                await closeRecommendBlockingPanels(client, { attemptsLimit: 2, rootState }).catch(() => null);
                await recoverAndReapplyRecommendContext(`image_capture:${detailStep}`, error, {
                  forceRecentNotView: true
                });
                continue;
              }
              imageEvidence = createRecoverableImageCaptureEvidence(error, {
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
        }
      } catch (error) {
        if (!isRecoverableRecommendDetailError(error)) throw error;
        const recoveryCount = candidateRecoveryCounts.get(candidateKey) || 0;
        if (recoveryCount < 1) {
          candidateRecoveryCounts.set(candidateKey, recoveryCount + 1);
          timings.detail_recovery_trigger = compactRecoverableDetailError(error);
          checkpointInProgressCandidate({ index, candidateKey, cardNodeId, detailStep, error });
          await closeRecommendDetail(client, { attemptsLimit: 2 }).catch(() => null);
          await closeRecommendAvatarPreview(client, { attemptsLimit: 2 }).catch(() => null);
          await closeRecommendBlockingPanels(client, { attemptsLimit: 2, rootState }).catch(() => null);
          await recoverAndReapplyRecommendContext(`detail:${detailStep}`, error, {
            forceRecentNotView: true
          });
          continue;
        }
        recoverableDetailError = error;
        detailResult = null;
        timings.detail_recovered_error = compactRecoverableDetailError(error);
        await closeRecommendDetail(client, { attemptsLimit: 2 }).catch(() => null);
        await closeRecommendAvatarPreview(client, { attemptsLimit: 2 }).catch(() => null);
        await closeRecommendBlockingPanels(client, { attemptsLimit: 2, rootState }).catch(() => null);
      }
    }

    await runControl.waitIfPaused();
    runControl.throwIfCanceled();
    runControl.setPhase("recommend:screening");
    let llmResult = null;
    if (useLlmScreening) {
      if (skipRecentColleagueContact || recoverableDetailError || detailResult?.image_evidence?.ok === false) {
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
            if (isFatalLlmProviderError(error)) {
              throw createFatalLlmRunError(error, {
                domain: "recommend",
                candidate: screeningCandidate
              });
            }
            llmResult = createFailedLlmScreeningResult(error);
          }
      }
      if (detailResult) detailResult.llm_result = llmResult;
    }
    const screening = skipRecentColleagueContact
      ? createRecentColleagueContactSkipScreening(screeningCandidate, colleagueContact)
      : recoverableDetailError
      ? createRecoverableDetailFailureScreening(screeningCandidate, recoverableDetailError)
      : detailResult?.image_evidence?.ok === false
      ? createImageCaptureFailureScreening(screeningCandidate, {
        code: detailResult.image_evidence.error_code,
        message: detailResult.image_evidence.error
      })
      : useLlmScreening
        ? llmResultToScreening(llmResult, screeningCandidate)
        : screenCandidate(screeningCandidate, { criteria });
    let actionDiscovery = null;
    let postActionResult = null;
    let closeFailureError = null;
    let closeRecoveryFailure = null;
    if (postActionEnabled && detailResult && !skipRecentColleagueContact) {
      const postActionStarted = Date.now();
      await runControl.waitIfPaused();
      runControl.throwIfCanceled();
      runControl.setPhase("recommend:post-action");
      await maybeHumanActionCooldown("before_post_action", timings);
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
      addTiming(timings, "post_action_ms", Date.now() - postActionStarted);
    }
    if (detailResult && closeDetail && !detailResult.close_result?.closed) {
      runControl.setPhase("recommend:close-detail");
      detailResult.close_result = await measureTiming(timings, "close_detail_ms", () => closeRecommendDetail(client));
      await maybeHumanActionCooldown("after_detail_close", timings);
      if (!detailResult.close_result?.closed) {
        closeFailureError = createRecommendCloseFailureError(detailResult.close_result);
        try {
          const recovery = await recoverAndReapplyRecommendContext("detail_close_failed", closeFailureError, {
            forceRecentNotView: true
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
    results.push(compactResult);
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
        error: compactResult.error,
        post_action: postActionResult
      }
    });
    addTiming(compactResult.timings, "checkpoint_save_ms", Date.now() - checkpointStarted);

    if (closeRecoveryFailure) {
      throw closeRecoveryFailure;
    }

    if (postActionResult?.stop_run) {
      listEndReason = postActionResult.reason || "post_action_stop";
      break;
    }

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
        updateRecommendProgress({
          human_rest_level: effectiveHumanBehavior.restLevel,
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

  runControl.setPhase("recommend:done");
  return {
    domain: "recommend",
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
    refresh_attempts: refreshAttempts,
    context_recoveries: contextRecoveryAttempts,
    debug_boundary: debugBoundary.getState(),
    list_read_stale_recovery_attempts: listReadStaleRecoveryAttempts,
    list_read_stale_recovery_applied: listReadStaleRecoveryApplied,
    list_read_stale_recoveries: listReadStaleRecoveries,
    last_list_read_recovery_mode: lastListReadRecoveryMode,
    last_list_read_stale_diagnostic: lastListReadStaleDiagnostic,
    list_read_stale_diagnostics: listReadStaleDiagnostics.slice(-12),
    ...countRecommendResultStatuses(results, { greetCount }),
    transient_recovered: countRecommendResultStatuses(results, { greetCount }).transient_recovered
      + listReadStaleRecoveries,
    results
  };
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
    screeningMode = "llm",
    llmConfig = null,
    llmTimeoutMs = 120000,
    llmImageLimit = 8,
    llmImageDetail = "high",
    imageOutputDir = "",
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
        llm_image_detail: llmImageDetail,
        image_output_dir: imageOutputDir || "",
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
        post_action_clicked: 0,
        image_capture_failed: 0,
        detail_open_failed: 0,
        transient_recovered: 0,
        colleague_contact_checked: 0,
        recent_colleague_contact_skipped: 0,
        colleague_contact_panel_missing: 0,
        context_recoveries: 0,
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
        llmImageDetail,
        imageOutputDir,
        humanRestEnabled: effectiveHumanRestEnabled,
        humanBehavior: effectiveHumanBehavior,
        skipRecentColleagueContacted: shouldSkipRecentColleagueContacted,
        colleagueContactWindowDays: normalizedColleagueContactWindowDays,
        debugTestMode: debugBoundaryOptions.debugTestMode,
        debugForceListEndAfterProcessed: debugBoundaryOptions.debugForceListEndAfterProcessed,
        debugForceContextRecoveryAfterProcessed: debugBoundaryOptions.debugForceContextRecoveryAfterProcessed,
        debugForceCdpReconnectAfterProcessed: debugBoundaryOptions.debugForceCdpReconnectAfterProcessed
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
