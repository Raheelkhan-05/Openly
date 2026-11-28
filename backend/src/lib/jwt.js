const crypto = require('crypto');

// Checks a Supabase sign-in token on this server, with no network call to Supabase for every request.
// Returns { uid, email, exp } for a valid token, null for one that is definitely not valid, and undefined when it cannot be
// decided here (an unknown key or algorithm), so the caller can ask Supabase instead.
function createJwtVerifier({ supabaseUrl, jwtSecret = '', fetchImpl = globalThis.fetch, now = Date.now }) {
  const issuer = supabaseUrl ? supabaseUrl.replace(/\/+$/, '') + '/auth/v1' : '';
  let keys = new Map(); // kid -> public key
  let loadedAt = 0;
  let loading = null;

  async function loadKeys() {
    if (!issuer || !fetchImpl) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetchImpl(issuer + '/.well-known/jwks.json', { signal: ctrl.signal }).finally(() => clearTimeout(timer));
        const data = res.ok ? await res.json() : { keys: [] };
        const next = new Map();
        for (const jwk of data.keys || []) {
          try { next.set(jwk.kid || '', crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* unsupported key */ }
        }
        keys = next;
      } catch { /* keep the old keys */ }
      loadedAt = now();
    })().finally(() => { loading = null; });
    return loading;
  }
  async function keyFor(kid) {
    const stale = now() - loadedAt > 3600_000 || (!keys.size && now() - loadedAt > 60_000);
    if (stale || (kid && !keys.has(kid) && now() - loadedAt > 60_000)) await loadKeys();
    return keys.get(kid || '') || (keys.size === 1 && !kid ? [...keys.values()][0] : null);
  }

  return async function verify(jwt) {
    const parts = String(jwt).split('.');
    if (parts.length !== 3) return null;
    let header; let payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    } catch { return null; }
    const data = Buffer.from(parts[0] + '.' + parts[1]);
    const sig = Buffer.from(parts[2], 'base64url');

    let valid;
    if (header.alg === 'HS256') {
      if (!jwtSecret) return undefined;
      const mac = crypto.createHmac('sha256', jwtSecret).update(data).digest();
      valid = mac.length === sig.length && crypto.timingSafeEqual(mac, sig);
    } else if (header.alg === 'ES256' || header.alg === 'RS256' || header.alg === 'EdDSA') {
      const key = await keyFor(header.kid);
      if (!key) return undefined;
      if (header.alg === 'ES256') valid = crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
      else if (header.alg === 'RS256') valid = crypto.verify('RSA-SHA256', data, key, sig);
      else valid = crypto.verify(null, data, key, sig);
    } else {
      return undefined;
    }
    if (!valid) return null;

    const t = Math.floor(now() / 1000);
    const aud = [].concat(payload.aud || []);
    if (!payload.exp || payload.exp + 5 < t) return null;
    if (payload.nbf && payload.nbf - 5 > t) return null;
    if (issuer && payload.iss && payload.iss !== issuer) return null;
    if (!aud.includes('authenticated') || !payload.sub) return null;
    return { uid: payload.sub, email: payload.email || '', exp: payload.exp * 1000 };
  };
}

module.exports = { createJwtVerifier };
