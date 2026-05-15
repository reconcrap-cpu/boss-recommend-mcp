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
  CHAT_ACTIVE_CANDIDATE_SELECTORS,
  CHAT_ASK_RESUME_BUTTON_SELECTORS,
  CHAT_ATTACHMENT_RESUME_BUTTON_SELECTORS,
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
  makeForbiddenChatResumeNavigationError
} from "./page-guard.js";

export const CHAT_UNSAFE_ONLINE_RESUME_LINK_CODE = "CHAT_UNSAFE_ONLINE_RESUME_LINK";

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
    || normalized.includes("已发送")
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
  const markers = ["简历请求已发送", "已发送简历", "已求简历", "已索要简历", "已发送"];
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

function isConfirmText(text = "") {
  const normalized = normalizeDetailText(text);
  return Boolean(
    normalized === "确定"
    || normalized === "确认"
    || normalized === "提交"
    || normalized === "继续"
    || normalized.includes("确定")
    || normalized.includes("确认")
  );
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
    resume_modal_open: Boolean(resumeState?.popup || resumeState?.content || resumeState?.resumeIframe),
    panels_closed: !Boolean(resumeState?.popup || resumeState?.content || resumeState?.resumeIframe)
  };
}

export async function setChatEditorMessage(client, message, {
  timeoutMs = 8000
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    const state = await readChatConversationReadyState(client);
    lastState = state;
    if (state.editor?.node_id) {
      try {
        if (state.editor.center) {
          await clickPoint(client, state.editor.center.x, state.editor.center.y);
        } else {
          await clickNodeCenter(client, state.editor.node_id, { scrollIntoView: true });
        }
        await sleep(120);
        await clearFocusedInput(client);
        await sleep(80);
        await insertText(client, message);
        await sleep(250);
        const afterState = await readChatConversationReadyState(client);
        const editorText = normalizeDetailText(afterState.editor?.label || "");
        if (editorText.includes(normalizeDetailText(message))) {
          return {
            ok: true,
            value: editorText,
            editor: afterState.editor || state.editor
          };
        }
        lastState = {
          ...afterState,
          editor_message_mismatch: true,
          editor_text: editorText
        };
      } catch (error) {
        if (!isRecoverableNodeError(error)) throw error;
        lastState = {
          ...state,
          recoverable_error: error?.message || String(error),
          recoverable_phase: "set_editor_message"
        };
      }
    }
    await sleep(250);
  }
  return {
    ok: false,
    error: "CHAT_EDITOR_NOT_FOUND",
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
  settleMs = 700
} = {}) {
  const started = Date.now();
  let lastState = null;
  let lastDisabledAskResume = null;
  while (Date.now() - started <= timeoutMs) {
    const state = await readChatConversationReadyState(client);
    lastState = state;
    if (state.attachment_resume_enabled) {
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
      already_requested: true,
      request_pending: true,
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

export async function clickChatConfirmRequestResume(client, {
  timeoutMs = 8000,
  settleMs = 900
} = {}) {
  const started = Date.now();
  let lastTarget = null;
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    lastState = await readChatConversationReadyState(client);
    const rootState = await getChatRoots(client);
    const confirmRoots = await resolveScopedRoots(
      client,
      rootState.roots,
      CHAT_CONVERSATION_CONTROL_SCOPE_SELECTORS
    );
    const target = await findVisibleMatchingTarget(
      client,
      confirmRoots,
      CHAT_CONFIRM_REQUEST_RESUME_SELECTORS,
      (item) => isConfirmText(item.label) && !item.disabled
    );
    lastTarget = target;
    if (target?.node_id) {
      try {
        if (target.center) {
          await clickPoint(client, target.center.x, target.center.y);
        } else {
          await clickNodeCenter(client, target.node_id, { scrollIntoView: true });
        }
        if (settleMs > 0) await sleep(settleMs);
        const afterState = await readChatConversationReadyState(client);
        return {
          confirmed: true,
          assumed_requested: Boolean(afterState.already_requested_resume),
          control: target,
          state: afterState
        };
      } catch (error) {
        if (!isRecoverableNodeError(error)) throw error;
        lastTarget = {
          ...target,
          recoverable_error: error?.message || String(error),
          recoverable_phase: "confirm_request_resume_click"
        };
      }
    }
    await sleep(250);
  }
  return {
    confirmed: false,
    error: "CONFIRM_BUTTON_NOT_FOUND",
    control: lastTarget,
    state: lastState
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

export async function waitForChatResumeRequestMessage(client, {
  baselineCount = 0,
  baselineResumeAttachmentCount = 0,
  timeoutMs = 6500,
  intervalMs = 260
} = {}) {
  const started = Date.now();
  let state = null;
  while (Date.now() - started <= timeoutMs) {
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
    await sleep(intervalMs);
  }
  return {
    observed: false,
    elapsed_ms: Date.now() - started,
    state
  };
}

export async function requestChatResumeForPassedCandidate(client, {
  greetingText = "Hi同学，能麻烦发下简历吗？",
  maxAttempts = 3,
  askResumeTimeoutMs = 8000,
  dryRun = false
} = {}) {
  const effectiveGreetingText = normalizeDetailText(greetingText) || "Hi同学，能麻烦发下简历吗？";
  const initialState = await readChatConversationReadyState(client);
  if (initialState.attachment_resume_enabled) {
    return {
      requested: false,
      skipped: true,
      reason: "attachment_resume_already_available",
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
  const editorState = await setChatEditorMessage(client, effectiveGreetingText);
  if (!editorState.ok) {
    throw new Error("CHAT_EDITOR_MESSAGE_MISMATCH");
  }
  const sendResult = await sendChatMessage(client, effectiveGreetingText);
  if (!sendResult.sent) {
    throw new Error(`CHAT_GREETING_SEND_FAILED:${sendResult.error || sendResult.method || "unknown"}`);
  }

  const attempts = [];
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await getChatResumeRequestMessageState(client);
    const askResult = await clickChatAskResume(client, {
      timeoutMs: askResumeTimeoutMs
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
    if (askResult.attachment_resume_available) {
      attempts.push({
        attempt: attempt + 1,
        ask_result: askResult,
        confirm_result: confirmResult,
        message_before_count: before.count,
        message_after_count: before.count,
        message_observed: false,
        message_last_text: before.last_text || ""
      });
      return {
        requested: false,
        skipped: true,
        reason: "attachment_resume_already_available",
        initial_state: initialState,
        close_before_greeting: closeBeforeGreeting,
        greeting_sent: true,
        greeting_send_result: sendResult,
        attempts
      };
    }
    if (askResult.request_pending || askResult.already_requested) {
      attempts.push({
        attempt: attempt + 1,
        ask_result: askResult,
        confirm_result: confirmResult,
        message_before_count: before.count,
        message_after_count: before.count,
        resume_attachment_before_count: before.resume_attachment_count || 0,
        resume_attachment_after_count: before.resume_attachment_count || 0,
        message_observed: false,
        message_last_text: before.last_success_text || before.last_text || ""
      });
      return {
        requested: false,
        skipped: true,
        reason: "resume_request_already_pending",
        initial_state: initialState,
        close_before_greeting: closeBeforeGreeting,
        greeting_sent: true,
        greeting_send_result: sendResult,
        attempts
      };
    }
    if (askResult.ok && !askResult.already_requested) {
      confirmResult = await clickChatConfirmRequestResume(client);
    }
    const messageCheck = await waitForChatResumeRequestMessage(client, {
      baselineCount: before.count,
      baselineResumeAttachmentCount: before.resume_attachment_count
    });
    const messageObserved = Boolean(messageCheck.observed);
    attempts.push({
      attempt: attempt + 1,
      ask_result: askResult,
      confirm_result: confirmResult,
      message_before_count: before.count,
      message_after_count: messageCheck.state?.count || 0,
      resume_attachment_before_count: before.resume_attachment_count || 0,
      resume_attachment_after_count: messageCheck.state?.resume_attachment_count || 0,
      message_observed: messageObserved,
      message_last_text: messageCheck.state?.last_success_text || messageCheck.state?.last_text || ""
    });
    if (messageObserved) {
      return {
        requested: true,
        skipped: false,
        reason: "requested",
        initial_state: initialState,
        close_before_greeting: closeBeforeGreeting,
        greeting_sent: true,
        greeting_send_result: sendResult,
        attempts
      };
    }
    await sleep(900);
  }

  return {
    requested: false,
    skipped: false,
    reason: "resume_request_message_not_observed",
    initial_state: initialState,
    close_before_greeting: closeBeforeGreeting,
    greeting_sent: true,
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
