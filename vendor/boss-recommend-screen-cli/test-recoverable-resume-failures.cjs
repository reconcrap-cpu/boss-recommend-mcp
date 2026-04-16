const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { RecommendScreenCli, parseArgs, __testables } = require("./boss-recommend-screen-cli.cjs");
const { __testables: captureTestables } = require("./scripts/capture-full-resume-canvas.cjs");

class FakeRecommendScreenCli extends RecommendScreenCli {
  constructor(args, options = {}) {
    super(args);
    this.testCandidates = options.candidates || [];
    this.captureOutcomes = options.captureOutcomes || new Map();
    this.screeningByKey = options.screeningByKey || new Map();
    this.domResumeByKey = options.domResumeByKey || new Map();
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

  async extractResumeTextFromDom(candidate) {
    return this.domResumeByKey.get(candidate.key) || null;
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

class FakeDetailCloseProbeCli extends RecommendScreenCli {
  constructor(args, options = {}) {
    super(args);
    this.listReady = options.listReady === true;
    this.evaluateCallCount = 0;
  }

  async getDetailClosedState() {
    return { closed: false, reason: "popup visible: .boss-popup__wrapper" };
  }

  async evaluate() {
    this.evaluateCallCount += 1;
    if (this.evaluateCallCount >= 2) {
      return this.listReady
        ? { ok: true, candidate_count: 1 }
        : { ok: false, error: "LIST_NOT_READY" };
    }
    return { ok: false, error: "CLOSE_ACTION_NOOP" };
  }

  async pressEsc() {}
}

class FakeRecoverableGreetFailureCli extends FakeRecommendScreenCli {
  constructor(args, options = {}) {
    super(args, options);
    this.greetErrors = options.greetErrors || new Map();
    this.closeFailureKeys = options.closeFailureKeys || new Set();
  }

  async greetCandidate() {
    const key = this.currentCandidateKey || "";
    const code = this.greetErrors.get(key);
    if (!code) return { actionTaken: "greet" };
    const error = new Error(code);
    error.code = code;
    throw error;
  }

  async closeDetailPage() {
    const key = this.currentCandidateKey || "";
    if (this.closeFailureKeys.has(key)) {
      return false;
    }
    return true;
  }
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
    pageScope: "recommend",
    port: 9222,
    output: path.join(tempDir, "result.csv"),
    inputSummary: null,
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
      pageScope: true,
      port: true,
      inputSummary: false,
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

function testResumeViewportStabilityRequiresSettledScrollAndClip() {
  const previous = {
    ok: true,
    scrollTop: 200,
    scrollHeight: 1000,
    clientHeight: 400,
    maxScroll: 600,
    clip: { x: 10, y: 20, width: 300, height: 400 }
  };
  const current = {
    ok: true,
    scrollTop: 200.5,
    scrollHeight: 1000,
    clientHeight: 400,
    maxScroll: 600,
    clip: { x: 10, y: 20, width: 300, height: 400 }
  };
  assert.equal(captureTestables.isStableResumeViewport(previous, current, 200), true);
  assert.equal(captureTestables.isStableResumeViewport(previous, { ...current, scrollTop: 180 }, 200), false);
  assert.equal(
    captureTestables.isStableResumeViewport(previous, { ...current, clip: { ...current.clip, height: 360 } }, 200),
    false
  );
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
      assert.match(error.message, /连续 .* 位候选人简历(?:捕获失败|获取失败（network \+ (?:DOM \+ )?截图）)/);
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

async function testTargetCountShouldStopWhenPassedCountReached() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-target-pass-stop-"));
  const args = createArgs(tempDir);
  args.targetCount = 1;
  const first = { key: "pass-1", geek_id: "pass-1", name: "pass-1" };
  const second = { key: "skip-2", geek_id: "skip-2", name: "skip-2" };
  const cli = new FakeRecommendScreenCli(args, {
    candidates: [first, second],
    screeningByKey: new Map([
      ["pass-1", { passed: true, reason: "matched", summary: "matched" }],
      ["skip-2", { passed: false, reason: "not matched", summary: "not matched" }]
    ])
  });

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.processed_count, 1);
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.skipped_count, 0);
  assert.equal(result.result.completion_reason, "target_count_reached");
}

async function testTargetCountShouldNotTreatProcessedCountAsReached() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-target-pass-only-"));
  const args = createArgs(tempDir);
  args.targetCount = 1;
  const first = { key: "skip-a", geek_id: "skip-a", name: "skip-a" };
  const second = { key: "skip-b", geek_id: "skip-b", name: "skip-b" };
  const cli = new FakeRecommendScreenCli(args, {
    candidates: [first, second],
    screeningByKey: new Map([
      ["skip-a", { passed: false, reason: "not matched", summary: "not matched" }],
      ["skip-b", { passed: false, reason: "not matched", summary: "not matched" }]
    ])
  });

  await assert.rejects(
    () => cli.run(),
    (error) => {
      assert.equal(error.code, "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED");
      assert.equal(error.retryable, true);
      assert.equal(error.partial_result?.processed_count, 2);
      assert.equal(error.partial_result?.passed_count, 0);
      assert.equal(error.partial_result?.completion_reason, "page_exhausted_before_target_count");
      return true;
    }
  );
}

async function testFeaturedShouldUseNetworkResumeOnly() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-network-first-"));
  const candidate = { key: "net-1", geek_id: "net-1", name: "network candidate" };
  const args = createArgs(tempDir);
  args.pageScope = "featured";
  const cli = new FakeRecommendScreenCli(args, {
    candidates: [candidate]
  });

  cli.waitForNetworkResumeCandidateInfo = async () => ({
    name: "network candidate",
    school: "测试大学",
    major: "计算机",
    company: "OpenClaw",
    position: "工程师",
    resumeText: "有丰富 MCP 经验"
  });
  cli.callTextModel = async () => ({
    passed: true,
    reason: "network pass",
    summary: "network summary"
  });
  cli.captureResumeImage = async () => {
    throw new Error("capture should not be called");
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.resume_source, "network");
}

