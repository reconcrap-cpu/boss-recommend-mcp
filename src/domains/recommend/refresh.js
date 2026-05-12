import { sleep } from "../../core/browser/index.js";
import {
  clickRecommendEndRefreshButton,
  waitForRecommendCardNodeIds
} from "./cards.js";
import {
  RECOMMEND_RECENT_NOT_VIEW_LABEL,
  RECOMMEND_TARGET_URL
} from "./constants.js";
import { selectAndConfirmFirstSafeFilter } from "./filters.js";
import { selectRecommendJob } from "./jobs.js";
import { selectRecommendPageScope } from "./scopes.js";
import {
  getRecommendRoots,
  waitForRecommendRoots
} from "./roots.js";

function normalizeLabels(labels = []) {
  return labels.map((label) => String(label || "").trim()).filter(Boolean);
}

function normalizeFilterGroup(spec = {}) {
  return {
    group: String(spec.group || "").trim(),
    labels: normalizeLabels(spec.labels || spec.filterLabels || []),
    selectAllLabels: spec.selectAllLabels !== false
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
    if (group.group || group.labels.length) groups.push(group);
  }

  const rootGroup = normalizeFilterGroup(filter);
  if ((rootGroup.group || rootGroup.labels.length) && !groups.length) {
    groups.push(rootGroup);
  }

  if (forceRecentNotView) {
    const recentGroup = groups.find((item) => item.group === "recentNotView");
    if (recentGroup) {
      if (!recentGroup.labels.some((label) => label.replace(/\s+/g, "") === RECOMMEND_RECENT_NOT_VIEW_LABEL)) {
        recentGroup.labels.push(RECOMMEND_RECENT_NOT_VIEW_LABEL);
      }
      recentGroup.selectAllLabels = true;
    } else {
      groups.unshift({
        group: "recentNotView",
        labels: [RECOMMEND_RECENT_NOT_VIEW_LABEL],
        selectAllLabels: true
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
      selectAllLabels: singleGroup.selectAllLabels
    };
  }
  return {
    group: filter.group || "",
    labels: normalizeLabels(filter.labels || filter.filterLabels || []),
    selectAllLabels: filter.selectAllLabels !== false
  };
}

function refreshFailureReason(method = "") {
  return method === "page_navigate" ? "page_navigate_failed" : "page_reload_failed";
}

export function isRetryableRecommendFilterReapplyError(error) {
  const message = String(error?.message || error || "");
  return /Recommend filter panel did not open|Recommend filter trigger was not found|Recommend filter confirm button was not found|No matching recommend filter option/i.test(message);
}

function compactFilterReapplyError(error) {
  return error?.message || String(error || "Recommend filter reapply failed");
}

async function selectAndConfirmRefreshFilter(client, rootState, filterOptions, {
  maxAttempts = 3,
  retryDelayMs = 1500
} = {}) {
  const attempts = [];
  let currentRootState = rootState;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const filter = await selectAndConfirmFirstSafeFilter(
        client,
        currentRootState.iframe.documentNodeId,
        filterOptions
      );
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
  let pageScopeResult = null;
  let filterResult = null;
  let filterReapplyAttempts = [];
  try {
    if (method === "page_navigate") {
      await client.Page.navigate({ url: targetUrl || RECOMMEND_TARGET_URL });
    } else {
      await client.Page.reload({ ignoreCache: true });
    }
    if (reloadSettleMs > 0) await sleep(reloadSettleMs);
    currentRootState = await waitForRecommendRoots(client, {
      timeoutMs: Math.max(45000, reloadSettleMs * 6),
      intervalMs: 500
    });
    if (!currentRootState?.iframe?.documentNodeId) {
      throw new Error("Recommend iframe was not ready after refresh reload");
    }
    if (jobLabel) {
      jobSelection = await selectRecommendJob(client, currentRootState.iframe.documentNodeId, {
        jobLabel,
        settleMs: reloadSettleMs > 10000 ? 12000 : 6000
      });
      if (!jobSelection.selected) {
        throw new Error(`Requested recommend job was not selected after refresh reload: ${jobSelection.reason}`);
      }
      currentRootState = await getRecommendRoots(client);
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
    const filterSelection = await selectAndConfirmRefreshFilter(
      client,
      currentRootState,
      buildRecommendFilterSelectionOptions(filter, { forceRecentNotView }),
      {
        retryDelayMs: Math.max(1200, Math.min(5000, Math.floor((reloadSettleMs || 8000) / 2)))
      }
    );
    filterResult = filterSelection.filter;
    filterReapplyAttempts = filterSelection.attempts;
    currentRootState = await getRecommendRoots(client);
    const cardNodeIds = await waitForRecommendCardNodeIds(client, currentRootState.iframe.documentNodeId, {
      timeoutMs: cardTimeoutMs,
      intervalMs: 500
    });
    if (!cardNodeIds.length) {
      throw new Error("No recommend candidate cards were found after refresh reload");
    }
    return {
      ok: true,
      method,
      target_url: method === "page_navigate" ? (targetUrl || RECOMMEND_TARGET_URL) : null,
      job_selection: jobSelection,
      page_scope: pageScopeResult,
      filter: filterResult,
      filter_reapply_attempts: filterReapplyAttempts,
      card_count: cardNodeIds.length,
      root_state: currentRootState,
      forced_recent_not_view: forceRecentNotView,
      elapsed_ms: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      method,
      reason: refreshFailureReason(method),
      error: error?.message || String(error),
      target_url: method === "page_navigate" ? (targetUrl || RECOMMEND_TARGET_URL) : null,
      job_selection: jobSelection,
      page_scope: pageScopeResult,
      filter: filterResult,
      filter_reapply_attempts: error?.filter_reapply_attempts || filterReapplyAttempts,
      card_count: 0,
      root_state: currentRootState,
      forced_recent_not_view: forceRecentNotView,
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
      try {
        currentRootState = await getRecommendRoots(client);
        const pageScopeResult = await selectRecommendPageScope(
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
        const filterSelection = await selectAndConfirmRefreshFilter(
          client,
          currentRootState,
          buildRecommendFilterSelectionOptions(filter, { forceRecentNotView }),
          {
            retryDelayMs: Math.max(1200, Math.min(5000, Math.floor((buttonSettleMs || 8000) / 2)))
          }
        );
        const filterResult = filterSelection.filter;
        currentRootState = await getRecommendRoots(client);
        const cardNodeIds = await waitForRecommendCardNodeIds(client, currentRootState.iframe.documentNodeId, {
          timeoutMs: cardTimeoutMs,
          intervalMs: 500
        });
        return {
          ok: cardNodeIds.length > 0,
          method: "end_refresh_button",
          attempts,
          page_scope: pageScopeResult,
          filter: filterResult,
          filter_reapply_attempts: filterSelection.attempts,
          card_count: cardNodeIds.length,
          root_state: currentRootState,
          forced_recent_not_view: forceRecentNotView
        };
      } catch (error) {
        attempts.push({
          ok: false,
          method: "end_refresh_button_after_click",
          reason: "end_refresh_reapply_failed",
          error: error?.message || String(error)
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
      forced_recent_not_view: forceRecentNotView
    }),
    attempts
  };
}
