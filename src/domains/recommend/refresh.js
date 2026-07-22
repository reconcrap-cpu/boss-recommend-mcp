import {
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import { htmlToText, normalizeText } from "../../core/screening/index.js";
import {
  buildRecommendSelfHealConfig,
  resolveRecommendSelfHealRoots
} from "../../core/self-heal/index.js";
import {
  createRecoverySettleError,
  waitForMiniFreshStartSettle
} from "../common/recovery-settle.js";
import {
  clickRecommendEndRefreshButton,
  waitForRecommendCardNodeIds
} from "./cards.js";
import {
  RECOMMEND_BOTTOM_MARKER_SELECTORS,
  RECOMMEND_RECENT_NOT_VIEW_LABEL,
  RECOMMEND_TARGET_URL
} from "./constants.js";
import { selectAndConfirmFirstSafeFilter } from "./filters.js";
import { ensureRecommendCurrentCityOnly } from "./location.js";
import {
  selectRecommendJob,
  verifyRecommendJobSelection
} from "./jobs.js";
import { selectRecommendPageScope } from "./scopes.js";
import {
  getRecommendRoots,
  waitForRecommendRoots
} from "./roots.js";
import { isStaleRecommendNodeError } from "./detail.js";

function normalizeLabels(labels = []) {
  return labels.map((label) => String(label || "").trim()).filter(Boolean);
}

function normalizeFilterGroup(spec = {}) {
  return {
    group: String(spec.group || "").trim(),
    labels: normalizeLabels(spec.labels || spec.filterLabels || []),
    selectAllLabels: spec.selectAllLabels !== false,
    allowUnlimited: spec.allowUnlimited === true,
    verifySticky: spec.verifySticky === true
  };
}

export function buildRecommendFilterGroups(filter = {}, {
  forceRecentNotView = false
} = {}) {
  const groups = [];
  const sourceGroups = Array.isArray(filter.filterGroups)
    ? filter.filterGroups
    : Array.isArray(filter.groups)
      ? filter.groups
      : [];

  for (const spec of sourceGroups) {
    const group = normalizeFilterGroup(spec);
    if (group.group || group.labels.length) {
      group.verifySticky = true;
      groups.push(group);
    }
  }

  const rootGroup = normalizeFilterGroup(filter);
  if ((rootGroup.group || rootGroup.labels.length) && !groups.length) {
    rootGroup.verifySticky = true;
    groups.push(rootGroup);
  }

  if (forceRecentNotView) {
    const recentGroup = groups.find((item) => item.group === "recentNotView");
    if (recentGroup) {
      if (!recentGroup.labels.some((label) => label.replace(/\s+/g, "") === RECOMMEND_RECENT_NOT_VIEW_LABEL)) {
        recentGroup.labels.push(RECOMMEND_RECENT_NOT_VIEW_LABEL);
      }
      recentGroup.selectAllLabels = true;
      recentGroup.verifySticky = true;
    } else {
      groups.unshift({
        group: "recentNotView",
        labels: [RECOMMEND_RECENT_NOT_VIEW_LABEL],
        selectAllLabels: true,
        allowUnlimited: false,
        verifySticky: true
      });
    }
  }

  return groups;
}

export function buildRecommendFilterSelectionOptions(filter = {}, {
  forceRecentNotView = false
} = {}) {
  const filterGroups = buildRecommendFilterGroups(filter, { forceRecentNotView });
  if (filterGroups.length > 1 || forceRecentNotView || Array.isArray(filter.filterGroups) || Array.isArray(filter.groups)) {
    return { filterGroups };
  }
  const [singleGroup] = filterGroups;
  if (singleGroup) {
    return {
      group: singleGroup.group,
      labels: singleGroup.labels,
      selectAllLabels: singleGroup.selectAllLabels,
      allowUnlimited: singleGroup.allowUnlimited,
      verifySticky: singleGroup.verifySticky
    };
  }
  return {
    group: filter.group || "",
    labels: normalizeLabels(filter.labels || filter.filterLabels || []),
    selectAllLabels: filter.selectAllLabels !== false,
    allowUnlimited: filter.allowUnlimited === true,
    verifySticky: filter.verifySticky === true
  };
}

export async function applyRecommendFilterEnvelopeStages(filter = {}, {
  applyCurrentCityOnly,
  applyFilterPanel
} = {}) {
  if (filter.enabled === false) {
    return {
      applied: false,
      skipped: true,
      current_city_only: null,
      filter: null
    };
  }
  if (typeof applyCurrentCityOnly !== "function" || typeof applyFilterPanel !== "function") {
    throw new Error("Recommend native filter stages require location and filter-panel callbacks");
  }
  const currentCityOnlyResult = await applyCurrentCityOnly();
  const filterResult = await applyFilterPanel();
  return {
    applied: true,
    skipped: false,
    current_city_only: currentCityOnlyResult,
    filter: filterResult
  };
}

function refreshFailureReason(method = "") {
  return method === "page_navigate" ? "page_navigate_failed" : "page_reload_failed";
}

export function isVerifiedRecommendFilterApplication(filterResult, filterOptions = {}) {
  if (filterResult?.confirmed !== true) return false;
  const requestedGroups = Array.isArray(filterOptions.filterGroups) && filterOptions.filterGroups.length
    ? filterOptions.filterGroups
    : (filterOptions.group || filterOptions.labels?.length ? [filterOptions] : []);
  const normalizedRequested = requestedGroups
    .filter((group) => group && String(group.group || "").trim() && Array.isArray(group.labels) && group.labels.length)
    .map((group) => ({
      group: String(group.group || "").trim(),
      labels: [...new Set(normalizeLabels(group.labels).map((label) => label.replace(/\s+/g, "")))],
      allowUnlimited: group.allowUnlimited === true,
      selectAllLabels: group.selectAllLabels !== false
    }));
  if (!normalizedRequested.length) return true;
  if (filterResult?.sticky_verification?.verified !== true) return false;
  const verifiedGroups = Array.isArray(filterResult.sticky_verification.groups)
    ? filterResult.sticky_verification.groups
    : [];
  if (verifiedGroups.length !== normalizedRequested.length) return false;
  return normalizedRequested.every((requested) => {
    const matches = verifiedGroups.filter((group) => String(group?.group || "") === requested.group);
    if (matches.length !== 1 || matches[0]?.verified !== true) return false;
    const verifiedLabels = normalizeLabels(matches[0].requested_labels || [])
      .map((label) => label.replace(/\s+/g, ""));
    const uniqueVerifiedLabels = [...new Set(verifiedLabels)];
    if (
      uniqueVerifiedLabels.length !== requested.labels.length
      || !requested.labels.every((label) => uniqueVerifiedLabels.includes(label))
    ) {
      return false;
    }
    const activeLabels = [...new Set(normalizeLabels(matches[0].active_labels || [])
      .map((label) => label.replace(/\s+/g, "")))];
    if (matches[0].unavailable === true) {
      return requested.allowUnlimited
        && requested.labels.length === 1
        && requested.labels[0] === "不限"
        && activeLabels.length === 0;
    }
    if (!requested.selectAllLabels) {
      return activeLabels.length === 1 && requested.labels.includes(activeLabels[0]);
    }
    return activeLabels.length === requested.labels.length
      && requested.labels.every((label) => activeLabels.includes(label));
  });
}

const RECOMMEND_FILTERED_EMPTY_TEXTS = Object.freeze([
  "没有相关数据",
  "暂无相关数据"
]);

const RECOMMEND_FILTERED_EMPTY_TEXT_SCAN_SELECTORS = Object.freeze([
  ...RECOMMEND_BOTTOM_MARKER_SELECTORS,
  "[class*=\"empty\"]",
  "[class*=\"no-data\"]",
  "[class*=\"nodata\"]",
  "div, span, p, section, li"
]);

function normalizeRecommendFilteredEmptyText(value = "") {
  return normalizeText(value).replace(/\s+/g, "");
}

function isUsableVisibleBox(box) {
  return Number(box?.rect?.width || 0) > 2 && Number(box?.rect?.height || 0) > 2;
}

async function inspectRecommendEmptyStateAccessibility(client, nodeId, expectedText) {
  if (typeof client?.Accessibility?.getPartialAXTree !== "function") {
    return {
      available: false,
      verified: false,
      reason: "accessibility_unavailable"
    };
  }
  try {
    const result = await client.Accessibility.getPartialAXTree({
      nodeId,
      fetchRelatives: true
    });
    const expected = normalizeRecommendFilteredEmptyText(expectedText);
    const nodes = (result?.nodes || []).map((node) => ({
      ignored: node?.ignored === true,
      role: node?.role?.value || "",
      name: node?.name?.value || "",
      value: node?.value?.value || ""
    }));
    const match = nodes.find((node) => (
      !node.ignored
      && [node.name, node.value].some((value) => (
        normalizeRecommendFilteredEmptyText(value) === expected
      ))
    ));
    return {
      available: true,
      verified: Boolean(match),
      reason: match ? "exact_accessible_text" : "exact_accessible_text_missing",
      match: match || null,
      node_count: nodes.length
    };
  } catch (error) {
    return {
      available: true,
      verified: false,
      reason: "accessibility_probe_failed",
      error: error?.message || String(error)
    };
  }
}

export async function inspectRecommendFilteredEmptyState(client, rootNodeId, {
  selectors = RECOMMEND_FILTERED_EMPTY_TEXT_SCAN_SELECTORS,
  exactTexts = RECOMMEND_FILTERED_EMPTY_TEXTS,
  maxNodes = 2500
} = {}) {
  if (!client || !rootNodeId) {
    return {
      verified: false,
      reason: "missing_client_or_root",
      text: null,
      node_id: null
    };
  }
  const expectedTexts = new Set(
    (exactTexts || []).map(normalizeRecommendFilteredEmptyText).filter(Boolean)
  );
  const selectorCounts = {};
  const queryErrors = [];
  const nodeIds = [];
  for (const selector of selectors || []) {
    try {
      const matches = await querySelectorAll(client, rootNodeId, selector);
      selectorCounts[selector] = matches.length;
      nodeIds.push(...matches);
    } catch (error) {
      selectorCounts[selector] = null;
      queryErrors.push({
        selector,
        error: error?.message || String(error)
      });
    }
  }

  const uniqueNodeIds = Array.from(new Set(nodeIds.filter(Boolean)))
    .slice(0, Math.max(0, Number(maxNodes) || 0));
  let checkedNodeCount = 0;
  for (const nodeId of uniqueNodeIds) {
    let text = "";
    try {
      text = normalizeRecommendFilteredEmptyText(htmlToText(await getOuterHTML(client, nodeId)));
    } catch {
      continue;
    }
    if (!expectedTexts.has(text)) continue;
    checkedNodeCount += 1;
    let box = null;
    try {
      box = await getNodeBox(client, nodeId);
    } catch {
      continue;
    }
    if (!isUsableVisibleBox(box)) continue;
    const accessibility = await inspectRecommendEmptyStateAccessibility(client, nodeId, text);
    if (accessibility.verified !== true) continue;
    return {
      verified: true,
      reason: "exact_visible_filtered_empty_state",
      text,
      node_id: nodeId,
      box: {
        x: box.rect.x,
        y: box.rect.y,
        width: box.rect.width,
        height: box.rect.height
      },
      accessibility,
      selector_counts: selectorCounts,
      checked_node_count: checkedNodeCount,
      candidate_node_count: uniqueNodeIds.length,
      query_errors: queryErrors.slice(0, 20)
    };
  }

  return {
    verified: false,
    reason: checkedNodeCount > 0
      ? "exact_empty_text_not_visible_or_accessible"
      : "exact_empty_text_not_found",
    text: null,
    node_id: null,
    selector_counts: selectorCounts,
    checked_node_count: checkedNodeCount,
    candidate_node_count: uniqueNodeIds.length,
    query_errors: queryErrors.slice(0, 20)
  };
}

export function isVerifiedRecommendRefreshExhaustion({
  cardCount = 0,
  filter = {},
  filterResult = null,
  pageScopeResult = null,
  currentCityOnlyResult = null,
  emptyState = null
} = {}) {
  if (
    Number(cardCount) !== 0
    || pageScopeResult?.selected !== true
    || emptyState?.verified !== true
  ) return false;
  const filterEnabled = filter?.enabled !== false;
  if (filterEnabled && !isVerifiedRecommendFilterApplication(
    filterResult,
    buildRecommendFilterSelectionOptions(filter)
  )) {
    return false;
  }
  const currentCityOnlyRequested = filter?.currentCityOnly === true || filter?.current_city_only === true;
  if (currentCityOnlyRequested && currentCityOnlyResult?.effective !== true) return false;
  return true;
}

function safeDiagnosticText(value, maxLength = 4000) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function safeDiagnosticStack(stack) {
  if (!stack) return null;
  return safeDiagnosticText(stack, 8000)
    .split(/\r?\n/)
    .slice(0, 12)
    .join("\n");
}

function buildErrorDiagnostic(error, {
  depth = 0,
  seen = new Set()
} = {}) {
  if (!error) return null;
  const isRecord = typeof error === "object" || typeof error === "function";
  if (isRecord && seen.has(error)) {
    return {
      name: error?.name || "Error",
      message: safeDiagnosticText(error?.message || String(error)),
      circular: true
    };
  }
  if (isRecord) seen.add(error);
  const diagnostic = {
    name: error?.name || "Error",
    message: safeDiagnosticText(error?.message || String(error))
  };
  if (error?.code !== undefined && error?.code !== null && error.code !== "") {
    diagnostic.code = typeof error.code === "number"
      ? error.code
      : safeDiagnosticText(error.code, 300);
  }
  if (error?.phase) diagnostic.phase = safeDiagnosticText(error.phase, 300);
  if (error?.cdp_method) diagnostic.cdp_method = safeDiagnosticText(error.cdp_method, 300);
  if (error?.cdp_at) diagnostic.cdp_at = safeDiagnosticText(error.cdp_at, 100);
  if (Number.isInteger(error?.cdp_node_id)) diagnostic.cdp_node_id = error.cdp_node_id;
  if (Number.isInteger(error?.cdp_backend_node_id)) {
    diagnostic.cdp_backend_node_id = error.cdp_backend_node_id;
  }
  if (Number.isInteger(error?.node_id)) diagnostic.node_id = error.node_id;
  if (Number.isInteger(error?.backend_node_id)) diagnostic.backend_node_id = error.backend_node_id;
  if (error?.cdp_search_id) diagnostic.cdp_search_id = safeDiagnosticText(error.cdp_search_id, 300);
  if (Array.isArray(error?.cdp_param_keys)) {
    diagnostic.cdp_param_keys = error.cdp_param_keys
      .slice(0, 20)
      .map((key) => safeDiagnosticText(key, 100));
  }
  const stack = safeDiagnosticStack(error?.stack);
  if (stack) diagnostic.stack = stack;
  if (depth < 2 && error?.cause && error.cause !== error) {
    diagnostic.cause = buildErrorDiagnostic(error.cause, {
      depth: depth + 1,
      seen
    });
  }
  return diagnostic;
}

export function compactRecommendRefreshErrorDiagnostic(error) {
  return buildErrorDiagnostic(error);
}

export function isRetryableRecommendFilterReapplyError(error) {
  const messages = [];
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if ((typeof current === "object" || typeof current === "function") && seen.has(current)) break;
    if (typeof current === "object" || typeof current === "function") seen.add(current);
    if (isStaleRecommendNodeError(current)) return true;
    messages.push(String(current?.message || current || ""));
    current = current?.cause;
  }
  const message = messages.join("\n");
  return /Recommend filter panel did not open|Recommend filter trigger was not found|Recommend filter confirm button was not found|Recommend filter application was not verified|No matching recommend filter option|Invalid (?:backend )?node(?:\s*id)?|Node with given id does not exist|No node found for given backend id/i.test(message);
}

