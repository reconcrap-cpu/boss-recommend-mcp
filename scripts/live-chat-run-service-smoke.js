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
  buildChatSelfHealConfig,
  HEALTH_STATUS,
  resolveChatSelfHealRoots,
  runSelfHealCheck
} from "../src/core/self-heal/index.js";
import {
  CHAT_TARGET_URL,
  closeChatResumeModal,
  createChatRunService
} from "../src/domains/chat/index.js";

function parsePositiveInt(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: CHAT_TARGET_URL,
    saveReport: ".live-artifacts/chat-run-service-lifecycle-live.json",
    criteria: "候选人具备算法、数据、机器学习或软件开发相关经历",
    allowNavigate: true,
    navigateSettleMs: 5000,
    healthTimeoutMs: 90000,
    cardTimeoutMs: 90000,
    readyTimeoutMs: 60000,
    resumeDomTimeoutMs: 60000,
    maxCandidates: 8,
    detailLimit: 0,
    detailSource: "cascade",
    delayMs: 1200,
    pauseAfterProcessed: 1,
    listMaxScrolls: 20,
    listStableSignatureLimit: 2,
    listWheelDeltaY: 850,
    listSettleMs: 1200,
    listFallbackPoint: { x: 320, y: 620 }
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
    if (arg === "--navigate-settle-ms") result.navigateSettleMs = parsePositiveInt(argv[++index], result.navigateSettleMs);
    if (arg === "--health-timeout-ms") result.healthTimeoutMs = parsePositiveInt(argv[++index], result.healthTimeoutMs);
    if (arg === "--card-timeout-ms") result.cardTimeoutMs = parsePositiveInt(argv[++index], result.cardTimeoutMs);
    if (arg === "--ready-timeout-ms") result.readyTimeoutMs = parsePositiveInt(argv[++index], result.readyTimeoutMs);
    if (arg === "--resume-dom-timeout-ms") result.resumeDomTimeoutMs = parsePositiveInt(argv[++index], result.resumeDomTimeoutMs);
    if (arg === "--max-candidates") result.maxCandidates = parsePositiveInt(argv[++index], result.maxCandidates);
    if (arg === "--detail-limit") result.detailLimit = Number(argv[++index]);
    if (arg === "--detail-source") result.detailSource = argv[++index];
    if (arg === "--delay-ms") result.delayMs = Number(argv[++index]);
    if (arg === "--pause-after-processed") result.pauseAfterProcessed = Number(argv[++index]);
    if (arg === "--list-max-scrolls") result.listMaxScrolls = parsePositiveInt(argv[++index], result.listMaxScrolls);
    if (arg === "--list-stable-signature-limit") {
      result.listStableSignatureLimit = parsePositiveInt(argv[++index], result.listStableSignatureLimit);
    }
    if (arg === "--list-wheel-delta-y") result.listWheelDeltaY = parsePositiveInt(argv[++index], result.listWheelDeltaY);
    if (arg === "--list-settle-ms") result.listSettleMs = parsePositiveInt(argv[++index], result.listSettleMs);
    if (arg === "--list-fallback-point") {
      const [x, y] = String(argv[++index] || "").split(/[,，:x]/).map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) result.listFallbackPoint = { x, y };
    }
    if (arg === "--slow-live") {
      result.navigateSettleMs = 10000;
      result.healthTimeoutMs = 180000;
      result.cardTimeoutMs = 180000;
      result.readyTimeoutMs = 120000;
      result.resumeDomTimeoutMs = 120000;
      result.listSettleMs = 1800;
      result.delayMs = Math.max(result.delayMs, 1600);
    }
  }

  return result;
}

async function connectToChatSession(options) {
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

function shouldNavigateToChat(url) {
  const text = String(url || "");
  return !text.includes("/web/chat/index")
    || text.includes("/web/chat/recommend")
    || text.includes("/web/chat/search");
}

async function ensureChatPage(client, target, options) {
  if (!options.allowNavigate || !shouldNavigateToChat(target?.url)) {
    return {
      navigated: false,
      url: target?.url || ""
    };
  }
  await client.Page.navigate({ url: CHAT_TARGET_URL });
  await sleep(options.navigateSettleMs);
  return {
    navigated: true,
    url: CHAT_TARGET_URL,
    settle_ms: options.navigateSettleMs
  };
}

async function waitUntil(predicate, timeoutMs = 15000, intervalMs = 80) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for chat run service live condition");
}

