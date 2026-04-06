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
const RESUME_CAPTURE_WAIT_MS = 60000;
const RESUME_CAPTURE_MAX_ATTEMPTS = 4;
const RESUME_CAPTURE_RETRY_DELAY_MS = 1200;
const MAX_CONSECUTIVE_RESUME_CAPTURE_FAILURES = 10;
const PAGE_SCOPE_TAB_STATUS = {
  recommend: "0",
  featured: "3"
};

function getCodexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

function getDefaultCalibrationPath() {
  return path.join(getCodexHome(), "boss-recommend-mcp", "favorite-calibration.json");
}

function log(...args) {
  console.error(...args);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeUrl(value) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  const cleaned = raw
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u2064\uFEFF]/g, "")
    .replace(/^["']|["']$/g, "");
  return cleaned.replace(/\/+$/, "");
}

function validateUrlString(raw) {
  const sanitized = sanitizeUrl(raw);
  if (!sanitized) return { ok: false, error: "baseUrl 为空" };
  try {
    const url = new URL(sanitized);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false, error: `协议无效: ${url.protocol} (期望 http 或 https)` };
    }
    return { ok: true, sanitized, full: sanitized };
  } catch (e) {
    return { ok: false, error: `URL 格式无效: ${e.message}`, raw };
  }
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
  if (["none", "noop", "no-op", "什么也不做", "不做任何操作", "不操作", "仅筛选", "只筛选"].includes(normalized)) {
    return "none";
  }
  return null;
}

function normalizePageScope(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (["recommend", "推荐", "推荐页", "推荐页面"].includes(normalized)) return "recommend";
  if (["featured", "精选", "精选页", "精选页面", "精选牛人"].includes(normalized)) return "featured";
  return null;
}

function parseBoolean(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "是"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "否"].includes(normalized)) return false;
  return null;
}

function normalizeCliOptionToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (!token) {
    return { token: "", inlineValue: null };
  }
  const normalizedDashes = token.replace(/^[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]+/, "--");
  const eqIndex = normalizedDashes.indexOf("=");
  if (normalizedDashes.startsWith("--") && eqIndex > 2) {
    return {
      token: normalizedDashes.slice(0, eqIndex),
      inlineValue: normalizedDashes.slice(eqIndex + 1)
    };
  }
  return { token: normalizedDashes, inlineValue: null };
}

function parseFavoriteActionValue(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue === "boolean") return rawValue ? "add" : "del";
  if (typeof rawValue === "number") {
    if (rawValue === 1) return "add";
    if (rawValue === 0) return "del";
  }
  const normalized = normalizeText(rawValue).toLowerCase();
  if (!normalized) return null;
  if (
    ["1", "add", "favorite", "collect", "interested", "true", "yes", "on"].includes(normalized)
    || /(?:^|[_\W])(add|favorite|collect|interest(?:ed)?)(?:$|[_\W])/.test(normalized)
  ) {
    return "add";
  }
  if (
    ["0", "del", "delete", "remove", "cancel", "unfavorite", "uncollect", "false", "no", "off"].includes(normalized)
    || /(?:^|[_\W])(del|delete|remove|cancel|unfavorite|uncollect|uninterest)(?:$|[_\W])/.test(normalized)
  ) {
    return "del";
  }
  return null;
}

function parseFavoriteActionFromObject(payload, visited = new Set()) {
  if (!payload || typeof payload !== "object") return null;
  if (visited.has(payload)) return null;
  visited.add(payload);

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const action = parseFavoriteActionFromObject(item, visited);
      if (action) return action;
    }
    return null;
  }

  const keys = Object.keys(payload);
  const strongSignalKey = (key) => /p3|status|state|favorite|collect|interested|markstatus|isfavorite|iscollect/.test(key);
  const weakSignalKey = (key) => /action|op|operation|type|mode|mark|interest/.test(key);
  for (const key of keys) {
    const value = payload[key];
    const normalizedKey = normalizeText(key).toLowerCase();
    if (strongSignalKey(normalizedKey)) {
      const action = parseFavoriteActionValue(value);
      if (action) return action;
    }
  }
  for (const key of keys) {
    const value = payload[key];
    const normalizedKey = normalizeText(key).toLowerCase();
    if (weakSignalKey(normalizedKey)) {
      const action = parseFavoriteActionValue(value);
      if (action) return action;
    }
  }

  for (const key of keys) {
    const value = payload[key];
    if (value && typeof value === "object") {
      const action = parseFavoriteActionFromObject(value, visited);
      if (action) return action;
    }
  }
  return null;
}

function parseFavoriteActionFromPostData(rawPostData) {
  const postData = normalizeText(rawPostData);
  if (!postData) return null;

  try {
    const parsed = JSON.parse(postData);
    const action = parseFavoriteActionFromObject(parsed);
    if (action) return action;
  } catch {}

  try {
    const params = new URLSearchParams(postData);
    const strongEntries = [];
    const weakEntries = [];
    for (const [key, value] of params.entries()) {
      const normalizedKey = normalizeText(key).toLowerCase();
      if (/p3|status|state|favorite|collect|interested|markstatus|isfavorite|iscollect/.test(normalizedKey)) {
        strongEntries.push(value);
      } else if (/action|op|operation|type|mode|mark|interest/.test(normalizedKey)) {
        weakEntries.push(value);
      }
    }
    for (const value of strongEntries) {
      const action = parseFavoriteActionValue(value);
      if (action) return action;
    }
    for (const value of weakEntries) {
      const action = parseFavoriteActionValue(value);
      if (action) return action;
    }
  } catch {}

  const fallback = parseFavoriteActionValue(postData);
  if (fallback) return fallback;

  if (/star-interest-click/i.test(postData)) {
    if (/(?:^|[?&"'\s])p3(?:["'\s:=]){1,3}1(?:$|[&"'\s,}])/i.test(postData)) return "add";
    if (/(?:^|[?&"'\s])p3(?:["'\s:=]){1,3}0(?:$|[&"'\s,}])/i.test(postData)) return "del";
  }
  return null;
}

function parseFavoriteActionFromRequest(url, postData = "") {
  const normalizedUrl = normalizeText(url).toLowerCase();
  if (!normalizedUrl) return null;

  if (/\/add(?:\/|$)|[?&](?:action|op|operation|type)=add\b|[?&](?:status|p3|favorite|collect|interested)=1\b/i.test(normalizedUrl)) {
    return "add";
  }
  if (/\/del(?:\/|$)|[?&](?:action|op|operation|type)=del\b|[?&](?:status|p3|favorite|collect|interested)=0\b/i.test(normalizedUrl)) {
    return "del";
  }

  return parseFavoriteActionFromPostData(postData);
}

function parseFavoriteActionFromActionLog(postData = "") {
  const raw = normalizeText(postData);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (normalizeText(payload?.action).toLowerCase() !== "star-interest-click") return null;
    return parseFavoriteActionValue(payload?.p3);
  } catch {}

  try {
    const params = new URLSearchParams(raw);
    const actionName = normalizeText(params.get("action")).toLowerCase();
    if (actionName !== "star-interest-click") return null;
    return parseFavoriteActionValue(params.get("p3"));
  } catch {}
  return null;
}

function parseFavoriteActionFromKnownRequest(url, postData = "") {
  const normalizedUrl = normalizeText(url).toLowerCase();
  if (!normalizedUrl) return null;

  if (normalizedUrl.includes("usermark")) {
    if (/\/add(?:\/|$)|[?&](?:action|op|operation|type)=add\b/i.test(normalizedUrl)) {
      return "add";
    }
    if (/\/del(?:\/|$)|[?&](?:action|op|operation|type)=del\b/i.test(normalizedUrl)) {
      return "del";
    }
    return null;
  }

  if (normalizedUrl.includes("actionlog/common.json")) {
    return parseFavoriteActionFromActionLog(postData);
  }

  return null;
}

function parseFavoriteActionFromWsPayload(payload, depth = 0) {
  if (depth > 3 || payload === null || payload === undefined) return null;

  if (typeof payload === "object") {
    if (normalizeText(payload?.action).toLowerCase() === "star-interest-click") {
      const strictAction = parseFavoriteActionValue(payload?.p3);
      if (strictAction) return strictAction;
    }
    const nestedCandidates = [
      payload.data,
      payload.payload,
      payload.body,
      payload.message,
      payload.msg
    ];
    for (const nested of nestedCandidates) {
      const action = parseFavoriteActionFromWsPayload(nested, depth + 1);
      if (action) return action;
    }
    return null;
  }

  const text = normalizeText(payload);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    const action = parseFavoriteActionFromWsPayload(parsed, depth + 1);
    if (action) return action;
  } catch {}

  const actionFromActionLog = parseFavoriteActionFromActionLog(text);
  if (actionFromActionLog) return actionFromActionLog;
  if (/usermark/i.test(text)) {
    if (/\/add(?:\/|$)|[?&](?:action|op|operation|type)=add\b/i.test(text)) return "add";
    if (/\/del(?:\/|$)|[?&](?:action|op|operation|type)=del\b/i.test(text)) return "del";
  }

  return null;
}

function isRecoverablePostActionError(error, action) {
  const normalizedAction = normalizeText(action).toLowerCase();
  const normalizedCode = normalizeText(error?.code).toUpperCase();
  if (!normalizedAction || !normalizedCode) return false;
  if (normalizedAction === "favorite" && normalizedCode === "FAVORITE_BUTTON_FAILED") return true;
  if (normalizedAction === "greet" && normalizedCode === "GREET_BUTTON_FAILED") return true;
  return false;
}

