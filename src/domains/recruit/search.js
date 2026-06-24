import {
  clearFocusedInput,
  clickNodeCenter,
  clickPoint,
  countSelectors,
  DETERMINISTIC_CLICK_OPTIONS,
  describeNode,
  findFirstNode,
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  insertText,
  pressKey,
  querySelector,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../../core/screening/index.js";
import {
  createRecoverySettleError,
  waitForMiniFreshStartSettle
} from "../common/recovery-settle.js";
import {
  RECRUIT_CARD_SELECTOR,
  RECRUIT_TARGET_URL,
  RECRUIT_NO_DATA_SELECTORS,
  RECRUIT_SEARCH_SELECTORS
} from "./constants.js";
import {
  getRecruitRoots,
  waitForRecruitRoots
} from "./roots.js";

const DEFAULT_RECRUIT_KEYWORD = "算法工程师";
const ACTIVE_CLASS_PATTERN = /\b(active|selected|checked|cur|current)\b/i;
const DEFAULT_RECRUIT_RESET_TIMEOUT_MS = 180000;
const DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS = 90000;
const DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS = 30000;
const DEFAULT_RECRUIT_CITY_NO_RESULT_FALLBACK_MS = 15000;

const DEGREE_LABEL_MAP = new Map([
  ["不限", "不限"],
  ["本科", "本科"],
  ["本科及以上", "本科"],
  ["硕士", "硕士"],
  ["硕士及以上", "硕士"],
  ["博士", "博士"]
]);

const SCHOOL_LABEL_ALIAS_MAP = new Map([
  ["统招", ["统招本科"]],
  ["统招本科", ["统招本科"]],
  ["双一流", ["双一流院校"]],
  ["双一流院校", ["双一流院校"]],
  ["211", ["211院校"]],
  ["211院校", ["211院校"]],
  ["985", ["985院校"]],
  ["985院校", ["985院校"]],
  ["留学生", ["留学生"]],
  ["qs100", ["QS 100", "QS100"]],
  ["qs500", ["QS 500", "QS500"]]
]);

const NATIONAL_CITY_LABELS = new Set([
  "全国",
  "不限",
  "不限城市",
  "全部",
  "All",
  "ALL",
  "all"
]);

const CITY_NO_RESULT_LABELS = new Set([
  "暂无结果",
  "暂无数据",
  "无结果"
]);
const EXPERIENCE_CUSTOM_MIN_VALUE = 1;
const EXPERIENCE_CUSTOM_MAX_VALUE = 12;
const EXPERIENCE_FIXED_LABEL_ALIASES = new Map([
  ["不限", "不限"],
  ["不限制", "不限"],
  ["无限制", "不限"],
  ["全部", "不限"],
  ["所有", "不限"],
  ["无", "不限"],
  ["none", "不限"],
  ["all", "不限"],
  ["在校/应届", "在校/应届"],
  ["在校应届", "在校/应届"],
  ["在校", "在校/应届"],
  ["应届", "在校/应届"],
  ["应届生", "在校/应届"],
  ["25年毕业", "25年毕业"],
  ["2025年毕业", "25年毕业"],
  ["25届", "25年毕业"],
  ["2025届", "25年毕业"],
  ["26年毕业", "26年毕业"],
  ["2026年毕业", "26年毕业"],
  ["26届", "26年毕业"],
  ["2026届", "26年毕业"],
  ["26年后毕业", "26年后毕业"],
  ["2026年后毕业", "26年后毕业"],
  ["26届后", "26年后毕业"],
  ["1-3年", "1-3年"],
  ["1到3年", "1-3年"],
  ["1至3年", "1-3年"],
  ["1~3年", "1-3年"],
  ["3-5年", "3-5年"],
  ["3到5年", "3-5年"],
  ["3至5年", "3-5年"],
  ["3~5年", "3-5年"],
  ["5-10年", "5-10年"],
  ["5到10年", "5-10年"],
  ["5至10年", "5-10年"],
  ["5~10年", "5-10年"]
]);
const EXPERIENCE_CUSTOM_ENDPOINTS = new Map([
  ["在校/应届", { value: 1, label: "在校/应届" }],
  ["在校应届", { value: 1, label: "在校/应届" }],
  ["在校", { value: 1, label: "在校/应届" }],
  ["应届", { value: 1, label: "在校/应届" }],
  ["应届生", { value: 1, label: "在校/应届" }],
  ["1年以内", { value: 2, label: "1年以内" }],
  ["一年以内", { value: 2, label: "1年以内" }],
  ["1年", { value: 2, label: "1年" }],
  ["一年", { value: 2, label: "1年" }],
  ["2年", { value: 3, label: "2年" }],
  ["二年", { value: 3, label: "2年" }],
  ["两年", { value: 3, label: "2年" }],
  ["3年", { value: 4, label: "3年" }],
  ["三年", { value: 4, label: "3年" }],
  ["4年", { value: 5, label: "4年" }],
  ["四年", { value: 5, label: "4年" }],
  ["5年", { value: 6, label: "5年" }],
  ["五年", { value: 6, label: "5年" }],
  ["6年", { value: 7, label: "6年" }],
  ["六年", { value: 7, label: "6年" }],
  ["7年", { value: 8, label: "7年" }],
  ["七年", { value: 8, label: "7年" }],
  ["8年", { value: 9, label: "8年" }],
  ["八年", { value: 9, label: "8年" }],
  ["9年", { value: 10, label: "9年" }],
  ["九年", { value: 10, label: "9年" }],
  ["10年", { value: 11, label: "10年" }],
  ["十年", { value: 11, label: "10年" }],
  ["10年以上", { value: 12, label: "10年以上" }],
  ["十年以上", { value: 12, label: "10年以上" }],
  ["10年+", { value: 12, label: "10年以上" }],
  ["10年以上经验", { value: 12, label: "10年以上" }],
  ["10+", { value: 12, label: "10年以上" }]
]);
const EXPERIENCE_CUSTOM_LABELS_BY_VALUE = new Map([
  [1, "在校/应届"],
  [2, "1年以内"],
  [3, "2年"],
  [4, "3年"],
  [5, "4年"],
  [6, "5年"],
  [7, "6年"],
  [8, "7年"],
  [9, "8年"],
  [10, "9年"],
  [11, "10年"],
  [12, "10年以上"]
]);
const GENDER_LABEL_ALIASES = new Map([
  ["不限", "不限"],
  ["不限制", "不限"],
  ["无限制", "不限"],
  ["全部", "不限"],
  ["所有", "不限"],
  ["无", "不限"],
  ["none", "不限"],
  ["all", "不限"],
  ["男", "男"],
  ["男性", "男"],
  ["男生", "男"],
  ["male", "男"],
  ["m", "男"],
  ["女", "女"],
  ["女性", "女"],
  ["女生", "女"],
  ["female", "女"],
  ["f", "女"]
]);
const AGE_FIXED_LABEL_ALIASES = new Map([
  ["不限", "不限"],
  ["不限制", "不限"],
  ["无限制", "不限"],
  ["全部", "不限"],
  ["所有", "不限"],
  ["无", "不限"],
  ["none", "不限"],
  ["all", "不限"],
  ["20-25", "20-25"],
  ["20到25", "20-25"],
  ["20至25", "20-25"],
  ["20~25", "20-25"],
  ["20-25岁", "20-25"],
  ["25-30", "25-30"],
  ["25到30", "25-30"],
  ["25至30", "25-30"],
  ["25~30", "25-30"],
  ["25-30岁", "25-30"],
  ["30-35", "30-35"],
  ["30到35", "30-35"],
  ["30至35", "30-35"],
  ["30~35", "30-35"],
  ["30-35岁", "30-35"],
  ["35-40", "35-40"],
  ["35到40", "35-40"],
  ["35至40", "35-40"],
  ["35~40", "35-40"],
  ["35-40岁", "35-40"],
  ["40-50", "40-50"],
  ["40到50", "40-50"],
  ["40至50", "40-50"],
  ["40~50", "40-50"],
  ["40-50岁", "40-50"],
  ["50以上", "50以上"],
  ["50岁以上", "50以上"],
  ["50+", "50以上"],
  ["50岁+", "50以上"]
]);
const AGE_CUSTOM_MIN = 16;
const AGE_CUSTOM_MAX = 46;

function uniqueNodeIds(nodeIds = []) {
  return Array.from(new Set(nodeIds.filter(Boolean)));
}

function buildRecruitSearchFrameUrl(pageUrl = RECRUIT_TARGET_URL) {
  const origin = new URL(pageUrl).origin;
  return `${origin}/web/frame/search/?jobId=&keywords=&t=${Date.now()}&source=&city=`;
}

async function navigateRecruitSearchFrame(client, iframeNodeId, {
  pageUrl = RECRUIT_TARGET_URL,
  reason = "reset_frame"
} = {}) {
  if (!iframeNodeId || typeof client?.Page?.navigate !== "function") return null;
  const iframeNode = await describeNode(client, iframeNodeId, { depth: 1, pierce: true });
  const frameId = iframeNode?.frameId;
  if (!frameId) return null;
  const frameUrl = buildRecruitSearchFrameUrl(pageUrl);
  await client.Page.navigate({ frameId, url: frameUrl });
  return {
    method: "Page.navigate",
    scope: "frame",
    frame_id: frameId,
    url: frameUrl,
    reason
  };
}

export function normalizeRecruitSearchLabel(label) {
  return normalizeText(label).replace(/\s+/g, "");
}

function normalizeRecruitSchoolCompareKey(label) {
  return normalizeRecruitSearchLabel(label).toLowerCase();
}

function resolveRecruitQsSchoolBucket(label) {
  const compareKey = normalizeRecruitSchoolCompareKey(label);
  const match = compareKey.match(/qs(?:世界大学排名)?(?:top)?(\d+)/i);
  if (!match) return [];
  const rank = Number(match[1]);
  if (!Number.isFinite(rank)) return [];
  return rank <= 100 ? ["QS 100", "QS100"] : ["QS 500", "QS500"];
}

export function buildRecruitSchoolSearchLabels(school) {
  const raw = normalizeText(school);
  if (!raw) return [];
  const normalized = normalizeRecruitSearchLabel(raw);
  const compareKey = normalizeRecruitSchoolCompareKey(raw);
  const labels = new Set([raw, normalized]);
  for (const alias of resolveRecruitQsSchoolBucket(raw)) {
    labels.add(alias);
  }
  for (const alias of SCHOOL_LABEL_ALIAS_MAP.get(compareKey) || []) {
    labels.add(alias);
  }
  return Array.from(labels).map(normalizeText).filter(Boolean);
}

export function buildRecruitJobTitleSearchTerms(jobTitle) {
  const normalized = normalizeText(jobTitle);
  if (!normalized) return [];
  const variants = [
    normalized,
    normalized.replace(/\s*[_＿]\s*/g, " "),
    normalized.replace(/\s*[｜|]\s*/g, " ")
  ].map(normalizeText).filter(Boolean);
  const separatorParts = normalized.split(/\s*[_＿｜|]\s*/).map(normalizeText).filter(Boolean);
  if (separatorParts.length > 1) {
    variants.push(separatorParts.join(" "));
    variants.push(separatorParts[0]);
  }
  return Array.from(new Set(variants));
}

export function isRecruitNationalCity(city) {
  return NATIONAL_CITY_LABELS.has(normalizeRecruitSearchLabel(city));
}

export function resolveRecruitDegreeLabel(degree) {
  const normalized = normalizeRecruitSearchLabel(degree || "不限");
  return DEGREE_LABEL_MAP.get(normalized) || normalized || "不限";
}

export function normalizeRecruitDegreeLabels(value) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[，,、|/]/)
      : [];
  const labels = rawItems
    .map(resolveRecruitDegreeLabel)
    .filter(Boolean);
  const uniqueLabels = uniqueNodeIds(labels);
  return uniqueLabels.length ? uniqueLabels : ["不限"];
}

function normalizeRecruitSchoolList(value) {
  const rawItems = Array.isArray(value)
    ? value.flatMap((item) => (
        typeof item === "string"
          ? item.split(/[，,、|/]/)
          : [item]
      ))
    : typeof value === "string"
      ? value.split(/[，,、|/]/)
      : [];
  return uniqueNodeIds(rawItems.map(normalizeText).filter(Boolean));
}

function normalizeExperienceCompareKey(value) {
  return normalizeRecruitSearchLabel(value).toLowerCase();
}

