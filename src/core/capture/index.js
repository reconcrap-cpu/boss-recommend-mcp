import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import {
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
  querySelectorAll,
  sleep
} from "../browser/index.js";
import {
  htmlToText,
  normalizeText
} from "../screening/index.js";

function nowIso() {
  return new Date().toISOString();
}

function resolveOutputPath(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function withPadding(rect, padding = 0) {
  const safePadding = Math.max(0, Number(padding) || 0);
  const x = Math.max(0, rect.x - safePadding);
  const y = Math.max(0, rect.y - safePadding);
  return {
    x,
    y,
    width: Math.max(1, rect.width + safePadding * 2 - (rect.x - x)),
    height: Math.max(1, rect.height + safePadding * 2 - (rect.y - y)),
    scale: 1
  };
}

function normalizeRandom(random) {
  return typeof random === "function" ? random : Math.random;
}

function randomBetween(random, min, max) {
  const lower = Number(min) || 0;
  const upper = Number(max) || lower;
  if (upper <= lower) return lower;
  return lower + normalizeRandom(random)() * (upper - lower);
}

function normalizeRatio(raw, fallback, { min = 0, max = 1 } = {}) {
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeScrollDeltaJitter({
  enabled = false,
  minRatio = 0.65,
  maxRatio = 0.9,
  minOverlapRatio = 0.2,
  preserveCoverage = true,
  random = Math.random
} = {}) {
  const safeMinRatio = normalizeRatio(minRatio, 0.65, { min: 0.1, max: 1 });
  const safeMaxRatio = Math.max(safeMinRatio, normalizeRatio(maxRatio, 0.9, { min: safeMinRatio, max: 1 }));
  return {
    enabled: enabled === true,
    min_ratio: safeMinRatio,
    max_ratio: safeMaxRatio,
    min_overlap_ratio: normalizeRatio(minOverlapRatio, 0.2, { min: 0, max: 0.8 }),
    preserve_coverage: preserveCoverage !== false,
    random: normalizeRandom(random)
  };
}

function resolveCoverageSafeScrollDelta({
  baseDelta,
  clipHeight,
  jitter
} = {}) {
  const safeBase = Math.max(1, Number(baseDelta) || 650);
  if (!jitter?.enabled) {
    return {
      deltaY: safeBase,
      jittered: false,
      base_delta_y: safeBase
    };
  }
  const safeClipHeight = Math.max(1, Number(clipHeight) || 1);
  const maxDeltaForOverlap = Math.max(1, Math.floor(safeClipHeight * (1 - jitter.min_overlap_ratio)));
  const upper = Math.max(1, Math.min(Math.round(safeBase * jitter.max_ratio), maxDeltaForOverlap));
  const lower = Math.min(upper, Math.max(1, Math.round(safeBase * jitter.min_ratio)));
  const deltaY = Math.max(1, Math.round(randomBetween(jitter.random, lower, upper)));
  return {
    deltaY,
    jittered: true,
    base_delta_y: safeBase,
    min_delta_y: lower,
    max_delta_y: upper,
    min_ratio: jitter.min_ratio,
    max_ratio: jitter.max_ratio,
    min_overlap_ratio: jitter.min_overlap_ratio,
    clip_height: safeClipHeight,
    max_delta_for_overlap: maxDeltaForOverlap,
    preserve_coverage: jitter.preserve_coverage
  };
}

export async function captureNodeHtml(client, nodeId, {
  domain = "unknown",
  source = "dom",
  metadata = {}
} = {}) {
  const [attributes, outerHTML] = await Promise.all([
    getAttributesMap(client, nodeId),
    getOuterHTML(client, nodeId)
  ]);
  const text = htmlToText(outerHTML);
  return {
    schema_version: 1,
    domain: normalizeText(domain) || "unknown",
    source,
    captured_at: nowIso(),
    node_id: nodeId,
    attributes,
    outer_html_length: outerHTML.length,
    text_length: text.length,
    text,
    outer_html: outerHTML,
    metadata
  };
}

export async function captureNodeScreenshot(client, nodeId, {
  filePath,
  format = "png",
  quality,
  padding = 0,
  captureBeyondViewport = true,
  fromSurface = true,
  metadata = {}
} = {}) {
  const box = await getNodeBox(client, nodeId);
  const clip = withPadding(box.rect, padding);
  const captureOptions = {
    format,
    fromSurface,
    captureBeyondViewport,
    clip
  };
  if (quality != null) {
    captureOptions.quality = quality;
  }
  const screenshot = await client.Page.captureScreenshot(captureOptions);
  const buffer = Buffer.from(screenshot.data || "", "base64");
  const resolvedPath = resolveOutputPath(filePath);
  if (resolvedPath) {
    fs.writeFileSync(resolvedPath, buffer);
  }
  return {
    schema_version: 1,
    source: "image",
    captured_at: nowIso(),
    node_id: nodeId,
    format,
    mime_type: `image/${format === "jpeg" ? "jpeg" : "png"}`,
    byte_length: buffer.length,
    file_path: resolvedPath,
    clip,
    node_rect: box.rect,
    metadata
  };
}

export async function captureViewportScreenshot(client, {
  filePath,
  format = "png",
  quality,
  captureBeyondViewport = false,
  fromSurface = true,
  metadata = {}
} = {}) {
  const captureOptions = {
    format,
    fromSurface,
    captureBeyondViewport
  };
  if (quality != null) {
    captureOptions.quality = quality;
  }
  const screenshot = await client.Page.captureScreenshot(captureOptions);
  const buffer = Buffer.from(screenshot.data || "", "base64");
  const resolvedPath = resolveOutputPath(filePath);
  if (resolvedPath) {
    fs.writeFileSync(resolvedPath, buffer);
  }
  return {
    schema_version: 1,
    source: "viewport-image",
    captured_at: nowIso(),
    format,
    mime_type: `image/${format === "jpeg" ? "jpeg" : "png"}`,
    byte_length: buffer.length,
    file_path: resolvedPath,
    capture_beyond_viewport: Boolean(captureBeyondViewport),
    metadata
  };
}

function filePathForSequence(basePath, index, extension) {
  const resolved = resolveOutputPath(basePath);
  if (!resolved) return null;
  const parsed = path.parse(resolved);
  const page = String(index + 1).padStart(2, "0");
  return path.join(parsed.dir, `${parsed.name}-page-${page}${parsed.ext || `.${extension}`}`);
}

function filePathForLlmSequence(basePath, index) {
  const resolved = resolveOutputPath(basePath);
  if (!resolved) return null;
  const parsed = path.parse(resolved);
  const page = String(index + 1).padStart(2, "0");
  return path.join(parsed.dir, `${parsed.name}-llm-${page}.jpg`);
}

function screenshotHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createCaptureTimeoutError(label, timeoutMs) {
  const error = new Error(`Image fallback capture timed out during ${label} after ${timeoutMs}ms`);
  error.code = "IMAGE_CAPTURE_TIMEOUT";
  error.capture_step = label;
  error.timeout_ms = timeoutMs;
  return error;
}

async function withCaptureTimeout(promise, {
  label = "capture_step",
  timeoutMs = 0
} = {}) {
  const safeTimeout = Math.max(0, Number(timeoutMs) || 0);
  if (!safeTimeout) return promise;
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createCaptureTimeoutError(label, safeTimeout)), safeTimeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertCaptureTotalBudget(started, totalTimeoutMs, label) {
  const safeTimeout = Math.max(0, Number(totalTimeoutMs) || 0);
  if (!safeTimeout) return;
  const elapsed = Date.now() - started;
  if (elapsed <= safeTimeout) return;
  const error = createCaptureTimeoutError(label, safeTimeout);
  error.elapsed_ms = elapsed;
  error.code = "IMAGE_CAPTURE_TOTAL_TIMEOUT";
  throw error;
}

const DEFAULT_SCROLL_ANCHOR_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "p",
  "li",
  "section",
  "article",
  "table",
  "tr",
  "dl",
  "dt",
  "dd",
  "[class*='resume']",
  "[class*='work']",
  "[class*='project']",
  "[class*='education']",
  "[class*='experience']",
  "[class*='item']",
  "div"
].join(",");

function normalizeScrollMethod(value = "dom-anchor-fallback-input") {
  const normalized = normalizeText(value).toLowerCase();
  if (["dom", "dom-anchor", "dom_anchor", "anchor"].includes(normalized)) return "dom-anchor";
  if (["dom-anchor-fallback-input", "dom_anchor_fallback_input", "dom-fallback-input"].includes(normalized)) {
    return "dom-anchor-fallback-input";
  }
  return "input";
}

function uniqueNumbers(values = []) {
  return Array.from(new Set(values.map((value) => Number(value) || 0).filter(Boolean)));
}

function pickEvenly(items = [], limit = 1) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  if (items.length <= safeLimit) return items;
  const picked = [];
  const last = items.length - 1;
  for (let index = 0; index < safeLimit; index += 1) {
    const sourceIndex = Math.round((index * last) / Math.max(1, safeLimit - 1));
    picked.push(items[sourceIndex]);
  }
  return Array.from(new Map(picked.map((item) => [item.node_id, item])).values());
}

