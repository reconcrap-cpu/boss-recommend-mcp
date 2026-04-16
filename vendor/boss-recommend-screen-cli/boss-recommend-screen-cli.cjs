#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const CDP = require("chrome-remote-interface");
const { captureFullResumeCanvas } = require("./scripts/capture-full-resume-canvas.cjs");

const DEFAULT_PORT = 9222;
const RECOMMEND_URL_FRAGMENT = "/web/chat/recommend";
const CSV_HEADER = [
  "姓名",
  "最高学历学校",
  "最高学历专业",
  "最近工作公司",
  "最近工作职位",
  "评估通过详细原因",
  "处理结果",
  "判断依据(CoT)",
  "动作执行结果",
  "简历来源",
  "原始判定通过",
  "最终判定通过",
  "证据总数",
  "证据命中数",
  "证据门控降级",
  "错误码",
  "错误信息",
  "候选人ID",
  "总耗时ms",
  "候选卡片读取ms",
  "点击候选人ms",
  "详情打开ms",
  "network简历等待ms",
  "文本模型ms",
  "截图获取ms",
  "视觉模型ms",
  "late network retry ms",
  "DOM fallback ms",
  "通过后动作ms",
  "关闭详情ms",
  "休息ms",
  "checkpoint保存ms"
].join(",");
const INPUT_SUMMARY_HEADER = ["运行输入字段", "运行输入值"].join(",");
const RESUME_CAPTURE_WAIT_MS = 60000;
const RESUME_CAPTURE_MAX_ATTEMPTS = 4;
const RESUME_CAPTURE_RETRY_DELAY_MS = 1200;
const NETWORK_RESUME_WAIT_MS = 4200;
const NETWORK_RESUME_RETRY_WAIT_MS = 2000;
const NETWORK_RESUME_IMAGE_MODE_GRACE_MS = 1000;
const NETWORK_RESUME_LATE_RETRY_MS = 3000;
const MAX_CONSECUTIVE_RESUME_CAPTURE_FAILURES = 10;
const DEFAULT_VISION_MAX_IMAGE_PIXELS = 36000000;
const DEFAULT_VISION_RETRY_MAX_IMAGE_PIXELS = 30000000;
const DEFAULT_TEXT_MODEL_CHUNK_SIZE_CHARS = 24000;
const DEFAULT_TEXT_MODEL_CHUNK_OVERLAP_CHARS = 1200;
const DEFAULT_TEXT_MODEL_MAX_CHUNKS = 12;
const MAX_EVIDENCE_TOKENS = 12;
let visionSharpFactory = null;
const PAGE_SCOPE_TAB_STATUS = {
  recommend: "0",
  latest: "1",
  featured: "3"
};
const BOTTOM_HINT_KEYWORDS = ["没有更多", "已显示全部", "已经到底", "暂无更多", "推荐完了", "没有更多人选"];
const LOAD_MORE_HINT_KEYWORDS = ["滚动加载更多", "下滑加载更多", "继续下滑", "继续滑动", "滑动加载", "正在加载", "加载中"];

function getHealingRulesPath() {
  const fromEnv = normalizeText(process.env.BOSS_RECOMMEND_HEALING_RULES_FILE || "");
  return fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(__dirname, "..", "..", "src", "recommend-healing-rules.json");
}

function loadHealingRules() {
  try {
    return JSON.parse(fs.readFileSync(getHealingRulesPath(), "utf8"));
  } catch {
    return {};
  }
}

function getHealingValue(root, pathParts, fallback) {
  let current = root;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      current = undefined;
      break;
    }
    current = current[part];
  }
  if (Array.isArray(current) && current.length > 0) {
    return current.map((item) => String(item));
  }
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return JSON.parse(JSON.stringify(current));
  }
  if (typeof current === "string") return current;
  return fallback;
}

function compilePatternList(patterns = []) {
  return (Array.isArray(patterns) ? patterns : [])
    .map((pattern) => {
      try {
        return new RegExp(String(pattern), "i");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function firstMatchingPattern(text, patterns = []) {
  const normalized = String(text || "");
  for (const pattern of compilePatternList(patterns)) {
    if (pattern.test(normalized)) return pattern.source;
  }
  return null;
}

function buildFirstSelectorLookupExpression(selectors = [], rootExpr = "document") {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    for (const selector of selectors) {
      try {
        const node = ${rootExpr}.querySelector(selector);
        if (node) return node;
      } catch {}
    }
    return null;
  })()`;
}

function buildSelectorCollectionExpression(selectors = [], rootExpr = "document") {
  return `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const nodes = [];
    for (const selector of selectors) {
      try {
        nodes.push(...Array.from(${rootExpr}.querySelectorAll(selector)));
      } catch {}
    }
    return Array.from(new Set(nodes));
  })()`;
}

const HEALING_RULES = loadHealingRules();
const RECOMMEND_IFRAME_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "top", "recommend_iframe"],
  ['iframe[name="recommendFrame"]', 'iframe[src*="/web/frame/recommend/"]', "iframe"]
);
const RECOMMEND_CARD_SELECTORS = getHealingValue(HEALING_RULES, ["selectors", "frame", "recommend_cards"], ["ul.card-list > li.card-item"]);
const FEATURED_CARD_SELECTORS = getHealingValue(HEALING_RULES, ["selectors", "frame", "featured_cards"], ["li.geek-info-card"]);
const LATEST_CARD_SELECTORS = getHealingValue(HEALING_RULES, ["selectors", "frame", "latest_cards"], [".candidate-card-wrap"]);
const RECOMMEND_TAB_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "frame", "tab_items"],
  ["li.tab-item[data-status]", 'li[data-status][class*="tab"]']
);
const DETAIL_POPUP_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "detail", "popup"],
  [
    ".boss-popup__wrapper",
    ".boss-popup_wrapper",
    ".boss-dialog_wrapper",
    ".dialog-wrap.active",
    ".boss-dialog",
    ".geek-detail-modal",
    ".resume-item-detail"
  ]
);
const DETAIL_RESUME_IFRAME_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "detail", "resume_iframe"],
  ['iframe[src*="/web/frame/c-resume/"]', 'iframe[name*="resume"]']
);
const RESUME_DOM_ROOT_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "detail", "resume_dom_root"],
  [
    ".resume-center-side",
    ".resume-detail-wrap",
    ".resume-item-detail",
    ".resume-section"
  ]
);
const RESUME_DOM_BLOCK_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "detail", "resume_dom_blocks"],
  [
    ".resume-section .section-title",
    ".resume-section .section-content",
    ".resume-section .item-content",
    ".resume-section .geek-desc",
    ".resume-section .text-item",
    ".resume-warning"
  ]
);
const RESUME_DOM_PROFILE_SELECTORS = {
  name: [
    ".resume-section.geek-base-info-wrap .name",
    ".geek-name .name",
    ".name-wrap .name"
  ],
  school: [
    ".geek-education-experience-wrap .school-name",
    ".edu-wrap .school-name"
  ],
  major: [
    ".geek-education-experience-wrap .major",
    ".edu-wrap .major"
  ],
  company: [
    ".geek-work-experience-wrap .company-name-wrap .name",
    ".geek-work-experience-wrap .company-name"
  ],
  position: [
    ".geek-work-experience-wrap .position span",
    ".geek-work-experience-wrap .position"
  ]
};
const DETAIL_CLOSE_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "detail", "close_button"],
  [
    ".boss-popup__close",
    ".popup-close",
    ".modal-close",
    ".dialog-close",
    ".close-btn",
    'button[aria-label*="关闭"]',
    'button[title*="关闭"]',
    ".icon-close"
  ]
);
const FAVORITE_BUTTON_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "detail", "favorite_button"],
  [".like-icon-and-text"]
);
const GREET_BUTTON_RECOMMEND_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "detail", "greet_button_recommend"],
  [
    "button.btn-v2.btn-sure-v2.btn-greet",
    ".resume-footer.item-operate button.btn-v2",
    ".resume-footer-wrap button.btn-v2",
    ".resume-footer.item-operate button",
    ".resume-footer-wrap button"
  ]
);
const GREET_BUTTON_FEATURED_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "detail", "greet_button_featured"],
  [
    "button.btn-v2.position-rights.btn-sure-v2",
    "button.btn-v2.btn-sure-v2.position-rights",
    ".resume-footer.item-operate button.btn-v2",
    ".resume-footer-wrap button.btn-v2",
    ".resume-footer.item-operate button",
    ".resume-footer-wrap button"
  ]
);
const REFRESH_FINISHED_WRAP_SELECTORS = getHealingValue(HEALING_RULES, ["selectors", "frame", "refresh_finished_wrap"], [".finished-wrap"]);
const REFRESH_BUTTON_SELECTORS = getHealingValue(
  HEALING_RULES,
  ["selectors", "frame", "refresh_button"],
  [".finished-wrap .btn.btn-refresh", ".finished-wrap .btn-refresh", ".no-data-refresh .btn-refresh"]
);
const RESUME_INFO_URL_PATTERNS = getHealingValue(
  HEALING_RULES,
  ["network", "resume", "info_url_patterns"],
  [
    "\\/wapi\\/zpjob\\/view\\/geek\\/info\\b",
    "\\/wapi\\/zpitem\\/web\\/boss\\/[^?#]*\\/geek\\/info\\b",
    "\\/boss\\/[^?#]*\\/geek\\/info\\b",
    "\\/geek\\/info\\b",
    "[?&](?:geekid|geek_id|encryptgeekid|encryptjid|jid|securityid)="
  ]
);
const RESUME_RELATED_KEYWORDS = getHealingValue(
  HEALING_RULES,
  ["network", "resume", "related_keywords"],
  ["geek", "resume", "candidate", "friend"]
);
const FAVORITE_ADD_PATTERNS = getHealingValue(
  HEALING_RULES,
  ["network", "favorite", "add_patterns"],
  [
    "\\/add(?:\\/|$)|[?&](?:action|op|operation|type)=add\\b|[?&](?:status|p3|favorite|collect|interested)=1\\b",
    "(?:^|[_\\W])(add|favorite|collect|interest(?:ed)?)(?:$|[_\\W])"
  ]
);
const FAVORITE_REMOVE_PATTERNS = getHealingValue(
  HEALING_RULES,
  ["network", "favorite", "remove_patterns"],
  [
    "\\/del(?:\\/|$)|[?&](?:action|op|operation|type)=del\\b|[?&](?:status|p3|favorite|collect|interested)=0\\b",
    "(?:^|[_\\W])(del|delete|remove|cancel|unfavorite|uncollect|uninterest)(?:$|[_\\W])"
  ]
);
const FAVORITE_ACTIONLOG_NAME = getHealingValue(
  HEALING_RULES,
  ["network", "favorite", "actionlog_action_name"],
  "star-interest-click"
);

function classifyFinishedWrapState(finishedWrapText, refreshButtonVisible = false) {
  const normalizedText = normalizeText(finishedWrapText);
  const matchedBottomKeyword = BOTTOM_HINT_KEYWORDS.find((keyword) => normalizedText.includes(keyword)) || null;
  if (matchedBottomKeyword) {
    return {
      isBottom: true,
      reason: matchedBottomKeyword,
      matched_bottom_keyword: matchedBottomKeyword,
      matched_load_more_keyword: null
    };
  }
  const matchedLoadMoreKeyword = LOAD_MORE_HINT_KEYWORDS.find((keyword) => normalizedText.includes(keyword)) || null;
  if (matchedLoadMoreKeyword) {
    return {
      isBottom: false,
      reason: null,
      matched_bottom_keyword: null,
      matched_load_more_keyword: matchedLoadMoreKeyword
    };
  }
  if (refreshButtonVisible) {
    return {
      isBottom: true,
      reason: "refresh_button_visible",
      matched_bottom_keyword: null,
      matched_load_more_keyword: null
    };
  }
  return {
    isBottom: false,
    reason: null,
    matched_bottom_keyword: null,
    matched_load_more_keyword: null
  };
}

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

function parseInputSummary(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSensitiveInputSummaryKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized === "baseurl" || normalized === "apikey" || normalized === "model";
}

function sanitizeInputSummary(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeInputSummary(item));
  }
  if (typeof value === "object") {
    const sanitized = {};
    for (const [key, raw] of Object.entries(value)) {
      if (isSensitiveInputSummaryKey(key)) continue;
      const next = sanitizeInputSummary(raw);
      if (next !== undefined) {
        sanitized[key] = next;
      }
    }
    return sanitized;
  }
  return value;
}

function resolveVisionPixelLimitFromEnv(envName, fallback) {
  const parsed = parsePositiveInteger(process.env[envName]);
  return parsed || fallback;
}

function resolveVisionRetryPixelLimit(primaryLimit) {
  const safePrimary = parsePositiveInteger(primaryLimit) || DEFAULT_VISION_MAX_IMAGE_PIXELS;
  const fallback = Math.max(1, Math.floor(safePrimary * 0.8));
  const parsed = resolveVisionPixelLimitFromEnv("BOSS_RECOMMEND_VISION_RETRY_MAX_IMAGE_PIXELS", DEFAULT_VISION_RETRY_MAX_IMAGE_PIXELS);
  const candidate = parsePositiveInteger(parsed) || fallback;
  return Math.min(Math.max(1, candidate), Math.max(1, safePrimary - 1));
}

function loadVisionSharp() {
  if (!visionSharpFactory) {
    visionSharpFactory = require("sharp");
  }
  return visionSharpFactory;
}

function isVisionImageSizeLimitMessage(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return false;
  return (
    /(像素|pixel|pixels|too large|image size|image dimension|too many pixels|max(?:imum)?[^a-z0-9]{0,8}(?:pixel|image)|超过|超出|上限)/i.test(text)
    || (text.includes("image") && text.includes("limit"))
  );
}

function isTextContextLimitMessage(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return false;
  return (
    /context length|maximum context|too many tokens|max(?:imum)? token|prompt is too long|input is too long|token limit|上下文|超出.*token|超过.*token|输入过长/i.test(text)
  );
}

function toStringArray(value, maxItems = 8) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const item of value) {
    const text = normalizeText(item);
    if (!text) continue;
    normalized.push(text);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function toLowerSafe(text) {
  return String(text || "").toLowerCase();
}

function extractEvidenceTokens(text, maxItems = MAX_EVIDENCE_TOKENS) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const matched = normalized.match(/[\u4e00-\u9fff]{2,}|[A-Za-z][A-Za-z0-9.+#_-]{2,}|\d{3,}/g) || [];
  const seen = new Set();
  const picked = [];
  const sorted = matched
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const token of sorted) {
    const key = toLowerSafe(token);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(token);
    if (picked.length >= maxItems) break;
  }
  return picked;
}

function matchEvidenceAgainstResume(evidenceText, rawResumeText, normalizedResumeText, normalizedResumeLowerText) {
  const normalizedEvidence = normalizeText(evidenceText);
  if (!normalizedEvidence) {
    return {
      matched: false,
      mode: "empty",
      matchedTokens: []
    };
  }
  if (rawResumeText.includes(evidenceText) || normalizedResumeText.includes(normalizedEvidence)) {
    return {
      matched: true,
      mode: "exact",
      matchedTokens: [normalizedEvidence]
    };
  }
  const evidenceTokens = extractEvidenceTokens(normalizedEvidence, MAX_EVIDENCE_TOKENS);
  if (evidenceTokens.length <= 0) {
    return {
      matched: false,
      mode: "token_empty",
      matchedTokens: []
    };
  }
  const matchedTokens = [];
  for (const token of evidenceTokens) {
    if (normalizedResumeLowerText.includes(toLowerSafe(token))) {
      matchedTokens.push(token);
    }
  }
  const requiredHits = evidenceTokens.length >= 4 ? 2 : 1;
  return {
    matched: matchedTokens.length >= requiredHits,
    mode: "token_fuzzy",
    matchedTokens
  };
}

function truncateText(value, maxLength = 96) {
  const text = normalizeText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(12, maxLength - 1))}…`;
}

function isMaskedName(value) {
  return /[*＊]/.test(normalizeText(value));
}

function normalizeNameForCompare(value) {
  return normalizeText(value).replace(/[*＊]/g, "");
}

function isLikelyNameMatch(expected, actual) {
  const left = normalizeNameForCompare(expected);
  const right = normalizeNameForCompare(actual);
  if (!left || !right) return true;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;
  return left[0] === right[0];
}

function isLikelyTextMatch(expected, actual) {
  const left = toLowerSafe(normalizeText(expected));
  const right = toLowerSafe(normalizeText(actual));
  if (!left || !right) return true;
  return left === right || left.includes(right) || right.includes(left);
}

function preferReadableName(...values) {
  const normalized = values.map((item) => normalizeText(item)).filter(Boolean);
  if (normalized.length <= 0) return "";
  const nonMasked = normalized.find((item) => !isMaskedName(item));
  return nonMasked || normalized[0];
}

function mergeCandidateProfiles(...profiles) {
  const list = profiles.filter((item) => item && typeof item === "object");
  const takeFirst = (field) => {
    for (const item of list) {
      const text = normalizeText(item?.[field] || "");
      if (text) return text;
    }
    return "";
  };
  return {
    name: preferReadableName(...list.map((item) => item?.name || "")),
    school: takeFirst("school"),
    major: takeFirst("major"),
    company: takeFirst("company"),
    position: takeFirst("position")
  };
}

function buildCardProfileFallbackText(cardProfile = {}) {
  const profile = cardProfile && typeof cardProfile === "object" ? cardProfile : {};
  const educationList = Array.isArray(profile.educationList)
    ? profile.educationList
        .map((item) => ({
          school: normalizeText(item?.school || ""),
          major: normalizeText(item?.major || ""),
          degree: normalizeText(item?.degree || ""),
          start: normalizeText(item?.start || ""),
          end: normalizeText(item?.end || "")
        }))
        .filter((item) => item.school || item.major || item.degree || item.start || item.end)
        .slice(0, 2)
    : [];
  const hasCore = Boolean(
    normalizeText(profile.name || "")
    || normalizeText(profile.age || "")
    || normalizeText(profile.gender || "")
    || normalizeText(profile.highestDegree || "")
    || normalizeText(profile.workYears || "")
    || normalizeText(profile.company || "")
    || normalizeText(profile.position || "")
    || normalizeText(profile.latestWorkStart || "")
    || normalizeText(profile.latestWorkEnd || "")
    || educationList.length > 0
  );
  if (!hasCore) return "";

  const lines = ["=== 人选卡片兜底信息（仅在简历缺失时使用） ==="];
  const pushField = (label, value) => {
    const text = normalizeText(value);
    if (!text) return;
    lines.push(`${label}: ${text}`);
  };

  pushField("姓名", profile.name);
  pushField("年龄", profile.age);
  pushField("性别", profile.gender);
  pushField("最高学历", profile.highestDegree);
  pushField("工作年限", profile.workYears);
  pushField("最近一份工作公司", profile.company);
  pushField("最近一份职位", profile.position);
  const workPeriod = formatResumeTimeRange(profile.latestWorkStart, profile.latestWorkEnd, "至今");
  if (workPeriod) {
    lines.push(`最近一份工作在职日期: ${workPeriod}`);
  }
  if (educationList.length > 0) {
    lines.push("最近两段学校经历:");
    educationList.forEach((item, index) => {
      const eduPeriod = formatResumeTimeRange(item.start, item.end);
      const detailParts = [
        item.school ? `学校=${item.school}` : "",
        item.major ? `专业=${item.major}` : "",
        item.degree ? `学历=${item.degree}` : "",
        eduPeriod ? `时间=${eduPeriod}` : ""
      ].filter(Boolean);
      if (detailParts.length > 0) {
        lines.push(`${index + 1}. ${detailParts.join("；")}`);
      }
    });
  }
  return lines.join("\n");
}

