import {
  clickNodeCenter,
  DETERMINISTIC_CLICK_OPTIONS,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  pressKey,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import { htmlToText, normalizeText } from "../../core/screening/index.js";
import {
  RECOMMEND_CURRENT_CITY_ONLY_LABEL,
  RECOMMEND_LOCATION_SELECTORS
} from "./constants.js";

function normalizeControlText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function parseBooleanState(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on", "checked", "selected"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "unchecked", "unselected"].includes(normalized)) return false;
  return null;
}

function uniqueNodeIds(nodeIds = []) {
  return [...new Set(nodeIds.filter((nodeId) => Number(nodeId) > 0))];
}

async function getVisibleBox(client, nodeId) {
  try {
    const box = await getNodeBox(client, nodeId);
    if (box.rect.width <= 0 || box.rect.height <= 0) return null;
    return box;
  } catch {
    return null;
  }
}

function extractCityLabel(attributes = {}, outerHTML = "") {
  const cleanCityLabel = (value) => normalizeText(value).replace(/^仅看\s*/, "").trim();
  const attributeValue = [
    attributes["data-city"],
    attributes["data-name"],
    attributes.title,
    attributes["aria-label"]
  ].map(cleanCityLabel).find((value) => value && value.length <= 24);
  if (attributeValue) return attributeValue;
  const text = cleanCityLabel(htmlToText(outerHTML)).replace(/\s+/g, " ").trim();
  if (!text || text.length > 24 || text.includes(RECOMMEND_CURRENT_CITY_ONLY_LABEL)) return null;
  return text;
}

async function readLocationTriggerCandidate(client, nodeId, selector) {
  const [attributes, outerHTML, box] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId),
    getVisibleBox(client, nodeId)
  ]);
  if (!box) return null;
  const currentCityLabel = extractCityLabel(attributes, outerHTML);
  return {
    node_id: nodeId,
    selector,
    current_city_label: currentCityLabel,
    class_name: attributes.class || "",
    box
  };
}

export async function findRecommendLocationTrigger(client, frameNodeId) {
  const candidates = [];
  const seen = new Set();
  for (const selector of RECOMMEND_LOCATION_SELECTORS.trigger) {
    const nodeIds = await querySelectorAll(client, frameNodeId, selector);
    for (const nodeId of nodeIds) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      const candidate = await readLocationTriggerCandidate(client, nodeId, selector);
      if (candidate) candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => {
    const labelDiff = Number(Boolean(right.current_city_label)) - Number(Boolean(left.current_city_label));
    if (labelDiff !== 0) return labelDiff;
    return left.box.rect.width - right.box.rect.width;
  });
  return candidates[0] || null;
}

async function readAccessibilityCheckedState(client, nodeId) {
  if (typeof client?.Accessibility?.getPartialAXTree !== "function") return null;
  try {
    const result = await client.Accessibility.getPartialAXTree({
      nodeId,
      fetchRelatives: true
    });
    for (const node of result.nodes || []) {
      for (const property of node.properties || []) {
        if (property.name !== "checked") continue;
        const checked = parseBooleanState(property.value?.value);
        if (checked !== null) {
          return {
            checked,
            source: "accessibility.checked"
          };
        }
      }
    }
  } catch {
    // Attribute and verified class fallbacks remain CDP-only and cover custom controls.
  }
  return null;
}

function readAttributeCheckedState(attributes = {}, source = "attributes") {
  for (const key of ["aria-checked", "data-checked", "data-state"]) {
    if (!hasOwn(attributes, key)) continue;
    const checked = parseBooleanState(attributes[key]);
    if (checked !== null) return { checked, source: `${source}.${key}` };
  }
  if (hasOwn(attributes, "checked")) {
    return { checked: true, source: `${source}.checked` };
  }
  const className = String(attributes.class || "");
  if (/(?:^|\s)(?:is-checked|checked|selected)(?:\s|$)/i.test(className)) {
    return { checked: true, source: `${source}.class` };
  }
  if (/(?:^|\s)(?:is-unchecked|unchecked)(?:\s|$)/i.test(className)) {
    return { checked: false, source: `${source}.class` };
  }
  return null;
}

