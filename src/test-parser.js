import assert from "node:assert/strict";
import { normalizeActivityLevel, parseRecommendInstruction } from "./parser.js";

const REPRODUCTION_INSTRUCTION = `启动boss推荐任务。条件如下：

页面选择：推荐；
学校标签：985/211/国内外名校；
学历：本科及以上；
性别：不限；
是否过滤近14天看过：近14天没有；
目标筛选数：152；
通过筛选后动作：打招呼；
最大招呼数：152；
岗位：研发工程师（AI应用方向）-2026届校招 _ 杭州；
筛选条件：需同时满足全部条件：1）如果有本科学历，本科学历必须为 211 及以上或 QS 前 500 海外院校；2）至少一段学历为 985、QS 前 100 海外院校或中科院；3）具备大模型 / AI / 图形学 / 计算机视觉 / 3D相关的算法或工程经验（实习、项目、科研均可）。学校是否是985、211、qs排名等判断如果简历内没有明确标明，需要通过学校名称来判断；4）必须是25年应届生或者26年应届生或者27年应届生，除了标签以外需要通过人选最高学历的求学年份判断（比如：本科简历里写了2021 - 2025，应该理解为25年毕业，属于25年应届生）；5）年龄必须35岁以内。`;

function testFavoriteInstructionRequiresPostActionChoice() {
  const result = parseRecommendInstruction({
    instruction: "推荐页上筛选985男生，近14天没有，有大模型平台经验，符合标准的收藏",
    confirmation: null,
    overrides: null
  });

  assert.deepEqual(result.searchParams.school_tag, ["985"]);
  assert.deepEqual(result.searchParams.degree, ["不限"]);
  assert.equal(result.searchParams.gender, "男");
  assert.equal(result.searchParams.recent_not_view, "近14天没有");
  assert.equal(result.searchParams.current_city_only, false);
  assert.equal(result.searchParams.activity_level, "不限");
  assert.equal(result.screenParams.criteria, "有大模型平台经验");
  assert.equal(result.proposed_post_action, null);
  assert.equal(result.needs_filters_confirmation, false);
  assert.equal(result.needs_school_tag_confirmation, false);
  assert.equal(result.needs_degree_confirmation, false);
  assert.equal(result.needs_gender_confirmation, false);
  assert.equal(result.needs_recent_not_view_confirmation, false);
  assert.equal(result.needs_criteria_confirmation, false);
  assert.equal(result.needs_post_action_confirmation, true);
  const postActionQuestion = result.pending_questions.find((item) => item.field === "post_action");
  assert.equal(Boolean(postActionQuestion), true);
  assert.equal(postActionQuestion.options.some((item) => item.value === "favorite"), false);
  assert.equal(postActionQuestion.options.some((item) => item.value === "greet"), true);
  assert.equal(postActionQuestion.options.some((item) => item.value === "none"), true);
}

function testOptionalCityAndActivityOverridesAndDefaults() {
  const defaults = parseRecommendInstruction({
    instruction: "推荐页筛选候选人，要求有算法经验",
    confirmation: null,
    overrides: null
  });
  assert.equal(defaults.searchParams.current_city_only, false);
  assert.equal(defaults.searchParams.activity_level, "不限");
  assert.equal(defaults.pending_questions.some((item) => item.field === "current_city_only"), false);
  assert.equal(defaults.pending_questions.some((item) => item.field === "activity_level"), false);

  const activityLevels = ["不限", "刚刚活跃", "今日活跃", "3日内活跃", "本周活跃", "本月活跃"];
  for (const activityLevel of activityLevels) {
    const result = parseRecommendInstruction({
      instruction: "推荐页筛选候选人，要求有算法经验",
      confirmation: null,
      overrides: {
        current_city_only: true,
        activity_level: activityLevel
      }
    });
    assert.equal(result.searchParams.current_city_only, true);
    assert.equal(result.searchParams.activity_level, activityLevel);
    assert.equal(result.suspicious_fields.length, 0);
  }

  const spaced = parseRecommendInstruction({
    instruction: "current_city_only，推荐页筛选候选人，要求有算法经验",
    confirmation: null,
    overrides: { activity_level: "3 日内活跃" }
  });
  assert.equal(spaced.searchParams.current_city_only, true);
  assert.equal(spaced.searchParams.activity_level, "3日内活跃");
}

