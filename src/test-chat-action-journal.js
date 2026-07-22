#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHAT_ACTION_STATES,
  createChatActionIdentity,
  createChatActionJournal,
  hashChatActionGreeting
} from "./domains/chat/action-journal.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "boss-chat-action-journal-"));
}

function assertErrorCode(fn, expectedCode) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, expectedCode);
    return true;
  });
}

function sequenceClock(values) {
  const queue = [...values];
  return () => {
    assert.ok(queue.length, "journal clock was called more times than expected");
    return queue.shift();
  };
}

function testStableIdentityRequiresScopeAndCandidateId() {
  const first = createChatActionIdentity({
    scope: "boss-account-a/profile-default",
    candidateId: "candidate-123"
  });
  const same = createChatActionIdentity({
    scope: "boss-account-a/profile-default",
    candidateId: "candidate-123"
  });
  const otherScope = createChatActionIdentity({
    scope: "boss-account-b/profile-default",
    candidateId: "candidate-123"
  });
  const otherCandidate = createChatActionIdentity({
    scope: "boss-account-a/profile-default",
    candidateId: "candidate-456"
  });

  assert.deepEqual(first, same);
  assert.notEqual(first.actionKey, otherScope.actionKey);
  assert.notEqual(first.actionKey, otherCandidate.actionKey);
  assert.equal(first.actionKey.length, 64);
  assert.equal(first.scopeSha256.length, 64);
  assertErrorCode(
    () => createChatActionIdentity({ scope: "scope", candidateId: "  " }),
    "CHAT_ACTION_CANDIDATE_ID_REQUIRED"
  );
  assertErrorCode(
    () => createChatActionIdentity({ scope: "", candidateId: "candidate-123" }),
    "CHAT_ACTION_SCOPE_REQUIRED"
  );
}