async function readCurrentCityCheckboxState(client, nodeId) {
  const nestedNodeIds = uniqueNodeIds(await querySelectorAll(
    client,
    nodeId,
    RECOMMEND_LOCATION_SELECTORS.checkboxInput
  ));
  const stateNodeIds = uniqueNodeIds([nodeId, ...nestedNodeIds]);
  for (const stateNodeId of stateNodeIds) {
    const accessibility = await readAccessibilityCheckedState(client, stateNodeId);
    if (accessibility) {
      return {
        ...accessibility,
        state_node_id: stateNodeId,
        input_node_ids: nestedNodeIds
      };
    }
  }
  const attributesByNode = [];
  for (const stateNodeId of stateNodeIds) {
    const attributes = await getAttributesMap(client, stateNodeId);
    attributesByNode.push({ node_id: stateNodeId, attributes });
    const state = readAttributeCheckedState(attributes, `node_${stateNodeId}`);
    if (state) {
      return {
        ...state,
        state_node_id: stateNodeId,
        input_node_ids: nestedNodeIds
      };
    }
  }
  const checkboxInput = attributesByNode.find(({ attributes }) => (
    String(attributes.type || "").toLowerCase() === "checkbox"
    || String(attributes.role || "").toLowerCase() === "checkbox"
  ));
  if (checkboxInput) {
    return {
      checked: false,
      source: `node_${checkboxInput.node_id}.unchecked_input`,
      state_node_id: checkboxInput.node_id,
      input_node_ids: nestedNodeIds
    };
  }
  const wrapper = attributesByNode[0]?.attributes || {};
  if (/(?:^|\s)(?:checkbox|check-box)(?:\s|$)/i.test(String(wrapper.class || ""))) {
    return {
      checked: false,
      source: `node_${nodeId}.unchecked_class`,
      state_node_id: nodeId,
      input_node_ids: nestedNodeIds
    };
  }
  return {
    checked: null,
    source: "unreadable",
    state_node_id: null,
    input_node_ids: nestedNodeIds
  };
}

async function readCurrentCityControlCandidates(client, nodeIds) {
  const matchingCandidates = [];
  for (const nodeId of nodeIds) {
    let outerHTML;
    try {
      outerHTML = await getOuterHTML(client, nodeId);
    } catch {
      continue;
    }
    const label = normalizeControlText(htmlToText(outerHTML));
    if (!label.includes(normalizeControlText(RECOMMEND_CURRENT_CITY_ONLY_LABEL))) continue;
    const box = await getVisibleBox(client, nodeId);
    if (!box) continue;
    const state = await readCurrentCityCheckboxState(client, nodeId);
    matchingCandidates.push({
      node_id: nodeId,
      label,
      exact_label: label === normalizeControlText(RECOMMEND_CURRENT_CITY_ONLY_LABEL),
      box,
      state
    });
  }
  matchingCandidates.sort((left, right) => {
    const readableDiff = Number(right.state.checked !== null) - Number(left.state.checked !== null);
    if (readableDiff !== 0) return readableDiff;
    const exactDiff = Number(right.exact_label) - Number(left.exact_label);
    if (exactDiff !== 0) return exactDiff;
    return left.label.length - right.label.length;
  });
  return matchingCandidates;
}

export async function findRecommendCurrentCityControl(client, frameNodeId) {
  const calibratedNodeIds = uniqueNodeIds(await querySelectorAll(
    client,
    frameNodeId,
    RECOMMEND_LOCATION_SELECTORS.checkboxCalibrated
  ));
  let matchingCandidates = await readCurrentCityControlCandidates(client, calibratedNodeIds);
  if (!matchingCandidates.length) {
    const fallbackNodeIds = uniqueNodeIds(await querySelectorAll(
      client,
      frameNodeId,
      RECOMMEND_LOCATION_SELECTORS.checkboxCandidates
    ));
    matchingCandidates = await readCurrentCityControlCandidates(client, fallbackNodeIds);
  }
  if (!matchingCandidates.length) return null;
  const best = matchingCandidates[0];
  return {
    ...best,
    visible: true,
    readable: best.state.checked !== null,
    matching_candidate_count: matchingCandidates.length
  };
}

