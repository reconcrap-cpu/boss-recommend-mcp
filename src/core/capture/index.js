import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import {
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../screening/index.js";

function nowIso() {
  return new Date().toISOString();
}

function resolveOutputPath(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function withPadding(rect, padding = 0) {
  const safePadding = Math.max(0, Number(padding) || 0);
  const x = Math.max(0, rect.x - safePadding);
  const y = Math.max(0, rect.y - safePadding);
  return {
    x,
    y,
    width: Math.max(1, rect.width + safePadding * 2 - (rect.x - x)),
    height: Math.max(1, rect.height + safePadding * 2 - (rect.y - y)),
    scale: 1
  };
}

const captureTransactions = new WeakMap();
const unsafeCaptureSessions = new WeakMap();

function captureConnectionEpoch(client) {
  const value = Number(client?.__connectionEpoch);
  return Number.isFinite(value) ? value : null;
}

function activeUnsafeCaptureSession(client) {
  return unsafeCaptureSessions.get(client) || null;
}

function clearUnsafeCaptureSessionAfterSettlement(client, unsafe) {
  if (!unsafe?.raw_capture_settled || !unsafe?.abandonment_settled) return false;
  if (unsafeCaptureSessions.get(client) !== unsafe) return false;
  unsafe.cleared_at = nowIso();
  unsafeCaptureSessions.delete(client);
  return true;
}

function createUnsafeCaptureSessionError(unsafe) {
  const error = new Error(
    "Screenshot capture is blocked because the prior timed-out request was not safely abandoned"
  );
  error.code = "IMAGE_CAPTURE_SESSION_UNSAFE";
  error.capture_outcome_unknown = true;
  error.screenshot_replay_suppressed = true;
  error.blocked_by_capture_operation_id = unsafe?.operation_id || null;
  error.blocked_connection_epoch = unsafe?.connection_epoch ?? null;
  error.blocked_since = unsafe?.blocked_since || null;
  error.blocked_reason = unsafe?.reason || "abandonment_unverified";
  return error;
}

function assertCaptureSessionSafe(client) {
  const unsafe = activeUnsafeCaptureSession(client);
  if (unsafe) throw createUnsafeCaptureSessionError(unsafe);
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRect(rect = {}) {
  return {
    x: finiteNumber(rect.x),
    y: finiteNumber(rect.y),
    width: Math.max(0, finiteNumber(rect.width)),
    height: Math.max(0, finiteNumber(rect.height))
  };
}

function rectFromQuad(quad = []) {
  if (!Array.isArray(quad) || quad.length < 8) return null;
  const values = quad.slice(0, 8).map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  const xs = [values[0], values[2], values[4], values[6]];
  const ys = [values[1], values[3], values[5], values[7]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y
  };
}

function expandRect(rect = {}, padding = 0) {
  const normalized = normalizeRect(rect);
  const safePadding = Math.max(0, finiteNumber(padding));
  return {
    x: normalized.x - safePadding,
    y: normalized.y - safePadding,
    width: normalized.width + safePadding * 2,
    height: normalized.height + safePadding * 2
  };
}

function intersectRects(left = {}, right = {}) {
  const a = normalizeRect(left);
  const b = normalizeRect(right);
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const rightEdge = Math.min(a.x + a.width, b.x + b.width);
  const bottomEdge = Math.min(a.y + a.height, b.y + b.height);
  return {
    x,
    y,
    width: Math.max(0, rightEdge - x),
    height: Math.max(0, bottomEdge - y)
  };
}

function rectArea(rect = {}) {
  const normalized = normalizeRect(rect);
  return normalized.width * normalized.height;
}

function viewportFromLayoutMetrics(metrics = {}) {
  const visual = metrics.cssVisualViewport || metrics.visualViewport || {};
  const layout = metrics.cssLayoutViewport || metrics.layoutViewport || {};
  const offsetX = finiteNumber(visual.offsetX);
  const offsetY = finiteNumber(visual.offsetY);
  const width = finiteNumber(visual.clientWidth, finiteNumber(layout.clientWidth));
  const height = finiteNumber(visual.clientHeight, finiteNumber(layout.clientHeight));
  const hasVisualPageX = visual.pageX != null && Number.isFinite(Number(visual.pageX));
  const hasVisualPageY = visual.pageY != null && Number.isFinite(Number(visual.pageY));
  return {
    // cssVisualViewport.pageX/pageY already include the visual offset.  Only
    // synthesize layout + offset when those fields are absent.
    x: hasVisualPageX
      ? Number(visual.pageX)
      : finiteNumber(layout.pageX) + offsetX,
    y: hasVisualPageY
      ? Number(visual.pageY)
      : finiteNumber(layout.pageY) + offsetY,
    offset_x: offsetX,
    offset_y: offsetY,
    width: Math.max(0, width),
    height: Math.max(0, height),
    page_scale: finiteNumber(visual.scale, 1),
    zoom: finiteNumber(visual.zoom, 1),
    source: metrics.cssVisualViewport
      ? "cssVisualViewport"
      : metrics.visualViewport
        ? "visualViewport"
        : metrics.cssLayoutViewport
          ? "cssLayoutViewport"
          : "layoutViewport"
  };
}

function viewportRelativeCandidates(rect, viewport, iframeOwnerRect = null) {
  const normalized = normalizeRect(rect);
  // DOM.getBoxModel quads are expressed in the node frame's viewport
  // coordinate space.  Top-level quads therefore need only the visual
  // viewport offset removed; pageX/pageY are retained as a low-priority
  // compatibility fallback for older/alternate CDP implementations.
  const viewportRelative = {
    ...normalized,
    x: normalized.x - viewport.offset_x,
    y: normalized.y - viewport.offset_y,
    coordinate_space: "viewport",
    coordinate_priority: 2
  };
  const pageRelative = {
    ...normalized,
    x: normalized.x - viewport.x,
    y: normalized.y - viewport.y,
    coordinate_space: "page",
    coordinate_priority: 1
  };
  const candidates = [viewportRelative, pageRelative];
  if (iframeOwnerRect) {
    const owner = normalizeRect(iframeOwnerRect);
    const ownerCandidates = viewportRelativeCandidates(owner, viewport);
    const viewportBounds = { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const resolvedOwner = ownerCandidates
      .map((candidate) => ({
        ...candidate,
        visible_area: rectArea(intersectRects(candidate, viewportBounds))
      }))
      .sort((left, right) => (
        right.visible_area - left.visible_area
        || right.coordinate_priority - left.coordinate_priority
      ))[0];
    candidates.push({
      ...normalized,
      x: resolvedOwner.x + normalized.x,
      y: resolvedOwner.y + normalized.y,
      coordinate_space: "iframe-local",
      coordinate_priority: 0,
      iframe_owner_viewport_rect: normalizeRect(resolvedOwner)
    });
  }
  return candidates;
}

function rectForCoordinateSpace(rect, viewport, coordinateSpace, iframeOwnerRect = null) {
  const candidates = viewportRelativeCandidates(rect, viewport, iframeOwnerRect);
  return normalizeRect(
    candidates.find((candidate) => candidate.coordinate_space === coordinateSpace)
    || candidates.find((candidate) => candidate.coordinate_space === "viewport")
    || candidates[0]
  );
}

function resolveVisibleTargetRect(rect, viewport, {
  padding = 0,
  iframeOwnerRect = null
} = {}) {
  const viewportBounds = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const ownerViewportRect = iframeOwnerRect
    ? normalizeRect(viewportRelativeCandidates(iframeOwnerRect, viewport)
        .map((candidate) => ({
          ...candidate,
          visible_area: rectArea(intersectRects(candidate, viewportBounds))
        }))
        .sort((left, right) => (
          right.visible_area - left.visible_area
          || right.coordinate_priority - left.coordinate_priority
        ))[0])
    : null;
  const visibleOwnerRect = ownerViewportRect
    ? intersectRects(ownerViewportRect, viewportBounds)
    : null;
  const candidates = viewportRelativeCandidates(rect, viewport, iframeOwnerRect)
    .map((candidate) => {
      const padded = expandRect(candidate, padding);
      const viewportIntersection = intersectRects(padded, viewportBounds);
      const intersection = visibleOwnerRect
        ? intersectRects(viewportIntersection, visibleOwnerRect)
        : viewportIntersection;
      const ownerIntersectionArea = visibleOwnerRect ? rectArea(intersection) : 0;
      return {
        ...candidate,
        padded,
        intersection,
        intersection_area: rectArea(intersection),
        owner_intersection_area: ownerIntersectionArea
      };
    })
    .sort((left, right) => (
      right.owner_intersection_area - left.owner_intersection_area
      || right.intersection_area - left.intersection_area
      || right.coordinate_priority - left.coordinate_priority
    ));
  // Modern Chrome reports nested-frame box quads already translated into the
  // main visual viewport.  Only use iframe-local translation when neither
  // direct coordinate interpretation intersects the iframe owner.
  const directOwnerCandidates = iframeOwnerRect
    ? candidates.filter((candidate) => (
        candidate.coordinate_space !== "iframe-local"
        && candidate.intersection.width >= 2
        && candidate.intersection.height >= 2
      ))
    : [];
  const selected = directOwnerCandidates[0] || candidates[0] || null;
  if (!selected || selected.intersection.width < 2 || selected.intersection.height < 2) {
    const error = new Error("CV capture target does not intersect the visible viewport");
    error.code = "IMAGE_CAPTURE_TARGET_OUT_OF_VIEW";
    error.target_rect = normalizeRect(rect);
    error.viewport = viewport;
    throw error;
  }
  return {
    coordinate_space: selected.coordinate_space,
    requested_rect: selected.padded,
    visible_rect: selected.intersection,
    visible_ratio: rectArea(selected.padded) > 0
      ? selected.intersection_area / rectArea(selected.padded)
      : 0,
    candidates: candidates.map((candidate) => ({
      coordinate_space: candidate.coordinate_space,
      intersection_area: candidate.intersection_area,
      owner_intersection_area: candidate.owner_intersection_area,
      coordinate_priority: candidate.coordinate_priority
    })),
    iframe_owner_visible_rect: visibleOwnerRect
  };
}

async function readCaptureViewportState(client) {
  if (!client?.Page || typeof client.Page.getLayoutMetrics !== "function") {
    const error = new Error("Page.getLayoutMetrics is required for clipless node capture");
    error.code = "IMAGE_CAPTURE_VIEWPORT_UNREADABLE";
    throw error;
  }
  const metrics = await client.Page.getLayoutMetrics();
  const viewport = viewportFromLayoutMetrics(metrics);
  if (viewport.width < 2 || viewport.height < 2) {
    const error = new Error("Visible viewport dimensions are unreadable");
    error.code = "IMAGE_CAPTURE_VIEWPORT_UNREADABLE";
    error.viewport = viewport;
    throw error;
  }
  let browserWindow = null;
  if (client?.Browser && typeof client.Browser.getWindowForTarget === "function") {
    try {
      const windowInfo = await client.Browser.getWindowForTarget({});
      const windowId = windowInfo?.windowId;
      const bounds = windowInfo?.bounds || (windowId != null && typeof client.Browser.getWindowBounds === "function"
        ? (await client.Browser.getWindowBounds({ windowId }))?.bounds
        : null);
      browserWindow = {
        window_id: windowId ?? null,
        left: finiteNumber(bounds?.left),
        top: finiteNumber(bounds?.top),
        width: Math.max(0, finiteNumber(bounds?.width)),
        height: Math.max(0, finiteNumber(bounds?.height)),
        window_state: bounds?.windowState || null
      };
    } catch {
      browserWindow = null;
    }
  }
  return {
    captured_at: nowIso(),
    viewport,
    browser_window: browserWindow
  };
}

function sameBrowserBounds(left = null, right = null) {
  if (!left || !right) return true;
  return left.window_id === right.window_id
    && left.left === right.left
    && left.top === right.top
    && left.width === right.width
    && left.height === right.height
    && left.window_state === right.window_state;
}

function compareCaptureViewportState(baseline, current, tolerance = 1) {
  if (!baseline?.viewport || !current?.viewport) {
    return { ok: false, reason: "unreadable" };
  }
  const safeTolerance = Math.max(0, finiteNumber(tolerance, 1));
  const widthDelta = current.viewport.width - baseline.viewport.width;
  const heightDelta = current.viewport.height - baseline.viewport.height;
  const windowChanged = !sameBrowserBounds(baseline.browser_window, current.browser_window);
  return {
    ok: Math.abs(widthDelta) <= safeTolerance && Math.abs(heightDelta) <= safeTolerance,
    reason: windowChanged ? "browser_window_changed" : null,
    width_delta: widthDelta,
    height_delta: heightDelta,
    browser_window_changed: windowChanged
  };
}

function createViewportDriftError(baseline, current, comparison, captureIndex = null) {
  const error = new Error("Viewport geometry changed during CV screenshot capture");
  error.code = "IMAGE_CAPTURE_VIEWPORT_DRIFT";
  error.capture_index = captureIndex;
  error.viewport_baseline = baseline;
  error.viewport_current = current;
  error.viewport_comparison = comparison;
  return error;
}

function readableBrowserWindow(windowState = null) {
  return Boolean(
    windowState
    && windowState.window_id != null
    && Number.isFinite(Number(windowState.width))
    && Number(windowState.width) > 0
    && Number.isFinite(Number(windowState.height))
    && Number(windowState.height) > 0
  );
}

function isExternalBrowserResize(previous = null, current = null) {
  if (!readableBrowserWindow(previous) || !readableBrowserWindow(current)) return false;
  if (previous.window_id !== current.window_id) return false;
  return previous.width !== current.width
    || previous.height !== current.height
    || previous.window_state !== current.window_state;
}

async function verifyCaptureWindowRebaseline(client, baseline, firstReading, {
  viewportTolerance = 1,
  stepTimeoutMs = 45000,
  captureIndex = null
} = {}) {
  const externalResize = isExternalBrowserResize(
    baseline?.browser_window,
    firstReading?.browser_window
  );
  if (!externalResize) {
    return {
      verified: false,
      reason: "browser_bounds_change_not_verified_external_resize",
      first_reading: firstReading,
      second_reading: null,
      stability: null
    };
  }
  const secondReading = await withCaptureTimeout(readCaptureViewportState(client), {
    label: `verify_window_rebaseline_${captureIndex ?? "unknown"}`,
    timeoutMs: stepTimeoutMs
  });
  const stability = compareCaptureViewportState(
    firstReading,
    secondReading,
    viewportTolerance
  );
  const boundsStable = sameBrowserBounds(
    firstReading?.browser_window,
    secondReading?.browser_window
  );
  return {
    verified: Boolean(stability.ok && !stability.browser_window_changed && boundsStable),
    reason: stability.ok && !stability.browser_window_changed && boundsStable
      ? "verified_external_resize_two_stable_readings"
      : "external_resize_not_stable_across_two_readings",
    first_reading: firstReading,
    second_reading: secondReading,
    stability,
    bounds_stable: boundsStable
  };
}

async function encodeImagePipeline(pipeline, format, quality) {
  const normalizedFormat = format === "jpg" ? "jpeg" : format;
  if (normalizedFormat === "jpeg") {
    return pipeline.jpeg({
      quality: quality == null ? 72 : Math.max(35, Math.min(95, finiteNumber(quality, 72))),
      mozjpeg: true
    });
  }
  if (normalizedFormat === "webp") {
    return pipeline.webp({
      quality: quality == null ? 76 : Math.max(35, Math.min(95, finiteNumber(quality, 76)))
    });
  }
  return pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
}

async function cropViewportScreenshotBuffer(buffer, {
  format = "png",
  quality,
  visibleRect,
  viewport,
  resizeMaxWidth = 0
} = {}) {
  const image = sharp(buffer, { failOn: "none" });
  const imageMetadata = await image.metadata();
  const imageWidth = Math.max(1, finiteNumber(imageMetadata.width));
  const imageHeight = Math.max(1, finiteNumber(imageMetadata.height));
  const scaleX = imageWidth / Math.max(1, viewport.width);
  const scaleY = imageHeight / Math.max(1, viewport.height);
  const rect = normalizeRect(visibleRect);
  const left = Math.max(0, Math.min(imageWidth - 1, Math.floor(rect.x * scaleX)));
  const top = Math.max(0, Math.min(imageHeight - 1, Math.floor(rect.y * scaleY)));
  const right = Math.max(left + 1, Math.min(imageWidth, Math.ceil((rect.x + rect.width) * scaleX)));
  const bottom = Math.max(top + 1, Math.min(imageHeight, Math.ceil((rect.y + rect.height) * scaleY)));
  const pixelCrop = {
    left,
    top,
    width: right - left,
    height: bottom - top
  };
  let pipeline = sharp(buffer, { failOn: "none" }).extract(pixelCrop);
  const safeMaxWidth = Math.max(0, finiteNumber(resizeMaxWidth));
  if (safeMaxWidth > 0 && pixelCrop.width > safeMaxWidth) {
    pipeline = pipeline.resize({ width: safeMaxWidth, withoutEnlargement: true });
  }
  pipeline = await encodeImagePipeline(pipeline, format, quality);
  const croppedBuffer = await pipeline.toBuffer();
  return {
    buffer: croppedBuffer,
    viewport_byte_length: buffer.length,
    image_width: imageWidth,
    image_height: imageHeight,
    scale_x: scaleX,
    scale_y: scaleY,
    pixel_crop: pixelCrop,
    resized: safeMaxWidth > 0 && pixelCrop.width > safeMaxWidth
  };
}

function createCliplessScreenshotOptions({ format = "png", quality } = {}) {
  const options = {
    format,
    fromSurface: true,
    captureBeyondViewport: false
  };
  if (quality != null) options.quality = quality;
  return options;
}

async function captureViewportAtomically(client, captureOptions, {
  label = "capture_screenshot",
  timeoutMs = 0
} = {}) {
  assertCaptureSessionSafe(client);
  const operationId = crypto.randomUUID();
  const queuedAt = Date.now();
  const prior = captureTransactions.get(client) || null;
  let releaseGate;
  const transaction = {
    gate: new Promise((resolve) => {
      releaseGate = resolve;
    }),
    released: false,
    release_reason: null,
    release(reason) {
      if (transaction.released) return;
      transaction.released = true;
      transaction.release_reason = reason;
      releaseGate();
      if (captureTransactions.get(client) === transaction) {
        captureTransactions.delete(client);
      }
    }
  };
  // Reserve our place synchronously, before yielding to the previous capture.
  // Without this reservation two callers can both observe an empty WeakMap and
  // issue overlapping Page.captureScreenshot requests.
  captureTransactions.set(client, transaction);
  if (prior) {
    await prior.gate;
    try {
      assertCaptureSessionSafe(client);
    } catch (error) {
      transaction.release("predecessor_session_unsafe");
      throw error;
    }
  }
  const requestStartedAt = Date.now();
  const connectionEpoch = captureConnectionEpoch(client);
  let rawCaptureSettled = false;
  let unsafeCaptureSession = null;
  const rawCapture = Promise.resolve().then(() => client.Page.captureScreenshot(captureOptions));
  const noteRawCaptureSettled = () => {
    rawCaptureSettled = true;
    if (unsafeCaptureSession) {
      unsafeCaptureSession.raw_capture_settled = true;
      unsafeCaptureSession.raw_capture_settled_at = nowIso();
      clearUnsafeCaptureSessionAfterSettlement(client, unsafeCaptureSession);
    }
    transaction.release("request_settled");
  };
  rawCapture.then(
    noteRawCaptureSettled,
    noteRawCaptureSettled
  );
  try {
    const result = await withCaptureTimeout(rawCapture, { label, timeoutMs });
    const completedAt = Date.now();
    return {
      ...result,
      __capture_telemetry: {
        operation_id: operationId,
        label,
        connection_epoch: connectionEpoch,
        queued_at: new Date(queuedAt).toISOString(),
        request_started_at: new Date(requestStartedAt).toISOString(),
        completed_at: new Date(completedAt).toISOString(),
        queue_elapsed_ms: requestStartedAt - queuedAt,
        transport_elapsed_ms: completedAt - requestStartedAt,
        total_elapsed_ms: completedAt - queuedAt,
        release_reason: transaction.release_reason || "request_settled"
      }
    };
  } catch (error) {
    const failedAt = Date.now();
    error.capture_operation = {
      operation_id: operationId,
      label,
      connection_epoch: connectionEpoch,
      queued_at: new Date(queuedAt).toISOString(),
      request_started_at: new Date(requestStartedAt).toISOString(),
      failed_at: new Date(failedAt).toISOString(),
      queue_elapsed_ms: requestStartedAt - queuedAt,
      transport_elapsed_ms: failedAt - requestStartedAt,
      total_elapsed_ms: failedAt - queuedAt,
      release_reason: transaction.release_reason
    };
    if (error?.code === "IMAGE_CAPTURE_TIMEOUT") {
      error.capture_outcome_unknown = true;
      error.screenshot_replay_suppressed = true;
      const canAttemptAbandonment = typeof client?.__abandonAndReconnect === "function";
      const unsafe = {
        operation_id: operationId,
        connection_epoch: connectionEpoch,
        blocked_since: nowIso(),
        reason: canAttemptAbandonment
          ? "abandonment_pending"
          : "abandonment_unavailable",
        raw_capture_settled: rawCaptureSettled,
        raw_capture_settled_at: rawCaptureSettled ? nowIso() : null,
        abandonment_attempted: canAttemptAbandonment,
        abandonment_settled: !canAttemptAbandonment,
        abandonment_settled_at: canAttemptAbandonment ? null : nowIso()
      };
      unsafeCaptureSession = unsafe;
      unsafeCaptureSessions.set(client, unsafe);
      clearUnsafeCaptureSessionAfterSettlement(client, unsafe);
      let safelyAbandoned = false;
      if (canAttemptAbandonment) {
        const abandonmentAttempt = Promise.resolve().then(() => client.__abandonAndReconnect({
          reason: `${label}:timeout_unknown_outcome`
        }));
        const noteAbandonmentSettled = (outcome) => {
          unsafe.abandonment_settled = true;
          unsafe.abandonment_outcome = outcome;
          unsafe.abandonment_settled_at = nowIso();
          clearUnsafeCaptureSessionAfterSettlement(client, unsafe);
        };
        abandonmentAttempt.then(
          () => noteAbandonmentSettled("fulfilled"),
          () => noteAbandonmentSettled("rejected")
        );
        try {
          const abandonTimeoutMs = Math.max(
            250,
            Math.min(5000, Math.floor((Math.max(0, Number(timeoutMs) || 0) || 4000) / 4))
          );
          error.capture_reconnect = await withCaptureTimeout(
            abandonmentAttempt,
            {
              label: `${label}_abandon_session`,
              timeoutMs: abandonTimeoutMs
            }
          );
          const epochAfterAbandon = captureConnectionEpoch(client);
          const reportedPreviousEpoch = Number(error.capture_reconnect?.previous_connection_epoch);
          const reportedNextEpoch = Number(error.capture_reconnect?.connection_epoch);
          const verifiedEpochChange = Boolean(
            (connectionEpoch != null
              && epochAfterAbandon != null
              && epochAfterAbandon !== connectionEpoch)
            || (Number.isFinite(reportedPreviousEpoch)
              && Number.isFinite(reportedNextEpoch)
              && reportedNextEpoch !== reportedPreviousEpoch)
          );
          if (error.capture_reconnect?.reconnected === true && verifiedEpochChange) {
            safelyAbandoned = true;
            unsafeCaptureSessions.delete(client);
            transaction.release("session_abandoned");
          }
        } catch (reconnectError) {
          error.capture_reconnect_error = reconnectError?.message || String(reconnectError);
        }
      }
      if (!safelyAbandoned) {
        unsafe.reason = error.capture_reconnect_error
          ? "abandonment_failed"
          : (canAttemptAbandonment ? "abandonment_unverified" : "abandonment_unavailable");
        const remainsUnsafe = unsafeCaptureSessions.get(client) === unsafe;
        if (remainsUnsafe) {
          error.capture_session_unsafe = true;
          error.capture_session_block = unsafe;
        }
        // Wake queued callers so they fail closed immediately.  The separate
        // unsafe-session sentinel prevents them (and later workflow retries)
        // from starting another screenshot until both the original request and
        // the abandonment attempt (if any) have settled.
        transaction.release(remainsUnsafe ? "session_unsafe" : "timed_out_work_settled");
      }
    }
    const rawEpochAfter = captureConnectionEpoch(client);
    error.capture_operation.release_reason = transaction.release_reason;
    error.capture_operation.connection_epoch_after = rawEpochAfter;
    throw error;
  }
}

async function readVisibleCaptureGeometry(client, nodeId, {
  padding = 0,
  iframeOwnerNodeId = null,
  allowReposition = true
} = {}) {
  async function read() {
    const [box, viewportState, iframeOwnerBox] = await Promise.all([
      getNodeBox(client, nodeId),
      readCaptureViewportState(client),
      iframeOwnerNodeId ? getNodeBox(client, iframeOwnerNodeId).catch(() => null) : Promise.resolve(null)
    ]);
    const iframeOwnerRect = iframeOwnerBox
      ? (rectFromQuad(iframeOwnerBox.model?.content) || iframeOwnerBox.rect)
      : null;
    const resolved = resolveVisibleTargetRect(box.rect, viewportState.viewport, {
      padding,
      iframeOwnerRect
    });
    return {
      box,
      iframe_owner_box: iframeOwnerBox,
      iframe_owner_rect: iframeOwnerRect,
      viewport_state: viewportState,
      resolved
    };
  }

  try {
    return await read();
  } catch (error) {
    if (
      !allowReposition
      || error?.code !== "IMAGE_CAPTURE_TARGET_OUT_OF_VIEW"
      || !client?.DOM
      || typeof client.DOM.scrollIntoViewIfNeeded !== "function"
    ) {
      throw error;
    }
    await client.DOM.scrollIntoViewIfNeeded({ nodeId });
    return read();
  }
}

function normalizeRandom(random) {
  return typeof random === "function" ? random : Math.random;
}

function randomBetween(random, min, max) {
  const lower = Number(min) || 0;
  const upper = Number(max) || lower;
  if (upper <= lower) return lower;
  return lower + normalizeRandom(random)() * (upper - lower);
}

function normalizeRatio(raw, fallback, { min = 0, max = 1 } = {}) {
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeScrollDeltaJitter({
  enabled = false,
  minRatio = 0.65,
  maxRatio = 0.9,
  minOverlapRatio = 0.2,
  preserveCoverage = true,
  random = Math.random
} = {}) {
  const safeMinRatio = normalizeRatio(minRatio, 0.65, { min: 0.1, max: 1 });
  const safeMaxRatio = Math.max(safeMinRatio, normalizeRatio(maxRatio, 0.9, { min: safeMinRatio, max: 1 }));
  return {
    enabled: enabled === true,
    min_ratio: safeMinRatio,
    max_ratio: safeMaxRatio,
    min_overlap_ratio: normalizeRatio(minOverlapRatio, 0.2, { min: 0, max: 0.8 }),
    preserve_coverage: preserveCoverage !== false,
    random: normalizeRandom(random)
  };
}

function resolveCoverageSafeScrollDelta({
  baseDelta,
  clipHeight,
  jitter
} = {}) {
  const safeBase = Math.max(1, Number(baseDelta) || 650);
  const safeClipHeight = Math.max(1, Number(clipHeight) || 1);
  const minOverlapRatio = normalizeRatio(jitter?.min_overlap_ratio, 0.2, { min: 0, max: 0.8 });
  const maxDeltaForOverlap = Math.max(1, Math.floor(safeClipHeight * (1 - minOverlapRatio)));
  if (!jitter?.enabled) {
    return {
      deltaY: Math.min(safeBase, maxDeltaForOverlap),
      jittered: false,
      base_delta_y: safeBase,
      min_overlap_ratio: minOverlapRatio,
      clip_height: safeClipHeight,
      max_delta_for_overlap: maxDeltaForOverlap,
      preserve_coverage: true
    };
  }
  const upper = Math.max(1, Math.min(Math.round(safeBase * jitter.max_ratio), maxDeltaForOverlap));
  const lower = Math.min(upper, Math.max(1, Math.round(safeBase * jitter.min_ratio)));
  const deltaY = Math.max(1, Math.round(randomBetween(jitter.random, lower, upper)));
  return {
    deltaY,
    jittered: true,
    base_delta_y: safeBase,
    min_delta_y: lower,
    max_delta_y: upper,
    min_ratio: jitter.min_ratio,
    max_ratio: jitter.max_ratio,
    min_overlap_ratio: jitter.min_overlap_ratio,
    clip_height: safeClipHeight,
    max_delta_for_overlap: maxDeltaForOverlap,
    preserve_coverage: jitter.preserve_coverage
  };
}

export async function captureNodeHtml(client, nodeId, {
  domain = "unknown",
  source = "dom",
  metadata = {}
} = {}) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
  ]);
  const text = htmlToText(outerHTML);
  return {
    schema_version: 1,
    domain: normalizeText(domain) || "unknown",
    source,
    captured_at: nowIso(),
    node_id: nodeId,
    attributes,
    outer_html_length: outerHTML.length,
    text_length: text.length,
    text,
    outer_html: outerHTML,
    metadata
  };
}

export async function captureNodeScreenshot(client, nodeId, {
  filePath,
  format = "png",
  quality,
  padding = 0,
  captureBeyondViewport: requestedCaptureBeyondViewport = false,
  fromSurface: requestedFromSurface = true,
  iframeOwnerNodeId = null,
  resizeMaxWidth = 0,
  stepTimeoutMs = 45000,
  metadata = {}
} = {}) {
  const operationStartedAt = Date.now();
  const geometry = await withCaptureTimeout(readVisibleCaptureGeometry(client, nodeId, {
    padding,
    iframeOwnerNodeId
  }), {
    label: "get_capture_geometry",
    timeoutMs: stepTimeoutMs
  });
  const geometryElapsedMs = Date.now() - operationStartedAt;
  const captureOptions = createCliplessScreenshotOptions({ format, quality });
  const screenshot = await captureViewportAtomically(client, captureOptions, {
    label: "capture_node_screenshot",
    timeoutMs: stepTimeoutMs
  });
  const viewportBuffer = Buffer.from(screenshot.data || "", "base64");
  const afterViewportState = await withCaptureTimeout(readCaptureViewportState(client), {
    label: "get_post_capture_viewport",
    timeoutMs: stepTimeoutMs
  });
  const viewportComparison = compareCaptureViewportState(geometry.viewport_state, afterViewportState);
  if (!viewportComparison.ok || viewportComparison.browser_window_changed) {
    const driftError = createViewportDriftError(
      geometry.viewport_state,
      afterViewportState,
      viewportComparison,
      0
    );
    driftError.capture_operation = screenshot.__capture_telemetry || null;
    driftError.target_geometry = {
      node_rect: geometry.box.rect,
      iframe_owner_rect: geometry.iframe_owner_rect || null
    };
    throw driftError;
  }
  const cropStartedAt = Date.now();
  const cropped = await cropViewportScreenshotBuffer(viewportBuffer, {
    format,
    quality,
    visibleRect: geometry.resolved.visible_rect,
    viewport: geometry.viewport_state.viewport,
    resizeMaxWidth
  });
  const localCropElapsedMs = Date.now() - cropStartedAt;
  const buffer = cropped.buffer;
  const resolvedPath = resolveOutputPath(filePath);
  if (resolvedPath) {
    fs.writeFileSync(resolvedPath, buffer);
  }
  return {
    schema_version: 1,
    source: "image",
    captured_at: nowIso(),
    node_id: nodeId,
    format,
    mime_type: `image/${format === "jpeg" ? "jpeg" : "png"}`,
    byte_length: buffer.length,
    file_path: resolvedPath,
    clip: geometry.resolved.visible_rect,
    crop: {
      ...geometry.resolved,
      ...cropped,
      buffer: undefined
    },
    node_rect: geometry.box.rect,
    iframe_owner_rect: geometry.iframe_owner_rect || null,
    viewport_before: geometry.viewport_state,
    viewport_after: afterViewportState,
    viewport_comparison: viewportComparison,
    capture_operation: screenshot.__capture_telemetry || null,
    timing: {
      geometry_elapsed_ms: geometryElapsedMs,
      transport_elapsed_ms: screenshot.__capture_telemetry?.transport_elapsed_ms ?? null,
      local_crop_elapsed_ms: localCropElapsedMs,
      total_elapsed_ms: Date.now() - operationStartedAt
    },
    browser_clip_used: false,
    capture_beyond_viewport: false,
    requested_capture_beyond_viewport: Boolean(requestedCaptureBeyondViewport),
    requested_from_surface: Boolean(requestedFromSurface),
    metadata
  };
}

export async function captureViewportScreenshot(client, {
  format = "png",
  quality,
  captureBeyondViewport: requestedCaptureBeyondViewport = false,
  fromSurface: requestedFromSurface = true,
  stepTimeoutMs = 45000,
  metadata = {}
} = {}) {
  const operationStartedAt = Date.now();
  const captureOptions = createCliplessScreenshotOptions({ format, quality });
  const screenshot = await captureViewportAtomically(client, captureOptions, {
    label: "capture_viewport_screenshot",
    timeoutMs: stepTimeoutMs
  });
  const buffer = Buffer.from(screenshot.data || "", "base64");
  return {
    schema_version: 1,
    source: "viewport-image",
    captured_at: nowIso(),
    format,
    mime_type: `image/${format === "jpeg" ? "jpeg" : "png"}`,
    byte_length: buffer.length,
    file_path: null,
    persistence: "forbidden_uncropped_viewport",
    capture_operation: screenshot.__capture_telemetry || null,
    timing: {
      transport_elapsed_ms: screenshot.__capture_telemetry?.transport_elapsed_ms ?? null,
      total_elapsed_ms: Date.now() - operationStartedAt
    },
    capture_beyond_viewport: false,
    requested_capture_beyond_viewport: Boolean(requestedCaptureBeyondViewport),
    requested_from_surface: Boolean(requestedFromSurface),
    browser_clip_used: false,
    metadata
  };
}

function filePathForSequence(basePath, index, extension) {
  const resolved = resolveOutputPath(basePath);
  if (!resolved) return null;
  const parsed = path.parse(resolved);
  const page = String(index + 1).padStart(2, "0");
  return path.join(parsed.dir, `${parsed.name}-page-${page}${parsed.ext || `.${extension}`}`);
}

function filePathForLlmSequence(basePath, index) {
  const resolved = resolveOutputPath(basePath);
  if (!resolved) return null;
  const parsed = path.parse(resolved);
  const page = String(index + 1).padStart(2, "0");
  return path.join(parsed.dir, `${parsed.name}-llm-${page}.jpg`);
}

function screenshotHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createCaptureTimeoutError(label, timeoutMs) {
  const error = new Error(`Image fallback capture timed out during ${label} after ${timeoutMs}ms`);
  error.code = "IMAGE_CAPTURE_TIMEOUT";
  error.capture_step = label;
  error.timeout_ms = timeoutMs;
  return error;
}

async function withCaptureTimeout(promise, {
  label = "capture_step",
  timeoutMs = 0
} = {}) {
  const safeTimeout = Math.max(0, Number(timeoutMs) || 0);
  if (!safeTimeout) return promise;
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createCaptureTimeoutError(label, safeTimeout)), safeTimeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertCaptureTotalBudget(started, totalTimeoutMs, label) {
  const safeTimeout = Math.max(0, Number(totalTimeoutMs) || 0);
  if (!safeTimeout) return;
  const elapsed = Date.now() - started;
  if (elapsed <= safeTimeout) return;
  const error = createCaptureTimeoutError(label, safeTimeout);
  error.elapsed_ms = elapsed;
  error.code = "IMAGE_CAPTURE_TOTAL_TIMEOUT";
  throw error;
}

const DEFAULT_SCROLL_ANCHOR_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "p",
  "li",
  "section",
  "article",
  "table",
  "tr",
  "dl",
  "dt",
  "dd",
  "[class*='resume']",
  "[class*='work']",
  "[class*='project']",
  "[class*='education']",
  "[class*='experience']",
  "[class*='item']",
  "div"
].join(",");

function normalizeScrollMethod(value = "dom-anchor-fallback-input") {
  const normalized = normalizeText(value).toLowerCase();
  if (["dom", "dom-anchor", "dom_anchor", "anchor"].includes(normalized)) return "dom-anchor";
  if (["dom-anchor-fallback-input", "dom_anchor_fallback_input", "dom-fallback-input"].includes(normalized)) {
    return "dom-anchor-fallback-input";
  }
  return "input";
}

function uniqueNumbers(values = []) {
  return Array.from(new Set(values.map((value) => Number(value) || 0).filter(Boolean)));
}

function pickEvenly(items = [], limit = 1) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  if (items.length <= safeLimit) return items;
  const picked = [];
  const last = items.length - 1;
  for (let index = 0; index < safeLimit; index += 1) {
    const sourceIndex = Math.round((index * last) / Math.max(1, safeLimit - 1));
    picked.push(items[sourceIndex]);
  }
  return Array.from(new Map(picked.map((item) => [item.node_id, item])).values());
}

