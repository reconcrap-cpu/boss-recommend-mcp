import assert from "node:assert/strict";
import { runRecommendPipeline as runRecommendPipelineImpl } from "./pipeline.js";

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
    page_confirmed: true,
    page_value: "recommend",
    job_confirmed: true,
    job_value: "数据分析实习生 _ 杭州",
    final_confirmed: true
  };
}

function createJobConfirmedWithoutFinalConfirmation() {
  return {
    page_confirmed: true,
    page_value: "recommend",
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
    needs_page_confirmation: false,
    page_scope: "recommend",
    proposed_page_scope: "recommend",
    proposed_post_action: "favorite",
    proposed_max_greet_count: null,
    job_selection_hint: null,
    pending_questions: [],
    review: {},
    ...overrides
  };
}

function createBasePipelineDeps(overrides = {}) {
  return {
    readRecommendTabState: async () => ({
      ok: true,
      active_status: "0",
      active_tab_status: "0"
    }),
    switchRecommendTab: async () => ({
      ok: true,
      state: "TAB_READY",
      after_state: {
        active_status: "0",
        active_tab_status: "0"
      }
    }),
    ...overrides
  };
}

async function runRecommendPipeline(args, dependencies = {}, runtime = null) {
  return runRecommendPipelineImpl(args, createBasePipelineDeps(dependencies), runtime);
}

