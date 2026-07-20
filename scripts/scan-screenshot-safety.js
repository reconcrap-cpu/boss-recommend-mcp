#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const SELF = path.resolve(import.meta.dirname, "scan-screenshot-safety.js");
const SOURCE_ROOTS = ["src", "scripts"];

function collectFiles(relativeRoot) {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  const files = [];
  const pending = [absoluteRoot];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") pending.push(absolute);
      } else if (/\.(?:c|m)?js$/i.test(entry.name) && path.resolve(absolute) !== SELF) {
        files.push(absolute);
      }
    }
  }
  return files;
}

function lineForOffset(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function addMatches(findings, file, source, pattern, reason) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(source))) {
    findings.push({
      file: path.relative(ROOT, file).replaceAll("\\", "/"),
      line: lineForOffset(source, match.index),
      reason,
      excerpt: match[0].replace(/\s+/g, " ").slice(0, 180)
    });
    if (!pattern.global) break;
  }
}

function readBalancedSegment(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          text: source.slice(openIndex + 1, index),
          end: index
        };
      }
    }
  }
  return null;
}

function addFinding(findings, file, source, offset, reason, excerpt) {
  findings.push({
    file: path.relative(ROOT, file).replaceAll("\\", "/"),
    line: lineForOffset(source, offset),
    reason,
    excerpt: String(excerpt || "").replace(/\s+/g, " ").slice(0, 180)
  });
}

function scanDirectCalls(findings, file, source) {
  const relativeFile = path.relative(ROOT, file).replaceAll("\\", "/");
  const sharedCaptureFile = "src/core/capture/index.js";
  const isTestSource = /^src\/test(?:-|\/)/.test(relativeFile);
  const directCall = /Page\.captureScreenshot\s*\(/g;
  let match;
  while ((match = directCall.exec(source))) {
    const openIndex = source.indexOf("(", match.index);
    const call = readBalancedSegment(source, openIndex, "(", ")");
    if (!call) {
      addFinding(
        findings,
        file,
        source,
        match.index,
        "Unable to audit Page.captureScreenshot arguments",
        match[0]
      );
      continue;
    }
    const options = call.text;
    if (relativeFile.startsWith("src/") && relativeFile !== sharedCaptureFile && !isTestSource) {
      addFinding(
        findings,
        file,
        source,
        match.index,
        "Active runtime screenshots must route through src/core/capture/index.js",
        options
      );
    }
    if (/\bclip\s*:/.test(options)) {
      addFinding(
        findings,
        file,
        source,
        match.index,
        "Page.captureScreenshot must not receive a browser-side clip",
        options
      );
    }
    const beyondProperty = options.match(/\bcaptureBeyondViewport\s*:\s*([^,}\n]+)/);
    if (beyondProperty && beyondProperty[1].trim() !== "false") {
      addFinding(
        findings,
        file,
        source,
        match.index,
        "Page.captureScreenshot captureBeyondViewport must be the literal false",
        options
      );
    }
    const surfaceProperty = options.match(/\bfromSurface\s*:\s*([^,}\n]+)/);
    if (surfaceProperty && surfaceProperty[1].trim() !== "true") {
      addFinding(
        findings,
        file,
        source,
        match.index,
        "Page.captureScreenshot fromSurface must be the literal true",
        options
      );
    }
    if (file.includes(`${path.sep}scripts${path.sep}`)) {
      if (!/\bcaptureBeyondViewport\s*:\s*false\b/.test(options)) {
        addFinding(
          findings,
          file,
          source,
          match.index,
          "Live screenshot harness must explicitly disable captureBeyondViewport",
          options
        );
      }
      if (!/\bfromSurface\s*:\s*true\b/.test(options)) {
        addFinding(
          findings,
          file,
          source,
          match.index,
          "Live screenshot harness must explicitly capture fromSurface",
          options
        );
      }
    }
    directCall.lastIndex = call.end + 1;
  }
}

