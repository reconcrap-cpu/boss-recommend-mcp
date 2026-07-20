#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_IMAGE_PAGES,
  NETWORK_RESUME_IMAGE_MODE_GRACE_MS,
  NETWORK_RESUME_RETRY_WAIT_MS,
  NETWORK_RESUME_WAIT_MS,
  compactCvAcquisitionState,
  confirmedImageCaptureResumeCheckpoint,
  attemptImageCaptureCheckpointResume,
  countParsedNetworkProfiles,
  createCvAcquisitionState,
  createImageCaptureWorkflowRetryTracker,
  createRequiredImageEvidenceFailure,
  getCvNetworkWaitPlan,
  hasImageCaptureWorkflowRetryBudget,
  hasParsedNetworkProfile,
  imageCaptureResumeCheckpoint,
  isFailedClosedImageAcquisition,
  isIncompleteImageEvidence,
  isRecoverableImageCaptureWorkflowError,
  recordCvImageFallback,
  recordCvNetworkHit,
  recordCvNetworkMiss,
  reacquireImageCaptureResumeTarget,
  requireCompleteImageEvidence,
  summarizeImageEvidence,
  waitForCvNetworkEvents
} from "./core/cv-acquisition/index.js";

function testDefaultImagePageCap() {
  assert.equal(DEFAULT_MAX_IMAGE_PAGES, 24);
}

function testWaitPlans() {
  const state = createCvAcquisitionState();
  const initial = getCvNetworkWaitPlan(state);
  assert.equal(initial.reason, "network_primary_full_wait");
  assert.equal(initial.initial_wait_ms, NETWORK_RESUME_WAIT_MS);
  assert.equal(initial.retry_wait_ms, NETWORK_RESUME_RETRY_WAIT_MS);

  recordCvImageFallback(state, {
    parsedNetworkProfileCount: 0,
    imageEvidence: {
      source: "image-scroll-sequence",
      screenshot_count: 6,
      unique_screenshot_count: 4
    }
  });
  const imageMode = getCvNetworkWaitPlan(state);
  assert.equal(imageMode.reason, "previous_image_mode_short_network_grace");
  assert.equal(imageMode.initial_wait_ms, NETWORK_RESUME_IMAGE_MODE_GRACE_MS);
  assert.equal(imageMode.retry_wait_ms, 0);
}

function testStateTransitions() {
  const state = createCvAcquisitionState({ mode: "invalid" });
  assert.equal(state.mode, "unknown");

  const miss = recordCvNetworkMiss(state, { parsedNetworkProfileCount: 0 });
  assert.equal(miss.mode, "unknown");
  assert.equal(miss.misses, 1);

  const network = recordCvNetworkHit(state, { parsedNetworkProfileCount: 1 });
  assert.equal(network.mode, "network");
  assert.equal(network.network_hits, 1);

  const image = recordCvImageFallback(state, {
    parsedNetworkProfileCount: 0,
    imageEvidence: {
      source: "image-scroll-sequence",
      screenshot_count: 3,
      unique_screenshot_count: 2,
      file_paths: ["a.png"],
      screenshots: [{ clip: { x: 1, y: 2, width: 3, height: 4 } }]
    }
  });
  assert.equal(image.mode, "image");
  assert.equal(image.image_fallbacks, 1);
  assert.equal(state.history.length, 3);
  assert.equal(compactCvAcquisitionState(state).last_result.image_evidence.unique_screenshot_count, 2);
}

