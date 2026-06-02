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
  pressKey,
  sleep
} from "../src/core/browser/index.js";
import {
  closeRecommendDetail,
  createRecommendDetailNetworkRecorder,
  discoverRecommendActionControls,
  getRecommendRoots,
  openRecommendCardDetail,
  readRecommendCardCandidate,
  RECOMMEND_TARGET_URL,
  resolveRecommendPostAction,
  waitForRecommendDetailActionControls,
  waitForRecommendCardNodeIds
} from "../src/domains/recommend/index.js";

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECOMMEND_TARGET_URL,
    saveReport: ".live-artifacts/recommend-actions-discovery-live.json",
    postAction: "greet",
    greetCount: 0,
    maxGreetCount: null,
    closeDetail: true,
    allowNavigate: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--save-report") result.saveReport = argv[++index];
    if (arg === "--post-action") result.postAction = argv[++index];
    if (arg === "--greet-count") result.greetCount = Number(argv[++index]);
    if (arg === "--max-greet-count") result.maxGreetCount = Number(argv[++index]);
    if (arg === "--leave-detail-open") result.closeDetail = false;
    if (arg === "--no-navigate") result.allowNavigate = false;
  }
  return result;
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

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (!["greet", "none"].includes(options.postAction)) {
    throw new Error(`Unsupported recommend post action: ${options.postAction}. Use greet or none.`);
  }
  let session;
  const result = {
    status: "UNKNOWN",
    generated_at: new Date().toISOString(),
    chrome: {
      host: options.host,
      port: options.port,
      target_url_includes: options.targetUrlIncludes
    }
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

    await enableDomains(client, ["Page", "DOM", "Input", "Network"]);
    const networkRecorder = createRecommendDetailNetworkRecorder(client);
    await bringPageToFront(client);
    if (options.allowNavigate && !String(target.url || "").includes(options.targetUrlIncludes)) {
      await client.Page.navigate({ url: RECOMMEND_TARGET_URL });
      await sleep(3000);
      result.chrome.navigated_to = RECOMMEND_TARGET_URL;
    }

    await closeRecommendDetail(client, { attemptsLimit: 2 });
    const rootState = await getRecommendRoots(client);
    const cardNodeIds = await waitForRecommendCardNodeIds(client, rootState.iframe.documentNodeId, {
      timeoutMs: 10000,
      intervalMs: 300
    });
    if (!cardNodeIds.length) {
      throw new Error("No recommend candidate cards found for action discovery");
    }

    const firstCardNodeId = cardNodeIds[0];
    const cardCandidate = await readRecommendCardCandidate(client, firstCardNodeId, {
      targetUrl: target.url,
      source: "recommend-actions-card"
    });
    networkRecorder.clear();
    const openedDetail = await openRecommendCardDetail(client, firstCardNodeId);
    const detailActionRoots = [
      openedDetail.detail_state?.popup?.node_id
        ? {
          name: `${openedDetail.detail_state.popup.root || "unknown"}:detail-popup`,
          nodeId: openedDetail.detail_state.popup.node_id
        }
        : null,
      openedDetail.detail_state?.resumeIframe?.node_id
        ? {
          name: `${openedDetail.detail_state.resumeIframe.root || "unknown"}:resume-iframe-node`,
          nodeId: openedDetail.detail_state.resumeIframe.node_id
        }
        : null
    ].filter(Boolean);
    let actionDiscovery = detailActionRoots.length
      ? await waitForRecommendDetailActionControls(client, {
        timeoutMs: 8000,
        intervalMs: 350
      })
      : await discoverRecommendActionControls(client);
    let actionDiscoveryScope = detailActionRoots.length ? "detail" : "page";
    if (
      !actionDiscovery.summary.favorite.found
      && !actionDiscovery.summary.greet.found
      && detailActionRoots.length
    ) {
      actionDiscovery = await discoverRecommendActionControls(client);
      actionDiscoveryScope = "page-fallback";
    }
    const plan = resolveRecommendPostAction({
      postAction: options.postAction,
      greetCount: options.greetCount,
      maxGreetCount: Number.isInteger(options.maxGreetCount) ? options.maxGreetCount : null
    });

    const requiredForPlan = plan.effective === "greet"
      ? actionDiscovery.summary.greet.found
      : true;
    if (!requiredForPlan) {
      throw new Error(`Planned action ${plan.effective} has no discovered control`);
    }

    let closeResult = null;
    if (options.closeDetail) {
      try {
        closeResult = await closeRecommendDetail(client);
      } catch (error) {
        await pressKey(client, "Escape", {
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27
        });
        await sleep(700);
        closeResult = {
          closed: false,
          best_effort: true,
          error: error?.message || String(error),
          attempts: [{ mode: "Escape-after-close-error" }]
        };
      }
    }

    assertNoForbiddenCdpCalls(methodLog);

    result.status = "PASS";
    result.runtime_evaluate_used = false;
    result.recommend = {
      iframe: {
        selector: rootState.iframe.selector,
        document_node_id: rootState.iframe.documentNodeId
      },
      cards: {
        count: cardNodeIds.length,
        first_card_node_id: firstCardNodeId,
        first_card_candidate: {
          schema_version: cardCandidate.schema_version,
          has_id: Boolean(cardCandidate.id),
          identity: redactIdentity(cardCandidate.identity),
          text_length: cardCandidate.text.raw.length
        }
      },
      detail: {
        opened: true,
        popup_found: Boolean(openedDetail.detail_state?.popup),
        resume_iframe_found: Boolean(openedDetail.detail_state?.resumeIframe),
        close_result: closeResult
      },
      action_plan: plan,
      action_discovery: {
        scope: actionDiscoveryScope,
        elapsed_ms: actionDiscovery.elapsed_ms,
        timed_out: actionDiscovery.timed_out,
        detail_root_count: actionDiscovery.detail_root_count,
        last_error: actionDiscovery.last_error,
        summary: actionDiscovery.summary,
        controls: actionDiscovery.controls.filter((control) => control.matches).map((control) => ({
          kind: control.kind,
          root: control.root,
          selector: control.selector,
          node_id: control.node_id,
          visible: control.visible,
          matches: control.matches,
          active: control.active,
          available: control.available,
          continue_chat: control.continue_chat,
          disabled: control.disabled,
          label: control.label,
          class_name: control.class_name,
          center: control.center,
          rect: control.rect,
          outer_html_length: control.outer_html_length,
          html_preview: control.html_preview
        }))
      },
      network_detail_event_count: networkRecorder.events.length
    };
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;
    result.saved_report_path = writeJsonFile(options.saveReport, result);
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
    try {
      result.saved_report_path = writeJsonFile(options.saveReport, result);
    } catch {}
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
