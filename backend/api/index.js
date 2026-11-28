const { config, validate } = require('../src/config');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { createVerifier } = require('../src/lib/verifier');
const { createCache } = require('../src/lib/cache');

let waitUntil = null;
try { ({ waitUntil } = require('@vercel/functions')); } catch { /* not on Vercel: background work simply continues */ }

const problems = validate(config);
if (problems.length) throw new Error('Cannot start: ' + problems.join(' '));
const store = createStore(config);
const verifyToken = config.authMode === 'supabase' ? createVerifier(store.client, { supabaseUrl: config.supabaseUrl, jwtSecret: config.jwtSecret }) : null;
module.exports = createApp({ store, config, verifyToken, cache: createCache({ url: config.redisUrl, token: config.redisToken }), waitUntil });
