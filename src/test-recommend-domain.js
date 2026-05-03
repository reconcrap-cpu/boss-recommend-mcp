#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  chooseFilterOptionByLabels,
  chooseFilterOptionsByLabels,
  chooseFirstSafeFilterOption,
  findRecommendCardNodeForCandidateKey,
  getRecommendPageScopeStatus,
  isActiveOption,
  isSafeFilterOptionLabel,
  isStaleRecommendNodeError,
  listRecommendPageScopeTabs,
  matchesRecommendDetailNetwork,
  normalizeFilterOptionLabel,
  normalizeRecommendPageScope,
  readRecommendDetailHtml,
  readRecommendCardCandidate,
  selectRecommendPageScope
} from "./domains/recommend/index.js";

function testFilterOptionHelpers() {
  assert.equal(normalizeFilterOptionLabel("  不 限  "), "不限");
  assert.equal(isSafeFilterOptionLabel("不限"), false);
  assert.equal(isSafeFilterOptionLabel("全部"), false);
  assert.equal(isSafeFilterOptionLabel("All"), false);
  assert.equal(isSafeFilterOptionLabel("本科"), true);
  assert.equal(isActiveOption({ class: "option active" }), true);
  assert.equal(isActiveOption({ class: "option" }, '<span class="option active">本科</span>'), true);
}

function testDeterministicFilterChoice() {
  const selected = chooseFirstSafeFilterOption([
    { group: "degree", label: "本科", active: false, node_id: 3 },
    { group: "recentNotView", label: "不限", active: false, node_id: 1 },
    { group: "recentNotView", label: "3天内未查看", active: true, node_id: 2 },
    { group: "gender", label: "男", active: false, node_id: 4 }
  ]);
  assert.deepEqual(selected, {
    group: "degree",
    label: "本科",
    active: false,
    node_id: 3
  });
}

function testTargetedFilterChoice() {
  const selected = chooseFilterOptionByLabels([
    { group: "degree", label: "本科", active: false, node_id: 3 },
    { group: "degree", label: "硕士", active: false, node_id: 4 },
    { group: "gender", label: "男", active: false, node_id: 5 }
  ], {
    group: "degree",
    labels: ["硕士", "博士"]
  });
  assert.deepEqual(selected, {
    group: "degree",
    label: "硕士",
    active: false,
    node_id: 4
  });

  const skippedActive = chooseFilterOptionByLabels([
    { group: "degree", label: "本科", active: true, node_id: 3 },
    { group: "degree", label: "博士", active: false, node_id: 6 }
  ], {
    group: "degree",
    labels: ["本科", "博士"]
  });
  assert.equal(skippedActive.node_id, 6);

  const multi = chooseFilterOptionsByLabels([
    { group: "degree", label: "本科", active: false, node_id: 3 },
    { group: "degree", label: "硕士", active: false, node_id: 4 },
    { group: "degree", label: "博士", active: false, node_id: 5 }
  ], {
    group: "degree",
    labels: ["本科", "硕士", "博士"]
  });
  assert.deepEqual(multi.map((item) => item.option?.node_id), [3, 4, 5]);
}

function testNetworkPatterns() {
  assert.equal(matchesRecommendDetailNetwork("https://www.zhipin.com/wapi/zpjob/view/geek/info?id=1"), true);
  assert.equal(matchesRecommendDetailNetwork("https://www.zhipin.com/web/frame/c-resume/foo"), true);
  assert.equal(matchesRecommendDetailNetwork("https://example.com/assets/app.js"), false);
}

async function testCardCandidateReader() {
  const client = {
    DOM: {
      async getAttributes() {
        return {
          attributes: ["data-geek", "abc123", "class", "card-inner"]
        };
      },
      async getOuterHTML() {
        return {
          outerHTML: '<div class="card-inner" data-geek="abc123"><span>张三</span><span>本科</span><span>算法工程师</span></div>'
        };
      }
    }
  };
  const candidate = await readRecommendCardCandidate(client, 42, {
    targetUrl: "https://www.zhipin.com/web/chat/recommend"
  });
  assert.equal(candidate.domain, "recommend");
  assert.equal(candidate.id, "abc123");
  assert.equal(candidate.identity.degree, "本科");
  assert.match(candidate.text.raw, /算法工程师/);
}

async function testFindFreshRecommendCardNodeByKey() {
  const nodes = {
    101: {
      attrs: ["data-geek", "stale-1", "class", "candidate-card-wrap"],
      html: '<div class="candidate-card-wrap" data-geek="stale-1"><span>候选人A</span><span>本科</span></div>'
    },
    102: {
      attrs: ["data-geek", "fresh-2", "class", "candidate-card-wrap"],
      html: '<div class="candidate-card-wrap" data-geek="fresh-2"><span>候选人B</span><span>硕士</span></div>'
    }
  };
  const client = {
    DOM: {
      async querySelectorAll() {
        return { nodeIds: [101, 102] };
      },
      async getAttributes({ nodeId }) {
        return { attributes: nodes[nodeId].attrs };
      },
      async getOuterHTML({ nodeId }) {
        return { outerHTML: nodes[nodeId].html };
      }
    }
  };

  assert.equal(isStaleRecommendNodeError(new Error("Could not find node with given id")), true);
  const result = await findRecommendCardNodeForCandidateKey(client, {
    candidateKey: "recommend:id:fresh-2",
    rootState: {
      iframe: { documentNodeId: 9 }
    },
    timeoutMs: 20,
    intervalMs: 0
  });
  assert.equal(result.ok, true);
  assert.equal(result.node_id, 102);
  assert.equal(result.candidate.id, "fresh-2");
}