function testOptionalCityAndActivityInstructionAliasesStayOutOfCriteria() {
  const structuredInstruction = `页面：推荐
筛选条件：必须有算法工程经验
current_city_only：true
活跃度：今日活跃
岗位：算法工程师`;
  for (const instruction of [structuredInstruction, structuredInstruction.replace(/\s+/g, " ")]) {
    const structured = parseRecommendInstruction({
      instruction,
      confirmation: null,
      overrides: null
    });
    assert.equal(structured.searchParams.current_city_only, true);
    assert.equal(structured.searchParams.activity_level, "今日活跃");
    assert.equal(structured.screenParams.criteria, "必须有算法工程经验");
    assert.equal(structured.screenParams.criteria.includes("current_city_only"), false);
    assert.equal(structured.screenParams.criteria.includes("活跃度"), false);
  }

  const natural = parseRecommendInstruction({
    instruction: "仅推荐期望城市为本城市的牛人，选择本月活跃。筛选条件：必须有多模态项目经验",
    confirmation: null,
    overrides: null
  });
  assert.equal(natural.searchParams.current_city_only, true);
  assert.equal(natural.searchParams.activity_level, "本月活跃");
  assert.equal(natural.screenParams.criteria, "必须有多模态项目经验");

  for (const instruction of [
    "取消仅推荐期望城市为本城市的牛人，筛选条件：必须有算法经验",
    "关闭仅推荐期望城市为本城市的牛人，筛选条件：必须有算法经验"
  ]) {
    const disabled = parseRecommendInstruction({
      instruction,
      confirmation: null,
      overrides: null
    });
    assert.equal(disabled.searchParams.current_city_only, false);
    assert.equal(disabled.screenParams.criteria, "必须有算法经验");
  }
}

