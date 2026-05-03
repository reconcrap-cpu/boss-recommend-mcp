#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
  sleep
} from "../src/core/browser/index.js";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_COMPLETED,
  RUN_STATUS_PAUSED
} from "../src/core/run/index.js";
import {
  buildRecommendSelfHealConfig,
  HEALTH_STATUS,
  resolveRecommendSelfHealRoots,
  runSelfHealCheck
} from "../src/core/self-heal/index.js";
import {
  createRecommendRunService,
  RECOMMEND_TARGET_URL
} from "../src/domains/recommend/index.js";

const DEFAULT_RULES_PATH = "";

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECOMMEND_TARGET_URL,
    rulesPath: DEFAULT_RULES_PATH,
    saveReport: ".live-artifacts/recommend-run-service-lifecycle.json",
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    job: "",
    pageScope: "recommend",
    allowNavigate: true,
    filterGroup: "degree",
    filterLabels: ["本科", "硕士", "博士"],
    filterGroups: [],
    selectAllLabels: true,
    maxCandidates: 15,
    detailLimit: 1,
    delayMs: 650,
    pauseAfterProcessed: 1,
    refreshOnEnd: true,
    maxRefreshRounds: 2,
    refreshButtonSettleMs: 8000,
    refreshReloadSettleMs: 8000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--rules") result.rulesPath = argv[++index];
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--no-save-report") result.saveReport = "";
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--job") result.job = argv[++index];
    if (arg === "--page-scope") result.pageScope = argv[++index];
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--filter-group") result.filterGroup = argv[++index];
    if (arg === "--filter-label") result.filterLabels.push(argv[++index]);
    if (arg === "--filter-labels") {
      result.filterLabels = String(argv[++index] || "")
        .split(/[,，、|/]/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (arg === "--filter") {
      const raw = String(argv[++index] || "");
      const [group, labelsRaw = ""] = raw.split(/[:=]/);
      result.filterGroups.push({
        group: group.trim(),
        labels: labelsRaw.split(/[,，、|/]/).map((item) => item.trim()).filter(Boolean),
        selectAllLabels: true
      });
    }
    if (arg === "--no-filter") result.filterLabels = [];
    if (arg === "--select-all-labels") result.selectAllLabels = true;
    if (arg === "--select-first-label") result.selectAllLabels = false;
    if (arg === "--max-candidates") result.maxCandidates = Number(argv[++index]);
    if (arg === "--detail-limit") result.detailLimit = Number(argv[++index]);
    if (arg === "--delay-ms") result.delayMs = Number(argv[++index]);
    if (arg === "--pause-after-processed") result.pauseAfterProcessed = Number(argv[++index]);
    if (arg === "--no-refresh-on-end") result.refreshOnEnd = false;
    if (arg === "--refresh-on-end") result.refreshOnEnd = true;
    if (arg === "--max-refresh-rounds") result.maxRefreshRounds = Number(argv[++index]);
    if (arg === "--refresh-button-settle-ms") result.refreshButtonSettleMs = Number(argv[++index]);
    if (arg === "--refresh-reload-settle-ms") result.refreshReloadSettleMs = Number(argv[++index]);
  }

  return result;
}

async function connectToRecommendSession(options) {
  try {
    return await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes: options.targetUrlIncludes
    });
  } catch (error) {
    if (!options.allowNavigate) throw error;
    return connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetPredicate: (target) => (
        target?.type === "page"
        && String(target?.url || "").includes("zhipin.com/web/chat")
      )
    });
  }
}

async function waitUntil(predicate, timeoutMs = 15000, intervalMs = 80) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for recommend run service live condition");
}

