import assert from "node:assert/strict";
import { shouldContinueRecruitPassedTarget } from "./domains/recruit/run-service.js";

assert.equal(
  shouldContinueRecruitPassedTarget({ passedCount: 0, targetCount: 2 }),
  true
);
assert.equal(
  shouldContinueRecruitPassedTarget({ passedCount: 1, targetCount: 2 }),
  true,
  "search must continue after many processed candidates when only one has passed"
);
assert.equal(
  shouldContinueRecruitPassedTarget({ passedCount: 2, targetCount: 2 }),
  false
);
assert.equal(
  shouldContinueRecruitPassedTarget({ passedCount: 10, targetCount: 2 }),
  false
);

console.log("Recruit/search passed-target semantics regression tests passed.");
