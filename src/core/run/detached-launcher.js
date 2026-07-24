import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WINDOWS_WRAPPER_PATH = fileURLToPath(new URL("./windows-detached-worker.ps1", import.meta.url));
const SAFE_DOMAIN_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SAFE_DOMAINS = new Set(["chat", "recommend", "recruit"]);
const MONITORING_DISABLED_VALUES = new Set(["0", "false", "off", "disabled", "no"]);

function createLauncherError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function ensureLogFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.closeSync(fs.openSync(filePath, "a"));
}

function assertControlledPath(value, label, platform) {
  const normalized = String(value || "");
  const pathApi = platform === "win32" ? path.win32 : path;
  if (!normalized || !pathApi.isAbsolute(normalized)) {
    throw createLauncherError("DETACHED_WORKER_PATH_INVALID", `${label} must be an absolute path`);
  }
  if (/[\0\r\n"]/.test(normalized)) {
    throw createLauncherError("DETACHED_WORKER_PATH_INVALID", `${label} contains unsupported characters`);
  }
  return normalized;
}

function assertControlledToken(value, label, pattern) {
  const normalized = String(value || "");
  if (!pattern.test(normalized)) {
    throw createLauncherError("DETACHED_WORKER_ARGUMENT_INVALID", `${label} contains unsupported characters`);
  }
  return normalized;
}

function optionalControlledEnvironmentPath(environment, key, platform) {
  const value = String(environment?.[key] || "");
  if (!value) return { invalid: false, value: "" };
  const pathApi = platform === "win32" ? path.win32 : path;
  try {
    return {
      invalid: false,
      value: assertControlledPath(
        pathApi.isAbsolute(value) ? value : pathApi.resolve(value),
        key,
        platform
      )
    };
  } catch {
    // Monitoring configuration must never make recruiting execution fail or
    // silently redirect a detached worker to an unrelated fallback root.
    return { invalid: true, value: "" };
  }
}

function normalizeBossMonitoringEnabled(value) {
  const normalized = String(value ?? "true").trim().toLowerCase();
  return MONITORING_DISABLED_VALUES.has(normalized) ? "false" : "true";
}

export function quoteWindowsCommandLineArgument(value) {
  const input = String(value ?? "");
  if (input.includes("\0")) {
    throw createLauncherError("DETACHED_WORKER_ARGUMENT_INVALID", "Windows command-line arguments cannot contain NUL");
  }
  if (input && !/[\s"]/.test(input)) return input;
  let output = '"';
  let backslashes = 0;
  for (const character of input) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      output += "\\".repeat((backslashes * 2) + 1);
      output += '"';
      backslashes = 0;
      continue;
    }
    output += "\\".repeat(backslashes);
    output += character;
    backslashes = 0;
  }
  output += "\\".repeat(backslashes * 2);
  output += '"';
  return output;
}

function quotePowerShellLiteral(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function windowsPowerShellPath(environment = process.env) {
  const systemRoot = String(environment?.SystemRoot || environment?.WINDIR || "").trim();
  return systemRoot
    ? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

export function buildWindowsDetachedWorkerCommand({
  powershellPath,
  wrapperScriptPath,
  nodePath,
  workerScriptPath,
  domain,
  runId,
  launchId,
  stdoutPath,
  stderrPath,
  exitStatusPath,
  recommendRuntimeHomePath = "",
  chatRuntimeHomePath = "",
  screenConfigPath = "",
  bossMonitorHomePath = "",
  recruitingMonitorHomePath = "",
  bossMonitoringEnabled = "true"
}) {
  const args = [
    powershellPath,
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    wrapperScriptPath,
    "-NodePath",
    nodePath,
    "-WorkerScriptPath",
    workerScriptPath,
    "-Domain",
    domain,
    "-RunId",
    runId,
    "-LaunchId",
    launchId,
    "-StdoutPath",
    stdoutPath,
    "-StderrPath",
    stderrPath,
    "-ExitStatusPath",
    exitStatusPath
  ];
  if (recommendRuntimeHomePath) {
    args.push("-RecommendRuntimeHomePath", recommendRuntimeHomePath);
  }
  if (chatRuntimeHomePath) {
    args.push("-ChatRuntimeHomePath", chatRuntimeHomePath);
  }
  if (screenConfigPath) {
    args.push("-ScreenConfigPath", screenConfigPath);
  }
  if (bossMonitorHomePath) {
    args.push("-BossMonitorHomePath", bossMonitorHomePath);
  }
  if (recruitingMonitorHomePath) {
    args.push("-RecruitingMonitorHomePath", recruitingMonitorHomePath);
  }
  args.push("-BossMonitoringEnabled", bossMonitoringEnabled);
  return args.map(quoteWindowsCommandLineArgument).join(" ");
}

export function buildWindowsCimEncodedCommand(commandLine) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$commandLine = ${quotePowerShellLiteral(commandLine)}`,
    "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }",
    "$payload = [ordered]@{ return_value = [int]$result.ReturnValue; process_id = [int]$result.ProcessId }",
    "[Console]::Out.Write(($payload | ConvertTo-Json -Compress))",
    "if ([int]$result.ReturnValue -ne 0) { exit 1 }"
  ].join("; ");
  return Buffer.from(script, "utf16le").toString("base64");
}

function parseCimPayload(stdout = "") {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // PowerShell may emit non-JSON diagnostics before the compact payload.
    }
  }
  return null;
}

function launchWindowsDetachedWorker(options) {
  const {
    nodePath,
    workerScriptPath,
    domain,
    runId,
    launchId,
    stdoutPath,
    stderrPath,
    exitStatusPath,
    recommendRuntimeHomePath,
    chatRuntimeHomePath,
    screenConfigPath,
    bossMonitorHomePath,
    recruitingMonitorHomePath,
    bossMonitoringEnabled,
    wrapperScriptPath = WINDOWS_WRAPPER_PATH,
    powershellPath = windowsPowerShellPath(options.environment),
    spawnSyncImpl = spawnSync
  } = options;
  const commandLine = buildWindowsDetachedWorkerCommand({
    powershellPath,
    wrapperScriptPath,
    nodePath,
    workerScriptPath,
    domain,
    runId,
    launchId,
    stdoutPath,
    stderrPath,
    exitStatusPath,
    recommendRuntimeHomePath,
    chatRuntimeHomePath,
    screenConfigPath,
    bossMonitorHomePath,
    recruitingMonitorHomePath,
    bossMonitoringEnabled
  });
  const encodedCommand = buildWindowsCimEncodedCommand(commandLine);
  const result = spawnSyncImpl(powershellPath, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand
  ], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result?.error) {
    throw createLauncherError(
      "WINDOWS_CIM_LAUNCH_FAILED",
      `Unable to invoke the Windows detached-worker launcher: ${result.error.message || result.error}`,
      result.error
    );
  }
  const payload = parseCimPayload(result?.stdout);
  const returnValue = Number(payload?.return_value);
  const workerPid = Number(payload?.process_id);
  if (Number.isFinite(returnValue) && returnValue !== 0) {
    throw createLauncherError(
      "WINDOWS_CIM_CREATE_FAILED",
      `Win32_Process.Create returned ${returnValue} while launching the detached worker.`
    );
  }
  if (result?.signal || !Number.isInteger(result?.status) || result.status !== 0) {
    const stderr = String(result?.stderr || "").trim();
    throw createLauncherError(
      "WINDOWS_CIM_LAUNCH_FAILED",
      stderr || `PowerShell CIM launcher exited with status ${result?.status ?? "unknown"}.`
    );
  }
  if (!Number.isInteger(workerPid) || workerPid <= 0 || returnValue !== 0) {
    throw createLauncherError(
      "WINDOWS_CIM_RESULT_INVALID",
      "Win32_Process.Create did not return a valid detached worker PID."
    );
  }
  return {
    pid: workerPid,
    unref() {}
  };
}

function launchPosixDetachedWorker({
  nodePath,
  workerScriptPath,
  domain,
  runId,
  launchId,
  stdoutPath,
  stderrPath,
  spawnImpl = spawn,
  environment = process.env
}) {
  const stdoutFd = fs.openSync(stdoutPath, "a");
  const stderrFd = fs.openSync(stderrPath, "a");
  try {
    return spawnImpl(nodePath, [
      workerScriptPath,
      "--domain",
      domain,
      "--run-id",
      runId,
      "--launch-id",
      launchId
    ], {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      env: environment
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

export function launchDetachedWorker(options = {}) {
  const platform = String(options.platform || process.platform);
  const environment = options.environment && typeof options.environment === "object"
    ? options.environment
    : process.env;
  const nodePath = assertControlledPath(options.nodePath || process.execPath, "nodePath", platform);
  const workerScriptPath = assertControlledPath(options.workerScriptPath, "workerScriptPath", platform);
  const stdoutPath = assertControlledPath(options.stdoutPath, "stdoutPath", platform);
  const stderrPath = assertControlledPath(options.stderrPath, "stderrPath", platform);
  const exitStatusPath = assertControlledPath(
    options.exitStatusPath || `${stderrPath}.exit.json`,
    "exitStatusPath",
    platform
  );
  const domain = assertControlledToken(options.domain, "domain", SAFE_DOMAIN_PATTERN);
  if (!SAFE_DOMAINS.has(domain)) {
    throw createLauncherError("DETACHED_WORKER_ARGUMENT_INVALID", "domain is not supported by the detached launcher");
  }
  const runId = assertControlledToken(options.runId, "runId", SAFE_RUN_ID_PATTERN);
  const launchId = assertControlledToken(options.launchId || runId, "launchId", SAFE_RUN_ID_PATTERN);
  const wrapperScriptPath = platform === "win32"
    ? assertControlledPath(options.wrapperScriptPath || WINDOWS_WRAPPER_PATH, "wrapperScriptPath", platform)
    : options.wrapperScriptPath;
  const chatRuntimeHomePath = options.chatRuntimeHomePath
    ? assertControlledPath(options.chatRuntimeHomePath, "chatRuntimeHomePath", platform)
    : "";
  const recommendRuntimeHomePath = options.recommendRuntimeHomePath
    ? assertControlledPath(options.recommendRuntimeHomePath, "recommendRuntimeHomePath", platform)
    : "";
  const screenConfigPath = options.screenConfigPath
    ? assertControlledPath(options.screenConfigPath, "screenConfigPath", platform)
    : "";
  const bossMonitorHomeFromEnvironment = optionalControlledEnvironmentPath(
    environment,
    "BOSS_MONITOR_HOME",
    platform
  );
  const recruitingMonitorHomeFromEnvironment = optionalControlledEnvironmentPath(
    environment,
    "RECRUITING_MONITOR_HOME",
    platform
  );
  const bossMonitorHomePath = options.bossMonitorHomePath
    ? assertControlledPath(options.bossMonitorHomePath, "bossMonitorHomePath", platform)
    : bossMonitorHomeFromEnvironment.value;
  const recruitingMonitorHomePath = options.recruitingMonitorHomePath
    ? assertControlledPath(options.recruitingMonitorHomePath, "recruitingMonitorHomePath", platform)
    : recruitingMonitorHomeFromEnvironment.value;
  let bossMonitoringEnabled = normalizeBossMonitoringEnabled(
    options.bossMonitoringEnabled ?? environment.BOSS_MONITORING_ENABLED
  );
  if (
    bossMonitorHomeFromEnvironment.invalid
    || recruitingMonitorHomeFromEnvironment.invalid
  ) {
    bossMonitoringEnabled = "false";
  }
  const prepareLogFile = typeof options.prepareLogFileImpl === "function"
    ? options.prepareLogFileImpl
    : ensureLogFile;
  prepareLogFile(stdoutPath);
  prepareLogFile(stderrPath);
  fs.mkdirSync(path.dirname(exitStatusPath), { recursive: true });
  const normalized = {
    ...options,
    platform,
    nodePath,
    workerScriptPath,
    stdoutPath,
    stderrPath,
    exitStatusPath,
    recommendRuntimeHomePath,
    domain,
    runId,
    launchId,
    wrapperScriptPath,
    chatRuntimeHomePath,
    screenConfigPath,
    bossMonitorHomePath,
    recruitingMonitorHomePath,
    bossMonitoringEnabled,
    environment
  };
  return platform === "win32"
    ? launchWindowsDetachedWorker(normalized)
    : launchPosixDetachedWorker(normalized);
}

export const __testables = {
  WINDOWS_WRAPPER_PATH,
  parseCimPayload,
  quotePowerShellLiteral,
  windowsPowerShellPath
};
