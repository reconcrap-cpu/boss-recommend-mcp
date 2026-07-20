#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
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
  buildRecruitSelfHealConfig,
  HEALTH_STATUS,
  resolveRecruitSelfHealRoots,
  runSelfHealCheck
} from "../src/core/self-heal/index.js";
import {
  applyRecruitSearchParams,
  createRecruitRunService,
  parseRecruitInstruction,
  RECRUIT_TARGET_URL,
  waitForRecruitSearchControls
} from "../src/domains/recruit/index.js";

function parseBoolean(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  if (["true", "1", "yes", "y", "on", "是", "要", "需要", "过滤"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off", "否", "不要", "不需要", "不过滤"].includes(normalized)) return false;
  return null;
}

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECRUIT_TARGET_URL,
    saveReport: ".live-artifacts/recruit-run-service-lifecycle.json",
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    allowNavigate: true,
    applySearch: true,
    resetSearch: true,
    instruction: "搜索关键词算法工程师，目标筛选2位",
    overrides: {},
    maxCandidates: 15,
    detailLimit: 1,
    delayMs: 650,
    pauseAfterProcessed: 1,
    resetTimeoutMs: 180000,
    searchTimeoutMs: 90000,
    cityOptionTimeoutMs: 30000,
    healthTimeoutMs: 90000,
    refreshOnEnd: true,
    maxRefreshRounds: 2,
    refreshResetSettleMs: 5000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--no-save-report") result.saveReport = "";
    if (arg === "--criteria") result.criteria = argv[++index];
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--no-apply-search") result.applySearch = false;
    if (arg === "--no-reset-search") result.resetSearch = false;
    if (arg === "--instruction") result.instruction = argv[++index];
    if (arg === "--keyword") result.overrides.keyword = argv[++index];
    if (arg === "--city") result.overrides.city = argv[++index];
    if (arg === "--degree") {
      const degreeValues = String(argv[++index] || "").split(/[，,、|/]/).map((item) => item.trim()).filter(Boolean);
      result.overrides.degrees = [
        ...(Array.isArray(result.overrides.degrees) ? result.overrides.degrees : []),
        ...degreeValues
      ];
      result.overrides.degree = result.overrides.degrees[0];
    }
    if (arg === "--degrees") {
      result.overrides.degrees = String(argv[++index] || "").split(/[，,、|/]/).map((item) => item.trim()).filter(Boolean);
      result.overrides.degree = result.overrides.degrees[0];
    }
    if (arg === "--school") {
      result.overrides.schools = [
        ...(Array.isArray(result.overrides.schools) ? result.overrides.schools : []),
        argv[++index]
      ];
    }
    if (arg === "--schools") result.overrides.schools = argv[++index];
    if (arg === "--filter-recent-viewed") {
      const parsed = parseBoolean(argv[++index]);
      if (parsed !== null) result.overrides.filter_recent_viewed = parsed;
    }
    if (arg === "--max-candidates") result.maxCandidates = Number(argv[++index]);
    if (arg === "--detail-limit") result.detailLimit = Number(argv[++index]);
    if (arg === "--delay-ms") result.delayMs = Number(argv[++index]);
    if (arg === "--pause-after-processed") result.pauseAfterProcessed = Number(argv[++index]);
    if (arg === "--no-refresh-on-end") result.refreshOnEnd = false;
    if (arg === "--refresh-on-end") result.refreshOnEnd = true;
    if (arg === "--max-refresh-rounds") result.maxRefreshRounds = Number(argv[++index]);
    if (arg === "--refresh-reset-settle-ms") result.refreshResetSettleMs = parsePositiveInt(argv[++index], result.refreshResetSettleMs);
    if (arg === "--slow-live") {
      result.resetTimeoutMs = 300000;
      result.searchTimeoutMs = 180000;
      result.cityOptionTimeoutMs = 60000;
      result.healthTimeoutMs = 180000;
      result.refreshResetSettleMs = 10000;
    }
    if (arg === "--reset-timeout-ms") result.resetTimeoutMs = parsePositiveInt(argv[++index], result.resetTimeoutMs);
    if (arg === "--search-timeout-ms") result.searchTimeoutMs = parsePositiveInt(argv[++index], result.searchTimeoutMs);
    if (arg === "--city-option-timeout-ms") {
      result.cityOptionTimeoutMs = parsePositiveInt(argv[++index], result.cityOptionTimeoutMs);
    }
    if (arg === "--health-timeout-ms") result.healthTimeoutMs = parsePositiveInt(argv[++index], result.healthTimeoutMs);
  }

  return result;
}

async function connectToRecruitSession(options) {
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
  throw new Error("Timed out waiting for recruit run service live condition");
}