function stableAnchorSignature(anchor = {}, attributes = {}) {
  const normalizedAttributes = Object.fromEntries(
    Object.entries(attributes || {})
      .map(([key, value]) => [String(key), normalizeText(value)])
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const identity = {
    document_order: Number.isFinite(Number(anchor.document_order))
      ? Number(anchor.document_order)
      : null,
    width: Math.round(Number(anchor.width) || 0),
    height: Math.round(Number(anchor.height) || 0),
    attributes: normalizedAttributes
  };
  return crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function patternLabel(pattern) {
  if (pattern instanceof RegExp) return pattern.source;
  return normalizeText(pattern);
}

function stopBoundaryPatterns(patterns = []) {
  return (Array.isArray(patterns) ? patterns : [patterns])
    .filter(Boolean)
    .map((pattern) => {
      if (pattern instanceof RegExp) {
        return {
          raw: pattern,
          label: pattern.source,
          matches: (text) => pattern.test(text)
        };
      }
      const normalized = normalizeText(pattern);
      return {
        raw: pattern,
        label: normalized,
        matches: (text) => normalized && text.includes(normalized)
      };
    });
}

async function collectStopBoundaryNodes(client, rootNodeId, {
  selector = "",
  textPatterns = [],
  maxProbeNodes = 180,
  maxTextLength = 700,
  stepTimeoutMs = 45000
} = {}) {
  const patterns = stopBoundaryPatterns(textPatterns);
  const normalizedSelector = normalizeText(selector);
  if (!normalizedSelector && !patterns.length) {
    return {
      enabled: false,
      ok: false,
      reason: "not_configured",
      nodes: []
    };
  }
  const started = Date.now();
  let nodeIds = [];
  try {
    nodeIds = uniqueNumbers(await querySelectorAll(
      client,
      rootNodeId,
      normalizedSelector || DEFAULT_SCROLL_ANCHOR_SELECTOR
    ));
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      reason: "query_selector_all_failed",
      selector: normalizedSelector || DEFAULT_SCROLL_ANCHOR_SELECTOR,
      error: error?.message || String(error),
      nodes: []
    };
  }

  const probeLimit = Math.max(1, Number(maxProbeNodes) || 180);
  const maxStopTextLength = Math.max(40, Number(maxTextLength) || 700);
  const perNodeTimeoutMs = Math.min(1000, Math.max(200, Math.floor((Number(stepTimeoutMs) || 45000) / 40)));
  const nodes = [];
  for (const nodeId of nodeIds.slice(0, probeLimit)) {
    try {
      let text = "";
      let matchedPattern = null;
      if (patterns.length) {
        const outerHTML = await withCaptureTimeout(getOuterHTML(client, nodeId), {
          label: `stop_boundary_html_${nodeId}`,
          timeoutMs: perNodeTimeoutMs
        });
        text = normalizeText(htmlToText(outerHTML));
        if (!text || text.length > maxStopTextLength) continue;
        matchedPattern = patterns.find((pattern) => pattern.matches(text));
        if (!matchedPattern) continue;
      }
      nodes.push({
        node_id: nodeId,
        text_preview: text.slice(0, 120),
        matched_pattern: matchedPattern ? patternLabel(matchedPattern.raw) : null
      });
    } catch {}
  }

  return {
    enabled: true,
    ok: nodes.length > 0,
    reason: nodes.length ? null : "no_matching_stop_boundary_nodes",
    selector: normalizedSelector || DEFAULT_SCROLL_ANCHOR_SELECTOR,
    elapsed_ms: Date.now() - started,
    discovered_node_count: nodeIds.length,
    probed_node_count: Math.min(nodeIds.length, probeLimit),
    match_count: nodes.length,
    pattern_labels: patterns.map((pattern) => pattern.label),
    nodes
  };
}

async function resolveVisibleStopBoundary(client, stopBoundaryPlan, clip, {
  topPadding = 8,
  minCaptureHeight = 180,
  stepTimeoutMs = 45000,
  viewport = null,
  coordinateSpace = "viewport",
  iframeOwnerRect = null
} = {}) {
  if (!stopBoundaryPlan?.nodes?.length || !clip) return null;
  const clipTop = Number(clip.y) || 0;
  const clipBottom = clipTop + (Number(clip.height) || 0);
  const safePadding = Math.max(0, Number(topPadding) || 0);
  const safeMinHeight = Math.max(1, Number(minCaptureHeight) || 180);
  const perNodeTimeoutMs = Math.min(900, Math.max(180, Math.floor((Number(stepTimeoutMs) || 45000) / 50)));
  const visible = [];

  for (const node of stopBoundaryPlan.nodes) {
    try {
      const box = await withCaptureTimeout(getNodeBox(client, node.node_id), {
        label: `stop_boundary_box_${node.node_id}`,
        timeoutMs: perNodeTimeoutMs
      });
      const rect = viewport
        ? rectForCoordinateSpace(
            box?.rect || {},
            viewport,
            coordinateSpace,
            iframeOwnerRect
          )
        : (box?.rect || {});
      const width = Number(rect.width) || 0;
      const height = Number(rect.height) || 0;
      if (width < 40 || height < 6) continue;
      const top = Number(rect.y) || 0;
      const bottom = top + height;
      if (bottom <= clipTop + 1) {
        return {
          action: "stop_before_capture",
          reason: "stop_boundary_above_clip",
          node_id: node.node_id,
          matched_pattern: node.matched_pattern,
          text_preview: node.text_preview,
          rect,
          clip
        };
      }
      if (top < clipBottom && bottom > clipTop) {
        visible.push({
          ...node,
          rect,
          top,
          bottom
        });
      }
    } catch {}
  }
  if (!visible.length) return null;

  visible.sort((a, b) => a.top - b.top);
  const boundary = visible[0];
  const boundaryY = Math.max(clipTop, boundary.top - safePadding);
  const adjustedHeight = Math.max(0, boundaryY - clipTop);
  if (adjustedHeight < safeMinHeight) {
    return {
      action: "stop_before_capture",
      reason: "stop_boundary_near_clip_top",
      node_id: boundary.node_id,
      matched_pattern: boundary.matched_pattern,
      text_preview: boundary.text_preview,
      rect: boundary.rect,
      clip,
      adjusted_height: adjustedHeight,
      min_capture_height: safeMinHeight
    };
  }

  return {
    action: "capture_then_stop",
    reason: "stop_boundary_visible",
    node_id: boundary.node_id,
    matched_pattern: boundary.matched_pattern,
    text_preview: boundary.text_preview,
    rect: boundary.rect,
    clip,
    adjusted_clip: {
      ...clip,
      height: adjustedHeight
    },
    adjusted_height: adjustedHeight,
    min_capture_height: safeMinHeight
  };
}

async function collectDomScrollAnchors(client, rootNodeId, {
  selector = DEFAULT_SCROLL_ANCHOR_SELECTOR,
  maxScreenshots = 6,
  maxProbeNodes = 260,
  minAnchorGap = 180,
  stepTimeoutMs = 45000
} = {}) {
  const started = Date.now();
  let nodeIds = [];
  try {
    nodeIds = uniqueNumbers(await querySelectorAll(client, rootNodeId, selector));
  } catch (error) {
    return {
      ok: false,
      method: "dom-anchor",
      reason: "query_selector_all_failed",
      error: error?.message || String(error)
    };
  }
  if (!nodeIds.length) {
    return {
      ok: false,
      method: "dom-anchor",
      reason: "no_anchor_nodes"
    };
  }

  const probeLimit = Math.max(1, Number(maxProbeNodes) || 260);
  const perNodeTimeoutMs = Math.min(1200, Math.max(250, Math.floor((Number(stepTimeoutMs) || 45000) / 30)));
  const measured = [];
  for (const [documentOrder, nodeId] of nodeIds.slice(0, probeLimit).entries()) {
    try {
      const box = await withCaptureTimeout(getNodeBox(client, nodeId), {
        label: `anchor_box_${nodeId}`,
        timeoutMs: perNodeTimeoutMs
      });
      const rect = box?.rect || {};
      if ((Number(rect.width) || 0) < 80 || (Number(rect.height) || 0) < 8) continue;
      measured.push({
        node_id: nodeId,
        document_order: documentOrder,
        y: Math.round(Number(rect.y) || 0),
        width: Math.round(Number(rect.width) || 0),
        height: Math.round(Number(rect.height) || 0)
      });
    } catch {}
  }

  let anchors = [];
  let bottomAnchor = null;
  if (measured.length) {
    const sorted = measured.sort((a, b) => a.y - b.y);
    bottomAnchor = sorted[sorted.length - 1] || null;
    if (bottomAnchor) {
      let attributes = {};
      try {
        attributes = await withCaptureTimeout(getAttributesMap(client, bottomAnchor.node_id), {
          label: `anchor_attributes_${bottomAnchor.node_id}`,
          timeoutMs: perNodeTimeoutMs
        });
      } catch {}
      bottomAnchor = {
        ...bottomAnchor,
        structural_signature: stableAnchorSignature(bottomAnchor, attributes)
      };
    }
    for (const item of sorted) {
      const last = anchors[anchors.length - 1];
      if (!last || Math.abs(item.y - last.y) >= Math.max(40, Number(minAnchorGap) || 180)) {
        anchors.push(item);
      }
    }
  }

  if (anchors.length < 2) {
    anchors = nodeIds.slice(0, probeLimit).map((nodeId, index) => ({
      node_id: nodeId,
      y: null,
      height: null,
      document_order: index
    }));
  }

  anchors = pickEvenly(anchors, Math.max(1, Number(maxScreenshots) || 1));
  return {
    ok: anchors.length > 0,
    method: "dom-anchor",
    elapsed_ms: Date.now() - started,
    selector,
    discovered_node_count: nodeIds.length,
    measured_node_count: measured.length,
    anchor_count: anchors.length,
    bottom_anchor: bottomAnchor,
    anchors
  };
}

function resolveAnchorProgressEvidence(anchorPlan, previousEvidence = null, tolerance = 1) {
  const anchor = anchorPlan?.bottom_anchor || null;
  const y = Number(anchor?.y);
  const height = Number(anchor?.height);
  const available = Boolean(
    anchor?.node_id
    && anchor?.y != null
    && anchor?.height != null
    && Number.isFinite(y)
    && Number.isFinite(height)
  );
  const previousAvailable = Boolean(previousEvidence?.available);
  const sameAnchor = Boolean(
    available
    && previousAvailable
    && Number(previousEvidence.node_id) === Number(anchor.node_id)
  );
  const positionComparable = Boolean(available && previousAvailable);
  const deltaY = positionComparable ? y - Number(previousEvidence.y) : null;
  const heightDelta = positionComparable ? height - Number(previousEvidence.height) : null;
  const safeTolerance = Math.max(0, Number(tolerance) || 0);
  const stationary = Boolean(
    positionComparable
    && Math.abs(deltaY) <= safeTolerance
    && Math.abs(heightDelta) <= safeTolerance
  );
  return {
    available,
    node_id: available ? Number(anchor.node_id) : null,
    document_order: available && Number.isFinite(Number(anchor.document_order))
      ? Number(anchor.document_order)
      : null,
    structural_signature: available ? (anchor.structural_signature || null) : null,
    y: available ? y : null,
    height: available ? height : null,
    previous_available: previousAvailable,
    previous_node_id: previousAvailable ? Number(previousEvidence.node_id) : null,
    same_anchor: sameAnchor,
    position_comparable: positionComparable,
    delta_y: deltaY,
    height_delta: heightDelta,
    stationary,
    tolerance: safeTolerance,
    reason: !available
      ? (anchorPlan?.reason || "anchor_geometry_unavailable")
      : !previousAvailable
        ? "no_previous_anchor_sample"
        : stationary
          ? (sameAnchor ? "bottom_anchor_stationary" : "bottom_anchor_reacquired_stationary")
          : (sameAnchor ? "bottom_anchor_moved" : "bottom_anchor_reacquired_moved")
  };
}

function resolveCoverageOverlap(previousEntry, visibleRect, scrollMetadata, anchorEvidence) {
  if (!previousEntry) return null;
  const previousRect = normalizeRect(previousEntry.visible_crop || {});
  const currentRect = normalizeRect(visibleRect || {});
  const comparableHeight = Math.min(previousRect.height, currentRect.height);
  let estimatedScrollDelta = null;
  let source = "unavailable";
  if (
    anchorEvidence?.position_comparable
    && Number.isFinite(Number(anchorEvidence.delta_y))
  ) {
    estimatedScrollDelta = Math.abs(Number(anchorEvidence.delta_y));
    source = "bottom_anchor_delta";
  } else if (Number.isFinite(Number(scrollMetadata?.wheel_delta_y))) {
    estimatedScrollDelta = Math.abs(Number(scrollMetadata.wheel_delta_y));
    source = "wheel_delta_request";
  }
  const overlapCss = estimatedScrollDelta == null
    ? null
    : Math.max(0, comparableHeight - estimatedScrollDelta);
  return {
    source,
    previous_capture_index: previousEntry.capture_index,
    comparable_height_css: comparableHeight,
    estimated_scroll_delta_y_css: estimatedScrollDelta,
    estimated_overlap_css: overlapCss,
    estimated_overlap_ratio: overlapCss == null || comparableHeight <= 0
      ? null
      : overlapCss / comparableHeight
  };
}

const SESSION_SCOPED_NODE_ID_KEYS = new Set([
  "node_id",
  "anchor_node_id",
  "previous_node_id"
]);

function sanitizeCoverageCheckpointValue(value, key = "") {
  if (SESSION_SCOPED_NODE_ID_KEYS.has(key)) return null;
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeCoverageCheckpointValue(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const next = sanitizeCoverageCheckpointValue(childValue, childKey);
      if (next !== undefined) sanitized[childKey] = next;
    }
    return sanitized;
  }
  return undefined;
}