function testActivityIntentNormalizationAndFallback() {
  const normalizationCases = [
    ["刚上线", "刚刚活跃"],
    ["active now", "刚刚活跃"],
    ["过去 2 小时", "刚刚活跃"],
    ["高活跃", "刚刚活跃"],
    ["非常活跃", "刚刚活跃"],
    ["high activity", "刚刚活跃"],
    ["very active", "刚刚活跃"],
    ["今天活跃", "今日活跃"],
    ["active today", "今日活跃"],
    ["过去 6 小时", "今日活跃"],
    ["今曰活跃", "今日活跃"],
    ["todai active", "今日活跃"],
    ["昨天活跃", "3日内活跃"],
    ["last 3 days", "3日内活跃"],
    ["最近五天", "本周活跃"],
    ["this week", "本周活跃"],
    ["本舟活跃", "本周活跃"],
    ["中等活跃", "本周活跃"],
    ["一般活跃", "本周活跃"],
    ["medium activity", "本周活跃"],
    ["moderately active", "本周活跃"],
    ["近20天", "本月活跃"],
    ["this month", "本月活跃"],
    ["低活跃", "本月活跃"],
    ["偶尔活跃", "本月活跃"],
    ["low activity", "本月活跃"],
    ["occasionally active", "本月活跃"],
    ["no preference", "不限"],
    ["不限", "不限"],
    ["不限或今日活跃", "不限"],
    ["不限制或本周活跃", "不限"],
    ["无要求但本月活跃", "不限"],
    ["活跃一点", "不限"],
    ["本活跃", "不限"],
    ["today or this week", "不限"],
    ["本周还是本月", "不限"],
    ["非常活跃或偶尔活跃", "不限"],
    ["very active or occasionally active", "不限"],
    ["high or low activity", "不限"],
    ["low or medium activity", "不限"],
    ["not high activity", "本月活跃"],
    ["blue pineapple", "不限"],
    ["", "不限"]
  ];
  for (const [input, expected] of normalizationCases) {
    assert.equal(normalizeActivityLevel(input), expected, input);
    const parsed = parseRecommendInstruction({
      instruction: "推荐页筛选候选人，筛选条件：必须有算法经验",
      confirmation: { final_confirmed: true },
      overrides: { activity_level: input }
    });
    assert.equal(parsed.searchParams.activity_level, expected, input);
    assert.equal(parsed.suspicious_fields.some((item) => item.field === "activity_level"), false, input);
    assert.equal(parsed.screenParams.criteria, "必须有算法经验", input);
  }

  const durationBoundaryCases = [
    ["1 day", "今日活跃"],
    ["2 days", "3日内活跃"],
    ["4 days", "3日内活跃"],
    ["5 days", "本周活跃"],
    ["7 days", "本周活跃"],
    ["10 days", "本周活跃"],
    ["18 days", "本周活跃"],
    ["19 days", "本月活跃"],
    ["20 days", "本月活跃"],
    ["30 days", "本月活跃"],
    ["2 weeks", "本周活跃"],
    ["3 weeks", "本月活跃"]
  ];
  for (const [input, expected] of durationBoundaryCases) {
    assert.equal(normalizeActivityLevel(input), expected, `duration boundary: ${input}`);
  }

  const structuredCases = [
    ["activity level：active today；筛选条件：必须有算法经验", "今日活跃"],
    ["活跃度：昨天活跃；筛选条件：必须有算法经验", "3日内活跃"],
    ["活跃度：blue pineapple；筛选条件：必须有算法经验", "不限"],
    ["活跃度：；筛选条件：必须有算法经验", "不限"]
  ];
  for (const [instruction, expected] of structuredCases) {
    const parsed = parseRecommendInstruction({
      instruction,
      confirmation: { final_confirmed: true },
      overrides: null
    });
    assert.equal(parsed.searchParams.activity_level, expected, instruction);
    assert.equal(parsed.suspicious_fields.some((item) => item.field === "activity_level"), false, instruction);
    assert.equal(parsed.screenParams.criteria, "必须有算法经验", instruction);
  }

  const naturalCases = [
    ["只看最近五天活跃的人，必须有算法经验", "本周活跃", "必须有算法经验"],
    ["active within the last three days, must have algorithm experience", "3日内活跃", "must have algorithm experience"],
    ["active in the last week, must have algorithm experience", "本周活跃", "must have algorithm experience"]
  ];
  for (const [instruction, expected, expectedCriteria] of naturalCases) {
    const natural = parseRecommendInstruction({
      instruction,
      confirmation: null,
      overrides: null
    });
    assert.equal(natural.searchParams.activity_level, expected, instruction);
    assert.equal(natural.screenParams.criteria, expectedCriteria, instruction);
  }

  const overrideWins = parseRecommendInstruction({
    instruction: "活跃度：今日活跃；筛选条件：必须有算法经验",
    confirmation: null,
    overrides: { activity_level: "past week" }
  });
  assert.equal(overrideWins.searchParams.activity_level, "本周活跃");

  const explicitUnknownOverrideWinsWithSafeDefault = parseRecommendInstruction({
    instruction: "活跃度：今日活跃；筛选条件：必须有算法经验",
    confirmation: null,
    overrides: { activity_level: "blue pineapple" }
  });
  assert.equal(explicitUnknownOverrideWinsWithSafeDefault.searchParams.activity_level, "不限");
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

function testMissingRecentNotViewValueCanBeRecoveredFromInstruction() {
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
      post_action_value: "none"
    },
    overrides: null
  });

  assert.equal(result.searchParams.recent_not_view, "近14天没有");
  assert.equal(result.needs_recent_not_view_confirmation, false);
  assert.equal(result.pending_questions.some((q) => q.field === "recent_not_view"), false);
}

