import { readFile } from 'node:fs/promises';

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

export function parseLlmJson(content) {
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
  const passed = typeof parsed.passed === 'boolean' ? parsed.passed : parsed.matched;
  if (typeof passed !== 'boolean') {
    throw new Error('LLM response missing boolean "passed"');
  }
  if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) {
    throw new Error('LLM response missing string "reason"');
  }

  return {
    passed,
    reason: parsed.reason.trim(),
  };
}

function buildPrompt({ screeningCriteria, candidate }) {
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

  return [
    '你是招聘筛选助手，请基于简历截图判断候选人是否符合筛选标准。',
    '只能依据图片中可见信息判断，不得臆测。',
    '只采信当前候选人的主简历内容（教育经历/工作经历/项目经历/专业技能）。',
    '必须忽略推荐模块与匿名卡片信息（例如“其他名企大厂经历牛人”“相似牛人”“推荐牛人”）。',
    '若无法在教育经历模块确认学校名称，不要编造学校名；按信息不足处理。',
    '必须且只能返回 JSON，不要输出 Markdown。',
    '返回格式：{"passed":true/false,"reason":"简短中文原因"}',
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

  async requestResponses(prompt, imageDataUrl) {
    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        max_output_tokens: this.responseMaxOutputTokens,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: imageDataUrl },
            ],
          },
        ],
      }),
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

    const content = getResponsesContent(data);
    if (!content) {
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
      return parseLlmJson(content);
    } catch (parseError) {
      const wrapped = new Error(
        `Responses API returned unparsable content: ${parseError?.message || parseError}`,
      );
      wrapped.code = 'RESPONSES_UNPARSABLE';
      throw wrapped;
    }
  }

  async requestCompletions(prompt, imageDataUrl) {
    const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        max_tokens: this.completionMaxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
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

    const content = getCompletionContent(data);
    if (!String(content || '').trim()) {
      const emptyError = new Error('Completions API empty textual content');
      emptyError.code = 'COMPLETIONS_EMPTY_CONTENT';
      throw emptyError;
    }

    try {
      return parseLlmJson(content);
    } catch (parseError) {
      const wrapped = new Error(
        `Completions API returned unparsable content: ${parseError?.message || parseError}`,
      );
      wrapped.code = 'COMPLETIONS_UNPARSABLE';
      throw wrapped;
    }
  }

  async evaluateResume({ screeningCriteria, candidate, imagePath }) {
    const prompt = buildPrompt({ screeningCriteria, candidate });
    const imageDataUrl = await this.readImageAsDataUrl(imagePath);

    if (this.preferCompletions) {
      try {
        return await this.withRetries('completions', async () =>
          this.requestCompletions(prompt, imageDataUrl),
        );
      } catch (completionsError) {
        if (!shouldFallbackToResponses(completionsError)) {
          throw completionsError;
        }
        return this.withRetries('responses', async () =>
          this.requestResponses(prompt, imageDataUrl),
        );
      }
    }

    try {
      return await this.withRetries('responses', async () =>
        this.requestResponses(prompt, imageDataUrl),
      );
    } catch (responsesError) {
      if (!shouldFallbackToCompletions(responsesError)) {
        throw responsesError;
      }
      return this.withRetries('completions', async () =>
        this.requestCompletions(prompt, imageDataUrl),
      );
    }
  }
}
