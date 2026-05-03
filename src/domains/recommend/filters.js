import {
  clickNodeCenter,
  countSelectors,
  findFirstNode,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  pressKey,
  querySelectorAll,
  sleep,
  waitForSelector
} from "../../core/browser/index.js";
import { htmlToText, normalizeText } from "../../core/screening/index.js";
import {
  RECOMMEND_CARD_SELECTOR,
  RECOMMEND_FILTER_GROUP_ORDER,
  RECOMMEND_FILTER_SELECTORS
} from "./constants.js";

const SKIP_OPTION_LABELS = new Set(["不限", "全部", "all"]);

export function normalizeFilterOptionLabel(label) {
  return normalizeText(label).replace(/\s+/g, "");
}

export function isSafeFilterOptionLabel(label) {
  const normalized = normalizeFilterOptionLabel(label);
  return Boolean(normalized) && !SKIP_OPTION_LABELS.has(normalized.toLowerCase());
}

export function isActiveOption(attributes = {}, outerHTML = "") {
  const className = attributes.class || "";
  return /\bactive\b/.test(className) || /\bactive\b/.test(String(outerHTML || "").split(">")[0] || "");
}

export function chooseFirstSafeFilterOption(options = [], groupOrder = RECOMMEND_FILTER_GROUP_ORDER) {
  for (const group of groupOrder) {
    const option = options.find((item) => (
      item.group === group
      && !item.active
      && isSafeFilterOptionLabel(item.label)
    ));
    if (option) return option;
  }
  return null;
}

export function chooseFilterOptionByLabels(options = [], {
  group = "",
  labels = []
} = {}) {
  const normalizedGroup = normalizeText(group);
  const normalizedLabels = labels.map(normalizeFilterOptionLabel).filter(Boolean);
  for (const label of normalizedLabels) {
    const option = options.find((item) => (
      (!normalizedGroup || item.group === normalizedGroup)
      && !item.active
      && normalizeFilterOptionLabel(item.label) === label
      && isSafeFilterOptionLabel(item.label)
    ));
    if (option) return option;
  }
  return null;
}

export function chooseFilterOptionsByLabels(options = [], {
  group = "",
  labels = []
} = {}) {
  const normalizedGroup = normalizeText(group);
  const normalizedLabels = labels.map(normalizeFilterOptionLabel).filter(Boolean);
  return normalizedLabels.map((label) => {
    const option = options.find((item) => (
      (!normalizedGroup || item.group === normalizedGroup)
      && normalizeFilterOptionLabel(item.label) === label
      && isSafeFilterOptionLabel(item.label)
    ));
    return {
      label,
      option: option || null
    };
  });
}

export async function getFilterPanelCount(client, frameNodeId) {
  return (await querySelectorAll(client, frameNodeId, RECOMMEND_FILTER_SELECTORS.panel)).length;
}

export async function getRecommendFilterCounts(client, frameNodeId) {
  return countSelectors(client, frameNodeId, {
    filter_trigger: RECOMMEND_FILTER_SELECTORS.trigger,
    filter_panel: RECOMMEND_FILTER_SELECTORS.panel,
    check_box: RECOMMEND_FILTER_SELECTORS.checkBox,
    option: `.filter-panel ${RECOMMEND_FILTER_SELECTORS.option}`,
    active_option: RECOMMEND_FILTER_SELECTORS.activeOption,
    recommend_card: RECOMMEND_CARD_SELECTOR
  });
}

export async function findFilterTrigger(client, frameNodeId) {
  return findFirstNode(client, frameNodeId, [
    RECOMMEND_FILTER_SELECTORS.trigger,
    ".recommend-filter.op-filter"
  ]);
}

export async function ensureFilterPanelClosed(client, frameNodeId, triggerNodeId = 0) {
  const attempts = [];
  if (await getFilterPanelCount(client, frameNodeId) === 0) return attempts;

  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await sleep(400);
  attempts.push("Escape");

  if (await getFilterPanelCount(client, frameNodeId) > 0 && triggerNodeId) {
    await clickNodeCenter(client, triggerNodeId);
    await sleep(500);
    attempts.push("filter-trigger-toggle");
  }

  return attempts;
}

async function findFilterTriggerCandidates(client, frameNodeId) {
  const candidates = [];
  const seen = new Set();
  for (const selector of [
    RECOMMEND_FILTER_SELECTORS.trigger,
    ".recommend-filter.op-filter"
  ]) {
    const candidate = await findFirstNode(client, frameNodeId, [selector]);
    if (candidate && !seen.has(candidate.nodeId)) {
      candidates.push(candidate);
      seen.add(candidate.nodeId);
    }
  }
  return candidates;
}

