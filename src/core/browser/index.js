import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";

export const DEFAULT_CHROME_HOST = "127.0.0.1";
export const DEFAULT_CHROME_PORT = 9222;
export const BOSS_LOGIN_URL = "https://www.zhipin.com/web/user/?ka=bticket";
export const LID_CLOSED_SAFE_CHROME_ARGS = [
  "--disable-backgrounding-occluded-windows",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-features=CalculateNativeWinOcclusion"
];

export const ALLOWED_CDP_DOMAINS = new Set([
  "Accessibility",
  "Browser",
  "DOM",
  "Input",
  "Network",
  "Page",
  "Target"
]);

export const FORBIDDEN_CDP_DOMAINS = new Set(["Runtime"]);

const BOSS_LOGIN_URL_PATTERN = /(?:zhipin\.com\/web\/user(?:\/|\?|$)|passport\.zhipin\.com|login\.zhipin\.com)/i;
const BOSS_LOGIN_TEXT_PATTERN = /扫码登录|验证码登录|密码登录|登录后|请登录|登录BOSS直聘|Boss登录|BOSS登录/i;
const CHROME_DEBUG_UNAVAILABLE_PATTERN = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|connect|socket hang up/i;
const BOSS_LOGIN_DOM_SELECTORS = [
  ".login-box",
  ".login-form",
  ".login-dialog",
  ".sign-form",
  ".qrcode-box",
  ".user-login",
  "input[name='phone']",
  "input[placeholder*='手机号']",
  "input[placeholder*='验证码']"
];
const HUMAN_INTERACTION_CONFIG = new WeakMap();
const DEFAULT_HUMAN_BEHAVIOR_PROFILE = "paced_with_rests";
export const DETERMINISTIC_CLICK_OPTIONS = Object.freeze({
  humanRestEnabled: false
});
const HUMAN_BEHAVIOR_PROFILES = Object.freeze({
  baseline: Object.freeze({
    enabled: false,
    clickMovement: false,
    textEntry: false,
    listScrollJitter: false,
    shortRest: false,
    batchRest: false,
    actionCooldown: false
  }),
  paced: Object.freeze({
    enabled: true,
    clickMovement: true,
    textEntry: true,
    listScrollJitter: true,
    shortRest: false,
    batchRest: false,
    actionCooldown: true
  }),
  paced_with_rests: Object.freeze({
    enabled: true,
    clickMovement: true,
    textEntry: true,
    listScrollJitter: true,
    shortRest: true,
    batchRest: true,
    actionCooldown: true
  })
});
const HUMAN_BEHAVIOR_PROFILE_ALIASES = Object.freeze({
  off: "baseline",
  disabled: "baseline",
  deterministic: "baseline",
  safe: "paced",
  safe_pacing: "paced",
  paced_with_rest: "paced_with_rests",
  rests: "paced_with_rests",
  rest: "paced_with_rests"
});

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function randomBetween(random, min, max) {
  const lower = Number(min) || 0;
  const upper = Number(max) || lower;
  if (upper <= lower) return lower;
  return lower + random() * (upper - lower);
}

function randomIntegerBetween(random, min, max) {
  return Math.floor(randomBetween(random, min, max + 1));
}

function normalizePoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function normalizeRandom(random) {
  return typeof random === "function" ? random : Math.random;
}

function getHumanInteractionConfig(client) {
  return HUMAN_INTERACTION_CONFIG.get(client) || null;
}

function normalizeBooleanOption(raw, fallback = null) {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw !== 0;
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["true", "1", "yes", "y", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function readFirstOption(source, keys = []) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function normalizeFeatureBoolean(raw, fallback) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return normalizeBooleanOption(readFirstOption(raw, ["enabled", "enable"]), fallback);
  }
  return normalizeBooleanOption(raw, fallback);
}

export function normalizeHumanBehaviorProfile(raw, fallback = "baseline") {
  const normalized = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const profile = HUMAN_BEHAVIOR_PROFILE_ALIASES[normalized] || normalized;
  return Object.prototype.hasOwnProperty.call(HUMAN_BEHAVIOR_PROFILES, profile)
    ? profile
    : fallback;
}

