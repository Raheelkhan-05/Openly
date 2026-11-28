const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Loads the extension's shared.js with a fake browser around it.
function load({ hash = '', settings = {}, fetchImpl } = {}) {
  const store = { settings };
  const calls = { replace: [], fetch: [] };
  for (const k of Object.keys(require.cache)) if (k.endsWith('extension/shared.js')) delete require.cache[k];
  globalThis.OpenlyConfig = { hostedUrl: 'https://openly.example', supabaseUrl: 'https://proj.supabase.co', supabaseAnonKey: 'anon' };
  globalThis.chrome = { storage: { local: {
    async get(keys) { if (keys == null) return { ...store }; const out = {}; for (const k of [].concat(keys)) if (k in store) out[k] = store[k]; return out; },
    async set(o) { Object.assign(store, o); },
    async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
  }, onChanged: { addListener() {} } } };
  globalThis.location = { hash, pathname: '/app/' };
  globalThis.history = { replaceState: (...a) => calls.replace.push(a) };
  globalThis.fetch = async (url, opts) => { calls.fetch.push([url, opts]); return fetchImpl(url, opts); };
  require(path.join(__dirname, '../../extension/shared.js'));
  return { O: globalThis.Openly, store, calls };
}
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, headers: { get: () => null } });

test('the web dashboard signs in from a handoff link and removes it from the address bar', async () => {
  const { O, store, calls } = load({
    hash: '#handoff=one-time-value&go=email%3Dabc',
    fetchImpl: async () => json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { email: 'me@x.com' } }),
  });
  const go = await O.consumeHandoff();
  assert.equal(go, 'email=abc');
  const [url, opts] = calls.fetch[0];
  assert.equal(url, 'https://proj.supabase.co/auth/v1/verify');
  assert.deepEqual(JSON.parse(opts.body), { type: 'magiclink', token_hash: 'one-time-value' });
  assert.equal(calls.replace.length, 1, 'the secret is removed from the address bar straight away');
  assert.equal(calls.replace[0][2], '/app/');
  assert.equal(store.session.accessToken, 'AT');
  assert.equal(store.session.refreshToken, 'RT');
  assert.equal(store.settings.signedIn, true);
  assert.equal(store.settings.accountEmail, 'me@x.com');
});

test('an expired or used handoff link says so and signs nobody in', async () => {
  const { O, store } = load({ hash: '#handoff=old', fetchImpl: async () => json(403, { error: 'otp_expired' }) });
  await assert.rejects(() => O.consumeHandoff(), /expired or was already used/);
  assert.equal(store.settings.signedIn, undefined);
});

test('a normal address does nothing', async () => {
  const { O, calls } = load({ hash: '#insights', fetchImpl: async () => json(200, {}) });
  assert.equal(await O.consumeHandoff(), null);
  assert.equal(calls.replace.length, 0);
  assert.equal(calls.fetch.length, 0);
});

test('self-hosted handoff carries the server and key', async () => {
  const { O, store } = load({ hash: '#server=https%3A%2F%2Fmy.example.com&key=secretkey', fetchImpl: async () => json(200, {}) });
  assert.equal(await O.consumeHandoff(), '');
  assert.equal(store.settings.mode, 'selfhost');
  assert.equal(store.settings.backendUrl, 'https://my.example.com');
  assert.equal(store.settings.apiKey, 'secretkey');
});

test('the extension builds a link from the server answer', async () => {
  const { O } = load({
    settings: { mode: 'cloud', signedIn: true, accountEmail: 'me@x.com' },
    fetchImpl: async (url) => (url.endsWith('/api/handoff') ? json(200, { token_hash: 'abc 123' }) : json(200, {})),
  });
  await globalThis.chrome.storage.local.set({ session: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600000 } });
  const link = await O.webHandoffUrl('email=zzz');
  assert.equal(link, 'https://openly.example/app/#handoff=abc%20123&go=email%3Dzzz');
});
