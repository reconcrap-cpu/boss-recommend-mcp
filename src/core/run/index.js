export const RUN_STATUS_QUEUED = "queued";
export const RUN_STATUS_RUNNING = "running";
export const RUN_STATUS_PAUSED = "paused";
export const RUN_STATUS_COMPLETED = "completed";
export const RUN_STATUS_CANCELING = "canceling";
export const RUN_STATUS_CANCELED = "canceled";
export const RUN_STATUS_FAILED = "failed";

const TERMINAL_STATUSES = new Set([
  RUN_STATUS_COMPLETED,
  RUN_STATUS_CANCELED,
  RUN_STATUS_FAILED
]);

export class RunCanceledError extends Error {
  constructor(message = "Run canceled") {
    super(message);
    this.name = "RunCanceledError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function createRunId(prefix = "run") {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorDiagnostic(error) {
  if (!error) return null;
  const diagnostic = {
    name: error?.name || "Error",
    message: error?.message || String(error)
  };
  if (error?.code) diagnostic.code = error.code;
  return diagnostic;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function snapshotFromEntry(entry) {
  const run = entry.run;
  return clone({
    runId: run.runId,
    name: run.name,
    pid: run.pid,
    status: run.status,
    phase: run.phase,
    progress: run.progress,
    context: run.context,
    checkpoint: run.checkpoint,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    canPause: run.status === RUN_STATUS_RUNNING,
    canResume: run.status === RUN_STATUS_PAUSED,
    canCancel: !TERMINAL_STATUSES.has(run.status),
    error: run.error,
    summary: run.summary
  });
}

export function createRunLifecycleManager({
  idPrefix = "run",
  now = nowIso,
  onSnapshot = null
} = {}) {
  const runs = new Map();

  function emitSnapshot(entry, event = {}) {
    if (typeof onSnapshot !== "function") return;
    try {
      onSnapshot(snapshotFromEntry(entry), {
        type: event.type || "update",
        at: now(),
        ...event
      });
    } catch {
      // Snapshot hooks must never interrupt an active browser run.
    }
  }

  function getEntry(runId) {
    const entry = runs.get(runId);
    if (!entry) throw new Error(`Unknown runId: ${runId}`);
    return entry;
  }

  function touch(entry) {
    entry.run.updatedAt = now();
  }

  function setStatus(entry, status, patch = {}) {
    entry.run.status = status;
    Object.assign(entry.run, patch);
    touch(entry);
    emitSnapshot(entry, { type: "status", status });
  }

  function createControls(entry) {
    return {
      signal: entry.controller.signal,
      get runId() {
        return entry.run.runId;
      },
      get status() {
        return entry.run.status;
      },
      setPhase(phase) {
        entry.run.phase = phase;
        touch(entry);
      },
      updateProgress(progressPatch = {}) {
        entry.run.progress = {
          ...entry.run.progress,
          ...progressPatch
        };
        touch(entry);
        emitSnapshot(entry, { type: "progress", progressPatch });
        return snapshotFromEntry(entry);
      },
      checkpoint(checkpointPatch = {}) {
        entry.run.checkpoint = {
          ...entry.run.checkpoint,
          ...checkpointPatch,
          updatedAt: now()
        };
        touch(entry);
        emitSnapshot(entry, { type: "checkpoint", checkpointPatch });
        return snapshotFromEntry(entry);
      },
      async waitIfPaused() {
        if (entry.controller.signal.aborted) {
          throw new RunCanceledError();
        }
        if (!entry.pauseRequested) return;
        setStatus(entry, RUN_STATUS_PAUSED);
        while (entry.pauseRequested) {
          const deferred = createDeferred();
          entry.pauseWaiters.add(deferred);
          try {
            await deferred.promise;
          } finally {
            entry.pauseWaiters.delete(deferred);
          }
          if (entry.controller.signal.aborted) {
            throw new RunCanceledError();
          }
        }
        setStatus(entry, RUN_STATUS_RUNNING);
      },
      async sleep(ms) {
        if (entry.controller.signal.aborted) {
          throw new RunCanceledError();
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          const onAbort = () => {
            clearTimeout(timer);
            reject(new RunCanceledError());
          };
          entry.controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      },
      throwIfCanceled() {
        if (entry.controller.signal.aborted) {
          throw new RunCanceledError();
        }
      }
    };
  }

  async function settle(entry, task) {
    try {
      const summary = await task(entry.controls);
      if (entry.controller.signal.aborted || entry.cancelRequested) {
        setStatus(entry, RUN_STATUS_CANCELED, {
          completedAt: now(),
          summary: summary || entry.run.summary
        });
      } else {
        setStatus(entry, RUN_STATUS_COMPLETED, {
          completedAt: now(),
          summary: summary || entry.run.summary
        });
      }
    } catch (error) {
      if (error instanceof RunCanceledError || entry.controller.signal.aborted || entry.cancelRequested) {
        setStatus(entry, RUN_STATUS_CANCELED, {
          completedAt: now(),
          error: error instanceof RunCanceledError ? null : errorDiagnostic(error)
        });
        return;
      }
      setStatus(entry, RUN_STATUS_FAILED, {
        completedAt: now(),
        error: errorDiagnostic(error)
      });
    }
  }

  function startRun({ runId: requestedRunId = "", name, pid = process.pid, context = {}, progress = {}, checkpoint = {}, task }) {
    if (typeof task !== "function") {
      throw new Error("startRun requires a task function");
    }
    const runId = String(requestedRunId || "").trim() || createRunId(idPrefix);
    if (runs.has(runId)) {
      throw new Error(`Run already exists: ${runId}`);
    }
    const startedAt = now();
    const entry = {
      controller: new AbortController(),
      pauseRequested: false,
      cancelRequested: false,
      pauseWaiters: new Set(),
      run: {
        runId,
        name: name || runId,
        pid: Number.isInteger(pid) && pid > 0 ? pid : process.pid,
        status: RUN_STATUS_QUEUED,
        phase: "queued",
        progress,
        context,
        checkpoint,
        startedAt,
        updatedAt: startedAt,
        completedAt: null,
        error: null,
        summary: null
      }
    };
    entry.controls = createControls(entry);
    runs.set(runId, entry);
    setStatus(entry, RUN_STATUS_RUNNING, { phase: "running" });
    entry.promise = settle(entry, task);
    return snapshotFromEntry(entry);
  }

  function getRun(runId) {
    return snapshotFromEntry(getEntry(runId));
  }

  function pauseRun(runId) {
    const entry = getEntry(runId);
    if (TERMINAL_STATUSES.has(entry.run.status)) return snapshotFromEntry(entry);
    entry.pauseRequested = true;
    if (entry.run.status === RUN_STATUS_RUNNING) {
      touch(entry);
      emitSnapshot(entry, { type: "pause_requested" });
    }
    return snapshotFromEntry(entry);
  }

  function resumeRun(runId) {
    const entry = getEntry(runId);
    if (TERMINAL_STATUSES.has(entry.run.status)) return snapshotFromEntry(entry);
    entry.pauseRequested = false;
    for (const waiter of entry.pauseWaiters) {
      waiter.resolve();
    }
    if (entry.run.status === RUN_STATUS_PAUSED) {
      setStatus(entry, RUN_STATUS_RUNNING);
    } else {
      touch(entry);
      emitSnapshot(entry, { type: "resume_requested" });
    }
    return snapshotFromEntry(entry);
  }

  function cancelRun(runId) {
    const entry = getEntry(runId);
    if (TERMINAL_STATUSES.has(entry.run.status)) return snapshotFromEntry(entry);
    entry.cancelRequested = true;
    setStatus(entry, RUN_STATUS_CANCELING);
    entry.controller.abort();
    entry.pauseRequested = false;
    for (const waiter of entry.pauseWaiters) {
      waiter.resolve();
    }
    return snapshotFromEntry(entry);
  }

  async function waitForRun(runId, { timeoutMs = 10000 } = {}) {
    const entry = getEntry(runId);
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out waiting for run ${runId}`)), timeoutMs);
    });
    await Promise.race([entry.promise, timeout]);
    return snapshotFromEntry(entry);
  }

  return {
    startRun,
    getRun,
    pauseRun,
    resumeRun,
    cancelRun,
    waitForRun,
    listRuns() {
      return Array.from(runs.values()).map(snapshotFromEntry);
    }
  };
}
