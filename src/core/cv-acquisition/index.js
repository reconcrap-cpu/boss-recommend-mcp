export const CV_ACQUISITION_MODE_UNKNOWN = "unknown";
export const CV_ACQUISITION_MODE_NETWORK = "network";
export const CV_ACQUISITION_MODE_IMAGE = "image";

export const NETWORK_RESUME_WAIT_MS = 4200;
export const NETWORK_RESUME_RETRY_WAIT_MS = 2000;
export const NETWORK_RESUME_IMAGE_MODE_GRACE_MS = 1000;
export const DEFAULT_MAX_IMAGE_PAGES = 24;
export const IMAGE_CAPTURE_WORKFLOW_RETRY_LIMIT = 1;

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

const RECOVERABLE_IMAGE_CAPTURE_CODES = new Set([
  "IMAGE_CAPTURE_TIMEOUT",
  "IMAGE_CAPTURE_TOTAL_TIMEOUT",
  "IMAGE_CAPTURE_VIEWPORT_DRIFT",
  "IMAGE_CAPTURE_VIEWPORT_UNREADABLE",
  "IMAGE_CAPTURE_TARGET_OUT_OF_VIEW"
]);

export function isIncompleteImageEvidence(imageEvidence = null) {
  return Boolean(
    imageEvidence
    && (imageEvidence.ok === false || imageEvidence.coverage_complete === false)
  );
}

export function createRequiredImageEvidenceFailure({
  code = "IMAGE_CAPTURE_EVIDENCE_MISSING",
  message = "Required CV image evidence is unavailable",
  source = "image-scroll-sequence",
  metadata = null
} = {}) {
  return {
    schema_version: 1,
    ok: false,
    source,
    capture_count: 0,
    screenshot_count: 0,
    unique_screenshot_count: 0,
    coverage_complete: false,
    coverage_terminal_reason: "required_image_evidence_unavailable",
    error_code: String(code || "IMAGE_CAPTURE_EVIDENCE_MISSING"),
    error: String(message || "Required CV image evidence is unavailable"),
    file_paths: [],
    llm_file_paths: [],
    metadata: metadata && typeof metadata === "object" ? metadata : null
  };
}

export function requireCompleteImageEvidence(imageEvidence = null, failureOptions = {}) {
  const filePaths = Array.isArray(imageEvidence?.file_paths)
    ? imageEvidence.file_paths.filter(Boolean)
    : [];
  const llmFilePaths = Array.isArray(imageEvidence?.llm_file_paths)
    ? imageEvidence.llm_file_paths.filter(Boolean)
    : [];
  const hasPersistedEvidence = filePaths.length > 0 || llmFilePaths.length > 0;
  if (
    imageEvidence
    && imageEvidence.ok !== false
    && imageEvidence.coverage_complete === true
    && hasPersistedEvidence
  ) {
    return imageEvidence;
  }
  if (isIncompleteImageEvidence(imageEvidence)) {
    return {
      ...imageEvidence,
      ok: false,
      coverage_complete: false,
      llm_file_paths: []
    };
  }
  return createRequiredImageEvidenceFailure(failureOptions);
}

export function isFailedClosedImageAcquisition({
  source = "",
  imageEvidence = null
} = {}) {
  const normalizedSource = String(source || "").trim().toLowerCase();
  if (isIncompleteImageEvidence(imageEvidence)) return true;
  if (normalizedSource === "missing_capture_node" || normalizedSource === "image_capture_failed") {
    return true;
  }
  if (normalizedSource === "image") {
    return requireCompleteImageEvidence(imageEvidence).ok === false;
  }
  return false;
}

export function isRecoverableImageCaptureWorkflowError(error) {
  if (!error) return false;
  if (RECOVERABLE_IMAGE_CAPTURE_CODES.has(String(error.code || ""))) return true;
  if (/Could not find node with given id|No node with given id|Node is detached|Cannot find node|Could not compute box model/i
    .test(String(error?.message || error || ""))) return true;
  return Boolean(
    error.cdp_outcome_unknown === true
    && error.cdp_replay_suppressed !== false
    && String(error.cdp_method || "").includes(".")
  );
}

