import assert from "node:assert/strict";
import { parseRecommendInstruction } from "./parser.js";

function testNeedConfirmationIncludesPostAction() {
  const result = parseRecommendInstruction({
    instruction: "推荐页上筛选985男生，近14天没有，有大模型平台经验，符合标准的收藏",
    confirmation: null,
    overrides: null
  });

  assert.deepEqual(result.searchParams.school_tag, ["985"]);
  assert.deepEqual(result.searchParams.degree, ["不限"]);
  assert.equal(result.searchParams.gender, "男");
  assert.equal(result.searchParams.recent_not_view, "近14天没有");
  assert.equal(result.screenParams.criteria, "有大模型平台经验");
  assert.equal(result.proposed_post_action, "favorite");
  assert.equal(result.needs_filters_confirmation, true);
  assert.equal(result.needs_school_tag_confirmation, true);
  assert.equal(result.needs_degree_confirmation, true);
  assert.equal(result.needs_gender_confirmation, true);
  assert.equal(result.needs_recent_not_view_confirmation, true);
  assert.equal(result.needs_criteria_confirmation, true);
  assert.equal(result.needs_post_action_confirmation, true);
}

function testConfirmedPostActionAndOverrides() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选女生，有多模态经历",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      school_tag_value: ["211"],
      degree_confirmed: true,
      degree_value: ["本科"],
      gender_confirmed: true,
      gender_value: "女",
      recent_not_view_confirmed: true,
      recent_not_view_value: "近14天没有",
      criteria_confirmed: true,
      target_count_confirmed: true,
      target_count_value: 12,
      post_action_confirmed: true,
      post_action_value: "greet",
      max_greet_count_confirmed: true,
      max_greet_count_value: 8
    },
    overrides: {
      school_tag: "211",
      degree: "本科",
      recent_not_view: "近14天没有",
      target_count: 12
    }
  });

  assert.deepEqual(result.searchParams.school_tag, ["211"]);
  assert.deepEqual(result.searchParams.degree, ["本科"]);
  assert.equal(result.searchParams.gender, "女");
  assert.equal(result.searchParams.recent_not_view, "近14天没有");
  assert.equal(result.screenParams.criteria, "有多模态经历");
  assert.equal(result.screenParams.target_count, 12);
  assert.equal(result.screenParams.post_action, "greet");
  assert.equal(result.screenParams.max_greet_count, 8);
  assert.equal(result.needs_filters_confirmation, false);
  assert.equal(result.needs_school_tag_confirmation, false);
  assert.equal(result.needs_degree_confirmation, false);
  assert.equal(result.needs_gender_confirmation, false);
  assert.equal(result.needs_recent_not_view_confirmation, false);
  assert.equal(result.needs_criteria_confirmation, false);
  assert.equal(result.needs_target_count_confirmation, false);
  assert.equal(result.needs_post_action_confirmation, false);
  assert.equal(result.needs_max_greet_count_confirmation, false);
}

function testMissingRecentNotViewValueShouldRequireReconfirmation() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985男生，近14天没有，有销售经验，符合标准收藏",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      school_tag_value: ["985"],
      degree_confirmed: true,
      degree_value: ["本科"],
      gender_confirmed: true,
      gender_value: "男",
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      target_count_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "favorite"
    },
    overrides: null
  });

  assert.equal(result.needs_recent_not_view_confirmation, true);
  assert.equal(result.pending_questions.some((q) => q.field === "recent_not_view"), true);
}

function testFilterConfirmedWithoutExplicitValuesShouldRequireReconfirmation() {
  const result = parseRecommendInstruction({
    instruction: "通过boss推荐skill帮我找人",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      target_count_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "favorite"
    },
    overrides: {
      criteria: "必须有至少3年工作经验，且做过算法"
    }
  });

  assert.deepEqual(result.searchParams.school_tag, ["不限"]);
  assert.deepEqual(result.searchParams.degree, ["不限"]);
  assert.equal(result.searchParams.gender, "不限");
  assert.equal(result.searchParams.recent_not_view, "不限");
  assert.equal(result.needs_school_tag_confirmation, true);
  assert.equal(result.needs_degree_confirmation, true);
  assert.equal(result.needs_gender_confirmation, true);
  assert.equal(result.needs_recent_not_view_confirmation, true);
  assert.equal(result.needs_filters_confirmation, true);
}