function testGreetingIsHashedAndNeverStored() {
  const baseDir = makeTempDir();
  try {
    const greeting = "private greeting that must not be persisted";
    const journal = createChatActionJournal({
      baseDir,
      now: () => "2026-07-19T12:00:00.000Z"
    });
    const result = journal.transition({
      scope: "account-a/profile-default",
      candidateId: "candidate-secret-test",
      state: "pre_action",
      runId: "run-a",
      greeting
    });

    assert.equal(result.record.greeting_sha256, hashChatActionGreeting(greeting));
    assert.equal(Object.hasOwn(result.record, "greeting"), false);
    const disk = fs.readFileSync(result.file_path, "utf8");
    assert.equal(disk.includes(greeting), false);
    assert.equal(disk.includes(result.record.greeting_sha256), true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testFullStateSequenceIsSharedAcrossRunIdsAndIdempotent() {
  const baseDir = makeTempDir();
  try {
    const journal = createChatActionJournal({
      baseDir,
      now: sequenceClock([
        "2026-07-19T12:00:00.000Z",
        "2026-07-19T12:00:01.000Z",
        "2026-07-19T12:00:02.000Z",
        "2026-07-19T12:00:03.000Z",
        "2026-07-19T12:00:04.000Z"
      ])
    });
    const input = {
      scope: "account-a/profile-default",
      candidateId: "candidate-shared",
      greeting: "Hi, please share your CV"
    };

    const preAction = journal.transition({
      ...input,
      state: "pre_action",
      runId: "run-one"
    });
    const idempotent = journal.transition({
      ...input,
      state: "pre_action",
      runId: "run-two"
    });
    assert.equal(idempotent.changed, false);
    assert.equal(idempotent.idempotent, true);
    assert.deepEqual(idempotent.record, preAction.record);

    const greetingInFlight = journal.transition({
      ...input,
      state: "greeting_send_in_flight",
      runId: "run-two",
      evidence: {
        greeting_baseline_count: 2,
        greeting_evidence_readable: true,
        ignored_secret: "must-not-persist"
      }
    });
    assert.equal(greetingInFlight.record.evidence.greeting_baseline_count, 2);
    assert.equal(greetingInFlight.record.evidence.greeting_evidence_readable, true);
    assert.equal(greetingInFlight.record.evidence.ignored_secret, undefined);
    assert.doesNotMatch(JSON.stringify(greetingInFlight.record), /must-not-persist/);
    journal.transition({ ...input, state: "greeting_confirmed", runId: "run-two" });
    journal.transition({ ...input, state: "request_in_flight", runId: "run-two" });
    const confirmed = journal.transition({
      ...input,
      state: "request_confirmed",
      runId: "run-two"
    });

    assert.equal(confirmed.record.state, "request_confirmed");
    assert.deepEqual(confirmed.record.run_ids, ["run-one", "run-two"]);
    assert.deepEqual(
      confirmed.record.history.map((entry) => entry.state),
      [
        "pre_action",
        "greeting_send_in_flight",
        "greeting_confirmed",
        "request_in_flight",
        "request_confirmed"
      ]
    );
    assert.equal(confirmed.record.created_at, "2026-07-19T12:00:00.000Z");
    assert.equal(confirmed.record.updated_at, "2026-07-19T12:00:04.000Z");

    const secondFactory = createChatActionJournal({ baseDir });
    assert.deepEqual(secondFactory.read(input), confirmed.record);
    assert.equal(secondFactory.entryPath(input), confirmed.file_path);

    const leftovers = fs.readdirSync(baseDir).filter((name) => (
      name.endsWith(".tmp") || name.endsWith(".lock")
    ));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testUnknownOutcomeCanOnlyResolveItsInFlightEffect() {
  const baseDir = makeTempDir();
  try {
    const journal = createChatActionJournal({ baseDir });
    const greetingUnknown = {
      scope: "account-a/profile-default",
      candidateId: "candidate-greeting-unknown",
      greeting: "hello"
    };
    journal.transition({ ...greetingUnknown, state: "pre_action", runId: "run-a" });
    journal.transition({ ...greetingUnknown, state: "greeting_send_in_flight", runId: "run-a" });
    journal.transition({ ...greetingUnknown, state: "outcome_unknown", runId: "run-a" });
    assertErrorCode(
      () => journal.transition({ ...greetingUnknown, state: "request_confirmed", runId: "run-b" }),
      "CHAT_ACTION_TRANSITION_INVALID"
    );
    const greetingAssumedSent = journal.transition({
      ...greetingUnknown,
      state: "greeting_assumed_sent",
      runId: "run-b",
      evidence: {
        assumption_policy: "at_most_once_assume_sent",
        confirmation_status: "not_observed",
        protected_from_replay: true,
        input_dispatched: true,
        ignored_secret: "must-not-persist"
      }
    });
    assert.equal(greetingAssumedSent.record.state, "greeting_assumed_sent");
    assert.equal(greetingAssumedSent.record.schema_version, 1);
    assert.equal(
      greetingAssumedSent.record.evidence.assumption_policy,
      "at_most_once_assume_sent"
    );
    assert.equal(greetingAssumedSent.record.evidence.confirmation_status, "not_observed");
    assert.equal(greetingAssumedSent.record.evidence.protected_from_replay, true);
    assert.equal(greetingAssumedSent.record.evidence.input_dispatched, true);
    assert.equal(greetingAssumedSent.record.evidence.ignored_secret, undefined);
    assert.doesNotMatch(JSON.stringify(greetingAssumedSent.record), /must-not-persist/);
    assertErrorCode(
      () => journal.transition({ ...greetingUnknown, state: "request_in_flight", runId: "run-b" }),
      "CHAT_ACTION_TRANSITION_INVALID"
    );
    assertErrorCode(
      () => journal.transition({ ...greetingUnknown, state: "outcome_unknown", runId: "run-b" }),
      "CHAT_ACTION_TRANSITION_INVALID"
    );
    const greetingResolved = journal.transition({
      ...greetingUnknown,
      state: "greeting_confirmed",
      runId: "run-b",
      evidence: { confirmation_status: "passively_confirmed" }
    });
    assert.equal(greetingResolved.record.state, "greeting_confirmed");
    assert.deepEqual(
      greetingResolved.record.history.map((entry) => entry.state),
      [
        "pre_action",
        "greeting_send_in_flight",
        "outcome_unknown",
        "greeting_assumed_sent",
        "greeting_confirmed"
      ]
    );

    const requestUnknown = {
      scope: "account-a/profile-default",
      candidateId: "candidate-request-unknown",
      greeting: "hello"
    };
    journal.transition({ ...requestUnknown, state: "pre_action", runId: "run-a" });
    journal.transition({ ...requestUnknown, state: "greeting_send_in_flight", runId: "run-a" });
    journal.transition({ ...requestUnknown, state: "greeting_confirmed", runId: "run-a" });
    journal.transition({ ...requestUnknown, state: "request_in_flight", runId: "run-a" });
    journal.transition({ ...requestUnknown, state: "outcome_unknown", runId: "run-a" });
    assertErrorCode(
      () => journal.transition({ ...requestUnknown, state: "greeting_confirmed", runId: "run-b" }),
      "CHAT_ACTION_TRANSITION_INVALID"
    );
    assertErrorCode(
      () => journal.transition({ ...requestUnknown, state: "greeting_assumed_sent", runId: "run-b" }),
      "CHAT_ACTION_TRANSITION_INVALID"
    );
    const requestResolved = journal.transition({
      ...requestUnknown,
      state: "request_confirmed",
      runId: "run-b"
    });
    assert.equal(requestResolved.record.state, "request_confirmed");
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testGreetingInFlightCanBecomeAssumedSentAndOnlyThenConfirmed() {
  const baseDir = makeTempDir();
  try {
    const journal = createChatActionJournal({ baseDir });
    const input = {
      scope: "account-a/profile-default",
      candidateId: "candidate-direct-assumed-sent",
      greeting: "hello",
      runId: "run-a"
    };
    journal.transition({ ...input, state: "pre_action" });
    journal.transition({ ...input, state: "greeting_send_in_flight" });
    const assumed = journal.transition({
      ...input,
      state: "greeting_assumed_sent",
      evidence: {
        assumption_policy: "at_most_once_assume_sent",
        confirmation_status: "readback_unverified",
        protected_from_replay: true,
        input_dispatched: true
      }
    });
    assert.equal(assumed.record.state, "greeting_assumed_sent");

    const idempotent = journal.transition({
      ...input,
      state: "greeting_assumed_sent",
      runId: "run-b"
    });
    assert.equal(idempotent.changed, false);
    assert.equal(idempotent.idempotent, true);
    assert.deepEqual(idempotent.record, assumed.record);
    assertErrorCode(
      () => journal.transition({ ...input, state: "request_in_flight", runId: "run-b" }),
      "CHAT_ACTION_TRANSITION_INVALID"
    );
    assertErrorCode(
      () => journal.transition({ ...input, state: "outcome_unknown", runId: "run-b" }),
      "CHAT_ACTION_TRANSITION_INVALID"
    );

    const confirmed = journal.transition({
      ...input,
      state: "greeting_confirmed",
      runId: "run-b",
      evidence: { confirmation_status: "passively_confirmed" }
    });
    assert.equal(confirmed.record.state, "greeting_confirmed");
    assert.deepEqual(
      confirmed.record.history.map((entry) => entry.state),
      [
        "pre_action",
        "greeting_send_in_flight",
        "greeting_assumed_sent",
        "greeting_confirmed"
      ]
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testInvalidTransitionsAndGreetingConflictsFailClosed() {
  const baseDir = makeTempDir();
  try {
    const journal = createChatActionJournal({ baseDir });
    const input = {
      scope: "account-a/profile-default",
      candidateId: "candidate-invalid",
      greeting: "first greeting",
      runId: "run-a"
    };

    assertErrorCode(
      () => journal.transition({ ...input, state: "greeting_send_in_flight" }),
      "CHAT_ACTION_TRANSITION_INVALID"
    );
    assertErrorCode(
      () => journal.transition({ ...input, state: "not-a-state" }),
      "CHAT_ACTION_STATE_INVALID"
    );
    assertErrorCode(
      () => journal.transition({
        scope: input.scope,
        candidateId: "candidate-no-greeting",
        state: "pre_action",
        runId: "run-a"
      }),
      "CHAT_ACTION_GREETING_REQUIRED"
    );

    journal.transition({ ...input, state: "pre_action" });
    assertErrorCode(
      () => journal.transition({
        ...input,
        greeting: "different greeting",
        state: "pre_action"
      }),
      "CHAT_ACTION_GREETING_HASH_CONFLICT"
    );
    journal.transition({ ...input, state: "greeting_send_in_flight" });
    journal.transition({ ...input, state: "greeting_confirmed" });
    assertErrorCode(
      () => journal.transition({ ...input, state: "request_confirmed" }),
      "CHAT_ACTION_TRANSITION_INVALID"
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testCorruptionAndConcurrentWriterLockFailClosed() {
  const baseDir = makeTempDir();
  try {
    const journal = createChatActionJournal({
      baseDir,
      lockOptions: {
        acquireTimeoutMs: 0,
        sleep: () => {}
      }
    });
    const corruptInput = {
      scope: "account-a/profile-default",
      candidateId: "candidate-corrupt"
    };
    const corruptPath = journal.entryPath(corruptInput);
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, "{broken", "utf8");
    assertErrorCode(() => journal.read(corruptInput), "CHAT_ACTION_JOURNAL_CORRUPT");

    const lockedInput = {
      scope: "account-a/profile-default",
      candidateId: "candidate-locked",
      greeting: "hello",
      state: "pre_action",
      runId: "run-a"
    };
    const lockedPath = journal.entryPath(lockedInput);
    fs.writeFileSync(`${lockedPath}.lock`, "99999\n", "utf8");
    assertErrorCode(
      () => journal.transition(lockedInput),
      "CHAT_ACTION_JOURNAL_BUSY"
    );
    assert.equal(fs.existsSync(lockedPath), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function writeLockFile(lockPath, {
  pid = 999_999_999,
  token = "stale-lock-token",
  released = false,
  ageMs = 60_000
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    schema_version: 1,
    pid,
    token,
    released
  })}\n`, "utf8");
  const timestamp = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, timestamp, timestamp);
}

function testStaleLockRecoveryRequiresOldAgeAndProvablyDeadPid() {
  const baseDir = makeTempDir();
  try {
    const journal = createChatActionJournal({
      baseDir,
      lockOptions: {
        acquireTimeoutMs: 0,
        staleMinAgeMs: 5_000,
        sleep: () => {},
        isProcessAlive: () => false
      }
    });
    const staleInput = {
      scope: "account-a/profile-default",
      candidateId: "candidate-stale-lock",
      greeting: "hello",
      state: "pre_action",
      runId: "run-a"
    };
    const stalePath = `${journal.entryPath(staleInput)}.lock`;
    writeLockFile(stalePath, { ageMs: 60_000 });
    const recovered = journal.transition(staleInput);
    assert.equal(recovered.record.state, "pre_action");
    assert.equal(fs.existsSync(stalePath), false);

    const freshInput = {
      ...staleInput,
      candidateId: "candidate-fresh-dead-lock"
    };
    const freshPath = `${journal.entryPath(freshInput)}.lock`;
    writeLockFile(freshPath, { ageMs: 0 });
    assertErrorCode(
      () => journal.transition(freshInput),
      "CHAT_ACTION_JOURNAL_BUSY"
    );
    assert.equal(fs.existsSync(journal.entryPath(freshInput)), false);

    const liveJournal = createChatActionJournal({
      baseDir,
      lockOptions: {
        acquireTimeoutMs: 0,
        staleMinAgeMs: 5_000,
        sleep: () => {},
        isProcessAlive: () => true
      }
    });
    const liveInput = {
      ...staleInput,
      candidateId: "candidate-live-old-lock"
    };
    const livePath = `${liveJournal.entryPath(liveInput)}.lock`;
    writeLockFile(livePath, { ageMs: 60_000 });
    assertErrorCode(
      () => liveJournal.transition(liveInput),
      "CHAT_ACTION_JOURNAL_BUSY"
    );
    assert.equal(fs.existsSync(liveJournal.entryPath(liveInput)), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testTransientWindowsRenameAndLockUnlinkErrorsAreRetried() {
  const baseDir = makeTempDir();
  const originalRenameSync = fs.renameSync;
  const originalUnlinkSync = fs.unlinkSync;
  let renameFailures = 2;
  let lockUnlinkFailures = 2;
  let sleepCalls = 0;
  try {
    fs.renameSync = (...args) => {
      if (renameFailures > 0) {
        renameFailures -= 1;
        const error = new Error("transient Windows rename contention");
        error.code = "EPERM";
        throw error;
      }
      return originalRenameSync(...args);
    };
    fs.unlinkSync = (target, ...args) => {
      if (String(target).endsWith(".lock") && lockUnlinkFailures > 0) {
        lockUnlinkFailures -= 1;
        const error = new Error("transient Windows unlink contention");
        error.code = "EACCES";
        throw error;
      }
      return originalUnlinkSync(target, ...args);
    };
    const journal = createChatActionJournal({
      baseDir,
      lockOptions: {
        fileOperationAttempts: 4,
        fileOperationRetryMinMs: 0,
        fileOperationRetryMaxMs: 0,
        sleep: () => { sleepCalls += 1; }
      }
    });
    const result = journal.transition({
      scope: "account-a/profile-default",
      candidateId: "candidate-windows-retry",
      greeting: "hello",
      state: "pre_action",
      runId: "run-a"
    });
    assert.equal(result.record.state, "pre_action");
    assert.equal(renameFailures, 0);
    assert.equal(lockUnlinkFailures, 0);
    assert.equal(sleepCalls, 4);
    assert.equal(fs.existsSync(`${result.file_path}.lock`), false);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.unlinkSync = originalUnlinkSync;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testTransientExistingLockUsesBoundedWaitAndThenAcquires() {
  const baseDir = makeTempDir();
  const originalOpenSync = fs.openSync;
  let transientExists = 2;
  let waitCalls = 0;
  try {
    const journal = createChatActionJournal({
      baseDir,
      lockOptions: {
        acquireTimeoutMs: 1_000,
        retryMinMs: 0,
        retryMaxMs: 0,
        sleep: () => { waitCalls += 1; }
      }
    });
    const input = {
      scope: "account-a/profile-default",
      candidateId: "candidate-transient-eexist",
      greeting: "hello",
      state: "pre_action",
      runId: "run-a"
    };
    const lockPath = `${journal.entryPath(input)}.lock`;
    fs.openSync = (target, flags, ...args) => {
      if (target === lockPath && flags === "wx" && transientExists > 0) {
        transientExists -= 1;
        const error = new Error("transient lock visibility");
        error.code = "EEXIST";
        throw error;
      }
      return originalOpenSync(target, flags, ...args);
    };
    const result = journal.transition(input);
    assert.equal(result.record.state, "pre_action");
    assert.equal(transientExists, 0);
    assert.equal(waitCalls, 2);
  } finally {
    fs.openSync = originalOpenSync;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testExhaustedLockCleanupDoesNotInvalidateCommittedTransition() {
  const baseDir = makeTempDir();
  const originalUnlinkSync = fs.unlinkSync;
  try {
    fs.unlinkSync = (target, ...args) => {
      if (String(target).endsWith(".lock")) {
        const error = new Error("persistent Windows lock cleanup contention");
        error.code = "EPERM";
        throw error;
      }
      return originalUnlinkSync(target, ...args);
    };
    const journal = createChatActionJournal({
      baseDir,
      lockOptions: {
        fileOperationAttempts: 2,
        fileOperationRetryMinMs: 0,
        fileOperationRetryMaxMs: 0,
        acquireTimeoutMs: 0,
        sleep: () => {}
      }
    });
    const input = {
      scope: "account-a/profile-default",
      candidateId: "candidate-released-lock-recovery",
      greeting: "hello",
      runId: "run-a"
    };
    const committed = journal.transition({ ...input, state: "pre_action" });
    const lockPath = `${committed.file_path}.lock`;
    assert.equal(committed.record.state, "pre_action");
    assert.equal(fs.existsSync(lockPath), true);
    const leftover = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(leftover.released, true);

    fs.unlinkSync = originalUnlinkSync;
    const advanced = journal.transition({
      ...input,
      state: "greeting_send_in_flight",
      expectedRevision: committed.record.revision
    });
    assert.equal(advanced.record.state, "greeting_send_in_flight");
    assert.equal(advanced.record.revision, 2);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

function testRevisionCasSurvivesFixedClockAndLegacyRecord() {
  const baseDir = makeTempDir();
  try {
    const fixedNow = "2026-07-21T03:00:00.000Z";
    const journal = createChatActionJournal({
      baseDir,
      now: () => fixedNow
    });
    const input = {
      scope: "account-a/profile-default",
      candidateId: "candidate-fixed-clock-cas",
      greeting: "hello",
      runId: "run-a"
    };
    const preAction = journal.transition({ ...input, state: "pre_action" });
    assert.equal(preAction.record.revision, 1);
    const firstClaim = journal.transition({
      ...input,
      state: "greeting_send_in_flight",
      expectedRevision: preAction.record.revision,
      expectedUpdatedAt: preAction.record.updated_at
    });
    assert.equal(firstClaim.changed, true);
    assert.equal(firstClaim.record.revision, 2);
    assert.equal(firstClaim.record.updated_at, preAction.record.updated_at);
    assertErrorCode(
      () => journal.transition({
        ...input,
        state: "greeting_send_in_flight",
        recordIdempotent: true,
        expectedRevision: preAction.record.revision,
        expectedUpdatedAt: preAction.record.updated_at
      }),
      "CHAT_ACTION_JOURNAL_CONCURRENT_UPDATE"
    );

    const legacyInput = {
      scope: "account-a/profile-default",
      candidateId: "candidate-legacy-no-revision",
      greeting: "hello",
      runId: "run-a"
    };
    const legacy = journal.transition({ ...legacyInput, state: "pre_action" });
    const raw = JSON.parse(fs.readFileSync(legacy.file_path, "utf8"));
    delete raw.revision;
    fs.writeFileSync(legacy.file_path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const migratedRead = journal.read(legacyInput);
    assert.equal(migratedRead.revision, 1);
    const migratedTransition = journal.transition({
      ...legacyInput,
      state: "greeting_send_in_flight",
      expectedRevision: migratedRead.revision
    });
    assert.equal(migratedTransition.record.revision, 2);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

assert.deepEqual(CHAT_ACTION_STATES, [
  "pre_action",
  "greeting_send_in_flight",
  "greeting_assumed_sent",
  "greeting_confirmed",
  "request_in_flight",
  "request_confirmed",
  "outcome_unknown"
]);
testStableIdentityRequiresScopeAndCandidateId();
testGreetingIsHashedAndNeverStored();
testFullStateSequenceIsSharedAcrossRunIdsAndIdempotent();
testUnknownOutcomeCanOnlyResolveItsInFlightEffect();
testGreetingInFlightCanBecomeAssumedSentAndOnlyThenConfirmed();
testInvalidTransitionsAndGreetingConflictsFailClosed();
testCorruptionAndConcurrentWriterLockFailClosed();
testStaleLockRecoveryRequiresOldAgeAndProvablyDeadPid();
testTransientWindowsRenameAndLockUnlinkErrorsAreRetried();
testTransientExistingLockUsesBoundedWaitAndThenAcquires();
testExhaustedLockCleanupDoesNotInvalidateCommittedTransition();
testRevisionCasSurvivesFixedClockAndLegacyRecord();

console.log("chat action journal tests passed");
