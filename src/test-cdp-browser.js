import assert from "node:assert/strict";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  chunkHumanText,
  clickPoint,
  clickNodeCenter,
  configureHumanInteraction,
  createHumanRestController,
  createBossLoginRequiredError,
  createGuardedCdpClient,
  detectBossLoginState,
  enableDomains,
  generateBezierPath,
  humanDelay,
  insertText,
  isChromeDebugUnavailableError,
  isBossLoginUrl,
  normalizeHumanBehaviorOptions,
  resolveHumanClickPointForBox,
  simulateHumanClick
} from "./core/browser/index.js";

async function testRuntimeDomainIsBlockedBeforeTransport() {
  let runtimeWasCalled = false;
  const methodLog = [];
  const guarded = createGuardedCdpClient({
    Runtime: {
      async evaluate() {
        runtimeWasCalled = true;
      }
    }
  }, { methodLog });

  const result = await assertRuntimeEvaluateBlocked(guarded);
  assert.equal(result.blocked, true);
  assert.equal(runtimeWasCalled, false);
  assert.deepEqual(methodLog, []);
}

async function testAllowedDomainsAreLogged() {
  const methodLog = [];
  const guarded = createGuardedCdpClient({
    Page: {
      async enable() {
        return { ok: true };
      }
    },
    DOM: {
      async enable() {
        return { ok: true };
      }
    }
  }, { methodLog });

  await enableDomains(guarded, ["Page", "DOM"]);
  assert.deepEqual(methodLog.map((entry) => entry.method), ["Page.enable", "DOM.enable"]);
  assertNoForbiddenCdpCalls(methodLog);
}

async function testGuardedClientReconnectsClosedTransport() {
  const calls = [];
  const methodLog = [];
  const listener = () => {};
  function makeClient(name, { failGetBody = false } = {}) {
    return {
      Page: {
        async enable() {
          calls.push(`${name}:Page.enable`);
          return {};
        },
        async bringToFront() {
          calls.push(`${name}:Page.bringToFront`);
          return {};
        }
      },
      Network: {
        async enable() {
          calls.push(`${name}:Network.enable`);
          return {};
        },
        async setCacheDisabled(params) {
          calls.push(`${name}:Network.setCacheDisabled:${params.cacheDisabled}`);
          return {};
        },
        responseReceived(nextListener) {
          calls.push(`${name}:Network.responseReceived:${nextListener === listener}`);
        },
        async getResponseBody() {
          calls.push(`${name}:Network.getResponseBody`);
          if (failGetBody) {
            throw new Error("WebSocket is not open: readyState 3 (CLOSED)");
          }
          return { body: name };
        }
      },
      async close() {
        calls.push(`${name}:close`);
      }
    };
  }

  const first = makeClient("first", { failGetBody: true });
  const second = makeClient("second");
  const guarded = createGuardedCdpClient(first, {
    methodLog,
    reconnect: async () => second
  });

  await enableDomains(guarded, ["Page", "Network"]);
  await guarded.Page.bringToFront();
  await guarded.Network.setCacheDisabled({ cacheDisabled: true });
  guarded.Network.responseReceived(listener);

  const result = await guarded.Network.getResponseBody({ requestId: "1" });
  assert.deepEqual(result, { body: "second" });
  assert.deepEqual(calls, [
    "first:Page.enable",
    "first:Network.enable",
    "first:Page.bringToFront",
    "first:Network.setCacheDisabled:true",
    "first:Network.responseReceived:true",
    "first:Network.getResponseBody",
    "second:Page.enable",
    "second:Network.enable",
    "second:Page.bringToFront",
    "second:Network.setCacheDisabled:true",
    "second:Network.responseReceived:true",
    "second:Network.getResponseBody"
  ]);
  assert.ok(methodLog.some((entry) => entry.method === "Network.getResponseBody:retry_after_reconnect"));
  assertNoForbiddenCdpCalls(methodLog);
}

async function testUnexpectedDomainIsRejected() {
  const guarded = createGuardedCdpClient({
    Runtime: {
      async enable() {
        return { ok: true };
      }
    }
  });
  await assert.rejects(
    () => enableDomains(guarded, ["Runtime"]),
    /not allowed/
  );
}

