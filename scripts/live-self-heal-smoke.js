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
  getMainFrameUrl,
  listChromeTargets,
  sleep,
  waitForMainFrameUrl
} from "../src/core/browser/index.js";
import {
  buildChatSelfHealConfig,
  buildRecommendSelfHealConfig,
  buildRecruitSelfHealConfig,
  classifyBossTargets,
  HEALTH_STATUS,
  resolveChatSelfHealRoots,
  resolveRecommendSelfHealRoots,
  resolveRecruitSelfHealRoots,
  runRepairAction,
  runSelfHealCheck
} from "../src/core/self-heal/index.js";

const DEFAULT_RULES_PATH = "";
const RECOMMEND_TARGET_URL = "https://www.zhipin.com/web/chat/recommend";
const RECRUIT_TARGET_URL = "https://www.zhipin.com/web/chat/search";
const CHAT_TARGET_URL = "https://www.zhipin.com/web/chat/index";

const DOMAIN_SPECS = Object.freeze({
  recommend: {
    targetUrl: RECOMMEND_TARGET_URL,
    buildConfig: buildRecommendSelfHealConfig,
    resolveRoots: resolveRecommendSelfHealRoots
  },
  recruit: {
    targetUrl: RECRUIT_TARGET_URL,
    buildConfig: buildRecruitSelfHealConfig,
    resolveRoots: resolveRecruitSelfHealRoots
  },
  chat: {
    targetUrl: CHAT_TARGET_URL,
    buildConfig: buildChatSelfHealConfig,
    resolveRoots: resolveChatSelfHealRoots
  }
});

function parseArgs(argv) {
  const result = {
    domain: "recommend",
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: "",
    rulesPath: DEFAULT_RULES_PATH,
    saveReport: "",
    skipRefreshRepair: false,
    allowNavigate: false,
    navigateSettleMs: 5000,
    healthTimeoutMs: 15000,
    postRepairHealthTimeoutMs: 20000,
    healthIntervalMs: 500
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--domain") result.domain = argv[++index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--rules") result.rulesPath = argv[++index];
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--no-save-report") result.saveReport = "";
    if (arg === "--skip-refresh-repair") result.skipRefreshRepair = true;
    if (arg === "--allow-navigate") result.allowNavigate = true;
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--navigate-settle-ms") result.navigateSettleMs = Number(argv[++index]);
    if (arg === "--health-timeout-ms") result.healthTimeoutMs = Number(argv[++index]);
    if (arg === "--post-repair-health-timeout-ms") result.postRepairHealthTimeoutMs = Number(argv[++index]);
    if (arg === "--health-interval-ms") result.healthIntervalMs = Number(argv[++index]);
    if (arg === "--slow-live") {
      result.allowNavigate = true;
      result.navigateSettleMs = 10000;
      result.healthTimeoutMs = 180000;
      result.postRepairHealthTimeoutMs = 180000;
      result.healthIntervalMs = 1000;
    }
  }

  result.domain = String(result.domain || "recommend").toLowerCase();
  const spec = DOMAIN_SPECS[result.domain];
  if (!spec) throw new Error(`Unsupported self-heal domain: ${result.domain}`);
  if (!result.targetUrlIncludes) result.targetUrlIncludes = spec.targetUrl;
  if (!result.saveReport) {
    result.saveReport = `.live-artifacts/${result.domain}-self-heal-report.json`;
  }
  return result;
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

function methodSummary(methodLog) {
  const summary = {};
  for (const entry of methodLog) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
}

function hasRoot(roots = {}, name) {
  const root = roots[name];
  return Boolean(
    typeof root === "number"
    || root?.nodeId
    || root?.documentNodeId
  );
}

function requiredRootsReady(roots = {}, config = {}) {
  const requiredRoots = new Set(
    (config.selectorProbes || [])
      .filter((probe) => probe.required)
      .map((probe) => probe.root || "top")
  );
  return [...requiredRoots].every((name) => hasRoot(roots, name));
}

function compactCheck(check) {
  if (!check) return null;
  return {
    domain: check.domain,
    status: check.status,
    summary: check.summary,
    probes: check.probes.map((probe) => ({
      id: probe.id,
      type: probe.type,
      status: probe.status,
      ok: probe.ok,
      required: probe.required,
      count: probe.count,
      root: probe.root || null,
      collapsed: probe.collapsed,
      recovered: probe.recovered,
      viewport_health: probe.viewport_health || undefined,
      matched_selectors: probe.matched_selectors || undefined,
      selector_counts: probe.selector_counts || undefined,
      total_ax_nodes: probe.total_ax_nodes || undefined,
      sample_urls: probe.sample_urls || undefined,
      error: probe.error || undefined
    })),
    drift_report: check.drift_report
  };
}

async function runSelfHealWithRetry({
  client,
  domain,
  config,
  resolveRoots,
  networkEvents = [],
  includeNetwork = false,
  timeoutMs = 10000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started <= timeoutMs) {
    const rootsState = await resolveRoots(client, config);
    const check = await runSelfHealCheck({
      client,
      domain,
      roots: rootsState.roots,
      selectorProbes: config.selectorProbes,
      accessibilityProbes: config.accessibilityProbes,
      viewportProbes: config.viewportProbes,
      networkProbes: includeNetwork ? config.networkProbes : [],
      networkEvents
    });
    last = { rootsState, check };
    if (requiredRootsReady(rootsState.roots, config) && check.status === HEALTH_STATUS.HEALTHY) {
      return last;
    }
    await sleep(intervalMs);
  }
  return last;
}