function compactFilterReapplyError(error) {
  return error?.message || String(error || "Recommend filter reapply failed");
}

export function isRetryableRecommendJobSelectionError(error) {
  if (isStaleRecommendNodeError(error)) return true;
  const message = String(error?.message || error || "");
  return /Recommend job trigger was not found|Recommend job dropdown did not mount options|Recommend job dropdown did not expose visible options|Matched recommend job has no clickable center|Matched recommend job has no visible clickable option|Recommend job selection was not sticky|Recommend job dropdown remained open after sticky verification/i.test(message);
}

function compactJobSelectionAttempt({
  ok = false,
  attempt = 0,
  iframeDocumentNodeId = 0,
  error = null,
  selection = null
} = {}) {
  return {
    ok: Boolean(ok),
    method: "job_select",
    reason: error ? "job_select_failed" : null,
    error: error ? (error?.message || String(error)) : null,
    error_diagnostic: error ? compactRecommendRefreshErrorDiagnostic(error) : null,
    attempt,
    iframe_document_node_id: iframeDocumentNodeId || 0,
    selected: Boolean(selection?.selected),
    selection_reason: selection?.reason || null,
    sticky_verified: selection?.sticky_verification?.verified ?? null,
    sticky_current_label: selection?.sticky_verification?.current_label_without_salary
      || selection?.sticky_verification?.current_label
      || null,
    sticky_menu_closed: selection?.sticky_verification?.menu_close?.ok ?? null
  };
}

