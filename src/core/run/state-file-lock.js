import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_MS = 10;
const DEAD_OWNER_GRACE_MS = 2_000;
const UNREADABLE_GRACE_MS = 10_000;
const MAX_LOCK_LEASE_MS = 120_000;
const RECOVERY_MAX_LOCK_LEASE_MS = 10_000;
const RELEASE_RETRY_DELAYS_MS = Object.freeze([10, 25, 50, 100]);
const TRANSIENT_LOCK_CODES = new Set(["EACCES", "EPERM", "EBUSY"]);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const heldLocks = new Map();

function sleepSync(milliseconds) {
  const delayMs = Math.max(0, Math.floor(Number(milliseconds) || 0));
  if (delayMs > 0) Atomics.wait(sleepCell, 0, 0, delayMs);
}

function processIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  if (numericPid === process.pid) return true;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function isExistingLockError(error, lockPath) {
  return error?.code === "EEXIST"
    || TRANSIENT_LOCK_CODES.has(error?.code);
}

function lockAgeMs(lockPath, owner) {
  const acquiredAt = Date.parse(String(owner?.acquired_at || ""));
  if (Number.isFinite(acquiredAt)) return Math.max(0, Date.now() - acquiredAt);
  try {
    return Math.max(0, Date.now() - fs.statSync(lockPath).mtimeMs);
  } catch {
    return 0;
  }
}

function sameLockOwner(left, right) {
  if (!left || !right) return left === right;
  return (
    String(left.nonce || "") !== ""
    && String(left.nonce || "") === String(right.nonce || "")
    && Number(left.pid) === Number(right.pid)
    && String(left.acquired_at || "") === String(right.acquired_at || "")
  );
}

function lockIsRecoverable(lockPath, owner, {
  deadOwnerGraceMs = DEAD_OWNER_GRACE_MS,
  unreadableGraceMs = UNREADABLE_GRACE_MS,
  maxLeaseMs = MAX_LOCK_LEASE_MS
} = {}) {
  const ageMs = lockAgeMs(lockPath, owner);
  if (ageMs >= maxLeaseMs) return true;
  return owner
    ? !processIsAlive(owner.pid) && ageMs >= deadOwnerGraceMs
    : ageMs >= unreadableGraceMs;
}

function releaseOwnedLock(lockPath, nonce, {
  unlinkSyncImpl = fs.unlinkSync,
  sleepSyncImpl = sleepSync,
  retryDelaysMs = RELEASE_RETRY_DELAYS_MS
} = {}) {
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const current = readLockOwner(lockPath);
      if (!current) {
        if (!fs.existsSync(lockPath)) return true;
        const retryDelayMs = retryDelaysMs[attempt];
        if (retryDelayMs === undefined) return false;
        sleepSyncImpl(retryDelayMs);
        continue;
      }
      if (current?.nonce !== nonce || Number(current?.pid) !== process.pid) {
        return false;
      }
      unlinkSyncImpl(lockPath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      const retryDelayMs = retryDelaysMs[attempt];
      if (!TRANSIENT_LOCK_CODES.has(error?.code) || retryDelayMs === undefined) {
        return false;
      }
      sleepSyncImpl(retryDelayMs);
    }
  }
  return false;
}

