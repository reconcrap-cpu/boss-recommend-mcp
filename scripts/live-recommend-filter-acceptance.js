#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  connectToChromeTarget,
  enableDomains,
  sleep
} from "../src/core/browser/index.js";
import {
  ensureRecommendCurrentCityOnly,
  getRecommendRoots,
  RECOMMEND_TARGET_URL,
  refreshRecommendListAtEnd,
  selectAndConfirmFirstSafeFilter
} from "../src/domains/recommend/index.js";

const JOB = process.argv.slice(2).join(" ").trim()
  || "科研算法实习生（3D重建与生成）-可转正 _ 杭州";
const outputDir = path.resolve(".live-artifacts/recommend-filter-acceptance");
const outputPath = path.join(outputDir, "result.json");
const SETTINGS_COOLDOWN_MS = 3000;
const session = await connectToChromeTarget({
  host: "127.0.0.1",
  port: 9222,
  targetUrlIncludes: RECOMMEND_TARGET_URL
});

function activitySpec(level) {
  return {
    group: "activity",
    labels: [level],
    selectAllLabels: false,
    allowUnlimited: true,
    verifySticky: true
  };
}

function compactFilter(result) {
  return {
    confirmed: result.confirmed,
    selected_option: result.selected_option,
    selected_options: result.selected_options,
    unavailable: result.unavailable,
    unavailable_groups: result.unavailable_groups,
    sticky_verification: result.sticky_verification
  };
}

async function ensureState(client, currentCityOnly, activityLevel) {
  let roots = await getRecommendRoots(client);
  const city = await ensureRecommendCurrentCityOnly(
    client,
    roots.iframe.documentNodeId,
    { enabled: currentCityOnly }
  );
  roots = await getRecommendRoots(client);
  const filter = await selectAndConfirmFirstSafeFilter(
    client,
    roots.iframe.documentNodeId,
    {
      filterGroups: [activitySpec(activityLevel)],
      afterConfirmSettleMs: 800,
      stickySettleMs: 300
    }
  );
  return { city, filter: compactFilter(filter) };
}

async function capture(client, name) {
  const screenshot = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
  const screenshotPath = path.join(outputDir, `${name}.png`);
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  return screenshotPath;
}

try {
  fs.mkdirSync(outputDir, { recursive: true });
  const { client, methodLog, target } = session;
  await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
  await bringPageToFront(client);

  const precondition = await ensureState(client, false, "不限");
  await sleep(SETTINGS_COOLDOWN_MS);
  const applied = await ensureState(client, true, "今日活跃");
  const appliedScreenshot = await capture(client, "01-applied-city-and-today");
  await sleep(SETTINGS_COOLDOWN_MS);
  const reset = await ensureState(client, false, "不限");
  const resetScreenshot = await capture(client, "02-reset-defaults");
  await sleep(SETTINGS_COOLDOWN_MS);

  const refresh = await refreshRecommendListAtEnd(client, {
    jobLabel: JOB,
    pageScope: "recommend",
    fallbackPageScope: "recommend",
    filter: {
      enabled: true,
      currentCityOnly: true,
      filterGroups: [activitySpec("今日活跃")]
    },
    preferEndRefreshButton: false,
    forceNavigate: false,
    forceRecentNotView: false,
    cardTimeoutMs: 30000,
    reloadSettleMs: 3000
  });
  if (!refresh.ok) {
    throw new Error(`Recommend refresh acceptance failed: ${refresh.reason || refresh.error}`);
  }
  const refreshScreenshot = await capture(client, "03-refresh-reapplied");
  await sleep(SETTINGS_COOLDOWN_MS);
  const cleanup = await ensureState(client, false, "不限");

  assertNoForbiddenCdpCalls(methodLog);
  const runtimeMethods = methodLog.filter((entry) => String(entry.method || "").startsWith("Runtime."));
  const scriptInjectionMethods = methodLog.filter((entry) => String(entry.method || "").startsWith("Page.addScript"));
  if (runtimeMethods.length || scriptInjectionMethods.length) {
    throw new Error("Forbidden browser execution method appeared in the live acceptance log");
  }
  const methodSummary = methodLog.reduce((summary, entry) => {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
    return summary;
  }, {});
  const result = {
    status: "PASS",
    generated_at: new Date().toISOString(),
    target: { id: target.id, url: target.url, title: target.title },
    job: JOB,
    post_action: "none",
    settings_cooldown_ms: SETTINGS_COOLDOWN_MS,
    precondition,
    applied,
    reset,
    refresh: {
      ok: refresh.ok,
      method: refresh.method,
      page_scope: refresh.page_scope,
      current_city_only: refresh.current_city_only,
      current_city_only_attempts: refresh.current_city_only_attempts,
      filter: compactFilter(refresh.filter),
      filter_reapply_attempts: refresh.filter_reapply_attempts,
      card_count: refresh.card_count,
      forced_recent_not_view: refresh.forced_recent_not_view
    },
    cleanup,
    screenshots: {
      applied: appliedScreenshot,
      reset: resetScreenshot,
      refresh_reapplied: refreshScreenshot
    },
    forbidden_method_counts: {
      runtime: runtimeMethods.length,
      script_injection: scriptInjectionMethods.length
    },
    method_summary: methodSummary,
    method_log: methodLog
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: result.status,
    output_path: outputPath,
    applied: result.applied,
    reset: result.reset,
    refresh: result.refresh,
    cleanup: result.cleanup,
    screenshots: result.screenshots,
    forbidden_method_counts: result.forbidden_method_counts,
    method_summary: result.method_summary
  }, null, 2));
} finally {
  await session.close();
}
