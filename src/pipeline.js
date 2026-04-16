import path from "node:path";
import { parseRecommendInstruction } from "./parser.js";
import {
  attemptPipelineAutoRepair,
  ensureBossRecommendPageReady,
  ensureFeaturedCalibrationReady,
  listRecommendJobs,
  readRecommendTabState,
  refreshBossRecommendList,
  reloadBossRecommendPage,
  runPipelinePreflight,
  runRecommendSearchCli,
  runRecommendScreenCli,
  switchRecommendTab
} from "./adapters.js";
import {
  buildTargetCountCompatibilityHints,
  cancelBossChatRun,
  getBossChatRun,
  normalizeTargetCountInput,
  pauseBossChatRun,
  resumeBossChatRun,
  startBossChatRun
} from "./boss-chat.js";

const FORCED_RECENT_NOT_VIEW_ON_SCREEN_RECOVERY = "近14天没有";
const MAX_SCREEN_AUTO_RECOVERY_ATTEMPTS = 5;
const MAX_SEARCH_NO_IFRAME_RETRY_ATTEMPTS = 1;
const SEARCH_NO_IFRAME_RETRY_DELAY_MS = 1200;
const MAX_SEARCH_FILTER_AUTO_RETRY_ATTEMPTS = 2;
const SEARCH_FILTER_AUTO_RETRY_DELAY_MS = 1200;
const BOSS_CHAT_FOLLOW_UP_POLL_MS = 1500;
const SEARCH_FILTER_RETRY_TOKENS = [
  "FILTER_CONFIRM_FAILED",
  "FILTER_DOM_CLASS_VERIFY_FAILED",
  "RECOMMEND_FILTER_PANEL_UNAVAILABLE",
  "RECOMMEND_FILTER_PANEL_NOT_READY",
  "FILTER_PANEL_NOT_FOUND",
  "FILTER_TRIGGER_NOT_FOUND",
  "FILTER_PANEL_OPEN_FAILED"
];
const PAGE_SCOPE_TO_TAB_STATUS = {
  recommend: "0",
  latest: "1",
  featured: "3"
};
const TAB_STATUS_TO_PAGE_SCOPE = {
  "0": "recommend",
  "1": "latest",
  "3": "featured"
};
const PAGE_SCOPE_LABELS = {
  recommend: "推荐",
  latest: "最新",
  featured: "精选"
};

function dedupe(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parsePositiveIntegerValue(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePipelineTargetCountValue(value) {
  return normalizeTargetCountInput(value).publicValue;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldAutoRetrySearchFilterFailure(errorCode, errorMessage) {
  const normalizedCode = normalizeText(errorCode).toUpperCase();
  const normalizedMessage = normalizeText(errorMessage).toUpperCase();
  const combined = `${normalizedCode} ${normalizedMessage}`.trim();
  if (!combined) return false;
  if (combined.includes("LOGIN_REQUIRED") || combined.includes("NO_RECOMMEND_IFRAME")) {
    return false;
  }
  if (SEARCH_FILTER_RETRY_TOKENS.some((token) => combined.includes(token))) {
    return true;
  }
  return /^(RECOMMEND_)?FILTER_/.test(normalizedCode);
}

function normalizePageScope(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (["recommend", "推荐", "推荐页", "推荐页面"].includes(normalized)) return "recommend";
  if (["latest", "最新", "最新页", "最新页面"].includes(normalized)) return "latest";
  if (["featured", "精选", "精选页", "精选页面", "精选牛人"].includes(normalized)) return "featured";
  return null;
}

function resolvePipelinePageScope(parsed, confirmation, overrides) {
  const parsedResolved = normalizePageScope(parsed?.page_scope);
  if (parsedResolved) return parsedResolved;
  const fromConfirmation = normalizePageScope(confirmation?.page_value);
  if (fromConfirmation) return fromConfirmation;
  return "recommend";
}

function pageScopeToTabStatus(scope) {
  return PAGE_SCOPE_TO_TAB_STATUS[scope] || "0";
}

function tabStatusToPageScope(status) {
  return TAB_STATUS_TO_PAGE_SCOPE[String(status || "")] || "recommend";
}

function normalizeJobTitle(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const byGap = text.split(/\s{2,}/).map((item) => item.trim()).filter(Boolean)[0] || text;
  const strippedRange = byGap
    .replace(/\s+\d+(?:\.\d+)?\s*(?:-|~|—|至)\s*\d+(?:\.\d+)?\s*(?:k|K|千|万|元\/天|元\/月|元\/年|K\/月|k\/月|万\/月|万\/年)?$/u, "")
    .trim();
  const strippedSingle = strippedRange
    .replace(/\s+\d+(?:\.\d+)?\s*(?:k|K|千|万|元\/天|元\/月|元\/年|K\/月|k\/月|万\/月|万\/年)$/u, "")
    .trim();
  return strippedSingle || byGap;
}

function normalizeJobOptions(jobOptions = []) {
  const normalized = [];
  const seen = new Set();
  for (const item of jobOptions) {
    if (!item || typeof item !== "object") continue;
    const value = normalizeText(item.value);
    const label = normalizeText(item.label);
    const title = normalizeJobTitle(item.title || label);
    const optionKey = value || title || label;
    if (!optionKey || seen.has(optionKey)) continue;
    seen.add(optionKey);
    normalized.push({
      value: value || null,
      title: title || label || null,
      label: label || title || null,
      current: item.current === true
    });
  }
  return normalized;
}

function resolveSelectedJob(jobOptions = [], requestedRaw) {
  const requested = normalizeText(requestedRaw);
  if (!requested) {
    return { job: null, ambiguous: false, candidates: [] };
  }
  const requestedTitle = normalizeJobTitle(requested).toLowerCase();
  const requestedLower = requested.toLowerCase();
  const byValue = jobOptions.find((item) => normalizeText(item.value || "").toLowerCase() === requestedLower);
  if (byValue) return { job: byValue, ambiguous: false, candidates: [] };
  const byTitle = jobOptions.find((item) => normalizeJobTitle(item.title || "").toLowerCase() === requestedTitle);
  if (byTitle) return { job: byTitle, ambiguous: false, candidates: [] };
  const byLabel = jobOptions.find((item) => normalizeText(item.label || "").toLowerCase() === requestedLower);
  if (byLabel) return { job: byLabel, ambiguous: false, candidates: [] };
  const partialMatches = jobOptions.filter((item) => {
    const title = normalizeJobTitle(item.title || "").toLowerCase();
    const label = normalizeText(item.label || "").toLowerCase();
    return (
      (title && (title.includes(requestedTitle) || requestedTitle.includes(title)))
      || (label && (label.includes(requestedLower) || requestedLower.includes(label)))
    );
  });
  if (partialMatches.length === 1) {
    return { job: partialMatches[0], ambiguous: false, candidates: [] };
  }
  if (partialMatches.length > 1) {
    return {
      job: null,
      ambiguous: true,
      candidates: partialMatches.map((item) => item.title || item.label || "").filter(Boolean)
    };
  }
  return { job: null, ambiguous: false, candidates: [] };
}

function buildJobPendingQuestion(jobOptions = [], selectedHint = null, reason = null) {
  const options = jobOptions.map((item) => ({
    label: item.title || item.label || item.value,
    value: item.value || item.title || item.label
  }));
  return {
    field: "job",
    question: reason
      || "已识别当前推荐页岗位列表，请确认本次要执行的岗位。确认后会先点击该岗位，再开始 search 和 screen。",
    value: normalizeText(selectedHint) || null,
    options
  };
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
    "npm_dep_ws",
    "npm_dep_sharp"
  ]);
  const dirs = checks
    .filter((item) => item && item.ok === false && npmCheckKeys.has(item.key))
    .map((item) => item.install_cwd)
    .filter((value) => typeof value === "string" && value.trim());
  if (dirs.length > 0) return dedupe(dirs);
  return workspaceRoot ? [workspaceRoot] : [];
}

function quoteForCommand(value) {
  return JSON.stringify(String(value));
}

function buildNpmInstallCommands(checks = [], workspaceRoot) {
  const dirs = collectNpmInstallDirs(checks, workspaceRoot);
  const commands = [];
  for (const dir of dirs) {
    commands.push(`npm install --prefix ${quoteForCommand(dir)}`);
  }
  return commands;
}

function getNodeInstallCommands() {
  if (process.platform === "win32") {
    return [
      "winget install OpenJS.NodeJS.LTS",
      "node --version"
    ];
  }
  if (process.platform === "darwin") {
    return [
      "brew install node",
      "node --version"
    ];
  }
  return [
    "使用系统包管理器安装 Node.js >= 18（例如 apt / yum / brew）",
    "node --version"
  ];
}

function formatCommandBlock(commands = []) {
  return commands.map((command) => `- ${command}`).join("\n");
}

function buildPreflightRecovery(checks = [], workspaceRoot) {
  const failed = failedCheckSet(checks);
  if (failed.size === 0) return null;

  const needScreenConfig = failed.has("screen_config");
  const needNode = failed.has("node_cli");
  const needNpm = (
    failed.has("npm_dep_chrome_remote_interface_search")
    || failed.has("npm_dep_chrome_remote_interface_screen")
    || failed.has("npm_dep_ws")
    || failed.has("npm_dep_sharp")
  );

  const ordered_steps = [];
  if (needScreenConfig) {
    const configCheck = checks.find((item) => item?.key === "screen_config");
    ordered_steps.push({
      id: "fill_screening_config",
      title: "填写 screening-config.json（baseUrl / apiKey / model）",
      blocked_by: [],
      commands: [
        `打开并填写：${configCheck?.path || "~/.boss-recommend-mcp/screening-config.json"}`,
        "确认 baseUrl、apiKey、model 都是可用值（不要保留模板占位符）。"
      ]
    });
  }
  if (needNode) {
    ordered_steps.push({
      id: "install_nodejs",
      title: "安装 Node.js >= 18",
      blocked_by: [],
      commands: getNodeInstallCommands()
    });
  }
  if (needNpm) {
    ordered_steps.push({
      id: "install_npm_dependencies",
      title: "安装 npm 依赖（chrome-remote-interface / ws / sharp）",
      blocked_by: needNode ? ["install_nodejs"] : [],
      commands: buildNpmInstallCommands(checks, workspaceRoot)
    });
  }

  const promptLines = [
    "你是环境修复 agent。请先读取 diagnostics.checks，再严格按下面顺序执行，不要并行跳步：",
    "1) node_cli 失败 -> 先安装 Node.js，未成功前禁止执行 npm install。",
    "2) npm_dep_* 失败 -> 再安装 npm 依赖（chrome-remote-interface / ws / sharp）。",
    "每一步完成后都重新运行 doctor，直到所有检查通过后再重试流水线。"
  ];
  if (needScreenConfig) {
    promptLines.splice(
      1,
      0,
      "0) 若 screen_config 失败：先让用户提供并填写 baseUrl、apiKey、model（不得使用模板占位符）。"
    );
  }

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
  if (parsedResult.needs_page_confirmation) confirmations.push("page_scope");
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
    selected_page: parsedResult.proposed_page_scope || parsedResult.page_scope || "recommend",
    search_params: parsedResult.searchParams,
    screen_params: parsedResult.screenParams,
    follow_up: parsedResult.follow_up || null,
    pending_questions: parsedResult.pending_questions,
    review: parsedResult.review,
    error: {
      code: "MISSING_REQUIRED_FIELDS",
      message: buildNeedInputMessage(parsedResult.missing_fields),
      retryable: true
    }
  };
}

