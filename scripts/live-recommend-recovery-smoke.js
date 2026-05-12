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
  getAttributesMap,
  getOuterHTML,
  querySelector,
  sleep
} from "../src/core/browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../src/core/screening/index.js";
import {
  findRecommendJobTrigger,
  getRecommendRoots,
  refreshRecommendListAtEnd,
  RECOMMEND_TARGET_URL,
  waitForRecommendCardNodeIds
} from "../src/domains/recommend/index.js";

function parseArgs(argv) {
  const options = {
    host: "127.0.0.1",
    port: 9222,
    targetUrl: RECOMMEND_TARGET_URL,
    targetUrlIncludes: RECOMMEND_TARGET_URL,
    jobLabel: "",
    pageScope: "recommend",
    fallbackPageScope: "recommend",
    forceNavigate: true,
    forceRecentNotView: true,
    reloadSettleMs: 12000,
    cardTimeoutMs: 60000,
    saveReport: ".live-artifacts/recommend-recovery-smoke.json",
    filterGroups: [
      {
        group: "degree",
        labels: ["本科", "硕士", "博士"],
        selectAllLabels: true
      },
      {
        group: "school",
        labels: ["985", "211", "双一流院校", "国内外名校"],
        selectAllLabels: true
      }
    ]
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") options.host = argv[++index];
    if (arg === "--port") options.port = Number(argv[++index]);
    if (arg === "--target-url") options.targetUrl = argv[++index];
    if (arg === "--target-url-includes") options.targetUrlIncludes = argv[++index];
    if (arg === "--job") options.jobLabel = argv[++index];
    if (arg === "--page-scope") options.pageScope = argv[++index];
    if (arg === "--fallback-page-scope") options.fallbackPageScope = argv[++index];
    if (arg === "--no-force-navigate") options.forceNavigate = false;
    if (arg === "--no-recent-not-view") options.forceRecentNotView = false;
    if (arg === "--reload-settle-ms") options.reloadSettleMs = Number(argv[++index]);
    if (arg === "--card-timeout-ms") options.cardTimeoutMs = Number(argv[++index]);
    if (arg === "--save-report") options.saveReport = argv[++index];
    if (arg === "--no-save-report") options.saveReport = "";
    if (arg === "--no-default-filter") options.filterGroups = [];
    if (arg === "--filter") {
      const raw = String(argv[++index] || "");
      const [group, labelsRaw = ""] = raw.split(/[:=]/);
      options.filterGroups.push({
        group: group.trim(),
        labels: labelsRaw.split(/[，,、|/]/).map((item) => item.trim()).filter(Boolean),
        selectAllLabels: true
      });
    }
  }

  return options;
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

async function connectToRecommendSession(options) {
  try {
    return await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes: options.targetUrlIncludes
    });
  } catch (error) {
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

async function readCurrentJobLabel(client, frameDocumentNodeId) {
  const labelNodeId = await querySelector(
    client,
    frameDocumentNodeId,
    ".job-selecter-wrap .ui-dropmenu-label, .ui-dropmenu-label"
  );
  if (!labelNodeId) return "";
  const html = await getOuterHTML(client, labelNodeId);
  return normalizeText(htmlToText(html));
}

async function summarizeRecommendState(client) {
  const roots = await getRecommendRoots(client);
  const iframeAttributes = await getAttributesMap(client, roots.iframe.nodeId).catch(() => ({}));
  const cardNodeIds = await waitForRecommendCardNodeIds(client, roots.iframe.documentNodeId, {
    timeoutMs: 1200,
    intervalMs: 200
  }).catch(() => []);
  const trigger = await findRecommendJobTrigger(client, roots.iframe.documentNodeId).catch(() => null);
  const currentJobLabel = trigger
    ? await readCurrentJobLabel(client, roots.iframe.documentNodeId).catch(() => "")
    : "";

  return {
    roots,
    summary: {
      iframe_selector: roots.iframe.selector || "",
      iframe_node_id: roots.iframe.nodeId,
      iframe_document_node_id: roots.iframe.documentNodeId,
      iframe_src: iframeAttributes.src || "",
      current_job_label: currentJobLabel,
      job_trigger_found: Boolean(trigger),
      job_trigger_rect: trigger?.rect || null,
      card_count: cardNodeIds.length
    }
  };
}

function compactRefreshResult(refreshResult = {}) {
  return {
    ok: Boolean(refreshResult.ok),
    method: refreshResult.method || "",
    reason: refreshResult.reason || null,
    error: refreshResult.error || null,
    forced_recent_not_view: Boolean(refreshResult.forced_recent_not_view),
    target_url: refreshResult.target_url || null,
    card_count: refreshResult.card_count || 0,
    elapsed_ms: refreshResult.elapsed_ms || 0,
    attempts: (refreshResult.attempts || []).map((attempt) => ({
      ok: Boolean(attempt.ok),
      method: attempt.method || "",
      reason: attempt.reason || null,
      error: attempt.error || null,
      card_count: attempt.card_count || 0,
      elapsed_ms: attempt.elapsed_ms || 0,
      job_selection_attempts: attempt.job_selection_attempts || []
    })),
    job_selection: refreshResult.job_selection
      ? {
        requested: refreshResult.job_selection.requested,
        selected: Boolean(refreshResult.job_selection.selected),
        already_current: Boolean(refreshResult.job_selection.already_current),
        reason: refreshResult.job_selection.reason || null,
        selected_option: refreshResult.job_selection.selected_option || null,
        refresh_attempts: refreshResult.job_selection.refresh_attempts || []
      }
      : null,
    job_selection_attempts: refreshResult.job_selection_attempts || [],
    page_scope: refreshResult.page_scope
      ? {
        requested_scope: refreshResult.page_scope.requested_scope,
        effective_scope: refreshResult.page_scope.effective_scope,
        selected: Boolean(refreshResult.page_scope.selected),
        fallback_applied: Boolean(refreshResult.page_scope.fallback_applied),
        reason: refreshResult.page_scope.reason || null,
        card_count: refreshResult.page_scope.card_count || refreshResult.page_scope.after?.card_count || 0
      }
      : null,
    filter: refreshResult.filter
      ? {
        confirmed: Boolean(refreshResult.filter.confirmed),
        selected_option: refreshResult.filter.selected_option || null,
        selected_options: refreshResult.filter.selected_options || []
      }
      : null,
    filter_reapply_attempts: refreshResult.filter_reapply_attempts || []
  };
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
    input: {
      target_url: options.targetUrl,
      job_label: options.jobLabel,
      page_scope: options.pageScope,
      fallback_page_scope: options.fallbackPageScope,
      force_navigate: options.forceNavigate,
      force_recent_not_view: options.forceRecentNotView,
      reload_settle_ms: options.reloadSettleMs,
      card_timeout_ms: options.cardTimeoutMs,
      filter_groups: options.filterGroups
    },
    before: null,
    refresh: null,
    after: null
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
    await enableDomains(client, ["Page", "DOM", "Input", "Accessibility"]);
    await bringPageToFront(client);

    const beforeState = await summarizeRecommendState(client);
    result.before = beforeState.summary;
    const jobLabel = options.jobLabel || beforeState.summary.current_job_label;
    if (!jobLabel) {
      throw new Error("No recommend job label was provided or detectable; pass --job");
    }
    result.input.job_label = jobLabel;

    const refreshResult = await refreshRecommendListAtEnd(client, {
      rootState: beforeState.roots,
      jobLabel,
      pageScope: options.pageScope,
      fallbackPageScope: options.fallbackPageScope,
      filter: { filterGroups: options.filterGroups },
      preferEndRefreshButton: false,
      forceNavigate: options.forceNavigate,
      targetUrl: options.targetUrl,
      forceRecentNotView: options.forceRecentNotView,
      cardTimeoutMs: options.cardTimeoutMs,
      reloadSettleMs: options.reloadSettleMs
    });
    result.refresh = compactRefreshResult(refreshResult);

    await sleep(1000);
    const afterState = await summarizeRecommendState(client);
    result.after = afterState.summary;
    result.method_summary = methodSummary(methodLog);
    assertNoForbiddenCdpCalls(methodLog);

    if (!refreshResult.ok) {
      throw new Error(`Recommend recovery refresh failed: ${refreshResult.reason || refreshResult.error || "unknown"}`);
    }
    if (!refreshResult.job_selection?.selected) {
      throw new Error("Recommend recovery smoke did not select the requested job");
    }
    if (!refreshResult.card_count) {
      throw new Error("Recommend recovery smoke found no cards after refresh");
    }

    result.status = "PASS";
  } catch (error) {
    result.status = "FAIL";
    result.error = {
      message: error?.message || String(error),
      stack: error?.stack || ""
    };
    process.exitCode = 1;
  } finally {
    if (session) await session.close().catch(() => null);
    if (options.saveReport) {
      result.report_path = writeJsonFile(options.saveReport, result);
    }
    console.log(JSON.stringify(result, null, 2));
  }
}

await run();
