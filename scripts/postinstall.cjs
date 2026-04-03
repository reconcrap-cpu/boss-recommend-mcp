#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function isGlobalInstall() {
  if (String(process.env.npm_config_global || "").toLowerCase() === "true") return true;
  if (String(process.env.npm_config_location || "").toLowerCase() === "global") return true;

  const argvRaw = String(process.env.npm_config_argv || "");
  if (argvRaw.includes("--global") || argvRaw.includes(" -g ")) return true;

  return false;
}

function main() {
  const cliPath = path.join(__dirname, "..", "src", "cli.js");
  if (!fs.existsSync(cliPath)) {
    return;
  }

  const initCwd = String(process.env.INIT_CWD || "").trim();
  const workspaceArgs = initCwd ? ["--workspace-root", path.resolve(initCwd)] : [];
  const cliArgs = isGlobalInstall()
    ? [cliPath, "install", ...workspaceArgs]
    : [cliPath, "init-config", ...workspaceArgs];

  const result = spawnSync(process.execPath, cliArgs, {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit",
    windowsHide: true,
    shell: false
  });

  if (result.error) {
    console.warn(`[boss-recommend-mcp] postinstall warning: ${result.error.message}`);
    return;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    console.warn(`[boss-recommend-mcp] postinstall warning: install exited with code ${result.status}`);
  }
}

main();
