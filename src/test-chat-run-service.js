#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RUN_STATUS_CANCELED,
  RUN_STATUS_FAILED,
  RUN_STATUS_PAUSED
} from "./core/run/index.js";
import {
  captureNodeIdFromResumeState,
  CHAT_COLLECT_CV_PROCESSING_FLOOR_MAX_MS,
  CHAT_COLLECT_CV_PROCESSING_FLOOR_MIN_MS,
  CHAT_EDITOR_PRE_ACTION_RETRY_LIMIT,
  CHAT_EDITOR_PRE_ACTION_RETRY_SETTLE_MS,
  applyChatProtectedOutcomeSkip,
  chatDetailSkipReasonFromReadyState,
  consumeChatDetailRecoveryBudget,
  countChatResultStatuses,
  compactChatCandidateSelectionReadyState,
  createCvCollectionScreening,
  createChatRunService,
  enforceChatCollectCvProcessingFloor,
  hasScreenableChatFullCvEvidence,
  isChatCandidateSelectionMismatchError,
  isChatOnlineResumeModalOpenFailureError,
  isRecoverableChatImageCaptureError,
  isChatResumeModalCloseFailureError,
  makeChatCandidateSelectionMismatchError,
  requireExactChatCandidateSelection,
  makeChatResumeModalOpenBeforeCandidateClickError,
  CHAT_ONLINE_RESUME_MODAL_NOT_OPEN_CODE,
  createChatActionJournal,
  reconcileChatRequestJournalFromExactExistingState,
  preserveChatRequestOutcomeUnknownWithoutReplay,
  resolveChatDomFallbackWait,
  sampleChatCollectCvProcessingFloorMs,
  shouldRetryChatEditorPreAction,
  shouldOpenOnlineResumeForChatDetail,
  summarizeChatFullCvEvidence
} from "./domains/chat/index.js";

function initializeRequestOutcomeUnknownJournal(journal, {
  scope,
  candidateId,
  greeting,
  runId = "old-run"
}) {
  journal.transition({ scope, candidateId, state: "pre_action", greeting, runId });
  journal.transition({ scope, candidateId, state: "greeting_send_in_flight", greeting, runId });
  journal.transition({ scope, candidateId, state: "greeting_confirmed", greeting, runId });
  journal.transition({ scope, candidateId, state: "request_in_flight", greeting, runId });
  return journal.transition({
    scope,
    candidateId,
    state: "outcome_unknown",
    greeting,
    runId,
    evidence: { action: "request_resume", reason: "resume_request_message_not_observed" }
  }).record;
}

