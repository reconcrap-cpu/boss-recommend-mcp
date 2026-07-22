import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  connectToChromeTargetOrOpen,
  createBossLoginRequiredError,
  detectBossLoginState,
  enableDomains,
  FORBIDDEN_CDP_METHODS,
  getCdpMethodLogStats,
  getMainFrameUrl,
  inspectChromeDebugCommandLine,
  isBossLoginUrl,
  waitForMainFrameUrl,
  sleep
} from "./core/browser/index.js";
import {
  RUN_STATUS_CANCELING,
  RUN_STATUS_CANCELED,
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_PAUSED
} from "./core/run/index.js";
import {
  buildLegacyScreenInputRows,
  cloneReportInput,
  writeLegacyScreenCsv
} from "./core/reporting/legacy-csv.js";
import {
  buildRecommendSelfHealConfig,
  HEALTH_STATUS,
  resolveRecommendSelfHealRoots,
  runSelfHealCheck
} from "./core/self-heal/index.js";
import {
  closeRecommendJobDropdown,
  closeRecommendDetail,
  createRecommendRunService,
  getRecommendRoots,
  inspectRecommendFilteredEmptyState,
  listRecommendJobOptions,
  RECOMMEND_TARGET_URL,
  runRecommendWorkflow
} from "./domains/recommend/index.js";
import {
  parseRecommendInstruction
} from "./parser.js";
import { getRunsDir } from "./run-state.js";
import {
  getCandidateResultJournalPath,
  readCandidateResultJournal
} from "./core/run/candidate-result-journal.js";
import {
  resolveBossConfiguredOutputDir,
  resolveHumanBehaviorForRun,
  resolveBossScreeningConfig
} from "./chat-runtime-config.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "./core/cv-acquisition/index.js";

const DEFAULT_RECOMMEND_HOST = "127.0.0.1";
const DEFAULT_RECOMMEND_PORT = 9222;
const DEFAULT_RECOMMEND_POLL_AFTER_SEC = 10;
const STATUS_METHOD_LOG_TAIL_LIMIT = 25;
const TARGET_COUNT_SEMANTICS = "target_count means candidates that pass screening; scan continues until that many candidates pass or the list ends";
const RUN_MODE_ASYNC = "async";
const REST_LEVEL_OPTIONS = ["low", "medium", "high"];
const REST_LEVEL_SET = new Set(REST_LEVEL_OPTIONS);

const TERMINAL_STATUSES = new Set([
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_CANCELED
]);

let recommendWorkflowImpl = runRecommendWorkflow;
let recommendConnectorImpl = connectRecommendChromeSession;
let recommendJobReaderImpl = readRecommendJobOptionsFromSession;
let recommendRunService = createRecommendRunService({
  idPrefix: "mcp_recommend",
  workflow: (...args) => recommendWorkflowImpl(...args),
  onSnapshot: persistRecommendLifecycleSnapshot
});
const recommendRunMeta = new Map();

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function collectRecommendRouteText(args = {}) {
  return normalizeText([
    args.instruction,
    args.criteria,
    args.target_url_includes,
    args.page_scope,
    args.confirmation?.page_value,
    args.confirmation?.job_value,
    args.overrides?.criteria,
    args.overrides?.page_scope,
    args.overrides?.job,
    args.overrides?.target_url_includes
  ].filter((value) => value !== undefined && value !== null).join(" "));
}

function findRouteSignals(text, patterns = []) {
  const signals = [];
  for (const { label, pattern } of patterns) {
    if (pattern.test(text)) signals.push(label);
  }
  return signals;
}

function detectExplicitNonRecommendScope(args = {}) {
  const fields = [
    ["page_scope", args.page_scope],
    ["confirmation.page_value", args.confirmation?.page_value],
    ["overrides.page_scope", args.overrides?.page_scope],
    ["target_url_includes", args.target_url_includes],
    ["overrides.target_url_includes", args.overrides?.target_url_includes]
  ];
  for (const [field, value] of fields) {
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) continue;
    if (/\/web\/chat\/index|chat\/index/.test(normalized) || ["chat", "chat-page", "boss-chat"].includes(normalized)) {
      return {
        domain: "chat",
        signals: [`${field}:chat`],
        text: normalized
      };
    }
    if (/\/web\/chat\/search|chat\/search/.test(normalized) || ["search", "search-page", "recruit", "recruit-page", "boss-recruit"].includes(normalized)) {
      return {
        domain: "search",
        signals: [`${field}:search`],
        text: normalized
      };
    }
  }
  return null;
}

function detectRecruitShapedRecommendArgs(args = {}) {
  const checks = [
    ["keyword", args.keyword],
    ["search_keyword", args.search_keyword],
    ["city", args.city],
    ["confirmation.keyword_value", args.confirmation?.keyword_value],
    ["confirmation.keyword_confirmed", args.confirmation?.keyword_confirmed],
    ["confirmation.search_params_confirmed", args.confirmation?.search_params_confirmed],
    ["overrides.keyword", args.overrides?.keyword],
    ["overrides.search_keyword", args.overrides?.search_keyword],
    ["overrides.city", args.overrides?.city],
    ["overrides.filter_recent_viewed", args.overrides?.filter_recent_viewed],
    ["overrides.schools", args.overrides?.schools],
    ["overrides.school_tags", args.overrides?.school_tags]
  ];
  const signals = [];
  for (const [field, value] of checks) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "string" && !normalizeText(value)) continue;
    signals.push(field);
  }
  if (!signals.length) return null;
  return {
    domain: "search",
    signals: signals.map((field) => `${field}:recruit_arg`),
    text: signals.join(" ")
  };
}

function detectNonRecommendRoute(args = {}) {
  const explicitRoute = detectExplicitNonRecommendScope(args);
  if (explicitRoute) return explicitRoute;
  const recruitArgRoute = detectRecruitShapedRecommendArgs(args);
  if (recruitArgRoute) return recruitArgRoute;

  const text = collectRecommendRouteText(args);
  if (!text) return null;
  const chatSignals = findRouteSignals(text, [
    { label: "chat-only", pattern: /\bchat[-\s]?only\b/i },
    { label: "boss-chat", pattern: /\bboss[-\s]?chat\b/i },
    { label: "chat page", pattern: /\bchat\s+page\b/i },
    { label: "chat/index", pattern: /(?:\/web\/chat\/index|chat\/index)/i },
    { label: "聊天页", pattern: /聊天页/ },
    { label: "聊天列表", pattern: /聊天列表/ },
    { label: "未读", pattern: /未读/ },
    { label: "全部聊天", pattern: /全部聊天|所有聊天/ },
    { label: "求简历", pattern: /求简历|索要简历|要简历|在线简历/ }
  ]);
  if (chatSignals.length) {
    return {
      domain: "chat",
      signals: chatSignals,
      text
    };
  }
  const searchSignals = findRouteSignals(text, [
    { label: "search-only", pattern: /\bsearch[-\s]?only\b/i },
    { label: "search page", pattern: /\bsearch\s+page\b/i },
    { label: "search keyword", pattern: /搜索关键词|关键词|keyword/i },
    { label: "recruit pipeline", pattern: /\brecruit\s+pipeline\b/i },
    { label: "chat/search", pattern: /(?:\/web\/chat\/search|chat\/search)/i },
    { label: "搜索页", pattern: /搜索页/ },
    { label: "招聘搜索", pattern: /招聘搜索/ }
  ]);
  if (searchSignals.length) {
    return {
      domain: "search",
      signals: searchSignals,
      text
    };
  }
  return null;
}

function buildWrongRecommendRouteResponse(route) {
  if (route?.domain === "chat") {
    return {
      status: "FAILED",
      route_guard: true,
      error: {
        code: "WRONG_BOSS_TOOL_FOR_CHAT",
        message: "This request is explicitly chat-only/chat-page work. In Trae-CN split toolsets, call boss-chat/boss_chat_health_check, then boss-chat/list_boss_chat_jobs or boss-chat/prepare_boss_chat_run, then boss-chat/start_boss_chat_run. Do not call boss-recommend tools.",
        retryable: false
      },
      detected_domain: "chat",
      detected_signals: route.signals || [],
      wrong_server: "boss-recommend",
      recommended_server: "boss-chat",
      recommended_tool_sequence: [
        "boss-chat/boss_chat_health_check",
        "boss-chat/list_boss_chat_jobs",
        "boss-chat/prepare_boss_chat_run",
        "boss-chat/start_boss_chat_run"
      ]
    };
  }
  if (route?.domain === "search") {
    return {
      status: "FAILED",
      route_guard: true,
      error: {
        code: "WRONG_BOSS_TOOL_FOR_SEARCH",
        message: "This request is explicitly search/recruit-page work. In Trae-CN split toolsets, call boss-recruit/run_recruit_pipeline or boss-recruit/start_recruit_pipeline_run. Do not call boss-recommend/run_recommend or boss-recommend/start_recommend_pipeline_run.",
        retryable: false
      },
      detected_domain: "search",
      detected_signals: route.signals || [],
      wrong_server: "boss-recommend",
      recommended_server: "boss-recruit",
      recommended_tool_sequence: [
        "boss-recruit/run_recruit_pipeline",
        "boss-recruit/start_recruit_pipeline_run"
      ]
    };
  }
  return null;
}

function guardRecommendRoute(args = {}) {
  return buildWrongRecommendRouteResponse(detectNonRecommendRoute(args));
}

