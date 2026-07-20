import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  captureCandidateEvidence,
  captureNodeHtml,
  captureNodeScreenshot,
  captureScrolledNodeScreenshots,
  captureViewportScreenshot
} from "./core/capture/index.js";

const DEFAULT_VIEWPORT_BUFFER = await sharp({
  create: {
    width: 600,
    height: 400,
    channels: 3,
    background: "#f8fafc"
  }
}).png().toBuffer();

function createFakeClient() {
  const calls = [];
  return {
    calls,
    DOM: {
      async getAttributes({ nodeId }) {
        calls.push(["DOM.getAttributes", nodeId]);
        return {
          attributes: ["data-id", "candidate-1", "class", "dialog-wrap active"]
        };
      },
      async getOuterHTML({ nodeId }) {
        calls.push(["DOM.getOuterHTML", nodeId]);
        return {
          outerHTML: `<section data-id="candidate-1"><h2>候选人</h2><p>硕士 5年经验 TypeScript</p></section>`
        };
      },
      async getBoxModel({ nodeId }) {
        calls.push(["DOM.getBoxModel", nodeId]);
        return {
          model: {
            border: [10, 20, 210, 20, 210, 120, 10, 120]
          }
        };
      }
    },
    Page: {
      async getLayoutMetrics() {
        calls.push(["Page.getLayoutMetrics"]);
        return {
          cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 300, clientHeight: 200 },
          cssVisualViewport: {
            offsetX: 0,
            offsetY: 0,
            pageX: 0,
            pageY: 0,
            clientWidth: 300,
            clientHeight: 200,
            scale: 1,
            zoom: 1
          }
        };
      },
      async captureScreenshot(params) {
        calls.push(["Page.captureScreenshot", params]);
        return {
          data: DEFAULT_VIEWPORT_BUFFER.toString("base64")
        };
      }
    },
    Browser: {
      async getWindowForTarget() {
        calls.push(["Browser.getWindowForTarget"]);
        return {
          windowId: 1,
          bounds: { left: 0, top: 0, width: 500, height: 400, windowState: "normal" }
        };
      }
    },
    Input: {
      async dispatchMouseEvent(params) {
        calls.push(["Input.dispatchMouseEvent", params.type]);
      }
    }
  };
}

function createImageSequenceClient(buffers = []) {
  const client = createFakeClient();
  let index = 0;
  client.Page.captureScreenshot = async (params) => {
    client.calls.push(["Page.captureScreenshot", params]);
    const buffer = buffers[Math.min(index, buffers.length - 1)] || DEFAULT_VIEWPORT_BUFFER;
    index += 1;
    return {
      data: buffer.toString("base64")
    };
  };
  return client;
}

async function testCaptureNodeHtml() {
  const client = createFakeClient();
  const captured = await captureNodeHtml(client, 7, {
    domain: "recommend",
    metadata: { selector: ".dialog-wrap.active" }
  });
  assert.equal(captured.domain, "recommend");
  assert.equal(captured.node_id, 7);
  assert.equal(captured.attributes["data-id"], "candidate-1");
  assert.equal(captured.text.includes("TypeScript"), true);
  assert.equal(captured.outer_html_length > 0, true);
}