async function getControlAncestorNodeIds(client, nodeId, frameNodeId, maxDepth = 10) {
  const ancestors = [];
  let currentNodeId = nodeId;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const described = await client.DOM.describeNode({
      nodeId: currentNodeId,
      depth: 0,
      pierce: true
    });
    const parentId = described.node?.parentId || 0;
    if (!parentId || parentId === frameNodeId) break;
    ancestors.push(parentId);
    currentNodeId = parentId;
  }
  return uniqueNodeIds(ancestors);
}

async function findExactLocationConfirmCandidates(client, frameNodeId, {
  controlNodeId
} = {}) {
  if (!controlNodeId) return [];
  const popoverNodeIds = uniqueNodeIds(await querySelectorAll(
    client,
    frameNodeId,
    RECOMMEND_LOCATION_SELECTORS.popoverCandidates
  ));
  for (const popoverNodeId of popoverNodeIds) {
    const popoverHTML = await getOuterHTML(client, popoverNodeId);
    if (!normalizeControlText(htmlToText(popoverHTML)).includes(
      normalizeControlText(RECOMMEND_CURRENT_CITY_ONLY_LABEL)
    )) continue;
    const nodeIds = uniqueNodeIds(await querySelectorAll(
      client,
      popoverNodeId,
      RECOMMEND_LOCATION_SELECTORS.confirmCandidates
    ));
    const candidates = [];
    for (const nodeId of nodeIds) {
      const outerHTML = await getOuterHTML(client, nodeId);
      const label = normalizeControlText(htmlToText(outerHTML));
      if (label !== normalizeControlText("确认")) continue;
      const box = await getVisibleBox(client, nodeId);
      if (!box) continue;
      candidates.push({
        node_id: nodeId,
        label: "确认",
        box,
        scope_node_id: popoverNodeId
      });
    }
    if (candidates.length) return candidates;
  }
  const ancestorNodeIds = await getControlAncestorNodeIds(client, controlNodeId, frameNodeId);
  for (const ancestorNodeId of ancestorNodeIds) {
    const nodeIds = uniqueNodeIds(await querySelectorAll(
      client,
      ancestorNodeId,
      RECOMMEND_LOCATION_SELECTORS.confirmCandidates
    ));
    const candidates = [];
    for (const nodeId of nodeIds) {
      const outerHTML = await getOuterHTML(client, nodeId);
      const label = normalizeControlText(htmlToText(outerHTML));
      if (label !== normalizeControlText("确认")) continue;
      const box = await getVisibleBox(client, nodeId);
      if (!box) continue;
      candidates.push({
        node_id: nodeId,
        label: "确认",
        box,
        scope_node_id: ancestorNodeId
      });
    }
    if (candidates.length) return candidates;
  }
  return [];
}

async function waitForCurrentCityControl(client, frameNodeId, {
  timeoutMs = 1800,
  intervalMs = 150
} = {}) {
  const started = Date.now();
  while (true) {
    const control = await findRecommendCurrentCityControl(client, frameNodeId);
    if (control) return control;
    if (Date.now() - started >= timeoutMs) break;
    if (intervalMs > 0) await sleep(intervalMs);
  }
  return null;
}

async function findVisibleRecommendLocationPopover(client, frameNodeId) {
  const nodeIds = uniqueNodeIds(await querySelectorAll(
    client,
    frameNodeId,
    RECOMMEND_LOCATION_SELECTORS.popoverCandidates
  ));
  for (const nodeId of nodeIds) {
    const box = await getVisibleBox(client, nodeId);
    if (box) return { node_id: nodeId, box };
  }
  return null;
}

async function waitForRecommendLocationPopoverState(client, frameNodeId, {
  timeoutMs = 1800,
  intervalMs = 150
} = {}) {
  const started = Date.now();
  let popover = null;
  while (true) {
    const control = await findRecommendCurrentCityControl(client, frameNodeId);
    if (control) return { opened: true, control, popover };
    popover = await findVisibleRecommendLocationPopover(client, frameNodeId) || popover;
    if (Date.now() - started >= timeoutMs) break;
    if (intervalMs > 0) await sleep(intervalMs);
  }
  return {
    opened: Boolean(popover),
    control: null,
    popover
  };
}

