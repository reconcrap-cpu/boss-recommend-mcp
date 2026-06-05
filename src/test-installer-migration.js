import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __testables } from "./cli.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(currentDir, "cli.js");
const packageRoot = path.resolve(currentDir, "..");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "boss-mcp-installer-"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function testMigratesLegacyMcpServers() {
  const tempDir = makeTempDir();
  const mcpPath = path.join(tempDir, "mcp.json");
  fs.writeFileSync(mcpPath, JSON.stringify({
    mcpServers: {
      "boss-recruit": {
        command: "npx",
        args: ["-y", "@reconcrap/boss-recruit-mcp@latest", "start"]
      },
      "boss-chat": {
        command: "boss-chat",
        args: ["start"]
      },
      "old-recommend-local": {
        command: "node",
        args: ["C:/Users/example/Documents/boss recommend pipeline/boss-recommend-mcp/src/index.js"]
      },
      "other-service": {
        command: "node",
        args: ["server.js"]
      }
    }
  }, null, 2), "utf8");

  const result = __testables.mergeMcpServerConfigFile(mcpPath, {
    packageVersion: "2.0.1",
    packageRootPath: path.join(tempDir, "node_modules", "@reconcrap", "boss-recommend-mcp")
  });
  const updated = readJson(mcpPath);
  const serverNames = Object.keys(updated.mcpServers).sort();

  assert.deepEqual(serverNames, ["boss-recommend", "other-service"]);
  assert.deepEqual(result.migrated_legacy_servers.sort(), ["boss-chat", "boss-recruit", "old-recommend-local"]);
  assert.ok(result.backup_file);
  assert.ok(fs.existsSync(result.backup_file));
  assert.match(fs.readFileSync(result.backup_file, "utf8"), /@reconcrap\/boss-recruit-mcp/);
  assert.equal(updated.mcpServers["boss-recommend"].command, "npx");
  assert.deepEqual(updated.mcpServers["boss-recommend"].args, [
    "-y",
    "@reconcrap/boss-recommend-mcp@2.0.1",
    "start"
  ]);

  const inspected = __testables.inspectMcpServerEntries(mcpPath);
  assert.equal(inspected.has_boss_recommend, true);
  assert.equal(inspected.has_boss_recruit, false);
  assert.equal(inspected.has_boss_chat, false);
}

function testCreatesCanonicalMcpServerWhenFileMissing() {
  const tempDir = makeTempDir();
  const mcpPath = path.join(tempDir, "missing", "mcp.json");
  const result = __testables.mergeMcpServerConfigFile(mcpPath, {
    packageVersion: "2.0.1",
    packageRootPath: path.join(tempDir, "node_modules", "@reconcrap", "boss-recommend-mcp")
  });
  const updated = readJson(mcpPath);

  assert.equal(result.backup_file, null);
  assert.deepEqual(Object.keys(updated.mcpServers), ["boss-recommend"]);
  assert.deepEqual(updated.mcpServers["boss-recommend"].args, [
    "-y",
    "@reconcrap/boss-recommend-mcp@2.0.1",
    "start"
  ]);
}

function testTraeConfigUsesSplitToolsets() {
  const tempDir = makeTempDir();
  const mcpPath = path.join(tempDir, "mcp.json");
  fs.writeFileSync(mcpPath, JSON.stringify({
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "D:/Projects"]
      },
      "boss-recommend": {
        command: "npx",
        args: ["-y", "@reconcrap/boss-recommend-mcp@2.1.11", "start"],
        env: {
          BOSS_WORKSPACE_ROOT: "C:/Users/example"
        }
      },
      "old-boss-chat": {
        command: "boss-chat",
        args: ["start"]
      }
    }
  }, null, 2), "utf8");

  const result = __testables.mergeMcpServerConfigFile(mcpPath, {
    agent: "trae-cn",
    packageVersion: "2.1.12",
    packageRootPath: path.join(tempDir, "node_modules", "@reconcrap", "boss-recommend-mcp")
  });
  const updated = readJson(mcpPath);
  const serverNames = Object.keys(updated.mcpServers).sort();

  assert.deepEqual(serverNames, ["boss-chat", "boss-recommend", "boss-recruit", "filesystem"]);
  assert.deepEqual(result.servers.sort(), ["boss-chat", "boss-recommend", "boss-recruit"]);
  assert.deepEqual(result.migrated_legacy_servers, ["old-boss-chat"]);
  assert.deepEqual(updated.mcpServers["boss-recommend"].args, [
    "-y",
    "@reconcrap/boss-recommend-mcp@2.1.12",
    "start"
  ]);
  assert.deepEqual(updated.mcpServers["boss-recommend"].env, {
    BOSS_WORKSPACE_ROOT: "C:/Users/example",
    BOSS_RECOMMEND_MCP_TOOLSET: "recommend"
  });
  assert.deepEqual(updated.mcpServers["boss-chat"].env, {
    BOSS_RECOMMEND_MCP_TOOLSET: "chat"
  });
  assert.deepEqual(updated.mcpServers["boss-recruit"].env, {
    BOSS_RECOMMEND_MCP_TOOLSET: "recruit"
  });

  const template = __testables.buildMcpConfigFileContent({
    client: "trae",
    packageVersion: "2.1.12"
  });
  assert.deepEqual(Object.keys(template.mcpServers).sort(), ["boss-chat", "boss-recommend", "boss-recruit"]);
  assert.equal(template.mcpServers["boss-recommend"].env.BOSS_RECOMMEND_MCP_TOOLSET, "recommend");
}