async function waitForRecommendRecoverySettle(client, {
  reloadSettleMs = 8000,
  timeoutMs = 90000
} = {}) {
  return waitForMiniFreshStartSettle(client, {
    domain: "recommend",
    timeoutMs,
    intervalMs: reloadSettleMs > 10000 ? 1200 : 800,
    settleMs: Math.max(0, Math.min(reloadSettleMs || 0, 5000)),
    selfHealConfig: buildRecommendSelfHealConfig(),
    resolveSelfHealRoots: resolveRecommendSelfHealRoots
  });
}

async function waitForFreshRecommendRoots(client, {
  timeoutMs = 10000,
  intervalMs = 500
} = {}) {
  const rootState = await waitForRecommendRoots(client, {
    timeoutMs,
    intervalMs
  });
  return rootState?.iframe?.documentNodeId ? rootState : null;
}

export async function selectRecommendJobWithRootRefresh(client, rootState, {
  jobLabel = "",
  settleMs = 6000,
  dropdownTimeoutMs = 4000,
  totalTimeoutMs = 30000,
  retryDelayMs = 1000
} = {}) {
  const started = Date.now();
  const attempts = [];
  let currentRootState = rootState || null;
  let lastError = null;
  let attempt = 0;

  while (Date.now() - started <= totalTimeoutMs) {
    attempt += 1;
    if (!currentRootState?.iframe?.documentNodeId) {
      currentRootState = await waitForFreshRecommendRoots(client, {
        timeoutMs: Math.min(10000, Math.max(2000, totalTimeoutMs - (Date.now() - started))),
        intervalMs: 500
      });
    }
    const iframeDocumentNodeId = currentRootState?.iframe?.documentNodeId || 0;
    try {
      const selection = await selectRecommendJob(client, iframeDocumentNodeId, {
        jobLabel,
        settleMs,
        dropdownTimeoutMs
      });
      if (selection.selected) {
        const stickyRootState = await waitForFreshRecommendRoots(client, {
          timeoutMs: Math.min(10000, Math.max(2000, totalTimeoutMs - (Date.now() - started))),
          intervalMs: 500
        }) || currentRootState;
        const stickyFrameNodeId = stickyRootState?.iframe?.documentNodeId || iframeDocumentNodeId;
        const stickyVerification = await verifyRecommendJobSelection(client, stickyFrameNodeId, {
          jobLabel,
          delayMs: 2000,
          dropdownTimeoutMs,
          closeSettleMs: 300
        });
        selection.sticky_verification = stickyVerification;
        currentRootState = stickyRootState || currentRootState;
        if (!stickyVerification.verified) {
          const stickyError = new Error(`Recommend job selection was not sticky after 2s: requested=${jobLabel}; current=${stickyVerification.current_label_without_salary || stickyVerification.current_label || "unknown"}`);
          stickyError.sticky_verification = stickyVerification;
          throw stickyError;
        }
        if (stickyVerification.menu_close && stickyVerification.menu_close.ok === false) {
          const closeError = new Error(`Recommend job dropdown remained open after sticky verification: ${stickyVerification.menu_close.reason || "unknown"}`);
          closeError.sticky_verification = stickyVerification;
          throw closeError;
        }
      }
      attempts.push(compactJobSelectionAttempt({
        ok: true,
        attempt,
        iframeDocumentNodeId,
        selection
      }));
      return {
        job_selection: {
          ...selection,
          refresh_attempts: attempts
        },
        root_state: currentRootState,
        attempts
      };
    } catch (error) {
      lastError = error;
      attempts.push(compactJobSelectionAttempt({
        ok: false,
        attempt,
        iframeDocumentNodeId,
        error
      }));
      if (!isRetryableRecommendJobSelectionError(error) || Date.now() - started >= totalTimeoutMs) {
        break;
      }
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      currentRootState = await waitForFreshRecommendRoots(client, {
        timeoutMs: Math.min(10000, Math.max(2000, totalTimeoutMs - (Date.now() - started))),
        intervalMs: 500
      });
    }
  }

  const wrapped = new Error(lastError?.message || "Recommend job selection failed after refresh reload");
  wrapped.cause = lastError;
  wrapped.job_selection_attempts = attempts;
  throw wrapped;
}

