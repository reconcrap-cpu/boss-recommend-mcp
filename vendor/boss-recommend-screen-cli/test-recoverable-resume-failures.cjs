const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { RecommendScreenCli, __testables } = require("./boss-recommend-screen-cli.cjs");
const { __testables: captureTestables } = require("./scripts/capture-full-resume-canvas.cjs");

class FakeRecommendScreenCli extends RecommendScreenCli {
  constructor(args, options = {}) {
    super(args);
    this.testCandidates = options.candidates || [];
    this.captureOutcomes = options.captureOutcomes || new Map();
    this.screeningByKey = options.screeningByKey || new Map();
    this.discoveryCalls = 0;
    this.lastCapturedCandidateKey = null;
  }

  async connect() {}

  async disconnect() {}

  async getDetailClosedState() {
    return { closed: true, reason: "test" };
  }

  async closeDetailPage() {
    return true;
  }

  async waitForListReady() {
    return true;
  }

  async ensureHealthyListViewport() {
    return {
      ok: true,
      state: { ok: true }
    };
  }

  async discoverCandidates() {
    if (this.discoveryCalls === 0) {
      for (const candidate of this.testCandidates) {
        this.candidateByKey.set(candidate.key, candidate);
        this.discoveredKeys.add(candidate.key);
        this.candidateQueue.push(candidate.key);
        this.insertCounter += 1;
        this.insertedAt.set(candidate.key, this.insertCounter);
      }
      this.discoveryCalls += 1;
      return {
        ok: true,
        added: this.testCandidates.length,
        candidate_count: this.testCandidates.length,
        total_cards: this.testCandidates.length
      };
    }
    this.discoveryCalls += 1;
    return {
      ok: true,
      added: 0,
      candidate_count: this.testCandidates.length,
      total_cards: this.testCandidates.length
    };
  }

  async scrollAndLoadMore() {
    return {
      before: {
        candidateCount: this.testCandidates.length,
        scrollTop: 0,
        scrollHeight: 100
      },
      after: {
        candidateCount: this.testCandidates.length,
        scrollTop: 0,
        scrollHeight: 100
      },
      bottom: {
        isBottom: true
      }
    };
  }

  async clickCandidate() {}

  async ensureDetailOpen() {
    return true;
  }

  async captureResumeImage(candidate) {
    const outcome = this.captureOutcomes.get(candidate.key);
    if (outcome instanceof Error) {
      throw outcome;
    }
    this.lastCapturedCandidateKey = candidate.key;
    return outcome || {
      stitchedImage: path.join(os.tmpdir(), `${candidate.key}.png`)
    };
  }

  async callVisionModel() {
    return this.screeningByKey.get(this.lastCapturedCandidateKey) || {
      passed: false,
      reason: "not matched",
      summary: "not matched"
    };
  }

  async favoriteCandidate() {
    return { actionTaken: "favorite" };
  }

  async greetCandidate() {
    return { actionTaken: "greet" };
  }

  async takeBreakIfNeeded() {}

  saveCsv() {}

  saveCheckpoint() {}
}

function createResumeCaptureError(message = "Resume canvas not found") {
  const error = new Error(message);
  error.code = "RESUME_CAPTURE_FAILED";
  error.retryable = true;
  return error;
}

function createArgs(tempDir) {
  return {
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    model: "test-model",
    criteria: "test criteria",
    targetCount: null,
    maxGreetCount: null,
    port: 9222,
    output: path.join(tempDir, "result.csv"),
    checkpointPath: path.join(tempDir, "checkpoint.json"),
    pauseControlPath: path.join(tempDir, "pause.json"),
    resume: false,
    postAction: "none",
    postActionConfirmed: true,
    help: false,
    __provided: {
      baseUrl: true,
      apiKey: true,
      model: true,
      criteria: true,
      targetCount: true,
      maxGreetCount: false,
      port: true,
      postAction: true,
      postActionConfirmed: true
    }
  };
}