function acquireRecoveryGuard(lockPath, {
  recoveryPath = `${lockPath}.recovery`,
  deadOwnerGraceMs = DEAD_OWNER_GRACE_MS,
  unreadableGraceMs = UNREADABLE_GRACE_MS,
  recoveryMaxLeaseMs = RECOVERY_MAX_LOCK_LEASE_MS
} = {}) {
  const nonce = crypto.randomBytes(18).toString("base64url");
  let fd = null;
  let created = false;
  try {
    fd = fs.openSync(recoveryPath, "wx", 0o600);
    created = true;
    fs.writeFileSync(fd, `${JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      nonce,
      acquired_at: new Date().toISOString()
    })}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return () => releaseOwnedLock(recoveryPath, nonce);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore cleanup errors and preserve the acquisition result.
      }
    }
    if (created) {
      try {
        fs.unlinkSync(recoveryPath);
      } catch {
        // The failed creator is the only process that could own this path.
      }
      throw error;
    }
    if (!isExistingLockError(error, recoveryPath)) throw error;

    // Recovery guards are normally held for only a few synchronous file
    // operations. If a recovering process died, remove its guard only after a
    // second owner read proves that the exact same stale guard still exists.
    const observed = readLockOwner(recoveryPath);
    const recoveryPolicy = {
      deadOwnerGraceMs,
      unreadableGraceMs,
      maxLeaseMs: recoveryMaxLeaseMs
    };
    if (!lockIsRecoverable(recoveryPath, observed, recoveryPolicy)) return null;
    const confirmed = readLockOwner(recoveryPath);
    if (
      !sameLockOwner(observed, confirmed)
      || !lockIsRecoverable(recoveryPath, confirmed, recoveryPolicy)
    ) {
      return null;
    }
    try {
      fs.unlinkSync(recoveryPath);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") return null;
    }
    return null;
  }
}

function recoverStaleLock(lockPath, options = {}) {
  const releaseRecoveryGuard = acquireRecoveryGuard(lockPath, options);
  if (!releaseRecoveryGuard) return false;
  try {
    const observed = readLockOwner(lockPath);
    if (!lockIsRecoverable(lockPath, observed, options)) return false;
    const confirmed = readLockOwner(lockPath);
    if (
      !sameLockOwner(observed, confirmed)
      || !lockIsRecoverable(lockPath, confirmed, options)
    ) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  } finally {
    releaseRecoveryGuard();
  }
}

export function acquireFileLockSync(lockPathInput, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryMs = RETRY_MS,
  deadOwnerGraceMs = DEAD_OWNER_GRACE_MS,
  unreadableGraceMs = UNREADABLE_GRACE_MS,
  maxLeaseMs = MAX_LOCK_LEASE_MS,
  recoveryMaxLeaseMs = RECOVERY_MAX_LOCK_LEASE_MS,
  recoveryPath: recoveryPathInput,
  timeoutCode = "FILE_LOCK_TIMEOUT",
  timeoutMessage = "",
  ownerMetadata = {},
  releaseUnlinkSyncImpl = fs.unlinkSync,
  releaseSleepSyncImpl = sleepSync,
  releaseRetryDelaysMs = RELEASE_RETRY_DELAYS_MS
} = {}) {
  const lockPath = path.resolve(lockPathInput);
  const recoveryPath = recoveryPathInput
    ? path.resolve(recoveryPathInput)
    : `${lockPath}.recovery`;
  const lockOptions = {
    deadOwnerGraceMs,
    unreadableGraceMs,
    maxLeaseMs,
    recoveryMaxLeaseMs,
    recoveryPath
  };
  const locallyHeld = heldLocks.get(lockPath);
  if (locallyHeld) {
    locallyHeld.depth += 1;
    return () => {
      locallyHeld.depth -= 1;
    };
  }

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const nonce = crypto.randomBytes(18).toString("base64url");
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  while (Date.now() <= deadline) {
    if (fs.existsSync(recoveryPath)) {
      const releaseRecoveryGuard = acquireRecoveryGuard(lockPath, lockOptions);
      if (releaseRecoveryGuard) releaseRecoveryGuard();
      sleepSync(retryMs);
      continue;
    }
    let fd = null;
    let created = false;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      created = true;
      fs.writeFileSync(fd, `${JSON.stringify({
        schema_version: 1,
        ...ownerMetadata,
        pid: process.pid,
        nonce,
        acquired_at: new Date().toISOString()
      })}\n`, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      const localEntry = { depth: 1, nonce };
      heldLocks.set(lockPath, localEntry);
      return () => {
        localEntry.depth -= 1;
        if (localEntry.depth > 0) return;
        heldLocks.delete(lockPath);
        releaseOwnedLock(lockPath, nonce, {
          unlinkSyncImpl: releaseUnlinkSyncImpl,
          sleepSyncImpl: releaseSleepSyncImpl,
          retryDelaysMs: releaseRetryDelaysMs
        });
      };
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore cleanup errors and preserve the acquisition failure.
        }
      }
      if (created) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // The failed creator is the only process that could own this path.
        }
        throw error;
      }
      if (!isExistingLockError(error, lockPath)) throw error;
      if (!recoverStaleLock(lockPath, lockOptions)) sleepSync(retryMs);
    }
  }
  const error = new Error(
    timeoutMessage || `Timed out acquiring file lock for ${lockPath}`
  );
  error.code = timeoutCode;
  throw error;
}

export function withRunStateFileLockSync(targetPath, operation, {
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("operation must be a function");
  }
  const absoluteTarget = path.resolve(targetPath);
  const release = acquireFileLockSync(`${absoluteTarget}.state.lock`, {
    timeoutMs,
    timeoutCode: "RUN_STATE_LOCK_TIMEOUT",
    timeoutMessage: `Timed out acquiring run-state transaction lock for ${absoluteTarget}`
  });
  try {
    return operation();
  } finally {
    release();
  }
}
