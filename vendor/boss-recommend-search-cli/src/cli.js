#!/usr/bin/env node
import process from "node:process";
import readline from "node:readline";
import CDP from "chrome-remote-interface";

const DEFAULT_PORT = 9222;
const RECOMMEND_URL_FRAGMENT = "/web/chat/recommend";
const SCHOOL_TAG_OPTIONS = ["不限", "985", "211", "双一流院校", "留学", "国内外名校", "公办本科"];
const DEGREE_OPTIONS = ["不限", "初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"];
const DEGREE_ORDER = ["初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"];
const GENDER_OPTIONS = ["不限", "男", "女"];
const RECENT_NOT_VIEW_OPTIONS = ["不限", "近14天没有"];

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parsePositiveInteger(raw) {
  const value = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
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
    schoolTag: "不限",
    degree: ["不限"],
    gender: "不限",
    recentNotView: "不限",
    port: DEFAULT_PORT,
    help: false,
    __provided: {
      schoolTag: false,
      degree: false,
      gender: false,
      recentNotView: false,
      port: false
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--school-tag" && next) {
      args.schoolTag = next;
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
  const askTargets = Object.values(args.__provided || {}).some((item) => item === false) || !Array.isArray(args.degree) || args.degree.length === 0;
  if (!askTargets) return args;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));
  try {
    if (!args.__provided.schoolTag) {
      args.schoolTag = await promptValue(
        ask,
        `学校标签（${SCHOOL_TAG_OPTIONS.join("/")}，默认: ${args.schoolTag}）: `,
        (value) => SCHOOL_TAG_OPTIONS.includes(value) ? value : null,
        args.schoolTag
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
    if (!args.__provided.degree || !Array.isArray(args.degree) || args.degree.length === 0) {
      const current = Array.isArray(args.degree) && args.degree.length > 0 ? args.degree.join(",") : "不限";
      args.degree = await promptValue(
        ask,
        `学历（可多选逗号分隔，支持“本科及以上”；默认: ${current}）: `,
        (value) => parseDegreeSelection(value),
        Array.isArray(args.degree) && args.degree.length > 0 ? args.degree : ["不限"]
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
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      return {
        ok: true,
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
      const school = doc.querySelector('.check-box.school');
      const degree = doc.querySelector('.check-box.degree');
      const gender = doc.querySelector('.check-box.gender');
      const recent = doc.querySelector('.check-box.recentNotView');
      return Boolean((school && degree && gender && recent) || isVisible(panel));
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
      const group = doc.querySelector('.check-box.' + groupClass);
      if (!group) {
        return { ok: false, error: 'GROUP_NOT_FOUND' };
      }
      const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
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

  async selectOption(groupClass, label) {
    const option = await this.getOptionInfo(groupClass, label);
    if (!option?.ok) {
      throw new Error(option?.error || 'OPTION_NOT_FOUND');
    }
    if (option.alreadySelected) {
      return;
    }
    await this.simulateHumanClick(option.x, option.y);
    await sleep(humanDelay(300, 80));
  }

  async getDegreeFilterState() {
    return this.evaluate(`(() => {
      const frame = document.querySelector('iframe[name="recommendFrame"]')
        || document.querySelector('iframe[src*="/web/frame/recommend/"]')
        || document.querySelector('iframe');
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const group = doc.querySelector('.check-box.degree');
      if (!group) {
        return { ok: false, error: 'GROUP_NOT_FOUND' };
      }
      const normalize = (value) => String(value || '').replace(/\\s+/g, '').trim();
      const labels = ${JSON.stringify(DEGREE_OPTIONS)};
      const activeLabels = labels.filter((label) => {
        const node = Array.from(group.querySelectorAll('.options .option'))
          .find((item) => normalize(item.textContent) === normalize(label));
        return Boolean(node && node.classList.contains('active'));
      });
      const defaultOption = group.querySelector('.default.option');
      return {
        ok: true,
        defaultActive: Boolean(defaultOption && defaultOption.classList.contains('active')),
        activeLabels
      };
    })()`);
  }

  async selectDegreeFilter(labels) {
    const targetLabels = Array.isArray(labels) && labels.length > 0 ? labels : ["不限"];
    if (targetLabels.includes("不限")) {
      await this.selectOption("degree", "不限");
      return;
    }

    const currentState = await this.getDegreeFilterState();
    if (!currentState?.ok) {
      throw new Error(currentState?.error || "DEGREE_FILTER_STATE_FAILED");
    }
    const current = sortDegreeSelection(currentState.activeLabels || []);
    const desired = sortDegreeSelection(targetLabels);
    const same =
      !currentState.defaultActive
      && current.length === desired.length
      && current.every((value, index) => value === desired[index]);
    if (same) return;

    await this.selectOption("degree", "不限");
    for (const label of desired) {
      await this.selectOption("degree", label);
    }
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
      const candidateCards = cards.filter((card) => card.querySelector('.card-inner[data-geekid]'));
      const body = doc.body;
      return {
        ok: true,
        candidateCount: candidateCards.length,
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
          usage: "node src/cli.js --school-tag 985 --degree 本科及以上 --gender 男 --recent-not-view 近14天没有 --port 9222"
        }
      }));
      return;
    }
    if (!Array.isArray(this.args.degree) || this.args.degree.length === 0) {
      throw new Error("INVALID_DEGREE_INPUT");
    }

    await this.connect();
    try {
      const frameState = await this.getFrameState();
      if (!frameState?.ok) {
        throw new Error(frameState?.error || 'NO_RECOMMEND_IFRAME');
      }

      await this.openFilterPanel();
      await this.selectOption("school", this.args.schoolTag);
      await this.selectDegreeFilter(this.args.degree);
      await this.selectOption("gender", this.args.gender);
      await this.selectOption("recentNotView", this.args.recentNotView);
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
          candidate_count: candidateInfo?.candidateCount ?? null,
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
