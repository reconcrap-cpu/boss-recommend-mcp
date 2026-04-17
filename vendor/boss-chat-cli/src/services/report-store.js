import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TIMING_BUCKETS = [
  ['initialNetworkWaitMs', '初始 network 等待'],
  ['networkRetryMs', 'network 重试'],
  ['imageCaptureMs', '简历截图'],
  ['imageModelMs', '图片模型'],
  ['lateNetworkRetryMs', '晚到 network 重试'],
  ['domFallbackMs', 'DOM 兜底'],
  ['textModelMs', '文本模型'],
];

const CSV_HEADER = [
  'index',
  'name',
  'source_job',
  'decision',
  'passed',
  'requested',
  'resume_acquisition_mode',
  'resume_acquisition_reason',
  'evaluation_mode',
  'evaluation_image_count',
  'initial_network_wait_ms',
  'network_retry_ms',
  'image_capture_ms',
  'image_model_ms',
  'late_network_retry_ms',
  'dom_fallback_ms',
  'text_model_ms',
  'timing_summary',
  'reason',
  'error_message',
  'llm_raw_output_preview',
];

function timestampToken(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function previewText(value, maxLength = 160) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function formatDurationMs(startedAt, finishedAt) {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const finished = finishedAt ? Date.parse(finishedAt) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return '-';
  }
  const totalMs = Math.round(finished - started);
  if (totalMs < 1000) return `${totalMs}ms`;
  if (totalMs < 60_000) return `${(totalMs / 1000).toFixed(1)}s`;
  return `${(totalMs / 60_000).toFixed(1)}m`;
}

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function toResults(summary) {
  return Array.isArray(summary?.results) ? summary.results : [];
}

function toOutcome(result) {
  if (normalizeText(result?.decision)) return normalizeText(result.decision);
  if (result?.passed) return 'passed';
  if (normalizeText(result?.error)) return 'error';
  return 'skipped';
}

function getArtifacts(result) {
  return result?.artifacts && typeof result.artifacts === 'object' ? result.artifacts : {};
}

function getAcquisitionMode(result) {
  return normalizeText(getArtifacts(result).resumeAcquisitionMode);
}

function getAcquisitionReason(result) {
  return normalizeText(getArtifacts(result).resumeAcquisitionReason);
}

function getTimingValue(result, key) {
  return normalizeMs(getArtifacts(result)[key]);
}

function formatTimingSummary(result) {
  const parts = [];
  for (const [key, label] of TIMING_BUCKETS) {
    const value = getTimingValue(result, key);
    if (value === null) continue;
    parts.push(`${label} ${value}ms`);
  }
  return parts.length > 0 ? parts.join(' | ') : '-';
}

function formatResultNotes(result) {
  const parts = [];
  const reason = previewText(result?.reason, 120);
  const errorMessage = previewText(result?.error, 120);
  const llmRawOutput = previewText(getArtifacts(result).llmRawOutput, 180);
  if (reason) parts.push(`原因: ${reason}`);
  if (errorMessage) parts.push(`错误: ${errorMessage}`);
  if (llmRawOutput) parts.push(`LLM: ${llmRawOutput}`);
  return parts.length > 0 ? parts.join(' | ') : '-';
}

function buildAcquisitionSummaryRows(results) {
  const counts = new Map();
  for (const result of results) {
    const mode = getAcquisitionMode(result) || 'unknown';
    const reason = getAcquisitionReason(result) || 'unspecified';
    const key = `${mode}__${reason}`;
    const current = counts.get(key) || { mode, reason, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) => right.count - left.count || left.mode.localeCompare(right.mode));
}

function buildTimingSummaryRows(results) {
  return TIMING_BUCKETS.map(([key, label]) => {
    let count = 0;
    let total = 0;
    for (const result of results) {
      const value = getTimingValue(result, key);
      if (value === null) continue;
      count += 1;
      total += value;
    }
    return {
      key,
      label,
      count,
      total,
      average: count > 0 ? Math.round(total / count) : null,
    };
  }).filter((item) => item.count > 0);
}

