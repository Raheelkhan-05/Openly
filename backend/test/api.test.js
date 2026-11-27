const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { memoryStore } = require('../src/store');
const { config: base } = require('../src/config');
const sources = require('../src/lib/sources');

const KEY = 'k'.repeat(32);
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const GPROXY = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const APPLEMAIL = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const ago = (ms) => new Date(Date.now() - ms).toISOString();

async function boot(overrides = {}) {
  const store = memoryStore();
  const config = { ...base, apiKey: KEY, ipSalt: 'salt', authMode: 'apikey', ...overrides };
  const verifyToken = async (t) => (t.startsWith('user-') ? t : null);
  const app = createApp({ store, config, verifyToken });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = config.authMode === 'supabase' ? (who) => ({ authorization: 'Bearer ' + who }) : () => ({ 'x-api-key': KEY });
  const call = (path, opts = {}, who = 'user-a') => fetch(url + path, { ...opts, headers: { 'content-type': 'application/json', ...authHeaders(who), ...(opts.headers || {}) } });
  const register = (token, extra = {}, who) => call('/api/emails', { method: 'POST', body: JSON.stringify({ token, subject: 'Hello', to: ['a@x.com'], sentAt: ago(120000), ...extra }) }, who);
  const hit = async (token, ua = CHROME) => { const r = await fetch(`${url}/t/${token}.gif`, { headers: { 'user-agent': ua } }); return r; };
  const click = async (token, n, ua = CHROME) => fetch(`${url}/r/${token}/${n}`, { redirect: 'manual', headers: { 'user-agent': ua } });
  const get = async (token, who) => (await (await call('/api/emails/' + token, {}, who)).json()).email;
  return { server, store, url, call, register, hit, click, get };
}

test('rejects a wrong API key', async () => {
  const { server, url } = await boot();
  assert.equal((await fetch(url + '/api/emails', { headers: { 'x-api-key': 'nope' } })).status, 401);
  server.close();
});

test('pixel always returns a no-cache gif, even for junk', async () => {
  const { server, url } = await boot();
  const r = await fetch(url + '/t/not-a-token.gif');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/gif');
  assert.match(r.headers.get('cache-control'), /no-store/);
  server.close();
});

test('a normal load is an open; a repeat right after is the same open', async () => {
  const { server, register, hit, get } = await boot();
  const t = uuid();
  await register(t);
  assert.equal((await get(t)).status, 'none');
  await hit(t); await hit(t);
  const e = await get(t);
  assert.equal(e.status, 'opened');
  assert.equal(e.open_count, 1);
  assert.equal(e.confidence, 'high');
  assert.equal(e.events.filter((x) => x.same_open).length, 1);
  server.close();
});

test('the tracking address counts with or without .gif on the end', async () => {
  const { server, register, get, url } = await boot();
  const t = uuid();
  await register(t);
  await fetch(`${url}/t/${t}`, { headers: { 'user-agent': CHROME } });
  assert.equal((await get(t)).status, 'opened');
  server.close();
});

test('unknown tokens are ignored', async () => {
  const { server, store, hit } = await boot();
  await hit(uuid());
  assert.equal((await store.listEventsByOwner(base.singleOwner, 10)).length, 0);
  server.close();
});

test('scanners and just-sent loads are only "possible"', async () => {
  const { server, register, hit, get } = await boot();
  const t = uuid();
  await register(t);
  await hit(t, 'curl/8.0');
  let e = await get(t);
  assert.equal(e.status, 'possible');
  assert.equal(e.confidence, 'low');

  const t2 = uuid();
  await register(t2, { sentAt: new Date().toISOString() });
  await hit(t2);
  e = await get(t2);
  assert.deepEqual(e.events[0].flags, ['just_sent']);
  server.close();
});

test('gmail proxy opens count with medium confidence and a flag', async () => {
  const { server, register, hit, get } = await boot();
  const t = uuid();
  await register(t, { to: ['a@x.com', 'b@x.com'] });
  await hit(t, GPROXY);
  const e = await get(t);
  assert.equal(e.status, 'opened');
  assert.equal(e.confidence, 'medium');
  assert.deepEqual(e.events[0].flags, ['image_proxy']);
  assert.equal(e.recipient_count, 2);
  server.close();
});

