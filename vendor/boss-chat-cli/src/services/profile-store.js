import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_PROFILE = {
  screeningCriteria: '',
  targetCount: null,
  startFrom: 'unread',
  jobSelection: null,
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  chrome: {
    port: 9222,
  },
  runtime: {
    batchRestEnabled: true,
    safePacing: true,
  },
};

function cloneDefaultProfile() {
  return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
}

function mergeProfile(base, override) {
  return {
    ...base,
    ...override,
    llm: {
      ...base.llm,
      ...(override?.llm || {}),
    },
    chrome: {
      ...base.chrome,
      ...(override?.chrome || {}),
    },
    runtime: {
      ...base.runtime,
      ...(override?.runtime || {}),
    },
  };
}

function normalizeNumber(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOptionalPositiveNumber(value, fallback = null) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeJobSelection(jobSelection) {
  if (!jobSelection || typeof jobSelection !== 'object') {
    return null;
  }
  const value = String(jobSelection.value || '').trim();
  const label = String(jobSelection.label || '').trim();
  if (!value && !label) {
    return null;
  }
  return {
    value: value || null,
    label: label || null,
  };
}

export function toPersistentProfile(profile = {}) {
  const normalized = normalizeProfile(profile);
  return {
    llm: {
      baseUrl: normalized.llm.baseUrl,
      apiKey: normalized.llm.apiKey,
      model: normalized.llm.model,
    },
    chrome: {
      port: normalized.chrome.port,
    },
    runtime: {
      batchRestEnabled: normalized.runtime.batchRestEnabled,
      safePacing: normalized.runtime.safePacing,
    },
  };
}

export function normalizeProfile(profile = {}) {
  const merged = mergeProfile(cloneDefaultProfile(), profile);
  merged.screeningCriteria = String(merged.screeningCriteria || '').trim();
  merged.startFrom = String(merged.startFrom || '').trim().toLowerCase() === 'all' ? 'all' : 'unread';
  merged.targetCount = normalizeOptionalPositiveNumber(merged.targetCount, null);
  merged.jobSelection = normalizeJobSelection(merged.jobSelection);
  merged.chrome.port = normalizeNumber(merged.chrome.port, DEFAULT_PROFILE.chrome.port);
  merged.llm.baseUrl = String(merged.llm.baseUrl || '').trim().replace(/\/+$/, '');
  merged.llm.apiKey = String(merged.llm.apiKey || '').trim();
  merged.llm.model = String(merged.llm.model || '').trim();
  merged.runtime.batchRestEnabled = merged.runtime.batchRestEnabled !== false;
  merged.runtime.safePacing = merged.runtime.safePacing !== false;
  return merged;
}

export function validateProfile(profile) {
  const missing = [];
  if (!profile.llm.baseUrl) missing.push('llm.baseUrl');
  if (!profile.llm.apiKey) missing.push('llm.apiKey');
  if (!profile.llm.model) missing.push('llm.model');
  if (!profile.chrome.port) missing.push('chrome.port');
  return missing;
}

export class ProfileStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.profilesDir = path.join(baseDir, 'profiles');
  }

  profilePath(profileName) {
    return path.join(this.profilesDir, `${profileName}.json`);
  }

  async ensureDir() {
    await mkdir(this.profilesDir, { recursive: true });
  }

  async load(profileName) {
    await this.ensureDir();
    try {
      const raw = await readFile(this.profilePath(profileName), 'utf8');
      return normalizeProfile(JSON.parse(raw));
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async save(profileName, profile) {
    await this.ensureDir();
    const normalized = toPersistentProfile(profile);
    await writeFile(
      this.profilePath(profileName),
      `${JSON.stringify(normalized, null, 2)}\n`,
      'utf8',
    );
    return normalizeProfile(normalized);
  }

  mergeWithOverrides(profile, overrides) {
    return normalizeProfile(mergeProfile(profile || cloneDefaultProfile(), overrides));
  }
}
