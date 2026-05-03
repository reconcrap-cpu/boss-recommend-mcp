import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const currentFilePath = fileURLToPath(import.meta.url);
const defaultRulesPath = path.join(path.dirname(currentFilePath), "recommend-healing-rules.json");

let cachedRulesPath = null;
let cachedRulesMtime = null;
let cachedRules = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePathLike(value) {
  return String(value || "").trim();
}

function getNestedValue(root, pathParts = []) {
  let current = root;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

export function getRecommendHealingRulesPath() {
  const fromEnv = normalizePathLike(process.env.BOSS_RECOMMEND_HEALING_RULES_FILE);
  return fromEnv ? path.resolve(fromEnv) : defaultRulesPath;
}

export function loadRecommendHealingRules(options = {}) {
  const fresh = options.fresh === true;
  const rulesPath = getRecommendHealingRulesPath();
  const stats = fs.statSync(rulesPath);
  if (
    !fresh
    && cachedRules
    && cachedRulesPath === rulesPath
    && cachedRulesMtime === Number(stats.mtimeMs)
  ) {
    return clone(cachedRules);
  }
  const nextRules = require(rulesPath);
  cachedRulesPath = rulesPath;
  cachedRulesMtime = Number(stats.mtimeMs);
  cachedRules = clone(nextRules);
  return clone(cachedRules);
}

export function saveRecommendHealingRules(nextRules) {
  const rulesPath = getRecommendHealingRulesPath();
  const serialized = `${JSON.stringify(nextRules, null, 2)}\n`;
  fs.writeFileSync(rulesPath, serialized, "utf8");
  cachedRulesPath = rulesPath;
  cachedRulesMtime = Number(fs.statSync(rulesPath).mtimeMs);
  cachedRules = clone(nextRules);
  return rulesPath;
}

export function getRecommendSelectorRule(pathParts = [], fallback = []) {
  const value = getNestedValue(loadRecommendHealingRules(), ["selectors", ...pathParts]);
  return Array.isArray(value) && value.length > 0 ? value.map((item) => String(item)) : fallback.slice();
}

export function getRecommendNetworkRule(pathParts = [], fallback = null) {
  const value = getNestedValue(loadRecommendHealingRules(), ["network", ...pathParts]);
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value && typeof value === "object") return clone(value);
  if (typeof value === "string") return value;
  if (Array.isArray(fallback)) return fallback.slice();
  if (fallback && typeof fallback === "object") return clone(fallback);
  return fallback;
}

export function compileRegexList(patterns = []) {
  return (Array.isArray(patterns) ? patterns : [])
    .map((pattern) => {
      try {
        return new RegExp(String(pattern), "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function findFirstMatchingPattern(value, patterns = []) {
  const text = String(value || "");
  for (const pattern of compileRegexList(patterns)) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

export function matchesAnyPattern(value, patterns = []) {
  return Boolean(findFirstMatchingPattern(value, patterns));
}

export function buildFirstSelectorLookupExpression(selectors = [], rootExpr = "document") {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    for (const selector of selectors) {
      try {
        const node = ${rootExpr}.querySelector(selector);
        if (node) return node;
      } catch {}
    }
    return null;
  })()`;
}

export function buildSelectorCollectionExpression(selectors = [], rootExpr = "document") {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const nodes = [];
    for (const selector of selectors) {
      try {
        nodes.push(...Array.from(${rootExpr}.querySelectorAll(selector)));
      } catch {}
    }
    return Array.from(new Set(nodes));
  })()`;
}
