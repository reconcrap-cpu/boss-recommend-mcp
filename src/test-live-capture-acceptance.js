import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  verifyCaptureEvidenceSafety,
  verifyScreenshotMethodSafety
} from "../scripts/live-helpers/capture-safety-proof.js";
import {
  buildPerformanceSummary,
  resolveAcceptanceStatus
} from "../scripts/live-recommend-viewport-collapse-acceptance.js";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createEvidence(dir, { overlap = 0.2, fullViewport = false } = {}) {
  const buffers = [Buffer.from("crop-one"), Buffer.from("crop-two")];
  const filePaths = buffers.map((buffer, index) => {
    const filePath = path.join(dir, `page-${index + 1}.jpg`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  });
  const screenshots = filePaths.map((filePath, index) => ({
    capture_index: index,
    file_path: filePath,
    sha256: sha256(buffers[index]),
    browser_clip_used: false,
    capture_beyond_viewport: false,
    capture_viewport: false
  }));
  const coverageLedger = screenshots.map((screenshot, index) => ({
    capture_index: index,
    accepted_for_coverage: true,
    new_unique_screenshot: true,
    sha256: screenshot.sha256,
    crop_geometry: {
      pixel_crop: fullViewport
        ? { left: 0, top: 0, width: 1200, height: 800 }
        : { left: 100, top: 50, width: 800, height: 700 }
    },
    image_dimensions: { viewport_width: 1200, viewport_height: 800 },
    viewport_comparison: { ok: true, browser_window_changed: false },
    overlap_with_previous: index === 0 ? null : { estimated_overlap_ratio: overlap }
  }));
  return {
    screenshots,
    coverage_ledger: coverageLedger,
    file_paths: filePaths,
    optimization: { browser_clip_used: false, capture_beyond_viewport: false }
  };
}

function testDerivedCropArtifactProof() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-live-capture-proof-"));
  try {
    const evidence = createEvidence(dir);
    const proof = verifyCaptureEvidenceSafety(evidence);
    assert.equal(proof.ok, true);
    assert.equal(proof.ordering_ok, true);
    assert.equal(proof.overlap_ok, true);
    assert.equal(proof.min_observed_overlap_ratio, 0.2);
    assert.equal(proof.verified_artifact_count, 2);
    assert.equal(proof.uncropped_viewport_images_persisted, false);

    const lowOverlap = verifyCaptureEvidenceSafety(createEvidence(dir, { overlap: 0.19 }));
    assert.equal(lowOverlap.ok, false);
    assert.equal(lowOverlap.overlap_ok, false);
    assert.equal(lowOverlap.issues.some((issue) => issue.code === "coverage_overlap_below_minimum"), true);

    const uncropped = verifyCaptureEvidenceSafety(createEvidence(dir, { fullViewport: true }));
    assert.equal(uncropped.ok, false);
    assert.equal(uncropped.uncropped_viewport_images_persisted, true);

    const outOfOrderEvidence = createEvidence(dir);
    outOfOrderEvidence.screenshots.reverse();
    const outOfOrder = verifyCaptureEvidenceSafety(outOfOrderEvidence);
    assert.equal(outOfOrder.ok, false);
    assert.equal(outOfOrder.ordering_ok, false);

    const viewportDriftEvidence = createEvidence(dir);
    viewportDriftEvidence.coverage_ledger[0].viewport_comparison.ok = false;
    const viewportDrift = verifyCaptureEvidenceSafety(viewportDriftEvidence);
    assert.equal(viewportDrift.ok, false);
    assert.equal(
      viewportDrift.issues.some((issue) => issue.code === "viewport_changed_during_capture"),
      true
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testMultiDomainSmokeObservesFrameResizeEvents() {
  const source = fs.readFileSync(
    path.resolve("scripts", "live-cv-capture-target-smoke.js"),
    "utf8"
  );
  assert.match(source, /Page\.frameResized\s*\(/);
  assert.match(source, /screenshotCorrelatedFrameResizeEvents\.length\s*>\s*0/);
  assert.match(source, /screenshot_correlated_frame_resize_event_count/);
}

function testScreenshotReplayProof() {
  const clean = verifyScreenshotMethodSafety([{ method: "Page.captureScreenshot" }]);
  assert.equal(clean.ok, true);
  assert.equal(clean.screenshot_retry_count, 0);
  const replayed = verifyScreenshotMethodSafety([
    { method: "Page.captureScreenshot" },
    { method: "Page.captureScreenshot:retry_after_reconnect" }
  ]);
  assert.equal(replayed.ok, false);
  assert.equal(replayed.screenshot_retry_count, 1);
}

function testMissingPerformanceBaselineIsIncomplete() {
  const performance = buildPerformanceSummary([{ elapsed_ms: 100, capture: { screenshot_timings_ms: [20] } }]);
  assert.equal(performance.limits_evaluated, false);
  assert.equal(performance.passed, null);
  assert.equal(resolveAcceptanceStatus([], ["performance_baseline_missing"]), "INCOMPLETE");
  assert.equal(resolveAcceptanceStatus(["coverage_incomplete"], ["performance_baseline_missing"]), "FAIL");
  assert.equal(resolveAcceptanceStatus([], []), "PASS");

  const regression = buildPerformanceSummary(
    [{ elapsed_ms: 1000, capture: { screenshot_timings_ms: [300] } }],
    { candidates: [{ elapsed_ms: 900, capture: { screenshot_timings_ms: [100] } }] }
  );
  assert.equal(regression.limits_evaluated, true);
  assert.equal(regression.regression.screenshot_p90_ms, 200);
  assert.equal(regression.regression.screenshot_max_ms, 200);
  assert.equal(regression.passed, false);
}

testDerivedCropArtifactProof();
testScreenshotReplayProof();
testMissingPerformanceBaselineIsIncomplete();
testMultiDomainSmokeObservesFrameResizeEvents();
console.log("live capture acceptance tests passed");
