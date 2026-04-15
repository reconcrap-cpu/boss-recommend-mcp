const SCHOOL_TAG_OPTIONS = [
  "不限",
  "985",
  "211",
  "双一流院校",
  "留学",
  "国内外名校",
  "公办本科"
];
const DEGREE_OPTIONS = [
  "不限",
  "初中及以下",
  "中专/中技",
  "高中",
  "大专",
  "本科",
  "硕士",
  "博士"
];
const DEGREE_ORDER = [
  "初中及以下",
  "中专/中技",
  "高中",
  "大专",
  "本科",
  "硕士",
  "博士"
];
const GENDER_OPTIONS = ["不限", "男", "女"];
const RECENT_NOT_VIEW_OPTIONS = ["不限", "近14天没有"];
const FILTER_CONFIRM_OPTIONS = [
  { label: "筛选项无误，继续", value: "confirm" },
  { label: "筛选项需要调整", value: "revise" }
];
const POST_ACTION_OPTIONS = ["favorite", "greet", "none"];
const POST_ACTION_LABELS = {
  favorite: "收藏",
  greet: "直接沟通",
  none: "什么也不做"
};
const PAGE_SCOPE_OPTIONS = ["recommend", "featured", "latest"];
const PAGE_SCOPE_LABELS = {
  recommend: "推荐",
  featured: "精选",
  latest: "最新"
};
const LEADING_NOISE_PATTERNS = [
  /^使用boss-recommend-pipeline skills/i,
  /^使用boss recommend pipeline skills/i,
  /^帮我(?:在boss上)?(?:筛选|处理|看一下|跑一下)/i,
  /^请(?:帮我)?(?:在boss上)?(?:筛选|处理|跑一下)/i,
  /^在推荐页(?:上)?/i,
  /^在boss推荐页(?:上)?/i
];
const SCHOOL_TAG_PATTERNS = [
  { label: "985", pattern: /(?:学校|院校|学历|标签|筛选|要求)?[^。；;\n]{0,12}(?:985)(?!\d)/i },
  { label: "211", pattern: /(?:学校|院校|学历|标签|筛选|要求)?[^。；;\n]{0,12}(?:211)(?!\d)/i },
  { label: "双一流院校", pattern: /双一流(?:院校|学校)?/i },
  { label: "留学", pattern: /留学|留学生|海归/i },
  { label: "国内外名校", pattern: /国内外名校|海内外名校|海外名校|qs\s*(?:top|前)?\s*\d+|名校/i },
  { label: "公办本科", pattern: /公办本科/i }
];
const DEGREE_PATTERNS = [
  { label: "初中及以下", pattern: /初中及以下|初中以下/i },
  { label: "中专/中技", pattern: /中专\s*\/\s*中技|中专中技|中专|中技/i },
  { label: "高中", pattern: /(?:学历|教育|要求)?[^。；;\n]{0,8}高中/i },
  { label: "大专", pattern: /(?:学历|教育|要求)?[^。；;\n]{0,8}(?:大专|专科)/i },
  { label: "本科", pattern: /(?:学历|教育|要求)?[^。；;\n]{0,8}(?:本科|学士)/i },
  { label: "硕士", pattern: /(?:学历|教育|要求)?[^。；;\n]{0,8}(?:硕士|研究生)/i },
  { label: "博士", pattern: /(?:学历|教育|要求)?[^。；;\n]{0,8}博士/i }
];
const GENDER_PATTERNS = [
  { label: "男", pattern: /(?:性别|候选人|人选)?[^。；;\n]{0,8}(?:男生|男性|男)/i },
  { label: "女", pattern: /(?:性别|候选人|人选)?[^。；;\n]{0,8}(?:女生|女性|女)/i }
];
const RECENT_NOT_VIEW_POSITIVE_PATTERNS = [
  /近?14天(?:内)?没有/i,
  /近?14天(?:内)?没看过/i,
  /近?14天(?:内)?未查看/i,
  /过滤[^。；;\n]{0,12}14天/i,
  /排除[^。；;\n]{0,12}14天/i
];
const RECENT_NOT_VIEW_NEGATIVE_PATTERNS = [
  /不限[^。；;\n]{0,8}14天/i,
  /不过滤[^。；;\n]{0,12}14天/i,
  /保留[^。；;\n]{0,12}14天/i
];
const TARGET_COUNT_PATTERNS = [
  /目标筛选数(?:量)?(?:为|是|:|：)?\s*(\d+)/i,
  /目标通过数(?:量)?(?:为|是|:|：)?\s*(\d+)/i,
  /目标(?:处理|筛选|通过)?(?:人数|数量)?(?:为|是|:|：)?\s*(\d+)/i,
  /至少(?:处理|筛选|通过)\s*(\d+)\s*(?:位|人)/i,
  /(?:处理|筛选|通过)\s*(\d+)\s*(?:位|人)/i
];
const MAX_GREET_COUNT_PATTERNS = [
  /最大招呼数(?:量)?(?:为|是|:|：)?\s*(\d+)/i,
  /最大(?:打招呼|招呼|沟通|联系)(?:人数|数量|数)?(?:为|是|:|：)?\s*(\d+)/i,
  /最多(?:打招呼|沟通|联系)\s*(\d+)\s*(?:位|人|个)?/i,
  /(?:打招呼|沟通|联系)(?:上限|最多|不超过|至多)(?:为|是|:|：)?\s*(\d+)/i
];
const CRITERIA_EXPLICIT_MARKER_PATTERN = /筛选条件\s*[：:]/i;
const CRITERIA_EXPLICIT_STOP_PATTERN = /(?:^|[\n；;])\s*(?:页面选择|学校标签|院校标签|学历|学位|性别|是否过滤近14天看过|目标筛选数|目标通过人数|通过筛选后动作|最大招呼数|最大打招呼数|岗位)\s*[：:]/i;
const CRITERIA_META_FIELD_PREFIX_PATTERNS = [
  /^(?:页面选择|学校标签|院校标签|学历|学位|性别|是否过滤近14天看过|目标筛选数|目标通过人数|通过筛选后动作|最大招呼数|最大打招呼数|岗位)\s*(?:[:：]|$)/i,
  /^(?:近?14天(?:内)?(?:没有|没看过|未查看)|(?:不过滤|保留|过滤|排除)[^。；;\n]{0,12}14天)\s*(?:[:：]|$)?/i,
  /^(?:目标(?:处理|筛选|通过)?(?:人数|数量)?|至少(?:处理|筛选|通过)|(?:处理|筛选|通过)\s*\d+\s*(?:位|人))(?:[:：\s]|$)/i,
  /^(?:最多(?:打招呼|沟通|联系)|(?:打招呼|沟通|联系)(?:上限|最多|不超过|至多))(?:[:：\s]|$)/i,
  /^(?:(?:通过筛选后)?动作|post[_\s-]?action|max[_\s-]?greet[_\s-]?count|target[_\s-]?count)\s*(?:[:：]|$)/i
];
const META_CLAUSE_PATTERNS = [
  /^推荐页|^推荐页面|^boss推荐/i,
  /^帮我|^请|^运行|^使用.*skill/i,
  /^启动boss推荐任务/i,
  /^条件如下(?:[:：]|$)/i,
  /^(?:符合标准(?:的人选)?(?:都)?(?:的)?(?:动作)?[:：]?\s*)?(?:收藏|打招呼|直接沟通|什么也不做|不做任何操作|不操作|仅筛选|只筛选)(?:[:：]|$)/i
];
const FEATURED_SCOPE_PATTERN = /(?:精选牛人|精选页|精选页面|精选tab|精选标签|tab[^。；;\n]{0,6}精选|精选)/i;
const LATEST_SCOPE_PATTERN = /(?:最新页|最新页面|最新tab|最新标签|tab[^。；;\n]{0,6}最新|最新)/i;
const RECOMMEND_SCOPE_PATTERN = /(?:推荐页|推荐页面|推荐tab|推荐标签|tab[^。；;\n]{0,6}推荐|推荐)/i;

