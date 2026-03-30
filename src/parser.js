const SCHOOL_TAG_OPTIONS = [
  "不限",
  "985",
  "211",
  "双一流院校",
  "留学",
  "国内外名校",
  "公办本科"
];
const GENDER_OPTIONS = ["不限", "男", "女"];
const RECENT_NOT_VIEW_OPTIONS = ["不限", "近14天没有"];
const POST_ACTION_OPTIONS = ["favorite", "greet"];
const POST_ACTION_LABELS = {
  favorite: "收藏",
  greet: "直接沟通"
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
  { label: "留学", pattern: /留学|留学生/i },
  { label: "国内外名校", pattern: /国内外名校|名校/i },
  { label: "公办本科", pattern: /公办本科/i }
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
  /目标(?:处理|筛选)?(?:人数|数量)?(?:为|是|:|：)?\s*(\d+)/i,
  /至少(?:处理|筛选)\s*(\d+)\s*(?:位|人)/i,
  /(?:处理|筛选)\s*(\d+)\s*(?:位|人)/i
];
const MAX_GREET_COUNT_PATTERNS = [
  /最多(?:打招呼|沟通|联系)\s*(\d+)\s*(?:位|人|个)?/i,
  /(?:打招呼|沟通|联系)(?:上限|最多|不超过|至多)(?:为|是|:|：)?\s*(\d+)/i
];
const FILTER_CLAUSE_PATTERNS = [
  /学校标签|院校标签|985|211|双一流|留学|国内外名校|公办本科/i,
  /性别|男生|女生|男性|女性|男\b|女\b/i,
  /近?14天(?:内)?没有|近?14天(?:内)?没看过|近?14天(?:内)?未查看|过滤[^。；;\n]{0,12}14天|排除[^。；;\n]{0,12}14天/i,
  /目标(?:处理|筛选)?(?:人数|数量)?|至少(?:处理|筛选)|(?:处理|筛选)\s*\d+\s*(?:位|人)/i,
  /最多(?:打招呼|沟通|联系)|(?:打招呼|沟通|联系)(?:上限|最多|不超过|至多)/i,
  /收藏|打招呼|直接沟通/i
];
const META_CLAUSE_PATTERNS = [
  /推荐页|推荐页面|boss推荐/i,
  /帮我|请|运行|skill/i
];