function patternLabel(pattern) {
  if (pattern instanceof RegExp) return pattern.source;
  return normalizeText(pattern);
}

function stopBoundaryPatterns(patterns = []) {
  return (Array.isArray(patterns) ? patterns : [patterns])
    .filter(Boolean)
    .map((pattern) => {
      if (pattern instanceof RegExp) {
        return {
          raw: pattern,
          label: pattern.source,
          matches: (text) => pattern.test(text)
        };
      }
      const normalized = normalizeText(pattern);
      return {
        raw: pattern,
        label: normalized,
        matches: (text) => normalized && text.includes(normalized)
      };
    });
}

async function collectStopBoundaryNodes(client, rootNodeId, {
  selector = "",
  textPatterns = [],
  maxProbeNodes = 180,
  maxTextLength = 700,
  stepTimeoutMs = 45000
} = {}) {
  const patterns = stopBoundaryPatterns(textPatterns);
  const normalizedSelector = normalizeText(selector);
  if (!normalizedSelector && !patterns.length) {
    return {
      enabled: false,
      ok: false,
      reason: "not_configured",
      nodes: []
    };
  }
  const started = Date.now();
  let nodeIds = [];
  try {
    nodeIds = uniqueNumbers(await querySelectorAll(
      client,
      rootNodeId,
      normalizedSelector || DEFAULT_SCROLL_ANCHOR_SELECTOR
    ));
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      reason: "query_selector_all_failed",
      selector: normalizedSelector || DEFAULT_SCROLL_ANCHOR_SELECTOR,
      error: error?.message || String(error),
      nodes: []
    };
  }

  const probeLimit = Math.max(1, Number(maxProbeNodes) || 180);
  const maxStopTextLength = Math.max(40, Number(maxTextLength) || 700);
  const perNodeTimeoutMs = Math.min(1000, Math.max(200, Math.floor((Number(stepTimeoutMs) || 45000) / 40)));
  const nodes = [];
  for (const nodeId of nodeIds.slice(0, probeLimit)) {
    try {
      let text = "";
      let matchedPattern = null;
      if (patterns.length) {
        const outerHTML = await withCaptureTimeout(getOuterHTML(client, nodeId), {
          label: `stop_boundary_html_${nodeId}`,
          timeoutMs: perNodeTimeoutMs
        });
        text = normalizeText(htmlToText(outerHTML));
        if (!text || text.length > maxStopTextLength) continue;
        matchedPattern = patterns.find((pattern) => pattern.matches(text));
        if (!matchedPattern) continue;
      }
      nodes.push({
        node_id: nodeId,
        text_preview: text.slice(0, 120),
        matched_pattern: matchedPattern ? patternLabel(matchedPattern.raw) : null
      });
    } catch {}
  }

  return {
    enabled: true,
    ok: nodes.length > 0,
    reason: nodes.length ? null : "no_matching_stop_boundary_nodes",
    selector: normalizedSelector || DEFAULT_SCROLL_ANCHOR_SELECTOR,
    elapsed_ms: Date.now() - started,
    discovered_node_count: nodeIds.length,
    probed_node_count: Math.min(nodeIds.length, probeLimit),
    match_count: nodes.length,
    pattern_labels: patterns.map((pattern) => pattern.label),
    nodes
  };
}

