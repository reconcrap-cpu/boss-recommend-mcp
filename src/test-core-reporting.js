import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LEGACY_RESULT_HEADER,
  buildLegacyScreenInputRows,
  legacyScreenResultRow,
  writeLegacyScreenCsv
} from "./core/reporting/legacy-csv.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-legacy-csv-"));
const filePath = path.join(dir, "result.csv");
const inputRows = buildLegacyScreenInputRows({
  instruction: "启动boss推荐任务",
  selectedPage: "recommend",
  selectedJob: {
    value: "job-1",
    title: "算法工程师 _ 杭州",
    label: "算法工程师 _ 杭州 20-30K"
  },
  userSearchParams: {
    school_tag: ["985", "211"],
    degree: ["本科", "硕士"],
    gender: "男",
    recent_not_view: "近14天没有",
    current_city_only: true,
    activity_level: "本周活跃"
  },
  effectiveSearchParams: {
    school_tag: ["985", "211"],
    degree: ["本科", "硕士"],
    gender: "男",
    recent_not_view: "近14天没有",
    current_city_only: true,
    activity_level: "本周活跃"
  },
  screenParams: {
    criteria: "只判断通过与否",
    target_count: 5,
    post_action: "greet",
    max_greet_count: 5
  },
  followUp: null
});

writeLegacyScreenCsv(filePath, {
  inputRows,
  results: [
    {
      index: 0,
      candidate: {
        id: "candidate-1",
        identity: {
          name: "张三",
          school: "示例大学",
          major: "计算机",
          current_company: "示例科技",
          current_position: "算法实习生"
        }
      },
      detail: {
        cv_acquisition: {
          source: "network",
          network_wait: {
            elapsed_ms: 123
          },
          image_evidence: {
            elapsed_ms: 456
          }
        }
      },
      llm: {
        passed: true,
        provider: {
          thinking_level: "low"
        },
        reason: "这个字段不应写入评估通过详细原因",
        reasoning_content: "完整 CoT / reasoning_content",
        raw_model_output: "{\"passed\":true}"
      },
      post_action: {
        requested: "greet",
        action_clicked: true
      },
      timings: {
        total_ms: 2000,
        card_read_ms: 10,
        text_model_ms: 800,
        post_action_ms: 50
      }
    },
    {
      index: 1,
      candidate: {
        id: "candidate-2",
        identity: {
          name: "李四",
          school: "示例学院",
          current_company: "示例软件",
          current_position: "增长运营"
        }
      },
      detail: {
        llm_screening: {
          passed: false,
          provider: {
            thinking_level: "current"
          },
          screening_strategy: "fast_first_verified",
          decision_source: "fast",
          verified: false,
          verification_reason: "",
          cot: "passed=false；当前模式总结写入CoT列。",
          raw_model_output: "{\"passed\":false,\"summary\":\"passed=false；当前模式总结写入CoT列。\"}"
        }
      },
      timings: {
        total_ms: 1200,
        vision_model_ms: 900
      }
    }
  ]
});

const csv = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
assert.equal(csv.includes("\"运行输入字段\",\"运行输入值\""), true);
assert.equal(csv.includes("selected_job.label"), true);
assert.equal(csv.includes("user_search_params.school_tag"), true);
assert.equal(csv.includes('"user_search_params.current_city_only","true"'), true);
assert.equal(csv.includes('"user_search_params.activity_level","本周活跃"'), true);
assert.equal(csv.indexOf("user_search_params.current_city_only") < csv.indexOf("user_search_params.activity_level"), true);
assert.equal(csv.includes(LEGACY_RESULT_HEADER.join(",")), false);
assert.equal(csv.includes(LEGACY_RESULT_HEADER.map((header) => `"${header}"`).join(",")), true);
assert.equal(csv.includes("完整 CoT / reasoning_content"), true);
assert.equal(csv.includes("这个字段不应写入评估通过详细原因"), false);
assert.equal(csv.includes("\"passed\""), true);
assert.equal(csv.includes("\"LLM thinking_level\""), true);
assert.equal(csv.includes("\"LLM screening_strategy\""), true);
assert.equal(csv.includes("\"LLM decision_source\""), true);
assert.equal(csv.includes("\"LLM verified\""), true);
assert.equal(csv.includes("\"LLM verification_reason\""), true);
assert.equal(csv.includes("\"low\""), true);
assert.equal(csv.includes("passed=false；当前模式总结写入CoT列。"), true);
assert.equal(csv.includes("\"current\""), true);
assert.equal(csv.includes("\"fast_first_verified\""), true);
assert.equal(csv.includes("\"fast\""), true);
assert.equal(csv.includes("\"False\""), false);
assert.equal(csv.includes("\"false\""), true);
assert.equal(csv.includes("\"network\""), true);
assert.equal(csv.includes("\"2000\""), true);
assert.equal(csv.includes("\"123\""), true);
assert.equal(csv.includes("\"800\""), true);

const actionResultColumn = LEGACY_RESULT_HEADER.indexOf("动作执行结果");
assert.notEqual(actionResultColumn, -1);
assert.equal(
  legacyScreenResultRow({
    post_action: {
      requested: "greet",
      action_clicked: true,
      assumed_sent: true,
      reason: "greet_confirmation_not_observed_assumed_sent"
    }
  })[actionResultColumn],
  "assumed_sent"
);
assert.equal(
  legacyScreenResultRow({
    post_action: {
      requested: "greet",
      action_clicked: true,
      skipped: true,
      action_transaction: {
        state: "greeting_assumed_sent"
      }
    }
  })[actionResultColumn],
  "assumed_sent"
);

fs.rmSync(dir, { recursive: true, force: true });
console.log("Core reporting tests passed");
