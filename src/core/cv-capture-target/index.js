import {
  getFrameDocumentNodeId,
  getNodeBox,
  querySelector,
  querySelectorAll,
  sleep
} from "../browser/index.js";

export const CV_CAPTURE_TARGET_SELECTORS = Object.freeze([
  ".resume-center-side .resume-detail-wrap",
  ".resume-container .resume-detail-wrap",
  ".resume-container .resume-content-wrap",
  // Kept for discovery compatibility, but never accepted as a standalone
  // capture target. Boss also uses this class for the narrow action sidebar.
  ".resume-item-detail",
  ".resume-detail-wrap",
  ".resume-content-wrap",
  ".resume-common-wrap",
  ".new-resume-online-main-ui",
  ".resume-detail",
  ".resume-recommend",
  "canvas#resume",
  ".resume-container"
]);

const IFRAME_BODY_SELECTORS = Object.freeze(["body", "html"]);
const STANDALONE_SIDE_PANE_SELECTOR = ".resume-item-detail";
const DEFAULT_STABILITY_SAMPLES = 2;
const DEFAULT_STABILITY_INTERVAL_MS = 0;
const DEFAULT_GEOMETRY_TOLERANCE_PX = 3;
const DEFAULT_GEOMETRY_TOLERANCE_RATIO = 0.01;

const SELECTOR_PRIORITY = new Map([
  [".resume-center-side .resume-detail-wrap", 120],
  [".resume-container .resume-detail-wrap", 115],
  [".resume-container .resume-content-wrap", 110],
  [".resume-detail-wrap", 105],
  [".resume-content-wrap", 100],
  [".resume-common-wrap", 95],
  [".new-resume-online-main-ui", 90],
  [".resume-detail", 85],
  [".resume-recommend", 80],
  ["canvas#resume", 75],
  [".resume-container", 70],
  ["body", 65],
  ["html", 60]
]);

const SOURCE_PRIORITY = Object.freeze({
  resume_iframe_cv_selector: 700,
  resume_iframe_body: 680,
  resume_iframe_element: 660,
  content_cv_selector: 600,
  content_cv_slot: 580,
  popup_cv_selector: 560,
  popup_cv_slot: 540,
  root_cv_selector: 400
});

function slotNodeId(slot = null) {
  return Number(slot?.node_id || slot?.nodeId || 0) || 0;
}

function rootNodeId(root = null) {
  return Number(root?.nodeId || root?.node_id || root?.root_node_id || 0) || 0;
}

function normalizeRootName(root = null, fallback = "") {
  return String(root?.name || root?.root || fallback || "").trim() || null;
}

function uniqueRoots(roots = []) {
  const seen = new Set();
  const result = [];
  for (const root of roots) {
    const nodeId = rootNodeId(root);
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    result.push({
      ...root,
      name: normalizeRootName(root),
      nodeId
    });
  }
  return result;
}

function slotAsRoot(slot = null, fallbackName = "") {
  const nodeId = slotNodeId(slot);
  if (!nodeId) return null;
  return {
    name: normalizeRootName(slot, fallbackName),
    nodeId,
    selector: slot?.selector || null,
    root_node_id: slot?.root_node_id || null
  };
}

function isVisibleBox(box = null) {
  return box?.rect?.width > 2 && box?.rect?.height > 2;
}

async function readVisibleBox(client, nodeId) {
  if (!nodeId) return null;
  try {
    const box = await getNodeBox(client, nodeId);
    return isVisibleBox(box) ? box : null;
  } catch {
    return null;
  }
}