export async function selectAndConfirmRefreshFilter(client, rootState, filterOptions, {
  maxAttempts = 3,
  retryDelayMs = 1500,
  selectFilter = selectAndConfirmFirstSafeFilter
} = {}) {
  const attempts = [];
  let currentRootState = rootState;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const filter = await selectFilter(
        client,
        currentRootState.iframe.documentNodeId,
        filterOptions
      );
      if (!isVerifiedRecommendFilterApplication(filter, filterOptions)) {
        const verificationError = new Error("Recommend filter application was not verified after refresh");
        verificationError.code = "RECOMMEND_FILTER_APPLICATION_UNVERIFIED";
        verificationError.filter_result = filter;
        throw verificationError;
      }
      attempts.push({
        ok: true,
        method: "filter_reapply",
        attempt
      });
      return {
        filter,
        root_state: currentRootState,
        attempts
      };
    } catch (error) {
      lastError = error;
      attempts.push({
        ok: false,
        method: "filter_reapply",
        reason: "filter_reapply_failed",
        error: compactFilterReapplyError(error),
        error_diagnostic: compactRecommendRefreshErrorDiagnostic(error),
        attempt
      });
      if (attempt >= maxAttempts || !isRetryableRecommendFilterReapplyError(error)) {
        break;
      }
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      currentRootState = await getRecommendRoots(client);
    }
  }

  const wrapped = new Error(compactFilterReapplyError(lastError));
  wrapped.cause = lastError;
  wrapped.filter_reapply_attempts = attempts;
  throw wrapped;
}

