import assert from "node:assert/strict";
import { runRecommendPipeline } from "./pipeline.js";

const DEFAULT_JOB_OPTIONS = [
  {
    value: "job-data-analyst",
    title: "数据分析实习生 _ 杭州",
    label: "数据分析实习生 _ 杭州 100-150元/天",
    current: true
  },
  {
    value: "job-algorithm",
    title: "算法工程师（视频/图像模型方向） _ 杭州",
    label: "算法工程师（视频/图像模型方向） _ 杭州 25-50K",
    current: false
  }
];

function createJobListResult() {
  return {
    ok: true,
    jobs: DEFAULT_JOB_OPTIONS,
    structured: {
      status: "COMPLETED",
      result: {
        jobs: DEFAULT_JOB_OPTIONS
      }
    }
  };
}

function createJobConfirmedConfirmation() {
  return {
    job_confirmed: true,
    job_value: "数据分析实习生 _ 杭州",
    final_confirmed: true
  };
}

function createJobConfirmedWithoutFinalConfirmation() {
  return {
    job_confirmed: true,
    job_value: "数据分析实习生 _ 杭州"
  };
}

function createParsed(overrides = {}) {
  return {
    searchParams: {
      school_tag: ["985"],
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
    job_selection_hint: null,
    pending_questions: [],
    review: {},
    ...overrides
  };
}

async function testPauseRequestedBeforeScreenShouldReturnPaused() {
  let screenCalled = false;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => ({
        ok: true,
        summary: {
          candidate_count: 5,
          applied_filters: {},
          page_state: { state: "RECOMMEND_READY" }
        }
      }),
      runRecommendScreenCli: async () => {
        screenCalled = true;
        return { ok: true, summary: {} };
      }
    },
    {
      isPauseRequested: () => true
    }
  );

  assert.equal(result.status, "PAUSED");
  assert.equal(result.partial_result.completion_reason, "paused_before_screen");
  assert.equal(screenCalled, false);
}

async function testPausedScreenResultShouldBubbleUp() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      resume: {
        output_csv: "C:/temp/resume.csv",
        checkpoint_path: "C:/temp/checkpoint.json",
        pause_control_path: "C:/temp/run.json"
      }
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => ({ ok: true, summary: { candidate_count: 9, applied_filters: {} } }),
      runRecommendScreenCli: async () => ({
        ok: false,
        paused: true,
        summary: {
          processed_count: 3,
          passed_count: 1,
          skipped_count: 2,
          output_csv: "C:/temp/resume.csv",
          checkpoint_path: "C:/temp/checkpoint.json",
          completion_reason: "paused"
        }
      })
    }
  );

  assert.equal(result.status, "PAUSED");
  assert.equal(result.partial_result.output_csv, "C:/temp/resume.csv");
  assert.equal(result.partial_result.completion_reason, "paused");
}

