import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LEGACY_RESULT_HEADER,
  buildLegacyScreenInputRows,
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
    recent_not_view: "近14天没有"
  },
  effectiveSearchParams: {
    school_tag: ["985", "211"],
    degree: ["本科", "硕士"],
    gender: "男",
    recent_not_view: "近14天没有"
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
          source: "network"
        }
      },
      llm: {
        passed: true,
        reason: "这个字段不应写入评估通过详细原因",
        reasoning_content: "完整 CoT / reasoning_content",
        raw_model_output: "{\"passed\":true}"
      },
      post_action: {
        requested: "greet",
        action_clicked: true
      }
    }
  ]
});

const csv = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
assert.equal(csv.includes("\"运行输入字段\",\"运行输入值\""), true);
assert.equal(csv.includes("selected_job.label"), true);
assert.equal(csv.includes("user_search_params.school_tag"), true);
assert.equal(csv.includes(LEGACY_RESULT_HEADER.join(",")), false);
assert.equal(csv.includes(LEGACY_RESULT_HEADER.map((header) => `"${header}"`).join(",")), true);
assert.equal(csv.includes("完整 CoT / reasoning_content"), true);
assert.equal(csv.includes("这个字段不应写入评估通过详细原因"), false);
assert.equal(csv.includes("\"passed\""), true);

fs.rmSync(dir, { recursive: true, force: true });
console.log("Core reporting tests passed");