test('your own view in Gmail is excluded', async () => {
  const { server, call, register, hit, get } = await boot();
  const t = uuid();
  await register(t);
  await call(`/api/emails/${t}/self-view`, { method: 'POST' });
  await hit(t, GPROXY);
  const e = await get(t);
  assert.equal(e.status, 'none');
  assert.equal(e.sender_count, 1);
  server.close();
});

test('pause excludes loads, and resume brings counting back', async () => {
  const { server, call, register, hit, get } = await boot();
  const t = uuid();
  await register(t);
  const p = await (await call('/api/pause', { method: 'POST', body: JSON.stringify({ minutes: 10 }) })).json();
  assert.ok(p.pause_until);
  assert.equal((await (await call('/api/ping')).json()).pause_until, p.pause_until);
  await hit(t, GPROXY);
  assert.equal((await get(t)).status, 'none');
  await call('/api/pause', { method: 'DELETE' });
  assert.equal((await (await call('/api/ping')).json()).pause_until, null);
  server.close();
});

test('"that was me" moves an open out of the count, and can be undone', async () => {
  const { server, call, register, hit, get } = await boot();
  const t = uuid();
  await register(t);
  await hit(t);
  const id = (await get(t)).events[0].id;
  await call(`/api/events/${id}/mine`, { method: 'POST', body: JSON.stringify({ mine: true }) });
  let e = await get(t);
  assert.equal(e.status, 'none');
  assert.equal(e.events[0].marked_mine, true);
  await call(`/api/events/${id}/mine`, { method: 'POST', body: JSON.stringify({ mine: false }) });
  e = await get(t);
  assert.equal(e.status, 'opened');
  server.close();
});

test('link clicks redirect, count, and give high confidence', async () => {
  const { server, register, click, get } = await boot();
  const t = uuid();
  await register(t, { links: [{ n: 1, url: 'https://example.com/pricing' }, { n: 2, url: 'javascript:alert(1)' }] });
  const r = await click(t, 1);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://example.com/pricing');
  const e = await get(t);
  assert.equal(e.status, 'opened');
  assert.equal(e.click_count, 1);
  assert.equal(e.confidence, 'high');
  assert.equal(e.link_count, 1); // the javascript: link was refused at registration
  assert.equal(e.clicked_links[0].url, 'https://example.com/pricing');
  server.close();
});

test('redirect only goes to registered links (no open redirect)', async () => {
  const { server, register, click, url } = await boot();
  const t = uuid();
  await register(t, { links: [{ n: 1, url: 'https://example.com/' }] });
  assert.equal((await click(t, 2)).status, 404);
  assert.equal((await click(uuid(), 1)).status, 404);
  assert.equal((await fetch(`${url}/r/${t}/1?u=https://evil.example`, { redirect: 'manual' })).headers.get('location'), 'https://example.com/');
  server.close();
});

test('a burst of different links from one visitor is a scanner, not a person', async () => {
  const { server, register, click, get } = await boot();
  const t = uuid();
  await register(t, { links: [1, 2, 3, 4].map((n) => ({ n, url: 'https://example.com/' + n })) });
  for (const n of [1, 2, 3, 4]) await click(t, n);
  const e = await get(t);
  assert.equal(e.click_count, 0);
  assert.equal(e.status, 'possible');
  assert.ok(e.events.every((x) => x.flags.includes('link_scanner')));
  server.close();
});

test('apple privacy network and apple mail preloads are not counted as reads', async () => {
  const { server, register, store, hit, get } = await boot();
  const t = uuid();
  await register(t);
  await store.addEvent({ token: t, owner: base.singleOwner, user_agent: CHROME, source: 'apple_privacy', ip_hash: 'x' });
  let e = await get(t);
  assert.equal(e.status, 'possible');
  assert.deepEqual(e.events[0].flags, ['apple_privacy']);

  const t2 = uuid();
  await register(t2, { sentAt: ago(30000) });
  await hit(t2, APPLEMAIL);
  e = await get(t2);
  assert.deepEqual(e.events[0].flags, ['preload']);
  server.close();
});

test('apple ranges list is read, including IPv6', () => {
  sources.addRangesFromCsv('17.5.0.0/16,US,US-CA,Cupertino,\n2a02:26f7:b3c0:4000::/64,GB,GB-LND,London,\n');
  assert.equal(sources.classifySource('17.5.9.9', CHROME), 'apple_privacy');
  assert.equal(sources.classifySource('::ffff:17.5.9.9', CHROME), 'apple_privacy');
  assert.equal(sources.classifySource('2a02:26f7:b3c0:4000::1', CHROME), 'apple_privacy');
  assert.equal(sources.classifySource('8.8.8.8', CHROME), 'direct');
  assert.equal(sources.classifySource('8.8.8.8', GPROXY), 'google_proxy');
});