function testMigratesQClawOpenClawConfigShape() {
  const tempDir = makeTempDir();
  const qclawPath = path.join(tempDir, ".qclaw", "openclaw.json");
  fs.mkdirSync(path.dirname(qclawPath), { recursive: true });
  fs.writeFileSync(qclawPath, JSON.stringify({
    agents: {
      list: [
        {
          id: "main",
          skills: ["boss-recommend-pipeline"]
        }
      ]
    },
    mcp: {
      servers: {
        liepin: {
          command: "npx",
          args: ["@reconcrap/liepin-mcp"]
        },
        "boss-chat": {
          command: "boss-chat",
          args: ["start"]
        }
      }
    }
  }, null, 2), "utf8");

  const result = __testables.mergeMcpServerConfigFile(qclawPath, {
    agent: "qclaw",
    packageVersion: "2.0.1",
    packageRootPath: path.join(tempDir, "node_modules", "@reconcrap", "boss-recommend-mcp")
  });
  const updated = readJson(qclawPath);

  assert.equal(result.config_shape, "qclaw");
  assert.deepEqual(Object.keys(updated.mcp.servers).sort(), ["boss-recommend", "liepin"]);
  assert.equal(updated.mcpServers, undefined);
  assert.deepEqual(updated.mcp.servers["boss-recommend"].args, [
    "-y",
    "@reconcrap/boss-recommend-mcp@2.0.1",
    "start"
  ]);
  assert.deepEqual(updated.mcp.servers["boss-recommend"].env, {
    BOSS_RECOMMEND_CDP_DETACHED: "1",
    BOSS_RECOMMEND_RUN_HEARTBEAT_MS: "10000"
  });
  assert.deepEqual(result.migrated_legacy_servers, ["boss-chat"]);
  assert.deepEqual(updated.agents.list[0].skills, ["boss-recommend-pipeline"]);

  const inspected = __testables.inspectMcpServerEntries(qclawPath);
  assert.equal(inspected.has_boss_recommend, true);
  assert.deepEqual(inspected.recommend_server_names, ["boss-recommend"]);
}

function testOpenClawConfigPreservesExistingEnvAndEnablesDetached() {
  const tempDir = makeTempDir();
  const openClawPath = path.join(tempDir, ".openclaw", "openclaw.json");
  fs.mkdirSync(path.dirname(openClawPath), { recursive: true });
  fs.writeFileSync(openClawPath, JSON.stringify({
    mcpServers: {
      "boss-recommend": {
        command: "npx",
        args: ["-y", "@reconcrap/boss-recommend-mcp@latest", "start"],
        env: {
          BOSS_WORKSPACE_ROOT: "/tmp/openclaw-workspace",
          BOSS_RECOMMEND_HOME: "/tmp/boss-recommend"
        }
      }
    }
  }, null, 2), "utf8");

  const result = __testables.mergeMcpServerConfigFile(openClawPath, {
    agent: "openclaw",
    packageVersion: "2.0.1",
    packageRootPath: path.join(tempDir, "node_modules", "@reconcrap", "boss-recommend-mcp")
  });
  const updated = readJson(openClawPath);

  assert.equal(result.config_shape, "mcpServers");
  assert.deepEqual(updated.mcpServers["boss-recommend"].env, {
    BOSS_WORKSPACE_ROOT: "/tmp/openclaw-workspace",
    BOSS_RECOMMEND_HOME: "/tmp/boss-recommend",
    BOSS_RECOMMEND_CDP_DETACHED: "1",
    BOSS_RECOMMEND_RUN_HEARTBEAT_MS: "10000"
  });
}

