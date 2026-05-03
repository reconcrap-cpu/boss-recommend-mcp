import { normalizeText } from "../screening/index.js";

export const GREET_CREDITS_EXHAUSTED_CODE = "GREET_CREDITS_EXHAUSTED";

function coerceQuota(quota) {
  if (!quota || typeof quota !== "object") return null;
  return {
    found: Boolean(quota.found),
    text: normalizeText(quota.text),
    numerator: Number.isFinite(Number(quota.numerator)) ? Number(quota.numerator) : null,
    denominator: Number.isFinite(Number(quota.denominator)) ? Number(quota.denominator) : null,
    exhausted: Boolean(quota.exhausted)
  };
}

export function parseGreetQuota(label = "") {
  const text = normalizeText(label);
  const match = text.match(/立即沟通\s*[\(（]\s*(\d+)\s*[/／]\s*(\d+)\s*[\)）]/);
  if (!match) {
    return {
      found: false,
      text,
      numerator: null,
      denominator: null,
      exhausted: false
    };
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return {
    found: true,
    text,
    numerator,
    denominator,
    exhausted: numerator > denominator
  };
}

export function normalizeGreetQuotaSource(source = "") {
  return coerceQuota(source) || parseGreetQuota(source);
}

export function assertGreetQuotaAvailable(source = "") {
  const quota = normalizeGreetQuotaSource(source);
  if (quota.exhausted) {
    const error = new Error(
      `Greet credits exhausted according to Boss quota text: ${quota.numerator}/${quota.denominator}`
    );
    error.code = GREET_CREDITS_EXHAUSTED_CODE;
    error.greet_quota = quota;
    throw error;
  }
  return quota;
}
