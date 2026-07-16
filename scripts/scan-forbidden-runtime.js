#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"]);
const SKIP_DIRS = new Set([".git", "node_modules", "coverage", "dist", "docs"]);

const DEFAULT_RECRUIT_ROOT = path.resolve(
  process.cwd(),
  "..",
  "..",
  "boss recruit pipeline",
  "boss-recruit-mcp"
);

const PATTERNS = [
  { id: "runtime-evaluate", regex: /\bRuntime\.evaluate\b/ },
  { id: "runtime-call-function-on", regex: /\bRuntime\.callFunctionOn\b/ },
  { id: "page-evaluate", regex: /\bpage\.evaluate\b/ },
  { id: "page-dollar-eval", regex: /\b(?:page|frame)\.\$\$?eval\s*\(/ },
  { id: "page-add-script-to-evaluate", regex: /\bPage\.addScriptToEvaluateOnNewDocument\b/ },
  { id: "lowercase-runtime-evaluate", regex: /\bruntime\.evaluate\b/ },
  { id: "global-eval", regex: /(^|[^A-Za-z0-9_.])eval\s*\(/ },
  { id: "function-constructor", regex: /\b(?:new\s+)?Function\s*\(/ },
  { id: "script-element-injection", regex: /\b(?:document\.)?createElement\s*\(\s*["']script["']/i },
  { id: "javascript-navigation-call", regex: /\b(?:Page\.navigate|location\.(?:assign|replace))\b[^\n]*\bjavascript\s*:/i },
  { id: "javascript-location-assignment", regex: /\b(?:window\.)?location(?:\.href)?\s*=\s*["'`]\s*javascript\s*:/i },
  { id: "generated-expression-helper", regex: /\bbuild[A-Za-z0-9_]*Expression\b/ },
  { id: "page-document-query", regex: /\bdocument\.querySelector(?:All)?\b/ },
  { id: "page-click-call", regex: /\.click\(\)/ }
];

const ALLOWLIST = [
  {
    relativePath: path.normalize("src/core/browser/index.js"),
    reason: "CDP guard module blocks forbidden methods; it does not execute page JS."
  },
  {
    relativePath: path.normalize("scripts/scan-forbidden-runtime.js"),
    reason: "Static scanner names forbidden APIs so it can reject them; it does not execute page JS."
  }
];

const LEGACY_QUARANTINE = [
  {
    label: "recommend-project",
    relativePathPrefix: `${path.normalize("legacy/research")}${path.sep}`,
    reason: "Research-only legacy quarantine. These files are retained for future reference, are excluded from npm package files, and are not active runtime paths."
  },
  {
    label: "recruit-source",
    relativePath: path.normalize("src/adapters.js"),
    reason: "External recruit source is kept as a migration reference; imported recruit behavior now lives in the CDP-only src/domains/recruit layer."
  },
  {
    label: "recruit-source",
    relativePathPrefix: `${path.normalize("vendor/boss-screen-cli")}${path.sep}`,
    reason: "External recruit screen vendor is kept as a migration reference and is outside the package entrypoint runtime path."
  },
  {
    label: "recruit-source",
    relativePathPrefix: `${path.normalize("vendor/boss-search-cli")}${path.sep}`,
    reason: "External recruit search vendor is kept as a migration reference and is outside the package entrypoint runtime path."
  }
];

function parseArgs(argv) {
  const flags = new Set(argv);
  return {
    json: flags.has("--json"),
    failOnFindings: flags.has("--fail-on-findings"),
    failOnLegacy: flags.has("--fail-on-legacy"),
    packageSurface: flags.has("--package-surface"),
    repoOnly: flags.has("--repo-only"),
    includeAllowed: flags.has("--include-allowed")
  };
}

function isAllowedFinding(root, filePath) {
  const relativePath = path.normalize(path.relative(root, filePath));
  return ALLOWLIST.find((entry) => entry.relativePath === relativePath) || null;
}

function getQuarantineEntry(label, root, filePath) {
  const relativePath = path.normalize(path.relative(root, filePath));
  return LEGACY_QUARANTINE.find((entry) => {
    if (entry.label !== label) return false;
    if (entry.relativePath && entry.relativePath === relativePath) return true;
    if (entry.relativePathPrefix && relativePath.startsWith(entry.relativePathPrefix)) return true;
    return false;
  }) || null;
}

function domainFor(label, filePath) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  if (label === "recruit-source") return "recruit";
  if (normalized.includes("boss-chat") || normalized.endsWith("/src/boss-chat.js")) return "chat";
  if (normalized.includes("recommend")) return "recommend";
  return "shared";
}

function* walkFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name))) {
      yield fullPath;
    }
  }
}

function scanFile({ label, root, filePath }) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const findings = [];
  const allowlistEntry = isAllowedFinding(root, filePath);
  const quarantineEntry = allowlistEntry ? null : getQuarantineEntry(label, root, filePath);
  const status = allowlistEntry
    ? "allowed"
    : quarantineEntry
      ? "legacy-quarantined"
      : "active";
  if (path.basename(filePath).toLowerCase() === "page.js") {
    findings.push({
      label,
      domain: domainFor(label, filePath),
      path: filePath,
      relative_path: path.relative(root, filePath),
      line_number: 1,
      pattern: "page-js-file",
      line: "Forbidden page.js file",
      status,
      allowed: status === "allowed",
      quarantined: status === "legacy-quarantined",
      reachable_from_entrypoint: status === "active",
      allowlist_reason: allowlistEntry?.reason || undefined,
      quarantine_reason: quarantineEntry?.reason || undefined
    });
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of PATTERNS) {
      if (!pattern.regex.test(line)) continue;
      findings.push({
        label,
        domain: domainFor(label, filePath),
        path: filePath,
        relative_path: path.relative(root, filePath),
        line_number: index + 1,
        pattern: pattern.id,
        line: line.trim(),
        status,
        allowed: status === "allowed",
        quarantined: status === "legacy-quarantined",
        reachable_from_entrypoint: status === "active",
        allowlist_reason: allowlistEntry?.reason || undefined,
        quarantine_reason: quarantineEntry?.reason || undefined
      });
    }
  }
  return findings;
}