function testGlobalWrapperLaunchConfigSupportsNpmGlobalUpgrades() {
  const tempDir = makeTempDir();
  const mcpPath = path.join(tempDir, "mcp.json");
  const wrapperPath = path.join(tempDir, "bin", "boss-recommend-mcp-mcp-server");
  fs.writeFileSync(mcpPath, JSON.stringify({
    mcpServers: {
      "boss-recruit": {
        command: "npx",
        args: ["-y", "@reconcrap/boss-recruit-mcp@latest", "start"]
      },
      "other-service": {
        command: "node",
        args: ["server.js"]
      }
    }
  }, null, 2), "utf8");

  const result = __testables.mergeMcpServerConfigFile(mcpPath, {
    agent: "openclaw",
    "mcp-launch": "global-wrapper",
    "mcp-wrapper-path": wrapperPath,
    packageVersion: "2.0.1",
    packageRootPath: path.join(tempDir, "node_modules", "@reconcrap", "boss-recommend-mcp")
  });
  const updated = readJson(mcpPath);
  const launch = updated.mcpServers["boss-recommend"];

  assert.equal(result.config_shape, "mcpServers");
  assert.deepEqual(Object.keys(updated.mcpServers).sort(), ["boss-recommend", "other-service"]);
  assert.deepEqual(result.migrated_legacy_servers, ["boss-recruit"]);
  assert.equal(launch.command, wrapperPath);
  assert.deepEqual(launch.args, []);
  assert.equal(launch.args.includes("@reconcrap/boss-recommend-mcp@2.0.1"), false);
  assert.deepEqual(launch.env, {
    BOSS_RECOMMEND_CDP_DETACHED: "1",
    BOSS_RECOMMEND_RUN_HEARTBEAT_MS: "10000"
  });
  assert.ok(fs.existsSync(wrapperPath));
  const wrapper = fs.readFileSync(wrapperPath, "utf8");
  assert.match(wrapper, /nvm\.sh/);
  assert.match(wrapper, /exec boss-recommend-mcp start "\$@"/);

  const inspected = __testables.inspectMcpServerEntries(mcpPath);
  assert.equal(inspected.has_boss_recommend, true);
  assert.equal(inspected.has_boss_recruit, false);
}

async function testRunCliUsesRecommendStartGate() {
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  const logs = [];
  console.log = (value = "") => {
    logs.push(String(value));
  };
  try {
    process.exitCode = undefined;
    await __testables.runPipelineOnce({
      instruction: "推荐页帮我筛候选人"
    });
  } finally {
    console.log = originalLog;
  }
  const payload = JSON.parse(logs.join("\n"));
  assert.equal(["NEED_INPUT", "NEED_CONFIRMATION"].includes(payload.status), true);
  assert.notEqual(payload.error?.code, "RECOMMEND_CLI_RUN_UNSUPPORTED_CDP_ONLY");
  assert.equal(payload.cli.command, "run");
  assert.equal(payload.cli.cdp_only, true);
  process.exitCode = originalExitCode;
}

async function testPrepareRunCliUsesRecommendPrepareGate() {
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  const logs = [];
  console.log = (value = "") => {
    logs.push(String(value));
  };
  try {
    process.exitCode = undefined;
    await __testables.preparePipelineOnce({
      instruction: "推荐页帮我筛候选人"
    });
  } finally {
    console.log = originalLog;
  }
  const payload = JSON.parse(logs.join("\n"));
  assert.equal(["NEED_INPUT", "NEED_CONFIRMATION"].includes(payload.status), true);
  assert.equal(payload.cron_ready, false);
  assert.equal(payload.cli.command, "prepare-run");
  assert.equal(payload.cli.cdp_only, true);
  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
}

async function testScheduleRunCliUsesRecommendScheduleGate() {
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  const logs = [];
  console.log = (value = "") => {
    logs.push(String(value));
  };
  try {
    process.exitCode = undefined;
    await __testables.schedulePipelineOnce({
      instruction: "推荐页帮我筛候选人",
      "schedule-delay-seconds": 60
    });
  } finally {
    console.log = originalLog;
  }
  const payload = JSON.parse(logs.join("\n"));
  assert.equal(["NEED_INPUT", "NEED_CONFIRMATION"].includes(payload.status), true);
  assert.equal(payload.schedule_created, false);
  assert.equal(payload.cli.command, "schedule-run");
  assert.equal(payload.cli.package_owned_scheduler, true);
  assert.equal(process.exitCode, 1);
  process.exitCode = originalExitCode;
}

function testDetachedRunCliShellFallback() {
  const result = spawnSync(process.execPath, [
    cliPath,
    "run",
    "--detached",
    "--instruction",
    "推荐页帮我筛候选人"
  ], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 30000
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "NEED_INPUT");
  assert.equal(payload.cli.command, "run");
  assert.equal(payload.cli.detached, true);
  assert.equal(payload.cli.detached_parent, true);
  assert.ok(payload.cli.child_pid);
  assert.match(payload.cli.stdout_path, /detached-runs/);
  assert.notEqual(payload.error?.code, "RECOMMEND_CLI_RUN_UNSUPPORTED_CDP_ONLY");
}

testMigratesLegacyMcpServers();
testCreatesCanonicalMcpServerWhenFileMissing();
testTraeConfigUsesSplitToolsets();
testMigratesQClawOpenClawConfigShape();
testOpenClawConfigPreservesExistingEnvAndEnablesDetached();
testGlobalWrapperLaunchConfigSupportsNpmGlobalUpgrades();
await testRunCliUsesRecommendStartGate();
await testPrepareRunCliUsesRecommendPrepareGate();
await testScheduleRunCliUsesRecommendScheduleGate();
testDetachedRunCliShellFallback();

console.log("installer migration tests passed");