function normalizeText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function normalizeCompactText(input) {
  return normalizeText(input).replace(/\s+/g, "").toLowerCase();
}

function parsePositiveIntegerValue(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function uniqueList(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function buildTextOptions(values = []) {
  return values.map((value) => ({
    label: value,
    value
  }));
}

function normalizeSchoolTag(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const compact = normalizeCompactText(normalized);
  if (normalized === "双一流" || compact === "双一流") return "双一流院校";
  if (["留学", "留学生", "海归", "海外留学"].includes(compact)) return "留学";
  if (
    ["国内外名校", "海内外名校", "国内外高校", "海内外高校", "海外名校"].includes(compact)
    || /^qs(?:前|top)?\d+$/.test(compact)
  ) {
    return "国内外名校";
  }
  if (SCHOOL_TAG_OPTIONS.includes(normalized)) return normalized;
  return null;
}

function toSchoolTagInputList(input) {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeText(item)).filter(Boolean);
  }
  const text = normalizeText(input);
  if (!text) return [];
  return text.split(/[，,、/|]/).map((item) => normalizeText(item)).filter(Boolean);
}

function auditSchoolTagSelections(input) {
  const rawItems = toSchoolTagInputList(input);
  const valid = [];
  const invalid = [];
  for (const item of rawItems) {
    const normalized = normalizeSchoolTag(item);
    if (normalized) {
      valid.push(normalized);
    } else {
      invalid.push(item);
    }
  }
  return {
    valid: sortSchoolTagSelections(valid),
    invalid: uniqueList(invalid)
  };
}

