#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chooseFilterOptionByLabels,
  chooseFilterOptionsByLabels,
  closeRecommendBlockingPanels,
  closeRecommendAvatarPreview,
  closeRecommendDetail,
  closeRecommendJobDropdownFully,
  compactRecommendRefreshErrorDiagnostic,
  createRecoverableImageCaptureEvidence,
  chooseFirstSafeFilterOption,
  ensureRecommendCurrentCityOnly,
  findRecommendBlockingPanel,
  findRecommendCardNodeForCandidateKey,
  getRecommendPageScopeStatus,
  isActiveOption,
  isRecoverableImageCaptureError,
  isCleanRecommendPostClickBindingReadinessTimeout,
  isRecoverableRecommendDetailError,
  isRecommendActivityGroupText,
  isRetryableRecommendFilterReapplyError,
  isRetryableRecommendJobSelectionError,
  isSafeFilterOptionLabel,
  isStaleRecommendNodeError,
  jobLabelMatches,
  listFilterOptions,
  listRecommendPageScopeTabs,
  matchesRecommendDetailNetwork,
  normalizeFilterOptionLabel,
  normalizeRecommendPageScope,
  openRecommendCardDetail,
  openRecommendCardDetailWithFreshRetry,
  openRecommendJobDropdown,
  parseColleagueContactDate,
  parseRecommendCardFieldsFromHtml,
  readRecommendAvatarPreviewState,
  readRecommendCardClickViewportEvidence,
  readRecommendDetailHtml,
  readRecommendCardCandidate,
  readRecommendCardPreClickProvenance,
  refreshRecommendListAtEnd,
  inspectRecommendFilteredEmptyState,
  isVerifiedRecommendFilterApplication,
  isVerifiedRecommendRefreshExhaustion,
  selectAndConfirmRefreshFilter,
  resolveRecommendCardDetailClickPoint,
  selectRecommendJob,
  selectRecommendJobWithRootRefresh,
  selectAndConfirmFirstSafeFilter,
  selectRecommendPageScope,
  shouldFailClosedRecommendImageAcquisition,
  summarizeRecommendPreClickRetryAttempts,
  inspectRecentColleagueContact,
  getColleagueContactSkipReason,
  isVerifiedColleagueContactInspection,
  isDateWithinWindow,
  verifyFilterGroupsSticky,
  verifyRecommendDetailCandidateBinding,
  waitForRecommendDetailCandidateBinding,
  waitForRecommendDetail,
  verifyRecommendJobSelection
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
  assert.equal(jobLabelMatches("大模型高招岗位 _ 杭州 - 另一个候选池", "大模型高招岗位 _ 杭州"), false);
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
    const detailOpenMiss = new Error("Candidate detail did not open or no known detail selectors mounted");
    const unknownCaptureOutcome = new Error("WebSocket is not open: readyState 3 (CLOSED)");
    unknownCaptureOutcome.cdp_method = "Page.captureScreenshot";
    unknownCaptureOutcome.cdp_outcome_unknown = true;
    unknownCaptureOutcome.cdp_replay_suppressed = true;

    assert.equal(isRecoverableImageCaptureError(error), true);
    assert.equal(isRecoverableImageCaptureError(staleError), true);
    assert.equal(isRecoverableImageCaptureError(unknownCaptureOutcome), true);
    assert.equal(isRecoverableRecommendDetailError(staleError), true);
    assert.equal(isRecoverableRecommendDetailError(detailOpenMiss), true);
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

function testRecommendMissingCaptureTargetFailsClosed() {
  assert.equal(shouldFailClosedRecommendImageAcquisition({
    cv_acquisition: { source: "missing_capture_node" },
    image_evidence: null
  }), true);
  assert.equal(shouldFailClosedRecommendImageAcquisition({
    cv_acquisition: { source: "image" },
    image_evidence: null
  }), true);
  assert.equal(shouldFailClosedRecommendImageAcquisition({
    cv_acquisition: { source: "network" },
    image_evidence: null
  }), false);
  assert.equal(shouldFailClosedRecommendImageAcquisition({
    cv_acquisition: { source: "image" },
    image_evidence: {
      ok: true,
      coverage_complete: true,
      file_paths: ["complete.jpg"]
    }
  }), false);
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

  const unlimited = [{ group: "activity", label: "不限", active: false, node_id: 9 }];
  assert.equal(chooseFilterOptionByLabels(unlimited, {
    group: "activity",
    labels: ["不限"]
  }), null);
  assert.equal(chooseFilterOptionByLabels(unlimited, {
    group: "activity",
    labels: ["不限"],
    allowUnlimited: true
  })?.node_id, 9);
}

function testStaleRecommendNodeClassificationTraversesCause() {
  const nested = new Error("outer transport failure", {
    cause: new Error("Could not find node with given id")
  });
  assert.equal(isStaleRecommendNodeError(nested), true);
  for (const message of [
    "Invalid NodeId",
    "Invalid backend node id",
    "Node with given id does not exist",
    "No node found for given backend id"
  ]) {
    assert.equal(isStaleRecommendNodeError(new Error(message)), true, message);
  }
  assert.equal(isStaleRecommendNodeError(new Error("ordinary network timeout")), false);
  const circular = new Error("ordinary wrapper");
  circular.cause = circular;
  assert.equal(isStaleRecommendNodeError(circular), false);
}

function createRecommendActivityFilterClient({
  activeLabel = "今日活跃",
  rowPresent = true,
  optionNodesPresent = true
} = {}) {
  const labels = ["不限", "刚刚活跃", "今日活跃", "3日内活跃", "本周活跃", "本月活跃"];
  const state = {
    panelOpen: false,
    activeLabel,
    optionClickCount: 0,
    clearClickCount: 0,
    confirmClickCount: 0,
    triggerClickCount: 0
  };
  const nodeForLabel = new Map(labels.map((label, index) => [31 + index, label]));
  function boxForNode(nodeId) {
    const left = Number(nodeId) * 10;
    return [left, 10, left + 8, 10, left + 8, 38, left, 38];
  }
  function nodeAtX(x) {
    for (const nodeId of [10, ...nodeForLabel.keys(), 40, 41]) {
      const left = Number(nodeId) * 10;
      if (x >= left && x <= left + 8) return nodeId;
    }
    return 0;
  }
  return {
    state,
    client: {
      DOM: {
        async querySelector({ nodeId, selector }) {
          if (nodeId !== 99) return { nodeId: 0 };
          if (selector === ".filter-label-wrap") return { nodeId: 10 };
          if (selector === ".filter-panel") return { nodeId: state.panelOpen ? 20 : 0 };
          return { nodeId: 0 };
        },
        async querySelectorAll({ nodeId, selector }) {
          if (nodeId === 20 && String(selector).includes(".option")) {
            return {
              nodeIds: state.panelOpen && optionNodesPresent ? [...nodeForLabel.keys()] : []
            };
          }
          if (nodeId !== 99) return { nodeIds: [] };
          if (selector === ".filter-label-wrap") return { nodeIds: [10] };
          if (selector === ".filter-panel") return { nodeIds: state.panelOpen ? [20] : [] };
          if (String(selector).includes("check-box.activity")) {
            return { nodeIds: state.panelOpen && rowPresent ? [20] : [] };
          }
          if (selector === ".filter-panel .check-box") {
            return { nodeIds: state.panelOpen && rowPresent ? [20] : [] };
          }
          if (String(selector).includes(".filter-panel .btn")) {
            return { nodeIds: state.panelOpen ? [40, 41] : [] };
          }
          if (String(selector).includes("active")) {
            const activeNode = [...nodeForLabel.entries()].find(([, label]) => label === state.activeLabel)?.[0];
            return { nodeIds: state.panelOpen && activeNode ? [activeNode] : [] };
          }
          return { nodeIds: [] };
        },
        async getAttributes({ nodeId }) {
          if (nodeId === 10) return { attributes: ["class", "filter-label-wrap"] };
          if (nodeId === 20) return { attributes: ["class", "check-box activity"] };
          if (nodeForLabel.has(nodeId)) {
            const active = nodeForLabel.get(nodeId) === state.activeLabel;
            return { attributes: ["class", `option${active ? " active" : ""}`] };
          }
          return { attributes: ["class", "btn"] };
        },
        async getOuterHTML({ nodeId }) {
          if (nodeId === 10) return { outerHTML: '<button class="filter-label-wrap">筛选</button>' };
          if (nodeId === 20) {
            return {
              outerHTML: `<div class="check-box activity"><span>活跃度[单选]</span>${labels.map((label) => `<span class="option">${label}</span>`).join("")}</div>`
            };
          }
          if (nodeForLabel.has(nodeId)) {
            const label = nodeForLabel.get(nodeId);
            const active = label === state.activeLabel ? " active" : "";
            return { outerHTML: `<span class="option${active}">${label}</span>` };
          }
          if (nodeId === 40) return { outerHTML: '<button class="btn">清除</button>' };
          if (nodeId === 41) return { outerHTML: '<button class="btn">确定</button>' };
          return { outerHTML: "<div></div>" };
        },
        async getBoxModel({ nodeId }) {
          return { model: { border: boxForNode(nodeId) } };
        },
        async scrollIntoViewIfNeeded() {
          return {};
        }
      },
      Input: {
        async dispatchKeyEvent() {
          return {};
        },
        async dispatchMouseEvent(event) {
          if (event.type !== "mouseReleased") return {};
          const nodeId = nodeAtX(event.x);
          if (nodeId === 10) {
            state.panelOpen = !state.panelOpen;
            state.triggerClickCount += 1;
          } else if (nodeForLabel.has(nodeId)) {
            state.activeLabel = nodeForLabel.get(nodeId);
            state.optionClickCount += 1;
          } else if (nodeId === 40) {
            state.clearClickCount += 1;
          } else if (nodeId === 41) {
            state.panelOpen = false;
            state.confirmClickCount += 1;
          }
          return {};
        }
      }
    }
  };
}

async function testRecommendActivityFilterSelectionAndStickyVerification() {
  assert.equal(isRecommendActivityGroupText("活跃度 [单选] 不限 刚刚活跃 今日活跃"), true);
  assert.equal(isRecommendActivityGroupText("近期没有看过 不限 近14天没有"), false);

  const { client, state } = createRecommendActivityFilterClient({ activeLabel: "今日活跃" });
  const result = await selectAndConfirmFirstSafeFilter(client, 99, {
    filterGroups: [{
      group: "activity",
      labels: ["不限"],
      selectAllLabels: false,
      allowUnlimited: true,
      verifySticky: true
    }],
    afterConfirmSettleMs: 0,
    stickySettleMs: 0
  });
  assert.equal(result.confirmed, true);
  assert.deepEqual(result.requested_groups, [{
    group: "activity",
    labels: ["不限"],
    select_all_labels: false,
    allow_unlimited: true,
    verify_sticky: true
  }]);
  assert.equal(result.selected_option.label, "不限");
  assert.equal(result.selected_option.clicked, true);
  assert.equal(result.sticky_verification.verified, true);
  assert.deepEqual(result.sticky_verification.groups[0].active_labels, ["不限"]);
  assert.equal(result.initial_close_attempts.includes("Escape"), true);
  assert.equal(result.open_attempts.length, 1);
  assert.equal(result.open_attempts[0].node_id, 10);
  assert.equal(result.confirm_attempts.length, 1);
  assert.equal(result.confirm_attempts[0].clicked, true);
  assert.equal(state.optionClickCount, 1);
  assert.equal(state.clearClickCount, 0);
  assert.equal(state.confirmClickCount, 2);

  const alreadyActive = createRecommendActivityFilterClient({ activeLabel: "不限" });
  const alreadyActiveResult = await selectAndConfirmFirstSafeFilter(alreadyActive.client, 99, {
    filterGroups: [{
      group: "activity",
      labels: ["不限"],
      selectAllLabels: false,
      allowUnlimited: true,
      verifySticky: true
    }],
    afterConfirmSettleMs: 0,
    stickySettleMs: 0
  });
  assert.equal(alreadyActiveResult.selected_option.was_active, true);
  assert.equal(alreadyActiveResult.selected_option.clicked, false);
  assert.equal(alreadyActive.state.optionClickCount, 0);
}

async function testRecommendActivityUnavailableDefaultAndUnreadableControl() {
  const unavailable = createRecommendActivityFilterClient({ rowPresent: false });
  const defaultResult = await selectAndConfirmFirstSafeFilter(unavailable.client, 99, {
    filterGroups: [{
      group: "activity",
      labels: ["不限"],
      selectAllLabels: false,
      allowUnlimited: true,
      verifySticky: true
    }],
    afterConfirmSettleMs: 0,
    stickySettleMs: 0
  });
  assert.equal(defaultResult.unavailable, true);
  assert.equal(defaultResult.unavailable_groups[0].reason, "activity_control_unavailable_default");
  assert.equal(defaultResult.sticky_verification.verified, true);
  assert.equal(defaultResult.sticky_verification.groups[0].unavailable, true);

  const unavailableRequested = createRecommendActivityFilterClient({ rowPresent: false });
  await assert.rejects(
    selectAndConfirmFirstSafeFilter(unavailableRequested.client, 99, {
      filterGroups: [{
        group: "activity",
        labels: ["今日活跃"],
        selectAllLabels: false,
        allowUnlimited: true,
        verifySticky: true
      }],
      afterConfirmSettleMs: 0,
      stickySettleMs: 0
    }),
    /No matching recommend filter option/
  );

  const unreadable = createRecommendActivityFilterClient({ optionNodesPresent: false });
  unreadable.state.panelOpen = true;
  await assert.rejects(
    listFilterOptions(unreadable.client, 99, { groupOrder: ["activity"] }),
    /visible but its options could not be read/
  );
}

function createMissingRecommendFilterPanelClient() {
  return {
    DOM: {
      async querySelector() {
        return { nodeId: 0 };
      },
      async querySelectorAll() {
        return { nodeIds: [] };
      }
    }
  };
}

async function testRecommendMissingFilterPanelDefaultSafety() {
  const defaultOptions = {
    filterGroups: [{
      group: "activity",
      labels: ["不限"],
      selectAllLabels: false,
      allowUnlimited: true,
      verifySticky: true
    }],
    afterConfirmSettleMs: 0,
    stickySettleMs: 0
  };
  const defaultResult = await selectAndConfirmFirstSafeFilter(
    createMissingRecommendFilterPanelClient(),
    99,
    defaultOptions
  );
  assert.equal(defaultResult.opened_panel, false);
  assert.equal(defaultResult.confirmed, true);
  assert.equal(defaultResult.unavailable, true);
  assert.equal(defaultResult.unavailable_default, true);
  assert.equal(defaultResult.confirm_label, "unavailable-default");
  assert.deepEqual(defaultResult.unavailable_groups, [{
    group: "activity",
    requested_labels: ["不限"],
    reason: "activity_control_unavailable_default",
    scope: "filter_panel"
  }]);
  assert.equal(defaultResult.sticky_verification.verified, true);
  assert.equal(defaultResult.sticky_verification.groups[0].unavailable, true);

  await assert.rejects(
    selectAndConfirmFirstSafeFilter(createMissingRecommendFilterPanelClient(), 99, {
      filterGroups: [{
        group: "activity",
        labels: ["今日活跃"],
        selectAllLabels: false,
        allowUnlimited: true,
        verifySticky: true
      }],
      afterConfirmSettleMs: 0
    }),
    /Recommend filter trigger was not found/
  );

  await assert.rejects(
    selectAndConfirmFirstSafeFilter(createMissingRecommendFilterPanelClient(), 99, {
      filterGroups: [{
        group: "degree",
        labels: ["不限"],
        selectAllLabels: false,
        allowUnlimited: true
      }],
      afterConfirmSettleMs: 0
    }),
    /Recommend filter trigger was not found/
  );

  await assert.rejects(
    selectAndConfirmFirstSafeFilter(createMissingRecommendFilterPanelClient(), 99, {
      filterGroups: [
        defaultOptions.filterGroups[0],
        {
          group: "school",
          labels: ["985"],
          selectAllLabels: true
        }
      ],
      afterConfirmSettleMs: 0
    }),
    /Recommend filter trigger was not found/
  );
}


function createRecommendLocationClient({
  checked = false,
  popupOpen = false,
  checkboxAvailable = true,
  stateReadable = true,
  staleStateReadOnce = false,
  triggerOpens = true,
  stickyConfirmLeavesPopoverOpen = false
} = {}) {
  const state = {
    checked,
    popupOpen,
    checkboxAvailable,
    stateReadable,
    staleStateReadOnce,
    triggerOpens,
    stickyConfirmLeavesPopoverOpen,
    transientControlMissingReads: 0,
    triggerClickCount: 0,
    checkboxClickCount: 0,
    confirmClickCount: 0,
    clearClickCount: 0,
    escapeCount: 0
  };
  function boxForNode(nodeId) {
    const left = Number(nodeId) * 10;
    return [left, 20, left + 8, 20, left + 8, 48, left, 48];
  }
  function nodeAtX(x) {
    for (const nodeId of [10, 20, 21, 30, 31]) {
      const left = nodeId * 10;
      if (x >= left && x <= left + 8) return nodeId;
    }
    return 0;
  }
  return {
    state,
    client: {
      DOM: {
        async querySelectorAll({ nodeId, selector }) {
          if (nodeId === 99 && selector === ".city-selecter-wrap") {
            return { nodeIds: [10] };
          }
          if (nodeId === 99 && selector === ".check-area-warp, .check-area-bottom") {
            return { nodeIds: state.popupOpen ? [100] : [] };
          }
          if (nodeId === 99 && String(selector).includes('[role="checkbox"]')) {
            if (state.transientControlMissingReads > 0) {
              state.transientControlMissingReads -= 1;
              return { nodeIds: [] };
            }
            return {
              nodeIds: state.popupOpen && state.checkboxAvailable ? [20] : []
            };
          }
          if (nodeId === 20 && String(selector).includes('input[type="checkbox"]')) {
            return { nodeIds: state.stateReadable ? [21] : [] };
          }
          if (nodeId === 100 && String(selector).includes("button")) {
            return { nodeIds: state.popupOpen ? [31, 30] : [] };
          }
          return { nodeIds: [] };
        },
        async getAttributes({ nodeId }) {
          if (nodeId === 10) {
            return { attributes: ["class", "city-selecter-wrap", "data-city", "上海"] };
          }
          if (nodeId === 20) {
            if (state.staleStateReadOnce) {
              state.staleStateReadOnce = false;
              throw new Error("Could not find node with given id");
            }
            return {
              attributes: [
                "class",
                state.stateReadable
                  ? `checkbox${state.checked ? " checked" : ""}`
                  : "city-choice"
              ]
            };
          }
          if (nodeId === 21) {
            return {
              attributes: state.checked
                ? ["type", "checkbox", "checked", ""]
                : ["type", "checkbox"]
            };
          }
          return { attributes: ["class", "btn"] };
        },
        async getOuterHTML({ nodeId }) {
          if (nodeId === 10) {
            return { outerHTML: '<button class="city-selecter-wrap" data-city="上海">上海</button>' };
          }
          if (nodeId === 20) {
            return {
              outerHTML: `<label class="checkbox${state.checked ? " checked" : ""}"><input type="checkbox"${state.checked ? " checked" : ""}><span>仅推荐期望城市为本城市的牛人</span></label>`
            };
          }
          if (nodeId === 21) {
            return { outerHTML: `<input type="checkbox"${state.checked ? " checked" : ""}>` };
          }
          if (nodeId === 100) return { outerHTML: '<div class="check-area-warp"></div>' };
          if (nodeId === 30) return { outerHTML: '<button class="btn">确认</button>' };
          if (nodeId === 31) return { outerHTML: '<button class="btn">清除</button>' };
          return { outerHTML: "<div></div>" };
        },
        async getBoxModel({ nodeId }) {
          if ([20, 21, 30, 31, 100].includes(nodeId) && !state.popupOpen) {
            throw new Error("Could not compute box model");
          }
          return { model: { border: boxForNode(nodeId) } };
        },
        async describeNode({ nodeId }) {
          const parents = { 20: 100, 21: 20, 30: 100, 31: 100, 100: 99 };
          return { node: { nodeId, parentId: parents[nodeId] || 0 } };
        }
      },
      Input: {
        async dispatchKeyEvent(event) {
          if (event.key === "Escape" && event.type === "keyUp") {
            state.popupOpen = false;
            state.escapeCount += 1;
          }
          return {};
        },
        async dispatchMouseEvent(event) {
          if (event.type !== "mouseReleased") return {};
          const nodeId = nodeAtX(event.x);
          if (nodeId === 10) {
            if (state.triggerOpens) state.popupOpen = !state.popupOpen;
            state.triggerClickCount += 1;
          } else if ([20, 21].includes(nodeId)) {
            state.checked = !state.checked;
            state.checkboxClickCount += 1;
          } else if (nodeId === 30) {
            state.confirmClickCount += 1;
            if (state.stickyConfirmLeavesPopoverOpen && state.confirmClickCount === 2) {
              state.popupOpen = true;
              state.transientControlMissingReads = 1;
            } else {
              state.popupOpen = false;
            }
          } else if (nodeId === 31) {
            state.clearClickCount += 1;
          }
          return {};
        }
      }
    }
  };
}

async function testRecommendCurrentCityOnlyStateAndStickyVerification() {
  const { client, state } = createRecommendLocationClient({ checked: false });
  const result = await ensureRecommendCurrentCityOnly(client, 99, {
    enabled: true,
    timeoutMs: 0,
    intervalMs: 0,
    settleMs: 0,
    closeStableMs: 0
  });
  assert.equal(result.requested, true);
  assert.equal(result.effective, true);
  assert.equal(result.available, true);
  assert.equal(result.clicked, true);
  assert.equal(result.current_city_label, "上海");
  assert.equal(result.before.checked, false);
  assert.equal(result.after_toggle.checked, true);
  assert.equal(result.confirmation.label, "确认");
  assert.equal(result.sticky_verification.verified, true);
  assert.equal(result.sticky_verification.actual, true);
  assert.equal(state.checkboxClickCount, 1);
  assert.equal(state.confirmClickCount, 2);
  assert.equal(state.clearClickCount, 0);
}