export function hasImageCaptureWorkflowRetryBudget(recoveryCount = 0) {
  const normalizedCount = Math.max(0, Math.floor(Number(recoveryCount) || 0));
  return normalizedCount < IMAGE_CAPTURE_WORKFLOW_RETRY_LIMIT;
}

export function createImageCaptureWorkflowRetryTracker({
  retryLimit = IMAGE_CAPTURE_WORKFLOW_RETRY_LIMIT
} = {}) {
  const normalizedLimit = Math.max(0, Math.floor(Number(retryLimit) || 0));
  const counts = new Map();
  const keyFor = (candidateKey) => String(candidateKey || "").trim() || "__unknown_candidate__";
  return {
    count(candidateKey) {
      return counts.get(keyFor(candidateKey)) || 0;
    },
    hasBudget(candidateKey) {
      return this.count(candidateKey) < normalizedLimit;
    },
    consume(candidateKey) {
      const key = keyFor(candidateKey);
      const previousCount = counts.get(key) || 0;
      if (previousCount >= normalizedLimit) {
        return {
          allowed: false,
          previous_count: previousCount,
          count: previousCount,
          retry_limit: normalizedLimit
        };
      }
      const count = previousCount + 1;
      counts.set(key, count);
      return {
        allowed: true,
        previous_count: previousCount,
        count,
        retry_limit: normalizedLimit
      };
    },
    release(candidateKey) {
      return counts.delete(keyFor(candidateKey));
    },
    size() {
      return counts.size;
    }
  };
}

export function imageCaptureResumeCheckpoint(error = null, {
  requireConfirmedPage = false
} = {}) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((typeof current === "object" || typeof current === "function") && seen.has(current)) break;
    if (typeof current === "object" || typeof current === "function") seen.add(current);
    const checkpoint = current?.capture_checkpoint;
    const screenshots = Array.isArray(checkpoint?.screenshots) ? checkpoint.screenshots : [];
    const confirmedCount = Math.max(0, Number(checkpoint?.confirmed_capture_count) || 0);
    const uniqueCount = Math.max(0, Number(checkpoint?.unique_screenshot_count) || 0);
    const hasPersistedPage = screenshots.some((item) => (
      String(item?.file_path || "").trim()
      && String(item?.sha256 || "").trim()
    ));
    if (
      checkpoint?.kind === "cv_capture_coverage_checkpoint"
      && Number(checkpoint.schema_version) === 1
      && (
        (confirmedCount > 0 && uniqueCount > 0 && hasPersistedPage)
        || (!requireConfirmedPage && confirmedCount === 0 && uniqueCount === 0 && screenshots.length === 0)
      )
    ) {
      return checkpoint;
    }
    current = current?.cause || null;
  }
  return null;
}

export function confirmedImageCaptureResumeCheckpoint(error = null) {
  return imageCaptureResumeCheckpoint(error, { requireConfirmedPage: true });
}

export async function reacquireImageCaptureResumeTarget({
  domain = "candidate",
  getRoots,
  ensureViewport,
  getDetailState,
  isDetailAvailable = (state) => Boolean(state),
  waitForTarget
} = {}) {
  for (const [name, task] of Object.entries({
    getRoots,
    ensureViewport,
    getDetailState,
    waitForTarget
  })) {
    if (typeof task !== "function") {
      throw new TypeError(`reacquireImageCaptureResumeTarget requires ${name}`);
    }
  }
  const rootState = await ensureViewport(await getRoots());
  const detailState = await getDetailState(rootState);
  if (!isDetailAvailable(detailState)) {
    const error = new Error(`${domain} detail is unavailable during image capture resume`);
    error.code = "IMAGE_CAPTURE_RESUME_DETAIL_UNAVAILABLE";
    throw error;
  }
  const targetWait = await waitForTarget(detailState, rootState);
  const target = targetWait?.target || null;
  if (!target?.node_id) {
    const error = new Error(`${domain} CV target is unavailable during image capture resume`);
    error.code = "IMAGE_CAPTURE_RESUME_TARGET_UNAVAILABLE";
    error.target_wait = targetWait || null;
    throw error;
  }
  return {
    root_state: rootState,
    detail_state: detailState,
    target_wait: targetWait,
    target
  };
}

