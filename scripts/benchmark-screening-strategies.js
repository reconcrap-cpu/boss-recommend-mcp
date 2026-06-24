#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  callScreeningLlm
} from "../src/core/screening/index.js";
import {
  resolveBossScreeningConfig
} from "../src/chat-runtime-config.js";

const BENCHMARK_VERSION = 3;
const HARD_GATE_VERSION = 2;
const DEFAULT_STRATEGIES = [
  "oracle_full_image_high",
  "baseline_full_image_reasoning",
  "extract_then_reason",
  "extract_hard_gate_then_reason",
  "batch_extract_then_reason",
  "batch_extract_hard_gate_then_reason",
  "pipeline_simulation"
];
const FULL_IMAGE_STRATEGIES = new Set([
  "oracle_full_image_high",
  "baseline_full_image_reasoning"
]);
const DEFAULT_RUN_DIR = path.join(os.homedir(), ".boss-recommend-mcp", "runs");
const DEFAULT_OUTPUT_DIR = path.join(".live-artifacts", "screening-benchmark");
const DEFAULT_CACHE_DIR = path.join(".live-artifacts", "screening-benchmark-cache");

function usage() {
  return [
    "Usage: node scripts/benchmark-screening-strategies.js [options]",
    "",
    "Offline replay benchmark for saved Boss recommend candidates.",
    "",
    "Options:",
    "  --dry-run                    Load saved candidates and write a manifest without calling an LLM.",
    "  --run <id-or-json-path>       Add one saved run. Can be repeated.",
    "  --runs <a,b,c>                Comma-separated run ids or JSON paths.",
    "  --run-dir <dir>               Saved run directory. Default: ~/.boss-recommend-mcp/runs",
    "  --latest-runs <n>             Auto-select latest replayable recommend runs. Default: 4",
    "  --max-candidates <n>          Limit replayed candidates after discovery.",
    "  --strategies <a,b,c>          Strategies to run. Default: all.",
    "  --config <path>               screening-config.json path. Default: normal runtime resolution.",
    "  --out-dir <dir>               Output directory. Default: .live-artifacts/screening-benchmark/<timestamp>",
    "  --cache-dir <dir>             LLM output cache directory. Default: .live-artifacts/screening-benchmark-cache",
    "  --force-refresh               Ignore cached LLM outputs.",
    "  --batch-size <n>              Batch size for batch_extract_then_reason. Default: 3",
    "  --target-avg-ms <n>           Eligibility latency target. Default: 30000",
    "  --max-false-negatives <n>     Eligibility false-negative budget vs oracle. Default: 0",
    "  --llm-timeout-ms <n>          Per-call timeout override.",
    "  --oracle-thinking-level <x>   Default: high",
    "  --baseline-thinking-level <x> Default: low",
    "  --extract-thinking-level <x>  Default: current",
    "  --fail-gate-thinking-level <x> Default: current",
    "  --reason-thinking-level <x>   Default: low",
    "  --escalate-thinking-level <x> Default: low",
    "  --image-limit <n>             Override image count passed to LLM.",
    "  --image-detail <low|high|auto> Override image detail.",
    "  --no-response-format          Do not request response_format=json_object for benchmark-native calls.",
    "  --help                        Show this help."
  ].join("\n");
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const options = {
    runDir: DEFAULT_RUN_DIR,
    runs: [],
    latestRuns: 4,
    maxCandidates: 0,
    strategies: [...DEFAULT_STRATEGIES],
    configPath: "",
    outDir: "",
    cacheDir: DEFAULT_CACHE_DIR,
    forceRefresh: false,
    dryRun: false,
    batchSize: 3,
    targetAvgMs: 30000,
    maxFalseNegatives: 0,
    llmTimeoutMs: null,
    oracleThinkingLevel: "high",
    baselineThinkingLevel: "low",
    extractThinkingLevel: "current",
    failGateThinkingLevel: "current",
    reasonThinkingLevel: "low",
    escalateThinkingLevel: "low",
    imageLimit: null,
    imageDetail: "",
    responseFormat: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--run") {
      options.runs.push(argv[++index]);
    } else if (arg === "--runs") {
      options.runs.push(...String(argv[++index] || "").split(",").map((item) => item.trim()).filter(Boolean));
    } else if (arg === "--run-dir") {
      options.runDir = argv[++index];
    } else if (arg === "--latest-runs") {
      options.latestRuns = parsePositiveInt(argv[++index], options.latestRuns);
    } else if (arg === "--max-candidates") {
      options.maxCandidates = parseNonNegativeInt(argv[++index], options.maxCandidates);
    } else if (arg === "--strategies") {
      options.strategies = String(argv[++index] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else if (arg === "--config") {
      options.configPath = argv[++index];
    } else if (arg === "--out-dir") {
      options.outDir = argv[++index];
    } else if (arg === "--cache-dir") {
      options.cacheDir = argv[++index];
    } else if (arg === "--force-refresh") {
      options.forceRefresh = true;
    } else if (arg === "--batch-size") {
      options.batchSize = parsePositiveInt(argv[++index], options.batchSize);
    } else if (arg === "--target-avg-ms") {
      options.targetAvgMs = parsePositiveInt(argv[++index], options.targetAvgMs);
    } else if (arg === "--max-false-negatives") {
      options.maxFalseNegatives = parseNonNegativeInt(argv[++index], options.maxFalseNegatives);
    } else if (arg === "--llm-timeout-ms") {
      options.llmTimeoutMs = parsePositiveInt(argv[++index], options.llmTimeoutMs);
    } else if (arg === "--oracle-thinking-level") {
      options.oracleThinkingLevel = argv[++index];
    } else if (arg === "--baseline-thinking-level") {
      options.baselineThinkingLevel = argv[++index];
    } else if (arg === "--extract-thinking-level") {
      options.extractThinkingLevel = argv[++index];
    } else if (arg === "--fail-gate-thinking-level") {
      options.failGateThinkingLevel = argv[++index];
    } else if (arg === "--reason-thinking-level") {
      options.reasonThinkingLevel = argv[++index];
    } else if (arg === "--escalate-thinking-level") {
      options.escalateThinkingLevel = argv[++index];
    } else if (arg === "--image-limit") {
      options.imageLimit = parsePositiveInt(argv[++index], options.imageLimit);
    } else if (arg === "--image-detail") {
      options.imageDetail = argv[++index];
    } else if (arg === "--no-response-format") {
      options.responseFormat = false;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  const unknownStrategies = options.strategies.filter((item) => !DEFAULT_STRATEGIES.includes(item));
  if (unknownStrategies.length) {
    throw new Error(`Unknown strategies: ${unknownStrategies.join(", ")}`);
  }
  const needsOracle = options.strategies.some((item) => item !== "pipeline_simulation" && item !== "oracle_full_image_high");
  if (needsOracle && !options.strategies.includes("oracle_full_image_high")) {
    options.strategies.unshift("oracle_full_image_high");
  }
  return options;
}

function ensureDir(dirPath) {
  fs.mkdirSync(path.resolve(dirPath), { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows, headers) {
  ensureDir(path.dirname(filePath));
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hashJson(value) {
  return sha256(JSON.stringify(value));
}

function hashFiles(filePaths) {
  const hash = crypto.createHash("sha256");
  for (const filePath of filePaths) {
    const resolved = path.resolve(filePath);
    hash.update(resolved);
    hash.update("\0");
    hash.update(fs.readFileSync(resolved));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function normalizeBlock(input) {
  return String(input ?? "").trim();
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tryExtractJsonObject(text) {
  const source = String(text || "").trim();
  const direct = tryParseJson(source);
  if (direct && typeof direct === "object") return direct;
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed && typeof parsed === "object") return parsed;
  }
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = tryParseJson(source.slice(start, end + 1));
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

function parseBooleanDecision(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = normalizeText(value).toLowerCase();
  if (["true", "pass", "passed", "yes", "是", "通过", "符合"].includes(normalized)) return true;
  if (["false", "fail", "failed", "no", "否", "不通过", "不符合"].includes(normalized)) return false;
  return null;
}

function compactError(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || error || "unknown").slice(0, 1000),
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    code: error?.code || null
  };
}

function resolveRunPath(raw, runDir) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (fs.existsSync(value)) return path.resolve(value);
  const withJson = value.endsWith(".json") ? value : `${value}.json`;
  const candidate = path.join(path.resolve(runDir), withJson);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Saved run not found: ${raw}`);
}

function isRecommendRunJsonName(name) {
  return /^mcp_recommend_.*\.json$/i.test(name) && !/checkpoint\.json$/i.test(name);
}

function getResultRows(runJson) {
  return Array.isArray(runJson?.result?.results) ? runJson.result.results : [];
}

function getRunIdFromPath(filePath, runJson) {
  return normalizeText(runJson?.run_id) || path.basename(filePath).replace(/\.json$/i, "");
}

function getCandidateImagePaths(row) {
  const evidence = row?.detail?.image_evidence || row?.detail?.cv_acquisition?.image_evidence || {};
  const llmPaths = Array.isArray(evidence.llm_file_paths) ? evidence.llm_file_paths : [];
  const fallbackPaths = Array.isArray(evidence.file_paths) ? evidence.file_paths : [];
  const screenshotPaths = Array.isArray(evidence.screenshots)
    ? evidence.screenshots.map((item) => item?.file_path).filter(Boolean)
    : [];
  const paths = (llmPaths.length ? llmPaths : (fallbackPaths.length ? fallbackPaths : screenshotPaths))
    .map((item) => path.resolve(String(item || "")))
    .filter((item) => item && fs.existsSync(item));
  return [...new Set(paths)];
}

function pickCriteria(runJson) {
  const candidates = [
    runJson?.result?.screen_params?.criteria,
    runJson?.context?.screen_params?.criteria,
    runJson?.context?.overrides?.criteria,
    runJson?.context?.criteria,
    runJson?.resume?.screen_params?.criteria,
    runJson?.resume?.overrides?.criteria,
    runJson?.resume?.criteria,
    runJson?.context?.instruction,
    runJson?.resume?.instruction,
    runJson?.result?.instruction
  ];
  for (const candidate of candidates) {
    const text = normalizeBlock(candidate);
    if (text) return text;
  }
  return "";
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function timing(row, key) {
  return numberValue(row?.timings?.[key] ?? row?.timing?.[key] ?? row?.[key]);
}

function sumTimings(row, keys) {
  return keys.reduce((sum, key) => sum + timing(row, key), 0);
}

function computeSavedTiming(row) {
  const totalMs = timing(row, "total_ms");
  const textModelMs = timing(row, "text_model_ms");
  const visionModelMs = timing(row, "vision_model_ms");
  const savedLlmMs = textModelMs + visionModelMs;
  const fallbackNonLlm = sumTimings(row, [
    "card_read_ms",
    "candidate_click_ms",
    "detail_open_ms",
    "network_cv_wait_ms",
    "late_network_retry_ms",
    "screenshot_capture_ms",
    "dom_fallback_ms",
    "post_action_ms",
    "close_detail_ms",
    "sleep_ms",
    "human_rest_ms",
    "checkpoint_save_ms"
  ]);
  const nonLlmMs = Math.max(0, totalMs > 0 ? totalMs - savedLlmMs : fallbackNonLlm);
  const acquisitionMs = sumTimings(row, [
    "card_read_ms",
    "candidate_click_ms",
    "detail_open_ms",
    "network_cv_wait_ms",
    "late_network_retry_ms",
    "screenshot_capture_ms",
    "dom_fallback_ms"
  ]);
  const postLlmMs = Math.max(0, nonLlmMs - acquisitionMs);
  return {
    saved_total_ms: totalMs,
    saved_llm_ms: savedLlmMs,
    saved_non_llm_ms: nonLlmMs,
    acquisition_ms: acquisitionMs,
    post_llm_ms: postLlmMs
  };
}

function compactCandidateForLlm(row) {
  const candidate = row?.screening?.candidate || row?.candidate || {};
  return {
    domain: candidate.domain || "recommend",
    source: candidate.source || "saved-benchmark",
    id: candidate.id || row?.candidate_id || row?.candidate_key || "",
    identity: candidate.identity || {},
    tags: Array.isArray(candidate.tags) ? candidate.tags : [],
    text: {
      raw: String(candidate.text?.raw || candidate.text || "")
    },
    metadata: {
      benchmark_replay: true,
      saved_candidate_key: row?.candidate_key || ""
    }
  };
}

function discoverRunPaths(options) {
  if (options.runs.length) {
    return [...new Set(options.runs.map((item) => resolveRunPath(item, options.runDir)))];
  }
  const resolvedRunDir = path.resolve(options.runDir);
  if (!fs.existsSync(resolvedRunDir)) return [];
  const entries = fs.readdirSync(resolvedRunDir)
    .filter(isRecommendRunJsonName)
    .map((name) => {
      const fullPath = path.join(resolvedRunDir, name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const selected = [];
  for (const entry of entries) {
    if (selected.length >= options.latestRuns) break;
    try {
      const runJson = readJson(entry.fullPath);
      const hasReplayableImage = getResultRows(runJson).some((row) => getCandidateImagePaths(row).length > 0);
      if (hasReplayableImage) selected.push(entry.fullPath);
    } catch {
      // Ignore unreadable historical artifacts.
    }
  }
  return selected;
}

function loadReplayCandidates(options) {
  const runPaths = discoverRunPaths(options);
  const candidates = [];
  const excluded = [];

  for (const runPath of runPaths) {
    const runJson = readJson(runPath);
    const runId = getRunIdFromPath(runPath, runJson);
    const criteria = pickCriteria(runJson);
    const criteriaHash = sha256(criteria);
    const rows = getResultRows(runJson);
    for (const [index, row] of rows.entries()) {
      const imagePaths = getCandidateImagePaths(row);
      const candidateKey = normalizeText(row?.candidate_key || row?.candidate?.id || row?.screening?.candidate?.id || `${runId}:${index}`);
      const base = {
        run_id: runId,
        run_path: runPath,
        candidate_index: index,
        candidate_key: candidateKey,
        candidate_id: normalizeText(row?.candidate?.id || row?.screening?.candidate?.id || ""),
        candidate_name: normalizeText(row?.candidate?.identity?.name || row?.screening?.candidate?.identity?.name || ""),
        criteria,
        criteria_hash: criteriaHash,
        saved_passed: parseBooleanDecision(row?.detail?.llm_screening?.passed ?? row?.llm_screening?.passed ?? row?.screening?.passed),
        saved_decision_source: normalizeText(row?.detail?.llm_screening?.decision_source || row?.llm_screening?.decision_source || ""),
        saved_cv_source: normalizeText(row?.detail?.cv_acquisition?.source || row?.candidate?.source || ""),
        image_paths: imagePaths,
        image_count: imagePaths.length,
        timing: computeSavedTiming(row),
        candidate: compactCandidateForLlm(row),
        row
      };
      if (!criteria) {
        excluded.push({ ...base, exclude_reason: "missing_criteria" });
      } else if (!imagePaths.length) {
        excluded.push({ ...base, exclude_reason: "missing_saved_llm_images" });
      } else {
        candidates.push({
          ...base,
          image_hash: hashFiles(imagePaths)
        });
      }
    }
  }

  const limitedCandidates = options.maxCandidates > 0
    ? candidates.slice(0, options.maxCandidates)
    : candidates;
  const overflow = options.maxCandidates > 0 ? candidates.slice(options.maxCandidates) : [];
  for (const item of overflow) {
    excluded.push({ ...item, exclude_reason: "max_candidates_limit" });
  }
  return {
    run_paths: runPaths,
    candidates: limitedCandidates,
    excluded
  };
}

function loadConfig(options) {
  if (options.dryRun) return {};
  if (options.configPath) {
    return readJson(options.configPath);
  }
  const resolution = resolveBossScreeningConfig(process.cwd());
  if (!resolution.ok) {
    throw new Error(resolution.error?.message || "screening-config.json is required for benchmark replay");
  }
  return resolution.config;
}

function forceSinglePassConfig(config, thinkingLevel, options = {}) {
  const forceEntry = (entry) => ({
    ...(typeof entry === "string" ? { model: entry } : (entry || {})),
    llmScreeningStrategy: "single_pass",
    screeningStrategy: "single_pass",
    llmThinkingLevel: thinkingLevel,
    thinkingLevel,
    reasoningEffort: thinkingLevel,
    ...(options.maxTokens ? { llmMaxTokens: options.maxTokens, maxTokens: options.maxTokens } : {})
  });
  const next = {
    ...(config || {}),
    llmScreeningStrategy: "single_pass",
    screeningStrategy: "single_pass",
    llmThinkingLevel: thinkingLevel,
    thinkingLevel,
    reasoningEffort: thinkingLevel
  };
  if (Array.isArray(config?.llmModels) && config.llmModels.length) {
    next.llmModels = config.llmModels.map(forceEntry);
  }
  if (Array.isArray(config?.models) && config.models.length) {
    next.models = config.models.map(forceEntry);
  }
  return next;
}

function cacheKeyFor(candidate, strategy, extra = {}) {
  return sha256(JSON.stringify({
    benchmark_version: BENCHMARK_VERSION,
    run_id: candidate.run_id,
    candidate_key: candidate.candidate_key,
    strategy,
    criteria_hash: candidate.criteria_hash,
    image_hash: candidate.image_hash,
    ...extra
  }));
}

function cachePath(cacheDir, key) {
  return path.join(path.resolve(cacheDir), `${key}.json`);
}

function readCache(options, key) {
  if (options.forceRefresh) return null;
  const filePath = cachePath(options.cacheDir, key);
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function writeCache(options, key, value) {
  const filePath = cachePath(options.cacheDir, key);
  writeJson(filePath, value);
}

async function withCandidateCache(candidate, strategy, options, extra, fn) {
  const key = cacheKeyFor(candidate, strategy, extra);
  const cached = readCache(options, key);
  if (cached) {
    return {
      ...cached,
      cache_hit: true,
      cache_key: key
    };
  }
  const value = await fn();
  const cachedValue = {
    ...value,
    cache_hit: false,
    cache_key: key,
    cached_at: new Date().toISOString()
  };
  writeCache(options, key, cachedValue);
  return cachedValue;
}

function imagePathToContentPart(filePath, detail = "low") {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : (ext === ".webp" ? "image/webp" : "image/png");
  const data = fs.readFileSync(resolved).toString("base64");
  return {
    type: "image_url",
    image_url: {
      url: `data:${mime};base64,${data}`,
      detail
    }
  };
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function chatCompletionsUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function isVolcengineModel(baseUrl, model) {
  return /volces|volcengine|ark\.cn|doubao|seed/i.test(`${baseUrl || ""} ${model || ""}`);
}

function isNativeVolcengineBaseUrl(baseUrl) {
  return /volces|volcengine|ark\.cn/i.test(String(baseUrl || ""));
}

function isOpenAiCompatibleV1BaseUrl(baseUrl) {
  return /(?:^|\/)v1(?:\/)?$/i.test(normalizeBaseUrl(baseUrl));
}

function applyThinking(payload, { baseUrl = "", model = "", thinkingLevel = "" } = {}) {
  const level = normalizeText(thinkingLevel).toLowerCase();
  if (!level || level === "current" || level === "auto") return payload;
  if (isVolcengineModel(baseUrl, model)) {
    payload.thinking = { type: level === "off" || level === "minimal" ? "disabled" : "enabled" };
    if (!isNativeVolcengineBaseUrl(baseUrl) && isOpenAiCompatibleV1BaseUrl(baseUrl)) {
      payload.reasoning_effort = level === "off" ? "minimal" : level;
    }
    return payload;
  }
  payload.reasoning_effort = level === "off" ? "minimal" : level;
  return payload;
}

function firstConfiguredValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return "";
}

function providerConfigs(config = {}) {
  const rawProviders = Array.isArray(config.llmModels) && config.llmModels.length
    ? config.llmModels
    : (Array.isArray(config.models) && config.models.length ? config.models : [config]);
  return rawProviders.map((raw, index) => {
    const entry = typeof raw === "string" ? { model: raw } : (raw || {});
    return {
      ...config,
      ...entry,
      baseUrl: firstConfiguredValue(entry.baseUrl, entry.base_url, config.baseUrl, config.base_url),
      apiKey: firstConfiguredValue(entry.apiKey, entry.api_key, config.apiKey, config.api_key),
      model: firstConfiguredValue(entry.model, entry.modelName, entry.model_name, typeof raw === "string" ? raw : "", config.model),
      llmProviderIndex: index,
      llmProviderCount: rawProviders.length
    };
  });
}

function completionContent(choice = {}) {
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => typeof item === "string" ? item : (item?.text || item?.content || "")).join("\n");
  }
  return "";
}

async function callJsonLlm({
  config,
  messages,
  thinkingLevel,
  timeoutMs,
  maxTokens = 1200,
  responseFormat = true,
  stage = "benchmark"
}) {
  const providers = providerConfigs(config);
  const errors = [];
  const started = Date.now();
  for (const [index, provider] of providers.entries()) {
    const baseUrl = normalizeBaseUrl(provider.baseUrl);
    const apiKey = normalizeText(provider.apiKey);
    const model = normalizeText(provider.model);
    if (!baseUrl || !apiKey || !model) {
      errors.push({ provider: index + 1, error: "missing baseUrl/apiKey/model" });
      continue;
    }
    const attempts = Math.max(1, Math.min(3, parseNonNegativeInt(provider.llmMaxRetries ?? provider.maxRetries, 1) + 1));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const responseFormatModes = responseFormat ? [true, false] : [false];
      for (const useResponseFormat of responseFormatModes) {
        const controller = new AbortController();
        const effectiveTimeoutMs = parsePositiveInt(provider.llmTimeoutMs ?? provider.timeoutMs, timeoutMs || 60000);
        const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
        try {
          const payload = applyThinking({
            model,
            temperature: Number.isFinite(Number(provider.temperature)) ? Number(provider.temperature) : 0.1,
            max_tokens: maxTokens,
            messages
          }, { baseUrl, model, thinkingLevel });
          if (useResponseFormat) payload.response_format = { type: "json_object" };
          const topP = Number(provider.topP ?? provider.top_p);
          if (Number.isFinite(topP)) payload.top_p = topP;
          const response = await fetch(chatCompletionsUrl(baseUrl), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
              ...(provider.openaiOrganization ? { "OpenAI-Organization": provider.openaiOrganization } : {}),
              ...(provider.openaiProject ? { "OpenAI-Project": provider.openaiProject } : {})
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          const responseText = await response.text();
          if (!response.ok) {
            const error = new Error(`LLM ${stage} failed: ${response.status} ${responseText.slice(0, 500)}`);
            error.status = response.status;
            if (useResponseFormat && /response_format|json_object|unsupported/i.test(responseText)) {
              errors.push({ provider: index + 1, attempt, response_format: true, error: error.message });
              continue;
            }
            throw error;
          }
          const outer = tryParseJson(responseText);
          if (!outer) throw new Error(`LLM ${stage} returned non-JSON HTTP body`);
          const choice = outer?.choices?.[0] || {};
          const content = completionContent(choice);
          const parsed = tryExtractJsonObject(content);
          if (!parsed) throw new Error(`LLM ${stage} response did not contain a JSON object: ${content.slice(0, 300)}`);
          return {
            ok: true,
            parsed,
            raw_model_output: content,
            usage: outer.usage || null,
            finish_reason: choice.finish_reason || "",
            elapsed_ms: Date.now() - started,
            provider: {
              baseUrl: baseUrl.replace(/\/\/[^/]+/, "//[redacted-host]"),
              model,
              index: index + 1,
              total: providers.length,
              thinking_level: thinkingLevel,
              response_format: useResponseFormat
            },
            attempt_count: attempt
          };
        } catch (error) {
          errors.push({ provider: index + 1, attempt, response_format: useResponseFormat, error: error.message || String(error) });
          if (attempt >= attempts) break;
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }
  return {
    ok: false,
    parsed: null,
    raw_model_output: "",
    elapsed_ms: Date.now() - started,
    errors
  };
}

function extractionMessages(candidate, options) {
  const imageParts = candidate.image_paths
    .slice(0, options.imageLimit || 8)
    .map((filePath) => imagePathToContentPart(filePath, options.imageDetail || "low"));
  return [
    {
      role: "system",
      content: [
        "你是简历事实抽取器，不做通过/不通过判断。",
        "只抽取截图中真实可见的信息；不要猜学校排名、任期、业务线或职责。",
        "只能返回严格 JSON。"
      ].join("")
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "请为了后续筛选，抽取与以下筛选标准相关的简历事实。",
            "",
            `筛选标准:\n${candidate.criteria}`,
            "",
            `候选人: ${candidate.candidate_name || candidate.candidate_key}`,
            "",
            "返回 JSON 格式：",
            "{",
            "  \"extraction_ok\": true/false,",
            "  \"candidate_key\": \"...\",",
            "  \"facts\": {",
            "    \"education\": [],",
            "    \"work_experience\": [],",
            "    \"products_or_industries\": [],",
            "    \"responsibilities_and_metrics\": [],",
            "    \"overseas_or_english_evidence\": [],",
            "    \"exclusion_evidence\": [],",
            "    \"date_or_tenure_evidence\": [],",
            "    \"unclear_or_missing\": []",
            "  },",
            "  \"needs_full_image_reasoning\": true/false",
            "}",
            "",
            "extraction_ok 只表示事实抽取是否成功，不表示候选人是否通过筛选。",
            "needs_full_image_reasoning 只在截图无法读取、关键字段相互冲突、或无法抽取足够事实时设为 true。",
            "不要输出筛选理由、结论解释、summary、cot 或额外文字。"
          ].join("\n")
        },
        ...imageParts
      ]
    }
  ];
}

function reasoningMessages(candidate, extraction) {
  return [
    {
      role: "system",
      content: [
        "你是严谨的招聘筛选助手。",
        "必须依据筛选标准和抽取事实判断；不要补充截图里没有的经历。",
        "证据不足或关键事实无法判断时，按筛选标准要求处理。",
        "只能返回严格 JSON。"
      ].join("")
    },
    {
      role: "user",
      content: [
        "请根据筛选标准和已抽取事实判断候选人是否通过。",
        "",
        `筛选标准:\n${candidate.criteria}`,
        "",
        `候选人: ${candidate.candidate_name || candidate.candidate_key}`,
        "",
        `抽取事实 JSON:\n${JSON.stringify(extraction, null, 2)}`,
        "",
        "返回 JSON 格式：",
        "{\"passed\": true/false, \"uncertain\": true/false}",
        "",
        "uncertain 只在抽取事实不足以做可靠判断、或需要回看完整图片推理时设为 true。",
        "不要输出筛选理由、结论解释、summary、cot 或额外文字。"
      ].join("\n")
    }
  ];
}

function hardFailGateMessages(candidate, extraction) {
  return [
    {
      role: "system",
      content: [
        "你是快速硬性淘汰检查器。",
        "只判断是否存在可以机械比较的硬性不通过，不做综合优劣排序。",
        "如果抽取事实已经清楚违反筛选标准中的硬条件、最低年限、学历门槛、稳定性门槛、产品/行业排除项或明确排除项，必须 hard_fail=true。",
        "如果筛选标准说明某类经历不计入，计算最低年限时必须排除这类经历。",
        "如果即使按对候选人有利的方式计算，仍然达不到硬性最低要求，也必须 hard_fail=true。",
        "只有事实不足、字段冲突、或需要回看图片才能决定时，才返回 uncertain=true。",
        "严禁为了节省时间牺牲召回；只能返回严格 JSON。"
      ].join("")
    },
    {
      role: "user",
      content: [
        "请只判断是否可以高置信度直接淘汰候选人。",
        "",
        `筛选标准:\n${candidate.criteria}`,
        "",
        `候选人: ${candidate.candidate_name || candidate.candidate_key}`,
        "",
        `抽取事实 JSON:\n${JSON.stringify(extraction, null, 2)}`,
        "",
        "返回 JSON 格式：",
        "{\"hard_fail\": true/false, \"continue_reasoning\": true/false, \"uncertain\": true/false}",
        "",
        "hard_fail=true 表示候选人已经明确不通过，后续无需 reasoning。",
        "如果 visible facts 足以确认硬性不通过，不要因为缺少解释性上下文而 uncertain。",
        "无法确认硬性不通过时，返回 hard_fail=false、continue_reasoning=true；需要回看图片或事实冲突时，uncertain=true。",
        "不要输出筛选理由、结论解释、summary、cot 或额外文字。"
      ].join("\n")
    }
  ];
}

function batchExtractionMessages(candidates, options) {
  const content = [
    {
      type: "text",
      text: [
        "请批量抽取候选人简历事实，不做通过/不通过判断。",
        "每个候选人都有自己的筛选标准；只抽取与该标准有关、且截图真实可见的信息。",
        "返回严格 JSON：",
        "{\"candidates\":[{\"candidate_key\":\"...\",\"extraction_ok\":true/false,\"facts\":{},\"needs_full_image_reasoning\":true/false}]}",
        "extraction_ok 只表示事实抽取是否成功，不表示候选人是否通过筛选。",
        "不要输出筛选理由、结论解释、summary、cot 或额外文字。",
        ""
      ].join("\n")
    }
  ];
  for (const candidate of candidates) {
    content.push({
      type: "text",
      text: [
        `候选人 candidate_key=${candidate.candidate_key}`,
        `候选人姓名=${candidate.candidate_name || ""}`,
        `筛选标准:\n${candidate.criteria}`,
        `下面 ${Math.min(candidate.image_paths.length, options.imageLimit || 8)} 张图属于这个候选人。`
      ].join("\n")
    });
    for (const filePath of candidate.image_paths.slice(0, options.imageLimit || 8)) {
      content.push(imagePathToContentPart(filePath, options.imageDetail || "low"));
    }
  }
  return [
    {
      role: "system",
      content: "你是简历事实抽取器。不要判断通过或不通过。不要编造。只能返回严格 JSON。"
    },
    { role: "user", content }
  ];
}

function shouldEscalateExtraction(extractionResult) {
  const parsed = extractionResult?.parsed || extractionResult;
  if (!extractionResult?.ok) return true;
  if (!parsed || typeof parsed !== "object") return true;
  if (parsed.extraction_ok === false || parsed.extractionOk === false) return true;
  if (parsed.needs_full_image_reasoning === true || parsed.needsFullImageReasoning === true) return true;
  if (!parsed.facts || typeof parsed.facts !== "object") return true;
  return false;
}

function parseReasoningDecision(reasonResult) {
  const parsed = reasonResult?.parsed || {};
  const passed = parseBooleanDecision(parsed.passed);
  const uncertain = parseBooleanDecision(parsed.uncertain ?? parsed.review_required ?? parsed.needs_review) === true;
  return {
    passed,
    uncertain,
    summary: ""
  };
}

function parseHardFailGateDecision(gateResult) {
  const parsed = gateResult?.parsed || {};
  const hardFail = parseBooleanDecision(
    parsed.hard_fail
    ?? parsed.hardFail
    ?? parsed.fail_fast
    ?? parsed.failFast
    ?? parsed.direct_fail
    ?? parsed.directFail
  ) === true;
  const uncertain = parseBooleanDecision(parsed.uncertain ?? parsed.review_required ?? parsed.needs_review) === true;
  const continueReasoning = parseBooleanDecision(
    parsed.continue_reasoning
    ?? parsed.continueReasoning
    ?? parsed.needs_reasoning
    ?? parsed.needsReasoning
  );
  return {
    hard_fail: hardFail,
    continue_reasoning: continueReasoning === null ? !hardFail : continueReasoning,
    uncertain,
    summary: ""
  };
}

function toStrategyResult(candidate, strategy, data) {
  const llmMs = numberValue(data.llm_ms ?? data.elapsed_ms);
  const projectedTotalMs = candidate.timing.saved_non_llm_ms + llmMs;
  const ok = Boolean(data.ok);
  const passed = typeof data.passed === "boolean" ? data.passed : null;
  const malformed = Boolean(data.malformed || !ok || (strategy !== "pipeline_simulation" && passed === null));
  return {
    strategy,
    run_id: candidate.run_id,
    candidate_key: candidate.candidate_key,
    candidate_name: candidate.candidate_name,
    criteria_hash: candidate.criteria_hash.slice(0, 16),
    image_hash: candidate.image_hash.slice(0, 16),
    ok,
    passed,
    decision_source: data.decision_source || strategy,
    summary: data.summary || "",
    error: data.error || "",
    cache_hit: Boolean(data.cache_hit),
    llm_ms: llmMs,
    extraction_ms: numberValue(data.extraction_ms),
    gate_ms: numberValue(data.gate_ms),
    reasoning_ms: numberValue(data.reasoning_ms),
    escalation_ms: numberValue(data.escalation_ms),
    projected_total_ms: projectedTotalMs,
    saved_non_llm_ms: candidate.timing.saved_non_llm_ms,
    saved_llm_ms: candidate.timing.saved_llm_ms,
    saved_total_ms: candidate.timing.saved_total_ms,
    image_count: candidate.image_count,
    escalated: Boolean(data.escalated),
    early_exit: Boolean(data.early_exit),
    malformed,
    raw: data.raw || null
  };
}

async function runFullImageStrategy(candidate, config, options, strategy, thinkingLevel) {
  return withCandidateCache(candidate, strategy, options, {
    thinking_level: thinkingLevel,
    image_limit: options.imageLimit || config.llmImageLimit || config.imageLimit || 8,
    image_detail: options.imageDetail || config.llmImageDetail || config.imageDetail || "low"
  }, async () => {
    const started = Date.now();
    try {
      const result = await callScreeningLlm({
        candidate: candidate.candidate,
        criteria: candidate.criteria,
        config: forceSinglePassConfig(config, thinkingLevel),
        timeoutMs: options.llmTimeoutMs || config.llmTimeoutMs || config.timeoutMs || 120000,
        imagePaths: candidate.image_paths,
        maxImages: options.imageLimit || config.llmImageLimit || config.imageLimit || 8,
        imageDetail: options.imageDetail || config.llmImageDetail || config.imageDetail || "low"
      });
      return {
        ok: Boolean(result.ok),
        passed: parseBooleanDecision(result.passed),
        summary: normalizeBlock(result.cot || result.decision_cot || result.raw_model_output),
        decision_source: strategy,
        llm_ms: Date.now() - started,
        raw: {
          provider: result.provider || null,
          usage: result.usage || null,
          finish_reason: result.finish_reason || null,
          attempt_count: result.attempt_count || 0,
          raw_model_output: result.raw_model_output || ""
        }
      };
    } catch (error) {
      return {
        ok: false,
        passed: null,
        decision_source: strategy,
        llm_ms: Date.now() - started,
        error: compactError(error).message,
        raw: { error: compactError(error) }
      };
    }
  });
}

async function runExtraction(candidate, config, options, strategyName) {
  return withCandidateCache(candidate, `${strategyName}:extract`, options, {
    thinking_level: options.extractThinkingLevel,
    image_limit: options.imageLimit || config.llmImageLimit || config.imageLimit || 8,
    image_detail: options.imageDetail || config.llmImageDetail || config.imageDetail || "low"
  }, async () => callJsonLlm({
    config,
    messages: extractionMessages(candidate, {
      ...options,
      imageLimit: options.imageLimit || config.llmImageLimit || config.imageLimit || 8,
      imageDetail: options.imageDetail || config.llmImageDetail || config.imageDetail || "low"
    }),
    thinkingLevel: options.extractThinkingLevel,
    timeoutMs: options.llmTimeoutMs || config.llmTimeoutMs || config.timeoutMs || 120000,
    maxTokens: 1000,
    responseFormat: options.responseFormat,
    stage: "extract"
  }));
}

async function runReasoning(candidate, extraction, config, options, strategyName) {
  return withCandidateCache(candidate, `${strategyName}:reason`, options, {
    thinking_level: options.reasonThinkingLevel,
    extraction_hash: hashJson(extraction?.parsed || extraction)
  }, async () => callJsonLlm({
    config,
    messages: reasoningMessages(candidate, extraction?.parsed || extraction),
    thinkingLevel: options.reasonThinkingLevel,
    timeoutMs: options.llmTimeoutMs || config.llmTimeoutMs || config.timeoutMs || 120000,
    maxTokens: 96,
    responseFormat: options.responseFormat,
    stage: "reason"
  }));
}

async function runHardFailGate(candidate, extraction, config, options, strategyName) {
  return withCandidateCache(candidate, `${strategyName}:hard_fail_gate`, options, {
    thinking_level: options.failGateThinkingLevel,
    extraction_hash: hashJson(extraction?.parsed || extraction),
    gate_version: HARD_GATE_VERSION
  }, async () => callJsonLlm({
    config,
    messages: hardFailGateMessages(candidate, extraction?.parsed || extraction),
    thinkingLevel: options.failGateThinkingLevel,
    timeoutMs: options.llmTimeoutMs || config.llmTimeoutMs || config.timeoutMs || 120000,
    maxTokens: 80,
    responseFormat: options.responseFormat,
    stage: "hard_fail_gate"
  }));
}

async function runEscalation(candidate, config, options, strategyName) {
  return runFullImageStrategy(
    candidate,
    config,
    options,
    `${strategyName}:escalate_full_image`,
    options.escalateThinkingLevel
  );
}

async function runExtractThenReasonCandidate(candidate, config, options, strategyName = "extract_then_reason") {
  return withCandidateCache(candidate, strategyName, options, {
    extract_thinking_level: options.extractThinkingLevel,
    reason_thinking_level: options.reasonThinkingLevel,
    escalate_thinking_level: options.escalateThinkingLevel,
    image_limit: options.imageLimit || config.llmImageLimit || config.imageLimit || 8,
    image_detail: options.imageDetail || config.llmImageDetail || config.imageDetail || "low"
  }, async () => {
    const extract = await runExtraction(candidate, config, options, strategyName);
    let extractionMs = numberValue(extract.elapsed_ms);
    if (shouldEscalateExtraction(extract)) {
      const escalation = await runEscalation(candidate, config, options, strategyName);
      return {
        ok: Boolean(escalation.ok),
        passed: typeof escalation.passed === "boolean" ? escalation.passed : null,
        summary: escalation.summary || "",
        decision_source: "escalate_full_image_after_extract",
        llm_ms: extractionMs + numberValue(escalation.llm_ms),
        extraction_ms: extractionMs,
        reasoning_ms: 0,
        escalation_ms: numberValue(escalation.llm_ms),
        escalated: true,
        malformed: !extract.ok,
        error: extract.ok ? "" : "extract_failed",
        raw: {
          extraction: extract,
          escalation
        }
      };
    }

    const reason = await runReasoning(candidate, extract, config, options, strategyName);
    const reasoningMs = numberValue(reason.elapsed_ms);
    const decision = parseReasoningDecision(reason);
    if (!reason.ok || decision.passed === null || decision.uncertain) {
      const escalation = await runEscalation(candidate, config, options, strategyName);
      return {
        ok: Boolean(escalation.ok),
        passed: typeof escalation.passed === "boolean" ? escalation.passed : null,
        summary: escalation.summary || "",
        decision_source: "escalate_full_image_after_reason",
        llm_ms: extractionMs + reasoningMs + numberValue(escalation.llm_ms),
        extraction_ms: extractionMs,
        reasoning_ms: reasoningMs,
        escalation_ms: numberValue(escalation.llm_ms),
        escalated: true,
        malformed: !reason.ok || decision.passed === null,
        error: reason.ok ? "" : "reason_failed",
        raw: {
          extraction: extract,
          reasoning: reason,
          escalation
        }
      };
    }

    return {
      ok: true,
      passed: decision.passed,
      summary: decision.summary,
      decision_source: "text_reasoning_from_extracted_facts",
      llm_ms: extractionMs + reasoningMs,
      extraction_ms: extractionMs,
      reasoning_ms: reasoningMs,
      escalation_ms: 0,
      escalated: false,
      malformed: false,
      raw: {
        extraction: extract,
        reasoning: reason
      }
    };
  });
}

async function runExtractHardGateThenReasonCandidate(candidate, config, options, strategyName = "extract_hard_gate_then_reason") {
  return withCandidateCache(candidate, strategyName, options, {
    extract_thinking_level: options.extractThinkingLevel,
    fail_gate_thinking_level: options.failGateThinkingLevel,
    reason_thinking_level: options.reasonThinkingLevel,
    escalate_thinking_level: options.escalateThinkingLevel,
    image_limit: options.imageLimit || config.llmImageLimit || config.imageLimit || 8,
    image_detail: options.imageDetail || config.llmImageDetail || config.imageDetail || "low",
    gate_version: HARD_GATE_VERSION
  }, async () => {
    const extract = await runExtraction(candidate, config, options, strategyName);
    const extractionMs = numberValue(extract.elapsed_ms);
    if (shouldEscalateExtraction(extract)) {
      const escalation = await runEscalation(candidate, config, options, strategyName);
      return {
        ok: Boolean(escalation.ok),
        passed: typeof escalation.passed === "boolean" ? escalation.passed : null,
        summary: escalation.summary || "",
        decision_source: "escalate_full_image_after_extract",
        llm_ms: extractionMs + numberValue(escalation.llm_ms),
        extraction_ms: extractionMs,
        gate_ms: 0,
        reasoning_ms: 0,
        escalation_ms: numberValue(escalation.llm_ms),
        escalated: true,
        early_exit: false,
        malformed: !extract.ok,
        error: extract.ok ? "" : "extract_failed",
        raw: {
          extraction: extract,
          escalation
        }
      };
    }

    const gate = await runHardFailGate(candidate, extract, config, options, strategyName);
    const gateMs = numberValue(gate.elapsed_ms);
    const gateDecision = parseHardFailGateDecision(gate);
    if (gate.ok && gateDecision.hard_fail && !gateDecision.uncertain) {
      return {
        ok: true,
        passed: false,
        summary: "",
        decision_source: "hard_fail_gate_from_extracted_facts",
        llm_ms: extractionMs + gateMs,
        extraction_ms: extractionMs,
        gate_ms: gateMs,
        reasoning_ms: 0,
        escalation_ms: 0,
        escalated: false,
        early_exit: true,
        malformed: false,
        raw: {
          extraction: extract,
          hard_fail_gate: gate
        }
      };
    }

    const reason = await runReasoning(candidate, extract, config, options, strategyName);
    const reasoningMs = numberValue(reason.elapsed_ms);
    const decision = parseReasoningDecision(reason);
    if (!reason.ok || decision.passed === null || decision.uncertain) {
      const escalation = await runEscalation(candidate, config, options, strategyName);
      return {
        ok: Boolean(escalation.ok),
        passed: typeof escalation.passed === "boolean" ? escalation.passed : null,
        summary: escalation.summary || "",
        decision_source: "escalate_full_image_after_reason",
        llm_ms: extractionMs + gateMs + reasoningMs + numberValue(escalation.llm_ms),
        extraction_ms: extractionMs,
        gate_ms: gateMs,
        reasoning_ms: reasoningMs,
        escalation_ms: numberValue(escalation.llm_ms),
        escalated: true,
        early_exit: false,
        malformed: !reason.ok || decision.passed === null,
        error: reason.ok ? "" : "reason_failed",
        raw: {
          extraction: extract,
          hard_fail_gate: gate,
          reasoning: reason,
          escalation
        }
      };
    }

    return {
      ok: true,
      passed: decision.passed,
      summary: decision.summary,
      decision_source: gate.ok ? "text_reasoning_after_hard_fail_gate" : "text_reasoning_after_gate_error",
      llm_ms: extractionMs + gateMs + reasoningMs,
      extraction_ms: extractionMs,
      gate_ms: gateMs,
      reasoning_ms: reasoningMs,
      escalation_ms: 0,
      escalated: false,
      early_exit: false,
      malformed: false,
      raw: {
        extraction: extract,
        hard_fail_gate: gate,
        reasoning: reason
      }
    };
  });
}

async function runBatchExtraction(batch, config, options) {
  const batchKey = sha256(JSON.stringify({
    strategy: "batch_extract_then_reason:batch_extract",
    benchmark_version: BENCHMARK_VERSION,
    candidates: batch.map((candidate) => ({
      run_id: candidate.run_id,
      candidate_key: candidate.candidate_key,
      criteria_hash: candidate.criteria_hash,
      image_hash: candidate.image_hash
    })),
    thinking_level: options.extractThinkingLevel,
    image_limit: options.imageLimit || config.llmImageLimit || config.imageLimit || 8,
    image_detail: options.imageDetail || config.llmImageDetail || config.imageDetail || "low"
  }));
  const cached = readCache(options, batchKey);
  if (cached) return { ...cached, cache_hit: true, cache_key: batchKey };
  const result = await callJsonLlm({
    config,
    messages: batchExtractionMessages(batch, {
      ...options,
      imageLimit: options.imageLimit || config.llmImageLimit || config.imageLimit || 8,
      imageDetail: options.imageDetail || config.llmImageDetail || config.imageDetail || "low"
    }),
    thinkingLevel: options.extractThinkingLevel,
    timeoutMs: options.llmTimeoutMs || config.llmTimeoutMs || config.timeoutMs || 120000,
    maxTokens: Math.max(1200, batch.length * 650),
    responseFormat: options.responseFormat,
    stage: "batch_extract"
  });
  writeCache(options, batchKey, result);
  return { ...result, cache_hit: false, cache_key: batchKey };
}

async function runBatchExtractThenReason(candidates, config, options, strategyName = "batch_extract_then_reason", useHardGate = false) {
  const results = [];
  const pending = [];
  for (const candidate of candidates) {
    const finalKey = cacheKeyFor(candidate, strategyName, {
      extract_thinking_level: options.extractThinkingLevel,
      fail_gate_thinking_level: useHardGate ? options.failGateThinkingLevel : "",
      reason_thinking_level: options.reasonThinkingLevel,
      batch_size: options.batchSize,
      gate_version: useHardGate ? HARD_GATE_VERSION : 0
    });
    const cached = readCache(options, finalKey);
    if (cached) {
      results.push(toStrategyResult(candidate, strategyName, { ...cached, cache_hit: true }));
    } else {
      pending.push({ candidate, finalKey });
    }
  }

  for (let index = 0; index < pending.length; index += options.batchSize) {
    const group = pending.slice(index, index + options.batchSize);
    const batch = group.map((item) => item.candidate);
    const batchExtract = await runBatchExtraction(batch, config, options);
    const parsedCandidates = Array.isArray(batchExtract?.parsed?.candidates)
      ? batchExtract.parsed.candidates
      : [];
    const byKey = new Map(parsedCandidates.map((item) => [normalizeText(item?.candidate_key), item]));
    for (const item of group) {
      const candidate = item.candidate;
      let extraction = {
        ok: Boolean(batchExtract.ok),
        parsed: byKey.get(candidate.candidate_key) || null,
        elapsed_ms: batch.length ? Math.round(numberValue(batchExtract.elapsed_ms) / batch.length) : numberValue(batchExtract.elapsed_ms),
        raw_model_output: batchExtract.raw_model_output || "",
        usage: batchExtract.usage || null,
        provider: batchExtract.provider || null
      };
      if (!extraction.parsed) {
        extraction = await runExtraction(candidate, config, options, `${strategyName}:fallback_single_extract`);
      }

      let value;
      const extractionMs = numberValue(extraction.elapsed_ms);
      if (shouldEscalateExtraction(extraction)) {
        const escalation = await runEscalation(candidate, config, options, strategyName);
        value = {
          ok: Boolean(escalation.ok),
          passed: typeof escalation.passed === "boolean" ? escalation.passed : null,
          summary: escalation.summary || "",
          decision_source: "escalate_full_image_after_batch_extract",
          llm_ms: extractionMs + numberValue(escalation.llm_ms),
          extraction_ms: extractionMs,
          gate_ms: 0,
          reasoning_ms: 0,
          escalation_ms: numberValue(escalation.llm_ms),
          escalated: true,
          early_exit: false,
          malformed: !extraction.ok,
          raw: { extraction, escalation }
        };
      } else {
        let gate = null;
        let gateMs = 0;
        let gateDecision = null;
        if (useHardGate) {
          gate = await runHardFailGate(candidate, extraction, config, options, strategyName);
          gateMs = numberValue(gate.elapsed_ms);
          gateDecision = parseHardFailGateDecision(gate);
        }
        if (useHardGate && gate?.ok && gateDecision?.hard_fail && !gateDecision?.uncertain) {
          value = {
            ok: true,
            passed: false,
            summary: "",
            decision_source: "hard_fail_gate_from_batch_extracted_facts",
            llm_ms: extractionMs + gateMs,
            extraction_ms: extractionMs,
            gate_ms: gateMs,
            reasoning_ms: 0,
            escalation_ms: 0,
            escalated: false,
            early_exit: true,
            malformed: false,
            raw: { extraction, hard_fail_gate: gate }
          };
        } else {
        const reason = await runReasoning(candidate, extraction, config, options, strategyName);
        const reasoningMs = numberValue(reason.elapsed_ms);
        const decision = parseReasoningDecision(reason);
        if (!reason.ok || decision.passed === null || decision.uncertain) {
          const escalation = await runEscalation(candidate, config, options, strategyName);
          value = {
            ok: Boolean(escalation.ok),
            passed: typeof escalation.passed === "boolean" ? escalation.passed : null,
            summary: escalation.summary || "",
            decision_source: "escalate_full_image_after_batch_reason",
            llm_ms: extractionMs + gateMs + reasoningMs + numberValue(escalation.llm_ms),
            extraction_ms: extractionMs,
            gate_ms: gateMs,
            reasoning_ms: reasoningMs,
            escalation_ms: numberValue(escalation.llm_ms),
            escalated: true,
            early_exit: false,
            malformed: !reason.ok || decision.passed === null,
            raw: { extraction, hard_fail_gate: gate, reasoning: reason, escalation }
          };
        } else {
          value = {
            ok: true,
            passed: decision.passed,
            summary: decision.summary,
            decision_source: useHardGate
              ? (gate?.ok ? "text_reasoning_after_batch_hard_fail_gate" : "text_reasoning_after_batch_gate_error")
              : "text_reasoning_from_batch_extracted_facts",
            llm_ms: extractionMs + gateMs + reasoningMs,
            extraction_ms: extractionMs,
            gate_ms: gateMs,
            reasoning_ms: reasoningMs,
            escalation_ms: 0,
            escalated: false,
            early_exit: false,
            malformed: false,
            raw: { extraction, hard_fail_gate: gate, reasoning: reason }
          };
        }
        }
      }
      writeCache(options, item.finalKey, value);
      results.push(toStrategyResult(candidate, strategyName, value));
    }
  }
  return results;
}

function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return 0;
  return Math.round(usable.reduce((sum, value) => sum + value, 0) / usable.length);
}

function summarizeStrategy(strategy, rows, oracleByKey, options) {
  if (strategy === "pipeline_simulation") {
    return summarizePipelineSimulation(rows, options);
  }
  const comparable = rows.filter((row) => typeof oracleByKey.get(row.candidate_key)?.passed === "boolean" && typeof row.passed === "boolean");
  const falseNegatives = comparable.filter((row) => oracleByKey.get(row.candidate_key).passed === true && row.passed === false).length;
  const falsePositives = comparable.filter((row) => oracleByKey.get(row.candidate_key).passed === false && row.passed === true).length;
  const oraclePassRate = comparable.length
    ? comparable.filter((row) => oracleByKey.get(row.candidate_key).passed === true).length / comparable.length
    : 0;
  const passRate = comparable.length
    ? comparable.filter((row) => row.passed === true).length / comparable.length
    : 0;
  const projected = rows.map((row) => row.projected_total_ms);
  const llm = rows.map((row) => row.llm_ms);
  const gate = rows.map((row) => row.gate_ms);
  const avgProjected = average(projected);
  const malformedCount = rows.filter((row) => row.malformed || !row.ok || typeof row.passed !== "boolean").length;
  const eligible = (
    strategy !== "oracle_full_image_high"
    && rows.length > 0
    && avgProjected < options.targetAvgMs
    && falseNegatives <= options.maxFalseNegatives
    && malformedCount === 0
  );
  return {
    strategy,
    quality_applicable: strategy !== "oracle_full_image_high",
    candidate_count: rows.length,
    ok_count: rows.filter((row) => row.ok).length,
    cache_hit_count: rows.filter((row) => row.cache_hit).length,
    pass_count: rows.filter((row) => row.passed === true).length,
    pass_rate: Number(passRate.toFixed(4)),
    oracle_pass_rate: Number(oraclePassRate.toFixed(4)),
    pass_rate_drift: Number((passRate - oraclePassRate).toFixed(4)),
    false_negatives: falseNegatives,
    false_positives: falsePositives,
    malformed_count: malformedCount,
    escalation_count: rows.filter((row) => row.escalated).length,
    early_exit_count: rows.filter((row) => row.early_exit).length,
    avg_llm_ms: average(llm),
    p50_llm_ms: percentile(llm, 0.5),
    p90_llm_ms: percentile(llm, 0.9),
    avg_gate_ms: average(gate),
    avg_projected_total_ms: avgProjected,
    p50_projected_total_ms: percentile(projected, 0.5),
    p90_projected_total_ms: percentile(projected, 0.9),
    eligible,
    eligibility: {
      target_avg_ms: options.targetAvgMs,
      max_false_negatives: options.maxFalseNegatives,
      avg_latency_ok: avgProjected < options.targetAvgMs,
      false_negative_ok: falseNegatives <= options.maxFalseNegatives,
      malformed_ok: malformedCount === 0
    }
  };
}

function summarizePipelineSimulation(allRows, options) {
  const baselineRows = allRows.filter((row) => row.strategy === "baseline_full_image_reasoning");
  if (!baselineRows.length) {
    return {
      strategy: "pipeline_simulation",
      quality_applicable: false,
      candidate_count: 0,
      note: "Run baseline_full_image_reasoning to compute pipeline simulation.",
      eligible: false
    };
  }
  const serialTotal = baselineRows.reduce((sum, row) => sum + numberValue(row.projected_total_ms), 0);
  const acquisitionTotal = baselineRows.reduce((sum, row) => sum + numberValue(row.raw?.timing?.acquisition_ms ?? row.saved_non_llm_ms), 0);
  const llmTotal = baselineRows.reduce((sum, row) => sum + numberValue(row.llm_ms), 0);
  const postTotal = baselineRows.reduce((sum, row) => sum + numberValue(row.raw?.timing?.post_llm_ms), 0);
  const lowerBoundTotal = Math.max(acquisitionTotal, llmTotal) + postTotal;
  const avgProjected = Math.round(lowerBoundTotal / baselineRows.length);
  return {
    strategy: "pipeline_simulation",
    quality_applicable: false,
    candidate_count: baselineRows.length,
    serial_total_ms: Math.round(serialTotal),
    simulated_lower_bound_total_ms: Math.round(lowerBoundTotal),
    avg_projected_total_ms: avgProjected,
    note: "Lower-bound estimate only; real implementation would need delayed/reopen handling for post-actions.",
    eligible: avgProjected < options.targetAvgMs
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(options.outDir || path.join(DEFAULT_OUTPUT_DIR, timestamp));
  options.outDir = outDir;
  ensureDir(outDir);
  ensureDir(options.cacheDir);

  const replay = loadReplayCandidates(options);
  const manifest = {
    benchmark_version: BENCHMARK_VERSION,
    created_at: new Date().toISOString(),
    dry_run: options.dryRun,
    run_paths: replay.run_paths,
    strategy_order: options.strategies,
    replay_candidate_count: replay.candidates.length,
    excluded_candidate_count: replay.excluded.length,
    excluded: replay.excluded.map((item) => ({
      run_id: item.run_id,
      candidate_key: item.candidate_key,
      candidate_name: item.candidate_name,
      exclude_reason: item.exclude_reason,
      image_count: item.image_count,
      criteria_hash: item.criteria_hash?.slice?.(0, 16) || ""
    })),
    candidates: replay.candidates.map((candidate) => ({
      run_id: candidate.run_id,
      candidate_key: candidate.candidate_key,
      candidate_name: candidate.candidate_name,
      criteria_hash: candidate.criteria_hash.slice(0, 16),
      image_hash: candidate.image_hash.slice(0, 16),
      image_count: candidate.image_count,
      saved_passed: candidate.saved_passed,
      saved_cv_source: candidate.saved_cv_source,
      timing: candidate.timing
    }))
  };
  writeJson(path.join(outDir, "benchmark-manifest.json"), manifest);

  if (options.dryRun) {
    const summary = {
      ...manifest,
      status: "dry_run_complete",
      message: "Dry run loaded saved candidates only; no LLM calls were made."
    };
    writeJson(path.join(outDir, "benchmark-summary.json"), summary);
    console.log(JSON.stringify({
      status: "dry_run_complete",
      out_dir: outDir,
      replay_candidate_count: replay.candidates.length,
      excluded_candidate_count: replay.excluded.length
    }, null, 2));
    return;
  }

  if (!replay.candidates.length) {
    throw new Error("No replayable saved candidates found. Use --run/--run-dir or check saved image artifacts.");
  }

  const config = loadConfig(options);
  const allResults = [];

  for (const strategy of options.strategies) {
    if (strategy === "pipeline_simulation") continue;
    if (strategy === "batch_extract_then_reason") {
      const rows = await runBatchExtractThenReason(replay.candidates, config, options, strategy, false);
      allResults.push(...rows);
      continue;
    }
    if (strategy === "batch_extract_hard_gate_then_reason") {
      const rows = await runBatchExtractThenReason(replay.candidates, config, options, strategy, true);
      allResults.push(...rows);
      continue;
    }

    for (const candidate of replay.candidates) {
      let value;
      if (strategy === "oracle_full_image_high") {
        value = await runFullImageStrategy(candidate, config, options, strategy, options.oracleThinkingLevel);
      } else if (strategy === "baseline_full_image_reasoning") {
        value = await runFullImageStrategy(candidate, config, options, strategy, options.baselineThinkingLevel);
      } else if (strategy === "extract_then_reason") {
        value = await runExtractThenReasonCandidate(candidate, config, options, strategy);
      } else if (strategy === "extract_hard_gate_then_reason") {
        value = await runExtractHardGateThenReasonCandidate(candidate, config, options, strategy);
      } else if (FULL_IMAGE_STRATEGIES.has(strategy)) {
        value = await runFullImageStrategy(candidate, config, options, strategy, "low");
      } else {
        throw new Error(`No runner for strategy: ${strategy}`);
      }
      const row = toStrategyResult(candidate, strategy, {
        ...value,
        raw: {
          ...(value.raw || {}),
          timing: candidate.timing
        }
      });
      allResults.push(row);
      console.log(JSON.stringify({
        strategy,
        run_id: candidate.run_id,
        candidate_key: candidate.candidate_key,
        passed: row.passed,
        llm_ms: row.llm_ms,
        gate_ms: row.gate_ms,
        projected_total_ms: row.projected_total_ms,
        early_exit: row.early_exit,
        cache_hit: row.cache_hit
      }));
    }
  }

  const oracleRows = allResults.filter((row) => row.strategy === "oracle_full_image_high");
  const oracleByKey = new Map(oracleRows.map((row) => [row.candidate_key, row]));
  const strategySummaries = [];
  for (const strategy of options.strategies) {
    if (strategy === "pipeline_simulation") {
      strategySummaries.push(summarizePipelineSimulation(allResults, options));
      continue;
    }
    strategySummaries.push(summarizeStrategy(
      strategy,
      allResults.filter((row) => row.strategy === strategy),
      oracleByKey,
      options
    ));
  }

  const disagreementRows = allResults.filter((row) => {
    if (row.strategy === "oracle_full_image_high" || row.strategy === "pipeline_simulation") return false;
    const oracle = oracleByKey.get(row.candidate_key);
    return typeof oracle?.passed === "boolean" && typeof row.passed === "boolean" && oracle.passed !== row.passed;
  }).map((row) => ({
    strategy: row.strategy,
    run_id: row.run_id,
    candidate_key: row.candidate_key,
    candidate_name: row.candidate_name,
    oracle_passed: oracleByKey.get(row.candidate_key)?.passed,
    strategy_passed: row.passed,
    decision_source: row.decision_source,
    summary: row.summary,
    projected_total_ms: row.projected_total_ms,
    llm_ms: row.llm_ms
  }));

  const summary = {
    benchmark_version: BENCHMARK_VERSION,
    created_at: new Date().toISOString(),
    out_dir: outDir,
    run_paths: replay.run_paths,
    replay_candidate_count: replay.candidates.length,
    excluded_candidate_count: replay.excluded.length,
    criteria_source: "per saved run: result.screen_params.criteria with context/instruction fallback",
    oracle: {
      strategy: "oracle_full_image_high",
      thinking_level: options.oracleThinkingLevel,
      description: "Quality source of truth for pass/fail comparisons."
    },
    target: {
      average_projected_total_ms: options.targetAvgMs,
      max_false_negatives: options.maxFalseNegatives
    },
    strategies: strategySummaries,
    disagreements: {
      count: disagreementRows.length,
      false_negative_count: disagreementRows.filter((row) => row.oracle_passed === true && row.strategy_passed === false).length,
      false_positive_count: disagreementRows.filter((row) => row.oracle_passed === false && row.strategy_passed === true).length
    }
  };

  writeJson(path.join(outDir, "benchmark-summary.json"), summary);
  writeJson(path.join(outDir, "benchmark-results.json"), allResults);
  writeCsv(path.join(outDir, "benchmark-results.csv"), allResults.map((row) => ({
    strategy: row.strategy,
    run_id: row.run_id,
    candidate_key: row.candidate_key,
    candidate_name: row.candidate_name,
    ok: row.ok,
    passed: row.passed,
    oracle_passed: oracleByKey.get(row.candidate_key)?.passed ?? "",
    decision_source: row.decision_source,
    cache_hit: row.cache_hit,
    llm_ms: row.llm_ms,
    extraction_ms: row.extraction_ms,
    gate_ms: row.gate_ms,
    reasoning_ms: row.reasoning_ms,
    escalation_ms: row.escalation_ms,
    projected_total_ms: row.projected_total_ms,
    saved_non_llm_ms: row.saved_non_llm_ms,
    saved_llm_ms: row.saved_llm_ms,
    saved_total_ms: row.saved_total_ms,
    image_count: row.image_count,
    escalated: row.escalated,
    early_exit: row.early_exit,
    malformed: row.malformed,
    error: row.error,
    summary: row.summary
  })), [
    "strategy",
    "run_id",
    "candidate_key",
    "candidate_name",
    "ok",
    "passed",
    "oracle_passed",
    "decision_source",
    "cache_hit",
    "llm_ms",
    "extraction_ms",
    "gate_ms",
    "reasoning_ms",
    "escalation_ms",
    "projected_total_ms",
    "saved_non_llm_ms",
    "saved_llm_ms",
    "saved_total_ms",
    "image_count",
    "escalated",
    "early_exit",
    "malformed",
    "error",
    "summary"
  ]);
  writeCsv(path.join(outDir, "benchmark-disagreements.csv"), disagreementRows, [
    "strategy",
    "run_id",
    "candidate_key",
    "candidate_name",
    "oracle_passed",
    "strategy_passed",
    "decision_source",
    "projected_total_ms",
    "llm_ms",
    "summary"
  ]);

  console.log(JSON.stringify({
    status: "complete",
    out_dir: outDir,
    replay_candidate_count: replay.candidates.length,
    excluded_candidate_count: replay.excluded.length,
    strategies: strategySummaries.map((item) => ({
      strategy: item.strategy,
      avg_projected_total_ms: item.avg_projected_total_ms,
      false_negatives: item.false_negatives,
      false_positives: item.false_positives,
      eligible: item.eligible
    })),
    disagreements: summary.disagreements
  }, null, 2));
}

run().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
