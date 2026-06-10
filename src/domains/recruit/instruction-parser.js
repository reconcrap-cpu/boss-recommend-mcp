const SEARCH_SCHOOL_MAP = {
  "统招": "统招本科",
  "统招本科": "统招本科",
  "统招本": "统招本科",
  "全日制本科": "统招本科",
  "双一流": "双一流院校",
  "双一流院校": "双一流院校",
  "双一流学校": "双一流院校",
  "985": "985院校",
  "985院校": "985院校",
  "211": "211院校",
  "211院校": "211院校",
  "qs": "QS 100",
  "qs100": "QS 100",
  "qs500": "QS 500"
};

const KNOWN_SCHOOL_LABELS = new Set(Object.values(SEARCH_SCHOOL_MAP));
const DEFAULT_PARAM_VALUES = {
  job: null,
  city: null,
  degree: "不限",
  schools: [],
  experience: null,
  gender: null,
  age: null,
  keyword: null,
  target_count: null,
  criteria: null
};
const DEFAULT_PARAM_LABELS = {
  job: "搜索页岗位未指定",
  city: "不限城市",
  degree: "不限",
  schools: "不限院校标签",
  experience: "经验要求未指定",
  gender: "性别未指定",
  age: "年龄要求未指定",
  keyword: "搜索关键词未指定",
  target_count: "目标通过人数未指定",
  criteria: "筛选 criteria 未指定"
};
const DEGREE_VALUES = new Set(["不限", "本科", "本科及以上", "硕士及以上", "博士"]);
const CITY_STOP_PATTERN = /(?:筛选|搜索|查找|找|做过|从事过|有过|相关|的人选|的人|并且|且|学历|学校|经验|性别|年龄|目标|必须|优先|，|。|；|;|,)/;
const POST_ACTIONS = new Set(["none", "greet"]);
const CRITERIA_MARKER_PATTERN = /(?:筛选条件|筛选标准|筛选要求|筛选规则|硬性条件|硬条件|criteria)\s*[：:]/i;
const CRITERIA_TRAILING_FIELD_PATTERN = /\n\s*(?:岗位|职位|关键词|城市|地点|工作地|学历|学校类型|院校标签|经验|经验要求|工作经验|工作年限|性别|年龄|年龄要求|年龄范围|只看未查看|目标筛选人数|目标人数|休息强度|后置动作|post_action|rest_level)\s*[：:]/i;