async function testResumeFromScreenPauseShouldSkipSearch() {
  let searchCalled = false;
  let receivedResume = null;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      resume: {
        resume: true,
        output_csv: "C:/temp/resume.csv",
        checkpoint_path: "C:/temp/checkpoint.json",
        pause_control_path: "C:/temp/run.json",
        previous_completion_reason: "paused"
      }
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => {
        searchCalled = true;
        return { ok: true, summary: { candidate_count: 9, applied_filters: {} } };
      },
      runRecommendScreenCli: async ({ resume }) => {
        receivedResume = resume;
        return {
          ok: true,
          summary: {
            processed_count: 6,
            passed_count: 2,
            skipped_count: 4,
            output_csv: "C:/temp/resume.csv",
            completion_reason: "page_exhausted"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(searchCalled, false);
  assert.equal(receivedResume.resume, true);
  assert.equal(receivedResume.require_checkpoint, true);
  assert.equal(result.result.candidate_count, null);
}

async function testResumeFromPausedBeforeScreenShouldRerunSearch() {
  let searchCalled = false;
  let receivedResume = null;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      resume: {
        resume: true,
        output_csv: "C:/temp/resume.csv",
        checkpoint_path: "C:/temp/checkpoint.json",
        pause_control_path: "C:/temp/run.json",
        previous_completion_reason: "paused_before_screen"
      }
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => {
        searchCalled = true;
        return { ok: true, summary: { candidate_count: 9, applied_filters: { degree: ["本科"] } } };
      },
      runRecommendScreenCli: async ({ resume }) => {
        receivedResume = resume;
        return {
          ok: true,
          summary: {
            processed_count: 4,
            passed_count: 1,
            skipped_count: 3,
            output_csv: "C:/temp/resume.csv",
            completion_reason: "page_exhausted"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(searchCalled, true);
  assert.equal(receivedResume.resume, true);
  assert.equal(receivedResume.require_checkpoint, false);
  assert.equal(result.result.candidate_count, 9);
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
      confirmation: createJobConfirmedConfirmation(),
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async ({ searchParams, selectedJob }) => {
        calls.push({ type: "search", searchParams, selectedJob });
        return {
          ok: true,
          summary: {
            candidate_count: 18,
            applied_filters: searchParams,
            selected_job: {
              value: "job-data-analyst",
              title: "数据分析实习生 _ 杭州"
            },
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
  assert.equal(result.result.selected_job.title, "数据分析实习生 _ 杭州");
  assert.equal(calls[0].selectedJob, "job-data-analyst");
  assert.equal(calls[0].type, "search");
  assert.equal(calls[1].type, "screen");
}

async function testSearchFailure() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
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

async function testSearchNoIframeWithLoginShouldReturnLoginRequired() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({
        ok: false,
        debug_port: 9222,
        state: "LOGIN_REQUIRED",
        page_state: {
          state: "LOGIN_REQUIRED",
          expected_url: "https://www.zhipin.com/web/chat/recommend",
          current_url: "https://www.zhipin.com/web/user/?ka=bticket",
          login_url: "https://www.zhipin.com/web/user/?ka=bticket"
        }
      }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => ({
        ok: false,
        stdout: "",
        stderr: "NO_RECOMMEND_IFRAME",
        structured: null,
        error: {
          code: "NO_RECOMMEND_IFRAME",
          message: "NO_RECOMMEND_IFRAME"
        }
      }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "BOSS_LOGIN_REQUIRED");
  assert.equal(result.required_user_action, "prepare_boss_recommend_page");
  assert.equal(result.guidance.agent_prompt.includes("https://www.zhipin.com/web/user/?ka=bticket"), true);
}

async function testJobTriggerNotFoundShouldMapToLoginRequiredWhenRecheckShowsLogin() {
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
      ensureBossRecommendPageReady: async () => ({
        ok: false,
        debug_port: 9222,
        state: "LOGIN_REQUIRED",
        page_state: {
          state: "LOGIN_REQUIRED",
          expected_url: "https://www.zhipin.com/web/chat/recommend",
          current_url: "https://www.zhipin.com/web/user/?ka=bticket",
          login_url: "https://www.zhipin.com/web/user/?ka=bticket"
        }
      }),
      listRecommendJobs: async () => ({
        ok: false,
        stdout: "",
        stderr: "",
        structured: null,
        jobs: [],
        error: {
          code: "JOB_TRIGGER_NOT_FOUND",
          message: "JOB_TRIGGER_NOT_FOUND"
        }
      }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "BOSS_LOGIN_REQUIRED");
  assert.equal(result.required_user_action, "prepare_boss_recommend_page");
  assert.equal(result.guidance.agent_prompt.includes("https://www.zhipin.com/web/user/?ka=bticket"), true);
}

async function testNeedJobConfirmationGate() {
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
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "NEED_CONFIRMATION");
  assert.equal(result.required_confirmations.includes("job"), true);
  assert.equal(result.pending_questions.some((item) => item.field === "job"), true);
  assert.equal(Array.isArray(result.job_options), true);
  assert.equal(result.job_options.length, 2);
}

async function testNeedFinalReviewConfirmationGate() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedWithoutFinalConfirmation(),
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "NEED_CONFIRMATION");
  assert.equal(result.required_confirmations.includes("final_review"), true);
  assert.equal(result.pending_questions.some((item) => item.field === "final_review"), true);
}

async function testLoginRequiredShouldReturnGuidance() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9555 }),
      ensureBossRecommendPageReady: async () => ({
        ok: false,
        debug_port: 9555,
        state: "LOGIN_REQUIRED",
        page_state: {
          state: "LOGIN_REQUIRED",
          expected_url: "https://www.zhipin.com/web/chat/recommend",
          current_url: "https://www.zhipin.com/web/geek/job",
          login_url: "https://www.zhipin.com/web/user/?ka=bticket"
        }
      }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "BOSS_LOGIN_REQUIRED");
  assert.equal(result.required_user_action, "prepare_boss_recommend_page");
  assert.equal(result.guidance.debug_port, 9555);
  assert.equal(result.guidance.expected_url, "https://www.zhipin.com/web/chat/recommend");
  assert.equal(result.guidance.agent_prompt.includes("9555"), true);
  assert.equal(result.guidance.agent_prompt.includes("https://www.zhipin.com/web/user/?ka=bticket"), true);
  assert.equal(result.guidance.agent_prompt.includes("已就绪"), true);
}

async function testDebugPortUnreachableShouldReturnConnectionCode() {
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
      ensureBossRecommendPageReady: async () => ({
        ok: false,
        debug_port: 9222,
        state: "DEBUG_PORT_UNREACHABLE",
        page_state: {
          state: "DEBUG_PORT_UNREACHABLE",
          expected_url: "https://www.zhipin.com/web/chat/recommend",
          current_url: null
        }
      }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "BOSS_CHROME_NOT_CONNECTED");
  assert.equal(result.required_user_action, "prepare_boss_recommend_page");
  assert.equal(result.guidance.agent_prompt.includes("--remote-debugging-port=9222"), true);
}

async function testPreflightRecoveryPlanOrder() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: "C:/workspace/boss-recommend-mcp",
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({
        ok: false,
        debug_port: 9222,
        checks: [
          { key: "node_cli", ok: false },
          { key: "npm_dep_ws", ok: false, install_cwd: "C:/workspace/boss-recommend-mcp" },
          { key: "python_cli", ok: false },
          { key: "python_pillow", ok: false }
        ]
      }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "PIPELINE_PREFLIGHT_FAILED");
  assert.deepEqual(
    result.diagnostics.recovery.ordered_steps.map((item) => item.id),
    ["install_nodejs", "install_npm_dependencies", "install_python", "install_pillow"]
  );
  assert.deepEqual(result.diagnostics.recovery.ordered_steps[1].blocked_by, ["install_nodejs"]);
  assert.deepEqual(result.diagnostics.recovery.ordered_steps[3].blocked_by, ["install_python"]);
  assert.equal(result.diagnostics.recovery.agent_prompt.includes("不要并行跳步"), true);
}

async function testPreflightAutoRepairCanUnblockPipeline() {
  let repairCalled = false;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({
        ok: false,
        debug_port: 9222,
        checks: [{ key: "npm_dep_ws", ok: false, install_cwd: process.cwd() }]
      }),
      attemptPipelineAutoRepair: () => {
        repairCalled = true;
        return {
          attempted: true,
          actions: [{ ok: true, action: "install_npm_dependencies" }],
          preflight: { ok: true, debug_port: 9222, checks: [] }
        };
      },
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => ({ ok: true, summary: { candidate_count: 1, applied_filters: {} } }),
      runRecommendScreenCli: async () => ({ ok: true, summary: { processed_count: 1, passed_count: 1, skipped_count: 0 } })
    }
  );

  assert.equal(repairCalled, true);
  assert.equal(result.status, "COMPLETED");
}

