import fs from "node:fs";
import path from "node:path";

const SUPPORTED_DOMAINS = new Set(["recommend", "recruit", "chat"]);

const DEGREE_RANK = {
  "初中及以下": 1,
  "中专/中技": 2,
  "高中": 3,
  "大专": 4,
  "本科": 5,
  "硕士": 6,
  "博士": 7
};

const DEGREE_PATTERNS = [
  { value: "博士", regex: /博士|phd|doctor/i },
  { value: "硕士", regex: /硕士|研究生|master/i },
  { value: "本科", regex: /本科|学士|bachelor/i },
  { value: "大专", regex: /大专|专科|college/i },
  { value: "高中", regex: /高中/i },
  { value: "中专/中技", regex: /中专|中技/i },
  { value: "初中及以下", regex: /初中及以下|初中以下/i }
];

const ENTITY_MAP = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " "
};

const GENDER_CODE_MAP = {
  1: "男",
  2: "女"
};

const LLM_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "auto", "current"]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeLlmThinkingLevel(value) {
  const normalized = normalizeText(value).toLowerCase();
  return LLM_THINKING_LEVELS.has(normalized) ? normalized : "";
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function buildChatCompletionsUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function isVolcengineModel(baseUrl, model) {
  return /volces|volcengine|ark\.cn|doubao|seed/i.test(`${baseUrl || ""} ${model || ""}`);
}

function applyChatCompletionThinking(payload, { baseUrl = "", model = "", thinkingLevel = "" } = {}) {
  const level = normalizeLlmThinkingLevel(thinkingLevel);
  if (!level || level === "current" || level === "auto") return payload;
  if (isVolcengineModel(baseUrl, model)) {
    if (level === "off" || level === "minimal") {
      payload.thinking = { type: "disabled" };
    } else {
      payload.thinking = { type: "enabled" };
    }
    return payload;
  }
  payload.reasoning_effort = level === "off" ? "minimal" : level;
  return payload;
}

function parsePositiveNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFiniteNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveLlmOutputTokenBudget(config = {}, thinkingLevel = "") {
  const explicit = parsePositiveNumber(
    config.llmMaxCompletionTokens
    ?? config.maxCompletionTokens
    ?? config.llmMaxTokens
    ?? config.maxTokens,
    null
  );
  if (explicit) return Math.max(1, Math.floor(explicit));
  const normalizedThinking = normalizeLlmThinkingLevel(thinkingLevel || "low") || "low";
  return normalizedThinking === "off" || normalizedThinking === "minimal" ? 64 : 512;
}

export function normalizeText(input) {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function normalizeBlockText(input) {
  return String(input ?? "").trim();
}

function compact(input) {
  return normalizeText(input).toLowerCase();
}

export function decodeHtmlEntities(input) {
  return String(input || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = String(entity).toLowerCase();
    if (key.startsWith("#x")) {
      const value = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    if (key.startsWith("#")) {
      const value = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return ENTITY_MAP[key] || match;
  });
}

export function htmlToText(html) {
  const withoutScripts = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withBreaks = withoutScripts
    .replace(/<\/(?:div|li|p|section|article|header|footer|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  return decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .join("\n");
}

export function parseHtmlAttributes(html) {
  const attributes = {};
  const openTag = String(html || "").match(/^<[^>]+>/s)?.[0] || "";
  const regex = /([:@A-Za-z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = regex.exec(openTag))) {
    const name = match[1];
    if (!name || name.startsWith("<")) continue;
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function unique(values) {
  return Array.from(new Set(values.map(normalizeText).filter(Boolean)));
}

function normalizeDomain(domain) {
  const normalized = compact(domain);
  if (!SUPPORTED_DOMAINS.has(normalized)) {
    throw new Error(`Unsupported screening domain: ${domain}`);
  }
  return normalized;
}

function collectTextParts(candidate = {}) {
  return unique([
    candidate.text,
    candidate.raw_text,
    candidate.summary,
    candidate.resume_text,
    candidate.identity?.name,
    candidate.identity?.title,
    candidate.identity?.current_position,
    candidate.identity?.current_company,
    candidate.identity?.school,
    candidate.identity?.major,
    ...(candidate.tags || [])
  ]);
}

function parseDegree(text) {
  for (const item of DEGREE_PATTERNS) {
    if (item.regex.test(text)) return item.value;
  }
  return null;
}

function parseYearsExperience(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/(?<!\d)(\d{1,2})\s*(?:年以上?|年)\s*(?:经验|工作经验)/i)
    || normalized.match(/(?:经验|工作经验|工作)\s*(?<!\d)(\d{1,2})\s*(?:年以上?|年)/i)
    || normalized.match(/(?<!\d)(\d{1,2})\s*years?\s*(?:of\s*)?(?:experience|work)?/i);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function parseAge(text) {
  const match = normalizeText(text).match(/(\d{2})\s*岁/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function parseGender(text) {
  const normalized = normalizeText(text);
  if (/(?:^|[\s｜|,，])男(?:$|[\s｜|,，])/.test(normalized)) return "男";
  if (/(?:^|[\s｜|,，])女(?:$|[\s｜|,，])/.test(normalized)) return "女";
  return null;
}

function normalizeGenderValue(value) {
  if (value == null || value === "") return null;
  if (GENDER_CODE_MAP[value]) return GENDER_CODE_MAP[value];
  const normalized = normalizeText(value);
  if (normalized === "男" || normalized === "女") return normalized;
  return parseGender(normalized);
}

function parseDateLike(value) {
  const normalized = normalizeText(value);
  if (!normalized || normalized === "0") return "";
  if (/^\d{6}$/.test(normalized)) return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)}`;
  if (/^\d{8}$/.test(normalized)) return `${normalized.slice(0, 4)}.${normalized.slice(4, 6)}`;
  return normalized;
}

function isLikelySalaryLine(value = "") {
  const normalized = normalizeText(value);
  return Boolean(
    /^(?:面议|薪资面议)$/i.test(normalized)
    || /^\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*[kK](?:\s*[·xX*]\s*\d+\s*薪?)?$/.test(normalized)
    || /^\d+\s*-\s*\d+\s*元\s*\/\s*天$/.test(normalized)
  );
}

function isLikelyStatusLine(value = "") {
  const normalized = normalizeText(value);
  return Boolean(
    !normalized
    || /^沟通|^收藏|^查看|^不合适/.test(normalized)
    || /^(?:在线|刚刚活跃|今日活跃|本周活跃|本月活跃|继续沟通|打招呼)$/.test(normalized)
  );
}

function stripLeadingSalaryToken(value = "") {
  return normalizeText(value)
    .replace(/^(?:面议|薪资面议)\s+/i, "")
    .replace(/^\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*[kK](?:\s*[·xX*]\s*\d+\s*薪?)?\s+/, "")
    .replace(/^\d+\s*-\s*\d+\s*元\s*\/\s*天\s+/, "")
    .trim();
}

function stripTrailingStatusToken(value = "") {
  return normalizeText(value)
    .replace(/\s*(?:在线|刚刚活跃|今日活跃|本周活跃|本月活跃|继续沟通|打招呼)$/u, "")
    .trim();
}

function cleanInferredNameLine(value = "") {
  const withoutSalary = stripLeadingSalaryToken(value);
  const withoutStatus = stripTrailingStatusToken(withoutSalary);
  return withoutStatus && !isLikelyStatusLine(withoutStatus) && !isLikelySalaryLine(withoutStatus)
    ? withoutStatus
    : "";
}

function firstUsefulLine(lines) {
  for (const line of lines) {
    const cleaned = cleanInferredNameLine(line);
    if (cleaned) return cleaned;
  }
  return null;
}

function parseNetworkBodyText(networkBody = {}) {
  const bodyResult = networkBody.body || networkBody;
  let body = String(bodyResult?.body || "");
  if (bodyResult?.base64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  return body;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tryExtractJsonObject(text) {
  const normalized = String(text || "").trim();
  const direct = tryParseJson(normalized);
  if (direct && typeof direct === "object") return direct;
  const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = tryParseJson(fenced[1].trim());
    if (parsed && typeof parsed === "object") return parsed;
  }
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = tryParseJson(normalized.slice(start, end + 1));
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

function extractBalancedJsonAt(text = "", startIndex = 0) {
  const source = String(text || "");
  const start = source.indexOf("{", Math.max(0, Number(startIndex) || 0));
  if (start < 0) return "";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

function tryParseEmbeddedJsonObjects(text = "") {
  const source = decodeHtmlEntities(String(text || ""));
  const objects = [];
  const anchors = [
    "__INITIAL_STATE__",
    "__NEXT_DATA__",
    "geekDetailInfo",
    "geekDetail",
    "geekBaseInfo",
    "geekEduExpList",
    "geekWorkExpList",
    "resume"
  ];
  for (const anchor of anchors) {
    let searchIndex = 0;
    while (searchIndex >= 0 && searchIndex < source.length) {
      const anchorIndex = source.indexOf(anchor, searchIndex);
      if (anchorIndex < 0) break;
      const windowStart = Math.max(0, anchorIndex - 4000);
      const braceIndex = source.lastIndexOf("{", anchorIndex);
      if (braceIndex >= windowStart) {
        const jsonText = extractBalancedJsonAt(source, braceIndex);
        const parsed = tryParseJson(jsonText);
        if (parsed && typeof parsed === "object") objects.push(parsed);
      }
      searchIndex = anchorIndex + anchor.length;
    }
  }
  return objects;
}

function flattenChatMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      return item?.text || item?.content || item?.reasoning_content || "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function collectLlmReasoningText(choice = {}) {
  const message = choice?.message || {};
  return [
    message.reasoning_content,
    message.reasoning,
    message.cot,
    message.chain_of_thought,
    choice.reasoning_content,
    choice.reasoning,
    choice.cot,
    choice.chain_of_thought
  ].map(flattenChatMessageContent).map(normalizeBlockText).filter(Boolean).join("\n\n");
}

function mimeTypeForImagePath(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function normalizeImagePaths({ imageEvidence = null, imagePaths = [] } = {}) {
  const paths = [];
  if (Array.isArray(imagePaths)) {
    paths.push(...imagePaths);
  }
  const evidenceLlmPaths = Array.isArray(imageEvidence?.llm_file_paths)
    ? imageEvidence.llm_file_paths
    : [];
  if (evidenceLlmPaths.length) {
    paths.push(...evidenceLlmPaths);
  } else {
    if (Array.isArray(imageEvidence?.file_paths)) {
      paths.push(...imageEvidence.file_paths);
    }
    if (Array.isArray(imageEvidence?.screenshots)) {
      paths.push(...imageEvidence.screenshots.map((item) => item.file_path));
    }
  }
  return unique(paths.map((filePath) => String(filePath || "").trim()).filter(Boolean));
}

function imagePathToLlmInput(filePath, {
  detail = "high"
} = {}) {
  const resolved = path.resolve(filePath);
  const buffer = fs.readFileSync(resolved);
  const mimeType = mimeTypeForImagePath(resolved);
  return {
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${buffer.toString("base64")}`,
      detail
    },
    metadata: {
      file_path: resolved,
      mime_type: mimeType,
      byte_length: buffer.length
    }
  };
}

export function buildScreeningLlmImageInputs({
  imageEvidence = null,
  imagePaths = [],
  maxImages = 8,
  detail = "high"
} = {}) {
  const paths = normalizeImagePaths({ imageEvidence, imagePaths });
  const limit = Math.max(1, Number(maxImages) || 8);
  return paths.slice(0, limit).map((filePath) => imagePathToLlmInput(filePath, { detail }));
}

function summarizeLlmImageInputs(imageInputs = []) {
  return imageInputs.map((input, index) => ({
    index,
    file_path: input.metadata?.file_path || null,
    mime_type: input.metadata?.mime_type || null,
    byte_length: input.metadata?.byte_length || 0
  }));
}

function parsePassedDecision(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = normalizeText(value).toLowerCase();
  if (["true", "pass", "passed", "yes", "是", "通过", "符合"].includes(normalized)) return true;
  if (["false", "fail", "failed", "no", "否", "不通过", "不符合"].includes(normalized)) return false;
  return null;
}

function pickFirst(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized && normalized !== "0") return normalized;
  }
  return "";
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isBossGeekDetailShape(value) {
  if (!isPlainObject(value)) return false;
  return Boolean(
    isPlainObject(value.geekBaseInfo)
    || value.geekName
    || value.geekAdvantage
    || Array.isArray(value.geekEduExpList)
    || Array.isArray(value.geekEducationList)
    || Array.isArray(value.geekWorkExpList)
    || Array.isArray(value.geekProjExpList)
    || Array.isArray(value.geekCertificationList)
    || Array.isArray(value.geekSkillList)
    || isPlainObject(value.highestEduExp)
  );
}

function isBossChatProfileShape(value) {
  if (!isPlainObject(value)) return false;
  return Boolean(
    (value.name || value.encryptGeekId || value.uid)
    && (
      Array.isArray(value.eduExpList)
      || Array.isArray(value.workExpList)
      || value.school
      || value.major
      || value.lastCompany
      || value.positionName
    )
  );
}

function collectObjects(root, {
  maxObjects = 500,
  maxDepth = 8
} = {}) {
  if (!root || typeof root !== "object") return [];
  const queue = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  const objects = [];
  while (queue.length && objects.length < maxObjects) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (isPlainObject(value)) objects.push(value);
    if (depth >= maxDepth) continue;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (child && typeof child === "object") {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return objects;
}

function joinRange(start, end, fallback = "") {
  const left = parseDateLike(start);
  const right = parseDateLike(end);
  if (left && right) return `${left}-${right}`;
  if (left) return `${left}-至今`;
  if (right) return right;
  return normalizeText(fallback);
}

function normalizeList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [];
}

function normalizeTagList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") return item;
    return pickFirst(item?.name, item?.label, item?.tagName, item?.text, item?.value);
  }).filter(Boolean);
}

function formatNamedSection(title, lines = []) {
  const normalized = lines.map(normalizeText).filter(Boolean);
  if (!normalized.length) return "";
  return [`【${title}】`, ...normalized].join("\n");
}

function formatWorkExperience(item = {}, index = 0) {
  const company = pickFirst(item.formattedCompany, item.company);
  const position = pickFirst(item.positionName, item.positionTitle, item.position);
  const period = joinRange(item.startYearMonStr || item.startDate, item.endYearMonStr || item.endDate, item.workYearDesc);
  const emphasis = [
    ...normalizeTagList(item.workEmphasisList),
    ...normalizeTagList(item.respHighlightList),
    ...normalizeTagList(item.workPerfHighlightList)
  ];
  return [
    `${index + 1}. ${[company, position, period].filter(Boolean).join(" / ")}`,
    item.department ? `部门：${normalizeText(item.department)}` : "",
    item.responsibility ? `职责：${normalizeText(item.responsibility)}` : "",
    item.workPerformance ? `业绩：${normalizeText(item.workPerformance)}` : "",
    item.workEmphasis ? `重点：${normalizeText(item.workEmphasis)}` : "",
    emphasis.length ? `亮点：${unique(emphasis).join("、")}` : ""
  ].filter(Boolean).join("\n");
}

function formatProjectExperience(item = {}, index = 0) {
  const period = joinRange(item.startYearMonStr || item.startDateDesc || item.startDate, item.endYearMonStr || item.endDateDesc || item.endDate);
  return [
    `${index + 1}. ${[pickFirst(item.name), pickFirst(item.roleName), period].filter(Boolean).join(" / ")}`,
    pickFirst(item.projectDescription, item.description) ? `项目描述：${pickFirst(item.projectDescription, item.description)}` : "",
    item.performance ? `项目业绩：${normalizeText(item.performance)}` : ""
  ].filter(Boolean).join("\n");
}

function formatEducation(item = {}, index = 0) {
  const period = joinRange(
    item.startDateDesc || item.startDate || item.startYearStr,
    item.endDateDesc || item.endDate || item.endYearStr
  );
  const tags = [
    ...normalizeTagList(item.tags),
    ...normalizeTagList(item.schoolTags),
    ...normalizeTagList(item.keySubjectList)
  ];
  return [
    `${index + 1}. ${[
      pickFirst(item.school, item.schoolName),
      pickFirst(item.major, item.majorName),
      pickFirst(item.degreeName, item.degree),
      period
    ].filter(Boolean).join(" / ")}`,
    tags.length ? `标签：${unique(tags).join("、")}` : "",
    item.courseDesc ? `课程：${normalizeText(item.courseDesc)}` : "",
    item.eduDescription ? `教育描述：${normalizeText(item.eduDescription)}` : "",
    item.thesisTitle ? `论文：${normalizeText(item.thesisTitle)}` : "",
    item.thesisDesc ? `论文描述：${normalizeText(item.thesisDesc)}` : ""
  ].filter(Boolean).join("\n");
}

function formatExpectation(item = {}, index = 0) {
  return `${index + 1}. ${[
    pickFirst(item.positionName, item.position),
    pickFirst(item.locationName, item.location),
    pickFirst(item.salaryDesc),
    pickFirst(item.industryDesc)
  ].filter(Boolean).join(" / ")}`;
}

function formatChatWorkExperience(item = {}, index = 0) {
  return [
    `${index + 1}. ${[
      pickFirst(item.company, item.brandName),
      pickFirst(item.positionName, item.position),
      pickFirst(item.workYear, item.workYearDesc, item.dateRange)
    ].filter(Boolean).join(" / ")}`,
    pickFirst(item.description, item.performance, item.content) ? `描述：${pickFirst(item.description, item.performance, item.content)}` : ""
  ].filter(Boolean).join("\n");
}

function formatChatEducation(item = {}, index = 0) {
  return `${index + 1}. ${[
    pickFirst(item.school),
    pickFirst(item.major),
    pickFirst(item.degree, item.degreeName),
    pickFirst(item.year, item.dateRange)
  ].filter(Boolean).join(" / ")}`;
}

function resolveBossGeekDetail(payload = {}) {
  const candidates = [
    { sourceKey: "geekDetailInfo", detail: payload?.zpData?.geekDetailInfo },
    { sourceKey: "geekDetail", detail: payload?.zpData?.geekDetail },
    { sourceKey: "geekDetailInfo", detail: payload?.zpData?.data?.geekDetailInfo },
    { sourceKey: "geekDetail", detail: payload?.zpData?.data?.geekDetail },
    { sourceKey: "geekDetailInfo", detail: payload?.zpData?.data?.detailInfo },
    { sourceKey: "geekDetailInfo", detail: payload?.zpData?.data?.resumeDetail },
    { sourceKey: "geekDetailInfo", detail: payload?.zpData?.data },
    { sourceKey: "geekDetailInfo", detail: payload?.data?.geekDetailInfo },
    { sourceKey: "geekDetail", detail: payload?.data?.geekDetail },
    { sourceKey: "geekDetailInfo", detail: payload?.data?.detailInfo },
    { sourceKey: "geekDetailInfo", detail: payload?.data?.resumeDetail },
    { sourceKey: "geekDetailInfo", detail: payload?.data },
    { sourceKey: "geekDetailInfo", detail: payload?.geekDetailInfo },
    { sourceKey: "geekDetail", detail: payload?.geekDetail },
    { sourceKey: "geekDetailInfo", detail: payload }
  ];
  const found = candidates.find((item) => isBossGeekDetailShape(item.detail));
  return found || { sourceKey: "", detail: null };
}

function extractBossChatGeekInfo(payload = {}) {
  const data = payload?.zpData?.data || payload?.data || payload?.zpData?.geekInfo || payload?.geekInfo;
  if (!data || typeof data !== "object") return null;
  if (!isBossChatProfileShape(data)) return null;
  const educationList = normalizeList(data.eduExpList);
  const workList = normalizeList(data.workExpList);
  const firstEducation = educationList[0] || {};
  const firstWork = workList[0] || {};
  const tags = unique([
    ...normalizeTagList(data.highLightGeekResumeWords),
    ...normalizeTagList(data.highLightWords),
    ...normalizeTagList(data.skillTags),
    ...normalizeTagList(data.labels),
    pickFirst(data.positionCategory),
    pickFirst(data.positionName, data.position, data.toPosition)
  ]);
  const salary = data.salaryDesc || (
    data.lowSalary && data.highSalary ? `${data.lowSalary}-${data.highSalary}K` : ""
  );
  const sections = {
    base: [
      pickFirst(data.name) ? `姓名：${pickFirst(data.name)}` : "",
      pickFirst(data.gender) ? `性别：${pickFirst(data.gender)}` : "",
      pickFirst(data.age) ? `年龄：${pickFirst(data.age)}` : "",
      pickFirst(data.year, data.workYear, data.workYearDesc) ? `工作年限：${pickFirst(data.year, data.workYear, data.workYearDesc)}` : "",
      pickFirst(data.degree, firstEducation.degree, firstEducation.degreeName) ? `最高学历：${pickFirst(data.degree, firstEducation.degree, firstEducation.degreeName)}` : "",
      pickFirst(data.positionStatus, data.positionStatusDesc) ? `求职状态：${pickFirst(data.positionStatus, data.positionStatusDesc)}` : ""
    ].filter(Boolean),
    expectation: [
      [pickFirst(data.toPosition, data.positionName, data.position), salary].filter(Boolean).join(" / ")
    ].filter(Boolean),
    current: [
      [pickFirst(data.lastCompany, data.lastCompany2), pickFirst(data.lastPosition, data.lastPosition2)].filter(Boolean).join(" / ")
    ].filter(Boolean),
    education: educationList.map(formatChatEducation).filter(Boolean),
    work: workList.map(formatChatWorkExperience).filter(Boolean),
    highlights: tags
  };
  const text = [
    formatNamedSection("基础信息", sections.base),
    formatNamedSection("求职期望", sections.expectation),
    formatNamedSection("最近经历", sections.current),
    formatNamedSection("工作经历", sections.work),
    formatNamedSection("教育经历", sections.education),
    formatNamedSection("亮点标签", sections.highlights)
  ].filter(Boolean).join("\n\n");
  return {
    text,
    identity: {
      name: pickFirst(data.name) || null,
      title: pickFirst(data.positionName, data.position, data.toPosition) || null,
      current_position: pickFirst(data.lastPosition, data.lastPosition2, firstWork.positionName, firstWork.position) || null,
      current_company: pickFirst(data.lastCompany, data.lastCompany2, firstWork.company, firstWork.brandName) || null,
      school: pickFirst(data.school, firstEducation.school) || null,
      major: pickFirst(data.major, firstEducation.major) || null,
      degree: pickFirst(data.degree, firstEducation.degree, firstEducation.degreeName) || parseDegree(text),
      years_experience: parseYearsExperience(pickFirst(data.year, data.workYear, data.workYearDesc)) ?? null,
      age: parseAge(String(data.age || "")) ?? null,
      gender: normalizeGenderValue(data.gender)
    },
    tags,
    source_keys: {
      chat_geek_info: true,
      geek_detail_info: false,
      geek_detail: false,
      education_count: educationList.length,
      work_count: workList.length
    }
  };
}

function extractBossChatHistoryResume(payload = {}) {
  const messages = normalizeList(payload?.zpData?.messages).length
    ? normalizeList(payload?.zpData?.messages)
    : normalizeList(payload?.messages).length
      ? normalizeList(payload?.messages)
      : normalizeList(payload?.data?.messages).length
        ? normalizeList(payload?.data?.messages)
        : normalizeList(payload?.zpData?.data?.messages);
  const resumes = messages
    .map((message) => message?.body?.resume)
    .filter((resume) => resume && typeof resume === "object");
  const resume = resumes[0];
  if (!resume) return null;
  const user = resume.user || {};
  const educationList = normalizeList(resume.education);
  const workList = normalizeList(resume.experiences);
  const firstEducation = educationList[0] || {};
  const firstWork = workList[0] || {};
  const tags = unique([
    pickFirst(resume.position),
    pickFirst(resume.positionCategory),
    ...normalizeTagList(resume.skills),
    ...normalizeTagList(resume.tags)
  ]);
  const sections = {
    base: [
      pickFirst(user.name) ? `姓名：${pickFirst(user.name)}` : "",
      pickFirst(resume.workYear) ? `工作年限：${pickFirst(resume.workYear)}` : "",
      pickFirst(firstEducation.degree, resume.degree) ? `最高学历：${pickFirst(firstEducation.degree, resume.degree)}` : ""
    ].filter(Boolean),
    expectation: [
      [pickFirst(resume.position), pickFirst(resume.positionCategory)].filter(Boolean).join(" / ")
    ].filter(Boolean),
    education: educationList.map(formatChatEducation).filter(Boolean),
    work: workList.map(formatChatWorkExperience).filter(Boolean),
    highlights: tags
  };
  const text = [
    formatNamedSection("基础信息", sections.base),
    formatNamedSection("求职期望", sections.expectation),
    formatNamedSection("工作经历", sections.work),
    formatNamedSection("教育经历", sections.education),
    formatNamedSection("亮点标签", sections.highlights)
  ].filter(Boolean).join("\n\n");
  return {
    text,
    identity: {
      name: pickFirst(user.name) || null,
      title: pickFirst(resume.position) || null,
      current_position: pickFirst(firstWork.positionName, firstWork.position) || null,
      current_company: pickFirst(firstWork.company, firstWork.brandName, user.company) || null,
      school: pickFirst(firstEducation.school) || null,
      major: pickFirst(firstEducation.major) || null,
      degree: pickFirst(firstEducation.degree, firstEducation.degreeName, resume.degree) || parseDegree(text),
      years_experience: parseYearsExperience(pickFirst(resume.workYear)) ?? null,
      age: null,
      gender: null
    },
    tags,
    source_keys: {
      chat_history_resume: true,
      geek_detail_info: false,
      geek_detail: false,
      education_count: educationList.length,
      work_count: workList.length
    }
  };
}

function extractBossProfileRecursively(payload = {}) {
  for (const object of collectObjects(payload)) {
    if (isBossGeekDetailShape(object)) {
      const profile = extractBossGeekDetailInfo({ geekDetailInfo: object });
      if (profile?.text || profile?.identity?.name) {
        return {
          ...profile,
          source_keys: {
            ...(profile.source_keys || {}),
            recursive_profile_match: true
          }
        };
      }
    }
    if (isBossChatProfileShape(object)) {
      const profile = extractBossChatGeekInfo({ zpData: { data: object } });
      if (profile?.text || profile?.identity?.name) {
        return {
          ...profile,
          source_keys: {
            ...(profile.source_keys || {}),
            recursive_profile_match: true
          }
        };
      }
    }
    if (isPlainObject(object.resume)) {
      const profile = extractBossChatHistoryResume({ zpData: { messages: [{ body: { resume: object.resume } }] } });
      if (profile?.text || profile?.identity?.name) {
        return {
          ...profile,
          source_keys: {
            ...(profile.source_keys || {}),
            recursive_profile_match: true
          }
        };
      }
    }
  }
  return null;
}

function extractBossGeekDetailInfo(payload = {}) {
  const { sourceKey, detail } = resolveBossGeekDetail(payload);
  if (!detail || typeof detail !== "object") return null;

  const base = detail.geekBaseInfo || detail.baseInfo || detail.base || {};
  const educationList = normalizeList(detail.geekEduExpList).length
    ? normalizeList(detail.geekEduExpList)
    : normalizeList(detail.geekEducationList);
  const firstEducation = educationList[0] || detail.highestEduExp || {};
  const workList = normalizeList(detail.geekWorkExpList);
  const firstWork = workList[0] || {};
  const projectList = normalizeList(detail.geekProjExpList);
  const expectationList = normalizeList(detail.geekExpPosList).length
    ? normalizeList(detail.geekExpPosList)
    : normalizeList(detail.geekExpectList);
  const expectationFallback = detail.showExpectPosition && typeof detail.showExpectPosition === "object"
    ? [detail.showExpectPosition]
    : [];
  const normalizedExpectationList = expectationList.length ? expectationList : expectationFallback;
  const certifications = normalizeList(detail.geekCertificationList);
  const skillTags = [
    ...normalizeTagList(detail.geekSkillList),
    ...normalizeTagList(detail.skillList),
    ...normalizeTagList(detail.blueGeekSkills),
    ...normalizeTagList(base.userHighlightList),
    ...normalizeTagList(base.userDescHighlightList),
    ...normalizeTagList(base.userDescHighLightList),
    ...normalizeTagList(detail.geekPersonalLabelList),
    ...normalizeTagList(detail.professionalSkill)
  ];
  const summaryParts = [
    pickFirst(detail.geekAdvantage),
    pickFirst(base.userDescription),
    pickFirst(base.userDesc),
    pickFirst(base.workEduDesc),
    pickFirst(detail.resumeSummary?.content, detail.resumeSummary?.text, detail.resumeSummary?.summary)
  ].filter(Boolean);
  const sections = {
    base: [
      pickFirst(base.name, detail.geekName, detail.name) ? `姓名：${pickFirst(base.name, detail.geekName, detail.name)}` : "",
      normalizeGenderValue(base.gender) ? `性别：${normalizeGenderValue(base.gender)}` : "",
      pickFirst(base.ageDesc, base.age) ? `年龄：${pickFirst(base.ageDesc, base.age)}` : "",
      pickFirst(base.degreeCategory) ? `最高学历：${pickFirst(base.degreeCategory)}` : "",
      pickFirst(base.workYearDesc, base.workYearsDesc) ? `工作年限：${pickFirst(base.workYearDesc, base.workYearsDesc)}` : "",
      pickFirst(base.activeTimeDesc) ? `活跃状态：${pickFirst(base.activeTimeDesc)}` : "",
      pickFirst(base.applyStatusDesc, base.applyStatusContent) ? `求职状态：${pickFirst(base.applyStatusDesc, base.applyStatusContent)}` : ""
    ].filter(Boolean),
    summary: summaryParts,
    expectations: normalizedExpectationList.map(formatExpectation).filter(Boolean),
    work_experience: workList.map(formatWorkExperience).filter(Boolean),
    project_experience: projectList.map(formatProjectExperience).filter(Boolean),
    education: educationList.map(formatEducation).filter(Boolean),
    certifications: certifications.map((item, index) => `${index + 1}. ${pickFirst(item.certName, item.name)}`).filter(Boolean),
    skills: unique(skillTags)
  };
  const text = [
    formatNamedSection("基础信息", sections.base),
    formatNamedSection("个人总结", sections.summary),
    formatNamedSection("求职期望", sections.expectations),
    formatNamedSection("工作经历", sections.work_experience),
    formatNamedSection("项目经历", sections.project_experience),
    formatNamedSection("教育经历", sections.education),
    formatNamedSection("证书", sections.certifications),
    formatNamedSection("技能/亮点", sections.skills)
  ].filter(Boolean).join("\n\n");

  return {
    identity: {
      name: pickFirst(base.name, detail.geekName, detail.name),
      current_position: pickFirst(firstWork.positionName, firstWork.positionTitle, firstWork.position),
      current_company: pickFirst(firstWork.formattedCompany, firstWork.company, firstWork.brandName),
      school: pickFirst(firstEducation.school, firstEducation.schoolName),
      major: pickFirst(firstEducation.major, firstEducation.majorName),
      degree: pickFirst(base.degreeCategory, firstEducation.degreeName, firstEducation.degree),
      years_experience: parseYearsExperience(pickFirst(base.workYearDesc, base.workYearsDesc)) ?? null,
      age: parseAge(pickFirst(base.ageDesc, base.age)) ?? null,
      gender: normalizeGenderValue(base.gender)
    },
    tags: unique([
      ...sections.skills,
      ...educationList.flatMap((item) => [
        ...normalizeTagList(item.tags),
        ...normalizeTagList(item.schoolTags)
      ])
    ]),
    sections,
    text,
    source_keys: {
      source_key: sourceKey,
      geek_detail_info: sourceKey === "geekDetailInfo",
      geek_detail: sourceKey === "geekDetail",
      work_count: workList.length,
      project_count: projectList.length,
      education_count: educationList.length,
      expectation_count: normalizedExpectationList.length,
      certification_count: certifications.length
    }
  };
}

export function extractBossProfileFromNetworkBody(networkBody = {}) {
  const text = parseNetworkBodyText(networkBody);
  const parsedObjects = [
    tryParseJson(text),
    ...tryParseEmbeddedJsonObjects(text)
  ].filter((item) => item && typeof item === "object");
  if (!parsedObjects.length) {
    const htmlText = /<html|<body|<div|<section|<script/i.test(text) ? htmlToText(text) : "";
    if (htmlText && htmlText.length > 80) {
      const candidate = normalizeCandidateProfile({
        domain: "recommend",
        source: "network-html-fallback",
        text: htmlText
      });
      return {
        ok: true,
        url: networkBody.url || null,
        status: networkBody.status ?? null,
        mimeType: networkBody.mimeType || null,
        text_length: text.length,
        profile: {
          identity: candidate.identity,
          tags: candidate.tags,
          sections: { html_text: [htmlText] },
          text: htmlText,
          source_keys: {
            network_html_text: true,
            html_text_length: htmlText.length
          }
        }
      };
    }
    return {
      ok: false,
      error: "NETWORK_BODY_NOT_JSON",
      text_length: text.length
    };
  }
  let profile = null;
  let parsed = parsedObjects[0];
  for (const candidateObject of parsedObjects) {
    profile = extractBossGeekDetailInfo(candidateObject)
      || extractBossChatGeekInfo(candidateObject)
      || extractBossChatHistoryResume(candidateObject)
      || extractBossProfileRecursively(candidateObject);
    if (profile) {
      parsed = candidateObject;
      break;
    }
  }
  if (!profile) {
    const encryptedPayload = parsedObjects.find((item) => (
      normalizeText(item?.zpData?.encryptGeekDetailInfo || item?.encryptGeekDetailInfo || "")
    ));
    return {
      ok: false,
      error: encryptedPayload ? "BOSS_GEEK_DETAIL_INFO_ENCRYPTED" : "BOSS_GEEK_DETAIL_INFO_NOT_FOUND",
      text_length: text.length,
      parsed_object_count: parsedObjects.length,
      top_level_keys: Object.keys(parsed || {}).slice(0, 30),
      zpData_keys: Object.keys(parsed?.zpData || {}).slice(0, 50),
      data_keys: Object.keys(parsed?.data || parsed?.zpData?.data || {}).slice(0, 50),
      encrypted_resume: Boolean(encryptedPayload),
      encrypted_resume_length: normalizeText(encryptedPayload?.zpData?.encryptGeekDetailInfo || encryptedPayload?.encryptGeekDetailInfo || "").length
    };
  }
  return {
    ok: true,
    url: networkBody.url || null,
    status: networkBody.status ?? null,
    mimeType: networkBody.mimeType || null,
    text_length: text.length,
    profile
  };
}

export function mergeCandidateProfiles(...profiles) {
  const base = {};
  for (const profile of profiles) {
    if (!profile) continue;
    for (const [key, value] of Object.entries(profile)) {
      if (value == null || value === "") continue;
      if (base[key] == null || base[key] === "") {
        base[key] = value;
      }
    }
  }
  return base;
}

export function buildScreeningCandidateFromDetail({
  cardCandidate,
  detailText = "",
  networkBodies = [],
  domain = "recommend",
  source = "live-cdp-detail",
  metadata = {}
} = {}) {
  const parsedNetworkProfiles = networkBodies.map(extractBossProfileFromNetworkBody);
  const successfulProfiles = parsedNetworkProfiles.filter((item) => item.ok).map((item) => item.profile);
  const networkText = successfulProfiles.map((profile) => profile.text).filter(Boolean).join("\n\n");
  const networkIdentity = mergeCandidateProfiles(
    ...successfulProfiles.map((profile) => profile.identity)
  );
  const networkTags = unique(successfulProfiles.flatMap((profile) => profile.tags || []));
  const combinedIdentity = mergeCandidateProfiles(
    networkIdentity,
    cardCandidate?.identity
  );
  const candidate = normalizeCandidateProfile({
    domain,
    source,
    id: cardCandidate?.id,
    href: cardCandidate?.links?.href,
    text: [
      networkText,
      detailText,
      cardCandidate?.text?.raw
    ].filter(Boolean).join("\n\n"),
    attributes: cardCandidate?.metadata?.attributes || {},
    identity: combinedIdentity,
    tags: unique([
      ...(cardCandidate?.tags || []),
      ...networkTags
    ]),
    metadata: {
      ...metadata,
      card_candidate_source: cardCandidate?.source || null,
      network_profile_count: successfulProfiles.length,
      network_profiles: parsedNetworkProfiles.map((item) => ({
        ok: item.ok,
        url: item.url,
        status: item.status,
        error: item.error,
        text_length: item.text_length,
        source_keys: item.profile?.source_keys || null
      }))
    }
  });
  return {
    candidate,
    parsed_network_profiles: parsedNetworkProfiles
  };
}

export function normalizeCandidateProfile(input = {}) {
  const domain = normalizeDomain(input.domain || "recommend");
  const rawText = String(input.text || input.raw_text || input.resume_text || "")
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .join("\n");
  const lines = rawText.split(/\r?\n/).map(normalizeText).filter(Boolean);
  const attrs = {
    ...(input.attributes || {}),
    ...(input.metadata?.attributes || {})
  };
  const sourceId = normalizeText(
    input.id
    || attrs["data-geek"]
    || attrs["data-geekid"]
    || attrs["data-expect"]
    || attrs["data-uid"]
    || attrs["data-securityid"]
    || attrs.encryptgeekid
    || attrs["data-lid"]
    || attrs["data-jid"]
    || attrs["data-itemid"]
    || attrs.geekid
    || attrs.expect
    || attrs.uid
    || attrs.securityid
    || attrs.jid
    || attrs.lid
    || attrs.href
    || ""
  ) || null;
  const explicitName = cleanInferredNameLine(input.identity?.name || input.name || "");
  const inferredName = explicitName || firstUsefulLine(lines) || null;
  const fullText = collectTextParts({
    ...input,
    text: rawText,
    raw_text: rawText,
    identity: {
      ...(input.identity || {}),
      name: inferredName
    }
  }).join("\n");
  const degree = input.identity?.degree || input.degree || parseDegree(fullText);

  return {
    schema_version: 1,
    domain,
    source: normalizeText(input.source || "unknown") || "unknown",
    id: sourceId,
    identity: {
      name: inferredName,
      title: normalizeText(input.identity?.title || input.title || "") || null,
      current_position: normalizeText(input.identity?.current_position || input.current_position || "") || null,
      current_company: normalizeText(input.identity?.current_company || input.current_company || "") || null,
      school: normalizeText(input.identity?.school || input.school || "") || null,
      major: normalizeText(input.identity?.major || input.major || "") || null,
      degree,
      years_experience: input.identity?.years_experience ?? input.years_experience ?? parseYearsExperience(fullText),
      age: input.identity?.age ?? input.age ?? parseAge(fullText),
      gender: input.identity?.gender || input.gender || parseGender(fullText)
    },
    tags: unique(input.tags || []),
    text: {
      summary: lines.slice(0, 8).join("\n"),
      raw: rawText
    },
    links: {
      href: normalizeText(input.href || attrs.href || "") || null
    },
    metadata: {
      ...(input.metadata || {}),
      attributes: attrs,
      normalized_at: input.normalized_at || nowIso()
    }
  };
}

export function normalizeCandidateFromHtml({
  domain = "recommend",
  source = "dom",
  html,
  attributes = {},
  metadata = {}
} = {}) {
  const parsedAttributes = parseHtmlAttributes(html);
  return normalizeCandidateProfile({
    domain,
    source,
    text: htmlToText(html),
    attributes: {
      ...parsedAttributes,
      ...attributes
    },
    metadata: {
      ...metadata,
      html_length: String(html || "").length
    }
  });
}

function normalizeKeywordList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return unique(value);
  return unique(String(value).split(/[,\n，、|/]/));
}

