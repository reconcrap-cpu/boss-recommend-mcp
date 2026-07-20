import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function normalizedPath(filePath) {
  return path.resolve(String(filePath || ""));
}

function strictlyIncreasing(values = []) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function fileHash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function addIssue(issues, code, details = {}) {
  issues.push({ code, ...details });
}

export function verifyCaptureEvidenceSafety(evidence = null, {
  minOverlapRatio = 0.2,
  verifyArtifacts = true
} = {}) {
  const issues = [];
  const ledger = Array.isArray(evidence?.coverage_ledger) ? evidence.coverage_ledger : [];
  const screenshots = Array.isArray(evidence?.screenshots) ? evidence.screenshots : [];
  const declaredPaths = Array.isArray(evidence?.file_paths)
    ? evidence.file_paths.map(normalizedPath)
    : [];
  const persistedScreenshots = screenshots.filter((entry) => entry?.file_path);
  const screenshotPaths = persistedScreenshots.map((entry) => normalizedPath(entry.file_path));
  const ledgerIndexes = ledger.map((entry) => Number(entry?.capture_index));
  const screenshotIndexes = screenshots.map((entry) => Number(entry?.capture_index));

  if (!ledger.length) addIssue(issues, "coverage_ledger_missing");
  if (!screenshots.length) addIssue(issues, "screenshots_missing");
  if (ledgerIndexes.some((value) => !Number.isInteger(value)) || !strictlyIncreasing(ledgerIndexes)) {
    addIssue(issues, "coverage_ledger_out_of_order", { capture_indexes: ledgerIndexes });
  }
  if (screenshotIndexes.some((value) => !Number.isInteger(value)) || !strictlyIncreasing(screenshotIndexes)) {
    addIssue(issues, "screenshots_out_of_order", { capture_indexes: screenshotIndexes });
  }
  if (
    declaredPaths.length !== screenshotPaths.length
    || declaredPaths.some((filePath, index) => filePath !== screenshotPaths[index])
  ) {
    addIssue(issues, "persisted_file_order_mismatch", {
      declared_paths: declaredPaths,
      screenshot_paths: screenshotPaths
    });
  }

  const ledgerByCaptureIndex = new Map(
    ledger.map((entry) => [Number(entry?.capture_index), entry])
  );
  let fullViewportArtifactCount = 0;
  let verifiedArtifactCount = 0;
  for (const screenshot of screenshots) {
    const captureIndex = Number(screenshot?.capture_index);
    const ledgerEntry = ledgerByCaptureIndex.get(captureIndex) || null;
    if (!ledgerEntry) {
      addIssue(issues, "screenshot_missing_ledger_entry", { capture_index: captureIndex });
      continue;
    }
    if (screenshot.browser_clip_used !== false || ledgerEntry.browser_clip_used === true) {
      addIssue(issues, "browser_clip_used", { capture_index: captureIndex });
    }
    if (screenshot.capture_beyond_viewport !== false || ledgerEntry.capture_beyond_viewport === true) {
      addIssue(issues, "capture_beyond_viewport_used", { capture_index: captureIndex });
    }
    if (screenshot.capture_viewport !== false) {
      addIssue(issues, "uncropped_capture_mode_used", { capture_index: captureIndex });
    }
    if (
      ledgerEntry.viewport_comparison?.ok !== true
      || ledgerEntry.viewport_comparison?.browser_window_changed === true
    ) {
      addIssue(issues, "viewport_changed_during_capture", {
        capture_index: captureIndex,
        viewport_comparison: ledgerEntry.viewport_comparison || null
      });
    }

    const pixelCrop = ledgerEntry.crop_geometry?.pixel_crop || screenshot.crop?.pixel_crop || null;
    const imageDimensions = ledgerEntry.image_dimensions || null;
    const viewportWidth = Number(imageDimensions?.viewport_width);
    const viewportHeight = Number(imageDimensions?.viewport_height);
    const cropReadable = pixelCrop
      && Number.isFinite(Number(pixelCrop.left))
      && Number.isFinite(Number(pixelCrop.top))
      && Number(pixelCrop.width) > 0
      && Number(pixelCrop.height) > 0
      && viewportWidth > 0
      && viewportHeight > 0;
    if (!cropReadable) {
      addIssue(issues, "crop_geometry_unreadable", { capture_index: captureIndex });
    } else {
      const coversFullViewport = Number(pixelCrop.left) <= 0
        && Number(pixelCrop.top) <= 0
        && Number(pixelCrop.width) >= viewportWidth
        && Number(pixelCrop.height) >= viewportHeight;
      if (coversFullViewport) {
        fullViewportArtifactCount += screenshot.file_path ? 1 : 0;
        addIssue(issues, "uncropped_viewport_artifact", { capture_index: captureIndex });
      }
    }

    if (!screenshot.file_path || !verifyArtifacts) continue;
    const filePath = normalizedPath(screenshot.file_path);
    if (!fs.existsSync(filePath)) {
      addIssue(issues, "persisted_artifact_missing", { capture_index: captureIndex, file_path: filePath });
      continue;
    }
    const actualHash = fileHash(filePath);
    const expectedHashes = [screenshot.sha256, ledgerEntry.sha256].filter(Boolean);
    if (!expectedHashes.length || expectedHashes.some((expected) => expected !== actualHash)) {
      addIssue(issues, "persisted_artifact_hash_mismatch", {
        capture_index: captureIndex,
        file_path: filePath,
        actual_sha256: actualHash,
        expected_sha256: expectedHashes
      });
      continue;
    }
    verifiedArtifactCount += 1;
  }

  const acceptedCoverageEntries = ledger.filter((entry) => (
    entry?.accepted_for_coverage === true && entry?.new_unique_screenshot !== false
  ));
  const overlapRatios = [];
  for (let index = 1; index < acceptedCoverageEntries.length; index += 1) {
    const entry = acceptedCoverageEntries[index];
    const ratio = Number(entry?.overlap_with_previous?.estimated_overlap_ratio);
    if (!Number.isFinite(ratio)) {
      addIssue(issues, "coverage_overlap_unreadable", { capture_index: entry?.capture_index ?? null });
      continue;
    }
    overlapRatios.push(ratio);
    if (ratio + Number.EPSILON < minOverlapRatio) {
      addIssue(issues, "coverage_overlap_below_minimum", {
        capture_index: entry?.capture_index ?? null,
        observed_ratio: ratio,
        required_ratio: minOverlapRatio
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    ordering_ok: !issues.some((issue) => issue.code.includes("out_of_order") || issue.code === "persisted_file_order_mismatch"),
    overlap_ok: !issues.some((issue) => issue.code.startsWith("coverage_overlap_")),
    min_required_overlap_ratio: minOverlapRatio,
    min_observed_overlap_ratio: overlapRatios.length ? Math.min(...overlapRatios) : null,
    persisted_artifact_count: persistedScreenshots.length,
    verified_artifact_count: verifiedArtifactCount,
    uncropped_viewport_images_persisted: fullViewportArtifactCount > 0,
    full_viewport_artifact_count: fullViewportArtifactCount
  };
}

export function verifyScreenshotMethodSafety(methodLog = []) {
  const screenshotMethods = methodLog.filter((entry) => (
    String(entry?.method || "").replace(/:retry_after_reconnect$/, "") === "Page.captureScreenshot"
  ));
  const replayCount = methodLog.filter((entry) => (
    entry?.method === "Page.captureScreenshot:retry_after_reconnect"
  )).length;
  return {
    ok: replayCount === 0,
    screenshot_method_count: screenshotMethods.length,
    screenshot_retry_count: replayCount,
    issues: replayCount > 0 ? [{ code: "screenshot_replayed_after_reconnect", count: replayCount }] : []
  };
}
