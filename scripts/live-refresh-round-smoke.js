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
  findRecommendEndRefreshButtons,
  getRecommendRoots,
  refreshRecommendListAtEnd,
  waitForRecommendRoots,
  RECOMMEND_TARGET_URL
} from "../src/domains/recommend/index.js";
import {
  parseRecruitInstruction,
  RECRUIT_TARGET_URL,
  refreshRecruitSearchAtEnd
} from "../src/domains/recruit/index.js";

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    domain: "recommend",
    allowNavigate: true,
    saveReport: ".live-artifacts/refresh-round-smoke.json",
    maxScrolls: 80,
    wheelDeltaY: 2400,
    settleMs: 1200,
    slowLive: false,
    recommendFilter: {
      filterGroups: [
        {
          group: "degree",
          labels: ["本科", "硕士", "博士"],
          selectAllLabels: true
        }
      ]
    },
    recruitInstruction: "搜索关键词算法工程师，目标筛选1位",
    recruitOverrides: {},
    searchTimeoutMs: 90000,
    resetTimeoutMs: 180000,
    cityOptionTimeoutMs: 30000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--domain") result.domain = argv[++index];
    if (arg === "--no-navigate") result.allowNavigate = false;
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--no-save-report") result.saveReport = "";
    if (arg === "--max-scrolls") result.maxScrolls = Number(argv[++index]);
    if (arg === "--wheel-delta-y") result.wheelDeltaY = Number(argv[++index]);
    if (arg === "--settle-ms") result.settleMs = Number(argv[++index]);
    if (arg === "--filter") {
      const raw = String(argv[++index] || "");
      const [group, labelsRaw = ""] = raw.split(/[:=]/);
      result.recommendFilter.filterGroups.push({
        group: group.trim(),
        labels: labelsRaw.split(/[，,、|/]/).map((item) => item.trim()).filter(Boolean),
        selectAllLabels: true
      });
    }
    if (arg === "--instruction") result.recruitInstruction = argv[++index];
    if (arg === "--keyword") result.recruitOverrides.keyword = argv[++index];
    if (arg === "--city") result.recruitOverrides.city = argv[++index];
    if (arg === "--degree") {
      const degreeValues = String(argv[++index] || "").split(/[，,、|/]/).map((item) => item.trim()).filter(Boolean);
      result.recruitOverrides.degrees = [
        ...(Array.isArray(result.recruitOverrides.degrees) ? result.recruitOverrides.degrees : []),
        ...degreeValues
      ];
      result.recruitOverrides.degree = result.recruitOverrides.degrees[0];
    }
    if (arg === "--school") {
      result.recruitOverrides.schools = [
        ...(Array.isArray(result.recruitOverrides.schools) ? result.recruitOverrides.schools : []),
        argv[++index]
      ];
    }
    if (arg === "--slow-live") {
      result.slowLive = true;
      result.maxScrolls = 160;
      result.settleMs = 3500;
      result.searchTimeoutMs = 180000;
      result.resetTimeoutMs = 300000;
      result.cityOptionTimeoutMs = 60000;
    }
  }

  return result;
}

function targetUrlForDomain(domain) {
  return domain === "recruit" || domain === "search" ? RECRUIT_TARGET_URL : RECOMMEND_TARGET_URL;
}

async function connectToBossSession(options) {
  const targetUrl = targetUrlForDomain(options.domain);
  try {
    return await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes: targetUrl
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

async function scrollRecommendUntilRefreshButton(client, options) {
  const attempts = [];
  let roots = await getRecommendRoots(client);
  for (let scroll = 0; scroll <= options.maxScrolls; scroll += 1) {
    const buttons = await findRecommendEndRefreshButtons(client, roots.iframe.documentNodeId);
    attempts.push({
      scroll,
      refresh_button_count: buttons.length,
      labels: buttons.map((button) => button.label).slice(0, 5)
    });
    if (buttons.length) {
      return {
        ok: true,
        roots,
        attempts,
        button: {
          node_id: buttons[0].node_id,
          label: buttons[0].label,
          y: buttons[0].box?.rect?.y || null
        }
      };
    }
    const point = { x: 700, y: 620 };
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: point.x, y: point.y, button: "none" });
    await client.Input.dispatchMouseEvent({
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: Math.max(1, Number(options.wheelDeltaY) || 2400)
    });
    if (options.settleMs > 0) await sleep(options.settleMs);
    roots = await getRecommendRoots(client);
  }
  return {
    ok: false,
    roots,
    attempts,
    reason: "refresh_button_not_found_after_scrolls"
  };
}

