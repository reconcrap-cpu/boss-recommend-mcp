const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

async function main() {
  testShouldAbortResumeProbeEarly();
  await testSingleResumeCaptureFailureIsSkipped();
  await testConsecutiveResumeCaptureFailuresStillAbort();
  await testPageExhaustedBeforeTargetShouldRaiseRecoverableError();
  await testPageExhaustedWithoutTargetShouldStillComplete();
  console.log("recoverable resume failure tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
