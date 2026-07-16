import assert from "node:assert/strict";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_PAUSED
} from "./core/run/index.js";
import {
  applyRecommendFilterEnvelopeStages,
  compactFilterResult,
  buildRecommendFilterGroups,
  buildRecommendFilterSelectionOptions,
  countRecommendResultStatuses,
  createRecommendRunService,
  selectAndConfirmFirstSafeFilter
} from "./domains/recommend/index.js";

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
      assert.equal(options.filter.currentCityOnly, true);
      assert.deepEqual(options.filter.filterGroups, [
        {
          group: "degree",
          labels: ["本科", "硕士", "博士"],
          selectAllLabels: true,
          allowUnlimited: false,
          verifySticky: false
        },
        {
          group: "activity",
          labels: ["不限"],
          selectAllLabels: false,
          allowUnlimited: true,
          verifySticky: true
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
      currentCityOnly: true,
      filterGroups: [
        {
          group: "degree",
          labels: ["本科", "硕士", "博士"],
          selectAllLabels: true
        },
        {
          group: "activity",
          labels: ["不限"],
          selectAllLabels: false,
          allowUnlimited: true,
          verifySticky: true
        }
      ]
    },
    maxCandidates: 20,
    detailLimit: 1,
    maxRefreshRounds: 3
  });
  assert.deepEqual(started.context.filter.filterGroups.map((item) => item.group), ["degree", "activity"]);
  assert.equal(started.context.filter.currentCityOnly, true);
  assert.equal(started.context.current_city_only_requested, true);
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

function testRefreshFilterEnvelopePreservesActivitySafetyFlags() {
  const filter = {
    enabled: true,
    currentCityOnly: false,
    filterGroups: [
      {
        group: "activity",
        labels: ["不限"],
        selectAllLabels: false,
        allowUnlimited: true,
        verifySticky: true
      }
    ]
  };
  assert.deepEqual(buildRecommendFilterGroups(filter), filter.filterGroups);
  assert.deepEqual(buildRecommendFilterSelectionOptions(filter), {
    filterGroups: filter.filterGroups
  });

  const forced = buildRecommendFilterSelectionOptions(filter, { forceRecentNotView: true });
  assert.deepEqual(forced.filterGroups.map((group) => group.group), ["recentNotView", "activity"]);
  assert.deepEqual(forced.filterGroups[0], {
    group: "recentNotView",
    labels: ["近14天没有"],
    selectAllLabels: true,
    allowUnlimited: false,
    verifySticky: false
  });
  assert.equal(forced.filterGroups[1].allowUnlimited, true);
  assert.equal(forced.filterGroups[1].verifySticky, true);
}

async function testNativeFilterStageOrderingAndBypass() {
  const calls = [];
  const applied = await applyRecommendFilterEnvelopeStages({ enabled: true }, {
    applyCurrentCityOnly: async () => {
      calls.push("current_city_only");
      return { requested: false, effective: false };
    },
    applyFilterPanel: async () => {
      calls.push("filter_panel");
      return { confirmed: true };
    }
  });
  assert.deepEqual(calls, ["current_city_only", "filter_panel"]);
  assert.equal(applied.applied, true);
  assert.equal(applied.current_city_only.effective, false);
  assert.equal(applied.filter.confirmed, true);

  const bypassCalls = [];
  const bypassed = await applyRecommendFilterEnvelopeStages({ enabled: false }, {
    applyCurrentCityOnly: async () => bypassCalls.push("current_city_only"),
    applyFilterPanel: async () => bypassCalls.push("filter_panel")
  });
  assert.deepEqual(bypassCalls, []);
  assert.deepEqual(bypassed, {
    applied: false,
    skipped: true,
    current_city_only: null,
    filter: null
  });

  const failureCalls = [];
  await assert.rejects(
    applyRecommendFilterEnvelopeStages({ enabled: true }, {
      applyCurrentCityOnly: async () => {
        failureCalls.push("current_city_only");
        throw new Error("location verification failed");
      },
      applyFilterPanel: async () => failureCalls.push("filter_panel")
    }),
    /location verification failed/
  );
  assert.deepEqual(failureCalls, ["current_city_only"]);
}