async function testRecommendCurrentCityOnlyAlreadyOpenAndUnavailablePolicy() {
  const alreadyOpen = createRecommendLocationClient({ checked: false, popupOpen: true });
  const result = await ensureRecommendCurrentCityOnly(alreadyOpen.client, 99, {
    enabled: false,
    timeoutMs: 0,
    intervalMs: 0,
    settleMs: 0,
    closeStableMs: 0
  });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, "already_in_requested_state");
  assert.equal(alreadyOpen.state.checkboxClickCount, 0);
  assert.equal(alreadyOpen.state.triggerClickCount, 1);
  assert.equal(alreadyOpen.state.confirmClickCount, 2);

  const unavailable = createRecommendLocationClient({ checkboxAvailable: false });
  const unavailableResult = await ensureRecommendCurrentCityOnly(unavailable.client, 99, {
    enabled: false,
    timeoutMs: 0,
    intervalMs: 0,
    settleMs: 0
  });
  assert.equal(unavailableResult.effective, false);
  assert.equal(unavailableResult.unavailable, true);
  assert.equal(unavailableResult.reason, "current_city_control_unavailable");
  assert.equal(unavailable.state.escapeCount, 1);
  assert.equal(unavailable.state.confirmClickCount, 0);

  const unavailableEnabled = createRecommendLocationClient({ checkboxAvailable: false });
  await assert.rejects(
    ensureRecommendCurrentCityOnly(unavailableEnabled.client, 99, {
      enabled: true,
      timeoutMs: 0,
      intervalMs: 0,
      settleMs: 0,
      attemptsLimit: 1
    }),
    /unavailable for an enabled request/
  );

  const unreadable = createRecommendLocationClient({ stateReadable: false });
  await assert.rejects(
    ensureRecommendCurrentCityOnly(unreadable.client, 99, {
      enabled: false,
      timeoutMs: 0,
      intervalMs: 0,
      settleMs: 0,
      attemptsLimit: 1
    }),
    /visible but its state is unreadable/
  );
}

async function testRecommendCurrentCityOnlyRetriesStaleControlState() {
  const { client, state } = createRecommendLocationClient({
    checked: false,
    staleStateReadOnce: true
  });
  const result = await ensureRecommendCurrentCityOnly(client, 99, {
    enabled: true,
    timeoutMs: 0,
    intervalMs: 0,
    settleMs: 0,
    closeStableMs: 0,
    attemptsLimit: 2
  });
  assert.equal(result.effective, true);
  assert.equal(result.sticky_verification.verified, true);
  assert.equal(state.escapeCount, 1);
  assert.equal(state.clearClickCount, 0);
}

async function testRecommendCurrentCityOnlyDoesNotTreatFailedOpenAsUnavailable() {
  const { client, state } = createRecommendLocationClient({ triggerOpens: false });
  await assert.rejects(
    ensureRecommendCurrentCityOnly(client, 99, {
      enabled: false,
      timeoutMs: 0,
      intervalMs: 0,
      settleMs: 0,
      attemptsLimit: 1,
      openAttemptsLimit: 3
    }),
    /location_popover_did_not_open/
  );
  assert.equal(state.triggerClickCount, 3);
}

function testNetworkPatterns() {
  assert.equal(matchesRecommendDetailNetwork("https://www.zhipin.com/wapi/zpjob/view/geek/info?id=1"), true);
  assert.equal(matchesRecommendDetailNetwork("https://www.zhipin.com/web/frame/c-resume/foo"), true);
  assert.equal(matchesRecommendDetailNetwork("https://example.com/assets/app.js"), false);
}

function testColleagueContactDateParsing() {
  const referenceDate = new Date(2026, 5, 24);
  const explicit = parseColleagueContactDate("费正丽 2026-06-18 10:03 向Ta发起沟通", { referenceDate });
  const yesterday = parseColleagueContactDate("昨天 同事发起沟通", { referenceDate });
  const threeDaysAgo = parseColleagueContactDate("3天前 同事交换简历", { referenceDate });
  assert.deepEqual([explicit.getFullYear(), explicit.getMonth(), explicit.getDate()], [2026, 5, 18]);
  assert.deepEqual([yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()], [2026, 5, 23]);
  assert.deepEqual([threeDaysAgo.getFullYear(), threeDaysAgo.getMonth(), threeDaysAgo.getDate()], [2026, 5, 21]);
  assert.equal(isDateWithinWindow(new Date(2026, 5, 10), { referenceDate, windowDays: 14 }), true);
  assert.equal(isDateWithinWindow(new Date(2026, 5, 9), { referenceDate, windowDays: 14 }), false);
}

function createColleagueContactClient({
  initialSelectedTab = "my",
  clickSelectsTab = true,
  rowText = "费正丽 向Ta发起沟通 2026-06-18 10:03 3D图形算法实习生",
  rowVisible = true
} = {}) {
  let selectedTab = initialSelectedTab;
  let lastBoxNode = null;
  const clicks = [];
  function htmlForNode(nodeId) {
    if (nodeId === 5) return '<div class="dialog-wrap active"></div>';
    if (nodeId === 10) return '<div class="colleague-collaboration"><div class="tab-hd"><span class="selected">我的沟通进度</span><span>同事沟通进度</span></div></div>';
    if (nodeId === 21) return `<span class="${selectedTab === "my" ? "selected" : ""}">我的沟通进度</span>`;
    if (nodeId === 22) return `<span class="${selectedTab === "colleague" ? "selected" : ""}">同事沟通进度</span>`;
    if (nodeId === 31) return `<div class="content">${rowText}</div>`;
    if (nodeId === 99) return '<div class="resume-item-detail"></div>';
    return "<div></div>";
  }
  return {
    get state() {
      return { selectedTab, clicks };
    },
    client: {
      DOM: {
        async querySelectorAll({ nodeId, selector }) {
          if (nodeId === 5 && selector === ".colleague-collaboration") return { nodeIds: [10] };
          if (nodeId === 5 && selector === ".resume-item-detail") return { nodeIds: [99] };
          if (nodeId === 10 && selector === ".tab-hd") return { nodeIds: [11] };
          if (nodeId === 10 && selector === ".record-item.mate-log-item .content") {
            return { nodeIds: selectedTab === "colleague" ? [31] : [] };
          }
          if (nodeId === 10 && selector === ".tab-hd .selected") {
            return { nodeIds: [selectedTab === "my" ? 21 : 22] };
          }
          if (nodeId === 10 && selector === ".tab-hd > span, .tab-hd > div, .tab-hd > button, .tab-hd > li") {
            return { nodeIds: [21, 22] };
          }
          return { nodeIds: [] };
        },
        async getOuterHTML({ nodeId }) {
          return { outerHTML: htmlForNode(nodeId) };
        },
        async scrollIntoViewIfNeeded() {
          return {};
        },
        async getBoxModel({ nodeId }) {
          if (nodeId === 31 && !rowVisible) throw new Error("row hidden");
          lastBoxNode = nodeId;
          return {
            model: {
              border: [100, 100, 200, 100, 200, 140, 100, 140]
            }
          };
        },
        async describeNode({ nodeId }) {
          return { node: { nodeId, backendNodeId: nodeId + 1000 } };
        }
      },
      Input: {
        async dispatchMouseEvent(event) {
          if (event.type === "mouseReleased" && lastBoxNode === 22 && clickSelectsTab) {
            selectedTab = "colleague";
            clicks.push("colleague-tab");
          }
        }
      }
    }
  };
}

async function testColleagueContactInspectorSelectsColleagueTab() {
  const fixture = createColleagueContactClient();
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false
  });
  assert.equal(result.panel_found, true);
  assert.equal(result.tab_changed, true);
  assert.deepEqual(fixture.state.clicks, ["colleague-tab"]);
  assert.equal(result.recent, true);
  assert.equal(result.matched_row.parsed_date, "2026-06-18");
}

async function testColleagueContactInspectorWaitsForLatePanel() {
  const fixture = createColleagueContactClient();
  let sectionQueries = 0;
  const originalQuerySelectorAll = fixture.client.DOM.querySelectorAll;
  fixture.client.DOM.querySelectorAll = async (params) => {
    if (params.nodeId === 5 && params.selector === ".colleague-collaboration") {
      sectionQueries += 1;
      if (sectionQueries === 1) return { nodeIds: [] };
    }
    return originalQuerySelectorAll(params);
  };
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false,
    sectionWaitMs: 50,
    sectionPollMs: 1
  });
  assert.equal(sectionQueries >= 2, true);
  assert.equal(result.panel_found, true);
  assert.equal(result.recent, true);
}

async function testRecommendCurrentCityOnlyRejectsTransientControlDisappearanceWhilePopoverRemainsVisible() {
  const { client, state } = createRecommendLocationClient({
    checked: false,
    stickyConfirmLeavesPopoverOpen: true
  });
  await assert.rejects(
    ensureRecommendCurrentCityOnly(client, 99, {
      enabled: true,
      timeoutMs: 40,
      intervalMs: 1,
      settleMs: 0,
      closeStableMs: 5,
      attemptsLimit: 1
    }),
    /location popover did not close after exact 确认 click/
  );
  assert.equal(state.confirmClickCount, 2);
  assert.equal(state.popupOpen, true);
  assert.equal(state.transientControlMissingReads, 0);
}

async function testColleagueContactInspectorFailsClosedWhenPanelMissing() {
  const result = await inspectRecentColleagueContact({
    DOM: {
      async querySelectorAll() {
        return { nodeIds: [] };
      },
      async getBoxModel() {
        return { model: { border: [0, 0, 100, 0, 100, 100, 0, 100] } };
      },
      async describeNode({ nodeId }) {
        return { node: { nodeId, backendNodeId: nodeId + 1000 } };
      }
    }
  }, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    scroll: false,
    sectionWaitMs: 0,
    sectionPollMs: 0
  });
  assert.equal(result.checked, false);
  assert.equal(result.panel_found, false);
  assert.equal(result.recent, null);
  assert.equal(result.indeterminate, true);
  assert.equal(result.reason, "panel_missing");
  assert.equal(isVerifiedColleagueContactInspection(result), false);
}

async function testColleagueContactInspectorAcceptsStablePanelAbsence() {
  const result = await inspectRecentColleagueContact({
    DOM: {
      async querySelectorAll() {
        return { nodeIds: [] };
      },
      async getBoxModel() {
        return { model: { border: [0, 0, 100, 0, 100, 100, 0, 100] } };
      },
      async describeNode({ nodeId }) {
        return { node: { nodeId, backendNodeId: nodeId + 1000 } };
      }
    }
  }, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    scroll: false,
    sectionWaitMs: 2,
    sectionPollMs: 1
  });
  assert.equal(result.checked, true);
  assert.equal(result.panel_found, false);
  assert.equal(result.recent, false);
  assert.equal(result.indeterminate, false);
  assert.equal(result.reason, "panel_missing");
  assert.equal(result.absence_probe.verified, true);
  assert.equal(result.absence_probe.poll_count >= 2, true);
  assert.equal(result.absence_probe.full_window_elapsed, true);
  assert.equal(result.absence_probe.scope_backend_node_ids.length, 1);
  assert.equal(isVerifiedColleagueContactInspection(result), true);
  assert.equal(getColleagueContactSkipReason(result), "");
  assert.equal(isVerifiedColleagueContactInspection({
    ...result,
    absence_probe: {
      ...result.absence_probe,
      poll_count: 1
    }
  }), false);
}

async function testColleagueContactInspectorFailsClosedWhenQueryErrors() {
  await assert.rejects(() => inspectRecentColleagueContact({
    DOM: {
      async querySelectorAll() {
        throw new Error("query failed");
      },
      async getBoxModel() {
        return { model: { border: [0, 0, 100, 0, 100, 100, 0, 100] } };
      },
      async describeNode({ nodeId }) {
        return { node: { nodeId, backendNodeId: nodeId + 1000 } };
      }
    }
  }, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    scroll: false,
    sectionWaitMs: 0,
    sectionPollMs: 0
  }), /query failed/);
}

async function testColleagueContactInspectorFailsClosedWhenTabUnavailable() {
  const result = await inspectRecentColleagueContact({
    DOM: {
      async querySelectorAll({ nodeId, selector }) {
        if (nodeId === 5 && selector === ".colleague-collaboration") return { nodeIds: [10] };
        return { nodeIds: [] };
      },
      async getOuterHTML() {
        return { outerHTML: "<div></div>" };
      },
      async getBoxModel() {
        return { model: { border: [0, 0, 100, 0, 100, 100, 0, 100] } };
      },
      async describeNode({ nodeId }) {
        return { node: { nodeId, backendNodeId: nodeId + 1000 } };
      }
    }
  }, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    scroll: false,
    sectionWaitMs: 0,
    sectionPollMs: 0
  });
  assert.equal(result.checked, false);
  assert.equal(result.panel_found, true);
  assert.equal(result.recent, null);
  assert.equal(result.indeterminate, true);
  assert.equal(result.reason, "colleague_tab_unavailable");
  assert.equal(isVerifiedColleagueContactInspection(result), false);
}

function testVerifiedColleagueContactInspectionRequiresExactPositiveEvidence() {
  const oldRowText = "费正丽 向Ta发起沟通 2026-06-01 10:03";
  const oldRowIdentity = `1031:${oldRowText}`;
  const bound = {
    checked: true,
    panel_found: true,
    indeterminate: false,
    selected_tab_text: "同事沟通进度",
    selected_tab_count: 1,
    pane_binding_verified: true,
    section_node_id: 10,
    section_backend_node_id: 1010,
    binding: {
      verified: true,
      selection_reverified_after_rows: true,
      row_scope: "selected_section_descendants"
    },
    scroll_probe: {
      completed: true,
      coverage_verified: true,
      scrolls_requested: 2,
      scrolls_completed: 2,
      position_count: 3,
      step_delta_y: 100,
      overlap_ratio: 0.35,
      effective_scroll_count: 1,
      cap_reached_without_end: false,
      end_proof: {
        verified: true,
        method: "effective_scroll_then_repeated_identical_rows",
        stable_samples_required: 2,
        stable_samples_observed: 2,
        additional_wheel_attempts_without_change: 2,
        effective_scroll_observed: true,
        effective_scroll_count: 1,
        end_position_index: 2,
        end_scroll_count: 2,
        row_signature: JSON.stringify([oldRowIdentity])
      },
      positions: [
        {
          position_index: 0,
          sampled_after_scroll_count: 0,
          row_count: 1,
          unreadable_row_count: 0,
          row_backend_node_ids: [1031],
          row_texts: [oldRowText],
          row_identity_keys: [oldRowIdentity],
          row_signature: JSON.stringify([oldRowIdentity]),
          ordered_row_layout: [{
            backend_node_id: 1031,
            text: oldRowText,
            x: 100,
            y: 100,
            width: 100,
            height: 40
          }],
          ordered_row_layout_keys: [`${oldRowText}:100:100:100:40`],
          row_layout_signature: JSON.stringify([`${oldRowText}:100:100:100:40`]),
          scroll_effect_observed: false,
          cumulative_effective_scroll_count: 0,
          new_row_count: 1,
          new_row_texts: [oldRowText],
          stable_signature_count: 0,
          binding_before_verified: true,
          binding_after_verified: true
        },
        {
          position_index: 1,
          sampled_after_scroll_count: 1,
          row_count: 1,
          unreadable_row_count: 0,
          row_backend_node_ids: [1031],
          row_texts: [oldRowText],
          row_identity_keys: [oldRowIdentity],
          row_signature: JSON.stringify([oldRowIdentity]),
          ordered_row_layout: [{
            backend_node_id: 1031,
            text: oldRowText,
            x: 100,
            y: 90,
            width: 100,
            height: 40
          }],
          ordered_row_layout_keys: [`${oldRowText}:100:90:100:40`],
          row_layout_signature: JSON.stringify([`${oldRowText}:100:90:100:40`]),
          scroll_effect_observed: true,
          cumulative_effective_scroll_count: 1,
          new_row_count: 0,
          new_row_texts: [],
          stable_signature_count: 1,
          binding_before_verified: true,
          binding_after_verified: true
        },
        {
          position_index: 2,
          sampled_after_scroll_count: 2,
          row_count: 1,
          unreadable_row_count: 0,
          row_backend_node_ids: [1031],
          row_texts: [oldRowText],
          row_identity_keys: [oldRowIdentity],
          row_signature: JSON.stringify([oldRowIdentity]),
          ordered_row_layout: [{
            backend_node_id: 1031,
            text: oldRowText,
            x: 100,
            y: 90,
            width: 100,
            height: 40
          }],
          ordered_row_layout_keys: [`${oldRowText}:100:90:100:40`],
          row_layout_signature: JSON.stringify([`${oldRowText}:100:90:100:40`]),
          scroll_effect_observed: false,
          cumulative_effective_scroll_count: 1,
          new_row_count: 0,
          new_row_texts: [],
          stable_signature_count: 2,
          binding_before_verified: true,
          binding_after_verified: true
        }
      ]
    }
  };
  const oldRow = {
    text: oldRowText,
    parsed_date: "2026-06-01",
    within_window: false,
    visible: true,
    node_id: 31,
    backend_node_id: 1031,
    section_node_id: 10,
    section_backend_node_id: 1010,
    observed_at_positions: [0, 1]
  };
  const recentRow = {
    ...oldRow,
    parsed_date: "2026-06-18",
    within_window: true
  };
  assert.equal(isVerifiedColleagueContactInspection({
    ...bound,
    recent: false,
    reason: "no_recent_colleague_contact",
    row_count: 1,
    rows: [oldRow]
  }), true);
  assert.equal(isVerifiedColleagueContactInspection({
    ...bound,
    scroll_probe: {
      ...bound.scroll_probe,
      end_proof: {
        ...bound.scroll_probe.end_proof,
        verified: false
      }
    },
    recent: false,
    reason: "no_recent_colleague_contact",
    row_count: 1,
    rows: [oldRow]
  }), false);
  assert.equal(isVerifiedColleagueContactInspection({
    ...bound,
    scroll_probe: {
      ...bound.scroll_probe,
      cap_reached_without_end: true
    },
    recent: false,
    reason: "no_recent_colleague_contact",
    row_count: 1,
    rows: [oldRow]
  }), false);
  assert.equal(isVerifiedColleagueContactInspection({
    ...bound,
    scroll_probe: null,
    recent: false,
    reason: "no_recent_colleague_contact",
    row_count: 1,
    rows: [oldRow]
  }), false);
  assert.equal(isVerifiedColleagueContactInspection({
    ...bound,
    recent: true,
    reason: "recent_colleague_contact_found",
    row_count: 1,
    rows: [recentRow]
  }), true);
  assert.equal(isVerifiedColleagueContactInspection({
    checked: true,
    panel_found: false,
    recent: false,
    reason: "panel_missing"
  }), false);
  assert.equal(isVerifiedColleagueContactInspection({
    ...bound,
    recent: false,
    reason: "no_recent_colleague_contact",
    row_count: 1,
    rows: [recentRow]
  }), false);
  assert.equal(getColleagueContactSkipReason({
    ...bound,
    recent: true,
    reason: "recent_colleague_contact_found",
    row_count: 1,
    rows: [{ ...recentRow, visible: false }]
  }), "colleague_contact_unverified");
  assert.equal(isVerifiedColleagueContactInspection({
    ...bound,
    recent: false,
    reason: "no_recent_colleague_contact",
    row_count: 1,
    rows: [{ ...oldRow, section_backend_node_id: 9999 }]
  }), false);
}

async function testColleagueContactRowQueryErrorDoesNotBecomeVerifiedClear() {
  const fixture = createColleagueContactClient({ initialSelectedTab: "colleague" });
  const originalQuerySelectorAll = fixture.client.DOM.querySelectorAll;
  fixture.client.DOM.querySelectorAll = async (params) => {
    if (params.selector.includes("record-item")) throw new Error("row query failed");
    return originalQuerySelectorAll(params);
  };
  await assert.rejects(() => inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false
  }), /row query failed/);
  assert.equal(getColleagueContactSkipReason({
    checked: false,
    recent: null,
    indeterminate: true,
    reason: "inspection_failed"
  }), "colleague_contact_unverified");
}

async function testColleagueContactTextReadErrorDoesNotBecomeVerifiedClear() {
  const fixture = createColleagueContactClient({ initialSelectedTab: "colleague" });
  const originalGetOuterHTML = fixture.client.DOM.getOuterHTML;
  fixture.client.DOM.getOuterHTML = async (params) => {
    if (params.nodeId === 31) throw new Error("row text read failed");
    return originalGetOuterHTML(params);
  };
  await assert.rejects(() => inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false
  }), /row text read failed/);
}

async function testColleagueContactTabClickMustBeVerified() {
  const fixture = createColleagueContactClient({ clickSelectsTab: false });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false
  });
  assert.equal(result.reason, "colleague_tab_unavailable");
  assert.equal(result.checked, false);
  assert.equal(result.recent, null);
  assert.equal(getColleagueContactSkipReason(result), "colleague_contact_unverified");
}

async function testColleagueContactMissingRowsFailClosed() {
  const fixture = createColleagueContactClient({ initialSelectedTab: "colleague" });
  const originalQuerySelectorAll = fixture.client.DOM.querySelectorAll;
  fixture.client.DOM.querySelectorAll = async (params) => {
    if (params.selector.includes("record-item")) return { nodeIds: [] };
    return originalQuerySelectorAll(params);
  };
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false
  });
  assert.equal(result.reason, "contact_rows_missing");
  assert.equal(result.checked, false);
  assert.equal(result.recent, null);
  assert.equal(getColleagueContactSkipReason(result), "colleague_contact_unverified");
}

async function testColleagueContactHiddenRowsCannotProveClearOrRecent() {
  const fixture = createColleagueContactClient({
    initialSelectedTab: "colleague",
    rowVisible: false
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false
  });
  assert.equal(result.reason, "colleague_row_evidence_unavailable");
  assert.equal(result.checked, false);
  assert.equal(result.scroll_probe.completed, false);
  assert.equal(result.scroll_probe.unreadable_rows[0].stage, "box");
  assert.equal(getColleagueContactSkipReason(result), "colleague_contact_unverified");
}