function scanRoot(scanRootConfig) {
  const { label, root, subdirs } = scanRootConfig;
  if (!fs.existsSync(root)) return [];
  const findings = [];
  for (const subdir of subdirs) {
    const subdirPath = path.join(root, subdir);
    if (!fs.existsSync(subdirPath)) continue;
    for (const filePath of walkFiles(subdirPath)) {
      findings.push(...scanFile({ label, root, filePath }));
    }
  }
  return findings;
}

function scanPackageSurface({ label, root }) {
  const packageJsonPath = path.join(root, "package.json");
  if (!fs.existsSync(packageJsonPath)) return [];
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const entries = Array.isArray(packageJson.files) ? packageJson.files : [];
  const files = new Set();

  for (const entry of entries) {
    const normalizedEntry = String(entry || "").trim();
    if (!normalizedEntry || normalizedEntry.includes("*")) continue;
    const fullPath = path.join(root, normalizedEntry);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      for (const filePath of walkFiles(fullPath)) {
        files.add(filePath);
      }
    } else if (stat.isFile() && CODE_EXTENSIONS.has(path.extname(fullPath))) {
      files.add(fullPath);
    }
  }

  const findings = [];
  for (const filePath of files) {
    findings.push(...scanFile({ label, root, filePath }));
  }
  return findings;
}