async function testCaptureNodeScreenshot() {
  const client = createFakeClient();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "node.png");
  const captured = await captureNodeScreenshot(client, 8, {
    filePath,
    padding: 5
  });
  assert.equal(captured.source, "image");
  assert.equal(captured.file_path, filePath);
  assert.equal(captured.byte_length > 0, true);
  assert.equal(captured.clip.x, 5);
  assert.equal(captured.clip.y, 15);
  assert.equal(captured.browser_clip_used, false);
  assert.equal(captured.capture_beyond_viewport, false);
  const screenshotCall = client.calls.find(([method]) => method === "Page.captureScreenshot");
  assert.equal("clip" in screenshotCall[1], false);
  assert.equal(screenshotCall[1].captureBeyondViewport, false);
  assert.equal(screenshotCall[1].fromSurface, true);
  assert.equal(fs.existsSync(filePath), true);
  const savedMetadata = await sharp(filePath).metadata();
  assert.deepEqual(
    { width: savedMetadata.width, height: savedMetadata.height },
    { width: 420, height: 220 },
    "the persisted image must be the local crop, not the 600x400 viewport capture"
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureViewportScreenshot() {
  const client = createFakeClient();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "viewport.png");
  const captured = await captureViewportScreenshot(client, {
    metadata: { reason: "empty-list-visual-check" }
  });
  assert.equal(captured.source, "viewport-image");
  assert.equal(captured.file_path, null);
  assert.equal(captured.persistence, "forbidden_uncropped_viewport");
  assert.equal(captured.byte_length, DEFAULT_VIEWPORT_BUFFER.length);
  assert.equal(captured.capture_beyond_viewport, false);
  assert.equal(fs.existsSync(filePath), false, "an uncropped viewport must never be persisted");
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureCandidateEvidence() {
  const client = createFakeClient();
  const evidence = await captureCandidateEvidence(client, {
    nodeId: 9,
    domain: "chat",
    includeHtml: true,
    includeScreenshot: false
  });
  assert.equal(evidence.domain, "chat");
  assert.equal(evidence.html.text.includes("硕士"), true);
  assert.equal(evidence.image, null);
}

async function testCaptureCandidateEvidenceScrollScreenshotDefault() {
  const client = createFakeClient();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "candidate.png");
  const evidence = await captureCandidateEvidence(client, {
    nodeId: 10,
    domain: "recommend",
    includeHtml: false,
    includeScreenshot: true,
    screenshotPath: filePath,
    screenshotOptions: {
      captureViewport: true,
      maxScreenshots: 2,
      duplicateStopCount: 3,
      requireTerminalProof: false
    }
  });
  assert.equal(evidence.image.source, "image-scroll-sequence");
  assert.equal(evidence.image.screenshot_count, 2);
  assert.equal(evidence.image.file_paths.length, 2);
  assert.equal(evidence.image.optimization.capture_viewport, false);
  assert.equal(evidence.image.optimization.requested_capture_viewport, true);
  assert.equal(evidence.image.screenshots.every((item) => item.capture_viewport === false), true);
  for (const persistedPath of evidence.image.file_paths) {
    const metadata = await sharp(persistedPath).metadata();
    assert.deepEqual(
      { width: metadata.width, height: metadata.height },
      { width: 400, height: 200 },
      "generic callers must be unable to persist the 600x400 uncropped viewport"
    );
  }
  assert.equal(client.calls.some(([method]) => method === "Input.dispatchMouseEvent"), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureScrolledNodeScreenshotsSkipsDuplicateTail() {
  const client = createFakeClient();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "candidate.jpg");
  const evidence = await captureScrolledNodeScreenshots(client, 11, {
    filePath,
    format: "jpeg",
    quality: 72,
    maxScreenshots: 3,
    duplicateStopCount: 1,
    skipDuplicateScreenshots: true,
    settleMs: 0
  });
  assert.equal(evidence.capture_count, 3);
  assert.equal(evidence.screenshot_count, 1);
  assert.equal(evidence.dropped_duplicate_count, 2);
  assert.equal(evidence.coverage_complete, true);
  assert.equal(evidence.coverage_terminal_reason, "consecutive_image_no_progress_anchor_unavailable");
  assert.equal(evidence.file_paths.length, 1);
  assert.equal(path.extname(evidence.file_paths[0]), ".jpg");
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureScrolledNodeScreenshotsComposesAllPagesForLlm() {
  const buffers = await Promise.all([
    "#ffffff",
    "#f1f5f9",
    "#e0f2fe",
    "#dcfce7",
    "#fef3c7"
  ].map((background) => sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background
    }
  }).jpeg({ quality: 80 }).toBuffer()));
  const client = createImageSequenceClient(buffers);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "candidate.jpg");
  const evidence = await captureScrolledNodeScreenshots(client, 12, {
    filePath,
    format: "jpeg",
    quality: 72,
    maxScreenshots: 5,
    duplicateStopCount: 10,
    skipDuplicateScreenshots: false,
    composeForLlm: true,
    llmPagesPerImage: 2,
    llmResizeMaxWidth: 1100,
    llmQuality: 72,
    requireTerminalProof: false,
    settleMs: 0
  });
  assert.equal(evidence.screenshot_count, 5);
  assert.equal(evidence.llm_screenshot_count, 3);
  assert.equal(evidence.llm_file_paths.length, 3);
  const representedSourcePaths = evidence.llm_screenshots.flatMap((item) => item.source_file_paths);
  assert.deepEqual(representedSourcePaths, evidence.file_paths);
  assert.equal(new Set(representedSourcePaths).size, evidence.file_paths.length);
  assert.equal(evidence.llm_screenshots.reduce((sum, item) => sum + item.source_page_count, 0), evidence.screenshot_count);
  assert.equal(evidence.llm_file_paths.every((item) => fs.existsSync(item)), true);
  assert.equal(evidence.llm_total_byte_length > 0, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureScrolledNodeScreenshotsCanUseDomAnchors() {
  const buffers = await Promise.all([
    "#fff7ed",
    "#ecfeff",
    "#f0fdf4"
  ].map((background) => sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background
    }
  }).jpeg({ quality: 80 }).toBuffer()));
  const client = createImageSequenceClient(buffers);
  client.DOM.querySelectorAll = async ({ nodeId, selector }) => {
    client.calls.push(["DOM.querySelectorAll", nodeId, selector]);
    return { nodeIds: [21, 22, 23, 24, 25] };
  };
  client.DOM.scrollIntoViewIfNeeded = async ({ nodeId }) => {
    client.calls.push(["DOM.scrollIntoViewIfNeeded", nodeId]);
  };
  client.DOM.getBoxModel = async ({ nodeId }) => {
    client.calls.push(["DOM.getBoxModel", nodeId]);
    const y = nodeId >= 21 ? 20 + (nodeId - 21) * 260 : 20;
    return {
      model: {
        border: [10, y, 210, y, 210, y + 120, 10, y + 120]
      }
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "candidate.jpg");
  const evidence = await captureScrolledNodeScreenshots(client, 20, {
    filePath,
    format: "jpeg",
    quality: 72,
    maxScreenshots: 3,
    duplicateStopCount: 10,
    skipDuplicateScreenshots: false,
    scrollMethod: "dom-anchor",
    requireTerminalProof: false,
    settleMs: 0
  });
  assert.equal(evidence.screenshot_count, 3);
  assert.equal(evidence.scroll_anchor_plan.ok, true);
  assert.equal(evidence.scroll_anchor_plan_history.length, 3);
  assert.equal(evidence.coverage_ledger.every((item) => item.anchor_evidence.available), true);
  assert.equal(client.calls.some(([method]) => method === "DOM.scrollIntoViewIfNeeded"), true);
  assert.equal(client.calls.some(([method]) => method === "Input.dispatchMouseEvent"), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureScrolledNodeScreenshotsFallsBackAfterNoopDomAnchorDuplicate() {
  const buffers = await Promise.all([
    "#ffffff",
    "#ffffff",
    "#dcfce7"
  ].map((background) => sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background
    }
  }).jpeg({ quality: 80 }).toBuffer()));
  const client = createImageSequenceClient(buffers);
  client.DOM.querySelectorAll = async ({ nodeId, selector }) => {
    client.calls.push(["DOM.querySelectorAll", nodeId, selector]);
    return { nodeIds: [31, 32] };
  };
  client.DOM.scrollIntoViewIfNeeded = async ({ nodeId }) => {
    client.calls.push(["DOM.scrollIntoViewIfNeeded", nodeId]);
  };
  client.DOM.getBoxModel = async ({ nodeId }) => {
    client.calls.push(["DOM.getBoxModel", nodeId]);
    const y = nodeId >= 31 ? 20 + (nodeId - 31) * 260 : 20;
    return {
      model: {
        border: [10, y, 210, y, 210, y + 120, 10, y + 120]
      }
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "candidate.jpg");
  const evidence = await captureScrolledNodeScreenshots(client, 30, {
    filePath,
    format: "jpeg",
    quality: 72,
    maxScreenshots: 3,
    duplicateStopCount: 1,
    skipDuplicateScreenshots: true,
    scrollMethod: "dom-anchor-fallback-input",
    settleMs: 0
  });
  assert.equal(evidence.capture_count, 5);
  assert.equal(evidence.screenshot_count, 2);
  assert.equal(evidence.dropped_duplicate_count, 3);
  assert.equal(evidence.coverage_complete, true);
  assert.equal(evidence.file_paths.length, 2);
  assert.equal(client.calls.some(([method]) => method === "Input.dispatchMouseEvent"), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureScrolledNodeScreenshotsUsesCoverageSafeScrollJitter() {
  const client = createFakeClient();
  const wheelEvents = [];
  client.Input.dispatchMouseEvent = async (params) => {
    client.calls.push(["Input.dispatchMouseEvent", params.type, params]);
    if (params.type === "mouseWheel") wheelEvents.push(params);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "candidate.jpg");
  const evidence = await captureScrolledNodeScreenshots(client, 13, {
    filePath,
    format: "jpeg",
    maxScreenshots: 2,
    duplicateStopCount: 10,
    scrollMethod: "input",
    wheelDeltaY: 650,
    scrollDeltaJitterEnabled: true,
    scrollDeltaJitterRandom: () => 0,
    scrollDeltaJitterPreserveCoverage: true,
    requireTerminalProof: false,
    settleMs: 0
  });
  assert.equal(evidence.screenshot_count, 2);
  assert.equal(wheelEvents.length, 1);
  assert.equal(wheelEvents[0].deltaY, 80);
  assert.equal(evidence.screenshots[1].scroll.wheel_delta_y, 80);
  assert.equal(evidence.screenshots[1].scroll.wheel_delta_jitter.max_delta_for_overlap, 80);
  assert.equal(evidence.optimization.scroll_delta_jitter.enabled, true);
  assert.equal(evidence.optimization.scroll_delta_jitter.preserve_coverage, true);
  assert.equal(evidence.optimization.effective_max_screenshots, 2);
  assert.equal(evidence.capture_iteration_limit, 2);
  assert.equal(evidence.coverage_ledger[1].overlap_with_previous.estimated_overlap_ratio, 0.2);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureScrolledNodeScreenshotsCropsAtStopBoundary() {
  const client = createImageSequenceClient([DEFAULT_VIEWPORT_BUFFER]);
  client.DOM.querySelectorAll = async ({ nodeId, selector }) => {
    client.calls.push(["DOM.querySelectorAll", nodeId, selector]);
    return { nodeIds: [41, 42] };
  };
  client.DOM.getOuterHTML = async ({ nodeId }) => {
    client.calls.push(["DOM.getOuterHTML", nodeId]);
    if (nodeId === 42) return { outerHTML: "<section>其他名企大厂 经历牛人</section>" };
    return { outerHTML: "<section>项目经历 Spring Boot Redis</section>" };
  };
  client.DOM.getBoxModel = async ({ nodeId }) => {
    client.calls.push(["DOM.getBoxModel", nodeId]);
    if (nodeId === 42) {
      return {
        model: {
          border: [10, 150, 210, 150, 210, 190, 10, 190]
        }
      };
    }
    return {
      model: {
        border: [10, 20, 210, 20, 210, 620, 10, 620]
      }
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "candidate.jpg");
  const evidence = await captureScrolledNodeScreenshots(client, 40, {
    filePath,
    format: "jpeg",
    quality: 72,
    maxScreenshots: 5,
    duplicateStopCount: 1,
    skipDuplicateScreenshots: true,
    scrollMethod: "input",
    stopBoundarySelector: "section",
    stopBoundaryTextPatterns: ["其他名企大厂"],
    stopBoundaryTopPadding: 5,
    stopBoundaryMinCaptureHeight: 120,
    settleMs: 0
  });
  assert.equal(evidence.capture_count, 1);
  assert.equal(evidence.screenshot_count, 1);
  assert.equal(evidence.screenshots[0].clip.height, 125);
  assert.equal(evidence.stop_boundary_result.action, "capture_then_stop");
  assert.equal(evidence.stop_boundary_result.matched_pattern, "其他名企大厂");
  assert.equal(client.calls.some(([method]) => method === "Input.dispatchMouseEvent"), false);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCliplessCropScalesAndViewportOffsets() {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const client = createFakeClient();
    const viewportBuffer = await sharp({
      create: {
        width: Math.round(320 * scale),
        height: Math.round(200 * scale),
        channels: 3,
        background: "#dbeafe"
      }
    }).png().toBuffer();
    client.DOM.getBoxModel = async ({ nodeId }) => {
      client.calls.push(["DOM.getBoxModel", nodeId]);
      return { model: { border: [20, 20, 180, 20, 180, 100, 20, 100] } };
    };
    client.Page.getLayoutMetrics = async () => ({
      cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 320, clientHeight: 200 },
      cssVisualViewport: {
        offsetX: 0,
        offsetY: 0,
        pageX: 0,
        pageY: 0,
        clientWidth: 320,
        clientHeight: 200,
        scale: 1,
        zoom: 1
      }
    });
    client.Page.captureScreenshot = async (params) => {
      client.calls.push(["Page.captureScreenshot", params]);
      return { data: viewportBuffer.toString("base64") };
    };
    const captured = await captureNodeScreenshot(client, 70, { format: "png" });
    assert.equal(captured.crop.pixel_crop.width, Math.round(160 * scale));
    assert.equal(captured.crop.pixel_crop.height, Math.round(80 * scale));
    assert.equal(captured.crop.scale_x, scale);
    assert.equal(captured.crop.scale_y, scale);
  }

  const offsetClient = createFakeClient();
  offsetClient.DOM.getBoxModel = async ({ nodeId }) => {
    offsetClient.calls.push(["DOM.getBoxModel", nodeId]);
    return { model: { border: [120, 70, 220, 70, 220, 150, 120, 150] } };
  };
  offsetClient.Page.getLayoutMetrics = async () => ({
    cssLayoutViewport: { pageX: 100, pageY: 50, clientWidth: 300, clientHeight: 200 },
    cssVisualViewport: {
      offsetX: 0,
      offsetY: 0,
      pageX: 100,
      pageY: 50,
      clientWidth: 300,
      clientHeight: 200,
      scale: 1,
      zoom: 1
    }
  });
  const offsetCapture = await captureNodeScreenshot(offsetClient, 71, { format: "png" });
  assert.equal(offsetCapture.crop.coordinate_space, "viewport");
  assert.equal(offsetCapture.crop.visible_rect.x, 120);
  assert.equal(offsetCapture.crop.visible_rect.y, 70);

  const visualOffsetClient = createFakeClient();
  visualOffsetClient.DOM.getBoxModel = async ({ nodeId }) => {
    visualOffsetClient.calls.push(["DOM.getBoxModel", nodeId]);
    return { model: { border: [120, 70, 220, 70, 220, 150, 120, 150] } };
  };
  visualOffsetClient.Page.getLayoutMetrics = async () => ({
    cssLayoutViewport: { pageX: 400, pageY: 250, clientWidth: 300, clientHeight: 200 },
    cssVisualViewport: {
      offsetX: 100,
      offsetY: 50,
      pageX: 500,
      pageY: 300,
      clientWidth: 300,
      clientHeight: 200,
      scale: 1,
      zoom: 1
    }
  });
  const visualOffsetCapture = await captureNodeScreenshot(visualOffsetClient, 72, { format: "png" });
  assert.equal(visualOffsetCapture.crop.coordinate_space, "viewport");
  assert.equal(visualOffsetCapture.crop.visible_rect.x, 20);
  assert.equal(visualOffsetCapture.crop.visible_rect.y, 20);

  const pageRelativeClient = createFakeClient();
  pageRelativeClient.DOM.getBoxModel = async ({ nodeId }) => {
    pageRelativeClient.calls.push(["DOM.getBoxModel", nodeId]);
    return { model: { border: [550, 330, 650, 330, 650, 410, 550, 410] } };
  };
  pageRelativeClient.Page.getLayoutMetrics = visualOffsetClient.Page.getLayoutMetrics;
  const pageRelativeCapture = await captureNodeScreenshot(pageRelativeClient, 73, { format: "png" });
  assert.equal(pageRelativeCapture.crop.coordinate_space, "page");
  assert.equal(pageRelativeCapture.crop.visible_rect.x, 50);
  assert.equal(pageRelativeCapture.crop.visible_rect.y, 30);
}

async function testCliplessCropIframeTranslationAndViewportClamp() {
  const client = createFakeClient();
  client.Page.getLayoutMetrics = async () => ({
    cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 700 },
    cssVisualViewport: {
      offsetX: 0,
      offsetY: 0,
      pageX: 0,
      pageY: 0,
      clientWidth: 1000,
      clientHeight: 700,
      scale: 1,
      zoom: 1
    }
  });
  client.DOM.getBoxModel = async ({ nodeId }) => {
    client.calls.push(["DOM.getBoxModel", nodeId]);
    if (nodeId === 80) {
      return {
        model: {
          border: [300, 200, 950, 200, 950, 650, 300, 650],
          content: [310, 210, 940, 210, 940, 640, 310, 640]
        }
      };
    }
    if (nodeId === 82) {
      return { model: { border: [10, 10, 260, 10, 260, 190, 10, 190] } };
    }
    return { model: { border: [350, 300, 650, 300, 650, 520, 350, 520] } };
  };
  const captured = await captureNodeScreenshot(client, 81, {
    format: "png",
    iframeOwnerNodeId: 80
  });
  assert.equal(captured.crop.coordinate_space, "viewport");
  assert.equal(captured.crop.visible_rect.x, 350);
  assert.equal(captured.crop.visible_rect.y, 300);
  assert.equal(captured.crop.visible_rect.width, 300);
  assert.equal(captured.crop.visible_ratio, 1);
  assert.deepEqual(captured.crop.iframe_owner_visible_rect, {
    x: 310,
    y: 210,
    width: 630,
    height: 430
  });

  const localFallback = await captureNodeScreenshot(client, 82, {
    format: "png",
    iframeOwnerNodeId: 80
  });
  assert.equal(localFallback.crop.coordinate_space, "iframe-local");
  assert.equal(localFallback.crop.visible_rect.x, 320);
  assert.equal(localFallback.crop.visible_rect.y, 220);
}

async function testCoverageIncompleteNeverProducesLlmEvidence() {
  const buffers = await Promise.all(["#fee2e2", "#dcfce7", "#dbeafe"].map((background) => sharp({
    create: { width: 600, height: 400, channels: 3, background }
  }).png().toBuffer()));
  const client = createImageSequenceClient(buffers);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const evidence = await captureScrolledNodeScreenshots(client, 90, {
    filePath: path.join(dir, "candidate.png"),
    format: "png",
    maxScreenshots: 2,
    duplicateStopCount: 1,
    skipDuplicateScreenshots: true,
    composeForLlm: true,
    scrollMethod: "input",
    settleMs: 0
  });
  assert.equal(evidence.ok, false);
  assert.equal(evidence.coverage_complete, false);
  assert.equal(evidence.error_code, "IMAGE_CAPTURE_COVERAGE_INCOMPLETE");
  assert.equal(evidence.coverage_terminal_reason, "coverage_limit_reached_without_terminal_proof");
  assert.deepEqual(evidence.llm_file_paths, []);
  assert.equal(evidence.coverage_ledger.length, 3);
  assert.equal(client.calls
    .filter(([method]) => method === "Page.captureScreenshot")
    .every(([, params]) => !("clip" in params)
      && params.captureBeyondViewport === false
      && params.fromSurface === true), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for test condition after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function testScreenshotTransactionsNeverOverlap() {
  const client = createFakeClient();
  const releases = [];
  let active = 0;
  let maxActive = 0;
  let callCount = 0;
  client.Page.captureScreenshot = async (params) => {
    client.calls.push(["Page.captureScreenshot", params]);
    callCount += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve) => {
      releases.push(() => {
        active -= 1;
        resolve({ data: DEFAULT_VIEWPORT_BUFFER.toString("base64") });
      });
    });
  };

  const first = captureViewportScreenshot(client, { stepTimeoutMs: 500 });
  const second = captureViewportScreenshot(client, { stepTimeoutMs: 500 });
  await waitFor(() => callCount === 1);
  assert.equal(maxActive, 1);
  releases[0]();
  await waitFor(() => callCount === 2);
  assert.equal(maxActive, 1, "the second screenshot must not start before the first settles");
  releases[1]();
  await Promise.all([first, second]);
  assert.equal(active, 0);
}

async function testScreenshotTimeoutReleasesOnlyAfterSuccessfulAbandonment() {
  const client = createFakeClient();
  const events = [];
  let callCount = 0;
  let releaseUnknownCapture;
  client.Page.captureScreenshot = async (params) => {
    client.calls.push(["Page.captureScreenshot", params]);
    callCount += 1;
    events.push(`capture_${callCount}`);
    if (callCount === 1) {
      return new Promise((resolve) => {
        releaseUnknownCapture = () => resolve({ data: DEFAULT_VIEWPORT_BUFFER.toString("base64") });
      });
    }
    return { data: DEFAULT_VIEWPORT_BUFFER.toString("base64") };
  };
  client.__abandonAndReconnect = async () => {
    events.push("abandon_start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push("abandon_done");
    return { reconnected: true, previous_connection_epoch: 1, connection_epoch: 2 };
  };

  const firstResult = captureViewportScreenshot(client, { stepTimeoutMs: 10 })
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  const second = captureViewportScreenshot(client, { stepTimeoutMs: 200 });
  const [first, secondResult] = await Promise.all([firstResult, second]);
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "IMAGE_CAPTURE_TIMEOUT");
  assert.equal(first.error.capture_outcome_unknown, true);
  assert.equal(first.error.screenshot_replay_suppressed, true);
  assert.equal(secondResult.source, "viewport-image");
  assert.deepEqual(events.slice(0, 4), [
    "capture_1",
    "abandon_start",
    "abandon_done",
    "capture_2"
  ]);
  assert.equal(callCount, 2, "an unknown screenshot outcome must never be replayed");
  releaseUnknownCapture();
}

async function testFailedAbandonmentBlocksUntilRawCaptureAlsoSettles() {
  const client = createFakeClient();
  let callCount = 0;
  let releaseUnknownCapture;
  client.Page.captureScreenshot = async (params) => {
    client.calls.push(["Page.captureScreenshot", params]);
    callCount += 1;
    if (callCount === 1) {
      return new Promise((resolve) => {
        releaseUnknownCapture = () => resolve({ data: DEFAULT_VIEWPORT_BUFFER.toString("base64") });
      });
    }
    return { data: DEFAULT_VIEWPORT_BUFFER.toString("base64") };
  };
  client.__abandonAndReconnect = async () => ({
    reconnected: true
    // Deliberately omit epoch evidence: a boolean claim alone must not release
    // a timed-out screenshot transaction.
  });

  const firstResult = captureViewportScreenshot(client, { stepTimeoutMs: 10 })
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  const secondResult = captureViewportScreenshot(client, { stepTimeoutMs: 200 })
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  const first = await firstResult;
  assert.equal(first.ok, false);
  assert.equal(first.error.capture_session_unsafe, true);
  const second = await secondResult;
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "IMAGE_CAPTURE_SESSION_UNSAFE");
  assert.equal(second.error.capture_outcome_unknown, true);
  assert.equal(callCount, 1, "a poisoned queue must never overlap or replay the unknown screenshot");
  const third = await captureViewportScreenshot(client, { stepTimeoutMs: 200 })
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  assert.equal(third.ok, false);
  assert.equal(third.error.code, "IMAGE_CAPTURE_SESSION_UNSAFE");
  assert.equal(callCount, 1);
  releaseUnknownCapture();
  await new Promise((resolve) => setTimeout(resolve, 1));
  const recovered = await captureViewportScreenshot(client, { stepTimeoutMs: 200 });
  assert.equal(recovered.source, "viewport-image");
  assert.equal(callCount, 2, "both settled operations must clear the temporary capture quarantine");
}

async function testHungAbandonmentRemainsFailClosedUntilItSettles() {
  const client = createFakeClient();
  let callCount = 0;
  let releaseUnknownCapture;
  let releaseAbandonment;
  client.Page.captureScreenshot = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Promise((resolve) => {
        releaseUnknownCapture = () => resolve({ data: DEFAULT_VIEWPORT_BUFFER.toString("base64") });
      });
    }
    return { data: DEFAULT_VIEWPORT_BUFFER.toString("base64") };
  };
  client.__abandonAndReconnect = async () => new Promise((resolve) => {
    releaseAbandonment = () => resolve({ reconnected: false });
  });
  const started = Date.now();
  const firstResult = captureViewportScreenshot(client, { stepTimeoutMs: 10 })
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  const queuedResult = captureViewportScreenshot(client, { stepTimeoutMs: 200 })
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  const [first, queued] = await Promise.all([firstResult, queuedResult]);
  assert.equal(first.ok, false);
  assert.equal(first.error.capture_session_unsafe, true);
  assert.equal(queued.ok, false);
  assert.equal(queued.error.code, "IMAGE_CAPTURE_SESSION_UNSAFE");
  assert.equal(callCount, 1);
  assert.equal(Date.now() - started < 1000, true, "a hung reconnect must fail closed promptly");
  releaseUnknownCapture();
  await new Promise((resolve) => setTimeout(resolve, 1));
  const stillBlocked = await captureViewportScreenshot(client, { stepTimeoutMs: 200 })
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  assert.equal(stillBlocked.ok, false);
  assert.equal(stillBlocked.error.code, "IMAGE_CAPTURE_SESSION_UNSAFE");
  assert.equal(callCount, 1, "raw settlement alone must not bypass a hung abandonment attempt");
  releaseAbandonment();
  await new Promise((resolve) => setTimeout(resolve, 1));
  const recovered = await captureViewportScreenshot(client, { stepTimeoutMs: 200 });
  assert.equal(recovered.source, "viewport-image");
  assert.equal(callCount, 2);
}

