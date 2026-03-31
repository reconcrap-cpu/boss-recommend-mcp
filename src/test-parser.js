import assert from "node:assert/strict";
import { parseRecommendInstruction } from "./parser.js";

function testNeedConfirmationIncludesPostAction() {
  const result = parseRecommendInstruction({
    instruction: "推荐页上筛选985男生，近14天没有，有大模型平台经验，符合标准的收藏",
    confirmation: null,
    overrides: null
  });

  assert.equal(result.searchParams.school_tag, "985");
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
      degree_confirmed: true,
      gender_confirmed: true,
      recent_not_view_confirmed: true,
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

  assert.equal(result.searchParams.school_tag, "211");
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

  assert.equal(result.searchParams.school_tag, "985");
  assert.deepEqual(result.searchParams.degree, ["不限"]);
  assert.equal(result.suspicious_fields.length, 1);
  assert.equal(result.suspicious_fields[0].field, "school_tag");
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
  assert.equal(result.screenParams.max_greet_count, 5);
  assert.equal(result.needs_max_greet_count_confirmation, false);
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

function testMcpMentionShouldStayInCriteria() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选211女生，近14天没有，有 AI Agent 或 MCP 工具开发经验，符合标准的直接沟通",
    confirmation: null,
    overrides: null
  });

  assert.equal(result.screenParams.criteria, "有 AI Agent 或 MCP 工具开发经验");
}

function main() {
  testNeedConfirmationIncludesPostAction();
  testConfirmedPostActionAndOverrides();
  testMultipleSchoolTagsMarkedSuspicious();
  testDegreeCanBeExtracted();
  testDegreeAtOrAboveExpansion();
  testDegreeExplicitListOnly();
  testDegreeOverrideCanBeArray();
  testCriteriaCanBeProvidedViaOverrides();
  testMissingCriteriaTriggersNeedInput();
  testMcpMentionShouldStayInCriteria();
  testGreetNeedsMaxGreetCountConfirmation();
  testGreetMaxGreetCountCanComeFromOverrides();
  testTargetCountNeedsConfirmationEvenWhenOptional();
  testTargetCountCanBeSkippedAfterConfirmation();
  console.log("parser tests passed");
}

main();
