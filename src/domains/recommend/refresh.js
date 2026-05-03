import { sleep } from "../../core/browser/index.js";
import {
  clickRecommendEndRefreshButton,
  waitForRecommendCardNodeIds
} from "./cards.js";
import {
  RECOMMEND_RECENT_NOT_VIEW_LABEL
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

export async function refreshRecommendListAtEnd(client, {
  rootState = null,
  jobLabel = "",
  pageScope = "recommend",
  fallbackPageScope = "recommend",
  filter = {},
  preferEndRefreshButton = true,
  forceRecentNotView = true,
  cardTimeoutMs = 30000,
  buttonSettleMs = 8000,
  reloadSettleMs = 8000
} = {}) {
  const attempts = [];
  let currentRootState = rootState || await getRecommendRoots(client);

  if (preferEndRefreshButton) {
    const buttonResult = await clickRecommendEndRefreshButton(
      client,
      currentRootState.iframe.documentNodeId,
      { settleMs: buttonSettleMs }
    );
    attempts.push(buttonResult);
    if (buttonResult.ok) {
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
      const filterResult = await selectAndConfirmFirstSafeFilter(
        client,
        currentRootState.iframe.documentNodeId,
        buildRecommendFilterSelectionOptions(filter, { forceRecentNotView })
      );
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
        card_count: cardNodeIds.length,
        root_state: currentRootState,
        forced_recent_not_view: forceRecentNotView
      };
    }
  }

  await client.Page.reload({ ignoreCache: true });
  if (reloadSettleMs > 0) await sleep(reloadSettleMs);
  currentRootState = await waitForRecommendRoots(client, {
    timeoutMs: Math.max(30000, reloadSettleMs * 4),
    intervalMs: 500
  });
  if (!currentRootState?.iframe?.documentNodeId) {
    throw new Error("Recommend iframe was not ready after refresh reload");
  }
  let jobSelection = null;
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
  const pageScopeResult = await selectRecommendPageScope(
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
  const filterResult = await selectAndConfirmFirstSafeFilter(
    client,
    currentRootState.iframe.documentNodeId,
    buildRecommendFilterSelectionOptions(filter, { forceRecentNotView })
  );
  const cardNodeIds = await waitForRecommendCardNodeIds(client, currentRootState.iframe.documentNodeId, {
    timeoutMs: cardTimeoutMs,
    intervalMs: 500
  });
  return {
    ok: cardNodeIds.length > 0,
    method: "page_reload",
    attempts,
    job_selection: jobSelection,
    page_scope: pageScopeResult,
    filter: filterResult,
    card_count: cardNodeIds.length,
    root_state: currentRootState,
    forced_recent_not_view: forceRecentNotView
  };
}