async function resolveVisibleStopBoundary(client, stopBoundaryPlan, clip, {
  topPadding = 8,
  minCaptureHeight = 180,
  stepTimeoutMs = 45000
} = {}) {
  if (!stopBoundaryPlan?.nodes?.length || !clip) return null;
  const clipTop = Number(clip.y) || 0;
  const clipBottom = clipTop + (Number(clip.height) || 0);
  const safePadding = Math.max(0, Number(topPadding) || 0);
  const safeMinHeight = Math.max(1, Number(minCaptureHeight) || 180);
  const perNodeTimeoutMs = Math.min(900, Math.max(180, Math.floor((Number(stepTimeoutMs) || 45000) / 50)));
  const visible = [];

  for (const node of stopBoundaryPlan.nodes) {
    try {
      const box = await withCaptureTimeout(getNodeBox(client, node.node_id), {
        label: `stop_boundary_box_${node.node_id}`,
        timeoutMs: perNodeTimeoutMs
      });
      const rect = box?.rect || {};
      const width = Number(rect.width) || 0;
      const height = Number(rect.height) || 0;
      if (width < 40 || height < 6) continue;
      const top = Number(rect.y) || 0;
      const bottom = top + height;
      if (bottom <= clipTop + 1) {
        return {
          action: "stop_before_capture",
          reason: "stop_boundary_above_clip",
          node_id: node.node_id,
          matched_pattern: node.matched_pattern,
          text_preview: node.text_preview,
          rect,
          clip
        };
      }
      if (top < clipBottom && bottom > clipTop) {
        visible.push({
          ...node,
          rect,
          top,
          bottom
        });
      }
    } catch {}
  }
  if (!visible.length) return null;

  visible.sort((a, b) => a.top - b.top);
  const boundary = visible[0];
  const boundaryY = Math.max(clipTop, boundary.top - safePadding);
  const adjustedHeight = Math.max(0, boundaryY - clipTop);
  if (adjustedHeight < safeMinHeight) {
    return {
      action: "stop_before_capture",
      reason: "stop_boundary_near_clip_top",
      node_id: boundary.node_id,
      matched_pattern: boundary.matched_pattern,
      text_preview: boundary.text_preview,
      rect: boundary.rect,
      clip,
      adjusted_height: adjustedHeight,
      min_capture_height: safeMinHeight
    };
  }

  return {
    action: "capture_then_stop",
    reason: "stop_boundary_visible",
    node_id: boundary.node_id,
    matched_pattern: boundary.matched_pattern,
    text_preview: boundary.text_preview,
    rect: boundary.rect,
    clip,
    adjusted_clip: {
      ...clip,
      height: adjustedHeight
    },
    adjusted_height: adjustedHeight,
    min_capture_height: safeMinHeight
  };
}

