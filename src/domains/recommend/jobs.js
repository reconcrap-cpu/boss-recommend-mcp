import {
  clickNodeCenter,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  pressKey,
  querySelectorAll,
  sleep,
  waitForSelector
} from "../../core/browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../../core/screening/index.js";

export const RECOMMEND_JOB_SELECTORS = Object.freeze({
  trigger: ".job-selecter-wrap, [class*=\"job-selecter-wrap\"], .ui-dropmenu",
  option: ".job-selecter-options .job-item, .job-list .job-item, .job-item",
  current: ".job-selecter-options .job-item.curr, .job-list .job-item.curr, .job-item.curr"
});

function normalizeJobText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function trimSalarySuffix(label) {
  return normalizeText(label)
    .replace(/\s+(?:\d+(?:-\d+)?K|面议|\d+-\d+元\/天).*$/i, "")
    .trim();
}

export function jobLabelMatches(optionLabel, targetLabel) {
  const option = normalizeJobText(optionLabel);
  const target = normalizeJobText(targetLabel);
  if (!option || !target) return false;
  return option === target
    || option.startsWith(target)
    || normalizeJobText(trimSalarySuffix(optionLabel)) === target;
}

function isVisibleBox(box) {
  return Boolean(box && box.rect.width > 4 && box.rect.height > 4);
}

async function readJobOption(client, nodeId, index) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
  ]);
  const label = normalizeText(htmlToText(outerHTML));
  let box = null;
  try {
    box = await getNodeBox(client, nodeId);
  } catch {}
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

export async function findRecommendJobTrigger(client, frameNodeId) {
  const nodeIds = await querySelectorAll(client, frameNodeId, RECOMMEND_JOB_SELECTORS.trigger);
  for (const nodeId of nodeIds) {
    try {
      const box = await getNodeBox(client, nodeId);
      if (isVisibleBox(box)) {
        return {
          node_id: nodeId,
          center: box.center,
          rect: box.rect
        };
      }
    } catch {}
  }
  return null;
}

export async function openRecommendJobDropdown(client, frameNodeId, {
  timeoutMs = 4000
} = {}) {
  const trigger = await findRecommendJobTrigger(client, frameNodeId);
  if (!trigger) {
    throw new Error("Recommend job trigger was not found");
  }

  let optionNodeId = await waitForSelector(client, frameNodeId, RECOMMEND_JOB_SELECTORS.option, {
    timeoutMs: 300,
    intervalMs: 100
  });
  if (optionNodeId) {
    const options = await listRecommendJobOptions(client, frameNodeId, { openDropdown: false });
    if (options.some((option) => option.visible)) {
      return {
        opened: true,
        already_open: true,
        trigger,
        options
      };
    }
  }

  await clickNodeCenter(client, trigger.node_id);
  optionNodeId = await waitForSelector(client, frameNodeId, RECOMMEND_JOB_SELECTORS.option, {
    timeoutMs,
    intervalMs: 200
  });
  if (!optionNodeId) {
    throw new Error("Recommend job dropdown did not mount options after trigger click");
  }
  const options = await listRecommendJobOptions(client, frameNodeId, { openDropdown: false });
  return {
    opened: true,
    already_open: false,
    trigger,
    options
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
    if (!option.label) continue;
    if (option.label.length > 120) continue;
    options.push(option);
  }
  return options;
}

export async function closeRecommendJobDropdown(client) {
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await sleep(300);
}

export async function selectRecommendJob(client, frameNodeId, {
  jobLabel = "",
  settleMs = 6000
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

  const opened = await openRecommendJobDropdown(client, frameNodeId);
  const options = opened.options.length
    ? opened.options
    : await listRecommendJobOptions(client, frameNodeId, { openDropdown: false });
  const visibleOptions = options.filter((option) => option.visible);
  const match = visibleOptions.find((option) => jobLabelMatches(option.label, target))
    || options.find((option) => jobLabelMatches(option.label, target));

  if (!match) {
    await closeRecommendJobDropdown(client);
    return {
      requested: target,
      selected: false,
      reason: "job_not_found",
      options: options.map(compactJobOption)
    };
  }

  if (match.current) {
    await closeRecommendJobDropdown(client);
    return {
      requested: target,
      selected: true,
      already_current: true,
      selected_option: compactJobOption(match),
      options: options.map(compactJobOption)
    };
  }

  if (!match.center) {
    await closeRecommendJobDropdown(client);
    throw new Error(`Matched recommend job has no clickable center: ${match.label}`);
  }

  const clickedBox = await clickNodeCenter(client, match.node_id);
  if (settleMs > 0) await sleep(settleMs);
  return {
    requested: target,
    selected: true,
    already_current: false,
    selected_option: compactJobOption(match),
    click_box: {
      center: clickedBox.center,
      rect: clickedBox.rect
    },
    options: options.map(compactJobOption)
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
    rect: option.rect
  };
}
