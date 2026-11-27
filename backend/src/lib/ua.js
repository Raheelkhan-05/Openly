// Small user-agent reader. Good enough for "Chrome on macOS" style labels.
function parseUA(ua = '') {
  let browser = 'Unknown';
  let os = 'Unknown';
  let device = 'Unknown';

  if (/GoogleImageProxy/i.test(ua)) { browser = 'Gmail image proxy'; device = 'Hidden by proxy'; }
  else if (/YahooMailProxy/i.test(ua)) { browser = 'Yahoo image proxy'; device = 'Hidden by proxy'; }
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
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
    else if (/Mobile|iPhone|Android/i.test(ua)) device = 'Mobile';
    else if (os !== 'Unknown') device = 'Desktop';
  }
  return { browser, os, device };
}

module.exports = { parseUA };
