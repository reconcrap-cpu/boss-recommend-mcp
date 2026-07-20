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
import {
  acquireRecommendListReadWithStaleRecovery,
  compactRecommendDomRootIdentity,
  createRecommendDomStaleForensicEvent,
  createRecommendDebugBoundaryController,
  createRecommendRefreshFailureError,
  normalizeRecommendDebugBoundaryOptions,
  recoverRecommendListReadStaleContext
} from "./domains/recommend/run-service.js";

function createListReadStaleError(nodeId = 101) {
  const error = new Error("Could not find node with given id");
  error.cdp_method = "DOM.querySelectorAll";
  error.cdp_at = "2026-07-17T10:00:00.000Z";
  error.cdp_node_id = nodeId;
  error.cdp_connection_epoch = 2;
  error.cdp_reconnected_epoch = 3;
  error.cdp_replay_policy = "safe_read_only";
  error.cdp_replayed_after_reconnect = true;
  error.cdp_param_keys = ["nodeId", "selector", "unsafe-key!"];
  return error;
}

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

function testDebugBoundaryValidationAndOnceOnlyController() {
  assert.throws(
    () => normalizeRecommendDebugBoundaryOptions({
      debug_force_list_end_after_processed: 3
    }),
    /requires debug_test_mode=true/
  );
  assert.throws(
    () => normalizeRecommendDebugBoundaryOptions({
      debug_test_mode: true,
      debug_force_list_end_after_processed: 3,
      debug_force_context_recovery_after_processed: 3
    }),
    /mutually exclusive/
  );
  assert.throws(
    () => normalizeRecommendDebugBoundaryOptions({
      debug_test_mode: true,
      debug_force_cdp_reconnect_after_processed: 0
    }),
    /positive integer/
  );

  for (const [field, expectedMode] of [
    ["debug_force_list_end_after_processed", "list_end"],
    ["debug_force_context_recovery_after_processed", "context_recovery"],
    ["debug_force_cdp_reconnect_after_processed", "cdp_reconnect"]
  ]) {
    const controller = createRecommendDebugBoundaryController({
      debug_test_mode: true,
      [field]: 3
    });
    assert.equal(controller.take(2), null);
    assert.equal(controller.take(3).mode, expectedMode);
    assert.equal(controller.take(3), null);
    assert.equal(controller.take(99), null);
    assert.equal(controller.getState().trigger_count, 1);
  }
}

async function testListReadStaleRecoveryThenSuccess() {
  let acquireCount = 0;
  let recoverCount = 0;
  const recoveredDiagnostics = [];
  const order = [];
  const acquisition = await acquireRecommendListReadWithStaleRecovery({
    maxRetries: 2,
    acquire: async () => {
      acquireCount += 1;
      if (acquireCount === 1) throw createListReadStaleError(111);
      return { ok: true, item: { key: "candidate:new" } };
    },
    onStale: async () => {
      order.push("stale_checkpoint");
    },
    recover: async () => {
      order.push("recover");
      recoverCount += 1;
      return { recovery_mode: "root_reacquire" };
    },
    onRecoveryApplied: async () => {
      order.push("recovery_applied");
    },
    onRecovered: async ({ diagnostic }) => {
      order.push("recovered");
      recoveredDiagnostics.push(diagnostic);
    }
  });
  assert.equal(acquireCount, 2);
  assert.equal(recoverCount, 1);
  assert.equal(acquisition.result.item.key, "candidate:new");
  assert.equal(acquisition.stale_diagnostics.length, 1);
  assert.equal(acquisition.stale_diagnostics[0].recovered, true);
  assert.equal(acquisition.stale_diagnostics[0].cdp_method, "DOM.querySelectorAll");
  assert.equal(acquisition.stale_diagnostics[0].cdp_node_id, 111);
  assert.equal(acquisition.stale_diagnostics[0].cdp_connection_epoch, 2);
  assert.equal(acquisition.stale_diagnostics[0].cdp_reconnected_epoch, 3);
  assert.equal(acquisition.stale_diagnostics[0].cdp_replay_policy, "safe_read_only");
  assert.equal(acquisition.stale_diagnostics[0].cdp_replayed_after_reconnect, true);
  assert.equal(acquisition.stale_diagnostics[0].cdp_at, "2026-07-17T10:00:00.000Z");
  assert.deepEqual(acquisition.stale_diagnostics[0].cdp_param_keys, ["nodeId", "selector"]);
  assert.equal(acquisition.stale_diagnostics[0].recovery_mode, "root_reacquire");
  assert.equal(recoveredDiagnostics.length, 1);
  assert.deepEqual(order, ["stale_checkpoint", "recover", "recovery_applied", "recovered"]);
}

