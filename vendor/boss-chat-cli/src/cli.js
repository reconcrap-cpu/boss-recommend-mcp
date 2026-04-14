#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as readlineCore from 'node:readline';
import readline from 'node:readline/promises';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

import { BossChatApp } from './app.js';
import { BossChatPage } from './browser/chat-page.js';
import {
  appendRunEvent,
  createRunId,
  createRunStateSnapshot,
  getRunEventsPath,
  isTerminalRunState,
  readRunState,
  RUN_STATE_CANCELED,
  RUN_STATE_COMPLETED,
  RUN_STATE_FAILED,
  RUN_STATE_PAUSED,
  RUN_STATE_QUEUED,
  RUN_STATE_RUNNING,
  updateRunState,
  writeRunState,
} from './runtime/async-run-state.js';
import { InteractionController } from './runtime/interaction.js';
import { RunControl } from './runtime/run-control.js';
import { ChromeClient } from './services/chrome-client.js';
import { LlmClient } from './services/llm.js';
import {
  normalizeProfile,
  ProfileStore,
  toPersistentProfile,
  validateProfile,
} from './services/profile-store.js';
import { ReportStore } from './services/report-store.js';
import { ResumeCaptureService } from './services/resume-capture.js';
import { NoopStateStore, StateStore } from './services/state-store.js';

const CLI_FILE_PATH = fileURLToPath(import.meta.url);
const MINIMAL_TERMINAL_PATTERNS = [/^进度: /, /^候选人结果: /];
const CHAT_INDEX_URL = 'https://www.zhipin.com/web/chat/index';
const CHAT_START_REQUIRED_FIELDS = ['job', 'start_from', 'target_count', 'criteria'];

function sanitizePathToken(value, fallback = 'run') {
  const token = String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 80);
  return token || fallback;
}

function formatLogLineArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      return util.inspect(arg, {
        depth: 6,
        breakLength: 120,
        maxArrayLength: 100,
      });
    })
    .join(' ');
}

function shouldPrintToMinimalTerminal(message) {
  return MINIMAL_TERMINAL_PATTERNS.some((pattern) => pattern.test(message));
}

