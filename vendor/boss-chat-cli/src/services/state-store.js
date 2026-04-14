import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE_TTL_HOURS = 24;

function createInitialState(profileName) {
  return {
    version: 1,
    profileName,
    updatedAt: null,
    customers: {},
    aliases: {},
  };
}

function isRecoverableStateError(error) {
  if (!error) return false;
  if (error.code === 'ENOENT') return true;
  if (error.name === 'SyntaxError') return true;
  const message = String(error.message || '').toLowerCase();
  return (
    message.includes('unexpected end of json') ||
    message.includes('unexpected token') ||
    message.includes('json')
  );
}

function stateBackupPath(filePath) {
  const token = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filePath}.corrupt-${token}.bak`;
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveStateTtlMs(options = {}) {
  const hours = parsePositiveNumber(
    options.stateTtlHours ?? process.env.BOSS_CHAT_STATE_TTL_HOURS,
    DEFAULT_STATE_TTL_HOURS,
  );
  return Math.floor(hours * 60 * 60 * 1000);
}

function isEntryExpired(entry, nowMs, ttlMs) {
  if (!entry || typeof entry !== 'object') return true;
  const updatedAtRaw = String(entry.updatedAt || '').trim();
  if (!updatedAtRaw) return false;
  const updatedAtMs = Date.parse(updatedAtRaw);
  if (!Number.isFinite(updatedAtMs)) return false;
  return nowMs - updatedAtMs > ttlMs;
}

function pruneExpiredState(state, ttlMs, nowMs = Date.now()) {
  const nextCustomers = {};
  const nextAliases = {};
  const customers = state?.customers && typeof state.customers === 'object' ? state.customers : {};
  const aliases = state?.aliases && typeof state.aliases === 'object' ? state.aliases : {};
  let removedCount = 0;

  for (const [key, entry] of Object.entries(customers)) {
    if (isEntryExpired(entry, nowMs, ttlMs)) {
      removedCount += 1;
      continue;
    }
    nextCustomers[key] = entry;
  }

  for (const [alias, key] of Object.entries(aliases)) {
    if (typeof alias !== 'string' || !alias) continue;
    if (typeof key !== 'string' || !key) continue;
    if (!nextCustomers[key]) continue;
    nextAliases[alias] = key;
  }

  const changed =
    removedCount > 0 ||
    Object.keys(nextAliases).length !== Object.keys(aliases).length ||
    Object.keys(nextCustomers).length !== Object.keys(customers).length;

  return {
    changed,
    removedCount,
    customers: nextCustomers,
    aliases: nextAliases,
  };
}

export class StateStore {
  constructor(baseDir, profileName, options = {}) {
    this.baseDir = baseDir;
    this.profileName = profileName;
    this.statesDir = path.join(baseDir, 'state');
    this.filePath = path.join(this.statesDir, `${profileName}.json`);
    this.state = createInitialState(profileName);
    this.stateTtlMs = resolveStateTtlMs(options);
  }

  async load() {
    await mkdir(this.statesDir, { recursive: true });
    const defaults = createInitialState(this.profileName);
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(String(raw || ''));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new SyntaxError('state file is not a JSON object');
      }
      this.state = {
        ...defaults,
        ...parsed,
        customers: {
          ...defaults.customers,
          ...(parsed.customers || {}),
        },
        aliases: {
          ...defaults.aliases,
          ...(parsed.aliases || {}),
        },
      };

      const pruned = pruneExpiredState(this.state, this.stateTtlMs);
      if (pruned.changed) {
        this.state.customers = pruned.customers;
        this.state.aliases = pruned.aliases;
        this.state.updatedAt = new Date().toISOString();
        await this.persistState();
      }
    } catch (error) {
      if (!isRecoverableStateError(error)) {
        throw error;
      }

      this.state = defaults;
      if (error?.code !== 'ENOENT') {
        const backupPath = stateBackupPath(this.filePath);
        await rename(this.filePath, backupPath);
      }
      await this.persistState();
    }
    return this.state;
  }

  has(customerKey) {
    return Boolean(this.resolveKey(customerKey));
  }

  hasAny(customerKeys = []) {
    return customerKeys.some((customerKey) => this.has(customerKey));
  }

  get(customerKey) {
    const resolved = this.resolveKey(customerKey);
    return resolved ? this.state.customers[resolved] || null : null;
  }

  keys() {
    return new Set(Object.keys(this.state.customers));
  }

  resolveKey(customerKey) {
    if (!customerKey) {
      return null;
    }
    if (this.state.customers[customerKey]) {
      return customerKey;
    }
    return this.state.aliases[customerKey] || null;
  }

  async record(customerKey, entry, aliases = []) {
    this.state.customers[customerKey] = {
      ...entry,
      customerKey,
      aliases,
      updatedAt: new Date().toISOString(),
    };
    for (const alias of aliases) {
      if (alias && alias !== customerKey) {
        this.state.aliases[alias] = customerKey;
      }
    }
    this.state.updatedAt = new Date().toISOString();
    await this.persistState();
  }

  async persistState() {
    await mkdir(this.statesDir, { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}

export class NoopStateStore {
  async load() {
    return { version: 1, customers: {} };
  }

  has() {
    return false;
  }

  hasAny() {
    return false;
  }

  get() {
    return null;
  }

  keys() {
    return new Set();
  }

  async record() {}
}
