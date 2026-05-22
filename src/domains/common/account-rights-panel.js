import {
  clickPoint,
  DETERMINISTIC_CLICK_OPTIONS,
  getDocumentRoot,
  getNodeBox,
  pressKey,
  querySelectorAll,
  sleep
} from "../../core/browser/index.js";

export const BOSS_ACCOUNT_RIGHTS_PANEL_TEXT_QUERIES = Object.freeze([
  "我的权益",
  "VVIP账号-精选版专享权益",
  "全部账号权益使用量",
  "职位发布权益总量",
  "每日使用权益总量"
]);

export const BOSS_ACCOUNT_RIGHTS_PANEL_CLOSE_SELECTORS = Object.freeze([
  ".boss-popup__close",
  ".boss-dialog__close",
  ".side-panel-close",
  ".drawer-close",
  ".panel-close",
  ".popup-close",
  ".modal-close",
  ".dialog-close",
  ".close-btn",
  ".icon-close",
  "[class*=\"close\"]",
  '[aria-label*="关闭"]',
  '[title*="关闭"]'
]);

async function performDomTextSearch(client, query, {
  limit = 6
} = {}) {
  if (typeof client?.DOM?.performSearch !== "function"
    || typeof client?.DOM?.getSearchResults !== "function") {
    return [];
  }

  const searchOnce = async () => {
    let searchId = "";
    try {
      const search = await client.DOM.performSearch({
        query,
        includeUserAgentShadowDOM: true
      });
      searchId = search?.searchId || "";
      const resultCount = Math.min(Number(search?.resultCount) || 0, Math.max(0, Number(limit) || 0));
      if (!searchId || resultCount <= 0) return [];
      const results = await client.DOM.getSearchResults({
        searchId,
        fromIndex: 0,
        toIndex: resultCount
      });
      return results?.nodeIds || [];
    } catch {
      return [];
    } finally {
      if (searchId && typeof client?.DOM?.discardSearchResults === "function") {
        try {
          await client.DOM.discardSearchResults({ searchId });
        } catch {
          // Best-effort cleanup only.
        }
      }
    }
  };

  const firstPass = await searchOnce();
  if (!firstPass.length) return [];
  const firstPassNodeIds = firstPass.filter((nodeId) => Number(nodeId) > 0);
  if (firstPassNodeIds.length || typeof client?.DOM?.getDocument !== "function") return firstPassNodeIds;

  try {
    await client.DOM.getDocument({
      depth: -1,
      pierce: true
    });
  } catch {
    return firstPassNodeIds;
  }
  return (await searchOnce()).filter((nodeId) => Number(nodeId) > 0);
}

export async function findBossAccountRightsBlockingPanel(client, {
  textQueries = BOSS_ACCOUNT_RIGHTS_PANEL_TEXT_QUERIES
} = {}) {
  for (const query of textQueries || []) {
    const nodeIds = await performDomTextSearch(client, query);
    for (const nodeId of nodeIds) {
      try {
        const box = await getNodeBox(client, nodeId);
        if (box?.rect?.width > 2 && box?.rect?.height > 2) {
          return {
            open: true,
            reason: "account_rights_panel_text_visible",
            query,
            node_id: nodeId,
            rect: box.rect,
            center: box.center
          };
        }
      } catch {
        // Hidden or stale text hits are ignored.
      }
    }
  }
  return {
    open: false
  };
}

export function accountRightsPanelOutsideClickPoint(probe = {}) {
  const rect = probe?.rect || {};
  // Click the empty lower-left sidebar area. It is outside the rights drawer
  // and avoids top nav, chat rows, message controls, and candidate actions.
  const x = 84;
  const y = Number.isFinite(Number(rect.y))
    ? Math.max(560, Math.min(680, Number(rect.y) + 600))
    : 660;
  return {
    x,
    y,
    mode: "empty-lower-left-sidebar"
  };
}

async function resolveBlockingPanelRoots(client, {
  roots = null,
  rootState = null,
  resolveRoots = null
} = {}) {
  if (Array.isArray(roots) && roots.some((root) => root?.nodeId)) {
    return roots.filter((root) => root?.nodeId);
  }
  if (Array.isArray(rootState?.roots) && rootState.roots.some((root) => root?.nodeId)) {
    return rootState.roots.filter((root) => root?.nodeId);
  }
  if (typeof resolveRoots === "function") {
    try {
      const resolved = await resolveRoots(client);
      if (Array.isArray(resolved)) return resolved.filter((root) => root?.nodeId);
      if (Array.isArray(resolved?.roots)) return resolved.roots.filter((root) => root?.nodeId);
    } catch {
      // Fall through to the top document. The rights panel lives there.
    }
  }
  try {
    const topRoot = await getDocumentRoot(client);
    return [{ name: "top", nodeId: topRoot.nodeId }];
  } catch {
    return [];
  }
}