export function normalizeHumanBehaviorOptions(raw = null, {
  legacyEnabled = false,
  safePacing = null,
  batchRestEnabled = null
} = {}) {
  const safePacingFlag = normalizeBooleanOption(safePacing, null);
  const batchRestFlag = normalizeBooleanOption(batchRestEnabled, null);
  let source = "default";
  let rawObject = {};
  if (typeof raw === "boolean") {
    rawObject = { enabled: raw };
    source = "boolean";
  } else if (typeof raw === "string") {
    rawObject = { profile: raw };
    source = "profile";
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    rawObject = raw;
    source = "object";
  }

  const explicitProfile = readFirstOption(rawObject, ["profile", "mode", "behaviorProfile", "behavior_profile"]);
  const enabledRaw = readFirstOption(rawObject, ["enabled", "enable", "human_behavior_enabled"]);
  const explicitEnabled = normalizeBooleanOption(enabledRaw, null);
  const inferredProfile = (raw === true || explicitEnabled === true) && legacyEnabled !== true && batchRestFlag !== true
    ? "paced"
    : legacyEnabled === true || batchRestFlag === true
    ? "paced_with_rests"
    : safePacingFlag === true
      ? "paced"
      : DEFAULT_HUMAN_BEHAVIOR_PROFILE;
  const profile = normalizeHumanBehaviorProfile(explicitProfile, inferredProfile);
  const profileDefaults = {
    ...HUMAN_BEHAVIOR_PROFILES[profile]
  };
  if (legacyEnabled === true && !explicitProfile) {
    Object.assign(profileDefaults, HUMAN_BEHAVIOR_PROFILES.paced_with_rests);
  } else if (safePacingFlag === true && !explicitProfile) {
    Object.assign(profileDefaults, HUMAN_BEHAVIOR_PROFILES.paced);
  }
  if (batchRestFlag === true && !explicitProfile) {
    Object.assign(profileDefaults, HUMAN_BEHAVIOR_PROFILES.paced_with_rests);
  }

  const hasExplicitEnabled = enabledRaw !== undefined;
  if (hasExplicitEnabled) {
    profileDefaults.enabled = normalizeBooleanOption(enabledRaw, profileDefaults.enabled);
  }
  if (!hasExplicitEnabled && (safePacingFlag === false || batchRestFlag === false) && !explicitProfile && legacyEnabled !== true) {
    profileDefaults.enabled = false;
  }
  if (!hasExplicitEnabled && (safePacingFlag === true || batchRestFlag === true || legacyEnabled === true)) {
    profileDefaults.enabled = true;
  }

  const enabled = profileDefaults.enabled === true;
  const clickMovement = normalizeFeatureBoolean(
    readFirstOption(rawObject, ["clickMovement", "click_movement", "click_movement_enabled"]),
    profileDefaults.clickMovement
  );
  const textEntry = normalizeFeatureBoolean(
    readFirstOption(rawObject, ["textEntry", "text_entry", "text_entry_enabled"]),
    profileDefaults.textEntry
  );
  const listScrollJitter = normalizeFeatureBoolean(
    readFirstOption(rawObject, ["listScrollJitter", "list_scroll_jitter", "scrollJitter", "scroll_jitter"]),
    profileDefaults.listScrollJitter
  );
  const actionCooldown = normalizeFeatureBoolean(
    readFirstOption(rawObject, ["actionCooldown", "action_cooldown", "readPause", "read_pause"]),
    profileDefaults.actionCooldown
  );
  let shortRest = normalizeFeatureBoolean(
    readFirstOption(rawObject, ["shortRest", "short_rest", "randomRest", "random_rest"]),
    profileDefaults.shortRest
  );
  let batchRest = normalizeFeatureBoolean(
    readFirstOption(rawObject, ["batchRest", "batch_rest", "batchRestEnabled", "batch_rest_enabled"]),
    profileDefaults.batchRest
  );
  if (batchRestFlag !== null) {
    batchRest = batchRestFlag;
    if (batchRestFlag === true && readFirstOption(rawObject, ["shortRest", "short_rest", "randomRest", "random_rest"]) === undefined) {
      shortRest = true;
    }
  }

  return {
    enabled,
    profile,
    source,
    clickMovement: enabled && clickMovement === true,
    textEntry: enabled && textEntry === true,
    listScrollJitter: enabled && listScrollJitter === true,
    shortRest: enabled && shortRest === true,
    batchRest: enabled && batchRest === true,
    actionCooldown: enabled && actionCooldown === true,
    restEnabled: enabled && (shortRest === true || batchRest === true)
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeTargetMatcher({ targetUrlIncludes, targetPredicate } = {}) {
  if (typeof targetPredicate === "function") return targetPredicate;
  if (targetUrlIncludes) {
    return (target) => String(target?.url || "").includes(targetUrlIncludes);
  }
  return (target) => target?.type === "page";
}

function isForbiddenMethod(methodName) {
  const [domain] = String(methodName || "").split(".");
  return FORBIDDEN_CDP_DOMAINS.has(domain);
}

function methodName(domain, method) {
  return `${String(domain)}.${String(method)}`;
}

function recordMethod(methodLog, method) {
  if (Array.isArray(methodLog)) {
    methodLog.push({ method, at: nowIso() });
  }
}

export function assertNoForbiddenCdpCalls(methodLog = []) {
  const forbidden = methodLog.filter((entry) => isForbiddenMethod(entry?.method));
  if (forbidden.length > 0) {
    const methods = forbidden.map((entry) => entry.method).join(", ");
    throw new Error(`Forbidden CDP methods were used: ${methods}`);
  }
}

export function humanDelay(baseMs, varianceMs, {
  minMs = 100,
  maxMs = 60000,
  random = Math.random
} = {}) {
  const nextRandom = normalizeRandom(random);
  const base = Math.max(0, Number(baseMs) || 0);
  const variance = Math.max(0, Number(varianceMs) || 0);
  const lower = Math.max(0, Number(minMs) || 0);
  const upper = Math.max(lower, Number(maxMs) || lower);
  if (variance <= 0) return Math.round(clampNumber(base, lower, upper));
  const u1 = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, nextRandom()));
  const u2 = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, nextRandom()));
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(clampNumber(base + z * variance, lower, upper));
}

export function generateBezierPath(start, end, {
  steps = 18,
  random = Math.random,
  controlJitterX = 100,
  controlJitterY = 60
} = {}) {
  const startPoint = normalizePoint(start);
  const endPoint = normalizePoint(end);
  if (!startPoint || !endPoint) {
    throw new Error("generateBezierPath requires finite start and end points");
  }
  const nextRandom = normalizeRandom(random);
  const safeSteps = Math.max(1, Math.floor(Number(steps) || 18));
  const midX = (startPoint.x + endPoint.x) / 2 + (nextRandom() - 0.5) * Math.max(0, Number(controlJitterX) || 0);
  const midY = (startPoint.y + endPoint.y) / 2 + (nextRandom() - 0.5) * Math.max(0, Number(controlJitterY) || 0);
  const path = [];
  for (let index = 0; index <= safeSteps; index += 1) {
    const t = index / safeSteps;
    const inverse = 1 - t;
    path.push({
      x: inverse * inverse * startPoint.x + 2 * inverse * t * midX + t * t * endPoint.x,
      y: inverse * inverse * startPoint.y + 2 * inverse * t * midY + t * t * endPoint.y
    });
  }
  return path;
}