function enrichCandidateInfoWithCardProfile(candidateInfo = {}, cardProfile = null) {
  const info = candidateInfo && typeof candidateInfo === "object" ? candidateInfo : {};
  const profile = cardProfile && typeof cardProfile === "object" ? cardProfile : null;
  if (!profile) return { ...info };

  const educationList = Array.isArray(profile.educationList) ? profile.educationList : [];
  const firstEducation = educationList[0] || {};
  const merged = {
    ...info,
    name: preferReadableName(info?.name || "", profile?.name || ""),
    school: normalizeText(info?.school || "") || normalizeText(profile?.school || "") || normalizeText(firstEducation?.school || ""),
    major: normalizeText(info?.major || "") || normalizeText(profile?.major || "") || normalizeText(firstEducation?.major || ""),
    company: normalizeText(info?.company || "") || normalizeText(profile?.company || ""),
    position: normalizeText(info?.position || "") || normalizeText(profile?.position || ""),
    alreadyInterested: info?.alreadyInterested === true
  };

  const baseResumeText = normalizeText(info?.resumeText || "");
  const cardFallbackText = buildCardProfileFallbackText(profile);
  if (cardFallbackText) {
    merged.resumeText = baseResumeText.includes("=== 人选卡片兜底信息（仅在简历缺失时使用） ===")
      ? baseResumeText
      : baseResumeText
        ? `${baseResumeText}\n\n${cardFallbackText}`
        : cardFallbackText;
  } else {
    merged.resumeText = baseResumeText;
  }
  return merged;
}

function isDomProfileConsistentWithCard(cardProfile, domProfile) {
  if (!cardProfile || !domProfile) return true;
  let compared = 0;
  let mismatched = 0;
  const compareField = (field, matcher) => {
    const expected = normalizeText(cardProfile?.[field] || "");
    const actual = normalizeText(domProfile?.[field] || "");
    if (!expected || !actual) return;
    compared += 1;
    if (!matcher(expected, actual)) {
      mismatched += 1;
    }
  };
  compareField("name", isLikelyNameMatch);
  compareField("school", isLikelyTextMatch);
  compareField("major", isLikelyTextMatch);
  if (compared <= 0) return true;
  return mismatched <= 1;
}

function isGenericReason(reason) {
  const text = normalizeText(reason);
  if (!text) return true;
  if (text.length < 24) return true;
  return /^(候选人同时满足全部筛选条件|满足筛选标准|不满足筛选标准|模型判定不通过|通过|不通过)[。！!?]?$/u.test(text);
}

function enrichReasonWithEvidence(reason, summary, evidence = [], passed = false) {
  const normalizedReason = normalizeText(reason);
  if (!isGenericReason(normalizedReason)) return normalizedReason;
  const normalizedSummary = normalizeText(summary);
  const evidenceItems = toStringArray(evidence, 4).map((item, index) => `${index + 1}) ${truncateText(item, 72)}`);
  const evidenceText = evidenceItems.length > 0 ? evidenceItems.join("；") : "";
  const base = normalizedReason || (passed ? "候选人满足筛选标准。" : "候选人未满足筛选标准。");
  if (evidenceText) {
    return `${base} 关键依据：${evidenceText}`;
  }
  if (normalizedSummary && normalizedSummary !== normalizedReason) {
    return `${base} 摘要：${normalizedSummary}`;
  }
  return base;
}

function formatEducationDegree(edu) {
  const degreeName = normalizeText(edu?.degreeName || edu?.degreeCategory || "");
  if (degreeName) return degreeName;
  if (typeof edu?.degree === "string") {
    return normalizeText(edu.degree);
  }
  return "";
}

function formatEducationSchoolTags(edu) {
  if (!Array.isArray(edu?.schoolTags) || edu.schoolTags.length <= 0) return "";
  const tags = edu.schoolTags
    .map((item) => normalizeText(item?.name || item?.tagName || item))
    .filter(Boolean);
  return tags.join("、");
}

function inferDegreeRank(degreeText) {
  const normalized = normalizeText(degreeText).toLowerCase();
  if (!normalized) return 0;
  if (/博士|phd|doctor/.test(normalized)) return 7;
  if (/硕士|master/.test(normalized)) return 6;
  if (/本科|学士|bachelor/.test(normalized)) return 5;
  if (/大专|专科|junior/.test(normalized)) return 4;
  if (/高中/.test(normalized)) return 3;
  if (/中专|中技/.test(normalized)) return 2;
  if (/初中|小学|及以下/.test(normalized)) return 1;
  return 0;
}

function normalizeResumeDateToken(value) {
  const raw = normalizeText(value);
  if (!raw) return "";
  const digits = raw.replace(/[^\d]/g, "");
  if (/^\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)}.${digits.slice(4, 6)}`;
  }
  if (/^\d{6}$/.test(digits)) {
    return `${digits.slice(0, 4)}.${digits.slice(4, 6)}`;
  }
  if (/^\d{4}$/.test(digits)) {
    return digits;
  }
  return raw;
}

function formatResumeTimeRange(startRaw, endRaw, fallbackEnd = "") {
  const start = normalizeResumeDateToken(startRaw);
  const end = normalizeResumeDateToken(endRaw) || normalizeText(fallbackEnd);
  if (start && end) return `${start} ~ ${end}`;
  if (start) return `${start} ~`;
  if (end) return `~ ${end}`;
  return "";
}

function formatResumeTimeRangeFromFields(source, startFields = [], endFields = [], fallbackEnd = "") {
  const startRaw = startFields
    .map((field) => source?.[field])
    .find((value) => normalizeText(value));
  const endRaw = endFields
    .map((field) => source?.[field])
    .find((value) => normalizeText(value));
  return formatResumeTimeRange(startRaw, endRaw, fallbackEnd);
}

function formatNamedListText(items = []) {
  if (!Array.isArray(items) || items.length <= 0) return "";
  return items
    .map((item) => normalizeText(item?.name || item?.subjectName || item?.title || item))
    .filter(Boolean)
    .join("、");
}

function extractYearFromResumeDate(value) {
  const token = normalizeResumeDateToken(value);
  if (!token) return "";
  const match = token.match(/(19|20)\d{2}/);
  return match ? match[0] : "";
}

function deriveHighestEducation(eduExpList = []) {
  const list = Array.isArray(eduExpList) ? eduExpList : [];
  let selected = null;
  for (const edu of list) {
    const degree = formatEducationDegree(edu);
    const rank = inferDegreeRank(degree);
    const endYear = extractYearFromResumeDate(
      edu?.endYearMonStr || edu?.endYearStr || edu?.endDateDesc || edu?.endDate || ""
    );
    const candidate = {
      school: normalizeText(edu?.school || edu?.schoolName || ""),
      degree,
      rank,
      endYear
    };
    if (!selected) {
      selected = candidate;
      continue;
    }
    const selectedYear = Number(selected.endYear || 0);
    const candidateYear = Number(candidate.endYear || 0);
    if (candidate.rank > selected.rank) {
      selected = candidate;
      continue;
    }
    if (candidate.rank === selected.rank && candidateYear > selectedYear) {
      selected = candidate;
    }
  }
  return selected || { school: "", degree: "", rank: 0, endYear: "" };
}

function splitTextByChunks(text, chunkSize, overlap, maxChunks) {
  const source = String(text || "");
  if (!source) return [];

  const safeChunkSize = Math.max(1000, parsePositiveInteger(chunkSize) || DEFAULT_TEXT_MODEL_CHUNK_SIZE_CHARS);
  const safeOverlap = Math.max(0, Math.min(safeChunkSize - 1, parsePositiveInteger(overlap) || DEFAULT_TEXT_MODEL_CHUNK_OVERLAP_CHARS));
  const safeMaxChunks = Math.max(1, parsePositiveInteger(maxChunks) || DEFAULT_TEXT_MODEL_MAX_CHUNKS);

  const chunks = [];
  let start = 0;
  while (start < source.length && chunks.length < safeMaxChunks) {
    const end = Math.min(source.length, start + safeChunkSize);
    chunks.push({
      text: source.slice(start, end),
      start,
      end
    });
    if (end >= source.length) break;
    start = Math.max(0, end - safeOverlap);
  }

  if (chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    if (last.end < source.length) {
      chunks[chunks.length - 1] = {
        text: source.slice(last.start),
        start: last.start,
        end: source.length
      };
    }
  }
  return chunks;
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
  if (["latest", "最新", "最新页", "最新页面"].includes(normalized)) return "latest";
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

function parsePassedDecision(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (/不符合|不通过|未通过|未命中|不匹配|不满足/.test(normalized)) return false;
  if (/符合|通过|命中|匹配|满足/.test(normalized)) return true;
  return null;
}

function parsePassedDecisionFromContent(content) {
  const raw = String(content || "");
  const explicit = raw.match(/"passed"\s*:\s*(true|false)/i);
  if (explicit) {
    return explicit[1].toLowerCase() === "true";
  }
  return parsePassedDecision(raw);
}

function flattenChatMessageContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          return item.text || item.content || item.reasoning_content || "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content || "");
}

function collectNestedText(value, out = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = normalizeText(String(value));
    if (normalized) out.push(normalized);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedText(item, out, depth + 1);
    }
    return out;
  }
  if (typeof value === "object") {
    const priorityKeys = ["text", "reasoning_content", "summary_text", "summary", "content", "cot", "reason"];
    const seen = new Set();
    for (const key of priorityKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        seen.add(key);
        collectNestedText(value[key], out, depth + 1);
      }
    }
    for (const [key, nested] of Object.entries(value)) {
      if (seen.has(key)) continue;
      collectNestedText(nested, out, depth + 1);
    }
  }
  return out;
}

function extractCotFromChoice(choice, parsed = {}) {
  const fragments = [];
  const candidates = [
    choice?.message?.reasoning_content,
    choice?.message?.reasoning,
    choice?.reasoning_content,
    choice?.reasoning,
    parsed?.cot,
    parsed?.reasoning_content,
    parsed?.reasoning,
    parsed?.summary_text,
    parsed?.summary,
    parsed?.reason
  ];
  for (const candidate of candidates) {
    collectNestedText(candidate, fragments);
  }
  const deduped = [];
  const seen = new Set();
  for (const item of fragments) {
    if (seen.has(item)) continue;
    seen.add(item);
    deduped.push(item);
  }
  return deduped.join("\n");
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

  if (firstMatchingPattern(normalizedUrl, FAVORITE_ADD_PATTERNS)) {
    return "add";
  }
  if (firstMatchingPattern(normalizedUrl, FAVORITE_REMOVE_PATTERNS)) {
    return "del";
  }

  return parseFavoriteActionFromPostData(postData);
}

function parseFavoriteActionFromActionLog(postData = "") {
  const raw = normalizeText(postData);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (normalizeText(payload?.action).toLowerCase() !== normalizeText(FAVORITE_ACTIONLOG_NAME).toLowerCase()) return null;
    return parseFavoriteActionValue(payload?.p3);
  } catch {}

  try {
    const params = new URLSearchParams(raw);
    const actionName = normalizeText(params.get("action")).toLowerCase();
    if (actionName !== normalizeText(FAVORITE_ACTIONLOG_NAME).toLowerCase()) return null;
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
    if (normalizeText(payload?.action).toLowerCase() === normalizeText(FAVORITE_ACTIONLOG_NAME).toLowerCase()) {
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
  if (normalizedAction === "greet" && ["GREET_BUTTON_FAILED", "GREET_BUTTON_NOT_FOUND", "GREET_CONTINUE_BUTTON_FOUND"].includes(normalizedCode)) {
    return true;
  }
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
const LLM_THINKING_ENV_KEYS = [
  "BOSS_RECOMMEND_LLM_THINKING_LEVEL",
  "BOSS_LLM_THINKING_LEVEL",
  "LLM_THINKING_LEVEL"
];

function normalizeLlmThinkingLevel(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[_\s]+/g, "-");
  if (!normalized) return "";
  if (["off", "disabled", "disable", "minimal", "none", "false", "0"].includes(normalized)) return "off";
  if (["low", "medium", "high", "auto", "current", "default", "provider-default", "unchanged", "inherit"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function getEnvLlmThinkingLevel() {
  for (const key of LLM_THINKING_ENV_KEYS) {
    const normalized = normalizeLlmThinkingLevel(process.env[key]);
    if (normalized) return normalized;
  }
  return "";
}

function resolveLlmThinkingLevel(value) {
  return normalizeLlmThinkingLevel(value) || getEnvLlmThinkingLevel() || "low";
}

function isVolcengineModel(baseUrl, model) {
  const combined = `${baseUrl || ""} ${model || ""}`;
  return /volces\.com|volcengine|ark\.cn-|doubao|seed/i.test(combined);
}

function applyChatCompletionThinking(payload, { baseUrl = "", model = "", thinkingLevel = "" } = {}) {
  const level = resolveLlmThinkingLevel(thinkingLevel);
  if (["current", "default", "provider-default", "unchanged", "inherit"].includes(level)) return payload;
  const isVolc = isVolcengineModel(baseUrl, model);
  if (isVolc) {
    if (level === "auto") {
      payload.thinking = { type: "auto" };
      return payload;
    }
    if (level === "off") {
      payload.thinking = { type: "disabled" };
      payload.reasoning_effort = "minimal";
      return payload;
    }
    payload.thinking = { type: "enabled" };
    payload.reasoning_effort = level;
    return payload;
  }
  if (level !== "auto") {
    payload.reasoning_effort = level === "off" ? "minimal" : level;
  }
  return payload;
}

function parseArgs(argv) {
  const parsed = {
    baseUrl: null,
    apiKey: null,
    model: null,
    thinkingLevel: null,
    openaiOrganization: null,
    openaiProject: null,
    criteria: null,
    targetCount: null,
    maxGreetCount: null,
    pageScope: "recommend",
    calibrationPath: getDefaultCalibrationPath(),
    port: DEFAULT_PORT,
    output: path.resolve(process.cwd(), `筛选结果_${Date.now()}.csv`),
    inputSummary: null,
    checkpointPath: null,
    pauseControlPath: null,
    resume: false,
    humanRestEnabled: false,
    postAction: null,
    postActionConfirmed: null,
    help: false,
    __provided: {
      baseUrl: false,
      apiKey: false,
      model: false,
      thinkingLevel: false,
      criteria: false,
      targetCount: false,
      maxGreetCount: false,
      pageScope: false,
      calibrationPath: false,
      port: false,
      humanRest: false,
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
    } else if ((token === "--thinking-level" || token === "--thinkingLevel" || token === "--llm-thinking-level" || token === "--reasoning-effort") && (inlineValue || next)) {
      parsed.thinkingLevel = inlineValue || next;
      parsed.__provided.thinkingLevel = true;
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
    } else if ((token === "--input-summary-json" || token === "--inputSummaryJson") && (inlineValue || next)) {
      parsed.inputSummary = parseInputSummary(inlineValue || next);
      if (!inlineValue) index += 1;
    } else if (token === "--checkpoint-path" && (inlineValue || next)) {
      parsed.checkpointPath = path.resolve(inlineValue || next);
      if (!inlineValue) index += 1;
    } else if (token === "--pause-control-path" && (inlineValue || next)) {
      parsed.pauseControlPath = path.resolve(inlineValue || next);
      if (!inlineValue) index += 1;
    } else if ((token === "--human-rest" || token === "--humanRest" || token === "--human_rest") && (inlineValue || next)) {
      const parsedBoolean = parseBoolean(inlineValue || next);
      parsed.humanRestEnabled = parsedBoolean === true;
      parsed.__provided.humanRest = parsedBoolean !== null;
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
        "请输入目标通过人数（--targetCount，可留空表示不设上限）: ",
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

function normalizeTimingMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function sanitizeTimingBreakdown(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) continue;
    const normalizedValue = normalizeTimingMs(raw);
    if (normalizedValue === null) continue;
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

function getTimingMs(timing, key) {
  const normalized = normalizeTimingMs(timing?.[key]);
  return normalized === null ? "" : normalized;
}

function stringifyInputSummaryValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendInputSummaryRows(rows, value, prefix = "") {
  if (value === null || value === undefined) {
    if (prefix) rows.push([prefix, stringifyInputSummaryValue(value)]);
    return;
  }
  if (Array.isArray(value)) {
    rows.push([prefix, stringifyInputSummaryValue(value)]);
    return;
  }
  if (typeof value !== "object") {
    rows.push([prefix, stringifyInputSummaryValue(value)]);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    if (prefix) rows.push([prefix, "{}"]);
    return;
  }
  for (const [key, item] of entries) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (!nextPrefix) continue;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      appendInputSummaryRows(rows, item, nextPrefix);
    } else {
      rows.push([nextPrefix, stringifyInputSummaryValue(item)]);
    }
  }
}

function buildInputSummaryRows(inputSummary) {
  if (!inputSummary || typeof inputSummary !== "object" || Array.isArray(inputSummary)) {
    return [];
  }
  const rows = [];
  appendInputSummaryRows(rows, inputSummary);
  return rows;
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
    const keys = ["geekId", "geek_id", "gid", "encryptGeekId", "encryptJid", "jid", "securityId"];
    for (const key of keys) {
      const value = normalizeText(parsed.searchParams.get(key) || "");
      if (value) return value;
    }
  } catch {}
  const matched = raw.match(/[?&](?:geekId|geek_id|gid|encryptGeekId|encryptJid|jid|securityId)=([^&]+)/i);
  if (matched?.[1]) return decodeURIComponent(matched[1]);
  return null;
}

function parseGeekIdFromPostData(postData) {
  const raw = normalizeText(postData);
  if (!raw) return null;
  const keys = ["geekId", "geek_id", "gid", "encryptGeekId", "encryptJid", "jid", "securityId"];
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const queue = [parsed];
      let depth = 0;
      while (queue.length > 0 && depth < 5) {
        const current = queue.shift();
        depth += 1;
        if (!current || typeof current !== "object") continue;
        for (const key of keys) {
          const value = normalizeText(current[key] || "");
          if (value) return value;
        }
        for (const value of Object.values(current)) {
          if (value && typeof value === "object") {
            queue.push(value);
          }
        }
      }
    }
  } catch {}

  const matched = raw.match(/(?:^|[?&,\s"'])?(?:geekId|geek_id|gid|encryptGeekId|encryptJid|jid|securityId)(?:["']?\s*[:=]\s*["']?)([^&,"'\s}]+)/i);
  if (matched?.[1]) return decodeURIComponent(matched[1]);
  return null;
}

function collectGeekIdsFromPayload(payload, fallbackGeekId = null) {
  if (!payload || typeof payload !== "object") return [];
  const geekDetail = payload?.geekDetail || payload;
  const baseInfo = geekDetail?.geekBaseInfo || {};
  const ids = [
    fallbackGeekId,
    baseInfo.geekId,
    baseInfo.encryptGeekId,
    baseInfo.securityId,
    geekDetail?.geekId,
    geekDetail?.encryptGeekId,
    geekDetail?.securityId,
    payload?.geekId,
    payload?.encryptGeekId,
    payload?.securityId
  ].map((value) => normalizeText(value)).filter(Boolean);
  return Array.from(new Set(ids));
}

function hasResumePayloadShape(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const geekDetail = payload?.geekDetail && typeof payload.geekDetail === "object"
    ? payload.geekDetail
    : payload;
  const baseInfo = geekDetail?.geekBaseInfo || {};
  const hasIdentity = Boolean(
    normalizeText(
      baseInfo?.name
      || geekDetail?.geekName
      || payload?.geekName
      || baseInfo?.geekId
      || baseInfo?.encryptGeekId
      || baseInfo?.securityId
      || geekDetail?.geekId
      || geekDetail?.encryptGeekId
      || geekDetail?.securityId
      || payload?.geekId
      || payload?.encryptGeekId
      || payload?.securityId
      || ""
    )
  );
  const hasResumeSections = [
    geekDetail?.geekExpectList,
    geekDetail?.geekWorkExpList,
    geekDetail?.geekProjExpList,
    geekDetail?.geekEduExpList,
    geekDetail?.geekEducationList,
    geekDetail?.geekSkillList
  ].some((section) => Array.isArray(section) && section.length > 0);
  const hasResumeTextFields = Boolean(
    normalizeText(
      geekDetail?.geekAdvantage
      || baseInfo?.userDesc
      || baseInfo?.userDescription
      || ""
    )
  );
  return hasIdentity && (hasResumeSections || hasResumeTextFields);
}

function findResumePayloadInObject(root, maxDepth = 4, visited = new Set()) {
  if (root === null || root === undefined || maxDepth < 0) return null;
  if (typeof root !== "object") return null;
  if (visited.has(root)) return null;
  visited.add(root);

  if (hasResumePayloadShape(root)) {
    return root;
  }

  if (maxDepth === 0) return null;

  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findResumePayloadInObject(item, maxDepth - 1, visited);
      if (found) return found;
    }
    return null;
  }

  const priorityKeys = [
    "zpData",
    "data",
    "result",
    "geekDetail",
    "detail",
    "info"
  ];
  for (const key of priorityKeys) {
    if (!(key in root)) continue;
    const found = findResumePayloadInObject(root[key], maxDepth - 1, visited);
    if (found) return found;
  }

  for (const value of Object.values(root)) {
    const found = findResumePayloadInObject(value, maxDepth - 1, visited);
    if (found) return found;
  }
  return null;
}

function extractResumePayloadFromResponseBody(parsedBody) {
  return findResumePayloadInObject(parsedBody, 4) || null;
}

function isResumeInfoRequestUrl(url) {
  const normalizedUrl = normalizeText(url).toLowerCase();
  if (!normalizedUrl || !normalizedUrl.includes("/wapi/")) return false;
  return Boolean(firstMatchingPattern(normalizedUrl, RESUME_INFO_URL_PATTERNS));
}

function isResumeRelatedWapiUrl(url) {
  const normalizedUrl = normalizeText(url).toLowerCase();
  if (!normalizedUrl || !normalizedUrl.includes("/wapi/")) return false;
  return RESUME_RELATED_KEYWORDS.some((keyword) => normalizedUrl.includes(String(keyword).toLowerCase()));
}

function formatResumeApiData(data) {
  const parts = [];
  const geekDetail = data?.geekDetail || data?.geekDetailInfo || data || {};
  const baseInfo = geekDetail.geekBaseInfo || {};
  const expectList = Array.isArray(geekDetail.geekExpectList) && geekDetail.geekExpectList.length > 0
    ? geekDetail.geekExpectList
    : Array.isArray(geekDetail.geekExpPosList) && geekDetail.geekExpPosList.length > 0
      ? geekDetail.geekExpPosList
      : geekDetail.showExpectPosition
        ? [geekDetail.showExpectPosition]
        : [];
  const workExpList = geekDetail.geekWorkExpList || [];
  const projExpList = geekDetail.geekProjExpList || [];
  const eduExpList = geekDetail.geekEduExpList || geekDetail.geekEducationList || [];
  const advantage = geekDetail.geekAdvantage || baseInfo.userDesc || baseInfo.userDescription || "";
  const skillList = geekDetail.geekSkillList || geekDetail.skillList || [];
  const certificationList = geekDetail.geekCertificationList || [];
  const workExpCheckRes = Array.isArray(geekDetail.workExpCheckRes) ? geekDetail.workExpCheckRes : [];
  const highestEdu = deriveHighestEducation(eduExpList);

  parts.push("=== 基本信息 ===");
  if (baseInfo.name) parts.push(`姓名: ${baseInfo.name}`);
  if (baseInfo.ageDesc) parts.push(`年龄: ${baseInfo.ageDesc}`);
  if (baseInfo.gender !== undefined) parts.push(`性别: ${baseInfo.gender === 1 ? "男" : "女"}`);
  if (baseInfo.degreeCategory) parts.push(`学历: ${baseInfo.degreeCategory}`);
  if (baseInfo.workYearDesc) parts.push(`工作经验: ${baseInfo.workYearDesc}`);
  if (typeof baseInfo.freshGraduate === "number") parts.push(`应届状态: ${baseInfo.freshGraduate === 1 ? "应届生" : "非应届生"}`);
  const workDate = normalizeResumeDateToken(baseInfo.workDate8);
  if (workDate) parts.push(`参加工作时间: ${workDate}`);
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
      const workTime = formatResumeTimeRangeFromFields(
        exp,
        ["startYearMonStr", "startYearStr", "startDateDesc", "startDate"],
        ["endYearMonStr", "endYearStr", "endDateDesc", "endDate"],
        "至今"
      );
      if (workTime) {
        parts.push(`   时间: ${workTime}`);
      }
      const workContent = exp.responsibility || exp.workContent || "";
      if (workContent) {
        parts.push(`   职责: ${stripHtml(workContent)}`);
      }
      const workPerformance = exp.workPerformance || exp.performance || "";
      if (workPerformance) {
        parts.push(`   成果: ${stripHtml(workPerformance)}`);
      }
      const workEmphasis = exp.workEmphasis || "";
      if (workEmphasis) {
        parts.push(`   补充: ${stripHtml(workEmphasis)}`);
      }
    });
  }

  if (projExpList.length > 0) {
    parts.push("\n=== 项目经历 ===");
    projExpList.forEach((proj, index) => {
      parts.push(`${index + 1}. ${proj.name || proj.projectName || "未知项目"}`);
      if (proj.roleName) parts.push(`   角色: ${proj.roleName}`);
      const projTime = formatResumeTimeRangeFromFields(
        proj,
        ["startYearMonStr", "startYearStr", "startDateDesc", "startDate"],
        ["endYearMonStr", "endYearStr", "endDateDesc", "endDate"],
        "至今"
      );
      if (projTime) {
        parts.push(`   时间: ${projTime}`);
      }
      const projectDescription = proj.description || proj.projectDescription || "";
      if (projectDescription) parts.push(`   描述: ${stripHtml(projectDescription)}`);
      const projectPerformance = proj.performance || proj.projectPerformance || "";
      if (projectPerformance) parts.push(`   成果: ${stripHtml(projectPerformance)}`);
    });
  }

  if (eduExpList.length > 0) {
    parts.push("\n=== 教育经历 ===");
    eduExpList.forEach((edu, index) => {
      parts.push(`${index + 1}. ${edu.school || edu.schoolName || "未知学校"}`);
      if (edu.major || edu.majorName) parts.push(`   专业: ${edu.major || edu.majorName}`);
      const eduDegree = formatEducationDegree(edu);
      if (eduDegree) parts.push(`   学历: ${eduDegree}`);
      const eduTime = formatResumeTimeRangeFromFields(
        edu,
        ["startYearMonStr", "startYearStr", "startDateDesc", "startDate"],
        ["endYearMonStr", "endYearStr", "endDateDesc", "endDate"]
      );
      if (eduTime) {
        parts.push(`   时间: ${eduTime}`);
      }
      const schoolTags = formatEducationSchoolTags(edu);
      if (schoolTags) {
        parts.push(`   学校标签: ${schoolTags}`);
      }
      const eduDescription = stripHtml(edu.eduDescription || edu.description || "");
      if (eduDescription) {
        parts.push(`   描述: ${eduDescription}`);
      }
      const courseDesc = stripHtml(edu.courseDesc || "");
      if (courseDesc) {
        parts.push(`   课程/研究: ${courseDesc}`);
      }
      const keySubjects = formatNamedListText(edu.keySubjectList || []);
      if (keySubjects) {
        parts.push(`   核心课程: ${keySubjects}`);
      }
      const thesisTitle = normalizeText(edu.thesisTitle || "");
      const thesisDesc = stripHtml(edu.thesisDesc || "");
      if (thesisTitle || thesisDesc) {
        parts.push(`   论文: ${thesisTitle}${thesisDesc ? ` - ${thesisDesc}` : ""}`);
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

  if (certificationList.length > 0) {
    parts.push("\n=== 资格证书 ===");
    certificationList.forEach((cert) => {
      const certName = normalizeText(cert?.certName || cert?.name || "");
      if (certName) parts.push(`- ${certName}`);
    });
  }

  parts.push("\n=== 结构化判定线索 ===");
  if (highestEdu.degree) parts.push(`最高学历: ${highestEdu.degree}`);
  if (highestEdu.school) parts.push(`最高学历学校: ${highestEdu.school}`);
  if (highestEdu.endYear) parts.push(`最高学历毕业年份: ${highestEdu.endYear}`);
  parts.push(`是否有工作经历: ${workExpList.length > 0 ? "是" : "否"}`);
  parts.push(`是否有项目经历: ${projExpList.length > 0 ? "是" : "否"}`);
  parts.push("相关经验硬判口径: 仅工作经历/项目经历可作为“相关经验”硬性证据；教育/课程/技能仅作补充。");
  if (workExpCheckRes.length > 0) {
    const riskText = workExpCheckRes
      .map((item) => normalizeText(item?.desc || item?.firstTip || item?.chatDesc || ""))
      .filter(Boolean)
      .slice(0, 3)
      .join("；");
    if (riskText) {
      parts.push(`软风险提示(需追问，不直接淘汰): ${riskText}`);
    }
  }
  parts.push("判定忽略项: 活跃度/沟通热度/受欢迎度等运营指标不参与通过判定。");

  return parts.join("\n");
}

function extractJsonObject(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response did not contain JSON");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function tryExtractJsonObject(text) {
  try {
    return extractJsonObject(text);
  } catch {
    return {};
  }
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
    const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
    if (!frame || !frame.contentDocument) {
      return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
    }
    const doc = frame.contentDocument;
    const frameRect = frame.getBoundingClientRect();
    const processed = new Set(processedKeys || []);
    const cards = ${buildSelectorCollectionExpression(RECOMMEND_CARD_SELECTORS, "doc")};
    const featuredCards = ${buildSelectorCollectionExpression(FEATURED_CARD_SELECTORS, "doc")};
    const latestCards = ${buildSelectorCollectionExpression(LATEST_CARD_SELECTORS, "doc")};
    const textOf = (el) => String(el ? el.textContent : '').replace(/\s+/g, ' ').trim();
    const pickText = (root, selectors) => {
      if (!root) return '';
      for (const selector of selectors || []) {
        let node = null;
        try {
          node = root.querySelector(selector);
        } catch {
          node = null;
        }
        const text = textOf(node);
        if (text) return text;
      }
      return '';
    };
    const tabs = ${buildSelectorCollectionExpression(RECOMMEND_TAB_SELECTORS, "doc")};
    const activeTab = tabs.find((node) => /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(String(node.className || ''))) || null;
    const activeStatus = activeTab ? String(activeTab.getAttribute('data-status') || '') : '';
    const recommendCandidates = cards.map((card, index) => {
      const inner = card.querySelector('.card-inner[data-geekid]');
      if (!inner) return null;
      const geekId = inner.getAttribute('data-geekid');
      if (!geekId) return null;
      const rect = card.getBoundingClientRect();
      const name = pickText(card, ['.geek-name-wrap .name', '.name-wrap .name', 'span.name', '.name']);
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
        name,
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
      const name = pickText(card, ['.geek-name-wrap .name', '.name-wrap .name', '.name', '.geek-name']);
      const tags = Array.from(card.querySelectorAll('.base-info span, .desc span, .tag-wrap span, .edu-wrap span'))
        .map((item) => textOf(item))
        .filter(Boolean);
      return {
        found: true,
        index,
        key: geekId,
        geek_id: geekId,
        name,
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
    const latestCandidates = latestCards.map((card, index) => {
      const inner = card.querySelector('.card-inner[data-geek]') || card.querySelector('[data-geek]');
      if (!inner) return null;
      const geekId = inner.getAttribute('data-geek');
      if (!geekId) return null;
      const rect = card.getBoundingClientRect();
      const name = pickText(card, ['.geek-name-wrap .name', '.name-wrap .name', '.name-wrap', '.name']);
      const tags = Array.from(card.querySelectorAll('.base-info span, .edu-wrap span, .desc span, .tag-wrap span, .tag-item'))
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
        name,
        school: tags[0] || '',
        major: tags[1] || '',
        degree: tags[2] || '',
        last_company: workSpans[0] || '',
        last_position: workSpans[1] || '',
        x: frameRect.left + rect.left + Math.min(Math.max(rect.width / 2, 80), Math.max(rect.width - 40, 80)),
        y: frameRect.top + rect.top + Math.min(Math.max(rect.height / 2, 24), Math.max(rect.height - 12, 24)),
        width: rect.width,
        height: rect.height,
        layout: 'latest'
      };
    }).filter(Boolean);
    const inferredStatus = activeStatus
      || (
        featuredCandidates.length > 0 && recommendCandidates.length === 0 && latestCandidates.length === 0
          ? '3'
          : latestCandidates.length > 0 && recommendCandidates.length === 0 && featuredCandidates.length === 0
            ? '1'
            : recommendCandidates.length > 0 && featuredCandidates.length === 0 && latestCandidates.length === 0
              ? '0'
              : ''
      );
    const activeLayout = inferredStatus === '3'
      ? 'featured'
      : inferredStatus === '1'
        ? 'latest'
        : inferredStatus === '0'
          ? 'recommend'
          : (
            featuredCandidates.length > 0 && recommendCandidates.length === 0 && latestCandidates.length === 0
              ? 'featured'
              : latestCandidates.length > 0 && featuredCandidates.length === 0 && recommendCandidates.length === 0
                ? 'latest'
                : 'recommend'
          );
    const candidates = activeLayout === 'featured'
      ? featuredCandidates
      : activeLayout === 'latest'
        ? latestCandidates
        : recommendCandidates;
    return {
      ok: true,
      candidates: candidates.filter((candidate) => !processed.has(candidate.key)),
      candidate_count: candidates.length,
      total_cards: activeLayout === 'featured' ? featuredCards.length : activeLayout === 'latest' ? latestCards.length : cards.length,
      active_tab_status: inferredStatus || null,
      layout: activeLayout
    };
  })(${JSON.stringify(processedKeys)})`;
}