async function testColleagueContactMultipleVisibleSectionsFailClosed() {
  const fixture = createColleagueContactClient({ initialSelectedTab: "colleague" });
  const originalQuerySelectorAll = fixture.client.DOM.querySelectorAll;
  fixture.client.DOM.querySelectorAll = async (params) => {
    if (params.nodeId === 5 && params.selector === ".colleague-collaboration") {
      return { nodeIds: [10, 12] };
    }
    return originalQuerySelectorAll(params);
  };
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false
  });
  assert.equal(result.reason, "panel_ambiguous");
  assert.equal(result.visible_section_count, 2);
  assert.equal(getColleagueContactSkipReason(result), "colleague_contact_unverified");
}

async function testColleagueContactUnparseableDateFailsClosed() {
  const fixture = createColleagueContactClient({
    initialSelectedTab: "colleague",
    rowText: "张三 向Ta发起沟通 日期未知"
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false
  });
  assert.equal(result.reason, "contact_date_unparseable");
  assert.equal(result.checked, false);
  assert.equal(result.recent, null);
  assert.equal(result.unparsed_row_count, 1);
  assert.equal(getColleagueContactSkipReason(result), "colleague_contact_unverified");
}

async function testColleagueContactJustNowIsRecent() {
  const fixture = createColleagueContactClient({
    initialSelectedTab: "colleague",
    rowText: "张三 刚刚向Ta发起沟通"
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false
  });
  assert.equal(result.recent, true);
  assert.equal(result.reason, "recent_colleague_contact_found");
  assert.equal(getColleagueContactSkipReason(result), "skipped_recent_colleague_contact");
}

function createAccountRightsPanelClient() {
  let panelOpen = true;
  let primed = false;
  let discarded = 0;
  const clicks = [];
  return {
    get state() {
      return { panelOpen, primed, discarded, clicks };
    },
    client: {
      DOM: {
        async getDocument(params = {}) {
          if (params.depth === -1) primed = true;
          return { root: { nodeId: 1 } };
        },
        async performSearch(params) {
          assert.equal(params.includeUserAgentShadowDOM, true);
          return {
            searchId: "rights-search",
            resultCount: panelOpen && params.query === "我的权益" ? 1 : 0
          };
        },
        async getSearchResults() {
          return { nodeIds: primed ? [99] : [0] };
        },
        async discardSearchResults() {
          discarded += 1;
        },
        async querySelectorAll() {
          return { nodeIds: [] };
        },
        async getBoxModel(params) {
          assert.equal(params.nodeId, 99);
          return {
            model: {
              border: [1085, 64, 1181, 64, 1181, 91, 1085, 91]
            }
          };
        }
      },
      Input: {
        async dispatchMouseEvent(params) {
          if (params.type === "mouseReleased") {
            clicks.push({ x: params.x, y: params.y });
            if (params.x === 84 && params.y === 664) panelOpen = false;
          }
          return {};
        },
        async dispatchKeyEvent() {
          return {};
        }
      }
    }
  };
}

async function testRecommendAccountRightsPanelUsesSharedSafeClose() {
  const fixture = createAccountRightsPanelClient();
  const open = await findRecommendBlockingPanel(fixture.client);
  assert.equal(open.open, true);
  assert.equal(open.query, "我的权益");
  assert.equal(fixture.state.primed, true);
  assert.equal(fixture.state.discarded, 2);

  const result = await closeRecommendBlockingPanels(fixture.client, {
    attemptsLimit: 1,
    roots: [{ name: "top", nodeId: 1 }, { name: "recommend-frame", nodeId: 2 }],
    waitMs: 0
  });
  assert.equal(result.closed, true);
  assert.equal(result.already_closed, false);
  assert.equal(result.attempts[0].mode, "outside-click");
  assert.equal(result.attempts[0].point.x, 84);
  assert.equal(result.attempts[0].point.y, 664);
  assert.equal(result.attempts[0].point.mode, "empty-lower-left-sidebar");
  assert.equal(fixture.state.panelOpen, false);
}

function testRecommendCardDetailClickPointAvoidsAvatar() {
  const point = resolveRecommendCardDetailClickPoint({
    rect: { x: 235, y: 402, width: 1008, height: 132 },
    center: { x: 739, y: 468 }
  });
  assert.equal(point.mode, "card-body-safe-point");
  assert.equal(point.x > 320, true);
  assert.equal(point.x < 700, true);
  assert.equal(point.y > 430, true);
  assert.equal(point.y < 455, true);
}

async function testRecommendCardClickViewportEvidenceDistinguishesVisibleAndOffscreenPoints() {
  const boxes = new Map([
    [41, [100, 100, 500, 100, 500, 300, 100, 300]],
    [42, [100, 900, 500, 900, 500, 1100, 100, 1100]]
  ]);
  const client = {
    Page: {
      async getLayoutMetrics() {
        return {
          cssVisualViewport: {
            clientWidth: 800,
            clientHeight: 600
          }
        };
      }
    },
    DOM: {
      async getBoxModel({ nodeId }) {
        return { model: { border: boxes.get(nodeId) } };
      },
      async querySelectorAll() {
        return { nodeIds: [] };
      },
      async getNodeForLocation() {
        return { nodeId: 41, backendNodeId: 141 };
      }
    }
  };

  const visible = await readRecommendCardClickViewportEvidence(client, 41);
  assert.equal(visible.verified, true);
  assert.equal(visible.in_viewport, true);
  assert.equal(visible.reason, null);
  assert.equal(visible.viewport.source, "cssVisualViewport");
  assert.equal(visible.click_target.x >= 4 && visible.click_target.x <= 796, true);
  assert.equal(visible.click_target.y >= 4 && visible.click_target.y <= 596, true);

  const offscreen = await readRecommendCardClickViewportEvidence(client, 42);
  assert.equal(offscreen.verified, true);
  assert.equal(offscreen.in_viewport, false);
  assert.equal(offscreen.reason, "card_click_point_outside_viewport");
  assert.equal(offscreen.click_target.y > offscreen.viewport.height, true);
}

async function testRecommendCardClickViewportEvidenceRejectsOccludedDefaultPoint() {
  const hitTests = [];
  let inputCount = 0;
  const client = {
    Page: {
      async getLayoutMetrics() {
        return {
          cssVisualViewport: {
            clientWidth: 800,
            clientHeight: 600
          }
        };
      }
    },
    DOM: {
      async getBoxModel({ nodeId }) {
        assert.equal(nodeId, 41);
        return {
          model: {
            border: [100, 100, 500, 100, 500, 300, 100, 300]
          }
        };
      },
      async getNodeForLocation(params) {
        hitTests.push(params);
        if (params.y === 156) {
          return {
            nodeId: 90,
            backendNodeId: 190
          };
        }
        return {
          nodeId: 42,
          backendNodeId: 142
        };
      },
      async querySelectorAll({ nodeId, selector }) {
        assert.equal(nodeId, 41);
        return { nodeIds: selector === "*" ? [42] : [] };
      },
      async describeNode({ nodeId }) {
        const nodes = {
          1: { nodeId: 1, backendNodeId: 101, parentId: 0 },
          41: { nodeId: 41, backendNodeId: 141, parentId: 1 },
          42: { nodeId: 42, backendNodeId: 142, parentId: 41 },
          90: { nodeId: 90, backendNodeId: 190, parentId: 1 }
        };
        return { node: nodes[nodeId] || { nodeId, backendNodeId: nodeId + 100 } };
      }
    },
    Input: {
      async dispatchMouseEvent() {
        inputCount += 1;
        assert.fail("viewport click proof must remain read-only");
      }
    }
  };

  const evidence = await readRecommendCardClickViewportEvidence(client, 41);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.in_viewport, true);
  assert.equal(evidence.reason, null);
  assert.equal(evidence.click_target.hit_test_candidate_index, 1);
  assert.equal(evidence.hit_test.completed, true);
  assert.equal(evidence.hit_test.exact_card_hit_verified, true);
  assert.equal(evidence.hit_test.selected.hit_test_candidate_index, 1);
  assert.equal(evidence.hit_test.attempts.length, 2);
  assert.equal(evidence.hit_test.attempts[0].exact_card_hit, false);
  assert.equal(
    evidence.hit_test.attempts[0].reason,
    "card_click_point_not_owned_by_exact_card"
  );
  assert.equal(evidence.hit_test.attempts[0].hit_node_id, 90);
  assert.equal(evidence.hit_test.attempts[1].exact_card_hit, true);
  assert.equal(evidence.hit_test.attempts[1].hit_node_id, 42);
  assert.deepEqual(
    hitTests.map(({ x, y }) => ({ x, y })),
    [{ x: 210, y: 156 }, { x: 210, y: 210 }]
  );
  assert.equal(inputCount, 0);
}

async function testRecommendCardClickViewportEvidenceRejectsInteractiveExactCardDescendant() {
  const hitTests = [];
  let inputCount = 0;
  const client = {
    Page: {
      async getLayoutMetrics() {
        return {
          cssVisualViewport: {
            clientWidth: 800,
            clientHeight: 600
          }
        };
      }
    },
    DOM: {
      async getBoxModel({ nodeId }) {
        assert.equal(nodeId, 41);
        return {
          model: {
            border: [100, 100, 500, 100, 500, 300, 100, 300]
          }
        };
      },
      async getNodeForLocation(params) {
        hitTests.push(params);
        return params.y === 156
          ? { nodeId: 42, backendNodeId: 142 }
          : { nodeId: 43, backendNodeId: 143 };
      },
      async querySelectorAll({ nodeId, selector }) {
        if (nodeId === 41 && selector === "*") return { nodeIds: [42, 43] };
        if (nodeId === 41) return { nodeIds: [42] };
        if (nodeId === 42 && selector === "*") return { nodeIds: [] };
        assert.fail(`Unexpected querySelectorAll(${nodeId}, ${selector})`);
      },
      async describeNode({ nodeId }) {
        const nodes = {
          41: {
            nodeId: 41,
            backendNodeId: 141,
            nodeName: "DIV",
            localName: "div",
            attributes: ["class", "candidate-card"]
          },
          42: {
            nodeId: 42,
            backendNodeId: 142,
            parentId: 41,
            nodeName: "BUTTON",
            localName: "button",
            attributes: ["class", "candidate-avatar action-btn"]
          },
          43: {
            nodeId: 43,
            backendNodeId: 143,
            parentId: 41,
            nodeName: "SPAN",
            localName: "span",
            attributes: ["class", "candidate-summary-body"]
          }
        };
        return { node: nodes[nodeId] || { nodeId, backendNodeId: nodeId + 100 } };
      }
    },
    Input: {
      async dispatchMouseEvent() {
        inputCount += 1;
        assert.fail("viewport click proof must remain read-only");
      }
    }
  };

  const evidence = await readRecommendCardClickViewportEvidence(client, 41);
  assert.equal(evidence.verified, true);
  assert.equal(evidence.in_viewport, true);
  assert.equal(evidence.reason, null);
  assert.equal(evidence.click_target.hit_test_candidate_index, 1);
  assert.equal(evidence.hit_test.selected.hit_test_candidate_index, 1);
  assert.equal(evidence.hit_test.attempts.length, 2);
  assert.equal(evidence.hit_test.attempts[0].exact_card_hit, true);
  assert.equal(evidence.hit_test.attempts[0].safe_card_hit, false);
  assert.equal(
    evidence.hit_test.attempts[0].reason,
    "card_click_point_unsafe_interactive_target"
  );
  assert.equal(evidence.hit_test.attempts[0].hit_node_name, "BUTTON");
  assert.equal(evidence.hit_test.attempts[1].exact_card_hit, true);
  assert.equal(evidence.hit_test.attempts[1].safe_card_hit, true);
  assert.equal(evidence.hit_test.attempts[1].hit_node_name, "SPAN");
  assert.deepEqual(
    hitTests.map(({ x, y }) => ({ x, y })),
    [{ x: 210, y: 156 }, { x: 210, y: 210 }]
  );
  assert.equal(inputCount, 0);
}

async function testRecommendPreverifiedCardBoxAuthorizesExactlyOneInputClick() {
  const inputEvents = [];
  const boxReads = [];
  let detailOpen = false;
  const cardBox = {
    model: { border: [100, 100, 500, 100, 500, 300, 100, 300] },
    center: { x: 300, y: 200 },
    rect: { x: 100, y: 100, width: 400, height: 200 }
  };
  const client = {
    Page: {
      async getLayoutMetrics() {
        return {
          cssVisualViewport: {
            clientWidth: 800,
            clientHeight: 600
          }
        };
      }
    },
    DOM: {
      async getDocument() {
        return { root: { nodeId: 1 } };
      },
      async querySelector({ nodeId, selector }) {
        if (nodeId === 1 && String(selector).includes("iframe")) {
          return { nodeId: 2 };
        }
        return { nodeId: 0 };
      },
      async describeNode({ nodeId }) {
        if (nodeId === 2) {
          return { node: { contentDocument: { nodeId: 3 } } };
        }
        return { node: {} };
      },
      async querySelectorAll({ selector }) {
        if (selector === "*") return { nodeIds: [] };
        if (detailOpen && selector === ".dialog-wrap.active") {
          return { nodeIds: [10] };
        }
        return { nodeIds: [] };
      },
      async getNodeForLocation() {
        return { nodeId: 41, backendNodeId: 141 };
      },
      async getBoxModel({ nodeId }) {
        boxReads.push(nodeId);
        if (nodeId === 41) return cardBox;
        if (nodeId === 10) {
          return {
            model: { border: [200, 80, 700, 80, 700, 580, 200, 580] }
          };
        }
        throw new Error(`Unexpected card box reread for node ${nodeId}`);
      },
      async getOuterHTML({ nodeId }) {
        assert.equal(nodeId, 10);
        return { outerHTML: '<div class="dialog-wrap active"><div class="resume-item-detail">候选人简历</div></div>' };
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
        if (event.type === "mouseReleased") detailOpen = true;
        return {};
      }
    }
  };

  const opened = await openRecommendCardDetail(client, 41, {
    timeoutMs: 20,
    scrollIntoView: false,
    preverifiedCardBox: cardBox
  });
  assert.equal(Boolean(opened.detail_state.popup), true);
  assert.equal(inputEvents.filter((event) => event.type === "mousePressed").length, 1);
  assert.equal(inputEvents.filter((event) => event.type === "mouseReleased").length, 1);
  assert.equal(
    boxReads.filter((nodeId) => nodeId === 41).length,
    1,
    "the final native hit-test proof must use one fresh card box immediately before Input"
  );
}

async function testRecommendPostClickPollingStaleIsAnnotatedAndNeverReclicked() {
  const inputEvents = [];
  const stalePollError = new Error("Could not find node with given id");
  const cardBox = {
    model: { border: [100, 100, 500, 100, 500, 300, 100, 300] },
    center: { x: 300, y: 200 },
    rect: { x: 100, y: 100, width: 400, height: 200 }
  };
  const client = {
    Page: {
      async getLayoutMetrics() {
        return {
          cssVisualViewport: {
            clientWidth: 800,
            clientHeight: 600
          }
        };
      }
    },
    DOM: {
      async getBoxModel({ nodeId }) {
        assert.equal(nodeId, 41);
        return cardBox;
      },
      async querySelectorAll({ nodeId, selector }) {
        assert.equal(nodeId, 41);
        assert.equal(typeof selector, "string");
        return { nodeIds: [] };
      },
      async getNodeForLocation() {
        return { nodeId: 41, backendNodeId: 141 };
      },
      async getDocument() {
        throw stalePollError;
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        inputEvents.push(event);
        return {};
      }
    }
  };

  await assert.rejects(
    openRecommendCardDetail(client, 41, {
      timeoutMs: 20,
      scrollIntoView: false,
      preverifiedCardBox: cardBox
    }),
    (error) => {
      assert.equal(error, stalePollError);
      assert.equal(error.recommend_click_dispatched, true);
      assert.equal(error.recommend_input_dispatched, true);
      assert.equal(error.recommend_post_input_outcome_unknown, true);
      assert.equal(error.recommend_no_click_dispatched, false);
      assert.equal(error.recommend_post_input_stage, "post_card_click_detail_poll");
      assert.equal(error.click_attempts.length, 1);
      assert.equal(error.click_attempts[0].input_dispatched, true);
      assert.equal(error.click_attempts[0].outcome, "detail_state_poll_failed");
      return true;
    }
  );
  assert.equal(inputEvents.filter((event) => event.type === "mousePressed").length, 1);
  assert.equal(inputEvents.filter((event) => event.type === "mouseReleased").length, 1);
}

async function testRecommendPreClickSnapshotReusesSuppliedRootTree() {
  const inputEvents = [];
  let inputDispatched = false;
  let getDocumentCalls = 0;
  const postInputRead = new Error("post-input detail read sentinel");
  const client = createRecommendDetailBindingClient();
  client.Page = {
    async getLayoutMetrics() {
      return {
        cssVisualViewport: {
          clientWidth: 1440,
          clientHeight: 900
        }
      };
    }
  };
  client.Input = {
    async dispatchMouseEvent(event) {
      inputEvents.push(event);
      inputDispatched = true;
      return {};
    }
  };
  client.DOM.getDocument = async () => {
    getDocumentCalls += 1;
    assert.equal(
      inputDispatched,
      true,
      "the supplied root tree must prevent a new document snapshot before Input"
    );
    throw postInputRead;
  };

  await assert.rejects(
    openRecommendCardDetailWithFreshRetry(client, {
      cardNodeId: 10,
      candidateKey: "recommend:id:candidate-123",
      cardCandidate: {
        id: "candidate-123",
        identity: {
          name: "张三",
          school: "浙江大学"
        }
      },
      rootState: {
        topRoot: { nodeId: 1 },
        iframe: { nodeId: 2, documentNodeId: 1 },
        roots: [{ name: "recommend-frame", nodeId: 1 }],
        rootNodes: { top: 1, frame: 1, frameOwner: 2 }
      },
      timeoutMs: 20,
      bindingTimeoutMs: 20,
      bindingIntervalMs: 0,
      maxAttempts: 2
    }),
    (error) => {
      assert.equal(error, postInputRead);
      assert.equal(error.recommend_input_dispatched, true);
      assert.equal(error.recommend_post_input_outcome_unknown, true);
      return true;
    }
  );
  assert.equal(getDocumentCalls, 1);
  assert.equal(inputEvents.some((event) => event.type === "mousePressed"), true);
  assert.equal(inputEvents.some((event) => event.type === "mouseReleased"), true);
}

async function testRecommendPreClickCardDisappearanceReacquiresBeforeInput() {
  const inputEvents = [];
  let inputDispatched = false;
  let oldCardBoxReads = 0;
  let getDocumentCalls = 0;
  const postInputRead = new Error("post-input detail read after exact reacquire");
  const client = createRecommendDetailBindingClient({
    rootScopedCardNodeIds: [11]
  });
  const originalGetBoxModel = client.DOM.getBoxModel.bind(client.DOM);
  const originalGetAttributes = client.DOM.getAttributes.bind(client.DOM);
  const originalGetOuterHTML = client.DOM.getOuterHTML.bind(client.DOM);
  client.DOM.getBoxModel = async ({ nodeId }) => {
    if (nodeId === 10) {
      oldCardBoxReads += 1;
      if (oldCardBoxReads > 1) {
        throw new Error("Could not find node with given id");
      }
    }
    if (nodeId === 11) {
      return { model: { border: [10, 10, 210, 10, 210, 50, 10, 50] } };
    }
    return originalGetBoxModel({ nodeId });
  };
  client.DOM.getAttributes = async ({ nodeId }) => {
    if (nodeId === 11) {
      return {
        attributes: ["class", "card-inner", "data-geek", "candidate-123"]
      };
    }
    return originalGetAttributes({ nodeId });
  };
  client.DOM.getOuterHTML = async ({ nodeId }) => {
    if (nodeId === 11) {
      return {
        outerHTML:
          '<div class="card-inner" data-geek="candidate-123">'
          + '<span class="name">张三</span><span>浙江大学</span></div>'
      };
    }
    return originalGetOuterHTML({ nodeId });
  };
  client.Page = {
    async getLayoutMetrics() {
      return {
        cssVisualViewport: {
          clientWidth: 1440,
          clientHeight: 900
        }
      };
    }
  };
  client.Input = {
    async dispatchMouseEvent(event) {
      inputEvents.push(event);
      inputDispatched = true;
      return {};
    }
  };
  client.DOM.getDocument = async () => {
    getDocumentCalls += 1;
    assert.equal(inputDispatched, true);
    throw postInputRead;
  };

  await assert.rejects(
    openRecommendCardDetailWithFreshRetry(client, {
      cardNodeId: 10,
      candidateKey: "recommend:id:candidate-123",
      cardCandidate: {
        id: "candidate-123",
        identity: {
          name: "张三",
          school: "浙江大学"
        }
      },
      rootState: {
        topRoot: { nodeId: 1 },
        iframe: { nodeId: 2, documentNodeId: 1 },
        roots: [{ name: "recommend-frame", nodeId: 1 }],
        rootNodes: { top: 1, frame: 1, frameOwner: 2 }
      },
      timeoutMs: 20,
      retryTimeoutMs: 20,
      retryIntervalMs: 0,
      bindingTimeoutMs: 20,
      bindingIntervalMs: 0,
      maxAttempts: 2
    }),
    (error) => {
      assert.equal(error, postInputRead);
      assert.equal(error.recommend_input_dispatched, true);
      assert.equal(error.recommend_detail_open_attempts.length, 2);
      const first = error.recommend_detail_open_attempts[0];
      assert.equal(first.node_id, 10);
      assert.equal(first.stale_node, true);
      assert.equal(first.pre_click_stale_no_action, true);
      assert.equal(first.input_dispatched, false);
      assert.equal(first.refresh_lookup.node_id, 11);
      assert.equal(first.refresh_lookup.exact_candidate_key_match, true);
      return true;
    }
  );
  assert.equal(getDocumentCalls, 1);
  assert.equal(inputEvents.filter((event) => event.type === "mousePressed").length, 1);
  assert.equal(inputEvents.filter((event) => event.type === "mouseReleased").length, 1);
}