async function openRecommendLocationPopover(client, frameNodeId, {
  timeoutMs = 1800,
  intervalMs = 150,
  attemptsLimit = 3
} = {}) {
  const attempts = [];
  const alreadyOpenControl = await findRecommendCurrentCityControl(client, frameNodeId);
  if (alreadyOpenControl) {
    const trigger = await findRecommendLocationTrigger(client, frameNodeId);
    return {
      opened: true,
      already_open: true,
      trigger,
      control: alreadyOpenControl,
      attempts,
      reason: "control_already_open"
    };
  }
  const alreadyOpenPopover = await findVisibleRecommendLocationPopover(client, frameNodeId);
  if (alreadyOpenPopover) {
    const state = await waitForRecommendLocationPopoverState(client, frameNodeId, {
      timeoutMs,
      intervalMs
    });
    const trigger = await findRecommendLocationTrigger(client, frameNodeId);
    return {
      opened: true,
      already_open: true,
      trigger,
      control: state.control,
      popover: state.popover || alreadyOpenPopover,
      attempts,
      reason: state.control ? "control_already_open" : "popover_already_open_without_control"
    };
  }
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    const trigger = await findRecommendLocationTrigger(client, frameNodeId);
    if (!trigger) {
      return {
        opened: false,
        trigger: null,
        control: null,
        attempts,
        reason: "location_trigger_unavailable"
      };
    }
    try {
      const click = await clickNodeCenter(client, trigger.node_id, DETERMINISTIC_CLICK_OPTIONS);
      const state = await waitForRecommendLocationPopoverState(client, frameNodeId, {
        timeoutMs,
        intervalMs
      });
      attempts.push({
        attempt,
        trigger_node_id: trigger.node_id,
        trigger_selector: trigger.selector,
        clicked: true,
        click_target: click.click_target,
        popover_found: Boolean(state.popover),
        control_found: Boolean(state.control)
      });
      if (state.opened) {
        return {
          opened: true,
          trigger,
          control: state.control,
          popover: state.popover,
          attempts,
          reason: state.control ? "control_found" : "control_unavailable"
        };
      }
    } catch (error) {
      attempts.push({
        attempt,
        trigger_node_id: trigger.node_id,
        trigger_selector: trigger.selector,
        clicked: false,
        error: error?.message || String(error)
      });
      if (typeof client?.Input?.dispatchKeyEvent === "function") {
        await pressKey(client, "Escape", {
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27
        });
        attempts.at(-1).recovery = "Escape";
      }
    }
  }
  return {
    opened: false,
    trigger: null,
    control: null,
    attempts,
    reason: "location_popover_did_not_open"
  };
}

