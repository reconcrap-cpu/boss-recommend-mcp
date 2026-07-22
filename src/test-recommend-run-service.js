import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_COMPLETED,
  RUN_STATUS_FAILED,
  RUN_STATUS_PAUSED
} from "./core/run/index.js";
import {
  compactInfiniteListState,
  createInfiniteListState,
  markInfiniteListCandidateProcessed
} from "./core/infinite-list/index.js";
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
  bindRecommendColleagueContactInspectionResult,
  compactRecommendDomRootIdentity,
  createRecommendDomStaleForensicEvent,
  createRecommendDebugBoundaryController,
  createRecommendGreetingActionJournal,
  getRecommendDetailFailureDisposition,
  isCandidateLocalRecommendPostClickBindingTimeout,
  createRecommendRefreshFailureError,
  checkpointRecommendPostActionStopResult,
  assertRecommendScreeningCandidateMatchesCard,
  assertRecommendControlMatchesCandidateDetailRoot,
  isVerifiedRecommendPostActionCandidateBinding,
  isVerifiedRecommendRefreshCompletion,
  isRecoverableRecommendDetailError,
  normalizeRecommendDebugBoundaryOptions,
  preserveRecommendDetailCandidateBindingForRecovery,
  reserveRecommendDetailRecovery,
  resolveEffectiveRecommendDetailLimit,
  recoverRecommendListReadStaleContext,
  runRecommendPostAction,
  selectAndVerifyInitialRecommendJob
} from "./domains/recommend/run-service.js";