async function createRunLogger(dataDir, { runId = '', detachedWorker = false } = {}) {
  const logsDir = path.join(dataDir, 'logs');
  await mkdir(logsDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const suffix = sanitizePathToken(runId || process.pid, detachedWorker ? 'detached' : 'run');
  const logPath = path.join(logsDir, `run-${stamp}-${suffix}.log`);

  let writeQueue = Promise.resolve();
  const enqueueWrite = (line) => {
    writeQueue = writeQueue.then(() => appendFile(logPath, line, 'utf8')).catch(() => {});
    return writeQueue;
  };

  const write = (level, sink, args) => {
    const message = formatLogLineArgs(args);
    enqueueWrite(`[${nowIso()}] [${level}] ${message}\n`);
    if (sink === 'stdout' && shouldPrintToMinimalTerminal(message)) {
      process.stdout.write(`${message}\n`);
      return;
    }
    if (sink === 'stderr' && shouldPrintToMinimalTerminal(message)) {
      process.stderr.write(`${message}\n`);
    }
  };

  const logger = {
    log: (...args) => write('INFO', 'stdout', args),
    info: (...args) => write('INFO', 'stdout', args),
    warn: (...args) => write('WARN', 'stderr', args),
    error: (...args) => write('ERROR', 'stderr', args),
  };

  enqueueWrite(`[${nowIso()}] [INFO] run-log-created path=${logPath}\n`);

  return {
    logger,
    logPath,
    flush: () => writeQueue,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function parseBooleanFlag(value, fallback = true) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseStartFrom(value, fallback = 'unread') {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['all', '全部', '2'].includes(normalized)) return 'all';
  if (['unread', '未读', '1'].includes(normalized)) return 'unread';
  return fallback;
}

function isUnlimitedTargetCountToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return false;
  return [
    'all',
    'unlimited',
    'infinity',
    'inf',
    'max',
    'full',
    'allcandidates',
    '全部',
    '全量',
    '不限',
    '扫到底',
    '全部候选人',
    '所有候选人',
    '全部人选',
    '所有人选',
    '直到完成所有人选',
  ].includes(token);
}

function parseTargetCount(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  if (isUnlimitedTargetCountToken(value)) {
    return -1;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed === -1) {
    return -1;
  }
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseArgs(argv) {
  const args = {
    command: 'run',
    profile: 'default',
    dryRun: false,
    noState: false,
    json: false,
    runId: '',
    detachedWorker: false,
    overrides: {
      startFrom: undefined,
      targetCount: undefined,
      screeningCriteria: undefined,
      jobSelection: undefined,
      llm: {},
      chrome: {},
      runtime: {},
    },
  };

  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith('--') ? next : undefined;
    if (value !== undefined) {
      index += 1;
    }

    switch (name) {
      case 'profile':
        args.profile = value || args.profile;
        break;
      case 'dry-run':
        args.dryRun = true;
        break;
      case 'no-state':
        args.noState = true;
        break;
      case 'json':
        args.json = true;
        break;
      case 'run-id':
      case 'runId':
        args.runId = String(value || '').trim();
        break;
      case 'detached-worker':
        args.detachedWorker = true;
        break;
      case 'targetCount':
        args.overrides.targetCount = parseTargetCount(value);
        break;
      case 'start-from':
      case 'startFrom':
        args.overrides.startFrom = parseStartFrom(value, 'unread');
        break;
      case 'criteria':
      case 'screeningCriteria':
        args.overrides.screeningCriteria = String(value || '').trim();
        break;
      case 'job':
      case 'jobSelection':
        args.overrides.jobSelection = String(value || '').trim();
        break;
      case 'baseurl':
      case 'baseUrl':
        args.overrides.llm.baseUrl = value || '';
        break;
      case 'apikey':
      case 'apiKey':
        args.overrides.llm.apiKey = value || '';
        break;
      case 'model':
        args.overrides.llm.model = value || '';
        break;
      case 'port':
        args.overrides.chrome.port = Number.parseInt(value, 10);
        break;
      case 'safe-pacing':
        args.overrides.runtime.safePacing = parseBooleanFlag(value, true);
        break;
      case 'batch-rest':
        args.overrides.runtime.batchRestEnabled = parseBooleanFlag(value, true);
        break;
      case 'help':
        args.command = 'help';
        break;
      default:
        throw new Error(`Unknown option: --${name}`);
    }
  }

  if (positionals.length > 0) {
    args.command = positionals[0];
  }
  return args;
}

function printUsage() {
  console.log('Usage: boss-chat <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  run                             Interactive/manual run');
  console.log('  prepare-run                     Preflight chat page and list jobs for required input collection');
  console.log('  start-run                       Start async run and return run_id');
  console.log('  get-run                         Query async run status');
  console.log('  pause-run                       Request async run pause');
  console.log('  resume-run                      Resume paused async run');
  console.log('  cancel-run                      Cancel async run');
  console.log('');
  console.log('Common options:');
  console.log('  --profile <name>                Profile name (default: default)');
  console.log('  --json                          JSON output for agent integration');
  console.log('  --run-id <id>                   Target async run_id (for get/pause/resume/cancel)');
  console.log('');
  console.log('Run options:');
  console.log('  --dry-run                       Evaluate and click, but do not request resume');
  console.log('  --no-state                      Disable in-run candidate deduplication');
  console.log('  --job <text|value|index>        Select job by label/value/index');
  console.log('  --criteria <text>               Screening criteria for resume evaluation');
  console.log('  --start-from <unread|all>       Start from unread or all list');
  console.log('  --targetCount <n|all>           Maximum candidates to process; all means unlimited');
  console.log('  --baseurl <url>                 Override LLM base URL');
  console.log('  --apikey <key>                  Override LLM API key');
  console.log('  --model <name>                  Override LLM model');
  console.log('  --port <n>                      Override Chrome remote debugging port');
}

function outputCommandResult(args, payload) {
  if (args.json) {
    console.log(JSON.stringify(payload));
    return;
  }

  if (payload?.status) {
    console.log(`status: ${payload.status}`);
  }
  if (payload?.run_id) {
    console.log(`run_id: ${payload.run_id}`);
  }
  if (payload?.message) {
    console.log(payload.message);
  }
  if (payload?.error?.message) {
    console.log(`error: ${payload.error.message}`);
  }
  if (!payload?.status && !payload?.message && !payload?.error) {
    console.log(JSON.stringify(payload, null, 2));
  }
}

function setupRuntimeControls(runControl) {
  if (!process.stdin.isTTY) {
    return () => {};
  }

  readlineCore.emitKeypressEvents(process.stdin);
  if (typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
  }

  const onKeypress = (_str, key) => {
    if (key?.ctrl && key.name === 'c') {
      runControl.requestStop('收到 Ctrl+C');
      return;
    }

    if (key?.name === 'p') {
      runControl.togglePause();
      return;
    }

    if (key?.name === 'r') {
      runControl.resume();
      return;
    }

    if (key?.name === 'q') {
      runControl.requestStop('用户请求停止');
    }
  };

  process.stdin.on('keypress', onKeypress);

  return () => {
    process.stdin.off('keypress', onKeypress);
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(false);
    }
  };
}

