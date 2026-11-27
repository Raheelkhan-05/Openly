const { config, validate } = require('./config');
const { createStore } = require('./store');
const { createApp } = require('./app');
const { createVerifier } = require('./lib/verifier');
const { loadAppleRanges } = require('./lib/sources');

const problems = validate(config);
if (problems.length) {
  console.error('Cannot start:\n - ' + problems.join('\n - '));
  process.exit(1);
}
const store = createStore(config);
if (store.name === 'memory') console.warn('Using the in-memory store. Data is lost when the server stops.');
const verifyToken = config.authMode === 'supabase' ? createVerifier(store.client) : null;

if (config.appleRanges) {
  loadAppleRanges()
    .then((n) => console.log(`Loaded ${n} Apple privacy network ranges.`))
    .catch((e) => console.warn('Could not load Apple ranges:', e.message));
}

createApp({ store, config, verifyToken }).listen(config.port, () => {
  console.log(`Openly backend listening on port ${config.port} (storage: ${store.name}, accounts: ${config.authMode})`);
});
