importScripts('config.js', 'shared.js', 'brand.js');
const { api, getSettings, isConfigured, backendOf } = Openly;

const dashboardUrl = (hash = '') => chrome.runtime.getURL('dashboard/dashboard.html') + hash;
let chain = Promise.resolve();
// Runs jobs one after another; a failed job never blocks the next one.
const serial = (fn) => (chain = chain.catch(() => { }).then(() => fn()));

/* ---------- badge ---------- */
async function refreshBadge() {
  const { unseen = 0, health = 'ok' } = await chrome.storage.local.get(['unseen', 'health']);
  if (health !== 'ok') {
    await chrome.action.setBadgeBackgroundColor({ color: '#B3382C' });
    await chrome.action.setBadgeText({ text: '!' });
  } else {
    await chrome.action.setBadgeBackgroundColor({ color: '#0B8F6A' });
    await chrome.action.setBadgeText({ text: unseen > 0 ? String(Math.min(unseen, 99)) : '' });
  }
}
async function setHealth(health) {
  await chrome.storage.local.set({ health });
  await refreshBadge();
}

/* ---------- stop your own browser from loading the tracking image while you write ---------- */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function syncBlockRule() {
  const base = backendOf(await getSettings());
  const addRules = base
    ? [{ id: 1, priority: 1, action: { type: 'block' }, condition: { regexFilter: '^' + escapeRegex(base) + '/t/', resourceTypes: ['image'], initiatorDomains: ['mail.google.com'] } }]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules });
}

/* ---------- registering sent emails (kept in a queue until the server accepts them) ---------- */
function enqueue(item) {
  return serial(async () => {
    const { pending = [] } = await chrome.storage.local.get('pending');
    await chrome.storage.local.set({ pending: pending.filter((p) => p.token !== item.token).concat(item).slice(-50) });
    await flushQueue();
  });
}

async function flushQueue() {
  const s = await getSettings();
  const { pending = [] } = await chrome.storage.local.get('pending');
  if (!pending.length) return;
  if (!isConfigured(s)) return setHealth('setup');
  const keep = [];
  for (const item of pending) {
    try {
      await api('/api/emails', { method: 'POST', body: item, settings: s });
      await setHealth('ok');
    } catch (e) {
      if (e.code === 'unauthorized') await setHealth('auth');
      const retry = e.code === 'network' || e.code === 'unauthorized' || e.status >= 500 || e.status === 429;
      if (retry && Date.now() - Date.parse(item.sentAt) < 7 * 864e5) keep.push(item);
    }
  }
  await chrome.storage.local.set({ pending: keep });
}

/* ---------- notifications ---------- */
function notify(id, title, message, context) {
  return chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, contextMessage: context || '' });
}

async function notifyFor(ev, s) {
  let title = null;
  if (ev.kind === 'recipient' && ev.type === 'click') {
    if (s.notifyClicks) title = 'A link was clicked';
  } else if (ev.kind === 'recipient' && !ev.same_open) {
    if (ev.open_index === 1 && s.notifyOpens) title = 'Your email was opened';
    else if (ev.open_index > 1 && s.notifyRepeat) title = `Opened again (${ev.open_index} opens)`;
  } else if (ev.kind === 'possible' && s.notifyPossible) {
    title = 'Possible open';
  }
  if (!title) return false;
  const who = ev.recipient_count > 1 ? `Sent to ${ev.recipient_count} people. Can't tell who.` : (ev.to_recipients || [])[0] || '';
  await notify(`openly|${ev.token}|${ev.id}`, title, ev.subject || '(no subject)', who);
  return true;
}

function poll() {
  return serial(async () => {
    const s = await getSettings();
    if (!isConfigured(s)) return setHealth('setup');
    try {
      const { cursor } = await chrome.storage.local.get('cursor');
      if (cursor == null) {
        const r = await api('/api/events/feed?after_id=latest', { settings: s });
        await chrome.storage.local.set({ cursor: r.last_id });
        return setHealth('ok');
      }
      const r = await api(`/api/events/feed?after_id=${cursor}`, { settings: s });
      let fresh = 0;
      for (const ev of r.events) if (await notifyFor(ev, s)) fresh += 1;
      // If the server's data was reset, start again from its current position.
      await chrome.storage.local.set({ cursor: r.latest_id < cursor ? r.latest_id : r.last_id });
      if (fresh) {
        const { unseen = 0 } = await chrome.storage.local.get('unseen');
        await chrome.storage.local.set({ unseen: unseen + fresh });
      }
      await setHealth('ok');
    } catch (e) {
      if (e.code === 'unauthorized') await setHealth('auth');
    }
  });
}

// Follow-ups: emails still unopened when their reminder comes due. Checked every ten minutes.
function checkReminders() {
  return serial(async () => {
    const s = await getSettings();
    if (!isConfigured(s)) return;
    const { lastReminderCheck = 0 } = await chrome.storage.local.get('lastReminderCheck');
    if (Date.now() - lastReminderCheck < 10 * 60000) return;
    await chrome.storage.local.set({ lastReminderCheck: Date.now() });
    try {
      const { reminders } = await api('/api/reminders/due', { settings: s });
      for (const r of reminders) {
        // Mark it first, so a failed request can never make the same reminder pop up every ten minutes.
        await api(`/api/emails/${r.token}/reminded`, { method: 'POST', settings: s });
        await notify(`openly|${r.token}|r`, 'No open yet', r.subject || '(no subject)', `Sent ${Openly.timeAgo(r.sent_at)}. You asked for a reminder.`);
      }
    } catch { /* try again next time */ }
  });
}

/* ---------- wiring ---------- */
function ensureAlarm() {
  chrome.alarms.get('tick', (a) => { if (!a) chrome.alarms.create('tick', { periodInMinutes: 1 }); });
}
ensureAlarm();

const quiet = (p) => Promise.resolve(p).catch(() => { });

chrome.runtime.onInstalled.addListener((d) => {
  ensureAlarm();
  quiet(syncBlockRule());
  quiet(refreshBadge());
  if (d.reason === 'install') chrome.tabs.create({ url: dashboardUrl('#settings') });
});
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); quiet(syncBlockRule()); quiet(refreshBadge()); quiet(poll()); });

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'tick') return;
  quiet(serial(flushQueue));
  quiet(poll());
  quiet(checkReminders());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    const o = changes.settings.oldValue || {};
    const n = changes.settings.newValue || {};
    if (['mode', 'backendUrl', 'apiKey', 'signedIn'].some((k) => o[k] !== n[k])) {
      chrome.storage.local.remove('cursor');
      quiet(syncBlockRule());
      quiet(serial(flushQueue).then(poll));
    }
  }
  if (changes.unseen) quiet(refreshBadge());
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === 'register') {
    enqueue(msg.payload).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === 'selfview') {
    quiet(api(`/api/emails/${msg.token}/self-view`, { method: 'POST' }));
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'open-settings') {
    chrome.tabs.create({ url: dashboardUrl('#settings') });
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type === 'clear-unseen') {
    chrome.storage.local.set({ unseen: 0 }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'poll-now') {
    poll().then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.notifications.onClicked.addListener((id) => {
  const [prefix, token] = id.split('|');
  if (prefix !== 'openly' || !/^[0-9a-f-]{36}$/i.test(token)) return;
  chrome.tabs.create({ url: dashboardUrl(`#email=${token}`) });
  chrome.notifications.clear(id);
});