function normalizeText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function parsePositiveIntegerValue(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function uniqueList(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function normalizeSchoolTag(value) {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  if (normalized === "双一流") return "双一流院校";
  if (SCHOOL_TAG_OPTIONS.includes(normalized)) return normalized;
  return null;
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
  if (normalized === "近14天未看" || normalized === "近14天没有" || normalized === "近14天没看过") {
    return "近14天没有";
  }
  if (normalized === "不限") return "不限";
  return RECENT_NOT_VIEW_OPTIONS.includes(normalized) ? normalized : null;
}

function normalizePostAction(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (["favorite", "fav", "收藏"].includes(normalized)) return "favorite";
  if (["greet", "chat", "打招呼", "直接沟通", "沟通"].includes(normalized)) return "greet";
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

function buildCriteria(text, overrideCriteria) {
  const normalizedOverride = normalizeText(overrideCriteria);
  if (normalizedOverride) {
    return normalizedOverride;
  }

  const clauses = sanitizeInstruction(text)
    .split(/[，,。；;\n]/)
    .map((item) => sanitizeClause(item))
    .filter(Boolean);

  const filtered = clauses.filter((clause) => {
    if (FILTER_CLAUSE_PATTERNS.some((pattern) => pattern.test(clause))) return false;
    if (META_CLAUSE_PATTERNS.some((pattern) => pattern.test(clause))) return false;
    return true;
  });

  const result = uniqueList(filtered.map(normalizeText)).join("；");
  return result || null;
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
      needs_max_greet_count_confirmation: false
    };
  }

  const overrideValue = parsePositiveIntegerValue(overrides?.max_greet_count);
  const confirmed = confirmation?.max_greet_count_confirmed === true;
  const confirmationValue = parsePositiveIntegerValue(confirmation?.max_greet_count_value);
  const instructionValue = extractMaxGreetCount(instruction);
  const proposed = overrideValue || confirmationValue || instructionValue || null;
  const resolved = overrideValue || (confirmed ? confirmationValue : null);

  return {
    max_greet_count: resolved,
    proposed_max_greet_count: proposed,
    needs_max_greet_count_confirmation: !(Number.isInteger(resolved) && resolved > 0)
  };
}

function collectSuspiciousFields({ detectedSchoolTags }) {
  const suspicious = [];
  if (detectedSchoolTags.length > 1) {
    suspicious.push({
      field: "school_tag",
      value: detectedSchoolTags,
      reason: "推荐页学校标签当前是单选，指令里同时提到了多个学校标签，请确认最终要应用哪一个。"
    });
  }
  return suspicious;
}

export function parseRecommendInstruction({ instruction, confirmation, overrides }) {
  const text = normalizeText(instruction);
  const detectedSchoolTags = extractSchoolTags(text);
  const overrideSchoolTag = normalizeSchoolTag(overrides?.school_tag);
  const overrideGender = normalizeGender(overrides?.gender);
  const overrideRecentNotView = normalizeRecentNotView(overrides?.recent_not_view);
  const overrideCriteria = overrides?.criteria;

  const searchParams = {
    school_tag: overrideSchoolTag || detectedSchoolTags[0] || "不限",
    gender: overrideGender || extractGender(text) || "不限",
    recent_not_view: overrideRecentNotView || extractRecentNotView(text) || "不限"
  };
  const screenParams = {
    criteria: buildCriteria(text, overrideCriteria),
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

  const suspicious_fields = collectSuspiciousFields({ detectedSchoolTags });
  const needs_filters_confirmation = confirmation?.filters_confirmed !== true;
  const needs_criteria_confirmation = confirmation?.criteria_confirmed !== true;
  const needs_target_count_confirmation = targetCountResolution.needs_target_count_confirmation;
  const needs_post_action_confirmation = postActionResolution.needs_post_action_confirmation;
  const needs_max_greet_count_confirmation = maxGreetCountResolution.needs_max_greet_count_confirmation;
  const pending_questions = [];

  if (needs_filters_confirmation) {
    pending_questions.push({
      field: "filters",
      question: "请确认推荐页筛选项是否正确。",
      value: searchParams
    });
  }

  if (needs_criteria_confirmation && screenParams.criteria) {
    pending_questions.push({
      field: "criteria",
      question: "请确认筛选 criteria 是否准确无误。",
      value: screenParams.criteria
    });
  }

  if (needs_target_count_confirmation) {
    pending_questions.push({
      field: "target_count",
      question: "本次目标筛选人数是多少？可留空表示不设上限。",
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
        { label: POST_ACTION_LABELS.greet, value: "greet" }
      ]
    });
  }

  if (needs_max_greet_count_confirmation) {
    pending_questions.push({
      field: "max_greet_count",
      question: "本次选择直接沟通时，最多打招呼多少位候选人？达到上限后会自动改为收藏。",
      value: maxGreetCountResolution.proposed_max_greet_count
    });
  }

  return {
    searchParams,
    screenParams,
    missing_fields,
    suspicious_fields,
    needs_filters_confirmation,
    needs_criteria_confirmation,
    needs_target_count_confirmation,
    needs_post_action_confirmation,
    needs_max_greet_count_confirmation,
    proposed_target_count: targetCountResolution.proposed_target_count,
    proposed_post_action: postActionResolution.proposed_post_action,
    proposed_max_greet_count: maxGreetCountResolution.proposed_max_greet_count,
    pending_questions,
    review: {
      extracted_search_params: searchParams,
      extracted_screen_params: {
        criteria: screenParams.criteria,
        target_count: targetCountResolution.proposed_target_count,
        post_action: postActionResolution.proposed_post_action,
        max_greet_count: maxGreetCountResolution.proposed_max_greet_count
      },
      current_search_params: searchParams,
      current_screen_params: screenParams,
      missing_fields,
      suspicious_fields,
      pending_questions
    }
  };
}

export {
  GENDER_OPTIONS,
  POST_ACTION_LABELS,
  POST_ACTION_OPTIONS,
  RECENT_NOT_VIEW_OPTIONS,
  SCHOOL_TAG_OPTIONS
};
