#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_REPORTS = {
  recommend: ".live-artifacts/phase10-recommend-full-run-20-live.json",
  search: ".live-artifacts/phase10-search-full-run-20-live.json",
  chat: ".live-artifacts/phase10-chat-full-run-20-live.json"
};

const EXPECTED_TARGETS = {
  recommend: "/web/chat/recommend",
  search: "/web/chat/search",
  chat: "/web/chat/index"
};

function parsePositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    minCandidates: 20,
    reports: { ...DEFAULT_REPORTS },
    json: false,
    allowPending: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--min-candidates") result.minCandidates = parsePositiveInt(argv[++index], result.minCandidates);
    if (arg === "--recommend-report") result.reports.recommend = argv[++index];
    if (arg === "--search-report" || arg === "--recruit-report") result.reports.search = argv[++index];
    if (arg === "--chat-report") result.reports.chat = argv[++index];
    if (arg === "--json") result.json = true;
    if (arg === "--allow-pending") result.allowPending = true;
  }
  return result;
}

function readJsonFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return {
      ok: false,
      resolved,
      error: "REPORT_MISSING",
      data: null
    };
  }
  try {
    return {
      ok: true,
      resolved,
      error: null,
      data: JSON.parse(fs.readFileSync(resolved, "utf8"))
    };
  } catch (error) {
    return {
      ok: false,
      resolved,
      error: `REPORT_INVALID_JSON: ${error.message}`,
      data: null
    };
  }
}

function getFinalSnapshot(report) {
  return report?.lifecycle?.final
    || report?.final
    || report?.snapshot
    || null;
}

function getProgress(finalSnapshot) {
  return finalSnapshot?.progress || {};
}

function getMethodName(entry) {
  if (typeof entry === "string") return entry;
  return String(entry?.method || "");
}

function hasRuntimeMethods(report) {
  const methodLog = Array.isArray(report?.method_log) ? report.method_log : [];
  return methodLog.some((entry) => /^Runtime\./.test(getMethodName(entry)));
}

function targetMatches(domain, report) {
  const expected = EXPECTED_TARGETS[domain];
  const values = [
    report?.chrome?.target_url_includes,
    report?.chrome?.target?.url,
    report?.chrome?.navigated_to,
    report?.lifecycle?.final?.context?.target_url
  ].map((value) => String(value || ""));
  return values.some((value) => value.includes(expected));
}

function validateDomainReport(domain, reportPath, minCandidates) {
  const readResult = readJsonFile(reportPath);
  const checks = [];
  const addCheck = (id, ok, observed, expected) => {
    checks.push({ id, ok: Boolean(ok), observed, expected });
  };

  if (!readResult.ok) {
    addCheck("report_exists", false, readResult.error, "readable JSON report");
    return {
      domain,
      report_path: readResult.resolved,
      status: "pending",
      checks,
      progress: null
    };
  }

  const report = readResult.data;
  const finalSnapshot = getFinalSnapshot(report);
  const progress = getProgress(finalSnapshot);
  const finalStatus = String(finalSnapshot?.status || "").toLowerCase();
  const screened = Number(progress.screened || 0);
  const processed = Number(progress.processed || 0);
  const uniqueSeen = Number(progress.unique_seen || 0);
  const targetCount = Number(progress.target_count || finalSnapshot?.context?.max_candidates || 0);

  addCheck("report_status_pass", report?.status === "PASS", report?.status, "PASS");
  addCheck("final_status_completed", finalStatus === "completed", finalSnapshot?.status, "completed");
  addCheck("processed_minimum", processed >= minCandidates, processed, `>= ${minCandidates}`);
  addCheck("screened_minimum", screened >= minCandidates, screened, `>= ${minCandidates}`);
  addCheck(
    "unique_seen_minimum",
    !Number.isFinite(uniqueSeen) || uniqueSeen === 0 || uniqueSeen >= minCandidates,
    uniqueSeen || null,
    `0/absent or >= ${minCandidates}`
  );
  addCheck("target_count_minimum", targetCount >= minCandidates, targetCount, `>= ${minCandidates}`);
  addCheck("target_url_matches", targetMatches(domain, report), report?.chrome?.target?.url || report?.chrome?.target_url_includes, EXPECTED_TARGETS[domain]);
  addCheck("runtime_flag_false", report?.runtime_evaluate_used === false, report?.runtime_evaluate_used, false);
  addCheck("no_runtime_methods", !hasRuntimeMethods(report), "method_log", "no Runtime.*");

  const failed = checks.filter((check) => !check.ok);
  return {
    domain,
    report_path: readResult.resolved,
    status: failed.length > 0 ? "fail" : "pass",
    checks,
    progress: {
      processed,
      screened,
      unique_seen: uniqueSeen || null,
      target_count: targetCount || null
    },
    generated_at: report?.generated_at || null
  };
}

function printReport(report) {
  console.log("Phase 10 completion gate");
  console.log(`Minimum screened candidates per domain: ${report.min_candidates}`);
  console.log(`Status: ${report.status}`);
  for (const domain of report.domains) {
    console.log("");
    console.log(`${domain.domain}: ${domain.status}`);
    console.log(`  report: ${domain.report_path}`);
    if (domain.progress) {
      console.log(`  processed=${domain.progress.processed} screened=${domain.progress.screened} unique_seen=${domain.progress.unique_seen ?? ""}`);
    }
    for (const check of domain.checks.filter((item) => !item.ok)) {
      console.log(`  FAIL ${check.id}: observed=${JSON.stringify(check.observed)} expected=${JSON.stringify(check.expected)}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const domains = Object.entries(options.reports).map(([domain, reportPath]) => (
    validateDomainReport(domain, reportPath, options.minCandidates)
  ));
  const failed = domains.filter((domain) => domain.status === "fail");
  const pending = domains.filter((domain) => domain.status === "pending");
  const report = {
    generated_at: new Date().toISOString(),
    min_candidates: options.minCandidates,
    status: failed.length > 0 ? "fail" : pending.length > 0 ? "pending" : "pass",
    domains
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (report.status !== "pass" && !(options.allowPending && report.status === "pending")) {
    process.exitCode = 1;
  }
}

main();