function resolveRecruitExperienceFixedLabel(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const direct = EXPERIENCE_FIXED_LABEL_ALIASES.get(normalized)
    || EXPERIENCE_FIXED_LABEL_ALIASES.get(normalizeExperienceCompareKey(normalized));
  if (direct) return direct;
  const compactRange = normalized
    .replace(/\s+/g, "")
    .replace(/[－—–]/g, "-")
    .replace(/(?:到|至)/g, "-")
    .replace(/[~～]/g, "-");
  return EXPERIENCE_FIXED_LABEL_ALIASES.get(compactRange) || null;
}

function normalizeRecruitExperienceCustomEndpoint(value, fallbackValue) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const number = Math.min(
      EXPERIENCE_CUSTOM_MAX_VALUE,
      Math.max(EXPERIENCE_CUSTOM_MIN_VALUE, Math.round(value))
    );
    return {
      value: number,
      label: EXPERIENCE_CUSTOM_LABELS_BY_VALUE.get(number) || String(number)
    };
  }
  const normalized = normalizeText(value);
  if (!normalized) {
    const number = fallbackValue;
    return {
      value: number,
      label: EXPERIENCE_CUSTOM_LABELS_BY_VALUE.get(number) || String(number)
    };
  }
  const direct = EXPERIENCE_CUSTOM_ENDPOINTS.get(normalized)
    || EXPERIENCE_CUSTOM_ENDPOINTS.get(normalizeExperienceCompareKey(normalized));
  if (direct) return { ...direct };
  const numeric = normalized.match(/^(\d+)\s*(?:年)?$/);
  if (numeric) {
    const years = Number.parseInt(numeric[1], 10);
    const valueByYears = new Map([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 8],
      [8, 9],
      [9, 10],
      [10, 11]
    ]);
    const number = valueByYears.get(years);
    if (number) {
      return {
        value: number,
        label: EXPERIENCE_CUSTOM_LABELS_BY_VALUE.get(number) || `${years}年`
      };
    }
  }
  throw new Error(`Unsupported recruit experience custom endpoint: ${normalized}`);
}

function parseRecruitExperienceCustomRangeText(value) {
  let text = normalizeText(value);
  if (!text) return null;
  text = text.replace(/^(?:自定义|custom)\s*[：:]?\s*/i, "").trim();
  if (!text) return {
    start: "在校/应届",
    end: "10年以上"
  };
  const parts = text
    .replace(/[－—–]/g, "-")
    .split(/\s*(?:到|至|~|～|-)\s*/)
    .map(normalizeText)
    .filter(Boolean);
  if (parts.length >= 2) {
    return {
      start: parts[0],
      end: parts[parts.length - 1]
    };
  }
  return null;
}

export function normalizeRecruitExperienceFilter(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const first = value.find((item) => normalizeText(item));
    return first === undefined ? null : normalizeRecruitExperienceFilter(first);
  }
  if (typeof value === "object") {
    const mode = normalizeText(value.mode).toLowerCase();
    const label = normalizeText(value.label || value.option || value.value);
    const hasCustomEndpoints = Object.prototype.hasOwnProperty.call(value, "start")
      || Object.prototype.hasOwnProperty.call(value, "end")
      || Object.prototype.hasOwnProperty.call(value, "min")
      || Object.prototype.hasOwnProperty.call(value, "max")
      || Object.prototype.hasOwnProperty.call(value, "from")
      || Object.prototype.hasOwnProperty.call(value, "to")
      || Object.prototype.hasOwnProperty.call(value, "start_value")
      || Object.prototype.hasOwnProperty.call(value, "end_value");
    if (mode === "custom" || hasCustomEndpoints) {
      const startSource = value.start ?? value.min ?? value.from ?? value.start_label ?? value.start_value;
      const endSource = value.end ?? value.max ?? value.to ?? value.end_label ?? value.end_value;
      const start = normalizeRecruitExperienceCustomEndpoint(startSource, EXPERIENCE_CUSTOM_MIN_VALUE);
      const end = normalizeRecruitExperienceCustomEndpoint(endSource, EXPERIENCE_CUSTOM_MAX_VALUE);
      if (start.value > end.value) {
        throw new Error(`Recruit experience custom start must be <= end: ${start.label} > ${end.label}`);
      }
      return {
        mode: "custom",
        start_label: start.label,
        end_label: end.label,
        start_value: start.value,
        end_value: end.value,
        label: `${start.label}-${end.label}`
      };
    }
    return normalizeRecruitExperienceFilter(label);
  }

  const text = normalizeText(value);
  if (!text) return null;
  const fixedLabel = resolveRecruitExperienceFixedLabel(text);
  if (fixedLabel) {
    return {
      mode: "option",
      label: fixedLabel,
      unlimited: fixedLabel === "不限"
    };
  }
  const customRange = parseRecruitExperienceCustomRangeText(text);
  if (customRange || /^(?:自定义|custom)$/i.test(text)) {
    return normalizeRecruitExperienceFilter({
      mode: "custom",
      start: customRange?.start || "在校/应届",
      end: customRange?.end || "10年以上"
    });
  }
  throw new Error(`Unsupported recruit experience filter: ${text}`);
}

function normalizeGenderCompareKey(value) {
  return normalizeRecruitSearchLabel(value).toLowerCase();
}

export function normalizeRecruitGenderFilter(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const first = value.find((item) => normalizeText(item));
    return first === undefined ? null : normalizeRecruitGenderFilter(first);
  }
  if (typeof value === "object") {
    return normalizeRecruitGenderFilter(value.label || value.value || value.gender);
  }
  const text = normalizeText(value);
  if (!text) return null;
  const label = GENDER_LABEL_ALIASES.get(text) || GENDER_LABEL_ALIASES.get(normalizeGenderCompareKey(text));
  if (!label) throw new Error(`Unsupported recruit gender filter: ${text}`);
  return {
    label,
    unlimited: label === "不限"
  };
}

function parseAgeNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const text = normalizeText(value);
  if (!text) return fallback;
  if (/^(?:不限|不限制|无限制|全部|所有|无|none|all)$/i.test(text)) return fallback;
  const match = text.match(/(\d+)/);
  if (!match) return fallback;
  return Number.parseInt(match[1], 10);
}

function normalizeAgeFixedLabel(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const compact = text
    .replace(/\s+/g, "")
    .replace(/[－—–]/g, "-")
    .replace(/(?:到|至)/g, "-")
    .replace(/[~～]/g, "-");
  return AGE_FIXED_LABEL_ALIASES.get(text)
    || AGE_FIXED_LABEL_ALIASES.get(compact)
    || AGE_FIXED_LABEL_ALIASES.get(normalizeRecruitSearchLabel(compact));
}

function parseAgeCustomRangeText(value) {
  let text = normalizeText(value);
  if (!text) return null;
  text = text.replace(/^(?:自定义|custom)\s*[：:]?\s*/i, "").trim();
  if (!text) return { min: null, max: null };
  const rangeMatch = text
    .replace(/[－—–]/g, "-")
    .match(/(\d+)\s*(?:岁)?\s*(?:-|到|至|~|～)\s*(\d+)\s*(?:岁)?/);
  if (rangeMatch) {
    return {
      min: Number.parseInt(rangeMatch[1], 10),
      max: Number.parseInt(rangeMatch[2], 10)
    };
  }
  return null;
}

function parseAgeCustomComparisonText(value) {
  const text = normalizeText(value).replace(/\s+/g, "");
  if (!text) return null;
  const strictUpper = text.match(/^(?:低于|小于|少于|未满|不满|<)(\d+)(?:岁)?$/);
  if (strictUpper) {
    return {
      min: null,
      max: Number.parseInt(strictUpper[1], 10) - 1
    };
  }
  const inclusiveUpper = text.match(/^(?:不超过|不大于|至多|最多|<=|≤)(\d+)(?:岁)?$/)
    || text.match(/^(\d+)(?:岁)?(?:及以下|以下|以内)$/);
  if (inclusiveUpper) {
    return {
      min: null,
      max: Number.parseInt(inclusiveUpper[1], 10)
    };
  }
  const strictLower = text.match(/^(?:高于|大于|超过|>)(\d+)(?:岁)?$/);
  if (strictLower) {
    return {
      min: Number.parseInt(strictLower[1], 10) + 1,
      max: null
    };
  }
  const inclusiveLower = text.match(/^(?:不低于|不小于|至少|最低|>=|≥)(\d+)(?:岁)?$/)
    || text.match(/^(\d+)(?:岁)?(?:及以上|以上)$/);
  if (inclusiveLower) {
    return {
      min: Number.parseInt(inclusiveLower[1], 10),
      max: null
    };
  }
  return null;
}

export function normalizeRecruitAgeFilter(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const first = value.find((item) => normalizeText(item));
    return first === undefined ? null : normalizeRecruitAgeFilter(first);
  }
  if (typeof value === "object") {
    const mode = normalizeText(value.mode).toLowerCase();
    const label = normalizeText(value.label || value.option || value.value);
    const hasCustom = Object.prototype.hasOwnProperty.call(value, "min")
      || Object.prototype.hasOwnProperty.call(value, "max")
      || Object.prototype.hasOwnProperty.call(value, "start")
      || Object.prototype.hasOwnProperty.call(value, "end")
      || Object.prototype.hasOwnProperty.call(value, "from")
      || Object.prototype.hasOwnProperty.call(value, "to");
    if (mode === "custom" || hasCustom) {
      const min = parseAgeNumber(value.min ?? value.start ?? value.from, null);
      const max = parseAgeNumber(value.max ?? value.end ?? value.to, null);
      if (min !== null && (min < AGE_CUSTOM_MIN || min > AGE_CUSTOM_MAX)) {
        throw new Error(`Recruit age custom min must be between ${AGE_CUSTOM_MIN} and ${AGE_CUSTOM_MAX}: ${min}`);
      }
      if (max !== null && (max < AGE_CUSTOM_MIN || max > AGE_CUSTOM_MAX)) {
        throw new Error(`Recruit age custom max must be between ${AGE_CUSTOM_MIN} and ${AGE_CUSTOM_MAX}: ${max}`);
      }
      if (min !== null && max !== null && min > max) {
        throw new Error(`Recruit age custom min must be <= max: ${min} > ${max}`);
      }
      return {
        mode: "custom",
        min,
        max,
        label: `${min ?? "不限"}-${max ?? "不限"}`
      };
    }
    return normalizeRecruitAgeFilter(label);
  }
  const text = normalizeText(value);
  if (!text) return null;
  const fixedLabel = normalizeAgeFixedLabel(text);
  if (fixedLabel) {
    return {
      mode: "option",
      label: fixedLabel,
      unlimited: fixedLabel === "不限"
    };
  }
  const customRange = parseAgeCustomRangeText(text);
  if (customRange || /^(?:自定义|custom)$/i.test(text)) {
    return normalizeRecruitAgeFilter({
      mode: "custom",
      min: customRange?.min ?? null,
      max: customRange?.max ?? null
    });
  }
  const customComparison = parseAgeCustomComparisonText(text);
  if (customComparison) {
    return normalizeRecruitAgeFilter({
      mode: "custom",
      min: customComparison.min,
      max: customComparison.max
    });
  }
  throw new Error(`Unsupported recruit age filter: ${text}`);
}

function pickRecruitExperienceSource(searchParams = {}) {
  if (Object.prototype.hasOwnProperty.call(searchParams, "experience")) return searchParams.experience;
  if (Object.prototype.hasOwnProperty.call(searchParams, "experiences")) return searchParams.experiences;
  if (Object.prototype.hasOwnProperty.call(searchParams, "experience_range")) return searchParams.experience_range;
  if (
    Object.prototype.hasOwnProperty.call(searchParams, "experience_start")
    || Object.prototype.hasOwnProperty.call(searchParams, "experience_end")
  ) {
    return {
      start: searchParams.experience_start,
      end: searchParams.experience_end
    };
  }
  return null;
}

function pickRecruitAgeSource(searchParams = {}) {
  if (Object.prototype.hasOwnProperty.call(searchParams, "age")) return searchParams.age;
  if (Object.prototype.hasOwnProperty.call(searchParams, "ages")) return searchParams.ages;
  if (Object.prototype.hasOwnProperty.call(searchParams, "age_range")) return searchParams.age_range;
  if (
    Object.prototype.hasOwnProperty.call(searchParams, "age_min")
    || Object.prototype.hasOwnProperty.call(searchParams, "age_max")
    || Object.prototype.hasOwnProperty.call(searchParams, "min_age")
    || Object.prototype.hasOwnProperty.call(searchParams, "max_age")
  ) {
    return {
      min: searchParams.age_min ?? searchParams.min_age,
      max: searchParams.age_max ?? searchParams.max_age
    };
  }
  return null;
}

