import {
  findIframeDocument,
  getDocumentRoot,
  querySelector,
  sleep
} from "../../core/browser/index.js";
import { RECRUIT_IFRAME_SELECTORS } from "./constants.js";

export async function getRecruitRoots(client, {
  iframeSelectors = RECRUIT_IFRAME_SELECTORS,
  requireFrame = true
} = {}) {
  const topRoot = await getDocumentRoot(client);
  const iframe = await findIframeDocument(client, topRoot.nodeId, iframeSelectors);
  if (!iframe && requireFrame) {
    throw new Error("searchFrame iframe was not found");
  }

  return {
    topRoot,
    iframe,
    roots: [
      { name: "top", nodeId: topRoot.nodeId },
      iframe ? { name: "search-frame", nodeId: iframe.documentNodeId } : null
    ].filter(Boolean),
    rootNodes: {
      top: topRoot.nodeId,
      frame: iframe?.documentNodeId || 0
    }
  };
}

export async function waitForRecruitRoots(client, {
  timeoutMs = 12000,
  intervalMs = 300,
  iframeSelectors = RECRUIT_IFRAME_SELECTORS
} = {}) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started <= timeoutMs) {
    lastState = await getRecruitRoots(client, {
      iframeSelectors,
      requireFrame: false
    });
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
