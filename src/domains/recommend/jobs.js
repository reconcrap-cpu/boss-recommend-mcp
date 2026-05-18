import {
  clickNodeCenter,
  clickPoint,
  DETERMINISTIC_CLICK_OPTIONS,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  pressKey,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../../core/screening/index.js";
import { isStaleRecommendNodeError } from "./detail.js";

export const RECOMMEND_JOB_SELECTORS = Object.freeze({
  trigger: ".job-selecter-wrap, [class*=\"job-selecter-wrap\"], .ui-dropmenu",
  option: ".job-selecter-options .job-item, .job-list .job-item, .job-item",
  current: ".job-selecter-options .job-item.curr, .job-list .job-item.curr, .job-item.curr"
});

function normalizeJobText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function stripSalaryText(label) {
  return normalizeText(label)
    .replace(/\s*[（(]\s*(?:\d+(?:-\d+)?K|面议|\d+-\d+元\/天)\s*[）)]\s*$/i, "")
    .replace(/\s+(?:\d+(?:-\d+)?K|面议|\d+-\d+元\/天)\s*$/i, "")
    .trim();
}

function trimSalarySuffix(label) {
  return stripSalaryText(label);
}

export function jobLabelMatches(optionLabel, targetLabel) {
  const option = normalizeJobText(optionLabel);
  const target = normalizeJobText(targetLabel);
  const optionWithoutSalary = normalizeJobText(stripSalaryText(optionLabel));
  const targetWithoutSalary = normalizeJobText(stripSalaryText(targetLabel));
  if (!option || !target) return false;
  return option === target
    || option.startsWith(target)
    || optionWithoutSalary === target
    || option === targetWithoutSalary
    || optionWithoutSalary === targetWithoutSalary;
}

function isVisibleBox(box) {
  return Boolean(box && box.rect.width > 4 && box.rect.height > 4);
}

async function readJobOption(client, nodeId, index) {
  let attributes = null;
  let outerHTML = "";
  try {
    [attributes, outerHTML] = await Promise.all([
      getAttributesMap(client, nodeId),
      getOuterHTML(client, nodeId)
    ]);
  } catch (error) {
    if (isStaleRecommendNodeError(error)) {
      return null;
    }
    throw error;
  }
  const label = normalizeText(htmlToText(outerHTML));
  let box = null;
  try {
    box = await getNodeBox(client, nodeId);
  } catch (error) {
    if (!isStaleRecommendNodeError(error)) throw error;
  }
  const className = attributes.class || "";
  return {
    node_id: nodeId,
    index,
    label,
    label_without_salary: trimSalarySuffix(label),
    class_name: className,
    current: /\bcurr\b|\bactive\b|\bselected\b/.test(className),
    visible: isVisibleBox(box),
    center: box?.center || null,
    rect: box?.rect || null
  };
}

async function readJobTrigger(client, nodeId) {
  let box = null;
  try {
    box = await getNodeBox(client, nodeId);
  } catch {}
  if (!isVisibleBox(box)) return null;

  let label = "";
  let className = "";
  try {
    const outerHTML = await getOuterHTML(client, nodeId);
    label = normalizeText(htmlToText(outerHTML));
  } catch {}
  try {
    const attributes = await getAttributesMap(client, nodeId);
    className = attributes.class || "";
  } catch {}

  return {
    node_id: nodeId,
    center: box.center,
    rect: box.rect,
    label,
    label_without_salary: trimSalarySuffix(label),
    class_name: className,
    visible: true
  };
}

export async function findRecommendJobTrigger(client, frameNodeId) {
  const nodeIds = await querySelectorAll(client, frameNodeId, RECOMMEND_JOB_SELECTORS.trigger);
  for (const nodeId of nodeIds) {
    const trigger = await readJobTrigger(client, nodeId);
    if (trigger) return trigger;
  }
  return null;
}

export async function waitForRecommendJobTrigger(client, frameNodeId, {
  timeoutMs = 8000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const trigger = await findRecommendJobTrigger(client, frameNodeId);
    if (trigger) return trigger;
    await sleep(intervalMs);
  }
  return null;
}

export async function openRecommendJobDropdown(client, frameNodeId, {
  timeoutMs = 4000,
  triggerTimeoutMs = Math.max(8000, timeoutMs),
  triggerIntervalMs = 250,
  dismissBeforeOpen = true,
  maxAttempts = 3
} = {}) {
  const trigger = await waitForRecommendJobTrigger(client, frameNodeId, {
    timeoutMs: triggerTimeoutMs,
    intervalMs: triggerIntervalMs
  });
  if (!trigger) {
    throw new Error("Recommend job trigger was not found");
  }

  const alreadyOpen = await waitForVisibleRecommendJobOptions(client, frameNodeId, {
    timeoutMs: 300,
    intervalMs: 100
  });
  if (alreadyOpen.visible_options.length) {
    return {
      opened: true,
      already_open: true,
      trigger,
      options: alreadyOpen.options
    };
  }

  const attempts = [];
  const attemptLimit = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  if (dismissBeforeOpen) {
    await closeRecommendJobDropdown(client);
  }
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    if (attempt > 1) await closeRecommendJobDropdown(client);
    const triggerBox = await clickNodeCenter(client, trigger.node_id, DETERMINISTIC_CLICK_OPTIONS);
    const opened = await waitForVisibleRecommendJobOptions(client, frameNodeId, {
      timeoutMs,
      intervalMs: 200
    });
    attempts.push({
      attempt,
      trigger_box: triggerBox,
      option_count: opened.options.length,
      visible_option_count: opened.visible_options.length
    });
    if (opened.visible_options.length) {
      return {
        opened: true,
        already_open: false,
        trigger,
        options: opened.options,
        attempts
      };
    }
  }
  const error = new Error("Recommend job dropdown did not expose visible options after trigger click");
  error.trigger = trigger;
  error.job_dropdown_attempts = attempts;
  throw error;
}