function parsePositiveInteger(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(raw, fallback) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isDebugTestMode(args = {}) {
  return args.debug_test_mode === true || args.allow_debug_test_mode === true;
}

function normalizeScreeningModeArg(args = {}) {
  const raw = normalizeText(args.screening_mode || args.screeningMode || "");
  if (args.use_llm === false) return "deterministic";
  return ["deterministic", "local", "local_scorer"].includes(raw.toLowerCase())
    ? "deterministic"
    : "llm";
}

function collectRecommendDebugTestOptions(args = {}, normalized = {}) {
  const reasons = [];
  if (normalizeScreeningModeArg(args) === "deterministic") reasons.push("deterministic_screening");
  if (args.allow_card_only_screening === true) reasons.push("allow_card_only_screening");
  if (parseNonNegativeInteger(args.detail_limit, null) === 0) reasons.push("detail_limit=0");
  if (args.no_filter === true) reasons.push("no_filter");
  if (args.filter_enabled === false) reasons.push("filter_enabled=false");
  if (args.debug_force_list_end_after_processed != null) {
    reasons.push("debug_force_list_end_after_processed");
  }
  if (args.debug_force_context_recovery_after_processed != null) {
    reasons.push("debug_force_context_recovery_after_processed");
  }
  if (args.debug_force_cdp_reconnect_after_processed != null) {
    reasons.push("debug_force_cdp_reconnect_after_processed");
  }
  if (args.dry_run_post_action === true) reasons.push("dry_run_post_action");
  if (args.execute_post_action === false && normalized.postAction && normalized.postAction !== "none") {
    reasons.push("execute_post_action=false");
  }
  return reasons;
}

function resolveRecommendDetailLimit(args = {}, normalized = {}) {
  const fallback = parsePositiveInteger(normalized.targetCount, 5);
  const requested = parseNonNegativeInteger(args.detail_limit, fallback);
  if (requested === 0 && !isDebugTestMode(args)) {
    return fallback;
  }
  if (requested === 0 && args.allow_card_only_screening !== true) {
    return fallback;
  }
  return requested;
}

function methodSummary(methodLog = []) {
  const summary = {};
  for (const entry of methodLog || []) {
    const method = compactCdpMethodName(entry?.method || entry || "");
    if (!method) continue;
    summary[method] = (summary[method] || 0) + 1;
  }
  return summary;
}

function compactCdpMethodName(value) {
  const method = normalizeText(value);
  return /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*(?::retry_after_reconnect)?$/.test(method)
    ? method
    : "";
}

function compactCdpMethodTimestamp(value) {
  const timestamp = normalizeText(value);
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function compactMethodLogForStatus(methodLog = []) {
  if (!Array.isArray(methodLog)) return [];
  return methodLog
    .map((entry) => {
      const compact = {
        method: compactCdpMethodName(entry?.method || entry || ""),
        at: compactCdpMethodTimestamp(entry?.at || "")
      };
      for (const key of ["connection_epoch", "replay_of_connection_epoch"]) {
        if (Number.isInteger(entry?.[key]) && entry[key] >= 0) compact[key] = entry[key];
      }
      const replayPolicy = normalizeText(entry?.replay_policy || "");
      if (replayPolicy) compact.replay_policy = replayPolicy.slice(0, 100);
      return compact;
    })
    .filter((entry) => Boolean(entry.method))
    .slice(-STATUS_METHOD_LOG_TAIL_LIMIT);
}

function canonicalRecommendChromeHost(host = "") {
  const normalized = String(host || "").trim().toLowerCase();
  return ["", "localhost", "127.0.0.1", "::1"].includes(normalized)
    ? "127.0.0.1"
    : normalized;
}

function readChromeCommandLineValue(args = [], name = "") {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    if (value.startsWith(prefix)) return value.slice(prefix.length).trim();
    if (value === `--${name}`) return String(args[index + 1] || "").trim();
  }
  return "";
}

function resolveExactChromeProfileDirectory(userDataDir, explicitProfileDirectory = "") {
  const resolvedUserDataDir = fs.realpathSync(path.resolve(userDataDir));
  let profileDirectory = String(explicitProfileDirectory || "").trim();
  if (!profileDirectory) {
    const localStatePath = path.join(resolvedUserDataDir, "Local State");
    const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const lastActive = Array.isArray(localState?.profile?.last_active_profiles)
      ? localState.profile.last_active_profiles.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const cachedProfiles = Object.keys(localState?.profile?.info_cache || {}).filter(Boolean);
    const candidates = Array.from(new Set([...lastActive, ...cachedProfiles]));
    if (candidates.length !== 1) {
      const error = new Error(
        "Chrome profile directory is not explicit and Local State does not prove exactly one active profile"
      );
      error.code = "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED";
      throw error;
    }
    profileDirectory = candidates[0];
  }
  const resolvedProfileDir = fs.realpathSync(path.resolve(resolvedUserDataDir, profileDirectory));
  const relativeProfile = path.relative(resolvedUserDataDir, resolvedProfileDir);
  if (!relativeProfile || relativeProfile.startsWith("..") || path.isAbsolute(relativeProfile)) {
    const error = new Error("Chrome profile directory is not a child of the exact user-data directory");
    error.code = "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED";
    throw error;
  }
  return {
    user_data_dir: process.platform === "win32" ? resolvedUserDataDir.toLowerCase() : resolvedUserDataDir,
    profile_directory: relativeProfile.replaceAll("\\", "/")
  };
}

export async function resolveRecommendActionJournalScope({
  host = DEFAULT_RECOMMEND_HOST,
  port = DEFAULT_RECOMMEND_PORT,
  session = null,
  inspectCommandLine = inspectChromeDebugCommandLine,
  strictFresh = false
} = {}) {
  const canonicalHost = canonicalRecommendChromeHost(host);
  if (canonicalHost !== "127.0.0.1") {
    const error = new Error("Live recommend greetings require a local canonical Chrome profile identity");
    error.code = "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED";
    throw error;
  }
  let userDataDir = "";
  let profileDirectory = "";
  let source = "";
  if (strictFresh === true) {
    let commandLine = null;
    try {
      commandLine = await inspectCommandLine({ host: canonicalHost, port });
    } catch (error) {
      const inspectionError = new Error(
        "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED: fresh Chrome command-line inspection failed"
      );
      inspectionError.code = "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED";
      inspectionError.retryable = false;
      inspectionError.cause = error;
      throw inspectionError;
    }
    const observedPort = Number(readChromeCommandLineValue(
      commandLine?.arguments,
      "remote-debugging-port"
    ));
    if (commandLine?.ok !== true || observedPort !== Number(port)) {
      const inspectionError = new Error(
        "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED: fresh Chrome process/port identity could not be proven"
      );
      inspectionError.code = "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED";
      inspectionError.retryable = false;
      inspectionError.expected_port = Number(port);
      inspectionError.observed_port = Number.isFinite(observedPort) ? observedPort : null;
      throw inspectionError;
    }
    userDataDir = readChromeCommandLineValue(commandLine.arguments, "user-data-dir");
    profileDirectory = readChromeCommandLineValue(commandLine.arguments, "profile-directory");
    source = `fresh_${commandLine.source || "chrome_command_line"}`;
  } else {
    const injected = session?.profile_identity;
    if (injected?.verified === true) {
      userDataDir = String(injected.user_data_dir || "").trim();
      profileDirectory = String(injected.profile_directory || "").trim();
      source = "session_verified_profile_identity";
    } else {
      let commandLine = null;
      try {
        commandLine = await inspectCommandLine({ host: canonicalHost, port });
      } catch {
        commandLine = null;
      }
      if (commandLine?.ok === true) {
        userDataDir = readChromeCommandLineValue(commandLine.arguments, "user-data-dir");
        profileDirectory = readChromeCommandLineValue(commandLine.arguments, "profile-directory");
        source = commandLine.source || "chrome_command_line";
      }
      if (!userDataDir && session?.chrome?.launched === true) {
        userDataDir = String(session.chrome.user_data_dir || "").trim();
        source = "same_call_chrome_launch";
      }
    }
  }
  if (!userDataDir) {
    const error = new Error(
      "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED: exact Chrome user-data/profile directory could not be proven"
    );
    error.code = "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED";
    error.retryable = false;
    throw error;
  }
  let exactProfile;
  try {
    exactProfile = resolveExactChromeProfileDirectory(userDataDir, profileDirectory);
  } catch (error) {
    const safeError = new Error(
      "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED: exact Chrome profile directory could not be proven"
    );
    safeError.code = "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED";
    safeError.retryable = false;
    throw safeError;
  }
  if (!exactProfile.user_data_dir || !exactProfile.profile_directory) {
    const error = new Error("Exact Chrome user-data/profile directory could not be proven");
    error.code = "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED";
    throw error;
  }
  const profileHash = crypto.createHash("sha256")
    .update(
      `boss-chrome-profile-v1\u0000${exactProfile.user_data_dir}\u0000${exactProfile.profile_directory}`,
      "utf8"
    )
    .digest("hex");
  return {
    scope: `boss-recommend-profile-v2:${canonicalHost}:profile-sha256:${profileHash}`,
    identity: {
      verified: true,
      source,
      canonical_host: canonicalHost,
      profile_sha256: profileHash,
      profile_directory: exactProfile.profile_directory
    }
  };
}

function clonePlain(value, fallback = null) {
  try {
    return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function plainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmptyRecord(value) {
  const record = plainRecord(value);
  return Object.keys(record).length ? record : null;
}

function compactMethodSummaryForStatus(value = {}) {
  const compact = {};
  for (const [rawMethod, rawCount] of Object.entries(plainRecord(value))) {
    const method = compactCdpMethodName(rawMethod);
    const count = Number(rawCount);
    if (!method || !Number.isInteger(count) || count < 1) continue;
    compact[method] = count;
  }
  return compact;
}

function compactChromeEvidenceUrl(value) {
  const text = normalizeText(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return text.split(/[?#]/, 1)[0] || null;
  }
}

function compactChromeAutoLaunchEvidence(value = {}) {
  const source = plainRecord(value);
  if (!Object.keys(source).length) return null;
  const compact = {};
  const booleanKeys = [
    "launched",
    "reused",
    "guard_checked",
    "required_flags_ok",
    "replaced",
    "target_created",
    "fallback_target",
    "fallback_any_page"
  ];
  for (const key of booleanKeys) {
    if (typeof source[key] === "boolean") compact[key] = source[key];
  }
  for (const key of ["port", "target_count", "command_line_args_count"]) {
    if (Number.isInteger(source[key]) && source[key] >= 0) compact[key] = source[key];
  }
  for (const key of ["close_method", "command_line_source"]) {
    const text = normalizeText(source[key]);
    if (text) compact[key] = text;
  }
  return Object.keys(compact).length ? compact : null;
}

function compactChromeEvidence(value = {}) {
  const source = plainRecord(value);
  if (!Object.keys(source).length) return null;
  const compact = {};
  const host = normalizeText(source.host);
  const targetId = normalizeText(source.target_id);
  const targetUrl = compactChromeEvidenceUrl(source.target_url);
  if (host) compact.host = host;
  if (Number.isInteger(source.port) && source.port > 0) compact.port = source.port;
  if (targetUrl) compact.target_url = targetUrl;
  if (targetId) compact.target_id = targetId;
  const autoLaunch = compactChromeAutoLaunchEvidence(source.auto_launch);
  if (autoLaunch) compact.auto_launch = autoLaunch;
  return Object.keys(compact).length ? compact : null;
}

function methodEvidenceFlags(methodSummaryValue = {}) {
  const methods = Object.keys(methodSummaryValue);
  return {
    runtime_evaluate_used: methods.some((method) => method.split(".", 1)[0] === "Runtime"),
    script_injection_used: methods.some((method) => (
      FORBIDDEN_CDP_METHODS.has(method.replace(/:retry_after_reconnect$/, ""))
    ))
  };
}

function buildPersistedCdpEvidence({ meta = {}, persisted = {} } = {}) {
  const hasLiveMethodLog = Array.isArray(meta.methodLog);
  const liveMethodLogStats = hasLiveMethodLog
    ? getCdpMethodLogStats(meta.methodLog)
    : null;
  const persistedMethodLog = compactMethodLogForStatus(persisted.method_log);
  const methodLog = hasLiveMethodLog
    ? compactMethodLogForStatus(meta.methodLog)
    : persistedMethodLog;
  const persistedSummary = compactMethodSummaryForStatus(persisted.method_summary);
  const summary = hasLiveMethodLog
    ? compactMethodSummaryForStatus(liveMethodLogStats?.method_summary)
    : Object.keys(persistedSummary).length
      ? persistedSummary
      : methodSummary(methodLog);
  const liveTotal = hasLiveMethodLog ? liveMethodLogStats?.total_count : null;
  const persistedTotal = Number(persisted.method_log_total);
  const methodLogTotal = Number.isInteger(liveTotal)
    ? liveTotal
    : Number.isInteger(persistedTotal) && persistedTotal >= methodLog.length
      ? persistedTotal
      : methodLog.length;
  const inferredFlags = methodEvidenceFlags(summary);
  return {
    runtime_evaluate_used: hasLiveMethodLog
      ? inferredFlags.runtime_evaluate_used
      : persisted.runtime_evaluate_used === true || inferredFlags.runtime_evaluate_used,
    script_injection_used: hasLiveMethodLog
      ? inferredFlags.script_injection_used
      : persisted.script_injection_used === true || inferredFlags.script_injection_used,
    method_summary: summary,
    method_log: methodLog,
    method_log_total: methodLogTotal,
    chrome: compactChromeEvidence(meta.chrome || persisted.chrome)
  };
}

function attachPersistedCdpEvidence(payload, persisted = {}) {
  return {
    ...payload,
    ...buildPersistedCdpEvidence({ persisted })
  };
}

function normalizeRunId(runId) {
  const normalized = normalizeText(runId);
  if (!normalized || normalized.includes("/") || normalized.includes("\\")) return "";
  return normalized;
}

function getRecommendRunArtifacts(runId) {
  const normalized = normalizeRunId(runId);
  if (!normalized) return null;
  const runsDir = getRunsDir();
  const outputDir = resolveBossConfiguredOutputDir("", runsDir);
  return {
    runs_dir: runsDir,
    output_dir: outputDir,
    run_state_path: path.join(runsDir, `${normalized}.json`),
    checkpoint_path: path.join(runsDir, `${normalized}.checkpoint.json`),
    worker_stdout_path: path.join(runsDir, `${normalized}.worker.stdout.log`),
    worker_stderr_path: path.join(runsDir, `${normalized}.worker.stderr.log`),
    worker_exit_status_path: path.join(runsDir, `${normalized}.worker.exit.json`),
    candidate_result_journal_path: getCandidateResultJournalPath({
      runDir: runsDir,
      runId: normalized
    }),
    output_csv: path.join(outputDir, `${normalized}.results.csv`),
    report_json: path.join(outputDir, `${normalized}.report.json`)
  };
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function recommendSearchParamsForCsv(searchParams = {}) {
  return {
    school_tag: Object.prototype.hasOwnProperty.call(searchParams, "school_tag") ? searchParams.school_tag : "不限",
    degree: Object.prototype.hasOwnProperty.call(searchParams, "degree") ? searchParams.degree : "不限",
    gender: Object.prototype.hasOwnProperty.call(searchParams, "gender") ? searchParams.gender : "不限",
    recent_not_view: Object.prototype.hasOwnProperty.call(searchParams, "recent_not_view") ? searchParams.recent_not_view : "不限",
    current_city_only: Object.prototype.hasOwnProperty.call(searchParams, "current_city_only") ? searchParams.current_city_only : false,
    activity_level: Object.prototype.hasOwnProperty.call(searchParams, "activity_level") ? searchParams.activity_level : "不限"
  };
}

function getSnapshotRequestContext(snapshot = {}) {
  const context = plainRecord(snapshot?.context);
  const shared = plainRecord(context.shared_run_context);
  return {
    context,
    confirmation: nonEmptyRecord(context.confirmation) || plainRecord(shared.confirmation),
    overrides: nonEmptyRecord(context.overrides) || plainRecord(shared.overrides),
    followUp: context.follow_up ?? shared.follow_up ?? null,
    shared
  };
}

function selectedRecommendJobForCsv(meta = {}, snapshot = {}) {
  const { confirmation, overrides, shared } = getSnapshotRequestContext(snapshot);
  const value = normalizeText(
    meta.args?.confirmation?.job_value
    || meta.normalized?.job
    || meta.args?.overrides?.job
    || confirmation.job_value
    || overrides.job
    || shared.confirmation?.job_value
    || shared.overrides?.job
    || shared.job_label
    || ""
  );
  return {
    value,
    title: value,
    label: value
  };
}

function buildRecommendCsvInputRows(snapshot = {}, meta = {}) {
  const { context, confirmation, overrides, followUp, shared } = getSnapshotRequestContext(snapshot);
  const searchParams = recommendSearchParamsForCsv(meta.parsed?.searchParams || {
    school_tag: overrides.school_tag ?? confirmation.school_tag_value,
    degree: overrides.degree ?? confirmation.degree_value,
    gender: overrides.gender ?? confirmation.gender_value,
    recent_not_view: overrides.recent_not_view ?? confirmation.recent_not_view_value,
    current_city_only: overrides.current_city_only ?? false,
    activity_level: overrides.activity_level ?? "不限"
  });
  const parsedScreenParams = meta.parsed?.screenParams || {};
  const screenParams = {
    criteria: parsedScreenParams.criteria || meta.normalized?.criteria || overrides.criteria || "",
    target_count: parsedScreenParams.target_count || snapshot.progress?.target_count || meta.normalized?.targetCount || overrides.target_count || confirmation.target_count_value || shared.max_candidates || "",
    post_action: parsedScreenParams.post_action || overrides.post_action || confirmation.post_action_value || shared.post_action || "none",
    max_greet_count: parsedScreenParams.max_greet_count ?? overrides.max_greet_count ?? confirmation.max_greet_count_value ?? shared.max_greet_count ?? ""
  };
  return buildLegacyScreenInputRows({
    instruction: meta.args?.instruction || context.instruction || shared.instruction || "",
    selectedPage: "recommend",
    selectedJob: selectedRecommendJobForCsv(meta, snapshot),
    userSearchParams: cloneReportInput(searchParams, {}),
    effectiveSearchParams: cloneReportInput(searchParams, {}),
    screenParams,
    followUp: meta.args?.follow_up || meta.args?.overrides?.follow_up || followUp || overrides.follow_up || null
  });
}

function writeRecommendLegacyCsvAtomic(filePath, rows = [], snapshot = {}, meta = {}) {
  writeLegacyScreenCsv(filePath, {
    inputRows: buildRecommendCsvInputRows(snapshot, meta),
    results: rows
  });
}

function readRecommendRunState(runId) {
  const artifacts = getRecommendRunArtifacts(runId);
  if (!artifacts) return null;
  return readJsonFile(artifacts.run_state_path);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getRecommendRunMeta(runId) {
  return recommendRunMeta.get(runId) || {};
}

function toIsoOrNull(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function secondsBetween(startedAt, endedAt) {
  const startMs = Date.parse(startedAt || "");
  const endMs = Date.parse(endedAt || "") || Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return Math.max(1, Math.round((endMs - startMs) / 1000));
}

function normalizeLegacyProgress(progress = {}, summary = null) {
  const processed = Number.isInteger(progress.processed)
    ? progress.processed
    : Number.isInteger(summary?.processed)
      ? summary.processed
      : 0;
  const screened = Number.isInteger(progress.screened)
    ? progress.screened
    : Number.isInteger(summary?.screened)
      ? summary.screened
      : processed;
  const passed = Number.isInteger(progress.passed)
    ? progress.passed
    : Number.isInteger(summary?.passed)
      ? summary.passed
      : 0;
  const normalized = {
    ...progress,
    processed,
    inspected: processed,
    screened,
    passed,
    skipped: Number.isInteger(progress.skipped) ? progress.skipped : Math.max(processed - passed, 0),
    greet_count: Number.isInteger(progress.greet_count) ? progress.greet_count : 0,
    greet_confirmed_count: Number.isInteger(progress.greet_confirmed_count) ? progress.greet_confirmed_count : 0,
    greet_assumed_sent_count: Number.isInteger(progress.greet_assumed_sent_count) ? progress.greet_assumed_sent_count : 0,
    greet_protected_no_replay_count: Number.isInteger(progress.greet_protected_no_replay_count) ? progress.greet_protected_no_replay_count : 0,
    post_action_clicked: Number.isInteger(progress.post_action_clicked) ? progress.post_action_clicked : 0
  };
  if (Object.prototype.hasOwnProperty.call(normalized, "last_list_read_stale_diagnostic")) {
    normalized.last_list_read_stale_diagnostic = compactListReadStaleDiagnosticForStatus(
      normalized.last_list_read_stale_diagnostic
    );
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "list_read_stale_diagnostics")) {
    normalized.list_read_stale_diagnostics = compactListReadStaleDiagnosticsForStatus(
      normalized.list_read_stale_diagnostics
    );
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "dom_stale_forensic")) {
    normalized.dom_stale_forensic = compactDomStaleForensicForStatus(
      normalized.dom_stale_forensic
    );
  }
  if (Object.prototype.hasOwnProperty.call(normalized, "dom_stale_forensics")) {
    normalized.dom_stale_forensics = compactDomStaleForensicsForStatus(
      normalized.dom_stale_forensics
    );
  }
  return normalized;
}

function readRecommendWorkerExitStatus(artifacts, persisted = {}) {
  const payload = artifacts?.worker_exit_status_path
    ? readJsonFile(artifacts.worker_exit_status_path)
    : null;
  if (!payload || typeof payload !== "object") return null;
  const runId = normalizeRunId(persisted.run_id || persisted.runId);
  if (
    payload.schema_version !== 1
    || normalizeText(payload.domain).toLowerCase() !== "recommend"
    || normalizeRunId(payload.run_id) !== runId
  ) {
    return null;
  }
  const wrapperPid = Number(payload.wrapper_pid);
  const workerPid = payload.worker_pid === null ? null : Number(payload.worker_pid);
  const launchId = normalizeText(payload.launch_id);
  const expectedLaunchId = normalizeText(persisted.resume?.worker_launch_id);
  const expectedWrapperPid = Number(persisted.resume?.worker_supervisor_pid);
  const persistedPid = Number(persisted.pid);
  if (!Number.isInteger(wrapperPid) || wrapperPid <= 0) return null;
  if (workerPid !== null && (!Number.isInteger(workerPid) || workerPid <= 0)) return null;
  if (expectedLaunchId && launchId !== expectedLaunchId) return null;
  if (
    Number.isInteger(expectedWrapperPid)
    && expectedWrapperPid > 0
    && wrapperPid !== expectedWrapperPid
  ) {
    return null;
  }
  if (
    !expectedLaunchId
    && (!Number.isInteger(expectedWrapperPid) || expectedWrapperPid <= 0)
    && Number.isInteger(persistedPid)
    && persistedPid > 0
    && persistedPid !== wrapperPid
    && persistedPid !== workerPid
  ) {
    return null;
  }
  const exitCode = Number(payload.exit_code);
  const startedAt = normalizeText(payload.started_at);
  const exitedAt = normalizeText(payload.exited_at);
  const terminationKind = normalizeText(payload.termination_kind);
  const startedAtMs = Date.parse(startedAt);
  const exitedAtMs = Date.parse(exitedAt);
  if (
    !Number.isInteger(exitCode)
    || !Number.isFinite(startedAtMs)
    || !Number.isFinite(exitedAtMs)
    || exitedAtMs < startedAtMs
  ) return null;
  if (!new Set(["observed_child_exit", "wrapper_error"]).has(terminationKind)) return null;
  return {
    schema_version: 1,
    domain: "recommend",
    run_id: runId,
    launch_id: launchId || null,
    wrapper_pid: wrapperPid,
    worker_pid: workerPid,
    started_at: startedAt,
    exited_at: exitedAt,
    exit_code: exitCode,
    nonzero: payload.nonzero === true || exitCode !== 0,
    termination_kind: terminationKind,
    wrapper_error: normalizeText(payload.wrapper_error) || null,
    diagnostic_source: "windows_cim_exit_sidecar"
  };
}

const STATUS_COUNT_KEYS = [
  "processed",
  "screened",
  "detail_opened",
  "passed",
  "skipped",
  "llm_screened",
  "greet_count",
  "greet_confirmed_count",
  "greet_assumed_sent_count",
  "greet_protected_no_replay_count",
  "post_action_clicked",
  "image_capture_failed",
  "detail_open_failed",
  "transient_recovered",
  "colleague_contact_checked",
  "recent_colleague_contact_skipped",
  "colleague_contact_panel_missing",
  "context_recoveries",
  "human_rest_count",
  "human_rest_ms",
  "card_count",
  "refresh_rounds"
];

function compactPositiveInteger(value, fallback = null) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function compactSmallRecord(value, fallback = null) {
  const record = plainRecord(value);
  if (!Object.keys(record).length) return fallback;
  return clonePlain(record, fallback);
}

function compactListReadStaleDiagnosticForStatus(value) {
  const source = plainRecord(value);
  if (!Object.keys(source).length) return null;
  const compact = {};
  for (const key of [
    "name",
    "code",
    "message",
    "phase",
    "cdp_method",
    "cdp_at",
    "cdp_search_id",
    "cdp_replay_policy",
    "recovery_mode"
  ]) {
    const text = normalizeText(source[key] || "");
    if (text) compact[key] = text.slice(0, key === "message" ? 500 : 200);
  }
  for (const key of [
    "cdp_node_id",
    "cdp_backend_node_id",
    "cdp_connection_epoch",
    "cdp_reconnected_epoch",
    "attempt"
  ]) {
    if (Number.isInteger(source[key]) && source[key] >= 0) compact[key] = source[key];
  }
  for (const key of [
    "exhausted",
    "recovery_applied",
    "recovered",
    "cdp_replay_suppressed",
    "cdp_outcome_unknown",
    "cdp_reconnected",
    "cdp_replayed_after_reconnect"
  ]) {
    if (typeof source[key] === "boolean") compact[key] = source[key];
  }
  for (const key of ["at", "recovery_applied_at", "recovered_at"]) {
    const text = normalizeText(source[key] || "");
    if (text && Number.isFinite(Date.parse(text))) compact[key] = new Date(text).toISOString();
  }
  if (Array.isArray(source.cdp_param_keys)) {
    compact.cdp_param_keys = source.cdp_param_keys
      .map((key) => normalizeText(key))
      .filter((key) => /^[A-Za-z][A-Za-z0-9_]*$/.test(key))
      .slice(0, 20);
  }
  if (source.cdp_reconnect_error !== undefined && source.cdp_reconnect_error !== null) {
    const reconnectError = plainRecord(source.cdp_reconnect_error);
    if (Object.keys(reconnectError).length) {
      const safeReconnectError = {};
      for (const key of ["name", "code", "message"]) {
        const text = normalizeText(reconnectError[key] || "");
        if (text) safeReconnectError[key] = text.slice(0, key === "message" ? 500 : 200);
      }
      if (Object.keys(safeReconnectError).length) compact.cdp_reconnect_error = safeReconnectError;
    } else {
      const reconnectErrorText = normalizeText(source.cdp_reconnect_error);
      if (reconnectErrorText) compact.cdp_reconnect_error = reconnectErrorText.slice(0, 500);
    }
  }
  return Object.keys(compact).length ? compact : null;
}

function compactDomStaleRootIdentityForStatus(value) {
  const source = plainRecord(value);
  if (!Object.keys(source).length) return null;
  const compact = {};
  for (const key of [
    "connection_epoch",
    "top_document_node_id",
    "iframe_owner_node_id",
    "iframe_document_node_id"
  ]) {
    if (Number.isInteger(source[key]) && source[key] >= 0) compact[key] = source[key];
  }
  const iframeSelector = normalizeText(source.iframe_selector || "");
  if (iframeSelector) compact.iframe_selector = iframeSelector.slice(0, 300);
  return Object.keys(compact).length ? compact : null;
}

function compactDomStaleNumericRecordForStatus(value) {
  const source = plainRecord(value);
  if (!Object.keys(source).length) return null;
  const compact = {};
  for (const [key, rawValue] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9_]*$/i.test(key)) continue;
    if (!Number.isInteger(rawValue) || rawValue < 0) continue;
    compact[key] = rawValue;
    if (Object.keys(compact).length >= 30) break;
  }
  return Object.keys(compact).length ? compact : null;
}

function compactDomStaleLifecycleTimelineForStatus(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((rawEntry) => {
      const entry = plainRecord(rawEntry);
      const compact = {};
      const at = compactCdpMethodTimestamp(entry.at || "");
      if (at) compact.at = at;
      for (const key of ["type", "operation", "frame_id", "parent_frame_id", "loader_id"]) {
        const text = normalizeText(entry[key] || "");
        if (text) compact[key] = text.slice(0, 300);
      }
      if (Number.isInteger(entry.connection_epoch) && entry.connection_epoch >= 0) {
        compact.connection_epoch = entry.connection_epoch;
      }
      const url = compactChromeEvidenceUrl(entry.url);
      if (url) compact.url = url;
      return Object.keys(compact).length ? compact : null;
    })
    .filter(Boolean)
    .slice(-20);
}

function compactDomStaleCandidateForStatus(value) {
  const source = plainRecord(value);
  if (!Object.keys(source).length) return null;
  const compact = {};
  for (const key of ["index", "card_node_id", "visible_index", "failing_list_node_id"]) {
    if (Number.isInteger(source[key]) && source[key] >= 0) compact[key] = source[key];
  }
  const candidateKey = normalizeText(source.key || "");
  if (candidateKey) compact.key = candidateKey.slice(0, 300);
  return Object.keys(compact).length ? compact : null;
}

function compactDomStaleRecoveryForStatus(value) {
  const source = plainRecord(value);
  if (!Object.keys(source).length) return null;
  const compact = {};
  for (const key of ["status", "mode", "escalated_from", "method"]) {
    const text = normalizeText(source[key] || "");
    if (text) compact[key] = text.slice(0, 200);
  }
  const at = compactCdpMethodTimestamp(source.at || "");
  if (at) compact.at = at;
  if (typeof source.ok === "boolean") compact.ok = source.ok;
  if (Number.isInteger(source.card_count) && source.card_count >= 0) {
    compact.card_count = source.card_count;
  }
  const error = compactListReadStaleDiagnosticForStatus(source.error);
  if (error) compact.error = error;
  return Object.keys(compact).length ? compact : null;
}

function compactDomStaleForensicForStatus(value) {
  const source = plainRecord(value);
  if (!Object.keys(source).length) return null;
  const compact = {};
  if (Number.isInteger(source.schema_version) && source.schema_version >= 0) {
    compact.schema_version = source.schema_version;
  }
  for (const key of ["event_id", "event_type", "phase", "operation", "detail_step"]) {
    const text = normalizeText(source[key] || "");
    if (text) compact[key] = text.slice(0, key === "event_id" ? 300 : 200);
  }
  const at = compactCdpMethodTimestamp(source.at || "");
  if (at) compact.at = at;

  const candidate = compactDomStaleCandidateForStatus(source.candidate);
  if (candidate) compact.candidate = candidate;
  const error = compactListReadStaleDiagnosticForStatus(source.error);
  if (error) compact.error = error;
  const preRecoveryRoots = compactDomStaleRootIdentityForStatus(source.pre_recovery_roots);
  if (preRecoveryRoots) compact.pre_recovery_roots = preRecoveryRoots;
  const postRecoveryRoots = compactDomStaleRootIdentityForStatus(source.post_recovery_roots);
  if (postRecoveryRoots) compact.post_recovery_roots = postRecoveryRoots;
  const candidateList = compactDomStaleNumericRecordForStatus(source.candidate_list);
  if (candidateList) compact.candidate_list = candidateList;
  const counters = compactDomStaleNumericRecordForStatus(source.counters);
  if (counters) compact.counters = counters;
  const lifecycleTimeline = compactDomStaleLifecycleTimelineForStatus(source.lifecycle_timeline);
  if (lifecycleTimeline.length) compact.lifecycle_timeline = lifecycleTimeline;
  const recovery = compactDomStaleRecoveryForStatus(source.recovery);
  if (recovery) compact.recovery = recovery;
  return Object.keys(compact).length ? compact : null;
}

function compactDomStaleForensicsForStatus(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => compactDomStaleForensicForStatus(item))
    .filter(Boolean)
    .slice(-12);
}

function compactListReadStaleDiagnosticsForStatus(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => compactListReadStaleDiagnosticForStatus(item))
    .filter(Boolean)
    .slice(-12);
}

function compactListReadStaleCheckpointEvent(value) {
  const source = plainRecord(value);
  if (!Object.keys(source).length) return null;
  const compact = {};
  const diagnostic = compactListReadStaleDiagnosticForStatus(source.diagnostic || source.trigger);
  if (diagnostic) compact.diagnostic = diagnostic;
  const recentDiagnostics = compactListReadStaleDiagnosticsForStatus(source.recent_diagnostics);
  if (recentDiagnostics.length) compact.recent_diagnostics = recentDiagnostics;
  for (const key of ["recovery_count", "recovery_applied_count"]) {
    if (Number.isInteger(source[key]) && source[key] >= 0) compact[key] = source[key];
  }
  if (source.recovery_error) {
    const recoveryError = compactListReadStaleDiagnosticForStatus(source.recovery_error);
    if (recoveryError) compact.recovery_error = recoveryError;
  }
  if (source.candidate_list) {
    const candidateList = plainRecord(source.candidate_list);
    compact.candidate_list = {};
    for (const key of ["seen_count", "queued_count", "processed_count", "read_error_count", "scroll_count"]) {
      if (Number.isInteger(candidateList[key]) && candidateList[key] >= 0) {
        compact.candidate_list[key] = candidateList[key];
      }
    }
  }
  return Object.keys(compact).length ? compact : null;
}

function compactRecommendSummaryForStatus(summary) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const compact = {
    domain: normalizeText(summary.domain || "recommend") || "recommend"
  };
  for (const key of STATUS_COUNT_KEYS) {
    if (Number.isInteger(summary[key])) compact[key] = summary[key];
  }
  if (summary.target_url) compact.target_url = normalizeText(summary.target_url);
  if (summary.list_end_reason) compact.list_end_reason = normalizeText(summary.list_end_reason);
  if (Number.isInteger(summary.results_count)) {
    compact.results_count = summary.results_count;
  } else if (Array.isArray(summary.results)) {
    compact.results_count = summary.results.length;
  }
  for (const key of [
    "target_count",
    "refresh_rounds",
    "refresh_attempt_count",
    "consecutive_refresh_attempts_without_progress",
    "results_tail_limit"
  ]) {
    if (Number.isInteger(summary[key]) && summary[key] >= 0) compact[key] = summary[key];
  }
  if (summary.completion_reason) {
    compact.completion_reason = normalizeText(summary.completion_reason);
  }
  for (const key of [
    "target_reached",
    "source_exhausted",
    "source_exhaustion_verified",
    "source_unverified_underfill",
    "post_action_stopped",
    "clean_completion",
    "results_truncated",
    "refresh_attempts_truncated"
  ]) {
    if (typeof summary[key] === "boolean") compact[key] = summary[key];
  }
  if (summary.candidate_result_journal && typeof summary.candidate_result_journal === "object") {
    const journal = summary.candidate_result_journal;
    compact.candidate_result_journal = {
      journal_file: normalizeText(journal.journal_file),
      raw_record_count: Number.isInteger(journal.raw_record_count) ? journal.raw_record_count : 0,
      committed_count: Number.isInteger(journal.committed_count) ? journal.committed_count : 0,
      superseded_record_count: Number.isInteger(journal.superseded_record_count)
        ? journal.superseded_record_count
        : Number.isInteger(journal.duplicate_count)
          ? journal.duplicate_count
          : 0,
      tail_truncated: journal.tail_truncated === true
    };
  }
  if (Array.isArray(summary.refresh_attempts)) {
    compact.refresh_attempt_count = summary.refresh_attempts.length;
  }
  if (Array.isArray(summary.context_recoveries)) {
    compact.context_recovery_count = summary.context_recoveries.length;
  } else if (Number.isInteger(summary.context_recoveries)) {
    compact.context_recoveries = summary.context_recoveries;
  }
  if (summary.job_selection) compact.job_selection = compactSmallRecord(summary.job_selection);
  if (summary.page_scope) compact.page_scope = compactSmallRecord(summary.page_scope);
  if (summary.filter) compact.filter = compactSmallRecord(summary.filter);
  if (summary.candidate_list) {
    const candidateList = plainRecord(summary.candidate_list);
    compact.candidate_list = {
      total_count: compactPositiveInteger(candidateList.total_count ?? candidateList.card_count, null),
      visible_count: compactPositiveInteger(candidateList.visible_count, null),
      list_end_reason: normalizeText(candidateList.list_end_reason || "")
    };
  }
  if (summary.viewport_health?.stats) {
    compact.viewport_health = {
      stats: clonePlain(summary.viewport_health.stats, {})
    };
  }
  if (summary.human_behavior) {
    compact.human_behavior = {
      enabled: summary.human_behavior.enabled === true,
      profile: normalizeText(summary.human_behavior.profile || ""),
      restLevel: normalizeText(summary.human_behavior.restLevel || summary.human_behavior.rest_level || "")
    };
  }
  if (summary.human_rest) {
    const humanRest = plainRecord(summary.human_rest);
    compact.human_rest = {
      enabled: humanRest.enabled === true,
      restLevel: normalizeText(humanRest.restLevel || humanRest.rest_level || ""),
      rest_count: compactPositiveInteger(humanRest.rest_count ?? humanRest.count, null),
      total_pause_ms: compactPositiveInteger(humanRest.total_pause_ms ?? humanRest.pause_ms, null)
    };
  }
  for (const key of [
    "list_read_stale_recovery_attempts",
    "list_read_stale_recovery_applied",
    "list_read_stale_recoveries"
  ]) {
    if (Number.isInteger(summary[key]) && summary[key] >= 0) compact[key] = summary[key];
  }
  if (summary.last_list_read_recovery_mode) {
    compact.last_list_read_recovery_mode = normalizeText(summary.last_list_read_recovery_mode).slice(0, 100);
  }
  const lastStaleDiagnostic = compactListReadStaleDiagnosticForStatus(
    summary.last_list_read_stale_diagnostic
  );
  if (lastStaleDiagnostic) compact.last_list_read_stale_diagnostic = lastStaleDiagnostic;
  const staleDiagnostics = compactListReadStaleDiagnosticsForStatus(summary.list_read_stale_diagnostics);
  if (staleDiagnostics.length) compact.list_read_stale_diagnostics = staleDiagnostics;
  const domStaleForensic = compactDomStaleForensicForStatus(summary.dom_stale_forensic);
  if (domStaleForensic) compact.dom_stale_forensic = domStaleForensic;
  const domStaleForensics = compactDomStaleForensicsForStatus(summary.dom_stale_forensics);
  if (domStaleForensics.length) compact.dom_stale_forensics = domStaleForensics;
  return compact;
}

function compactRecommendCheckpointForStatus(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return {};
  const compact = {};
  if (checkpoint.updatedAt || checkpoint.updated_at) {
    compact.updatedAt = normalizeText(checkpoint.updatedAt || checkpoint.updated_at);
  }
  if (Number.isInteger(checkpoint.results_count)) {
    compact.results_count = checkpoint.results_count;
  } else if (Array.isArray(checkpoint.results)) {
    compact.results_count = checkpoint.results.length;
  }
  for (const key of STATUS_COUNT_KEYS) {
    if (Number.isInteger(checkpoint[key])) compact[key] = checkpoint[key];
  }
  for (const key of [
    "list_read_stale_recovery",
    "list_read_stale_recovery_applied",
    "list_read_stale_recovered",
    "list_read_stale_recovery_exhausted",
    "list_read_stale_recovery_failed"
  ]) {
    const event = compactListReadStaleCheckpointEvent(checkpoint[key]);
    if (event) compact[key] = event;
  }
  if (checkpoint.candidate_result_journal && typeof checkpoint.candidate_result_journal === "object") {
    const journal = checkpoint.candidate_result_journal;
    compact.candidate_result_journal = {
      journal_file: normalizeText(journal.journal_file),
      raw_record_count: Number.isInteger(journal.raw_record_count) ? journal.raw_record_count : 0,
      committed_count: Number.isInteger(journal.committed_count) ? journal.committed_count : 0,
      superseded_record_count: Number.isInteger(journal.superseded_record_count)
        ? journal.superseded_record_count
        : 0,
      tail_truncated: journal.tail_truncated === true
    };
  }
  const domStaleForensic = compactDomStaleForensicForStatus(checkpoint.dom_stale_forensic);
  if (domStaleForensic) compact.dom_stale_forensic = domStaleForensic;
  const domStaleForensics = compactDomStaleForensicsForStatus(checkpoint.dom_stale_forensics);
  if (domStaleForensics.length) compact.dom_stale_forensics = domStaleForensics;
  return compact;
}

function compactRecommendResultForStatus(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result || null;
  const compact = {
    ...result
  };
  if (Number.isInteger(result.results_count)) {
    compact.results_count = result.results_count;
    compact.results_available = result.results_available === true
      || result.results_count > 0
      || (Array.isArray(result.results) && result.results.length > 0);
  } else if (Array.isArray(result.results)) {
    compact.results_count = result.results.length;
    compact.results_available = result.results.length > 0;
  }
  delete compact.results;
  return compact;
}

export function compactRecommendRunForStatus(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) return run || null;
  const compact = {
    ...run
  };
  if (compact.result) compact.result = compactRecommendResultForStatus(compact.result);
  if (compact.summary) compact.summary = compactRecommendSummaryForStatus(compact.summary);
  if (compact.checkpoint) compact.checkpoint = compactRecommendCheckpointForStatus(compact.checkpoint);
  return compact;
}

