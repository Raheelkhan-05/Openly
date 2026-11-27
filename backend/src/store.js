const crypto = require('crypto');

const byTime = (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id - b.id;
const iso = (ms) => new Date(ms).toISOString();

/* ---------- In-memory store: for trying things locally and for tests ---------- */
function memoryStore() {
  const emails = new Map();
  let events = [];
  let views = [];
  let mutes = [];
  let nextId = 1;

  return {
    name: 'memory',
    async upsertEmail(e) {
      const prev = emails.get(e.token);
      const row = { id: prev?.id || crypto.randomUUID(), created_at: prev?.created_at || iso(Date.now()), reminded_at: null, ...prev, ...e };
      emails.set(e.token, row);
      return row;
    },
    async getEmail(token) { return emails.get(token) || null; },
    // Inserts a brand-new email. Returns null (and changes nothing) when the token already exists.
    async insertEmail(e) {
      if (emails.has(e.token)) return null;
      return this.upsertEmail(e);
    },
    async updateEmail(owner, token, patch) {
      const e = emails.get(token);
      if (!e || e.owner !== owner) return null;
      Object.assign(e, patch);
      return e;
    },
    async emailsByTokens(tokens) { return tokens.map((t) => emails.get(t)).filter(Boolean); },
    async listEmails(owner, limit) {
      return [...emails.values()].filter((e) => e.owner === owner).sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at)).slice(0, limit);
    },
    async deleteEmail(owner, token) {
      if (emails.get(token)?.owner !== owner) return;
      emails.delete(token);
      events = events.filter((e) => e.token !== token);
      views = views.filter((v) => v.token !== token);
    },
    async deleteAll(owner) {
      for (const [t, e] of emails) if (e.owner === owner) emails.delete(t);
      events = events.filter((e) => e.owner !== owner);
      views = views.filter((v) => v.owner !== owner);
      mutes = mutes.filter((m) => m.owner !== owner);
    },
    async addEvent(ev) {
      const row = { id: nextId++, occurred_at: iso(Date.now()), mine: false, type: 'open', link_n: null, source: 'direct', ...ev };
      events.push(row);
      return row;
    },
    async listEvents(tokens) { const s = new Set(tokens); return events.filter((e) => s.has(e.token)).sort(byTime); },
    async listEventsByOwner(owner, limit) { return events.filter((e) => e.owner === owner).sort(byTime).slice(0, limit); },
    async listEventsAfter(owner, id, limit) { return events.filter((e) => e.owner === owner && e.id > id).slice(0, limit); },
    async latestEventId(owner) { const mine = events.filter((e) => e.owner === owner); return mine.length ? mine[mine.length - 1].id : 0; },
    async markEventMine(owner, id, mine) {
      const ev = events.find((e) => e.id === id && e.owner === owner);
      if (!ev) return false;
      ev.mine = mine;
      return true;
    },
    async addSenderView(owner, token) { views.push({ owner, token, seen_at: iso(Date.now()) }); },
    async listSenderViews(tokens) { const s = new Set(tokens); return views.filter((v) => s.has(v.token)); },
    async addMute(owner, startsAt, endsAt) { mutes.push({ owner, starts_at: startsAt, ends_at: endsAt }); },
    async listMutes(owner) { return mutes.filter((m) => m.owner === owner && Date.parse(m.ends_at) > Date.now() - 30 * 864e5); },
    async clearMutes(owner) {
      const now = Date.now();
      for (const m of mutes) if (m.owner === owner && Date.parse(m.ends_at) > now) m.ends_at = iso(now);
    },
    async dueReminders(owner, nowIso) {
      return [...emails.values()]
        .filter((e) => e.owner === owner && e.remind_at && !e.reminded_at && e.remind_at <= nowIso)
        .sort((a, b) => a.remind_at.localeCompare(b.remind_at))
        .slice(0, 20);
    },
    async markReminded(owner, token) {
      const e = emails.get(token);
      if (e && e.owner === owner) e.reminded_at = iso(Date.now());
    },
  };
}