function isCvScopedSelector(selector = "") {
  const normalized = String(selector || "").trim();
  if (!normalized) return false;
  if (normalized === STANDALONE_SIDE_PANE_SELECTOR) return false;
  if (/boss-popup|boss-dialog|dialog-wrap|geek-detail-modal|\bmodal\b|new-chat-resume-dialog-main-ui/i.test(normalized)) {
    return false;
  }
  return /resume-detail-wrap|resume-content-wrap|resume-common-wrap|new-resume-online-main-ui|resume-detail(?:\b|[.#:])|resume-recommend|canvas#resume|resume-container/i.test(normalized);
}

function isStandaloneSidePaneSelector(selector = "") {
  return String(selector || "").trim() === STANDALONE_SIDE_PANE_SELECTOR;
}

function selectorPriority(selector = "") {
  return SELECTOR_PRIORITY.get(String(selector || "").trim()) || 10;
}

function sourcePriority(source = "") {
  const normalized = String(source || "").trim();
  if (SOURCE_PRIORITY[normalized]) return SOURCE_PRIORITY[normalized];
  if (normalized.endsWith("_cv_selector")) return 500;
  if (normalized.endsWith("_cv_slot")) return 480;
  return 100;
}

function semanticPriority(target = null) {
  if (isCvScopedSelector(target?.selector)) return 2;
  if (target?.source === "resume_iframe_body" || target?.source === "resume_iframe_element") return 1;
  return 0;
}

function selectionScore(target = null) {
  const width = Math.min(5000, Math.max(0, Number(target?.rect?.width) || 0));
  const height = Math.min(9999, Math.max(0, Number(target?.rect?.height) || 0));
  const area = Math.min(10_000_000, width * height);
  return (
    sourcePriority(target?.source) * 1_000_000_000_000
    + semanticPriority(target) * 100_000_000_000
    + width * 10_000_000
    + area * 1000
    + selectorPriority(target?.selector)
  );
}

function compareTargets(left, right) {
  const sourceDelta = sourcePriority(right?.source) - sourcePriority(left?.source);
  if (sourceDelta) return sourceDelta;
  const semanticDelta = semanticPriority(right) - semanticPriority(left);
  if (semanticDelta) return semanticDelta;
  const widthDelta = (Number(right?.rect?.width) || 0) - (Number(left?.rect?.width) || 0);
  if (widthDelta) return widthDelta;
  const rightArea = (Number(right?.rect?.width) || 0) * (Number(right?.rect?.height) || 0);
  const leftArea = (Number(left?.rect?.width) || 0) * (Number(left?.rect?.height) || 0);
  if (rightArea !== leftArea) return rightArea - leftArea;
  const selectorDelta = selectorPriority(right?.selector) - selectorPriority(left?.selector);
  if (selectorDelta) return selectorDelta;
  return Number(left?.node_id || 0) - Number(right?.node_id || 0);
}

function targetIdentity(target = null) {
  if (!target?.node_id) return "";
  return [
    target.node_id,
    target.selector || "",
    target.source || "",
    target.root_node_id || "",
    target.iframe_node_id || "",
    target.iframe_document_node_id || ""
  ].join("|");
}

function rectDelta(left = null, right = null) {
  const keys = ["x", "y", "width", "height"];
  return Object.fromEntries(keys.map((key) => [
    key,
    Math.abs((Number(left?.[key]) || 0) - (Number(right?.[key]) || 0))
  ]));
}

function hasStableGeometry(left = null, right = null, {
  geometryTolerancePx = DEFAULT_GEOMETRY_TOLERANCE_PX,
  geometryToleranceRatio = DEFAULT_GEOMETRY_TOLERANCE_RATIO
} = {}) {
  if (!left || !right) return false;
  const pixelTolerance = Math.max(0, Number(geometryTolerancePx) || 0);
  const ratioTolerance = Math.max(0, Number(geometryToleranceRatio) || 0);
  for (const key of ["x", "y", "width", "height"]) {
    const leftValue = Number(left[key]);
    const rightValue = Number(right[key]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return false;
    const tolerance = Math.max(
      pixelTolerance,
      Math.max(Math.abs(leftValue), Math.abs(rightValue), 1) * ratioTolerance
    );
    if (Math.abs(leftValue - rightValue) > tolerance) return false;
  }
  return true;
}

function buildTarget({
  domain = "",
  nodeId,
  source,
  selector = null,
  root = null,
  rootNodeId = null,
  box = null,
  iframeNodeId = null,
  iframeDocumentNodeId = null,
  fallback = false,
  containment = null
} = {}) {
  return {
    schema_version: 1,
    domain: domain || null,
    node_id: nodeId,
    source,
    selector,
    root,
    root_node_id: rootNodeId || null,
    iframe_node_id: iframeNodeId || null,
    iframe_document_node_id: iframeDocumentNodeId || null,
    cv_only: !fallback,
    fallback: Boolean(fallback),
    rect: box?.rect || null,
    center: box?.center || null,
    containment_verified: Boolean(containment),
    containment: containment || null
  };
}

async function collectVisibleSelectorTargets(client, roots = [], selectors = CV_CAPTURE_TARGET_SELECTORS, {
  domain = "",
  source = "cv_selector",
  iframeNodeId = null,
  iframeDocumentNodeId = null,
  containment = "verified_detail_container",
  selfContainedOnly = false
} = {}) {
  const targets = [];
  for (const root of uniqueRoots(roots)) {
    for (const selector of selectors) {
      if (isStandaloneSidePaneSelector(selector)) continue;
      if (selfContainedOnly && !isCvScopedSelector(selector)) continue;
      let nodeIds = [];
      try {
        nodeIds = await querySelectorAll(client, root.nodeId, selector);
      } catch {
        nodeIds = [];
      }
      for (const nodeId of nodeIds) {
        const box = await readVisibleBox(client, nodeId);
        if (!box) continue;
        targets.push(buildTarget({
          domain,
          nodeId,
          source,
          selector,
          root: root.name,
          rootNodeId: root.nodeId,
          box,
          iframeNodeId,
          iframeDocumentNodeId,
          containment
        }));
      }
    }
  }
  return targets;
}

async function visibleSlotTarget(client, slot = null, {
  domain = "",
  source = "cv_slot",
  fallback = false
} = {}) {
  const nodeId = slotNodeId(slot);
  if (!nodeId) return null;
  if (!fallback && !isCvScopedSelector(slot?.selector)) return null;
  const box = await readVisibleBox(client, nodeId);
  if (!box) return null;
  return buildTarget({
    domain,
    nodeId,
    source,
    selector: slot?.selector || null,
    root: slot?.root || null,
    rootNodeId: slot?.root_node_id || null,
    box,
    fallback,
    containment: fallback ? null : "verified_cv_slot"
  });
}

async function collectIframeCaptureTargets(client, resumeIframe = null, {
  domain = "",
  selectors = CV_CAPTURE_TARGET_SELECTORS
} = {}) {
  const iframeNodeId = slotNodeId(resumeIframe);
  if (!iframeNodeId) return [];
  const targets = [];

  try {
    const documentNodeId = await getFrameDocumentNodeId(client, iframeNodeId);
    targets.push(...await collectVisibleSelectorTargets(client, [{
      name: "resume-iframe-document",
      nodeId: documentNodeId
    }], selectors, {
      domain,
      source: "resume_iframe_cv_selector",
      iframeNodeId,
      iframeDocumentNodeId: documentNodeId,
      containment: "resume_iframe_document"
    }));

    for (const selector of IFRAME_BODY_SELECTORS) {
      const nodeId = await querySelector(client, documentNodeId, selector).catch(() => 0);
      const box = await readVisibleBox(client, nodeId);
      if (!box) continue;
      targets.push(buildTarget({
        domain,
        nodeId,
        source: "resume_iframe_body",
        selector,
        root: "resume-iframe-document",
        rootNodeId: documentNodeId,
        box,
        iframeNodeId,
        iframeDocumentNodeId: documentNodeId,
        containment: "resume_iframe_document"
      }));
    }
  } catch {}

  const iframeBox = await readVisibleBox(client, iframeNodeId);
  if (iframeBox) {
    targets.push(buildTarget({
      domain,
      nodeId: iframeNodeId,
      source: "resume_iframe_element",
      selector: resumeIframe?.selector || null,
      root: resumeIframe?.root || null,
      rootNodeId: resumeIframe?.root_node_id || null,
      box: iframeBox,
      iframeNodeId,
      fallback: false,
      containment: "resume_iframe_element"
    }));
  }
  return targets;
}

async function collectSlotCaptureTargets(client, slot = null, {
  domain = "",
  slotName = "content",
  selectors = CV_CAPTURE_TARGET_SELECTORS
} = {}) {
  const targets = [];
  const root = slotAsRoot(slot, slotName);
  if (root) {
    targets.push(...await collectVisibleSelectorTargets(client, [root], selectors, {
      domain,
      source: `${slotName}_cv_selector`,
      containment: `${slotName}_detail_container`
    }));
  }
  const slotTarget = await visibleSlotTarget(client, slot, {
    domain,
    source: `${slotName}_cv_slot`
  });
  if (slotTarget) targets.push(slotTarget);
  return targets;
}

function rankTargets(targets = []) {
  const bestByNode = new Map();
  for (const target of targets) {
    if (!target?.node_id || !target.containment_verified) continue;
    const key = `${target.iframe_document_node_id || 0}|${target.node_id}`;
    const existing = bestByNode.get(key);
    if (!existing || compareTargets(target, existing) < 0) {
      bestByNode.set(key, target);
    }
  }
  const ranked = [...bestByNode.values()].sort(compareTargets);
  return ranked.map((target, index) => ({
    ...target,
    selection: {
      rank: index + 1,
      candidate_count: ranked.length,
      score: selectionScore(target),
      source_priority: sourcePriority(target.source),
      selector_priority: selectorPriority(target.selector)
    }
  }));
}

async function discoverCvCaptureTargets(client, detailState = null, {
  domain = "",
  selectors = CV_CAPTURE_TARGET_SELECTORS
} = {}) {
  const targets = [];
  targets.push(...await collectIframeCaptureTargets(client, detailState?.resumeIframe, {
    domain,
    selectors
  }));

  targets.push(...await collectSlotCaptureTargets(client, detailState?.content, {
    domain,
    slotName: "content",
    selectors
  }));

  targets.push(...await collectSlotCaptureTargets(client, detailState?.popup, {
    domain,
    slotName: "popup",
    selectors
  }));

  targets.push(...await collectVisibleSelectorTargets(client, detailState?.roots || [], selectors, {
    domain,
    source: "root_cv_selector",
    containment: "self_contained_cv_wrapper",
    selfContainedOnly: true
  }));

  return rankTargets(targets);
}

export async function resolveCvCaptureTarget(client, detailState = null, {
  stabilitySamples = DEFAULT_STABILITY_SAMPLES,
  stabilityIntervalMs = DEFAULT_STABILITY_INTERVAL_MS,
  geometryTolerancePx = DEFAULT_GEOMETRY_TOLERANCE_PX,
  geometryToleranceRatio = DEFAULT_GEOMETRY_TOLERANCE_RATIO,
  ...options
} = {}) {
  const requestedSampleCount = Number(stabilitySamples);
  const sampleCount = Number.isFinite(requestedSampleCount)
    ? Math.max(DEFAULT_STABILITY_SAMPLES, Math.floor(requestedSampleCount))
    : DEFAULT_STABILITY_SAMPLES;
  const intervalMs = Math.max(0, Number(stabilityIntervalMs) || 0);
  const samples = [];
  let previous = null;

  for (let index = 0; index < sampleCount; index += 1) {
    const ranked = await discoverCvCaptureTargets(client, detailState, options);
    const current = ranked[0] || null;
    if (!current) return null;
    if (previous) {
      if (targetIdentity(previous) !== targetIdentity(current)) return null;
      if (!hasStableGeometry(previous.rect, current.rect, {
        geometryTolerancePx,
        geometryToleranceRatio
      })) return null;
    }
    samples.push(current.rect);
    previous = current;
    if (index < sampleCount - 1 && intervalMs > 0) await sleep(intervalMs);
  }

  const delta = rectDelta(samples[0], samples.at(-1));
  return {
    ...previous,
    stability: {
      stable: true,
      sample_count: samples.length,
      interval_ms: intervalMs,
      geometry_tolerance_px: Math.max(0, Number(geometryTolerancePx) || 0),
      geometry_tolerance_ratio: Math.max(0, Number(geometryToleranceRatio) || 0),
      max_rect_delta_px: Math.max(...Object.values(delta)),
      rect_delta: delta
    }
  };
}

export async function waitForCvCaptureTarget(client, detailState = null, {
  timeoutMs = 6000,
  intervalMs = 250,
  ...options
} = {}) {
  const started = Date.now();
  let target = null;
  while (Date.now() - started <= Math.max(0, Number(timeoutMs) || 0)) {
    target = await resolveCvCaptureTarget(client, detailState, options);
    if (target?.node_id) {
      return {
        ok: true,
        elapsed_ms: Date.now() - started,
        target
      };
    }
    await sleep(Math.max(50, Number(intervalMs) || 250));
  }
  target = await resolveCvCaptureTarget(client, detailState, options);
  return {
    ok: Boolean(target?.node_id),
    elapsed_ms: Date.now() - started,
    target: target || null
  };
}
