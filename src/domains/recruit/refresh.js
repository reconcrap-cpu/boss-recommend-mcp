import {
  applyRecruitSearchParams,
  normalizeRecruitSearchParams
} from "./search.js";

export function buildRecruitRefreshSearchParams(searchParams = {}) {
  return {
    ...normalizeRecruitSearchParams(searchParams),
    filter_recent_viewed: true
  };
}

export async function refreshRecruitSearchAtEnd(client, {
  searchParams = {},
  requireCards = true,
  searchTimeoutMs = 90000,
  resetTimeoutMs = 180000,
  resetSettleMs = 5000,
  cityOptionTimeoutMs = 30000
} = {}) {
  const refreshSearchParams = buildRecruitRefreshSearchParams(searchParams);
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
    forced_recent_viewed: true,
    search_params: refreshSearchParams,
    card_count: cardCount,
    application
  };
}