function testCanvasCausalBindingEvidenceIsReusedBeforeEveryDetailRead() {
  const source = fs.readFileSync(
    new URL("./domains/recommend/run-service.js", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function requireCurrentDetailCandidateBinding");
  const end = source.indexOf("async function containCandidateLocalDetailBindingFailure", start);
  assert.ok(start > 0 && end > start);
  const reverify = source.slice(start, end);
  assert.match(
    reverify,
    /card_click_evidence:\s*currentDetailCandidateBinding\?\.card\?\.click_evidence\s*\|\|\s*null/
  );
  assert.match(
    reverify,
    /click_attempts:\s*currentDetailCandidateBinding\?\.card\?\.click_attempts\s*\|\|\s*\[\]/
  );
  assert.match(
    reverify,
    /cardClickEvidence:\s*bindingContext\?\.card_click_evidence\s*\|\|\s*null/
  );
  assert.match(
    reverify,
    /clickAttempts:\s*Array\.isArray\(bindingContext\?\.click_attempts\)/
  );
  assert.ok(
    reverify.indexOf("const freshDetailState = await waitForRecommendDetail")
      < reverify.indexOf("const binding = await verifyRecommendDetailCandidateBinding"),
    "every later detail read must reacquire fresh detail state before binding verification"
  );
  assert.match(
    reverify,
    /screeningOnlyBindingEnabled\s*&&\s*binding\.screening_verified\s*===\s*true/
  );

  assert.match(
    source,
    /const screeningOnlyBindingEnabled = Boolean\([\s\S]*normalizedPostAction === "none"[\s\S]*executePostAction === false[\s\S]*\)/
  );
  assert.match(
    source,
    /acceptScreeningBinding:\s*screeningOnlyBindingEnabled/
  );

  const captureStart = source.indexOf('detailStep = "capture_image"');
  const captureBindingIndex = source.indexOf(
    'await requireCurrentDetailCandidateBinding("before_cv_image_capture")',
    captureStart
  );
  const captureReacquireIndex = source.indexOf(
    "await reacquireCaptureTargetAfterBinding()",
    captureBindingIndex
  );
  const captureInputIndex = source.indexOf(
    "() => captureImageForTarget(captureTarget, captureTargetWait)",
    captureReacquireIndex
  );
  assert.ok(captureStart > 0);
  assert.ok(captureBindingIndex > captureStart);
  assert.ok(captureReacquireIndex > captureBindingIndex);
  assert.ok(captureInputIndex > captureReacquireIndex);

  const resumedStart = source.indexOf('detailStep = "resume_image_capture"');
  const resumedBindingIndex = source.indexOf(
    'await requireCurrentDetailCandidateBinding("before_resumed_cv_image_capture")',
    resumedStart
  );
  const resumedReacquireIndex = source.indexOf(
    "await reacquireCaptureTargetAfterBinding()",
    resumedBindingIndex
  );
  const resumedCaptureIndex = source.indexOf(
    "() => captureImageForTarget(captureTarget, captureTargetWait, resumeCheckpoint)",
    resumedReacquireIndex
  );
  assert.ok(resumedStart > 0);
  assert.ok(resumedBindingIndex > resumedStart);
  assert.ok(resumedReacquireIndex > resumedBindingIndex);
  assert.ok(resumedCaptureIndex > resumedReacquireIndex);
}

function testPostActionBindingIsGatedByPassedScreening() {
  const source = fs.readFileSync(
    new URL("./domains/recommend/run-service.js", import.meta.url),
    "utf8"
  );
  const postActionGuardStart = source.indexOf("if (\n      postActionEnabled");
  const postActionBinding = source.indexOf(
    'await requireCurrentDetailCandidateBinding("before_post_action_discovery")',
    postActionGuardStart
  );
  assert.ok(postActionGuardStart > 0 && postActionBinding > postActionGuardStart);
  const postActionGuard = source.slice(postActionGuardStart, postActionBinding);
  assert.match(postActionGuard, /screening\?\.passed === true/);
  assert.match(postActionGuard, /detailResult/);
  assert.match(postActionGuard, /!colleagueContactSkipReason/);
}

function testRecommendScreeningCandidateIdentityInvariantFailsClosed() {
  const cardCandidate = {
    id: "33e97f1cf19aef040XB73t-_FlJQ",
    identity: { name: "朱余哲" }
  };
  const verified = assertRecommendScreeningCandidateMatchesCard({
    cardCandidate,
    screeningCandidate: {
      id: "33e97f1cf19aef040XB73t-_FlJQ",
      identity: { name: "朱余哲" }
    },
    stage: "test"
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.exact_candidate_id, true);
  assert.equal(verified.exact_name, true);

  assert.throws(
    () => assertRecommendScreeningCandidateMatchesCard({
      cardCandidate,
      screeningCandidate: {
        id: "33e97f1cf19aef040XB73t-_FlJQ",
        identity: { name: "杨雯语" }
      },
      stage: "immediately_before_llm_screening"
    }),
    (error) => {
      assert.equal(error.code, "RECOMMEND_SCREENING_CANDIDATE_IDENTITY_MISMATCH");
      assert.equal(error.phase, "recommend:screening-candidate-identity");
      assert.equal(error.screening_candidate_identity.exact_candidate_id, true);
      assert.equal(error.screening_candidate_identity.exact_name, false);
      return true;
    }
  );
}

function testRecommendPreLlmInvariantRunsBeforeModelCall() {
  const source = fs.readFileSync(
    new URL("./domains/recommend/run-service.js", import.meta.url),
    "utf8"
  );
  const bindingIndex = source.indexOf(
    'await requireCurrentDetailCandidateBinding("immediately_before_llm_screening")'
  );
  const invariantIndex = source.indexOf(
    "assertRecommendScreeningCandidateMatchesCard({",
    bindingIndex
  );
  const llmCallIndex = source.indexOf("callScreeningLlm({", bindingIndex);
  assert.ok(bindingIndex > 0);
  assert.ok(invariantIndex > bindingIndex);
  assert.ok(llmCallIndex > invariantIndex);
  const guardedBlock = source.slice(bindingIndex, llmCallIndex);
  assert.match(guardedBlock, /stage:\s*"immediately_before_llm_screening"/);
}

function createVerifiedRecommendCandidateBinding(candidateId = "candidate-1") {
  return {
    schema_version: 1,
    verified: true,
    stable: true,
    method: "exact_candidate_id_and_name",
    expected_candidate_id: candidateId,
    expected_name: "候选人",
    allow_scroll: false,
    settle_ms: 0,
    card: {
      stable: true,
      candidate_id: candidateId,
      name: "候选人"
    },
    detail: {
      root: {
        source: "popup",
        node_id: 10,
        backend_node_id: 1010,
        contained_iframe: null,
        canonical: true,
        action_root: true,
        visible: true,
        stable: true
      },
      candidate_id_evidence_present: true,
      candidate_id_probe_complete: true,
      exact_candidate_id: true,
      exact_name: true,
      exact_secondary: false,
      first: {
        scopes: [{
          source: "popup",
          node_id: 10,
          backend_node_id: 1010,
          visible: true
        }]
      },
      second: {
        scopes: [{
          source: "popup",
          node_id: 10,
          backend_node_id: 1010,
          visible: true
        }]
      }
    }
  };
}

function createVerifiedRecommendCanvasCausalBinding(candidateId = "candidate-canvas") {
  const name = "画布候选人";
  const clickPoint = {
    x: 120,
    y: 30,
    mode: "card-body-safe-point",
    attempt_index: 0,
    hit_test_candidate_index: 0
  };
  const cardBefore = {
    verified: true,
    reason: null,
    node_id: 10,
    backend_node_id: 110,
    candidate_id: candidateId,
    name,
    visible: true
  };
  const iframeSelector = 'iframe[name*="resume"]';
  const ancestryPath = [
    { node_id: 30, backend_node_id: 1030 },
    { node_id: 10, backend_node_id: 1010 }
  ];
  const containedIframe = {
    selector: iframeSelector,
    node_id: 31,
    backend_node_id: 1031,
    iframe_node_id: 30,
    iframe_backend_node_id: 1030,
    container_node_id: 10,
    container_backend_node_id: 1010,
    ancestry_depth: 1,
    ancestry_path: ancestryPath,
    visible: true,
    stable: true,
    contained: true
  };
  const popupScope = {
    source: "popup",
    node_id: 10,
    backend_node_id: 1010,
    visible: true
  };
  const iframeScope = {
    source: "resume_iframe",
    selector: iframeSelector,
    node_id: 31,
    backend_node_id: 1031,
    iframe_node_id: 30,
    iframe_backend_node_id: 1030,
    container_node_id: 10,
    container_backend_node_id: 1010,
    container_verified: true,
    visible: true,
    ancestry: {
      verified: true,
      depth: 1,
      path: ancestryPath
    }
  };
  const clickEvidence = {
    verified: true,
    in_viewport: true,
    reason: null,
    node_id: 10,
    click_target: clickPoint,
    hit_test: {
      completed: true,
      exact_card_hit_verified: true,
      reason: null,
      selected: clickPoint,
      selected_attempt: {
        point: clickPoint,
        inside_viewport: true,
        exact_card_hit: true,
        safe_card_hit: true,
        safe_card_body_hit: true,
        hit_node_id: 10,
        hit_node_name: "DIV",
        hit_backend_node_id: 110,
        reason: null
      }
    }
  };
  return {
    schema_version: 1,
    verified: true,
    stable: true,
    method: "exact_card_click_and_new_resume_root",
    expected_candidate_id: candidateId,
    expected_name: name,
    card: {
      stable: true,
      disappeared_after_click: true,
      before: cardBefore,
      after: {
        verified: false,
        definitively_disappeared: true,
        disappearance_kind: "detached"
      },
      candidate_id: candidateId,
      name,
      pre_click_provenance: {
        verified: true,
        reason: null,
        containment_method: "parent_ancestry",
        card: cardBefore,
        list_root: {
          node_id: 1,
          backend_node_id: 101,
          iframe_node_id: 2,
          iframe_backend_node_id: 102,
          linked_document_node_id: 1
        },
        ancestry: {
          verified: true,
          reason: null,
          descendant_node_id: 10,
          ancestor_node_id: 1,
          ancestor_backend_node_id: 101
        }
      },
      click_evidence: clickEvidence,
      click_attempts: [{
        attempt: 1,
        click_target: clickPoint,
        input_dispatched: true,
        outcome: "detail",
        elapsed_ms: 25
      }],
      causal_proof: {
        verified: true,
        reason: null,
        resume_iframe_selector: iframeSelector
      }
    },
    detail: {
      root: {
        source: "popup",
        node_id: 10,
        backend_node_id: 1010,
        contained_iframe: containedIframe,
        canonical: true,
        action_root: true,
        visible: true,
        stable: true
      },
      newly_mounted: true,
      root_matches_expected: true,
      roots_before_click: [],
      roots_before_capture: {
        schema_version: 1,
        captured: true,
        complete: true,
        roots: [],
        ignored_scopes: []
      },
      candidate_id_evidence_present: false,
      candidate_id_probe_complete: true,
      exact_candidate_id: false,
      exact_name: false,
      exact_secondary: false,
      first: { scopes: [popupScope, iframeScope] },
      second: { scopes: [popupScope, iframeScope] }
    }
  };
}

const VERIFIED_RECOMMEND_ACTION_SCOPE = `boss-recommend-profile-v2:127.0.0.1:profile-sha256:${"a".repeat(64)}`;

function createExactRecommendActionDom({ label = "打招呼" } = {}) {
  let actionNodeId = 0;
  let actionBackendNodeId = 0;
  return {
    async getDocument() {
      return { root: { nodeId: 1, backendNodeId: 1 } };
    },
    async pushNodesByBackendIdsToFrontend({ backendNodeIds }) {
      actionBackendNodeId = Number(backendNodeIds[0]) || 0;
      actionNodeId = actionBackendNodeId - 1000;
      return {
        nodeIds: backendNodeIds.map((backendNodeId) => Number(backendNodeId) - 1000)
      };
    },
    async describeNode({ nodeId }) {
      return {
        node: {
          nodeId,
          backendNodeId: nodeId + 1000,
          parentId: nodeId === 10 ? 0 : 10
        }
      };
    },
    async querySelectorAll() {
      return { nodeIds: [] };
    },
    async getAttributes() {
      return { attributes: ["class", "btn-greet"] };
    },
    async getOuterHTML() {
      return { outerHTML: `<button class="btn-greet">${label}</button>` };
    },
    async scrollIntoViewIfNeeded() {},
    async getBoxModel() {
      return {
        model: {
          border: [10, 10, 110, 10, 110, 50, 10, 50]
        }
      };
    },
    async getNodeForLocation() {
      return {
        nodeId: actionNodeId,
        backendNodeId: actionBackendNodeId,
        frameId: "recommend-frame"
      };
    }
  };
}

function createExactRecommendActionPage({ width = 1280, height = 720 } = {}) {
  return {
    async getLayoutMetrics() {
      return {
        cssVisualViewport: {
          clientWidth: width,
          clientHeight: height,
          pageX: 0,
          pageY: 0,
          scale: 1
        }
      };
    }
  };
}

function createPostClickRecommendActionClient({
  initialLabel = "打招呼",
  confirmedLabel = "继续沟通",
  clickError = null,
  rootScopedControlAliasNodeId = 0,
  postClickInitialGreetReads = 0
} = {}) {
  let clicked = false;
  let inputCalls = 0;
  let postClickGreetReads = 0;
  const actionNodeId = 501;
  const detailRootNodeId = 10;
  return {
    get clicked() { return clicked; },
    get inputCalls() { return inputCalls; },
    get postClickGreetReads() { return postClickGreetReads; },
    client: {
      Page: createExactRecommendActionPage(),
      DOM: {
        async getDocument() {
          return { root: { nodeId: 1, backendNodeId: 1001 } };
        },
        async pushNodesByBackendIdsToFrontend({ backendNodeIds }) {
          return {
            nodeIds: backendNodeIds.map((backendNodeId) => (
              Number(backendNodeId) === 1501
                ? actionNodeId
                : Number(backendNodeId) === 1010
                ? detailRootNodeId
                : 0
            ))
          };
        },
        async querySelector({ nodeId, selector }) {
          if (nodeId === 1 && (
            selector === 'iframe[name="recommendFrame"]'
            || selector === 'iframe[src*="/web/frame/recommend/"]'
            || selector === "iframe"
          )) return { nodeId: 2 };
          if ((nodeId === 1 || nodeId === 3) && selector === ".dialog-wrap.active") {
            return { nodeId: detailRootNodeId };
          }
          return { nodeId: 0 };
        },
        async querySelectorAll({ nodeId, selector }) {
          if ((nodeId === 1 || nodeId === 3) && selector === ".dialog-wrap.active") {
            return { nodeIds: [detailRootNodeId] };
          }
          if (nodeId !== detailRootNodeId) return { nodeIds: [] };
          if (selector === "*" && rootScopedControlAliasNodeId > 0) {
            return { nodeIds: [rootScopedControlAliasNodeId] };
          }
          if (/button|\.btn|role="button"|^a$|^span$|^div$/u.test(selector)) {
            return { nodeIds: [actionNodeId] };
          }
          return { nodeIds: [] };
        },
        async describeNode({ nodeId }) {
          if (nodeId === 2) {
            return {
              node: {
                nodeId,
                backendNodeId: 1002,
                parentId: 1,
                contentDocument: { nodeId: 3 }
              }
            };
          }
          const backendNodeId = nodeId === detailRootNodeId
            ? 1010
            : nodeId === actionNodeId || nodeId === rootScopedControlAliasNodeId
            ? 1501
            : nodeId + 1000;
          return {
            node: {
              nodeId,
              backendNodeId,
              parentId: nodeId === actionNodeId
                ? rootScopedControlAliasNodeId > 0 ? 0 : detailRootNodeId
                : nodeId === detailRootNodeId
                  ? 3
                  : 0
            }
          };
        },
        async getAttributes({ nodeId }) {
          return { attributes: nodeId === actionNodeId ? ["class", "btn-greet"] : [] };
        },
        async getOuterHTML({ nodeId }) {
          if (nodeId === actionNodeId) {
            let label = initialLabel;
            if (clicked) {
              label = postClickGreetReads < postClickInitialGreetReads
                ? initialLabel
                : confirmedLabel;
              postClickGreetReads += 1;
            }
            return { outerHTML: `<button class="btn-greet">${label}</button>` };
          }
          return { outerHTML: '<div class="dialog-wrap active"></div>' };
        },
        async scrollIntoViewIfNeeded() {},
        async getBoxModel({ nodeId }) {
          if (![detailRootNodeId, actionNodeId].includes(nodeId)) {
            throw new Error(`Unexpected box node ${nodeId}`);
          }
          return { model: { border: [10, 10, 110, 10, 110, 50, 10, 50] } };
        },
        async getNodeForLocation() {
          return {
            nodeId: actionNodeId,
            backendNodeId: 1501,
            frameId: "recommend-frame"
          };
        }
      },
      Input: {
        async dispatchMouseEvent(event) {
          inputCalls += 1;
          if (clickError && event.type === "mousePressed") throw clickError;
          if (event.type === "mouseReleased") clicked = true;
        }
      }
    }
  };
}

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
          verifySticky: true
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

async function testPostActionTerminalStopFailsLifecycleButPreservesSummary() {
  const unknownSummary = {
    list_end_reason: "greet_outcome_unknown",
    results: [{
      candidate_id: "candidate-terminal-unknown",
      post_action: {
        stop_run: true,
        outcome_unknown: true,
        reason: "greet_outcome_unknown"
      }
    }]
  };
  const failedService = createRecommendRunService({
    idPrefix: "test_recommend_terminal_unknown",
    workflow: async () => unknownSummary
  });
  const failedStart = failedService.startRecommendRun({ client: {} });
  const failed = await failedService.waitForRecommendRun(failedStart.runId);
  assert.equal(failed.status, RUN_STATUS_FAILED);
  assert.equal(failed.error.code, "RECOMMEND_GREET_OUTCOME_UNKNOWN");
  assert.equal(failed.error.phase, "recommend:post-action-terminal");
  assert.deepEqual(failed.summary, unknownSummary);

  const quotaSummary = {
    list_end_reason: "greet_credits_exhausted",
    results: [{
      candidate_id: "candidate-quota",
      post_action: {
        stop_run: true,
        out_of_greet_credits: true,
        reason: "greet_credits_exhausted"
      }
    }]
  };
  const completedService = createRecommendRunService({
    idPrefix: "test_recommend_terminal_quota",
    workflow: async () => quotaSummary
  });
  const completedStart = completedService.startRecommendRun({ client: {} });
  const completed = await completedService.waitForRecommendRun(completedStart.runId);
  assert.equal(completed.status, RUN_STATUS_COMPLETED);
  assert.deepEqual(completed.summary, quotaSummary);
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
  const firstStaleState = createListStateForRecoveryTest();
  let rootOnlyCalls = 0;
  let contextCalls = 0;
  const firstStale = await recoverRecommendListReadStaleContext({
    staleAttempt: 1,
    listState: firstStaleState,
    rootReacquire: async () => {
      rootOnlyCalls += 1;
      return {
        card_count: 8,
        filters_reset: true,
        cards_are_unfiltered: true
      };
    },
    contextReapply: async () => {
      contextCalls += 1;
      firstStaleState.queued_keys.clear();
      firstStaleState.stable_signature_count = 0;
      firstStaleState.last_visible_signature = "";
      return {
        ok: true,
        exact_job_verified: true,
        exact_page_scope_verified: true,
        current_city_only_verified: true,
        exact_filters_verified: true,
        card_count: 2
      };
    }
  });
  assert.equal(firstStale.recovery_mode, "context_reapply");
  assert.equal(firstStale.escalated_from, "root_only_recovery_disallowed");
  assert.equal(rootOnlyCalls, 0, "unfiltered cards from a root-only reacquire must never be read");
  assert.equal(contextCalls, 1);
  assert.equal(firstStale.context_reapply.exact_filters_verified, true);
  assert.deepEqual(Array.from(firstStaleState.processed_keys), ["candidate:done"]);
  assert.equal(firstStaleState.queued_keys.size, 0);
  assert.equal(firstStaleState.stable_signature_count, 0);
  assert.equal(firstStaleState.last_visible_signature, "");

  const repeatedState = createListStateForRecoveryTest();
  let repeatedContextCalls = 0;
  const repeated = await recoverRecommendListReadStaleContext({
    staleAttempt: 2,
    listState: repeatedState,
    contextReapply: async () => {
      repeatedContextCalls += 1;
      return { ok: true };
    }
  });
  assert.equal(repeated.recovery_mode, "context_reapply");
  assert.equal(repeated.escalated_from, "repeated_stale");
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
    verifySticky: true
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

function testRecommendStatusCountersRequireSuccessfulRecoveryEvidence() {
  const counts = countRecommendResultStatuses([
    {
      screening: { passed: true },
      detail: {
        llm_screening: { status: "pass" },
        image_evidence: { ok: true },
        cv_acquisition: {
          close_recovery: { ok: true, method: "refresh" }
        }
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
      error: { code: "IMAGE_CAPTURE_TIMEOUT" },
      timings: {
        image_capture_resume: { attempted: true, ok: false }
      }
    },
    {
      screening: { passed: false },
      detail: {
        image_evidence: { ok: true }
      },
      timings: {
        image_capture_resume: { attempted: true, ok: true }
      }
    }
  ], {
    greetCount: 1
  });

  assert.equal(counts.processed, 5);
  assert.equal(counts.screened, 5);
  assert.equal(counts.detail_opened, 3);
  assert.equal(counts.passed, 1);
  assert.equal(counts.llm_screened, 1);
  assert.equal(counts.greet_count, 1);
  assert.equal(counts.post_action_clicked, 1);
  assert.equal(counts.detail_open_failed, 2);
  assert.equal(counts.image_capture_failed, 1);
  assert.equal(counts.transient_recovered, 2);

  const terminalMismatchCounts = countRecommendResultStatuses(
    Array.from({ length: 5 }, (_, index) => ({
      candidate: { id: `terminal-mismatch-${index}` },
      screening: { passed: false },
      detail: null,
      error: { code: "RECOMMEND_DETAIL_CANDIDATE_MISMATCH" },
      timings: {
        detail_recovered_error: { code: "RECOMMEND_DETAIL_CANDIDATE_MISMATCH" }
      }
    }))
  );
  assert.equal(terminalMismatchCounts.detail_open_failed, 5);
  assert.equal(terminalMismatchCounts.transient_recovered, 0);
}

async function testInitialJobSelectionRequiresIndependentStickyVerification() {
  const rootState = { iframe: { documentNodeId: 321 } };
  let selectorCalls = 0;
  await assert.rejects(
    () => selectAndVerifyInitialRecommendJob({}, rootState, {
      jobLabel: "科研算法实习生（3D重建与生成）-可转正 _ 杭州",
      settleMs: 0,
      dropdownTimeoutMs: 1,
      totalTimeoutMs: 1,
      retryDelayMs: 0,
      async selectWithRootRefresh(client, observedRootState, options) {
        selectorCalls += 1;
        assert.deepEqual(observedRootState, rootState);
        assert.equal(options.jobLabel, "科研算法实习生（3D重建与生成）-可转正 _ 杭州");
        return {
          root_state: { iframe: { documentNodeId: 654 } },
          job_selection: {
            selected: true,
            selected_option: { label: options.jobLabel },
            sticky_verification: {
              verified: false,
              current_label: "错误岗位 _ 杭州",
              menu_close: { ok: true }
            }
          }
        };
      }
    }),
    (error) => {
      assert.equal(error.code, "RECOMMEND_INITIAL_JOB_STICKY_VERIFICATION_FAILED");
      assert.match(error.message, /错误岗位/);
      assert.equal(error.job_selection.selected, true);
      assert.equal(error.job_selection.sticky_verification.verified, false);
      return true;
    }
  );
  assert.equal(selectorCalls, 1);
}

function testColleagueContactFilterForcesDetailInspectionPastConfiguredLimit() {
  assert.equal(resolveEffectiveRecommendDetailLimit({
    detailLimit: 2,
    postActionEnabled: false,
    requireColleagueContactInspection: true
  }), Number.POSITIVE_INFINITY);
  assert.equal(resolveEffectiveRecommendDetailLimit({
    detailLimit: 2,
    postActionEnabled: true,
    requireColleagueContactInspection: false
  }), Number.POSITIVE_INFINITY);
  assert.equal(resolveEffectiveRecommendDetailLimit({
    detailLimit: 2,
    postActionEnabled: false,
    requireColleagueContactInspection: false
  }), 2);
}

function testRecommendRefreshCompletionRequiresExactBoundEmptyState() {
  const exact = {
    ok: true,
    exhausted: true,
    card_count: 0,
    empty_state: { verified: true }
  };
  assert.equal(isVerifiedRecommendRefreshCompletion(exact), true);
  assert.equal(isVerifiedRecommendRefreshCompletion({
    ...exact,
    empty_state: { verified: false }
  }), false);
  assert.equal(isVerifiedRecommendRefreshCompletion({
    ...exact,
    card_count: 1
  }), false);
  assert.equal(isVerifiedRecommendRefreshCompletion({
    ...exact,
    ok: false
  }), false);
}

function testRecoverableDetailBindingSurvivesNullResultAndReservesOneRecovery() {
  const binding = createVerifiedRecommendCandidateBinding("candidate-recoverable-binding");
  assert.equal(
    preserveRecommendDetailCandidateBindingForRecovery(null, binding),
    binding
  );
  const partialDetail = {};
  assert.equal(
    preserveRecommendDetailCandidateBindingForRecovery(partialDetail, binding),
    binding
  );
  assert.equal(partialDetail.candidate_binding, binding);

  const recoveryCounts = new Map();
  assert.deepEqual(
    reserveRecommendDetailRecovery(recoveryCounts, "candidate-recoverable-binding", 1),
    { allowed: true, current_count: 0, next_count: 1, limit: 1 }
  );
  assert.deepEqual(
    reserveRecommendDetailRecovery(recoveryCounts, "candidate-recoverable-binding", 1),
    { allowed: false, current_count: 1, next_count: 1, limit: 1 }
  );

  const bindingError = new Error("detail binding readiness exhausted");
  bindingError.code = "RECOMMEND_DETAIL_CANDIDATE_MISMATCH";
  assert.deepEqual(getRecommendDetailFailureDisposition(bindingError), {
    recoverable: true,
    candidate_local: true,
    context_recovery: false,
    allow_post_action: false,
    reason: "candidate_binding_failed_closed"
  });
  const staleError = new Error("Could not find node with given id");
  assert.equal(getRecommendDetailFailureDisposition(staleError).context_recovery, true);
}

function testPreClickStaleNoActionDispositionRequiresExactRetryExhaustion() {
  const fullyDecorated = Object.assign(
    new Error("Could not find node with given id"),
    {
      recommend_pre_click_stale_no_action: true,
      recommend_no_click_dispatched: true,
      recommend_click_dispatched: false,
      recommend_input_dispatched: false,
      recommend_pre_click_stage: "pre_click_card_box",
      recommend_pre_click_retry_exhausted: true,
      recommend_pre_click_reacquire_failed: false,
      recommend_pre_click_retry: {
        attempt_count: 3,
        all_pre_click_stale_no_action: true,
        no_click_dispatched: true,
        retry_exhausted: true,
        reacquire_failed: false,
        expected_attempt_count: 3,
        candidate_local_exhaustion: true
      }
    }
  );
  assert.deepEqual(getRecommendDetailFailureDisposition(fullyDecorated), {
    recoverable: true,
    candidate_local: true,
    context_recovery: false,
    allow_post_action: false,
    reason: "pre_click_stale_no_action_failed_closed"
  });

  const postInputUnknown = Object.assign(new Error(fullyDecorated.message), {
    ...fullyDecorated,
    recommend_no_click_dispatched: false,
    recommend_click_dispatched: true,
    recommend_input_dispatched: true,
    recommend_post_input_outcome_unknown: true,
    recommend_post_input_stage: "post_card_click_detail_poll"
  });
  assert.equal(isRecoverableRecommendDetailError(postInputUnknown), false);
  assert.deepEqual(getRecommendDetailFailureDisposition(postInputUnknown), {
    recoverable: false,
    candidate_local: false,
    context_recovery: false,
    allow_post_action: false,
    reason: "post_input_detail_outcome_unknown_terminal"
  });

  const cleanPostClickBindingTimeout = Object.assign(
    new Error("RECOMMEND_DETAIL_CANDIDATE_MISMATCH: detail_binding_readiness_timeout"),
    {
      code: "RECOMMEND_DETAIL_CANDIDATE_MISMATCH",
      recommend_clean_pre_action_detail_binding_timeout: true,
      recommend_no_click_dispatched: false,
      recommend_click_dispatched: true,
      recommend_input_dispatched: true,
      recommend_post_input_outcome_unknown: false,
      recommend_post_input_stage: "post_card_click_binding",
      click_attempts: [{ attempt: 1, input_dispatched: true, outcome: "detail" }],
      detail_candidate_binding: {
        verified: false,
        reason: "detail_binding_readiness_timeout",
        readiness: {
          exhausted: true,
          terminal: false,
          last_error: null
        }
      }
    }
  );
  assert.equal(isCandidateLocalRecommendPostClickBindingTimeout(cleanPostClickBindingTimeout), true);
  assert.equal(isRecoverableRecommendDetailError(cleanPostClickBindingTimeout), true);
  assert.deepEqual(getRecommendDetailFailureDisposition(cleanPostClickBindingTimeout), {
    recoverable: true,
    candidate_local: true,
    context_recovery: false,
    allow_post_action: false,
    reason: "detail_binding_readiness_timeout_failed_closed"
  });
  for (const mutation of [
    { recommend_clean_pre_action_detail_binding_timeout: false },
    { recommend_post_input_outcome_unknown: true },
    { recommend_post_input_stage: "post_card_click_detail_poll" },
    { detail_candidate_binding: {
      ...cleanPostClickBindingTimeout.detail_candidate_binding,
      reason: "detail_candidate_id_mismatch"
    } },
    { detail_candidate_binding: {
      ...cleanPostClickBindingTimeout.detail_candidate_binding,
      readiness: {
        ...cleanPostClickBindingTimeout.detail_candidate_binding.readiness,
        terminal: true
      }
    } },
    { click_attempts: [
      ...cleanPostClickBindingTimeout.click_attempts,
      { attempt: 2, input_dispatched: true, outcome: "detail" }
    ] }
  ]) {
    const unsafe = Object.assign(
      new Error(cleanPostClickBindingTimeout.message),
      cleanPostClickBindingTimeout,
      mutation
    );
    assert.equal(isCandidateLocalRecommendPostClickBindingTimeout(unsafe), false);
    assert.equal(isRecoverableRecommendDetailError(unsafe), false);
    assert.equal(
      getRecommendDetailFailureDisposition(unsafe).reason,
      "post_input_detail_outcome_unknown_terminal"
    );
  }

  const genericStale = new Error("Could not find node with given id");
  assert.deepEqual(getRecommendDetailFailureDisposition(genericStale), {
    recoverable: true,
    candidate_local: false,
    context_recovery: true,
    allow_post_action: false,
    reason: "detail_context_recovery_required"
  });

  const mixedRetry = Object.assign(new Error(fullyDecorated.message), {
    ...fullyDecorated,
    recommend_pre_click_retry: {
      ...fullyDecorated.recommend_pre_click_retry,
      all_pre_click_stale_no_action: false,
      candidate_local_exhaustion: false
    }
  });
  assert.equal(getRecommendDetailFailureDisposition(mixedRetry).candidate_local, false);
  assert.equal(getRecommendDetailFailureDisposition(mixedRetry).context_recovery, true);

  const reacquireFailed = Object.assign(new Error(fullyDecorated.message), {
    ...fullyDecorated,
    recommend_pre_click_reacquire_failed: true,
    recommend_pre_click_retry: {
      ...fullyDecorated.recommend_pre_click_retry,
      reacquire_failed: true,
      candidate_local_exhaustion: false
    }
  });
  assert.equal(getRecommendDetailFailureDisposition(reacquireFailed).candidate_local, false);
  assert.equal(getRecommendDetailFailureDisposition(reacquireFailed).context_recovery, true);
}

function testCandidateLocalCriticalCheckpointIncludesProcessedListState() {
  const candidateKey = "candidate:binding-timeout";
  const state = createInfiniteListState({ domain: "recommend" });
  state.seen_keys.add(candidateKey);
  state.queued_keys.add(candidateKey);
  markInfiniteListCandidateProcessed(state, candidateKey, {
    metadata: { result_index: 0, candidate_id: "candidate-binding-timeout" }
  });
  const compact = compactInfiniteListState(state);
  assert.equal(compact.processed_count, 1);
  assert.equal(compact.queued_count, 0);
  assert.equal(state.processed_keys.has(candidateKey), true);
  assert.equal(state.queued_keys.has(candidateKey), false);

  const source = fs.readFileSync(new URL("./domains/recommend/run-service.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /if \(isRecommendDetailCandidateBindingError\(error\)\) throw error/,
    "downstream binding mismatches must never bypass candidate-local containment"
  );
  const containmentCalls = source.match(/await containCandidateLocalDetailBindingFailure\(error, \{/g) || [];
  assert.equal(containmentCalls.length >= 3, true);
  assert.match(source, /phase: "recommend:llm-binding"/);
  assert.match(source, /phase: "recommend:post-action-binding"/);
  assert.match(source, /screening = createRecoverableDetailFailureScreening\(screeningCandidate, error\)/);
  assert.match(source, /actionDiscovery = null;\s*postActionResult = null/);
  const checkpointStart = source.indexOf("const completedCandidateCheckpoint = {");
  const checkpointEnd = source.indexOf("if (closeRecoveryFailure)", checkpointStart);
  assert.ok(checkpointStart > 0 && checkpointEnd > checkpointStart);
  const checkpointPath = source.slice(checkpointStart, checkpointEnd);
  assert.match(checkpointPath, /candidate_list:\s*compactInfiniteListState\(listState\)/);
  assert.match(checkpointPath, /candidate_local_detail_failure:\s*candidateLocalDetailFailurePending/);
  assert.match(checkpointPath, /if \(candidateLocalDetailFailurePending\) \{\s*runControl\.checkpointCritical/);
  assert.match(checkpointPath, /runControl\.checkpointCritical\(completedCandidateCheckpoint\)/);
  const markProcessedIndex = source.lastIndexOf(
    "markInfiniteListCandidateProcessed(listState, candidateKey",
    checkpointStart
  );
  const criticalCheckpointIndex = source.indexOf(
    "runControl.checkpointCritical(completedCandidateCheckpoint)",
    checkpointStart
  );
  assert.ok(markProcessedIndex > 0);
  assert.ok(
    markProcessedIndex < criticalCheckpointIndex,
    "the candidate must be removed from queued state before the required terminal checkpoint"
  );
  const screeningPhaseIndex = source.indexOf('runControl.setPhase("recommend:screening")');
  const preScreeningGuardStart = source.lastIndexOf(
    "if (!candidateLocalDetailFailurePending)",
    screeningPhaseIndex
  );
  assert.ok(preScreeningGuardStart > 0);
  const preScreeningGuard = source.slice(preScreeningGuardStart, screeningPhaseIndex);
  assert.match(preScreeningGuard, /await runControl\.waitIfPaused\(\)/);
  assert.match(preScreeningGuard, /runControl\.throwIfCanceled\(\)/);
  const terminalThrowIndex = checkpointPath.indexOf("throw candidateLocalDetailTerminalError");
  const postCriticalPauseIndex = checkpointPath.indexOf(
    "if (candidateLocalDetailFailurePending)",
    terminalThrowIndex + 1
  );
  assert.ok(terminalThrowIndex > 0);
  assert.ok(postCriticalPauseIndex > terminalThrowIndex);
  assert.match(
    checkpointPath.slice(postCriticalPauseIndex),
    /await runControl\.waitIfPaused\(\);\s*runControl\.throwIfCanceled\(\)/
  );
}

async function testColleagueResultBindingDriftPreventsDerivedSkip() {
  const bindingError = new Error("candidate detail drifted after colleague scroll");
  bindingError.code = "RECOMMEND_DETAIL_CANDIDATE_MISMATCH";
  let verificationCalls = 0;
  await assert.rejects(
    () => bindRecommendColleagueContactInspectionResult({
      checked: true,
      recent: true,
      reason: "recent_colleague_contact_found"
    }, {
      async reverifyCandidateBinding(stage) {
        verificationCalls += 1;
        assert.equal(stage, "after_colleague_contact_before_result");
        throw bindingError;
      }
    }),
    (error) => error === bindingError
  );
  assert.equal(verificationCalls, 1);
}

async function testVerifiedPanelAbsenceContinuesAfterFreshCandidateBinding() {
  let verificationCalls = 0;
  const result = await bindRecommendColleagueContactInspectionResult({
    checked: true,
    panel_found: false,
    recent: false,
    indeterminate: false,
    reason: "panel_missing",
    rows: [],
    absence_probe: {
      verified: true,
      selector: ".colleague-collaboration",
      scope_count: 1,
      stable_scope_count: 1,
      poll_count: 8,
      elapsed_ms: 1000,
      timeout_ms: 1000,
      full_window_elapsed: true,
      query_error_count: 0,
      scope_binding_lost: false,
      scope_backend_node_ids: [1005]
    }
  }, {
    async reverifyCandidateBinding(stage) {
      verificationCalls += 1;
      assert.equal(stage, "after_colleague_contact_before_result");
      return {
        verified: true,
        candidate_id: "candidate-panel-absent"
      };
    }
  });
  assert.equal(verificationCalls, 1);
  assert.equal(result.candidate_binding.verified, true);
  assert.equal(result.skip_reason, "");
}

async function testRecommendGreetingJournalProtectsUnknownClickAndReconcilesExactControl() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-greet-journal-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const scope = VERIFIED_RECOMMEND_ACTION_SCOPE;
    const candidateId = "candidate-greet-unknown";
    const checkpoints = [];
    let inputCalls = 0;
    const client = {
      Page: createExactRecommendActionPage(),
      DOM: createExactRecommendActionDom(),
      Input: {
        async dispatchMouseEvent() {
          inputCalls += 1;
          const error = new Error("connection closed during click");
          error.cdp_method = "Input.dispatchMouseEvent";
          error.cdp_outcome_unknown = true;
          throw error;
        }
      }
    };
    const actionDiscovery = {
      summary: {
        greet: {
          found: true,
          kind: "greet",
          label: "打招呼",
          available: true,
          continue_chat: false,
          disabled: false,
          node_id: 501,
          backend_node_id: 1501,
          root_node_id: 10,
          root_backend_node_id: 1010
        }
      }
    };
    const unknown = await runRecommendPostAction({
      client,
      screening: { passed: true },
      actionDiscovery,
      postAction: "greet",
      executePostAction: true,
      afterClickDelayMs: 0,
      candidateId,
      candidateBinding: createVerifiedRecommendCandidateBinding(candidateId),
      reverifyCandidateBinding: async () => createVerifiedRecommendCandidateBinding(candidateId),
      actionJournal: journal,
      actionJournalScope: scope,
      reverifyActionJournalScope: async () => scope,
      runId: "run-unknown",
      checkpointCritical: (patch) => checkpoints.push(patch)
    });
    assert.equal(unknown.outcome_unknown, true);
    assert.equal(unknown.stop_run, true);
    assert.equal(unknown.counted_as_greet, false);
    assert.equal(inputCalls, 1);
    assert.deepEqual(
      checkpoints.map((checkpoint) => checkpoint.action_transaction.state),
      ["pre_action", "greeting_send_in_flight", "outcome_unknown"]
    );
    const unknownRecord = journal.read({ scope, candidateId });
    assert.equal(unknownRecord.state, "outcome_unknown");
    assert.equal(unknownRecord.evidence.control_node_id, 501);
    assert.equal(unknownRecord.evidence.control_backend_node_id, 1501);
    assert.equal(unknownRecord.evidence.control_label, "打招呼");
    assert.equal(unknownRecord.evidence.control_center_x, 60);
    assert.equal(unknownRecord.evidence.control_rect_width, 100);

    const protectedResult = await runRecommendPostAction({
      client,
      screening: { passed: true },
      actionDiscovery,
      postAction: "greet",
      executePostAction: true,
      afterClickDelayMs: 0,
      candidateId,
      candidateBinding: createVerifiedRecommendCandidateBinding(candidateId),
      reverifyCandidateBinding: async () => createVerifiedRecommendCandidateBinding(candidateId),
      actionJournal: journal,
      actionJournalScope: scope,
      reverifyActionJournalScope: async () => scope,
      runId: "run-replacement",
      checkpointCritical: (patch) => checkpoints.push(patch)
    });
    assert.equal(protectedResult.reason, "greet_outcome_unknown_preserved_no_replay");
    assert.equal(protectedResult.outcome_unknown, true);
    assert.equal(inputCalls, 1);

    const reconciledCandidateId = "candidate-greet-reconciled";
    journal.transition({
      scope,
      candidateId: reconciledCandidateId,
      state: "pre_action",
      runId: "old-run",
      greeting: "boss-recommend-greet-action-v1"
    });
    journal.transition({
      scope,
      candidateId: reconciledCandidateId,
      state: "greeting_send_in_flight",
      runId: "old-run",
      greeting: "boss-recommend-greet-action-v1"
    });
    const reconciled = await runRecommendPostAction({
      client: { DOM: createExactRecommendActionDom({ label: "继续沟通" }) },
      screening: { passed: true },
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "继续沟通",
            available: false,
            continue_chat: true,
            disabled: false,
            node_id: 777,
            backend_node_id: 1777,
            root_node_id: 10,
            root_backend_node_id: 1010
          }
        }
      },
      postAction: "greet",
      executePostAction: true,
      candidateId: reconciledCandidateId,
      candidateBinding: createVerifiedRecommendCandidateBinding(reconciledCandidateId),
      reverifyCandidateBinding: async () => createVerifiedRecommendCandidateBinding(reconciledCandidateId),
      actionJournal: journal,
      actionJournalScope: scope,
      reverifyActionJournalScope: async () => scope,
      runId: "reconcile-run",
      checkpointCritical: (patch) => checkpoints.push(patch)
    });
    assert.equal(reconciled.verified_after_click, true);
    assert.equal(reconciled.already_connected, true);
    assert.equal(journal.read({ scope, candidateId: reconciledCandidateId }).state, "greeting_confirmed");

    const compoundCandidateId = "candidate-compound-continue-chat";
    journal.transition({
      scope,
      candidateId: compoundCandidateId,
      state: "pre_action",
      runId: "old-run",
      greeting: "boss-recommend-greet-action-v1"
    });
    journal.transition({
      scope,
      candidateId: compoundCandidateId,
      state: "greeting_send_in_flight",
      runId: "old-run",
      greeting: "boss-recommend-greet-action-v1"
    });
    await assert.rejects(
      () => runRecommendPostAction({
        client: {
          DOM: createExactRecommendActionDom({ label: "候选人资料 继续沟通" })
        },
        screening: { passed: true },
        actionDiscovery: {
          summary: {
            greet: {
              found: true,
              kind: "greet",
              label: "候选人资料 继续沟通",
              available: false,
              continue_chat: true,
              disabled: false,
              node_id: 778,
              backend_node_id: 1778,
              root_node_id: 10,
              root_backend_node_id: 1010
            }
          }
        },
        postAction: "greet",
        executePostAction: true,
        candidateId: compoundCandidateId,
        candidateBinding: createVerifiedRecommendCandidateBinding(compoundCandidateId),
        reverifyCandidateBinding: async () => createVerifiedRecommendCandidateBinding(compoundCandidateId),
        actionJournal: journal,
        actionJournalScope: scope,
        reverifyActionJournalScope: async () => scope,
        runId: "compound-reconcile-run",
        checkpointCritical: (patch) => checkpoints.push(patch)
      }),
      (error) => error?.code === "RECOMMEND_ACTION_CONTROL_LABEL_MISMATCH"
    );
    assert.equal(journal.read({ scope, candidateId: compoundCandidateId }).state, "greeting_send_in_flight");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendPostClickBackendScopedFrontendAliasConfirmsGreeting() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-post-click-frontend-alias-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const candidateId = "candidate-post-click-frontend-alias";
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    const fixture = createPostClickRecommendActionClient({
      rootScopedControlAliasNodeId: 601,
      postClickInitialGreetReads: 1
    });
    const result = await runRecommendPostAction({
      client: fixture.client,
      screening: { passed: true },
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 501,
            backend_node_id: 1501,
            root: "top:detail-popup",
            root_node_id: 10,
            root_backend_node_id: 1010
          }
        }
      },
      postAction: "greet",
      executePostAction: true,
      afterClickDelayMs: 0,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async () => binding,
      actionJournal: journal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "post-click-frontend-alias-run",
      checkpointCritical() {}
    });
    assert.equal(fixture.clicked, true);
    assert.equal(fixture.inputCalls > 0, true);
    assert.equal(fixture.postClickGreetReads >= 2, true);
    assert.equal(result.verified_after_click, true);
    assert.equal(result.reason, "greeting_confirmed");
    assert.equal(result.counted_as_greet, true);
    assert.notEqual(result.outcome_unknown, true);
    const record = journal.read({
      scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      candidateId
    });
    assert.equal(record.state, "greeting_confirmed");
    assert.deepEqual(
      record.history.map((entry) => entry.state),
      ["pre_action", "greeting_send_in_flight", "greeting_confirmed"]
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendCandidateBindingMismatchCannotEnterPostActionClick() {
  let inputCalls = 0;
  const candidateId = "candidate-binding-guard";
  const mismatchedBinding = {
    ...createVerifiedRecommendCandidateBinding("different-candidate"),
    expected_candidate_id: "different-candidate"
  };
  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(mismatchedBinding, candidateId),
    false
  );
  await assert.rejects(
    () => runRecommendPostAction({
      client: {
        Input: {
          async dispatchMouseEvent() {
            inputCalls += 1;
          }
        }
      },
      screening: { passed: true },
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 999
          }
        }
      },
      postAction: "greet",
      executePostAction: true,
      candidateId,
      candidateBinding: mismatchedBinding,
      actionJournal: {
        read() { return null; },
        transition() { throw new Error("journal must not be reached"); }
      },
      checkpointCritical() {
        throw new Error("checkpoint must not be reached");
      }
    }),
    (error) => error?.code === "RECOMMEND_DETAIL_CANDIDATE_MISMATCH"
  );
  assert.equal(inputCalls, 0);
}

