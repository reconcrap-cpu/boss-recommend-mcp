#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";

const GATES = [
  {
    name: "runtime strict",
    script: "scan:runtime:strict"
  },
  {
    name: "package runtime strict",
    script: "scan:runtime:package:strict"
  },
  {
    name: "legacy boundary",
    script: "scan:legacy-boundary"
  },
  {
    name: "package boundary",
    script: "scan:package-boundary"
  },
  {
    name: "screenshot safety",
    script: "scan:screenshot-safety"
  }
];

function npmInvocation(script) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return {
      command: process.execPath,
      args: [npmExecPath, "run", script],
      shell: false
    };
  }
  return {
    command: "npm",
    args: ["run", script],
    shell: process.platform === "win32"
  };
}

function runGate(gate) {
  const invocation = npmInvocation(gate.script);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: invocation.shell,
    windowsHide: true
  });
  return {
    ...gate,
    ok: result.status === 0 && !result.error,
    status: Number.isInteger(result.status) ? result.status : -1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error?.message || ""
  };
}

function printResult(result) {
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${result.name}: npm run ${result.script}`);
  const output = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n").trim();
  if (!result.ok && output) {
    console.log(output);
  }
}

function main() {
  const results = [];
  for (const gate of GATES) {
    const result = runGate(gate);
    results.push(result);
    printResult(result);
    if (!result.ok) break;
  }

  const failed = results.filter((result) => !result.ok);
  const summary = {
    generated_at: new Date().toISOString(),
    status: failed.length > 0 ? "fail" : "pass",
    gates_total: GATES.length,
    gates_run: results.length,
    gates_passed: results.filter((result) => result.ok).length,
    failed_gate: failed[0]?.script || null
  };

  console.log("");
  console.log(JSON.stringify(summary, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main();