async function testRecommendShouldPreferNetworkResumeWhenAvailable() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-recommend-network-main-"));
  const candidate = { key: "net-main-1", geek_id: "net-main-1", name: "recommend network main candidate" };
  const cli = new FakeRecommendScreenCli(createArgs(tempDir), {
    candidates: [candidate]
  });
  cli.waitForNetworkResumeCandidateInfo = async () => ({
    resumeText: "这段 network 文本在 recommend 页面应优先用于筛选"
  });
  cli.callTextModel = async () => ({
    passed: true,
    reason: "network used",
    summary: "network used"
  });
  cli.captureResumeImage = async () => {
    throw new Error("capture should not be called when recommend network resume exists");
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.resume_source, "network");
}

async function testNetworkMissShouldFallbackToImageThenDom() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-network-dom-fallback-"));
  const candidate = { key: "dom-1", geek_id: "dom-1", name: "dom candidate" };
  const cli = new FakeRecommendScreenCli(createArgs(tempDir), {
    candidates: [candidate],
    domResumeByKey: new Map([
      ["dom-1", {
        name: "dom candidate",
        school: "华中科技大学",
        major: "智能科学与技术",
        company: "小米科技（武汉）",
        position: "算法工程师",
        resumeText: "教育经历：华中科技大学（本硕），专业智能科学与技术。工作与项目经历包含多模态、大模型微调、Agent 架构设计与落地。"
      }]
    ])
  });

  cli.waitForNetworkResumeCandidateInfo = async () => null;
  let captureAttempted = false;
  cli.callTextModel = async (resumeText) => ({
    passed: true,
    reason: resumeText.includes("华中科技大学") ? "dom fallback used" : "unexpected",
    summary: "dom fallback used"
  });
  cli.captureResumeImage = async () => {
    captureAttempted = true;
    throw new Error("capture failed, should fallback to dom");
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.resume_source, "dom_fallback");
  assert.equal(cli.passedCandidates.length, 1);
  assert.equal(cli.passedCandidates[0].school, "华中科技大学");
  assert.equal(cli.passedCandidates[0].resumeSource, "dom_fallback");
  assert.equal(captureAttempted, true);
}

async function testNetworkMissShouldFallbackToImageCapture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-network-fallback-"));
  const candidate = { key: "img-1", geek_id: "img-1", name: "image candidate" };
  const cli = new FakeRecommendScreenCli(createArgs(tempDir), {
    candidates: [candidate],
    captureOutcomes: new Map([
      ["img-1", { stitchedImage: path.join(tempDir, "img-1.png") }]
    ]),
    screeningByKey: new Map([
      ["img-1", { passed: false, reason: "image path used", summary: "image path used" }]
    ])
  });
  cli.waitForNetworkResumeCandidateInfo = async () => null;

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.resume_source, "image_fallback");
}

async function testImageModeShouldUseShortNetworkGraceWindow() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-image-mode-grace-"));
  const first = { key: "img-mode-1", geek_id: "img-mode-1", name: "image mode one" };
  const second = { key: "img-mode-2", geek_id: "img-mode-2", name: "image mode two" };
  const cli = new FakeRecommendScreenCli(createArgs(tempDir), {
    candidates: [first, second],
    captureOutcomes: new Map([
      [first.key, { stitchedImage: path.join(tempDir, "img-mode-1.png") }],
      [second.key, { stitchedImage: path.join(tempDir, "img-mode-2.png") }]
    ]),
    screeningByKey: new Map([
      [first.key, { passed: false, reason: "image one", summary: "image one" }],
      [second.key, { passed: false, reason: "image two", summary: "image two" }]
    ])
  });
  const waits = [];
  cli.waitForNetworkResumeCandidateInfo = async (_candidate, timeoutMs) => {
    waits.push(timeoutMs);
    return null;
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(cli.resumeAcquisitionMode, "image");
  assert.deepEqual(waits.slice(-1), [__testables.NETWORK_RESUME_IMAGE_MODE_GRACE_MS]);
}

async function testImageFailureShouldLateRetryNetworkBeforeDomFallback() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-image-fail-late-network-"));
  const candidate = { key: "late-network-1", geek_id: "late-network-1", name: "late network candidate" };
  const cli = new FakeRecommendScreenCli(createArgs(tempDir), {
    candidates: [candidate]
  });
  let domUsed = false;
  cli.waitForNetworkResumeCandidateInfo = async (_candidate, timeoutMs) => (
    timeoutMs === __testables.NETWORK_RESUME_LATE_RETRY_MS
      ? { resumeText: "late network resume text" }
      : null
  );
  cli.captureResumeImage = async () => {
    throw createResumeCaptureError("image capture failed before late network");
  };
  cli.extractResumeTextFromDom = async () => {
    domUsed = true;
    return null;
  };
  cli.callTextModel = async () => ({
    passed: true,
    reason: "late network used",
    summary: "late network used"
  });

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.resume_source, "network");
  assert.equal(domUsed, false);
}

async function testLatestShouldPreferNetworkResumeWhenAvailable() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-latest-network-main-"));
  const args = createArgs(tempDir);
  args.pageScope = "latest";
  const candidate = { key: "latest-net-1", geek_id: "latest-net-1", name: "latest network candidate" };
  const cli = new FakeRecommendScreenCli(args, {
    candidates: [candidate]
  });
  cli.waitForNetworkResumeCandidateInfo = async () => ({
    resumeText: "最新页 network 简历可用"
  });
  cli.callTextModel = async () => ({
    passed: true,
    reason: "network used",
    summary: "network used"
  });
  cli.captureResumeImage = async () => {
    throw new Error("capture should not be called when latest network resume exists");
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.resume_source, "network");
}

async function testLatestNetworkMissShouldFallbackToImageCapture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-latest-network-fallback-"));
  const args = createArgs(tempDir);
  args.pageScope = "latest";
  const candidate = { key: "latest-img-1", geek_id: "latest-img-1", name: "latest image candidate" };
  const cli = new FakeRecommendScreenCli(args, {
    candidates: [candidate],
    captureOutcomes: new Map([
      ["latest-img-1", { stitchedImage: path.join(tempDir, "latest-img-1.png") }]
    ]),
    screeningByKey: new Map([
      ["latest-img-1", { passed: false, reason: "image fallback used", summary: "image fallback used" }]
    ])
  });
  cli.waitForNetworkResumeCandidateInfo = async () => null;

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.resume_source, "image_fallback");
}