function sortSchoolTagSelections(values) {
  const order = new Map(SCHOOL_TAG_OPTIONS.map((item, index) => [item, index]));
  const unique = Array.from(
    new Set((values || []).map((item) => normalizeSchoolTag(item)).filter(Boolean))
  );
  if (!unique.length) return [];
  if (unique.includes("不限")) {
    return unique.length === 1
      ? ["不限"]
      : unique.filter((item) => item !== "不限").sort((left, right) => order.get(left) - order.get(right));
  }
  return unique.sort((left, right) => order.get(left) - order.get(right));
}

function normalizeSchoolTagSelections(input) {
  const audited = auditSchoolTagSelections(input);
  return audited.valid.length ? audited.valid : null;
}

function normalizeDegree(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized === "专科") return "大专";
  if (normalized === "研究生") return "硕士";
  if (normalized === "中专" || normalized === "中技" || normalized === "中专中技") return "中专/中技";
  return DEGREE_OPTIONS.includes(normalized) ? normalized : null;
}

function sortDegreeSelections(values) {
  return uniqueList(values).sort((left, right) => {
    const leftIndex = DEGREE_ORDER.indexOf(left);
    const rightIndex = DEGREE_ORDER.indexOf(right);
    return leftIndex - rightIndex;
  });
}

function expandDegreeAtOrAbove(value) {
  const normalized = normalizeDegree(value);
  if (!normalized || normalized === "不限") return [];
  const startIndex = DEGREE_ORDER.indexOf(normalized);
  if (startIndex === -1) return [];
  return DEGREE_ORDER.slice(startIndex);
}

function parseDegreeSelectionsFromText(text) {
  const normalizedText = normalizeText(text);
  if (!normalizedText) return [];
  if (
    /(?:学历|学位|教育)(?:要求)?\s*(?:[:：]\s*)?(?:不限|不限制|无要求)|(?:不限|不限制)\s*(?:[:：]\s*)?(?:学历|学位|教育)(?:要求)?/i
      .test(normalizedText)
  ) {
    return ["不限"];
  }

  const selected = [];
  const atOrAbovePattern = /(初中及以下|中专\/中技|中专中技|中专|中技|高中|大专|专科|本科|硕士|研究生|博士)\s*(?:及|或)?以上/g;
  let match;
  while ((match = atOrAbovePattern.exec(normalizedText)) !== null) {
    selected.push(...expandDegreeAtOrAbove(match[1]));
  }

  for (const { label, pattern } of DEGREE_PATTERNS) {
    if (pattern.test(normalizedText)) {
      selected.push(label);
    }
  }
  return sortDegreeSelections(selected);
}

function normalizeDegreeSelections(input) {
  if (Array.isArray(input)) {
    const normalized = sortDegreeSelections(input.map((item) => normalizeDegree(item)).filter(Boolean));
    if (!normalized.length) return null;
    return normalized.includes("不限") ? ["不限"] : normalized;
  }

  const text = normalizeText(input);
  if (!text) return null;
  if (text.includes("以上")) {
    const fromText = parseDegreeSelectionsFromText(text);
    if (fromText.length) return fromText;
  }
  const parts = text.split(/[，,、/|]/).map((item) => normalizeDegree(item)).filter(Boolean);
  if (parts.length) {
    const normalized = sortDegreeSelections(parts);
    return normalized.includes("不限") ? ["不限"] : normalized;
  }
  const single = normalizeDegree(text);
  return single ? [single] : null;
}

function normalizeGender(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized === "男性" || normalized === "男生") return "男";
  if (normalized === "女性" || normalized === "女生") return "女";
  return GENDER_OPTIONS.includes(normalized) ? normalized : null;
}

