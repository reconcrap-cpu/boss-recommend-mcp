import { createCustomerKey } from '../utils/customer-key.js';

const CHAT_URL_TOKEN = '/web/chat/index';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function browserGetPageState() {
  const querySelectors = (selectors) => {
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found) return found;
    }
    return null;
  };
  const listContainer = querySelectors([
    '.user-list.b-scroll-stable',
    '.chat-user .user-list',
    '.chat-user .user-container > div > div:nth-child(2)',
    '.chat-user .user-container [class*="list"]',
  ]);
  const listItems = document.querySelectorAll('div[role="listitem"]');

  return {
    href: window.location.href,
    readyState: document.readyState,
    hasListContainer: Boolean(listContainer),
    listItemCount: listItems.length,
  };
}

function browserGetCurrentHref() {
  return { href: window.location.href };
}

function browserNavigateToChatIndex(options = {}) {
  const chatUrl = 'https://www.zhipin.com/web/chat/index';
  const force = options?.force === true;
  if (force || !String(window.location.href || '').includes('/web/chat/index')) {
    window.location.assign(chatUrl);
    return { ok: true, changed: true, href: chatUrl };
  }
  return { ok: true, changed: false, href: window.location.href };
}

async function browserListJobs() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };

  const triggerSelectors = [
    '.chat-job-select',
    '.chat-job-selector',
    '.job-selecter',
    '.job-selector',
    '.job-select-wrap',
    '.job-select',
    '.job-select-box',
    '.job-wrap',
    '.chat-job-name',
    '.top-chat-search',
  ];

  for (const selector of triggerSelectors) {
    const trigger = document.querySelector(selector);
    if (trigger && isVisible(trigger)) {
      trigger.click();
      break;
    }
  }

  await new Promise((resolve) => window.setTimeout(resolve, 180));

  const items = Array.from(
    document.querySelectorAll('.ui-dropmenu-list li[value], .dropmenu-list li[value]'),
  );
  const jobs = [];
  const seen = new Set();
  for (const item of items) {
    const label = normalize(item.textContent || '');
    const value = normalize(item.getAttribute('value') || item.dataset?.value || '');
    if (!label) continue;
    const key = `${value}__${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({
      value: value || null,
      label,
      active: item.classList.contains('active') || item.classList.contains('curr'),
      visible: isVisible(item),
    });
  }

  return {
    ok: true,
    jobs,
  };
}

async function browserSelectJob(jobSelection) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const targetValue = normalize(jobSelection?.value || '');
  const targetLabel = normalize(jobSelection?.label || '');

  const triggerSelectors = [
    '.chat-job-select',
    '.chat-job-selector',
    '.job-selecter',
    '.job-selector',
    '.job-select-wrap',
    '.job-select',
    '.job-select-box',
    '.job-wrap',
    '.chat-job-name',
    '.top-chat-search',
  ];
  for (const selector of triggerSelectors) {
    const trigger = document.querySelector(selector);
    if (trigger && isVisible(trigger)) {
      trigger.click();
      break;
    }
  }
  await new Promise((resolve) => window.setTimeout(resolve, 180));

  const items = Array.from(
    document.querySelectorAll('.ui-dropmenu-list li[value], .dropmenu-list li[value]'),
  );
  if (items.length === 0) {
    return { ok: false, error: 'JOB_OPTIONS_NOT_FOUND' };
  }

  const target = items.find((item) => {
    const value = normalize(item.getAttribute('value') || item.dataset?.value || '');
    const label = normalize(item.textContent || '');
    return (targetValue && value === targetValue) || (targetLabel && label === targetLabel);
  });

  if (!target) {
    return { ok: false, error: 'JOB_OPTION_NOT_FOUND' };
  }

  target.click();
  await new Promise((resolve) => window.setTimeout(resolve, 280));

  const refreshed = Array.from(
    document.querySelectorAll('.ui-dropmenu-list li[value], .dropmenu-list li[value]'),
  );
  const selected = refreshed.find((item) => item.classList.contains('active') || item.classList.contains('curr'));
  const selectedLabel = normalize(selected?.textContent || '');
  const selectedValue = normalize(selected?.getAttribute('value') || selected?.dataset?.value || '');
  const matched =
    (targetValue && selectedValue === targetValue) || (targetLabel && selectedLabel === targetLabel);

  return {
    ok: true,
    matched,
    selected: {
      value: selectedValue || null,
      label: selectedLabel || null,
    },
  };
}

async function browserActivateFilterTab(label) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0.01;
  };

  const getMessageFilterCandidates = () => {
    const containers = [
      ...Array.from(document.querySelectorAll('.chat-message-filter-left')),
      ...Array.from(document.querySelectorAll('.chat-message-filter')),
    ].filter(isVisible);
    for (const container of containers) {
      const scoped = Array.from(container.querySelectorAll('span,button,a,div'))
        .filter((node) => isVisible(node))
        .filter((node) => ['全部', '未读'].includes(normalize(node.textContent || '')));
      if (scoped.length > 0) {
        return scoped;
      }
    }
    return [];
  };

  const getActiveFilterLabel = () => {
    const activeNode = Array.from(
      document.querySelectorAll(
        '.chat-message-filter-left span.active, .chat-message-filter span.active, .chat-message-filter-left .active, .chat-message-filter .active',
      ),
    ).find((node) => isVisible(node));
    return normalize(activeNode?.textContent || '');
  };

  const hasActiveState = (node) => {
    let current = node;
    let depth = 0;
    while (current instanceof HTMLElement && depth < 4) {
      if (
        current.classList.contains('active') ||
        current.classList.contains('curr') ||
        current.getAttribute('aria-selected') === 'true' ||
        current.getAttribute('data-active') === 'true'
      ) {
        return true;
      }
      current = current.parentElement;
      depth += 1;
    }
    return false;
  };

  const messageFilterCandidates = getMessageFilterCandidates();
  const candidates = (
    messageFilterCandidates.length > 0
      ? messageFilterCandidates
      : Array.from(document.querySelectorAll('span,button,div,li,a,[role="tab"]'))
  ).filter((node) => normalize(node.textContent || '') === label && isVisible(node));

  if (candidates.length === 0) {
    return { ok: false, error: `FILTER_TAB_NOT_FOUND:${label}` };
  }

  const active = candidates.find((node) => hasActiveState(node));
  const activeLabelBefore = getActiveFilterLabel();
  if (active || activeLabelBefore === label) {
    return { ok: true, changed: false, verified: true, activeLabel: activeLabelBefore || label };
  }

  const target = candidates[0];
  const parentFilterItem = target.closest('.chat-message-filter-left span, .chat-message-filter-left [class*="item"]');
  const clickable =
    parentFilterItem ||
    target.closest('button,[role="tab"],a,li,[class*="tab"],[class*="filter"],div') ||
    target;

  clickable.click();
  await new Promise((resolve) => window.setTimeout(resolve, 380));

  const refreshedCandidates = getMessageFilterCandidates();
  const refreshed = (
    refreshedCandidates.length > 0
      ? refreshedCandidates
      : Array.from(document.querySelectorAll('span,button,div,li,a,[role="tab"]'))
  ).filter((node) => normalize(node.textContent || '') === label && isVisible(node));
  const activeLabelAfter = getActiveFilterLabel();
  const verified = activeLabelAfter === label || refreshed.some((node) => hasActiveState(node));

  return {
    ok: true,
    changed: true,
    verified,
    activeLabel: activeLabelAfter || '',
  };
}

function browserGetLoadedCustomers() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isScrollable = (el) =>
    el instanceof HTMLElement &&
    Number(el.scrollHeight || 0) > Number(el.clientHeight || 0) + 16 &&
    Number(el.clientHeight || 0) > 80;
  const querySelectors = (selectors) => {
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found) return found;
    }
    return null;
  };
  let listContainer = querySelectors([
    '.user-list.b-scroll-stable',
    '.chat-user .user-list',
    '.chat-user .user-container > div > div:nth-child(2)',
    '.chat-user .user-container [class*="list"]',
  ]);

  if (!listContainer) {
    const firstCard = document.querySelector('div[role="listitem"]');
    if (firstCard instanceof HTMLElement) {
      let current = firstCard.parentElement;
      let depth = 0;
      let best = null;
      while (current && depth < 24) {
        if (isScrollable(current)) {
          best = current;
          if (/user|list|chat/i.test(String(current.className || ''))) {
            break;
          }
        }
        current = current.parentElement;
        depth += 1;
      }
      listContainer = best || firstCard.parentElement;
    }
  }

  const cardSource = listContainer || document;
  const cards = Array.from(cardSource.querySelectorAll('div[role="listitem"]'))
    .filter((node) => node instanceof HTMLElement)
    .map((card, domIndex) => {
      const text = normalize(card.textContent || '');
      const lines = text.split(/\n+/).map(normalize).filter(Boolean);
      const rect = card.getBoundingClientRect();
      const geekItem = card.querySelector('.geek-item[data-id], .geek-item');
      const nameNode = card.querySelector('.geek-name,[class*="name"]');
      const sourceJobNode = card.querySelector('.source-job');

      return {
        domIndex,
        customerId:
          geekItem?.getAttribute('data-id') ||
          card.getAttribute('key') ||
          card.getAttribute('data-key') ||
          card.dataset.id ||
          card.id ||
          '',
        name: normalize(nameNode?.textContent || lines[1] || lines[0] || ''),
        sourceJob: normalize(sourceJobNode?.textContent || ''),
        textSnippet: text.slice(0, 300),
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        },
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > listContainer.getBoundingClientRect().top &&
          rect.top < listContainer.getBoundingClientRect().bottom,
      };
    })
    .filter((card) => card.textSnippet);

  if (cards.length === 0) {
    return {
      ok: false,
      error: 'CHAT_CARD_LIST_NOT_FOUND',
      customers: [],
    };
  }

  return {
    ok: true,
    customers: cards,
    scroll: {
      top: Number(listContainer?.scrollTop || 0),
      height: Number(listContainer?.scrollHeight || 0),
      clientHeight: Number(listContainer?.clientHeight || 0),
    },
  };
}

function browserPrimeConversationByFirstCandidate() {
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const items = Array.from(document.querySelectorAll('div[role="listitem"]')).filter((node) => node instanceof HTMLElement);
  const target = items.find((item) => isVisible(item)) || items[0];
  if (!(target instanceof HTMLElement)) {
    return { ok: false, error: 'NO_FIRST_CANDIDATE' };
  }

  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  const clickTarget = target.querySelector('.geek-item[data-id], .geek-item, .geek-item-wrap') || target;
  if (!(clickTarget instanceof HTMLElement)) {
    return { ok: false, error: 'FIRST_CANDIDATE_NOT_CLICKABLE' };
  }

  const geekItem = target.querySelector('.geek-item[data-id], .geek-item');
  const name = normalize(
    target.querySelector('.geek-name,[class*="name"]')?.textContent ||
      '',
  );
  const sourceJob = normalize(target.querySelector('.source-job')?.textContent || '');
  const customerId = normalize(
    geekItem?.getAttribute('data-id') ||
      target.getAttribute('key') ||
      target.getAttribute('data-key') ||
      target.dataset.id ||
      '',
  );
  const domIndex = items.indexOf(target);

  clickTarget.click();
  return {
    ok: true,
    text: normalize(target.textContent || '').slice(0, 120),
    candidate: {
      name: name || null,
      sourceJob: sourceJob || null,
      customerId: customerId || null,
      domIndex,
    },
    totalVisibleCandidates: items.length,
  };
}

function browserCenterCandidateInList(options = {}) {
  const domIndex = Number(options.domIndex);
  const drift = Number(options.drift || 0);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const isScrollable = (el) =>
    el instanceof HTMLElement &&
    Number(el.scrollHeight || 0) > Number(el.clientHeight || 0) + 16 &&
    Number(el.clientHeight || 0) > 80;
  const querySelectors = (selectors) => {
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found) return found;
    }
    return null;
  };
  let listContainer = querySelectors([
    '.user-list.b-scroll-stable',
    '.chat-user .user-list',
    '.chat-user .user-container > div > div:nth-child(2)',
    '.chat-user .user-container [class*="list"]',
  ]);

  if (!listContainer) {
    const firstCard = document.querySelector('div[role="listitem"]');
    if (firstCard instanceof HTMLElement) {
      let current = firstCard.parentElement;
      let depth = 0;
      let best = null;
      while (current && depth < 24) {
        if (isScrollable(current)) {
          best = current;
          if (/user|list|chat/i.test(String(current.className || ''))) {
            break;
          }
        }
        current = current.parentElement;
        depth += 1;
      }
      listContainer = best || firstCard.parentElement;
    }
  }

  if (!listContainer) {
    return { ok: false, error: 'CHAT_LIST_CONTAINER_NOT_FOUND' };
  }

  const cards = Array.from(listContainer.querySelectorAll('div[role="listitem"]'));
  const card = cards[domIndex];
  if (!(card instanceof HTMLElement)) {
    return { ok: false, error: `CARD_NOT_FOUND:${domIndex}` };
  }

  const beforeTop = Number(listContainer.scrollTop || 0);
  const listRect = listContainer.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const listCenter = listRect.top + listRect.height / 2;
  const cardCenter = cardRect.top + cardRect.height / 2;
  const delta = cardCenter - listCenter + drift;
  const maxScroll = Math.max(0, listContainer.scrollHeight - listContainer.clientHeight);
  const targetScroll = clamp(beforeTop + delta, 0, maxScroll);
  listContainer.scrollTop = targetScroll;
  listContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

  const rect = card.getBoundingClientRect();
  return {
    ok: true,
    beforeTop,
    afterTop: Number(listContainer.scrollTop || 0),
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    },
  };
}

function browserActivateCandidate(options = {}) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const domIndex = Number(options.domIndex);
  const drift = Number(options.drift || 0);
  const targetId = normalize(options.customerId || '');
  const targetName = normalize(options.name || '');
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const isScrollable = (el) =>
    el instanceof HTMLElement &&
    Number(el.scrollHeight || 0) > Number(el.clientHeight || 0) + 16 &&
    Number(el.clientHeight || 0) > 80;
  const querySelectors = (selectors) => {
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found) return found;
    }
    return null;
  };
  let listContainer = querySelectors([
    '.user-list.b-scroll-stable',
    '.chat-user .user-list',
    '.chat-user .user-container > div > div:nth-child(2)',
    '.chat-user .user-container [class*="list"]',
  ]);

  if (!listContainer) {
    const firstCard = document.querySelector('div[role="listitem"]');
    if (firstCard instanceof HTMLElement) {
      let current = firstCard.parentElement;
      let depth = 0;
      let best = null;
      while (current && depth < 24) {
        if (isScrollable(current)) {
          best = current;
          if (/user|list|chat/i.test(String(current.className || ''))) {
            break;
          }
        }
        current = current.parentElement;
        depth += 1;
      }
      listContainer = best || firstCard.parentElement;
    }
  }

  if (!listContainer) {
    return { ok: false, error: 'CHAT_LIST_CONTAINER_NOT_FOUND' };
  }

  const cards = Array.from(listContainer.querySelectorAll('div[role="listitem"]')).filter(
    (node) => node instanceof HTMLElement,
  );
  const resolveCardMeta = (card) => {
    const geekItem = card.querySelector('.geek-item[data-id], .geek-item');
    const customerId = normalize(
      geekItem?.getAttribute('data-id') ||
        card.getAttribute('key') ||
        card.getAttribute('data-key') ||
        card.dataset.id ||
        card.id ||
        '',
    );
    const name = normalize(card.querySelector('.geek-name,[class*="name"]')?.textContent || '');
    return { customerId, name };
  };

  let card = null;
  if (targetId) {
    card = cards.find((item) => {
      const meta = resolveCardMeta(item);
      return (
        meta.customerId === targetId ||
        (meta.customerId && targetId.endsWith(meta.customerId)) ||
        (targetId && meta.customerId.endsWith(targetId))
      );
    });
  }
  if (!card && targetName) {
    card = cards.find((item) => resolveCardMeta(item).name === targetName);
  }
  if (!card && Number.isFinite(domIndex)) {
    card = cards[domIndex] || null;
  }
  if (!(card instanceof HTMLElement)) {
    return { ok: false, error: 'TARGET_CANDIDATE_NOT_FOUND' };
  }

  const beforeTop = Number(listContainer.scrollTop || 0);
  const listRect = listContainer.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const listCenter = listRect.top + listRect.height / 2;
  const cardCenter = cardRect.top + cardRect.height / 2;
  const delta = cardCenter - listCenter + drift;
  const maxScroll = Math.max(0, listContainer.scrollHeight - listContainer.clientHeight);
  const targetScroll = clamp(beforeTop + delta, 0, maxScroll);
  listContainer.scrollTop = targetScroll;
  listContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

  const clickTarget = card.querySelector('.geek-item[data-id], .geek-item, .geek-item-wrap') || card;
  if (!(clickTarget instanceof HTMLElement)) {
    return { ok: false, error: 'TARGET_CANDIDATE_NOT_CLICKABLE' };
  }
  clickTarget.click();
  const rect = card.getBoundingClientRect();
  const meta = resolveCardMeta(card);
  return {
    ok: true,
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    },
    resolved: {
      customerId: meta.customerId,
      name: meta.name,
      domIndex: cards.indexOf(card),
    },
  };
}

function browserScrollCustomerList(options = {}) {
  const ratio = Number(options.ratio || 0.72);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const isOverflowScrollable = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    return /(auto|scroll|overlay)/i.test(String(style.overflowY || ''));
  };
  const findBestScrollableContainer = (seedCard) => {
    const candidates = [];
    const pushCandidate = (node) => {
      if (node instanceof HTMLElement) candidates.push(node);
    };
    if (seedCard instanceof HTMLElement) {
      let current = seedCard.parentElement;
      let depth = 0;
      while (current && depth < 30) {
        pushCandidate(current);
        current = current.parentElement;
        depth += 1;
      }
    }
    const unique = Array.from(new Set(candidates));
    let best = null;
    let bestScore = -Infinity;
    for (const node of unique) {
      const scrollRange = Number(node.scrollHeight || 0) - Number(node.clientHeight || 0);
      const styleBonus = isOverflowScrollable(node) ? 80 : 0;
      const classBonus = /user|list|chat/i.test(String(node.className || '')) ? 24 : 0;
      const score = scrollRange + styleBonus + classBonus;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
    return best;
  };
  const isScrollable = (el) =>
    el instanceof HTMLElement &&
    Number(el.scrollHeight || 0) > Number(el.clientHeight || 0) + 16 &&
    Number(el.clientHeight || 0) > 80;
  const querySelectors = (selectors) => {
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found) return found;
    }
    return null;
  };
  let listContainer = querySelectors([
    '.user-list.b-scroll-stable',
    '.chat-user .user-list',
    '.chat-user .user-container > div > div:nth-child(2)',
    '.chat-user .user-container [class*="list"]',
  ]);

  if (!listContainer) {
    const firstCard = document.querySelector('div[role="listitem"]');
    if (firstCard instanceof HTMLElement) {
      let current = firstCard.parentElement;
      let depth = 0;
      let best = null;
      while (current && depth < 24) {
        if (isScrollable(current)) {
          best = current;
          if (/user|list|chat/i.test(String(current.className || ''))) {
            break;
          }
        }
        current = current.parentElement;
        depth += 1;
      }
      listContainer = best || firstCard.parentElement;
    }
  }

  if (!listContainer) {
    return { ok: false, error: 'CHAT_LIST_CONTAINER_NOT_FOUND' };
  }

  const findNoMoreTips = () => {
    const host =
      listContainer.closest('.chat-user, .user-container, .chat-container, .chat-main') || document;
    const tips = Array.from(host.querySelectorAll('div[role="tfoot"] .load-tips, p.load-tips')).find((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const text = normalize(node.textContent || '');
      return text.includes('没有更多了') && isVisible(node);
    });
    return {
      detected: Boolean(tips),
      text: normalize(tips?.textContent || ''),
    };
  };

  const firstCard = listContainer.querySelector('div[role="listitem"]') || document.querySelector('div[role="listitem"]');
  if (firstCard instanceof HTMLElement) {
    const best = findBestScrollableContainer(firstCard);
    if (best instanceof HTMLElement) {
      listContainer = best;
    }
  }

  const noMoreBefore = findNoMoreTips();
  const before = {
    top: Number(listContainer.scrollTop || 0),
    height: Number(listContainer.scrollHeight || 0),
    clientHeight: Number(listContainer.clientHeight || 0),
    cardCount: Number(listContainer.querySelectorAll('div[role="listitem"]').length || 0),
  };
  const amount = Math.max(120, Math.round(before.clientHeight * Math.max(0.35, Math.min(0.95, ratio))));
  const maxScroll = Math.max(0, before.height - before.clientHeight);
  if (maxScroll > 0) {
    listContainer.scrollTop = clamp(before.top + amount, 0, maxScroll);
  } else {
    const cards = Array.from(listContainer.querySelectorAll('div[role="listitem"]')).filter(
      (node) => node instanceof HTMLElement,
    );
    const tail = cards[cards.length - 1];
    if (tail instanceof HTMLElement) {
      tail.scrollIntoView({ block: 'end', inline: 'nearest' });
      try {
        listContainer.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: amount,
            bubbles: true,
            cancelable: true,
          }),
        );
      } catch {}
    }
  }
  listContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

  const after = {
    top: Number(listContainer.scrollTop || 0),
    height: Number(listContainer.scrollHeight || 0),
    clientHeight: Number(listContainer.clientHeight || 0),
    cardCount: Number(listContainer.querySelectorAll('div[role="listitem"]').length || 0),
  };
  const noMoreAfter = findNoMoreTips();
  const atBottom = after.height <= after.clientHeight + 2 || after.top >= Math.max(0, after.height - after.clientHeight - 2);

  return {
    ok: true,
    before,
    after,
    atBottom,
    noMoreDetectedBefore: noMoreBefore.detected,
    noMoreDetectedAfter: noMoreAfter.detected,
    noMoreTextBefore: noMoreBefore.text,
    noMoreTextAfter: noMoreAfter.text,
    didScroll:
      before.top !== after.top ||
      before.height !== after.height ||
      before.cardCount !== after.cardCount,
  };
}

function browserConversationReadyState() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isAskResumeText = (text) => {
    const normalized = normalize(text);
    if (!normalized) return false;
    return (
      normalized === '求简历' ||
      normalized === '索要简历' ||
      normalized === '求附件简历' ||
      normalized.includes('求简历') ||
      normalized.includes('索要简历') ||
      normalized.includes('附件简历')
    );
  };
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const isDisabled = (el) => {
    const classText = String(el?.className || '').toLowerCase();
    const ariaDisabled = String(el?.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true';
    const disabledAttr = Boolean(el?.hasAttribute?.('disabled'));
    return classText.includes('disabled') || ariaDisabled || disabledAttr;
  };
  const isDisabledDeep = (el) => {
    if (!(el instanceof HTMLElement)) return true;
    let current = el;
    let depth = 0;
    while (current && depth < 5) {
      if (isDisabled(current)) return true;
      current = current.parentElement;
      depth += 1;
    }
    return false;
  };
  const resolveAttachmentButton = () => {
    const candidates = Array.from(
      document.querySelectorAll(
        '.resume-btn-file, .btn.resume-btn-file, [class*="resume-btn-file"]',
      ),
    ).filter((el) => isVisible(el));
    const match = candidates.find((el) => {
      const text = normalize(el.textContent || '');
      if (!text) return false;
      if (!text.includes('附件简历')) return false;
      if (text.includes('求附件简历')) return false;
      return true;
    });
    return match || null;
  };
  const onlineResume = Array.from(
    document.querySelectorAll(
      'a.btn.resume-btn-online, a.resume-btn-online, .resume-btn-online, .btn.resume-btn-online',
    ),
  ).find((el) => {
    if (!isVisible(el)) return false;
      if (!normalize(el.textContent || '').includes('在线简历')) return false;
      return !isDisabled(el);
  });
  const attachmentResume = resolveAttachmentButton();
  const askResume = Array.from(document.querySelectorAll('span.operate-btn, button, a, span')).find(
    (el) => isVisible(el) && isAskResumeText(el.textContent || ''),
  );
  const attachmentResumeEnabled = Boolean(attachmentResume) && !isDisabledDeep(attachmentResume);
  return {
    hasOnlineResume: Boolean(onlineResume),
    hasAskResume: Boolean(askResume),
    onlineResumeClass: String(onlineResume?.className || ''),
    hasAttachmentResume: Boolean(attachmentResume),
    attachmentResumeEnabled,
    attachmentResumeClass: String(attachmentResume?.className || ''),
  };
}

function browserOpenOnlineResume(options = {}) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const selectors = [
    'a.btn.resume-btn-online',
    'a.resume-btn-online',
    '.resume-btn-online',
    '.btn.resume-btn-online',
  ];
  let target = null;
  let selectorUsed = '';
  for (const selector of selectors) {
    const node = Array.from(document.querySelectorAll(selector)).find(
      (el) => {
        if (!isVisible(el)) return false;
        if (!normalize(el.textContent || '').includes('在线简历')) return false;
        const classText = String(el.className || '').toLowerCase();
        const ariaDisabled = String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        const disabledAttr = el.hasAttribute('disabled');
        return !classText.includes('disabled') && !ariaDisabled && !disabledAttr;
      },
    );
    if (node) {
      target = node;
      selectorUsed = selector;
      break;
    }
  }
  if (!target) {
    return { ok: false, error: 'ONLINE_RESUME_BUTTON_NOT_FOUND' };
  }
  if (options?.click === true) {
    try {
      target.click();
      const clickedRect = target.getBoundingClientRect();
      return {
        ok: true,
        clicked: true,
        by: 'dom-target-click',
        selector: selectorUsed || 'resume-btn-online',
        rect: {
          left: clickedRect.left,
          top: clickedRect.top,
          width: clickedRect.width,
          height: clickedRect.height,
          right: clickedRect.right,
          bottom: clickedRect.bottom,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: `ONLINE_RESUME_DOM_CLICK_FAILED:${error?.message || error}`,
      };
    }
  }
  const rect = target.getBoundingClientRect();
  return {
    ok: true,
    selector: selectorUsed || 'resume-btn-online',
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.right,
      bottom: rect.bottom,
    },
  };
}

function browserCloseResumeModalDomOnce() {
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };

  const selectors = [
    '.boss-popup__close',
    '.boss-dialog__close',
    '.dialog-close',
    '.modal-close',
    '.icon-close',
  ];

  for (const selector of selectors) {
    const target = Array.from(document.querySelectorAll(selector)).find((el) => isVisible(el));
    if (target instanceof HTMLElement) {
      target.click();
      const rect = target.getBoundingClientRect();
      return {
        ok: true,
        selector,
        method: 'dom-click-once',
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        },
      };
    }
  }

  return { ok: false, error: 'RESUME_CLOSE_BUTTON_NOT_FOUND' };
}

function browserGetResumeRateLimitWarning() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const patterns = ['查看太频繁', '操作太频繁', '频繁', '稍后再试'];
  const nodes = Array.from(document.querySelectorAll('div,span,p,section,article')).filter(isVisible);
  for (const node of nodes) {
    const text = normalize(node.textContent || '');
    if (!text || text.length > 120) continue;
    if (patterns.some((pattern) => text.includes(pattern))) {
      return { hit: true, text };
    }
  }
  return { hit: false, text: '' };
}

function browserIsResumeModalOpen() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const closeSelectors = [
    '.boss-popup__close',
    '.boss-dialog__close',
    '.dialog-close',
    '.modal-close',
    '.icon-close',
  ];
  const wrapperSelectors = [
    '.boss-popup__wrapper',
    '.new-chat-resume-dialog-main-ui',
    '.boss-dialog',
    '.dialog-wrap.active',
    '.geek-detail-modal',
    '.modal',
  ];
  const frameSelectors = [
    'iframe[src*="/web/frame/c-resume/"]',
    'iframe[src*="resume"]',
    'iframe[name*="resume"]',
  ];
  const resumePanelSelectors = [
    '.resume-content-wrap',
    '.resume-common-wrap',
    '.resume-detail',
    '.resume-recommend',
    '.iframe-resume-detail',
    'canvas#resume',
  ];
  const wrappers = Array.from(document.querySelectorAll(wrapperSelectors.join(','))).filter(isVisible);
  const resumeIframes = Array.from(document.querySelectorAll(frameSelectors.join(','))).filter(isVisible);

  const scoreScope = (scope) => {
    const rect = scope.getBoundingClientRect();
    const isLarge = rect.width >= 320 && rect.height >= 220;
    const hasClose = closeSelectors.some((selector) =>
      Array.from(scope.querySelectorAll(selector)).some((node) => isVisible(node)),
    );
    const hasResumeIframe = frameSelectors.some((selector) =>
      Array.from(scope.querySelectorAll(selector)).some((node) => isVisible(node)),
    );
    const hasResumePanel = resumePanelSelectors.some((selector) =>
      Array.from(scope.querySelectorAll(selector)).some((node) => isVisible(node)),
    );
    const classText = normalize(scope.className || '').toLowerCase();
    const text = normalize(scope.textContent || '').slice(0, 240).toLowerCase();
    const hasResumeClass = classText.includes('resume');
    const hasResumeText = text.includes('在线简历') || text.includes('附件简历') || text.includes('简历');
    const scopeStyle = getComputedStyle(scope);
    const isLeaving =
      /\bv-leave\b/.test(classText) ||
      /\bleave-active\b/.test(classText) ||
      /\bleaving\b/.test(classText) ||
      scopeStyle.pointerEvents === 'none';
    const hasResumeHint = hasResumeIframe || hasResumePanel || hasResumeClass || hasResumeText;

    let score = 0;
    if (isLarge) score += 120;
    if (hasClose) score += 100;
    if (hasResumeClass) score += 80;
    if (hasResumeText) score += 40;
    if (hasResumePanel) score += 180;
    if (hasResumeIframe) score += 280;
    const zIndex = Number.parseInt(getComputedStyle(scope).zIndex || '0', 10);
    if (Number.isFinite(zIndex)) score += Math.max(0, Math.min(zIndex, 1000)) / 10;
    score += Math.min(120, Math.floor((rect.width * rect.height) / 9000));

    const isResumeScope =
      hasResumeIframe ||
      (hasResumeHint && isLarge);
    const finalScope =
      isResumeScope && !(isLeaving && !hasResumeIframe && !hasClose);

    return {
      scope,
      score,
      hasClose,
      hasResumeIframe,
      hasResumePanel,
      hasResumeClass,
      hasResumeText,
      isLarge,
      isResumeScope: finalScope,
    };
  };

  const scoped = wrappers.map(scoreScope).filter((item) => item.isResumeScope).sort((a, b) => b.score - a.score);
  const closeCount = scoped.reduce((total, item) => {
    let local = 0;
    for (const selector of closeSelectors) {
      local += Array.from(item.scope.querySelectorAll(selector)).filter(isVisible).length;
    }
    return total + local;
  }, 0);
  const top = scoped[0];

  return {
    open: scoped.length > 0 || resumeIframes.length > 0,
    scopeCount: scoped.length,
    iframeCount: resumeIframes.length,
    closeCount,
    topScopeClass: normalize(top?.scope?.className || ''),
    topScopeScore: Number(top?.score || 0),
  };
}

function browserCloseResumeModalBySelector() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const wrapperSelectors = [
    '.boss-popup__wrapper',
    '.new-chat-resume-dialog-main-ui',
    '.boss-dialog',
    '.dialog-wrap.active',
    '.geek-detail-modal',
    '.modal',
  ];
  const frameSelectors = [
    'iframe[src*="/web/frame/c-resume/"]',
    'iframe[src*="resume"]',
    'iframe[name*="resume"]',
  ];
  const resumePanelSelectors = [
    '.resume-content-wrap',
    '.resume-common-wrap',
    '.resume-detail',
    '.resume-recommend',
    '.iframe-resume-detail',
    'canvas#resume',
  ];
  const closeSelectors = [
    '.boss-popup__close',
    '.boss-dialog__close',
    '.dialog-close',
    '.modal-close',
    '.icon-close',
  ];

  const scoreScope = (scope) => {
    const rect = scope.getBoundingClientRect();
    const isLarge = rect.width >= 320 && rect.height >= 220;
    const hasClose = closeSelectors.some((selector) =>
      Array.from(scope.querySelectorAll(selector)).some((node) => isVisible(node)),
    );
    const hasResumeIframe = frameSelectors.some((selector) =>
      Array.from(scope.querySelectorAll(selector)).some((node) => isVisible(node)),
    );
    const hasResumePanel = resumePanelSelectors.some((selector) =>
      Array.from(scope.querySelectorAll(selector)).some((node) => isVisible(node)),
    );
    const classText = normalize(scope.className || '').toLowerCase();
    const text = normalize(scope.textContent || '').slice(0, 240).toLowerCase();
    const hasResumeClass = classText.includes('resume');
    const hasResumeText = text.includes('在线简历') || text.includes('附件简历') || text.includes('简历');
    const scopeStyle = getComputedStyle(scope);
    const isLeaving =
      /\bv-leave\b/.test(classText) ||
      /\bleave-active\b/.test(classText) ||
      /\bleaving\b/.test(classText) ||
      scopeStyle.pointerEvents === 'none';

    let score = 0;
    if (isLarge) score += 120;
    if (hasClose) score += 100;
    if (hasResumeClass) score += 80;
    if (hasResumeText) score += 40;
    if (hasResumePanel) score += 180;
    if (hasResumeIframe) score += 280;
    score += Math.min(120, Math.floor((rect.width * rect.height) / 9000));

    const isResumeScope =
      hasResumeIframe ||
      ((hasResumePanel || hasResumeClass || hasResumeText) && hasClose && isLarge);
    const finalScope =
      isResumeScope && !(isLeaving && !hasResumeIframe && !hasClose);

    return {
      scope,
      score,
      isResumeScope: finalScope,
    };
  };

  const scopes = Array.from(document.querySelectorAll(wrapperSelectors.join(',')))
    .filter(isVisible)
    .map(scoreScope)
    .filter((item) => item.isResumeScope)
    .sort((a, b) => b.score - a.score);

  for (const entry of scopes) {
    for (const selector of closeSelectors) {
      const nodes = Array.from(entry.scope.querySelectorAll(selector));
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        try {
          node.click();
          return {
            ok: true,
            method: 'selector',
            selector,
            scopeClass: normalize(entry.scope.className || ''),
            scopeScore: Number(entry.score || 0),
          };
        } catch {}
      }
    }
  }

  return { ok: false, error: 'RESUME_CLOSE_TARGET_NOT_FOUND', scopeCount: scopes.length };
}

function browserFindResumeCloseRect() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const wrapperSelectors = [
    '.boss-popup__wrapper',
    '.new-chat-resume-dialog-main-ui',
    '.boss-dialog',
    '.dialog-wrap.active',
    '.geek-detail-modal',
    '.modal',
  ];
  const frameSelectors = [
    'iframe[src*="/web/frame/c-resume/"]',
    'iframe[src*="resume"]',
    'iframe[name*="resume"]',
  ];
  const resumePanelSelectors = [
    '.resume-content-wrap',
    '.resume-common-wrap',
    '.resume-detail',
    '.resume-recommend',
    '.iframe-resume-detail',
    'canvas#resume',
  ];
  const selectors = [
    '.boss-popup__close',
    '.boss-dialog__close',
    '.dialog-close',
    '.modal-close',
    '.icon-close',
  ];

  const scoreScope = (scope) => {
    const rect = scope.getBoundingClientRect();
    const isLarge = rect.width >= 320 && rect.height >= 220;
    const hasClose = selectors.some((selector) =>
      Array.from(scope.querySelectorAll(selector)).some((node) => isVisible(node)),
    );
    const hasResumeIframe = frameSelectors.some((selector) =>
      Array.from(scope.querySelectorAll(selector)).some((node) => isVisible(node)),
    );
    const hasResumePanel = resumePanelSelectors.some((selector) =>
      Array.from(scope.querySelectorAll(selector)).some((node) => isVisible(node)),
    );
    const classText = normalize(scope.className || '').toLowerCase();
    const text = normalize(scope.textContent || '').slice(0, 240).toLowerCase();
    const hasResumeClass = classText.includes('resume');
    const hasResumeText = text.includes('在线简历') || text.includes('附件简历') || text.includes('简历');
    const scopeStyle = getComputedStyle(scope);
    const isLeaving =
      /\bv-leave\b/.test(classText) ||
      /\bleave-active\b/.test(classText) ||
      /\bleaving\b/.test(classText) ||
      scopeStyle.pointerEvents === 'none';
    let score = 0;
    if (isLarge) score += 120;
    if (hasClose) score += 100;
    if (hasResumeClass) score += 80;
    if (hasResumeText) score += 40;
    if (hasResumePanel) score += 180;
    if (hasResumeIframe) score += 280;
    score += Math.min(120, Math.floor((rect.width * rect.height) / 9000));
    const isResumeScope =
      hasResumeIframe ||
      ((hasResumePanel || hasResumeClass || hasResumeText) && hasClose && isLarge);
    const finalScope =
      isResumeScope && !(isLeaving && !hasResumeIframe && !hasClose);
    return { scope, score, isResumeScope: finalScope };
  };

  const scopes = Array.from(document.querySelectorAll(wrapperSelectors.join(',')))
    .filter(isVisible)
    .map(scoreScope)
    .filter((item) => item.isResumeScope)
    .sort((a, b) => b.score - a.score);

  for (const entry of scopes) {
    for (const selector of selectors) {
      const nodes = Array.from(entry.scope.querySelectorAll(selector));
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const rect = node.getBoundingClientRect();
        return {
          ok: true,
          selector,
          scopeClass: normalize(entry.scope.className || ''),
          scopeScore: Number(entry.score || 0),
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom,
          },
        };
      }
    }
  }

  return {
    ok: false,
    error: 'RESUME_CLOSE_RECT_NOT_FOUND',
    scopeCount: scopes.length,
  };
}

function browserCloseAnyPopupBySelector() {
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const wrappers = Array.from(
    document.querySelectorAll('.boss-popup__wrapper, .dialog-wrap.active, .boss-dialog, .geek-detail-modal, .modal'),
  ).filter((node) => {
    if (!isVisible(node)) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 220 && rect.height > 160;
  });
  const closeSelectors = ['.boss-popup__close', '.boss-dialog__close', '.dialog-close', '.modal-close', '.icon-close'];

  for (const wrapper of wrappers) {
    for (const selector of closeSelectors) {
      const target = Array.from(wrapper.querySelectorAll(selector)).find((node) => isVisible(node));
      if (target instanceof HTMLElement) {
        target.click();
        return { ok: true, selector, method: 'any-popup-selector' };
      }
    }
  }
  return { ok: false, error: 'ANY_POPUP_CLOSE_NOT_FOUND' };
}

function browserFindAnyPopupCloseRect() {
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const wrappers = Array.from(
    document.querySelectorAll('.boss-popup__wrapper, .dialog-wrap.active, .boss-dialog, .geek-detail-modal, .modal'),
  ).filter((node) => {
    if (!isVisible(node)) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 220 && rect.height > 160;
  });
  const closeSelectors = ['.boss-popup__close', '.boss-dialog__close', '.dialog-close', '.modal-close', '.icon-close'];

  for (const wrapper of wrappers) {
    for (const selector of closeSelectors) {
      const target = Array.from(wrapper.querySelectorAll(selector)).find((node) => isVisible(node));
      if (target instanceof HTMLElement) {
        const rect = target.getBoundingClientRect();
        return {
          ok: true,
          selector,
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom,
          },
        };
      }
    }
  }
  return { ok: false, error: 'ANY_POPUP_CLOSE_RECT_NOT_FOUND' };
}

function browserAnyPopupVisible() {
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 220 && rect.height > 160;
  };
  const wrappers = Array.from(
    document.querySelectorAll('.boss-popup__wrapper, .dialog-wrap.active, .boss-dialog, .geek-detail-modal, .modal'),
  ).filter(isVisible);
  return { visible: wrappers.length > 0, count: wrappers.length };
}

function browserSetEditorMessage(message) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const text = String(message || '').trim();
  if (!text) {
    return { ok: false, error: 'CHAT_MESSAGE_EMPTY' };
  }

  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };

  const editor = document.querySelector(
    '#boss-chat-editor-input, .conversation-editor #boss-chat-editor-input, .conversation-editor .boss-chat-editor-input',
  );
  if (!(editor instanceof HTMLElement) || !isVisible(editor)) {
    return { ok: false, error: 'CHAT_EDITOR_NOT_FOUND' };
  }

  editor.click();
  editor.focus();

  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  editor.textContent = '';
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, text);
  } catch {}

  if (!inserted) {
    editor.textContent = text;
  }

  try {
    editor.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: 'insertText',
      }),
    );
  } catch {
    editor.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  }
  editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));

  const activeSubmit = Array.from(
    document.querySelectorAll(
      '.conversation-editor .submit.active, .conversation-editor .submit-content .submit.active, .submit.active',
    ),
  ).some((node) => isVisible(node));

  return {
    ok: true,
    value: normalize(editor.textContent || ''),
    activeSubmit,
  };
}

async function browserSendMessage(args = {}) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const expectedText = normalize(args?.expectedText || '');
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };

  const findEditor = () =>
    document.querySelector(
      '#boss-chat-editor-input, .conversation-editor #boss-chat-editor-input, .conversation-editor .boss-chat-editor-input',
    );
  const getEditorText = () => normalize(findEditor()?.textContent || '');
  const snapshot = () => {
    const activeSubmit = Array.from(
      document.querySelectorAll(
        '.conversation-editor .submit.active, .conversation-editor .submit-content .submit.active, .submit.active',
      ),
    ).find((node) => isVisible(node));
    const anySubmit = Array.from(
      document.querySelectorAll(
        '.conversation-editor .submit-content .submit, .conversation-editor .submit, .submit-content .submit, .submit',
      ),
    ).find((node) => isVisible(node) && normalize(node.textContent || '').includes('发送'));
    const editorText = getEditorText();
    return {
      editorText,
      hasExpected: expectedText ? editorText.includes(expectedText) : editorText.length > 0,
      activeSubmit: Boolean(activeSubmit),
      hasAnySubmit: Boolean(anySubmit),
    };
  };

  const pressEnter = (target) => {
    if (!(target instanceof HTMLElement)) return;
    const init = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  };

  const editor = findEditor();
  if (!(editor instanceof HTMLElement) || !isVisible(editor)) {
    return { ok: false, error: 'CHAT_EDITOR_NOT_FOUND' };
  }
  editor.click();
  editor.focus();

  const before = snapshot();
  if (!before.hasExpected) {
    return {
      ok: false,
      error: 'CHAT_EDITOR_TEXT_MISSING',
      editorBefore: before.editorText,
    };
  }

  const methods = [];
  const clickActive = () => {
    const activeSubmit = Array.from(
      document.querySelectorAll(
        '.conversation-editor .submit.active, .conversation-editor .submit-content .submit.active, .submit.active',
      ),
    ).find((node) => isVisible(node) && normalize(node.textContent || '').includes('发送'));
    if (activeSubmit instanceof HTMLElement) {
      activeSubmit.click();
      methods.push('click-submit-active');
      return true;
    }
    return false;
  };
  const clickAny = () => {
    const anySubmit = Array.from(
      document.querySelectorAll(
        '.conversation-editor .submit-content .submit, .conversation-editor .submit, .submit-content .submit, .submit',
      ),
    ).find((node) => isVisible(node) && normalize(node.textContent || '').includes('发送'));
    if (anySubmit instanceof HTMLElement) {
      anySubmit.click();
      methods.push('click-submit');
      return true;
    }
    return false;
  };

  clickActive() || clickAny();
  await new Promise((resolve) => window.setTimeout(resolve, 320));
  let after = snapshot();
  if (!after.editorText) {
    return {
      ok: true,
      sent: true,
      method: methods.join('+') || 'click-submit',
      cleared: true,
      editorAfter: '',
    };
  }

  pressEnter(editor);
  methods.push('editor-enter');
  await new Promise((resolve) => window.setTimeout(resolve, 320));
  after = snapshot();
  if (!after.editorText) {
    return {
      ok: true,
      sent: true,
      method: methods.join('+'),
      cleared: true,
      editorAfter: '',
    };
  }

  pressEnter(document.activeElement || editor);
  methods.push('active-enter');
  await new Promise((resolve) => window.setTimeout(resolve, 320));
  after = snapshot();

  return {
    ok: true,
    sent: !after.editorText,
    method: methods.join('+') || 'none',
    cleared: !after.editorText,
    editorAfter: after.editorText,
    activeSubmitAfter: after.activeSubmit,
  };
}

function browserClickAskResume() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const getActionLabel = (el) =>
    normalize([
      el?.textContent || '',
      el?.getAttribute?.('aria-label') || '',
      el?.getAttribute?.('title') || '',
      el?.getAttribute?.('data-title') || '',
    ].join(' '));
  const isAskResumeText = (text) => {
    const normalized = normalize(text);
    if (!normalized) return false;
    return (
      normalized === '求简历' ||
      normalized === '索要简历' ||
      normalized === '求附件简历' ||
      normalized.includes('求简历') ||
      normalized.includes('索要简历') ||
      normalized.includes('附件简历')
    );
  };
  const isRequestedText = (text) => {
    const normalized = normalize(text);
    return (
      normalized === '已求简历' ||
      normalized === '已申请' ||
      normalized === '已发送' ||
      normalized.includes('已求简历') ||
      normalized.includes('已申请') ||
      normalized.includes('已发送')
    );
  };
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const isDisabled = (el) => {
    const classText = String(el.className || '').toLowerCase();
    const ariaDisabled = String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
    const disabledAttr = el.hasAttribute('disabled');
    return classText.includes('disabled') || ariaDisabled || disabledAttr;
  };
  const toClickable = (node) => {
    let current = node;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (!(current instanceof HTMLElement)) break;
      const tag = String(current.tagName || '').toUpperCase();
      const classText = String(current.className || '').toLowerCase();
      const role = String(current.getAttribute('role') || '').toLowerCase();
      if (tag === 'BUTTON' || tag === 'A' || role === 'button' || classText.includes('btn')) {
        return current;
      }
      current = current.parentElement;
    }
    return node;
  };
  const alreadyRequested = Array.from(document.querySelectorAll('span.operate-btn')).find(
    (el) =>
      isVisible(el) &&
      (isRequestedText(getActionLabel(el)) || (isAskResumeText(getActionLabel(el)) && isDisabled(el))) &&
      isDisabled(el),
  );
  if (alreadyRequested) {
    return {
      ok: true,
      alreadyRequested: true,
      text: normalize(alreadyRequested.textContent || ''),
      className: String(alreadyRequested.className || ''),
    };
  }
  const exactOperate = Array.from(document.querySelectorAll('span.operate-btn')).find(
    (el) =>
      isVisible(el) &&
      isAskResumeText(getActionLabel(el)) &&
      !isRequestedText(getActionLabel(el)) &&
      !isDisabled(el),
  );
  const fallbackOperate = Array.from(
    document.querySelectorAll('span.operate-btn, .operate-btn, [class*="operate"], [class*="resume"], button, a, span'),
  ).find(
    (el) =>
      isVisible(el) &&
      isAskResumeText(getActionLabel(el)) &&
      !isRequestedText(getActionLabel(el)) &&
      !isDisabled(el),
  );
  const target = exactOperate || fallbackOperate || null;
  if (!target) {
    return { ok: false, error: 'ASK_RESUME_BUTTON_NOT_FOUND' };
  }
  const clickable = toClickable(target);
  clickable.click();
  return {
    ok: true,
    alreadyRequested: false,
    text: normalize(target.textContent || ''),
    className: String(target.className || ''),
    clickedTag: String(clickable?.tagName || ''),
    clickedClassName: String(clickable?.className || ''),
  };
}

function browserClickConfirmRequestResume() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const isConfirmText = (text) => {
    const normalized = normalize(text);
    return (
      normalized === '确定' ||
      normalized === '确认' ||
      normalized === '提交' ||
      normalized === '发送' ||
      normalized === '继续'
    );
  };
  const toClickable = (node) => {
    let current = node;
    for (let depth = 0; current && depth < 5; depth += 1) {
      if (!(current instanceof HTMLElement)) break;
      const tag = String(current.tagName || '').toUpperCase();
      const classText = String(current.className || '').toLowerCase();
      const role = String(current.getAttribute('role') || '').toLowerCase();
      if (tag === 'BUTTON' || tag === 'A' || role === 'button' || classText.includes('btn')) {
        return current;
      }
      current = current.parentElement;
    }
    return node;
  };
  const wrapperSelectors = '.boss-popup__wrapper, .boss-dialog, .dialog-wrap.active, .modal';
  const wrappers = Array.from(document.querySelectorAll(wrapperSelectors))
    .filter((el) => isVisible(el))
    .sort((left, right) => {
      const leftStyle = getComputedStyle(left);
      const rightStyle = getComputedStyle(right);
      const leftZ = Number.parseInt(leftStyle.zIndex || '0', 10);
      const rightZ = Number.parseInt(rightStyle.zIndex || '0', 10);
      if (leftZ !== rightZ) return rightZ - leftZ;
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
    });
  const findConfirmInScope = (scope) =>
    Array.from(
      scope.querySelectorAll(
        'span.boss-btn-primary.boss-btn, .boss-btn-primary.boss-btn, .boss-popup__wrapper .boss-btn-primary, .boss-dialog .boss-btn-primary, .boss-btn-primary, button, a, span',
      ),
    ).find((el) => isVisible(el) && isConfirmText(el.textContent || ''));
  let target = null;
  for (const wrapper of wrappers) {
    target = findConfirmInScope(wrapper);
    if (target) break;
  }
  if (!target) {
    target = Array.from(document.querySelectorAll('.boss-btn-primary, button, a, span')).find(
      (el) => isVisible(el) && isConfirmText(el.textContent || ''),
    );
  }
  if (!target) {
    return { ok: false, error: 'CONFIRM_BUTTON_NOT_FOUND' };
  }
  const clickable = toClickable(target);
  clickable.click();
  return {
    ok: true,
    text: normalize(target.textContent || ''),
    className: String(target.className || ''),
    clickedTag: String(clickable?.tagName || ''),
    clickedClassName: String(clickable?.className || ''),
  };
}

function browserGetRequestResumeUiState() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const getActionLabel = (el) =>
    normalize([
      el?.textContent || '',
      el?.getAttribute?.('aria-label') || '',
      el?.getAttribute?.('title') || '',
      el?.getAttribute?.('data-title') || '',
    ].join(' '));
  const isAskResumeText = (text) => {
    const normalized = normalize(text);
    if (!normalized) return false;
    return (
      normalized === '求简历' ||
      normalized === '索要简历' ||
      normalized === '求附件简历' ||
      normalized.includes('求简历') ||
      normalized.includes('索要简历') ||
      normalized.includes('附件简历')
    );
  };
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const isDisabled = (el) => {
    const classText = String(el.className || '').toLowerCase();
    const ariaDisabled = String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
    const disabledAttr = el.hasAttribute('disabled');
    return classText.includes('disabled') || ariaDisabled || disabledAttr;
  };
  const isRequestedText = (text) => {
    const normalized = normalize(text);
    return (
      normalized === '已求简历' ||
      normalized === '已申请' ||
      normalized === '已发送' ||
      normalized.includes('已求简历') ||
      normalized.includes('已申请') ||
      normalized.includes('已发送')
    );
  };
  const isConfirmText = (text) => {
    const normalized = normalize(text);
    return (
      normalized === '确定' ||
      normalized === '确认' ||
      normalized === '提交' ||
      normalized === '发送' ||
      normalized === '继续'
    );
  };

  const askNodePreferred = Array.from(
    document.querySelectorAll('span.operate-btn, .operate-btn, [class*="operate"], button, a, span'),
  ).find((el) => isVisible(el) && isAskResumeText(getActionLabel(el)));
  const askNodeFallback = Array.from(document.querySelectorAll('button, a, span')).find(
    (el) => isVisible(el) && isAskResumeText(getActionLabel(el)),
  );
  const askNode = askNodePreferred || askNodeFallback || null;
  const askDisabled = Boolean(askNode && isDisabled(askNode));
  const requestedOperateNode = Array.from(document.querySelectorAll('span.operate-btn')).find(
    (el) =>
      isVisible(el) &&
      (isRequestedText(getActionLabel(el)) || isAskResumeText(getActionLabel(el))) &&
      isDisabled(el),
  );
  const hasDisabledOperateAsk = Boolean(requestedOperateNode);
  const explicitRequestedNode = Array.from(
    document.querySelectorAll(
      '.operate-btn, [class*="operate"], [class*="resume"], span, button, a, div',
    ),
  ).find((el) => {
    const text = normalize(el.textContent || '');
    if (!isVisible(el)) return false;
    if (!text) return false;
    if (!isRequestedText(text)) return false;
    const classText = String(el.className || '').toLowerCase();
    return classText.includes('operate') || classText.includes('resume') || classText.includes('btn');
  });
  const wrapperSelectors = '.boss-popup__wrapper, .boss-dialog, .dialog-wrap.active, .modal';
  const wrappers = Array.from(document.querySelectorAll(wrapperSelectors)).filter((el) => isVisible(el));
  let confirmNode = null;
  for (const wrapper of wrappers) {
    confirmNode = Array.from(
      wrapper.querySelectorAll(
        'span.boss-btn-primary.boss-btn, .boss-btn-primary.boss-btn, .boss-popup__wrapper .boss-btn-primary, .boss-dialog .boss-btn-primary, .boss-btn-primary, button, a, span',
      ),
    ).find((el) => isVisible(el) && isConfirmText(el.textContent || ''));
    if (confirmNode) break;
  }
  if (!confirmNode) {
    confirmNode = Array.from(document.querySelectorAll('.boss-btn-primary, button, a, span')).find(
      (el) => isVisible(el) && isConfirmText(el.textContent || ''),
    );
  }

  return {
    hasAskResume: Boolean(askNode),
    askDisabled,
    hasDisabledOperateAsk,
    hasRequestedMark: hasDisabledOperateAsk || Boolean(explicitRequestedNode) || askDisabled,
    hasConfirm: Boolean(confirmNode),
  };
}

function browserGetResumeRequestMessageState() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };

  const container = document.querySelector('.chat-message-list');
  if (!(container instanceof HTMLElement)) {
    return {
      ok: false,
      error: 'CHAT_MESSAGE_LIST_NOT_FOUND',
      count: 0,
      lastText: '',
      recent: [],
    };
  }

  const candidates = Array.from(
    container.querySelectorAll('.item-system .text span, .item-system .text, .item-system span'),
  ).filter((node) => isVisible(node));
  const matched = [];
  for (const node of candidates) {
    const text = normalize(node.textContent || '');
    if (!text) continue;
    if (text.includes('简历请求已发送')) {
      matched.push(text);
    }
  }

  return {
    ok: true,
    count: matched.length,
    lastText: matched.length > 0 ? matched[matched.length - 1] : '',
    recent: matched.slice(-3),
  };
}

function browserExtractResumeProfileFromModal() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') < 0.01) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  };
  const isNoiseText = (text) => {
    const normalized = normalize(text);
    return (
      normalized.includes('其他名企大厂经历牛人') ||
      normalized.includes('相似牛人') ||
      normalized.includes('推荐牛人') ||
      normalized.includes('匿名牛人')
    );
  };
  const stripNoiseText = (text) => {
    let cleaned = normalize(text);
    const noisePhrases = ['其他名企大厂经历牛人', '相似牛人', '推荐牛人', '匿名牛人'];
    for (const phrase of noisePhrases) {
      cleaned = cleaned.split(phrase).join(' ');
    }
    return normalize(cleaned);
  };
  const pickSectionText = (section) => {
    if (!section) return '';
    return stripNoiseText(section.innerText || section.textContent || '');
  };
  const pickFirstText = (scope, selectors) => {
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(scope.querySelectorAll(selector)).slice(0, 12);
      } catch {
        nodes = [];
      }
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = normalize(node.textContent || '');
        if (!text || isNoiseText(text)) continue;
        return text;
      }
    }
    return '';
  };
  const pickList = (scope, selectors, maxItems = 5) => {
    const items = [];
    const seen = new Set();
    for (const selector of selectors) {
      let nodes = [];
      try {
        nodes = Array.from(scope.querySelectorAll(selector)).slice(0, 20);
      } catch {
        nodes = [];
      }
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = normalize(node.textContent || '');
        if (!text || isNoiseText(text)) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(text);
        if (items.length >= maxItems) return items;
      }
    }
    return items;
  };

  const wrappers = Array.from(
    document.querySelectorAll('.dialog-wrap.active, .boss-popup__wrapper, .boss-dialog, .geek-detail-modal, .modal'),
  ).filter((el) => isVisible(el));
  const scope = wrappers[0] || document;
  const root =
    scope.querySelector('.resume-center-side .resume-detail-wrap') ||
    scope.querySelector('.resume-detail-wrap') ||
    scope.querySelector('.resume-center-side') ||
    scope.querySelector('.resume-detail') ||
    document.querySelector('.resume-center-side .resume-detail-wrap') ||
    document.querySelector('.resume-detail-wrap') ||
    null;

  if (!root) {
    return {
      ok: false,
      error: 'RESUME_PROFILE_ROOT_NOT_FOUND',
      name: '',
      primarySchool: '',
      major: '',
      company: '',
      position: '',
      schools: [],
      majors: [],
      resumeText: '',
      evidenceCorpus: '',
    };
  }

  const educationSection =
    root.querySelector('.resume-section.geek-education-experience-wrap') ||
    root.querySelector('.geek-education-experience-wrap') ||
    root.querySelector('.resume-section[class*="education"]') ||
    root;
  const workSection =
    root.querySelector('.resume-section.geek-work-experience-wrap') ||
    root.querySelector('.geek-work-experience-wrap') ||
    root.querySelector('.resume-section[class*="work"]') ||
    root;
  const projectSection =
    root.querySelector('.resume-section.geek-project-experience-wrap') ||
    root.querySelector('.geek-project-experience-wrap') ||
    root.querySelector('.resume-section[class*="project"]') ||
    null;
  const skillSection =
    root.querySelector('.resume-section.geek-skill-wrap') ||
    root.querySelector('.geek-skill-wrap') ||
    root.querySelector('.resume-section[class*="skill"]') ||
    null;
  const baseSection =
    root.querySelector('.resume-section.geek-base-info-wrap') ||
    root.querySelector('.geek-base-info-wrap') ||
    root;

  const schools = pickList(educationSection, [
    '.school-name',
    '.school-info .name-wrap .school-name',
    '.edu-wrap .school-name',
  ]);
  const majors = pickList(educationSection, [
    '.major',
    '.school-name-wrap .major',
    '.edu-wrap .major',
  ]);

  const name = pickFirstText(baseSection, [
    '.name-wrap .name',
    '.geek-name .name',
    '.name',
  ]);
  const primarySchool = schools[0] || '';
  const major = majors[0] || '';
  const company = pickFirstText(workSection, [
    '.company-name-wrap .name',
    '.company-name',
    '.helper-company-query-wrap .name',
  ]);
  const position = pickFirstText(workSection, [
    '.position span',
    '.position',
  ]);
  const baseText = pickSectionText(baseSection);
  const educationText = pickSectionText(educationSection);
  const workText = pickSectionText(workSection);
  const projectText = pickSectionText(projectSection);
  const skillText = pickSectionText(skillSection);
  const evidenceCorpus = stripNoiseText(root.innerText || root.textContent || '');
  const resumeText = [
    baseText ? `基础信息: ${baseText}` : '',
    educationText ? `教育经历: ${educationText}` : '',
    workText ? `工作经历: ${workText}` : '',
    projectText ? `项目经历: ${projectText}` : '',
    skillText ? `技能信息: ${skillText}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    ok: true,
    name,
    primarySchool,
    major,
    company,
    position,
    schools,
    majors,
    resumeText: resumeText || evidenceCorpus || '',
    evidenceCorpus: evidenceCorpus || resumeText || '',
    debug: {
      rootClass: String(root.className || ''),
      educationClass: String(educationSection?.className || ''),
      workClass: String(workSection?.className || ''),
      wrapperClass: String(scope?.className || ''),
      resumeTextLength: Number((resumeText || '').length),
      evidenceCorpusLength: Number((evidenceCorpus || '').length),
    },
  };
}