function testRecommendPreClickRetrySummaryRequiresEveryExactNoActionAttempt() {
  const exactAttempt = (attempt) => ({
    attempt,
    stale_node: true,
    pre_click_stale_no_action: true,
    no_click_dispatched: true,
    click_dispatched: false,
    input_dispatched: false,
    pre_click_stage: "pre_click_card_box",
    exact_candidate_provenance_verified: true,
    detail_open_miss: false,
    candidate_binding_mismatch: false
  });
  const exactAttempts = [1, 2, 3].map(exactAttempt);
  assert.deepEqual(summarizeRecommendPreClickRetryAttempts(exactAttempts), {
    attempt_count: 3,
    all_pre_click_stale_no_action: true,
    no_click_dispatched: true
  });

  for (const mutation of [
    { detail_open_miss: true },
    { candidate_binding_mismatch: true },
    { exact_candidate_provenance_verified: false },
    { click_dispatched: true, no_click_dispatched: false }
  ]) {
    const mixedAttempts = exactAttempts.map((attempt) => ({ ...attempt }));
    Object.assign(mixedAttempts[1], mutation);
    const summary = summarizeRecommendPreClickRetryAttempts(mixedAttempts);
    assert.equal(summary.attempt_count, 3);
    assert.equal(summary.all_pre_click_stale_no_action, false);
    assert.equal(summary.no_click_dispatched, false);
  }
}

function testRecommendPreClickViewportPreparationSourceOrdering() {
  const source = fs.readFileSync(new URL("./domains/recommend/detail.js", import.meta.url), "utf8");
  const wrapperStart = source.indexOf("export async function openRecommendCardDetailWithFreshRetry");
  const wrapperEnd = source.indexOf("export async function closeRecommendAvatarPreview", wrapperStart);
  assert.ok(wrapperStart > 0 && wrapperEnd > wrapperStart);
  const wrapper = source.slice(wrapperStart, wrapperEnd);

  const initialViewportIndex = wrapper.indexOf("const initialViewport = await readRecommendCardClickViewportEvidence");
  const scrollIndex = wrapper.indexOf("await scrollNodeIntoView(client, currentNodeId)");
  const exactReacquireIndex = wrapper.indexOf("const postScrollResolved = await findRecommendCardNodeForCandidateKey");
  const detailRootsIndex = wrapper.indexOf("const detailRootsBefore = await readRecommendDetailRootsBeforeClick");
  const provenanceIndex = wrapper.indexOf("cardPreClickProvenance = await readRecommendCardPreClickProvenance");
  const exactProofIndex = wrapper.indexOf("exactCandidateProvenanceVerified = true");
  const finalViewportIndex = wrapper.indexOf("const finalViewport = await readRecommendCardClickViewportEvidence");
  const openIndex = wrapper.indexOf("const opened = await openRecommendCardDetail");
  const bindingIndex = wrapper.indexOf(
    "const candidateBinding = await waitForRecommendDetailCandidateBinding",
    openIndex
  );
  assert.ok(initialViewportIndex >= 0);
  assert.ok(initialViewportIndex < scrollIndex);
  assert.ok(scrollIndex < exactReacquireIndex);
  assert.ok(exactReacquireIndex < detailRootsIndex);
  assert.ok(detailRootsIndex < provenanceIndex);
  assert.match(
    wrapper.slice(detailRootsIndex, provenanceIndex),
    /readRecommendDetailRootsBeforeClick\(client,\s*\{\s*rootState:\s*currentRootState\s*\}\)/,
    "the pre-click detail snapshot must reuse the exact card root tree"
  );
  assert.ok(provenanceIndex < exactProofIndex);
  assert.ok(exactProofIndex < finalViewportIndex);
  assert.ok(finalViewportIndex < openIndex);
  assert.ok(openIndex < bindingIndex);
  assert.match(wrapper.slice(openIndex), /scrollIntoView:\s*false/);
  assert.match(wrapper.slice(openIndex), /preverifiedCardBox:\s*finalViewport\.box/);
  assert.match(
    wrapper.slice(bindingIndex),
    /cardClickEvidence:\s*opened\?\.card_box\?\.click_viewport\s*\|\|\s*null/
  );
  assert.match(
    wrapper.slice(bindingIndex),
    /clickAttempts:\s*cumulativeClickAttempts/
  );
  assert.match(
    wrapper.slice(bindingIndex),
    /card_click_evidence:\s*candidateBinding\?\.card\?\.click_evidence\s*\|\|\s*null/
  );
  assert.match(
    wrapper.slice(bindingIndex),
    /click_attempts:\s*candidateBinding\?\.card\?\.click_attempts\s*\|\|\s*\[\]/
  );
  const postInputGuardIndex = wrapper.indexOf("inputDispatched === true");
  const postInputThrowIndex = wrapper.indexOf(
    "throw attachRecommendDetailOpenRetryEvidence",
    postInputGuardIndex
  );
  const postFailureReacquireIndex = wrapper.indexOf(
    "const resolved = await findRecommendCardNodeForCandidateKey",
    postInputGuardIndex
  );
  assert.ok(postInputGuardIndex >= 0);
  assert.ok(postInputThrowIndex > postInputGuardIndex);
  assert.ok(
    postInputThrowIndex < postFailureReacquireIndex,
    "post-Input errors must terminate before the fresh-node reacquire path"
  );

  const openerStart = source.indexOf("export async function openRecommendCardDetail(client");
  const openerEnd = source.indexOf("function attachRecommendDetailOpenRetryEvidence", openerStart);
  const opener = source.slice(openerStart, openerEnd);
  assert.match(opener, /const maxClickAttempts = 1/);
}

function createAvatarPreviewClient() {
  let avatarOpen = true;
  let closeClicks = 0;
  return {
    get state() {
      return { avatarOpen, closeClicks };
    },
    client: {
      DOM: {
        async getDocument() {
          return { root: { nodeId: 1 } };
        },
        async querySelector({ selector }) {
          if (String(selector || "").includes("iframe")) return { nodeId: 5 };
          return { nodeId: 0 };
        },
        async describeNode({ nodeId }) {
          if (nodeId === 5) return { node: { contentDocument: { nodeId: 7 } } };
          return { node: {} };
        },
        async querySelectorAll({ nodeId, selector }) {
          const value = String(selector || "");
          if (!avatarOpen) return { nodeIds: [] };
          if (nodeId === 1 && value.includes("dialog-wrap.active") && !value.includes("close")) {
            return { nodeIds: [20] };
          }
          if (nodeId === 1 && value.includes("avatar-preview") && !value.includes("close")) {
            return { nodeIds: [21] };
          }
          if (nodeId === 1 && value.includes("boss-popup__close")) {
            return { nodeIds: [22] };
          }
          return { nodeIds: [] };
        },
        async getOuterHTML({ nodeId }) {
          if (nodeId === 20) {
            return {
              outerHTML:
                '<div class="dialog-wrap active"><div class="boss-dialog__wrapper avatar-preview primitive">'
                + '<div class="figure-preview"><div class="figure-mask">王旭东</div></div></div></div>'
            };
          }
          if (nodeId === 21) {
            return {
              outerHTML:
                '<div class="boss-dialog__wrapper avatar-preview primitive"><div class="figure-preview">王旭东</div></div>'
            };
          }
          if (nodeId === 22) return { outerHTML: '<div class="boss-popup__close"><i class="icon-close"></i></div>' };
          return { outerHTML: "" };
        },
        async getBoxModel({ nodeId }) {
          if (nodeId === 22) {
            return { model: { border: [488, 421, 512, 421, 512, 445, 488, 445] } };
          }
          return { model: { border: [257, 416, 517, 416, 517, 676, 257, 676] } };
        }
      },
      Input: {
        async dispatchMouseEvent(event) {
          if (event.type === "mouseReleased" && event.x >= 488 && event.x <= 512) {
            avatarOpen = false;
            closeClicks += 1;
          }
          return {};
        },
        async dispatchKeyEvent() {
          avatarOpen = false;
          return {};
        }
      }
    }
  };
}

async function testRecommendAvatarPreviewIsNotDetailAndCanClose() {
  const fixture = createAvatarPreviewClient();
  const detail = await waitForRecommendDetail(fixture.client, {
    timeoutMs: 20,
    intervalMs: 1
  });
  assert.equal(Boolean(detail?.popup || detail?.resumeIframe), false);

  const avatar = await readRecommendAvatarPreviewState(fixture.client);
  assert.equal(avatar.open, true);
  assert.equal(avatar.preview.selector.includes("avatar-preview"), true);

  const close = await closeRecommendAvatarPreview(fixture.client, {
    attemptsLimit: 1,
    waitMs: 20
  });
  assert.equal(close.closed, true);
  assert.equal(close.already_closed, false);
  assert.equal(fixture.state.closeClicks, 1);
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
  const navigateCause = new Error("stale navigate node");
  navigateCause.code = -32000;
  navigateCause.cdp_method = "Page.navigate";
  navigateCause.cdp_at = "2026-07-17T01:02:03.000Z";
  navigateCause.cdp_node_id = 77;
  const navigateError = new Error("navigate timeout", { cause: navigateCause });
  const reloadError = new Error("reload timeout");
  reloadError.cdp_method = "Page.reload";
  reloadError.cdp_at = "2026-07-17T01:02:04.000Z";
  reloadError.cdp_backend_node_id = 88;
  reloadError.cdp_param_keys = ["ignoreCache"];
  const result = await refreshRecommendListAtEnd({
    Page: {
      async navigate() {
        calls.push("navigate");
        throw navigateError;
      },
      async reload() {
        calls.push("reload");
        throw reloadError;
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
  assert.equal(result.attempts[0].error_diagnostic.message, "navigate timeout");
  assert.equal(result.attempts[0].error_diagnostic.cause.cdp_method, "Page.navigate");
  assert.equal(result.attempts[0].error_diagnostic.cause.cdp_node_id, 77);
  assert.match(result.attempts[0].error_diagnostic.stack, /navigate timeout/);
  assert.equal(result.attempts[1].error_diagnostic.cdp_method, "Page.reload");
  assert.equal(result.attempts[1].error_diagnostic.cdp_at, "2026-07-17T01:02:04.000Z");
  assert.equal(result.attempts[1].error_diagnostic.cdp_backend_node_id, 88);
  assert.deepEqual(result.attempts[1].error_diagnostic.cdp_param_keys, ["ignoreCache"]);
  assert.deepEqual(result.error_diagnostic, result.attempts[1].error_diagnostic);
}

function createRecommendDetailBindingClient({
  detailCandidateId = "candidate-123",
  detailName = "张三",
  detailSchool = "浙江大学",
  remountDetailBetweenSamples = false,
  omitDetailCandidateId = false,
  duplicateVisibleDetailRoot = false,
  includeResumeIframe = false,
  hiddenResumeIframe = false,
  iframeAncestryDrift = false,
  omitResumeIframeParentId = false,
  popupScopedResumeIframeNodeIds = [30],
  popupScopedResumeIframeBackendIds = {},
  popupScopedQueryError = null,
  popupBackendAfterPopupScopedQuery = null,
  resumeIframeBackendAfterPopupScopedQuery = null,
  resumeDocumentNodeIdAfterPopupScopedQuery = null,
  resumeDocumentBackendAfterPopupScopedQuery = null,
  cardDetachedAfterClick = false,
  cardAfterClickError = null,
  iframeDocumentNodeId = 1,
  omitCardParentId = false,
  rootScopedCardNodeIds = [10],
  rootScopedCardBackendIds = {},
  rootScopedQueryError = null,
  rootBackendAfterRootScopedQuery = null,
  iframeBackendAfterRootScopedQuery = null,
  iframeDocumentNodeIdAfterRootScopedQuery = null,
  cardCandidateIdAfterRootScopedQuery = null,
  cardNameAfterRootScopedQuery = null,
  identityReadyAfterSamples = 0,
  omitDetailIdentityText = false,
  includePopupCvTarget = true
} = {}) {
  const validNodeId = (value) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };
  let detailDescribeCount = 0;
  let iframeSample = 0;
  let detailIdentitySample = 0;
  let rootScopedQueryCompleted = false;
  let popupScopedQueryCompleted = false;
  let hitTestCardNodeId = 10;
  const backendIds = {
    1: 101,
    2: 102,
    10: 110,
    11: 111,
    20: 220,
    21: 221,
    22: 222,
    23: 223,
    24: 224,
    25: 225,
    30: 330,
    31: 331,
    32: 332,
    99: 999
  };
  const html = {
    10: '<div class="card-inner" data-geek="candidate-123"><span class="name">张三</span><span>浙江大学</span></div>',
    11: '<div class="card-inner" data-geek="other-candidate"><span class="name">张三</span><span>浙江大学</span></div>',
    20: '<div class="dialog-wrap active"><span class="name">张三</span><span>浙江大学</span></div>',
    21: `<div data-geek="${detailCandidateId}"></div>`,
    22: `<span class="name">${detailName}</span>`,
    23: `<span class="school">${detailSchool}</span>`,
    24: '<div class="dialog-wrap active stale-detail"></div>',
    25: '<div class="resume-center-side"><div class="resume-detail-wrap">简历画布</div></div>'
  };
  return {
    DOM: {
      async getDocument() {
        return { root: { nodeId: 99 } };
      },
      async querySelector({ nodeId, selector }) {
        if (nodeId === 99 && String(selector).includes("iframe")) {
          return { nodeId: 2 };
        }
        return { nodeId: 0 };
      },
      async getAttributes({ nodeId }) {
        if (nodeId === 10) {
          return {
            attributes: [
              "class",
              "card-inner",
              "data-geek",
              rootScopedQueryCompleted && cardCandidateIdAfterRootScopedQuery
                ? cardCandidateIdAfterRootScopedQuery
                : "candidate-123"
            ]
          };
        }
        if (nodeId === 21 && !omitDetailCandidateId) {
          return { attributes: ["data-geek", detailCandidateId] };
        }
        return { attributes: [] };
      },
      async getOuterHTML({ nodeId }) {
        if (nodeId === 10 && rootScopedQueryCompleted) {
          const candidateId = cardCandidateIdAfterRootScopedQuery || "candidate-123";
          const candidateName = cardNameAfterRootScopedQuery || "张三";
          return {
            outerHTML: `<div class="card-inner" data-geek="${candidateId}"><span class="name">${candidateName}</span><span>浙江大学</span></div>`
          };
        }
        return { outerHTML: html[nodeId] || "" };
      },
      async getBoxModel({ nodeId }) {
        if (nodeId === 30 && hiddenResumeIframe) {
          throw new Error("Could not compute box model for hidden iframe");
        }
        if (![10, 20, 21, 22, 23, 24, 25, 30, 31].includes(nodeId)) throw new Error(`Unexpected node ${nodeId}`);
        return { model: { border: [10, 10, 210, 10, 210, 50, 10, 50] } };
      },
      async scrollIntoViewIfNeeded() {
        return {};
      },
      async describeNode({ nodeId }) {
        if (nodeId === 10 && (cardDetachedAfterClick || cardAfterClickError)) {
          throw new Error(cardAfterClickError || "Could not find node with given id");
        }
        let backendNodeId = rootScopedQueryCompleted
          && validNodeId(rootScopedCardBackendIds?.[nodeId])
          ? validNodeId(rootScopedCardBackendIds[nodeId])
          : backendIds[nodeId];
        if (nodeId === 1 && rootScopedQueryCompleted && validNodeId(rootBackendAfterRootScopedQuery)) {
          backendNodeId = validNodeId(rootBackendAfterRootScopedQuery);
        }
        if (nodeId === 2 && rootScopedQueryCompleted && validNodeId(iframeBackendAfterRootScopedQuery)) {
          backendNodeId = validNodeId(iframeBackendAfterRootScopedQuery);
        }
        if (
          popupScopedQueryCompleted
          && validNodeId(popupScopedResumeIframeBackendIds?.[nodeId])
        ) {
          backendNodeId = validNodeId(popupScopedResumeIframeBackendIds[nodeId]);
        }
        if (
          nodeId === 20
          && popupScopedQueryCompleted
          && validNodeId(popupBackendAfterPopupScopedQuery)
        ) {
          backendNodeId = validNodeId(popupBackendAfterPopupScopedQuery);
        }
        if (
          nodeId === 30
          && popupScopedQueryCompleted
          && validNodeId(resumeIframeBackendAfterPopupScopedQuery)
        ) {
          backendNodeId = validNodeId(resumeIframeBackendAfterPopupScopedQuery);
        }
        if (
          nodeId === 31
          && popupScopedQueryCompleted
          && validNodeId(resumeDocumentBackendAfterPopupScopedQuery)
        ) {
          backendNodeId = validNodeId(resumeDocumentBackendAfterPopupScopedQuery);
        }
        if (nodeId === 20 && remountDetailBetweenSamples) {
          detailDescribeCount += 1;
          backendNodeId += detailDescribeCount > 1 ? 1 : 0;
        }
        if (nodeId === 30) {
          return {
            node: {
              nodeId,
              backendNodeId,
              ...(omitResumeIframeParentId
                ? {}
                : { parentId: iframeAncestryDrift && iframeSample > 1 ? 99 : 20 }),
              contentDocument: {
                nodeId: popupScopedQueryCompleted
                  && validNodeId(resumeDocumentNodeIdAfterPopupScopedQuery)
                  ? validNodeId(resumeDocumentNodeIdAfterPopupScopedQuery)
                  : 31
              }
            }
          };
        }
        if (nodeId === 2) {
          return {
            node: {
              nodeId,
              backendNodeId,
              parentId: 0,
              contentDocument: {
                nodeId: rootScopedQueryCompleted
                  && validNodeId(iframeDocumentNodeIdAfterRootScopedQuery)
                  ? validNodeId(iframeDocumentNodeIdAfterRootScopedQuery)
                  : iframeDocumentNodeId
              }
            }
          };
        }
        if (nodeId === 99) {
          return { node: { nodeId, backendNodeId, parentId: 0 } };
        }
        return {
          node: {
            nodeId,
            backendNodeId,
            ...(nodeId === 10 && omitCardParentId
              ? {}
              : { parentId: nodeId === 20 ? 1 : 20 })
          }
        };
      },
      async querySelectorAll({ nodeId, selector }) {
        if (selector === "*" && [10, 11].includes(nodeId)) {
          hitTestCardNodeId = nodeId;
          return { nodeIds: [] };
        }
        if (nodeId === 1 && selector === ".dialog-wrap.active") {
          return { nodeIds: duplicateVisibleDetailRoot ? [20, 24] : [20] };
        }
        if (nodeId === 1 && selector === 'iframe[name*="resume"]') {
          iframeSample += 1;
          return { nodeIds: includeResumeIframe ? [30] : [] };
        }
        if (nodeId === 1 && selector.includes(".candidate-card-wrap")) {
          rootScopedQueryCompleted = true;
          if (rootScopedQueryError) throw new Error(rootScopedQueryError);
          return { nodeIds: [...rootScopedCardNodeIds] };
        }
        if (nodeId !== 20) return { nodeIds: [] };
        if (selector === 'iframe[name*="resume"]') {
          popupScopedQueryCompleted = true;
          if (popupScopedQueryError) throw new Error(popupScopedQueryError);
          return { nodeIds: [...popupScopedResumeIframeNodeIds] };
        }
        if (
          includePopupCvTarget
          && selector === ".resume-center-side .resume-detail-wrap"
        ) {
          return { nodeIds: [25] };
        }
        if (selector.includes("[data-geek]")) {
          detailIdentitySample += 1;
          if (detailIdentitySample <= identityReadyAfterSamples) return { nodeIds: [] };
          return { nodeIds: omitDetailCandidateId ? [] : [21] };
        }
        if (selector.includes("span")) {
          return {
            nodeIds: omitDetailIdentityText || detailIdentitySample <= identityReadyAfterSamples
              ? []
              : [22, 23]
          };
        }
        return { nodeIds: [] };
      },
      async getNodeForLocation() {
        return {
          nodeId: hitTestCardNodeId,
          backendNodeId: backendIds[hitTestCardNodeId]
        };
      }
    },
    Accessibility: {
      async getPartialAXTree({ nodeId }) {
        if (nodeId === 22) {
          return {
            nodes: [{
              nodeId: "ax-detail-name",
              backendDOMNodeId: backendIds[22],
              name: { value: detailName }
            }]
          };
        }
        if (nodeId === 23) {
          return {
            nodes: [{
              nodeId: "ax-detail-school",
              backendDOMNodeId: backendIds[23],
              name: { value: detailSchool }
            }]
          };
        }
        return { nodes: [] };
      }
    }
  };
}

async function testRecommendDetailCandidateBindingRequiresStableExactIdentity() {
  const candidate = {
    id: "candidate-123",
    identity: {
      name: "张三",
      school: "浙江大学"
    }
  };
  const detailState = {
    popup: { node_id: 20 }
  };
  const exact = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient(),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState,
      settleMs: 0
    }
  );
  assert.equal(exact.verified, true);
  assert.equal(exact.screening_verified, true);
  assert.equal(exact.method, "exact_candidate_id_and_name");
  assert.equal(exact.expected_candidate_id, "candidate-123");
  assert.equal(exact.card.stable, true);
  assert.deepEqual(exact.detail.root, {
    source: "popup",
    node_id: 20,
    backend_node_id: 220,
    iframe_node_id: null,
    iframe_backend_node_id: null,
    contained_iframe: null,
    canonical: true,
    action_root: true,
    visible: true,
    stable: true
  });
  assert.equal(exact.detail.exact_candidate_id, true);
  assert.equal(exact.detail.exact_name, true);

  const fallback = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({ omitDetailCandidateId: true }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState,
      settleMs: 0
    }
  );
  assert.equal(fallback.verified, true);
  assert.equal(fallback.method, "exact_name_and_secondary_identity");
  assert.deepEqual(fallback.detail.stable_secondary_fields, ["school"]);
}