function compactCurrentCityOnlyReapplyError(error) {
  return error?.message || String(error || "Recommend current-city-only reapply failed");
}

function isRetryableRecommendCurrentCityOnlyReapplyError(error) {
  if (isStaleRecommendNodeError(error)) return true;
  const message = compactCurrentCityOnlyReapplyError(error);
  return /current-city|current city|location|popover|trigger|checkbox|stale|did not (?:open|mount|close)/i.test(message)
    && !/unavailable/i.test(message);
}

async function ensureRefreshCurrentCityOnly(client, rootState, {
  enabled = false,
  maxAttempts = 3,
  retryDelayMs = 1500
} = {}) {
  const attempts = [];
  let currentRootState = rootState;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await ensureRecommendCurrentCityOnly(
        client,
        currentRootState.iframe.documentNodeId,
        { enabled }
      );
      attempts.push({
        ok: true,
        method: "current_city_only_reapply",
        attempt,
        result
      });
      return {
        current_city_only: result,
        root_state: currentRootState,
        attempts
      };
    } catch (error) {
      lastError = error;
      attempts.push({
        ok: false,
        method: "current_city_only_reapply",
        reason: "current_city_only_reapply_failed",
        error: compactCurrentCityOnlyReapplyError(error),
        error_diagnostic: compactRecommendRefreshErrorDiagnostic(error),
        attempt
      });
      if (attempt >= maxAttempts || !isRetryableRecommendCurrentCityOnlyReapplyError(error)) {
        break;
      }
      if (retryDelayMs > 0) await sleep(retryDelayMs);
      currentRootState = await getRecommendRoots(client);
    }
  }

  const wrapped = new Error(compactCurrentCityOnlyReapplyError(lastError));
  wrapped.cause = lastError;
  wrapped.current_city_only_attempts = attempts;
  throw wrapped;
}

