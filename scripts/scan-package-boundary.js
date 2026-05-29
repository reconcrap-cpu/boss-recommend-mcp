#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const BLOCKED_PACKAGE_PATTERNS = [
  {
    id: "legacy-directory",
    regex: /^legacy\//i,
    description: "legacy research archive must not be published"
  },
  {
    id: "vendor-directory",
    regex: /^vendor\//i,
    description: "package-local vendor automation must not be published"
  },
  {
    id: "docs-directory",
    regex: /^docs\//i,
    description: "rewrite handoff docs are development-only"
  },
  {
    id: "live-or-scan-script",
    regex: /^scripts\/(?!(?:postinstall\.cjs|install-macos\.sh)$)/i,
    description: "live test and scanner scripts are development-only"
  },
  {
    id: "test-source",
    regex: /^src\/test-/i,
    description: "development tests must not be published"
  },
  {
    id: "moved-legacy-source",
    regex: /^src\/(?:adapters|boss-chat|pipeline|self-heal|recommend-healing-config)\.js$/i,
    description: "moved legacy source modules must not be published"
  },
  {
    id: "moved-legacy-rules",
    regex: /^src\/recommend-healing-rules\.json$/i,
    description: "moved legacy rules must not be published"
  }
];

function parseArgs(argv) {
  const flags = new Set(argv);
  return {
    json: flags.has("--json")
  };
}

function npmInvocation() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return {
      command: process.execPath,
      args: [npmExecPath, "pack", "--dry-run", "--json"],
      shell: false
    };
  }
  return {
    command: "npm",
    args: ["pack", "--dry-run", "--json"],
    shell: process.platform === "win32"
  };
}

function runNpmPackDryRun() {
  const invocation = npmInvocation();
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: invocation.shell,
    windowsHide: true
  });
  if (result.status !== 0 || result.error) {
    const message = [
      result.error?.message,
      result.stderr,
      result.stdout
    ].filter(Boolean).join("\n").trim();
    throw new Error(message || "npm pack --dry-run --json failed");
  }
  const parsed = JSON.parse(result.stdout);
  const packageInfo = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!packageInfo || !Array.isArray(packageInfo.files)) {
    throw new Error("npm pack dry-run output did not include a files list");
  }
  return packageInfo;
}

function normalizePackagePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\.?\//, "");
}

function classifyPackagePath(filePath) {
  const normalized = normalizePackagePath(filePath);
  return BLOCKED_PACKAGE_PATTERNS
    .filter((pattern) => pattern.regex.test(normalized))
    .map((pattern) => ({
      path: normalized,
      pattern: pattern.id,
      description: pattern.description
    }));
}

function scanPackageFiles(packageInfo) {
  const findings = [];
  for (const file of packageInfo.files) {
    findings.push(...classifyPackagePath(file.path));
  }
  return findings;
}

function summarize(packageInfo, findings) {
  const byPattern = {};
  for (const finding of findings) {
    byPattern[finding.pattern] = (byPattern[finding.pattern] || 0) + 1;
  }
  return {
    entry_count: Number(packageInfo.entryCount || packageInfo.files.length || 0),
    package_filename: packageInfo.filename || null,
    findings: findings.length,
    strict_gate: findings.length > 0 ? "fail" : "pass",
    by_pattern: byPattern
  };
}

function printReport(report) {
  console.log("Package boundary scan");
  console.log(`Package filename: ${report.summary.package_filename || ""}`);
  console.log(`Entry count: ${report.summary.entry_count}`);
  console.log(`Findings: ${report.summary.findings}`);
  console.log(`Strict gate: ${report.summary.strict_gate}`);
  if (report.findings.length === 0) return;
  console.log("");
  console.log("Findings:");
  for (const finding of report.findings) {
    console.log(`- ${finding.path}: ${finding.pattern} - ${finding.description}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageInfo = runNpmPackDryRun();
  const findings = scanPackageFiles(packageInfo);
  const report = {
    generated_at: new Date().toISOString(),
    root: process.cwd(),
    summary: summarize(packageInfo, findings),
    findings,
    files: packageInfo.files.map((file) => ({
      path: normalizePackagePath(file.path),
      size: file.size
    }))
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (findings.length > 0) {
    process.exitCode = 1;
  }
}

main();