function testProfileCountingAndEvidenceSummary() {
  assert.equal(countParsedNetworkProfiles({
    parsed_network_profiles: [{ ok: true }, { ok: false }, { ok: true }]
  }), 2);
  assert.equal(hasParsedNetworkProfile({
    parsed_network_profiles: [{ ok: false }]
  }), false);
  assert.deepEqual(summarizeImageEvidence(null), null);
  assert.deepEqual(summarizeImageEvidence({
    source: "image-scroll-sequence",
    screenshot_count: 2,
    unique_screenshot_count: 2,
    file_paths: ["page-01.png"],
    llm_file_paths: ["page-llm-01.jpg"],
    llm_screenshot_count: 1,
    llm_total_byte_length: 123,
    llm_original_total_byte_length: 456,
    scroll_anchor_plan: { ok: true, anchor_count: 2 },
    stop_boundary_checks: [{ capture_index: 1, match_count: 1 }],
    stop_boundary_result: { action: "capture_then_stop" }
  }), {
    ok: true,
    source: "image-scroll-sequence",
    elapsed_ms: 0,
    capture_count: 2,
    screenshot_count: 2,
    unique_screenshot_count: 2,
    dropped_duplicate_count: 0,
    coverage_complete: null,
    coverage_terminal_reason: null,
    coverage_limit_reached: false,
    coverage_ledger_count: 0,
    resumed_from_checkpoint: false,
    resume_checkpoint_id: null,
    resume_confirmed_screenshot_count: 0,
    resume_confirmed_ledger_count: 0,
    coverage_checkpoint_id: null,
    total_byte_length: 0,
    original_total_byte_length: 0,
    llm_screenshot_count: 1,
    llm_total_byte_length: 123,
    llm_original_total_byte_length: 456,
    llm_composition_error: null,
    optimization: null,
    browser_clip_used: false,
    capture_beyond_viewport: false,
    scroll_anchor_plan: { ok: true, anchor_count: 2 },
    stop_boundary_plan: null,
    stop_boundary_checks: [{ capture_index: 1, match_count: 1 }],
    stop_boundary_result: { action: "capture_then_stop" },
    error_code: null,
    error: null,
    file_paths: ["page-01.png"],
    llm_file_paths: ["page-llm-01.jpg"],
    first_clip: null
  });

  const incomplete = {
    ok: true,
    coverage_complete: false,
    error_code: "IMAGE_CAPTURE_COVERAGE_INCOMPLETE",
    file_paths: ["partial-page.jpg"],
    llm_file_paths: ["partial-page.jpg"]
  };
  assert.equal(isIncompleteImageEvidence(incomplete), true);
  assert.equal(summarizeImageEvidence(incomplete).ok, false);
  assert.equal(summarizeImageEvidence({ ok: true, coverage_complete: true }).ok, true);
  assert.equal(isIncompleteImageEvidence(null), false);
}

function testRecoverableImageCaptureWorkflowErrors() {
  for (const code of [
    "IMAGE_CAPTURE_TIMEOUT",
    "IMAGE_CAPTURE_TOTAL_TIMEOUT",
    "IMAGE_CAPTURE_VIEWPORT_DRIFT",
    "IMAGE_CAPTURE_VIEWPORT_UNREADABLE",
    "IMAGE_CAPTURE_TARGET_OUT_OF_VIEW"
  ]) {
    assert.equal(isRecoverableImageCaptureWorkflowError({ code }), true, code);
  }
  assert.equal(isRecoverableImageCaptureWorkflowError({
    cdp_method: "Page.captureScreenshot",
    cdp_outcome_unknown: true,
    cdp_replay_suppressed: true
  }), true);
  assert.equal(isRecoverableImageCaptureWorkflowError({
    cdp_method: "DOM.getBoxModel",
    cdp_outcome_unknown: true,
    cdp_replay_suppressed: true
  }), true);
  assert.equal(isRecoverableImageCaptureWorkflowError({
    cdp_method: "Input.dispatchMouseEvent",
    cdp_outcome_unknown: true,
    cdp_replay_suppressed: true
  }), true);
  assert.equal(isRecoverableImageCaptureWorkflowError({
    cdp_method: "DOM.querySelector",
    cdp_outcome_unknown: true,
    cdp_replay_suppressed: true
  }), true);
  assert.equal(isRecoverableImageCaptureWorkflowError({
    cdp_method: "DOM.getBoxModel",
    cdp_outcome_unknown: true,
    cdp_replay_suppressed: false
  }), false);
  assert.equal(isRecoverableImageCaptureWorkflowError(
    new Error("Could not find node with given id")
  ), true);
  assert.equal(isRecoverableImageCaptureWorkflowError(
    new Error("Node is detached from document")
  ), true);
  assert.equal(isRecoverableImageCaptureWorkflowError(new Error("Connection closed")), false);
  assert.equal(hasImageCaptureWorkflowRetryBudget(0), true);
  assert.equal(hasImageCaptureWorkflowRetryBudget(1), false);
  assert.equal(hasImageCaptureWorkflowRetryBudget(2), false);
}

