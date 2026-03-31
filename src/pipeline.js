import { parseRecommendInstruction } from "./parser.js";
import {
  ensureBossRecommendPageReady,
  runPipelinePreflight,
  runRecommendSearchCli,
  runRecommendScreenCli
} from "./adapters.js";

function buildRequiredConfirmations(parsedResult) {
  const confirmations = [];
  if (parsedResult.needs_filters_confirmation) confirmations.push("filters");
  if (parsedResult.needs_school_tag_confirmation) confirmations.push("school_tag");
  if (parsedResult.needs_degree_confirmation) confirmations.push("degree");
  if (parsedResult.needs_gender_confirmation) confirmations.push("gender");
  if (parsedResult.needs_recent_not_view_confirmation) confirmations.push("recent_not_view");
  if (parsedResult.needs_criteria_confirmation) confirmations.push("criteria");
  if (parsedResult.needs_target_count_confirmation) confirmations.push("target_count");
  if (parsedResult.needs_post_action_confirmation) confirmations.push("post_action");
  if (parsedResult.needs_max_greet_count_confirmation) confirmations.push("max_greet_count");
  return confirmations;
}

function buildNeedInputResponse(parsedResult) {
  return {
    status: "NEED_INPUT",
    missing_fields: parsedResult.missing_fields,
    required_confirmations: buildRequiredConfirmations(parsedResult),
    search_params: parsedResult.searchParams,
    screen_params: parsedResult.screenParams,
    pending_questions: parsedResult.pending_questions,
    review: parsedResult.review,
    error: {
      code: "MISSING_REQUIRED_FIELDS",
      message: "缺少必要的筛选 criteria，请先补充或通过 overrides.criteria 明确传入。",
      retryable: true
    }
  };
}

function buildNeedConfirmationResponse(parsedResult) {
  return {
    status: "NEED_CONFIRMATION",
    required_confirmations: buildRequiredConfirmations(parsedResult),
    search_params: parsedResult.searchParams,
    screen_params: {
      ...parsedResult.screenParams,
      target_count: parsedResult.proposed_target_count ?? parsedResult.screenParams.target_count,
      post_action: parsedResult.proposed_post_action || parsedResult.screenParams.post_action,
      max_greet_count: parsedResult.proposed_max_greet_count || parsedResult.screenParams.max_greet_count
    },
    pending_questions: parsedResult.pending_questions,
    review: parsedResult.review
  };
}

function buildFailedResponse(code, message, extra = {}) {
  return {
    status: "FAILED",
    error: {
      code,
      message,
      retryable: true
    },
    ...extra
  };
}

const defaultDependencies = {
  parseRecommendInstruction,
  ensureBossRecommendPageReady,
  runPipelinePreflight,
  runRecommendSearchCli,
  runRecommendScreenCli
};

export async function runRecommendPipeline(
  { workspaceRoot, instruction, confirmation, overrides },
  dependencies = defaultDependencies
) {
  const {
    parseRecommendInstruction: parseInstruction,
    ensureBossRecommendPageReady: ensureRecommendPageReady,
    runPipelinePreflight: runPreflight,
    runRecommendSearchCli: searchCli,
    runRecommendScreenCli: screenCli
  } = dependencies;
  const startedAt = Date.now();
  const parsed = parseInstruction({ instruction, confirmation, overrides });

  if (parsed.missing_fields.length > 0) {
    return buildNeedInputResponse(parsed);
  }

  if (
    parsed.needs_filters_confirmation
    || parsed.needs_school_tag_confirmation
    || parsed.needs_degree_confirmation
    || parsed.needs_gender_confirmation
    || parsed.needs_recent_not_view_confirmation
    || parsed.needs_criteria_confirmation
    || parsed.needs_target_count_confirmation
    || parsed.needs_post_action_confirmation
    || parsed.needs_max_greet_count_confirmation
  ) {
    return buildNeedConfirmationResponse(parsed);
  }

  const preflight = runPreflight(workspaceRoot);
  if (!preflight.ok) {
    return buildFailedResponse(
      "PIPELINE_PREFLIGHT_FAILED",
      "Recommend 流水线运行前检查失败，请先修复缺失的本地依赖或配置文件。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          checks: preflight.checks,
          debug_port: preflight.debug_port
        }
      }
    );
  }

  const pageCheck = await ensureRecommendPageReady(workspaceRoot, {
    port: preflight.debug_port
  });
  if (!pageCheck.ok) {
    const loginRelated = new Set(["LOGIN_REQUIRED", "LOGIN_REQUIRED_AFTER_REDIRECT"]);
    return buildFailedResponse(
      loginRelated.has(pageCheck.state) ? "BOSS_LOGIN_REQUIRED" : "BOSS_RECOMMEND_PAGE_NOT_READY",
      loginRelated.has(pageCheck.state)
        ? "Boss 页面未稳定停留在 recommend 页面，疑似未登录或登录态失效。"
        : "无法确认 Boss recommend 页面已就绪，请检查 Chrome 调试端口和页面状态。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          debug_port: preflight.debug_port,
          page_state: pageCheck.page_state
        }
      }
    );
  }

  const searchResult = await searchCli({
    workspaceRoot,
    searchParams: parsed.searchParams
  });
  if (!searchResult.ok) {
    return buildFailedResponse(
      searchResult.error?.code || "RECOMMEND_SEARCH_FAILED",
      searchResult.error?.message || "推荐页筛选执行失败。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          debug_port: preflight.debug_port,
          stdout: searchResult.stdout?.slice(-1000),
          stderr: searchResult.stderr?.slice(-1000),
          result: searchResult.structured || null
        }
      }
    );
  }

  const screenResult = await screenCli({
    workspaceRoot,
    screenParams: parsed.screenParams
  });
  if (!screenResult.ok) {
    const partialScreenResult = screenResult.summary || screenResult.structured?.result || null;
    return buildFailedResponse(
      screenResult.error?.code || "RECOMMEND_SCREEN_FAILED",
      screenResult.error?.message || "推荐页筛选执行失败。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        partial_result: partialScreenResult,
        diagnostics: {
          debug_port: preflight.debug_port,
          stdout: screenResult.stdout?.slice(-1000),
          stderr: screenResult.stderr?.slice(-1000),
          result: screenResult.structured || null
        }
      }
    );
  }

  const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  const searchSummary = searchResult.summary || {};
  const screenSummary = screenResult.summary || {};

  return {
    status: "COMPLETED",
    search_params: parsed.searchParams,
    screen_params: parsed.screenParams,
    result: {
      candidate_count: searchSummary.candidate_count ?? null,
      applied_filters: searchSummary.applied_filters || parsed.searchParams,
      processed_count: screenSummary.processed_count ?? 0,
      passed_count: screenSummary.passed_count ?? 0,
      skipped_count: screenSummary.skipped_count ?? 0,
      duration_sec: durationSec,
      output_csv: screenSummary.output_csv || null,
      completion_reason: screenSummary.completion_reason || "screen_completed",
      page_state: searchSummary.page_state || pageCheck.page_state,
      post_action: parsed.screenParams.post_action,
      max_greet_count: parsed.screenParams.max_greet_count,
      greet_count: screenSummary.greet_count ?? 0,
      greet_limit_fallback_count: screenSummary.greet_limit_fallback_count ?? 0
    },
    message: "Recommend 流水线已完成。post_action 在运行开始时已一次性确认；若选择打招呼并设置上限，超出上限后会自动改为收藏。"
  };
}
