#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const CDP = require("chrome-remote-interface");
const { captureFullResumeCanvas } = require("./scripts/capture-full-resume-canvas.cjs");

const DEFAULT_PORT = 9222;
const RECOMMEND_URL_FRAGMENT = "/web/chat/recommend";
const CSV_HEADER = ["姓名", "最高学历学校", "最高学历专业", "最近工作公司", "最近工作职位", "评估通过详细原因"].join(",");

function log(...args) {
  console.error(...args);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parsePositiveInteger(raw) {
  const value = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizePostAction(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (["favorite", "fav", "收藏"].includes(normalized)) return "favorite";
  if (["greet", "chat", "打招呼", "直接沟通", "沟通"].includes(normalized)) return "greet";
  return null;
}

function parseBoolean(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "是"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "否"].includes(normalized)) return false;
  return null;
}

function parseArgs(argv) {
  const parsed = {
    baseUrl: null,
    apiKey: null,
    model: null,
    openaiOrganization: null,
    openaiProject: null,
    criteria: null,
    targetCount: null,
    maxGreetCount: null,
    port: DEFAULT_PORT,
    output: path.resolve(process.cwd(), `筛选结果_${Date.now()}.csv`),
    postAction: null,
    postActionConfirmed: null,
    help: false,
    __provided: {
      baseUrl: false,
      apiKey: false,
      model: false,
      criteria: false,
      targetCount: false,
      maxGreetCount: false,
      port: false,
      postAction: false,
      postActionConfirmed: false
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--baseurl" && next) {
      parsed.baseUrl = next;
      parsed.__provided.baseUrl = true;
      index += 1;
    } else if (token === "--apikey" && next) {
      parsed.apiKey = next;
      parsed.__provided.apiKey = true;
      index += 1;
    } else if (token === "--model" && next) {
      parsed.model = next;
      parsed.__provided.model = true;
      index += 1;
    } else if (token === "--openai-organization" && next) {
      parsed.openaiOrganization = next;
      index += 1;
    } else if (token === "--openai-project" && next) {
      parsed.openaiProject = next;
      index += 1;
    } else if (token === "--criteria" && next) {
      parsed.criteria = next;
      parsed.__provided.criteria = true;
      index += 1;
    } else if (token === "--targetCount" && next) {
      parsed.targetCount = parsePositiveInteger(next);
      parsed.__provided.targetCount = true;
      index += 1;
    } else if (token === "--max-greet-count" && next) {
      parsed.maxGreetCount = parsePositiveInteger(next);
      parsed.__provided.maxGreetCount = true;
      index += 1;
    } else if (token === "--port" && next) {
      parsed.port = parsePositiveInteger(next) || DEFAULT_PORT;
      parsed.__provided.port = true;
      index += 1;
    } else if (token === "--output" && next) {
      parsed.output = path.resolve(next);
      index += 1;
    } else if (token === "--post-action" && next) {
      parsed.postAction = normalizePostAction(next);
      parsed.__provided.postAction = true;
      index += 1;
    } else if (token === "--post-action-confirmed" && next) {
      parsed.postActionConfirmed = parseBoolean(next);
      parsed.__provided.postActionConfirmed = true;
      index += 1;
    } else if (token === "--help" || token === "-h") {
      parsed.help = true;
    }
  }

  return parsed;
}

function isInteractiveTTY() {
  return Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
}

async function askWithValidation(ask, question, validate, options = {}) {
  const { allowEmpty = false, defaultValue = undefined } = options;
  while (true) {
    const answer = normalizeText(await ask(question));
    if (!answer) {
      if (defaultValue !== undefined) return defaultValue;
      if (allowEmpty) return null;
    }
    const validated = validate(answer);
    if (validated !== null && validated !== undefined) return validated;
    console.error("输入无效，请重试。");
  }
}