function normalizeRecentNotView(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const compact = normalizeCompactText(normalized).replace(/天内/g, "天");
  if (
    /^(?:近)?14天(?:没有|未看|没看过|没看|未查看|未查看过)$/.test(compact)
    || /^(?:过滤|排除)(?:近)?14天(?:已看|看过)?$/.test(compact)
  ) {
    return "近14天没有";
  }
  if (
    /^(?:不限|不限制|无要求|无|全部|都可以)$/.test(compact)
    || /^(?:不过滤|保留)(?:近)?14天(?:已看|看过)?$/.test(compact)
  ) {
    return "不限";
  }
  return RECENT_NOT_VIEW_OPTIONS.includes(normalized) ? normalized : null;
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
  if (["latest", "最新", "最新页", "最新页面"].includes(normalized)) return "latest";
  return PAGE_SCOPE_OPTIONS.includes(normalized) ? normalized : null;
}

function extractPageScope(text) {
  if (FEATURED_SCOPE_PATTERN.test(text)) return "featured";
  if (LATEST_SCOPE_PATTERN.test(text)) return "latest";
  if (RECOMMEND_SCOPE_PATTERN.test(text)) return "recommend";
  return null;
}

function sanitizeInstruction(text) {
  let current = normalizeText(text);
  for (const pattern of LEADING_NOISE_PATTERNS) {
    current = current.replace(pattern, "").trim();
  }
  return current;
}

function extractSchoolTags(text) {
  const matches = [];
  for (const { label, pattern } of SCHOOL_TAG_PATTERNS) {
    if (pattern.test(text)) {
      matches.push(label);
    }
  }
  return uniqueList(matches);
}

function extractGender(text) {
  for (const { label, pattern } of GENDER_PATTERNS) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return null;
}

function extractDegrees(text) {
  return parseDegreeSelectionsFromText(text);
}

function extractRecentNotView(text) {
  for (const pattern of RECENT_NOT_VIEW_NEGATIVE_PATTERNS) {
    if (pattern.test(text)) {
      return "不限";
    }
  }
  for (const pattern of RECENT_NOT_VIEW_POSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return "近14天没有";
    }
  }
  return null;
}

function extractTargetCount(text) {
  for (const pattern of TARGET_COUNT_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const count = Number.parseInt(match[1], 10);
      if (Number.isFinite(count) && count > 0) {
        return count;
      }
    }
  }
  return null;
}

function extractMaxGreetCount(text) {
  for (const pattern of MAX_GREET_COUNT_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const count = Number.parseInt(match[1], 10);
      if (Number.isFinite(count) && count > 0) {
        return count;
      }
    }
  }
  return null;
}

function extractJobSelectionHint(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const match = normalized.match(/(?:^|[\n；;])\s*(?:岗位|职位|job)\s*[：:]\s*([^\n；;]+)/i);
  if (!match?.[1]) return null;
  return normalizeText(String(match[1] || "").replace(/[。；;]+$/, "").trim());
}

function sanitizeClause(clause) {
  let current = normalizeText(clause);
  for (const pattern of LEADING_NOISE_PATTERNS) {
    current = current.replace(pattern, "").trim();
  }
  current = current
    .replace(/^符合标准的人选(?:都)?/i, "")
    .replace(/^人选(?:需要|要求)?/i, "")
    .replace(/^候选人(?:需要|要求)?/i, "")
    .replace(/^要求/i, "")
    .trim();
  return current;
}

function isMetaClause(clause) {
  const normalized = sanitizeClause(clause);
  if (!normalized) return true;
  const withoutNumbering = normalized.replace(/^\d+\s*[)）]\s*/, "").trim();
  if (!withoutNumbering) return true;
  if (CRITERIA_META_FIELD_PREFIX_PATTERNS.some((pattern) => pattern.test(withoutNumbering))) return true;
  if (META_CLAUSE_PATTERNS.some((pattern) => pattern.test(withoutNumbering))) return true;
  return false;
}

function splitRawCriteriaClauses(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const firstNumberedIndex = normalized.search(/\d+\s*[)）]/);
  if (firstNumberedIndex === -1) {
    return normalized
      .split(/[；;\n]+/)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  const prefix = normalized
    .slice(0, firstNumberedIndex)
    .replace(/[；;，,。]+$/, "")
    .trim();
  const numberedClauses = normalized
    .slice(firstNumberedIndex)
    .split(/(?=\d+\s*[)）])/)
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  return prefix ? [prefix, ...numberedClauses] : numberedClauses;
}

function normalizeRawCriteriaClauses(clauses = []) {
  const filtered = clauses
    .map((item) => String(item || "").replace(/^[；;，,。]+/, "").replace(/[；;，,。]+$/, "").trim())
    .filter(Boolean)
    .filter((item) => !isMetaClause(item));
  const unique = uniqueList(filtered);
  if (!unique.length) return null;
  return unique.reduce((acc, clause) => {
    if (!acc) return clause;
    if (/[：:]$/.test(acc) && /^\d+\s*[)）]/.test(clause)) {
      return `${acc}${clause}`;
    }
    return `${acc}；${clause}`;
  }, "");
}

