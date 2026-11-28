const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createJwtVerifier } = require('../src/lib/jwt');
const { createVerifier } = require('../src/lib/verifier');
const { createCache } = require('../src/lib/cache');
const { createApp } = require('../src/app');
const { memoryStore } = require('../src/store');
const { config: base } = require('../src/config');

const URL_ = 'https://proj.supabase.co';
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function es256Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' };
  const sign = (claims, header = {}) => {
    const h = b64({ alg: 'ES256', typ: 'JWT', kid: 'k1', ...header });
    const p = b64(claims);
    const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  return { jwk, sign };
}
const claims = (extra = {}) => ({ sub: 'user-1', email: 'a@x.com', aud: 'authenticated', iss: URL_ + '/auth/v1', exp: Math.floor(Date.now() / 1000) + 3600, ...extra });
const jwksFetch = (jwk, counter = { n: 0 }) => async () => { counter.n++; return { ok: true, json: async () => ({ keys: [jwk] }) }; };

test('a token signed with a published key is accepted without asking Supabase', async () => {
  const { jwk, sign } = es256Pair();
  const counter = { n: 0 };
  const verify = createJwtVerifier({ supabaseUrl: URL_, fetchImpl: jwksFetch(jwk, counter) });
  const u = await verify(sign(claims()));
  assert.equal(u.uid, 'user-1');
  assert.equal(u.email, 'a@x.com');
  await verify(sign(claims()));
  assert.equal(counter.n, 1, 'keys are fetched once, then remembered');
});

test('forged, expired, wrong-audience and wrong-issuer tokens are rejected', async () => {
  const { jwk, sign } = es256Pair();
  const other = es256Pair();
  const verify = createJwtVerifier({ supabaseUrl: URL_, fetchImpl: jwksFetch(jwk) });
  assert.equal(await verify(other.sign(claims())), null, 'signed by another key');
  assert.equal(await verify(sign(claims({ exp: Math.floor(Date.now() / 1000) - 60 }))), null, 'expired');
  assert.equal(await verify(sign(claims({ aud: 'anon' }))), null, 'wrong audience');
  assert.equal(await verify(sign(claims({ iss: 'https://evil.example/auth/v1' }))), null, 'wrong issuer');
  assert.equal(await verify(sign(claims({ sub: undefined }))), null, 'no subject');
  assert.equal(await verify('not.a.jwt'), null);
  assert.equal(await verify('garbage'), null);
});

test('HS256 tokens need the shared secret; without it Supabase is asked', async () => {
  const secret = 'shhh-its-a-secret';
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64(claims());
  const sig = crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
  const jwt = `${h}.${p}.${sig}`;
  assert.equal((await createJwtVerifier({ supabaseUrl: URL_, jwtSecret: secret })(jwt)).uid, 'user-1');
  assert.equal(await createJwtVerifier({ supabaseUrl: URL_, jwtSecret: 'wrong' })(jwt), null);
  assert.equal(await createJwtVerifier({ supabaseUrl: URL_ })(jwt), undefined);

  let asked = 0;
  const supabase = { auth: { getUser: async () => { asked++; return { data: { user: { id: 'user-9', email: 'z@x.com' } }, error: null }; } } };
  const verify = createVerifier(supabase, { supabaseUrl: URL_ });
  assert.deepEqual(await verify(jwt), { uid: 'user-9', email: 'z@x.com' });
  await verify(jwt);
  assert.equal(asked, 1, 'the answer is remembered');
});

test('the cache works in memory, and through Redis when configured', async () => {
  const mem = createCache();
  await mem.set('a', { x: 1 }, 30);
  assert.deepEqual(await mem.get('a'), { x: 1 });
  await mem.del('a');
  assert.equal(await mem.get('a'), undefined);

  const calls = [];
  const store = new Map();
  const fake = async (url, opts) => {
    const cmds = JSON.parse(opts.body);
    calls.push(cmds);
    return { ok: true, json: async () => cmds.map(([c, k, v]) => ({ result: c === 'SET' ? (store.set(k, v), 'OK') : c === 'GET' ? store.get(k) ?? null : c === 'INCR' ? (store.set(k, String((Number(store.get(k)) || 0) + 1)), 1) : c === 'MGET' ? [store.get(k) ?? null, store.get(v) ?? null] : c === 'DEL' ? (store.delete(k), 1) : 'OK' })) };
  };
  const r = createCache({ url: 'https://r.example', token: 't', fetchImpl: fake });
  await r.writeVersioned('d', { ver: 0, body: 7 }, 60);
  const read = await r.readVersioned('v', 'd');
  assert.deepEqual(read, { ver: 0, entry: { ver: 0, body: 7 } });
  assert.equal(calls.filter((c) => c[0][0] === 'MGET').length, 1, 'version and answer come back in one round trip');
  await r.bump('v');
  assert.equal((await r.readVersioned('v', 'd')).ver, 1);
  const down = createCache({ url: 'https://r.example', token: 't', fetchImpl: async () => { throw new Error('offline'); } });
  await down.set('k', 1, 30);
  assert.equal(await down.get('k'), 1, 'a Redis outage falls back to memory instead of failing');
});

