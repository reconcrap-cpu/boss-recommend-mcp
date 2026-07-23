import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-monitor-v1-"));
const recommendHome = path.join(testRoot, "boss-recommend");
const recruitHome = path.join(testRoot, "boss-recruit");
const monitorHome = path.join(testRoot, "projection");
const recruitingMonitorHome = path.join(testRoot, "recruiting-monitor");
process.env.BOSS_RECOMMEND_HOME = recommendHome;
process.env.BOSS_RECRUIT_HOME = recruitHome;
process.env.BOSS_MONITOR_HOME = monitorHome;
process.env.RECRUITING_MONITOR_HOME = recruitingMonitorHome;
process.env.BOSS_MONITORING_ENABLED = "true";
process.env.RECRUITING_MONITOR_URL = "http://127.0.0.1:47831";
process.env.RECRUITING_MONITOR_LINK_SECRET = "isolated-test-ticket-secret-at-least-32-bytes";
const monitorLinkSecretHash = crypto.createHash("sha256")
  .update(process.env.RECRUITING_MONITOR_LINK_SECRET, "utf8")
  .digest("hex");

const {
  __test: projectionTest,
  createBossMonitorSourceMarker,
  createBossMonitoringBlock,
  getBossMonitorRunDir,
  writeBossMonitorProjection,
  writeBossMonitorProjectionNonfatal
} = await import("./monitor/projection.js");
const {
  createBossRecruitingRunProvider
} = await import("./monitor-provider.js");
const {
  createCandidateResultJournal
} = await import("./core/run/candidate-result-journal.js");

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function healthyDaemonFixture(overrides = {}) {
  return {
    pid: process.pid,
    instance_id: "isolated-monitor-instance-1234",
    started_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    base_url: "http://127.0.0.1:47831",
    providers: ["boss"],
    link_secret_sha256: monitorLinkSecretHash,
    ...overrides
  };
}

function runningSource(kind, runId, checkpointPath, screenshotPath) {
  const now = new Date().toISOString();
  return {
    run_id: runId,
    state: "running",
    stage: `${kind}:screening`,
    started_at: now,
    updated_at: now,
    heartbeat_at: now,
    pid: process.pid,
    progress: {
      target_count: 3,
      processed: 1,
      screened: 1,
      passed: 1,
      skipped: 0,
      greet_count: 0
    },
    context: {
      criteria_present: true
    },
    control: {
      pause_requested: false,
      cancel_requested: false
    },
    resume: {
      checkpoint_path: checkpointPath
    },
    artifacts: {
      checkpoint_path: checkpointPath
    },
    checkpoint: {
      results: [
        {
          index: 0,
          candidate_key: `${kind}-candidate-1`,
          candidate: {
            id: "private-id",
            name: "候选人甲",
            phone: "should-not-project"
          },
          screening: {
            passed: true,
            score: 91,
            reasons: ["满足硬性要求"]
          },
          llm_screening: {
            raw_model_output: "<script>alert('xss')</script>",
            reasoning_content: "private chain of thought"
          },
          detail: {
            image_evidence: {
              file_paths: [screenshotPath]
            }
          },
          post_action: {
            requested: "greet",
            status: "failed",
            reason: `Unable to persist action evidence at ${screenshotPath}`
          },
          timings: {
            total_ms: 123
          }
        }
      ],
      last_candidate: {
        candidate_key: `${kind}-candidate-1`,
        candidate: { name: "候选人甲" },
        screening: { passed: true, score: 91 }
      }
    }
  };
}

