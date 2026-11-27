const { parseUA } = require('./ua');

const BOT_UA = /(bot\b|crawler|spider|scanner|curl\/|wget|python-requests|python-urllib|go-http-client|java\/|okhttp|headless|phantomjs|barracuda|proofpoint|mimecast|symantec|trendmicro|safelinks|urlscan|postman|node-fetch|axios|libwww|monitor)/i;
const PROXY_UA = /(GoogleImageProxy|YahooMailProxy)/i;

/**
 * Decide what one tracking request most likely was.
 *   sender    - you (marked by you, during a pause, or while you viewed your own email). Never counted.
 *   possible  - ambiguous: scanner, preloader, or too soon after sending. Never counted as a read.
 *   recipient - a normal request. Counted.
 */
function classifyEvent(ev, email, views, mutes, rules) {
  const t = Date.parse(ev.occurred_at);
  const isClick = ev.type === 'click';

  if (ev.mine) return { kind: 'sender', flags: [], reason: 'You marked this as yours.' };

  for (const m of mutes) {
    if (t >= Date.parse(m.starts_at) && t <= Date.parse(m.ends_at)) {
      return { kind: 'sender', flags: [], reason: 'Happened while you had counting paused.' };
    }
  }
  if (!isClick) {
    for (const v of views) {
      const seen = Date.parse(v.seen_at);
      if (t >= seen - rules.selfViewBeforeMs && t <= seen + rules.selfViewAfterMs) {
        return { kind: 'sender', flags: [], reason: 'Happened while you were viewing this email in Gmail.' };
      }
    }
  }

  if (ev.source === 'apple_privacy') {
    return { kind: 'possible', flags: ['apple_privacy'], reason: "Came through Apple's privacy network, which loads images before anyone reads." };
  }
  const ua = (ev.user_agent || '').trim();
  if (!ua || BOT_UA.test(ua)) {
    return { kind: 'possible', flags: ['automated'], reason: 'Looks like a scanner or link checker, not a person.' };
  }

  const sinceSend = email ? t - Date.parse(email.sent_at) : Infinity;
  if (sinceSend < (isClick ? rules.clickJustSentMs : rules.justSentMs)) {
    return { kind: 'possible', flags: ['just_sent'], reason: 'Arrived seconds after sending. It may be your own view or a scanner.' };
  }
  if (!isClick && sinceSend < rules.applePrefetchMs && parseUA(ua).browser === 'Apple Mail') {
    return { kind: 'possible', flags: ['preload'], reason: "Apple Mail can load images as soon as mail arrives, before it's read." };
  }

  const proxy = PROXY_UA.test(ua);
  return {
    kind: 'recipient',
    flags: proxy ? ['image_proxy'] : [],
    reason: isClick ? 'A link was clicked.' : proxy ? 'Loaded through an email image proxy, which hides the real device.' : 'The tracking image was loaded.',
  };
}

function summarize(email, events, views, mutes, rules) {
  const sorted = [...events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id - b.id);
  const linkUrl = (n) => (email.links || []).find((l) => l.n === n)?.url || null;

  const items = sorted.map((ev) => ({ ev, t: Date.parse(ev.occurred_at), c: classifyEvent(ev, email, views, mutes, rules) }));

  // Security scanners open every link in a message within seconds.
  for (const a of items) {
    if (a.ev.type !== 'click' || a.c.kind !== 'recipient' || !a.ev.ip_hash) continue;
    const seen = new Set();
    for (const b of items) {
      if (b.ev.type === 'click' && b.ev.ip_hash === a.ev.ip_hash && Math.abs(b.t - a.t) <= rules.burstMs) seen.add(b.ev.link_n);
    }
    if (seen.size >= rules.burstLinks) {
      a.c = { kind: 'possible', flags: ['link_scanner'], reason: 'Several links were requested within seconds, which looks like a security scanner.' };
    }
  }

  let openCount = 0, clickCount = 0, possible = 0, sender = 0;
  let firstAt = null, lastAt = null, lastCountedOpenAt = null, directOpen = false;
  const devices = new Set();
  const clicked = new Map();

  const out = items.map(({ ev, t, c }) => {
    const info = parseUA(ev.user_agent);
    const item = {
      id: ev.id,
      type: ev.type || 'open',
      occurred_at: ev.occurred_at,
      kind: c.kind,
      flags: c.flags,
      reason: c.reason,
      same_open: false,
      open_index: null,
      link_n: ev.link_n ?? null,
      link_url: ev.type === 'click' ? linkUrl(ev.link_n) : null,
      marked_mine: !!ev.mine,
      ...info,
    };
    if (c.kind === 'recipient') {
      firstAt = firstAt || ev.occurred_at;
      lastAt = ev.occurred_at;
      const direct = !c.flags.includes('image_proxy');
      if (direct) devices.add(`${info.browser}|${info.os}|${info.device}`);
      if (item.type === 'click') {
        clickCount += 1;
        clicked.set(ev.link_n, (clicked.get(ev.link_n) || 0) + 1);
      } else if (lastCountedOpenAt !== null && t - lastCountedOpenAt < rules.sameOpenMs) {
        item.same_open = true;
      } else {
        openCount += 1;
        item.open_index = openCount;
        lastCountedOpenAt = t;
        if (direct) directOpen = true;
      }
    } else if (c.kind === 'possible') possible += 1;
    else sender += 1;
    return item;
  });

  const engaged = openCount + clickCount > 0;
  const recipientCount = (email.to_recipients || []).length + (email.cc_recipients || []).length + (email.bcc_recipients || []).length;

  return {
    token: email.token,
    subject: email.subject,
    to_recipients: email.to_recipients || [],
    cc_recipients: email.cc_recipients || [],
    bcc_recipients: email.bcc_recipients || [],
    recipient_count: recipientCount,
    sent_at: email.sent_at,
    status: engaged ? 'opened' : possible > 0 ? 'possible' : 'none',
    // high: a link was clicked, or a real client loaded the image. medium: loaded through a proxy. low: only uncertain activity.
    confidence: clickCount > 0 ? 'high' : openCount > 0 ? (directOpen ? 'high' : 'medium') : possible > 0 ? 'low' : null,
    open_count: openCount,
    click_count: clickCount,
    possible_count: possible,
    sender_count: sender,
    first_open_at: firstAt,
    last_open_at: lastAt,
    distinct_devices: devices.size,
    link_count: (email.links || []).length,
    clicked_links: [...clicked.entries()].map(([n, count]) => ({ n, url: linkUrl(n), count })),
    remind_at: email.remind_at || null,
    reminded_at: email.reminded_at || null,
    events: out,
  };
}

module.exports = { classifyEvent, summarize };
