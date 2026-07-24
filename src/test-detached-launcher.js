import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import {
  buildWindowsCimEncodedCommand,
  launchDetachedWorker,
  quoteWindowsCommandLineArgument
} from "./core/run/detached-launcher.js";
import { createBossMonitorSourceMarker } from "./monitor/projection.js";
import {
  createRunStateSnapshot,
  readRunState,
  writeRunState
} from "./run-state.js";

function testWindowsArgumentQuoting() {
  assert.equal(quoteWindowsCommandLineArgument("plain"), "plain");
  assert.equal(
    quoteWindowsCommandLineArgument("C:\\Program Files\\nodejs\\node.exe"),
    '"C:\\Program Files\\nodejs\\node.exe"'
  );
  assert.equal(quoteWindowsCommandLineArgument('a"b'), '"a\\"b"');
  assert.equal(quoteWindowsCommandLineArgument("C:\\path with space\\"), '"C:\\path with space\\\\"');
  const encoded = buildWindowsCimEncodedCommand('"C:\\Program Files\\node.exe" worker.js');
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(decoded, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(decoded, /ConvertTo-Json -Compress/);
}

function testWindowsCimLaunchUsesOnlyControlledArguments() {
  const observed = {};
  const preparedLogs = [];
  const child = launchDetachedWorker({
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    workerScriptPath: "C:\\Program Files\\boss-recommend-mcp\\src\\detached-worker.js",
    wrapperScriptPath: "C:\\Program Files\\boss-recommend-mcp\\src\\core\\run\\windows-detached-worker.ps1",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    domain: "chat",
    runId: "mcp_chat_safe-123",
    stdoutPath: "C:\\Temp\\worker.stdout.log",
    stderrPath: "C:\\Temp\\worker.stderr.log",
    recommendRuntimeHomePath: "C:\\Users\\tester\\.boss-recommend-mcp",
    recruitRuntimeHomePath: "C:\\Users\\tester\\.boss-recruit-mcp",
    chatRuntimeHomePath: "C:\\Users\\tester\\.boss-recommend-mcp\\boss-chat",
    screenConfigPath: "C:\\Users\\tester\\.boss-recommend-mcp\\screening-config.json",
    environment: {
      BOSS_MONITOR_HOME: "C:\\Users\\tester\\boss-monitor-projection",
      RECRUITING_MONITOR_HOME: "C:\\Users\\tester\\recruiting-monitor",
      BOSS_MONITORING_ENABLED: "off"
    },
    prepareLogFileImpl: (filePath) => preparedLogs.push(filePath),
    spawnSyncImpl(command, args, options) {
      observed.command = command;
      observed.args = args;
      observed.options = options;
      return {
        status: 0,
        stdout: 'notice\r\n{"return_value":0,"process_id":43210}',
        stderr: ""
      };
    }
  });
  assert.equal(child.pid, 43210);
  assert.equal(typeof child.unref, "function");
  assert.equal(child.once, undefined);
  assert.deepEqual(preparedLogs, ["C:\\Temp\\worker.stdout.log", "C:\\Temp\\worker.stderr.log"]);
  assert.equal(observed.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(observed.args.slice(0, 5), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand"
  ]);
  assert.equal(observed.options.windowsHide, true);
  const script = Buffer.from(observed.args[5], "base64").toString("utf16le");
  assert.match(script, /Win32_Process/);
  assert.match(script, /windows-detached-worker\.ps1/);
  assert.match(script, /-Domain chat/);
  assert.match(script, /-RunId mcp_chat_safe-123/);
  assert.match(script, /-LaunchId mcp_chat_safe-123/);
  assert.match(script, /-ExitStatusPath/);
  assert.match(script, /C:\\Temp\\worker\.stderr\.log\.exit\.json/);
  assert.match(script, /-RecommendRuntimeHomePath/);
  assert.match(script, /C:\\Users\\tester\\\.boss-recommend-mcp/);
  assert.match(script, /-RecruitRuntimeHomePath/);
  assert.match(script, /C:\\Users\\tester\\\.boss-recruit-mcp/);
  assert.match(script, /-ChatRuntimeHomePath/);
  assert.match(script, /C:\\Users\\tester\\\.boss-recommend-mcp\\boss-chat/);
  assert.match(script, /-ScreenConfigPath/);
  assert.match(script, /C:\\Users\\tester\\\.boss-recommend-mcp\\screening-config\.json/);
  assert.match(script, /-BossMonitorHomePath/);
  assert.match(script, /C:\\Users\\tester\\boss-monitor-projection/);
  assert.match(script, /-RecruitingMonitorHomePath/);
  assert.match(script, /C:\\Users\\tester\\recruiting-monitor/);
  assert.match(script, /-BossMonitoringEnabled false/);
  assert.doesNotMatch(script, /criteria|api[_-]?key|greeting/i);

  const wrapperSource = fs.readFileSync(
    new URL("./core/run/windows-detached-worker.ps1", import.meta.url),
    "utf8"
  );
  assert.match(wrapperSource, /EnvironmentVariables\['BOSS_CHAT_HOME'\]/);
  assert.match(wrapperSource, /EnvironmentVariables\['BOSS_RECOMMEND_SCREEN_CONFIG'\]/);
  assert.match(wrapperSource, /EnvironmentVariables\['BOSS_RECOMMEND_HOME'\]/);
  assert.match(wrapperSource, /EnvironmentVariables\['BOSS_RECRUIT_HOME'\]/);
  assert.match(wrapperSource, /EnvironmentVariables\['BOSS_MONITOR_HOME'\]/);
  assert.match(wrapperSource, /EnvironmentVariables\['RECRUITING_MONITOR_HOME'\]/);
  assert.match(wrapperSource, /EnvironmentVariables\['BOSS_MONITORING_ENABLED'\]/);
  assert.match(wrapperSource, /Write-WorkerExitStatus/);
  assert.match(wrapperSource, /--record-exit/);
  assert.match(wrapperSource, /Invoke-ExitRecorder -ObservedExitCode 1/);
}

function testWindowsCimFailuresAreExplicit() {
  const common = {
    platform: "win32",
    nodePath: "C:\\node.exe",
    workerScriptPath: "C:\\worker.js",
    wrapperScriptPath: "C:\\windows-detached-worker.ps1",
    powershellPath: "C:\\powershell.exe",
    domain: "chat",
    runId: "mcp_chat_safe",
    stdoutPath: "C:\\logs\\stdout.log",
    stderrPath: "C:\\logs\\stderr.log",
    prepareLogFileImpl() {}
  };
  assert.throws(() => launchDetachedWorker({
    ...common,
    spawnSyncImpl: () => ({
      status: 1,
      stdout: '{"return_value":5,"process_id":0}',
      stderr: "access denied"
    })
  }), (error) => error?.code === "WINDOWS_CIM_CREATE_FAILED");
  assert.throws(() => launchDetachedWorker({
    ...common,
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "CIM unavailable" })
  }), (error) => error?.code === "WINDOWS_CIM_LAUNCH_FAILED" && /CIM unavailable/.test(error.message));
  assert.throws(() => launchDetachedWorker({
    ...common,
    runId: "unsafe run id",
    spawnSyncImpl: () => ({ status: 0, stdout: '{"return_value":0,"process_id":1}', stderr: "" })
  }), (error) => error?.code === "DETACHED_WORKER_ARGUMENT_INVALID");
  assert.throws(() => launchDetachedWorker({
    ...common,
    domain: "arbitrary"
  }), (error) => error?.code === "DETACHED_WORKER_ARGUMENT_INVALID");
  assert.throws(() => launchDetachedWorker({
    ...common,
    exitStatusPath: "relative-exit.json"
  }), (error) => error?.code === "DETACHED_WORKER_PATH_INVALID");
  assert.throws(() => launchDetachedWorker({
    ...common,
    bossMonitorHomePath: "relative-monitor-home"
  }), (error) => error?.code === "DETACHED_WORKER_PATH_INVALID");
  let relativeEnvironmentScript = "";
  assert.doesNotThrow(() => launchDetachedWorker({
    ...common,
    environment: {
      BOSS_MONITOR_HOME: "relative-monitor-home",
      RECRUITING_MONITOR_HOME: "relative-monitor-runtime",
      BOSS_MONITORING_ENABLED: "false"
    },
    spawnSyncImpl: (_command, args) => {
      relativeEnvironmentScript = Buffer.from(args[5], "base64").toString("utf16le");
      return {
        status: 0,
        stdout: '{"return_value":0,"process_id":321}',
        stderr: ""
      };
    }
  }));
  assert.equal(
    relativeEnvironmentScript.includes(path.win32.resolve("relative-monitor-home")),
    true
  );
  assert.equal(
    relativeEnvironmentScript.includes(path.win32.resolve("relative-monitor-runtime")),
    true
  );
  let invalidEnvironmentScript = "";
  assert.doesNotThrow(() => launchDetachedWorker({
    ...common,
    environment: {
      BOSS_MONITOR_HOME: "invalid\nmonitor-home",
      BOSS_MONITORING_ENABLED: "true"
    },
    spawnSyncImpl: (_command, args) => {
      invalidEnvironmentScript = Buffer.from(args[5], "base64").toString("utf16le");
      return {
        status: 0,
        stdout: '{"return_value":0,"process_id":322}',
        stderr: ""
      };
    }
  }));
  assert.doesNotMatch(invalidEnvironmentScript, /-BossMonitorHomePath/);
  assert.match(invalidEnvironmentScript, /-BossMonitoringEnabled false/);
}