function keywordMatches(text, keywords) {
  const haystack = compact(text);
  return keywords.filter((keyword) => haystack.includes(compact(keyword)));
}

function degreeAtLeast(candidateDegree, minimumDegree) {
  if (!minimumDegree) return true;
  const candidateRank = DEGREE_RANK[candidateDegree] || 0;
  const minimumRank = DEGREE_RANK[minimumDegree] || 0;
  return candidateRank >= minimumRank;
}

export function screenCandidate(candidateInput, criteria = {}) {
  const candidate = candidateInput?.schema_version
    ? candidateInput
    : normalizeCandidateProfile(candidateInput);
  const text = [
    candidate.text?.raw,
    candidate.text?.summary,
    ...Object.values(candidate.identity || {}).map((value) => value == null ? "" : String(value)),
    ...(candidate.tags || [])
  ].join("\n");
  const requiredKeywords = normalizeKeywordList(criteria.required_keywords || criteria.requiredKeywords);
  const preferredKeywords = normalizeKeywordList(criteria.preferred_keywords || criteria.preferredKeywords || criteria.criteria);
  const excludedKeywords = normalizeKeywordList(criteria.excluded_keywords || criteria.excludedKeywords);
  const matchedRequired = keywordMatches(text, requiredKeywords);
  const matchedPreferred = keywordMatches(text, preferredKeywords);
  const matchedExcluded = keywordMatches(text, excludedKeywords);
  const reasons = [];
  let score = 0;

  if (requiredKeywords.length > 0) {
    if (matchedRequired.length === requiredKeywords.length) {
      score += 60;
      reasons.push(`Matched all required keywords: ${matchedRequired.join(", ")}`);
    } else {
      const missing = requiredKeywords.filter((keyword) => !matchedRequired.includes(keyword));
      reasons.push(`Missing required keywords: ${missing.join(", ")}`);
    }
  }

  if (preferredKeywords.length > 0) {
    score += Math.round((matchedPreferred.length / preferredKeywords.length) * 30);
    if (matchedPreferred.length) {
      reasons.push(`Matched preferred keywords: ${matchedPreferred.join(", ")}`);
    }
  }

  if (matchedExcluded.length > 0) {
    score -= 80;
    reasons.push(`Matched excluded keywords: ${matchedExcluded.join(", ")}`);
  }

  const minimumDegree = criteria.minimum_degree || criteria.minimumDegree || null;
  const degreeOk = degreeAtLeast(candidate.identity?.degree, minimumDegree);
  if (minimumDegree) {
    if (degreeOk) {
      score += 10;
      reasons.push(`Degree meets minimum: ${candidate.identity?.degree || "unknown"} >= ${minimumDegree}`);
    } else {
      reasons.push(`Degree below or unknown for minimum: ${minimumDegree}`);
    }
  }

  const hasCriteria = (
    requiredKeywords.length > 0
    || preferredKeywords.length > 0
    || excludedKeywords.length > 0
    || Boolean(minimumDegree)
  );
  const hasRequired = requiredKeywords.length === 0 || matchedRequired.length === requiredKeywords.length;
  const passed = hasCriteria && hasRequired && degreeOk && matchedExcluded.length === 0;
  const boundedScore = Math.max(0, Math.min(100, hasCriteria ? score : 0));

  return {
    schema_version: 1,
    status: passed ? "pass" : "review",
    passed,
    score: boundedScore,
    reasons: reasons.length ? reasons : ["No explicit screening criteria supplied; candidate normalized for review."],
    matched: {
      required_keywords: matchedRequired,
      preferred_keywords: matchedPreferred,
      excluded_keywords: matchedExcluded
    },
    candidate: {
      domain: candidate.domain,
      source: candidate.source,
      id: candidate.id,
      identity: candidate.identity
    },
    screened_at: nowIso()
  };
}

