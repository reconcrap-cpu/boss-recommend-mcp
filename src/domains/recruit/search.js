import {
  clearFocusedInput,
  clickNodeCenter,
  countSelectors,
  DETERMINISTIC_CLICK_OPTIONS,
  describeNode,
  findFirstNode,
  getAttributesMap,
  getOuterHTML,
  insertText,
  pressKey,
  querySelector,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../../core/screening/index.js";
import {
  createRecoverySettleError,
  waitForMiniFreshStartSettle
} from "../common/recovery-settle.js";
import {
  RECRUIT_CARD_SELECTOR,
  RECRUIT_TARGET_URL,
  RECRUIT_NO_DATA_SELECTORS,
  RECRUIT_SEARCH_SELECTORS
} from "./constants.js";
import {
  getRecruitRoots,
  waitForRecruitRoots
} from "./roots.js";

const DEFAULT_RECRUIT_KEYWORD = "算法工程师";
const ACTIVE_CLASS_PATTERN = /\b(active|selected|checked|cur|current)\b/i;
const DEFAULT_RECRUIT_RESET_TIMEOUT_MS = 180000;
const DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS = 90000;
const DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS = 30000;
const DEFAULT_RECRUIT_CITY_NO_RESULT_FALLBACK_MS = 15000;

const DEGREE_LABEL_MAP = new Map([
  ["不限", "不限"],
  ["本科", "本科"],
  ["本科及以上", "本科"],
  ["硕士", "硕士"],
  ["硕士及以上", "硕士"],
  ["博士", "博士"]
]);

const NATIONAL_CITY_LABELS = new Set([
  "全国",
  "不限",
  "不限城市",
  "全部",
  "All",
  "ALL",
  "all"
]);

const CITY_NO_RESULT_LABELS = new Set([
  "暂无结果",
  "暂无数据",
  "无结果"
]);

function uniqueNodeIds(nodeIds = []) {
  return Array.from(new Set(nodeIds.filter(Boolean)));
}

function buildRecruitSearchFrameUrl(pageUrl = RECRUIT_TARGET_URL) {
  const origin = new URL(pageUrl).origin;
  return `${origin}/web/frame/search/?jobId=&keywords=&t=${Date.now()}&source=&city=`;
}

async function navigateRecruitSearchFrame(client, iframeNodeId, {
  pageUrl = RECRUIT_TARGET_URL,
  reason = "reset_frame"
} = {}) {
  if (!iframeNodeId || typeof client?.Page?.navigate !== "function") return null;
  const iframeNode = await describeNode(client, iframeNodeId, { depth: 1, pierce: true });
  const frameId = iframeNode?.frameId;
  if (!frameId) return null;
  const frameUrl = buildRecruitSearchFrameUrl(pageUrl);
  await client.Page.navigate({ frameId, url: frameUrl });
  return {
    method: "Page.navigate",
    scope: "frame",
    frame_id: frameId,
    url: frameUrl,
    reason
  };
}

export function normalizeRecruitSearchLabel(label) {
  return normalizeText(label).replace(/\s+/g, "");
}

export function buildRecruitJobTitleSearchTerms(jobTitle) {
  const normalized = normalizeText(jobTitle);
  if (!normalized) return [];
  const variants = [
    normalized,
    normalized.replace(/\s*[_＿]\s*/g, " "),
    normalized.replace(/\s*[｜|]\s*/g, " ")
  ].map(normalizeText).filter(Boolean);
  const separatorParts = normalized.split(/\s*[_＿｜|]\s*/).map(normalizeText).filter(Boolean);
  if (separatorParts.length > 1) {
    variants.push(separatorParts.join(" "));
    variants.push(separatorParts[0]);
  }
  return Array.from(new Set(variants));
}

export function isRecruitNationalCity(city) {
  return NATIONAL_CITY_LABELS.has(normalizeRecruitSearchLabel(city));
}

export function resolveRecruitDegreeLabel(degree) {
  const normalized = normalizeRecruitSearchLabel(degree || "不限");
  return DEGREE_LABEL_MAP.get(normalized) || normalized || "不限";
}

export function normalizeRecruitDegreeLabels(value) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[，,、|/]/)
      : [];
  const labels = rawItems
    .map(resolveRecruitDegreeLabel)
    .filter(Boolean);
  const uniqueLabels = uniqueNodeIds(labels);
  return uniqueLabels.length ? uniqueLabels : ["不限"];
}

