#!/usr/bin/env node
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  clickNodeCenter,
  connectToChromeTarget,
  countSelectors,
  enableDomains,
  findIframeDocument,
  findFirstNode,
  getNodeBox,
  getDocumentRoot,
  pressKey,
  querySelectorAll,
  sleep,
  waitForSelector
} from "../src/core/browser/index.js";

const RECOMMEND_TARGET_URL = "https://www.zhipin.com/web/chat/recommend";
const RECOMMEND_IFRAME_SELECTORS = [
  'iframe[name="recommendFrame"]',
  'iframe[src*="/web/frame/recommend/"]',
  "iframe"
];

const SELECTORS = {
  filter_trigger: ".filter-label-wrap",
  filter_panel: ".filter-panel",
  check_box: ".filter-panel .check-box",
  option: ".filter-panel .option",
  recommend_card: ".candidate-card-wrap .card-inner[data-geek], .candidate-card-wrap [data-geek], li.geek-info-card a[data-geekid], a[data-geekid]"
};

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECOMMEND_TARGET_URL,
    closePanel: true
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
    if (arg === "--leave-panel-open") result.closePanel = false;
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

async function panelCount(client, frameDocumentNodeId) {
  return (await querySelectorAll(client, frameDocumentNodeId, SELECTORS.filter_panel)).length;
}

async function ensurePanelClosed(client, frameDocumentNodeId, triggerNodeId) {
  const attempts = [];
  if (await panelCount(client, frameDocumentNodeId) === 0) return attempts;

  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
  await sleep(400);
  attempts.push("Escape");

  if (await panelCount(client, frameDocumentNodeId) > 0 && triggerNodeId) {
    await clickNodeCenter(client, triggerNodeId);
    await sleep(500);
    attempts.push("filter-trigger-toggle");
  }

  return attempts;
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
    runtime_guard_probe: null,
    recommend: {}
  };

  try {
    session = await connectToChromeTarget({
      host: options.host,
      port: options.port,
      targetUrlIncludes: options.targetUrlIncludes
    });
    const { client, methodLog, target } = session;
    result.chrome.target = {
      id: target.id,
      type: target.type,
      url: target.url,
      title: target.title
    };


    await enableDomains(client, ["Page", "DOM", "Input", "Accessibility"]);
    await bringPageToFront(client);

    const root = await getDocumentRoot(client);
    const iframe = await findIframeDocument(client, root.nodeId, RECOMMEND_IFRAME_SELECTORS);
    if (!iframe) {
      throw new Error("recommendFrame iframe was not found with CDP DOM selectors");
    }
    result.recommend.iframe = {
      selector: iframe.selector,
      node_id: iframe.nodeId,
      document_node_id: iframe.documentNodeId
    };

    const trigger = await findFirstNode(client, iframe.documentNodeId, [SELECTORS.filter_trigger]);
    if (!trigger) {
      throw new Error("Recommend filter trigger .filter-label-wrap was not found");
    }
    result.recommend.initial_close_attempts = await ensurePanelClosed(client, iframe.documentNodeId, trigger.nodeId);
    const triggerBox = await getNodeBox(client, trigger.nodeId);
    result.recommend.filter_trigger = {
      node_id: trigger.nodeId,
      center: triggerBox.center,
      rect: triggerBox.rect
    };
    result.recommend.before_counts = await countSelectors(client, iframe.documentNodeId, SELECTORS);

    await clickNodeCenter(client, trigger.nodeId);
    const panelNodeId = await waitForSelector(client, iframe.documentNodeId, SELECTORS.filter_panel, {
      timeoutMs: 6000,
      intervalMs: 200
    });
    result.recommend.opened_panel = Boolean(panelNodeId);
    result.recommend.panel_node_id = panelNodeId || null;
    result.recommend.after_open_counts = await countSelectors(client, iframe.documentNodeId, SELECTORS);

    if (options.closePanel) {
      result.recommend.close_attempts = await ensurePanelClosed(client, iframe.documentNodeId, trigger.nodeId);
      result.recommend.after_close_counts = await countSelectors(client, iframe.documentNodeId, SELECTORS);
    }

    result.runtime_guard_probe = assertNoForbiddenCdpCalls(methodLog);
    result.runtime_evaluate_used = false;
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;
    result.status = result.recommend.opened_panel ? "PASS" : "FAIL";
    console.log(JSON.stringify(result, null, 2));
    if (!result.recommend.opened_panel) process.exitCode = 1;
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
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) {
      await session.close();
    }
  }
}

run();
