import { readFile } from 'node:fs/promises';

const DEFAULT_TEXT_MODEL_CHUNK_SIZE_CHARS = 24000;
const DEFAULT_TEXT_MODEL_CHUNK_OVERLAP_CHARS = 1200;
const DEFAULT_TEXT_MODEL_MAX_CHUNKS = 12;
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
    'off'
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
  const level = normalizeLlmThinkingLevel(thinkingLevel) || 'off';
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
  const level = normalizeLlmThinkingLevel(thinkingLevel) || 'off';
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
    '返回格式：{"passed":true/false,"reason":"简短中文原因","summary":"简短总结","evidence":["证据原文1","证据原文2"]}',
    '当信息不足以支持通过时，返回 passed=false。',
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
      ? `\n\n当前输入是简历分段 ${chunkIndex}/${chunkTotal}。请严格基于本分段文本判断；如果本分段证据不足，必须返回 passed=false。`
      : '';
  return [
    '你是招聘筛选助手，请基于简历文本判断候选人是否符合筛选标准。',
    '只能依据输入文本中可见信息判断，不得臆测。',
    '只采信当前候选人的主简历内容（教育经历/工作经历/项目经历/专业技能）。',
    '必须忽略推荐模块与匿名卡片信息（例如“其他名企大厂经历牛人”“相似牛人”“推荐牛人”）。',
    '若无法在教育经历模块确认学校名称，不要编造学校名；按信息不足处理。',
    '必须且只能返回 JSON，不要输出 Markdown。',
    '返回格式：{"passed":true/false,"reason":"简短中文原因","summary":"简短总结","evidence":["证据原文1","证据原文2"]}',
    '当信息不足以支持通过时，返回 passed=false。',
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

export function parseLlmJson(content, options = {}) {
  const text = String(content || '').trim();
  if (!text) {
    throw new Error('LLM returned empty content');
  }

  const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = codeFenceMatch ? codeFenceMatch[1] : text;
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('LLM response did not contain JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const parsedPassed = typeof parsed.passed === 'boolean' ? parsed.passed : parsed.matched;
  if (typeof parsedPassed !== 'boolean') {
    throw new Error('LLM response missing boolean "passed"');
  }
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
    throw new Error('LLM response missing string "reason"');
  }

  const reason = normalizeText(parsed.reason);
  const summary = normalizeText(parsed.summary || reason);
  const parsedEvidence = toStringArray(parsed.evidence);

  const evidenceCorpus = normalizeText(options.evidenceCorpus || options.rawResumeText || '');
  const chunkIndex = Number.isInteger(options.chunkIndex) && options.chunkIndex > 0 ? options.chunkIndex : 1;
  const chunkTotal = Number.isInteger(options.chunkTotal) && options.chunkTotal > 0 ? options.chunkTotal : 1;

  let evidence = parsedEvidence;
  let evidenceMatchedCount = parsedEvidence.length;
  if (evidenceCorpus) {
    const normalizedCorpus = normalizeText(evidenceCorpus);
    const normalizedCorpusLower = toLowerSafe(normalizedCorpus);
    evidence = [];
    for (const item of parsedEvidence) {
      const matched = matchEvidenceAgainstResume(item, evidenceCorpus, normalizedCorpus, normalizedCorpusLower);
      if (matched.matched) {
        evidence.push(item);
      }
    }
    evidenceMatchedCount = evidence.length;
  }

  const rawPassed = parsedPassed === true;
  const evidenceRawCount = parsedEvidence.length;
  const evidenceGateDemoted = rawPassed && evidenceMatchedCount <= 0;
  const passed = evidenceGateDemoted ? false : rawPassed;
  const finalReason = evidenceGateDemoted
    ? `模型未给出可在简历原文中校验的证据，按安全策略判为不通过。${reason ? ` 原始原因: ${reason}` : ''}`
    : reason;

  return {
    passed,
    rawPassed,
    reason: finalReason || '模型未返回有效理由。',
    summary: summary || finalReason || '模型未返回有效总结。',
    evidence,
    evidenceRawCount,
    evidenceMatchedCount,
    evidenceGateDemoted,
    chunkIndex,
    chunkTotal,
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

  async requestResponses({ prompt, imageDataUrl = null, evidenceCorpus = '', chunkIndex = 1, chunkTotal = 1 }) {
    const content = [{ type: 'input_text', text: prompt }];
    if (imageDataUrl) {
      content.push({ type: 'input_image', image_url: imageDataUrl });
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
      return parseLlmJson(outputContent, {
        evidenceCorpus,
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

  async requestCompletions({ prompt, imageDataUrl = null, evidenceCorpus = '', chunkIndex = 1, chunkTotal = 1 }) {
    const content = [{ type: 'text', text: prompt }];
    if (imageDataUrl) {
      content.push({ type: 'image_url', image_url: { url: imageDataUrl } });
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
    if (!String(outputContent || '').trim()) {
      const emptyError = new Error('Completions API empty textual content');
      emptyError.code = 'COMPLETIONS_EMPTY_CONTENT';
      throw emptyError;
    }

    try {
      return parseLlmJson(outputContent, {
        evidenceCorpus,
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

  async evaluateImageResume({ screeningCriteria, candidate, imagePath }) {
    const prompt = buildImagePrompt({ screeningCriteria, candidate });
    const imageDataUrl = await this.readImageAsDataUrl(imagePath);
    const evidenceCorpus = normalizeText(candidate?.evidenceCorpus || candidate?.resumeText || '');
    const result = await this.requestByPreference({
      prompt,
      imageDataUrl,
      evidenceCorpus,
      chunkIndex: 1,
      chunkTotal: 1,
    });
    return {
      ...result,
      evaluationMode: 'image',
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
      const result = await this.requestByPreference({
        prompt: buildTextPrompt({
          screeningCriteria,
          candidate,
          resumeText: chunk.text,
          chunkIndex: index + 1,
          chunkTotal: chunks.length,
        }),
        imageDataUrl: null,
        evidenceCorpus: chunk.text,
        chunkIndex: index + 1,
        chunkTotal: chunks.length,
      });
      chunkResults.push(result);
    }

    const passedChunks = chunkResults.filter((item) => item?.passed === true);
    if (passedChunks.length > 0) {
      const best = passedChunks[0];
      return {
        ...best,
        evaluationMode: 'text',
      };
    }

    const firstReason = chunkResults.map((item) => normalizeText(item?.reason)).find(Boolean);
    return {
      passed: false,
      rawPassed: chunkResults.some((item) => item?.rawPassed === true),
      reason: firstReason || `分段筛选未找到满足标准的证据（共 ${chunks.length} 段）。`,
      summary: firstReason || `分段筛选未找到满足标准的证据（共 ${chunks.length} 段）。`,
      evidence: [],
      evidenceRawCount: chunkResults.reduce(
        (acc, item) =>
          acc + (Number.isFinite(Number(item?.evidenceRawCount)) ? Number(item.evidenceRawCount) : 0),
        0,
      ),
      evidenceMatchedCount: chunkResults.reduce(
        (acc, item) =>
          acc + (Number.isFinite(Number(item?.evidenceMatchedCount)) ? Number(item.evidenceMatchedCount) : 0),
        0,
      ),
      evidenceGateDemoted: chunkResults.some((item) => item?.evidenceGateDemoted === true),
      chunkIndex: null,
      chunkTotal: chunks.length,
      evaluationMode: 'text',
    };
  }

  async evaluateResume({ screeningCriteria, candidate, imagePath }) {
    const hasResumeText = Boolean(normalizeText(candidate?.resumeText || ''));
    if (hasResumeText) {
      try {
        return await this.evaluateTextResume({ screeningCriteria, candidate });
      } catch (textError) {
        if (!imagePath) {
          throw textError;
        }
        const imageResult = await this.evaluateImageResume({ screeningCriteria, candidate, imagePath });
        return {
          ...imageResult,
          textFallbackError: normalizeText(textError?.message || textError),
        };
      }
    }
    return this.evaluateImageResume({ screeningCriteria, candidate, imagePath });
  }
}

export const __testables = {
  extractEvidenceTokens,
  matchEvidenceAgainstResume,
  splitTextByChunks,
  isTextContextLimitMessage,
};
