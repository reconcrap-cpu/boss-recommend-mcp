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
    const greetingResolved = journal.transition({
      ...greetingUnknown,
      state: "greeting_confirmed",
      runId: "run-b"
    });
    assert.equal(greetingResolved.record.state, "greeting_confirmed");

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
    const journal = createChatActionJournal({ baseDir });
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

assert.deepEqual(CHAT_ACTION_STATES, [
  "pre_action",
  "greeting_send_in_flight",
  "greeting_confirmed",
  "request_in_flight",
  "request_confirmed",
  "outcome_unknown"
]);
testStableIdentityRequiresScopeAndCandidateId();
testGreetingIsHashedAndNeverStored();
testFullStateSequenceIsSharedAcrossRunIdsAndIdempotent();
testUnknownOutcomeCanOnlyResolveItsInFlightEffect();
testInvalidTransitionsAndGreetingConflictsFailClosed();
testCorruptionAndConcurrentWriterLockFailClosed();

console.log("chat action journal tests passed");
