import {
  getDocumentRoot,
  querySelector,
  sleep
} from "../../core/browser/index.js";

export async function getChatRoots(client) {
  const topRoot = await getDocumentRoot(client);
  return {
    topRoot,
    roots: [
      { name: "top", nodeId: topRoot.nodeId }
    ],
    rootNodes: {
      top: topRoot.nodeId
    }
  };
}

export async function waitForChatRoots(client, {
  timeoutMs = 12000,
  intervalMs = 300
} = {}) {
  const started = Date.now();
  let lastState = null;
  let lastError = null;
  while (Date.now() - started <= timeoutMs) {
    try {
      lastState = await getChatRoots(client);
      if (lastState?.rootNodes?.top) return lastState;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError && !lastState) throw lastError;
  return lastState;
}

export async function queryFirstAcrossChatRoots(client, roots, selectors) {
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