async function testRecommendDetailCandidateBindingRequiresAxTextDescendantOfExactDomNode() {
  const candidate = {
    id: "candidate-123",
    identity: { name: "张三" }
  };
  const createClient = ({ contained, backendOnly = false }) => {
    const client = createRecommendDetailBindingClient();
    const originalDescribeNode = client.DOM.describeNode.bind(client.DOM);
    client.DOM.describeNode = async ({ nodeId }) => {
      if (nodeId === 22) {
        return {
          node: {
            nodeId: 22,
            backendNodeId: 222,
            parentId: 20,
            children: contained
              ? [{
                  nodeId: backendOnly ? 0 : 26,
                  backendNodeId: 226,
                  parentId: 22,
                  nodeName: "#text",
                  nodeValue: "张三"
                }]
              : []
          }
        };
      }
      if (nodeId === 26) {
        return {
          node: {
            nodeId: 26,
            backendNodeId: 226,
            parentId: 22,
            nodeName: "#text",
            nodeValue: "张三"
          }
        };
      }
      return originalDescribeNode({ nodeId });
    };
    client.Accessibility.getPartialAXTree = async ({ nodeId, backendNodeId, fetchRelatives }) => {
      assert.equal(fetchRelatives, false);
      if (contained && (nodeId === 26 || backendNodeId === 226)) {
        return {
          nodes: [{
            nodeId: "ax-name",
            backendDOMNodeId: 226,
            ignored: false,
            role: { value: "StaticText" },
            name: { value: "张三" }
          }]
        };
      }
      if (nodeId !== 22) return { nodes: [] };
      if (contained) {
        return {
          nodes: [{
            nodeId: "ax-wrapper",
            backendDOMNodeId: 222,
            ignored: true,
            childIds: []
          }]
        };
      }
      return {
        nodes: [
          {
            nodeId: "ax-wrapper",
            backendDOMNodeId: 222,
            ignored: true,
            childIds: []
          },
          {
            nodeId: "ax-sibling-wrapper",
            backendDOMNodeId: 999,
            ignored: true,
            childIds: ["ax-sibling-name"]
          },
          {
            nodeId: "ax-sibling-name",
            backendDOMNodeId: 2999,
            parentId: "ax-sibling-wrapper",
            ignored: false,
            role: { value: "StaticText" },
            name: { value: "张三" }
          }
        ]
      };
    };
    return client;
  };
  const shared = {
    cardNodeId: 10,
    cardCandidate: candidate,
    detailState: { popup: { node_id: 20 } },
    allowScroll: false,
    settleMs: 0
  };

  const exactDescendant = await verifyRecommendDetailCandidateBinding(
    createClient({ contained: true }),
    shared
  );
  assert.equal(exactDescendant.verified, true);
  assert.equal(exactDescendant.method, "exact_candidate_id_and_name");
  assert.equal(exactDescendant.detail.exact_name, true);

  const exactBackendOnlyDescendant = await verifyRecommendDetailCandidateBinding(
    createClient({ contained: true, backendOnly: true }),
    shared
  );
  assert.equal(exactBackendOnlyDescendant.verified, true);
  assert.equal(exactBackendOnlyDescendant.method, "exact_candidate_id_and_name");
  assert.equal(exactBackendOnlyDescendant.detail.exact_name, true);

  const siblingText = await verifyRecommendDetailCandidateBinding(
    createClient({ contained: false }),
    shared
  );
  assert.equal(siblingText.verified, false);
  assert.equal(siblingText.reason, "detail_candidate_name_not_proven");
  assert.equal(siblingText.method, null);
  assert.equal(siblingText.detail.exact_name, false);
}

async function testRecommendDetailCandidateBindingUsesExactAgeAsSecondaryIdentity() {
  const candidate = {
    id: "candidate-123",
    identity: {
      name: "张三",
      age: "28岁"
    }
  };
  const createClient = ({ detailAge }) => {
    const client = createRecommendDetailBindingClient({ omitDetailCandidateId: true });
    const originalQuerySelectorAll = client.DOM.querySelectorAll.bind(client.DOM);
    const originalGetOuterHTML = client.DOM.getOuterHTML.bind(client.DOM);
    const originalGetBoxModel = client.DOM.getBoxModel.bind(client.DOM);
    const originalDescribeNode = client.DOM.describeNode.bind(client.DOM);
    const originalGetPartialAXTree = client.Accessibility.getPartialAXTree.bind(
      client.Accessibility
    );
    client.DOM.querySelectorAll = async ({ nodeId, selector }) => {
      if (nodeId === 20 && String(selector).includes("span")) {
        return { nodeIds: [22, 25] };
      }
      return originalQuerySelectorAll({ nodeId, selector });
    };
    client.DOM.getOuterHTML = async ({ nodeId }) => {
      if (nodeId === 25) return { outerHTML: `<span class="age">${detailAge}</span>` };
      return originalGetOuterHTML({ nodeId });
    };
    client.DOM.getBoxModel = async ({ nodeId }) => {
      if (nodeId === 25) {
        return { model: { border: [10, 10, 210, 10, 210, 50, 10, 50] } };
      }
      return originalGetBoxModel({ nodeId });
    };
    client.DOM.describeNode = async ({ nodeId }) => {
      if (nodeId === 25) {
        return { node: { nodeId: 25, backendNodeId: 225, parentId: 20 } };
      }
      return originalDescribeNode({ nodeId });
    };
    client.Accessibility.getPartialAXTree = async ({ nodeId }) => {
      if (nodeId === 25) {
        return {
          nodes: [{
            nodeId: "ax-age",
            backendDOMNodeId: 225,
            ignored: false,
            role: { value: "StaticText" },
            name: { value: detailAge }
          }]
        };
      }
      return originalGetPartialAXTree({ nodeId });
    };
    return client;
  };
  const shared = {
    cardNodeId: 10,
    cardCandidate: candidate,
    detailState: { popup: { node_id: 20 } },
    allowScroll: false,
    settleMs: 0
  };

  const exactAge = await verifyRecommendDetailCandidateBinding(
    createClient({ detailAge: "28岁" }),
    shared
  );
  assert.equal(exactAge.verified, true);
  assert.equal(exactAge.method, "exact_name_and_secondary_identity");
  assert.deepEqual(exactAge.detail.stable_secondary_fields, ["age"]);
  assert.equal(exactAge.detail.candidate_id_evidence_present, false);

  const wrongAge = await verifyRecommendDetailCandidateBinding(
    createClient({ detailAge: "27岁" }),
    shared
  );
  assert.equal(wrongAge.verified, false);
  assert.equal(wrongAge.reason, "detail_secondary_identity_not_proven");
  assert.equal(wrongAge.method, null);
  assert.equal(wrongAge.detail.exact_secondary, false);
}

async function testRecommendDetailCandidateBindingUsesCanonicalPopupWithContainedIframe() {
  const candidate = {
    id: "candidate-123",
    identity: {
      name: "张三",
      school: "浙江大学"
    }
  };
  const detailState = {
    popup: { node_id: 20, selector: ".dialog-wrap.active" },
    resumeIframe: { node_id: 30, selector: 'iframe[name*="resume"]' },
    roots: [{ name: "top", nodeId: 1 }]
  };
  const exact = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({ includeResumeIframe: true }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState,
      settleMs: 0
    }
  );
  assert.equal(exact.verified, true);
  assert.equal(exact.detail.root.source, "popup");
  assert.equal(exact.detail.root.node_id, 20);
  assert.equal(exact.detail.root.backend_node_id, 220);
  assert.equal(exact.detail.root.canonical, true);
  assert.equal(exact.detail.root.action_root, true);
  assert.deepEqual(exact.detail.root.contained_iframe, {
    selector: 'iframe[name*="resume"]',
    node_id: 31,
    backend_node_id: 331,
    iframe_node_id: 30,
    iframe_backend_node_id: 330,
    container_node_id: 20,
    container_backend_node_id: 220,
    containment_method: "parent_ancestry",
    container_membership: null,
    ancestry_depth: 1,
    ancestry_path: [
      { node_id: 30, backend_node_id: 330 },
      { node_id: 20, backend_node_id: 220 }
    ],
    visible: true,
    stable: true,
    contained: true
  });
  assert.equal(exact.detail.first.scopes.length, 2);
  assert.equal(exact.detail.second.scopes.length, 2);

  const hidden = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({
      includeResumeIframe: true,
      hiddenResumeIframe: true
    }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState,
      settleMs: 0
    }
  );
  assert.equal(hidden.verified, false);
  assert.equal(hidden.detail.candidate_id_probe_complete, false);
  assert.equal(hidden.detail.root.source, "popup");
  assert.equal(hidden.detail.root.contained_iframe, null);
  assert.equal(hidden.detail.first.scopes.length, 1);
  assert.equal(hidden.detail.first.ignored_scopes.length, 1);
  assert.equal(hidden.detail.first.ignored_scopes[0].source, "resume_iframe");
}

async function testRecommendDetailCandidateBindingUsesExactPopupScopedIframeFallback() {
  const candidate = {
    id: "candidate-123",
    identity: {
      name: "张三",
      school: "浙江大学"
    }
  };
  const detailState = {
    popup: { node_id: 20, selector: ".dialog-wrap.active" },
    resumeIframe: { node_id: 30, selector: 'iframe[name*="resume"]' },
    roots: [{ name: "top", nodeId: 1 }]
  };
  const verify = (options = {}) => verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({
      includeResumeIframe: true,
      omitResumeIframeParentId: true,
      ...options
    }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState,
      settleMs: 0
    }
  );

  const exact = await verify();
  assert.equal(exact.verified, true);
  assert.equal(
    exact.detail.root.contained_iframe.containment_method,
    "popup_scoped_exact_resume_iframe_identity"
  );
  assert.equal(exact.detail.root.contained_iframe.container_membership.verified, true);
  assert.equal(exact.detail.root.contained_iframe.container_membership.popup_scoped, true);
  assert.equal(exact.detail.root.contained_iframe.container_membership.query_count, 1);
  assert.equal(
    exact.detail.root.contained_iframe.container_membership.exact_frontend_match_count,
    1
  );
  assert.equal(
    exact.detail.root.contained_iframe.container_membership.exact_backend_match_count,
    1
  );
  assert.equal(
    exact.detail.root.contained_iframe.container_membership.recheck.verified,
    true
  );

  const targetAbsent = await verify({ popupScopedResumeIframeNodeIds: [32] });
  assert.equal(targetAbsent.verified, false);
  assert.equal(
    targetAbsent.detail.first.scopes.find((scope) => scope.source === "resume_iframe")
      .container_membership.reason,
    "detail_iframe_popup_frontend_match_missing"
  );

  const duplicateFrontend = await verify({ popupScopedResumeIframeNodeIds: [30, 30] });
  assert.equal(duplicateFrontend.verified, false);
  assert.equal(
    duplicateFrontend.detail.first.scopes.find((scope) => scope.source === "resume_iframe")
      .container_membership.reason,
    "detail_iframe_popup_frontend_match_ambiguous"
  );

  const wrongBackend = await verify({ resumeIframeBackendAfterPopupScopedQuery: 339 });
  assert.equal(wrongBackend.verified, false);
  assert.equal(
    wrongBackend.detail.first.scopes.find((scope) => scope.source === "resume_iframe")
      .container_membership.reason,
    "detail_iframe_popup_backend_mismatch"
  );

  const ambiguousBackend = await verify({
    popupScopedResumeIframeNodeIds: [30, 32],
    popupScopedResumeIframeBackendIds: { 32: 330 }
  });
  assert.equal(ambiguousBackend.verified, false);
  assert.equal(
    ambiguousBackend.detail.first.scopes.find((scope) => scope.source === "resume_iframe")
      .container_membership.reason,
    "detail_iframe_popup_backend_match_ambiguous"
  );

  const popupDrift = await verify({ popupBackendAfterPopupScopedQuery: 229 });
  assert.equal(popupDrift.verified, false);
  assert.equal(
    popupDrift.detail.first.scopes.find((scope) => scope.source === "resume_iframe")
      .container_membership.reason,
    "detail_iframe_popup_backend_drift"
  );

  const linkDrift = await verify({ resumeDocumentNodeIdAfterPopupScopedQuery: 99 });
  assert.equal(linkDrift.verified, false);
  assert.equal(
    linkDrift.detail.first.scopes.find((scope) => scope.source === "resume_iframe")
      .container_membership.reason,
    "detail_iframe_document_link_drift"
  );

  const documentBackendDrift = await verify({
    resumeDocumentBackendAfterPopupScopedQuery: 339
  });
  assert.equal(documentBackendDrift.verified, false);
  assert.equal(
    documentBackendDrift.detail.first.scopes.find((scope) => scope.source === "resume_iframe")
      .container_membership.reason,
    "detail_iframe_document_backend_drift"
  );

  const queryFailure = await verify({ popupScopedQueryError: "iframe query failed" });
  assert.equal(queryFailure.verified, false);
  assert.equal(
    queryFailure.detail.first.scopes.find((scope) => scope.source === "resume_iframe")
      .container_membership.reason,
    "detail_iframe_popup_query_failed"
  );
}

async function testRecommendDetailCandidateBindingRejectsIframeAncestryDrift() {
  const candidate = {
    id: "candidate-123",
    identity: {
      name: "张三",
      school: "浙江大学"
    }
  };
  const drift = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({
      includeResumeIframe: true,
      iframeAncestryDrift: true
    }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState: {
        popup: { node_id: 20, selector: ".dialog-wrap.active" },
        resumeIframe: { node_id: 30, selector: 'iframe[name*="resume"]' },
        roots: [{ name: "top", nodeId: 1 }]
      },
      settleMs: 0
    }
  );
  assert.equal(drift.verified, false);
  assert.equal(drift.reason, "detail_iframe_ancestry_not_stable");
  assert.equal(drift.detail.root, null);
}

async function testRecommendDetailCandidateBindingRejectsWrongOrStaleDetail() {
  const candidate = {
    id: "candidate-123",
    identity: {
      name: "张三",
      school: "浙江大学"
    }
  };
  const detailState = { popup: { node_id: 20 } };
  const wrong = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({ detailCandidateId: "different-candidate" }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState,
      settleMs: 0
    }
  );
  assert.equal(wrong.verified, false);
  assert.equal(wrong.reason, "detail_candidate_id_mismatch");

  const stale = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({ remountDetailBetweenSamples: true }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState,
      settleMs: 0
    }
  );
  assert.equal(stale.verified, false);
  assert.equal(stale.reason, "detail_root_identity_not_stable");

  const duplicateRoot = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({ duplicateVisibleDetailRoot: true }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState: {
        popup: { node_id: 20, selector: ".dialog-wrap.active" },
        roots: [{ name: "top", nodeId: 1 }]
      },
      settleMs: 0
    }
  );
  assert.equal(duplicateRoot.verified, false);
  assert.equal(duplicateRoot.reason, "detail_root_not_unique");
  assert.equal(duplicateRoot.detail.first.scopes.length, 2);
}

async function testRecommendDetailCandidateBindingNoScrollProofFailsClosedOnDrift() {
  const candidate = {
    id: "candidate-123",
    identity: {
      name: "张三",
      school: "浙江大学"
    }
  };
  const detailState = { popup: { node_id: 20 } };
  const exactClient = createRecommendDetailBindingClient();
  exactClient.DOM.scrollIntoViewIfNeeded = async () => {
    assert.fail("non-scrolling candidate proof must never scroll identity nodes");
  };
  const exact = await verifyRecommendDetailCandidateBinding(exactClient, {
    cardNodeId: 10,
    cardCandidate: candidate,
    detailState,
    allowScroll: false,
    settleMs: 0
  });
  assert.equal(exact.verified, true);
  assert.equal(exact.allow_scroll, false);
  assert.equal(exact.settle_ms, 0);

  const wrong = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({ detailCandidateId: "different-candidate" }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState,
      allowScroll: false,
      settleMs: 0
    }
  );
  assert.equal(wrong.verified, false);
  assert.equal(wrong.reason, "detail_candidate_id_mismatch");

  const remounted = await verifyRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({ remountDetailBetweenSamples: true }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState,
      allowScroll: false,
      settleMs: 0
    }
  );
  assert.equal(remounted.verified, false);
  assert.equal(remounted.reason, "detail_root_identity_not_stable");
}

function createVerifiedPreClickCardProvenance(candidate = null) {
  return {
    verified: true,
    reason: null,
    containment_method: "parent_ancestry",
    card: {
      verified: true,
      reason: null,
      node_id: 10,
      backend_node_id: 110,
      candidate_id: candidate?.id || "candidate-123",
      name: candidate?.identity?.name || "张三",
      visible: true
    },
    list_root: {
      node_id: 1,
      backend_node_id: 101,
      iframe_node_id: 2,
      iframe_backend_node_id: 102,
      linked_document_node_id: 1
    },
    ancestry: {
      verified: true,
      reason: null,
      descendant_node_id: 10,
      ancestor_node_id: 1,
      ancestor_backend_node_id: 101,
      depth: 2,
      path: [
        { node_id: 10, backend_node_id: 110 },
        { node_id: 20, backend_node_id: 220 },
        { node_id: 1, backend_node_id: 101 }
      ]
    }
  };
}

function createExactRecommendCardClickEvidence({
  safe = true,
  nodeId = 10
} = {}) {
  const point = {
    x: 120,
    y: 30,
    mode: "card-body-safe-point",
    attempt_index: 0,
    hit_test_candidate_index: 0
  };
  return {
    verified: true,
    in_viewport: true,
    reason: null,
    node_id: nodeId,
    click_target: point,
    viewport: {
      width: 1440,
      height: 900,
      margin_px: 4,
      source: "cssVisualViewport"
    },
    hit_test: {
      completed: true,
      exact_card_hit_verified: true,
      reason: null,
      selected: point,
      descendant_count: 4,
      unsafe_descendant_count: 0,
      attempts: [{
        point,
        inside_viewport: true,
        exact_card_hit: true,
        safe_card_hit: safe,
        safe_card_body_hit: safe,
        hit_node_id: nodeId,
        hit_node_name: "DIV",
        hit_backend_node_id: 110,
        reason: safe ? null : "card_click_point_not_safe_card_body"
      }]
    }
  };
}

function createExactRecommendCardClickAttempts() {
  return [{
    attempt: 1,
    click_target: createExactRecommendCardClickEvidence().click_target,
    input_dispatched: true,
    outcome: "detail",
    elapsed_ms: 25
  }];
}

async function testRecommendCanvasDetailUsesStrictExactClickCausality() {
  const candidate = {
    id: "candidate-123",
    identity: { name: "张三", school: "浙江大学" }
  };
  const detailState = {
    popup: { node_id: 20, selector: ".dialog-wrap.active" },
    resumeIframe: { node_id: 30, selector: 'iframe[name*="resume"]' },
    roots: [{ name: "top", nodeId: 1 }]
  };
  const provenance = createVerifiedPreClickCardProvenance(candidate);
  const baseOptions = {
    cardNodeId: 10,
    cardCandidate: candidate,
    detailState,
    cardEvidenceBefore: provenance.card,
    cardPreClickProvenance: provenance,
    cardClickEvidence: createExactRecommendCardClickEvidence(),
    clickAttempts: createExactRecommendCardClickAttempts(),
    detailRootsBefore: {
      schema_version: 1,
      captured: true,
      complete: true,
      roots: [],
      ignored_scopes: []
    },
    allowCardDisappearance: true,
    allowScroll: false,
    settleMs: 0
  };
  const canvasClient = (overrides = {}) => createRecommendDetailBindingClient({
    includeResumeIframe: true,
    cardDetachedAfterClick: true,
    omitDetailCandidateId: true,
    omitDetailIdentityText: true,
    ...overrides
  });

  const exact = await verifyRecommendDetailCandidateBinding(
    canvasClient(),
    baseOptions
  );
  assert.equal(exact.verified, true);
  assert.equal(exact.method, "exact_card_click_and_new_resume_root");
  assert.equal(exact.detail.exact_name, false);
  assert.equal(exact.detail.exact_secondary, false);
  assert.equal(exact.card.disappeared_after_click, true);
  assert.equal(exact.card.causal_proof.verified, true);
  assert.equal(exact.card.click_attempts.length, 1);
  assert.equal(exact.detail.root.source, "popup");
  assert.equal(exact.detail.root.contained_iframe.contained, true);
  assert.equal(
    exact.detail.root.contained_iframe.selector,
    'iframe[name*="resume"]'
  );
  assert.equal(
    exact.detail.second.identity_probes.every((probe) => (
      probe.exact_dom_text_count === 0 && probe.ax_exact_count === 0
    )),
    true
  );

  const unsafeHit = await verifyRecommendDetailCandidateBinding(
    canvasClient(),
    {
      ...baseOptions,
      cardClickEvidence: createExactRecommendCardClickEvidence({ safe: false })
    }
  );
  assert.equal(unsafeHit.verified, false);
  assert.equal(unsafeHit.screening_verified, false);
  assert.equal(unsafeHit.reason, "detail_causal_safe_hit_unverified");

  const repeatedClick = await verifyRecommendDetailCandidateBinding(
    canvasClient(),
    {
      ...baseOptions,
      clickAttempts: [
        ...createExactRecommendCardClickAttempts(),
        { ...createExactRecommendCardClickAttempts()[0], attempt: 2 }
      ]
    }
  );
  assert.equal(repeatedClick.verified, false);
  assert.equal(repeatedClick.screening_verified, false);
  assert.equal(repeatedClick.reason, "detail_causal_single_click_unverified");

  const cardStillMounted = await verifyRecommendDetailCandidateBinding(
    canvasClient({ cardDetachedAfterClick: false }),
    baseOptions
  );
  assert.equal(cardStillMounted.verified, false);
  assert.equal(cardStillMounted.reason, "detail_causal_card_not_detached_after_click");
  assert.equal(cardStillMounted.screening_verified, true);
  assert.equal(
    cardStillMounted.screening_method,
    "exact_card_click_and_stable_popup_cv_root"
  );

  const preExistingRoot = await verifyRecommendDetailCandidateBinding(
    canvasClient(),
    {
      ...baseOptions,
      detailRootsBefore: [{
        source: "popup",
        node_id: 20,
        backend_node_id: 220,
        iframe_node_id: null,
        iframe_backend_node_id: null,
        visible: true
      }]
    }
  );
  assert.equal(preExistingRoot.verified, false);
  assert.equal(preExistingRoot.screening_verified, false);
  assert.equal(preExistingRoot.reason, "detail_root_not_newly_mounted");

  const wrongCandidateId = await verifyRecommendDetailCandidateBinding(
    canvasClient({
      detailCandidateId: "different-candidate",
      omitDetailCandidateId: false
    }),
    baseOptions
  );
  assert.equal(wrongCandidateId.verified, false);
  assert.equal(wrongCandidateId.screening_verified, false);
  assert.equal(wrongCandidateId.reason, "detail_candidate_id_mismatch");

  const loadingOnly = await verifyRecommendDetailCandidateBinding(
    canvasClient({ includeResumeIframe: false }),
    {
      ...baseOptions,
      detailState: { popup: { node_id: 20, selector: ".dialog-wrap.active" } }
    }
  );
  assert.equal(loadingOnly.verified, false);
  assert.equal(loadingOnly.reason, "detail_causal_resume_iframe_not_ready");
  assert.equal(loadingOnly.screening_verified, true);
  assert.equal(
    loadingOnly.screening_method,
    "exact_card_click_and_stable_popup_cv_root"
  );

  const genericLoadingPopup = await verifyRecommendDetailCandidateBinding(
    canvasClient({ includeResumeIframe: false, includePopupCvTarget: false }),
    {
      ...baseOptions,
      detailState: { popup: { node_id: 20, selector: ".dialog-wrap.active" } }
    }
  );
  assert.equal(genericLoadingPopup.verified, false);
  assert.equal(genericLoadingPopup.screening_verified, false);
  assert.equal(
    genericLoadingPopup.screening_reason,
    "screening_popup_cv_target_unverified"
  );

  const screeningReady = await waitForRecommendDetailCandidateBinding(
    canvasClient({ includeResumeIframe: false }),
    {
      ...baseOptions,
      acceptScreeningBinding: true,
      timeoutMs: 0,
      maxAttempts: 1
    }
  );
  assert.equal(screeningReady.verified, false);
  assert.equal(screeningReady.screening_verified, true);
  assert.equal(screeningReady.readiness.verified, true);
  assert.equal(screeningReady.readiness.strict_verified, false);
  assert.equal(screeningReady.readiness.accepted_screening_binding, true);
}