export function normalizeRecruitSearchParams(searchParams = {}) {
  const degrees = normalizeRecruitDegreeLabels(searchParams.degrees || searchParams.degree || "不限");
  const normalized = {
    city: normalizeText(searchParams.city) || null,
    degree: degrees[0] || "不限",
    degrees,
    schools: Array.isArray(searchParams.schools)
      ? searchParams.schools.map(normalizeText).filter(Boolean)
      : [],
    keyword: normalizeText(searchParams.keyword) || DEFAULT_RECRUIT_KEYWORD,
    filter_recent_viewed: typeof searchParams.filter_recent_viewed === "boolean"
      ? searchParams.filter_recent_viewed
      : null
  };
  const job = normalizeText(searchParams.job || searchParams.job_title || searchParams.selected_job);
  if (job) normalized.job = job;
  return normalized;
}

export function hasRecruitSearchParams(searchParams = {}) {
  const degrees = normalizeRecruitDegreeLabels(searchParams.degrees || searchParams.degree || "不限");
  const job = normalizeText(searchParams.job || searchParams.job_title || searchParams.selected_job);
  const normalized = {
    city: normalizeText(searchParams.city) || null,
    degree: degrees[0] || "不限",
    degrees,
    schools: Array.isArray(searchParams.schools)
      ? searchParams.schools.map(normalizeText).filter(Boolean)
      : [],
    keyword: normalizeText(searchParams.keyword),
    filter_recent_viewed: typeof searchParams.filter_recent_viewed === "boolean"
      ? searchParams.filter_recent_viewed
      : null
  };
  return Boolean(
    job
    || normalized.city
    || normalized.degrees.some((degree) => degree && degree !== "不限")
    || normalized.schools.length
    || normalized.keyword
    || typeof normalized.filter_recent_viewed === "boolean"
  );
}

function candidateIsActive(attributes = {}, outerHTML = "") {
  const className = attributes.class || "";
  const openingTag = String(outerHTML || "").split(">")[0] || "";
  return ACTIVE_CLASS_PATTERN.test(className)
    || ACTIVE_CLASS_PATTERN.test(openingTag)
    || /\bchecked(?:=["']?checked)?\b/i.test(openingTag);
}

async function readTextCandidate(client, nodeId, {
  selector = "",
  index = 0
} = {}) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
  ]);
  const text = normalizeText(htmlToText(outerHTML));
  return {
    node_id: nodeId,
    selector,
    index,
    label: normalizeRecruitSearchLabel(text),
    text,
    active: candidateIsActive(attributes, outerHTML),
    class_name: attributes.class || "",
    attributes
  };
}

async function listTextCandidates(client, rootNodeId, selectors = []) {
  const candidates = [];
  const seen = new Set();
  for (const selector of selectors) {
    const nodeIds = uniqueNodeIds(await querySelectorAll(client, rootNodeId, selector));
    for (let index = 0; index < nodeIds.length; index += 1) {
      const nodeId = nodeIds[index];
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      candidates.push(await readTextCandidate(client, nodeId, { selector, index }));
    }
  }
  return candidates;
}

export function chooseRecruitTextCandidate(candidates = [], {
  label = "",
  match = "exact"
} = {}) {
  const target = normalizeRecruitSearchLabel(label);
  if (!target) return null;
  const byExact = candidates.find((candidate) => candidate.label === target);
  if (byExact) return byExact;
  if (match === "exact") return null;
  const byPrefix = candidates.find((candidate) => (
    candidate.label.startsWith(target)
    || target.startsWith(candidate.label)
  ));
  if (byPrefix) return byPrefix;
  if (match === "prefix") return null;
  return candidates.find((candidate) => candidate.label.includes(target) || target.includes(candidate.label)) || null;
}

async function findTextCandidate(client, rootNodeId, selectors, label, options = {}) {
  const candidates = await listTextCandidates(client, rootNodeId, selectors);
  return {
    candidate: chooseRecruitTextCandidate(candidates, { label, ...options }),
    candidates
  };
}

function summarizeTextCandidates(candidates = [], limit = 20) {
  return candidates.map((item) => ({
    label: item.text,
    active: item.active,
    node_id: item.node_id,
    selector: item.selector
  })).slice(0, limit);
}

async function waitForRecruitTextCandidate(client, rootNodeId, selectors, label, {
  timeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS,
  intervalMs = 300,
  match = "exact"
} = {}) {
  const started = Date.now();
  let candidate = null;
  let candidates = [];
  while (Date.now() - started <= timeoutMs) {
    const found = await findTextCandidate(client, rootNodeId, selectors, label, { match });
    candidate = found.candidate;
    candidates = found.candidates;
    if (candidate) break;
    await sleep(intervalMs);
  }
  return {
    candidate,
    candidates,
    elapsed_ms: Date.now() - started
  };
}