function testLatestPayloadShouldNotLeakAcrossCandidates() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-latest-payload-leak-"));
  const cli = new RecommendScreenCli(createArgs(tempDir));
  cli.latestResumeNetworkPayload = {
    ts: Date.now(),
    geekIds: ["candidate-a"],
    candidateInfo: {
      resumeText: "candidate-a resume"
    }
  };
  const extracted = cli.tryExtractNetworkResumeForCandidate({
    key: "candidate-b",
    geek_id: "candidate-b"
  });
  assert.equal(extracted, null);
}

function testLatestPayloadShouldRemainAvailableWhenCandidateKeyMissing() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-latest-payload-no-key-"));
  const cli = new RecommendScreenCli(createArgs(tempDir));
  cli.latestResumeNetworkPayload = {
    ts: Date.now(),
    geekIds: ["candidate-a"],
    candidateInfo: {
      resumeText: "recent resume payload"
    }
  };
  const extracted = cli.tryExtractNetworkResumeForCandidate({
    key: "",
    geek_id: ""
  });
  assert.equal(extracted?.candidateInfo?.resumeText, "recent resume payload");
}

async function testVisionModelFailureShouldSkipCandidateAndContinue() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-vision-failure-skip-"));
  const first = { key: "vision-fail-1", geek_id: "vision-fail-1", name: "vision-fail-1" };
  const second = { key: "vision-pass-2", geek_id: "vision-pass-2", name: "vision-pass-2" };
  const cli = new FakeRecommendScreenCli(createArgs(tempDir), {
    candidates: [first, second],
    captureOutcomes: new Map([
      ["vision-fail-1", { stitchedImage: path.join(tempDir, "vision-fail-1.png") }],
      ["vision-pass-2", { stitchedImage: path.join(tempDir, "vision-pass-2.png") }]
    ]),
    screeningByKey: new Map([
      ["vision-pass-2", { passed: true, reason: "ok", summary: "ok" }]
    ])
  });

  cli.callVisionModel = async () => {
    if (cli.lastCapturedCandidateKey === "vision-fail-1") {
      const error = new Error("model backend timeout");
      error.code = "VISION_MODEL_FAILED";
      throw error;
    }
    return {
      passed: true,
      reason: "ok",
      summary: "ok"
    };
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.processed_count, 2);
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.skipped_count, 1);
}

async function testFeaturedNetworkMissShouldFallbackToDomAfterImageFailure() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-featured-network-only-"));
  const args = createArgs(tempDir);
  args.pageScope = "featured";
  const candidate = { key: "featured-no-network", geek_id: "featured-no-network", name: "featured no network" };
  const cli = new FakeRecommendScreenCli(args, {
    candidates: [candidate],
    domResumeByKey: new Map([
      ["featured-no-network", {
        name: "featured no network",
        school: "华中科技大学",
        major: "软件工程",
        company: "测试公司",
        position: "后端工程师",
        resumeText: "featured network miss 后应在截图失败后走 DOM 兜底。"
      }]
    ])
  });
  cli.waitForNetworkResumeCandidateInfo = async () => null;
  let captureAttempted = false;
  cli.callTextModel = async () => ({
    passed: true,
    reason: "dom fallback used",
    summary: "dom fallback used"
  });
  cli.captureResumeImage = async () => {
    captureAttempted = true;
    throw new Error("capture failed for featured scope");
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.processed_count, 1);
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.skipped_count, 0);
  assert.equal(result.result.resume_source, "dom_fallback");
  assert.equal(captureAttempted, true);
  assert.equal(cli.passedCandidates[0].resumeSource, "dom_fallback");
}

async function testFeaturedFavoriteShouldNotUseDomFallback() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-featured-favorite-"));
  const args = createArgs(tempDir);
  args.pageScope = "featured";
  const calibrationPath = path.join(tempDir, "favorite-calibration.json");
  fs.writeFileSync(calibrationPath, JSON.stringify({
    favoritePosition: {
      pageX: 120,
      pageY: 220,
      canvasX: 0,
      canvasY: 0
    }
  }, null, 2));
  args.calibrationPath = calibrationPath;
  const cli = new RecommendScreenCli(args);
  let evaluateCalls = 0;
  let clickCalls = 0;
  cli.evaluate = async () => {
    evaluateCalls += 1;
    return { ok: true };
  };
  cli.simulateHumanClick = async () => {
    clickCalls += 1;
    cli.favoriteActionEvents.push({ action: "add", ts: Date.now(), source: "test", url: "userMark/add" });
  };
  const result = await cli.favoriteCandidate();
  assert.equal(result.actionTaken, "favorite");
  assert.equal(clickCalls, 1);
  assert.equal(evaluateCalls, 0);
}

async function testFeaturedFavoriteShouldSkipClickWhenAlreadyInterested() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-featured-favorite-already-"));
  const args = createArgs(tempDir);
  args.pageScope = "featured";
  const calibrationPath = path.join(tempDir, "favorite-calibration.json");
  fs.writeFileSync(calibrationPath, JSON.stringify({
    favoritePosition: {
      pageX: 120,
      pageY: 220,
      canvasX: 0,
      canvasY: 0
    }
  }, null, 2));
  args.calibrationPath = calibrationPath;
  const cli = new RecommendScreenCli(args);
  let clickCalls = 0;
  cli.simulateHumanClick = async () => {
    clickCalls += 1;
  };
  const result = await cli.favoriteCandidate({ alreadyInterested: true });
  assert.equal(result.actionTaken, "already_favorited");
  assert.equal(result.source, "network_profile");
  assert.equal(clickCalls, 0);
}

