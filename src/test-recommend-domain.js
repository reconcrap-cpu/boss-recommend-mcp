#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chooseFilterOptionByLabels,
  chooseFilterOptionsByLabels,
  closeRecommendDetail,
  createRecoverableImageCaptureEvidence,
  chooseFirstSafeFilterOption,
  findRecommendCardNodeForCandidateKey,
  getRecommendPageScopeStatus,
  isActiveOption,
  isRecoverableImageCaptureError,
  isRecoverableRecommendDetailError,
  isSafeFilterOptionLabel,
  isStaleRecommendNodeError,
  jobLabelMatches,
  listRecommendPageScopeTabs,
  matchesRecommendDetailNetwork,
  normalizeFilterOptionLabel,
  normalizeRecommendPageScope,
  parseRecommendCardFieldsFromHtml,
  readRecommendDetailHtml,
  readRecommendCardCandidate,
  refreshRecommendListAtEnd,
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

function testJobLabelMatchingIgnoresSalaryFormatting() {
  assert.equal(jobLabelMatches("大模型高招岗位 _ 杭州 50-80K", "大模型高招岗位 _ 杭州 (50-80K)"), true);
  assert.equal(jobLabelMatches("大模型高招岗位 _ 杭州", "大模型高招岗位 _ 杭州 (50-80K)"), true);
  assert.equal(jobLabelMatches("研发实习生（AI应用方向）- 26/27届校招 _ 杭州 150-250元/天", "研发实习生（AI应用方向）- 26/27届校招 _ 杭州 (150-250元/天)"), true);
  assert.equal(jobLabelMatches("数据分析实习生 _ 杭州 100-150元/天", "算法工程师 _ 杭州 (25-50K)"), false);
}

function testRecoverableImageCaptureEvidencePreservesPartialPages() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-capture-"));
  try {
    const basePath = path.join(tempDir, "recommend-candidate-001.jpg");
    const firstPage = path.join(tempDir, "recommend-candidate-001-page-01.jpg");
    const secondPage = path.join(tempDir, "recommend-candidate-001-page-02.jpg");
    fs.writeFileSync(firstPage, "first");
    fs.writeFileSync(secondPage, "second");
    const error = new Error("Image fallback capture timed out during capture_screenshot_4 after 45000ms");
    error.code = "IMAGE_CAPTURE_TIMEOUT";
    const staleError = new Error("Could not find node with given id");

    assert.equal(isRecoverableImageCaptureError(error), true);
    assert.equal(isRecoverableImageCaptureError(staleError), true);
    assert.equal(isRecoverableRecommendDetailError(staleError), true);
    assert.equal(isRecoverableRecommendDetailError(new Error("Boss recommend page is not healthy")), false);
    assert.equal(isRecoverableImageCaptureError(new Error("Inspected target navigated or closed")), false);
    const evidence = createRecoverableImageCaptureEvidence(error, {
      elapsedMs: 45003,
      filePath: basePath,
      maxScreenshots: 4
    });

    assert.equal(evidence.ok, false);
    assert.equal(evidence.error_code, "IMAGE_CAPTURE_TIMEOUT");
    assert.equal(evidence.screenshot_count, 2);
    assert.deepEqual(evidence.file_paths, [firstPage, secondPage]);
    assert.deepEqual(evidence.llm_file_paths, []);
    const staleEvidence = createRecoverableImageCaptureEvidence(staleError, {
      filePath: basePath,
      maxScreenshots: 4
    });
    assert.equal(staleEvidence.error_code, "IMAGE_CAPTURE_STALE_NODE");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

async function testRefreshRecoveryFallsBackFromNavigateToReload() {
  const calls = [];
  const result = await refreshRecommendListAtEnd({
    Page: {
      async navigate() {
        calls.push("navigate");
        throw new Error("navigate timeout");
      },
      async reload() {
        calls.push("reload");
        throw new Error("reload timeout");
      }
    }
  }, {
    preferEndRefreshButton: false,
    forceNavigate: true,
    reloadSettleMs: 0
  });

  assert.equal(result.ok, false);
  assert.equal(result.method, "page_reload");
  assert.equal(result.reason, "page_reload_failed");
  assert.equal(result.error, "reload timeout");
  assert.deepEqual(calls, ["navigate", "reload"]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.reason), [
    "page_navigate_failed",
    "page_reload_failed"
  ]);
  assert.deepEqual(result.attempts.map((attempt) => attempt.error), [
    "navigate timeout",
    "reload timeout"
  ]);
}