function testDefaultFilterValuesDoNotRequireFieldConfirmation() {
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
      post_action_value: "none"
    },
    overrides: {
      criteria: "必须有至少3年工作经验，且做过算法"
    }
  });

  assert.deepEqual(result.searchParams.school_tag, ["不限"]);
  assert.deepEqual(result.searchParams.degree, ["不限"]);
  assert.equal(result.searchParams.gender, "不限");
  assert.equal(result.searchParams.recent_not_view, "不限");
  assert.equal(result.needs_school_tag_confirmation, false);
  assert.equal(result.needs_degree_confirmation, false);
  assert.equal(result.needs_gender_confirmation, false);
  assert.equal(result.needs_recent_not_view_confirmation, false);
  assert.equal(result.needs_filters_confirmation, false);
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
      post_action_value: "none"
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
      post_action_value: "none"
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
      post_action_value: "none"
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
      post_action_value: "none"
    },
    overrides: null
  });

  assert.deepEqual(result.missing_fields, ["criteria"]);
  assert.equal(result.pending_questions.some((q) => q.field === "criteria"), true);
}

function testGreetDoesNotNeedMaxGreetCountConfirmation() {
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
  assert.equal(result.needs_max_greet_count_confirmation, false);
  assert.equal(result.pending_questions.some((q) => q.field === "max_greet_count"), false);
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
  assert.equal(result.pending_questions.some((q) => q.field === "max_greet_count"), false);
}

function testGreetAutoFilledMaxGreetCountIsHandledByFinalReview() {
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
      post_action_value: "greet"
    },
    overrides: {
      max_greet_count: 3
    }
  });

  assert.equal(result.screenParams.post_action, "greet");
  assert.equal(result.screenParams.max_greet_count, 3);
  assert.equal(result.needs_max_greet_count_confirmation, false);
  assert.equal(result.pending_questions.some((q) => q.field === "max_greet_count"), false);
  assert.equal(result.suspicious_fields.some((item) => item.field === "max_greet_count"), false);
}

function testGreetMaxGreetCountEqualTargetShouldPassAfterExplicitConfirmation() {
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
  assert.equal(result.screenParams.max_greet_count, 3);
  assert.equal(result.needs_max_greet_count_confirmation, false);
  assert.equal(result.pending_questions.some((q) => q.field === "max_greet_count"), false);
}

function testTargetCountCanBeReviewedWithoutFieldConfirmation() {
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
      post_action_value: "none"
    },
    overrides: null
  });

  assert.equal(result.needs_target_count_confirmation, false);
  assert.equal(result.pending_questions.some((q) => q.field === "target_count"), false);
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
      post_action_value: "none"
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
  assert.equal(result.needs_page_confirmation, false);
  assert.equal(result.pending_questions.some((item) => item.field === "page_scope"), false);
}

function testMissingPostActionShouldExposeStructuredOptions() {
  const result = parseRecommendInstruction({
    instruction: "推荐页筛选候选人，有 Agent 经验",
    confirmation: null,
    overrides: null
  });
  const postActionQuestion = result.pending_questions.find((item) => item.field === "post_action");

  assert.equal(Boolean(postActionQuestion), true);
  assert.equal(Array.isArray(postActionQuestion.options), true);
  assert.equal(postActionQuestion.options.some((item) => item.value === "favorite"), false);
  assert.equal(postActionQuestion.options.some((item) => item.value === "greet"), true);
  assert.equal(postActionQuestion.options.some((item) => item.value === "none"), true);
}

function testLatestKeywordShouldProposeLatestPageScope() {
  const result = parseRecommendInstruction({
    instruction: "在推荐页最新里筛选候选人，有 Agent 经验，符合标准收藏",
    confirmation: null,
    overrides: null
  });

  assert.equal(result.proposed_page_scope, "latest");
  assert.equal(result.needs_page_confirmation, false);
  const pageQuestion = result.pending_questions.find((item) => item.field === "page_scope");
  assert.equal(Boolean(pageQuestion), false);
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
  assert.equal(result.needs_page_confirmation, false);
  assert.equal(result.pending_questions.some((item) => item.field === "page_scope"), false);
}