async function testRecommendPreInputCheckpointAbortIsDurableAndReplayable() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-greet-pre-input-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const candidateId = "candidate-pre-input-abort";
    let inputCalls = 0;
    const client = {
      Page: createExactRecommendActionPage(),
      DOM: createExactRecommendActionDom(),
      Input: {
        async dispatchMouseEvent() {
          inputCalls += 1;
          const error = new Error("stop after replay reached Input");
          error.cdp_method = "Input.dispatchMouseEvent";
          throw error;
        }
      }
    };
    const discovery = {
      summary: {
        greet: {
          found: true,
          kind: "greet",
          label: "打招呼",
          available: true,
          continue_chat: false,
          disabled: false,
          node_id: 601,
          backend_node_id: 1601,
          root_node_id: 10,
          root_backend_node_id: 1010
        }
      }
    };
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    const aborted = await runRecommendPostAction({
      client,
      screening: { passed: true },
      actionDiscovery: discovery,
      postAction: "greet",
      executePostAction: true,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async () => binding,
      actionJournal: journal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "run-pre-input-abort",
      checkpointCritical(patch) {
        if (patch?.action_transaction?.state === "greeting_send_in_flight") {
          throw new Error("checkpoint unavailable before Input");
        }
      }
    });
    assert.equal(aborted.pre_input_aborted, true);
    assert.equal(aborted.replayable, true);
    assert.equal(aborted.stop_run, true);
    assert.equal(inputCalls, 0);
    const abortedRecord = journal.read({
      scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      candidateId
    });
    assert.equal(abortedRecord.state, "greeting_send_in_flight");
    assert.equal(abortedRecord.history.at(-1).evidence.reason, "pre_input_checkpoint_aborted");

    const replay = await runRecommendPostAction({
      client,
      screening: { passed: true },
      actionDiscovery: discovery,
      postAction: "greet",
      executePostAction: true,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async () => binding,
      actionJournal: journal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "run-pre-input-replay",
      checkpointCritical() {}
    });
    assert.equal(inputCalls, 1);
    assert.equal(replay.outcome_unknown, true);
    assert.equal(journal.read({
      scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      candidateId
    }).state, "outcome_unknown");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendActionHitTestAbortIsDurableReplayableAndZeroInput() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-greet-hit-test-abort-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const candidateId = "candidate-hit-test-abort";
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    let inputCalls = 0;
    const dom = createExactRecommendActionDom();
    dom.getNodeForLocation = async () => ({
      nodeId: 999,
      backendNodeId: 1999,
      frameId: "foreign-overlay-frame"
    });
    const result = await runRecommendPostAction({
      client: {
        Page: createExactRecommendActionPage(),
        DOM: dom,
        Input: {
          async dispatchMouseEvent() {
            inputCalls += 1;
          }
        }
      },
      screening: { passed: true },
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 601,
            backend_node_id: 1601,
            root_node_id: 10,
            root_backend_node_id: 1010
          }
        }
      },
      postAction: "greet",
      executePostAction: true,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async () => binding,
      actionJournal: journal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "run-hit-test-abort",
      checkpointCritical() {}
    });

    assert.equal(inputCalls, 0);
    assert.equal(result.pre_input_aborted, true);
    assert.equal(result.replayable, true);
    assert.equal(result.stop_run, true);
    assert.equal(result.reason, "greet_pre_input_aborted_replayable");
    assert.equal(result.outcome_unknown, undefined);
    assert.equal(result.error.code, "RECOMMEND_ACTION_CONTROL_HIT_TEST_UNVERIFIED");
    assert.equal(result.error.recommend_pre_input_aborted, true);
    assert.equal(result.error.recommend_input_dispatched, false);
    assert.equal(result.error.recommend_action_control_hit_test.attempts.length, 5);
    const record = journal.read({
      scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      candidateId
    });
    assert.equal(record.state, "greeting_send_in_flight");
    assert.equal(record.history.at(-1).evidence.reason, "pre_input_abort");
    assert.equal(record.history.at(-1).evidence.pre_input_cdp_method, "DOM.getNodeForLocation");
    assert.equal(record.history.at(-1).evidence.action_hit_test_attempt_count, 5);
    assert.equal(
      record.history.at(-1).evidence.action_hit_test_reason,
      "action_click_point_not_owned_by_exact_control"
    );
    assert.equal(record.history.at(-1).evidence.action_hit_test_last_hit_backend_node_id, 1999);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendConcurrentForeignOwnerCannotAuthorizeInput() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-greet-race-"));
  try {
    const fixedNow = "2026-07-21T03:00:00.000Z";
    const journal = createRecommendGreetingActionJournal({
      baseDir,
      now: () => fixedNow
    });
    const candidateId = "candidate-foreign-owner";
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    let inputCalls = 0;
    let foreignClaimed = false;
    const result = await runRecommendPostAction({
      client: {
        DOM: createExactRecommendActionDom(),
        Input: {
          async dispatchMouseEvent() {
            inputCalls += 1;
          }
        }
      },
      screening: { passed: true },
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 701,
            backend_node_id: 1701,
            root_node_id: 10,
            root_backend_node_id: 1010
          }
        }
      },
      postAction: "greet",
      executePostAction: true,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async () => {
        if (!foreignClaimed) {
          foreignClaimed = true;
          journal.transition({
            scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
            candidateId,
            state: "pre_action",
            runId: "foreign-run",
            greeting: "boss-recommend-greet-action-v1",
            evidence: { reason: "foreign_owner_pre_action" }
          });
          journal.transition({
            scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
            candidateId,
            state: "greeting_send_in_flight",
            runId: "foreign-run",
            greeting: "boss-recommend-greet-action-v1",
            evidence: { reason: "foreign_owner_claim" }
          });
        }
        return binding;
      },
      actionJournal: journal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "losing-run",
      checkpointCritical() {}
    });
    assert.equal(inputCalls, 0);
    assert.equal(result.reason, "greet_in_flight_owned_by_another_operation");
    assert.equal(result.stop_run, true);
    const record = journal.read({ scope: VERIFIED_RECOMMEND_ACTION_SCOPE, candidateId });
    assert.equal(record.state, "greeting_send_in_flight");
    assert.equal(record.last_run_id, "foreign-run");
    assert.equal(record.updated_at, fixedNow);
    assert.equal(record.revision, 2);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendActionControlReparentBeforeInputFailsClosed() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-greet-root-drift-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const candidateId = "candidate-root-reparent";
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    let reparented = false;
    let inputCalls = 0;
    const dom = createExactRecommendActionDom();
    const describeNode = dom.describeNode;
    dom.describeNode = async ({ nodeId }) => {
      const described = await describeNode({ nodeId });
      if (nodeId !== 10 && reparented) described.node.parentId = 99;
      return described;
    };
    await assert.rejects(
      () => runRecommendPostAction({
        client: {
        DOM: dom,
        Input: {
          async dispatchMouseEvent() {
            inputCalls += 1;
          }
        }
        },
        screening: { passed: true },
        actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 901,
            backend_node_id: 1901,
            root_node_id: 10,
            root_backend_node_id: 1010
          }
        }
        },
        postAction: "greet",
        executePostAction: true,
        candidateId,
        candidateBinding: binding,
        reverifyCandidateBinding: async (stage) => {
        if (stage === "immediately_before_greeting_control_refresh") reparented = true;
        return binding;
        },
        actionJournal: journal,
        actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
        reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
        runId: "root-reparent-run",
        checkpointCritical() {}
      }),
      (error) => error?.code === "RECOMMEND_ACTION_CONTROL_SCOPE_MISMATCH"
    );
    assert.equal(inputCalls, 0);
    assert.equal(journal.read({
      scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      candidateId
    }).state, "pre_action");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendProfileScopeDriftAfterPreActionBlocksInput() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-greet-scope-drift-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const candidateId = "candidate-scope-drift";
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    let scopeReads = 0;
    let inputCalls = 0;
    await assert.rejects(
      () => runRecommendPostAction({
        client: {
          DOM: createExactRecommendActionDom(),
          Input: {
            async dispatchMouseEvent() {
              inputCalls += 1;
            }
          }
        },
        screening: { passed: true },
        actionDiscovery: {
          summary: {
            greet: {
              found: true,
              kind: "greet",
              label: "打招呼",
              available: true,
              continue_chat: false,
              disabled: false,
              node_id: 801,
              backend_node_id: 1801,
              root_node_id: 10,
              root_backend_node_id: 1010
            }
          }
        },
        postAction: "greet",
        executePostAction: true,
        candidateId,
        candidateBinding: binding,
        reverifyCandidateBinding: async () => binding,
        actionJournal: journal,
        actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
        reverifyActionJournalScope: async () => {
          scopeReads += 1;
          return scopeReads === 1
            ? VERIFIED_RECOMMEND_ACTION_SCOPE
            : `boss-recommend-profile-v2:127.0.0.1:profile-sha256:${"b".repeat(64)}`;
        },
        runId: "scope-drift-run",
        checkpointCritical() {}
      }),
      (error) => error?.code === "RECOMMEND_ACTION_SCOPE_DRIFT"
    );
    assert.equal(inputCalls, 0);
    assert.equal(journal.read({
      scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      candidateId
    }).state, "pre_action");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendCandidateBindingRequiresOneExactControlRoot() {
  const candidateId = "candidate-exact-detail-root";
  const binding = createVerifiedRecommendCandidateBinding(candidateId);
  const popupWithContainedIframe = structuredClone(binding);
  popupWithContainedIframe.detail.root.contained_iframe = {
    selector: 'iframe[name*="resume"]',
    node_id: 31,
    backend_node_id: 1031,
    iframe_node_id: 30,
    iframe_backend_node_id: 1030,
    container_node_id: 10,
    container_backend_node_id: 1010,
    ancestry_depth: 1,
    ancestry_path: [
      { node_id: 30, backend_node_id: 1030 },
      { node_id: 10, backend_node_id: 1010 }
    ],
    visible: true,
    stable: true,
    contained: true
  };
  const containedIframeScope = {
    source: "resume_iframe",
    selector: 'iframe[name*="resume"]',
    node_id: 31,
    backend_node_id: 1031,
    iframe_node_id: 30,
    iframe_backend_node_id: 1030,
    container_node_id: 10,
    container_backend_node_id: 1010,
    container_verified: true,
    visible: true,
    ancestry: {
      verified: true,
      depth: 1,
      path: [
        { node_id: 30, backend_node_id: 1030 },
        { node_id: 10, backend_node_id: 1010 }
      ]
    }
  };
  popupWithContainedIframe.detail.first.scopes.push(structuredClone(containedIframeScope));
  popupWithContainedIframe.detail.second.scopes.push(structuredClone(containedIframeScope));
  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(popupWithContainedIframe, candidateId),
    true
  );

  const twoRoots = structuredClone(binding);
  twoRoots.detail.first.scopes.push({
    source: "popup",
    node_id: 11,
    backend_node_id: 1011,
    visible: true
  });
  twoRoots.detail.second.scopes.push({
    source: "popup",
    node_id: 11,
    backend_node_id: 1011,
    visible: true
  });
  assert.equal(isVerifiedRecommendPostActionCandidateBinding(twoRoots, candidateId), false);

  assert.equal(
    assertRecommendControlMatchesCandidateDetailRoot({
      root_node_id: 11,
      root_backend_node_id: 1010
    }, binding, "frontend_id_remapped"),
    true,
    "a fresh frontend handle for the exact immutable detail-root backend must be accepted"
  );
  assert.throws(
    () => assertRecommendControlMatchesCandidateDetailRoot({
      root_node_id: 11,
      root_backend_node_id: 1011
    }, binding, "backend_identity_drift"),
    (error) => error?.code === "RECOMMEND_ACTION_DETAIL_ROOT_MISMATCH"
  );
  assert.throws(
    () => assertRecommendControlMatchesCandidateDetailRoot({
      root_node_id: 0,
      root_backend_node_id: 1010
    }, binding, "frontend_handle_missing"),
    (error) => error?.code === "RECOMMEND_ACTION_DETAIL_ROOT_MISMATCH"
  );

  let inputCalls = 0;
  let journalCalls = 0;
  const base = {
    client: {
      Input: {
        async dispatchMouseEvent() { inputCalls += 1; }
      }
    },
    screening: { passed: true },
    postAction: "greet",
    executePostAction: true,
    candidateId,
    reverifyCandidateBinding: async () => binding,
    actionJournal: {
      read() { journalCalls += 1; return null; },
      transition() { journalCalls += 1; throw new Error("journal must not be reached"); }
    },
    actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
    reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
    checkpointCritical() { throw new Error("checkpoint must not be reached"); }
  };
  await assert.rejects(
    () => runRecommendPostAction({
      ...base,
      candidateBinding: twoRoots,
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 501,
            backend_node_id: 1501,
            root_node_id: 10,
            root_backend_node_id: 1010
          }
        }
      }
    }),
    (error) => error?.code === "RECOMMEND_DETAIL_CANDIDATE_MISMATCH"
  );
  await assert.rejects(
    () => runRecommendPostAction({
      ...base,
      candidateBinding: binding,
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 601,
            backend_node_id: 1601,
            root_node_id: 11,
            root_backend_node_id: 1011
          }
        }
      }
    }),
    (error) => error?.code === "RECOMMEND_ACTION_DETAIL_ROOT_MISMATCH"
  );
  assert.equal(inputCalls, 0);
  assert.equal(journalCalls, 0);
}