function normalizeCoverageResumeCheckpoint(checkpoint, {
  maxUniqueScreenshots
} = {}) {
  if (!checkpoint) {
    return {
      used: false,
      checkpoint_id: null,
      screenshots: [],
      coverage_ledger: [],
      anchor_plan_history: [],
      stop_boundary_checks: [],
      viewport_events: [],
      previous_hash: "",
      dropped_duplicate_count: 0,
      next_capture_index: 0,
      current_pending_scroll_metadata: null,
      continuity_target: null
    };
  }
  if (typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    const error = new Error("resumeCheckpoint must be a coverage checkpoint object");
    error.code = "IMAGE_CAPTURE_CHECKPOINT_INVALID";
    throw error;
  }
  if (
    checkpoint.kind !== "cv_capture_coverage_checkpoint"
    || Number(checkpoint.schema_version) !== 1
  ) {
    const error = new Error("resumeCheckpoint has an unsupported schema or kind");
    error.code = "IMAGE_CAPTURE_CHECKPOINT_INVALID";
    throw error;
  }
  const screenshots = sanitizeCoverageCheckpointValue(
    Array.isArray(checkpoint.screenshots) ? checkpoint.screenshots : []
  );
  const coverageLedger = sanitizeCoverageCheckpointValue(
    Array.isArray(checkpoint.coverage_ledger) ? checkpoint.coverage_ledger : []
  ).filter((entry) => entry?.accepted_for_coverage !== false);
  const uniqueHashes = new Set(
    screenshots.map((item) => String(item?.sha256 || "")).filter(Boolean)
  );
  const safeMaxUnique = Math.max(1, Number(maxUniqueScreenshots) || 1);
  if (uniqueHashes.size > safeMaxUnique) {
    const error = new Error("resumeCheckpoint exceeds the configured unique screenshot limit");
    error.code = "IMAGE_CAPTURE_CHECKPOINT_INVALID";
    error.unique_screenshot_count = uniqueHashes.size;
    error.max_unique_screenshots = safeMaxUnique;
    throw error;
  }
  const ledgerNextIndex = coverageLedger.reduce((next, entry) => (
    Math.max(next, (Number(entry?.capture_index) || 0) + 1)
  ), 0);
  const requestedNextIndex = Math.max(0, Number(checkpoint.next_capture_index) || 0);
  const previousHash = String(checkpoint.previous_hash || "");
  const lastConfirmedEntry = [...coverageLedger]
    .reverse()
    .find((entry) => String(entry?.sha256 || "") === previousHash)
    || coverageLedger[coverageLedger.length - 1]
    || null;
  const checkpointContinuityTarget = sanitizeCoverageCheckpointValue(
    checkpoint.resume_continuity_target || null
  );
  return {
    used: true,
    checkpoint_id: String(checkpoint.checkpoint_id || "") || null,
    screenshots,
    coverage_ledger: coverageLedger,
    anchor_plan_history: sanitizeCoverageCheckpointValue(
      Array.isArray(checkpoint.anchor_plan_history) ? checkpoint.anchor_plan_history : []
    ),
    stop_boundary_checks: sanitizeCoverageCheckpointValue(
      Array.isArray(checkpoint.stop_boundary_checks) ? checkpoint.stop_boundary_checks : []
    ),
    viewport_events: sanitizeCoverageCheckpointValue(
      Array.isArray(checkpoint.viewport_events) ? checkpoint.viewport_events : []
    ),
    previous_hash: previousHash,
    dropped_duplicate_count: Math.max(0, Number(checkpoint.dropped_duplicate_count) || 0),
    next_capture_index: Math.max(ledgerNextIndex, requestedNextIndex),
    current_pending_scroll_metadata: sanitizeCoverageCheckpointValue(
      checkpoint.current_pending_scroll_metadata || null
    ),
    continuity_target: checkpointContinuityTarget || (previousHash ? {
      sha256: previousHash,
      capture_index: lastConfirmedEntry?.capture_index ?? null,
      visible_crop: lastConfirmedEntry?.visible_crop || null,
      anchor: lastConfirmedEntry?.anchor_evidence || lastConfirmedEntry?.anchor_plan?.bottom_anchor || null
    } : null)
  };
}