async function testRecommendDetailBindingReadinessAllowsExactDelayedIdentityAfterCardUnmount() {
  const candidate = {
    id: "candidate-123",
    identity: { name: "张三", school: "浙江大学" }
  };
  const binding = await waitForRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({
      cardDetachedAfterClick: true,
      identityReadyAfterSamples: 2
    }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      detailState: { popup: { node_id: 20 } },
      cardEvidenceBefore: createVerifiedPreClickCardProvenance(candidate).card,
      cardPreClickProvenance: createVerifiedPreClickCardProvenance(candidate),
      detailRootsBefore: [],
      allowCardDisappearance: true,
      settleMs: 0,
      intervalMs: 0,
      timeoutMs: 1000,
      maxAttempts: 4
    }
  );
  assert.equal(binding.verified, true);
  assert.equal(binding.method, "exact_candidate_id_and_name");
  assert.equal(binding.card.disappeared_after_click, true);
  assert.equal(binding.detail.newly_mounted, true);
  assert.equal(binding.readiness.attempt_count, 2);
}

async function testRecommendDetailBindingReadinessRefreshesLoadingPopupState() {
  const candidate = {
    id: "candidate-123",
    identity: { name: "张三" }
  };
  let detailStateReads = 0;
  const client = createRecommendDetailBindingClient({
    omitDetailCandidateId: true,
    cardDetachedAfterClick: true,
    identityReadyAfterSamples: 999
  });
  const originalQuerySelectorAll = client.DOM.querySelectorAll.bind(client.DOM);
  const originalGetAttributes = client.DOM.getAttributes.bind(client.DOM);
  const originalGetOuterHTML = client.DOM.getOuterHTML.bind(client.DOM);
  const originalGetBoxModel = client.DOM.getBoxModel.bind(client.DOM);
  const originalDescribeNode = client.DOM.describeNode.bind(client.DOM);
  const originalGetPartialAXTree = client.Accessibility.getPartialAXTree.bind(
    client.Accessibility
  );

  client.DOM.getDocument = async () => {
    detailStateReads += 1;
    return { root: { nodeId: 100 } };
  };
  client.DOM.querySelector = async ({ nodeId, selector }) => ({
    nodeId: nodeId === 100 && String(selector).includes("iframe") ? 2 : 0
  });
  client.DOM.querySelectorAll = async ({ nodeId, selector }) => {
    const value = String(selector);
    if ((nodeId === 100 || nodeId === 1) && value === ".dialog-wrap.active") {
      return { nodeIds: [20] };
    }
    if (
      detailStateReads > 1
      && (nodeId === 100 || nodeId === 1 || nodeId === 20)
      && value.includes("iframe")
      && (value.includes("resume") || value.includes("/web/frame/c-resume/"))
    ) {
      return { nodeIds: [30] };
    }
    if (nodeId === 31 && value.includes("[data-geek]")) return { nodeIds: [33] };
    if (nodeId === 31 && (value.includes(".name") || value.includes("span"))) {
      return { nodeIds: [32] };
    }
    return originalQuerySelectorAll({ nodeId, selector });
  };
  client.DOM.getAttributes = async ({ nodeId }) => {
    if (nodeId === 33) return { attributes: ["data-geek", "candidate-123"] };
    return originalGetAttributes({ nodeId });
  };
  client.DOM.getOuterHTML = async ({ nodeId }) => {
    if (nodeId === 30) return { outerHTML: '<iframe name="resume"></iframe>' };
    if (nodeId === 31) return { outerHTML: '<html data-geek="candidate-123"></html>' };
    if (nodeId === 32) return { outerHTML: '<span class="name">张三</span>' };
    if (nodeId === 33) return { outerHTML: '<div data-geek="candidate-123"></div>' };
    return originalGetOuterHTML({ nodeId });
  };
  client.DOM.getBoxModel = async ({ nodeId }) => {
    if ([32, 33, 100].includes(nodeId)) {
      return { model: { border: [10, 10, 210, 10, 210, 50, 10, 50] } };
    }
    return originalGetBoxModel({ nodeId });
  };
  client.DOM.describeNode = async ({ nodeId }) => {
    if (nodeId === 100) {
      return { node: { nodeId: 100, backendNodeId: 1100, parentId: 0 } };
    }
    if (nodeId === 32) {
      return { node: { nodeId: 32, backendNodeId: 332, parentId: 31 } };
    }
    if (nodeId === 33) {
      return { node: { nodeId: 33, backendNodeId: 333, parentId: 31 } };
    }
    return originalDescribeNode({ nodeId });
  };
  client.Accessibility.getPartialAXTree = async ({ nodeId }) => {
    if (nodeId === 32) {
      return {
        nodes: [{
          nodeId: "ax-name",
          backendDOMNodeId: 332,
          ignored: false,
          role: { value: "StaticText" },
          name: { value: "张三" }
        }]
      };
    }
    return originalGetPartialAXTree({ nodeId });
  };

  const binding = await waitForRecommendDetailCandidateBinding(client, {
    cardNodeId: 10,
    cardCandidate: candidate,
    detailState: {
      popup: { node_id: 20, selector: ".dialog-wrap.active" },
      roots: [{ name: "recommend-frame", nodeId: 1 }]
    },
    cardEvidenceBefore: createVerifiedPreClickCardProvenance(candidate).card,
    cardPreClickProvenance: createVerifiedPreClickCardProvenance(candidate),
    detailRootsBefore: [],
    allowCardDisappearance: true,
    allowScroll: false,
    settleMs: 0,
    intervalMs: 0,
    timeoutMs: 1000,
    maxAttempts: 3
  });

  assert.equal(binding.verified, true);
  assert.equal(binding.method, "exact_candidate_id_and_name");
  assert.equal(binding.readiness.attempt_count, 2);
  assert.equal(detailStateReads >= 1, true, "later readiness attempts must re-read detail state");
  assert.equal(binding.detail.root.source, "popup");
  assert.equal(binding.detail.root.contained_iframe.iframe_node_id, 30);
  assert.equal(binding.detail.root.contained_iframe.node_id, 31);
}

async function testRecommendPreClickCardProvenanceRequiresExactIframeDocumentLink() {
  const candidate = {
    id: "candidate-123",
    identity: { name: "张三", school: "浙江大学" }
  };
  const read = (options = {}) => readRecommendCardPreClickProvenance(
    createRecommendDetailBindingClient(options),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      rootState: {
        iframe: { nodeId: 2, documentNodeId: 1 }
      }
    }
  );
  const exact = await readRecommendCardPreClickProvenance(
    createRecommendDetailBindingClient(),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      rootState: {
        iframe: { nodeId: 2, documentNodeId: 1 }
      }
    }
  );
  assert.equal(exact.verified, true);
  assert.equal(exact.list_root.linked_document_node_id, 1);
  assert.equal(exact.ancestry.verified, true);
  assert.equal(exact.containment_method, "parent_ancestry");
  assert.equal(exact.root_membership, null);

  const mismatched = await readRecommendCardPreClickProvenance(
    createRecommendDetailBindingClient({ iframeDocumentNodeId: 99 }),
    {
      cardNodeId: 10,
      cardCandidate: candidate,
      rootState: {
        iframe: { nodeId: 2, documentNodeId: 1 }
      }
    }
  );
  assert.equal(mismatched.verified, false);
  assert.equal(mismatched.reason, "card_iframe_document_link_mismatch");

  const rootScoped = await read({ omitCardParentId: true });
  assert.equal(rootScoped.verified, true);
  assert.equal(rootScoped.ancestry.verified, false);
  assert.equal(rootScoped.ancestry.parent_id_missing, true);
  assert.equal(rootScoped.containment_method, "root_scoped_exact_card_identity");
  assert.equal(rootScoped.root_membership.verified, true);
  assert.equal(rootScoped.root_membership.root_scoped, true);
  assert.equal(rootScoped.root_membership.query_count, 1);
  assert.equal(rootScoped.root_membership.exact_frontend_match_count, 1);
  assert.equal(rootScoped.root_membership.exact_backend_match_count, 1);
  assert.equal(rootScoped.root_membership.observed_card_backend_node_id, 110);
  assert.equal(rootScoped.root_membership.recheck.verified, true);
  assert.equal(rootScoped.root_membership.recheck.observed_root_backend_node_id, 101);
  assert.equal(rootScoped.root_membership.recheck.observed_iframe_backend_node_id, 102);
  assert.equal(rootScoped.root_membership.recheck.observed_linked_document_node_id, 1);
  assert.equal(rootScoped.root_membership.card_identity_recheck.verified, true);
  assert.equal(rootScoped.root_membership.card_identity_recheck.candidate_id, "candidate-123");

  const targetAbsent = await read({
    omitCardParentId: true,
    rootScopedCardNodeIds: [11]
  });
  assert.equal(targetAbsent.verified, false);
  assert.equal(targetAbsent.reason, "card_list_root_frontend_match_missing");
  assert.equal(targetAbsent.root_membership.exact_frontend_match_count, 0);

  const duplicateFrontend = await read({
    omitCardParentId: true,
    rootScopedCardNodeIds: [10, 10]
  });
  assert.equal(duplicateFrontend.verified, false);
  assert.equal(duplicateFrontend.reason, "card_list_root_frontend_match_ambiguous");
  assert.equal(duplicateFrontend.root_membership.exact_frontend_match_count, 2);

  const wrongBackend = await read({
    omitCardParentId: true,
    rootScopedCardBackendIds: { 10: 119 }
  });
  assert.equal(wrongBackend.verified, false);
  assert.equal(wrongBackend.reason, "card_list_root_card_backend_mismatch");
  assert.equal(wrongBackend.root_membership.expected_card_backend_node_id, 110);
  assert.equal(wrongBackend.root_membership.observed_card_backend_node_id, 119);

  const reusedCardIdentity = await read({
    omitCardParentId: true,
    cardCandidateIdAfterRootScopedQuery: "other-candidate",
    cardNameAfterRootScopedQuery: "李四"
  });
  assert.equal(reusedCardIdentity.verified, false);
  assert.equal(reusedCardIdentity.reason, "card_list_root_card_identity_recheck_failed");
  assert.equal(reusedCardIdentity.root_membership.card_identity_recheck.verified, false);
  assert.equal(
    reusedCardIdentity.root_membership.card_identity_recheck.candidate_id,
    "other-candidate"
  );

  const ambiguousBackend = await read({
    omitCardParentId: true,
    rootScopedCardNodeIds: [10, 11],
    rootScopedCardBackendIds: { 11: 110 }
  });
  assert.equal(ambiguousBackend.verified, false);
  assert.equal(ambiguousBackend.reason, "card_list_root_backend_match_ambiguous");
  assert.equal(ambiguousBackend.root_membership.exact_backend_match_count, 2);

  const rootDrift = await read({
    omitCardParentId: true,
    rootBackendAfterRootScopedQuery: 109
  });
  assert.equal(rootDrift.verified, false);
  assert.equal(rootDrift.reason, "card_list_root_backend_drift");
  assert.equal(rootDrift.root_membership.recheck.verified, false);

  const iframeDrift = await read({
    omitCardParentId: true,
    iframeBackendAfterRootScopedQuery: 109
  });
  assert.equal(iframeDrift.verified, false);
  assert.equal(iframeDrift.reason, "card_iframe_backend_drift");
  assert.equal(iframeDrift.root_membership.recheck.verified, false);

  const linkDrift = await read({
    omitCardParentId: true,
    iframeDocumentNodeIdAfterRootScopedQuery: 99
  });
  assert.equal(linkDrift.verified, false);
  assert.equal(linkDrift.reason, "card_iframe_document_link_drift");
  assert.equal(linkDrift.root_membership.recheck.observed_linked_document_node_id, 99);

  const queryFailure = await read({
    omitCardParentId: true,
    rootScopedQueryError: "query transport failed"
  });
  assert.equal(queryFailure.verified, false);
  assert.equal(queryFailure.reason, "card_list_root_query_failed");
  assert.equal(queryFailure.root_membership.error, "query transport failed");
}

async function testRecommendDetailBindingReadinessWrongIdAndTimeoutFailClosed() {
  const candidate = {
    id: "candidate-123",
    identity: { name: "张三", school: "浙江大学" }
  };
  const shared = {
    cardNodeId: 10,
    cardCandidate: candidate,
    detailState: { popup: { node_id: 20 } },
    cardEvidenceBefore: createVerifiedPreClickCardProvenance(candidate).card,
    cardPreClickProvenance: createVerifiedPreClickCardProvenance(candidate),
    detailRootsBefore: [],
    allowCardDisappearance: true,
    settleMs: 0,
    intervalMs: 0,
    timeoutMs: 1000
  };
  const wrong = await waitForRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({
      cardDetachedAfterClick: true,
      detailCandidateId: "different-candidate"
    }),
    { ...shared, maxAttempts: 4 }
  );
  assert.equal(wrong.verified, false);
  assert.equal(wrong.reason, "detail_candidate_id_mismatch");
  assert.equal(wrong.readiness.terminal, true);
  assert.equal(wrong.readiness.attempt_count, 1);

  const noSecondaryCandidate = {
    id: candidate.id,
    identity: { name: candidate.identity.name }
  };
  const timeout = await waitForRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({
      cardDetachedAfterClick: true,
      omitDetailCandidateId: true
    }),
    {
      ...shared,
      cardCandidate: noSecondaryCandidate,
      cardEvidenceBefore: createVerifiedPreClickCardProvenance(noSecondaryCandidate).card,
      cardPreClickProvenance: createVerifiedPreClickCardProvenance(noSecondaryCandidate),
      maxAttempts: 2
    }
  );
  assert.equal(timeout.verified, false);
  assert.equal(timeout.reason, "detail_binding_readiness_timeout");
  assert.equal(timeout.readiness.exhausted, true);
  assert.equal(timeout.readiness.last_reason, "detail_secondary_identity_not_proven");
  assert.equal(timeout.method, null, "name alone must never authorize detail binding");

  const singleDetailClick = [{
    attempt: 1,
    input_dispatched: true,
    outcome: "detail"
  }];
  assert.equal(
    isCleanRecommendPostClickBindingReadinessTimeout(timeout, singleDetailClick),
    true
  );
  for (const [bindingMutation, clickAttempts] of [
    [{ reason: "detail_candidate_id_mismatch" }, singleDetailClick],
    [{ readiness: { ...timeout.readiness, exhausted: false } }, singleDetailClick],
    [{ readiness: { ...timeout.readiness, terminal: true } }, singleDetailClick],
    [{ readiness: { ...timeout.readiness, last_error: "read failed" } }, singleDetailClick],
    [{}, [...singleDetailClick, { attempt: 2, input_dispatched: true, outcome: "detail" }]],
    [{}, [{ attempt: 1, input_dispatched: true, outcome: "none" }]]
  ]) {
    assert.equal(
      isCleanRecommendPostClickBindingReadinessTimeout(
        { ...timeout, ...bindingMutation },
        clickAttempts
      ),
      false
    );
  }

  await assert.rejects(
    () => waitForRecommendDetailCandidateBinding(
      createRecommendDetailBindingClient({
        cardAfterClickError: "WebSocket is not open: readyState 3 (CLOSED)"
      }),
      { ...shared, maxAttempts: 1 }
    ),
    /WebSocket is not open/,
    "closed transport errors must propagate instead of becoming a local binding mismatch"
  );

  const oldRoot = await waitForRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({ cardDetachedAfterClick: true }),
    {
      ...shared,
      detailRootsBefore: [{
        source: "popup",
        node_id: 20,
        backend_node_id: 220,
        iframe_node_id: null,
        iframe_backend_node_id: null,
        visible: true
      }],
      maxAttempts: 2
    }
  );
  assert.equal(oldRoot.verified, false);
  assert.equal(oldRoot.reason, "detail_root_not_newly_mounted");
  assert.equal(oldRoot.readiness.terminal, true);

  const rootSwap = await waitForRecommendDetailCandidateBinding(
    createRecommendDetailBindingClient({ cardDetachedAfterClick: true }),
    {
      ...shared,
      expectedDetailRoot: {
        source: "popup",
        node_id: 99,
        backend_node_id: 999,
        iframe_node_id: null,
        iframe_backend_node_id: null
      },
      maxAttempts: 2
    }
  );
  assert.equal(rootSwap.verified, false);
  assert.equal(rootSwap.reason, "detail_root_changed");
  assert.equal(rootSwap.readiness.terminal, true);
}

function createRecommendFilteredEmptyStateClient({
  text = "没有相关数据",
  axText = text,
  visible = true
} = {}) {
  return {
    DOM: {
      async querySelectorAll({ selector }) {
        return { nodeIds: selector === ".empty-text" ? [41] : [] };
      },
      async getOuterHTML({ nodeId }) {
        assert.equal(nodeId, 41);
        return { outerHTML: `<div class="empty-text">${text}</div>` };
      },
      async getBoxModel({ nodeId }) {
        assert.equal(nodeId, 41);
        if (!visible) throw new Error("node is not visible");
        return {
          model: {
            border: [400, 300, 600, 300, 600, 340, 400, 340]
          }
        };
      }
    },
    Accessibility: {
      async getPartialAXTree({ nodeId }) {
        assert.equal(nodeId, 41);
        return {
          nodes: [{
            ignored: false,
            role: { value: "StaticText" },
            name: { value: axText }
          }]
        };
      }
    }
  };
}

function createScrollingColleagueContactClient({
  rowTextByPosition = [
    "甲同事 向Ta发起沟通 2026-05-01 10:00",
    "乙同事 向Ta发起沟通 2026-05-02 10:00",
    "丙同事 向Ta发起沟通 2026-05-03 10:00",
    "丁同事 向Ta发起沟通 2026-05-04 10:00"
  ],
  loseBindingAtPosition = null,
  failScrollAtPosition = null,
  ignoreScroll = false
} = {}) {
  const fixture = createColleagueContactClient({ initialSelectedTab: "colleague" });
  let scrollPosition = 0;
  const originalQuerySelectorAll = fixture.client.DOM.querySelectorAll;
  const originalGetOuterHTML = fixture.client.DOM.getOuterHTML;
  const originalDispatchMouseEvent = fixture.client.Input.dispatchMouseEvent;
  fixture.client.DOM.querySelectorAll = async (params) => {
    if (params.nodeId === 10 && params.selector === ".record-item.mate-log-item .content") {
      return { nodeIds: [31 + scrollPosition] };
    }
    if (
      params.nodeId === 10
      && params.selector === ".tab-hd .selected"
      && loseBindingAtPosition === scrollPosition
    ) {
      return { nodeIds: [21] };
    }
    return originalQuerySelectorAll(params);
  };
  fixture.client.DOM.getOuterHTML = async (params) => {
    const position = params.nodeId - 31;
    if (position >= 0 && position < rowTextByPosition.length) {
      return { outerHTML: `<div class="content">${rowTextByPosition[position]}</div>` };
    }
    return originalGetOuterHTML(params);
  };
  fixture.client.Input.dispatchMouseEvent = async (event) => {
    if (event.type !== "mouseWheel") return originalDispatchMouseEvent(event);
    if (failScrollAtPosition === scrollPosition) throw new Error("synthetic scroll failure");
    if (!ignoreScroll) {
      scrollPosition = Math.min(scrollPosition + 1, rowTextByPosition.length - 1);
    }
    return {};
  };
  return {
    client: fixture.client,
    get state() {
      return { scrollPosition };
    }
  };
}

async function testColleagueContactSamplesEveryScrollPosition() {
  const fixture = createScrollingColleagueContactClient({
    rowTextByPosition: [
      "甲同事 向Ta发起沟通 2026-05-01 10:00",
      "乙同事 向Ta发起沟通 2026-06-20 10:00",
      "丙同事 向Ta发起沟通 2026-05-03 10:00",
      "丁同事 向Ta发起沟通 2026-05-04 10:00"
    ]
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: true,
    scrollMaxSteps: 6,
    scrollSettleMs: 0
  });
  assert.equal(result.recent, true);
  assert.equal(result.reason, "recent_colleague_contact_found");
  assert.equal(result.matched_row.text.includes("乙同事"), true);
  assert.deepEqual(result.matched_row.observed_at_positions, [1]);
  assert.equal(result.scroll_probe.completed, true);
  assert.equal(result.scroll_probe.coverage_verified, true);
  assert.equal(result.scroll_probe.scrolls_completed, 5);
  assert.equal(result.scroll_probe.position_count, 6);
  assert.equal(result.scroll_probe.end_proof.verified, true);
  assert.equal(result.scroll_probe.end_proof.stable_samples_observed, 2);
  assert.deepEqual(
    result.scroll_probe.positions.map((position) => position.sampled_after_scroll_count),
    [0, 1, 2, 3, 4, 5]
  );
}