function testShouldAbortResumeProbeEarly() {
  const probe = {
    ok: false,
    reason: "NO_CRESUME_IFRAME",
    debug: {
      activeScopeCount: 0,
      totalResumeIframes: 0,
      visibleResumeIframes: 0
    }
  };
  const shouldAbort = captureTestables.shouldAbortResumeProbeEarly({
    probe,
    stableNoResumeIframePolls: captureTestables.EARLY_FAIL_NO_RESUME_IFRAME_STABLE_POLLS,
    elapsedMs: captureTestables.EARLY_FAIL_NO_RESUME_IFRAME_MIN_WAIT_MS,
    waitResumeMs: 60000
  });
  assert.equal(shouldAbort, true);
}

async function testSingleResumeCaptureFailureIsSkipped() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-skip-"));
  const badCandidate = { key: "bad", geek_id: "bad", name: "bad candidate" };
  const goodCandidate = { key: "good", geek_id: "good", name: "good candidate" };
  const cli = new FakeRecommendScreenCli(createArgs(tempDir), {
    candidates: [badCandidate, goodCandidate],
    captureOutcomes: new Map([
      ["bad", createResumeCaptureError()],
      ["good", { stitchedImage: path.join(tempDir, "good.png") }]
    ]),
    screeningByKey: new Map([
      ["good", { passed: true, reason: "matched", summary: "matched" }]
    ])
  });

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.processed_count, 2);
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.skipped_count, 1);
  assert.equal(cli.consecutiveResumeCaptureFailures, 0);
}

async function testConsecutiveResumeCaptureFailuresStillAbort() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-abort-"));
  const maxFailures = __testables.MAX_CONSECUTIVE_RESUME_CAPTURE_FAILURES;
  const candidates = Array.from({ length: maxFailures }, (_, index) => ({
    key: `fail-${index + 1}`,
    geek_id: `fail-${index + 1}`,
    name: `fail-${index + 1}`
  }));
  const captureOutcomes = new Map(
    candidates.map((candidate) => [candidate.key, createResumeCaptureError(`Resume capture failed for ${candidate.key}`)])
  );
  const cli = new FakeRecommendScreenCli(createArgs(tempDir), {
    candidates,
    captureOutcomes
  });

  await assert.rejects(
    () => cli.run(),
    (error) => {
      assert.equal(error.code, "RESUME_CAPTURE_FAILED_CONSECUTIVE_LIMIT");
      assert.match(error.message, /连续 .* 位候选人简历捕获失败/);
      assert.equal(error.rollback?.rollback_count, maxFailures);
      assert.equal(error.partial_result?.processed_count, 0);
      assert.equal(error.partial_result?.skipped_count, 0);
      assert.deepEqual(Array.from(cli.processedKeys), []);
      return true;
    }
  );
}

async function testPageExhaustedBeforeTargetShouldRaiseRecoverableError() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-page-exhausted-"));
  const args = createArgs(tempDir);
  args.targetCount = 5;
  const cli = new FakeRecommendScreenCli(args);
  cli.scrollAndLoadMore = async () => ({
    before: {
      candidateCount: 0,
      scrollTop: 120,
      scrollHeight: 900
    },
    after: {
      candidateCount: 0,
      scrollTop: 900,
      scrollHeight: 900
    },
    bottom: {
      isBottom: true,
      finished_wrap_visible: true,
      refresh_button_visible: true,
      refresh_button_text: "刷新"
    }
  });

  await assert.rejects(
    () => cli.run(),
    (error) => {
      assert.equal(error.code, "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED");
      assert.equal(error.retryable, true);
      assert.equal(error.partial_result?.processed_count, 0);
      assert.equal(error.partial_result?.output_csv, args.output);
      assert.equal(error.partial_result?.checkpoint_path, args.checkpointPath);
      assert.equal(error.partial_result?.completion_reason, "page_exhausted_before_target_count");
      assert.equal(error.page_exhaustion?.reason, "bottom_reached");
      assert.equal(error.page_exhaustion?.bottom?.finished_wrap_visible, true);
      assert.equal(error.page_exhaustion?.bottom?.refresh_button_visible, true);
      return true;
    }
  );
}