function testFilterConfirmedWithExplicitConfirmationValuesShouldNotFallbackToUnlimited() {
  const result = parseRecommendInstruction({
    instruction: "通过boss推荐skill帮我找人",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      school_tag_value: ["985", "211"],
      degree_confirmed: true,
      degree_value: ["大专", "本科", "硕士", "博士"],
      gender_confirmed: true,
      gender_value: "男",
      recent_not_view_confirmed: true,
      recent_not_view_value: "近14天没有",
      criteria_confirmed: true,
      target_count_confirmed: true,
      target_count_value: 3,
      post_action_confirmed: true,
      post_action_value: "favorite"
    },
    overrides: {
      criteria: "必须有至少3年工作经验，且做过算法"
    }
  });

  assert.deepEqual(result.searchParams.school_tag, ["985", "211"]);
  assert.deepEqual(result.searchParams.degree, ["大专", "本科", "硕士", "博士"]);
  assert.equal(result.searchParams.gender, "男");
  assert.equal(result.searchParams.recent_not_view, "近14天没有");
  assert.equal(result.needs_school_tag_confirmation, false);
  assert.equal(result.needs_degree_confirmation, false);
  assert.equal(result.needs_gender_confirmation, false);
  assert.equal(result.needs_recent_not_view_confirmation, false);
}

function testMultipleSchoolTagsMarkedSuspicious() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985和211，有推荐系统经验",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "favorite"
    },
    overrides: null
  });

  assert.deepEqual(result.searchParams.school_tag, ["985", "211"]);
  assert.deepEqual(result.searchParams.degree, ["不限"]);
  assert.equal(result.suspicious_fields.length, 0);
}

function testDegreeCanBeExtracted() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选本科女生，近14天没有，有大模型项目经验",
    confirmation: null,
    overrides: null
  });

  assert.deepEqual(result.searchParams.degree, ["本科"]);
}

function testDegreeAtOrAboveExpansion() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选大专及以上，近14天没有，有Agent经验",
    confirmation: null,
    overrides: null
  });

  assert.deepEqual(result.searchParams.degree, ["大专", "本科", "硕士", "博士"]);
}

function testDegreeShouldNotBeOverwrittenBySchoolTagUnlimitedClause() {
  const result = parseRecommendInstruction({
    instruction: "学校标签不限，学历要求大专及以上，性别不限，过滤近14天已看",
    confirmation: null,
    overrides: null
  });

  assert.deepEqual(result.searchParams.school_tag, ["不限"]);
  assert.deepEqual(result.searchParams.degree, ["大专", "本科", "硕士", "博士"]);
}

function testDegreeExplicitListOnly() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选大专、本科，近14天没有，有Agent经验",
    confirmation: null,
    overrides: null
  });

  assert.deepEqual(result.searchParams.degree, ["大专", "本科"]);
}

function testDegreeOverrideCanBeArray() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选本科，近14天没有，有Agent经验",
    confirmation: null,
    overrides: {
      degree: ["大专", "本科"]
    }
  });

  assert.deepEqual(result.searchParams.degree, ["大专", "本科"]);
}

function testSchoolTagOverrideCanBeArray() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985候选人，有算法经验",
    confirmation: null,
    overrides: {
      school_tag: ["985", "211"]
    }
  });

  assert.deepEqual(result.searchParams.school_tag, ["985", "211"]);
}

function testSchoolTagOverrideMixedValidAndInvalidShouldKeepValidOnes() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选候选人，有算法经验",
    confirmation: null,
    overrides: {
      school_tag: ["985", "211", "foo_tag"]
    }
  });

  assert.deepEqual(result.searchParams.school_tag, ["985", "211"]);
  assert.equal(result.suspicious_fields.some((item) => item.field === "school_tag"), true);
}

function testSchoolTagOverrideAllInvalidShouldFallbackToUnlimited() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选候选人，有算法经验",
    confirmation: null,
    overrides: {
      school_tag: ["abc", "foo"]
    }
  });

  assert.deepEqual(result.searchParams.school_tag, ["不限"]);
}

function testSchoolTagQsAliasShouldNormalizeToDomesticAndOverseasTop() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选候选人，有算法经验",
    confirmation: null,
    overrides: {
      school_tag: ["985", "QS前200"]
    }
  });

  assert.deepEqual(result.searchParams.school_tag, ["985", "国内外名校"]);
}

function testRecentNotViewSpacedOverrideShouldNormalize() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985男生，有算法经验",
    confirmation: null,
    overrides: {
      recent_not_view: "近 14 天没有"
    }
  });

  assert.equal(result.searchParams.recent_not_view, "近14天没有");
}

function testCriteriaCanBeProvidedViaOverrides() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选211女生",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      target_count_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "favorite"
    },
    overrides: {
      criteria: "候选人需要有 AI Agent 或 MCP 工具开发经验"
    }
  });

  assert.equal(result.missing_fields.length, 0);
  assert.equal(result.screenParams.criteria, "候选人需要有 AI Agent 或 MCP 工具开发经验");
}