async function testPreflightAutoRepairStillFailShouldExposeDiagnostics() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({
        ok: false,
        debug_port: 9222,
        checks: [{ key: "node_cli", ok: false }]
      }),
      attemptPipelineAutoRepair: () => ({
        attempted: true,
        actions: [{ ok: false, action: "install_npm_dependencies" }],
        preflight: {
          ok: false,
          debug_port: 9222,
          checks: [{ key: "node_cli", ok: false }]
        }
      }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "PIPELINE_PREFLIGHT_FAILED");
  assert.equal(result.diagnostics.auto_repair.attempted, true);
}

async function testScreenConfigFailureShouldRequireUserProvidedConfig() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({
        ok: false,
        debug_port: 9222,
        checks: [
          {
            key: "screen_config",
            ok: false,
            path: "C:/Users/test/.boss-recommend-mcp/screening-config.json",
            reason: "MISSING_REQUIRED_FIELDS",
            message: "screening-config.json 缺失或格式无效"
          }
        ]
      }),
      attemptPipelineAutoRepair: () => ({
        attempted: false,
        actions: [],
        preflight: {
          ok: false,
          debug_port: 9222,
          checks: [
            {
              key: "screen_config",
              ok: false,
              path: "C:/Users/test/.boss-recommend-mcp/screening-config.json",
              reason: "MISSING_REQUIRED_FIELDS",
              message: "screening-config.json 缺失或格式无效"
            }
          ]
        }
      }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "PIPELINE_PREFLIGHT_FAILED");
  assert.equal(result.required_user_action, "provide_screening_config");
  assert.equal(result.guidance.config_path.includes("screening-config.json"), true);
  assert.equal(result.guidance.config_dir.includes(".boss-recommend-mcp"), true);
  assert.equal(result.guidance.agent_prompt.includes("baseUrl"), true);
  assert.equal(result.guidance.agent_prompt.includes("apiKey"), true);
  assert.equal(result.guidance.agent_prompt.includes("model"), true);
}