async function waitForHealthyChat(client, config, {
  timeoutMs = 90000,
  intervalMs = 1000
} = {}) {
  const started = Date.now();
  let lastCheck = null;
  while (Date.now() - started <= timeoutMs) {
    const roots = await resolveChatSelfHealRoots(client, config);
    lastCheck = await runSelfHealCheck({
      client,
      domain: "chat",
      roots: roots.roots,
      selectorProbes: config.selectorProbes,
      accessibilityProbes: config.accessibilityProbes,
      viewportProbes: config.viewportProbes
    });
    if (lastCheck.status === HEALTH_STATUS.HEALTHY) return lastCheck;
    await sleep(intervalMs);
  }
  return lastCheck;
}

function compactHealth(check) {
  return {
    status: check?.status,
    summary: check?.summary,
    drift_report: check?.drift_report,
    probes: (check?.probes || []).map((probe) => ({
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

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let session;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    slow_live: options.healthTimeoutMs >= 180000,
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    },
    lifecycle: {}
  };

  try {
    session = await connectToChatSession(options);
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };

    await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
    await bringPageToFront(client);
    result.navigation = await ensureChatPage(client, target, options);

    const selfHealConfig = buildChatSelfHealConfig();
    const initialHealth = await waitForHealthyChat(client, selfHealConfig, {
      timeoutMs: options.healthTimeoutMs
    });
    result.self_heal = {
      initial: compactHealth(initialHealth)
    };
    if (!initialHealth || initialHealth.status !== HEALTH_STATUS.HEALTHY) {
      throw new Error(`Chat initial health is not healthy: ${initialHealth?.status || "missing"}`);
    }

    const service = createChatRunService({ idPrefix: "live_chat" });
    const started = service.startChatRun({
      client,
      targetUrl: CHAT_TARGET_URL,
      criteria: options.criteria,
      maxCandidates: options.maxCandidates,
      detailLimit: options.detailLimit,
      detailSource: options.detailSource,
      cardTimeoutMs: options.cardTimeoutMs,
      readyTimeoutMs: options.readyTimeoutMs,
      resumeDomTimeoutMs: options.resumeDomTimeoutMs,
      delayMs: options.delayMs,
      listMaxScrolls: options.listMaxScrolls,
      listStableSignatureLimit: options.listStableSignatureLimit,
      listWheelDeltaY: options.listWheelDeltaY,
      listSettleMs: options.listSettleMs,
      listFallbackPoint: options.listFallbackPoint,
      name: "live-chat-run-service-smoke"
    });
    result.lifecycle.started = redactSnapshot(started);

    if (options.pauseAfterProcessed <= 0) {
      const final = await service.waitForChatRun(started.runId, { timeoutMs: 600000 });
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
      const snapshot = service.getChatRun(started.runId);
      return snapshot.progress.processed >= options.pauseAfterProcessed && snapshot;
    }, Math.max(15000, options.cardTimeoutMs));
    result.lifecycle.first_progress = redactSnapshot(firstProgress);

    service.pauseChatRun(started.runId);
    const paused = await waitUntil(() => {
      const snapshot = service.getChatRun(started.runId);
      return snapshot.status === RUN_STATUS_PAUSED && snapshot;
    }, Math.max(15000, options.delayMs + options.listSettleMs + 5000));
    result.lifecycle.paused = redactSnapshot(paused);

    await sleep(Math.max(900, options.delayMs + 250));
    const stillPaused = service.getChatRun(started.runId);
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
      throw new Error("Chat run service progress changed while paused");
    }

    service.resumeChatRun(started.runId);
    const resumed = await waitUntil(() => {
      const snapshot = service.getChatRun(started.runId);
      return snapshot.progress.processed > paused.progress.processed && snapshot;
    }, Math.max(15000, options.delayMs + options.listSettleMs + 5000));
    result.lifecycle.resumed = redactSnapshot(resumed);

    service.cancelChatRun(started.runId);
    const final = await service.waitForChatRun(started.runId, { timeoutMs: 10000 });
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
      result.runtime_evaluate_used = session.methodLog.some((entry) => /^Runtime\./.test(entry.method));
    }
    try {
      if (session?.client) {
        await closeChatResumeModal(session.client, { attemptsLimit: 2 });
      }
    } catch {}
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