async function testPageExhaustedWithoutTargetShouldStillComplete() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-page-complete-"));
  const cli = new FakeRecommendScreenCli(createArgs(tempDir));
  cli.scrollAndLoadMore = async () => ({
    before: {
      candidateCount: 0,
      scrollTop: 120,
      scrollHeight: 900
    },
    after: {
      candidateCount: 0,
      scrollTop: 900,
      scrollHeight: 900
    },
    bottom: {
      isBottom: true,
      finished_wrap_visible: true,
      refresh_button_visible: true,
      refresh_button_text: "刷新"
    }
  });

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.processed_count, 0);
  assert.equal(result.result.output_csv, cli.args.output);
  assert.equal(result.result.checkpoint_path, cli.args.checkpointPath);
  assert.equal(result.result.completion_reason, "page_exhausted");
}

async function testStitchWithSharpShouldComposeExpectedImage() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-sharp-stitch-"));
  const chunkA = path.join(tempDir, "chunk_000.png");
  const chunkB = path.join(tempDir, "chunk_001.png");
  const chunkC = path.join(tempDir, "chunk_002.png");
  const metadataPath = path.join(tempDir, "chunks.json");
  const outputPath = path.join(tempDir, "stitched.png");

  await sharp({
    create: { width: 20, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } }
  }).png().toFile(chunkA);
  await sharp({
    create: { width: 20, height: 100, channels: 3, background: { r: 0, g: 255, b: 0 } }
  }).png().toFile(chunkB);
  await sharp({
    create: { width: 20, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } }
  }).png().toFile(chunkC);

  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      chunks: [
        { index: 0, file: chunkA, scrollTop: 0, clipHeightCss: 100 },
        { index: 1, file: chunkB, scrollTop: 80, clipHeightCss: 100 },
        { index: 2, file: chunkC, scrollTop: 160, clipHeightCss: 100 }
      ]
    }),
    "utf8"
  );

  const stitched = await captureTestables.stitchWithSharp(metadataPath, outputPath);
  const outputMeta = await sharp(outputPath).metadata();

  assert.equal(stitched.ok, true);
  assert.equal(stitched.engine, "sharp");
  assert.equal(stitched.segments, 3);
  assert.equal(outputMeta.width, 20);
  assert.equal(outputMeta.height, 260);
  assert.equal(Array.isArray(stitched.used), true);
  assert.equal(stitched.used.length, 3);
}

function testStitchWithAvailablePythonShouldFallbackToPython() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-python-fallback-"));
  const stitchScript = path.join(tempDir, "stitch.py");
  fs.writeFileSync(stitchScript, "print('ok')", "utf8");
  const calls = [];
  const result = captureTestables.stitchWithAvailablePython(
    stitchScript,
    path.join(tempDir, "meta.json"),
    path.join(tempDir, "out.png"),
    (command) => {
      calls.push(command);
      if (command === "python3") {
        return {
          status: 1,
          signal: null,
          error: null,
          stderr: "python3 failed",
          stdout: ""
        };
      }
      return {
        status: 0,
        signal: null,
        error: null,
        stderr: "",
        stdout: "ok"
      };
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.command, "python");
  assert.deepEqual(calls, ["python3", "python"]);
}

function testStitchWithAvailablePythonShouldFailWhenScriptMissing() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-python-missing-"));
  const result = captureTestables.stitchWithAvailablePython(
    path.join(tempDir, "missing.py"),
    path.join(tempDir, "meta.json"),
    path.join(tempDir, "out.png")
  );

  assert.equal(result.ok, false);
  assert.equal(Array.isArray(result.attempts), true);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].command, "python3");
}

async function main() {
  testShouldAbortResumeProbeEarly();
  await testSingleResumeCaptureFailureIsSkipped();
  await testConsecutiveResumeCaptureFailuresStillAbort();
  await testPageExhaustedBeforeTargetShouldRaiseRecoverableError();
  await testPageExhaustedWithoutTargetShouldStillComplete();
  await testStitchWithSharpShouldComposeExpectedImage();
  testStitchWithAvailablePythonShouldFallbackToPython();
  testStitchWithAvailablePythonShouldFailWhenScriptMissing();
  console.log("recoverable resume failure tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