async function testFeaturedFavoriteShouldRecognizeAlreadyFavoritedByDelThenAdd() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-featured-favorite-del-add-"));
  const args = createArgs(tempDir);
  args.pageScope = "featured";
  const calibrationPath = path.join(tempDir, "favorite-calibration.json");
  fs.writeFileSync(calibrationPath, JSON.stringify({
    favoritePosition: {
      pageX: 120,
      pageY: 220,
      canvasX: 0,
      canvasY: 0
    }
  }, null, 2));
  args.calibrationPath = calibrationPath;
  const cli = new RecommendScreenCli(args);
  let clickCalls = 0;
  cli.simulateHumanClick = async () => {
    clickCalls += 1;
    cli.favoriteActionEvents.push({
      action: clickCalls === 1 ? "del" : "add",
      ts: Date.now(),
      source: "test",
      url: clickCalls === 1 ? "userMark/del" : "userMark/add"
    });
  };
  const result = await cli.favoriteCandidate();
  assert.equal(result.actionTaken, "already_favorited");
  assert.equal(result.re_favorited, true);
  assert.equal(clickCalls, 2);
}

async function testFeaturedFavoriteWithoutCalibrationShouldFail() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-featured-favorite-missing-cal-"));
  const args = createArgs(tempDir);
  args.pageScope = "featured";
  args.calibrationPath = path.join(tempDir, "missing-calibration.json");
  const cli = new RecommendScreenCli(args);
  await assert.rejects(
    () => cli.favoriteCandidate(),
    (error) => {
      assert.equal(error.code, "FAVORITE_CALIBRATION_REQUIRED");
      return true;
    }
  );
}

function testFavoriteActionParserShouldSupportBodySignals() {
  const addFromJson = __testables.parseFavoriteActionFromPostData(JSON.stringify({
    action: "star-interest-click",
    p3: 1
  }));
  const delFromForm = __testables.parseFavoriteActionFromPostData("action=star-interest-click&p3=0");
  assert.equal(addFromJson, "add");
  assert.equal(delFromForm, "del");
}

function testFavoriteActionParserShouldSupportFallbackRequestShape() {
  const action = __testables.parseFavoriteActionFromRequest(
    "https://www.zhipin.com/wapi/zpgeek/favorite/operate",
    JSON.stringify({ op: "add", geekId: "abc" })
  );
  assert.equal(action, "add");
}

function testFavoriteActionParserShouldSupportWebSocketPayload() {
  const addFromWsJson = __testables.parseFavoriteActionFromWsPayload(JSON.stringify({
    action: "star-interest-click",
    p3: 1
  }));
  const delFromWsForm = __testables.parseFavoriteActionFromWsPayload("action=star-interest-click&p3=0");
  assert.equal(addFromWsJson, "add");
  assert.equal(delFromWsForm, "del");
}

function testFavoriteActionParserShouldOnlyTrustKnownRequestShapes() {
  const unknown = __testables.parseFavoriteActionFromKnownRequest(
    "https://www.zhipin.com/wapi/other/metrics",
    JSON.stringify({ action: "add", p3: 1 })
  );
  const actionLog = __testables.parseFavoriteActionFromKnownRequest(
    "https://www.zhipin.com/wapi/zplog/actionLog/common.json",
    JSON.stringify({ action: "star-interest-click", p3: 1 })
  );
  const userMark = __testables.parseFavoriteActionFromKnownRequest(
    "https://www.zhipin.com/wapi/zpgeek/userMark/add",
    ""
  );
  assert.equal(unknown, null);
  assert.equal(actionLog, "add");
  assert.equal(userMark, "add");
}

function testFinishedWrapClassifierShouldNotTreatLoadMoreAsBottom() {
  const loadMore = __testables.classifyFinishedWrapState("滚动加载更多", false);
  const loading = __testables.classifyFinishedWrapState("正在加载数据...", false);
  const noMore = __testables.classifyFinishedWrapState("没有更多人选", false);
  const refreshOnly = __testables.classifyFinishedWrapState("", true);

  assert.equal(loadMore.isBottom, false);
  assert.equal(loadMore.matched_load_more_keyword, "滚动加载更多");
  assert.equal(loading.isBottom, false);
  assert.equal(loading.matched_load_more_keyword, "正在加载");
  assert.equal(noMore.isBottom, true);
  assert.equal(noMore.matched_bottom_keyword, "没有更多");
  assert.equal(refreshOnly.isBottom, true);
  assert.equal(refreshOnly.reason, "refresh_button_visible");
}

function testFormatResumeApiDataShouldPreserveEducationTagsAndProjectDescription() {
  const source = {
    geekDetailInfo: {
      geekBaseInfo: {
        name: "测试候选人",
        degreeCategory: "硕士"
      },
      geekEduExpList: [
        {
          school: "南京大学",
          major: "数学",
          degree: 203,
          degreeName: "本科",
          schoolTags: [{ name: "985院校" }, { name: "QS世界大学排名TOP200" }]
        }
      ],
      geekProjExpList: [
        {
          name: "Prompt-to-Prompt 3DEditing via NeRF",
          projectDescription: "采用stable diffusion进行编辑实验"
        }
      ]
    }
  };
  const formatted = __testables.formatResumeApiData(source);
  assert.equal(formatted.includes("学历: 本科"), true);
  assert.equal(formatted.includes("学历: 203"), false);
  assert.equal(formatted.includes("学校标签: 985院校、QS世界大学排名TOP200"), true);
  assert.equal(formatted.includes("描述: 采用stable diffusion进行编辑实验"), true);
}

function testEvidenceTokenMatcherShouldSupportParaphrasedEvidence() {
  const resume = [
    "南京大学 专业: 数学",
    "Prompt-to-Prompt 3DEditing via NeRF",
    "采用 stable diffusion 进行编辑实验"
  ].join(" | ");
  const normalizedResume = resume.replace(/\s+/g, " ").trim();
  const matched = __testables.matchEvidenceAgainstResume(
    "项目经历包含Prompt-to-Prompt 3DEditing via NeRF（stable diffusion）",
    resume,
    normalizedResume,
    normalizedResume.toLowerCase()
  );
  assert.equal(matched.matched, true);
  const unmatched = __testables.matchEvidenceAgainstResume(
    "有十年金融风控投研经历",
    resume,
    normalizedResume,
    normalizedResume.toLowerCase()
  );
  assert.equal(unmatched.matched, false);
}

