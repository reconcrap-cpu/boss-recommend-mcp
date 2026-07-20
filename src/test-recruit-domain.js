#!/usr/bin/env node
import assert from "node:assert/strict";
import { GREET_CREDITS_EXHAUSTED_CODE } from "./core/greet-quota/index.js";
import { RUN_STATUS_COMPLETED } from "./core/run/index.js";
import {
  buildRecruitJobTitleSearchTerms,
  buildRecruitRefreshSearchParams,
  buildRecruitSchoolSearchLabels,
  buildRecruitSearchApplicationStepNames,
  clickRecruitSearchWithKeywordGuard,
  closeRecruitBlockingPanels,
  countRecruitResultStatuses,
  createRecruitRunService,
  chooseRecruitTextCandidate,
  clickRecruitActionControl,
  findRecruitBlockingPanel,
  ensureRecruitCardInViewport,
  isRecoverableRecruitImageCaptureError,
  isRecoverableRecruitDetailError,
  isTerminalRecruitImageCaptureFailureSource,
  isRecruitNationalCity,
  matchesRecruitDetailNetwork,
  normalizeRecruitAgeFilter,
  normalizeRecruitExperienceFilter,
  normalizeRecruitGenderFilter,
  normalizeRecruitSearchLabel,
  normalizeRecruitSearchParams,
  parseRecruitInstruction,
  readRecruitKeywordInputValue,
  readRecruitCardCandidate,
  resolveRecruitDegreeLabel,
  setRecruitAge,
  setRecruitCity,
  setRecruitExperience,
  setRecruitExchangeResumeFilter,
  setRecruitGender,
  setRecruitJobTitle,
  setRecruitKeyword,
  setRecruitSchools,
  shouldFailClosedRecruitImageAcquisition,
  shouldRetryRecruitDetailRecovery,
  recruitInstructionParserSemantics
} from "./domains/recruit/index.js";

function testParserImportSemantics() {
  const parsed = parseRecruitInstruction({
    instruction: "请在Boss上找城市在上海，学历硕士及以上，985，目标筛选3位，做过LLM的人选。筛选条件：候选人必须有LLM相关经验。",
    confirmation: {
      keyword_confirmed: true,
      criteria_confirmed: true,
      search_params_confirmed: true
    },
    overrides: {
      keyword: "LLM",
      experience: "5-10年",
      gender: "女",
      age: { min: 25, max: 35 },
      filter_recent_viewed: true
    }
  });

  assert.equal(parsed.searchParams.city, "上海");
  assert.equal(parsed.searchParams.degree, "硕士及以上");
  assert.deepEqual(parsed.searchParams.schools, ["985院校"]);
  assert.equal(parsed.searchParams.experience, "5-10年");
  assert.equal(parsed.searchParams.gender, "女");
  assert.deepEqual(parsed.searchParams.age, { min: 25, max: 35 });
  assert.equal(parsed.searchParams.keyword, "LLM");
  assert.equal(parsed.searchParams.filter_recent_viewed, true);
  assert.equal(parsed.screenParams.target_count, 3);
  assert.match(parsed.screenParams.criteria, /LLM/);
  assert.equal(recruitInstructionParserSemantics.source, "boss-recruit-mcp/src/parser.js");

  const explicitSchools = parseRecruitInstruction({
    instruction: "学校：985、211、统招本科、留学生、qs50、qs500",
    confirmation: {
      keyword_confirmed: true,
      criteria_confirmed: true,
      search_params_confirmed: true,
      use_default_for_missing: true
    },
    overrides: {
      schools: ["985、211", "统招本科、留学生、qs50、qs500"]
    }
  });
  assert.deepEqual(explicitSchools.searchParams.schools, [
    "985院校",
    "211院校",
    "统招本科",
    "留学生",
    "QS 100",
    "QS 500"
  ]);
}

function testNetworkPatterns() {
  assert.equal(
    matchesRecruitDetailNetwork("https://www.zhipin.com/wapi/zpitem/web/boss/search/geek/info?jid=1"),
    true
  );
  assert.equal(
    matchesRecruitDetailNetwork("https://www.zhipin.com/wapi/zpjob/view/geek/info/v2?uid=1"),
    true
  );
  assert.equal(matchesRecruitDetailNetwork("https://example.com/static/app.js"), false);
}