function testExactExistingRequestStateReconcilesUnknownJournal() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-reconcile-journal-"));
  try {
    const journal = createChatActionJournal({ baseDir });
    const scope = "boss-chat-cdp:127.0.0.1:9222";
    const candidateId = "candidate-202";
    const greeting = "Hi同学，能麻烦发下简历吗？";
    const unknownRecord = initializeRequestOutcomeUnknownJournal(journal, {
      scope,
      candidateId,
      greeting
    });
    const checkpoints = [];
    const reconciled = reconcileChatRequestJournalFromExactExistingState({
      actionJournal: journal,
      actionJournalScope: scope,
      actionJournalRecord: unknownRecord,
      candidateId,
      selectionReadyState: {
        candidate_selection_verified: true,
        expected_candidate_id: candidateId,
        active_candidate_id: candidateId
      },
      readyState: {
        already_requested_resume: true,
        attachment_resume_enabled: true
      },
      runId: "recovery-run",
      greeting,
      checkpointCritical: (patch) => checkpoints.push(patch)
    });
    assert.equal(reconciled.requested, false);
    assert.equal(reconciled.skipped, true);
    assert.equal(reconciled.satisfied, true);
    assert.equal(reconciled.journal_reconciled_existing_state, true);
    assert.equal(reconciled.action_transaction.state, "request_confirmed");
    assert.equal(reconciled.action_transaction.evidence.active_candidate_id, candidateId);
    assert.equal(
      reconciled.action_transaction.evidence.request_confirmation_source,
      "exact_requested_resume_state"
    );
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].action_transaction.state, "request_confirmed");
    const stored = journal.read({ scope, candidateId });
    assert.equal(stored.state, "request_confirmed");
    assert.equal(stored.last_run_id, "recovery-run");
    assert.equal(stored.history.at(-1).from_state, "outcome_unknown");
    assert.equal(stored.history.at(-1).state, "request_confirmed");

    const attachmentCandidateId = "candidate-attachment";
    journal.transition({ scope, candidateId: attachmentCandidateId, state: "pre_action", greeting, runId: "old-run" });
    journal.transition({ scope, candidateId: attachmentCandidateId, state: "greeting_send_in_flight", greeting, runId: "old-run" });
    journal.transition({ scope, candidateId: attachmentCandidateId, state: "greeting_confirmed", greeting, runId: "old-run" });
    const requestInFlightRecord = journal.transition({
      scope,
      candidateId: attachmentCandidateId,
      state: "request_in_flight",
      greeting,
      runId: "old-run"
    }).record;
    const attachmentReconciled = reconcileChatRequestJournalFromExactExistingState({
      actionJournal: journal,
      actionJournalScope: scope,
      actionJournalRecord: requestInFlightRecord,
      candidateId: attachmentCandidateId,
      selectionReadyState: {
        candidate_selection_verified: true,
        expected_candidate_id: attachmentCandidateId,
        active_candidate_id: attachmentCandidateId
      },
      readyState: {
        already_requested_resume: false,
        attachment_resume_enabled: true
      },
      runId: "recovery-run",
      greeting,
      checkpointCritical: (patch) => checkpoints.push(patch)
    });
    assert.equal(attachmentReconciled.action_transaction.state, "request_confirmed");
    assert.equal(
      attachmentReconciled.action_transaction.evidence.request_confirmation_source,
      "attachment_resume_available"
    );
    assert.equal(attachmentReconciled.action_transaction.evidence.message_observed, false);
    const attachmentStored = journal.read({ scope, candidateId: attachmentCandidateId });
    assert.equal(attachmentStored.history.at(-1).from_state, "request_in_flight");
    assert.equal(attachmentStored.history.at(-1).state, "request_confirmed");
    assert.equal(reconcileChatRequestJournalFromExactExistingState({
      actionJournal: journal,
      actionJournalScope: scope,
      actionJournalRecord: attachmentStored,
      candidateId: attachmentCandidateId,
      selectionReadyState: {
        candidate_selection_verified: true,
        expected_candidate_id: attachmentCandidateId,
        active_candidate_id: attachmentCandidateId
      },
      readyState: {
        already_requested_resume: false,
        attachment_resume_enabled: true
      },
      runId: "recovery-run",
      greeting,
      checkpointCritical: (patch) => checkpoints.push(patch)
    }), null);
    assert.equal(checkpoints.length, 2);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testExistingRequestStateReconciliationFailsClosedWithoutExactEvidence() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-reconcile-negative-"));
  try {
    const journal = createChatActionJournal({ baseDir });
    const scope = "boss-chat-cdp:127.0.0.1:9222";
    const candidateId = "candidate-negative";
    const greeting = "Hi同学，能麻烦发下简历吗？";
    const unknownRecord = initializeRequestOutcomeUnknownJournal(journal, {
      scope,
      candidateId,
      greeting
    });
    const exactSelection = {
      candidate_selection_verified: true,
      expected_candidate_id: candidateId,
      active_candidate_id: candidateId
    };
    const readyState = {
      already_requested_resume: false,
      attachment_resume_enabled: true
    };
    const checkpoints = [];
    const variants = [
      { selectionReadyState: { ...exactSelection, candidate_selection_verified: false } },
      { selectionReadyState: { ...exactSelection, expected_candidate_id: "other" } },
      { selectionReadyState: { ...exactSelection, active_candidate_id: "other" } },
      { readyState: { already_requested_resume: false, attachment_resume_enabled: false } },
      { actionJournalRecord: null },
      {
        actionJournalRecord: {
          ...unknownRecord,
          state: "outcome_unknown",
          history: [
            ...unknownRecord.history.slice(0, -1),
            { ...unknownRecord.history.at(-1), from_state: "greeting_send_in_flight" }
          ]
        }
      }
    ];
    for (const variant of variants) {
      const result = reconcileChatRequestJournalFromExactExistingState({
        actionJournal: journal,
        actionJournalScope: scope,
        actionJournalRecord: variant.actionJournalRecord === undefined
          ? unknownRecord
          : variant.actionJournalRecord,
        candidateId,
        selectionReadyState: variant.selectionReadyState || exactSelection,
        readyState: variant.readyState || readyState,
        runId: "recovery-run",
        greeting,
        checkpointCritical: (patch) => checkpoints.push(patch)
      });
      assert.equal(result, null);
    }
    assert.equal(checkpoints.length, 0);
    assert.equal(journal.read({ scope, candidateId }).state, "outcome_unknown");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testProtectedRequestOutcomeUnknownIsSkippedWithoutReplay() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-protected-unknown-"));
  try {
    const journal = createChatActionJournal({ baseDir });
    const scope = "boss-chat-cdp:127.0.0.1:9222";
    const candidateId = "candidate-protected-request";
    const greeting = "Hi同学，能麻烦发下简历吗？";
    const unknownRecord = initializeRequestOutcomeUnknownJournal(journal, {
      scope,
      candidateId,
      greeting
    });
    const storedBefore = JSON.stringify(journal.read({ scope, candidateId }));
    const protectedResult = preserveChatRequestOutcomeUnknownWithoutReplay({
      actionJournalRecord: unknownRecord,
      candidateId,
      activeCandidateId: candidateId,
      readyEvidence: {
        already_requested_resume: false,
        attachment_resume_enabled: false
      },
      messageEvidence: {
        ok: true,
        count: 0,
        resume_attachment_count: 0
      }
    });

    assert.equal(protectedResult.requested, false);
    assert.equal(protectedResult.skipped, true);
    assert.equal(protectedResult.satisfied, false);
    assert.equal(protectedResult.reason, "outcome_unknown_preserved_no_replay");
    assert.equal(protectedResult.journal_preserved_outcome_unknown, true);
    assert.equal(protectedResult.no_replay, true);
    assert.equal(protectedResult.action_unknown_origin, "request_in_flight");
    assert.equal(protectedResult.action_transaction.state, "outcome_unknown");
    assert.equal(protectedResult.request_verification.request_message_count, 0);
    assert.equal(protectedResult.request_verification.resume_attachment_count, 0);
    assert.equal(JSON.stringify(journal.read({ scope, candidateId })), storedBefore);

    const protectedScreening = applyChatProtectedOutcomeSkip({
      status: "pass",
      passed: true,
      score: 100,
      reasons: ["collect_cv:request_cv_available"],
      candidate: { id: candidateId }
    }, protectedResult, { id: candidateId });
    assert.equal(protectedScreening.status, "skip");
    assert.equal(protectedScreening.passed, false);
    assert.equal(protectedScreening.score, 0);
    assert.deepEqual(protectedScreening.reasons, ["outcome_unknown_preserved_no_replay"]);

    const greetingOriginUnknown = {
      ...unknownRecord,
      history: [
        ...unknownRecord.history.slice(0, -1),
        { ...unknownRecord.history.at(-1), from_state: "greeting_send_in_flight" }
      ]
    };
    const variants = [
      { activeCandidateId: "other-candidate" },
      { actionJournalRecord: { ...unknownRecord, candidate_id: "other-candidate" } },
      { actionJournalRecord: greetingOriginUnknown },
      { actionJournalRecord: { ...unknownRecord, state: "request_in_flight" } }
    ];
    for (const variant of variants) {
      assert.equal(preserveChatRequestOutcomeUnknownWithoutReplay({
        actionJournalRecord: variant.actionJournalRecord || unknownRecord,
        candidateId,
        activeCandidateId: variant.activeCandidateId || candidateId,
        readyEvidence: {},
        messageEvidence: { ok: true, count: 0, resume_attachment_count: 0 }
      }), null);
    }
    const unchangedScreening = { status: "pass", passed: true, candidate: { id: candidateId } };
    assert.equal(applyChatProtectedOutcomeSkip(unchangedScreening, { skipped: true }, null), unchangedScreening);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

async function testCollectCvProcessingFloorHelpers() {
  assert.equal(sampleChatCollectCvProcessingFloorMs({ random: () => 0 }), 10000);
  assert.equal(sampleChatCollectCvProcessingFloorMs({ random: () => 0.5 }), 12500);
  assert.equal(sampleChatCollectCvProcessingFloorMs({ random: () => 1 }), 15000);

  let fakeNow = 4000;
  const sleepCalls = [];
  const enforced = await enforceChatCollectCvProcessingFloor({
    candidateStartedAt: 0,
    targetMs: 15000,
    nowFn: () => fakeNow,
    sleepFn: async (ms) => {
      sleepCalls.push(ms);
      fakeNow += ms;
    }
  });
  assert.deepEqual(sleepCalls, [11000]);
  assert.deepEqual(enforced, {
    enabled: true,
    target_ms: 15000,
    elapsed_before_ms: 4000,
    delay_requested_ms: 11000,
    delay_elapsed_ms: 11000,
    elapsed_after_ms: 15000,
    verified: true
  });

  let unnecessarySleep = false;
  const alreadySatisfied = await enforceChatCollectCvProcessingFloor({
    candidateStartedAt: 0,
    targetMs: 10000,
    nowFn: () => 16000,
    sleepFn: async () => {
      unnecessarySleep = true;
    }
  });
  assert.equal(unnecessarySleep, false);
  assert.equal(alreadySatisfied.delay_requested_ms, 0);
  assert.equal(alreadySatisfied.elapsed_after_ms, 16000);
  assert.equal(alreadySatisfied.verified, true);

  const disabled = await enforceChatCollectCvProcessingFloor({ enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.delay_requested_ms, 0);

  await assert.rejects(
    enforceChatCollectCvProcessingFloor({
      candidateStartedAt: 0,
      targetMs: 10000,
      nowFn: () => 0,
      sleepFn: async () => {}
    }),
    (error) => error?.code === "CHAT_COLLECT_CV_PROCESSING_FLOOR_CLOCK_STALLED"
  );
}

async function testCollectCvProcessingFloorServiceContract() {
  const service = createChatRunService({
    idPrefix: "test_chat_floor",
    workflow: async () => ({ domain: "chat", processed: 0, results: [] })
  });

  const collectCv = service.startChatRun({
    client: { guarded: true },
    criteria: "",
    maxCandidates: 1,
    humanBehavior: { enabled: false, profile: "baseline" }
  });
  assert.equal(collectCv.context.collect_cv_processing_floor_enabled, true);
  assert.equal(collectCv.context.collect_cv_processing_floor_min_ms, CHAT_COLLECT_CV_PROCESSING_FLOOR_MIN_MS);
  assert.equal(collectCv.context.collect_cv_processing_floor_max_ms, CHAT_COLLECT_CV_PROCESSING_FLOOR_MAX_MS);
  assert.equal(collectCv.context.human_rest_enabled, false);
  assert.equal(collectCv.context.human_rest_per_candidate_enabled, false);
  await service.waitForChatRun(collectCv.runId);

  const collectCvWithHighRest = service.startChatRun({
    client: { guarded: true },
    criteria: "",
    maxCandidates: 1,
    humanBehavior: {
      enabled: true,
      profile: "paced_with_rests",
      restLevel: "high"
    }
  });
  assert.equal(collectCvWithHighRest.context.collect_cv_processing_floor_enabled, true);
  assert.equal(collectCvWithHighRest.context.human_rest_enabled, true);
  assert.equal(collectCvWithHighRest.context.human_rest_level, "high");
  assert.equal(collectCvWithHighRest.context.human_rest_per_candidate_enabled, false);
  await service.waitForChatRun(collectCvWithHighRest.runId);

  const screening = service.startChatRun({
    client: { guarded: true },
    criteria: "算法",
    maxCandidates: 1,
    humanBehavior: { enabled: false, profile: "baseline" }
  });
  assert.equal(screening.context.collect_cv_processing_floor_enabled, false);
  assert.equal(screening.context.collect_cv_processing_floor_min_ms, null);
  assert.equal(screening.context.collect_cv_processing_floor_max_ms, null);
  await service.waitForChatRun(screening.runId);
}

function testChatDetailRecoveryBudgetCapsModalRetry() {
  const counts = new Map();
  const first = consumeChatDetailRecoveryBudget(counts, "candidate-1");
  const second = consumeChatDetailRecoveryBudget(counts, "candidate-1");
  const independentCandidate = consumeChatDetailRecoveryBudget(counts, "candidate-2");

  assert.deepEqual(first, {
    allowed: true,
    previous_count: 0,
    count: 1,
    retry_limit: 1
  });
  assert.deepEqual(second, {
    allowed: false,
    previous_count: 1,
    count: 1,
    retry_limit: 1
  });
  assert.equal(independentCandidate.allowed, true);
  assert.equal(counts.get("candidate-1"), 1);
  assert.equal(counts.get("candidate-2"), 1);
}

function testChatEditorRetryIsLimitedToPreAction() {
  const mismatch = Object.assign(new Error("CHAT_EDITOR_MESSAGE_MISMATCH"), {
    code: "CHAT_EDITOR_MESSAGE_MISMATCH"
  });
  assert.equal(CHAT_EDITOR_PRE_ACTION_RETRY_LIMIT, 1);
  assert.equal(CHAT_EDITOR_PRE_ACTION_RETRY_SETTLE_MS, 1500);
  assert.equal(shouldRetryChatEditorPreAction(mismatch, { state: "pre_action" }, 0), true);
  assert.equal(shouldRetryChatEditorPreAction(mismatch, { state: "pre_action" }, 1), false);
  assert.equal(shouldRetryChatEditorPreAction(mismatch, { state: "greeting_send_in_flight" }, 0), false);
  assert.equal(shouldRetryChatEditorPreAction(mismatch, { state: "request_in_flight" }, 0), false);
  assert.equal(shouldRetryChatEditorPreAction(mismatch, { state: "outcome_unknown" }, 0), false);
  assert.equal(
    shouldRetryChatEditorPreAction(
      Object.assign(new Error("Connection closed"), { code: "CDP_CONNECTION_CLOSED" }),
      { state: "pre_action" },
      0
    ),
    false
  );
}

async function waitUntil(predicate, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for chat run service test condition");
}

async function testLifecycleDelegation() {
  const service = createChatRunService({
    idPrefix: "test_chat",
    workflow: async (options, runControl) => {
      assert.equal(options.targetUrl, "https://www.zhipin.com/web/chat/index");
      assert.equal(options.detailSource, "cascade");
      assert.equal(options.detailLimit, 1);
      assert.equal(options.listFallbackPoint, null);
      assert.equal(options.humanRestEnabled, true);
      for (let processed = 1; processed <= 20; processed += 1) {
        await runControl.waitIfPaused();
        runControl.throwIfCanceled();
        runControl.setPhase("test:chat-screening");
        runControl.updateProgress({
          card_count: 40,
          target_count: 20,
          processed,
          screened: processed,
          detail_opened: processed >= 1 ? 1 : 0
        });
        await runControl.sleep(25);
      }
      return { domain: "chat", processed: 20 };
    }
  });

  const started = service.startChatRun({
    client: { guarded: true },
    targetUrl: "https://www.zhipin.com/web/chat/index",
    criteria: "算法",
    maxCandidates: 20,
    detailLimit: 1,
    detailSource: "cascade",
    humanRestEnabled: true
  });
  assert.equal(started.context.domain, "chat");
  assert.equal(started.context.detail_source, "cascade");
  assert.equal(started.context.list_fallback_point, null);
  assert.equal(started.context.human_rest_enabled, true);
  assert.equal(started.progress.human_rest_enabled, true);

  await waitUntil(() => service.getChatRun(started.runId).progress.processed >= 2);
  service.pauseChatRun(started.runId);
  const paused = await waitUntil(() => {
    const snapshot = service.getChatRun(started.runId);
    return snapshot.status === RUN_STATUS_PAUSED && snapshot;
  });
  const pausedProgress = paused.progress.processed;
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.equal(service.getChatRun(started.runId).progress.processed, pausedProgress);

  service.resumeChatRun(started.runId);
  await waitUntil(() => service.getChatRun(started.runId).progress.processed > pausedProgress);
  service.cancelChatRun(started.runId);
  const final = await service.waitForChatRun(started.runId);
  assert.equal(final.status, RUN_STATUS_CANCELED);
}

function testChatResumeCaptureTarget() {
  assert.equal(captureNodeIdFromResumeState({
    content: { node_id: 101 },
    popup: { node_id: 202 },
    resumeIframe: { node_id: 303 }
  }), 101);
  assert.equal(captureNodeIdFromResumeState({
    content: { node_id: 101 },
    resumeIframe: { node_id: 303 }
  }), 101);
  assert.equal(captureNodeIdFromResumeState({
    resumeIframe: { node_id: 303 }
  }), 303);
  assert.equal(captureNodeIdFromResumeState({
    popup: { node_id: 202 }
  }), 202);
  assert.equal(captureNodeIdFromResumeState(null), null);
}

function testChatPreDetailAttachmentResumeSkipReason() {
  assert.equal(chatDetailSkipReasonFromReadyState({
    attachment_resume_enabled: true,
    has_attachment_resume: true
  }), "attachment_resume_already_available");
  assert.equal(chatDetailSkipReasonFromReadyState({
    attachment_resume_enabled: false,
    has_attachment_resume: true
  }), "");
  assert.equal(chatDetailSkipReasonFromReadyState({
    has_online_resume: true
  }), "");

  const error = makeChatResumeModalOpenBeforeCandidateClickError({ closed: false });
  assert.equal(error.code, "CHAT_RESUME_MODAL_OPEN_BEFORE_CANDIDATE_CLICK");
  assert.equal(error.close_result.closed, false);
  assert.equal(isChatResumeModalCloseFailureError(error), true);
  assert.equal(isChatResumeModalCloseFailureError(new Error("different")), false);

  const mismatch = makeChatCandidateSelectionMismatchError({
    ready: {
      expected_candidate_id: "expected-1",
      active_candidate_id: "active-2"
    }
  }, {
    id: "expected-1"
  });
  assert.equal(mismatch.code, "CHAT_ACTIVE_CANDIDATE_MISMATCH");
  assert.equal(mismatch.selection_ready_state.active_candidate_id, "active-2");
  assert.equal(isChatCandidateSelectionMismatchError(mismatch), true);
  assert.equal(isChatCandidateSelectionMismatchError(new Error("different")), false);

  const exactSelection = {
    ready: {
      ok: true,
      reason: "online_resume_probe_skipped",
      expected_candidate_id: "expected-1",
      active_candidate_id: "expected-1",
      candidate_selection_verified: true,
      activeCandidate: {
        node_id: 42,
        selector: ".geek-item.selected[data-id]",
        candidate_id: "expected-1",
        label: "候选人一",
        outer_html_length: 128
      }
    }
  };
  assert.equal(
    requireExactChatCandidateSelection(exactSelection, { id: "expected-1" }),
    exactSelection.ready
  );
  assert.deepEqual(compactChatCandidateSelectionReadyState(exactSelection.ready), {
    ok: true,
    reason: "online_resume_probe_skipped",
    elapsed_ms: null,
    expected_candidate_id: "expected-1",
    active_candidate_id: "expected-1",
    candidate_selection_verified: true,
    active_candidate: {
      node_id: 42,
      selector: ".geek-item.selected[data-id]",
      candidate_id: "expected-1",
      label: "候选人一",
      outer_html_length: 128
    }
  });
  const invalidSelections = [
    [{ ready: { ...exactSelection.ready, candidate_selection_verified: false } }, { id: "expected-1" }],
    [{ ready: { ...exactSelection.ready, expected_candidate_id: "other" } }, { id: "expected-1" }],
    [{ ready: { ...exactSelection.ready, active_candidate_id: "other" } }, { id: "expected-1" }],
    [{ ready: exactSelection.ready }, { id: "" }],
    [{ ready: null }, { id: "expected-1" }]
  ];
  for (const [selected, candidate] of invalidSelections) {
    assert.throws(
      () => requireExactChatCandidateSelection(selected, candidate),
      (error) => error?.code === "CHAT_ACTIVE_CANDIDATE_MISMATCH"
    );
  }

  const modalError = new Error("Chat online resume modal did not open");
  modalError.code = CHAT_ONLINE_RESUME_MODAL_NOT_OPEN_CODE;
  assert.equal(isChatOnlineResumeModalOpenFailureError(modalError), true);
  assert.equal(isChatOnlineResumeModalOpenFailureError(new Error("different")), false);
}

function testCollectCvModeDoesNotOpenOnlineResumeDetail() {
  assert.equal(shouldOpenOnlineResumeForChatDetail(), true);
  assert.equal(shouldOpenOnlineResumeForChatDetail({
    collectCvOnly: true
  }), false);
  assert.equal(shouldOpenOnlineResumeForChatDetail({
    collectCvOnly: false,
    detailResult: {
      cv_acquisition: {
        skipped: true,
        source: "online_cv_already_available"
      }
    }
  }), false);
}

function testCollectCvMissingOnlineResumeRequestsCv() {
  const candidate = {
    identity: {
      name: "missing-online-cv"
    }
  };
  const requestable = createCvCollectionScreening(candidate, {
    detailUnavailableReason: "collect_cv_missing_online_resume",
    preActionState: {
      has_online_resume: false,
      attachment_resume_enabled: false,
      ask_resume: {
        node_id: 1,
        disabled: false
      }
    }
  });
  assert.equal(requestable.status, "pass");
  assert.equal(requestable.passed, true);
  assert.deepEqual(requestable.reasons, ["collect_cv:collect_cv_missing_online_resume"]);

  const noButton = createCvCollectionScreening(candidate, {
    detailUnavailableReason: "online_resume_button_unavailable",
    preActionState: {
      has_online_resume: false,
      attachment_resume_enabled: false,
      ask_resume: {
        node_id: 1,
        disabled: false
      }
    }
  });
  assert.equal(noButton.status, "pass");
  assert.equal(noButton.passed, true);
  assert.deepEqual(noButton.reasons, ["collect_cv:online_resume_button_unavailable"]);

  const requestableDespiteOnlineProbe = createCvCollectionScreening(candidate, {
    detailUnavailableReason: "online_cv_already_available",
    preActionState: {
      has_online_resume: true,
      attachment_resume_enabled: false,
      ask_resume: {
        node_id: 1,
        disabled: false
      }
    }
  });
  assert.equal(requestableDespiteOnlineProbe.status, "pass");
  assert.equal(requestableDespiteOnlineProbe.passed, true);
  assert.deepEqual(requestableDespiteOnlineProbe.reasons, ["collect_cv:online_cv_already_available"]);

  const attachmentAvailable = createCvCollectionScreening(candidate, {
    detailUnavailableReason: "attachment_resume_already_available",
    preActionState: {
      has_online_resume: false,
      attachment_resume_enabled: true,
      ask_resume: {
        node_id: 1,
        disabled: false
      }
    }
  });
  assert.equal(attachmentAvailable.status, "skip");
  assert.equal(attachmentAvailable.passed, false);
  assert.deepEqual(attachmentAvailable.reasons, ["attachment_resume_already_available"]);

  const alreadyRequested = createCvCollectionScreening(candidate, {
    detailUnavailableReason: "collect_cv_missing_online_resume",
    preActionState: {
      has_online_resume: false,
      attachment_resume_enabled: false,
      already_requested_resume: true,
      ask_resume: {
        node_id: 1,
        disabled: false
      }
    }
  });
  assert.equal(alreadyRequested.status, "skip");
  assert.equal(alreadyRequested.passed, false);
  assert.deepEqual(alreadyRequested.reasons, ["resume_request_already_pending"]);

  const hasOnlineNoRequestControl = createCvCollectionScreening(candidate, {
    detailUnavailableReason: "collect_cv_request_candidate",
    preActionState: {
      has_online_resume: true,
      attachment_resume_enabled: false,
      ask_resume: {
        node_id: 1,
        disabled: true
      }
    }
  });
  assert.equal(hasOnlineNoRequestControl.status, "pass");
  assert.equal(hasOnlineNoRequestControl.passed, true);
  assert.deepEqual(hasOnlineNoRequestControl.reasons, ["collect_cv:collect_cv_request_candidate"]);
}

async function testFinalFailureScreenshotArtifact() {
  const imageOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-final-failure-"));
  let captured = false;
  const client = {
    Page: {
      async getFrameTree() {
        return {
          frameTree: {
            frame: {
              url: "https://www.zhipin.com/web/chat/index"
            }
          }
        };
      },
      async captureScreenshot() {
        captured = true;
        return {
          data: Buffer.from("x").toString("base64")
        };
      }
    }
  };
  const service = createChatRunService({
    idPrefix: "test_chat_failure",
    workflow: async () => {
      throw new Error("synthetic final failure");
    }
  });
  const started = service.startChatRun({
    client,
    criteria: "算法",
    maxCandidates: 1,
    imageOutputDir
  });
  const final = await service.waitForChatRun(started.runId);
  assert.equal(final.status, RUN_STATUS_FAILED);
  assert.equal(captured, true);
  assert.equal(final.checkpoint.final_failure_artifact.kind, "chat_final_failure_page");
  assert.equal(final.checkpoint.final_failure_artifact.page_state.is_chat_shell, true);
  const screenshot = final.checkpoint.final_failure_artifact.screenshot;
  assert.equal(screenshot.file_path, null);
  assert.equal(screenshot.persistence, "forbidden_uncropped_viewport");
  assert.deepEqual(fs.readdirSync(imageOutputDir), [], "final-failure capture must not persist viewport bytes");
  fs.rmSync(imageOutputDir, { recursive: true, force: true });
}

function testChatResultCountersPreserveCommittedRows() {
  const counters = countChatResultStatuses([
    {
      detail: {
        cv_acquisition: { skipped: false },
        llm_screening: { ok: true }
      },
      screening: {
        status: "pass",
        passed: true
      }
    },
    {
      detail: {
        cv_acquisition: {
          skipped: true,
          source: "resume_modal_close_failed:close_resume_modal"
        }
      },
      screening: {
        status: "skip",
        passed: false
      }
    }
  ]);

  assert.deepEqual(counters, {
    processed: 2,
    screened: 2,
    detail_opened: 1,
    llm_screened: 1,
    passed: 1,
    skipped: 1
  });
}

function testChatDomFallbackWaitPlan() {
  assert.deepEqual(resolveChatDomFallbackWait({
    normalizedDetailSource: "image",
    resumeDomTimeoutMs: 120000
  }), {
    skipped: false,
    timeout_ms: 3500,
    configured_timeout_ms: 120000,
    short_probe: true,
    reason: "forced_image_modal_probe"
  });

  const domPlan = resolveChatDomFallbackWait({
    normalizedDetailSource: "dom",
    resumeDomTimeoutMs: 120000
  });
  assert.equal(domPlan.timeout_ms, 120000);
  assert.equal(domPlan.short_probe, false);

  const firstProfileOnlyPlan = resolveChatDomFallbackWait({
    normalizedDetailSource: "cascade",
    parsedNetworkProfileCount: 2,
    waitPlan: { mode_before: "network" },
    resumeDomTimeoutMs: 120000
  });
  assert.equal(firstProfileOnlyPlan.timeout_ms, 3500);
  assert.equal(firstProfileOnlyPlan.short_probe, true);
  assert.equal(firstProfileOnlyPlan.reason, "profile_only_network_short_dom_probe");

  const imageModeProfileOnlyPlan = resolveChatDomFallbackWait({
    normalizedDetailSource: "cascade",
    parsedNetworkProfileCount: 2,
    waitPlan: { mode_before: "image" },
    resumeDomTimeoutMs: 120000
  });
  assert.equal(imageModeProfileOnlyPlan.timeout_ms, 1500);
  assert.equal(imageModeProfileOnlyPlan.short_probe, true);

  const imageModeNetworkMissPlan = resolveChatDomFallbackWait({
    normalizedDetailSource: "cascade",
    parsedNetworkProfileCount: 0,
    waitPlan: { mode_before: "image" },
    resumeDomTimeoutMs: 120000
  });
  assert.equal(imageModeNetworkMissPlan.timeout_ms, 2500);
  assert.equal(imageModeNetworkMissPlan.short_probe, true);
}

function testChatFullCvEvidenceGate() {
  const profileOnly = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [
        {
          ok: true,
          profile: {
            text: "姓名：王同学\n教育经历：浙江大学 本科\n亮点标签：Embedding",
            source_keys: {
              chat_geek_info: true,
              education_count: 1,
              work_count: 0
            }
          }
        }
      ],
      detail: {
        popup_text: "",
        content_text: "",
        resume_iframe_text: ""
      }
    },
    contentWait: {
      ok: true,
      skipped: true,
      reason: "network_profile_parsed_before_dom_wait",
      text_length: 0
    }
  });
  assert.equal(profileOnly.full_cv_acquired, false);
  assert.equal(profileOnly.network_profile_only_count, 1);
  assert.equal(profileOnly.network_full_cv_count, 0);

  const fullNetwork = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [
        {
          ok: true,
          profile: {
            text: "基础信息\n姓名：赵同学\n最高学历：硕士\n\n"
              + "个人总结\n长期参与大模型、检索排序、视觉理解和多模态算法实验，负责数据构建、模型训练、评估和误差分析。"
              + "熟悉深度学习、机器学习、Transformer、RAG、向量检索、图像识别和模型部署评测，能够独立完成算法项目闭环。\n\n"
              + "求职期望\n算法工程师 / 杭州 / 校招\n\n"
              + "工作经历\n1. 字节跳动 算法实习生 2025.06-2025.09，负责大模型检索增强、召回排序实验、特征分析和AB指标复盘。"
              + "2. 某实验室 科研助理 2024.09-2025.05，负责视觉语言模型数据清洗、训练脚本开发、实验记录和论文复现。\n\n"
              + "项目经历\n1. 多模态大模型问答系统，负责Embedding召回、重排模型训练、负样本构造、指标评估和上线前压测。"
              + "2. 计算机视觉缺陷检测项目，负责图像增强、检测模型训练、mAP评估、误检分析和模型蒸馏。"
              + "3. 三维重建科研项目，负责相机标定、点云配准、NeRF实验、可视化评估、失败样例归因和实验报告撰写。"
              + "4. 论文复现项目，复现视觉Transformer模型并完成消融实验，记录数据集划分、训练参数、指标变化和结论。\n\n"
              + "教育经历\n浙江大学 计算机科学与技术 硕士 2024-2027\n山东大学 软件工程 本科 2020-2024\n\n"
              + "校园经历\n参加智能车竞赛和机器学习课程项目，负责感知算法、路径规划实验、传感器数据清洗和答辩材料整理。\n\n"
              + "技能/亮点\nPyTorch、LLM、RAG、CV、3D视觉、检索排序、论文复现、模型评估、特征工程、AB实验、误差分析",
            source_keys: {
              geek_detail_info: true,
              project_count: 2,
              education_count: 2,
              work_count: 2,
              expectation_count: 1
            }
          }
        }
      ],
      detail: {}
    }
  });
  assert.equal(fullNetwork.full_cv_acquired, true);
  assert.equal(fullNetwork.source, "network");

  const shortGeekDetail = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [
        {
          ok: true,
          profile: {
            text: "基础信息\n姓名：陈同学\n教育经历\n浙江大学 硕士\n亮点标签\n大模型、视觉算法",
            source_keys: {
              geek_detail_info: true,
              education_count: 1,
              work_count: 0,
              project_count: 0
            }
          }
        }
      ],
      detail: {}
    },
    contentWait: {
      ok: true,
      skipped: true,
      reason: "network_profile_parsed_before_dom_wait",
      text_length: 0
    }
  });
  assert.equal(shortGeekDetail.full_cv_acquired, false);
  assert.equal(shortGeekDetail.network_profile_only_count, 1);
  assert.equal(shortGeekDetail.network_full_cv_count, 0);

  const domResume = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [],
      detail: {
        popup_text: "",
        content_text:
          "教育经历\n浙江大学 计算机科学 本科\n2021-2025\n\n"
          + "项目经历\n图像算法项目，负责模型训练与评估，包含数据处理、特征提取、模型迭代、误差分析、上线验证和论文复现。"
          + "项目中使用深度学习模型完成图像识别任务，持续调参并撰写实验报告。\n\n"
          + "工作经历\n算法实习，负责检索排序实验、指标监控、召回策略优化、AB实验复盘和模型效果评估。"
          + "在实习中参与候选集生成、特征工程和排序模型训练，沉淀了完整算法项目经验。",
        resume_iframe_text: ""
      }
    },
    contentWait: {
      ok: true,
      text_length: 200
    }
  });
  assert.equal(domResume.full_cv_acquired, true);
  assert.equal(domResume.source, "dom");

  const imageResume = summarizeChatFullCvEvidence({
    detailResult: {
      parsed_network_profiles: [
        {
          ok: true,
          profile: {
            text: "姓名：李同学",
            source_keys: { chat_geek_info: true }
          }
        }
      ],
      detail: {}
    },
    imageEvidence: {
      ok: true,
      coverage_complete: true,
      llm_file_paths: ["C:/tmp/cv.jpg"],
      llm_screenshot_count: 1
    }
  });
  assert.equal(imageResume.full_cv_acquired, true);
  assert.equal(imageResume.source, "image");
  assert.equal(imageResume.network_profile_only_count, 1);

  const incompleteImageResume = summarizeChatFullCvEvidence({
    imageEvidence: {
      ok: true,
      coverage_complete: false,
      screenshot_count: 4,
      file_paths: ["partial-page.jpg"],
      llm_file_paths: ["partial-page.jpg"]
    }
  });
  assert.equal(incompleteImageResume.full_cv_acquired, false);
  assert.equal(incompleteImageResume.image_full_cv, false);
  assert.equal(incompleteImageResume.image_summary.ok, false);
  assert.equal(hasScreenableChatFullCvEvidence({ full_cv_acquired: true }, {
    ok: true,
    coverage_complete: false,
    file_paths: ["partial-page.jpg"]
  }), false);
  assert.equal(hasScreenableChatFullCvEvidence({ full_cv_acquired: true }, {
    ok: true,
    coverage_complete: true,
    file_paths: ["complete-page.jpg"]
  }), true);
  assert.equal(hasScreenableChatFullCvEvidence({
    full_cv_acquired: true,
    source: "image"
  }, null), false);
  assert.equal(hasScreenableChatFullCvEvidence({
    full_cv_acquired: true,
    source: "image"
  }, {
    ok: true,
    coverage_complete: true,
    file_paths: []
  }), false);

  const unknownCaptureOutcome = new Error("Connection closed");
  unknownCaptureOutcome.cdp_method = "Page.captureScreenshot";
  unknownCaptureOutcome.cdp_outcome_unknown = true;
  unknownCaptureOutcome.cdp_replay_suppressed = true;
  assert.equal(isRecoverableChatImageCaptureError(unknownCaptureOutcome), true);
  assert.equal(isRecoverableChatImageCaptureError({
    cdp_method: "DOM.getBoxModel",
    cdp_outcome_unknown: true,
    cdp_replay_suppressed: true
  }), true);
}

testChatFullCvEvidenceGate();
testExactExistingRequestStateReconcilesUnknownJournal();
testExistingRequestStateReconciliationFailsClosedWithoutExactEvidence();
testProtectedRequestOutcomeUnknownIsSkippedWithoutReplay();
await testCollectCvProcessingFloorHelpers();
await testCollectCvProcessingFloorServiceContract();
testChatDetailRecoveryBudgetCapsModalRetry();
testChatEditorRetryIsLimitedToPreAction();
testChatResumeCaptureTarget();
testChatPreDetailAttachmentResumeSkipReason();
testCollectCvModeDoesNotOpenOnlineResumeDetail();
testCollectCvMissingOnlineResumeRequestsCv();
testChatResultCountersPreserveCommittedRows();
testChatDomFallbackWaitPlan();
await testLifecycleDelegation();
await testFinalFailureScreenshotArtifact();

console.log("chat run service tests passed");
