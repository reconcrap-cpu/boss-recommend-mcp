#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertNoForbiddenCdpCalls,
  bringPageToFront,
  connectToChromeTargetOrOpen,
  enableDomains,
  sleep
} from "../src/core/browser/index.js";
import { captureScrolledNodeScreenshots } from "../src/core/capture/index.js";
import { DEFAULT_MAX_IMAGE_PAGES } from "../src/core/cv-acquisition/index.js";
import { waitForCvCaptureTarget } from "../src/core/cv-capture-target/index.js";
import {
  compactInfiniteListState,
  createInfiniteListState,
  getNextInfiniteListCandidate,
  markInfiniteListCandidateProcessed,
  resolveInfiniteListFallbackPoint
} from "../src/core/infinite-list/index.js";
import { createViewportRunGuard } from "../src/core/self-heal/viewport.js";
import {
  verifyCaptureEvidenceSafety,
  verifyScreenshotMethodSafety
} from "./live-helpers/capture-safety-proof.js";
import {
  closeRecommendDetail,
  getRecommendRoots,
  openRecommendCardDetailWithFreshRetry,
  readRecommendCardCandidate,
  RECOMMEND_CARD_SELECTOR,
  RECOMMEND_LIST_CONTAINER_SELECTORS,
  RECOMMEND_TARGET_URL,
  waitForRecommendCardNodeIds,
  waitForRecommendRoots
} from "../src/domains/recommend/index.js";

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    host: "127.0.0.1",
    port: 9222,
    candidateCount: 30,
    maxScreenshots: DEFAULT_MAX_IMAGE_PAGES,
    outputDir: path.resolve(".live-artifacts", "viewport-collapse-acceptance", timestampForPath()),
    allowNavigate: false,
    listMaxScrolls: 40,
    listSettleMs: 1200,
    captureSettleMs: 350,
    candidateDelayMs: 0,
    baselineReport: "",
    continueOnError: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--host" && next) options.host = argv[++index];
    else if (arg === "--port" && next) options.port = positiveInteger(argv[++index], options.port);
    else if (arg === "--candidate-count" && next) {
      options.candidateCount = positiveInteger(argv[++index], options.candidateCount);
    } else if (arg === "--max-screenshots" && next) {
      options.maxScreenshots = positiveInteger(argv[++index], options.maxScreenshots);
    } else if (arg === "--output-dir" && next) options.outputDir = path.resolve(argv[++index]);
    else if (arg === "--allow-navigate") options.allowNavigate = true;
    else if (arg === "--list-max-scrolls" && next) {
      options.listMaxScrolls = positiveInteger(argv[++index], options.listMaxScrolls);
    } else if (arg === "--list-settle-ms" && next) {
      options.listSettleMs = Math.max(0, Number(argv[++index]) || 0);
    } else if (arg === "--capture-settle-ms" && next) {
      options.captureSettleMs = Math.max(0, Number(argv[++index]) || 0);
    } else if (arg === "--candidate-delay-ms" && next) {
      options.candidateDelayMs = Math.max(0, Number(argv[++index]) || 0);
    } else if (arg === "--baseline-report" && next) {
      options.baselineReport = path.resolve(argv[++index]);
    } else if (arg === "--continue-on-error") options.continueOnError = true;
  }
  return options;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(filePath, value) {
  const resolved = path.resolve(filePath);
  ensureDir(path.dirname(resolved));
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return resolved;
}

function percentile(values = [], ratio = 0.5) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = Math.max(0, Math.min(1, ratio)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return Math.round(sorted[lower]);
  return Math.round(sorted[lower] + ((sorted[upper] - sorted[lower]) * (position - lower)));
}

function canonicalMethod(method) {
  return String(method || "").replace(/:retry_after_reconnect$/, "");
}

