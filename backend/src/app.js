const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { summarize } = require('./lib/summarize');
const { computeInsights } = require('./lib/insights');
const { classifySource } = require('./lib/sources');
const { buildPixel } = require('./lib/pixel');
const brand = require('./brand');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIXEL_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.gif)?$/i;
const GIF = buildPixel(brand.fingerprint ? 'openly:' + brand.fingerprint : null);

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const withTimeout = (p, ms) => {
  let timer;
  return Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), ms); })]).finally(() => clearTimeout(timer));
};
const isHttpUrl = (u) => typeof u === 'string' && u.length <= 2048 && /^https?:\/\/[^\s]+$/i.test(u);

function cleanList(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim().toLowerCase().slice(0, 254);
    if (s.includes('@')) seen.add(s);
    if (seen.size >= 100) break;
  }
  return [...seen];
}
function cleanLinks(v) {
  if (!Array.isArray(v)) return [];
  const out = new Map();
  for (const l of v) {
    const n = Number(l?.n);
    if (Number.isInteger(n) && n >= 1 && n <= 500 && isHttpUrl(l.url)) out.set(n, { n, url: l.url });
    if (out.size >= 200) break;
  }
  return [...out.values()];
}
function group(rows) {
  const m = new Map();
  for (const r of rows) (m.get(r.token) || m.set(r.token, []).get(r.token)).push(r);
  return m;
}

