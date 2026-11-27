const { config, validate } = require('../src/config');
const { createStore } = require('../src/store');
const { createApp } = require('../src/app');
const { createVerifier } = require('../src/lib/verifier');

const problems = validate(config);
if (problems.length) throw new Error('Cannot start: ' + problems.join(' '));
const store = createStore(config);
module.exports = createApp({ store, config, verifyToken: config.authMode === 'supabase' ? createVerifier(store.client) : null });