export function normalizeRecruitSearchParams(searchParams = {}) {
  const degrees = normalizeRecruitDegreeLabels(searchParams.degrees || searchParams.degree || "不限");
  const experience = normalizeRecruitExperienceFilter(pickRecruitExperienceSource(searchParams));
  const gender = normalizeRecruitGenderFilter(searchParams.gender);
  const age = normalizeRecruitAgeFilter(pickRecruitAgeSource(searchParams));
  const normalized = {
    city: normalizeText(searchParams.city) || null,
    degree: degrees[0] || "不限",
    degrees,
    schools: normalizeRecruitSchoolList(searchParams.schools),
    keyword: normalizeText(searchParams.keyword) || DEFAULT_RECRUIT_KEYWORD,
    filter_recent_viewed: typeof searchParams.filter_recent_viewed === "boolean"
      ? searchParams.filter_recent_viewed
      : null,
    skip_recent_colleague_contacted: searchParams.skip_recent_colleague_contacted !== false
  };
  const job = normalizeText(searchParams.job || searchParams.job_title || searchParams.selected_job);
  if (job) normalized.job = job;
  if (experience) normalized.experience = experience;
  if (gender) normalized.gender = gender;
  if (age) normalized.age = age;
  return normalized;
}

export function buildRecruitSearchApplicationStepNames(searchParams = {}) {
  const normalized = normalizeRecruitSearchParams(searchParams);
  const steps = [];
  // Recruit search applies job first because job changes can reset other filters.
  if (normalized.job) steps.push("job_title");
  if (normalized.city) steps.push("city");
  steps.push("degree", "schools");
  if (normalized.experience) steps.push("experience");
  if (normalized.gender) steps.push("gender");
  if (normalized.age) steps.push("age");
  if (typeof normalized.filter_recent_viewed === "boolean") steps.push("recent_viewed");
  if (typeof normalized.skip_recent_colleague_contacted === "boolean") steps.push("exchange_resume");
  // Keyword is the final filter before executing the search.
  steps.push("keyword", "search");
  return steps;
}

export function hasRecruitSearchParams(searchParams = {}) {
  const degrees = normalizeRecruitDegreeLabels(searchParams.degrees || searchParams.degree || "不限");
  const job = normalizeText(searchParams.job || searchParams.job_title || searchParams.selected_job);
  const experience = normalizeRecruitExperienceFilter(pickRecruitExperienceSource(searchParams));
  const gender = normalizeRecruitGenderFilter(searchParams.gender);
  const age = normalizeRecruitAgeFilter(pickRecruitAgeSource(searchParams));
  const normalized = {
    city: normalizeText(searchParams.city) || null,
    degree: degrees[0] || "不限",
    degrees,
    schools: normalizeRecruitSchoolList(searchParams.schools),
    keyword: normalizeText(searchParams.keyword),
    filter_recent_viewed: typeof searchParams.filter_recent_viewed === "boolean"
      ? searchParams.filter_recent_viewed
      : null,
    skip_recent_colleague_contacted: searchParams.skip_recent_colleague_contacted !== false
  };
  return Boolean(
    job
    || normalized.city
    || normalized.degrees.some((degree) => degree && degree !== "不限")
    || normalized.schools.length
    || experience
    || gender
    || age
    || normalized.keyword
    || typeof normalized.filter_recent_viewed === "boolean"
    || typeof normalized.skip_recent_colleague_contacted === "boolean"
  );
}

function candidateIsActive(attributes = {}, outerHTML = "") {
  const className = attributes.class || "";
  const openingTag = String(outerHTML || "").split(">")[0] || "";
  return ACTIVE_CLASS_PATTERN.test(className)
    || ACTIVE_CLASS_PATTERN.test(openingTag)
    || /\bchecked(?:=["']?checked)?\b/i.test(openingTag);
}

function isVisibleBox(box) {
  return Boolean(box && box.rect.width > 4 && box.rect.height > 4);
}

async function readTextCandidate(client, nodeId, {
  selector = "",
  index = 0,
  includeBox = false
} = {}) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
  ]);
  let box = null;
  let boxError = "";
  if (includeBox) {
    try {
      box = await getNodeBox(client, nodeId);
    } catch (error) {
      boxError = error?.message || String(error);
    }
  }
  const text = normalizeText(htmlToText(outerHTML));
  return {
    node_id: nodeId,
    selector,
    index,
    label: normalizeRecruitSearchLabel(text),
    text,
    active: candidateIsActive(attributes, outerHTML),
    visible: includeBox ? isVisibleBox(box) : undefined,
    center: box?.center || null,
    rect: box?.rect || null,
    box_error: boxError || undefined,
    class_name: attributes.class || "",
    attributes
  };
}

async function listTextCandidates(client, rootNodeId, selectors = [], options = {}) {
  const candidates = [];
  const seen = new Set();
  for (const selector of selectors) {
    const nodeIds = uniqueNodeIds(await querySelectorAll(client, rootNodeId, selector));
    for (let index = 0; index < nodeIds.length; index += 1) {
      const nodeId = nodeIds[index];
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      candidates.push(await readTextCandidate(client, nodeId, { selector, index, ...options }));
    }
  }
  return candidates;
}

export function chooseRecruitTextCandidate(candidates = [], {
  label = "",
  match = "exact"
} = {}) {
  const target = normalizeRecruitSearchLabel(label);
  if (!target) return null;
  const byExact = candidates.find((candidate) => candidate.label === target);
  if (byExact) return byExact;
  if (match === "exact") return null;
  const byPrefix = candidates.find((candidate) => (
    candidate.label.startsWith(target)
    || target.startsWith(candidate.label)
  ));
  if (byPrefix) return byPrefix;
  if (match === "prefix") return null;
  return candidates.find((candidate) => candidate.label.includes(target) || target.includes(candidate.label)) || null;
}

function chooseRecruitSchoolCandidate(candidates = [], school) {
  const targetKeys = new Set(buildRecruitSchoolSearchLabels(school).map(normalizeRecruitSchoolCompareKey));
  if (!targetKeys.size) return null;
  return candidates.find((candidate) => targetKeys.has(normalizeRecruitSchoolCompareKey(candidate.text || candidate.label))) || null;
}

async function findTextCandidate(client, rootNodeId, selectors, label, options = {}) {
  const candidates = await listTextCandidates(client, rootNodeId, selectors);
  return {
    candidate: chooseRecruitTextCandidate(candidates, { label, ...options }),
    candidates
  };
}

function summarizeTextCandidates(candidates = [], limit = 20) {
  return candidates.map((item) => ({
    label: item.text,
    active: item.active,
    node_id: item.node_id,
    selector: item.selector
  })).slice(0, limit);
}

async function waitForRecruitTextCandidate(client, rootNodeId, selectors, label, {
  timeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS,
  intervalMs = 300,
  match = "exact"
} = {}) {
  const started = Date.now();
  let candidate = null;
  let candidates = [];
  while (Date.now() - started <= timeoutMs) {
    const found = await findTextCandidate(client, rootNodeId, selectors, label, { match });
    candidate = found.candidate;
    candidates = found.candidates;
    if (candidate) break;
    await sleep(intervalMs);
  }
  return {
    candidate,
    candidates,
    elapsed_ms: Date.now() - started
  };
}

async function waitForRecruitJobTitleCandidate(client, rootNodeId, selectors, jobTitle, {
  timeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS,
  intervalMs = 300
} = {}) {
  const terms = buildRecruitJobTitleSearchTerms(jobTitle);
  const started = Date.now();
  let candidate = null;
  let candidates = [];
  let matchedTerm = "";
  while (Date.now() - started <= timeoutMs) {
    candidates = await listTextCandidates(client, rootNodeId, selectors);
    for (const term of terms) {
      const found = chooseRecruitTextCandidate(candidates, { label: term, match: "contains" });
      if (found) {
        candidate = found;
        matchedTerm = term;
        break;
      }
    }
    if (candidate) break;
    await sleep(intervalMs);
  }
  return {
    candidate,
    candidates,
    matched_term: matchedTerm,
    search_terms: terms,
    elapsed_ms: Date.now() - started
  };
}

function compactRecruitTextCandidate(candidate = {}) {
  return {
    label: candidate.text || "",
    normalized_label: candidate.label || "",
    active: Boolean(candidate.active),
    visible: Boolean(candidate.visible),
    class_name: candidate.class_name || "",
    node_id: candidate.node_id,
    selector: candidate.selector,
    center: candidate.center || null,
    rect: candidate.rect || null,
    box_error: candidate.box_error || null
  };
}

async function listRecruitJobTitleOptions(client, frameNodeId) {
  const candidates = await listTextCandidates(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.jobTitleOption,
    { includeBox: true }
  );
  return candidates.filter((candidate) => candidate.text && candidate.text.length <= 160);
}

async function findVisibleRecruitJobTitleTrigger(client, frameNodeId) {
  const candidates = [];
  const seen = new Set();
  for (const selector of RECRUIT_SEARCH_SELECTORS.jobTitleTrigger) {
    const nodeIds = uniqueNodeIds(await querySelectorAll(client, frameNodeId, selector));
    for (const nodeId of nodeIds) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      let box = null;
      try {
        box = await getNodeBox(client, nodeId);
      } catch {}
      if (!isVisibleBox(box)) continue;
      candidates.push({
        selector,
        node_id: nodeId,
        center: box.center,
        rect: box.rect
      });
    }
  }
  return candidates[0] || null;
}

async function waitForVisibleRecruitJobTitleOptions(client, frameNodeId, {
  timeoutMs = 4000,
  intervalMs = 200
} = {}) {
  const started = Date.now();
  let options = [];
  while (Date.now() - started <= timeoutMs) {
    options = await listRecruitJobTitleOptions(client, frameNodeId);
    const visibleOptions = options.filter((option) => option.visible);
    if (visibleOptions.length) {
      return {
        options,
        visible_options: visibleOptions
      };
    }
    await sleep(intervalMs);
  }
  return {
    options,
    visible_options: []
  };
}

async function closeRecruitJobTitleDropdown(client, settleMs = 300) {
  if (typeof client?.Input?.dispatchKeyEvent !== "function") {
    return {
      ok: false,
      reason: "dispatch_key_unavailable"
    };
  }
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  if (settleMs > 0) await sleep(settleMs);
  return {
    ok: true,
    reason: "escape"
  };
}

async function openRecruitJobTitleDropdown(client, frameNodeId, {
  timeoutMs = 4000,
  maxAttempts = 3
} = {}) {
  const alreadyOpen = await waitForVisibleRecruitJobTitleOptions(client, frameNodeId, {
    timeoutMs: 300,
    intervalMs: 100
  });
  if (alreadyOpen.visible_options.length) {
    return {
      opened: true,
      already_open: true,
      options: alreadyOpen.options,
      visible_options: alreadyOpen.visible_options
    };
  }

  await closeRecruitJobTitleDropdown(client);
  const attempts = [];
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    const trigger = await findVisibleRecruitJobTitleTrigger(client, frameNodeId);
    if (!trigger) {
      throw new Error("Recruit job trigger was not found");
    }
    if (attempt > 1) await closeRecruitJobTitleDropdown(client);
    const clickBox = await clickNodeCenter(client, trigger.node_id, DETERMINISTIC_CLICK_OPTIONS);
    const opened = await waitForVisibleRecruitJobTitleOptions(client, frameNodeId, {
      timeoutMs,
      intervalMs: 200
    });
    attempts.push({
      attempt,
      trigger,
      click_box: {
        center: clickBox.center,
        rect: clickBox.rect
      },
      option_count: opened.options.length,
      visible_option_count: opened.visible_options.length
    });
    if (opened.visible_options.length) {
      return {
        opened: true,
        already_open: false,
        trigger,
        options: opened.options,
        visible_options: opened.visible_options,
        attempts
      };
    }
  }

  const error = new Error("Recruit job dropdown did not expose visible options after trigger click");
  error.job_dropdown_attempts = attempts;
  throw error;
}