async function promptMissingInputs(args) {
  if (!isInteractiveTTY() || args.help) return args;

  if (args.__provided.postAction && args.postAction && args.postActionConfirmed === null) {
    args.postActionConfirmed = true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  try {
    if (!normalizeText(args.criteria)) {
      args.criteria = await askWithValidation(
        ask,
        "请输入筛选标准（--criteria）: ",
        (value) => normalizeText(value) || null
      );
    }
    if (!normalizeText(args.baseUrl)) {
      args.baseUrl = await askWithValidation(
        ask,
        "请输入模型接口 baseUrl（--baseurl，例如 https://api.openai.com/v1）: ",
        (value) => normalizeText(value) || null
      );
    }
    if (!normalizeText(args.apiKey)) {
      args.apiKey = await askWithValidation(
        ask,
        "请输入模型接口 apiKey（--apikey）: ",
        (value) => normalizeText(value) || null
      );
    }
    if (!normalizeText(args.model)) {
      args.model = await askWithValidation(
        ask,
        "请输入模型名（--model）: ",
        (value) => normalizeText(value) || null
      );
    }
    if (args.targetCount === null) {
      const targetCount = await askWithValidation(
        ask,
        "请输入目标筛选人数（--targetCount，可留空表示不设上限）: ",
        (value) => parsePositiveInteger(value),
        { allowEmpty: true }
      );
      if (Number.isInteger(targetCount) && targetCount > 0) {
        args.targetCount = targetCount;
      }
    }
    if (!(args.postActionConfirmed === true && args.postAction)) {
      args.postAction = await askWithValidation(
        ask,
        "本次通过人选统一执行什么动作？请输入 1(收藏) 或 2(直接沟通): ",
        (value) => {
          if (value === "1") return "favorite";
          if (value === "2") return "greet";
          return null;
        }
      );
      args.postActionConfirmed = true;
    }
    if (args.postAction === "greet" && !(Number.isInteger(args.maxGreetCount) && args.maxGreetCount > 0)) {
      args.maxGreetCount = await askWithValidation(
        ask,
        "本次最多打招呼多少位候选人？请输入正整数（--max-greet-count）: ",
        (value) => parsePositiveInteger(value)
      );
    }
    if (!args.__provided.port) {
      args.port = await askWithValidation(
        ask,
        `Chrome 调试端口（--port，默认: ${args.port}）: `,
        (value) => parsePositiveInteger(value),
        { defaultValue: args.port }
      );
    }
    return args;
  } finally {
    rl.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function humanDelay(baseMs, varianceMs) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(100, Math.round(baseMs + z * varianceMs));
}

function generateBezierPath(start, end, steps = 18) {
  const path = [];
  const midX = (start.x + end.x) / 2 + (Math.random() - 0.5) * 100;
  const midY = (start.y + end.y) / 2 + (Math.random() - 0.5) * 60;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * midX + t * t * end.x;
    const y = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * midY + t * t * end.y;
    path.push({ x, y });
  }
  return path;
}

function csvEscape(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

function extractJsonObject(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Vision model response did not contain JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

async function promptPostAction() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("POST_ACTION_CONFIRMATION_REQUIRED");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  try {
    const answer = normalizeText(await ask("本次通过人选统一执行什么动作？请输入 1(收藏) 或 2(直接沟通): "));
    if (answer === "1") return "favorite";
    if (answer === "2") return "greet";
    throw new Error("INVALID_POST_ACTION_CONFIRMATION");
  } finally {
    rl.close();
  }
}

async function promptMaxGreetCount() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("MAX_GREET_COUNT_CONFIRMATION_REQUIRED");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  try {
    const answer = normalizeText(await ask("本次最多打招呼多少位候选人？请输入正整数: "));
    const count = parsePositiveInteger(answer);
    if (!count) {
      throw new Error("INVALID_MAX_GREET_COUNT_CONFIRMATION");
    }
    return count;
  } finally {
    rl.close();
  }
}

function buildListCandidatesExpr(processedKeys) {
  return `((processedKeys) => {
    const frame = document.querySelector('iframe[name="recommendFrame"]')
      || document.querySelector('iframe[src*="/web/frame/recommend/"]')
      || document.querySelector('iframe');
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const frameRect = frame.getBoundingClientRect();
    const processed = new Set(processedKeys || []);
    const cards = Array.from(doc.querySelectorAll('ul.card-list > li.card-item'));
    const textOf = (el) => String(el ? el.textContent : '').replace(/\s+/g, ' ').trim();
    const candidates = cards.map((card, index) => {
      const inner = card.querySelector('.card-inner[data-geekid]');
      if (!inner) return null;
      const geekId = inner.getAttribute('data-geekid');
      if (!geekId) return null;
      const rect = card.getBoundingClientRect();
      const nameEl = card.querySelector('.name');
      const eduSpans = Array.from(card.querySelectorAll('.edu-wrap .edu-exp span, .edu-wrap .content span, .edu-wrap span'))
        .map((item) => textOf(item))
        .filter(Boolean);
      const latestWork = card.querySelector('.timeline-wrap.work-exps .timeline-item');
      const workSpans = latestWork
        ? Array.from(latestWork.querySelectorAll('.join-text-wrap.content span')).map((item) => textOf(item)).filter(Boolean)
        : [];
      return {
        found: true,
        index,
        key: geekId,
        geek_id: geekId,
        name: textOf(nameEl),
        school: eduSpans[0] || '',
        major: eduSpans[1] || '',
        degree: eduSpans[2] || '',
        last_company: workSpans[0] || '',
        last_position: workSpans[1] || '',
        x: frameRect.left + rect.left + Math.min(Math.max(rect.width / 2, 80), rect.width - 40),
        y: frameRect.top + rect.top + Math.min(Math.max(rect.height / 2, 24), rect.height - 12),
        width: rect.width,
        height: rect.height
      };
    }).filter(Boolean);
    return {
      ok: true,
      candidates: candidates.filter((candidate) => !processed.has(candidate.key)),
      candidate_count: candidates.length,
      total_cards: cards.length
    };
  })(${JSON.stringify(processedKeys)})`;
}

const jsGetListState = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const body = doc.body;
  const cards = Array.from(doc.querySelectorAll('ul.card-list > li.card-item'));
  const candidateCards = cards.filter((card) => card.querySelector('.card-inner[data-geekid]'));
  return {
    ok: true,
    scrollTop: body ? body.scrollTop : 0,
    scrollHeight: body ? body.scrollHeight : 0,
    clientHeight: body ? body.clientHeight : 0,
    candidateCount: candidateCards.length,
    totalCards: cards.length
  };
})()`;

const jsScrollList = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const body = doc.body;
  const cards = Array.from(doc.querySelectorAll('ul.card-list > li.card-item')).filter((card) => card.querySelector('.card-inner[data-geekid]'));
  const lastCard = cards[cards.length - 1];
  const before = {
    scrollTop: body ? body.scrollTop : 0,
    scrollHeight: body ? body.scrollHeight : 0
  };
  if (lastCard && typeof lastCard.scrollIntoView === 'function') {
    lastCard.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
  if (body) {
    body.scrollTop = body.scrollHeight;
    body.dispatchEvent(new Event('scroll', { bubbles: true }));
  }
  return {
    ok: true,
    before,
    after: {
      scrollTop: body ? body.scrollTop : 0,
      scrollHeight: body ? body.scrollHeight : 0
    }
  };
})()`;

const jsDetectBottom = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { isBottom: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const keywords = ['没有更多', '已显示全部', '已经到底', '暂无更多', '推荐完了', '没有更多人选'];
  const elements = Array.from(doc.querySelectorAll('div,span,p'));
  for (const el of elements) {
    if (el.offsetParent === null) continue;
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 40) continue;
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return { isBottom: true, reason: keyword };
      }
    }
  }
  return { isBottom: false };
})()`;
const jsWaitForDetail = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { open: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const win = doc.defaultView;
  const viewportWidth = (win && Number.isFinite(win.innerWidth) && win.innerWidth > 0)
    ? win.innerWidth
    : (doc.documentElement ? doc.documentElement.clientWidth : 0);
  const viewportHeight = (win && Number.isFinite(win.innerHeight) && win.innerHeight > 0)
    ? win.innerHeight
    : (doc.documentElement ? doc.documentElement.clientHeight : 0);
  const isVisibleInViewport = (el) => {
    if (!el) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    if (viewportWidth <= 0 || viewportHeight <= 0) return el.offsetParent !== null;
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  };
  const close = doc.querySelector('.boss-popup__close');
  const favorite = doc.querySelector('.like-icon-and-text');
  const greet = doc.querySelector('button.btn-v2.btn-sure-v2.btn-greet');
  const resumeFrame = doc.querySelector('iframe[src*="/web/frame/c-resume/"], iframe[name*="resume"]');
  const open = Boolean(
    isVisibleInViewport(close)
    || isVisibleInViewport(favorite)
    || isVisibleInViewport(greet)
    || isVisibleInViewport(resumeFrame)
  );
  return { open };
})()`;