async function waitForRecruitJobTitleCandidate(client, rootNodeId, selectors, jobTitle, {
  timeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS,
  intervalMs = 300
} = {}) {
  const terms = buildRecruitJobTitleSearchTerms(jobTitle);
  const started = Date.now();
  let candidate = null;
  let candidates = [];
  let matchedTerm = "";
  while (Date.now() - started <= timeoutMs) {
    candidates = await listTextCandidates(client, rootNodeId, selectors);
    for (const term of terms) {
      const found = chooseRecruitTextCandidate(candidates, { label: term, match: "contains" });
      if (found) {
        candidate = found;
        matchedTerm = term;
        break;
      }
    }
    if (candidate) break;
    await sleep(intervalMs);
  }
  return {
    candidate,
    candidates,
    matched_term: matchedTerm,
    search_terms: terms,
    elapsed_ms: Date.now() - started
  };
}

async function clickFirstNodeBySelectors(client, rootNodeId, selectors, {
  optional = false,
  scrollIntoView = true
} = {}) {
  const found = await findFirstNode(client, rootNodeId, selectors);
  if (!found) {
    if (optional) return { clicked: false, reason: "not_found" };
    throw new Error(`Recruit search node was not found for selectors: ${selectors.join(", ")}`);
  }
  try {
    const box = await clickNodeCenter(client, found.nodeId, {
      ...DETERMINISTIC_CLICK_OPTIONS,
      scrollIntoView
    });
    await sleep(250);
    return {
      clicked: true,
      selector: found.selector,
      node_id: found.nodeId,
      box
    };
  } catch (error) {
    if (optional) {
      return {
        clicked: false,
        reason: "not_clickable",
        selector: found.selector,
        node_id: found.nodeId,
        error: error?.message || String(error)
      };
    }
    throw error;
  }
}

async function dismissRecruitSearchOverlays(client, settleMs = 250) {
  if (typeof client?.Input?.dispatchKeyEvent !== "function") {
    return {
      method: "Escape",
      skipped: true,
      reason: "dispatch_key_unavailable"
    };
  }
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  if (settleMs > 0) await sleep(settleMs);
  return {
    method: "Escape",
    settle_ms: settleMs
  };
}

export async function getRecruitSearchCounts(client, frameNodeId) {
  return countSelectors(client, frameNodeId, {
    keyword_input: RECRUIT_SEARCH_SELECTORS.keywordInput.join(", "),
    search_button: RECRUIT_SEARCH_SELECTORS.searchButton.join(", "),
    degree_option: RECRUIT_SEARCH_SELECTORS.degreeOption.join(", "),
    school_item: RECRUIT_SEARCH_SELECTORS.schoolItem.join(", "),
    recent_viewed_label: RECRUIT_SEARCH_SELECTORS.recentViewedLabel.join(", "),
    candidate_card: RECRUIT_CARD_SELECTOR,
    no_data: RECRUIT_NO_DATA_SELECTORS.join(", ")
  });
}