function normalizeText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function normalizeCriteriaBlock(input) {
  const lines = String(input || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.join("\n").trim() || null;
}

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFieldLineValue(rawText, labels = []) {
  const lines = String(rawText || "").replace(/\r\n/g, "\n").split("\n");
  const labelPattern = labels.map(escapeRegExp).join("|");
  if (!labelPattern) return null;
  const pattern = new RegExp(`^\\s*(?:${labelPattern})(?:\\s*\\([^)]*\\))?\\s*[：:]\\s*(.+?)\\s*$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    const value = match?.[1]?.trim();
    if (value) return value;
  }
  return null;
}

function uniqueList(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function normalizeSchoolLabel(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^(?:不限|不限制|无限制|全部|所有|无|none|all)$/i.test(raw)) return null;
  if (KNOWN_SCHOOL_LABELS.has(raw)) return raw;

  const compact = raw.toLowerCase().replace(/\s+/g, "");
  const qsMatch = compact.match(/^qs(\d+)$/);
  if (qsMatch) {
    const rank = Number.parseInt(qsMatch[1], 10);
    if (Number.isFinite(rank)) return rank > 100 ? SEARCH_SCHOOL_MAP.qs500 : SEARCH_SCHOOL_MAP.qs100;
  }
  return SEARCH_SCHOOL_MAP[compact] || SEARCH_SCHOOL_MAP[raw] || raw;
}

function sanitizeCityCandidate(value) {
  if (typeof value !== "string") return null;
  let candidate = value.trim();
  if (!candidate) return null;
  candidate = candidate.replace(/^(在|是|为)\s*/, "").trim();
  const stopIndex = candidate.search(CITY_STOP_PATTERN);
  if (stopIndex >= 0) candidate = candidate.slice(0, stopIndex).trim();
  candidate = candidate.replace(/[的\s]+$/g, "").trim();
  return candidate || null;
}

function extractCity(text) {
  const patterns = [
    /地点(?:在|是|为|:|：)?\s*([^\n，。；;、]+)/i,
    /城市(?:在|是|为|:|：)?\s*([^\n，。；;、]+)/i,
    /工作地(?:在|是|为|:|：)?\s*([^\n，。；;、]+)/i,
    /base(?:在|是|为|:|：)?\s*([^\n，。；;、]+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const city = sanitizeCityCandidate(match[1]);
      if (city) return city;
    }
  }
  return null;
}

function extractDegree(text) {
  if (/(博士及以上|博士)/.test(text)) return "博士";
  if (/(硕士及以上|硕士以上)/.test(text)) return "硕士及以上";
  if (/硕士/.test(text)) return "硕士";
  if (/(本科及以上|本科以上)/.test(text)) return "本科及以上";
  if (/本科/.test(text)) return "本科";
  return null;
}

function extractSchools(text) {
  const schools = [];
  if (/统招(?:本科)?/.test(text)) schools.push(SEARCH_SCHOOL_MAP["统招"]);
  if (/双一流(?:院校|学校)?/.test(text)) schools.push(SEARCH_SCHOOL_MAP["双一流"]);
  if (/(^|[^0-9])985([^0-9]|$)/.test(text)) schools.push(SEARCH_SCHOOL_MAP["985"]);
  if (/(^|[^0-9])211([^0-9]|$)/.test(text)) schools.push(SEARCH_SCHOOL_MAP["211"]);
  const qsMatches = text.matchAll(/\bqs\s*(\d+)\b/ig);
  for (const match of qsMatches) {
    const rank = Number.parseInt(match[1], 10);
    if (Number.isFinite(rank)) schools.push(rank > 100 ? SEARCH_SCHOOL_MAP.qs500 : SEARCH_SCHOOL_MAP.qs100);
  }
  return uniqueList(schools);
}

function extractRecentViewedFilter(text) {
  const negativePatterns = [
    /(?:不|别|无需|不用|不要).{0,6}(?:过滤|排除|去掉|剔除).{0,8}(?:近?14天(?:内)?查看(?:过)?)/i,
    /(?:保留|包含).{0,8}(?:近?14天(?:内)?查看(?:过)?)/i,
    /(?:近?14天(?:内)?查看(?:过)?).{0,8}(?:不要|不用|无需|不需要|不必).{0,4}(?:过滤|排除|去掉|剔除)/i
  ];
  if (negativePatterns.some((pattern) => pattern.test(text))) return false;

  const positivePatterns = [
    /(?:过滤|排除|去掉|剔除).{0,8}(?:近?14天(?:内)?查看(?:过)?)/i,
    /(?:近?14天(?:内)?查看(?:过)?).{0,8}(?:过滤|排除|去掉|剔除)/i
  ];
  if (positivePatterns.some((pattern) => pattern.test(text))) return true;
  return null;
}

function normalizeRecentViewedOverride(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (["true", "yes", "1", "需要过滤", "过滤", "近14天没有", "not_viewed"].includes(normalized)) return true;
  if (["false", "no", "0", "不过滤", "不限", "none"].includes(normalized)) return false;
  return null;
}

function normalizeStringOverride(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeSchoolsOverride(value) {
  if (Array.isArray(value)) {
    return uniqueList(value.flatMap((item) => normalizeSchoolsOverride(item) || []));
  }
  if (typeof value === "string") return uniqueList(value.split(/[，,、|/]/).map(normalizeSchoolLabel));
  return null;
}

function extractSchoolFilterExplicit(rawText) {
  const value = extractFieldLineValue(rawText, [
    "学校",
    "院校",
    "学校类型",
    "院校标签",
    "学校标签",
    "school",
    "school_tag",
    "school_tags",
    "schools"
  ]);
  if (value === null) return { explicit: false, schools: null };
  return { explicit: true, schools: normalizeSchoolsOverride(value) || [] };
}

function extractRecentViewedExplicit(rawText) {
  const value = extractFieldLineValue(rawText, ["只看未查看", "过滤已看", "recent_not_view", "filter_recent_viewed"]);
  return value === null ? null : normalizeRecentViewedOverride(value);
}

function normalizeDegreesOverride(value) {
  if (Array.isArray(value)) return uniqueList(value.map(normalizeText));
  if (typeof value === "string") return uniqueList(value.split(/[，,、|/]/).map(normalizeText));
  return null;
}

function normalizeExperienceOverride(value) {
  if (typeof value === "string") return normalizeText(value) || null;
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeText).filter(Boolean);
    return normalized.length ? normalized[0] : null;
  }
  if (value && typeof value === "object") return value;
  return null;
}

function normalizeGenericSearchFilterOverride(value) {
  if (typeof value === "string" || typeof value === "number") return normalizeText(value) || null;
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeText).filter(Boolean);
    return normalized.length ? normalized[0] : null;
  }
  if (value && typeof value === "object") return value;
  return null;
}

function normalizeDegreeFieldValue(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (/^(?:不限|不限制|无限制|全部|所有|无|none|all)$/i.test(normalized)) return "不限";
  return extractDegree(normalized) || normalized;
}

function normalizePostAction(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["", "none", "skip", "no", "不执行", "无", "什么也不做"].includes(normalized)) return "none";
  if (["greet", "chat", "打招呼", "直接沟通", "沟通"].includes(normalized)) return "greet";
  return POST_ACTIONS.has(normalized) ? normalized : "";
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractKeywordExplicit(text) {
  const patterns = [
    /搜索关键词(?:为|是|:|：)?\s*([^\n，。；;]+)/i,
    /关键词(?:为|是|:|：)?\s*([^\n，。；;]+)/i,
    /keyword(?:\s*[:：=]\s*|\s+is\s+)([^\n，。；;]+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const keyword = match?.[1]?.trim();
    if (keyword) return keyword;
  }
  return null;
}

function extractKeywordAuto(text) {
  const patterns = [
    /做过\s*([A-Za-z0-9+#./\-\s]{2,40}?)(?:的人选|的人|相关|并且|且|，|。|,|$)/i,
    /有过\s*([A-Za-z0-9+#./\-\s]{2,40}?)(?:经验|背景|的人选|并且|且|，|。|,|$)/i,
    /从事过\s*([A-Za-z0-9+#./\-\s]{2,40}?)(?:相关|的人选|并且|且|，|。|,|$)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const keyword = match?.[1]?.replace(/\s+/g, " ").trim();
    if (keyword && keyword.length >= 2) return keyword;
  }
  return null;
}

function extractJobExplicit(text) {
  const patterns = [
    /(?:搜索页)?(?:岗位|职位)(?:名称)?(?:为|是|:|：)?\s*([^\n，。；;]+)/i,
    /job(?:\s*title)?(?:\s*[:：=]\s*|\s+is\s+)([^\n，。；;]+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const job = match?.[1]?.trim();
    if (job) return job;
  }
  return null;
}

function extractTargetCount(text) {
  const patterns = [
    /至少筛选\s*(\d+)\s*位?/i,
    /目标(?:筛选)?(?:人数|数量)?(?:为|是|:|：)?\s*(\d+)/i,
    /目标(?:筛选)?(?:人数|数量)?\s*(\d+)\s*人/i,
    /筛选\s*(\d+)\s*位/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

function extractPostAction(text) {
  if (/(?:什么也不做|不(?:打招呼|沟通)|只筛选|不执行)/.test(text)) return "none";
  if (/(?:直接沟通|打招呼|立即沟通|greet|post_action\s*[:：=]\s*greet)/i.test(text)) return "greet";
  return "";
}

function extractTargetCountExplicit(rawText) {
  const value = extractFieldLineValue(rawText, ["目标筛选人数", "目标人数", "目标通过人数", "target_count", "max_candidates"]);
  return parsePositiveInteger(value);
}

function extractPostActionExplicit(rawText) {
  const value = extractFieldLineValue(rawText, ["后置动作", "通过后执行动作", "post_action"]);
  return normalizePostAction(value);
}

function extractExplicitCriteria(rawText) {
  const normalized = String(rawText || "").replace(/\r\n/g, "\n");
  const match = normalized.match(CRITERIA_MARKER_PATTERN);
  if (!match) return null;
  let criteria = normalized.slice(match.index + match[0].length).trim();
  const trailingFieldIndex = criteria.search(CRITERIA_TRAILING_FIELD_PATTERN);
  if (trailingFieldIndex > 0) criteria = criteria.slice(0, trailingFieldIndex).trim();
  return normalizeCriteriaBlock(criteria);
}

function resolveKeyword(parsed, confirmation) {
  if (parsed.keyword_override) {
    return { keyword: parsed.keyword_override, needsConfirmation: false, proposedKeyword: null };
  }
  const explicit = parsed.keyword_explicit;
  const auto = parsed.keyword_auto;
  const confirmed = confirmation?.keyword_confirmed === true;
  const rejected = confirmation?.keyword_confirmed === false;
  const value = typeof confirmation?.keyword_value === "string" ? confirmation.keyword_value.trim() : "";
  if (confirmed && value) return { keyword: value, needsConfirmation: false, proposedKeyword: null };
  if (explicit) return { keyword: explicit, needsConfirmation: false, proposedKeyword: null };
  if (rejected) return { keyword: value || null, needsConfirmation: false, proposedKeyword: null };
  if (auto) {
    if (confirmed) return { keyword: auto, needsConfirmation: false, proposedKeyword: null };
    return { keyword: null, needsConfirmation: true, proposedKeyword: auto };
  }
  return { keyword: null, needsConfirmation: false, proposedKeyword: null };
}

function resolveJob(parsed, confirmation) {
  if (parsed.job_override) return parsed.job_override;
  const confirmed = confirmation?.job_confirmed === true;
  const value = typeof confirmation?.job_value === "string" ? confirmation.job_value.trim() : "";
  if (confirmed && value) return value;
  return parsed.job_explicit || null;
}

function resolvePostAction(parsed, confirmation) {
  const confirmed = confirmation?.post_action_confirmed === true;
  const confirmationValue = normalizePostAction(confirmation?.post_action_value);
  return parsed.post_action_override
    || (confirmed && confirmationValue ? confirmationValue : "")
    || parsed.post_action_explicit
    || "none";
}

function resolveMaxGreetCount(parsed, confirmation) {
  return parsePositiveInteger(confirmation?.max_greet_count_value)
    || parsePositiveInteger(parsed.max_greet_count_override)
    || null;
}

function collectMissingFields(searchParams, screenParams, parsed = {}) {
  const missing = [];
  if (!searchParams.job) missing.push("job");
  if (!searchParams.city && !parsed.city_explicit) missing.push("city");
  if (!searchParams.degree && !searchParams.degrees?.length && !parsed.degree_explicit) missing.push("degree");
  if (!searchParams.schools?.length && !parsed.schools_explicit) missing.push("schools");
  if (!searchParams.keyword) missing.push("keyword");
  if (!screenParams.criteria) missing.push("criteria");
  if (!screenParams.target_count) missing.push("target_count");
  return missing;
}

function collectUnresolvedMissingFields(missingFields, appliedDefaults) {
  return missingFields.filter((field) => !Object.prototype.hasOwnProperty.call(appliedDefaults, field));
}

function collectSuspiciousFields(searchParams, screenParams) {
  const suspicious = [];
  if (searchParams.city && (/\s/.test(searchParams.city) || CITY_STOP_PATTERN.test(searchParams.city) || searchParams.city.length > 8)) {
    suspicious.push({
      field: "city",
      value: searchParams.city,
      reason: "城市提取结果看起来包含多余短语，请确认是否为标准城市名。"
    });
  }
  if (searchParams.degree && !DEGREE_VALUES.has(searchParams.degree)) {
    suspicious.push({
      field: "degree",
      value: searchParams.degree,
      reason: "学历提取结果不在预期枚举内，请确认。"
    });
  }
  if (searchParams.keyword && /城市|学历|学校|目标人数|目标数量|筛选\d+位/i.test(searchParams.keyword)) {
    suspicious.push({
      field: "keyword",
      value: searchParams.keyword,
      reason: "关键词看起来混入了筛选条件，请确认是否只保留核心方向词。"
    });
  }
  if (screenParams.target_count && (!Number.isInteger(screenParams.target_count) || screenParams.target_count <= 0)) {
    suspicious.push({
      field: "target_count",
      value: screenParams.target_count,
      reason: "目标人数不是有效正整数，请确认。"
    });
  }
  return suspicious;
}

function buildMissingFieldQuestions(missingFields = [], defaultPreview = {}) {
  const questions = {
    job: "请填写搜索页岗位名称（关键词输入框旁边的岗位选择）。",
    city: "请填写城市；如不限城市，请明确回复不限。",
    degree: "请填写学历筛选；如不限学历，请明确回复不限。",
    schools: "请填写院校标签；如不限院校标签，请明确回复不限。",
    keyword: "请填写搜索关键词。",
    criteria: "请填写本次筛选 criteria（完整自然语言硬条件）。",
    target_count: "请填写本次目标通过人数。"
  };
  return missingFields.map((field) => ({
    field,
    question: questions[field] || `请填写 ${field}。`,
    value: Object.prototype.hasOwnProperty.call(defaultPreview, field) ? defaultPreview[field] : null
  }));
}

function buildDefaultPreview(missingFields, { skipKeywordDefault = false } = {}) {
  return missingFields.reduce((acc, field) => {
    if (field === "keyword" && skipKeywordDefault) return acc;
    if (!["city", "degree", "schools"].includes(field)) return acc;
    acc[field] = DEFAULT_PARAM_LABELS[field];
    return acc;
  }, {});
}

function applyDefaults(searchParams, screenParams, missingFields, useDefaultForMissing, { skipKeywordDefault = false } = {}) {
  if (!useDefaultForMissing) {
    return { searchParams, screenParams, appliedDefaults: {} };
  }
  const appliedDefaults = {};
  const nextSearchParams = { ...searchParams };
  const nextScreenParams = { ...screenParams };
  if (missingFields.includes("city")) {
    nextSearchParams.city = DEFAULT_PARAM_VALUES.city;
    appliedDefaults.city = DEFAULT_PARAM_LABELS.city;
  }
  if (missingFields.includes("degree")) {
    nextSearchParams.degree = DEFAULT_PARAM_VALUES.degree;
    appliedDefaults.degree = DEFAULT_PARAM_LABELS.degree;
  }
  if (missingFields.includes("schools")) {
    nextSearchParams.schools = DEFAULT_PARAM_VALUES.schools.slice();
    appliedDefaults.schools = DEFAULT_PARAM_LABELS.schools;
  }
  return {
    searchParams: nextSearchParams,
    screenParams: nextScreenParams,
    appliedDefaults
  };
}

export function parseRecruitInstruction({ instruction, confirmation, overrides } = {}) {
  const rawInstruction = String(instruction || "");
  const text = normalizeText(rawInstruction);
  const finalConfirmed = confirmation?.final_confirmed === true;
  const explicitSchools = extractSchoolFilterExplicit(rawInstruction);
  const explicitRecentViewed = extractRecentViewedExplicit(rawInstruction);
  const explicitKeyword = extractFieldLineValue(rawInstruction, ["搜索关键词", "关键词", "keyword"]);
  const explicitJob = extractFieldLineValue(rawInstruction, ["岗位", "职位", "job"]);
  const explicitCity = extractFieldLineValue(rawInstruction, ["城市", "地点", "工作地", "base"]);
  const explicitDegree = extractFieldLineValue(rawInstruction, ["学历", "degree"]);
  const explicitExperience = extractFieldLineValue(rawInstruction, ["经验", "经验要求", "工作经验", "工作年限", "experience"]);
  const explicitGender = extractFieldLineValue(rawInstruction, ["性别", "gender"]);
  const explicitAge = extractFieldLineValue(rawInstruction, ["年龄", "年龄要求", "年龄范围", "age"]);
  const explicitTargetCount = extractTargetCountExplicit(rawInstruction);
  const explicitPostAction = extractPostActionExplicit(rawInstruction);
  const parsed = {
    job_explicit: explicitJob || extractJobExplicit(text),
    city: sanitizeCityCandidate(explicitCity) || extractCity(text),
    city_explicit: explicitCity !== null,
    degree: normalizeDegreeFieldValue(explicitDegree) || extractDegree(text),
    degree_explicit: explicitDegree !== null,
    experience: normalizeExperienceOverride(explicitExperience),
    experience_explicit: explicitExperience !== null,
    gender: normalizeGenericSearchFilterOverride(explicitGender),
    gender_explicit: explicitGender !== null,
    age: normalizeGenericSearchFilterOverride(explicitAge),
    age_explicit: explicitAge !== null,
    schools: explicitSchools.explicit ? explicitSchools.schools : extractSchools(text),
    schools_explicit: explicitSchools.explicit,
    filter_recent_viewed: explicitRecentViewed !== null ? explicitRecentViewed : extractRecentViewedFilter(text),
    keyword_explicit: explicitKeyword || extractKeywordExplicit(text),
    keyword_auto: extractKeywordAuto(text),
    target_count: explicitTargetCount || extractTargetCount(text),
    post_action_explicit: explicitPostAction || extractPostAction(text),
    criteria_explicit: extractExplicitCriteria(rawInstruction)
  };

  if (overrides) {
    const overrideCity = sanitizeCityCandidate(normalizeStringOverride(overrides.city));
    const overrideDegree = normalizeStringOverride(overrides.degree);
    const overrideDegrees = normalizeDegreesOverride(overrides.degrees || (Array.isArray(overrides.degree) ? overrides.degree : null));
    const hasOverrideSchools = Object.prototype.hasOwnProperty.call(overrides, "schools")
      || Object.prototype.hasOwnProperty.call(overrides, "school_tag")
      || Object.prototype.hasOwnProperty.call(overrides, "school_tags");
    const overrideSchools = normalizeSchoolsOverride(
      Object.prototype.hasOwnProperty.call(overrides, "schools")
        ? overrides.schools
        : Object.prototype.hasOwnProperty.call(overrides, "school_tag")
          ? overrides.school_tag
          : overrides.school_tags
    );
    const overrideKeyword = normalizeStringOverride(overrides.keyword);
    const overrideJob = normalizeStringOverride(overrides.job || overrides.job_title || overrides.selected_job);
    const overrideCriteria = normalizeStringOverride(overrides.criteria);
    const hasOverrideExperience = Object.prototype.hasOwnProperty.call(overrides, "experience")
      || Object.prototype.hasOwnProperty.call(overrides, "experiences")
      || Object.prototype.hasOwnProperty.call(overrides, "experience_range")
      || Object.prototype.hasOwnProperty.call(overrides, "experience_start")
      || Object.prototype.hasOwnProperty.call(overrides, "experience_end");
    const overrideExperience = Object.prototype.hasOwnProperty.call(overrides, "experience")
      ? normalizeExperienceOverride(overrides.experience)
      : Object.prototype.hasOwnProperty.call(overrides, "experiences")
        ? normalizeExperienceOverride(overrides.experiences)
        : Object.prototype.hasOwnProperty.call(overrides, "experience_range")
          ? normalizeExperienceOverride(overrides.experience_range)
          : hasOverrideExperience
            ? {
              start: overrides.experience_start,
              end: overrides.experience_end
            }
            : null;
    const hasOverrideGender = Object.prototype.hasOwnProperty.call(overrides, "gender");
    const overrideGender = hasOverrideGender ? normalizeGenericSearchFilterOverride(overrides.gender) : null;
    const hasOverrideAge = Object.prototype.hasOwnProperty.call(overrides, "age")
      || Object.prototype.hasOwnProperty.call(overrides, "ages")
      || Object.prototype.hasOwnProperty.call(overrides, "age_range")
      || Object.prototype.hasOwnProperty.call(overrides, "age_min")
      || Object.prototype.hasOwnProperty.call(overrides, "age_max")
      || Object.prototype.hasOwnProperty.call(overrides, "min_age")
      || Object.prototype.hasOwnProperty.call(overrides, "max_age");
    const overrideAge = Object.prototype.hasOwnProperty.call(overrides, "age")
      ? normalizeGenericSearchFilterOverride(overrides.age)
      : Object.prototype.hasOwnProperty.call(overrides, "ages")
        ? normalizeGenericSearchFilterOverride(overrides.ages)
        : Object.prototype.hasOwnProperty.call(overrides, "age_range")
          ? normalizeGenericSearchFilterOverride(overrides.age_range)
          : hasOverrideAge
            ? {
              min: overrides.age_min ?? overrides.min_age,
              max: overrides.age_max ?? overrides.max_age
            }
            : null;
    const overrideRecentViewed = normalizeRecentViewedOverride(
      Object.prototype.hasOwnProperty.call(overrides, "filter_recent_viewed")
        ? overrides.filter_recent_viewed
        : overrides.recent_not_view
    );
    const overridePostAction = normalizePostAction(overrides.post_action);
    if (overrideCity) parsed.city = overrideCity;
    if (overrideDegree) parsed.degree = overrideDegree;
    if (overrideDegrees?.length) parsed.degrees = overrideDegrees;
    if (Object.prototype.hasOwnProperty.call(overrides, "city")) parsed.city_explicit = true;
    if (Object.prototype.hasOwnProperty.call(overrides, "degree") || Object.prototype.hasOwnProperty.call(overrides, "degrees")) {
      parsed.degree_explicit = true;
    }
    if (hasOverrideSchools && Array.isArray(overrideSchools)) {
      parsed.schools = overrideSchools;
      parsed.schools_explicit = true;
    }
    if (hasOverrideExperience) {
      parsed.experience = overrideExperience;
      parsed.experience_explicit = true;
    }
    if (hasOverrideGender) {
      parsed.gender = overrideGender;
      parsed.gender_explicit = true;
    }
    if (hasOverrideAge) {
      parsed.age = overrideAge;
      parsed.age_explicit = true;
    }
    if (overrideKeyword) parsed.keyword_override = overrideKeyword;
    if (overrideJob) parsed.job_override = overrideJob;
    if (overrideCriteria) parsed.criteria_override = overrideCriteria;
    if (overrideRecentViewed !== null) parsed.filter_recent_viewed = overrideRecentViewed;
    if (overridePostAction) parsed.post_action_override = overridePostAction;
    if (Number.isFinite(overrides.max_greet_count) && overrides.max_greet_count > 0) {
      parsed.max_greet_count_override = Number.parseInt(String(overrides.max_greet_count), 10);
    }
    if (Number.isFinite(overrides.target_count) && overrides.target_count > 0) {
      parsed.target_count = Number.parseInt(String(overrides.target_count), 10);
    }
  }

  const keywordResolution = resolveKeyword(parsed, confirmation);
  const job = resolveJob(parsed, confirmation);
  const postAction = resolvePostAction(parsed, confirmation);
  const maxGreetCount = resolveMaxGreetCount(parsed, confirmation);
  const confirmationCriteria = normalizeStringOverride(confirmation?.criteria_value);
  const baseSearchParams = {
    job,
    city: parsed.city,
    degree: parsed.degree,
    degrees: parsed.degrees,
    schools: parsed.schools,
    experience: parsed.experience,
    gender: parsed.gender,
    age: parsed.age,
    filter_recent_viewed: parsed.filter_recent_viewed,
    keyword: keywordResolution.keyword
  };
  const criteria = parsed.criteria_override || confirmationCriteria || parsed.criteria_explicit || null;
  const criteriaSource = parsed.criteria_override
    ? "override"
    : confirmationCriteria
      ? "confirmation"
      : parsed.criteria_explicit
        ? "instruction_block"
        : "missing";
  const baseScreenParams = {
    criteria,
    target_count: parsed.target_count,
    post_action: postAction,
    max_greet_count: maxGreetCount
  };
  const missingBeforeDefaults = collectMissingFields(baseSearchParams, baseScreenParams, parsed);

  const useDefaultForMissing = finalConfirmed || confirmation?.use_default_for_missing === true;
  const skipKeywordDefault = keywordResolution.needsConfirmation;
  const defaultPreview = buildDefaultPreview(missingBeforeDefaults, { skipKeywordDefault });
  const { searchParams, screenParams, appliedDefaults } = applyDefaults(
    baseSearchParams,
    baseScreenParams,
    missingBeforeDefaults,
    useDefaultForMissing,
    { skipKeywordDefault }
  );
  const missingAfterDefaults = collectUnresolvedMissingFields(missingBeforeDefaults, appliedDefaults);
  const suspicious_fields = collectSuspiciousFields(searchParams, screenParams);
  const needs_recent_viewed_filter_confirmation = !finalConfirmed && searchParams.filter_recent_viewed === null;
  const needs_criteria_confirmation = Boolean(screenParams.criteria) && !finalConfirmed && confirmation?.criteria_confirmed !== true;
  const pending_questions = [
    ...buildMissingFieldQuestions(missingAfterDefaults, defaultPreview),
    ...(needs_recent_viewed_filter_confirmation
      ? [{
        field: "filter_recent_viewed",
        question: "是否需要过滤近14天查看过的人选？",
        options: [
          { label: "需要过滤", value: true },
          { label: "不过滤", value: false }
        ]
      }]
      : []),
    ...(needs_criteria_confirmation
      ? [{
        field: "criteria",
        question: "请确认筛选 criteria 是否准确无误（尤其是硬性约束条件）？",
        value: baseScreenParams.criteria
      }]
      : [])
  ];
  const review = {
    extracted_search_params: baseSearchParams,
    extracted_screen_params: baseScreenParams,
    current_search_params: searchParams,
    current_screen_params: screenParams,
    missing_fields: missingAfterDefaults,
    missing_fields_before_defaults: missingBeforeDefaults,
    has_unresolved_missing_fields: missingAfterDefaults.length > 0,
    suspicious_fields,
    pending_questions,
    default_preview: defaultPreview,
    applied_defaults: appliedDefaults,
    criteria_source: criteriaSource,
    final_confirmed: finalConfirmed
  };

  return {
    parsed,
    searchParams,
    screenParams,
    missing_fields: missingAfterDefaults,
    has_unresolved_missing_fields: missingAfterDefaults.length > 0,
    suspicious_fields,
    needs_keyword_confirmation: keywordResolution.needsConfirmation,
    needs_recent_viewed_filter_confirmation,
    needs_criteria_confirmation,
    needs_search_params_confirmation: !finalConfirmed && confirmation?.search_params_confirmed !== true,
    proposed_keyword: keywordResolution.proposedKeyword,
    pending_questions,
    default_preview: defaultPreview,
    applied_defaults: appliedDefaults,
    review
  };
}

export const recruitInstructionParserSemantics = Object.freeze({
  source: "boss-recruit-mcp/src/parser.js",
  imported_at: "2026-04-30",
  default_param_values: DEFAULT_PARAM_VALUES,
  school_labels: SEARCH_SCHOOL_MAP,
  degree_values: Array.from(DEGREE_VALUES),
  experience_values: ["不限", "在校/应届", "25年毕业", "26年毕业", "26年后毕业", "1-3年", "3-5年", "5-10年", "自定义"],
  gender_values: ["不限", "男", "女"],
  age_values: ["不限", "20-25", "25-30", "30-35", "35-40", "40-50", "50以上", "自定义"]
});