const jsGetListState = `(() => {
  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const body = doc.body;
  const frameRect = frame.getBoundingClientRect();
  const cards = ${buildSelectorCollectionExpression(RECOMMEND_CARD_SELECTORS, "doc")};
  const candidateCards = cards.filter((card) => card.querySelector('.card-inner[data-geekid]'));
  const featuredCards = ${buildSelectorCollectionExpression(FEATURED_CARD_SELECTORS, "doc")};
  const featuredCandidates = featuredCards.filter((card) => card.querySelector('a[data-geekid]'));
  const latestCards = ${buildSelectorCollectionExpression(LATEST_CARD_SELECTORS, "doc")};
  const latestCandidates = latestCards.filter((card) => card.querySelector('.card-inner[data-geek], [data-geek]'));
  const tabs = ${buildSelectorCollectionExpression(RECOMMEND_TAB_SELECTORS, "doc")};
  const activeTab = tabs.find((node) => /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(String(node.className || ''))) || null;
  const activeTabStatus = activeTab ? String(activeTab.getAttribute('data-status') || '') : '';
  const inferredStatus = activeTabStatus
    || (
      featuredCandidates.length > 0 && candidateCards.length === 0 && latestCandidates.length === 0
        ? '3'
        : latestCandidates.length > 0 && candidateCards.length === 0 && featuredCandidates.length === 0
          ? '1'
          : candidateCards.length > 0 && featuredCandidates.length === 0 && latestCandidates.length === 0
            ? '0'
            : ''
    );
  const effectiveCount = inferredStatus === '3'
    ? featuredCandidates.length
    : inferredStatus === '1'
      ? latestCandidates.length
      : inferredStatus === '0'
        ? candidateCards.length
        : Math.max(candidateCards.length, featuredCandidates.length, latestCandidates.length);
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
    latestCandidateCount: latestCandidates.length,
    totalCards: Math.max(cards.length, featuredCards.length, latestCards.length),
    activeTabStatus: inferredStatus || null
  };
})()`;

const jsScrollList = `(() => {
  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const doc = frame.contentDocument;
  const body = doc.body;
  const recommendCards = ${buildSelectorCollectionExpression(RECOMMEND_CARD_SELECTORS, "doc")}.filter((card) => card.querySelector('.card-inner[data-geekid]'));
  const featuredCards = ${buildSelectorCollectionExpression(FEATURED_CARD_SELECTORS, "doc")}.filter((card) => card.querySelector('a[data-geekid]'));
  const latestCards = ${buildSelectorCollectionExpression(LATEST_CARD_SELECTORS, "doc")}.filter((card) => card.querySelector('.card-inner[data-geek], [data-geek]'));
  const tabs = ${buildSelectorCollectionExpression(RECOMMEND_TAB_SELECTORS, "doc")};
  const activeTab = tabs.find((node) => /(?:^|\\s)(?:curr|current|active|selected)(?:\\s|$)/i.test(String(node.className || ''))) || null;
  const activeStatus = activeTab ? String(activeTab.getAttribute('data-status') || '') : '';
  const inferredStatus = activeStatus
    || (
      featuredCards.length > 0 && recommendCards.length === 0 && latestCards.length === 0
        ? '3'
        : latestCards.length > 0 && recommendCards.length === 0 && featuredCards.length === 0
          ? '1'
          : recommendCards.length > 0 && featuredCards.length === 0 && latestCards.length === 0
            ? '0'
            : ''
    );
  const activeCards = inferredStatus === '3' ? featuredCards : inferredStatus === '1' ? latestCards : recommendCards;
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
  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
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
  const finishedWrap = ${buildSelectorCollectionExpression(REFRESH_FINISHED_WRAP_SELECTORS, "doc")}
    .find((el) => isVisible(el)) || null;
  const refreshButton = ${buildSelectorCollectionExpression(REFRESH_BUTTON_SELECTORS, "doc")}
    .find((el) => isVisible(el)) || null;
  const keywords = ${JSON.stringify(BOTTOM_HINT_KEYWORDS)};
  const loadMoreKeywords = ${JSON.stringify(LOAD_MORE_HINT_KEYWORDS)};
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
  const finishedWrapText = finishedWrap ? String(finishedWrap.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const matchedBottomKeyword = keywords.find((keyword) => finishedWrapText.includes(keyword)) || null;
  const matchedLoadMoreKeyword = loadMoreKeywords.find((keyword) => finishedWrapText.includes(keyword)) || null;
  const inferredBottom = matchedBottomKeyword
    ? true
    : (Boolean(refreshButton) && !matchedLoadMoreKeyword);
  return {
    isBottom: inferredBottom,
    reason: matchedBottomKeyword || (inferredBottom ? 'refresh_button_visible' : null),
    finished_wrap_visible: Boolean(finishedWrap),
    finished_wrap_text: finishedWrapText || null,
    refresh_button_visible: Boolean(refreshButton),
    refresh_button_text: refreshButton ? String(refreshButton.textContent || '').replace(/\s+/g, ' ').trim() : null,
    matched_bottom_keyword: matchedBottomKeyword,
    matched_load_more_keyword: matchedLoadMoreKeyword
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
  const topSignals = ${JSON.stringify([...DETAIL_POPUP_SELECTORS, ...DETAIL_RESUME_IFRAME_SELECTORS])};
  for (const sel of topSignals) {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const node of nodes) {
      if (topVisible(node)) {
        return { open: true, scope: 'top', selector: sel };
      }
    }
  }
  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
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
  const close = ${buildFirstSelectorLookupExpression(DETAIL_CLOSE_SELECTORS, "doc")};
  const favorite = ${buildFirstSelectorLookupExpression(FAVORITE_BUTTON_SELECTORS, "doc")};
  const greet = ${buildFirstSelectorLookupExpression(GREET_BUTTON_RECOMMEND_SELECTORS, "doc")};
  const resumeFrame = ${buildFirstSelectorLookupExpression(DETAIL_RESUME_IFRAME_SELECTORS, "doc")};
  const open = Boolean(
    isVisibleInViewport(close)
    || isVisibleInViewport(favorite)
    || isVisibleInViewport(greet)
    || isVisibleInViewport(resumeFrame)
  );
  return { open, scope: 'frame' };
})()`;