function loadCalibrationPosition(filePath) {
  try {
    const resolved = path.resolve(String(filePath || ""));
    if (!resolved || !fs.existsSync(resolved)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    const favoritePosition = parsed?.favoritePosition;
    if (!favoritePosition) return null;
    if (!Number.isFinite(favoritePosition.pageX) || !Number.isFinite(favoritePosition.pageY)) {
      return null;
    }
    return {
      path: resolved,
      position: {
        pageX: Number(favoritePosition.pageX),
        pageY: Number(favoritePosition.pageY)
      }
    };
  } catch {
    return null;
  }
}

function shouldBringChromeToFront() {
  const envValue = normalizeText(process.env.BOSS_RECOMMEND_BRING_TO_FRONT || "").toLowerCase();
  if (envValue) {
    if (["1", "true", "yes", "y", "on"].includes(envValue)) return true;
    if (["0", "false", "no", "n", "off"].includes(envValue)) return false;
  }
  return false;
}

const SHOULD_BRING_TO_FRONT = shouldBringChromeToFront();

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
    pageScope: "recommend",
    calibrationPath: getDefaultCalibrationPath(),
    port: DEFAULT_PORT,
    output: path.resolve(process.cwd(), `筛选结果_${Date.now()}.csv`),
    checkpointPath: null,
    pauseControlPath: null,
    resume: false,
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
      pageScope: false,
      calibrationPath: false,
      port: false,
      postAction: false,
      postActionConfirmed: false
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const normalizedToken = normalizeCliOptionToken(argv[index]);
    const token = normalizedToken.token;
    const next = argv[index + 1];
    const inlineValue = normalizedToken.inlineValue;
    if ((token === "--baseurl" || token === "--base-url") && (inlineValue || next)) {
      parsed.baseUrl = inlineValue || next;
      parsed.__provided.baseUrl = true;
      if (!inlineValue) index += 1;
    } else if ((token === "--apikey" || token === "--api-key") && (inlineValue || next)) {
      parsed.apiKey = inlineValue || next;
      parsed.__provided.apiKey = true;
      if (!inlineValue) index += 1;
    } else if (token === "--model" && (inlineValue || next)) {
      parsed.model = inlineValue || next;
      parsed.__provided.model = true;
      if (!inlineValue) index += 1;
    } else if (token === "--openai-organization" && (inlineValue || next)) {
      parsed.openaiOrganization = inlineValue || next;
      if (!inlineValue) index += 1;
    } else if (token === "--openai-project" && (inlineValue || next)) {
      parsed.openaiProject = inlineValue || next;
      if (!inlineValue) index += 1;
    } else if (token === "--criteria" && (inlineValue || next)) {
      parsed.criteria = inlineValue || next;
      parsed.__provided.criteria = true;
      if (!inlineValue) index += 1;
    } else if ((token === "--targetCount" || token === "--target-count") && (inlineValue || next)) {
      parsed.targetCount = parsePositiveInteger(inlineValue || next);
      parsed.__provided.targetCount = true;
      if (!inlineValue) index += 1;
    } else if ((token === "--max-greet-count" || token === "--maxGreetCount") && (inlineValue || next)) {
      parsed.maxGreetCount = parsePositiveInteger(inlineValue || next);
      parsed.__provided.maxGreetCount = true;
      if (!inlineValue) index += 1;
    } else if ((token === "--page-scope" || token === "--pageScope" || token === "--page_scope") && (inlineValue || next)) {
      parsed.pageScope = normalizePageScope(inlineValue || next) || "recommend";
      parsed.__provided.pageScope = true;
      if (!inlineValue) index += 1;
    } else if ((token === "--calibration" || token === "--calibration-path") && (inlineValue || next)) {
      parsed.calibrationPath = path.resolve(inlineValue || next);
      parsed.__provided.calibrationPath = true;
      if (!inlineValue) index += 1;
    } else if (token === "--port" && (inlineValue || next)) {
      parsed.port = parsePositiveInteger(inlineValue || next) || DEFAULT_PORT;
      parsed.__provided.port = true;
      if (!inlineValue) index += 1;
    } else if (token === "--output" && (inlineValue || next)) {
      parsed.output = path.resolve(inlineValue || next);
      if (!inlineValue) index += 1;
    } else if (token === "--checkpoint-path" && (inlineValue || next)) {
      parsed.checkpointPath = path.resolve(inlineValue || next);
      if (!inlineValue) index += 1;
    } else if (token === "--pause-control-path" && (inlineValue || next)) {
      parsed.pauseControlPath = path.resolve(inlineValue || next);
      if (!inlineValue) index += 1;
    } else if (token === "--resume") {
      parsed.resume = true;
    } else if ((token === "--post-action" || token === "--postAction") && (inlineValue || next)) {
      parsed.postAction = normalizePostAction(inlineValue || next);
      parsed.__provided.postAction = true;
      if (!inlineValue) index += 1;
    } else if ((token === "--post-action-confirmed" || token === "--postActionConfirmed") && (inlineValue || next)) {
      parsed.postActionConfirmed = parseBoolean(inlineValue || next);
      parsed.__provided.postActionConfirmed = true;
      if (!inlineValue) index += 1;
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
        "本次通过人选统一执行什么动作？请输入 1(收藏) / 2(直接沟通) / 3(什么也不做): ",
        (value) => {
          if (value === "1") return "favorite";
          if (value === "2") return "greet";
          if (value === "3") return "none";
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

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseGeekIdFromUrl(url) {
  const raw = normalizeText(url);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const keys = ["geekId", "geek_id", "gid", "encryptGeekId", "securityId"];
    for (const key of keys) {
      const value = normalizeText(parsed.searchParams.get(key) || "");
      if (value) return value;
    }
  } catch {}
  const matched = raw.match(/[?&](?:geekId|geek_id|gid|encryptGeekId|securityId)=([^&]+)/i);
  if (matched?.[1]) return decodeURIComponent(matched[1]);
  return null;
}

function formatResumeApiData(data) {
  const parts = [];
  const geekDetail = data?.geekDetail || data || {};
  const baseInfo = geekDetail.geekBaseInfo || {};
  const expectList = geekDetail.geekExpectList || [];
  const workExpList = geekDetail.geekWorkExpList || [];
  const projExpList = geekDetail.geekProjExpList || [];
  const eduExpList = geekDetail.geekEduExpList || geekDetail.geekEducationList || [];
  const advantage = geekDetail.geekAdvantage || baseInfo.userDesc || baseInfo.userDescription || "";
  const skillList = geekDetail.geekSkillList || geekDetail.skillList || [];

  parts.push("=== 基本信息 ===");
  if (baseInfo.name) parts.push(`姓名: ${baseInfo.name}`);
  if (baseInfo.ageDesc) parts.push(`年龄: ${baseInfo.ageDesc}`);
  if (baseInfo.gender !== undefined) parts.push(`性别: ${baseInfo.gender === 1 ? "男" : "女"}`);
  if (baseInfo.degreeCategory) parts.push(`学历: ${baseInfo.degreeCategory}`);
  if (baseInfo.workYearDesc) parts.push(`工作经验: ${baseInfo.workYearDesc}`);
  if (baseInfo.activeTimeDesc) parts.push(`活跃状态: ${baseInfo.activeTimeDesc}`);
  if (baseInfo.applyStatusContent) parts.push(`求职状态: ${baseInfo.applyStatusContent}`);

  if (expectList.length > 0) {
    parts.push("\n=== 期望工作 ===");
    expectList.forEach((expect, index) => {
      parts.push(`${index + 1}. 期望城市: ${expect.locationName || "未知"}`);
      if (expect.positionName) parts.push(`   期望职位: ${expect.positionName}`);
      if (expect.salaryDesc) parts.push(`   期望薪资: ${expect.salaryDesc}`);
      if (expect.industryDesc) parts.push(`   期望行业: ${expect.industryDesc}`);
    });
  }

  if (advantage) {
    parts.push("\n=== 个人优势 ===");
    parts.push(stripHtml(advantage));
  }

  if (workExpList.length > 0) {
    parts.push("\n=== 工作经历 ===");
    workExpList.forEach((exp, index) => {
      const company = exp.company || "";
      const position = stripHtml(exp.positionName || "");
      parts.push(`${index + 1}. ${company} - ${position}`);
      if (exp.startYearMonStr) {
        parts.push(`   时间: ${exp.startYearMonStr} ~ ${exp.endYearMonStr || "至今"}`);
      }
      if (exp.responsibility) {
        parts.push(`   职责: ${stripHtml(exp.responsibility)}`);
      }
    });
  }

  if (projExpList.length > 0) {
    parts.push("\n=== 项目经历 ===");
    projExpList.forEach((proj, index) => {
      parts.push(`${index + 1}. ${proj.name || "未知项目"}`);
      if (proj.roleName) parts.push(`   角色: ${proj.roleName}`);
      if (proj.startYearMonStr) {
        parts.push(`   时间: ${proj.startYearMonStr} ~ ${proj.endYearMonStr || "至今"}`);
      }
      if (proj.description) parts.push(`   描述: ${stripHtml(proj.description)}`);
      if (proj.performance) parts.push(`   成果: ${stripHtml(proj.performance)}`);
    });
  }

  if (eduExpList.length > 0) {
    parts.push("\n=== 教育经历 ===");
    eduExpList.forEach((edu, index) => {
      parts.push(`${index + 1}. ${edu.school || edu.schoolName || "未知学校"}`);
      if (edu.major || edu.majorName) parts.push(`   专业: ${edu.major || edu.majorName}`);
      const eduDegree = edu.degree || edu.degreeCategory || edu.degreeName;
      if (eduDegree) parts.push(`   学历: ${eduDegree}`);
      const eduStart = edu.startYearMonStr || edu.startYearStr;
      if (eduStart) {
        const eduEnd = edu.endYearMonStr || edu.endYearStr || "";
        parts.push(`   时间: ${eduStart} ~ ${eduEnd}`);
      }
    });
  }

  if (skillList.length > 0) {
    parts.push("\n=== 技能标签 ===");
    skillList.forEach((skill) => {
      if (skill.skillName || skill.name) {
        parts.push(`- ${skill.skillName || skill.name}${skill.level ? ` (${skill.level})` : ""}`);
      }
    });
  }

  return parts.join("\n");
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
    const answer = normalizeText(await ask("本次通过人选统一执行什么动作？请输入 1(收藏) / 2(直接沟通) / 3(什么也不做): "));
    if (answer === "1") return "favorite";
    if (answer === "2") return "greet";
    if (answer === "3") return "none";
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
    const featuredCards = Array.from(doc.querySelectorAll('li.geek-info-card'));
    const textOf = (el) => String(el ? el.textContent : '').replace(/\s+/g, ' ').trim();
    const tabs = Array.from(doc.querySelectorAll('li.tab-item[data-status], li[data-status][class*="tab"]'));
    const activeTab = tabs.find((node) => /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(String(node.className || ''))) || null;
    const activeStatus = activeTab ? String(activeTab.getAttribute('data-status') || '') : '';
    const recommendCandidates = cards.map((card, index) => {
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
        height: rect.height,
        layout: 'recommend'
      };
    }).filter(Boolean);
    const featuredCandidates = featuredCards.map((card, index) => {
      const anchor = card.querySelector('a[data-geekid]');
      if (!anchor) return null;
      const geekId = anchor.getAttribute('data-geekid');
      if (!geekId) return null;
      const rect = card.getBoundingClientRect();
      const nameEl = card.querySelector('.name, .geek-name, .name-wrap .name');
      const tags = Array.from(card.querySelectorAll('.base-info span, .desc span, .tag-wrap span, .edu-wrap span'))
        .map((item) => textOf(item))
        .filter(Boolean);
      return {
        found: true,
        index,
        key: geekId,
        geek_id: geekId,
        name: textOf(nameEl),
        school: tags[0] || '',
        major: tags[1] || '',
        degree: tags[2] || '',
        last_company: '',
        last_position: '',
        x: frameRect.left + rect.left + Math.min(Math.max(rect.width / 2, 80), Math.max(rect.width - 40, 80)),
        y: frameRect.top + rect.top + Math.min(Math.max(rect.height / 2, 24), Math.max(rect.height - 12, 24)),
        width: rect.width,
        height: rect.height,
        layout: 'featured'
      };
    }).filter(Boolean);
    const inferredStatus = activeStatus
      || (featuredCandidates.length > 0 && recommendCandidates.length === 0 ? '3' : recommendCandidates.length > 0 ? '0' : '');
    const activeLayout = inferredStatus === '3'
      ? 'featured'
      : inferredStatus === '0'
        ? 'recommend'
        : (featuredCandidates.length > 0 && recommendCandidates.length === 0 ? 'featured' : 'recommend');
    const candidates = activeLayout === 'featured' ? featuredCandidates : recommendCandidates;
    return {
      ok: true,
      candidates: candidates.filter((candidate) => !processed.has(candidate.key)),
      candidate_count: candidates.length,
      total_cards: activeLayout === 'featured' ? featuredCards.length : cards.length,
      active_tab_status: inferredStatus || null,
      layout: activeLayout
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
  const frameRect = frame.getBoundingClientRect();
  const cards = Array.from(doc.querySelectorAll('ul.card-list > li.card-item'));
  const candidateCards = cards.filter((card) => card.querySelector('.card-inner[data-geekid]'));
  const featuredCards = Array.from(doc.querySelectorAll('li.geek-info-card'));
  const featuredCandidates = featuredCards.filter((card) => card.querySelector('a[data-geekid]'));
  const tabs = Array.from(doc.querySelectorAll('li.tab-item[data-status], li[data-status][class*="tab"]'));
  const activeTab = tabs.find((node) => /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(String(node.className || ''))) || null;
  const activeTabStatus = activeTab ? String(activeTab.getAttribute('data-status') || '') : '';
  const inferredStatus = activeTabStatus
    || (featuredCandidates.length > 0 && candidateCards.length === 0 ? '3' : candidateCards.length > 0 ? '0' : '');
  const effectiveCount = inferredStatus === '3'
    ? featuredCandidates.length
    : inferredStatus === '0'
      ? candidateCards.length
      : Math.max(candidateCards.length, featuredCandidates.length);
  return {
    ok: true,
    scrollTop: body ? body.scrollTop : 0,
    scrollHeight: body ? body.scrollHeight : 0,
    clientHeight: body ? body.clientHeight : 0,
    clientWidth: body ? body.clientWidth : 0,
    frameRect: {
      width: frameRect.width,
      height: frameRect.height
    },
    viewport: {
      width: (doc.defaultView && Number.isFinite(doc.defaultView.innerWidth)) ? doc.defaultView.innerWidth : 0,
      height: (doc.defaultView && Number.isFinite(doc.defaultView.innerHeight)) ? doc.defaultView.innerHeight : 0
    },
    candidateCount: effectiveCount,
    recommendCandidateCount: candidateCards.length,
    featuredCandidateCount: featuredCandidates.length,
    totalCards: Math.max(cards.length, featuredCards.length),
    activeTabStatus: inferredStatus || null
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
  const recommendCards = Array.from(doc.querySelectorAll('ul.card-list > li.card-item')).filter((card) => card.querySelector('.card-inner[data-geekid]'));
  const featuredCards = Array.from(doc.querySelectorAll('li.geek-info-card')).filter((card) => card.querySelector('a[data-geekid]'));
  const tabs = Array.from(doc.querySelectorAll('li.tab-item[data-status], li[data-status][class*="tab"]'));
  const activeTab = tabs.find((node) => /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(String(node.className || ''))) || null;
  const activeStatus = activeTab ? String(activeTab.getAttribute('data-status') || '') : '';
  const inferredStatus = activeStatus
    || (featuredCards.length > 0 && recommendCards.length === 0 ? '3' : recommendCards.length > 0 ? '0' : '');
  const activeCards = inferredStatus === '3' ? featuredCards : recommendCards;
  const lastCard = activeCards[activeCards.length - 1];
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
  const isVisible = (el) => {
    if (!el) return false;
    const win = doc.defaultView;
    if (!win) return el.offsetParent !== null;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2 && el.offsetParent !== null;
  };
  const finishedWrap = Array.from(doc.querySelectorAll('.finished-wrap')).find((el) => isVisible(el)) || null;
  const refreshButton = Array.from(doc.querySelectorAll('.finished-wrap .btn.btn-refresh, .finished-wrap .btn-refresh, .no-data-refresh .btn-refresh'))
    .find((el) => isVisible(el)) || null;
  const keywords = ['没有更多', '已显示全部', '已经到底', '暂无更多', '推荐完了', '没有更多人选'];
  const elements = Array.from(doc.querySelectorAll('div,span,p'));
  for (const el of elements) {
    if (el.offsetParent === null) continue;
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 40) continue;
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        return {
          isBottom: true,
          reason: keyword,
          finished_wrap_visible: Boolean(finishedWrap),
          refresh_button_visible: Boolean(refreshButton),
          refresh_button_text: refreshButton ? String(refreshButton.textContent || '').replace(/\s+/g, ' ').trim() : null
        };
      }
    }
  }
  return {
    isBottom: Boolean(finishedWrap),
    reason: finishedWrap ? 'finished-wrap' : null,
    finished_wrap_visible: Boolean(finishedWrap),
    refresh_button_visible: Boolean(refreshButton),
    refresh_button_text: refreshButton ? String(refreshButton.textContent || '').replace(/\s+/g, ' ').trim() : null
  };
})()`;
const jsWaitForDetail = `(() => {
  const topVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const topSignals = [
    '.dialog-wrap.active',
    '.boss-popup__wrapper',
    '.boss-popup_wrapper',
    'iframe[src*="/web/frame/c-resume/"]',
    'iframe[name*="resume"]'
  ];
  for (const sel of topSignals) {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const node of nodes) {
      if (topVisible(node)) {
        return { open: true, scope: 'top', selector: sel };
      }
    }
  }
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
  return { open, scope: 'frame' };
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

  const topVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const topCloseSelectors = [
    '.boss-popup__close',
    '.popup-close',
    '.modal-close',
    '.dialog-close',
    '.close-btn',
    'button[aria-label*="关闭"]',
    'button[title*="关闭"]',
    '.icon-close'
  ];
  for (const sel of topCloseSelectors) {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const node of nodes) {
      if (!topVisible(node)) continue;
      try {
        node.click();
        return { ok: true, method: 'top-close', selector: sel };
      } catch {}
    }
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
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (doc, el) => {
    if (!el) return false;
    const view = doc.defaultView || window;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const resolveFavorite = (doc, offsetX, offsetY, scope) => {
    if (!doc) return null;
    const direct = Array.from(doc.querySelectorAll('.like-icon-and-text')).find((node) => isVisible(doc, node)) || null;
    const footer = doc.querySelector('.resume-footer.item-operate, .resume-footer-wrap, .resume-footer');
    const fromFooter = footer
      ? Array.from(footer.querySelectorAll('[class*="collect"], [class*="favorite"], button, .btn, span'))
        .find((node) => isVisible(doc, node) && /收藏|已收藏|感兴趣|已感兴趣/.test(normalize(node.textContent) + normalize(node.className)))
      : null;
    const fallback = Array.from(doc.querySelectorAll('button, .btn, span, div, a'))
      .filter((node) => isVisible(doc, node))
      .find((node) => /收藏|已收藏|感兴趣|已感兴趣/.test(normalize(node.textContent) + normalize(node.className))) || null;
    const root = direct || fromFooter || fallback;
    if (!root) return null;
    const rect = root.getBoundingClientRect();
    const label = normalize((root.querySelector ? root.querySelector('.btn-text') : null)?.textContent || root.textContent);
    const className = normalize(root.className || '');
    const active = (
      /已收藏|已感兴趣/.test(label)
      || /(?:^|\\s)(?:active|curr|current|selected|checked)(?:\\s|$)/i.test(className)
      || Boolean(root.querySelector && root.querySelector('.like-icon.like-icon-active, .active, .selected, .curr'))
    );
    return {
      ok: true,
      active,
      label: label || null,
      x: offsetX + rect.left + rect.width / 2,
      y: offsetY + rect.top + rect.height / 2,
      scope
    };
  };

  const topResult = resolveFavorite(document, 0, 0, 'top');
  if (topResult) return topResult;

  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const frameRect = frame.getBoundingClientRect();
  const frameResult = resolveFavorite(frame.contentDocument, frameRect.left, frameRect.top, 'frame');
  if (frameResult) return frameResult;
  return { ok: false, error: 'FAVORITE_BUTTON_NOT_FOUND' };
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

const jsGetGreetStateRecommend = `(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (doc, el) => {
    if (!el) return false;
    const view = doc.defaultView || window;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const resolveGreet = (doc, offsetX, offsetY, scope) => {
    if (!doc) return null;
    const candidates = [
      ...Array.from(doc.querySelectorAll('button.btn-v2.btn-sure-v2.btn-greet')),
      ...Array.from(doc.querySelectorAll('.resume-footer.item-operate button.btn-v2, .resume-footer-wrap button.btn-v2')),
      ...Array.from(doc.querySelectorAll('.resume-footer.item-operate button, .resume-footer-wrap button'))
    ];
    const button = candidates.find((item) => isVisible(doc, item) && /沟通|打招呼|聊一聊/.test(normalize(item.textContent))) || null;
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return {
      ok: true,
      disabled: Boolean(button.disabled),
      x: offsetX + rect.left + rect.width / 2,
      y: offsetY + rect.top + rect.height / 2,
      scope
    };
  };
  const topResult = resolveGreet(document, 0, 0, 'top');
  if (topResult) return topResult;

  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const frameRect = frame.getBoundingClientRect();
  const frameResult = resolveGreet(frame.contentDocument, frameRect.left, frameRect.top, 'frame');
  if (frameResult) return frameResult;
  return { ok: false, error: 'GREET_BUTTON_NOT_FOUND' };
})()`;

const jsClickGreetFallbackRecommend = `(() => {
  const topButton = Array.from(document.querySelectorAll('.resume-footer.item-operate button, .resume-footer-wrap button, button.btn-v2.btn-sure-v2'))
    .find((item) => item && item.offsetParent !== null && /沟通|打招呼|聊一聊/.test(String(item.textContent || '').replace(/\\s+/g, ' ')));
  if (topButton) {
    topButton.click();
    return { ok: true, scope: 'top' };
  }
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

const jsGetGreetStateFeatured = `(() => {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (doc, el) => {
    if (!el) return false;
    const view = doc.defaultView || window;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const resolveGreet = (doc, offsetX, offsetY, scope) => {
    if (!doc) return null;
    const candidates = [
      ...Array.from(doc.querySelectorAll('button.btn-v2.position-rights.btn-sure-v2')),
      ...Array.from(doc.querySelectorAll('button.btn-v2.btn-sure-v2.position-rights')),
      ...Array.from(doc.querySelectorAll('.resume-footer.item-operate button.btn-v2, .resume-footer-wrap button.btn-v2')),
      ...Array.from(doc.querySelectorAll('.resume-footer.item-operate button, .resume-footer-wrap button'))
    ];
    const button = candidates.find((item) => isVisible(doc, item) && /立即沟通|沟通|打招呼|聊一聊/.test(normalize(item.textContent))) || null;
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return {
      ok: true,
      disabled: Boolean(button.disabled),
      x: offsetX + rect.left + rect.width / 2,
      y: offsetY + rect.top + rect.height / 2,
      scope
    };
  };
  const topResult = resolveGreet(document, 0, 0, 'top');
  if (topResult) return topResult;

  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const frameRect = frame.getBoundingClientRect();
  const frameResult = resolveGreet(frame.contentDocument, frameRect.left, frameRect.top, 'frame');
  if (frameResult) return frameResult;
  return { ok: false, error: 'GREET_BUTTON_NOT_FOUND' };
})()`;

const jsClickGreetFallbackFeatured = `(() => {
  const topButton = Array.from(document.querySelectorAll('button.btn-v2.position-rights.btn-sure-v2, button.btn-v2.btn-sure-v2.position-rights, .resume-footer.item-operate button, .resume-footer-wrap button'))
    .find((item) => item && item.offsetParent !== null && /立即沟通|沟通|打招呼|聊一聊/.test(String(item.textContent || '').replace(/\\s+/g, ' ')));
  if (topButton) {
    topButton.click();
    return { ok: true, scope: 'top' };
  }
  const frame = document.querySelector('iframe[name="recommendFrame"]')
    || document.querySelector('iframe[src*="/web/frame/recommend/"]')
    || document.querySelector('iframe');
  if (!frame || !frame.contentDocument) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  const doc = frame.contentDocument;
  const button = doc.querySelector('button.btn-v2.position-rights.btn-sure-v2, button.btn-v2.btn-sure-v2.position-rights');
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
  return { ok: false, error: 'RELOAD_DISABLED_BY_POLICY' };
})()`;

class RecommendScreenCli {
  constructor(args) {
    this.args = args;
    const baseUrlCheck = validateUrlString(this.args.baseUrl);
    if (this.args.baseUrl && !baseUrlCheck.ok) {
      log(`[警告] baseUrl 校验失败: ${baseUrlCheck.error}, 原始值=${JSON.stringify(this.args.baseUrl)}`);
    }
    if (baseUrlCheck.sanitized) {
      this.args.baseUrl = baseUrlCheck.sanitized;
    }
    this.client = null;
    this.Runtime = null;
    this.Input = null;
    this.Page = null;
    this.Browser = null;
    this.Network = null;
    this.target = null;
    this.windowId = null;
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
    this.consecutiveResumeCaptureFailures = 0;
    this.resumeCaptureFailureStreakKeys = [];
    this.currentCandidateKey = null;
    this.resumeNetworkRequests = new Map();
    this.resumeNetworkByGeekId = new Map();
    this.latestResumeNetworkPayload = null;
    this.favoriteActionEvents = [];
    this.favoriteClickPendingSince = 0;
    this.favoriteNetworkTraces = [];
    this.webSocketByRequestId = new Map();
    this.resumeSourceStats = {
      network: 0,
      image_fallback: 0
    };
    this.lastActiveTabStatus = PAGE_SCOPE_TAB_STATUS[this.args.pageScope] || null;
    this.featuredCalibration = this.args.pageScope === "featured"
      ? loadCalibrationPosition(this.args.calibrationPath)
      : null;
    this.restCounter = 0;
    this.restThreshold = 25 + Math.floor(Math.random() * 8);
    this.checkpointPath = this.args.checkpointPath ? path.resolve(this.args.checkpointPath) : null;
    this.pauseControlPath = this.args.pauseControlPath ? path.resolve(this.args.pauseControlPath) : null;
    this.debugDir = path.join(os.tmpdir(), "boss-recommend-screen", String(Date.now()));
    fs.mkdirSync(this.debugDir, { recursive: true });
  }

  readPauseControlState() {
    if (!this.pauseControlPath) return { pause_requested: false };
    try {
      if (!fs.existsSync(this.pauseControlPath)) return { pause_requested: false };
      const raw = fs.readFileSync(this.pauseControlPath, "utf8");
      const parsed = JSON.parse(raw);
      const pauseRequested = parsed?.pause_requested === true || parsed?.control?.pause_requested === true;
      const pauseRequestedAt = normalizeText(parsed?.pause_requested_at || parsed?.control?.pause_requested_at);
      const requestedBy = normalizeText(parsed?.requested_by || parsed?.control?.pause_requested_by);
      return {
        pause_requested: pauseRequested,
        pause_requested_at: pauseRequestedAt,
        requested_by: requestedBy
      };
    } catch {
      return { pause_requested: false };
    }
  }

  shouldPauseAtBoundary() {
    const control = this.readPauseControlState();
    return control.pause_requested === true;
  }

  buildCheckpointPayload() {
    return {
      version: 1,
      saved_at: new Date().toISOString(),
      output_csv: this.args.output,
      processed_count: this.processedCount,
      skipped_count: this.skippedCount,
      greet_count: this.greetCount,
      greet_limit_fallback_count: this.greetLimitFallbackCount,
      processed_keys: Array.from(this.processedKeys),
      passed_candidates: this.passedCandidates.map((item) => ({
        name: item?.name || "",
        school: item?.school || "",
        major: item?.major || "",
        company: item?.company || "",
        position: item?.position || "",
        reason: item?.reason || "",
        action: item?.action || "",
        geekId: item?.geekId || "",
        summary: item?.summary || "",
        imagePath: item?.imagePath || "",
        resumeSource: item?.resumeSource || ""
      }))
    };
  }

  buildProgressSnapshot(completionReason = null) {
    const defaultResumeSource = this.args.pageScope === "featured" ? "network" : "image_fallback";
    const snapshot = {
      processed_count: this.processedCount,
      passed_count: this.passedCandidates.length,
      skipped_count: this.skippedCount,
      output_csv: this.args.output,
      checkpoint_path: this.checkpointPath,
      selected_page: this.args.pageScope || "recommend",
      active_tab_status: this.lastActiveTabStatus || PAGE_SCOPE_TAB_STATUS[this.args.pageScope] || null,
      resume_source: this.resumeSourceStats.image_fallback > 0
        ? "image_fallback"
        : this.resumeSourceStats.network > 0
          ? "network"
          : defaultResumeSource,
      post_action: this.args.postAction,
      max_greet_count: this.args.postAction === "greet" ? this.args.maxGreetCount : null,
      greet_count: this.greetCount,
      greet_limit_fallback_count: this.greetLimitFallbackCount
    };
    if (completionReason) {
      snapshot.completion_reason = completionReason;
    }
    return snapshot;
  }

  markFavoriteClickPending() {
    this.favoriteClickPendingSince = Date.now();
    this.favoriteNetworkTraces = [];
  }

  consumeFavoriteActionResult(since = 0) {
    const timestamp = Number.isFinite(since) ? since : 0;
    const matched = this.favoriteActionEvents.find((item) => Number(item?.ts || 0) >= timestamp) || null;
    if (!matched) {
      if (this.favoriteClickPendingSince > 0 && (Date.now() - this.favoriteClickPendingSince) > 8000) {
        this.favoriteClickPendingSince = 0;
      }
      return null;
    }
    this.favoriteActionEvents = this.favoriteActionEvents.filter((item) => item !== matched);
    this.favoriteClickPendingSince = 0;
    return matched.action || null;
  }

  recordFavoriteNetworkTrace(entry) {
    const trace = {
      ts: Date.now(),
      ...entry
    };
    this.favoriteNetworkTraces.push(trace);
    if (this.favoriteNetworkTraces.length > 60) {
      this.favoriteNetworkTraces = this.favoriteNetworkTraces.slice(-60);
    }
  }

  summarizeFavoriteNetworkTrace(since = 0) {
    const timestamp = Number.isFinite(since) ? since : 0;
    return this.favoriteNetworkTraces
      .filter((item) => Number(item?.ts || 0) >= timestamp)
      .slice(-12)
      .map((item) => {
        if (item.kind === "ws") {
          return `[ws:${item.direction}] ${item.url || "unknown"} payload=${item.payload || ""}`;
        }
        return `[http] ${item.method || "GET"} ${item.url || ""} body=${item.postData || ""}`;
      });
  }

  cacheResumeNetworkPayload(payload, fallbackGeekId = null) {
    if (!payload || typeof payload !== "object") return;
    const geekDetail = payload.geekDetail || payload;
    const baseInfo = geekDetail.geekBaseInfo || {};
    const geekId = normalizeText(
      fallbackGeekId
      || baseInfo.geekId
      || baseInfo.encryptGeekId
      || geekDetail.geekId
      || payload.geekId
      || ""
    ) || null;
    const candidateInfo = {
      name: baseInfo.name || geekDetail.geekName || payload.geekName || "",
      school: (geekDetail.geekEduExpList && geekDetail.geekEduExpList[0]?.school)
        || (geekDetail.geekEducationList && geekDetail.geekEducationList[0]?.school)
        || "",
      major: (geekDetail.geekEduExpList && geekDetail.geekEduExpList[0]?.major)
        || (geekDetail.geekEducationList && geekDetail.geekEducationList[0]?.major)
        || "",
      company: (geekDetail.geekWorkExpList && geekDetail.geekWorkExpList[0]?.company) || "",
      position: (geekDetail.geekWorkExpList && geekDetail.geekWorkExpList[0]?.positionName) || "",
      resumeText: formatResumeApiData(payload),
      alreadyInterested: payload.alreadyInterested === true
    };
    const wrapped = {
      ts: Date.now(),
      geekId: geekId || null,
      data: payload,
      candidateInfo
    };
    this.latestResumeNetworkPayload = wrapped;
    if (geekId) {
      this.resumeNetworkByGeekId.set(geekId, wrapped);
    }
  }

  tryExtractNetworkResumeForCandidate(candidate) {
    const candidateKey = normalizeText(candidate?.key || candidate?.geek_id || "");
    if (candidateKey && this.resumeNetworkByGeekId.has(candidateKey)) {
      return this.resumeNetworkByGeekId.get(candidateKey)?.candidateInfo || null;
    }
    if (this.latestResumeNetworkPayload) {
      const ageMs = Date.now() - Number(this.latestResumeNetworkPayload.ts || 0);
      if (ageMs <= 12000) {
        return this.latestResumeNetworkPayload.candidateInfo || null;
      }
    }
    return null;
  }

  async waitForNetworkResumeCandidateInfo(candidate, timeoutMs = 2200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = this.tryExtractNetworkResumeForCandidate(candidate);
      if (info && normalizeText(info.resumeText)) {
        return info;
      }
      await sleep(120);
    }
    return null;
  }

  handleNetworkRequestWillBeSent(params) {
    const url = normalizeText(params?.request?.url || "");
    if (!url) return;
    if (url.includes("/wapi/zpitem/web/boss/search/geek/info")) {
      const geekId = parseGeekIdFromUrl(url);
      this.resumeNetworkRequests.set(params.requestId, {
        ts: Date.now(),
        url,
        geekId
      });
      return;
    }

    if (this.favoriteClickPendingSince <= 0) return;
    const requestTs = Date.now();
    if (requestTs < this.favoriteClickPendingSince) return;
    const method = normalizeText(params?.request?.method || "").toUpperCase() || "GET";
    const postData = params?.request?.postData || "";
    this.recordFavoriteNetworkTrace({
      ts: requestTs,
      kind: "http",
      method,
      url: url.slice(0, 240),
      postData: normalizeText(postData).slice(0, 200)
    });
    const action = parseFavoriteActionFromKnownRequest(url, postData);
    if (!action) return;
    const source = url.includes("userMark")
      ? "userMark"
      : url.includes("actionLog/common.json")
        ? "actionLog"
        : "favorite";
    this.favoriteActionEvents.push({ action, ts: requestTs, source, url });
  }

  handleNetworkWebSocketCreated(params) {
    const requestId = normalizeText(params?.requestId || "");
    if (!requestId) return;
    const url = normalizeText(params?.url || "");
    this.webSocketByRequestId.set(requestId, url || "");
  }

  handleNetworkWebSocketFrame(params, direction = "sent") {
    if (this.favoriteClickPendingSince <= 0) return;
    const ts = Date.now();
    if (ts < this.favoriteClickPendingSince) return;
    const requestId = normalizeText(params?.requestId || "");
    const payloadData = normalizeText(params?.response?.payloadData || "");
    const wsUrl = this.webSocketByRequestId.get(requestId) || "";
    this.recordFavoriteNetworkTrace({
      ts,
      kind: "ws",
      direction,
      url: wsUrl ? wsUrl.slice(0, 240) : requestId ? `ws:${requestId}` : "ws",
      payload: payloadData.slice(0, 200)
    });
    const action = parseFavoriteActionFromWsPayload(payloadData);
    if (!action) return;
    this.favoriteActionEvents.push({
      action,
      ts,
      source: `websocket_${direction}`,
      url: wsUrl || (requestId ? `ws:${requestId}` : "websocket")
    });
  }

  async handleNetworkLoadingFinished(params) {
    const requestMeta = this.resumeNetworkRequests.get(params?.requestId);
    if (!requestMeta) return;
    this.resumeNetworkRequests.delete(params.requestId);
    try {
      const responseBody = await this.Network.getResponseBody({ requestId: params.requestId });
      if (!responseBody?.body) return;
      const parsed = JSON.parse(responseBody.body);
      if (parsed?.zpData) {
        this.cacheResumeNetworkPayload(parsed.zpData, requestMeta.geekId);
      }
    } catch {}
  }

  resetResumeCaptureFailureStreak() {
    this.consecutiveResumeCaptureFailures = 0;
    this.resumeCaptureFailureStreakKeys = [];
  }

  recordResumeCaptureFailure(candidateKey) {
    this.consecutiveResumeCaptureFailures += 1;
    if (candidateKey) {
      this.resumeCaptureFailureStreakKeys.push(candidateKey);
    }
  }

  rollbackResumeCaptureFailureStreak(currentCandidateKey = null) {
    const streakKeys = Array.from(new Set([
      ...this.resumeCaptureFailureStreakKeys,
      ...(currentCandidateKey ? [currentCandidateKey] : [])
    ].filter(Boolean)));
    const rollbackCount = streakKeys.length;
    if (rollbackCount <= 0) {
      this.resetResumeCaptureFailureStreak();
      return {
        rollback_count: 0,
        processed_count: this.processedCount,
        skipped_count: this.skippedCount,
        rolled_back_keys: []
      };
    }

    this.processedCount = Math.max(0, this.processedCount - rollbackCount);
    this.skippedCount = Math.max(0, this.skippedCount - rollbackCount);
    for (const key of streakKeys) {
      this.processedKeys.delete(key);
      this.discoveredKeys.delete(key);
    }
    this.resetResumeCaptureFailureStreak();
    return {
      rollback_count: rollbackCount,
      processed_count: this.processedCount,
      skipped_count: this.skippedCount,
      rolled_back_keys: streakKeys
    };
  }

  saveCheckpoint() {
    if (!this.checkpointPath) return;
    const payload = this.buildCheckpointPayload();
    fs.mkdirSync(path.dirname(this.checkpointPath), { recursive: true });
    const tempPath = `${this.checkpointPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, this.checkpointPath);
  }

  loadCheckpointIfNeeded() {
    if (!this.args.resume || !this.checkpointPath) return false;
    if (!fs.existsSync(this.checkpointPath)) return false;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.checkpointPath, "utf8"));
    } catch (error) {
      throw this.buildError("RESUME_CHECKPOINT_INVALID", `无法读取 checkpoint：${error.message || error}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw this.buildError("RESUME_CHECKPOINT_INVALID", "checkpoint 格式无效");
    }

    if (normalizeText(parsed.output_csv)) {
      this.args.output = path.resolve(parsed.output_csv);
    }
    this.processedCount = Number.isInteger(parsed.processed_count) && parsed.processed_count >= 0
      ? parsed.processed_count
      : this.processedCount;
    this.skippedCount = Number.isInteger(parsed.skipped_count) && parsed.skipped_count >= 0
      ? parsed.skipped_count
      : this.skippedCount;
    this.greetCount = Number.isInteger(parsed.greet_count) && parsed.greet_count >= 0
      ? parsed.greet_count
      : this.greetCount;
    this.greetLimitFallbackCount = Number.isInteger(parsed.greet_limit_fallback_count) && parsed.greet_limit_fallback_count >= 0
      ? parsed.greet_limit_fallback_count
      : this.greetLimitFallbackCount;

    this.processedKeys = new Set(Array.isArray(parsed.processed_keys) ? parsed.processed_keys.filter(Boolean) : []);
    this.discoveredKeys = new Set(Array.from(this.processedKeys));
    this.candidateQueue = [];
    this.candidateByKey = new Map();
    this.insertedAt = new Map();
    this.insertCounter = 0;
    this.passedCandidates = Array.isArray(parsed.passed_candidates)
      ? parsed.passed_candidates.map((item) => ({
          name: item?.name || "",
          school: item?.school || "",
          major: item?.major || "",
          company: item?.company || "",
          position: item?.position || "",
          reason: item?.reason || "",
          action: item?.action || "",
          geekId: item?.geekId || "",
          summary: item?.summary || "",
          imagePath: item?.imagePath || "",
          resumeSource: item?.resumeSource || ""
        }))
      : [];
    const networkCount = this.passedCandidates.filter((item) => item?.resumeSource === "network").length;
    const imageFallbackCount = this.passedCandidates.filter((item) => item?.resumeSource === "image_fallback").length;
    this.resumeSourceStats = {
      network: networkCount,
      image_fallback: this.args.pageScope === "featured" ? 0 : imageFallbackCount
    };
    if (this.resumeSourceStats.network <= 0 && this.resumeSourceStats.image_fallback <= 0) {
      const snapshotSource = normalizeText(parsed.resume_source || "").toLowerCase();
      if (snapshotSource === "network") {
        this.resumeSourceStats.network = 1;
      } else if (snapshotSource === "image_fallback" && this.args.pageScope !== "featured") {
        this.resumeSourceStats.image_fallback = 1;
      }
    }

    return true;
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
    const { Runtime, Input, Page, Browser, Network } = this.client;
    this.Runtime = Runtime;
    this.Input = Input;
    this.Page = Page;
    this.Browser = Browser || null;
    this.Network = Network || null;
    await Runtime.enable();
    await Page.enable();
    if (this.Network && typeof this.Network.enable === "function") {
      await this.Network.enable();
      if (typeof this.Network.requestWillBeSent === "function") {
        this.Network.requestWillBeSent((params) => {
          try {
            this.handleNetworkRequestWillBeSent(params);
          } catch {}
        });
      }
      if (typeof this.Network.webSocketCreated === "function") {
        this.Network.webSocketCreated((params) => {
          try {
            this.handleNetworkWebSocketCreated(params);
          } catch {}
        });
      }
      if (typeof this.Network.webSocketFrameSent === "function") {
        this.Network.webSocketFrameSent((params) => {
          try {
            this.handleNetworkWebSocketFrame(params, "sent");
          } catch {}
        });
      }
      if (typeof this.Network.webSocketFrameReceived === "function") {
        this.Network.webSocketFrameReceived((params) => {
          try {
            this.handleNetworkWebSocketFrame(params, "received");
          } catch {}
        });
      }
      if (typeof this.Network.loadingFinished === "function") {
        this.Network.loadingFinished((params) => {
          this.handleNetworkLoadingFinished(params).catch(() => {});
        });
      }
    }
    if (this.Browser && typeof this.Browser.getWindowForTarget === "function") {
      try {
        const windowInfo = await this.Browser.getWindowForTarget();
        if (Number.isInteger(windowInfo?.windowId)) {
          this.windowId = windowInfo.windowId;
        }
      } catch {}
    }
    if (SHOULD_BRING_TO_FRONT && Page && typeof Page.bringToFront === "function") {
      await Page.bringToFront();
    }
  }

  async disconnect() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {}
    }
    this.client = null;
    this.Runtime = null;
    this.Input = null;
    this.Page = null;
    this.Browser = null;
    this.Network = null;
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

  async getListState() {
    const state = await this.evaluate(jsGetListState);
    if (state && typeof state === "object") {
      const activeStatus = normalizeText(state.activeTabStatus || "");
      if (activeStatus) {
        this.lastActiveTabStatus = activeStatus;
      }
      return state;
    }
    return { ok: false, error: "INVALID_LIST_STATE" };
  }

  isListViewportCollapsed(state) {
    if (!state?.ok) return false;
    const clientHeight = Number(state.clientHeight || 0);
    const clientWidth = Number(state.clientWidth || 0);
    const frameWidth = Number(state.frameRect?.width || 0);
    const frameHeight = Number(state.frameRect?.height || 0);
    const viewportWidth = Number(state.viewport?.width || 0);
    const viewportHeight = Number(state.viewport?.height || 0);

    return (
      (clientHeight > 0 && clientHeight < 260)
      || (clientWidth > 0 && clientWidth < 280)
      || (frameHeight > 0 && frameHeight < 320)
      || (frameWidth > 0 && frameWidth < 460)
      || (viewportHeight > 0 && viewportHeight < 260)
      || (viewportWidth > 0 && viewportWidth < 360)
    );
  }

  async getCurrentWindowState() {
    if (!this.Browser || !this.windowId || typeof this.Browser.getWindowBounds !== "function") {
      return null;
    }
    try {
      const info = await this.Browser.getWindowBounds({ windowId: this.windowId });
      const state = String(info?.bounds?.windowState || "").toLowerCase();
      return state || null;
    } catch {
      return null;
    }
  }

  async setWindowStateIfPossible(windowState, reason = "unknown") {
    if (!this.Browser || !this.windowId || typeof this.Browser.setWindowBounds !== "function") {
      return false;
    }
    try {
      await this.Browser.setWindowBounds({
        windowId: this.windowId,
        bounds: {
          windowState
        }
      });
      log(`[视口恢复] 已设置窗口状态为 ${windowState}，原因: ${reason}`);
      return true;
    } catch (error) {
      log(`[视口恢复] 设置窗口状态 ${windowState} 失败: ${error.message || error}`);
      return false;
    }
  }

  async toggleWindowStateForViewportRecovery(reason = "unknown") {
    const currentState = await this.getCurrentWindowState();
    const sequence = currentState === "normal"
      ? ["maximized", "normal"]
      : ["normal", "maximized"];
    let applied = false;
    for (const state of sequence) {
      const ok = await this.setWindowStateIfPossible(state, reason);
      if (ok) {
        applied = true;
        await sleep(humanDelay(520, 80));
      }
    }
    if (applied && SHOULD_BRING_TO_FRONT && this.Page && typeof this.Page.bringToFront === "function") {
      try {
        await this.Page.bringToFront();
      } catch {}
    }
    return applied;
  }

  async ensureHealthyListViewport(reason = "unknown") {
    let state = await this.getListState();
    if (!this.isListViewportCollapsed(state)) {
      return { ok: true, recovered: false, state };
    }

    log(`[视口恢复] 检测到推荐列表视口异常缩小，尝试自动恢复。原因: ${reason}`);
    await this.toggleWindowStateForViewportRecovery(reason);
    await sleep(humanDelay(900, 130));
    state = await this.getListState();
    if (!this.isListViewportCollapsed(state)) {
      return { ok: true, recovered: true, state };
    }

    return {
      ok: false,
      recovered: false,
      state
    };
  }

  async discoverCandidates() {
    const health = await this.ensureHealthyListViewport("discover_candidates");
    if (!health?.ok) {
      return {
        ok: false,
        error: "LIST_VIEWPORT_COLLAPSED",
        added: 0,
        list_state: health?.state || null
      };
    }
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
    if (normalizeText(scan.active_tab_status)) {
      this.lastActiveTabStatus = normalizeText(scan.active_tab_status);
    }
    return {
      ok: true,
      added,
      candidate_count: scan.candidate_count ?? null,
      total_cards: scan.total_cards ?? null,
      active_tab_status: scan.active_tab_status || null,
      layout: scan.layout || null
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
    const health = await this.ensureHealthyListViewport("scroll_and_load_more");
    const before = health?.state?.ok ? health.state : await this.getListState();
    const scrollResult = await this.evaluate(jsScrollList);
    await sleep(humanDelay(1200, 260));
    const after = await this.getListState();
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
        .find((item) => (item.getAttribute('data-geekid') || '') === String(candidateKey)) || null;
      const featuredAnchor = inner
        ? null
        : Array.from(doc.querySelectorAll('li.geek-info-card a[data-geekid], a[data-geekid]'))
          .find((item) => (item.getAttribute('data-geekid') || '') === String(candidateKey)) || null;
      const card = inner
        ? (inner.closest('li.card-item') || inner.closest('.card-item'))
        : (featuredAnchor ? (featuredAnchor.closest('li.geek-info-card') || featuredAnchor.closest('.geek-info-card')) : null);
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
    const candidateLabel = normalizeText(candidate?.geek_id || candidate?.name || "unknown");
    const candidateKey = String(candidate?.geek_id || candidate?.name || "candidate")
      .replace(/[^\w.-]+/g, "_")
      .slice(0, 80) || "candidate";
    const attemptSummaries = [];
    let lastError = null;

    for (let attempt = 1; attempt <= RESUME_CAPTURE_MAX_ATTEMPTS; attempt += 1) {
      const outPrefix = path.join(this.debugDir, `${candidateKey}_${Date.now()}_a${attempt}`);
      try {
        return await captureFullResumeCanvas({
          port: this.args.port,
          outPrefix,
          targetPattern: RECOMMEND_URL_FRAGMENT,
          waitResumeMs: RESUME_CAPTURE_WAIT_MS,
          scrollSettleMs: 500
        });
      } catch (error) {
        lastError = error;
        const message = normalizeText(error?.message || String(error) || "Failed to capture resume image.");
        attemptSummaries.push(`a${attempt}/${RESUME_CAPTURE_MAX_ATTEMPTS}:${message.slice(0, 320)}`);
        log(`[简历截图失败] candidate=${candidateLabel} attempt=${attempt}/${RESUME_CAPTURE_MAX_ATTEMPTS} error=${message}`);
        if (attempt < RESUME_CAPTURE_MAX_ATTEMPTS) {
          await sleep(RESUME_CAPTURE_RETRY_DELAY_MS);
        }
      }
    }

    const lastMessage = normalizeText(lastError?.message || "Failed to capture resume image.");
    const attemptsText = attemptSummaries.join(" | ");
    throw this.buildError(
      "RESUME_CAPTURE_FAILED",
      `Resume capture failed after ${RESUME_CAPTURE_MAX_ATTEMPTS} attempts; last_error=${lastMessage}; attempts=${attemptsText}`
    );
  }

  async callVisionModel(imagePath) {
    const imageBase64 = fs.readFileSync(imagePath, "base64");
    const rawBaseUrl = this.args.baseUrl;
    log(`[callVisionModel] baseUrl 原始值类型=${typeof rawBaseUrl}, 长度=${rawBaseUrl != null ? String(rawBaseUrl).length : "null/undefined"}, JSON编码=${JSON.stringify(rawBaseUrl)}`);
    const baseUrl = String(rawBaseUrl || "").replace(/\/$/, "");
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

  async callTextModel(resumeText) {
    const safeResumeText = String(resumeText || "").slice(0, 28000);
    const rawBaseUrl = this.args.baseUrl;
    log(`[callTextModel] baseUrl 原始值类型=${typeof rawBaseUrl}, 长度=${rawBaseUrl != null ? String(rawBaseUrl).length : "null/undefined"}, JSON编码=${JSON.stringify(rawBaseUrl)}`);
    const baseUrl = String(rawBaseUrl || "").replace(/\/$/, "");
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
          content: `请根据以下标准判断候选人是否通过筛选。\n\n筛选标准:\n${this.args.criteria}\n\n简历内容:\n${safeResumeText}\n\n请返回严格 JSON: {"passed": true/false, "reason": "...", "summary": "..."}`
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
      throw this.buildError("TEXT_MODEL_FAILED", `Text model request failed: ${response.status} ${body.slice(0, 400)}`);
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

  async favoriteCandidate(options = {}) {
    if (this.args.pageScope === "featured") {
      if (options.alreadyInterested === true) {
        log("[FAVORITE] network profile indicates alreadyInterested=true，跳过点击以避免误取消收藏。");
        return { actionTaken: "already_favorited", source: "network_profile" };
      }
      if (!this.featuredCalibration?.position) {
        throw this.buildError(
          "FAVORITE_CALIBRATION_REQUIRED",
          "精选页收藏缺少可用校准文件（favorite-calibration.json）。请先运行 boss-recommend-mcp calibrate。",
          true,
          {
            calibration_path: this.args.calibrationPath || null
          }
        );
      }

      const base = this.featuredCalibration.position;
      const maxClicks = 5;
      let detectedAlreadyFavoritedByNetwork = false;
      for (let clickIndex = 0; clickIndex < maxClicks; clickIndex += 1) {
        const clickStartedAt = Date.now();
        this.markFavoriteClickPending();
        const offsetX = Math.floor(Math.random() * 7) - 3;
        const offsetY = Math.floor(Math.random() * 7) - 3;
        try {
          await this.simulateHumanClick(base.pageX + offsetX, base.pageY + offsetY);
        } catch (error) {
          throw this.buildError(
            "FAVORITE_BUTTON_FAILED",
            `精选页收藏模拟点击失败：${error?.message || error}`
          );
        }

        let sawDel = false;
        for (let index = 0; index < 14; index += 1) {
          await sleep(humanDelay(260, 80));
          const networkAction = this.consumeFavoriteActionResult(clickStartedAt);
          if (networkAction === "add") {
            return detectedAlreadyFavoritedByNetwork
              ? { actionTaken: "already_favorited", re_favorited: true }
              : { actionTaken: "favorite" };
          }
          if (networkAction === "del") {
            detectedAlreadyFavoritedByNetwork = true;
            log("[FAVORITE] 检测到 network=del，推断该人选原本已收藏，继续点击恢复为收藏状态。");
            sawDel = true;
            break;
          }
        }
        if (!sawDel && clickIndex === maxClicks - 1) {
          const traceSummary = this.summarizeFavoriteNetworkTrace(clickStartedAt);
          if (traceSummary.length > 0) {
            log(`[FAVORITE_NETWORK_TRACE] ${traceSummary.join(" | ")}`);
          } else {
            log("[FAVORITE_NETWORK_TRACE] 点击后未捕获到可识别的 HTTP/WS 网络信号。");
          }
          break;
        }
      }

      if (detectedAlreadyFavoritedByNetwork) {
        throw this.buildError(
          "FAVORITE_BUTTON_FAILED",
          "精选页检测到 network del（原本已收藏），但后续未检测到 network add（恢复收藏）成功信号。"
        );
      }
      throw this.buildError("FAVORITE_BUTTON_FAILED", "精选页收藏未检测到 network add 成功信号。");
    }

    const before = await this.evaluate(jsGetFavoriteState);
    if (!before?.ok) {
      throw this.buildError("FAVORITE_BUTTON_FAILED", before?.error || "收藏按钮不可用");
    }
    if (before.active) {
      return { actionTaken: "already_favorited" };
    }
    const clickStartedAt = Date.now();
    this.markFavoriteClickPending();
    try {
      await this.simulateHumanClick(before.x, before.y);
    } catch {
      if (this.args.pageScope !== "featured") {
        const fallback = await this.evaluate(jsClickFavoriteFallback);
        if (!fallback?.ok) {
          throw this.buildError("FAVORITE_BUTTON_FAILED", fallback?.error || "收藏按钮点击失败");
        }
      } else {
        throw this.buildError("FAVORITE_BUTTON_FAILED", "精选页收藏只允许模拟点击，点击失败。");
      }
    }

    for (let index = 0; index < 8; index += 1) {
      await sleep(humanDelay(260, 80));
      const state = await this.evaluate(jsGetFavoriteState);
      if (state?.ok && state.active) {
        return { actionTaken: "favorite" };
      }
      const networkAction = this.consumeFavoriteActionResult(clickStartedAt);
      if (networkAction === "add") {
        return { actionTaken: "favorite" };
      }
    }

    throw this.buildError("FAVORITE_BUTTON_FAILED", "收藏状态未能确认成功切换到已收藏。");
  }

  async greetCandidate() {
    const greetStateScript = this.args.pageScope === "featured" ? jsGetGreetStateFeatured : jsGetGreetStateRecommend;
    const greetClickFallbackScript = this.args.pageScope === "featured"
      ? jsClickGreetFallbackFeatured
      : jsClickGreetFallbackRecommend;
    const greet = await this.evaluate(greetStateScript);
    if (!greet?.ok || greet.disabled) {
      throw this.buildError("GREET_BUTTON_FAILED", greet?.error || "打招呼按钮不可用");
    }

    try {
      await this.simulateHumanClick(greet.x, greet.y);
    } catch {
      const fallback = await this.evaluate(greetClickFallbackScript);
      if (!fallback?.ok) {
        throw this.buildError("GREET_BUTTON_FAILED", fallback?.error || "打招呼点击失败");
      }
    }

    const isListReadyNow = async () => {
      const detailState = await this.getDetailClosedState();
      if (!detailState?.closed) return false;
      const listState = await this.evaluate(jsGetListState);
      return Boolean(listState?.ok);
    };

    let know = null;
    for (let index = 0; index < 10; index += 1) {
      await sleep(humanDelay(260, 80));
      know = await this.evaluate(jsGetKnowButtonState);
      if (know?.ok) break;
      if (await isListReadyNow()) {
        log("[打招呼] 未检测到“知道了”弹窗，页面已自动返回列表，继续下一位候选人。");
        return { actionTaken: "greet", ackMode: "auto_return_no_popup" };
      }
    }
    if (!know?.ok) {
      log(`[打招呼] 未检测到“知道了”弹窗（${know?.error || "ACK_BUTTON_NOT_FOUND"}），按无弹窗流程继续。`);
      return { actionTaken: "greet", ackMode: "no_popup_detected" };
    }

    try {
      await this.simulateHumanClick(know.x, know.y);
    } catch {
      const fallback = await this.evaluate(jsClickKnowFallback);
      if (!fallback?.ok) {
        if (await isListReadyNow()) {
          log("[打招呼] “知道了”点击兜底失败，但页面已回列表，继续下一位候选人。");
          return { actionTaken: "greet", ackMode: "ack_click_failed_but_list_ready" };
        }
        log(`[打招呼] “知道了”按钮点击失败（${fallback?.error || "unknown"}），后续由详情关闭流程兜底。`);
        return { actionTaken: "greet", ackMode: "ack_click_failed" };
      }
    }

    for (let index = 0; index < 8; index += 1) {
      await sleep(humanDelay(220, 60));
      const state = await this.evaluate(jsGetKnowButtonState);
      if (!state?.ok) {
        return { actionTaken: "greet", ackMode: "ack_closed" };
      }
      if (await isListReadyNow()) {
        return { actionTaken: "greet", ackMode: "auto_return_after_ack" };
      }
    }

    if (await isListReadyNow()) {
      return { actionTaken: "greet", ackMode: "ack_still_visible_but_list_ready" };
    }
    log("[打招呼] “知道了”弹窗关闭未确认，后续由详情关闭流程兜底。");
    return { actionTaken: "greet", ackMode: "ack_close_unconfirmed" };
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

    log(`[关闭详情] 常规关闭失败，进入额外 ESC 重试（禁用刷新/跳转）。最后状态: ${state?.reason || "unknown"}`);
    for (let retry = 0; retry < 2; retry += 1) {
      await sleep(2000);
      await this.pressEsc();
      await sleep(humanDelay(260, 60));
      state = await this.getDetailClosedState();
      if (state?.closed) {
        log(`[关闭详情] 额外ESC成功: ${state.reason || "closed"}`);
        return true;
      }
    }

    state = await this.getDetailClosedState();
    log(`[关闭详情] 连续 ESC 后仍未确认关闭（${state?.reason || "unknown"}），按策略视为检测误差并继续下一位。`);
    return true;
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
    log(
      `[ARGS] page_scope=${this.args.pageScope} target_count=${this.args.targetCount ?? "none"} ` +
      `post_action=${this.args.postAction || "unset"} port=${this.args.port}`
    );

    if (!(this.args.postActionConfirmed === true && this.args.postAction)) {
      this.args.postAction = await promptPostAction();
      this.args.postActionConfirmed = true;
    }
    if (this.args.postAction === "greet" && !(Number.isInteger(this.args.maxGreetCount) && this.args.maxGreetCount > 0)) {
      this.args.maxGreetCount = await promptMaxGreetCount();
    }

    const restoredFromCheckpoint = this.loadCheckpointIfNeeded();
    if (restoredFromCheckpoint) {
      log(`[恢复] 已从 checkpoint 恢复，已处理 ${this.processedCount} 位候选人。`);
    }

    await this.connect();
    try {
      const startupDetailState = await this.getDetailClosedState();
      if (!startupDetailState?.closed) {
        log("[恢复] 检测到详情页处于打开状态，先尝试关闭后再继续筛选");
        const startupClosed = await this.closeDetailPage(4);
        if (!startupClosed) {
          throw this.buildError("DETAIL_CLOSE_FAILED_AT_START", "启动时未能关闭遗留详情页");
        }
      }
      const startupListReady = await this.waitForListReady(18);
      if (!startupListReady) {
        throw this.buildError("RECOMMEND_PAGE_NOT_READY", "推荐列表未就绪（可能仍停留在详情页）");
      }
      const initialHealth = await this.ensureHealthyListViewport("startup");
      if (!initialHealth?.ok) {
        throw this.buildError("LIST_VIEWPORT_COLLAPSED", "推荐列表视口异常缩小，自动恢复失败。");
      }
      const initialList = initialHealth.state || await this.getListState();
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

      let pageExhaustion = null;
      while (!this.args.targetCount || this.processedCount < this.args.targetCount) {
        if (this.shouldPauseAtBoundary()) {
          this.saveCsv();
          this.saveCheckpoint();
          return {
            status: "PAUSED",
            result: this.buildProgressSnapshot("paused")
          };
        }
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
            pageExhaustion = {
              reason: "bottom_reached",
              bottom: scroll.bottom || null,
              scroll: scroll.scrollResult || null,
              before: scroll.before || null,
              after: scroll.after || null,
              discovery: {
                added: discovery.added ?? 0,
                candidate_count: discovery.candidate_count ?? null,
                total_cards: discovery.total_cards ?? null
              }
            };
            break;
          }
          if (didGrow || didDiscover) {
            this.scrollRetryCount = 0;
            continue;
          }
          if (!didScroll) {
            this.scrollRetryCount += 1;
            if (this.scrollRetryCount >= this.maxScrollRetries) {
              pageExhaustion = {
                reason: "scroll_stalled",
                bottom: scroll.bottom || null,
                scroll: scroll.scrollResult || null,
                before: scroll.before || null,
                after: scroll.after || null,
                discovery: {
                  added: discovery.added ?? 0,
                  candidate_count: discovery.candidate_count ?? null,
                  total_cards: discovery.total_cards ?? null
                }
              };
              break;
            }
            continue;
          }
          this.scrollRetryCount += 1;
          if (this.scrollRetryCount >= this.maxScrollRetries) {
            pageExhaustion = {
              reason: "scroll_retry_exhausted",
              bottom: scroll.bottom || null,
              scroll: scroll.scrollResult || null,
              before: scroll.before || null,
              after: scroll.after || null,
              discovery: {
                added: discovery.added ?? 0,
                candidate_count: discovery.candidate_count ?? null,
                total_cards: discovery.total_cards ?? null
              }
            };
            break;
          }
          continue;
        }

        this.scrollRetryCount = 0;
        this.processedCount += 1;
        log(`处理第 ${this.processedCount} 位候选人: ${nextCandidate.name || nextCandidate.geek_id}`);
        let shouldMarkProcessed = true;

        try {
          this.currentCandidateKey = nextCandidate.key || nextCandidate.geek_id || null;
          await this.clickCandidate(nextCandidate);
          const detailOpen = await this.ensureDetailOpen();
          if (!detailOpen) {
            throw this.buildError("DETAIL_OPEN_FAILED", "详情页打开超时");
          }

          const isFeaturedScope = this.args.pageScope === "featured";
          let capture = null;
          let screening = null;
          let resumeSource = isFeaturedScope ? "network" : "image_fallback";
          const networkCandidateInfo = await this.waitForNetworkResumeCandidateInfo(nextCandidate, 2400);
          const candidateProfile = {
            name: networkCandidateInfo?.name || nextCandidate.name || "",
            school: networkCandidateInfo?.school || nextCandidate.school || "",
            major: networkCandidateInfo?.major || nextCandidate.major || "",
            company: networkCandidateInfo?.company || nextCandidate.last_company || "",
            position: networkCandidateInfo?.position || nextCandidate.last_position || ""
          };

          if (isFeaturedScope) {
            if (!networkCandidateInfo?.resumeText) {
              throw this.buildError(
                "RESUME_NETWORK_UNAVAILABLE",
                "精选页未获取到 network 简历数据，已跳过当前候选人。"
              );
            }
            screening = await this.callTextModel(networkCandidateInfo.resumeText);
            resumeSource = "network";
            this.resumeSourceStats.network += 1;
          } else {
            capture = await this.captureResumeImage(nextCandidate);
            screening = await this.callVisionModel(capture.stitchedImage);
            resumeSource = "image_fallback";
            this.resumeSourceStats.image_fallback += 1;
          }
          this.resetResumeCaptureFailureStreak();
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
            let actionResult = { actionTaken: "none" };
            try {
              actionResult = effectiveAction === "favorite"
                ? await this.favoriteCandidate({
                  alreadyInterested: networkCandidateInfo?.alreadyInterested === true
                })
                : effectiveAction === "greet"
                  ? await this.greetCandidate()
                  : { actionTaken: "none" };
            } catch (postActionError) {
              if (!isRecoverablePostActionError(postActionError, effectiveAction)) {
                throw postActionError;
              }
              log(`[POST_ACTION_WARN] ${effectiveAction} 失败，继续写入通过候选人: ${postActionError.message || postActionError}`);
              actionResult = {
                actionTaken: `${effectiveAction}_failed`,
                errorCode: postActionError.code || "POST_ACTION_FAILED",
                errorMessage: normalizeText(postActionError.message || "post action failed")
              };
            }
            if (actionResult.actionTaken === "greet") {
              this.greetCount += 1;
            }
            const screeningReason = normalizeText(screening.reason || screening.summary || "");
            const actionErrorMessage = normalizeText(actionResult.errorMessage || "");
            const mergedReason = actionErrorMessage
              ? `${screeningReason}${screeningReason ? " | " : ""}[${effectiveAction}失败] ${actionErrorMessage}`
              : screeningReason;
            this.passedCandidates.push({
              name: candidateProfile.name,
              school: candidateProfile.school,
              major: candidateProfile.major,
              company: candidateProfile.company,
              position: candidateProfile.position,
              reason: mergedReason,
              action: actionResult.actionTaken,
              geekId: nextCandidate.geek_id,
              summary: screening.summary,
              imagePath: capture?.stitchedImage || "",
              resumeSource
            });
          } else {
            this.skippedCount += 1;
          }
        } catch (error) {
          this.skippedCount += 1;
          log(`候选人处理失败: ${error.code || error.message}`);
          if (["RESUME_CAPTURE_FAILED", "RESUME_NETWORK_UNAVAILABLE"].includes(error.code)) {
            this.recordResumeCaptureFailure(nextCandidate.key);
            const failureLabel = error.code === "RESUME_NETWORK_UNAVAILABLE" ? "简历 network 获取失败" : "简历截图失败";
            log(
              `[候选人跳过] ${nextCandidate.name || nextCandidate.geek_id || "unknown"} ${failureLabel}，` +
              `已跳过当前候选人；连续失败 ${this.consecutiveResumeCaptureFailures}/${MAX_CONSECUTIVE_RESUME_CAPTURE_FAILURES}`
            );
            if (this.consecutiveResumeCaptureFailures >= MAX_CONSECUTIVE_RESUME_CAPTURE_FAILURES) {
              shouldMarkProcessed = false;
              const rollback = this.rollbackResumeCaptureFailureStreak(nextCandidate.key);
              const failureTypeText = this.args.pageScope === "featured" ? "简历 network 获取失败" : "简历捕获失败";
              throw this.buildError(
                "RESUME_CAPTURE_FAILED_CONSECUTIVE_LIMIT",
                `连续 ${MAX_CONSECUTIVE_RESUME_CAPTURE_FAILURES} 位候选人${failureTypeText}，已停止运行以避免错误跳过。` +
                `已回滚这 ${rollback.rollback_count} 个失败样本的计数；最后错误: ${error.message || error}`,
                true,
                {
                  cause_code: error.code,
                  rollback
                }
              );
            }
          } else {
            this.resetResumeCaptureFailureStreak();
          }
          if (["VISION_MODEL_FAILED", "TEXT_MODEL_FAILED"].includes(error.code)) {
            throw error;
          }
        } finally {
          const closed = await this.closeDetailPage();
          if (!closed) {
            throw this.buildError("DETAIL_CLOSE_FAILED", "详情页未能正确关闭");
          }
          if (shouldMarkProcessed) {
            this.processedKeys.add(nextCandidate.key);
          }
        }

        await this.takeBreakIfNeeded();
        try {
          this.saveCheckpoint();
        } catch (checkpointError) {
          log(`[保存checkpoint失败] ${checkpointError.message || checkpointError}`);
        }
      }

      if (this.args.targetCount && this.processedCount < this.args.targetCount) {
        throw this.buildError(
          "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED",
          `推荐列表已到底，但当前仅处理 ${this.processedCount} 位，尚未达到目标 ${this.args.targetCount} 位。`,
          true,
          {
            partial_result: this.buildProgressSnapshot("page_exhausted_before_target_count"),
            page_exhaustion: pageExhaustion
          }
        );
      }

      this.saveCsv();
      try {
        this.saveCheckpoint();
      } catch (checkpointError) {
        log(`[保存checkpoint失败] ${checkpointError.message || checkpointError}`);
      }
      return {
        status: "COMPLETED",
        result: {
          ...this.buildProgressSnapshot(
            this.args.targetCount && this.processedCount >= this.args.targetCount
              ? "target_count_reached"
              : "page_exhausted"
          ),
          completion_reason: this.args.targetCount && this.processedCount >= this.args.targetCount
            ? "target_count_reached"
            : "page_exhausted",
        }
      };
    } catch (error) {
      try {
        this.saveCsv();
      } catch (saveError) {
        log(`[保存CSV失败] ${saveError.message || saveError}`);
      }
      try {
        this.saveCheckpoint();
      } catch (checkpointError) {
        log(`[保存checkpoint失败] ${checkpointError.message || checkpointError}`);
      }
      if (!error.partial_result) {
        error.partial_result = this.buildProgressSnapshot();
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
        usage: "node boss-recommend-screen-cli.cjs --criteria \"有 MCP 开发经验\" --post-action <favorite|greet|none> --max-greet-count 10 --post-action-confirmed true --baseurl <url> --apikey <key> --model <model> --page-scope recommend|featured --calibration <favorite-calibration.json> --port 9222 --output <csv-path> --checkpoint-path <checkpoint.json> --pause-control-path <pause-control.json> [--resume]"
      }
    }));
    return;
  }

  const finalArgs = await promptMissingInputs(args);
  const cli = new RecommendScreenCli(finalArgs);
  const result = await cli.run();
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    const errorPayload = {
      code: error.code || "RECOMMEND_SCREEN_FAILED",
      message: error.message || "推荐页筛选执行失败。",
      retryable: error.retryable !== false
    };
    for (const [key, value] of Object.entries(error || {})) {
      if (["code", "message", "retryable", "partial_result", "stack"].includes(key)) continue;
      errorPayload[key] = value;
    }
    const payload = {
      status: "FAILED",
      error: errorPayload,
      result: error.partial_result || null
    };
    console.log(JSON.stringify(payload));
    process.exitCode = 1;
  });
} else {
  module.exports = {
    RecommendScreenCli,
    parseArgs,
    promptMissingInputs,
    __testables: {
      MAX_CONSECUTIVE_RESUME_CAPTURE_FAILURES,
      RESUME_CAPTURE_MAX_ATTEMPTS,
      RESUME_CAPTURE_WAIT_MS,
      parseFavoriteActionFromPostData,
      parseFavoriteActionFromRequest,
      parseFavoriteActionFromKnownRequest,
      parseFavoriteActionFromActionLog,
      parseFavoriteActionFromWsPayload,
      isRecoverablePostActionError
    }
  };
}