function buildNeedConfirmationResponse(parsedResult) {
  return {
    status: "NEED_CONFIRMATION",
    required_confirmations: buildRequiredConfirmations(parsedResult),
    selected_page: parsedResult.proposed_page_scope || parsedResult.page_scope || "recommend",
    search_params: parsedResult.searchParams,
    screen_params: {
      ...parsedResult.screenParams,
      target_count: parsedResult.proposed_target_count ?? parsedResult.screenParams.target_count,
      post_action: parsedResult.proposed_post_action || parsedResult.screenParams.post_action,
      max_greet_count: parsedResult.proposed_max_greet_count || parsedResult.screenParams.max_greet_count
    },
    follow_up: parsedResult.follow_up || null,
    pending_questions: parsedResult.pending_questions,
    review: parsedResult.review
  };
}

function normalizeFollowUpChatInput(followUp = null, defaults = null) {
  const raw = followUp?.chat;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      requested: false,
      missing_fields: [],
      pending_questions: [],
      summary: null,
      input: null
    };
  }

  const defaultCriteria = normalizeText(defaults?.criteria || "");
  const defaultStartFromRaw = normalizeText(defaults?.start_from || "").toLowerCase();
  const defaultStartFrom = defaultStartFromRaw === "all" ? "all" : "unread";
  const defaultTargetCount = normalizePipelineTargetCountValue(defaults?.target_count);

  const explicitCriteria = normalizeText(raw.criteria);
  const explicitStartFromRaw = normalizeText(raw.start_from).toLowerCase();
  const explicitStartFrom = explicitStartFromRaw === "all" ? "all" : explicitStartFromRaw === "unread" ? "unread" : "";
  const explicitTarget = normalizeTargetCountInput(raw.target_count);
  const explicitTargetCount = explicitTarget.publicValue;

  const hasExplicitCriteria = Boolean(explicitCriteria);
  const hasExplicitStartFrom = Boolean(explicitStartFrom);
  const hasExplicitTargetCount = explicitTarget.provided;

  const criteria = explicitCriteria || defaultCriteria;
  const startFrom = explicitStartFrom || defaultStartFrom;
  const targetCount = explicitTargetCount || defaultTargetCount;

  const profile = normalizeText(raw.profile) || "default";
  const summary = {
    profile,
    criteria: criteria || null,
    start_from: startFrom || null,
    target_count: targetCount,
    dry_run: raw.dry_run === true,
    no_state: raw.no_state === true,
    safe_pacing: typeof raw.safe_pacing === "boolean" ? raw.safe_pacing : null,
    batch_rest_enabled: typeof raw.batch_rest_enabled === "boolean" ? raw.batch_rest_enabled : null
  };

  const missing_fields = [];
  const pending_questions = [];

  if (!hasExplicitCriteria) {
    missing_fields.push("follow_up.chat.criteria");
    pending_questions.push({
      field: "follow_up.chat.criteria",
      question: "请填写 boss-chat follow-up 的筛选 criteria（自然语言，必填）。",
      value: criteria || null
    });
  }
  if (!hasExplicitStartFrom) {
    missing_fields.push("follow_up.chat.start_from");
    pending_questions.push({
      field: "follow_up.chat.start_from",
      question: "请确认 boss-chat follow-up 从未读还是全部聊天列表开始。",
      value: summary.start_from,
      options: [
        { label: "未读", value: "unread" },
        { label: "全部", value: "all" }
      ]
    });
  }
  if (!hasExplicitTargetCount) {
    const targetCountHints = buildTargetCountCompatibilityHints({
      argumentName: "follow_up.chat.target_count",
      recommendedArgumentPatch: {
        follow_up: {
          chat: {
            target_count: "all"
          }
        }
      }
    });
    missing_fields.push("follow_up.chat.target_count");
    pending_questions.push({
      ...targetCountHints,
      field: "follow_up.chat.target_count",
      question: "请填写 boss-chat follow-up 本次处理人数上限。若扫到底，请在 follow_up.chat.target_count 里字面填写 \"all\"。",
      value: summary.target_count,
      ...(explicitTarget.rawValue !== undefined ? { received_target_count: explicitTarget.rawValue } : {}),
      ...(explicitTarget.parseError ? { target_count_parse_error: explicitTarget.parseError } : {})
    });
  }

  return {
    requested: true,
    missing_fields,
    pending_questions,
    summary,
    input: {
      profile,
      criteria: criteria || null,
      start_from: startFrom || null,
      target_count: targetCount,
      dry_run: raw.dry_run === true,
      no_state: raw.no_state === true,
      safe_pacing: typeof raw.safe_pacing === "boolean" ? raw.safe_pacing : undefined,
      batch_rest_enabled: typeof raw.batch_rest_enabled === "boolean" ? raw.batch_rest_enabled : undefined
    }
  };
}

function mergeParsedFollowUp(parsedResult, followUpChat) {
  if (!followUpChat?.requested) {
    return {
      ...parsedResult,
      follow_up: null,
      follow_up_chat: followUpChat || null
    };
  }
  const pending_questions = [
    ...(Array.isArray(parsedResult?.pending_questions) ? parsedResult.pending_questions : []),
    ...followUpChat.pending_questions
  ];
  return {
    ...parsedResult,
    missing_fields: dedupe([
      ...(Array.isArray(parsedResult?.missing_fields) ? parsedResult.missing_fields : []),
      ...followUpChat.missing_fields
    ]),
    pending_questions,
    review: {
      ...(parsedResult?.review || {}),
      follow_up: {
        chat: followUpChat.summary
      }
    },
    follow_up: {
      chat: followUpChat.summary
    },
    follow_up_chat: followUpChat
  };
}

function buildResolvedFollowUpChatInput(followUpChat, { selectedJob, debugPort }) {
  return {
    profile: followUpChat?.input?.profile || "default",
    job: selectedJob?.title || selectedJob?.label || selectedJob?.value || null,
    start_from: followUpChat?.input?.start_from || null,
    criteria: followUpChat?.input?.criteria || null,
    target_count: followUpChat?.input?.target_count || null,
    port: Number.isFinite(debugPort) ? debugPort : null,
    dry_run: followUpChat?.input?.dry_run === true,
    no_state: followUpChat?.input?.no_state === true,
    safe_pacing: followUpChat?.input?.safe_pacing,
    batch_rest_enabled: followUpChat?.input?.batch_rest_enabled
  };
}

function buildBossChatFollowUpStatus({ payload, runId, fallbackInput = null, startMessage = null }) {
  const run = payload?.run || null;
  const progress = run?.progress && typeof run.progress === "object" ? run.progress : {};
  return {
    enabled: true,
    run_id: normalizeText(payload?.run_id || run?.runId || runId) || null,
    state: normalizeText(run?.state || payload?.state || payload?.status).toLowerCase() || null,
    profile: normalizeText(fallbackInput?.profile) || "default",
    job: normalizeText(fallbackInput?.job) || null,
    start_from: normalizeText(fallbackInput?.start_from) || null,
    criteria: normalizeText(fallbackInput?.criteria) || null,
    target_count: normalizePipelineTargetCountValue(fallbackInput?.target_count),
    port: parsePositiveIntegerValue(fallbackInput?.port),
    progress: {
      inspected: Number.isInteger(progress.inspected) ? progress.inspected : 0,
      passed: Number.isInteger(progress.passed) ? progress.passed : 0,
      requested: Number.isInteger(progress.requested) ? progress.requested : 0,
      skipped: Number.isInteger(progress.skipped) ? progress.skipped : 0,
      errors: Number.isInteger(progress.errors) ? progress.errors : 0
    },
    last_message: normalizeText(run?.lastMessage || payload?.message || startMessage) || null,
    error: run?.error || payload?.error || null,
    result: run?.result || null
  };
}

function buildNeedInputMessage(missingFields = []) {
  if (!Array.isArray(missingFields) || missingFields.length === 0) {
    return "缺少必要字段，请先补充后再继续。";
  }
  if (missingFields.length === 1 && missingFields[0] === "criteria") {
    return "缺少必要的筛选 criteria，请先补充或通过 overrides.criteria 明确传入。";
  }
  return `缺少必要字段：${missingFields.join(", ")}。请先补充后再继续。`;
}

