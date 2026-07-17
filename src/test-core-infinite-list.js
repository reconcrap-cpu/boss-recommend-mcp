#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  candidateKeyFromProfile,
  classifyInfiniteListBottomMarker,
  compactInfiniteListState,
  createInfiniteListState,
  getNextInfiniteListCandidate,
  markInfiniteListCandidateProcessed,
  resolveInfiniteListScrollTiming,
  resolveInfiniteListFallbackPoint
} from "./core/infinite-list/index.js";
import {
  normalizeCandidateFromHtml
} from "./core/screening/index.js";

function createFakeScrollClient({
  onWheel = () => {},
  boxForNode = null,
  queryMap = {},
  viewport = { clientWidth: 1000, clientHeight: 800 }
} = {}) {
  const events = [];
  return {
    events,
    client: {
      DOM: {
        async scrollIntoViewIfNeeded() {
          events.push({ type: "scrollIntoViewIfNeeded" });
        },
        async getBoxModel({ nodeId }) {
          if (typeof boxForNode === "function") {
            const box = await boxForNode(nodeId);
            if (box instanceof Error) throw box;
            if (box) return box;
          }
          const top = Number(nodeId) * 10;
          return {
            model: {
              border: [10, top, 110, top, 110, top + 40, 10, top + 40]
            }
          };
        },
        async querySelectorAll({ selector }) {
          return {
            nodeIds: queryMap[selector] || []
          };
        }
      },
      Input: {
        async dispatchMouseEvent(event) {
          events.push(event);
          if (event.type === "mouseWheel") onWheel(event);
        }
      },
      Page: {
        async getLayoutMetrics() {
          return {
            visualViewport: viewport
          };
        }
      }
    }
  };
}

function createSequenceRandom(values = []) {
  let index = 0;
  return () => {
    const value = values[index] ?? 0.5;
    index += 1;
    return value;
  };
}

function testCandidateKeys() {
  assert.equal(candidateKeyFromProfile({
    domain: "recommend",
    id: " geek_1 "
  }), "recommend:id:geek_1");

  assert.equal(candidateKeyFromProfile({
    domain: "recruit",
    attributes: { "data-jid": "jid_2" }
  }), "recruit:attr:jid_2");

  const searchCard = normalizeCandidateFromHtml({
    domain: "recruit",
    html: '<a data-jid="same-job" data-expect="candidate-1">候选人 A 立即沟通(30/200)</a>',
    attributes: {
      "data-jid": "same-job",
      "data-expect": "candidate-1"
    }
  });
  assert.equal(searchCard.id, "candidate-1");
  assert.equal(candidateKeyFromProfile(searchCard), "recruit:id:candidate-1");
  assert.equal(candidateKeyFromProfile({
    ...searchCard,
    text: { raw: "候选人 A 继续沟通" }
  }), "recruit:id:candidate-1");

  const identityKey = candidateKeyFromProfile({
    domain: "chat",
    identity: {
      name: "王五",
      current_position: "算法工程师",
      school: "复旦大学"
    }
  });
  assert.match(identityKey, /^chat:identity:[a-f0-9]{16}$/);

  const textKey = candidateKeyFromProfile({
    domain: "recommend",
    text: { raw: "候选人有推荐系统和机器学习经历" }
  });
  assert.match(textKey, /^recommend:text:[a-f0-9]{16}$/);
}

function testClassifiesLegacyBottomMarkers() {
  const noMore = classifyInfiniteListBottomMarker({ text: "没有更多人选" });
  assert.equal(noMore.is_bottom, true);
  assert.equal(noMore.matched_bottom_keyword, "没有更多");

  const loading = classifyInfiniteListBottomMarker({ text: "下滑加载更多" });
  assert.equal(loading.is_bottom, false);
  assert.equal(loading.matched_load_more_keyword, "下滑加载更多");

  const refreshOnly = classifyInfiniteListBottomMarker({
    text: "刷新",
    refreshButtonVisible: true
  });
  assert.equal(refreshOnly.is_bottom, true);
  assert.equal(refreshOnly.reason, "refresh_button_visible");
}

