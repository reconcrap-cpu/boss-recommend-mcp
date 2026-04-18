import { readFile } from 'node:fs/promises';

const DEFAULT_TEXT_MODEL_CHUNK_SIZE_CHARS = 24000;
const DEFAULT_TEXT_MODEL_CHUNK_OVERLAP_CHARS = 1200;
const DEFAULT_TEXT_MODEL_MAX_CHUNKS = 12;
const LONG_RESUME_AGGREGATE_LIMITS_STANDARD = {
  summaryMaxLength: 180,
  evidenceMaxItems: 3,
  blockerMaxItems: 3,
  uncertaintyMaxItems: 2,
  quoteMaxItems: 2,
  itemMaxLength: 160,
  quoteMaxLength: 120,
};
const LONG_RESUME_AGGREGATE_LIMITS_COMPACT = {
  summaryMaxLength: 120,
  evidenceMaxItems: 2,
  blockerMaxItems: 2,
  uncertaintyMaxItems: 1,
  quoteMaxItems: 1,
  itemMaxLength: 96,
  quoteMaxLength: 80,
};
const MAX_EVIDENCE_TOKENS = 12;
const LLM_THINKING_ENV_KEYS = [
  'BOSS_CHAT_LLM_THINKING_LEVEL',
  'BOSS_RECOMMEND_LLM_THINKING_LEVEL',
  'BOSS_LLM_THINKING_LEVEL',
  'LLM_THINKING_LEVEL',
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, maxLength = 96) {
  const text = normalizeText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(12, maxLength - 1))}…`;
}

function toLowerSafe(text) {
  return String(text || '').toLowerCase();
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getCompletionContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return '';
      })
      .join('');
  }

  return '';
}

function flattenChatMessageContent(content) {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          return item.text || item.content || item.reasoning_content || '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

function getResponsesContent(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  const output = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      if (typeof chunk?.text === 'string') {
        parts.push(chunk.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function normalizeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeLlmThinkingLevel(value) {
  const normalized = normalizeText(value).toLowerCase().replace(/[_\s]+/g, '-');
  if (!normalized) return '';
  if (['off', 'disabled', 'disable', 'minimal', 'none', 'false', '0'].includes(normalized)) return 'off';
  if (
    ['low', 'medium', 'high', 'auto', 'current', 'default', 'provider-default', 'unchanged', 'inherit'].includes(
      normalized,
    )
  ) {
    return normalized;
  }
  return '';
}

function getEnvLlmThinkingLevel() {
  for (const key of LLM_THINKING_ENV_KEYS) {
    const normalized = normalizeLlmThinkingLevel(process.env[key]);
    if (normalized) return normalized;
  }
  return '';
}

function resolveLlmThinkingLevel(config = {}, options = {}) {
  return (
    normalizeLlmThinkingLevel(options.thinkingLevel) ||
    normalizeLlmThinkingLevel(options.llmThinkingLevel) ||
    normalizeLlmThinkingLevel(config.llmThinkingLevel) ||
    normalizeLlmThinkingLevel(config.thinkingLevel) ||
    normalizeLlmThinkingLevel(config.reasoningEffort) ||
    normalizeLlmThinkingLevel(config.reasoning_effort) ||
    getEnvLlmThinkingLevel() ||
    'low'
  );
}

function isProviderDefaultThinkingLevel(level) {
  return ['current', 'default', 'provider-default', 'unchanged', 'inherit'].includes(level);
}

function isVolcengineModel(baseUrl, model) {
  const combined = `${baseUrl || ''} ${model || ''}`;
  return /volces\.com|volcengine|ark\.cn-|doubao|seed/i.test(combined);
}

function applyChatCompletionThinking(payload, { baseUrl = '', model = '', thinkingLevel = '' } = {}) {
  const level = normalizeLlmThinkingLevel(thinkingLevel) || 'low';
  if (isProviderDefaultThinkingLevel(level)) return payload;
  const isVolc = isVolcengineModel(baseUrl, model);
  if (isVolc) {
    if (level === 'auto') {
      payload.thinking = { type: 'auto' };
      return payload;
    }
    if (level === 'off') {
      payload.thinking = { type: 'disabled' };
      payload.reasoning_effort = 'minimal';
      return payload;
    }
    payload.thinking = { type: 'enabled' };
    payload.reasoning_effort = level;
    return payload;
  }
  if (level !== 'auto') {
    payload.reasoning_effort = level === 'off' ? 'minimal' : level;
  }
  return payload;
}

function applyResponsesThinking(payload, { thinkingLevel = '' } = {}) {
  const level = normalizeLlmThinkingLevel(thinkingLevel) || 'low';
  if (isProviderDefaultThinkingLevel(level) || level === 'auto') return payload;
  payload.reasoning = {
    ...(payload.reasoning || {}),
    effort: level === 'off' ? 'minimal' : level,
  };
  return payload;
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

function dedupeNormalizedList(value, maxItems = 8, maxLength = 160) {
  const source = Array.isArray(value) ? value : [];
  const normalized = [];
  const seen = new Set();
  for (const item of source) {
    const text = truncateText(item, maxLength);
    const key = toLowerSafe(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
    if (normalized.length >= maxItems) break;
  }
  return normalized;
}

function collectNestedText(value, out = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
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
  if (typeof value === 'object') {
    const priorityKeys = ['text', 'reasoning_content', 'summary_text', 'summary', 'content', 'cot', 'reason'];
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

function dedupeTextFragments(fragments = []) {
  const deduped = [];
  const seen = new Set();
  for (const item of fragments) {
    const normalized = normalizeText(item);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function joinTextFragments(fragments = []) {
  return dedupeTextFragments(fragments).join('\n');
}

function extractCompletionReasoningText(data) {
  const choice = data?.choices?.[0] || {};
  const fragments = [];
  const content = choice?.message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const partType = normalizeText(part?.type || '').toLowerCase();
      if (partType.includes('reason') || partType.includes('summary')) {
        collectNestedText(part, fragments);
      }
    }
  }
  const candidates = [
    choice?.message?.reasoning_content,
    choice?.message?.reasoning,
    choice?.reasoning_content,
    choice?.reasoning,
  ];
  for (const candidate of candidates) {
    collectNestedText(candidate, fragments);
  }
  return joinTextFragments(fragments);
}

function extractResponsesReasoningText(data) {
  const fragments = [];
  collectNestedText(data?.reasoning, fragments);
  collectNestedText(data?.reasoning_content, fragments);

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const itemType = normalizeText(item?.type || '').toLowerCase();
    if (itemType.includes('reason') || itemType.includes('summary')) {
      collectNestedText(item, fragments);
    }
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      const chunkType = normalizeText(chunk?.type || '').toLowerCase();
      if (chunkType.includes('reason') || chunkType.includes('summary')) {
        collectNestedText(chunk, fragments);
      }
    }
  }

  return joinTextFragments(fragments);
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
      mode: 'empty',
      matchedTokens: [],
    };
  }
  if (rawResumeText.includes(evidenceText) || normalizedResumeText.includes(normalizedEvidence)) {
    return {
      matched: true,
      mode: 'exact',
      matchedTokens: [normalizedEvidence],
    };
  }
  const evidenceTokens = extractEvidenceTokens(normalizedEvidence, MAX_EVIDENCE_TOKENS);
  if (evidenceTokens.length <= 0) {
    return {
      matched: false,
      mode: 'token_empty',
      matchedTokens: [],
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
    mode: 'token_fuzzy',
    matchedTokens,
  };
}

function filterEvidenceListAgainstText(value, sourceText, maxItems = 8, maxLength = 160) {
  const rawSource = String(sourceText || '');
  const normalizedSource = normalizeText(rawSource);
  const normalizedSourceLower = toLowerSafe(normalizedSource);
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const text = truncateText(item, maxLength);
    if (!text) continue;
    const match = matchEvidenceAgainstResume(text, rawSource, normalizedSource, normalizedSourceLower);
    if (!match.matched) continue;
    const key = toLowerSafe(text);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function filterQuotedSpansAgainstText(value, sourceText, maxItems = 6, maxLength = 120) {
  const rawSource = String(sourceText || '');
  const normalizedSource = normalizeText(rawSource);
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const text = truncateText(item, maxLength);
    if (!text) continue;
    const normalized = normalizeText(text);
    if (!normalized) continue;
    const matched = rawSource.includes(text) || normalizedSource.includes(normalized);
    if (!matched) continue;
    const key = toLowerSafe(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function splitTextByChunks(text, chunkSize, overlap, maxChunks) {
  const source = String(text || '');
  if (!source) return [];

  const safeChunkSize = Math.max(1000, parsePositiveInteger(chunkSize) || DEFAULT_TEXT_MODEL_CHUNK_SIZE_CHARS);
  const safeOverlap = Math.max(
    0,
    Math.min(safeChunkSize - 1, parsePositiveInteger(overlap) || DEFAULT_TEXT_MODEL_CHUNK_OVERLAP_CHARS),
  );
  const safeMaxChunks = Math.max(1, parsePositiveInteger(maxChunks) || DEFAULT_TEXT_MODEL_MAX_CHUNKS);

  const chunks = [];
  let start = 0;
  while (start < source.length && chunks.length < safeMaxChunks) {
    const end = Math.min(source.length, start + safeChunkSize);
    chunks.push({
      text: source.slice(start, end),
      start,
      end,
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
        end: source.length,
      };
    }
  }
  return chunks;
}

function isTextContextLimitMessage(message) {
  const text = normalizeText(message).toLowerCase();
  if (!text) return false;
  return /context length|maximum context|too many tokens|max(?:imum)? token|prompt is too long|input is too long|token limit|上下文|超出.*token|超过.*token|输入过长/i.test(
    text,
  );
}

function buildProfileContext(candidate) {
  const schools = Array.isArray(candidate?.resumeProfile?.schools)
    ? candidate.resumeProfile.schools.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const majors = Array.isArray(candidate?.resumeProfile?.majors)
    ? candidate.resumeProfile.majors.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const profileSchool = String(candidate?.resumeProfile?.primarySchool || '').trim();
  const profileMajor = String(candidate?.resumeProfile?.major || '').trim();
  const profileCompany = String(candidate?.resumeProfile?.company || '').trim();
  const profilePosition = String(candidate?.resumeProfile?.position || '').trim();
  const profileContext = [];
  if (profileSchool || schools.length > 0 || profileMajor || majors.length > 0 || profileCompany || profilePosition) {
    profileContext.push('简历结构化提取（仅来自当前候选人主简历区域）：');
    if (profileSchool) profileContext.push(`主学校：${profileSchool}`);
    if (schools.length > 0) profileContext.push(`学校列表：${schools.join('、')}`);
    if (profileMajor) profileContext.push(`主专业：${profileMajor}`);
    if (majors.length > 0) profileContext.push(`专业列表：${majors.join('、')}`);
    if (profileCompany) profileContext.push(`最近公司：${profileCompany}`);
    if (profilePosition) profileContext.push(`最近职位：${profilePosition}`);
  }
  return profileContext;
}

function buildAggregateCandidateProfile(candidate, compact = false) {
  const maxLength = compact ? 80 : 120;
  const schools = Array.isArray(candidate?.resumeProfile?.schools)
    ? dedupeNormalizedList(candidate.resumeProfile.schools, compact ? 2 : 3, maxLength)
    : [];
  const majors = Array.isArray(candidate?.resumeProfile?.majors)
    ? dedupeNormalizedList(candidate.resumeProfile.majors, compact ? 2 : 3, maxLength)
    : [];
  const profile = {
    name: truncateText(candidate?.name || '', maxLength),
    sourceJob: truncateText(candidate?.sourceJob || '', maxLength),
    primarySchool: truncateText(candidate?.resumeProfile?.primarySchool || '', maxLength),
    primaryMajor: truncateText(candidate?.resumeProfile?.major || '', maxLength),
    company: truncateText(candidate?.resumeProfile?.company || '', maxLength),
    position: truncateText(candidate?.resumeProfile?.position || '', maxLength),
    schools,
    majors,
  };
  return Object.fromEntries(Object.entries(profile).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return Boolean(normalizeText(value));
  }));
}

function buildImagePrompt({ screeningCriteria, candidate }) {
  const profileContext = buildProfileContext(candidate);
  return [
    '你是招聘筛选助手，请基于简历截图判断候选人是否符合筛选标准。',
    '只能依据图片中可见信息判断，不得臆测。',
    '只采信当前候选人的主简历内容（教育经历/工作经历/项目经历/专业技能）。',
    '必须忽略推荐模块与匿名卡片信息（例如“其他名企大厂经历牛人”“相似牛人”“推荐牛人”）。',
    '若无法在教育经历模块确认学校名称，不要编造学校名；按信息不足处理。',
    '必须完整阅读全部简历截图分段后再判断。',
    '必须且只能返回 JSON，不要输出 Markdown。',
    '返回格式：{"passed":true} 或 {"passed":false}。',
    '不要返回理由、总结、证据、思维过程或额外字段。',
    '当信息不足以支持通过时，返回 {"passed":false}。',
    '',
    `筛选标准：${screeningCriteria}`,
    '',
    '候选人上下文（仅供辅助，不可覆盖图片事实）：',
    `姓名：${candidate.name || '未知'}`,
    `投递职位：${candidate.sourceJob || '未知'}`,
    ...(profileContext.length > 0 ? ['', ...profileContext] : []),
  ].join('\n');
}

function buildTextPrompt({ screeningCriteria, candidate, resumeText, chunkIndex = 1, chunkTotal = 1 }) {
  const profileContext = buildProfileContext(candidate);
  const chunkHint =
    chunkTotal > 1
      ? `\n\n当前输入是简历分段 ${chunkIndex}/${chunkTotal}。请严格基于本分段文本判断；如果本分段证据不足，必须返回 {"passed":false}。`
      : '';
  return [
    '你是招聘筛选助手，请基于简历文本判断候选人是否符合筛选标准。',
    '只能依据输入文本中可见信息判断，不得臆测。',
    '只采信当前候选人的主简历内容（教育经历/工作经历/项目经历/专业技能）。',
    '必须忽略推荐模块与匿名卡片信息（例如“其他名企大厂经历牛人”“相似牛人”“推荐牛人”）。',
    '若无法在教育经历模块确认学校名称，不要编造学校名；按信息不足处理。',
    '必须且只能返回 JSON，不要输出 Markdown。',
    '返回格式：{"passed":true} 或 {"passed":false}。',
    '不要返回理由、总结、证据、思维过程或额外字段。',
    '当信息不足以支持通过时，返回 {"passed":false}。',
    '',
    `筛选标准：${screeningCriteria}`,
    '',
    '候选人上下文（仅供辅助，不可覆盖简历事实）：',
    `姓名：${candidate.name || '未知'}`,
    `投递职位：${candidate.sourceJob || '未知'}`,
    ...(profileContext.length > 0 ? ['', ...profileContext] : []),
    '',
    `简历文本:\n${String(resumeText || '')}${chunkHint}`,
  ].join('\n');
}

function buildChunkAnalysisPrompt({ screeningCriteria, candidate, resumeText, chunkIndex = 1, chunkTotal = 1 }) {
  const profileContext = buildProfileContext(candidate);
  return [
    '你是招聘筛选助手，请对长简历的当前文本分段提取结构化筛选证据。',
    '只能依据当前分段文本中可见信息判断，不得臆测其他分段内容。',
    '只采信当前候选人的主简历内容（教育经历/工作经历/项目经历/专业技能）。',
    '必须忽略推荐模块与匿名卡片信息（例如“其他名企大厂经历牛人”“相似牛人”“推荐牛人”）。',
    '若无法在教育经历模块确认学校名称，不要编造学校名；按信息不足处理。',
    '必须且只能返回 JSON，不要输出 Markdown。',
    'hard_evidence / soft_evidence / hard_blockers / quoted_spans 中每项都必须来自当前分段原文。',
    '如果当前分段单独不足以支持通过，chunk_passed 必须为 false。',
    '',
    `筛选标准：${screeningCriteria}`,
    '',
    '候选人上下文（仅供辅助，不可覆盖简历事实）：',
    `姓名：${candidate.name || '未知'}`,
    `投递职位：${candidate.sourceJob || '未知'}`,
    ...(profileContext.length > 0 ? ['', ...profileContext] : []),
    '',
    `当前分段：${chunkIndex}/${chunkTotal}`,
    '',
    `分段文本:\n${String(resumeText || '')}`,
    '',
    '请返回严格 JSON：{"chunk_passed":true/false,"chunk_summary":"","hard_evidence":[],"soft_evidence":[],"hard_blockers":[],"missing_or_uncertain":[],"quoted_spans":[],"chunk_index":1,"chunk_total":1}',
  ].join('\n');
}

function buildLongResumeAggregatePrompt({ screeningCriteria, candidate, aggregateInput }) {
  return [
    '你是招聘筛选助手，请基于长简历各分段的结构化分析结果，对整份简历做最终综合判断。',
    '必须综合全部 chunk 的信息后再判断，允许跨 chunk 拼接教育、项目、工作经历证据。',
    '只采信当前候选人的主简历内容（教育经历/工作经历/项目经历/专业技能）。',
    '必须忽略推荐模块与匿名卡片信息（例如“其他名企大厂经历牛人”“相似牛人”“推荐牛人”）。',
    '若结构化证据仍不足以支持通过，返回 {"passed":false}。',
    '必须且只能返回 JSON，不要输出 Markdown。',
    '返回格式：{"passed":true/false,"reason":"","summary":"","evidence":[]}。',
    '',
    `筛选标准：${screeningCriteria}`,
    '',
    '候选人上下文（仅供辅助，不可覆盖结构化证据事实）：',
    `姓名：${candidate?.name || '未知'}`,
    `投递职位：${candidate?.sourceJob || '未知'}`,
    '',
    `长简历结构化输入:\n${JSON.stringify(aggregateInput, null, 2)}`,
  ].join('\n');
}

function pickFirstText(...values) {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return '';
}

function parsePassedDecision(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return null;
  if (['true', '1', 'yes', 'y', 'pass', 'passed', 'match', 'matched'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'fail', 'failed', 'unmatched'].includes(normalized)) return false;
  return null;
}

function extractJsonPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error('LLM returned empty content');
  }
  const codeFenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = codeFenceMatch ? codeFenceMatch[1] : raw;
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('LLM response did not contain JSON');
  }
  return {
    text: raw,
    parsed: JSON.parse(jsonMatch[0]),
  };
}

export function parseLlmJson(content, options = {}) {
  const text = String(content || '').trim();
  if (!text) {
    throw new Error('LLM returned empty content');
  }

  const normalizedText = normalizeText(text);
  const chunkIndex = Number.isInteger(options.chunkIndex) && options.chunkIndex > 0 ? options.chunkIndex : 1;
  const chunkTotal = Number.isInteger(options.chunkTotal) && options.chunkTotal > 0 ? options.chunkTotal : 1;

  if (/^(pass|passed|true)$/i.test(normalizedText)) {
    return {
      passed: true,
      rawOutputText: text,
      rawReasoningText: normalizeText(options.reasoningText || ''),
      cot: normalizeText(options.reasoningText || ''),
      reason: '',
      summary: '',
      evidence: [],
      chunkIndex,
      chunkTotal,
    };
  }

  if (/^(fail|failed|false)$/i.test(normalizedText)) {
    return {
      passed: false,
      rawOutputText: text,
      rawReasoningText: normalizeText(options.reasoningText || ''),
      cot: normalizeText(options.reasoningText || ''),
      reason: '',
      summary: '',
      evidence: [],
      chunkIndex,
      chunkTotal,
    };
  }

  const { parsed } = extractJsonPayload(text);
  const parsedPassed =
    typeof parsed.passed === 'boolean'
      ? parsed.passed
      : typeof parsed.matched === 'boolean'
      ? parsed.matched
      : /^pass$/i.test(String(parsed.decision || '').trim())
      ? true
      : /^fail$/i.test(String(parsed.decision || '').trim())
      ? false
      : null;
  if (typeof parsedPassed !== 'boolean') {
    throw new Error('LLM response missing boolean "passed"');
  }

  const parsedReason = pickFirstText(parsed?.reason, parsed?.summary, parsed?.summary_text);
  const parsedSummary = pickFirstText(parsed?.summary, parsed?.summary_text, parsed?.reason);
  const parsedCot = pickFirstText(
    options.reasoningText,
    parsed?.cot,
    parsed?.reasoning_content,
    parsed?.reasoning,
    parsedReason,
    parsedSummary,
  );
  const parsedEvidence = toStringArray(parsed?.evidence);

  return {
    passed: parsedPassed,
    rawOutputText: text,
    rawReasoningText: normalizeText(options.reasoningText || ''),
    cot: parsedCot,
    reason: parsedReason || parsedCot,
    summary: parsedSummary || parsedReason || parsedCot,
    evidence: parsedEvidence,
    chunkIndex,
      chunkTotal,
    };
}

function normalizeChunkAnalysisResult(content, options = {}) {
  const { text, parsed } = extractJsonPayload(content);
  const chunkIndex = Number.isInteger(options.chunkIndex) && options.chunkIndex > 0 ? options.chunkIndex : 1;
  const chunkTotal = Number.isInteger(options.chunkTotal) && options.chunkTotal > 0 ? options.chunkTotal : 1;
  const resumeText = String(options.resumeText || '');
  const chunkPassed =
    parsePassedDecision(parsed?.chunk_passed) !== null
      ? parsePassedDecision(parsed?.chunk_passed)
      : parsePassedDecision(parsed?.passed);
  if (chunkPassed === null) {
    throw new Error('LLM chunk analysis response missing boolean "chunk_passed"');
  }
  return {
    rawOutputText: text,
    chunk_passed: chunkPassed,
    chunk_summary: truncateText(
      parsed?.chunk_summary || parsed?.summary || (chunkPassed ? '当前分段命中相关证据。' : '当前分段证据不足。'),
      220,
    ),
    hard_evidence: filterEvidenceListAgainstText(parsed?.hard_evidence, resumeText, 4, 180),
    soft_evidence: filterEvidenceListAgainstText(parsed?.soft_evidence, resumeText, 3, 180),
    hard_blockers: filterEvidenceListAgainstText(parsed?.hard_blockers, resumeText, 3, 180),
    missing_or_uncertain: dedupeNormalizedList(parsed?.missing_or_uncertain, 3, 140),
    quoted_spans: filterQuotedSpansAgainstText(parsed?.quoted_spans, resumeText, 4, 140),
    chunk_index: chunkIndex,
    chunk_total: chunkTotal,
  };
}

function buildLongResumeAggregateInput(chunkAnalyses = [], candidate = {}, options = {}) {
  const compact = options?.compact === true;
  const limits = compact ? LONG_RESUME_AGGREGATE_LIMITS_COMPACT : LONG_RESUME_AGGREGATE_LIMITS_STANDARD;
  const seenByBucket = {
    hard_evidence: new Set(),
    soft_evidence: new Set(),
    hard_blockers: new Set(),
    missing_or_uncertain: new Set(),
    quoted_spans: new Set(),
  };
  const normalizedChunks = (Array.isArray(chunkAnalyses) ? chunkAnalyses : [])
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      chunk_passed: item.chunk_passed === true,
      chunk_summary: truncateText(
        item.chunk_summary || (item.chunk_passed ? '当前分段命中相关证据。' : '当前分段证据不足。'),
        limits.summaryMaxLength,
      ),
      hard_evidence: dedupeNormalizedList(item.hard_evidence, limits.evidenceMaxItems * 2, limits.itemMaxLength),
      soft_evidence: dedupeNormalizedList(item.soft_evidence, limits.evidenceMaxItems * 2, limits.itemMaxLength),
      hard_blockers: dedupeNormalizedList(item.hard_blockers, limits.blockerMaxItems * 2, limits.itemMaxLength),
      missing_or_uncertain: dedupeNormalizedList(
        item.missing_or_uncertain,
        limits.uncertaintyMaxItems * 2,
        limits.itemMaxLength,
      ),
      quoted_spans: dedupeNormalizedList(item.quoted_spans, limits.quoteMaxItems * 2, limits.quoteMaxLength),
      chunk_index: Number.isFinite(Number(item.chunk_index)) ? Number(item.chunk_index) : index + 1,
      chunk_total: Number.isFinite(Number(item.chunk_total)) ? Number(item.chunk_total) : null,
    }))
    .sort((left, right) => left.chunk_index - right.chunk_index)
    .map((item) => {
      const chunk = {
        chunk_index: item.chunk_index,
        chunk_total: item.chunk_total,
        chunk_passed: item.chunk_passed,
        chunk_summary: item.chunk_summary,
      };
      for (const [field, maxItems] of [
        ['hard_evidence', limits.evidenceMaxItems],
        ['soft_evidence', limits.evidenceMaxItems],
        ['hard_blockers', limits.blockerMaxItems],
        ['missing_or_uncertain', limits.uncertaintyMaxItems],
        ['quoted_spans', limits.quoteMaxItems],
      ]) {
        const bucket = [];
        for (const entry of item[field]) {
          const key = toLowerSafe(entry);
          if (!entry || seenByBucket[field].has(key)) continue;
          seenByBucket[field].add(key);
          bucket.push(entry);
          if (bucket.length >= maxItems) break;
        }
        if (bucket.length > 0) {
          chunk[field] = bucket;
        }
      }
      return chunk;
    });
  return {
    compression_mode: compact ? 'compact' : 'standard',
    chunk_count: normalizedChunks.length,
    candidate_profile: buildAggregateCandidateProfile(candidate, compact),
    chunks: normalizedChunks,
  };
}

function shouldFallbackToCompletions(error) {
  if (error?.code === 'RESPONSES_EMPTY_CONTENT') return true;
  if (error?.code === 'RESPONSES_INCOMPLETE_LENGTH') return true;
  if (error?.code === 'RESPONSES_UNPARSABLE') return true;
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('/responses') ||
    message.includes('404') ||
    message.includes('not found') ||
    message.includes('unknown url') ||
    message.includes('unsupported') ||
    message.includes('input_image') ||
    message.includes('response_format') ||
    message.includes('empty content') ||
    message.includes('incomplete=length') ||
    message.includes('did not contain json')
  );
}

function shouldFallbackToResponses(error) {
  if (error?.code === 'COMPLETIONS_EMPTY_CONTENT') return true;
  if (error?.code === 'COMPLETIONS_UNPARSABLE') return true;
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('/chat/completions') ||
    message.includes('404') ||
    message.includes('not found') ||
    message.includes('unknown url') ||
    message.includes('unsupported') ||
    message.includes('image_url') ||
    message.includes('multimodal')
  );
}

export class LlmClient {
  constructor(config, options = {}) {
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = options.fetchImpl || fetch;
    this.maxRetries = options.maxRetries || 3;
    this.timeoutMs = options.timeoutMs || 30000;
    this.responseMaxOutputTokens = Number.isFinite(Number(options.responseMaxOutputTokens))
      ? Number(options.responseMaxOutputTokens)
      : Number.isFinite(Number(config.responseMaxOutputTokens))
        ? Number(config.responseMaxOutputTokens)
        : 1200;
    this.completionMaxTokens = Number.isFinite(Number(options.completionMaxTokens))
      ? Number(options.completionMaxTokens)
      : Number.isFinite(Number(config.completionMaxTokens))
        ? Number(config.completionMaxTokens)
        : 800;
    this.preferCompletions =
      options.preferCompletions !== undefined
        ? normalizeBool(options.preferCompletions, false)
        : config.preferCompletions !== undefined
        ? normalizeBool(config.preferCompletions, false)
        : /doubao|seed/i.test(String(this.model || ''));
    this.thinkingLevel = resolveLlmThinkingLevel(config, options);
  }

  async readImageAsDataUrl(imagePath) {
    const binary = await readFile(imagePath);
    return `data:image/png;base64,${binary.toString('base64')}`;
  }

  async withRetries(label, fn) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error(`${label} evaluation failed`);
  }

  async requestResponses({
    prompt,
    imageDataUrl = null,
    imageDataUrls = [],
    evidenceCorpus = '',
    chunkIndex = 1,
    chunkTotal = 1,
    parser = parseLlmJson,
  }) {
    const content = [{ type: 'input_text', text: prompt }];
    const normalizedImageDataUrls = Array.isArray(imageDataUrls)
      ? imageDataUrls.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (imageDataUrl) {
      normalizedImageDataUrls.unshift(String(imageDataUrl));
    }
    for (const item of normalizedImageDataUrls) {
      content.push({ type: 'input_image', image_url: item });
    }
    const payload = {
      model: this.model,
      temperature: 0.1,
      max_output_tokens: this.responseMaxOutputTokens,
      input: [
        {
          role: 'user',
          content,
        },
      ],
    };
    applyResponsesThinking(payload, { thinkingLevel: this.thinkingLevel });

    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Responses API request failed: ${response.status} ${response.statusText} ${errorText}`,
      );
    }

    const data = await response.json();
    if (data?.error?.message) {
      throw new Error(`Responses API error: ${data.error.message}`);
    }

    const outputContent = getResponsesContent(data);
    const reasoningText = extractResponsesReasoningText(data);
    if (!outputContent) {
      const incompleteReason = String(data?.incomplete_details?.reason || '').trim();
      const outputTypes = Array.isArray(data?.output)
        ? data.output
            .map((item) => String(item?.type || '').trim())
            .filter(Boolean)
        : [];
      const emptyError = new Error(
        `Responses API empty textual content${
          incompleteReason ? ` (incomplete=${incompleteReason})` : ''
        }${outputTypes.length > 0 ? ` (outputTypes=${outputTypes.join(',')})` : ''}`,
      );
      emptyError.code =
        incompleteReason.toLowerCase() === 'length'
          ? 'RESPONSES_INCOMPLETE_LENGTH'
          : 'RESPONSES_EMPTY_CONTENT';
      throw emptyError;
    }

    try {
      return parser(outputContent, {
        evidenceCorpus,
        reasoningText,
        chunkIndex,
        chunkTotal,
      });
    } catch (parseError) {
      const wrapped = new Error(
        `Responses API returned unparsable content: ${parseError?.message || parseError}`,
      );
      wrapped.code = 'RESPONSES_UNPARSABLE';
      throw wrapped;
    }
  }

  async requestCompletions({
    prompt,
    imageDataUrl = null,
    imageDataUrls = [],
    evidenceCorpus = '',
    chunkIndex = 1,
    chunkTotal = 1,
    parser = parseLlmJson,
  }) {
    const content = [{ type: 'text', text: prompt }];
    const normalizedImageDataUrls = Array.isArray(imageDataUrls)
      ? imageDataUrls.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (imageDataUrl) {
      normalizedImageDataUrls.unshift(String(imageDataUrl));
    }
    for (const item of normalizedImageDataUrls) {
      content.push({ type: 'image_url', image_url: { url: item } });
    }
    const payload = {
      model: this.model,
      temperature: 0.1,
      max_tokens: this.completionMaxTokens,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    };
    applyChatCompletionThinking(payload, {
      baseUrl: this.baseUrl,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
    });

    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Completions API request failed: ${response.status} ${response.statusText} ${errorText}`,
      );
    }

    const data = await response.json();
    if (data?.error?.message) {
      throw new Error(`Completions API error: ${data.error.message}`);
    }

    const outputContent = getCompletionContent(data);
    const reasoningText = extractCompletionReasoningText(data);
    if (!String(outputContent || '').trim()) {
      const emptyError = new Error('Completions API empty textual content');
      emptyError.code = 'COMPLETIONS_EMPTY_CONTENT';
      throw emptyError;
    }

    try {
      return parser(outputContent, {
        evidenceCorpus,
        reasoningText,
        chunkIndex,
        chunkTotal,
      });
    } catch (parseError) {
      const wrapped = new Error(
        `Completions API returned unparsable content: ${parseError?.message || parseError}`,
      );
      wrapped.code = 'COMPLETIONS_UNPARSABLE';
      throw wrapped;
    }
  }

  async requestByPreference(payload) {
    if (this.preferCompletions) {
      try {
        return await this.withRetries('completions', async () => this.requestCompletions(payload));
      } catch (completionsError) {
        if (!shouldFallbackToResponses(completionsError)) {
          throw completionsError;
        }
        return this.withRetries('responses', async () => this.requestResponses(payload));
      }
    }

    try {
      return await this.withRetries('responses', async () => this.requestResponses(payload));
    } catch (responsesError) {
      if (!shouldFallbackToCompletions(responsesError)) {
        throw responsesError;
      }
      return this.withRetries('completions', async () => this.requestCompletions(payload));
    }
  }

  async evaluateImageResume({ screeningCriteria, candidate, imagePath, imagePaths = [] }) {
    const prompt = buildImagePrompt({ screeningCriteria, candidate });
    const normalizedImagePaths = Array.isArray(imagePaths)
      ? imagePaths.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (imagePath) {
      normalizedImagePaths.unshift(String(imagePath));
    }
    const uniqueImagePaths = [...new Set(normalizedImagePaths)];
    if (uniqueImagePaths.length <= 0) {
      throw new Error('IMAGE_MODEL_FAILED: missing image paths');
    }
    const imageDataUrls = await Promise.all(
      uniqueImagePaths.map((item) => this.readImageAsDataUrl(item)),
    );
    const evidenceCorpus = normalizeText(candidate?.evidenceCorpus || candidate?.resumeText || '');
    const result = await this.requestByPreference({
      prompt,
      imageDataUrls,
      evidenceCorpus,
      chunkIndex: 1,
      chunkTotal: 1,
    });
    return {
      ...result,
      evaluationMode: uniqueImagePaths.length > 1 ? 'image-multi-chunk' : 'image',
      imageCount: uniqueImagePaths.length,
    };
  }

  async requestTextChunkAnalysis({ screeningCriteria, candidate, resumeText, chunkIndex = 1, chunkTotal = 1 }) {
    return this.requestByPreference({
      prompt: buildChunkAnalysisPrompt({
        screeningCriteria,
        candidate,
        resumeText,
        chunkIndex,
        chunkTotal,
      }),
      imageDataUrl: null,
      evidenceCorpus: resumeText,
      chunkIndex,
      chunkTotal,
      parser: (content, parserOptions) =>
        normalizeChunkAnalysisResult(content, {
          resumeText,
          chunkIndex,
          chunkTotal,
          ...parserOptions,
        }),
    });
  }

  async requestLongResumeAggregateDecision({
    screeningCriteria,
    candidate,
    aggregateInput,
    aggregateRetryUsed = false,
  }) {
    const result = await this.requestByPreference({
      prompt: buildLongResumeAggregatePrompt({
        screeningCriteria,
        candidate,
        aggregateInput,
      }),
      imageDataUrl: null,
      evidenceCorpus: JSON.stringify(aggregateInput),
      chunkIndex: 1,
      chunkTotal: Number.isFinite(Number(aggregateInput?.chunk_count))
        ? Number(aggregateInput.chunk_count)
        : 1,
    });
    return {
      ...result,
      evaluationMode: 'text-chunk-aggregate',
      aggregateRetryUsed,
      chunkIndex: null,
      chunkTotal: Number.isFinite(Number(aggregateInput?.chunk_count))
        ? Number(aggregateInput.chunk_count)
        : result.chunkTotal,
    };
  }

  async evaluateTextResume({ screeningCriteria, candidate }) {
    const fullResumeText = String(candidate?.resumeText || '');
    const normalizedResumeText = normalizeText(fullResumeText);
    if (!normalizedResumeText) {
      throw new Error('TEXT_MODEL_FAILED: resume text is empty');
    }
    const evidenceCorpus = normalizeText(candidate?.evidenceCorpus || fullResumeText);

    const requestSingleChunk = () =>
      this.requestByPreference({
        prompt: buildTextPrompt({
          screeningCriteria,
          candidate,
          resumeText: fullResumeText,
          chunkIndex: 1,
          chunkTotal: 1,
        }),
        imageDataUrl: null,
        evidenceCorpus,
        chunkIndex: 1,
        chunkTotal: 1,
      });

    try {
      const single = await requestSingleChunk();
      return {
        ...single,
        evaluationMode: 'text',
        aggregateRetryUsed: false,
      };
    } catch (error) {
      if (!isTextContextLimitMessage(error?.message || '')) {
        throw error;
      }
    }

    const chunkSize = parsePositiveInteger(process.env.BOSS_CHAT_TEXT_CHUNK_SIZE_CHARS) || DEFAULT_TEXT_MODEL_CHUNK_SIZE_CHARS;
    const overlap = parsePositiveInteger(process.env.BOSS_CHAT_TEXT_CHUNK_OVERLAP_CHARS) || DEFAULT_TEXT_MODEL_CHUNK_OVERLAP_CHARS;
    const maxChunks = parsePositiveInteger(process.env.BOSS_CHAT_TEXT_MAX_CHUNKS) || DEFAULT_TEXT_MODEL_MAX_CHUNKS;
    const chunks = splitTextByChunks(fullResumeText, chunkSize, overlap, maxChunks);
    if (!chunks.length) {
      throw new Error('TEXT_MODEL_FAILED: resume text is empty after chunk split');
    }

    const chunkResults = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const result = await this.requestTextChunkAnalysis({
        screeningCriteria,
        candidate,
        resumeText: chunk.text,
        chunkIndex: index + 1,
        chunkTotal: chunks.length,
      });
      chunkResults.push(result);
    }

    let aggregateInput = buildLongResumeAggregateInput(chunkResults, candidate);
    try {
      return await this.requestLongResumeAggregateDecision({
        screeningCriteria,
        candidate,
        aggregateInput,
        aggregateRetryUsed: false,
      });
    } catch (error) {
      if (!isTextContextLimitMessage(error?.message || '')) {
        throw error;
      }
    }

    aggregateInput = buildLongResumeAggregateInput(chunkResults, candidate, { compact: true });
    return this.requestLongResumeAggregateDecision({
      screeningCriteria,
      candidate,
      aggregateInput,
      aggregateRetryUsed: true,
    });
  }

  async evaluateResume({ screeningCriteria, candidate, imagePath, imagePaths = [] }) {
    const normalizedImagePaths = Array.isArray(imagePaths)
      ? imagePaths.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (imagePath) {
      normalizedImagePaths.unshift(String(imagePath));
    }
    const uniqueImagePaths = [...new Set(normalizedImagePaths)];
    if (uniqueImagePaths.length > 0) {
      return this.evaluateImageResume({
        screeningCriteria,
        candidate,
        imagePaths: uniqueImagePaths,
      });
    }

    const hasResumeText = Boolean(normalizeText(candidate?.resumeText || ''));
    if (hasResumeText) {
      return this.evaluateTextResume({ screeningCriteria, candidate });
    }

    throw new Error('LLM evaluation requires at least one resume image or non-empty resume text');
  }
}

export const __testables = {
  flattenChatMessageContent,
  collectNestedText,
  extractCompletionReasoningText,
  extractResponsesReasoningText,
  extractEvidenceTokens,
  matchEvidenceAgainstResume,
  splitTextByChunks,
  isTextContextLimitMessage,
  buildChunkAnalysisPrompt,
  buildLongResumeAggregatePrompt,
  normalizeChunkAnalysisResult,
  buildLongResumeAggregateInput,
  dedupeNormalizedList,
  filterEvidenceListAgainstText,
  filterQuotedSpansAgainstText,
};