function startDetachedControlSync({ dataDir, runId, runControl }) {
  let lastHeartbeatAt = 0;
  let inTick = false;

  const timer = setInterval(() => {
    if (inTick) return;
    inTick = true;
    try {
      const snapshot = readRunState(dataDir, runId);
      if (!snapshot) return;

      const control = snapshot.control || {};
      if (control.cancelRequested && !runControl.isStopping()) {
        runControl.requestStop('收到 cancel-run 请求');
        appendRunEvent(dataDir, runId, {
          type: 'control',
          action: 'cancel-request-observed',
          message: '检测到 cancel-run 请求，准备安全停止。',
        });
      }

      if (control.pauseRequested) {
        if (!runControl.isPaused() && !runControl.isStopping()) {
          runControl.pause();
          updateRunState(dataDir, runId, {
            state: RUN_STATE_PAUSED,
            stage: 'running',
            heartbeatAt: nowIso(),
            lastMessage: '运行已暂停（来自 pause-run 请求）。',
          });
        }
      } else if (runControl.isPaused() && !runControl.isStopping()) {
        runControl.resume();
        updateRunState(dataDir, runId, {
          state: RUN_STATE_RUNNING,
          stage: 'running',
          heartbeatAt: nowIso(),
          lastMessage: '运行已继续（来自 resume-run 请求）。',
        });
      }

      const now = Date.now();
      if (now - lastHeartbeatAt >= 5000) {
        updateRunState(dataDir, runId, {
          heartbeatAt: nowIso(),
          state: runControl.isPaused() ? RUN_STATE_PAUSED : RUN_STATE_RUNNING,
        });
        lastHeartbeatAt = now;
      }
    } catch {} finally {
      inTick = false;
    }
  }, 700);

  return () => clearInterval(timer);
}

async function promptPersistentLlmIfMissing(profile, profileName) {
  const missing = validateProfile(profile);
  if (missing.length === 0) {
    return normalizeProfile(profile);
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `Profile "${profileName}" 缺少必要配置：${missing.join(', ')}。当前为非交互模式，请先补齐 profile 或通过参数传入。`,
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(`Profile "${profileName}" 缺少 LLM/Chrome 必要配置，开始交互填写。`);
    if (!profile.llm.baseUrl) {
      profile.llm.baseUrl = await rl.question('LLM baseUrl: ');
    }
    if (!profile.llm.apiKey) {
      profile.llm.apiKey = await rl.question('LLM apiKey: ');
    }
    if (!profile.llm.model) {
      profile.llm.model = await rl.question('LLM model: ');
    }
    profile.chrome.port =
      (await rl.question(`Chrome 远程调试端口 [${profile.chrome.port || 9222}]: `)) ||
      profile.chrome.port ||
      9222;
  } finally {
    rl.close();
  }

  return normalizeProfile(profile);
}

function resolveJobSelection(jobs, input) {
  const normalizedInput = String(input || '').trim();
  if (!normalizedInput) return null;

  const asIndex = Number.parseInt(normalizedInput, 10);
  if (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= jobs.length) {
    return jobs[asIndex - 1];
  }

  const byValue = jobs.find((job) => String(job.value || '').trim() === normalizedInput);
  if (byValue) return byValue;

  const byExactLabel = jobs.find((job) => String(job.label || '').trim() === normalizedInput);
  if (byExactLabel) return byExactLabel;

  const normalizedLower = normalizedInput.toLowerCase();
  const fuzzy = jobs.filter((job) =>
    String(job.label || '').toLowerCase().includes(normalizedLower),
  );
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new Error('岗位选择有歧义，请输入编号或完整岗位名。');
  }

  return null;
}

async function promptRunProfile({ page, persistentProfile, overrides }) {
  const jobs = await page.listJobs();
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error('未解析到岗位列表，请确认岗位下拉可见。');
  }

  let selectedJob = null;
  if (overrides.jobSelection) {
    selectedJob = resolveJobSelection(jobs, overrides.jobSelection);
    if (!selectedJob) {
      throw new Error(`未找到岗位: ${overrides.jobSelection}`);
    }
  }

  let startFrom = overrides.startFrom;
  let screeningCriteria = overrides.screeningCriteria;
  let targetCount = overrides.targetCount;

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      if (!selectedJob) {
        console.log('可选岗位:');
        jobs.forEach((job, index) => {
          console.log(`  ${index + 1}. ${job.label}${job.active ? ' (当前)' : ''}`);
        });
        const answer = await rl.question('请选择岗位编号: ');
        selectedJob = resolveJobSelection(jobs, answer);
        if (!selectedJob) {
          throw new Error('岗位选择无效。');
        }
      }

      if (!startFrom) {
        const answer = await rl.question('列表范围 [1=未读, 2=全部] (1): ');
        startFrom = parseStartFrom(answer, 'unread');
      }

      if (!screeningCriteria) {
        screeningCriteria = String(await rl.question('筛选标准: ')).trim();
      }

      if (targetCount === undefined) {
        const answer = await rl.question('本次处理人数上限（回车=扫到底）: ');
        targetCount = parseTargetCount(answer);
      }
    } finally {
      rl.close();
    }
  }

  if (!selectedJob) {
    selectedJob = jobs[0];
  }
  if (!startFrom) {
    startFrom = 'unread';
  }
  if (!screeningCriteria) {
    throw new Error('筛选标准不能为空（可通过 --criteria 传入，或在交互中输入）。');
  }

  return normalizeProfile({
    ...persistentProfile,
    jobSelection: {
      value: selectedJob.value,
      label: selectedJob.label,
    },
    startFrom,
    screeningCriteria,
    targetCount: targetCount ?? null,
  });
}