async function testColleagueContactFindsRecentRowBeyondLegacyScrollCap() {
  const fixture = createScrollingColleagueContactClient({
    rowTextByPosition: [
      "甲同事 向Ta发起沟通 2026-05-01 10:00",
      "乙同事 向Ta发起沟通 2026-05-02 10:00",
      "丙同事 向Ta发起沟通 2026-05-03 10:00",
      "丁同事 向Ta发起沟通 2026-05-04 10:00",
      "戊同事 向Ta发起沟通 2026-05-05 10:00",
      "己同事 向Ta发起沟通 2026-05-06 10:00",
      "庚同事 向Ta发起沟通 2026-06-20 10:00",
      "辛同事 向Ta发起沟通 2026-05-08 10:00"
    ]
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: true,
    scrollMaxSteps: 12,
    scrollSettleMs: 0
  });
  assert.equal(result.checked, true);
  assert.equal(result.recent, true);
  assert.equal(result.reason, "recent_colleague_contact_found");
  assert.equal(result.matched_row.text.includes("庚同事"), true);
  assert.deepEqual(result.matched_row.observed_at_positions, [6]);
  assert.equal(result.scroll_probe.scrolls_completed, 9);
  assert.equal(result.scroll_probe.end_proof.verified, true);
}

async function testColleagueContactCapWithoutStableEndFailsClosed() {
  const fixture = createScrollingColleagueContactClient({
    rowTextByPosition: Array.from(
      { length: 10 },
      (_, index) => `同事${index} 向Ta发起沟通 2026-05-${String(index + 1).padStart(2, "0")} 10:00`
    )
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: true,
    scrollMaxSteps: 5,
    scrollSettleMs: 0
  });
  assert.equal(result.checked, false);
  assert.equal(result.recent, null);
  assert.equal(result.reason, "scroll_end_not_verified_before_cap");
  assert.equal(result.scroll_probe.completed, false);
  assert.equal(result.scroll_probe.coverage_verified, false);
  assert.equal(result.scroll_probe.cap_reached_without_end, true);
  assert.equal(result.scroll_probe.end_proof.verified, false);
  assert.equal(getColleagueContactSkipReason(result), "colleague_contact_unverified");
}

async function testColleagueContactIgnoredWheelOnLongListFailsClosed() {
  const fixture = createScrollingColleagueContactClient({
    ignoreScroll: true,
    rowTextByPosition: Array.from(
      { length: 10 },
      (_, index) => `同事${index} 向Ta发起沟通 2026-05-${String(index + 1).padStart(2, "0")} 10:00`
    )
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: true,
    scrollMaxSteps: 4,
    scrollSettleMs: 0
  });
  assert.equal(result.checked, false);
  assert.equal(result.recent, null);
  assert.equal(result.reason, "scroll_end_not_verified_before_cap");
  assert.equal(result.scroll_probe.completed, false);
  assert.equal(result.scroll_probe.coverage_verified, false);
  assert.equal(result.scroll_probe.effective_scroll_count, 0);
  assert.equal(result.scroll_probe.end_proof.verified, false);
  assert.equal(result.scroll_probe.end_proof.effective_scroll_observed, false);
  assert.equal(getColleagueContactSkipReason(result), "colleague_contact_unverified");
}

async function testColleagueContactRecentVisibleRowShortCircuitsIncompleteScroll() {
  const fixture = createScrollingColleagueContactClient({
    ignoreScroll: true,
    rowTextByPosition: ["同事甲 向Ta发起沟通 2026-06-18 10:00"]
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: true,
    scrollMaxSteps: 4,
    scrollSettleMs: 0
  });
  assert.equal(result.checked, true);
  assert.equal(result.recent, true);
  assert.equal(result.reason, "recent_colleague_contact_found");
  assert.equal(result.scroll_probe.completed, false);
  assert.equal(result.scroll_probe.reason, "scroll_end_not_verified_before_cap");
  assert.equal(result.matched_row.within_window, true);
  assert.equal(isVerifiedColleagueContactInspection(result), true);
  assert.equal(getColleagueContactSkipReason(result), "skipped_recent_colleague_contact");
}

async function testColleagueContactScrollBindingDriftFailsClosed() {
  const fixture = createScrollingColleagueContactClient({
    loseBindingAtPosition: 1
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: true,
    scrollMaxSteps: 6,
    scrollSettleMs: 0
  });
  assert.equal(result.checked, false);
  assert.equal(result.recent, null);
  assert.equal(result.indeterminate, true);
  assert.equal(result.reason, "colleague_binding_lost");
  assert.equal(result.scroll_probe.completed, false);
  assert.equal(result.scroll_probe.coverage_verified, false);
  assert.equal(result.scroll_probe.failed_position, 1);
  assert.equal(result.scroll_probe.failed_binding_phase, "before_rows");
  assert.equal(getColleagueContactSkipReason(result), "colleague_contact_unverified");
}

async function testColleagueContactNoRecentRequiresCompleteScrollCoverage() {
  const fixture = createScrollingColleagueContactClient();
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: true,
    scrollMaxSteps: 6,
    scrollSettleMs: 0
  });
  assert.equal(result.checked, true);
  assert.equal(result.recent, false);
  assert.equal(result.reason, "no_recent_colleague_contact");
  assert.equal(result.scroll_probe.completed, true);
  assert.equal(result.scroll_probe.coverage_verified, true);
  assert.equal(result.scroll_probe.position_count, 6);
  assert.equal(result.scroll_probe.scrolls_completed, 5);
  assert.equal(result.scroll_probe.end_proof.verified, true);
  assert.equal(result.scroll_probe.end_proof.method, "effective_scroll_then_repeated_identical_rows");
  assert.equal(result.scroll_probe.end_proof.effective_scroll_observed, true);
  assert.equal(result.scroll_probe.effective_scroll_count > 0, true);

  const disabledFixture = createScrollingColleagueContactClient();
  const disabled = await inspectRecentColleagueContact(disabledFixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: false,
    scrollSettleMs: 0
  });
  assert.equal(disabled.checked, false);
  assert.equal(disabled.recent, null);
  assert.equal(disabled.reason, "scroll_scan_disabled");
  assert.equal(disabled.scroll_probe.completed, true);
  assert.equal(disabled.scroll_probe.coverage_verified, false);
}

async function testColleagueContactScrollDispatchFailureFailsClosed() {
  const fixture = createScrollingColleagueContactClient({
    failScrollAtPosition: 1
  });
  const result = await inspectRecentColleagueContact(fixture.client, {
    popup: { node_id: 5 },
    roots: [{ name: "top", nodeId: 1 }]
  }, {
    referenceDate: new Date(2026, 5, 24),
    windowDays: 14,
    scroll: true,
    scrollMaxSteps: 3,
    scrollSettleMs: 0
  });
  assert.equal(result.checked, false);
  assert.equal(result.recent, null);
  assert.equal(result.reason, "scroll_dispatch_failed");
  assert.equal(result.scroll_probe.completed, false);
  assert.equal(result.scroll_probe.scrolls_completed, 1);
  assert.equal(result.scroll_probe.position_count, 2);
  assert.match(result.scroll_probe.error, /synthetic scroll failure/);
  assert.equal(getColleagueContactSkipReason(result), "colleague_contact_unverified");
}

async function testRecommendFilteredEmptyStateRequiresExactVisibleDomAndAccessibility() {
  const exact = await inspectRecommendFilteredEmptyState(
    createRecommendFilteredEmptyStateClient(),
    7
  );
  assert.equal(exact.verified, true);
  assert.equal(exact.text, "没有相关数据");
  assert.equal(exact.accessibility.verified, true);

  const wrongText = await inspectRecommendFilteredEmptyState(
    createRecommendFilteredEmptyStateClient({ text: "加载中" }),
    7
  );
  assert.equal(wrongText.verified, false);

  const hidden = await inspectRecommendFilteredEmptyState(
    createRecommendFilteredEmptyStateClient({ visible: false }),
    7
  );
  assert.equal(hidden.verified, false);

  const inaccessible = await inspectRecommendFilteredEmptyState(
    createRecommendFilteredEmptyStateClient({ axText: "" }),
    7
  );
  assert.equal(inaccessible.verified, false);
}

function testRecommendRefreshExhaustionRequiresExactEmptyStateAndContext() {
  const base = {
    cardCount: 0,
    filter: { enabled: true, currentCityOnly: true },
    filterResult: { confirmed: true, unavailable: false },
    pageScopeResult: { selected: true },
    currentCityOnlyResult: { effective: true },
    emptyState: { verified: true }
  };
  assert.equal(isVerifiedRecommendRefreshExhaustion(base), true);
  assert.equal(isVerifiedRecommendRefreshExhaustion({
    ...base,
    emptyState: { verified: false }
  }), false);
  assert.equal(isVerifiedRecommendRefreshExhaustion({
    ...base,
    filterResult: { confirmed: false }
  }), false);
  assert.equal(isVerifiedRecommendRefreshExhaustion({
    ...base,
    currentCityOnlyResult: { effective: false }
  }), false);
  assert.equal(isVerifiedRecommendRefreshExhaustion({
    ...base,
    cardCount: 1
  }), false);
}

function testRecommendFilterApplicationRequiresAllStickyGroups() {
  const options = {
    filterGroups: [
      { group: "degree", labels: ["博士"], selectAllLabels: true, verifySticky: true },
      { group: "school", labels: ["985", "211"], selectAllLabels: true, verifySticky: true }
    ]
  };
  const exact = {
    confirmed: true,
    sticky_verification: {
      verified: true,
      groups: [
        {
          group: "degree",
          requested_labels: ["博士"],
          active_labels: ["博士"],
          verified: true
        },
        {
          group: "school",
          requested_labels: ["985", "211"],
          active_labels: ["211", "985"],
          verified: true
        }
      ]
    }
  };
  assert.equal(isVerifiedRecommendFilterApplication(exact, options), true);
  assert.equal(isVerifiedRecommendFilterApplication({
    ...exact,
    confirmed: false
  }, options), false);
  assert.equal(isVerifiedRecommendFilterApplication({
    ...exact,
    sticky_verification: {
      verified: true,
      groups: exact.sticky_verification.groups.slice(0, 1)
    }
  }, options), false);
  assert.equal(isVerifiedRecommendFilterApplication({
    ...exact,
    sticky_verification: {
      verified: true,
      groups: [
        exact.sticky_verification.groups[0],
        {
          group: "school",
          requested_labels: ["985"],
          active_labels: ["985"],
          verified: true
        }
      ]
    }
  }, options), false);
  assert.equal(isVerifiedRecommendFilterApplication({
    ...exact,
    sticky_verification: {
      verified: true,
      groups: [
        {
          ...exact.sticky_verification.groups[0],
          active_labels: ["博士", "硕士"]
        },
        exact.sticky_verification.groups[1]
      ]
    }
  }, options), false);
  assert.equal(isVerifiedRecommendFilterApplication({
    ...exact,
    sticky_verification: {
      verified: true,
      groups: [
        exact.sticky_verification.groups[0],
        {
          ...exact.sticky_verification.groups[1],
          active_labels: ["985", "211", "双一流院校"]
        }
      ]
    }
  }, options), false);

  const unavailableDefaultOptions = {
    filterGroups: [{
      group: "activity",
      labels: ["不限"],
      selectAllLabels: false,
      allowUnlimited: true,
      verifySticky: true
    }]
  };
  assert.equal(isVerifiedRecommendFilterApplication({
    confirmed: true,
    sticky_verification: {
      verified: true,
      groups: [{
        group: "activity",
        requested_labels: ["不限"],
        active_labels: [],
        verified: true,
        unavailable: true,
        reason: "activity_control_unavailable_default"
      }]
    }
  }, unavailableDefaultOptions), true);

  const legitimateSingleSelectOptions = {
    filterGroups: [{
      group: "degree",
      labels: ["硕士", "博士"],
      selectAllLabels: false,
      verifySticky: true
    }]
  };
  assert.equal(isVerifiedRecommendFilterApplication({
    confirmed: true,
    sticky_verification: {
      verified: true,
      groups: [{
        group: "degree",
        requested_labels: ["硕士", "博士"],
        active_labels: ["博士"],
        verified: true,
        single_select: true
      }]
    }
  }, legitimateSingleSelectOptions), true);
  assert.equal(isVerifiedRecommendFilterApplication({
    confirmed: true,
    sticky_verification: {
      verified: true,
      groups: [{
        group: "degree",
        requested_labels: ["硕士", "博士"],
        active_labels: ["硕士", "博士"],
        verified: true,
        single_select: true
      }]
    }
  }, legitimateSingleSelectOptions), false);
}

function createExactStickyFilterClient({
  degreeActive = ["博士"],
  schoolActive = ["985", "211"]
} = {}) {
  const state = { panelOpen: true };
  const optionEntries = [
    [31, 20, "博士", degreeActive.includes("博士")],
    [32, 20, "硕士", degreeActive.includes("硕士")],
    [41, 21, "985", schoolActive.includes("985")],
    [42, 21, "211", schoolActive.includes("211")],
    [43, 21, "双一流院校", schoolActive.includes("双一流院校")]
  ];
  const optionByNode = new Map(optionEntries.map(([nodeId, groupNodeId, label, active]) => (
    [nodeId, { groupNodeId, label, active }]
  )));
  return {
    DOM: {
      async querySelector({ nodeId, selector }) {
        if (nodeId !== 99) return { nodeId: 0 };
        if (selector === ".filter-label-wrap") return { nodeId: 10 };
        if (selector === ".filter-panel") return { nodeId: state.panelOpen ? 15 : 0 };
        return { nodeId: 0 };
      },
      async querySelectorAll({ nodeId, selector }) {
        if (nodeId === 99) {
          if (selector === ".filter-label-wrap") return { nodeIds: [10] };
          if (selector === ".filter-panel") return { nodeIds: state.panelOpen ? [15] : [] };
          if (selector === ".filter-panel .check-box.degree") {
            return { nodeIds: state.panelOpen ? [20] : [] };
          }
          if (selector === ".filter-panel .check-box.school") {
            return { nodeIds: state.panelOpen ? [21] : [] };
          }
          if (String(selector).includes(".filter-panel .btn")) {
            return { nodeIds: state.panelOpen ? [90] : [] };
          }
        }
        if ((nodeId === 20 || nodeId === 21) && String(selector).includes(".option")) {
          return {
            nodeIds: optionEntries
              .filter(([, groupNodeId]) => groupNodeId === nodeId)
              .map(([optionNodeId]) => optionNodeId)
          };
        }
        return { nodeIds: [] };
      },
      async getAttributes({ nodeId }) {
        const option = optionByNode.get(nodeId);
        if (option) return { attributes: ["class", `option${option.active ? " active" : ""}`] };
        if (nodeId === 10) return { attributes: ["class", "filter-label-wrap"] };
        return { attributes: ["class", "btn"] };
      },
      async getOuterHTML({ nodeId }) {
        const option = optionByNode.get(nodeId);
        if (option) {
          return {
            outerHTML: `<span class="option${option.active ? " active" : ""}">${option.label}</span>`
          };
        }
        if (nodeId === 90) return { outerHTML: '<button class="btn">确定</button>' };
        if (nodeId === 10) return { outerHTML: '<button class="filter-label-wrap">筛选</button>' };
        return { outerHTML: "<div></div>" };
      },
      async getBoxModel({ nodeId }) {
        const left = Number(nodeId) * 10;
        return { model: { border: [left, 10, left + 8, 10, left + 8, 38, left, 38] } };
      },
      async scrollIntoViewIfNeeded() {
        return {};
      }
    },
    Input: {
      async dispatchKeyEvent() {
        return {};
      },
      async dispatchMouseEvent(event) {
        if (event.type === "mouseReleased" && event.x >= 900) state.panelOpen = false;
        return {};
      }
    }
  };
}

async function testRecommendStickyVerificationRequiresExactActiveLabels() {
  const specs = [
    { group: "degree", labels: ["博士"], selectAllLabels: true },
    { group: "school", labels: ["985", "211"], selectAllLabels: true }
  ];
  const exact = await verifyFilterGroupsSticky(createExactStickyFilterClient(), 99, {
    specs,
    settleMs: 0
  });
  assert.equal(exact.verified, true);
  assert.deepEqual(exact.groups[0].active_labels, ["博士"]);
  assert.deepEqual(exact.groups[1].active_labels, ["985", "211"]);

  await assert.rejects(
    verifyFilterGroupsSticky(createExactStickyFilterClient({
      degreeActive: ["博士", "硕士"]
    }), 99, { specs, settleMs: 0 }),
    /sticky verification failed for: degree/i
  );
  await assert.rejects(
    verifyFilterGroupsSticky(createExactStickyFilterClient({
      schoolActive: ["985", "211", "双一流院校"]
    }), 99, { specs, settleMs: 0 }),
    /sticky verification failed for: school/i
  );
}

async function testRefreshFilterReapplyRejectsUnconfirmedPositiveCardContext() {
  const rootState = { iframe: { documentNodeId: 7 } };
  const options = {
    filterGroups: [
      { group: "degree", labels: ["博士"], selectAllLabels: true, verifySticky: true }
    ]
  };
  await assert.rejects(() => selectAndConfirmRefreshFilter({}, rootState, options, {
    maxAttempts: 1,
    retryDelayMs: 0,
    selectFilter: async () => ({
      confirmed: false,
      sticky_verification: null
    })
  }), /filter application was not verified/i);

  const verified = await selectAndConfirmRefreshFilter({}, rootState, options, {
    maxAttempts: 1,
    retryDelayMs: 0,
    selectFilter: async () => ({
      confirmed: true,
      sticky_verification: {
        verified: true,
        groups: [{
          group: "degree",
          requested_labels: ["博士"],
          active_labels: ["博士"],
          verified: true
        }]
      }
    })
  });
  assert.equal(verified.filter.confirmed, true);
  assert.equal(verified.attempts[0].ok, true);
}

async function testOpenRecommendJobDropdownWaitsForLateTrigger() {
  let triggerPolls = 0;
  let clicked = false;
  const optionSelector = ".job-selecter-options .job-item, .job-list .job-item, .job-item";
  const client = {
    DOM: {
      async querySelectorAll({ selector }) {
        if (selector.includes("job-selecter-wrap")) {
          triggerPolls += 1;
          return { nodeIds: triggerPolls >= 3 ? [10] : [] };
        }
        if (selector === optionSelector) {
          return { nodeIds: clicked ? [20] : [] };
        }
        return { nodeIds: [] };
      },
      async querySelector({ selector }) {
        if (selector === optionSelector && clicked) return { nodeId: 20 };
        return { nodeId: 0 };
      },
      async getBoxModel({ nodeId }) {
        if (nodeId === 10) {
          return { model: { border: [10, 10, 110, 10, 110, 40, 10, 40] } };
        }
        if (nodeId === 20) {
          return { model: { border: [10, 50, 160, 50, 160, 80, 10, 80] } };
        }
        throw new Error(`Unexpected node ${nodeId}`);
      },
      async getAttributes({ nodeId }) {
        assert.equal(nodeId, 20);
        return { attributes: ["class", "job-item curr"] };
      },
      async getOuterHTML({ nodeId }) {
        assert.equal(nodeId, 20);
        return { outerHTML: '<li class="job-item curr">算法工程师 _ 杭州 25-50K</li>' };
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        if (event.type === "mouseReleased") clicked = true;
        return {};
      }
    }
  };

  const result = await openRecommendJobDropdown(client, 99, {
    timeoutMs: 200,
    triggerTimeoutMs: 500,
    triggerIntervalMs: 10
  });

  assert.equal(result.opened, true);
  assert.equal(result.already_open, false);
  assert.equal(result.trigger.node_id, 10);
  assert.equal(result.options.length, 1);
  assert.equal(triggerPolls >= 3, true);
}

async function testOpenRecommendJobDropdownRequiresVisibleOptions() {
  let clickCount = 0;
  let escapeCount = 0;
  const optionSelector = ".job-selecter-options .job-item, .job-list .job-item, .job-item";
  const client = {
    DOM: {
      async querySelectorAll({ selector }) {
        if (selector.includes("job-selecter-wrap")) return { nodeIds: [10] };
        if (selector === optionSelector) return { nodeIds: [20] };
        return { nodeIds: [] };
      },
      async getBoxModel({ nodeId }) {
        if (nodeId === 10) {
          return { model: { border: [10, 10, 130, 10, 130, 44, 10, 44] } };
        }
        if (nodeId === 20 && clickCount >= 2) {
          return { model: { border: [10, 50, 190, 50, 190, 82, 10, 82] } };
        }
        if (nodeId === 20) {
          return { model: { border: [10, 50, 10, 50, 10, 50, 10, 50] } };
        }
        throw new Error(`Unexpected node ${nodeId}`);
      },
      async getAttributes({ nodeId }) {
        assert.equal(nodeId, 20);
        return { attributes: ["class", "job-item"] };
      },
      async getOuterHTML({ nodeId }) {
        assert.equal(nodeId, 20);
        return { outerHTML: '<li class="job-item">AI算法实习生 _ 杭州 150-200元/天</li>' };
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        if (event.type === "mouseReleased") clickCount += 1;
        return {};
      },
      async dispatchKeyEvent(event) {
        if (event.key === "Escape") escapeCount += 1;
        return {};
      }
    }
  };

  const result = await openRecommendJobDropdown(client, 99, {
    timeoutMs: 20,
    triggerTimeoutMs: 50,
    triggerIntervalMs: 1,
    maxAttempts: 2
  });

  assert.equal(result.opened, true);
  assert.equal(clickCount, 2);
  assert.equal(escapeCount >= 2, true);
  assert.equal(result.options[0].visible, true);
  assert.equal(result.attempts[0].visible_option_count, 0);
  assert.equal(result.attempts[1].visible_option_count, 1);
}