async function applyRefreshMethod(client, method, {
  jobLabel = "",
  pageScope = "recommend",
  fallbackPageScope = "recommend",
  filter = {},
  targetUrl = RECOMMEND_TARGET_URL,
  forceRecentNotView = true,
  cardTimeoutMs = 30000,
  reloadSettleMs = 8000
} = {}) {
  const started = Date.now();
  let currentRootState = null;
  let jobSelection = null;
  let jobSelectionAttempts = [];
  let pageScopeResult = null;
  let currentCityOnlyResult = null;
  let currentCityOnlyAttempts = [];
  let filterResult = null;
  let filterReapplyAttempts = [];
  let recoverySettle = null;
  try {
    if (method === "page_navigate") {
      await client.Page.navigate({ url: targetUrl || RECOMMEND_TARGET_URL });
    } else {
      await client.Page.reload({ ignoreCache: true });
    }
    recoverySettle = await waitForRecommendRecoverySettle(client, {
      reloadSettleMs,
      timeoutMs: Math.max(45000, reloadSettleMs * 6)
    });
    if (!recoverySettle.ok) {
      throw createRecoverySettleError("recommend", recoverySettle);
    }
    currentRootState = await waitForRecommendRoots(client, {
      timeoutMs: Math.max(45000, reloadSettleMs * 6),
      intervalMs: 500
    });
    if (!currentRootState?.iframe?.documentNodeId) {
      throw new Error("Recommend iframe was not ready after refresh reload");
    }
    if (jobLabel) {
      const jobSelectionResult = await selectRecommendJobWithRootRefresh(client, currentRootState, {
        jobLabel,
        settleMs: reloadSettleMs > 10000 ? 12000 : 6000,
        dropdownTimeoutMs: 4000,
        totalTimeoutMs: reloadSettleMs > 10000 ? 45000 : 30000,
        retryDelayMs: 1200
      });
      jobSelection = jobSelectionResult.job_selection;
      jobSelectionAttempts = jobSelectionResult.attempts;
      if (!jobSelection.selected) {
        throw new Error(`Requested recommend job was not selected after refresh reload: ${jobSelection.reason}`);
      }
      currentRootState = jobSelectionResult.root_state || await getRecommendRoots(client);
    }
    pageScopeResult = await selectRecommendPageScope(
      client,
      currentRootState.iframe.documentNodeId,
      {
        pageScope,
        fallbackScope: fallbackPageScope,
        settleMs: reloadSettleMs > 10000 ? 3000 : 1200,
        timeoutMs: Math.max(10000, Math.min(cardTimeoutMs, 60000))
      }
    );
    if (!pageScopeResult.selected) {
      throw new Error(`Recommend page scope was not selected after refresh reload: ${pageScopeResult.reason || pageScope}`);
    }
    currentRootState = await getRecommendRoots(client);
    const retryDelayMs = Math.max(1200, Math.min(5000, Math.floor((reloadSettleMs || 8000) / 2)));
    const filterStages = await applyRecommendFilterEnvelopeStages(filter, {
      applyCurrentCityOnly: async () => {
        const selection = await ensureRefreshCurrentCityOnly(client, currentRootState, {
          enabled: filter.currentCityOnly === true || filter.current_city_only === true,
          retryDelayMs
        });
        currentCityOnlyAttempts = selection.attempts;
        currentRootState = await getRecommendRoots(client);
        return selection.current_city_only;
      },
      applyFilterPanel: async () => {
        const selection = await selectAndConfirmRefreshFilter(
          client,
          currentRootState,
          buildRecommendFilterSelectionOptions(filter, { forceRecentNotView }),
          { retryDelayMs }
        );
        filterReapplyAttempts = selection.attempts;
        currentRootState = await getRecommendRoots(client);
        return selection.filter;
      }
    });
    currentCityOnlyResult = filterStages.current_city_only;
    filterResult = filterStages.filter;
    const cardNodeIds = await waitForRecommendCardNodeIds(client, currentRootState.iframe.documentNodeId, {
      timeoutMs: cardTimeoutMs,
      intervalMs: 500
    });
    const emptyState = cardNodeIds.length === 0
      ? await inspectRecommendFilteredEmptyState(client, currentRootState.iframe.documentNodeId)
      : null;
    const exhausted = isVerifiedRecommendRefreshExhaustion({
      cardCount: cardNodeIds.length,
      filter,
      filterResult,
      pageScopeResult,
      currentCityOnlyResult,
      emptyState
    });
    if (!cardNodeIds.length && !exhausted) {
      throw new Error("No recommend candidate cards were found after refresh reload");
    }
    return {
      ok: true,
      exhausted,
      reason: exhausted ? "filtered_list_exhausted" : null,
      method,
      target_url: method === "page_navigate" ? (targetUrl || RECOMMEND_TARGET_URL) : null,
      job_selection: jobSelection,
      job_selection_attempts: jobSelectionAttempts,
      recovery_settle: recoverySettle,
      page_scope: pageScopeResult,
      current_city_only: currentCityOnlyResult,
      current_city_only_attempts: currentCityOnlyAttempts,
      filter: filterResult,
      filter_reapply_attempts: filterReapplyAttempts,
      card_count: cardNodeIds.length,
      empty_state: emptyState,
      root_state: currentRootState,
      forced_recent_not_view: Boolean(forceRecentNotView && filter.enabled !== false),
      elapsed_ms: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      method,
      reason: refreshFailureReason(method),
      error: error?.message || String(error),
      error_diagnostic: compactRecommendRefreshErrorDiagnostic(error),
      target_url: method === "page_navigate" ? (targetUrl || RECOMMEND_TARGET_URL) : null,
      job_selection: jobSelection,
      job_selection_attempts: error?.job_selection_attempts || jobSelectionAttempts,
      recovery_settle: error?.recovery_settle || recoverySettle,
      page_scope: pageScopeResult,
      current_city_only: currentCityOnlyResult,
      current_city_only_attempts: error?.current_city_only_attempts || currentCityOnlyAttempts,
      filter: filterResult,
      filter_reapply_attempts: error?.filter_reapply_attempts || filterReapplyAttempts,
      card_count: 0,
      root_state: currentRootState,
      forced_recent_not_view: Boolean(forceRecentNotView && filter.enabled !== false),
      elapsed_ms: Date.now() - started
    };
  }
}

