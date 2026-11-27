const crypto = require('crypto');

// Checks a Supabase sign-in token and returns the person's id (or null). Results are remembered briefly.
function createVerifier(supabase) {
  const cache = new Map();
  return async function verify(jwt) {
    const k = crypto.createHash('sha256').update(jwt).digest('hex');
    const hit = cache.get(k);
    if (hit && hit.exp > Date.now()) return hit.uid;
    const { data, error } = await supabase.auth.getUser(jwt);
    if (error || !data?.user) return null;
    if (cache.size > 2000) cache.clear();
    cache.set(k, { uid: data.user.id, exp: Date.now() + 5 * 60000 });
    return data.user.id;
  };
}
module.exports = { createVerifier };
