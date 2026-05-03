import assert from "node:assert/strict";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_PAUSED
} from "./core/run/index.js";
import { createRecommendRunService } from "./domains/recommend/index.js";

async function waitUntil(predicate, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for recommend run service test condition");
}

async function testLifecycleDelegation() {
  const service = createRecommendRunService({
    idPrefix: "test_recommend",
    workflow: async (options, runControl) => {
      assert.equal(options.targetUrl, "https://www.zhipin.com/web/chat/recommend");
      assert.equal(options.jobLabel, "算法工程师");
      assert.equal(options.pageScope, "featured");
      assert.equal(options.fallbackPageScope, "recommend");
      assert.equal(options.refreshOnEnd, true);
      assert.equal(options.maxRefreshRounds, 3);
      assert.equal(options.postAction, "none");
      assert.equal(options.executePostAction, true);
      assert.deepEqual(options.filter.filterGroups, [
        {
          group: "degree",
          labels: ["本科", "硕士", "博士"],
          selectAllLabels: true
        },
        {
          group: "recentNotView",
          labels: ["近14天没有"],
          selectAllLabels: true
        }
      ]);
      for (let processed = 1; processed <= 20; processed += 1) {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("test:screening");
        runControl.updateProgress({
          card_count: 20,
          target_count: 20,
          processed,
          screened: processed,
          detail_opened: processed >= 1 ? 1 : 0
        });
        await runControl.sleep(25);
      }
      return { processed: 20 };
    }
  });

  const started = service.startRecommendRun({
    client: {},
    targetUrl: "https://www.zhipin.com/web/chat/recommend",
    criteria: "算法",
    jobLabel: "算法工程师",
    pageScope: "featured",
    filter: {
      filterGroups: [
        {
          group: "degree",
          labels: ["本科", "硕士", "博士"],
          selectAllLabels: true
        },
        {
          group: "recentNotView",
          labels: ["近14天没有"],
          selectAllLabels: true
        }
      ]
    },
    maxCandidates: 20,
    detailLimit: 1,
    maxRefreshRounds: 3
  });
  assert.deepEqual(started.context.filter.filterGroups.map((item) => item.group), ["degree", "recentNotView"]);
  assert.equal(started.context.job_label, "算法工程师");
  assert.equal(started.context.requested_page_scope, "featured");
  assert.equal(started.context.fallback_page_scope, "recommend");
  assert.equal(started.context.max_refresh_rounds, 3);

  await waitUntil(() => service.getRecommendRun(started.runId).progress.processed >= 2);
  service.pauseRecommendRun(started.runId);
  const paused = await waitUntil(() => {
    const snapshot = service.getRecommendRun(started.runId);
    return snapshot.status === RUN_STATUS_PAUSED && snapshot;
  });
  const pausedProgress = paused.progress.processed;
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(service.getRecommendRun(started.runId).progress.processed, pausedProgress);

  service.resumeRecommendRun(started.runId);
  await waitUntil(() => service.getRecommendRun(started.runId).progress.processed > pausedProgress);
  service.cancelRecommendRun(started.runId);
  const final = await service.waitForRecommendRun(started.runId);
  assert.equal(final.status, RUN_STATUS_CANCELED);
}

async function testPostActionOptionDelegation() {
  let observedOptions = null;
  const service = createRecommendRunService({
    idPrefix: "test_recommend_action",
    workflow: async (options, runControl) => {
      observedOptions = options;
      runControl.setPhase("test:post-action-options");
      runControl.updateProgress({
        processed: 1,
        screened: 1,
        passed: 1,
        greet_count: 0,
        post_action_clicked: 0
      });
      return {
        processed: 1,
        screened: 1,
        passed: 1,
        greet_count: 0,
        post_action_clicked: 0,
        results: []
      };
    }
  });

  const started = service.startRecommendRun({
    client: {},
    targetUrl: "https://www.zhipin.com/web/chat/recommend",
    criteria: "算法",
    filter: { enabled: false },
    maxCandidates: 1,
    postAction: "greet",
    maxGreetCount: 2,
    executePostAction: false,
    actionTimeoutMs: 1234,
    actionIntervalMs: 234,
    actionAfterClickDelayMs: 345
  });

  assert.equal(started.context.post_action, "greet");
  assert.equal(started.context.max_greet_count, 2);
  assert.equal(started.context.execute_post_action, false);
  assert.equal(started.context.action_timeout_ms, 1234);

  const final = await service.waitForRecommendRun(started.runId);
  assert.equal(final.status, "completed");
  assert.equal(observedOptions.postAction, "greet");
  assert.equal(observedOptions.maxGreetCount, 2);
  assert.equal(observedOptions.executePostAction, false);
  assert.equal(observedOptions.actionTimeoutMs, 1234);
  assert.equal(observedOptions.actionIntervalMs, 234);
  assert.equal(observedOptions.actionAfterClickDelayMs, 345);
}

await testLifecycleDelegation();
await testPostActionOptionDelegation();

console.log("recommend run service tests passed");