const jsCloseDetail = `(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const pickVisibleKnowButton = (rootDoc) => {
    if (!rootDoc) return null;
    const buttons = Array.from(rootDoc.querySelectorAll('button.btn-v2.btn-sure-v2, button.btn'));
    return buttons.find((item) => normalize(item.textContent) === '知道了' && item.offsetParent !== null) || null;
  };

  const topKnow = pickVisibleKnowButton(document);
  if (topKnow) {
    topKnow.click();
    return { ok: true, method: 'know-top' };
  }

  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const frameKnow = pickVisibleKnowButton(doc);
  if (frameKnow) {
    frameKnow.click();
    return { ok: true, method: 'know-frame' };
  }

  const win = doc.defaultView;
  const isVisible = (el) => {
    if (!el) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const viewportWidth = (win && Number.isFinite(win.innerWidth) && win.innerWidth > 0)
      ? win.innerWidth
      : (doc.documentElement ? doc.documentElement.clientWidth : 0);
    const viewportHeight = (win && Number.isFinite(win.innerHeight) && win.innerHeight > 0)
      ? win.innerHeight
      : (doc.documentElement ? doc.documentElement.clientHeight : 0);
    if (viewportWidth <= 0 || viewportHeight <= 0) return true;
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  };

  const directCloseSelectors = [
    '.boss-popup__close',
    '.popup-close',
    '.modal-close',
    '.dialog-close',
    '.close-btn',
    'button[aria-label*="关闭"]',
    'button[title*="关闭"]',
    '.icon-close'
  ];
  for (const sel of directCloseSelectors) {
    const nodes = Array.from(doc.querySelectorAll(sel));
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      try {
        node.click();
        return { ok: true, method: 'direct-close', selector: sel };
      } catch {}
    }
  }

  const fallbackSelector = [
    '[aria-label*="关闭"]',
    '[aria-label*="返回"]',
    '[title*="关闭"]',
    '[title*="返回"]',
    '[class*="close"]',
    '[class*="Close"]',
    '[class*="back"]',
    '[class*="Back"]',
    'button',
    'a',
    'i',
    'span'
  ].join(',');
  const candidates = Array.from(doc.querySelectorAll(fallbackSelector)).slice(0, 500);
  const score = (el) => {
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const nearTopRight = Math.abs((frame.getBoundingClientRect().width - centerX)) + centerY;
    const text = normalize(el.textContent);
    const aria = normalize(el.getAttribute ? el.getAttribute('aria-label') : '');
    const title = normalize(el.getAttribute ? el.getAttribute('title') : '');
    const cls = normalize(el.className);
    const keywordBoost = /关闭|返回|收起|退出|×/.test(text + aria + title) ? -3000 : 0;
    const classBoost = /close|back/i.test(cls) ? -1200 : 0;
    return nearTopRight + keywordBoost + classBoost;
  };
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const node of candidates) {
    if (!isVisible(node)) continue;
    const text = normalize(node.textContent);
    const aria = normalize(node.getAttribute ? node.getAttribute('aria-label') : '');
    const title = normalize(node.getAttribute ? node.getAttribute('title') : '');
    const cls = normalize(node.className);
    if (!/关闭|返回|收起|退出|×/.test(text + aria + title) && !/close|back/i.test(cls)) continue;
    const currentScore = score(node);
    if (currentScore < bestScore) {
      bestScore = currentScore;
      best = node;
    }
  }
  if (best) {
    try {
      best.click();
      return { ok: true, method: 'fallback-close' };
    } catch {}
  }

  return { ok: false, error: 'DETAIL_CLOSE_TRIGGER_NOT_FOUND' };
})()`;

const jsIsDetailClosed = `(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const pickVisibleKnowButton = (rootDoc) => {
    if (!rootDoc) return null;
    const buttons = Array.from(rootDoc.querySelectorAll('button.btn-v2.btn-sure-v2, button.btn'));
    return buttons.find((item) => normalize(item.textContent) === '知道了' && item.offsetParent !== null) || null;
  };

  const topKnow = pickVisibleKnowButton(document);
  if (topKnow) {
    return { closed: false, reason: 'top know button visible' };
  }

  const topPopupSelectors = [
    '.boss-popup__wrapper',
    '.boss-popup_wrapper',
    '.boss-dialog_wrapper',
    '.dialog-wrap.active',
    '.boss-dialog',
    '[class*="popup"][class*="wrapper"]',
    '[class*="dialog"][class*="wrapper"]'
  ];
  for (const sel of topPopupSelectors) {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const node of nodes) {
      if (node.offsetParent === null) continue;
      const style = getComputedStyle(node);
      if (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.01) {
        return { closed: false, reason: 'top popup visible: ' + sel };
      }
    }
  }

  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { closed: true, reason: 'NO_RECOMMEND_IFRAME' };
  }

  const doc = frame.contentDocument;
  const win = doc.defaultView;
  const isVisible = (el) => {
    if (!el) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const viewportWidth = (win && Number.isFinite(win.innerWidth) && win.innerWidth > 0)
      ? win.innerWidth
      : (doc.documentElement ? doc.documentElement.clientWidth : 0);
    const viewportHeight = (win && Number.isFinite(win.innerHeight) && win.innerHeight > 0)
      ? win.innerHeight
      : (doc.documentElement ? doc.documentElement.clientHeight : 0);
    if (viewportWidth <= 0 || viewportHeight <= 0) return true;
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  };

  const popupSelectors = [
    '.boss-popup__wrapper',
    '.boss-popup_wrapper',
    '.boss-dialog_wrapper',
    '.dialog-wrap.active',
    '.boss-dialog',
    '[class*="popup"][class*="wrapper"]',
    '[class*="dialog"][class*="wrapper"]',
    '.geek-detail-modal',
    '.resume-item-detail'
  ];
  for (const sel of popupSelectors) {
    const nodes = Array.from(doc.querySelectorAll(sel));
    for (const node of nodes) {
      if (isVisible(node)) {
        return { closed: false, reason: 'popup visible: ' + sel };
      }
    }
  }

  const detailSignals = [
    '.like-icon-and-text',
    'button.btn-v2.btn-sure-v2.btn-greet',
    'iframe[src*="/web/frame/c-resume/"]',
    'iframe[name*="resume"]'
  ];
  for (const sel of detailSignals) {
    const node = doc.querySelector(sel);
    if (isVisible(node)) {
      return { closed: false, reason: 'detail signal visible: ' + sel };
    }
  }

  return { closed: true, reason: 'no popup or detail signal visible' };
})()`;

const jsGetFavoriteState = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const root = doc.querySelector('.like-icon-and-text');
  if (!root || root.offsetParent === null) {
    return { ok: false, error: 'FAVORITE_BUTTON_NOT_FOUND' };
  }
  const frameRect = frame.getBoundingClientRect();
  const rect = root.getBoundingClientRect();
  const text = String((root.querySelector('.btn-text') || {}).textContent || '').replace(/\s+/g, ' ').trim();
  const active = Boolean(root.querySelector('.like-icon.like-icon-active')) || text.includes('已收藏');
  return {
    ok: true,
    active,
    label: text,
    x: frameRect.left + rect.left + rect.width / 2,
    y: frameRect.top + rect.top + rect.height / 2
  };
})()`;

const jsClickFavoriteFallback = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  const doc = frame.contentDocument;
  const root = doc.querySelector('.like-icon-and-text');
  if (!root || root.offsetParent === null) return { ok: false, error: 'FAVORITE_BUTTON_NOT_FOUND' };
  root.click();
  return { ok: true };
})()`;

