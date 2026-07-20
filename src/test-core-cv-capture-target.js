import assert from "node:assert/strict";
import {
  resolveCvCaptureTarget,
  waitForCvCaptureTarget
} from "./core/cv-capture-target/index.js";

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
        const configured = queryAll[`${nodeId}|${selector}`];
        return {
          nodeIds: typeof configured === "function" ? configured() : configured || []
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
        const configured = boxes[nodeId];
        if (!configured) throw new Error(`No box for node ${nodeId}`);
        return typeof configured === "function" ? configured() : configured;
      }
    }
  };
}

async function testStandaloneResumeItemDetailIsRejected() {
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

  assert.equal(target, null);

  const directSlotTarget = await resolveCvCaptureTarget(client, {
    content: {
      node_id: 44,
      selector: ".resume-item-detail",
      root: "top",
      root_node_id: 1
    }
  }, {
    domain: "recommend",
    stabilityIntervalMs: 0
  });
  assert.equal(directSlotTarget, null);
}

async function testLargestMainCvWrapperWins() {
  const client = createFakeClient({
    queryAll: {
      "10|.resume-center-side .resume-detail-wrap": [41],
      "10|.resume-detail-wrap": [41, 42],
      "10|.resume-item-detail": [44]
    },
    boxes: {
      10: box(0, 0, 1000, 900),
      41: box(20, 30, 350, 733),
      42: box(200, 30, 778, 733),
      44: box(20, 30, 350, 733)
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
    domain: "recommend",
    stabilityIntervalMs: 0
  });

  assert.equal(target.node_id, 42);
  assert.equal(target.selector, ".resume-detail-wrap");
  assert.equal(target.selection.candidate_count, 2);
  assert.equal(target.containment_verified, true);
  assert.equal(target.stability.sample_count, 2);
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
    domain: "chat",
    stabilityIntervalMs: 0
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
    domain: "recruit",
    stabilityIntervalMs: 0
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
    domain: "chat",
    stabilityIntervalMs: 0
  });

  assert.equal(target.node_id, 50);
  assert.equal(target.source, "content_cv_slot");
  assert.equal(target.cv_only, true);
}

async function testGeometryMustBeStableAcrossSamples() {
  let boxRead = 0;
  const client = createFakeClient({
    queryAll: {
      "10|.resume-detail-wrap": [51]
    },
    boxes: {
      51: () => {
        boxRead += 1;
        return box(10, 10, boxRead === 1 ? 778 : 650, 733);
      }
    }
  });

  const target = await resolveCvCaptureTarget(client, {
    popup: {
      node_id: 10,
      selector: ".boss-popup__wrapper"
    }
  }, {
    stabilityIntervalMs: 0
  });

  assert.equal(target, null);
}

async function testIdentityMustBeStableAcrossSamples() {
  let queryCount = 0;
  const client = createFakeClient({
    queryAll: {
      "10|.resume-detail-wrap": () => [++queryCount === 1 ? 61 : 62]
    },
    boxes: {
      61: box(10, 10, 778, 733),
      62: box(10, 10, 778, 733)
    }
  });

  const target = await resolveCvCaptureTarget(client, {
    popup: {
      node_id: 10,
      selector: ".boss-popup__wrapper"
    }
  }, {
    stabilityIntervalMs: 0
  });

  assert.equal(target, null);
}

async function testWaitHandlesTransientMainPanelAbsence() {
  let queryCount = 0;
  const client = createFakeClient({
    queryAll: {
      "10|.resume-detail-wrap": () => {
        queryCount += 1;
        return queryCount === 1 ? [] : [71];
      }
    },
    boxes: {
      71: box(10, 10, 778, 733)
    }
  });

  const result = await waitForCvCaptureTarget(client, {
    popup: {
      node_id: 10,
      selector: ".boss-popup__wrapper"
    }
  }, {
    timeoutMs: 100,
    intervalMs: 1,
    stabilityIntervalMs: 0
  });

  assert.equal(result.ok, true);
  assert.equal(result.target.node_id, 71);
  assert.equal(result.target.stability.sample_count, 2);
}

await testStandaloneResumeItemDetailIsRejected();
await testLargestMainCvWrapperWins();
await testIframeCvContentPreferredBeforePopup();
await testBroadPopupDoesNotBecomeCvTarget();
await testCvScopedContentSlotCanBeTarget();
await testGeometryMustBeStableAcrossSamples();
await testIdentityMustBeStableAcrossSamples();
await testWaitHandlesTransientMainPanelAbsence();

console.log("Core CV capture target tests passed");
