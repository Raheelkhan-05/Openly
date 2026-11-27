const net = require('net');

// Where a request came from, judged from the network address and user agent.
// The address itself is never stored; only the label below.
const apple = new net.BlockList();
apple.addSubnet('17.0.0.0', 8, 'ipv4'); // Apple's own network
let appleRangeCount = 1;

function addRangesFromCsv(text) {
  let added = 0;
  for (const line of String(text).split('\n')) {
    const cidr = line.split(',')[0].trim();
    const [addr, prefix] = cidr.split('/');
    const p = Number(prefix);
    if (!addr || !Number.isInteger(p)) continue;
    try {
      apple.addSubnet(addr, p, addr.includes(':') ? 'ipv6' : 'ipv4');
      added += 1;
    } catch { /* skip bad line */ }
  }
  appleRangeCount += added;
  return added;
}

// Apple publishes the networks used by iCloud Private Relay and Mail Privacy Protection.
async function loadAppleRanges(url = 'https://mask-api.icloud.com/egress-ip-ranges.csv') {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return addRangesFromCsv(await res.text());
}

function classifySource(ip, ua) {
  if (/GoogleImageProxy/i.test(ua || '')) return 'google_proxy';
  if (/YahooMailProxy/i.test(ua || '')) return 'yahoo_proxy';
  let a = String(ip || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  const family = net.isIP(a);
  if (family && apple.check(a, family === 6 ? 'ipv6' : 'ipv4')) return 'apple_privacy';
  return 'direct';
}

module.exports = { classifySource, loadAppleRanges, addRangesFromCsv, rangeCount: () => appleRangeCount };