function completionReason(status) {
  if (status === RUN_STATUS_COMPLETED) return "completed";
  if (status === RUN_STATUS_CANCELED) return "canceled_by_user";
  if (status === RUN_STATUS_FAILED) return "failed";
  if (status === RUN_STATUS_PAUSED) return "paused";
  return null;
}

function normalizeErrorText(error = {}) {
  return normalizeText([
    error?.code || "",
    error?.message || error || ""
  ].join(" "));
}

function classifyRecommendRecovery(error = {}) {
  const text = normalizeErrorText(error);
  if (!text) return null;
  if (/BOSS_LOGIN_REQUIRED/i.test(text)) return "login_required";
  if (/Could not find node with given id|No node with given id|Node is detached|Cannot find node|DETAIL_STALE_NODE|IMAGE_CAPTURE_STALE_NODE/i.test(text)) {
    return "transient_stale_dom";
  }
  if (/IMAGE_CAPTURE_TIMEOUT|IMAGE_CAPTURE_TOTAL_TIMEOUT|Image fallback capture timed out/i.test(text)) {
    return "transient_image_capture";
  }
  if (/RUN_PROCESS_EXITED|RUN_WORKER|DETACHED_WORKER|RECOMMEND_WORKER_EXITED/i.test(text)) {
    return "worker_process_exited";
  }
  if (/(?:aborted|abort|timeout|timed out|fetch failed|socket|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/i.test(text)) {
    return "transient_network_or_llm";
  }
  return null;
}

function isCancelShutdownError(error = {}) {
  const text = normalizeErrorText(error);
  return /socket hang up|ECONNREFUSED|ECONNRESET|WebSocket is not open|Target closed|Session closed|Connection closed|RUN_PROCESS_EXITED|DETACHED_WORKER|RUN_WORKER/i.test(text);
}

function buildConstrainedAgentRecovery(snapshot = {}, meta = {}, artifacts = null) {
  const error = snapshot?.error || snapshot?.result?.error || null;
  const classification = classifyRecommendRecovery(error);
  if (!classification) return null;
  const workerProcessExited = classification === "worker_process_exited";
  const canRestartSameRequest = classification !== "login_required" && !workerProcessExited;
  return {
    policy_version: 1,
    classification,
    safe_for_outer_ai_agent: !workerProcessExited,
    recommended_action: workerProcessExited
      ? "audit_durable_action_journals_then_start_one_reduced_target_replacement_only"
      : canRestartSameRequest
        ? "restart_same_recommend_request_only"
        : "ask_user_to_login_then_retry_same_recommend_request",
    package_requirement: "@reconcrap/boss-recommend-mcp@>=2.0.30",
    run_id: snapshot?.runId || snapshot?.run_id || null,
    retryable: true,
    automatic_restart_allowed: !workerProcessExited && canRestartSameRequest,
    requires_durable_action_journal_audit: workerProcessExited,
    resume_failed_run_in_place_allowed: false,
    same_request_sources: {
      instruction: "run.context.instruction",
      confirmation: "run.context.confirmation",
      overrides: "run.context.overrides",
      follow_up: "run.context.follow_up"
    },
    constraints: [
      ...(workerProcessExited
        ? [
            "Preserve instruction, criteria, filters, job, page_scope, and post_action exactly; change only target_count and max_greet_count to the audited remaining deficit.",
            "Set replacement target_count=max(0,cumulative_goal-exact_unique_durable_greeting_confirmed_or_assumed_sent); cap max_greet_count to that same remaining value."
          ]
        : ["Do not change instruction, criteria, filters, job, page_scope, target_count, post_action, or max_greet_count."]),
      "Do not switch to search/recruit/chat and do not add follow_up.chat.",
      "Do not summarize, translate, or rewrite criteria.",
      "Do not ask the user to reconfirm business choices unless Boss login is required or the stored context is missing.",
      "Use the same Chrome debug port and recommend page route.",
      ...(workerProcessExited ? [
        "Never replay greeting_send_in_flight, outcome_unknown, pending, or incompletely bound post-action candidates.",
        "Count exact unique durable greeting_confirmed and greeting_assumed_sent journals before computing a reduced replacement target; both are protected from replay.",
        "Do not resume this terminal failed run in place; start at most one replacement after the audit."
      ] : [])
    ],
    artifacts: artifacts ? {
      run_state_path: artifacts.run_state_path || null,
      checkpoint_path: artifacts.checkpoint_path || null,
      report_json: artifacts.report_json || null,
      output_csv: artifacts.output_csv || null
    } : null
  };
}

function recommendArtifactWriteWarning(kind, filePath, error) {
  return {
    code: "RECOMMEND_OPTIONAL_ARTIFACT_WRITE_FAILED",
    artifact: kind,
    path: filePath || null,
    message: normalizeText(error?.message || error || "optional artifact write failed")
      || "optional artifact write failed",
    retryable: true,
    occurred_at: new Date().toISOString()
  };
}

function readRecommendCandidateResultJournalForArtifacts(runId) {
  try {
    return {
      snapshot: readCandidateResultJournal({
        runDir: getRunsDir(),
        runId
      }),
      error: null
    };
  } catch (error) {
    return { snapshot: null, error };
  }
}

function writeOptionalRecommendRunArtifacts(snapshot) {
  const artifacts = getRecommendRunArtifacts(snapshot?.runId || snapshot?.run_id);
  if (!artifacts) return [];

  const warnings = [];
  const runId = snapshot?.runId || snapshot?.run_id;
  const meta = getRecommendRunMeta(snapshot?.runId || snapshot?.run_id);
  const checkpoint = snapshot?.checkpoint && typeof snapshot.checkpoint === "object"
    ? snapshot.checkpoint
    : {};
  const summary = snapshot?.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  let checkpointResults = Array.isArray(checkpoint.results) ? checkpoint.results : [];
  if (!summary && checkpointResults.length === 0 && checkpoint.candidate_result_journal) {
    const journal = readRecommendCandidateResultJournalForArtifacts(runId);
    if (journal.error) {
      warnings.push(recommendArtifactWriteWarning(
        "candidate_result_journal_read",
        artifacts.candidate_result_journal_path,
        journal.error
      ));
    } else {
      checkpointResults = journal.snapshot?.results || [];
    }
  }
  let artifactSummary = summary || (checkpointResults.length ? {
    domain: "recommend",
    partial: true,
    partial_reason: snapshot?.status || snapshot?.state || "non_terminal",
    results: checkpointResults
  } : null);
  if (summary?.candidate_result_journal) {
    const journal = readRecommendCandidateResultJournalForArtifacts(runId);
    if (journal.error) {
      warnings.push(recommendArtifactWriteWarning(
        "candidate_result_journal_read",
        artifacts.candidate_result_journal_path,
        journal.error
      ));
    } else {
      const journalResults = journal.snapshot?.results || [];
      artifactSummary = {
        ...summary,
        runtime_results_truncated: summary.results_truncated === true,
        results_count: journal.snapshot?.committed_count ?? journalResults.length,
        results_truncated: false,
        results: journalResults
      };
    }
  }
  if (!artifactSummary) return warnings;

  const rows = Array.isArray(artifactSummary.results) ? artifactSummary.results : [];
  try {
    writeRecommendLegacyCsvAtomic(artifacts.output_csv, rows, snapshot, meta);
    if (meta) meta.outputCsvPath = artifacts.output_csv;
  } catch (error) {
    warnings.push(recommendArtifactWriteWarning("results_csv", artifacts.output_csv, error));
  }
  try {
    writeJsonAtomic(artifacts.report_json, {
      run_id: snapshot.runId || snapshot.run_id,
      status: snapshot.status || snapshot.state,
      phase: snapshot.phase || snapshot.stage,
      progress: snapshot.progress || {},
      context: snapshot.context || {},
      checkpoint,
      error: snapshot.error || null,
      last_message: snapshot.error?.message || snapshot.phase || snapshot.stage || null,
      recovery: buildConstrainedAgentRecovery(snapshot, meta, artifacts),
      summary: artifactSummary,
      generated_at: new Date().toISOString()
    });
    if (meta) meta.reportJsonPath = artifacts.report_json;
  } catch (error) {
    warnings.push(recommendArtifactWriteWarning("report_json", artifacts.report_json, error));
  }
  return warnings;
}

function persistRecommendCheckpointSnapshot(normalized) {
  const artifacts = getRecommendRunArtifacts(normalized?.run_id || normalized?.runId);
  if (!artifacts) return;
  const checkpoint = normalized?.checkpoint && typeof normalized.checkpoint === "object"
    ? normalized.checkpoint
    : {};
  writeJsonAtomic(artifacts.checkpoint_path, checkpoint);
  const meta = getRecommendRunMeta(normalized?.run_id || normalized?.runId);
  if (meta) meta.checkpointPath = artifacts.checkpoint_path;
}

function buildLegacyRecommendResult(snapshot) {
  if (!snapshot) return null;
  const artifacts = getRecommendRunArtifacts(snapshot.runId || snapshot.run_id);
  const meta = getRecommendRunMeta(snapshot.runId);
  const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const checkpoint = snapshot.checkpoint && typeof snapshot.checkpoint === "object" ? snapshot.checkpoint : {};
  let resultRows = Array.isArray(summary?.results)
    ? summary.results
    : Array.isArray(checkpoint.results)
      ? checkpoint.results
      : [];
  if (resultRows.length === 0 && checkpoint.candidate_result_journal) {
    resultRows = readRecommendCandidateResultJournalForArtifacts(snapshot.runId).snapshot?.results || [];
  }
  const progress = normalizeLegacyProgress(snapshot.progress, summary);
  const targetCount = Number.isInteger(progress.target_count)
    ? progress.target_count
    : Number.isInteger(snapshot.context?.max_candidates)
      ? snapshot.context.max_candidates
      : meta.parsed?.screenParams?.target_count || null;
  return {
    status: snapshot.status === RUN_STATUS_COMPLETED
      ? "COMPLETED"
      : snapshot.status === RUN_STATUS_CANCELED
        ? "CANCELED"
        : snapshot.status === RUN_STATUS_PAUSED
          ? "PAUSED"
          : snapshot.status === RUN_STATUS_FAILED
            ? "FAILED"
            : snapshot.status,
    run_id: snapshot.runId,
    completion_reason: normalizeText(summary?.completion_reason || "") || completionReason(snapshot.status),
    lifecycle_completion_reason: completionReason(snapshot.status),
    target_reached: summary?.target_reached === true,
    source_exhausted: summary?.source_exhausted === true,
    source_exhaustion_verified: summary?.source_exhaustion_verified === true,
    source_unverified_underfill: summary?.source_unverified_underfill === true,
    post_action_stopped: summary?.post_action_stopped === true,
    clean_completion: summary?.clean_completion === true,
    requested_count: targetCount,
    processed_count: progress.processed,
    inspected_count: progress.processed,
    screened_count: progress.screened,
    passed_count: progress.passed,
    skipped_count: progress.skipped,
    detail_opened: progress.detail_opened || summary?.detail_opened || 0,
    greet_count: progress.greet_count || 0,
    greet_confirmed_count: progress.greet_confirmed_count || summary?.greet_confirmed_count || 0,
    greet_assumed_sent_count: progress.greet_assumed_sent_count || summary?.greet_assumed_sent_count || 0,
    greet_protected_no_replay_count: progress.greet_protected_no_replay_count || summary?.greet_protected_no_replay_count || 0,
    post_action_clicked: progress.post_action_clicked || summary?.post_action_clicked || 0,
    output_csv: artifacts?.output_csv || meta.outputCsvPath || null,
    report_json: artifacts?.report_json || meta.reportJsonPath || null,
    checkpoint_path: artifacts?.checkpoint_path || meta.checkpointPath || null,
    started_at: snapshot.startedAt,
    completed_at: snapshot.completedAt || null,
    duration_sec: secondsBetween(snapshot.startedAt, snapshot.completedAt),
    selected_job: {
      title: meta.normalized?.job || meta.args?.confirmation?.job_value || meta.args?.overrides?.job || ""
    },
    selected_page_scope: summary?.page_scope || {
      requested_scope: meta.normalized?.pageScope || meta.parsed?.page_scope || "recommend",
      effective_scope: meta.normalized?.pageScope || meta.parsed?.page_scope || "recommend"
    },
    search_params: clonePlain(meta.parsed?.searchParams || {}, {}),
    screen_params: clonePlain(meta.parsed?.screenParams || {}, {}),
    target_count_semantics: TARGET_COUNT_SEMANTICS,
    error: snapshot.error || null,
    recovery: buildConstrainedAgentRecovery(snapshot, meta, artifacts),
    results_count: Number.isInteger(summary?.results_count)
      ? summary.results_count
      : resultRows.length,
    results_available: resultRows.length > 0
  };
}

function normalizeRunSnapshot(snapshot) {
  if (!snapshot) return null;
  const meta = getRecommendRunMeta(snapshot.runId);
  const artifacts = getRecommendRunArtifacts(snapshot.runId);
  const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : null;
  const progress = normalizeLegacyProgress(snapshot.progress, summary);
  const legacyResult = (
    TERMINAL_STATUSES.has(snapshot.status)
    || snapshot.status === RUN_STATUS_PAUSED
  ) ? buildLegacyRecommendResult({ ...snapshot, progress }) : null;
  const recovery = nonEmptyRecord({
    ...plainRecord(snapshot.recovery),
    ...plainRecord(buildConstrainedAgentRecovery(snapshot, meta, artifacts))
  });
  const snapshotContext = plainRecord(snapshot.context);
  const metaArgs = plainRecord(meta.args);
  const oldContext = {
    workspace_root: meta.workspaceRoot || snapshotContext.workspace_root || null,
    instruction: metaArgs.instruction || snapshotContext.instruction || "",
    confirmation: clonePlain(metaArgs.confirmation ?? snapshotContext.confirmation ?? {}, {}),
    overrides: clonePlain(metaArgs.overrides ?? snapshotContext.overrides ?? {}, {}),
    follow_up: clonePlain(metaArgs.follow_up ?? snapshotContext.follow_up ?? null, null),
    target_count_semantics: TARGET_COUNT_SEMANTICS
  };
  return {
    ...snapshot,
    checkpoint: compactRecommendCheckpointForStatus(snapshot.checkpoint),
    summary: compactRecommendSummaryForStatus(summary),
    progress,
    run_id: snapshot.runId,
    mode: RUN_MODE_ASYNC,
    state: snapshot.status,
    stage: snapshot.phase,
    started_at: snapshot.startedAt,
    updated_at: snapshot.updatedAt,
    completed_at: toIsoOrNull(snapshot.completedAt),
    heartbeat_at: toIsoOrNull(snapshot.heartbeatAt || snapshot.heartbeat_at || snapshot.updatedAt),
    pid: Number.isInteger(snapshot.pid) && snapshot.pid > 0 ? snapshot.pid : process.pid || null,
    last_message: snapshot.error?.message || snapshot.phase || null,
    context: {
      ...snapshotContext,
      ...oldContext,
      shared_run_context: snapshotContext
    },
    control: {
      pause_requested: snapshot.status === RUN_STATUS_PAUSED,
      pause_requested_at: snapshot.status === RUN_STATUS_PAUSED ? snapshot.updatedAt : null,
      pause_requested_by: snapshot.status === RUN_STATUS_PAUSED ? "pause_recommend_pipeline_run" : null,
      cancel_requested: snapshot.status === RUN_STATUS_CANCELING
    },
    resume: {
      ...plainRecord(snapshot.resume),
      checkpoint_path: legacyResult?.checkpoint_path || meta.checkpointPath || artifacts?.checkpoint_path || null,
      pause_control_path: artifacts?.run_state_path || null,
      output_csv: legacyResult?.output_csv || null,
      worker_stdout_path: artifacts?.worker_stdout_path || null,
      worker_stderr_path: artifacts?.worker_stderr_path || null,
      worker_exit_status_path: artifacts?.worker_exit_status_path || null,
      resume_count: meta.resumeCount || 0,
      last_resumed_at: meta.lastResumedAt || null,
      last_paused_at: snapshot.status === RUN_STATUS_PAUSED ? snapshot.updatedAt : null
    },
    recovery,
    result: legacyResult,
    artifacts
  };
}

function mergePersistedControlRequest(normalized, existing) {
  const control = {
    ...(normalized?.control || {})
  };
  const existingControl = plainRecord(existing?.control);
  if (!normalized) return control;
  if (TERMINAL_STATUSES.has(normalized.state)) {
    if (
      normalized.state === RUN_STATUS_FAILED
      && existingControl.cancel_requested === true
      && isCancelShutdownError(normalized.error || normalized.result?.error || "")
    ) {
      return {
        ...control,
        pause_requested: true,
        pause_requested_at: existingControl.pause_requested_at || control.pause_requested_at || new Date().toISOString(),
        pause_requested_by: existingControl.pause_requested_by || control.pause_requested_by || "cancel_recommend_pipeline_run",
        cancel_requested: true
      };
    }
    return control;
  }
  if (existingControl.cancel_requested === true) {
    return {
      ...control,
      pause_requested: true,
      pause_requested_at: existingControl.pause_requested_at || control.pause_requested_at || new Date().toISOString(),
      pause_requested_by: existingControl.pause_requested_by || control.pause_requested_by || "cancel_recommend_pipeline_run",
      cancel_requested: true
    };
  }
  if (existingControl.pause_requested === true && normalized.state !== RUN_STATUS_PAUSED) {
    return {
      ...control,
      pause_requested: true,
      pause_requested_at: existingControl.pause_requested_at || control.pause_requested_at || new Date().toISOString(),
      pause_requested_by: existingControl.pause_requested_by || control.pause_requested_by || "pause_recommend_pipeline_run"
    };
  }
  if (existingControl.pause_requested === false && normalized.state === RUN_STATUS_PAUSED) {
    return {
      ...control,
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    };
  }
  return control;
}

function cancelErrorFromShutdown(shutdownError = null) {
  return {
    code: "PIPELINE_CANCELED",
    message: "流水线已取消。",
    retryable: true,
    shutdown_error: shutdownError || undefined
  };
}

function coerceCanceledTerminalSnapshot(normalized, existing) {
  const existingControl = plainRecord(existing?.control);
  const shutdownError = normalized?.error || normalized?.result?.error || null;
  const shouldWrapCanceledShutdown = (
    normalized
    && (
      (
        normalized.state === RUN_STATUS_FAILED
        && existingControl.cancel_requested === true
      )
      || normalized.state === RUN_STATUS_CANCELED
    )
    && isCancelShutdownError(shutdownError || "")
  );
  if (
    !shouldWrapCanceledShutdown
  ) {
    return normalized;
  }
  const canceledError = cancelErrorFromShutdown(shutdownError);
  return {
    ...normalized,
    state: RUN_STATUS_CANCELED,
    status: RUN_STATUS_CANCELED,
    last_message: "流水线已取消；取消收尾时浏览器连接已关闭。",
    control: {
      pause_requested: false,
      pause_requested_at: null,
      pause_requested_by: null,
      cancel_requested: false
    },
    error: canceledError,
    result: normalized.result ? {
      ...normalized.result,
      status: "CANCELED",
      completion_reason: "canceled_by_user",
      error: canceledError
    } : {
      status: "CANCELED",
      completion_reason: "canceled_by_user",
      error: canceledError,
      run_id: normalized.run_id,
      processed_count: normalized.progress?.processed || 0,
      screened_count: normalized.progress?.screened || normalized.progress?.processed || 0,
      passed_count: normalized.progress?.passed || 0
    }
  };
}

function persistRecommendRunSnapshot(snapshot, {
  persistActiveCheckpoint = false
} = {}) {
  let normalized = normalizeRunSnapshot(snapshot);
  if (!normalized?.run_id) return normalized;
  const artifacts = getRecommendRunArtifacts(normalized.run_id);
  if (!artifacts) return normalized;
  const existing = readJsonFile(artifacts.run_state_path);
  normalized.resume = {
    ...plainRecord(existing?.resume),
    ...plainRecord(normalized.resume)
  };
  normalized.control = mergePersistedControlRequest(normalized, existing);
  normalized = coerceCanceledTerminalSnapshot(normalized, existing);
  const shouldPersistCheckpoint = persistActiveCheckpoint
    || TERMINAL_STATUSES.has(normalized.state)
    || normalized.state === RUN_STATUS_PAUSED;
  if (shouldPersistCheckpoint) {
    persistRecommendCheckpointSnapshot(snapshot);
  }
  const cdpEvidence = buildPersistedCdpEvidence({
    meta: getRecommendRunMeta(normalized.run_id),
    persisted: existing || {}
  });
  const existingArtifactWarnings = Array.isArray(existing?.artifact_warnings)
    ? existing.artifact_warnings
    : [];
  const withArtifactWarnings = (value, warnings) => ({
    ...value,
    artifact_warnings: warnings,
    artifacts: {
      ...plainRecord(value.artifacts),
      warnings
    }
  });
  const buildPayload = (value) => ({
    run_id: value.run_id,
    mode: value.mode,
    state: value.state,
    status: value.status,
    stage: value.stage,
    started_at: value.started_at,
    updated_at: value.updated_at,
    heartbeat_at: value.heartbeat_at,
    completed_at: value.completed_at,
    pid: value.pid,
    progress: value.progress,
    last_message: value.last_message,
    context: value.context,
    control: value.control,
    resume: value.resume,
    error: value.error,
    recovery: value.recovery,
    result: value.result,
    summary: value.summary,
    checkpoint: value.checkpoint,
    artifact_warnings: value.artifact_warnings,
    artifacts: value.artifacts,
    ...cdpEvidence
  });
  normalized = withArtifactWarnings(normalized, existingArtifactWarnings);
  writeJsonAtomic(artifacts.run_state_path, buildPayload(normalized));

  if (TERMINAL_STATUSES.has(normalized.state) || normalized.state === RUN_STATUS_PAUSED) {
    let artifactWarnings;
    try {
      artifactWarnings = writeOptionalRecommendRunArtifacts(snapshot);
    } catch (error) {
      artifactWarnings = [recommendArtifactWriteWarning(
        "artifact_generation",
        null,
        error
      )];
    }
    normalized = withArtifactWarnings(normalized, artifactWarnings);
    if (JSON.stringify(artifactWarnings) !== JSON.stringify(existingArtifactWarnings)) {
      try {
        writeJsonAtomic(artifacts.run_state_path, buildPayload(normalized));
      } catch (error) {
        normalized = withArtifactWarnings(normalized, [
          ...artifactWarnings,
          recommendArtifactWriteWarning("artifact_warning_state", artifacts.run_state_path, error)
        ]);
      }
    }
  }
  return normalized;
}

function patchPersistedRecommendRunControl(runId, controlPatch = {}, {
  message = ""
} = {}) {
  const artifacts = getRecommendRunArtifacts(runId);
  if (!artifacts) return null;
  const current = readJsonFile(artifacts.run_state_path);
  const state = normalizeText(current?.state || current?.status || "");
  if (!current || TERMINAL_STATUSES.has(state)) return null;
  const now = new Date().toISOString();
  const patched = {
    ...current,
    updated_at: now,
    heartbeat_at: current.heartbeat_at || now,
    last_message: message || current.last_message || "",
    control: {
      ...(current.control || {}),
      ...controlPatch
    }
  };
  writeJsonAtomic(artifacts.run_state_path, patched);
  return patched;
}

function reconcilePersistedRecommendRunIfNeeded(persisted) {
  if (!persisted || typeof persisted !== "object") return persisted;
  const persistedState = normalizeText(persisted.state || persisted.status);
  if (TERMINAL_STATUSES.has(persistedState)) return persisted;

  const runId = normalizeRunId(persisted.run_id || persisted.runId);
  const artifacts = getRecommendRunArtifacts(runId);
  const exitStatus = readRecommendWorkerExitStatus(artifacts, persisted);
  if (!exitStatus && isProcessAlive(persisted.pid)) return persisted;
  const checkpoint = artifacts?.checkpoint_path ? readJsonFile(artifacts.checkpoint_path) : null;
  const now = new Date().toISOString();
  const cancelRequested = persisted.control?.cancel_requested === true;
  const processExitedError = exitStatus
    ? {
        code: exitStatus.nonzero ? "RECOMMEND_WORKER_EXITED_NONZERO" : "RECOMMEND_WORKER_EXITED_EARLY",
        message: exitStatus.wrapper_error
          ? `Recommend worker supervisor failed: ${exitStatus.wrapper_error}`
          : `Recommend worker exited before writing a terminal state (exit_code=${exitStatus.exit_code}).`,
        retryable: true,
        worker_exit_code: exitStatus.exit_code,
        worker_launch_id: exitStatus.launch_id,
        worker_pid: exitStatus.worker_pid,
        supervisor_pid: exitStatus.wrapper_pid,
        worker_exited_at: exitStatus.exited_at,
        termination_kind: exitStatus.termination_kind,
        diagnostic_source: exitStatus.diagnostic_source
      }
    : {
        code: "RUN_PROCESS_EXITED",
        message: `检测到推荐任务进程已退出（pid=${persisted.pid || "unknown"}）。`,
        retryable: true,
        diagnostic_source: "pid_reconciliation"
      };
  const error = cancelRequested
    ? cancelErrorFromShutdown(processExitedError)
    : {
        ...processExitedError,
        message: exitStatus
          ? `${processExitedError.message} 已自动标记为失败。`
          : `检测到推荐任务进程已退出（pid=${persisted.pid || "unknown"}），已自动标记为失败。`
      };
  const workerLastHeartbeatAt = normalizeText(
    persisted.recovery?.worker_last_heartbeat_at
    || persisted.heartbeat_at
    || ""
  ) || null;
  return persistRecommendRunSnapshot({
    runId,
    name: persisted.name || runId,
    status: cancelRequested ? RUN_STATUS_CANCELED : RUN_STATUS_FAILED,
    phase: persisted.stage || persisted.phase || "recommend:orphaned",
    progress: persisted.progress || {},
    context: persisted.context || {},
    checkpoint: checkpoint || persisted.checkpoint || {},
    startedAt: persisted.started_at || persisted.startedAt || now,
    updatedAt: now,
    heartbeatAt: workerLastHeartbeatAt || now,
    completedAt: now,
    pid: Number.isInteger(persisted.pid) && persisted.pid > 0 ? persisted.pid : null,
    resume: persisted.resume || {},
    error,
    recovery: {
      ...plainRecord(persisted.recovery),
      worker_last_heartbeat_at: workerLastHeartbeatAt,
      reconciled_at: now,
      reconciliation_reason: error.code,
      automatic_restart_allowed: false,
      requires_durable_action_journal_audit: !cancelRequested
    },
    summary: persisted.summary || null
  });
}

function persistRecommendLifecycleSnapshot(snapshot, event = {}) {
  return persistRecommendRunSnapshot(snapshot, {
    persistActiveCheckpoint: event?.type === "checkpoint"
  });
}

function attachMethodEvidence(payload, runId) {
  const meta = getRecommendRunMeta(runId);
  const methodLog = meta.methodLog || [];
  assertNoForbiddenCdpCalls(methodLog);
  return {
    ...payload,
    ...buildPersistedCdpEvidence({
      meta,
      persisted: readRecommendRunState(runId) || {}
    })
  };
}

function compactRecommendJobListOption(option, index) {
  const label = normalizeText(option?.label);
  const name = normalizeText(option?.label_without_salary || label);
  return {
    index,
    name,
    label,
    label_without_salary: name,
    current: Boolean(option?.current),
    visible: Boolean(option?.visible)
  };
}

async function readRecommendJobOptionsFromSession(session) {
  const client = session?.client;
  if (!client) throw new Error("Recommend Chrome session is missing a CDP client");
  const rootState = await getRecommendRoots(client);
  const frameNodeId = rootState?.iframe?.documentNodeId;
  if (!frameNodeId) throw new Error("recommendFrame iframe document was not found");

  let options = [];
  try {
    options = await listRecommendJobOptions(client, frameNodeId, {
      openDropdown: true
    });
  } finally {
    await closeRecommendJobDropdown(client).catch(() => {});
  }

  const compacted = [];
  const seen = new Set();
  for (const option of options) {
    const compact = compactRecommendJobListOption(option, compacted.length);
    if (!compact.name && !compact.label) continue;
    const key = `${compact.name}\n${compact.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push(compact);
  }

  return {
    source: "recommend_job_dropdown",
    selector: "recommend job selection dropdown",
    job_options: compacted,
    selected_job: compacted.find((option) => option.current) || null
  };
}

export async function listRecommendJobsTool({ workspaceRoot = "", args = {} } = {}) {
  const routeGuard = guardRecommendRoute(args);
  if (routeGuard) {
    return {
      ...routeGuard,
      stage: "recommend_job_list",
      message: "list_recommend_jobs is recommend-page only. For chat-only job lists, call list_boss_chat_jobs or prepare_boss_chat_run."
    };
  }
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const host = normalizeText(args.host) || DEFAULT_RECOMMEND_HOST;
  const port = parsePositiveInteger(
    args.port,
    configResolution.ok ? configResolution.config.debugPort : DEFAULT_RECOMMEND_PORT
  );
  const targetUrlIncludes = normalizeText(args.target_url_includes) || RECOMMEND_TARGET_URL;
  const allowNavigate = args.allow_navigate !== false;
  const slowLive = args.slow_live === true;
  let session;

  try {
    session = await recommendConnectorImpl({
      host,
      port,
      targetUrlIncludes,
      allowNavigate,
      slowLive
    });

    const jobs = await recommendJobReaderImpl(session, {
      workspaceRoot: normalizeText(workspaceRoot) || process.cwd(),
      args: clonePlain(args, {}),
      normalized: {
        host,
        port,
        targetUrlIncludes,
        allowNavigate,
        slowLive
      }
    });
    const jobOptions = Array.isArray(jobs?.job_options) ? jobs.job_options : [];
    assertNoForbiddenCdpCalls(session.methodLog || []);
    return {
      status: "OK",
      stage: "recommend_job_list",
      cdp_only: true,
      runtime_evaluate_used: false,
      page_url: session.navigation?.url || session.target?.url || RECOMMEND_TARGET_URL,
      job_count: jobOptions.length,
      job_names: jobOptions.map((option) => option.name || option.label).filter(Boolean),
      job_full_labels: jobOptions.map((option) => option.label || option.name).filter(Boolean),
      job_options: jobOptions,
      selected_job: jobs?.selected_job || jobOptions.find((option) => option.current) || null,
      source: jobs?.source || "recommend_job_dropdown",
      selector: jobs?.selector || "",
      message: "已通过 CDP-only 从推荐页岗位下拉框读取可用岗位。Cron/一次性任务里的 job 参数优先使用 job_names 中的完整岗位名。",
      chrome: {
        host,
        port,
        target_url: session.navigation?.url || session.target?.url || RECOMMEND_TARGET_URL,
        target_id: session.target?.id || null,
        auto_launch: session.chrome || null
      },
      method_summary: methodSummary(session.methodLog || []),
      method_log: session.methodLog || []
    };
  } catch (error) {
    const methodLog = session?.methodLog || [];
    const loginRequired = error?.code === "BOSS_LOGIN_REQUIRED";
    return {
      status: "FAILED",
      stage: "recommend_job_list",
      cdp_only: true,
      runtime_evaluate_used: methodLog.some((entry) => String(entry?.method || entry).startsWith("Runtime.")),
      error: {
        code: loginRequired ? "BOSS_LOGIN_REQUIRED" : "RECOMMEND_JOB_LIST_FAILED",
        message: error?.message || "Failed to read recommend job list",
        requires_login: Boolean(error?.requires_login),
        login_url: error?.login_url || null,
        login_detection: error?.login_detection || null,
        current_url: error?.current_url || null,
        target_url: error?.target_url || RECOMMEND_TARGET_URL,
        chrome: error?.chrome || null,
        retryable: true
      },
      chrome: {
        host,
        port,
        target_url: targetUrlIncludes,
        auto_launch: error?.chrome || session?.chrome || null
      },
      method_summary: methodSummary(methodLog),
      method_log: methodLog
    };
  } finally {
    if (session) {
      try {
        await session.close?.();
      } catch {
        // Best-effort cleanup after a read-only helper.
      }
    }
  }
}

function compactHealth(check) {
  if (!check) return null;
  return {
    status: check.status,
    summary: check.summary,
    drift_report: check.drift_report,
    empty_bootstrap_refresh: check.empty_bootstrap_refresh || null,
    accepted_empty_bootstrap: check.accepted_empty_bootstrap || null,
    probes: (check.probes || []).map((probe) => ({
      id: probe.id,
      type: probe.type,
      status: probe.status,
      count: probe.count,
      required: probe.required
    }))
  };
}

function hasOnlyCandidateCardsRequiredFailure(check) {
  const failedRequiredIds = Array.isArray(check?.summary?.failed_required_ids)
    ? check.summary.failed_required_ids
    : [];
  const blockedRequiredIds = Array.isArray(check?.summary?.blocked_required_ids)
    ? check.summary.blocked_required_ids
    : [];
  return check?.status === HEALTH_STATUS.DEGRADED
    && failedRequiredIds.length === 1
    && failedRequiredIds[0] === "candidate_cards"
    && blockedRequiredIds.length === 0;
}

function compactRecommendEmptyStateEvidence(emptyState) {
  if (!emptyState) return null;
  return {
    verified: emptyState.verified === true,
    reason: emptyState.reason || null,
    text: emptyState.text || null,
    node_id: emptyState.node_id ?? null,
    box: emptyState.box || null,
    accessibility: emptyState.accessibility ? {
      available: emptyState.accessibility.available ?? null,
      verified: emptyState.accessibility.verified === true,
      reason: emptyState.accessibility.reason || null
    } : null
  };
}

function hasExactRecommendFilteredEmptyState(emptyState) {
  return emptyState?.verified === true
    && emptyState?.reason === "exact_visible_filtered_empty_state"
    && emptyState?.accessibility?.verified === true;
}

function attachRecommendEmptyBootstrapRefreshEvidence(check, refreshEvidence, emptyState = null) {
  if (!check || refreshEvidence?.attempted !== true) return check;
  return {
    ...check,
    empty_bootstrap_refresh: {
      ...refreshEvidence,
      after: {
        health: compactHealth(check),
        empty_state: compactRecommendEmptyStateEvidence(emptyState)
      }
    }
  };
}

export function getRecommendEmptyBootstrapPreflightAction(
  check,
  emptyState = null,
  refreshEvidence = null
) {
  if (check?.status === HEALTH_STATUS.HEALTHY) return "accept_healthy";
  if (!hasOnlyCandidateCardsRequiredFailure(check)) return "wait";
  if (!hasExactRecommendFilteredEmptyState(emptyState)) return "wait";
  if (refreshEvidence?.attempted !== true) return "refresh";
  if (
    refreshEvidence.completed !== true
    || refreshEvidence.ok !== true
    || refreshEvidence.method !== "Page.navigate"
    || refreshEvidence.target_url !== RECOMMEND_TARGET_URL
  ) return "wait";
  return "accept_empty_bootstrap";
}

export function acceptRecommendEmptyBootstrapHealth(check, emptyState, refreshEvidence = null) {
  if (
    getRecommendEmptyBootstrapPreflightAction(check, emptyState, refreshEvidence)
      !== "accept_empty_bootstrap"
  ) return null;

  const healthWithRefresh = attachRecommendEmptyBootstrapRefreshEvidence(
    check,
    refreshEvidence,
    emptyState
  );
  return {
    ...healthWithRefresh,
    accepted_empty_bootstrap: {
      accepted: true,
      mode: "exact_filtered_empty_bootstrap",
      reason: emptyState.reason,
      original_health_status: check.status,
      failed_required_ids: [...check.summary.failed_required_ids],
      blocked_required_ids: [...check.summary.blocked_required_ids],
      root: "frame",
      empty_state: compactRecommendEmptyStateEvidence(emptyState),
      refresh: healthWithRefresh.empty_bootstrap_refresh
    }
  };
}

export function isRecommendConnectorHealthAccepted(health) {
  if (health?.status === HEALTH_STATUS.HEALTHY) return true;
  const accepted = health?.accepted_empty_bootstrap;
  return accepted?.accepted === true
    && accepted.mode === "exact_filtered_empty_bootstrap"
    && accepted.original_health_status === HEALTH_STATUS.DEGRADED
    && getRecommendEmptyBootstrapPreflightAction(
      health,
      accepted.empty_state,
      health.empty_bootstrap_refresh
    ) === "accept_empty_bootstrap";
}

async function waitForHealthyRecommend(client, config, {
  timeoutMs = 90000,
  intervalMs = 1000,
  refreshSettleMs = 5000,
  refreshNavigationTimeoutMs = 20000
} = {}) {
  const started = Date.now();
  let lastCheck = null;
  let refreshEvidence = null;
  while (Date.now() - started <= timeoutMs) {
    const loginDetection = await detectBossLoginState(client).catch(() => null);
    if (loginDetection?.requires_login) {
      return attachRecommendEmptyBootstrapRefreshEvidence({
        status: "login_required",
        summary: "Boss login is required",
        loginDetection
      }, refreshEvidence);
    }
    const roots = await resolveRecommendSelfHealRoots(client, config);
    lastCheck = await runSelfHealCheck({
      client,
      domain: "recommend",
      roots: roots.roots,
      selectorProbes: config.selectorProbes,
      accessibilityProbes: config.accessibilityProbes,
      viewportProbes: config.viewportProbes
    });
    if (lastCheck.status === HEALTH_STATUS.HEALTHY) {
      return attachRecommendEmptyBootstrapRefreshEvidence(lastCheck, refreshEvidence);
    }
    let emptyState = null;
    if (hasOnlyCandidateCardsRequiredFailure(lastCheck) && roots.roots.frame) {
      emptyState = await inspectRecommendFilteredEmptyState(
        client,
        roots.roots.frame
      ).catch((error) => ({
        verified: false,
        reason: "filtered_empty_state_probe_failed",
        error: error?.message || String(error)
      }));
    }
    const action = getRecommendEmptyBootstrapPreflightAction(
      lastCheck,
      emptyState,
      refreshEvidence
    );
    if (action === "refresh") {
      const refreshStarted = Date.now();
      refreshEvidence = {
        attempted: true,
        completed: false,
        ok: false,
        method: "Page.navigate",
        target_url: RECOMMEND_TARGET_URL,
        before: {
          health: compactHealth(lastCheck),
          empty_state: compactRecommendEmptyStateEvidence(emptyState)
        }
      };
      try {
        const navigationResult = await client.Page.navigate({ url: RECOMMEND_TARGET_URL });
        if (navigationResult?.errorText) {
          throw new Error(navigationResult.errorText);
        }
        const waited = await waitForMainFrameUrl(
          client,
          (url) => isBossLoginUrl(url) || !shouldNavigateToRecommend(url),
          {
            timeoutMs: refreshNavigationTimeoutMs,
            intervalMs: Math.max(250, Math.min(1000, intervalMs))
          }
        );
        if (refreshSettleMs > 0) await sleep(refreshSettleMs);
        refreshEvidence = {
          ...refreshEvidence,
          completed: true,
          ok: waited?.ok === true,
          navigation: {
            frame_id: navigationResult?.frameId || null,
            loader_id: navigationResult?.loaderId || null,
            observed_url: waited?.url || null,
            observed_url_ok: waited?.ok === true
          },
          elapsed_ms: Date.now() - refreshStarted
        };
      } catch (error) {
        refreshEvidence = {
          ...refreshEvidence,
          completed: true,
          ok: false,
          error: error?.message || String(error),
          elapsed_ms: Date.now() - refreshStarted
        };
      }
      continue;
    }
    if (action === "accept_empty_bootstrap") {
      const accepted = acceptRecommendEmptyBootstrapHealth(
        lastCheck,
        emptyState,
        refreshEvidence
      );
      if (accepted) return accepted;
    }
    await sleep(intervalMs);
  }
  return attachRecommendEmptyBootstrapRefreshEvidence(lastCheck, refreshEvidence);
}

function shouldNavigateToRecommend(url) {
  return !String(url || "").includes("/web/chat/recommend");
}

async function connectRecommendChromeSession({
  host = DEFAULT_RECOMMEND_HOST,
  port = DEFAULT_RECOMMEND_PORT,
  targetUrlIncludes = RECOMMEND_TARGET_URL,
  allowNavigate = true,
  slowLive = false
} = {}) {
  const session = await connectToChromeTargetOrOpen({
    host,
    port,
    targetUrlIncludes,
    targetUrl: RECOMMEND_TARGET_URL,
    allowNavigate,
    slowLive,
    fallbackTargetPredicate: (target) => (
      target?.type === "page"
      && String(target?.url || "").includes("zhipin.com")
    )
  });

  const { client, target } = session;
  await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
  if (typeof client?.Network?.setCacheDisabled === "function") {
    await client.Network.setCacheDisabled({ cacheDisabled: true });
  }
  await bringPageToFront(client);

  const targetUrl = String(target?.url || "");
  let navigation = {
    navigated: false,
    url: targetUrl
  };
  if (allowNavigate && shouldNavigateToRecommend(targetUrl)) {
    await client.Page.navigate({ url: RECOMMEND_TARGET_URL });
    const settleMs = slowLive ? 12000 : 5000;
    const waited = await waitForMainFrameUrl(
      client,
      (url) => isBossLoginUrl(url) || !shouldNavigateToRecommend(url),
      { timeoutMs: settleMs, intervalMs: 500 }
    );
    navigation = {
      navigated: true,
      url: RECOMMEND_TARGET_URL,
      settle_ms: settleMs,
      observed_url: waited.url || null,
      observed_url_ok: waited.ok
    };
  }
  let currentUrl = await getMainFrameUrl(client).catch(() => navigation.url || targetUrl);
  if (allowNavigate && shouldNavigateToRecommend(currentUrl) && !isBossLoginUrl(currentUrl)) {
    await client.Page.navigate({ url: RECOMMEND_TARGET_URL });
    const settleMs = slowLive ? 12000 : 5000;
    const waited = await waitForMainFrameUrl(
      client,
      (url) => isBossLoginUrl(url) || !shouldNavigateToRecommend(url),
      { timeoutMs: settleMs, intervalMs: 500 }
    );
    navigation = {
      navigated: true,
      url: RECOMMEND_TARGET_URL,
      settle_ms: settleMs,
      observed_url: waited.url || null,
      observed_url_ok: waited.ok,
      reason: "observed_url_mismatch"
    };
    currentUrl = await getMainFrameUrl(client).catch(() => waited.url || currentUrl);
  }
  const loginDetection = await detectBossLoginState(client, { currentUrl }).catch(() => ({
    requires_login: isBossLoginUrl(currentUrl),
    reason: "login_detection_failed",
    current_url: currentUrl
  }));
  if (loginDetection.requires_login) {
    await session.close?.();
    throw createBossLoginRequiredError({
      domain: "recommend",
      currentUrl: loginDetection.current_url || currentUrl,
      targetUrl: RECOMMEND_TARGET_URL,
      loginDetection,
      chrome: session.chrome || null
    });
  }
  if (shouldNavigateToRecommend(currentUrl)) {
    await session.close?.();
    throw new Error(`Boss recommend page did not navigate to ${RECOMMEND_TARGET_URL}; current URL: ${currentUrl || "unknown"}`);
  }

  const selfHealConfig = buildRecommendSelfHealConfig();
  const health = await waitForHealthyRecommend(client, selfHealConfig, {
    timeoutMs: slowLive ? 180000 : 90000,
    intervalMs: slowLive ? 1200 : 800,
    refreshSettleMs: slowLive ? 12000 : 5000,
    refreshNavigationTimeoutMs: slowLive ? 45000 : 20000
  });
  if (health?.loginDetection?.requires_login) {
    await session.close?.();
    throw createBossLoginRequiredError({
      domain: "recommend",
      currentUrl: health.loginDetection.current_url || currentUrl,
      targetUrl: RECOMMEND_TARGET_URL,
      loginDetection: health.loginDetection,
      chrome: session.chrome || null
    });
  }
  if (!isRecommendConnectorHealthAccepted(health)) {
    const latestUrl = await getMainFrameUrl(client).catch(() => currentUrl);
    const latestLoginDetection = await detectBossLoginState(client, { currentUrl: latestUrl }).catch(() => ({
      requires_login: isBossLoginUrl(latestUrl),
      reason: "login_detection_failed",
      current_url: latestUrl
    }));
    if (latestLoginDetection.requires_login) {
      await session.close?.();
      throw createBossLoginRequiredError({
        domain: "recommend",
        currentUrl: latestLoginDetection.current_url || latestUrl,
        targetUrl: RECOMMEND_TARGET_URL,
        loginDetection: latestLoginDetection,
        chrome: session.chrome || null
      });
    }
    throw new Error(`Boss recommend page is not healthy: ${health?.status || "missing"}`);
  }

  return {
    ...session,
    navigation,
    health
  };
}

function parseRecommendPipelineRequest(args = {}) {
  return parseRecommendInstruction({
    instruction: args.instruction,
    confirmation: args.confirmation,
    overrides: args.overrides
  });
}

function readOwn(source, keys = []) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function getExplicitRestLevel(args = {}) {
  const behavior = readOwn(args, ["human_behavior", "humanBehavior"]);
  const raw = readOwn(behavior, ["restLevel", "rest_level"]);
  const normalized = normalizeText(raw).toLowerCase();
  return {
    raw: raw ?? null,
    restLevel: REST_LEVEL_SET.has(normalized) ? normalized : null,
    valid: REST_LEVEL_SET.has(normalized),
    missing: raw === undefined || raw === null || normalizeText(raw) === ""
  };
}

function buildReviewScreenParams(parsed) {
  return {
    ...(parsed.screenParams || {}),
    criteria: parsed.screenParams?.criteria || null,
    criteria_normalized: parsed.criteria_normalized || null,
    target_count: parsed.screenParams?.target_count ?? parsed.proposed_target_count ?? null,
    post_action: parsed.screenParams?.post_action || parsed.proposed_post_action || null,
    max_greet_count: parsed.screenParams?.max_greet_count ?? parsed.proposed_max_greet_count ?? null
  };
}

function buildReviewPageScope(parsed) {
  return parsed.page_scope || parsed.proposed_page_scope || "recommend";
}

function buildReviewJob(args = {}) {
  return normalizeText(args.confirmation?.job_value || args.overrides?.job || "") || null;
}

function buildScheduleReview(args = {}) {
  const scheduleRunAt = normalizeText(args.schedule_run_at || args.scheduleRunAt || args.run_at || args.runAt);
  const scheduleDelayMinutes = args.schedule_delay_minutes ?? args.scheduleDelayMinutes;
  const scheduleDelaySeconds = args.schedule_delay_seconds ?? args.scheduleDelaySeconds;
  if (!scheduleRunAt && scheduleDelayMinutes === undefined && scheduleDelaySeconds === undefined) return null;
  return {
    schedule_run_at: scheduleRunAt || null,
    schedule_delay_minutes: scheduleDelayMinutes ?? null,
    schedule_delay_seconds: scheduleDelaySeconds ?? null
  };
}

function buildRequiredConfirmations(parsed, args = {}) {
  const required = [];
  if (parsed.needs_page_confirmation) required.push("page_scope");
  if (parsed.needs_filters_confirmation) required.push("filters");
  if (parsed.needs_school_tag_confirmation) required.push("school_tag");
  if (parsed.needs_degree_confirmation) required.push("degree");
  if (parsed.needs_gender_confirmation) required.push("gender");
  if (parsed.needs_recent_not_view_confirmation) required.push("recent_not_view");
  if (parsed.needs_criteria_confirmation) required.push("criteria");
  if (parsed.needs_target_count_confirmation) required.push("target_count");
  if (parsed.needs_post_action_confirmation) required.push("post_action");
  if (parsed.needs_skip_recent_colleague_contacted_confirmation) required.push("skip_recent_colleague_contacted");
  if ((parsed.suspicious_fields || []).length) required.push("suspicious_fields");

  const confirmation = args.confirmation || {};
  const jobValue = normalizeText(confirmation.job_value || args.overrides?.job || "");
  if (!jobValue) required.push("job");
  const restLevel = getExplicitRestLevel(args);
  if (!restLevel.valid) required.push("rest_level");
  const blocksFinalReview = required.some((field) => field !== "rest_level");
  if (confirmation.final_confirmed !== true && !blocksFinalReview) required.push("final_review");
  return Array.from(new Set(required));
}

function buildJobPendingQuestion(args = {}) {
  const value = normalizeText(args.confirmation?.job_value || args.overrides?.job || "");
  return {
    field: "job",
    question: "请确认推荐页岗位。CDP-only rewrite 会先切换到该岗位，再按所选页面范围执行筛选。",
    value: value || null
  };
}

function buildRestLevelPendingQuestion(args = {}) {
  const restLevel = getExplicitRestLevel(args);
  return {
    field: "rest_level",
    question: restLevel.missing
      ? "请确认本次运行休息强度 rest_level。"
      : "rest_level 只能是 low / medium / high，请重新确认本次运行休息强度。",
    value: restLevel.restLevel || restLevel.raw || null,
    options: REST_LEVEL_OPTIONS.map((value) => ({
      label: value,
      value
    }))
  };
}

function buildSuspiciousFieldsQuestion(parsed) {
  return {
    field: "suspicious_fields",
    question: "检测到需要修正或明确确认的异常字段，请先修正后再启动。",
    value: parsed.suspicious_fields || []
  };
}

function buildFinalReviewQuestion(parsed, args = {}) {
  const restLevel = getExplicitRestLevel(args);
  return {
    field: "final_review",
    question: "请最终确认本次推荐页筛选参数无误；确认后设置 final_confirmed=true 即可启动或创建定时任务。",
    value: {
      page_scope: buildReviewPageScope(parsed),
      job: buildReviewJob(args),
      search_params: parsed.searchParams,
      screen_params: buildReviewScreenParams(parsed),
      human_behavior: {
        restLevel: restLevel.restLevel || null
      },
      schedule: buildScheduleReview(args)
    }
  };
}

function buildNeedInputResponse(parsed, args = {}) {
  return {
    status: "NEED_INPUT",
    missing_fields: parsed.missing_fields,
    required_confirmations: buildRequiredConfirmations(parsed, args),
    search_params: parsed.searchParams,
    screen_params: parsed.screenParams,
    pending_questions: parsed.pending_questions,
    review: parsed.review,
    error: {
      code: "MISSING_REQUIRED_FIELDS",
      message: "缺少必要字段。请补齐推荐页 criteria 等必填字段后再启动 CDP-only recommend run。",
      retryable: true
    }
  };
}

function buildNeedConfirmationResponse(parsed, args, requiredConfirmations) {
  const pending = [...(parsed.pending_questions || [])];
  if (requiredConfirmations.includes("suspicious_fields") && !pending.some((item) => item.field === "suspicious_fields")) {
    pending.push(buildSuspiciousFieldsQuestion(parsed));
  }
  if (requiredConfirmations.includes("job") && !pending.some((item) => item.field === "job")) {
    pending.push(buildJobPendingQuestion(args));
  }
  if (requiredConfirmations.includes("rest_level") && !pending.some((item) => item.field === "rest_level")) {
    pending.push(buildRestLevelPendingQuestion(args));
  }
  if (requiredConfirmations.includes("final_review") && !pending.some((item) => item.field === "final_review")) {
    pending.push(buildFinalReviewQuestion(parsed, args));
  }
  return {
    status: "NEED_CONFIRMATION",
    required_confirmations: requiredConfirmations,
    page_scope: buildReviewPageScope(parsed),
    search_params: parsed.searchParams,
    screen_params: buildReviewScreenParams(parsed),
    pending_questions: pending,
    review: {
      ...(parsed.review || {}),
      required_confirmations: requiredConfirmations
    }
  };
}

function evaluateRecommendPipelineGate(parsed, args = {}) {
  if (parsed.missing_fields?.length) return buildNeedInputResponse(parsed, args);
  const requiredConfirmations = buildRequiredConfirmations(parsed, args);
  if (requiredConfirmations.length) {
    return buildNeedConfirmationResponse(parsed, args, requiredConfirmations);
  }

  if (args.follow_up?.chat || args.overrides?.follow_up?.chat) {
    return {
      status: "FAILED",
      error: {
        code: "FOLLOW_UP_CHAT_NOT_CDP_REWRITTEN",
        message: "recommend -> chat follow-up orchestration is legacy-only and intentionally fenced from the CDP-only MCP route. Run recommend first, then use the direct chat MCP route separately, or keep the old chained behavior in the archived legacy lane.",
        retryable: true
      },
      review: parsed.review
    };
  }

  return null;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function withoutUnlimited(values = []) {
  return toArray(values)
    .map((value) => normalizeText(value))
    .filter((value) => value && value !== "不限" && value.toLowerCase() !== "all" && value !== "全部");
}

function buildRecommendFilter(parsed, args = {}) {
  if (args.no_filter === true || args.filter_enabled === false) {
    return { enabled: false };
  }

  const groups = [{
    group: "activity",
    labels: [parsed.searchParams?.activity_level || "不限"],
    selectAllLabels: false,
    allowUnlimited: true,
    verifySticky: true
  }];
  const recentNotView = withoutUnlimited(parsed.searchParams?.recent_not_view);
  if (recentNotView.length) {
    groups.push({
      group: "recentNotView",
      labels: recentNotView,
      selectAllLabels: true,
      verifySticky: true
    });
  }

  const degree = withoutUnlimited(parsed.searchParams?.degree);
  if (degree.length) {
    groups.push({
      group: "degree",
      labels: degree,
      selectAllLabels: true,
      verifySticky: true
    });
  }

  const gender = withoutUnlimited(parsed.searchParams?.gender);
  if (gender.length) {
    groups.push({
      group: "gender",
      labels: gender,
      selectAllLabels: true,
      verifySticky: true
    });
  }

  const school = withoutUnlimited(parsed.searchParams?.school_tag);
  if (school.length) {
    groups.push({
      group: "school",
      labels: school,
      selectAllLabels: true,
      verifySticky: true
    });
  }

  return {
    enabled: true,
    currentCityOnly: parsed.searchParams?.current_city_only === true,
    filterGroups: groups
  };
}

function normalizeRecommendStartInput(args = {}, parsed, configResolution = null) {
  const confirmation = args.confirmation || {};
  const overrides = args.overrides || {};
  const slowLive = args.slow_live === true;
  const targetCount = parsePositiveInteger(
    args.max_candidates,
    parsed.screenParams?.target_count || parsePositiveInteger(confirmation.target_count_value, 5)
  );
  return {
    host: normalizeText(args.host) || DEFAULT_RECOMMEND_HOST,
    port: parsePositiveInteger(
      args.port,
      configResolution?.ok ? configResolution.config.debugPort : DEFAULT_RECOMMEND_PORT
    ),
    targetUrlIncludes: normalizeText(args.target_url_includes) || RECOMMEND_TARGET_URL,
    allowNavigate: args.allow_navigate !== false,
    slowLive,
    criteria: parsed.screenParams?.criteria || normalizeText(overrides.criteria),
    targetCount,
    job: normalizeText(confirmation.job_value || overrides.job || ""),
    pageScope: parsed.page_scope || "recommend",
    filter: buildRecommendFilter(parsed, args),
    postAction: parsed.screenParams?.post_action || "none",
    maxGreetCount: Number.isInteger(parsed.screenParams?.max_greet_count)
      ? parsed.screenParams.max_greet_count
      : null,
    skipRecentColleagueContacted: parsed.screenParams?.skip_recent_colleague_contacted !== false,
    colleagueContactWindowDays: 14,
    screeningMode: normalizeScreeningModeArg(args)
  };
}

function getRunOptions(
  args,
  parsed,
  normalized,
  session,
  configResolution = null,
  actionJournalScope = ""
) {
  const slowLive = args.slow_live === true;
  const executePostAction = args.dry_run_post_action === true
    ? false
    : args.execute_post_action !== false;
  const humanBehavior = resolveHumanBehaviorForRun(args, configResolution?.config || {});
  return {
    client: session.client,
    targetUrl: RECOMMEND_TARGET_URL,
    criteria: normalized.criteria,
    jobLabel: normalized.job,
    pageScope: normalized.pageScope,
    fallbackPageScope: "recommend",
    filter: normalized.filter,
    maxCandidates: normalized.targetCount,
    detailLimit: resolveRecommendDetailLimit(args, normalized),
    closeDetail: true,
    delayMs: parseNonNegativeInteger(args.delay_ms, 0),
    cardTimeoutMs: slowLive ? 180000 : 90000,
    maxImagePages: parsePositiveInteger(args.max_image_pages, DEFAULT_MAX_IMAGE_PAGES),
    imageWheelDeltaY: parsePositiveInteger(args.image_wheel_delta_y, 650),
    cvAcquisitionMode: normalizeText(args.cv_acquisition_mode) || "unknown",
    listMaxScrolls: parsePositiveInteger(args.list_max_scrolls, 20),
    listStableSignatureLimit: parsePositiveInteger(args.list_stable_signature_limit, 2),
    listWheelDeltaY: parsePositiveInteger(args.list_wheel_delta_y, 850),
    listSettleMs: parsePositiveInteger(args.list_settle_ms, slowLive ? 1800 : 1200),
    listFallbackPoint: null,
    refreshOnEnd: args.refresh_on_end !== false,
    maxRefreshRounds: Math.min(2, parseNonNegativeInteger(args.max_refresh_rounds, 2)),
    refreshButtonSettleMs: parsePositiveInteger(args.refresh_button_settle_ms, slowLive ? 10000 : 8000),
    refreshReloadSettleMs: parsePositiveInteger(args.refresh_reload_settle_ms, slowLive ? 12000 : 8000),
    postAction: normalized.postAction,
    maxGreetCount: normalized.maxGreetCount,
    executePostAction,
    actionTimeoutMs: parsePositiveInteger(args.action_timeout_ms, slowLive ? 12000 : 8000),
    actionIntervalMs: parsePositiveInteger(args.action_interval_ms, 500),
    actionAfterClickDelayMs: parseNonNegativeInteger(args.action_after_click_delay_ms, slowLive ? 1200 : 900),
    actionJournalScope,
    reverifyActionJournalScope: actionJournalScope
      ? async () => resolveRecommendActionJournalScope({
          host: normalized.host,
          port: normalized.port,
          strictFresh: true
        })
      : null,
    screeningMode: normalized.screeningMode,
    llmConfig: normalized.screeningMode === "llm" && configResolution?.ok ? {
      ...configResolution.config
    } : null,
    llmTimeoutMs: parsePositiveInteger(
      args.llm_timeout_ms,
      parsePositiveInteger(configResolution?.config?.llmTimeoutMs || configResolution?.config?.timeoutMs, slowLive ? 180000 : 120000)
    ),
    llmImageLimit: parsePositiveInteger(
      args.llm_image_limit,
      parsePositiveInteger(configResolution?.config?.llmImageLimit || configResolution?.config?.imageLimit, 8)
    ),
    llmImageDetail: normalizeText(
      args.llm_image_detail || configResolution?.config?.llmImageDetail || configResolution?.config?.imageDetail
    ) || "low",
    imageOutputDir: resolveBossConfiguredOutputDir("", getRunsDir()),
    humanRestEnabled: humanBehavior.restEnabled,
    humanBehavior,
    skipRecentColleagueContacted: normalized.skipRecentColleagueContacted,
    colleagueContactWindowDays: normalized.colleagueContactWindowDays,
    debugTestMode: isDebugTestMode(args),
    debugForceListEndAfterProcessed: parsePositiveInteger(
      args.debug_force_list_end_after_processed,
      null
    ),
    debugForceContextRecoveryAfterProcessed: parsePositiveInteger(
      args.debug_force_context_recovery_after_processed,
      null
    ),
    debugForceCdpReconnectAfterProcessed: parsePositiveInteger(
      args.debug_force_cdp_reconnect_after_processed,
      null
    ),
    name: "mcp-recommend-pipeline-run",
    parsed
  };
}

function prepareRecommendPipelineStart(args = {}, { workspaceRoot = "" } = {}) {
  const routeGuard = guardRecommendRoute(args);
  if (routeGuard) return { response: routeGuard };
  const parsed = parseRecommendPipelineRequest(args);
  const gate = evaluateRecommendPipelineGate(parsed, args);
  if (gate) return { response: gate };
  const configResolution = resolveBossScreeningConfig(workspaceRoot);
  const normalized = normalizeRecommendStartInput(args, parsed, configResolution);
  const debugTestOptions = collectRecommendDebugTestOptions(args, normalized);
  if (debugTestOptions.length && !isDebugTestMode(args)) {
    return {
      response: {
        status: "FAILED",
        error: {
          code: "DEBUG_TEST_MODE_REQUIRED",
          message: `这些参数属于调试/测试路径，正式 live run 不会默认启用：${debugTestOptions.join(", ")}。如确需测试，请显式传 debug_test_mode=true。`,
          retryable: false
        },
        debug_test_options: debugTestOptions
      }
    };
  }
  if (normalized.screeningMode === "llm" && !configResolution.ok) {
    return {
      response: {
        status: "FAILED",
        error: {
          code: "SCREEN_CONFIG_ERROR",
          message: configResolution.error?.message || "screening-config.json is required for LLM screening.",
          retryable: true
        },
        config_path: configResolution.config_path || null,
        candidate_paths: configResolution.candidate_paths || []
      }
    };
  }
  return {
    parsed,
    configResolution,
    normalized
  };
}

export function shouldPreserveRecommendDetailOnTerminal(snapshot = null) {
  return snapshot?.checkpoint?.preserve_detail_on_terminal === true
    && snapshot?.checkpoint?.action_result_critical_persisted !== true;
}

async function closeRecommendRunSession(runId) {
  const meta = recommendRunMeta.get(runId);
  if (!meta || meta.closed) return;
  try {
    try {
      let preserveDetail = false;
      try {
        const snapshot = recommendRunService.getRecommendRun(runId);
        preserveDetail = shouldPreserveRecommendDetailOnTerminal(snapshot);
      } catch {
        // If the in-memory run is unavailable, retain the existing best-effort cleanup policy.
      }
      meta.preserve_detail_on_terminal = preserveDetail;
      if (meta.session?.client && !preserveDetail) {
        await closeRecommendDetail(meta.session.client, { attemptsLimit: 2 });
      }
    } catch {
      // Cleanup is best-effort once the run has settled.
    }
    assertNoForbiddenCdpCalls(meta.methodLog || []);
  } finally {
    meta.closed = true;
    try {
      await meta.session?.close?.();
    } catch {
      // Nothing actionable for the caller once the run has settled.
    }
  }
}

async function waitForRecommendRunTerminal(runId) {
  while (true) {
    try {
      const snapshot = recommendRunService.getRecommendRun(runId);
      if (TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    } catch {
      return null;
    }
    await sleep(1000);
  }
}

function trackRecommendRun(runId) {
  waitForRecommendRunTerminal(runId)
    .then((terminal) => {
      if (terminal) persistRecommendRunSnapshot(terminal);
    })
    .catch(() => null)
    .finally(() => {
      closeRecommendRunSession(runId).catch(() => {});
    });
}

async function startRecommendPipelineRunInternal(args = {}, { workspaceRoot = "", runId = "" } = {}) {
  const prepared = prepareRecommendPipelineStart(args, { workspaceRoot });
  if (prepared.response) return prepared.response;
  const { parsed, configResolution, normalized } = prepared;
  const fixedRunId = normalizeRunId(runId);
  if (runId && !fixedRunId) {
    return {
      status: "FAILED",
      error: {
        code: "INVALID_RUN_ID",
        message: "run_id is invalid",
        retryable: false
      }
    };
  }

  let session;
  try {
    session = await recommendConnectorImpl({
      host: normalized.host,
      port: normalized.port,
      targetUrlIncludes: normalized.targetUrlIncludes,
      allowNavigate: normalized.allowNavigate,
      slowLive: normalized.slowLive
    });
  } catch (error) {
    const loginRequired = error?.code === "BOSS_LOGIN_REQUIRED";
    return {
      status: "FAILED",
      error: {
        code: loginRequired ? "BOSS_LOGIN_REQUIRED" : "BOSS_RECOMMEND_PAGE_NOT_READY",
        message: error?.message || "Boss recommend page is not ready",
        requires_login: Boolean(error?.requires_login),
        login_url: error?.login_url || null,
        login_detection: error?.login_detection || null,
        chrome: error?.chrome || null,
        current_url: error?.current_url || null,
        target_url: error?.target_url || RECOMMEND_TARGET_URL,
        retryable: true
      },
      chrome: error?.chrome || null
    };
  }

  let actionJournalScope = "";
  let actionProfileIdentity = null;
  const liveGreetingRequested = normalized.postAction === "greet"
    && args.dry_run_post_action !== true
    && args.execute_post_action !== false;
  if (liveGreetingRequested) {
    try {
      const resolvedScope = await resolveRecommendActionJournalScope({
        host: normalized.host,
        port: normalized.port,
        session
      });
      actionJournalScope = resolvedScope.scope;
      actionProfileIdentity = resolvedScope.identity;
    } catch (error) {
      await session.close?.();
      return {
        status: "FAILED",
        error: {
          code: error?.code || "RECOMMEND_ACTION_PROFILE_IDENTITY_UNVERIFIED",
          message: error?.message || "Exact Chrome profile identity could not be proven",
          retryable: false
        }
      };
    }
  }

  let started;
  try {
    started = recommendRunService.startRecommendRun({
      ...getRunOptions(
        args,
        parsed,
        normalized,
        session,
        configResolution,
        actionJournalScope
      ),
      runId: fixedRunId || undefined,
      pid: process.pid,
      candidateResultJournalDir: getRunsDir()
    });
  } catch (error) {
    await session.close?.();
    return {
      status: "FAILED",
      error: {
        code: "RECOMMEND_RUN_START_FAILED",
        message: error?.message || "Failed to start recommend run",
        retryable: true
      }
    };
  }

  recommendRunMeta.set(started.runId, {
    session,
    methodLog: session.methodLog || [],
    workspaceRoot: normalizeText(workspaceRoot) || process.cwd(),
    args: clonePlain(args, {}),
    normalized,
    parsed,
    chrome: {
      host: normalized.host,
      port: normalized.port,
      target_url: session.navigation?.url || session.target?.url || RECOMMEND_TARGET_URL,
      target_id: session.target?.id || null,
      auto_launch: session.chrome || null,
      action_profile_identity: actionProfileIdentity
    },
    health: session.health || null
  });
  trackRecommendRun(started.runId);
  const persistedStarted = persistRecommendRunSnapshot(started);

  return {
    status: "ACCEPTED",
    run_id: persistedStarted.run_id,
    state: persistedStarted.state,
    run: persistedStarted,
    poll_after_sec: DEFAULT_RECOMMEND_POLL_AFTER_SEC,
    review: parsed.review,
    message: normalized.postAction === "none"
      ? "Recommend pipeline run started through the shared CDP-only recommend service. No post-action was requested."
      : `Recommend pipeline run started through the shared CDP-only recommend service with post_action=${normalized.postAction}${args.dry_run_post_action === true ? " in dry-run mode" : ""}.`,
    post_action: {
      requested: normalized.postAction,
      execute_post_action: args.dry_run_post_action === true ? false : args.execute_post_action !== false,
      max_greet_count: normalized.maxGreetCount
    },
    target_count_semantics: TARGET_COUNT_SEMANTICS
  };
}

export function prepareRecommendPipelineRunTool({ workspaceRoot = "", args = {} } = {}) {
  const prepared = prepareRecommendPipelineStart(args, { workspaceRoot });
  if (prepared.response) {
    return {
      ...prepared.response,
      cron_ready: false
    };
  }
  const { parsed, normalized } = prepared;
  const nextAction = {
    immediate_run: {
      recommended_next_tool: "start_recommend_pipeline_run",
      alternate_next_tool: "run_recommend",
      same_arguments: true,
      native_mcp_required: true
    },
    scheduled_run: {
      recommended_next_tool: "schedule_recommend_pipeline_run",
      same_arguments: true,
      requires_schedule_field: true
    },
    do_not_call_prepare_again: true,
    do_not_use_cli_fallback_when_mcp_tools_available: true,
    do_not_use_terminal_or_shell: true,
    forbidden_fallbacks: [
      "run_command",
      "terminal",
      "shell",
      "CLI detached fallback",
      "manual JSON-RPC over shell",
      "npx --stdio"
    ]
  };
  const agentGuidance = {
    host_has_native_mcp: true,
    native_mcp_required_after_prepare: true,
    proof: "This prepare_recommend_pipeline_run response was returned by the MCP server, so the host can call MCP tools from this server.",
    immediate_run: {
      tool: nextAction.immediate_run.recommended_next_tool,
      alternate_tool: nextAction.immediate_run.alternate_next_tool,
      same_arguments: true
    },
    scheduled_run: {
      tool: nextAction.scheduled_run.recommended_next_tool,
      same_arguments: true
    },
    trae_cn: {
      next_step: "Call boss-recommend/start_recommend_pipeline_run or boss-recommend/run_recommend through the native MCP tool interface.",
      never_use_terminal_fallback_after_prepare: true
    },
    forbidden_when_mcp_tools_are_available: nextAction.forbidden_fallbacks
  };
  return {
    status: "READY",
    cron_ready: true,
    prepared_only: true,
    run_started: false,
    recommended_next_tool: nextAction.immediate_run.recommended_next_tool,
    alternate_next_tool: nextAction.immediate_run.alternate_next_tool,
    next_action: nextAction,
    agent_guidance: agentGuidance,
    message: "READY only means the payload passed validation; prepare_recommend_pipeline_run did not start a run. This response proves the MCP server is available. To start now, call the native MCP tool start_recommend_pipeline_run or run_recommend with the same arguments. Do not call prepare_recommend_pipeline_run again, and do not use terminal, shell, CLI detached fallback, or manual JSON-RPC when MCP tools are available.",
    review: parsed.review,
    post_action: {
      requested: normalized.postAction,
      execute_post_action: args.dry_run_post_action === true ? false : args.execute_post_action !== false,
      max_greet_count: normalized.maxGreetCount
    },
    target_count_semantics: TARGET_COUNT_SEMANTICS
  };
}

export async function startRecommendPipelineRunTool({ workspaceRoot = "", args = {}, runId = "" } = {}) {
  const started = await startRecommendPipelineRunInternal(args, { workspaceRoot, runId });
  if (started.status !== "ACCEPTED") return started;
  return attachMethodEvidence(started, started.run_id);
}

export function getRecommendPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  if (!runId) {
    return {
      status: "FAILED",
      error: {
        code: "INVALID_RUN_ID",
        message: "run_id is required",
        retryable: false
      }
    };
  }
  try {
    const run = recommendRunService.getRecommendRun(runId);
    const normalizedRun = persistRecommendRunSnapshot(run);
    return attachMethodEvidence({
      status: "RUN_STATUS",
      run: compactRecommendRunForStatus(normalizedRun)
    }, runId);
  } catch {
    const persisted = readRecommendRunState(runId);
    if (persisted) {
      const reconciled = compactRecommendRunForStatus(reconcilePersistedRecommendRunIfNeeded(persisted));
      const persistedEvidence = readRecommendRunState(runId) || persisted;
      return attachPersistedCdpEvidence({
        status: "RUN_STATUS",
        run: reconciled,
        persistence: {
          source: "disk",
          active_control_available: false,
          stale_process_reconciled: reconciled?.state !== persisted.state
        }
      }, persistedEvidence);
    }
    return {
      status: "FAILED",
      error: {
        code: "RUN_NOT_FOUND",
        message: `No recommend run found for run_id=${runId}`,
        retryable: false
      }
    };
  }
}

export function pauseRecommendPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  try {
    const before = recommendRunService.getRecommendRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistRecommendRunSnapshot(before);
      return attachMethodEvidence({
        status: "PAUSE_IGNORED",
        run: compactRecommendRunForStatus(normalizedBefore),
        message: "目标任务已结束，无需暂停。"
      }, runId);
    }
    if (before.status === RUN_STATUS_PAUSED) {
      const normalizedBefore = persistRecommendRunSnapshot(before);
      return attachMethodEvidence({
        status: "PAUSE_IGNORED",
        run: compactRecommendRunForStatus(normalizedBefore),
        message: "目标任务已经处于 paused 状态。"
      }, runId);
    }
    const run = recommendRunService.pauseRecommendRun(runId);
    const normalizedRun = persistRecommendRunSnapshot(run);
    return attachMethodEvidence({
      status: "PAUSE_REQUESTED",
      run: compactRecommendRunForStatus(normalizedRun),
      message: "暂停请求已接收，将在当前候选人处理完成后进入 paused。"
    }, runId);
  } catch {
    const persisted = readRecommendRunState(runId);
    if (persisted && TERMINAL_STATUSES.has(persisted.state)) {
      return attachPersistedCdpEvidence({
        status: "PAUSE_IGNORED",
        run: compactRecommendRunForStatus(persisted),
        message: "目标任务已结束，无需暂停。"
      }, persisted);
    }
    return getRecommendPipelineRunTool({ args });
  }
}

export function resumeRecommendPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  try {
    const before = recommendRunService.getRecommendRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistRecommendRunSnapshot(before);
      return attachMethodEvidence({
        status: "FAILED",
        error: {
          code: "RUN_ALREADY_TERMINATED",
          message: "目标任务已结束，无法继续。",
          retryable: false
        },
        run: compactRecommendRunForStatus(normalizedBefore)
      }, runId);
    }
    if (before.status !== RUN_STATUS_PAUSED) {
      const normalizedBefore = persistRecommendRunSnapshot(before);
      return attachMethodEvidence({
        status: "FAILED",
        error: {
          code: "RUN_NOT_PAUSED",
          message: "仅 paused 状态的 run 才能继续。",
          retryable: true
        },
        run: compactRecommendRunForStatus(normalizedBefore)
      }, runId);
    }
    const run = recommendRunService.resumeRecommendRun(runId);
    const meta = getRecommendRunMeta(runId);
    if (meta) {
      meta.resumeCount = (meta.resumeCount || 0) + 1;
      meta.lastResumedAt = new Date().toISOString();
    }
    const normalizedRun = persistRecommendRunSnapshot(run);
    return attachMethodEvidence({
      status: "RESUME_REQUESTED",
      run: compactRecommendRunForStatus(normalizedRun),
      poll_after_sec: DEFAULT_RECOMMEND_POLL_AFTER_SEC,
      message: "已恢复 Recommend run，请使用 get_recommend_pipeline_run 按需轮询。"
    }, runId);
  } catch {
    const persisted = readRecommendRunState(runId);
    if (persisted) {
      return attachPersistedCdpEvidence({
        status: "FAILED",
        error: {
          code: TERMINAL_STATUSES.has(persisted.state) ? "RUN_ALREADY_TERMINATED" : "RUN_NOT_ACTIVE",
          message: TERMINAL_STATUSES.has(persisted.state)
            ? "目标任务已结束，无法继续。"
            : "该 run 只有磁盘快照，没有当前进程内的活动 CDP 会话，无法安全继续。",
          retryable: !TERMINAL_STATUSES.has(persisted.state)
        },
        run: compactRecommendRunForStatus(persisted),
        persistence: {
          source: "disk",
          active_control_available: false
        }
      }, persisted);
    }
    return getRecommendPipelineRunTool({ args });
  }
}

export function cancelRecommendPipelineRunTool({ args = {} } = {}) {
  const runId = normalizeRunId(args.run_id || args.runId);
  try {
    const before = recommendRunService.getRecommendRun(runId);
    if (TERMINAL_STATUSES.has(before.status)) {
      const normalizedBefore = persistRecommendRunSnapshot(before);
      return attachMethodEvidence({
        status: "CANCEL_IGNORED",
        run: compactRecommendRunForStatus(normalizedBefore),
        message: "目标任务已结束，无需取消。"
      }, runId);
    }
    const run = recommendRunService.cancelRecommendRun(runId);
    const normalizedRun = persistRecommendRunSnapshot(run);
    return attachMethodEvidence({
      status: "CANCEL_REQUESTED",
      run: compactRecommendRunForStatus(normalizedRun),
      message: "已收到取消请求，将在当前候选人处理完成后安全停止。"
    }, runId);
  } catch {
    const persisted = readRecommendRunState(runId);
    if (persisted && TERMINAL_STATUSES.has(persisted.state)) {
      return attachPersistedCdpEvidence({
        status: "CANCEL_IGNORED",
        run: compactRecommendRunForStatus(persisted),
        message: "目标任务已结束，无需取消。"
      }, persisted);
    }
    const cancelMessage = "已收到取消请求，将由 detached worker 在下一个安全边界停止。";
    const patched = patchPersistedRecommendRunControl(runId, {
      pause_requested: true,
      pause_requested_at: new Date().toISOString(),
      pause_requested_by: "cancel_recommend_pipeline_run",
      cancel_requested: true
    }, {
      message: cancelMessage
    });
    if (patched) {
      return attachPersistedCdpEvidence({
        status: "CANCEL_REQUESTED",
        run: compactRecommendRunForStatus(patched),
        message: cancelMessage,
        persistence: {
          source: "disk",
          active_control_available: false,
          detached_control_requested: true
        }
      }, patched);
    }
    return getRecommendPipelineRunTool({ args });
  }
}

export function getRecommendMcpHealthSnapshot(runId) {
  const meta = getRecommendRunMeta(runId);
  return {
    health: compactHealth(meta.health || null),
    chrome: meta.chrome || null,
    method_summary: methodSummary(meta.methodLog || [])
  };
}

export function __setRecommendMcpConnectorForTests(nextConnector) {
  recommendConnectorImpl = typeof nextConnector === "function" ? nextConnector : connectRecommendChromeSession;
}

export function __setRecommendMcpJobReaderForTests(nextReader) {
  recommendJobReaderImpl = typeof nextReader === "function" ? nextReader : readRecommendJobOptionsFromSession;
}

export function __setRecommendMcpWorkflowForTests(nextWorkflow) {
  recommendWorkflowImpl = typeof nextWorkflow === "function" ? nextWorkflow : runRecommendWorkflow;
  recommendRunService = createRecommendRunService({
    idPrefix: "mcp_recommend",
    workflow: (...args) => recommendWorkflowImpl(...args),
    onSnapshot: persistRecommendLifecycleSnapshot
  });
}

export function __resetRecommendMcpStateForTests() {
  for (const meta of recommendRunMeta.values()) {
    try {
      meta.session?.close?.();
    } catch {
      // Best-effort test cleanup.
    }
  }
  recommendRunMeta.clear();
  __setRecommendMcpConnectorForTests(null);
  __setRecommendMcpJobReaderForTests(null);
  __setRecommendMcpWorkflowForTests(null);
}