async function confirmRecommendLocationPopover(client, frameNodeId, {
  timeoutMs = 1800,
  intervalMs = 150,
  controlNodeId,
  stableCloseMs = 300
} = {}) {
  const candidates = await findExactLocationConfirmCandidates(client, frameNodeId, { controlNodeId });
  if (!candidates.length) {
    throw new Error("Recommend location exact 确认 button was not found");
  }
  const clickErrors = [];
  for (const candidate of candidates) {
    let box;
    try {
      box = await clickNodeCenter(client, candidate.node_id, DETERMINISTIC_CLICK_OPTIONS);
    } catch (error) {
      clickErrors.push({
        node_id: candidate.node_id,
        message: error?.message || String(error)
      });
      continue;
    }

    const started = Date.now();
    const requiredStableCloseMs = Math.max(0, Number(stableCloseMs) || 0);
    let absentSince = null;
    let absentObservations = 0;
    let lastObservation = null;
    while (Date.now() - started <= timeoutMs) {
      try {
        const [control, popover] = await Promise.all([
          findRecommendCurrentCityControl(client, frameNodeId),
          findVisibleRecommendLocationPopover(client, frameNodeId)
        ]);
        const observedAt = Date.now();
        lastObservation = {
          control_visible: Boolean(control),
          popover_visible: Boolean(popover),
          observed_after_ms: observedAt - started
        };
        if (!control && !popover) {
          absentSince ??= observedAt;
          absentObservations += 1;
          if (observedAt - absentSince >= requiredStableCloseMs) {
            return {
              confirmed: true,
              label: "确认",
              node_id: candidate.node_id,
              box,
              stable_close_ms: observedAt - absentSince,
              stable_close_observations: absentObservations,
              control_absent: true,
              popover_invisible: true
            };
          }
        } else {
          absentSince = null;
          absentObservations = 0;
        }
      } catch (error) {
        const uncertain = new Error("Recommend location popover close state was uncertain after exact 确认 click");
        uncertain.cause = error;
        uncertain.confirm_node_id = candidate.node_id;
        uncertain.last_observation = lastObservation;
        throw uncertain;
      }
      if (intervalMs > 0) await sleep(intervalMs);
    }

    const error = new Error("Recommend location popover did not close after exact 确认 click");
    error.confirm_node_id = candidate.node_id;
    error.last_observation = lastObservation;
    error.stable_close_ms = absentSince === null ? 0 : Date.now() - absentSince;
    error.stable_close_observations = absentObservations;
    error.click_errors = clickErrors;
    throw error;
  }
  const error = new Error("Recommend location popover did not close after exact 确认 click");
  error.click_errors = clickErrors;
  throw error;
}

async function clickCurrentCityControl(client, control) {
  const candidates = uniqueNodeIds([
    control.node_id,
    ...(control.state.input_node_ids || [])
  ]);
  const errors = [];
  for (const nodeId of candidates) {
    try {
      const box = await clickNodeCenter(client, nodeId, DETERMINISTIC_CLICK_OPTIONS);
      return { clicked: true, node_id: nodeId, box };
    } catch (error) {
      errors.push({ node_id: nodeId, message: error?.message || String(error) });
    }
  }
  const error = new Error("Recommend current-city checkbox could not be clicked");
  error.click_errors = errors;
  throw error;
}

function compactControlState(control) {
  if (!control) return null;
  return {
    checked: control.state.checked,
    state_source: control.state.source,
    node_id: control.node_id,
    state_node_id: control.state.state_node_id
  };
}

function isStaleLocationNodeError(error) {
  return /Could not find node|Could not compute box model|No node with given id|stale/i.test(
    String(error?.message || "")
  );
}

function unavailableResult({ requested, currentCityLabel, reason, attempts }) {
  return {
    requested,
    effective: false,
    available: false,
    unavailable: true,
    reason,
    clicked: false,
    current_city_label: currentCityLabel || null,
    before: null,
    after_toggle: null,
    confirmation: null,
    sticky_verification: {
      verified: true,
      expected: false,
      actual: null,
      unavailable: true,
      state_source: "control_unavailable",
      close_confirmation: null
    },
    attempts
  };
}