function createResumeContinuityTarget(screenshots = [], coverageLedger = [], previousHash = "") {
  const targetHash = String(previousHash || "");
  if (!targetHash) return null;
  const lastConfirmedEntry = [...coverageLedger]
    .reverse()
    .find((entry) => String(entry?.sha256 || "") === targetHash)
    || coverageLedger[coverageLedger.length - 1]
    || null;
  const screenshot = [...screenshots]
    .reverse()
    .find((item) => String(item?.sha256 || "") === targetHash)
    || null;
  return sanitizeCoverageCheckpointValue({
    sha256: targetHash,
    capture_index: lastConfirmedEntry?.capture_index ?? screenshot?.capture_index ?? null,
    screenshot_file_path: screenshot?.file_path || null,
    visible_crop: lastConfirmedEntry?.visible_crop || screenshot?.crop?.visible_rect || null,
    anchor: lastConfirmedEntry?.anchor_evidence || lastConfirmedEntry?.anchor_plan?.bottom_anchor || null
  });
}

function createCoverageCheckpoint({
  screenshots,
  coverageLedger,
  anchorPlanHistory,
  stopBoundaryChecks,
  viewportEvents,
  previousHash,
  droppedDuplicateCount,
  currentScrollMetadata,
  maxUniqueScreenshots,
  format,
  filePath,
  sourceCheckpointId = null,
  resumeContinuity = null
} = {}) {
  const sanitizedScreenshots = sanitizeCoverageCheckpointValue(screenshots || []);
  const sanitizedLedger = sanitizeCoverageCheckpointValue(coverageLedger || [])
    .filter((entry) => entry?.accepted_for_coverage !== false);
  const nextCaptureIndex = sanitizedLedger.reduce((next, entry) => (
    Math.max(next, (Number(entry?.capture_index) || 0) + 1)
  ), 0);
  return {
    schema_version: 1,
    kind: "cv_capture_coverage_checkpoint",
    checkpoint_id: crypto.randomUUID(),
    source_checkpoint_id: sourceCheckpointId,
    created_at: nowIso(),
    session_scoped_node_ids_reset: true,
    node_id: null,
    format,
    file_path: filePath ? path.resolve(filePath) : null,
    max_unique_screenshots: Math.max(1, Number(maxUniqueScreenshots) || 1),
    next_capture_index: nextCaptureIndex,
    confirmed_capture_count: sanitizedLedger.length,
    unique_screenshot_count: new Set(
      sanitizedScreenshots.map((item) => String(item?.sha256 || "")).filter(Boolean)
    ).size,
    previous_hash: String(previousHash || ""),
    dropped_duplicate_count: Math.max(0, Number(droppedDuplicateCount) || 0),
    current_pending_scroll_metadata: sanitizeCoverageCheckpointValue(currentScrollMetadata || null),
    resume_continuity_target: createResumeContinuityTarget(
      sanitizedScreenshots,
      sanitizedLedger,
      previousHash
    ),
    last_resume_continuity: sanitizeCoverageCheckpointValue(resumeContinuity || null),
    screenshots: sanitizedScreenshots,
    coverage_ledger: sanitizedLedger,
    anchor_plan_history: sanitizeCoverageCheckpointValue(anchorPlanHistory || []),
    stop_boundary_checks: sanitizeCoverageCheckpointValue(stopBoundaryChecks || []),
    viewport_events: sanitizeCoverageCheckpointValue(viewportEvents || [])
  };
}