function testCheckpointPayloadShouldIncludeCandidateAudits() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-audit-checkpoint-"));
  const cli = new RecommendScreenCli(createArgs(tempDir));
  cli.recordCandidateAudit({
    candidate_key: "candidate-a",
    geek_id: "candidate-a",
    candidate_name: "候选人A",
    outcome: "skipped",
    resume_source: "network",
    raw_passed: true,
    final_passed: false,
    evidence_gate_demoted: true,
    screening_reason: "模型未给出可校验证据"
  });
  const checkpoint = cli.buildCheckpointPayload();
  assert.equal(Array.isArray(checkpoint.candidate_audits), true);
  assert.equal(checkpoint.candidate_audits.length, 1);
  assert.equal(checkpoint.candidate_audits[0].candidate_key, "candidate-a");
  assert.equal(checkpoint.candidate_audits[0].evidence_gate_demoted, true);
}

function testCheckpointShouldPersistAndRestoreInputSummary() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-input-summary-checkpoint-"));
  const args = createArgs(tempDir);
  args.inputSummary = {
    instruction: "筛选 AI 人选",
    search_params: {
      school_tag: ["985"],
      degree: ["本科"]
    },
    screen_params: {
      criteria: "有 LLM 项目经验"
    },
    baseUrl: "https://should-not-be-stored",
    apiKey: "sk-should-not-be-stored",
    model: "should-not-be-stored"
  };
  const cli = new RecommendScreenCli(args);
  const checkpoint = cli.buildCheckpointPayload();
  assert.equal(checkpoint.input_summary?.instruction, "筛选 AI 人选");
  assert.equal(checkpoint.input_summary?.screen_params?.criteria, "有 LLM 项目经验");
  assert.equal(Object.prototype.hasOwnProperty.call(checkpoint.input_summary || {}, "baseUrl"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(checkpoint.input_summary || {}, "apiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(checkpoint.input_summary || {}, "model"), false);

  fs.writeFileSync(args.checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
  const resumeArgs = createArgs(tempDir);
  resumeArgs.resume = true;
  resumeArgs.inputSummary = null;
  const resumeCli = new RecommendScreenCli(resumeArgs);
  const restored = resumeCli.loadCheckpointIfNeeded();
  assert.equal(restored, true);
  assert.equal(resumeCli.inputSummary?.instruction, "筛选 AI 人选");
  assert.equal(resumeCli.inputSummary?.screen_params?.criteria, "有 LLM 项目经验");
}

function testSaveCsvShouldIncludeAllCandidateOutcomes() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-csv-audit-"));
  const args = createArgs(tempDir);
  args.output = path.join(tempDir, "result.csv");
  const cli = new RecommendScreenCli(args);
  cli.inputSummary = {
    instruction: "找算法候选人",
    search_params: {
      school_tag: ["985", "211"],
      degree: ["本科"],
      gender: "不限"
    },
    screen_params: {
      criteria: "有 LLM 研究或工程经验",
      post_action: "greet"
    },
    baseUrl: "https://should-not-appear",
    apiKey: "sk-should-not-appear",
    model: "gpt-should-not-appear"
  };
  cli.candidateAudits = [
    {
      candidate_key: "cand-pass",
      geek_id: "cand-pass",
      candidate_name: "通过候选人",
      school: "南京大学",
      major: "数学",
      company: "",
      position: "",
      outcome: "passed",
      screening_reason: "满足全部条件",
      action_taken: "greet",
      resume_source: "network",
      raw_passed: true,
      final_passed: true,
      evidence_raw_count: 4,
      evidence_matched_count: 3,
      evidence_gate_demoted: false,
      error_code: "",
      error_message: ""
    },
    {
      candidate_key: "cand-skip",
      geek_id: "cand-skip",
      candidate_name: "跳过候选人",
      school: "某大学",
      major: "工科",
      company: "",
      position: "",
      outcome: "skipped",
      screening_reason: "证据不足",
      action_taken: "none",
      resume_source: "network",
      raw_passed: false,
      final_passed: false,
      evidence_raw_count: 2,
      evidence_matched_count: 0,
      evidence_gate_demoted: false,
      error_code: "",
      error_message: ""
    }
  ];
  cli.saveCsv();
  const content = fs.readFileSync(args.output, "utf8");
  assert.equal(content.includes("处理结果"), true);
  assert.equal(content.includes("运行输入字段"), true);
  assert.equal(content.includes("instruction"), true);
  assert.equal(content.includes("screen_params.criteria"), true);
  assert.equal(content.includes("baseUrl"), false);
  assert.equal(content.includes("apiKey"), false);
  assert.equal(content.includes("model"), false);
  assert.equal((content.match(/运行输入字段/g) || []).length, 1);
  assert.equal(content.includes("通过候选人"), true);
  assert.equal(content.includes("跳过候选人"), true);
  assert.equal(content.includes("cand-skip"), true);
}

async function testGetCenteredCandidateClickPointShouldSupportLatestSelector() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-latest-click-locator-"));
  const args = createArgs(tempDir);
  args.pageScope = "latest";
  const cli = new RecommendScreenCli(args);

  let expressionCaptured = "";
  cli.evaluate = async (expression) => {
    expressionCaptured = String(expression || "");
    return {
      ok: true,
      x: 100,
      y: 100,
      width: 120,
      height: 64
    };
  };

  const result = await cli.getCenteredCandidateClickPoint({
    key: "latest-test-key",
    geek_id: "latest-test-key"
  });

  assert.equal(result.ok, true);
  assert.equal(expressionCaptured.includes(".candidate-card-wrap .card-inner[data-geek]"), true);
  assert.equal(expressionCaptured.includes("getAttribute('data-geek')"), true);
}

async function testFeaturedPostActionFailureShouldStillRecordPassedCandidate() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-featured-action-failure-"));
  const args = createArgs(tempDir);
  args.pageScope = "featured";
  args.postAction = "favorite";
  const candidate = { key: "featured-fav-fail", geek_id: "featured-fav-fail", name: "featured candidate" };
  const cli = new FakeRecommendScreenCli(args, {
    candidates: [candidate]
  });

  cli.waitForNetworkResumeCandidateInfo = async () => ({
    name: "featured candidate",
    school: "测试大学",
    major: "人工智能",
    company: "测试公司",
    position: "算法工程师",
    resumeText: "满足测试标准"
  });
  cli.callTextModel = async () => ({
    passed: true,
    reason: "通过",
    summary: "通过"
  });
  cli.favoriteCandidate = async () => {
    const error = new Error("精选页收藏未检测到 network add 成功信号。");
    error.code = "FAVORITE_BUTTON_FAILED";
    throw error;
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.processed_count, 1);
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.skipped_count, 0);
  assert.equal(cli.passedCandidates.length, 1);
  assert.equal(cli.passedCandidates[0].action, "favorite_failed");
  assert.match(cli.passedCandidates[0].reason, /\[favorite失败]/);
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

