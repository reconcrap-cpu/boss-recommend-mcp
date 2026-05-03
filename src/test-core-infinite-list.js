#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  candidateKeyFromProfile,
  compactInfiniteListState,
  createInfiniteListState,
  getNextInfiniteListCandidate,
  markInfiniteListCandidateProcessed
} from "./core/infinite-list/index.js";
import {
  normalizeCandidateFromHtml
} from "./core/screening/index.js";

function createFakeScrollClient({ onWheel = () => {} } = {}) {
  const events = [];
  return {
    events,
    client: {
      DOM: {
        async scrollIntoViewIfNeeded() {
          events.push({ type: "scrollIntoViewIfNeeded" });
        },
        async getBoxModel({ nodeId }) {
          const top = Number(nodeId) * 10;
          return {
            model: {
              border: [10, top, 110, top, 110, top + 40, 10, top + 40]
            }
          };
        }
      },
      Input: {
        async dispatchMouseEvent(event) {
          events.push(event);
          if (event.type === "mouseWheel") onWheel(event);
        }
      }
    }
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
    settleMs: 0
  });
  assert.equal(result.ok, false);
  assert.equal(result.end_reached, true);
  assert.equal(result.reason, "stable_visible_signature");
  assert.equal(compactInfiniteListState(state).scroll_count, 1);
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

testCandidateKeys();
await testTraversesAfterVisibleBatchWithoutDuplicates();
await testDetectsStableEndOfList();
await testSkipsReadErrors();

console.log("core infinite list tests passed");
