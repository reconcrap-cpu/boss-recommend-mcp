import fs from "node:fs";
import path from "node:path";

export const LEGACY_INPUT_HEADER = ["运行输入字段", "运行输入值"];

export const LEGACY_RESULT_HEADER = [
  "姓名",
  "最高学历学校",
  "最高学历专业",
  "最近工作公司",
  "最近工作职位",
  "评估通过详细原因",
  "处理结果",
  "判断依据(CoT)",
  "动作执行结果",
  "简历来源",
  "原始判定通过",
  "最终判定通过",
  "LLM thinking_level",
  "LLM screening_strategy",
  "LLM decision_source",
  "LLM verified",
  "LLM verification_reason",
  "错误码",
  "错误信息",
  "候选人ID",
  "总耗时ms",
  "候选卡片读取ms",
  "点击候选人ms",
  "详情打开ms",
  "network简历等待ms",
  "文本模型ms",
  "截图获取ms",
  "视觉模型ms",
  "late network retry ms",
  "DOM fallback ms",
  "通过后动作ms",
  "关闭详情ms",
  "休息ms",
  "checkpoint保存ms"
];

const SEARCH_PARAM_ORDER = [
  "school_tag",
  "degree",
  "degrees",
  "gender",
  "recent_not_view",
  "city",
  "schools",
  "keyword",
  "filter_recent_viewed",
  "skip_recent_colleague_contacted",
  "job",
  "start_from",
  "target_count",
  "detail_source"
];

const SCREEN_PARAM_ORDER = [
  "criteria",
  "target_count",
  "post_action",
  "max_greet_count",
  "skip_recent_colleague_contacted",
  "colleague_contact_window_days",
  "search_exchange_resume_filter_days"
];

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeBlockText(value) {
  return String(value ?? "").trim();
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cloneJson(value, fallback = null) {
  try {
    return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function formatInputValue(value) {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function appendInputRow(rows, field, value) {
  if (!field || value === undefined) return;
  rows.push({
    field,
    value: formatInputValue(value)
  });
}

function appendPrefixedRows(rows, prefix, values = {}, order = []) {
  const source = values && typeof values === "object" && !Array.isArray(values) ? values : {};
  const emitted = new Set();
  for (const key of order) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      appendInputRow(rows, `${prefix}.${key}`, source[key]);
      emitted.add(key);
    }
  }
  for (const key of Object.keys(source).sort()) {
    if (emitted.has(key)) continue;
    appendInputRow(rows, `${prefix}.${key}`, source[key]);
  }
}

export function buildLegacyScreenInputRows({
  instruction = "",
  selectedPage = "",
  selectedJob = null,
  userSearchParams = {},
  effectiveSearchParams = {},
  screenParams = {},
  followUp = null,
  extraRows = []
} = {}) {
  const rows = [];
  appendInputRow(rows, "instruction", instruction);
  appendInputRow(rows, "selected_page", selectedPage);

  if (selectedJob && typeof selectedJob === "object") {
    appendInputRow(rows, "selected_job.value", selectedJob.value);
    appendInputRow(rows, "selected_job.title", selectedJob.title);
    appendInputRow(rows, "selected_job.label", selectedJob.label);
  } else if (selectedJob) {
    appendInputRow(rows, "selected_job.label", selectedJob);
  }

  appendPrefixedRows(rows, "user_search_params", userSearchParams, SEARCH_PARAM_ORDER);
  appendPrefixedRows(rows, "effective_search_params", effectiveSearchParams, SEARCH_PARAM_ORDER);
  appendPrefixedRows(rows, "screen_params", screenParams, SCREEN_PARAM_ORDER);
  appendInputRow(rows, "follow_up", followUp);

  for (const row of extraRows || []) {
    if (Array.isArray(row)) appendInputRow(rows, row[0], row[1]);
    else appendInputRow(rows, row?.field, row?.value);
  }
  return rows;
}

export function defaultLegacyCsvPathForReport(reportPath) {
  const resolved = path.resolve(reportPath);
  const parsed = path.parse(resolved);
  return path.join(parsed.dir, `${parsed.name}.csv`);
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return "";
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeBlockText(value);
    if (text) return text;
  }
  return "";
}

function firstBoolean(...values) {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const text = normalizeText(value).toLowerCase();
    if (["true", "pass", "passed", "yes", "是", "通过", "符合"].includes(text)) return true;
    if (["false", "fail", "failed", "no", "否", "不通过", "不符合"].includes(text)) return false;
  }
  return "";
}

function actionResultText(row = {}) {
  const action = row.post_action || row.action || {};
  if (action.requested === true && !action.skipped) {
    return firstText(action.reason, action.kind, action.type, "requested");
  }
  if (action.skipped) {
    return firstText(action.reason, action.kind, action.type, "skipped");
  }
  if (action.action_clicked || action.clicked) {
    return firstText(action.effective, action.requested, action.kind, action.type, "clicked");
  }
  if (action.action_attempted || action.attempted) return "failed";
  if (action.requested && action.requested !== "none") return "not_attempted";
  return "";
}