/* ---------- Supabase store ---------- */
function supabaseStore(url, key) {
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const ok = ({ data, error }) => {
    if (error) throw new Error(error.message);
    return data;
  };

  return {
    name: 'supabase',
    client: sb,
    async upsertEmail(e) { return ok(await sb.from('tracked_emails').upsert(e, { onConflict: 'token' }).select().single()); },
    async getEmail(token) { return ok(await sb.from('tracked_emails').select('*').eq('token', token).maybeSingle()); },
    async insertEmail(e) {
      const { data, error } = await sb.from('tracked_emails').insert(e).select().single();
      if (error) {
        if (error.code === '23505') return null; // token already exists
        throw new Error(error.message);
      }
      return data;
    },
    async updateEmail(owner, token, patch) {
      return ok(await sb.from('tracked_emails').update(patch).eq('token', token).eq('owner', owner).select().maybeSingle());
    },
    async emailsByTokens(tokens) {
      if (!tokens.length) return [];
      return ok(await sb.from('tracked_emails').select('*').in('token', tokens));
    },
    async listEmails(owner, limit) {
      return ok(await sb.from('tracked_emails').select('*').eq('owner', owner).order('sent_at', { ascending: false }).limit(limit));
    },
    async deleteEmail(owner, token) {
      const email = ok(await sb.from('tracked_emails').select('token').eq('token', token).eq('owner', owner).maybeSingle());
      if (!email) return;
      ok(await sb.from('email_events').delete().eq('token', token));
      ok(await sb.from('sender_views').delete().eq('token', token));
      ok(await sb.from('tracked_emails').delete().eq('token', token));
    },
    async deleteAll(owner) {
      ok(await sb.from('email_events').delete().eq('owner', owner));
      ok(await sb.from('sender_views').delete().eq('owner', owner));
      ok(await sb.from('pause_windows').delete().eq('owner', owner));
      ok(await sb.from('tracked_emails').delete().eq('owner', owner));
    },
    async addEvent(ev) { return ok(await sb.from('email_events').insert(ev).select().single()); },
    async listEvents(tokens) {
      if (!tokens.length) return [];
      return ok(await sb.from('email_events').select('*').in('token', tokens).order('occurred_at', { ascending: true }).limit(5000));
    },
    async listEventsByOwner(owner, limit) {
      return ok(await sb.from('email_events').select('*').eq('owner', owner).order('id', { ascending: true }).limit(limit));
    },
    async listEventsAfter(owner, id, limit) {
      return ok(await sb.from('email_events').select('*').eq('owner', owner).gt('id', id).order('id', { ascending: true }).limit(limit));
    },
    async latestEventId(owner) {
      const rows = ok(await sb.from('email_events').select('id').eq('owner', owner).order('id', { ascending: false }).limit(1));
      return rows[0]?.id || 0;
    },
    async markEventMine(owner, id, mine) {
      const rows = ok(await sb.from('email_events').update({ mine }).eq('id', id).eq('owner', owner).select('id'));
      return rows.length > 0;
    },
    async addSenderView(owner, token) { ok(await sb.from('sender_views').insert({ owner, token })); },
    async listSenderViews(tokens) {
      if (!tokens.length) return [];
      return ok(await sb.from('sender_views').select('*').in('token', tokens).limit(5000));
    },
    async addMute(owner, startsAt, endsAt) { ok(await sb.from('pause_windows').insert({ owner, starts_at: startsAt, ends_at: endsAt })); },
    async listMutes(owner) {
      return ok(await sb.from('pause_windows').select('*').eq('owner', owner).gte('ends_at', iso(Date.now() - 30 * 864e5)));
    },
    async clearMutes(owner) {
      const now = iso(Date.now());
      ok(await sb.from('pause_windows').update({ ends_at: now }).eq('owner', owner).gt('ends_at', now));
    },
    async dueReminders(owner, nowIso) {
      return ok(await sb.from('tracked_emails').select('*').eq('owner', owner).not('remind_at', 'is', null).is('reminded_at', null).lte('remind_at', nowIso).order('remind_at').limit(20));
    },
    async markReminded(owner, token) {
      ok(await sb.from('tracked_emails').update({ reminded_at: iso(Date.now()) }).eq('token', token).eq('owner', owner));
    },
  };
}

function createStore(config) {
  return config.driver === 'memory' ? memoryStore() : supabaseStore(config.supabaseUrl, config.supabaseKey);
}

module.exports = { createStore, memoryStore };