async function closeRecruitJobTitleDropdownFully(client, frameNodeId, {
  settleMs = 300,
  timeoutMs = 1500
} = {}) {
  const before = await waitForVisibleRecruitJobTitleOptions(client, frameNodeId, {
    timeoutMs: 200,
    intervalMs: 100
  });
  const attempts = [];
  if (!before.visible_options.length) {
    return {
      ok: true,
      closed: false,
      reason: "already_closed",
      visible_before_count: 0,
      visible_after_count: 0,
      attempts
    };
  }

  const started = Date.now();
  for (let attempt = 1; attempt <= 2 && Date.now() - started <= timeoutMs; attempt += 1) {
    const close = await closeRecruitJobTitleDropdown(client, settleMs);
    const after = await waitForVisibleRecruitJobTitleOptions(client, frameNodeId, {
      timeoutMs: 250,
      intervalMs: 100
    });
    attempts.push({
      method: "escape",
      attempt,
      close,
      visible_after_count: after.visible_options.length
    });
    if (!after.visible_options.length) {
      return {
        ok: true,
        closed: true,
        reason: "escape",
        visible_before_count: before.visible_options.length,
        visible_after_count: 0,
        attempts
      };
    }
  }

  const trigger = await findVisibleRecruitJobTitleTrigger(client, frameNodeId).catch(() => null);
  if (trigger?.node_id) {
    const click = await clickNodeCenter(client, trigger.node_id, DETERMINISTIC_CLICK_OPTIONS).catch((error) => ({
      error: error?.message || String(error || "")
    }));
    if (settleMs > 0) await sleep(settleMs);
    const afterToggle = await waitForVisibleRecruitJobTitleOptions(client, frameNodeId, {
      timeoutMs: 250,
      intervalMs: 100
    });
    attempts.push({
      method: "trigger_toggle",
      click,
      visible_after_count: afterToggle.visible_options.length
    });
    if (!afterToggle.visible_options.length) {
      return {
        ok: true,
        closed: true,
        reason: "trigger_toggle",
        visible_before_count: before.visible_options.length,
        visible_after_count: 0,
        attempts
      };
    }
  }

  const outside = await clickPoint(client, 12, 12, DETERMINISTIC_CLICK_OPTIONS).catch((error) => ({
    error: error?.message || String(error || "")
  }));
  if (settleMs > 0) await sleep(settleMs);
  const afterOutside = await waitForVisibleRecruitJobTitleOptions(client, frameNodeId, {
    timeoutMs: 250,
    intervalMs: 100
  });
  attempts.push({
    method: "outside_click",
    click: outside,
    visible_after_count: afterOutside.visible_options.length
  });
  if (!afterOutside.visible_options.length) {
    return {
      ok: true,
      closed: true,
      reason: "outside_click",
      visible_before_count: before.visible_options.length,
      visible_after_count: 0,
      attempts
    };
  }

  return {
    ok: false,
    closed: false,
    reason: "still_visible_after_close_attempts",
    visible_before_count: before.visible_options.length,
    visible_after_count: afterOutside.visible_options.length,
    attempts
  };
}

async function verifyRecruitJobTitleSelection(client, frameNodeId, {
  jobTitle = "",
  delayMs = 1200,
  dropdownTimeoutMs = 4000
} = {}) {
  const requested = normalizeText(jobTitle);
  if (delayMs > 0) await sleep(delayMs);
  let options = [];
  let openError = null;
  try {
    const opened = await openRecruitJobTitleDropdown(client, frameNodeId, {
      timeoutMs: dropdownTimeoutMs
    });
    options = opened.options || [];
  } catch (error) {
    openError = error;
    options = await listRecruitJobTitleOptions(client, frameNodeId).catch(() => []);
  }
  const current = options.find((option) => option.active) || null;
  const searchTerms = buildRecruitJobTitleSearchTerms(requested);
  const verified = Boolean(
    current
    && searchTerms.some((term) => chooseRecruitTextCandidate([current], {
      label: term,
      match: "contains"
    }))
  );
  const menuClose = await closeRecruitJobTitleDropdownFully(client, frameNodeId).catch((error) => ({
    ok: false,
    closed: false,
    reason: "close_failed",
    error: error?.message || String(error)
  }));
  return {
    verified,
    requested,
    search_terms: searchTerms,
    current_label: current?.text || "",
    current_option: current ? compactRecruitTextCandidate(current) : null,
    option_count: options.length,
    visible_option_count: options.filter((option) => option.visible).length,
    options: options.map(compactRecruitTextCandidate),
    open_error: openError ? (openError?.message || String(openError)) : null,
    menu_close: menuClose
  };
}

async function clickFirstNodeBySelectors(client, rootNodeId, selectors, {
  optional = false,
  scrollIntoView = true
} = {}) {
  const errors = [];
  const seen = new Set();
  let matched = false;
  for (const selector of selectors) {
    const nodeIds = uniqueNodeIds(await querySelectorAll(client, rootNodeId, selector));
    for (const nodeId of nodeIds) {
      if (seen.has(nodeId)) continue;
      seen.add(nodeId);
      matched = true;
      try {
        const box = await clickNodeCenter(client, nodeId, {
          ...DETERMINISTIC_CLICK_OPTIONS,
          scrollIntoView
        });
        await sleep(250);
        return {
          clicked: true,
          selector,
          node_id: nodeId,
          box,
          skipped_errors: errors
        };
      } catch (error) {
        errors.push({
          selector,
          node_id: nodeId,
          error: error?.message || String(error)
        });
      }
    }
  }
  if (!matched) {
    if (optional) return { clicked: false, reason: "not_found" };
    throw new Error(`Recruit search node was not found for selectors: ${selectors.join(", ")}`);
  }
  if (optional) {
    return {
      clicked: false,
      reason: "not_clickable",
      errors
    };
  }
  const detail = errors.map((item) => `${item.selector}#${item.node_id}: ${item.error}`).join("; ");
  throw new Error(`Recruit search nodes were found but none were clickable for selectors: ${selectors.join(", ")}; ${detail}`);
}

async function dismissRecruitSearchOverlays(client, settleMs = 250) {
  if (typeof client?.Input?.dispatchKeyEvent !== "function") {
    return {
      method: "Escape",
      skipped: true,
      reason: "dispatch_key_unavailable"
    };
  }
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  if (settleMs > 0) await sleep(settleMs);
  return {
    method: "Escape",
    settle_ms: settleMs
  };
}

export async function getRecruitSearchCounts(client, frameNodeId) {
  return countSelectors(client, frameNodeId, {
    keyword_input: RECRUIT_SEARCH_SELECTORS.keywordInput.join(", "),
    search_button: RECRUIT_SEARCH_SELECTORS.searchButton.join(", "),
    degree_option: RECRUIT_SEARCH_SELECTORS.degreeOption.join(", "),
    school_item: RECRUIT_SEARCH_SELECTORS.schoolItem.join(", "),
    experience_option: RECRUIT_SEARCH_SELECTORS.experienceOption.join(", "),
    experience_custom: RECRUIT_SEARCH_SELECTORS.experienceCustom.join(", "),
    gender_dropdown: RECRUIT_SEARCH_SELECTORS.genderDropdown.join(", "),
    age_option: RECRUIT_SEARCH_SELECTORS.ageOption.join(", "),
    age_custom: RECRUIT_SEARCH_SELECTORS.ageCustom.join(", "),
    recent_viewed_label: RECRUIT_SEARCH_SELECTORS.recentViewedLabel.join(", "),
    candidate_card: RECRUIT_CARD_SELECTOR,
    no_data: RECRUIT_NO_DATA_SELECTORS.join(", ")
  });
}

export async function waitForRecruitSearchControls(client, {
  timeoutMs = DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    const roots = await getRecruitRoots(client, { requireFrame: false });
    const frameNodeId = roots.iframe?.documentNodeId;
    if (frameNodeId) {
      const counts = await getRecruitSearchCounts(client, frameNodeId);
      lastState = {
        ok: counts.keyword_input > 0 && counts.search_button > 0,
        elapsed_ms: Date.now() - started,
        iframe_selector: roots.iframe.selector,
        iframe_document_node_id: frameNodeId,
        counts
      };
      if (lastState.ok) return lastState;
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    ...(lastState || {})
  };
}

async function settleRecruitSearchAfterReset(client, {
  timeoutMs = DEFAULT_RECRUIT_RESET_TIMEOUT_MS,
  settleMs = 5000
} = {}) {
  return waitForMiniFreshStartSettle(client, {
    domain: "search",
    timeoutMs,
    intervalMs: 500,
    settleMs: Math.max(0, Math.min(settleMs || 0, 5000)),
    readinessLabel: "search_controls_ready",
    checkReady: ({ remainingMs }) => waitForRecruitSearchControls(client, {
      timeoutMs: Math.min(Math.max(1, remainingMs), 1500),
      intervalMs: 300
    })
  });
}

export async function resetRecruitSearchPage(client, {
  url = RECRUIT_TARGET_URL,
  settleMs = 5000,
  timeoutMs = DEFAULT_RECRUIT_RESET_TIMEOUT_MS
} = {}) {
  const actions = [];
  let miniFreshStart = null;
  const rootTimeoutMs = Math.min(timeoutMs, 90000);
  async function waitForRootsAfterSettle() {
    await sleep(settleMs);
    return waitForRecruitRoots(client, {
      timeoutMs: rootTimeoutMs,
      intervalMs: 300
    });
  }

  async function waitForControls() {
    return waitForRecruitSearchControls(client, {
      timeoutMs,
      intervalMs: 300
    });
  }

  if (typeof client?.Page?.reload === "function") {
    await client.Page.reload({ ignoreCache: true });
    actions.push({ method: "Page.reload" });
  } else {
    await client.Page.navigate({ url });
    actions.push({ method: "Page.navigate", url });
  }

  miniFreshStart = await settleRecruitSearchAfterReset(client, {
    timeoutMs: Math.min(timeoutMs, 90000),
    settleMs
  });
  actions.push({
    method: "mini_fresh_start_settle",
    ok: Boolean(miniFreshStart.ok),
    status: miniFreshStart.status || "",
    reason: miniFreshStart.reason || "",
    elapsed_ms: miniFreshStart.elapsed_ms || 0
  });
  if (!miniFreshStart.ok) {
    throw createRecoverySettleError("search", miniFreshStart);
  }

  let roots = await waitForRootsAfterSettle();
  const frameReset = await navigateRecruitSearchFrame(client, roots?.iframe?.nodeId, {
    pageUrl: url,
    reason: "reset_frame_after_page_reload"
  });
  if (frameReset) {
    actions.push(frameReset);
    await sleep(settleMs);
  }

  let controls = await waitForControls();
  if (!controls.ok && typeof client?.Page?.navigate === "function") {
    await client.Page.navigate({ url });
    actions.push({
      method: "Page.navigate",
      url,
      reason: roots?.iframe?.documentNodeId ? "controls_not_ready" : "iframe_not_ready"
    });
    roots = await waitForRootsAfterSettle();
    const fallbackFrameReset = await navigateRecruitSearchFrame(client, roots?.iframe?.nodeId, {
      pageUrl: url,
      reason: "reset_frame_after_page_navigate"
    });
    if (fallbackFrameReset) {
      actions.push(fallbackFrameReset);
      await sleep(settleMs);
    }
    miniFreshStart = await settleRecruitSearchAfterReset(client, {
      timeoutMs: Math.min(timeoutMs, 90000),
      settleMs: Math.min(settleMs, 1500)
    });
    actions.push({
      method: "mini_fresh_start_settle_after_navigate",
      ok: Boolean(miniFreshStart.ok),
      status: miniFreshStart.status || "",
      reason: miniFreshStart.reason || "",
      elapsed_ms: miniFreshStart.elapsed_ms || 0
    });
    if (!miniFreshStart.ok) {
      throw createRecoverySettleError("search", miniFreshStart);
    }
    controls = await waitForControls();
  }
  roots = await getRecruitRoots(client, { requireFrame: false });
  if (!controls.ok && !roots?.iframe?.documentNodeId) {
    throw new Error("Recruit search page reset did not expose searchFrame iframe");
  }
  if (!controls.ok) {
    throw new Error("Recruit search page reset exposed iframe but search controls were not ready");
  }
  return {
    actions,
    target_url: url,
    iframe_selector: controls.iframe_selector || roots.iframe.selector,
    iframe_document_node_id: controls.iframe_document_node_id || roots.iframe.documentNodeId,
    mini_fresh_start: miniFreshStart,
    controls
  };
}

export async function setRecruitKeyword(client, frameNodeId, keyword) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) {
    return { applied: false, reason: "empty_keyword" };
  }
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const input = await clickFirstNodeBySelectors(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.keywordInput);
    await clearFocusedInput(client);
    await sleep(120);
    const textEntry = await insertText(client, normalizedKeyword);
    await sleep(350);
    const verification = await verifyRecruitKeywordInputValue(client, frameNodeId, normalizedKeyword, {
      settleMs: 350
    });
    attempts.push({
      attempt,
      input,
      text_entry: textEntry,
      verification
    });
    if (verification.verified !== false) {
      return {
        applied: true,
        keyword: normalizedKeyword,
        input,
        text_entry: textEntry,
        verification,
        attempts
      };
    }
  }

  const last = attempts[attempts.length - 1]?.verification || {};
  throw new Error(`Recruit keyword input did not hold requested value: expected=${normalizedKeyword}; actual=${last.actual || "unknown"}`);
}

