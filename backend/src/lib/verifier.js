const crypto = require('crypto');
const { createJwtVerifier } = require('./jwt');

// Checks a Supabase sign-in token and returns { uid, email } (or null). The signature is checked here; Supabase is only
// asked when that is not possible (an unknown key type). Results are remembered until the token expires or for 5 minutes.
function createVerifier(supabase, { supabaseUrl = '', jwtSecret = '' } = {}) {
  const cache = new Map();
  const local = createJwtVerifier({ supabaseUrl, jwtSecret });
  return async function verify(jwt) {
    const k = crypto.createHash('sha256').update(jwt).digest('hex');
    const hit = cache.get(k);
    if (hit && hit.exp > Date.now()) return hit.user;

    let user = await local(jwt).catch(() => undefined);
    let until = user ? Math.min(user.exp, Date.now() + 5 * 60000) : 0;
    if (user === undefined) {
      const { data, error } = await supabase.auth.getUser(jwt);
      user = error || !data?.user ? null : { uid: data.user.id, email: data.user.email || '' };
      until = Date.now() + 5 * 60000;
    }
    if (!user) return null;
    if (cache.size > 2000) cache.clear();
    cache.set(k, { user: { uid: user.uid, email: user.email }, exp: until });
    return { uid: user.uid, email: user.email };
  };
}
module.exports = { createVerifier };
