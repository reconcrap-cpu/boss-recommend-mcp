import assert from "node:assert/strict";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  createBossLoginRequiredError,
  createGuardedCdpClient,
  detectBossLoginState,
  enableDomains,
  isChromeDebugUnavailableError,
  isBossLoginUrl
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
await testUnexpectedDomainIsRejected();
testBossLoginUrlDetection();
testBossLoginRequiredErrorShape();
testChromeDebugUnavailableDetection();
await testBossLoginDomDetection();

console.log("CDP browser guard tests passed");
