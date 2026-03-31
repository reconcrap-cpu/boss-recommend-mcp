import assert from "node:assert/strict";
import { runRecommendPipeline } from "./pipeline.js";

function createParsed(overrides = {}) {
  return {
    searchParams: {
      school_tag: "985",
      degree: ["本科"],
      gender: "男",
      recent_not_view: "近14天没有"
    },
    screenParams: {
      criteria: "候选人需要有大模型平台经验",
      target_count: 10,
      post_action: "favorite",
      max_greet_count: null
    },
    missing_fields: [],
    suspicious_fields: [],
    needs_filters_confirmation: false,
    needs_school_tag_confirmation: false,
    needs_degree_confirmation: false,
    needs_gender_confirmation: false,
    needs_recent_not_view_confirmation: false,
    needs_criteria_confirmation: false,
    needs_target_count_confirmation: false,
    needs_post_action_confirmation: false,
    needs_max_greet_count_confirmation: false,
    proposed_post_action: "favorite",
    proposed_max_greet_count: null,
    pending_questions: [],
    review: {},
    ...overrides
  };
}

async function testNeedConfirmationGate() {
  let preflightCalled = false;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed({ needs_post_action_confirmation: true }),
      runPipelinePreflight: () => {
        preflightCalled = true;
        return { ok: true, checks: [], debug_port: 9222 };
      },
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "NEED_CONFIRMATION");
  assert.equal(preflightCalled, false);
}

async function testNeedTargetCountConfirmationGate() {
  let preflightCalled = false;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed({
        needs_target_count_confirmation: true,
        pending_questions: [{ field: "target_count" }]
      }),
      runPipelinePreflight: () => {
        preflightCalled = true;
        return { ok: true, checks: [], debug_port: 9222 };
      },
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "NEED_CONFIRMATION");
  assert.equal(result.required_confirmations.includes("target_count"), true);
  assert.equal(preflightCalled, false);
}

async function testNeedSchoolTagConfirmationGate() {
  let preflightCalled = false;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed({
        needs_school_tag_confirmation: true,
        pending_questions: [{ field: "school_tag" }]
      }),
      runPipelinePreflight: () => {
        preflightCalled = true;
        return { ok: true, checks: [], debug_port: 9222 };
      },
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "NEED_CONFIRMATION");
  assert.equal(result.required_confirmations.includes("school_tag"), true);
  assert.equal(preflightCalled, false);
}

async function testNeedMaxGreetCountConfirmationGate() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed({
        screenParams: {
          criteria: "候选人需要有大模型平台经验",
          target_count: 10,
          post_action: "greet",
          max_greet_count: null
        },
        needs_max_greet_count_confirmation: true,
        proposed_post_action: "greet",
        proposed_max_greet_count: null,
        pending_questions: [{ field: "max_greet_count" }]
      }),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "NEED_CONFIRMATION");
  assert.equal(result.required_confirmations.includes("max_greet_count"), true);
}

async function testNeedInputGate() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed({ missing_fields: ["criteria"] }),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "NEED_INPUT");
}

async function testCompletedPipeline() {
  const calls = [];
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } }),
      runRecommendSearchCli: async ({ searchParams }) => {
        calls.push({ type: "search", searchParams });
        return {
          ok: true,
          summary: {
            candidate_count: 18,
            applied_filters: searchParams,
            page_state: { state: "RECOMMEND_READY" }
          }
        };
      },
      runRecommendScreenCli: async ({ screenParams }) => {
        calls.push({ type: "screen", screenParams });
        return {
          ok: true,
          summary: {
            processed_count: 10,
            passed_count: 3,
            skipped_count: 7,
            output_csv: "C:/temp/result.csv",
            completion_reason: "page_exhausted"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.candidate_count, 18);
  assert.equal(result.result.processed_count, 10);
  assert.equal(result.result.passed_count, 3);
  assert.equal(result.result.post_action, "favorite");
  assert.deepEqual(result.result.applied_filters.degree, ["本科"]);
  assert.equal(calls[0].type, "search");
  assert.equal(calls[1].type, "screen");
}

async function testSearchFailure() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({
        ok: false,
        stdout: "",
        stderr: "boom",
        structured: null,
        error: {
          code: "RECOMMEND_FILTER_PANEL_UNAVAILABLE",
          message: "筛选面板不可用。"
        }
      }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "RECOMMEND_FILTER_PANEL_UNAVAILABLE");
}

async function main() {
  await testNeedConfirmationGate();
  await testNeedSchoolTagConfirmationGate();
  await testNeedTargetCountConfirmationGate();
  await testNeedMaxGreetCountConfirmationGate();
  await testNeedInputGate();
  await testCompletedPipeline();
  await testSearchFailure();
  console.log("pipeline tests passed");
}

await main();