function testBossLoginUrlDetection() {
  assert.equal(isBossLoginUrl("https://www.zhipin.com/web/user/?ka=bticket"), true);
  assert.equal(isBossLoginUrl("https://passport.zhipin.com/login"), true);
  assert.equal(isBossLoginUrl("https://www.zhipin.com/web/chat/recommend"), false);
}

function testBossLoginRequiredErrorShape() {
  const error = createBossLoginRequiredError({
    domain: "recommend",
    currentUrl: "https://www.zhipin.com/web/user/?ka=bticket",
    targetUrl: "https://www.zhipin.com/web/chat/recommend",
    loginDetection: { requires_login: true, reason: "url" },
    chrome: { launched: true, port: 9222 }
  });
  assert.equal(error.code, "BOSS_LOGIN_REQUIRED");
  assert.equal(error.requires_login, true);
  assert.equal(error.retryable, true);
  assert.equal(error.login_url.includes("zhipin.com/web/user"), true);
  assert.equal(error.login_detection.reason, "url");
  assert.equal(error.chrome.launched, true);
}

function testChromeDebugUnavailableDetection() {
  assert.equal(isChromeDebugUnavailableError(new Error("connect ECONNREFUSED 127.0.0.1:9222")), true);
  assert.equal(isChromeDebugUnavailableError(new Error("No matching Chrome target found")), false);
}

function createSequenceRandom(values = []) {
  let index = 0;
  return () => {
    const value = values[index] ?? 0.5;
    index += 1;
    return value;
  };
}

function testHumanDelayAndBezierPath() {
  const delay = humanDelay(260, 0, { minMs: 100, random: createSequenceRandom([0.5]) });
  assert.equal(delay, 260);
  const path = generateBezierPath({ x: 0, y: 0 }, { x: 30, y: 15 }, {
    steps: 3,
    random: createSequenceRandom([0.5, 0.5]),
    controlJitterX: 0,
    controlJitterY: 0
  });
  assert.equal(path.length, 4);
  assert.deepEqual(path[0], { x: 0, y: 0 });
  assert.deepEqual(path[path.length - 1], { x: 30, y: 15 });
}

async function testSimulateHumanClickUsesOnlyInputCdp() {
  const events = [];
  const methodLog = [];
  const guarded = createGuardedCdpClient({
    Input: {
      async dispatchMouseEvent(params) {
        events.push(params);
        return {};
      }
    }
  }, { methodLog });
  const result = await simulateHumanClick(guarded, 100, 120, {
    startPoint: { x: 20, y: 30 },
    random: createSequenceRandom(Array.from({ length: 80 }, () => 0.5)),
    sleepFn: async () => {},
    moveSteps: 4,
    moveDelayMinMs: 0,
    moveDelayMaxMs: 0,
    hoverDelayMinMs: 0,
    hoverDelayMaxMs: 0,
    prePressBaseMs: 0,
    prePressVarianceMs: 0,
    holdVarianceMs: 0,
    delayMs: 0
  });
  assert.equal(result.mode, "human");
  assert.equal(result.path_points, 5);
  assert.equal(events.some((event) => event.type === "mousePressed"), true);
  assert.equal(events.some((event) => event.type === "mouseReleased"), true);
  assert.equal(events.filter((event) => event.type === "mouseMoved").length > 3, true);
  assert.deepEqual([...new Set(methodLog.map((entry) => entry.method))], ["Input.dispatchMouseEvent"]);
  assertNoForbiddenCdpCalls(methodLog);
}

async function testConfiguredHumanInteractionControlsClickPoint() {
  const events = [];
  const guarded = createGuardedCdpClient({
    Input: {
      async dispatchMouseEvent(params) {
        events.push(params);
        return {};
      }
    }
  });
  await clickPoint(guarded, 10, 10, { delayMs: 0 });
  assert.deepEqual(events.map((event) => event.type), ["mouseMoved", "mousePressed", "mouseReleased"]);

  events.length = 0;
  configureHumanInteraction(guarded, {
    enabled: true,
    random: createSequenceRandom(Array.from({ length: 80 }, () => 0.5)),
    sleepFn: async () => {},
    moveSteps: 2,
    moveDelayMinMs: 0,
    moveDelayMaxMs: 0,
    hoverDelayMinMs: 0,
    hoverDelayMaxMs: 0,
    prePressBaseMs: 0,
    prePressVarianceMs: 0,
    holdVarianceMs: 0
  });
  await clickPoint(guarded, 10, 10, { delayMs: 0 });
  assert.equal(events.filter((event) => event.type === "mouseMoved").length > 1, true);
  assert.equal(events.at(-2).type, "mousePressed");
  assert.equal(events.at(-1).type, "mouseReleased");
}