export async function ensureRecommendCurrentCityOnly(client, frameNodeId, {
  enabled = false,
  timeoutMs = 1800,
  intervalMs = 150,
  attemptsLimit = 2,
  openAttemptsLimit = 3,
  settleMs = 250,
  closeStableMs = 300
} = {}) {
  const requested = enabled === true;
  const attempts = [];
  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    try {
      const opened = await openRecommendLocationPopover(client, frameNodeId, {
        timeoutMs,
        intervalMs,
        attemptsLimit: openAttemptsLimit
      });
      const currentCityLabel = opened.trigger?.current_city_label || null;
      attempts.push({
        attempt,
        opened: opened.opened,
        reason: opened.reason,
        open_attempts: opened.attempts
      });
      if (!opened.opened) {
        if (!requested && opened.reason === "location_trigger_unavailable") {
          return unavailableResult({
            requested,
            currentCityLabel,
            reason: "location_trigger_unavailable",
            attempts
          });
        }
        throw new Error(`Recommend location popover could not be opened: ${opened.reason}`);
      }
      if (!opened.control) {
        if (typeof client?.Input?.dispatchKeyEvent === "function") {
          await pressKey(client, "Escape", {
            code: "Escape",
            windowsVirtualKeyCode: 27,
            nativeVirtualKeyCode: 27
          });
          attempts.at(-1).unavailable_close = "Escape";
        }
        if (!requested) {
          return unavailableResult({
            requested,
            currentCityLabel,
            reason: "current_city_control_unavailable",
            attempts
          });
        }
        throw new Error("Recommend current-city checkbox is unavailable for an enabled request");
      }
      if (!opened.control.readable) {
        throw new Error("Recommend current-city checkbox is visible but its state is unreadable");
      }

      const before = compactControlState(opened.control);
      let clicked = false;
      let clickEvidence = null;
      let afterToggleControl = opened.control;
      if (opened.control.state.checked !== requested) {
        clickEvidence = await clickCurrentCityControl(client, opened.control);
        clicked = true;
        afterToggleControl = await waitForCurrentCityControl(client, frameNodeId, { timeoutMs, intervalMs });
        if (!afterToggleControl?.readable || afterToggleControl.state.checked !== requested) {
          throw new Error("Recommend current-city checkbox did not reach the requested state after click");
        }
      }
      const afterToggle = compactControlState(afterToggleControl);
      const confirmation = await confirmRecommendLocationPopover(client, frameNodeId, {
        timeoutMs,
        intervalMs,
        controlNodeId: afterToggleControl.node_id,
        stableCloseMs: closeStableMs
      });
      if (!confirmation.confirmed) {
        throw new Error("Recommend location state was not confirmed");
      }
      if (settleMs > 0) await sleep(settleMs);

      const reopened = await openRecommendLocationPopover(client, frameNodeId, {
        timeoutMs,
        intervalMs,
        attemptsLimit: openAttemptsLimit
      });
      if (!reopened.opened || !reopened.control) {
        throw new Error("Recommend current-city checkbox was unavailable during sticky verification");
      }
      if (!reopened.control.readable) {
        throw new Error("Recommend current-city checkbox was visible but unreadable during sticky verification");
      }
      const actual = reopened.control.state.checked;
      const stickyClose = await confirmRecommendLocationPopover(client, frameNodeId, {
        timeoutMs,
        intervalMs,
        controlNodeId: reopened.control.node_id,
        stableCloseMs: closeStableMs
      });
      if (!stickyClose.confirmed) {
        throw new Error("Recommend location sticky verification was not confirmed");
      }
      const stickyVerification = {
        verified: actual === requested,
        expected: requested,
        actual,
        unavailable: false,
        state_source: reopened.control.state.source,
        close_confirmation: {
          confirmed: stickyClose.confirmed,
          label: stickyClose.label,
          node_id: stickyClose.node_id
        }
      };
      if (!stickyVerification.verified) {
        const error = new Error("Recommend current-city checkbox failed sticky verification");
        error.sticky_verification = stickyVerification;
        throw error;
      }
      attempts.at(-1).click = clickEvidence
        ? { clicked: true, node_id: clickEvidence.node_id }
        : { clicked: false, reason: "already_in_requested_state" };
      attempts.at(-1).verified = true;
      return {
        requested,
        effective: actual,
        available: true,
        unavailable: false,
        reason: clicked ? "state_updated" : "already_in_requested_state",
        clicked,
        current_city_label: currentCityLabel,
        before,
        after_toggle: afterToggle,
        confirmation: {
          confirmed: confirmation.confirmed,
          label: confirmation.label,
          node_id: confirmation.node_id
        },
        sticky_verification: stickyVerification,
        attempts
      };
    } catch (error) {
      attempts.push({
        attempt,
        error: error?.message || String(error),
        stale_node: isStaleLocationNodeError(error)
      });
      if (!isStaleLocationNodeError(error) || attempt >= attemptsLimit) throw error;
      if (typeof client?.Input?.dispatchKeyEvent === "function") {
        await pressKey(client, "Escape", {
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27
        });
      }
      if (settleMs > 0) await sleep(settleMs);
    }
  }
  throw new Error("Recommend current-city checkbox state was not ensured");
}
