import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import CDP from "chrome-remote-interface";
import { getScreenConfigResolution } from "./adapters.js";
import {
  buildFirstSelectorLookupExpression,
  buildSelectorCollectionExpression,
  findFirstMatchingPattern,
  getRecommendHealingRulesPath,
  getRecommendNetworkRule,
  getRecommendSelectorRule,
  loadRecommendHealingRules,
  saveRecommendHealingRules
} from "./recommend-healing-config.js";

const RECOMMEND_URL_FRAGMENT = "/web/chat/recommend";
const TOOL_NAME = "run_recommend_self_heal";
const PROFILE_SAFE = "safe";
const PROFILE_FULL = "full";
const MODE_SCAN = "scan";
const MODE_APPLY = "apply";
const NON_PROMOTABLE_SELECTOR_RULE_IDS = new Set([
  "detail_close_fallback_candidates"
]);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getStateHome() {
  return process.env.BOSS_RECOMMEND_HOME
    ? path.resolve(process.env.BOSS_RECOMMEND_HOME)
    : path.join(os.homedir(), ".boss-recommend-mcp");
}

function getSelfHealSessionsDir() {
  return path.join(getStateHome(), "self-heal-sessions");
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function getSessionPath(repairSessionId) {
  return path.join(getSelfHealSessionsDir(), `${repairSessionId}.json`);
}

function loadScreenConfigDebugPort(workspaceRoot) {
  const configResolution = getScreenConfigResolution(workspaceRoot);
  const configPath = configResolution.resolved_path;
  if (!configPath) return null;
  const parsed = readJsonFile(configPath);
  const port = Number.parseInt(String(parsed?.debugPort || ""), 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function resolveDebugPort(workspaceRoot, args = {}) {
  const explicit = Number.parseInt(String(args.port || ""), 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const fromEnv = Number.parseInt(String(process.env.BOSS_RECOMMEND_CHROME_PORT || ""), 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return loadScreenConfigDebugPort(workspaceRoot) || 9222;
}

function normalizeMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === MODE_APPLY ? MODE_APPLY : MODE_SCAN;
}

function normalizeScope(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["full", "selectors_only", "search_screen"].includes(normalized)) return normalized;
  return "full";
}

function normalizeValidationProfile(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized === PROFILE_SAFE ? PROFILE_SAFE : PROFILE_FULL;
}

function dedupeRepairs(repairs = []) {
  const result = [];
  const seen = new Set();
  for (const repair of repairs) {
    if (!repair || typeof repair !== "object") continue;
    const key = JSON.stringify({ type: repair.type, path: repair.path, value: repair.value });
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(repair);
  }
  return result;
}

function getSelectorScanDefinitions(scope = "full") {
  const shared = [
    { rule_id: "recommend_iframe", path: ["top", "recommend_iframe"], root: "top", required: true, report_on_no_match: true },
    { rule_id: "tab_items", path: ["frame", "tab_items"], root: "frame", required: true, report_on_no_match: true },
    { rule_id: "filter_trigger", path: ["frame", "filter_trigger"], root: "frame", required: true, report_on_no_match: true },
    { rule_id: "filter_panel", path: ["frame", "filter_panel"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_confirm_button", path: ["frame", "filter_confirm_button"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_confirm_candidates", path: ["frame", "filter_confirm_candidates"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_group_container", path: ["frame", "filter_group_container"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_group_school", path: ["frame", "filter_group_school"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_group_degree", path: ["frame", "filter_group_degree"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_group_gender", path: ["frame", "filter_group_gender"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_group_recent_not_view", path: ["frame", "filter_group_recent_not_view"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_option", path: ["frame", "filter_option"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_option_all", path: ["frame", "filter_option_all"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_option_active", path: ["frame", "filter_option_active"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "filter_scroll_container", path: ["frame", "filter_scroll_container"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "job_dropdown_trigger", path: ["frame", "job_dropdown_trigger"], root: "frame", required: true, report_on_no_match: true },
    { rule_id: "job_search_input", path: ["frame", "job_search_input"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "job_item_label", path: ["frame", "job_item_label"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "job_selected_label", path: ["frame", "job_selected_label"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "recommend_cards", path: ["frame", "recommend_cards"], root: "frame", required: true, report_on_no_match: false },
    { rule_id: "recommend_card_inner", path: ["frame", "recommend_card_inner"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "featured_cards", path: ["frame", "featured_cards"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "featured_card_anchor", path: ["frame", "featured_card_anchor"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "latest_cards", path: ["frame", "latest_cards"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "latest_card_inner", path: ["frame", "latest_card_inner"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "refresh_finished_wrap", path: ["frame", "refresh_finished_wrap"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "refresh_button", path: ["frame", "refresh_button"], root: "frame", required: false, report_on_no_match: false }
  ];
  if (scope === "selectors_only") return shared;
  return shared.concat([
    { rule_id: "job_list_items", path: ["frame", "job_list_items"], root: "frame", required: false, report_on_no_match: false },
    { rule_id: "detail_popup", path: ["detail", "popup"], root: "detail", required: false, report_on_no_match: true },
    { rule_id: "detail_close_button", path: ["detail", "close_button"], root: "detail", required: false, report_on_no_match: true },
    { rule_id: "detail_close_fallback_candidates", path: ["detail", "close_fallback_candidates"], root: "detail", required: false, report_on_no_match: true },
    { rule_id: "detail_ack_button", path: ["detail", "ack_button"], root: "detail", required: false, report_on_no_match: false },
    { rule_id: "detail_resume_iframe", path: ["detail", "resume_iframe"], root: "detail", required: false, report_on_no_match: true },
    { rule_id: "detail_favorite_button", path: ["detail", "favorite_button"], root: "detail", required: false, report_on_no_match: true },
    { rule_id: "detail_greet_button_recommend", path: ["detail", "greet_button_recommend"], root: "detail", required: false, report_on_no_match: true },
    { rule_id: "detail_greet_button_featured", path: ["detail", "greet_button_featured"], root: "detail", required: false, report_on_no_match: true }
  ]);
}

function analyzeSelectorChecks(selectorChecks = []) {
  const drifts = [];
  for (const check of selectorChecks) {
    if (!check || check.skipped === true) continue;
    const matches = Array.isArray(check.matches) ? check.matches : [];
    const matched = matches.find((item) => Number(item.count || 0) > 0) || null;
    if (!matched) {
      if (check.required !== true && check.report_on_no_match !== true) {
        continue;
      }
      drifts.push({
        kind: "selector",
        rule_id: check.rule_id,
        path: check.path,
        reason: check.no_match_reason || "no_selector_matched",
        confidence: Number.isFinite(Number(check.no_match_confidence)) ? Number(check.no_match_confidence) : 0.35,
        matches,
        validation_context: check.validation_context || null,
        auto_repairable: false
      });
      continue;
    }
    if (matched.index > 0) {
      if (NON_PROMOTABLE_SELECTOR_RULE_IDS.has(String(check.rule_id || ""))) {
        drifts.push({
          kind: "selector",
          rule_id: check.rule_id,
          path: check.path,
          reason: "fallback_selector_matched_non_promotable",
          confidence: 0.7,
          matches,
          selected_value: matched.selector,
          auto_repairable: false
        });
        continue;
      }
      drifts.push({
        kind: "selector",
        rule_id: check.rule_id,
        path: check.path,
        reason: "fallback_selector_matched",
        confidence: 0.98,
        matches,
        selected_value: matched.selector,
        auto_repairable: true,
        proposed_repair: {
          type: "promote_selector",
          path: ["selectors", ...check.path],
          value: matched.selector,
          confidence: 0.98
        }
      });
    }
  }
  return drifts;
}

function analyzeNetworkChecks(networkChecks = []) {
  const drifts = [];
  for (const check of networkChecks) {
    if (!check || check.skipped === true) continue;
    if (check.ok === true) continue;
    const confidence = Number.isFinite(Number(check.confidence)) ? Number(check.confidence) : 0.4;
    const drift = {
      kind: "network",
      rule_id: check.rule_id,
      path: check.path,
      reason: check.reason || "network_rule_drift",
      confidence,
      observed_value: check.observed_value || null,
      observed_items: check.observed_items || [],
      auto_repairable: false
    };
    if (check.matched_pattern && Array.isArray(check.patterns) && check.patterns.indexOf(check.matched_pattern) > 0) {
      drift.auto_repairable = confidence >= 0.9;
      drift.proposed_repair = {
        type: "promote_regex",
        path: ["network", ...check.path],
        value: check.matched_pattern,
        confidence
      };
    }
    drifts.push(drift);
  }
  return drifts;
}

function createRepairSession({ args, selectorChecks, networkChecks, drifts, proposedRepairs }) {
  const repairSessionId = randomUUID();
  const payload = {
    repair_session_id: repairSessionId,
    created_at: new Date().toISOString(),
    tool: TOOL_NAME,
    args,
    rules_path: getRecommendHealingRulesPath(),
    selector_checks: selectorChecks,
    network_checks: networkChecks,
    drifts,
    proposed_repairs: proposedRepairs,
    applied: false
  };
  writeJsonFile(getSessionPath(repairSessionId), payload);
  return payload;
}

function promoteArrayValue(values = [], targetValue) {
  const normalizedTarget = String(targetValue || "");
  const next = values.filter((item) => String(item) !== normalizedTarget);
  return [normalizedTarget, ...next];
}

function applyRepairToRules(rules, repair) {
  if (!repair || typeof repair !== "object" || !Array.isArray(repair.path) || repair.path.length < 3) {
    return false;
  }
  const [rootKey] = repair.path;
  if (!["selectors", "network"].includes(rootKey)) {
    return false;
  }
  let parent = rules;
  for (let index = 0; index < repair.path.length - 1; index += 1) {
    const part = repair.path[index];
    if (!parent[part] || typeof parent[part] !== "object" || Array.isArray(parent[part])) {
      return false;
    }
    parent = parent[part];
  }
  const leafKey = repair.path[repair.path.length - 1];
  const current = parent[leafKey];
  if (!Array.isArray(current) || current.length === 0) return false;
  if (!current.includes(repair.value)) return false;
  parent[leafKey] = promoteArrayValue(current, repair.value);
  return true;
}

function applyRepairSession(repairSessionId, confirmApply) {
  const sessionPath = getSessionPath(repairSessionId);
  const session = readJsonFile(sessionPath);
  if (!session) {
    return {
      status: "FAILED",
      error: {
        code: "SELF_HEAL_SESSION_NOT_FOUND",
        message: `未找到 repair_session_id=${repairSessionId}。`,
        retryable: false
      }
    };
  }
  if (confirmApply !== true) {
    return {
      status: "FAILED",
      error: {
        code: "SELF_HEAL_CONFIRMATION_REQUIRED",
        message: "apply 模式必须显式传入 confirm_apply=true。",
        retryable: false
      }
    };
  }
  const rules = loadRecommendHealingRules({ fresh: true });
  const appliedRepairs = [];
  for (const repair of dedupeRepairs(session.proposed_repairs || [])) {
    const confidence = Number.isFinite(Number(repair?.confidence)) ? Number(repair.confidence) : 0;
    if (confidence < 0.9) continue;
    if (applyRepairToRules(rules, repair)) {
      appliedRepairs.push(repair);
    }
  }
  if (appliedRepairs.length === 0) {
    return {
      status: "FAILED",
      error: {
        code: "SELF_HEAL_NOTHING_TO_APPLY",
        message: "当前 repair session 没有可自动应用的高置信度修复项。",
        retryable: false
      }
    };
  }
  const rulesPath = saveRecommendHealingRules(rules);
  const updatedSession = {
    ...session,
    applied: true,
    applied_at: new Date().toISOString(),
    applied_repairs: appliedRepairs,
    rules_path: rulesPath
  };
  writeJsonFile(sessionPath, updatedSession);
  return {
    status: "REPAIRED",
    repair_session_id: repairSessionId,
    rules_path: rulesPath,
    applied_repairs: appliedRepairs,
    message: "已将高置信度修复写回 recommend-healing-rules.json。"
  };
}

async function evaluate(client, expression) {
  const result = await client.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "Runtime.evaluate failed");
  }
  return result.result?.value;
}

async function pickRecommendTarget(port) {
  const targets = await CDP.List({ port });
  return targets.find((item) => typeof item?.url === "string" && item.url.includes(RECOMMEND_URL_FRAGMENT))
    || targets.find((item) => item?.type === "page")
    || null;
}

function buildRecommendFrameExpression() {
  return buildFirstSelectorLookupExpression(getRecommendSelectorRule(["top", "recommend_iframe"]));
}

function buildRootListExpression(root = "top") {
  if (root === "top") return "[document]";
  if (root === "frame") return `[${buildRecommendFrameExpression()}?.contentDocument].filter(Boolean)`;
  if (root === "detail") {
    return `(() => {
      const roots = [];
      const frame = ${buildRecommendFrameExpression()};
      if (frame?.contentDocument) roots.push(frame.contentDocument);
      if (document) roots.push(document);
      return roots;
    })()`;
  }
  return "[]";
}

function buildSelectorCheckExpression(selectors = [], root = "top") {
  return `(() => {
    const roots = ${buildRootListExpression(root)};
    if (!Array.isArray(roots) || roots.length === 0) {
      return { ok: false, error: "ROOT_NOT_AVAILABLE" };
    }
    const selectors = ${JSON.stringify(selectors)};
    const matches = selectors.map((selector, index) => {
      try {
        const count = roots.reduce((sum, currentRoot) => {
          try {
            return sum + currentRoot.querySelectorAll(selector).length;
          } catch {
            return sum;
          }
        }, 0);
        return { selector, index, count };
      } catch {
        return { selector, index, count: 0 };
      }
    });
    return { ok: true, matches };
  })()`;
}

function buildClickFirstExpression(selectors = [], root = "frame") {
  return `(() => {
    const roots = ${buildRootListExpression(root)};
    if (!Array.isArray(roots) || roots.length === 0) return { ok: false, error: "ROOT_NOT_AVAILABLE" };
    const nodes = roots.flatMap((root) => ${buildSelectorCollectionExpression(selectors, "root")});
    const target = nodes.find((node) => node && typeof node.click === "function");
    if (!target) return { ok: false, error: "TARGET_NOT_FOUND" };
    try {
      target.click();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || "CLICK_FAILED" };
    }
  })()`;
}

function buildDetailStateExpression() {
  const popupSelectors = getRecommendSelectorRule(["detail", "popup"]);
  const resumeIframeSelectors = getRecommendSelectorRule(["detail", "resume_iframe"]);
  return `(() => {
    const roots = ${buildRootListExpression("detail")};
    if (!Array.isArray(roots) || roots.length === 0) return { ok: false, open: false, error: "NO_RECOMMEND_IFRAME" };
    const popupNodes = roots.flatMap((doc) => ${buildSelectorCollectionExpression(popupSelectors, "doc")});
    const resumeNodes = roots.flatMap((doc) => ${buildSelectorCollectionExpression(resumeIframeSelectors, "doc")});
    return {
      ok: true,
      open: popupNodes.length > 0 || resumeNodes.length > 0,
      popup_count: popupNodes.length,
      resume_iframe_count: resumeNodes.length
    };
  })()`;
}

function buildDetailCloseExpression() {
  const closeSelectors = getRecommendSelectorRule(["detail", "close_button"]);
  return `(() => {
    const roots = ${buildRootListExpression("detail")};
    const closeTargets = Array.isArray(roots)
      ? roots.flatMap((doc) => ${buildSelectorCollectionExpression(closeSelectors, "doc")})
      : [];
    const target = closeTargets.find((node) => node && typeof node.click === "function");
    if (!target) return { ok: false, error: "DETAIL_CLOSE_TARGET_NOT_FOUND" };
    try {
      target.click();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || "DETAIL_CLOSE_FAILED" };
    }
  })()`;
}

function buildActionButtonExpression(selectors = []) {
  return `(() => {
    const roots = ${buildRootListExpression("detail")};
    if (!Array.isArray(roots) || roots.length === 0) return { ok: false, error: "NO_RECOMMEND_IFRAME" };
    const nodes = roots.flatMap((doc) => ${buildSelectorCollectionExpression(selectors, "doc")});
    const target = nodes.find((node) => node && typeof node.click === "function");
    if (!target) return { ok: false, error: "ACTION_BUTTON_NOT_FOUND" };
    const className = String(target.className || "");
    const text = String(target.textContent || "").replace(/\\s+/g, " ").trim();
    return { ok: true, class_name: className, text };
  })()`;
}

function buildActionClickExpression(selectors = []) {
  return `(() => {
    const roots = ${buildRootListExpression("detail")};
    if (!Array.isArray(roots) || roots.length === 0) return { ok: false, error: "NO_RECOMMEND_IFRAME" };
    const nodes = roots.flatMap((doc) => ${buildSelectorCollectionExpression(selectors, "doc")});
    const target = nodes.find((node) => node && typeof node.click === "function");
    if (!target) return { ok: false, error: "ACTION_BUTTON_NOT_FOUND" };
    try {
      target.click();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || "ACTION_CLICK_FAILED" };
    }
  })()`;
}

function buildFilterPanelStateExpression() {
  const panelSelectors = getRecommendSelectorRule(["frame", "filter_panel"]);
  const confirmSelectors = getRecommendSelectorRule(["frame", "filter_confirm_button"]);
  const groupSelectors = getRecommendSelectorRule(["frame", "filter_group_container"]);
  const optionSelectors = getRecommendSelectorRule(["frame", "filter_option"]);
  return `(() => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    const collect = (selectors, root = doc) => selectors.flatMap((selector) => {
      try { return Array.from(root.querySelectorAll(selector)); } catch { return []; }
    });
    const panels = collect(${JSON.stringify(panelSelectors)}).filter(isVisible);
    const panelRoot = panels[0] || null;
    const confirmButtons = panelRoot
      ? collect(${JSON.stringify(confirmSelectors)}, panelRoot).filter((item) => isVisible(item))
      : [];
    const groups = panelRoot
      ? collect(${JSON.stringify(groupSelectors)}, panelRoot).filter((item) => isVisible(item))
      : [];
    const options = panelRoot
      ? collect(${JSON.stringify(optionSelectors)}, panelRoot).filter((item) => isVisible(item))
      : [];
    const confirmButton = confirmButtons.find((item) => /确定|确认|完成|应用/.test(normalize(item.textContent || ''))) || confirmButtons[0] || null;
    return {
      ok: true,
      visible: Boolean(panelRoot),
      panel_count: panels.length,
      confirm_button_visible: Boolean(confirmButton),
      confirm_button_text: confirmButton ? normalize(confirmButton.textContent || '') : null,
      group_count: groups.length,
      option_count: options.length
    };
  })()`;
}

function buildFilterTriggerClickExpression() {
  const triggerSelectors = getRecommendSelectorRule(["frame", "filter_trigger"]);
  return `(() => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    for (const selector of ${JSON.stringify(triggerSelectors)}) {
      const node = (() => { try { return doc.querySelector(selector); } catch { return null; } })();
      if (!node || !isVisible(node)) continue;
      try {
        node.click();
        return { ok: true, selector };
      } catch (error) {
        return { ok: false, error: error?.message || 'FILTER_TRIGGER_CLICK_FAILED', selector };
      }
    }
    return { ok: false, error: 'FILTER_TRIGGER_NOT_FOUND' };
  })()`;
}

function buildFilterConfirmClickExpression() {
  const confirmSelectors = getRecommendSelectorRule(["frame", "filter_confirm_button"]);
  const panelSelectors = getRecommendSelectorRule(["frame", "filter_panel"]);
  return `(() => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    const panels = ${buildSelectorCollectionExpression(panelSelectors, "doc")}.filter((item) => isVisible(item));
    const panel = panels[0] || null;
    if (!panel) return { ok: false, error: 'FILTER_PANEL_NOT_FOUND' };
    const buttons = ${buildSelectorCollectionExpression(confirmSelectors, "panel")}.filter((item) => isVisible(item));
    const target = buttons.find((item) => /确定|确认|完成|应用/.test(normalize(item.textContent || ''))) || buttons[0] || null;
    if (!target) return { ok: false, error: 'FILTER_CONFIRM_BUTTON_NOT_FOUND' };
    try {
      target.click();
      return { ok: true, text: normalize(target.textContent || '') || null };
    } catch (error) {
      return { ok: false, error: error?.message || 'FILTER_CONFIRM_CLICK_FAILED' };
    }
  })()`;
}

function buildFilterGroupProbeExpression(groupClass) {
  const groupContainerSelectors = getRecommendSelectorRule(["frame", "filter_group_container"]);
  const optionSelectors = getRecommendSelectorRule(["frame", "filter_option_all"], getRecommendSelectorRule(["frame", "filter_option"]));
  const groupSelectorMap = {
    school: getRecommendSelectorRule(["frame", "filter_group_school"], [".check-box.school"]),
    degree: getRecommendSelectorRule(["frame", "filter_group_degree"], [".check-box.degree"]),
    gender: getRecommendSelectorRule(["frame", "filter_group_gender"], [".check-box.gender"]),
    recentNotView: getRecommendSelectorRule(["frame", "filter_group_recent_not_view"], [".check-box.recentNotView"])
  };
  const scrollContainerSelectors = getRecommendSelectorRule(["frame", "filter_scroll_container"]);
  return `((groupClass) => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME', group_class: groupClass };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
    const collect = (selectors, root = doc) => selectors.flatMap((selector) => {
      try { return Array.from(root.querySelectorAll(selector)); } catch { return []; }
    });
    const pickVisibleGroup = (groups) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      };
      return groups.find((group) => isVisible(group)) || groups[0] || null;
    };
    const optionSetOf = (group) => new Set(
      collect(${JSON.stringify(optionSelectors)}, group)
        .map((node) => normalize(node.textContent || ''))
        .filter(Boolean)
    );
    const groups = collect(${JSON.stringify(groupContainerSelectors)});
    const directSelectors = (${JSON.stringify(groupSelectorMap)})[groupClass] || [];
    let group = pickVisibleGroup(collect(directSelectors));
    let matchedBy = group ? 'direct' : null;
    if (!group) {
      if (groupClass === 'school') {
        group = groups.find((item) => {
          const set = optionSetOf(item);
          return set.has('985') || set.has('211') || set.has('双一流院校');
        }) || null;
      } else if (groupClass === 'degree') {
        group = groups.find((item) => {
          const set = optionSetOf(item);
          return set.has('大专') || set.has('本科') || set.has('硕士') || set.has('博士');
        }) || null;
      } else if (groupClass === 'gender') {
        group = groups.find((item) => {
          const set = optionSetOf(item);
          return set.has('男') || set.has('女');
        }) || null;
      } else if (groupClass === 'recentNotView') {
        group = groups.find((item) => {
          const set = optionSetOf(item);
          return set.has('近14天没有');
        }) || null;
      }
      if (group) matchedBy = 'option-signature';
    }
    let usedScroll = false;
    let scrollerMatchedSelector = null;
    if (!group) {
      const scrollerMatch = ${JSON.stringify(scrollContainerSelectors)}
        .map((selector) => ({ selector, node: (() => { try { return doc.querySelector(selector); } catch { return null; } })() }))
        .find((item) => item.node) || null;
      const scroller = scrollerMatch?.node || null;
      if (scroller) {
        scrollerMatchedSelector = scrollerMatch.selector;
        const maxScrollTop = Math.max(0, Number(scroller.scrollHeight || 0) - Number(scroller.clientHeight || 0));
        const steps = 14;
        for (let index = 0; index <= steps; index += 1) {
          const nextTop = maxScrollTop <= 0 ? 0 : Math.round((maxScrollTop * index) / steps);
          scroller.scrollTop = nextTop;
          usedScroll = true;
          const refreshedGroups = collect(${JSON.stringify(groupContainerSelectors)});
          if (groupClass === 'school') {
            group = refreshedGroups.find((item) => {
              const set = optionSetOf(item);
              return set.has('985') || set.has('211') || set.has('双一流院校');
            }) || null;
          } else if (groupClass === 'degree') {
            group = refreshedGroups.find((item) => {
              const set = optionSetOf(item);
              return set.has('大专') || set.has('本科') || set.has('硕士') || set.has('博士');
            }) || null;
          } else if (groupClass === 'gender') {
            group = refreshedGroups.find((item) => {
              const set = optionSetOf(item);
              return set.has('男') || set.has('女');
            }) || null;
          } else if (groupClass === 'recentNotView') {
            group = refreshedGroups.find((item) => {
              const set = optionSetOf(item);
              return set.has('近14天没有');
            }) || null;
          }
          if (group) {
            matchedBy = 'option-signature-after-scroll';
            break;
          }
        }
      }
    }
    const optionCount = group ? collect(${JSON.stringify(optionSelectors)}, group).length : 0;
    return {
      ok: Boolean(group),
      group_class: groupClass,
      matched_by: matchedBy,
      used_scroll: usedScroll,
      scroll_container_selector: scrollerMatchedSelector,
      group_option_count: optionCount
    };
  })(${JSON.stringify(groupClass)})`;
}

function buildAckButtonExpression() {
  const ackSelectors = getRecommendSelectorRule(["detail", "ack_button"]);
  return `(() => {
    const roots = ${buildRootListExpression("detail")};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    if (!Array.isArray(roots) || roots.length === 0) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    for (const doc of roots) {
      for (const selector of ${JSON.stringify(ackSelectors)}) {
        const nodes = (() => { try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; } })();
        const target = nodes.find((item) => item && item.offsetParent !== null && normalize(item.textContent || '') === '知道了') || null;
        if (target) {
          return { ok: true, selector, text: normalize(target.textContent || '') };
        }
      }
    }
    return { ok: false, error: 'ACK_BUTTON_NOT_FOUND' };
  })()`;
}

function buildAckButtonClickExpression() {
  const ackSelectors = getRecommendSelectorRule(["detail", "ack_button"]);
  return `(() => {
    const roots = ${buildRootListExpression("detail")};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    if (!Array.isArray(roots) || roots.length === 0) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    for (const doc of roots) {
      for (const selector of ${JSON.stringify(ackSelectors)}) {
        const nodes = (() => { try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; } })();
        const target = nodes.find((item) => item && item.offsetParent !== null && normalize(item.textContent || '') === '知道了') || null;
        if (!target) continue;
        try {
          target.click();
          return { ok: true, selector };
        } catch (error) {
          return { ok: false, error: error?.message || 'ACK_BUTTON_CLICK_FAILED', selector };
        }
      }
    }
    return { ok: false, error: 'ACK_BUTTON_NOT_FOUND' };
  })()`;
}

function buildDetailClosedStateExpression() {
  const popupSelectors = getRecommendSelectorRule(["detail", "popup"]);
  const resumeSelectors = getRecommendSelectorRule(["detail", "resume_iframe"]);
  const favoriteSelectors = getRecommendSelectorRule(["detail", "favorite_button"]);
  const greetSelectors = [
    ...getRecommendSelectorRule(["detail", "greet_button_recommend"]),
    ...getRecommendSelectorRule(["detail", "greet_button_featured"])
  ];
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const pickVisibleKnowButton = (rootDoc) => {
      if (!rootDoc) return null;
      const buttons = Array.from(rootDoc.querySelectorAll('button.btn-v2.btn-sure-v2, button.btn'));
      return buttons.find((item) => normalize(item.textContent || '') === '知道了' && item.offsetParent !== null) || null;
    };
    const topKnow = pickVisibleKnowButton(document);
    if (topKnow) return { closed: false, reason: 'top know button visible' };
    const topPopups = ${buildSelectorCollectionExpression(popupSelectors, "document")}.filter((item) => item && item.offsetParent !== null);
    if (topPopups.length > 0) return { closed: false, reason: 'top popup visible' };
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) return { closed: true, reason: 'NO_RECOMMEND_IFRAME' };
    const doc = frame.contentDocument;
    const frameKnow = pickVisibleKnowButton(doc);
    if (frameKnow) return { closed: false, reason: 'frame know button visible' };
    const popupNodes = ${buildSelectorCollectionExpression(popupSelectors, "doc")}.filter((item) => item && item.offsetParent !== null);
    if (popupNodes.length > 0) return { closed: false, reason: 'popup visible' };
    const detailSignals = [
      ...${JSON.stringify(resumeSelectors)},
      ...${JSON.stringify(favoriteSelectors)},
      ...${JSON.stringify(greetSelectors)}
    ];
    for (const selector of detailSignals) {
      const node = (() => { try { return doc.querySelector(selector); } catch { return null; } })();
      if (node && node.offsetParent !== null) return { closed: false, reason: 'detail signal visible: ' + selector };
    }
    return { closed: true, reason: 'no popup or detail signal visible' };
  })()`;
}

function buildRecommendTabStateExpression() {
  const tabSelectors = getRecommendSelectorRule(["frame", "tab_items"]);
  const recommendCardSelectors = getRecommendSelectorRule(["frame", "recommend_cards"]);
  const featuredCardSelectors = getRecommendSelectorRule(["frame", "featured_cards"]);
  const latestCardSelectors = getRecommendSelectorRule(["frame", "latest_cards"]);
  return `(() => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const tabs = Array.from(new Set(${JSON.stringify(tabSelectors)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      }))).map((node) => {
      const status = normalize(node.getAttribute('data-status'));
      const className = normalize(node.className);
      const active = (
        /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(className)
        || normalize(node.getAttribute('aria-selected')) === 'true'
        || normalize(node.getAttribute('data-selected')) === 'true'
      );
      return {
        status: status || null,
        title: normalize(node.getAttribute('title')) || null,
        label: normalize(node.textContent) || null,
        active,
        class_name: className || null
      };
    });
    const countBy = (selectors) => selectors.reduce((sum, selector) => {
      try { return sum + doc.querySelectorAll(selector).length; } catch { return sum; }
    }, 0);
    const recommendCount = countBy(${JSON.stringify(recommendCardSelectors)});
    const featuredCount = countBy(${JSON.stringify(featuredCardSelectors)});
    const latestCount = countBy(${JSON.stringify(latestCardSelectors)});
    const activeTab = tabs.find((item) => item.active && item.status) || null;
    let inferredStatus = activeTab?.status || null;
    if (!inferredStatus) {
      if (featuredCount > 0 && recommendCount === 0 && latestCount === 0) inferredStatus = '3';
      else if (latestCount > 0 && featuredCount === 0 && recommendCount === 0) inferredStatus = '1';
      else if (recommendCount > 0 && featuredCount === 0 && latestCount === 0) inferredStatus = '0';
    }
    return {
      ok: true,
      active_status: inferredStatus,
      tabs,
      layout: {
        recommend_count: recommendCount,
        featured_count: featuredCount,
        latest_count: latestCount
      }
    };
  })()`;
}

function buildRecommendTabSwitchExpression(targetStatus) {
  const tabSelectors = getRecommendSelectorRule(["frame", "tab_items"]);
  return `((targetStatus) => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, state: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const tabs = Array.from(new Set(${JSON.stringify(tabSelectors)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      })));
    const target = tabs.find((node) => normalize(node.getAttribute('data-status')) === String(targetStatus)) || null;
    if (!target) {
      return { ok: false, state: 'TAB_NOT_FOUND', target_status: String(targetStatus) };
    }
    try {
      target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    } catch {}
    try {
      target.click();
      return { ok: true, state: 'TAB_CLICKED', target_status: String(targetStatus) };
    } catch (error) {
      return {
        ok: false,
        state: 'TAB_CLICK_FAILED',
        message: error?.message || String(error),
        target_status: String(targetStatus)
      };
    }
  })(${JSON.stringify(String(targetStatus))})`;
}

function buildCandidateSurfaceStateExpression() {
  const specific = {
    recommend: getRecommendSelectorRule(["frame", "recommend_cards"]),
    latest: getRecommendSelectorRule(["frame", "latest_cards"]),
    featured: getRecommendSelectorRule(["frame", "featured_cards"])
  };
  const genericSelectors = [
    ...specific.recommend,
    ...specific.latest,
    ...specific.featured,
    ...getRecommendSelectorRule(["frame", "recommend_card_inner"]),
    ...getRecommendSelectorRule(["frame", "latest_card_inner"]),
    ...getRecommendSelectorRule(["frame", "featured_card_anchor"])
  ];
  return `(() => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const countBy = (selectors) => selectors.reduce((sum, selector) => {
      try { return sum + doc.querySelectorAll(selector).length; } catch { return sum; }
    }, 0);
    const uniqueNodes = Array.from(new Set(${JSON.stringify(genericSelectors)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      })));
    const tabState = ${buildRecommendTabStateExpression()};
    return {
      ok: true,
      active_status: tabState?.active_status || null,
      counts: {
        recommend: countBy(${JSON.stringify(specific.recommend)}),
        latest: countBy(${JSON.stringify(specific.latest)}),
        featured: countBy(${JSON.stringify(specific.featured)}),
        generic: uniqueNodes.length
      }
    };
  })()`;
}

function buildCandidateCountStateExpression() {
  const recommendCardSelectors = getRecommendSelectorRule(["frame", "recommend_cards"]);
  const recommendInnerSelectors = getRecommendSelectorRule(["frame", "recommend_card_inner"]);
  const featuredCardSelectors = getRecommendSelectorRule(["frame", "featured_cards"]);
  const featuredAnchorSelectors = getRecommendSelectorRule(["frame", "featured_card_anchor"]);
  const latestCardSelectors = getRecommendSelectorRule(["frame", "latest_cards"]);
  const latestInnerSelectors = getRecommendSelectorRule(["frame", "latest_card_inner"]);
  const tabSelectors = getRecommendSelectorRule(["frame", "tab_items"]);
  return `(() => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const collect = (selectors) => selectors.flatMap((selector) => {
      try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
    });
    const cards = collect(${JSON.stringify(recommendCardSelectors)});
    const recommendCandidates = cards.filter((card) => ${buildSelectorCollectionExpression(recommendInnerSelectors, "card")}.length > 0);
    const featuredCards = collect(${JSON.stringify(featuredCardSelectors)});
    const featuredCandidates = featuredCards.filter((card) => ${buildSelectorCollectionExpression(featuredAnchorSelectors, "card")}.length > 0);
    const latestCards = collect(${JSON.stringify(latestCardSelectors)});
    const latestCandidates = latestCards.filter((card) => ${buildSelectorCollectionExpression(latestInnerSelectors, "card")}.length > 0);
    const tabs = collect(${JSON.stringify(tabSelectors)});
    const activeTab = tabs.find((node) => {
      const className = String(node.className || '');
      const selected = String(node.getAttribute('aria-selected') || '').toLowerCase() === 'true';
      return /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(className) || selected;
    }) || null;
    const activeTabStatus = activeTab ? String(activeTab.getAttribute('data-status') || '') : '';
    const inferredStatus = activeTabStatus
      || (featuredCandidates.length > 0 && recommendCandidates.length === 0 && latestCandidates.length === 0
        ? '3'
        : latestCandidates.length > 0 && recommendCandidates.length === 0 && featuredCandidates.length === 0
          ? '1'
          : recommendCandidates.length > 0 && featuredCandidates.length === 0 && latestCandidates.length === 0
            ? '0'
            : '');
    const effectiveCount = inferredStatus === '3'
      ? featuredCandidates.length
      : inferredStatus === '1'
        ? latestCandidates.length
        : inferredStatus === '0'
          ? recommendCandidates.length
          : Math.max(recommendCandidates.length, featuredCandidates.length, latestCandidates.length);
    return {
      ok: true,
      candidateCount: effectiveCount,
      recommendCandidateCount: recommendCandidates.length,
      featuredCandidateCount: featuredCandidates.length,
      latestCandidateCount: latestCandidates.length,
      activeTabStatus: inferredStatus || null
    };
  })()`;
}

function buildDetailOpenExpression() {
  const recommendInnerSelectors = getRecommendSelectorRule(["frame", "recommend_card_inner"]);
  const latestInnerSelectors = getRecommendSelectorRule(["frame", "latest_card_inner"]);
  const featuredAnchorSelectors = getRecommendSelectorRule(["frame", "featured_card_anchor"]);
  const recommendCardSelectors = getRecommendSelectorRule(["frame", "recommend_cards"]);
  const latestCardSelectors = getRecommendSelectorRule(["frame", "latest_cards"]);
  const featuredCardSelectors = getRecommendSelectorRule(["frame", "featured_cards"]);
  return `(() => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    const collect = (selectors, root = doc) => selectors.flatMap((selector) => {
      try { return Array.from(root.querySelectorAll(selector)); } catch { return []; }
    });
    const tabs = collect(${JSON.stringify(getRecommendSelectorRule(["frame", "tab_items"]))});
    const activeTab = tabs.find((node) => {
      const className = String(node.className || '');
      const selected = String(node.getAttribute('aria-selected') || '').toLowerCase() === 'true';
      return /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(className) || selected;
    }) || null;
    const recommendTargetsRaw = collect(${JSON.stringify(recommendCardSelectors)}).flatMap((card) => {
      const inner = collect(${JSON.stringify(recommendInnerSelectors)}, card);
      return [...inner, card];
    });
    const latestTargetsRaw = collect(${JSON.stringify(latestCardSelectors)}).flatMap((card) => {
      const inner = collect(${JSON.stringify(latestInnerSelectors)}, card);
      return [...inner, card];
    });
    const featuredTargetsRaw = collect(${JSON.stringify(featuredCardSelectors)}).flatMap((card) => {
      const inner = collect(${JSON.stringify(featuredAnchorSelectors)}, card);
      return [...inner, card];
    });
    const recommendVisible = recommendTargetsRaw.filter((node) => isVisible(node));
    const latestVisible = latestTargetsRaw.filter((node) => isVisible(node));
    const featuredVisible = featuredTargetsRaw.filter((node) => isVisible(node));
    let activeStatus = normalize(activeTab?.getAttribute('data-status') || '');
    if (!activeStatus) {
      if (featuredVisible.length > 0 && recommendVisible.length === 0 && latestVisible.length === 0) activeStatus = '3';
      else if (latestVisible.length > 0 && recommendVisible.length === 0 && featuredVisible.length === 0) activeStatus = '1';
      else if (recommendVisible.length > 0 && latestVisible.length === 0 && featuredVisible.length === 0) activeStatus = '0';
    }
    let targets = [];
    if (activeStatus === '3') {
      targets = featuredTargetsRaw;
    } else if (activeStatus === '1') {
      targets = latestTargetsRaw;
    } else {
      targets = recommendTargetsRaw;
    }
    const target = targets.find((node) => node && typeof node.click === 'function' && isVisible(node));
    if (!target) return { ok: false, error: 'TARGET_NOT_FOUND', active_status: activeStatus || null };
    try {
      target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    } catch {}
    try {
      target.click();
      return { ok: true, active_status: activeStatus || null };
    } catch (error) {
      return { ok: false, error: error?.message || 'CLICK_FAILED', active_status: activeStatus || null };
    }
  })()`;
}

function buildJobListStateExpression() {
  const jobItemSelectors = getRecommendSelectorRule(["frame", "job_list_items"]);
  const selectedLabelSelectors = getRecommendSelectorRule(["frame", "job_selected_label"]);
  return `(() => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const normalizeTitle = (value) => {
      const text = normalize(value);
      if (!text) return '';
      const byGap = text.split(/\\s{2,}/).map((item) => item.trim()).filter(Boolean)[0] || text;
      const strippedRange = byGap
        .replace(/\\s+\\d+(?:\\.\\d+)?\\s*(?:-|~|—|至)\\s*\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元\\/天|元\\/月|元\\/年|K\\/月|k\\/月|万\\/月|万\\/年)?$/u, '')
        .trim();
      const strippedSingle = strippedRange
        .replace(/\\s+\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元\\/天|元\\/月|元\\/年|K\\/月|k\\/月|万\\/月|万\\/年)$/u, '')
        .trim();
      return strippedSingle || byGap;
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    const items = ${JSON.stringify(jobItemSelectors)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      });
    const jobs = [];
    const seen = new Set();
    for (const item of items) {
      const label = normalize(item.querySelector('.label')?.textContent || item.textContent || '');
      const title = normalizeTitle(label);
      const value = normalize(item.getAttribute('value') || item.dataset?.value || '');
      const dedupeKey = value || title || label;
      if (!dedupeKey || seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      jobs.push({
        value: value || null,
        title: title || label || null,
        label: label || null,
        current: item.classList.contains('curr') || item.classList.contains('active'),
        visible: isVisible(item)
      });
    }
    const selectedLabelNode = ${JSON.stringify(selectedLabelSelectors)}
      .map((selector) => {
        try { return doc.querySelector(selector); } catch { return null; }
      })
      .find((node) => node) || null;
    return {
      ok: true,
      jobs,
      selected_label: normalize(selectedLabelNode ? selectedLabelNode.textContent : '')
    };
  })()`;
}

function buildJobDropdownClickExpression() {
  const dropdownSelectors = getRecommendSelectorRule(["frame", "job_dropdown_trigger"]);
  return `(() => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    };
    for (const selector of ${JSON.stringify(dropdownSelectors)}) {
      const el = doc.querySelector(selector);
      if (el && isVisible(el)) {
        el.click();
        return { ok: true };
      }
    }
    return { ok: false, error: 'JOB_TRIGGER_NOT_FOUND' };
  })()`;
}

function buildJobSelectExpression(job) {
  const jobItemSelectors = getRecommendSelectorRule(["frame", "job_list_items"]);
  return `((job) => {
    const frame = ${buildRecommendFrameExpression()};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const normalizeTitle = (value) => {
      const text = normalize(value);
      if (!text) return '';
      const byGap = text.split(/\\s{2,}/).map((item) => item.trim()).filter(Boolean)[0] || text;
      const strippedRange = byGap
        .replace(/\\s+\\d+(?:\\.\\d+)?\\s*(?:-|~|—|至)\\s*\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元\\/天|元\\/月|元\\/年|K\\/月|k\\/月|万\\/月|万\\/年)?$/u, '')
        .trim();
      const strippedSingle = strippedRange
        .replace(/\\s+\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元\\/天|元\\/月|元\\/年|K\\/月|k\\/月|万\\/月|万\\/年)$/u, '')
        .trim();
      return strippedSingle || byGap;
    };
    const items = ${JSON.stringify(jobItemSelectors)}
      .flatMap((selector) => {
        try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; }
      });
    const target = items.find((item) => {
      const value = normalize(item.getAttribute('value') || item.dataset?.value || '');
      const label = normalize(item.querySelector('.label')?.textContent || item.textContent || '');
      const title = normalizeTitle(label);
      const matchValue = job.value && value && value === normalize(job.value);
      const matchTitle = job.title && title && title === normalize(job.title);
      const matchLabel = job.label && label && label === normalize(job.label);
      return matchValue || matchTitle || matchLabel;
    });
    if (!target) {
      return { ok: false, error: 'JOB_OPTION_NOT_FOUND' };
    }
    target.click();
    return { ok: true };
  })(${JSON.stringify(job)})`;
}

function upsertSelectorCheck(selectorChecks, nextCheck) {
  const index = selectorChecks.findIndex((item) => item?.rule_id === nextCheck?.rule_id);
  if (index >= 0) selectorChecks[index] = nextCheck;
  else selectorChecks.push(nextCheck);
}

async function waitForRecommendTabStatus(client, targetStatus, rounds = 12) {
  const normalizedTarget = String(targetStatus);
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    const state = await evaluate(client, buildRecommendTabStateExpression());
    if (state?.ok && String(state.active_status || "") === normalizedTarget) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 220 + attempt * 40));
  }
  return await evaluate(client, buildRecommendTabStateExpression());
}

async function waitForCandidateCountStable(client, expectedTabStatus = null, rounds = 10) {
  let lastCount = null;
  let stableRounds = 0;
  let latest = null;
  for (let index = 0; index < rounds; index += 1) {
    latest = await evaluate(client, buildCandidateCountStateExpression());
    const status = normalizeText(latest?.activeTabStatus || "");
    const current = latest?.candidateCount ?? null;
    if (expectedTabStatus && status && status !== String(expectedTabStatus)) {
      stableRounds = 0;
      lastCount = current;
      await new Promise((resolve) => setTimeout(resolve, 350 + index * 50));
      continue;
    }
    if (current !== null && current === lastCount) {
      stableRounds += 1;
      const shouldKeepWaitingForZero = Number(current) === 0 && index < Math.min(rounds - 1, 5);
      if (stableRounds >= 2 && !shouldKeepWaitingForZero) {
        return latest;
      }
    } else {
      stableRounds = 0;
    }
    lastCount = current;
    await new Promise((resolve) => setTimeout(resolve, 350 + index * 50));
  }
  return latest || await evaluate(client, buildCandidateCountStateExpression());
}

async function waitForFilterPanelVisible(client, expectedVisible, rounds = 10) {
  let latest = null;
  for (let index = 0; index < rounds; index += 1) {
    latest = await evaluate(client, buildFilterPanelStateExpression());
    if (Boolean(latest?.visible) === Boolean(expectedVisible)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 150 + index * 40));
  }
  return latest || await evaluate(client, buildFilterPanelStateExpression());
}

async function validateFilterScopedSelectors(client, selectorChecks, extraDrifts) {
  const openResult = await evaluate(client, buildFilterTriggerClickExpression());
  if (!openResult?.ok) {
    extraDrifts.push({
      kind: "validation",
      rule_id: "filter_panel_activation",
      path: ["frame", "filter_panel"],
      reason: "filter_panel_open_failed",
      confidence: 0.9,
      auto_repairable: false,
      details: openResult?.error || null
    });
    return;
  }
  const panelState = await waitForFilterPanelVisible(client, true, 12);
  const panelVisible = panelState?.visible === true;
  const defs = [
    { rule_id: "filter_panel", path: ["frame", "filter_panel"], contextCount: Number(panelState?.panel_count || 0) },
    { rule_id: "filter_confirm_button", path: ["frame", "filter_confirm_button"], contextCount: Number(panelState?.confirm_button_visible ? 1 : 0) },
    { rule_id: "filter_confirm_candidates", path: ["frame", "filter_confirm_candidates"], contextCount: Number(panelState?.confirm_button_visible ? 1 : 0) },
    { rule_id: "filter_group_container", path: ["frame", "filter_group_container"], contextCount: Number(panelState?.group_count || 0) },
    { rule_id: "filter_option", path: ["frame", "filter_option"], contextCount: Number(panelState?.option_count || 0) },
    { rule_id: "filter_option_all", path: ["frame", "filter_option_all"], contextCount: Number(panelState?.option_count || 0) },
    { rule_id: "filter_option_active", path: ["frame", "filter_option_active"], contextCount: Number(panelState?.option_count || 0) },
    { rule_id: "filter_scroll_container", path: ["frame", "filter_scroll_container"], contextCount: Number(panelState?.visible ? 1 : 0) }
  ];
  for (const definition of defs) {
    const response = await evaluate(client, buildSelectorCheckExpression(getRecommendSelectorRule(definition.path), "frame"));
    upsertSelectorCheck(selectorChecks, {
      rule_id: definition.rule_id,
      path: definition.path,
      root: "frame",
      required: false,
      report_on_no_match: panelVisible && definition.contextCount > 0,
      no_match_reason: "no_selector_matched_after_filter_panel_open",
      no_match_confidence: 0.87,
      validation_context: {
        filter_panel_visible: panelVisible,
        context_count: definition.contextCount
      },
      skipped: response?.error === "ROOT_NOT_AVAILABLE",
      matches: Array.isArray(response?.matches) ? response.matches : []
    });
  }

  const groupValidations = [
    { groupClass: "school", rule_id: "filter_group_school", path: ["frame", "filter_group_school"] },
    { groupClass: "degree", rule_id: "filter_group_degree", path: ["frame", "filter_group_degree"] },
    { groupClass: "gender", rule_id: "filter_group_gender", path: ["frame", "filter_group_gender"] },
    { groupClass: "recentNotView", rule_id: "filter_group_recent_not_view", path: ["frame", "filter_group_recent_not_view"] }
  ];
  for (const groupValidation of groupValidations) {
    const probe = await evaluate(client, buildFilterGroupProbeExpression(groupValidation.groupClass));
    const response = await evaluate(client, buildSelectorCheckExpression(getRecommendSelectorRule(groupValidation.path), "frame"));
    upsertSelectorCheck(selectorChecks, {
      rule_id: groupValidation.rule_id,
      path: groupValidation.path,
      root: "frame",
      required: false,
      report_on_no_match: probe?.ok === true,
      no_match_reason: "no_selector_matched_after_group_probe",
      no_match_confidence: 0.9,
      validation_context: {
        group_class: groupValidation.groupClass,
        group_probe_ok: probe?.ok === true,
        matched_by: probe?.matched_by || null,
        used_scroll: probe?.used_scroll === true,
        scroll_container_selector: probe?.scroll_container_selector || null,
        group_option_count: Number(probe?.group_option_count || 0)
      },
      skipped: response?.error === "ROOT_NOT_AVAILABLE",
      matches: Array.isArray(response?.matches) ? response.matches : []
    });
    if (probe?.ok !== true) {
      extraDrifts.push({
        kind: "validation",
        rule_id: `${groupValidation.rule_id}_activation`,
        path: groupValidation.path,
        reason: "filter_group_probe_failed",
        confidence: 0.86,
        auto_repairable: false,
        details: probe?.error || null
      });
    }
  }

  const closeResult = await evaluate(client, buildFilterConfirmClickExpression());
  if (!closeResult?.ok) {
    extraDrifts.push({
      kind: "validation",
      rule_id: "filter_panel_close",
      path: ["frame", "filter_confirm_button"],
      reason: "filter_panel_close_failed",
      confidence: 0.88,
      auto_repairable: false,
      details: closeResult?.error || null
    });
    return;
  }
  const closedState = await waitForFilterPanelVisible(client, false, 12);
  if (closedState?.visible === true) {
    extraDrifts.push({
      kind: "validation",
      rule_id: "filter_panel_close",
      path: ["frame", "filter_confirm_button"],
      reason: "filter_panel_still_visible_after_confirm",
      confidence: 0.88,
      auto_repairable: false
    });
  }
}

async function ensureRecommendTabActive(client, targetStatus) {
  const before = await evaluate(client, buildRecommendTabStateExpression());
  if (before?.ok && String(before.active_status || "") === String(targetStatus)) {
    return { ok: true, before, after: before, switched: false };
  }
  const clickResult = await evaluate(client, buildRecommendTabSwitchExpression(targetStatus));
  if (!clickResult?.ok) {
    return { ok: false, before, click_result: clickResult };
  }
  const after = await waitForRecommendTabStatus(client, targetStatus, 12);
  return {
    ok: after?.ok === true && String(after.active_status || "") === String(targetStatus),
    before,
    after,
    click_result: clickResult,
    switched: true
  };
}

async function ensureJobListReady(client) {
  let lastError = "JOB_LIST_NOT_FOUND";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await evaluate(client, buildJobListStateExpression());
    if (state?.ok && Array.isArray(state.jobs) && state.jobs.length > 0) {
      return state;
    }
    lastError = state?.error || lastError;
    const clickResult = await evaluate(client, buildJobDropdownClickExpression());
    if (!clickResult?.ok) {
      lastError = clickResult?.error || lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 220 + attempt * 80));
  }
  throw new Error(lastError);
}

async function waitForJobSelected(client, job, rounds = 10) {
  const selectedValue = normalizeText(job?.value || "");
  const selectedTitle = normalizeText(job?.title || "");
  const selectedLabel = normalizeText(job?.label || "");
  for (let index = 0; index < rounds; index += 1) {
    const state = await evaluate(client, buildJobListStateExpression());
    if (state?.ok) {
      const current = (state.jobs || []).find((item) => item.current);
      if (current) {
        const sameValue = selectedValue && normalizeText(current.value || "") === selectedValue;
        const sameTitle = selectedTitle && normalizeText(current.title || "") === selectedTitle;
        const sameLabel = selectedLabel && normalizeText(current.label || "") === selectedLabel;
        if (sameValue || sameTitle || sameLabel) return { ok: true, state };
      }
      const selectedText = normalizeText(state.selected_label || "");
      if (selectedTitle && selectedText && (selectedText === selectedTitle || selectedText.includes(selectedTitle))) {
        return { ok: true, state };
      }
      if (selectedLabel && selectedText && (selectedText === selectedLabel || selectedText.includes(selectedLabel))) {
        return { ok: true, state };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150 + index * 40));
  }
  return { ok: false, state: await evaluate(client, buildJobListStateExpression()) };
}

async function validateTabScopedCardSelectors(client, selectorChecks, extraDrifts, originalTabStatus) {
  const validations = [
    {
      rule_id: "recommend_cards",
      path: ["frame", "recommend_cards"],
      inner_rule_id: "recommend_card_inner",
      inner_path: ["frame", "recommend_card_inner"],
      target_status: "0",
      tab_name: "recommend"
    },
    {
      rule_id: "latest_cards",
      path: ["frame", "latest_cards"],
      inner_rule_id: "latest_card_inner",
      inner_path: ["frame", "latest_card_inner"],
      target_status: "1",
      tab_name: "latest"
    },
    {
      rule_id: "featured_cards",
      path: ["frame", "featured_cards"],
      inner_rule_id: "featured_card_anchor",
      inner_path: ["frame", "featured_card_anchor"],
      target_status: "3",
      tab_name: "featured"
    }
  ];

  for (const validation of validations) {
    const activation = await ensureRecommendTabActive(client, validation.target_status);
    if (!activation.ok) {
      extraDrifts.push({
        kind: "validation",
        rule_id: `${validation.rule_id}_activation`,
        path: validation.path,
        reason: "tab_activation_failed",
        confidence: 0.9,
        auto_repairable: false,
        details: activation.click_result || activation.after || null
      });
      continue;
    }
    const stableCount = await waitForCandidateCountStable(client, validation.target_status, 10);
    const response = await evaluate(client, buildSelectorCheckExpression(getRecommendSelectorRule(validation.path), "frame"));
    const innerResponse = await evaluate(client, buildSelectorCheckExpression(getRecommendSelectorRule(validation.inner_path), "frame"));
    const surface = await evaluate(client, buildCandidateSurfaceStateExpression());
    const activeStatus = String(stableCount?.activeTabStatus || surface?.active_status || "");
    const tabCount = validation.target_status === "0"
      ? Number(stableCount?.recommendCandidateCount || surface?.counts?.recommend || 0)
      : validation.target_status === "1"
        ? Number(stableCount?.latestCandidateCount || surface?.counts?.latest || 0)
        : Number(stableCount?.featuredCandidateCount || surface?.counts?.featured || 0);
    upsertSelectorCheck(selectorChecks, {
      rule_id: validation.rule_id,
      path: validation.path,
      root: "frame",
      required: validation.rule_id === "recommend_cards",
      report_on_no_match: activeStatus === validation.target_status && tabCount > 0,
      no_match_reason: "no_selector_matched_after_tab_activation",
      no_match_confidence: 0.88,
      validation_context: {
        target_tab: validation.tab_name,
        target_status: validation.target_status,
        active_status: activeStatus || null,
        candidate_count: tabCount
      },
      skipped: response?.error === "ROOT_NOT_AVAILABLE",
      matches: Array.isArray(response?.matches) ? response.matches : []
    });
    upsertSelectorCheck(selectorChecks, {
      rule_id: validation.inner_rule_id,
      path: validation.inner_path,
      root: "frame",
      required: false,
      report_on_no_match: activeStatus === validation.target_status && tabCount > 0,
      no_match_reason: "no_inner_selector_matched_after_tab_activation",
      no_match_confidence: 0.89,
      validation_context: {
        target_tab: validation.tab_name,
        target_status: validation.target_status,
        active_status: activeStatus || null,
        candidate_count: tabCount
      },
      skipped: innerResponse?.error === "ROOT_NOT_AVAILABLE",
      matches: Array.isArray(innerResponse?.matches) ? innerResponse.matches : []
    });
  }

  if (originalTabStatus) {
    await ensureRecommendTabActive(client, originalTabStatus);
  }
}

async function validateJobScopedSelectors(client, selectorChecks, extraDrifts) {
  let initialState = null;
  try {
    initialState = await ensureJobListReady(client);
  } catch (error) {
    extraDrifts.push({
      kind: "validation",
      rule_id: "job_list_items_activation",
      path: ["frame", "job_list_items"],
      reason: "job_dropdown_activation_failed",
      confidence: 0.9,
      auto_repairable: false,
      details: error?.message || String(error)
    });
    return;
  }

  upsertSelectorCheck(selectorChecks, {
    rule_id: "job_list_items",
    path: ["frame", "job_list_items"],
    root: "frame",
    required: false,
    report_on_no_match: Array.isArray(initialState.jobs) && initialState.jobs.length > 0,
    no_match_reason: "no_selector_matched_after_job_dropdown_open",
    no_match_confidence: 0.86,
    validation_context: {
      job_count: Array.isArray(initialState.jobs) ? initialState.jobs.length : 0
    },
    skipped: false,
    matches: (await evaluate(client, buildSelectorCheckExpression(getRecommendSelectorRule(["frame", "job_list_items"]), "frame")))?.matches || []
  });
  upsertSelectorCheck(selectorChecks, {
    rule_id: "job_item_label",
    path: ["frame", "job_item_label"],
    root: "frame",
    required: false,
    report_on_no_match: Array.isArray(initialState.jobs) && initialState.jobs.length > 0,
    no_match_reason: "no_selector_matched_for_job_item_label_after_dropdown_open",
    no_match_confidence: 0.86,
    validation_context: {
      job_count: Array.isArray(initialState.jobs) ? initialState.jobs.length : 0
    },
    skipped: false,
    matches: (await evaluate(client, buildSelectorCheckExpression(getRecommendSelectorRule(["frame", "job_item_label"]), "frame")))?.matches || []
  });
  upsertSelectorCheck(selectorChecks, {
    rule_id: "job_search_input",
    path: ["frame", "job_search_input"],
    root: "frame",
    required: false,
    report_on_no_match: Array.isArray(initialState.jobs) && initialState.jobs.length > 0,
    no_match_reason: "no_selector_matched_for_job_search_input_after_dropdown_open",
    no_match_confidence: 0.88,
    validation_context: {
      job_count: Array.isArray(initialState.jobs) ? initialState.jobs.length : 0
    },
    skipped: false,
    matches: (await evaluate(client, buildSelectorCheckExpression(getRecommendSelectorRule(["frame", "job_search_input"]), "frame")))?.matches || []
  });

  const currentJob = (initialState.jobs || []).find((item) => item.current) || null;
  const targetJob = (initialState.jobs || []).find((item) => !item.current && item.visible)
    || (initialState.jobs || []).find((item) => !item.current)
    || currentJob
    || (initialState.jobs || [])[0]
    || null;

  if (!targetJob) {
    extraDrifts.push({
      kind: "validation",
      rule_id: "job_selected_label_activation",
      path: ["frame", "job_selected_label"],
      reason: "job_option_missing_for_validation",
      confidence: 0.82,
      auto_repairable: false
    });
    return;
  }

  const clickResult = await evaluate(client, buildJobSelectExpression(targetJob));
  if (!clickResult?.ok) {
    extraDrifts.push({
      kind: "validation",
      rule_id: "job_selected_label_activation",
      path: ["frame", "job_selected_label"],
      reason: "job_option_click_failed",
      confidence: 0.9,
      auto_repairable: false,
      details: clickResult?.error || null
    });
    return;
  }

  const selectionWait = await waitForJobSelected(client, targetJob, 10);
  const labelResponse = await evaluate(client, buildSelectorCheckExpression(getRecommendSelectorRule(["frame", "job_selected_label"]), "frame"));
  upsertSelectorCheck(selectorChecks, {
    rule_id: "job_selected_label",
    path: ["frame", "job_selected_label"],
    root: "frame",
    required: false,
    report_on_no_match: selectionWait.ok === true,
    no_match_reason: "no_selector_matched_after_job_selection",
    no_match_confidence: 0.9,
    validation_context: {
      selected_job: {
        value: targetJob.value || null,
        title: targetJob.title || null,
        label: targetJob.label || null
      },
      selection_applied: selectionWait.ok === true,
      selected_label: selectionWait.state?.selected_label || null
    },
    skipped: false,
    matches: Array.isArray(labelResponse?.matches) ? labelResponse.matches : []
  });

  if (!selectionWait.ok) {
    extraDrifts.push({
      kind: "validation",
      rule_id: "job_selected_label_activation",
      path: ["frame", "job_selected_label"],
      reason: "job_selection_not_applied",
      confidence: 0.9,
      auto_repairable: false
    });
  }

  if (currentJob && (normalizeText(currentJob.value || currentJob.title || currentJob.label || "") !== normalizeText(targetJob.value || targetJob.title || targetJob.label || ""))) {
    const restoreClick = await evaluate(client, buildJobSelectExpression(currentJob));
    if (restoreClick?.ok) {
      await waitForJobSelected(client, currentJob, 8);
    }
  }
}

async function closeDetailSurface(client, maxRetries = 3) {
  for (let retry = 0; retry < maxRetries; retry += 1) {
    const closedBefore = await evaluate(client, buildDetailClosedStateExpression());
    if (closedBefore?.closed) return { ok: true, method: "already_closed", state: closedBefore };

    const ackProbe = await evaluate(client, buildAckButtonExpression());
    if (ackProbe?.ok) {
      const ackClick = await evaluate(client, buildAckButtonClickExpression());
      if (ackClick?.ok) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    const closeAttempt = await evaluate(client, buildDetailCloseExpression());
    if (closeAttempt?.ok) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const closedAfter = await evaluate(client, buildDetailClosedStateExpression());
    if (closedAfter?.closed) {
      return { ok: true, method: closeAttempt?.ok ? "close_button" : (ackProbe?.ok ? "ack_button" : "post_check"), state: closedAfter };
    }

    try {
      await client.Input.dispatchKeyEvent({ type: "keyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
      await client.Input.dispatchKeyEvent({ type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 350));
    const closedAfterEsc = await evaluate(client, buildDetailClosedStateExpression());
    if (closedAfterEsc?.closed) return { ok: true, method: "escape", state: closedAfterEsc };
  }
  return { ok: false, state: await evaluate(client, buildDetailClosedStateExpression()) };
}

function extractObservedNetworkMatch(observedValues = [], patterns = []) {
  for (const observedValue of observedValues) {
    const matchedPattern = findFirstMatchingPattern(observedValue, patterns);
    if (matchedPattern) {
      return { observed_value: observedValue, matched_pattern: matchedPattern };
    }
  }
  return null;
}

function createNetworkCheck(ruleId, path, patterns, observedItems = [], confidence = 0.98) {
  const observedValues = observedItems.map((item) => item.match_target).filter(Boolean);
  const match = extractObservedNetworkMatch(observedValues, patterns);
  if (match) {
    return {
      rule_id: ruleId,
      path,
      ok: patterns[0] === match.matched_pattern,
      reason: patterns[0] === match.matched_pattern ? "matched_primary_pattern" : "matched_fallback_pattern",
      confidence,
      patterns,
      matched_pattern: match.matched_pattern,
      observed_value: match.observed_value,
      observed_items: observedItems
    };
  }
  return {
    rule_id: ruleId,
    path,
    ok: false,
    reason: observedItems.length > 0 ? "observed_unmatched_network" : "network_signal_missing",
    confidence: observedItems.length > 0 ? 0.45 : 0.25,
    patterns,
    observed_items: observedItems,
    observed_value: observedValues[0] || null
  };
}

async function scanRuntimeSurface({ workspaceRoot, args }) {
  const port = resolveDebugPort(workspaceRoot, args);
  const scope = normalizeScope(args.scope);
  const validationProfile = normalizeValidationProfile(args.validation_profile);
  const selectorDefinitions = getSelectorScanDefinitions(scope);
  const deferredRuleIds = new Set([
    "filter_panel",
    "filter_confirm_button",
    "filter_confirm_candidates",
    "filter_group_container",
    "filter_group_school",
    "filter_group_degree",
    "filter_group_gender",
    "filter_group_recent_not_view",
    "filter_option",
    "filter_option_all",
    "filter_option_active",
    "filter_scroll_container",
    "recommend_cards",
    "recommend_card_inner",
    "latest_cards",
    "latest_card_inner",
    "featured_cards",
    "featured_card_anchor",
    "job_list_items",
    "job_item_label",
    "job_search_input",
    "job_selected_label"
  ]);
  const selectorChecks = [];
  const networkEvents = [];
  const extraDrifts = [];
  const sideEffectSummary = {
    opened_candidate_detail: false,
    detail_opened_tabs: [],
    toggled_favorite_twice: false,
    triggered_greet: false,
    favorite_validation_attempted: false,
    favorite_validation_completed: false,
    greet_validation_attempted: false,
    greet_validation_completed: false,
    detail_popup_closed: false,
    detail_popup_closed_tabs: []
  };
  let client = null;
  try {
    const target = await pickRecommendTarget(port);
    if (!target) {
      return {
        selector_checks: [],
        network_checks: [],
        side_effect_summary: sideEffectSummary,
        extra_drifts: [
          {
            kind: "page",
            rule_id: "recommend_page_target",
            reason: "boss_recommend_tab_not_found",
            confidence: 0.2,
            auto_repairable: false
          }
        ]
      };
    }

    client = await CDP({ port, target });
    const { Runtime, Page, Network } = client;
    await Runtime.enable();
    await Page.enable();
    if (Network && typeof Network.enable === "function") {
      await Network.enable();
      if (typeof Network.requestWillBeSent === "function") {
        Network.requestWillBeSent((params) => {
          const url = normalizeText(params?.request?.url || "");
          const postData = normalizeText(params?.request?.postData || "");
          const payload = `${url} ${postData}`.trim();
          networkEvents.push({
            kind: "request",
            ts: Date.now(),
            url,
            postData,
            match_target: payload || url
          });
        });
      }
      if (typeof Network.webSocketFrameSent === "function") {
        Network.webSocketFrameSent((params) => {
          const payload = normalizeText(params?.response?.payloadData || "");
          if (!payload) return;
          networkEvents.push({
            kind: "websocket_sent",
            ts: Date.now(),
            url: "",
            postData: payload,
            match_target: payload
          });
        });
      }
      if (typeof Network.webSocketFrameReceived === "function") {
        Network.webSocketFrameReceived((params) => {
          const payload = normalizeText(params?.response?.payloadData || "");
          if (!payload) return;
          networkEvents.push({
            kind: "websocket_received",
            ts: Date.now(),
            url: "",
            postData: payload,
            match_target: payload
          });
        });
      }
    }

    for (const definition of selectorDefinitions.filter((item) => item.root !== "detail" && !deferredRuleIds.has(item.rule_id))) {
      const selectors = getRecommendSelectorRule(definition.path);
      const response = await evaluate(client, buildSelectorCheckExpression(selectors, definition.root));
      selectorChecks.push({
        rule_id: definition.rule_id,
        path: definition.path,
        root: definition.root,
        required: definition.required === true,
        report_on_no_match: definition.report_on_no_match === true,
        skipped: response?.error === "ROOT_NOT_AVAILABLE",
        matches: Array.isArray(response?.matches) ? response.matches : []
      });
    }

    const initialTabState = await evaluate(client, buildRecommendTabStateExpression());
    const originalTabStatus = normalizeText(initialTabState?.active_status || "") || "0";
    await validateFilterScopedSelectors(client, selectorChecks, extraDrifts);
    await validateTabScopedCardSelectors(client, selectorChecks, extraDrifts, originalTabStatus);
    await validateJobScopedSelectors(client, selectorChecks, extraDrifts);
    await waitForCandidateCountStable(client, originalTabStatus, 10);
    const networkChecks = [];
    const resumePatterns = getRecommendNetworkRule(["resume", "info_url_patterns"], []);
    const resumeKeywords = getRecommendNetworkRule(["resume", "related_keywords"], []);
    let fullActionCompleted = false;
    let detailCloseFailed = false;
    const detailTabValidations = [
      { tab_name: "recommend", tab_status: "0" },
      { tab_name: "latest", tab_status: "1" },
      { tab_name: "featured", tab_status: "3" }
    ];
    for (const tabValidation of detailTabValidations) {
      const activation = await ensureRecommendTabActive(client, tabValidation.tab_status);
      if (!activation?.ok) {
        extraDrifts.push({
          kind: "validation",
          rule_id: "detail_tab_activation",
          path: ["frame", "tab_items"],
          reason: "detail_tab_activation_failed",
          confidence: 0.9,
          auto_repairable: false,
          details: {
            tab_name: tabValidation.tab_name,
            tab_status: tabValidation.tab_status,
            activation: activation?.click_result || activation?.after || null
          }
        });
        continue;
      }
      const stableCount = await waitForCandidateCountStable(client, tabValidation.tab_status, 10);
      const tabCandidateCount = tabValidation.tab_status === "0"
        ? Number(stableCount?.recommendCandidateCount || 0)
        : tabValidation.tab_status === "1"
          ? Number(stableCount?.latestCandidateCount || 0)
          : Number(stableCount?.featuredCandidateCount || 0);
      const tabSurfaceState = await evaluate(client, buildCandidateSurfaceStateExpression());
      const tabOuterCount = tabValidation.tab_status === "0"
        ? Number(tabSurfaceState?.counts?.recommend || 0)
        : tabValidation.tab_status === "1"
          ? Number(tabSurfaceState?.counts?.latest || 0)
          : Number(tabSurfaceState?.counts?.featured || 0);
      const effectiveTabCount = Math.max(tabCandidateCount, tabOuterCount);
      if (!(effectiveTabCount > 0)) {
        extraDrifts.push({
          kind: "validation",
          rule_id: "detail_tab_candidate_presence",
          path: ["frame", "recommend_cards"],
          reason: "detail_tab_has_no_candidate_surface",
          confidence: 0.72,
          auto_repairable: false,
          details: {
            tab_name: tabValidation.tab_name,
            tab_status: tabValidation.tab_status,
            candidate_count: tabCandidateCount,
            outer_count: tabOuterCount
          }
        });
        continue;
      }

      const openCandidateResult = await evaluate(client, buildDetailOpenExpression());
      if (!openCandidateResult?.ok) {
        extraDrifts.push({
          kind: "validation",
          rule_id: "detail_open_validation",
          path: ["detail", "popup"],
          reason: "candidate_detail_open_click_failed",
          confidence: 0.92,
          auto_repairable: false,
          details: {
            tab_name: tabValidation.tab_name,
            tab_status: tabValidation.tab_status,
            error: openCandidateResult?.error || "TARGET_NOT_FOUND"
          }
        });
        continue;
      }
      sideEffectSummary.opened_candidate_detail = true;
      if (!sideEffectSummary.detail_opened_tabs.includes(tabValidation.tab_name)) {
        sideEffectSummary.detail_opened_tabs.push(tabValidation.tab_name);
      }
      await new Promise((resolve) => setTimeout(resolve, 1800));

      const detailState = await evaluate(client, buildDetailStateExpression());
      if (!detailState?.open) {
        extraDrifts.push({
          kind: "validation",
          rule_id: "detail_open_validation",
          path: ["detail", "popup"],
          reason: "candidate_detail_not_detected_after_click",
          confidence: 0.9,
          auto_repairable: false,
          details: {
            tab_name: tabValidation.tab_name,
            tab_status: tabValidation.tab_status
          }
        });
        continue;
      }

      for (const definition of selectorDefinitions.filter((item) => item.root === "detail")) {
        if (definition.rule_id === "detail_ack_button") continue;
        let reportOnNoMatch = definition.report_on_no_match === true;
        if (definition.rule_id === "detail_greet_button_recommend") {
          reportOnNoMatch = tabValidation.tab_status !== "3";
        }
        if (definition.rule_id === "detail_greet_button_featured") {
          reportOnNoMatch = tabValidation.tab_status === "3";
        }
        const selectors = getRecommendSelectorRule(definition.path);
        const response = await evaluate(client, buildSelectorCheckExpression(selectors, definition.root));
        selectorChecks.push({
          rule_id: definition.rule_id,
          path: definition.path,
          root: definition.root,
          required: definition.required === true,
          report_on_no_match: reportOnNoMatch,
          validation_context: {
            tab_name: tabValidation.tab_name,
            tab_status: tabValidation.tab_status
          },
          skipped: false,
          matches: Array.isArray(response?.matches) ? response.matches : []
        });
      }

      if (validationProfile === PROFILE_FULL && !fullActionCompleted) {
        const favoriteSelectors = getRecommendSelectorRule(["detail", "favorite_button"]);
        sideEffectSummary.favorite_validation_attempted = true;
        const favoriteProbe = await evaluate(client, buildActionButtonExpression(favoriteSelectors));
        if (favoriteProbe?.ok) {
          const favoriteStartedAt = Date.now();
          const firstClick = await evaluate(client, buildActionClickExpression(favoriteSelectors));
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const secondClick = await evaluate(client, buildActionClickExpression(favoriteSelectors));
          await new Promise((resolve) => setTimeout(resolve, 1200));
          sideEffectSummary.toggled_favorite_twice = firstClick?.ok === true && secondClick?.ok === true;
          sideEffectSummary.favorite_validation_completed = sideEffectSummary.toggled_favorite_twice;
          if (!sideEffectSummary.toggled_favorite_twice) {
            extraDrifts.push({
              kind: "validation",
              rule_id: "favorite_roundtrip_validation",
              path: ["detail", "favorite_button"],
              reason: "favorite_toggle_roundtrip_incomplete",
              confidence: 0.92,
              auto_repairable: false,
              details: {
                tab_name: tabValidation.tab_name,
                tab_status: tabValidation.tab_status,
                first_click_ok: firstClick?.ok === true,
                second_click_ok: secondClick?.ok === true
              }
            });
          }
          const favoriteObserved = networkEvents.filter((item) => Number(item.ts || 0) >= favoriteStartedAt);
          networkChecks.push(createNetworkCheck("favorite_request_add", ["favorite", "add_patterns"], getRecommendNetworkRule(["favorite", "add_patterns"], []), favoriteObserved, 0.95));
          networkChecks.push(createNetworkCheck("favorite_request_remove", ["favorite", "remove_patterns"], getRecommendNetworkRule(["favorite", "remove_patterns"], []), favoriteObserved, 0.95));
        } else {
          extraDrifts.push({
            kind: "validation",
            rule_id: "favorite_roundtrip_validation",
            path: ["detail", "favorite_button"],
            reason: "favorite_button_not_found_for_full_validation",
            confidence: 0.9,
            auto_repairable: false,
            details: {
              tab_name: tabValidation.tab_name,
              tab_status: tabValidation.tab_status
            }
          });
        }

        const greetSelectors = [
          ...getRecommendSelectorRule(["detail", "greet_button_recommend"]),
          ...getRecommendSelectorRule(["detail", "greet_button_featured"])
        ];
        sideEffectSummary.greet_validation_attempted = true;
        const greetProbe = await evaluate(client, buildActionButtonExpression(greetSelectors));
        if (greetProbe?.ok) {
          const greetStartedAt = Date.now();
          const greetClick = await evaluate(client, buildActionClickExpression(greetSelectors));
          await new Promise((resolve) => setTimeout(resolve, 1600));
          sideEffectSummary.triggered_greet = greetClick?.ok === true;
          sideEffectSummary.greet_validation_completed = sideEffectSummary.triggered_greet;
          const ackResponse = await evaluate(client, buildSelectorCheckExpression(getRecommendSelectorRule(["detail", "ack_button"]), "detail"));
          selectorChecks.push({
            rule_id: "detail_ack_button",
            path: ["detail", "ack_button"],
            root: "detail",
            required: false,
            report_on_no_match: false,
            validation_context: {
              tab_name: tabValidation.tab_name,
              tab_status: tabValidation.tab_status,
              greet_triggered: sideEffectSummary.triggered_greet
            },
            skipped: false,
            matches: Array.isArray(ackResponse?.matches) ? ackResponse.matches : []
          });
          if (!sideEffectSummary.triggered_greet) {
            extraDrifts.push({
              kind: "validation",
              rule_id: "greet_validation",
              path: ["detail", "greet_button_recommend"],
              reason: "greet_click_failed_during_full_validation",
              confidence: 0.92,
              auto_repairable: false,
              details: {
                tab_name: tabValidation.tab_name,
                tab_status: tabValidation.tab_status
              }
            });
          }
          const greetObserved = networkEvents.filter((item) => Number(item.ts || 0) >= greetStartedAt);
          networkChecks.push(createNetworkCheck("greet_request", ["greet", "url_patterns"], getRecommendNetworkRule(["greet", "url_patterns"], []), greetObserved, 0.92));
        } else {
          extraDrifts.push({
            kind: "validation",
            rule_id: "greet_validation",
            path: ["detail", "greet_button_recommend"],
            reason: "greet_button_not_found_for_full_validation",
            confidence: 0.9,
            auto_repairable: false,
            details: {
              tab_name: tabValidation.tab_name,
              tab_status: tabValidation.tab_status
            }
          });
        }
        fullActionCompleted = true;
      }

      const closeResult = await closeDetailSurface(client, 4);
      if (closeResult?.ok) {
        if (!sideEffectSummary.detail_popup_closed_tabs.includes(tabValidation.tab_name)) {
          sideEffectSummary.detail_popup_closed_tabs.push(tabValidation.tab_name);
        }
      } else {
        detailCloseFailed = true;
        extraDrifts.push({
          kind: "validation",
          rule_id: "detail_close_validation",
          path: ["detail", "close_button"],
          reason: "detail_popup_not_closed_after_validation",
          confidence: 0.93,
          auto_repairable: false,
          details: {
            tab_name: tabValidation.tab_name,
            tab_status: tabValidation.tab_status,
            close_state: closeResult?.state || null
          }
        });
      }
    }

    if (validationProfile === PROFILE_FULL && !fullActionCompleted) {
      extraDrifts.push({
        kind: "validation",
        rule_id: "full_validation_gate",
        path: ["detail", "popup"],
        reason: "full_validation_skipped_because_no_detail_open_on_any_tab",
        confidence: 0.9,
        auto_repairable: false
      });
    }
    sideEffectSummary.detail_popup_closed = sideEffectSummary.detail_popup_closed_tabs.length > 0 && !detailCloseFailed;
    const resumeObserved = networkEvents.filter((item) => {
      const matchTarget = normalizeText(item.match_target || "").toLowerCase();
      return matchTarget.includes("/wapi/") && resumeKeywords.some((keyword) => matchTarget.includes(String(keyword).toLowerCase()));
    });
    networkChecks.push(createNetworkCheck("resume_info_request", ["resume", "info_url_patterns"], resumePatterns, resumeObserved, 0.97));
    if (originalTabStatus) {
      await ensureRecommendTabActive(client, originalTabStatus);
    }

    return {
      selector_checks: selectorChecks,
      network_checks: networkChecks,
      side_effect_summary: sideEffectSummary,
      extra_drifts: extraDrifts
    };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {}
    }
  }
}

const defaultDependencies = { scanRuntimeSurface };

export async function runRecommendSelfHeal({ workspaceRoot, args = {} }, dependencies = defaultDependencies) {
  const normalizedArgs = {
    mode: normalizeMode(args.mode),
    scope: normalizeScope(args.scope),
    validation_profile: normalizeValidationProfile(args.validation_profile),
    port: args.port,
    repair_session_id: normalizeText(args.repair_session_id || "") || null,
    confirm_apply: args.confirm_apply === true
  };

  if (normalizedArgs.mode === MODE_APPLY) {
    if (!normalizedArgs.repair_session_id) {
      return {
        status: "FAILED",
        error: {
          code: "SELF_HEAL_SESSION_REQUIRED",
          message: "apply 模式必须提供 repair_session_id。",
          retryable: false
        }
      };
    }
    return applyRepairSession(normalizedArgs.repair_session_id, normalizedArgs.confirm_apply);
  }

  const scanResult = await dependencies.scanRuntimeSurface({ workspaceRoot, args: normalizedArgs });
  const selectorChecks = Array.isArray(scanResult?.selector_checks) ? scanResult.selector_checks : [];
  const networkChecks = Array.isArray(scanResult?.network_checks) ? scanResult.network_checks : [];
  const selectorDrifts = analyzeSelectorChecks(selectorChecks);
  const networkDrifts = analyzeNetworkChecks(networkChecks);
  const extraDrifts = Array.isArray(scanResult?.extra_drifts) ? scanResult.extra_drifts : [];
  const drifts = [...selectorDrifts, ...networkDrifts, ...extraDrifts];
  if (drifts.length === 0) {
    return {
      status: "HEALTHY",
      scope: normalizedArgs.scope,
      validation_profile: normalizedArgs.validation_profile,
      rules_path: getRecommendHealingRulesPath(),
      selector_checks: selectorChecks,
      network_checks: networkChecks,
      side_effect_summary: scanResult?.side_effect_summary || null,
      message: "未发现 selector / network 规则漂移。"
    };
  }
  const proposedRepairs = dedupeRepairs(
    drifts
      .map((item) => item?.proposed_repair || null)
      .filter((item) => item && Number(item.confidence || 0) >= 0.9)
  );
  const session = createRepairSession({
    args: normalizedArgs,
    selectorChecks,
    networkChecks,
    drifts,
    proposedRepairs
  });
  return {
    status: "NEED_CONFIRMATION",
    scope: normalizedArgs.scope,
    validation_profile: normalizedArgs.validation_profile,
    rules_path: getRecommendHealingRulesPath(),
    repair_session_id: session.repair_session_id,
    selector_checks: selectorChecks,
    network_checks: networkChecks,
    drifts,
    proposed_repairs: proposedRepairs,
    side_effect_summary: scanResult?.side_effect_summary || null,
    message: proposedRepairs.length > 0
      ? "检测到可修复的 selector / network 漂移，请确认是否应用修复。"
      : "检测到漂移，但当前没有高置信度自动修复项。"
  };
}

export const __testables = {
  analyzeSelectorChecks,
  analyzeNetworkChecks,
  applyRepairSession,
  applyRepairToRules,
  createNetworkCheck,
  createRepairSession,
  getSelfHealSessionsDir,
  normalizeMode,
  normalizeScope,
  normalizeValidationProfile,
  resolveDebugPort,
  scanRuntimeSurface
};