export async function refreshRecommendListAtEnd(client, {
  rootState = null,
  jobLabel = "",
  pageScope = "recommend",
  fallbackPageScope = "recommend",
  filter = {},
  preferEndRefreshButton = true,
  forceNavigate = false,
  targetUrl = RECOMMEND_TARGET_URL,
  forceRecentNotView = true,
  cardTimeoutMs = 30000,
  buttonSettleMs = 8000,
  reloadSettleMs = 8000
} = {}) {
  const attempts = [];
  let currentRootState = rootState || null;

  if (preferEndRefreshButton) {
    currentRootState = currentRootState || await getRecommendRoots(client);
    const buttonResult = await clickRecommendEndRefreshButton(
      client,
      currentRootState.iframe.documentNodeId,
      { settleMs: buttonSettleMs }
    );
    attempts.push(buttonResult);
    if (buttonResult.ok) {
      let pageScopeResult = null;
      let currentCityOnlyResult = null;
      let currentCityOnlyAttempts = [];
      let filterResult = null;
      let filterReapplyAttempts = [];
      try {
        currentRootState = await getRecommendRoots(client);
        pageScopeResult = await selectRecommendPageScope(
          client,
          currentRootState.iframe.documentNodeId,
          {
            pageScope,
            fallbackScope: fallbackPageScope,
            settleMs: buttonSettleMs > 10000 ? 3000 : 1200,
            timeoutMs: Math.max(10000, Math.min(cardTimeoutMs, 60000))
          }
        );
        if (!pageScopeResult.selected) {
          throw new Error(`Recommend page scope was not selected after end refresh: ${pageScopeResult.reason || pageScope}`);
        }
        currentRootState = await getRecommendRoots(client);
        const retryDelayMs = Math.max(1200, Math.min(5000, Math.floor((buttonSettleMs || 8000) / 2)));
        const filterStages = await applyRecommendFilterEnvelopeStages(filter, {
          applyCurrentCityOnly: async () => {
            const selection = await ensureRefreshCurrentCityOnly(client, currentRootState, {
              enabled: filter.currentCityOnly === true || filter.current_city_only === true,
              retryDelayMs
            });
            currentCityOnlyAttempts = selection.attempts;
            currentRootState = await getRecommendRoots(client);
            return selection.current_city_only;
          },
          applyFilterPanel: async () => {
            const selection = await selectAndConfirmRefreshFilter(
              client,
              currentRootState,
              buildRecommendFilterSelectionOptions(filter, { forceRecentNotView }),
              { retryDelayMs }
            );
            filterReapplyAttempts = selection.attempts;
            currentRootState = await getRecommendRoots(client);
            return selection.filter;
          }
        });
        currentCityOnlyResult = filterStages.current_city_only;
        filterResult = filterStages.filter;
        const cardNodeIds = await waitForRecommendCardNodeIds(client, currentRootState.iframe.documentNodeId, {
          timeoutMs: cardTimeoutMs,
          intervalMs: 500
        });
        const emptyState = cardNodeIds.length === 0
          ? await inspectRecommendFilteredEmptyState(client, currentRootState.iframe.documentNodeId)
          : null;
        const exhausted = isVerifiedRecommendRefreshExhaustion({
          cardCount: cardNodeIds.length,
          filter,
          filterResult,
          pageScopeResult,
          currentCityOnlyResult,
          emptyState
        });
        if (cardNodeIds.length > 0 || exhausted) {
          return {
            ok: true,
            exhausted,
            reason: exhausted ? "filtered_list_exhausted" : null,
            method: "end_refresh_button",
            attempts,
            page_scope: pageScopeResult,
            current_city_only: currentCityOnlyResult,
            current_city_only_attempts: currentCityOnlyAttempts,
            filter: filterResult,
            filter_reapply_attempts: filterReapplyAttempts,
            card_count: cardNodeIds.length,
            empty_state: emptyState,
            root_state: currentRootState,
            forced_recent_not_view: Boolean(forceRecentNotView && filter.enabled !== false)
          };
        }
        attempts.push({
          ok: false,
          method: "end_refresh_button_after_click",
          reason: "end_refresh_empty_state_unverified",
          page_scope: pageScopeResult,
          current_city_only: currentCityOnlyResult,
          current_city_only_attempts: currentCityOnlyAttempts,
          filter: filterResult,
          filter_reapply_attempts: filterReapplyAttempts,
          card_count: 0,
          empty_state: emptyState,
          forced_recent_not_view: Boolean(forceRecentNotView && filter.enabled !== false)
        });
      } catch (error) {
        attempts.push({
          ok: false,
          method: "end_refresh_button_after_click",
          reason: "end_refresh_reapply_failed",
          error: error?.message || String(error),
          error_diagnostic: compactRecommendRefreshErrorDiagnostic(error),
          page_scope: pageScopeResult,
          current_city_only: currentCityOnlyResult,
          current_city_only_attempts: error?.current_city_only_attempts || currentCityOnlyAttempts,
          filter: filterResult,
          filter_reapply_attempts: error?.filter_reapply_attempts || filterReapplyAttempts,
          forced_recent_not_view: Boolean(forceRecentNotView && filter.enabled !== false)
        });
      }
    }
  }

  const fallbackMethods = [];
  if (forceNavigate && typeof client?.Page?.navigate === "function") {
    fallbackMethods.push("page_navigate");
  }
  if (typeof client?.Page?.reload === "function") {
    fallbackMethods.push("page_reload");
  }
  if (!fallbackMethods.length) {
    fallbackMethods.push("page_reload");
  }

  let lastRefreshResult = null;
  for (const method of fallbackMethods) {
    const refreshResult = await applyRefreshMethod(client, method, {
      jobLabel,
      pageScope,
      fallbackPageScope,
      filter,
      targetUrl,
      forceRecentNotView,
      cardTimeoutMs,
      reloadSettleMs
    });
    if (refreshResult.ok) {
      return {
        ...refreshResult,
        attempts
      };
    }
    attempts.push(refreshResult);
    lastRefreshResult = refreshResult;
  }

  return {
    ...(lastRefreshResult || {
      ok: false,
      method: fallbackMethods[fallbackMethods.length - 1] || "page_reload",
      reason: "refresh_failed",
      error: "Recommend refresh did not run",
      card_count: 0,
      root_state: currentRootState,
      forced_recent_not_view: Boolean(forceRecentNotView && filter.enabled !== false)
    }),
    attempts
  };
}