function validateStartRunArgs(args) {
  const missing = [];
  if (!args?.overrides?.jobSelection) missing.push('--job');
  if (!args?.overrides?.startFrom) missing.push('--start-from');
  if (args?.overrides?.targetCount === undefined || args?.overrides?.targetCount === null) {
    missing.push('--targetCount');
  }
  if (!args?.overrides?.screeningCriteria) missing.push('--criteria');

  if (missing.length === 0) return null;
  return {
    status: 'FAILED',
    error: {
      code: 'MISSING_REQUIRED_ARGS',
      message: `start-run 缺少必要参数：${missing.join(', ')}`,
      retryable: false,
    },
  };
}

function buildPreparePendingQuestions(args, jobs = []) {
  const pendingQuestions = [];
  const startFromValue = String(args?.overrides?.startFrom || '').trim().toLowerCase();
  const targetCountValue = Number.parseInt(String(args?.overrides?.targetCount ?? ''), 10);
  const hasTargetCount =
    args?.overrides?.targetCount !== undefined &&
    args?.overrides?.targetCount !== null &&
    Number.isFinite(targetCountValue) &&
    (targetCountValue > 0 || targetCountValue === -1);
  const criteriaValue = String(args?.overrides?.screeningCriteria || '').trim();
  const jobValue = String(args?.overrides?.jobSelection || '').trim();
  const jobOptions = jobs.map((job, index) => ({
    label: `${index + 1}. ${job.label}${job.active ? '（当前）' : ''}`,
    value: String(job.value || job.label || ''),
    index: index + 1,
    active: Boolean(job.active),
  }));

  if (!jobValue) {
    pendingQuestions.push({
      field: 'job',
      question: '请选择岗位（必须从岗位列表中选择）',
      required: true,
      options: jobOptions,
    });
  }
  if (!['unread', 'all'].includes(startFromValue)) {
    pendingQuestions.push({
      field: 'start_from',
      question: '请选择起始范围',
      required: true,
      options: [
        { label: '未读', value: 'unread' },
        { label: '全部', value: 'all' },
      ],
    });
  }
  if (!hasTargetCount) {
    pendingQuestions.push({
      field: 'target_count',
      question: '请输入目标数量（正整数）或 all（扫到底）',
      required: true,
    });
  }
  if (!criteriaValue) {
    pendingQuestions.push({
      field: 'criteria',
      question: '请输入筛选标准（自然语言）',
      required: true,
    });
  }
  return pendingQuestions;
}

async function connectBossChatPage(chromeClient) {
  const isBossDomainTarget = (target) =>
    target?.type === 'page' && /zhipin\.com/i.test(String(target?.url || ''));
  let target = null;
  let recoveredToChatIndex = false;

  try {
    target = await chromeClient.connect(BossChatPage.targetMatcher);
  } catch {
    target = await chromeClient.connect(isBossDomainTarget);
  }

  const page = new BossChatPage(chromeClient);
  try {
    await page.ensureReady();
  } catch {
    await page.recoverToChatIndex();
    recoveredToChatIndex = true;
    await page.ensureReady();
  }

  return { target, page, recoveredToChatIndex };
}

async function handlePrepareRunCommand(args, dataDir) {
  const profileStore = new ProfileStore(dataDir);
  const savedProfile = (await profileStore.load(args.profile)) || {};
  const mergedProfile = normalizeProfile({
    ...savedProfile,
    llm: {
      ...(savedProfile.llm || {}),
      ...(args.overrides.llm || {}),
    },
    chrome: {
      ...(savedProfile.chrome || {}),
      ...(args.overrides.chrome || {}),
    },
    runtime: {
      ...(savedProfile.runtime || {}),
      ...(args.overrides.runtime || {}),
    },
  });

  const missingProfileConfig = validateProfile(mergedProfile);
  if (missingProfileConfig.length > 0) {
    return {
      status: 'FAILED',
      error: {
        code: 'PROFILE_CONFIG_MISSING',
        message: `profile 配置缺失：${missingProfileConfig.join(', ')}`,
        retryable: false,
      },
    };
  }

  let chromeClient = null;
  try {
    chromeClient = new ChromeClient(mergedProfile.chrome.port);
    const { target, page, recoveredToChatIndex } = await connectBossChatPage(chromeClient);
    const jobs = await page.listJobs();
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return {
        status: 'FAILED',
        error: {
          code: 'CHAT_JOB_LIST_EMPTY',
          message: '未解析到岗位列表，请先在聊天页确认岗位下拉可见后重试。',
          retryable: true,
        },
      };
    }

    return {
      status: 'NEED_INPUT',
      stage: 'chat_run_setup',
      page_url: CHAT_INDEX_URL,
      connected_target: target?.url || '',
      recovered_to_chat_index: recoveredToChatIndex,
      required_fields: CHAT_START_REQUIRED_FIELDS.slice(),
      defaults: {
        profile: String(args.profile || 'default').trim() || 'default',
        start_from: 'unread',
      },
      job_options: jobs.map((job, index) => ({
        index: index + 1,
        label: String(job.label || ''),
        value: String(job.value || job.label || ''),
        active: Boolean(job.active),
      })),
      pending_questions: buildPreparePendingQuestions(args, jobs),
      message:
        '已导航至 Boss 聊天页并加载岗位列表。请补齐 job / start_from / target_count / criteria 后再次调用 start-run。',
    };
  } catch (error) {
    return {
      status: 'FAILED',
      error: {
        code: 'CHAT_PREPARE_FAILED',
        message: error?.message || 'prepare-run 执行失败。',
        retryable: true,
      },
    };
  } finally {
    if (chromeClient) {
      await chromeClient.close();
    }
  }
}

