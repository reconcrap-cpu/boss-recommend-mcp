import assert from "node:assert/strict";
import {
  classifyFavoriteControl,
  classifyGreetControl,
  clickRecommendActionControl,
  normalizeRecommendPostAction,
  resolveRecommendPostAction,
  runRecommendNonReplayableInputWithDeadline,
  summarizeRecommendActionControls
} from "./domains/recommend/actions.js";
import { GREET_CREDITS_EXHAUSTED_CODE } from "./core/greet-quota/index.js";

function exactControlDom(methods = {}, label = "打招呼") {
  let lastControlNodeId = 0;
  let lastControlBackendNodeId = 0;
  return {
    async getDocument() {
      return { root: { nodeId: 1, backendNodeId: 1 } };
    },
    async pushNodesByBackendIdsToFrontend({ backendNodeIds }) {
      lastControlBackendNodeId = Number(backendNodeIds[0]) || 0;
      lastControlNodeId = lastControlBackendNodeId - 1000;
      return {
        nodeIds: backendNodeIds.map((backendNodeId) => Number(backendNodeId) - 1000)
      };
    },
    async describeNode({ nodeId }) {
      if (Number(nodeId) > 1 && Number(nodeId) !== 10) lastControlNodeId = Number(nodeId);
      return {
        node: {
          nodeId,
          backendNodeId: nodeId + 1000,
          parentId: nodeId === 10 ? 0 : 10
        }
      };
    },
    async getAttributes() {
      return { attributes: ["class", "btn-greet"] };
    },
    async getOuterHTML() {
      return { outerHTML: `<button class="btn-greet">${label}</button>` };
    },
    async querySelectorAll() {
      return { nodeIds: [] };
    },
    async getNodeForLocation() {
      return {
        nodeId: lastControlNodeId,
        backendNodeId: lastControlBackendNodeId,
        frameId: "recommend-frame"
      };
    },
    ...methods
  };
}

function exactControlPage({ width = 100000, height = 100000 } = {}) {
  return {
    async getLayoutMetrics() {
      return {
        cssVisualViewport: {
          clientWidth: width,
          clientHeight: height,
          pageX: 0,
          pageY: 0,
          scale: 1
        }
      };
    }
  };
}

function testFavoriteClassification() {
  const active = classifyFavoriteControl({
    outerHTML: '<div class="like-icon-and-text"><span class="like-icon like-icon-active"></span><span>已感兴趣</span></div>',
    attributes: { class: "like-icon-and-text active" }
  });
  assert.equal(active.matches, true);
  assert.equal(active.active, true);
  assert.equal(active.disabled, false);

  const inactive = classifyFavoriteControl({
    outerHTML: '<div class="like-icon-and-text"><span>感兴趣</span></div>',
    attributes: { class: "like-icon-and-text" }
  });
  assert.equal(inactive.matches, true);
  assert.equal(inactive.active, false);
}

function testGreetClassification() {
  const greet = classifyGreetControl({
    outerHTML: '<button class="btn-v2 btn-sure-v2 btn-greet">打招呼</button>',
    attributes: { class: "btn-v2 btn-sure-v2 btn-greet" }
  });
  assert.equal(greet.matches, true);
  assert.equal(greet.available, true);
  assert.equal(greet.continue_chat, false);

  const continued = classifyGreetControl({
    outerHTML: '<button class="btn-v2">继续沟通</button>',
    attributes: { class: "btn-v2" }
  });
  assert.equal(continued.matches, true);
  assert.equal(continued.available, false);
  assert.equal(continued.continue_chat, true);

  const compoundAncestor = classifyGreetControl({
    outerHTML: '<div class="candidate-detail"><span>候选人资料</span><button>继续沟通</button></div>',
    attributes: { class: "candidate-detail" }
  });
  assert.equal(compoundAncestor.continue_chat, false);
  assert.equal(compoundAncestor.matches, false);

  const quotaGreet = classifyGreetControl({
    outerHTML: '<button class="btn-v2">立即沟通(30/20)</button>',
    attributes: { class: "btn-v2" }
  });
  assert.equal(quotaGreet.matches, true);
  assert.equal(quotaGreet.available, true);
  assert.equal(quotaGreet.greet_quota.exhausted, true);
}