function testRecommendCanvasCausalBindingRequiresImmutableExactEvidence() {
  const candidateId = "candidate-canvas-post-action";
  const binding = createVerifiedRecommendCanvasCausalBinding(candidateId);
  assert.equal(isVerifiedRecommendPostActionCandidateBinding(binding, candidateId), true);

  const screeningOnly = structuredClone(binding);
  screeningOnly.verified = false;
  screeningOnly.method = null;
  screeningOnly.screening_verified = true;
  screeningOnly.screening_method = "exact_card_click_and_stable_popup_cv_root";
  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(screeningOnly, candidateId),
    false,
    "screening-only evidence must never authorize a post action"
  );

  const mutations = [
    (value) => {
      value.card.click_evidence.hit_test.selected_attempt.safe_card_body_hit = false;
    },
    (value) => {
      value.card.click_attempts.push({
        ...value.card.click_attempts[0],
        attempt: 2
      });
    },
    (value) => {
      value.card.after.definitively_disappeared = false;
    },
    (value) => {
      value.detail.candidate_id_evidence_present = true;
    },
    (value) => {
      value.detail.root.contained_iframe.selector = 'iframe[name="unrelated"]';
    },
    (value) => {
      value.detail.first.scopes[1].selector = 'iframe[name="drifted"]';
    },
    (value) => {
      value.card.causal_proof.verified = false;
    }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(binding);
    mutate(changed);
    assert.equal(
      isVerifiedRecommendPostActionCandidateBinding(changed, candidateId),
      false
    );
  }
  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(binding, "different-candidate"),
    false
  );
}