function normalizeCriteriaClauses(clauses = []) {
  const filtered = clauses
    .map((item) => sanitizeClause(item))
    .map((item) => item.replace(/^[；;，,。]+/, "").replace(/[；;，,。]+$/, "").trim())
    .filter(Boolean)
    .filter((item) => !isMetaClause(item));
  const unique = uniqueList(filtered.map((item) => normalizeText(item)));
  if (!unique.length) return null;
  return unique.reduce((acc, clause) => {
    if (!acc) return clause;
    if (/[：:]$/.test(acc) && /^\d+\s*[)）]/.test(clause)) {
      return `${acc}${clause}`;
    }
    return `${acc}；${clause}`;
  }, "");
}

function extractExplicitCriteriaBlock(text) {
  const normalizedText = String(text || "").replace(/\r\n/g, "\n");
  const markerMatch = normalizedText.match(CRITERIA_EXPLICIT_MARKER_PATTERN);
  if (!markerMatch) return {
    raw: null,
    normalized: null
  };

  let block = normalizedText.slice(markerMatch.index + markerMatch[0].length);
  const stopMatch = block.match(CRITERIA_EXPLICIT_STOP_PATTERN);
  if (stopMatch && stopMatch.index > 0) {
    block = block.slice(0, stopMatch.index);
  }
  const rawClauses = splitRawCriteriaClauses(block);
  return {
    raw: normalizeRawCriteriaClauses(rawClauses),
    normalized: normalizeCriteriaClauses(rawClauses)
  };
}

function buildFallbackCriteria(text) {
  const clauses = sanitizeInstruction(text)
    .split(/[，,。；;\n]/)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return {
    raw: normalizeRawCriteriaClauses(clauses),
    normalized: normalizeCriteriaClauses(clauses)
  };
}

function buildCriteria({ instruction, rawInstruction, overrideCriteria }) {
  const rawOverride = String(overrideCriteria || "").trim();
  const normalizedOverride = normalizeText(rawOverride);
  if (normalizedOverride) {
    return {
      raw: rawOverride || normalizedOverride,
      normalized: normalizedOverride,
      source: "override"
    };
  }

  const explicitCriteria = extractExplicitCriteriaBlock(rawInstruction || instruction);
  if (explicitCriteria.raw) {
    return {
      ...explicitCriteria,
      source: "explicit"
    };
  }

  const fallbackCriteria = buildFallbackCriteria(rawInstruction || instruction);
  return {
    ...fallbackCriteria,
    source: fallbackCriteria.raw ? "fallback" : null
  };
}

function resolvePostAction({ instruction, confirmation, overrides }) {
  const confirmed = confirmation?.post_action_confirmed === true;
  const confirmationValue = normalizePostAction(confirmation?.post_action_value);
  const overrideValue = normalizePostAction(overrides?.post_action);
  const instructionValue =
    /收藏/.test(instruction) && !/取消收藏/.test(instruction)
      ? "favorite"
      : /打招呼|直接沟通|沟通/.test(instruction)
        ? "greet"
        : /什么也不做|不做任何操作|不操作|仅筛选|只筛选/.test(instruction)
          ? "none"
        : null;
  const proposed = overrideValue || confirmationValue || instructionValue || null;

  if (confirmed && confirmationValue) {
    return {
      post_action: confirmationValue,
      proposed_post_action: confirmationValue,
      needs_post_action_confirmation: false
    };
  }

  return {
    post_action: confirmed ? confirmationValue || proposed : null,
    proposed_post_action: proposed,
    needs_post_action_confirmation: true
  };
}

function resolveTargetCount({ instruction, confirmation, overrides }) {
  const confirmed = confirmation?.target_count_confirmed === true;
  const overrideValue = parsePositiveIntegerValue(overrides?.target_count);
  const confirmationValue = parsePositiveIntegerValue(confirmation?.target_count_value);
  const instructionValue = extractTargetCount(instruction);
  const proposed = overrideValue || confirmationValue || instructionValue || null;
  const resolved = overrideValue || (confirmed ? confirmationValue : null);

  return {
    target_count: resolved,
    proposed_target_count: proposed,
    needs_target_count_confirmation: !confirmed
  };
}

