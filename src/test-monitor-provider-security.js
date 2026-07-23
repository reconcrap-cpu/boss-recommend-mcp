import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRunCommandResultV1 } from "@reconcrap/recruiting-run-monitor-contract";

const testBase = path.resolve(
  process.env.BOSS_MONITOR_PROVIDER_TEST_ROOT
  || path.join(os.tmpdir(), "boss-monitor-provider-security")
);
fs.mkdirSync(testBase, { recursive: true });
const testRoot = fs.mkdtempSync(path.join(testBase, "case-"));
if (path.dirname(testRoot) !== testBase) {
  throw new Error("Refusing to use a monitor provider test root outside the configured base");
}

const recommendHome = path.join(testRoot, "boss-recommend");
const recruitHome = path.join(testRoot, "boss-recruit");
const monitorHome = path.join(testRoot, "boss-monitor-projection");
process.env.BOSS_RECOMMEND_HOME = recommendHome;
process.env.BOSS_RECRUIT_HOME = recruitHome;
process.env.BOSS_MONITOR_HOME = monitorHome;
process.env.RECRUITING_MONITOR_HOME = path.join(testRoot, "recruiting-monitor");
process.env.BOSS_MONITORING_ENABLED = "true";

const {
  createBossMonitorSourceMarker,
  getBossMonitorRunDir,
  writeBossMonitorProjection
} = await import("./monitor/projection.js");
const {
  createBossRecruitingRunProvider
} = await import("./monitor-provider.js");
const {
  createCandidateResultJournal
} = await import("./core/run/candidate-result-journal.js");

const sources = new Map();
const calls = [];

function sourceKey(kind, runId) {
  return `${kind}:${runId}`;
}

function createSource(kind, runId) {
  const now = new Date().toISOString();
  const source = {
    run_id: runId,
    state: "running",
    stage: `${kind}:screening`,
    started_at: now,
    updated_at: now,
    heartbeat_at: now,
    pid: process.pid,
    monitoring_v1: createBossMonitorSourceMarker(now),
    progress: {
      target_count: 5,
      processed: 0,
      screened: 0,
      passed: 0,
      skipped: 0,
      greet_count: 0
    },
    control: {
      pause_requested: false,
      cancel_requested: false
    }
  };
  sources.set(sourceKey(kind, runId), source);
  const snapshot = writeBossMonitorProjection(kind, source, {
    type: "fixture",
    v1_created: true
  });
  assert.ok(snapshot, `expected a ${kind} monitor fixture`);
  return {
    provider: "boss",
    kind,
    run_id: runId
  };
}