export async function openFilterPanel(client, frameNodeId) {
  let triggerCandidates = await findFilterTriggerCandidates(client, frameNodeId);
  if (!triggerCandidates.length) {
    throw new Error("Recommend filter trigger was not found");
  }

  const existingPanelNodeId = await waitForSelector(client, frameNodeId, RECOMMEND_FILTER_SELECTORS.panel, {
    timeoutMs: 300,
    intervalMs: 100
  });
  if (existingPanelNodeId) {
    const triggerBox = await getNodeBox(client, triggerCandidates[0].nodeId);
    return {
      trigger: triggerCandidates[0],
      trigger_box: triggerBox,
      panel_node_id: existingPanelNodeId,
      initial_close_attempts: [],
      already_open: true
    };
  }

  const closeAttempts = await ensureFilterPanelClosed(client, frameNodeId, triggerCandidates[0].nodeId);

  const attempts = [];
  for (let round = 0; round < 3; round += 1) {
    triggerCandidates = await findFilterTriggerCandidates(client, frameNodeId);
    for (const trigger of triggerCandidates) {
      const triggerBox = await getNodeBox(client, trigger.nodeId);
      await clickNodeCenter(client, trigger.nodeId);
      attempts.push({
        selector: trigger.selector,
        node_id: trigger.nodeId,
        center: triggerBox.center
      });
      const panelNodeId = await waitForSelector(client, frameNodeId, RECOMMEND_FILTER_SELECTORS.panel, {
        timeoutMs: 2500,
        intervalMs: 200
      });
      if (panelNodeId) {
        return {
          trigger,
          trigger_box: triggerBox,
          panel_node_id: panelNodeId,
          initial_close_attempts: closeAttempts,
          open_attempts: attempts
        };
      }
    }
    await sleep(500);
  }

  throw new Error(`Recommend filter panel did not open after ${attempts.length} trigger attempts`);
}

async function readOptionNode(client, group, nodeId) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
  ]);
  const label = normalizeFilterOptionLabel(htmlToText(outerHTML));
  return {
    group,
    node_id: nodeId,
    label,
    active: isActiveOption(attributes, outerHTML),
    attributes: {
      class: attributes.class || "",
      value: attributes.value || "",
      type: attributes.type || ""
    }
  };
}

export async function listFilterOptions(client, frameNodeId, {
  groupOrder = RECOMMEND_FILTER_GROUP_ORDER
} = {}) {
  const options = [];
  for (const group of groupOrder) {
    const groupSelector = RECOMMEND_FILTER_SELECTORS.groups[group];
    if (!groupSelector) continue;
    const groupNodeIds = await querySelectorAll(client, frameNodeId, groupSelector);
    for (const groupNodeId of groupNodeIds) {
      const optionNodeIds = await querySelectorAll(client, groupNodeId, RECOMMEND_FILTER_SELECTORS.option);
      for (const optionNodeId of optionNodeIds) {
        options.push(await readOptionNode(client, group, optionNodeId));
      }
    }
  }
  return options;
}

async function clickFirstAvailableNode(client, nodeIds) {
  const errors = [];
  for (const nodeId of nodeIds) {
    try {
      const box = await clickNodeCenter(client, nodeId);
      return {
        clicked: true,
        node_id: nodeId,
        box
      };
    } catch (error) {
      errors.push({
        node_id: nodeId,
        message: error?.message || String(error)
      });
    }
  }
  return {
    clicked: false,
    errors
  };
}

function normalizeButtonLabel(label) {
  return normalizeFilterOptionLabel(label).toLowerCase();
}

function buttonRank(candidate) {
  const label = normalizeButtonLabel(candidate.label);
  if (/确定|确认|完成|ok|confirm/.test(label)) return 0;
  if (/重置|清空|取消|reset|cancel/.test(label)) return 2;
  return 1;
}

async function readButtonCandidate(client, nodeId, index) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
  ]);
  return {
    node_id: nodeId,
    index,
    label: normalizeButtonLabel(htmlToText(outerHTML)),
    class_name: attributes.class || ""
  };
}

async function readConfirmButtonCandidates(client, frameNodeId) {
  const nodeIds = await querySelectorAll(client, frameNodeId, RECOMMEND_FILTER_SELECTORS.confirmButton);
  const candidates = [];
  for (let index = 0; index < nodeIds.length; index += 1) {
    candidates.push(await readButtonCandidate(client, nodeIds[index], index));
  }
  return candidates.sort((left, right) => {
    const rankDiff = buttonRank(left) - buttonRank(right);
    if (rankDiff !== 0) return rankDiff;
    return right.index - left.index;
  });
}