export async function waitForRecruitSearchControls(client, {
  timeoutMs = DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    const roots = await getRecruitRoots(client, { requireFrame: false });
    const frameNodeId = roots.iframe?.documentNodeId;
    if (frameNodeId) {
      const counts = await getRecruitSearchCounts(client, frameNodeId);
      lastState = {
        ok: counts.keyword_input > 0 && counts.search_button > 0,
        elapsed_ms: Date.now() - started,
        iframe_selector: roots.iframe.selector,
        iframe_document_node_id: frameNodeId,
        counts
      };
      if (lastState.ok) return lastState;
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    ...(lastState || {})
  };
}

async function settleRecruitSearchAfterReset(client, {
  timeoutMs = DEFAULT_RECRUIT_RESET_TIMEOUT_MS,
  settleMs = 5000
} = {}) {
  return waitForMiniFreshStartSettle(client, {
    domain: "search",
    timeoutMs,
    intervalMs: 500,
    settleMs: Math.max(0, Math.min(settleMs || 0, 5000)),
    readinessLabel: "search_controls_ready",
    checkReady: ({ remainingMs }) => waitForRecruitSearchControls(client, {
      timeoutMs: Math.min(Math.max(1, remainingMs), 1500),
      intervalMs: 300
    })
  });
}

export async function resetRecruitSearchPage(client, {
  url = RECRUIT_TARGET_URL,
  settleMs = 5000,
  timeoutMs = DEFAULT_RECRUIT_RESET_TIMEOUT_MS
} = {}) {
  const actions = [];
  let miniFreshStart = null;
  const rootTimeoutMs = Math.min(timeoutMs, 90000);
  async function waitForRootsAfterSettle() {
    await sleep(settleMs);
    return waitForRecruitRoots(client, {
      timeoutMs: rootTimeoutMs,
      intervalMs: 300
    });
  }

  async function waitForControls() {
    return waitForRecruitSearchControls(client, {
      timeoutMs,
      intervalMs: 300
    });
  }

  if (typeof client?.Page?.reload === "function") {
    await client.Page.reload({ ignoreCache: true });
    actions.push({ method: "Page.reload" });
  } else {
    await client.Page.navigate({ url });
    actions.push({ method: "Page.navigate", url });
  }

  miniFreshStart = await settleRecruitSearchAfterReset(client, {
    timeoutMs: Math.min(timeoutMs, 90000),
    settleMs
  });
  actions.push({
    method: "mini_fresh_start_settle",
    ok: Boolean(miniFreshStart.ok),
    status: miniFreshStart.status || "",
    reason: miniFreshStart.reason || "",
    elapsed_ms: miniFreshStart.elapsed_ms || 0
  });
  if (!miniFreshStart.ok) {
    throw createRecoverySettleError("search", miniFreshStart);
  }

  let roots = await waitForRootsAfterSettle();
  const frameReset = await navigateRecruitSearchFrame(client, roots?.iframe?.nodeId, {
    pageUrl: url,
    reason: "reset_frame_after_page_reload"
  });
  if (frameReset) {
    actions.push(frameReset);
    await sleep(settleMs);
  }

  let controls = await waitForControls();
  if (!controls.ok && typeof client?.Page?.navigate === "function") {
    await client.Page.navigate({ url });
    actions.push({
      method: "Page.navigate",
      url,
      reason: roots?.iframe?.documentNodeId ? "controls_not_ready" : "iframe_not_ready"
    });
    roots = await waitForRootsAfterSettle();
    const fallbackFrameReset = await navigateRecruitSearchFrame(client, roots?.iframe?.nodeId, {
      pageUrl: url,
      reason: "reset_frame_after_page_navigate"
    });
    if (fallbackFrameReset) {
      actions.push(fallbackFrameReset);
      await sleep(settleMs);
    }
    miniFreshStart = await settleRecruitSearchAfterReset(client, {
      timeoutMs: Math.min(timeoutMs, 90000),
      settleMs: Math.min(settleMs, 1500)
    });
    actions.push({
      method: "mini_fresh_start_settle_after_navigate",
      ok: Boolean(miniFreshStart.ok),
      status: miniFreshStart.status || "",
      reason: miniFreshStart.reason || "",
      elapsed_ms: miniFreshStart.elapsed_ms || 0
    });
    if (!miniFreshStart.ok) {
      throw createRecoverySettleError("search", miniFreshStart);
    }
    controls = await waitForControls();
  }
  roots = await getRecruitRoots(client, { requireFrame: false });
  if (!controls.ok && !roots?.iframe?.documentNodeId) {
    throw new Error("Recruit search page reset did not expose searchFrame iframe");
  }
  if (!controls.ok) {
    throw new Error("Recruit search page reset exposed iframe but search controls were not ready");
  }
  return {
    actions,
    target_url: url,
    iframe_selector: controls.iframe_selector || roots.iframe.selector,
    iframe_document_node_id: controls.iframe_document_node_id || roots.iframe.documentNodeId,
    mini_fresh_start: miniFreshStart,
    controls
  };
}

export async function setRecruitKeyword(client, frameNodeId, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) {
    return { applied: false, reason: "empty_keyword" };
  }
  const input = await clickFirstNodeBySelectors(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.keywordInput);
  await clearFocusedInput(client);
  await sleep(120);
  await insertText(client, normalizedKeyword);
  await sleep(350);
  return {
    applied: true,
    keyword: normalizedKeyword,
    input
  };
}

export async function selectRecruitDefaultJobTitle(client, frameNodeId) {
  return clickFirstNodeBySelectors(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.jobTitleOption, {
    optional: true
  });
}

export async function setRecruitJobTitle(client, frameNodeId, jobTitle, {
  optionTimeoutMs = DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS
} = {}) {
  const normalizedJobTitle = normalizeText(jobTitle);
  if (!normalizedJobTitle) {
    return { applied: false, reason: "empty_job_title" };
  }
  const lookup = await waitForRecruitJobTitleCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.jobTitleOption,
    normalizedJobTitle,
    { timeoutMs: Math.min(optionTimeoutMs, 30000) }
  );
  if (!lookup.candidate) {
    throw new Error(`Recruit job title option was not found: ${normalizedJobTitle}`);
  }
  let box = null;
  if (!lookup.candidate.active) {
    box = await clickNodeCenter(client, lookup.candidate.node_id, {
      ...DETERMINISTIC_CLICK_OPTIONS,
      scrollIntoView: true
    });
    await sleep(500);
  }
  return {
    applied: true,
    requested_job: normalizedJobTitle,
    selected_label: lookup.candidate.text,
    matched_term: lookup.matched_term,
    search_terms: lookup.search_terms,
    selected_node_id: lookup.candidate.node_id,
    was_active: lookup.candidate.active,
    clicked: !lookup.candidate.active,
    box,
    discovered_options: summarizeTextCandidates(lookup.candidates, 30)
  };
}

