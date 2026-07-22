import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  buildWindowsCimEncodedCommand,
  launchDetachedWorker,
  quoteWindowsCommandLineArgument
} from "./core/run/detached-launcher.js";

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
    chatRuntimeHomePath: "C:\\Users\\tester\\.boss-recommend-mcp\\boss-chat",
    screenConfigPath: "C:\\Users\\tester\\.boss-recommend-mcp\\screening-config.json",
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
  assert.match(script, /-ChatRuntimeHomePath/);
  assert.match(script, /C:\\Users\\tester\\\.boss-recommend-mcp\\boss-chat/);
  assert.match(script, /-ScreenConfigPath/);
  assert.match(script, /C:\\Users\\tester\\\.boss-recommend-mcp\\screening-config\.json/);
  assert.doesNotMatch(script, /criteria|api[_-]?key|greeting/i);

  const wrapperSource = fs.readFileSync(
    new URL("./core/run/windows-detached-worker.ps1", import.meta.url),
    "utf8"
  );
  assert.match(wrapperSource, /EnvironmentVariables\['BOSS_CHAT_HOME'\]/);
  assert.match(wrapperSource, /EnvironmentVariables\['BOSS_RECOMMEND_SCREEN_CONFIG'\]/);
  assert.match(wrapperSource, /EnvironmentVariables\['BOSS_RECOMMEND_HOME'\]/);
  assert.match(wrapperSource, /Write-WorkerExitStatus/);
  assert.match(wrapperSource, /--record-exit/);
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

function testPosixLaunchRetainsExistingSpawnContract() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-posix-launcher-test-"));
  const stdoutPath = path.join(tempDir, "worker.stdout.log");
  const stderrPath = path.join(tempDir, "worker.stderr.log");
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
      environment: { SAFE_TEST: "1" },
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
    assert.deepEqual(observed.options.env, { SAFE_TEST: "1" });
    assert.equal(fs.existsSync(stdoutPath), true);
    assert.equal(fs.existsSync(stderrPath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testWindowsArgumentQuoting();
testWindowsCimLaunchUsesOnlyControlledArguments();
testWindowsCimFailuresAreExplicit();
testPosixLaunchRetainsExistingSpawnContract();
await testWindowsSupervisorPersistsObservedExitSidecar();
await testWindowsSupervisorPersistsForcedWorkerTermination();
await testWindowsSupervisorPersistsWrapperFailure();
console.log("detached launcher tests passed");