export async function selectFirstSafeFilterOption(client, frameNodeId, {
  groupOrder = RECOMMEND_FILTER_GROUP_ORDER
} = {}) {
  const options = await listFilterOptions(client, frameNodeId, { groupOrder });
  const selected = chooseFirstSafeFilterOption(options, groupOrder);
  if (!selected) {
    throw new Error("No safe non-active recommend filter option was found");
  }

  const box = await clickNodeCenter(client, selected.node_id, { scrollIntoView: true });
  await sleep(300);

  return {
    selected_option: {
      group: selected.group,
      label: selected.label,
      node_id: selected.node_id,
      was_active: selected.active
    },
    option_box: box,
    discovered_options: options.map((option) => ({
      group: option.group,
      label: option.label,
      active: option.active,
      node_id: option.node_id
    }))
  };
}

export async function selectFilterOption(client, frameNodeId, {
  group = "",
  labels = [],
  groupOrder = RECOMMEND_FILTER_GROUP_ORDER
} = {}) {
  const options = await listFilterOptions(client, frameNodeId, { groupOrder });
  const selected = labels.length
    ? chooseFilterOptionByLabels(options, { group, labels })
    : chooseFirstSafeFilterOption(options, groupOrder);

  if (!selected) {
    const target = labels.length
      ? `${group || "any group"} / ${labels.join(", ")}`
      : "first safe non-active option";
    throw new Error(`No matching recommend filter option was found for ${target}`);
  }

  const box = await clickNodeCenter(client, selected.node_id, { scrollIntoView: true });
  await sleep(300);

  return {
    selected_option: {
      group: selected.group,
      label: selected.label,
      node_id: selected.node_id,
      was_active: selected.active,
      requested_group: group || null,
      requested_labels: labels
    },
    option_box: box,
    discovered_options: options.map((option) => ({
      group: option.group,
      label: option.label,
      active: option.active,
      node_id: option.node_id
    }))
  };
}

export async function selectFilterOptions(client, frameNodeId, {
  group = "",
  labels = [],
  groupOrder = RECOMMEND_FILTER_GROUP_ORDER
} = {}) {
  if (!labels.length) {
    return selectFilterOption(client, frameNodeId, { group, labels, groupOrder });
  }

  const selectedOptions = [];
  const missingLabels = [];
  let discoveredOptions = [];

  for (const label of labels) {
    if (await getFilterPanelCount(client, frameNodeId) === 0) {
      await openFilterPanel(client, frameNodeId);
    }

    const options = await listFilterOptions(client, frameNodeId, { groupOrder });
    discoveredOptions = options.map((option) => ({
      group: option.group,
      label: option.label,
      active: option.active,
      node_id: option.node_id
    }));
    const selected = chooseFilterOptionByLabels(options, { group, labels: [label] });
    const alreadyActive = options.find((option) => (
      (!group || option.group === group)
      && normalizeFilterOptionLabel(option.label) === normalizeFilterOptionLabel(label)
      && option.active
    ));

    if (alreadyActive) {
      selectedOptions.push({
        group: alreadyActive.group,
        label: alreadyActive.label,
        node_id: alreadyActive.node_id,
        was_active: true,
        clicked: false,
        requested_group: group || null
      });
      continue;
    }

    if (!selected) {
      missingLabels.push(label);
      continue;
    }

    const box = await clickNodeCenter(client, selected.node_id, { scrollIntoView: true });
    selectedOptions.push({
      group: selected.group,
      label: selected.label,
      node_id: selected.node_id,
      was_active: false,
      clicked: true,
      requested_group: group || null,
      option_box: box
    });
    await sleep(450);
  }

  if (missingLabels.length) {
    throw new Error(`No matching recommend filter options were found for ${group || "any group"} / ${missingLabels.join(", ")}`);
  }

  return {
    selected_option: selectedOptions[0] || null,
    selected_options: selectedOptions.map((option) => ({
      group: option.group,
      label: option.label,
      node_id: option.node_id,
      was_active: option.was_active,
      clicked: option.clicked,
      requested_group: option.requested_group,
      requested_labels: labels
    })),
    option_box: selectedOptions.find((option) => option.option_box)?.option_box || null,
    discovered_options: discoveredOptions
  };
}