export function summarizeMethodLog(methodLog = []) {
  assertNoForbiddenCdpCalls(methodLog);
  const methodCounts = {};
  for (const entry of methodLog) {
    methodCounts[entry.method] = (methodCounts[entry.method] || 0) + 1;
  }
  const screenshotCalls = methodLog.filter((entry) => canonicalMethod(entry.method) === "Page.captureScreenshot");
  const connectionEpochs = Array.from(new Set(
    methodLog.map((entry) => Number(entry.connection_epoch)).filter(Number.isInteger)
  )).sort((a, b) => a - b);
  return {
    method_count: methodLog.length,
    method_counts: methodCounts,
    screenshot_method_count: screenshotCalls.length,
    screenshot_retry_count: methodLog.filter((entry) => entry.method === "Page.captureScreenshot:retry_after_reconnect").length,
    screenshot_connection_epochs: Array.from(new Set(
      screenshotCalls.map((entry) => Number(entry.connection_epoch)).filter(Number.isInteger)
    )).sort((a, b) => a - b),
    connection_epochs: connectionEpochs,
    connection_epoch_change_count: Math.max(0, connectionEpochs.length - 1),
    forbidden_method_count: 0
  };
}

function summarizeCapture(evidence = null, safetyProof = null) {
  if (!evidence) return null;
  const ledger = Array.isArray(evidence.coverage_ledger) ? evidence.coverage_ledger : [];
  return {
    ok: evidence.ok === true,
    coverage_complete: evidence.coverage_complete === true,
    coverage_terminal_reason: evidence.coverage_terminal_reason || null,
    coverage_limit_reached: Boolean(evidence.coverage_limit_reached),
    capture_count: evidence.capture_count || 0,
    screenshot_count: evidence.screenshot_count || 0,
    dropped_duplicate_count: evidence.dropped_duplicate_count || 0,
    browser_clip_used: Boolean(evidence.optimization?.browser_clip_used),
    capture_beyond_viewport: Boolean(evidence.optimization?.capture_beyond_viewport),
    file_paths: evidence.file_paths || [],
    screenshot_timings_ms: ledger.map((entry) => Number(entry?.timing?.total_elapsed_ms)).filter(Number.isFinite),
    transport_timings_ms: ledger.map((entry) => Number(entry?.timing?.transport_elapsed_ms)).filter(Number.isFinite),
    capture_operations: ledger.map((entry) => ({
      capture_index: entry.capture_index,
      operation_id: entry.capture_operation_id || null,
      connection_epoch: entry.connection_epoch ?? null,
      crop_geometry: entry.crop_geometry || null,
      image_dimensions: entry.image_dimensions || null,
      viewport_comparison: entry.viewport_comparison || null,
      overlap_with_previous: entry.overlap_with_previous || null,
      timing: entry.timing || null
    })),
    safety_proof: safetyProof,
    viewport_events: evidence.viewport_events || []
  };
}

