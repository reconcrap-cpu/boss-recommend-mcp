import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __testables } from "./cli.js";

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

testMigratesLegacyMcpServers();
testCreatesCanonicalMcpServerWhenFileMissing();

console.log("installer migration tests passed");