export async function readRecruitKeywordInputValue(client, frameNodeId) {
  if (typeof client?.Accessibility?.getPartialAXTree !== "function") {
    return {
      available: false,
      reason: "accessibility_unavailable",
      value: null,
      normalized_value: ""
    };
  }
  for (const selector of RECRUIT_SEARCH_SELECTORS.keywordInput) {
    const nodeIds = uniqueNodeIds(await querySelectorAll(client, frameNodeId, selector));
    for (const nodeId of nodeIds) {
      const ax = await client.Accessibility.getPartialAXTree({
        nodeId,
        fetchRelatives: false
      });
      const node = ax?.nodes?.[0] || null;
      if (!node) continue;
      const value = typeof node?.value?.value === "string" ? node.value.value : "";
      return {
        available: true,
        selector,
        node_id: nodeId,
        value,
        normalized_value: normalizeText(value),
        role: node?.role?.value || ""
      };
    }
  }
  return {
    available: false,
    reason: "keyword_input_not_found",
    value: null,
    normalized_value: ""
  };
}

export async function verifyRecruitKeywordInputValue(client, frameNodeId, expectedKeyword, {
  settleMs = 0
} = {}) {
  const expected = normalizeText(expectedKeyword);
  const before = await readRecruitKeywordInputValue(client, frameNodeId);
  if (!before.available || !expected) {
    return {
      verified: null,
      reason: before.reason || "empty_expected_keyword",
      expected,
      actual: before.normalized_value || "",
      before,
      after: before
    };
  }
  let after = before;
  if (settleMs > 0) {
    await sleep(settleMs);
    after = await readRecruitKeywordInputValue(client, frameNodeId);
  }
  const actual = normalizeText(after.normalized_value || after.value);
  return {
    verified: actual === expected,
    expected,
    actual,
    before,
    after
  };
}

export async function selectRecruitDefaultJobTitle(client, frameNodeId) {
  return clickFirstNodeBySelectors(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.jobTitleOption, {
    optional: true
  });
}

export async function setRecruitJobTitle(client, frameNodeId, jobTitle, {
  optionTimeoutMs = DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS
} = {}) {
  const normalizedJobTitle = normalizeText(jobTitle);
  if (!normalizedJobTitle) {
    return { applied: false, reason: "empty_job_title" };
  }
  const opened = await openRecruitJobTitleDropdown(client, frameNodeId, {
    timeoutMs: Math.min(optionTimeoutMs, 30000)
  });
  const options = opened.options.length
    ? opened.options
    : await listRecruitJobTitleOptions(client, frameNodeId);
  const terms = buildRecruitJobTitleSearchTerms(normalizedJobTitle);
  let match = null;
  let matchedTerm = "";
  const visibleOptions = options.filter((option) => option.visible);
  const hiddenMatches = [];
  for (const term of terms) {
    match = chooseRecruitTextCandidate(visibleOptions, { label: term, match: "contains" });
    if (match) {
      matchedTerm = term;
      break;
    }
    const hiddenMatch = chooseRecruitTextCandidate(
      options.filter((option) => !option.visible),
      { label: term, match: "contains" }
    );
    if (hiddenMatch) hiddenMatches.push(hiddenMatch);
  }
  if (!match) {
    await closeRecruitJobTitleDropdown(client);
    if (hiddenMatches.length) {
      const error = new Error(`Matched recruit job has no visible clickable option: ${hiddenMatches[0].text}`);
      error.hidden_job_matches = hiddenMatches.map(compactRecruitTextCandidate);
      throw error;
    }
    throw new Error(`Recruit job title option was not found: ${normalizedJobTitle}`);
  }
  let box = null;
  if (!match.active) {
    if (!match.center) {
      await closeRecruitJobTitleDropdown(client);
      throw new Error(`Matched recruit job has no clickable center: ${match.text}`);
    }
    box = await clickNodeCenter(client, match.node_id, {
      ...DETERMINISTIC_CLICK_OPTIONS,
      scrollIntoView: true
    });
    await sleep(500);
  }
  const stickyVerification = await verifyRecruitJobTitleSelection(client, frameNodeId, {
    jobTitle: normalizedJobTitle,
    delayMs: 1200,
    dropdownTimeoutMs: Math.min(optionTimeoutMs, 5000)
  });
  if (!stickyVerification.verified) {
    throw new Error(`Recruit job selection was not sticky after 1.2s: requested=${normalizedJobTitle}; current=${stickyVerification.current_label || "unknown"}`);
  }
  if (stickyVerification.menu_close && stickyVerification.menu_close.ok === false) {
    throw new Error(`Recruit job dropdown remained open after sticky verification: ${stickyVerification.menu_close.reason || "unknown"}`);
  }
  return {
    applied: true,
    requested_job: normalizedJobTitle,
    selected_label: match.text,
    matched_term: matchedTerm,
    search_terms: terms,
    selected_node_id: match.node_id,
    was_active: match.active,
    clicked: !match.active,
    box,
    opened_dropdown: {
      already_open: Boolean(opened.already_open),
      visible_option_count: visibleOptions.length,
      attempts: opened.attempts || []
    },
    sticky_verification: stickyVerification,
    discovered_options: options.map(compactRecruitTextCandidate).slice(0, 30)
  };
}

export async function setRecruitDegree(client, frameNodeId, degree) {
  const degreeLabel = resolveRecruitDegreeLabel(degree);
  if (!degreeLabel || degreeLabel === "不限") {
    return { applied: false, reason: "unlimited_degree", degree: degreeLabel || "不限" };
  }
  const { candidate, candidates } = await findTextCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.degreeOption,
    degreeLabel,
    { match: "prefix" }
  );
  if (!candidate) {
    throw new Error(`Recruit degree option was not found: ${degreeLabel}`);
  }
  const box = await clickNodeCenter(client, candidate.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(350);
  return {
    applied: true,
    requested_degree: degree,
    selected_label: candidate.text,
    selected_node_id: candidate.node_id,
    was_active: candidate.active,
    box,
    discovered_options: candidates.map((item) => ({
      label: item.text,
      active: item.active,
      node_id: item.node_id,
      selector: item.selector
    }))
  };
}

export async function setRecruitDegrees(client, frameNodeId, degrees = []) {
  const labels = normalizeRecruitDegreeLabels(degrees).filter((label) => label && label !== "不限");
  if (!labels.length) {
    return { applied: false, reason: "unlimited_degree", degrees: ["不限"], selected: [] };
  }

  const selected = [];
  let discoveredOptions = [];
  for (const label of labels) {
    const { candidate, candidates } = await findTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.degreeOption,
      label,
      { match: "prefix" }
    );
    discoveredOptions = candidates.map((item) => ({
      label: item.text,
      active: item.active,
      node_id: item.node_id,
      selector: item.selector
    }));
    if (!candidate) {
      throw new Error(`Recruit degree option was not found: ${label}`);
    }

    let box = null;
    if (!candidate.active) {
      box = await clickNodeCenter(client, candidate.node_id, {
        ...DETERMINISTIC_CLICK_OPTIONS,
        scrollIntoView: true
      });
      await sleep(350);
    }
    selected.push({
      requested_degree: label,
      selected_label: candidate.text,
      selected_node_id: candidate.node_id,
      was_active: candidate.active,
      clicked: !candidate.active,
      box
    });
  }

  return {
    applied: true,
    requested_degrees: labels,
    selected,
    discovered_options: discoveredOptions
  };
}

async function findClickableDescendant(client, nodeId, selectors) {
  for (const selector of selectors) {
    const childNodeId = await querySelector(client, nodeId, selector);
    if (childNodeId) return { node_id: childNodeId, selector };
  }
  return { node_id: nodeId, selector: null };
}

export async function setRecruitSchools(client, frameNodeId, schools = []) {
  const targets = normalizeRecruitSchoolList(schools);
  const applied = [];
  const missing = [];
  if (!targets.length) {
    return { applied: false, schools: [], selected: [], missing: [] };
  }

  for (const school of targets) {
    const candidates = await listTextCandidates(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.schoolItem);
    const candidate = chooseRecruitSchoolCandidate(candidates, school);
    if (!candidate) {
      missing.push({
        school,
        exact_labels: buildRecruitSchoolSearchLabels(school),
        discovered: candidates.map((item) => item.text).slice(0, 20)
      });
      continue;
    }

    const clickable = await findClickableDescendant(client, candidate.node_id, RECRUIT_SEARCH_SELECTORS.schoolClickable);
    let clickableActive = candidate.active;
    if (clickable.node_id !== candidate.node_id) {
      const clickableCandidate = await readTextCandidate(client, clickable.node_id, {
        selector: clickable.selector || "",
        index: 0
      });
      clickableActive = clickableActive || clickableCandidate.active;
    }

    let box = null;
    if (!clickableActive) {
      box = await clickNodeCenter(client, clickable.node_id, {
        ...DETERMINISTIC_CLICK_OPTIONS,
        scrollIntoView: true
      });
      await sleep(350);
    }

    applied.push({
      school,
      exact_labels: buildRecruitSchoolSearchLabels(school),
      selected_label: candidate.text,
      selected_node_id: candidate.node_id,
      clickable_node_id: clickable.node_id,
      clickable_selector: clickable.selector,
      was_active: clickableActive,
      clicked: !clickableActive,
      box
    });
  }

  if (missing.length) {
    throw new Error(`Recruit school options were not found: ${missing.map((item) => item.school).join(", ")}`);
  }

  return {
    applied: true,
    schools: targets,
    selected: applied,
    missing
  };
}

async function findFirstRecruitSearchNode(client, rootNodeId, selectors = []) {
  const errors = [];
  for (const selector of selectors) {
    const nodeIds = uniqueNodeIds(await querySelectorAll(client, rootNodeId, selector));
    for (const nodeId of nodeIds) {
      try {
        const box = await getNodeBox(client, nodeId);
        if (!isVisibleBox(box)) continue;
        return { node_id: nodeId, selector, box };
      } catch (error) {
        errors.push({
          selector,
          node_id: nodeId,
          error: error?.message || String(error)
        });
      }
    }
  }
  return { node_id: 0, selector: "", box: null, errors };
}

function parseRecruitExperienceHiddenValue(rawValue) {
  const [startRaw, endRaw] = String(rawValue || "").split(",");
  const startValue = Number.parseInt(startRaw, 10);
  const endValue = Number.parseInt(endRaw, 10);
  return {
    raw_value: String(rawValue || ""),
    start_value: Number.isFinite(startValue) ? startValue : null,
    end_value: Number.isFinite(endValue) ? endValue : null
  };
}

async function readRecruitExperienceCustomState(client, frameNodeId) {
  let hidden = null;
  for (const selector of RECRUIT_SEARCH_SELECTORS.experienceCustomHiddenInput) {
    const nodeId = await querySelector(client, frameNodeId, selector);
    if (!nodeId) continue;
    const attributes = await getAttributesMap(client, nodeId);
    hidden = {
      node_id: nodeId,
      selector,
      value: attributes.value || ""
    };
    break;
  }
  const parsedHidden = parseRecruitExperienceHiddenValue(hidden?.value || "");
  const handleNodes = [];
  for (const selector of RECRUIT_SEARCH_SELECTORS.experienceCustomSliderHandle) {
    const nodeIds = uniqueNodeIds(await querySelectorAll(client, frameNodeId, selector));
    for (const nodeId of nodeIds) {
      if (handleNodes.some((item) => item.node_id === nodeId)) continue;
      try {
        const box = await getNodeBox(client, nodeId);
        if (!isVisibleBox(box)) continue;
        handleNodes.push({ node_id: nodeId, selector, box });
      } catch {
        // Ignore invisible handles; missing handles are reported by the caller.
      }
    }
  }
  handleNodes.sort((left, right) => left.box.center.x - right.box.center.x);
  return {
    hidden,
    ...parsedHidden,
    handles: handleNodes.map((item, index) => ({
      index,
      node_id: item.node_id,
      selector: item.selector,
      center: item.box.center,
      rect: item.box.rect
    }))
  };
}

