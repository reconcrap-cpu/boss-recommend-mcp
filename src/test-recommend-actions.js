import assert from "node:assert/strict";
import {
  classifyFavoriteControl,
  classifyGreetControl,
  clickRecommendActionControl,
  normalizeRecommendPostAction,
  resolveRecommendPostAction,
  summarizeRecommendActionControls
} from "./domains/recommend/actions.js";
import { GREET_CREDITS_EXHAUSTED_CODE } from "./core/greet-quota/index.js";

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
    DOM: {
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
    },
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

async function testActionClickDoesNotUseCachedCenterAfterStaleScroll() {
  const inputEvents = [];
  const staleError = new Error("Could not find node with given id");
  staleError.cdp_method = "DOM.scrollIntoViewIfNeeded";
  staleError.cdp_connection_epoch = 3;
  staleError.cdp_replay_policy = "read_only";
  const client = {
    DOM: {
      async scrollIntoViewIfNeeded() {
        throw staleError;
      },
      async getBoxModel() {
        assert.fail("box model must not be read after stale scroll");
      }
    },
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
    DOM: {
      async scrollIntoViewIfNeeded() {
        return {};
      },
      async getBoxModel() {
        throw staleError;
      }
    },
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
      node_id: 42
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
    DOM: {
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
    },
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
      node_id: 43
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

testFavoriteClassification();
testGreetClassification();
await testGreetQuotaClickGuard();
await testActionClickScrollsNodeIntoViewBeforeClick();
await testActionClickDoesNotUseCachedCenterAfterStaleScroll();
await testActionClickDoesNotUseCachedCenterAfterStaleBoxRead();
await testActionClickRejectsUnreadableFreshGeometry();
testPostActionResolution();
testSummary();

console.log("recommend action tests passed");