const jsExtractResumeTextFromDom = `(() => {
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const rootSelectors = ${JSON.stringify(RESUME_DOM_ROOT_SELECTORS)};
  const blockSelectors = ${JSON.stringify(RESUME_DOM_BLOCK_SELECTORS)};
  const profileSelectors = ${JSON.stringify(RESUME_DOM_PROFILE_SELECTORS)};

  const isVisible = (doc, el) => {
    if (!el) return false;
    const win = (doc && doc.defaultView) || window;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.02) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };

  const pickFirstText = (doc, scopeRoot, selectors) => {
    const scopeNode = scopeRoot && typeof scopeRoot.querySelectorAll === 'function' ? scopeRoot : doc;
    for (const selector of selectors || []) {
      let nodes = [];
      try {
        nodes = Array.from(scopeNode.querySelectorAll(selector)).slice(0, 12);
      } catch {
        nodes = [];
      }
      for (const node of nodes) {
        if (!isVisible(doc, node)) continue;
        const text = normalize(node.textContent || '');
        if (text) return text;
      }
    }
    return '';
  };

  const extractProfileFromRoot = (doc, root) => ({
    name: pickFirstText(doc, root, profileSelectors.name),
    school: pickFirstText(doc, root, profileSelectors.school),
    major: pickFirstText(doc, root, profileSelectors.major),
    company: pickFirstText(doc, root, profileSelectors.company),
    position: pickFirstText(doc, root, profileSelectors.position)
  });

  const extractRootText = (doc, root) => {
    const sectionSelector = '.resume-section';
    const titleSelector = '.section-title';
    const contentSelector = '.section-content';
    const dedup = new Set();
    const lines = [];
    const pushLine = (raw) => {
      const text = normalize(raw);
      if (!text) return;
      const key = text.toLowerCase();
      if (dedup.has(key)) return;
      dedup.add(key);
      lines.push(text);
    };

    let sections = [];
    try {
      sections = Array.from(root.querySelectorAll(sectionSelector)).slice(0, 120);
    } catch {
      sections = [];
    }
    if (sections.length > 0) {
      for (const section of sections) {
        if (!isVisible(doc, section)) continue;
        const title = normalize((section.querySelector(titleSelector)?.textContent) || '');
        const contentNode = section.querySelector(contentSelector);
        const content = normalize((contentNode && contentNode.textContent) || section.textContent || '');
        if (title && content) {
          pushLine('[' + title + '] ' + content);
        } else if (content) {
          pushLine(content);
        } else if (title) {
          pushLine('[' + title + ']');
        }
      }
    }

    if (lines.length === 0) {
      let blocks = [];
      try {
        blocks = Array.from(root.querySelectorAll(blockSelectors.join(','))).slice(0, 260);
      } catch {
        blocks = [];
      }
      if (blocks.length > 0) {
        for (const node of blocks) {
          if (!isVisible(doc, node)) continue;
          pushLine(node.textContent || '');
        }
      }
    }

    if (lines.length === 0) {
      pushLine(root.textContent || '');
    }
    return normalize(lines.join('\\n'));
  };

  const collectFromDocument = (doc, scope) => {
    if (!doc) return [];
    const rows = [];
    const seen = new Set();

    const pushCandidate = (root, selectorLabel) => {
      if (!root || seen.has(root)) return;
      seen.add(root);
      if (!isVisible(doc, root)) return;
      const text = extractRootText(doc, root);
      if (text.length < 120) return;
      const profile = extractProfileFromRoot(doc, root);
      rows.push({
        scope,
        selector: selectorLabel,
        text,
        text_length: text.length,
        name: profile.name || '',
        school: profile.school || '',
        major: profile.major || '',
        company: profile.company || '',
        position: profile.position || ''
      });
    };

    for (const selector of rootSelectors) {
      let nodes = [];
      try {
        nodes = Array.from(doc.querySelectorAll(selector)).slice(0, 20);
      } catch {
        nodes = [];
      }
      for (const node of nodes) {
        pushCandidate(node, selector);
      }
    }

    if (rows.length === 0) {
      const fallbackRoot = doc.querySelector('.resume-center-side')
        || doc.querySelector('.resume-detail-wrap')
        || doc.querySelector('.resume-section');
      if (fallbackRoot) {
        pushCandidate(fallbackRoot, 'fallback_any_resume_root');
      }
    }
    return rows;
  };

  const topRows = collectFromDocument(document, 'top');
  let frameRows = [];
  try {
    const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
    if (frame && frame.contentDocument) {
      frameRows = collectFromDocument(frame.contentDocument, 'frame');
    }
  } catch {}

  const candidates = [...topRows, ...frameRows]
    .filter((item) => normalize(item?.text || '').length > 0)
    .sort((a, b) => Number(b?.text_length || 0) - Number(a?.text_length || 0));
  const best = candidates[0] || null;
  if (!best) {
    return {
      ok: false,
      reason: 'resume_dom_not_found',
      candidate_count: 0
    };
  }
  return {
    ok: true,
    ...best,
    candidate_count: candidates.length
  };
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
  const topCloseSelectors = ${JSON.stringify(DETAIL_CLOSE_SELECTORS)};
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

  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
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

  const directCloseSelectors = ${JSON.stringify(DETAIL_CLOSE_SELECTORS)};
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

  const topPopupSelectors = ${JSON.stringify(DETAIL_POPUP_SELECTORS)};
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

  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
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

  const popupSelectors = ${JSON.stringify(DETAIL_POPUP_SELECTORS)};
  for (const sel of popupSelectors) {
    const nodes = Array.from(doc.querySelectorAll(sel));
    for (const node of nodes) {
      if (isVisible(node)) {
        return { closed: false, reason: 'popup visible: ' + sel };
      }
    }
  }

  const detailSignals = ${JSON.stringify([...FAVORITE_BUTTON_SELECTORS, ...GREET_BUTTON_RECOMMEND_SELECTORS, ...DETAIL_RESUME_IFRAME_SELECTORS])};
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
    const direct = ${buildSelectorCollectionExpression(FAVORITE_BUTTON_SELECTORS, "doc")}
      .find((node) => isVisible(doc, node)) || null;
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

  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
  if (!frame || !frame.contentDocument) {
    return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  }
  const frameRect = frame.getBoundingClientRect();
  const frameResult = resolveFavorite(frame.contentDocument, frameRect.left, frameRect.top, 'frame');
  if (frameResult) return frameResult;
  return { ok: false, error: 'FAVORITE_BUTTON_NOT_FOUND' };
})()`;

