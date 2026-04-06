#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import CDP from "chrome-remote-interface";

const DEFAULT_PORT = 9222;
const RECOMMEND_URL_FRAGMENT = "/web/chat/recommend";
const BOSS_LOGIN_URL = "https://www.zhipin.com/web/user/?ka=bticket";
const BOSS_LOGIN_URL_PATTERN = /(?:zhipin\.com\/web\/user(?:\/|\?|$)|passport\.zhipin\.com)/i;
const BOSS_LOGIN_TITLE_PATTERN = /登录|signin|扫码登录|BOSS直聘登录/i;
const SCHOOL_TAG_OPTIONS = ["不限", "985", "211", "双一流院校", "留学", "国内外名校", "公办本科"];
const DEGREE_OPTIONS = ["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"];
const DEGREE_ORDER = ["初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"];
const GENDER_OPTIONS = ["不限", "男", "女"];
const RECENT_NOT_VIEW_OPTIONS = ["不限", "近14天没有"];

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeJobTitle(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const byGap = text.split(/\s{2,}/).map((item) => item.trim()).filter(Boolean)[0] || text;
  const strippedRange = byGap
    .replace(/\s+\d+(?:\.\d+)?\s*(?:-|~|—|至)\s*\d+(?:\.\d+)?\s*(?:k|K|千|万|元\/天|元\/月|元\/年|K\/月|k\/月|万\/月|万\/年)?$/u, "")
    .trim();
  const strippedSingle = strippedRange
    .replace(/\s+\d+(?:\.\d+)?\s*(?:k|K|千|万|元\/天|元\/月|元\/年|K\/月|k\/月|万\/月|万\/年)$/u, "")
    .trim();
  return strippedSingle || byGap;
}

function parsePositiveInteger(raw) {
  const value = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizePageScope(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (["recommend", "推荐", "推荐页", "推荐页面"].includes(normalized)) return "recommend";
  if (["latest", "最新", "最新页", "最新页面"].includes(normalized)) return "latest";
  if (["featured", "精选", "精选页", "精选页面", "精选牛人"].includes(normalized)) return "featured";
  return null;
}

function sortSchoolSelection(values) {
  const order = new Map(SCHOOL_TAG_OPTIONS.map((label, index) => [label, index]));
  const unique = Array.from(new Set((values || []).filter((item) => order.has(item))));
  if (!unique.length) return [];
  if (unique.includes("不限")) {
    return unique.length === 1
      ? ["不限"]
      : unique.filter((item) => item !== "不限").sort((left, right) => order.get(left) - order.get(right));
  }
  return unique.sort((left, right) => order.get(left) - order.get(right));
}

function parseSchoolSelection(raw) {
  const text = normalizeText(raw);
  if (!text) return null;
  if (text === "不限") return ["不限"];

  const selected = [];
  for (const chunk of text.split(/[，,、/|]/)) {
    const value = normalizeText(chunk);
    if (SCHOOL_TAG_OPTIONS.includes(value)) {
      selected.push(value);
    }
  }
  for (const label of SCHOOL_TAG_OPTIONS) {
    if (label !== "不限" && text.includes(label)) {
      selected.push(label);
    }
  }
  const normalized = sortSchoolSelection(selected);
  return normalized.length ? normalized : null;
}

function normalizeDegree(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized === "专科") return "大专";
  if (normalized === "研究生") return "硕士";
  if (normalized === "中专" || normalized === "中技" || normalized === "中专中技") return "中专/中技";
  return DEGREE_OPTIONS.includes(normalized) ? normalized : null;
}

function sortDegreeSelection(values) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => DEGREE_ORDER.indexOf(left) - DEGREE_ORDER.indexOf(right));
}