export function configureHumanInteraction(client, {
  enabled = false,
  clickMovementEnabled = null,
  textEntryEnabled = null,
  safeClickPointEnabled = null,
  actionCooldownEnabled = null,
  random = Math.random,
  sleepFn = null,
  moveSteps = 18,
  moveJitterPx = 3,
  hoverJitterPx = 5,
  moveDelayMinMs = 5,
  moveDelayMaxMs = 23,
  hoverDelayMinMs = 10,
  hoverDelayMaxMs = 30,
  prePressBaseMs = 260,
  prePressVarianceMs = 80,
  holdVarianceMs = 30,
  safeClickMinWidth = 44,
  safeClickMinHeight = 28,
  safeClickInsetRatio = 0.22,
  safeClickMinInsetPx = 4,
  safeClickMaxInsetPx = 18,
  textChunkMinLength = 1,
  textChunkMaxLength = 5,
  textChunkDelayBaseMs = 55,
  textChunkDelayVarianceMs = 30
} = {}) {
  const previous = getHumanInteractionConfig(client);
  const normalizedEnabled = enabled === true;
  HUMAN_INTERACTION_CONFIG.set(client, {
    enabled: normalizedEnabled,
    clickMovementEnabled: normalizedEnabled && clickMovementEnabled !== false,
    textEntryEnabled: normalizedEnabled && textEntryEnabled !== false,
    safeClickPointEnabled: normalizedEnabled && safeClickPointEnabled !== false,
    actionCooldownEnabled: normalizedEnabled && actionCooldownEnabled !== false,
    random: normalizeRandom(random),
    sleepFn: typeof sleepFn === "function" ? sleepFn : sleep,
    moveSteps: Math.max(1, Math.floor(Number(moveSteps) || 18)),
    moveJitterPx: Math.max(0, Number(moveJitterPx) || 0),
    hoverJitterPx: Math.max(0, Number(hoverJitterPx) || 0),
    moveDelayMinMs: Math.max(0, Number(moveDelayMinMs) || 0),
    moveDelayMaxMs: Math.max(0, Number(moveDelayMaxMs) || 0),
    hoverDelayMinMs: Math.max(0, Number(hoverDelayMinMs) || 0),
    hoverDelayMaxMs: Math.max(0, Number(hoverDelayMaxMs) || 0),
    prePressBaseMs: Math.max(0, Number(prePressBaseMs) || 0),
    prePressVarianceMs: Math.max(0, Number(prePressVarianceMs) || 0),
    holdVarianceMs: Math.max(0, Number(holdVarianceMs) || 0),
    safeClickMinWidth: Math.max(1, Number(safeClickMinWidth) || 44),
    safeClickMinHeight: Math.max(1, Number(safeClickMinHeight) || 28),
    safeClickInsetRatio: clampNumber(safeClickInsetRatio, 0.05, 0.45),
    safeClickMinInsetPx: Math.max(0, Number(safeClickMinInsetPx) || 0),
    safeClickMaxInsetPx: Math.max(0, Number(safeClickMaxInsetPx) || 0),
    textChunkMinLength: Math.max(1, Math.floor(Number(textChunkMinLength) || 1)),
    textChunkMaxLength: Math.max(1, Math.floor(Number(textChunkMaxLength) || 5)),
    textChunkDelayBaseMs: Math.max(0, Number(textChunkDelayBaseMs) || 0),
    textChunkDelayVarianceMs: Math.max(0, Number(textChunkDelayVarianceMs) || 0),
    lastMousePoint: previous?.lastMousePoint || null
  });
  return () => {
    if (previous) {
      HUMAN_INTERACTION_CONFIG.set(client, previous);
    } else {
      HUMAN_INTERACTION_CONFIG.delete(client);
    }
  };
}

