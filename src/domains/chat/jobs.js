import {
  clickNodeCenter,
  clickPoint,
  DETERMINISTIC_CLICK_OPTIONS,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
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
  CHAT_JOB_FALLBACK_SELECTORS,
  CHAT_JOB_LABEL_SELECTORS,
  CHAT_JOB_OPTION_SELECTORS,
  CHAT_JOB_TRIGGER_SELECTORS
} from "./constants.js";
import { getChatRoots } from "./roots.js";

function isActiveClass(className = "") {
  return /\b(active|selected|current)\b/i.test(String(className || ""));
}

function normalizeJobText(value) {
  return normalizeText(value).replace(/\s+_/g, " _").replace(/_\s+/g, "_ ");
}

async function freshTopRootNodeId(client, fallbackNodeId) {
  try {
    const rootState = await getChatRoots(client);
    return rootState.rootNodes.top || fallbackNodeId;
  } catch {
    return fallbackNodeId;
  }
}

async function safeQuerySelector(client, rootNodeId, selector) {
  try {
    return await querySelector(client, rootNodeId, selector);
  } catch {
    return 0;
  }
}

async function safeQuerySelectorAll(client, rootNodeId, selector) {
  try {
    return await querySelectorAll(client, rootNodeId, selector);
  } catch {
    return [];
  }
}

async function readNodeText(client, nodeId) {
  const outerHTML = await getOuterHTML(client, nodeId);
  return {
    outerHTML,
    text: normalizeJobText(htmlToText(outerHTML))
  };
}

async function readSelectedJobLabel(client, rootNodeId) {
  for (const selector of CHAT_JOB_LABEL_SELECTORS) {
    const nodeId = await safeQuerySelector(client, rootNodeId, selector);
    if (!nodeId) continue;
    try {
      const { text } = await readNodeText(client, nodeId);
      if (text) return { selector, label: text };
    } catch {
      continue;
    }
  }
  return { selector: "", label: "" };
}

async function readOptionNode(client, nodeId, index, { selector, source }) {
  const [attributes, textResult] = await Promise.all([
    getAttributesMap(client, nodeId),
    readNodeText(client, nodeId)
  ]);
  const label = normalizeJobText(attributes.title || textResult.text);
  if (!label) return null;
  const rawValue = normalizeText(attributes.value || attributes["data-value"] || attributes["data-id"] || "");
  return {
    node_id: nodeId,
    index,
    label,
    title: label,
    value: rawValue || label,
    active: isActiveClass(attributes.class),
    is_all: rawValue === "-1" || /^(全部职位|全部岗位|全部)$/u.test(label),
    source,
    selector
  };
}

async function readClickableOptionNode(client, nodeId, index, { selector, source }) {
  const option = await readOptionNode(client, nodeId, index, { selector, source });
  if (!option) return null;
  try {
    const box = await getNodeBox(client, nodeId);
    option.center = box.center;
    option.rect = box.rect;
    option.visible = box.rect.width > 2 && box.rect.height > 2;
  } catch {
    option.center = null;
    option.rect = null;
    option.visible = false;
  }
  return option;
}

async function readOptionsForSelector(client, rootNodeId, selector, { source }) {
  const nodeIds = await safeQuerySelectorAll(client, rootNodeId, selector);
  const options = [];
  for (const nodeId of nodeIds) {
    let option = null;
    try {
      option = await readClickableOptionNode(client, nodeId, options.length + 1, {
        selector,
        source
      });
    } catch {
      option = null;
    }
    if (option) options.push(option);
  }
  return options;
}