async function runRecommend(client, options) {
  const scrollResult = await scrollRecommendUntilRefreshButton(client, options);
  const refreshResult = await refreshRecommendListAtEnd(client, {
    rootState: scrollResult.roots,
    filter: options.recommendFilter,
    forceRecentNotView: true,
    cardTimeoutMs: options.slowLive ? 120000 : 30000,
    buttonSettleMs: options.slowLive ? 12000 : 8000,
    reloadSettleMs: options.slowLive ? 12000 : 8000
  });
  if (!refreshResult.ok) {
    throw new Error(`Recommend refresh round failed via ${refreshResult.method || "unknown"}`);
  }
  return {
    domain: "recommend",
    scroll_to_refresh_button: scrollResult,
    refresh: {
      ok: refreshResult.ok,
      method: refreshResult.method,
      forced_recent_not_view: refreshResult.forced_recent_not_view,
      card_count: refreshResult.card_count,
      filter: {
        confirmed: refreshResult.filter?.confirmed || false,
        selected_option: refreshResult.filter?.selected_option || null,
        selected_options: refreshResult.filter?.selected_options || []
      },
      attempts: refreshResult.attempts
    }
  };
}

async function runRecruit(client, options) {
  const parsedInstruction = parseRecruitInstruction({
    instruction: options.recruitInstruction,
    confirmation: {
      keyword_confirmed: true,
      criteria_confirmed: true,
      search_params_confirmed: true,
      use_default_for_missing: true
    },
    overrides: options.recruitOverrides
  });
  const refreshResult = await refreshRecruitSearchAtEnd(client, {
    searchParams: parsedInstruction.searchParams,
    requireCards: true,
    searchTimeoutMs: options.searchTimeoutMs,
    resetTimeoutMs: options.resetTimeoutMs,
    resetSettleMs: options.slowLive ? 10000 : 5000,
    cityOptionTimeoutMs: options.cityOptionTimeoutMs
  });
  if (!refreshResult.ok) {
    throw new Error("Recruit/search refresh round failed");
  }
  return {
    domain: "recruit",
    parsed_instruction: {
      search_params: parsedInstruction.searchParams,
      screen_params: parsedInstruction.screenParams
    },
    refresh: {
      ok: refreshResult.ok,
      method: refreshResult.method,
      forced_recent_viewed: refreshResult.forced_recent_viewed,
      search_params: refreshResult.search_params,
      card_count: refreshResult.card_count,
      post_search_state: refreshResult.application?.post_search_state || null,
      steps: (refreshResult.application?.steps || []).map((step) => ({
        step: step.step,
        applied: step.result?.applied,
        clicked: step.result?.clicked,
        searched: step.result?.searched,
        reason: step.result?.reason || null
      }))
    }
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  let session;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    domain: options.domain,
    chrome: {
      host: options.host,
      port: options.port
    }
  };

  try {
    session = await connectToBossSession(options);
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
    const targetUrl = targetUrlForDomain(options.domain);
    if (options.allowNavigate && !String(target.url || "").includes(targetUrl)) {
      await client.Page.navigate({ url: targetUrl });
      if (options.domain === "recommend") {
        const ready = await waitForRecommendRoots(client, {
          timeoutMs: options.slowLive ? 180000 : 30000,
          intervalMs: 500
        });
        if (!ready?.iframe?.documentNodeId) {
          throw new Error("Recommend iframe was not ready after navigation");
        }
      } else {
        await sleep(options.slowLive ? 8000 : 3000);
      }
      result.chrome.navigated_to = targetUrl;
    }

    result.behavior = options.domain === "recruit" || options.domain === "search"
      ? await runRecruit(client, options)
      : await runRecommend(client, options);

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
      result.saved_failure_report_path = writeJsonFile(options.saveReport, result);
    }
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