function methodSummary(methodLog) {
  const summary = {};
  for (const entry of methodLog) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function readJsonFile(filePath) {
  if (!filePath) return {};
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return {};
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return resolved;
}

function redactIdentity(identity = {}) {
  return {
    ...identity,
    name: identity?.name ? "[redacted]" : null
  };
}

function redactSnapshot(snapshot) {
  const clone = JSON.parse(JSON.stringify(snapshot || {}));
  if (clone.checkpoint?.last_candidate?.identity) {
    clone.checkpoint.last_candidate.identity = redactIdentity(clone.checkpoint.last_candidate.identity);
  }
  for (const result of clone.summary?.results || []) {
    if (result.candidate?.identity) {
      result.candidate.identity = redactIdentity(result.candidate.identity);
    }
    if (result.screening?.candidate?.identity) {
      result.screening.candidate.identity = redactIdentity(result.screening.candidate.identity);
    }
  }
  return clone;
}

function compactHealth(check) {
  return {
    status: check.status,
    summary: check.summary,
    drift_report: check.drift_report,
    probes: check.probes.map((probe) => ({
      id: probe.id,
      type: probe.type,
      status: probe.status,
      count: probe.count,
      required: probe.required,
      collapsed: probe.collapsed,
      recovered: probe.recovered,
      viewport_health: probe.viewport_health || undefined
    }))
  };
}

async function waitForHealthyRecommend(client, selfHealConfig, {
  timeoutMs = 20000,
  intervalMs = 800
} = {}) {
  const started = Date.now();
  let lastCheck = null;
  while (Date.now() - started <= timeoutMs) {
    const selfHealRoots = await resolveRecommendSelfHealRoots(client, selfHealConfig);
    lastCheck = await runSelfHealCheck({
      client,
      domain: "recommend",
      roots: selfHealRoots.roots,
      selectorProbes: selfHealConfig.selectorProbes,
      accessibilityProbes: selfHealConfig.accessibilityProbes,
      viewportProbes: selfHealConfig.viewportProbes
    });
    if (lastCheck.status === HEALTH_STATUS.HEALTHY) return lastCheck;
    await sleep(intervalMs);
  }
  return lastCheck;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let session;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    },
    lifecycle: {}
  };

  try {
    session = await connectToRecommendSession(options);
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };
    result.runtime_guard_probe = await assertRuntimeEvaluateBlocked(client);

    await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
    await bringPageToFront(client);
    if (options.allowNavigate && !String(target.url || "").includes(options.targetUrlIncludes)) {
      await client.Page.navigate({ url: RECOMMEND_TARGET_URL });
      await sleep(3000);
      result.chrome.navigated_to = RECOMMEND_TARGET_URL;
    }

    const rules = readJsonFile(options.rulesPath);
    const selfHealConfig = buildRecommendSelfHealConfig(rules);
    const initialHealth = await waitForHealthyRecommend(client, selfHealConfig);
    result.self_heal = {
      initial: initialHealth ? compactHealth(initialHealth) : null
    };
    if (!initialHealth || initialHealth.status !== HEALTH_STATUS.HEALTHY) {
      throw new Error(`Recommend initial health is not healthy: ${initialHealth?.status || "missing"}`);
    }

    const service = createRecommendRunService({ idPrefix: "live_recommend" });
    const started = service.startRecommendRun({
      client,
      targetUrl: target.url,
      criteria: options.criteria,
      jobLabel: options.job,
      pageScope: options.pageScope,
      fallbackPageScope: "recommend",
      filter: options.filterGroups.length
        ? { filterGroups: options.filterGroups }
        : options.filterLabels.length
        ? {
            group: options.filterGroup,
            labels: options.filterLabels,
            selectAllLabels: options.selectAllLabels
          }
        : { enabled: false },
      maxCandidates: options.maxCandidates,
      detailLimit: options.detailLimit,
      delayMs: options.delayMs,
      refreshOnEnd: options.refreshOnEnd,
      maxRefreshRounds: options.maxRefreshRounds,
      refreshButtonSettleMs: options.refreshButtonSettleMs,
      refreshReloadSettleMs: options.refreshReloadSettleMs,
      name: "live-recommend-run-service-smoke"
    });
    result.lifecycle.started = redactSnapshot(started);

    if (options.pauseAfterProcessed <= 0) {
      const final = await service.waitForRecommendRun(started.runId, { timeoutMs: 600000 });
      result.lifecycle.final = redactSnapshot(final);
      if (final.status !== RUN_STATUS_COMPLETED) {
        throw new Error(`Expected completed final status, got ${final.status}`);
      }
      assertNoForbiddenCdpCalls(methodLog);
      result.runtime_evaluate_used = false;
      result.method_summary = methodSummary(methodLog);
      result.method_log = methodLog;
      result.status = "PASS";

      if (options.saveReport) {
        result.saved_report_path = writeJsonFile(options.saveReport, result);
      }

      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const firstProgress = await waitUntil(() => {
      const snapshot = service.getRecommendRun(started.runId);
      return snapshot.progress.processed >= options.pauseAfterProcessed && snapshot;
    });
    result.lifecycle.first_progress = redactSnapshot(firstProgress);

    service.pauseRecommendRun(started.runId);
    const paused = await waitUntil(() => {
      const snapshot = service.getRecommendRun(started.runId);
      return snapshot.status === RUN_STATUS_PAUSED && snapshot;
    });
    result.lifecycle.paused = redactSnapshot(paused);

    await sleep(Math.max(700, options.delayMs + 150));
    const stillPaused = service.getRecommendRun(started.runId);
    result.lifecycle.paused_stability = {
      before: paused.progress,
      after: stillPaused.progress,
      stable: (
        stillPaused.progress.processed === paused.progress.processed
        && stillPaused.progress.screened === paused.progress.screened
        && stillPaused.progress.detail_opened === paused.progress.detail_opened
      )
    };
    if (!result.lifecycle.paused_stability.stable) {
      throw new Error("Recommend run service progress changed while paused");
    }

    service.resumeRecommendRun(started.runId);
    const resumed = await waitUntil(() => {
      const snapshot = service.getRecommendRun(started.runId);
      return snapshot.progress.processed > paused.progress.processed && snapshot;
    });
    result.lifecycle.resumed = redactSnapshot(resumed);

    service.cancelRecommendRun(started.runId);
    const final = await service.waitForRecommendRun(started.runId, { timeoutMs: 8000 });
    result.lifecycle.final = redactSnapshot(final);
    if (final.status !== RUN_STATUS_CANCELED) {
      throw new Error(`Expected canceled final status, got ${final.status}`);
    }

    assertNoForbiddenCdpCalls(methodLog);
    result.runtime_evaluate_used = false;
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;
    result.status = "PASS";

    if (options.saveReport) {
      result.saved_report_path = writeJsonFile(options.saveReport, result);
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    result.status = "FAIL";
    result.error = {
      name: error?.name || "Error",
      message: error?.message || String(error)
    };
    if (session?.methodLog) {
      result.method_summary = methodSummary(session.methodLog);
      result.method_log = session.methodLog;
    }
    if (options.saveReport) {
      result.saved_report_path = writeJsonFile(options.saveReport, result);
    }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