function testResolvesListScrollJitterTiming() {
  const deterministic = resolveInfiniteListScrollTiming({
    wheelDeltaY: 1000,
    settleMs: 1000
  });
  assert.equal(deterministic.wheelDeltaY, 1000);
  assert.equal(deterministic.settleMs, 1000);
  assert.equal(deterministic.wheel_delta_jitter.enabled, false);

  const jittered = resolveInfiniteListScrollTiming({
    wheelDeltaY: 1000,
    settleMs: 1000,
    listScrollJitterEnabled: true,
    listScrollJitterMinRatio: 0.8,
    listScrollJitterMaxRatio: 1.2,
    listSettleJitterMinRatio: 0.9,
    listSettleJitterMaxRatio: 1.1,
    random: createSequenceRandom([0, 1])
  });
  assert.equal(jittered.wheelDeltaY, 800);
  assert.equal(jittered.settleMs, 1100);
  assert.equal(jittered.wheel_delta_jitter.enabled, true);
  assert.equal(jittered.wheel_delta_jitter.preserve_coverage, true);
  assert.equal(jittered.settle_jitter.enabled, true);
}

async function testTraversesAfterVisibleBatchWithoutDuplicates() {
  let pageIndex = 0;
  const pages = [
    [1, 2],
    [2, 3]
  ];
  const candidates = new Map([
    [1, { domain: "recruit", id: "a", identity: { name: "A" }, attributes: {} }],
    [2, { domain: "recruit", id: "b", identity: { name: "B" }, attributes: {} }],
    [3, { domain: "recruit", id: "c", identity: { name: "C" }, attributes: {} }]
  ]);
  const { client, events } = createFakeScrollClient({
    onWheel: () => {
      pageIndex = Math.min(pageIndex + 1, pages.length - 1);
    }
  });
  const state = createInfiniteListState({ domain: "recruit", listName: "search-results" });
  const findNodeIds = async () => pages[pageIndex];
  const readCandidate = async (nodeId) => candidates.get(nodeId);

  const first = await getNextInfiniteListCandidate({
    client,
    state,
    findNodeIds,
    readCandidate,
    settleMs: 0
  });
  assert.equal(first.ok, true);
  assert.equal(first.item.key, "recruit:id:a");
  markInfiniteListCandidateProcessed(state, first.item.key);

  const second = await getNextInfiniteListCandidate({
    client,
    state,
    findNodeIds,
    readCandidate,
    settleMs: 0
  });
  assert.equal(second.ok, true);
  assert.equal(second.item.key, "recruit:id:b");
  markInfiniteListCandidateProcessed(state, second.item.key);

  const third = await getNextInfiniteListCandidate({
    client,
    state,
    findNodeIds,
    readCandidate,
    maxScrolls: 2,
    settleMs: 0
  });
  assert.equal(third.ok, true);
  assert.equal(third.item.key, "recruit:id:c");
  assert.equal(events.some((event) => event.type === "mouseWheel"), true);
  assert.equal(compactInfiniteListState(state).processed_count, 2);
  assert.equal(compactInfiniteListState(state).queued_count, 1);
}

async function testDetectsStableEndOfList() {
  const { client } = createFakeScrollClient();
  const state = createInfiniteListState({ domain: "chat", listName: "chat-candidates" });
  state.processed_keys.add("chat:id:a");
  const result = await getNextInfiniteListCandidate({
    client,
    state,
    findNodeIds: async () => [1],
    readCandidate: async () => ({ domain: "chat", id: "a", attributes: {} }),
    maxScrolls: 3,
    stableSignatureLimit: 1,
    minScrollsBeforeEnd: 1,
    settleMs: 0
  });
  assert.equal(result.ok, false);
  assert.equal(result.end_reached, true);
  assert.equal(result.reason, "stable_visible_signature");
  assert.equal(compactInfiniteListState(state).scroll_count, 1);
}