const jsClickFavoriteFallback = `(() => {
  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
  if (!frame || !frame.contentDocument) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  const doc = frame.contentDocument;
  const root = ${buildFirstSelectorLookupExpression(FAVORITE_BUTTON_SELECTORS, "doc")};
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
      const candidates = ${buildSelectorCollectionExpression(GREET_BUTTON_RECOMMEND_SELECTORS, "doc")};
      const visibleButtons = candidates.filter((item) => isVisible(doc, item));
      const normalizeLabel = (item) => normalize(item?.textContent || '');
      const isContinue = (item) => /继续沟通/.test(normalizeLabel(item));
      const isGreetEntry = (item) => (
        /打招呼|聊一聊|立即沟通/.test(normalizeLabel(item))
        || (/沟通/.test(normalizeLabel(item)) && !isContinue(item))
      );
      const button = visibleButtons.find((item) => isGreetEntry(item)) || null;
      const continueButton = visibleButtons.find((item) => isContinue(item)) || null;
      if (!button && continueButton) {
        return { ok: false, error: 'GREET_CONTINUE_BUTTON_FOUND', scope };
      }
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

  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
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
    .find((item) => {
      if (!item || item.offsetParent === null) return false;
      const text = String(item.textContent || '').replace(/\\s+/g, ' ').trim();
      if (/继续沟通/.test(text)) return false;
      return /打招呼|聊一聊|立即沟通/.test(text) || /沟通/.test(text);
    });
  if (topButton) {
    topButton.click();
    return { ok: true, scope: 'top' };
  }
  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
  if (!frame || !frame.contentDocument) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  const doc = frame.contentDocument;
  const button = ${buildSelectorCollectionExpression(GREET_BUTTON_RECOMMEND_SELECTORS, "doc")}
    .find((item) => {
      if (!item || item.offsetParent === null) return false;
      const text = String(item.textContent || '').replace(/\\s+/g, ' ').trim();
      if (/继续沟通/.test(text)) return false;
      return /打招呼|聊一聊|立即沟通/.test(text) || /沟通/.test(text);
    }) || null;
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
      const candidates = ${buildSelectorCollectionExpression(GREET_BUTTON_FEATURED_SELECTORS, "doc")};
      const visibleButtons = candidates.filter((item) => isVisible(doc, item));
      const normalizeLabel = (item) => normalize(item?.textContent || '');
      const isContinue = (item) => /继续沟通/.test(normalizeLabel(item));
      const isGreetEntry = (item) => (
        /打招呼|聊一聊|立即沟通/.test(normalizeLabel(item))
        || (/沟通/.test(normalizeLabel(item)) && !isContinue(item))
      );
      const button = visibleButtons.find((item) => isGreetEntry(item)) || null;
      const continueButton = visibleButtons.find((item) => isContinue(item)) || null;
      if (!button && continueButton) {
        return { ok: false, error: 'GREET_CONTINUE_BUTTON_FOUND', scope };
      }
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

  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
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
    .find((item) => {
      if (!item || item.offsetParent === null) return false;
      const text = String(item.textContent || '').replace(/\\s+/g, ' ').trim();
      if (/继续沟通/.test(text)) return false;
      return /打招呼|聊一聊|立即沟通/.test(text) || /沟通/.test(text);
    });
  if (topButton) {
    topButton.click();
    return { ok: true, scope: 'top' };
  }
  const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
  if (!frame || !frame.contentDocument) return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
  const doc = frame.contentDocument;
  const button = ${buildSelectorCollectionExpression(GREET_BUTTON_FEATURED_SELECTORS, "doc")}
    .find((item) => {
      if (!item || item.offsetParent === null) return false;
      const text = String(item.textContent || '').replace(/\\s+/g, ' ').trim();
      if (/继续沟通/.test(text)) return false;
      return /打招呼|聊一聊|立即沟通/.test(text) || /沟通/.test(text);
    }) || null;
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
    this.resumeNetworkRelatedRequests = new Map();
    this.resumeNetworkDiagnostics = [];
    this.resumeNetworkByGeekId = new Map();
    this.latestResumeNetworkPayload = null;
    this.favoriteActionEvents = [];
    this.favoriteClickPendingSince = 0;
    this.favoriteNetworkTraces = [];
    this.webSocketByRequestId = new Map();
    this.candidateAudits = [];
    this.resumeSourceStats = {
      network: 0,
      dom_fallback: 0,
      image_fallback: 0
    };
    this.resumeAcquisitionMode = "unknown";
    this.resumeAcquisitionModeReason = "";
    this.lastActiveTabStatus = PAGE_SCOPE_TAB_STATUS[this.args.pageScope] || null;
    this.featuredCalibration = this.args.pageScope === "featured"
      ? loadCalibrationPosition(this.args.calibrationPath)
      : null;
    this.restCounter = 0;
    this.restThreshold = 25 + Math.floor(Math.random() * 8);
    this.checkpointPath = this.args.checkpointPath ? path.resolve(this.args.checkpointPath) : null;
    this.pauseControlPath = this.args.pauseControlPath ? path.resolve(this.args.pauseControlPath) : null;
    this.inputSummary = sanitizeInputSummary(this.args.inputSummary);
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
      resume_acquisition_mode: this.resumeAcquisitionMode,
      resume_acquisition_mode_reason: this.resumeAcquisitionModeReason,
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
      })),
      candidate_audits: this.candidateAudits.map((item) => ({
        ts: item?.ts || null,
        candidate_key: item?.candidate_key || "",
        geek_id: item?.geek_id || "",
        candidate_name: item?.candidate_name || "",
        school: item?.school || "",
        major: item?.major || "",
        company: item?.company || "",
        position: item?.position || "",
        outcome: item?.outcome || "",
        resume_source: item?.resume_source || "",
        resume_text_len: Number.isFinite(Number(item?.resume_text_len)) ? Number(item.resume_text_len) : null,
        raw_passed: item?.raw_passed === true,
        final_passed: item?.final_passed === true,
        evidence_raw_count: Number.isFinite(Number(item?.evidence_raw_count)) ? Number(item.evidence_raw_count) : null,
        evidence_matched_count: Number.isFinite(Number(item?.evidence_matched_count)) ? Number(item.evidence_matched_count) : null,
        evidence_gate_demoted: item?.evidence_gate_demoted === true,
        screening_reason: item?.screening_reason || "",
        action_taken: item?.action_taken || "",
        error_code: item?.error_code || "",
        error_message: item?.error_message || "",
        chunk_index: Number.isFinite(Number(item?.chunk_index)) ? Number(item.chunk_index) : null,
        chunk_total: Number.isFinite(Number(item?.chunk_total)) ? Number(item.chunk_total) : null,
        timing_ms: sanitizeTimingBreakdown(item?.timing_ms)
      })),
      input_summary: sanitizeInputSummary(this.inputSummary)
    };
  }

  buildProgressSnapshot(completionReason = null) {
    const defaultResumeSource = "network";
    const snapshot = {
      processed_count: this.processedCount,
      passed_count: this.passedCandidates.length,
      skipped_count: this.skippedCount,
      output_csv: this.args.output,
      checkpoint_path: this.checkpointPath,
      selected_page: this.args.pageScope || "recommend",
      active_tab_status: this.lastActiveTabStatus || PAGE_SCOPE_TAB_STATUS[this.args.pageScope] || null,
      resume_acquisition_mode: this.resumeAcquisitionMode,
      resume_source: this.resumeSourceStats.image_fallback > 0
        ? "image_fallback"
        : this.resumeSourceStats.dom_fallback > 0
          ? "dom_fallback"
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

  recordResumeNetworkDiagnostic(entry) {
    const normalized = {
      ts: Number.isFinite(Number(entry?.ts)) ? Number(entry.ts) : Date.now(),
      kind: normalizeText(entry?.kind || "unknown") || "unknown",
      request_id: normalizeText(entry?.request_id || "") || null,
      method: normalizeText(entry?.method || "").toUpperCase() || null,
      url: normalizeText(entry?.url || "") || null,
      geek_id: normalizeText(entry?.geek_id || "") || null,
      match: normalizeText(entry?.match || "") || null,
      reason: normalizeText(entry?.reason || "") || null,
      error: normalizeText(entry?.error || "") || null,
      resume_text_len: Number.isFinite(Number(entry?.resume_text_len)) ? Number(entry.resume_text_len) : null,
      candidate_key: normalizeText(entry?.candidate_key || "") || null,
      source: normalizeText(entry?.source || "") || null,
      waited_ms: Number.isFinite(Number(entry?.waited_ms)) ? Number(entry.waited_ms) : null
    };
    this.resumeNetworkDiagnostics.push(normalized);
    if (this.resumeNetworkDiagnostics.length > 240) {
      this.resumeNetworkDiagnostics = this.resumeNetworkDiagnostics.slice(-240);
    }
  }

  summarizeResumeNetworkDiagnostics(since = 0) {
    const timestamp = Number.isFinite(since) ? since : 0;
    return this.resumeNetworkDiagnostics
      .filter((item) => Number(item?.ts || 0) >= timestamp)
      .slice(-20)
      .map((item) => {
        const prefix = `[${item.kind}]`;
        if (item.kind === "request") {
          return `${prefix} ${item.method || "GET"} ${item.url || ""} match=${item.match || "none"} geek=${item.geek_id || "-"}`;
        }
        if (item.kind === "response_hit") {
          return `${prefix} ${item.url || ""} geek=${item.geek_id || "-"} resume_len=${item.resume_text_len ?? "?"}`;
        }
        if (item.kind === "response_miss") {
          return `${prefix} ${item.url || ""} reason=${item.reason || "payload_not_found"}`;
        }
        if (item.kind === "response_error") {
          return `${prefix} ${item.url || ""} error=${item.error || "unknown"}`;
        }
        if (item.kind === "wait_hit") {
          return `${prefix} candidate=${item.candidate_key || "-"} source=${item.source || "-"} waited_ms=${item.waited_ms ?? "?"} resume_len=${item.resume_text_len ?? "?"}`;
        }
        if (item.kind === "wait_timeout") {
          return `${prefix} candidate=${item.candidate_key || "-"} waited_ms=${item.waited_ms ?? "?"} reason=${item.reason || "timeout"}`;
        }
        if (item.kind === "dom_fallback_hit") {
          return `${prefix} candidate=${item.candidate_key || "-"} scope=${item.source || "-"} selector=${item.reason || "-"} resume_len=${item.resume_text_len ?? "?"}`;
        }
        if (item.kind === "dom_fallback_miss") {
          return `${prefix} candidate=${item.candidate_key || "-"} reason=${item.reason || "dom_not_found"}`;
        }
        if (item.kind === "dom_fallback_error") {
          return `${prefix} candidate=${item.candidate_key || "-"} error=${item.error || "unknown"}`;
        }
        if (item.kind === "dom_profile_mismatch") {
          return `${prefix} candidate=${item.candidate_key || "-"} card=${item.card_name || "-"} dom=${item.dom_name || "-"}`;
        }
        if (item.kind === "dom_profile_mismatch_retry_failed") {
          return `${prefix} candidate=${item.candidate_key || "-"} error=${item.error || "unknown"}`;
        }
        return `${prefix} ${item.url || item.reason || "n/a"}`;
      });
  }

  recordCandidateAudit(entry = {}) {
    const normalized = {
      ts: new Date().toISOString(),
      candidate_key: normalizeText(entry?.candidate_key || entry?.geek_id || "") || "",
      geek_id: normalizeText(entry?.geek_id || entry?.candidate_key || "") || "",
      candidate_name: normalizeText(entry?.candidate_name || "") || "",
      school: normalizeText(entry?.school || "") || "",
      major: normalizeText(entry?.major || "") || "",
      company: normalizeText(entry?.company || "") || "",
      position: normalizeText(entry?.position || "") || "",
      outcome: normalizeText(entry?.outcome || "unknown") || "unknown",
      resume_source: normalizeText(entry?.resume_source || "") || "",
      resume_text_len: Number.isFinite(Number(entry?.resume_text_len)) ? Number(entry.resume_text_len) : null,
      raw_passed: entry?.raw_passed === true,
      final_passed: entry?.final_passed === true,
      evidence_raw_count: Number.isFinite(Number(entry?.evidence_raw_count)) ? Number(entry.evidence_raw_count) : null,
      evidence_matched_count: Number.isFinite(Number(entry?.evidence_matched_count)) ? Number(entry.evidence_matched_count) : null,
      evidence_gate_demoted: entry?.evidence_gate_demoted === true,
      screening_reason: normalizeText(entry?.screening_reason || "") || "",
      action_taken: normalizeText(entry?.action_taken || "") || "",
      error_code: normalizeText(entry?.error_code || "") || "",
      error_message: normalizeText(entry?.error_message || "") || "",
      chunk_index: Number.isFinite(Number(entry?.chunk_index)) ? Number(entry.chunk_index) : null,
      chunk_total: Number.isFinite(Number(entry?.chunk_total)) ? Number(entry.chunk_total) : null,
      timing_ms: sanitizeTimingBreakdown(entry?.timing_ms)
    };
    this.candidateAudits.push(normalized);
    const maxItems = parsePositiveInteger(process.env.BOSS_RECOMMEND_MAX_CANDIDATE_AUDITS);
    if (maxItems && this.candidateAudits.length > maxItems) {
      this.candidateAudits = this.candidateAudits.slice(-maxItems);
    }
  }

  updateCandidateAuditTiming(candidateKey, timing = {}) {
    const normalizedKey = normalizeText(candidateKey || "");
    if (!normalizedKey) return;
    const timingMs = sanitizeTimingBreakdown(timing);
    for (let index = this.candidateAudits.length - 1; index >= 0; index -= 1) {
      const audit = this.candidateAudits[index];
      if (
        normalizeText(audit?.candidate_key || "") === normalizedKey
        || normalizeText(audit?.geek_id || "") === normalizedKey
      ) {
        audit.timing_ms = timingMs;
        return;
      }
    }
  }

  logResumeNetworkMissDiagnostics(candidate, options = {}) {
    const candidateKey = normalizeText(candidate?.key || candidate?.geek_id || "");
    const candidateName = normalizeText(candidate?.name || "");
    const waitStartedAt = Number.isFinite(options.waitStartedAt) ? options.waitStartedAt : 0;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;
    const now = Date.now();
    const latestPayloadAgeMs = this.latestResumeNetworkPayload
      ? Math.max(0, now - Number(this.latestResumeNetworkPayload.ts || 0))
      : null;
    const latestPayloadGeekIds = Array.isArray(this.latestResumeNetworkPayload?.geekIds)
      ? this.latestResumeNetworkPayload.geekIds.slice(0, 4)
      : [];
    const recentLines = this.summarizeResumeNetworkDiagnostics(waitStartedAt);
    const trackedResumeRequestCount = this.resumeNetworkRequests.size;
    const trackedRelatedRequestCount = this.resumeNetworkRelatedRequests.size;

    log(
      `[network简历未命中] candidate=${candidateKey || candidateName || "unknown"} `
      + `wait_ms=${timeoutMs || "n/a"} `
      + `tracked_resume_requests=${trackedResumeRequestCount} `
      + `tracked_related_requests=${trackedRelatedRequestCount} `
      + `cached_by_geek=${this.resumeNetworkByGeekId.size} `
      + `latest_payload_age_ms=${latestPayloadAgeMs ?? "none"} `
      + `latest_payload_geek_ids=${latestPayloadGeekIds.length ? latestPayloadGeekIds.join("|") : "none"}`
    );
    if (recentLines.length > 0) {
      log(`[network简历未命中][最近网络事件] ${recentLines.join(" || ")}`);
    } else {
      log("[network简历未命中][最近网络事件] none");
    }
  }

  cacheResumeNetworkPayload(payload, fallbackGeekId = null) {
    if (!payload || typeof payload !== "object") return;
    const geekDetail = payload.geekDetail || payload;
    const baseInfo = geekDetail.geekBaseInfo || {};
    const geekIds = collectGeekIdsFromPayload(payload, fallbackGeekId);
    const geekId = geekIds[0] || null;
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
      alreadyInterested: payload.alreadyInterested === true || geekDetail.alreadyInterested === true
    };
    const wrapped = {
      ts: Date.now(),
      geekId: geekId || null,
      geekIds,
      data: payload,
      candidateInfo
    };
    this.latestResumeNetworkPayload = wrapped;
    for (const id of geekIds) {
      const normalizedId = normalizeText(id);
      if (!normalizedId) continue;
      this.resumeNetworkByGeekId.set(normalizedId, wrapped);
    }
  }

  tryExtractNetworkResumeForCandidate(candidate, options = {}) {
    const candidateKey = normalizeText(candidate?.key || candidate?.geek_id || "");
    const minTs = Number.isFinite(Number(options?.minTs)) ? Number(options.minTs) : 0;
    if (candidateKey && this.resumeNetworkByGeekId.has(candidateKey)) {
      const wrapped = this.resumeNetworkByGeekId.get(candidateKey);
      const payloadTs = Number(wrapped?.ts || 0);
      if (payloadTs >= minTs) {
        return {
          candidateInfo: wrapped?.candidateInfo || null,
          source: "geek_id_map",
          ts: payloadTs
        };
      }
    }
    if (this.latestResumeNetworkPayload) {
      const wrapped = this.latestResumeNetworkPayload;
      const payloadTs = Number(wrapped?.ts || 0);
      const ageMs = Date.now() - payloadTs;
      const latestGeekIds = Array.isArray(wrapped?.geekIds)
        ? wrapped.geekIds.map((id) => normalizeText(id)).filter(Boolean)
        : [];
      const withinAge = ageMs <= 12000;
      const withinTs = payloadTs >= minTs;
      if (!candidateKey && withinAge && withinTs) {
        return {
          candidateInfo: wrapped?.candidateInfo || null,
          source: "latest_payload",
          ts: payloadTs
        };
      }
      if (candidateKey && withinAge && withinTs && latestGeekIds.includes(candidateKey)) {
        return {
          candidateInfo: wrapped?.candidateInfo || null,
          source: "latest_payload_key_match",
          ts: payloadTs
        };
      }
    }
    return null;
  }

  async waitForNetworkResumeCandidateInfo(candidate, timeoutMs = 2200, options = {}) {
    const waitStartedAt = Date.now();
    const candidateKey = normalizeText(candidate?.key || candidate?.geek_id || "");
    const minTs = Number.isFinite(Number(options?.minTs)) ? Number(options.minTs) : 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.tryExtractNetworkResumeForCandidate(candidate, { minTs });
      const info = match?.candidateInfo || null;
      if (info && normalizeText(info.resumeText)) {
        this.recordResumeNetworkDiagnostic({
          kind: "wait_hit",
          candidate_key: candidateKey,
          source: match?.source || "unknown",
          waited_ms: Date.now() - waitStartedAt,
          min_ts: minTs || null,
          payload_ts: Number(match?.ts || 0) || null,
          resume_text_len: normalizeText(info.resumeText).length
        });
        return info;
      }
      await sleep(120);
    }
    this.recordResumeNetworkDiagnostic({
      kind: "wait_timeout",
      candidate_key: candidateKey,
      waited_ms: Date.now() - waitStartedAt,
      min_ts: minTs || null,
      reason: "resume_text_not_ready"
    });
    return null;
  }

  setResumeAcquisitionMode(mode, reason = "") {
    if (!["unknown", "network", "image"].includes(mode)) return;
    if (this.resumeAcquisitionMode === mode) return;
    this.resumeAcquisitionMode = mode;
    this.resumeAcquisitionModeReason = normalizeText(reason || "");
    log(`[简历获取模式] mode=${mode}${this.resumeAcquisitionModeReason ? ` reason=${this.resumeAcquisitionModeReason}` : ""}`);
  }

  async waitForResumeNetworkByMode(candidate, options = {}) {
    const minTs = Number.isFinite(Number(options?.minTs)) ? Number(options.minTs) : 0;
    const mode = this.resumeAcquisitionMode || "unknown";
    const firstWaitMs = mode === "image" ? NETWORK_RESUME_IMAGE_MODE_GRACE_MS : NETWORK_RESUME_WAIT_MS;
    const waitStartedAt = Date.now();
    let networkCandidateInfo = await this.waitForNetworkResumeCandidateInfo(candidate, firstWaitMs, { minTs });
    if (normalizeText(networkCandidateInfo?.resumeText)) {
      this.setResumeAcquisitionMode("network", "network_resume_hit");
      return networkCandidateInfo;
    }
    if (typeof this.logResumeNetworkMissDiagnostics === "function") {
      this.logResumeNetworkMissDiagnostics(candidate, {
        timeoutMs: firstWaitMs,
        waitStartedAt
      });
    }
    if (mode === "image") {
      return null;
    }
    await sleep(NETWORK_RESUME_RETRY_WAIT_MS);
    networkCandidateInfo = await this.waitForNetworkResumeCandidateInfo(
      candidate,
      NETWORK_RESUME_RETRY_WAIT_MS,
      { minTs }
    );
    if (normalizeText(networkCandidateInfo?.resumeText)) {
      this.setResumeAcquisitionMode("network", "network_resume_retry_hit");
      return networkCandidateInfo;
    }
    return null;
  }

  async waitForLateNetworkResumeCandidateInfo(candidate, options = {}) {
    const minTs = Number.isFinite(Number(options?.minTs)) ? Number(options.minTs) : 0;
    const networkCandidateInfo = await this.waitForNetworkResumeCandidateInfo(
      candidate,
      NETWORK_RESUME_LATE_RETRY_MS,
      { minTs }
    );
    if (normalizeText(networkCandidateInfo?.resumeText)) {
      this.setResumeAcquisitionMode("network", "late_network_resume_hit");
      return networkCandidateInfo;
    }
    return null;
  }

  async extractResumeTextFromDom(candidate) {
    const candidateKey = normalizeText(candidate?.key || candidate?.geek_id || "");
    const candidateLabel = normalizeText(candidate?.name || candidateKey || "unknown");
    if (!this.Runtime || typeof this.Runtime.evaluate !== "function") {
      return null;
    }
    let extracted = null;
    try {
      extracted = await this.evaluate(jsExtractResumeTextFromDom);
    } catch (error) {
      this.recordResumeNetworkDiagnostic({
        kind: "dom_fallback_error",
        candidate_key: candidateKey,
        error: normalizeText(error?.message || error)
      });
      log(`[DOM简历提取失败] candidate=${candidateLabel} error=${normalizeText(error?.message || error)}`);
      return null;
    }
    if (!extracted || extracted.ok !== true) {
      this.recordResumeNetworkDiagnostic({
        kind: "dom_fallback_miss",
        candidate_key: candidateKey,
        reason: normalizeText(extracted?.reason || "resume_dom_not_found")
      });
      log(
        `[DOM简历未命中] candidate=${candidateLabel} reason=${normalizeText(extracted?.reason || "resume_dom_not_found")}`
      );
      return null;
    }

    const resumeText = normalizeText(extracted.text || "");
    if (!resumeText) {
      this.recordResumeNetworkDiagnostic({
        kind: "dom_fallback_miss",
        candidate_key: candidateKey,
        reason: "resume_dom_text_empty"
      });
      log(`[DOM简历未命中] candidate=${candidateLabel} reason=resume_dom_text_empty`);
      return null;
    }

    const info = {
      name: preferReadableName(extracted.name || "", candidate?.name || ""),
      school: normalizeText(extracted.school || candidate?.school || ""),
      major: normalizeText(extracted.major || candidate?.major || ""),
      company: normalizeText(extracted.company || candidate?.last_company || ""),
      position: normalizeText(extracted.position || candidate?.last_position || ""),
      resumeText,
      alreadyInterested: false
    };

    this.recordResumeNetworkDiagnostic({
      kind: "dom_fallback_hit",
      candidate_key: candidateKey,
      source: normalizeText(extracted.scope || "unknown"),
      reason: normalizeText(extracted.selector || "unknown"),
      resume_text_len: resumeText.length
    });
    log(
      `[DOM简历命中] candidate=${candidateLabel} scope=${normalizeText(extracted.scope || "unknown")} `
      + `selector=${normalizeText(extracted.selector || "unknown")} resume_len=${resumeText.length}`
    );
    return info;
  }

  async resolveDomResumeFallback(candidate, cardProfile) {
    let domCandidateInfo = await this.extractResumeTextFromDom(candidate);
    let networkCandidateInfo = null;
    if (domCandidateInfo && !isDomProfileConsistentWithCard(cardProfile, domCandidateInfo)) {
      this.recordResumeNetworkDiagnostic({
        kind: "dom_profile_mismatch",
        candidate_key: normalizeText(candidate?.key || candidate?.geek_id || ""),
        card_name: normalizeText(cardProfile?.name || ""),
        dom_name: normalizeText(domCandidateInfo?.name || ""),
        card_school: normalizeText(cardProfile?.school || ""),
        dom_school: normalizeText(domCandidateInfo?.school || "")
      });
      log(
        `[DOM简历疑似错位] candidate=${candidate?.key || candidate?.geek_id || "unknown"} ` +
        `card=${normalizeText(cardProfile?.name || "-")} dom=${normalizeText(domCandidateInfo?.name || "-")}，尝试重试一次点击+监听。`
      );
      try {
        const retryCaptureStartedAt = Date.now();
        await this.clickCandidate(candidate);
        const retryDetailOpen = await this.ensureDetailOpen();
        if (retryDetailOpen) {
          networkCandidateInfo = await this.waitForNetworkResumeCandidateInfo(
            candidate,
            NETWORK_RESUME_RETRY_WAIT_MS,
            { minTs: retryCaptureStartedAt }
          );
          if (!normalizeText(networkCandidateInfo?.resumeText)) {
            const retryDomCandidateInfo = await this.extractResumeTextFromDom(candidate);
            if (retryDomCandidateInfo && isDomProfileConsistentWithCard(cardProfile, retryDomCandidateInfo)) {
              domCandidateInfo = retryDomCandidateInfo;
            } else {
              domCandidateInfo = null;
            }
          } else {
            domCandidateInfo = null;
          }
        } else {
          domCandidateInfo = null;
        }
      } catch (retryError) {
        domCandidateInfo = null;
        this.recordResumeNetworkDiagnostic({
          kind: "dom_profile_mismatch_retry_failed",
          candidate_key: normalizeText(candidate?.key || candidate?.geek_id || ""),
          error: normalizeText(retryError?.message || retryError)
        });
      }
    }
    return {
      domCandidateInfo,
      networkCandidateInfo
    };
  }

  handleNetworkRequestWillBeSent(params) {
    const url = normalizeText(params?.request?.url || "");
    const postData = params?.request?.postData || "";
    if (!url) return;
    const requestTs = Date.now();
    const method = normalizeText(params?.request?.method || "").toUpperCase() || "GET";
    const isResumeInfo = isResumeInfoRequestUrl(url);
    const isResumeRelated = isResumeInfo || isResumeRelatedWapiUrl(url);
    if (isResumeRelated) {
      const geekId = parseGeekIdFromUrl(url) || parseGeekIdFromPostData(postData);
      const meta = {
        ts: requestTs,
        url,
        geekId,
        method,
        isResumeInfo
      };
      this.resumeNetworkRelatedRequests.set(params.requestId, meta);
      this.recordResumeNetworkDiagnostic({
        kind: "request",
        request_id: params.requestId,
        method,
        url: url.slice(0, 280),
        geek_id: geekId,
        match: isResumeInfo ? "resume_info_url" : "wapi_related_non_resume_info"
      });
      if (this.resumeNetworkRelatedRequests.size > 400) {
        const oldest = [...this.resumeNetworkRelatedRequests.entries()]
          .sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0))
          .slice(0, this.resumeNetworkRelatedRequests.size - 320);
        for (const [requestId] of oldest) {
          this.resumeNetworkRelatedRequests.delete(requestId);
        }
      }
      if (isResumeInfo) {
        this.resumeNetworkRequests.set(params.requestId, {
          ts: requestTs,
          url,
          geekId
        });
        return;
      }
    }

    if (this.favoriteClickPendingSince <= 0) return;
    if (requestTs < this.favoriteClickPendingSince) return;
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
    const requestId = params?.requestId;
    const requestMeta = this.resumeNetworkRequests.get(requestId);
    const relatedMeta = this.resumeNetworkRelatedRequests.get(requestId);
    if (!requestMeta && !relatedMeta) return;
    this.resumeNetworkRequests.delete(requestId);
    this.resumeNetworkRelatedRequests.delete(requestId);
    const effectiveMeta = requestMeta || relatedMeta || {};
    const effectiveUrl = normalizeText(effectiveMeta.url || "");
    const effectiveGeekId = normalizeText(effectiveMeta.geekId || "");
    try {
      const responseBody = await this.Network.getResponseBody({ requestId });
      if (!responseBody?.body) {
        this.recordResumeNetworkDiagnostic({
          kind: "response_miss",
          request_id: requestId,
          url: effectiveUrl.slice(0, 280),
          geek_id: effectiveGeekId,
          reason: "empty_body"
        });
        return;
      }
      const rawBody = responseBody.base64Encoded
        ? Buffer.from(responseBody.body, "base64").toString("utf8")
        : responseBody.body;
      const parsed = JSON.parse(rawBody);
      const resumePayload = extractResumePayloadFromResponseBody(parsed);
      if (resumePayload) {
        this.cacheResumeNetworkPayload(resumePayload, effectiveGeekId);
        const formattedText = normalizeText(formatResumeApiData(resumePayload));
        this.recordResumeNetworkDiagnostic({
          kind: "response_hit",
          request_id: requestId,
          url: effectiveUrl.slice(0, 280),
          geek_id: effectiveGeekId,
          resume_text_len: formattedText.length
        });
      } else {
        this.recordResumeNetworkDiagnostic({
          kind: "response_miss",
          request_id: requestId,
          url: effectiveUrl.slice(0, 280),
          geek_id: effectiveGeekId,
          reason: "payload_not_found"
        });
      }
    } catch (error) {
      this.recordResumeNetworkDiagnostic({
        kind: "response_error",
        request_id: requestId,
        url: effectiveUrl.slice(0, 280),
        geek_id: effectiveGeekId,
        error: normalizeText(error?.message || String(error)).slice(0, 240)
      });
    }
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
    const rollbackSet = new Set(streakKeys);
    this.candidateAudits = this.candidateAudits.filter((item) => !rollbackSet.has(item?.candidate_key));
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
    this.candidateAudits = Array.isArray(parsed.candidate_audits)
      ? parsed.candidate_audits.map((item) => ({
          ts: normalizeText(item?.ts || "") || null,
          candidate_key: normalizeText(item?.candidate_key || "") || "",
          geek_id: normalizeText(item?.geek_id || "") || "",
          candidate_name: normalizeText(item?.candidate_name || "") || "",
          school: normalizeText(item?.school || "") || "",
          major: normalizeText(item?.major || "") || "",
          company: normalizeText(item?.company || "") || "",
          position: normalizeText(item?.position || "") || "",
          outcome: normalizeText(item?.outcome || "unknown") || "unknown",
          resume_source: normalizeText(item?.resume_source || "") || "",
          resume_text_len: Number.isFinite(Number(item?.resume_text_len)) ? Number(item.resume_text_len) : null,
          raw_passed: item?.raw_passed === true,
          final_passed: item?.final_passed === true,
          evidence_raw_count: Number.isFinite(Number(item?.evidence_raw_count)) ? Number(item.evidence_raw_count) : null,
          evidence_matched_count: Number.isFinite(Number(item?.evidence_matched_count)) ? Number(item.evidence_matched_count) : null,
          evidence_gate_demoted: item?.evidence_gate_demoted === true,
          screening_reason: normalizeText(item?.screening_reason || "") || "",
          action_taken: normalizeText(item?.action_taken || "") || "",
          error_code: normalizeText(item?.error_code || "") || "",
          error_message: normalizeText(item?.error_message || "") || "",
          chunk_index: Number.isFinite(Number(item?.chunk_index)) ? Number(item.chunk_index) : null,
          chunk_total: Number.isFinite(Number(item?.chunk_total)) ? Number(item.chunk_total) : null,
          timing_ms: sanitizeTimingBreakdown(item?.timing_ms)
        }))
      : [];
    if (!this.inputSummary) {
      this.inputSummary = sanitizeInputSummary(parsed.input_summary);
    }
    const networkCount = this.passedCandidates.filter((item) => item?.resumeSource === "network").length;
    const domFallbackCount = this.passedCandidates.filter((item) => item?.resumeSource === "dom_fallback").length;
    const imageFallbackCount = this.passedCandidates.filter((item) => item?.resumeSource === "image_fallback").length;
    this.resumeSourceStats = {
      network: networkCount,
      dom_fallback: domFallbackCount,
      image_fallback: imageFallbackCount
    };
    if (
      this.resumeSourceStats.network <= 0
      && this.resumeSourceStats.dom_fallback <= 0
      && this.resumeSourceStats.image_fallback <= 0
    ) {
      const snapshotSource = normalizeText(parsed.resume_source || "").toLowerCase();
      if (snapshotSource === "network") {
        this.resumeSourceStats.network = 1;
      } else if (snapshotSource === "dom_fallback") {
        this.resumeSourceStats.dom_fallback = 1;
      } else if (snapshotSource === "image_fallback") {
        this.resumeSourceStats.image_fallback = 1;
      }
    }
    const checkpointMode = normalizeText(parsed.resume_acquisition_mode || "").toLowerCase();
    if (["network", "image"].includes(checkpointMode)) {
      this.resumeAcquisitionMode = checkpointMode;
      this.resumeAcquisitionModeReason = normalizeText(parsed.resume_acquisition_mode_reason || "checkpoint");
    } else if (this.resumeSourceStats.network > 0) {
      this.resumeAcquisitionMode = "network";
      this.resumeAcquisitionModeReason = "checkpoint_source_stats";
    } else if (this.resumeSourceStats.image_fallback > 0) {
      this.resumeAcquisitionMode = "image";
      this.resumeAcquisitionModeReason = "checkpoint_source_stats";
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
      const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
      if (!frame || !frame.contentDocument) {
        return { ok: false, error: 'NO_RECOMMEND_IFRAME' };
      }
      const doc = frame.contentDocument;
      const recommendInner = Array.from(doc.querySelectorAll('.card-inner[data-geekid]'))
        .find((item) => (item.getAttribute('data-geekid') || '') === String(candidateKey)) || null;
      const latestInner = recommendInner
        ? null
        : ${buildSelectorCollectionExpression([".candidate-card-wrap .card-inner[data-geek]", ".candidate-card-wrap [data-geek]"], "doc")}
          .find((item) => (item.getAttribute('data-geek') || '') === String(candidateKey)) || null;
      const featuredAnchor = (recommendInner || latestInner)
        ? null
        : ${buildSelectorCollectionExpression(["li.geek-info-card a[data-geekid]", "a[data-geekid]"], "doc")}
          .find((item) => (item.getAttribute('data-geekid') || '') === String(candidateKey)) || null;
      const card = recommendInner
        ? (recommendInner.closest('li.card-item') || recommendInner.closest('.card-item'))
        : latestInner
          ? (latestInner.closest('.candidate-card-wrap') || latestInner.closest('li.card-item') || latestInner.closest('.card-item'))
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

  async extractCandidateProfileFromCard(candidate) {
    const candidateKey = candidate?.key || candidate?.geek_id || null;
    if (!candidateKey) {
      return null;
    }
    let profile = null;
    try {
      profile = await this.evaluate(`((candidateKey) => {
        const frame = ${buildFirstSelectorLookupExpression(RECOMMEND_IFRAME_SELECTORS)};
        if (!frame || !frame.contentDocument) {
          return { ok: false, error: "NO_RECOMMEND_IFRAME" };
        }
        const doc = frame.contentDocument;
        const textOf = (el) => String(el ? el.textContent : "").replace(/\\s+/g, " ").trim();
        const pick = (root, selectors) => {
          if (!root) return "";
          for (const selector of selectors || []) {
            let node = null;
            try {
              node = root.querySelector(selector);
            } catch {
              node = null;
            }
            const text = textOf(node);
            if (text) return text;
          }
          return "";
        };
        const rankDegree = (value) => {
          const text = normalize(value).toLowerCase();
          if (!text) return 0;
          if (/博士|phd|doctor/.test(text)) return 7;
          if (/硕士|master/.test(text)) return 6;
          if (/本科|学士|bachelor/.test(text)) return 5;
          if (/大专|专科/.test(text)) return 4;
          if (/高中/.test(text)) return 3;
          if (/中专|中技/.test(text)) return 2;
          if (/初中|小学/.test(text)) return 1;
          return 0;
        };
        const recommendInner = Array.from(doc.querySelectorAll(".card-inner[data-geekid]"))
          .find((item) => (item.getAttribute("data-geekid") || "") === String(candidateKey)) || null;
        const latestInner = recommendInner
          ? null
          : ${buildSelectorCollectionExpression([".candidate-card-wrap .card-inner[data-geek]", ".candidate-card-wrap [data-geek]"], "doc")}
            .find((item) => (item.getAttribute("data-geek") || "") === String(candidateKey)) || null;
        const featuredAnchor = (recommendInner || latestInner)
          ? null
          : ${buildSelectorCollectionExpression(["li.geek-info-card a[data-geekid]", "a[data-geekid]"], "doc")}
            .find((item) => (item.getAttribute("data-geekid") || "") === String(candidateKey)) || null;
        const card = recommendInner
          ? (recommendInner.closest("li.card-item") || recommendInner.closest(".card-item"))
          : latestInner
            ? (latestInner.closest(".candidate-card-wrap") || latestInner.closest("li.card-item") || latestInner.closest(".card-item"))
            : (featuredAnchor ? (featuredAnchor.closest("li.geek-info-card") || featuredAnchor.closest(".geek-info-card")) : null);
        if (!card) {
          return { ok: false, error: "CANDIDATE_CARD_NOT_FOUND" };
        }
        const eduSpans = Array.from(card.querySelectorAll(".edu-wrap .edu-exp span, .edu-wrap .content span, .edu-wrap span"))
          .map((item) => textOf(item))
          .filter(Boolean);
        const latestWork = card.querySelector(".timeline-wrap.work-exps .timeline-item");
        const workSpans = latestWork
          ? Array.from(latestWork.querySelectorAll(".join-text-wrap.content span")).map((item) => textOf(item)).filter(Boolean)
          : [];
        const workTimeSpans = latestWork
          ? Array.from(latestWork.querySelectorAll(".join-text-wrap.time span")).map((item) => textOf(item)).filter(Boolean)
          : [];
        const eduItems = Array.from(card.querySelectorAll(".timeline-wrap.edu-exps .timeline-item"))
          .map((item) => {
            const timeSpans = Array.from(item.querySelectorAll(".join-text-wrap.time span")).map((node) => textOf(node)).filter(Boolean);
            const contentSpans = Array.from(item.querySelectorAll(".join-text-wrap.content span")).map((node) => textOf(node)).filter(Boolean);
            return {
              school: contentSpans[0] || "",
              major: contentSpans[1] || "",
              degree: contentSpans[2] || "",
              start: timeSpans[0] || "",
              end: timeSpans[1] || ""
            };
          })
          .filter((item) => item.school || item.major || item.degree || item.start || item.end)
          .slice(0, 2);
        if (eduItems.length === 0 && (eduSpans[0] || eduSpans[1] || eduSpans[2])) {
          eduItems.push({
            school: eduSpans[0] || "",
            major: eduSpans[1] || "",
            degree: eduSpans[2] || "",
            start: "",
            end: ""
          });
        }
        const baseInfoTokens = Array.from(card.querySelectorAll(".join-text-wrap.base-info span, .base-info span"))
          .map((item) => textOf(item))
          .filter(Boolean);
        let age = "";
        let workYears = "";
        let highestDegree = "";
        for (const token of baseInfoTokens) {
          if (!age && /\d+\s*岁/u.test(token)) {
            age = token;
            continue;
          }
          if (!workYears && /(\d+\s*年|应届|在校)/u.test(token) && !/\d+\s*岁/u.test(token)) {
            workYears = token;
            continue;
          }
          if (!highestDegree && /(博士|硕士|本科|大专|专科|高中|中专|中技|初中)/u.test(token)) {
            highestDegree = token;
          }
        }
        const genderUse = card.querySelector("svg.gender use, .gender use, svg[class*='gender'] use");
        const genderHref = String(
          (genderUse && (genderUse.getAttribute("xlink:href") || genderUse.getAttribute("href") || ""))
          || ""
        ).toLowerCase();
        let gender = "";
        if (/(man|male|boy|icon-man|男)/.test(genderHref)) {
          gender = "男";
        } else if (/(woman|female|girl|icon-woman|女)/.test(genderHref)) {
          gender = "女";
        }
        if (!highestDegree) {
          const degreeFromEdu = eduItems
            .slice()
            .sort((a, b) => rankDegree(b.degree) - rankDegree(a.degree))[0];
          if (degreeFromEdu?.degree) {
            highestDegree = degreeFromEdu.degree;
          }
        }
        return {
          ok: true,
          name: pick(card, [".geek-name-wrap .name", ".name-wrap .name", "span.name", ".name"]),
          school: eduSpans[0] || pick(card, [".edu-wrap .school-name", ".base-info .school-name", ".school-name"]),
          major: eduSpans[1] || pick(card, [".edu-wrap .major", ".major"]),
          company: workSpans[0] || pick(card, [".company-name-wrap .name", ".company-name"]),
          position: workSpans[1] || pick(card, [".position span", ".position"]),
          age,
          gender,
          highest_degree: highestDegree,
          work_years: workYears,
          latest_work_start: workTimeSpans[0] || "",
          latest_work_end: workTimeSpans[1] || "",
          education_list: eduItems
        };
      })(${JSON.stringify(candidateKey)})`);
    } catch {
      profile = null;
    }
    if (!profile?.ok) {
      return null;
    }
    return {
      name: normalizeText(profile?.name || ""),
      school: normalizeText(profile?.school || ""),
      major: normalizeText(profile?.major || ""),
      company: normalizeText(profile?.company || ""),
      position: normalizeText(profile?.position || ""),
      age: normalizeText(profile?.age || ""),
      gender: normalizeText(profile?.gender || ""),
      highestDegree: normalizeText(profile?.highest_degree || ""),
      workYears: normalizeText(profile?.work_years || ""),
      latestWorkStart: normalizeText(profile?.latest_work_start || ""),
      latestWorkEnd: normalizeText(profile?.latest_work_end || ""),
      educationList: Array.isArray(profile?.education_list)
        ? profile.education_list
            .map((item) => ({
              school: normalizeText(item?.school || ""),
              major: normalizeText(item?.major || ""),
              degree: normalizeText(item?.degree || ""),
              start: normalizeText(item?.start || ""),
              end: normalizeText(item?.end || "")
            }))
            .filter((item) => item.school || item.major || item.degree || item.start || item.end)
            .slice(0, 2)
        : []
    };
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
          scrollSettleMs: 500,
          stitchFullImage: false
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
    const primaryLimit = resolveVisionPixelLimitFromEnv(
      "BOSS_RECOMMEND_VISION_MAX_IMAGE_PIXELS",
      DEFAULT_VISION_MAX_IMAGE_PIXELS
    );
    const retryLimit = resolveVisionRetryPixelLimit(primaryLimit);
    const preparedPrimary = await this.prepareVisionInputsForModel(imagePath, primaryLimit, "primary");
    try {
      const primaryResult = await this.requestVisionModel(preparedPrimary.imagePaths);
      return this.applyVisionEvidenceGate(primaryResult);
    } catch (error) {
      if (!isVisionImageSizeLimitMessage(error?.message || "")) {
        throw error;
      }
      log(
        `[VISION] 检测到图片尺寸超限，准备降采样重试: ` +
        `primary_limit=${primaryLimit} source=${preparedPrimary.source} ` +
        `source_pixels=${preparedPrimary.sourcePixels ?? "unknown"} ` +
        `segments=${preparedPrimary.imagePaths?.length || 1}`
      );
    }
    const preparedRetry = await this.prepareVisionInputsForModel(imagePath, retryLimit, "retry");
    try {
      const retryResult = await this.requestVisionModel(preparedRetry.imagePaths);
      return this.applyVisionEvidenceGate(retryResult);
    } catch (retryError) {
      if (!isVisionImageSizeLimitMessage(retryError?.message || "")) {
        throw retryError;
      }
      throw this.buildError(
        "VISION_IMAGE_SIZE_LIMIT_EXCEEDED",
        `Vision model still rejected image after retry downscale; ` +
          `primary_limit=${primaryLimit}; retry_limit=${retryLimit}; ` +
          `source_pixels=${preparedRetry.sourcePixels ?? "unknown"}; ` +
          `retry_pixels=${preparedRetry.currentPixels ?? "unknown"}; ` +
          `segments=${preparedRetry.imagePaths?.length || 1}; ` +
          `last_error=${normalizeText(retryError?.message || retryError)}`
      );
    }
  }

  async prepareVisionInputsForModel(imageInput, maxPixels, attemptTag = "primary") {
    const sourcePaths = Array.isArray(imageInput) ? imageInput.filter(Boolean) : [imageInput].filter(Boolean);
    if (sourcePaths.length <= 0) {
      return {
        imagePaths: [],
        source: "empty",
        sourcePixels: null,
        currentPixels: null
      };
    }
    const preparedItems = [];
    for (let index = 0; index < sourcePaths.length; index += 1) {
      const prepared = await this.prepareVisionImageSegmentsForModel(
        sourcePaths[index],
        maxPixels,
        `${attemptTag}.input${String(index + 1).padStart(3, "0")}`
      );
      preparedItems.push(prepared);
    }
    return {
      imagePaths: preparedItems.flatMap((item) => item.imagePaths || []),
      source: sourcePaths.length > 1 ? "ordered_chunks" : (preparedItems[0]?.source || "single"),
      sourcePixels: preparedItems.reduce((acc, item) => (
        Number.isFinite(Number(item?.sourcePixels)) ? acc + Number(item.sourcePixels) : acc
      ), 0) || null,
      currentPixels: preparedItems.reduce((acc, item) => (
        Number.isFinite(Number(item?.currentPixels)) ? acc + Number(item.currentPixels) : acc
      ), 0) || null
    };
  }

  applyVisionEvidenceGate(result) {
    const parsed = result && typeof result === "object" ? result : {};
    const rawPassed = parsed?.rawPassed === true || parsed?.passed === true;
    const parsedEvidence = toStringArray(parsed?.evidence);
    const evidenceRawCount = Number.isFinite(Number(parsed?.evidenceRawCount))
      ? Number(parsed.evidenceRawCount)
      : parsedEvidence.length;
    const evidenceMatchedCount = Number.isFinite(Number(parsed?.evidenceMatchedCount))
      ? Number(parsed.evidenceMatchedCount)
      : parsedEvidence.length;
    const cot = normalizeText(parsed?.cot || parsed?.reason || "");
    const summary = normalizeText(parsed?.summary || cot);
    const finalReason = cot || (rawPassed ? "模型判定符合筛选标准。" : "模型判定不符合筛选标准。");
    return {
      passed: rawPassed,
      rawPassed,
      cot: finalReason,
      reason: finalReason,
      summary: summary || finalReason,
      evidence: parsedEvidence,
      evidenceRawCount,
      evidenceMatchedCount,
      evidenceGateDemoted: false
    };
  }

  async prepareVisionImageSegmentsForModel(imagePath, maxPixels, attemptTag = "primary") {
    const resolvedMaxPixels = parsePositiveInteger(maxPixels);
    if (!resolvedMaxPixels) {
      return {
        imagePaths: [imagePath],
        source: "no_limit",
        sourcePixels: null,
        currentPixels: null
      };
    }

    let sharp;
    try {
      sharp = loadVisionSharp();
    } catch (error) {
      log(`[VISION] 加载 sharp 失败，回退到单图模式: ${error?.message || error}`);
      const single = await this.prepareVisionImageForModel(imagePath, resolvedMaxPixels, attemptTag);
      return {
        imagePaths: [single.imagePath],
        source: `single_${single.source}`,
        sourcePixels: single.sourcePixels ?? null,
        currentPixels: single.currentPixels ?? null
      };
    }

    let metadata;
    try {
      metadata = await sharp(imagePath).metadata();
    } catch (error) {
      log(`[VISION] 读取图片尺寸失败，回退到单图模式: ${error?.message || error}`);
      const single = await this.prepareVisionImageForModel(imagePath, resolvedMaxPixels, attemptTag);
      return {
        imagePaths: [single.imagePath],
        source: `single_${single.source}`,
        sourcePixels: single.sourcePixels ?? null,
        currentPixels: single.currentPixels ?? null
      };
    }

    const width = Number(metadata?.width || 0);
    const height = Number(metadata?.height || 0);
    const sourcePixels = width > 0 && height > 0 ? width * height : null;
    if (!sourcePixels || sourcePixels <= resolvedMaxPixels) {
      return {
        imagePaths: [imagePath],
        source: "within_limit",
        sourcePixels,
        currentPixels: sourcePixels
      };
    }

    const maxTileHeight = Math.floor(resolvedMaxPixels / Math.max(1, width));
    if (!Number.isFinite(maxTileHeight) || maxTileHeight < 64) {
      const single = await this.prepareVisionImageForModel(imagePath, resolvedMaxPixels, attemptTag);
      return {
        imagePaths: [single.imagePath],
        source: `single_${single.source}`,
        sourcePixels: single.sourcePixels ?? sourcePixels,
        currentPixels: single.currentPixels ?? sourcePixels
      };
    }

    const parsedPath = path.parse(imagePath);
    const imagePaths = [];
    for (let top = 0, index = 0; top < height; top += maxTileHeight, index += 1) {
      const segmentHeight = Math.min(maxTileHeight, height - top);
      const segmentPath = path.join(
        parsedPath.dir,
        `${parsedPath.name}.${attemptTag}.seg${String(index + 1).padStart(3, "0")}.png`
      );
      await sharp(imagePath)
        .extract({
          left: 0,
          top,
          width,
          height: segmentHeight
        })
        .png()
        .toFile(segmentPath);
      imagePaths.push(segmentPath);
    }

    log(
      `[VISION] 长简历按分段输入模型: ${width}x${height}(${sourcePixels}) ` +
      `-> segments=${imagePaths.length}, max_pixels_per_segment=${resolvedMaxPixels}, attempt=${attemptTag}`
    );
    return {
      imagePaths,
      source: "segmented",
      sourcePixels,
      currentPixels: resolvedMaxPixels
    };
  }

  async prepareVisionImageForModel(imagePath, maxPixels, attemptTag = "primary") {
    const resolvedMaxPixels = parsePositiveInteger(maxPixels);
    if (!resolvedMaxPixels) {
      return {
        imagePath,
        source: "no_limit",
        sourcePixels: null,
        currentPixels: null
      };
    }
    let sharp;
    try {
      sharp = loadVisionSharp();
    } catch (error) {
      log(`[VISION] 加载 sharp 失败，跳过预缩放: ${error?.message || error}`);
      return {
        imagePath,
        source: "sharp_unavailable",
        sourcePixels: null,
        currentPixels: null
      };
    }
    let metadata;
    try {
      metadata = await sharp(imagePath).metadata();
    } catch (error) {
      log(`[VISION] 读取图片尺寸失败，跳过预缩放: ${error?.message || error}`);
      return {
        imagePath,
        source: "metadata_error",
        sourcePixels: null,
        currentPixels: null
      };
    }
    const width = Number(metadata?.width || 0);
    const height = Number(metadata?.height || 0);
    const sourcePixels = width > 0 && height > 0 ? width * height : null;
    if (!sourcePixels || sourcePixels <= resolvedMaxPixels) {
      return {
        imagePath,
        source: "within_limit",
        sourcePixels,
        currentPixels: sourcePixels
      };
    }
    const scale = Math.sqrt(resolvedMaxPixels / sourcePixels);
    const targetWidth = Math.max(1, Math.floor(width * scale));
    const targetHeight = Math.max(1, Math.floor(height * scale));
    const parsedPath = path.parse(imagePath);
    const resizedPath = path.join(
      parsedPath.dir,
      `${parsedPath.name}.${attemptTag}.max${resolvedMaxPixels}.png`
    );
    try {
      await sharp(imagePath)
        .resize({
          width: targetWidth,
          height: targetHeight,
          fit: "inside",
          withoutEnlargement: true
        })
        .png()
        .toFile(resizedPath);
      const resizedMeta = await sharp(resizedPath).metadata();
      const resizedPixels = Number(resizedMeta?.width || 0) * Number(resizedMeta?.height || 0);
      log(
        `[VISION] 图片预缩放完成: ${width}x${height}(${sourcePixels}) -> ` +
        `${resizedMeta?.width || "?"}x${resizedMeta?.height || "?"}(${resizedPixels || "?"}); ` +
        `limit=${resolvedMaxPixels}; attempt=${attemptTag}`
      );
      return {
        imagePath: resizedPath,
        source: "resized",
        sourcePixels,
        currentPixels: resizedPixels || null
      };
    } catch (error) {
      log(`[VISION] 预缩放失败，继续使用原图: ${error?.message || error}`);
      return {
        imagePath,
        source: "resize_failed",
        sourcePixels,
        currentPixels: sourcePixels
      };
    }
  }

  async requestVisionModel(imagePath) {
    const imagePaths = Array.isArray(imagePath) ? imagePath.filter(Boolean) : [imagePath].filter(Boolean);
    if (imagePaths.length <= 0) {
      throw this.buildError("VISION_MODEL_FAILED", "No vision image input provided.");
    }
    const userContent = [
      {
        type: "text",
        text:
          "请根据以下标准判断候选人是否通过筛选。\n\n" +
          `筛选标准:\n${this.args.criteria}\n\n` +
          "你将收到候选人完整简历的一个或多个顺序分段图片。必须完整阅读全部分段后再判断，" +
          "不能只根据前几段下结论；后续分段中的教育、项目、经历或否定信息必须纳入最终判断。" +
          "严禁编造任何不存在的经历、项目、学校、公司或时间线；证据不足时必须判定为不通过。\n" +
          "当筛选条件涉及应届/毕业年份时，必须以最高学历毕业年份作为主依据；若简历中出现教育起止时间、毕业时间或可推断年份信息，必须先推断再判断，" +
          "只有完全不存在可推断时间信息时才可以写“无法判断”。\n" +
          "当筛选条件提及“相关经验”时，必须以工作经历或项目经历作为硬性证据；教育/课程/论文/技能/个人优势只能作为补充，不能单独判定满足。\n" +
          "workExpCheckRes 等经历校验项仅作为“需追问”软风险，不得直接据此判定不通过。\n" +
          "活跃度、沟通热度、受欢迎度等运营指标不参与筛选通过判定。\n\n" +
          "要求：\n" +
          "1) 只做结论判断：候选人是否符合筛选标准。\n" +
          "2) 只返回 passed 布尔值，不要在 JSON 中输出 reason/summary/evidence 等字段。\n\n" +
          "请返回严格 JSON: " +
          "{\"passed\": true/false}"
      }
    ];
    for (let index = 0; index < imagePaths.length; index += 1) {
      const segmentPath = imagePaths[index];
      const imageBase64 = fs.readFileSync(segmentPath, "base64");
      if (imagePaths.length > 1) {
        userContent.push({
          type: "text",
          text: `简历分段 ${index + 1}/${imagePaths.length}`
        });
      }
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${imageBase64}`
        }
      });
    }
    const rawBaseUrl = this.args.baseUrl;
    log(`[callVisionModel] baseUrl 原始值类型=${typeof rawBaseUrl}, 长度=${rawBaseUrl != null ? String(rawBaseUrl).length : "null/undefined"}, JSON编码=${JSON.stringify(rawBaseUrl)}`);
    const baseUrl = String(rawBaseUrl || "").replace(/\/$/, "");
    const payload = {
      model: this.args.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "你是一位严谨的招聘筛选助手。必须完整阅读所有输入材料，严禁臆造不存在的简历经历。" +
            "只能返回 JSON，不要输出任何额外文字。"
        },
        {
          role: "user",
          content: userContent
        }
      ]
    };
    applyChatCompletionThinking(payload, {
      baseUrl,
      model: this.args.model,
      thinkingLevel: this.args.thinkingLevel
    });
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
    const choice = json?.choices?.[0] || {};
    const content = flattenChatMessageContent(choice?.message?.content);
    const parsed = tryExtractJsonObject(content);
    const parsedPassed = parsePassedDecision(parsed?.passed);
    const fallbackPassed = parsePassedDecisionFromContent(content);
    const rawPassed = parsedPassed !== null ? parsedPassed : fallbackPassed;
    if (rawPassed === null) {
      throw this.buildError(
        "VISION_MODEL_FAILED",
        `Vision model response missing boolean passed decision. content=${truncateText(content, 180)}`
      );
    }
    const cot = normalizeText(extractCotFromChoice(choice, parsed));
    const reason = cot || (rawPassed ? "模型判定符合筛选标准。" : "模型判定不符合筛选标准。");
    const summary = reason;
    const parsedEvidence = toStringArray(parsed?.evidence);
    const evidenceRawCount = Number.isFinite(Number(parsed?.evidenceRawCount))
      ? Number(parsed.evidenceRawCount)
      : parsedEvidence.length;
    const evidenceMatchedCount = Number.isFinite(Number(parsed?.evidenceMatchedCount))
      ? Number(parsed.evidenceMatchedCount)
      : parsedEvidence.length;
    const passed = rawPassed;
    const enrichedReason = enrichReasonWithEvidence(reason, summary || reason, parsedEvidence, passed);
    return {
      passed,
      rawPassed,
      cot: reason,
      reason: enrichedReason,
      summary: summary || enrichedReason,
      evidence: parsedEvidence,
      evidenceRawCount,
      evidenceMatchedCount,
      evidenceGateEligible: false,
      evidenceGateDemoted: false
    };
  }

  async callTextModel(resumeText) {
    const fullResumeText = String(resumeText || "");
    if (!normalizeText(fullResumeText)) {
      throw this.buildError("TEXT_MODEL_FAILED", "Resume text is empty.");
    }
    try {
      return await this.requestTextModel(fullResumeText, {
        chunkIndex: 1,
        chunkTotal: 1
      });
    } catch (error) {
      if (!isTextContextLimitMessage(error?.message || "")) {
        throw error;
      }
      log("[TEXT_MODEL] 检测到上下文长度限制，启用分段筛选模式。");
    }

    const chunkSize = parsePositiveInteger(process.env.BOSS_RECOMMEND_TEXT_CHUNK_SIZE_CHARS) || DEFAULT_TEXT_MODEL_CHUNK_SIZE_CHARS;
    const overlap = parsePositiveInteger(process.env.BOSS_RECOMMEND_TEXT_CHUNK_OVERLAP_CHARS) || DEFAULT_TEXT_MODEL_CHUNK_OVERLAP_CHARS;
    const maxChunks = parsePositiveInteger(process.env.BOSS_RECOMMEND_TEXT_MAX_CHUNKS) || DEFAULT_TEXT_MODEL_MAX_CHUNKS;
    const chunks = splitTextByChunks(fullResumeText, chunkSize, overlap, maxChunks);
    if (!chunks.length) {
      throw this.buildError("TEXT_MODEL_FAILED", "Resume text is empty after chunk split.");
    }

    const chunkResults = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const result = await this.requestTextModel(chunk.text, {
        chunkIndex: index + 1,
        chunkTotal: chunks.length
      });
      chunkResults.push(result);
    }

    const passedChunks = chunkResults.filter((item) => item?.passed === true);
    if (passedChunks.length > 0) {
      const best = passedChunks[0];
      return {
        passed: true,
        rawPassed: best?.rawPassed === true || best?.passed === true,
        reason: best.reason || `分段筛选命中（${best.chunkIndex}/${chunks.length}）。`,
        summary: best.summary || best.reason || "分段筛选命中",
        evidence: Array.isArray(best.evidence) ? best.evidence : [],
        evidenceRawCount: Number.isFinite(Number(best?.evidenceRawCount)) ? Number(best.evidenceRawCount) : null,
        evidenceMatchedCount: Number.isFinite(Number(best?.evidenceMatchedCount)) ? Number(best.evidenceMatchedCount) : null,
        evidenceGateDemoted: best?.evidenceGateDemoted === true,
        chunkIndex: best?.chunkIndex || null,
        chunkTotal: best?.chunkTotal || chunks.length
      };
    }

    const firstReason = chunkResults.map((item) => normalizeText(item?.reason)).find(Boolean);
    return {
      passed: false,
      rawPassed: chunkResults.some((item) => item?.rawPassed === true),
      reason: firstReason || `分段筛选未找到满足标准的证据（共 ${chunks.length} 段）。`,
      summary: firstReason || `分段筛选未找到满足标准的证据（共 ${chunks.length} 段）。`,
      evidence: [],
      evidenceRawCount: chunkResults.reduce((acc, item) => acc + (Number.isFinite(Number(item?.evidenceRawCount)) ? Number(item.evidenceRawCount) : 0), 0),
      evidenceMatchedCount: chunkResults.reduce((acc, item) => acc + (Number.isFinite(Number(item?.evidenceMatchedCount)) ? Number(item.evidenceMatchedCount) : 0), 0),
      evidenceGateDemoted: chunkResults.some((item) => item?.evidenceGateDemoted === true),
      chunkIndex: null,
      chunkTotal: chunks.length
    };
  }

  async requestTextModel(resumeText, options = {}) {
    const safeResumeText = String(resumeText || "");
    const chunkIndex = Number.isInteger(options.chunkIndex) && options.chunkIndex > 0 ? options.chunkIndex : 1;
    const chunkTotal = Number.isInteger(options.chunkTotal) && options.chunkTotal > 0 ? options.chunkTotal : 1;
    const chunkHint = chunkTotal > 1
      ? `\n\n当前输入是简历分段 ${chunkIndex}/${chunkTotal}。请严格基于本分段文本判断；如果本分段证据不足，必须返回 passed=false。`
      : "";
    const rawBaseUrl = this.args.baseUrl;
    log(`[callTextModel] baseUrl 原始值类型=${typeof rawBaseUrl}, 长度=${rawBaseUrl != null ? String(rawBaseUrl).length : "null/undefined"}, JSON编码=${JSON.stringify(rawBaseUrl)}`);
    const baseUrl = String(rawBaseUrl || "").replace(/\/$/, "");
    const payload = {
      model: this.args.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "你是一位严谨的招聘筛选助手。必须完整阅读输入内容，严禁编造不存在的简历经历。" +
            "只能返回 JSON，不要输出任何额外文字。"
        },
        {
          role: "user",
          content:
            `请根据以下标准判断候选人是否通过筛选。\n\n筛选标准:\n${this.args.criteria}\n\n` +
            `简历内容:\n${safeResumeText}${chunkHint}\n\n` +
            "要求：\n" +
            "1) 必须完整阅读上面的全部简历文本。\n" +
            "2) 只能依据简历中真实出现的信息判断，严禁编造不存在的经历/项目/学历/公司。\n" +
            "3) 若文本中包含“人选卡片兜底信息（仅在简历缺失时使用）”段落，只能在主简历缺失对应字段时引用该段，不可覆盖主简历已明确字段。\n" +
            "4) 若证据不足，必须返回 passed=false。\n\n" +
            "5) 当筛选条件涉及应届/毕业年份时，必须以最高学历毕业年份作为主依据；若简历中存在教育时间、毕业时间或可推断年份信息，必须先推断再判断；" +
            "只有完全不存在时间线信息时才可写“无法判断”。\n" +
            "6) 当筛选条件提及“相关经验”时，必须以工作经历或项目经历作为硬性证据；教育/课程/论文/技能/个人优势只能作为补充，不能单独判定满足。\n" +
            "7) workExpCheckRes 等经历校验项仅作为“需追问”软风险，不得直接据此判定不通过。\n" +
            "8) 活跃度、沟通热度、受欢迎度等运营指标不参与筛选通过判定。\n" +
            "9) 只做结论判断：候选人是否符合筛选标准。\n" +
            "10) 只返回 passed 布尔值，不要在 JSON 中输出 reason/summary/evidence 等字段。\n\n" +
            "请返回严格 JSON: " +
            "{\"passed\": true/false}"
        }
      ]
    };
    applyChatCompletionThinking(payload, {
      baseUrl,
      model: this.args.model,
      thinkingLevel: this.args.thinkingLevel
    });
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
    const choice = json?.choices?.[0] || {};
    const content = flattenChatMessageContent(choice?.message?.content);
    const parsed = tryExtractJsonObject(content);
    const cot = normalizeText(extractCotFromChoice(choice, parsed));
    const normalizedResume = normalizeText(safeResumeText);
    const normalizedResumeLower = toLowerSafe(normalizedResume);
    const parsedEvidence = toStringArray(parsed?.evidence);
    const evidence = [];
    for (const item of parsedEvidence) {
      const matched = matchEvidenceAgainstResume(item, safeResumeText, normalizedResume, normalizedResumeLower);
      if (matched.matched) {
        evidence.push(item);
      }
    }
    const parsedPassed = parsePassedDecision(parsed?.passed);
    const fallbackPassed = parsePassedDecisionFromContent(content);
    const rawPassed = parsedPassed !== null ? parsedPassed : fallbackPassed;
    if (rawPassed === null) {
      throw this.buildError(
        "TEXT_MODEL_FAILED",
        `Text model response missing boolean passed decision. content=${truncateText(content, 180)}`
      );
    }
    const passed = rawPassed;
    const finalReason = cot || (passed ? "模型判定符合筛选标准。" : "模型判定不符合筛选标准。");
    const summary = finalReason;
    const enrichedReason = enrichReasonWithEvidence(finalReason, summary || finalReason, evidence, passed);
    return {
      passed,
      rawPassed,
      cot: finalReason,
      reason: enrichedReason,
      summary: summary || enrichedReason,
      evidence,
      evidenceRawCount: parsedEvidence.length,
      evidenceMatchedCount: evidence.length,
      evidenceGateDemoted: false,
      chunkIndex,
      chunkTotal
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
    if (!greet?.ok) {
      if (greet?.error === "GREET_CONTINUE_BUTTON_FOUND") {
        throw this.buildError("GREET_CONTINUE_BUTTON_FOUND", "检测到“继续沟通”按钮，判定为已沟通过，跳过本次打招呼。");
      }
      if (greet?.error === "GREET_BUTTON_NOT_FOUND") {
        throw this.buildError("GREET_BUTTON_NOT_FOUND", "未找到可用的打招呼按钮，跳过本次打招呼。");
      }
      throw this.buildError("GREET_BUTTON_FAILED", greet?.error || "打招呼按钮不可用");
    }
    if (greet.disabled) {
      throw this.buildError("GREET_BUTTON_FAILED", "打招呼按钮不可用");
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
    const listState = await this.evaluate(jsGetListState);
    if (listState?.ok) {
      log(`[关闭详情] 连续 ESC 后仍未确认关闭（${state?.reason || "unknown"}），但候选人列表已可用，按就绪状态继续。`);
      return true;
    }
    log(`[关闭详情] 连续 ESC 后仍未确认关闭（${state?.reason || "unknown"}），且候选人列表未恢复，判定关闭失败。`);
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
      const pauseMs = this.args.humanRestEnabled ? 3000 + Math.floor(Math.random() * 4000) : 0;
      log(`[随机休息] 暂停 ${Math.round(pauseMs / 1000)} 秒`);
      await sleep(pauseMs);
    }
    if (this.restCounter >= this.restThreshold) {
      const pauseMs = this.args.humanRestEnabled ? 15000 + Math.floor(Math.random() * 15000) : 0;
      log(`[批次休息] 已连续处理 ${this.restCounter} 人，暂停 ${Math.round(pauseMs / 1000)} 秒`);
      await sleep(pauseMs);
      this.restCounter = 0;
      this.restThreshold = 25 + Math.floor(Math.random() * 8);
    }
  }

  saveCsv() {
    const lines = [];
    const sanitizedInputSummary = sanitizeInputSummary(this.inputSummary);
    const inputSummaryRows = buildInputSummaryRows(sanitizedInputSummary);
    if (inputSummaryRows.length > 0) {
      lines.push(INPUT_SUMMARY_HEADER);
      for (const [key, value] of inputSummaryRows) {
        lines.push([csvEscape(key), csvEscape(value)].join(","));
      }
      lines.push("");
    }
    lines.push(CSV_HEADER);
    const passedByGeekId = new Map();
    for (const item of this.passedCandidates) {
      const key = normalizeText(item?.geekId || "");
      if (!key) continue;
      passedByGeekId.set(key, item);
    }
    const auditRows = Array.isArray(this.candidateAudits) && this.candidateAudits.length > 0
      ? this.candidateAudits
      : this.passedCandidates.map((item) => ({
          candidate_key: item?.geekId || "",
          geek_id: item?.geekId || "",
          candidate_name: item?.name || "",
          school: item?.school || "",
          major: item?.major || "",
          company: item?.company || "",
          position: item?.position || "",
          outcome: "passed",
          screening_reason: item?.reason || "",
          action_taken: item?.action || "none",
          resume_source: item?.resumeSource || "",
          raw_passed: true,
          final_passed: true,
          evidence_raw_count: null,
          evidence_matched_count: null,
          evidence_gate_demoted: false,
          error_code: "",
          error_message: ""
        }));
    for (const audit of auditRows) {
      const auditGeekId = normalizeText(audit?.geek_id || audit?.candidate_key || "");
      const passedItem = auditGeekId ? passedByGeekId.get(auditGeekId) : null;
      const finalPassed = audit?.final_passed === true || normalizeText(audit?.outcome || "") === "passed";
      const screeningReason = normalizeText(audit?.screening_reason || passedItem?.reason || "");
      const passReason = finalPassed ? screeningReason : "";
      const timing = sanitizeTimingBreakdown(audit?.timing_ms);
      lines.push([
        csvEscape(audit?.candidate_name || passedItem?.name || ""),
        csvEscape(audit?.school || passedItem?.school || ""),
        csvEscape(audit?.major || passedItem?.major || ""),
        csvEscape(audit?.company || passedItem?.company || ""),
        csvEscape(audit?.position || passedItem?.position || ""),
        csvEscape(passReason),
        csvEscape(audit?.outcome || (finalPassed ? "passed" : "unknown")),
        csvEscape(screeningReason),
        csvEscape(audit?.action_taken || passedItem?.action || "none"),
        csvEscape(audit?.resume_source || passedItem?.resumeSource || ""),
        csvEscape(audit?.raw_passed === true ? "true" : audit?.raw_passed === false ? "false" : ""),
        csvEscape(finalPassed ? "true" : "false"),
        csvEscape(Number.isFinite(Number(audit?.evidence_raw_count)) ? Number(audit.evidence_raw_count) : ""),
        csvEscape(Number.isFinite(Number(audit?.evidence_matched_count)) ? Number(audit.evidence_matched_count) : ""),
        csvEscape(audit?.evidence_gate_demoted === true ? "true" : "false"),
        csvEscape(audit?.error_code || ""),
        csvEscape(audit?.error_message || ""),
        csvEscape(auditGeekId || passedItem?.geekId || ""),
        csvEscape(getTimingMs(timing, "total_ms")),
        csvEscape(getTimingMs(timing, "card_profile_ms")),
        csvEscape(getTimingMs(timing, "click_candidate_ms")),
        csvEscape(getTimingMs(timing, "detail_open_ms")),
        csvEscape(getTimingMs(timing, "network_resume_wait_ms")),
        csvEscape(getTimingMs(timing, "text_model_ms")),
        csvEscape(getTimingMs(timing, "image_capture_ms")),
        csvEscape(getTimingMs(timing, "vision_model_ms")),
        csvEscape(getTimingMs(timing, "late_network_retry_ms")),
        csvEscape(getTimingMs(timing, "dom_fallback_ms")),
        csvEscape(getTimingMs(timing, "post_action_ms")),
        csvEscape(getTimingMs(timing, "close_detail_ms")),
        csvEscape(getTimingMs(timing, "rest_ms")),
        csvEscape(getTimingMs(timing, "checkpoint_save_ms"))
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
      log(
        `[恢复] 已从 checkpoint 恢复，已处理 ${this.processedCount} 位候选人，` +
        `其中通过 ${this.passedCandidates.length} 位。`
      );
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
      while (!this.args.targetCount || this.passedCandidates.length < this.args.targetCount) {
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
        const candidateStartedAt = Date.now();
        const candidateTiming = {};
        const candidateKeyForTiming = nextCandidate.key || nextCandidate.geek_id || "";
        const addCandidateTiming = (key, startedAt) => {
          const elapsed = Math.max(0, Date.now() - startedAt);
          candidateTiming[key] = Math.round((Number(candidateTiming[key]) || 0) + elapsed);
        };
        const timeCandidateStage = async (key, fn) => {
          const startedAt = Date.now();
          try {
            return await fn();
          } finally {
            addCandidateTiming(key, startedAt);
          }
        };
        const timeCandidateStageSync = (key, fn) => {
          const startedAt = Date.now();
          try {
            return fn();
          } finally {
            addCandidateTiming(key, startedAt);
          }
        };
        let shouldMarkProcessed = true;
        let resumeSource = "";
        let resumeTextLength = null;
        let screening = null;
        let candidateProfile = mergeCandidateProfiles(
          {
            name: nextCandidate.name || "",
            school: nextCandidate.school || "",
            major: nextCandidate.major || "",
            company: nextCandidate.last_company || "",
            position: nextCandidate.last_position || ""
          }
        );
        let allowDetailCloseFailure = false;

        try {
          this.currentCandidateKey = nextCandidate.key || nextCandidate.geek_id || null;
          const cardProfile = await timeCandidateStage(
            "card_profile_ms",
            () => this.extractCandidateProfileFromCard(nextCandidate)
          );
          candidateProfile = mergeCandidateProfiles(
            cardProfile || null,
            {
              name: nextCandidate.name || "",
              school: nextCandidate.school || "",
              major: nextCandidate.major || "",
              company: nextCandidate.last_company || "",
              position: nextCandidate.last_position || ""
            }
          );
          const candidateCaptureStartedAt = Date.now();
          await timeCandidateStage("click_candidate_ms", () => this.clickCandidate(nextCandidate));
          const detailOpen = await timeCandidateStage("detail_open_ms", () => this.ensureDetailOpen());
          if (!detailOpen) {
            throw this.buildError("DETAIL_OPEN_FAILED", "详情页打开超时");
          }

          let capture = null;
          let networkCandidateInfo = await timeCandidateStage(
            "network_resume_wait_ms",
            () => this.waitForResumeNetworkByMode(nextCandidate, {
              minTs: candidateCaptureStartedAt
            })
          );
          let domCandidateInfo = null;

          if (networkCandidateInfo?.resumeText) {
            networkCandidateInfo = enrichCandidateInfoWithCardProfile(networkCandidateInfo, cardProfile || null);
            screening = await timeCandidateStage(
              "text_model_ms",
              () => this.callTextModel(networkCandidateInfo.resumeText)
            );
            resumeSource = "network";
            resumeTextLength = normalizeText(networkCandidateInfo.resumeText).length;
            this.resumeSourceStats.network += 1;
            candidateProfile = mergeCandidateProfiles(
              networkCandidateInfo || null,
              cardProfile || null,
              {
                name: nextCandidate.name || "",
                school: nextCandidate.school || "",
                major: nextCandidate.major || "",
                company: nextCandidate.last_company || "",
                position: nextCandidate.last_position || ""
              }
            );
          } else {
            try {
              resumeSource = "image_fallback";
              capture = await timeCandidateStage(
                "image_capture_ms",
                () => this.captureResumeImage(nextCandidate)
              );
              this.setResumeAcquisitionMode("image", "image_capture_success");
              screening = await timeCandidateStage(
                "vision_model_ms",
                () => this.callVisionModel(capture.modelImagePaths || capture.stitchedImage)
              );
              this.resumeSourceStats.image_fallback += 1;
            } catch (imageFallbackError) {
              const lateNetworkCandidateInfo = await timeCandidateStage(
                "late_network_retry_ms",
                () => this.waitForLateNetworkResumeCandidateInfo(nextCandidate, {
                  minTs: candidateCaptureStartedAt
                })
              );
              if (lateNetworkCandidateInfo?.resumeText) {
                networkCandidateInfo = enrichCandidateInfoWithCardProfile(
                  lateNetworkCandidateInfo,
                  cardProfile || null
                );
                screening = await timeCandidateStage(
                  "text_model_ms",
                  () => this.callTextModel(networkCandidateInfo.resumeText)
                );
                resumeSource = "network";
                resumeTextLength = normalizeText(networkCandidateInfo.resumeText).length;
                this.resumeSourceStats.network += 1;
                candidateProfile = mergeCandidateProfiles(
                  networkCandidateInfo || null,
                  cardProfile || null,
                  {
                    name: nextCandidate.name || "",
                    school: nextCandidate.school || "",
                    major: nextCandidate.major || "",
                    company: nextCandidate.last_company || "",
                    position: nextCandidate.last_position || ""
                  }
                );
              } else {
                const domFallback = await timeCandidateStage(
                  "dom_fallback_ms",
                  () => this.resolveDomResumeFallback(nextCandidate, cardProfile || null)
                );
                if (domFallback?.networkCandidateInfo?.resumeText) {
                  networkCandidateInfo = enrichCandidateInfoWithCardProfile(
                    domFallback.networkCandidateInfo,
                    cardProfile || null
                  );
                  screening = await timeCandidateStage(
                    "text_model_ms",
                    () => this.callTextModel(networkCandidateInfo.resumeText)
                  );
                  resumeSource = "network";
                  resumeTextLength = normalizeText(networkCandidateInfo.resumeText).length;
                  this.resumeSourceStats.network += 1;
                  candidateProfile = mergeCandidateProfiles(
                    networkCandidateInfo || null,
                    cardProfile || null,
                    {
                      name: nextCandidate.name || "",
                      school: nextCandidate.school || "",
                      major: nextCandidate.major || "",
                      company: nextCandidate.last_company || "",
                      position: nextCandidate.last_position || ""
                    }
                  );
                } else if (domFallback?.domCandidateInfo?.resumeText) {
                  domCandidateInfo = enrichCandidateInfoWithCardProfile(
                    domFallback.domCandidateInfo,
                    cardProfile || null
                  );
                  screening = await timeCandidateStage(
                    "text_model_ms",
                    () => this.callTextModel(domCandidateInfo.resumeText)
                  );
                  resumeSource = "dom_fallback";
                  resumeTextLength = normalizeText(domCandidateInfo.resumeText).length;
                  this.resumeSourceStats.dom_fallback += 1;
                  candidateProfile = mergeCandidateProfiles(
                    domCandidateInfo || null,
                    cardProfile || null,
                    {
                      name: nextCandidate.name || "",
                      school: nextCandidate.school || "",
                      major: nextCandidate.major || "",
                      company: nextCandidate.last_company || "",
                      position: nextCandidate.last_position || ""
                    }
                  );
                } else {
                  throw imageFallbackError;
                }
              }
            }
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
              actionResult = await timeCandidateStage(
                "post_action_ms",
                () => effectiveAction === "favorite"
                  ? this.favoriteCandidate({
                    alreadyInterested: networkCandidateInfo?.alreadyInterested === true
                  })
                  : effectiveAction === "greet"
                    ? this.greetCandidate()
                    : Promise.resolve({ actionTaken: "none" })
              );
            } catch (postActionError) {
              if (!isRecoverablePostActionError(postActionError, effectiveAction)) {
                throw postActionError;
              }
              log(`[POST_ACTION_WARN] ${effectiveAction} 失败，继续写入通过候选人: ${postActionError.message || postActionError}`);
              if (effectiveAction === "greet") {
                allowDetailCloseFailure = true;
              }
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
              imagePath: capture?.stitchedImage || capture?.modelImagePaths?.[0] || capture?.chunkFiles?.[0] || "",
              resumeSource
            });
            this.recordCandidateAudit({
              candidate_key: nextCandidate.key || nextCandidate.geek_id || "",
              geek_id: nextCandidate.geek_id || nextCandidate.key || "",
              candidate_name: candidateProfile.name || nextCandidate.name || "",
              school: candidateProfile.school || "",
              major: candidateProfile.major || "",
              company: candidateProfile.company || "",
              position: candidateProfile.position || "",
              outcome: "passed",
              resume_source: resumeSource,
              resume_text_len: resumeTextLength,
              raw_passed: screening?.rawPassed === true || screening?.passed === true,
              final_passed: true,
              evidence_raw_count: Number.isFinite(Number(screening?.evidenceRawCount))
                ? Number(screening.evidenceRawCount)
                : (Array.isArray(screening?.evidence) ? screening.evidence.length : null),
              evidence_matched_count: Number.isFinite(Number(screening?.evidenceMatchedCount))
                ? Number(screening.evidenceMatchedCount)
                : (Array.isArray(screening?.evidence) ? screening.evidence.length : null),
              evidence_gate_demoted: screening?.evidenceGateDemoted === true,
              screening_reason: screeningReason,
              action_taken: actionResult.actionTaken || "none",
              chunk_index: Number.isFinite(Number(screening?.chunkIndex)) ? Number(screening.chunkIndex) : null,
              chunk_total: Number.isFinite(Number(screening?.chunkTotal)) ? Number(screening.chunkTotal) : null
            });
          } else {
            this.skippedCount += 1;
            this.recordCandidateAudit({
              candidate_key: nextCandidate.key || nextCandidate.geek_id || "",
              geek_id: nextCandidate.geek_id || nextCandidate.key || "",
              candidate_name: candidateProfile.name || nextCandidate.name || "",
              school: candidateProfile.school || "",
              major: candidateProfile.major || "",
              company: candidateProfile.company || "",
              position: candidateProfile.position || "",
              outcome: "skipped",
              resume_source: resumeSource,
              resume_text_len: resumeTextLength,
              raw_passed: screening?.rawPassed === true,
              final_passed: false,
              evidence_raw_count: Number.isFinite(Number(screening?.evidenceRawCount))
                ? Number(screening.evidenceRawCount)
                : (Array.isArray(screening?.evidence) ? screening.evidence.length : null),
              evidence_matched_count: Number.isFinite(Number(screening?.evidenceMatchedCount))
                ? Number(screening.evidenceMatchedCount)
                : (Array.isArray(screening?.evidence) ? screening.evidence.length : null),
              evidence_gate_demoted: screening?.evidenceGateDemoted === true,
              screening_reason: normalizeText(screening?.reason || screening?.summary || "模型判定不通过"),
              chunk_index: Number.isFinite(Number(screening?.chunkIndex)) ? Number(screening.chunkIndex) : null,
              chunk_total: Number.isFinite(Number(screening?.chunkTotal)) ? Number(screening.chunkTotal) : null
            });
          }
        } catch (error) {
          this.skippedCount += 1;
          this.recordCandidateAudit({
            candidate_key: nextCandidate.key || nextCandidate.geek_id || "",
            geek_id: nextCandidate.geek_id || nextCandidate.key || "",
            candidate_name: nextCandidate.name || candidateProfile.name || "",
            school: candidateProfile.school || nextCandidate.school || "",
            major: candidateProfile.major || nextCandidate.major || "",
            company: candidateProfile.company || nextCandidate.last_company || "",
            position: candidateProfile.position || nextCandidate.last_position || "",
            outcome: "skipped_error",
            resume_source: resumeSource,
            resume_text_len: resumeTextLength,
            raw_passed: screening?.rawPassed === true,
            final_passed: false,
            evidence_raw_count: Number.isFinite(Number(screening?.evidenceRawCount))
              ? Number(screening.evidenceRawCount)
              : (Array.isArray(screening?.evidence) ? screening.evidence.length : null),
            evidence_matched_count: Number.isFinite(Number(screening?.evidenceMatchedCount))
              ? Number(screening.evidenceMatchedCount)
              : (Array.isArray(screening?.evidence) ? screening.evidence.length : null),
            evidence_gate_demoted: screening?.evidenceGateDemoted === true,
            screening_reason: normalizeText(screening?.reason || screening?.summary || ""),
            error_code: error?.code || "CANDIDATE_PROCESS_FAILED",
            error_message: normalizeText(error?.message || error)
          });
          log(`候选人处理失败: ${error.code || error.message}`);
          if (["RESUME_CAPTURE_FAILED", "RESUME_NETWORK_UNAVAILABLE"].includes(error.code)) {
            this.recordResumeCaptureFailure(nextCandidate.key);
            const failureLabel = error.code === "RESUME_NETWORK_UNAVAILABLE"
              ? "简历 network/DOM 获取失败且截图回退未完成"
              : "简历截图失败";
            log(
              `[候选人跳过] ${nextCandidate.name || nextCandidate.geek_id || "unknown"} ${failureLabel}，` +
              `已跳过当前候选人；连续失败 ${this.consecutiveResumeCaptureFailures}/${MAX_CONSECUTIVE_RESUME_CAPTURE_FAILURES}`
            );
            if (this.consecutiveResumeCaptureFailures >= MAX_CONSECUTIVE_RESUME_CAPTURE_FAILURES) {
              shouldMarkProcessed = false;
              const rollback = this.rollbackResumeCaptureFailureStreak(nextCandidate.key);
              const failureTypeText = "简历获取失败（network + DOM + 截图）";
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
          if (error.code === "TEXT_MODEL_FAILED") {
            throw error;
          }
          if (error.code === "VISION_MODEL_FAILED") {
            if (isVisionImageSizeLimitMessage(error?.message || "")) {
              log(
                `[候选人跳过] ${nextCandidate.name || nextCandidate.geek_id || "unknown"} 触发视觉模型像素限制，` +
                "已在本轮跳过并继续处理下一位。"
              );
            } else {
              log(
                `[候选人跳过] ${nextCandidate.name || nextCandidate.geek_id || "unknown"} 视觉模型调用失败，` +
                "已在本轮跳过并继续处理下一位。"
              );
            }
          }
          if (error.code === "VISION_IMAGE_SIZE_LIMIT_EXCEEDED") {
            log(
              `[候选人跳过] ${nextCandidate.name || nextCandidate.geek_id || "unknown"} 触发视觉模型像素限制，` +
              "已完成预缩放和重试，仍失败，继续处理下一位。"
            );
          }
        } finally {
          const closed = await timeCandidateStage("close_detail_ms", () => this.closeDetailPage());
          if (!closed) {
            if (allowDetailCloseFailure) {
              log("[详情关闭兜底] 本候选人 post_action 失败后详情页关闭未确认，已记录错误并继续下一位候选人。");
            } else {
              throw this.buildError("DETAIL_CLOSE_FAILED", "详情页未能正确关闭");
            }
          }
          if (shouldMarkProcessed) {
            this.processedKeys.add(nextCandidate.key);
          }
        }

        await timeCandidateStage("rest_ms", () => this.takeBreakIfNeeded());
        candidateTiming.total_ms = Math.max(0, Date.now() - candidateStartedAt);
        this.updateCandidateAuditTiming(candidateKeyForTiming, candidateTiming);
        try {
          timeCandidateStageSync("checkpoint_save_ms", () => this.saveCheckpoint());
          candidateTiming.total_ms = Math.max(0, Date.now() - candidateStartedAt);
          this.updateCandidateAuditTiming(candidateKeyForTiming, candidateTiming);
        } catch (checkpointError) {
          log(`[保存checkpoint失败] ${checkpointError.message || checkpointError}`);
        }
        try {
          this.saveCsv();
        } catch (csvError) {
          log(`[增量保存CSV失败] ${csvError.message || csvError}`);
        }
        log(
          `[TIMING] candidate=${candidateKeyForTiming || nextCandidate.name || "unknown"} ` +
          `total_ms=${candidateTiming.total_ms ?? ""} ` +
          `network_ms=${candidateTiming.network_resume_wait_ms ?? 0} ` +
          `text_model_ms=${candidateTiming.text_model_ms ?? 0} ` +
          `image_capture_ms=${candidateTiming.image_capture_ms ?? 0} ` +
          `vision_model_ms=${candidateTiming.vision_model_ms ?? 0} ` +
          `post_action_ms=${candidateTiming.post_action_ms ?? 0} ` +
          `close_ms=${candidateTiming.close_detail_ms ?? 0}`
        );
      }

      if (this.args.targetCount && this.passedCandidates.length < this.args.targetCount) {
        throw this.buildError(
          "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED",
          `推荐列表已到底，但当前仅通过 ${this.passedCandidates.length} 位，尚未达到目标 ${this.args.targetCount} 位。`,
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
            this.args.targetCount && this.passedCandidates.length >= this.args.targetCount
              ? "target_count_reached"
              : "page_exhausted"
          ),
          completion_reason: this.args.targetCount && this.passedCandidates.length >= this.args.targetCount
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
          usage: "node boss-recommend-screen-cli.cjs --criteria \"有 MCP 开发经验\" --post-action <favorite|greet|none> --max-greet-count 10 --post-action-confirmed true --baseurl <url> --apikey <key> --model <model> --thinking-level off|low|medium|high|current --page-scope recommend|latest|featured --calibration <favorite-calibration.json> --port 9222 --human-rest <true|false> --output <csv-path> [--input-summary-json <json>] --checkpoint-path <checkpoint.json> --pause-control-path <pause-control.json> [--resume]"
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
      NETWORK_RESUME_IMAGE_MODE_GRACE_MS,
      NETWORK_RESUME_LATE_RETRY_MS,
      parseFavoriteActionFromPostData,
      parseFavoriteActionFromRequest,
      parseFavoriteActionFromKnownRequest,
      parseFavoriteActionFromActionLog,
      parseFavoriteActionFromWsPayload,
      isRecoverablePostActionError,
      classifyFinishedWrapState,
      formatResumeApiData,
      buildCardProfileFallbackText,
      enrichCandidateInfoWithCardProfile,
      extractEvidenceTokens,
      matchEvidenceAgainstResume
    }
  };
}
