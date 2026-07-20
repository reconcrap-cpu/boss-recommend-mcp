import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const scannerPath = path.join(process.cwd(), "scripts", "scan-forbidden-runtime.js");
const boundaryScannerPath = path.join(process.cwd(), "scripts", "scan-legacy-boundary.js");
const packageBoundaryScannerPath = path.join(process.cwd(), "scripts", "scan-package-boundary.js");
const phase9GatePath = path.join(process.cwd(), "scripts", "phase9-static-gate.js");
const scannerSource = fs.readFileSync(scannerPath, "utf8");

for (const patternId of [
  "page-dollar-eval",
  "page-evaluate-on-new-document",
  "playwright-add-init-script",
  "page-add-script-to-evaluate",
  "global-eval",
  "function-constructor",
  "script-element-injection",
  "script-markup-injection",
  "javascript-navigation-call",
  "javascript-browser-navigation",
  "javascript-location-assignment",
  "page-js-file"
]) {
  assert.ok(scannerSource.includes(patternId), `runtime scanner is missing ${patternId}`);
}
assert.match(scannerSource, /subdirs: \["bin", "src", "scripts", "legacy", "vendor"\]/);

function runScanner(args = []) {
  return spawnSync(process.execPath, [scannerPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

const jsonRun = runScanner(["--json", "--repo-only"]);
assert.equal(jsonRun.status, 0, jsonRun.stderr || jsonRun.stdout);

const report = JSON.parse(jsonRun.stdout);
assert.equal(report.summary.reachable_findings, 0);
assert.equal(report.summary.active_findings, 0);
assert.equal(report.summary.strict_gate, "pass");
assert.equal(
  report.summary.raw_active_findings,
  report.summary.legacy_quarantined_findings
);
assert.ok(report.summary.raw_active_findings > 0);
assert.equal(report.summary.allowed_findings, 0);
assert.ok(report.findings.every((finding) => finding.status !== "active"));
assert.ok(report.findings.some((finding) => finding.status === "legacy-quarantined"));

const strictRun = runScanner(["--fail-on-findings", "--repo-only"]);
assert.equal(strictRun.status, 0, strictRun.stderr || strictRun.stdout);

const legacyRun = runScanner(["--fail-on-legacy", "--repo-only"]);
assert.equal(legacyRun.status, 1);

const packageSurfaceRun = runScanner(["--json", "--package-surface"]);
assert.equal(packageSurfaceRun.status, 0, packageSurfaceRun.stderr || packageSurfaceRun.stdout);

const packageSurfaceReport = JSON.parse(packageSurfaceRun.stdout);
assert.equal(packageSurfaceReport.summary.reachable_findings, 0);
assert.equal(packageSurfaceReport.summary.active_findings, 0);
assert.equal(packageSurfaceReport.summary.raw_active_findings, 0);
assert.equal(packageSurfaceReport.summary.legacy_quarantined_findings, 0);
assert.equal(packageSurfaceReport.summary.allowed_findings, 0);
assert.equal(packageSurfaceReport.summary.strict_gate, "pass");

const packageStrictRun = runScanner(["--package-surface", "--fail-on-legacy"]);
assert.equal(packageStrictRun.status, 0, packageStrictRun.stderr || packageStrictRun.stdout);

const boundaryRun = spawnSync(process.execPath, [boundaryScannerPath, "--json"], {
  cwd: process.cwd(),
  encoding: "utf8"
});
assert.equal(boundaryRun.status, 0, boundaryRun.stderr || boundaryRun.stdout);
const boundaryReport = JSON.parse(boundaryRun.stdout);
assert.equal(boundaryReport.summary.strict_gate, "pass");
assert.equal(boundaryReport.summary.findings, 0);
assert.ok(boundaryReport.summary.active_files_scanned > 0);

const packageBoundaryRun = spawnSync(process.execPath, [packageBoundaryScannerPath, "--json"], {
  cwd: process.cwd(),
  encoding: "utf8"
});
assert.equal(packageBoundaryRun.status, 0, packageBoundaryRun.stderr || packageBoundaryRun.stdout);
const packageBoundaryReport = JSON.parse(packageBoundaryRun.stdout);
assert.equal(packageBoundaryReport.summary.strict_gate, "pass");
assert.equal(packageBoundaryReport.summary.findings, 0);
assert.ok(packageBoundaryReport.summary.entry_count > 0);
assert.ok(packageBoundaryReport.files.every((file) => !file.path.startsWith("legacy/")));
assert.ok(packageBoundaryReport.files.every((file) => !file.path.startsWith("vendor/")));

const phase9GateRun = spawnSync(process.execPath, [phase9GatePath], {
  cwd: process.cwd(),
  encoding: "utf8"
});
assert.equal(phase9GateRun.status, 0, phase9GateRun.stderr || phase9GateRun.stdout);
assert.match(phase9GateRun.stdout, /"status": "pass"/);

console.log("runtime scanner quarantine, legacy boundary, package boundary, and phase9 static gate tests passed");