function resumeAnchorMatches(targetAnchor = null, freshAnchor = null, tolerance = 1) {
  if (!targetAnchor || !freshAnchor?.node_id) return false;
  const safeTolerance = Math.max(0, Number(tolerance) || 0);
  const targetY = Number(targetAnchor.y);
  const freshY = Number(freshAnchor.y);
  const targetHeight = Number(targetAnchor.height);
  const freshHeight = Number(freshAnchor.height);
  if (![targetY, freshY, targetHeight, freshHeight].every(Number.isFinite)) return false;
  const signatureMatch = Boolean(
    targetAnchor.structural_signature
    && freshAnchor.structural_signature
    && targetAnchor.structural_signature === freshAnchor.structural_signature
  );
  const orderMatch = Boolean(
    Number.isFinite(Number(targetAnchor.document_order))
    && Number.isFinite(Number(freshAnchor.document_order))
    && Number(targetAnchor.document_order) === Number(freshAnchor.document_order)
  );
  if (!signatureMatch && !orderMatch) return false;
  return Math.abs(targetY - freshY) <= safeTolerance
    && Math.abs(targetHeight - freshHeight) <= safeTolerance;
}

async function captureResumeContinuityProbe(client, nodeId, {
  format,
  quality,
  padding,
  iframeOwnerNodeId,
  resizeMaxWidth,
  stepTimeoutMs,
  scrollAnchorSelector,
  maxScreenshots,
  scrollAnchorMaxProbeNodes,
  scrollAnchorMinGap,
  viewportTolerance,
  attempt,
  direction
} = {}) {
  const geometry = await withCaptureTimeout(readVisibleCaptureGeometry(client, nodeId, {
    padding,
    iframeOwnerNodeId
  }), {
    label: `resume_geometry_${attempt}`,
    timeoutMs: stepTimeoutMs
  });
  const screenshot = await captureViewportAtomically(
    client,
    createCliplessScreenshotOptions({ format, quality }),
    {
      label: `resume_probe_${attempt}`,
      timeoutMs: stepTimeoutMs
    }
  );
  const viewportBuffer = Buffer.from(screenshot.data || "", "base64");
  const afterViewportState = await withCaptureTimeout(readCaptureViewportState(client), {
    label: `resume_post_viewport_${attempt}`,
    timeoutMs: stepTimeoutMs
  });
  const viewportComparison = compareCaptureViewportState(
    geometry.viewport_state,
    afterViewportState,
    viewportTolerance
  );
  if (!viewportComparison.ok || viewportComparison.browser_window_changed) {
    const error = createViewportDriftError(
      geometry.viewport_state,
      afterViewportState,
      viewportComparison,
      `resume_${attempt}`
    );
    error.capture_operation = screenshot.__capture_telemetry || null;
    throw error;
  }
  const processed = await withCaptureTimeout(cropViewportScreenshotBuffer(viewportBuffer, {
    format,
    quality,
    visibleRect: geometry.resolved.visible_rect,
    viewport: geometry.viewport_state.viewport,
    resizeMaxWidth
  }), {
    label: `resume_crop_${attempt}`,
    timeoutMs: stepTimeoutMs
  });
  const anchorPlan = await collectDomScrollAnchors(client, nodeId, {
    selector: scrollAnchorSelector,
    maxScreenshots,
    maxProbeNodes: scrollAnchorMaxProbeNodes,
    minAnchorGap: scrollAnchorMinGap,
    stepTimeoutMs
  });
  return {
    attempt,
    direction,
    sha256: screenshotHash(processed.buffer),
    geometry,
    anchor_plan: anchorPlan,
    anchor_evidence: resolveAnchorProgressEvidence(anchorPlan, null, viewportTolerance),
    capture_operation: screenshot.__capture_telemetry || null
  };
}

function summarizeResumeProbe(probe, target, matchKind = null, progress = null) {
  return {
    attempt: probe.attempt,
    direction: probe.direction,
    sha256: probe.sha256,
    target_hash_match: probe.sha256 === target?.sha256,
    target_anchor_match: resumeAnchorMatches(
      target?.anchor,
      probe.anchor_plan?.bottom_anchor,
      target?.viewport_tolerance
    ),
    match_kind: matchKind,
    progress,
    anchor: probe.anchor_evidence,
    capture_operation: probe.capture_operation,
    visible_crop: probe.geometry?.resolved?.visible_rect || null
  };
}

async function dispatchResumeWheel(client, probe, deltaY, {
  label,
  stepTimeoutMs
} = {}) {
  const rect = probe?.geometry?.resolved?.visible_rect;
  if (!rect || rect.width < 2 || rect.height < 2) {
    const error = new Error("Resume continuity scroll target is unreadable");
    error.code = "IMAGE_CAPTURE_RESUME_CONTINUITY_UNPROVEN";
    throw error;
  }
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const timeoutMs = Math.min(Math.max(3000, Number(stepTimeoutMs) || 45000), 10000);
  await withCaptureTimeout(client.Input.dispatchMouseEvent({
    type: "mouseMoved",
    x,
    y,
    button: "none"
  }), { label: `${label}_move`, timeoutMs });
  await withCaptureTimeout(client.Input.dispatchMouseEvent({
    type: "mouseWheel",
    x,
    y,
    deltaX: 0,
    deltaY
  }), { label: `${label}_wheel`, timeoutMs });
  return { x, y, delta_y: deltaY };
}

