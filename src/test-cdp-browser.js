import assert from "node:assert/strict";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  createGuardedCdpClient,
  enableDomains
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

await testRuntimeDomainIsBlockedBeforeTransport();
await testAllowedDomainsAreLogged();
await testUnexpectedDomainIsRejected();

console.log("CDP browser guard tests passed");
