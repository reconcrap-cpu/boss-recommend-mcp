#!/usr/bin/env node
import process from "node:process";
import {
  assertNoForbiddenCdpCalls,
  assertRuntimeEvaluateBlocked,
  bringPageToFront,
  connectToChromeTarget,
  countSelectors,
  enableDomains,
  findIframeDocument,
  getDocumentRoot,
  sleep
} from "../src/core/browser/index.js";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_PAUSED,
  createRunLifecycleManager
} from "../src/core/run/index.js";

const RECOMMEND_TARGET_URL = "https://www.zhipin.com/web/chat/recommend";
const RECOMMEND_IFRAME_SELECTORS = [
  'iframe[name="recommendFrame"]',
  'iframe[src*="/web/frame/recommend/"]',
  "iframe"
];
const SELECTORS = {
  recommend_card: ".candidate-card-wrap .card-inner[data-geek], .candidate-card-wrap [data-geek], li.geek-info-card a[data-geekid], a[data-geekid]"
};

function parseArgs(argv) {
  const result = {
    host: "127.0.0.1",
    port: 9222,
    targetUrlIncludes: RECOMMEND_TARGET_URL
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    if (arg === "--port") result.port = Number(argv[++index]);
    if (arg === "--target-url-includes") result.targetUrlIncludes = argv[++index];
  }
  return result;
}

async function waitUntil(predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(75);
  }
  throw new Error("Timed out waiting for live run lifecycle condition");
}

function methodSummary(methodLog) {
  const summary = {};
  for (const entry of methodLog) {
    summary[entry.method] = (summary[entry.method] || 0) + 1;
  }
  return summary;
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
    lifecycle: {}
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
    result.runtime_guard_probe = await assertRuntimeEvaluateBlocked(client);

    await enableDomains(client, ["Page", "DOM"]);
    await bringPageToFront(client);
    const root = await getDocumentRoot(client);
    const iframe = await findIframeDocument(client, root.nodeId, RECOMMEND_IFRAME_SELECTORS);
    if (!iframe) throw new Error("recommendFrame iframe was not found");

    const manager = createRunLifecycleManager({ idPrefix: "live_recommend" });
    const started = manager.startRun({
      name: "live-recommend-lifecycle-smoke",
      context: {
        targetUrl: target.url,
        iframeSelector: iframe.selector
      },
      progress: {
        iterations: 0,
        recommend_cards: 0
      },
      task: async (runControl) => {
        runControl.setPhase("live-card-count");
        for (let iteration = 0; iteration < 100; iteration += 1) {
          await runControl.waitIfPaused();
          runControl.throwIfCanceled();
          const counts = await countSelectors(client, iframe.documentNodeId, SELECTORS);
          runControl.updateProgress({
            iterations: iteration + 1,
            recommend_cards: counts.recommend_card
          });
          await runControl.sleep(180);
        }
        return { completedIterations: 100 };
      }
    });
    result.lifecycle.started = started;

    const firstProgress = await waitUntil(() => {
      const snapshot = manager.getRun(started.runId);
      return snapshot.progress.iterations >= 2 && snapshot;
    });
    result.lifecycle.first_progress = firstProgress.progress;

    manager.pauseRun(started.runId);
    const paused = await waitUntil(() => {
      const snapshot = manager.getRun(started.runId);
      return snapshot.status === RUN_STATUS_PAUSED && snapshot;
    });
    result.lifecycle.paused = {
      status: paused.status,
      progress: paused.progress
    };

    await sleep(650);
    const stillPaused = manager.getRun(started.runId);
    result.lifecycle.paused_stability = {
      before: paused.progress,
      after: stillPaused.progress,
      stable: stillPaused.progress.iterations === paused.progress.iterations
    };
    if (!result.lifecycle.paused_stability.stable) {
      throw new Error("Run progress changed while paused");
    }

    manager.resumeRun(started.runId);
    const resumed = await waitUntil(() => {
      const snapshot = manager.getRun(started.runId);
      return snapshot.progress.iterations > paused.progress.iterations && snapshot;
    });
    result.lifecycle.resumed = {
      status: resumed.status,
      progress: resumed.progress
    };

    manager.cancelRun(started.runId);
    const final = await manager.waitForRun(started.runId, { timeoutMs: 5000 });
    result.lifecycle.final = final;
    if (final.status !== RUN_STATUS_CANCELED) {
      throw new Error(`Expected canceled final status, got ${final.status}`);
    }

    assertNoForbiddenCdpCalls(methodLog);
    result.runtime_evaluate_used = false;
    result.method_summary = methodSummary(methodLog);
    result.method_log = methodLog;
    result.status = "PASS";
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
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } finally {
    if (session) await session.close();
  }
}

run();