export async function selectFilterGroups(client, frameNodeId, {
  filterGroups = [],
  groupOrder = RECOMMEND_FILTER_GROUP_ORDER
} = {}) {
  const selectedOptions = [];
  const discoveredOptions = [];
  const groups = filterGroups.filter((item) => item && (item.group || item.labels?.length));
  if (!groups.length) {
    return selectFilterOption(client, frameNodeId, { groupOrder });
  }

  for (const spec of groups) {
    const labels = Array.isArray(spec.labels) ? spec.labels : [];
    const selection = spec.selectAllLabels === false
      ? await selectFilterOption(client, frameNodeId, {
        group: spec.group || "",
        labels,
        groupOrder
      })
      : await selectFilterOptions(client, frameNodeId, {
        group: spec.group || "",
        labels,
        groupOrder
      });
    if (selection.selected_option) selectedOptions.push(selection.selected_option);
    for (const option of selection.selected_options || []) {
      selectedOptions.push(option);
    }
    for (const option of selection.discovered_options || []) {
      discoveredOptions.push(option);
    }
  }

  const dedupedSelected = [];
  const seenSelected = new Set();
  for (const option of selectedOptions) {
    const key = `${option.group || ""}:${normalizeFilterOptionLabel(option.label || "")}`;
    if (seenSelected.has(key)) continue;
    seenSelected.add(key);
    dedupedSelected.push(option);
  }

  return {
    selected_option: dedupedSelected[0] || null,
    selected_options: dedupedSelected,
    option_box: dedupedSelected.find((option) => option.option_box)?.option_box || null,
    discovered_options: discoveredOptions
  };
}

export async function confirmFilterPanel(client, frameNodeId, {
  timeoutMs = 8000
} = {}) {
  const candidates = await readConfirmButtonCandidates(client, frameNodeId);
  if (!candidates.length && await getFilterPanelCount(client, frameNodeId) === 0) {
    return {
      confirmed: true,
      confirm_node_id: null,
      confirm_label: "auto-closed",
      confirm_candidates: [],
      confirm_attempts: [],
      panel_count: 0
    };
  }
  if (!candidates.length) {
    throw new Error("Recommend filter confirm button was not found");
  }

  const attempts = [];
  for (const candidate of candidates) {
    const clickResult = await clickFirstAvailableNode(client, [candidate.node_id]);
    attempts.push({
      node_id: candidate.node_id,
      label: candidate.label,
      clicked: clickResult.clicked,
      errors: clickResult.errors
    });
    if (!clickResult.clicked) continue;

    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const panelCount = await getFilterPanelCount(client, frameNodeId);
      if (panelCount === 0) {
        return {
          confirmed: true,
          confirm_node_id: clickResult.node_id,
          confirm_label: candidate.label,
          confirm_box: clickResult.box,
          confirm_candidates: candidates,
          confirm_attempts: attempts,
          panel_count: 0
        };
      }
      await sleep(250);
    }
  }

  return {
    confirmed: false,
    confirm_node_id: attempts.at(-1)?.node_id || null,
    confirm_label: attempts.at(-1)?.label || null,
    confirm_candidates: candidates,
    confirm_attempts: attempts,
    panel_count: await getFilterPanelCount(client, frameNodeId)
  };
}

export async function selectAndConfirmFirstSafeFilter(client, frameNodeId, options = {}) {
  const beforeCounts = await getRecommendFilterCounts(client, frameNodeId);
  const openResult = await openFilterPanel(client, frameNodeId);
  const afterOpenCounts = await getRecommendFilterCounts(client, frameNodeId);
  const filterGroups = Array.isArray(options.filterGroups) ? options.filterGroups : [];
  const selection = filterGroups.length
    ? await selectFilterGroups(client, frameNodeId, { filterGroups, groupOrder: options.groupOrder })
    : options.selectAllLabels
    ? await selectFilterOptions(client, frameNodeId, options)
    : await selectFilterOption(client, frameNodeId, options);
  const confirm = await confirmFilterPanel(client, frameNodeId);
  await sleep(1200);
  const afterConfirmCounts = await getRecommendFilterCounts(client, frameNodeId);

  return {
    opened_panel: true,
    trigger: {
      node_id: openResult.trigger.nodeId,
      selector: openResult.trigger.selector,
      center: openResult.trigger_box.center,
      rect: openResult.trigger_box.rect
    },
    initial_close_attempts: openResult.initial_close_attempts,
    before_counts: beforeCounts,
    after_open_counts: afterOpenCounts,
    ...selection,
    ...confirm,
    after_confirm_counts: afterConfirmCounts
  };
}