async function testDoesNotTreatSlowAppendAsEndAfterOneStableSignature() {
  let wheelCount = 0;
  const { client } = createFakeScrollClient({
    onWheel: () => {
      wheelCount += 1;
    }
  });
  const state = createInfiniteListState({ domain: "recommend", listName: "recommend-candidates" });
  state.processed_keys.add("recommend:id:a");
  state.processed_keys.add("recommend:id:b");
  const candidates = new Map([
    [1, { domain: "recommend", id: "a", attributes: {} }],
    [2, { domain: "recommend", id: "b", attributes: {} }],
    [3, { domain: "recommend", id: "c", attributes: {} }]
  ]);
  const result = await getNextInfiniteListCandidate({
    client,
    state,
    findNodeIds: async () => (wheelCount >= 2 ? [1, 2, 3] : [1, 2]),
    readCandidate: async (nodeId) => candidates.get(nodeId),
    maxScrolls: 4,
    stableSignatureLimit: 1,
    minScrollsBeforeEnd: 3,
    settleMs: 0
  });
  assert.equal(result.ok, true);
  assert.equal(result.item.key, "recommend:id:c");
  assert.equal(wheelCount >= 2, true);
  assert.equal(result.attempts.some((attempt) => attempt.stable_end_deferred), true);
}

async function testBottomMarkerStopsBeforeStableFallback() {
  const { client } = createFakeScrollClient();
  const state = createInfiniteListState({ domain: "recommend", listName: "recommend-candidates" });
  state.processed_keys.add("recommend:id:a");
  const result = await getNextInfiniteListCandidate({
    client,
    state,
    findNodeIds: async () => [1],
    readCandidate: async () => ({ domain: "recommend", id: "a", attributes: {} }),
    detectBottomMarker: async () => ({
      found: true,
      reason: "没有更多",
      source: "text_scan",
      marker: { text: "没有更多人选" }
    }),
    maxScrolls: 3,
    stableSignatureLimit: 5,
    settleMs: 0
  });
  assert.equal(result.ok, false);
  assert.equal(result.end_reached, true);
  assert.equal(result.reason, "bottom_marker");
  assert.equal(result.bottom_marker.reason, "没有更多");
  assert.equal(compactInfiniteListState(state).scroll_count, 0);
}

async function testSkipsReadErrors() {
  const { client } = createFakeScrollClient();
  const state = createInfiniteListState({ domain: "recommend", listName: "recommend-candidates" });
  const result = await getNextInfiniteListCandidate({
    client,
    state,
    findNodeIds: async () => [1, 2],
    readCandidate: async (nodeId) => {
      if (nodeId === 1) throw new Error("stale node");
      return { domain: "recommend", id: "ok", attributes: {} };
    },
    settleMs: 0
  });
  assert.equal(result.ok, true);
  assert.equal(result.item.key, "recommend:id:ok");
  assert.equal(compactInfiniteListState(state).read_error_count, 1);
}

async function testRethrowsSelectedReadErrors() {
  const { client } = createFakeScrollClient();
  const state = createInfiniteListState({ domain: "recommend", listName: "recommend-candidates" });
  const staleError = new Error("Could not find node with given id");
  staleError.cdp_method = "DOM.getOuterHTML";
  await assert.rejects(
    () => getNextInfiniteListCandidate({
      client,
      state,
      findNodeIds: async () => [1, 2],
      readCandidate: async (nodeId) => {
        if (nodeId === 1) throw staleError;
        return { domain: "recommend", id: "unreachable", attributes: {} };
      },
      shouldRethrowReadError: (error) => error === staleError,
      settleMs: 0
    }),
    (error) => error === staleError
  );
  const compact = compactInfiniteListState(state);
  assert.equal(compact.read_error_count, 1);
  assert.equal(state.ledger.at(-1)?.event, "candidate_read_error");
}