function createFollowUpChat(overrides = {}) {
  return {
    chat: {
      criteria: "有 AI Agent 经验",
      start_from: "unread",
      target_count: 5,
      ...overrides
    }
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

async function testConsecutiveResumeCaptureFailuresShouldRefreshAndRerunSearchWithForcedRecentFilter() {
  const searchCalls = [];
  const screenCalls = [];
  let reloadCalls = 0;
  let pageReadyCalls = 0;
  const parsed = createParsed();
  parsed.searchParams = {
    ...parsed.searchParams,
    recent_not_view: "不限"
  };
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      resume: {
        resume: false,
        output_csv: "C:/temp/resume.csv",
        checkpoint_path: "C:/temp/checkpoint.json",
        pause_control_path: "C:/temp/run.json",
        previous_completion_reason: ""
      }
    },
    {
      parseRecommendInstruction: () => parsed,
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => {
        pageReadyCalls += 1;
        return { ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } };
      },
      listRecommendJobs: async () => createJobListResult(),
      reloadBossRecommendPage: async () => {
        reloadCalls += 1;
        return {
          ok: true,
          state: "RECOMMEND_READY",
          reloaded_url: "https://www.zhipin.com/web/chat/recommend"
        };
      },
      runRecommendSearchCli: async ({ searchParams, selectedJob }) => {
        searchCalls.push({
          searchParams,
          selectedJob
        });
        return {
          ok: true,
          summary: {
            candidate_count: 9,
            applied_filters: searchParams,
            selected_job: selectedJob,
            page_state: { state: "RECOMMEND_READY" }
          }
        };
      },
      runRecommendScreenCli: async ({ resume }) => {
        screenCalls.push(resume);
        if (screenCalls.length === 1) {
          return {
            ok: false,
            error: {
              code: "RESUME_CAPTURE_FAILED_CONSECUTIVE_LIMIT",
              message: "连续 10 位候选人截图失败"
            },
            summary: {
              processed_count: 216,
              passed_count: 83,
              skipped_count: 133,
              output_csv: "C:/temp/resume.csv"
            }
          };
        }
        return {
          ok: true,
          summary: {
            processed_count: 240,
            passed_count: 90,
            skipped_count: 150,
            output_csv: "C:/temp/resume.csv",
            completion_reason: "page_exhausted"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(searchCalls.length, 2);
  assert.equal(searchCalls[0].searchParams.recent_not_view, "不限");
  assert.equal(searchCalls[1].searchParams.recent_not_view, "近14天没有");
  assert.equal(screenCalls.length, 2);
  assert.equal(screenCalls[0].resume, false);
  assert.equal(screenCalls[1].resume, true);
  assert.equal(screenCalls[1].require_checkpoint, true);
  assert.equal(screenCalls[1].output_csv, "C:/temp/resume.csv");
  assert.equal(reloadCalls, 1);
  assert.equal(pageReadyCalls, 2);
  assert.equal(result.result.output_csv, "C:/temp/resume.csv");
  assert.equal(result.result.auto_recovery.reload.ok, true);
  assert.equal(result.search_params.recent_not_view, "近14天没有");
}

async function testPageExhaustedBeforeTargetShouldRefreshInPageAndResumeScreen() {
  const searchCalls = [];
  const screenCalls = [];
  let refreshCalls = 0;
  let reloadCalls = 0;
  let pageReadyCalls = 0;
  const parsed = createParsed();
  parsed.searchParams = {
    ...parsed.searchParams,
    recent_not_view: "不限"
  };
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      resume: {
        resume: false,
        output_csv: "C:/temp/resume.csv",
        checkpoint_path: "C:/temp/checkpoint.json",
        pause_control_path: "C:/temp/run.json",
        previous_completion_reason: ""
      }
    },
    {
      parseRecommendInstruction: () => parsed,
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => {
        pageReadyCalls += 1;
        return { ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } };
      },
      listRecommendJobs: async () => createJobListResult(),
      refreshBossRecommendList: async () => {
        refreshCalls += 1;
        return {
          ok: true,
          action: "in_page_refresh",
          state: "RECOMMEND_READY",
          before_state: {
            finished_wrap_visible: true,
            refresh_button_visible: true
          },
          after_state: {
            finished_wrap_visible: false,
            list_ready: true
          }
        };
      },
      reloadBossRecommendPage: async () => {
        reloadCalls += 1;
        return {
          ok: true,
          state: "RECOMMEND_READY",
          reloaded_url: "https://www.zhipin.com/web/chat/recommend"
        };
      },
      runRecommendSearchCli: async ({ searchParams }) => {
        searchCalls.push({ ...searchParams });
        return {
          ok: true,
          summary: {
            candidate_count: 9,
            applied_filters: searchParams,
            page_state: { state: "RECOMMEND_READY" }
          }
        };
      },
      runRecommendScreenCli: async ({ resume }) => {
        screenCalls.push({ ...resume });
        if (screenCalls.length === 1) {
          return {
            ok: false,
            error: {
              code: "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED",
              message: "推荐列表已到底，但尚未达到目标数。",
              page_exhaustion: {
                reason: "bottom_reached",
                bottom: {
                  isBottom: true,
                  finished_wrap_visible: true,
                  refresh_button_visible: true
                }
              }
            },
            summary: {
              processed_count: 4,
              passed_count: 1,
              skipped_count: 3,
              output_csv: "C:/temp/resume.csv",
              checkpoint_path: "C:/temp/checkpoint.json",
              completion_reason: "page_exhausted_before_target_count"
            }
          };
        }
        return {
          ok: true,
          summary: {
            processed_count: 10,
            passed_count: 3,
            skipped_count: 7,
            output_csv: "C:/temp/resume.csv",
            checkpoint_path: "C:/temp/checkpoint.json",
            completion_reason: "target_count_reached"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].recent_not_view, "不限");
  assert.equal(screenCalls.length, 2);
  assert.equal(screenCalls[0].resume, false);
  assert.equal(screenCalls[1].resume, true);
  assert.equal(screenCalls[1].require_checkpoint, true);
  assert.equal(screenCalls[1].output_csv, "C:/temp/resume.csv");
  assert.equal(refreshCalls, 1);
  assert.equal(reloadCalls, 0);
  assert.equal(pageReadyCalls, 1);
  assert.equal(result.result.candidate_count, null);
  assert.equal(result.result.completion_reason, "target_count_reached");
  assert.equal(result.result.auto_recovery.action, "in_page_refresh");
  assert.equal(result.result.auto_recovery.refresh.ok, true);
  assert.equal(result.result.auto_recovery.page_exhaustion.reason, "bottom_reached");
  assert.equal(result.search_params.recent_not_view, "不限");
}

async function testPageExhaustedBeforeTargetShouldReloadWhenRefreshButtonMissing() {
  const searchCalls = [];
  const screenCalls = [];
  let refreshCalls = 0;
  let reloadCalls = 0;
  let pageReadyCalls = 0;
  const parsed = createParsed();
  parsed.searchParams = {
    ...parsed.searchParams,
    recent_not_view: "不限"
  };
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      resume: {
        resume: false,
        output_csv: "C:/temp/resume.csv",
        checkpoint_path: "C:/temp/checkpoint.json",
        pause_control_path: "C:/temp/run.json",
        previous_completion_reason: ""
      }
    },
    {
      parseRecommendInstruction: () => parsed,
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => {
        pageReadyCalls += 1;
        return { ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } };
      },
      listRecommendJobs: async () => createJobListResult(),
      refreshBossRecommendList: async () => {
        refreshCalls += 1;
        return {
          ok: false,
          action: "in_page_refresh",
          state: "REFRESH_BUTTON_NOT_FOUND",
          message: "未找到页内刷新按钮。"
        };
      },
      reloadBossRecommendPage: async () => {
        reloadCalls += 1;
        return {
          ok: true,
          state: "RECOMMEND_READY",
          reloaded_url: "https://www.zhipin.com/web/chat/recommend"
        };
      },
      runRecommendSearchCli: async ({ searchParams }) => {
        searchCalls.push({ ...searchParams });
        return {
          ok: true,
          summary: {
            candidate_count: searchCalls.length === 1 ? 9 : 12,
            applied_filters: searchParams,
            page_state: { state: "RECOMMEND_READY" }
          }
        };
      },
      runRecommendScreenCli: async ({ resume }) => {
        screenCalls.push({ ...resume });
        if (screenCalls.length === 1) {
          return {
            ok: false,
            error: {
              code: "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED",
              message: "推荐列表已到底，但尚未达到目标数。",
              page_exhaustion: {
                reason: "bottom_reached",
                bottom: {
                  isBottom: true,
                  finished_wrap_visible: true,
                  refresh_button_visible: false
                }
              }
            },
            summary: {
              processed_count: 4,
              passed_count: 1,
              skipped_count: 3,
              output_csv: "C:/temp/resume.csv",
              checkpoint_path: "C:/temp/checkpoint.json",
              completion_reason: "page_exhausted_before_target_count"
            }
          };
        }
        return {
          ok: true,
          summary: {
            processed_count: 10,
            passed_count: 3,
            skipped_count: 7,
            output_csv: "C:/temp/resume.csv",
            checkpoint_path: "C:/temp/checkpoint.json",
            completion_reason: "target_count_reached"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(searchCalls.length, 2);
  assert.equal(searchCalls[0].recent_not_view, "不限");
  assert.equal(searchCalls[1].recent_not_view, "近14天没有");
  assert.equal(screenCalls.length, 2);
  assert.equal(screenCalls[0].resume, false);
  assert.equal(screenCalls[1].resume, true);
  assert.equal(screenCalls[1].require_checkpoint, true);
  assert.equal(refreshCalls, 1);
  assert.equal(reloadCalls, 1);
  assert.equal(pageReadyCalls, 2);
  assert.equal(result.result.candidate_count, 12);
  assert.equal(result.result.auto_recovery.action, "reload_page_and_rerun_search");
  assert.equal(result.result.auto_recovery.refresh.state, "REFRESH_BUTTON_NOT_FOUND");
  assert.equal(result.result.auto_recovery.reload.ok, true);
  assert.equal(result.search_params.recent_not_view, "近14天没有");
}

async function testPageExhaustedBeforeTargetShouldReloadWhenRefreshDoesNotRecoverList() {
  const searchCalls = [];
  const screenCalls = [];
  let refreshCalls = 0;
  let reloadCalls = 0;
  const parsed = createParsed();
  parsed.searchParams = {
    ...parsed.searchParams,
    recent_not_view: "不限"
  };
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      resume: {
        resume: false,
        output_csv: "C:/temp/resume.csv",
        checkpoint_path: "C:/temp/checkpoint.json",
        pause_control_path: "C:/temp/run.json",
        previous_completion_reason: ""
      }
    },
    {
      parseRecommendInstruction: () => parsed,
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } }),
      listRecommendJobs: async () => createJobListResult(),
      refreshBossRecommendList: async () => {
        refreshCalls += 1;
        return {
          ok: false,
          action: "in_page_refresh",
          state: "LIST_NOT_RELOADED",
          message: "点击刷新后列表没有重新就绪。"
        };
      },
      reloadBossRecommendPage: async () => {
        reloadCalls += 1;
        return {
          ok: true,
          state: "RECOMMEND_READY",
          reloaded_url: "https://www.zhipin.com/web/chat/recommend"
        };
      },
      runRecommendSearchCli: async ({ searchParams }) => {
        searchCalls.push({ ...searchParams });
        return {
          ok: true,
          summary: {
            candidate_count: searchCalls.length === 1 ? 9 : 11,
            applied_filters: searchParams,
            page_state: { state: "RECOMMEND_READY" }
          }
        };
      },
      runRecommendScreenCli: async ({ resume }) => {
        screenCalls.push({ ...resume });
        if (screenCalls.length === 1) {
          return {
            ok: false,
            error: {
              code: "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED",
              message: "推荐列表已到底，但尚未达到目标数。"
            },
            summary: {
              processed_count: 4,
              passed_count: 1,
              skipped_count: 3,
              output_csv: "C:/temp/resume.csv",
              checkpoint_path: "C:/temp/checkpoint.json",
              completion_reason: "page_exhausted_before_target_count"
            }
          };
        }
        return {
          ok: true,
          summary: {
            processed_count: 10,
            passed_count: 3,
            skipped_count: 7,
            output_csv: "C:/temp/resume.csv",
            checkpoint_path: "C:/temp/checkpoint.json",
            completion_reason: "target_count_reached"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(searchCalls.length, 2);
  assert.equal(searchCalls[1].recent_not_view, "近14天没有");
  assert.equal(screenCalls.length, 2);
  assert.equal(screenCalls[1].resume, true);
  assert.equal(refreshCalls, 1);
  assert.equal(reloadCalls, 1);
  assert.equal(result.result.candidate_count, 11);
  assert.equal(result.result.auto_recovery.action, "reload_page_and_rerun_search");
  assert.equal(result.result.auto_recovery.refresh.state, "LIST_NOT_RELOADED");
  assert.equal(result.search_params.recent_not_view, "近14天没有");
}

async function testPageExhaustedBeforeTargetShouldFailAfterFiveRecoveryAttempts() {
  const searchCalls = [];
  const screenCalls = [];
  let refreshCalls = 0;
  const parsed = createParsed();
  parsed.searchParams = {
    ...parsed.searchParams,
    recent_not_view: "不限"
  };
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      resume: {
        resume: false,
        output_csv: "C:/temp/resume.csv",
        checkpoint_path: "C:/temp/checkpoint.json",
        pause_control_path: "C:/temp/run.json",
        previous_completion_reason: ""
      }
    },
    {
      parseRecommendInstruction: () => parsed,
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } }),
      listRecommendJobs: async () => createJobListResult(),
      refreshBossRecommendList: async () => {
        refreshCalls += 1;
        return {
          ok: true,
          action: "in_page_refresh",
          state: "RECOMMEND_READY",
          before_state: {
            finished_wrap_visible: true,
            refresh_button_visible: true
          },
          after_state: {
            finished_wrap_visible: false,
            list_ready: true
          }
        };
      },
      runRecommendSearchCli: async ({ searchParams }) => {
        searchCalls.push({ ...searchParams });
        return {
          ok: true,
          summary: {
            candidate_count: 9,
            applied_filters: searchParams,
            page_state: { state: "RECOMMEND_READY" }
          }
        };
      },
      runRecommendScreenCli: async ({ resume }) => {
        screenCalls.push({ ...resume });
        return {
          ok: false,
          error: {
            code: "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED",
            message: "推荐列表已到底，但尚未达到目标数。",
            page_exhaustion: {
              reason: "bottom_reached",
              bottom: {
                isBottom: true,
                finished_wrap_visible: true,
                refresh_button_visible: true
              }
            }
          },
          summary: {
            processed_count: 4,
            passed_count: 1,
            skipped_count: 3,
            output_csv: "C:/temp/resume.csv",
            checkpoint_path: "C:/temp/checkpoint.json",
            completion_reason: "page_exhausted_before_target_count"
          }
        };
      }
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "TARGET_COUNT_NOT_REACHED_PAGE_EXHAUSTED");
  assert.match(result.error.message, /已达到自动恢复上限 5 次/);
  assert.equal(searchCalls.length, 1);
  assert.equal(screenCalls.length, 6);
  assert.equal(refreshCalls, 5);
  assert.equal(result.partial_result.output_csv, "C:/temp/resume.csv");
  assert.equal(result.diagnostics.auto_recovery.attempt, 5);
  assert.equal(result.diagnostics.auto_recovery.action, "in_page_refresh");
  assert.equal(result.diagnostics.auto_recovery.partial_result.checkpoint_path, "C:/temp/checkpoint.json");
}

async function testNullTargetCountShouldKeepPageExhaustedCompletion() {
  const parsed = createParsed();
  parsed.screenParams = {
    ...parsed.screenParams,
    target_count: null
  };
  let receivedScreenParams = null;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {}
    },
    {
      parseRecommendInstruction: () => parsed,
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => ({
        ok: true,
        summary: {
          candidate_count: 9,
          applied_filters: {},
          page_state: { state: "RECOMMEND_READY" }
        }
      }),
      runRecommendScreenCli: async ({ screenParams }) => {
        receivedScreenParams = screenParams;
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

  assert.equal(receivedScreenParams.target_count, null);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.completion_reason, "page_exhausted");
  assert.equal(result.result.auto_recovery, null);
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

async function testNeedPageScopeConfirmationGate() {
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
        needs_page_confirmation: true,
        page_scope: null,
        proposed_page_scope: "featured",
        pending_questions: [{ field: "page_scope" }]
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
  assert.equal(result.required_confirmations.includes("page_scope"), true);
  assert.equal(result.selected_page, "featured");
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

async function testFeaturedPipelineShouldRunSearchThenSwitchTabThenScreen() {
  const calls = [];
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {
        ...createJobConfirmedConfirmation(),
        page_confirmed: true,
        page_value: "featured"
      },
      overrides: {
        page_scope: "featured"
      }
    },
    {
      parseRecommendInstruction: () => createParsed({
        page_scope: "featured",
        proposed_page_scope: "featured"
      }),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async ({ pageScope }) => {
        calls.push({ type: "search", pageScope });
        return {
          ok: true,
          summary: {
            candidate_count: 6,
            applied_filters: { degree: ["本科"] },
            page_state: { state: "RECOMMEND_READY" }
          }
        };
      },
      readRecommendTabState: async () => ({
        ok: true,
        active_status: "0",
        tab_state: { active_status: "0" }
      }),
      switchRecommendTab: async (_workspaceRoot, { target_status }) => {
        calls.push({ type: "switch", target_status });
        return {
          ok: true,
          state: "TAB_SWITCHED",
          active_status: "3",
          tab_state: { active_status: "3" }
        };
      },
      runRecommendScreenCli: async ({ pageScope }) => {
        calls.push({ type: "screen", pageScope });
        return {
          ok: true,
          summary: {
            processed_count: 6,
            passed_count: 2,
            skipped_count: 4,
            output_csv: "C:/temp/result.csv",
            completion_reason: "page_exhausted",
            active_tab_status: "3",
            resume_source: "network"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls.map((item) => item.type), ["search", "switch", "screen"]);
  assert.equal(calls[0].pageScope, "featured");
  assert.equal(calls[2].pageScope, "featured");
  assert.equal(result.result.selected_page, "featured");
  assert.equal(result.result.active_tab_status, "3");
  assert.equal(result.result.resume_source, "network");
}

async function testLatestPipelineShouldRunSearchThenSwitchTabThenScreen() {
  const calls = [];
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {
        ...createJobConfirmedConfirmation(),
        page_confirmed: true,
        page_value: "latest"
      },
      overrides: {
        page_scope: "latest"
      }
    },
    {
      parseRecommendInstruction: () => createParsed({
        page_scope: "latest",
        proposed_page_scope: "latest"
      }),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async ({ pageScope }) => {
        calls.push({ type: "search", pageScope });
        return {
          ok: true,
          summary: {
            candidate_count: 8,
            applied_filters: { degree: ["本科"] },
            page_state: { state: "RECOMMEND_READY" }
          }
        };
      },
      readRecommendTabState: async () => ({
        ok: true,
        active_status: "0",
        tab_state: { active_status: "0" }
      }),
      switchRecommendTab: async (_workspaceRoot, { target_status }) => {
        calls.push({ type: "switch", target_status });
        return {
          ok: true,
          state: "TAB_SWITCHED",
          active_status: "1",
          tab_state: { active_status: "1" }
        };
      },
      runRecommendScreenCli: async ({ pageScope }) => {
        calls.push({ type: "screen", pageScope });
        return {
          ok: true,
          summary: {
            processed_count: 8,
            passed_count: 3,
            skipped_count: 5,
            output_csv: "C:/temp/result.csv",
            completion_reason: "page_exhausted",
            active_tab_status: "1",
            resume_source: "image_fallback"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls.map((item) => item.type), ["search", "switch", "screen"]);
  assert.equal(calls[0].pageScope, "latest");
  assert.equal(calls[1].target_status, "1");
  assert.equal(calls[2].pageScope, "latest");
  assert.equal(result.result.selected_page, "latest");
  assert.equal(result.result.active_tab_status, "1");
  assert.equal(result.result.resume_source, "image_fallback");
}

async function testPipelineShouldPassInputSummaryToScreenCli() {
  let capturedInputSummary = null;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "帮我找有 AI/LLM 项目经验的人",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => ({
        ok: true,
        summary: {
          candidate_count: 3,
          applied_filters: {
            school_tag: ["985"],
            degree: ["本科"],
            gender: "男",
            recent_not_view: "近14天没有"
          }
        }
      }),
      runRecommendScreenCli: async ({ inputSummary }) => {
        capturedInputSummary = inputSummary;
        return {
          ok: true,
          summary: {
            processed_count: 3,
            passed_count: 1,
            skipped_count: 2,
            output_csv: "C:/temp/result.csv",
            active_tab_status: "0",
            resume_source: "network"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(Boolean(capturedInputSummary), true);
  assert.equal(capturedInputSummary.instruction, "帮我找有 AI/LLM 项目经验的人");
  assert.equal(capturedInputSummary.selected_page, "recommend");
  assert.equal(capturedInputSummary.selected_job?.title, "数据分析实习生 _ 杭州");
  assert.equal(capturedInputSummary.user_search_params?.recent_not_view, "近14天没有");
  assert.equal(capturedInputSummary.effective_search_params?.recent_not_view, "近14天没有");
  assert.equal(capturedInputSummary.screen_params?.criteria, "候选人需要有大模型平台经验");
  assert.equal(Object.prototype.hasOwnProperty.call(capturedInputSummary, "baseUrl"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedInputSummary, "apiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(capturedInputSummary, "model"), false);
}

async function testFeaturedMissingCalibrationShouldAutoCalibrateThenContinue() {
  const calls = [];
  let preflightCallCount = 0;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {
        ...createJobConfirmedConfirmation(),
        page_confirmed: true,
        page_value: "featured"
      },
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed({
        page_scope: "featured",
        proposed_page_scope: "featured"
      }),
      runPipelinePreflight: () => {
        preflightCallCount += 1;
        if (preflightCallCount === 1) {
          return {
            ok: false,
            debug_port: 9222,
            page_scope: "featured",
            checks: [
              {
                key: "favorite_calibration",
                ok: false,
                path: "C:/Users/test/.codex/boss-recommend-mcp/favorite-calibration.json",
                message: "favorite-calibration.json 不存在或无效"
              }
            ]
          };
        }
        return {
          ok: true,
          debug_port: 9222,
          page_scope: "featured",
          checks: []
        };
      },
      ensureFeaturedCalibrationReady: async () => {
        calls.push({ type: "calibrate" });
        return {
          ok: true,
          calibration_path: "C:/Users/test/.codex/boss-recommend-mcp/favorite-calibration.json",
          auto_started: true
        };
      },
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => {
        calls.push({ type: "search" });
        return {
          ok: true,
          summary: { candidate_count: 2, applied_filters: {} }
        };
      },
      readRecommendTabState: async () => ({
        ok: true,
        active_status: "3",
        tab_state: { active_status: "3" }
      }),
      switchRecommendTab: async () => ({
        ok: true,
        state: "TAB_SWITCHED",
        active_status: "3",
        tab_state: { active_status: "3" }
      }),
      runRecommendScreenCli: async () => {
        calls.push({ type: "screen" });
        return {
          ok: true,
          summary: {
            processed_count: 2,
            passed_count: 1,
            skipped_count: 1,
            output_csv: "C:/temp/result.csv",
            active_tab_status: "3",
            resume_source: "network"
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(preflightCallCount, 2);
  assert.deepEqual(calls.map((item) => item.type), ["calibrate", "search", "screen"]);
}

async function testFeaturedCalibrationFailureShouldReturnCalibrationRequired() {
  let searchCalled = false;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {
        ...createJobConfirmedConfirmation(),
        page_confirmed: true,
        page_value: "featured"
      },
      overrides: {}
    },
    {
      parseRecommendInstruction: () => createParsed({
        page_scope: "featured",
        proposed_page_scope: "featured"
      }),
      runPipelinePreflight: () => ({
        ok: false,
        debug_port: 9222,
        page_scope: "featured",
        checks: [
          {
            key: "favorite_calibration",
            ok: false,
            path: "C:/Users/test/.codex/boss-recommend-mcp/favorite-calibration.json",
            message: "favorite-calibration.json 不存在或无效"
          }
        ]
      }),
      ensureFeaturedCalibrationReady: async () => ({
        ok: false,
        calibration_path: "C:/Users/test/.codex/boss-recommend-mcp/favorite-calibration.json",
        calibration_script_path: "C:/Users/test/boss-recruit-mcp/vendor/boss-screen-cli/calibrate-favorite-position-v2.cjs",
        error: {
          code: "CALIBRATION_REQUIRED",
          message: "校准失败"
        }
      }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => {
        searchCalled = true;
        return { ok: true, summary: {} };
      },
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "CALIBRATION_REQUIRED");
  assert.equal(result.required_user_action, "run_featured_calibration");
  assert.equal(result.guidance.calibration_path.includes("favorite-calibration.json"), true);
  assert.equal(searchCalled, false);
}

async function testFeaturedTabSwitchFailureShouldReturnRetryableError() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {
        ...createJobConfirmedConfirmation(),
        page_confirmed: true,
        page_value: "featured"
      },
      overrides: {
        page_scope: "featured"
      }
    },
    {
      parseRecommendInstruction: () => createParsed({
        page_scope: "featured",
        proposed_page_scope: "featured"
      }),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: { state: "RECOMMEND_READY" } }),
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => ({
        ok: true,
        summary: { candidate_count: 3, applied_filters: {} }
      }),
      readRecommendTabState: async () => ({
        ok: true,
        active_status: "0",
        tab_state: { active_status: "0" }
      }),
      switchRecommendTab: async () => ({
        ok: false,
        state: "TAB_NOT_FOUND",
        message: "未找到精选 tab。"
      }),
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "TAB_NOT_FOUND");
  assert.equal(result.required_user_action, "retry_switch_recommend_tab");
  assert.equal(result.selected_page, "featured");
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
  let searchCallCount = 0;
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
      runRecommendSearchCli: async () => {
        searchCallCount += 1;
        return {
          ok: false,
          stdout: "",
          stderr: "boom",
          structured: null,
          error: {
            code: "RECOMMEND_FILTER_PANEL_UNAVAILABLE",
            message: "筛选面板不可用。"
          }
        };
      },
      runRecommendScreenCli: async () => ({ ok: true, summary: {} })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "RECOMMEND_FILTER_PANEL_UNAVAILABLE");
  assert.equal(searchCallCount, 3);
}

async function testSearchFilterFailureShouldRetryAndRecover() {
  let searchCallCount = 0;
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
      runRecommendSearchCli: async () => {
        searchCallCount += 1;
        if (searchCallCount === 1) {
          return {
            ok: false,
            stdout: "",
            stderr: "FILTER_CONFIRM_FAILED",
            structured: null,
            error: {
              code: "FILTER_CONFIRM_FAILED",
              message: "FILTER_CONFIRM_FAILED"
            }
          };
        }
        return {
          ok: true,
          summary: {
            candidate_count: 6,
            applied_filters: {}
          }
        };
      },
      runRecommendScreenCli: async () => ({
        ok: true,
        summary: {
          processed_count: 3,
          passed_count: 2,
          skipped_count: 1,
          output_csv: "C:/temp/search-filter-retry.csv"
        }
      })
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(searchCallCount, 2);
  assert.equal(result.result.auto_recovery.trigger, "SEARCH_FILTER_RETRY");
  assert.equal(result.result.auto_recovery.attempt, 1);
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

async function testSearchNoIframeShouldRetryOnceWhenPageRecheckReady() {
  let searchCallCount = 0;
  let recheckCount = 0;
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
      ensureBossRecommendPageReady: async () => {
        recheckCount += 1;
        return {
          ok: true,
          debug_port: 9222,
          state: "RECOMMEND_READY",
          page_state: {
            state: "RECOMMEND_READY",
            expected_url: "https://www.zhipin.com/web/chat/recommend",
            current_url: "https://www.zhipin.com/web/chat/recommend"
          }
        };
      },
      listRecommendJobs: async () => createJobListResult(),
      runRecommendSearchCli: async () => {
        searchCallCount += 1;
        if (searchCallCount === 1) {
          return {
            ok: false,
            stdout: "",
            stderr: "NO_RECOMMEND_IFRAME",
            structured: null,
            error: {
              code: "NO_RECOMMEND_IFRAME",
              message: "NO_RECOMMEND_IFRAME"
            }
          };
        }
        return {
          ok: true,
          summary: {
            candidate_count: 5,
            applied_filters: {}
          }
        };
      },
      runRecommendScreenCli: async () => ({
        ok: true,
        summary: {
          processed_count: 2,
          passed_count: 1,
          skipped_count: 1,
          output_csv: "C:/temp/retry.csv"
        }
      })
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(searchCallCount, 2);
  assert.equal(recheckCount >= 2, true);
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
      readRecommendTabState: async () => ({ ok: true, active_tab_status: "0" }),
      switchRecommendTab: async () => ({ ok: true, state: "TAB_READY" }),
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
          { key: "npm_dep_sharp", ok: false, install_cwd: "C:/workspace/boss-recommend-mcp" }
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
    ["install_nodejs", "install_npm_dependencies"]
  );
  assert.deepEqual(result.diagnostics.recovery.ordered_steps[1].blocked_by, ["install_nodejs"]);
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

async function testFollowUpChatMissingCriteriaShouldNeedInput() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {},
      followUp: createFollowUpChat({ criteria: "" })
    },
    {
      parseRecommendInstruction: () => createParsed()
    }
  );

  assert.equal(result.status, "NEED_INPUT");
  assert.equal(result.missing_fields.includes("follow_up.chat.criteria"), true);
  assert.equal(result.pending_questions.some((item) => item.field === "follow_up.chat.criteria"), true);
}

async function testFollowUpChatMissingFieldsShouldExposeRecommendDefaults() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {},
      followUp: createFollowUpChat({
        criteria: "",
        start_from: "",
        target_count: null
      })
    },
    {
      parseRecommendInstruction: () => createParsed({
        screenParams: {
          criteria: "默认沿用 recommend 的筛选条件",
          target_count: 18,
          post_action: "favorite",
          max_greet_count: null
        }
      })
    }
  );

  assert.equal(result.status, "NEED_INPUT");
  assert.equal(result.missing_fields.includes("follow_up.chat.criteria"), true);
  assert.equal(result.missing_fields.includes("follow_up.chat.start_from"), true);
  assert.equal(result.missing_fields.includes("follow_up.chat.target_count"), true);
  const criteriaQuestion = result.pending_questions.find((item) => item.field === "follow_up.chat.criteria");
  const startFromQuestion = result.pending_questions.find((item) => item.field === "follow_up.chat.start_from");
  const targetCountQuestion = result.pending_questions.find((item) => item.field === "follow_up.chat.target_count");
  assert.equal(criteriaQuestion?.value, "默认沿用 recommend 的筛选条件");
  assert.equal(startFromQuestion?.value, "unread");
  assert.equal(targetCountQuestion?.value, 18);
}

async function testFollowUpChatMissingStartFromShouldNeedInput() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {},
      followUp: createFollowUpChat({ start_from: "" })
    },
    {
      parseRecommendInstruction: () => createParsed()
    }
  );

  assert.equal(result.status, "NEED_INPUT");
  assert.equal(result.missing_fields.includes("follow_up.chat.start_from"), true);
  assert.equal(result.pending_questions.some((item) => item.field === "follow_up.chat.start_from"), true);
}

async function testFollowUpChatMissingTargetCountShouldNeedInput() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: {},
      overrides: {},
      followUp: createFollowUpChat({ target_count: null })
    },
    {
      parseRecommendInstruction: () => createParsed()
    }
  );

  assert.equal(result.status, "NEED_INPUT");
  assert.equal(result.missing_fields.includes("follow_up.chat.target_count"), true);
  assert.equal(result.pending_questions.some((item) => item.field === "follow_up.chat.target_count"), true);
}

