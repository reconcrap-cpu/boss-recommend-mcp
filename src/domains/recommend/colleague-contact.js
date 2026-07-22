import {
  clickNodeCenter,
  describeNode,
  getFrameDocumentNodeId,
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import { htmlToText } from "../../core/screening/index.js";

const COLLEAGUE_SECTION_SELECTOR = ".colleague-collaboration";
const SECTION_SELECTED_TAB_SELECTOR = ".tab-hd .selected";
const TAB_CANDIDATE_SELECTOR = ".tab-hd > span, .tab-hd > div, .tab-hd > button, .tab-hd > li";
const SECTION_ROW_SELECTOR = ".record-item.mate-log-item";
const SECTION_ROW_CONTENT_SELECTOR = ".record-item.mate-log-item .content";
const DETAIL_PANE_SELECTOR = ".resume-item-detail";

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dateOnly(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(left, right) {
  const leftDate = dateOnly(left);
  const rightDate = dateOnly(right);
  if (!leftDate || !rightDate) return null;
  return Math.floor((leftDate.getTime() - rightDate.getTime()) / 86400000);
}

function formatLocalDate(date) {
  const parsed = dateOnly(date);
  if (!parsed) return null;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function makeDate(year, month, day) {
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
  ) {
    return null;
  }
  return parsed;
}

export function parseColleagueContactDate(text, {
  referenceDate = new Date()
} = {}) {
  const raw = normalizeText(text);
  if (!raw) return null;
  const today = dateOnly(referenceDate) || dateOnly(new Date());
  if (/(?:刚刚|刚才)/.test(raw)) return today;
  const relativeDays = raw.match(/(\d+)\s*天前/);
  if (relativeDays) {
    const days = Number.parseInt(relativeDays[1], 10);
    if (Number.isFinite(days) && days >= 0) {
      const date = new Date(today);
      date.setDate(date.getDate() - days);
      return date;
    }
  }
  if (/今天/.test(raw)) return today;
  if (/昨天/.test(raw)) {
    const date = new Date(today);
    date.setDate(date.getDate() - 1);
    return date;
  }
  if (/前天/.test(raw)) {
    const date = new Date(today);
    date.setDate(date.getDate() - 2);
    return date;
  }

  const full = raw.match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/);
  if (full) {
    return makeDate(
      Number.parseInt(full[1], 10),
      Number.parseInt(full[2], 10),
      Number.parseInt(full[3], 10)
    );
  }

  const partial = raw.match(/(?:^|\D)(\d{1,2})[.\-\/](\d{1,2})(?:\D|$)/);
  if (partial) {
    const reference = dateOnly(referenceDate) || new Date();
    let date = makeDate(
      reference.getFullYear(),
      Number.parseInt(partial[1], 10),
      Number.parseInt(partial[2], 10)
    );
    if (date && daysBetween(date, reference) > 7) {
      date = makeDate(
        reference.getFullYear() - 1,
        Number.parseInt(partial[1], 10),
        Number.parseInt(partial[2], 10)
      );
    }
    return date;
  }

  return null;
}

export function isDateWithinWindow(date, {
  referenceDate = new Date(),
  windowDays = 14
} = {}) {
  const diff = daysBetween(referenceDate, date);
  return Number.isFinite(diff) && diff >= 0 && diff <= windowDays;
}

async function textForNode(client, nodeId) {
  return htmlToText(await getOuterHTML(client, nodeId));
}

async function queryAcrossRoots(client, roots, selector) {
  const matches = [];
  for (const root of roots || []) {
    if (!root?.nodeId) continue;
    const nodeIds = await querySelectorAll(client, root.nodeId, selector);
    for (const nodeId of nodeIds) {
      matches.push({
        root: root.name,
        root_node_id: root.nodeId,
        selector,
        node_id: nodeId
      });
    }
  }
  return matches;
}

function tabIsColleague(text) {
  return normalizeText(text) === "同事沟通进度";
}

function isUsableVisibleRowBox(box) {
  return Number(box?.rect?.width || 0) > 2 && Number(box?.rect?.height || 0) > 2;
}

async function readVisibleNodeEvidence(client, nodeId) {
  let box = null;
  try {
    box = await getNodeBox(client, nodeId);
  } catch {
    return null;
  }
  if (!isUsableVisibleRowBox(box)) return null;
  const node = await describeNode(client, nodeId, { depth: 0, pierce: true });
  if (!Number.isInteger(node?.backendNodeId) || node.backendNodeId <= 0) return null;
  return {
    node_id: nodeId,
    backend_node_id: node.backendNodeId,
    box: {
      x: box.rect.x,
      y: box.rect.y,
      width: box.rect.width,
      height: box.rect.height
    }
  };
}

async function readSelectedColleagueTab(client, sectionNodeId) {
  const selectedIds = await querySelectorAll(client, sectionNodeId, SECTION_SELECTED_TAB_SELECTOR);
  const visibleSelected = [];
  for (const nodeId of selectedIds) {
    const evidence = await readVisibleNodeEvidence(client, nodeId);
    if (!evidence) continue;
    visibleSelected.push({
      ...evidence,
      text: normalizeText(await textForNode(client, nodeId))
    });
  }
  const selected = visibleSelected.length === 1 && tabIsColleague(visibleSelected[0].text);
  return {
    selected,
    selected_text: visibleSelected[0]?.text || "",
    selected_tab_count: visibleSelected.length,
    node_id: visibleSelected[0]?.node_id || null,
    backend_node_id: visibleSelected[0]?.backend_node_id || null,
    box: visibleSelected[0]?.box || null
  };
}

async function ensureColleagueTabSelected(client, sectionNodeId) {
  const before = await readSelectedColleagueTab(client, sectionNodeId);
  if (before.selected) {
    return {
      ...before,
      changed: false
    };
  }

  const candidateIds = await querySelectorAll(client, sectionNodeId, TAB_CANDIDATE_SELECTOR);
  for (const nodeId of candidateIds) {
    const evidence = await readVisibleNodeEvidence(client, nodeId);
    if (!evidence) continue;
    const text = normalizeText(await textForNode(client, nodeId));
    if (!tabIsColleague(text)) continue;
    const box = await clickNodeCenter(client, nodeId, { scrollIntoView: true });
    await sleep(500);
    const after = await readSelectedColleagueTab(client, sectionNodeId);
    return {
      ...after,
      changed: true,
      click_box: {
        rect: box.rect,
        center: box.center
      },
      reason: after.selected ? null : "colleague_tab_selection_not_verified"
    };
  }

  return {
    ...before,
    changed: false,
    reason: "colleague_tab_candidate_not_visible"
  };
}

async function readContactRows(client, sectionNodeId, sectionBackendNodeId, sectionRoot = "") {
  const contentNodeIds = await querySelectorAll(client, sectionNodeId, SECTION_ROW_CONTENT_SELECTOR);
  const fallbackNodeIds = contentNodeIds.length
    ? []
    : await querySelectorAll(client, sectionNodeId, SECTION_ROW_SELECTOR);
  const nodeIds = contentNodeIds.length ? contentNodeIds : fallbackNodeIds;
  const rows = [];
  const unreadableRows = [];
  const seen = new Set();
  for (const nodeId of nodeIds) {
    let box = null;
    try {
      box = await getNodeBox(client, nodeId);
    } catch (error) {
      unreadableRows.push({
        node_id: nodeId,
        stage: "box",
        error: error?.message || String(error)
      });
      continue;
    }
    if (!isUsableVisibleRowBox(box)) {
      unreadableRows.push({
        node_id: nodeId,
        stage: "visible_box"
      });
      continue;
    }
    const node = await describeNode(client, nodeId, { depth: 0, pierce: true });
    if (!Number.isInteger(node?.backendNodeId) || node.backendNodeId <= 0) {
      unreadableRows.push({
        node_id: nodeId,
        stage: "backend_identity"
      });
      continue;
    }
    const text = normalizeText(await textForNode(client, nodeId));
    if (!text) {
      unreadableRows.push({
        node_id: nodeId,
        backend_node_id: node.backendNodeId,
        stage: "text"
      });
      continue;
    }
    if (seen.has(text)) continue;
    seen.add(text);
    rows.push({
      text,
      root: sectionRoot,
      selector: contentNodeIds.length ? SECTION_ROW_CONTENT_SELECTOR : SECTION_ROW_SELECTOR,
      node_id: nodeId,
      backend_node_id: node.backendNodeId,
      section_node_id: sectionNodeId,
      section_backend_node_id: sectionBackendNodeId,
      visible: true,
      box: {
        x: box.rect.x,
        y: box.rect.y,
        width: box.rect.width,
        height: box.rect.height
      }
    });
  }
  return {
    rows,
    unreadable_rows: unreadableRows
  };
}

function paneBindingMatches(sectionEvidence, selectedEvidence, section, tab) {
  return Boolean(
    sectionEvidence
    && sectionEvidence.backend_node_id === section.backend_node_id
    && selectedEvidence?.selected === true
    && selectedEvidence.selected_tab_count === 1
    && selectedEvidence.node_id === tab.node_id
    && selectedEvidence.backend_node_id === tab.backend_node_id
  );
}

async function readPaneBindingAtPosition(client, section, tab) {
  const sectionEvidence = await readVisibleNodeEvidence(client, section.node_id);
  const selectedEvidence = await readSelectedColleagueTab(client, section.node_id);
  return {
    verified: paneBindingMatches(sectionEvidence, selectedEvidence, section, tab),
    section_visible: Boolean(sectionEvidence),
    section_node_id: section.node_id,
    section_backend_node_id: sectionEvidence?.backend_node_id || null,
    selected_tab_node_id: selectedEvidence.node_id || null,
    selected_tab_backend_node_id: selectedEvidence.backend_node_id || null,
    selected_tab_text: selectedEvidence.selected_text,
    selected_tab_count: selectedEvidence.selected_tab_count
  };
}

async function resolveBoundScrollTarget(client, scopes, section) {
  const sectionScope = (scopes || []).find((scope) => (
    scope?.name === section.root
    && scope?.nodeId === section.root_node_id
  ));
  const detailPanes = sectionScope
    ? await queryAcrossRoots(client, [sectionScope], DETAIL_PANE_SELECTOR)
    : [];
  const visiblePanes = [];
  for (const pane of detailPanes) {
    const evidence = await readVisibleNodeEvidence(client, pane.node_id);
    if (!evidence) continue;
    visiblePanes.push({
      ...pane,
      ...evidence
    });
  }
  if (visiblePanes.length > 1) {
    return {
      ok: false,
      reason: "scroll_target_ambiguous",
      visible_target_count: visiblePanes.length
    };
  }
  if (visiblePanes.length === 1) {
    return {
      ok: true,
      node_id: visiblePanes[0].node_id,
      backend_node_id: visiblePanes[0].backend_node_id,
      selector: visiblePanes[0].selector,
      box: visiblePanes[0].box
    };
  }
  const sectionEvidence = await readVisibleNodeEvidence(client, section.node_id);
  if (!sectionEvidence || sectionEvidence.backend_node_id !== section.backend_node_id) {
    return {
      ok: false,
      reason: "scroll_target_box_unavailable",
      visible_target_count: 0
    };
  }
  return {
    ok: true,
    node_id: section.node_id,
    backend_node_id: section.backend_node_id,
    selector: COLLEAGUE_SECTION_SELECTOR,
    box: sectionEvidence.box
  };
}

function addRowsFromPosition(byText, positionRows, positionIndex) {
  for (const row of positionRows) {
    const existing = byText.get(row.text);
    if (existing) {
      if (!existing.observed_at_positions.includes(positionIndex)) {
        existing.observed_at_positions.push(positionIndex);
      }
      continue;
    }
    byText.set(row.text, {
      ...row,
      observed_at_positions: [positionIndex]
    });
  }
}

async function scanContactRowsAcrossScrollPositions(client, scopes, section, tab, {
  enabled = true,
  maxScrolls = 24,
  settleMs = 350
} = {}) {
  const stableEndSamplesRequired = 2;
  const boundedMaxScrolls = enabled
    ? Math.max(
      stableEndSamplesRequired,
      Math.min(48, Number.isFinite(Number(maxScrolls)) ? Math.floor(Number(maxScrolls)) : 24)
    )
    : 0;
  const scrollTarget = enabled
    ? await resolveBoundScrollTarget(client, scopes, section)
    : null;
  if (enabled && !scrollTarget?.ok) {
    return {
      completed: false,
      coverage_verified: false,
      reason: scrollTarget?.reason || "scroll_target_box_unavailable",
      scrolls_requested: boundedMaxScrolls,
      scrolls_completed: 0,
      position_count: 0,
      positions: [],
      rows: []
    };
  }

  const rowsByText = new Map();
  const positions = [];
  let scrollsCompleted = 0;
  let previousRowSignature = null;
  let previousRowLayoutSignature = null;
  let stableSignatureCount = 0;
  let effectiveScrollCount = 0;
  let endProof = null;
  const targetHeight = Number(scrollTarget?.box?.height || 0);
  const stepDeltaY = enabled
    ? Math.max(1, Math.min(480, Math.floor(targetHeight * 0.65)))
    : 0;

  for (let positionIndex = 0; positionIndex <= boundedMaxScrolls; positionIndex += 1) {
    const bindingBefore = await readPaneBindingAtPosition(client, section, tab);
    if (!bindingBefore.verified) {
      return {
        completed: false,
        coverage_verified: false,
        reason: "colleague_binding_lost",
        scrolls_requested: boundedMaxScrolls,
        scrolls_completed: scrollsCompleted,
        position_count: positions.length,
        positions,
        rows: [],
        failed_position: positionIndex,
        failed_binding_phase: "before_rows",
        binding: bindingBefore
      };
    }

    const positionRead = await readContactRows(
      client,
      section.node_id,
      section.backend_node_id,
      section.root
    );
    const positionRows = positionRead.rows;
    const bindingAfter = await readPaneBindingAtPosition(client, section, tab);
    const rowIdentityKeys = positionRows
      .map((row) => `${row.backend_node_id}:${row.text}`)
      .sort();
    const rowTexts = positionRows.map((row) => row.text).sort();
    const rowSignature = JSON.stringify(rowIdentityKeys);
    const orderedRows = positionRows
      .map((row) => ({
        backend_node_id: row.backend_node_id,
        text: row.text,
        x: Math.round(Number(row?.box?.x || 0)),
        y: Math.round(Number(row?.box?.y || 0)),
        width: Math.round(Number(row?.box?.width || 0)),
        height: Math.round(Number(row?.box?.height || 0))
      }))
      .sort((left, right) => (
        left.y - right.y
        || left.x - right.x
        || left.backend_node_id - right.backend_node_id
      ));
    const rowLayoutKeys = orderedRows.map((row) => (
      `${row.text}:${row.x}:${row.y}:${row.width}:${row.height}`
    ));
    const rowLayoutSignature = JSON.stringify(rowLayoutKeys);
    const newRowTexts = rowTexts.filter((text) => !rowsByText.has(text));
    const scrollEffectObserved = Boolean(
      scrollsCompleted > 0
      && rowLayoutSignature !== previousRowLayoutSignature
    );
    if (scrollEffectObserved) effectiveScrollCount += 1;
    if (
      scrollsCompleted > 0
      && rowSignature === previousRowSignature
      && newRowTexts.length === 0
    ) {
      stableSignatureCount += 1;
    } else {
      stableSignatureCount = 0;
    }
    const positionEvidence = {
      position_index: positionIndex,
      sampled_after_scroll_count: scrollsCompleted,
      row_count: positionRows.length,
      unreadable_row_count: positionRead.unreadable_rows.length,
      row_backend_node_ids: positionRows.map((row) => row.backend_node_id),
      row_texts: rowTexts,
      row_identity_keys: rowIdentityKeys,
      row_signature: rowSignature,
      ordered_row_layout: orderedRows,
      ordered_row_layout_keys: rowLayoutKeys,
      row_layout_signature: rowLayoutSignature,
      scroll_effect_observed: scrollEffectObserved,
      cumulative_effective_scroll_count: effectiveScrollCount,
      new_row_count: newRowTexts.length,
      new_row_texts: newRowTexts,
      stable_signature_count: stableSignatureCount,
      binding_before_verified: bindingBefore.verified,
      binding_after_verified: bindingAfter.verified
    };
    positions.push(positionEvidence);
    if (!bindingAfter.verified) {
      return {
        completed: false,
        coverage_verified: false,
        reason: "colleague_binding_lost",
        scrolls_requested: boundedMaxScrolls,
        scrolls_completed: scrollsCompleted,
        position_count: positions.length,
        positions,
        rows: [],
        failed_position: positionIndex,
        failed_binding_phase: "after_rows",
        binding: bindingAfter
      };
    }
    if (positionRead.unreadable_rows.length) {
      return {
        completed: false,
        coverage_verified: false,
        reason: "colleague_row_evidence_unavailable",
        scrolls_requested: boundedMaxScrolls,
        scrolls_completed: scrollsCompleted,
        position_count: positions.length,
        positions,
        rows: [],
        failed_position: positionIndex,
        unreadable_rows: positionRead.unreadable_rows
      };
    }
    addRowsFromPosition(rowsByText, positionRows, positionIndex);
    previousRowSignature = rowSignature;
    previousRowLayoutSignature = rowLayoutSignature;

    if (
      enabled
      && stableSignatureCount >= stableEndSamplesRequired
      && effectiveScrollCount > 0
    ) {
      endProof = {
        verified: true,
        method: "effective_scroll_then_repeated_identical_rows",
        stable_samples_required: stableEndSamplesRequired,
        stable_samples_observed: stableSignatureCount,
        effective_scroll_observed: true,
        effective_scroll_count: effectiveScrollCount,
        end_position_index: positionIndex,
        end_scroll_count: scrollsCompleted,
        row_signature: rowSignature,
        additional_wheel_attempts_without_change: stableSignatureCount
      };
      break;
    }

    if (positionIndex === boundedMaxScrolls) break;

    const freshTarget = await readVisibleNodeEvidence(client, scrollTarget.node_id);
    if (!freshTarget || freshTarget.backend_node_id !== scrollTarget.backend_node_id) {
      return {
        completed: false,
        coverage_verified: false,
        reason: "scroll_target_binding_lost",
        scrolls_requested: boundedMaxScrolls,
        scrolls_completed: scrollsCompleted,
        position_count: positions.length,
        positions,
        rows: [],
        failed_position: positionIndex,
        target_selector: scrollTarget.selector
      };
    }
    try {
      await client.Input.dispatchMouseEvent({
        type: "mouseWheel",
        x: freshTarget.box.x + (freshTarget.box.width / 2),
        y: freshTarget.box.y + (freshTarget.box.height / 2),
        deltaY: stepDeltaY,
        deltaX: 0
      });
    } catch (error) {
      return {
        completed: false,
        coverage_verified: false,
        reason: "scroll_dispatch_failed",
        error: error?.message || String(error),
        scrolls_requested: boundedMaxScrolls,
        scrolls_completed: scrollsCompleted,
        position_count: positions.length,
        positions,
        rows: [],
        failed_position: positionIndex,
        target_selector: scrollTarget.selector
      };
    }
    scrollsCompleted += 1;
    await sleep(Math.max(0, Number(settleMs) || 0));
  }

  const allPositionEvidenceVerified = positions.every((position) => (
      position.binding_before_verified === true
      && position.binding_after_verified === true
  ));
  const completed = enabled
    ? Boolean(endProof?.verified && allPositionEvidenceVerified)
    : Boolean(positions.length === 1 && scrollsCompleted === 0 && allPositionEvidenceVerified);
  const coverageVerified = Boolean(
    enabled
    && completed
    && endProof?.verified === true
    && positions.every((position) => position.row_count > 0)
  );
  const capReachedWithoutEnd = Boolean(
    enabled
    && scrollsCompleted >= boundedMaxScrolls
    && endProof?.verified !== true
  );
  return {
    completed,
    coverage_verified: coverageVerified,
    reason: completed
      ? !enabled
        ? "scroll_scan_disabled"
        : coverageVerified
          ? null
          : "scroll_position_rows_missing"
      : capReachedWithoutEnd
        ? "scroll_end_not_verified_before_cap"
        : "scroll_scan_incomplete",
    scrolls_requested: boundedMaxScrolls,
    scrolls_completed: scrollsCompleted,
    position_count: positions.length,
    positions,
    target_selector: scrollTarget?.selector || null,
    target_node_id: scrollTarget?.node_id || null,
    target_backend_node_id: scrollTarget?.backend_node_id || null,
    step_delta_y: stepDeltaY,
    overlap_ratio: 0.35,
    effective_scroll_count: effectiveScrollCount,
    end_proof: endProof || {
      verified: false,
      method: "effective_scroll_then_repeated_identical_rows",
      stable_samples_required: stableEndSamplesRequired,
      stable_samples_observed: stableSignatureCount,
      effective_scroll_observed: effectiveScrollCount > 0,
      effective_scroll_count: effectiveScrollCount,
      end_position_index: null,
      end_scroll_count: null,
      row_signature: null,
      additional_wheel_attempts_without_change: stableSignatureCount
    },
    cap_reached_without_end: capReachedWithoutEnd,
    coverage_gap_positions: positions
      .filter((position) => position.row_count <= 0)
      .map((position) => position.position_index),
    rows: Array.from(rowsByText.values())
  };
}

async function resolveColleagueDetailScopes(client, detailState) {
  const scopes = [];
  if (Number.isInteger(detailState?.popup?.node_id) && detailState.popup.node_id > 0) {
    const popupEvidence = await readVisibleNodeEvidence(client, detailState.popup.node_id);
    if (popupEvidence) {
      scopes.push({
        name: "popup",
        nodeId: detailState.popup.node_id,
        backendNodeId: popupEvidence.backend_node_id
      });
    }
  }
  if (Number.isInteger(detailState?.resumeIframe?.node_id) && detailState.resumeIframe.node_id > 0) {
    try {
      const documentNodeId = await getFrameDocumentNodeId(client, detailState.resumeIframe.node_id);
      scopes.push({
        name: "resume_iframe",
        nodeId: documentNodeId,
        backendNodeId: null
      });
    } catch {
      // A stale or inaccessible iframe cannot be used as colleague-contact evidence.
    }
  }
  return scopes;
}

async function waitForColleagueSections(client, scopes, {
  timeoutMs = 1000,
  intervalMs = 150
} = {}) {
  const started = Date.now();
  let sections = [];
  let pollCount = 0;
  let stableScopeCount = 0;
  let scopeBindingLost = false;
  do {
    pollCount += 1;
    stableScopeCount = 0;
    for (const scope of scopes) {
      if (!Number.isInteger(scope?.backendNodeId) || scope.backendNodeId <= 0) continue;
      const evidence = await readVisibleNodeEvidence(client, scope.nodeId);
      if (!evidence || evidence.backend_node_id !== scope.backendNodeId) {
        scopeBindingLost = true;
        break;
      }
      stableScopeCount += 1;
    }
    if (scopeBindingLost) break;
    const matches = await queryAcrossRoots(client, scopes, COLLEAGUE_SECTION_SELECTOR);
    sections = [];
    for (const match of matches) {
      const evidence = await readVisibleNodeEvidence(client, match.node_id);
      if (!evidence) continue;
      sections.push({
        ...match,
        backend_node_id: evidence.backend_node_id,
        visible: true,
        box: evidence.box
      });
    }
    if (sections.length) {
      return {
        sections,
        absence_probe: {
          verified: false,
          selector: COLLEAGUE_SECTION_SELECTOR,
          scope_count: scopes.length,
          stable_scope_count: stableScopeCount,
          poll_count: pollCount,
          elapsed_ms: Date.now() - started,
          timeout_ms: Math.max(0, Number(timeoutMs) || 0),
          full_window_elapsed: false,
          query_error_count: 0,
          scope_binding_lost: false,
          scope_backend_node_ids: scopes
            .map((scope) => Number(scope?.backendNodeId))
            .filter((backendNodeId) => Number.isInteger(backendNodeId) && backendNodeId > 0)
        }
      };
    }
    const elapsedMs = Date.now() - started;
    const normalizedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
    if (
      elapsedMs >= normalizedTimeoutMs
      && (normalizedTimeoutMs === 0 || pollCount >= 2)
    ) break;
    await sleep(Math.max(1, Number(intervalMs) || 0));
  } while (true);
  const elapsedMs = Date.now() - started;
  const normalizedTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  const stableBackendNodeIds = scopes
    .map((scope) => Number(scope?.backendNodeId))
    .filter((backendNodeId) => Number.isInteger(backendNodeId) && backendNodeId > 0);
  return {
    sections,
    absence_probe: {
      verified: Boolean(
        !scopeBindingLost
        && scopes.length > 0
        && stableScopeCount > 0
        && stableBackendNodeIds.length === stableScopeCount
        && pollCount >= 2
        && elapsedMs >= normalizedTimeoutMs
      ),
      selector: COLLEAGUE_SECTION_SELECTOR,
      scope_count: scopes.length,
      stable_scope_count: stableScopeCount,
      poll_count: pollCount,
      elapsed_ms: elapsedMs,
      timeout_ms: normalizedTimeoutMs,
      full_window_elapsed: elapsedMs >= normalizedTimeoutMs,
      query_error_count: 0,
      scope_binding_lost: scopeBindingLost,
      scope_backend_node_ids: stableBackendNodeIds
    }
  };
}

export async function inspectRecentColleagueContact(client, detailState, {
  referenceDate = new Date(),
  windowDays = 14,
  scroll = true,
  scrollMaxSteps = 24,
  scrollSettleMs = 350,
  sectionWaitMs = 1000,
  sectionPollMs = 150
} = {}) {
  const scopes = await resolveColleagueDetailScopes(client, detailState);
  if (!scopes.length) {
    return {
      checked: false,
      panel_found: false,
      recent: null,
      indeterminate: true,
      reason: "detail_scope_unavailable",
      window_days: windowDays,
      rows: []
    };
  }
  const sectionWait = await waitForColleagueSections(client, scopes, {
    timeoutMs: sectionWaitMs,
    intervalMs: sectionPollMs
  });
  const sections = sectionWait.sections;
  if (!sections.length) {
    const absenceVerified = sectionWait.absence_probe?.verified === true;
    return {
      checked: absenceVerified,
      panel_found: false,
      recent: absenceVerified ? false : null,
      indeterminate: !absenceVerified,
      reason: "panel_missing",
      window_days: windowDays,
      absence_probe: sectionWait.absence_probe,
      rows: []
    };
  }
  if (sections.length !== 1) {
    return {
      checked: false,
      panel_found: true,
      recent: null,
      indeterminate: true,
      reason: "panel_ambiguous",
      window_days: windowDays,
      visible_section_count: sections.length,
      rows: []
    };
  }

  const section = sections[0];
  const tabHeaderIds = await querySelectorAll(client, section.node_id, ".tab-hd");
  let visibleTabHeaderCount = 0;
  for (const nodeId of tabHeaderIds) {
    if (await readVisibleNodeEvidence(client, nodeId)) visibleTabHeaderCount += 1;
  }
  const tab = await ensureColleagueTabSelected(client, section.node_id);
  if (!tab.selected) {
    return {
      checked: false,
      panel_found: true,
      recent: null,
      indeterminate: true,
      reason: "colleague_tab_unavailable",
      window_days: windowDays,
      section_root: section.root,
      section_node_id: section.node_id,
      section_backend_node_id: section.backend_node_id,
      tab_header_found: visibleTabHeaderCount === 1,
      selected_tab_text: tab.selected_text,
      selected_tab_count: tab.selected_tab_count,
      pane_binding_verified: false,
      rows: []
    };
  }

  const scrollScan = await scanContactRowsAcrossScrollPositions(
    client,
    scopes,
    section,
    tab,
    {
      enabled: scroll,
      maxScrolls: scrollMaxSteps,
      settleMs: scrollSettleMs
    }
  );
  const {
    rows = [],
    ...scroll_probe
  } = scrollScan;

  const sectionAfter = await readVisibleNodeEvidence(client, section.node_id);
  const selectedAfter = await readSelectedColleagueTab(client, section.node_id);
  const binding = {
    verified: Boolean(
      sectionAfter
      && sectionAfter.backend_node_id === section.backend_node_id
      && tab.selected === true
      && selectedAfter.selected === true
      && selectedAfter.backend_node_id === tab.backend_node_id
      && selectedAfter.selected_tab_count === 1
    ),
    detail_root_node_id: scopes[0]?.nodeId || null,
    section_node_id: section.node_id,
    section_backend_node_id: section.backend_node_id,
    section_visible: Boolean(sectionAfter),
    selected_tab_node_id: tab.node_id || null,
    selected_tab_backend_node_id: tab.backend_node_id || null,
    selected_tab_text: tab.selected_text,
    selected_tab_visible: tab.selected === true,
    selected_tab_count: tab.selected_tab_count,
    selection_reverified_after_rows: selectedAfter.selected === true,
    selected_tab_backend_node_id_after_rows: selectedAfter.backend_node_id || null,
    row_scope: "selected_section_descendants"
  };
  if (!binding.verified) {
    return {
      checked: false,
      panel_found: true,
      recent: null,
      indeterminate: true,
      reason: "colleague_binding_lost",
      window_days: windowDays,
      section_root: section.root,
      section_node_id: section.node_id,
      section_backend_node_id: section.backend_node_id,
      tab_header_found: visibleTabHeaderCount === 1,
      selected_tab_text: selectedAfter.selected_text || tab.selected_text,
      selected_tab_count: selectedAfter.selected_tab_count,
      pane_binding_verified: false,
      binding,
      rows: [],
      scroll_probe
    };
  }

  const parsedRows = rows.map((row) => {
    const parsedDate = parseColleagueContactDate(row.text, { referenceDate });
    return {
      ...row,
      parsed_date: parsedDate ? formatLocalDate(parsedDate) : null,
      within_window: parsedDate
        ? isDateWithinWindow(parsedDate, { referenceDate, windowDays })
        : false
    };
  });
  const matched = parsedRows.find((row) => row.within_window) || null;
  if (matched) {
    return {
      checked: true,
      panel_found: true,
      recent: true,
      indeterminate: false,
      reason: "recent_colleague_contact_found",
      window_days: windowDays,
      section_root: section.root,
      section_node_id: section.node_id,
      section_backend_node_id: section.backend_node_id,
      tab_header_found: visibleTabHeaderCount === 1,
      selected_tab_text: tab.selected_text,
      selected_tab_count: tab.selected_tab_count,
      pane_binding_verified: true,
      binding,
      tab_changed: tab.changed,
      matched_row: matched,
      row_count: parsedRows.length,
      rows: parsedRows,
      scroll_probe
    };
  }
  if (!scroll_probe.completed) {
    return {
      checked: false,
      panel_found: true,
      recent: null,
      indeterminate: true,
      reason: scroll_probe.reason || "colleague_scroll_scan_incomplete",
      window_days: windowDays,
      section_root: section.root,
      section_node_id: section.node_id,
      section_backend_node_id: section.backend_node_id,
      tab_header_found: visibleTabHeaderCount === 1,
      selected_tab_text: tab.selected_text,
      selected_tab_count: tab.selected_tab_count,
      pane_binding_verified: true,
      binding,
      rows: parsedRows,
      scroll_probe
    };
  }
  if (!parsedRows.length) {
    return {
      checked: false,
      panel_found: true,
      recent: null,
      indeterminate: true,
      reason: "contact_rows_missing",
      window_days: windowDays,
      section_root: section.root,
      section_node_id: section.node_id,
      section_backend_node_id: section.backend_node_id,
      tab_header_found: visibleTabHeaderCount === 1,
      selected_tab_text: tab.selected_text,
      selected_tab_count: tab.selected_tab_count,
      pane_binding_verified: true,
      binding,
      tab_changed: tab.changed,
      row_count: 0,
      rows: [],
      scroll_probe
    };
  }
  const unparsedRows = parsedRows.filter((row) => !row.parsed_date);
  if (unparsedRows.length) {
    return {
      checked: false,
      panel_found: true,
      recent: null,
      indeterminate: true,
      reason: "contact_date_unparseable",
      window_days: windowDays,
      section_root: section.root,
      section_node_id: section.node_id,
      section_backend_node_id: section.backend_node_id,
      tab_header_found: visibleTabHeaderCount === 1,
      selected_tab_text: tab.selected_text,
      selected_tab_count: tab.selected_tab_count,
      pane_binding_verified: true,
      binding,
      tab_changed: tab.changed,
      row_count: parsedRows.length,
      unparsed_row_count: unparsedRows.length,
      unparsed_rows: unparsedRows,
      rows: parsedRows,
      scroll_probe
    };
  }
  if (!scroll_probe.coverage_verified) {
    return {
      checked: false,
      panel_found: true,
      recent: null,
      indeterminate: true,
      reason: scroll_probe.reason || "colleague_scroll_scan_incomplete",
      window_days: windowDays,
      section_root: section.root,
      section_node_id: section.node_id,
      section_backend_node_id: section.backend_node_id,
      tab_header_found: visibleTabHeaderCount === 1,
      selected_tab_text: tab.selected_text,
      selected_tab_count: tab.selected_tab_count,
      pane_binding_verified: true,
      binding,
      tab_changed: tab.changed,
      row_count: parsedRows.length,
      rows: parsedRows,
      scroll_probe
    };
  }
  return {
    checked: true,
    panel_found: true,
    recent: false,
    indeterminate: false,
    reason: "no_recent_colleague_contact",
    window_days: windowDays,
    section_root: section.root,
    section_node_id: section.node_id,
    section_backend_node_id: section.backend_node_id,
    tab_header_found: visibleTabHeaderCount === 1,
    selected_tab_text: tab.selected_text,
    selected_tab_count: tab.selected_tab_count,
    pane_binding_verified: true,
    binding,
    tab_changed: tab.changed,
    matched_row: null,
    row_count: parsedRows.length,
    rows: parsedRows,
    scroll_probe
  };
}