test('opens from two different real devices are noticed', async () => {
  const { server, register, store, get } = await boot();
  const t = uuid();
  await register(t);
  const at = (s) => ago(s * 1000);
  await store.addEvent({ token: t, owner: base.singleOwner, user_agent: CHROME, occurred_at: at(100), ip_hash: 'a' });
  await store.addEvent({ token: t, owner: base.singleOwner, user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1', occurred_at: at(50), ip_hash: 'b' });
  assert.equal((await get(t)).distinct_devices, 2);
  server.close();
});

test('feed reports new events, including clicks, and can be reset to latest', async () => {
  const { server, call, register, hit, click } = await boot();
  const t = uuid();
  await register(t, { links: [{ n: 1, url: 'https://example.com/' }] });
  const start = await (await call('/api/events/feed?after_id=latest')).json();
  await hit(t);
  await click(t, 1);
  const feed = await (await call('/api/events/feed?after_id=' + start.last_id)).json();
  assert.equal(feed.events.length, 2);
  assert.deepEqual(feed.events.map((e) => e.type), ['open', 'click']);
  assert.equal(feed.events[0].subject, 'Hello');
  server.close();
});

test('reminders: due and unopened are returned; opened ones are quietly closed', async () => {
  const { server, call, register, hit } = await boot();
  const quiet = uuid(), opened = uuid();
  await register(quiet, { sentAt: ago(3 * 3600e3), remindAfterHours: 1 });
  await register(opened, { sentAt: ago(3 * 3600e3), remindAfterHours: 1 });
  await hit(opened);
  let r = await (await call('/api/reminders/due')).json();
  assert.deepEqual(r.reminders.map((x) => x.token), [quiet]);
  await call(`/api/emails/${quiet}/reminded`, { method: 'POST' });
  r = await (await call('/api/reminders/due')).json();
  assert.equal(r.reminders.length, 0);
  server.close();
});

test('insights count opens by hour and weekday', async () => {
  const { server, call, register, hit } = await boot();
  const t = uuid();
  await register(t);
  await hit(t);
  const i = await (await call('/api/insights?tz=0')).json();
  assert.equal(i.total, 1);
  assert.equal(i.opened, 1);
  assert.equal(i.hours.reduce((a, b) => a + b, 0), 1);
  assert.ok(i.median_minutes_to_first_open >= 1);
  server.close();
});

test('people only see their own emails, and cannot take over a tracking id', async () => {
  const { server, call, register, hit, get } = await boot({ authMode: 'supabase' });
  const t = uuid();
  assert.equal((await register(t, {}, 'user-a')).status, 201);
  await hit(t);
  assert.equal((await register(t, { subject: 'stolen' }, 'user-b')).status, 409);
  assert.equal((await call('/api/emails/' + t, {}, 'user-b')).status, 404);
  assert.equal((await (await call('/api/emails', {}, 'user-b')).json()).emails.length, 0);
  assert.equal((await (await call('/api/events/feed?after_id=0', {}, 'user-b')).json()).events.length, 0);
  assert.equal((await get(t, 'user-a')).subject, 'Hello');
  assert.equal((await call('/api/emails', {}, 'bad-token')).status, 401);
  server.close();
});

test('delete removes one email; delete-all wipes your data only', async () => {
  const { server, call, register, hit } = await boot({ authMode: 'supabase' });
  const a = uuid(), b = uuid();
  await register(a, {}, 'user-a'); await register(b, {}, 'user-b');
  await hit(a);
  await call('/api/emails/' + a, { method: 'DELETE' }, 'user-a');
  assert.equal((await call('/api/emails/' + a, {}, 'user-a')).status, 404);
  await register(a, {}, 'user-a');
  await call('/api/data', { method: 'DELETE' }, 'user-a');
  assert.equal((await (await call('/api/emails', {}, 'user-a')).json()).emails.length, 0);
  assert.equal((await (await call('/api/emails', {}, 'user-b')).json()).emails.length, 1);
  const exp = await (await call('/api/export', {}, 'user-b')).json();
  assert.equal(exp.emails.length, 1);
  server.close();
});