function readBaseline(filePath) {
  if (!filePath) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function buildPerformanceSummary(candidates = [], baseline = null) {
  const candidateMs = candidates.map((item) => Number(item.elapsed_ms)).filter(Number.isFinite);
  const screenshotMs = candidates.flatMap((item) => item.capture?.screenshot_timings_ms || []);
  const current = {
    candidate_median_ms: percentile(candidateMs, 0.5),
    candidate_p90_ms: percentile(candidateMs, 0.9),
    screenshot_median_ms: percentile(screenshotMs, 0.5),
    screenshot_p90_ms: percentile(screenshotMs, 0.9),
    screenshot_max_ms: screenshotMs.length ? Math.max(...screenshotMs) : null
  };
  const baselineCandidates = Array.isArray(baseline?.candidates) ? baseline.candidates : [];
  const baselineCandidateMs = baselineCandidates
    .map((item) => Number(item.elapsed_ms))
    .filter(Number.isFinite);
  const baselineScreenshotMs = baselineCandidates.flatMap(
    (item) => item.capture?.screenshot_timings_ms || []
  ).map(Number).filter(Number.isFinite);
  const derivedBaselineTiming = baselineCandidateMs.length || baselineScreenshotMs.length
    ? {
        candidate_median_ms: percentile(baselineCandidateMs, 0.5),
        candidate_p90_ms: percentile(baselineCandidateMs, 0.9),
        screenshot_median_ms: percentile(baselineScreenshotMs, 0.5),
        screenshot_p90_ms: percentile(baselineScreenshotMs, 0.9),
        screenshot_max_ms: baselineScreenshotMs.length ? Math.max(...baselineScreenshotMs) : null
      }
    : null;
  const declaredBaselineTiming = baseline?.timing || baseline?.performance?.current || null;
  const baselineTiming = declaredBaselineTiming || derivedBaselineTiming
    ? { ...(derivedBaselineTiming || {}), ...(declaredBaselineTiming || {}) }
    : null;
  if (!baselineTiming) return { current, baseline: null, limits_evaluated: false, passed: null };
  const requiredBaselineMetrics = [
    "candidate_median_ms",
    "candidate_p90_ms",
    "screenshot_median_ms",
    "screenshot_p90_ms",
    "screenshot_max_ms"
  ];
  const missingBaselineMetrics = requiredBaselineMetrics.filter(
    (key) => !Number.isFinite(Number(baselineTiming[key]))
  );
  if (missingBaselineMetrics.length) {
    return {
      current,
      baseline: baselineTiming,
      limits_evaluated: false,
      passed: null,
      missing_baseline_metrics: missingBaselineMetrics
    };
  }
  const regression = {
    candidate_median_ms: current.candidate_median_ms - Number(baselineTiming.candidate_median_ms),
    candidate_p90_ms: current.candidate_p90_ms - Number(baselineTiming.candidate_p90_ms),
    screenshot_median_ms: current.screenshot_median_ms - Number(baselineTiming.screenshot_median_ms),
    screenshot_p90_ms: current.screenshot_p90_ms - Number(baselineTiming.screenshot_p90_ms),
    screenshot_max_ms: current.screenshot_max_ms - Number(baselineTiming.screenshot_max_ms)
  };
  const limits = {
    candidate_median_ms: 1000,
    candidate_p90_ms: 2000,
    screenshot_median_ms: 150,
    screenshot_p90_ms: 150,
    screenshot_max_ms: 150
  };
  return {
    current,
    baseline: baselineTiming,
    regression,
    limits,
    limits_evaluated: true,
    passed: Object.keys(limits).every((key) => Number(regression[key]) <= limits[key])
  };
}

export function resolveAcceptanceStatus(failureReasons = [], incompleteReasons = []) {
  if (failureReasons.length) return "FAIL";
  if (incompleteReasons.length) return "INCOMPLETE";
  return "PASS";
}

async function runAcceptance(options) {
  const outputDir = ensureDir(options.outputDir);
  const imageDir = ensureDir(path.join(outputDir, "images"));
  const candidateDir = ensureDir(path.join(outputDir, "candidates"));
  const startedAt = Date.now();
  const results = [];
  const frameResizeEvents = [];
  const observer = { candidateIndex: null, phase: "connect" };
  let session = null;
  let viewportGuard = null;
  let listState = null;
  let terminalReason = "";

  try {
    session = await connectToChromeTargetOrOpen({
      host: options.host,
      port: options.port,
      targetUrlIncludes: "/web/chat/recommend",
      targetUrl: RECOMMEND_TARGET_URL,
      allowNavigate: options.allowNavigate,
      slowLive: false,
      launchIfMissing: false
    });
    const { client } = session;
    await enableDomains(client, ["Page", "DOM", "Input", "Network", "Accessibility"]);
    client.Page.frameResized(() => {
      frameResizeEvents.push({
        at: new Date().toISOString(),
        at_ms: Date.now(),
        candidate_index: observer.candidateIndex,
        phase: observer.phase,
        connection_epoch: client.__connectionEpoch ?? null
      });
    });
    await bringPageToFront(client);
    await closeRecommendDetail(client, { attemptsLimit: 2 }).catch(() => null);
    let rootState = await waitForRecommendRoots(client, { timeoutMs: 20000, intervalMs: 400 });
    if (!rootState?.iframe?.documentNodeId) throw new Error("recommend iframe was not ready");

    viewportGuard = createViewportRunGuard({
      client,
      domain: "recommend-viewport-acceptance",
      root: "frame",
      frameOwnerRoot: "frameOwner",
      getRoots: getRecommendRoots,
      maxEvents: Math.max(100, options.candidateCount * 4)
    });
    rootState = (await viewportGuard.ensure(rootState, { phase: "initial" })).rootState;
    listState = createInfiniteListState({ domain: "recommend", listName: "viewport-collapse-acceptance" });

    while (results.length < options.candidateCount) {
      observer.candidateIndex = results.length;
      observer.phase = "list";
      const next = await getNextInfiniteListCandidate({
        client,
        state: listState,
        maxScrolls: options.listMaxScrolls,
        stableSignatureLimit: 3,
        wheelDeltaY: 850,
        settleMs: options.listSettleMs,
        fallbackPoint: async ({ items = [] }) => {
          const roots = await getRecommendRoots(client);
          return resolveInfiniteListFallbackPoint(client, {
            rootNodeId: roots.iframe?.documentNodeId || 0,
            containerSelectors: RECOMMEND_LIST_CONTAINER_SELECTORS,
            itemNodeIds: items.map((item) => item.node_id).filter(Boolean),
            itemSelectors: [RECOMMEND_CARD_SELECTOR],
            viewportPoint: { xRatio: 0.28, yRatio: 0.5 },
            validateViewportPoint: true
          });
        },
        findNodeIds: async () => {
          rootState = await getRecommendRoots(client);
          return waitForRecommendCardNodeIds(client, rootState.iframe.documentNodeId, {
            timeoutMs: 15000,
            intervalMs: 400
          });
        },
        readCandidate: (nodeId, { visibleIndex }) => readRecommendCardCandidate(client, nodeId, {
          source: "viewport-collapse-live-acceptance",
          metadata: { visible_index: visibleIndex }
        })
      });
      if (!next.ok) {
        terminalReason = next.reason || "candidate_list_exhausted";
        break;
      }

      const index = results.length;
      const candidateStarted = Date.now();
      const result = {
        index,
        candidate_key: next.item.key,
        candidate: {
          id: next.item.candidate?.id || null,
          identity: next.item.candidate?.identity || {}
        },
        post_action: "none",
        capture: null,
        error: null
      };
      let captureStarted = null;
      let captureEnded = null;
      try {
        rootState = (await viewportGuard.ensure(rootState, { phase: `candidate_${index + 1}_before` })).rootState;
        observer.phase = "open_detail";
        const opened = await openRecommendCardDetailWithFreshRetry(client, {
          cardNodeId: next.item.node_id,
          candidateKey: next.item.key,
          cardCandidate: next.item.candidate,
          rootState,
          maxAttempts: 3,
          timeoutMs: 15000
        });
        observer.phase = "target";
        const targetWait = await waitForCvCaptureTarget(client, opened.detail_state, {
          domain: "recommend",
          timeoutMs: 10000,
          intervalMs: 250
        });
        if (!targetWait.target?.node_id) throw new Error("stable CV capture target was not found");
        observer.phase = "capture";
        captureStarted = Date.now();
        const evidence = await captureScrolledNodeScreenshots(client, targetWait.target.node_id, {
          filePath: path.join(imageDir, `candidate-${String(index + 1).padStart(3, "0")}.jpg`),
          format: "jpeg",
          quality: 72,
          optimize: true,
          resizeMaxWidth: 1100,
          captureViewport: false,
          captureBeyondViewport: false,
          fromSurface: true,
          iframeOwnerNodeId: targetWait.target.iframe_node_id || null,
          padding: 0,
          maxScreenshots: options.maxScreenshots,
          wheelDeltaY: 650,
          settleMs: options.captureSettleMs,
          scrollMethod: "dom-anchor-fallback-input",
          stepTimeoutMs: 45000,
          totalTimeoutMs: 180000,
          duplicateStopCount: 2,
          skipDuplicateScreenshots: true,
          requireTerminalProof: true,
          composeForLlm: false,
          metadata: {
            domain: "recommend",
            post_action: "none",
            candidate_index: index,
            candidate_key: next.item.key,
            capture_target: targetWait.target
          }
        });
        captureEnded = Date.now();
        result.capture_target = targetWait.target;
        result.capture_target_wait_ms = targetWait.elapsed_ms || 0;
        const safetyProof = verifyCaptureEvidenceSafety(evidence);
        result.capture = summarizeCapture(evidence, safetyProof);
        if (!safetyProof.ok) {
          const error = new Error(`CV capture safety proof failed: ${JSON.stringify(safetyProof.issues)}`);
          error.code = "CV_CAPTURE_SAFETY_PROOF_FAILED";
          throw error;
        }
        result.evidence_path = writeJson(
          path.join(candidateDir, `candidate-${String(index + 1).padStart(3, "0")}.json`),
          { target_wait: targetWait, evidence }
        );
        if (!evidence.ok || !evidence.coverage_complete) {
          const error = new Error(evidence.error || "CV coverage was incomplete");
          error.code = evidence.error_code || "IMAGE_CAPTURE_COVERAGE_INCOMPLETE";
          throw error;
        }
      } catch (error) {
        captureEnded ??= Date.now();
        result.error = { code: error?.code || null, message: error?.message || String(error) };
      } finally {
        observer.phase = "close_detail";
        result.close_result = await closeRecommendDetail(client, { attemptsLimit: 3 }).catch((error) => ({
          closed: false,
          error: error?.message || String(error)
        }));
        result.elapsed_ms = Date.now() - candidateStarted;
        result.capture_window = captureStarted == null ? null : {
          started_at_ms: captureStarted,
          ended_at_ms: captureEnded,
          frame_resize_events: frameResizeEvents.filter((event) => (
            event.at_ms >= captureStarted && event.at_ms <= captureEnded
          ))
        };
        try {
          rootState = await getRecommendRoots(client);
          await viewportGuard.ensure(rootState, { phase: `candidate_${index + 1}_after` });
        } catch (error) {
          result.error ||= { code: error?.code || "VIEWPORT_GUARD_FAILED", message: error?.message || String(error) };
        }
      }

      results.push(result);
      markInfiniteListCandidateProcessed(listState, next.item.key, {
        status: result.error ? "failed" : "captured",
        metadata: { result_index: index, coverage_complete: Boolean(result.capture?.coverage_complete) }
      });
      if (result.error && !options.continueOnError) {
        terminalReason = result.error.code || "candidate_error";
        break;
      }
      if (options.candidateDelayMs > 0) await sleep(options.candidateDelayMs);
    }

    const methodSummary = summarizeMethodLog(session.methodLog || []);
    const screenshotMethodSafety = verifyScreenshotMethodSafety(session.methodLog || []);
    const methodLogPath = writeJson(path.join(outputDir, "cdp-method-log.json"), session.methodLog || []);
    const baseline = readBaseline(options.baselineReport);
    const performance = buildPerformanceSummary(results, baseline);
    const viewportStats = viewportGuard.getStats();
    const screenshotCorrelatedResizeEvents = results.flatMap(
      (item) => item.capture_window?.frame_resize_events || []
    );
    const failureReasons = [];
    const incompleteReasons = [];
    if (results.length < options.candidateCount) failureReasons.push("candidate_count_not_reached");
    if (results.some((item) => item.error)) failureReasons.push("candidate_errors_present");
    if (results.some((item) => item.capture?.coverage_complete !== true)) failureReasons.push("coverage_incomplete");
    if (results.some((item) => item.capture?.browser_clip_used)) failureReasons.push("browser_clip_used");
    if (results.some((item) => item.capture?.capture_beyond_viewport)) failureReasons.push("capture_beyond_viewport_used");
    if (methodSummary.screenshot_retry_count > 0) failureReasons.push("screenshot_replayed_after_reconnect");
    if (!screenshotMethodSafety.ok) failureReasons.push("screenshot_method_safety_failed");
    if (results.some((item) => item.capture?.safety_proof?.ordering_ok !== true)) failureReasons.push("capture_ordering_invalid");
    if (results.some((item) => item.capture?.safety_proof?.overlap_ok !== true)) failureReasons.push("capture_overlap_below_minimum");
    if (results.some((item) => item.capture?.safety_proof?.ok !== true)) failureReasons.push("capture_artifact_safety_unverified");
    if (screenshotCorrelatedResizeEvents.length > 0) failureReasons.push("screenshot_correlated_viewport_resize");
    if (viewportStats.recoveries > 0 || viewportStats.failures > 0) failureReasons.push("viewport_guard_recovery_or_failure");
    if (performance.passed === false) failureReasons.push("performance_regression_limit_exceeded");
    if (!performance.limits_evaluated) incompleteReasons.push("performance_baseline_missing");

    const status = resolveAcceptanceStatus(failureReasons, incompleteReasons);
    const uncroppedViewportImagesPersisted = results.some(
      (item) => item.capture?.safety_proof?.uncropped_viewport_images_persisted === true
    );

    return {
      schema_version: 1,
      status,
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
      request: {
        domain: "recommend",
        candidate_count: options.candidateCount,
        post_action: "none",
        allow_navigate: options.allowNavigate,
        max_screenshots: options.maxScreenshots,
        fixed_candidate_delay_ms: options.candidateDelayMs
      },
      safety: {
        ...methodSummary,
        screenshot_method_safety: screenshotMethodSafety,
        screenshot_correlated_frame_resize_event_count: screenshotCorrelatedResizeEvents.length,
        uncropped_viewport_images_persisted: uncroppedViewportImagesPersisted,
        crop_artifact_proofs: results.map((item) => item.capture?.safety_proof || null)
      },
      coverage: {
        requested_candidates: options.candidateCount,
        attempted_candidates: results.length,
        complete_candidates: results.filter((item) => item.capture?.coverage_complete === true).length,
        incomplete_candidates: results.filter((item) => item.capture?.coverage_complete !== true).length,
        screenshot_count: results.reduce((sum, item) => sum + (item.capture?.screenshot_count || 0), 0)
      },
      performance,
      viewport: {
        stats: viewportStats,
        events: viewportGuard.getEvents(),
        frame_resize_events: frameResizeEvents,
        screenshot_correlated_frame_resize_events: screenshotCorrelatedResizeEvents
      },
      candidate_list: compactInfiniteListState(listState),
      terminal_reason: terminalReason || null,
      failure_reasons: failureReasons,
      incomplete_reasons: incompleteReasons,
      model_boundary: {
        live_evaluated: false,
        status: "not_live_evaluated",
        fail_closed_unit_tested: true,
        unit_test_command: "npm run test:core-cv-acquisition"
      },
      artifacts: {
        output_dir: outputDir,
        image_dir: imageDir,
        candidate_dir: candidateDir,
        cdp_method_log_path: methodLogPath
      },
      candidates: results
    };
  } finally {
    observer.phase = "close_session";
    if (session) await session.close();
  }
}

async function main() {
  const options = parseArgs();
  ensureDir(options.outputDir);
  let report;
  try {
    report = await runAcceptance(options);
  } catch (error) {
    report = {
      schema_version: 1,
      status: "FAIL",
      generated_at: new Date().toISOString(),
      request: { domain: "recommend", candidate_count: options.candidateCount, post_action: "none" },
      error: { code: error?.code || null, message: error?.message || String(error) },
      artifacts: { output_dir: options.outputDir }
    };
  }
  const reportPath = writeJson(path.join(options.outputDir, "summary.json"), report);
  if (Array.isArray(report.viewport?.frame_resize_events)) {
    writeJson(path.join(options.outputDir, "frame-resize-events.json"), report.viewport.frame_resize_events);
  }
  console.log(JSON.stringify({ ...report, candidates: undefined, report_path: reportPath }, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
}

const isMain = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();

export { runAcceptance };