export async function setRecruitDegree(client, frameNodeId, degree) {
  const degreeLabel = resolveRecruitDegreeLabel(degree);
  if (!degreeLabel || degreeLabel === "不限") {
    return { applied: false, reason: "unlimited_degree", degree: degreeLabel || "不限" };
  }
  const { candidate, candidates } = await findTextCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.degreeOption,
    degreeLabel,
    { match: "prefix" }
  );
  if (!candidate) {
    throw new Error(`Recruit degree option was not found: ${degreeLabel}`);
  }
  const box = await clickNodeCenter(client, candidate.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(350);
  return {
    applied: true,
    requested_degree: degree,
    selected_label: candidate.text,
    selected_node_id: candidate.node_id,
    was_active: candidate.active,
    box,
    discovered_options: candidates.map((item) => ({
      label: item.text,
      active: item.active,
      node_id: item.node_id,
      selector: item.selector
    }))
  };
}

export async function setRecruitDegrees(client, frameNodeId, degrees = []) {
  const labels = normalizeRecruitDegreeLabels(degrees).filter((label) => label && label !== "不限");
  if (!labels.length) {
    return { applied: false, reason: "unlimited_degree", degrees: ["不限"], selected: [] };
  }

  const selected = [];
  let discoveredOptions = [];
  for (const label of labels) {
    const { candidate, candidates } = await findTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.degreeOption,
      label,
      { match: "prefix" }
    );
    discoveredOptions = candidates.map((item) => ({
      label: item.text,
      active: item.active,
      node_id: item.node_id,
      selector: item.selector
    }));
    if (!candidate) {
      throw new Error(`Recruit degree option was not found: ${label}`);
    }

    let box = null;
    if (!candidate.active) {
      box = await clickNodeCenter(client, candidate.node_id, {
        ...DETERMINISTIC_CLICK_OPTIONS,
        scrollIntoView: true
      });
      await sleep(350);
    }
    selected.push({
      requested_degree: label,
      selected_label: candidate.text,
      selected_node_id: candidate.node_id,
      was_active: candidate.active,
      clicked: !candidate.active,
      box
    });
  }

  return {
    applied: true,
    requested_degrees: labels,
    selected,
    discovered_options: discoveredOptions
  };
}

async function findClickableDescendant(client, nodeId, selectors) {
  for (const selector of selectors) {
    const childNodeId = await querySelector(client, nodeId, selector);
    if (childNodeId) return { node_id: childNodeId, selector };
  }
  return { node_id: nodeId, selector: null };
}

export async function setRecruitSchools(client, frameNodeId, schools = []) {
  const targets = schools.map(normalizeText).filter(Boolean);
  const applied = [];
  const missing = [];
  if (!targets.length) {
    return { applied: false, schools: [], selected: [], missing: [] };
  }

  for (const school of targets) {
    const { candidate, candidates } = await findTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.schoolItem,
      school,
      { match: "contains" }
    );
    if (!candidate) {
      missing.push({
        school,
        discovered: candidates.map((item) => item.text).slice(0, 20)
      });
      continue;
    }

    const clickable = await findClickableDescendant(client, candidate.node_id, RECRUIT_SEARCH_SELECTORS.schoolClickable);
    let clickableActive = candidate.active;
    if (clickable.node_id !== candidate.node_id) {
      const clickableCandidate = await readTextCandidate(client, clickable.node_id, {
        selector: clickable.selector || "",
        index: 0
      });
      clickableActive = clickableActive || clickableCandidate.active;
    }

    let box = null;
    if (!clickableActive) {
      box = await clickNodeCenter(client, clickable.node_id, {
        ...DETERMINISTIC_CLICK_OPTIONS,
        scrollIntoView: true
      });
      await sleep(350);
    }

    applied.push({
      school,
      selected_label: candidate.text,
      selected_node_id: candidate.node_id,
      clickable_node_id: clickable.node_id,
      clickable_selector: clickable.selector,
      was_active: clickableActive,
      clicked: !clickableActive,
      box
    });
  }

  if (missing.length) {
    throw new Error(`Recruit school options were not found: ${missing.map((item) => item.school).join(", ")}`);
  }

  return {
    applied: true,
    schools: targets,
    selected: applied,
    missing
  };
}