async function waitForVisibleRecommendJobOptions(client, frameNodeId, {
  timeoutMs = 4000,
  intervalMs = 200
} = {}) {
  const started = Date.now();
  let lastOptions = [];
  while (Date.now() - started <= timeoutMs) {
    lastOptions = await listRecommendJobOptions(client, frameNodeId, { openDropdown: false });
    const visibleOptions = lastOptions.filter((option) => option.visible);
    if (visibleOptions.length) {
      return {
        options: lastOptions,
        visible_options: visibleOptions
      };
    }
    await sleep(intervalMs);
  }
  return {
    options: lastOptions,
    visible_options: []
  };
}

export async function listRecommendJobOptions(client, frameNodeId, {
  openDropdown = true
} = {}) {
  if (openDropdown) {
    await openRecommendJobDropdown(client, frameNodeId);
  }

  const nodeIds = await querySelectorAll(client, frameNodeId, RECOMMEND_JOB_SELECTORS.option);
  const options = [];
  const seen = new Set();
  for (let index = 0; index < nodeIds.length; index += 1) {
    const nodeId = nodeIds[index];
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const option = await readJobOption(client, nodeId, index);
    if (!option) continue;
    if (!option.label) continue;
    if (option.label.length > 120) continue;
    options.push(option);
  }
  return options;
}

export async function closeRecommendJobDropdown(client) {
  if (typeof client?.Input?.dispatchKeyEvent !== "function") {
    return {
      ok: false,
      reason: "dispatch_key_unavailable"
    };
  }
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await sleep(300);
  return {
    ok: true,
    reason: "escape"
  };
}

async function readVisibleRecommendJobOptions(client, frameNodeId) {
  const options = await listRecommendJobOptions(client, frameNodeId, {
    openDropdown: false
  }).catch(() => []);
  return {
    options,
    visible_options: options.filter((option) => option.visible)
  };
}

