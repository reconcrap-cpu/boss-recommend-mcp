import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureCandidateEvidence,
  captureNodeHtml,
  captureNodeScreenshot,
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

await testCaptureNodeHtml();
await testCaptureNodeScreenshot();
await testCaptureViewportScreenshot();
await testCaptureCandidateEvidence();
await testCaptureCandidateEvidenceScrollScreenshotDefault();

console.log("Core capture tests passed");
