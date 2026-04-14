import { createHash } from 'node:crypto';

function normalized(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function shortHash(parts) {
  return createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 16);
}

function collectExplicitIds(customer = {}) {
  return [
    customer.customerId,
    customer.domKey,
    customer.listItemKey,
    customer.reactKey,
    customer.dc,
    customer.id,
    customer.uid,
    customer.geekId,
    customer.cardId,
  ]
    .map(normalized)
    .filter(Boolean);
}

export function createCustomerKey(customer = {}) {
  const [explicitId] = collectExplicitIds(customer);

  if (explicitId) {
    return `id:${explicitId}`;
  }

  const name = normalized(customer.name);
  const company = normalized(customer.company);
  const educationText = normalized(customer.educationText);
  const textSnippet = normalized(customer.textSnippet);

  const stableSeed = [name, company, educationText].filter(Boolean);
  const seed = stableSeed.length > 0 ? stableSeed.join('|') : textSnippet;

  if (!seed) {
    throw new Error('Cannot create customer key without id or identifying text');
  }

  const digest = createHash('sha1').update(seed).digest('hex').slice(0, 16);
  return `hash:${digest}`;
}

export function createCustomerAliases(customer = {}) {
  const aliases = new Set();
  const name = normalized(customer.name);
  const company = normalized(customer.company);
  const educationText = normalized(customer.educationText);
  const textSnippet = normalized(customer.textSnippet).slice(0, 120);

  for (const explicitId of collectExplicitIds(customer)) {
    aliases.add(`id:${explicitId}`);
  }

  try {
    aliases.add(createCustomerKey(customer));
  } catch {}

  if (name && company) {
    aliases.add(`nc:${shortHash([name, company])}`);
  }
  if (name && educationText) {
    aliases.add(`ne:${shortHash([name, educationText])}`);
  }
  if (company && educationText) {
    aliases.add(`ce:${shortHash([company, educationText])}`);
  }
  if (name && company && educationText) {
    aliases.add(`nce:${shortHash([name, company, educationText])}`);
  }
  if (!company && name && textSnippet) {
    aliases.add(`ns:${shortHash([name, textSnippet])}`);
  }

  return Array.from(aliases);
}