export async function setRecruitRecentViewedFilter(client, frameNodeId, enabled) {
  if (typeof enabled !== "boolean") {
    return { applied: false, reason: "not_requested" };
  }
  const { candidate, candidates } = await findTextCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.recentViewedLabel,
    "过滤近14天查看",
    { match: "contains" }
  );
  if (!candidate) {
    throw new Error("Recruit recent-viewed filter was not found");
  }

  let box = null;
  if (candidate.active !== enabled) {
    box = await clickNodeCenter(client, candidate.node_id, {
      ...DETERMINISTIC_CLICK_OPTIONS,
      scrollIntoView: true
    });
    await sleep(900);
  }

  return {
    applied: true,
    requested: enabled,
    was_active: candidate.active,
    changed: candidate.active !== enabled,
    selected_label: candidate.text,
    selected_node_id: candidate.node_id,
    box,
    discovered_options: candidates.map((item) => ({
      label: item.text,
      active: item.active,
      node_id: item.node_id,
      selector: item.selector
    }))
  };
}

async function selectRecruitNationalCityThroughPicker(client, frameNodeId, {
  requestedCity = "全国",
  reason = "national_city_requested",
  optionTimeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS
} = {}) {
  const input = await clickFirstNodeBySelectors(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.cityInput);
  await clearFocusedInput(client);
  await sleep(500);

  const path = [];
  const categoryLookup = await waitForRecruitTextCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.citySearchResult,
    "城市",
    { match: "exact", timeoutMs: Math.min(optionTimeoutMs, 6000) }
  );
  if (categoryLookup.candidate) {
    const box = await clickNodeCenter(client, categoryLookup.candidate.node_id, {
      ...DETERMINISTIC_CLICK_OPTIONS,
      scrollIntoView: true
    });
    await sleep(400);
    path.push({
      label: "城市",
      selected_label: categoryLookup.candidate.text,
      node_id: categoryLookup.candidate.node_id,
      box
    });
  } else {
    path.push({
      label: "城市",
      skipped: true,
      reason: "not_found_or_already_expanded",
      discovered_options: summarizeTextCandidates(categoryLookup.candidates)
    });
  }

  let popularLookup = await waitForRecruitTextCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.cityProvinceItem,
    "热门",
    { match: "exact", timeoutMs: optionTimeoutMs }
  );
  if (!popularLookup.candidate) {
    popularLookup = await waitForRecruitTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.citySearchResult,
      "热门",
      { match: "exact", timeoutMs: Math.min(optionTimeoutMs, 6000) }
    );
  }
  if (!popularLookup.candidate) {
    return {
      applied: false,
      reason: "national_city_popular_not_found",
      requested_city: requestedCity,
      input,
      path,
      discovered_options: summarizeTextCandidates(popularLookup.candidates)
    };
  }
  const popularBox = await clickNodeCenter(client, popularLookup.candidate.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(400);
  path.push({
    label: "热门",
    selected_label: popularLookup.candidate.text,
    node_id: popularLookup.candidate.node_id,
    box: popularBox
  });

  let nationalLookup = await waitForRecruitTextCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.cityDropdownItem,
    "全国",
    { match: "exact", timeoutMs: optionTimeoutMs }
  );
  if (!nationalLookup.candidate) {
    nationalLookup = await waitForRecruitTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.citySearchResult,
      "全国",
      { match: "exact", timeoutMs: Math.min(optionTimeoutMs, 6000) }
    );
  }
  if (!nationalLookup.candidate) {
    return {
      applied: false,
      reason: "national_city_option_not_found",
      requested_city: requestedCity,
      input,
      path,
      discovered_options: summarizeTextCandidates(nationalLookup.candidates)
    };
  }

  const nationalBox = await clickNodeCenter(client, nationalLookup.candidate.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(700);
  path.push({
    label: "全国",
    selected_label: nationalLookup.candidate.text,
    node_id: nationalLookup.candidate.node_id,
    box: nationalBox
  });

  return {
    applied: true,
    reason,
    city: "全国",
    requested_city: requestedCity,
    selected_label: nationalLookup.candidate.text,
    selected_node_id: nationalLookup.candidate.node_id,
    input,
    path,
    box: nationalBox,
    selection_mode: "city_picker",
    picker_path: ["城市", "热门", "全国"]
  };
}