function testFailClosedRequiredImageEvidence() {
  const missingTarget = createRequiredImageEvidenceFailure({
    code: "IMAGE_CAPTURE_TARGET_UNAVAILABLE",
    message: "target unavailable",
    metadata: { domain: "recommend" }
  });
  assert.equal(missingTarget.ok, false);
  assert.equal(missingTarget.coverage_complete, false);
  assert.equal(missingTarget.error_code, "IMAGE_CAPTURE_TARGET_UNAVAILABLE");
  assert.deepEqual(missingTarget.llm_file_paths, []);
  assert.equal(isIncompleteImageEvidence(missingTarget), true);

  const missingResult = requireCompleteImageEvidence(null, {
    code: "IMAGE_CAPTURE_EVIDENCE_MISSING"
  });
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.error_code, "IMAGE_CAPTURE_EVIDENCE_MISSING");

  const malformedSuccess = requireCompleteImageEvidence({
    ok: true,
    coverage_complete: true,
    file_paths: [],
    llm_file_paths: []
  });
  assert.equal(malformedSuccess.ok, false);

  const incomplete = requireCompleteImageEvidence({
    ok: true,
    coverage_complete: false,
    file_paths: ["partial.jpg"],
    llm_file_paths: ["partial.jpg"]
  });
  assert.equal(incomplete.ok, false);
  assert.deepEqual(incomplete.llm_file_paths, []);

  const complete = {
    ok: true,
    coverage_complete: true,
    file_paths: ["complete.jpg"],
    llm_file_paths: ["complete.jpg"]
  };
  assert.equal(requireCompleteImageEvidence(complete), complete);
  assert.equal(isFailedClosedImageAcquisition({
    source: "missing_capture_node",
    imageEvidence: null
  }), true);
  assert.equal(isFailedClosedImageAcquisition({
    source: "image",
    imageEvidence: null
  }), true);
  assert.equal(isFailedClosedImageAcquisition({
    source: "network",
    imageEvidence: null
  }), false);
}

function testDedicatedImageCaptureRetryCounterIndependence() {
  const detailRecoveryCounts = new Map([["candidate-1", 1]]);
  const tracker = createImageCaptureWorkflowRetryTracker();
  assert.equal(tracker.count("candidate-1"), 0);
  assert.equal(tracker.hasBudget("candidate-1"), true);

  const first = tracker.consume("candidate-1");
  assert.equal(first.allowed, true);
  assert.equal(first.count, 1);
  assert.equal(detailRecoveryCounts.get("candidate-1"), 1);
  assert.equal(tracker.hasBudget("candidate-1"), false);

  const second = tracker.consume("candidate-1");
  assert.equal(second.allowed, false);
  assert.equal(second.count, 1);
  assert.equal(detailRecoveryCounts.get("candidate-1"), 1);

  assert.equal(tracker.consume("candidate-2").allowed, true);
  detailRecoveryCounts.set("candidate-2", 1);
  assert.equal(tracker.count("candidate-2"), 1);
}

