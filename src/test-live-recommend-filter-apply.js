import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  exactCurrentCityState,
  exactGroupState,
  loadRuntime,
  parseArgs
} from "../scripts/live-recommend-filter-apply.js";

const defaults = parseArgs([]);
assert.equal(defaults.currentCityOnly, true);
assert.equal(defaults.activityLevel, "今日活跃");
assert.deepEqual(defaults.schoolTags, ["985", "211"]);
assert.deepEqual(defaults.degreeLabels, ["本科", "硕士", "博士"]);
assert.equal(defaults.cooldownMs, 3000);
assert.equal(fs.existsSync(path.join(defaults.runtimeRoot, "package.json")), true);

const unpaced = parseArgs([
  "--cooldown-ms", "0",
  "--school-tags", "985，211/985",
  "--degrees", "本科，硕士/博士|本科"
]);
assert.equal(unpaced.cooldownMs, 0);
assert.deepEqual(unpaced.schoolTags, ["985", "211"]);
assert.deepEqual(unpaced.degreeLabels, ["本科", "硕士", "博士"]);

const explicitRuntimeRoot = parseArgs(["--runtime-root", "."]);
assert.equal(explicitRuntimeRoot.runtimeRoot, path.resolve("."));
assert.throws(
  () => parseArgs(["--runtime-root", ""]),
  /Runtime root is required/
);

const harnessSource = fs.readFileSync(
  new URL("../scripts/live-recommend-filter-apply.js", import.meta.url),
  "utf8"
);
assert.doesNotMatch(harnessSource, /from\s+["']\.\.\/src\//);
assert.match(harnessSource, /applied-current-city\.png/);
assert.match(harnessSource, /findRecommendCurrentCityControl/);
assert.match(harnessSource, /pressKey\(client, "Escape"/);

const loadedRuntime = await loadRuntime(defaults.runtimeRoot);
const workspacePackage = JSON.parse(fs.readFileSync(
  path.join(defaults.runtimeRoot, "package.json"),
  "utf8"
));
assert.equal(loadedRuntime.root, fs.realpathSync(defaults.runtimeRoot));
assert.equal(loadedRuntime.package_name, workspacePackage.name);
assert.equal(loadedRuntime.package_version, workspacePackage.version);

const checkedCurrentCity = exactCurrentCityState({
  readable: true,
  node_id: 12,
  state: {
    checked: true,
    source: "node_12.class",
    state_node_id: 12
  }
}, true);
assert.deepEqual(checkedCurrentCity, {
  expected: true,
  actual: true,
  readable: true,
  verified: true,
  state_source: "node_12.class",
  node_id: 12,
  state_node_id: 12
});
assert.equal(exactCurrentCityState({
  readable: true,
  state: { checked: false, source: "node_13.unchecked_class" }
}, true).verified, false);
assert.equal(exactCurrentCityState({
  readable: false,
  state: { checked: null, source: "unreadable" }
}, true).verified, false);

assert.throws(
  () => parseArgs(["--cooldown-ms", "-1"]),
  /non-negative integer/
);
assert.throws(
  () => parseArgs(["--degrees", "本科,学士"]),
  /Unsupported degree: 学士/
);

const exactDegree = exactGroupState([
  { label: "不限", active: false },
  { label: "本科", active: true },
  { label: "硕士", active: true },
  { label: "博士", active: true }
], ["本科", "硕士", "博士"]);
assert.equal(exactDegree.verified, true);
assert.deepEqual(exactDegree.active.sort(), exactDegree.desired.sort());

const extraActiveDegree = exactGroupState([
  { label: "大专", active: true },
  { label: "本科", active: true },
  { label: "硕士", active: true },
  { label: "博士", active: true }
], ["本科", "硕士", "博士"]);
assert.equal(extraActiveDegree.verified, false);

const missingDegree = exactGroupState([
  { label: "本科", active: true },
  { label: "硕士", active: true },
  { label: "博士", active: false }
], ["本科", "硕士", "博士"]);
assert.equal(missingDegree.verified, false);

console.log("Live recommend filter-apply harness tests passed");
