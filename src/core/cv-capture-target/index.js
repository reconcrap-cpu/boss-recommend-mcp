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
  if (/boss-popup|boss-dialog|dialog-wrap|geek-detail-modal|\bmodal\b|new-chat-resume-dialog-main-ui/i.test(normalized)) {
    return false;
  }
  return /resume-item-detail|resume-detail-wrap|resume-content-wrap|resume-common-wrap|new-resume-online-main-ui|resume-detail(?:\b|[.#:])|resume-recommend|canvas#resume|resume-container/i.test(normalized);
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
  fallback = false
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
    center: box?.center || null
  };
}

async function firstVisibleSelectorTarget(client, roots = [], selectors = CV_CAPTURE_TARGET_SELECTORS, {
  domain = "",
  source = "cv_selector",
  iframeNodeId = null,
  iframeDocumentNodeId = null
} = {}) {
  for (const root of uniqueRoots(roots)) {
    for (const selector of selectors) {
      let nodeIds = [];
      try {
        nodeIds = await querySelectorAll(client, root.nodeId, selector);
      } catch {
        nodeIds = [];
      }
      for (const nodeId of nodeIds) {
        const box = await readVisibleBox(client, nodeId);
        if (!box) continue;
        return buildTarget({
          domain,
          nodeId,
          source,
          selector,
          root: root.name,
          rootNodeId: root.nodeId,
          box,
          iframeNodeId,
          iframeDocumentNodeId
        });
      }
    }
  }
  return null;
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
    fallback
  });
}

async function resolveIframeCaptureTarget(client, resumeIframe = null, {
  domain = "",
  selectors = CV_CAPTURE_TARGET_SELECTORS
} = {}) {
  const iframeNodeId = slotNodeId(resumeIframe);
  if (!iframeNodeId) return null;

  try {
    const documentNodeId = await getFrameDocumentNodeId(client, iframeNodeId);
    const selectorTarget = await firstVisibleSelectorTarget(client, [{
      name: "resume-iframe-document",
      nodeId: documentNodeId
    }], selectors, {
      domain,
      source: "resume_iframe_cv_selector",
      iframeNodeId,
      iframeDocumentNodeId: documentNodeId
    });
    if (selectorTarget) return selectorTarget;

    for (const selector of IFRAME_BODY_SELECTORS) {
      const nodeId = await querySelector(client, documentNodeId, selector).catch(() => 0);
      const box = await readVisibleBox(client, nodeId);
      if (!box) continue;
      return buildTarget({
        domain,
        nodeId,
        source: "resume_iframe_body",
        selector,
        root: "resume-iframe-document",
        rootNodeId: documentNodeId,
        box,
        iframeNodeId,
        iframeDocumentNodeId: documentNodeId
      });
    }
  } catch {}

  const iframeBox = await readVisibleBox(client, iframeNodeId);
  if (!iframeBox) return null;
  return buildTarget({
    domain,
    nodeId: iframeNodeId,
    source: "resume_iframe_element",
    selector: resumeIframe?.selector || null,
    root: resumeIframe?.root || null,
    rootNodeId: resumeIframe?.root_node_id || null,
    box: iframeBox,
    iframeNodeId,
    fallback: false
  });
}

async function resolveSlotCaptureTarget(client, slot = null, {
  domain = "",
  slotName = "content",
  selectors = CV_CAPTURE_TARGET_SELECTORS
} = {}) {
  const root = slotAsRoot(slot, slotName);
  const selectorTarget = root
    ? await firstVisibleSelectorTarget(client, [root], selectors, {
      domain,
      source: `${slotName}_cv_selector`
    })
    : null;
  if (selectorTarget) return selectorTarget;
  return visibleSlotTarget(client, slot, {
    domain,
    source: `${slotName}_cv_slot`
  });
}

export async function resolveCvCaptureTarget(client, detailState = null, {
  domain = "",
  selectors = CV_CAPTURE_TARGET_SELECTORS
} = {}) {
  const iframeTarget = await resolveIframeCaptureTarget(client, detailState?.resumeIframe, {
    domain,
    selectors
  });
  if (iframeTarget) return iframeTarget;

  const contentTarget = await resolveSlotCaptureTarget(client, detailState?.content, {
    domain,
    slotName: "content",
    selectors
  });
  if (contentTarget) return contentTarget;

  const popupTarget = await resolveSlotCaptureTarget(client, detailState?.popup, {
    domain,
    slotName: "popup",
    selectors
  });
  if (popupTarget) return popupTarget;

  return firstVisibleSelectorTarget(client, detailState?.roots || [], selectors, {
    domain,
    source: "root_cv_selector"
  });
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