async function collectDomScrollAnchors(client, rootNodeId, {
  selector = DEFAULT_SCROLL_ANCHOR_SELECTOR,
  maxScreenshots = 6,
  maxProbeNodes = 260,
  minAnchorGap = 180,
  stepTimeoutMs = 45000
} = {}) {
  const started = Date.now();
  let nodeIds = [];
  try {
    nodeIds = uniqueNumbers(await querySelectorAll(client, rootNodeId, selector));
  } catch (error) {
    return {
      ok: false,
      method: "dom-anchor",
      reason: "query_selector_all_failed",
      error: error?.message || String(error)
    };
  }
  if (!nodeIds.length) {
    return {
      ok: false,
      method: "dom-anchor",
      reason: "no_anchor_nodes"
    };
  }

  const probeLimit = Math.max(1, Number(maxProbeNodes) || 260);
  const perNodeTimeoutMs = Math.min(1200, Math.max(250, Math.floor((Number(stepTimeoutMs) || 45000) / 30)));
  const measured = [];
  for (const nodeId of nodeIds.slice(0, probeLimit)) {
    try {
      const box = await withCaptureTimeout(getNodeBox(client, nodeId), {
        label: `anchor_box_${nodeId}`,
        timeoutMs: perNodeTimeoutMs
      });
      const rect = box?.rect || {};
      if ((Number(rect.width) || 0) < 80 || (Number(rect.height) || 0) < 8) continue;
      measured.push({
        node_id: nodeId,
        y: Math.round(Number(rect.y) || 0),
        height: Math.round(Number(rect.height) || 0)
      });
    } catch {}
  }

  let anchors = [];
  if (measured.length) {
    const sorted = measured.sort((a, b) => a.y - b.y);
    for (const item of sorted) {
      const last = anchors[anchors.length - 1];
      if (!last || Math.abs(item.y - last.y) >= Math.max(40, Number(minAnchorGap) || 180)) {
        anchors.push(item);
      }
    }
  }

  if (anchors.length < 2) {
    anchors = nodeIds.slice(0, probeLimit).map((nodeId, index) => ({
      node_id: nodeId,
      y: null,
      height: null,
      document_order: index
    }));
  }

  anchors = pickEvenly(anchors, Math.max(1, Number(maxScreenshots) || 1));
  return {
    ok: anchors.length > 0,
    method: "dom-anchor",
    elapsed_ms: Date.now() - started,
    selector,
    discovered_node_count: nodeIds.length,
    measured_node_count: measured.length,
    anchor_count: anchors.length,
    anchors
  };
}

async function scrollDomAnchorIntoView(client, nodeId, {
  timeoutMs = 10000,
  label = "dom_scroll_anchor"
} = {}) {
  if (client.DOM && typeof client.DOM.scrollIntoViewIfNeeded === "function") {
    return withCaptureTimeout(client.DOM.scrollIntoViewIfNeeded({ nodeId }), { label, timeoutMs });
  }
  if (typeof client.send === "function") {
    return withCaptureTimeout(client.send("DOM.scrollIntoViewIfNeeded", { nodeId }), { label, timeoutMs });
  }
  throw new Error("CDP client does not expose DOM.scrollIntoViewIfNeeded");
}

async function optimizeScreenshotBuffer(buffer, {
  enabled = false,
  format = "png",
  quality,
  resizeMaxWidth = 0
} = {}) {
  if (!enabled && !resizeMaxWidth) {
    return {
      buffer,
      optimized: false,
      optimization_error: null
    };
  }
  try {
    const normalizedFormat = format === "jpg" ? "jpeg" : format;
    let pipeline = sharp(buffer, { failOn: "none" });
    const metadata = await pipeline.metadata();
    const width = Number(metadata.width) || 0;
    const safeMaxWidth = Math.max(0, Number(resizeMaxWidth) || 0);
    if (safeMaxWidth > 0 && width > safeMaxWidth) {
      pipeline = pipeline.resize({
        width: safeMaxWidth,
        withoutEnlargement: true
      });
    }
    if (normalizedFormat === "jpeg") {
      pipeline = pipeline.jpeg({
        quality: quality == null ? 72 : Math.max(35, Math.min(95, Number(quality) || 72)),
        mozjpeg: true
      });
    } else if (normalizedFormat === "webp") {
      pipeline = pipeline.webp({
        quality: quality == null ? 76 : Math.max(35, Math.min(95, Number(quality) || 76))
      });
    } else {
      pipeline = pipeline.png({
        compressionLevel: 9,
        adaptiveFiltering: true
      });
    }
    const optimizedBuffer = await pipeline.toBuffer();
    return {
      buffer: optimizedBuffer,
      optimized: true,
      original_byte_length: buffer.length,
      optimization_error: null
    };
  } catch (error) {
    return {
      buffer,
      optimized: false,
      original_byte_length: buffer.length,
      optimization_error: error?.message || String(error)
    };
  }
}