function testDomStaleForensicEventIsSafeAndCorrelatable() {
  const error = createListReadStaleError(771);
  error.cdp_search_id = "search-7";
  error.cdp_replay_suppressed = true;
  error.cdp_outcome_unknown = true;
  const listState = {
    domain: "recommend",
    list_name: "recommend-candidates",
    seen_keys: new Set(["candidate:done"]),
    queued_keys: new Set(),
    processed_keys: new Set(["candidate:done"]),
    ledger: [{
      at: "2026-07-17T10:00:00.000Z",
      event: "candidate_read_error",
      node_id: 771,
      visible_index: 4,
      error: error.message
    }]
  };
  const rootState = {
    topRoot: { nodeId: 10 },
    iframe: {
      nodeId: 20,
      documentNodeId: 30,
      selector: "#recommendFrame"
    },
    rootNodes: { top: 10, frameOwner: 20, frame: 30 }
  };
  assert.deepEqual(compactRecommendDomRootIdentity(rootState, 2), {
    connection_epoch: 2,
    top_document_node_id: 10,
    iframe_owner_node_id: 20,
    iframe_document_node_id: 30,
    iframe_selector: "#recommendFrame"
  });
  const event = createRecommendDomStaleForensicEvent(error, {
    eventId: "dom-stale-test",
    phase: "recommend:list-read",
    operation: "candidate:list-read-card",
    candidateIndex: 10,
    rootState,
    connectionEpoch: 2,
    listState,
    counters: { processed: 10, passed: 1 },
    timeline: Array.from({ length: 25 }, (_, index) => ({
      at: `2026-07-17T10:00:${String(index).padStart(2, "0")}.000Z`,
      type: "DOM.documentUpdated"
    }))
  });
  assert.equal(event.event_id, "dom-stale-test");
  assert.equal(event.candidate.index, 10);
  assert.equal(event.candidate.failing_list_node_id, 771);
  assert.equal(event.candidate.visible_index, 4);
  assert.equal(event.error.cdp_connection_epoch, 2);
  assert.equal(event.error.cdp_reconnected_epoch, 3);
  assert.equal(event.error.cdp_search_id, "search-7");
  assert.equal(event.error.cdp_replay_suppressed, true);
  assert.equal(event.error.cdp_outcome_unknown, true);
  assert.equal(event.lifecycle_timeline.length, 20);
  assert.equal(JSON.stringify(event).includes("unsafe-key!"), false);
}

async function testListReadRepeatedStaleIsBounded() {
  let acquireCount = 0;
  let recoverCount = 0;
  await assert.rejects(
    acquireRecommendListReadWithStaleRecovery({
      maxRetries: 2,
      acquire: async () => {
        acquireCount += 1;
        throw createListReadStaleError(200 + acquireCount);
      },
      recover: async () => {
        recoverCount += 1;
      }
    }),
    (error) => {
      assert.equal(error.list_read_stale_recovery_exhausted, true);
      assert.equal(error.phase, "recommend:list-read");
      assert.equal(error.list_read_stale_recovery_attempts.length, 3);
      assert.equal(error.list_read_stale_recovery_attempts[2].exhausted, true);
      assert.equal(
        error.list_read_stale_recovery_attempts.filter((item) => item.recovered === true).length,
        0
      );
      return true;
    }
  );
  assert.equal(acquireCount, 3);
  assert.equal(recoverCount, 2);
}

