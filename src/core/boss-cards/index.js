import { htmlToText, normalizeText } from "../screening/index.js";

function uniqueTexts(values = []) {
  return Array.from(new Set(values.map((value) => normalizeText(value)).filter(Boolean)));
}

function classList(value = "") {
  return String(value || "").split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function hasAllClasses(classValue = "", requiredClasses = []) {
  const classes = classList(classValue);
  return requiredClasses.every((required) => classes.includes(required));
}

function findClassAttributeIndex(html = "", requiredClasses = [], startIndex = 0) {
  const regex = /class=(["'])(.*?)\1/gi;
  regex.lastIndex = Math.max(0, Number(startIndex) || 0);
  let match;
  while ((match = regex.exec(String(html || "")))) {
    if (hasAllClasses(match[2], requiredClasses)) return match.index;
  }
  return -1;
}

function sectionByClasses(html = "", startClasses = [], endClassGroups = []) {
  const source = String(html || "");
  const classIndex = findClassAttributeIndex(source, startClasses);
  if (classIndex < 0) return "";
  const start = Math.max(0, source.lastIndexOf("<", classIndex));
  let end = source.length;
  for (const group of endClassGroups) {
    const found = findClassAttributeIndex(source, group, classIndex + 1);
    if (found >= 0) {
      const tagStart = source.lastIndexOf("<", found);
      end = Math.min(end, tagStart >= 0 ? tagStart : found);
    }
  }
  return source.slice(start, end);
}

function textFromHtmlFragment(fragment = "") {
  return normalizeText(htmlToText(fragment).replace(/\n+/g, " "));
}

function stripNameSuffixes(value = "") {
  return normalizeText(value)
    .replace(/\s*(在线|刚刚活跃|今日活跃|本周活跃|本月活跃)$/u, "")
    .trim();
}

function extractFirstSpanWithClass(html = "", className = "") {
  const regex = /<span\b[^>]*class=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/span>/gi;
  let match;
  while ((match = regex.exec(String(html || "")))) {
    if (classList(match[2]).includes(className)) {
      return textFromHtmlFragment(match[3]);
    }
  }
  return "";
}

function extractSpanTexts(fragment = "") {
  const values = [];
  const regex = /<span\b[^>]*>([\s\S]*?)<\/span>/gi;
  let match;
  while ((match = regex.exec(String(fragment || "")))) {
    values.push(textFromHtmlFragment(match[1]));
  }
  return uniqueTexts(values);
}

function extractDivTextsWithClasses(fragment = "", requiredClasses = []) {
  const values = [];
  const regex = /<div\b[^>]*class=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = regex.exec(String(fragment || "")))) {
    if (hasAllClasses(match[2], requiredClasses)) {
      values.push(extractSpanTexts(match[3]));
    }
  }
  return values.filter((items) => items.length);
}

function parseAgeValue(value = "") {
  const match = normalizeText(value).match(/^(\d{2})岁$/u);
  if (!match) return null;
  const age = Number.parseInt(match[1], 10);
  return Number.isFinite(age) ? age : null;
}

function parseDegreeValue(value = "") {
  const normalized = normalizeText(value);
  const match = normalized.match(/博士|硕士|本科|大专|专科|高中|中专\/中技|中专|中技|初中及以下/u);
  return match ? match[0] : "";
}

function isSalaryLike(value = "") {
  const normalized = normalizeText(value);
  return Boolean(
    /^(?:面议|薪资面议)$/i.test(normalized)
    || /^\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?\s*[kK](?:\s*[·xX*]\s*\d+\s*薪?)?$/.test(normalized)
    || /^\d+\s*-\s*\d+\s*元\s*\/\s*天$/.test(normalized)
  );
}

function extractSalary(html = "") {
  const section = sectionByClasses(html, ["salary-wrap"], [
    ["name-wrap"],
    ["col-2"]
  ]);
  return extractSpanTexts(section).find(isSalaryLike) || "";
}

function extractBaseInfo(html = "") {
  const section = sectionByClasses(html, ["base-info"], [
    ["expect-wrap"],
    ["geek-desc"],
    ["timeline-wrap"]
  ]);
  const parts = extractSpanTexts(section);
  return {
    parts,
    age: parts.map(parseAgeValue).find((value) => value != null) ?? null,
    degree: parts.map(parseDegreeValue).find(Boolean) || ""
  };
}

function extractFirstTimelineContent(html = "", timelineClass = "") {
  const section = sectionByClasses(html, ["timeline-wrap", timelineClass], [
    timelineClass === "work-exps" ? ["timeline-wrap", "edu-exps"] : ["card-btns"],
    ["action-wrap"]
  ]);
  const contentRows = extractDivTextsWithClasses(section, ["join-text-wrap", "content"]);
  return contentRows[0] || [];
}

function extractTagTexts(html = "") {
  const tags = [];
  const regex = /<span\b[^>]*class=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/span>/gi;
  let match;
  while ((match = regex.exec(String(html || "")))) {
    if (classList(match[2]).includes("tag-item")) {
      tags.push(textFromHtmlFragment(match[3]));
    }
  }
  return uniqueTexts(tags);
}

export function parseBossCandidateCardFieldsFromHtml(html = "") {
  const name = stripNameSuffixes(extractFirstSpanWithClass(html, "name"));
  const baseInfo = extractBaseInfo(html);
  const work = extractFirstTimelineContent(html, "work-exps");
  const education = extractFirstTimelineContent(html, "edu-exps");
  const educationDegree = education.map(parseDegreeValue).find(Boolean) || "";
  return {
    identity: {
      name: name && !isSalaryLike(name) ? name : "",
      current_company: work[0] || "",
      current_position: work[1] || "",
      school: education[0] || "",
      major: education[1] || "",
      degree: educationDegree || baseInfo.degree || "",
      age: baseInfo.age
    },
    salary: extractSalary(html),
    base_info: baseInfo.parts,
    work,
    education,
    tags: extractTagTexts(html)
  };
}

export function mergeBossCandidateCardFields(candidate, outerHTML = "", {
  metadataKey = "boss_card_fields"
} = {}) {
  const parsed = parseBossCandidateCardFieldsFromHtml(outerHTML);
  const identity = { ...(candidate.identity || {}) };
  for (const [key, value] of Object.entries(parsed.identity || {})) {
    if (value !== "" && value !== null && value !== undefined) {
      identity[key] = value;
    }
  }
  return {
    ...candidate,
    identity,
    tags: uniqueTexts([...(candidate.tags || []), ...(parsed.tags || [])]),
    metadata: {
      ...(candidate.metadata || {}),
      [metadataKey]: {
        salary: parsed.salary || "",
        base_info: parsed.base_info || [],
        work: parsed.work || [],
        education: parsed.education || [],
        tags: parsed.tags || []
      }
    }
  };
}
