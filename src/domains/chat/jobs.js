import {
  clickNodeCenter,
  clickPoint,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
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

async function clickFirstVisible(client, rootNodeId, selectors = []) {
  for (const selector of selectors) {
    const nodeIds = await safeQuerySelectorAll(client, rootNodeId, selector);
    for (const nodeId of nodeIds) {
      try {
        const box = await getNodeBox(client, nodeId);
        if (box.rect.width <= 2 || box.rect.height <= 2) continue;
        await clickPoint(client, box.center.x, box.center.y);
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
  if (!matched || !matched.visible) {
    const triggerRootNodeId = await freshTopRootNodeId(client, currentRootNodeId);
    const trigger = await clickFirstVisible(client, triggerRootNodeId, CHAT_JOB_TRIGGER_SELECTORS);
    if (settleMs > 0) await sleep(settleMs);
    currentRootNodeId = await freshTopRootNodeId(client, triggerRootNodeId);
    optionsResult = await readChatJobOptions(client, currentRootNodeId, {
      timeoutMs,
      intervalMs
    });
    matched = (optionsResult.job_options || []).find((option) => matchJobOption(option, requested)) || null;
    if (!matched || !matched.visible) {
      return {
        selected: false,
        reason: matched ? "job_option_not_visible" : "job_option_not_found",
        requested,
        trigger,
        options: optionsResult.job_options || [],
        selected_label_before: optionsResult.selected_label || ""
      };
    }
  }

  if (matched.active || normalizeJobText(optionsResult.selected_label).toLowerCase() === normalizeJobText(matched.label).toLowerCase()) {
    return {
      selected: true,
      already_current: true,
      requested,
      selected_option: matched,
      options: optionsResult.job_options || [],
      selected_label: optionsResult.selected_label || matched.label
    };
  }

  if (matched.center) {
    await clickPoint(client, matched.center.x, matched.center.y);
  } else {
    await clickNodeCenter(client, matched.node_id, {
      scrollIntoView: true
    });
  }
  if (settleMs > 0) await sleep(settleMs);

  const afterRootNodeId = await freshTopRootNodeId(client, currentRootNodeId);
  const after = await readChatJobOptions(client, afterRootNodeId, {
    timeoutMs: Math.min(timeoutMs, 3000),
    intervalMs
  });
  const afterMatch = (after.job_options || []).find((option) => matchJobOption(option, matched.label)) || matched;
  const selectedLabel = normalizeJobText(after.selected_label || afterMatch.label || "");
  const verified = selectedLabel
    ? matchJobOption({ label: selectedLabel, value: selectedLabel, title: selectedLabel }, matched.label)
    : true;

  return {
    selected: true,
    verified,
    already_current: false,
    requested,
    selected_option: afterMatch,
    options: after.job_options || optionsResult.job_options || [],
    selected_label: selectedLabel,
    before: optionsResult,
    after
  };
}