async function testListReadRecoveryDoesNotDuplicateResultsOrActions() {
  const results = [{ candidate_key: "candidate:processed" }];
  let postActionCount = 1;
  const processedLedger = new Set(["candidate:processed"]);
  const queuedLedger = new Set(["candidate:queued"]);
  let acquireCount = 0;
  const acquisition = await acquireRecommendListReadWithStaleRecovery({
    maxRetries: 2,
    acquire: async () => {
      acquireCount += 1;
      if (acquireCount === 1) throw createListReadStaleError(301);
      return { ok: true, item: { key: "candidate:next" } };
    },
    recover: async () => {
      assert.deepEqual(Array.from(processedLedger), ["candidate:processed"]);
      assert.deepEqual(Array.from(queuedLedger), ["candidate:queued"]);
      assert.equal(results.length, 1);
      assert.equal(postActionCount, 1);
    }
  });
  results.push({ candidate_key: acquisition.result.item.key });
  postActionCount += 1;
  assert.deepEqual(results.map((item) => item.candidate_key), [
    "candidate:processed",
    "candidate:next"
  ]);
  assert.equal(postActionCount, 2);
}

function createListStateForRecoveryTest() {
  return {
    processed_keys: new Set(["candidate:done"]),
    queued_keys: new Set(["candidate:in-flight"]),
    stable_signature_count: 3,
    last_visible_signature: "stale-signature",
    last_result: { ok: false },
    ledger: []
  };
}

async function testTieredListReadRecoverySelection() {
  const lightweightState = createListStateForRecoveryTest();
  let lightweightRootCalls = 0;
  let lightweightContextCalls = 0;
  const lightweight = await recoverRecommendListReadStaleContext({
    staleAttempt: 1,
    listState: lightweightState,
    rootReacquire: async () => {
      lightweightRootCalls += 1;
      return { card_count: 8 };
    },
    contextReapply: async () => {
      lightweightContextCalls += 1;
      return { ok: true };
    }
  });
  assert.equal(lightweight.recovery_mode, "root_reacquire");
  assert.equal(lightweightRootCalls, 1);
  assert.equal(lightweightContextCalls, 0);
  assert.deepEqual(Array.from(lightweightState.processed_keys), ["candidate:done"]);
  assert.equal(lightweightState.queued_keys.size, 0);
  assert.equal(lightweightState.stable_signature_count, 0);
  assert.equal(lightweightState.last_visible_signature, "");

  const escalatedState = createListStateForRecoveryTest();
  let escalatedContextCalls = 0;
  const escalated = await recoverRecommendListReadStaleContext({
    staleAttempt: 1,
    listState: escalatedState,
    rootReacquire: async () => {
      throw createListReadStaleError(401);
    },
    contextReapply: async () => {
      escalatedContextCalls += 1;
      escalatedState.queued_keys.clear();
      return { ok: true };
    }
  });
  assert.equal(escalated.recovery_mode, "context_reapply");
  assert.equal(escalated.escalated_from, "root_reacquire");
  assert.equal(escalatedContextCalls, 1);
  assert.deepEqual(Array.from(escalatedState.processed_keys), ["candidate:done"]);

  const noCardsState = createListStateForRecoveryTest();
  let noCardsContextCalls = 0;
  const noCards = await recoverRecommendListReadStaleContext({
    staleAttempt: 1,
    listState: noCardsState,
    rootReacquire: async () => ({ card_count: 0 }),
    contextReapply: async () => {
      noCardsContextCalls += 1;
      noCardsState.queued_keys.clear();
      return { ok: true };
    }
  });
  assert.equal(noCards.recovery_mode, "context_reapply");
  assert.equal(noCards.root_reacquire_error.code, "RECOMMEND_LIST_ROOT_REACQUIRE_NO_CARDS");
  assert.equal(noCardsContextCalls, 1);

  const repeatedState = createListStateForRecoveryTest();
  let repeatedRootCalls = 0;
  let repeatedContextCalls = 0;
  const repeated = await recoverRecommendListReadStaleContext({
    staleAttempt: 2,
    listState: repeatedState,
    rootReacquire: async () => {
      repeatedRootCalls += 1;
      return { card_count: 8 };
    },
    contextReapply: async () => {
      repeatedContextCalls += 1;
      repeatedState.queued_keys.clear();
      return { ok: true };
    }
  });
  assert.equal(repeated.recovery_mode, "context_reapply");
  assert.equal(repeated.escalated_from, "repeated_stale");
  assert.equal(repeatedRootCalls, 0);
  assert.equal(repeatedContextCalls, 1);
}