async function testGreetQuotaClickGuard() {
  await assert.rejects(
    () => clickRecommendActionControl({}, {
      kind: "greet",
      label: "立即沟通(30/20)",
      center: { x: 1, y: 1 },
      node_id: 2
    }),
    (error) => error.code === GREET_CREDITS_EXHAUSTED_CODE
  );
}

async function testActionClickScrollsNodeIntoViewBeforeClick() {
  const events = [];
  const client = {
    Page: exactControlPage(),
    DOM: exactControlDom({
      async scrollIntoViewIfNeeded({ nodeId }) {
        events.push({ type: "scroll", nodeId });
        return {};
      },
      async getBoxModel({ nodeId }) {
        events.push({ type: "box", nodeId });
        return {
          model: {
            border: [100, 100, 200, 100, 200, 140, 100, 140]
          }
        };
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        events.push({ type: "mouse", event });
        return {};
      }
    }
  };
  const result = await clickRecommendActionControl(client, {
    kind: "greet",
    label: "打招呼",
    center: { x: 1199.5, y: -578.5 },
    node_id: 22,
    backend_node_id: 1022,
    root_node_id: 10,
    root_backend_node_id: 1010,
    disabled: false
  });
  assert.deepEqual(events.slice(0, 2), [
    { type: "scroll", nodeId: 22 },
    { type: "box", nodeId: 22 }
  ]);
  assert.deepEqual(result.center, { x: 150, y: 120 });
  assert.equal(events.some((item) => (
    item.type === "mouse"
    && item.event.type === "mousePressed"
    && item.event.x === 150
    && item.event.y === 120
  )), true);
}

async function testActionClickPersistsInFlightAfterFreshGeometryBeforeInput() {
  const events = [];
  const client = {
    Page: exactControlPage(),
    DOM: exactControlDom({
      async scrollIntoViewIfNeeded({ nodeId }) {
        events.push({ type: "scroll", nodeId });
      },
      async getBoxModel({ nodeId }) {
        events.push({ type: "box", nodeId });
        return {
          model: {
            border: [10, 20, 110, 20, 110, 60, 10, 60]
          }
        };
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        events.push({ type: "mouse", event });
      }
    }
  };
  await clickRecommendActionControl(client, {
    kind: "greet",
    label: "打招呼",
    node_id: 91,
    backend_node_id: 1091,
    root_node_id: 10,
    root_backend_node_id: 1010,
    disabled: false
  }, {
    beforeClick: async (evidence) => {
      events.push({ type: "journal", evidence });
    },
    immediatelyBeforeInput: async (evidence) => {
      events.push({ type: "final-hook", evidence });
    }
  });
  assert.deepEqual(events.slice(0, 3).map((item) => item.type), ["scroll", "box", "journal"]);
  assert.equal(events[2].evidence.node_id, 91);
  assert.equal(events[2].evidence.center.x, 60);
  const mouseIndex = events.findIndex((item, index) => index > 2 && item.type === "mouse");
  assert.equal(mouseIndex > 2, true);
  assert.equal(events.slice(3, mouseIndex).some((item) => item.type === "scroll"), true);
  assert.equal(events.slice(3, mouseIndex).some((item) => item.type === "box"), true);
  const finalHookIndex = events.findIndex((item) => item.type === "final-hook");
  assert.equal(finalHookIndex > 2, true);
  assert.equal(events[finalHookIndex].evidence.root_node_id, 10);
  assert.equal(events[finalHookIndex].evidence.center, null);
  assert.equal(events.slice(finalHookIndex + 1, mouseIndex).some((item) => item.type === "scroll"), false);
  assert.equal(events.slice(finalHookIndex + 1, mouseIndex).filter((item) => item.type === "box").length, 1);

  const blockedEvents = [];
  await assert.rejects(
    () => clickRecommendActionControl({
      DOM: client.DOM,
      Input: {
        async dispatchMouseEvent(event) {
          blockedEvents.push(event);
        }
      }
    }, {
      kind: "greet",
      label: "打招呼",
      node_id: 92,
      backend_node_id: 1092,
      root_node_id: 10,
      root_backend_node_id: 1010,
      disabled: false
    }, {
      beforeClick: async () => {
        throw new Error("critical journal persistence failed");
      }
    }),
    /critical journal persistence failed/
  );
  assert.deepEqual(blockedEvents, []);
}

async function testActionClickRefreshesGeometryAfterFinalNonScrollingHook() {
  const events = [];
  let xOffset = 0;
  const client = {
    Page: exactControlPage(),
    DOM: exactControlDom({
      async scrollIntoViewIfNeeded({ nodeId }) {
        events.push({ type: "control-scroll", nodeId });
      },
      async getBoxModel({ nodeId }) {
        events.push({ type: "box", nodeId, xOffset });
        return {
          model: {
            border: [
              10 + xOffset, 20,
              110 + xOffset, 20,
              110 + xOffset, 60,
              10 + xOffset, 60
            ]
          }
        };
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        events.push({ type: "mouse", event });
      }
    }
  };

  const result = await clickRecommendActionControl(client, {
    kind: "greet",
    label: "打招呼",
    node_id: 93,
    backend_node_id: 1093,
    root_node_id: 10,
    root_backend_node_id: 1010,
    disabled: false
  }, {
    immediatelyBeforeInput: async (controlAfterScroll) => {
      assert.equal(controlAfterScroll.scroll_allowed, true);
      assert.equal(controlAfterScroll.center, null);
      events.push({ type: "candidate-reproof" });
      // Model the candidate/root proof moving the viewport after the earlier
      // preliminary geometry was at x=60.
      xOffset = 200;
    }
  });

  assert.deepEqual(result.center, { x: 260, y: 40 });
  const candidateReproofIndex = events.findIndex((item) => item.type === "candidate-reproof");
  const firstInputIndex = events.findIndex((item) => item.type === "mouse");
  assert.equal(candidateReproofIndex >= 0, true);
  assert.equal(firstInputIndex > candidateReproofIndex, true);
  assert.equal(
    events.slice(candidateReproofIndex + 1, firstInputIndex)
      .some((item) => item.type === "control-scroll"),
    false
  );
  assert.deepEqual(
    events[firstInputIndex].event,
    { type: "mousePressed", x: 260, y: 40, button: "left", clickCount: 1 }
  );
}

async function testActionClickDoesNotUseCachedCenterAfterStaleScroll() {
  const inputEvents = [];
  const staleError = new Error("Could not find node with given id");
  staleError.cdp_method = "DOM.scrollIntoViewIfNeeded";
  staleError.cdp_connection_epoch = 3;
  staleError.cdp_replay_policy = "read_only";
  const client = {
    DOM: exactControlDom({
      async scrollIntoViewIfNeeded() {
        throw staleError;
      },
      async getBoxModel() {
        assert.fail("box model must not be read after stale scroll");
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
      }
    }
  };

  await assert.rejects(
    () => clickRecommendActionControl(client, {
      kind: "greet",
      label: "打招呼",
      center: { x: 999, y: 777 },
      node_id: 41,
      backend_node_id: 1041,
      root_node_id: 10,
      root_backend_node_id: 1010,
      selector: "button.btn-greet",
      root: "recommend-frame"
    }),
    (error) => {
      assert.equal(error.message, "Could not find node with given id");
      assert.equal(error.code, "RECOMMEND_ACTION_CONTROL_REFRESH_FAILED");
      assert.equal(error.phase, "recommend:post-action-control-refresh");
      assert.equal(error.action_control_refresh_step, "scroll_into_view");
      assert.equal(error.action_control.node_id, 41);
      assert.equal(error.cached_center_ignored, true);
      assert.equal(error.cdp_method, "DOM.scrollIntoViewIfNeeded");
      assert.equal(error.cdp_connection_epoch, 3);
      assert.equal(error.cdp_replay_policy, "read_only");
      return true;
    }
  );
  assert.deepEqual(inputEvents, []);
}

async function testActionClickDoesNotUseCachedCenterAfterStaleBoxRead() {
  const inputEvents = [];
  const staleError = new Error("Could not compute box model");
  staleError.cdp_method = "DOM.getBoxModel";
  staleError.cdp_outcome_unknown = false;
  staleError.cdp_connection_epoch = 7;
  const client = {
    DOM: exactControlDom({
      async scrollIntoViewIfNeeded() {
        return {};
      },
      async getBoxModel() {
        throw staleError;
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
      }
    }
  };

  await assert.rejects(
    () => clickRecommendActionControl(client, {
      kind: "greet",
      label: "打招呼",
      center: { x: 999, y: 777 },
      node_id: 42,
      backend_node_id: 1042,
      root_node_id: 10,
      root_backend_node_id: 1010
    }),
    (error) => {
      assert.equal(error.message, "Could not compute box model");
      assert.equal(error.code, "RECOMMEND_ACTION_CONTROL_REFRESH_FAILED");
      assert.equal(error.phase, "recommend:post-action-control-refresh");
      assert.equal(error.action_control_refresh_step, "read_box_model");
      assert.equal(error.cached_center_ignored, true);
      assert.equal(error.cdp_method, "DOM.getBoxModel");
      assert.equal(error.cdp_outcome_unknown, false);
      assert.equal(error.cdp_connection_epoch, 7);
      return true;
    }
  );
  assert.deepEqual(inputEvents, []);
}

async function testActionClickRejectsUnreadableFreshGeometry() {
  const inputEvents = [];
  const client = {
    DOM: exactControlDom({
      async scrollIntoViewIfNeeded() {
        return {};
      },
      async getBoxModel() {
        return {
          model: {
            border: [100, 100, 100, 100, 100, 140, 100, 140]
          }
        };
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
      }
    }
  };

  await assert.rejects(
    () => clickRecommendActionControl(client, {
      kind: "greet",
      label: "打招呼",
      center: { x: 999, y: 777 },
      node_id: 43,
      backend_node_id: 1043,
      root_node_id: 10,
      root_backend_node_id: 1010
    }),
    (error) => {
      assert.equal(error.code, "RECOMMEND_ACTION_CONTROL_GEOMETRY_UNREADABLE");
      assert.equal(error.phase, "recommend:post-action-control-refresh");
      assert.equal(error.action_control_refresh_step, "read_box_model");
      assert.equal(error.cdp_method, "DOM.getBoxModel");
      assert.equal(error.cdp_node_id, 43);
      assert.equal(error.cached_center_ignored, true);
      return true;
    }
  );
  assert.deepEqual(inputEvents, []);
}

function remappingControlDom({
  controlBackendNodeId = 1094,
  rootBackendNodeId = 1010
} = {}) {
  let generation = 0;
  let dropControlOnPush = false;
  const events = [];
  const frontendFor = (backendNodeId) => (
    Number(backendNodeId) - 1000 + (generation * 1000)
  );
  const dom = {
    async getDocument() {
      generation += 1;
      events.push({ type: "document", generation });
      return { root: { nodeId: 1, backendNodeId: 1 } };
    },
    async pushNodesByBackendIdsToFrontend({ backendNodeIds }) {
      events.push({ type: "push", generation, backendNodeIds: [...backendNodeIds] });
      return {
        nodeIds: backendNodeIds.map((backendNodeId) => (
          dropControlOnPush && Number(backendNodeId) === controlBackendNodeId
            ? 0
            : frontendFor(backendNodeId)
        ))
      };
    },
    async describeNode({ nodeId }) {
      const controlNodeId = frontendFor(controlBackendNodeId);
      const rootNodeId = frontendFor(rootBackendNodeId);
      if (Number(nodeId) === controlNodeId) {
        return {
          node: {
            nodeId: controlNodeId,
            backendNodeId: controlBackendNodeId,
            parentId: rootNodeId
          }
        };
      }
      if (Number(nodeId) === rootNodeId) {
        return {
          node: {
            nodeId: rootNodeId,
            backendNodeId: rootBackendNodeId,
            parentId: 0
          }
        };
      }
      throw new Error(`stale frontend node ${nodeId} in generation ${generation}`);
    },
    async getAttributes() {
      return { attributes: ["class", "btn-greet"] };
    },
    async getOuterHTML() {
      return { outerHTML: '<button class="btn-greet">打招呼</button>' };
    },
    async querySelectorAll() {
      return { nodeIds: [] };
    },
    async getNodeForLocation() {
      return {
        nodeId: frontendFor(controlBackendNodeId),
        backendNodeId: controlBackendNodeId,
        frameId: "recommend-frame"
      };
    },
    async scrollIntoViewIfNeeded({ nodeId }) {
      events.push({ type: "scroll", generation, nodeId });
      return {};
    },
    async getBoxModel({ nodeId }) {
      events.push({ type: "box", generation, nodeId });
      const x = generation * 100;
      return {
        model: {
          border: [x, 20, x + 100, 20, x + 100, 60, x, 60]
        }
      };
    }
  };
  return {
    dom,
    events,
    get generation() {
      return generation;
    },
    frontendFor,
    dropControl() {
      dropControlOnPush = true;
    }
  };
}

async function testActionClickRebindsAfterEveryCandidateProof() {
  const remap = remappingControlDom();
  const inputEvents = [];
  const client = {
    Page: exactControlPage(),
    DOM: remap.dom,
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
      }
    }
  };

  const result = await clickRecommendActionControl(client, {
    kind: "greet",
    label: "打招呼",
    node_id: 94,
    backend_node_id: 1094,
    root_node_id: 10,
    root_backend_node_id: 1010,
    disabled: false
  }, {
    beforeFinalRefresh: async () => {
      await remap.dom.getDocument();
    },
    beforeInput: async () => {
      await remap.dom.getDocument();
    },
    immediatelyBeforeInput: async () => {
      await remap.dom.getDocument();
    }
  });

  const finalGeneration = remap.generation;
  const pushEvents = remap.events.filter((event) => event.type === "push");
  assert.equal(finalGeneration >= 7, true);
  assert.equal(pushEvents.length >= 4, true);
  for (const pushEvent of pushEvents) {
    assert.deepEqual(pushEvent.backendNodeIds, [1094, 1010]);
    const eventIndex = remap.events.indexOf(pushEvent);
    assert.equal(remap.events[eventIndex - 1]?.type, "document");
    assert.equal(remap.events[eventIndex - 1]?.generation, pushEvent.generation);
  }
  assert.equal(result.node_id, remap.frontendFor(1094));
  assert.equal(result.root_node_id, remap.frontendFor(1010));
  assert.deepEqual(result.center, { x: finalGeneration * 100 + 50, y: 40 });
  assert.equal(inputEvents.filter((event) => event.type === "mousePressed").length, 1);
  assert.deepEqual(
    inputEvents.find((event) => event.type === "mousePressed"),
    {
      type: "mousePressed",
      x: finalGeneration * 100 + 50,
      y: 40,
      button: "left",
      clickCount: 1
    }
  );
}

async function testActionClickFailsClosedWhenBackendCannotRebindAfterProof() {
  const remap = remappingControlDom();
  const inputEvents = [];
  await assert.rejects(
    () => clickRecommendActionControl({
      DOM: remap.dom,
      Input: {
        async dispatchMouseEvent(event) {
          inputEvents.push(event);
        }
      }
    }, {
      kind: "greet",
      label: "打招呼",
      node_id: 94,
      backend_node_id: 1094,
      root_node_id: 10,
      root_backend_node_id: 1010,
      disabled: false
    }, {
      beforeFinalRefresh: async () => {
        remap.dropControl();
      }
    }),
    (error) => {
      assert.equal(error.code, "RECOMMEND_ACTION_CONTROL_REBIND_FAILED");
      assert.equal(error.phase, "recommend:post-action-control-refresh");
      assert.equal(error.action_control_refresh_step, "rebind_after_final_refresh");
      assert.equal(error.cdp_method, "DOM.pushNodesByBackendIdsToFrontend");
      return true;
    }
  );
  assert.deepEqual(inputEvents, []);
}

async function testActionClickDoesNotReplayUnknownBackendPushTransport() {
  const inputEvents = [];
  let pushCalls = 0;
  const transportError = new Error("WebSocket closed during backend push");
  transportError.cdp_method = "DOM.pushNodesByBackendIdsToFrontend";
  transportError.cdp_connection_epoch = 4;
  transportError.cdp_replay_policy = "not_allowlisted";
  transportError.cdp_outcome_unknown = true;
  const client = {
    Page: exactControlPage(),
    DOM: exactControlDom({
      async pushNodesByBackendIdsToFrontend() {
        pushCalls += 1;
        throw transportError;
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
      }
    }
  };

  await assert.rejects(
    () => clickRecommendActionControl(client, {
      kind: "greet",
      label: "打招呼",
      node_id: 95,
      backend_node_id: 1095,
      root_node_id: 10,
      root_backend_node_id: 1010,
      disabled: false
    }),
    (error) => {
      assert.equal(error.code, "RECOMMEND_ACTION_CONTROL_REFRESH_FAILED");
      assert.equal(error.action_control_refresh_step, "rebind_before_scroll");
      assert.equal(error.cdp_method, "DOM.pushNodesByBackendIdsToFrontend");
      assert.equal(error.cdp_replay_policy, "not_allowlisted");
      assert.equal(error.cdp_outcome_unknown, true);
      return true;
    }
  );
  assert.equal(pushCalls, 1);
  assert.deepEqual(inputEvents, []);
}

async function testActionClickUsesExactRootMembershipWhenPushedParentIsMissing() {
  const inputEvents = [];
  const scopeQueries = [];
  const client = {
    Page: exactControlPage(),
    DOM: exactControlDom({
      async describeNode({ nodeId }) {
        return {
          node: {
            nodeId,
            backendNodeId: nodeId + 1000,
            parentId: 0
          }
        };
      },
      async querySelectorAll({ nodeId, selector }) {
        scopeQueries.push({ nodeId, selector });
        return { nodeIds: [22] };
      },
      async scrollIntoViewIfNeeded() {
        return {};
      },
      async getBoxModel() {
        return {
          model: {
            border: [100, 100, 200, 100, 200, 140, 100, 140]
          }
        };
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
      }
    }
  };

  const result = await clickRecommendActionControl(client, {
    kind: "greet",
    label: "打招呼",
    node_id: 22,
    backend_node_id: 1022,
    root_node_id: 10,
    root_backend_node_id: 1010,
    disabled: false
  });

  assert.equal(result.clicked, true);
  assert.equal(scopeQueries.length > 0, true);
  assert.equal(
    scopeQueries.filter((query) => query.nodeId === 10)
      .every((query) => query.selector === "*"),
    true
  );
  assert.equal(
    scopeQueries.some((query) => query.nodeId === 22 && query.selector === "*"),
    true
  );
  assert.equal(inputEvents.filter((event) => event.type === "mousePressed").length, 1);
}

async function testActionClickFailsClosedWhenExactRootMembershipIsMissing() {
  const inputEvents = [];
  await assert.rejects(
    () => clickRecommendActionControl({
      DOM: exactControlDom({
        async describeNode({ nodeId }) {
          return {
            node: {
              nodeId,
              backendNodeId: nodeId + 1000,
              parentId: 0
            }
          };
        },
        async querySelectorAll() {
          return { nodeIds: [23, 24] };
        },
        async scrollIntoViewIfNeeded() {
          return {};
        },
        async getBoxModel() {
          assert.fail("geometry must not be read after scope membership failure");
        }
      }),
      Input: {
        async dispatchMouseEvent(event) {
          inputEvents.push(event);
        }
      }
    }, {
      kind: "greet",
      label: "打招呼",
      node_id: 22,
      backend_node_id: 1022,
      root_node_id: 10,
      root_backend_node_id: 1010,
      disabled: false
    }),
    (error) => {
      assert.equal(error.code, "RECOMMEND_ACTION_CONTROL_SCOPE_MISMATCH");
      assert.equal(error.phase, "recommend:post-action-control-refresh");
      assert.equal(error.action_control_refresh_step, "describe_before_scroll");
      assert.equal(error.cdp_method, "DOM.querySelectorAll");
      assert.deepEqual(error.cdp_param_keys, ["nodeId", "selector"]);
      return true;
    }
  );
  assert.deepEqual(inputEvents, []);
}

async function testActionClickUsesOnlyFreshExactHitTestedFallbackPoint() {
  const events = [];
  const hitCalls = [];
  const inputEvents = [];
  const client = {
    Page: {
      async getLayoutMetrics() {
        events.push({ type: "layout" });
        return {
          cssVisualViewport: { clientWidth: 1280, clientHeight: 720, pageX: 0, pageY: 0 }
        };
      }
    },
    DOM: exactControlDom({
      async scrollIntoViewIfNeeded() {},
      async getBoxModel() {
        return {
          model: { border: [100, 100, 200, 100, 200, 140, 100, 140] }
        };
      },
      async getNodeForLocation(args) {
        hitCalls.push(args);
        events.push({ type: "hit", args });
        return hitCalls.length === 1
          ? { nodeId: 999, backendNodeId: 1999, frameId: "recommend-frame" }
          : { nodeId: 22, backendNodeId: 1022, frameId: "recommend-frame" };
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
        events.push({ type: "input", event });
      }
    }
  };

  const result = await clickRecommendActionControl(client, {
    kind: "greet",
    label: "打招呼",
    node_id: 22,
    backend_node_id: 1022,
    root_node_id: 10,
    root_backend_node_id: 1010,
    disabled: false
  });

  assert.equal(hitCalls.length, 2);
  assert.deepEqual(hitCalls[0], {
    x: 150,
    y: 120,
    includeUserAgentShadowDOM: true
  });
  assert.equal(Object.hasOwn(hitCalls[0], "ignorePointerEventsNone"), false);
  assert.deepEqual(result.center, { x: 125, y: 120 });
  assert.equal(result.click_target_proof.verified, true);
  assert.equal(result.click_target_proof.attempts.length, 2);
  assert.equal(result.click_target_proof.attempts[0].exact_control_hit, false);
  assert.equal(result.click_target_proof.attempts[1].exact_control_hit, true);
  assert.equal(inputEvents.filter((event) => event.type === "mousePressed").length, 1);
  assert.deepEqual(inputEvents.map((event) => event.type), ["mousePressed", "mouseReleased"]);
  assert.equal(inputEvents.every((event) => event.x === 125 && event.y === 120), true);
  const successfulHitIndex = events.findLastIndex((event) => event.type === "hit");
  const firstInputIndex = events.findIndex((event) => event.type === "input");
  assert.equal(firstInputIndex, successfulHitIndex + 1);
}

async function testActionClickFailsClosedWhenEveryPointHitsForeignControl() {
  const inputEvents = [];
  let hitCalls = 0;
  await assert.rejects(
    () => clickRecommendActionControl({
      Page: exactControlPage({ width: 1280, height: 720 }),
      DOM: exactControlDom({
        async scrollIntoViewIfNeeded() {},
        async getBoxModel() {
          return {
            model: { border: [100, 100, 200, 100, 200, 140, 100, 140] }
          };
        },
        async getNodeForLocation() {
          hitCalls += 1;
          return { nodeId: 88, backendNodeId: 1088, frameId: "wrong-root-frame" };
        }
      }),
      Input: {
        async dispatchMouseEvent(event) {
          inputEvents.push(event);
        }
      }
    }, {
      kind: "greet",
      label: "打招呼",
      node_id: 22,
      backend_node_id: 1022,
      root_node_id: 10,
      root_backend_node_id: 1010,
      disabled: false
    }),
    (error) => {
      assert.equal(error.code, "RECOMMEND_ACTION_CONTROL_HIT_TEST_UNVERIFIED");
      assert.equal(error.recommend_pre_input_aborted, true);
      assert.equal(error.recommend_input_dispatched, false);
      assert.equal(error.cdp_method, "DOM.getNodeForLocation");
      assert.equal(error.recommend_action_control_hit_test.attempts.length, 5);
      assert.equal(
        error.recommend_action_control_hit_test.attempts
          .every((attempt) => attempt.hit_backend_node_id === 1088),
        true
      );
      return true;
    }
  );
  assert.equal(hitCalls, 5);
  assert.deepEqual(inputEvents, []);
}

async function testActionClickAcceptsOnlyBackendProvenExactControlDescendant() {
  const inputEvents = [];
  const client = {
    Page: exactControlPage({ width: 1280, height: 720 }),
    DOM: exactControlDom({
      async querySelectorAll({ nodeId, selector }) {
        return nodeId === 22 && selector === "*" ? { nodeIds: [23] } : { nodeIds: [] };
      },
      async scrollIntoViewIfNeeded() {},
      async getBoxModel() {
        return {
          model: { border: [100, 100, 200, 100, 200, 140, 100, 140] }
        };
      },
      async getNodeForLocation() {
        return { nodeId: 23, backendNodeId: 1023, frameId: "recommend-frame" };
      }
    }),
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
      }
    }
  };
  const result = await clickRecommendActionControl(client, {
    kind: "greet",
    label: "打招呼",
    node_id: 22,
    backend_node_id: 1022,
    root_node_id: 10,
    root_backend_node_id: 1010,
    disabled: false
  });
  assert.equal(result.click_target_proof.exact_control_hit_verified, true);
  assert.equal(result.click_target_proof.control_descendant_backend_count, 1);
  assert.equal(result.click_target_proof.attempts[0].hit_backend_node_id, 1023);
  assert.equal(inputEvents.filter((event) => event.type === "mousePressed").length, 1);
}

function testPostActionResolution() {
  assert.equal(normalizeRecommendPostAction("收藏"), "");
  assert.equal(normalizeRecommendPostAction("favorite"), "");
  assert.equal(normalizeRecommendPostAction("直接沟通"), "greet");
  assert.equal(normalizeRecommendPostAction("none"), "none");

  const limited = resolveRecommendPostAction({
    postAction: "greet",
    greetCount: 3,
    maxGreetCount: 3
  });
  assert.equal(limited.requested, "greet");
  assert.equal(limited.effective, "none");
  assert.equal(limited.reason, "greet_limit_reached");
}

function testSummary() {
  const summary = summarizeRecommendActionControls([
    {
      kind: "favorite",
      visible: true,
      matches: true,
      active: false,
      disabled: false,
      label: "感兴趣",
      selector: ".like-icon-and-text",
      root: "recommend-frame",
      node_id: 1,
      center: { x: 10, y: 20 }
    },
    {
      kind: "greet",
      visible: true,
      matches: true,
      available: true,
      continue_chat: false,
      disabled: false,
      label: "打招呼",
      selector: "button.btn-greet",
      root: "recommend-frame",
      node_id: 2,
      center: { x: 30, y: 40 }
    }
  ]);
  assert.equal(summary.favorite.found, true);
  assert.equal(summary.favorite.active, false);
  assert.equal(summary.greet.found, true);
  assert.equal(summary.greet.available, true);
  assert.equal(summary.counts.favorite, 1);
  assert.equal(summary.counts.greet, 1);
}

async function testNonReplayableInputTimeoutAbandonsBeforeReconnectAndNeverReplays() {
  let rejectPendingInput = null;
  let actionCalls = 0;
  let closeCalls = 0;
  let reconnectCalls = 0;
  const client = {
    async close() {
      closeCalls += 1;
      rejectPendingInput?.(new Error("old transport closed"));
      return true;
    },
    async __abandonAndReconnect() {
      reconnectCalls += 1;
      return { reconnected: true, previous_connection_epoch: 1, connection_epoch: 2 };
    }
  };
  await assert.rejects(
    runRecommendNonReplayableInputWithDeadline(client, () => {
      actionCalls += 1;
      return new Promise((resolve, reject) => {
        rejectPendingInput = reject;
      });
    }, {
      timeoutMs: 15,
      closeTimeoutMs: 100,
      settlementTimeoutMs: 100
    }),
    (error) => {
      assert.equal(error.code, "RECOMMEND_ACTION_INPUT_TIMEOUT");
      assert.equal(error.cdp_method, "Input.dispatchMouseEvent");
      assert.equal(error.cdp_outcome_unknown, true);
      assert.equal(error.cdp_replay_suppressed, true);
      assert.equal(error.recommend_input_dispatched, true);
      assert.equal(error.recommend_input_transport_contained, true);
      assert.equal(error.recommend_input_transport_abandon_failed, false);
      assert.equal(error.input_timeout_diagnostic.reconnect_succeeded, true);
      return true;
    }
  );
  assert.equal(actionCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(reconnectCalls, 1);
}

testFavoriteClassification();
testGreetClassification();
await testGreetQuotaClickGuard();
await testActionClickScrollsNodeIntoViewBeforeClick();
await testActionClickPersistsInFlightAfterFreshGeometryBeforeInput();
await testActionClickRefreshesGeometryAfterFinalNonScrollingHook();
await testActionClickDoesNotUseCachedCenterAfterStaleScroll();
await testActionClickDoesNotUseCachedCenterAfterStaleBoxRead();
await testActionClickRejectsUnreadableFreshGeometry();
await testActionClickRebindsAfterEveryCandidateProof();
await testActionClickFailsClosedWhenBackendCannotRebindAfterProof();
await testActionClickDoesNotReplayUnknownBackendPushTransport();
await testActionClickUsesExactRootMembershipWhenPushedParentIsMissing();
await testActionClickFailsClosedWhenExactRootMembershipIsMissing();
await testActionClickUsesOnlyFreshExactHitTestedFallbackPoint();
await testActionClickFailsClosedWhenEveryPointHitsForeignControl();
await testActionClickAcceptsOnlyBackendProvenExactControlDescendant();
await testNonReplayableInputTimeoutAbandonsBeforeReconnectAndNeverReplays();
testPostActionResolution();
testSummary();

console.log("recommend action tests passed");