async function findVisibleCloseTarget(client, roots, selectors) {
  let fallback = null;
  for (const root of roots || []) {
    if (!root?.nodeId) continue;
    for (const selector of selectors || []) {
      let nodeIds = [];
      try {
        nodeIds = await querySelectorAll(client, root.nodeId, selector);
      } catch {
        nodeIds = [];
      }
      for (const nodeId of nodeIds) {
        const target = {
          root: root.name,
          root_node_id: root.nodeId,
          selector,
          node_id: nodeId
        };
        if (!fallback) fallback = target;
        try {
          const box = await getNodeBox(client, nodeId);
          if (box?.rect?.width > 2 && box?.rect?.height > 2) {
            return {
              ...target,
              center: box.center,
              rect: box.rect
            };
          }
        } catch {
          // Stale close candidates are ignored.
        }
      }
    }
  }
  return fallback;
}

async function pressEscape(client) {
  await pressKey(client, "Escape", {
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27
  });
}

export async function closeBossAccountRightsBlockingPanel(client, {
  attemptsLimit = 2,
  closeSelectors = BOSS_ACCOUNT_RIGHTS_PANEL_CLOSE_SELECTORS,
  resolveRoots = null,
  roots = null,
  rootState = null,
  textQueries = BOSS_ACCOUNT_RIGHTS_PANEL_TEXT_QUERIES,
  waitMs = 700
} = {}) {
  const attempts = [];
  let probe = await findBossAccountRightsBlockingPanel(client, { textQueries });
  if (!probe.open) {
    return {
      closed: true,
      already_closed: true,
      probe,
      attempts
    };
  }

  for (let index = 0; index < attemptsLimit; index += 1) {
    const outsidePoint = accountRightsPanelOutsideClickPoint(probe);
    try {
      await clickPoint(client, outsidePoint.x, outsidePoint.y, DETERMINISTIC_CLICK_OPTIONS);
      attempts.push({
        mode: "outside-click",
        point: outsidePoint
      });
    } catch (error) {
      attempts.push({
        mode: "outside-click-error",
        point: outsidePoint,
        error: error?.message || String(error)
      });
    }
    await sleep(waitMs);

    probe = await findBossAccountRightsBlockingPanel(client, { textQueries });
    if (!probe.open) {
      return {
        closed: true,
        already_closed: false,
        probe,
        attempts
      };
    }

    const resolvedRoots = await resolveBlockingPanelRoots(client, { roots, rootState, resolveRoots });
    const closeTarget = await findVisibleCloseTarget(client, resolvedRoots, closeSelectors);
    if (closeTarget) {
      try {
        if (closeTarget.center) {
          await clickPoint(client, closeTarget.center.x, closeTarget.center.y, DETERMINISTIC_CLICK_OPTIONS);
        }
        attempts.push({
          mode: "close-selector",
          selector: closeTarget.selector,
          root: closeTarget.root
        });
      } catch (error) {
        attempts.push({
          mode: "close-selector-error",
          selector: closeTarget.selector,
          root: closeTarget.root,
          error: error?.message || String(error)
        });
      }
      await sleep(waitMs);

      probe = await findBossAccountRightsBlockingPanel(client, { textQueries });
      if (!probe.open) {
        return {
          closed: true,
          already_closed: false,
          probe,
          attempts
        };
      }
    }

    try {
      await pressEscape(client);
      attempts.push({ mode: closeTarget ? "Escape-fallback" : "Escape" });
    } catch (error) {
      attempts.push({
        mode: "Escape-error",
        error: error?.message || String(error)
      });
    }
    await sleep(waitMs);

    probe = await findBossAccountRightsBlockingPanel(client, { textQueries });
    if (!probe.open) {
      return {
        closed: true,
        already_closed: false,
        probe,
        attempts
      };
    }
  }

  return {
    closed: false,
    already_closed: false,
    reason: "account_rights_panel_still_visible_after_close_attempts",
    probe,
    attempts
  };
}

