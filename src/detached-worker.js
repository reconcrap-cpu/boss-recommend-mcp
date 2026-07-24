#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    } else if (item === "--launch-id") {
      args.launchId = normalizeText(argv[index + 1]);
      index += 1;
    } else if (item === "--record-exit") {
      args.recordExit = true;
    } else if (item === "--worker-exit-code") {
      const parsed = Number.parseInt(argv[index + 1], 10);
      args.workerExitCode = Number.isInteger(parsed) ? parsed : null;
      index += 1;
    } else if (item === "--worker-pid") {
      const parsed = Number.parseInt(argv[index + 1], 10);
      args.workerPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      index += 1;
    } else if (item === "--supervisor-pid") {
      const parsed = Number.parseInt(argv[index + 1], 10);
      args.supervisorPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      index += 1;
    }
  }
  return args;
}

function defaultLoadRecommendWorkerModule() {
  return import("./index.js");
}

function requireRecommendWorkerFunction(module, exportName) {
  const workerFunction = module?.[exportName];
  if (typeof workerFunction === "function") return workerFunction;
  const error = new Error(`Recommend detached worker export is unavailable: ${exportName}`);
  error.code = "DETACHED_RECOMMEND_WORKER_EXPORT_UNAVAILABLE";
  throw error;
}

export async function runDetachedWorkerDomain({ domain, runId, launchId } = {}, dependencies = {}) {
  const workerOptions = launchId ? { runId, launchId } : { runId };
  if (domain === "chat") {
    const runWorker = dependencies.runBossChatDetachedWorker || runBossChatDetachedWorker;
    return runWorker(workerOptions);
  }
  if (domain === "recruit") {
    const runWorker = dependencies.runBossRecruitDetachedWorker || runBossRecruitDetachedWorker;
    return runWorker(workerOptions);
  }
  if (domain === "recommend") {
    const loadRecommendWorkerModule = dependencies.loadRecommendWorkerModule || defaultLoadRecommendWorkerModule;
    const module = await loadRecommendWorkerModule();
    const runWorker = requireRecommendWorkerFunction(module, "runDetachedRecommendWorker");
    return runWorker(workerOptions);
  }
  return { ok: false, error: `Unsupported detached worker domain: ${domain}` };
}

export async function markDetachedWorkerDomainFailed(domain, runId, error, options = {}, dependencies = {}) {
  if (domain === "chat") {
    const markWorkerFailed = dependencies.markBossChatDetachedWorkerFailed || markBossChatDetachedWorkerFailed;
    return markWorkerFailed(runId, error, options);
  }
  if (domain === "recruit") {
    const markWorkerFailed = dependencies.markBossRecruitDetachedWorkerFailed || markBossRecruitDetachedWorkerFailed;
    return markWorkerFailed(runId, error, options);
  }
  if (domain === "recommend") {
    const loadRecommendWorkerModule = dependencies.loadRecommendWorkerModule || defaultLoadRecommendWorkerModule;
    const module = await loadRecommendWorkerModule();
    const markWorkerFailed = requireRecommendWorkerFunction(module, "markDetachedRecommendWorkerFailed");
    return markWorkerFailed(runId, error, options);
  }
  return null;
}

export async function recordDetachedWorkerExit(options = {}, dependencies = {}) {
  const exitCode = Number.isInteger(options.workerExitCode) ? options.workerExitCode : null;
  const exitLabel = exitCode === null ? "code=unknown" : `code=${exitCode}`;
  const error = new Error(`Detached ${options.domain} worker exited before writing a terminal state (${exitLabel}).`);
  error.code = "DETACHED_WORKER_EXITED_EARLY";
  const persisted = await markDetachedWorkerDomainFailed(
    options.domain,
    options.runId,
    error,
    {
      code: "DETACHED_WORKER_EXITED_EARLY",
      workerExitCode: exitCode,
      workerPid: options.workerPid,
      supervisorPid: options.supervisorPid,
      workerLaunchId: options.launchId,
      diagnosticSource: "windows_cim_supervisor"
    },
    dependencies
  );
  return { ok: true, persisted: Boolean(persisted) };
}

function installFailureHandlers(domain, runId, launchId = "", dependencies = {}) {
  let handled = false;
  const failOnce = async (error, options = {}) => {
    if (handled) return;
    handled = true;
    try {
      await markDetachedWorkerDomainFailed(domain, runId, error, {
        ...options,
        workerLaunchId: launchId || null
      }, dependencies);
    } catch (markError) {
      console.error("[boss-recommend-mcp] failed to persist detached worker failure", markError);
    }
  };

  process.on("uncaughtException", async (error) => {
    console.error("[boss-recommend-mcp] detached worker uncaught exception", error);
    await failOnce(error, { code: "DETACHED_WORKER_UNCAUGHT_EXCEPTION" });
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("[boss-recommend-mcp] detached worker unhandled rejection", reason);
    const error = reason instanceof Error ? reason : new Error(normalizeText(reason) || "Unhandled promise rejection");
    await failOnce(error, { code: "DETACHED_WORKER_UNHANDLED_REJECTION" });
    process.exit(1);
  });

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, async () => {
      const error = new Error(`detached ${domain} worker received ${signal}`);
      console.error("[boss-recommend-mcp] detached worker received signal", signal);
      await failOnce(error, { code: "DETACHED_WORKER_SIGNAL" });
      const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
      process.exit(signalExitCodes[signal] || 1);
    });
  }
}

export async function runDetachedWorkerMain(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (!options.domain || !options.runId) {
    console.error("[boss-recommend-mcp] detached worker requires --domain and --run-id");
    process.exitCode = 1;
    return;
  }
  if (options.recordExit) {
    await recordDetachedWorkerExit(options, dependencies);
    return;
  }
  installFailureHandlers(options.domain, options.runId, options.launchId, dependencies);
  const result = await runDetachedWorkerDomain(options, dependencies);
  if (!result?.ok) {
    const rawResultError = result?.error;
    const resultError = rawResultError instanceof Error
      ? rawResultError
      : new Error(
          normalizeText(rawResultError?.message || rawResultError || result?.message)
          || `Detached ${options.domain} worker returned a non-ok result.`
        );
    const failureCode = normalizeText(result?.code || rawResultError?.code || resultError?.code)
      || "DETACHED_WORKER_START_FAILED";
    if (!normalizeText(resultError.code)) {
      resultError.code = failureCode;
    }
    try {
      await markDetachedWorkerDomainFailed(
        options.domain,
        options.runId,
        resultError,
        {
          code: failureCode,
          workerLaunchId: options.launchId || null,
          diagnosticSource: "detached_worker_non_ok_result"
        },
        dependencies
      );
    } catch (markError) {
      console.error("[boss-recommend-mcp] failed to persist detached worker non-ok result", markError);
    }
    process.exitCode = 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  await runDetachedWorkerMain().catch(async (error) => {
    const options = parseArgs(process.argv.slice(2));
    console.error("[boss-recommend-mcp] detached worker failed", error);
    try {
      await markDetachedWorkerDomainFailed(
        options.domain,
        options.runId,
        error,
        {
          code: "DETACHED_WORKER_FAILED",
          workerLaunchId: options.launchId || null
        }
      );
    } catch (markError) {
      console.error("[boss-recommend-mcp] failed to persist detached worker failure", markError);
    }
    process.exitCode = 1;
  });
}