function selectionEquals(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function uniqueNormalizedLabels(values) {
  return Array.from(
    new Set(
      (values || [])
        .map((item) => normalizeText(item))
        .filter(Boolean)
    )
  );
}

function expandDegreeAtOrAbove(value) {
  const normalized = normalizeDegree(value);
  if (!normalized || normalized === "不限") return [];
  const index = DEGREE_ORDER.indexOf(normalized);
  if (index === -1) return [];
  return DEGREE_ORDER.slice(index);
}

function parseDegreeSelection(raw) {
  const text = normalizeText(raw);
  if (!text) return null;
  if (text === "不限") return ["不限"];
  if (/不限/.test(text) && !/(初中|中专|中技|高中|大专|专科|本科|硕士|研究生|博士)/.test(text)) {
    return ["不限"];
  }

  const selected = [];
  const atOrAbovePattern = /(初中及以下|中专\/中技|中专中技|中专|中技|高中|大专|专科|本科|硕士|研究生|博士)\s*(?:及|或)?以上/g;
  let match;
  while ((match = atOrAbovePattern.exec(text)) !== null) {
    selected.push(...expandDegreeAtOrAbove(match[1]));
  }

  const chunks = text.split(/[，,、/|]/).map((item) => normalizeDegree(item)).filter(Boolean);
  selected.push(...chunks);

  for (const label of DEGREE_OPTIONS) {
    if (label === "不限") continue;
    if (text.includes(label)) {
      selected.push(label);
    }
  }

  const normalized = sortDegreeSelection(selected);
  return normalized.length ? normalized : null;
}

function parseArgs(argv) {
  const args = {
    schoolTag: ["不限"],
    degree: ["不限"],
    gender: "不限",
    recentNotView: "不限",
    pageScope: "recommend",
    port: DEFAULT_PORT,
    listJobs: false,
    job: null,
    help: false,
    __provided: {
      schoolTag: false,
      degree: false,
      gender: false,
      recentNotView: false,
      pageScope: true,
      port: false,
      job: false
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--school-tag" && next) {
      args.schoolTag = parseSchoolSelection(next);
      args.__provided.schoolTag = true;
      index += 1;
    } else if (token === "--degree" && next) {
      args.degree = parseDegreeSelection(next);
      args.__provided.degree = true;
      index += 1;
    } else if (token === "--gender" && next) {
      args.gender = next;
      args.__provided.gender = true;
      index += 1;
    } else if (token === "--recent-not-view" && next) {
      args.recentNotView = next;
      args.__provided.recentNotView = true;
      index += 1;
    } else if (token === "--port" && next) {
      args.port = parsePositiveInteger(next) || DEFAULT_PORT;
      args.__provided.port = true;
      index += 1;
    } else if (token === "--page-scope" && next) {
      args.pageScope = normalizePageScope(next) || "recommend";
      args.__provided.pageScope = true;
      index += 1;
    } else if (token === "--job" && next) {
      args.job = normalizeText(next) || null;
      args.__provided.job = true;
      index += 1;
    } else if (token === "--list-jobs") {
      args.listJobs = true;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    }
  }

  return args;
}

function isInteractiveTTY() {
  return Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
}

async function promptValue(ask, question, validate, defaultValue) {
  while (true) {
    const answer = normalizeText(await ask(question));
    if (!answer && defaultValue !== undefined) return defaultValue;
    const validated = validate(answer);
    if (validated !== null && validated !== undefined) return validated;
    console.error("输入无效，请重试。");
  }
}

async function enrichArgsFromPrompt(args) {
  if (!isInteractiveTTY() || args.help) return args;
  if (args.listJobs) return args;
  const askTargets =
    Object.values(args.__provided || {}).some((item) => item === false)
    || !Array.isArray(args.schoolTag)
    || args.schoolTag.length === 0
    || !Array.isArray(args.degree)
    || args.degree.length === 0;
  if (!askTargets) return args;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  try {
    if (!args.__provided.schoolTag) {
      const current = Array.isArray(args.schoolTag) && args.schoolTag.length > 0 ? args.schoolTag.join("/") : "不限";
      args.schoolTag = await promptValue(
        ask,
        `学校标签（可多选，逗号/斜杠分隔；${SCHOOL_TAG_OPTIONS.join("/")}，默认: ${current}）: `,
        (value) => parseSchoolSelection(value),
        Array.isArray(args.schoolTag) && args.schoolTag.length > 0 ? args.schoolTag : ["不限"]
      );
    }
    if (!args.__provided.gender) {
      args.gender = await promptValue(
        ask,
        `性别（${GENDER_OPTIONS.join("/")}，默认: ${args.gender}）: `,
        (value) => GENDER_OPTIONS.includes(value) ? value : null,
        args.gender
      );
    }
    if (!args.__provided.recentNotView) {
      args.recentNotView = await promptValue(
        ask,
        `近14天已看过滤（${RECENT_NOT_VIEW_OPTIONS.join("/")}，默认: ${args.recentNotView}）: `,
        (value) => RECENT_NOT_VIEW_OPTIONS.includes(value) ? value : null,
        args.recentNotView
      );
    }
    if (!args.__provided.degree || !Array.isArray(args.degree) || args.degree.length === 0) {
      const current = Array.isArray(args.degree) && args.degree.length > 0 ? args.degree.join(",") : "不限";
      args.degree = await promptValue(
        ask,
        `学历（可多选逗号分隔，支持“本科及以上”；默认: ${current}）: `,
        (value) => parseDegreeSelection(value),
        Array.isArray(args.degree) && args.degree.length > 0 ? args.degree : ["不限"]
      );
    }
    if (!args.__provided.port) {
      args.port = await promptValue(
        ask,
        `Chrome 调试端口（默认: ${args.port}）: `,
        (value) => parsePositiveInteger(value),
        args.port
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
  return Math.max(80, Math.round(baseMs + z * varianceMs));
}

function generateBezierPath(start, end, steps = 18) {
  const path = [];
  const midX = (start.x + end.x) / 2 + (Math.random() - 0.5) * 80;
  const midY = (start.y + end.y) / 2 + (Math.random() - 0.5) * 40;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const x = (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * midX + t * t * end.x;
    const y = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * midY + t * t * end.y;
    path.push({ x, y });
  }
  return path;
}

class RecommendSearchCli {
  constructor(args) {
    this.args = args;
    this.client = null;
    this.Runtime = null;
    this.Input = null;
    this.target = null;
  }

  async connect() {
    const targets = await CDP.List({ port: this.args.port });
    this.target = targets.find(
      (item) => typeof item?.url === "string" && item.url.includes(RECOMMEND_URL_FRAGMENT)
    ) || targets.find((item) => item?.type === "page");

    if (!this.target) {
      throw new Error("No debuggable recommend page target found");
    }

    this.client = await CDP({ port: this.args.port, target: this.target });
    const { Runtime, Input, Page } = this.client;
    this.Runtime = Runtime;
    this.Input = Input;
    await Runtime.enable();
    await Page.enable();
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {}
    }
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
      await sleep(6 + Math.floor(Math.random() * 18));
    }

    const hoverSteps = 2 + Math.floor(Math.random() * 3);
    for (let index = 0; index < hoverSteps; index += 1) {
      await this.Input.dispatchMouseEvent({
        type: "mouseMoved",
        x: Math.round(targetX + (Math.random() - 0.5) * 5),
        y: Math.round(targetY + (Math.random() - 0.5) * 5)
      });
      await sleep(10 + Math.floor(Math.random() * 20));
    }

    await sleep(humanDelay(220, 60));
    await this.Input.dispatchMouseEvent({
      type: "mousePressed",
      x: Math.round(targetX),
      y: Math.round(targetY),
      button: "left",
      clickCount: 1
    });
    await sleep(30 + Math.floor(Math.random() * 30));
    await this.Input.dispatchMouseEvent({
      type: "mouseReleased",
      x: Math.round(targetX),
      y: Math.round(targetY),
      button: "left",
      clickCount: 1
    });
  }

  async getFrameState() {
    return this.evaluate(`(() => {
      const currentUrl = (() => {
        try { return String(window.location.href || ''); } catch { return ''; }
      })();
      const title = (() => {
        try { return String(document.title || ''); } catch { return ''; }
      })();
      const isLogin = ${BOSS_LOGIN_URL_PATTERN}.test(currentUrl)
        || ${BOSS_LOGIN_TITLE_PATTERN}.test(title);
      if (isLogin) {
        return {
          ok: false,
          error: 'LOGIN_REQUIRED',
          currentUrl: currentUrl || ${JSON.stringify(BOSS_LOGIN_URL)},
          title
        };
      }
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME', currentUrl, title };
      }
      return {
        ok: true,
        currentUrl,
        title,
        frameUrl: (() => {
          try { return String(frame.contentWindow.location.href || ''); } catch { return ''; }
        })()
      };
    })()`);
  }

  async getFilterEntryPoint() {
    return this.evaluate(`(() => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const el = doc.querySelector('.filter-label-wrap') || doc.querySelector('.recommend-filter.op-filter');
      if (!el) {
        return { ok: false, error: 'FILTER_TRIGGER_NOT_FOUND' };
      }
      const frameRect = frame.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return {
        ok: true,
        x: frameRect.left + rect.left + rect.width / 2,
        y: frameRect.top + rect.top + rect.height / 2
      };
    })()`);
  }

  async getJobListState() {
    return this.evaluate(`(() => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const normalizeTitle = (value) => {
        const text = normalize(value);
        if (!text) return '';
        const byGap = text.split(/\\s{2,}/).map((item) => item.trim()).filter(Boolean)[0] || text;
        const strippedRange = byGap
          .replace(/\\s+\\d+(?:\\.\\d+)?\\s*(?:-|~|—|至)\\s*\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元\\/天|元\\/月|元\\/年|K\\/月|k\\/月|万\\/月|万\\/年)?$/u, '')
          .trim();
        const strippedSingle = strippedRange
          .replace(/\\s+\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元\\/天|元\\/月|元\\/年|K\\/月|k\\/月|万\\/月|万\\/年)$/u, '')
          .trim();
        return strippedSingle || byGap;
      };
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      };

      const items = Array.from(doc.querySelectorAll([
        '.ui-dropmenu-list .job-list .job-item',
        '.job-selecter-options .job-list .job-item',
        '.job-selector-options .job-list .job-item',
        '.dropmenu-list .job-list .job-item',
        '.job-list .job-item'
      ].join(',')));
      const jobs = [];
      const seen = new Set();
      for (const item of items) {
        const label = normalize(item.querySelector('.label')?.textContent || item.textContent || '');
        const title = normalizeTitle(label);
        const value = normalize(item.getAttribute('value') || item.dataset?.value || '');
        const dedupeKey = value || title || label;
        if (!dedupeKey || seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        jobs.push({
          value: value || null,
          title: title || label || null,
          label: label || null,
          current: item.classList.contains('curr') || item.classList.contains('active'),
          visible: isVisible(item)
        });
      }

      const selectedLabelNode = doc.querySelector('.chat-job-name, .job-selecter .label, .job-selecter .job-name, .job-select .label');
      return {
        ok: true,
        jobs,
        selected_label: normalize(selectedLabelNode ? selectedLabelNode.textContent : ''),
        frame_url: (() => {
          try { return String(frame.contentWindow.location.href || ''); } catch { return ''; }
        })()
      };
    })()`);
  }

  async clickJobDropdownTriggerBySelector() {
    return this.evaluate(`(() => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const selectors = [
        '.chat-job-select',
        '.chat-job-selector',
        '.job-selecter',
        '.job-selector',
        '.job-select-wrap',
        '.job-select',
        '.job-select-box',
        '.job-wrap',
        '.chat-job-name',
        '.top-chat-search'
      ];
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      };
      for (const selector of selectors) {
        const el = doc.querySelector(selector);
        if (el && isVisible(el)) {
          el.click();
          return { ok: true };
        }
      }
      return { ok: false, error: 'JOB_TRIGGER_NOT_FOUND' };
    })()`);
  }

  async ensureJobListReady() {
    let lastError = "JOB_LIST_NOT_FOUND";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = await this.getJobListState();
      if (state?.ok && Array.isArray(state.jobs) && state.jobs.length > 0) {
        return state;
      }
      lastError = state?.error || lastError;
      const clickResult = await this.clickJobDropdownTriggerBySelector();
      if (!clickResult?.ok) {
        lastError = clickResult?.error || lastError;
      }
      await sleep(220 + attempt * 80);
    }
    throw new Error(lastError);
  }

  findJobMatch(jobList, requestedJobRaw) {
    const requested = normalizeText(requestedJobRaw);
    if (!requested) return null;
    const normalizedRequestedTitle = normalizeJobTitle(requested);
    const normalize = (value) => normalizeText(value).toLowerCase();
    const byValue = jobList.find((job) => normalize(job.value || "") === normalize(requested));
    if (byValue) return byValue;
    const exactTitle = jobList.find((job) => normalize(job.title || "") === normalize(normalizedRequestedTitle));
    if (exactTitle) return exactTitle;
    const exactLabel = jobList.find((job) => normalize(job.label || "") === normalize(requested));
    if (exactLabel) return exactLabel;
    const contains = jobList.filter((job) => {
      const title = normalize(job.title || "");
      const label = normalize(job.label || "");
      const target = normalize(normalizedRequestedTitle);
      return (
        (title && (title.includes(target) || target.includes(title)))
        || (label && (label.includes(normalize(requested)) || normalize(requested).includes(label)))
      );
    });
    if (contains.length === 1) return contains[0];
    if (contains.length > 1) {
      throw new Error("JOB_SELECTION_AMBIGUOUS");
    }
    return null;
  }

  async clickJobBySelector(job) {
    return this.evaluate(`((job) => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const normalizeTitle = (value) => {
        const text = normalize(value);
        if (!text) return '';
        const byGap = text.split(/\\s{2,}/).map((item) => item.trim()).filter(Boolean)[0] || text;
        const strippedRange = byGap
          .replace(/\\s+\\d+(?:\\.\\d+)?\\s*(?:-|~|—|至)\\s*\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元\\/天|元\\/月|元\\/年|K\\/月|k\\/月|万\\/月|万\\/年)?$/u, '')
          .trim();
        const strippedSingle = strippedRange
          .replace(/\\s+\\d+(?:\\.\\d+)?\\s*(?:k|K|千|万|元\\/天|元\\/月|元\\/年|K\\/月|k\\/月|万\\/月|万\\/年)$/u, '')
          .trim();
        return strippedSingle || byGap;
      };
      const items = Array.from(doc.querySelectorAll([
        '.ui-dropmenu-list .job-list .job-item',
        '.job-selecter-options .job-list .job-item',
        '.job-selector-options .job-list .job-item',
        '.dropmenu-list .job-list .job-item',
        '.job-list .job-item'
      ].join(',')));
      const target = items.find((item) => {
        const value = normalize(item.getAttribute('value') || item.dataset?.value || '');
        const label = normalize(item.querySelector('.label')?.textContent || item.textContent || '');
        const title = normalizeTitle(label);
        const matchValue = job.value && value && value === normalize(job.value);
        const matchTitle = job.title && title && title === normalize(job.title);
        const matchLabel = job.label && label && label === normalize(job.label);
        return matchValue || matchTitle || matchLabel;
      });
      if (!target) {
        return { ok: false, error: 'JOB_OPTION_NOT_FOUND' };
      }
      target.click();
      return { ok: true };
    })(${JSON.stringify(job)})`);
  }

  async waitJobSelected(job, rounds = 8) {
    const selectedValue = normalizeText(job.value || "");
    const selectedTitle = normalizeText(job.title || "");
    const selectedLabel = normalizeText(job.label || "");
    for (let index = 0; index < rounds; index += 1) {
      const state = await this.getJobListState();
      if (state?.ok) {
        const current = (state.jobs || []).find((item) => item.current);
        if (current) {
          const sameValue = selectedValue && normalizeText(current.value || "") === selectedValue;
          const sameTitle = selectedTitle && normalizeText(current.title || "") === selectedTitle;
          const sameLabel = selectedLabel && normalizeText(current.label || "") === selectedLabel;
          if (sameValue || sameTitle || sameLabel) return true;
        }
        const selectedText = normalizeText(state.selected_label || "");
        if (selectedTitle && selectedText && (selectedText === selectedTitle || selectedText.includes(selectedTitle))) {
          return true;
        }
      }
      await sleep(150 + index * 40);
    }
    return false;
  }

  async selectJob(jobSelection) {
    const state = await this.ensureJobListReady();
    const matched = this.findJobMatch(state.jobs || [], jobSelection);
    if (!matched) {
      throw new Error("JOB_OPTION_NOT_FOUND");
    }
    const clicked = await this.clickJobBySelector(matched);
    if (!clicked?.ok) {
      throw new Error(clicked?.error || "JOB_SELECT_FAILED");
    }
    const selected = await this.waitJobSelected(matched, 10);
    if (!selected) {
      throw new Error("JOB_SELECTION_NOT_APPLIED");
    }
    return matched;
  }

  async isFilterPanelVisible() {
    const result = await this.evaluate(`(() => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) return false;
      const doc = frame.contentDocument;
      const panel = doc.querySelector('.recommend-filter.op-filter .filter-panel');
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      };
      const groups = Array.from(doc.querySelectorAll('.check-box'));
      const visibleGroups = groups.filter((group) => isVisible(group));
      if (visibleGroups.length >= 2) return true;
      return Boolean(isVisible(panel) && visibleGroups.length >= 1);
    })()`);
    return result === true;
  }

  async clickFilterEntryBySelector() {
    return this.evaluate(`(() => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const entry = doc.querySelector('.filter-label-wrap') || doc.querySelector('.recommend-filter.op-filter');
      if (!entry) {
        return { ok: false, error: 'FILTER_TRIGGER_NOT_FOUND' };
      }
      entry.click();
      return { ok: true };
    })()`);
  }

  async getFilterConfirmButton() {
    return this.evaluate(`(() => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const panel = doc.querySelector('.recommend-filter.op-filter .filter-panel');
      if (!panel) {
        return { ok: false, error: 'FILTER_PANEL_NOT_FOUND' };
      }
      const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2;
      };
      const button = Array.from(panel.querySelectorAll('.btn, button')).find((el) => {
        return normalize(el.textContent) === '确定' && isVisible(el);
      });
      if (!button) {
        return { ok: false, error: 'FILTER_CONFIRM_BUTTON_NOT_FOUND' };
      }
      const frameRect = frame.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      return {
        ok: true,
        x: frameRect.left + rect.left + rect.width / 2,
        y: frameRect.top + rect.top + rect.height / 2
      };
    })()`);
  }

  async clickFilterConfirmBySelector() {
    return this.evaluate(`(() => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const panel = doc.querySelector('.recommend-filter.op-filter .filter-panel');
      if (!panel) {
        return { ok: false, error: 'FILTER_PANEL_NOT_FOUND' };
      }
      const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
      const button = Array.from(panel.querySelectorAll('.btn, button')).find((el) => {
        return normalize(el.textContent) === '确定';
      });
      if (!button) {
        return { ok: false, error: 'FILTER_CONFIRM_BUTTON_NOT_FOUND' };
      }
      button.click();
      return { ok: true };
    })()`);
  }

  async openFilterPanel() {
    if (await this.isFilterPanelVisible()) return;
    let lastError = 'FILTER_PANEL_UNAVAILABLE';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const point = await this.getFilterEntryPoint();
      if (point?.ok) {
        await this.simulateHumanClick(point.x, point.y);
      } else {
        lastError = point?.error || lastError;
      }
      for (let index = 0; index < 8; index += 1) {
        await sleep(140 + index * 40);
        if (await this.isFilterPanelVisible()) {
          return;
        }
      }

      const fallback = await this.clickFilterEntryBySelector();
      if (fallback?.ok) {
        for (let index = 0; index < 8; index += 1) {
          await sleep(140 + index * 40);
          if (await this.isFilterPanelVisible()) {
            return;
          }
        }
      } else {
        lastError = fallback?.error || lastError;
      }
    }
    throw new Error(lastError === 'FILTER_TRIGGER_NOT_FOUND' ? lastError : 'FILTER_PANEL_UNAVAILABLE');
  }

  async closeFilterPanel() {
    if (!(await this.isFilterPanelVisible())) {
      return;
    }

    const selectorClickResult = await this.clickFilterConfirmBySelector();
    if (selectorClickResult?.ok) {
      for (let index = 0; index < 10; index += 1) {
        await sleep(140 + index * 40);
        if (!(await this.isFilterPanelVisible())) {
          return;
        }
      }
    }

    const point = await this.getFilterConfirmButton();
    if (point?.ok) {
      await this.simulateHumanClick(point.x, point.y);
      for (let index = 0; index < 10; index += 1) {
        await sleep(140 + index * 40);
        if (!(await this.isFilterPanelVisible())) {
          return;
        }
      }
    }

    throw new Error('FILTER_CONFIRM_FAILED');
  }

  async getOptionInfo(groupClass, label) {
    return this.evaluate(`((groupClass, label) => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
      const groupCandidates = Array.from(doc.querySelectorAll('.check-box'));
      const getOptionSet = (group) => new Set(
        Array.from(group.querySelectorAll('.default.option, .options .option, .option'))
          .map((item) => normalize(item.textContent))
          .filter(Boolean)
      );
      const findGroup = () => {
        const direct = doc.querySelector('.check-box.' + groupClass);
        if (direct) return direct;
        if (groupClass === 'school') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('985') || set.has('211') || set.has('双一流院校');
          }) || null;
        }
        if (groupClass === 'degree') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('大专') || set.has('本科') || set.has('硕士') || set.has('博士');
          }) || null;
        }
        if (groupClass === 'gender') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('男') || set.has('女');
          }) || null;
        }
        if (groupClass === 'recentNotView') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('近14天没有');
          }) || null;
        }
        return null;
      };
      const group = findGroup();
      if (!group) {
        return { ok: false, error: 'GROUP_NOT_FOUND' };
      }
      const frameRect = frame.getBoundingClientRect();
      const getPoint = (el) => {
        const rect = el.getBoundingClientRect();
        return {
          x: frameRect.left + rect.left + rect.width / 2,
          y: frameRect.top + rect.top + rect.height / 2
        };
      };
      const options = Array.from(group.querySelectorAll('.options .option, .option'));
      const active = group.querySelector('.default.option.active, .options .option.active, .option.active');
      const activeText = normalize(active ? active.textContent : '');
      const target = label === '不限'
        ? (group.querySelector('.default.option') || options.find((item) => normalize(item.textContent) === '不限'))
        : options.find((item) => normalize(item.textContent) === normalize(label));
      if (!target) {
        return { ok: false, error: 'OPTION_NOT_FOUND', activeText };
      }
      const targetActive = target.classList.contains('active');
      return {
        ok: true,
        activeText,
        alreadySelected: targetActive || activeText === normalize(label),
        x: getPoint(target).x,
        y: getPoint(target).y
      };
    })(${JSON.stringify(groupClass)}, ${JSON.stringify(label)})`);
  }

  async ensureGroupReady(groupClass) {
    return this.evaluate(`((groupClass) => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
      const groupCandidates = Array.from(doc.querySelectorAll('.check-box'));
      const getOptionSet = (group) => new Set(
        Array.from(group.querySelectorAll('.default.option, .options .option, .option'))
          .map((item) => normalize(item.textContent))
          .filter(Boolean)
      );
      const findGroup = () => {
        const direct = doc.querySelector('.check-box.' + groupClass);
        if (direct) return direct;
        if (groupClass === 'school') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('985') || set.has('211') || set.has('双一流院校');
          }) || null;
        }
        if (groupClass === 'degree') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('大专') || set.has('本科') || set.has('硕士') || set.has('博士');
          }) || null;
        }
        if (groupClass === 'gender') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('男') || set.has('女');
          }) || null;
        }
        if (groupClass === 'recentNotView') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('近14天没有');
          }) || null;
        }
        return null;
      };

      const scrollGroupIntoView = (group) => {
        try {
          group.scrollIntoView({ behavior: 'instant', block: 'center' });
        } catch {
          try { group.scrollIntoView({ block: 'center' }); } catch {}
        }
      };

      let group = findGroup();
      if (group) {
        scrollGroupIntoView(group);
        return { ok: true, found: true, scrolled: false };
      }

      const topScroller = doc.querySelector('.recommend-filter.op-filter .filter-panel .top')
        || doc.querySelector('.recommend-filter.op-filter .top')
        || doc.querySelector('.recommend-filter.op-filter .filter-panel');
      if (!topScroller) {
        return { ok: false, error: 'FILTER_SCROLL_CONTAINER_NOT_FOUND' };
      }
      const maxScrollTop = Math.max(0, topScroller.scrollHeight - topScroller.clientHeight);
      const steps = 14;
      for (let index = 0; index <= steps; index += 1) {
        const nextTop = maxScrollTop <= 0 ? 0 : Math.round((maxScrollTop * index) / steps);
        topScroller.scrollTop = nextTop;
        group = findGroup();
        if (group) {
          scrollGroupIntoView(group);
          return { ok: true, found: true, scrolled: true, step: index };
        }
      }
      return { ok: false, error: 'GROUP_NOT_FOUND' };
    })(${JSON.stringify(groupClass)})`);
  }

  async selectOption(groupClass, label) {
    let option = await this.getOptionInfo(groupClass, label);
    if (!option?.ok && option?.error === "GROUP_NOT_FOUND") {
      await this.openFilterPanel();
      const ensure = await this.ensureGroupReady(groupClass);
      if (!ensure?.ok) {
        throw new Error(ensure?.error || "GROUP_NOT_FOUND");
      }
      await sleep(humanDelay(180, 60));
      option = await this.getOptionInfo(groupClass, label);
    }
    if (!option?.ok) {
      throw new Error(option?.error || 'OPTION_NOT_FOUND');
    }
    if (option.alreadySelected) {
      return;
    }
    const domClick = await this.clickOptionBySelector(groupClass, label);
    if (!domClick?.ok) {
      throw new Error(domClick?.error || "OPTION_DOM_CLICK_FAILED");
    }
    if (await this.waitOptionSelected(groupClass, label, 10)) {
      return;
    }

    await this.simulateHumanClick(option.x, option.y);
    if (!(await this.waitOptionSelected(groupClass, label, 10))) {
      throw new Error("OPTION_SELECTION_NOT_APPLIED");
    }
  }

  async clickOptionBySelector(groupClass, label) {
    return this.evaluate(`((groupClass, label) => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
      const groupCandidates = Array.from(doc.querySelectorAll('.check-box'));
      const getOptionSet = (group) => new Set(
        Array.from(group.querySelectorAll('.default.option, .options .option, .option'))
          .map((item) => normalize(item.textContent))
          .filter(Boolean)
      );
      const findGroup = () => {
        const direct = doc.querySelector('.check-box.' + groupClass);
        if (direct) return direct;
        if (groupClass === 'school') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('985') || set.has('211') || set.has('双一流院校');
          }) || null;
        }
        if (groupClass === 'degree') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('大专') || set.has('本科') || set.has('硕士') || set.has('博士');
          }) || null;
        }
        if (groupClass === 'gender') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('男') || set.has('女');
          }) || null;
        }
        if (groupClass === 'recentNotView') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('近14天没有');
          }) || null;
        }
        return null;
      };
      const group = findGroup();
      if (!group) {
        return { ok: false, error: 'GROUP_NOT_FOUND' };
      }
      const options = Array.from(group.querySelectorAll('.options .option, .option'));
      const target = label === '不限'
        ? (group.querySelector('.default.option') || options.find((item) => normalize(item.textContent) === '不限'))
        : options.find((item) => normalize(item.textContent) === normalize(label));
      if (!target) {
        return { ok: false, error: 'OPTION_NOT_FOUND' };
      }
      target.click();
      return { ok: true };
    })(${JSON.stringify(groupClass)}, ${JSON.stringify(label)})`);
  }

  async waitOptionSelected(groupClass, label, rounds = 8) {
    for (let index = 0; index < rounds; index += 1) {
      const state = await this.getOptionInfo(groupClass, label);
      if (state?.ok && state.alreadySelected) {
        return true;
      }
      await sleep(120 + index * 40);
    }
    return false;
  }

  async getFilterGroupState(groupClass) {
    return this.evaluate(`((groupClass) => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
      const groupCandidates = Array.from(doc.querySelectorAll('.check-box'));
      const getOptionSet = (group) => new Set(
        Array.from(group.querySelectorAll('.default.option, .options .option, .option'))
          .map((item) => normalize(item.textContent))
          .filter(Boolean)
      );
      const findGroup = () => {
        const direct = doc.querySelector('.check-box.' + groupClass);
        if (direct) return direct;
        if (groupClass === 'school') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('985') || set.has('211') || set.has('双一流院校');
          }) || null;
        }
        if (groupClass === 'degree') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('大专') || set.has('本科') || set.has('硕士') || set.has('博士');
          }) || null;
        }
        if (groupClass === 'gender') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('男') || set.has('女');
          }) || null;
        }
        if (groupClass === 'recentNotView') {
          return groupCandidates.find((group) => {
            const set = getOptionSet(group);
            return set.has('近14天没有');
          }) || null;
        }
        return null;
      };

      const group = findGroup();
      if (!group) {
        return { ok: false, error: 'GROUP_NOT_FOUND' };
      }

      const defaultOption = group.querySelector('.default.option');
      const options = Array.from(group.querySelectorAll('.default.option, .options .option, .option'));
      const byLabel = new Map();
      for (const node of options) {
        const label = normalize(node.textContent);
        if (!label) continue;
        const className = String(node.className || '').trim();
        const active = node.classList.contains('active');
        const existing = byLabel.get(label);
        if (existing) {
          existing.active = existing.active || active;
          if (className && !existing.classNames.includes(className)) {
            existing.classNames.push(className);
          }
        } else {
          byLabel.set(label, {
            label,
            active,
            classNames: className ? [className] : []
          });
        }
      }

      const normalizedOptions = Array.from(byLabel.values()).map((item) => ({
        label: item.label,
        active: item.active,
        class_name: item.classNames.join(' | ')
      }));
      return {
        ok: true,
        group_class: groupClass,
        defaultActive: Boolean(defaultOption && defaultOption.classList.contains('active')),
        defaultClassName: defaultOption ? String(defaultOption.className || '').trim() : '',
        options: normalizedOptions,
        activeLabels: normalizedOptions.filter((item) => item.active).map((item) => item.label)
      };
    })(${JSON.stringify(groupClass)})`);
  }

  async getSchoolFilterState() {
    return this.getFilterGroupState("school");
  }

  async selectSchoolFilter(labels) {
    const ensure = await this.ensureGroupReady("school");
    if (!ensure?.ok) {
      throw new Error(ensure?.error || "GROUP_NOT_FOUND");
    }

    const targetLabels = Array.isArray(labels) && labels.length > 0 ? labels : ["不限"];
    const desired = sortSchoolSelection(targetLabels);
    const expectDefaultOnly = desired.includes("不限");
    let lastState = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.getSchoolFilterState();
      if (!state?.ok) {
        throw new Error(state?.error || "SCHOOL_FILTER_STATE_FAILED");
      }
      lastState = state;
      const current = sortSchoolSelection(state.activeLabels || []);
      const matched = expectDefaultOnly
        ? Boolean(state.defaultActive)
        : (!state.defaultActive && selectionEquals(current, desired));
      if (matched) {
        return;
      }

      if (expectDefaultOnly) {
        await this.selectOption("school", "不限");
        await sleep(humanDelay(180, 50));
        continue;
      }

      if (state.defaultActive) {
        const clearDefault = await this.clickOptionBySelector("school", "不限");
        if (!clearDefault?.ok) {
          throw new Error(clearDefault?.error || "SCHOOL_DEFAULT_CLEAR_FAILED");
        }
        await sleep(humanDelay(180, 50));
      }
      for (const label of desired) {
        await this.selectOption("school", label);
        await sleep(humanDelay(120, 40));
      }
      await sleep(humanDelay(180, 50));
    }

    throw new Error(`SCHOOL_FILTER_VERIFY_FAILED:${JSON.stringify(lastState || {})}`);
  }

  async getDegreeFilterState() {
    return this.getFilterGroupState("degree");
  }

  async getGenderFilterState() {
    return this.getFilterGroupState("gender");
  }

  async getRecentNotViewFilterState() {
    return this.getFilterGroupState("recentNotView");
  }

  async selectDegreeFilter(labels) {
    const ensure = await this.ensureGroupReady("degree");
    if (!ensure?.ok) {
      throw new Error(ensure?.error || "GROUP_NOT_FOUND");
    }

    const targetLabels = Array.isArray(labels) && labels.length > 0 ? labels : ["不限"];
    const desired = sortDegreeSelection(targetLabels);
    const expectDefaultOnly = desired.includes("不限");
    let lastState = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await this.getDegreeFilterState();
      if (!state?.ok) {
        throw new Error(state?.error || "DEGREE_FILTER_STATE_FAILED");
      }
      lastState = state;
      const current = sortDegreeSelection(state.activeLabels || []);
      const matched = expectDefaultOnly
        ? Boolean(state.defaultActive)
        : (!state.defaultActive && selectionEquals(current, desired));
      if (matched) {
        return;
      }

      if (expectDefaultOnly) {
        await this.selectOption("degree", "不限");
        await sleep(humanDelay(180, 50));
        continue;
      }

      if (state.defaultActive) {
        const clearDefault = await this.clickOptionBySelector("degree", "不限");
        if (!clearDefault?.ok) {
          throw new Error(clearDefault?.error || "DEGREE_DEFAULT_CLEAR_FAILED");
        }
        await sleep(humanDelay(180, 50));
      }
      for (const label of desired) {
        await this.selectOption("degree", label);
        await sleep(humanDelay(120, 40));
      }
      await sleep(humanDelay(180, 50));
    }

    throw new Error(`DEGREE_FILTER_VERIFY_FAILED:${JSON.stringify(lastState || {})}`);
  }

  buildGroupClassVerification(groupName, state, expectedLabels, availableOptions, sortFn) {
    if (!state?.ok) {
      return {
        group: groupName,
        ok: false,
        reason: state?.error || "GROUP_STATE_UNAVAILABLE",
        expected_labels: expectedLabels,
        state: state || null
      };
    }

    const expectedSorted = sortFn(uniqueNormalizedLabels(expectedLabels));
    const expectedSet = new Set(expectedSorted);
    const allowedSet = new Set(uniqueNormalizedLabels(availableOptions));
    const optionMap = new Map();
    for (const option of state.options || []) {
      optionMap.set(normalizeText(option.label), option);
    }

    const selectedNotActive = [];
    const unselectedButActive = [];
    for (const label of expectedSorted) {
      const option = optionMap.get(label);
      if (!option || option.active !== true) {
        selectedNotActive.push(label);
      }
    }
    for (const label of allowedSet) {
      if (expectedSet.has(label)) continue;
      const option = optionMap.get(label);
      if (option?.active === true) {
        unselectedButActive.push(label);
      }
    }

    const expectDefault = expectedSet.has("不限");
    const defaultMismatch = expectDefault ? !state.defaultActive : Boolean(state.defaultActive);
    const ok = (
      selectedNotActive.length === 0
      && unselectedButActive.length === 0
      && !defaultMismatch
    );

    return {
      group: groupName,
      ok,
      expected_labels: expectedSorted,
      actual_active_labels: sortFn(uniqueNormalizedLabels(state.activeLabels || [])),
      default_active: Boolean(state.defaultActive),
      selected_not_active: selectedNotActive,
      unselected_but_active: unselectedButActive,
      default_mismatch: defaultMismatch,
      options: state.options || []
    };
  }

  async verifyFilterDomClassStates(expected) {
    const schoolState = await this.getSchoolFilterState();
    const degreeState = await this.getDegreeFilterState();
    const genderState = await this.getGenderFilterState();
    const recentState = await this.getRecentNotViewFilterState();

    const checks = [
      this.buildGroupClassVerification(
        "school",
        schoolState,
        Array.isArray(expected?.schoolTag) && expected.schoolTag.length > 0 ? expected.schoolTag : ["不限"],
        SCHOOL_TAG_OPTIONS,
        sortSchoolSelection
      ),
      this.buildGroupClassVerification(
        "degree",
        degreeState,
        Array.isArray(expected?.degree) && expected.degree.length > 0 ? expected.degree : ["不限"],
        DEGREE_OPTIONS,
        sortDegreeSelection
      ),
      this.buildGroupClassVerification(
        "gender",
        genderState,
        [normalizeText(expected?.gender || "不限")],
        GENDER_OPTIONS,
        uniqueNormalizedLabels
      ),
      this.buildGroupClassVerification(
        "recent_not_view",
        recentState,
        [normalizeText(expected?.recentNotView || "不限")],
        RECENT_NOT_VIEW_OPTIONS,
        uniqueNormalizedLabels
      )
    ];
    const failures = checks.filter((item) => item.ok === false);
    return {
      ok: failures.length === 0,
      checks,
      failures,
      states: {
        school: schoolState,
        degree: degreeState,
        gender: genderState,
        recent_not_view: recentState
      }
    };
  }

  async countCandidates() {
    return this.evaluate(`(() => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const cards = Array.from(doc.querySelectorAll('ul.card-list > li.card-item'));
      const recommendCandidates = cards.filter((card) => card.querySelector('.card-inner[data-geekid]'));
      const featuredCards = Array.from(doc.querySelectorAll('li.geek-info-card'));
      const featuredCandidates = featuredCards.filter((card) => card.querySelector('a[data-geekid]'));
      const latestCards = Array.from(doc.querySelectorAll('.candidate-card-wrap'));
      const latestCandidates = latestCards.filter((card) => card.querySelector('.card-inner[data-geek], [data-geek]'));
      const tabs = Array.from(doc.querySelectorAll('li.tab-item[data-status], li[data-status][class*="tab"]'));
      const activeTab = tabs.find((node) => {
        const className = String(node.className || '');
        const selected = String(node.getAttribute('aria-selected') || '').toLowerCase() === 'true';
        return /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(className) || selected;
      }) || null;
      const activeTabStatus = activeTab ? String(activeTab.getAttribute('data-status') || '') : '';
      const inferredStatus = activeTabStatus
        || (featuredCandidates.length > 0 && recommendCandidates.length === 0 && latestCandidates.length === 0
          ? '3'
          : latestCandidates.length > 0 && recommendCandidates.length === 0 && featuredCandidates.length === 0
            ? '1'
            : recommendCandidates.length > 0 && featuredCandidates.length === 0 && latestCandidates.length === 0
              ? '0'
              : '');
      const effectiveCount = inferredStatus === '3'
        ? featuredCandidates.length
        : inferredStatus === '1'
          ? latestCandidates.length
        : inferredStatus === '0'
          ? recommendCandidates.length
          : Math.max(recommendCandidates.length, featuredCandidates.length, latestCandidates.length);
      const body = doc.body;
      return {
        ok: true,
        candidateCount: effectiveCount,
        recommendCandidateCount: recommendCandidates.length,
        featuredCandidateCount: featuredCandidates.length,
        latestCandidateCount: latestCandidates.length,
        activeTabStatus: inferredStatus || null,
        totalCardCount: cards.length,
        scrollTop: body ? body.scrollTop : 0,
        scrollHeight: body ? body.scrollHeight : 0,
        clientHeight: body ? body.clientHeight : 0
      };
    })()`);
  }

  async waitForCandidateCountStable() {
    let lastCount = null;
    let stableRounds = 0;
    let latest = null;
    for (let index = 0; index < 10; index += 1) {
      latest = await this.countCandidates();
      const current = latest?.candidateCount ?? null;
      if (current !== null && current === lastCount) {
        stableRounds += 1;
        if (stableRounds >= 2) {
          return latest;
        }
      } else {
        stableRounds = 0;
      }
      lastCount = current;
      await sleep(350 + index * 50);
    }
    return latest;
  }

  async run() {
    if (this.args.help) {
      console.log(JSON.stringify({
        status: "COMPLETED",
        result: {
          usage: "node src/cli.js --school-tag 985/211 --degree 本科及以上 --gender 男 --recent-not-view 近14天没有 --job \"算法工程师（视频/图像模型方向） _ 杭州\" --page-scope recommend|latest|featured --port 9222",
          list_jobs_usage: "node src/cli.js --list-jobs --port 9222"
        }
      }));
      return;
    }
    if (!Array.isArray(this.args.schoolTag) || this.args.schoolTag.length === 0) {
      throw new Error("INVALID_SCHOOL_TAG_INPUT");
    }
    if (!Array.isArray(this.args.degree) || this.args.degree.length === 0) {
      throw new Error("INVALID_DEGREE_INPUT");
    }

    await this.connect();
    try {
      const frameState = await this.getFrameState();
      if (!frameState?.ok) {
        if (frameState?.error === "LOGIN_REQUIRED") {
          throw new Error("LOGIN_REQUIRED");
        }
        throw new Error(frameState?.error || 'NO_RECOMMEND_IFRAME');
      }

      if (this.args.listJobs) {
        const jobState = await this.ensureJobListReady();
        console.log(JSON.stringify({
          status: "COMPLETED",
          result: {
            jobs: jobState.jobs || [],
            page_state: {
              target_url: this.target?.url || null,
              frame_url: frameState.frameUrl || jobState.frame_url || null
            }
          }
        }));
        return;
      }

      let selectedJob = null;
      if (this.args.job) {
        selectedJob = await this.selectJob(this.args.job);
        await sleep(humanDelay(220, 70));
      }

      await this.openFilterPanel();
      await this.selectSchoolFilter(this.args.schoolTag);
      await this.selectOption("gender", this.args.gender);
      await this.selectOption("recentNotView", this.args.recentNotView);
      await this.selectDegreeFilter(this.args.degree);
      const domClassVerification = await this.verifyFilterDomClassStates({
        schoolTag: this.args.schoolTag,
        degree: this.args.degree,
        gender: this.args.gender,
        recentNotView: this.args.recentNotView
      });
      if (!domClassVerification.ok) {
        throw new Error(`FILTER_DOM_CLASS_VERIFY_FAILED:${JSON.stringify(domClassVerification.failures)}`);
      }
      await this.closeFilterPanel();
      const candidateInfo = await this.waitForCandidateCountStable();

      console.log(JSON.stringify({
        status: "COMPLETED",
        result: {
          applied_filters: {
            school_tag: this.args.schoolTag,
            degree: this.args.degree,
            gender: this.args.gender,
            recent_not_view: this.args.recentNotView
          },
          verified_filters: {
            school: domClassVerification.states.school,
            degree: domClassVerification.states.degree,
            gender: domClassVerification.states.gender,
            recent_not_view: domClassVerification.states.recent_not_view,
            dom_class_check: {
              ok: domClassVerification.ok,
              checks: domClassVerification.checks
            }
          },
          selected_job: selectedJob,
          candidate_count: candidateInfo?.candidateCount ?? null,
          active_tab_status: candidateInfo?.activeTabStatus ?? null,
          selected_page: this.args.pageScope || "recommend",
          page_state: {
            target_url: this.target?.url || null,
            frame_url: frameState.frameUrl || null
          }
        }
      }));
    } finally {
      await this.disconnect();
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const finalArgs = await enrichArgsFromPrompt(args);
  const cli = new RecommendSearchCli(finalArgs);
  await cli.run();
}

function isDirectExecution() {
  const entry = process.argv?.[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.log(JSON.stringify({
      status: "FAILED",
      error: {
        code: error.message || "RECOMMEND_SEARCH_FAILED",
        message: error.message || "推荐页筛选执行失败。",
        retryable: true
      }
    }));
    process.exitCode = 1;
  });
}

export {
  RecommendSearchCli,
  normalizeJobTitle,
  parseArgs
};