function summarize(findings) {
  const summary = {
    total_findings: findings.length,
    raw_active_findings: findings.filter((finding) => !finding.allowed).length,
    active_findings: findings.filter((finding) => finding.status === "active").length,
    reachable_findings: findings.filter((finding) => finding.status === "active").length,
    legacy_quarantined_findings: findings.filter((finding) => finding.status === "legacy-quarantined").length,
    allowed_findings: findings.filter((finding) => finding.allowed).length,
    strict_gate: findings.some((finding) => finding.status === "active") ? "fail" : "pass",
    by_status: {},
    by_domain: {},
    by_file: {},
    by_file_status: {}
  };
  for (const finding of findings) {
    summary.by_status[finding.status] = (summary.by_status[finding.status] || 0) + 1;
    summary.by_domain[finding.domain] = (summary.by_domain[finding.domain] || 0) + 1;
    const key = `${finding.label}:${finding.relative_path}`;
    summary.by_file[key] = (summary.by_file[key] || 0) + 1;
    summary.by_file_status[key] ??= {
      total: 0,
      active: 0,
      legacy_quarantined: 0,
      allowed: 0
    };
    summary.by_file_status[key].total += 1;
    if (finding.status === "active") summary.by_file_status[key].active += 1;
    if (finding.status === "legacy-quarantined") {
      summary.by_file_status[key].legacy_quarantined += 1;
    }
    if (finding.status === "allowed") summary.by_file_status[key].allowed += 1;
  }
  return summary;
}

function printTextReport(report) {
  console.log("Forbidden runtime/page-JS scan");
  console.log(`Roots: ${report.roots.map((root) => `${root.label}=${root.root}`).join("; ")}`);
  console.log(`Total findings: ${report.summary.total_findings}`);
  console.log(`Raw non-allowed findings: ${report.summary.raw_active_findings}`);
  console.log(`Reachable active findings: ${report.summary.reachable_findings}`);
  console.log(`Legacy quarantined findings: ${report.summary.legacy_quarantined_findings}`);
  console.log(`Allowed guard findings: ${report.summary.allowed_findings}`);
  console.log(`Strict gate: ${report.summary.strict_gate}`);
  console.log("");
  console.log("Findings by status:");
  for (const [status, count] of Object.entries(report.summary.by_status)) {
    console.log(`- ${status}: ${count}`);
  }
  console.log("");
  console.log("Findings by domain:");
  for (const [domain, count] of Object.entries(report.summary.by_domain)) {
    console.log(`- ${domain}: ${count}`);
  }
  console.log("");
  console.log("Findings by file:");
  for (const [file, count] of Object.entries(report.summary.by_file)) {
    const statusCounts = report.summary.by_file_status[file] || {};
    const details = [
      statusCounts.active ? `active ${statusCounts.active}` : null,
      statusCounts.legacy_quarantined ? `quarantined ${statusCounts.legacy_quarantined}` : null,
      statusCounts.allowed ? `allowed ${statusCounts.allowed}` : null
    ].filter(Boolean).join(", ");
    console.log(`- ${file}: ${count}${details ? ` (${details})` : ""}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let roots = [];
  let findings = [];
  if (options.packageSurface) {
    roots = [
      {
        label: "recommend-package",
        root: process.cwd(),
        package_surface: true
      }
    ];
    findings = roots.flatMap(scanPackageSurface);
  } else {
    roots = [
      {
        label: "recommend-project",
        root: process.cwd(),
        subdirs: ["bin", "src", "scripts", "legacy", "vendor"]
      }
    ];

    if (!options.repoOnly && fs.existsSync(DEFAULT_RECRUIT_ROOT)) {
      roots.push({
        label: "recruit-source",
        root: DEFAULT_RECRUIT_ROOT,
        subdirs: ["bin", "src", "vendor"]
      });
    }

    findings = roots.flatMap(scanRoot);
  }
  const visibleFindings = options.includeAllowed
    ? findings
    : findings.filter((finding) => !finding.allowed);
  const report = {
    generated_at: new Date().toISOString(),
    roots,
    summary: summarize(findings),
    findings: visibleFindings
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTextReport(report);
  }

  if (options.failOnFindings && report.summary.active_findings > 0) {
    process.exitCode = 1;
  }
  if (options.failOnLegacy && report.summary.raw_active_findings > 0) {
    process.exitCode = 1;
  }
}

main();