function testHumanBehaviorNormalization() {
  const defaultBehavior = normalizeHumanBehaviorOptions();
  assert.equal(defaultBehavior.enabled, true);
  assert.equal(defaultBehavior.profile, "paced_with_rests");
  assert.equal(defaultBehavior.restEnabled, true);
  assert.equal(defaultBehavior.clickMovement, true);
  assert.equal(defaultBehavior.textEntry, true);
  assert.equal(defaultBehavior.listScrollJitter, true);

  const explicitBaseline = normalizeHumanBehaviorOptions({ profile: "baseline" });
  assert.equal(explicitBaseline.enabled, false);
  assert.equal(explicitBaseline.restEnabled, false);

  const paced = normalizeHumanBehaviorOptions({ profile: "paced" });
  assert.equal(paced.enabled, true);
  assert.equal(paced.clickMovement, true);
  assert.equal(paced.textEntry, true);
  assert.equal(paced.listScrollJitter, true);
  assert.equal(paced.restEnabled, false);

  const legacy = normalizeHumanBehaviorOptions(null, { legacyEnabled: true });
  assert.equal(legacy.profile, "paced_with_rests");
  assert.equal(legacy.restEnabled, true);
  assert.equal(legacy.shortRest, true);
  assert.equal(legacy.batchRest, true);

  const safePacing = normalizeHumanBehaviorOptions(null, { safePacing: true });
  assert.equal(safePacing.profile, "paced");
  assert.equal(safePacing.actionCooldown, true);
  assert.equal(safePacing.restEnabled, false);
}

async function testHumanClickPointAndChunkedText() {
  const point = resolveHumanClickPointForBox({
    center: { x: 50, y: 20 },
    rect: { x: 0, y: 0, width: 100, height: 40 }
  }, {
    random: createSequenceRandom([0, 1]),
    safeClickInsetRatio: 0.2,
    safeClickMinInsetPx: 4,
    safeClickMaxInsetPx: 20
  });
  assert.equal(point.mode, "safe_inset");
  assert.equal(point.x, 20);
  assert.equal(point.y, 32);

  const smallPoint = resolveHumanClickPointForBox({
    center: { x: 10, y: 10 },
    rect: { x: 0, y: 0, width: 20, height: 20 }
  });
  assert.equal(smallPoint.mode, "center");
  assert.equal(smallPoint.x, 10);

  const chunks = chunkHumanText("abcdef", {
    random: createSequenceRandom([0, 0, 0]),
    minLength: 2,
    maxLength: 2
  });
  assert.deepEqual(chunks, ["ab", "cd", "ef"]);

  const inserted = [];
  const sleeps = [];
  const mouseEvents = [];
  const guarded = createGuardedCdpClient({
    Input: {
      async insertText(params) {
        inserted.push(params.text);
      },
      async dispatchMouseEvent(params) {
        mouseEvents.push(params);
      }
    },
    DOM: {
      async scrollIntoViewIfNeeded() {},
      async getBoxModel() {
        return {
          model: {
            border: [0, 0, 100, 0, 100, 40, 0, 40]
          }
        };
      }
    }
  });
  configureHumanInteraction(guarded, {
    enabled: true,
    random: createSequenceRandom(Array.from({ length: 20 }, () => 0)),
    sleepFn: async (ms) => sleeps.push(ms),
    moveSteps: 1,
    moveDelayMinMs: 0,
    moveDelayMaxMs: 0,
    hoverDelayMinMs: 0,
    hoverDelayMaxMs: 0,
    prePressBaseMs: 0,
    prePressVarianceMs: 0,
    holdVarianceMs: 0,
    textChunkMinLength: 2,
    textChunkMaxLength: 2,
    textChunkDelayBaseMs: 0,
    textChunkDelayVarianceMs: 0
  });
  const textResult = await insertText(guarded, "abcdef");
  assert.equal(textResult.mode, "chunked");
  assert.deepEqual(inserted, ["ab", "cd", "ef"]);

  inserted.length = 0;
  mouseEvents.length = 0;
  const humanClickBox = await clickNodeCenter(guarded, 1, { delayMs: 0 });
  const press = mouseEvents.find((event) => event.type === "mousePressed");
  assert.equal(inserted.length, 0);
  assert.deepEqual(sleeps, []);
  assert.ok(press);
  assert.notEqual(Math.round(press.x), 50);
  assert.equal(humanClickBox.click_target.mode, "safe_inset");

  mouseEvents.length = 0;
  const deterministicClickBox = await clickNodeCenter(guarded, 1, {
    delayMs: 0,
    humanRestEnabled: false
  });
  const deterministicPress = mouseEvents.find((event) => event.type === "mousePressed");
  assert.ok(deterministicPress);
  assert.equal(Math.round(deterministicPress.x), 50);
  assert.equal(Math.round(deterministicPress.y), 20);
  assert.equal(deterministicClickBox.click_target.mode, "center");
  assert.equal(deterministicClickBox.click_result.mode, "direct");
}