async function readRecruitExperienceFixedOptionState(client, frameNodeId) {
  const candidates = await listTextCandidates(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.experienceOption);
  return {
    active_labels: candidates.filter((item) => item.active).map((item) => item.text),
    options: summarizeTextCandidates(candidates, 20)
  };
}

async function dragRecruitExperienceSliderHandle(client, frameNodeId, {
  handleIndex,
  targetValue
}) {
  const state = await readRecruitExperienceCustomState(client, frameNodeId);
  const handle = state.handles[handleIndex];
  if (!handle) {
    throw new Error(`Recruit experience custom slider handle was not found: index=${handleIndex}`);
  }
  const slider = await findFirstRecruitSearchNode(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.experienceCustomSlider
  );
  let trackRect = slider.box?.rect || null;
  if (!trackRect && state.handles.length >= 2 && state.start_value !== null && state.end_value !== null && state.end_value !== state.start_value) {
    const leftHandle = state.handles[0];
    const rightHandle = state.handles[state.handles.length - 1];
    const valueSpan = state.end_value - state.start_value;
    const fullValueSpan = EXPERIENCE_CUSTOM_MAX_VALUE - EXPERIENCE_CUSTOM_MIN_VALUE;
    const inferredWidth = Math.abs(rightHandle.center.x - leftHandle.center.x) * (fullValueSpan / valueSpan);
    const inferredX = leftHandle.center.x - inferredWidth * ((state.start_value - EXPERIENCE_CUSTOM_MIN_VALUE) / fullValueSpan);
    trackRect = {
      x: inferredX,
      y: Math.min(leftHandle.rect.y, rightHandle.rect.y),
      width: inferredWidth,
      height: Math.max(leftHandle.rect.height, rightHandle.rect.height)
    };
  }
  if (!trackRect) {
    throw new Error("Recruit experience custom slider was not found");
  }
  const percent = (targetValue - EXPERIENCE_CUSTOM_MIN_VALUE)
    / (EXPERIENCE_CUSTOM_MAX_VALUE - EXPERIENCE_CUSTOM_MIN_VALUE);
  let targetX = trackRect.x + trackRect.width * Math.min(1, Math.max(0, percent));
  const endpointOvershootPx = Math.min(24, Math.max(8, trackRect.width * 0.04));
  const valueStepPx = trackRect.width / (EXPERIENCE_CUSTOM_MAX_VALUE - EXPERIENCE_CUSTOM_MIN_VALUE);
  if (targetValue > EXPERIENCE_CUSTOM_MIN_VALUE && targetValue < EXPERIENCE_CUSTOM_MAX_VALUE) {
    targetX += valueStepPx * 0.45;
  }
  if (targetValue === EXPERIENCE_CUSTOM_MIN_VALUE) targetX -= endpointOvershootPx;
  if (targetValue === EXPERIENCE_CUSTOM_MAX_VALUE) targetX += endpointOvershootPx;
  const targetY = handle.center.y || (trackRect.y + trackRect.height / 2);
  const startX = handle.center.x;
  const startY = handle.center.y;
  const steps = 8;
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: startX, y: startY, button: "none" });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: startX, y: startY, button: "left", clickCount: 1 });
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    await client.Input.dispatchMouseEvent({
      type: "mouseMoved",
      x: startX + (targetX - startX) * ratio,
      y: startY + (targetY - startY) * ratio,
      button: "left"
    });
    await sleep(30);
  }
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: targetX, y: targetY, button: "left", clickCount: 1 });
  await sleep(350);
  return {
    handle_index: handleIndex,
    target_value: targetValue,
    target_label: EXPERIENCE_CUSTOM_LABELS_BY_VALUE.get(targetValue) || String(targetValue),
    slider_node_id: slider.node_id || null,
    handle_node_id: handle.node_id,
    start: { x: startX, y: startY },
    target: { x: targetX, y: targetY },
    track: trackRect,
    inferred_track: !slider.box
  };
}

async function nudgeRecruitExperienceCustomSelection(client, frameNodeId, filter) {
  if (filter.end_value > filter.start_value) {
    const intermediate = filter.end_value === EXPERIENCE_CUSTOM_MAX_VALUE
      ? filter.end_value - 1
      : filter.end_value + 1;
    return [
      await dragRecruitExperienceSliderHandle(client, frameNodeId, {
        handleIndex: 1,
        targetValue: intermediate
      }),
      await dragRecruitExperienceSliderHandle(client, frameNodeId, {
        handleIndex: 1,
        targetValue: filter.end_value
      })
    ];
  }
  const intermediate = filter.start_value === EXPERIENCE_CUSTOM_MIN_VALUE
    ? filter.start_value + 1
    : filter.start_value - 1;
  return [
    await dragRecruitExperienceSliderHandle(client, frameNodeId, {
      handleIndex: 0,
      targetValue: intermediate
    }),
    await dragRecruitExperienceSliderHandle(client, frameNodeId, {
      handleIndex: 0,
      targetValue: filter.start_value
    })
  ];
}

export async function setRecruitExperience(client, frameNodeId, experience) {
  const filter = normalizeRecruitExperienceFilter(experience);
  if (!filter) {
    return { applied: false, reason: "not_requested" };
  }

  if (filter.mode === "option") {
    const { candidate, candidates } = await findTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.experienceOption,
      filter.label,
      { match: "exact" }
    );
    if (!candidate) {
      throw new Error(`Recruit experience option was not found: ${filter.label}`);
    }
    let box = null;
    if (!candidate.active) {
      box = await clickNodeCenter(client, candidate.node_id, {
        ...DETERMINISTIC_CLICK_OPTIONS,
        scrollIntoView: true
      });
      await sleep(500);
    }
    return {
      applied: true,
      mode: "option",
      requested_experience: experience,
      selected_label: candidate.text,
      selected_node_id: candidate.node_id,
      was_active: candidate.active,
      clicked: !candidate.active,
      box,
      discovered_options: summarizeTextCandidates(candidates, 20)
    };
  }

  const customClick = await clickFirstNodeBySelectors(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.experienceCustom,
    { optional: false, scrollIntoView: true }
  );
  const before = await readRecruitExperienceCustomState(client, frameNodeId);
  const fixedOptionsBefore = await readRecruitExperienceFixedOptionState(client, frameNodeId);
  const drags = [];
  if (before.start_value !== filter.start_value) {
    drags.push(await dragRecruitExperienceSliderHandle(client, frameNodeId, {
      handleIndex: 0,
      targetValue: filter.start_value
    }));
  }
  const afterStart = await readRecruitExperienceCustomState(client, frameNodeId);
  if (afterStart.end_value !== filter.end_value) {
    drags.push(await dragRecruitExperienceSliderHandle(client, frameNodeId, {
      handleIndex: 1,
      targetValue: filter.end_value
    }));
  }
  if (!drags.length && fixedOptionsBefore.active_labels.length) {
    drags.push(...await nudgeRecruitExperienceCustomSelection(client, frameNodeId, filter));
  }
  const after = await readRecruitExperienceCustomState(client, frameNodeId);
  const fixedOptionsAfter = await readRecruitExperienceFixedOptionState(client, frameNodeId);
  const verified = after.start_value === filter.start_value && after.end_value === filter.end_value;
  if (!verified) {
    throw new Error(
      `Recruit experience custom range did not stick: requested=${filter.start_value},${filter.end_value}; actual=${after.raw_value || "unknown"}`
    );
  }
  if (fixedOptionsAfter.active_labels.length) {
    throw new Error(
      `Recruit experience custom range still has fixed option active: ${fixedOptionsAfter.active_labels.join(", ")}`
    );
  }
  return {
    applied: true,
    mode: "custom",
    requested_experience: experience,
    requested_range: {
      start_label: filter.start_label,
      end_label: filter.end_label,
      start_value: filter.start_value,
      end_value: filter.end_value
    },
    custom_click: customClick,
    fixed_options_before: fixedOptionsBefore,
    before,
    after,
    fixed_options_after: fixedOptionsAfter,
    drags,
    verification: {
      verified,
      fixed_option_cleared: fixedOptionsAfter.active_labels.length === 0,
      expected: `${filter.start_value},${filter.end_value}`,
      actual: after.raw_value
    }
  };
}

async function findRecruitGenderDropdown(client, frameNodeId) {
  const candidates = await listTextCandidates(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.genderDropdown, {
    includeBox: true
  });
  const visible = candidates
    .filter((item) => item.visible && item.rect)
    .sort((left, right) => left.rect.x - right.rect.x);
  return {
    candidate: visible[0] || null,
    candidates
  };
}

async function readRecruitGenderState(client, frameNodeId) {
  const { candidate, candidates } = await findRecruitGenderDropdown(client, frameNodeId);
  if (!candidate) {
    return {
      available: false,
      discovered: summarizeTextCandidates(candidates, 10)
    };
  }
  const hiddenNodeId = await querySelector(client, candidate.node_id, "input[type='hidden']");
  const hidden = hiddenNodeId ? await getAttributesMap(client, hiddenNodeId) : {};
  const hiddenSelectedLabel = hidden.value === "-1" ? "不限" : "";
  return {
    available: true,
    selected_label: hiddenSelectedLabel || normalizeText(candidate.text),
    selected_node_id: candidate.node_id,
    hidden_value: hidden.value || "",
    discovered: summarizeTextCandidates(candidates, 10)
  };
}

