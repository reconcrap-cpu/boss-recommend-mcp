import assert from 'node:assert/strict';
import test from 'node:test';

import { LlmClient, __testables } from './llm.js';

function createJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function createErrorResponse(status, message) {
  return {
    ok: false,
    status,
    statusText: '',
    async json() {
      return {};
    },
    async text() {
      return message;
    },
  };
}

function createCompletionsPayload(content) {
  return {
    choices: [
      {
        message: {
          content,
        },
      },
    ],
  };
}

function createClient(fetchImpl) {
  return new LlmClient(
    {
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      model: 'test-model',
    },
    {
      fetchImpl,
      preferCompletions: true,
      maxRetries: 1,
      timeoutMs: 5000,
    },
  );
}

function getPromptFromOptions(options = {}) {
  const payload = JSON.parse(String(options.body || '{}'));
  return String(
    payload?.messages?.[0]?.content?.[0]?.text ||
      payload?.input?.[0]?.content?.[0]?.text ||
      '',
  );
}

async function withChunkEnv(overrides, fn) {
  const keys = [
    'BOSS_CHAT_TEXT_CHUNK_SIZE_CHARS',
    'BOSS_CHAT_TEXT_CHUNK_OVERLAP_CHARS',
    'BOSS_CHAT_TEXT_MAX_CHUNKS',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides || {})) {
    process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function buildCandidate(resumeText) {
  return {
    name: '候选人A',
    sourceJob: '算法工程师',
    resumeProfile: {
      primarySchool: '南京大学',
      schools: ['南京大学'],
      major: '人工智能',
      majors: ['人工智能'],
      company: '测试公司',
      position: '算法工程师',
    },
    resumeText,
    evidenceCorpus: resumeText,
  };
}

test('evaluateTextResume keeps the full-text fast path when context allows', async () => {
  const marker = '__END_OF_FULL_RESUME__';
  const resumeText = `${'A'.repeat(32000)}${marker}`;
  let callCount = 0;
  let capturedPrompt = '';
  const client = createClient(async (_url, options) => {
    callCount += 1;
    capturedPrompt = getPromptFromOptions(options);
    return createJsonResponse(createCompletionsPayload('{"passed":false}'));
  });

  const result = await client.evaluateTextResume({
    screeningCriteria: '有 AI 项目经验',
    candidate: buildCandidate(resumeText),
  });

  assert.equal(result.passed, false);
  assert.equal(result.evaluationMode, 'text');
  assert.equal(result.aggregateRetryUsed, false);
  assert.equal(callCount, 1);
  assert.equal(capturedPrompt.includes(marker), true);
});

test('evaluateTextResume aggregates chunk evidence for long resumes instead of using any-pass shortcut', async () => {
  const chunkOneMarker = '本科 2025 届，南京大学';
  const chunkTwoMarker = '有 2 段 AI 项目与工作经历';
  const resumeText = `${chunkOneMarker}\n${'A'.repeat(1300)}\n${chunkTwoMarker}\n${'B'.repeat(300)}`;
  const expectedChunkCount = __testables.splitTextByChunks(resumeText, 1000, 1, 6).length;
  let callCount = 0;
  let aggregatePrompt = '';
  const client = createClient(async (_url, options) => {
    callCount += 1;
    const prompt = getPromptFromOptions(options);
    if (callCount === 1) {
      return createErrorResponse(400, 'maximum context length exceeded');
    }
    const chunkMatch = prompt.match(/当前分段：\s*(\d+)\/(\d+)/);
    if (chunkMatch) {
      const chunkIndex = Number(chunkMatch[1]);
      const chunkTotal = Number(chunkMatch[2]);
      const isFirst = chunkIndex === 1;
      const isLast = chunkIndex === chunkTotal;
      return createJsonResponse(
        createCompletionsPayload(
          JSON.stringify({
            chunk_passed: false,
            chunk_summary: isFirst ? '教育信息命中' : isLast ? '项目与工作信息命中' : '中间分段主要是补充描述',
            hard_evidence: isFirst ? ['本科 2025 届', '南京大学'] : isLast ? ['AI 项目', '2 段工作经历'] : [],
            soft_evidence: [],
            hard_blockers: [],
            missing_or_uncertain: isLast ? [] : ['还需结合后续分段'],
            quoted_spans: isFirst ? ['本科 2025 届'] : isLast ? ['2 段工作经历'] : [],
            chunk_index: chunkIndex,
            chunk_total: chunkTotal,
          }),
        ),
      );
    }
    aggregatePrompt = prompt;
    return createJsonResponse(
      createCompletionsPayload(
        JSON.stringify({
          passed: true,
          reason: '综合全部分段后，教育背景与 AI 项目/工作经历共同满足筛选条件。',
          summary: '跨 chunk 证据成立',
          evidence: ['本科 2025 届', 'AI 项目', '2 段工作经历'],
        }),
      ),
    );
  });

  const result = await withChunkEnv(
    {
      BOSS_CHAT_TEXT_CHUNK_SIZE_CHARS: '1000',
      BOSS_CHAT_TEXT_CHUNK_OVERLAP_CHARS: '1',
      BOSS_CHAT_TEXT_MAX_CHUNKS: '6',
    },
    () =>
      client.evaluateTextResume({
        screeningCriteria: '有 AI 项目经验',
        candidate: buildCandidate(resumeText),
      }),
  );

  assert.equal(result.passed, true);
  assert.equal(result.evaluationMode, 'text-chunk-aggregate');
  assert.equal(result.chunkIndex, null);
  assert.equal(result.chunkTotal, expectedChunkCount);
  assert.equal(result.aggregateRetryUsed, false);
  assert.equal(callCount, expectedChunkCount + 2);
  assert.equal(aggregatePrompt.includes(`"chunk_count": ${expectedChunkCount}`), true);
  assert.equal(aggregatePrompt.includes('本科 2025 届'), true);
  assert.equal(aggregatePrompt.includes('AI 项目'), true);
});

test('evaluateTextResume does not pass when one chunk passes but aggregate decision rejects', async () => {
  const resumeText = `${'A'.repeat(900)}\n局部命中关键词\n${'B'.repeat(900)}`;
  const client = createClient(async (_url, options) => {
    const prompt = getPromptFromOptions(options);
    if (prompt.includes('简历文本:') && !prompt.includes('当前分段：')) {
      return createErrorResponse(400, 'maximum context length exceeded');
    }
    const chunkMatch = prompt.match(/当前分段：\s*(\d+)\/(\d+)/);
    if (chunkMatch) {
      const chunkIndex = Number(chunkMatch[1]);
      return createJsonResponse(
        createCompletionsPayload(
          JSON.stringify({
            chunk_passed: chunkIndex === 1,
            chunk_summary: chunkIndex === 1 ? '局部关键词命中' : '缺少完整证据',
            hard_evidence: chunkIndex === 1 ? ['局部关键词'] : [],
            soft_evidence: [],
            hard_blockers: chunkIndex === 1 ? [] : ['缺少连续工作/项目证据'],
            missing_or_uncertain: ['完整时间线不足'],
            quoted_spans: chunkIndex === 1 ? ['局部关键词'] : ['缺少连续工作/项目证据'],
            chunk_index: chunkIndex,
            chunk_total: Number(chunkMatch[2]),
          }),
        ),
      );
    }
    return createJsonResponse(
      createCompletionsPayload(
        JSON.stringify({
          passed: false,
          reason: '综合全部分段后仍缺少完整项目与工作链路，不能通过。',
          summary: '聚合后不通过',
          evidence: ['缺少连续工作/项目证据'],
        }),
      ),
    );
  });

  const result = await withChunkEnv(
    {
      BOSS_CHAT_TEXT_CHUNK_SIZE_CHARS: '1000',
      BOSS_CHAT_TEXT_CHUNK_OVERLAP_CHARS: '1',
      BOSS_CHAT_TEXT_MAX_CHUNKS: '6',
    },
    () =>
      client.evaluateTextResume({
        screeningCriteria: '有 AI 项目经验',
        candidate: buildCandidate(resumeText),
      }),
  );

  assert.equal(result.passed, false);
  assert.equal(result.evaluationMode, 'text-chunk-aggregate');
});

test('evaluateTextResume retries aggregate once with compacted evidence and fails on invalid aggregate JSON', async () => {
  const resumeText = `${'第一段证据 '.repeat(160)}\n${'第二段证据 '.repeat(160)}`;
  const aggregatePrompts = [];
  const client = createClient(async (url, options) => {
    const prompt = getPromptFromOptions(options);
    if (prompt.includes('简历文本:') && !prompt.includes('当前分段：')) {
      return createErrorResponse(400, 'maximum context length exceeded');
    }
    if (prompt.includes('当前分段：')) {
      const chunkMatch = prompt.match(/当前分段：\s*(\d+)\/(\d+)/);
      const chunkIndex = Number(chunkMatch[1]);
      return createJsonResponse(
        createCompletionsPayload(
          JSON.stringify({
            chunk_passed: false,
            chunk_summary: `分段 ${chunkIndex} 提取到多条证据`,
            hard_evidence: [`关键证据 ${chunkIndex}-1`, `关键证据 ${chunkIndex}-2`, `关键证据 ${chunkIndex}-3`],
            soft_evidence: [`补充证据 ${chunkIndex}-1`, `补充证据 ${chunkIndex}-2`],
            hard_blockers: [],
            missing_or_uncertain: [`待确认信息 ${chunkIndex}-1`, `待确认信息 ${chunkIndex}-2`],
            quoted_spans: [`原文片段 ${chunkIndex}-1`, `原文片段 ${chunkIndex}-2`],
            chunk_index: chunkIndex,
            chunk_total: Number(chunkMatch[2]),
          }),
        ),
      );
    }
    aggregatePrompts.push(prompt);
    if (aggregatePrompts.length === 1) {
      return createErrorResponse(400, 'maximum context length exceeded');
    }
    if (String(url || '').includes('/responses')) {
      return createJsonResponse({
        output_text: '{"reason":"missing passed field","summary":"invalid"}',
      });
    }
    return createJsonResponse(
      createCompletionsPayload(
        JSON.stringify({
          reason: 'missing passed field',
          summary: 'invalid',
        }),
      ),
    );
  });

  await assert.rejects(
    () =>
      withChunkEnv(
        {
          BOSS_CHAT_TEXT_CHUNK_SIZE_CHARS: '1000',
          BOSS_CHAT_TEXT_CHUNK_OVERLAP_CHARS: '1',
          BOSS_CHAT_TEXT_MAX_CHUNKS: '6',
        },
        () =>
          client.evaluateTextResume({
            screeningCriteria: '有 AI 项目经验',
            candidate: buildCandidate(resumeText),
          }),
      ),
    /missing boolean "passed"|unparsable/i,
  );

  assert.equal(aggregatePrompts.length >= 2, true);
  assert.equal(aggregatePrompts[1].length < aggregatePrompts[0].length, true);
});