export function compactScreeningLlmResult(llmResult) {
  if (!llmResult) return null;
  return {
    ok: Boolean(llmResult.ok),
    provider: llmResult.provider || null,
    passed: llmResult.passed,
    cot: llmResult.cot || llmResult.decision_cot || "",
    reasoning_content: llmResult.reasoning_content || "",
    raw_model_output: llmResult.raw_model_output || "",
    evidence_count: Array.isArray(llmResult.evidence) ? llmResult.evidence.length : 0,
    usage: llmResult.usage || null,
    finish_reason: llmResult.finish_reason || null,
    image_input_count: llmResult.image_input_count || 0,
    attempt_count: llmResult.attempt_count || 0,
    error: llmResult.error || null,
    screened_at: llmResult.screened_at || null
  };
}

export function llmResultToScreening(llmResult, candidate) {
  return {
    status: llmResult?.passed ? "pass" : "fail",
    passed: Boolean(llmResult?.passed),
    score: llmResult?.passed ? 100 : 0,
    reasons: llmResult?.error ? ["llm_invalid_response"] : [],
    candidate
  };
}

export function isRecoverableLlmScreeningError(error) {
  return /(?:LLM response missing boolean passed decision|LLM response was not valid JSON)/i
    .test(String(error?.message || error || ""));
}