export function createHumanRestController({
  enabled = false,
  shortRestEnabled = true,
  batchRestEnabled = true,
  random = Math.random,
  shortRestProbability = 0.08,
  shortRestMinMs = 3000,
  shortRestMaxMs = 7000,
  batchThresholdBase = 25,
  batchThresholdJitter = 8,
  batchRestMinMs = 15000,
  batchRestMaxMs = 30000
} = {}) {
  const nextRandom = normalizeRandom(random);
  const state = {
    enabled: enabled === true,
    short_rest_enabled: enabled === true && shortRestEnabled !== false,
    batch_rest_enabled: enabled === true && batchRestEnabled !== false,
    rest_counter: 0,
    rest_threshold: Math.max(1, Math.floor(Number(batchThresholdBase) || 25) + Math.floor(nextRandom() * Math.max(1, Number(batchThresholdJitter) || 1))),
    rest_count: 0,
    total_rest_ms: 0
  };

  function resetThreshold() {
    state.rest_threshold = Math.max(1, Math.floor(Number(batchThresholdBase) || 25) + Math.floor(nextRandom() * Math.max(1, Number(batchThresholdJitter) || 1)));
  }

  async function takeBreakIfNeeded({ sleepFn = sleep } = {}) {
    if (!state.enabled) {
      return {
        enabled: false,
        rested: false,
        rest_counter: state.rest_counter,
        rest_threshold: state.rest_threshold,
        events: []
      };
    }
    const sleeper = typeof sleepFn === "function" ? sleepFn : sleep;
    state.rest_counter += 1;
    const events = [];
    if (state.short_rest_enabled && nextRandom() < Math.max(0, Number(shortRestProbability) || 0)) {
      const pauseMs = Math.round(randomBetween(nextRandom, shortRestMinMs, shortRestMaxMs));
      await sleeper(pauseMs);
      events.push({ kind: "random_rest", pause_ms: pauseMs });
    }
    if (state.batch_rest_enabled && state.rest_counter >= state.rest_threshold) {
      const pauseMs = Math.round(randomBetween(nextRandom, batchRestMinMs, batchRestMaxMs));
      await sleeper(pauseMs);
      events.push({
        kind: "batch_rest",
        pause_ms: pauseMs,
        processed_since_last_batch_rest: state.rest_counter
      });
      state.rest_counter = 0;
      resetThreshold();
    }
    const pauseMs = events.reduce((sum, event) => sum + event.pause_ms, 0);
    if (pauseMs > 0) {
      state.rest_count += events.length;
      state.total_rest_ms += pauseMs;
    }
    return {
      enabled: true,
      rested: events.length > 0,
      pause_ms: pauseMs,
      rest_counter: state.rest_counter,
      rest_threshold: state.rest_threshold,
      rest_count: state.rest_count,
      total_rest_ms: state.total_rest_ms,
      events
    };
  }

  return {
    takeBreakIfNeeded,
    getState() {
      return { ...state };
    }
  };
}

export function isBossLoginUrl(url) {
  return BOSS_LOGIN_URL_PATTERN.test(String(url || ""));
}

export function createBossLoginRequiredError({
  domain = "boss",
  currentUrl = "",
  targetUrl = "",
  loginUrl = BOSS_LOGIN_URL,
  loginDetection = null,
  chrome = null
} = {}) {
  const error = new Error(`Boss login is required before starting the ${domain} run.`);
  error.code = "BOSS_LOGIN_REQUIRED";
  error.requires_login = true;
  error.current_url = currentUrl || null;
  error.target_url = targetUrl || null;
  error.login_url = loginUrl;
  error.login_detection = loginDetection || null;
  error.chrome = chrome || null;
  error.retryable = true;
  return error;
}

export async function detectBossLoginState(client, { currentUrl = "" } = {}) {
  const inspectedUrl = currentUrl || await getMainFrameUrl(client).catch(() => "");
  if (isBossLoginUrl(inspectedUrl)) {
    return {
      requires_login: true,
      reason: "url",
      current_url: inspectedUrl,
      matched_selectors: []
    };
  }

  let root = null;
  try {
    root = await getDocumentRoot(client, { depth: 1, pierce: true });
  } catch (error) {
    return {
      requires_login: false,
      reason: "dom_unavailable",
      current_url: inspectedUrl,
      error: error?.message || String(error || "")
    };
  }

  const matchedSelectors = [];
  for (const selector of BOSS_LOGIN_DOM_SELECTORS) {
    const nodeId = await querySelector(client, root.nodeId, selector).catch(() => 0);
    if (nodeId) matchedSelectors.push(selector);
  }

  if (matchedSelectors.length === 0) {
    return {
      requires_login: false,
      reason: "no_login_dom",
      current_url: inspectedUrl,
      matched_selectors: []
    };
  }

  const html = await getOuterHTML(client, root.nodeId).catch(() => "");
  const looksLikeLogin = BOSS_LOGIN_TEXT_PATTERN.test(html);
  return {
    requires_login: looksLikeLogin,
    reason: looksLikeLogin ? "dom" : "login_selector_without_login_text",
    current_url: inspectedUrl,
    matched_selectors: matchedSelectors
  };
}

export function isChromeDebugUnavailableError(error) {
  return CHROME_DEBUG_UNAVAILABLE_PATTERN.test(String(error?.message || error || ""));
}