async function boot(overrides = {}, extra = {}) {
  const store = memoryStore();
  const config = { ...base, apiKey: 'k'.repeat(32), ipSalt: 's', authMode: 'supabase', ...overrides };
  const verifyToken = async (t) => (t.startsWith('user-') ? { uid: t, email: t + '@example.com' } : null);
  const app = createApp({ store, config, verifyToken, ...extra });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, opts = {}, who = 'user-a') => fetch(url + path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + who, ...(opts.headers || {}) } });
  return { server, store, url, call };
}
const uuid = () => crypto.randomUUID();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the tracking image answers at once and the open is saved afterwards', async () => {
  const { server, store, url, call } = await boot({ deferWrites: true });
  const t = uuid();
  await call('/api/emails', { method: 'POST', body: JSON.stringify({ token: t, subject: 'Hi', to: ['a@x.com'], sentAt: new Date(Date.now() - 120000).toISOString() }) });
  const slow = store.addEvent.bind(store);
  store.addEvent = async (e) => { await wait(300); return slow(e); }; // a slow database
  const started = Date.now();
  const r = await fetch(`${url}/t/${t}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/gif');
  assert.ok(Date.now() - started < 200, 'did not wait for the slow database');
  await wait(600);
  assert.equal((await (await call('/api/emails/' + t)).json()).email.open_count, 1, 'the open was saved');
  server.close();
});

test('a new open shows up in the list at once even though lists are cached', async () => {
  const { server, url, call } = await boot({ deferWrites: false });
  const t = uuid();
  await call('/api/emails', { method: 'POST', body: JSON.stringify({ token: t, subject: 'Hi', to: ['a@x.com'], sentAt: new Date(Date.now() - 120000).toISOString() }) });
  const first = await (await call('/api/emails')).json();
  assert.equal(first.emails[0].open_count, 0);
  await call('/api/emails'); // served from the cache
  await fetch(`${url}/t/${t}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' } });
  assert.equal((await (await call('/api/emails')).json()).emails[0].open_count, 1);
  assert.equal((await (await call('/api/emails/' + t)).json()).email.open_count, 1);
  await call('/api/emails/' + t, { method: 'DELETE' });
  assert.equal((await (await call('/api/emails')).json()).emails.length, 0, 'a delete shows up at once');
  server.close();
});

test('cached answers never leak to another person, and unchanged lists answer 304', async () => {
  const { server, url, call } = await boot({ deferWrites: false });
  const t = uuid();
  await call('/api/emails', { method: 'POST', body: JSON.stringify({ token: t, subject: 'Mine', to: ['a@x.com'] }) }, 'user-a');
  await call('/api/emails/' + t, {}, 'user-a');
  assert.equal((await call('/api/emails/' + t, {}, 'user-b')).status, 404);
  assert.equal((await (await call('/api/emails', {}, 'user-b')).json()).emails.length, 0);
  const one = await call('/api/emails', {}, 'user-a');
  const etag = one.headers.get('etag');
  assert.ok(etag);
  assert.match(one.headers.get('cache-control'), /no-cache/);
  // A browser revalidating its stored copy sends just If-None-Match. (Node's fetch adds no-cache to such requests, so use http.)
  const status = await new Promise((resolve, reject) => {
    require('node:http').get(url + '/api/emails', { headers: { authorization: 'Bearer user-a', 'if-none-match': etag } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  server.close();
  assert.equal(status, 304);
});

test('handoff gives a one-time sign-in value for the signed-in account only', async () => {
  const { server, url, call } = await boot();
  const r = await call('/api/handoff', { method: 'POST' }, 'user-a');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).token_hash, 'hash-for-user-a@example.com');
  assert.equal((await fetch(url + '/api/handoff', { method: 'POST' })).status, 401);
  server.close();
  const self = await boot({ authMode: 'apikey' });
  const r2 = await fetch(self.url + '/api/handoff', { method: 'POST', headers: { 'x-api-key': 'k'.repeat(32) } });
  assert.equal(r2.status, 400);
  self.server.close();
});
