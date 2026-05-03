import {
  clickNodeCenter,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../../core/screening/index.js";
import {
  assertGreetQuotaAvailable,
  parseGreetQuota
} from "../../core/greet-quota/index.js";

const ACTION_SELECTOR = [
  "button",
  '[role="button"]',
  ".btn",
  '[class*="btn"]',
  '[class*="chat"]',
  '[class*="greet"]',
  '[ka*="chat"]',
  '[ka*="greet"]',
  '[ka*="contact"]'
].join(", ");

const DISABLED_PATTERN = /\b(disabled|disable|ui-disabled|is-disabled)\b/i;
const CONTINUE_CHAT_PATTERN = /继续沟通|继续聊天|查看沟通|已沟通/i;
const GREET_PATTERN = /打招呼|立即沟通|立即聊天|聊一聊|开聊|沟通/i;
const GREET_LABEL_PATTERN = /^(打招呼|立即沟通|立即聊天|聊一聊|开聊|沟通)(?:[\(（]\d+\s*[/／]\s*\d+[\)）])?$/i;
const FAVORITE_PATTERN = /收藏|感兴趣/i;
const FAVORITE_LABEL_PATTERN = /^(收藏|感兴趣)$/i;
const OPEN_RESUME_KA_PATTERN = /search_click_open_resume|open_resume|resume/i;
const EXTERNAL_URL_PATTERN = /(?:https?:)?\/\/|github\.com|gitlab\.com|gitee\.com/i;
const MAX_ACTION_LABEL_LENGTH = 80;

function openingTagName(outerHTML = "") {
  const match = String(outerHTML || "").match(/^<\s*([a-z0-9-]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function isButtonLike(attributes = {}, outerHTML = "") {
  const tagName = openingTagName(outerHTML);
  const className = normalizeText(attributes.class);
  const role = normalizeText(attributes.role).toLowerCase();
  const ka = normalizeText(attributes.ka || attributes["data-ka"]);
  return tagName === "button"
    || role === "button"
    || /\bbtn\b|button|chat|greet/i.test(className)
    || /greet|chat|contact/i.test(ka);
}

function isUnsafeLinkOrCard(attributes = {}, outerHTML = "") {
  const tagName = openingTagName(outerHTML);
  const href = normalizeText(attributes.href);
  const ka = normalizeText(attributes.ka || attributes["data-ka"]);
  const className = normalizeText(attributes.class);
  const joined = [href, ka, className, String(outerHTML || "").slice(0, 500)].join(" ");
  if (OPEN_RESUME_KA_PATTERN.test(ka)) return true;
  if (tagName === "a" && href && !/^#|^javascript:/i.test(href)) return true;
  if (EXTERNAL_URL_PATTERN.test(joined) && tagName === "a") return true;
  return false;
}

function nodeIsDisabled(attributes = {}, outerHTML = "") {
  const joined = [
    attributes.class,
    attributes.disabled,
    attributes["aria-disabled"],
    attributes["data-disabled"],
    String(outerHTML || "").slice(0, 500)
  ].map(normalizeText).join(" ");
  return DISABLED_PATTERN.test(joined)
    || attributes.disabled !== undefined
    || normalizeText(attributes["aria-disabled"]).toLowerCase() === "true";
}

function classifyRecruitAction({ text = "", attributes = {}, outerHTML = "" } = {}) {
  if (isUnsafeLinkOrCard(attributes, outerHTML)) return null;
  const joined = [
    text,
    attributes.class,
    attributes.ka,
    attributes["data-ka"],
    attributes.title,
    attributes["aria-label"]
  ].map(normalizeText).join(" ");
  const label = normalizeText(text);
  const buttonLike = isButtonLike(attributes, outerHTML);
  const continueChat = CONTINUE_CHAT_PATTERN.test(joined);
  const greetQuota = parseGreetQuota(label);
  if (continueChat) {
    return {
      kind: "greet",
      continue_chat: true,
      available: false,
      greet_quota: null
    };
  }
  if (GREET_PATTERN.test(joined) && buttonLike && (label.length <= MAX_ACTION_LABEL_LENGTH || GREET_LABEL_PATTERN.test(label))) {
    return {
      kind: "greet",
      continue_chat: false,
      available: !nodeIsDisabled(attributes, outerHTML),
      greet_quota: greetQuota.found ? greetQuota : null
    };
  }
  if (FAVORITE_PATTERN.test(joined) && buttonLike && (label.length <= MAX_ACTION_LABEL_LENGTH || FAVORITE_LABEL_PATTERN.test(label))) {
    return {
      kind: "favorite",
      continue_chat: false,
      available: !nodeIsDisabled(attributes, outerHTML)
    };
  }
  return null;
}

function scoreRecruitAction(control) {
  let score = 0;
  if (control.kind === "greet") score += 100;
  if (control.available) score += 20;
  if (!control.continue_chat) score += 10;
  if (/打招呼/.test(control.label)) score += 10;
  if (/立即沟通|聊一聊|开聊/.test(control.label)) score += 6;
  if (/btn|button/i.test(control.class_name)) score += 3;
  return score;
}

async function readRecruitActionControl(client, nodeId, {
  selector = "",
  index = 0
} = {}) {
  let attributes;
  let outerHTML;
  try {
    [attributes, outerHTML] = await Promise.all([
      getAttributesMap(client, nodeId),
      getOuterHTML(client, nodeId)
    ]);
  } catch {
    return null;
  }
  const text = normalizeText(htmlToText(outerHTML));
  const classified = classifyRecruitAction({ text, attributes, outerHTML });
  if (!classified) return null;
  let box = null;
  try {
    box = await getNodeBox(client, nodeId);
  } catch {
    return null;
  }
  if (!box?.rect || box.rect.width < 4 || box.rect.height < 4) return null;
  const control = {
    node_id: nodeId,
    selector,
    index,
    kind: classified.kind,
    label: text,
    class_name: attributes.class || "",
    attributes: {
      ka: attributes.ka || attributes["data-ka"] || "",
      href: attributes.href || "",
      role: attributes.role || "",
      title: attributes.title || "",
      aria_label: attributes["aria-label"] || ""
    },
    tag_name: openingTagName(outerHTML),
    disabled: nodeIsDisabled(attributes, outerHTML),
    available: Boolean(classified.available),
    continue_chat: Boolean(classified.continue_chat),
    greet_quota: classified.greet_quota || null,
    center: box.center,
    rect: box.rect
  };
  control.score = scoreRecruitAction(control);
  return control;
}

export async function discoverRecruitDetailActionControls(client, rootNodeIds = []) {
  const controls = [];
  const seen = new Set();
  for (const rootNodeId of rootNodeIds.filter(Boolean)) {
    let nodeIds = [];
    try {
      nodeIds = await querySelectorAll(client, rootNodeId, ACTION_SELECTOR);
    } catch {
      continue;
    }
    for (let index = 0; index < nodeIds.length; index += 1) {
      const nodeId = nodeIds[index];
      if (!nodeId || seen.has(nodeId)) continue;
      seen.add(nodeId);
      const control = await readRecruitActionControl(client, nodeId, {
        selector: ACTION_SELECTOR,
        index
      });
      if (control) controls.push(control);
    }
  }
  controls.sort((left, right) => right.score - left.score);
  return controls;
}

export function summarizeRecruitActionControls(controls = []) {
  const greetControls = controls.filter((control) => control.kind === "greet");
  const favoriteControls = controls.filter((control) => control.kind === "favorite");
  const actionableGreet = greetControls.find((control) => control.available && !control.continue_chat) || null;
  const continueGreet = greetControls.find((control) => control.continue_chat) || null;
  const actionableFavorite = favoriteControls.find((control) => control.available) || null;
  return {
    greet: {
      found: Boolean(actionableGreet || continueGreet),
      available: Boolean(actionableGreet),
      continue_chat: Boolean(continueGreet && !actionableGreet),
      greet_quota: actionableGreet?.greet_quota || continueGreet?.greet_quota || null,
      control: actionableGreet || continueGreet
    },
    favorite: {
      found: Boolean(actionableFavorite),
      available: Boolean(actionableFavorite),
      control: actionableFavorite
    }
  };
}

export async function waitForRecruitDetailActionControls(client, {
  rootNodeIds = [],
  timeoutMs = 8000,
  intervalMs = 400,
  requireAny = false
} = {}) {
  const started = Date.now();
  let controls = [];
  while (Date.now() - started <= timeoutMs) {
    controls = await discoverRecruitDetailActionControls(client, rootNodeIds);
    const summary = summarizeRecruitActionControls(controls);
    if (!requireAny || summary.greet.found || summary.favorite.found) {
      return {
        ok: summary.greet.found || summary.favorite.found,
        elapsed_ms: Date.now() - started,
        controls,
        summary
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    controls,
    summary: summarizeRecruitActionControls(controls)
  };
}

export async function clickRecruitActionControl(client, control, {
  delayMs = 120
} = {}) {
  if (!control?.node_id) throw new Error("Recruit action control is missing node_id");
  const greetQuota = control.kind === "greet"
    ? assertGreetQuotaAvailable(control.greet_quota || control.label || "")
    : null;
  const box = await clickNodeCenter(client, control.node_id, {
    scrollIntoView: true,
    delayMs
  });
  return {
    clicked: true,
    kind: control.kind,
    label: control.label,
    greet_quota: greetQuota?.found ? greetQuota : null,
    node_id: control.node_id,
    box
  };
}