function testExplicitCriteriaBlockShouldKeepAllCoreRulesAndExcludeMetaFields() {
  const result = parseRecommendInstruction({
    instruction: REPRODUCTION_INSTRUCTION,
    confirmation: null,
    overrides: null
  });
  const criteria = result.screenParams.criteria || "";

  assert.equal(criteria.includes("需同时满足全部条件"), true);
  assert.equal(criteria.includes("1）如果有本科学历，本科学历必须为 211 及以上或 QS 前 500 海外院校"), true);
  assert.equal(criteria.includes("2）至少一段学历为 985、QS 前 100 海外院校或中科院"), true);
  assert.equal(criteria.includes("3）具备大模型 / AI / 图形学 / 计算机视觉 / 3D相关的算法或工程经验"), true);
  assert.equal(criteria.includes("4）必须是25年应届生或者26年应届生或者27年应届生"), true);
  assert.equal(criteria.includes("5）年龄必须35岁以内"), true);

  assert.equal(criteria.includes("页面选择"), false);
  assert.equal(criteria.includes("目标筛选数"), false);
  assert.equal(criteria.includes("通过筛选后动作"), false);
  assert.equal(criteria.includes("最大招呼数"), false);
  assert.equal(criteria.includes("岗位"), false);
}

function testOpenClawInstructionShouldPreferLlmCriteriaOverPageFilters() {
  const instruction = `启动Boss推荐页筛选任务。

页面筛选条件：
- 学历：博士
- 学校标签：985 / 211 / 双一流院校 / 国内外名校
- 性别：不限
- 近14天已看过的人选：不限

LLM筛选条件，必须同时满足全部条件：

1）学历/科研门槛必须满足：至少一段学历为985、QS前300海外院校、中科院，或211/双一流院校相关专业。
2）履历中必须能看到多模态大模型、视频生成、世界模型或3D重建方向的研究经历。

目标人数：200
通过动作：打招呼
岗位：科研算法实习生（3D重建与生成）-可转正 _ 杭州`;
  const result = parseRecommendInstruction({
    instruction,
    confirmation: { final_confirmed: true },
    overrides: null
  });
  const criteria = result.screenParams.criteria || "";

  assert.notEqual(criteria, "-");
  assert.equal(criteria.includes("1）学历/科研门槛必须满足"), true);
  assert.equal(criteria.includes("2）履历中必须能看到多模态大模型"), true);
  assert.equal(criteria.includes("页面筛选条件"), false);
  assert.equal(criteria.includes("学历：博士"), false);
  assert.equal(result.criteria_normalized.includes("QS前300"), true);
}

function testCriteriaPlaceholderShouldRemainMissing() {
  for (const criteria of ["-", "—", "暂无", "none"]) {
    const result = parseRecommendInstruction({
      instruction: `启动Boss推荐任务\n筛选标准：${criteria}`,
      confirmation: { final_confirmed: true },
      overrides: { criteria }
    });

    assert.equal(result.screenParams.criteria, null, criteria);
    assert.equal(result.missing_fields.includes("criteria"), true, criteria);
  }
}

function testFallbackCriteriaShouldStillWorkWithoutExplicitMarker() {
  const result = parseRecommendInstruction({
    instruction: "页面选择：推荐；学校标签：985/211；岗位：算法工程师；候选人需满足至少两段 AI 项目经验；最大招呼数：20；",
    confirmation: null,
    overrides: null
  });
  const criteria = result.screenParams.criteria || "";

  assert.equal(criteria.includes("至少两段 AI 项目经验"), true);
  assert.equal(criteria.includes("页面选择"), false);
  assert.equal(criteria.includes("岗位"), false);
  assert.equal(criteria.includes("最大招呼数"), false);
}