export async function closeRecommendJobDropdownFully(client, frameNodeId, {
  settleMs = 300,
  timeoutMs = 1200
} = {}) {
  const before = await readVisibleRecommendJobOptions(client, frameNodeId);
  const attempts = [];
  if (!before.visible_options.length) {
    return {
      ok: true,
      closed: false,
      reason: "already_closed",
      visible_before_count: 0,
      visible_after_count: 0,
      attempts
    };
  }

  const started = Date.now();
  for (let attempt = 1; attempt <= 2 && Date.now() - started <= timeoutMs; attempt += 1) {
    const close = await closeRecommendJobDropdown(client);
    if (settleMs > 0) await sleep(settleMs);
    const afterEscape = await readVisibleRecommendJobOptions(client, frameNodeId);
    attempts.push({
      method: "escape",
      attempt,
      ok: afterEscape.visible_options.length === 0,
      visible_after_count: afterEscape.visible_options.length,
      close
    });
    if (!afterEscape.visible_options.length) {
      return {
        ok: true,
        closed: true,
        reason: "escape",
        visible_before_count: before.visible_options.length,
        visible_after_count: 0,
        attempts
      };
    }
  }

  const trigger = await findRecommendJobTrigger(client, frameNodeId).catch(() => null);
  if (trigger?.node_id) {
    const click = await clickNodeCenter(client, trigger.node_id, DETERMINISTIC_CLICK_OPTIONS).catch((error) => ({
      error: error?.message || String(error || "")
    }));
    if (settleMs > 0) await sleep(settleMs);
    const afterToggle = await readVisibleRecommendJobOptions(client, frameNodeId);
    attempts.push({
      method: "trigger_toggle",
      ok: afterToggle.visible_options.length === 0,
      visible_after_count: afterToggle.visible_options.length,
      click
    });
    if (!afterToggle.visible_options.length) {
      return {
        ok: true,
        closed: true,
        reason: "trigger_toggle",
        visible_before_count: before.visible_options.length,
        visible_after_count: 0,
        attempts
      };
    }
  }

  const outside = await clickPoint(client, 12, 12, DETERMINISTIC_CLICK_OPTIONS).catch((error) => ({
    error: error?.message || String(error || "")
  }));
  if (settleMs > 0) await sleep(settleMs);
  const afterOutside = await readVisibleRecommendJobOptions(client, frameNodeId);
  attempts.push({
    method: "outside_click",
    ok: afterOutside.visible_options.length === 0,
    visible_after_count: afterOutside.visible_options.length,
    click: outside
  });

  return {
    ok: afterOutside.visible_options.length === 0,
    closed: afterOutside.visible_options.length === 0,
    reason: afterOutside.visible_options.length ? "still_visible_after_close_attempts" : "outside_click",
    visible_before_count: before.visible_options.length,
    visible_after_count: afterOutside.visible_options.length,
    attempts,
    first_visible_after: afterOutside.visible_options[0] ? compactJobOption(afterOutside.visible_options[0]) : null
  };
}

export async function verifyRecommendJobSelection(client, frameNodeId, {
  jobLabel = "",
  delayMs = 2000,
  dropdownTimeoutMs = 4000,
  closeSettleMs = 300
} = {}) {
  const requested = normalizeText(jobLabel);
  if (delayMs > 0) await sleep(delayMs);
  let options = [];
  let openError = null;
  try {
    options = await listRecommendJobOptions(client, frameNodeId, {
      openDropdown: true
    });
  } catch (error) {
    openError = error;
    options = await listRecommendJobOptions(client, frameNodeId, {
      openDropdown: false
    }).catch(() => []);
  }
  const current = options.find((option) => option.current) || null;
  const verified = Boolean(current && jobLabelMatches(current.label, requested));
  const menuClose = await closeRecommendJobDropdownFully(client, frameNodeId, {
    settleMs: closeSettleMs,
    timeoutMs: Math.max(1200, Math.min(4000, dropdownTimeoutMs))
  }).catch((error) => ({
    ok: false,
    closed: false,
    reason: "close_failed",
    error: error?.message || String(error || "")
  }));
  return {
    verified,
    requested,
    current_label: current?.label || "",
    current_label_without_salary: current?.label_without_salary || "",
    current_option: current ? compactJobOption(current) : null,
    option_count: options.length,
    visible_option_count: options.filter((option) => option.visible).length,
    options: options.map(compactJobOption),
    open_error: openError ? (openError?.message || String(openError)) : null,
    menu_close: menuClose
  };
}