async function restoreResumeContinuity(client, nodeId, {
  target,
  format,
  quality,
  padding,
  iframeOwnerNodeId,
  resizeMaxWidth,
  stepTimeoutMs,
  totalTimeoutMs,
  sequenceStarted,
  scrollAnchorSelector,
  maxScreenshots,
  scrollAnchorMaxProbeNodes,
  scrollAnchorMinGap,
  viewportTolerance,
  wheelDeltaY,
  historicalScrollDeltas = [],
  continuationDeltaY = null,
  scrollDeltaJitter,
  settleMs
} = {}) {
  if (!target?.sha256) {
    const error = new Error("Resume checkpoint has no last confirmed visual position");
    error.code = "IMAGE_CAPTURE_RESUME_CONTINUITY_UNPROVEN";
    throw error;
  }
  target.viewport_tolerance = viewportTolerance;
  const probes = [];
  let attempt = 0;
  let continuityBaseline = null;
  const maxDirectionalAttempts = Math.max(4, Math.max(1, Number(maxScreenshots) || 1) * 2 + 2);

  const takeProbe = async (direction) => {
    assertCaptureTotalBudget(sequenceStarted, totalTimeoutMs, `resume_continuity_${direction}_${attempt + 1}`);
    attempt += 1;
    const probe = await captureResumeContinuityProbe(client, nodeId, {
      format,
      quality,
      padding,
      iframeOwnerNodeId,
      resizeMaxWidth,
      stepTimeoutMs,
      scrollAnchorSelector,
      maxScreenshots,
      scrollAnchorMaxProbeNodes,
      scrollAnchorMinGap,
      viewportTolerance,
      attempt,
      direction
    });
    if (!continuityBaseline) {
      continuityBaseline = probe.geometry.viewport_state;
    } else {
      const comparison = compareCaptureViewportState(
        continuityBaseline,
        probe.geometry.viewport_state,
        viewportTolerance
      );
      if (!comparison.ok || comparison.browser_window_changed) {
        throw createViewportDriftError(
          continuityBaseline,
          probe.geometry.viewport_state,
          comparison,
          `resume_${attempt}`
        );
      }
    }
    return probe;
  };

  const matchProbe = async (probe) => {
    if (probe.sha256 === target.sha256) return { matched: true, kind: "sha256" };
    if (!resumeAnchorMatches(target.anchor, probe.anchor_plan?.bottom_anchor, viewportTolerance)) {
      return { matched: false, kind: null };
    }
    // A structural anchor match is accepted only after an independent fresh
    // read at the same position.  Node ids are deliberately not retained.
    const verification = await takeProbe("anchor_verification");
    const verified = resumeAnchorMatches(
      target.anchor,
      verification.anchor_plan?.bottom_anchor,
      viewportTolerance
    );
    probes.push(summarizeResumeProbe(
      verification,
      target,
      verified ? "anchor_stable_second_read" : null,
      "verification"
    ));
    return { matched: verified, kind: verified ? "anchor_stable" : null, probe: verification };
  };

  let current = await takeProbe("initial");
  let match = await matchProbe(current);
  probes.push(summarizeResumeProbe(current, target, match.kind));
  if (match.probe) current = match.probe;

  const scrollAndProbe = async (direction, deltaY, previous) => {
    await dispatchResumeWheel(client, previous, deltaY, {
      label: `resume_${direction}_${attempt + 1}`,
      stepTimeoutMs
    });
    if (settleMs > 0) await sleep(settleMs);
    const next = await takeProbe(direction);
    const anchorProgress = resolveAnchorProgressEvidence(
      next.anchor_plan,
      previous.anchor_evidence,
      viewportTolerance
    );
    const progressed = next.sha256 !== previous.sha256
      || Boolean(anchorProgress.available && !anchorProgress.stationary);
    const nextMatch = await matchProbe(next);
    probes.push(summarizeResumeProbe(
      next,
      target,
      nextMatch.kind,
      progressed ? "progress" : "no_progress"
    ));
    return {
      probe: nextMatch.probe || next,
      match: nextMatch,
      progressed
    };
  };

  const safeDelta = resolveCoverageSafeScrollDelta({
    baseDelta: wheelDeltaY,
    clipHeight: current.geometry.resolved.visible_rect.height,
    jitter: { ...scrollDeltaJitter, enabled: false }
  });

  if (!match.matched) {
    let noProgress = 0;
    for (let index = 0; index < maxDirectionalAttempts && noProgress < 2; index += 1) {
      const result = await scrollAndProbe("toward_top", -Math.abs(safeDelta.deltaY), current);
      current = result.probe;
      match = result.match;
      if (match.matched) break;
      noProgress = result.progressed ? 0 : noProgress + 1;
    }
  }

  if (!match.matched) {
    let noProgress = 0;
    for (let index = 0; index < maxDirectionalAttempts && noProgress < 2; index += 1) {
      const historicalDelta = Math.abs(Number(historicalScrollDeltas[index]) || 0);
      const replayDelta = historicalDelta > 0
        ? resolveCoverageSafeScrollDelta({
            baseDelta: historicalDelta,
            clipHeight: current.geometry.resolved.visible_rect.height,
            jitter: { ...scrollDeltaJitter, enabled: false }
          }).deltaY
        : safeDelta.deltaY;
      const result = await scrollAndProbe("from_top", Math.abs(replayDelta), current);
      current = result.probe;
      match = result.match;
      if (match.matched) break;
      noProgress = result.progressed ? 0 : noProgress + 1;
    }
  }

  if (!match.matched) {
    const error = new Error("Could not restore the last confirmed CV coverage position after session reacquisition");
    error.code = "IMAGE_CAPTURE_RESUME_CONTINUITY_UNPROVEN";
    error.coverage_incomplete = true;
    error.resume_continuity = {
      verified: false,
      target: sanitizeCoverageCheckpointValue(target),
      probes: [...probes].sort((left, right) => left.attempt - right.attempt)
    };
    throw error;
  }

  const freshAnchorEvidence = resolveAnchorProgressEvidence(
    current.anchor_plan,
    null,
    viewportTolerance
  );
  const checkpointContinuationDelta = Math.abs(Number(continuationDeltaY) || 0);
  const continuationDelta = resolveCoverageSafeScrollDelta({
    baseDelta: checkpointContinuationDelta || wheelDeltaY,
    clipHeight: current.geometry.resolved.visible_rect.height,
    jitter: scrollDeltaJitter
  });
  const physicalScroll = await dispatchResumeWheel(
    client,
    current,
    Math.abs(continuationDelta.deltaY),
    {
      label: "resume_continue_from_confirmed_position",
      stepTimeoutMs
    }
  );
  if (settleMs > 0) await sleep(settleMs);

  return {
    verified: true,
    match_kind: match.kind,
    target: sanitizeCoverageCheckpointValue(target),
    probe_count: probes.length,
    probes: [...probes].sort((left, right) => left.attempt - right.attempt),
    restored_anchor: sanitizeCoverageCheckpointValue(freshAnchorEvidence),
    previous_anchor_evidence: freshAnchorEvidence,
    continuation_scroll: {
      method: "Input.dispatchMouseEvent",
      physically_dispatched: true,
      checkpoint_delta_physically_reissued: checkpointContinuationDelta > 0,
      ...physicalScroll,
      wheel_delta_base_y: continuationDelta.base_delta_y,
      overlap_ratio_target: continuationDelta.min_overlap_ratio ?? scrollDeltaJitter.min_overlap_ratio
    },
    viewport_baseline: current.geometry.viewport_state
  };
}

async function scrollDomAnchorIntoView(client, nodeId, {
  timeoutMs = 10000,
  label = "dom_scroll_anchor"
} = {}) {
  if (client.DOM && typeof client.DOM.scrollIntoViewIfNeeded === "function") {
    return withCaptureTimeout(client.DOM.scrollIntoViewIfNeeded({ nodeId }), { label, timeoutMs });
  }
  if (typeof client.send === "function") {
    return withCaptureTimeout(client.send("DOM.scrollIntoViewIfNeeded", { nodeId }), { label, timeoutMs });
  }
  throw new Error("CDP client does not expose DOM.scrollIntoViewIfNeeded");
}

async function composeScreenshotsForLlm(screenshots = [], {
  basePath,
  pagesPerImage = 3,
  resizeMaxWidth = 1100,
  quality = 72
} = {}) {
  const fileScreenshots = screenshots.filter((item) => item?.file_path);
  if (!basePath || fileScreenshots.length <= 1) {
    return {
      llm_file_paths: fileScreenshots.map((item) => item.file_path),
      llm_screenshots: [],
      llm_total_byte_length: 0,
      llm_original_total_byte_length: 0,
      llm_composition_error: null
    };
  }

  const safePagesPerImage = Math.max(1, Math.min(5, Number(pagesPerImage) || 3));
  const safeWidth = Math.max(700, Math.min(1400, Number(resizeMaxWidth) || 1100));
  const safeQuality = Math.max(45, Math.min(90, Number(quality) || 72));
  const llmScreenshots = [];

  try {
    for (let index = 0; index < fileScreenshots.length; index += safePagesPerImage) {
      const group = fileScreenshots.slice(index, index + safePagesPerImage);
      const prepared = [];
      for (const item of group) {
        const sourceBuffer = fs.readFileSync(item.file_path);
        const { data, info } = await sharp(sourceBuffer, { failOn: "none" })
          .resize({
            width: safeWidth,
            withoutEnlargement: true
          })
          .jpeg({
            quality: safeQuality,
            mozjpeg: true
          })
          .toBuffer({ resolveWithObject: true });
        prepared.push({
          input: data,
          width: info.width,
          height: info.height,
          source_file_path: item.file_path
        });
      }

      const width = Math.max(...prepared.map((item) => item.width), 1);
      const height = prepared.reduce((sum, item) => sum + item.height, 0);
      let top = 0;
      const composites = prepared.map((item) => {
        const layer = {
          input: item.input,
          left: 0,
          top
        };
        top += item.height;
        return layer;
      });
      const outputBuffer = await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: "#ffffff"
        }
      })
        .composite(composites)
        .jpeg({
          quality: safeQuality,
          mozjpeg: true
        })
        .toBuffer();
      const outputPath = filePathForLlmSequence(basePath, llmScreenshots.length);
      fs.writeFileSync(outputPath, outputBuffer);
      llmScreenshots.push({
        index: llmScreenshots.length,
        file_path: outputPath,
        byte_length: outputBuffer.length,
        source_file_paths: prepared.map((item) => item.source_file_path),
        source_page_count: prepared.length,
        width,
        height,
        format: "jpeg",
        mime_type: "image/jpeg"
      });
    }
  } catch (error) {
    return {
      llm_file_paths: fileScreenshots.map((item) => item.file_path),
      llm_screenshots: [],
      llm_total_byte_length: 0,
      llm_original_total_byte_length: fileScreenshots.reduce((sum, item) => sum + (Number(item.byte_length) || 0), 0),
      llm_composition_error: error?.message || String(error)
    };
  }

  return {
    llm_file_paths: llmScreenshots.map((item) => item.file_path),
    llm_screenshots: llmScreenshots,
    llm_total_byte_length: llmScreenshots.reduce((sum, item) => sum + (Number(item.byte_length) || 0), 0),
    llm_original_total_byte_length: fileScreenshots.reduce((sum, item) => sum + (Number(item.byte_length) || 0), 0),
    llm_composition_error: null
  };
}