function createAccountRightsPanelClient() {
  let panelOpen = true;
  let discarded = 0;
  const clicks = [];
  return {
    get state() {
      return { panelOpen, discarded, clicks };
    },
    client: {
      DOM: {
        async getDocument() {
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
          return { nodeIds: [99] };
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

async function testRecruitAccountRightsPanelUsesSharedSafeClose() {
  const fixture = createAccountRightsPanelClient();
  const open = await findRecruitBlockingPanel(fixture.client);
  assert.equal(open.open, true);
  assert.equal(open.query, "我的权益");
  assert.equal(fixture.state.discarded, 1);

  const result = await closeRecruitBlockingPanels(fixture.client, {
    attemptsLimit: 1,
    roots: [{ name: "top", nodeId: 1 }, { name: "search-frame", nodeId: 2 }],
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

function testSearchParamHelpers() {
  assert.equal(normalizeRecruitSearchLabel(" QS 100 "), "QS100");
  assert.equal(resolveRecruitDegreeLabel("本科及以上"), "本科");
  assert.equal(resolveRecruitDegreeLabel("硕士及以上"), "硕士");
  assert.equal(isRecruitNationalCity(" 全国 "), true);
  assert.equal(isRecruitNationalCity("不限城市"), true);
  assert.equal(isRecruitNationalCity("上海"), false);
  assert.deepEqual(normalizeRecruitSearchParams({
    city: " 上海 ",
    degree: "硕士及以上",
    schools: ["985院校", "", " QS 100 "],
    filter_recent_viewed: true
  }), {
    city: "上海",
    degree: "硕士",
    degrees: ["硕士"],
    schools: ["985院校", "QS 100"],
    keyword: "算法工程师",
    filter_recent_viewed: true,
    skip_recent_colleague_contacted: null
  });

  assert.deepEqual(normalizeRecruitSearchParams({
    degrees: ["本科", "硕士及以上", "博士"]
  }).degrees, ["本科", "硕士", "博士"]);
  assert.deepEqual(normalizeRecruitSearchParams({
    schools: "985、211、统招本科、留学生、qs50、qs500"
  }).schools, ["985", "211", "统招本科", "留学生", "qs50", "qs500"]);
  assert.deepEqual(normalizeRecruitExperienceFilter("5-10年"), {
    mode: "option",
    label: "5-10年",
    unlimited: false
  });
  assert.deepEqual(normalizeRecruitExperienceFilter({
    start: "在校/应届",
    end: "10年以上"
  }), {
    mode: "custom",
    start_label: "在校/应届",
    end_label: "10年以上",
    start_value: 1,
    end_value: 12,
    label: "在校/应届-10年以上"
  });
  assert.deepEqual(normalizeRecruitExperienceFilter("3-10年"), {
    mode: "custom",
    start_label: "3年",
    end_label: "10年",
    start_value: 4,
    end_value: 11,
    label: "3年-10年"
  });
  assert.deepEqual(normalizeRecruitGenderFilter("female"), {
    label: "女",
    unlimited: false
  });
  assert.deepEqual(normalizeRecruitAgeFilter("30-35"), {
    mode: "option",
    label: "30-35",
    unlimited: false
  });
  assert.deepEqual(normalizeRecruitAgeFilter({ min: "25岁", max: "35岁" }), {
    mode: "custom",
    min: 25,
    max: 35,
    label: "25-35"
  });
  assert.deepEqual(normalizeRecruitAgeFilter("低于40"), {
    mode: "custom",
    min: null,
    max: 39,
    label: "不限-39"
  });
  assert.deepEqual(normalizeRecruitAgeFilter("40岁以下"), {
    mode: "custom",
    min: null,
    max: 40,
    label: "不限-40"
  });

  assert.deepEqual(buildRecruitJobTitleSearchTerms(
    "算法工程师 23-27届实习/校招/早期职业 _ 杭州"
  ), [
    "算法工程师 23-27届实习/校招/早期职业 _ 杭州",
    "算法工程师 23-27届实习/校招/早期职业 杭州",
    "算法工程师 23-27届实习/校招/早期职业",
  ]);

  const selected = chooseRecruitTextCandidate([
    { label: "不限", node_id: 1 },
    { label: "硕士", node_id: 2 },
    { label: "博士", node_id: 3 }
  ], {
    label: "硕士及以上",
    match: "prefix"
  });
  assert.equal(selected.node_id, 2);

  assert.equal(buildRecruitSchoolSearchLabels("985").includes("985院校"), true);
  assert.equal(buildRecruitSchoolSearchLabels("qs50").includes("QS 100"), true);
  assert.equal(buildRecruitSchoolSearchLabels("QS 100").includes("QS 100"), true);
  assert.equal(buildRecruitSchoolSearchLabels("qs50").includes("QS 500"), false);
  assert.equal(buildRecruitSchoolSearchLabels("qs101").includes("QS 500"), true);
  assert.deepEqual(buildRecruitSearchApplicationStepNames({
    job: "海外用户增长运营专家（AI产品） _ 上海",
    city: "上海",
    degree: "本科及以上",
    schools: ["985", "qs50"],
    experience: "5-10年",
    gender: "女",
    age: { min: 25, max: 35 },
    keyword: "用户运营",
    filter_recent_viewed: true
  }), ["job_title", "city", "degree", "schools", "experience", "gender", "age", "recent_viewed", "keyword", "search"]);
  const noJobSteps = buildRecruitSearchApplicationStepNames({
    city: "上海",
    keyword: "用户运营"
  });
  assert.equal(noJobSteps[0], "city");
  assert.equal(noJobSteps[noJobSteps.length - 2], "keyword");
  assert.equal(noJobSteps[noJobSteps.length - 1], "search");
}

function testExchangeResumeFilterStepNames() {
  assert.deepEqual(buildRecruitSearchApplicationStepNames({
    keyword: "三维重建",
    skip_recent_colleague_contacted: true
  }).slice(-3), ["exchange_resume", "keyword", "search"]);
  assert.deepEqual(buildRecruitSearchApplicationStepNames({
    keyword: "三维重建"
  }).slice(-2), ["keyword", "search"]);
  assert.equal(normalizeRecruitSearchParams({
    keyword: "三维重建",
    skip_recent_colleague_contacted: false
  }).skip_recent_colleague_contacted, false);

  const explicitColleagueFilter = parseRecruitInstruction({
    instruction: [
      "岗位：海外用户增长运营专家（AI产品） _ 上海",
      "关键词：用户运营",
      "城市：上海",
      "学历：本科及以上",
      "学校类型：不限",
      "只看未查看：不限",
      "同事近期触达：过滤",
      "目标筛选人数：3",
      "筛选条件：候选人需要有用户运营经验。"
    ].join("\n"),
    confirmation: {
      final_confirmed: true
    }
  });
  assert.equal(explicitColleagueFilter.searchParams.filter_recent_viewed, false);
  assert.equal(explicitColleagueFilter.searchParams.skip_recent_colleague_contacted, true);

  const explicitNoColleagueFilter = parseRecruitInstruction({
    instruction: [
      "岗位：海外用户增长运营专家（AI产品） _ 上海",
      "关键词：用户运营",
      "城市：上海",
      "学历：本科及以上",
      "学校类型：不限",
      "只看未查看：不限",
      "近期同事触达：不限",
      "目标筛选人数：3",
      "筛选条件：候选人需要有用户运营经验。"
    ].join("\n"),
    confirmation: {
      final_confirmed: true
    }
  });
  assert.equal(explicitNoColleagueFilter.searchParams.filter_recent_viewed, false);
  assert.equal(explicitNoColleagueFilter.searchParams.skip_recent_colleague_contacted, false);

  const semicolonPackedFields = parseRecruitInstruction({
    instruction: "岗位：海外用户增长运营专家（AI产品） _ 上海；城市：上海；学历：本科及以上；学校：985、211；关键词：用户运营，增长运营；同事近期触达：不限；目标筛选人数：3；筛选条件：候选人需要有用户运营经验。",
    confirmation: {
      final_confirmed: true
    }
  });
  assert.equal(semicolonPackedFields.searchParams.job, "海外用户增长运营专家（AI产品） _ 上海");
  assert.equal(semicolonPackedFields.searchParams.city, "上海");
  assert.equal(semicolonPackedFields.searchParams.degree, "本科及以上");
  assert.deepEqual(semicolonPackedFields.searchParams.schools, ["985院校", "211院校"]);
  assert.equal(semicolonPackedFields.searchParams.keyword, "用户运营，增长运营");
  assert.equal(semicolonPackedFields.searchParams.skip_recent_colleague_contacted, false);
}

function createExchangeResumeFilterClient({ allowClick = false } = {}) {
  const clicks = [];
  const fixture = {
    get clicks() {
      return clicks;
    },
    client: null
  };
  fixture.client = {
    DOM: {
      async querySelectorAll({ nodeId, selector }) {
        assert.equal(nodeId, 1);
        if (selector === 'label.checkbox.high_search_checkbox[ka="search_change_exchange_resume"]') {
          return { nodeIds: [44] };
        }
        return { nodeIds: [] };
      },
      async getAttributes({ nodeId }) {
        assert.equal(nodeId, 44);
        return {
          attributes: ["class", "checkbox high_search_checkbox checked", "ka", "search_change_exchange_resume"]
        };
      },
      async getOuterHTML({ nodeId }) {
        assert.equal(nodeId, 44);
        return {
          outerHTML: '<label class="checkbox high_search_checkbox checked" ka="search_change_exchange_resume"><span class="checkbox-text">近30天未和同事交换简历</span></label>'
        };
      },
      async scrollIntoViewIfNeeded() {
        if (!allowClick) throw new Error("already checked exchange-resume filter should not be clicked");
        return {};
      },
      async getBoxModel({ nodeId }) {
        assert.equal(nodeId, 44);
        return {
          model: {
            border: [10, 10, 110, 10, 110, 50, 10, 50]
          }
        };
      }
    },
    Input: {
      async dispatchMouseEvent(event) {
        if (event.type === "mouseReleased") clicks.push(event);
        return {};
      }
    }
  };
  return fixture;
}

async function testExchangeResumeFilterActiveDetection() {
  const fixture = createExchangeResumeFilterClient();
  const result = await setRecruitExchangeResumeFilter(fixture.client, 1, true);
  assert.equal(result.applied, true);
  assert.equal(result.requested, true);
  assert.equal(result.was_active, true);
  assert.equal(result.changed, false);
  assert.equal(result.selected_label, "近30天未和同事交换简历");
  assert.equal(fixture.clicks.length, 0);

  const clearFixture = createExchangeResumeFilterClient({ allowClick: true });
  const cleared = await setRecruitExchangeResumeFilter(clearFixture.client, 1, false);
  assert.equal(cleared.applied, true);
  assert.equal(cleared.requested, false);
  assert.equal(cleared.was_active, true);
  assert.equal(cleared.changed, true);
  assert.equal(clearFixture.clicks.length, 1);
}

async function testCardCandidateReader() {
  const client = {
    DOM: {
      async getAttributes() {
        return {
          attributes: ["data-jid", "jid_123", "data-geekid", "geek_456", "class", "geek-info-card"]
        };
      },
      async getOuterHTML() {
        return {
          outerHTML:
            '<a class="geek-info-card" data-jid="jid_123" data-geekid="geek_456">'
            + "<span>李四</span><span>硕士</span><span>机器学习算法工程师</span></a>"
        };
      }
    }
  };
  const candidate = await readRecruitCardCandidate(client, 7, {
    targetUrl: "https://www.zhipin.com/web/chat/search"
  });
  assert.equal(candidate.domain, "recruit");
  assert.equal(candidate.id, "geek_456");
  assert.equal(candidate.identity.degree, "硕士");
  assert.match(candidate.text.raw, /机器学习算法工程师/);
}

async function testRunServiceLifecycle() {
  const service = createRecruitRunService({
    idPrefix: "test_recruit",
    workflow: async (_options, runControl) => {
      runControl.setPhase("recruit:test");
      runControl.updateProgress({ processed: 1, screened: 1, passed: 1 });
      runControl.checkpoint({
        last_candidate: {
          id: "geek_456",
          identity: { degree: "硕士" },
          screening: { status: "pass", passed: true, score: 90 }
        }
      });
      return {
        domain: "recruit",
        processed: 1,
        screened: 1,
        detail_opened: 0,
        passed: 1,
        results: []
      };
    }
  });
  const started = service.startRecruitRun({
    client: { guarded: true },
    targetUrl: "https://www.zhipin.com/web/chat/search",
    criteria: "算法",
    maxCandidates: 1,
    detailLimit: 0
  });
  const final = await service.waitForRecruitRun(started.runId, { timeoutMs: 3000 });
  assert.equal(final.status, RUN_STATUS_COMPLETED);
  assert.equal(final.summary.domain, "recruit");
  assert.equal(final.progress.processed, 1);
}

async function testRecruitGreetQuotaClickGuard() {
  await assert.rejects(
    () => clickRecruitActionControl({}, {
      kind: "greet",
      label: "立即沟通(30/20)",
      node_id: 42
    }),
    (error) => error.code === GREET_CREDITS_EXHAUSTED_CODE
  );
}

function boxModelForRect(rect) {
  const { x, y, width, height } = rect;
  return {
    model: {
      border: [x, y, x + width, y, x + width, y + height, x, y + height]
    }
  };
}

async function testRecruitCardViewportGuardScrollsCardIntoView() {
  let cardY = 920;
  const wheelEvents = [];
  const scrollIntoViewCalls = [];
  const client = {
    Page: {
      async getLayoutMetrics() {
        return {
          cssVisualViewport: {
            clientWidth: 1000,
            clientHeight: 600
          }
        };
      }
    },
    DOM: {
      async scrollIntoViewIfNeeded({ nodeId }) {
        scrollIntoViewCalls.push(nodeId);
        return {};
      },
      async getBoxModel({ nodeId }) {
        assert.equal(nodeId, 42);
        return boxModelForRect({ x: 120, y: cardY, width: 520, height: 140 });
      }
    },
    Input: {
      async dispatchMouseEvent(params) {
        if (params.type === "mouseWheel") {
          wheelEvents.push(params);
          cardY -= params.deltaY;
        }
        return {};
      }
    }
  };

  const result = await ensureRecruitCardInViewport(client, 42, {
    settleMs: 0,
    maxScrollAttempts: 4
  });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(scrollIntoViewCalls[0], 42);
  assert.equal(wheelEvents.length > 0, true);
  assert.equal(result.attempts[0].in_viewport, false);
  assert.equal(result.attempts.at(-1).in_viewport, true);
}

function createRecruitJobDropdownClient() {
  let dropdownOpen = false;
  let currentNodeId = 12;
  const clicks = [];
  const optionRects = {
    10: { x: 120, y: 130, width: 460, height: 34 },
    11: { x: 120, y: 170, width: 460, height: 34 },
    12: { x: 120, y: 210, width: 460, height: 34 }
  };
  const labels = {
    10: "不限职位",
    11: "海外用户增长运营专家（AI产品） 上海 本科 5-10年 25-45K·14薪",
    12: "AI算法实习生 杭州 本科 在校/应届 150-200元/天"
  };
  return {
    get state() {
      return { dropdownOpen, currentNodeId, clicks };
    },
    client: {
      DOM: {
        async querySelectorAll(params) {
          const selector = params.selector || "";
          if (selector.includes("search_select_job") || selector.includes(".search-job-list-C li")) {
            return { nodeIds: [10, 11, 12] };
          }
          if (selector.includes(".search-job-list-C .ui-dropmenu")) {
            return { nodeIds: [2] };
          }
          return { nodeIds: [] };
        },
        async getAttributes(params) {
          if ([10, 11, 12].includes(params.nodeId)) {
            return {
              attributes: [
                "class",
                params.nodeId === currentNodeId ? "active" : "",
                "ka",
                "search_select_job"
              ]
            };
          }
          return { attributes: ["class", ""] };
        },
        async getOuterHTML(params) {
          if ([10, 11, 12].includes(params.nodeId)) {
            const active = params.nodeId === currentNodeId ? " active" : "";
            return { outerHTML: `<li class="${active}" ka="search_select_job">${labels[params.nodeId]}</li>` };
          }
          if (params.nodeId === 2) {
            return { outerHTML: `<div class="ui-dropmenu">AI算法实习生</div>` };
          }
          return { outerHTML: "<div></div>" };
        },
        async getBoxModel(params) {
          if (params.nodeId === 2) {
            return boxModelForRect({ x: 100, y: 80, width: 500, height: 40 });
          }
          if ([10, 11, 12].includes(params.nodeId)) {
            if (!dropdownOpen) throw new Error("Could not compute box model.");
            return boxModelForRect(optionRects[params.nodeId]);
          }
          throw new Error("Could not compute box model.");
        },
        async scrollIntoViewIfNeeded() {
          return {};
        }
      },
      Input: {
        async dispatchMouseEvent(params) {
          if (params.type !== "mouseReleased") return {};
          clicks.push({ x: params.x, y: params.y });
          if (params.y >= 80 && params.y <= 120) {
            dropdownOpen = true;
          }
          if (dropdownOpen && params.y >= 170 && params.y <= 204) {
            currentNodeId = 11;
            dropdownOpen = false;
          }
          return {};
        },
        async dispatchKeyEvent(params) {
          if (params.key === "Escape") dropdownOpen = false;
          return {};
        }
      }
    }
  };
}

async function testRecruitJobSelectionOpensVisibleDropdown() {
  const fixture = createRecruitJobDropdownClient();
  const result = await setRecruitJobTitle(
    fixture.client,
    1,
    "海外用户增长运营专家（AI产品） _ 上海",
    { optionTimeoutMs: 50 }
  );
  assert.equal(result.applied, true);
  assert.equal(result.clicked, true);
  assert.equal(result.sticky_verification.verified, true);
  assert.equal(result.opened_dropdown.visible_option_count, 3);
  assert.equal(fixture.state.currentNodeId, 11);
  assert.equal(fixture.state.clicks.some((click) => click.y >= 80 && click.y <= 120), true);
  assert.equal(fixture.state.clicks.some((click) => click.y >= 170 && click.y <= 204), true);
}

function createRecruitCityPickerClient() {
  let cityOpen = false;
  let typed = "";
  let selectedCity = "";
  const clicks = [];
  return {
    get state() {
      return { cityOpen, typed, selectedCity, clicks };
    },
    client: {
      DOM: {
        async querySelectorAll(params) {
          const selector = params.selector || "";
          if (selector.includes("input")) {
            return { nodeIds: [20] };
          }
          if (selector.includes(".city-wrap .city") || selector.includes(".city-wrap")) {
            return { nodeIds: [21] };
          }
          if (selector.includes(".search-result-C .search-result-item")) {
            return { nodeIds: cityOpen && typed ? [22] : [] };
          }
          return { nodeIds: [] };
        },
        async querySelector(params) {
          const result = await this.querySelectorAll(params);
          return { nodeId: result.nodeIds[0] || 0 };
        },
        async getAttributes() {
          return { attributes: ["class", ""] };
        },
        async getOuterHTML(params) {
          if (params.nodeId === 22) return { outerHTML: "<li>上海</li>" };
          if (params.nodeId === 21) return { outerHTML: "<div class=\"city\">城市</div>" };
          return { outerHTML: "<input>" };
        },
        async getBoxModel(params) {
          if (params.nodeId === 20) {
            if (!cityOpen) throw new Error("Could not compute box model.");
            return boxModelForRect({ x: 90, y: 60, width: 180, height: 32 });
          }
          if (params.nodeId === 21) return boxModelForRect({ x: 90, y: 60, width: 180, height: 42 });
          if (params.nodeId === 22) return boxModelForRect({ x: 90, y: 112, width: 120, height: 30 });
          throw new Error("Could not compute box model.");
        },
        async scrollIntoViewIfNeeded() {
          return {};
        }
      },
      Input: {
        async dispatchMouseEvent(params) {
          if (params.type !== "mouseReleased") return {};
          clicks.push({ x: params.x, y: params.y });
          if (params.y >= 60 && params.y <= 102) cityOpen = true;
          if (params.y >= 112 && params.y <= 142) selectedCity = "上海";
          return {};
        },
        async dispatchKeyEvent() {
          return {};
        },
        async insertText(params) {
          typed += params.text || "";
          return {};
        }
      }
    }
  };
}

async function testRecruitCitySelectionOpensVisiblePicker() {
  const fixture = createRecruitCityPickerClient();
  const result = await setRecruitCity(fixture.client, 1, "上海", {
    optionTimeoutMs: 50
  });
  assert.equal(result.applied, true);
  assert.equal(result.selected_label, "上海");
  assert.equal(fixture.state.cityOpen, true);
  assert.equal(fixture.state.typed, "上海");
  assert.equal(fixture.state.selectedCity, "上海");
  assert.equal(fixture.state.clicks.some((click) => click.y >= 60 && click.y <= 102), true);
}

function createRecruitSchoolFilterClient() {
  const labels = {
    30: "统招本科",
    31: "双一流院校",
    32: "211院校",
    33: "985院校",
    34: "留学生",
    35: "QS 100",
    36: "QS 500"
  };
  const itemIds = Object.keys(labels).map(Number);
  const active = new Set();
  const clicks = [];
  const itemIdForNode = (nodeId) => (nodeId >= 130 ? nodeId - 100 : nodeId);
  const rectForItem = (itemId) => ({
    x: 80,
    y: 100 + (itemId - 30) * 32,
    width: 140,
    height: 24
  });

  return {
    get state() {
      return { active: Array.from(active), clicks };
    },
    client: {
      DOM: {
        async querySelectorAll(params) {
          const selector = params.selector || "";
          if (selector.includes("school-item") || selector.includes("school")) {
            return { nodeIds: itemIds };
          }
          return { nodeIds: [] };
        },
        async querySelector(params) {
          if (itemIds.includes(params.nodeId)) return { nodeId: params.nodeId + 100 };
          return { nodeId: 0 };
        },
        async getAttributes(params) {
          const itemId = itemIdForNode(params.nodeId);
          return {
            attributes: ["class", active.has(itemId) ? "active checked" : ""]
          };
        },
        async getOuterHTML(params) {
          const itemId = itemIdForNode(params.nodeId);
          const label = labels[itemId] || "";
          const activeClass = active.has(itemId) ? " active checked" : "";
          if (params.nodeId >= 130) {
            return { outerHTML: `<label class="checkbox${activeClass}">${label}</label>` };
          }
          return { outerHTML: `<li class="school-item${activeClass}">${label}</li>` };
        },
        async getBoxModel(params) {
          const itemId = itemIdForNode(params.nodeId);
          if (!labels[itemId]) throw new Error("Could not compute box model.");
          return boxModelForRect(rectForItem(itemId));
        },
        async scrollIntoViewIfNeeded() {
          return {};
        }
      },
      Input: {
        async dispatchMouseEvent(params) {
          if (params.type !== "mouseReleased") return {};
          clicks.push({ x: params.x, y: params.y });
          const item = itemIds.find((itemId) => {
            const rect = rectForItem(itemId);
            return params.y >= rect.y && params.y <= rect.y + rect.height;
          });
          if (item) active.add(item);
          return {};
        }
      }
    }
  };
}

async function testRecruitSchoolSelectionUsesQsBuckets() {
  const qs50 = createRecruitSchoolFilterClient();
  const qs50Result = await setRecruitSchools(qs50.client, 1, ["qs50"]);
  assert.equal(qs50Result.selected[0].selected_label, "QS 100");
  assert.equal(qs50.state.active.includes(35), true);
  assert.equal(qs50.state.active.includes(36), false);

  const qs101 = createRecruitSchoolFilterClient();
  const qs101Result = await setRecruitSchools(qs101.client, 1, ["qs101"]);
  assert.equal(qs101Result.selected[0].selected_label, "QS 500");
  assert.equal(qs101.state.active.includes(36), true);
}

function createRecruitExperienceFilterClient({ hiddenValue = "1,7" } = {}) {
  const optionLabels = {
    90: "不限",
    91: "在校/应届",
    92: "25年毕业",
    93: "26年毕业",
    94: "26年后毕业",
    95: "1-3年",
    96: "3-5年",
    97: "5-10年"
  };
  const optionIds = Object.keys(optionLabels).map(Number);
  const active = new Set([90]);
  const clicks = [];
  let customClicked = false;
  let draggingHandle = null;
  let hidden = hiddenValue;
  const customRect = { x: 100, y: 350, width: 80, height: 24 };
  const trackRect = { x: 100, y: 410, width: 220, height: 24 };
  const optionRect = (nodeId) => ({
    x: 100 + ((nodeId - 90) % 4) * 90,
    y: 250 + Math.floor((nodeId - 90) / 4) * 34,
    width: 82,
    height: 24
  });
  const values = () => hidden.split(",").map((part) => Number.parseInt(part, 10));
  const setValue = (handleIndex, x) => {
    const current = values();
    const ratio = Math.min(1, Math.max(0, (x - trackRect.x) / trackRect.width));
    const nextValue = Math.min(12, Math.max(1, Math.round(ratio * 11) + 1));
    if (handleIndex === 0) current[0] = Math.min(nextValue, current[1]);
    if (handleIndex === 1) current[1] = Math.max(nextValue, current[0]);
    hidden = `${current[0]},${current[1]}`;
  };
  const handleRect = (handleIndex) => {
    const current = values();
    const value = current[handleIndex];
    const centerX = trackRect.x + trackRect.width * ((value - 1) / 11);
    return { x: centerX - 6, y: trackRect.y + 3, width: 12, height: 18 };
  };
  const rectContains = (rect, point) => (
    point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
  );

  return {
    get state() {
      return { hidden, customClicked, active: Array.from(active), clicks };
    },
    client: {
      DOM: {
        async querySelectorAll(params) {
          const selector = params.selector || "";
          if (selector.includes("input[type='hidden']")) return { nodeIds: [104] };
          if (selector.includes("ui-slider-button-wrap")) return { nodeIds: [102, 103] };
          if (selector.includes("ui-slider-wrap")) return { nodeIds: [101] };
          if (selector.includes("exp-item")) return { nodeIds: optionIds };
          if (selector.includes("custom")) return { nodeIds: [100] };
          return { nodeIds: [] };
        },
        async querySelector(params) {
          const result = await this.querySelectorAll(params);
          return { nodeId: result.nodeIds[0] || 0 };
        },
        async getAttributes(params) {
          if (optionLabels[params.nodeId]) {
            return { attributes: ["class", active.has(params.nodeId) ? "exp-item active" : "exp-item"] };
          }
          if (params.nodeId === 104) return { attributes: ["value", hidden] };
          return { attributes: ["class", ""] };
        },
        async getOuterHTML(params) {
          if (optionLabels[params.nodeId]) {
            const activeClass = active.has(params.nodeId) ? " active" : "";
            return { outerHTML: `<span class="exp-item${activeClass}">${optionLabels[params.nodeId]}</span>` };
          }
          if (params.nodeId === 100) return { outerHTML: "<span class=\"custom\">自定义</span>" };
          if (params.nodeId === 104) return { outerHTML: `<input type="hidden" value="${hidden}">` };
          return { outerHTML: "<div></div>" };
        },
        async getBoxModel(params) {
          if (optionLabels[params.nodeId]) return boxModelForRect(optionRect(params.nodeId));
          if (params.nodeId === 100) return boxModelForRect(customRect);
          if (params.nodeId === 101) return boxModelForRect(trackRect);
          if (params.nodeId === 102) return boxModelForRect(handleRect(0));
          if (params.nodeId === 103) return boxModelForRect(handleRect(1));
          throw new Error("Could not compute box model.");
        },
        async scrollIntoViewIfNeeded() {
          return {};
        }
      },
      Input: {
        async dispatchMouseEvent(params) {
          const point = { x: params.x, y: params.y };
          if (params.type === "mousePressed") {
            if (rectContains(handleRect(0), point)) draggingHandle = 0;
            if (rectContains(handleRect(1), point)) draggingHandle = 1;
            return {};
          }
          if (params.type !== "mouseReleased") return {};
          clicks.push({ x: params.x, y: params.y });
          if (draggingHandle !== null) {
            setValue(draggingHandle, params.x);
            draggingHandle = null;
            active.clear();
            return {};
          }
          if (rectContains(customRect, point)) {
            customClicked = true;
            return {};
          }
          const option = optionIds.find((nodeId) => rectContains(optionRect(nodeId), point));
          if (option) {
            active.clear();
            active.add(option);
          }
          return {};
        }
      }
    }
  };
}

async function testRecruitExperienceSelectionSupportsOptionsAndCustomRange() {
  const fixed = createRecruitExperienceFilterClient();
  const fixedResult = await setRecruitExperience(fixed.client, 1, "5-10年");
  assert.equal(fixedResult.applied, true);
  assert.equal(fixedResult.mode, "option");
  assert.equal(fixedResult.selected_label, "5-10年");
  assert.equal(fixed.state.active.includes(97), true);

  const custom = createRecruitExperienceFilterClient({ hiddenValue: "1,7" });
  const customResult = await setRecruitExperience(custom.client, 1, {
    start: "在校/应届",
    end: "10年以上"
  });
  assert.equal(customResult.applied, true);
  assert.equal(customResult.mode, "custom");
  assert.equal(custom.state.customClicked, true);
  assert.equal(custom.state.hidden, "1,12");
  assert.equal(customResult.verification.verified, true);
  assert.equal(customResult.verification.actual, "1,12");
}

function createRecruitGenderFilterClient({
  initialLabel = "性别",
  initialHiddenValue = "-1"
} = {}) {
  let open = false;
  let selectedLabel = initialLabel;
  let hiddenValue = initialHiddenValue;
  const clicks = [];
  const dropdownRects = {
    200: { x: 100, y: 300, width: 50, height: 30 },
    201: { x: 220, y: 300, width: 90, height: 30 }
  };
  const optionLabels = {
    210: "不限",
    211: "男",
    212: "女"
  };
  const optionRects = {
    210: { x: 100, y: 338, width: 90, height: 38 },
    211: { x: 100, y: 376, width: 90, height: 38 },
    212: { x: 100, y: 414, width: 90, height: 38 }
  };
  const rectContains = (rect, point) => (
    point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
  );
  return {
    get state() {
      return { open, selectedLabel, hiddenValue, clicks };
    },
    client: {
      DOM: {
        async querySelectorAll(params) {
          const selector = params.selector || "";
          if (selector.includes("gender-select")) return { nodeIds: [200, 201] };
          if (selector === "li" && params.nodeId === 200 && open) return { nodeIds: [210, 211, 212] };
          return { nodeIds: [] };
        },
        async querySelector(params) {
          const selector = params.selector || "";
          if (params.nodeId === 200 && selector.includes("input[type='hidden']")) return { nodeId: 213 };
          return { nodeId: 0 };
        },
        async getAttributes(params) {
          if (params.nodeId === 200) return { attributes: ["class", open ? "dropdown-wrap select gender-select dropdown-menu-open" : "dropdown-wrap select gender-select"] };
          if (params.nodeId === 201) return { attributes: ["class", "dropdown-wrap select gender-select"] };
          if (params.nodeId === 213) return { attributes: ["type", "hidden", "value", hiddenValue] };
          if (optionLabels[params.nodeId]) {
            return { attributes: ["class", optionLabels[params.nodeId] === selectedLabel ? "selected" : ""] };
          }
          return { attributes: ["class", ""] };
        },
        async getOuterHTML(params) {
          if (params.nodeId === 200) return { outerHTML: `<div class="gender-select"><span>${selectedLabel}</span><input type="hidden" value="${hiddenValue}"></div>` };
          if (params.nodeId === 201) return { outerHTML: "<div class=\"gender-select\"><span>牛人活跃度</span><input type=\"hidden\" value=\"0\"></div>" };
          if (optionLabels[params.nodeId]) return { outerHTML: `<li>${optionLabels[params.nodeId]}</li>` };
          return { outerHTML: "<div></div>" };
        },
        async getBoxModel(params) {
          if (dropdownRects[params.nodeId]) return boxModelForRect(dropdownRects[params.nodeId]);
          if (optionRects[params.nodeId]) return boxModelForRect(optionRects[params.nodeId]);
          throw new Error("Could not compute box model.");
        },
        async scrollIntoViewIfNeeded() {
          return {};
        }
      },
      Input: {
        async dispatchMouseEvent(params) {
          if (params.type !== "mouseReleased") return {};
          const point = { x: params.x, y: params.y };
          clicks.push(point);
          if (rectContains(dropdownRects[200], point)) {
            open = true;
            return {};
          }
          const option = Object.keys(optionRects).map(Number).find((nodeId) => rectContains(optionRects[nodeId], point));
          if (option) {
            selectedLabel = optionLabels[option];
            hiddenValue = selectedLabel === "不限" ? "-1" : selectedLabel === "男" ? "0" : "1";
            open = false;
          }
          return {};
        },
        async dispatchKeyEvent() {
          open = false;
          return {};
        }
      }
    }
  };
}

async function testRecruitGenderSelectionUsesVisibleDropdown() {
  const fixture = createRecruitGenderFilterClient();
  const result = await setRecruitGender(fixture.client, 1, "女");
  assert.equal(result.applied, true);
  assert.equal(result.selected_label, "女");
  assert.equal(result.verification.verified, true);
  assert.equal(fixture.state.selectedLabel, "女");
  assert.equal(fixture.state.hiddenValue, "1");

  const alreadyUnlimited = createRecruitGenderFilterClient({
    initialLabel: "不限",
    initialHiddenValue: "-1"
  });
  const unlimitedResult = await setRecruitGender(alreadyUnlimited.client, 1, "不限");
  assert.equal(unlimitedResult.applied, true);
  assert.equal(unlimitedResult.selected_label, "不限");
  assert.equal(unlimitedResult.verification.verified, true);
  assert.equal(alreadyUnlimited.state.selectedLabel, "不限");
}

function createRecruitAgeFilterClient({
  unlimitedValue = "0",
  includeHiddenDropdowns = false,
  hideVisibleDropdownWrappers = false
} = {}) {
  const optionLabels = {
    300: "不限",
    301: "20-25",
    302: "25-30",
    303: "30-35",
    304: "35-40",
    305: "40-50",
    306: "50以上"
  };
  const optionIds = Object.keys(optionLabels).map(Number);
  const active = new Set([300]);
  const clicks = [];
  let customVisible = false;
  let openDropdownIndex = null;
  let minValue = "0";
  let maxValue = "0";
  const customRect = { x: 700, y: 300, width: 70, height: 24 };
  const dropdownRects = {
    320: { x: 780, y: 300, width: 80, height: 24 },
    321: { x: 875, y: 300, width: 80, height: 24 }
  };
  const optionRect = (nodeId) => ({
    x: 100 + (nodeId - 300) * 70,
    y: 300,
    width: 60,
    height: 24
  });
  const ageOptionLabels = ["不限"];
  for (let age = 16; age <= 46; age += 1) ageOptionLabels.push(`${age}岁`);
  const ageOptionNodeIds = ageOptionLabels.map((_, index) => 400 + index);
  const ageOptionRect = (nodeId) => ({
    x: openDropdownIndex === 0 ? 780 : 875,
    y: 340 + (nodeId - 400) * 34,
    width: 86,
    height: 30
  });
  const rectContains = (rect, point) => (
    point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height
  );
  const ageValueForNode = (nodeId) => {
    const label = ageOptionLabels[nodeId - 400];
    return label === "不限" ? unlimitedValue : label.replace(/\D/g, "");
  };
  return {
    get state() {
      return { customVisible, openDropdownIndex, minValue, maxValue, active: Array.from(active), clicks };
    },
    client: {
      DOM: {
        async querySelectorAll(params) {
          const selector = params.selector || "";
          if (selector.includes("age-item")) return { nodeIds: optionIds };
          if (selector.includes(".age-select .custom") || selector.includes("[class*=\"age\"] [class*=\"custom\"]")) return { nodeIds: [310] };
          if (selector.includes("age-custom .dropdown-wrap")) {
            return { nodeIds: customVisible ? [
              ...(includeHiddenDropdowns ? [318, 319] : []),
              ...(hideVisibleDropdownWrappers ? [] : [320, 321])
            ] : [] };
          }
          if (selector.includes("age-custom input")) return { nodeIds: customVisible ? [330, 331, 332, 333] : [] };
          if (selector.includes("age-custom li")) return { nodeIds: openDropdownIndex === null ? [] : ageOptionNodeIds };
          return { nodeIds: [] };
        },
        async querySelector(params) {
          const result = await this.querySelectorAll(params);
          return { nodeId: result.nodeIds[0] || 0 };
        },
        async getAttributes(params) {
          if (optionLabels[params.nodeId]) {
            return { attributes: ["class", active.has(params.nodeId) ? "age-item active" : "age-item"] };
          }
          if (params.nodeId === 330 || params.nodeId === 332) {
            return { attributes: ["class", "ipt", "placeholder", "请选择", "type", "text"] };
          }
          if (params.nodeId === 331) return { attributes: ["type", "hidden", "value", minValue] };
          if (params.nodeId === 333) return { attributes: ["type", "hidden", "value", maxValue] };
          return { attributes: ["class", ""] };
        },
        async getOuterHTML(params) {
          if (optionLabels[params.nodeId]) {
            const activeClass = active.has(params.nodeId) ? " active" : "";
            return { outerHTML: `<span class="age-item${activeClass}">${optionLabels[params.nodeId]}</span>` };
          }
          if (params.nodeId === 310) return { outerHTML: "<span class=\"custom\">自定义</span>" };
          if (params.nodeId === 320) return { outerHTML: `<div class="dropdown-wrap select"><input class="ipt"><input type="hidden" value="${minValue}"></div>` };
          if (params.nodeId === 321) return { outerHTML: `<div class="dropdown-wrap select"><input class="ipt"><input type="hidden" value="${maxValue}"></div>` };
          if (params.nodeId === 330 || params.nodeId === 332) return { outerHTML: "<input class=\"ipt\" placeholder=\"请选择\" type=\"text\">" };
          if (params.nodeId === 331) return { outerHTML: `<input type="hidden" value="${minValue}">` };
          if (params.nodeId === 333) return { outerHTML: `<input type="hidden" value="${maxValue}">` };
          if (ageOptionNodeIds.includes(params.nodeId)) return { outerHTML: `<li>${ageOptionLabels[params.nodeId - 400]}</li>` };
          return { outerHTML: "<div></div>" };
        },
        async getBoxModel(params) {
          if (optionLabels[params.nodeId]) return boxModelForRect(optionRect(params.nodeId));
          if (params.nodeId === 310) return boxModelForRect(customRect);
          if (dropdownRects[params.nodeId]) return boxModelForRect(dropdownRects[params.nodeId]);
          if (params.nodeId === 330) return boxModelForRect(dropdownRects[320]);
          if (params.nodeId === 332) return boxModelForRect(dropdownRects[321]);
          if (ageOptionNodeIds.includes(params.nodeId)) return boxModelForRect(ageOptionRect(params.nodeId));
          throw new Error("Could not compute box model.");
        },
        async scrollIntoViewIfNeeded() {
          return {};
        }
      },
      Input: {
        async dispatchMouseEvent(params) {
          if (params.type !== "mouseReleased") return {};
          const point = { x: params.x, y: params.y };
          clicks.push(point);
          if (rectContains(customRect, point)) {
            customVisible = true;
            return {};
          }
          const fixed = optionIds.find((nodeId) => rectContains(optionRect(nodeId), point));
          if (fixed) {
            active.clear();
            active.add(fixed);
            return {};
          }
          if (customVisible && rectContains(dropdownRects[320], point)) {
            openDropdownIndex = 0;
            return {};
          }
          if (customVisible && rectContains(dropdownRects[321], point)) {
            openDropdownIndex = 1;
            return {};
          }
          const ageOption = ageOptionNodeIds.find((nodeId) => rectContains(ageOptionRect(nodeId), point));
          if (ageOption && openDropdownIndex !== null) {
            if (openDropdownIndex === 0) minValue = ageValueForNode(ageOption);
            if (openDropdownIndex === 1) maxValue = ageValueForNode(ageOption);
            active.clear();
            openDropdownIndex = null;
          }
          return {};
        }
      }
    }
  };
}

async function testRecruitAgeSelectionSupportsOptionsAndCustomRange() {
  const fixed = createRecruitAgeFilterClient();
  const fixedResult = await setRecruitAge(fixed.client, 1, "30-35");
  assert.equal(fixedResult.applied, true);
  assert.equal(fixedResult.mode, "option");
  assert.equal(fixedResult.selected_label, "30-35");
  assert.equal(fixed.state.active.includes(303), true);

  const custom = createRecruitAgeFilterClient();
  const customResult = await setRecruitAge(custom.client, 1, { min: 25, max: 35 });
  assert.equal(customResult.applied, true);
  assert.equal(customResult.mode, "custom");
  assert.equal(custom.state.customVisible, true);
  assert.equal(custom.state.minValue, "25");
  assert.equal(custom.state.maxValue, "35");
  assert.equal(customResult.verification.verified, true);
  assert.deepEqual(customResult.verification.actual, [25, 35]);

  const customWithHiddenDropdowns = createRecruitAgeFilterClient({ includeHiddenDropdowns: true });
  const hiddenDropdownResult = await setRecruitAge(customWithHiddenDropdowns.client, 1, { min: 25, max: 35 });
  assert.equal(hiddenDropdownResult.applied, true);
  assert.equal(hiddenDropdownResult.mode, "custom");
  assert.equal(customWithHiddenDropdowns.state.minValue, "25");
  assert.equal(customWithHiddenDropdowns.state.maxValue, "35");
  assert.deepEqual(
    hiddenDropdownResult.selected.map((item) => item.dropdown_node_id),
    [320, 321]
  );

  const customWithInputTriggers = createRecruitAgeFilterClient({
    includeHiddenDropdowns: true,
    hideVisibleDropdownWrappers: true
  });
  const inputTriggerResult = await setRecruitAge(customWithInputTriggers.client, 1, { min: 25, max: 35 });
  assert.equal(inputTriggerResult.applied, true);
  assert.equal(inputTriggerResult.mode, "custom");
  assert.equal(customWithInputTriggers.state.minValue, "25");
  assert.equal(customWithInputTriggers.state.maxValue, "35");
  assert.deepEqual(
    inputTriggerResult.selected.map((item) => item.dropdown_node_id),
    [330, 332]
  );

  const strictUpper = createRecruitAgeFilterClient({ unlimitedValue: "-1" });
  const strictUpperResult = await setRecruitAge(strictUpper.client, 1, "低于40");
  assert.equal(strictUpperResult.applied, true);
  assert.equal(strictUpperResult.mode, "custom");
  assert.equal(strictUpper.state.minValue, "-1");
  assert.equal(strictUpper.state.maxValue, "39");
  assert.equal(strictUpperResult.verification.verified, true);
  assert.deepEqual(strictUpperResult.verification.actual, [null, 39]);
}

function createRecruitKeywordInputClient() {
  let value = "用户增长";
  let focused = false;
  let selected = false;
  let searchClicks = 0;
  const clicks = [];
  return {
    get state() {
      return { value, focused, selected, searchClicks, clicks };
    },
    client: {
      DOM: {
        async querySelectorAll(params) {
          const selector = params.selector || "";
          if (selector.includes("input")) return { nodeIds: [70] };
          if (selector.includes("icon-search") || selector.includes("search-btn")) return { nodeIds: [80] };
          return { nodeIds: [] };
        },
        async getAttributes() {
          return { attributes: ["class", ""] };
        },
        async getOuterHTML(params) {
          if (params.nodeId === 70) return { outerHTML: "<input class=\"search-input\">" };
          if (params.nodeId === 80) return { outerHTML: "<i class=\"icon-search\"></i>" };
          return { outerHTML: "<div></div>" };
        },
        async getBoxModel(params) {
          if (params.nodeId === 70) return boxModelForRect({ x: 100, y: 60, width: 320, height: 36 });
          if (params.nodeId === 80) return boxModelForRect({ x: 430, y: 60, width: 60, height: 36 });
          throw new Error("Could not compute box model.");
        },
        async scrollIntoViewIfNeeded() {
          return {};
        }
      },
      Accessibility: {
        async getPartialAXTree(params) {
          assert.equal(params.nodeId, 70);
          return {
            nodes: [{
              role: { value: "textbox" },
              value: { value }
            }]
          };
        }
      },
      Input: {
        async dispatchMouseEvent(params) {
          if (params.type !== "mouseReleased") return {};
          clicks.push({ x: params.x, y: params.y });
          if (params.x >= 100 && params.x <= 420) {
            focused = true;
          }
          if (params.x >= 430 && params.x <= 490) {
            searchClicks += 1;
            if (searchClicks === 1) value = "用户增长";
          }
          return {};
        },
        async dispatchKeyEvent(params) {
          if (params.type !== "keyDown") return {};
          if (params.key === "a" && params.modifiers === 2) {
            selected = true;
          }
          if (params.key === "Backspace" && selected) {
            value = "";
            selected = false;
          }
          return {};
        },
        async insertText(params) {
          if (!focused) return {};
          if (selected) {
            value = params.text || "";
            selected = false;
          } else {
            value += params.text || "";
          }
          return {};
        }
      }
    }
  };
}

async function testRecruitKeywordGuardRetriesWhenSearchRewritesInput() {
  const fixture = createRecruitKeywordInputClient();
  const keyword = "用户运营，增长运营，国际化";
  const applied = await setRecruitKeyword(fixture.client, 1, keyword);
  assert.equal(applied.verification.verified, true);
  assert.equal((await readRecruitKeywordInputValue(fixture.client, 1)).value, keyword);

  const search = await clickRecruitSearchWithKeywordGuard(fixture.client, 1, keyword, {
    postSearchSettleMs: 0
  });
  assert.equal(search.keyword_guard.verified, true);
  assert.equal(search.keyword_guard.attempts.length, 2);
  assert.equal(search.keyword_guard.attempts[0].after.actual, "用户增长");
  assert.equal(search.keyword_guard.attempts[1].reapply.applied, true);
  assert.equal(fixture.state.searchClicks, 2);
  assert.equal(fixture.state.value, keyword);
}

function testRecruitRecoveryHelpers() {
  const refreshParams = buildRecruitRefreshSearchParams({
    keyword: "LLM",
    filter_recent_viewed: false
  });
  assert.equal(refreshParams.keyword, "LLM");
  assert.equal(refreshParams.filter_recent_viewed, true);
  assert.equal(
    isRecoverableRecruitDetailError(new Error("Could not find node with given id")),
    true
  );
  const unknownCaptureOutcome = new Error("WebSocket is not open: readyState 3 (CLOSED)");
  unknownCaptureOutcome.cdp_method = "Page.captureScreenshot";
  unknownCaptureOutcome.cdp_outcome_unknown = true;
  unknownCaptureOutcome.cdp_replay_suppressed = true;
  assert.equal(isRecoverableRecruitImageCaptureError(unknownCaptureOutcome), true);

  const counts = countRecruitResultStatuses([
    {
      screening: { passed: true },
      detail: { llm_screening: { status: "pass" }, image_evidence: { ok: true } }
    },
    {
      screening: { passed: false },
      detail: null,
      error: { code: "DETAIL_STALE_NODE" }
    },
    {
      screening: { passed: false },
      detail: { image_evidence: { ok: false, error_code: "IMAGE_CAPTURE_TIMEOUT" } },
      error: { code: "IMAGE_CAPTURE_TIMEOUT" }
    }
  ]);
  assert.equal(counts.processed, 3);
  assert.equal(counts.detail_opened, 2);
  assert.equal(counts.passed, 1);
  assert.equal(counts.llm_screened, 1);
  assert.equal(counts.detail_open_failed, 1);
  assert.equal(counts.image_capture_failed, 1);
  assert.equal(counts.transient_recovered, 2);
}

function testRecruitMissingCaptureTargetFailsClosed() {
  assert.equal(shouldFailClosedRecruitImageAcquisition({
    cv_acquisition: { source: "missing_capture_node" },
    image_evidence: null
  }), true);
  assert.equal(shouldFailClosedRecruitImageAcquisition({
    cv_acquisition: { source: "image_capture_failed" },
    image_evidence: null
  }), true);
  assert.equal(shouldFailClosedRecruitImageAcquisition({
    cv_acquisition: { source: "network" },
    image_evidence: null
  }), false);
}

function testRecruitTerminalImageFailureSuppressesDetailRestart() {
  assert.equal(isTerminalRecruitImageCaptureFailureSource("image_capture_failed"), true);
  assert.equal(isTerminalRecruitImageCaptureFailureSource("image"), false);
  assert.equal(shouldRetryRecruitDetailRecovery({
    recoveryCount: 0,
    imageCaptureTerminalFailure: false
  }), true);
  assert.equal(shouldRetryRecruitDetailRecovery({
    recoveryCount: 1,
    imageCaptureTerminalFailure: false
  }), false);
  assert.equal(shouldRetryRecruitDetailRecovery({
    recoveryCount: 0,
    imageCaptureTerminalFailure: true
  }), false);
}

testParserImportSemantics();
testNetworkPatterns();
await testRecruitAccountRightsPanelUsesSharedSafeClose();
testSearchParamHelpers();
testExchangeResumeFilterStepNames();
await testExchangeResumeFilterActiveDetection();
await testCardCandidateReader();
await testRecruitCardViewportGuardScrollsCardIntoView();
await testRunServiceLifecycle();
await testRecruitGreetQuotaClickGuard();
await testRecruitJobSelectionOpensVisibleDropdown();
await testRecruitCitySelectionOpensVisiblePicker();
await testRecruitSchoolSelectionUsesQsBuckets();
await testRecruitExperienceSelectionSupportsOptionsAndCustomRange();
await testRecruitGenderSelectionUsesVisibleDropdown();
await testRecruitAgeSelectionSupportsOptionsAndCustomRange();
await testRecruitKeywordGuardRetriesWhenSearchRewritesInput();
testRecruitRecoveryHelpers();
testRecruitMissingCaptureTargetFailsClosed();
testRecruitTerminalImageFailureSuppressesDetailRestart();

console.log("recruit domain tests passed");