async function testConfirmedCheckpointAndLightweightReacquire() {
  const checkpoint = {
    kind: "cv_capture_coverage_checkpoint",
    schema_version: 1,
    confirmed_capture_count: 2,
    unique_screenshot_count: 2,
    screenshots: [
      { file_path: "page-01.jpg", sha256: "hash-1" },
      { file_path: "page-02.jpg", sha256: "hash-2" }
    ]
  };
  const wrapped = new Error("wrapped");
  wrapped.cause = Object.assign(new Error("capture failed"), {
    capture_checkpoint: checkpoint
  });
  assert.equal(confirmedImageCaptureResumeCheckpoint(wrapped), checkpoint);
  assert.equal(confirmedImageCaptureResumeCheckpoint({
    capture_checkpoint: { ...checkpoint, confirmed_capture_count: 0 }
  }), null);
  const startCheckpoint = {
    kind: "cv_capture_coverage_checkpoint",
    schema_version: 1,
    confirmed_capture_count: 0,
    unique_screenshot_count: 0,
    screenshots: [],
    coverage_ledger: [],
    current_pending_scroll_metadata: { before_capture: "initial" }
  };
  assert.equal(imageCaptureResumeCheckpoint({ capture_checkpoint: startCheckpoint }), startCheckpoint);

  const calls = [];
  const result = await reacquireImageCaptureResumeTarget({
    domain: "test",
    getRoots: async () => {
      calls.push("roots");
      return { generation: 1 };
    },
    ensureViewport: async (roots) => {
      calls.push("viewport");
      return { ...roots, healthy: true };
    },
    getDetailState: async (roots) => {
      calls.push(`detail:${roots.healthy}`);
      return { popup: { node_id: 21 } };
    },
    isDetailAvailable: (state) => Boolean(state?.popup),
    waitForTarget: async (_detail, roots) => {
      calls.push(`target:${roots.healthy}`);
      return { target: { node_id: 31, iframe_node_id: 41 } };
    }
  });
  assert.deepEqual(calls, ["roots", "viewport", "detail:true", "target:true"]);
  assert.equal(result.root_state.healthy, true);
  assert.equal(result.target.node_id, 31);

  await assert.rejects(() => reacquireImageCaptureResumeTarget({
    domain: "test",
    getRoots: async () => ({}),
    ensureViewport: async (roots) => roots,
    getDetailState: async () => null,
    isDetailAvailable: () => false,
    waitForTarget: async () => ({ target: { node_id: 1 } })
  }), (error) => error?.code === "IMAGE_CAPTURE_RESUME_DETAIL_UNAVAILABLE");

  let captureCalls = 0;
  const reacquireFailure = await attemptImageCaptureCheckpointResume({
    checkpoint: startCheckpoint,
    reacquire: async () => {
      throw new Error("detail disappeared");
    },
    capture: async () => {
      captureCalls += 1;
      return { ok: true };
    }
  });
  assert.equal(reacquireFailure.outcome, "reacquire_failed");
  assert.equal(reacquireFailure.restart_required, false);
  assert.equal(captureCalls, 0);

  const resumedCaptureFailure = await attemptImageCaptureCheckpointResume({
    checkpoint,
    reacquire: async () => ({ target: { node_id: 99 } }),
    capture: async (_context, passedCheckpoint) => {
      captureCalls += 1;
      assert.equal(passedCheckpoint, checkpoint);
      throw new Error("resumed capture failed");
    }
  });
  assert.equal(resumedCaptureFailure.outcome, "capture_failed");
  assert.equal(resumedCaptureFailure.restart_required, false);
  assert.equal(captureCalls, 1);
}

async function testNetworkWaitRetries() {
  const calls = [];
  const result = await waitForCvNetworkEvents(async (_recorder, options) => {
    calls.push(options.timeoutMs);
    return calls.length === 1
      ? { ok: false, elapsed_ms: 10, count: 0, total_event_count: 0 }
      : { ok: true, elapsed_ms: 20, count: 1, total_event_count: 1 };
  }, { events: [] }, {
    waitPlan: {
      initial_wait_ms: 11,
      retry_wait_ms: 22
    },
    intervalMs: 1
  });

  assert.deepEqual(calls, [11, 22]);
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.stages.length, 2);
}

async function testImageModeSkipsRetry() {
  const state = createCvAcquisitionState({ mode: "image" });
  const plan = getCvNetworkWaitPlan(state);
  const calls = [];
  const result = await waitForCvNetworkEvents(async (_recorder, options) => {
    calls.push(options.timeoutMs);
    return { ok: false, elapsed_ms: 5, count: 0, total_event_count: 0 };
  }, { events: [] }, {
    waitPlan: plan,
    intervalMs: 1
  });

  assert.deepEqual(calls, [NETWORK_RESUME_IMAGE_MODE_GRACE_MS]);
  assert.equal(result.ok, false);
  assert.equal(result.stages.length, 1);
}

testDefaultImagePageCap();
testWaitPlans();
testStateTransitions();
testProfileCountingAndEvidenceSummary();
testRecoverableImageCaptureWorkflowErrors();
testFailClosedRequiredImageEvidence();
testDedicatedImageCaptureRetryCounterIndependence();
await testConfirmedCheckpointAndLightweightReacquire();
await testNetworkWaitRetries();
await testImageModeSkipsRetry();

console.log("core cv acquisition tests passed");