function methodSummary(methodLog) {
  const summary = {};
  for (const entry of methodLog) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
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
    if (result.candidate?.identity) result.candidate.identity = redactIdentity(result.candidate.identity);
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

async function waitForHealthyRecruit(client, selfHealConfig, {
  timeoutMs = 20000,
  intervalMs = 800
} = {}) {
  const started = Date.now();
  let lastCheck = null;
  while (Date.now() - started <= timeoutMs) {
    const selfHealRoots = await resolveRecruitSelfHealRoots(client, selfHealConfig);
    lastCheck = await runSelfHealCheck({
      client,
      domain: "recruit",
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
    timeouts: {
      reset_timeout_ms: options.resetTimeoutMs,
      search_timeout_ms: options.searchTimeoutMs,
      city_option_timeout_ms: options.cityOptionTimeoutMs,
      health_timeout_ms: options.healthTimeoutMs
    },
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    },
    lifecycle: {}
  };

  try {
    session = await connectToRecruitSession(options);
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };

    await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
    await client.Network.setCacheDisabled({ cacheDisabled: true });
    await bringPageToFront(client);
    if (options.allowNavigate && !String(target.url || "").includes(options.targetUrlIncludes)) {
      await client.Page.navigate({ url: RECRUIT_TARGET_URL });
      await sleep(3000);
      result.chrome.navigated_to = RECRUIT_TARGET_URL;
      result.chrome.navigate_ready = await waitForRecruitSearchControls(client, {
        timeoutMs: options.searchTimeoutMs,
        intervalMs: 1000
      });
    }

    const parsedInstruction = parseRecruitInstruction({
      instruction: options.instruction || options.criteria,
      confirmation: {
        keyword_confirmed: true,
        criteria_confirmed: true,
        search_params_confirmed: true,
        use_default_for_missing: true
      },
      overrides: options.overrides
    });
    result.recruit_search_instruction = {
      instruction: options.instruction || options.criteria,
      search_params: parsedInstruction.searchParams,
      screen_params: parsedInstruction.screenParams,
      applied_defaults: parsedInstruction.applied_defaults,
      missing_fields: parsedInstruction.missing_fields
    };

    if (options.applySearch) {
      result.search_application = await applyRecruitSearchParams(client, {
        searchParams: parsedInstruction.searchParams,
        requireCards: true,
        resetBeforeApply: options.resetSearch,
        searchTimeoutMs: options.searchTimeoutMs,
        resetTimeoutMs: options.resetTimeoutMs,
        cityOptionTimeoutMs: options.cityOptionTimeoutMs
      });
    }

    const selfHealConfig = buildRecruitSelfHealConfig();
    const initialHealth = await waitForHealthyRecruit(client, selfHealConfig, {
      timeoutMs: options.healthTimeoutMs
    });
    result.self_heal = {
      initial: initialHealth ? compactHealth(initialHealth) : null
    };
    if (!initialHealth || initialHealth.status !== HEALTH_STATUS.HEALTHY) {
      throw new Error(`Recruit initial health is not healthy: ${initialHealth?.status || "missing"}`);
    }

    const service = createRecruitRunService({ idPrefix: "live_recruit" });
    const started = service.startRecruitRun({
      client,
      targetUrl: result.chrome.navigated_to || target.url,
      criteria: options.criteria,
      searchParams: parsedInstruction.searchParams,
      resetBeforeSearch: options.resetSearch,
      maxCandidates: options.maxCandidates,
      detailLimit: options.detailLimit,
      cardTimeoutMs: options.searchTimeoutMs,
      resetTimeoutMs: options.resetTimeoutMs,
      cityOptionTimeoutMs: options.cityOptionTimeoutMs,
      delayMs: options.delayMs,
      refreshOnEnd: options.refreshOnEnd,
      maxRefreshRounds: options.maxRefreshRounds,
      refreshResetSettleMs: options.refreshResetSettleMs,
      name: "live-recruit-run-service-smoke"
    });
    result.lifecycle.started = redactSnapshot(started);

    if (options.pauseAfterProcessed <= 0) {
      const final = await service.waitForRecruitRun(started.runId, { timeoutMs: 600000 });
      result.lifecycle.final = redactSnapshot(final);
      if (final.status !== RUN_STATUS_COMPLETED) {
        throw new Error(`Expected completed final status, got ${final.status}`);
      }
      result.runtime_guard_probe = assertNoForbiddenCdpCalls(methodLog);
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
      const snapshot = service.getRecruitRun(started.runId);
      return snapshot.progress.processed >= options.pauseAfterProcessed && snapshot;
    });
    result.lifecycle.first_progress = redactSnapshot(firstProgress);

    service.pauseRecruitRun(started.runId);
    const paused = await waitUntil(() => {
      const snapshot = service.getRecruitRun(started.runId);
      return snapshot.status === RUN_STATUS_PAUSED && snapshot;
    });
    result.lifecycle.paused = redactSnapshot(paused);

    await sleep(Math.max(700, options.delayMs + 150));
    const stillPaused = service.getRecruitRun(started.runId);
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
      throw new Error("Recruit run service progress changed while paused");
    }

    service.resumeRecruitRun(started.runId);
    const resumed = await waitUntil(() => {
      const snapshot = service.getRecruitRun(started.runId);
      return snapshot.progress.processed > paused.progress.processed && snapshot;
    });
    result.lifecycle.resumed = redactSnapshot(resumed);

    service.cancelRecruitRun(started.runId);
    const final = await service.waitForRecruitRun(started.runId, { timeoutMs: 8000 });
    result.lifecycle.final = redactSnapshot(final);
    if (final.status !== RUN_STATUS_CANCELED) {
      throw new Error(`Expected canceled final status, got ${final.status}`);
    }

    result.runtime_guard_probe = assertNoForbiddenCdpCalls(methodLog);
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
