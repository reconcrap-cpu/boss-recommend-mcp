import {
  bringPageToFront,
  detectBossLoginState,
  sleep
} from "../../core/browser/index.js";
import {
  HEALTH_STATUS,
  runSelfHealCheck
} from "../../core/self-heal/index.js";

function compactProbe(probe = {}) {
  return {
    id: probe.id || "",
    type: probe.type || "",
    status: probe.status || "",
    count: probe.count || 0,
    required: Boolean(probe.required),
    error: probe.error || null
  };
}

export function compactRecoveryHealth(check = null) {
  if (!check) return null;
  return {
    domain: check.domain || "",
    status: check.status || "",
    summary: check.summary || null,
    drift_report: check.drift_report || null,
    probes: (check.probes || []).map(compactProbe)
  };
}

export function createRecoverySettleError(domain, settle = {}) {
  const status = settle.status || settle.reason || "unknown";
  const error = new Error(`${domain} mini fresh-start settle failed: ${status}`);
  error.code = `${String(domain || "boss").toUpperCase()}_RECOVERY_SETTLE_FAILED`;
  error.recovery_settle = settle;
  error.retryable = true;
  return error;
}

export async function waitForMiniFreshStartSettle(client, {
  domain = "boss",
  timeoutMs = 90000,
  intervalMs = 800,
  settleMs = 0,
  readinessLabel = "ready",
  checkReady = null,
  selfHealConfig = null,
  resolveSelfHealRoots = null
} = {}) {
  const started = Date.now();
  let lastReady = null;
  let lastHealth = null;
  let lastRoots = null;
  let lastLoginDetection = null;

  if (typeof client?.Network?.setCacheDisabled === "function") {
    await client.Network.setCacheDisabled({ cacheDisabled: true }).catch(() => null);
  }
  await bringPageToFront(client).catch(() => null);
  if (settleMs > 0) await sleep(settleMs);

  while (Date.now() - started <= timeoutMs) {
    lastLoginDetection = await detectBossLoginState(client).catch((error) => ({
      requires_login: false,
      reason: "login_detection_failed",
      error: error?.message || String(error || "")
    }));
    if (lastLoginDetection?.requires_login) {
      return {
        ok: false,
        domain,
        status: "login_required",
        reason: "login_required",
        elapsed_ms: Date.now() - started,
        login_detection: lastLoginDetection,
        readiness: lastReady,
        health: compactRecoveryHealth(lastHealth),
        roots: lastRoots
      };
    }

    if (typeof checkReady === "function") {
      lastReady = await checkReady({
        elapsedMs: Date.now() - started,
        remainingMs: Math.max(1, timeoutMs - (Date.now() - started))
      }).catch((error) => ({
        ok: false,
        reason: "readiness_check_failed",
        error: error?.message || String(error || "")
      }));
      if (lastReady?.ok) {
        return {
          ok: true,
          domain,
          status: "ready",
          reason: readinessLabel,
          elapsed_ms: Date.now() - started,
          readiness: lastReady,
          health: compactRecoveryHealth(lastHealth),
          roots: lastRoots
        };
      }
    }

    if (selfHealConfig && typeof resolveSelfHealRoots === "function") {
      const rootsResult = await resolveSelfHealRoots(client, selfHealConfig).catch((error) => ({
        roots: {},
        error: error?.message || String(error || "")
      }));
      lastRoots = rootsResult?.roots || {};
      lastHealth = await runSelfHealCheck({
        client,
        domain,
        roots: lastRoots,
        selectorProbes: selfHealConfig.selectorProbes || [],
        accessibilityProbes: selfHealConfig.accessibilityProbes || [],
        viewportProbes: selfHealConfig.viewportProbes || []
      }).catch((error) => ({
        domain,
        status: "failed",
        summary: {
          status: "failed",
          failed_required: 1
        },
        probes: [],
        drift_report: [],
        error: error?.message || String(error || "")
      }));
      if (lastHealth?.status === HEALTH_STATUS.HEALTHY) {
        return {
          ok: true,
          domain,
          status: HEALTH_STATUS.HEALTHY,
          reason: "self_heal_healthy",
          elapsed_ms: Date.now() - started,
          readiness: lastReady,
          health: compactRecoveryHealth(lastHealth),
          roots: lastRoots
        };
      }
    }

    await sleep(intervalMs);
  }

  return {
    ok: false,
    domain,
    status: lastHealth?.status || lastReady?.reason || "timeout",
    reason: "timeout",
    elapsed_ms: Date.now() - started,
    login_detection: lastLoginDetection,
    readiness: lastReady,
    health: compactRecoveryHealth(lastHealth),
    roots: lastRoots
  };
}
