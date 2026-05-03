import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import {
  getAttributesMap,
  getNodeBox,
  getOuterHTML,
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

function screenshotHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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
  metadata = {}
} = {}) {
  if (!nodeId) throw new Error("captureScrolledNodeScreenshots requires nodeId");
  const sequenceStarted = Date.now();
  const screenshots = [];
  let consecutiveDuplicates = 0;
  let previousHash = "";
  let captureCount = 0;
  let droppedDuplicateCount = 0;

  for (let index = 0; index < Math.max(1, Number(maxScreenshots) || 1); index += 1) {
    captureCount += 1;
    const captureStarted = Date.now();
    const box = await getNodeBox(client, nodeId);
    const clip = withPadding(box.rect, padding);
    const captureOptions = captureViewport ? {
      format,
      fromSurface,
      captureBeyondViewport: false
    } : {
      format,
      fromSurface,
      captureBeyondViewport,
      clip
    };
    if (quality != null) {
      captureOptions.quality = quality;
    }
    const screenshot = await client.Page.captureScreenshot(captureOptions);
    const originalBuffer = Buffer.from(screenshot.data || "", "base64");
    const optimized = await optimizeScreenshotBuffer(originalBuffer, {
      enabled: optimize,
      format,
      quality,
      resizeMaxWidth
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
        clip,
        capture_viewport: Boolean(captureViewport),
        node_rect: box.rect,
        scroll: index === 0
          ? { before_capture: "initial" }
          : { before_capture: `wheel_down_${index}` },
        metadata
      });
    }

    previousHash = hash;
    if (consecutiveDuplicates >= Math.max(1, Number(duplicateStopCount) || 1)) {
      break;
    }

    if (index < Math.max(1, Number(maxScreenshots) || 1) - 1) {
      const x = box.center.x;
      const y = box.center.y;
      await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
      await client.Input.dispatchMouseEvent({
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: Math.max(1, Number(wheelDeltaY) || 650)
      });
      if (settleMs > 0) await sleep(settleMs);
    }
  }

  return {
    schema_version: 1,
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
    optimization: {
      enabled: Boolean(optimize),
      resize_max_width: Math.max(0, Number(resizeMaxWidth) || 0),
      capture_viewport: Boolean(captureViewport),
      format,
      quality: quality ?? null
    },
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
