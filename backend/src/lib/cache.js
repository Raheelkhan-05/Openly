// A small cache with two layers: memory in this process, and (optional) Redis shared by every server instance.
// Redis is Upstash's REST service (the free tier is plenty): set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
// Without Redis everything still works, but entries live only in this process and for a shorter time.
function createCache({ url = '', token = '', fetchImpl = globalThis.fetch } = {}) {
  const mem = new Map(); // key -> { v, exp }
  const redis = !!(url && token);
  const base = url.replace(/\/+$/, '');

  async function pipeline(commands) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    try {
      const res = await fetchImpl(base + '/pipeline', { method: 'POST', signal: ctrl.signal, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(commands) });
      if (!res.ok) return null;
      return (await res.json()).map((r) => r.result);
    } catch { return null; } finally { clearTimeout(timer); }
  }
  const putMem = (key, v, ttlSec) => {
    if (mem.size > 5000) mem.clear();
    mem.set(key, { v, exp: Date.now() + ttlSec * 1000 });
  };
  const getMem = (key) => {
    const h = mem.get(key);
    if (!h) return undefined;
    if (h.exp <= Date.now()) { mem.delete(key); return undefined; }
    return h.v;
  };
  const parse = (s) => { try { return s == null ? undefined : JSON.parse(s); } catch { return undefined; } };

  return {
    redis,
    async get(key) {
      const m = getMem(key);
      if (m !== undefined) return m;
      if (!redis) return undefined;
      const r = await pipeline([['GET', key]]);
      const v = r ? parse(r[0]) : undefined;
      if (v !== undefined) putMem(key, v, 60);
      return v;
    },
    async set(key, value, ttlSec) {
      putMem(key, value, redis ? Math.min(ttlSec, 60) : ttlSec);
      if (redis) await pipeline([['SET', key, JSON.stringify(value), 'EX', String(ttlSec)]]);
    },
    async del(key) {
      mem.delete(key);
      if (redis) await pipeline([['DEL', key]]);
    },
    // A stored answer plus a counter that says whether it is out of date. Both come back in ONE round trip.
    async readVersioned(verKey, dataKey) {
      if (redis) {
        const r = await pipeline([['MGET', verKey, dataKey]]);
        if (r && Array.isArray(r[0])) return { ver: Number(r[0][0]) || 0, entry: parse(r[0][1]) };
      }
      return { ver: Number(getMem(verKey)) || 0, entry: getMem(dataKey) };
    },
    async writeVersioned(dataKey, entry, ttlSec) {
      putMem(dataKey, entry, redis ? 15 : 10);
      if (redis) await pipeline([['SET', dataKey, JSON.stringify(entry), 'EX', String(ttlSec)]]);
    },
    async bump(verKey) {
      putMem(verKey, (Number(getMem(verKey)) || 0) + 1, 86400);
      if (redis) await pipeline([['INCR', verKey], ['EXPIRE', verKey, '86400']]);
    },
    clearLocal() { mem.clear(); },
  };
}
module.exports = { createCache };