function testMissingCriteriaTriggersNeedInput() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985男生",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      target_count_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "favorite"
    },
    overrides: null
  });

  assert.deepEqual(result.missing_fields, ["criteria"]);
  assert.equal(result.pending_questions.some((q) => q.field === "criteria"), true);
}

function testGreetNeedsMaxGreetCountConfirmation() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985男生，有大模型工程经验，符合标准直接沟通",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      target_count_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "greet"
    },
    overrides: null
  });

  assert.equal(result.screenParams.post_action, "greet");
  assert.equal(result.screenParams.max_greet_count, null);
  assert.equal(result.needs_max_greet_count_confirmation, true);
  assert.equal(result.pending_questions.some((q) => q.field === "max_greet_count"), true);
}

function testGreetMaxGreetCountCanComeFromOverrides() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985男生，有大模型工程经验，符合标准直接沟通",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      target_count_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "greet"
    },
    overrides: {
      max_greet_count: 5
    }
  });

  assert.equal(result.screenParams.post_action, "greet");
  assert.equal(result.screenParams.max_greet_count, null);
  assert.equal(result.needs_max_greet_count_confirmation, true);
}

function testGreetAutoFilledMaxGreetCountShouldRequireReconfirmation() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985男生，有大模型工程经验，目标3人，符合标准直接沟通",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      target_count_confirmed: true,
      target_count_value: 3,
      post_action_confirmed: true,
      post_action_value: "greet",
      max_greet_count_confirmed: true,
      max_greet_count_value: 3
    },
    overrides: null
  });

  assert.equal(result.screenParams.post_action, "greet");
  assert.equal(result.screenParams.max_greet_count, null);
  assert.equal(result.needs_max_greet_count_confirmation, true);
  assert.equal(result.pending_questions.some((q) => q.field === "max_greet_count"), true);
  assert.equal(result.suspicious_fields.some((item) => item.field === "max_greet_count"), true);
}

function testTargetCountNeedsConfirmationEvenWhenOptional() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985男生，有大模型平台经验，符合标准收藏",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "favorite"
    },
    overrides: null
  });

  assert.equal(result.needs_target_count_confirmation, true);
  assert.equal(result.pending_questions.some((q) => q.field === "target_count"), true);
}

function testTargetCountCanBeSkippedAfterConfirmation() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选985男生，有大模型平台经验，符合标准收藏",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
      criteria_confirmed: true,
      target_count_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "favorite"
    },
    overrides: null
  });

  assert.equal(result.needs_target_count_confirmation, false);
  assert.equal(result.screenParams.target_count, null);
}

function testPostActionNoneCanBeConfirmed() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选211女生，近14天没有，有AI经验，符合标准什么也不做",
    confirmation: {
      filters_confirmed: true,
      school_tag_confirmed: true,
      school_tag_value: ["211"],
      degree_confirmed: true,
      degree_value: ["本科"],
      gender_confirmed: true,
      gender_value: "女",
      recent_not_view_confirmed: true,
      recent_not_view_value: "近14天没有",
      criteria_confirmed: true,
      target_count_confirmed: true,
      post_action_confirmed: true,
      post_action_value: "none"
    },
    overrides: null
  });

  assert.equal(result.screenParams.post_action, "none");
  assert.equal(result.needs_post_action_confirmation, false);
}

function testJobSelectionHintCanComeFromOverrides() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选211女生，有算法经验，符合标准收藏",
    confirmation: null,
    overrides: {
      job: "算法工程师（视频/图像模型方向） _ 杭州"
    }
  });

  assert.equal(result.job_selection_hint, "算法工程师（视频/图像模型方向） _ 杭州");
}

function testMcpMentionShouldStayInCriteria() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选211女生，近14天没有，有 AI Agent 或 MCP 工具开发经验，符合标准的直接沟通",
    confirmation: null,
    overrides: null
  });

  assert.equal(result.screenParams.criteria, "有 AI Agent 或 MCP 工具开发经验");
}

function testFeaturedKeywordShouldProposeFeaturedPageScope() {
  const result = parseRecommendInstruction({
    instruction: "在推荐页精选里筛选候选人，有 Agent 经验，符合标准收藏",
    confirmation: null,
    overrides: null
  });

  assert.equal(result.proposed_page_scope, "featured");
  assert.equal(result.needs_page_confirmation, true);
  assert.equal(result.pending_questions.some((item) => item.field === "page_scope"), true);
}

