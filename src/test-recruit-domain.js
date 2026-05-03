#!/usr/bin/env node
import assert from "node:assert/strict";
import { GREET_CREDITS_EXHAUSTED_CODE } from "./core/greet-quota/index.js";
import { RUN_STATUS_COMPLETED } from "./core/run/index.js";
import {
  buildRecruitJobTitleSearchTerms,
  createRecruitRunService,
  chooseRecruitTextCandidate,
  clickRecruitActionControl,
  isRecruitNationalCity,
  matchesRecruitDetailNetwork,
  normalizeRecruitSearchLabel,
  normalizeRecruitSearchParams,
  parseRecruitInstruction,
  readRecruitCardCandidate,
  resolveRecruitDegreeLabel,
  recruitInstructionParserSemantics
} from "./domains/recruit/index.js";

function testParserImportSemantics() {
  const parsed = parseRecruitInstruction({
    instruction: "请在Boss上找城市在上海，学历硕士及以上，985，目标筛选3位，做过LLM的人选",
    confirmation: {
      keyword_confirmed: true,
      criteria_confirmed: true,
      search_params_confirmed: true
    },
    overrides: {
      keyword: "LLM",
      filter_recent_viewed: true
    }
  });

  assert.equal(parsed.searchParams.city, "上海");
  assert.equal(parsed.searchParams.degree, "硕士及以上");
  assert.deepEqual(parsed.searchParams.schools, ["985院校"]);
  assert.equal(parsed.searchParams.keyword, "LLM");
  assert.equal(parsed.searchParams.filter_recent_viewed, true);
  assert.equal(parsed.screenParams.target_count, 3);
  assert.match(parsed.screenParams.criteria, /LLM/);
  assert.equal(recruitInstructionParserSemantics.source, "boss-recruit-mcp/src/parser.js");
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
    filter_recent_viewed: true
  });

  assert.deepEqual(normalizeRecruitSearchParams({
    degrees: ["本科", "硕士及以上", "博士"]
  }).degrees, ["本科", "硕士", "博士"]);

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

testParserImportSemantics();
testNetworkPatterns();
testSearchParamHelpers();
await testCardCandidateReader();
await testRunServiceLifecycle();
await testRecruitGreetQuotaClickGuard();

console.log("recruit domain tests passed");
