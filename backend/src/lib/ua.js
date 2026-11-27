// Small user-agent reader. Good enough for "Chrome on macOS" style labels.
function parseUA(ua = '') {
  let browser = 'Unknown';
  let os = 'Unknown';
  let device = 'Unknown';

  if (/GoogleImageProxy/i.test(ua)) { browser = 'Gmail image proxy'; device = 'Hidden by proxy'; }
  else if (/YahooMailProxy/i.test(ua)) { browser = 'Yahoo image proxy'; device = 'Hidden by proxy'; }
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Outlook/i.test(ua)) browser = 'Outlook';
  else if (/Thunderbird/i.test(ua)) browser = 'Thunderbird';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else if (/AppleWebKit/.test(ua)) browser = 'Apple Mail';

  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod|iOS/.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  if (device === 'Unknown' && ua) {
    if (/iPad|Tablet/i.test(ua)) device = 'Tablet';
    else if (/Mobile|iPhone|iPod|Android/i.test(ua)) device = 'Mobile';
    else if (os !== 'Unknown') device = 'Desktop';
  }
  return { browser, os, device };
}

/**
 * A plain-language description of where one request came from.
 *   kind   - mobile | tablet | desktop | hidden | unknown
 *   label  - what to show ("Mobile phone", "Desktop / laptop", "Hidden by Gmail"...)
 *   detail - "Chrome on Windows"
 *   basis  - how sure we can be: a link click and a direct image load show the reader's real device,
 *            a proxy hides it, so the kind is "hidden" and nothing is guessed.
 */
function describeDevice(ua = '', source = 'direct', type = 'open') {
  const info = parseUA(ua);
  const detail = [info.browser, info.os].filter((x) => x && x !== 'Unknown').join(' on ');
  const hidden = (label) => ({ kind: 'hidden', label, detail: '', basis: 'hidden' });

  if (source === 'apple_privacy') return hidden('Hidden by Apple Mail privacy');
  if (source === 'google_proxy' || /GoogleImageProxy/i.test(ua)) return hidden('Hidden by Gmail');
  if (source === 'yahoo_proxy' || /YahooMailProxy/i.test(ua)) return hidden('Hidden by Yahoo Mail');

  const basis = type === 'click' ? 'link click' : 'image load';
  switch (info.device) {
    case 'Mobile': return { kind: 'mobile', label: 'Mobile phone', detail, basis };
    case 'Tablet': return { kind: 'tablet', label: 'Tablet', detail, basis };
    case 'Desktop': return { kind: 'desktop', label: 'Desktop / laptop', detail, basis };
    default: return { kind: 'unknown', label: 'Device unknown', detail, basis };
  }
}

module.exports = { parseUA, describeDevice };