function buildFinalReviewQuestion({ searchParams, screenParams, selectedJob, selectedPage, followUpChat }) {
  return {
    field: "final_review",
    question: followUpChat
      ? "开始执行前，请最后确认全部参数（岗位/页面/筛选条件/筛选 criteria/目标通过人数/post_action/max_greet_count/boss-chat follow-up）无误。"
      : "开始执行搜索和筛选前，请最后确认全部参数（岗位/页面/筛选条件/筛选 criteria/目标通过人数/post_action/max_greet_count）无误。",
    value: {
      job: selectedJob?.title || selectedJob?.label || selectedJob?.value || null,
      page_scope: selectedPage || "recommend",
      search_params: searchParams,
      screen_params: screenParams,
      follow_up: followUpChat
        ? {
            chat: followUpChat
          }
        : null
    },
    options: [
      { label: "参数无误，开始执行", value: "confirm" },
      { label: "参数需要调整", value: "revise" }
    ]
  };
}

function cloneJsonSafe(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function buildScreenInputSummary({
  instruction,
  selectedPage,
  selectedJob,
  userSearchParams,
  effectiveSearchParams,
  screenParams,
  followUp
}) {
  return {
    instruction: normalizeText(instruction || "") || null,
    selected_page: selectedPage || "recommend",
    selected_job: selectedJob
      ? {
          value: normalizeText(selectedJob.value || "") || null,
          title: normalizeText(selectedJob.title || "") || null,
          label: normalizeText(selectedJob.label || "") || null
        }
      : null,
    user_search_params: cloneJsonSafe(userSearchParams),
    effective_search_params: cloneJsonSafe(effectiveSearchParams),
    screen_params: cloneJsonSafe(screenParams),
    follow_up: cloneJsonSafe(followUp)
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

function buildPausedResponse(message, extra = {}) {
  return {
    status: "PAUSED",
    message: normalizeText(message || "") || "Recommend 流水线已暂停。",
    ...extra
  };
}

function buildRecommendFollowUpEnvelope(recommendResult, chatPayload = null) {
  return {
    search_params: recommendResult?.search_params || null,
    screen_params: recommendResult?.screen_params || null,
    result: recommendResult?.result || null,
    partial_result: recommendResult?.result || null,
    follow_up: chatPayload
      ? {
          chat: chatPayload
        }
      : null
  };
}

function buildFollowUpFailedResponse(code, message, recommendResult, chatPayload) {
  return {
    status: "FAILED",
    error: {
      code,
      message,
      retryable: true
    },
    ...buildRecommendFollowUpEnvelope(recommendResult, chatPayload)
  };
}

function buildFollowUpPausedResponse(message, recommendResult, chatPayload) {
  return {
    status: "PAUSED",
    message: normalizeText(message || "") || "Recommend 流水线已暂停。",
    ...buildRecommendFollowUpEnvelope(recommendResult, chatPayload)
  };
}

class PipelineAbortError extends Error {
  constructor(message = "Pipeline execution aborted") {
    super(message);
    this.name = "PipelineAbortError";
    this.code = "PIPELINE_ABORTED";
  }
}

function isAbortSignalTriggered(signal) {
  return Boolean(signal && signal.aborted);
}

function ensurePipelineNotAborted(signal) {
  if (isAbortSignalTriggered(signal)) {
    throw new PipelineAbortError("Pipeline execution aborted by caller.");
  }
}

function safeInvokeRuntimeCallback(callback, payload) {
  if (typeof callback !== "function") return;
  try {
    callback(payload);
  } catch {
    // Keep pipeline stable even if runtime callback fails.
  }
}

function createPipelineRuntime(runtime = null) {
  const signal = runtime?.signal;
  const heartbeatIntervalMs = Number.isFinite(runtime?.heartbeatIntervalMs) && runtime.heartbeatIntervalMs > 0
    ? runtime.heartbeatIntervalMs
    : 10_000;
  const isPauseRequested = typeof runtime?.isPauseRequested === "function"
    ? runtime.isPauseRequested
    : () => false;
  const isCancelRequested = typeof runtime?.isCancelRequested === "function"
    ? runtime.isCancelRequested
    : () => false;

  function setStage(stage, message = null) {
    safeInvokeRuntimeCallback(runtime?.onStage, {
      stage,
      message: normalizeText(message || "") || null,
      at: new Date().toISOString()
    });
  }

  function heartbeat(stage, details = null) {
    safeInvokeRuntimeCallback(runtime?.onHeartbeat, {
      stage,
      details: details || null,
      at: new Date().toISOString()
    });
  }

  function output(stage, event) {
    safeInvokeRuntimeCallback(runtime?.onOutput, {
      stage,
      ...(event || {}),
      at: new Date().toISOString()
    });
  }

  function progress(stage, payload) {
    safeInvokeRuntimeCallback(runtime?.onProgress, {
      stage,
      ...(payload || {}),
      at: new Date().toISOString()
    });
  }

  function followUp(payload) {
    safeInvokeRuntimeCallback(runtime?.onFollowUp, {
      ...(payload || {}),
      at: new Date().toISOString()
    });
  }

  function adapterRuntime(stage) {
    return {
      signal,
      heartbeatIntervalMs,
      onOutput: (event) => output(stage, event),
      onHeartbeat: (event) => heartbeat(stage, event),
      onProgress: (payload) => progress(stage, payload)
    };
  }

  return {
    signal,
    heartbeatIntervalMs,
    isPauseRequested,
    isCancelRequested,
    setStage,
    heartbeat,
    output,
    progress,
    followUp,
    adapterRuntime
  };
}

function isProcessAbortError(errorLike) {
  const code = normalizeText(errorLike?.code || "").toUpperCase();
  return code === "PROCESS_ABORTED" || code === "ABORTED";
}

function isPauseRequested(runtimeHooks) {
  try {
    return runtimeHooks?.isPauseRequested?.() === true;
  } catch {
    return false;
  }
}

function isCancelRequested(runtimeHooks) {
  try {
    return runtimeHooks?.isCancelRequested?.() === true;
  } catch {
    return false;
  }
}

function buildChromeSetupGuidance({ debugPort, pageState }) {
  const expectedUrl = pageState?.expected_url || "https://www.zhipin.com/web/chat/recommend";
  const loginUrl = pageState?.login_url || "https://www.zhipin.com/web/user/?ka=bticket";
  const currentUrl = pageState?.current_url || null;
  const state = pageState?.state || "UNKNOWN";
  const isPortIssue = state === "DEBUG_PORT_UNREACHABLE";
  const needsLogin = state === "LOGIN_REQUIRED" || state === "LOGIN_REQUIRED_AFTER_REDIRECT";
  const launchAttempt = pageState?.launch_attempt || null;
  const launchLine = launchAttempt?.ok
    ? `已自动启动 Chrome（--remote-debugging-port=${debugPort}，--user-data-dir=${launchAttempt.user_data_dir || "auto"}）。`
    : null;
  const launchExample = process.platform === "win32"
    ? `chrome.exe --remote-debugging-port=${debugPort} --user-data-dir=<profile-dir>`
    : process.platform === "darwin"
      ? `'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --remote-debugging-port=${debugPort} --user-data-dir=<profile-dir>`
      : `google-chrome --remote-debugging-port=${debugPort} --user-data-dir=<profile-dir>`;
  const steps = [
    `请先在可连接到 DevTools 端口 ${debugPort} 的 Chrome 实例中完成以下操作：`,
    ...(launchLine ? [launchLine] : []),
    "1) 确认当前 Chrome 与本次运行使用同一个远程调试端口。",
    isPortIssue
      ? `2) 若端口不可连接，请用远程调试方式启动 Chrome（示例：${launchExample}）。`
      : "2) 确认端口可连接且浏览器窗口保持打开。",
    needsLogin
      ? `3) 当前检测到 Boss 未登录，请先打开并完成登录：${loginUrl}`
      : "3) 如 Boss 登录态失效，请先重新登录。",
    `4) 登录完成后先导航并停留在推荐页：${expectedUrl}`,
    "5) 完成后回复“已就绪”，我会继续执行并优先自动导航到推荐页。"
  ];
  return {
    debug_port: debugPort,
    expected_url: expectedUrl,
    current_url: currentUrl,
    page_state: state,
    agent_prompt: steps.join("\n")
  };
}

async function runBossChatFollowUpPhase({
  workspaceRoot,
  followUpChat,
  selectedJob,
  debugPort,
  recommendResult,
  resume,
  runtimeHooks,
  startChatRun,
  getChatRun,
  pauseChatRun,
  resumeChatRun,
  cancelChatRun
}) {
  const recommendSummary = recommendResult?.result || null;
  const resolvedChatInput = buildResolvedFollowUpChatInput(followUpChat, {
    selectedJob,
    debugPort
  });
  let chatRunId = normalizeText(resume?.chat_run_id || "");
  const resumeFromChatPhase = resume?.resume === true && normalizeText(resume?.follow_up_phase) === "chat_followup";
  let pauseRequested = false;
  let cancelRequested = false;
  let resumeIssued = false;

  runtimeHooks.setStage(
    "chat_followup",
    chatRunId
      ? "Recommend 流水线已完成，准备恢复 boss-chat follow-up。"
      : "Recommend 流水线已完成，开始执行 boss-chat follow-up。"
  );
  runtimeHooks.heartbeat("chat_followup", {
    profile: resolvedChatInput.profile,
    job: resolvedChatInput.job,
    start_from: resolvedChatInput.start_from,
    target_count: resolvedChatInput.target_count
  });

  if (!chatRunId) {
    const startResult = await startChatRun({
      workspaceRoot,
      input: {
        profile: resolvedChatInput.profile,
        job: resolvedChatInput.job,
        start_from: resolvedChatInput.start_from,
        criteria: resolvedChatInput.criteria,
        target_count: resolvedChatInput.target_count,
        port: resolvedChatInput.port,
        dry_run: resolvedChatInput.dry_run,
        no_state: resolvedChatInput.no_state,
        safe_pacing: resolvedChatInput.safe_pacing,
        batch_rest_enabled: resolvedChatInput.batch_rest_enabled
      }
    });
    if (startResult?.status !== "ACCEPTED" || !normalizeText(startResult?.run_id)) {
      return buildFollowUpFailedResponse(
        startResult?.error?.code || "BOSS_CHAT_FOLLOW_UP_LAUNCH_FAILED",
        startResult?.error?.message || "boss-chat follow-up 启动失败。",
        recommendResult,
        {
          enabled: true,
          input: resolvedChatInput,
          launch_result: startResult || null
        }
      );
    }
    chatRunId = normalizeText(startResult.run_id);
    runtimeHooks.followUp({
      stage: "chat_followup",
      last_message: startResult.message || "boss-chat follow-up 已启动。",
      recommend_payload: recommendResult,
      recommend_result: recommendSummary,
      follow_up: {
        chat: {
          ...buildBossChatFollowUpStatus({
            payload: startResult,
            runId: chatRunId,
            fallbackInput: resolvedChatInput,
            startMessage: startResult.message || "boss-chat follow-up 已启动。"
          }),
          input: resolvedChatInput
        }
      }
    });
  }

  while (true) {
    ensurePipelineNotAborted(runtimeHooks.signal);

    const chatStatusPayload = await getChatRun({
      workspaceRoot,
      input: {
        profile: resolvedChatInput.profile,
        runId: chatRunId
      }
    });
    const chatStatus = buildBossChatFollowUpStatus({
      payload: chatStatusPayload,
      runId: chatRunId,
      fallbackInput: resolvedChatInput
    });
    const chatState = normalizeText(chatStatus.state).toLowerCase();

    runtimeHooks.followUp({
      stage: "chat_followup",
      last_message: chatStatus.last_message || "boss-chat follow-up 进行中。",
      recommend_payload: recommendResult,
      recommend_result: recommendSummary,
      follow_up: {
        chat: {
          ...chatStatus,
          input: resolvedChatInput
        }
      }
    });

    if (isCancelRequested(runtimeHooks) && !cancelRequested && !["completed", "failed", "canceled"].includes(chatState)) {
      cancelRequested = true;
      await cancelChatRun({
        workspaceRoot,
        input: {
          profile: resolvedChatInput.profile,
          runId: chatRunId
        }
      });
      await sleep(500);
      continue;
    }

    if (
      isPauseRequested(runtimeHooks)
      && !pauseRequested
      && !cancelRequested
      && !["paused", "completed", "failed", "canceled"].includes(chatState)
    ) {
      pauseRequested = true;
      await pauseChatRun({
        workspaceRoot,
        input: {
          profile: resolvedChatInput.profile,
          runId: chatRunId
        }
      });
      await sleep(500);
      continue;
    }

    if (resumeFromChatPhase && !isPauseRequested(runtimeHooks) && !isCancelRequested(runtimeHooks) && !resumeIssued) {
      if (chatState === "paused") {
        resumeIssued = true;
        await resumeChatRun({
          workspaceRoot,
          input: {
            profile: resolvedChatInput.profile,
            runId: chatRunId
          }
        });
        await sleep(500);
        continue;
      }
      if (chatState === "running" || chatState === "queued") {
        resumeIssued = true;
      }
    }

    if (chatState === "completed") {
      return {
        ...recommendResult,
        follow_up: {
          chat: {
            ...chatStatus,
            input: resolvedChatInput
          }
        },
        message: "Recommend 流水线已完成，boss-chat follow-up 也已执行完成。"
      };
    }

    if (chatState === "failed") {
      return buildFollowUpFailedResponse(
        chatStatus.error?.code || "BOSS_CHAT_FOLLOW_UP_FAILED",
        chatStatus.error?.message || "boss-chat follow-up 执行失败。",
        recommendResult,
        {
          ...chatStatus,
          input: resolvedChatInput
        }
      );
    }

    if (chatState === "canceled") {
      if (isCancelRequested(runtimeHooks)) {
        return buildFollowUpPausedResponse(
          "Recommend 流水线已取消，boss-chat follow-up 已停止。",
          recommendResult,
          {
            ...chatStatus,
            input: resolvedChatInput
          }
        );
      }
      return buildFollowUpFailedResponse(
        "BOSS_CHAT_FOLLOW_UP_CANCELED",
        "boss-chat follow-up 已取消。",
        recommendResult,
        {
          ...chatStatus,
          input: resolvedChatInput
        }
      );
    }

    if (chatState === "paused" && isPauseRequested(runtimeHooks)) {
      return buildFollowUpPausedResponse(
        "Recommend 流水线已暂停，可使用 resume 继续 boss-chat follow-up。",
        recommendResult,
        {
          ...chatStatus,
          input: resolvedChatInput
        }
      );
    }

    await sleep(BOSS_CHAT_FOLLOW_UP_POLL_MS);
  }
}

const defaultDependencies = {
  attemptPipelineAutoRepair,
  parseRecommendInstruction,
  ensureBossRecommendPageReady,
  ensureFeaturedCalibrationReady,
  listRecommendJobs,
  readRecommendTabState,
  refreshBossRecommendList,
  reloadBossRecommendPage,
  runPipelinePreflight,
  runRecommendSearchCli,
  runRecommendScreenCli,
  startBossChatRun,
  getBossChatRun,
  pauseBossChatRun,
  resumeBossChatRun,
  cancelBossChatRun,
  switchRecommendTab
};

export async function runRecommendPipeline(
  { workspaceRoot, instruction, confirmation, overrides, followUp = null, resume = null },
  dependencies = defaultDependencies,
  runtime = null
) {
  const injectedDependencies = dependencies || {};
  const resolvedDependencies = { ...defaultDependencies, ...(dependencies || {}) };
  const {
    attemptPipelineAutoRepair: attemptAutoRepair,
    parseRecommendInstruction: parseInstruction,
    ensureBossRecommendPageReady: ensureRecommendPageReady,
    ensureFeaturedCalibrationReady: ensureCalibrationReady,
    listRecommendJobs: listJobs,
    readRecommendTabState: readTabState,
    refreshBossRecommendList: refreshRecommendList,
    reloadBossRecommendPage: reloadRecommendPage,
    runPipelinePreflight: runPreflight,
    runRecommendSearchCli: searchCli,
    runRecommendScreenCli: screenCli,
    startBossChatRun: startChatRun,
    getBossChatRun: getChatRun,
    pauseBossChatRun: pauseChatRun,
    resumeBossChatRun: resumeChatRun,
    cancelBossChatRun: cancelChatRun,
    switchRecommendTab: switchTab
  } = resolvedDependencies;
  const runtimeHooks = createPipelineRuntime(runtime);
  ensurePipelineNotAborted(runtimeHooks.signal);

  const startedAt = Date.now();
  const instructionParsed = parseInstruction({ instruction, confirmation, overrides });
  const parsed = mergeParsedFollowUp(
    instructionParsed,
    normalizeFollowUpChatInput(followUp, {
      criteria: instructionParsed?.screenParams?.criteria || null,
      target_count: instructionParsed?.screenParams?.target_count || null,
      start_from: "unread"
    })
  );
  const selectedPage = resolvePipelinePageScope(parsed, confirmation, overrides);

  if (parsed.missing_fields.length > 0) {
    return buildNeedInputResponse(parsed);
  }

  if (
    parsed.needs_page_confirmation
    || parsed.needs_filters_confirmation
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

  const resumeFromChatPhase = (
    resume?.resume === true
    && normalizeText(resume?.follow_up_phase) === "chat_followup"
    && normalizeText(resume?.chat_run_id)
  );
  if (resumeFromChatPhase) {
    if (!parsed.follow_up_chat?.requested || !resume?.recommend_result) {
      return buildFailedResponse(
        "BOSS_CHAT_FOLLOW_UP_RESUME_CONTEXT_MISSING",
        "缺少 boss-chat follow-up 恢复上下文，无法继续。"
      );
    }
    const preflight = runPreflight(workspaceRoot, { pageScope: selectedPage });
    return runBossChatFollowUpPhase({
      workspaceRoot,
      followUpChat: parsed.follow_up_chat,
      selectedJob: resume.recommend_result?.selected_job || null,
      debugPort: preflight.debug_port,
      recommendResult: {
        status: "COMPLETED",
        search_params: resume.recommend_search_params || parsed.searchParams,
        screen_params: resume.recommend_screen_params || parsed.screenParams,
        result: resume.recommend_result,
        message: "Recommend 流水线已完成，正在恢复 boss-chat follow-up。"
      },
      resume,
      runtimeHooks,
      startChatRun,
      getChatRun,
      pauseChatRun,
      resumeChatRun,
      cancelChatRun
    });
  }

  ensurePipelineNotAborted(runtimeHooks.signal);
  runtimeHooks.setStage("preflight", "开始执行 preflight 检查。");
  runtimeHooks.heartbeat("preflight");

  let preflight = runPreflight(workspaceRoot, { pageScope: selectedPage });
  let autoRepair = null;
  const shouldAttemptAutoRepair = (
    dependencies === defaultDependencies
    || Object.prototype.hasOwnProperty.call(injectedDependencies, "attemptPipelineAutoRepair")
  );
  if (!preflight.ok) {
    if (shouldAttemptAutoRepair && typeof attemptAutoRepair === "function") {
      autoRepair = attemptAutoRepair(workspaceRoot, preflight);
      if (autoRepair?.preflight) {
        preflight = autoRepair.preflight;
      }
    }
  }

  const shouldCheckFeaturedCalibration = (
    dependencies === defaultDependencies
    || Object.prototype.hasOwnProperty.call(injectedDependencies, "ensureFeaturedCalibrationReady")
  );
  const featuredCalibrationCheck = preflight.checks?.find((item) => item?.key === "favorite_calibration");
  if (
    selectedPage === "featured"
    && shouldCheckFeaturedCalibration
    && featuredCalibrationCheck
    && featuredCalibrationCheck.ok === false
  ) {
    runtimeHooks.setStage("calibration", "检测到精选页缺少可用收藏校准文件，开始自动执行校准。");
    runtimeHooks.heartbeat("calibration");
    const calibrationResult = await ensureCalibrationReady(workspaceRoot, {
      port: preflight.debug_port,
      timeoutMs: 60000,
      autoCalibrate: true,
      runtime: runtimeHooks.adapterRuntime("calibration")
    });
    ensurePipelineNotAborted(runtimeHooks.signal);
    if (!calibrationResult?.ok) {
      return buildFailedResponse(
        "CALIBRATION_REQUIRED",
        calibrationResult?.error?.message || "精选页收藏校准失败，请先完成校准后重试。",
        {
          selected_page: selectedPage,
          search_params: parsed.searchParams,
          screen_params: parsed.screenParams,
          required_user_action: "run_featured_calibration",
          guidance: {
            calibration_path: calibrationResult?.calibration_path || featuredCalibrationCheck.path || null,
            debug_port: calibrationResult?.debug_port || preflight.debug_port,
            calibration_script_path: calibrationResult?.calibration_script_path || null,
            tip: "请在 Boss 推荐页切换到精选 tab 后打开候选人详情，按提示先收藏再取消收藏完成校准后重试。"
          },
          diagnostics: {
            checks: preflight.checks,
            calibration: calibrationResult || null
          }
        }
      );
    }
    preflight = runPreflight(workspaceRoot, { pageScope: selectedPage });
  }

  if (!preflight.ok) {
    runtimeHooks.heartbeat("preflight", {
      status: "failed"
    });
    const screenConfigCheck = preflight.checks?.find((item) => item?.key === "screen_config" && item?.ok === false);
    const screenConfigPath = String(screenConfigCheck?.path || "");
    const screenConfigDir = screenConfigPath ? path.dirname(screenConfigPath) : null;
    const screenConfigReason = String(screenConfigCheck?.reason || "").trim().toUpperCase();
    const screenConfigMessage = String(screenConfigCheck?.message || "");
    const screenConfigHasPlaceholder = (
      screenConfigReason.includes("PLACEHOLDER")
      || /占位符|默认模板值|replace-with-openai-api-key/i.test(screenConfigMessage)
    );
    const recovery = buildPreflightRecovery(preflight.checks, workspaceRoot);
    return buildFailedResponse(
      "PIPELINE_PREFLIGHT_FAILED",
      "Recommend 流水线运行前检查失败，请先修复缺失的本地依赖或配置文件。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        required_user_action: screenConfigCheck
          ? (screenConfigHasPlaceholder ? "confirm_screening_config_updated" : "provide_screening_config")
          : undefined,
        guidance: screenConfigCheck
          ? {
              config_path: screenConfigCheck.path,
              config_dir: screenConfigDir,
              agent_prompt: [
                ...(screenConfigHasPlaceholder
                  ? [
                      "检测到 screening-config.json 仍包含默认占位词，当前禁止继续执行。",
                      `请引导用户在以下目录修改配置文件：${screenConfigDir || "(unknown)"}`,
                      `配置文件路径：${screenConfigCheck.path}`,
                      "必须替换为真实可用值：baseUrl、apiKey、model（不要保留任何模板占位符）。",
                      "修改完成后，必须先让用户明确回复“已修改完成”，再继续下一步。"
                    ]
                  : [
                      "请先让用户填写 screening-config.json 的以下字段：",
                      "1) baseUrl",
                      "2) apiKey",
                      "3) model",
                      `配置文件路径：${screenConfigCheck.path}`,
                      "注意：不要使用模板占位符（例如 replace-with-openai-api-key），也不要由 agent 自行猜测或代填示例值。必须向用户逐项确认真实可用值后再重试。"
                    ])
              ].join("\n")
            }
          : undefined,
        diagnostics: {
          checks: preflight.checks,
          debug_port: preflight.debug_port,
          config_resolution: preflight.config_resolution,
          auto_repair: autoRepair,
          recovery
        }
      }
    );
  }

  ensurePipelineNotAborted(runtimeHooks.signal);
  runtimeHooks.setStage("page_ready", "preflight 完成，开始检查 recommend 页面就绪状态。");
  runtimeHooks.heartbeat("page_ready");

  const pageCheck = await ensureRecommendPageReady(workspaceRoot, {
    port: preflight.debug_port
  });
  ensurePipelineNotAborted(runtimeHooks.signal);
  if (!pageCheck.ok) {
    const loginRelated = new Set(["LOGIN_REQUIRED", "LOGIN_REQUIRED_AFTER_REDIRECT"]);
    const connectivityRelated = new Set(["DEBUG_PORT_UNREACHABLE"]);
    const guidance = buildChromeSetupGuidance({
      debugPort: preflight.debug_port,
      pageState: pageCheck.page_state
    });
    return buildFailedResponse(
      connectivityRelated.has(pageCheck.state)
        ? "BOSS_CHROME_NOT_CONNECTED"
        : loginRelated.has(pageCheck.state)
          ? "BOSS_LOGIN_REQUIRED"
          : "BOSS_RECOMMEND_PAGE_NOT_READY",
      loginRelated.has(pageCheck.state)
        ? `开始执行搜索和筛选前，请先在端口 ${preflight.debug_port} 的 Chrome 完成 Boss 登录并停留在 recommend 页面。`
        : connectivityRelated.has(pageCheck.state)
          ? `开始执行搜索和筛选前，需要先连接到端口 ${preflight.debug_port} 的 Chrome 远程调试实例。`
          : `开始执行搜索和筛选前，请先在端口 ${preflight.debug_port} 的 Chrome 停留在 Boss recommend 页面。`,
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        required_user_action: "prepare_boss_recommend_page",
        guidance,
        diagnostics: {
          debug_port: preflight.debug_port,
          page_state: pageCheck.page_state
        }
      }
    );
  }

  runtimeHooks.setStage("job_list", "页面就绪，开始读取岗位列表。");
  runtimeHooks.heartbeat("job_list");
  const jobListResult = await listJobs({
    workspaceRoot,
    port: preflight.debug_port,
    runtime: runtimeHooks.adapterRuntime("job_list")
  });
  ensurePipelineNotAborted(runtimeHooks.signal);
  if (isProcessAbortError(jobListResult.error)) {
    throw new PipelineAbortError(jobListResult.error?.message || "岗位列表读取已取消。");
  }
  if (!jobListResult.ok) {
    const jobListErrorCode = String(jobListResult.error?.code || "");
    const jobListErrorMessage = String(jobListResult.error?.message || "");
    const pageReadinessFailure = (
      jobListErrorCode === "JOB_TRIGGER_NOT_FOUND"
      || jobListErrorCode === "NO_RECOMMEND_IFRAME"
      || jobListErrorCode === "LOGIN_REQUIRED"
      || jobListErrorMessage.includes("JOB_TRIGGER_NOT_FOUND")
      || jobListErrorMessage.includes("NO_RECOMMEND_IFRAME")
      || jobListErrorMessage.includes("LOGIN_REQUIRED")
    );
    if (pageReadinessFailure) {
      const recheck = await ensureRecommendPageReady(workspaceRoot, {
        port: preflight.debug_port
      });
      const loginRelated = new Set(["LOGIN_REQUIRED", "LOGIN_REQUIRED_AFTER_REDIRECT"]);
      const connectivityRelated = new Set(["DEBUG_PORT_UNREACHABLE"]);
      const guidance = buildChromeSetupGuidance({
        debugPort: preflight.debug_port,
        pageState: recheck.page_state
      });
      if (!recheck.ok || loginRelated.has(recheck.state) || connectivityRelated.has(recheck.state)) {
        return buildFailedResponse(
          connectivityRelated.has(recheck.state)
            ? "BOSS_CHROME_NOT_CONNECTED"
            : loginRelated.has(recheck.state)
              ? "BOSS_LOGIN_REQUIRED"
              : "BOSS_RECOMMEND_PAGE_NOT_READY",
          loginRelated.has(recheck.state)
            ? `检测到当前 Boss 处于未登录状态，请先登录后再继续。登录页：https://www.zhipin.com/web/user/?ka=bticket`
            : connectivityRelated.has(recheck.state)
              ? `读取岗位列表前需要先连接到端口 ${preflight.debug_port} 的 Chrome 远程调试实例。`
              : `读取岗位列表前，请先在端口 ${preflight.debug_port} 的 Chrome 停留在 Boss recommend 页面。`,
          {
            search_params: parsed.searchParams,
            screen_params: parsed.screenParams,
            required_user_action: "prepare_boss_recommend_page",
            guidance,
            diagnostics: {
              debug_port: preflight.debug_port,
              page_state: recheck.page_state,
              stdout: jobListResult.stdout?.slice(-1000),
              stderr: jobListResult.stderr?.slice(-1000),
              result: jobListResult.structured || null
            }
          }
        );
      }
    }
    return buildFailedResponse(
      jobListResult.error?.code || "RECOMMEND_JOB_LIST_FAILED",
      jobListResult.error?.message || "读取推荐岗位列表失败，无法开始筛选。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          debug_port: preflight.debug_port,
          stdout: jobListResult.stdout?.slice(-1000),
          stderr: jobListResult.stderr?.slice(-1000),
          result: jobListResult.structured || null
        }
      }
    );
  }
  const jobOptions = normalizeJobOptions(jobListResult.jobs);
  if (jobOptions.length === 0) {
    return buildFailedResponse(
      "RECOMMEND_JOB_LIST_EMPTY",
      "未识别到可选岗位，暂时无法开始筛选。",
      {
        search_params: parsed.searchParams,
        screen_params: parsed.screenParams,
        diagnostics: {
          debug_port: preflight.debug_port,
          result: jobListResult.structured || null
        }
      }
    );
  }

  const selectedJobHint = normalizeText(confirmation?.job_value || parsed.job_selection_hint || "");
  const selectedJobResolution = resolveSelectedJob(jobOptions, selectedJobHint);
  const jobConfirmed = confirmation?.job_confirmed === true;
  const selectedTabStatus = pageScopeToTabStatus(selectedPage);
  if (!jobConfirmed || !selectedJobResolution.job) {
    const reason = selectedJobResolution.ambiguous
      ? `你提供的岗位“${selectedJobHint}”匹配到多个选项：${selectedJobResolution.candidates.join(" / ")}。请明确选择其中一个岗位。`
      : selectedJobHint
        ? `未在当前岗位列表中找到“${selectedJobHint}”，请从以下岗位中重新确认一个。`
        : "已识别当前推荐页岗位列表，请先确认本次要执行的岗位；确认后会先点击该岗位，再开始 search 和 screen。";
    const pendingQuestions = (parsed.pending_questions || []).filter((item) => item?.field !== "job");
    pendingQuestions.push(buildJobPendingQuestion(jobOptions, selectedJobHint, reason));
    const requiredConfirmations = dedupe([...buildRequiredConfirmations(parsed), "job"]);
    return {
      status: "NEED_CONFIRMATION",
      required_confirmations: requiredConfirmations,
      selected_page: selectedPage,
      search_params: parsed.searchParams,
      screen_params: {
        ...parsed.screenParams,
        target_count: parsed.proposed_target_count ?? parsed.screenParams.target_count,
        post_action: parsed.proposed_post_action || parsed.screenParams.post_action,
        max_greet_count: parsed.proposed_max_greet_count || parsed.screenParams.max_greet_count
      },
      follow_up: parsed.follow_up || null,
      pending_questions: pendingQuestions,
      review: parsed.review,
      job_options: jobOptions
    };
  }
  const selectedJob = selectedJobResolution.job;
  const selectedJobToken = selectedJob.value || selectedJob.title || selectedJob.label;
  if (confirmation?.final_confirmed !== true) {
    const pendingQuestions = (parsed.pending_questions || []).filter((item) => item?.field !== "final_review");
    pendingQuestions.push(buildFinalReviewQuestion({
      searchParams: parsed.searchParams,
      screenParams: {
        ...parsed.screenParams,
        target_count: parsed.proposed_target_count ?? parsed.screenParams.target_count,
        post_action: parsed.proposed_post_action || parsed.screenParams.post_action,
        max_greet_count: parsed.proposed_max_greet_count || parsed.screenParams.max_greet_count
      },
      selectedJob,
      selectedPage,
      followUpChat: parsed.follow_up?.chat || null
    }));
    return {
      status: "NEED_CONFIRMATION",
      required_confirmations: dedupe([...buildRequiredConfirmations(parsed), "final_review"]),
      selected_page: selectedPage,
      search_params: parsed.searchParams,
      screen_params: {
        ...parsed.screenParams,
        target_count: parsed.proposed_target_count ?? parsed.screenParams.target_count,
        post_action: parsed.proposed_post_action || parsed.screenParams.post_action,
        max_greet_count: parsed.proposed_max_greet_count || parsed.screenParams.max_greet_count
      },
      follow_up: parsed.follow_up || null,
      selected_job: selectedJob,
      pending_questions: pendingQuestions,
      review: parsed.review,
      job_options: jobOptions
    };
  }

  const resumeCompletionReason = normalizeText(resume?.previous_completion_reason || "").toLowerCase();
  const isResumeRun = resume?.resume === true;
  const resumeFromPausedBeforeScreen = isResumeRun && resumeCompletionReason === "paused_before_screen";
  const skipSearchOnResume = isResumeRun && !resumeFromPausedBeforeScreen;
  let effectiveSearchParams = { ...parsed.searchParams };
  let searchSummary = null;
  let shouldRunSearch = !skipSearchOnResume;
  let screenAutoRecoveryCount = 0;
  let lastAutoRecovery = null;
  let searchNoIframeRetryCount = 0;
  let searchFilterRetryCount = 0;
  let activeTabStatus = null;
  let currentResumeConfig = {
    checkpoint_path: resume?.checkpoint_path || null,
    pause_control_path: resume?.pause_control_path || null,
    output_csv: resume?.output_csv || null,
    resume: resume?.resume === true,
    require_checkpoint: skipSearchOnResume
  };

  const ensureSelectedPageTab = async () => {
    const expectedStatus = selectedTabStatus;
    let beforeState = null;
    if (typeof readTabState === "function") {
      beforeState = await readTabState(workspaceRoot, { port: preflight.debug_port });
      if (beforeState?.ok && normalizeText(beforeState.active_status)) {
        activeTabStatus = normalizeText(beforeState.active_status);
      }
    }
    if (String(activeTabStatus || "") === String(expectedStatus)) {
      return {
        ok: true,
        switched: false,
        before_state: beforeState || null,
        after_state: beforeState || null
      };
    }
    if (typeof switchTab !== "function") {
      return {
        ok: false,
        error: {
          code: "RECOMMEND_TAB_SWITCH_ADAPTER_MISSING",
          message: "缺少 recommend tab 切换适配器。"
        },
        before_state: beforeState || null,
        after_state: null
      };
    }
    const switchResult = await switchTab(workspaceRoot, {
      port: preflight.debug_port,
      target_status: expectedStatus
    });
    if (!switchResult?.ok) {
      return {
        ok: false,
        error: {
          code: switchResult?.state || "RECOMMEND_TAB_SWITCH_FAILED",
          message: switchResult?.message || `切换到${PAGE_SCOPE_LABELS[selectedPage]} tab 失败。`
        },
        before_state: beforeState || null,
        after_state: switchResult?.tab_state || null
      };
    }
    activeTabStatus = normalizeText(switchResult.active_status || switchResult.tab_state?.active_status || expectedStatus);
    return {
      ok: true,
      switched: true,
      before_state: beforeState || null,
      after_state: switchResult.tab_state || null
    };
  };

  while (true) {
    if (shouldRunSearch) {
      ensurePipelineNotAborted(runtimeHooks.signal);
      runtimeHooks.setStage(
        "search",
        screenAutoRecoveryCount > 0
          ? `自动恢复第 ${screenAutoRecoveryCount} 次：重新执行 recommend search（强制 recent_not_view=${FORCED_RECENT_NOT_VIEW_ON_SCREEN_RECOVERY}）。`
          : "岗位已确认，开始执行 recommend search。"
      );
      runtimeHooks.heartbeat("search", lastAutoRecovery);
      const searchResult = await searchCli({
        workspaceRoot,
        searchParams: effectiveSearchParams,
        selectedJob: selectedJobToken,
        pageScope: selectedPage,
        runtime: runtimeHooks.adapterRuntime("search")
      });
      ensurePipelineNotAborted(runtimeHooks.signal);
      if (isProcessAbortError(searchResult.error)) {
        throw new PipelineAbortError(searchResult.error?.message || "推荐筛选已取消。");
      }
      if (!searchResult.ok) {
        const searchErrorCode = String(searchResult.error?.code || "");
        const searchErrorMessage = String(searchResult.error?.message || "");
        const isNoIframeSearchFailure = (
          searchErrorCode === "NO_RECOMMEND_IFRAME"
          || searchErrorMessage.includes("NO_RECOMMEND_IFRAME")
        );
        const loginRelatedSearchFailure = (
          searchErrorCode === "LOGIN_REQUIRED"
          || isNoIframeSearchFailure
          || searchErrorMessage.includes("LOGIN_REQUIRED")
        );
        if (loginRelatedSearchFailure) {
          const recheck = await ensureRecommendPageReady(workspaceRoot, {
            port: preflight.debug_port
          });
          if (recheck.state === "LOGIN_REQUIRED" || recheck.state === "LOGIN_REQUIRED_AFTER_REDIRECT") {
            const guidance = buildChromeSetupGuidance({
              debugPort: preflight.debug_port,
              pageState: recheck.page_state
            });
            return buildFailedResponse(
              "BOSS_LOGIN_REQUIRED",
              "检测到当前 Boss 处于未登录状态，请先登录后再继续。登录页：https://www.zhipin.com/web/user/?ka=bticket",
              {
                search_params: effectiveSearchParams,
                screen_params: parsed.screenParams,
                selected_job: selectedJob,
                required_user_action: "prepare_boss_recommend_page",
                guidance,
                diagnostics: {
                  debug_port: preflight.debug_port,
                  page_state: recheck.page_state,
                  stdout: searchResult.stdout?.slice(-1000),
                  stderr: searchResult.stderr?.slice(-1000),
                  result: searchResult.structured || null,
                  auto_recovery: lastAutoRecovery
                }
              }
            );
          }
          if (
            isNoIframeSearchFailure
            && recheck.state === "RECOMMEND_READY"
            && searchNoIframeRetryCount < MAX_SEARCH_NO_IFRAME_RETRY_ATTEMPTS
          ) {
            searchNoIframeRetryCount += 1;
            const retryDelayMs = SEARCH_NO_IFRAME_RETRY_DELAY_MS;
            const retryDiagnostics = {
              trigger: "NO_RECOMMEND_IFRAME",
              attempt: searchNoIframeRetryCount,
              max_attempts: MAX_SEARCH_NO_IFRAME_RETRY_ATTEMPTS,
              delay_ms: retryDelayMs,
              page_state: recheck.page_state || null
            };
            runtimeHooks.setStage(
              "search_recovery",
              `检测到 recommend iframe 暂未就绪，等待 ${Math.round(retryDelayMs / 1000)} 秒后重试 search（第 ${searchNoIframeRetryCount}/${MAX_SEARCH_NO_IFRAME_RETRY_ATTEMPTS} 次）。`
            );
            runtimeHooks.heartbeat("search_recovery", retryDiagnostics);
            await sleep(retryDelayMs);
            continue;
          }
        }
        if (
          shouldAutoRetrySearchFilterFailure(searchErrorCode, searchErrorMessage)
          && searchFilterRetryCount < MAX_SEARCH_FILTER_AUTO_RETRY_ATTEMPTS
        ) {
          searchFilterRetryCount += 1;
          const retryDelayMs = SEARCH_FILTER_AUTO_RETRY_DELAY_MS;
          lastAutoRecovery = {
            trigger: "SEARCH_FILTER_RETRY",
            attempt: searchFilterRetryCount,
            max_attempts: MAX_SEARCH_FILTER_AUTO_RETRY_ATTEMPTS,
            delay_ms: retryDelayMs,
            error_code: searchErrorCode || null,
            error_message: searchErrorMessage || null,
            action: "retry_search"
          };
          runtimeHooks.setStage(
            "search_recovery",
            `检测到筛选控件状态异常（${searchErrorCode || "UNKNOWN"}），等待 ${Math.round(retryDelayMs / 1000)} 秒后重试 search（第 ${searchFilterRetryCount}/${MAX_SEARCH_FILTER_AUTO_RETRY_ATTEMPTS} 次）。`
          );
          runtimeHooks.heartbeat("search_recovery", lastAutoRecovery);
          await sleep(retryDelayMs);
          continue;
        }
        return buildFailedResponse(
          searchResult.error?.code || "RECOMMEND_SEARCH_FAILED",
          searchResult.error?.message || "推荐页筛选执行失败。",
          {
            search_params: effectiveSearchParams,
            screen_params: parsed.screenParams,
            selected_job: selectedJob,
            diagnostics: {
              debug_port: preflight.debug_port,
              stdout: searchResult.stdout?.slice(-1000),
              stderr: searchResult.stderr?.slice(-1000),
              result: searchResult.structured || null,
              auto_recovery: lastAutoRecovery
            }
          }
        );
      }

      searchFilterRetryCount = 0;
      searchSummary = searchResult.summary || {};
      if (isPauseRequested(runtimeHooks)) {
        return buildPausedResponse("已在 screen 阶段开始前暂停 Recommend 流水线。", {
          selected_page: selectedPage,
          active_tab_status: activeTabStatus || null,
          search_params: effectiveSearchParams,
          screen_params: parsed.screenParams,
          selected_job: selectedJob,
          partial_result: {
            candidate_count: searchSummary.candidate_count ?? null,
            applied_filters: searchSummary.applied_filters || effectiveSearchParams,
            output_csv: currentResumeConfig.output_csv || null,
            completion_reason: "paused_before_screen"
          }
        });
      }
      const tabSwitchResult = await ensureSelectedPageTab();
      if (!tabSwitchResult.ok) {
        return buildFailedResponse(
          tabSwitchResult.error?.code || "RECOMMEND_TAB_SWITCH_FAILED",
          tabSwitchResult.error?.message || `切换到${PAGE_SCOPE_LABELS[selectedPage]} tab 失败。`,
          {
            selected_page: selectedPage,
            active_tab_status: activeTabStatus || null,
            search_params: effectiveSearchParams,
            screen_params: parsed.screenParams,
            selected_job: selectedJob,
            required_user_action: "retry_switch_recommend_tab",
            guidance: {
              expected_tab_status: selectedTabStatus,
              expected_page_scope: selectedPage,
              expected_page_label: PAGE_SCOPE_LABELS[selectedPage]
            },
            diagnostics: {
              debug_port: preflight.debug_port,
              tab_switch: tabSwitchResult
            }
          }
        );
      }
      ensurePipelineNotAborted(runtimeHooks.signal);
      runtimeHooks.setStage(
        "screen",
        selectedPage !== "recommend"
          ? `search 完成，已切换到${PAGE_SCOPE_LABELS[selectedPage]} tab，开始执行 recommend screen。`
          : "search 完成，开始执行 recommend screen。"
      );
    } else {
      const tabSwitchResult = await ensureSelectedPageTab();
      if (!tabSwitchResult.ok) {
        return buildFailedResponse(
          tabSwitchResult.error?.code || "RECOMMEND_TAB_SWITCH_FAILED",
          tabSwitchResult.error?.message || `切换到${PAGE_SCOPE_LABELS[selectedPage]} tab 失败。`,
          {
            selected_page: selectedPage,
            active_tab_status: activeTabStatus || null,
            search_params: effectiveSearchParams,
            screen_params: parsed.screenParams,
            selected_job: selectedJob,
            required_user_action: "retry_switch_recommend_tab",
            guidance: {
              expected_tab_status: selectedTabStatus,
              expected_page_scope: selectedPage,
              expected_page_label: PAGE_SCOPE_LABELS[selectedPage]
            },
            diagnostics: {
              debug_port: preflight.debug_port,
              tab_switch: tabSwitchResult
            }
          }
        );
      }
      ensurePipelineNotAborted(runtimeHooks.signal);
      runtimeHooks.setStage("screen", "检测到可续跑 checkpoint，跳过 search，直接恢复 recommend screen。");
    }

    runtimeHooks.heartbeat("screen", lastAutoRecovery);
    const screenResult = await screenCli({
      workspaceRoot,
      screenParams: parsed.screenParams,
      pageScope: selectedPage,
      inputSummary: buildScreenInputSummary({
        instruction,
        selectedPage,
        selectedJob,
        userSearchParams: parsed.searchParams,
        effectiveSearchParams,
        screenParams: parsed.screenParams,
        followUp: parsed.follow_up || null
      }),
      resume: currentResumeConfig,
      runtime: runtimeHooks.adapterRuntime("screen")
    });
    ensurePipelineNotAborted(runtimeHooks.signal);
    if (isProcessAbortError(screenResult.error)) {
      throw new PipelineAbortError(screenResult.error?.message || "推荐筛选已取消。");
    }
    if (screenResult.paused) {
      return buildPausedResponse("Recommend 流水线已暂停，可使用 resume 继续。", {
        selected_page: selectedPage,
        active_tab_status: activeTabStatus || null,
        search_params: effectiveSearchParams,
        screen_params: parsed.screenParams,
        selected_job: selectedJob,
        partial_result: screenResult.summary || screenResult.structured?.result || null
      });
    }
    if (!screenResult.ok) {
      const screenErrorCode = String(screenResult.error?.code || "");
      const partialScreenResult = screenResult.summary || screenResult.structured?.result || null;
      const resumeOutputCsv = normalizeText(partialScreenResult?.output_csv || currentResumeConfig.output_csv || "");
      const hasCheckpointForRecovery = Boolean(normalizeText(currentResumeConfig.checkpoint_path || ""));
      const screenPartialForRecovery = partialScreenResult
        ? {
            processed_count: partialScreenResult.processed_count ?? null,
            passed_count: partialScreenResult.passed_count ?? null,
            skipped_count: partialScreenResult.skipped_count ?? null,
            output_csv: partialScreenResult.output_csv || currentResumeConfig.output_csv || null,
            checkpoint_path: partialScreenResult.checkpoint_path || currentResumeConfig.checkpoint_path || null,
            completion_reason: partialScreenResult.completion_reason || null
          }
        : null;
      const isResumeCaptureRecovery = screenErrorCode === "RESUME_CAPTURE_FAILED_CONSECUTIVE_LIMIT";
      const isPageExhaustedRecovery = screenErrorCode === "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED";
      const isRecoverableScreenFailure = isResumeCaptureRecovery || isPageExhaustedRecovery;
      const canRecoverSafely = hasCheckpointForRecovery && Boolean(resumeOutputCsv);
      const hasRecoveryAttemptsRemaining = screenAutoRecoveryCount < MAX_SCREEN_AUTO_RECOVERY_ATTEMPTS;

      if (isRecoverableScreenFailure && !canRecoverSafely) {
        return buildFailedResponse(
          "SCREEN_AUTO_RECOVERY_UNSAFE",
          "检测到 recommend 自动恢复触发，但缺少 checkpoint 或 output_csv，无法安全续跑。",
          {
            search_params: effectiveSearchParams,
            screen_params: parsed.screenParams,
            selected_job: selectedJob,
            partial_result: partialScreenResult,
            diagnostics: {
              debug_port: preflight.debug_port,
              stdout: screenResult.stdout?.slice(-1000),
              stderr: screenResult.stderr?.slice(-1000),
              result: screenResult.structured || null,
              auto_recovery: {
                trigger: screenErrorCode,
                attempt: screenAutoRecoveryCount,
                max_attempts: MAX_SCREEN_AUTO_RECOVERY_ATTEMPTS,
                original_recent_not_view: parsed.searchParams.recent_not_view,
                effective_recent_not_view: effectiveSearchParams.recent_not_view,
                partial_result: screenPartialForRecovery
              }
            }
          }
        );
      }

      if (isRecoverableScreenFailure && !hasRecoveryAttemptsRemaining) {
        return buildFailedResponse(
          screenResult.error?.code || "RECOMMEND_SCREEN_FAILED",
          `${screenResult.error?.message || "推荐页筛选执行失败。"} 已达到自动恢复上限 ${MAX_SCREEN_AUTO_RECOVERY_ATTEMPTS} 次。`,
          {
            search_params: effectiveSearchParams,
            screen_params: parsed.screenParams,
            selected_job: selectedJob,
            partial_result: partialScreenResult,
            diagnostics: {
              debug_port: preflight.debug_port,
              stdout: screenResult.stdout?.slice(-1000),
              stderr: screenResult.stderr?.slice(-1000),
              result: screenResult.structured || null,
              auto_recovery: lastAutoRecovery
            }
          }
        );
      }

      if (isRecoverableScreenFailure && canRecoverSafely && hasRecoveryAttemptsRemaining) {
        screenAutoRecoveryCount += 1;
        lastAutoRecovery = {
          trigger: screenErrorCode,
          attempt: screenAutoRecoveryCount,
          max_attempts: MAX_SCREEN_AUTO_RECOVERY_ATTEMPTS,
          original_recent_not_view: parsed.searchParams.recent_not_view,
          effective_recent_not_view: effectiveSearchParams.recent_not_view,
          partial_result: screenPartialForRecovery,
          page_exhaustion: screenResult.error?.page_exhaustion || null
        };

        if (isPageExhaustedRecovery) {
          runtimeHooks.setStage(
            "screen_recovery",
            `推荐列表已到底但未达目标，开始自动补货（第 ${screenAutoRecoveryCount} 次）：优先尝试页内刷新。`
          );
          runtimeHooks.heartbeat("screen_recovery", lastAutoRecovery);

          const refreshResult = typeof refreshRecommendList === "function"
            ? await refreshRecommendList(workspaceRoot, {
                port: preflight.debug_port
              })
            : {
                ok: false,
                action: "in_page_refresh",
                state: "REFRESH_ADAPTER_MISSING",
                message: "缺少页内刷新适配器。"
              };
          ensurePipelineNotAborted(runtimeHooks.signal);

          lastAutoRecovery = {
            ...lastAutoRecovery,
            refresh: refreshResult
              ? {
                  ok: refreshResult.ok,
                  state: refreshResult.state || null,
                  message: refreshResult.message || null,
                  before_state: refreshResult.before_state || null,
                  after_state: refreshResult.after_state || null
                }
              : null
          };

          if (refreshResult?.ok) {
            lastAutoRecovery = {
              ...lastAutoRecovery,
              action: "in_page_refresh"
            };
            currentResumeConfig = {
              checkpoint_path: currentResumeConfig.checkpoint_path || null,
              pause_control_path: currentResumeConfig.pause_control_path || null,
              output_csv: resumeOutputCsv || null,
              resume: true,
              require_checkpoint: true
            };
            shouldRunSearch = false;
            searchSummary = null;
            continue;
          }

          runtimeHooks.setStage(
            "screen_recovery",
            `页内刷新不可用（${refreshResult?.state || "unknown"}），改为刷新 recommend 页面并重跑 search。`
          );
          runtimeHooks.heartbeat("screen_recovery", lastAutoRecovery);
        } else {
        const recoveryFailureText = "简历获取失败（network + 截图）";
        runtimeHooks.setStage(
          "screen_recovery",
          `screen 连续${recoveryFailureText}，开始自动恢复（第 ${screenAutoRecoveryCount} 次）：刷新 recommend 页面并重跑 search。`
        );
          runtimeHooks.heartbeat("screen_recovery", lastAutoRecovery);
        }

        effectiveSearchParams = {
          ...effectiveSearchParams,
          recent_not_view: FORCED_RECENT_NOT_VIEW_ON_SCREEN_RECOVERY
        };
        lastAutoRecovery = {
          ...lastAutoRecovery,
          action: "reload_page_and_rerun_search",
          effective_recent_not_view: effectiveSearchParams.recent_not_view
        };

        const reloadResult = typeof reloadRecommendPage === "function"
          ? await reloadRecommendPage(workspaceRoot, {
              port: preflight.debug_port
            })
          : null;
        ensurePipelineNotAborted(runtimeHooks.signal);

        lastAutoRecovery = {
          ...lastAutoRecovery,
          reload: reloadResult
            ? {
                ok: reloadResult.ok,
                state: reloadResult.state || null,
                message: reloadResult.message || null,
                reloaded_url: reloadResult.reloaded_url || null
              }
            : null
        };

        const recoveryPageCheck = await ensureRecommendPageReady(workspaceRoot, {
          port: preflight.debug_port
        });
        ensurePipelineNotAborted(runtimeHooks.signal);
        if (!recoveryPageCheck.ok) {
          const guidance = buildChromeSetupGuidance({
            debugPort: preflight.debug_port,
            pageState: recoveryPageCheck.page_state
          });
          return buildFailedResponse(
            recoveryPageCheck.state === "LOGIN_REQUIRED" || recoveryPageCheck.state === "LOGIN_REQUIRED_AFTER_REDIRECT"
              ? "BOSS_LOGIN_REQUIRED"
              : recoveryPageCheck.state === "DEBUG_PORT_UNREACHABLE"
                ? "BOSS_CHROME_NOT_CONNECTED"
                : "BOSS_RECOMMEND_PAGE_NOT_READY",
            "自动恢复时无法重新就绪 recommend 页面，请先处理页面状态后再继续。",
            {
              search_params: effectiveSearchParams,
              screen_params: parsed.screenParams,
              selected_job: selectedJob,
              partial_result: partialScreenResult,
              required_user_action: "prepare_boss_recommend_page",
              guidance,
              diagnostics: {
                debug_port: preflight.debug_port,
                page_state: recoveryPageCheck.page_state,
                stdout: screenResult.stdout?.slice(-1000),
                stderr: screenResult.stderr?.slice(-1000),
                result: screenResult.structured || null,
                auto_recovery: lastAutoRecovery
              }
            }
          );
        }

        currentResumeConfig = {
          checkpoint_path: currentResumeConfig.checkpoint_path || null,
          pause_control_path: currentResumeConfig.pause_control_path || null,
          output_csv: resumeOutputCsv || null,
          resume: true,
          require_checkpoint: true
        };
        shouldRunSearch = true;
        searchSummary = null;
        continue;
      }

      return buildFailedResponse(
        screenResult.error?.code || "RECOMMEND_SCREEN_FAILED",
        screenResult.error?.message || "推荐页筛选执行失败。",
        {
          search_params: effectiveSearchParams,
          screen_params: parsed.screenParams,
          selected_job: selectedJob,
          partial_result: partialScreenResult,
          diagnostics: {
            debug_port: preflight.debug_port,
            stdout: screenResult.stdout?.slice(-1000),
            stderr: screenResult.stderr?.slice(-1000),
            result: screenResult.structured || null,
            auto_recovery: lastAutoRecovery
          }
        }
      );
    }

    runtimeHooks.setStage("finalize", "screen 完成，正在汇总结果。");
    runtimeHooks.heartbeat("finalize");
    const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const finalSearchSummary = searchSummary || {};
    const screenSummary = screenResult.summary || {};
    const resolvedActiveTabStatus = normalizeText(
      screenSummary.active_tab_status
      || finalSearchSummary.active_tab_status
      || activeTabStatus
      || selectedTabStatus
    ) || selectedTabStatus;
    const resolvedSelectedPage = normalizePageScope(
      screenSummary.selected_page
      || finalSearchSummary.selected_page
      || selectedPage
      || tabStatusToPageScope(resolvedActiveTabStatus)
    ) || selectedPage;
    const resolvedResumeSourceRaw = normalizeText(screenSummary.resume_source || "").toLowerCase();
    const resolvedResumeSource = ["network", "image_fallback"].includes(resolvedResumeSourceRaw)
      ? resolvedResumeSourceRaw
      : "network";
    runtimeHooks.progress("finalize", {
      processed: screenSummary.processed_count ?? 0,
      passed: screenSummary.passed_count ?? 0,
      skipped: screenSummary.skipped_count ?? 0,
      greet_count: screenSummary.greet_count ?? 0
    });

    const recommendResult = {
      status: "COMPLETED",
      search_params: effectiveSearchParams,
      screen_params: parsed.screenParams,
      result: {
        candidate_count: finalSearchSummary.candidate_count ?? null,
        applied_filters: finalSearchSummary.applied_filters || effectiveSearchParams,
        processed_count: screenSummary.processed_count ?? 0,
        passed_count: screenSummary.passed_count ?? 0,
        skipped_count: screenSummary.skipped_count ?? 0,
        duration_sec: durationSec,
        output_csv: screenSummary.output_csv || null,
        completion_reason: screenSummary.completion_reason || "screen_completed",
        page_state: finalSearchSummary.page_state || pageCheck.page_state,
        selected_job: finalSearchSummary.selected_job || selectedJob,
        selected_page: resolvedSelectedPage,
        active_tab_status: resolvedActiveTabStatus,
        resume_source: resolvedResumeSource,
        post_action: parsed.screenParams.post_action,
        max_greet_count: parsed.screenParams.max_greet_count,
        greet_count: screenSummary.greet_count ?? 0,
        greet_limit_fallback_count: screenSummary.greet_limit_fallback_count ?? 0,
        auto_recovery: lastAutoRecovery
      },
      message: parsed.screenParams.post_action === "none"
        ? "Recommend 流水线已完成。本次 post_action=none：符合条件的人选仅记录到 CSV，不执行收藏或打招呼。"
        : "Recommend 流水线已完成。post_action 在运行开始时已一次性确认；若选择打招呼并设置上限，超出上限后会自动改为收藏。"
    };

    if (!parsed.follow_up_chat?.requested) {
      return recommendResult;
    }

    return runBossChatFollowUpPhase({
      workspaceRoot,
      followUpChat: parsed.follow_up_chat,
      selectedJob,
      debugPort: preflight.debug_port,
      recommendResult,
      resume,
      runtimeHooks,
      startChatRun,
      getChatRun,
      pauseChatRun,
      resumeChatRun,
      cancelChatRun
    });
  }
}
