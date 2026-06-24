import {
  clickNodeCenter,
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import { htmlToText } from "../../core/screening/index.js";

const COLLEAGUE_SECTION_SELECTOR = ".colleague-collaboration";
const COLLEAGUE_TAB_SELECTOR = ".colleague-collaboration .tab-hd";
const SELECTED_TAB_SELECTOR = ".colleague-collaboration .tab-hd .selected";
const SECTION_SELECTED_TAB_SELECTOR = ".tab-hd .selected";
const TAB_CANDIDATE_SELECTOR = ".tab-hd span, .tab-hd div, .tab-hd *";
const ROW_SELECTOR = ".colleague-collaboration .record-item.mate-log-item";
const ROW_CONTENT_SELECTOR = ".colleague-collaboration .record-item.mate-log-item .content";
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
    const nodeIds = await querySelectorAll(client, root.nodeId, selector).catch(() => []);
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
  return /同事沟通进度/.test(normalizeText(text));
}

async function ensureColleagueTabSelected(client, sectionNodeId) {
  const selectedIds = await querySelectorAll(client, sectionNodeId, SECTION_SELECTED_TAB_SELECTOR).catch(() => []);
  for (const nodeId of selectedIds) {
    const text = normalizeText(await textForNode(client, nodeId).catch(() => ""));
    if (tabIsColleague(text)) {
      return {
        selected: true,
        changed: false,
        selected_text: text
      };
    }
  }

  const candidateIds = await querySelectorAll(client, sectionNodeId, TAB_CANDIDATE_SELECTOR).catch(() => []);
  for (const nodeId of candidateIds) {
    const text = normalizeText(await textForNode(client, nodeId).catch(() => ""));
    if (!tabIsColleague(text)) continue;
    const box = await clickNodeCenter(client, nodeId, { scrollIntoView: true });
    await sleep(500);
    return {
      selected: true,
      changed: true,
      selected_text: text,
      click_box: {
        rect: box.rect,
        center: box.center
      }
    };
  }

  return {
    selected: false,
    changed: false,
    selected_text: selectedIds.length
      ? normalizeText(await textForNode(client, selectedIds[0]).catch(() => ""))
      : ""
  };
}

async function readContactRows(client, roots) {
  const rowMatches = await queryAcrossRoots(client, roots, ROW_CONTENT_SELECTOR);
  const fallbackMatches = rowMatches.length ? [] : await queryAcrossRoots(client, roots, ROW_SELECTOR);
  const matches = rowMatches.length ? rowMatches : fallbackMatches;
  const rows = [];
  const seen = new Set();
  for (const match of matches) {
    const text = normalizeText(await textForNode(client, match.node_id).catch(() => ""));
    if (!text || seen.has(text)) continue;
    seen.add(text);
    rows.push({
      text,
      root: match.root,
      selector: match.selector,
      node_id: match.node_id
    });
  }
  return rows;
}

async function scrollDetailPaneForRows(client, roots, sectionNodeId, {
  maxScrolls = 4,
  settleMs = 350
} = {}) {
  const detailPanes = await queryAcrossRoots(client, roots, DETAIL_PANE_SELECTOR);
  const targetNodeId = detailPanes[0]?.node_id || sectionNodeId;
  let box = null;
  try {
    box = await getNodeBox(client, targetNodeId);
  } catch {
    try {
      box = await getNodeBox(client, sectionNodeId);
    } catch {
      return { scrolls: 0, reason: "scroll_target_box_unavailable" };
    }
  }
  let scrolls = 0;
  for (let index = 0; index < maxScrolls; index += 1) {
    await client.Input.dispatchMouseEvent({
      type: "mouseWheel",
      x: box.center.x,
      y: box.center.y,
      deltaY: 680,
      deltaX: 0
    });
    scrolls += 1;
    await sleep(settleMs);
  }
  return {
    scrolls,
    target_selector: detailPanes[0]?.selector || COLLEAGUE_SECTION_SELECTOR
  };
}

async function waitForColleagueSections(client, roots, {
  timeoutMs = 1000,
  intervalMs = 150
} = {}) {
  const started = Date.now();
  let sections = [];
  do {
    sections = await queryAcrossRoots(client, roots, COLLEAGUE_SECTION_SELECTOR);
    if (sections.length) return sections;
    if (Date.now() - started >= timeoutMs) break;
    await sleep(intervalMs);
  } while (Date.now() - started <= timeoutMs);
  return sections;
}

export async function inspectRecentColleagueContact(client, detailState, {
  referenceDate = new Date(),
  windowDays = 14,
  scroll = true,
  sectionWaitMs = 1000,
  sectionPollMs = 150
} = {}) {
  const roots = detailState?.roots || [];
  const sections = await waitForColleagueSections(client, roots, {
    timeoutMs: sectionWaitMs,
    intervalMs: sectionPollMs
  });
  if (!sections.length) {
    return {
      checked: true,
      panel_found: false,
      recent: false,
      reason: "panel_missing",
      window_days: windowDays,
      rows: []
    };
  }

  const section = sections[0];
  const tabHeader = await queryAcrossRoots(client, roots, COLLEAGUE_TAB_SELECTOR);
  const tab = await ensureColleagueTabSelected(client, section.node_id);
  if (!tab.selected) {
    return {
      checked: true,
      panel_found: true,
      recent: false,
      reason: "colleague_tab_unavailable",
      window_days: windowDays,
      section_root: section.root,
      tab_header_found: tabHeader.length > 0,
      selected_tab_text: tab.selected_text,
      rows: []
    };
  }

  let rows = await readContactRows(client, roots);
  let scroll_probe = null;
  if (scroll) {
    scroll_probe = await scrollDetailPaneForRows(client, roots, section.node_id);
    const afterScrollRows = await readContactRows(client, roots);
    const byText = new Map(rows.map((row) => [row.text, row]));
    for (const row of afterScrollRows) {
      if (!byText.has(row.text)) byText.set(row.text, row);
    }
    rows = Array.from(byText.values());
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
  return {
    checked: true,
    panel_found: true,
    recent: Boolean(matched),
    reason: matched ? "recent_colleague_contact_found" : "no_recent_colleague_contact",
    window_days: windowDays,
    section_root: section.root,
    tab_header_found: tabHeader.length > 0,
    selected_tab_text: tab.selected_text,
    tab_changed: tab.changed,
    matched_row: matched,
    row_count: parsedRows.length,
    rows: parsedRows,
    scroll_probe
  };
}
