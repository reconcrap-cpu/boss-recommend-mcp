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
  openRecommendJobDropdown,
  parseColleagueContactDate,
  parseRecommendCardFieldsFromHtml,
  readRecommendAvatarPreviewState,
  readRecommendDetailHtml,
  readRecommendCardCandidate,
  refreshRecommendListAtEnd,
  resolveRecommendCardDetailClickPoint,
  selectRecommendJob,
  selectRecommendJobWithRootRefresh,
  selectAndConfirmFirstSafeFilter,
  selectRecommendPageScope,
  shouldFailClosedRecommendImageAcquisition,
  inspectRecentColleagueContact,
  isDateWithinWindow,
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
  triggerOpens = true
} = {}) {
  const state = {
    checked,
    popupOpen,
    checkboxAvailable,
    stateReadable,
    staleStateReadOnce,
    triggerOpens,
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
            state.popupOpen = false;
            state.confirmClickCount += 1;
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
    settleMs: 0
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
    settleMs: 0
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

function createColleagueContactClient() {
  let selectedTab = "my";
  let lastBoxNode = null;
  const clicks = [];
  const rowText = "费正丽 向Ta发起沟通 2026-06-18 10:03 3D图形算法实习生";
  function htmlForNode(nodeId) {
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
          if (nodeId === 1 && selector === ".colleague-collaboration") return { nodeIds: [10] };
          if (nodeId === 1 && selector === ".colleague-collaboration .tab-hd") return { nodeIds: [11] };
          if (nodeId === 1 && selector === ".resume-item-detail") return { nodeIds: [99] };
          if (nodeId === 1 && selector === ".colleague-collaboration .record-item.mate-log-item .content") {
            return { nodeIds: selectedTab === "colleague" ? [31] : [] };
          }
          if (nodeId === 10 && selector === ".tab-hd .selected") {
            return { nodeIds: [selectedTab === "my" ? 21 : 22] };
          }
          if (nodeId === 10 && selector === ".tab-hd span, .tab-hd div, .tab-hd *") {
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
          lastBoxNode = nodeId;
          return {
            model: {
              border: [100, 100, 200, 100, 200, 140, 100, 140]
            }
          };
        }
      },
      Input: {
        async dispatchMouseEvent(event) {
          if (event.type === "mouseReleased" && lastBoxNode === 22) {
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
    if (params.nodeId === 1 && params.selector === ".colleague-collaboration") {
      sectionQueries += 1;
      if (sectionQueries === 1) return { nodeIds: [] };
    }
    return originalQuerySelectorAll(params);
  };
  const result = await inspectRecentColleagueContact(fixture.client, {
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
testNetworkPatterns();
testColleagueContactDateParsing();
await testColleagueContactInspectorSelectsColleagueTab();
await testColleagueContactInspectorWaitsForLatePanel();
await testRecommendAccountRightsPanelUsesSharedSafeClose();
testRecommendCardDetailClickPointAvoidsAvatar();
await testRecommendAvatarPreviewIsNotDetailAndCanClose();
testRetryableRecommendFilterReapplyError();
testRecommendRefreshErrorDiagnosticIsBoundedAndPreservesCdpFields();
testRetryableRecommendJobSelectionError();
testRecommendCardFieldParser();
await testCardCandidateReader();
await testRefreshRecoveryFallsBackFromNavigateToReload();
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