function scanViewportCaptureCalls(findings, file, source) {
  const viewportCall = /\bcaptureViewportScreenshot\s*\(/g;
  let match;
  while ((match = viewportCall.exec(source))) {
    const prefix = source.slice(Math.max(0, match.index - 40), match.index);
    if (/function\s+$/.test(prefix)) continue;
    const openIndex = source.indexOf("(", match.index);
    const call = readBalancedSegment(source, openIndex, "(", ")");
    if (!call) continue;
    if (/\bfilePath\s*:/.test(call.text)) {
      addFinding(
        findings,
        file,
        source,
        match.index,
        "captureViewportScreenshot must not be given a persistence path",
        call.text
      );
    }
    viewportCall.lastIndex = call.end + 1;
  }
}

function scanSharedCaptureContract(findings) {
  const captureSourcePath = path.join(ROOT, "src", "core", "capture", "index.js");
  const captureSource = fs.readFileSync(captureSourcePath, "utf8");
  const functionStart = captureSource.indexOf("function createCliplessScreenshotOptions");
  const parameterOpen = functionStart >= 0 ? captureSource.indexOf("(", functionStart) : -1;
  const parameters = parameterOpen >= 0
    ? readBalancedSegment(captureSource, parameterOpen, "(", ")")
    : null;
  const functionOpen = parameters ? captureSource.indexOf("{", parameters.end + 1) : -1;
  const functionBody = functionOpen >= 0
    ? readBalancedSegment(captureSource, functionOpen, "{", "}")
    : null;
  const contractSource = functionBody?.text || "";
  if (
    !functionBody
    || !/\bfromSurface\s*:\s*true\b/.test(contractSource)
    || !/\bcaptureBeyondViewport\s*:\s*false\b/.test(contractSource)
    || /\bclip\s*:/.test(contractSource)
  ) {
    addFinding(
      findings,
      captureSourcePath,
      captureSource,
      Math.max(0, functionStart),
      "Shared capture must construct screenshot options through the clipless visible-viewport contract",
      functionBody?.text || "createCliplessScreenshotOptions contract missing"
    );
  }

  const viewportStart = captureSource.indexOf("export async function captureViewportScreenshot");
  const viewportParameterOpen = viewportStart >= 0 ? captureSource.indexOf("(", viewportStart) : -1;
  const viewportParameters = viewportParameterOpen >= 0
    ? readBalancedSegment(captureSource, viewportParameterOpen, "(", ")")
    : null;
  const viewportFunctionOpen = viewportParameters
    ? captureSource.indexOf("{", viewportParameters.end + 1)
    : -1;
  const viewportBody = viewportFunctionOpen >= 0
    ? readBalancedSegment(captureSource, viewportFunctionOpen, "{", "}")
    : null;
  if (
    !viewportBody
    || /\bfilePath\b/.test(viewportParameters?.text || "")
    || /\b(?:fs\.writeFileSync|resolveOutputPath)\b/.test(viewportBody.text)
    || !/\bfile_path\s*:\s*null\b/.test(viewportBody.text)
    || !/\bpersistence\s*:\s*["']forbidden_uncropped_viewport["']/.test(viewportBody.text)
  ) {
    addFinding(
      findings,
      captureSourcePath,
      captureSource,
      Math.max(0, viewportStart),
      "Uncropped viewport capture must be non-persistent by construction",
      `${viewportParameters?.text || "missing parameters"} ${viewportBody?.text || "missing body"}`
    );
  }
  const transportCalls = captureSource.match(/Page\.captureScreenshot\s*\(/g) || [];
  if (transportCalls.length !== 1 || !captureSource.includes("Page.captureScreenshot(captureOptions)")) {
    addFinding(
      findings,
      captureSourcePath,
      captureSource,
      0,
      "Shared capture must have one audited Page.captureScreenshot transport call",
      `transport_call_count=${transportCalls.length}`
    );
  }
  const optionFactoryCalls = captureSource.match(/createCliplessScreenshotOptions\s*\(/g) || [];
  const atomicCaptureRoutes = captureSource.match(/await\s+captureViewportAtomically\s*\(/g) || [];
  const assignedFactoryRoutes = captureSource.match(
    /const\s+captureOptions\s*=\s*createCliplessScreenshotOptions\s*\(/g
  ) || [];
  const assignedAtomicRoutes = captureSource.match(
    /await\s+captureViewportAtomically\s*\(\s*client\s*,\s*captureOptions\b/g
  ) || [];
  const directFactoryRoutes = captureSource.match(
    /await\s+captureViewportAtomically\s*\(\s*client\s*,\s*createCliplessScreenshotOptions\s*\(/g
  ) || [];
  const factoryRouteCount = Math.max(0, optionFactoryCalls.length - 1);
  const auditedRouteCount = assignedAtomicRoutes.length + directFactoryRoutes.length;
  if (
    atomicCaptureRoutes.length !== auditedRouteCount
    || assignedFactoryRoutes.length !== assignedAtomicRoutes.length
    || factoryRouteCount !== auditedRouteCount
  ) {
    addFinding(
      findings,
      captureSourcePath,
      captureSource,
      0,
      "Every shared screenshot route must use the audited clipless option factory",
      [
        `atomic_route_count=${atomicCaptureRoutes.length}`,
        `factory_route_count=${factoryRouteCount}`,
        `assigned_factory_count=${assignedFactoryRoutes.length}`,
        `assigned_atomic_count=${assignedAtomicRoutes.length}`,
        `direct_factory_count=${directFactoryRoutes.length}`
      ].join("; ")
    );
  }

  const scrollCaptureStart = captureSource.indexOf("export async function captureScrolledNodeScreenshots");
  const scrollParameterOpen = scrollCaptureStart >= 0
    ? captureSource.indexOf("(", scrollCaptureStart)
    : -1;
  const scrollParameters = scrollParameterOpen >= 0
    ? readBalancedSegment(captureSource, scrollParameterOpen, "(", ")")
    : null;
  const scrollFunctionOpen = scrollParameters
    ? captureSource.indexOf("{", scrollParameters.end + 1)
    : -1;
  const scrollFunctionBody = scrollFunctionOpen >= 0
    ? readBalancedSegment(captureSource, scrollFunctionOpen, "{", "}")
    : null;
  const scrollContract = `${scrollParameters?.text || ""}\n${scrollFunctionBody?.text || ""}`;
  if (
    !scrollFunctionBody
    || !/captureViewport\s*:\s*requestedCaptureViewport\s*=\s*false/.test(scrollContract)
    || !/const\s+effectiveCaptureViewport\s*=\s*false\b/.test(scrollContract)
    || !/requested_capture_viewport\s*:\s*Boolean\(requestedCaptureViewport\)/.test(scrollContract)
    || /optimizeScreenshotBuffer\s*\(/.test(scrollContract)
  ) {
    addFinding(
      findings,
      captureSourcePath,
      captureSource,
      Math.max(0, scrollCaptureStart),
      "Scrolled evidence capture must ignore full-viewport requests and always crop locally",
      scrollContract.slice(0, 500)
    );
  }
}

function main() {
  const findings = [];
  const files = SOURCE_ROOTS.flatMap(collectFiles);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const relativeFile = path.relative(ROOT, file).replaceAll("\\", "/");
    const isTestSource = /^src\/test(?:-|\/)/.test(relativeFile);
    addMatches(
      findings,
      file,
      source,
      /\bcaptureBeyondViewport\s*:\s*true\b/g,
      "captureBeyondViewport:true is forbidden in active screenshot code"
    );
    addMatches(
      findings,
      file,
      source,
      /\bcaptureBeyondViewport\s*=\s*true\b/g,
      "captureBeyondViewport must never default to true"
    );
    if (!isTestSource) {
      addMatches(
        findings,
        file,
        source,
        /\bcaptureViewport\s*:\s*true\b/g,
        "Persisted evidence must not request an uncropped full viewport"
      );
    }
    scanDirectCalls(findings, file, source);
    scanViewportCaptureCalls(findings, file, source);
  }

  scanSharedCaptureContract(findings);

  const summary = {
    generated_at: new Date().toISOString(),
    scanned_file_count: files.length,
    finding_count: findings.length,
    findings
  };
  console.log(JSON.stringify(summary, null, 2));
  if (findings.length) process.exitCode = 1;
}

main();
