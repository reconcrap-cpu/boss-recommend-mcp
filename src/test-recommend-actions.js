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
testPostActionResolution();
testSummary();

console.log("recommend action tests passed");
