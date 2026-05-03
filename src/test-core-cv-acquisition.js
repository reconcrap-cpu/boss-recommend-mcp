#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  NETWORK_RESUME_IMAGE_MODE_GRACE_MS,
  NETWORK_RESUME_RETRY_WAIT_MS,
  NETWORK_RESUME_WAIT_MS,
  compactCvAcquisitionState,
  countParsedNetworkProfiles,
  createCvAcquisitionState,
  getCvNetworkWaitPlan,
  hasParsedNetworkProfile,
  recordCvImageFallback,
  recordCvNetworkHit,
  recordCvNetworkMiss,
  summarizeImageEvidence,
  waitForCvNetworkEvents
} from "./core/cv-acquisition/index.js";

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
    file_paths: ["page-01.png"]
  }), {
    source: "image-scroll-sequence",
    elapsed_ms: 0,
    capture_count: 2,
    screenshot_count: 2,
    unique_screenshot_count: 2,
    dropped_duplicate_count: 0,
    total_byte_length: 0,
    original_total_byte_length: 0,
    optimization: null,
    file_paths: ["page-01.png"],
    first_clip: null
  });
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

testWaitPlans();
testStateTransitions();
testProfileCountingAndEvidenceSummary();
await testNetworkWaitRetries();
await testImageModeSkipsRetry();

console.log("core cv acquisition tests passed");