function testRecommendCanvasCausalBindingSurvivesCompactBeforeCard() {
  const candidateId = "candidate-canvas-compact-before";
  const binding = createVerifiedRecommendCanvasCausalBinding(candidateId);
  binding.card.before = { ...binding.card.before };
  delete binding.card.before.candidate_id;
  delete binding.card.before.name;

  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(binding, candidateId),
    true,
    "the exact identity-bearing pre-click provenance must authorize a compact persisted binding"
  );

  const candidateDrift = structuredClone(binding);
  candidateDrift.card.pre_click_provenance.card.candidate_id = "different-candidate";
  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(candidateDrift, candidateId),
    false,
    "compacted bindings must still fail closed when exact pre-click candidate identity drifts"
  );

  const nameDrift = structuredClone(binding);
  nameDrift.card.pre_click_provenance.card.name = "另一个候选人";
  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(nameDrift, candidateId),
    false,
    "compacted bindings must still fail closed when exact pre-click name identity drifts"
  );

  const frontendDrift = structuredClone(binding);
  frontendDrift.card.before.node_id += 1;
  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(frontendDrift, candidateId),
    false,
    "compacted bindings must fail closed when the structural frontend node drifts"
  );

  const backendDrift = structuredClone(binding);
  backendDrift.card.before.backend_node_id += 1;
  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(backendDrift, candidateId),
    false,
    "compacted bindings must fail closed when the structural backend node drifts"
  );

  const unverifiedBefore = structuredClone(binding);
  unverifiedBefore.card.before.verified = false;
  assert.equal(
    isVerifiedRecommendPostActionCandidateBinding(unverifiedBefore, candidateId),
    false,
    "compacted bindings must fail closed when the structural pre-click node is unverified"
  );
}