function buildMarkdownSummary(summary) {
  const results = toResults(summary);
  const acquisitionRows = buildAcquisitionSummaryRows(results);
  const timingRows = buildTimingSummaryRows(results);
  const lines = [
    '# Boss Chat 运行报告',
    '',
    '## 概览',
    `- 开始时间: ${summary?.startedAt || '-'}`,
    `- 结束时间: ${summary?.finishedAt || '-'}`,
    `- 总耗时: ${formatDurationMs(summary?.startedAt, summary?.finishedAt)}`,
    `- 处理进度: inspected=${Number(summary?.inspected || 0)} / target=${summary?.profile?.targetCount || '∞'}`,
    `- 结果统计: passed=${Number(summary?.passed || 0)} | requested=${Number(summary?.requested || 0)} | skipped=${Number(summary?.skipped || 0)} | errors=${Number(summary?.errors || 0)}`,
    `- 停止状态: ${summary?.stopped ? `stopped (${summary?.stopReason || 'unknown'})` : 'completed'}`,
    `- 穷尽列表: ${summary?.exhausted === true ? 'yes' : 'no'}`,
    `- 报告文件: JSON=${summary?.reportPath || '-'} | Markdown=${summary?.reportMarkdownPath || '-'} | CSV=${summary?.reportCsvPath || '-'}`,
    '',
    '## Resume Acquisition 汇总',
    '',
    '| mode | retry_reason | count |',
    '| --- | --- | ---: |',
  ];

  if (acquisitionRows.length === 0) {
    lines.push('| - | - | 0 |');
  } else {
    for (const row of acquisitionRows) {
      lines.push(`| ${row.mode} | ${row.reason} | ${row.count} |`);
    }
  }

  lines.push('');
  lines.push('## Timing 汇总');
  lines.push('');
  lines.push('| bucket | hits | total | avg |');
  lines.push('| --- | ---: | ---: | ---: |');
  if (timingRows.length === 0) {
    lines.push('| - | 0 | - | - |');
  } else {
    for (const row of timingRows) {
      lines.push(`| ${row.label} | ${row.count} | ${row.total}ms | ${row.average === null ? '-' : `${row.average}ms`} |`);
    }
  }

  lines.push('');
  lines.push('## 候选人明细');
  lines.push('');
  lines.push('| # | 姓名 | 结论 | acquisition | retry_reason | timing | notes |');
  lines.push('| ---: | --- | --- | --- | --- | --- | --- |');

  if (results.length === 0) {
    lines.push('| 1 | - | - | - | - | - | - |');
  } else {
    results.forEach((result, index) => {
      lines.push(
        `| ${index + 1} | ${previewText(result?.name || '未知', 32) || '未知'} | ${toOutcome(result)} | ${getAcquisitionMode(result) || '-'} | ${getAcquisitionReason(result) || '-'} | ${formatTimingSummary(result)} | ${formatResultNotes(result)} |`,
      );
    });
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function buildCsvSummary(summary) {
  const results = toResults(summary);
  const lines = [CSV_HEADER.join(',')];
  results.forEach((result, index) => {
    const artifacts = getArtifacts(result);
    lines.push([
      csvEscape(index + 1),
      csvEscape(result?.name || ''),
      csvEscape(result?.sourceJob || ''),
      csvEscape(toOutcome(result)),
      csvEscape(result?.passed === true ? 'true' : 'false'),
      csvEscape(result?.requested === true ? 'true' : 'false'),
      csvEscape(getAcquisitionMode(result)),
      csvEscape(getAcquisitionReason(result)),
      csvEscape(artifacts.evaluationMode || ''),
      csvEscape(Number.isFinite(Number(artifacts.evaluationImageCount)) ? Number(artifacts.evaluationImageCount) : ''),
      csvEscape(getTimingValue(result, 'initialNetworkWaitMs') ?? ''),
      csvEscape(getTimingValue(result, 'networkRetryMs') ?? ''),
      csvEscape(getTimingValue(result, 'imageCaptureMs') ?? ''),
      csvEscape(getTimingValue(result, 'imageModelMs') ?? ''),
      csvEscape(getTimingValue(result, 'lateNetworkRetryMs') ?? ''),
      csvEscape(getTimingValue(result, 'domFallbackMs') ?? ''),
      csvEscape(getTimingValue(result, 'textModelMs') ?? ''),
      csvEscape(formatTimingSummary(result)),
      csvEscape(result?.reason || ''),
      csvEscape(result?.error || ''),
      csvEscape(previewText(artifacts.llmRawOutput, 500)),
    ].join(','));
  });
  return `\uFEFF${lines.join('\n')}\n`;
}

export class ReportStore {
  constructor(baseDir) {
    this.reportsDir = path.join(baseDir, 'reports');
  }

  async write(summary) {
    await mkdir(this.reportsDir, { recursive: true });
    const baseName = `run-${timestampToken()}`;
    const jsonPath = path.join(this.reportsDir, `${baseName}.json`);
    const markdownPath = path.join(this.reportsDir, `${baseName}.md`);
    const csvPath = path.join(this.reportsDir, `${baseName}.csv`);

    if (summary && typeof summary === 'object') {
      summary.reportPath = jsonPath;
      summary.reportMarkdownPath = markdownPath;
      summary.reportCsvPath = csvPath;
      summary.reportArtifacts = {
        jsonPath,
        markdownPath,
        csvPath,
      };
    }

    await Promise.all([
      writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
      writeFile(markdownPath, buildMarkdownSummary(summary), 'utf8'),
      writeFile(csvPath, buildCsvSummary(summary), 'utf8'),
    ]);
    return jsonPath;
  }
}