function buildDetachedRunArgs(args, runId) {
  const workerArgs = [CLI_FILE_PATH, 'run', '--detached-worker', '--run-id', runId];
  workerArgs.push('--profile', args.profile);
  workerArgs.push('--job', String(args.overrides.jobSelection));
  workerArgs.push('--start-from', String(args.overrides.startFrom));
  workerArgs.push('--criteria', String(args.overrides.screeningCriteria));

  if (args.dryRun) workerArgs.push('--dry-run');
  if (args.noState) workerArgs.push('--no-state');
  if (args.overrides.targetCount !== undefined && args.overrides.targetCount !== null) {
    workerArgs.push('--targetCount', String(args.overrides.targetCount));
  }
  if (args.overrides.llm.baseUrl) {
    workerArgs.push('--baseurl', String(args.overrides.llm.baseUrl));
  }
  if (args.overrides.llm.apiKey) {
    workerArgs.push('--apikey', String(args.overrides.llm.apiKey));
  }
  if (args.overrides.llm.model) {
    workerArgs.push('--model', String(args.overrides.llm.model));
  }
  if (Number.isFinite(args.overrides.chrome.port)) {
    workerArgs.push('--port', String(args.overrides.chrome.port));
  }
  if (Object.prototype.hasOwnProperty.call(args.overrides.runtime, 'safePacing')) {
    workerArgs.push('--safe-pacing', String(Boolean(args.overrides.runtime.safePacing)));
  }
  if (Object.prototype.hasOwnProperty.call(args.overrides.runtime, 'batchRestEnabled')) {
    workerArgs.push('--batch-rest', String(Boolean(args.overrides.runtime.batchRestEnabled)));
  }

  return workerArgs;
}