try {
  fs.mkdirSync(path.join(recommendHome, "runs"), { recursive: true });
  fs.mkdirSync(path.join(recruitHome, "runs"), { recursive: true });
  const screenshotPath = path.join(recommendHome, "runs", "resume.png");
  fs.writeFileSync(
    screenshotPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  );
  const checkpointPath = path.join(recommendHome, "runs", "monitor-recommend.checkpoint.json");
  const recommendSource = runningSource("recommend", "monitor-recommend", checkpointPath, screenshotPath);
  writeJson(checkpointPath, recommendSource.checkpoint);

  const first = writeBossMonitorProjection("recommend", recommendSource, {
    type: "checkpoint",
    producer: true,
    v1_created: true
  });
  assert.equal(first.ref.kind, "recommend");
  assert.equal(first.revision, 1);
  assert.equal(first.goal.mode, "passed_target");
  assert.equal(first.goal.current, 1);
  assert.equal(first.controls.available.includes("pause"), true);
  assert.equal(first.extensions.boss.projected_candidate_count, 1);
  const firstSerialized = JSON.stringify(first);
  assert.equal(firstSerialized.includes("raw_model_output"), false);
  assert.equal(firstSerialized.includes("chain of thought"), false);
  assert.equal(firstSerialized.includes(screenshotPath), false);
  assert.ok(Buffer.byteLength(firstSerialized, "utf8") < 256 * 1024);
  const providerMetadata = readJson(path.join(monitorHome, "v1", "provider.json"));
  assert.doesNotThrow(() => JSON.stringify(providerMetadata));
  assert.equal(Object.hasOwn(providerMetadata, "extensions"), false);
  const providerInstallation = readJson(
    path.join(monitorHome, "v1", ".provider-installation.json")
  );
  assert.equal(providerInstallation.provider, "boss");
  assert.ok(Number.isFinite(Date.parse(providerInstallation.installed_at)));

  const runDir = getBossMonitorRunDir("recommend", "monitor-recommend");
  const eventLines = fs.readFileSync(path.join(runDir, "events.ndjson"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    eventLines.map((event) => event.type),
    ["run.created", "artifact.available", "candidate.completed", "run.progress"]
  );
  const candidateEvent = eventLines.find((event) => event.type === "candidate.completed");
  assert.equal(candidateEvent.payload.candidate.display.name, "候选人甲");
  assert.equal(candidateEvent.payload.candidate.decision, "passed");
  assert.equal(candidateEvent.payload.candidate.action_outcome.status, "failed");
  assert.match(candidateEvent.payload.candidate.action_outcome.message, /\[redacted-path\]/);
  assert.equal(candidateEvent.payload.candidate.action_outcome.message.includes(screenshotPath), false);
  assert.equal(JSON.stringify(candidateEvent).includes("raw_model_output"), false);
  assert.equal(JSON.stringify(candidateEvent).includes(screenshotPath), false);
  assert.equal(candidateEvent.payload.candidate.evidence.length, 2);

  const provider = createBossRecruitingRunProvider({ watchIntervalMs: 20 });
  await assert.rejects(
    () => provider.listRuns({}),
    (error) => error?.code === "KIND_REQUIRED"
  );
  const recommendPage = await provider.listRuns({ kind: "recommend" });
  assert.equal(recommendPage.runs.length, 1);
  assert.equal(recommendPage.runs[0].ref.kind, "recommend");
  assert.equal((await provider.listRuns({ kind: "search" })).runs.length, 0);

  const ref = { provider: "boss", kind: "recommend", run_id: "monitor-recommend" };
  const snapshot = await provider.getSnapshot(ref);
  const events = await provider.getEvents(ref, 0, 20);
  assert.equal(events.events.length, 4);
  assert.equal(events.last_seq, snapshot.last_event_seq);
  fs.appendFileSync(path.join(runDir, "events.ndjson"), "{\"partial\":", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 5_200));
  const heartbeatSnapshot = await provider.getSnapshot(ref);
  assert.ok(heartbeatSnapshot.revision > snapshot.revision);
  const heartbeatEvents = await provider.getEvents(ref, snapshot.last_event_seq, 20);
  assert.ok(heartbeatEvents.events.some((event) => event.type === "run.progress"));
  assert.equal(
    (await provider.getEvents(ref, 0, 100)).events
      .filter((event) => event.type === "artifact.available").length,
    1
  );
  assert.ok(heartbeatSnapshot.liveness.update_age_ms >= 0);
  for (const line of fs.readFileSync(path.join(runDir, "events.ndjson"), "utf8").trim().split(/\r?\n/)) {
    assert.doesNotThrow(() => JSON.parse(line));
  }

  const screenshotEvidence = candidateEvent.payload.candidate.evidence.find(
    (entry) => entry.type === "resume_screenshot"
  );
  const screenshot = await provider.getEvidence(
    ref,
    "recommend-candidate-1",
    screenshotEvidence.evidence_id
  );
  assert.equal(screenshot.content_type, "image/png");
  const screenshotChunks = [];
  for await (const chunk of screenshot.stream) screenshotChunks.push(chunk);
  assert.equal(Buffer.concat(screenshotChunks).equals(fs.readFileSync(screenshotPath)), true);

  const modelEvidence = candidateEvent.payload.candidate.evidence.find(
    (entry) => entry.type === "model_output"
  );
  const model = await provider.getEvidence(ref, "recommend-candidate-1", modelEvidence.evidence_id);
  const modelChunks = [];
  for await (const chunk of model.stream) modelChunks.push(Buffer.from(chunk));
  const modelText = Buffer.concat(modelChunks).toString("utf8");
  assert.match(modelText, /raw_model_output/);
  assert.match(modelText, /<script>/);
  assert.equal(model.content_type, "text/plain");
  await assert.rejects(
    () => provider.getEvidence(ref, "wrong-candidate", screenshotEvidence.evidence_id),
    (error) => error?.code === "EVIDENCE_UNAVAILABLE"
  );

  const evidenceDir = path.join(runDir, ".evidence");
  const outsideEvidenceId = "a".repeat(32);
  const invalidMimeEvidenceId = "b".repeat(32);
  const outsideSymlinkEvidenceId = "c".repeat(32);
  const outsidePath = path.join(testRoot, "outside.png");
  fs.writeFileSync(outsidePath, fs.readFileSync(screenshotPath));
  writeJson(path.join(evidenceDir, `${outsideEvidenceId}.json`), {
    kind: "resume_screenshot",
    source_type: "file",
    source_path: outsidePath,
    candidate_ref: "recommend-candidate-1"
  });
  const invalidMimePath = path.join(recommendHome, "runs", "invalid.png");
  fs.writeFileSync(invalidMimePath, "<html>not an image</html>", "utf8");
  writeJson(path.join(evidenceDir, `${invalidMimeEvidenceId}.json`), {
    kind: "resume_screenshot",
    source_type: "file",
    source_path: invalidMimePath,
    candidate_ref: "recommend-candidate-1"
  });
  await assert.rejects(
    () => provider.getEvidence(ref, "recommend-candidate-1", outsideEvidenceId),
    (error) => error?.code === "EVIDENCE_PATH_REJECTED"
  );
  await assert.rejects(
    () => provider.getEvidence(ref, "recommend-candidate-1", invalidMimeEvidenceId),
    (error) => error?.code === "EVIDENCE_MIME_REJECTED"
  );
  const symlinkPath = path.join(recommendHome, "runs", "outside-link.png");
  try {
    fs.symlinkSync(outsidePath, symlinkPath, "file");
    writeJson(path.join(evidenceDir, `${outsideSymlinkEvidenceId}.json`), {
      kind: "resume_screenshot",
      source_type: "file",
      source_path: symlinkPath,
      candidate_ref: "recommend-candidate-1"
    });
    await assert.rejects(
      () => provider.getEvidence(ref, "recommend-candidate-1", outsideSymlinkEvidenceId),
      (error) => error?.code === "EVIDENCE_PATH_REJECTED"
    );
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }

  const monitorFiles = fs.readdirSync(runDir);
  assert.equal(monitorFiles.some((name) => /\.(png|jpe?g|webp)$/i.test(name)), false);

  const journalRunId = "journal-projection";
  const journal = createCandidateResultJournal({
    runDir: path.join(recommendHome, "runs"),
    runId: journalRunId
  });
  const journalResult = {
    index: 0,
    candidate_key: "journal-candidate",
    candidate: { name: "候选人日志" },
    screening: { passed: true, score: 80, reasons: ["初次结果"] }
  };
  journal.append({
    resultIndex: 0,
    candidateKey: "journal-candidate",
    result: {
      ...journalResult,
      llm_screening: {
        raw_model_output: "journal model output"
      },
      detail: {
        image_evidence: {
          file_paths: [screenshotPath]
        }
      }
    }
  });
  const journalSource = {
    ...runningSource("recommend", journalRunId, checkpointPath, screenshotPath),
    checkpoint: { results: [] },
    artifacts: {
      checkpoint_path: checkpointPath,
      candidate_result_journal_path: journal.path
    }
  };
  const firstJournalSnapshot = writeBossMonitorProjection("recommend", journalSource, {
    type: "created",
    v1_created: true
  });
  const journalRef = {
    provider: "boss",
    kind: "recommend",
    run_id: journalRunId
  };
  const firstJournalEvents = await provider.getEvents(journalRef, 0, 100);
  assert.equal(
    firstJournalEvents.events.filter((event) => event.type === "candidate.completed").length,
    1
  );
  journal.append({
    resultIndex: 0,
    candidateKey: "journal-candidate",
    result: {
      ...journalResult,
      screening: { ...journalResult.screening, score: 96, reasons: ["重试后的结果"] }
    }
  });
  writeBossMonitorProjection("recommend", journalSource, { type: "checkpoint" });
  const updatedJournalEvents = await provider.getEvents(
    journalRef,
    firstJournalSnapshot.last_event_seq,
    100
  );
  const updatedCandidate = updatedJournalEvents.events.find(
    (event) => event.type === "candidate.completed"
  );
  assert.equal(updatedCandidate.payload.candidate.score, 96);
  assert.equal(new Set([
    ...firstJournalEvents.events,
    ...updatedJournalEvents.events
  ].map((event) => event.event_id)).size, (
    firstJournalEvents.events.length + updatedJournalEvents.events.length
  ));

  const transientRunId = "transient-evidence-locator";
  const transientJournalDir = path.join(recommendHome, "runs");
  const transientJournal = createCandidateResultJournal({
    runDir: transientJournalDir,
    runId: transientRunId
  });
  transientJournal.append({
    resultIndex: 0,
    candidateKey: "transient-candidate",
    result: {
      index: 0,
      candidate_key: "transient-candidate",
      candidate: { name: "候选人瞬态" },
      screening: { passed: true, score: 88 },
      llm_screening: { raw_model_output: "retry me after locator failure" },
      detail: { image_evidence: { file_paths: [screenshotPath] } }
    }
  });
  const transientSource = {
    ...runningSource("recommend", transientRunId, checkpointPath, screenshotPath),
    checkpoint: { results: [] },
    artifacts: {
      checkpoint_path: checkpointPath,
      candidate_result_journal_path: transientJournal.path
    }
  };
  const transientRunDir = getBossMonitorRunDir("recommend", transientRunId);
  fs.mkdirSync(transientRunDir, { recursive: true });
  fs.writeFileSync(path.join(transientRunDir, ".evidence"), "injected transient failure", "utf8");
  const transientFirst = writeBossMonitorProjection("recommend", transientSource, {
    type: "created",
    v1_created: true
  });
  assert.equal(transientFirst.extensions.boss.projected_journal_record_count, 1);
  const transientEvents = await provider.getEvents({
    provider: "boss",
    kind: "recommend",
    run_id: transientRunId
  }, 0, 100);
  const transientCandidateEvent = transientEvents.events.find(
    (event) => event.type === "candidate.completed"
  );
  const transientModelEvidence = transientCandidateEvent.payload.candidate.evidence.find(
    (entry) => entry.type === "model_output"
  );
  assert.ok(transientModelEvidence);
  fs.unlinkSync(path.join(transientRunDir, ".evidence"));
  writeBossMonitorProjection("recommend", transientSource, { type: "heartbeat" });
  assert.equal(
    (await provider.getEvents({
      provider: "boss",
      kind: "recommend",
      run_id: transientRunId
    }, 0, 100)).events.filter((event) => event.type === "candidate.completed").length,
    1,
    "locator retry must not duplicate the candidate event"
  );
  const retriedEvidence = await provider.getEvidence(
    { provider: "boss", kind: "recommend", run_id: transientRunId },
    "transient-candidate",
    transientModelEvidence.evidence_id
  );
  const retriedEvidenceChunks = [];
  for await (const chunk of retriedEvidence.stream) retriedEvidenceChunks.push(Buffer.from(chunk));
  assert.match(Buffer.concat(retriedEvidenceChunks).toString("utf8"), /retry me after locator failure/);

  const searchCheckpoint = path.join(recruitHome, "runs", "monitor-search.checkpoint.json");
  const searchSource = runningSource("search", "monitor-search", searchCheckpoint, screenshotPath);
  searchSource.checkpoint.results = [];
  writeJson(searchCheckpoint, searchSource.checkpoint);
  const historicalSource = {
    ...searchSource,
    run_id: "pre-monitor-install",
    started_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:01.000Z"
  };
  assert.equal(writeBossMonitorProjection("search", historicalSource, {
    type: "lifecycle",
    producer: true
  }), null);
  assert.equal(writeBossMonitorProjection("search", {
    ...historicalSource,
    updated_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString()
  }, {
    type: "lifecycle",
    producer: true
  }), null);
  assert.equal(writeBossMonitorProjection("search", {
    ...historicalSource,
    monitoring_v1: {
      contract_version: "1.0",
      created_at: historicalSource.started_at,
      provider_installed_at: providerInstallation.installed_at
    }
  }, {
    type: "lifecycle",
    producer: true
  }), null);
  assert.equal(
    fs.existsSync(path.join(getBossMonitorRunDir("search", "pre-monitor-install"), "snapshot.json")),
    false
  );
  writeBossMonitorProjection("search", searchSource, {
    type: "progress",
    v1_created: true
  });
  assert.equal((await provider.listRuns({ kind: "recommend" })).runs.length, 3);
  assert.equal((await provider.listRuns({ kind: "search" })).runs.length, 1);
  assert.equal((await provider.listRuns({ kind: "chat" })).runs.length, 0);
  const searchRef = { provider: "boss", kind: "search", run_id: "monitor-search" };
  const searchRunDir = getBossMonitorRunDir("search", "monitor-search");
  const searchSnapshotPath = path.join(searchRunDir, "snapshot.json");
  const staleSearch = readJson(searchSnapshotPath);
  staleSearch.liveness.heartbeat_at = new Date(Date.now() - 60_000).toISOString();
  writeJson(searchSnapshotPath, staleSearch);
  assert.equal((await provider.getSnapshot(searchRef)).liveness.status, "stale");
  writeJson(path.join(searchRunDir, "worker-exit.json"), {
    worker_instance_id: "old-worker-with-reused-pid",
    pid: staleSearch.liveness.pid,
    exited_at: new Date().toISOString()
  });
  assert.equal((await provider.getSnapshot(searchRef)).liveness.status, "stale");
  staleSearch.liveness.heartbeat_at = new Date().toISOString();
  writeJson(searchSnapshotPath, staleSearch);
  assert.equal((await provider.getSnapshot(searchRef)).liveness.status, "alive");
  writeJson(path.join(searchRunDir, "worker-exit.json"), {
    worker_instance_id: staleSearch.liveness.worker_instance_id,
    pid: staleSearch.liveness.pid,
    exited_at: new Date().toISOString(),
    reason: "fixture"
  });
  assert.equal((await provider.getSnapshot(searchRef)).liveness.status, "exited");

  const retryRunId = "terminal-retry";
  const retrySource = runningSource("recommend", retryRunId, checkpointPath, screenshotPath);
  writeBossMonitorProjection("recommend", retrySource, {
    type: "created",
    producer: true,
    v1_created: true
  });
  const retryRunDir = getBossMonitorRunDir("recommend", retryRunId);
  const retryLockPath = path.join(retryRunDir, ".writer.lock");
  writeJson(retryLockPath, {
    pid: process.pid,
    worker_instance_id: "live-contender",
    nonce: "live-contender-nonce",
    acquired_at: new Date().toISOString()
  });
  const retryTerminalSource = {
    ...retrySource,
    state: "completed",
    stage: "recommend:done",
    updated_at: new Date().toISOString(),
    completed_at: new Date().toISOString()
  };
  assert.equal(writeBossMonitorProjectionNonfatal("recommend", retryTerminalSource, {
    type: "status",
    producer: true
  }), null);
  assert.equal((await provider.getSnapshot({
    provider: "boss",
    kind: "recommend",
    run_id: retryRunId
  })).state, "running");
  fs.unlinkSync(retryLockPath);
  await new Promise((resolve) => setTimeout(resolve, 5_200));
  assert.equal((await provider.getSnapshot({
    provider: "boss",
    kind: "recommend",
    run_id: retryRunId
  })).state, "completed");
  assert.equal(fs.existsSync(retryLockPath), false);

  const terminalSource = {
    ...recommendSource,
    state: "completed",
    stage: "recommend:done",
    updated_at: new Date().toISOString(),
    completed_at: new Date().toISOString()
  };
  const terminal = writeBossMonitorProjection("recommend", terminalSource, {
    type: "status",
    producer: true
  });
  assert.equal(terminal.state, "completed");
  assert.equal(terminal.liveness.status, "exited");
  assert.equal(fs.existsSync(path.join(runDir, "worker-exit.json")), true);
  const terminalRevision = terminal.revision;
  await new Promise((resolve) => setTimeout(resolve, 5_200));
  const stillTerminal = await provider.getSnapshot(ref);
  assert.equal(stillTerminal.state, "completed");
  assert.equal(stillTerminal.revision, terminalRevision);

  const recoveredLockRunId = "recovered-writer-lock";
  const recoveredLockRunDir = getBossMonitorRunDir("chat", recoveredLockRunId);
  fs.mkdirSync(recoveredLockRunDir, { recursive: true });
  const staleWriterLock = path.join(recoveredLockRunDir, ".writer.lock");
  writeJson(staleWriterLock, {
    pid: 2147483647,
    worker_instance_id: "dead-owner",
    nonce: "dead-owner-nonce",
    acquired_at: "2025-01-01T00:00:00.000Z"
  });
  const oldLockTime = new Date(Date.now() - 30_000);
  fs.utimesSync(staleWriterLock, oldLockTime, oldLockTime);
  const recoveredLockSnapshot = writeBossMonitorProjection("chat", {
    ...runningSource("chat", recoveredLockRunId, checkpointPath, screenshotPath),
    monitoring_v1: { contract_version: "1.0", created_at: new Date().toISOString() }
  }, { type: "created", v1_created: true });
  assert.equal(recoveredLockSnapshot.state, "running");
  assert.equal(fs.existsSync(staleWriterLock), false);

  writeJson(path.join(recommendHome, "runs", "monitor-recommend.json"), terminalSource);
  const commandRevision = (await provider.getSnapshot(ref)).revision;
  const command = {
    type: "cancel",
    idempotency_key: "same-command",
    expected_revision: commandRevision
  };
  const firstCommand = await provider.executeCommand(ref, command);
  const secondCommand = await provider.executeCommand(ref, command);
  assert.deepEqual(secondCommand, firstCommand);
  assert.equal(firstCommand.command, "cancel");

  const conflict = await provider.executeCommand(ref, {
    command: "pause",
    idempotency_key: "stale-revision",
    expected_revision: 0
  });
  assert.equal(conflict.status, "conflict");

  assert.equal(createBossMonitoringBlock(
    "recommend",
    "monitor-recommend"
  ).availability, "monitor_unavailable");
  writeJson(
    path.join(recruitingMonitorHome, "daemon.json"),
    healthyDaemonFixture()
  );
  const monitoring = createBossMonitoringBlock("recommend", "monitor-recommend");
  assert.equal(monitoring.availability, "ready");
  assert.match(monitoring.dashboard_url, /^http:\/\/127\.0\.0\.1:47831\/access\//);
  const token = monitoring.dashboard_url.split("/access/")[1];
  const [ticketBody] = token.split(".");
  const ticket = JSON.parse(Buffer.from(ticketBody, "base64url").toString("utf8"));
  assert.deepEqual(ticket.ref, {
    provider: "boss",
    kind: "recommend",
    run_id: "monitor-recommend"
  });
  process.env.RECRUITING_MONITOR_URL = "http://192.0.2.10:47831";
  const remoteMonitoring = createBossMonitoringBlock("recommend", "monitor-recommend");
  assert.equal(remoteMonitoring.availability, "monitor_unavailable");
  assert.equal(remoteMonitoring.dashboard_url, null);
  process.env.RECRUITING_MONITOR_URL = "http://127.0.0.1:47831";
  writeJson(
    path.join(recruitingMonitorHome, "daemon.json"),
    healthyDaemonFixture({ providers: ["simulated"] })
  );
  assert.equal(
    createBossMonitoringBlock("recommend", "monitor-recommend").availability,
    "monitor_unavailable"
  );
  writeJson(
    path.join(recruitingMonitorHome, "daemon.json"),
    healthyDaemonFixture({ pid: 2_147_483_647 })
  );
  assert.equal(
    createBossMonitoringBlock("recommend", "monitor-recommend").availability,
    "monitor_unavailable"
  );
  writeJson(
    path.join(recruitingMonitorHome, "daemon.json"),
    healthyDaemonFixture({ started_at: "not-a-timestamp" })
  );
  assert.equal(
    createBossMonitoringBlock("recommend", "monitor-recommend").availability,
    "monitor_unavailable"
  );
  writeJson(
    path.join(recruitingMonitorHome, "daemon.json"),
    healthyDaemonFixture({
      heartbeat_at: new Date(Date.now() - 16_000).toISOString()
    })
  );
  assert.equal(
    createBossMonitoringBlock("recommend", "monitor-recommend").availability,
    "monitor_unavailable"
  );
  writeJson(
    path.join(recruitingMonitorHome, "daemon.json"),
    healthyDaemonFixture({
      heartbeat_at: new Date(Date.now() + 6_000).toISOString()
    })
  );
  assert.equal(
    createBossMonitoringBlock("recommend", "monitor-recommend").availability,
    "monitor_unavailable"
  );
  writeJson(
    path.join(recruitingMonitorHome, "daemon.json"),
    healthyDaemonFixture({
      instance_id: "short"
    })
  );
  assert.equal(
    createBossMonitoringBlock("recommend", "monitor-recommend").availability,
    "monitor_unavailable"
  );
  writeJson(
    path.join(recruitingMonitorHome, "daemon.json"),
    healthyDaemonFixture({
      link_secret_sha256: "0".repeat(64)
    })
  );
  assert.equal(
    createBossMonitoringBlock("recommend", "monitor-recommend").availability,
    "monitor_unavailable"
  );
  const configuredMonitorHome = process.env.RECRUITING_MONITOR_HOME;
  delete process.env.RECRUITING_MONITOR_HOME;
  assert.equal(
    projectionTest.recruitingMonitorHome(),
    path.join(os.homedir(), ".recruiting-run-monitor")
  );
  process.env.RECRUITING_MONITOR_HOME = configuredMonitorHome;

  const healthyMonitorHome = process.env.BOSS_MONITOR_HOME;
  const invalidMonitorHome = path.join(testRoot, "monitor-home-is-a-file");
  fs.writeFileSync(invalidMonitorHome, "not a directory", "utf8");
  process.env.BOSS_MONITOR_HOME = invalidMonitorHome;
  assert.equal(
    createBossMonitorSourceMarker(new Date().toISOString()),
    null,
    "provider installation I/O failure must omit the V1 source marker"
  );
  assert.equal(
    writeBossMonitorProjectionNonfatal("recommend", {
      run_id: "monitor-storage-unavailable",
      state: "queued",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, {
      type: "created",
      producer: true,
      v1_created: true
    }),
    null,
    "projection persistence failure must remain nonfatal"
  );
  process.env.BOSS_MONITOR_HOME = healthyMonitorHome;

  process.env.BOSS_MONITORING_ENABLED = "false";
  assert.equal(
    writeBossMonitorProjectionNonfatal("chat", {
      run_id: "disabled-run",
      state: "running"
    }),
    null
  );
  assert.equal(createBossMonitoringBlock("chat", "disabled-run").availability, "disabled");

  console.log("Boss monitor projection/provider tests passed.");
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
