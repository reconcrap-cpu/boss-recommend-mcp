#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  assertGreetQuotaAvailable,
  describeGreetQuotaAfterSpend,
  GREET_CREDITS_EXHAUSTED_CODE,
  parseGreetQuota
} from "./core/greet-quota/index.js";

function testQuotaParsing() {
  assert.deepEqual(parseGreetQuota("立即沟通(30/135)"), {
    found: true,
    text: "立即沟通(30/135)",
    numerator: 30,
    denominator: 135,
    exhausted: false
  });
  assert.deepEqual(parseGreetQuota("立即沟通（30／20）"), {
    found: true,
    text: "立即沟通（30／20）",
    numerator: 30,
    denominator: 20,
    exhausted: true
  });
  assert.equal(parseGreetQuota("打招呼").found, false);
}

function testQuotaGuard() {
  assert.equal(assertGreetQuotaAvailable("立即沟通(30/135)").exhausted, false);
  assert.throws(
    () => assertGreetQuotaAvailable("立即沟通(30/20)"),
    (error) => error.code === GREET_CREDITS_EXHAUSTED_CODE
      && error.greet_quota?.numerator === 30
      && error.greet_quota?.denominator === 20
  );
}

function testQuotaAfterSpend() {
  assert.deepEqual(describeGreetQuotaAfterSpend("立即沟通(30/69)"), {
    found: true,
    text: "立即沟通(30/69)",
    numerator: 30,
    denominator: 69,
    exhausted: false,
    remaining_after_spend: 39,
    exhausted_after_spend: false
  });
  assert.deepEqual(describeGreetQuotaAfterSpend("立即沟通(30/39)"), {
    found: true,
    text: "立即沟通(30/39)",
    numerator: 30,
    denominator: 39,
    exhausted: false,
    remaining_after_spend: 9,
    exhausted_after_spend: true
  });
}

testQuotaParsing();
testQuotaGuard();
testQuotaAfterSpend();

console.log("core greet quota tests passed");