async function handleStartRunCommand(args, dataDir) {
  const validateError = validateStartRunArgs(args);
  if (validateError) return validateError;

  const profileStore = new ProfileStore(dataDir);
  const savedProfile = (await profileStore.load(args.profile)) || {};
  const mergedProfile = normalizeProfile({
    ...savedProfile,
    llm: {
      ...(savedProfile.llm || {}),
      ...(args.overrides.llm || {}),
    },
    chrome: {
      ...(savedProfile.chrome || {}),
      ...(args.overrides.chrome || {}),
    },
    runtime: {
      ...(savedProfile.runtime || {}),
      ...(args.overrides.runtime || {}),
    },
  });
  const missingProfileConfig = validateProfile(mergedProfile);
  if (missingProfileConfig.length > 0) {
    return {
      status: 'FAILED',
      error: {
        code: 'PROFILE_CONFIG_MISSING',
        message: `profile 配置缺失：${missingProfileConfig.join(', ')}`,
        retryable: false,
      },
    };
  }

  const runId = createRunId();
  const snapshot = createRunStateSnapshot({
    runId,
    state: RUN_STATE_QUEUED,
    stage: 'preflight',
    lastMessage: '异步任务已创建，等待 detached worker 启动。',
    request: {
      profile: args.profile,
      dryRun: Boolean(args.dryRun),
      noState: Boolean(args.noState),
      input: {
        job: String(args.overrides.jobSelection || ''),
        startFrom: String(args.overrides.startFrom || ''),
        criteria: String(args.overrides.screeningCriteria || ''),
        targetCount: args.overrides.targetCount ?? null,
      },
    },
  });
  writeRunState(dataDir, snapshot);
  appendRunEvent(dataDir, runId, {
    type: 'lifecycle',
    action: 'accepted',
    state: RUN_STATE_QUEUED,
    message: '异步任务已接受。',
  });

  let worker = null;
  try {
    worker = spawn(process.execPath, buildDetachedRunArgs(args, runId), {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    worker.unref();
  } catch (error) {
    const message = `无法启动 detached worker：${error?.message || 'unknown error'}`;
    updateRunState(dataDir, runId, {
      state: RUN_STATE_FAILED,
      stage: 'preflight',
      heartbeatAt: nowIso(),
      lastMessage: message,
      error: {
        code: 'RUN_WORKER_LAUNCH_FAILED',
        message,
        retryable: true,
      },
    });
    return {
      status: 'FAILED',
      run_id: runId,
      error: {
        code: 'RUN_WORKER_LAUNCH_FAILED',
        message,
        retryable: true,
      },
    };
  }

  updateRunState(dataDir, runId, {
    pid: worker?.pid,
    state: RUN_STATE_QUEUED,
    stage: 'preflight',
    heartbeatAt: nowIso(),
    lastMessage: '异步任务已启动（detached）。',
  });
  appendRunEvent(dataDir, runId, {
    type: 'lifecycle',
    action: 'detached-started',
    state: RUN_STATE_QUEUED,
    pid: worker?.pid || null,
    message: 'detached worker 已启动。',
  });

  return {
    status: 'ACCEPTED',
    run_id: runId,
    state: RUN_STATE_QUEUED,
    message: '异步任务已启动。默认不自动查询进度；如需进度请调用 get-run。',
  };
}

function buildRunNotFound(runId) {
  return {
    status: 'FAILED',
    error: {
      code: 'RUN_NOT_FOUND',
      message: `未找到 run_id=${runId} 的运行记录。`,
      retryable: false,
    },
  };
}

function readRunOrError(args, dataDir) {
  const runId = String(args.runId || '').trim();
  if (!runId) {
    return {
      error: {
        status: 'FAILED',
        error: {
          code: 'INVALID_RUN_ID',
          message: 'run_id is required',
          retryable: false,
        },
      },
      runId: '',
      snapshot: null,
    };
  }

  const snapshot = readRunState(dataDir, runId);
  if (!snapshot) {
    return {
      error: buildRunNotFound(runId),
      runId,
      snapshot: null,
    };
  }
  return { error: null, runId, snapshot };
}

function handleGetRunCommand(args, dataDir) {
  const resolved = readRunOrError(args, dataDir);
  if (resolved.error) return resolved.error;

  return {
    status: 'RUN_STATUS',
    run: resolved.snapshot,
    events_path: getRunEventsPath(dataDir, resolved.runId),
    message: '按需查询成功。默认不自动轮询。',
  };
}

function handlePauseRunCommand(args, dataDir) {
  const resolved = readRunOrError(args, dataDir);
  if (resolved.error) return resolved.error;

  if (isTerminalRunState(resolved.snapshot.state)) {
    return {
      status: 'PAUSE_IGNORED',
      run: resolved.snapshot,
      message: '目标任务已结束，无需暂停。',
    };
  }
  if (resolved.snapshot.control?.pauseRequested || resolved.snapshot.state === RUN_STATE_PAUSED) {
    return {
      status: 'PAUSE_IGNORED',
      run: resolved.snapshot,
      message: '目标任务已处于暂停请求中或已暂停。',
    };
  }

  const updated = updateRunState(dataDir, resolved.runId, {
    control: {
      pauseRequested: true,
      cancelRequested: Boolean(resolved.snapshot.control?.cancelRequested),
    },
    lastMessage: '已收到暂停请求，将在安全检查点暂停。',
    heartbeatAt: nowIso(),
  });
  appendRunEvent(dataDir, resolved.runId, {
    type: 'control',
    action: 'pause-requested',
    message: '已写入 pauseRequested=true。',
  });

  return {
    status: 'PAUSE_REQUESTED',
    run: updated || resolved.snapshot,
    message: '暂停请求已接收。',
  };
}

function handleResumeRunCommand(args, dataDir) {
  const resolved = readRunOrError(args, dataDir);
  if (resolved.error) return resolved.error;

  if (isTerminalRunState(resolved.snapshot.state)) {
    return {
      status: 'FAILED',
      error: {
        code: 'RUN_ALREADY_TERMINATED',
        message: '目标任务已结束，无法继续。',
        retryable: false,
      },
      run: resolved.snapshot,
    };
  }

  if (!resolved.snapshot.control?.pauseRequested && resolved.snapshot.state !== RUN_STATE_PAUSED) {
    return {
      status: 'RESUME_IGNORED',
      run: resolved.snapshot,
      message: '目标任务未处于暂停状态。',
    };
  }

  const updated = updateRunState(dataDir, resolved.runId, {
    state:
      resolved.snapshot.state === RUN_STATE_PAUSED ? RUN_STATE_RUNNING : resolved.snapshot.state,
    control: {
      pauseRequested: false,
      cancelRequested: false,
    },
    lastMessage: '已收到继续请求，将恢复执行。',
    heartbeatAt: nowIso(),
  });
  appendRunEvent(dataDir, resolved.runId, {
    type: 'control',
    action: 'resume-requested',
    message: '已写入 pauseRequested=false。',
  });

  return {
    status: 'RESUME_REQUESTED',
    run: updated || resolved.snapshot,
    message: '继续请求已接收。',
  };
}

function handleCancelRunCommand(args, dataDir) {
  const resolved = readRunOrError(args, dataDir);
  if (resolved.error) return resolved.error;

  if (isTerminalRunState(resolved.snapshot.state)) {
    return {
      status: 'CANCEL_IGNORED',
      run: resolved.snapshot,
      message: '目标任务已结束，无需取消。',
    };
  }

  const updated = updateRunState(dataDir, resolved.runId, {
    control: {
      pauseRequested: true,
      cancelRequested: true,
    },
    lastMessage: '已收到取消请求，将在安全检查点停止。',
    heartbeatAt: nowIso(),
  });
  appendRunEvent(dataDir, resolved.runId, {
    type: 'control',
    action: 'cancel-requested',
    message: '已写入 cancelRequested=true。',
  });

  return {
    status: 'CANCEL_REQUESTED',
    run: updated || resolved.snapshot,
    message: '取消请求已接收。',
  };
}

async function executeRunCommand(args, dataDir) {
  const asyncMode = Boolean(args.detachedWorker && args.runId);
  const runId = asyncMode ? String(args.runId || '').trim() : '';

  if (asyncMode && !runId) {
    throw new Error('detached worker mode requires --run-id');
  }

  const runLogger = await createRunLogger(dataDir, {
    runId,
    detachedWorker: asyncMode,
  });
  const logger = runLogger.logger;
  logger.log(
    `运行日志已创建: ${runLogger.logPath} | mode=${asyncMode ? 'detached-worker' : 'interactive'}`,
  );

  const runControl = new RunControl({ logger });
  let cleanupRuntimeControls = () => {};
  let cleanupControlSync = () => {};
  let chromeClient = null;

  try {
    const profileStore = new ProfileStore(dataDir);
    const savedProfile = (await profileStore.load(args.profile)) || {};
    const persistentMerged = normalizeProfile({
      ...savedProfile,
      llm: {
        ...(savedProfile.llm || {}),
        ...(args.overrides.llm || {}),
      },
      chrome: {
        ...(savedProfile.chrome || {}),
        ...(args.overrides.chrome || {}),
      },
      runtime: {
        ...(savedProfile.runtime || {}),
        ...(args.overrides.runtime || {}),
      },
    });
    const persistentProfile = await promptPersistentLlmIfMissing(persistentMerged, args.profile);
    await profileStore.save(args.profile, toPersistentProfile(persistentProfile));

    if (asyncMode) {
      const existing = readRunState(dataDir, runId);
      if (!existing) {
        writeRunState(
          dataDir,
          createRunStateSnapshot({
            runId,
            state: RUN_STATE_QUEUED,
            stage: 'preflight',
            request: {
              profile: args.profile,
              dryRun: Boolean(args.dryRun),
              noState: Boolean(args.noState),
            },
            lastMessage: 'detached worker 直接启动。',
          }),
        );
      }

      updateRunState(dataDir, runId, {
        pid: process.pid,
        state: RUN_STATE_RUNNING,
        stage: 'preflight',
        heartbeatAt: nowIso(),
        logPath: runLogger.logPath,
        lastMessage: 'detached worker 已启动，准备执行。',
      });
      appendRunEvent(dataDir, runId, {
        type: 'lifecycle',
        action: 'worker-boot',
        state: RUN_STATE_RUNNING,
        pid: process.pid,
        message: 'detached worker 已接管任务。',
      });
      cleanupControlSync = startDetachedControlSync({ dataDir, runId, runControl });
    }

    chromeClient = new ChromeClient(persistentProfile.chrome.port);

    const { target, page, recoveredToChatIndex } = await connectBossChatPage(chromeClient);
    logger.log(`已连接 Chrome tab: ${target.title || target.url}`);
    if (recoveredToChatIndex) {
      logger.log(`检测到当前标签不在聊天页，已自动跳转到 ${CHAT_INDEX_URL}`);
    }

    const runProfile = await promptRunProfile({
      page,
      persistentProfile,
      overrides: args.overrides,
    });
    const appliedJob = await page.selectJob(runProfile.jobSelection);
    runProfile.jobSelection = {
      value: appliedJob.value || runProfile.jobSelection.value,
      label: appliedJob.label || runProfile.jobSelection.label,
    };

    if (asyncMode) {
      updateRunState(dataDir, runId, {
        state: RUN_STATE_RUNNING,
        stage: 'preflight',
        heartbeatAt: nowIso(),
        lastMessage: '页面与岗位已就绪，开始执行候选人流程。',
      });
    }

    const interaction = new InteractionController(chromeClient, {
      ...persistentProfile.runtime,
      runControl,
    });
    const llmClient = new LlmClient(runProfile.llm);
    const resumeCaptureService = new ResumeCaptureService({ chromeClient, logger });
    const stateStore = args.noState ? new NoopStateStore() : new StateStore(dataDir, args.profile);
    const reportStore = new ReportStore(dataDir);
    const app = new BossChatApp({
      page,
      llmClient,
      interaction,
      resumeCaptureService,
      stateStore,
      reportStore,
      runControl,
      logger,
      dryRun: args.dryRun,
      artifactRootDir: path.join(dataDir, 'artifacts'),
      onProgress: (progress, meta = {}) => {
        if (!asyncMode) return;
        const nextState = runControl.isPaused() ? RUN_STATE_PAUSED : RUN_STATE_RUNNING;
        const stage = String(meta?.stage || 'running');
        const message = String(
          meta?.message ||
            `进度更新 inspected=${progress.inspected},passed=${progress.passed},requested=${progress.requested}`,
        );
        updateRunState(dataDir, runId, {
          state: nextState,
          stage,
          heartbeatAt: nowIso(),
          progress: {
            inspected: Number(progress.inspected || 0),
            passed: Number(progress.passed || 0),
            requested: Number(progress.requested || 0),
            skipped: Number(progress.skipped || 0),
            errors: Number(progress.errors || 0),
          },
          lastMessage: message,
        });
        appendRunEvent(dataDir, runId, {
          type: 'progress',
          state: nextState,
          stage,
          message,
          progress: {
            inspected: Number(progress.inspected || 0),
            passed: Number(progress.passed || 0),
            requested: Number(progress.requested || 0),
            skipped: Number(progress.skipped || 0),
            errors: Number(progress.errors || 0),
          },
        });
      },
    });

    cleanupRuntimeControls = setupRuntimeControls(runControl);

    logger.log('开始处理 Boss 聊天候选人列表...');
    const targetCountLabel =
      Number.isFinite(Number(runProfile.targetCount)) && Number(runProfile.targetCount) > 0
        ? String(runProfile.targetCount)
        : '扫到底';
    logger.log(
      `本次设置: 岗位=${runProfile.jobSelection.label}, 范围=${runProfile.startFrom === 'all' ? '全部' : '未读'}, 上限=${targetCountLabel}`,
    );
    logger.log('运行中快捷键: p=暂停/继续, r=继续, q=停止, Ctrl+C=停止');

    const summary = await app.run(runProfile);
    logger.log(`已检查: ${summary.inspected}`);
    logger.log(`通过: ${summary.passed}`);
    logger.log(`已求简历: ${summary.requested}`);
    logger.log(`跳过: ${summary.skipped}`);
    logger.log(`错误: ${summary.errors}`);
    if (summary.exhausted) {
      logger.log('候选人列表已没有更多可处理项，提前结束。');
    }
    if (summary.stopped) {
      logger.log(`运行已停止: ${summary.stopReason}`);
    }
    logger.log(`运行报告: ${summary.reportPath}`);

    if (asyncMode) {
      const latest = readRunState(dataDir, runId);
      const canceledRequested = Boolean(latest?.control?.cancelRequested);
      const terminalState =
        summary.stopped || canceledRequested ? RUN_STATE_CANCELED : RUN_STATE_COMPLETED;
      const terminalMessage =
        terminalState === RUN_STATE_CANCELED
          ? `任务已停止：${summary.stopReason || '收到取消请求'}`
          : '任务执行完成。';

      updateRunState(dataDir, runId, {
        state: terminalState,
        stage: 'finalize',
        heartbeatAt: nowIso(),
        progress: {
          inspected: Number(summary.inspected || 0),
          passed: Number(summary.passed || 0),
          requested: Number(summary.requested || 0),
          skipped: Number(summary.skipped || 0),
          errors: Number(summary.errors || 0),
        },
        control: {
          pauseRequested: false,
          cancelRequested: false,
        },
        lastMessage: terminalMessage,
        error: null,
        result: {
          finishedAt: nowIso(),
          reportPath: String(summary.reportPath || ''),
          summary,
        },
      });
      appendRunEvent(dataDir, runId, {
        type: 'lifecycle',
        action: 'terminal',
        state: terminalState,
        message: terminalMessage,
      });
    }
  } catch (error) {
    logger.error(error?.stack || error?.message || String(error));
    error.runLogPath = runLogger.logPath;
    if (asyncMode) {
      const message = error?.message || String(error);
      updateRunState(dataDir, runId, {
        state: RUN_STATE_FAILED,
        stage: 'finalize',
        heartbeatAt: nowIso(),
        logPath: runLogger.logPath,
        lastMessage: message,
        error: {
          code: 'RUN_EXECUTION_FAILED',
          message,
          retryable: true,
        },
      });
      appendRunEvent(dataDir, runId, {
        type: 'lifecycle',
        action: 'failed',
        state: RUN_STATE_FAILED,
        message,
      });
    }
    throw error;
  } finally {
    cleanupControlSync();
    cleanupRuntimeControls();
    if (chromeClient) {
      await chromeClient.close();
    }
    await runLogger.flush();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.join(process.cwd(), '.boss-chat');
  await mkdir(dataDir, { recursive: true });

  if (args.command === 'help') {
    printUsage();
    return;
  }

  if (args.command === 'run') {
    await executeRunCommand(args, dataDir);
    return;
  }

  let payload = null;
  switch (args.command) {
    case 'prepare-run':
      payload = await handlePrepareRunCommand(args, dataDir);
      break;
    case 'start-run':
      payload = await handleStartRunCommand(args, dataDir);
      break;
    case 'get-run':
      payload = handleGetRunCommand(args, dataDir);
      break;
    case 'pause-run':
      payload = handlePauseRunCommand(args, dataDir);
      break;
    case 'resume-run':
      payload = handleResumeRunCommand(args, dataDir);
      break;
    case 'cancel-run':
      payload = handleCancelRunCommand(args, dataDir);
      break;
    default:
      printUsage();
      process.exitCode = 1;
      return;
  }

  outputCommandResult(args, payload);
  if (payload?.status === 'FAILED') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const runLogPath = String(error?.runLogPath || '').trim();
  if (runLogPath) {
    console.error(`执行失败，详细日志见: ${runLogPath}`);
  } else {
    console.error(`执行失败: ${error.message}`);
  }
  process.exitCode = 1;
});