function pickLlm(row = {}) {
  return row.llm
    || row.llm_screening
    || row.detail?.llm_screening
    || row.screening?.llm
    || {};
}

function pickCandidate(row = {}) {
  const screeningCandidate = row.screening?.candidate || {};
  const candidate = row.candidate || row.card_candidate || {};
  return {
    ...screeningCandidate,
    ...candidate,
    identity: {
      ...(screeningCandidate.identity || {}),
      ...(candidate.identity || {})
    }
  };
}

function timingValue(row = {}, ...keys) {
  const timings = row.timings || row.timing || {};
  const detail = row.detail || {};
  const acquisition = detail.cv_acquisition || {};
  const fallbackByKey = {
    network_cv_wait_ms: acquisition.network_wait?.elapsed_ms,
    screenshot_capture_ms: acquisition.image_evidence?.elapsed_ms || detail.image_evidence?.elapsed_ms,
    dom_fallback_ms: acquisition.content_wait?.elapsed_ms,
    close_detail_ms: detail.close_result?.elapsed_ms,
    post_action_ms: row.post_action?.elapsed_ms
  };
  for (const key of keys) {
    const value = firstDefined(row[key], timings[key], fallbackByKey[key]);
    if (value !== "") return value;
  }
  return "";
}

export function legacyScreenResultRow(row = {}) {
  const candidate = pickCandidate(row);
  const identity = candidate.identity || {};
  const detail = row.detail || {};
  const screening = row.screening || {};
  const llm = pickLlm(row);
  const rawPassed = firstBoolean(llm.passed, screening.passed, row.raw_passed, row.passed);
  const finalPassed = firstBoolean(row.final_passed, row.finalPassed, rawPassed);
  const hasError = Boolean(row.error || row.error_code || row.error_message);
  const processResult = hasError
    ? "error"
    : finalPassed === true
      ? "passed"
      : "skipped";
  const cot = firstText(
    llm.decision_cot,
    llm.cot,
    llm.reasoning_content,
    llm.raw_reasoning_content,
    llm.raw_model_output,
    llm.raw_content,
    row.decision_cot,
    row.cot,
    screening.decision_cot,
    screening.cot
  );
  const error = row.error || {};
  const cvSource = firstText(
    detail.cv_acquisition?.source,
    row.cv_source,
    candidate.source,
    screening.candidate?.source
  );
  return [
    identity.name,
    identity.school,
    identity.major,
    identity.current_company,
    identity.current_position,
    "",
    processResult,
    cot,
    actionResultText(row),
    cvSource,
    rawPassed,
    finalPassed,
    firstText(llm.provider?.thinking_level),
    firstText(llm.screening_strategy),
    firstText(llm.decision_source),
    typeof llm.verified === "boolean" ? llm.verified : "",
    firstText(llm.verification_reason),
    row.error_code || error.code || error.name || llm.error_code || (llm.error ? "LLM_SCREENING_ERROR" : ""),
    row.error_message || error.message || llm.error || "",
    candidate.id || row.candidate_id || "",
    timingValue(row, "total_ms"),
    timingValue(row, "card_read_ms"),
    timingValue(row, "candidate_click_ms"),
    timingValue(row, "detail_open_ms"),
    timingValue(row, "network_cv_wait_ms"),
    timingValue(row, "text_model_ms"),
    timingValue(row, "screenshot_capture_ms"),
    timingValue(row, "vision_model_ms"),
    timingValue(row, "late_network_retry_ms"),
    timingValue(row, "dom_fallback_ms"),
    timingValue(row, "post_action_ms"),
    timingValue(row, "close_detail_ms"),
    timingValue(row, "sleep_ms"),
    timingValue(row, "checkpoint_save_ms")
  ];
}

export function writeLegacyScreenCsv(filePath, {
  inputRows = [],
  results = []
} = {}) {
  const resolved = path.resolve(filePath);
  ensureDirectory(path.dirname(resolved));
  const normalizedInputRows = (inputRows || []).map((row) => ({
    field: row?.field ?? row?.[0] ?? "",
    value: row?.value ?? row?.[1] ?? ""
  }));
  const lines = [
    LEGACY_INPUT_HEADER.map(csvCell).join(","),
    ...normalizedInputRows.map((row) => [row.field, row.value].map(csvCell).join(",")),
    "",
    LEGACY_RESULT_HEADER.map(csvCell).join(","),
    ...(results || []).map((row) => legacyScreenResultRow(row).map(csvCell).join(","))
  ];
  const tempPath = `${resolved}.tmp`;
  fs.writeFileSync(tempPath, `\uFEFF${lines.join("\n")}\n`, "utf8");
  fs.renameSync(tempPath, resolved);
  return resolved;
}

export function cloneReportInput(value, fallback = {}) {
  return cloneJson(value, fallback);
}