async function testDebugBoundaryOptionDelegation() {
  let observedOptions = null;
  const service = createRecommendRunService({
    idPrefix: "test_recommend_debug_boundary",
    workflow: async (options, runControl) => {
      observedOptions = options;
      runControl.updateProgress({ processed: 1, screened: 1 });
      return { processed: 1 };
    }
  });
  const started = service.startRecommendRun({
    client: {},
    criteria: "算法",
    filter: { enabled: false },
    maxCandidates: 1,
    debugTestMode: true,
    debugForceCdpReconnectAfterProcessed: 10
  });
  assert.equal(started.context.debug_test_mode, true);
  assert.equal(started.context.debug_boundary_mode, "cdp_reconnect");
  assert.equal(started.context.debug_boundary_threshold, 10);
  const final = await service.waitForRecommendRun(started.runId);
  assert.equal(final.status, "completed");
  assert.equal(observedOptions.debugTestMode, true);
  assert.equal(observedOptions.debugForceCdpReconnectAfterProcessed, 10);
  assert.equal(observedOptions.debugForceListEndAfterProcessed, null);
}

function testRefreshFailurePreservesCdpDiagnostic() {
  const refreshAttempt = {
    ok: false,
    reason: "page_reload_failed",
    error: "Could not find node with given id",
    error_diagnostic: {
      name: "Error",
      message: "Could not find node with given id",
      cdp_method: "DOM.getBoxModel",
      cdp_at: "2026-07-17T10:00:00.000Z",
      cdp_node_id: 4242,
      cdp_param_keys: ["nodeId"]
    }
  };
  const error = createRecommendRefreshFailureError(refreshAttempt, {
    listEndReason: "debug_forced_list_end",
    targetCount: 200,
    passedCount: 3
  });
  assert.equal(error.code, "RECOMMEND_END_REFRESH_FAILED");
  assert.equal(error.cdp_method, "DOM.getBoxModel");
  assert.equal(error.cdp_node_id, 4242);
  assert.deepEqual(error.cdp_param_keys, ["nodeId"]);
  assert.deepEqual(error.error_diagnostic, refreshAttempt.error_diagnostic);
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
testDebugBoundaryValidationAndOnceOnlyController();
await testListReadStaleRecoveryThenSuccess();
testDomStaleForensicEventIsSafeAndCorrelatable();
await testListReadRepeatedStaleIsBounded();
await testListReadRecoveryDoesNotDuplicateResultsOrActions();
await testTieredListReadRecoverySelection();
await testDebugBoundaryOptionDelegation();
testRefreshFailurePreservesCdpDiagnostic();
await testPostActionOptionDelegation();
await testDetailLimitDefaultsToUnlimitedForPassTarget();
await testNativeFilterStageOrderingAndBypass();
await testRunServiceMissingFilterPanelDefaultPolicy();
testCompactFilterResultPreservesActivityEvidenceAndAttempts();
testRefreshFilterEnvelopePreservesActivitySafetyFlags();
testRecommendStatusCountersPreserveProgressAfterRecovery();

console.log("recommend run service tests passed");
