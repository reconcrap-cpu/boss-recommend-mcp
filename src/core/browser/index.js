import { execFile, spawn } from "node:child_process";
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
export const DEFAULT_REQUIRED_CHROME_FLAGS = LID_CLOSED_SAFE_CHROME_ARGS;

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
const CDP_CLOSED_TRANSPORT_PATTERN = /WebSocket is not open|readyState\s+\d+\s+\(CLOSED\)|ECONNRESET|socket hang up|Target closed|Session closed|Connection closed/i;
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
const DEFAULT_HUMAN_REST_LEVEL = "low";
const HUMAN_REST_LEVEL_ALIASES = Object.freeze({
  default: "low",
  light: "low",
  normal: "medium",
  med: "medium",
  heavy: "high"
});
const HUMAN_REST_LEVEL_PROFILES = Object.freeze({
  medium: Object.freeze({
    targetRestMs: 30 * 60 * 1000,
    targetCandidateCount: 700,
    targetWindowMs: 5 * 60 * 60 * 1000,
    intervalMin: 4,
    intervalMax: 16,
    longRestProbability: 0.22,
    shortRestMinMs: 8000,
    shortRestMaxMs: 45000,
    longRestMinMs: 60000,
    longRestMaxMs: 180000,
    minDebtToRestMs: 8000,
    forceDebtMs: 90000,
    maxOverspendMs: 15000
  }),
  high: Object.freeze({
    targetRestMs: 60 * 60 * 1000,
    targetCandidateCount: 700,
    targetWindowMs: 5 * 60 * 60 * 1000,
    intervalMin: 3,
    intervalMax: 12,
    longRestProbability: 0.28,
    shortRestMinMs: 12000,
    shortRestMaxMs: 75000,
    longRestMinMs: 90000,
    longRestMaxMs: 300000,
    minDebtToRestMs: 12000,
    forceDebtMs: 150000,
    maxOverspendMs: 25000
  })
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

export function normalizeHumanRestLevel(raw, fallback = DEFAULT_HUMAN_REST_LEVEL) {
  const normalized = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const level = HUMAN_REST_LEVEL_ALIASES[normalized] || normalized;
  return level === "low" || level === "medium" || level === "high"
    ? level
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
  const restLevel = normalizeHumanRestLevel(
    readFirstOption(rawObject, ["restLevel", "rest_level"]),
    DEFAULT_HUMAN_REST_LEVEL
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
    restLevel,
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
  nowFn = Date.now,
  restLevel = DEFAULT_HUMAN_REST_LEVEL,
  shortRestProbability = 0.08,
  shortRestMinMs = 3000,
  shortRestMaxMs = 7000,
  batchThresholdBase = 25,
  batchThresholdJitter = 8,
  batchRestMinMs = 15000,
  batchRestMaxMs = 30000
} = {}) {
  const nextRandom = normalizeRandom(random);
  const readNow = typeof nowFn === "function" ? nowFn : Date.now;
  const normalizedRestLevel = normalizeHumanRestLevel(restLevel);
  const budgetProfile = (shortRestEnabled !== false || batchRestEnabled !== false)
    ? HUMAN_REST_LEVEL_PROFILES[normalizedRestLevel] || null
    : null;
  const nextBudgetRestInterval = () => budgetProfile
    ? randomIntegerBetween(nextRandom, budgetProfile.intervalMin, budgetProfile.intervalMax)
    : 0;
  const state = {
    enabled: enabled === true,
    rest_level: normalizedRestLevel,
    short_rest_enabled: enabled === true && shortRestEnabled !== false,
    batch_rest_enabled: enabled === true && batchRestEnabled !== false,
    rest_counter: 0,
    rest_threshold: Math.max(1, Math.floor(Number(batchThresholdBase) || 25) + Math.floor(nextRandom() * Math.max(1, Number(batchThresholdJitter) || 1))),
    processed_count: 0,
    candidates_since_last_rest: 0,
    candidates_until_next_rest: nextBudgetRestInterval(),
    active_elapsed_ms: 0,
    last_active_at_ms: Number(readNow()) || 0,
    rest_count: 0,
    total_rest_ms: 0
  };

  function resetThreshold() {
    state.rest_threshold = Math.max(1, Math.floor(Number(batchThresholdBase) || 25) + Math.floor(nextRandom() * Math.max(1, Number(batchThresholdJitter) || 1)));
  }

  function updateActiveElapsed() {
    const now = Number(readNow()) || 0;
    if (state.last_active_at_ms >= 0 && now >= state.last_active_at_ms) {
      state.active_elapsed_ms += now - state.last_active_at_ms;
    }
    state.last_active_at_ms = now;
    return now;
  }

  function getBudgetTargetMs() {
    if (!budgetProfile) return 0;
    const candidateTarget = state.processed_count * (budgetProfile.targetRestMs / budgetProfile.targetCandidateCount);
    const elapsedTarget = state.active_elapsed_ms * (budgetProfile.targetRestMs / budgetProfile.targetWindowMs);
    return Math.max(candidateTarget, elapsedTarget);
  }

  function chooseBudgetRestPause(debtMs) {
    const longRest = nextRandom() < budgetProfile.longRestProbability;
    const minMs = longRest ? budgetProfile.longRestMinMs : budgetProfile.shortRestMinMs;
    const maxMs = longRest ? budgetProfile.longRestMaxMs : budgetProfile.shortRestMaxMs;
    const scaleMin = longRest ? 0.75 : 0.38;
    const scaleMax = longRest ? 1.1 : 0.78;
    const desiredMs = debtMs * randomBetween(nextRandom, scaleMin, scaleMax);
    const randomizedMs = randomBetween(nextRandom, minMs, maxMs);
    const blendedMs = Math.max(minMs, Math.min(maxMs, (desiredMs + randomizedMs) / 2));
    const maxAllowedMs = Math.max(minMs, debtMs + budgetProfile.maxOverspendMs);
    return {
      pauseMs: Math.round(Math.min(blendedMs, maxAllowedMs)),
      restSize: longRest ? "long" : "short"
    };
  }

  async function takeBudgetBreakIfNeeded(sleeper) {
    state.processed_count += 1;
    state.candidates_since_last_rest += 1;
    state.candidates_until_next_rest -= 1;
    const debtMs = getBudgetTargetMs() - state.total_rest_ms;
    const intervalDue = state.candidates_until_next_rest <= 0;
    const forceDue = debtMs >= budgetProfile.forceDebtMs;
    if (!intervalDue && !forceDue) {
      return null;
    }
    if (debtMs < budgetProfile.minDebtToRestMs) {
      if (intervalDue) state.candidates_until_next_rest = nextBudgetRestInterval();
      return null;
    }
    const { pauseMs, restSize } = chooseBudgetRestPause(debtMs);
    await sleeper(pauseMs);
    const event = {
      kind: "random_rest",
      rest_level: normalizedRestLevel,
      rest_size: restSize,
      pause_ms: pauseMs,
      processed_since_last_rest: state.candidates_since_last_rest,
      rest_budget_debt_ms: Math.round(Math.max(0, debtMs))
    };
    state.candidates_since_last_rest = 0;
    state.candidates_until_next_rest = nextBudgetRestInterval();
    return event;
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
    updateActiveElapsed();
    if (budgetProfile) {
      const budgetEvent = await takeBudgetBreakIfNeeded(sleeper);
      const pauseMs = budgetEvent?.pause_ms || 0;
      if (pauseMs > 0) {
        state.rest_count += 1;
        state.total_rest_ms += pauseMs;
        state.last_active_at_ms = Number(readNow()) || state.last_active_at_ms;
      }
      return {
        enabled: true,
        rested: Boolean(budgetEvent),
        pause_ms: pauseMs,
        rest_level: normalizedRestLevel,
        rest_counter: state.rest_counter,
        rest_threshold: state.rest_threshold,
        processed_count: state.processed_count,
        candidates_until_next_rest: state.candidates_until_next_rest,
        active_elapsed_ms: state.active_elapsed_ms,
        rest_count: state.rest_count,
        total_rest_ms: state.total_rest_ms,
        events: budgetEvent ? [budgetEvent] : []
      };
    }
    state.rest_counter += 1;
    state.processed_count += 1;
    const events = [];
    if (state.short_rest_enabled && nextRandom() < Math.max(0, Number(shortRestProbability) || 0)) {
      const pauseMs = Math.round(randomBetween(nextRandom, shortRestMinMs, shortRestMaxMs));
      await sleeper(pauseMs);
      events.push({ kind: "random_rest", rest_level: normalizedRestLevel, pause_ms: pauseMs });
    }
    if (state.batch_rest_enabled && state.rest_counter >= state.rest_threshold) {
      const pauseMs = Math.round(randomBetween(nextRandom, batchRestMinMs, batchRestMaxMs));
      await sleeper(pauseMs);
      events.push({
        kind: "batch_rest",
        rest_level: normalizedRestLevel,
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
      state.last_active_at_ms = Number(readNow()) || state.last_active_at_ms;
    }
    return {
      enabled: true,
      rested: events.length > 0,
      pause_ms: pauseMs,
      rest_level: normalizedRestLevel,
      rest_counter: state.rest_counter,
      rest_threshold: state.rest_threshold,
      processed_count: state.processed_count,
      active_elapsed_ms: state.active_elapsed_ms,
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

export function parseChromeCommandLineArgs(commandLineOrArgs = []) {
  if (Array.isArray(commandLineOrArgs)) {
    return commandLineOrArgs
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  const text = String(commandLineOrArgs || "").trim();
  if (!text) return [];
  const args = [];
  let current = "";
  let quote = null;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function splitChromeFeatureList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function chromeFlagIsPresent(args, requiredFlag) {
  if (!requiredFlag) return true;
  const disableFeaturesPrefix = "--disable-features=";
  if (requiredFlag.startsWith(disableFeaturesPrefix)) {
    const requiredFeatures = splitChromeFeatureList(requiredFlag.slice(disableFeaturesPrefix.length));
    const disableFeatureArgs = args.filter((arg) => arg.startsWith(disableFeaturesPrefix));
    const lastDisableFeatureArg = disableFeatureArgs[disableFeatureArgs.length - 1] || "";
    const features = splitChromeFeatureList(lastDisableFeatureArg.slice(disableFeaturesPrefix.length));
    return requiredFeatures.every((feature) => features.includes(feature));
  }
  if (args.includes(requiredFlag)) return true;
  return false;
}

export function getMissingRequiredChromeFlags(
  commandLineOrArgs = [],
  requiredFlags = DEFAULT_REQUIRED_CHROME_FLAGS
) {
  const args = parseChromeCommandLineArgs(commandLineOrArgs);
  return requiredFlags.filter((flag) => !chromeFlagIsPresent(args, flag));
}

function normalizeChromeLaunchArgs(args = []) {
  const disableFeaturesPrefix = "--disable-features=";
  const result = [];
  const seen = new Set();
  const disabledFeatures = [];
  const disabledFeatureSet = new Set();
  let disabledFeatureIndex = -1;

  for (const rawArg of args) {
    const arg = String(rawArg || "").trim();
    if (!arg) continue;
    if (arg.startsWith(disableFeaturesPrefix)) {
      if (disabledFeatureIndex < 0) {
        disabledFeatureIndex = result.length;
        result.push(null);
      }
      for (const feature of splitChromeFeatureList(arg.slice(disableFeaturesPrefix.length))) {
        if (!disabledFeatureSet.has(feature)) {
          disabledFeatureSet.add(feature);
          disabledFeatures.push(feature);
        }
      }
      continue;
    }
    if (seen.has(arg)) continue;
    seen.add(arg);
    result.push(arg);
  }

  return result.map((arg) => (
    arg === null
      ? `${disableFeaturesPrefix}${disabledFeatures.join(",")}`
      : arg
  ));
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
    "--start-maximized",
    "--new-window",
    url
  ];
  return normalizeChromeLaunchArgs(args);
}

function execFileText(file, args = [], { timeoutMs = 5000, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer,
      windowsHide: true
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error?.message || ""
      });
    });
  });
}

async function inspectChromeCommandLineViaCdp({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT
} = {}) {
  let client = null;
  try {
    client = await CDP({ host, port });
    const result = await client.Browser.getBrowserCommandLine();
    const args = parseChromeCommandLineArgs(result?.arguments || result?.commandLine || result?.command_line || []);
    if (args.length === 0) {
      return {
        ok: false,
        source: "cdp_browser_command_line",
        arguments: [],
        error: "Browser.getBrowserCommandLine returned no command-line arguments"
      };
    }
    return {
      ok: true,
      source: "cdp_browser_command_line",
      arguments: args
    };
  } catch (error) {
    return {
      ok: false,
      source: "cdp_browser_command_line",
      arguments: [],
      error: error?.message || String(error || "")
    };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

function parseWindowsProcessListJson(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .map((item) => ({
      pid: Number(item?.ProcessId),
      command_line: String(item?.CommandLine || "")
    }))
    .filter((item) => Number.isFinite(item.pid) && item.command_line);
}

function parsePosixProcessList(text = "", port = DEFAULT_CHROME_PORT) {
  const portPattern = new RegExp(`--remote-debugging-port(?:=|\\s+)${port}(?=\\s|$)`);
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match
        ? { pid: Number(match[1]), command_line: match[2] }
        : null;
    })
    .filter((item) => item && Number.isFinite(item.pid) && portPattern.test(item.command_line));
}

function summarizeChromeProcesses(processes = []) {
  return processes
    .map((item) => ({
      pid: item.pid,
      command_line_length: String(item.command_line || "").length
    }))
    .filter((item) => Number.isFinite(item.pid));
}

async function inspectChromeCommandLineViaProcessList({
  port = DEFAULT_CHROME_PORT
} = {}) {
  const portText = String(port);
  let processes = [];
  let raw = null;

  if (process.platform === "win32") {
    const portPattern = `--remote-debugging-port(=|\\s+)${portText}(\\s|$)`;
    const script = [
      "$items = Get-CimInstance Win32_Process",
      `| Where-Object { $_.CommandLine -and $_.CommandLine -match '${portPattern}' }`,
      "| Select-Object ProcessId,CommandLine;",
      "$items | ConvertTo-Json -Compress"
    ].join(" ");
    raw = await execFileText("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ], { timeoutMs: 6000 });
    if (!raw.ok) {
      return {
        ok: false,
        source: "process_list",
        arguments: [],
        processes: [],
        error: raw.error || raw.stderr || "Failed to inspect Windows process list"
      };
    }
    try {
      processes = parseWindowsProcessListJson(raw.stdout);
    } catch (error) {
      return {
        ok: false,
        source: "process_list",
        arguments: [],
        processes: [],
        error: `Failed to parse Windows process list: ${error?.message || error}`
      };
    }
  } else {
    const psArgs = process.platform === "darwin"
      ? ["-axo", "pid=,command="]
      : ["-eo", "pid=,args="];
    raw = await execFileText("ps", psArgs, { timeoutMs: 6000 });
    if (!raw.ok) {
      return {
        ok: false,
        source: "process_list",
        arguments: [],
        processes: [],
        error: raw.error || raw.stderr || "Failed to inspect process list"
      };
    }
    processes = parsePosixProcessList(raw.stdout, port);
  }

  if (processes.length === 0) {
    return {
      ok: false,
      source: "process_list",
      arguments: [],
      processes: [],
      error: `No local process was found for --remote-debugging-port=${port}`
    };
  }
  const primary = processes[0];
  return {
    ok: true,
    source: "process_list",
    arguments: parseChromeCommandLineArgs(primary.command_line),
    process: {
      pid: primary.pid,
      command_line_length: primary.command_line.length
    },
    processes: summarizeChromeProcesses(processes)
  };
}

export async function inspectChromeDebugCommandLine({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  _deps = {}
} = {}) {
  const inspectViaCdp = _deps.inspectChromeCommandLineViaCdpImpl || inspectChromeCommandLineViaCdp;
  const inspectViaProcess = _deps.inspectChromeCommandLineViaProcessListImpl || inspectChromeCommandLineViaProcessList;
  const cdpResult = await inspectViaCdp({ host, port });
  if (cdpResult?.ok && cdpResult.arguments?.length) {
    return cdpResult;
  }
  if (!isLocalChromeHost(host)) {
    return {
      ok: false,
      source: cdpResult?.source || "unknown",
      arguments: [],
      error: cdpResult?.error || `Cannot inspect process list for non-local Chrome debug host: ${host}`
    };
  }
  const processResult = await inspectViaProcess({ port });
  if (processResult?.ok && processResult.arguments?.length) {
    return {
      ...processResult,
      cdp_error: cdpResult?.error || null
    };
  }
  return {
    ok: false,
    source: processResult?.source || cdpResult?.source || "unknown",
    arguments: [],
    processes: processResult?.processes || [],
    error: processResult?.error || cdpResult?.error || "Chrome command line could not be inspected"
  };
}

async function waitForChromeDebugPortClosed({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  timeoutMs = 6000,
  intervalMs = 300,
  listChromeTargetsImpl = listChromeTargets
} = {}) {
  const started = Date.now();
  let lastError = null;
  let lastTargetCount = 0;
  while (Date.now() - started <= timeoutMs) {
    try {
      const targets = await listChromeTargetsImpl({ host, port });
      lastTargetCount = Array.isArray(targets) ? targets.length : 0;
    } catch (error) {
      if (isChromeDebugUnavailableError(error)) {
        return {
          ok: true,
          elapsed_ms: Date.now() - started
        };
      }
      lastError = error;
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    target_count: lastTargetCount,
    error: lastError?.message || `Chrome debug port ${port} is still reachable`
  };
}

export async function closeChromeDebugInstance({
  host = DEFAULT_CHROME_HOST,
  port = DEFAULT_CHROME_PORT,
  processes = [],
  timeoutMs = 8000,
  intervalMs = 300,
  _deps = {}
} = {}) {
  if (!isLocalChromeHost(host)) {
    return {
      ok: false,
      method: "none",
      error: `Refusing to close non-local Chrome debug host: ${host}`
    };
  }

  const listChromeTargetsImpl = _deps.listChromeTargetsImpl || listChromeTargets;
  const waitClosed = _deps.waitForChromeDebugPortClosedImpl || waitForChromeDebugPortClosed;
  let browserCloseAttempted = false;
  let browserCloseError = null;
  try {
    let client = null;
    try {
      client = await CDP({ host, port });
      if (typeof client?.Browser?.close !== "function") {
        throw new Error("Browser.close is not available");
      }
      browserCloseAttempted = true;
      await client.Browser.close();
    } finally {
      if (client) await client.close().catch(() => {});
    }
  } catch (error) {
    browserCloseError = error?.message || String(error || "");
  }

  let closed = await waitClosed({ host, port, timeoutMs, intervalMs, listChromeTargetsImpl });
  if (closed.ok) {
    return {
      ok: true,
      method: browserCloseAttempted ? "Browser.close" : "port_already_closed",
      elapsed_ms: closed.elapsed_ms,
      browser_close_error: browserCloseError
    };
  }

  const pids = Array.from(new Set((processes || [])
    .map((item) => Number(item?.pid))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid)));
  const killedPids = [];
  const processErrors = [];
  for (const pid of pids) {
    try {
      process.kill(pid);
      killedPids.push(pid);
    } catch (error) {
      processErrors.push({
        pid,
        error: error?.message || String(error || "")
      });
    }
  }

  if (killedPids.length > 0) {
    closed = await waitClosed({ host, port, timeoutMs, intervalMs, listChromeTargetsImpl });
    if (closed.ok) {
      return {
        ok: true,
        method: browserCloseAttempted ? "Browser.close+process.kill" : "process.kill",
        elapsed_ms: closed.elapsed_ms,
        killed_pids: killedPids,
        browser_close_error: browserCloseError,
        process_errors: processErrors
      };
    }
  }

  return {
    ok: false,
    method: browserCloseAttempted && killedPids.length > 0
      ? "Browser.close+process.kill"
      : browserCloseAttempted
        ? "Browser.close"
        : killedPids.length > 0
          ? "process.kill"
          : "none",
    killed_pids: killedPids,
    browser_close_error: browserCloseError,
    process_errors: processErrors,
    wait: closed,
    error: closed.error || browserCloseError || "Failed to close Chrome debug instance"
  };
}

function summarizeRelaunch(result = {}, reason = "") {
  return {
    reason,
    launched: Boolean(result?.launched),
    chrome_path: result?.chrome_path || null,
    user_data_dir: result?.user_data_dir || null,
    launch_args: Array.isArray(result?.launch_args) ? result.launch_args : [],
    readiness: result?.readiness || null
  };
}

function createChromeGuardError(message, code, chromeGuard) {
  const error = new Error(message);
  error.code = code;
  error.chrome_guard = chromeGuard;
  return error;
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
  slowLive = false,
  userDataDir = ""
} = {}) {
  if (!isLocalChromeHost(host)) {
    throw new Error(`Cannot auto-launch Chrome for non-local debug host: ${host}`);
  }
  const chromePath = getChromeExecutable();
  if (!chromePath) {
    throw new Error("Chrome executable not found. Set BOSS_MCP_CHROME_PATH or BOSS_RECOMMEND_CHROME_PATH.");
  }
  const resolvedUserDataDir = userDataDir || getBossChromeUserDataDir(port);
  ensureDir(resolvedUserDataDir);
  const args = buildBossChromeLaunchArgs({ port, userDataDir: resolvedUserDataDir, url });
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
    user_data_dir: resolvedUserDataDir,
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
  launchIfMissing = true,
  userDataDir = "",
  enforceRequiredFlags = true,
  requiredFlags = DEFAULT_REQUIRED_CHROME_FLAGS,
  _deps = {}
} = {}) {
  const listChromeTargetsImpl = _deps.listChromeTargetsImpl || listChromeTargets;
  const inspectCommandLineImpl = _deps.inspectChromeDebugCommandLineImpl || inspectChromeDebugCommandLine;
  const closeChromeDebugInstanceImpl = _deps.closeChromeDebugInstanceImpl || closeChromeDebugInstance;
  const launchChromeDebugInstanceImpl = _deps.launchChromeDebugInstanceImpl || launchChromeDebugInstance;
  const required = Array.from(new Set((requiredFlags || []).filter(Boolean)));
  const baseGuard = {
    guard_checked: Boolean(enforceRequiredFlags),
    required_flags: required,
    missing_flags: [],
    required_flags_ok: !enforceRequiredFlags,
    replaced: false,
    close_method: null,
    relaunch: null,
    host,
    port
  };

  try {
    const targets = await listChromeTargetsImpl({ host, port });
    if (!enforceRequiredFlags) {
      return {
        launched: false,
        reused: true,
        port,
        target_count: targets.length,
        ...baseGuard
      };
    }

    const commandLine = await inspectCommandLineImpl({ host, port, _deps });
    const missingFlags = commandLine?.ok
      ? getMissingRequiredChromeFlags(commandLine.arguments, required)
      : required.slice();
    const commandLineEvidence = {
      command_line_source: commandLine?.source || "unknown",
      command_line_error: commandLine?.ok ? null : (commandLine?.error || "Chrome command line could not be inspected"),
      command_line_args_count: Array.isArray(commandLine?.arguments) ? commandLine.arguments.length : 0,
      inspected_process: commandLine?.process || null,
      inspected_processes: commandLine?.processes || []
    };
    if (missingFlags.length === 0) {
      return {
        launched: false,
        reused: true,
        port,
        target_count: targets.length,
        ...baseGuard,
        required_flags_ok: true,
        ...commandLineEvidence
      };
    }

    const guard = {
      ...baseGuard,
      required_flags_ok: false,
      missing_flags: missingFlags,
      target_count: targets.length,
      ...commandLineEvidence
    };
    if (!isLocalChromeHost(host)) {
      throw createChromeGuardError(
        `Chrome debug host ${host}:${port} is missing required Chrome flags and is not local, so it will not be auto-closed.`,
        "CHROME_REQUIRED_FLAGS_MISSING_NON_LOCAL",
        guard
      );
    }

    const closeResult = await closeChromeDebugInstanceImpl({
      host,
      port,
      processes: commandLine?.processes || [],
      _deps
    });
    if (!closeResult?.ok) {
      throw createChromeGuardError(
        `Chrome debug instance on port ${port} is missing required flags and could not be closed: ${closeResult?.error || "unknown close failure"}`,
        "CHROME_REQUIRED_FLAGS_REPLACE_FAILED",
        {
          ...guard,
          close_method: closeResult?.method || null,
          close_result: closeResult || null
        }
      );
    }

    try {
      const relaunch = await launchChromeDebugInstanceImpl({
        host,
        port,
        url,
        slowLive,
        userDataDir
      });
      return {
        ...relaunch,
        reused: false,
        ...guard,
        required_flags_ok: true,
        replaced: true,
        close_method: closeResult.method || null,
        close_result: closeResult,
        relaunch: summarizeRelaunch(relaunch, "missing_required_flags")
      };
    } catch (error) {
      throw createChromeGuardError(
        `Chrome debug instance on port ${port} was closed for missing flags, but relaunch failed: ${error?.message || error}`,
        "CHROME_REQUIRED_FLAGS_RELAUNCH_FAILED",
        {
          ...guard,
          close_method: closeResult.method || null,
          close_result: closeResult,
          relaunch: {
            reason: "missing_required_flags",
            launched: false,
            error: error?.message || String(error || "")
          }
        }
      );
    }
  } catch (error) {
    if (error?.chrome_guard) {
      throw error;
    }
    if (!launchIfMissing || !isChromeDebugUnavailableError(error)) {
      throw error;
    }
    try {
      const relaunch = await launchChromeDebugInstanceImpl({
        host,
        port,
        url,
        slowLive,
        userDataDir
      });
      return {
        ...baseGuard,
        ...relaunch,
        reused: false,
        required_flags_ok: true,
        relaunch: summarizeRelaunch(relaunch, "port_unreachable")
      };
    } catch (launchError) {
      throw createChromeGuardError(
        `Chrome debug port ${port} was unreachable and Chrome relaunch failed: ${launchError?.message || launchError}`,
        "CHROME_RELAUNCH_FAILED",
        {
          ...baseGuard,
          required_flags_ok: false,
          relaunch: {
            reason: "port_unreachable",
            launched: false,
            error: launchError?.message || String(launchError || "")
          }
        }
      );
    }
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
  launchIfMissing = true,
  _deps = {}
} = {}) {
  const ensureChromeDebugPortImpl = _deps.ensureChromeDebugPortImpl || ensureChromeDebugPort;
  const connectToChromeTargetImpl = _deps.connectToChromeTargetImpl || connectToChromeTarget;
  const openChromeTargetImpl = _deps.openChromeTargetImpl || openChromeTarget;
  let chrome = null;
  if (targetUrl) {
    chrome = await ensureChromeDebugPortImpl({
      host,
      port,
      url: targetUrl,
      slowLive,
      launchIfMissing: allowNavigate && launchIfMissing
    });
  }

  try {
    const session = await connectToChromeTargetImpl({
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
        const session = await connectToChromeTargetImpl({
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
      openAttempt = await openChromeTargetImpl({ host, port, url: targetUrl });
      if (openAttempt.ok) {
        const session = await connectToChromeTargetImpl({
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

    const session = await connectToChromeTargetImpl({
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

export function isClosedCdpTransportError(error) {
  return CDP_CLOSED_TRANSPORT_PATTERN.test(String(error?.message || error || ""));
}

function cloneCdpParams(params = {}) {
  if (!params || typeof params !== "object" || typeof params === "function") return params;
  try {
    return JSON.parse(JSON.stringify(params));
  } catch {
    return { ...params };
  }
}

function shouldReplayCdpSetupCall(domain, method) {
  return method === "enable"
    || (domain === "Network" && method === "setCacheDisabled")
    || (domain === "Page" && method === "bringToFront");
}

export function createGuardedCdpClient(client, { methodLog = [], reconnect = null } = {}) {
  let currentClient = client;
  let reconnectInFlight = null;
  const setupCalls = [];
  const eventSubscriptions = [];

  async function replaySessionSetup(nextClient) {
    for (const call of setupCalls) {
      const fn = nextClient?.[call.domain]?.[call.method];
      if (typeof fn === "function") {
        await fn.call(nextClient[call.domain], cloneCdpParams(call.params));
      }
    }
    for (const subscription of eventSubscriptions) {
      const fn = nextClient?.[subscription.domain]?.[subscription.event];
      if (typeof fn === "function") {
        fn.call(nextClient[subscription.domain], subscription.listener);
      }
    }
  }

  async function reconnectClient() {
    if (typeof reconnect !== "function") return null;
    if (!reconnectInFlight) {
      reconnectInFlight = Promise.resolve()
        .then(() => reconnect())
        .then(async (nextClient) => {
          if (!nextClient) throw new Error("CDP reconnect returned no client");
          currentClient = nextClient;
          await replaySessionSetup(nextClient);
          return nextClient;
        })
        .finally(() => {
          reconnectInFlight = null;
        });
    }
    return reconnectInFlight;
  }

  async function invokeWithReconnect({
    methodNameForLog,
    invoke,
    retryable = true
  }) {
    recordMethod(methodLog, methodNameForLog);
    try {
      return await invoke(currentClient);
    } catch (error) {
      if (!retryable || !isClosedCdpTransportError(error) || typeof reconnect !== "function") {
        throw error;
      }
      await reconnectClient();
      recordMethod(methodLog, `${methodNameForLog}:retry_after_reconnect`);
      return invoke(currentClient);
    }
  }

  return new Proxy({}, {
    get(_target, property, receiver) {
      if (property === "send") {
        return async (method, params = {}) => {
          if (isForbiddenMethod(method)) {
            throw new Error(`Forbidden CDP method blocked: ${method}`);
          }
          return invokeWithReconnect({
            methodNameForLog: method,
            invoke: (activeClient) => activeClient.send(method, params)
          });
        };
      }

      if (property === "close") {
        return async () => currentClient?.close?.();
      }

      if (property === "__rawClient") return currentClient;

      const value = Reflect.get(currentClient, property, receiver);
      if (!value || typeof value !== "object") return value;

      return new Proxy({}, {
        get(_domainTarget, method, domainReceiver) {
          const domainTarget = Reflect.get(currentClient, property, receiver);
          const domainValue = Reflect.get(domainTarget, method, domainReceiver);
          if (typeof domainValue !== "function") return domainValue;

          return (params = {}) => {
            const fullMethod = methodName(property, method);
            if (isForbiddenMethod(fullMethod)) {
              throw new Error(`Forbidden CDP method blocked: ${fullMethod}`);
            }
            if (typeof params === "function") {
              eventSubscriptions.push({
                domain: property,
                event: method,
                listener: params
              });
              recordMethod(methodLog, fullMethod);
              return domainValue.call(domainTarget, params);
            }
            if (shouldReplayCdpSetupCall(property, method)) {
              setupCalls.push({
                domain: property,
                method,
                params: cloneCdpParams(params)
              });
            }
            return invokeWithReconnect({
              methodNameForLog: fullMethod,
              invoke: (activeClient) => {
                const activeDomain = activeClient?.[property];
                const activeMethod = activeDomain?.[method];
                if (typeof activeMethod !== "function") {
                  throw new Error(`CDP method is unavailable after reconnect: ${fullMethod}`);
                }
                return activeMethod.call(activeDomain, params);
              }
            });
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

  let rawClient = await CDP({ host, port, target });
  let activeTarget = target;
  const methodLog = [];
  const client = createGuardedCdpClient(rawClient, {
    methodLog,
    reconnect: async () => {
      const latestTargets = await listChromeTargets({ host, port });
      const nextTarget = activeTarget?.id
        ? latestTargets.find((item) => item?.id === activeTarget.id)
        : latestTargets.find(matcher);
      if (!nextTarget) {
        const urls = latestTargets.map((item) => item.url).filter(Boolean).join("\n");
        throw new Error(`No matching Chrome target found while reconnecting to ${host}:${port}.\nAvailable targets:\n${urls}`);
      }
      try {
        await rawClient.close();
      } catch {}
      rawClient = await CDP({ host, port, target: nextTarget });
      activeTarget = nextTarget;
      return rawClient;
    }
  });

  return {
    client,
    get rawClient() {
      return rawClient;
    },
    get target() {
      return activeTarget;
    },
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
