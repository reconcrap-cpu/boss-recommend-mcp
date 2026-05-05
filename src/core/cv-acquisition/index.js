export const CV_ACQUISITION_MODE_UNKNOWN = "unknown";
export const CV_ACQUISITION_MODE_NETWORK = "network";
export const CV_ACQUISITION_MODE_IMAGE = "image";

export const NETWORK_RESUME_WAIT_MS = 4200;
export const NETWORK_RESUME_RETRY_WAIT_MS = 2000;
export const NETWORK_RESUME_IMAGE_MODE_GRACE_MS = 1000;

const VALID_MODES = new Set([
  CV_ACQUISITION_MODE_UNKNOWN,
  CV_ACQUISITION_MODE_NETWORK,
  CV_ACQUISITION_MODE_IMAGE
]);

function normalizeMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : CV_ACQUISITION_MODE_UNKNOWN;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

export function createCvAcquisitionState({
  mode = CV_ACQUISITION_MODE_UNKNOWN
} = {}) {
  return {
    schema_version: 1,
    mode: normalizeMode(mode),
    attempts: 0,
    network_hits: 0,
    image_fallbacks: 0,
    misses: 0,
    last_result: null,
    history: []
  };
}

export function getCvNetworkWaitPlan(state = {}, {
  networkWaitMs = NETWORK_RESUME_WAIT_MS,
  networkRetryWaitMs = NETWORK_RESUME_RETRY_WAIT_MS,
  imageModeGraceMs = NETWORK_RESUME_IMAGE_MODE_GRACE_MS
} = {}) {
  const modeBefore = normalizeMode(state?.mode);
  if (modeBefore === CV_ACQUISITION_MODE_IMAGE) {
    return {
      schema_version: 1,
      mode_before: modeBefore,
      reason: "previous_image_mode_short_network_grace",
      initial_wait_ms: positiveNumber(imageModeGraceMs, NETWORK_RESUME_IMAGE_MODE_GRACE_MS),
      retry_wait_ms: 0
    };
  }

  return {
    schema_version: 1,
    mode_before: modeBefore,
    reason: "network_primary_full_wait",
    initial_wait_ms: positiveNumber(networkWaitMs, NETWORK_RESUME_WAIT_MS),
    retry_wait_ms: positiveNumber(networkRetryWaitMs, NETWORK_RESUME_RETRY_WAIT_MS)
  };
}

export async function waitForCvNetworkEvents(waitForNetworkEvents, recorder, {
  waitPlan = getCvNetworkWaitPlan(),
  minCount = 1,
  requireLoaded = true,
  intervalMs = 120
} = {}) {
  if (typeof waitForNetworkEvents !== "function") {
    throw new Error("waitForCvNetworkEvents requires a domain wait function");
  }
  const started = Date.now();
  const stages = [];

  const initial = await waitForNetworkEvents(recorder, {
    minCount,
    requireLoaded,
    timeoutMs: waitPlan.initial_wait_ms,
    intervalMs
  });
  stages.push({
    stage: "initial",
    ...compactNetworkWait(initial)
  });

  if (!initial.ok && waitPlan.retry_wait_ms > 0) {
    const retry = await waitForNetworkEvents(recorder, {
      minCount,
      requireLoaded,
      timeoutMs: waitPlan.retry_wait_ms,
      intervalMs
    });
    stages.push({
      stage: "retry",
      ...compactNetworkWait(retry)
    });
  }

  const last = stages[stages.length - 1] || {};
  return {
    ok: stages.some((stage) => stage.ok),
    elapsed_ms: Date.now() - started,
    count: Math.max(...stages.map((stage) => Number(stage.count) || 0), 0),
    total_event_count: last.total_event_count ?? last.count ?? 0,
    wait_plan: waitPlan,
    stages
  };
}

export function countParsedNetworkProfiles(detailResult = {}) {
  return (detailResult?.parsed_network_profiles || []).filter((item) => item?.ok).length;
}

export function hasParsedNetworkProfile(detailResult = {}) {
  return countParsedNetworkProfiles(detailResult) > 0;
}