export function createFailedLlmScreeningResult(error) {
  return {
    ok: false,
    passed: false,
    reason: "",
    evidence: [],
    cot: "",
    decision_cot: "",
    reasoning_content: "",
    raw_model_output: "",
    image_input_count: Number(error?.image_input_count) || 0,
    image_inputs: Array.isArray(error?.image_inputs) ? error.image_inputs : [],
    attempt_count: Number(error?.llm_attempt_count) || 0,
    error: error?.message || String(error || "unknown"),
    screened_at: nowIso()
  };
}

export function buildScreeningLlmMessages({
  candidate,
  criteria,
  imageEvidence = null,
  imagePaths = [],
  imageInputs = null,
  maxImages = 8,
  imageDetail = "high"
}) {
  const safeCriteria = normalizeText(criteria || "判断候选人是否符合本次招聘筛选标准");
  const safeText = String(candidate?.text?.raw || candidate?.text || "");
  const images = Array.isArray(imageInputs)
    ? imageInputs
    : buildScreeningLlmImageInputs({
      imageEvidence,
      imagePaths,
      maxImages,
      detail: imageDetail
    });
  const prompt =
    `请根据以下标准判断候选人是否通过筛选。\n\n筛选标准:\n${safeCriteria}\n\n`
    + `候选人信息:\n${safeText || "候选人的完整简历信息在后续截图中，请按截图顺序阅读。"}\n\n`
    + (images.length
      ? `候选人简历截图共 ${images.length} 张，按从上到下的滚动顺序排列。若截图是拼接长图，请按图内从上到下顺序完整阅读；不要跳过任何一段简历内容。\n\n`
      : "")
    + "要求：\n"
    + "1) 只能依据候选人信息或截图中真实出现的内容判断。\n"
    + "2) 若证据不足或截图无法确认，必须返回 passed=false。\n"
    + "3) 不要输出评估原因、证据列表、解释或额外文字。\n"
    + "4) 只返回 JSON，格式为："
    + "{\"passed\": true/false}";
  const userContent = images.length
    ? [
      { type: "text", text: prompt },
      ...images.map((image) => ({
        type: "image_url",
        image_url: image.image_url
      }))
    ]
    : prompt;
  return [
    {
      role: "system",
      content:
        "你是一位严谨的招聘筛选助手。必须完整阅读输入内容，严禁编造不存在的候选人经历。"
        + "只能返回严格 JSON，不要输出原因、证据或额外文字。"
    },
    {
      role: "user",
      content: userContent
    }
  ];
}