function layoutMetrics(width, height) {
  return {
    cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: width, clientHeight: height },
    cssVisualViewport: {
      offsetX: 0,
      offsetY: 0,
      pageX: 0,
      pageY: 0,
      clientWidth: width,
      clientHeight: height,
      scale: 1,
      zoom: 1
    }
  };
}

async function testCaptureRebaselineRequiresTwoStableExternalResizeReadings() {
  const client = createImageSequenceClient([DEFAULT_VIEWPORT_BUFFER, DEFAULT_VIEWPORT_BUFFER]);
  const viewportReadings = [
    [300, 200],
    [300, 200],
    [320, 220],
    [320, 220],
    [320, 220]
  ];
  const windowReadings = [
    [500, 400],
    [500, 400],
    [520, 420],
    [520, 420],
    [520, 420]
  ];
  let viewportIndex = 0;
  let windowIndex = 0;
  client.Page.getLayoutMetrics = async () => {
    const [width, height] = viewportReadings[Math.min(viewportIndex, viewportReadings.length - 1)];
    viewportIndex += 1;
    return layoutMetrics(width, height);
  };
  client.Browser.getWindowForTarget = async () => {
    const [width, height] = windowReadings[Math.min(windowIndex, windowReadings.length - 1)];
    windowIndex += 1;
    return {
      windowId: 1,
      bounds: { left: 0, top: 0, width, height, windowState: "normal" }
    };
  };

  const evidence = await captureScrolledNodeScreenshots(client, 95, {
    maxScreenshots: 2,
    requireTerminalProof: false,
    settleMs: 0
  });
  const event = evidence.viewport_events.find((item) => item.kind === "verified_window_rebaseline");
  assert.equal(evidence.ok, true);
  assert.equal(event?.verification?.verified, true);
  assert.equal(event?.verification?.reason, "verified_external_resize_two_stable_readings");
  assert.equal(viewportIndex, 5, "external resize must consume a distinct second stability reading");
}