export async function selectRecommendJob(client, frameNodeId, {
  jobLabel = "",
  settleMs = 6000,
  dropdownTimeoutMs = Math.max(8000, settleMs)
} = {}) {
  const target = normalizeText(jobLabel);
  if (!target) {
    return {
      requested: "",
      selected: false,
      reason: "no_job_requested",
      options: []
    };
  }

  let opened = null;
  try {
    opened = await openRecommendJobDropdown(client, frameNodeId, {
      timeoutMs: dropdownTimeoutMs,
      triggerTimeoutMs: dropdownTimeoutMs
    });
  } catch (error) {
    const currentOptions = await listRecommendJobOptions(client, frameNodeId, {
      openDropdown: false
    }).catch(() => []);
    const currentMatch = currentOptions.find((option) => (
      option.current && jobLabelMatches(option.label, target)
    ));
    if (currentMatch) {
      const menuClose = await closeRecommendJobDropdownFully(client, frameNodeId).catch((closeError) => ({
        ok: false,
        closed: false,
        reason: "close_failed",
        error: closeError?.message || String(closeError || "")
      }));
      return {
        requested: target,
        selected: true,
        already_current: true,
        selected_option: compactJobOption({
          ...currentMatch,
          source: "current_option_without_visible_dropdown"
        }),
        options: currentOptions.map(compactJobOption),
        dropdown_error: error?.message || String(error),
        job_dropdown_attempts: error?.job_dropdown_attempts || [],
        menu_close: menuClose
      };
    }
    throw error;
  }
  const options = opened.options.length
    ? opened.options
    : await listRecommendJobOptions(client, frameNodeId, { openDropdown: false });
  const visibleOptions = options.filter((option) => option.visible);
  const hiddenMatches = options.filter((option) => !option.visible && jobLabelMatches(option.label, target));
  const match = visibleOptions.find((option) => jobLabelMatches(option.label, target));

  if (!match) {
    await closeRecommendJobDropdown(client);
    if (hiddenMatches.length) {
      const error = new Error(`Matched recommend job has no visible clickable option: ${hiddenMatches[0].label}`);
      error.hidden_job_matches = hiddenMatches.map(compactJobOption);
      throw error;
    }
    return {
      requested: target,
      selected: false,
      reason: "job_not_found",
      options: options.map(compactJobOption)
    };
  }

  if (match.current) {
    const menuClose = await closeRecommendJobDropdownFully(client, frameNodeId).catch((error) => ({
      ok: false,
      closed: false,
      reason: "close_failed",
      error: error?.message || String(error || "")
    }));
    return {
      requested: target,
      selected: true,
      already_current: true,
      selected_option: compactJobOption(match),
      options: options.map(compactJobOption),
      menu_close: menuClose
    };
  }

  if (!match.center) {
    await closeRecommendJobDropdown(client);
    throw new Error(`Matched recommend job has no clickable center: ${match.label}`);
  }

  const clickedBox = await clickNodeCenter(client, match.node_id, DETERMINISTIC_CLICK_OPTIONS);
  if (settleMs > 0) await sleep(settleMs);
  const menuClose = await closeRecommendJobDropdownFully(client, frameNodeId).catch((error) => ({
    ok: false,
    closed: false,
    reason: "close_failed",
    error: error?.message || String(error || "")
  }));
  return {
    requested: target,
    selected: true,
    already_current: false,
    selected_option: compactJobOption(match),
    click_box: {
      center: clickedBox.center,
      rect: clickedBox.rect
    },
    options: options.map(compactJobOption),
    menu_close: menuClose
  };
}

function compactJobOption(option) {
  return {
    label: option.label,
    label_without_salary: option.label_without_salary,
    current: Boolean(option.current),
    visible: Boolean(option.visible),
    class_name: option.class_name,
    node_id: option.node_id,
    center: option.center,
    rect: option.rect,
    source: option.source || null
  };
}