async function waitUntil(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function removeTempDirBestEffort(tempDir) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(error?.code)) throw error;
  }
}

async function testWindowsSupervisorPersistsObservedExitSidecar() {
  if (process.platform !== "win32") return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-windows-supervisor-test-"));
  const workerScriptPath = path.join(tempDir, "exit-23-worker.mjs");
  const stdoutPath = path.join(tempDir, "worker.stdout.log");
  const stderrPath = path.join(tempDir, "worker.stderr.log");
  const exitStatusPath = path.join(tempDir, "worker.exit.json");
  fs.writeFileSync(workerScriptPath, "process.exit(23);\n", "utf8");
  let child = null;
  try {
    child = launchDetachedWorker({
      nodePath: process.execPath,
      workerScriptPath,
      domain: "recommend",
      runId: "mcp_recommend_exit_sidecar_test",
      stdoutPath,
      stderrPath,
      exitStatusPath
    });
    assert.equal(await waitUntil(() => fs.existsSync(exitStatusPath)), true);
    const payload = JSON.parse(fs.readFileSync(exitStatusPath, "utf8"));
    assert.equal(payload.schema_version, 1);
    assert.equal(payload.domain, "recommend");
    assert.equal(payload.run_id, "mcp_recommend_exit_sidecar_test");
    assert.equal(payload.launch_id, "mcp_recommend_exit_sidecar_test");
    assert.equal(payload.wrapper_pid, child.pid);
    assert.equal(Number.isInteger(payload.worker_pid), true);
    assert.equal(payload.exit_code, 23);
    assert.equal(payload.nonzero, true);
    assert.equal(payload.termination_kind, "observed_child_exit");
    assert.equal(Number.isFinite(Date.parse(payload.started_at)), true);
    assert.equal(Number.isFinite(Date.parse(payload.exited_at)), true);
    assert.equal(
      await waitUntil(() => {
        try {
          process.kill(child.pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
      true
    );
    assert.equal(fs.readdirSync(tempDir).some((name) => name.includes(".tmp.")), false);
  } finally {
    removeTempDirBestEffort(tempDir);
  }
}

async function testWindowsSupervisorPropagatesMonitorEnvironment() {
  if (process.platform !== "win32") return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-windows-monitor-env-test-"));
  const workerScriptPath = path.join(tempDir, "capture-monitor-env.mjs");
  const workerEnvironmentPath = path.join(tempDir, "worker-monitor-env.json");
  const recorderEnvironmentPath = path.join(tempDir, "recorder-monitor-env.json");
  const stdoutPath = path.join(tempDir, "worker.stdout.log");
  const stderrPath = path.join(tempDir, "worker.stderr.log");
  const exitStatusPath = path.join(tempDir, "worker.exit.json");
  const recommendRuntimeHome = path.join(tempDir, "boss-recommend");
  const recruitRuntimeHome = path.join(tempDir, "boss-recruit");
  const bossMonitorHome = path.join(tempDir, "boss-monitor-projection");
  const recruitingMonitorHome = path.join(tempDir, "recruiting-monitor");
  fs.writeFileSync(workerScriptPath, [
    'import fs from "node:fs";',
    `const outputPath = process.argv.includes("--record-exit")`
      + ` ? ${JSON.stringify(recorderEnvironmentPath)} : ${JSON.stringify(workerEnvironmentPath)};`,
    "fs.writeFileSync(outputPath, JSON.stringify({",
    "  recommend_runtime_home: process.env.BOSS_RECOMMEND_HOME || null,",
    "  recruit_runtime_home: process.env.BOSS_RECRUIT_HOME || null,",
    "  boss_monitor_home: process.env.BOSS_MONITOR_HOME || null,",
    "  recruiting_monitor_home: process.env.RECRUITING_MONITOR_HOME || null,",
    "  monitoring_enabled: process.env.BOSS_MONITORING_ENABLED || null",
    '}), "utf8");'
  ].join("\n"), "utf8");
  try {
    launchDetachedWorker({
      nodePath: process.execPath,
      workerScriptPath,
      domain: "recommend",
      runId: "mcp_recommend_monitor_env_test",
      stdoutPath,
      stderrPath,
      exitStatusPath,
      recommendRuntimeHomePath: recommendRuntimeHome,
      recruitRuntimeHomePath: recruitRuntimeHome,
      environment: {
        ...process.env,
        BOSS_MONITOR_HOME: bossMonitorHome,
        RECRUITING_MONITOR_HOME: recruitingMonitorHome,
        BOSS_MONITORING_ENABLED: "true"
      }
    });
    assert.equal(
      await waitUntil(() => (
        fs.existsSync(exitStatusPath)
        && fs.existsSync(workerEnvironmentPath)
        && fs.existsSync(recorderEnvironmentPath)
      )),
      true
    );
    const expected = {
      recommend_runtime_home: recommendRuntimeHome,
      recruit_runtime_home: recruitRuntimeHome,
      boss_monitor_home: bossMonitorHome,
      recruiting_monitor_home: recruitingMonitorHome,
      monitoring_enabled: "true"
    };
    assert.deepEqual(JSON.parse(fs.readFileSync(workerEnvironmentPath, "utf8")), expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(recorderEnvironmentPath, "utf8")), expected);
  } finally {
    removeTempDirBestEffort(tempDir);
  }
}

async function testWindowsSupervisorPersistsForcedWorkerTermination() {
  if (process.platform !== "win32") return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-windows-supervisor-kill-test-"));
  const workerScriptPath = path.join(tempDir, "long-running-worker.mjs");
  const workerPidPath = path.join(tempDir, "worker.pid");
  const stdoutPath = path.join(tempDir, "worker.stdout.log");
  const stderrPath = path.join(tempDir, "worker.stderr.log");
  const exitStatusPath = path.join(tempDir, "worker.exit.json");
  fs.writeFileSync(workerScriptPath, [
    'import fs from "node:fs";',
    'if (process.argv.includes("--record-exit")) process.exit(0);',
    `fs.writeFileSync(${JSON.stringify(workerPidPath)}, String(process.pid), "utf8");`,
    'console.log("worker-ready");',
    'setInterval(() => {}, 1000);'
  ].join("\n"), "utf8");
  let supervisor = null;
  let workerPid = null;
  try {
    supervisor = launchDetachedWorker({
      nodePath: process.execPath,
      workerScriptPath,
      domain: "recommend",
      runId: "mcp_recommend_forced_worker_termination_test",
      stdoutPath,
      stderrPath,
      exitStatusPath
    });
    assert.equal(await waitUntil(() => fs.existsSync(workerPidPath)), true);
    workerPid = Number.parseInt(fs.readFileSync(workerPidPath, "utf8"), 10);
    assert.equal(Number.isInteger(workerPid) && workerPid > 0, true);
    assert.notEqual(workerPid, supervisor.pid);
    assert.equal(
      await waitUntil(() => fs.existsSync(stdoutPath) && fs.readFileSync(stdoutPath, "utf8").includes("worker-ready")),
      true
    );
    process.kill(workerPid);
    assert.equal(await waitUntil(() => fs.existsSync(exitStatusPath)), true);
    const payload = JSON.parse(fs.readFileSync(exitStatusPath, "utf8"));
    assert.equal(payload.domain, "recommend");
    assert.equal(payload.run_id, "mcp_recommend_forced_worker_termination_test");
    assert.equal(payload.launch_id, "mcp_recommend_forced_worker_termination_test");
    assert.equal(payload.wrapper_pid, supervisor.pid);
    assert.equal(payload.worker_pid, workerPid);
    assert.notEqual(payload.exit_code, 0);
    assert.equal(payload.nonzero, true);
    assert.equal(payload.termination_kind, "observed_child_exit");
    assert.equal(
      await waitUntil(() => {
        try {
          process.kill(supervisor.pid, 0);
          return false;
        } catch {
          return true;
        }
      }),
      true
    );
  } finally {
    if (workerPid) {
      try { process.kill(workerPid); } catch {}
    }
    if (supervisor?.pid) {
      try { process.kill(supervisor.pid); } catch {}
    }
    removeTempDirBestEffort(tempDir);
  }
}

async function testWindowsSupervisorPersistsWrapperFailure() {
  if (process.platform !== "win32") return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-windows-supervisor-wrapper-test-"));
  const missingNodePath = path.join(tempDir, "missing-node.exe");
  const workerScriptPath = path.join(tempDir, "unused-worker.mjs");
  const stdoutPath = path.join(tempDir, "worker.stdout.log");
  const stderrPath = path.join(tempDir, "worker.stderr.log");
  const exitStatusPath = path.join(tempDir, "worker.exit.json");
  fs.writeFileSync(workerScriptPath, "process.exit(0);\n", "utf8");
  let supervisor = null;
  try {
    supervisor = launchDetachedWorker({
      nodePath: missingNodePath,
      workerScriptPath,
      domain: "recommend",
      runId: "mcp_recommend_wrapper_failure_test",
      stdoutPath,
      stderrPath,
      exitStatusPath
    });
    assert.equal(await waitUntil(() => fs.existsSync(exitStatusPath)), true);
    const payload = JSON.parse(fs.readFileSync(exitStatusPath, "utf8"));
    assert.equal(payload.domain, "recommend");
    assert.equal(payload.run_id, "mcp_recommend_wrapper_failure_test");
    assert.equal(payload.launch_id, "mcp_recommend_wrapper_failure_test");
    assert.equal(payload.wrapper_pid, supervisor.pid);
    assert.equal(payload.worker_pid, null);
    assert.equal(payload.exit_code, 1);
    assert.equal(payload.nonzero, true);
    assert.equal(payload.termination_kind, "wrapper_error");
    assert.equal(typeof payload.wrapper_error, "string");
    assert.equal(payload.wrapper_error.length > 0, true);
  } finally {
    if (supervisor?.pid) {
      try { process.kill(supervisor.pid); } catch {}
    }
    removeTempDirBestEffort(tempDir);
  }
}

async function testWindowsSupervisorReconcilesWrapperFailureWhenRecorderAvailable() {
  if (process.platform !== "win32") return;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-windows-wrapper-reconcile-test-"));
  const recommendRuntimeHome = path.join(tempDir, "boss-recommend");
  const bossMonitorHome = path.join(tempDir, "boss-monitor-projection");
  const blockedLogParent = path.join(tempDir, "stdout-parent-is-a-file");
  const stdoutPath = path.join(blockedLogParent, "worker.stdout.log");
  const stderrPath = path.join(tempDir, "worker.stderr.log");
  const exitStatusPath = path.join(tempDir, "worker.exit.json");
  const workerScriptPath = fileURLToPath(new URL("./detached-worker.js", import.meta.url));
  const runId = "mcp_recommend_wrapper_reconcile_test";
  const launchId = "wrapper-reconcile-launch";
  const publicRunDir = path.join(
    bossMonitorHome,
    "v1",
    "runs",
    "recommend",
    runId
  );
  const previousEnvironment = {
    BOSS_RECOMMEND_HOME: process.env.BOSS_RECOMMEND_HOME,
    BOSS_MONITOR_HOME: process.env.BOSS_MONITOR_HOME,
    BOSS_MONITORING_ENABLED: process.env.BOSS_MONITORING_ENABLED
  };
  let supervisor = null;
  try {
    process.env.BOSS_RECOMMEND_HOME = recommendRuntimeHome;
    process.env.BOSS_MONITOR_HOME = bossMonitorHome;
    process.env.BOSS_MONITORING_ENABLED = "true";
    fs.writeFileSync(blockedLogParent, "not a directory\n", "utf8");

    const monitoringV1 = createBossMonitorSourceMarker();
    assert.ok(monitoringV1, "test run should receive a valid V1 monitor marker");
    writeRunState(createRunStateSnapshot({
      runId,
      mode: "async",
      state: "queued",
      lastMessage: "Waiting for the detached wrapper.",
      resume: {
        worker_launch_id: launchId,
        worker_launch_committed: false
      },
      monitoringV1
    }));

    supervisor = launchDetachedWorker({
      nodePath: process.execPath,
      workerScriptPath,
      domain: "recommend",
      runId,
      launchId,
      stdoutPath,
      stderrPath,
      exitStatusPath,
      recommendRuntimeHomePath: recommendRuntimeHome,
      bossMonitorHomePath: bossMonitorHome,
      bossMonitoringEnabled: "true",
      // Deliberately leave the invalid log parent for the detached PowerShell
      // wrapper. This exercises its outer catch after Node and the worker
      // script have both been validated and remain available to the recorder.
      prepareLogFileImpl() {}
    });

    assert.equal(
      await waitUntil(() => {
        const state = readRunState(runId);
        return state?.state === "failed"
          && fs.existsSync(path.join(publicRunDir, "snapshot.json"))
          && fs.existsSync(path.join(publicRunDir, "worker-exit.json"));
      }),
      true,
      "wrapper failure should be reconciled into legacy and public terminal state"
    );

    const legacyState = readRunState(runId);
    assert.equal(legacyState.state, "failed");
    assert.equal(legacyState.error?.code, "DETACHED_WORKER_EXITED_EARLY");
    assert.equal(legacyState.error?.worker_launch_id, launchId);
    assert.equal(legacyState.error?.diagnostic_source, "windows_cim_supervisor");
    assert.equal(legacyState.error?.worker_pid, undefined);

    const wrapperExit = JSON.parse(fs.readFileSync(exitStatusPath, "utf8"));
    assert.equal(wrapperExit.termination_kind, "wrapper_error");
    assert.equal(wrapperExit.worker_pid, null);
    assert.equal(wrapperExit.exit_code, 1);

    const publicSnapshot = JSON.parse(
      fs.readFileSync(path.join(publicRunDir, "snapshot.json"), "utf8")
    );
    assert.equal(publicSnapshot.state, "failed");
    assert.equal(publicSnapshot.errors?.[0]?.code, "DETACHED_WORKER_EXITED_EARLY");
    const publicExit = JSON.parse(
      fs.readFileSync(path.join(publicRunDir, "worker-exit.json"), "utf8")
    );
    assert.equal(publicExit.state, "failed");
    assert.equal(publicExit.ref?.run_id, runId);
    const events = fs.readFileSync(path.join(publicRunDir, "events.ndjson"), "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "run.error"), true);
  } finally {
    if (supervisor?.pid) {
      try { process.kill(supervisor.pid); } catch {}
    }
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    removeTempDirBestEffort(tempDir);
  }
}

function testPosixLaunchUsesNormalizedControlledEnvironment() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-posix-launcher-test-"));
  const stdoutPath = path.join(tempDir, "worker.stdout.log");
  const stderrPath = path.join(tempDir, "worker.stderr.log");
  const recommendRuntimeHome = path.join(tempDir, "boss-recommend");
  const recruitRuntimeHome = path.join(tempDir, "boss-recruit");
  const chatRuntimeHome = path.join(tempDir, "boss-chat");
  const screenConfigPath = path.join(tempDir, "screening-config.json");
  const relativeBossMonitorHome = path.join("relative", "boss-monitor-projection");
  const relativeRecruitingMonitorHome = path.join("relative", "recruiting-monitor");
  const sourceEnvironment = {
    SAFE_TEST: "1",
    BOSS_MONITOR_HOME: relativeBossMonitorHome,
    RECRUITING_MONITOR_HOME: relativeRecruitingMonitorHome,
    BOSS_MONITORING_ENABLED: "OFF",
    BOSS_RECOMMEND_HOME: "stale-recommend-home",
    BOSS_RECRUIT_HOME: "stale-recruit-home",
    BOSS_CHAT_HOME: "stale-chat-home",
    BOSS_RECOMMEND_SCREEN_CONFIG: "stale-screen-config"
  };
  const observed = {};
  const expectedChild = new EventEmitter();
  expectedChild.pid = 99;
  try {
    const child = launchDetachedWorker({
      platform: "linux",
      nodePath: "/usr/bin/node",
      workerScriptPath: "/opt/boss/src/detached-worker.js",
      domain: "chat",
      runId: "mcp_chat_safe",
      stdoutPath,
      stderrPath,
      recommendRuntimeHomePath: recommendRuntimeHome,
      recruitRuntimeHomePath: recruitRuntimeHome,
      chatRuntimeHomePath: chatRuntimeHome,
      screenConfigPath,
      environment: sourceEnvironment,
      spawnImpl(command, args, options) {
        observed.command = command;
        observed.args = args;
        observed.options = options;
        return expectedChild;
      }
    });
    assert.equal(child, expectedChild);
    assert.equal(observed.command, "/usr/bin/node");
    assert.deepEqual(observed.args, [
      "/opt/boss/src/detached-worker.js",
      "--domain",
      "chat",
      "--run-id",
      "mcp_chat_safe",
      "--launch-id",
      "mcp_chat_safe"
    ]);
    assert.equal(observed.options.detached, true);
    assert.equal(observed.options.stdio[0], "ignore");
    assert.equal(Number.isInteger(observed.options.stdio[1]), true);
    assert.equal(Number.isInteger(observed.options.stdio[2]), true);
    assert.notEqual(observed.options.env, sourceEnvironment);
    assert.deepEqual(observed.options.env, {
      SAFE_TEST: "1",
      BOSS_MONITOR_HOME: path.resolve(relativeBossMonitorHome),
      RECRUITING_MONITOR_HOME: path.resolve(relativeRecruitingMonitorHome),
      BOSS_MONITORING_ENABLED: "false",
      BOSS_RECOMMEND_HOME: recommendRuntimeHome,
      BOSS_RECRUIT_HOME: recruitRuntimeHome,
      BOSS_CHAT_HOME: chatRuntimeHome,
      BOSS_RECOMMEND_SCREEN_CONFIG: screenConfigPath
    });
    assert.equal(sourceEnvironment.BOSS_MONITOR_HOME, relativeBossMonitorHome);
    assert.equal(sourceEnvironment.BOSS_MONITORING_ENABLED, "OFF");
    assert.equal(fs.existsSync(stdoutPath), true);
    assert.equal(fs.existsSync(stderrPath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testPosixLaunchFailsClosedForInvalidMonitoringEnvironment() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-posix-launcher-invalid-env-test-"));
  const stdoutPath = path.join(tempDir, "worker.stdout.log");
  const stderrPath = path.join(tempDir, "worker.stderr.log");
  const recruitRuntimeHome = path.join(tempDir, "boss-recruit");
  const relativeRecruitingMonitorHome = path.join("relative", "recruiting-monitor");
  const sourceEnvironment = {
    SAFE_TEST: "2",
    BOSS_MONITOR_HOME: "invalid\nmonitor-home",
    RECRUITING_MONITOR_HOME: relativeRecruitingMonitorHome,
    BOSS_MONITORING_ENABLED: "true"
  };
  let observedEnvironment = null;
  const expectedChild = new EventEmitter();
  expectedChild.pid = 100;
  try {
    const child = launchDetachedWorker({
      platform: "linux",
      nodePath: "/usr/bin/node",
      workerScriptPath: "/opt/boss/src/detached-worker.js",
      domain: "recruit",
      runId: "mcp_recruit_safe",
      stdoutPath,
      stderrPath,
      recruitRuntimeHomePath: recruitRuntimeHome,
      environment: sourceEnvironment,
      spawnImpl(_command, _args, options) {
        observedEnvironment = options.env;
        return expectedChild;
      }
    });
    assert.equal(child, expectedChild);
    assert.notEqual(observedEnvironment, sourceEnvironment);
    assert.equal(Object.hasOwn(observedEnvironment, "BOSS_MONITOR_HOME"), false);
    assert.equal(
      observedEnvironment.RECRUITING_MONITOR_HOME,
      path.resolve(relativeRecruitingMonitorHome)
    );
    assert.equal(observedEnvironment.BOSS_MONITORING_ENABLED, "false");
    assert.equal(observedEnvironment.BOSS_RECRUIT_HOME, recruitRuntimeHome);
    assert.equal(observedEnvironment.SAFE_TEST, "2");
    assert.equal(sourceEnvironment.BOSS_MONITOR_HOME, "invalid\nmonitor-home");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testWindowsArgumentQuoting();
testWindowsCimLaunchUsesOnlyControlledArguments();
testWindowsCimFailuresAreExplicit();
testPosixLaunchUsesNormalizedControlledEnvironment();
testPosixLaunchFailsClosedForInvalidMonitoringEnvironment();
await testWindowsSupervisorPersistsObservedExitSidecar();
await testWindowsSupervisorPropagatesMonitorEnvironment();
await testWindowsSupervisorPersistsForcedWorkerTermination();
await testWindowsSupervisorPersistsWrapperFailure();
await testWindowsSupervisorReconcilesWrapperFailureWhenRecorderAvailable();
console.log("detached launcher tests passed");