async function composeScreenshotsForLlm(screenshots = [], {
  basePath,
  pagesPerImage = 3,
  resizeMaxWidth = 1100,
  quality = 72
} = {}) {
  const fileScreenshots = screenshots.filter((item) => item?.file_path);
  if (!basePath || fileScreenshots.length <= 1) {
    return {
      llm_file_paths: fileScreenshots.map((item) => item.file_path),
      llm_screenshots: [],
      llm_total_byte_length: 0,
      llm_original_total_byte_length: 0,
      llm_composition_error: null
    };
  }

  const safePagesPerImage = Math.max(1, Math.min(5, Number(pagesPerImage) || 3));
  const safeWidth = Math.max(700, Math.min(1400, Number(resizeMaxWidth) || 1100));
  const safeQuality = Math.max(45, Math.min(90, Number(quality) || 72));
  const llmScreenshots = [];

  try {
    for (let index = 0; index < fileScreenshots.length; index += safePagesPerImage) {
      const group = fileScreenshots.slice(index, index + safePagesPerImage);
      const prepared = [];
      for (const item of group) {
        const sourceBuffer = fs.readFileSync(item.file_path);
        const { data, info } = await sharp(sourceBuffer, { failOn: "none" })
          .resize({
            width: safeWidth,
            withoutEnlargement: true
          })
          .jpeg({
            quality: safeQuality,
            mozjpeg: true
          })
          .toBuffer({ resolveWithObject: true });
        prepared.push({
          input: data,
          width: info.width,
          height: info.height,
          source_file_path: item.file_path
        });
      }

      const width = Math.max(...prepared.map((item) => item.width), 1);
      const height = prepared.reduce((sum, item) => sum + item.height, 0);
      let top = 0;
      const composites = prepared.map((item) => {
        const layer = {
          input: item.input,
          left: 0,
          top
        };
        top += item.height;
        return layer;
      });
      const outputBuffer = await sharp({
        create: {
          width,
          height,
          channels: 3,
          background: "#ffffff"
        }
      })
        .composite(composites)
        .jpeg({
          quality: safeQuality,
          mozjpeg: true
        })
        .toBuffer();
      const outputPath = filePathForLlmSequence(basePath, llmScreenshots.length);
      fs.writeFileSync(outputPath, outputBuffer);
      llmScreenshots.push({
        index: llmScreenshots.length,
        file_path: outputPath,
        byte_length: outputBuffer.length,
        source_file_paths: prepared.map((item) => item.source_file_path),
        source_page_count: prepared.length,
        width,
        height,
        format: "jpeg",
        mime_type: "image/jpeg"
      });
    }
  } catch (error) {
    return {
      llm_file_paths: fileScreenshots.map((item) => item.file_path),
      llm_screenshots: [],
      llm_total_byte_length: 0,
      llm_original_total_byte_length: fileScreenshots.reduce((sum, item) => sum + (Number(item.byte_length) || 0), 0),
      llm_composition_error: error?.message || String(error)
    };
  }

  return {
    llm_file_paths: llmScreenshots.map((item) => item.file_path),
    llm_screenshots: llmScreenshots,
    llm_total_byte_length: llmScreenshots.reduce((sum, item) => sum + (Number(item.byte_length) || 0), 0),
    llm_original_total_byte_length: fileScreenshots.reduce((sum, item) => sum + (Number(item.byte_length) || 0), 0),
    llm_composition_error: null
  };
}

