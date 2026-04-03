import assert from "node:assert/strict";
import { RecommendSearchCli, normalizeJobTitle } from "./cli.js";

const JOBS = [
  {
    value: "b80ce74081810d060nZ93t24FlRY",
    title: "数据分析实习生 _ 杭州",
    label: "数据分析实习生 _ 杭州 100-150元/天",
    current: true
  },
  {
    value: "3208c73ad64d0e610nV93du7FFdZ",
    title: "算法工程师（视频/图像模型方向） _ 杭州",
    label: "算法工程师（视频/图像模型方向） _ 杭州 25-50K",
    current: false
  }
];

function createArgs(overrides = {}) {
  return {
    schoolTag: ["不限"],
    degree: ["不限"],
    gender: "不限",
    recentNotView: "不限",
    port: 9222,
    listJobs: false,
    job: null,
    help: false,
    __provided: {
      schoolTag: true,
      degree: true,
      gender: true,
      recentNotView: true,
      port: true,
      job: true
    },
    ...overrides
  };
}

class SelectJobCliMock extends RecommendSearchCli {
  constructor(args, states) {
    super(args);
    this.states = Array.isArray(states) ? states.slice() : [];
    this.stateIndex = 0;
    this.dropdownClicks = 0;
    this.clickedJob = null;
    this.waitSelectedResult = true;
  }

  async getJobListState() {
    if (!this.states.length) {
      return { ok: true, jobs: JOBS };
    }
    const index = Math.min(this.stateIndex, this.states.length - 1);
    this.stateIndex += 1;
    return this.states[index];
  }

  async clickJobDropdownTriggerBySelector() {
    this.dropdownClicks += 1;
    return { ok: true };
  }

  async clickJobBySelector(job) {
    this.clickedJob = job;
    return { ok: true };
  }

  async waitJobSelected() {
    return this.waitSelectedResult;
  }
}

class ListJobsRunCliMock extends RecommendSearchCli {
  constructor(args, state) {
    super(args);
    this.state = state;
    this.connected = false;
    this.disconnected = false;
    this.filterOpened = false;
  }

  async connect() {
    this.connected = true;
  }

  async disconnect() {
    this.disconnected = true;
  }

  async getFrameState() {
    return { ok: true, frameUrl: "https://www.zhipin.com/web/frame/recommend/mock" };
  }

  async ensureJobListReady() {
    return this.state;
  }

  async openFilterPanel() {
    this.filterOpened = true;
  }
}

function testNormalizeJobTitle() {
  assert.equal(
    normalizeJobTitle("算法工程师（视频/图像模型方向） _ 杭州 25-50K"),
    "算法工程师（视频/图像模型方向） _ 杭州"
  );
  assert.equal(
    normalizeJobTitle("数据分析实习生 _ 杭州 100-150元/天"),
    "数据分析实习生 _ 杭州"
  );
  assert.equal(normalizeJobTitle(""), "");
}

function testFindJobMatchByValueTitleLabelAndPartial() {
  const cli = new RecommendSearchCli(createArgs());
  const byValue = cli.findJobMatch(JOBS, "3208c73ad64d0e610nV93du7FFdZ");
  assert.equal(byValue?.title, "算法工程师（视频/图像模型方向） _ 杭州");

  const byTitle = cli.findJobMatch(JOBS, "算法工程师（视频/图像模型方向） _ 杭州");
  assert.equal(byTitle?.value, "3208c73ad64d0e610nV93du7FFdZ");

  const byLabel = cli.findJobMatch(JOBS, "数据分析实习生 _ 杭州 100-150元/天");
  assert.equal(byLabel?.value, "b80ce74081810d060nZ93t24FlRY");

  const byPartial = cli.findJobMatch(JOBS, "视频/图像模型方向");
  assert.equal(byPartial?.value, "3208c73ad64d0e610nV93du7FFdZ");
}

function testFindJobMatchAmbiguousThrows() {
  const cli = new RecommendSearchCli(createArgs());
  const ambiguousJobs = [
    { value: "v1", title: "算法工程师 _ 杭州", label: "算法工程师 _ 杭州 25-50K" },
    { value: "v2", title: "算法工程师 _ 上海", label: "算法工程师 _ 上海 25-50K" }
  ];
  assert.throws(() => cli.findJobMatch(ambiguousJobs, "算法工程师"), /JOB_SELECTION_AMBIGUOUS/);
}

async function testSelectJobRetriesThenClicks() {
  const states = [
    { ok: true, jobs: [] },
    { ok: true, jobs: JOBS }
  ];
  const cli = new SelectJobCliMock(createArgs(), states);
  const selected = await cli.selectJob("算法工程师（视频/图像模型方向） _ 杭州");
  assert.equal(cli.dropdownClicks >= 1, true);
  assert.equal(cli.clickedJob?.value, "3208c73ad64d0e610nV93du7FFdZ");
  assert.equal(selected?.title, "算法工程师（视频/图像模型方向） _ 杭州");
}

async function testSelectJobFailsWhenNotApplied() {
  const cli = new SelectJobCliMock(createArgs(), [{ ok: true, jobs: JOBS }]);
  cli.waitSelectedResult = false;
  await assert.rejects(
    async () => {
      await cli.selectJob("数据分析实习生 _ 杭州");
    },
    /JOB_SELECTION_NOT_APPLIED/
  );
}

async function testRunListJobsModePrintsJobsAndSkipsFilter() {
  const cli = new ListJobsRunCliMock(
    createArgs({ listJobs: true }),
    {
      ok: true,
      jobs: JOBS,
      frame_url: "https://www.zhipin.com/web/frame/recommend/mock"
    }
  );
  const originalLog = console.log;
  const outputs = [];
  console.log = (value) => outputs.push(String(value));
  try {
    await cli.run();
  } finally {
    console.log = originalLog;
  }
  assert.equal(cli.connected, true);
  assert.equal(cli.disconnected, true);
  assert.equal(cli.filterOpened, false);
  assert.equal(outputs.length, 1);
  const payload = JSON.parse(outputs[0]);
  assert.equal(payload.status, "COMPLETED");
  assert.equal(Array.isArray(payload.result.jobs), true);
  assert.equal(payload.result.jobs.length, 2);
}

async function main() {
  testNormalizeJobTitle();
  testFindJobMatchByValueTitleLabelAndPartial();
  testFindJobMatchAmbiguousThrows();
  await testSelectJobRetriesThenClicks();
  await testSelectJobFailsWhenNotApplied();
  await testRunListJobsModePrintsJobsAndSkipsFilter();
  console.log("search job tests passed");
}

await main();