function testRecommendCardFieldParser() {
  const html = `
    <div class="card-inner" data-geek="abc123">
      <div class="salary-wrap css-type-1"><span>15-30K</span></div>
      <div class="row name-wrap"><span class="name">马良</span><img class="online-marker"></div>
      <div class="join-text-wrap base-info"><span>21岁</span><span>27年应届生</span><span>本科</span></div>
      <div class="timeline-wrap work-exps">
        <div class="timeline-item">
          <div class="join-text-wrap time"><span>2026.01</span><span>2026.03</span></div>
          <div class="join-text-wrap content"><span>柠檬微趣</span><span>U3D</span></div>
        </div>
      </div>
      <div class="timeline-wrap edu-exps">
        <div class="timeline-item">
          <div class="join-text-wrap time"><span>2023</span><span>2027</span></div>
          <div class="join-text-wrap content"><span>兰州大学</span><span>计算机科学与技术</span><span>本科</span></div>
        </div>
      </div>
    </div>`;
  const fields = parseRecommendCardFieldsFromHtml(html);
  assert.equal(fields.salary, "15-30K");
  assert.equal(fields.identity.name, "马良");
  assert.equal(fields.identity.school, "兰州大学");
  assert.equal(fields.identity.major, "计算机科学与技术");
  assert.equal(fields.identity.current_company, "柠檬微趣");
  assert.equal(fields.identity.current_position, "U3D");
  assert.equal(fields.identity.degree, "本科");
  assert.equal(fields.identity.age, 21);
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

async function testCloseRecommendDetailWaitsUntilClosed() {
  let detailVisible = true;
  let closePollsRemaining = null;
  let clickCount = 0;

  const client = {
    DOM: {
      async getDocument() {
        if (closePollsRemaining !== null) {
          if (closePollsRemaining <= 0) {
            detailVisible = false;
          } else {
            closePollsRemaining -= 1;
          }
        }
        return { root: { nodeId: 1 } };
      },
      async querySelector({ nodeId, selector }) {
        if (nodeId === 1 && selector.includes("iframe")) return { nodeId: 2 };
        return { nodeId: 0 };
      },
      async describeNode({ nodeId }) {
        assert.equal(nodeId, 2);
        return { node: { contentDocument: { nodeId: 3 } } };
      },
      async querySelectorAll({ selector }) {
        if (!detailVisible) return { nodeIds: [] };
        if (selector === ".dialog-wrap.active") return { nodeIds: [5] };
        if (selector === ".boss-popup__close") return { nodeIds: [4] };
        return { nodeIds: [] };
      },
      async getBoxModel({ nodeId }) {
        assert.ok([4, 5].includes(nodeId));
        return { model: { border: [10, 10, 50, 10, 50, 40, 10, 40] } };
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        if (event.type === "mouseReleased") {
          clickCount += 1;
          closePollsRemaining = 2;
        }
        return {};
      },
      async dispatchKeyEvent() {
        return {};
      }
    }
  };

  const result = await closeRecommendDetail(client, {
    attemptsLimit: 1,
    closeWaitMs: 1500,
    escapeWaitMs: 50
  });

  assert.equal(result.closed, true);
  assert.equal(clickCount, 1);
  assert.equal(
    result.attempts.some((attempt) => (
      attempt.mode === "wait-closed-after-primary"
      && attempt.closed === true
      && attempt.elapsed_ms >= 250
    )),
    true
  );
}

testFilterOptionHelpers();
testJobLabelMatchingIgnoresSalaryFormatting();
testRecoverableImageCaptureEvidencePreservesPartialPages();
testDeterministicFilterChoice();
testTargetedFilterChoice();
testNetworkPatterns();
testRecommendCardFieldParser();
await testCardCandidateReader();
await testRefreshRecoveryFallsBackFromNavigateToReload();
await testFindFreshRecommendCardNodeByKey();
await testStaleResumeIframeDetailHtmlReadIsNonFatal();
await testPageScopeHelpers();
await testPageScopeFallbackToRecommend();
await testCloseRecommendDetailWaitsUntilClosed();

console.log("recommend domain tests passed");
