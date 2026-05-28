#!/usr/bin/env node
import {
  markBossChatDetachedWorkerFailed,
  runBossChatDetachedWorker
} from "./chat-mcp.js";
import {
  markBossRecruitDetachedWorkerFailed,
  runBossRecruitDetachedWorker
} from "./recruit-mcp.js";

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--domain") {
      args.domain = normalizeText(argv[index + 1]).toLowerCase();
      index += 1;
    } else if (item === "--run-id") {
      args.runId = normalizeText(argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

function markFailed(domain, runId, error, options = {}) {
  if (domain === "chat") {
    return markBossChatDetachedWorkerFailed(runId, error, options);
  }
  if (domain === "recruit") {
    return markBossRecruitDetachedWorkerFailed(runId, error, options);
  }
  return null;
}

function installFailureHandlers(domain, runId) {
  let handled = false;
  const failOnce = (error, options = {}) => {
    if (handled) return;
    handled = true;
    try {
      markFailed(domain, runId, error, options);
    } catch (markError) {
      console.error("[boss-recommend-mcp] failed to persist detached worker failure", markError);
    }
  };

  process.on("uncaughtException", (error) => {
    console.error("[boss-recommend-mcp] detached worker uncaught exception", error);
    failOnce(error, { code: "DETACHED_WORKER_UNCAUGHT_EXCEPTION" });
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[boss-recommend-mcp] detached worker unhandled rejection", reason);
    const error = reason instanceof Error ? reason : new Error(normalizeText(reason) || "Unhandled promise rejection");
    failOnce(error, { code: "DETACHED_WORKER_UNHANDLED_REJECTION" });
    process.exit(1);
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      const error = new Error(`detached ${domain} worker received ${signal}`);
      console.error("[boss-recommend-mcp] detached worker received signal", signal);
      failOnce(error, { code: "DETACHED_WORKER_SIGNAL" });
      const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
      process.exit(signalExitCodes[signal] || 1);
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.domain || !options.runId) {
    console.error("[boss-recommend-mcp] detached worker requires --domain and --run-id");
    process.exitCode = 1;
    return;
  }
  installFailureHandlers(options.domain, options.runId);
  const result = options.domain === "chat"
    ? await runBossChatDetachedWorker({ runId: options.runId })
    : options.domain === "recruit"
      ? await runBossRecruitDetachedWorker({ runId: options.runId })
      : { ok: false, error: `Unsupported detached worker domain: ${options.domain}` };
  if (!result?.ok) {
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  const options = parseArgs(process.argv.slice(2));
  console.error("[boss-recommend-mcp] detached worker failed", error);
  markFailed(options.domain, options.runId, error, { code: "DETACHED_WORKER_FAILED" });
  process.exitCode = 1;
});