function dedupeJobOptions(options = []) {
  const seen = new Set();
  const deduped = [];
  for (const option of options) {
    const key = `${normalizeText(option.value).toLowerCase()}|${normalizeText(option.label).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      ...option,
      index: deduped.length + 1
    });
  }
  return deduped;
}

export async function readChatJobOptions(client, rootNodeId, {
  timeoutMs = 12000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let selected = { selector: "", label: "" };
  let lastPrimary = {
    selector: "",
    source: "chat-job-list",
    options: []
  };

  while (Date.now() - started <= timeoutMs) {
    selected = await readSelectedJobLabel(client, rootNodeId);
    for (const selector of CHAT_JOB_OPTION_SELECTORS) {
      const options = await readOptionsForSelector(client, rootNodeId, selector, {
        source: "chat-job-list"
      });
      if (options.length) {
        lastPrimary = {
          selector,
          source: "chat-job-list",
          options: dedupeJobOptions(options)
        };
        return {
          selector,
          source: "chat-job-list",
          selected_label: selected.label || "",
          selected_selector: selected.selector || "",
          job_options: lastPrimary.options
        };
      }
    }
    await sleep(intervalMs);
  }

  const fallbackOptions = [];
  for (const selector of CHAT_JOB_FALLBACK_SELECTORS) {
    const options = await readOptionsForSelector(client, rootNodeId, selector, {
      source: "conversation-source-job"
    });
    fallbackOptions.push(...options);
  }

  const dedupedFallback = dedupeJobOptions(fallbackOptions);
  if (dedupedFallback.length) {
    return {
      selector: CHAT_JOB_FALLBACK_SELECTORS.join(", "),
      source: "conversation-source-job",
      selected_label: selected.label || "",
      selected_selector: selected.selector || "",
      job_options: dedupedFallback
    };
  }

  return {
    selector: lastPrimary.selector,
    source: lastPrimary.source,
    selected_label: selected.label || "",
    selected_selector: selected.selector || "",
    job_options: []
  };
}

function matchJobOption(option, jobLabel = "") {
  const requested = normalizeJobText(jobLabel).toLowerCase();
  if (!requested) return false;
  return [
    option.value,
    option.label,
    option.title
  ].map((value) => normalizeJobText(value).toLowerCase()).some((value) => (
    value === requested
    || value.includes(requested)
    || requested.includes(value)
  ));
}

function activeMatchingJobOption(options = [], jobLabel = "") {
  return (options || []).find((option) => option.active && matchJobOption(option, jobLabel)) || null;
}

function selectedLabelMatches(label = "", jobLabel = "") {
  const normalized = normalizeJobText(label);
  return Boolean(normalized && matchJobOption({ label: normalized, value: normalized, title: normalized }, jobLabel));
}

async function clickFirstVisible(client, rootNodeId, selectors = []) {
  for (const selector of selectors) {
    const nodeIds = await safeQuerySelectorAll(client, rootNodeId, selector);
    for (const nodeId of nodeIds) {
      try {
        const box = await getNodeBox(client, nodeId);
        if (box.rect.width <= 2 || box.rect.height <= 2) continue;
        await clickPoint(client, box.center.x, box.center.y, DETERMINISTIC_CLICK_OPTIONS);
        return {
          clicked: true,
          selector,
          node_id: nodeId,
          center: box.center
        };
      } catch {}
    }
  }
  return {
    clicked: false,
    selector: "",
    node_id: 0
  };
}

async function openChatJobDropdown(client, rootNodeId, {
  timeoutMs = 12000,
  intervalMs = 300,
  settleMs = 800
} = {}) {
  const started = Date.now();
  const triedPoints = new Set();
  const attempts = [];
  const initialClose = await closeChatJobDropdownQuietly(client, rootNodeId, Math.min(settleMs, 300));
  for (const selector of CHAT_JOB_TRIGGER_SELECTORS) {
    const currentRootNodeId = await freshTopRootNodeId(client, rootNodeId);
    const nodeIds = await safeQuerySelectorAll(client, currentRootNodeId, selector);
    for (const nodeId of nodeIds) {
      try {
        const box = await getNodeBox(client, nodeId);
        if (box.rect.width <= 2 || box.rect.height <= 2) continue;
        const y = box.center.y;
        const xCandidates = [
          ["center", box.center.x],
          ["right_12", box.rect.x + box.rect.width - 12],
          ["right_44", box.rect.x + box.rect.width - 44],
          ["right_64", box.rect.x + box.rect.width - 64]
        ].filter(([, x]) => x > box.rect.x + 4 && x < box.rect.x + box.rect.width - 4);
        for (const [pointName, x] of xCandidates) {
          const pointKey = `${nodeId}:${Math.round(x)}:${Math.round(y)}`;
          if (triedPoints.has(pointKey)) continue;
          triedPoints.add(pointKey);
          await clickPoint(client, x, y, DETERMINISTIC_CLICK_OPTIONS);
          if (settleMs > 0) await sleep(Math.min(settleMs, 800));
          const remaining = Math.max(300, timeoutMs - (Date.now() - started));
          const optionsResult = await waitForChatJobOptions(client, currentRootNodeId, {
            timeoutMs: Math.min(remaining, 1800),
            intervalMs,
            requireVisible: true
          });
          const visibleCount = (optionsResult.job_options || []).filter((option) => option.visible).length;
          const attempt = {
            clicked: true,
            selector,
            node_id: nodeId,
            point: pointName,
            center: { x, y },
            visible_option_count: visibleCount,
            initial_close: initialClose
          };
          attempts.push(attempt);
          if (visibleCount > 0) {
            return {
              ...attempt,
              attempts,
              options_result: optionsResult
            };
          }
          if (Date.now() - started > timeoutMs) break;
        }
      } catch (error) {
        attempts.push({
          clicked: false,
          selector,
          node_id: nodeId,
          error: error?.message || String(error)
        });
      }
      if (Date.now() - started > timeoutMs) break;
    }
    if (Date.now() - started > timeoutMs) break;
  }
  return {
    clicked: attempts.some((attempt) => attempt.clicked),
    selector: attempts.find((attempt) => attempt.clicked)?.selector || "",
    node_id: attempts.find((attempt) => attempt.clicked)?.node_id || 0,
    attempts,
    options_result: null
  };
}

async function waitForChatJobOptions(client, rootNodeId, {
  timeoutMs = 12000,
  intervalMs = 300,
  requireVisible = false
} = {}) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started <= timeoutMs) {
    const currentRootNodeId = await freshTopRootNodeId(client, rootNodeId);
    latest = await readChatJobOptions(client, currentRootNodeId, {
      timeoutMs: Math.min(intervalMs, 300),
      intervalMs
    });
    const options = latest.job_options || [];
    if (options.length && (!requireVisible || options.some((option) => option.visible))) {
      return latest;
    }
    await sleep(intervalMs);
  }
  return latest || {
    selector: "",
    source: "chat-job-list",
    selected_label: "",
    job_options: []
  };
}

async function waitForSelectedChatJob(client, rootNodeId, jobLabel = "", {
  timeoutMs = 5000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started <= timeoutMs) {
    const currentRootNodeId = await freshTopRootNodeId(client, rootNodeId);
    latest = await readChatJobOptions(client, currentRootNodeId, {
      timeoutMs: Math.min(intervalMs, 300),
      intervalMs
    });
    if (
      selectedLabelMatches(latest.selected_label, jobLabel)
      || activeMatchingJobOption(latest.job_options || [], jobLabel)
    ) {
      return {
        verified: true,
        result: latest
      };
    }
    await sleep(intervalMs);
  }
  return {
    verified: false,
    result: latest
  };
}

async function visibleChatJobOptions(client, rootNodeId) {
  const currentRootNodeId = await freshTopRootNodeId(client, rootNodeId);
  const visible = [];
  for (const selector of CHAT_JOB_OPTION_SELECTORS) {
    const nodeIds = await safeQuerySelectorAll(client, currentRootNodeId, selector);
    for (const nodeId of nodeIds) {
      try {
        const box = await getNodeBox(client, nodeId);
        if (box.rect.width > 2 && box.rect.height > 2) {
          visible.push({
            selector,
            node_id: nodeId,
            center: box.center,
            rect: box.rect
          });
        }
      } catch {
        // Hidden job options are normal when the dropdown is closed.
      }
    }
  }
  return visible;
}

export async function closeChatJobDropdown(client, rootNodeId, {
  settleMs = 180
} = {}) {
  const before = await visibleChatJobOptions(client, rootNodeId);
  if (!before.length) {
    return {
      ok: true,
      closed: false,
      reason: "already_closed",
      visible_before_count: 0,
      visible_after_count: 0
    };
  }
  if (typeof client?.Input?.dispatchKeyEvent !== "function") {
    return {
      ok: false,
      closed: false,
      reason: "dispatch_key_unavailable",
      visible_before_count: before.length,
      visible_after_count: before.length
    };
  }
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  if (settleMs > 0) await sleep(settleMs);
  const after = await visibleChatJobOptions(client, rootNodeId);
  if (after.length) {
    const currentRootNodeId = await freshTopRootNodeId(client, rootNodeId);
    for (const selector of CHAT_JOB_TRIGGER_SELECTORS) {
      const nodeIds = await safeQuerySelectorAll(client, currentRootNodeId, selector);
      for (const nodeId of nodeIds) {
        try {
          const box = await getNodeBox(client, nodeId);
          if (box.rect.width <= 2 || box.rect.height <= 2) continue;
          await clickPoint(client, box.center.x, box.center.y, DETERMINISTIC_CLICK_OPTIONS);
          if (settleMs > 0) await sleep(settleMs);
          const afterToggle = await visibleChatJobOptions(client, currentRootNodeId);
          if (!afterToggle.length) {
            return {
              ok: true,
              closed: true,
              reason: "trigger_toggle",
              visible_before_count: before.length,
              visible_after_count: 0,
              first_visible_before: before[0] || null,
              first_visible_after: null
            };
          }
        } catch {
          continue;
        }
      }
    }
  }
  return {
    ok: after.length === 0,
    closed: after.length === 0,
    reason: after.length ? "still_visible_after_escape" : "escape",
    visible_before_count: before.length,
    visible_after_count: after.length,
    first_visible_before: before[0] || null,
    first_visible_after: after[0] || null
  };
}

async function closeChatJobDropdownQuietly(client, rootNodeId, settleMs = 180) {
  try {
    return await closeChatJobDropdown(client, rootNodeId, { settleMs });
  } catch (error) {
    return {
      ok: false,
      closed: false,
      reason: "close_failed",
      error: error?.message || String(error)
    };
  }
}

export async function selectChatJob(client, rootNodeId, {
  jobLabel = "",
  timeoutMs = 12000,
  intervalMs = 300,
  settleMs = 800
} = {}) {
  const requested = normalizeJobText(jobLabel);
  if (!requested) {
    return {
      selected: false,
      reason: "missing_job_label"
    };
  }

  let currentRootNodeId = await freshTopRootNodeId(client, rootNodeId);
  let optionsResult = await readChatJobOptions(client, currentRootNodeId, {
    timeoutMs: Math.min(timeoutMs, 1500),
    intervalMs
  });
  let matched = (optionsResult.job_options || []).find((option) => matchJobOption(option, requested)) || null;
  if (
    matched
    && (
      matched.active
      || selectedLabelMatches(optionsResult.selected_label, matched.label)
      || selectedLabelMatches(optionsResult.selected_label, requested)
    )
  ) {
    const menuClose = await closeChatJobDropdownQuietly(client, currentRootNodeId, Math.min(settleMs, 300));
    return {
      selected: true,
      verified: true,
      already_current: true,
      requested,
      selected_option: matched,
      options: optionsResult.job_options || [],
      selected_label: optionsResult.selected_label || matched.label,
      menu_close: menuClose
    };
  }

  if (!matched || !matched.visible) {
    const triggerRootNodeId = await freshTopRootNodeId(client, currentRootNodeId);
    const trigger = await openChatJobDropdown(client, triggerRootNodeId, {
      timeoutMs,
      intervalMs,
      settleMs
    });
    currentRootNodeId = await freshTopRootNodeId(client, triggerRootNodeId);
    optionsResult = trigger.options_result || await waitForChatJobOptions(client, currentRootNodeId, {
      timeoutMs,
      intervalMs,
      requireVisible: true
    });
    matched = (optionsResult.job_options || []).find((option) => matchJobOption(option, requested)) || null;
    if (!matched || !matched.visible) {
      const menuClose = await closeChatJobDropdownQuietly(client, currentRootNodeId, Math.min(settleMs, 300));
      return {
        selected: false,
        reason: matched ? "job_option_not_visible" : "job_option_not_found",
        requested,
        trigger,
        options: optionsResult.job_options || [],
        selected_label_before: optionsResult.selected_label || "",
        menu_close: menuClose
      };
    }
  }

  if (matched.active || normalizeJobText(optionsResult.selected_label).toLowerCase() === normalizeJobText(matched.label).toLowerCase()) {
    const menuClose = await closeChatJobDropdownQuietly(client, currentRootNodeId, Math.min(settleMs, 300));
    return {
      selected: true,
      verified: true,
      already_current: true,
      requested,
      selected_option: matched,
      options: optionsResult.job_options || [],
      selected_label: optionsResult.selected_label || matched.label,
      menu_close: menuClose
    };
  }

  if (matched.center) {
    await clickPoint(client, matched.center.x, matched.center.y, DETERMINISTIC_CLICK_OPTIONS);
  } else {
    await clickNodeCenter(client, matched.node_id, {
      ...DETERMINISTIC_CLICK_OPTIONS,
      scrollIntoView: true
    });
  }
  if (settleMs > 0) await sleep(settleMs);

  const afterRootNodeId = await freshTopRootNodeId(client, currentRootNodeId);
  const verification = await waitForSelectedChatJob(client, afterRootNodeId, matched.label, {
    timeoutMs: Math.min(timeoutMs, 5000),
    intervalMs
  });
  const after = verification.result || {
    selected_label: "",
    job_options: []
  };
  const afterMatch = (after.job_options || []).find((option) => matchJobOption(option, matched.label)) || matched;
  const selectedLabel = normalizeJobText(after.selected_label || "");
  const activeMatch = activeMatchingJobOption(after.job_options || [], matched.label);
  const verified = Boolean(verification.verified || selectedLabelMatches(selectedLabel, matched.label) || activeMatch);
  const menuClose = await closeChatJobDropdownQuietly(client, afterRootNodeId, Math.min(settleMs, 300));

  return {
    selected: verified,
    verified,
    already_current: false,
    reason: verified ? "verified" : "job_selection_not_verified",
    requested,
    selected_option: afterMatch,
    active_option: activeMatch,
    options: after.job_options || optionsResult.job_options || [],
    selected_label: selectedLabel,
    before: optionsResult,
    after,
    menu_close: menuClose
  };
}
