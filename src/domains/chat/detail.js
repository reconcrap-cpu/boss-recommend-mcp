import {
  clearFocusedInput,
  clickNodeCenter,
  clickPoint,
  DETERMINISTIC_CLICK_OPTIONS,
  getFrameDocumentNodeId,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  insertText,
  pressKey,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import {
  buildScreeningCandidateFromDetail,
  htmlToText
} from "../../core/screening/index.js";
import {
  closeBossAccountRightsBlockingPanel,
  findBossAccountRightsBlockingPanel
} from "../common/account-rights-panel.js";
import {
  CHAT_ACTIVE_CANDIDATE_SELECTORS,
  CHAT_ASK_RESUME_BUTTON_SELECTORS,
  CHAT_ATTACHMENT_RESUME_BUTTON_SELECTORS,
  CHAT_BLOCKING_PANEL_CLOSE_SELECTORS,
  CHAT_BLOCKING_PANEL_TEXT_QUERIES,
  CHAT_CONFIRM_REQUEST_RESUME_SELECTORS,
  CHAT_EDITOR_SELECTORS,
  CHAT_MESSAGE_FILTER_SELECTORS,
  CHAT_MESSAGE_LIST_SELECTORS,
  CHAT_ONLINE_RESUME_BUTTON_SELECTORS,
  CHAT_PRIMARY_LABEL_SELECTORS,
  CHAT_PROFILE_NETWORK_PATTERNS,
  CHAT_RESUME_CLOSE_SELECTORS,
  CHAT_RESUME_CONTENT_SELECTORS,
  CHAT_RESUME_FAST_MODAL_SELECTORS,
  CHAT_RESUME_IFRAME_SELECTORS,
  CHAT_RESUME_MODAL_SELECTORS,
  CHAT_SEND_BUTTON_SELECTORS
} from "./constants.js";
import {
  getChatRoots,
  queryFirstAcrossChatRoots
} from "./roots.js";
import {
  assertChatShellNotResumeTopLevel,
  getChatTopLevelState,
  isForbiddenChatResumeTopLevelUrl,
  makeBossSecurityVerificationRequiredError,
  makeForbiddenChatResumeNavigationError
} from "./page-guard.js";

export const CHAT_UNSAFE_ONLINE_RESUME_LINK_CODE = "CHAT_UNSAFE_ONLINE_RESUME_LINK";
export const CHAT_ONLINE_RESUME_MODAL_NOT_OPEN_CODE = "CHAT_ONLINE_RESUME_MODAL_NOT_OPEN";

const CHAT_CONVERSATION_CONTROL_SCOPE_SELECTORS = Object.freeze([
  ".conversation-main",
  ".conversation-editor",
  ".chat-message-list",
  ".toolbar-box-right",
  ".operate-exchange-left",
  ".operate-icon-item",
  ".exchange-tooltip",
  ".boss-popup__wrapper",
  ".boss-dialog",
  ".dialog-wrap.active",
  ".geek-detail-modal"
]);

const CHAT_REQUESTED_RESUME_SCOPE_SELECTORS = Object.freeze([
  ".chat-message-list",
  ".conversation-editor",
  ".conversation-main",
  ".toolbar-box-right",
  ".operate-exchange-left",
  ".operate-icon-item",
  ".exchange-tooltip",
  ".boss-popup__wrapper",
  ".boss-dialog",
  ".dialog-wrap.active"
]);

const CHAT_REQUEST_RESUME_CONFIRM_PROMPT = "确定向牛人索取简历吗？";
const CHAT_REQUEST_RESUME_CONFIRM_SCOPE_SELECTORS = Object.freeze([
  ".exchange-tooltip",
  ".boss-popup__wrapper",
  ".boss-dialog",
  ".dialog-wrap.active"
]);
const CHAT_REQUEST_RESUME_CONFIRM_DEFAULT_TIMEOUT_MS = 20000;
const CHAT_REQUEST_RESUME_CONFIRM_POLL_INTERVAL_MS = 250;

export function matchesChatProfileNetwork(url) {
  return CHAT_PROFILE_NETWORK_PATTERNS.some((pattern) => pattern.test(String(url || "")));
}

function looksLikeForbiddenChatResumePath(value = "") {
  const normalized = String(value || "");
  return isForbiddenChatResumeTopLevelUrl(normalized)
    || /(?:^|["'\s=])(?:https?:\/\/[^"'\s>]*zhipin\.com)?\/web\/frame\/c-resume(?:[/?#"' >]|$)/i
      .test(normalized);
}

function extractFirstHtmlAttribute(html = "", names = []) {
  const source = String(html || "");
  for (const name of names) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
    const match = source.match(regex);
    if (match) return match[1] ?? match[2] ?? match[3] ?? "";
  }
  return "";
}

export function isUnsafeChatOnlineResumeTarget(target = {}, buttonHTML = "") {
  const attributes = target?.attributes || {};
  const href = attributes.href
    || attributes["data-href"]
    || attributes["data-url"]
    || attributes.url
    || extractFirstHtmlAttribute(buttonHTML, ["href", "data-href", "data-url", "url"]);
  return looksLikeForbiddenChatResumePath(href)
    || looksLikeForbiddenChatResumePath(buttonHTML);
}

export function makeUnsafeChatOnlineResumeLinkError(target = {}, buttonHTML = "") {
  const href = target?.attributes?.href
    || target?.attributes?.["data-href"]
    || target?.attributes?.["data-url"]
    || extractFirstHtmlAttribute(buttonHTML, ["href", "data-href", "data-url", "url"])
    || null;
  const error = new Error("CHAT_UNSAFE_ONLINE_RESUME_LINK: refusing to click an online resume link that can navigate the chat tab to /web/frame/c-resume/");
  error.code = CHAT_UNSAFE_ONLINE_RESUME_LINK_CODE;
  error.href = href;
  error.button_selector = target?.selector || null;
  error.button_text = htmlToText(buttonHTML).slice(0, 120);
  error.button_html_length = String(buttonHTML || "").length;
  return error;
}

export function isUnsafeChatOnlineResumeLinkError(error) {
  return error?.code === CHAT_UNSAFE_ONLINE_RESUME_LINK_CODE
    || /CHAT_UNSAFE_ONLINE_RESUME_LINK/i.test(String(error?.message || error || ""));
}

export function isChatOnlineResumeModalOpenFailureError(error) {
  return error?.code === CHAT_ONLINE_RESUME_MODAL_NOT_OPEN_CODE
    || /Chat online resume modal did not open/i.test(String(error?.message || error || ""));
}

export function createChatProfileNetworkRecorder(client) {
  const events = [];
  client.Network.responseReceived((event) => {
    const url = event?.response?.url || "";
    if (!matchesChatProfileNetwork(url)) return;
    events.push({
      requestId: event.requestId,
      url,
      status: event.response?.status,
      mimeType: event.response?.mimeType,
      type: event.type
    });
  });
  if (typeof client.Network.loadingFinished === "function") {
    client.Network.loadingFinished((event) => {
      const found = events.find((item) => item.requestId === event.requestId);
      if (!found) return;
      found.loading_finished = true;
      found.encodedDataLength = event.encodedDataLength;
    });
  }
  if (typeof client.Network.loadingFailed === "function") {
    client.Network.loadingFailed((event) => {
      const found = events.find((item) => item.requestId === event.requestId);
      if (!found) return;
      found.loading_failed = true;
      found.loading_error = event.errorText || event.blockedReason || "Network loading failed";
    });
  }
  return {
    events,
    clear() {
      events.length = 0;
    }
  };
}

export async function waitForChatProfileNetworkEvents(recorder, {
  minCount = 1,
  requireLoaded = true,
  timeoutMs = 8000,
  intervalMs = 120
} = {}) {
  const started = Date.now();
  const events = Array.isArray(recorder) ? recorder : recorder?.events || [];
  let matching = [];
  while (Date.now() - started <= timeoutMs) {
    matching = events.filter((event) => (
      !requireLoaded
      || event.loading_finished === true
      || event.loading_failed === true
    ));
    if (matching.length >= minCount) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        count: matching.length,
        events: matching
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    count: matching.length,
    events: matching,
    total_event_count: events.length
  };
}

export async function readChatProfileNetworkBodies(client, events = [], {
  limit = 20
} = {}) {
  const bodies = [];
  for (const event of events.slice(0, limit)) {
    try {
      const body = await client.Network.getResponseBody({ requestId: event.requestId });
      bodies.push({
        ...event,
        body,
        body_length: String(body?.body || "").length
      });
    } catch (error) {
      bodies.push({
        ...event,
        body_error: error?.message || String(error)
      });
    }
  }
  return bodies;
}

function normalizeDetailText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function chatCandidateIdFromAttributes(attributes = {}) {
  return normalizeDetailText(
    attributes["data-id"]
    || attributes["data-geekid"]
    || attributes["data-geek"]
    || attributes["data-uid"]
    || attributes.key
    || attributes.id
    || ""
  );
}

async function hydrateActiveChatCandidate(client, activeCandidate = null) {
  if (!activeCandidate?.node_id) return activeCandidate;
  let attributes = {};
  let outerHTML = "";
  try {
    [attributes, outerHTML] = await Promise.all([
      getAttributesMap(client, activeCandidate.node_id),
      getOuterHTML(client, activeCandidate.node_id)
    ]);
  } catch {}
  return {
    ...activeCandidate,
    attributes,
    candidate_id: chatCandidateIdFromAttributes(attributes) || null,
    label: normalizeDetailText(htmlToText(outerHTML)),
    outer_html_length: outerHTML.length
  };
}

export async function readChatActiveCandidateState(client) {
  const rootState = await getChatRoots(client);
  const activeCandidate = await queryFirstAcrossChatRoots(
    client,
    rootState.roots,
    CHAT_ACTIVE_CANDIDATE_SELECTORS
  );
  return {
    roots: rootState.roots,
    active_candidate: await hydrateActiveChatCandidate(client, activeCandidate)
  };
}

export async function waitForChatOnlineResumeButton(client, {
  timeoutMs = 12000,
  intervalMs = 250,
  expectedCandidateId = ""
} = {}) {
  const started = Date.now();
  let lastState = null;
  const expectedId = chatCandidateIdFromAttributes({ "data-id": expectedCandidateId });
  while (Date.now() - started <= timeoutMs) {
    const topLevelState = await getChatTopLevelState(client);
    if (topLevelState.is_forbidden_resume_top_level) {
      return {
        forbidden_top_level_navigation: true,
        top_level_state: topLevelState
      };
    }
    const rootState = await getChatRoots(client);
    const target = await findVisibleTarget(client, rootState.roots, CHAT_ONLINE_RESUME_BUTTON_SELECTORS);
    const activeCandidate = await hydrateActiveChatCandidate(
      client,
      await queryFirstAcrossChatRoots(client, rootState.roots, CHAT_ACTIVE_CANDIDATE_SELECTORS)
    );
    const activeCandidateId = activeCandidate?.candidate_id || "";
    const candidateSelectionVerified = expectedId
      ? activeCandidateId === expectedId
      : undefined;
    lastState = {
      roots: rootState.roots,
      target,
      activeCandidate,
      expected_candidate_id: expectedId || null,
      active_candidate_id: activeCandidateId || null,
      candidate_selection_verified: candidateSelectionVerified
    };
    if (target && (!expectedId || candidateSelectionVerified)) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        ...lastState
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    reason: expectedId && lastState?.candidate_selection_verified === false
      ? "active_candidate_mismatch"
      : "online_resume_button_unavailable",
    elapsed_ms: Date.now() - started,
    ...lastState
  };
}

export async function selectChatCandidate(client, cardNodeId, {
  timeoutMs = 12000,
  settleMs = 1200
} = {}) {
  const cardBox = await clickNodeCenter(client, cardNodeId, {
    scrollIntoView: true
  });
  if (settleMs > 0) await sleep(settleMs);
  const ready = await waitForChatOnlineResumeButton(client, { timeoutMs });
  return {
    card_box: cardBox,
    ready
  };
}

function hasActiveSignal(attributes = {}, outerHTML = "") {
  return /\b(active|selected|current|curr)\b/i.test(String(attributes.class || ""))
    || normalizeDetailText(attributes["aria-selected"]).toLowerCase() === "true"
    || normalizeDetailText(attributes["data-active"]).toLowerCase() === "true"
    || /\b(active|selected|current|curr)\b/i.test(String(outerHTML || "").slice(0, 500));
}