async function resetRecruitCityToNational(client, {
  requestedCity = "",
  reason = "national_city_frame_reset",
  optionTimeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS
} = {}) {
  const roots = await getRecruitRoots(client, { requireFrame: false });
  const reset = await navigateRecruitSearchFrame(client, roots?.iframe?.nodeId, { reason });
  if (!reset) {
    return {
      applied: false,
      reason: "national_city_frame_reset_unavailable",
      requested_city: requestedCity
    };
  }
  await sleep(1500);
  const controls = await waitForRecruitSearchControls(client, {
    timeoutMs: Math.max(optionTimeoutMs, DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS),
    intervalMs: 300
  });
  return {
    applied: controls.ok,
    reason,
    city: "全国",
    requested_city: requestedCity,
    selected_label: "全国",
    selection_mode: "frame_reset",
    reset,
    controls,
    reacquire_frame: true
  };
}

export async function setRecruitCity(client, frameNodeId, city, {
  optionTimeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS
} = {}) {
  const normalizedCity = normalizeText(city);
  if (!normalizedCity) {
    return { applied: false, reason: "empty_city" };
  }
  if (isRecruitNationalCity(normalizedCity)) {
    return selectRecruitNationalCityThroughPicker(client, frameNodeId, {
      requestedCity: normalizedCity,
      reason: "national_city_requested",
      optionTimeoutMs
    });
  }

  const input = await clickFirstNodeBySelectors(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.cityInput);
  await clearFocusedInput(client);
  await sleep(120);
  await insertText(client, normalizedCity);
  await sleep(500);

  const started = Date.now();
  const noResultFallbackMs = Math.min(DEFAULT_RECRUIT_CITY_NO_RESULT_FALLBACK_MS, optionTimeoutMs);
  let candidate = null;
  let candidates = [];
  let noResultFirstSeenAt = 0;
  while (Date.now() - started <= optionTimeoutMs) {
    const found = await findTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.citySearchResult,
      normalizedCity,
      { match: "contains" }
    );
    candidate = found.candidate;
    candidates = found.candidates;
    if (candidate) break;
    const hasNoResult = candidates.some((item) => CITY_NO_RESULT_LABELS.has(item.label));
    if (hasNoResult) {
      if (!noResultFirstSeenAt) noResultFirstSeenAt = Date.now();
      if (Date.now() - noResultFirstSeenAt >= noResultFallbackMs) break;
    } else {
      noResultFirstSeenAt = 0;
    }
    await sleep(300);
  }
  if (!candidate) {
    const nationalFallback = await selectRecruitNationalCityThroughPicker(client, frameNodeId, {
      requestedCity: normalizedCity,
      reason: "city_result_not_found",
      optionTimeoutMs
    });
    if (nationalFallback.applied) {
      return {
        ...nationalFallback,
        reason: "city_result_not_found",
        requested_city: normalizedCity,
        requested_city_not_found: true,
        fallback_to_national: true,
        original_input: input,
        elapsed_ms: Date.now() - started,
        discovered_options_before_fallback: candidates.map((item) => item.text).slice(0, 20)
      };
    }

    const resetFallback = await resetRecruitCityToNational(client, {
      requestedCity: normalizedCity,
      reason: "city_result_not_found_frame_reset",
      optionTimeoutMs
    });
    if (resetFallback.applied) {
      return {
        ...resetFallback,
        reason: "city_result_not_found",
        requested_city: normalizedCity,
        requested_city_not_found: true,
        fallback_to_national: true,
        original_input: input,
        picker_fallback: nationalFallback,
        elapsed_ms: Date.now() - started,
        discovered_options_before_fallback: candidates.map((item) => item.text).slice(0, 20)
      };
    }

    return {
      applied: false,
      reason: "city_result_not_found",
      city: normalizedCity,
      input,
      elapsed_ms: Date.now() - started,
      discovered_options: candidates.map((item) => item.text).slice(0, 20),
      national_fallback: nationalFallback,
      reset_fallback: resetFallback
    };
  }

  const box = await clickNodeCenter(client, candidate.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(600);
  return {
    applied: true,
    city: normalizedCity,
    selected_label: candidate.text,
    selected_node_id: candidate.node_id,
    input,
    elapsed_ms: Date.now() - started,
    box
  };
}

export async function clickRecruitSearch(client, frameNodeId) {
  const buttonResult = await clickFirstNodeBySelectors(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.searchButton, {
    optional: true,
    scrollIntoView: false
  });
  if (buttonResult.clicked) {
    await sleep(1500);
    return {
      searched: true,
      mode: "button",
      button: buttonResult
    };
  }

  await pressKey(client, "Enter", {
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  });
  await sleep(1500);
  return {
    searched: true,
    mode: "enter"
  };
}