export async function captureScrolledNodeScreenshots(client, nodeId, {
  filePath,
  format = "png",
  quality,
  padding = 0,
  captureBeyondViewport: requestedCaptureBeyondViewport = false,
  fromSurface: requestedFromSurface = true,
  captureViewport: requestedCaptureViewport = false,
  iframeOwnerNodeId = null,
  maxScreenshots = 6,
  wheelDeltaY = 650,
  settleMs = 900,
  duplicateStopCount = 2,
  skipDuplicateScreenshots = false,
  optimize = false,
  resizeMaxWidth = 0,
  composeForLlm = false,
  llmPagesPerImage = 3,
  llmResizeMaxWidth = 1100,
  llmQuality = 72,
  stepTimeoutMs = 45000,
  totalTimeoutMs = 90000,
  scrollMethod = "dom-anchor-fallback-input",
  scrollAnchorSelector = DEFAULT_SCROLL_ANCHOR_SELECTOR,
  scrollAnchorMaxProbeNodes = 260,
  scrollAnchorMinGap = 180,
  scrollDeltaJitterEnabled = false,
  scrollDeltaJitterMinRatio = 0.65,
  scrollDeltaJitterMaxRatio = 0.9,
  scrollDeltaJitterMinOverlapRatio = 0.2,
  scrollDeltaJitterPreserveCoverage = true,
  scrollDeltaJitterRandom = Math.random,
  stopBoundarySelector = "",
  stopBoundaryTextPatterns = [],
  stopBoundaryMaxProbeNodes = 180,
  stopBoundaryMaxTextLength = 700,
  stopBoundaryTopPadding = 8,
  stopBoundaryMinCaptureHeight = 180,
  requireTerminalProof = true,
  viewportTolerance = 1,
  resumeCheckpoint = null,
  metadata = {}
} = {}) {
  if (!nodeId) throw new Error("captureScrolledNodeScreenshots requires nodeId");
  const sequenceStarted = Date.now();
  const normalizedScrollMethod = normalizeScrollMethod(scrollMethod);
  const maxScreenshotCount = Math.max(1, Number(maxScreenshots) || 1);
  const requiredNoProgressCount = Math.max(2, Number(duplicateStopCount) || 2);
  const scrollDeltaJitter = normalizeScrollDeltaJitter({
    enabled: scrollDeltaJitterEnabled,
    minRatio: scrollDeltaJitterMinRatio,
    maxRatio: scrollDeltaJitterMaxRatio,
    minOverlapRatio: scrollDeltaJitterMinOverlapRatio,
    preserveCoverage: scrollDeltaJitterPreserveCoverage,
    random: scrollDeltaJitterRandom
  });
  // maxScreenshots is a hard cap on unique persisted evidence pages.  The only
  // extra transport attempts are the required terminal no-progress probes.
  const coverageIterationLimit = maxScreenshotCount;
  const maxCaptureIterations = coverageIterationLimit
    + (requireTerminalProof ? requiredNoProgressCount : 0);
  const resumeState = normalizeCoverageResumeCheckpoint(resumeCheckpoint, {
    maxUniqueScreenshots: coverageIterationLimit
  });
  // A new session invalidates prior anchor/no-progress proof.  Preserve the
  // unique-page cap, but grant one anchor-baseline capture plus a fresh
  // terminal-proof window so two independent post-reacquisition no-progress
  // attempts remain possible even when native anchors are available.
  const captureIterationCeiling = maxCaptureIterations
    + (resumeState.used && requireTerminalProof ? requiredNoProgressCount + 1 : 0);
  let anchorPlan = null;
  const anchorPlanHistory = [...resumeState.anchor_plan_history];
  const stopBoundaryEnabled = Boolean(
    normalizeText(stopBoundarySelector)
    || (Array.isArray(stopBoundaryTextPatterns)
      ? stopBoundaryTextPatterns.length
      : stopBoundaryTextPatterns)
  );
  let stopBoundaryPlan = {
    enabled: false,
    ok: false,
    reason: "not_configured",
    nodes: []
  };
  const stopBoundaryChecks = [...resumeState.stop_boundary_checks];
  const screenshots = [...resumeState.screenshots];
  const coverageLedger = [...resumeState.coverage_ledger];
  const viewportEvents = [...resumeState.viewport_events];
  let consecutiveDuplicates = 0;
  let consecutiveNoProgress = 0;
  let previousAnchorEvidence = null;
  let previousHash = resumeState.previous_hash
    || String(screenshots[screenshots.length - 1]?.sha256 || "");
  let captureCount = resumeState.next_capture_index;
  let droppedDuplicateCount = resumeState.dropped_duplicate_count;
  let stopBoundaryResult = null;
  let viewportBaseline = null;
  let coverageComplete = false;
  let terminalReason = null;
  let coverageLimitReached = false;
  let resumeContinuity = resumeState.used ? {
    verified: false,
    target: resumeState.continuity_target,
    checkpoint_pending_scroll_ignored: Boolean(resumeState.current_pending_scroll_metadata)
  } : null;
  let currentScrollMetadata = {
    before_capture: "initial",
    method: "none",
    requested_scroll_method: normalizedScrollMethod,
    anchor_plan: null
  };

  try {
    if (resumeState.used && screenshots.length > 0) {
      resumeContinuity = await restoreResumeContinuity(client, nodeId, {
        target: resumeState.continuity_target,
        format,
        quality,
        padding,
        iframeOwnerNodeId,
        resizeMaxWidth,
        stepTimeoutMs,
        totalTimeoutMs,
        sequenceStarted,
        scrollAnchorSelector,
        maxScreenshots: coverageIterationLimit,
        scrollAnchorMaxProbeNodes,
        scrollAnchorMinGap,
        viewportTolerance,
        wheelDeltaY,
        historicalScrollDeltas: resumeState.coverage_ledger
          .slice(1)
          .map((entry) => {
            const wheelDelta = Math.abs(Number(entry?.scroll?.wheel_delta_y) || 0);
            if (wheelDelta > 0) return wheelDelta;
            return Math.abs(Number(entry?.anchor_evidence?.delta_y) || 0);
          }),
        continuationDeltaY: resumeState.current_pending_scroll_metadata?.wheel_delta_y,
        scrollDeltaJitter,
        settleMs
      });
      previousAnchorEvidence = resumeContinuity.previous_anchor_evidence;
      viewportBaseline = resumeContinuity.viewport_baseline;
      currentScrollMetadata = {
        before_capture: "resume_after_confirmed_position",
        method: "Input.dispatchMouseEvent",
        requested_scroll_method: normalizedScrollMethod,
        wheel_delta_y: resumeContinuity.continuation_scroll.delta_y,
        wheel_delta_base_y: resumeContinuity.continuation_scroll.wheel_delta_base_y,
        overlap_ratio_target: resumeContinuity.continuation_scroll.overlap_ratio_target,
        physically_dispatched: true,
        resume_continuity_verified: true,
        resume_match_kind: resumeContinuity.match_kind,
        checkpoint_pending_scroll_physically_reissued: Boolean(
          resumeContinuity.continuation_scroll.checkpoint_delta_physically_reissued
        ),
        old_pending_delta_used_as_position_proof: false,
        anchor_node_id: null,
        anchor_plan: null
      };
      viewportEvents.push({
        capture_index: resumeState.next_capture_index,
        kind: "resume_continuity_verified",
        match_kind: resumeContinuity.match_kind,
        probe_count: resumeContinuity.probe_count,
        viewport_state: viewportBaseline
      });
    }
    for (let index = resumeState.next_capture_index; index < captureIterationCeiling; index += 1) {
    assertCaptureTotalBudget(sequenceStarted, totalTimeoutMs, `capture_page_${index + 1}`);
    captureCount += 1;
    const captureStarted = Date.now();
    const geometry = await withCaptureTimeout(readVisibleCaptureGeometry(client, nodeId, {
      padding,
      iframeOwnerNodeId
    }), {
      label: `get_capture_geometry_${index + 1}`,
      timeoutMs: stepTimeoutMs
    });
    const geometryElapsedMs = Date.now() - captureStarted;
    const box = geometry.box;
    const clip = withPadding(box.rect, padding);
    if (!viewportBaseline) {
      viewportBaseline = geometry.viewport_state;
      viewportEvents.push({
        capture_index: index,
        kind: "baseline",
        viewport_state: viewportBaseline
      });
    } else {
      const beforeComparison = compareCaptureViewportState(viewportBaseline, geometry.viewport_state, viewportTolerance);
      if (beforeComparison.browser_window_changed) {
        const rebaselineVerification = await verifyCaptureWindowRebaseline(
          client,
          viewportBaseline,
          geometry.viewport_state,
          {
            viewportTolerance,
            stepTimeoutMs,
            captureIndex: index
          }
        );
        if (!rebaselineVerification.verified) {
          const driftError = createViewportDriftError(
            viewportBaseline,
            rebaselineVerification.second_reading || geometry.viewport_state,
            {
              ...beforeComparison,
              rebaseline_verification: rebaselineVerification
            },
            index
          );
          driftError.rebaseline_verification = rebaselineVerification;
          throw driftError;
        }
        viewportEvents.push({
          capture_index: index,
          kind: "verified_window_rebaseline",
          previous_baseline: viewportBaseline,
          viewport_state: rebaselineVerification.second_reading,
          comparison: beforeComparison,
          verification: rebaselineVerification
        });
        viewportBaseline = rebaselineVerification.second_reading;
      } else if (!beforeComparison.ok) {
        throw createViewportDriftError(viewportBaseline, geometry.viewport_state, beforeComparison, index);
      }
    }
    let visibleStopBoundary = null;
    if (stopBoundaryEnabled) {
      stopBoundaryPlan = await collectStopBoundaryNodes(client, nodeId, {
        selector: stopBoundarySelector,
        textPatterns: stopBoundaryTextPatterns,
        maxProbeNodes: stopBoundaryMaxProbeNodes,
        maxTextLength: stopBoundaryMaxTextLength,
        stepTimeoutMs
      });
      stopBoundaryChecks.push({
        capture_index: index,
        ok: Boolean(stopBoundaryPlan.ok),
        reason: stopBoundaryPlan.reason || null,
        discovered_node_count: stopBoundaryPlan.discovered_node_count || 0,
        probed_node_count: stopBoundaryPlan.probed_node_count || 0,
        match_count: stopBoundaryPlan.match_count || 0,
        elapsed_ms: stopBoundaryPlan.elapsed_ms || 0
      });
      visibleStopBoundary = await resolveVisibleStopBoundary(
        client,
        stopBoundaryPlan,
        geometry.resolved.visible_rect,
        {
        topPadding: stopBoundaryTopPadding,
        minCaptureHeight: stopBoundaryMinCaptureHeight,
        stepTimeoutMs,
        viewport: geometry.viewport_state.viewport,
        coordinateSpace: geometry.resolved.coordinate_space,
        iframeOwnerRect: geometry.iframe_owner_rect || null
      });
    }
    if (visibleStopBoundary?.action === "stop_before_capture") {
      stopBoundaryResult = visibleStopBoundary;
      coverageComplete = screenshots.length > 0;
      terminalReason = coverageComplete
        ? (visibleStopBoundary.reason || "stop_boundary_before_capture")
        : "stop_boundary_before_first_capture";
      break;
    }
    const effectiveClip = visibleStopBoundary?.adjusted_clip || clip;
    const effectiveCaptureViewport = false;
    const resolvedCrop = visibleStopBoundary?.adjusted_clip
      ? {
          ...geometry.resolved,
          requested_rect: effectiveClip,
          visible_rect: effectiveClip,
          visible_ratio: 1
        }
      : geometry.resolved;
    const captureOptions = createCliplessScreenshotOptions({ format, quality });
    const screenshot = await captureViewportAtomically(client, captureOptions, {
      label: `capture_screenshot_${index + 1}`,
      timeoutMs: stepTimeoutMs
    });
    const viewportBuffer = Buffer.from(screenshot.data || "", "base64");
    const afterViewportState = await withCaptureTimeout(readCaptureViewportState(client), {
      label: `get_post_capture_viewport_${index + 1}`,
      timeoutMs: stepTimeoutMs
    });
    const viewportComparison = compareCaptureViewportState(
      geometry.viewport_state,
      afterViewportState,
      viewportTolerance
    );
    if (!viewportComparison.ok || viewportComparison.browser_window_changed) {
      const driftError = createViewportDriftError(
        geometry.viewport_state,
        afterViewportState,
        viewportComparison,
        index
      );
      driftError.capture_operation = screenshot.__capture_telemetry || null;
      driftError.target_geometry = {
        node_rect: geometry.box.rect,
        iframe_owner_rect: geometry.iframe_owner_rect || null
      };
      throw driftError;
    }
    const localProcessingStartedAt = Date.now();
    const processed = await withCaptureTimeout(cropViewportScreenshotBuffer(viewportBuffer, {
      format,
      quality,
      visibleRect: resolvedCrop.visible_rect,
      viewport: geometry.viewport_state.viewport,
      resizeMaxWidth
    }), {
      label: `crop_screenshot_${index + 1}`,
      timeoutMs: stepTimeoutMs
    });
    const localProcessingElapsedMs = Date.now() - localProcessingStartedAt;
    const buffer = processed.buffer;
    const hash = screenshotHash(buffer);
    const duplicateOfPrevious = previousHash && previousHash === hash;
    const isNewUniqueScreenshot = !screenshots.some((item) => item?.sha256 === hash);
    if (duplicateOfPrevious) {
      consecutiveDuplicates += 1;
    } else {
      consecutiveDuplicates = 0;
    }

    // Re-query after every preceding scroll.  Node ids from an earlier DOM
    // snapshot are never reused as terminal-coverage evidence.
    anchorPlan = await collectDomScrollAnchors(client, nodeId, {
      selector: scrollAnchorSelector,
      maxScreenshots: coverageIterationLimit,
      maxProbeNodes: scrollAnchorMaxProbeNodes,
      minAnchorGap: scrollAnchorMinGap,
      stepTimeoutMs
    });
    const anchorPlanSummary = {
      capture_index: index,
      phase: "after_capture",
      ok: Boolean(anchorPlan.ok),
      reason: anchorPlan.reason || null,
      discovered_node_count: anchorPlan.discovered_node_count || 0,
      measured_node_count: anchorPlan.measured_node_count || 0,
      anchor_count: anchorPlan.anchor_count || 0,
      bottom_anchor: anchorPlan.bottom_anchor || null,
      elapsed_ms: anchorPlan.elapsed_ms || 0
    };
    anchorPlanHistory.push(anchorPlanSummary);
    const anchorEvidence = resolveAnchorProgressEvidence(
      anchorPlan,
      previousAnchorEvidence,
      viewportTolerance
    );
    const noProgress = Boolean(
      duplicateOfPrevious
      && (!anchorEvidence.available || anchorEvidence.stationary)
    );
    consecutiveNoProgress = noProgress ? consecutiveNoProgress + 1 : 0;
    previousAnchorEvidence = anchorEvidence;
    const visibleCrop = resolvedCrop?.visible_rect || geometry.resolved.visible_rect;
    const overlapWithPrevious = resolveCoverageOverlap(
      coverageLedger[coverageLedger.length - 1] || null,
      visibleCrop,
      currentScrollMetadata,
      anchorEvidence
    );

    const coverageEntry = {
      capture_index: index,
      captured_at: nowIso(),
      capture_operation_id: screenshot.__capture_telemetry?.operation_id || null,
      connection_epoch: screenshot.__capture_telemetry?.connection_epoch ?? null,
      scroll_attempt: index,
      scroll: currentScrollMetadata,
      node_rect: box.rect,
      iframe_owner_rect: geometry.iframe_owner_rect || null,
      target_geometry: {
        node_rect: box.rect,
        iframe_owner_rect: geometry.iframe_owner_rect || null,
        coordinate_space: resolvedCrop?.coordinate_space || "viewport"
      },
      requested_crop: effectiveClip,
      visible_crop: visibleCrop,
      pixel_crop: processed.pixel_crop || null,
      crop_geometry: {
        requested_crop: effectiveClip,
        visible_crop: visibleCrop,
        pixel_crop: processed.pixel_crop || null
      },
      image_dimensions: {
        viewport_width: processed.image_width || null,
        viewport_height: processed.image_height || null,
        scale_x: processed.scale_x || null,
        scale_y: processed.scale_y || null
      },
      coordinate_space: resolvedCrop?.coordinate_space || "viewport",
      overlap_ratio_target: scrollDeltaJitter.min_overlap_ratio,
      sha256: hash,
      duplicate_of_previous: Boolean(duplicateOfPrevious),
      new_unique_screenshot: isNewUniqueScreenshot,
      visual_duplicate_count: consecutiveDuplicates,
      no_progress: noProgress,
      consecutive_no_progress: consecutiveNoProgress,
      overlap_with_previous: overlapWithPrevious,
      viewport_before: geometry.viewport_state,
      viewport_after: afterViewportState,
      viewport_comparison: viewportComparison,
      capture_operation: screenshot.__capture_telemetry || null,
      timing: {
        geometry_elapsed_ms: geometryElapsedMs,
        queue_elapsed_ms: screenshot.__capture_telemetry?.queue_elapsed_ms ?? null,
        transport_elapsed_ms: screenshot.__capture_telemetry?.transport_elapsed_ms ?? null,
        local_processing_elapsed_ms: localProcessingElapsedMs,
        total_elapsed_ms: Date.now() - captureStarted
      },
      anchor_evidence: anchorEvidence,
      anchor_plan: anchorPlanSummary,
      stop_boundary: visibleStopBoundary || null
    };
    let outputPath = null;
    if (duplicateOfPrevious && skipDuplicateScreenshots) {
      droppedDuplicateCount += 1;
    } else if (
      isNewUniqueScreenshot
      && new Set(screenshots.map((item) => item?.sha256).filter(Boolean)).size >= coverageIterationLimit
    ) {
      coverageLimitReached = true;
    } else {
      outputPath = filePath ? filePathForSequence(filePath, screenshots.length, format) : null;
      if (outputPath) {
        fs.writeFileSync(outputPath, buffer);
      }

      screenshots.push({
        index: screenshots.length,
        capture_index: index,
        source: "image",
        captured_at: nowIso(),
        node_id: nodeId,
        format,
        mime_type: `image/${format === "jpeg" ? "jpeg" : "png"}`,
        byte_length: buffer.length,
        original_byte_length: processed.original_byte_length || processed.viewport_byte_length || viewportBuffer.length,
        viewport_byte_length: viewportBuffer.length,
        optimized: true,
        optimization_error: processed.optimization_error || null,
        elapsed_ms: Date.now() - captureStarted,
        file_path: outputPath,
        sha256: hash,
        duplicate_of_previous: Boolean(duplicateOfPrevious),
        clip: effectiveClip,
        crop: resolvedCrop ? {
          ...resolvedCrop,
          pixel_crop: processed.pixel_crop || null,
          image_width: processed.image_width || null,
          image_height: processed.image_height || null,
          scale_x: processed.scale_x || null,
          scale_y: processed.scale_y || null
        } : null,
        capture_viewport: effectiveCaptureViewport,
        browser_clip_used: false,
        capture_beyond_viewport: false,
        node_rect: box.rect,
        iframe_owner_rect: geometry.iframe_owner_rect || null,
        scroll: currentScrollMetadata,
        stop_boundary: visibleStopBoundary || null,
        viewport_before: geometry.viewport_state,
        viewport_after: afterViewportState,
        viewport_comparison: viewportComparison,
        capture_operation: screenshot.__capture_telemetry || null,
        timing: {
          geometry_elapsed_ms: geometryElapsedMs,
          queue_elapsed_ms: screenshot.__capture_telemetry?.queue_elapsed_ms ?? null,
          transport_elapsed_ms: screenshot.__capture_telemetry?.transport_elapsed_ms ?? null,
          local_processing_elapsed_ms: localProcessingElapsedMs,
          total_elapsed_ms: Date.now() - captureStarted
        },
        metadata
      });
    }
    coverageEntry.accepted_for_coverage = !coverageLimitReached;
    coverageLedger.push(coverageEntry);

    if (coverageLimitReached) {
      terminalReason = "coverage_limit_reached_without_terminal_proof";
      break;
    }

    if (visibleStopBoundary?.action === "capture_then_stop") {
      stopBoundaryResult = visibleStopBoundary;
      coverageComplete = true;
      terminalReason = visibleStopBoundary.reason || "stop_boundary_after_capture";
      break;
    }

    previousHash = hash;
    if (
      consecutiveNoProgress >= requiredNoProgressCount
    ) {
      coverageComplete = true;
      terminalReason = anchorEvidence.available
        ? "consecutive_image_and_anchor_no_progress"
        : "consecutive_image_no_progress_anchor_unavailable";
      break;
    }

    if (index < captureIterationCeiling - 1) {
      assertCaptureTotalBudget(sequenceStarted, totalTimeoutMs, `scroll_after_page_${index + 1}`);
      if (normalizedScrollMethod === "dom-anchor") {
        const nextAnchor = anchorPlan?.anchors?.[index + 1] || null;
        if (!nextAnchor?.node_id) break;
        await scrollDomAnchorIntoView(client, nextAnchor.node_id, {
          label: `scroll_dom_anchor_${index + 1}`,
          timeoutMs: Math.min(Math.max(3000, Number(stepTimeoutMs) || 45000), 10000)
        });
        currentScrollMetadata = {
          before_capture: `dom_anchor_${index + 1}`,
          method: "DOM.scrollIntoViewIfNeeded",
          requested_scroll_method: normalizedScrollMethod,
          anchor_node_id: nextAnchor.node_id,
          anchor_y: nextAnchor.y,
          anchor_height: nextAnchor.height,
          anchor_plan: anchorPlanHistory[anchorPlanHistory.length - 1] || null
        };
      } else {
        const visibleRect = resolvedCrop?.visible_rect || geometry.resolved.visible_rect;
        const x = visibleRect.x + visibleRect.width / 2;
        const y = visibleRect.y + visibleRect.height / 2;
        const scrollDelta = resolveCoverageSafeScrollDelta({
          baseDelta: wheelDeltaY,
          clipHeight: visibleRect.height,
          jitter: scrollDeltaJitter
        });
        await withCaptureTimeout(client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" }), {
          label: `scroll_mouse_move_${index + 1}`,
          timeoutMs: Math.min(Math.max(3000, Number(stepTimeoutMs) || 45000), 10000)
        });
        await withCaptureTimeout(client.Input.dispatchMouseEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY: scrollDelta.deltaY
        }), {
          label: `scroll_wheel_${index + 1}`,
          timeoutMs: Math.min(Math.max(3000, Number(stepTimeoutMs) || 45000), 10000)
        });
        currentScrollMetadata = {
          before_capture: `wheel_down_${index + 1}`,
          method: "Input.dispatchMouseEvent",
          requested_scroll_method: normalizedScrollMethod,
          wheel_delta_y: scrollDelta.deltaY,
          wheel_delta_base_y: scrollDelta.base_delta_y,
          wheel_delta_jitter: scrollDelta.jittered ? scrollDelta : null,
          overlap_ratio_target: scrollDelta.min_overlap_ratio ?? scrollDeltaJitter.min_overlap_ratio,
          anchor_plan: anchorPlanHistory[anchorPlanHistory.length - 1] || null
        };
      }
      if (settleMs > 0) await sleep(settleMs);
    }
    }
  } catch (error) {
    const captureError = error instanceof Error ? error : new Error(String(error));
    captureError.capture_checkpoint = createCoverageCheckpoint({
      screenshots,
      coverageLedger,
      anchorPlanHistory,
      stopBoundaryChecks,
      viewportEvents,
      previousHash,
      droppedDuplicateCount,
      currentScrollMetadata,
      maxUniqueScreenshots: coverageIterationLimit,
      format,
      filePath,
      sourceCheckpointId: resumeState.checkpoint_id,
      resumeContinuity: captureError.resume_continuity || resumeContinuity
    });
    throw captureError;
  }

  if (!coverageComplete && !requireTerminalProof && !coverageLimitReached) {
    coverageComplete = true;
    terminalReason = "terminal_proof_not_required";
  }
  if (!terminalReason) {
    terminalReason = coverageLimitReached
      ? "coverage_limit_reached_without_terminal_proof"
      : "capture_iteration_limit_without_terminal_proof";
  }

  let llmComposition;
  try {
    llmComposition = coverageComplete && composeForLlm
      ? await withCaptureTimeout(composeScreenshotsForLlm(screenshots, {
          basePath: filePath,
          pagesPerImage: llmPagesPerImage,
          resizeMaxWidth: llmResizeMaxWidth,
          quality: llmQuality
        }), {
          label: "compose_llm_screenshots",
          timeoutMs: stepTimeoutMs
        })
      : {
          llm_file_paths: coverageComplete
            ? screenshots.map((item) => item.file_path).filter(Boolean)
            : [],
          llm_screenshots: [],
          llm_total_byte_length: 0,
          llm_original_total_byte_length: 0,
          llm_composition_error: null
        };
  } catch (error) {
    const captureError = error instanceof Error ? error : new Error(String(error));
    captureError.capture_checkpoint = createCoverageCheckpoint({
      screenshots,
      coverageLedger,
      anchorPlanHistory,
      stopBoundaryChecks,
      viewportEvents,
      previousHash,
      droppedDuplicateCount,
      currentScrollMetadata,
      maxUniqueScreenshots: coverageIterationLimit,
      format,
      filePath,
      sourceCheckpointId: resumeState.checkpoint_id,
      resumeContinuity
    });
    throw captureError;
  }

  return {
    schema_version: 1,
    ok: coverageComplete,
    source: "image-scroll-sequence",
    captured_at: nowIso(),
    node_id: nodeId,
    resumed_from_checkpoint: resumeState.used,
    resume_checkpoint_id: resumeState.checkpoint_id,
    resume_confirmed_screenshot_count: resumeState.screenshots.length,
    resume_confirmed_ledger_count: resumeState.coverage_ledger.length,
    resume_continuity: sanitizeCoverageCheckpointValue(resumeContinuity),
    elapsed_ms: Date.now() - sequenceStarted,
    capture_count: captureCount,
    screenshot_count: screenshots.length,
    unique_screenshot_count: new Set(screenshots.map((item) => item.sha256)).size,
    duplicate_screenshot_count: captureCount - new Set(screenshots.map((item) => item.sha256)).size,
    dropped_duplicate_count: droppedDuplicateCount,
    coverage_complete: coverageComplete,
    coverage_terminal_reason: terminalReason,
    coverage_limit_reached: coverageLimitReached,
    coverage_required_no_progress_count: requiredNoProgressCount,
    coverage_iteration_limit: coverageIterationLimit,
    capture_iteration_limit: captureIterationCeiling,
    base_capture_iteration_limit: maxCaptureIterations,
    error_code: coverageComplete ? null : "IMAGE_CAPTURE_COVERAGE_INCOMPLETE",
    error: coverageComplete
      ? null
      : "CV image capture reached its safety limit without terminal coverage proof",
    total_byte_length: screenshots.reduce((sum, item) => sum + (Number(item.byte_length) || 0), 0),
    original_total_byte_length: screenshots.reduce((sum, item) => sum + (Number(item.original_byte_length) || 0), 0),
    llm_file_paths: llmComposition.llm_file_paths,
    llm_screenshot_count: llmComposition.llm_file_paths.length,
    llm_total_byte_length: llmComposition.llm_total_byte_length,
    llm_original_total_byte_length: llmComposition.llm_original_total_byte_length,
    llm_composition_error: llmComposition.llm_composition_error,
    llm_screenshots: llmComposition.llm_screenshots,
    optimization: {
      enabled: Boolean(optimize),
      resize_max_width: Math.max(0, Number(resizeMaxWidth) || 0),
      capture_viewport: false,
      requested_capture_viewport: Boolean(requestedCaptureViewport),
      format,
      quality: quality ?? null,
      llm_compose_enabled: Boolean(composeForLlm),
      llm_pages_per_image: Math.max(1, Math.min(5, Number(llmPagesPerImage) || 3)),
      llm_resize_max_width: Math.max(0, Number(llmResizeMaxWidth) || 0),
      llm_quality: llmQuality ?? null,
      step_timeout_ms: Math.max(0, Number(stepTimeoutMs) || 0),
      total_timeout_ms: Math.max(0, Number(totalTimeoutMs) || 0),
      scroll_method: normalizedScrollMethod,
      requested_max_screenshots: maxScreenshotCount,
      effective_max_screenshots: coverageIterationLimit,
      capture_iteration_limit: captureIterationCeiling,
      base_capture_iteration_limit: maxCaptureIterations,
      require_terminal_proof: Boolean(requireTerminalProof),
      required_no_progress_count: requiredNoProgressCount,
      resumed_from_checkpoint: resumeState.used,
      resume_checkpoint_id: resumeState.checkpoint_id,
      browser_clip_used: false,
      capture_beyond_viewport: false,
      requested_capture_beyond_viewport: Boolean(requestedCaptureBeyondViewport),
      requested_from_surface: Boolean(requestedFromSurface),
      scroll_anchor_selector: scrollAnchorSelector,
      scroll_anchor_max_probe_nodes: Math.max(1, Number(scrollAnchorMaxProbeNodes) || 260),
      scroll_anchor_min_gap: Math.max(0, Number(scrollAnchorMinGap) || 0),
      scroll_delta_jitter: {
        enabled: scrollDeltaJitter.enabled,
        min_ratio: scrollDeltaJitter.min_ratio,
        max_ratio: scrollDeltaJitter.max_ratio,
        min_overlap_ratio: scrollDeltaJitter.min_overlap_ratio,
        preserve_coverage: scrollDeltaJitter.preserve_coverage
      }
    },
    scroll_anchor_plan: anchorPlan,
    scroll_anchor_plan_history: anchorPlanHistory,
    stop_boundary_plan: stopBoundaryPlan,
    stop_boundary_checks: stopBoundaryChecks,
    stop_boundary_result: stopBoundaryResult,
    coverage_ledger: coverageLedger,
    coverage_checkpoint: coverageComplete
      ? null
      : createCoverageCheckpoint({
          screenshots,
          coverageLedger,
          anchorPlanHistory,
          stopBoundaryChecks,
          viewportEvents,
          previousHash,
          droppedDuplicateCount,
          currentScrollMetadata,
          maxUniqueScreenshots: coverageIterationLimit,
          format,
          filePath,
          sourceCheckpointId: resumeState.checkpoint_id,
          resumeContinuity
        }),
    viewport_baseline: viewportBaseline,
    viewport_events: viewportEvents,
    file_paths: screenshots.map((item) => item.file_path).filter(Boolean),
    screenshots,
    metadata
  };
}