async function testFinalReviewShouldIncludeFollowUpChatSummary() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedWithoutFinalConfirmation(),
      overrides: {},
      followUp: createFollowUpChat()
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
  assert.equal(result.follow_up?.chat?.criteria, "有 AI Agent 经验");
  const finalReview = result.pending_questions.find((item) => item.field === "final_review");
  assert.equal(finalReview?.value?.follow_up?.chat?.start_from, "unread");
  assert.equal(finalReview?.value?.follow_up?.chat?.target_count, 5);
}

async function testCompletedPipelineShouldRunChatFollowUp() {
  let getChatRunCalls = 0;
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      followUp: createFollowUpChat()
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9555 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      readRecommendTabState: async () => ({ ok: true, active_tab_status: "0" }),
      switchRecommendTab: async () => ({ ok: true, state: "TAB_READY" }),
      runRecommendSearchCli: async () => ({
        ok: true,
        summary: {
          candidate_count: 8,
          applied_filters: { degree: ["本科"] },
          selected_job: DEFAULT_JOB_OPTIONS[0]
        }
      }),
      runRecommendScreenCli: async () => ({
        ok: true,
        summary: {
          processed_count: 6,
          passed_count: 2,
          skipped_count: 4,
          output_csv: "C:/temp/recommend.csv",
          completion_reason: "screen_completed"
        }
      }),
      startBossChatRun: async ({ input }) => {
        assert.equal(input.job, DEFAULT_JOB_OPTIONS[0].title);
        assert.equal(input.port, 9555);
        return {
          status: "ACCEPTED",
          run_id: "chat-run-1",
          message: "chat started"
        };
      },
      getBossChatRun: async () => {
        getChatRunCalls += 1;
        if (getChatRunCalls === 1) {
          return {
            status: "RUN_STATUS",
            run: {
              runId: "chat-run-1",
              state: "running",
              lastMessage: "chat running",
              progress: {
                inspected: 1,
                passed: 0,
                requested: 0,
                skipped: 1,
                errors: 0
              }
            }
          };
        }
        return {
          status: "RUN_STATUS",
          run: {
            runId: "chat-run-1",
            state: "completed",
            lastMessage: "chat completed",
            progress: {
              inspected: 3,
              passed: 1,
              requested: 1,
              skipped: 2,
              errors: 0
            },
            result: {
              requested_count: 1
            }
          }
        };
      }
    }
  );

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.result.output_csv, "C:/temp/recommend.csv");
  assert.equal(result.follow_up?.chat?.run_id, "chat-run-1");
  assert.equal(result.follow_up?.chat?.state, "completed");
  assert.equal(result.follow_up?.chat?.input?.port, 9555);
}