async function testRecommendPostCheckpointDriftAbortsBeforeInputReplayably() {
  for (const driftType of ["candidate", "profile", "label", "geometry", "non_scrolling_proof"]) {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `recommend-pre-input-${driftType}-`));
    try {
      const journal = createRecommendGreetingActionJournal({ baseDir });
      const candidateId = `candidate-pre-input-${driftType}`;
      const binding = createVerifiedRecommendCandidateBinding(candidateId);
      let afterInFlightCheckpoint = false;
      let inputCalls = 0;
      const dom = createExactRecommendActionDom();
      const getOuterHTML = dom.getOuterHTML;
      const getBoxModel = dom.getBoxModel;
      dom.getOuterHTML = async (args) => {
        if (afterInFlightCheckpoint && driftType === "label") {
          return { outerHTML: '<button class="btn-greet">错误标签</button>' };
        }
        return getOuterHTML(args);
      };
      dom.getBoxModel = async (args) => {
        if (afterInFlightCheckpoint && driftType === "geometry") {
          return { model: { border: [10, 10, 10, 10, 10, 50, 10, 50] } };
        }
        return getBoxModel(args);
      };
      const result = await runRecommendPostAction({
        client: {
          DOM: dom,
          Input: {
            async dispatchMouseEvent() { inputCalls += 1; }
          }
        },
        screening: { passed: true },
        actionDiscovery: {
          summary: {
            greet: {
              found: true,
              kind: "greet",
              label: "打招呼",
              available: true,
              continue_chat: false,
              disabled: false,
              node_id: 501,
              backend_node_id: 1501,
              root_node_id: 10,
              root_backend_node_id: 1010
            }
          }
        },
        postAction: "greet",
        executePostAction: true,
        candidateId,
        candidateBinding: binding,
        reverifyCandidateBinding: async (stage) => {
          if (
            afterInFlightCheckpoint
            && driftType === "candidate"
            && stage === "immediately_before_greeting_input"
          ) {
            return { ...binding, verified: false, reason: "candidate_drift_after_checkpoint" };
          }
          if (
            afterInFlightCheckpoint
            && driftType === "non_scrolling_proof"
            && stage === "immediately_before_greeting_input"
          ) {
            return { ...binding, allow_scroll: true, settle_ms: 120 };
          }
          return binding;
        },
        actionJournal: journal,
        actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
        reverifyActionJournalScope: async (stage) => (
          afterInFlightCheckpoint
          && driftType === "profile"
          && stage === "immediately_before_greeting_input"
            ? `boss-recommend-profile-v2:127.0.0.1:profile-sha256:${"b".repeat(64)}`
            : VERIFIED_RECOMMEND_ACTION_SCOPE
        ),
        runId: `post-checkpoint-${driftType}`,
        checkpointCritical(patch) {
          if (patch?.action_transaction?.state === "greeting_send_in_flight") {
            afterInFlightCheckpoint = true;
          }
        }
      });
      assert.equal(result.pre_input_aborted, true, driftType);
      assert.equal(result.replayable, true, driftType);
      assert.equal(result.reason, "greet_pre_input_aborted_replayable", driftType);
      assert.equal(inputCalls, 0, driftType);
      const record = journal.read({ scope: VERIFIED_RECOMMEND_ACTION_SCOPE, candidateId });
      assert.equal(record.state, "greeting_send_in_flight", driftType);
      assert.equal(record.history.at(-1).evidence.reason, "pre_input_abort", driftType);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  }
}