function testParseArgsShouldSupportFeaturedAliasesAndInlinePort() {
  const parsed = parseArgs([
    "--criteria", "test criteria",
    "--baseurl", "https://example.com/v1",
    "--apikey", "key",
    "--model", "test-model",
    "--target-count", "3",
    "--pageScope", "featured",
    "--port=9222",
    "--postAction", "favorite",
    "--postActionConfirmed", "true"
  ]);
  assert.equal(parsed.pageScope, "featured");
  assert.equal(parsed.port, 9222);
  assert.equal(parsed.targetCount, 3);
  assert.equal(parsed.postAction, "favorite");
  assert.equal(parsed.postActionConfirmed, true);
  assert.equal(parsed.__provided.pageScope, true);
  assert.equal(parsed.__provided.port, true);
}

function testParseArgsShouldSupportLatestPageScope() {
  const parsed = parseArgs([
    "--criteria", "test criteria",
    "--baseurl", "https://example.com/v1",
    "--apikey", "key",
    "--model", "test-model",
    "--page-scope", "latest",
    "--port", "9222",
    "--post-action", "none",
    "--post-action-confirmed", "true"
  ]);
  assert.equal(parsed.pageScope, "latest");
  assert.equal(parsed.port, 9222);
}

function testParseArgsShouldSupportInputSummaryJson() {
  const parsed = parseArgs([
    "--criteria", "test criteria",
    "--baseurl", "https://example.com/v1",
    "--apikey", "key",
    "--model", "test-model",
    "--post-action", "none",
    "--post-action-confirmed", "true",
    "--input-summary-json", "{\"instruction\":\"筛选测试\",\"search_params\":{\"school_tag\":[\"985\"]}}"
  ]);
  assert.equal(parsed.inputSummary?.instruction, "筛选测试");
  assert.equal(parsed.inputSummary?.search_params?.school_tag?.[0], "985");
}

async function testCallTextModelShouldNotTruncateLongResume() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-text-full-"));
  const cli = new RecommendScreenCli(createArgs(tempDir));
  const marker = "__END_OF_RESUME_MARKER__";
  const resumeText = `${"A".repeat(32000)}${marker}`;
  const originalFetch = global.fetch;
  let capturedUserContent = "";
  global.fetch = async (_url, options = {}) => {
    const payload = JSON.parse(String(options.body || "{}"));
    capturedUserContent = String(payload?.messages?.[1]?.content || "");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "{\"passed\": false, \"reason\": \"not matched\", \"summary\": \"not matched\", \"evidence\": [\"A\"]}"
              }
            }
          ]
        };
      }
    };
  };
  try {
    const result = await cli.callTextModel(resumeText);
    assert.equal(result.passed, false);
    assert.equal(capturedUserContent.includes(marker), true);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testCallTextModelShouldFallbackToChunkModeOnContextLimit() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-text-chunk-fallback-"));
  const cli = new RecommendScreenCli(createArgs(tempDir));
  const originalFetch = global.fetch;
  const prevChunkSize = process.env.BOSS_RECOMMEND_TEXT_CHUNK_SIZE_CHARS;
  const prevChunkOverlap = process.env.BOSS_RECOMMEND_TEXT_CHUNK_OVERLAP_CHARS;
  const prevMaxChunks = process.env.BOSS_RECOMMEND_TEXT_MAX_CHUNKS;
  process.env.BOSS_RECOMMEND_TEXT_CHUNK_SIZE_CHARS = "80";
  process.env.BOSS_RECOMMEND_TEXT_CHUNK_OVERLAP_CHARS = "0";
  process.env.BOSS_RECOMMEND_TEXT_MAX_CHUNKS = "6";

  const passMarker = "PASS_MARKER_ABC";
  const resumeText = `${"x".repeat(120)}${passMarker}${"y".repeat(120)}`;
  let callCount = 0;
  global.fetch = async (_url, options = {}) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: false,
        status: 400,
        async text() {
          return "maximum context length exceeded";
        }
      };
    }

    const payload = JSON.parse(String(options.body || "{}"));
    const userContent = String(payload?.messages?.[1]?.content || "");
    const passed = userContent.includes(passMarker);
    const response = passed
      ? "{\"passed\": true, \"reason\": \"命中证据\", \"summary\": \"命中\", \"evidence\": [\"PASS_MARKER_ABC\"]}"
      : "{\"passed\": false, \"reason\": \"本段证据不足\", \"summary\": \"不足\", \"evidence\": []}";
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: response
              }
            }
          ]
        };
      }
    };
  };
  try {
    const result = await cli.callTextModel(resumeText);
    assert.equal(result.passed, true);
    assert.equal(callCount >= 2, true);
    assert.equal(Array.isArray(result.evidence), true);
  } finally {
    global.fetch = originalFetch;
    if (prevChunkSize === undefined) {
      delete process.env.BOSS_RECOMMEND_TEXT_CHUNK_SIZE_CHARS;
    } else {
      process.env.BOSS_RECOMMEND_TEXT_CHUNK_SIZE_CHARS = prevChunkSize;
    }
    if (prevChunkOverlap === undefined) {
      delete process.env.BOSS_RECOMMEND_TEXT_CHUNK_OVERLAP_CHARS;
    } else {
      process.env.BOSS_RECOMMEND_TEXT_CHUNK_OVERLAP_CHARS = prevChunkOverlap;
    }
    if (prevMaxChunks === undefined) {
      delete process.env.BOSS_RECOMMEND_TEXT_MAX_CHUNKS;
    } else {
      process.env.BOSS_RECOMMEND_TEXT_MAX_CHUNKS = prevMaxChunks;
    }
  }
}