async function testCompletedPipelineShouldFailWhenChatLaunchFails() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      followUp: createFollowUpChat()
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      readRecommendTabState: async () => ({ ok: true, active_tab_status: "0" }),
      switchRecommendTab: async () => ({ ok: true, state: "TAB_READY" }),
      runRecommendSearchCli: async () => ({ ok: true, summary: { candidate_count: 1, applied_filters: {} } }),
      runRecommendScreenCli: async () => ({
        ok: true,
        summary: {
          processed_count: 1,
          passed_count: 1,
          skipped_count: 0,
          output_csv: "C:/temp/recommend.csv",
          completion_reason: "screen_completed"
        }
      }),
      startBossChatRun: async () => ({
        status: "FAILED",
        error: {
          code: "CHAT_START_FAILED",
          message: "cannot start chat"
        }
      })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "CHAT_START_FAILED");
  assert.equal(result.follow_up?.chat?.launch_result?.status, "FAILED");
}

async function testCompletedPipelineShouldFailWhenChatRunFails() {
  const result = await runRecommendPipeline(
    {
      workspaceRoot: process.cwd(),
      instruction: "test",
      confirmation: createJobConfirmedConfirmation(),
      overrides: {},
      followUp: createFollowUpChat()
    },
    {
      parseRecommendInstruction: () => createParsed(),
      runPipelinePreflight: () => ({ ok: true, checks: [], debug_port: 9222 }),
      ensureBossRecommendPageReady: async () => ({ ok: true, state: "RECOMMEND_READY", page_state: {} }),
      listRecommendJobs: async () => createJobListResult(),
      readRecommendTabState: async () => ({ ok: true, active_tab_status: "0" }),
      switchRecommendTab: async () => ({ ok: true, state: "TAB_READY" }),
      runRecommendSearchCli: async () => ({ ok: true, summary: { candidate_count: 1, applied_filters: {} } }),
      runRecommendScreenCli: async () => ({
        ok: true,
        summary: {
          processed_count: 1,
          passed_count: 1,
          skipped_count: 0,
          output_csv: "C:/temp/recommend.csv",
          completion_reason: "screen_completed"
        }
      }),
      startBossChatRun: async () => ({
        status: "ACCEPTED",
        run_id: "chat-run-2",
        message: "chat started"
      }),
      getBossChatRun: async () => ({
        status: "RUN_STATUS",
        run: {
          runId: "chat-run-2",
          state: "failed",
          lastMessage: "chat failed",
          error: {
            code: "CHAT_RUNTIME_FAILED",
            message: "chat runtime failed"
          }
        }
      })
    }
  );

  assert.equal(result.status, "FAILED");
  assert.equal(result.error.code, "CHAT_RUNTIME_FAILED");
  assert.equal(result.follow_up?.chat?.state, "failed");
}