export async function captureCandidateEvidence(client, {
  nodeId,
  domain = "unknown",
  source = "dom",
  screenshotPath,
  includeHtml = true,
  includeScreenshot = false,
  screenshotMode = "scroll",
  screenshotOptions = {},
  metadata = {}
} = {}) {
  if (!nodeId) throw new Error("captureCandidateEvidence requires nodeId");
  const evidence = {
    schema_version: 1,
    domain: normalizeText(domain) || "unknown",
    source,
    captured_at: nowIso(),
    node_id: nodeId,
    html: null,
    image: null,
    metadata
  };
  if (includeHtml) {
    evidence.html = await captureNodeHtml(client, nodeId, {
      domain,
      source: "dom",
      metadata
    });
  }
  if (includeScreenshot) {
    evidence.image = screenshotMode === "single"
      ? await captureNodeScreenshot(client, nodeId, {
          ...screenshotOptions,
          filePath: screenshotPath,
          metadata: {
            ...metadata,
            capture_mode: "single_visible_clip"
          }
        })
      : await captureScrolledNodeScreenshots(client, nodeId, {
          ...screenshotOptions,
          filePath: screenshotPath,
          metadata: {
            ...metadata,
            capture_mode: "scroll_sequence"
          }
        });
  }
  return evidence;
}
