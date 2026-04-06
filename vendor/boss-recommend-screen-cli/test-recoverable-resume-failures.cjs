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
    pageScope: "recommend",
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
      pageScope: true,
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

async function testRecommendShouldKeepImageCaptureEvenWhenNetworkResumeExists() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-recommend-image-main-"));
  const candidate = { key: "img-main-1", geek_id: "img-main-1", name: "recommend image main candidate" };
  const cli = new FakeRecommendScreenCli(createArgs(tempDir), {
    candidates: [candidate],
    captureOutcomes: new Map([
      ["img-main-1", { stitchedImage: path.join(tempDir, "img-main-1.png") }]
    ]),
    screeningByKey: new Map([
      ["img-main-1", { passed: true, reason: "image path used", summary: "image path used" }]
    ])
  });
  cli.waitForNetworkResumeCandidateInfo = async () => ({
    resumeText: "这段 network 文本在 recommend 页面不应被用于筛选"
  });
  cli.callTextModel = async () => {
    throw new Error("text model should not be called for recommend scope");
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.passed_count, 1);
  assert.equal(result.result.resume_source, "image_fallback");
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

async function testFeaturedNetworkMissShouldSkipWithoutImageCapture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-screen-featured-network-only-"));
  const args = createArgs(tempDir);
  args.pageScope = "featured";
  const candidate = { key: "featured-no-network", geek_id: "featured-no-network", name: "featured no network" };
  const cli = new FakeRecommendScreenCli(args, {
    candidates: [candidate]
  });
  cli.waitForNetworkResumeCandidateInfo = async () => null;
  cli.captureResumeImage = async () => {
    throw new Error("capture should not be called for featured scope");
  };

  const result = await cli.run();
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.processed_count, 1);
  assert.equal(result.result.passed_count, 0);
  assert.equal(result.result.skipped_count, 1);
  assert.equal(result.result.resume_source, "network");
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

async function main() {
  testShouldAbortResumeProbeEarly();
  await testSingleResumeCaptureFailureIsSkipped();
  await testConsecutiveResumeCaptureFailuresStillAbort();
  await testPageExhaustedBeforeTargetShouldRaiseRecoverableError();
  await testPageExhaustedWithoutTargetShouldStillComplete();
  await testFeaturedShouldUseNetworkResumeOnly();
  await testRecommendShouldKeepImageCaptureEvenWhenNetworkResumeExists();
  await testNetworkMissShouldFallbackToImageCapture();
  await testVisionModelFailureShouldSkipCandidateAndContinue();
  await testFeaturedNetworkMissShouldSkipWithoutImageCapture();
  await testFeaturedFavoriteShouldNotUseDomFallback();
  await testFeaturedFavoriteShouldSkipClickWhenAlreadyInterested();
  await testFeaturedFavoriteShouldRecognizeAlreadyFavoritedByDelThenAdd();
  await testFeaturedFavoriteWithoutCalibrationShouldFail();
  testFavoriteActionParserShouldSupportBodySignals();
  testFavoriteActionParserShouldSupportFallbackRequestShape();
  testFavoriteActionParserShouldSupportWebSocketPayload();
  testFavoriteActionParserShouldOnlyTrustKnownRequestShapes();
  testFinishedWrapClassifierShouldNotTreatLoadMoreAsBottom();
  await testGetCenteredCandidateClickPointShouldSupportLatestSelector();
  await testFeaturedPostActionFailureShouldStillRecordPassedCandidate();
  await testStitchWithSharpShouldComposeExpectedImage();
  testStitchWithAvailablePythonShouldFallbackToPython();
  testStitchWithAvailablePythonShouldFailWhenScriptMissing();
  testParseArgsShouldSupportFeaturedAliasesAndInlinePort();
  testParseArgsShouldSupportLatestPageScope();
  console.log("recoverable resume failure tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