async function testTextModelShouldDefaultThinkingOffForVolcengine() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-thinking-off-"));
  const cli = new RecommendScreenCli(createArgs(tempDir));
  cli.args.baseUrl = "https://ark.cn-beijing.volces.com/api/v3";
  cli.args.model = "doubao-seed-2-0-mini-260215";
  const originalFetch = global.fetch;
  let capturedPayload = null;
  global.fetch = async (_url, options = {}) => {
    capturedPayload = JSON.parse(String(options.body || "{}"));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "{\"passed\": false, \"reason\": \"not matched\", \"summary\": \"not matched\", \"evidence\": [\"resume\"]}"
              }
            }
          ]
        };
      }
    };
  };
  try {
    await cli.callTextModel("resume");
    assert.deepEqual(capturedPayload?.thinking, { type: "disabled" });
    assert.equal(capturedPayload?.reasoning_effort, "minimal");
  } finally {
    global.fetch = originalFetch;
  }
}

async function testTextModelShouldSupportLowThinkingForVolcengine() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-thinking-low-"));
  const cli = new RecommendScreenCli(createArgs(tempDir));
  cli.args.baseUrl = "https://ark.cn-beijing.volces.com/api/v3";
  cli.args.model = "doubao-seed-2-0-mini-260215";
  cli.args.thinkingLevel = "low";
  const originalFetch = global.fetch;
  let capturedPayload = null;
  global.fetch = async (_url, options = {}) => {
    capturedPayload = JSON.parse(String(options.body || "{}"));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "{\"passed\": false, \"reason\": \"not matched\", \"summary\": \"not matched\", \"evidence\": [\"resume\"]}"
              }
            }
          ]
        };
      }
    };
  };
  try {
    await cli.callTextModel("resume");
    assert.deepEqual(capturedPayload?.thinking, { type: "enabled" });
    assert.equal(capturedPayload?.reasoning_effort, "low");
  } finally {
    global.fetch = originalFetch;
  }
}

async function testPrepareVisionImageSegmentsShouldSplitLongImage() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-vision-segments-"));
  const cli = new RecommendScreenCli(createArgs(tempDir));
  const imagePath = path.join(tempDir, "long.png");
  await sharp({
    create: { width: 400, height: 1200, channels: 3, background: { r: 240, g: 240, b: 240 } }
  }).png().toFile(imagePath);

  const prepared = await cli.prepareVisionImageSegmentsForModel(imagePath, 120000, "test");
  assert.equal(Array.isArray(prepared.imagePaths), true);
  assert.equal(prepared.imagePaths.length > 1, true);
  for (const segmentPath of prepared.imagePaths) {
    assert.equal(fs.existsSync(segmentPath), true);
  }
}

function testRecoverablePostActionErrorShouldTreatGreetContinueAndNoButtonAsRecoverable() {
  assert.equal(
    __testables.isRecoverablePostActionError({ code: "GREET_CONTINUE_BUTTON_FOUND" }, "greet"),
    true
  );
  assert.equal(
    __testables.isRecoverablePostActionError({ code: "GREET_BUTTON_NOT_FOUND" }, "greet"),
    true
  );
}

async function testRecoverableGreetContinueButtonShouldNotAbortWhenDetailCloseFails() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-greet-continue-"));
  const args = createArgs(tempDir);
  args.postAction = "greet";
  args.maxGreetCount = 5;
  args.__provided.maxGreetCount = true;

  const first = { key: "candidate-1", geek_id: "candidate-1", name: "candidate-1" };
  const second = { key: "candidate-2", geek_id: "candidate-2", name: "candidate-2" };
  const cli = new FakeRecoverableGreetFailureCli(args, {
    candidates: [first, second],
    captureOutcomes: new Map([
      [first.key, { stitchedImage: path.join(tempDir, "candidate-1.png") }],
      [second.key, { stitchedImage: path.join(tempDir, "candidate-2.png") }]
    ]),
    screeningByKey: new Map([
      [first.key, { passed: true, reason: "matched", summary: "matched" }],
      [second.key, { passed: true, reason: "matched", summary: "matched" }]
    ]),
    greetErrors: new Map([[first.key, "GREET_CONTINUE_BUTTON_FOUND"]]),
    closeFailureKeys: new Set([first.key])
  });

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.processed_count, 2);
  assert.equal(result.result.passed_count, 2);
  assert.equal(result.result.greet_count, 1);
}

async function testRecoverableGreetButtonNotFoundShouldNotAbortWhenDetailCloseFails() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-greet-not-found-"));
  const args = createArgs(tempDir);
  args.postAction = "greet";
  args.maxGreetCount = 5;
  args.__provided.maxGreetCount = true;

  const first = { key: "candidate-a", geek_id: "candidate-a", name: "candidate-a" };
  const second = { key: "candidate-b", geek_id: "candidate-b", name: "candidate-b" };
  const cli = new FakeRecoverableGreetFailureCli(args, {
    candidates: [first, second],
    captureOutcomes: new Map([
      [first.key, { stitchedImage: path.join(tempDir, "candidate-a.png") }],
      [second.key, { stitchedImage: path.join(tempDir, "candidate-b.png") }]
    ]),
    screeningByKey: new Map([
      [first.key, { passed: true, reason: "matched", summary: "matched" }],
      [second.key, { passed: true, reason: "matched", summary: "matched" }]
    ]),
    greetErrors: new Map([[first.key, "GREET_BUTTON_NOT_FOUND"]]),
    closeFailureKeys: new Set([first.key])
  });

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.processed_count, 2);
  assert.equal(result.result.passed_count, 2);
  assert.equal(result.result.greet_count, 1);
}

async function testCloseDetailPageShouldFailWhenDetailStillOpenAndListNotReady() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-close-detail-fail-"));
  const cli = new FakeDetailCloseProbeCli(createArgs(tempDir), { listReady: false });
  const closed = await cli.closeDetailPage(1);
  assert.equal(closed, false);
}

async function testCloseDetailPageShouldContinueWhenListReady() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-close-detail-list-ready-"));
  const cli = new FakeDetailCloseProbeCli(createArgs(tempDir), { listReady: true });
  const closed = await cli.closeDetailPage(1);
  assert.equal(closed, true);
}