export function summarizeImageEvidence(imageEvidence = null) {
  if (!imageEvidence) return null;
  return {
    ok: imageEvidence.ok !== false,
    source: imageEvidence.source || "",
    elapsed_ms: imageEvidence.elapsed_ms || 0,
    capture_count: imageEvidence.capture_count || imageEvidence.screenshot_count || 0,
    screenshot_count: imageEvidence.screenshot_count || 0,
    unique_screenshot_count: imageEvidence.unique_screenshot_count || 0,
    dropped_duplicate_count: imageEvidence.dropped_duplicate_count || 0,
    total_byte_length: imageEvidence.total_byte_length || 0,
    original_total_byte_length: imageEvidence.original_total_byte_length || 0,
    llm_screenshot_count: imageEvidence.llm_screenshot_count || 0,
    llm_total_byte_length: imageEvidence.llm_total_byte_length || 0,
    llm_original_total_byte_length: imageEvidence.llm_original_total_byte_length || 0,
    llm_composition_error: imageEvidence.llm_composition_error || null,
    optimization: imageEvidence.optimization || null,
    scroll_anchor_plan: imageEvidence.scroll_anchor_plan || null,
    stop_boundary_plan: imageEvidence.stop_boundary_plan || null,
    stop_boundary_checks: imageEvidence.stop_boundary_checks || [],
    stop_boundary_result: imageEvidence.stop_boundary_result || null,
    error_code: imageEvidence.error_code || imageEvidence.code || null,
    error: imageEvidence.error || null,
    file_paths: imageEvidence.file_paths || [],
    llm_file_paths: imageEvidence.llm_file_paths || [],
    first_clip: imageEvidence.screenshots?.[0]?.clip || imageEvidence.clip || null
  };
}

export function recordCvNetworkHit(state, {
  reason = "parsed_network_profile",
  parsedNetworkProfileCount = 0,
  waitResult = null
} = {}) {
  return recordCvAcquisitionResult(state, {
    source: CV_ACQUISITION_MODE_NETWORK,
    reason,
    parsed_network_profile_count: parsedNetworkProfileCount,
    wait_result: waitResult
  });
}

export function recordCvImageFallback(state, {
  reason = "network_miss_image_fallback",
  parsedNetworkProfileCount = 0,
  waitResult = null,
  imageEvidence = null
} = {}) {
  return recordCvAcquisitionResult(state, {
    source: CV_ACQUISITION_MODE_IMAGE,
    reason,
    parsed_network_profile_count: parsedNetworkProfileCount,
    wait_result: waitResult,
    image_evidence: summarizeImageEvidence(imageEvidence)
  });
}

export function recordCvNetworkMiss(state, {
  reason = "network_miss",
  parsedNetworkProfileCount = 0,
  waitResult = null
} = {}) {
  return recordCvAcquisitionResult(state, {
    source: "miss",
    reason,
    parsed_network_profile_count: parsedNetworkProfileCount,
    wait_result: waitResult
  });
}

export function compactCvAcquisitionState(state = {}) {
  return {
    mode: normalizeMode(state.mode),
    attempts: Number(state.attempts) || 0,
    network_hits: Number(state.network_hits) || 0,
    image_fallbacks: Number(state.image_fallbacks) || 0,
    misses: Number(state.misses) || 0,
    last_result: state.last_result || null
  };
}

function recordCvAcquisitionResult(state, result) {
  if (!state || typeof state !== "object") {
    throw new Error("CV acquisition state is required");
  }
  const recorded = {
    schema_version: 1,
    recorded_at: nowIso(),
    ...result
  };
  state.attempts = (Number(state.attempts) || 0) + 1;
  if (result.source === CV_ACQUISITION_MODE_NETWORK) {
    state.mode = CV_ACQUISITION_MODE_NETWORK;
    state.network_hits = (Number(state.network_hits) || 0) + 1;
  } else if (result.source === CV_ACQUISITION_MODE_IMAGE) {
    state.mode = CV_ACQUISITION_MODE_IMAGE;
    state.image_fallbacks = (Number(state.image_fallbacks) || 0) + 1;
  } else {
    state.misses = (Number(state.misses) || 0) + 1;
  }
  state.last_result = recorded;
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push(recorded);
  return compactCvAcquisitionState(state);
}

function compactNetworkWait(waitResult = {}) {
  return {
    ok: Boolean(waitResult?.ok),
    elapsed_ms: waitResult?.elapsed_ms || 0,
    count: waitResult?.count || 0,
    total_event_count: waitResult?.total_event_count ?? waitResult?.events?.length ?? 0
  };
}