const jsGetGreetState = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const button = doc.querySelector('button.btn-v2.btn-sure-v2.btn-greet');
  if (!button || button.offsetParent === null) {
    return { ok: false, error: 'GREET_BUTTON_NOT_FOUND' };
  }
  const frameRect = frame.getBoundingClientRect();
  const rect = button.getBoundingClientRect();
  return {
    ok: true,
    disabled: Boolean(button.disabled),
    x: frameRect.left + rect.left + rect.width / 2,
    y: frameRect.top + rect.top + rect.height / 2
  };
})()`;

const jsClickGreetFallback = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  const doc = frame.contentDocument;
  const button = doc.querySelector('button.btn-v2.btn-sure-v2.btn-greet');
  if (!button || button.offsetParent === null) return { ok: false, error: 'GREET_BUTTON_NOT_FOUND' };
  button.click();
  return { ok: true };
})()`;

const jsGetKnowButtonState = `(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
  const pickVisibleKnowButton = (doc) => {
    if (!doc) return null;
    const buttons = Array.from(doc.querySelectorAll('button.btn-v2.btn-sure-v2, button.btn'));
    return buttons.find((item) => normalize(item.textContent) === '知道了' && item.offsetParent !== null) || null;
  };

  // 实测知道了确认按钮可能出现在顶层文档，不在 recommendFrame 内。
  const topButton = pickVisibleKnowButton(document);
  if (topButton) {
    const rect = topButton.getBoundingClientRect();
    return {
      ok: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const button = pickVisibleKnowButton(doc);
  if (!button) {
    return { ok: false, error: 'ACK_BUTTON_NOT_FOUND' };
  }
  const frameRect = frame.getBoundingClientRect();
  const rect = button.getBoundingClientRect();
  return {
    ok: true,
    x: frameRect.left + rect.left + rect.width / 2,
    y: frameRect.top + rect.top + rect.height / 2
  };
})()`;

const jsClickKnowFallback = `(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
  const pickVisibleKnowButton = (doc) => {
    if (!doc) return null;
    const buttons = Array.from(doc.querySelectorAll('button.btn-v2.btn-sure-v2, button.btn'));
    return buttons.find((item) => normalize(item.textContent) === '知道了' && item.offsetParent !== null) || null;
  };

  const topButton = pickVisibleKnowButton(document);
  if (topButton) {
    topButton.click();
    return { ok: true };
  }

  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  const doc = frame.contentDocument;
  const button = pickVisibleKnowButton(doc);
  if (!button) return { ok: false, error: 'ACK_BUTTON_NOT_FOUND' };
  button.click();
  return { ok: true };
})()`;

const jsGetCloseState = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const win = doc.defaultView;
  const frameRect = frame.getBoundingClientRect();
  const isVisible = (el) => {
    if (!el) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const viewportWidth = (win && Number.isFinite(win.innerWidth) && win.innerWidth > 0)
      ? win.innerWidth
      : (doc.documentElement ? doc.documentElement.clientWidth : 0);
    const viewportHeight = (win && Number.isFinite(win.innerHeight) && win.innerHeight > 0)
      ? win.innerHeight
      : (doc.documentElement ? doc.documentElement.clientHeight : 0);
    if (viewportWidth <= 0 || viewportHeight <= 0) return true;
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  };
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const scoreCloseCandidate = (el) => {
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const nearTopRight = Math.abs((frameRect.width - centerX)) + centerY;
    const className = normalize(el.className);
    const aria = normalize(el.getAttribute ? el.getAttribute('aria-label') : '');
    const title = normalize(el.getAttribute ? el.getAttribute('title') : '');
    const text = normalize(el.textContent);
    const keywordBoost = /关闭|返回|收起|退出|×/.test(text + aria + title) ? -3000 : 0;
    const classBoost = /close|back/i.test(className) ? -1200 : 0;
    return nearTopRight + keywordBoost + classBoost;
  };

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const direct = doc.querySelector('.boss-popup__close');
  if (isVisible(direct)) {
    best = direct;
    bestScore = scoreCloseCandidate(direct);
  }

  const selector = [
    '.boss-popup__close',
    '[aria-label*="关闭"]',
    '[aria-label*="返回"]',
    '[title*="关闭"]',
    '[title*="返回"]',
    '[class*="close"]',
    '[class*="Close"]',
    '[class*="back"]',
    '[class*="Back"]',
    'button',
    'a',
    'i',
    'span'
  ].join(',');
  const nodes = Array.from(doc.querySelectorAll(selector)).slice(0, 400);
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const text = normalize(el.textContent);
    const aria = normalize(el.getAttribute ? el.getAttribute('aria-label') : '');
    const title = normalize(el.getAttribute ? el.getAttribute('title') : '');
    const cls = normalize(el.className);
    if (!/关闭|返回|收起|退出|×/.test(text + aria + title) && !/close|back/i.test(cls)) {
      continue;
    }
    const currentScore = scoreCloseCandidate(el);
    if (currentScore < bestScore) {
      bestScore = currentScore;
      best = el;
    }
  }

  if (!best) {
    return { ok: false, error: 'DETAIL_CLOSE_NOT_FOUND' };
  }
  const rect = best.getBoundingClientRect();
  return {
    ok: true,
    x: frameRect.left + rect.left + rect.width / 2,
    y: frameRect.top + rect.top + rect.height / 2
  };
})()`;

const jsClickCloseFallback = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  const doc = frame.contentDocument;
  const win = doc.defaultView;
  const isVisible = (el) => {
    if (!el) return false;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const viewportWidth = (win && Number.isFinite(win.innerWidth) && win.innerWidth > 0)
      ? win.innerWidth
      : (doc.documentElement ? doc.documentElement.clientWidth : 0);
    const viewportHeight = (win && Number.isFinite(win.innerHeight) && win.innerHeight > 0)
      ? win.innerHeight
      : (doc.documentElement ? doc.documentElement.clientHeight : 0);
    if (viewportWidth <= 0 || viewportHeight <= 0) return true;
    return rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight;
  };
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const direct = doc.querySelector('.boss-popup__close');
  if (isVisible(direct)) {
    direct.click();
    return { ok: true, mode: 'boss-popup__close' };
  }

  const selector = [
    '[aria-label*="关闭"]',
    '[aria-label*="返回"]',
    '[title*="关闭"]',
    '[title*="返回"]',
    '[class*="close"]',
    '[class*="Close"]',
    '[class*="back"]',
    '[class*="Back"]',
    'button',
    'a',
    'i',
    'span'
  ].join(',');
  const nodes = Array.from(doc.querySelectorAll(selector)).slice(0, 400);
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const frameRect = frame.getBoundingClientRect();
  const score = (el) => {
    const rect = el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const nearTopRight = Math.abs((frameRect.width - centerX)) + centerY;
    const cls = normalize(el.className);
    const aria = normalize(el.getAttribute ? el.getAttribute('aria-label') : '');
    const title = normalize(el.getAttribute ? el.getAttribute('title') : '');
    const text = normalize(el.textContent);
    const keywordBoost = /关闭|返回|收起|退出|×/.test(text + aria + title) ? -3000 : 0;
    const classBoost = /close|back/i.test(cls) ? -1200 : 0;
    return nearTopRight + keywordBoost + classBoost;
  };
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const text = normalize(el.textContent);
    const aria = normalize(el.getAttribute ? el.getAttribute('aria-label') : '');
    const title = normalize(el.getAttribute ? el.getAttribute('title') : '');
    const cls = normalize(el.className);
    if (!/关闭|返回|收起|退出|×/.test(text + aria + title) && !/close|back/i.test(cls)) continue;
    const currentScore = score(el);
    if (currentScore < bestScore) {
      bestScore = currentScore;
      best = el;
    }
  }
  if (!best) return { ok: false, error: 'DETAIL_CLOSE_NOT_FOUND' };
  best.click();
  return { ok: true };
})()`;