function pathExists(targetPath) {
  try {
    return Boolean(targetPath) && fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function isLocalChromeHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return !normalized || normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function getDefaultChromeExecutableCandidates() {
  const candidates = [
    process.env.BOSS_MCP_CHROME_PATH,
    process.env.BOSS_RECOMMEND_CHROME_PATH
  ].filter(Boolean);
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/snap/bin/chromium"
    );
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

export function getChromeExecutable() {
  return getDefaultChromeExecutableCandidates().find((candidate) => pathExists(candidate)) || null;
}

export function getBossChromeUserDataDir(port = DEFAULT_CHROME_PORT) {
  const sharedPath = path.join(getCodexHome(), "boss-mcp", `chrome-profile-${port}`);
  ensureDir(sharedPath);
  return sharedPath;
}

function parseExtraChromeArgs(value = "") {
  return String(value || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildBossChromeLaunchArgs({
  port = DEFAULT_CHROME_PORT,
  userDataDir = "",
  url = "about:blank",
  extraArgs = []
} = {}) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...LID_CLOSED_SAFE_CHROME_ARGS,
    ...parseExtraChromeArgs(process.env.BOSS_MCP_EXTRA_CHROME_ARGS),
    ...extraArgs,
    "--new-window",
    url
  ];
  return Array.from(new Set(args.filter(Boolean)));
}

export async function waitForChromeDebugPort({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  timeoutMs = 8000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      const targets = await listChromeTargets({ host, port });
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        targets
      };
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    error: lastError?.message || String(lastError || "Chrome debug port did not become ready")
  };
}

export async function launchChromeDebugInstance({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  url = "about:blank",
  slowLive = false
} = {}) {
  if (!isLocalChromeHost(host)) {
    throw new Error(`Cannot auto-launch Chrome for non-local debug host: ${host}`);
  }
  const chromePath = getChromeExecutable();
  if (!chromePath) {
    throw new Error("Chrome executable not found. Set BOSS_MCP_CHROME_PATH or BOSS_RECOMMEND_CHROME_PATH.");
  }
  const userDataDir = getBossChromeUserDataDir(port);
  const args = buildBossChromeLaunchArgs({ port, userDataDir, url });
  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  const readiness = await waitForChromeDebugPort({
    host,
    port,
    timeoutMs: slowLive ? 30000 : 12000,
    intervalMs: slowLive ? 700 : 300
  });
  if (!readiness.ok) {
    throw new Error(`Chrome launched but DevTools port ${port} did not become reachable: ${readiness.error}`);
  }
  return {
    launched: true,
    chrome_path: chromePath,
    user_data_dir: userDataDir,
    launch_args: args,
    port,
    url,
    readiness: {
      elapsed_ms: readiness.elapsed_ms,
      target_count: readiness.targets.length
    }
  };
}

export async function ensureChromeDebugPort({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  url = "about:blank",
  slowLive = false,
  launchIfMissing = true
} = {}) {
  try {
    const targets = await listChromeTargets({ host, port });
    return {
      launched: false,
      reused: true,
      port,
      target_count: targets.length
    };
  } catch (error) {
    if (!launchIfMissing || !isChromeDebugUnavailableError(error)) {
      throw error;
    }
    return launchChromeDebugInstance({ host, port, url, slowLive });
  }
}

export async function openChromeTarget({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  url
} = {}) {
  const encodedUrl = encodeURIComponent(url || "about:blank");
  const endpoint = `http://${host}:${port}/json/new?${encodedUrl}`;
  const methods = ["PUT", "GET"];
  let lastError = null;
  for (const method of methods) {
    try {
      const response = await fetch(endpoint, { method });
      if (response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {}
        return {
          ok: true,
          method,
          target_id: payload?.id || null,
          url: payload?.url || url || null
        };
      }
      lastError = new Error(`DevTools /json/new returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  return {
    ok: false,
    error: lastError?.message || "Failed to open Chrome target"
  };
}

export async function connectToChromeTargetOrOpen({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  targetUrlIncludes,
  targetPredicate,
  fallbackTargetPredicate,
  targetUrl,
  allowNavigate = true,
  slowLive = false,
  launchIfMissing = true
} = {}) {
  let chrome = null;
  if (allowNavigate && targetUrl) {
    chrome = await ensureChromeDebugPort({
      host,
      port,
      url: targetUrl,
      slowLive,
      launchIfMissing
    });
  }

  try {
    const session = await connectToChromeTarget({
      host,
      port,
      targetUrlIncludes,
      targetPredicate
    });
    return {
      ...session,
      chrome: {
        ...(chrome || { launched: false, reused: true, port }),
        target_created: false
      }
    };
  } catch (primaryError) {
    if (!allowNavigate) throw primaryError;

    if (typeof fallbackTargetPredicate === "function") {
      try {
        const session = await connectToChromeTarget({
          host,
          port,
          targetPredicate: fallbackTargetPredicate
        });
        return {
          ...session,
          chrome: {
            ...(chrome || { launched: false, reused: true, port }),
            target_created: false,
            fallback_target: true
          }
        };
      } catch {}
    }

    let openAttempt = null;
    if (targetUrl) {
      openAttempt = await openChromeTarget({ host, port, url: targetUrl });
      if (openAttempt.ok) {
        const session = await connectToChromeTarget({
          host,
          port,
          targetPredicate: (target) => (
            (openAttempt.target_id && target?.id === openAttempt.target_id)
            || String(target?.url || "").includes(targetUrlIncludes || targetUrl)
            || (targetUrl.includes("zhipin.com") && String(target?.url || "").includes("zhipin.com"))
          )
        });
        return {
          ...session,
          chrome: {
            ...(chrome || { launched: false, reused: true, port }),
            target_created: true,
            open_attempt: openAttempt
          }
        };
      }
    }

    const session = await connectToChromeTarget({
      host,
      port,
      targetPredicate: (target) => target?.type === "page"
    });
    return {
      ...session,
      chrome: {
        ...(chrome || { launched: false, reused: true, port }),
        target_created: false,
        open_attempt: openAttempt,
        fallback_any_page: true
      }
    };
  }
}

export function createGuardedCdpClient(client, { methodLog = [] } = {}) {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "send") {
        return async (method, params = {}) => {
          if (isForbiddenMethod(method)) {
            throw new Error(`Forbidden CDP method blocked: ${method}`);
          }
          recordMethod(methodLog, method);
          return target.send(method, params);
        };
      }

      const value = Reflect.get(target, property, receiver);
      if (!value || typeof value !== "object") return value;

      return new Proxy(value, {
        get(domainTarget, method, domainReceiver) {
          const domainValue = Reflect.get(domainTarget, method, domainReceiver);
          if (typeof domainValue !== "function") return domainValue;

          return async (params = {}) => {
            const fullMethod = methodName(property, method);
            if (isForbiddenMethod(fullMethod)) {
              throw new Error(`Forbidden CDP method blocked: ${fullMethod}`);
            }
            recordMethod(methodLog, fullMethod);
            return domainValue.call(domainTarget, params);
          };
        }
      });
    }
  });
}

export async function listChromeTargets({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT
} = {}) {
  return CDP.List({ host, port });
}

export async function connectToChromeTarget({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  targetUrlIncludes,
  targetPredicate
} = {}) {
  const targets = await listChromeTargets({ host, port });
  const matcher = normalizeTargetMatcher({ targetUrlIncludes, targetPredicate });
  const target = targets.find(matcher);
  if (!target) {
    const urls = targets.map((item) => item.url).filter(Boolean).join("\n");
    throw new Error(`No matching Chrome target found on ${host}:${port}.\nAvailable targets:\n${urls}`);
  }

  const rawClient = await CDP({ host, port, target });
  const methodLog = [];
  const client = createGuardedCdpClient(rawClient, { methodLog });

  return {
    client,
    rawClient,
    target,
    methodLog,
    async close() {
      await rawClient.close();
    }
  };
}

export async function assertRuntimeEvaluateBlocked(client) {
  try {
    await client.Runtime.evaluate({ expression: "1" });
  } catch (error) {
    if (/Forbidden CDP method blocked: Runtime\.evaluate/.test(String(error?.message || ""))) {
      return { blocked: true, message: error.message };
    }
    throw error;
  }
  throw new Error("Runtime.evaluate was not blocked by the CDP guard");
}

export async function enableDomains(client, domains = ["Page", "DOM", "Input"]) {
  for (const domain of domains) {
    if (!ALLOWED_CDP_DOMAINS.has(domain)) {
      throw new Error(`CDP domain is not allowed by the CDP-only contract: ${domain}`);
    }
    if (typeof client?.[domain]?.enable === "function") {
      await client[domain].enable();
    }
  }
}

export async function bringPageToFront(client) {
  if (typeof client?.Page?.bringToFront === "function") {
    await client.Page.bringToFront();
  }
}

export async function getPageFrameTree(client) {
  const result = await client.Page.getFrameTree();
  return result.frameTree || null;
}

export async function getMainFrame(client) {
  const frameTree = await getPageFrameTree(client);
  return frameTree?.frame || null;
}

export async function getMainFrameUrl(client) {
  const frame = await getMainFrame(client);
  return frame?.url || "";
}

export async function waitForMainFrameUrl(client, predicate, {
  timeoutMs = 10000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let lastUrl = "";
  while (Date.now() - started <= timeoutMs) {
    lastUrl = await getMainFrameUrl(client);
    if (predicate(lastUrl)) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        url: lastUrl
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    url: lastUrl
  };
}

export async function getDocumentRoot(client, { depth = 1, pierce = true } = {}) {
  const result = await client.DOM.getDocument({ depth, pierce });
  return result.root;
}

export async function querySelector(client, nodeId, selector) {
  const result = await client.DOM.querySelector({ nodeId, selector });
  return result.nodeId || 0;
}

export async function querySelectorAll(client, nodeId, selector) {
  const result = await client.DOM.querySelectorAll({ nodeId, selector });
  return result.nodeIds || [];
}

export async function findFirstNode(client, rootNodeId, selectors = []) {
  for (const selector of selectors) {
    const nodeId = await querySelector(client, rootNodeId, selector);
    if (nodeId) return { selector, nodeId };
  }
  return null;
}

export async function describeNode(client, nodeId, { depth = 1, pierce = true } = {}) {
  const result = await client.DOM.describeNode({ nodeId, depth, pierce });
  return result.node;
}

export async function getFrameDocumentNodeId(client, iframeNodeId) {
  const node = await describeNode(client, iframeNodeId, { depth: 1, pierce: true });
  const documentNodeId = node?.contentDocument?.nodeId;
  if (!documentNodeId) {
    throw new Error(`Node ${iframeNodeId} does not expose a contentDocument node`);
  }
  return documentNodeId;
}

export async function findIframeDocument(client, rootNodeId, selectors = []) {
  const iframe = await findFirstNode(client, rootNodeId, selectors);
  if (!iframe) return null;
  const documentNodeId = await getFrameDocumentNodeId(client, iframe.nodeId);
  return { ...iframe, documentNodeId };
}

export async function getAttributesMap(client, nodeId) {
  const result = await client.DOM.getAttributes({ nodeId });
  const attributes = {};
  const raw = result.attributes || [];
  for (let index = 0; index < raw.length; index += 2) {
    attributes[raw[index]] = raw[index + 1] || "";
  }
  return attributes;
}

export async function getOuterHTML(client, nodeId) {
  const result = await client.DOM.getOuterHTML({ nodeId });
  return result.outerHTML || "";
}

export async function getNodeBox(client, nodeId) {
  const result = await client.DOM.getBoxModel({ nodeId });
  const model = result.model;
  const quad = model.border?.length ? model.border : model.content;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    model,
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2
    },
    rect: {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    }
  };
}

export async function simulateHumanClick(client, targetX, targetY, {
  button = "left",
  clickCount = 1,
  delayMs = 80,
  random = Math.random,
  sleepFn = sleep,
  moveSteps = 18,
  moveJitterPx = 3,
  hoverJitterPx = 5,
  moveDelayMinMs = 5,
  moveDelayMaxMs = 23,
  hoverDelayMinMs = 10,
  hoverDelayMaxMs = 30,
  prePressBaseMs = 260,
  prePressVarianceMs = 80,
  holdVarianceMs = 30,
  startPoint = null
} = {}) {
  const target = normalizePoint({ x: targetX, y: targetY });
  if (!target) throw new Error("simulateHumanClick requires finite target coordinates");
  const nextRandom = normalizeRandom(random);
  const interactionConfig = getHumanInteractionConfig(client) || {};
  const start = normalizePoint(startPoint)
    || normalizePoint(interactionConfig.lastMousePoint)
    || {
      x: Math.max(0, target.x + randomBetween(nextRandom, -140, 140)),
      y: Math.max(0, target.y + randomBetween(nextRandom, -90, 90))
    };
  const path = generateBezierPath(start, target, {
    steps: moveSteps,
    random: nextRandom
  });
  const sleeper = typeof sleepFn === "function" ? sleepFn : sleep;
  const moveDelayMin = Math.min(moveDelayMinMs, moveDelayMaxMs);
  const moveDelayMax = Math.max(moveDelayMinMs, moveDelayMaxMs);
  const hoverDelayMin = Math.min(hoverDelayMinMs, hoverDelayMaxMs);
  const hoverDelayMax = Math.max(hoverDelayMinMs, hoverDelayMaxMs);
  for (const point of path) {
    await client.Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: Math.round(point.x + randomBetween(nextRandom, -moveJitterPx / 2, moveJitterPx / 2)),
      y: Math.round(point.y + randomBetween(nextRandom, -moveJitterPx / 2, moveJitterPx / 2)),
      button: "none"
    });
    const pauseMs = Math.round(randomBetween(nextRandom, moveDelayMin, moveDelayMax));
    if (pauseMs > 0) await sleeper(pauseMs);
  }
  const hoverSteps = randomIntegerBetween(nextRandom, 3, 6);
  for (let index = 0; index < hoverSteps; index += 1) {
    await client.Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: Math.round(target.x + randomBetween(nextRandom, -hoverJitterPx / 2, hoverJitterPx / 2)),
      y: Math.round(target.y + randomBetween(nextRandom, -hoverJitterPx / 2, hoverJitterPx / 2)),
      button: "none"
    });
    const pauseMs = Math.round(randomBetween(nextRandom, hoverDelayMin, hoverDelayMax));
    if (pauseMs > 0) await sleeper(pauseMs);
  }
  const prePressMs = humanDelay(prePressBaseMs, prePressVarianceMs, {
    minMs: 0,
    maxMs: Math.max(prePressBaseMs + prePressVarianceMs * 4, prePressBaseMs),
    random: nextRandom
  });
  if (prePressMs > 0) await sleeper(prePressMs);
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: target.x, y: target.y, button, clickCount });
  const holdMs = humanDelay(delayMs, holdVarianceMs, {
    minMs: 0,
    maxMs: Math.max(delayMs + holdVarianceMs * 4, delayMs),
    random: nextRandom
  });
  if (holdMs > 0) await sleeper(holdMs);
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: target.x, y: target.y, button, clickCount });
  const latestConfig = getHumanInteractionConfig(client);
  if (latestConfig) latestConfig.lastMousePoint = target;
  return {
    mode: "human",
    path_points: path.length,
    hover_steps: hoverSteps,
    pre_press_ms: prePressMs,
    hold_ms: holdMs
  };
}

export function resolveHumanClickPointForBox(box, {
  enabled = true,
  safeClickPointEnabled = true,
  random = Math.random,
  safeClickMinWidth = 44,
  safeClickMinHeight = 28,
  safeClickInsetRatio = 0.22,
  safeClickMinInsetPx = 4,
  safeClickMaxInsetPx = 18
} = {}) {
  const center = normalizePoint(box?.center);
  if (!center) throw new Error("resolveHumanClickPointForBox requires a box center");
  const rect = box?.rect || {};
  const width = Number(rect.width);
  const height = Number(rect.height);
  const originX = Number(rect.x);
  const originY = Number(rect.y);
  if (
    enabled !== true
    || safeClickPointEnabled === false
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || !Number.isFinite(originX)
    || !Number.isFinite(originY)
    || width < Math.max(1, Number(safeClickMinWidth) || 44)
    || height < Math.max(1, Number(safeClickMinHeight) || 28)
  ) {
    return {
      x: center.x,
      y: center.y,
      mode: "center",
      reason: "small_or_disabled"
    };
  }

  const nextRandom = normalizeRandom(random);
  const insetRatio = clampNumber(safeClickInsetRatio, 0.05, 0.45);
  const minInset = Math.max(0, Number(safeClickMinInsetPx) || 0);
  const maxInset = Math.max(minInset, Number(safeClickMaxInsetPx) || minInset);
  const insetX = Math.min(width / 2 - 1, Math.max(minInset, Math.min(maxInset, width * insetRatio)));
  const insetY = Math.min(height / 2 - 1, Math.max(minInset, Math.min(maxInset, height * insetRatio)));
  const usableWidth = Math.max(0, width - insetX * 2);
  const usableHeight = Math.max(0, height - insetY * 2);
  if (usableWidth <= 0 || usableHeight <= 0) {
    return {
      x: center.x,
      y: center.y,
      mode: "center",
      reason: "insufficient_safe_area"
    };
  }
  return {
    x: originX + insetX + nextRandom() * usableWidth,
    y: originY + insetY + nextRandom() * usableHeight,
    mode: "safe_inset",
    inset_x: insetX,
    inset_y: insetY
  };
}

export async function clickPoint(client, x, y, {
  button = "left",
  clickCount = 1,
  delayMs = 80,
  humanRestEnabled = null,
  humanInteraction = null
} = {}) {
  const configured = getHumanInteractionConfig(client);
  const mergedHumanInteraction = {
    ...(configured || {}),
    ...(humanInteraction || {})
  };
  const humanEnabled = humanRestEnabled === true
    || humanInteraction?.enabled === true
    || (humanRestEnabled !== false && configured?.enabled === true);
  if (humanEnabled && mergedHumanInteraction.clickMovementEnabled !== false) {
    return simulateHumanClick(client, x, y, {
      ...mergedHumanInteraction,
      button,
      clickCount,
      delayMs
    });
  }
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button, clickCount });
  if (delayMs > 0) await sleep(delayMs);
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button, clickCount });
  return {
    mode: "direct"
  };
}

export async function scrollNodeIntoView(client, nodeId) {
  await client.DOM.scrollIntoViewIfNeeded({ nodeId });
}

export async function clickNodeCenter(client, nodeId, {
  scrollIntoView = false,
  ...clickOptions
} = {}) {
  if (scrollIntoView) {
    await scrollNodeIntoView(client, nodeId);
    await sleep(150);
  }
  const box = await getNodeBox(client, nodeId);
  const configured = getHumanInteractionConfig(client);
  const mergedHumanInteraction = {
    ...(configured || {}),
    ...(clickOptions.humanInteraction || {})
  };
  const humanClickPointEnabled = (
    clickOptions.humanRestEnabled === true
    || clickOptions.humanInteraction?.enabled === true
    || (clickOptions.humanRestEnabled !== false && configured?.enabled === true)
  ) && mergedHumanInteraction.safeClickPointEnabled !== false;
  const clickPointTarget = humanClickPointEnabled
    ? resolveHumanClickPointForBox(box, mergedHumanInteraction)
    : { ...box.center, mode: "center" };
  const clickResult = await clickPoint(client, clickPointTarget.x, clickPointTarget.y, clickOptions);
  return {
    ...box,
    click_target: clickPointTarget,
    click_result: clickResult
  };
}

export async function pressKey(client, key, {
  code = key,
  windowsVirtualKeyCode,
  nativeVirtualKeyCode = windowsVirtualKeyCode,
  text = "",
  modifiers = 0
} = {}) {
  await client.Input.dispatchKeyEvent({
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode,
    text,
    modifiers
  });
  await client.Input.dispatchKeyEvent({
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode,
    modifiers
  });
}

export function chunkHumanText(text, {
  random = Math.random,
  minLength = 1,
  maxLength = 5
} = {}) {
  const chars = Array.from(String(text || ""));
  const min = Math.max(1, Math.floor(Number(minLength) || 1));
  const max = Math.max(min, Math.floor(Number(maxLength) || min));
  const nextRandom = normalizeRandom(random);
  const chunks = [];
  let index = 0;
  while (index < chars.length) {
    const remaining = chars.length - index;
    const size = Math.min(remaining, randomIntegerBetween(nextRandom, min, max));
    chunks.push(chars.slice(index, index + size).join(""));
    index += size;
  }
  return chunks;
}

export async function insertText(client, text, {
  humanTextEntryEnabled = null,
  humanInteraction = null
} = {}) {
  const value = String(text || "");
  const configured = getHumanInteractionConfig(client);
  const mergedHumanInteraction = {
    ...(configured || {}),
    ...(humanInteraction || {})
  };
  const textEntryEnabled = humanTextEntryEnabled === true
    || humanInteraction?.textEntryEnabled === true
    || (humanTextEntryEnabled !== false
      && configured?.enabled === true
      && configured?.textEntryEnabled !== false);
  if (!textEntryEnabled || value.length <= 1) {
    await client.Input.insertText({ text: value });
    return {
      mode: "direct",
      chunk_count: value ? 1 : 0
    };
  }
  const chunks = chunkHumanText(value, {
    random: mergedHumanInteraction.random,
    minLength: mergedHumanInteraction.textChunkMinLength,
    maxLength: mergedHumanInteraction.textChunkMaxLength
  });
  const sleeper = typeof mergedHumanInteraction.sleepFn === "function"
    ? mergedHumanInteraction.sleepFn
    : sleep;
  for (let index = 0; index < chunks.length; index += 1) {
    await client.Input.insertText({ text: chunks[index] });
    if (index < chunks.length - 1) {
      const pauseMs = humanDelay(
        mergedHumanInteraction.textChunkDelayBaseMs,
        mergedHumanInteraction.textChunkDelayVarianceMs,
        {
          minMs: 0,
          maxMs: Math.max(
            mergedHumanInteraction.textChunkDelayBaseMs + mergedHumanInteraction.textChunkDelayVarianceMs * 4,
            mergedHumanInteraction.textChunkDelayBaseMs
          ),
          random: mergedHumanInteraction.random
        }
      );
      if (pauseMs > 0) await sleeper(pauseMs);
    }
  }
  return {
    mode: "chunked",
    chunk_count: chunks.length,
    chunks
  };
}

export async function selectAllFocusedText(client) {
  await pressKey(client, "a", {
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2
  });
}

export async function clearFocusedInput(client) {
  await selectAllFocusedText(client);
  await pressKey(client, "Backspace", {
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });
}

export async function waitForSelector(client, nodeId, selector, {
  timeoutMs = 5000,
  intervalMs = 150
} = {}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const foundNodeId = await querySelector(client, nodeId, selector);
    if (foundNodeId) return foundNodeId;
    await sleep(intervalMs);
  }
  return 0;
}

export async function countSelectors(client, nodeId, selectors = {}) {
  const counts = {};
  for (const [name, selector] of Object.entries(selectors)) {
    counts[name] = (await querySelectorAll(client, nodeId, selector)).length;
  }
  return counts;
}

export async function getAccessibilityTree(client, options = {}) {
  return client.Accessibility.getFullAXTree(options);
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