async function testHumanRestController() {
  const sleepCalls = [];
  const disabled = createHumanRestController({ enabled: false });
  const disabledResult = await disabled.takeBreakIfNeeded({
    sleepFn: async (ms) => sleepCalls.push(ms)
  });
  assert.equal(disabledResult.rested, false);
  assert.deepEqual(sleepCalls, []);

  const noRestFeatures = createHumanRestController({
    enabled: true,
    shortRestEnabled: false,
    batchRestEnabled: false,
    random: createSequenceRandom(Array.from({ length: 10 }, () => 0)),
    shortRestProbability: 1,
    batchThresholdBase: 1,
    batchThresholdJitter: 1
  });
  const noRestResult = await noRestFeatures.takeBreakIfNeeded({
    sleepFn: async (ms) => sleepCalls.push(ms)
  });
  assert.equal(noRestResult.rested, false);
  assert.deepEqual(sleepCalls, []);

  const enabled = createHumanRestController({
    enabled: true,
    random: createSequenceRandom(Array.from({ length: 20 }, () => 0)),
    shortRestProbability: 1,
    shortRestMinMs: 10,
    shortRestMaxMs: 10,
    batchThresholdBase: 2,
    batchThresholdJitter: 1,
    batchRestMinMs: 20,
    batchRestMaxMs: 20
  });
  const first = await enabled.takeBreakIfNeeded({ sleepFn: async (ms) => sleepCalls.push(ms) });
  const second = await enabled.takeBreakIfNeeded({ sleepFn: async (ms) => sleepCalls.push(ms) });
  assert.equal(first.rested, true);
  assert.equal(second.events.some((event) => event.kind === "batch_rest"), true);
  assert.deepEqual(sleepCalls, [10, 10, 20]);
  assert.equal(enabled.getState().rest_count, 3);
  assert.equal(enabled.getState().total_rest_ms, 40);
}

async function testBossLoginDomDetection() {
  const queriedSelectors = [];
  const client = {
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelector({ selector }) {
        queriedSelectors.push(selector);
        return { nodeId: selector === ".login-box" ? 2 : 0 };
      },
      async getOuterHTML() {
        return { outerHTML: '<main><div class="login-box">扫码登录 Boss登录</div></main>' };
      }
    }
  };
  const state = await detectBossLoginState(client, {
    currentUrl: "https://www.zhipin.com/web/chat/recommend"
  });
  assert.equal(state.requires_login, true);
  assert.equal(state.reason, "dom");
  assert.ok(state.matched_selectors.includes(".login-box"));
  assert.ok(queriedSelectors.length > 0);
}

await testRuntimeDomainIsBlockedBeforeTransport();
await testAllowedDomainsAreLogged();
await testGuardedClientReconnectsClosedTransport();
await testUnexpectedDomainIsRejected();
testBossLoginUrlDetection();
testBossLoginRequiredErrorShape();
testChromeDebugUnavailableDetection();
testHumanDelayAndBezierPath();
await testSimulateHumanClickUsesOnlyInputCdp();
await testConfiguredHumanInteractionControlsClickPoint();
testHumanBehaviorNormalization();
await testHumanClickPointAndChunkedText();
await testHumanRestController();
await testBossLoginDomDetection();

console.log("CDP browser guard tests passed");