function browserGetActiveCandidateSnapshot() {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const active =
    document.querySelector('.geek-item.selected[data-id]') ||
    document.querySelector('.geek-item.selected');
  if (!(active instanceof HTMLElement)) {
    return {
      hasActive: false,
      customerId: '',
      name: '',
      domIndex: -1,
    };
  }
  const listItem = active.closest('div[role="listitem"]');
  const all = Array.from(document.querySelectorAll('div[role="listitem"]'));
  const name = normalize(listItem?.querySelector('.geek-name,[class*="name"]')?.textContent || '');
  const customerId = normalize(
    active.getAttribute('data-id') ||
      listItem?.getAttribute('key') ||
      listItem?.getAttribute('data-key') ||
      active.id ||
      '',
  );
  return {
    hasActive: true,
    customerId,
    name,
    domIndex: listItem ? all.indexOf(listItem) : -1,
  };
}

export class BossChatPage {
  constructor(chromeClient) {
    this.chromeClient = chromeClient;
  }

  static targetMatcher(target) {
    return target?.type === 'page' && String(target.url || '').includes(CHAT_URL_TOKEN);
  }

  async getPageState() {
    return this.chromeClient.callFunction(browserGetPageState);
  }

  async ensureOnChatPage() {
    const pageState = await this.getPageState();
    if (!pageState?.href?.includes(CHAT_URL_TOKEN)) {
      throw new Error('ACTIVE_TAB_IS_NOT_BOSS_CHAT_PAGE');
    }
    return pageState;
  }