export async function captureScrolledNodeScreenshots(client, nodeId, {
  filePath,
  format = "png",
  quality,
  padding = 0,
  captureBeyondViewport = true,
  fromSurface = true,
  captureViewport = false,
  maxScreenshots = 6,
  wheelDeltaY = 650,
  settleMs = 900,
  duplicateStopCount = 2,
  skipDuplicateScreenshots = false,
  optimize = false,
  resizeMaxWidth = 0,
  composeForLlm = false,
  llmPagesPerImage = 3,
  llmResizeMaxWidth = 1100,
  llmQuality = 72,
  stepTimeoutMs = 45000,
  totalTimeoutMs = 90000,
  scrollMethod = "dom-anchor-fallback-input",
  scrollAnchorSelector = DEFAULT_SCROLL_ANCHOR_SELECTOR,
  scrollAnchorMaxProbeNodes = 260,
  scrollAnchorMinGap = 180,
  scrollDeltaJitterEnabled = false,
  scrollDeltaJitterMinRatio = 0.65,
  scrollDeltaJitterMaxRatio = 0.9,
  scrollDeltaJitterMinOverlapRatio = 0.2,
  scrollDeltaJitterPreserveCoverage = true,
  scrollDeltaJitterRandom = Math.random,
  stopBoundarySelector = "",
  stopBoundaryTextPatterns = [],
  stopBoundaryMaxProbeNodes = 180,
  stopBoundaryMaxTextLength = 700,
  stopBoundaryTopPadding = 8,
  stopBoundaryMinCaptureHeight = 180,
  metadata = {}
} = {}) {
  if (!nodeId) throw new Error("captureScrolledNodeScreenshots requires nodeId");
  const sequenceStarted = Date.now();
  const normalizedScrollMethod = normalizeScrollMethod(scrollMethod);
  const maxScreenshotCount = Math.max(1, Number(maxScreenshots) || 1);
  const scrollDeltaJitter = normalizeScrollDeltaJitter({
    enabled: scrollDeltaJitterEnabled,
    minRatio: scrollDeltaJitterMinRatio,
    maxRatio: scrollDeltaJitterMaxRatio,
    minOverlapRatio: scrollDeltaJitterMinOverlapRatio,
    preserveCoverage: scrollDeltaJitterPreserveCoverage,
    random: scrollDeltaJitterRandom
  });
  const maxCaptureIterations = scrollDeltaJitter.enabled && scrollDeltaJitter.preserve_coverage
    ? Math.max(maxScreenshotCount, Math.ceil(maxScreenshotCount / scrollDeltaJitter.min_ratio))
    : maxScreenshotCount;
  const anchorPlan = normalizedScrollMethod !== "input"
    ? await collectDomScrollAnchors(client, nodeId, {
        selector: scrollAnchorSelector,
        maxScreenshots: maxCaptureIterations,
        maxProbeNodes: scrollAnchorMaxProbeNodes,
        minAnchorGap: scrollAnchorMinGap,
        stepTimeoutMs
      })
    : null;
  const stopBoundaryEnabled = Boolean(
    normalizeText(stopBoundarySelector)
    || (Array.isArray(stopBoundaryTextPatterns)
      ? stopBoundaryTextPatterns.length
      : stopBoundaryTextPatterns)
  );
  let stopBoundaryPlan = {
    enabled: false,
    ok: false,
    reason: "not_configured",
    nodes: []
  };
  const stopBoundaryChecks = [];
  const screenshots = [];
  let consecutiveDuplicates = 0;
  let previousHash = "";
  let captureCount = 0;
  let droppedDuplicateCount = 0;
  let forceInputScrollAfterDuplicate = false;
  let stopBoundaryResult = null;
  let currentScrollMetadata = {
    before_capture: "initial",
    method: normalizedScrollMethod,
    anchor_plan: anchorPlan
      ? {
          ok: Boolean(anchorPlan.ok),
          reason: anchorPlan.reason || null,
          discovered_node_count: anchorPlan.discovered_node_count || 0,
          measured_node_count: anchorPlan.measured_node_count || 0,
          anchor_count: anchorPlan.anchor_count || 0,
          elapsed_ms: anchorPlan.elapsed_ms || 0
        }
      : null
  };

  if (anchorPlan?.anchors?.[0]?.node_id && normalizedScrollMethod !== "input") {
    try {
      await scrollDomAnchorIntoView(client, anchorPlan.anchors[0].node_id, {
        label: "scroll_dom_anchor_initial",
        timeoutMs: Math.min(Math.max(3000, Number(stepTimeoutMs) || 45000), 10000)
      });
      currentScrollMetadata = {
        before_capture: "dom_anchor_initial",
        method: "DOM.scrollIntoViewIfNeeded",
        anchor_node_id: anchorPlan.anchors[0].node_id,
        anchor_y: anchorPlan.anchors[0].y,
        anchor_height: anchorPlan.anchors[0].height,
        anchor_plan: currentScrollMetadata.anchor_plan
      };
    } catch (error) {
      if (normalizedScrollMethod === "dom-anchor") {
        throw error;
      }
      currentScrollMetadata = {
        before_capture: "dom_anchor_initial_failed",
        method: "DOM.scrollIntoViewIfNeeded",
        anchor_node_id: anchorPlan.anchors[0].node_id,
        error: error?.message || String(error),
        anchor_plan: currentScrollMetadata.anchor_plan
      };
    }
  }

  for (let index = 0; index < maxCaptureIterations; index += 1) {
    assertCaptureTotalBudget(sequenceStarted, totalTimeoutMs, `capture_page_${index + 1}`);
    captureCount += 1;
    const captureStarted = Date.now();
    const box = await withCaptureTimeout(getNodeBox(client, nodeId), {
      label: `get_box_${index + 1}`,
      timeoutMs: stepTimeoutMs
    });
    const clip = withPadding(box.rect, padding);
    let visibleStopBoundary = null;
    if (stopBoundaryEnabled) {
      stopBoundaryPlan = await collectStopBoundaryNodes(client, nodeId, {
        selector: stopBoundarySelector,
        textPatterns: stopBoundaryTextPatterns,
        maxProbeNodes: stopBoundaryMaxProbeNodes,
        maxTextLength: stopBoundaryMaxTextLength,
        stepTimeoutMs
      });
      stopBoundaryChecks.push({
        capture_index: index,
        ok: Boolean(stopBoundaryPlan.ok),
        reason: stopBoundaryPlan.reason || null,
        discovered_node_count: stopBoundaryPlan.discovered_node_count || 0,
        probed_node_count: stopBoundaryPlan.probed_node_count || 0,
        match_count: stopBoundaryPlan.match_count || 0,
        elapsed_ms: stopBoundaryPlan.elapsed_ms || 0
      });
      visibleStopBoundary = await resolveVisibleStopBoundary(client, stopBoundaryPlan, clip, {
        topPadding: stopBoundaryTopPadding,
        minCaptureHeight: stopBoundaryMinCaptureHeight,
        stepTimeoutMs
      });
    }
    if (visibleStopBoundary?.action === "stop_before_capture") {
      stopBoundaryResult = visibleStopBoundary;
      break;
    }
    const effectiveClip = visibleStopBoundary?.adjusted_clip || clip;
    const effectiveCaptureViewport = Boolean(captureViewport && !visibleStopBoundary?.adjusted_clip);
    const captureOptions = effectiveCaptureViewport ? {
      format,
      fromSurface,
      captureBeyondViewport: false
    } : {
      format,
      fromSurface,
      captureBeyondViewport,
      clip: effectiveClip
    };
    if (quality != null) {
      captureOptions.quality = quality;
    }
    const screenshot = await withCaptureTimeout(client.Page.captureScreenshot(captureOptions), {
      label: `capture_screenshot_${index + 1}`,
      timeoutMs: stepTimeoutMs
    });
    const originalBuffer = Buffer.from(screenshot.data || "", "base64");
    const optimized = await withCaptureTimeout(optimizeScreenshotBuffer(originalBuffer, {
      enabled: optimize,
      format,
      quality,
      resizeMaxWidth
    }), {
      label: `optimize_screenshot_${index + 1}`,
      timeoutMs: stepTimeoutMs
    });
    const buffer = optimized.buffer;
    const hash = screenshotHash(buffer);
    const duplicateOfPrevious = previousHash && previousHash === hash;
    if (duplicateOfPrevious) {
      consecutiveDuplicates += 1;
    } else {
      consecutiveDuplicates = 0;
    }

    let outputPath = null;
    if (duplicateOfPrevious && skipDuplicateScreenshots) {
      droppedDuplicateCount += 1;
    } else {
      outputPath = filePath ? filePathForSequence(filePath, screenshots.length, format) : null;
      if (outputPath) {
        fs.writeFileSync(outputPath, buffer);
      }

      screenshots.push({
        index: screenshots.length,
        capture_index: index,
        source: "image",
        captured_at: nowIso(),
        node_id: nodeId,
        format,
        mime_type: `image/${format === "jpeg" ? "jpeg" : "png"}`,
        byte_length: buffer.length,
        original_byte_length: optimized.original_byte_length || originalBuffer.length,
        optimized: Boolean(optimized.optimized),
        optimization_error: optimized.optimization_error || null,
        elapsed_ms: Date.now() - captureStarted,
        file_path: outputPath,
        sha256: hash,
        duplicate_of_previous: Boolean(duplicateOfPrevious),
        clip: effectiveClip,
        capture_viewport: effectiveCaptureViewport,
        node_rect: box.rect,
        scroll: currentScrollMetadata,
        stop_boundary: visibleStopBoundary || null,
        metadata
      });
    }

    if (visibleStopBoundary?.action === "capture_then_stop") {
      stopBoundaryResult = visibleStopBoundary;
      break;
    }

    previousHash = hash;
    forceInputScrollAfterDuplicate = Boolean(
      duplicateOfPrevious
      && normalizedScrollMethod === "dom-anchor-fallback-input"
      && currentScrollMetadata?.method === "DOM.scrollIntoViewIfNeeded"
    );
    if (
      consecutiveDuplicates >= Math.max(1, Number(duplicateStopCount) || 1)
      && !forceInputScrollAfterDuplicate
    ) {
      break;
    }

    if (index < maxCaptureIterations - 1) {
      assertCaptureTotalBudget(sequenceStarted, totalTimeoutMs, `scroll_after_page_${index + 1}`);
      let scrolledByDomAnchor = false;
      const nextAnchor = anchorPlan?.anchors?.[index + 1] || null;
      if (nextAnchor?.node_id && normalizedScrollMethod !== "input" && !forceInputScrollAfterDuplicate) {
        try {
          await scrollDomAnchorIntoView(client, nextAnchor.node_id, {
            label: `scroll_dom_anchor_${index + 1}`,
            timeoutMs: Math.min(Math.max(3000, Number(stepTimeoutMs) || 45000), 10000)
          });
          scrolledByDomAnchor = true;
          currentScrollMetadata = {
            before_capture: `dom_anchor_${index + 1}`,
            method: "DOM.scrollIntoViewIfNeeded",
            anchor_node_id: nextAnchor.node_id,
            anchor_y: nextAnchor.y,
            anchor_height: nextAnchor.height
          };
        } catch (error) {
          if (normalizedScrollMethod === "dom-anchor") {
            throw error;
          }
          currentScrollMetadata = {
            before_capture: `dom_anchor_${index + 1}_failed`,
            method: "DOM.scrollIntoViewIfNeeded",
            anchor_node_id: nextAnchor.node_id,
            error: error?.message || String(error)
          };
        }
      } else if (normalizedScrollMethod === "dom-anchor") {
        break;
      }

      if (!scrolledByDomAnchor && normalizedScrollMethod !== "dom-anchor") {
        const x = box.center.x;
        const y = box.center.y;
        const scrollDelta = resolveCoverageSafeScrollDelta({
          baseDelta: wheelDeltaY,
          clipHeight: effectiveClip.height,
          jitter: scrollDeltaJitter
        });
        await withCaptureTimeout(client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" }), {
          label: `scroll_mouse_move_${index + 1}`,
          timeoutMs: Math.min(Math.max(3000, Number(stepTimeoutMs) || 45000), 10000)
        });
        await withCaptureTimeout(client.Input.dispatchMouseEvent({
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY: scrollDelta.deltaY
        }), {
          label: `scroll_wheel_${index + 1}`,
          timeoutMs: Math.min(Math.max(3000, Number(stepTimeoutMs) || 45000), 10000)
        });
        currentScrollMetadata = {
          before_capture: `wheel_down_${index + 1}`,
          method: "Input.dispatchMouseEvent",
          fallback_from_dom_anchor: Boolean(anchorPlan && normalizedScrollMethod === "dom-anchor-fallback-input"),
          wheel_delta_y: scrollDelta.deltaY,
          wheel_delta_base_y: scrollDelta.base_delta_y,
          wheel_delta_jitter: scrollDelta.jittered ? scrollDelta : null
        };
      }
      if (settleMs > 0) await sleep(settleMs);
    }
  }

  const llmComposition = composeForLlm
    ? await withCaptureTimeout(composeScreenshotsForLlm(screenshots, {
        basePath: filePath,
        pagesPerImage: llmPagesPerImage,
        resizeMaxWidth: llmResizeMaxWidth,
        quality: llmQuality
      }), {
        label: "compose_llm_screenshots",
        timeoutMs: stepTimeoutMs
      })
    : {
        llm_file_paths: screenshots.map((item) => item.file_path).filter(Boolean),
        llm_screenshots: [],
        llm_total_byte_length: 0,
        llm_original_total_byte_length: 0,
        llm_composition_error: null
      };

  return {
    schema_version: 1,
    ok: true,
    source: "image-scroll-sequence",
    captured_at: nowIso(),
    node_id: nodeId,
    elapsed_ms: Date.now() - sequenceStarted,
    capture_count: captureCount,
    screenshot_count: screenshots.length,
    unique_screenshot_count: new Set(screenshots.map((item) => item.sha256)).size,
    duplicate_screenshot_count: captureCount - new Set(screenshots.map((item) => item.sha256)).size,
    dropped_duplicate_count: droppedDuplicateCount,
    total_byte_length: screenshots.reduce((sum, item) => sum + (Number(item.byte_length) || 0), 0),
    original_total_byte_length: screenshots.reduce((sum, item) => sum + (Number(item.original_byte_length) || 0), 0),
    llm_file_paths: llmComposition.llm_file_paths,
    llm_screenshot_count: llmComposition.llm_file_paths.length,
    llm_total_byte_length: llmComposition.llm_total_byte_length,
    llm_original_total_byte_length: llmComposition.llm_original_total_byte_length,
    llm_composition_error: llmComposition.llm_composition_error,
    llm_screenshots: llmComposition.llm_screenshots,
    optimization: {
      enabled: Boolean(optimize),
      resize_max_width: Math.max(0, Number(resizeMaxWidth) || 0),
      capture_viewport: Boolean(captureViewport),
      format,
      quality: quality ?? null,
      llm_compose_enabled: Boolean(composeForLlm),
      llm_pages_per_image: Math.max(1, Math.min(5, Number(llmPagesPerImage) || 3)),
      llm_resize_max_width: Math.max(0, Number(llmResizeMaxWidth) || 0),
      llm_quality: llmQuality ?? null,
      step_timeout_ms: Math.max(0, Number(stepTimeoutMs) || 0),
      total_timeout_ms: Math.max(0, Number(totalTimeoutMs) || 0),
      scroll_method: normalizedScrollMethod,
      requested_max_screenshots: maxScreenshotCount,
      effective_max_screenshots: maxCaptureIterations,
      scroll_anchor_selector: scrollAnchorSelector,
      scroll_anchor_max_probe_nodes: Math.max(1, Number(scrollAnchorMaxProbeNodes) || 260),
      scroll_anchor_min_gap: Math.max(0, Number(scrollAnchorMinGap) || 0),
      scroll_delta_jitter: {
        enabled: scrollDeltaJitter.enabled,
        min_ratio: scrollDeltaJitter.min_ratio,
        max_ratio: scrollDeltaJitter.max_ratio,
        min_overlap_ratio: scrollDeltaJitter.min_overlap_ratio,
        preserve_coverage: scrollDeltaJitter.preserve_coverage
      }
    },
    scroll_anchor_plan: anchorPlan,
    stop_boundary_plan: stopBoundaryPlan,
    stop_boundary_checks: stopBoundaryChecks,
    stop_boundary_result: stopBoundaryResult,
    file_paths: screenshots.map((item) => item.file_path).filter(Boolean),
    screenshots,
    metadata
  };
}