async function testStaleResumeIframeDetailHtmlReadIsNonFatal() {
  const client = {
    DOM: {
      async getOuterHTML({ nodeId }) {
        assert.equal(nodeId, 201);
        return {
          outerHTML: '<div class="dialog-wrap"><span>候选人详情</span></div>'
        };
      },
      async describeNode() {
        throw new Error("Could not find node with given id");
      }
    }
  };

  const html = await readRecommendDetailHtml(client, {
    popup: { node_id: 201 },
    resumeIframe: { node_id: 202 }
  });
  assert.match(html.popupText, /候选人详情/);
  assert.equal(html.resumeHTML, "");
  assert.equal(html.resumeIframeDocumentNodeId, null);
  assert.equal(html.errors.length, 1);
  assert.equal(html.errors[0].source, "resume_iframe");
  assert.equal(html.errors[0].stale_node, true);
}

async function testPageScopeHelpers() {
  assert.equal(normalizeRecommendPageScope("推荐"), "recommend");
  assert.equal(normalizeRecommendPageScope("精选"), "featured");
  assert.equal(normalizeRecommendPageScope("最新"), "latest");
  assert.equal(getRecommendPageScopeStatus("featured"), "3");

  const nodes = {
    1: {
      attrs: ["class", "tab-item curr", "data-status", "0", "title", "推荐"],
      html: '<span class="tab-item curr" data-status="0" title="推荐">推荐</span>',
      box: [0, 0, 32, 0, 32, 36, 0, 36]
    },
    2: {
      attrs: ["class", "tab-item", "data-status", "3", "title", "精选牛人"],
      html: '<span class="tab-item" data-status="3" title="精选牛人">精选 <em>11</em></span>',
      box: [60, 0, 92, 0, 92, 36, 60, 36]
    },
    3: {
      attrs: ["class", "tab-item", "data-status", "1", "title", "新牛人"],
      html: '<span class="tab-item" data-status="1" title="新牛人">最新</span>',
      box: [120, 0, 152, 0, 152, 36, 120, 36]
    }
  };
  const client = {
    DOM: {
      async querySelectorAll() {
        return { nodeIds: [1, 2, 3] };
      },
      async getAttributes({ nodeId }) {
        return { attributes: nodes[nodeId].attrs };
      },
      async getOuterHTML({ nodeId }) {
        return { outerHTML: nodes[nodeId].html };
      },
      async getBoxModel({ nodeId }) {
        return { model: { border: nodes[nodeId].box } };
      }
    }
  };
  const tabs = await listRecommendPageScopeTabs(client, 99);
  assert.deepEqual(tabs.map((tab) => tab.scope), ["recommend", "featured", "latest"]);
  assert.deepEqual(tabs.map((tab) => tab.current), [true, false, false]);
}

async function testPageScopeFallbackToRecommend() {
  let clicked = false;
  let recommendCurrent = false;
  const client = {
    DOM: {
      async querySelectorAll({ selector }) {
        if (String(selector).includes("candidate-card-wrap")) {
          return { nodeIds: recommendCurrent ? [101, 102] : [] };
        }
        return { nodeIds: [1] };
      },
      async getAttributes({ nodeId }) {
        assert.equal(nodeId, 1);
        return {
          attributes: [
            "class",
            recommendCurrent ? "tab-item curr" : "tab-item",
            "data-status",
            "0",
            "title",
            "推荐"
          ]
        };
      },
      async getOuterHTML({ nodeId }) {
        assert.equal(nodeId, 1);
        const className = recommendCurrent ? "tab-item curr" : "tab-item";
        return {
          outerHTML: `<span class="${className}" data-status="0" title="推荐">推荐</span>`
        };
      },
      async getBoxModel({ nodeId }) {
        assert.equal(nodeId, 1);
        return { model: { border: [10, 10, 50, 10, 50, 40, 10, 40] } };
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        if (event.type === "mouseReleased") {
          clicked = true;
          recommendCurrent = true;
        }
        return {};
      }
    }
  };

  const result = await selectRecommendPageScope(client, 99, {
    pageScope: "featured",
    fallbackScope: "recommend",
    settleMs: 0,
    timeoutMs: 500
  });

  assert.equal(clicked, true);
  assert.equal(result.requested_scope, "featured");
  assert.equal(result.effective_scope, "recommend");
  assert.equal(result.fallback_applied, true);
  assert.equal(result.selected, true);
  assert.deepEqual(result.available_scopes, ["recommend"]);
  assert.equal(result.after.card_count, 2);
}

testFilterOptionHelpers();
testDeterministicFilterChoice();
testTargetedFilterChoice();
testNetworkPatterns();
await testCardCandidateReader();
await testFindFreshRecommendCardNodeByKey();
await testStaleResumeIframeDetailHtmlReadIsNonFatal();
await testPageScopeHelpers();
await testPageScopeFallbackToRecommend();

console.log("recommend domain tests passed");