async function testSelectRecommendJobAcceptsHiddenCurrentOptionAfterDropdownMiss() {
  let clickCount = 0;
  let escapeCount = 0;
  const optionSelector = ".job-selecter-options .job-item, .job-list .job-item, .job-item";
  const client = {
    DOM: {
      async querySelectorAll({ selector }) {
        if (selector.includes("job-selecter-wrap")) return { nodeIds: [10] };
        if (selector === optionSelector) return { nodeIds: [20, 21] };
        return { nodeIds: [] };
      },
      async getBoxModel({ nodeId }) {
        if (nodeId === 10) {
          return { model: { border: [10, 10, 170, 10, 170, 44, 10, 44] } };
        }
        if (nodeId === 20 || nodeId === 21) {
          return { model: { border: [10, 50, 10, 50, 10, 50, 10, 50] } };
        }
        throw new Error(`Unexpected node ${nodeId}`);
      },
      async getAttributes({ nodeId }) {
        if (nodeId === 10) return { attributes: ["class", "job-selecter-wrap"] };
        if (nodeId === 20) return { attributes: ["class", "job-item curr"] };
        if (nodeId === 21) return { attributes: ["class", "job-item"] };
        return { attributes: [] };
      },
      async getOuterHTML({ nodeId }) {
        if (nodeId === 10) {
          return { outerHTML: '<div class="job-selecter-wrap">AI算法实习生 _ 杭州 150-200元/天 大模型高招岗位 _ 杭州 50-80K</div>' };
        }
        if (nodeId === 20) {
          return { outerHTML: '<li class="job-item curr">AI算法实习生 _ 杭州 150-200元/天</li>' };
        }
        if (nodeId === 21) {
          return { outerHTML: '<li class="job-item">大模型高招岗位 _ 杭州 50-80K</li>' };
        }
        return { outerHTML: "" };
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        if (event.type === "mouseReleased") clickCount += 1;
        return {};
      },
      async dispatchKeyEvent(event) {
        if (event.key === "Escape") escapeCount += 1;
        return {};
      }
    }
  };

  const result = await selectRecommendJob(client, 99, {
    jobLabel: "AI算法实习生 _ 杭州",
    settleMs: 0,
    dropdownTimeoutMs: 20
  });

  assert.equal(result.selected, true);
  assert.equal(result.already_current, true);
  assert.equal(result.selected_option.source, "current_option_without_visible_dropdown");
  assert.equal(result.options.length, 2);
  assert.equal(clickCount > 0, true);
  assert.equal(escapeCount > 0, true);
}

async function testSelectRecommendJobRefreshesStaleFrameRoot() {
  let currentDocumentNodeId = 100;
  let menuOpen = false;
  const optionSelector = ".job-selecter-options .job-item, .job-list .job-item, .job-item";
  const client = {
    DOM: {
      async getDocument() {
        currentDocumentNodeId = 200;
        return { root: { nodeId: 1 } };
      },
      async querySelector({ nodeId, selector }) {
        if (nodeId === 1 && selector.includes("iframe")) return { nodeId: 2 };
        if (nodeId === 200 && selector === optionSelector && menuOpen) return { nodeId: 20 };
        return { nodeId: 0 };
      },
      async describeNode({ nodeId }) {
        assert.equal(nodeId, 2);
        return { node: { contentDocument: { nodeId: currentDocumentNodeId } } };
      },
      async querySelectorAll({ nodeId, selector }) {
        if (selector.includes("job-selecter-wrap")) {
          return { nodeIds: nodeId === 200 ? [10] : [] };
        }
        if (selector === optionSelector) {
          return { nodeIds: nodeId === 200 ? [20] : [] };
        }
        return { nodeIds: [] };
      },
      async getBoxModel({ nodeId }) {
        if (nodeId === 10) {
          return { model: { border: [10, 10, 110, 10, 110, 40, 10, 40] } };
        }
        if (nodeId === 20) {
          return menuOpen
            ? { model: { border: [10, 50, 190, 50, 190, 80, 10, 80] } }
            : { model: { border: [10, 50, 10, 50, 10, 50, 10, 50] } };
        }
        throw new Error(`Unexpected node ${nodeId}`);
      },
      async getAttributes({ nodeId }) {
        assert.equal(nodeId, 20);
        return { attributes: ["class", "job-item curr"] };
      },
      async getOuterHTML({ nodeId }) {
        assert.equal(nodeId, 20);
        return { outerHTML: '<li class="job-item curr">海外用户增长运营专家（AI产品） _ 杭州 25-35K</li>' };
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        if (event.type === "mouseReleased") menuOpen = !menuOpen;
        return {};
      },
      async dispatchKeyEvent() {
        return {};
      }
    }
  };

  const result = await selectRecommendJobWithRootRefresh(client, {
    iframe: { documentNodeId: 100 }
  }, {
    jobLabel: "海外用户增长运营专家（AI产品）",
    settleMs: 0,
    dropdownTimeoutMs: 50,
    totalTimeoutMs: 1000,
    retryDelayMs: 10
  });

  assert.equal(result.job_selection.selected, true);
  assert.equal(result.root_state.iframe.documentNodeId, 200);
  assert.equal(result.attempts.length >= 2, true);
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts.at(-1).ok, true);
}

function createRecommendJobDropdownClient({ menuOpen = true, escapeCloses = false } = {}) {
  const state = {
    menuOpen: Boolean(menuOpen),
    escapeCount: 0,
    triggerClickCount: 0
  };
  const labels = {
    20: "海外用户增长运营专家（AI产品） _ 杭州 25-35K",
    21: "AI算法实习生 _ 杭州 150-200元/天"
  };
  return {
    state,
    client: {
      DOM: {
        async querySelectorAll({ selector }) {
          if (selector.includes("job-selecter-wrap")) return { nodeIds: [10] };
          if (selector === ".job-selecter-options .job-item, .job-list .job-item, .job-item") {
            return { nodeIds: [20, 21] };
          }
          return { nodeIds: [] };
        },
        async getBoxModel({ nodeId }) {
          if (nodeId === 10) {
            return { model: { border: [10, 10, 210, 10, 210, 44, 10, 44] } };
          }
          if (nodeId === 20 || nodeId === 21) {
            return state.menuOpen
              ? { model: { border: [10, 50 + nodeId, 230, 50 + nodeId, 230, 80 + nodeId, 10, 80 + nodeId] } }
              : { model: { border: [10, 50, 10, 50, 10, 50, 10, 50] } };
          }
          throw new Error(`Unexpected node ${nodeId}`);
        },
        async getAttributes({ nodeId }) {
          if (nodeId === 10) return { attributes: ["class", "job-selecter-wrap"] };
          if (nodeId === 20) return { attributes: ["class", "job-item"] };
          if (nodeId === 21) return { attributes: ["class", "job-item curr"] };
          return { attributes: [] };
        },
        async getOuterHTML({ nodeId }) {
          if (nodeId === 10) return { outerHTML: '<div class="job-selecter-wrap">AI算法实习生 _ 杭州</div>' };
          return { outerHTML: `<li>${labels[nodeId] || ""}</li>` };
        }
      },
      Input: {
        async dispatchKeyEvent(event) {
          if (event.key === "Escape") {
            state.escapeCount += 1;
            if (escapeCloses && event.type === "keyUp") state.menuOpen = false;
          }
          return {};
        },
        async dispatchMouseEvent(event) {
          if (event.type !== "mouseReleased") return {};
          if (Math.abs(event.x - 110) < 2 && Math.abs(event.y - 27) < 2) {
            state.triggerClickCount += 1;
            state.menuOpen = !state.menuOpen;
          }
          return {};
        }
      }
    }
  };
}

async function testCloseRecommendJobDropdownFallsBackToTriggerToggle() {
  const { client, state } = createRecommendJobDropdownClient({
    menuOpen: true,
    escapeCloses: false
  });
  const result = await closeRecommendJobDropdownFully(client, 99, {
    settleMs: 0,
    timeoutMs: 100
  });
  assert.equal(result.ok, true);
  assert.equal(result.closed, true);
  assert.equal(result.reason, "trigger_toggle");
  assert.equal(state.menuOpen, false);
  assert.equal(state.escapeCount > 0, true);
  assert.equal(state.triggerClickCount, 1);
}

async function testVerifyRecommendJobSelectionClosesDropdownAfterReadingCurrent() {
  const { client, state } = createRecommendJobDropdownClient({
    menuOpen: false,
    escapeCloses: false
  });
  const result = await verifyRecommendJobSelection(client, 99, {
    jobLabel: "AI算法实习生 _ 杭州",
    delayMs: 0,
    dropdownTimeoutMs: 100,
    closeSettleMs: 0
  });
  assert.equal(result.verified, true);
  assert.equal(result.current_label_without_salary, "AI算法实习生 _ 杭州");
  assert.equal(result.menu_close.ok, true);
  assert.equal(result.menu_close.reason, "trigger_toggle");
  assert.equal(state.menuOpen, false);
}

function testRetryableRecommendFilterReapplyError() {
  assert.equal(isRetryableRecommendFilterReapplyError(new Error("Recommend filter panel did not open after 6 trigger attempts")), true);
  assert.equal(isRetryableRecommendFilterReapplyError(new Error("Recommend filter trigger was not found")), true);
  assert.equal(isRetryableRecommendFilterReapplyError(new Error("Recommend filter confirm button was not found")), true);
  assert.equal(isRetryableRecommendFilterReapplyError(new Error("Could not find node with given id")), true);
  assert.equal(isRetryableRecommendFilterReapplyError(new Error("Node is detached from document")), true);
  assert.equal(isRetryableRecommendFilterReapplyError(new Error("Invalid NodeId")), true);
  assert.equal(isRetryableRecommendFilterReapplyError(new Error("No node found for given backend id")), true);
  assert.equal(isRetryableRecommendFilterReapplyError(new Error("filter state read failed", {
    cause: new Error("Could not find node with given id")
  })), true);
  assert.equal(isRetryableRecommendFilterReapplyError(new Error("Requested recommend job was not selected after refresh reload")), false);
}

function testRecommendRefreshErrorDiagnosticIsBoundedAndPreservesCdpFields() {
  const cause = new Error("Could not find node with given id");
  cause.code = -32000;
  cause.cdp_method = "DOM.getBoxModel";
  cause.cdp_at = "2026-07-17T02:03:04.000Z";
  cause.cdp_node_id = 123;
  cause.cdp_backend_node_id = 456;
  cause.node_id = 789;
  cause.cdp_param_keys = Array.from({ length: 25 }, (_, index) => `key_${index}`);
  cause.stack = Array.from({ length: 20 }, (_, index) => `stack line ${index}`).join("\n");
  const wrapped = new Error("filter reapply failed", { cause });
  wrapped.phase = "recommend:filter-reapply";

  const diagnostic = compactRecommendRefreshErrorDiagnostic(wrapped);
  assert.equal(diagnostic.message, "filter reapply failed");
  assert.equal(diagnostic.phase, "recommend:filter-reapply");
  assert.equal(diagnostic.cause.code, -32000);
  assert.equal(diagnostic.cause.cdp_method, "DOM.getBoxModel");
  assert.equal(diagnostic.cause.cdp_at, "2026-07-17T02:03:04.000Z");
  assert.equal(diagnostic.cause.cdp_node_id, 123);
  assert.equal(diagnostic.cause.cdp_backend_node_id, 456);
  assert.equal(diagnostic.cause.node_id, 789);
  assert.equal(diagnostic.cause.cdp_param_keys.length, 20);
  assert.equal(diagnostic.cause.stack.split("\n").length, 12);
}

function testRetryableRecommendJobSelectionError() {
  assert.equal(isRetryableRecommendJobSelectionError(new Error("Recommend job dropdown did not expose visible options after trigger click")), true);
  assert.equal(isRetryableRecommendJobSelectionError(new Error("Matched recommend job has no clickable center: AI算法实习生")), true);
  assert.equal(isRetryableRecommendJobSelectionError(new Error("Matched recommend job has no visible clickable option: AI算法实习生")), true);
  assert.equal(isRetryableRecommendJobSelectionError(new Error("Could not find node with given id")), true);
  assert.equal(isRetryableRecommendJobSelectionError(new Error("Could not compute box model.")), true);
  assert.equal(isRetryableRecommendJobSelectionError(new Error("Requested recommend job was not selected after refresh reload")), false);
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

async function testCloseRecommendDetailClicksOutsideModalBeforeEscape() {
  let detailVisible = true;
  let closeAfterOutsideClick = false;
  let closeClickCount = 0;
  let outsideClickCount = 0;
  let escapeCount = 0;

  const client = {
    Page: {
      async getLayoutMetrics() {
        return {
          cssLayoutViewport: {
            clientWidth: 1200,
            clientHeight: 800
          }
        };
      }
    },
    DOM: {
      async getDocument() {
        if (closeAfterOutsideClick) {
          detailVisible = false;
          closeAfterOutsideClick = false;
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
        if (selector === ".dialog-wrap.active") return { nodeIds: [6] };
        if (selector === ".boss-popup__close") return { nodeIds: [4] };
        if (selector === ".resume-center-side .resume-detail-wrap") return { nodeIds: [5] };
        return { nodeIds: [] };
      },
      async getBoxModel({ nodeId }) {
        if (nodeId === 4) {
          return { model: { border: [900, 90, 930, 90, 930, 120, 900, 120] } };
        }
        if (nodeId === 5) {
          return { model: { border: [200, 100, 800, 100, 800, 600, 200, 600] } };
        }
        if (nodeId === 6) {
          return { model: { border: [0, 0, 1200, 0, 1200, 800, 0, 800] } };
        }
        throw new Error(`Unexpected node ${nodeId}`);
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        if (event.type !== "mouseReleased") return {};
        if (event.x < 200) {
          outsideClickCount += 1;
          closeAfterOutsideClick = true;
        } else {
          closeClickCount += 1;
        }
        return {};
      },
      async dispatchKeyEvent() {
        escapeCount += 1;
        return {};
      }
    }
  };

  const result = await closeRecommendDetail(client, {
    attemptsLimit: 1,
    closeWaitMs: 20,
    escapeWaitMs: 20
  });

  assert.equal(result.closed, true);
  assert.equal(closeClickCount, 1);
  assert.equal(outsideClickCount, 1);
  assert.equal(escapeCount, 0);
  assert.equal(result.attempts.some((attempt) => attempt.mode === "outside-modal-click" && attempt.clicked), true);
  assert.equal(
    result.attempts.some((attempt) => (
      attempt.mode === "wait-closed-after-outside-click"
      && attempt.closed === true
    )),
    true
  );
}

async function testCloseRecommendDetailReportsFinalVerificationWhenStillOpen() {
  let closeClickCount = 0;
  let outsideClickCount = 0;
  let escapeCount = 0;

  const client = {
    Page: {
      async getLayoutMetrics() {
        return {
          cssLayoutViewport: {
            clientWidth: 1200,
            clientHeight: 800
          }
        };
      }
    },
    DOM: {
      async getDocument() {
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
        if (selector === ".dialog-wrap.active") return { nodeIds: [6] };
        if (selector === ".boss-popup__close") return { nodeIds: [4] };
        if (selector === ".resume-center-side .resume-detail-wrap") return { nodeIds: [5] };
        return { nodeIds: [] };
      },
      async getBoxModel({ nodeId }) {
        if (nodeId === 4) {
          return { model: { border: [900, 90, 930, 90, 930, 120, 900, 120] } };
        }
        if (nodeId === 5) {
          return { model: { border: [200, 100, 800, 100, 800, 600, 200, 600] } };
        }
        if (nodeId === 6) {
          return { model: { border: [0, 0, 1200, 0, 1200, 800, 0, 800] } };
        }
        throw new Error(`Unexpected node ${nodeId}`);
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        if (event.type !== "mouseReleased") return {};
        if (event.x < 200) {
          outsideClickCount += 1;
        } else {
          closeClickCount += 1;
        }
        return {};
      },
      async dispatchKeyEvent() {
        escapeCount += 1;
        return {};
      }
    }
  };

  const result = await closeRecommendDetail(client, {
    attemptsLimit: 1,
    closeWaitMs: 20,
    escapeWaitMs: 20
  });

  assert.equal(result.closed, false);
  assert.equal(result.reason, "detail_still_visible_after_close_attempts");
  assert.equal(closeClickCount, 1);
  assert.equal(outsideClickCount, 1);
  assert.equal(escapeCount, 2);
  assert.equal(result.verification.open, true);
  assert.equal(result.verification.stable_open, true);
  assert.equal(result.verification.second.popup.selector, ".dialog-wrap.active");
  assert.equal(result.verification.second.resume_iframe, null);
  assert.equal(
    result.attempts.some((attempt) => (
      attempt.mode === "final-close-verification"
      && attempt.open === true
      && attempt.stable_open === true
      && attempt.popup?.selector === ".dialog-wrap.active"
    )),
    true
  );
}

testFilterOptionHelpers();
testJobLabelMatchingIgnoresSalaryFormatting();
testStaleRecommendNodeClassificationTraversesCause();
testRecoverableImageCaptureEvidencePreservesPartialPages();
testRecommendMissingCaptureTargetFailsClosed();
testDeterministicFilterChoice();
testTargetedFilterChoice();
await testRecommendActivityFilterSelectionAndStickyVerification();
await testRecommendActivityUnavailableDefaultAndUnreadableControl();
await testRecommendMissingFilterPanelDefaultSafety();
await testRecommendCurrentCityOnlyStateAndStickyVerification();
await testRecommendCurrentCityOnlyAlreadyOpenAndUnavailablePolicy();
await testRecommendCurrentCityOnlyRetriesStaleControlState();
await testRecommendCurrentCityOnlyDoesNotTreatFailedOpenAsUnavailable();
await testRecommendCurrentCityOnlyRejectsTransientControlDisappearanceWhilePopoverRemainsVisible();
testNetworkPatterns();
testColleagueContactDateParsing();
await testColleagueContactSamplesEveryScrollPosition();
await testColleagueContactFindsRecentRowBeyondLegacyScrollCap();
await testColleagueContactCapWithoutStableEndFailsClosed();
await testColleagueContactIgnoredWheelOnLongListFailsClosed();
await testColleagueContactRecentVisibleRowShortCircuitsIncompleteScroll();
await testColleagueContactScrollBindingDriftFailsClosed();
await testColleagueContactNoRecentRequiresCompleteScrollCoverage();
await testColleagueContactScrollDispatchFailureFailsClosed();
await testColleagueContactInspectorSelectsColleagueTab();
await testColleagueContactInspectorWaitsForLatePanel();
await testColleagueContactInspectorFailsClosedWhenPanelMissing();
await testColleagueContactInspectorAcceptsStablePanelAbsence();
await testColleagueContactInspectorFailsClosedWhenQueryErrors();
await testColleagueContactInspectorFailsClosedWhenTabUnavailable();
testVerifiedColleagueContactInspectionRequiresExactPositiveEvidence();
await testColleagueContactRowQueryErrorDoesNotBecomeVerifiedClear();
await testColleagueContactTextReadErrorDoesNotBecomeVerifiedClear();
await testColleagueContactTabClickMustBeVerified();
await testColleagueContactMissingRowsFailClosed();
await testColleagueContactHiddenRowsCannotProveClearOrRecent();
await testColleagueContactMultipleVisibleSectionsFailClosed();
await testColleagueContactUnparseableDateFailsClosed();
await testColleagueContactJustNowIsRecent();
await testRecommendAccountRightsPanelUsesSharedSafeClose();
testRecommendCardDetailClickPointAvoidsAvatar();
await testRecommendCardClickViewportEvidenceDistinguishesVisibleAndOffscreenPoints();
await testRecommendCardClickViewportEvidenceRejectsOccludedDefaultPoint();
await testRecommendCardClickViewportEvidenceRejectsInteractiveExactCardDescendant();
await testRecommendPreverifiedCardBoxAuthorizesExactlyOneInputClick();
await testRecommendPostClickPollingStaleIsAnnotatedAndNeverReclicked();
await testRecommendPreClickSnapshotReusesSuppliedRootTree();
await testRecommendPreClickCardDisappearanceReacquiresBeforeInput();
testRecommendPreClickRetrySummaryRequiresEveryExactNoActionAttempt();
testRecommendPreClickViewportPreparationSourceOrdering();
await testRecommendAvatarPreviewIsNotDetailAndCanClose();
await testRecommendDetailCandidateBindingRequiresStableExactIdentity();
await testRecommendDetailBindingReadinessRefreshesLoadingPopupState();
await testRecommendDetailCandidateBindingUsesExactAgeAsSecondaryIdentity();
await testRecommendDetailCandidateBindingRequiresAxTextDescendantOfExactDomNode();
await testRecommendDetailCandidateBindingUsesCanonicalPopupWithContainedIframe();
await testRecommendDetailCandidateBindingUsesExactPopupScopedIframeFallback();
await testRecommendDetailCandidateBindingRejectsIframeAncestryDrift();
await testRecommendDetailCandidateBindingRejectsWrongOrStaleDetail();
await testRecommendDetailCandidateBindingNoScrollProofFailsClosedOnDrift();
await testRecommendCanvasDetailUsesStrictExactClickCausality();
await testRecommendDetailBindingReadinessAllowsExactDelayedIdentityAfterCardUnmount();
await testRecommendPreClickCardProvenanceRequiresExactIframeDocumentLink();
await testRecommendDetailBindingReadinessWrongIdAndTimeoutFailClosed();
testRetryableRecommendFilterReapplyError();
testRecommendRefreshErrorDiagnosticIsBoundedAndPreservesCdpFields();
testRetryableRecommendJobSelectionError();
testRecommendCardFieldParser();
await testCardCandidateReader();
await testRefreshRecoveryFallsBackFromNavigateToReload();
await testRecommendFilteredEmptyStateRequiresExactVisibleDomAndAccessibility();
testRecommendRefreshExhaustionRequiresExactEmptyStateAndContext();
testRecommendFilterApplicationRequiresAllStickyGroups();
await testRecommendStickyVerificationRequiresExactActiveLabels();
await testRefreshFilterReapplyRejectsUnconfirmedPositiveCardContext();
await testOpenRecommendJobDropdownWaitsForLateTrigger();
await testOpenRecommendJobDropdownRequiresVisibleOptions();
await testSelectRecommendJobAcceptsHiddenCurrentOptionAfterDropdownMiss();
await testSelectRecommendJobRefreshesStaleFrameRoot();
await testCloseRecommendJobDropdownFallsBackToTriggerToggle();
await testVerifyRecommendJobSelectionClosesDropdownAfterReadingCurrent();
await testFindFreshRecommendCardNodeByKey();
await testStaleResumeIframeDetailHtmlReadIsNonFatal();
await testPageScopeHelpers();
await testPageScopeFallbackToRecommend();
await testCloseRecommendDetailWaitsUntilClosed();
await testCloseRecommendDetailClicksOutsideModalBeforeEscape();
await testCloseRecommendDetailReportsFinalVerificationWhenStillOpen();

console.log("recommend domain tests passed");