async function testCaptureRejectsUnstableOrUnverifiedRebaseline() {
  const client = createImageSequenceClient([DEFAULT_VIEWPORT_BUFFER, DEFAULT_VIEWPORT_BUFFER]);
  const viewportReadings = [
    [300, 200],
    [300, 200],
    [320, 220],
    [318, 218]
  ];
  const windowReadings = [
    [500, 400],
    [500, 400],
    [520, 420],
    [518, 418]
  ];
  let viewportIndex = 0;
  let windowIndex = 0;
  client.Page.getLayoutMetrics = async () => {
    const [width, height] = viewportReadings[Math.min(viewportIndex, viewportReadings.length - 1)];
    viewportIndex += 1;
    return layoutMetrics(width, height);
  };
  client.Browser.getWindowForTarget = async () => {
    const [width, height] = windowReadings[Math.min(windowIndex, windowReadings.length - 1)];
    windowIndex += 1;
    return {
      windowId: 1,
      bounds: { left: 0, top: 0, width, height, windowState: "normal" }
    };
  };
  const result = await captureScrolledNodeScreenshots(client, 96, {
    maxScreenshots: 2,
    requireTerminalProof: false,
    settleMs: 0
  }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "IMAGE_CAPTURE_VIEWPORT_DRIFT");
  assert.equal(result.error.rebaseline_verification.verified, false);
  assert.equal(client.calls.filter(([method]) => method === "Page.captureScreenshot").length, 1);

  const collapsed = createImageSequenceClient([DEFAULT_VIEWPORT_BUFFER, DEFAULT_VIEWPORT_BUFFER]);
  const collapsedReadings = [[300, 200], [300, 200], [294, 194]];
  let collapsedIndex = 0;
  collapsed.Page.getLayoutMetrics = async () => {
    const [width, height] = collapsedReadings[Math.min(collapsedIndex, collapsedReadings.length - 1)];
    collapsedIndex += 1;
    return layoutMetrics(width, height);
  };
  const collapsedResult = await captureScrolledNodeScreenshots(collapsed, 97, {
    maxScreenshots: 2,
    requireTerminalProof: false,
    settleMs: 0
  }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  assert.equal(collapsedResult.ok, false);
  assert.equal(collapsedResult.error.code, "IMAGE_CAPTURE_VIEWPORT_DRIFT");
  assert.equal(collapsedResult.error.rebaseline_verification, undefined);
  assert.equal(collapsed.calls.filter(([method]) => method === "Page.captureScreenshot").length, 1);
}

async function testAnchorAndImageTerminalProofWithTransientDuplicate() {
  const buffers = await Promise.all(["#ffffff", "#ffffff", "#bfdbfe", "#bfdbfe", "#bfdbfe"].map((background) => sharp({
    create: { width: 600, height: 400, channels: 3, background }
  }).png().toBuffer()));
  const client = createImageSequenceClient(buffers);
  let scrollCount = 0;
  let anchorQueryCount = 0;
  const anchorRoles = new Map();
  client.DOM.querySelectorAll = async ({ nodeId, selector }) => {
    client.calls.push(["DOM.querySelectorAll", nodeId, selector]);
    anchorQueryCount += 1;
    const topId = 200 + anchorQueryCount * 2;
    const bottomId = topId + 1;
    anchorRoles.set(topId, "top");
    anchorRoles.set(bottomId, "bottom");
    return { nodeIds: [topId, bottomId] };
  };
  client.DOM.getBoxModel = async ({ nodeId }) => {
    client.calls.push(["DOM.getBoxModel", nodeId]);
    if (nodeId === 100) {
      return { model: { border: [10, 20, 210, 20, 210, 120, 10, 120] } };
    }
    const effectiveScroll = Math.min(scrollCount, 2) * 80;
    const y = anchorRoles.get(nodeId) === "top" ? 20 - effectiveScroll : 300 - effectiveScroll;
    return { model: { border: [20, y, 180, y, 180, y + 20, 20, y + 20] } };
  };
  client.Input.dispatchMouseEvent = async (params) => {
    client.calls.push(["Input.dispatchMouseEvent", params.type, params]);
    if (params.type === "mouseWheel") scrollCount += 1;
  };

  const evidence = await captureScrolledNodeScreenshots(client, 100, {
    format: "png",
    maxScreenshots: 3,
    skipDuplicateScreenshots: true,
    duplicateStopCount: 2,
    scrollMethod: "dom-anchor-fallback-input",
    settleMs: 0
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.capture_count, 5);
  assert.equal(evidence.screenshot_count, 2);
  assert.equal(evidence.coverage_terminal_reason, "consecutive_image_and_anchor_no_progress");
  assert.deepEqual(evidence.coverage_ledger.map((item) => item.no_progress), [
    false,
    false,
    false,
    true,
    true
  ]);
  assert.equal(evidence.coverage_ledger[1].duplicate_of_previous, true);
  assert.equal(evidence.coverage_ledger[1].anchor_evidence.stationary, false);
  assert.equal(evidence.coverage_ledger[1].overlap_with_previous.estimated_overlap_ratio, 0.2);
  assert.equal(evidence.coverage_ledger[3].anchor_evidence.same_anchor, false);
  assert.equal(evidence.coverage_ledger[3].anchor_evidence.reason, "bottom_anchor_reacquired_stationary");
  assert.equal(typeof evidence.coverage_ledger[0].capture_operation_id, "string");
  assert.equal(evidence.coverage_ledger[0].capture_operation_id.length > 0, true);
  assert.equal(evidence.coverage_ledger[0].timing.transport_elapsed_ms >= 0, true);
  assert.equal(evidence.coverage_ledger[0].timing.local_processing_elapsed_ms >= 0, true);
  assert.deepEqual(evidence.coverage_ledger[0].image_dimensions, {
    viewport_width: 600,
    viewport_height: 400,
    scale_x: 2,
    scale_y: 2
  });
  assert.equal(
    evidence.screenshots[0].capture_operation.operation_id,
    evidence.coverage_ledger[0].capture_operation_id
  );
  assert.equal(anchorQueryCount, evidence.capture_count, "anchors must be re-queried after every scroll/capture");
}

async function testStopBoundaryBeforeFirstCaptureIsIncomplete() {
  const client = createFakeClient();
  client.DOM.querySelectorAll = async () => ({ nodeIds: [111] });
  client.DOM.getOuterHTML = async () => ({ outerHTML: "<section>其他名企大厂</section>" });
  client.DOM.getBoxModel = async ({ nodeId }) => {
    if (nodeId === 110) {
      return { model: { border: [10, 20, 210, 20, 210, 120, 10, 120] } };
    }
    return { model: { border: [10, 0, 210, 0, 210, 10, 10, 10] } };
  };
  const evidence = await captureScrolledNodeScreenshots(client, 110, {
    maxScreenshots: 2,
    stopBoundarySelector: "section",
    stopBoundaryTextPatterns: ["其他名企大厂"],
    settleMs: 0
  });
  assert.equal(evidence.ok, false);
  assert.equal(evidence.screenshot_count, 0);
  assert.equal(evidence.coverage_terminal_reason, "stop_boundary_before_first_capture");
  assert.equal(client.calls.some(([method]) => method === "Page.captureScreenshot"), false);
}

async function testOffscreenStopBoundaryDoesNotTruncateCoverage() {
  const client = createFakeClient();
  client.DOM.querySelectorAll = async () => ({ nodeIds: [121] });
  client.DOM.getOuterHTML = async () => ({ outerHTML: "<section>其他名企大厂</section>" });
  client.DOM.getBoxModel = async ({ nodeId }) => {
    if (nodeId === 120) {
      return { model: { border: [10, 20, 210, 20, 210, 620, 10, 620] } };
    }
    return { model: { border: [10, 520, 210, 520, 210, 560, 10, 560] } };
  };
  const evidence = await captureScrolledNodeScreenshots(client, 120, {
    maxScreenshots: 2,
    skipDuplicateScreenshots: true,
    stopBoundarySelector: "section",
    stopBoundaryTextPatterns: ["其他名企大厂"],
    settleMs: 0
  });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.capture_count, 3);
  assert.equal(evidence.stop_boundary_result, null);
  assert.equal(evidence.coverage_terminal_reason, "consecutive_image_and_anchor_no_progress");
}

async function testResumeCheckpointAppendsAndComposesOnlyWhenComplete() {
  const [pageA, pageB, pageC] = await Promise.all(["#fee2e2", "#dcfce7", "#dbeafe"].map((background) => sharp({
    create: { width: 600, height: 400, channels: 3, background }
  }).png().toBuffer()));
  const firstClient = createFakeClient();
  let firstCaptureIndex = 0;
  firstClient.Page.captureScreenshot = async (params) => {
    firstClient.calls.push(["Page.captureScreenshot", params]);
    if (firstCaptureIndex === 0) {
      firstCaptureIndex += 1;
      return { data: pageA.toString("base64") };
    }
    if (firstCaptureIndex === 1) {
      firstCaptureIndex += 1;
      return { data: pageB.toString("base64") };
    }
    firstCaptureIndex += 1;
    const error = new Error("CDP transport closed during screenshot");
    error.code = "CDP_CONNECTION_CLOSED";
    error.cdp_outcome_unknown = true;
    throw error;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-resume-"));
  const filePath = path.join(dir, "candidate.png");
  let firstError = null;
  try {
    await captureScrolledNodeScreenshots(firstClient, 130, {
      filePath,
      format: "png",
      maxScreenshots: 4,
      skipDuplicateScreenshots: true,
      composeForLlm: true,
      llmPagesPerImage: 2,
      scrollMethod: "dom-anchor-fallback-input",
      settleMs: 0
    });
  } catch (error) {
    firstError = error;
  }
  assert.equal(firstError?.code, "CDP_CONNECTION_CLOSED");
  const checkpoint = firstError?.capture_checkpoint;
  assert.equal(checkpoint?.kind, "cv_capture_coverage_checkpoint");
  assert.equal(checkpoint?.schema_version, 1);
  assert.equal(checkpoint?.screenshots.length, 2);
  assert.equal(checkpoint?.coverage_ledger.length, 2);
  assert.equal(checkpoint?.next_capture_index, 2);
  assert.equal(checkpoint?.session_scoped_node_ids_reset, true);
  assert.doesNotThrow(() => JSON.stringify(checkpoint));
  assert.equal(checkpoint.screenshots.every((item) => item.node_id === null), true);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes("-llm-")), false);

  // Simulate stale ids supplied by an older caller.  Normalization must strip
  // them instead of reusing them in the new CDP session.
  checkpoint.current_pending_scroll_metadata.anchor_node_id = 999;
  checkpoint.current_pending_scroll_metadata.anchor_plan = {
    bottom_anchor: { node_id: 998, y: 100, height: 20 }
  };
  checkpoint.screenshots[0].node_id = 997;
  checkpoint.coverage_ledger[0].anchor_evidence.node_id = 996;

  // A reconnect may rebuild the CV panel at the top.  The capture layer must
  // physically find the last confirmed page (B), then issue a fresh scroll
  // from B before it appends page C.
  const resumeClient = createFakeClient();
  let resumedScrollPosition = 0;
  resumeClient.Page.captureScreenshot = async (params) => {
    resumeClient.calls.push(["Page.captureScreenshot", params]);
    const buffer = [pageA, pageB, pageC][resumedScrollPosition];
    return { data: buffer.toString("base64") };
  };
  resumeClient.DOM.querySelectorAll = async () => ({ nodeIds: [231, 232] });
  resumeClient.DOM.getBoxModel = async ({ nodeId }) => {
    if (nodeId === 230) {
      return { model: { border: [10, 20, 210, 20, 210, 120, 10, 120] } };
    }
    const y = nodeId === 231 ? 20 : 300 - resumedScrollPosition * 50;
    return { model: { border: [20, y, 180, y, 180, y + 20, 20, y + 20] } };
  };
  resumeClient.Input.dispatchMouseEvent = async (params) => {
    resumeClient.calls.push(["Input.dispatchMouseEvent", params.type, params]);
    if (params.type !== "mouseWheel") return;
    resumedScrollPosition = Math.max(0, Math.min(
      2,
      resumedScrollPosition + (params.deltaY > 0 ? 1 : -1)
    ));
  };
  const resumed = await captureScrolledNodeScreenshots(resumeClient, 230, {
    filePath,
    format: "png",
    maxScreenshots: 4,
    skipDuplicateScreenshots: true,
    composeForLlm: true,
    llmPagesPerImage: 2,
    scrollMethod: "dom-anchor-fallback-input",
    resumeCheckpoint: checkpoint,
    settleMs: 0
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed_from_checkpoint, true);
  assert.equal(resumed.resume_checkpoint_id, checkpoint.checkpoint_id);
  assert.equal(resumed.resume_confirmed_screenshot_count, 2);
  assert.equal(resumed.resume_continuity.verified, true);
  assert.equal(resumed.resume_continuity.match_kind, "sha256");
  assert.equal(resumed.resume_continuity.probes.some((item) => item.direction === "from_top"), true);
  assert.equal(resumed.coverage_ledger[2].overlap_with_previous.source, "bottom_anchor_delta");
  assert.equal(resumed.coverage_ledger[2].scroll.checkpoint_pending_scroll_physically_reissued, true);
  assert.equal(resumed.coverage_ledger[2].scroll.old_pending_delta_used_as_position_proof, false);
  assert.equal(resumed.capture_count, 5);
  assert.equal(resumed.screenshot_count, 3);
  assert.equal(resumed.coverage_ledger.length, 5);
  assert.equal(resumed.coverage_ledger[2].capture_index, 2);
  assert.equal(resumed.screenshots[0].node_id, null);
  assert.equal(resumed.coverage_ledger[0].anchor_evidence.node_id, null);
  assert.equal(resumed.screenshots[2].scroll.anchor_node_id, null);
  assert.equal(resumed.coverage_checkpoint, null);
  assert.equal(resumed.llm_screenshot_count, 2);
  assert.deepEqual(
    resumed.llm_screenshots.flatMap((item) => item.source_file_paths),
    resumed.file_paths
  );
  assert.equal(resumed.llm_file_paths.every((item) => fs.existsSync(item)), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testResumeGetsTwoFreshTerminalProofAttempts() {
  const pages = await Promise.all(["#fecaca", "#bbf7d0", "#bfdbfe", "#fde68a"].map((background) => sharp({
    create: { width: 600, height: 400, channels: 3, background }
  }).png().toBuffer()));
  const client = createFakeClient();
  const sequence = [pages[0], pages[1], pages[2], pages[3], pages[3]];
  let captureIndex = 0;
  let initialScrollCount = 0;
  client.Page.captureScreenshot = async (params) => {
    client.calls.push(["Page.captureScreenshot", params]);
    if (captureIndex < sequence.length) {
      const buffer = sequence[captureIndex];
      captureIndex += 1;
      return { data: buffer.toString("base64") };
    }
    captureIndex += 1;
    const error = new Error("session abandoned during second terminal probe");
    error.code = "CDP_CONNECTION_CLOSED";
    error.cdp_outcome_unknown = true;
    throw error;
  };
  client.DOM.querySelectorAll = async () => ({ nodeIds: [141, 142] });
  client.DOM.getBoxModel = async ({ nodeId }) => {
    if (nodeId === 140) {
      return { model: { border: [10, 20, 210, 20, 210, 120, 10, 120] } };
    }
    const y = nodeId === 141
      ? 20
      : 400 - Math.min(initialScrollCount, 3) * 50;
    return { model: { border: [20, y, 180, y, 180, y + 20, 20, y + 20] } };
  };
  client.Input.dispatchMouseEvent = async (params) => {
    if (params.type === "mouseWheel") initialScrollCount += 1;
  };
  let captureError = null;
  try {
    await captureScrolledNodeScreenshots(client, 140, {
      format: "png",
      maxScreenshots: 4,
      skipDuplicateScreenshots: true,
      settleMs: 0
    });
  } catch (error) {
    captureError = error;
  }
  assert.equal(captureError?.capture_checkpoint?.next_capture_index, 5);
  assert.equal(captureError?.capture_checkpoint?.unique_screenshot_count, 4);
  assert.equal(captureError?.capture_checkpoint?.coverage_ledger[4].consecutive_no_progress, 1);

  const resumedClient = createImageSequenceClient([pages[3], pages[3], pages[3]]);
  resumedClient.DOM.querySelectorAll = async () => ({ nodeIds: [241, 242] });
  resumedClient.DOM.getBoxModel = async ({ nodeId }) => {
    if (nodeId === 240) {
      return { model: { border: [10, 20, 210, 20, 210, 120, 10, 120] } };
    }
    const y = nodeId === 241 ? 20 : 250;
    return { model: { border: [20, y, 180, y, 180, y + 20, 20, y + 20] } };
  };
  const resumed = await captureScrolledNodeScreenshots(resumedClient, 240, {
    format: "png",
    maxScreenshots: 4,
    skipDuplicateScreenshots: true,
    resumeCheckpoint: captureError.capture_checkpoint,
    settleMs: 0
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.capture_count, 7);
  assert.equal(resumed.capture_iteration_limit, 9);
  assert.equal(resumed.base_capture_iteration_limit, 6);
  assert.equal(resumed.screenshot_count, 4);
  assert.equal(resumed.coverage_ledger.length, 7);
  assert.equal(resumed.resume_continuity.verified, true);
  assert.equal(resumed.coverage_ledger[5].consecutive_no_progress, 1);
  assert.equal(resumed.coverage_ledger[5].anchor_evidence.position_comparable, true);
  assert.equal(resumed.coverage_ledger[6].consecutive_no_progress, 2);
  assert.equal(resumed.coverage_terminal_reason, "consecutive_image_and_anchor_no_progress");
}

async function testResumeContinuityFailureIsIncompleteAndPersistsNoProbeImages() {
  const [pageA, pageB] = await Promise.all(["#fecaca", "#bfdbfe"].map((background) => sharp({
    create: { width: 600, height: 400, channels: 3, background }
  }).png().toBuffer()));
  const initial = createFakeClient();
  let captureIndex = 0;
  initial.Page.captureScreenshot = async () => {
    if (captureIndex === 0) {
      captureIndex += 1;
      return { data: pageA.toString("base64") };
    }
    const error = new Error("connection closed before next confirmed page");
    error.code = "CDP_CONNECTION_CLOSED";
    error.cdp_outcome_unknown = true;
    throw error;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-resume-fail-"));
  const filePath = path.join(dir, "candidate.png");
  const first = await captureScrolledNodeScreenshots(initial, 250, {
    filePath,
    maxScreenshots: 2,
    settleMs: 0
  }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  assert.equal(first.ok, false);
  assert.equal(first.error.capture_checkpoint.screenshots.length, 1);

  const reacquired = createImageSequenceClient([pageB]);
  const resumed = await captureScrolledNodeScreenshots(reacquired, 350, {
    filePath,
    maxScreenshots: 2,
    resumeCheckpoint: first.error.capture_checkpoint,
    settleMs: 0
  }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  assert.equal(resumed.ok, false);
  assert.equal(resumed.error.code, "IMAGE_CAPTURE_RESUME_CONTINUITY_UNPROVEN");
  assert.equal(resumed.error.coverage_incomplete, true);
  assert.equal(resumed.error.capture_checkpoint.last_resume_continuity.verified, false);
  assert.equal(
    fs.readdirSync(dir).filter((name) => name.endsWith(".png")).length,
    1,
    "continuity probes must remain in memory and never become evidence files"
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

function testDomainCaptureJitterWiring() {
  const runServicePaths = [
    path.join("src", "domains", "recommend", "run-service.js"),
    path.join("src", "domains", "chat", "run-service.js"),
    path.join("src", "domains", "recruit", "run-service.js")
  ];
  for (const filePath of runServicePaths) {
    const source = fs.readFileSync(filePath, "utf8");
    assert.equal(
      source.includes("scrollDeltaJitterEnabled: effectiveHumanBehavior.listScrollJitter"),
      true,
      `${filePath} must wire humanBehavior listScrollJitter into CV capture scroll jitter`
    );
  }
}

await testCaptureNodeHtml();
await testCaptureNodeScreenshot();
await testCaptureViewportScreenshot();
await testCaptureCandidateEvidence();
await testCaptureCandidateEvidenceScrollScreenshotDefault();
await testCaptureScrolledNodeScreenshotsSkipsDuplicateTail();
await testCaptureScrolledNodeScreenshotsComposesAllPagesForLlm();
await testCaptureScrolledNodeScreenshotsCanUseDomAnchors();
await testCaptureScrolledNodeScreenshotsFallsBackAfterNoopDomAnchorDuplicate();
await testCaptureScrolledNodeScreenshotsUsesCoverageSafeScrollJitter();
await testCaptureScrolledNodeScreenshotsCropsAtStopBoundary();
await testCliplessCropScalesAndViewportOffsets();
await testCliplessCropIframeTranslationAndViewportClamp();
await testCoverageIncompleteNeverProducesLlmEvidence();
await testScreenshotTransactionsNeverOverlap();
await testScreenshotTimeoutReleasesOnlyAfterSuccessfulAbandonment();
await testFailedAbandonmentBlocksUntilRawCaptureAlsoSettles();
await testHungAbandonmentRemainsFailClosedUntilItSettles();
await testCaptureRebaselineRequiresTwoStableExternalResizeReadings();
await testCaptureRejectsUnstableOrUnverifiedRebaseline();
await testAnchorAndImageTerminalProofWithTransientDuplicate();
await testStopBoundaryBeforeFirstCaptureIsIncomplete();
await testOffscreenStopBoundaryDoesNotTruncateCoverage();
await testResumeCheckpointAppendsAndComposesOnlyWhenComplete();
await testResumeGetsTwoFreshTerminalProofAttempts();
await testResumeContinuityFailureIsIncompleteAndPersistsNoProbeImages();
testDomainCaptureJitterWiring();

console.log("Core capture tests passed");