async function main() {
  await testPauseRequestedBeforeScreenShouldReturnPaused();
  await testPausedScreenResultShouldBubbleUp();
  await testResumeFromScreenPauseShouldSkipSearch();
  await testResumeFromPausedBeforeScreenShouldRerunSearch();
  await testConsecutiveResumeCaptureFailuresShouldRefreshAndRerunSearchWithForcedRecentFilter();
  await testPageExhaustedBeforeTargetShouldRefreshInPageAndResumeScreen();
  await testPageExhaustedBeforeTargetShouldReloadWhenRefreshButtonMissing();
  await testPageExhaustedBeforeTargetShouldReloadWhenRefreshDoesNotRecoverList();
  await testPageExhaustedBeforeTargetShouldFailAfterFiveRecoveryAttempts();
  await testNullTargetCountShouldKeepPageExhaustedCompletion();
  await testNeedConfirmationGate();
  await testNeedPageScopeConfirmationGate();
  await testNeedSchoolTagConfirmationGate();
  await testNeedTargetCountConfirmationGate();
  await testNeedMaxGreetCountConfirmationGate();
  await testNeedInputGate();
  await testFeaturedPipelineShouldRunSearchThenSwitchTabThenScreen();
  await testLatestPipelineShouldRunSearchThenSwitchTabThenScreen();
  await testPipelineShouldPassInputSummaryToScreenCli();
  await testFeaturedMissingCalibrationShouldAutoCalibrateThenContinue();
  await testFeaturedCalibrationFailureShouldReturnCalibrationRequired();
  await testFeaturedTabSwitchFailureShouldReturnRetryableError();
  await testNeedJobConfirmationGate();
  await testNeedFinalReviewConfirmationGate();
  await testCompletedPipeline();
  await testSearchFailure();
  await testSearchFilterFailureShouldRetryAndRecover();
  await testSearchNoIframeWithLoginShouldReturnLoginRequired();
  await testSearchNoIframeShouldRetryOnceWhenPageRecheckReady();
  await testJobTriggerNotFoundShouldMapToLoginRequiredWhenRecheckShowsLogin();
  await testLoginRequiredShouldReturnGuidance();
  await testDebugPortUnreachableShouldReturnConnectionCode();
  await testPreflightRecoveryPlanOrder();
  await testPreflightAutoRepairCanUnblockPipeline();
  await testPreflightAutoRepairStillFailShouldExposeDiagnostics();
  await testScreenConfigFailureShouldRequireUserProvidedConfig();
  await testScreenConfigPlaceholderShouldRequireUserConfirmationAfterUpdate();
  await testScreenConfigRecoveryStepShouldBeFirst();
  await testFollowUpChatMissingCriteriaShouldNeedInput();
  await testFollowUpChatMissingFieldsShouldExposeRecommendDefaults();
  await testFollowUpChatMissingStartFromShouldNeedInput();
  await testFollowUpChatMissingTargetCountShouldNeedInput();
  await testFinalReviewShouldIncludeFollowUpChatSummary();
  await testCompletedPipelineShouldRunChatFollowUp();
  await testCompletedPipelineShouldFailWhenChatLaunchFails();
  await testCompletedPipelineShouldFailWhenChatRunFails();
  console.log("pipeline tests passed");
}

await main();
