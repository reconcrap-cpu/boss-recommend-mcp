#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const ACTIVE_DIRS = ["bin", "src", "scripts"];
const SKIP_DIRS = new Set([".git", "node_modules", "coverage", "dist", "docs", "legacy", ".live-artifacts"]);
const TOOLING_ALLOWLIST = new Set([
  path.normalize("scripts/scan-forbidden-runtime.js"),
  path.normalize("scripts/scan-legacy-boundary.js")
]);

const BOUNDARY_PATTERNS = [
  {
    id: "legacy-research-path",
    regex: /legacy[\\/]research/i,
    description: "active code must not point at the research-only legacy quarantine"
  },
  {
    id: "relative-legacy-path",
    regex: /(?:^|[="'`(,:\s])(?:\.\.[\\/]|\.?[\\/])legacy[\\/]/i,
    description: "active code must not import or execute files from a legacy directory"
  },
  {
    id: "package-local-vendor-path",
    regex: /(?:^|[="'`(,:\s])(?:\.\.[\\/]|\.?[\\/])vendor[\\/](?:boss-recommend|boss-chat)/i,
    description: "package-local Boss vendor automation is quarantined and must not be active"
  },
  {
    id: "old-recommend-search-vendor",
    regex: /\bboss-recommend-search-cli\b/i,
    description: "recommend search vendor is retained only under legacy/research"
  },
  {
    id: "old-recommend-screen-vendor",
    regex: /\bboss-recommend-screen-cli\b/i,
    description: "recommend screen vendor is retained only under legacy/research"
  },
  {
    id: "old-chat-vendor",
    regex: /\bboss-chat-cli\b/i,
    description: "chat vendor is retained only under legacy/research"
  },
  {
    id: "moved-legacy-module",
    regex: /(?:^|[\\/"'`(,:\s])(?:src[\\/])?(?:adapters|boss-chat|pipeline|self-heal|recommend-healing-config)\.js/i,
    description: "moved legacy source modules must not be referenced by active code"
  },
  {
    id: "moved-legacy-rules",
    regex: /(?:^|[\\/"'`(,:\s])(?:src[\\/])?recommend-healing-rules\.json/i,
    description: "moved legacy healing rules must not be referenced by active code"
  },
  {
    id: "moved-legacy-test",
    regex: /(?:^|[\\/"'`(,:\s])(?:src[\\/])?test-(?:adapters-runtime|boss-chat|pipeline|self-heal)\.js/i,
    description: "legacy tests are quarantined and must not be package scripts"
  }
];

function parseArgs(argv) {
  const flags = new Set(argv);
  return {
    json: flags.has("--json")
  };
}

function toRelative(root, filePath) {
  return path.normalize(path.relative(root, filePath));
}

function isSkippedDir(name) {
  return SKIP_DIRS.has(name);
}

function* walkFiles(root, dirPath) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isSkippedDir(entry.name)) continue;
      yield* walkFiles(root, path.join(dirPath, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    const filePath = path.join(dirPath, entry.name);
    const relativePath = toRelative(root, filePath);
    if (TOOLING_ALLOWLIST.has(relativePath)) continue;
    if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      yield filePath;
    }
  }
}

function findPatternMatches(text) {
  return BOUNDARY_PATTERNS
    .filter((pattern) => pattern.regex.test(text))
    .map((pattern) => ({
      pattern: pattern.id,
      description: pattern.description
    }));
}

function scanFile(root, filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const findings = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const match of findPatternMatches(line)) {
      findings.push({
        source: "file",
        path: filePath,
        relative_path: toRelative(root, filePath),
        line_number: index + 1,
        line: line.trim(),
        ...match
      });
    }
  }
  return findings;
}

function scanPackageJson(root) {
  const packagePath = path.join(root, "package.json");
  if (!fs.existsSync(packagePath)) return [];
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const findings = [];
  for (const [key, value] of Object.entries(packageJson.scripts || {})) {
    for (const match of findPatternMatches(String(value || ""))) {
      findings.push({
        source: "package-script",
        path: packagePath,
        relative_path: "package.json",
        key: `scripts.${key}`,
        value,
        ...match
      });
    }
  }
  for (const [index, value] of (packageJson.files || []).entries()) {
    for (const match of findPatternMatches(String(value || ""))) {
      findings.push({
        source: "package-files",
        path: packagePath,
        relative_path: "package.json",
        key: `files[${index}]`,
        value,
        ...match
      });
    }
  }
  return findings;
}

function scanFilesystemBoundary(root) {
  const findings = [];
  const packageVendorPath = path.join(root, "vendor");
  if (fs.existsSync(packageVendorPath)) {
    findings.push({
      source: "filesystem",
      path: packageVendorPath,
      relative_path: "vendor",
      pattern: "top-level-vendor-directory",
      description: "package-local vendor directory must stay out of the active project root"
    });
  }
  return findings;
}

function scanRoot(root) {
  const files = [];
  const findings = [
    ...scanPackageJson(root),
    ...scanFilesystemBoundary(root)
  ];
  for (const dirName of ACTIVE_DIRS) {
    const dirPath = path.join(root, dirName);
    for (const filePath of walkFiles(root, dirPath)) {
      files.push(filePath);
      findings.push(...scanFile(root, filePath));
    }
  }
  return { files, findings };
}

function summarize({ files, findings }) {
  const byPattern = {};
  const bySource = {};
  for (const finding of findings) {
    byPattern[finding.pattern] = (byPattern[finding.pattern] || 0) + 1;
    bySource[finding.source] = (bySource[finding.source] || 0) + 1;
  }
  return {
    active_files_scanned: files.length,
    findings: findings.length,
    strict_gate: findings.length > 0 ? "fail" : "pass",
    by_pattern: byPattern,
    by_source: bySource
  };
}

function printReport(report) {
  console.log("Legacy boundary scan");
  console.log(`Active files scanned: ${report.summary.active_files_scanned}`);
  console.log(`Findings: ${report.summary.findings}`);
  console.log(`Strict gate: ${report.summary.strict_gate}`);
  if (report.findings.length === 0) return;
  console.log("");
  console.log("Findings:");
  for (const finding of report.findings) {
    const location = finding.line_number
      ? `${finding.relative_path}:${finding.line_number}`
      : `${finding.relative_path}${finding.key ? ` ${finding.key}` : ""}`;
    console.log(`- ${location}: ${finding.pattern} - ${finding.description}`);
    if (finding.line) console.log(`  ${finding.line}`);
    if (finding.value) console.log(`  ${finding.value}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const result = scanRoot(root);
  const report = {
    generated_at: new Date().toISOString(),
    root,
    summary: summarize(result),
    findings: result.findings
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (report.summary.findings > 0) {
    process.exitCode = 1;
  }
}

main();
