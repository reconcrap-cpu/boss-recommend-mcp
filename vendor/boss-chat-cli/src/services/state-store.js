function createInitialState(profileName) {
  return {
    version: 1,
    profileName,
    updatedAt: null,
    customers: {},
    aliases: {},
  };
}

export class StateStore {
  constructor(_baseDir, profileName, _options = {}) {
    this.profileName = profileName;
    this.state = createInitialState(profileName);
  }

  async load() {
    // Session-only dedup: each run starts with an empty state and does not persist cross-run history.
    this.state = createInitialState(this.profileName);
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
  }

  async persistState() {}
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