export async function attemptImageCaptureCheckpointResume({
  checkpoint,
  reacquire,
  capture
} = {}) {
  if (!checkpoint || typeof checkpoint !== "object") {
    throw new TypeError("attemptImageCaptureCheckpointResume requires checkpoint");
  }
  if (typeof reacquire !== "function" || typeof capture !== "function") {
    throw new TypeError("attemptImageCaptureCheckpointResume requires reacquire and capture");
  }
  let context = null;
  try {
    context = await reacquire(checkpoint);
  } catch (error) {
    return {
      attempted: true,
      outcome: "reacquire_failed",
      restart_required: false,
      checkpoint,
      context: null,
      evidence: null,
      error
    };
  }
  try {
    const evidence = await capture(context, checkpoint);
    return {
      attempted: true,
      outcome: "completed",
      restart_required: false,
      checkpoint,
      context,
      evidence,
      error: null
    };
  } catch (error) {
    return {
      attempted: true,
      outcome: "capture_failed",
      restart_required: false,
      checkpoint,
      context,
      evidence: null,
      error
    };
  }
}

export function summarizeImageEvidence(imageEvidence = null) {
  if (!imageEvidence) return null;
  return {
    ok: !isIncompleteImageEvidence(imageEvidence),
    source: imageEvidence.source || "",
    elapsed_ms: imageEvidence.elapsed_ms || 0,
    capture_count: imageEvidence.capture_count || imageEvidence.screenshot_count || 0,
    screenshot_count: imageEvidence.screenshot_count || 0,
    unique_screenshot_count: imageEvidence.unique_screenshot_count || 0,
    dropped_duplicate_count: imageEvidence.dropped_duplicate_count || 0,
    coverage_complete: imageEvidence.coverage_complete == null
      ? null
      : imageEvidence.coverage_complete === true,
    coverage_terminal_reason: imageEvidence.coverage_terminal_reason || null,
    coverage_limit_reached: Boolean(imageEvidence.coverage_limit_reached),
    coverage_ledger_count: Array.isArray(imageEvidence.coverage_ledger)
      ? imageEvidence.coverage_ledger.length
      : 0,
    resumed_from_checkpoint: Boolean(imageEvidence.resumed_from_checkpoint),
    resume_checkpoint_id: imageEvidence.resume_checkpoint_id || null,
    resume_confirmed_screenshot_count: imageEvidence.resume_confirmed_screenshot_count || 0,
    resume_confirmed_ledger_count: imageEvidence.resume_confirmed_ledger_count || 0,
    coverage_checkpoint_id: imageEvidence.coverage_checkpoint?.checkpoint_id || null,
    total_byte_length: imageEvidence.total_byte_length || 0,
    original_total_byte_length: imageEvidence.original_total_byte_length || 0,
    llm_screenshot_count: imageEvidence.llm_screenshot_count || 0,
    llm_total_byte_length: imageEvidence.llm_total_byte_length || 0,
    llm_original_total_byte_length: imageEvidence.llm_original_total_byte_length || 0,
    llm_composition_error: imageEvidence.llm_composition_error || null,
    optimization: imageEvidence.optimization || null,
    browser_clip_used: Boolean(imageEvidence.optimization?.browser_clip_used),
    capture_beyond_viewport: Boolean(imageEvidence.optimization?.capture_beyond_viewport),
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
