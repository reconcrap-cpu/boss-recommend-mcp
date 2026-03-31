import { parseRecommendInstruction } from "./parser.js";
import {
  ensureBossRecommendPageReady,
  runPipelinePreflight,
  runRecommendSearchCli,
  runRecommendScreenCli
} from "./adapters.js";

function dedupe(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function failedCheckSet(checks = []) {
  const failed = checks
    .filter((item) => item && item.ok === false && typeof item.key === "string")
    .map((item) => item.key);
  return new Set(failed);
}

function collectNpmInstallDirs(checks = [], workspaceRoot) {
  const npmCheckKeys = new Set([
    "npm_dep_chrome_remote_interface_search",
    "npm_dep_chrome_remote_interface_screen",
    "npm_dep_ws"
  ]);
  const dirs = checks
    .filter((item) => item && item.ok === false && npmCheckKeys.has(item.key))
    .map((item) => item.install_cwd)
    .filter((value) => typeof value === "string" && value.trim());
  if (dirs.length > 0) return dedupe(dirs);
  return workspaceRoot ? [workspaceRoot] : [];
}

function buildNpmInstallCommands(checks = [], workspaceRoot) {
  const dirs = collectNpmInstallDirs(checks, workspaceRoot);
  const commands = [];
  for (const dir of dirs) {
    const escaped = String(dir).replace(/'/g, "''");
    commands.push(`Set-Location '${escaped}'`);
    commands.push("npm install");
  }
  return commands;
}

function formatCommandBlock(commands = []) {
  return commands.map((command) => `- ${command}`).join("\n");
}

function buildPreflightRecovery(checks = [], workspaceRoot) {
  const failed = failedCheckSet(checks);
  if (failed.size === 0) return null;

  const needNode = failed.has("node_cli");
  const needNpm = (
    failed.has("npm_dep_chrome_remote_interface_search")
    || failed.has("npm_dep_chrome_remote_interface_screen")
    || failed.has("npm_dep_ws")
  );
  const needPython = failed.has("python_cli");
  const needPillow = failed.has("python_pillow");

  const ordered_steps = [];
  if (needNode) {
    ordered_steps.push({
      id: "install_nodejs",
      title: "安装 Node.js >= 18",
      blocked_by: [],
      commands: [
        "winget install OpenJS.NodeJS.LTS",
        "node --version"
      ]
    });
  }
  if (needNpm) {
    ordered_steps.push({
      id: "install_npm_dependencies",
      title: "安装 npm 依赖（chrome-remote-interface / ws）",
      blocked_by: needNode ? ["install_nodejs"] : [],
      commands: buildNpmInstallCommands(checks, workspaceRoot)
    });
  }
  if (needPython) {
    ordered_steps.push({
      id: "install_python",
      title: "安装 Python（确保 python 命令可用）",
      blocked_by: [],
      commands: [
        "winget install Python.Python.3.12",
        "python --version"
      ]
    });
  }
  if (needPillow) {
    ordered_steps.push({
      id: "install_pillow",
      title: "安装 Pillow",
      blocked_by: needPython ? ["install_python"] : [],
      commands: [
        "python -m pip install --upgrade pip",
        "python -m pip install pillow"
      ]
    });
  }

  const promptLines = [
    "你是环境修复 agent。请先读取 diagnostics.checks，再严格按下面顺序执行，不要并行跳步：",
    "1) node_cli 失败 -> 先安装 Node.js，未成功前禁止执行 npm install。",
    "2) npm_dep_* 失败 -> 再安装 npm 依赖（chrome-remote-interface / ws）。",
    "3) python_cli 失败 -> 安装 Python 并确保 python 命令可用。",
    "4) python_pillow 失败 -> 最后安装 Pillow。",
    "每一步完成后都重新运行 doctor，直到所有检查通过后再重试流水线。"
  ];

  if (needNpm) {
    const npmCommands = buildNpmInstallCommands(checks, workspaceRoot);
    if (npmCommands.length > 0) {
      promptLines.push("建议执行的 npm 命令：");
      promptLines.push(formatCommandBlock(npmCommands));
    }
  }

  return {
    failed_check_keys: [...failed],
    ordered_steps,
    agent_prompt: promptLines.join("\n")
  };
}

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
    const recovery = buildPreflightRecovery(preflight.checks, workspaceRoot);
    return buildFailedResponse(
      "PIPELINE_PREFLIGHT_FAILED",
      "Recommend 流水线运行前检查失败，请先修复缺失的本地依赖或配置文件。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          checks: preflight.checks,
          debug_port: preflight.debug_port,
          recovery
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