export async function setRecruitGender(client, frameNodeId, gender) {
  const filter = normalizeRecruitGenderFilter(gender);
  if (!filter) {
    return { applied: false, reason: "not_requested" };
  }
  const beforeRoot = await findRecruitGenderDropdown(client, frameNodeId);
  if (!beforeRoot.candidate) {
    throw new Error("Recruit gender dropdown was not found");
  }
  const openBox = await clickNodeCenter(client, beforeRoot.candidate.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(350);
  const rootAfterOpen = await findRecruitGenderDropdown(client, frameNodeId);
  const rootNodeId = rootAfterOpen.candidate?.node_id || beforeRoot.candidate.node_id;
  const options = await listTextCandidates(client, rootNodeId, ["li"], { includeBox: true });
  const option = chooseRecruitTextCandidate(options, { label: filter.label, match: "exact" });
  if (!option) {
    throw new Error(`Recruit gender option was not found: ${filter.label}`);
  }
  let selectBox = null;
  if (!option.active) {
    selectBox = await clickNodeCenter(client, option.node_id, {
      ...DETERMINISTIC_CLICK_OPTIONS,
      scrollIntoView: true
    });
    await sleep(600);
  } else {
    await pressKey(client, "Escape", {
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27
    });
    await sleep(250);
  }
  const after = await readRecruitGenderState(client, frameNodeId);
  const verified = after.selected_label === filter.label
    || (filter.label === "不限" && /^(?:性别|不限)$/.test(after.selected_label));
  if (!verified) {
    throw new Error(`Recruit gender selection did not stick: requested=${filter.label}; actual=${after.selected_label || "unknown"}`);
  }
  return {
    applied: true,
    requested_gender: gender,
    selected_label: filter.label,
    opened_dropdown: {
      node_id: beforeRoot.candidate.node_id,
      box: openBox
    },
    selected_node_id: option.node_id,
    option_was_active: option.active,
    clicked: !option.active,
    box: selectBox,
    verification: {
      verified,
      selected_label: after.selected_label,
      hidden_value: after.hidden_value
    },
    discovered_options: summarizeTextCandidates(options, 10)
  };
}

async function readRecruitAgeCustomState(client, frameNodeId) {
  const inputNodeIds = uniqueNodeIds(await querySelectorAll(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.ageCustomInput.join(", ")
  ));
  const inputs = [];
  for (const nodeId of inputNodeIds) {
    const attributes = await getAttributesMap(client, nodeId);
    let box = null;
    try {
      box = await getNodeBox(client, nodeId);
    } catch {}
    inputs.push({
      node_id: nodeId,
      type: attributes.type || "",
      value: attributes.value || "",
      placeholder: attributes.placeholder || "",
      visible: isVisibleBox(box),
      rect: box?.rect || null
    });
  }
  const hidden = inputs.filter((item) => item.type === "hidden");
  return {
    inputs,
    min: parseRecruitAgeCustomHiddenValue(hidden[0]?.value),
    max: parseRecruitAgeCustomHiddenValue(hidden[1]?.value),
    raw_values: hidden.map((item) => item.value)
  };
}

async function readRecruitAgeFixedOptionState(client, frameNodeId) {
  const candidates = await listTextCandidates(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.ageOption);
  return {
    active_labels: candidates.filter((item) => item.active).map((item) => item.text),
    options: summarizeTextCandidates(candidates, 20)
  };
}

function ageCustomOptionLabel(value) {
  if (value === null || value === undefined) return "不限";
  return `${value}岁`;
}

function parseRecruitAgeCustomHiddenValue(value) {
  const text = normalizeText(value);
  if (!text || text === "0" || text === "-1") return null;
  return parseAgeNumber(text, null);
}

async function selectRecruitAgeCustomDropdownValue(client, frameNodeId, {
  dropdownIndex,
  value
}) {
  const dropdownNodeIds = uniqueNodeIds(await querySelectorAll(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.ageCustomDropdown.join(", ")
  ));
  const dropdownNodeId = dropdownNodeIds[dropdownIndex];
  if (!dropdownNodeId) {
    throw new Error(`Recruit age custom dropdown was not found: index=${dropdownIndex}`);
  }
  const openBox = await clickNodeCenter(client, dropdownNodeId, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(350);
  const label = ageCustomOptionLabel(value);
  const options = await listTextCandidates(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.ageCustomOption, {
    includeBox: true
  });
  const option = chooseRecruitTextCandidate(options, { label, match: "exact" });
  if (!option) {
    throw new Error(`Recruit age custom option was not found: ${label}`);
  }
  const box = await clickNodeCenter(client, option.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(600);
  return {
    dropdown_index: dropdownIndex,
    requested_value: value,
    selected_label: option.text,
    dropdown_node_id: dropdownNodeId,
    option_node_id: option.node_id,
    open_box: openBox,
    box,
    discovered_options: summarizeTextCandidates(options, 40)
  };
}

export async function setRecruitAge(client, frameNodeId, age) {
  const filter = normalizeRecruitAgeFilter(age);
  if (!filter) {
    return { applied: false, reason: "not_requested" };
  }

  if (filter.mode === "option") {
    const { candidate, candidates } = await findTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.ageOption,
      filter.label,
      { match: "exact" }
    );
    if (!candidate) {
      throw new Error(`Recruit age option was not found: ${filter.label}`);
    }
    let box = null;
    if (!candidate.active) {
      box = await clickNodeCenter(client, candidate.node_id, {
        ...DETERMINISTIC_CLICK_OPTIONS,
        scrollIntoView: true
      });
      await sleep(500);
    }
    return {
      applied: true,
      mode: "option",
      requested_age: age,
      selected_label: candidate.text,
      selected_node_id: candidate.node_id,
      was_active: candidate.active,
      clicked: !candidate.active,
      box,
      discovered_options: summarizeTextCandidates(candidates, 20)
    };
  }

  const customClick = await clickFirstNodeBySelectors(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.ageCustom,
    { optional: false, scrollIntoView: true }
  );
  const before = await readRecruitAgeCustomState(client, frameNodeId);
  const fixedBefore = await readRecruitAgeFixedOptionState(client, frameNodeId);
  const selected = [];
  selected.push(await selectRecruitAgeCustomDropdownValue(client, frameNodeId, {
    dropdownIndex: 0,
    value: filter.min
  }));
  selected.push(await selectRecruitAgeCustomDropdownValue(client, frameNodeId, {
    dropdownIndex: 1,
    value: filter.max
  }));
  const after = await readRecruitAgeCustomState(client, frameNodeId);
  const fixedAfter = await readRecruitAgeFixedOptionState(client, frameNodeId);
  const verified = after.min === filter.min && after.max === filter.max;
  if (!verified) {
    throw new Error(`Recruit age custom values did not stick: requested=${filter.min},${filter.max}; actual=${after.raw_values.join(",")}`);
  }
  if (fixedAfter.active_labels.length) {
    throw new Error(`Recruit age custom still has fixed option active: ${fixedAfter.active_labels.join(", ")}`);
  }
  return {
    applied: true,
    mode: "custom",
    requested_age: age,
    requested_range: {
      min: filter.min,
      max: filter.max
    },
    custom_click: customClick,
    before,
    after,
    fixed_options_before: fixedBefore,
    fixed_options_after: fixedAfter,
    selected,
    verification: {
      verified,
      fixed_option_cleared: fixedAfter.active_labels.length === 0,
      expected: [filter.min, filter.max],
      actual: [after.min, after.max]
    }
  };
}

async function setRecruitCheckboxFilter(client, frameNodeId, enabled, {
  selectors,
  label,
  errorLabel
} = {}) {
  if (typeof enabled !== "boolean") {
    return { applied: false, reason: "not_requested" };
  }
  const { candidate, candidates } = await findTextCandidate(
    client,
    frameNodeId,
    selectors,
    label,
    { match: "contains" }
  );
  if (!candidate) {
    throw new Error(`${errorLabel || "Recruit checkbox filter"} was not found`);
  }

  let box = null;
  if (candidate.active !== enabled) {
    box = await clickNodeCenter(client, candidate.node_id, {
      ...DETERMINISTIC_CLICK_OPTIONS,
      scrollIntoView: true
    });
    await sleep(900);
  }

  return {
    applied: true,
    requested: enabled,
    was_active: candidate.active,
    changed: candidate.active !== enabled,
    selected_label: candidate.text,
    selected_node_id: candidate.node_id,
    box,
    discovered_options: candidates.map((item) => ({
      label: item.text,
      active: item.active,
      node_id: item.node_id,
      selector: item.selector
    }))
  };
}

export async function setRecruitRecentViewedFilter(client, frameNodeId, enabled) {
  return setRecruitCheckboxFilter(client, frameNodeId, enabled, {
    selectors: RECRUIT_SEARCH_SELECTORS.recentViewedLabel,
    label: "过滤近14天查看",
    errorLabel: "Recruit recent-viewed filter"
  });
}

export async function setRecruitExchangeResumeFilter(client, frameNodeId, enabled) {
  return setRecruitCheckboxFilter(client, frameNodeId, enabled, {
    selectors: RECRUIT_SEARCH_SELECTORS.exchangeResumeLabel,
    label: "近30天未和同事交换简历",
    errorLabel: "Recruit exchange-resume filter"
  });
}

async function openRecruitCityPicker(client, frameNodeId, {
  settleMs = 350
} = {}) {
  const alreadyOpenInput = await clickFirstNodeBySelectors(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.cityInput,
    { optional: true }
  );
  if (alreadyOpenInput.clicked) {
    return {
      opened: true,
      already_open: true,
      input: alreadyOpenInput,
      trigger: null
    };
  }

  const trigger = await clickFirstNodeBySelectors(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.cityTrigger,
    { scrollIntoView: false }
  );
  if (settleMs > 0) await sleep(settleMs);
  const input = await clickFirstNodeBySelectors(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.cityInput
  );
  return {
    opened: true,
    already_open: false,
    trigger,
    input
  };
}

async function selectRecruitNationalCityThroughPicker(client, frameNodeId, {
  requestedCity = "全国",
  reason = "national_city_requested",
  optionTimeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS
} = {}) {
  const picker = await openRecruitCityPicker(client, frameNodeId);
  await clearFocusedInput(client);
  await sleep(500);

  const path = [];
  const categoryLookup = await waitForRecruitTextCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.citySearchResult,
    "城市",
    { match: "exact", timeoutMs: Math.min(optionTimeoutMs, 6000) }
  );
  if (categoryLookup.candidate) {
    const box = await clickNodeCenter(client, categoryLookup.candidate.node_id, {
      ...DETERMINISTIC_CLICK_OPTIONS,
      scrollIntoView: true
    });
    await sleep(400);
    path.push({
      label: "城市",
      selected_label: categoryLookup.candidate.text,
      node_id: categoryLookup.candidate.node_id,
      box
    });
  } else {
    path.push({
      label: "城市",
      skipped: true,
      reason: "not_found_or_already_expanded",
      discovered_options: summarizeTextCandidates(categoryLookup.candidates)
    });
  }

  let popularLookup = await waitForRecruitTextCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.cityProvinceItem,
    "热门",
    { match: "exact", timeoutMs: optionTimeoutMs }
  );
  if (!popularLookup.candidate) {
    popularLookup = await waitForRecruitTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.citySearchResult,
      "热门",
      { match: "exact", timeoutMs: Math.min(optionTimeoutMs, 6000) }
    );
  }
  if (!popularLookup.candidate) {
    return {
      applied: false,
      reason: "national_city_popular_not_found",
      requested_city: requestedCity,
      input: picker.input,
      picker,
      path,
      discovered_options: summarizeTextCandidates(popularLookup.candidates)
    };
  }
  const popularBox = await clickNodeCenter(client, popularLookup.candidate.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(400);
  path.push({
    label: "热门",
    selected_label: popularLookup.candidate.text,
    node_id: popularLookup.candidate.node_id,
    box: popularBox
  });

  let nationalLookup = await waitForRecruitTextCandidate(
    client,
    frameNodeId,
    RECRUIT_SEARCH_SELECTORS.cityDropdownItem,
    "全国",
    { match: "exact", timeoutMs: optionTimeoutMs }
  );
  if (!nationalLookup.candidate) {
    nationalLookup = await waitForRecruitTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.citySearchResult,
      "全国",
      { match: "exact", timeoutMs: Math.min(optionTimeoutMs, 6000) }
    );
  }
  if (!nationalLookup.candidate) {
    return {
      applied: false,
      reason: "national_city_option_not_found",
      requested_city: requestedCity,
      input: picker.input,
      picker,
      path,
      discovered_options: summarizeTextCandidates(nationalLookup.candidates)
    };
  }

  const nationalBox = await clickNodeCenter(client, nationalLookup.candidate.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(700);
  path.push({
    label: "全国",
    selected_label: nationalLookup.candidate.text,
    node_id: nationalLookup.candidate.node_id,
    box: nationalBox
  });

  return {
    applied: true,
    reason,
    city: "全国",
    requested_city: requestedCity,
    selected_label: nationalLookup.candidate.text,
    selected_node_id: nationalLookup.candidate.node_id,
    input: picker.input,
    picker,
    path,
    box: nationalBox,
    selection_mode: "city_picker",
    picker_path: ["城市", "热门", "全国"]
  };
}

async function resetRecruitCityToNational(client, {
  requestedCity = "",
  reason = "national_city_frame_reset",
  optionTimeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS
} = {}) {
  const roots = await getRecruitRoots(client, { requireFrame: false });
  const reset = await navigateRecruitSearchFrame(client, roots?.iframe?.nodeId, { reason });
  if (!reset) {
    return {
      applied: false,
      reason: "national_city_frame_reset_unavailable",
      requested_city: requestedCity
    };
  }
  await sleep(1500);
  const controls = await waitForRecruitSearchControls(client, {
    timeoutMs: Math.max(optionTimeoutMs, DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS),
    intervalMs: 300
  });
  return {
    applied: controls.ok,
    reason,
    city: "全国",
    requested_city: requestedCity,
    selected_label: "全国",
    selection_mode: "frame_reset",
    reset,
    controls,
    reacquire_frame: true
  };
}

