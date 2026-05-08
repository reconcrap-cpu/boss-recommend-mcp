import assert from "node:assert/strict";
import { resolveCvCaptureTarget } from "./core/cv-capture-target/index.js";

function box(x, y, width, height) {
  return {
    model: {
      border: [
        x, y,
        x + width, y,
        x + width, y + height,
        x, y + height
      ]
    }
  };
}

function createFakeClient({
  queryAll = {},
  queryOne = {},
  frameDocuments = {},
  boxes = {}
} = {}) {
  const calls = [];
  return {
    calls,
    DOM: {
      async querySelectorAll({ nodeId, selector }) {
        calls.push(["DOM.querySelectorAll", nodeId, selector]);
        return {
          nodeIds: queryAll[`${nodeId}|${selector}`] || []
        };
      },
      async querySelector({ nodeId, selector }) {
        calls.push(["DOM.querySelector", nodeId, selector]);
        return {
          nodeId: queryOne[`${nodeId}|${selector}`] || 0
        };
      },
      async describeNode({ nodeId }) {
        calls.push(["DOM.describeNode", nodeId]);
        const documentNodeId = frameDocuments[nodeId];
        return {
          node: {
            contentDocument: documentNodeId ? { nodeId: documentNodeId } : null
          }
        };
      },
      async getBoxModel({ nodeId }) {
        calls.push(["DOM.getBoxModel", nodeId]);
        if (!boxes[nodeId]) throw new Error(`No box for node ${nodeId}`);
        return boxes[nodeId];
      }
    }
  };
}

async function testPopupWrapperNarrowsToCvNode() {
  const client = createFakeClient({
    queryAll: {
      "10|.resume-item-detail": [44]
    },
    boxes: {
      10: box(0, 0, 900, 900),
      44: box(20, 30, 560, 820)
    }
  });
  const target = await resolveCvCaptureTarget(client, {
    popup: {
      node_id: 10,
      selector: ".boss-popup__wrapper",
      root: "top",
      root_node_id: 1
    }
  }, {
    domain: "recommend"
  });

  assert.equal(target.node_id, 44);
  assert.equal(target.source, "popup_cv_selector");
  assert.equal(target.selector, ".resume-item-detail");
  assert.equal(target.cv_only, true);
}

async function testIframeCvContentPreferredBeforePopup() {
  const client = createFakeClient({
    frameDocuments: {
      20: 30
    },
    queryAll: {
      "30|.resume-detail-wrap": [31],
      "10|.resume-item-detail": [44]
    },
    boxes: {
      10: box(0, 0, 900, 900),
      20: box(0, 0, 620, 900),
      31: box(12, 18, 580, 1200),
      44: box(20, 30, 560, 820)
    }
  });
  const target = await resolveCvCaptureTarget(client, {
    popup: {
      node_id: 10,
      selector: ".boss-popup__wrapper"
    },
    resumeIframe: {
      node_id: 20,
      selector: 'iframe[src*="/web/frame/c-resume/"]'
    }
  }, {
    domain: "chat"
  });

  assert.equal(target.node_id, 31);
  assert.equal(target.source, "resume_iframe_cv_selector");
  assert.equal(target.iframe_node_id, 20);
  assert.equal(target.iframe_document_node_id, 30);
}

async function testBroadPopupDoesNotBecomeCvTarget() {
  const client = createFakeClient({
    boxes: {
      10: box(0, 0, 900, 900)
    }
  });
  const target = await resolveCvCaptureTarget(client, {
    popup: {
      node_id: 10,
      selector: ".dialog-wrap.active"
    }
  }, {
    domain: "recruit"
  });

  assert.equal(target, null);
}

async function testCvScopedContentSlotCanBeTarget() {
  const client = createFakeClient({
    boxes: {
      50: box(5, 10, 610, 1000)
    }
  });
  const target = await resolveCvCaptureTarget(client, {
    content: {
      node_id: 50,
      selector: ".resume-detail-wrap",
      root: "top",
      root_node_id: 1
    }
  }, {
    domain: "chat"
  });

  assert.equal(target.node_id, 50);
  assert.equal(target.source, "content_cv_slot");
  assert.equal(target.cv_only, true);
}

await testPopupWrapperNarrowsToCvNode();
await testIframeCvContentPreferredBeforePopup();
await testBroadPopupDoesNotBecomeCvTarget();
await testCvScopedContentSlotCanBeTarget();

console.log("Core CV capture target tests passed");