async function testVisionEvidenceGateShouldDemoteImageFallbackWithoutEvidence() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-vision-evidence-gate-"));
  const cli = new RecommendScreenCli(createArgs(tempDir));
  cli.prepareVisionImageSegmentsForModel = async () => ({
    imagePaths: ["segment-1"],
    source: "test",
    sourcePixels: 100,
    currentPixels: 100
  });
  cli.requestVisionModel = async () => ({
    passed: true,
    rawPassed: true,
    reason: "matched",
    summary: "matched",
    evidence: []
  });
  const result = await cli.callVisionModel(path.join(tempDir, "fake.png"));
  assert.equal(result.rawPassed, true);
  assert.equal(result.passed, false);
  assert.equal(result.evidenceGateDemoted, true);
  assert.equal(result.evidenceRawCount, 0);
  assert.equal(result.evidenceMatchedCount, 0);
}

async function testVisionModelShouldSendAllOrderedChunks() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-vision-all-chunks-"));
  const chunkPaths = [];
  for (let index = 0; index < 3; index += 1) {
    const chunkPath = path.join(tempDir, `chunk-${index + 1}.png`);
    await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 255 - index, g: 250, b: 245 } }
    }).png().toFile(chunkPath);
    chunkPaths.push(chunkPath);
  }
  const cli = new RecommendScreenCli(createArgs(tempDir));
  const originalFetch = global.fetch;
  let capturedPayload = null;
  global.fetch = async (_url, options = {}) => {
    capturedPayload = JSON.parse(String(options.body || "{}"));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "{\"passed\": false, \"reason\": \"checked all chunks\", \"summary\": \"checked\", \"evidence\": [\"chunk evidence\", \"more evidence\"]}"
              }
            }
          ]
        };
      }
    };
  };
  try {
    const result = await cli.requestVisionModel(chunkPaths);
    assert.equal(result.passed, false);
    const userContent = capturedPayload?.messages?.[1]?.content || [];
    assert.equal(userContent.filter((item) => item?.type === "image_url").length, 3);
    const text = userContent.map((item) => item?.text || "").join("\n");
    assert.equal(text.includes("简历分段 1/3"), true);
    assert.equal(text.includes("简历分段 2/3"), true);
    assert.equal(text.includes("简历分段 3/3"), true);
    assert.equal(text.includes("不能只根据前几段下结论"), true);
  } finally {
    global.fetch = originalFetch;
  }
}

async function main() {
  testShouldAbortResumeProbeEarly();
  testResumeViewportStabilityRequiresSettledScrollAndClip();
  await testSingleResumeCaptureFailureIsSkipped();
  await testConsecutiveResumeCaptureFailuresStillAbort();
  await testPageExhaustedBeforeTargetShouldRaiseRecoverableError();
  await testPageExhaustedWithoutTargetShouldStillComplete();
  await testTargetCountShouldStopWhenPassedCountReached();
  await testTargetCountShouldNotTreatProcessedCountAsReached();
  await testFeaturedShouldUseNetworkResumeOnly();
  await testRecommendShouldPreferNetworkResumeWhenAvailable();
  await testNetworkMissShouldFallbackToImageThenDom();
  await testNetworkMissShouldFallbackToImageCapture();
  await testImageModeShouldUseShortNetworkGraceWindow();
  await testImageFailureShouldLateRetryNetworkBeforeDomFallback();
  await testLatestShouldPreferNetworkResumeWhenAvailable();
  await testLatestNetworkMissShouldFallbackToImageCapture();
  testLatestPayloadShouldNotLeakAcrossCandidates();
  testLatestPayloadShouldRemainAvailableWhenCandidateKeyMissing();
  await testVisionModelFailureShouldSkipCandidateAndContinue();
  await testFeaturedNetworkMissShouldFallbackToDomAfterImageFailure();
  await testFeaturedFavoriteShouldNotUseDomFallback();
  await testFeaturedFavoriteShouldSkipClickWhenAlreadyInterested();
  await testFeaturedFavoriteShouldRecognizeAlreadyFavoritedByDelThenAdd();
  await testFeaturedFavoriteWithoutCalibrationShouldFail();
  testFavoriteActionParserShouldSupportBodySignals();
  testFavoriteActionParserShouldSupportFallbackRequestShape();
  testFavoriteActionParserShouldSupportWebSocketPayload();
  testFavoriteActionParserShouldOnlyTrustKnownRequestShapes();
  testFinishedWrapClassifierShouldNotTreatLoadMoreAsBottom();
  testFormatResumeApiDataShouldPreserveEducationTagsAndProjectDescription();
  testEvidenceTokenMatcherShouldSupportParaphrasedEvidence();
  testCheckpointPayloadShouldIncludeCandidateAudits();
  testCheckpointShouldPersistAndRestoreInputSummary();
  testSaveCsvShouldIncludeAllCandidateOutcomes();
  await testGetCenteredCandidateClickPointShouldSupportLatestSelector();
  await testFeaturedPostActionFailureShouldStillRecordPassedCandidate();
  await testStitchWithSharpShouldComposeExpectedImage();
  testStitchWithAvailablePythonShouldFallbackToPython();
  testStitchWithAvailablePythonShouldFailWhenScriptMissing();
  testParseArgsShouldSupportFeaturedAliasesAndInlinePort();
  testParseArgsShouldSupportLatestPageScope();
  testParseArgsShouldSupportInputSummaryJson();
  await testCallTextModelShouldNotTruncateLongResume();
  await testCallTextModelShouldFallbackToChunkModeOnContextLimit();
  await testTextModelShouldDefaultThinkingOffForVolcengine();
  await testTextModelShouldSupportLowThinkingForVolcengine();
  await testPrepareVisionImageSegmentsShouldSplitLongImage();
  await testVisionEvidenceGateShouldDemoteImageFallbackWithoutEvidence();
  await testVisionModelShouldSendAllOrderedChunks();
  testRecoverablePostActionErrorShouldTreatGreetContinueAndNoButtonAsRecoverable();
  await testRecoverableGreetContinueButtonShouldNotAbortWhenDetailCloseFails();
  await testRecoverableGreetButtonNotFoundShouldNotAbortWhenDetailCloseFails();
  await testCloseDetailPageShouldFailWhenDetailStillOpenAndListNotReady();
  await testCloseDetailPageShouldContinueWhenListReady();
  console.log("recoverable resume failure tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