function testClosedQuestionsShouldExposeStructuredOptions() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选候选人，有 Agent 经验，符合标准收藏",
    confirmation: null,
    overrides: null
  });
  const schoolTagQuestion = result.pending_questions.find((item) => item.field === "school_tag");
  const recentNotViewQuestion = result.pending_questions.find((item) => item.field === "recent_not_view");
  const filtersQuestion = result.pending_questions.find((item) => item.field === "filters");

  assert.equal(Boolean(schoolTagQuestion), true);
  assert.equal(Array.isArray(schoolTagQuestion.options), true);
  assert.equal(schoolTagQuestion.options.some((item) => item.value === "国内外名校"), true);
  assert.equal(schoolTagQuestion.options.every((item) => typeof item.label === "string" && typeof item.value === "string"), true);

  assert.equal(Boolean(recentNotViewQuestion), true);
  assert.equal(Array.isArray(recentNotViewQuestion.options), true);
  assert.equal(recentNotViewQuestion.options.some((item) => item.value === "近14天没有"), true);

  assert.equal(Boolean(filtersQuestion), true);
  assert.equal(Array.isArray(filtersQuestion.options), true);
  assert.equal(filtersQuestion.options.some((item) => item.value === "confirm"), true);
}

function testLatestKeywordShouldProposeLatestPageScope() {
  const result = parseRecommendInstruction({
    instruction: "在推荐页最新里筛选候选人，有 Agent 经验，符合标准收藏",
    confirmation: null,
    overrides: null
  });

  assert.equal(result.proposed_page_scope, "latest");
  assert.equal(result.needs_page_confirmation, true);
  const pageQuestion = result.pending_questions.find((item) => item.field === "page_scope");
  assert.equal(Boolean(pageQuestion), true);
  assert.equal(Array.isArray(pageQuestion.options), true);
  assert.equal(pageQuestion.options.some((item) => item.value === "latest"), true);
}

function testConfirmedPageScopeShouldBeResolved() {
  const result = parseRecommendInstruction({
    instruction: "在推荐页筛选候选人，有 Agent 经验，符合标准收藏",
    confirmation: {
      page_confirmed: true,
      page_value: "featured"
    },
    overrides: null
  });

  assert.equal(result.page_scope, "featured");
  assert.equal(result.needs_page_confirmation, false);
}

function testPageScopeOverrideShouldNotBypassConfirmation() {
  const result = parseRecommendInstruction({
    instruction: "在推荐页筛选候选人，有 Agent 经验，符合标准收藏",
    confirmation: null,
    overrides: {
      page_scope: "featured"
    }
  });

  assert.equal(result.proposed_page_scope, "featured");
  assert.equal(result.page_scope, null);
  assert.equal(result.needs_page_confirmation, true);
  assert.equal(result.pending_questions.some((item) => item.field === "page_scope"), true);
}

function main() {
  testNeedConfirmationIncludesPostAction();
  testConfirmedPostActionAndOverrides();
  testMissingRecentNotViewValueShouldRequireReconfirmation();
  testFilterConfirmedWithoutExplicitValuesShouldRequireReconfirmation();
  testFilterConfirmedWithExplicitConfirmationValuesShouldNotFallbackToUnlimited();
  testMultipleSchoolTagsMarkedSuspicious();
  testDegreeCanBeExtracted();
  testDegreeAtOrAboveExpansion();
  testDegreeShouldNotBeOverwrittenBySchoolTagUnlimitedClause();
  testDegreeExplicitListOnly();
  testDegreeOverrideCanBeArray();
  testSchoolTagOverrideCanBeArray();
  testSchoolTagOverrideMixedValidAndInvalidShouldKeepValidOnes();
  testSchoolTagOverrideAllInvalidShouldFallbackToUnlimited();
  testSchoolTagQsAliasShouldNormalizeToDomesticAndOverseasTop();
  testRecentNotViewSpacedOverrideShouldNormalize();
  testCriteriaCanBeProvidedViaOverrides();
  testMissingCriteriaTriggersNeedInput();
  testMcpMentionShouldStayInCriteria();
  testGreetNeedsMaxGreetCountConfirmation();
  testGreetMaxGreetCountCanComeFromOverrides();
  testGreetAutoFilledMaxGreetCountShouldRequireReconfirmation();
  testTargetCountNeedsConfirmationEvenWhenOptional();
  testTargetCountCanBeSkippedAfterConfirmation();
  testPostActionNoneCanBeConfirmed();
  testJobSelectionHintCanComeFromOverrides();
  testFeaturedKeywordShouldProposeFeaturedPageScope();
  testClosedQuestionsShouldExposeStructuredOptions();
  testLatestKeywordShouldProposeLatestPageScope();
  testConfirmedPageScopeShouldBeResolved();
  testPageScopeOverrideShouldNotBypassConfirmation();
  console.log("parser tests passed");
}

main();
