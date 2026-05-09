import {
  applyRecruitSearchParams,
  normalizeRecruitSearchParams
} from "./search.js";

export function buildRecruitRefreshSearchParams(searchParams = {}, {
  forceRecentViewed = true
} = {}) {
  const normalizedSearchParams = normalizeRecruitSearchParams(searchParams);
  return {
    ...normalizedSearchParams,
    filter_recent_viewed: forceRecentViewed ? true : normalizedSearchParams.filter_recent_viewed
  };
}

export async function refreshRecruitSearchAtEnd(client, {
  searchParams = {},
  requireCards = true,
  searchTimeoutMs = 90000,
  resetTimeoutMs = 180000,
  resetSettleMs = 5000,
  cityOptionTimeoutMs = 30000,
  forceRecentViewed = true
} = {}) {
  const refreshSearchParams = buildRecruitRefreshSearchParams(searchParams, { forceRecentViewed });
  const application = await applyRecruitSearchParams(client, {
    searchParams: refreshSearchParams,
    requireCards,
    resetBeforeApply: true,
    searchTimeoutMs,
    resetTimeoutMs,
    resetSettleMs,
    cityOptionTimeoutMs
  });
  const cardCount = application.post_search_state?.counts?.candidate_card || 0;
  return {
    ok: !requireCards || cardCount > 0,
    method: "page_reload_search",
    forced_recent_viewed: Boolean(forceRecentViewed),
    search_params: refreshSearchParams,
    card_count: cardCount,
    application
  };
}