function testOverrideCriteriaShouldHaveHighestPriorityOverExplicitCriteriaBlock() {
  const result = parseRecommendInstruction({
    instruction: REPRODUCTION_INSTRUCTION,
    confirmation: null,
    overrides: {
      criteria: "只看有开源 Agent 项目经验的人选"
    }
  });

  assert.equal(result.screenParams.criteria, "只看有开源 Agent 项目经验的人选");
}

function testFallbackCriteriaShouldNotDropReal985211QsRules() {
  const result = parseRecommendInstruction({
    instruction: "页面选择：推荐；目标筛选数：10；至少一段学历为985或QS前100海外院校；如果有本科学历，本科必须211或QS前500；岗位：算法工程师；",
    confirmation: null,
    overrides: null
  });
  const criteria = result.screenParams.criteria || "";

  assert.equal(criteria.includes("985"), true);
  assert.equal(criteria.includes("QS前100"), true);
  assert.equal(criteria.includes("211"), true);
  assert.equal(criteria.includes("QS前500"), true);
}

function testMetaHintsShouldBeProposedFromInstruction() {
  const result = parseRecommendInstruction({
    instruction: `页面选择：推荐；目标筛选数：5；通过筛选后动作：打招呼；最大招呼数：3；岗位：研发工程师（AI应用方向）-2026届校招 _ 杭州；筛选条件：需同时满足全部条件：1）具备AI经验；`,
    confirmation: null,
    overrides: null
  });

  assert.equal(result.proposed_page_scope, "recommend");
  assert.equal(result.proposed_target_count, 5);
  assert.equal(result.proposed_post_action, "greet");
  assert.equal(result.proposed_max_greet_count, 3);
  assert.equal(result.job_selection_hint, "研发工程师（AI应用方向）-2026届校招 _ 杭州");
  assert.equal(result.screenParams.target_count, null);
  assert.equal(result.screenParams.post_action, null);
  assert.equal(result.screenParams.max_greet_count, 3);
}

function main() {
  testFavoriteInstructionRequiresPostActionChoice();
  testOptionalCityAndActivityOverridesAndDefaults();
  testOptionalCityAndActivityInstructionAliasesStayOutOfCriteria();
  testActivityIntentNormalizationAndFallback();
  testConfirmedPostActionAndOverrides();
  testMissingRecentNotViewValueCanBeRecoveredFromInstruction();
  testDefaultFilterValuesDoNotRequireFieldConfirmation();
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
  testGreetDoesNotNeedMaxGreetCountConfirmation();
  testGreetMaxGreetCountCanComeFromOverrides();
  testGreetAutoFilledMaxGreetCountIsHandledByFinalReview();
  testGreetMaxGreetCountEqualTargetShouldPassAfterExplicitConfirmation();
  testTargetCountCanBeReviewedWithoutFieldConfirmation();
  testTargetCountCanBeSkippedAfterConfirmation();
  testPostActionNoneCanBeConfirmed();
  testJobSelectionHintCanComeFromOverrides();
  testFeaturedKeywordShouldProposeFeaturedPageScope();
  testMissingPostActionShouldExposeStructuredOptions();
  testLatestKeywordShouldProposeLatestPageScope();
  testConfirmedPageScopeShouldBeResolved();
  testPageScopeOverrideShouldNotBypassConfirmation();
  testExplicitCriteriaBlockShouldKeepAllCoreRulesAndExcludeMetaFields();
  testOpenClawInstructionShouldPreferLlmCriteriaOverPageFilters();
  testCriteriaPlaceholderShouldRemainMissing();
  testFallbackCriteriaShouldStillWorkWithoutExplicitMarker();
  testOverrideCriteriaShouldHaveHighestPriorityOverExplicitCriteriaBlock();
  testFallbackCriteriaShouldNotDropReal985211QsRules();
  testMetaHintsShouldBeProposedFromInstruction();
  console.log("parser tests passed");
}

main();
