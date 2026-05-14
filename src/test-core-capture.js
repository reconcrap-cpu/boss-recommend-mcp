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
      async captureScreenshot(params) {
        calls.push(["Page.captureScreenshot", params.clip]);
        return {
          data: Buffer.from("fake-image").toString("base64")
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
    client.calls.push(["Page.captureScreenshot", params.clip]);
    const buffer = buffers[Math.min(index, buffers.length - 1)] || Buffer.from("fake-image");
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
  assert.equal(captured.byte_length, Buffer.byteLength("fake-image"));
  assert.equal(captured.clip.x, 5);
  assert.equal(captured.clip.y, 15);
  assert.equal(fs.existsSync(filePath), true);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureViewportScreenshot() {
  const client = createFakeClient();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-capture-"));
  const filePath = path.join(dir, "viewport.png");
  const captured = await captureViewportScreenshot(client, {
    filePath,
    metadata: { reason: "empty-list-visual-check" }
  });
  assert.equal(captured.source, "viewport-image");
  assert.equal(captured.file_path, filePath);
  assert.equal(captured.byte_length, Buffer.byteLength("fake-image"));
  assert.equal(captured.capture_beyond_viewport, false);
  assert.equal(fs.existsSync(filePath), true);
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
      maxScreenshots: 2,
      duplicateStopCount: 3
    }
  });
  assert.equal(evidence.image.source, "image-scroll-sequence");
  assert.equal(evidence.image.screenshot_count, 2);
  assert.equal(evidence.image.file_paths.length, 2);
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
  assert.equal(evidence.capture_count, 2);
  assert.equal(evidence.screenshot_count, 1);
  assert.equal(evidence.dropped_duplicate_count, 1);
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
    settleMs: 0
  });
  assert.equal(evidence.screenshot_count, 3);
  assert.equal(evidence.scroll_anchor_plan.ok, true);
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
  assert.equal(evidence.capture_count, 3);
  assert.equal(evidence.screenshot_count, 2);
  assert.equal(evidence.dropped_duplicate_count, 1);
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
    scrollDeltaJitterPreserveCoverage: false,
    settleMs: 0
  });
  assert.equal(evidence.screenshot_count, 2);
  assert.equal(wheelEvents.length, 1);
  assert.equal(wheelEvents[0].deltaY, 80);
  assert.equal(evidence.screenshots[1].scroll.wheel_delta_y, 80);
  assert.equal(evidence.screenshots[1].scroll.wheel_delta_jitter.max_delta_for_overlap, 80);
  assert.equal(evidence.optimization.scroll_delta_jitter.enabled, true);
  assert.equal(evidence.optimization.scroll_delta_jitter.preserve_coverage, false);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCaptureScrolledNodeScreenshotsCropsAtStopBoundary() {
  const client = createImageSequenceClient([Buffer.from("before-stop")]);
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
          border: [10, 520, 210, 520, 210, 560, 10, 560]
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
  assert.equal(evidence.screenshots[0].clip.height, 495);
  assert.equal(evidence.stop_boundary_result.action, "capture_then_stop");
  assert.equal(evidence.stop_boundary_result.matched_pattern, "其他名企大厂");
  assert.equal(client.calls.some(([method]) => method === "Input.dispatchMouseEvent"), false);
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
testDomainCaptureJitterWiring();

console.log("Core capture tests passed");
