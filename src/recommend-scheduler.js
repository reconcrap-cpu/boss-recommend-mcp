import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getStateHome } from "./run-state.js";
import {
  compactRecommendRunForStatus,
  getRecommendPipelineRunTool,
  prepareRecommendPipelineRunTool,
  startRecommendPipelineRunTool
} from "./recommend-mcp.js";

const SCHEDULE_WORKER_FLAG = "--schedule-worker";
const SCHEDULE_ID_FLAG = "--schedule-id";
const TERMINAL_SCHEDULE_STATES = new Set(["completed", "failed", "canceled"]);
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "canceled"]);
const SCHEDULE_FORBIDDEN_DEBUG_FIELDS = Object.freeze([
  "debug_test_mode",
  "allow_debug_test_mode",
  "debug_force_list_end_after_processed",
  "debug_force_context_recovery_after_processed",
  "debug_force_cdp_reconnect_after_processed"
]);

let spawnProcessImpl = spawn;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clonePlain(value, fallback = null) {
  try {
    return value === undefined ? fallback : JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function hasOwn(source, key) {
  return Boolean(source && Object.prototype.hasOwnProperty.call(source, key));
}

function collectScheduledRecommendDebugOptions(args = {}) {
  const options = [];
  for (const field of SCHEDULE_FORBIDDEN_DEBUG_FIELDS) {
    if (hasOwn(args, field)) options.push(field);
  }

  const screeningMode = normalizeText(args.screening_mode || args.screeningMode).toLowerCase();
  if (["deterministic", "local", "local_scorer"].includes(screeningMode)) {
    options.push(`screening_mode=${screeningMode}`);
  }
  if (args.use_llm === false || args.useLlm === false) {
    options.push("use_llm=false");
  }
  if (args.allow_card_only_screening === true || args.allowCardOnlyScreening === true) {
    options.push("allow_card_only_screening");
  }
  const detailLimit = Number.parseInt(String(args.detail_limit ?? args.detailLimit ?? ""), 10);
  if (Number.isFinite(detailLimit) && detailLimit === 0) options.push("detail_limit=0");
  if (args.no_filter === true || args.noFilter === true) options.push("no_filter");
  if (args.filter_enabled === false || args.filterEnabled === false) options.push("filter_enabled=false");
  if (args.dry_run_post_action === true || args.dryRunPostAction === true) {
    options.push("dry_run_post_action");
  }
  if (args.dry_run === true || args.dryRun === true) options.push("dry_run");

  const requestedPostAction = normalizeText(
    args.overrides?.post_action
      ?? args.confirmation?.post_action_value
      ?? args.post_action
      ?? args.postAction
  ).toLowerCase();
  if (
    requestedPostAction
    && requestedPostAction !== "none"
    && (args.execute_post_action === false || args.executePostAction === false)
  ) {
    options.push("execute_post_action=false");
  }
  return Array.from(new Set(options));
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNonNegativeNumber(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseRunAt(args = {}) {
  const direct = normalizeText(args.schedule_run_at || args.scheduleRunAt || args.run_at || args.runAt);
  if (direct) {
    const timestamp = Date.parse(direct);
    if (!Number.isFinite(timestamp)) {
      return {
        ok: false,
        error: `Invalid schedule_run_at: ${direct}`
      };
    }
    return {
      ok: true,
      runAtMs: timestamp,
      source: "schedule_run_at"
    };
  }

  const delaySeconds = parseNonNegativeNumber(args.schedule_delay_seconds ?? args.scheduleDelaySeconds, null);
  if (delaySeconds !== null) {
    return {
      ok: true,
      runAtMs: Date.now() + Math.round(delaySeconds * 1000),
      source: "schedule_delay_seconds"
    };
  }

  const delayMinutes = parseNonNegativeNumber(args.schedule_delay_minutes ?? args.scheduleDelayMinutes, null);
  if (delayMinutes !== null) {
    return {
      ok: true,
      runAtMs: Date.now() + Math.round(delayMinutes * 60 * 1000),
      source: "schedule_delay_minutes"
    };
  }

  return {
    ok: false,
    error: "schedule_run_at or schedule_delay_minutes/schedule_delay_seconds is required"
  };
}

function safeIdPart(value) {
  return normalizeText(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function createScheduleId(raw = "") {
  const requested = safeIdPart(raw);
  if (requested) return requested;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `mcp_recommend_schedule_${Date.now().toString(36)}_${suffix}`;
}

function getSchedulesDir() {
  return path.join(getStateHome(), "schedules");
}

function getScheduleArtifacts(scheduleId) {
  const id = safeIdPart(scheduleId);
  if (!id) throw new Error("schedule_id is required");
  return {
    schedule_path: path.join(getSchedulesDir(), `${id}.json`),
    worker_stdout_path: path.join(getSchedulesDir(), `${id}.worker.stdout.log`),
    worker_stderr_path: path.join(getSchedulesDir(), `${id}.worker.stderr.log`)
  };
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return payload;
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readSchedule(scheduleId) {
  const artifacts = getScheduleArtifacts(scheduleId);
  return readJsonFile(artifacts.schedule_path);
}

function writeSchedule(scheduleId, patch) {
  const artifacts = getScheduleArtifacts(scheduleId);
  const current = readJsonFile(artifacts.schedule_path) || {};
  return writeJsonAtomic(artifacts.schedule_path, {
    ...current,
    ...patch,
    schedule_id: scheduleId,
    updated_at: nowIso()
  });
}

function compactScheduleForStatus(schedule) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return schedule || null;
  const compact = clonePlain(schedule, schedule);
  if (compact.run) compact.run = compactRecommendRunForStatus(compact.run);
  if (compact.launch_payload?.run) {
    compact.launch_payload = {
      ...compact.launch_payload,
      run: compactRecommendRunForStatus(compact.launch_payload.run)
    };
  }
  return compact;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stripScheduleArgs(args = {}) {
  const cloned = clonePlain(args, {});
  for (const key of [
    "schedule_id",
    "scheduleId",
    "schedule_run_at",
    "scheduleRunAt",
    "run_at",
    "runAt",
    "schedule_delay_seconds",
    "scheduleDelaySeconds",
    "schedule_delay_minutes",
    "scheduleDelayMinutes"
  ]) {
    delete cloned[key];
  }
  return cloned;
}

function buildFailedSchedulePayload(error, extra = {}) {
  return {
    status: "FAILED",
    schedule_created: false,
    error: {
      code: "RECOMMEND_SCHEDULE_FAILED",
      message: error?.message || String(error || "Unable to schedule recommend run"),
      retryable: true
    },
    ...extra
  };
}

function launchScheduleWorker(scheduleId) {
  const artifacts = getScheduleArtifacts(scheduleId);
  fs.mkdirSync(path.dirname(artifacts.worker_stdout_path), { recursive: true });
  const stdoutFd = fs.openSync(artifacts.worker_stdout_path, "a");
  const stderrFd = fs.openSync(artifacts.worker_stderr_path, "a");
  let child;
  try {
    child = spawnProcessImpl(process.execPath, [
      thisFilePath,
      SCHEDULE_WORKER_FLAG,
      SCHEDULE_ID_FLAG,
      scheduleId
    ], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      env: process.env
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  if (typeof child?.unref === "function") child.unref();
  return {
    pid: child.pid || null,
    stdoutPath: artifacts.worker_stdout_path,
    stderrPath: artifacts.worker_stderr_path
  };
}

export async function scheduleRecommendPipelineRunTool({ workspaceRoot = "", args = {} } = {}) {
  const runArgs = stripScheduleArgs(args);
  const forbiddenDebugOptions = collectScheduledRecommendDebugOptions(runArgs);
  if (forbiddenDebugOptions.length) {
    return {
      status: "FAILED",
      schedule_created: false,
      cron_ready: false,
      error: {
        code: "RECOMMEND_SCHEDULE_DEBUG_OPTIONS_FORBIDDEN",
        message: `Recommend schedules cannot contain diagnostic-only run options: ${forbiddenDebugOptions.join(", ")}`,
        retryable: false
      },
      forbidden_debug_options: forbiddenDebugOptions
    };
  }
  const prepared = prepareRecommendPipelineRunTool({ workspaceRoot, args: runArgs });
  if (prepared.status !== "READY" || prepared.cron_ready !== true) {
    return {
      ...prepared,
      status: prepared.status || "FAILED",
      schedule_created: false,
      cron_ready: false,
      message: "Recommend schedule was not created because the run payload is not READY."
    };
  }

  const due = parseRunAt(args);
  if (!due.ok) {
    return {
      status: "FAILED",
      schedule_created: false,
      cron_ready: true,
      error: {
        code: "INVALID_SCHEDULE_TIME",
        message: due.error,
        retryable: false
      },
      prepare: prepared
    };
  }

  const scheduleId = createScheduleId(args.schedule_id || args.scheduleId);
  const artifacts = getScheduleArtifacts(scheduleId);
  const runAtIso = new Date(due.runAtMs).toISOString();
  const createdAt = nowIso();
  try {
    writeJsonAtomic(artifacts.schedule_path, {
      schedule_id: scheduleId,
      state: "scheduled",
      status: "scheduled",
      created_at: createdAt,
      updated_at: createdAt,
      run_at: runAtIso,
      run_at_ms: due.runAtMs,
      time_source: due.source,
      workspace_root: path.resolve(workspaceRoot || process.cwd()),
      args: runArgs,
      prepare: prepared,
      worker_stdout_path: artifacts.worker_stdout_path,
      worker_stderr_path: artifacts.worker_stderr_path,
      pid: null,
      run_id: null,
      run: null,
      error: null
    });
  } catch (error) {
    return buildFailedSchedulePayload(error, { prepare: prepared });
  }

  let worker;
  try {
    worker = launchScheduleWorker(scheduleId);
  } catch (error) {
    writeSchedule(scheduleId, {
      state: "failed",
      status: "failed",
      error: {
        code: "SCHEDULE_WORKER_LAUNCH_FAILED",
        message: error?.message || String(error || "Unable to launch schedule worker"),
        retryable: true
      }
    });
    return buildFailedSchedulePayload(error, {
      schedule_created: true,
      schedule_id: scheduleId,
      schedule: readSchedule(scheduleId),
      prepare: prepared
    });
  }

  const schedule = writeSchedule(scheduleId, {
    state: "scheduled",
    status: "scheduled",
    pid: worker.pid,
    worker_stdout_path: worker.stdoutPath,
    worker_stderr_path: worker.stderrPath
  });

  return {
    status: "SCHEDULED",
    schedule_created: true,
    cron_ready: true,
    schedule_id: scheduleId,
    run_at: runAtIso,
    run_at_ms: due.runAtMs,
    worker_pid: worker.pid,
    worker_stdout_path: worker.stdoutPath,
    worker_stderr_path: worker.stderrPath,
    schedule,
    prepare: prepared,
    message: "Recommend run schedule created. The package-owned detached scheduler will start the prepared payload at run_at."
  };
}

export function getRecommendScheduledRunTool({ args = {} } = {}) {
  const scheduleId = safeIdPart(args.schedule_id || args.scheduleId);
  if (!scheduleId) {
    return {
      status: "FAILED",
      error: {
        code: "INVALID_SCHEDULE_ID",
        message: "schedule_id is required",
        retryable: false
      }
    };
  }
  const schedule = readSchedule(scheduleId);
  if (!schedule) {
    return {
      status: "FAILED",
      error: {
        code: "SCHEDULE_NOT_FOUND",
        message: `schedule_id=${scheduleId} not found`,
        retryable: false
      }
    };
  }
  let next = schedule;
  if (!TERMINAL_SCHEDULE_STATES.has(normalizeText(schedule.state || schedule.status)) && schedule.pid && !isProcessAlive(schedule.pid)) {
    next = writeSchedule(scheduleId, {
      state: "failed",
      status: "failed",
      completed_at: nowIso(),
      error: {
        code: "SCHEDULE_WORKER_EXITED",
        message: `Scheduled worker process exited before reaching a terminal state (pid=${schedule.pid}).`,
        retryable: true
      }
    });
  }
  return {
    status: "OK",
    schedule_id: scheduleId,
    schedule: compactScheduleForStatus(next)
  };
}

export async function runScheduledRecommendWorker({ scheduleId }) {
  const normalizedScheduleId = safeIdPart(scheduleId);
  if (!normalizedScheduleId) return { ok: false, error: "schedule_id is required" };
  let schedule = readSchedule(normalizedScheduleId);
  if (!schedule) return { ok: false, error: `schedule_id=${normalizedScheduleId} not found` };
  const runAtMs = Number(schedule.run_at_ms);
  if (!Number.isFinite(runAtMs)) {
    writeSchedule(normalizedScheduleId, {
      state: "failed",
      status: "failed",
      completed_at: nowIso(),
      error: {
        code: "INVALID_SCHEDULE_STATE",
        message: "schedule is missing a valid run_at_ms",
        retryable: false
      }
    });
    return { ok: false, error: "schedule is missing a valid run_at_ms" };
  }

  schedule = writeSchedule(normalizedScheduleId, {
    state: "waiting",
    status: "waiting",
    pid: process.pid,
    worker_started_at: nowIso()
  });

  while (Date.now() < runAtMs) {
    await sleep(Math.min(30_000, Math.max(50, runAtMs - Date.now())));
    const latest = readSchedule(normalizedScheduleId);
    if (normalizeText(latest?.state) === "canceled") return { ok: true, canceled: true };
  }

  writeSchedule(normalizedScheduleId, {
    state: "launching",
    status: "launching",
    launch_started_at: nowIso()
  });

  const started = await startRecommendPipelineRunTool({
    workspaceRoot: schedule.workspace_root,
    args: clonePlain(schedule.args, {})
  });
  if (started.status !== "ACCEPTED") {
    writeSchedule(normalizedScheduleId, {
      state: "failed",
      status: "failed",
      completed_at: nowIso(),
      launch_payload: started,
      error: started.error || {
        code: "RECOMMEND_START_NOT_ACCEPTED",
        message: started.status || "start_recommend_pipeline_run did not return ACCEPTED",
        retryable: true
      }
    });
    return { ok: false, error: started.error?.message || started.status || "not accepted" };
  }

  writeSchedule(normalizedScheduleId, {
    state: "running",
    status: "running",
    run_id: started.run_id,
    run: started.run || null,
    launch_payload: started,
    launched_at: nowIso()
  });

  while (true) {
    const payload = getRecommendPipelineRunTool({ args: { run_id: started.run_id } });
    const runState = normalizeText(payload?.run?.state || payload?.run?.status);
    writeSchedule(normalizedScheduleId, {
      state: runState && TERMINAL_RUN_STATES.has(runState) ? runState : "running",
      status: runState && TERMINAL_RUN_STATES.has(runState) ? runState : "running",
      run_id: started.run_id,
      run: payload?.run || null,
      last_poll_at: nowIso(),
      completed_at: runState && TERMINAL_RUN_STATES.has(runState) ? nowIso() : undefined,
      error: runState === "failed" ? (payload?.run?.error || payload?.error || null) : null
    });
    if (TERMINAL_RUN_STATES.has(runState)) break;
    await sleep(1000);
  }
  return { ok: true, run_id: started.run_id };
}

export function __setRecommendSchedulerSpawnForTests(nextImpl) {
  spawnProcessImpl = typeof nextImpl === "function" ? nextImpl : spawn;
}

function parseScheduleWorkerOptions(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || !argv.includes(SCHEDULE_WORKER_FLAG)) return null;
  const idIndex = argv.indexOf(SCHEDULE_ID_FLAG);
  return {
    scheduleId: idIndex >= 0 ? normalizeText(argv[idIndex + 1]) : ""
  };
}

const thisFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFilePath) {
  const options = parseScheduleWorkerOptions(process.argv.slice(2));
  if (options) {
    runScheduledRecommendWorker(options).then((result) => {
      if (!result?.ok) process.exitCode = 1;
    }).catch((error) => {
      try {
        writeSchedule(options.scheduleId, {
          state: "failed",
          status: "failed",
          completed_at: nowIso(),
          error: {
            code: "SCHEDULE_WORKER_UNHANDLED_ERROR",
            message: error?.message || String(error || "schedule worker failed"),
            retryable: true
          }
        });
      } catch {}
      console.error("[boss-recommend-mcp] scheduled recommend worker failed", error);
      process.exitCode = 1;
    });
  }
}