async function testRecommendCandidateSwapDuringFinalControlVerificationAbortsBeforeInput() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-final-control-swap-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const candidateId = "candidate-final-control-swap";
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    let controlScrolls = 0;
    let candidateSwapped = false;
    let inputCalls = 0;
    const dom = createExactRecommendActionDom();
    const scrollIntoViewIfNeeded = dom.scrollIntoViewIfNeeded;
    dom.scrollIntoViewIfNeeded = async (args) => {
      controlScrolls += 1;
      await scrollIntoViewIfNeeded(args);
      if (controlScrolls === 2) candidateSwapped = true;
    };
    const result = await runRecommendPostAction({
      client: {
        Page: createExactRecommendActionPage(),
        DOM: dom,
        Input: {
          async dispatchMouseEvent() { inputCalls += 1; }
        }
      },
      screening: { passed: true },
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 501,
            backend_node_id: 1501,
            root_node_id: 10,
            root_backend_node_id: 1010
          }
        }
      },
      postAction: "greet",
      executePostAction: true,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async (stage, options = {}) => {
        if (stage === "immediately_before_greeting_input") {
          assert.deepEqual(options, { allowScroll: false, settleMs: 0 });
        }
        return candidateSwapped && stage === "immediately_before_greeting_input"
          ? { ...binding, verified: false, reason: "candidate_swapped_during_final_control_verification" }
          : binding;
      },
      actionJournal: journal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "final-control-swap-run",
      checkpointCritical() {}
    });
    assert.equal(controlScrolls, 2);
    assert.equal(candidateSwapped, true);
    assert.equal(inputCalls, 0);
    assert.equal(result.pre_input_aborted, true);
    assert.equal(result.replayable, true);
    assert.equal(result.reason, "greet_pre_input_aborted_replayable");
    const record = journal.read({ scope: VERIFIED_RECOMMEND_ACTION_SCOPE, candidateId });
    assert.equal(record.state, "greeting_send_in_flight");
    assert.equal(record.history.at(-1).evidence.reason, "pre_input_abort");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendFinalInputUsesGeometryAfterNonScrollingCandidateReproof() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-final-geometry-refresh-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const candidateId = "candidate-final-geometry-refresh";
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    let xOffset = 0;
    const inputEvents = [];
    const dom = createExactRecommendActionDom();
    dom.getBoxModel = async () => ({
      model: {
        border: [
          10 + xOffset, 10,
          110 + xOffset, 10,
          110 + xOffset, 50,
          10 + xOffset, 50
        ]
      }
    });

    const result = await runRecommendPostAction({
      client: {
        Page: createExactRecommendActionPage(),
        DOM: dom,
        Input: {
          async dispatchMouseEvent(event) {
            inputEvents.push(event);
            const error = new Error("stop after capturing exact final input coordinate");
            error.cdp_method = "Input.dispatchMouseEvent";
            error.cdp_outcome_unknown = true;
            throw error;
          }
        }
      },
      screening: { passed: true },
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 501,
            backend_node_id: 1501,
            root_node_id: 10,
            root_backend_node_id: 1010
          }
        }
      },
      postAction: "greet",
      executePostAction: true,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async (stage, options = {}) => {
        if (stage === "immediately_before_greeting_input") {
          assert.deepEqual(options, { allowScroll: false, settleMs: 0 });
          // Reproduce the prior stale-coordinate race: earlier geometry was
          // centered at x=60, while the final candidate/root proof leaves the
          // same exact control centered at x=260.
          xOffset = 200;
        }
        return binding;
      },
      actionJournal: journal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "final-geometry-refresh-run",
      checkpointCritical() {}
    });

    assert.equal(result.outcome_unknown, true);
    assert.equal(inputEvents.length, 1);
    assert.deepEqual(inputEvents[0], {
      type: "mousePressed",
      x: 260,
      y: 30,
      button: "left",
      clickCount: 1
    });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendPostInputJournalFailurePreservesDetailAndPreventsReplay() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-post-input-journal-failure-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const candidateId = "candidate-post-input-journal-failure";
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    const fixture = createPostClickRecommendActionClient();
    const checkpoints = [];
    const journalFailure = Object.assign(
      new Error("journal storage busy after Input"),
      { code: "CHAT_ACTION_JOURNAL_LOCK_TIMEOUT" }
    );
    const failingJournal = {
      read: (args) => journal.read(args),
      entryPath: (args) => journal.entryPath(args),
      transition(args) {
        if (["greeting_confirmed", "outcome_unknown"].includes(args?.state)) {
          throw journalFailure;
        }
        return journal.transition(args);
      }
    };
    const actionDiscovery = {
      summary: {
        greet: {
          found: true,
          kind: "greet",
          label: "打招呼",
          available: true,
          continue_chat: false,
          disabled: false,
          node_id: 501,
          backend_node_id: 1501,
          root: "top:detail-popup",
          root_node_id: 10,
          root_backend_node_id: 1010
        }
      }
    };
    const result = await runRecommendPostAction({
      client: fixture.client,
      screening: { passed: true },
      actionDiscovery,
      postAction: "greet",
      executePostAction: true,
      afterClickDelayMs: 0,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async () => binding,
      actionJournal: failingJournal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "post-input-journal-failure-run",
      checkpointCritical(patch) { checkpoints.push(patch); }
    });
    assert.equal(fixture.clicked, true);
    assert.equal(fixture.inputCalls > 0, true);
    assert.equal(result.action_clicked, true);
    assert.equal(result.counted_as_greet, false);
    assert.equal(result.outcome_unknown, true);
    assert.equal(result.stop_run, true);
    assert.equal(result.preserve_detail_on_terminal, true);
    assert.equal(result.post_input_journal_persistence_failed, true);
    assert.equal(result.action_transaction.state, "greeting_send_in_flight");
    assert.equal(result.error.code, "CHAT_ACTION_JOURNAL_LOCK_TIMEOUT");
    assert.equal(result.terminal_preservation.candidate_id, candidateId);
    assert.equal(result.terminal_preservation.input_dispatched, true);
    assert.equal(result.terminal_preservation.control.control_root_node_id, 10);
    const emergencyCheckpoint = checkpoints.at(-1);
    assert.equal(emergencyCheckpoint.preserve_detail_on_terminal, true);
    assert.equal(emergencyCheckpoint.action_result_critical_persisted, false);
    assert.equal(emergencyCheckpoint.terminal_preservation.candidate_id, candidateId);

    const inputCallsAfterFailure = fixture.inputCalls;
    const replay = await runRecommendPostAction({
      client: fixture.client,
      screening: { passed: true },
      actionDiscovery,
      postAction: "greet",
      executePostAction: true,
      afterClickDelayMs: 0,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async () => binding,
      actionJournal: journal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "post-input-journal-failure-replay",
      checkpointCritical() {}
    });
    assert.equal(replay.reason, "greet_outcome_unknown_preserved_no_replay");
    assert.equal(replay.outcome_unknown, true);
    assert.equal(fixture.inputCalls, inputCallsAfterFailure);
    assert.equal(journal.read({
      scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      candidateId
    }).state, "outcome_unknown");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendCandidateDriftAfterExactPostClickControlStaysUnknown() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "recommend-post-click-candidate-drift-"));
  try {
    const journal = createRecommendGreetingActionJournal({ baseDir });
    const candidateId = "candidate-post-click-drift";
    const binding = createVerifiedRecommendCandidateBinding(candidateId);
    const fixture = createPostClickRecommendActionClient();
    const result = await runRecommendPostAction({
      client: fixture.client,
      screening: { passed: true },
      actionDiscovery: {
        summary: {
          greet: {
            found: true,
            kind: "greet",
            label: "打招呼",
            available: true,
            continue_chat: false,
            disabled: false,
            node_id: 501,
            backend_node_id: 1501,
            root: "top:detail-popup",
            root_node_id: 10,
            root_backend_node_id: 1010
          }
        }
      },
      postAction: "greet",
      executePostAction: true,
      afterClickDelayMs: 0,
      candidateId,
      candidateBinding: binding,
      reverifyCandidateBinding: async (stage) => (
        stage === "after_greeting_control_confirmation"
          ? { ...binding, verified: false, reason: "candidate_changed_after_continue_control" }
          : binding
      ),
      actionJournal: journal,
      actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
      runId: "post-click-drift-run",
      checkpointCritical() {}
    });
    assert.equal(fixture.clicked, true);
    assert.equal(result.verified_after_click, undefined);
    assert.equal(result.outcome_unknown, true);
    assert.equal(result.counted_as_greet, false);
    assert.equal(journal.read({
      scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
      candidateId
    }).state, "outcome_unknown");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testRecommendPostClickJournalCheckpointFailurePreservesResultPath() {
  for (const finalState of ["outcome_unknown", "greeting_confirmed"]) {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `recommend-post-click-${finalState}-`));
    try {
      const journal = createRecommendGreetingActionJournal({ baseDir });
      const candidateId = `candidate-post-click-${finalState}`;
      const binding = createVerifiedRecommendCandidateBinding(candidateId);
      const clickError = finalState === "outcome_unknown"
        ? Object.assign(new Error("click transport failed"), {
            cdp_method: "Input.dispatchMouseEvent",
            cdp_outcome_unknown: true
          })
        : null;
      const fixture = createPostClickRecommendActionClient({ clickError });
      const result = await runRecommendPostAction({
        client: fixture.client,
        screening: { passed: true },
        actionDiscovery: {
          summary: {
            greet: {
              found: true,
              kind: "greet",
              label: "打招呼",
              available: true,
              continue_chat: false,
              disabled: false,
              node_id: 501,
              backend_node_id: 1501,
              root: "top:detail-popup",
              root_node_id: 10,
              root_backend_node_id: 1010
            }
          }
        },
        postAction: "greet",
        executePostAction: true,
        afterClickDelayMs: 0,
        candidateId,
        candidateBinding: binding,
        reverifyCandidateBinding: async () => binding,
        actionJournal: journal,
        actionJournalScope: VERIFIED_RECOMMEND_ACTION_SCOPE,
        reverifyActionJournalScope: async () => VERIFIED_RECOMMEND_ACTION_SCOPE,
        runId: `post-click-${finalState}-run`,
        checkpointCritical(patch) {
          if (patch?.action_transaction?.state === finalState) {
            throw new Error(`critical ${finalState} checkpoint unavailable`);
          }
        }
      });
      assert.equal(result.action_transaction.state, finalState);
      assert.equal(result.stop_run, true);
      assert.equal(result.preserve_detail_until_result_persisted, true);
      assert.equal(Boolean(result.action_transaction_checkpoint_error), true);
      assert.equal(journal.read({
        scope: VERIFIED_RECOMMEND_ACTION_SCOPE,
        candidateId
      }).state, finalState);

      const candidateResult = { candidate: { id: candidateId }, post_action: result };
      const fallbackCheckpoints = [];
      await assert.rejects(
        async () => checkpointRecommendPostActionStopResult({
          checkpointCritical() { throw new Error("full result persistence failed"); },
          checkpoint(patch) { fallbackCheckpoints.push(patch); }
        }, {
          results: [candidateResult],
          preserve_detail_on_terminal: false,
          action_result_critical_persisted: true
        }, {
          candidateResult,
          candidateId,
          actionState: finalState,
          resultIndex: 0
        }),
        (error) => error?.recommend_preserve_detail_on_terminal === true
      );
      assert.equal(fallbackCheckpoints.length, 1);
      assert.equal(fallbackCheckpoints[0].results[0], candidateResult);
      assert.equal(fallbackCheckpoints[0].preserve_detail_on_terminal, true);
      assert.equal(fallbackCheckpoints[0].action_result_critical_persisted, false);
      assert.equal(fallbackCheckpoints[0].terminal_preservation.action_state, finalState);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  }
}