const jsReloadRecommendFrame = `(() => {
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentWindow) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  try {
    const current = String(frame.contentWindow.location.href || '');
    if (current.includes('/web/frame/recommend/')) {
      frame.contentWindow.location.reload();
    } else {
      frame.contentWindow.location.href = 'https://www.zhipin.com/web/frame/recommend/';
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
})()`;

class RecommendScreenCli {
  constructor(args) {
    this.args = args;
    this.client = null;
    this.Runtime = null;
    this.Input = null;
    this.Page = null;
    this.target = null;
    this.discoveredKeys = new Set();
    this.processedKeys = new Set();
    this.candidateQueue = [];
    this.candidateByKey = new Map();
    this.insertedAt = new Map();
    this.insertCounter = 0;
    this.passedCandidates = [];
    this.scrollRetryCount = 0;
    this.maxScrollRetries = 3;
    this.processedCount = 0;
    this.skippedCount = 0;
    this.greetCount = 0;
    this.greetLimitFallbackCount = 0;
    this.restCounter = 0;
    this.restThreshold = 25 + Math.floor(Math.random() * 8);
    this.debugDir = path.join(os.tmpdir(), "boss-recommend-screen", String(Date.now()));
    fs.mkdirSync(this.debugDir, { recursive: true });
  }