export async function waitForRecruitSearchResultState(client, {
  timeoutMs = DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS,
  intervalMs = 500
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      const roots = await getRecruitRoots(client, { requireFrame: false });
      const frameNodeId = roots.iframe?.documentNodeId;
      if (frameNodeId) {
        const counts = await countSelectors(client, frameNodeId, {
          candidate_card: RECRUIT_CARD_SELECTOR,
          no_data: RECRUIT_NO_DATA_SELECTORS.join(", ")
        });
        lastState = {
          ok: counts.candidate_card > 0 || counts.no_data > 0,
          elapsed_ms: Date.now() - started,
          iframe_selector: roots.iframe.selector,
          iframe_document_node_id: frameNodeId,
          counts
        };
        if (lastState.ok) return lastState;
      }
    } catch (error) {
      lastState = {
        ok: false,
        elapsed_ms: Date.now() - started,
        error: error?.message || String(error)
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    ...(lastState || {})
  };
}

export async function applyRecruitSearchParams(client, {
  searchParams = {},
  requireCards = true,
  resetBeforeApply = false,
  searchTimeoutMs = DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS,
  resetTimeoutMs = DEFAULT_RECRUIT_RESET_TIMEOUT_MS,
  resetSettleMs = 5000,
  cityOptionTimeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS
} = {}) {
  const normalizedSearchParams = normalizeRecruitSearchParams(searchParams);
  const reset = resetBeforeApply
    ? await resetRecruitSearchPage(client, {
      timeoutMs: resetTimeoutMs,
      settleMs: resetSettleMs
    })
    : null;
  const controls = reset?.controls?.ok
    ? reset.controls
    : await waitForRecruitSearchControls(client, {
      timeoutMs: searchTimeoutMs,
      intervalMs: 500
    });
  if (!controls.ok) {
    throw new Error(`Recruit search controls were not ready after navigation; counts=${JSON.stringify(controls.counts || {})}`);
  }
  const overlayDismissal = await dismissRecruitSearchOverlays(client);
  const initialRoots = await getRecruitRoots(client);
  let frameNodeId = initialRoots.iframe.documentNodeId;
  const initialFrameNodeId = frameNodeId;
  const beforeCounts = await getRecruitSearchCounts(client, frameNodeId);
  const steps = [];

  if (normalizedSearchParams.job) {
    steps.push({
      step: "job_title",
      result: await setRecruitJobTitle(client, frameNodeId, normalizedSearchParams.job, {
        optionTimeoutMs: searchTimeoutMs
      })
    });
  }

  if (normalizedSearchParams.city) {
    const cityResult = await setRecruitCity(client, frameNodeId, normalizedSearchParams.city, {
      optionTimeoutMs: cityOptionTimeoutMs
    });
    steps.push({
      step: "city",
      result: cityResult
    });
    if (cityResult?.reacquire_frame) {
      const rootsAfterCity = await getRecruitRoots(client);
      frameNodeId = rootsAfterCity.iframe.documentNodeId;
      steps.push({
        step: "reacquire_after_city",
        result: {
          selector: rootsAfterCity.iframe.selector,
          document_node_id: frameNodeId,
          reason: cityResult.reason
        }
      });
    }
  }

  steps.push({
    step: "degree",
    result: await setRecruitDegrees(client, frameNodeId, normalizedSearchParams.degrees)
  });

  steps.push({
    step: "schools",
    result: await setRecruitSchools(client, frameNodeId, normalizedSearchParams.schools)
  });

  steps.push({
    step: "keyword",
    result: await setRecruitKeyword(client, frameNodeId, normalizedSearchParams.keyword)
  });

  steps.push({
    step: "search",
    result: await clickRecruitSearch(client, frameNodeId)
  });

  if (typeof normalizedSearchParams.filter_recent_viewed === "boolean") {
    const postSearchRoots = await getRecruitRoots(client);
    steps.push({
      step: "recent_viewed",
      result: await setRecruitRecentViewedFilter(
        client,
        postSearchRoots.iframe.documentNodeId,
        normalizedSearchParams.filter_recent_viewed
      )
    });
  }

  const postSearchState = await waitForRecruitSearchResultState(client, {
    timeoutMs: searchTimeoutMs
  });
  if (requireCards && (postSearchState.counts?.candidate_card || 0) === 0) {
    throw new Error(`Recruit search did not produce candidate cards; no_data=${postSearchState.counts?.no_data || 0}`);
  }

  return {
    applied: true,
    search_params: normalizedSearchParams,
    reset,
    overlay_dismissal: overlayDismissal,
    controls,
    initial_iframe: {
      selector: initialRoots.iframe.selector,
      document_node_id: initialFrameNodeId
    },
    before_counts: beforeCounts,
    steps,
    post_search_state: postSearchState
  };
}