function isDisabledSignal(attributes = {}, outerHTML = "") {
  return attributes.disabled !== undefined
    || normalizeDetailText(attributes["aria-disabled"]).toLowerCase() === "true"
    || /\b(disabled|disable|is-disabled)\b/i.test([
      attributes.class,
      String(outerHTML || "").slice(0, 500)
    ].join(" "));
}

function isAskResumeText(text = "") {
  const normalized = normalizeDetailText(text);
  return Boolean(
    normalized === "求简历"
    || normalized === "索要简历"
    || normalized === "求附件简历"
    || normalized.includes("求简历")
    || normalized.includes("索要简历")
    || normalized.includes("求附件简历")
  );
}

function isRequestedResumeText(text = "") {
  const normalized = normalizeDetailText(text);
  return Boolean(
    normalized === "已求简历"
    || normalized === "已索要简历"
    || normalized.includes("已求简历")
    || normalized.includes("已索要简历")
    || normalized.includes("简历请求已发送")
    || normalized.includes("已发送简历")
    || (normalized.includes("已申请") && normalized.includes("简历"))
  );
}

function isResumeRequestSentMessageText(text = "") {
  const normalized = normalizeDetailText(text);
  return Boolean(
    normalized.includes("简历请求已发送")
    || normalized.includes("已发送简历")
    || normalized.includes("已求简历")
    || normalized.includes("已索要简历")
  );
}

function countTextOccurrences(text = "", needle = "") {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const found = text.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + needle.length;
  }
  return count;
}

function countResumeRequestSentMessageMarkers(lines = []) {
  const markers = ["简历请求已发送", "已发送简历", "已求简历", "已索要简历"];
  return lines.reduce((total, line) => (
    total + markers.reduce((lineTotal, marker) => (
      lineTotal + countTextOccurrences(line, marker)
    ), 0)
  ), 0);
}

function isResumeAttachmentMessageText(text = "") {
  const normalized = normalizeDetailText(text);
  return Boolean(
    /点击.*附件简历/.test(normalized)
    || /预览附件简历/.test(normalized)
    || /查看附件简历/.test(normalized)
    || /(?:简历|resume)[^\s]*\.(?:pdf|docx?|jpg|jpeg|png)\b/i.test(normalized)
  );
}

function countResumeAttachmentMessageMarkers(lines = []) {
  return lines.reduce((total, line) => total + (isResumeAttachmentMessageText(line) ? 1 : 0), 0);
}

function isRequestedResumeControlTarget(target = {}) {
  const label = normalizeDetailText(target.label);
  const className = String(target.attributes?.class || "");
  const selector = String(target.selector || "");
  const controlLike = /\boperate-btn\b|operate|resume|button|btn/i.test(`${selector} ${className}`);
  if (isRequestedResumeText(label)) return true;
  return controlLike && Boolean(
    label === "已申请"
    || label === "已发送"
    || label.includes("已申请")
    || label.includes("已发送")
  );
}

function isAttachmentResumeText(text = "") {
  const normalized = normalizeDetailText(text);
  return Boolean(
    normalized === "附件简历"
    || (normalized.includes("附件简历") && !normalized.includes("求附件简历"))
  );
}

function isAttachmentResumeTarget(target = {}) {
  return isAttachmentResumeText(target.label)
    || /resume-btn-file/i.test(String(target.attributes?.class || target.selector || ""));
}

function isRequestResumeConfirmPrompt(text = "") {
  return normalizeDetailText(text).includes(CHAT_REQUEST_RESUME_CONFIRM_PROMPT);
}

function isExactRequestResumeConfirmText(text = "") {
  const normalized = normalizeDetailText(text);
  return normalized === "确定" || normalized === "确认";
}

function isSendText(text = "") {
  const normalized = normalizeDetailText(text);
  return normalized === "发送" || normalized.includes("发送");
}

function isRecoverableNodeError(error) {
  return /(?:Could not find node|No node with given id|Cannot find node|Could not compute box model)/i
    .test(String(error?.message || error || ""));
}

async function readTarget(client, root, selector, nodeId) {
  let attributes = {};
  let outerHTML = "";
  let readError = "";
  try {
    [attributes, outerHTML] = await Promise.all([
      getAttributesMap(client, nodeId),
      getOuterHTML(client, nodeId)
    ]);
  } catch (error) {
    readError = error?.message || String(error);
  }
  const label = normalizeDetailText(htmlToText(outerHTML));
  let box = null;
  try {
    box = await getNodeBox(client, nodeId);
  } catch {}
  return {
    root: root.name,
    root_node_id: root.nodeId,
    selector,
    node_id: nodeId,
    label,
    attributes,
    disabled: isDisabledSignal(attributes, outerHTML),
    active: hasActiveSignal(attributes, outerHTML),
    visible: Boolean(box && box.rect.width > 2 && box.rect.height > 2),
    center: box?.center || null,
    rect: box?.rect || null,
    outer_html_length: outerHTML.length,
    read_error: readError || null
  };
}

async function findVisibleMatchingTarget(client, roots, selectors, predicate) {
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      const nodeIds = await querySelectorAll(client, root.nodeId, selector);
      for (const nodeId of nodeIds) {
        const target = await readTarget(client, root, selector, nodeId);
        if (!target.visible) continue;
        if (predicate(target)) return target;
      }
    }
  }
  return null;
}