function createRunServiceMissingFilterPanelClient() {
  return {
    DOM: {
      async querySelector() {
        return { nodeId: 0 };
      },
      async querySelectorAll() {
        return { nodeIds: [] };
      }
    }
  };
}

async function testRunServiceMissingFilterPanelDefaultPolicy() {
  const filter = {
    enabled: true,
    currentCityOnly: false,
    filterGroups: [{
      group: "activity",
      labels: ["不限"],
      selectAllLabels: false,
      allowUnlimited: true,
      verifySticky: true
    }]
  };
  const result = await selectAndConfirmFirstSafeFilter(
    createRunServiceMissingFilterPanelClient(),
    99,
    buildRecommendFilterSelectionOptions(filter)
  );
  assert.equal(result.confirmed, true);
  assert.equal(result.unavailable_default, true);
  const compact = compactFilterResult(result);
  assert.deepEqual(compact.requested_groups[0], {
    group: "activity",
    labels: ["不限"],
    select_all_labels: false,
    allow_unlimited: true,
    verify_sticky: true
  });
  assert.deepEqual(compact.effective_groups[0], {
    group: "activity",
    requested_labels: ["不限"],
    active_labels: [],
    verified: true,
    unavailable: true,
    reason: "activity_control_unavailable_default"
  });
  assert.equal(compact.sticky_verification.verified, true);
  assert.deepEqual(compact.attempts, {
    initial_close: [],
    open: [],
    confirmation: []
  });

  const stages = await applyRecommendFilterEnvelopeStages(filter, {
    applyCurrentCityOnly: async () => ({ requested: false, effective: false }),
    applyFilterPanel: async () => result
  });
  assert.equal(stages.applied, true);
  assert.equal(stages.filter.confirmed, true);
  assert.equal(stages.filter.unavailable, true);

  for (const failingFilter of [
    {
      enabled: true,
      filterGroups: [{
        group: "activity",
        labels: ["今日活跃"],
        selectAllLabels: false,
        allowUnlimited: true,
        verifySticky: true
      }]
    },
    {
      enabled: true,
      filterGroups: [{
        group: "school",
        labels: ["985"],
        selectAllLabels: true
      }]
    }
  ]) {
    await assert.rejects(
      selectAndConfirmFirstSafeFilter(
        createRunServiceMissingFilterPanelClient(),
        99,
        buildRecommendFilterSelectionOptions(failingFilter)
      ),
      /Recommend filter trigger was not found/
    );
  }
}

function testCompactFilterResultPreservesActivityEvidenceAndAttempts() {
  const compact = compactFilterResult({
    opened_panel: true,
    requested_groups: [{
      group: "activity",
      labels: ["今日活跃"],
      select_all_labels: false,
      allow_unlimited: true,
      verify_sticky: true
    }],
    selected_option: {
      group: "activity",
      label: "今日活跃",
      was_active: false,
      clicked: true
    },
    selected_options: [],
    unavailable: false,
    unavailable_groups: [],
    confirmed: true,
    sticky_verification: {
      verified: true,
      groups: [{
        group: "activity",
        requested_labels: ["今日活跃"],
        active_labels: ["今日活跃"],
        verified: true,
        unavailable: false
      }]
    },
    initial_close_attempts: ["Escape"],
    open_attempts: [{
      selector: ".filter-label-wrap",
      node_id: 10,
      click_target: { x: 100, y: 50 },
      click_result: { dispatched: true }
    }],
    confirm_attempts: [{
      node_id: 41,
      label: "确定",
      clicked: true,
      errors: []
    }],
    before_counts: { filter_panel: 0 },
    after_confirm_counts: { filter_panel: 0 }
  });
  assert.equal(compact.selected_option.group, "activity");
  assert.equal(compact.selected_option.label, "今日活跃");
  assert.equal(compact.selected_option.clicked, true);
  assert.deepEqual(compact.requested_groups[0].labels, ["今日活跃"]);
  assert.deepEqual(compact.effective_groups[0].active_labels, ["今日活跃"]);
  assert.equal(compact.sticky_verification.verified, true);
  assert.deepEqual(compact.attempts, {
    initial_close: ["Escape"],
    open: [{
      selector: ".filter-label-wrap",
      node_id: 10,
      click_target: { x: 100, y: 50 }
    }],
    confirmation: [{
      node_id: 41,
      label: "确定",
      clicked: true,
      errors: []
    }]
  });
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
    actionAfterClickDelayMs: 345,
    humanRestEnabled: true
  });

  assert.equal(started.context.post_action, "greet");
  assert.equal(started.context.max_greet_count, 2);
  assert.equal(started.context.execute_post_action, false);
  assert.equal(started.context.action_timeout_ms, 1234);
  assert.equal(started.context.human_rest_enabled, true);
  assert.equal(started.progress.human_rest_enabled, true);

  const final = await service.waitForRecommendRun(started.runId);
  assert.equal(final.status, "completed");
  assert.equal(observedOptions.postAction, "greet");
  assert.equal(observedOptions.maxGreetCount, 2);
  assert.equal(observedOptions.executePostAction, false);
  assert.equal(observedOptions.actionTimeoutMs, 1234);
  assert.equal(observedOptions.actionIntervalMs, 234);
  assert.equal(observedOptions.actionAfterClickDelayMs, 345);
  assert.equal(observedOptions.humanRestEnabled, true);
}