function toTargetSummary(targets = []) {
  return targets
    .filter((target) => target?.type === "page")
    .map((target) => ({
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    }));
}

function isDomainTargetUrl(domain, url = "") {
  const text = String(url || "");
  if (domain === "chat") {
    return text.includes("/web/chat/index")
      || (text.includes("/web/chat") && !text.includes("/web/chat/recommend") && !text.includes("/web/chat/search"));
  }
  if (domain === "recruit") return text.includes("/web/chat/search");
  return text.includes("/web/chat/recommend");
}

async function connectToDomainSession(options) {
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

async function ensureDomainPage(client, target, options, spec) {
  const beforeUrl = await getMainFrameUrl(client).catch(() => target?.url || "");
  if (!options.allowNavigate || isDomainTargetUrl(options.domain, beforeUrl)) {
    return {
      navigated: false,
      before_url: beforeUrl || target?.url || "",
      after_url: beforeUrl || target?.url || ""
    };
  }

  await client.Page.navigate({ url: spec.targetUrl });
  if (options.navigateSettleMs > 0) await sleep(options.navigateSettleMs);
  const waited = await waitForMainFrameUrl(
    client,
    (url) => isDomainTargetUrl(options.domain, url),
    {
      timeoutMs: Math.max(options.healthTimeoutMs, options.navigateSettleMs),
      intervalMs: options.healthIntervalMs
    }
  );
  const afterUrl = waited.url || await getMainFrameUrl(client).catch(() => spec.targetUrl);
  return {
    navigated: true,
    before_url: beforeUrl || target?.url || "",
    navigate_url: spec.targetUrl,
    wait: waited,
    after_url: afterUrl
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const spec = DOMAIN_SPECS[options.domain];
  let session;
  const networkEvents = [];
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    domain: options.domain,
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    }
  };

  try {
    const targets = await listChromeTargets({
      host: options.host,
      port: options.port
    });
    result.available_page_targets = toTargetSummary(targets);
    result.target_availability = classifyBossTargets(targets);

    const rules = readJsonFile(options.rulesPath);
    const config = spec.buildConfig(rules);

    session = await connectToDomainSession(options);
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };
    result.runtime_guard_probe = await assertRuntimeEvaluateBlocked(client);

    await enableDomains(client, ["Page", "DOM", "Accessibility", "Network"]);
    client.Network.responseReceived((event) => {
      networkEvents.push({
        requestId: event.requestId,
        url: event?.response?.url || "",
        status: event?.response?.status,
        mimeType: event?.response?.mimeType,
        type: event?.type
      });
    });
    await bringPageToFront(client);
    result.navigation = await ensureDomainPage(client, target, options, spec);

    const initialHealth = await runSelfHealWithRetry({
      client,
      domain: options.domain,
      config,
      resolveRoots: spec.resolveRoots,
      timeoutMs: options.healthTimeoutMs,
      intervalMs: options.healthIntervalMs
    });
    const initialCheck = initialHealth?.check;

    let repairResult = null;
    let postRefreshCheck = null;
    if (!options.skipRefreshRepair) {
      networkEvents.length = 0;
      repairResult = await runRepairAction(client, config.repairActions[0]);
      const postRefreshHealth = await runSelfHealWithRetry({
        client,
        domain: options.domain,
        config,
        resolveRoots: spec.resolveRoots,
        networkEvents,
        includeNetwork: true,
        timeoutMs: options.postRepairHealthTimeoutMs,
        intervalMs: options.healthIntervalMs
      });
      postRefreshCheck = postRefreshHealth?.check;
    }

    result.runtime_guard = {
      blocked: true,
      used_forbidden_runtime: false
    };
    result.self_heal = {
      [options.domain]: {
        initial: compactCheck(initialCheck),
        refresh_repair: repairResult,
        post_refresh: postRefreshCheck ? compactCheck(postRefreshCheck) : null,
        network_event_count_after_refresh: postRefreshCheck ? networkEvents.length : 0
      }
    };
    for (const domain of Object.keys(DOMAIN_SPECS)) {
      if (domain === options.domain) continue;
      result.self_heal[domain] = {
        status: result.target_availability[domain]?.status || "unknown",
        note: result.target_availability[domain]?.status === "available"
          ? `${domain} target is available for a future domain probe.`
          : `Blocked for live self-heal validation until a ${domain} target is open.`
      };
    }
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;

    assertNoForbiddenCdpCalls(methodLog);

    const domainLiveOk = initialCheck?.status === HEALTH_STATUS.HEALTHY
      && (!postRefreshCheck || postRefreshCheck.status === HEALTH_STATUS.HEALTHY);
    if (!domainLiveOk) {
      const statuses = [
        `initial=${initialCheck?.status || "missing"}`,
        `post_refresh=${postRefreshCheck?.status || "skipped"}`
      ].join(", ");
      throw new Error(`${options.domain} self-heal health check did not pass the live gate (${statuses})`);
    }

    result.status = "PASS";
    if (options.saveReport) {
      result.saved_report_path = path.resolve(options.saveReport);
      writeJsonFile(options.saveReport, result);
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
      result.saved_report_path = path.resolve(options.saveReport);
      writeJsonFile(options.saveReport, result);
    }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