export async function setRecruitCity(client, frameNodeId, city, {
  optionTimeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS
} = {}) {
  const normalizedCity = normalizeText(city);
  if (!normalizedCity) {
    return { applied: false, reason: "empty_city" };
  }
  if (isRecruitNationalCity(normalizedCity)) {
    return selectRecruitNationalCityThroughPicker(client, frameNodeId, {
      requestedCity: normalizedCity,
      reason: "national_city_requested",
      optionTimeoutMs
    });
  }

  const picker = await openRecruitCityPicker(client, frameNodeId);
  await clearFocusedInput(client);
  await sleep(120);
  await insertText(client, normalizedCity);
  await sleep(500);

  const started = Date.now();
  const noResultFallbackMs = Math.min(DEFAULT_RECRUIT_CITY_NO_RESULT_FALLBACK_MS, optionTimeoutMs);
  let candidate = null;
  let candidates = [];
  let noResultFirstSeenAt = 0;
  while (Date.now() - started <= optionTimeoutMs) {
    const found = await findTextCandidate(
      client,
      frameNodeId,
      RECRUIT_SEARCH_SELECTORS.citySearchResult,
      normalizedCity,
      { match: "contains" }
    );
    candidate = found.candidate;
    candidates = found.candidates;
    if (candidate) break;
    const hasNoResult = candidates.some((item) => CITY_NO_RESULT_LABELS.has(item.label));
    if (hasNoResult) {
      if (!noResultFirstSeenAt) noResultFirstSeenAt = Date.now();
      if (Date.now() - noResultFirstSeenAt >= noResultFallbackMs) break;
    } else {
      noResultFirstSeenAt = 0;
    }
    await sleep(300);
  }
  if (!candidate) {
    const nationalFallback = await selectRecruitNationalCityThroughPicker(client, frameNodeId, {
      requestedCity: normalizedCity,
      reason: "city_result_not_found",
      optionTimeoutMs
    });
    if (nationalFallback.applied) {
      return {
        ...nationalFallback,
        reason: "city_result_not_found",
        requested_city: normalizedCity,
        requested_city_not_found: true,
        fallback_to_national: true,
        original_input: picker.input,
        picker,
        elapsed_ms: Date.now() - started,
        discovered_options_before_fallback: candidates.map((item) => item.text).slice(0, 20)
      };
    }

    const resetFallback = await resetRecruitCityToNational(client, {
      requestedCity: normalizedCity,
      reason: "city_result_not_found_frame_reset",
      optionTimeoutMs
    });
    if (resetFallback.applied) {
      return {
        ...resetFallback,
        reason: "city_result_not_found",
        requested_city: normalizedCity,
        requested_city_not_found: true,
        fallback_to_national: true,
        original_input: picker.input,
        picker,
        picker_fallback: nationalFallback,
        elapsed_ms: Date.now() - started,
        discovered_options_before_fallback: candidates.map((item) => item.text).slice(0, 20)
      };
    }

    return {
      applied: false,
      reason: "city_result_not_found",
      city: normalizedCity,
      input: picker.input,
      picker,
      elapsed_ms: Date.now() - started,
      discovered_options: candidates.map((item) => item.text).slice(0, 20),
      national_fallback: nationalFallback,
      reset_fallback: resetFallback
    };
  }

  const box = await clickNodeCenter(client, candidate.node_id, {
    ...DETERMINISTIC_CLICK_OPTIONS,
    scrollIntoView: true
  });
  await sleep(600);
  return {
    applied: true,
    city: normalizedCity,
    selected_label: candidate.text,
    selected_node_id: candidate.node_id,
    input: picker.input,
    picker,
    elapsed_ms: Date.now() - started,
    box
  };
}

export async function clickRecruitSearch(client, frameNodeId) {
  const buttonResult = await clickFirstNodeBySelectors(client, frameNodeId, RECRUIT_SEARCH_SELECTORS.searchButton, {
    optional: true,
    scrollIntoView: false
  });
  if (buttonResult.clicked) {
    await sleep(1500);
    return {
      searched: true,
      mode: "button",
      button: buttonResult
    };
  }

  await pressKey(client, "Enter", {
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  });
  await sleep(1500);
  return {
    searched: true,
    mode: "enter"
  };
}

export async function clickRecruitSearchWithKeywordGuard(client, frameNodeId, keyword, {
  maxAttempts = 2,
  postSearchSettleMs = 2200
} = {}) {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) {
    return clickRecruitSearch(client, frameNodeId);
  }

  const attempts = [];
  let currentFrameNodeId = frameNodeId;
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    let rootsBeforeAttempt = null;
    try {
      rootsBeforeAttempt = await getRecruitRoots(client, { requireFrame: false });
      if (rootsBeforeAttempt?.iframe?.documentNodeId) {
        currentFrameNodeId = rootsBeforeAttempt.iframe.documentNodeId;
      }
    } catch {}
    const before = await verifyRecruitKeywordInputValue(client, currentFrameNodeId, normalizedKeyword);
    let reapply = null;
    if (before.verified === false) {
      reapply = await setRecruitKeyword(client, currentFrameNodeId, normalizedKeyword);
    }
    const search = await clickRecruitSearch(client, currentFrameNodeId);
    let rootsAfterSearch = null;
    try {
      rootsAfterSearch = await getRecruitRoots(client, { requireFrame: false });
      if (rootsAfterSearch?.iframe?.documentNodeId) {
        currentFrameNodeId = rootsAfterSearch.iframe.documentNodeId;
      }
    } catch {}
    const after = await verifyRecruitKeywordInputValue(client, currentFrameNodeId, normalizedKeyword, {
      settleMs: postSearchSettleMs
    });
    attempts.push({
      attempt,
      before,
      reapply,
      search,
      after,
      frame_reacquired_before_attempt: rootsBeforeAttempt?.iframe?.documentNodeId
        ? {
          selector: rootsBeforeAttempt.iframe.selector,
          document_node_id: rootsBeforeAttempt.iframe.documentNodeId
        }
        : null,
      frame_reacquired: rootsAfterSearch?.iframe?.documentNodeId
        ? {
          selector: rootsAfterSearch.iframe.selector,
          document_node_id: rootsAfterSearch.iframe.documentNodeId
        }
        : null
    });
    if (after.verified !== false) {
      return {
        searched: true,
        mode: search.mode,
        search,
        keyword_guard: {
          verified: after.verified,
          expected: after.expected,
          actual: after.actual,
          attempts
        }
      };
    }
  }

  const last = attempts[attempts.length - 1]?.after || {};
  const error = new Error(`Recruit keyword was not preserved after search: expected=${normalizedKeyword}; actual=${last.actual || "unknown"}`);
  error.keyword_guard = {
    verified: false,
    expected: normalizedKeyword,
    actual: last.actual || "",
    attempts
  };
  throw error;
}

export async function waitForRecruitSearchResultState(client, {
  timeoutMs = DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS,
  intervalMs = 500
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      const roots = await getRecruitRoots(client, { requireFrame: false });
      const frameNodeId = roots.iframe?.documentNodeId;
      if (frameNodeId) {
        const counts = await countSelectors(client, frameNodeId, {
          candidate_card: RECRUIT_CARD_SELECTOR,
          no_data: RECRUIT_NO_DATA_SELECTORS.join(", ")
        });
        lastState = {
          ok: counts.candidate_card > 0 || counts.no_data > 0,
          elapsed_ms: Date.now() - started,
          iframe_selector: roots.iframe.selector,
          iframe_document_node_id: frameNodeId,
          counts
        };
        if (lastState.ok) return lastState;
      }
    } catch (error) {
      lastState = {
        ok: false,
        elapsed_ms: Date.now() - started,
        error: error?.message || String(error)
      };
    }
    await sleep(intervalMs);
  }
  return {
    ok: false,
    elapsed_ms: Date.now() - started,
    ...(lastState || {})
  };
}

export async function applyRecruitSearchParams(client, {
  searchParams = {},
  requireCards = true,
  resetBeforeApply = false,
  searchTimeoutMs = DEFAULT_RECRUIT_SEARCH_TIMEOUT_MS,
  resetTimeoutMs = DEFAULT_RECRUIT_RESET_TIMEOUT_MS,
  resetSettleMs = 5000,
  cityOptionTimeoutMs = DEFAULT_RECRUIT_CITY_OPTION_TIMEOUT_MS
} = {}) {
  const normalizedSearchParams = normalizeRecruitSearchParams(searchParams);
  const reset = resetBeforeApply
    ? await resetRecruitSearchPage(client, {
      timeoutMs: resetTimeoutMs,
      settleMs: resetSettleMs
    })
    : null;
  const controls = reset?.controls?.ok
    ? reset.controls
    : await waitForRecruitSearchControls(client, {
      timeoutMs: searchTimeoutMs,
      intervalMs: 500
    });
  if (!controls.ok) {
    throw new Error(`Recruit search controls were not ready after navigation; counts=${JSON.stringify(controls.counts || {})}`);
  }
  const overlayDismissal = await dismissRecruitSearchOverlays(client);
  const initialRoots = await getRecruitRoots(client);
  let frameNodeId = initialRoots.iframe.documentNodeId;
  const initialFrameNodeId = frameNodeId;
  const beforeCounts = await getRecruitSearchCounts(client, frameNodeId);
  const steps = [];
  const applicationStepNames = buildRecruitSearchApplicationStepNames(normalizedSearchParams);

  for (const stepName of applicationStepNames) {
    if (stepName === "job_title") {
      steps.push({
        step: "job_title",
        result: await setRecruitJobTitle(client, frameNodeId, normalizedSearchParams.job, {
          optionTimeoutMs: searchTimeoutMs
        })
      });
      const rootsAfterJob = await getRecruitRoots(client);
      frameNodeId = rootsAfterJob.iframe.documentNodeId;
      steps.push({
        step: "reacquire_after_job",
        result: {
          selector: rootsAfterJob.iframe.selector,
          document_node_id: frameNodeId
        }
      });
    } else if (stepName === "city") {
      const cityResult = await setRecruitCity(client, frameNodeId, normalizedSearchParams.city, {
        optionTimeoutMs: cityOptionTimeoutMs
      });
      steps.push({
        step: "city",
        result: cityResult
      });
      if (cityResult?.reacquire_frame) {
        const rootsAfterCity = await getRecruitRoots(client);
        frameNodeId = rootsAfterCity.iframe.documentNodeId;
        steps.push({
          step: "reacquire_after_city",
          result: {
            selector: rootsAfterCity.iframe.selector,
            document_node_id: frameNodeId,
            reason: cityResult.reason
          }
        });
      }
    } else if (stepName === "degree") {
      steps.push({
        step: "degree",
        result: await setRecruitDegrees(client, frameNodeId, normalizedSearchParams.degrees)
      });
    } else if (stepName === "schools") {
      steps.push({
        step: "schools",
        result: await setRecruitSchools(client, frameNodeId, normalizedSearchParams.schools)
      });
    } else if (stepName === "experience") {
      steps.push({
        step: "experience",
        result: await setRecruitExperience(client, frameNodeId, normalizedSearchParams.experience)
      });
    } else if (stepName === "gender") {
      steps.push({
        step: "gender",
        result: await setRecruitGender(client, frameNodeId, normalizedSearchParams.gender)
      });
    } else if (stepName === "age") {
      steps.push({
        step: "age",
        result: await setRecruitAge(client, frameNodeId, normalizedSearchParams.age)
      });
    } else if (stepName === "keyword") {
      const rootsBeforeKeyword = await getRecruitRoots(client);
      frameNodeId = rootsBeforeKeyword.iframe.documentNodeId;
      steps.push({
        step: "reacquire_before_keyword",
        result: {
          selector: rootsBeforeKeyword.iframe.selector,
          document_node_id: frameNodeId
        }
      });
      steps.push({
        step: "keyword",
        result: await setRecruitKeyword(client, frameNodeId, normalizedSearchParams.keyword)
      });
    } else if (stepName === "search") {
      const rootsBeforeSearch = await getRecruitRoots(client);
      frameNodeId = rootsBeforeSearch.iframe.documentNodeId;
      steps.push({
        step: "reacquire_before_search",
        result: {
          selector: rootsBeforeSearch.iframe.selector,
          document_node_id: frameNodeId
        }
      });
      steps.push({
        step: "search",
        result: await clickRecruitSearchWithKeywordGuard(client, frameNodeId, normalizedSearchParams.keyword)
      });
    } else if (stepName === "recent_viewed") {
      const recentFilterRoots = await getRecruitRoots(client);
      steps.push({
        step: "recent_viewed",
        result: await setRecruitRecentViewedFilter(
          client,
          recentFilterRoots.iframe.documentNodeId,
          normalizedSearchParams.filter_recent_viewed
        )
      });
    } else if (stepName === "exchange_resume") {
      const exchangeFilterRoots = await getRecruitRoots(client);
      steps.push({
        step: "exchange_resume",
        result: await setRecruitExchangeResumeFilter(
          client,
          exchangeFilterRoots.iframe.documentNodeId,
          normalizedSearchParams.skip_recent_colleague_contacted
        )
      });
    }
  }

  const postSearchState = await waitForRecruitSearchResultState(client, {
    timeoutMs: searchTimeoutMs
  });
  if (requireCards && (postSearchState.counts?.candidate_card || 0) === 0) {
    throw new Error(`Recruit search did not produce candidate cards; no_data=${postSearchState.counts?.no_data || 0}`);
  }

  return {
    applied: true,
    search_params: normalizedSearchParams,
    reset,
    overlay_dismissal: overlayDismissal,
    controls,
    application_step_names: applicationStepNames,
    initial_iframe: {
      selector: initialRoots.iframe.selector,
      document_node_id: initialFrameNodeId
    },
    before_counts: beforeCounts,
    steps,
    post_search_state: postSearchState
  };
}