  async ensureReady() {
    const pageState = await this.ensureOnChatPage();
    if (!pageState.hasListContainer && Number(pageState.listItemCount || 0) <= 0) {
      throw new Error('CHAT_LIST_CONTAINER_NOT_FOUND');
    }
    return pageState;
  }

  async recoverToChatIndex(options = {}) {
    const maxAttempts = options.maxAttempts || 20;
    const delayMs = options.delayMs || 500;
    const forceNavigate = options.forceNavigate === true;
    const waitForReadyState = options.waitForReadyState || 'complete';
    const hrefResult = await this.chromeClient.callFunction(browserGetCurrentHref);
    if (!forceNavigate && String(hrefResult?.href || '').includes(CHAT_URL_TOKEN)) {
      return { changed: false, href: hrefResult?.href || '' };
    }

    await this.chromeClient.callFunction(browserNavigateToChatIndex, { force: forceNavigate });
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const state = await this.getPageState();
      const onChatPage = String(state?.href || '').includes(CHAT_URL_TOKEN);
      const ready = !waitForReadyState || String(state?.readyState || '').toLowerCase() === String(waitForReadyState).toLowerCase();
      if (onChatPage && ready) {
        return { changed: true, href: state.href };
      }
    }

    throw new Error('RECOVER_TO_CHAT_INDEX_TIMEOUT');
  }

  async listJobs() {
    const result = await this.chromeClient.callFunction(browserListJobs);
    if (!result?.ok) {
      throw new Error(result?.error || 'LIST_JOBS_FAILED');
    }
    return result.jobs || [];
  }

  async selectJob(jobSelection) {
    const result = await this.chromeClient.callFunction(browserSelectJob, jobSelection);
    if (!result?.ok) {
      throw new Error(result?.error || 'SELECT_JOB_FAILED');
    }
    if (!result.matched) {
      throw new Error('JOB_SELECTION_NOT_APPLIED');
    }
    return result.selected;
  }

  async activateUnreadFilter() {
    const result = await this.chromeClient.callFunction(browserActivateFilterTab, '未读');
    if (!result?.ok) {
      throw new Error(result?.error || 'ACTIVATE_UNREAD_FILTER_FAILED');
    }
    return result;
  }

  async activateAllFilter() {
    const result = await this.chromeClient.callFunction(browserActivateFilterTab, '全部');
    if (!result?.ok) {
      throw new Error(result?.error || 'ACTIVATE_ALL_FILTER_FAILED');
    }
    return result;
  }

  async getLoadedCustomers() {
    let lastError = 'GET_LOADED_CUSTOMERS_FAILED';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await this.chromeClient.callFunction(browserGetLoadedCustomers);
      if (result?.ok) {
        return result.customers.map((customer) => ({
          ...customer,
          customerKey: createCustomerKey(customer),
        }));
      }
      lastError = result?.error || lastError;
      await new Promise((resolve) => setTimeout(resolve, 180 + attempt * 70));
    }
    throw new Error(lastError);
  }

  async centerCustomerCard(domIndex, drift = 0) {
    const result = await this.chromeClient.callFunction(browserCenterCandidateInList, {
      domIndex,
      drift,
    });
    if (!result?.ok) {
      throw new Error(result?.error || `CENTER_CUSTOMER_CARD_FAILED:${domIndex}`);
    }
    return result.rect;
  }

  async activateCandidate(customer, drift = 0) {
    const result = await this.chromeClient.callFunction(browserActivateCandidate, {
      domIndex: customer?.domIndex,
      customerId: customer?.customerId || '',
      name: customer?.name || '',
      drift,
    });
    if (!result?.ok) {
      throw new Error(result?.error || 'ACTIVATE_CANDIDATE_FAILED');
    }
    return result;
  }

  async scrollCustomerList(ratio = 0.72) {
    const result = await this.chromeClient.callFunction(browserScrollCustomerList, { ratio });
    if (!result?.ok) {
      throw new Error(result?.error || 'SCROLL_CUSTOMER_LIST_FAILED');
    }
    return result;
  }

  async waitForConversationReady(options = {}) {
    const maxAttempts = options.maxAttempts || 12;
    const delayMs = options.delayMs || 260;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const state = await this.chromeClient.callFunction(browserConversationReadyState);
      if (state?.hasOnlineResume || state?.hasAskResume || state?.hasAttachmentResume) {
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error('CONVERSATION_PANEL_NOT_READY');
  }

  async waitForCandidateActivated(customer, options = {}) {
    const maxAttempts = options.maxAttempts || 12;
    const delayMs = options.delayMs || 220;
    const expectedId = String(customer?.customerId || '').trim();
    const expectedName = String(customer?.name || '').trim();
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const state = await this.chromeClient.callFunction(browserGetActiveCandidateSnapshot);
      if (state?.hasActive) {
        const activeId = String(state.customerId || '').trim();
        const activeName = String(state.name || '').trim();
        const idMatched =
          expectedId &&
          (activeId === expectedId || activeId.endsWith(expectedId) || expectedId.endsWith(activeId));
        const nameMatched = expectedName && activeName && activeName === expectedName;
        if (idMatched || nameMatched) {
          return { ...state, matched: true };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const finalState = await this.chromeClient.callFunction(browserGetActiveCandidateSnapshot);
    return {
      ...(finalState || {}),
      matched: false,
      expectedId,
      expectedName,
    };
  }

  async primeConversationByFirstCandidate(options = {}) {
    const clickResult = await this.chromeClient.callFunction(browserPrimeConversationByFirstCandidate);
    if (!clickResult?.ok) {
      throw new Error(clickResult?.error || 'PRIME_CONVERSATION_FAILED');
    }
    await new Promise((resolve) => setTimeout(resolve, options.delayMs || 700));
    const readyState = await this.waitForConversationReady({
      maxAttempts: options.maxAttempts || 12,
      delayMs: options.pollMs || 240,
    });
    return {
      ...clickResult,
      readyState,
    };
  }

  async openOnlineResume() {
    const isModalLikelyOpen = (state) =>
      Boolean(state?.open) ||
      Number(state?.iframeCount || 0) > 0 ||
      (Number(state?.scopeCount || 0) > 0 && Number(state?.closeCount || 0) > 0);

    const preState = await this.getResumeModalState();
    if (isModalLikelyOpen(preState)) {
      return {
        clicked: false,
        detectedOpen: true,
        by: 'already-open',
      };
    }

    const result = await this.chromeClient.callFunction(browserOpenOnlineResume, { click: true });
    if (!result?.ok) {
      throw new Error(
        `OPEN_ONLINE_RESUME_FAILED(selector=n/a,error=${result?.error || 'n/a'})`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 360));
    const state = await this.getResumeModalState();
    if (isModalLikelyOpen(state)) {
      return { ...result, clicked: true, detectedOpen: true, by: 'dom-target-click-once' };
    }

    return {
      ...result,
      clicked: true,
      detectedOpen: false,
      by: 'dom-target-click-once-no-modal',
    };
  }

  async closeResumeModalDomOnce() {
    const stateBefore = await this.getResumeModalState();
    const openBefore =
      Boolean(stateBefore?.open) ||
      Number(stateBefore?.iframeCount || 0) > 0 ||
      Number(stateBefore?.scopeCount || 0) > 0;
    if (!openBefore) {
      return {
        closed: true,
        method: 'already-closed',
        finalState: stateBefore,
      };
    }

    const result = await this.chromeClient.callFunction(browserCloseResumeModalDomOnce);
    if (!result?.ok) {
      const finalState = await this.getResumeModalState();
      return {
        closed: false,
        method: `dom-close-miss:${result?.error || 'unknown'}`,
        finalState,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 420));
    let finalState = await this.getResumeModalState();
    let openAfter =
      Boolean(finalState?.open) ||
      Number(finalState?.iframeCount || 0) > 0 ||
      Number(finalState?.scopeCount || 0) > 0;
    const classText = String(finalState?.topScopeClass || '');
    if (openAfter && /\bv-leave\b|\bleave-active\b|\bleaving\b/i.test(classText)) {
      await new Promise((resolve) => setTimeout(resolve, 760));
      finalState = await this.getResumeModalState();
      openAfter =
        Boolean(finalState?.open) ||
        Number(finalState?.iframeCount || 0) > 0 ||
        Number(finalState?.scopeCount || 0) > 0;
    }
    return {
      closed: !openAfter,
      method: `dom-close-once:${result.selector || 'unknown'}`,
      finalState,
    };
  }

  async isResumeModalOpen() {
    const result = await this.chromeClient.callFunction(browserIsResumeModalOpen);
    return Boolean(result?.open);
  }

  async getResumeRateLimitWarning() {
    const result = await this.chromeClient.callFunction(browserGetResumeRateLimitWarning);
    return {
      hit: Boolean(result?.hit),
      text: String(result?.text || ''),
    };
  }

  async getResumeModalState() {
    const result = await this.chromeClient.callFunction(browserIsResumeModalOpen);
    return {
      open: Boolean(result?.open),
      scopeCount: Number(result?.scopeCount || 0),
      iframeCount: Number(result?.iframeCount || 0),
      closeCount: Number(result?.closeCount || 0),
      topScopeClass: String(result?.topScopeClass || ''),
      topScopeScore: Number(result?.topScopeScore || 0),
    };
  }

  async waitForResumeModalOpen(options = {}) {
    const maxAttempts = options.maxAttempts || 30;
    const delayMs = options.delayMs || 300;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const state = await this.getResumeModalState();
      const appearsOpen =
        Boolean(state.open) ||
        Number(state.iframeCount || 0) > 0 ||
        (Number(state.scopeCount || 0) > 0 && Number(state.closeCount || 0) > 0);
      if (appearsOpen && attempt >= 1) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const finalState = await this.getResumeModalState();
    throw new Error(
      `RESUME_MODAL_OPEN_TIMEOUT(scope=${finalState.scopeCount},iframe=${finalState.iframeCount},close=${finalState.closeCount},class=${finalState.topScopeClass || 'n/a'})`,
    );
  }

  async closeResumeModal({ maxAttempts = 12, ensureDismiss = false } = {}) {
    const overlayOpen = (state) =>
      Boolean(state?.open) ||
      Number(state?.iframeCount || 0) > 0 ||
      Number(state?.scopeCount || 0) > 0 ||
      Number(state?.closeCount || 0) > 0;
    const methods = [];
    for (let index = 0; index < maxAttempts; index += 1) {
      const state = await this.getResumeModalState();
      if (!overlayOpen(state) && !ensureDismiss) {
        return {
          closed: true,
          method: methods.join('+') || 'already-closed',
          finalState: state,
        };
      }

      const selectorResult = await this.chromeClient.callFunction(browserCloseResumeModalBySelector);
      if (selectorResult?.ok) {
        methods.push(
          `${selectorResult?.method || 'selector'}:${selectorResult?.selector || 'unknown'}`,
        );
      } else {
        methods.push(`selector-miss:${selectorResult?.error || 'unknown'}`);
        const anySelector = await this.chromeClient.callFunction(browserCloseAnyPopupBySelector);
        if (anySelector?.ok) {
          methods.push(`any-selector:${anySelector.selector || 'unknown'}`);
        } else {
          methods.push(`any-selector-miss:${anySelector?.error || 'unknown'}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 260));

      let midState = await this.getResumeModalState();
      if (!overlayOpen(midState)) {
        return {
          closed: true,
          method: methods.join('+'),
          finalState: midState,
        };
      }

      await this.chromeClient.pressEscape();
      methods.push('escape');
      await new Promise((resolve) => setTimeout(resolve, 260));

      midState = await this.getResumeModalState();
      if (!overlayOpen(midState)) {
        return {
          closed: true,
          method: methods.join('+'),
          finalState: midState,
        };
      }

      if (index % 2 === 0) {
        const closeRect = await this.chromeClient.callFunction(browserFindResumeCloseRect);
        if (closeRect?.ok && closeRect.rect) {
          await this.clickRect(closeRect.rect);
          methods.push(`rect:${closeRect.selector || 'unknown'}`);
          await new Promise((resolve) => setTimeout(resolve, 260));
        } else {
          methods.push(`rect-miss:${closeRect?.error || 'unknown'}`);
          const anyRect = await this.chromeClient.callFunction(browserFindAnyPopupCloseRect);
          if (anyRect?.ok && anyRect.rect) {
            await this.clickRect(anyRect.rect);
            methods.push(`any-rect:${anyRect.selector || 'unknown'}`);
            await new Promise((resolve) => setTimeout(resolve, 260));
          } else {
            methods.push(`any-rect-miss:${anyRect?.error || 'unknown'}`);
          }
        }
      }

      if (ensureDismiss && index >= 1) {
        const finalSweep = await this.getResumeModalState();
        if (!overlayOpen(finalSweep)) {
          return {
            closed: true,
            method: methods.join('+'),
            finalState: finalSweep,
          };
        }
      }
    }

    const finalState = await this.getResumeModalState();
    if (!overlayOpen(finalState)) {
      return {
        closed: true,
        method: methods.join('+') || 'fallback',
        finalState,
      };
    }
    return {
      closed: false,
      method: methods.join('+') || 'failed',
      finalState,
    };
  }

  async closeAllPopupsHard({ maxAttempts = 10 } = {}) {
    const methods = [];
    for (let index = 0; index < maxAttempts; index += 1) {
      const visible = await this.chromeClient.callFunction(browserAnyPopupVisible);
      if (!visible?.visible) {
        return {
          closed: true,
          method: methods.join('+') || 'already-closed',
          finalVisibleCount: Number(visible?.count || 0),
        };
      }

      const bySelector = await this.chromeClient.callFunction(browserCloseAnyPopupBySelector);
      if (bySelector?.ok) {
        methods.push(`any-selector:${bySelector.selector || 'unknown'}`);
      } else {
        methods.push(`any-selector-miss:${bySelector?.error || 'unknown'}`);
      }

      await this.chromeClient.pressEscape();
      methods.push('escape');
      await new Promise((resolve) => setTimeout(resolve, 220));

      const byRect = await this.chromeClient.callFunction(browserFindAnyPopupCloseRect);
      if (byRect?.ok && byRect.rect) {
        await this.clickRect(byRect.rect);
        methods.push(`any-rect:${byRect.selector || 'unknown'}`);
      } else {
        methods.push(`any-rect-miss:${byRect?.error || 'unknown'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 220));
    }

    const finalVisible = await this.chromeClient.callFunction(browserAnyPopupVisible);
    return {
      closed: !Boolean(finalVisible?.visible),
      method: methods.join('+') || 'failed',
      finalVisibleCount: Number(finalVisible?.count || 0),
    };
  }

  async clickRect(rect) {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const targetX = Math.round(centerX + (Math.random() - 0.5) * Math.min(6, rect.width * 0.2));
    const targetY = Math.round(centerY + (Math.random() - 0.5) * Math.min(6, rect.height * 0.2));
    await this.chromeClient.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x: targetX,
      y: targetY,
    });
    await this.chromeClient.Input.dispatchMouseEvent({
      type: 'mousePressed',
      x: targetX,
      y: targetY,
      button: 'left',
      clickCount: 1,
    });
    await this.chromeClient.Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x: targetX,
      y: targetY,
      button: 'left',
      clickCount: 1,
    });
  }

  async setEditorMessage(message) {
    const result = await this.chromeClient.callFunction(browserSetEditorMessage, message);
    if (!result?.ok) {
      throw new Error(result?.error || 'SET_EDITOR_MESSAGE_FAILED');
    }
    return {
      value: String(result.value || ''),
      activeSubmit: Boolean(result?.activeSubmit),
    };
  }

  async sendMessage(expectedText = '') {
    let result = await this.chromeClient.callFunction(browserSendMessage, { expectedText });
    if (!result?.ok) {
      throw new Error(result?.error || 'SEND_MESSAGE_FAILED');
    }
    if (!result?.sent) {
      await this.chromeClient.pressEnter();
      await new Promise((resolve) => setTimeout(resolve, 280));
      result = await this.chromeClient.callFunction(browserSendMessage, { expectedText });
      if (!result?.ok) {
        throw new Error(result?.error || 'SEND_MESSAGE_FAILED');
      }
    }
    return result;
  }

  async clickAskResume() {
    let lastResult = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await this.chromeClient.callFunction(browserClickAskResume);
      lastResult = result;
      if (result?.ok) {
        return result;
      }
      if (result?.error !== 'ASK_RESUME_BUTTON_NOT_FOUND') {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 220 + attempt * 80));
    }
    throw new Error(lastResult?.error || 'CLICK_ASK_RESUME_FAILED');
  }

  async clickConfirmRequestResume() {
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const beforeState = await this.chromeClient.callFunction(browserGetRequestResumeUiState);
      if (beforeState?.hasDisabledOperateAsk) {
        return {
          ok: true,
          confirmed: false,
          requestedVerified: true,
          assumedRequested: true,
          uiState: beforeState,
        };
      }

      const result = await this.chromeClient.callFunction(browserClickConfirmRequestResume);
      if (result?.ok) {
        await new Promise((resolve) => setTimeout(resolve, 220));
      }

      const uiState = await this.chromeClient.callFunction(browserGetRequestResumeUiState);
      if (uiState?.hasDisabledOperateAsk) {
        return {
          ok: true,
          confirmed: Boolean(result?.ok),
          requestedVerified: true,
          assumedRequested: !Boolean(result?.ok),
          uiState,
        };
      }

      if (
        attempt % 3 === 2 &&
        uiState?.hasAskResume &&
        !uiState?.askDisabled &&
        !uiState?.hasConfirm
      ) {
        await this.chromeClient.callFunction(browserClickAskResume);
      }
      await new Promise((resolve) => setTimeout(resolve, 260));
    }
    const finalUiState = await this.chromeClient.callFunction(browserGetRequestResumeUiState);
    if (finalUiState?.hasDisabledOperateAsk) {
      return {
        ok: true,
        confirmed: false,
        requestedVerified: true,
        assumedRequested: true,
        uiState: finalUiState,
      };
    }
    throw new Error(
      `CLICK_CONFIRM_REQUEST_RESUME_FAILED(state=${JSON.stringify(finalUiState || {})})`,
    );
  }

  async getResumeRequestMessageState() {
    const result = await this.chromeClient.callFunction(browserGetResumeRequestMessageState);
    return {
      ok: Boolean(result?.ok),
      error: String(result?.error || ''),
      count: Number(result?.count || 0),
      lastText: String(result?.lastText || ''),
      recent: Array.isArray(result?.recent) ? result.recent.map((item) => String(item || '')) : [],
    };
  }

  async getResumeProfileFromDom() {
    const result = await this.chromeClient.callFunction(browserExtractResumeProfileFromModal);
    return {
      ok: Boolean(result?.ok),
      error: String(result?.error || ''),
      name: String(result?.name || ''),
      primarySchool: String(result?.primarySchool || ''),
      major: String(result?.major || ''),
      company: String(result?.company || ''),
      position: String(result?.position || ''),
      schools: Array.isArray(result?.schools) ? result.schools.map((item) => String(item || '')) : [],
      majors: Array.isArray(result?.majors) ? result.majors.map((item) => String(item || '')) : [],
      debug: result?.debug && typeof result.debug === 'object' ? result.debug : {},
    };
  }

  async waitForResumeRequestMessage({ baselineCount = 0, timeoutMs = 6500, pollMs = 260 } = {}) {
    const start = Date.now();
    let latest = null;
    const hasSentMessage = (state = {}) => {
      const lastText = String(state?.lastText || '');
      const recent = Array.isArray(state?.recent) ? state.recent : [];
      if (lastText.includes('简历请求已发送')) return true;
      return recent.some((item) => String(item || '').includes('简历请求已发送'));
    };
    while (Date.now() - start < timeoutMs) {
      const state = await this.getResumeRequestMessageState();
      latest = state;
      if (state.count > baselineCount || hasSentMessage(state)) {
        return {
          observed: true,
          state,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      observed: false,
      state: latest || {
        ok: false,
        error: 'RESUME_REQUEST_MESSAGE_STATE_EMPTY',
        count: 0,
        lastText: '',
        recent: [],
      },
    };
  }
}