  async connect() {
    const targets = await CDP.List({ port: this.args.port });
    this.target = targets.find(
      (item) => typeof item?.url === "string" && item.url.includes(RECOMMEND_URL_FRAGMENT)
    ) || targets.find((item) => item?.type === "page");
    if (!this.target) {
      throw this.buildError("RECOMMEND_PAGE_NOT_READY", "No debuggable recommend page target found.");
    }
    this.client = await CDP({ port: this.args.port, target: this.target });
    const { Runtime, Input, Page } = this.client;
    this.Runtime = Runtime;
    this.Input = Input;
    this.Page = Page;
    await Runtime.enable();
    await Page.enable();
    await Page.bringToFront();
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {}
    }
  }

  buildError(code, message, retryable = true, extra = {}) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    Object.assign(error, extra);
    return error;
  }

  async evaluate(expression) {
    const result = await this.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  async simulateHumanClick(targetX, targetY) {
    const start = {
      x: Math.round(Math.random() * 180 + 80),
      y: Math.round(Math.random() * 160 + 80)
    };
    const path = generateBezierPath(start, { x: targetX, y: targetY });
    for (const point of path) {
      await this.Input.dispatchMouseEvent({
        type: "mouseMoved",
        x: Math.round(point.x + (Math.random() - 0.5) * 3),
        y: Math.round(point.y + (Math.random() - 0.5) * 3)
      });
      await sleep(5 + Math.floor(Math.random() * 18));
    }
    const hoverSteps = 3 + Math.floor(Math.random() * 4);
    for (let index = 0; index < hoverSteps; index += 1) {
      await this.Input.dispatchMouseEvent({
        type: "mouseMoved",
        x: Math.round(targetX + (Math.random() - 0.5) * 5),
        y: Math.round(targetY + (Math.random() - 0.5) * 5)
      });
      await sleep(10 + Math.floor(Math.random() * 20));
    }
    await sleep(humanDelay(260, 80));
    await this.Input.dispatchMouseEvent({
      type: "mousePressed",
      x: Math.round(targetX),
      y: Math.round(targetY),
      button: "left",
      clickCount: 1
    });
    await sleep(25 + Math.floor(Math.random() * 35));
    await this.Input.dispatchMouseEvent({
      type: "mouseReleased",
      x: Math.round(targetX),
      y: Math.round(targetY),
      button: "left",
      clickCount: 1
    });
  }

  async pressEsc() {
    await this.Input.dispatchKeyEvent({ type: "keyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
    await this.Input.dispatchKeyEvent({ type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
  }
  async ensureDetailOpen() {
    for (let index = 0; index < 20; index += 1) {
      const state = await this.evaluate(jsWaitForDetail);
      if (state?.open) return true;
      await sleep(humanDelay(300, 80));
    }
    return false;
  }

  async getDetailClosedState() {
    const state = await this.evaluate(jsIsDetailClosed);
    if (state && typeof state === "object") return state;
    return { closed: false, reason: "invalid detail closed state" };
  }

  async isDetailOpen() {
    const state = await this.getDetailClosedState();
    return state?.closed === false;
  }

  async discoverCandidates() {
    const scan = await this.evaluate(buildListCandidatesExpr(Array.from(this.processedKeys)));
    if (!scan?.ok) {
      return {
        ok: false,
        error: scan?.error || "CANDIDATE_SCAN_FAILED",
        added: 0
      };
    }
    let added = 0;
    for (const candidate of scan.candidates || []) {
      const key = candidate?.key || null;
      if (!key) continue;
      this.candidateByKey.set(key, candidate);
      if (this.discoveredKeys.has(key)) continue;
      this.discoveredKeys.add(key);
      this.candidateQueue.push(key);
      this.insertCounter += 1;
      this.insertedAt.set(key, this.insertCounter);
      added += 1;
    }
    return {
      ok: true,
      added,
      candidate_count: scan.candidate_count ?? null,
      total_cards: scan.total_cards ?? null
    };
  }

  sortCandidateQueue() {
    const getIndex = (key) => {
      const candidate = this.candidateByKey.get(key);
      const index = Number(candidate?.index);
      return Number.isFinite(index) ? index : Number.POSITIVE_INFINITY;
    };
    const getInsertedAt = (key) => Number(this.insertedAt.get(key) || 0);
    this.candidateQueue.sort((a, b) => {
      const diff = getIndex(a) - getIndex(b);
      if (diff !== 0) return diff;
      return getInsertedAt(a) - getInsertedAt(b);
    });
  }

  getNextCandidateFromQueue() {
    while (this.candidateQueue.length > 0) {
      const key = this.candidateQueue.shift();
      if (!key) continue;
      if (this.processedKeys.has(key)) continue;
      const candidate = this.candidateByKey.get(key) || null;
      if (!candidate?.key) continue;
      return candidate;
    }
    return null;
  }

  async scrollAndLoadMore() {
    const before = await this.evaluate(jsGetListState);
    const scrollResult = await this.evaluate(jsScrollList);
    await sleep(humanDelay(1200, 260));
    const after = await this.evaluate(jsGetListState);
    const bottom = await this.evaluate(jsDetectBottom);
    return { before, scrollResult, after, bottom };
  }

  async getCenteredCandidateClickPoint(candidate) {
    const candidateKey = candidate?.key || candidate?.geek_id || null;
    if (!candidateKey) {
      return { ok: false, error: "CANDIDATE_KEY_MISSING" };
    }
    return this.evaluate(`((candidateKey) => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const inner = Array.from(doc.querySelectorAll('.card-inner[data-geekid]'))
        .find((item) => (item.getAttribute('data-geekid') || '') === String(candidateKey));
      if (!inner) {
        return { ok: false, error: 'CANDIDATE_NOT_FOUND' };
      }
      const card = inner.closest('li.card-item') || inner.closest('.card-item');
      if (!card) {
        return { ok: false, error: 'CANDIDATE_CARD_NOT_FOUND' };
      }

      // Align card near viewport center before click, then click with jitter.
      card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      const scrollTarget = doc.scrollingElement || doc.body;
      const viewportHeight = (() => {
        const win = doc.defaultView;
        if (win && Number.isFinite(win.innerHeight) && win.innerHeight > 0) return win.innerHeight;
        if (doc.documentElement && doc.documentElement.clientHeight > 0) return doc.documentElement.clientHeight;
        return frame.clientHeight || 0;
      })();

      for (let pass = 0; pass < 2; pass += 1) {
        const currentRect = card.getBoundingClientRect();
        const delta = (currentRect.top + currentRect.height / 2) - (viewportHeight / 2);
        if (Math.abs(delta) <= 26) break;
        if (scrollTarget) {
          scrollTarget.scrollTop += delta;
          scrollTarget.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      }

      const frameRect = frame.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      const deltaToViewportCenter = (rect.top + rect.height / 2) - (viewportHeight / 2);
      return {
        ok: true,
        x: frameRect.left + rect.left + rect.width / 2,
        y: frameRect.top + rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        delta_to_center: Math.round(deltaToViewportCenter)
      };
    })(${JSON.stringify(candidateKey)})`);
  }

  async clickCandidate(candidate) {
    const centered = await this.getCenteredCandidateClickPoint(candidate);
    if (centered?.ok) {
      await sleep(humanDelay(220, 60));
    }
    const baseX = centered?.ok ? centered.x : candidate.x;
    const baseY = centered?.ok ? centered.y : candidate.y;
    const width = centered?.ok ? centered.width : candidate.width;
    const height = centered?.ok ? centered.height : candidate.height;
    const rangeX = Math.min(36, Math.max(10, Math.floor((width || 120) / 4)));
    const rangeY = Math.min(24, Math.max(8, Math.floor((height || 64) / 4)));
    const offsetX = Math.floor(Math.random() * (rangeX * 2 + 1)) - rangeX;
    const offsetY = Math.floor(Math.random() * (rangeY * 2 + 1)) - rangeY;
    await this.simulateHumanClick(baseX + offsetX, baseY + offsetY);
  }

  async captureResumeImage(candidate) {
    const outPrefix = path.join(this.debugDir, `${candidate.geek_id}_${Date.now()}`);
    try {
      return await captureFullResumeCanvas({
        port: this.args.port,
        outPrefix,
        targetPattern: RECOMMEND_URL_FRAGMENT,
        waitResumeMs: 30000,
        scrollSettleMs: 500
      });
    } catch (error) {
      throw this.buildError("RESUME_CAPTURE_FAILED", error.message || "Failed to capture resume image.");
    }
  }

  async callVisionModel(imagePath) {
    const imageBase64 = fs.readFileSync(imagePath, "base64");
    const baseUrl = this.args.baseUrl.replace(/\/$/, "");
    const payload = {
      model: this.args.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: "你是一位严谨的招聘筛选助手。你只能返回 JSON，不要输出任何额外文字。"
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `请根据以下标准判断候选人是否通过筛选。\n\n筛选标准:\n${this.args.criteria}\n\n你看到的是整份候选人简历长图。请返回严格 JSON: {\"passed\": true/false, \"reason\": \"...\", \"summary\": \"...\"}`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${imageBase64}`
              }
            }
          ]
        }
      ]
    };
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.args.apiKey}`
    };
    if (this.args.openaiOrganization) headers["OpenAI-Organization"] = this.args.openaiOrganization;
    if (this.args.openaiProject) headers["OpenAI-Project"] = this.args.openaiProject;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const body = await response.text();
      throw this.buildError("VISION_MODEL_FAILED", `Vision model request failed: ${response.status} ${body.slice(0, 400)}`);
    }
    const json = await response.json();
    const content = Array.isArray(json?.choices?.[0]?.message?.content)
      ? json.choices[0].message.content.map((item) => item?.text || "").join("\n")
      : json?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonObject(content);
    return {
      passed: parsed.passed === true,
      reason: normalizeText(parsed.reason),
      summary: normalizeText(parsed.summary)
    };
  }

  async favoriteCandidate() {
    const before = await this.evaluate(jsGetFavoriteState);
    if (!before?.ok) {
      throw this.buildError("FAVORITE_BUTTON_FAILED", before?.error || "收藏按钮不可用");
    }
    if (before.active) {
      return { actionTaken: "already_favorited" };
    }

    try {
      await this.simulateHumanClick(before.x, before.y);
    } catch {
      const fallback = await this.evaluate(jsClickFavoriteFallback);
      if (!fallback?.ok) {
        throw this.buildError("FAVORITE_BUTTON_FAILED", fallback?.error || "收藏按钮点击失败");
      }
    }

    for (let index = 0; index < 8; index += 1) {
      await sleep(humanDelay(260, 80));
      const state = await this.evaluate(jsGetFavoriteState);
      if (state?.ok && state.active) {
        return { actionTaken: "favorite" };
      }
    }

    throw this.buildError("FAVORITE_BUTTON_FAILED", "收藏状态未能确认成功切换到已收藏。");
  }

  async greetCandidate() {
    const greet = await this.evaluate(jsGetGreetState);
    if (!greet?.ok || greet.disabled) {
      throw this.buildError("GREET_BUTTON_FAILED", greet?.error || "打招呼按钮不可用");
    }

    try {
      await this.simulateHumanClick(greet.x, greet.y);
    } catch {
      const fallback = await this.evaluate(jsClickGreetFallback);
      if (!fallback?.ok) {
        throw this.buildError("GREET_BUTTON_FAILED", fallback?.error || "打招呼点击失败");
      }
    }

    let know = null;
    for (let index = 0; index < 10; index += 1) {
      await sleep(humanDelay(260, 80));
      know = await this.evaluate(jsGetKnowButtonState);
      if (know?.ok) break;
    }
    if (!know?.ok) {
      throw this.buildError("ACK_BUTTON_FAILED", know?.error || "未出现知道了确认按钮");
    }

    try {
      await this.simulateHumanClick(know.x, know.y);
    } catch {
      const fallback = await this.evaluate(jsClickKnowFallback);
      if (!fallback?.ok) {
        throw this.buildError("ACK_BUTTON_FAILED", fallback?.error || "知道了按钮点击失败");
      }
    }

    for (let index = 0; index < 8; index += 1) {
      await sleep(humanDelay(220, 60));
      const state = await this.evaluate(jsGetKnowButtonState);
      if (!state?.ok) {
        return { actionTaken: "greet" };
      }
    }

    throw this.buildError("ACK_BUTTON_FAILED", "知道了弹窗未成功关闭。");
  }

  async closeDetailPage(maxRetries = 3) {
    let state = await this.getDetailClosedState();
    if (state?.closed) {
      return true;
    }

    for (let retry = 0; retry < maxRetries; retry += 1) {
      log(`[关闭详情] 尝试 ${retry + 1}/${maxRetries}，当前状态: ${state?.reason || "unknown"}`);
      const closeAttempt = await this.evaluate(jsCloseDetail);
      if (closeAttempt?.ok) {
        log(`[关闭详情] 触发关闭动作: ${closeAttempt.method || "unknown"}`);
      }

      await sleep(humanDelay(420, 120));
      state = await this.getDetailClosedState();
      if (state?.closed) {
        log(`[关闭详情] 成功: ${state.reason || "closed"}`);
        return true;
      }

      await this.pressEsc();
      await sleep(humanDelay(520, 140));
      state = await this.getDetailClosedState();
      if (state?.closed) {
        log(`[关闭详情] ESC后成功: ${state.reason || "closed"}`);
        return true;
      }
    }

    log(`[关闭详情] 常规关闭失败，进入强制恢复。最后状态: ${state?.reason || "unknown"}`);
    for (let retry = 0; retry < 2; retry += 1) {
      await this.pressEsc();
      await sleep(900 + retry * 250);
      state = await this.getDetailClosedState();
      if (state?.closed) {
        log(`[关闭详情] 强制ESC成功: ${state.reason || "closed"}`);
        return true;
      }
    }

    const reloaded = await this.evaluate(jsReloadRecommendFrame);
    if (reloaded?.ok) {
      log("[关闭详情] 已触发 recommendFrame reload，等待列表恢复。");
      const listReady = await this.waitForListReady(45);
      if (listReady) {
        state = await this.getDetailClosedState();
        if (state?.closed) {
          log(`[关闭详情] reload 后恢复成功: ${state.reason || "closed"}`);
          return true;
        }
      }
    } else {
      log(`[关闭详情] recommendFrame reload 失败: ${reloaded?.error || "unknown"}`);
    }

    state = await this.getDetailClosedState();
    log(`[关闭详情] 失败，当前状态: ${state?.reason || "unknown"}`);
    return false;
  }

  async waitForListReady(maxRounds = 30) {
    for (let index = 0; index < maxRounds; index += 1) {
      const listState = await this.evaluate(jsGetListState);
      const detailState = await this.getDetailClosedState();
      if (listState?.ok && detailState?.closed) {
        return true;
      }
      await sleep(220 + index * 20);
    }
    return false;
  }

  async takeBreakIfNeeded() {
    this.restCounter += 1;
    if (Math.random() < 0.08) {
      const pauseMs = 3000 + Math.floor(Math.random() * 4000);
      log(`[随机休息] 暂停 ${Math.round(pauseMs / 1000)} 秒`);
      await sleep(pauseMs);
    }
    if (this.restCounter >= this.restThreshold) {
      const pauseMs = 15000 + Math.floor(Math.random() * 15000);
      log(`[批次休息] 已连续处理 ${this.restCounter} 人，暂停 ${Math.round(pauseMs / 1000)} 秒`);
      await sleep(pauseMs);
      this.restCounter = 0;
      this.restThreshold = 25 + Math.floor(Math.random() * 8);
    }
  }

  saveCsv() {
    const lines = [CSV_HEADER];
    for (const item of this.passedCandidates) {
      lines.push([
        csvEscape(item.name),
        csvEscape(item.school),
        csvEscape(item.major),
        csvEscape(item.company),
        csvEscape(item.position),
        csvEscape(item.reason)
      ].join(","));
    }
    fs.mkdirSync(path.dirname(this.args.output), { recursive: true });
    fs.writeFileSync(this.args.output, `\uFEFF${lines.join("\n")}\n`, "utf8");
  }

  async run() {
    if (!this.args.criteria) {
      throw this.buildError("INVALID_CLI_INPUT", "Missing required --criteria", false);
    }
    if (!this.args.baseUrl || !this.args.apiKey || !this.args.model) {
      throw this.buildError("SCREEN_CONFIG_ERROR", "Missing baseUrl/apiKey/model", false);
    }

    if (!(this.args.postActionConfirmed === true && this.args.postAction)) {
      this.args.postAction = await promptPostAction();
      this.args.postActionConfirmed = true;
    }
    if (this.args.postAction === "greet" && !(Number.isInteger(this.args.maxGreetCount) && this.args.maxGreetCount > 0)) {
      this.args.maxGreetCount = await promptMaxGreetCount();
    }

    await this.connect();
    try {
      const initialList = await this.evaluate(jsGetListState);
      if (!initialList?.ok) {
        throw this.buildError("RECOMMEND_PAGE_NOT_READY", initialList?.error || "推荐列表不可用");
      }
      const initialDiscovery = await this.discoverCandidates();
      if (!initialDiscovery.ok) {
        throw this.buildError("CANDIDATE_SCAN_FAILED", initialDiscovery.error || "候选人列表扫描失败");
      }
      if (initialDiscovery.added > 0) {
        this.sortCandidateQueue();
      }

      while (!this.args.targetCount || this.processedCount < this.args.targetCount) {
        const periodicDiscovery = await this.discoverCandidates();
        if (!periodicDiscovery.ok) {
          throw this.buildError("CANDIDATE_SCAN_FAILED", periodicDiscovery.error || "候选人列表扫描失败");
        }
        if (periodicDiscovery.added > 0) {
          this.sortCandidateQueue();
        }
        let nextCandidate = this.getNextCandidateFromQueue();
        if (!nextCandidate) {
          const scroll = await this.scrollAndLoadMore();
          const discovery = await this.discoverCandidates();
          if (!discovery.ok) {
            throw this.buildError("CANDIDATE_SCAN_FAILED", discovery.error || "候选人列表扫描失败");
          }
          if (discovery.added > 0) {
            this.sortCandidateQueue();
          }
          const didGrow = Number(scroll.after?.candidateCount || 0) > Number(scroll.before?.candidateCount || 0);
          const didDiscover = discovery.added > 0;
          const didScroll = Number(scroll.after?.scrollTop || 0) !== Number(scroll.before?.scrollTop || 0)
            || Number(scroll.after?.scrollHeight || 0) !== Number(scroll.before?.scrollHeight || 0);
          if (scroll.bottom?.isBottom) {
            break;
          }
          if (didGrow || didDiscover) {
            this.scrollRetryCount = 0;
            continue;
          }
          if (!didScroll) {
            this.scrollRetryCount += 1;
            if (this.scrollRetryCount >= this.maxScrollRetries) {
              break;
            }
            continue;
          }
          this.scrollRetryCount += 1;
          if (this.scrollRetryCount >= this.maxScrollRetries) {
            break;
          }
          continue;
        }

        this.scrollRetryCount = 0;
        this.processedCount += 1;
        log(`处理第 ${this.processedCount} 位候选人: ${nextCandidate.name || nextCandidate.geek_id}`);

        try {
          await this.clickCandidate(nextCandidate);
          const detailOpen = await this.ensureDetailOpen();
          if (!detailOpen) {
            throw this.buildError("DETAIL_OPEN_FAILED", "详情页打开超时");
          }

          const capture = await this.captureResumeImage(nextCandidate);
          const screening = await this.callVisionModel(capture.stitchedImage);
          log(`筛选结果: ${screening.passed ? "通过" : "不通过"}`);

          if (screening.passed) {
            let effectiveAction = this.args.postAction;
            if (
              this.args.postAction === "greet"
              && Number.isInteger(this.args.maxGreetCount)
              && this.args.maxGreetCount > 0
              && this.greetCount >= this.args.maxGreetCount
            ) {
              effectiveAction = "favorite";
              this.greetLimitFallbackCount += 1;
            }
            const actionResult = effectiveAction === "favorite"
              ? await this.favoriteCandidate()
              : await this.greetCandidate();
            if (actionResult.actionTaken === "greet") {
              this.greetCount += 1;
            }
            this.passedCandidates.push({
              name: nextCandidate.name,
              school: nextCandidate.school || "",
              major: nextCandidate.major || "",
              company: nextCandidate.last_company || "",
              position: nextCandidate.last_position || "",
              reason: screening.reason || screening.summary || "",
              action: actionResult.actionTaken,
              geekId: nextCandidate.geek_id,
              summary: screening.summary,
              imagePath: capture.stitchedImage
            });
          } else {
            this.skippedCount += 1;
          }
        } catch (error) {
          this.skippedCount += 1;
          log(`候选人处理失败: ${error.code || error.message}`);
          if (["RESUME_CAPTURE_FAILED", "VISION_MODEL_FAILED"].includes(error.code)) {
            throw error;
          }
        } finally {
          const closed = await this.closeDetailPage();
          if (!closed) {
            throw this.buildError("DETAIL_CLOSE_FAILED", "详情页未能正确关闭");
          }
          this.processedKeys.add(nextCandidate.key);
        }

        await this.takeBreakIfNeeded();
      }

      this.saveCsv();
      return {
        status: "COMPLETED",
        result: {
          processed_count: this.processedCount,
          passed_count: this.passedCandidates.length,
          skipped_count: this.skippedCount,
          output_csv: this.args.output,
          completion_reason: this.args.targetCount && this.processedCount >= this.args.targetCount
            ? "target_count_reached"
            : "page_exhausted",
          post_action: this.args.postAction,
          max_greet_count: this.args.postAction === "greet" ? this.args.maxGreetCount : null,
          greet_count: this.greetCount,
          greet_limit_fallback_count: this.greetLimitFallbackCount
        }
      };
    } catch (error) {
      try {
        this.saveCsv();
      } catch (saveError) {
        log(`[保存CSV失败] ${saveError.message || saveError}`);
      }
      if (!error.partial_result) {
        error.partial_result = {
          processed_count: this.processedCount,
          passed_count: this.passedCandidates.length,
          skipped_count: this.skippedCount,
          output_csv: this.args.output
        };
      }
      throw error;
    } finally {
      await this.disconnect();
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(JSON.stringify({
      status: "COMPLETED",
      result: {
        usage: "node boss-recommend-screen-cli.cjs --criteria \"有 MCP 开发经验\" --post-action greet --max-greet-count 10 --post-action-confirmed true --baseurl <url> --apikey <key> --model <model> --port 9222"
      }
    }));
    return;
  }

  const finalArgs = await promptMissingInputs(args);
  const cli = new RecommendScreenCli(finalArgs);
  const result = await cli.run();
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  const payload = {
    status: "FAILED",
    error: {
      code: error.code || "RECOMMEND_SCREEN_FAILED",
      message: error.message || "推荐页筛选执行失败。",
      retryable: error.retryable !== false
    },
    result: error.partial_result || null
  };
  console.log(JSON.stringify(payload));
  process.exitCode = 1;
});