function resolveMaxGreetCount({ instruction, confirmation, overrides, postActionResolution }) {
  const actionHint = postActionResolution.post_action || postActionResolution.proposed_post_action;
  if (actionHint !== "greet") {
    return {
      max_greet_count: null,
      proposed_max_greet_count: null,
      needs_max_greet_count_confirmation: false,
      suspicious_auto_fill: false
    };
  }

  const overrideValue = parsePositiveIntegerValue(overrides?.max_greet_count);
  const confirmed = confirmation?.max_greet_count_confirmed === true;
  const confirmationValue = parsePositiveIntegerValue(confirmation?.max_greet_count_value);
  const instructionValue = extractMaxGreetCount(instruction);
  const targetCountHint = (
    parsePositiveIntegerValue(confirmation?.target_count_value)
    || parsePositiveIntegerValue(overrides?.target_count)
    || extractTargetCount(instruction)
    || null
  );
  const proposed = confirmationValue || overrideValue || instructionValue || null;
  const resolved = confirmed ? (confirmationValue || overrideValue || null) : null;
  const suspiciousAutoFill = Boolean(
    !confirmed
    && Number.isInteger(proposed)
    && proposed > 0
    && !Number.isInteger(instructionValue)
    && Number.isInteger(targetCountHint)
    && targetCountHint > 0
    && proposed === targetCountHint
  );
  const needsConfirmation = (
    !(Number.isInteger(resolved) && resolved > 0)
  );

  return {
    max_greet_count: needsConfirmation ? null : resolved,
    proposed_max_greet_count: proposed,
    needs_max_greet_count_confirmation: needsConfirmation,
    suspicious_auto_fill: suspiciousAutoFill
  };
}

function resolvePageScope({ instruction, confirmation, overrides }) {
  const confirmed = confirmation?.page_confirmed === true;
  const confirmationValue = normalizePageScope(confirmation?.page_value);
  const overrideValue = normalizePageScope(overrides?.page_scope);
  const instructionValue = extractPageScope(instruction);
  const proposed = overrideValue || confirmationValue || instructionValue || "recommend";
  return {
    page_scope: confirmed && confirmationValue ? confirmationValue : null,
    proposed_page_scope: proposed,
    needs_page_confirmation: !(confirmed && Boolean(confirmationValue))
  };
}

function collectSuspiciousFields({ invalidOverrideSchoolTags, maxGreetCountResolution }) {
  const suspicious = [];
  if (Array.isArray(invalidOverrideSchoolTags) && invalidOverrideSchoolTags.length > 0) {
    suspicious.push({
      field: "school_tag",
      value: invalidOverrideSchoolTags,
      reason: `已忽略无效学校标签：${invalidOverrideSchoolTags.join(" / ")}；仅保留可识别选项。`
    });
  }
  if (maxGreetCountResolution?.suspicious_auto_fill) {
    suspicious.push({
      field: "max_greet_count",
      value: maxGreetCountResolution.proposed_max_greet_count,
      reason: "检测到 max_greet_count 与 target_count 相同且原始指令未明确该值，可能是自动填充，需用户再次确认。"
    });
  }
  return suspicious;
}