await testLifecycleDelegation();
await testPostActionTerminalStopFailsLifecycleButPreservesSummary();
testCanvasCausalBindingEvidenceIsReusedBeforeEveryDetailRead();
testPostActionBindingIsGatedByPassedScreening();
testRecommendScreeningCandidateIdentityInvariantFailsClosed();
testRecommendPreLlmInvariantRunsBeforeModelCall();
testDebugBoundaryValidationAndOnceOnlyController();
await testListReadStaleRecoveryThenSuccess();
testDomStaleForensicEventIsSafeAndCorrelatable();
await testListReadRepeatedStaleIsBounded();
await testListReadRecoveryDoesNotDuplicateResultsOrActions();
await testTieredListReadRecoverySelection();
await testInitialJobSelectionRequiresIndependentStickyVerification();
await testDebugBoundaryOptionDelegation();
testRefreshFailurePreservesCdpDiagnostic();
await testPostActionOptionDelegation();
await testDetailLimitDefaultsToUnlimitedForPassTarget();
await testNativeFilterStageOrderingAndBypass();
await testRunServiceMissingFilterPanelDefaultPolicy();
testCompactFilterResultPreservesActivityEvidenceAndAttempts();
testRefreshFilterEnvelopePreservesActivitySafetyFlags();
testRecommendStatusCountersRequireSuccessfulRecoveryEvidence();
testColleagueContactFilterForcesDetailInspectionPastConfiguredLimit();
testRecommendRefreshCompletionRequiresExactBoundEmptyState();
testRecoverableDetailBindingSurvivesNullResultAndReservesOneRecovery();
testPreClickStaleNoActionDispositionRequiresExactRetryExhaustion();
testCandidateLocalCriticalCheckpointIncludesProcessedListState();
await testColleagueResultBindingDriftPreventsDerivedSkip();
await testVerifiedPanelAbsenceContinuesAfterFreshCandidateBinding();
await testRecommendGreetingJournalProtectsUnknownClickAndReconcilesExactControl();
await testRecommendPostClickBackendScopedFrontendAliasConfirmsGreeting();
await testRecommendCandidateBindingMismatchCannotEnterPostActionClick();
await testRecommendPreInputCheckpointAbortIsDurableAndReplayable();
await testRecommendActionHitTestAbortIsDurableReplayableAndZeroInput();
await testRecommendConcurrentForeignOwnerCannotAuthorizeInput();
await testRecommendProfileScopeDriftAfterPreActionBlocksInput();
await testRecommendActionControlReparentBeforeInputFailsClosed();
await testRecommendCandidateBindingRequiresOneExactControlRoot();
testRecommendCanvasCausalBindingRequiresImmutableExactEvidence();
testRecommendCanvasCausalBindingSurvivesCompactBeforeCard();
await testRecommendPostCheckpointDriftAbortsBeforeInputReplayably();
await testRecommendCandidateSwapDuringFinalControlVerificationAbortsBeforeInput();
await testRecommendFinalInputUsesGeometryAfterNonScrollingCandidateReproof();
await testRecommendPostInputJournalFailurePreservesDetailAndPreventsReplay();
await testRecommendCandidateDriftAfterExactPostClickControlStaysUnknown();
await testRecommendPostClickJournalCheckpointFailurePreservesResultPath();

console.log("recommend run service tests passed");
