require('dotenv').config();
const crypto = require('crypto');

const env = process.env;
const apiKey = (env.API_KEY || '').trim();
const authMode = (env.AUTH_MODE || 'apikey').toLowerCase();

const config = {
  port: Number(env.PORT) || 8787,
  // "apikey": one person, one secret key (self-hosting).
  // "supabase": many people, each signs in with their own account (hosted service).
  authMode,
  apiKey,
  singleOwner: '00000000-0000-0000-0000-000000000001',
  driver: (env.DB_DRIVER || (env.SUPABASE_URL ? 'supabase' : 'memory')).toLowerCase(),
  supabaseUrl: env.SUPABASE_URL || '',
  supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
  appleRanges: env.APPLE_RANGES === 'on',
  ipSalt:
    env.IP_SALT ||
    crypto.createHash('sha256').update('openly:' + (apiKey || env.SUPABASE_SERVICE_ROLE_KEY || 'dev')).digest('hex'),
  // How events are judged (milliseconds).
  rules: {
    selfViewBeforeMs: 5000, // an image load up to 5s before a "sender looked" signal...
    selfViewAfterMs: 30000, // ...or up to 30s after it, counts as the sender
    justSentMs: 15000, // an image load this soon after sending is uncertain
    clickJustSentMs: 8000, // so is a link click this soon after sending
    applePrefetchMs: 120000, // Apple Mail may preload images right after delivery
    sameOpenMs: 60000, // image loads within a minute of each other count as one open (Gmail often loads twice)
    burstMs: 3000, // several different links hit within this window...
    burstLinks: 3, // ...by the same visitor look like a security scanner
  },
};

function validate(c) {
  const problems = [];
  if (!['apikey', 'supabase'].includes(c.authMode)) problems.push('AUTH_MODE must be "apikey" or "supabase".');
  if (c.authMode === 'apikey' && c.apiKey.length < 24) problems.push('API_KEY is missing or shorter than 24 characters.');
  if (c.authMode === 'supabase' && c.driver !== 'supabase') problems.push('AUTH_MODE=supabase needs the Supabase database (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).');
  if (c.driver === 'supabase' && (!c.supabaseUrl || !c.supabaseKey)) {
    problems.push('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when using Supabase.');
  }
  return problems;
}

module.exports = { config, validate };
