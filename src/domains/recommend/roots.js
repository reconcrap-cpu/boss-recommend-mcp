import {
  findIframeDocument,
  getDocumentRoot,
  querySelector,
  sleep
} from "../../core/browser/index.js";
import { RECOMMEND_IFRAME_SELECTORS } from "./constants.js";

export async function getRecommendRoots(client, {
  iframeSelectors = RECOMMEND_IFRAME_SELECTORS,
  requireFrame = true
} = {}) {
  const topRoot = await getDocumentRoot(client);
  const iframe = await findIframeDocument(client, topRoot.nodeId, iframeSelectors);
  if (!iframe && requireFrame) {
    throw new Error("recommendFrame iframe was not found");
  }

  return {
    topRoot,
    iframe,
    roots: [
      { name: "top", nodeId: topRoot.nodeId },
      iframe ? { name: "recommend-frame", nodeId: iframe.documentNodeId } : null
    ].filter(Boolean),
    rootNodes: {
      top: topRoot.nodeId,
      frame: iframe?.documentNodeId || 0
    }
  };
}

export async function waitForRecommendRoots(client, {
  timeoutMs = 10000,
  intervalMs = 250,
  iframeSelectors = RECOMMEND_IFRAME_SELECTORS
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      lastState = await getRecommendRoots(client, {
        iframeSelectors,
        requireFrame: false
      });
    } catch (error) {
      lastState = {
        error: error?.message || String(error),
        roots: [],
        rootNodes: {
          top: 0,
          frame: 0
        }
      };
    }
    if (lastState.iframe?.documentNodeId) return lastState;
    await sleep(intervalMs);
  }
  return lastState;
}

export async function queryFirstAcrossRoots(client, roots, selectors) {
  for (const root of roots) {
    if (!root?.nodeId) continue;
    for (const selector of selectors) {
      const nodeId = await querySelector(client, root.nodeId, selector);
      if (nodeId) {
        return {
          root: root.name,
          root_node_id: root.nodeId,
          selector,
          node_id: nodeId
        };
      }
    }
  }
  return null;
}
