const test = require('node:test');
const assert = require('node:assert/strict');
const { describeDevice } = require('../src/lib/ua');
const { summarize } = require('../src/lib/summarize');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const PROXY = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const rules = { selfViewBeforeMs: 0, selfViewAfterMs: 0, justSentMs: 15000, clickJustSentMs: 5000, applePrefetchMs: 0, sameOpenMs: 60000, burstMs: 5000, burstLinks: 3 };

test('device kinds are told apart, and proxies are never guessed', () => {
    assert.equal(describeDevice(IPHONE, 'direct', 'click').kind, 'mobile');
    assert.equal(describeDevice(WINDOWS, 'direct', 'open').kind, 'desktop');
    assert.equal(describeDevice(PROXY, 'google_proxy', 'open').label, 'Hidden by Gmail');
    assert.equal(describeDevice(IPHONE, 'apple_privacy', 'open').kind, 'hidden');
});

test('an email summary counts devices and remembers the last known one', () => {
    const email = { token: 't', subject: 's', sent_at: '2026-01-01T00:00:00Z', links: [] };
    const ev = (id, at, ua, source, type = 'open') => ({ id, occurred_at: at, user_agent: ua, source, type, ip_hash: 'x' });
    const s = summarize(email, [
        ev(1, '2026-01-01T01:00:00Z', PROXY, 'google_proxy'),
        ev(2, '2026-01-01T02:00:00Z', WINDOWS, 'direct'),
        ev(3, '2026-01-01T05:00:00Z', IPHONE, 'direct'),
    ], [], [], rules);
    assert.equal(s.device_counts.hidden, 1);
    assert.equal(s.device_counts.desktop, 1);
    assert.equal(s.device_counts.mobile, 1);
    assert.equal(s.last_device.kind, 'mobile');
});