async function testDetailLimitDefaultsToUnlimitedForPassTarget() {
  let observedOptions = null;
  const service = createRecommendRunService({
    idPrefix: "test_recommend_detail_default",
    workflow: async (options, runControl) => {
      observedOptions = options;
      runControl.setPhase("test:detail-default");
      runControl.updateProgress({
        processed: 1,
        screened: 1,
        detail_opened: 1
      });
      return {
        processed: 1,
        screened: 1,
        detail_opened: 1,
        results: []
      };
    }
  });

  const started = service.startRecommendRun({
    client: {},
    targetUrl: "https://www.zhipin.com/web/chat/recommend",
    criteria: "算法",
    filter: { enabled: false },
    maxCandidates: 4
  });

  assert.equal(started.context.detail_limit, null);
  assert.equal(started.context.max_candidates_semantics, "passed_candidates");
  const final = await service.waitForRecommendRun(started.runId);
  assert.equal(final.status, "completed");
  assert.equal(observedOptions.detailLimit, null);
}

function testRecommendStatusCountersPreserveProgressAfterRecovery() {
  const counts = countRecommendResultStatuses([
    {
      screening: { passed: true },
      detail: {
        llm_screening: { status: "pass" },
        image_evidence: { ok: true }
      },
      post_action: { action_clicked: true }
    },
    {
      screening: { passed: false },
      detail: null,
      llm_screening: null,
      error: { code: "DETAIL_STALE_NODE" }
    },
    {
      screening: { passed: false },
      detail: null,
      llm_screening: null,
      error: { code: "DETAIL_OPEN_FAILED" }
    },
    {
      screening: { passed: false },
      detail: {
        image_evidence: {
          ok: false,
          error_code: "IMAGE_CAPTURE_TIMEOUT"
        }
      },
      error: { code: "IMAGE_CAPTURE_TIMEOUT" }
    }
  ], {
    greetCount: 1
  });

  assert.equal(counts.processed, 4);
  assert.equal(counts.screened, 4);
  assert.equal(counts.detail_opened, 2);
  assert.equal(counts.passed, 1);
  assert.equal(counts.llm_screened, 1);
  assert.equal(counts.greet_count, 1);
  assert.equal(counts.post_action_clicked, 1);
  assert.equal(counts.detail_open_failed, 2);
  assert.equal(counts.image_capture_failed, 1);
  assert.equal(counts.transient_recovered, 3);
}

await testLifecycleDelegation();
await testPostActionOptionDelegation();
await testDetailLimitDefaultsToUnlimitedForPassTarget();
await testNativeFilterStageOrderingAndBypass();
await testRunServiceMissingFilterPanelDefaultPolicy();
testCompactFilterResultPreservesActivityEvidenceAndAttempts();
testRefreshFilterEnvelopePreservesActivitySafetyFlags();
testRecommendStatusCountersPreserveProgressAfterRecovery();

console.log("recommend run service tests passed");