function fakeTool(kind, command) {
  return async ({ args }) => {
    const key = sourceKey(kind, args.run_id);
    const current = sources.get(key);
    assert.ok(current, `missing fake source for ${key}`);
    calls.push({ kind, command, run_id: args.run_id });
    if (args.run_id === "concurrent-recommend") {
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    if (args.run_id.includes("path-error-recommend")) {
      throw new Error(
        `Unable to apply ${command} using ${path.join(recommendHome, "private", "control.json")}`
      );
    }
    const next = {
      ...current,
      updated_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      control: {
        ...current.control,
        pause_requested: command === "pause",
        cancel_requested: command === "cancel"
      }
    };
    sources.set(key, next);
    return {
      status: `${command.toUpperCase()}_REQUESTED`,
      ...(args.run_id === "path-result-recommend"
        ? {
            message: `Applied command through ${path.join(
              recommendHome,
              "private",
              "command-result.json"
            )}`
          }
        : {}),
      run: next
    };
  };
}

const fakeModules = {
  recommend: {
    pauseRecommendPipelineRunTool: fakeTool("recommend", "pause"),
    resumeRecommendPipelineRunTool: fakeTool("recommend", "resume"),
    cancelRecommendPipelineRunTool: fakeTool("recommend", "cancel")
  },
  search: {
    pauseRecruitPipelineRunTool: fakeTool("search", "pause"),
    resumeRecruitPipelineRunTool: fakeTool("search", "resume"),
    cancelRecruitPipelineRunTool: fakeTool("search", "cancel")
  },
  chat: {
    pauseBossChatRunTool: fakeTool("chat", "pause"),
    resumeBossChatRunTool: fakeTool("chat", "resume"),
    cancelBossChatRunTool: fakeTool("chat", "cancel")
  }
};

const provider = createBossRecruitingRunProvider({
  watchIntervalMs: 20,
  legacyModuleLoader: async (kind) => {
    const module = fakeModules[kind];
    assert.ok(module, `unexpected fake workflow module request: ${kind}`);
    return module;
  }
});

async function executeAtCurrentRevision(ref, command, idempotencyKey) {
  const snapshot = await provider.getSnapshot(ref);
  return provider.executeCommand(ref, {
    command,
    idempotency_key: idempotencyKey,
    expected_revision: snapshot.revision
  });
}

function commandRequestFingerprint(ref, command, expectedRevision) {
  return crypto.createHash("sha256").update(JSON.stringify({
    ref,
    command,
    expected_revision: expectedRevision
  })).digest("hex");
}

function seedOrphanCommand(ref, command, idempotencyKey, expectedRevision, {
  claim = true,
  claimPatch = {}
} = {}) {
  const commandDir = path.join(
    getBossMonitorRunDir(ref.kind, ref.run_id),
    ".commands"
  );
  const digest = crypto.createHash("sha256").update(idempotencyKey).digest("hex");
  const fingerprint = commandRequestFingerprint(ref, command, expectedRevision);
  const requestPath = path.join(commandDir, `${digest}.request.json`);
  const resultPath = path.join(commandDir, `${digest}.json`);
  const revisionPath = path.join(
    commandDir,
    ".revisions",
    `${expectedRevision}.json`
  );
  fs.mkdirSync(path.dirname(revisionPath), { recursive: true });
  fs.writeFileSync(requestPath, `${JSON.stringify({
    schema_version: 1,
    ref,
    command,
    idempotency_key: idempotencyKey,
    expected_revision: expectedRevision,
    fingerprint,
    recorded_at: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  if (claim) {
    fs.writeFileSync(revisionPath, `${JSON.stringify({
      schema_version: 1,
      revision: expectedRevision,
      fingerprint,
      idempotency_key: idempotencyKey,
      command,
      claimed_at: new Date().toISOString(),
      ...claimPatch
    }, null, 2)}\n`, "utf8");
  }
  return { commandDir, requestPath, resultPath, revisionPath };
}

function projectSource(ref, patch = {}) {
  const key = sourceKey(ref.kind, ref.run_id);
  const current = sources.get(key);
  assert.ok(current, `missing fake source for ${key}`);
  const now = new Date().toISOString();
  const next = {
    ...current,
    ...patch,
    updated_at: now,
    heartbeat_at: now,
    control: {
      ...current.control,
      ...(patch.control || {})
    }
  };
  sources.set(key, next);
  return writeBossMonitorProjection(ref.kind, next, {
    type: "fixture"
  });
}

try {
  for (const kind of ["recommend", "search", "chat"]) {
    const ref = createSource(kind, `routing-${kind}`);
    for (const command of ["pause", "resume", "cancel"]) {
      const before = calls.length;
      const result = await executeAtCurrentRevision(
        ref,
        command,
        `route-${kind}-${command}`
      );
      assertRunCommandResultV1(result);
      assert.equal(result.status, "accepted");
      assert.equal(result.command, command);
      assert.deepEqual(calls[before], {
        kind,
        command,
        run_id: ref.run_id
      });
      assert.equal(calls.length, before + 1);
    }
    assert.equal(
      calls.filter((entry) => entry.run_id === ref.run_id).length,
      3,
      `${kind} should route each control exactly once`
    );
  }

  const idempotentRef = createSource("recommend", "idempotent-recommend");
  const idempotentRevision = (await provider.getSnapshot(idempotentRef)).revision;
  const idempotentCommand = {
    command: "pause",
    idempotency_key: "bound-request-key",
    expected_revision: idempotentRevision
  };
  const beforeIdempotent = calls.length;
  const first = await provider.executeCommand(idempotentRef, idempotentCommand);
  const duplicate = await provider.executeCommand(idempotentRef, idempotentCommand);
  assertRunCommandResultV1(first);
  assert.deepEqual(duplicate, first);
  assert.equal(calls.length, beforeIdempotent + 1);

  const observedOrphanRef = createSource("recommend", "orphan-observed-recommend");
  const observedOrphanRevision = (await provider.getSnapshot(observedOrphanRef)).revision;
  const observedOrphanInput = {
    command: "pause",
    idempotency_key: "orphan-observed-key",
    expected_revision: observedOrphanRevision
  };
  const observedOrphanPaths = seedOrphanCommand(
    observedOrphanRef,
    observedOrphanInput.command,
    observedOrphanInput.idempotency_key,
    observedOrphanInput.expected_revision
  );
  projectSource(observedOrphanRef, {
    control: {
      pause_requested: true,
      pause_requested_at: new Date().toISOString()
    }
  });
  const beforeObservedRecovery = calls.length;
  const observedSnapshot = await provider.getSnapshot(observedOrphanRef);
  const observedNewKey = await provider.executeCommand(observedOrphanRef, {
    command: "cancel",
    idempotency_key: "orphan-observed-new-browser-key",
    expected_revision: observedSnapshot.revision
  });
  assertRunCommandResultV1(observedNewKey);
  assert.equal(observedNewKey.status, "conflict");
  assert.match(observedNewKey.message, /^COMMAND_RESERVATION_RECOVERED:/);
  assert.equal(calls.length, beforeObservedRecovery);
  const observedRecovery = await provider.executeCommand(
    observedOrphanRef,
    observedOrphanInput
  );
  assertRunCommandResultV1(observedRecovery);
  assert.equal(observedRecovery.status, "duplicate");
  assert.equal(observedRecovery.snapshot.controls.pending[0].command, "pause");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(observedOrphanPaths.resultPath, "utf8")),
    observedRecovery
  );
  assert.deepEqual(
    await provider.executeCommand(observedOrphanRef, observedOrphanInput),
    observedRecovery
  );
  assert.equal(calls.length, beforeObservedRecovery);
  const afterObservedRecovery = await provider.getSnapshot(observedOrphanRef);
  const observedFreshCommand = await provider.executeCommand(observedOrphanRef, {
    command: "cancel",
    idempotency_key: "orphan-observed-fresh-command",
    expected_revision: afterObservedRecovery.revision
  });
  assert.equal(observedFreshCommand.status, "accepted");
  assert.equal(calls.length, beforeObservedRecovery + 1);

  const unobservedOrphanRef = createSource("recommend", "orphan-unobserved-recommend");
  const unobservedOrphanRevision = (await provider.getSnapshot(unobservedOrphanRef)).revision;
  const unobservedOrphanInput = {
    command: "pause",
    idempotency_key: "orphan-unobserved-key",
    expected_revision: unobservedOrphanRevision
  };
  seedOrphanCommand(
    unobservedOrphanRef,
    unobservedOrphanInput.command,
    unobservedOrphanInput.idempotency_key,
    unobservedOrphanInput.expected_revision
  );
  const heartbeatSnapshot = projectSource(unobservedOrphanRef);
  assert.ok(heartbeatSnapshot.revision > unobservedOrphanRevision);
  const beforeUnobservedRecovery = calls.length;
  const blockedByReservation = await provider.executeCommand(unobservedOrphanRef, {
    command: "cancel",
    idempotency_key: "must-not-bypass-orphan",
    expected_revision: heartbeatSnapshot.revision
  });
  assertRunCommandResultV1(blockedByReservation);
  assert.equal(blockedByReservation.status, "conflict");
  assert.match(blockedByReservation.message, /^COMMAND_RESERVATION_RECOVERED:/);
  assert.equal(calls.length, beforeUnobservedRecovery + 1);
  const reusedOrphanKey = await provider.executeCommand(unobservedOrphanRef, {
    ...unobservedOrphanInput,
    command: "cancel"
  });
  assertRunCommandResultV1(reusedOrphanKey);
  assert.equal(reusedOrphanKey.status, "conflict");
  assert.match(reusedOrphanKey.message, /^IDEMPOTENCY_KEY_REUSED:/);
  assert.equal(calls.length, beforeUnobservedRecovery + 1);
  const unobservedRecovery = await provider.executeCommand(
    unobservedOrphanRef,
    unobservedOrphanInput
  );
  assertRunCommandResultV1(unobservedRecovery);
  assert.equal(unobservedRecovery.status, "accepted");
  assert.equal(calls.length, beforeUnobservedRecovery + 1);
  assert.deepEqual(
    await provider.executeCommand(unobservedOrphanRef, unobservedOrphanInput),
    unobservedRecovery
  );
  assert.equal(calls.length, beforeUnobservedRecovery + 1);
  const afterUnobservedRecovery = await provider.getSnapshot(unobservedOrphanRef);
  const unobservedFreshCommand = await provider.executeCommand(
    unobservedOrphanRef,
    {
      command: "cancel",
      idempotency_key: "orphan-unobserved-fresh-command",
      expected_revision: afterUnobservedRecovery.revision
    }
  );
  assert.equal(unobservedFreshCommand.status, "accepted");
  assert.equal(calls.length, beforeUnobservedRecovery + 2);

  const missingClaimRef = createSource("recommend", "orphan-missing-claim-recommend");
  const missingClaimRevision = (await provider.getSnapshot(missingClaimRef)).revision;
  const missingClaimInput = {
    command: "pause",
    idempotency_key: "orphan-missing-claim-key",
    expected_revision: missingClaimRevision
  };
  seedOrphanCommand(
    missingClaimRef,
    missingClaimInput.command,
    missingClaimInput.idempotency_key,
    missingClaimInput.expected_revision,
    { claim: false }
  );
  const beforeMissingClaim = calls.length;
  const missingClaimResult = await provider.executeCommand(missingClaimRef, missingClaimInput);
  assertRunCommandResultV1(missingClaimResult);
  assert.equal(missingClaimResult.status, "conflict");
  assert.match(missingClaimResult.message, /^COMMAND_RESULT_UNAVAILABLE:/);
  assert.equal(calls.length, beforeMissingClaim);

  const orphanPathErrorRef = createSource("recommend", "orphan-path-error-recommend");
  const orphanPathErrorRevision = (await provider.getSnapshot(orphanPathErrorRef)).revision;
  const orphanPathErrorInput = {
    command: "cancel",
    idempotency_key: "orphan-path-error-key",
    expected_revision: orphanPathErrorRevision
  };
  seedOrphanCommand(
    orphanPathErrorRef,
    orphanPathErrorInput.command,
    orphanPathErrorInput.idempotency_key,
    orphanPathErrorInput.expected_revision
  );
  const orphanPathErrorResult = await provider.executeCommand(
    orphanPathErrorRef,
    orphanPathErrorInput
  );
  assertRunCommandResultV1(orphanPathErrorResult);
  assert.equal(orphanPathErrorResult.status, "rejected");
  assert.match(orphanPathErrorResult.message, /\[redacted-path\]/);
  assert.equal(orphanPathErrorResult.message.includes(testRoot), false);

  const beforeReused = calls.length;
  const reusedInput = {
    command: "cancel",
    idempotency_key: idempotentCommand.idempotency_key,
    expected_revision: idempotentRevision
  };
  const reused = await provider.executeCommand(idempotentRef, reusedInput);
  const reusedAgain = await provider.executeCommand(idempotentRef, reusedInput);
  assertRunCommandResultV1(reused);
  assert.equal(reused.status, "conflict");
  assert.match(reused.message, /^IDEMPOTENCY_KEY_REUSED:/);
  assert.deepEqual(reusedAgain, reused);
  assert.equal(calls.length, beforeReused);
  const reusedRevision = await provider.executeCommand(idempotentRef, {
    ...idempotentCommand,
    expected_revision: idempotentRevision + 1
  });
  assertRunCommandResultV1(reusedRevision);
  assert.equal(reusedRevision.status, "conflict");
  assert.match(reusedRevision.message, /^IDEMPOTENCY_KEY_REUSED:/);
  assert.equal(calls.length, beforeReused);

  const pathResultRef = createSource("recommend", "path-result-recommend");
  const pathResultSnapshot = await provider.getSnapshot(pathResultRef);
  const pathResultInput = {
    command: "pause",
    idempotency_key: "path-result-key",
    expected_revision: pathResultSnapshot.revision
  };
  const pathResult = await provider.executeCommand(pathResultRef, pathResultInput);
  assert.equal(pathResult.status, "accepted");
  assert.match(pathResult.message, /\[redacted-path\]/);
  assert.equal(pathResult.message.includes(testRoot), false);
  const pathResultCommandDir = path.join(
    getBossMonitorRunDir(pathResultRef.kind, pathResultRef.run_id),
    ".commands"
  );
  const storedResultPath = path.join(
    pathResultCommandDir,
    fs.readdirSync(pathResultCommandDir).find((entry) => (
      entry.endsWith(".json") && !entry.endsWith(".request.json")
    ))
  );
  const storedResult = JSON.parse(fs.readFileSync(storedResultPath, "utf8"));
  storedResult.message = `Persisted result leaked ${path.join(
    recommendHome,
    "private",
    "stored-result.json"
  )}`;
  fs.writeFileSync(storedResultPath, `${JSON.stringify(storedResult, null, 2)}\n`, "utf8");
  const sanitizedDuplicate = await provider.executeCommand(pathResultRef, pathResultInput);
  assert.match(sanitizedDuplicate.message, /\[redacted-path\]/);
  assert.equal(sanitizedDuplicate.message.includes(testRoot), false);

  const pathErrorRef = createSource("recommend", "path-error-recommend");
  const pathError = await executeAtCurrentRevision(
    pathErrorRef,
    "cancel",
    "path-error-key"
  );
  assert.equal(pathError.status, "rejected");
  assert.match(pathError.message, /\[redacted-path\]/);
  assert.equal(pathError.message.includes(testRoot), false);

  const concurrentRef = createSource("recommend", "concurrent-recommend");
  const concurrentRevision = (await provider.getSnapshot(concurrentRef)).revision;
  const concurrentInputs = [
    {
      command: "pause",
      idempotency_key: "concurrent-pause",
      expected_revision: concurrentRevision
    },
    {
      command: "cancel",
      idempotency_key: "concurrent-cancel",
      expected_revision: concurrentRevision
    }
  ];
  const beforeConcurrent = calls.length;
  const concurrentResults = await Promise.all(
    concurrentInputs.map((input) => provider.executeCommand(concurrentRef, input))
  );
  for (const result of concurrentResults) assertRunCommandResultV1(result);
  assert.deepEqual(
    concurrentResults.map((result) => result.status).sort(),
    ["accepted", "conflict"]
  );
  assert.equal(calls.length, beforeConcurrent + 1);
  const losingIndex = concurrentResults.findIndex((result) => result.status === "conflict");
  const repeatedConflict = await provider.executeCommand(
    concurrentRef,
    concurrentInputs[losingIndex]
  );
  assert.deepEqual(repeatedConflict, concurrentResults[losingIndex]);
  assert.equal(calls.length, beforeConcurrent + 1);
  assert.equal(
    fs.existsSync(path.join(getBossMonitorRunDir(
      concurrentRef.kind,
      concurrentRef.run_id
    ), ".commands", ".run.lock")),
    false
  );

  const staleLockRef = createSource("search", "stale-lock-search");
  const staleCommandDir = path.join(
    getBossMonitorRunDir(staleLockRef.kind, staleLockRef.run_id),
    ".commands"
  );
  fs.mkdirSync(staleCommandDir, { recursive: true });
  const staleLockPath = path.join(staleCommandDir, ".run.lock");
  fs.writeFileSync(staleLockPath, `${JSON.stringify({
    schema_version: 1,
    nonce: "abandoned-owner",
    pid: 2_147_483_647,
    acquired_at: new Date(Date.now() - 5_000).toISOString()
  })}\n`, { encoding: "utf8", mode: 0o600 });
  const staleTime = new Date(Date.now() - 5_000);
  fs.utimesSync(staleLockPath, staleTime, staleTime);
  const staleLockResult = await executeAtCurrentRevision(
    staleLockRef,
    "pause",
    "stale-lock-recovery"
  );
  assertRunCommandResultV1(staleLockResult);
  assert.equal(staleLockResult.status, "accepted");
  assert.equal(fs.existsSync(staleLockPath), false);

  const evidenceRef = createSource("recommend", "evidence-validation");
  const invalidEvidenceIds = [
    "",
    "../snapshot",
    "..\\snapshot",
    "A".repeat(32),
    ` ${"a".repeat(32)}`,
    `${"a".repeat(32)} `,
    "a".repeat(31),
    "a".repeat(33),
    "a".repeat(16) + "/" + "b".repeat(15),
    "C:\\outside\\locator"
  ];
  for (const evidenceId of invalidEvidenceIds) {
    await assert.rejects(
      () => provider.getEvidence(evidenceRef, "candidate-1", evidenceId),
      (error) => error?.code === "INVALID_EVIDENCE_ID",
      `expected invalid evidence ID rejection for ${JSON.stringify(evidenceId)}`
    );
  }
  await assert.rejects(
    () => provider.getEvidence(evidenceRef, "candidate-1", "a".repeat(32)),
    (error) => (
      error?.code === "EVIDENCE_UNAVAILABLE"
      && error?.statusCode === 404
    )
  );

  const evidenceDir = path.join(
    getBossMonitorRunDir(evidenceRef.kind, evidenceRef.run_id),
    ".evidence"
  );
  fs.mkdirSync(evidenceDir, { recursive: true });
  const journalRunDir = path.join(recommendHome, "runs", evidenceRef.run_id);
  const journal = createCandidateResultJournal({
    runDir: journalRunDir,
    runId: evidenceRef.run_id
  });
  journal.append({
    resultIndex: 0,
    candidateKey: "candidate-1",
    result: {
      index: 0,
      candidate_key: "candidate-1",
      llm_screening: {
        raw_model_output: "superseded model output"
      }
    }
  });
  journal.append({
    resultIndex: 0,
    candidateKey: "candidate-1",
    result: {
      index: 0,
      candidate_key: "candidate-1",
      llm_screening: {
        raw_model_output: "latest active model output",
        reasoning_content: "latest active reasoning"
      }
    }
  });
  journal.append({
    resultIndex: 1,
    candidateKey: "candidate-2",
    result: {
      index: 1,
      candidate_key: "candidate-2",
      llm_screening: {
        raw_model_output: "other candidate output"
      }
    }
  });

  const journalEvidenceId = "d".repeat(32);
  fs.writeFileSync(
    path.join(evidenceDir, `${journalEvidenceId}.json`),
    `${JSON.stringify({
      kind: "model_output",
      source_type: "candidate_result_journal",
      source_path: journal.path,
      candidate_ref: "candidate-1",
      result_index: 0
    })}\n`,
    "utf8"
  );
  const journalEvidence = await provider.getEvidence(
    evidenceRef,
    "candidate-1",
    journalEvidenceId
  );
  const journalChunks = [];
  for await (const chunk of journalEvidence.stream) {
    assert.ok(chunk instanceof Uint8Array, "evidence stream chunks must be Uint8Array");
    journalChunks.push(Buffer.from(chunk));
  }
  const journalText = Buffer.concat(journalChunks).toString("utf8");
  assert.match(journalText, /latest active model output/);
  assert.match(journalText, /latest active reasoning/);
  assert.doesNotMatch(journalText, /superseded model output/);

  const mismatchedJournalEvidenceId = "e".repeat(32);
  fs.writeFileSync(
    path.join(evidenceDir, `${mismatchedJournalEvidenceId}.json`),
    `${JSON.stringify({
      kind: "model_output",
      source_type: "candidate_result_journal",
      source_path: journal.path,
      candidate_ref: "candidate-1",
      result_index: 1
    })}\n`,
    "utf8"
  );
  await assert.rejects(
    () => provider.getEvidence(
      evidenceRef,
      "candidate-1",
      mismatchedJournalEvidenceId
    ),
    (error) => (
      error?.code === "EVIDENCE_UNAVAILABLE"
      && error?.statusCode === 404
    )
  );

  const oversizedImageId = "f".repeat(32);
  const oversizedImagePath = path.join(recommendHome, "oversized-evidence.png");
  const oversizedFd = fs.openSync(oversizedImagePath, "w");
  try {
    fs.writeSync(
      oversizedFd,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      0,
      8,
      0
    );
    fs.ftruncateSync(oversizedFd, 32 * 1024 * 1024 + 1);
  } finally {
    fs.closeSync(oversizedFd);
  }
  fs.writeFileSync(
    path.join(evidenceDir, `${oversizedImageId}.json`),
    `${JSON.stringify({
      kind: "resume_screenshot",
      source_type: "file",
      source_path: oversizedImagePath,
      candidate_ref: "candidate-1"
    })}\n`,
    "utf8"
  );
  await assert.rejects(
    () => provider.getEvidence(
      evidenceRef,
      "candidate-1",
      oversizedImageId
    ),
    (error) => (
      error?.code === "EVIDENCE_UNAVAILABLE"
      && error?.statusCode === 404
    )
  );

  const directoryLocatorId = "b".repeat(32);
  fs.mkdirSync(path.join(evidenceDir, `${directoryLocatorId}.json`));
  await assert.rejects(
    () => provider.getEvidence(evidenceRef, "candidate-1", directoryLocatorId),
    (error) => error?.code === "EVIDENCE_PATH_REJECTED"
  );

  const symlinkLocatorId = "c".repeat(32);
  const outsideLocator = path.join(testRoot, "outside-locator.json");
  fs.writeFileSync(outsideLocator, "{}\n", "utf8");
  try {
    fs.symlinkSync(
      outsideLocator,
      path.join(evidenceDir, `${symlinkLocatorId}.json`),
      "file"
    );
    await assert.rejects(
      () => provider.getEvidence(evidenceRef, "candidate-1", symlinkLocatorId),
      (error) => error?.code === "EVIDENCE_PATH_REJECTED"
    );
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }

  console.log("Boss monitor provider command/security tests passed.");
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