export async function captureCandidateEvidence(client, {
  nodeId,
  domain = "unknown",
  source = "dom",
  screenshotPath,
  includeHtml = true,
  includeScreenshot = false,
  screenshotMode = "scroll",
  screenshotOptions = {},
  metadata = {}
} = {}) {
  if (!nodeId) throw new Error("captureCandidateEvidence requires nodeId");
  const evidence = {
    schema_version: 1,
    domain: normalizeText(domain) || "unknown",
    source,
    captured_at: nowIso(),
    node_id: nodeId,
    html: null,
    image: null,
    metadata
  };
  if (includeHtml) {
    evidence.html = await captureNodeHtml(client, nodeId, {
      domain,
      source: "dom",
      metadata
    });
  }
  if (includeScreenshot) {
    evidence.image = screenshotMode === "single"
      ? await captureNodeScreenshot(client, nodeId, {
          ...screenshotOptions,
          filePath: screenshotPath,
          metadata: {
            ...metadata,
            capture_mode: "single_visible_clip"
          }
        })
      : await captureScrolledNodeScreenshots(client, nodeId, {
          ...screenshotOptions,
          filePath: screenshotPath,
          metadata: {
            ...metadata,
            capture_mode: "scroll_sequence"
          }
        });
  }
  return evidence;
}
