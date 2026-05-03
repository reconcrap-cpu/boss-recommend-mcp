import path from "node:path";

export function addTiming(timings, key, value) {
  if (!timings || !key) return;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return;
  timings[key] = (Number(timings[key]) || 0) + Math.round(numeric);
}

export async function measureTiming(timings, key, task) {
  const started = Date.now();
  try {
    return await task();
  } finally {
    addTiming(timings, key, Date.now() - started);
  }
}

export function imageEvidenceFilePath({
  imageOutputDir = "",
  domain = "candidate",
  runId = "",
  index = 0,
  extension = "png"
} = {}) {
  const dir = String(imageOutputDir || "").trim();
  if (!dir) return "";
  const safeDomain = String(domain || "candidate").replace(/[^\w.-]+/g, "_");
  const safeRunId = String(runId || `${safeDomain}-run`).replace(/[^\w.-]+/g, "_");
  const safeIndex = String((Number(index) || 0) + 1).padStart(3, "0");
  const safeExt = String(extension || "png").replace(/^\./, "") || "png";
  return path.join(dir, safeRunId, `${safeDomain}-candidate-${safeIndex}.${safeExt}`);
}