async function resolveScopedRoots(client, roots = [], selectors = [], {
  fallbackToRoots = true
} = {}) {
  const scoped = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      let nodeIds = [];
      try {
        nodeIds = await querySelectorAll(client, root.nodeId, selector);
      } catch {
        nodeIds = [];
      }
      for (const nodeId of nodeIds) {
        const key = `${root.name}:${nodeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scoped.push({
          name: `${root.name}:${selector}`,
          nodeId
        });
      }
    }
  }
  if (scoped.length || !fallbackToRoots) return scoped;
  return roots;
}

async function findAnchoredChatRequestResumeConfirmTarget(client, roots = []) {
  const promptRoots = await resolveScopedRoots(
    client,
    roots,
    CHAT_REQUEST_RESUME_CONFIRM_SCOPE_SELECTORS,
    { fallbackToRoots: false }
  );
  let lastPrompt = null;
  let lastPromptCandidate = null;
  let lastTargetCandidate = null;
  for (const promptRoot of promptRoots) {
    const prompt = await readTarget(
      client,
      promptRoot,
      "request-resume-confirm-prompt",
      promptRoot.nodeId
    );
    lastPromptCandidate = prompt;
    if (!prompt.visible || !isRequestResumeConfirmPrompt(prompt.label)) continue;
    lastPrompt = prompt;
    for (const selector of CHAT_CONFIRM_REQUEST_RESUME_SELECTORS) {
      const nodeIds = await querySelectorAll(client, promptRoot.nodeId, selector);
      for (const nodeId of nodeIds) {
        const target = await readTarget(client, promptRoot, selector, nodeId);
        lastTargetCandidate = target;
        if (!target.visible || target.disabled || !isExactRequestResumeConfirmText(target.label)) {
          continue;
        }
        return {
          prompt,
          prompt_candidate: lastPromptCandidate,
          target,
          target_candidate: lastTargetCandidate,
          discovery_mode: "exact_request_prompt"
        };
      }
    }
  }
  return {
    prompt: lastPrompt,
    prompt_candidate: lastPromptCandidate,
    target: null,
    target_candidate: lastTargetCandidate,
    discovery_mode: lastPrompt ? "exact_request_prompt" : null
  };
}

export async function selectChatPrimaryLabel(client, {
  label = "全部",
  timeoutMs = 8000,
  intervalMs = 300,
  settleMs = 700
} = {}) {
  const started = Date.now();
  let lastCandidates = [];
  while (Date.now() - started <= timeoutMs) {
    const rootState = await getChatRoots(client);
    const candidates = [];
    for (const root of rootState.roots) {
      for (const selector of CHAT_PRIMARY_LABEL_SELECTORS) {
        const nodeIds = await querySelectorAll(client, root.nodeId, selector);
        for (const nodeId of nodeIds) {
          const target = await readTarget(client, root, selector, nodeId);
          if (target.visible) candidates.push(target);
        }
      }
    }
    lastCandidates = candidates;
    const matched = candidates.find((target) => (
      target.label === label || target.label.startsWith(`${label}(`)
    ));
    if (matched?.active) {
      return {
        ok: true,
        changed: false,
        verified: true,
        active_label: matched.label,
        control: matched
      };
    }
    if (matched) {
      if (matched.center) {
        await clickPoint(client, matched.center.x, matched.center.y, DETERMINISTIC_CLICK_OPTIONS);
      } else {
        await clickNodeCenter(client, matched.node_id, {
          ...DETERMINISTIC_CLICK_OPTIONS,
          scrollIntoView: true
        });
      }
      if (settleMs > 0) await sleep(settleMs);
      return {
        ok: true,
        changed: true,
        verified: true,
        active_label: label,
        control: matched
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    error: `CHAT_PRIMARY_LABEL_NOT_FOUND:${label}`,
    candidates: lastCandidates.map((item) => ({
      label: item.label,
      selector: item.selector,
      active: item.active
    }))
  };
}

export async function selectChatMessageFilter(client, {
  startFrom = "unread",
  timeoutMs = 8000,
  intervalMs = 300,
  settleMs = 900
} = {}) {
  const label = startFrom === "all" ? "全部" : "未读";
  const started = Date.now();
  let lastCandidates = [];
  while (Date.now() - started <= timeoutMs) {
    const rootState = await getChatRoots(client);
    const candidates = [];
    for (const root of rootState.roots) {
      for (const selector of CHAT_MESSAGE_FILTER_SELECTORS) {
        const nodeIds = await querySelectorAll(client, root.nodeId, selector);
        for (const nodeId of nodeIds) {
          const target = await readTarget(client, root, selector, nodeId);
          if (target.visible && target.label === label) candidates.push(target);
        }
      }
    }
    lastCandidates = candidates;
    const active = candidates.find((target) => target.active);
    if (active) {
      return {
        ok: true,
        changed: false,
        verified: true,
        active_label: active.label,
        control: active
      };
    }
    const matched = candidates[0];
    if (matched) {
      if (matched.center) {
        await clickPoint(client, matched.center.x, matched.center.y, DETERMINISTIC_CLICK_OPTIONS);
      } else {
        await clickNodeCenter(client, matched.node_id, {
          ...DETERMINISTIC_CLICK_OPTIONS,
          scrollIntoView: true
        });
      }
      if (settleMs > 0) await sleep(settleMs);
      return {
        ok: true,
        changed: true,
        verified: true,
        active_label: label,
        control: matched
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    error: `CHAT_MESSAGE_FILTER_NOT_FOUND:${label}`,
    candidates: lastCandidates.map((item) => ({
      label: item.label,
      selector: item.selector,
      active: item.active
    }))
  };
}

export async function waitForChatResumeModal(client, {
  timeoutMs = 12000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    const topLevelState = await getChatTopLevelState(client);
    if (topLevelState.is_forbidden_resume_top_level) {
      return {
        forbidden_top_level_navigation: true,
        top_level_state: topLevelState
      };
    }
    const rootState = await getChatRoots(client);
    const popup = await findVisibleTarget(client, rootState.roots, CHAT_RESUME_MODAL_SELECTORS);
    const content = await findVisibleTarget(client, rootState.roots, CHAT_RESUME_CONTENT_SELECTORS);
    const resumeIframe = await findVisibleTarget(client, rootState.roots, CHAT_RESUME_IFRAME_SELECTORS);
    lastState = {
      roots: rootState.roots,
      popup,
      content,
      resumeIframe
    };
    if (popup || content || resumeIframe) return lastState;
    await sleep(intervalMs);
  }
  return lastState;
}

export async function quickChatResumeModalOpenProbe(client, {
  selectors = CHAT_RESUME_FAST_MODAL_SELECTORS
} = {}) {
  const rootState = await getChatRoots(client);
  for (const root of rootState.roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      let nodeIds = [];
      try {
        nodeIds = await querySelectorAll(client, root.nodeId, selector);
      } catch {
        nodeIds = [];
      }
      for (const nodeId of nodeIds.slice(0, 4)) {
        try {
          const box = await getNodeBox(client, nodeId);
          if (box?.rect?.width > 8 && box?.rect?.height > 8) {
            return {
              open: true,
              root: root.name,
              selector,
              node_id: nodeId,
              rect: box.rect,
              center: box.center
            };
          }
        } catch {
          // Hidden or stale modal probes are ignored.
        }
      }
    }
  }
  return {
    open: false
  };
}

export async function findChatBlockingPanel(client, {
  textQueries = CHAT_BLOCKING_PANEL_TEXT_QUERIES
} = {}) {
  const panel = await findBossAccountRightsBlockingPanel(client, { textQueries });
  return panel.open
    ? { ...panel, reason: "blocking_panel_text_visible" }
    : panel;
}

export async function closeChatBlockingPanels(client, {
  attemptsLimit = 2,
  closeSelectors = CHAT_BLOCKING_PANEL_CLOSE_SELECTORS,
  textQueries = CHAT_BLOCKING_PANEL_TEXT_QUERIES
} = {}) {
  return closeBossAccountRightsBlockingPanel(client, {
    attemptsLimit,
    closeSelectors,
    resolveRoots: getChatRoots,
    textQueries
  });
}

export async function readChatResumeHtml(client, resumeState) {
  let popupHTML = "";
  let contentHTML = "";
  let resumeIframeHTML = "";
  let resumeIframeDocumentNodeId = null;

  if (resumeState?.popup?.node_id) {
    popupHTML = await getOuterHTML(client, resumeState.popup.node_id);
  }

  if (resumeState?.content?.node_id && resumeState.content.node_id !== resumeState?.popup?.node_id) {
    contentHTML = await getOuterHTML(client, resumeState.content.node_id);
  }

  if (resumeState?.resumeIframe?.node_id) {
    resumeIframeDocumentNodeId = await getFrameDocumentNodeId(client, resumeState.resumeIframe.node_id);
    resumeIframeHTML = await getOuterHTML(client, resumeIframeDocumentNodeId);
  }

  return {
    popupHTML,
    contentHTML,
    resumeIframeHTML,
    resumeIframeDocumentNodeId,
    popupText: htmlToText(popupHTML),
    contentText: htmlToText(contentHTML),
    resumeIframeText: htmlToText(resumeIframeHTML)
  };
}

function emptyChatResumeHtml(readError = null) {
  return {
    popupHTML: "",
    contentHTML: "",
    resumeIframeHTML: "",
    resumeIframeDocumentNodeId: null,
    popupText: "",
    contentText: "",
    resumeIframeText: "",
    readError: readError?.message || null
  };
}

export async function waitForChatResumeContent(client, {
  minTextLength = 120,
  timeoutMs = 15000,
  intervalMs = 250
} = {}) {
  const started = Date.now();
  let lastState = null;
  let lastHtml = null;
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      lastState = await waitForChatResumeModal(client, {
        timeoutMs: 700,
        intervalMs: 100
      });
      if (lastState?.popup || lastState?.content || lastState?.resumeIframe) {
        lastHtml = await readChatResumeHtml(client, lastState);
        const textLength = [
          lastHtml.popupText,
          lastHtml.contentText,
          lastHtml.resumeIframeText
        ].join("\n").length;
        if (textLength >= minTextLength) {
          return {
            ok: true,
            elapsed_ms: Date.now() - started,
            text_length: textLength,
            resume_state: lastState,
            resume_html: lastHtml
          };
        }
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const textLength = [
    lastHtml?.popupText,
    lastHtml?.contentText,
    lastHtml?.resumeIframeText
  ].filter(Boolean).join("\n").length;
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    text_length: textLength,
    resume_state: lastState,
    resume_html: lastHtml,
    error: lastError?.message || null
  };
}

export async function openChatOnlineResume(client, {
  timeoutMs = 15000,
  attemptsLimit = 3,
  settleMs = 1200
} = {}) {
  const attempts = [];
  for (let index = 0; index < attemptsLimit; index += 1) {
    if (settleMs > 0) await sleep(settleMs);
    await assertChatShellNotResumeTopLevel(client, {
      context: "openChatOnlineResume:before_existing_modal_check"
    });
    const existingResumeState = await waitForChatResumeModal(client, {
      timeoutMs: 500,
      intervalMs: 100
    });
    if (existingResumeState?.forbidden_top_level_navigation) {
      throw makeForbiddenChatResumeNavigationError(existingResumeState.top_level_state);
    }
    if (
      existingResumeState?.popup
      || existingResumeState?.content
      || existingResumeState?.resumeIframe
    ) {
      attempts.push({
        attempt: index + 1,
        ok: true,
        reused_existing_modal: true,
        resume_popup_selector: existingResumeState?.popup?.selector || null,
        resume_content_selector: existingResumeState?.content?.selector || null,
        resume_iframe_selector: existingResumeState?.resumeIframe?.selector || null
      });
      return {
        button: null,
        button_html: "",
        resume_state: existingResumeState,
        attempts
      };
    }

    const buttonState = await waitForChatOnlineResumeButton(client, {
      timeoutMs: Math.min(timeoutMs, 8000)
    });
    if (!buttonState?.target?.node_id) {
      attempts.push({
        attempt: index + 1,
        ok: false,
        error: "ONLINE_RESUME_BUTTON_NOT_FOUND"
      });
      continue;
    }

    let buttonHTML = "";
    try {
      buttonHTML = await getOuterHTML(client, buttonState.target.node_id);
    } catch {}

    if (isUnsafeChatOnlineResumeTarget(buttonState.target, buttonHTML)) {
      const error = makeUnsafeChatOnlineResumeLinkError(buttonState.target, buttonHTML);
      attempts.push({
        attempt: index + 1,
        ok: false,
        error: error.code,
        blocked_pre_click: true,
        button_selector: buttonState.target.selector,
        button_text: error.button_text,
        button_href: error.href,
        button_html_length: buttonHTML.length
      });
      error.attempts = attempts;
      throw error;
    }

    try {
      if (buttonState.target.center) {
        await clickPoint(client, buttonState.target.center.x, buttonState.target.center.y);
      } else {
        await clickNodeCenter(client, buttonState.target.node_id, {
          scrollIntoView: true
        });
      }
    } catch (error) {
      attempts.push({
        attempt: index + 1,
        ok: false,
        error: error?.message || String(error),
        recoverable_stale_node: isRecoverableNodeError(error),
        button_selector: buttonState.target.selector,
        button_text: htmlToText(buttonHTML).slice(0, 120),
        button_html_length: buttonHTML.length
      });
      if (isRecoverableNodeError(error)) {
        await sleep(350);
        continue;
      }
      throw error;
    }
    await assertChatShellNotResumeTopLevel(client, {
      context: "openChatOnlineResume:after_online_resume_click"
    });
    const resumeState = await waitForChatResumeModal(client, {
      timeoutMs: Math.max(2500, Math.floor(timeoutMs / attemptsLimit))
    });
    if (resumeState?.forbidden_top_level_navigation) {
      throw makeForbiddenChatResumeNavigationError(resumeState.top_level_state);
    }
    attempts.push({
      attempt: index + 1,
      ok: Boolean(resumeState?.popup || resumeState?.content || resumeState?.resumeIframe),
      button_selector: buttonState.target.selector,
      button_text: htmlToText(buttonHTML).slice(0, 120),
      button_html_length: buttonHTML.length,
      resume_popup_selector: resumeState?.popup?.selector || null,
      resume_content_selector: resumeState?.content?.selector || null,
      resume_iframe_selector: resumeState?.resumeIframe?.selector || null
    });
    if (resumeState?.popup || resumeState?.content || resumeState?.resumeIframe) {
      return {
        button: buttonState.target,
        button_html: buttonHTML,
        resume_state: resumeState,
        attempts
      };
    }
  }

  const error = new Error("Chat online resume modal did not open");
  error.code = CHAT_ONLINE_RESUME_MODAL_NOT_OPEN_CODE;
  error.retryable = true;
  error.attempts = attempts;
  throw error;
}

export async function readChatConversationReadyState(client) {
  const rootState = await getChatRoots(client);
  const scopedControlRoots = await resolveScopedRoots(
    client,
    rootState.roots,
    CHAT_CONVERSATION_CONTROL_SCOPE_SELECTORS,
    { fallbackToRoots: false }
  );
  const scopedRequestedRoots = await resolveScopedRoots(
    client,
    rootState.roots,
    CHAT_REQUESTED_RESUME_SCOPE_SELECTORS,
    { fallbackToRoots: false }
  );
  const controlRoots = scopedControlRoots.length ? scopedControlRoots : rootState.roots;
  const requestedRoots = scopedRequestedRoots.length ? scopedRequestedRoots : rootState.roots;
  const onlineResume = await findVisibleMatchingTarget(
    client,
    controlRoots,
    CHAT_ONLINE_RESUME_BUTTON_SELECTORS,
    (target) => target.label.includes("在线简历") && !target.disabled
  );
  const attachmentResume = await findVisibleMatchingTarget(
    client,
    controlRoots,
    CHAT_ATTACHMENT_RESUME_BUTTON_SELECTORS,
    (target) => isAttachmentResumeText(target.label)
  );
  const askResume = await findVisibleMatchingTarget(
    client,
    controlRoots,
    CHAT_ASK_RESUME_BUTTON_SELECTORS,
    (target) => isAskResumeText(target.label) && !isAttachmentResumeTarget(target)
  );
  const requestedResume = await findVisibleMatchingTarget(
    client,
    requestedRoots,
    CHAT_ASK_RESUME_BUTTON_SELECTORS,
    (target) => isRequestedResumeControlTarget(target)
  );
  const editor = await findVisibleMatchingTarget(
    client,
    controlRoots,
    CHAT_EDITOR_SELECTORS,
    () => true
  );
  const sendButton = await findVisibleMatchingTarget(
    client,
    controlRoots,
    CHAT_SEND_BUTTON_SELECTORS,
    (target) => isSendText(target.label) || /submit/i.test(String(target.attributes?.class || ""))
  );
  const resumeState = await waitForChatResumeModal(client, { timeoutMs: 300 });
  const blockingPanel = await findChatBlockingPanel(client);
  const resumeModalOpen = Boolean(resumeState?.popup || resumeState?.content || resumeState?.resumeIframe);
  const blockingPanelOpen = Boolean(blockingPanel?.open);
  return {
    has_online_resume: Boolean(onlineResume),
    online_resume: onlineResume,
    has_ask_resume: Boolean(askResume),
    ask_resume: askResume,
    already_requested_resume: Boolean(requestedResume),
    requested_resume: requestedResume,
    has_attachment_resume: Boolean(attachmentResume),
    attachment_resume_enabled: Boolean(attachmentResume && !attachmentResume.disabled),
    attachment_resume: attachmentResume,
    editor_visible: Boolean(editor),
    editor,
    send_button_visible: Boolean(sendButton),
    send_button: sendButton,
    resume_modal_open: resumeModalOpen,
    blocking_panel_open: blockingPanelOpen,
    blocking_panel: blockingPanelOpen ? blockingPanel : null,
    panels_closed: !resumeModalOpen && !blockingPanelOpen
  };
}

function readAccessibilityBooleanProperty(node, propertyName) {
  for (const property of node?.properties || []) {
    if (property?.name !== propertyName) continue;
    if (typeof property?.value?.value === "boolean") return property.value.value;
  }
  return null;
}

async function readFreshChatEditorTarget(client) {
  const rootState = await getChatRoots(client);
  const scopedControlRoots = await resolveScopedRoots(
    client,
    rootState.roots,
    CHAT_CONVERSATION_CONTROL_SCOPE_SELECTORS,
    { fallbackToRoots: false }
  );
  const controlRoots = scopedControlRoots.length ? scopedControlRoots : rootState.roots;
  return findVisibleMatchingTarget(
    client,
    controlRoots,
    CHAT_EDITOR_SELECTORS,
    () => true
  );
}

async function readChatEditorFocusState(client, editor) {
  if (!editor?.node_id) {
    return {
      available: false,
      focused: false,
      reason: "editor_node_missing"
    };
  }
  if (typeof client?.Accessibility?.getPartialAXTree !== "function") {
    return {
      available: false,
      focused: false,
      reason: "accessibility_unavailable",
      editor_node_id: editor.node_id
    };
  }
  try {
    const result = await client.Accessibility.getPartialAXTree({
      nodeId: editor.node_id,
      fetchRelatives: false
    });
    const node = result?.nodes?.[0] || null;
    if (!node) {
      return {
        available: false,
        focused: false,
        reason: "accessibility_node_missing",
        editor_node_id: editor.node_id
      };
    }
    return {
      available: true,
      focused: readAccessibilityBooleanProperty(node, "focused") === true,
      focusable: readAccessibilityBooleanProperty(node, "focusable"),
      role: node?.role?.value || "",
      backend_dom_node_id: node?.backendDOMNodeId || null,
      editor_node_id: editor.node_id
    };
  } catch (error) {
    return {
      available: false,
      focused: false,
      reason: "accessibility_read_failed",
      read_error: error?.message || String(error),
      editor_node_id: editor.node_id
    };
  }
}

const CHAT_EDITOR_FOCUS_SETTLE_LIMIT_MS = 600;
const CHAT_EDITOR_FOCUS_POLL_INTERVAL_MS = 100;

function canChatEditorFocusStillSettle(focus) {
  if (focus?.focused) return false;
  if (focus?.available && focus?.focusable === true && !focus?.read_error) return true;
  if (focus?.reason === "editor_node_missing" || focus?.reason === "accessibility_node_missing") {
    return true;
  }
  return Boolean(focus?.read_error && isRecoverableNodeError(focus.read_error));
}

async function waitForFreshChatEditorFocus(client, {
  initialDelayMs = 0,
  settleLimitMs = CHAT_EDITOR_FOCUS_SETTLE_LIMIT_MS,
  pollIntervalMs = CHAT_EDITOR_FOCUS_POLL_INTERVAL_MS
} = {}) {
  const startedAt = Date.now();
  const observations = [];
  let editor = null;
  let focus = {
    available: false,
    focused: false,
    reason: "focus_not_read"
  };
  let firstRead = true;
  while (true) {
    try {
      editor = await readFreshChatEditorTarget(client);
      focus = await readChatEditorFocusState(client, editor);
    } catch (error) {
      if (!isRecoverableNodeError(error)) throw error;
      editor = null;
      focus = {
        available: false,
        focused: false,
        reason: "recoverable_node_error",
        read_error: error?.message || String(error)
      };
    }
    observations.push({
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      editor_node_id: editor?.node_id || null,
      available: focus.available,
      focused: focus.focused,
      focusable: focus.focusable ?? null,
      role: focus.role || null,
      backend_dom_node_id: focus.backend_dom_node_id || null,
      reason: focus.reason || null,
      read_error: focus.read_error || null
    });
    const elapsedMs = Date.now() - startedAt;
    if (
      focus.focused
      || !canChatEditorFocusStillSettle(focus)
      || elapsedMs >= settleLimitMs
    ) {
      break;
    }
    const delayMs = firstRead && initialDelayMs > 0
      ? initialDelayMs
      : pollIntervalMs;
    firstRead = false;
    await sleep(Math.min(delayMs, Math.max(1, settleLimitMs - elapsedMs)));
  }
  return {
    editor,
    focus,
    observations,
    poll_count: Math.max(0, observations.length - 1),
    elapsed_ms: observations.at(-1)?.elapsed_ms || 0,
    settled_after_poll: Boolean(focus.focused && observations.length > 1)
  };
}

async function recoverChatEditorFocusWithDomFocus(client, editor, focus) {
  const backendNodeId = Number(focus?.backend_dom_node_id);
  const editorNodeId = Number(editor?.node_id);
  if (
    typeof client?.DOM?.focus !== "function"
    || typeof client?.DOM?.describeNode !== "function"
    || !Number.isInteger(editorNodeId)
    || editorNodeId <= 0
    || focus?.focused
    || focus?.available !== true
    || focus?.focusable !== true
    || focus?.read_error
    || !Number.isInteger(backendNodeId)
    || backendNodeId <= 0
  ) {
    return {
      attempted: false,
      dispatched: false,
      editor,
      focus,
      settle: null
    };
  }

  let focusCallAttempted = false;
  try {
    const freshEditor = await readFreshChatEditorTarget(client);
    const freshEditorNodeId = Number(freshEditor?.node_id);
    const axEditorNodeId = Number(focus?.editor_node_id);
    if (
      !Number.isInteger(freshEditorNodeId)
      || freshEditorNodeId <= 0
      || freshEditorNodeId !== editorNodeId
      || axEditorNodeId !== editorNodeId
    ) {
      return {
        attempted: true,
        dispatched: false,
        target_kind: "backend_node_id",
        target_id: backendNodeId,
        editor: freshEditor || editor,
        focus,
        settle: null,
        pre_focus_editor_node_id: editorNodeId,
        fresh_editor_node_id: Number.isInteger(freshEditorNodeId) ? freshEditorNodeId : null,
        ax_editor_node_id: Number.isInteger(axEditorNodeId) ? axEditorNodeId : null,
        focus_call_attempted: false,
        binding_failed: true,
        pre_focus_binding_verified: false,
        post_focus_binding_verified: false,
        error: "fresh_editor_node_binding_mismatch"
      };
    }

    const described = await client.DOM.describeNode({ nodeId: freshEditorNodeId });
    const describedBackendNodeId = Number(described?.node?.backendNodeId);
    if (
      !Number.isInteger(describedBackendNodeId)
      || describedBackendNodeId <= 0
      || describedBackendNodeId !== backendNodeId
    ) {
      return {
        attempted: true,
        dispatched: false,
        target_kind: "backend_node_id",
        target_id: backendNodeId,
        editor: freshEditor,
        focus,
        settle: null,
        pre_focus_editor_node_id: editorNodeId,
        fresh_editor_node_id: freshEditorNodeId,
        ax_editor_node_id: axEditorNodeId,
        described_backend_dom_node_id: Number.isInteger(describedBackendNodeId)
          ? describedBackendNodeId
          : null,
        focus_call_attempted: false,
        binding_failed: true,
        pre_focus_binding_verified: false,
        post_focus_binding_verified: false,
        error: "editor_backend_node_binding_mismatch"
      };
    }

    focusCallAttempted = true;
    await client.DOM.focus({ backendNodeId });
    const settle = await waitForFreshChatEditorFocus(client, {
      initialDelayMs: 80
    });
    const postFocusEditorNodeId = Number(settle.editor?.node_id);
    const postFocusAxEditorNodeId = Number(settle.focus?.editor_node_id);
    const postFocusBackendNodeId = Number(settle.focus?.backend_dom_node_id);
    const postFocusBindingVerified = Boolean(
      Number.isInteger(postFocusEditorNodeId)
      && postFocusEditorNodeId > 0
      && postFocusAxEditorNodeId === postFocusEditorNodeId
      && postFocusBackendNodeId === backendNodeId
    );
    const postFocusVerified = postFocusBindingVerified && settle.focus?.focused === true;
    const verifiedFocus = postFocusVerified
      ? settle.focus
      : {
          ...settle.focus,
          focused: false,
          reason: postFocusBindingVerified
            ? "native_focus_not_verified"
            : "native_focus_post_binding_mismatch"
        };
    return {
      attempted: true,
      dispatched: true,
      target_kind: "backend_node_id",
      target_id: backendNodeId,
      editor: settle.editor || editor,
      focus: verifiedFocus,
      settle: {
        ...settle,
        focus: verifiedFocus
      },
      pre_focus_editor_node_id: editorNodeId,
      fresh_editor_node_id: freshEditorNodeId,
      ax_editor_node_id: axEditorNodeId,
      described_backend_dom_node_id: describedBackendNodeId,
      focus_call_attempted: true,
      binding_failed: !postFocusVerified,
      pre_focus_binding_verified: true,
      post_focus_editor_node_id: Number.isInteger(postFocusEditorNodeId)
        ? postFocusEditorNodeId
        : null,
      post_focus_ax_editor_node_id: Number.isInteger(postFocusAxEditorNodeId)
        ? postFocusAxEditorNodeId
        : null,
      post_focus_backend_dom_node_id: Number.isInteger(postFocusBackendNodeId)
        ? postFocusBackendNodeId
        : null,
      post_focus_binding_verified: postFocusBindingVerified,
      post_focus_verified: postFocusVerified,
      error: postFocusVerified
        ? null
        : postFocusBindingVerified
          ? "native_focus_not_verified"
          : "post_focus_backend_node_binding_mismatch"
    };
  } catch (error) {
    if (!focusCallAttempted && !isRecoverableNodeError(error)) throw error;
    return {
      attempted: true,
      dispatched: false,
      target_kind: "backend_node_id",
      target_id: backendNodeId,
      editor,
      focus,
      settle: null,
      focus_call_attempted: focusCallAttempted,
      binding_failed: focusCallAttempted,
      error: error?.message || String(error)
    };
  }
}

async function focusChatEditorForInput(client, initialEditor, {
  deterministic = false,
  attemptsLimit = 3
} = {}) {
  let editor = initialEditor || null;
  let lastState = null;
  const attempts = [];
  let nativeFocusAttempted = false;
  const limit = Math.max(1, Number(attemptsLimit) || 1);
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    if (!editor?.node_id) {
      editor = await readFreshChatEditorTarget(client);
      lastState = { editor };
    }
    if (!editor?.node_id) {
      attempts.push({
        attempt,
        editor_node_id: null,
        focused: false,
        reason: "editor_not_found"
      });
      if (attempt < limit) await sleep(160);
      continue;
    }

    let clickResult = null;
    try {
      const useDeterministicClick = deterministic || attempt > 1;
      if (editor.center) {
        clickResult = await clickPoint(
          client,
          editor.center.x,
          editor.center.y,
          useDeterministicClick ? DETERMINISTIC_CLICK_OPTIONS : undefined
        );
      } else {
        clickResult = await clickNodeCenter(client, editor.node_id, {
          scrollIntoView: true,
          ...(useDeterministicClick ? DETERMINISTIC_CLICK_OPTIONS : {})
        });
      }
      const clickedEditor = editor;
      // Boss can remount the contenteditable as a direct consequence of focus.
      // Frontend DOM node ids are session/document-epoch scoped, so never ask
      // Accessibility about the pre-click id. Reacquire the editor first.
      const clickFocusSettle = await waitForFreshChatEditorFocus(client, {
        initialDelayMs: attempt === 1 ? 120 : 180
      });
      let verificationEditor = clickFocusSettle.editor;
      lastState = { editor: verificationEditor };
      let focus = clickFocusSettle.focus;
      let focusSettle = clickFocusSettle;
      const nativeFocusRecovery = nativeFocusAttempted
        ? {
            attempted: false,
            dispatched: false,
            editor: verificationEditor,
            focus,
            settle: null
          }
        : await recoverChatEditorFocusWithDomFocus(
            client,
            verificationEditor,
            focus
          );
      nativeFocusAttempted = nativeFocusAttempted || nativeFocusRecovery.attempted;
      if (nativeFocusRecovery.attempted) {
        verificationEditor = nativeFocusRecovery.editor || verificationEditor;
        focus = nativeFocusRecovery.focus || focus;
        focusSettle = nativeFocusRecovery.settle || focusSettle;
        lastState = { editor: verificationEditor };
      }
      attempts.push({
        attempt,
        clicked_editor_node_id: clickedEditor.node_id,
        editor_node_id: verificationEditor?.node_id || null,
        editor_reacquired: Boolean(verificationEditor?.node_id),
        editor_node_changed: Boolean(
          verificationEditor?.node_id
          && verificationEditor.node_id !== clickedEditor.node_id
        ),
        editor_selector: verificationEditor?.selector || clickedEditor.selector || null,
        editor_trace_id: verificationEditor?.attributes?.traceid || clickedEditor.attributes?.traceid || null,
        click_mode: clickResult?.mode || clickResult?.click_result?.mode || null,
        focus_available: focus.available,
        focused: focus.focused,
        focusable: focus.focusable ?? null,
        focus_role: focus.role || null,
        focus_backend_dom_node_id: focus.backend_dom_node_id || null,
        focus_reason: focus.reason || null,
        focus_read_error: focus.read_error || null,
        focus_poll_count: focusSettle.poll_count,
        focus_settle_elapsed_ms: focusSettle.elapsed_ms,
        focus_settled_after_poll: focusSettle.settled_after_poll,
        focus_observations: focusSettle.observations,
        click_focus_poll_count: clickFocusSettle.poll_count,
        click_focus_settle_elapsed_ms: clickFocusSettle.elapsed_ms,
        click_focus_settled_after_poll: clickFocusSettle.settled_after_poll,
        click_focus_observations: clickFocusSettle.observations,
        native_focus_attempted: nativeFocusRecovery.attempted,
        native_focus_dispatched: nativeFocusRecovery.dispatched,
        native_focus_target_kind: nativeFocusRecovery.target_kind || null,
        native_focus_target_id: nativeFocusRecovery.target_id || null,
        native_focus_error: nativeFocusRecovery.error || null,
        native_focus_call_attempted: nativeFocusRecovery.focus_call_attempted === true,
        native_focus_binding_failed: nativeFocusRecovery.binding_failed === true,
        native_focus_pre_editor_node_id: nativeFocusRecovery.pre_focus_editor_node_id || null,
        native_focus_fresh_editor_node_id: nativeFocusRecovery.fresh_editor_node_id || null,
        native_focus_ax_editor_node_id: nativeFocusRecovery.ax_editor_node_id || null,
        native_focus_described_backend_dom_node_id: nativeFocusRecovery.described_backend_dom_node_id || null,
        native_focus_pre_binding_verified: nativeFocusRecovery.pre_focus_binding_verified === true,
        native_focus_post_editor_node_id: nativeFocusRecovery.post_focus_editor_node_id || null,
        native_focus_post_ax_editor_node_id: nativeFocusRecovery.post_focus_ax_editor_node_id || null,
        native_focus_post_backend_dom_node_id: nativeFocusRecovery.post_focus_backend_dom_node_id || null,
        native_focus_post_binding_verified: nativeFocusRecovery.post_focus_binding_verified === true,
        native_focus_post_verified: nativeFocusRecovery.post_focus_verified === true,
        native_focus_poll_count: nativeFocusRecovery.settle?.poll_count ?? null,
        native_focus_settle_elapsed_ms: nativeFocusRecovery.settle?.elapsed_ms ?? null,
        native_focus_settled_after_poll: nativeFocusRecovery.settle?.settled_after_poll ?? null,
        native_focus_observations: nativeFocusRecovery.settle?.observations || []
      });
      if (nativeFocusRecovery.binding_failed) {
        return {
          ok: false,
          terminal_binding_failure: true,
          editor: verificationEditor,
          focus,
          attempts,
          state: lastState,
          terminal_focus_binding_failure: nativeFocusRecovery.focus_call_attempted === true,
          focus_binding_error: nativeFocusRecovery.error || null
        };
      }
      if (focus.focused) {
        return {
          ok: true,
          editor: verificationEditor,
          focus,
          native_focus_backend_node_id: nativeFocusRecovery.dispatched
            && nativeFocusRecovery.pre_focus_binding_verified
            && nativeFocusRecovery.post_focus_binding_verified
            ? nativeFocusRecovery.target_id
            : null,
          attempts,
          state: lastState
        };
      }
      editor = focus.read_error && isRecoverableNodeError(focus.read_error)
        ? null
        : verificationEditor;
    } catch (error) {
      if (!isRecoverableNodeError(error)) throw error;
      attempts.push({
        attempt,
        editor_node_id: editor.node_id,
        editor_selector: editor.selector || null,
        editor_trace_id: editor.attributes?.traceid || null,
        focused: false,
        recoverable_error: error?.message || String(error)
      });
      editor = null;
    }

    if (attempt < limit) await sleep(160);
  }
  return {
    ok: false,
    editor,
    focus: attempts[attempts.length - 1] || null,
    attempts,
    state: lastState
  };
}

async function verifyChatEditorBackendBinding(client, editor, focus, expectedBackendNodeId) {
  const expected = Number(expectedBackendNodeId);
  if (!Number.isInteger(expected) || expected <= 0) {
    return {
      required: false,
      verified: true
    };
  }
  const editorNodeId = Number(editor?.node_id);
  const axEditorNodeId = Number(focus?.editor_node_id);
  const axBackendNodeId = Number(focus?.backend_dom_node_id);
  const base = {
    required: true,
    expected_backend_dom_node_id: expected,
    editor_node_id: Number.isInteger(editorNodeId) ? editorNodeId : null,
    ax_editor_node_id: Number.isInteger(axEditorNodeId) ? axEditorNodeId : null,
    ax_backend_dom_node_id: Number.isInteger(axBackendNodeId) ? axBackendNodeId : null
  };
  if (
    focus?.focused !== true
    || !Number.isInteger(editorNodeId)
    || editorNodeId <= 0
    || axEditorNodeId !== editorNodeId
    || axBackendNodeId !== expected
    || typeof client?.DOM?.describeNode !== "function"
  ) {
    return {
      ...base,
      verified: false,
      error: "editor_backend_node_binding_mismatch"
    };
  }
  try {
    const described = await client.DOM.describeNode({ nodeId: editorNodeId });
    const describedBackendNodeId = Number(described?.node?.backendNodeId);
    const verified = Number.isInteger(describedBackendNodeId)
      && describedBackendNodeId > 0
      && describedBackendNodeId === expected;
    return {
      ...base,
      described_backend_dom_node_id: Number.isInteger(describedBackendNodeId)
        ? describedBackendNodeId
        : null,
      verified,
      error: verified ? null : "editor_backend_node_binding_mismatch"
    };
  } catch (error) {
    return {
      ...base,
      verified: false,
      error: error?.message || String(error)
    };
  }
}

export async function setChatEditorMessage(client, message, {
  timeoutMs = 8000
} = {}) {
  const expectedText = normalizeDetailText(message);
  const started = Date.now();
  let lastState = null;
  let editorFound = false;
  const attempts = [];
  while (Date.now() - started <= timeoutMs) {
    const state = await readChatConversationReadyState(client);
    lastState = state;
    if (state.editor?.node_id) {
      editorFound = true;
      try {
        const focusResult = await focusChatEditorForInput(client, state.editor, {
          deterministic: false,
          attemptsLimit: 3
        });
        const focusedEditor = focusResult.editor || state.editor;
        if (!focusResult.ok) {
          const observedText = normalizeDetailText(focusedEditor?.label || "");
          attempts.push({
            stage: "normal",
            editor_node_id: focusedEditor?.node_id || state.editor.node_id,
            editor_selector: focusedEditor?.selector || state.editor.selector || null,
            editor_trace_id: focusedEditor?.attributes?.traceid || state.editor.attributes?.traceid || null,
            input_mode: null,
            chunk_count: 0,
            expected_length: expectedText.length,
            observed_length: observedText.length,
            exact_match: false,
            focus_verified: false,
            focus_attempts: focusResult.attempts,
            terminal_focus_binding_failure: focusResult.terminal_focus_binding_failure === true,
            focus_binding_error: focusResult.focus_binding_error || null
          });
          lastState = {
            ...(focusResult.state || state),
            editor_focus_unverified: true,
            terminal_focus_binding_failure: focusResult.terminal_focus_binding_failure === true,
            focus_binding_error: focusResult.focus_binding_error || null,
            editor_text_length: observedText.length
          };
          if (focusResult.terminal_focus_binding_failure) {
            return {
              ok: false,
              error: "CHAT_EDITOR_MESSAGE_MISMATCH",
              editor_found: true,
              attempts,
              deterministic_fallback_attempted: false,
              state: lastState
            };
          }
          break;
        }
        const clearSkipped = normalizeDetailText(focusedEditor.label || "") === "";
        const nativeFocusBackendNodeId = Number(focusResult.native_focus_backend_node_id);
        let preClearFocusSettle = null;
        let preClearBinding = {
          required: false,
          verified: true
        };
        if (Number.isInteger(nativeFocusBackendNodeId) && nativeFocusBackendNodeId > 0) {
          preClearFocusSettle = await waitForFreshChatEditorFocus(client, {
            initialDelayMs: 80
          });
          preClearBinding = await verifyChatEditorBackendBinding(
            client,
            preClearFocusSettle.editor,
            preClearFocusSettle.focus,
            nativeFocusBackendNodeId
          );
          if (!preClearBinding.verified) {
            attempts.push({
              stage: "normal",
              editor_node_id: preClearFocusSettle.editor?.node_id || null,
              editor_selector: preClearFocusSettle.editor?.selector || focusedEditor.selector || null,
              editor_trace_id: preClearFocusSettle.editor?.attributes?.traceid || focusedEditor.attributes?.traceid || null,
              input_mode: null,
              chunk_count: 0,
              expected_length: expectedText.length,
              observed_length: normalizeDetailText(focusedEditor.label || "").length,
              exact_match: false,
              focus_verified: false,
              terminal_focus_binding_failure: true,
              focus_binding_error: preClearBinding.error || null,
              focus_attempts: focusResult.attempts,
              pre_clear_focus: preClearFocusSettle.focus,
              pre_clear_focus_observations: preClearFocusSettle.observations,
              pre_clear_binding: preClearBinding,
              clear_skipped: true
            });
            lastState = {
              editor: preClearFocusSettle.editor,
              terminal_focus_binding_failure: true,
              focus_binding_error: preClearBinding.error || null,
              editor_focus_unverified: true
            };
            return {
              ok: false,
              error: "CHAT_EDITOR_MESSAGE_MISMATCH",
              editor_found: true,
              attempts,
              deterministic_fallback_attempted: false,
              state: lastState
            };
          }
        }
        if (!clearSkipped) await clearFocusedInput(client);
        const preInsertFocusSettle = clearSkipped && preClearFocusSettle
          ? preClearFocusSettle
          : await waitForFreshChatEditorFocus(client, {
              initialDelayMs: 80
            });
        const preInsertEditor = preInsertFocusSettle.editor;
        const preInsertState = { editor: preInsertEditor };
        const preInsertFocus = preInsertFocusSettle.focus;
        const preInsertBinding = clearSkipped && preClearFocusSettle
          ? preClearBinding
          : await verifyChatEditorBackendBinding(
              client,
              preInsertEditor,
              preInsertFocus,
              nativeFocusBackendNodeId
            );
        if (!preInsertFocus.focused || !preInsertBinding.verified) {
          attempts.push({
            stage: "normal",
            editor_node_id: preInsertEditor?.node_id || null,
            editor_node_changed_before_insert: Boolean(
              preInsertEditor?.node_id
              && preInsertEditor.node_id !== focusedEditor.node_id
            ),
            editor_selector: preInsertEditor?.selector || focusedEditor.selector || null,
            editor_trace_id: preInsertEditor?.attributes?.traceid || focusedEditor.attributes?.traceid || null,
            input_mode: null,
            chunk_count: 0,
            expected_length: expectedText.length,
            observed_length: normalizeDetailText(focusedEditor.label || "").length,
            exact_match: false,
            focus_verified: false,
            focus_lost_before_insert: true,
            terminal_focus_binding_failure: preInsertBinding.required && !preInsertBinding.verified,
            focus_binding_error: preInsertBinding.error || null,
            focus_attempts: focusResult.attempts,
            pre_insert_focus: preInsertFocus,
            pre_insert_binding: preInsertBinding,
            pre_insert_focus_poll_count: preInsertFocusSettle.poll_count,
            pre_insert_focus_settle_elapsed_ms: preInsertFocusSettle.elapsed_ms,
            pre_insert_focus_observations: preInsertFocusSettle.observations,
            clear_skipped: clearSkipped
          });
          lastState = {
            ...preInsertState,
            editor_focus_lost_before_insert: true,
            terminal_focus_binding_failure: preInsertBinding.required && !preInsertBinding.verified,
            focus_binding_error: preInsertBinding.error || null
          };
          if (preInsertBinding.required && !preInsertBinding.verified) {
            return {
              ok: false,
              error: "CHAT_EDITOR_MESSAGE_MISMATCH",
              editor_found: true,
              attempts,
              deterministic_fallback_attempted: false,
              state: lastState
            };
          }
          break;
        }
        const inputResult = await insertText(client, message);
        await sleep(250);
        const afterState = await readChatConversationReadyState(client);
        const editorText = normalizeDetailText(afterState.editor?.label || "");
        const exactMatch = editorText === expectedText;
        attempts.push({
          stage: "normal",
          editor_node_id: preInsertEditor?.node_id || focusedEditor.node_id,
          editor_node_changed_before_insert: Boolean(
            preInsertEditor?.node_id
            && preInsertEditor.node_id !== focusedEditor.node_id
          ),
          editor_selector: preInsertEditor?.selector || focusedEditor.selector || null,
          editor_trace_id: preInsertEditor?.attributes?.traceid || focusedEditor.attributes?.traceid || null,
          input_mode: inputResult?.mode || null,
          chunk_count: Number(inputResult?.chunk_count || 0),
          expected_length: expectedText.length,
          observed_length: editorText.length,
          exact_match: exactMatch,
          focus_verified: true,
          focus_attempts: focusResult.attempts,
          pre_insert_focus: preInsertFocus,
          pre_insert_binding: preInsertBinding,
          pre_insert_focus_poll_count: preInsertFocusSettle.poll_count,
          pre_insert_focus_settle_elapsed_ms: preInsertFocusSettle.elapsed_ms,
          pre_insert_focus_observations: preInsertFocusSettle.observations,
          clear_skipped: clearSkipped,
          read_error: afterState.editor?.read_error || null
        });
        if (exactMatch) {
          return {
            ok: true,
            value: editorText,
            editor: afterState.editor || state.editor,
            attempts,
            deterministic_fallback_attempted: false
          };
        }
        lastState = {
          ...afterState,
          editor_message_mismatch: true,
          editor_text_length: editorText.length
        };
        break;
      } catch (error) {
        if (!isRecoverableNodeError(error)) throw error;
        attempts.push({
          stage: "normal",
          editor_node_id: state.editor.node_id,
          editor_selector: state.editor.selector || null,
          editor_trace_id: state.editor.attributes?.traceid || null,
          expected_length: expectedText.length,
          exact_match: false,
          recoverable_error: error?.message || String(error)
        });
        lastState = {
          ...state,
          recoverable_error: error?.message || String(error),
          recoverable_phase: "set_editor_message"
        };
      }
    }
    await sleep(250);
  }

  // A chat transition can briefly steal focus or remount the contenteditable
  // while human-style chunked input is in progress. No outbound action has
  // started yet, so one freshly reacquired, deterministic editor-only retry is
  // safe. The message still must be read back exactly before callers may send.
  let deterministicFallbackAttempted = false;
  const fallbackState = await readChatConversationReadyState(client);
  lastState = fallbackState || lastState;
  if (fallbackState?.editor?.node_id) {
    editorFound = true;
    deterministicFallbackAttempted = true;
    try {
      const focusResult = await focusChatEditorForInput(client, fallbackState.editor, {
        deterministic: true,
        attemptsLimit: 3
      });
      const focusedEditor = focusResult.editor || fallbackState.editor;
      if (!focusResult.ok) {
        const observedText = normalizeDetailText(focusedEditor?.label || "");
        attempts.push({
          stage: "deterministic_fallback",
          editor_node_id: focusedEditor?.node_id || fallbackState.editor.node_id,
          editor_selector: focusedEditor?.selector || fallbackState.editor.selector || null,
          editor_trace_id: focusedEditor?.attributes?.traceid || fallbackState.editor.attributes?.traceid || null,
          input_mode: null,
          chunk_count: 0,
          expected_length: expectedText.length,
          observed_length: observedText.length,
          exact_match: false,
          focus_verified: false,
          focus_attempts: focusResult.attempts
        });
        lastState = {
          ...(focusResult.state || fallbackState),
          editor_focus_unverified: true,
          editor_text_length: observedText.length
        };
      } else {
        const clearSkipped = normalizeDetailText(focusedEditor.label || "") === "";
        const nativeFocusBackendNodeId = Number(focusResult.native_focus_backend_node_id);
        let preClearFocusSettle = null;
        let preClearBinding = {
          required: false,
          verified: true
        };
        if (Number.isInteger(nativeFocusBackendNodeId) && nativeFocusBackendNodeId > 0) {
          preClearFocusSettle = await waitForFreshChatEditorFocus(client, {
            initialDelayMs: 80
          });
          preClearBinding = await verifyChatEditorBackendBinding(
            client,
            preClearFocusSettle.editor,
            preClearFocusSettle.focus,
            nativeFocusBackendNodeId
          );
          if (!preClearBinding.verified) {
            attempts.push({
              stage: "deterministic_fallback",
              editor_node_id: preClearFocusSettle.editor?.node_id || null,
              editor_selector: preClearFocusSettle.editor?.selector || focusedEditor.selector || null,
              editor_trace_id: preClearFocusSettle.editor?.attributes?.traceid || focusedEditor.attributes?.traceid || null,
              input_mode: null,
              chunk_count: 0,
              expected_length: expectedText.length,
              observed_length: normalizeDetailText(focusedEditor.label || "").length,
              exact_match: false,
              focus_verified: false,
              terminal_focus_binding_failure: true,
              focus_binding_error: preClearBinding.error || null,
              focus_attempts: focusResult.attempts,
              pre_clear_focus: preClearFocusSettle.focus,
              pre_clear_focus_observations: preClearFocusSettle.observations,
              pre_clear_binding: preClearBinding,
              clear_skipped: true
            });
            lastState = {
              editor: preClearFocusSettle.editor,
              terminal_focus_binding_failure: true,
              focus_binding_error: preClearBinding.error || null,
              editor_focus_unverified: true
            };
            return {
              ok: false,
              error: "CHAT_EDITOR_MESSAGE_MISMATCH",
              editor_found: true,
              attempts,
              deterministic_fallback_attempted: true,
              state: lastState
            };
          }
        }
        if (!clearSkipped) await clearFocusedInput(client);
        const preInsertFocusSettle = clearSkipped && preClearFocusSettle
          ? preClearFocusSettle
          : await waitForFreshChatEditorFocus(client, {
              initialDelayMs: 80
            });
        const preInsertEditor = preInsertFocusSettle.editor;
        const preInsertState = { editor: preInsertEditor };
        const preInsertFocus = preInsertFocusSettle.focus;
        const preInsertBinding = clearSkipped && preClearFocusSettle
          ? preClearBinding
          : await verifyChatEditorBackendBinding(
              client,
              preInsertEditor,
              preInsertFocus,
              nativeFocusBackendNodeId
            );
        if (!preInsertFocus.focused || !preInsertBinding.verified) {
          attempts.push({
            stage: "deterministic_fallback",
            editor_node_id: preInsertEditor?.node_id || null,
            editor_node_changed_before_insert: Boolean(
              preInsertEditor?.node_id
              && preInsertEditor.node_id !== focusedEditor.node_id
            ),
            editor_selector: preInsertEditor?.selector || focusedEditor.selector || null,
            editor_trace_id: preInsertEditor?.attributes?.traceid || focusedEditor.attributes?.traceid || null,
            input_mode: null,
            chunk_count: 0,
            expected_length: expectedText.length,
            observed_length: normalizeDetailText(focusedEditor.label || "").length,
            exact_match: false,
            focus_verified: false,
            focus_lost_before_insert: true,
            terminal_focus_binding_failure: preInsertBinding.required && !preInsertBinding.verified,
            focus_binding_error: preInsertBinding.error || null,
            focus_attempts: focusResult.attempts,
            pre_insert_focus: preInsertFocus,
            pre_insert_binding: preInsertBinding,
            pre_insert_focus_poll_count: preInsertFocusSettle.poll_count,
            pre_insert_focus_settle_elapsed_ms: preInsertFocusSettle.elapsed_ms,
            pre_insert_focus_observations: preInsertFocusSettle.observations,
            clear_skipped: clearSkipped
          });
          lastState = {
            ...preInsertState,
            editor_focus_lost_before_insert: true,
            terminal_focus_binding_failure: preInsertBinding.required && !preInsertBinding.verified,
            focus_binding_error: preInsertBinding.error || null
          };
        } else {
          const inputResult = await insertText(client, message, {
            humanTextEntryEnabled: false
          });
          await sleep(350);
          const afterState = await readChatConversationReadyState(client);
          const editorText = normalizeDetailText(afterState.editor?.label || "");
          const exactMatch = editorText === expectedText;
          attempts.push({
            stage: "deterministic_fallback",
            editor_node_id: preInsertEditor?.node_id || focusedEditor.node_id,
            editor_node_changed_before_insert: Boolean(
              preInsertEditor?.node_id
              && preInsertEditor.node_id !== focusedEditor.node_id
            ),
            editor_selector: preInsertEditor?.selector || focusedEditor.selector || null,
            editor_trace_id: preInsertEditor?.attributes?.traceid || focusedEditor.attributes?.traceid || null,
            input_mode: inputResult?.mode || null,
            chunk_count: Number(inputResult?.chunk_count || 0),
            expected_length: expectedText.length,
            observed_length: editorText.length,
            exact_match: exactMatch,
            focus_verified: true,
            focus_attempts: focusResult.attempts,
            pre_insert_focus: preInsertFocus,
            pre_insert_binding: preInsertBinding,
            pre_insert_focus_poll_count: preInsertFocusSettle.poll_count,
            pre_insert_focus_settle_elapsed_ms: preInsertFocusSettle.elapsed_ms,
            pre_insert_focus_observations: preInsertFocusSettle.observations,
            clear_skipped: clearSkipped,
            read_error: afterState.editor?.read_error || null
          });
          if (exactMatch) {
            return {
              ok: true,
              value: editorText,
              editor: afterState.editor || preInsertEditor || focusedEditor,
              attempts,
              deterministic_fallback_attempted: true,
              recovery: {
                mode: "deterministic_reacquired_editor"
              }
            };
          }
          lastState = {
            ...afterState,
            editor_message_mismatch: true,
            editor_text_length: editorText.length
          };
        }
      }
    } catch (error) {
      if (!isRecoverableNodeError(error)) throw error;
      attempts.push({
        stage: "deterministic_fallback",
        editor_node_id: fallbackState.editor.node_id,
        editor_selector: fallbackState.editor.selector || null,
        editor_trace_id: fallbackState.editor.attributes?.traceid || null,
        expected_length: expectedText.length,
        exact_match: false,
        recoverable_error: error?.message || String(error)
      });
      lastState = {
        ...fallbackState,
        recoverable_error: error?.message || String(error),
        recoverable_phase: "set_editor_message_deterministic_fallback"
      };
    }
  }

  return {
    ok: false,
    error: editorFound ? "CHAT_EDITOR_MESSAGE_MISMATCH" : "CHAT_EDITOR_NOT_FOUND",
    editor_found: editorFound,
    attempts,
    deterministic_fallback_attempted: deterministicFallbackAttempted,
    state: lastState
  };
}

export async function sendChatMessage(client, expectedText = "", {
  timeoutMs = 8000,
  settleMs = 800
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    const state = await readChatConversationReadyState(client);
    lastState = state;
    if (state.send_button?.node_id && !state.send_button.disabled) {
      try {
        if (state.send_button.center) {
          await clickPoint(client, state.send_button.center.x, state.send_button.center.y);
        } else {
          await clickNodeCenter(client, state.send_button.node_id, { scrollIntoView: true });
        }
        if (settleMs > 0) await sleep(settleMs);
        return {
          sent: true,
          method: "send-button",
          control: state.send_button,
          expected_text: expectedText
        };
      } catch (error) {
        if (!isRecoverableNodeError(error)) throw error;
        lastState = {
          ...state,
          recoverable_error: error?.message || String(error),
          recoverable_phase: "send_button_click"
        };
        await sleep(250);
        continue;
      }
    }
    if (state.editor?.node_id) {
      await pressKey(client, "Enter", {
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13
      });
      if (settleMs > 0) await sleep(settleMs);
      return {
        sent: true,
        method: "enter",
        expected_text: expectedText
      };
    }
    await sleep(250);
  }
  return {
    sent: false,
    method: "none",
    error: "CHAT_SEND_CONTROL_NOT_FOUND",
    state: lastState
  };
}

export async function clickChatAskResume(client, {
  timeoutMs = 8000,
  settleMs = 700,
  skipWhenAttachmentResumeAvailable = true
} = {}) {
  const started = Date.now();
  let lastState = null;
  let lastDisabledAskResume = null;
  while (Date.now() - started <= timeoutMs) {
    const state = await readChatConversationReadyState(client);
    lastState = state;
    if (skipWhenAttachmentResumeAvailable && state.attachment_resume_enabled) {
      return {
        ok: true,
        already_requested: true,
        attachment_resume_available: true,
        control: state.attachment_resume
      };
    }
    if (state.ask_resume?.node_id && !state.ask_resume.disabled) {
      try {
        if (state.ask_resume.center) {
          await clickPoint(client, state.ask_resume.center.x, state.ask_resume.center.y);
        } else {
          await clickNodeCenter(client, state.ask_resume.node_id, { scrollIntoView: true });
        }
        if (settleMs > 0) await sleep(settleMs);
        return {
          ok: true,
          already_requested: false,
          control: state.ask_resume
        };
      } catch (error) {
        if (!isRecoverableNodeError(error)) throw error;
        lastState = {
          ...state,
          recoverable_error: error?.message || String(error),
          recoverable_phase: "ask_resume_click"
        };
      }
    }
    if (state.ask_resume?.node_id && state.ask_resume.disabled) {
      lastDisabledAskResume = state.ask_resume;
    }
    if (state.already_requested_resume) {
      return {
        ok: true,
        already_requested: true,
        control: state.requested_resume
      };
    }
    await sleep(250);
  }
  if (lastDisabledAskResume) {
    return {
      ok: false,
      already_requested: false,
      request_pending: false,
      error: "ASK_RESUME_BUTTON_DISABLED",
      control: lastDisabledAskResume,
      state: lastState
    };
  }
  return {
    ok: false,
    error: "ASK_RESUME_BUTTON_NOT_FOUND",
    state: lastState
  };
}

export function resolveChatConfirmResumeTimeoutMs(value) {
  const hasExplicitValue = value !== null
    && value !== undefined
    && !(typeof value === "string" && value.trim() === "");
  if (!hasExplicitValue) return CHAT_REQUEST_RESUME_CONFIRM_DEFAULT_TIMEOUT_MS;
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue)
    ? Math.max(0, parsedValue)
    : CHAT_REQUEST_RESUME_CONFIRM_DEFAULT_TIMEOUT_MS;
}

export async function clickChatConfirmRequestResume(client, {
  timeoutMs = null,
  settleMs = 900,
  pollIntervalMs = CHAT_REQUEST_RESUME_CONFIRM_POLL_INTERVAL_MS
} = {}) {
  const effectiveTimeoutMs = resolveChatConfirmResumeTimeoutMs(timeoutMs);
  const parsedPollIntervalMs = Number(pollIntervalMs);
  const effectivePollIntervalMs = Number.isFinite(parsedPollIntervalMs)
    ? Math.max(1, parsedPollIntervalMs)
    : CHAT_REQUEST_RESUME_CONFIRM_POLL_INTERVAL_MS;
  const started = Date.now();
  let lastPrompt = null;
  let lastTarget = null;
  let lastState = null;
  let discoveryMode = null;
  let pollCount = 0;
  let firstPromptObservedElapsedMs = null;
  let firstTargetObservedElapsedMs = null;
  let lastPromptReadError = null;
  let lastTargetReadError = null;
  let clickAttempted = false;
  let clickDispatched = false;
  const diagnostics = () => ({
    timeout_ms: effectiveTimeoutMs,
    poll_interval_ms: effectivePollIntervalMs,
    poll_count: pollCount,
    elapsed_ms: Math.max(0, Date.now() - started),
    discovery_mode: discoveryMode,
    prompt_observed: Boolean(lastPrompt),
    first_prompt_observed_elapsed_ms: firstPromptObservedElapsedMs,
    last_prompt_read_error: lastPromptReadError,
    target_observed: Boolean(lastTarget),
    first_target_observed_elapsed_ms: firstTargetObservedElapsedMs,
    last_target_read_error: lastTargetReadError,
    click_attempted: clickAttempted,
    click_dispatched: clickDispatched
  });

  while (true) {
    pollCount += 1;
    lastState = await readChatConversationReadyState(client);
    if (lastState.already_requested_resume || lastState.attachment_resume_enabled) {
      return {
        confirmed: true,
        assumed_requested: true,
        reason: lastState.attachment_resume_enabled
          ? "attachment_resume_available"
          : "request_state_observed",
        control: lastState.requested_resume || lastState.attachment_resume || null,
        prompt: lastPrompt,
        state: lastState,
        ...diagnostics()
      };
    }
    const rootState = await getChatRoots(client);
    let discovered;
    try {
      discovered = await findAnchoredChatRequestResumeConfirmTarget(
        client,
        rootState.roots
      );
    } catch (error) {
      if (!isRecoverableNodeError(error)) throw error;
      lastTargetReadError = error?.message || String(error);
      discovered = {
        prompt: null,
        prompt_candidate: null,
        target: null,
        target_candidate: null,
        discovery_mode: null
      };
    }
    lastPromptReadError = discovered.prompt_candidate?.read_error || lastPromptReadError;
    lastTargetReadError = discovered.target_candidate?.read_error || lastTargetReadError;
    if (discovered.prompt) {
      lastPrompt = discovered.prompt;
      discoveryMode = discovered.discovery_mode;
      if (firstPromptObservedElapsedMs === null) {
        firstPromptObservedElapsedMs = Math.max(0, Date.now() - started);
      }
    }
    lastTarget = discovered.target;
    if (lastTarget && firstTargetObservedElapsedMs === null) {
      firstTargetObservedElapsedMs = Math.max(0, Date.now() - started);
    }
    if (lastTarget?.node_id) {
      clickAttempted = true;
      try {
        if (lastTarget.center) {
          await clickPoint(client, lastTarget.center.x, lastTarget.center.y);
        } else {
          await clickNodeCenter(client, lastTarget.node_id, { scrollIntoView: true });
        }
        clickDispatched = true;
        if (settleMs > 0) await sleep(settleMs);
        const afterState = await readChatConversationReadyState(client);
        return {
          confirmed: true,
          assumed_requested: Boolean(afterState.already_requested_resume),
          control: lastTarget,
          prompt: lastPrompt,
          state: afterState,
          ...diagnostics()
        };
      } catch (error) {
        if (!isRecoverableNodeError(error)) throw error;
        const control = {
          ...lastTarget,
          recoverable_error: error?.message || String(error),
          recoverable_phase: clickDispatched
            ? "confirm_request_resume_post_click_state"
            : "confirm_request_resume_click"
        };
        return {
          confirmed: false,
          outcome_unknown: true,
          error: clickDispatched
            ? "CONFIRM_CLICK_OUTCOME_UNKNOWN"
            : "CONFIRM_CLICK_FAILED",
          control,
          prompt: lastPrompt,
          state: lastState,
          ...diagnostics()
        };
      }
    }
    const elapsedMs = Date.now() - started;
    if (elapsedMs >= effectiveTimeoutMs) break;
    await sleep(Math.min(
      effectivePollIntervalMs,
      Math.max(1, effectiveTimeoutMs - elapsedMs)
    ));
  }
  return {
    confirmed: false,
    error: "CONFIRM_BUTTON_NOT_FOUND",
    control: null,
    prompt: lastPrompt,
    state: lastState,
    ...diagnostics()
  };
}

export async function getChatResumeRequestMessageState(client) {
  const rootState = await getChatRoots(client);
  let messageRoot = null;
  for (const root of rootState.roots) {
    for (const selector of CHAT_MESSAGE_LIST_SELECTORS) {
      const nodeIds = await querySelectorAll(client, root.nodeId, selector);
      if (nodeIds.length) {
        messageRoot = {
          root,
          selector,
          node_id: nodeIds[0]
        };
        break;
      }
    }
    if (messageRoot) break;
  }
  const nodeId = messageRoot?.node_id || rootState.rootNodes.top;
  let text = "";
  try {
    text = htmlToText(await getOuterHTML(client, nodeId));
  } catch {}
  const lines = text.split(/\r?\n/).map(normalizeDetailText).filter(Boolean);
  const matching = lines.filter((line) => isResumeRequestSentMessageText(line));
  const attachmentMatching = lines.filter((line) => isResumeAttachmentMessageText(line));
  const count = countResumeRequestSentMessageMarkers(lines);
  const resumeAttachmentCount = countResumeAttachmentMessageMarkers(lines);
  return {
    ok: Boolean(text),
    selector: messageRoot?.selector || "top",
    count,
    resume_attachment_count: resumeAttachmentCount,
    success_count: count + resumeAttachmentCount,
    last_text: matching[matching.length - 1] || lines[lines.length - 1] || "",
    last_resume_attachment_text: attachmentMatching[attachmentMatching.length - 1] || "",
    last_success_text: matching[matching.length - 1] || attachmentMatching[attachmentMatching.length - 1] || "",
    recent: lines.slice(-12)
  };
}

export async function readChatRequestVerificationEvidence(client) {
  // Both readers reacquire the document root. Running them concurrently can
  // invalidate the first reader's frontend node IDs when the second
  // DOM.getDocument call refreshes Chrome's node-id namespace.
  const messageState = await getChatResumeRequestMessageState(client);
  const readyState = await readChatConversationReadyState(client);
  return {
    message_state: messageState,
    ready_state: readyState
  };
}

const CHAT_GREETING_DELIVERY_PREFIX_PATTERN = /^(?:送达|已送达|已读|未读)\s*/u;

export function isExactChatGreetingMessageText(value = "", expectedValue = "") {
  const line = normalizeDetailText(value);
  const expected = normalizeDetailText(expectedValue);
  if (!line || !expected) return false;
  if (line === expected) return true;
  return normalizeDetailText(line.replace(CHAT_GREETING_DELIVERY_PREFIX_PATTERN, "")) === expected;
}

export async function getChatGreetingMessageState(client, greetingText = "") {
  const expected = normalizeDetailText(greetingText);
  const rootState = await getChatRoots(client);
  let messageRoot = null;
  for (const root of rootState.roots) {
    for (const selector of CHAT_MESSAGE_LIST_SELECTORS) {
      const nodeIds = await querySelectorAll(client, root.nodeId, selector);
      if (nodeIds.length) {
        messageRoot = {
          root,
          selector,
          node_id: nodeIds[0]
        };
        break;
      }
    }
    if (messageRoot) break;
  }
  if (!messageRoot?.node_id || !expected) {
    return {
      ok: false,
      selector: messageRoot?.selector || null,
      expected_text: expected,
      exact_count: 0,
      recent: []
    };
  }
  let text = "";
  try {
    text = htmlToText(await getOuterHTML(client, messageRoot.node_id));
  } catch {}
  const lines = text.split(/\r?\n/).map(normalizeDetailText).filter(Boolean);
  return {
    ok: Boolean(text),
    selector: messageRoot.selector,
    expected_text: expected,
    exact_count: lines.filter((line) => isExactChatGreetingMessageText(line, expected)).length,
    recent: lines.slice(-12)
  };
}

export async function waitForChatResumeRequestMessage(client, {
  baselineCount = 0,
  baselineResumeAttachmentCount = 0,
  timeoutMs = 6500,
  intervalMs = 260
} = {}) {
  const started = Date.now();
  let state = null;
  while (true) {
    state = await getChatResumeRequestMessageState(client);
    const observed = (
      state.count > baselineCount
      || state.resume_attachment_count > baselineResumeAttachmentCount
    );
    if (observed) {
      return {
        observed: true,
        elapsed_ms: Date.now() - started,
        state
      };
    }
    const elapsedMs = Date.now() - started;
    if (elapsedMs >= timeoutMs) break;
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - elapsedMs)));
  }
  return {
    observed: false,
    elapsed_ms: Date.now() - started,
    state
  };
}

export function resolveChatRequestVerificationTimeoutMs(value, maxAttempts = 3) {
  const parsedAttempts = Number(maxAttempts);
  const effectiveAttempts = Number.isFinite(parsedAttempts)
    ? Math.max(0, parsedAttempts)
    : 3;
  const fallbackMs = Math.max(6500, Math.min(20000, effectiveAttempts * 3250));
  const hasExplicitValue = value !== null
    && value !== undefined
    && !(typeof value === "string" && value.trim() === "");
  if (!hasExplicitValue) return fallbackMs;
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue)
    ? Math.max(0, parsedValue)
    : fallbackMs;
}

export async function requestChatResumeForPassedCandidate(client, {
  greetingText = "Hi同学，能麻烦发下简历吗？",
  maxAttempts = 3,
  askResumeTimeoutMs = 8000,
  confirmResumeTimeoutMs = null,
  confirmResumePollIntervalMs = CHAT_REQUEST_RESUME_CONFIRM_POLL_INTERVAL_MS,
  requestVerificationTimeoutMs = null,
  requestFinalVerificationSettleMs = 260,
  dryRun = false,
  skipWhenAttachmentResumeAvailable = true,
  skipGreeting = false,
  actionTransition = null
} = {}) {
  const effectiveGreetingText = normalizeDetailText(greetingText) || "Hi同学，能麻烦发下简历吗？";
  const initialState = await readChatConversationReadyState(client);
  if (skipWhenAttachmentResumeAvailable && initialState.attachment_resume_enabled) {
    return {
      requested: false,
      skipped: true,
      reason: "attachment_resume_already_available",
      initial_state: initialState
    };
  }
  if (initialState.already_requested_resume) {
    return {
      requested: false,
      skipped: true,
      reason: "resume_request_already_pending",
      initial_state: initialState
    };
  }
  if (dryRun) {
    return {
      requested: false,
      skipped: false,
      reason: "dry_run",
      initial_state: initialState,
      would_send_greeting: true,
      would_click_ask_resume: true
    };
  }

  const closeBeforeGreeting = await closeChatResumeModal(client, { attemptsLimit: 3 });
  if (!closeBeforeGreeting.closed) {
    return {
      requested: false,
      skipped: true,
      reason: "resume_modal_close_failed_before_request",
      initial_state: initialState,
      close_before_greeting: closeBeforeGreeting
    };
  }
  let greetingBaseline = null;
  let editorState = null;
  let sendResult = null;
  if (!skipGreeting) {
    greetingBaseline = await getChatGreetingMessageState(client, effectiveGreetingText);
    editorState = await setChatEditorMessage(client, effectiveGreetingText);
    if (!editorState.ok) {
      const error = new Error(editorState.error || "CHAT_EDITOR_MESSAGE_MISMATCH");
      error.code = editorState.error || "CHAT_EDITOR_MESSAGE_MISMATCH";
      error.retryable = true;
      error.attempts = Array.isArray(editorState.attempts)
        ? editorState.attempts
        : [];
      throw error;
    }
    if (typeof actionTransition === "function") {
      await actionTransition("greeting_send_in_flight", {
        greeting_baseline_count: greetingBaseline.exact_count,
        greeting_evidence_readable: greetingBaseline.ok
      });
    }
    sendResult = await sendChatMessage(client, effectiveGreetingText);
    if (!sendResult.sent) {
      if (typeof actionTransition === "function") {
        await actionTransition("outcome_unknown", {
          action: "greeting_send",
          reason: sendResult.error || sendResult.method || "unknown"
        });
      }
      throw new Error(`CHAT_GREETING_SEND_FAILED:${sendResult.error || sendResult.method || "unknown"}`);
    }
    const postGreetingPageState = await getChatTopLevelState(client);
    if (postGreetingPageState.is_security_verification) {
      if (typeof actionTransition === "function") {
        await actionTransition("outcome_unknown", {
          action: "greeting_send",
          reason: "boss_security_verification_required"
        });
      }
      throw makeBossSecurityVerificationRequiredError(
        postGreetingPageState,
        "chat_greeting_confirmation"
      );
    }
    if (typeof actionTransition === "function") {
      await actionTransition("greeting_confirmed", {
        greeting_baseline_count: greetingBaseline.exact_count,
        send_method: sendResult.method || null
      });
    }
  }

  const attempts = [];
  const before = await getChatResumeRequestMessageState(client);
  if (typeof actionTransition === "function") {
    await actionTransition("request_in_flight", {
      request_baseline_count: before.count,
      resume_attachment_baseline_count: before.resume_attachment_count || 0
    });
  }
  const askResult = await clickChatAskResume(client, {
    timeoutMs: askResumeTimeoutMs,
    skipWhenAttachmentResumeAvailable
  });
  let confirmResult = {
    confirmed: false,
    assumed_requested: Boolean(askResult.already_requested),
    skipped: true,
    reason: askResult.attachment_resume_available
      ? "attachment_resume_already_available"
      : askResult.request_pending
        ? "resume_request_already_pending"
        : askResult.ok
          ? "already_requested"
          : (askResult.error || "ask_resume_not_clicked")
  };
  if (askResult.ok && !askResult.already_requested) {
    confirmResult = await clickChatConfirmRequestResume(client, {
      timeoutMs: confirmResumeTimeoutMs,
      pollIntervalMs: confirmResumePollIntervalMs
    });
  }
  let messageCheck = (askResult.attachment_resume_available || askResult.request_pending || askResult.already_requested)
    ? { observed: false, state: before, elapsed_ms: 0 }
    : await waitForChatResumeRequestMessage(client, {
        baselineCount: before.count,
        baselineResumeAttachmentCount: before.resume_attachment_count,
        timeoutMs: resolveChatRequestVerificationTimeoutMs(
          requestVerificationTimeoutMs,
          maxAttempts
        )
      });
  let finalReadyState = confirmResult?.assumed_requested
    ? (confirmResult.state || null)
    : null;
  let passiveVerificationAttempted = false;
  if (!messageCheck.observed && !finalReadyState) {
    passiveVerificationAttempted = true;
    const settleMs = Math.max(0, Number(requestFinalVerificationSettleMs) || 0);
    if (settleMs > 0) await sleep(settleMs);
    const {
      message_state: freshMessageState,
      ready_state: freshReadyState
    } = await readChatRequestVerificationEvidence(client);
    messageCheck = {
      observed: Boolean(
        freshMessageState.count > before.count
        || freshMessageState.resume_attachment_count > before.resume_attachment_count
      ),
      elapsed_ms: messageCheck.elapsed_ms + settleMs,
      state: freshMessageState,
      passive_final_read: true
    };
    finalReadyState = freshReadyState;
  }
  const postRequestPageState = await getChatTopLevelState(client);
  if (postRequestPageState.is_security_verification) {
    if (typeof actionTransition === "function") {
      await actionTransition("outcome_unknown", {
        action: "request_resume",
        reason: "boss_security_verification_required"
      });
    }
    throw makeBossSecurityVerificationRequiredError(
      postRequestPageState,
      "chat_resume_request_confirmation"
    );
  }
  const messageObserved = Boolean(
    (messageCheck.state?.count || 0) > (before.count || 0)
  );
  const attachmentObserved = Boolean(
    (messageCheck.state?.resume_attachment_count || 0) > (before.resume_attachment_count || 0)
  );
  const readyStateObserved = Boolean(
    finalReadyState?.already_requested_resume
    || finalReadyState?.attachment_resume_enabled
  );
  const requestObserved = messageObserved || attachmentObserved || readyStateObserved;
  const confirmationSource = messageObserved
    ? "message_delta"
    : attachmentObserved
      ? "attachment_resume_delta"
      : finalReadyState?.already_requested_resume
        ? "exact_requested_resume_state"
        : finalReadyState?.attachment_resume_enabled
          ? "attachment_resume_available"
          : null;
  attempts.push({
    attempt: 1,
    ask_result: askResult,
    confirm_result: confirmResult,
    message_before_count: before.count,
    message_after_count: messageCheck.state?.count || 0,
    resume_attachment_before_count: before.resume_attachment_count || 0,
    resume_attachment_after_count: messageCheck.state?.resume_attachment_count || 0,
    message_observed: messageObserved,
    message_last_text: messageCheck.state?.last_success_text || messageCheck.state?.last_text || "",
    ready_state_observed: readyStateObserved,
    confirmation_source: confirmationSource,
    passive_verification_attempted: passiveVerificationAttempted
  });

  const satisfiedReason = askResult.attachment_resume_available
    ? "attachment_resume_already_available"
    : (askResult.request_pending || askResult.already_requested)
      ? "resume_request_already_pending"
      : requestObserved
        ? "requested"
        : "";
  if (satisfiedReason) {
    if (typeof actionTransition === "function") {
      await actionTransition("request_confirmed", {
        reason: satisfiedReason,
        message_observed: messageObserved,
        request_ready_state_observed: readyStateObserved,
        request_confirmation_source: confirmationSource,
        request_after_count: messageCheck.state?.count || before.count,
        resume_attachment_after_count: messageCheck.state?.resume_attachment_count || before.resume_attachment_count || 0
      });
    }
    return {
      requested: satisfiedReason === "requested",
      skipped: satisfiedReason !== "requested",
      reason: satisfiedReason,
      initial_state: initialState,
      close_before_greeting: closeBeforeGreeting,
      greeting_sent: !skipGreeting,
      greeting_skipped_from_journal: Boolean(skipGreeting),
      greeting_send_result: sendResult,
      attempts
    };
  }

  if (typeof actionTransition === "function") {
    await actionTransition("outcome_unknown", {
      action: "request_resume",
      reason: "resume_request_message_not_observed",
      ask_result: {
        ok: Boolean(askResult.ok),
        error: askResult.error || null
      },
      confirm_result: {
        confirmed: Boolean(confirmResult.confirmed),
        error: confirmResult.error || null
      }
    });
  }
  return {
    requested: false,
    skipped: false,
    reason: "resume_request_message_not_observed",
    outcome_unknown: true,
    initial_state: initialState,
    close_before_greeting: closeBeforeGreeting,
    greeting_sent: !skipGreeting,
    greeting_skipped_from_journal: Boolean(skipGreeting),
    greeting_send_result: sendResult,
    attempts
  };
}

export async function closeChatResumeModal(client, {
  attemptsLimit = 3
} = {}) {
  const attempts = [];
  for (let index = 0; index < attemptsLimit; index += 1) {
    const existingState = await waitForChatResumeModal(client, { timeoutMs: 500 });
    if (!existingState?.popup && !existingState?.content && !existingState?.resumeIframe) {
      return {
        closed: true,
        attempts
      };
    }

    const rootState = await getChatRoots(client);
    const closeTarget = await findVisibleTarget(client, rootState.roots, CHAT_RESUME_CLOSE_SELECTORS);
    if (closeTarget) {
      try {
        await clickPoint(client, closeTarget.center.x, closeTarget.center.y, DETERMINISTIC_CLICK_OPTIONS);
        attempts.push({
          mode: "close-selector",
          selector: closeTarget.selector,
          root: closeTarget.root
        });
      } catch (error) {
        attempts.push({
          mode: "close-selector-error",
          selector: closeTarget.selector,
          root: closeTarget.root,
          error: error?.message || String(error)
        });
      }
      await sleep(700);
    } else {
      await pressEscape(client);
      attempts.push({ mode: "Escape" });
      await sleep(700);
    }

    let state = await waitForChatResumeModal(client, { timeoutMs: 1000 });
    if (!state?.popup && !state?.content && !state?.resumeIframe) {
      return {
        closed: true,
        attempts
      };
    }

    await pressEscape(client);
    attempts.push({ mode: "Escape-fallback" });
    await sleep(700);

    state = await waitForChatResumeModal(client, { timeoutMs: 1000 });
    if (!state?.popup && !state?.content && !state?.resumeIframe) {
      return {
        closed: true,
        attempts
      };
    }
  }

  return {
    closed: false,
    attempts
  };
}

export async function extractChatProfileCandidate(client, {
  cardCandidate,
  cardNodeId,
  resumeState,
  resumeHtml: providedResumeHtml = null,
  networkEvents = [],
  targetUrl = "",
  closeResume = true,
  networkParseRetryMs = 1800,
  networkParseIntervalMs = 250
} = {}) {
  let resumeHtml = providedResumeHtml || null;
  if (!resumeHtml) {
    try {
      resumeHtml = await readChatResumeHtml(client, resumeState);
    } catch (error) {
      if (!networkEvents.length) throw error;
      resumeHtml = emptyChatResumeHtml(error);
    }
  }
  const detailText = [
    resumeHtml.popupText,
    resumeHtml.contentText,
    resumeHtml.resumeIframeText
  ].filter(Boolean).join("\n\n");

  const parseStarted = Date.now();
  let networkBodies = [];
  let detailCandidateResult = null;
  do {
    networkBodies = await readChatProfileNetworkBodies(client, networkEvents);
    detailCandidateResult = buildScreeningCandidateFromDetail({
      domain: "chat",
      source: "chat-live-cdp-profile",
      cardCandidate,
      detailText,
      networkBodies,
      metadata: {
        target_url: targetUrl,
        card_node_id: cardNodeId,
        resume_popup_selector: resumeState?.popup?.selector || null,
        resume_content_selector: resumeState?.content?.selector || null,
        resume_iframe_selector: resumeState?.resumeIframe?.selector || null,
        resume_iframe_document_node_id: resumeHtml.resumeIframeDocumentNodeId
      }
    });
    if (detailCandidateResult.parsed_network_profiles.some((item) => item.ok)) break;
    if (Date.now() - parseStarted >= Math.max(0, Number(networkParseRetryMs) || 0)) break;
    await sleep(Math.max(50, Number(networkParseIntervalMs) || 250));
  } while (true);

  let closeResult = null;
  if (closeResume) {
    closeResult = await closeChatResumeModal(client);
  }

  return {
    candidate: detailCandidateResult.candidate,
    parsed_network_profiles: detailCandidateResult.parsed_network_profiles,
    network_bodies: networkBodies,
    network_parse_retry_elapsed_ms: Date.now() - parseStarted,
    network_event_count: networkEvents.length,
    detail: {
      popup_text: resumeHtml.popupText,
      content_text: resumeHtml.contentText,
      resume_iframe_text: resumeHtml.resumeIframeText,
      popup_html_length: resumeHtml.popupHTML.length,
      content_html_length: resumeHtml.contentHTML.length,
      resume_iframe_html_length: resumeHtml.resumeIframeHTML.length
    },
    resume_html_read_error: resumeHtml.readError || null,
    close_result: closeResult
  };
}

async function findVisibleTarget(client, roots, selectors) {
  let fallback = null;
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      const nodeIds = await querySelectorAll(client, root.nodeId, selector);
      for (const nodeId of nodeIds) {
        const target = {
          root: root.name,
          root_node_id: root.nodeId,
          selector,
          node_id: nodeId
        };
        if (!fallback) fallback = target;
        try {
          const box = await getNodeBox(client, nodeId);
          if (box.rect.width > 2 && box.rect.height > 2) {
            return {
              ...target,
              center: box.center,
              rect: box.rect
            };
          }
        } catch {}
      }
    }
  }
  return fallback;
}

async function pressEscape(client) {
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
}