async function testScreenConfigPlaceholderShouldRequireUserConfirmationAfterUpdate() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({
        ok: false,
        debug_port: 9222,
        checks: [
          {
            key: "screen_config",
            ok: false,
            path: "C:/Users/test/workspace/config/screening-config.json",
            reason: "PLACEHOLDER_API_KEY",
            message: "screening-config.json 的 apiKey 仍是模板占位符，请填写真实 API Key。"
          }
        ]
      }),
      attemptPipelineAutoRepair: () => ({
        attempted: false,
        actions: [],
        preflight: {
          ok: false,
          debug_port: 9222,
          checks: [
            {
              key: "screen_config",
              ok: false,
              path: "C:/Users/test/workspace/config/screening-config.json",
              reason: "PLACEHOLDER_API_KEY",
              message: "screening-config.json 的 apiKey 仍是模板占位符，请填写真实 API Key。"
            }
          ]
        }
      }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "PIPELINE_PREFLIGHT_FAILED");
  assert.equal(result.required_user_action, "confirm_screening_config_updated");
  assert.equal(result.guidance.config_dir, "C:/Users/test/workspace/config");
  assert.equal(result.guidance.agent_prompt.includes("已修改完成"), true);
}

async function testScreenConfigRecoveryStepShouldBeFirst() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: "C:/workspace/boss-recommend-mcp",
      instruction: "test",
      confirmation: {},
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({
        ok: false,
        debug_port: 9222,
        checks: [
          {
            key: "screen_config",
            ok: false,
            path: "C:/Users/test/.boss-recommend-mcp/screening-config.json",
            message: "screening-config.json 缺失或格式无效"
          },
          { key: "node_cli", ok: false }
        ]
      }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      runRecommendSearchCli: async () => ({ ok: true, summary: {} }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.diagnostics.recovery.ordered_steps[0].id, "fill_screening_config");
}

async function main() {
  await testPauseRequestedBeforeScreenShouldReturnPaused();
  await testPausedScreenResultShouldBubbleUp();
  await testResumeFromScreenPauseShouldSkipSearch();
  await testResumeFromPausedBeforeScreenShouldRerunSearch();
  await testNeedConfirmationGate();
  await testNeedSchoolTagConfirmationGate();
  await testNeedTargetCountConfirmationGate();
  await testNeedMaxGreetCountConfirmationGate();
  await testNeedInputGate();
  await testNeedJobConfirmationGate();
  await testNeedFinalReviewConfirmationGate();
  await testCompletedPipeline();
  await testSearchFailure();
  await testSearchNoIframeWithLoginShouldReturnLoginRequired();
  await testJobTriggerNotFoundShouldMapToLoginRequiredWhenRecheckShowsLogin();
  await testLoginRequiredShouldReturnGuidance();
  await testDebugPortUnreachableShouldReturnConnectionCode();
  await testPreflightRecoveryPlanOrder();
  await testPreflightAutoRepairCanUnblockPipeline();
  await testPreflightAutoRepairStillFailShouldExposeDiagnostics();
  await testScreenConfigFailureShouldRequireUserProvidedConfig();
  await testScreenConfigPlaceholderShouldRequireUserConfirmationAfterUpdate();
  await testScreenConfigRecoveryStepShouldBeFirst();
  console.log("pipeline tests passed");
}

await main();