function normalizeLlmMaxRetries(value) {
  if (value == null || value === "") return 1;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 1;
  return Math.min(3, Math.floor(parsed));
}

function isRetryableLlmRequestError(error) {
  const status = Number(error?.status);
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;
  return /(?:aborted|abort|timeout|timed out|fetch failed|socket|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN)/i
    .test(String(error?.message || error || ""));
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export async function callScreeningLlm({
  candidate,
  criteria,
  config = {},
  timeoutMs = 60000,
  imageEvidence = null,
  imagePaths = [],
  maxImages = 8,
  imageDetail = "high"
} = {}) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const apiKey = normalizeText(config.apiKey);
  const model = normalizeText(config.model);
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Missing LLM config fields: baseUrl/apiKey/model");
  }
  const imageInputs = buildScreeningLlmImageInputs({
    imageEvidence,
    imagePaths,
    maxImages: config.llmImageLimit || config.imageLimit || maxImages,
    detail: config.llmImageDetail || config.imageDetail || imageDetail
  });
  if (!candidate?.text?.raw && !candidate?.text && !imageInputs.length) {
    throw new Error("Candidate text and image evidence are empty");
  }

  const thinkingLevel = config.llmThinkingLevel || config.thinkingLevel || config.reasoningEffort || "low";
  const outputTokenBudget = resolveLlmOutputTokenBudget(config, thinkingLevel);
  const payload = {
    model,
    temperature: parseFiniteNumber(config.temperature, 0.1),
    max_tokens: outputTokenBudget,
    messages: buildScreeningLlmMessages({
      candidate,
      criteria,
      imageInputs
    })
  };
  const topP = parseFiniteNumber(config.topP ?? config.top_p, null);
  if (topP !== null) payload.top_p = topP;
  const maxCompletionTokens = parsePositiveNumber(
    config.llmMaxCompletionTokens ?? config.maxCompletionTokens,
    null
  );
  if (maxCompletionTokens !== null) {
    payload.max_completion_tokens = Math.max(1, Math.floor(maxCompletionTokens));
  }
  applyChatCompletionThinking(payload, {
    baseUrl,
    model,
    thinkingLevel
  });

  const maxRetries = normalizeLlmMaxRetries(config.llmMaxRetries ?? config.maxRetries);
  const maxAttempts = maxRetries + 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };
    if (config.openaiOrganization) headers["OpenAI-Organization"] = config.openaiOrganization;
    if (config.openaiProject) headers["OpenAI-Project"] = config.openaiProject;

    const response = await fetch(buildChatCompletionsUrl(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const responseText = await response.text();
    if (!response.ok) {
      const error = new Error(`LLM request failed: ${response.status} ${responseText.slice(0, 400)}`);
      error.status = response.status;
      throw error;
    }
    const json = tryParseJson(responseText);
    if (!json) {
      throw new Error("LLM response was not valid JSON");
    }
    const choice = json?.choices?.[0] || {};
    const content = flattenChatMessageContent(choice?.message?.content);
    const reasoningContent = collectLlmReasoningText(choice);
    const parsed = tryExtractJsonObject(content) || tryExtractJsonObject(reasoningContent);
    const passed = parsePassedDecision(parsed?.passed);
    if (passed === null) {
      throw new Error(`LLM response missing boolean passed decision: ${content.slice(0, 240)}`);
    }
    const evidence = Array.isArray(parsed?.evidence)
      ? parsed.evidence.map(normalizeText).filter(Boolean)
      : [];
    const decisionCot = firstUsefulLine([
      parsed?.cot,
      parsed?.decision_cot,
      parsed?.reasoning,
      parsed?.chain_of_thought,
      reasoningContent
    ].map(normalizeBlockText).filter(Boolean)) || reasoningContent;
    return {
      ok: true,
      provider: {
        baseUrl: baseUrl.replace(/\/\/[^/]+/, "//[redacted-host]"),
        model,
        thinking_level: normalizeLlmThinkingLevel(thinkingLevel) || "low",
        thinking: payload.thinking || null,
        reasoning_effort: payload.reasoning_effort || null,
        max_tokens: payload.max_tokens,
        max_completion_tokens: payload.max_completion_tokens || null
      },
      passed,
      reason: "",
      evidence,
      cot: decisionCot,
      decision_cot: decisionCot,
      reasoning_content: reasoningContent,
      raw_model_output: content,
      usage: json.usage || null,
      finish_reason: choice.finish_reason || null,
      raw_content_length: content.length,
      image_input_count: imageInputs.length,
      image_inputs: summarizeLlmImageInputs(imageInputs),
      attempt_count: attempt,
      screened_at: nowIso()
    };
  } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableLlmRequestError(error)) {
        error.image_input_count = imageInputs.length;
        error.image_inputs = summarizeLlmImageInputs(imageInputs);
        error.llm_attempt_count = attempt;
        throw error;
      }
      await sleepMs(Math.min(2500, 500 * attempt));
  } finally {
    clearTimeout(timer);
  }
  }
  lastError = lastError || new Error("LLM request failed without response");
  lastError.image_input_count = imageInputs.length;
  lastError.image_inputs = summarizeLlmImageInputs(imageInputs);
  lastError.llm_attempt_count = maxAttempts;
  throw lastError;
}