function createApp({ store, config, verifyToken }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(cors({ origin: true, allowedHeaders: ['content-type', 'x-api-key', 'authorization'], methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], maxAge: 600 }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  /* ---- who owns a tracking token (remembered for a minute) ---- */
  const cache = new Map();
  async function emailFor(token) {
    const hit = cache.get(token);
    if (hit && hit.exp > Date.now()) return hit.email;
    const email = await store.getEmail(token);
    if (email) {
      if (cache.size > 5000) cache.clear();
      cache.set(token, { email, exp: Date.now() + 60000 });
    }
    return email;
  }

  async function record(token, type, linkN, req) {
    const email = await emailFor(token);
    if (!email) return false; // not one of ours
    const ua = String(req.get('user-agent') || '').slice(0, 400);
    await store.addEvent({
      token,
      owner: email.owner,
      type,
      link_n: linkN,
      user_agent: ua,
      source: classifySource(req.ip, ua),
      ip_hash: crypto.createHash('sha256').update(config.ipSalt + (req.ip || '')).digest('hex').slice(0, 16),
    });
    return true;
  }

  /* ---- public: the tracking image and the link redirect ---- */
  const publicLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: false, legacyHeaders: false, handler: (req, res) => (req.path.startsWith('/r/') ? res.status(429).type('text').send('Too many requests') : sendGif(res)) });
  function sendGif(res) {
    res.set({
      'Content-Type': 'image/gif',
      'Content-Length': GIF.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.status(200).end(GIF);
  }
  app.get('/t/:file', publicLimiter, async (req, res) => {
    const m = PIXEL_FILE.exec(req.params.file);
    if (m) {
      try { await withTimeout(record(m[1].toLowerCase(), 'open', null, req), 2500); }
      catch (e) { console.error('Could not save open:', e.message); }
    }
    sendGif(res);
  });

  // Links are looked up from what the sender registered, never taken from the address, so this can't be abused as an open redirect.
  app.get('/r/:token/:n', publicLimiter, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const notFound = () => res.status(404).type('text').send('This link is no longer available.');
    if (!UUID.test(req.params.token) || !/^\d{1,3}$/.test(req.params.n)) return notFound();
    const token = req.params.token.toLowerCase();
    const n = Number(req.params.n);
    let email;
    try { email = await emailFor(token); } catch (e) { console.error(e.message); return notFound(); }
    const link = (email?.links || []).find((l) => l.n === n);
    if (!link || !isHttpUrl(link.url)) return notFound();
    try { await withTimeout(record(token, 'click', n, req), 2500); }
    catch (e) { console.error('Could not save click:', e.message); }
    res.redirect(302, link.url);
  });

  /* ---- everything below needs a signed-in person ---- */
  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: false, legacyHeaders: false, message: { error: 'Too many requests. Try again in a minute.' } });
  const expected = config.apiKey ? sha(config.apiKey) : null;
  const auth = wrap(async (req, res, next) => {
    if (config.authMode === 'supabase') {
      const bearer = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
      const uid = bearer ? await verifyToken(bearer[1]) : null;
      if (!uid) return res.status(401).json({ error: 'Please sign in again.' });
      req.owner = uid;
      return next();
    }
    if (expected && crypto.timingSafeEqual(sha(req.get('x-api-key') || ''), expected)) {
      req.owner = config.singleOwner;
      return next();
    }
    res.status(401).json({ error: 'The API key is not correct.' });
  });
  app.use('/api', apiLimiter, auth);

  async function summaries(owner, { limit = 100, emails = null } = {}) {
    const list = emails || (await store.listEmails(owner, limit));
    const tokens = list.map((e) => e.token);
    const [events, views, mutes] = await Promise.all([store.listEvents(tokens), store.listSenderViews(tokens), store.listMutes(owner)]);
    const ev = group(events);
    const vw = group(views);
    return list.map((e) => summarize(e, ev.get(e.token) || [], vw.get(e.token) || [], mutes, config.rules));
  }
  const strip = ({ events, ...rest }) => rest;
  const tokenParam = (req, res) => {
    if (!UUID.test(req.params.token)) { res.status(400).json({ error: 'Invalid token.' }); return null; }
    return req.params.token.toLowerCase();
  };

  app.get('/api/ping', wrap(async (req, res) => {
    const now = Date.now();
    const active = (await store.listMutes(req.owner)).filter((m) => Date.parse(m.starts_at) <= now && Date.parse(m.ends_at) > now);
    const until = active.length ? new Date(Math.max(...active.map((m) => Date.parse(m.ends_at)))).toISOString() : null;
    res.json({ ok: true, storage: store.name, mode: config.authMode, pause_until: until, time: new Date(now).toISOString() });
  }));

  app.post('/api/pause', wrap(async (req, res) => {
    const minutes = Math.min(Math.max(Math.round(Number(req.body?.minutes)) || 0, 1), 480);
    const now = Date.now();
    await store.addMute(req.owner, new Date(now - 5000).toISOString(), new Date(now + minutes * 60000).toISOString());
    res.json({ ok: true, pause_until: new Date(now + minutes * 60000).toISOString() });
  }));
  app.delete('/api/pause', wrap(async (req, res) => {
    await store.clearMutes(req.owner);
    res.json({ ok: true });
  }));

  app.post('/api/emails', wrap(async (req, res) => {
    const b = req.body || {};
    if (!UUID.test(String(b.token || ''))) return res.status(400).json({ error: 'token must be a UUID.' });
    const token = b.token.toLowerCase();
    let sent = Date.parse(b.sentAt);
    if (!Number.isFinite(sent) || sent > Date.now() + 5 * 60_000) sent = Date.now();
    const hours = Math.min(Math.max(Number(b.remindAfterHours) || 0, 0), 24 * 30);
    const row = {
      token,
      owner: req.owner,
      subject: String(b.subject || '').slice(0, 998),
      to_recipients: cleanList(b.to),
      cc_recipients: cleanList(b.cc),
      bcc_recipients: cleanList(b.bcc),
      links: cleanLinks(b.links),
      remind_at: hours ? new Date(sent + hours * 3600_000).toISOString() : null,
      sent_at: new Date(sent).toISOString(),
    };
    // A new email is one database call. Only when the token already exists (the same email registered again) do we
    // check who owns it first.
    if (!(await store.insertEmail(row))) {
      const existing = await store.getEmail(token);
      if (existing && existing.owner !== req.owner) return res.status(409).json({ error: 'This tracking id belongs to someone else.' });
      await store.upsertEmail(row);
    }
    cache.delete(token);
    res.status(201).json({ ok: true });
  }));

  // Fills in the real subject, recipients and send time of an email that was registered without them (the phone
  // add-on cannot read the subject of a draft). It never touches links or reminders, so it cannot undo what the
  // Chrome extension registered for the same token.
  app.post('/api/emails/:token/details', wrap(async (req, res) => {
    const token = tokenParam(req, res); if (!token) return;
    const b = req.body || {};
    const patch = {};
    if (typeof b.subject === 'string' && b.subject.trim()) patch.subject = b.subject.trim().slice(0, 998);
    for (const [key, col] of [['to', 'to_recipients'], ['cc', 'cc_recipients'], ['bcc', 'bcc_recipients']]) {
      if (Array.isArray(b[key])) patch[col] = cleanList(b[key]);
    }
    const sent = Date.parse(b.sentAt);
    if (Number.isFinite(sent) && sent <= Date.now() + 5 * 60_000) patch.sent_at = new Date(sent).toISOString();
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update.' });
    const row = await store.updateEmail(req.owner, token, patch);
    if (!row) return res.status(404).json({ error: 'Unknown email.' });
    cache.delete(token);
    res.json({ ok: true });
  }));

  app.post('/api/emails/:token/self-view', wrap(async (req, res) => {
    const token = tokenParam(req, res); if (!token) return;
    const email = await store.getEmail(token);
    if (!email || email.owner !== req.owner) return res.status(404).json({ error: 'Unknown email.' });
    await store.addSenderView(req.owner, token);
    res.json({ ok: true });
  }));

  app.get('/api/emails', wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    res.json({ emails: (await summaries(req.owner, { limit })).map(strip), server_time: new Date().toISOString() });
  }));

  app.get('/api/emails/:token', wrap(async (req, res) => {
    const token = tokenParam(req, res); if (!token) return;
    const email = await store.getEmail(token);
    if (!email || email.owner !== req.owner) return res.status(404).json({ error: 'This email is no longer tracked.' });
    res.json({ email: (await summaries(req.owner, { emails: [email] }))[0] });
  }));

  app.delete('/api/emails/:token', wrap(async (req, res) => {
    const token = tokenParam(req, res); if (!token) return;
    await store.deleteEmail(req.owner, token);
    cache.delete(token);
    res.json({ ok: true });
  }));

  app.post('/api/events/:id/mine', wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event.' });
    const found = await store.markEventMine(req.owner, id, req.body?.mine !== false);
    if (!found) return res.status(404).json({ error: 'Unknown event.' });
    res.json({ ok: true });
  }));

  app.get('/api/insights', wrap(async (req, res) => {
    const list = await summaries(req.owner, { limit: 200 });
    res.json(computeInsights(list, Number(req.query.tz) || 0));
  }));

  // New activity, for notifications. after_id=latest just returns the current position.
  app.get('/api/events/feed', wrap(async (req, res) => {
    const latest = await store.latestEventId(req.owner);
    if (req.query.after_id === 'latest') return res.json({ events: [], last_id: latest, latest_id: latest });
    const after = Math.max(Number(req.query.after_id) || 0, 0);
    const batch = await store.listEventsAfter(req.owner, after, 200);
    if (!batch.length) return res.json({ events: [], last_id: after, latest_id: latest });

    const tokens = [...new Set(batch.map((e) => e.token))];
    const emails = (await store.emailsByTokens(tokens)).filter((e) => e.owner === req.owner);
    const wanted = new Set(batch.map((e) => e.id));
    const out = [];
    for (const s of await summaries(req.owner, { emails })) {
      for (const ev of s.events) {
        if (wanted.has(ev.id) && ev.kind !== 'sender') {
          out.push({ ...ev, token: s.token, subject: s.subject, recipient_count: s.recipient_count, to_recipients: s.to_recipients });
        }
      }
    }
    out.sort((a, b) => a.id - b.id);
    res.json({ events: out, last_id: batch[batch.length - 1].id, latest_id: latest });
  }));

  // Emails that were never opened by the time their reminder came due.
  app.get('/api/reminders/due', wrap(async (req, res) => {
    const due = await store.dueReminders(req.owner, new Date().toISOString());
    const list = await summaries(req.owner, { emails: due });
    const out = [];
    for (const s of list) {
      if (s.status === 'opened') await store.markReminded(req.owner, s.token); // already answered, nothing to remind
      else out.push({ token: s.token, subject: s.subject, to_recipients: s.to_recipients, sent_at: s.sent_at });
    }
    res.json({ reminders: out });
  }));
  app.post('/api/emails/:token/reminded', wrap(async (req, res) => {
    const token = tokenParam(req, res); if (!token) return;
    await store.markReminded(req.owner, token);
    res.json({ ok: true });
  }));

  app.get('/api/export', wrap(async (req, res) => {
    const emails = await store.listEmails(req.owner, 5000);
    res.set('Content-Disposition', 'attachment; filename="openly-export.json"');
    res.json({ exported_at: new Date().toISOString(), emails, events: await store.listEventsByOwner(req.owner, 100000) });
  }));
  app.delete('/api/data', wrap(async (req, res) => {
    await store.deleteAll(req.owner);
    cache.clear();
    res.json({ ok: true });
  }));

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  return app;
}

module.exports = { createApp };