async function testResolvesContainerFallbackPoint() {
  const { client } = createFakeScrollClient({
    queryMap: {
      ".chat-list": [10]
    },
    boxForNode: (nodeId) => {
      if (nodeId === 10) {
        return {
          model: {
            border: [100, 50, 300, 50, 300, 450, 100, 450]
          }
        };
      }
      return null;
    }
  });
  const fallback = await resolveInfiniteListFallbackPoint(client, {
    rootNodeId: 1,
    containerSelectors: [".chat-list"],
    viewportPoint: { xRatio: 0.3, yRatio: 0.72 }
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.source, "container");
  assert.deepEqual(fallback.point, { x: 200, y: 250 });
}

async function testContainerFallbackClampsTallVirtualListToViewport() {
  const { client } = createFakeScrollClient({
    queryMap: {
      ".long-list": [10]
    },
    boxForNode: (nodeId) => {
      if (nodeId === 10) {
        return {
          model: {
            border: [100, 100, 300, 100, 300, 2100, 100, 2100]
          }
        };
      }
      return null;
    },
    viewport: {
      clientWidth: 1000,
      clientHeight: 800
    }
  });
  const fallback = await resolveInfiniteListFallbackPoint(client, {
    rootNodeId: 1,
    containerSelectors: [".long-list"],
    allowedSources: ["container"]
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.source, "container");
  assert.deepEqual(fallback.point, { x: 200, y: 450 });
  assert.equal(fallback.rect.height, 700);
  assert.equal(fallback.full_rect.height, 2000);
}

async function testAllowedSourcesCanForceItemUnionFallbackPoint() {
  const { client } = createFakeScrollClient({
    queryMap: {
      ".chat-list": [10]
    },
    boxForNode: (nodeId) => {
      if (nodeId === 10) {
        return {
          model: {
            border: [100, 50, 300, 50, 300, 450, 100, 450]
          }
        };
      }
      if (nodeId === 21) {
        return {
          model: {
            border: [120, 120, 320, 120, 320, 220, 120, 220]
          }
        };
      }
      if (nodeId === 22) {
        return {
          model: {
            border: [120, 230, 320, 230, 320, 330, 120, 330]
          }
        };
      }
      return null;
    }
  });
  const fallback = await resolveInfiniteListFallbackPoint(client, {
    rootNodeId: 1,
    containerSelectors: [".chat-list"],
    itemNodeIds: [21, 22],
    allowedSources: ["item_union"],
    viewportPoint: { xRatio: 0.3, yRatio: 0.72 }
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.source, "item_union");
  assert.deepEqual(fallback.point, { x: 210, y: 225 });
  assert.deepEqual(fallback.rect, { x: 120, y: 120, width: 180, height: 210 });
  assert.deepEqual(fallback.full_rect, { x: 120, y: 120, width: 200, height: 210 });
}

async function testItemUnionFallbackIgnoresOffscreenVirtualItems() {
  const { client } = createFakeScrollClient({
    queryMap: {
      ".chat-list": [10]
    },
    boxForNode: (nodeId) => {
      if (nodeId === 10) {
        return {
          model: {
            border: [100, 50, 500, 50, 500, 650, 100, 650]
          }
        };
      }
      if (nodeId === 21) {
        return {
          model: {
            border: [120, 100, 320, 100, 320, 200, 120, 200]
          }
        };
      }
      if (nodeId === 22) {
        return {
          model: {
            border: [120, 900, 320, 900, 320, 1000, 120, 1000]
          }
        };
      }
      return null;
    },
    viewport: {
      clientWidth: 1000,
      clientHeight: 800
    }
  });
  const fallback = await resolveInfiniteListFallbackPoint(client, {
    rootNodeId: 1,
    containerSelectors: [".chat-list"],
    itemNodeIds: [21, 22],
    allowedSources: ["item_union"],
    viewportPoint: { xRatio: 0.3, yRatio: 0.72 }
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.source, "item_union");
  assert.equal(fallback.visible_item_box_count, 1);
  assert.deepEqual(fallback.point, { x: 220, y: 150 });
}

async function testAllowedSourcesCanForceValidatedViewportFallbackPoint() {
  const { client } = createFakeScrollClient({
    queryMap: {
      ".chat-list": [10]
    },
    boxForNode: (nodeId) => {
      if (nodeId === 10) {
        return {
          model: {
            border: [100, 50, 500, 50, 500, 650, 100, 650]
          }
        };
      }
      return null;
    },
    viewport: {
      clientWidth: 1000,
      clientHeight: 800
    }
  });
  const fallback = await resolveInfiniteListFallbackPoint(client, {
    rootNodeId: 1,
    containerSelectors: [".chat-list"],
    allowedSources: ["viewport_ratio"],
    viewportPoint: { xRatio: 0.3, yRatio: 0.5 },
    validateViewportPoint: true
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.source, "viewport_ratio");
  assert.equal(fallback.validated, true);
  assert.deepEqual(fallback.point, { x: 300, y: 400 });
}

async function testRejectsUnvalidatedViewportFallback() {
  const { client } = createFakeScrollClient();
  const fallback = await resolveInfiniteListFallbackPoint(client, {
    rootNodeId: 1,
    containerSelectors: [".missing"],
    itemSelectors: [".missing-card"],
    viewportPoint: { xRatio: 0.3, yRatio: 0.72 },
    validateViewportPoint: true
  });
  assert.equal(fallback.ok, false);
  assert.equal(fallback.reason, "fallback_point_unavailable");
}

async function testUsesFallbackResolverAfterStaleAnchors() {
  let wheelCount = 0;
  const { client, events } = createFakeScrollClient({
    onWheel: () => {
      wheelCount += 1;
    },
    boxForNode: () => new Error("stale node")
  });
  const state = createInfiniteListState({ domain: "chat", listName: "chat-candidates" });
  state.processed_keys.add("chat:id:a");
  const result = await getNextInfiniteListCandidate({
    client,
    state,
    findNodeIds: async () => [1],
    readCandidate: async () => ({ domain: "chat", id: "a", attributes: {} }),
    fallbackPoint: async () => ({
      ok: true,
      source: "container",
      point: { x: 300, y: 500 }
    }),
    maxScrolls: 0,
    stableSignatureLimit: 5,
    settleMs: 0
  });
  const wheel = events.find((event) => event.type === "mouseWheel");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "max_scrolls_exhausted");
  assert.equal(wheelCount, 1);
  assert.equal(wheel.x, 300);
  assert.equal(wheel.y, 500);
  assert.equal(result.attempts[0].scroll_result.mode, "fallback_point");
  assert.equal(result.attempts[0].scroll_result.fallback.source, "container");
}

testCandidateKeys();
testClassifiesLegacyBottomMarkers();
testResolvesListScrollJitterTiming();
await testTraversesAfterVisibleBatchWithoutDuplicates();
await testDetectsStableEndOfList();
await testDoesNotTreatSlowAppendAsEndAfterOneStableSignature();
await testBottomMarkerStopsBeforeStableFallback();
await testSkipsReadErrors();
await testRethrowsSelectedReadErrors();
await testResolvesContainerFallbackPoint();
await testContainerFallbackClampsTallVirtualListToViewport();
await testAllowedSourcesCanForceItemUnionFallbackPoint();
await testItemUnionFallbackIgnoresOffscreenVirtualItems();
await testAllowedSourcesCanForceValidatedViewportFallbackPoint();
await testRejectsUnvalidatedViewportFallback();
await testUsesFallbackResolverAfterStaleAnchors();

console.log("core infinite list tests passed");