export function parseRecommendInstruction({ instruction, confirmation, overrides }) {
  const rawInstruction = String(instruction || "");
  const text = normalizeText(rawInstruction);
  const detectedSchoolTags = extractSchoolTags(text);
  const detectedDegrees = extractDegrees(text);
  const schoolTagAudit = auditSchoolTagSelections(overrides?.school_tag);
  const overrideSchoolTag = schoolTagAudit.valid.length > 0 ? schoolTagAudit.valid : null;
  const confirmationSchoolTag = normalizeSchoolTagSelections(confirmation?.school_tag_value);
  const overrideDegrees = normalizeDegreeSelections(overrides?.degree);
  const confirmationDegrees = normalizeDegreeSelections(confirmation?.degree_value);
  const overrideGender = normalizeGender(overrides?.gender);
  const confirmationGender = normalizeGender(confirmation?.gender_value);
  const overrideRecentNotView = normalizeRecentNotView(overrides?.recent_not_view);
  const confirmationRecentNotView = normalizeRecentNotView(confirmation?.recent_not_view_value);
  const overrideCriteria = overrides?.criteria;
  const criteriaResolution = buildCriteria({
    instruction: text,
    rawInstruction,
    overrideCriteria
  });
  const jobSelectionHint = normalizeText(
    overrides?.job
    || confirmation?.job_value
    || extractJobSelectionHint(rawInstruction)
    || ""
  );
  const pageScopeResolution = resolvePageScope({ instruction: text, confirmation, overrides });

  const inferredSchoolTag = detectedSchoolTags.length > 0
    ? sortSchoolTagSelections(detectedSchoolTags)
    : ["不限"];
  const searchParams = {
    school_tag: overrideSchoolTag || confirmationSchoolTag || inferredSchoolTag,
    degree: (
      (Array.isArray(overrideDegrees) && overrideDegrees.length > 0
        ? overrideDegrees
        : Array.isArray(confirmationDegrees) && confirmationDegrees.length > 0
          ? confirmationDegrees
        : Array.isArray(detectedDegrees) && detectedDegrees.length > 0
          ? detectedDegrees
          : ["不限"])
    ),
    gender: overrideGender || confirmationGender || extractGender(text) || "不限",
    recent_not_view: overrideRecentNotView || confirmationRecentNotView || extractRecentNotView(text) || "不限"
  };
  const screenParams = {
    criteria: criteriaResolution.raw || criteriaResolution.normalized || null,
    target_count: null,
    post_action: null,
    max_greet_count: null
  };
  const targetCountResolution = resolveTargetCount({ instruction: text, confirmation, overrides });
  screenParams.target_count = targetCountResolution.target_count;
  const postActionResolution = resolvePostAction({ instruction: text, confirmation, overrides });
  screenParams.post_action = postActionResolution.post_action;
  const maxGreetCountResolution = resolveMaxGreetCount({
    instruction: text,
    confirmation,
    overrides,
    postActionResolution
  });
  screenParams.max_greet_count = maxGreetCountResolution.max_greet_count;

  const missing_fields = [];
  if (!screenParams.criteria) {
    missing_fields.push("criteria");
  }

  const suspicious_fields = collectSuspiciousFields({
    invalidOverrideSchoolTags: schoolTagAudit.invalid,
    maxGreetCountResolution
  });
  const hasConfirmedSchoolTagValue = Array.isArray(confirmationSchoolTag) && confirmationSchoolTag.length > 0;
  const hasConfirmedDegreeValue = Array.isArray(confirmationDegrees) && confirmationDegrees.length > 0;
  const hasConfirmedGenderValue = Boolean(confirmationGender);
  const hasConfirmedRecentNotViewValue = Boolean(confirmationRecentNotView);
  const needs_school_tag_confirmation = (
    confirmation?.school_tag_confirmed !== true
    || !hasConfirmedSchoolTagValue
  );
  const needs_degree_confirmation = (
    confirmation?.degree_confirmed !== true
    || !hasConfirmedDegreeValue
  );
  const needs_gender_confirmation = (
    confirmation?.gender_confirmed !== true
    || !hasConfirmedGenderValue
  );
  const needs_recent_not_view_confirmation = (
    confirmation?.recent_not_view_confirmed !== true
    || !hasConfirmedRecentNotViewValue
  );
  const needs_filters_confirmation = (
    confirmation?.filters_confirmed !== true
    || needs_school_tag_confirmation
    || needs_degree_confirmation
    || needs_gender_confirmation
    || needs_recent_not_view_confirmation
  );
  const needs_criteria_confirmation = confirmation?.criteria_confirmed !== true;
  const needs_target_count_confirmation = targetCountResolution.needs_target_count_confirmation;
  const needs_post_action_confirmation = postActionResolution.needs_post_action_confirmation;
  const needs_max_greet_count_confirmation = maxGreetCountResolution.needs_max_greet_count_confirmation;
  const needs_page_confirmation = pageScopeResolution.needs_page_confirmation;
  const pending_questions = [];

  if (needs_page_confirmation) {
    pending_questions.push({
      field: "page_scope",
      question: "请确认本次在推荐里的哪个页面执行筛选：推荐 / 精选 / 最新。",
      value: pageScopeResolution.proposed_page_scope,
      options: [
        { label: PAGE_SCOPE_LABELS.recommend, value: "recommend" },
        { label: PAGE_SCOPE_LABELS.featured, value: "featured" },
        { label: PAGE_SCOPE_LABELS.latest, value: "latest" }
      ]
    });
  }

  if (needs_school_tag_confirmation) {
    const schoolTagQuestion = detectedSchoolTags.length > 1
      ? `检测到学校标签：${detectedSchoolTags.join(" / ")}。请确认学校标签筛选（可多选）。`
      : "请确认学校标签筛选（可多选）。";
    pending_questions.push({
      field: "school_tag",
      question: schoolTagQuestion,
      value: searchParams.school_tag,
      options: buildTextOptions(SCHOOL_TAG_OPTIONS)
    });
  }

  if (needs_degree_confirmation) {
    pending_questions.push({
      field: "degree",
      question: "请确认学历筛选（可多选）。",
      value: searchParams.degree,
      options: buildTextOptions(DEGREE_OPTIONS)
    });
  }

  if (needs_gender_confirmation) {
    pending_questions.push({
      field: "gender",
      question: "请确认性别筛选。",
      value: searchParams.gender,
      options: buildTextOptions(GENDER_OPTIONS)
    });
  }

  if (needs_recent_not_view_confirmation) {
    pending_questions.push({
      field: "recent_not_view",
      question: "请确认是否过滤近14天内已看过的人选。",
      value: searchParams.recent_not_view,
      options: buildTextOptions(RECENT_NOT_VIEW_OPTIONS)
    });
  }

  if (needs_filters_confirmation && pending_questions.every((item) => item.field !== "filters")) {
    pending_questions.push({
      field: "filters",
      question: "请确认以上推荐页筛选项整体无误。",
      value: searchParams,
      options: FILTER_CONFIRM_OPTIONS
    });
  }

  if (!screenParams.criteria) {
    pending_questions.push({
      field: "criteria",
      question: "请用自然语言填写本次筛选 criteria（必填，不支持“严格执行/宽松执行”等预设选项）。",
      value: null
    });
  } else if (needs_criteria_confirmation) {
    pending_questions.push({
      field: "criteria",
      question: "请再次确认筛选 criteria（自然语言描述）是否准确；如需调整请直接改写完整 criteria。",
      value: screenParams.criteria
    });
  }

  if (needs_target_count_confirmation) {
    pending_questions.push({
      field: "target_count",
      question: "本次目标通过人数是多少？可留空表示不设上限。",
      value: targetCountResolution.proposed_target_count
    });
  }

  if (needs_post_action_confirmation) {
    pending_questions.push({
      field: "post_action",
      question: "请确认本次运行对通过人选统一执行的动作。",
      value: postActionResolution.proposed_post_action,
      options: [
        { label: POST_ACTION_LABELS.favorite, value: "favorite" },
        { label: POST_ACTION_LABELS.greet, value: "greet" },
        { label: POST_ACTION_LABELS.none, value: "none" }
      ]
    });
  }

  if (needs_max_greet_count_confirmation) {
    pending_questions.push({
      field: "max_greet_count",
      question: maxGreetCountResolution.suspicious_auto_fill
        ? "检测到最大打招呼人数可能是自动默认值，请明确确认本次最多打招呼多少位候选人（必须为正整数）。"
        : "本次选择直接沟通时，最多打招呼多少位候选人？达到上限后会自动改为收藏。",
      value: maxGreetCountResolution.proposed_max_greet_count
    });
  }

  return {
    searchParams,
    screenParams,
    missing_fields,
    suspicious_fields,
    needs_filters_confirmation,
    needs_school_tag_confirmation,
    needs_degree_confirmation,
    needs_gender_confirmation,
    needs_recent_not_view_confirmation,
    needs_criteria_confirmation,
    needs_target_count_confirmation,
    needs_post_action_confirmation,
    needs_max_greet_count_confirmation,
    needs_page_confirmation,
    criteria_normalized: criteriaResolution.normalized,
    proposed_target_count: targetCountResolution.proposed_target_count,
    proposed_post_action: postActionResolution.proposed_post_action,
    proposed_max_greet_count: maxGreetCountResolution.proposed_max_greet_count,
    page_scope: pageScopeResolution.page_scope,
    proposed_page_scope: pageScopeResolution.proposed_page_scope,
    job_selection_hint: jobSelectionHint || null,
    pending_questions,
    review: {
      extracted_page_scope: pageScopeResolution.proposed_page_scope,
      extracted_search_params: searchParams,
      extracted_screen_params: {
        criteria: screenParams.criteria,
        criteria_normalized: criteriaResolution.normalized,
        target_count: targetCountResolution.proposed_target_count,
        post_action: postActionResolution.proposed_post_action,
        max_greet_count: maxGreetCountResolution.proposed_max_greet_count
      },
      current_page_scope: pageScopeResolution.page_scope,
      current_search_params: searchParams,
      current_screen_params: {
        ...screenParams,
        criteria_normalized: criteriaResolution.normalized
      },
      missing_fields,
      suspicious_fields,
      pending_questions
    }
  };
}

export {
  DEGREE_OPTIONS,
  GENDER_OPTIONS,
  POST_ACTION_LABELS,
  POST_ACTION_OPTIONS,
  RECENT_NOT_VIEW_OPTIONS,
  SCHOOL_TAG_OPTIONS
};
