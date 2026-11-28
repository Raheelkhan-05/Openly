/* Shared helpers for the popup, dashboard, service worker and Gmail script. */
globalThis.Openly = (() => {
  const CFG = globalThis.OpenlyConfig || {};
  const cloudAvailable = !!(CFG.hostedUrl && CFG.supabaseUrl && CFG.supabaseAnonKey);

  const DEFAULTS = {
    mode: cloudAvailable ? 'cloud' : 'selfhost', // "cloud": sign in with email. "selfhost": your own server and key.
    backendUrl: '',
    apiKey: '',
    signedIn: false,
    accountEmail: '',
    trackByDefault: true,
    trackClicksByDefault: false,
    remindAfterHours: 0,
    notifyOpens: true,
    notifyRepeat: false,
    notifyClicks: true,
    notifyPossible: false,
  };

  class ApiError extends Error {
    constructor(message, status, code) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }

  /* ---------- settings ---------- */
  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULTS, ...(settings || {}) };
  }
  async function saveSettings(patch) {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  }
  const normalizeBase = (u) => (u || '').trim().replace(/\/+$/, '');
  const backendOf = (s) => (s.mode === 'cloud' ? normalizeBase(CFG.hostedUrl) : normalizeBase(s.backendUrl));
  const isConfigured = (s) => (s.mode === 'cloud' ? !!(cloudAvailable && s.signedIn) : !!(backendOf(s) && (s.apiKey || '').trim()));

  /* ---------- accounts (sign in with an emailed code) ---------- */
  async function authCall(path, body) {
    let res;
    try {
      res = await fetch(normalizeBase(CFG.supabaseUrl) + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', apikey: CFG.supabaseAnonKey },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ApiError('Could not reach the sign-in service. Check your connection.', 0, 'network');
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, data };
  }
  const storeSession = (d) =>
    chrome.storage.local.set({ session: { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 } });

  async function requestCode(email) {
    const r = await authCall('/auth/v1/otp', { email: email.trim(), create_user: true });
    if (!r.ok) throw new ApiError(r.data?.msg || r.data?.error_description || 'Could not send the code. Try again in a minute.', r.status, 'auth');
  }
  async function verifyCode(email, code) {
    const r = await authCall('/auth/v1/verify', { type: 'email', email: email.trim(), token: code.trim() });
    if (!r.ok || !r.data?.access_token) throw new ApiError('That code is not right, or it has expired.', r.status, 'auth');
    await storeSession(r.data);
    await saveSettings({ mode: 'cloud', signedIn: true, accountEmail: r.data.user?.email || email.trim() });
  }
  // Signs in with the one-time value that another signed-in Openly (the extension or the add-on) made. This gets its OWN session
  // from Supabase, so two devices never share (and so never invalidate) each other's refresh token.
  async function signInWithHandoff(tokenHash) {
    const r = await authCall('/auth/v1/verify', { type: 'magiclink', token_hash: String(tokenHash).trim() });
    if (!r.ok || !r.data?.access_token) throw new ApiError('This sign-in link has expired or was already used. Open it again from the extension.', r.status, 'auth');
    await storeSession(r.data);
    await saveSettings({ mode: 'cloud', signedIn: true, accountEmail: r.data.user?.email || '' });
  }
  // The address that opens the web dashboard already signed in (works once; fine to show as a QR code for a phone).
  async function webHandoffUrl(hash = '') {
    const s = await getSettings();
    if (!isConfigured(s)) throw new ApiError('Sign in first.', 401, 'unauthorized');
    const base = backendOf(s) + '/app/';
    const tail = hash ? '&go=' + encodeURIComponent(hash) : '';
    if (s.mode === 'cloud') {
      const r = await api('/api/handoff', { method: 'POST', settings: s });
      return base + '#handoff=' + encodeURIComponent(r.token_hash) + tail;
    }
    return base + '#server=' + encodeURIComponent(backendOf(s)) + '&key=' + encodeURIComponent(s.apiKey.trim()) + tail;
  }
  // Reads a handoff out of the page address (web dashboard only). Returns where to go next, or null when there was none.
  async function consumeHandoff() {
    const h = location.hash.replace(/^#/, '');
    if (!/(^|&)(handoff|server)=/.test(h)) return null;
    const p = new URLSearchParams(h);
    history.replaceState(null, '', location.pathname); // the secret must not stay in the address bar or history
    const go = p.get('go') || '';
    if (p.get('handoff')) { await signInWithHandoff(p.get('handoff')); return go; }
    if (p.get('server') && p.get('key')) { await saveSettings({ mode: 'selfhost', backendUrl: normalizeBase(p.get('server')), apiKey: p.get('key') }); return go; }
    return null;
  }
  async function signOut() {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(['session', 'cursor', 'pending', ...Object.keys(all).filter((k) => k.startsWith('cache:'))]);
    await saveSettings({ signedIn: false, accountEmail: '' });
  }

  let refreshing = null;
  async function accessToken() {
    const { session } = await chrome.storage.local.get('session');
    if (!session) throw new ApiError('Please sign in again.', 401, 'unauthorized');
    if (session.expiresAt - Date.now() > 60000) return session.accessToken;
    refreshing ||= (async () => {
      const r = await authCall('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refreshToken });
      if (!r.ok || !r.data?.access_token) {
        await chrome.storage.local.remove('session');
        await saveSettings({ signedIn: false });
        throw new ApiError('Please sign in again.', 401, 'unauthorized');
      }
      await storeSession(r.data);
      return r.data.access_token;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  /* ---------- talking to the server ---------- */
  async function api(path, { method = 'GET', body, settings, timeout = 12000 } = {}) {
    const s = settings || (await getSettings());
    if (!isConfigured(s)) {
      throw new ApiError(s.mode === 'cloud' ? 'Sign in to start tracking.' : 'Add your server address and API key in Settings.', 0, 'not_configured');
    }
    const headers = s.mode === 'cloud' ? { authorization: 'Bearer ' + (await accessToken()) } : { 'x-api-key': s.apiKey.trim() };
    if (body) headers['content-type'] = 'application/json';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(backendOf(s) + path, { method, signal: ctrl.signal, headers, body: body ? JSON.stringify(body) : undefined });
      let data = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      if (!res.ok) throw new ApiError(data?.error || `The server answered with an error (${res.status}).`, res.status, res.status === 401 ? 'unauthorized' : 'http');
      return data;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(e.name === 'AbortError' ? 'The server took too long to answer.' : 'Could not reach the server. Check the address.', 0, 'network');
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- remembered answers: show the last list at once, then refresh it ---------- */
  const keyOf = async (name) => { const s = await getSettings(); return `cache:${s.mode}:${s.accountEmail || s.backendUrl || ''}:${name}`; };
  async function peek(name) {
    const k = await keyOf(name);
    const r = await chrome.storage.local.get(k);
    return r[k] || null; // { data, at }
  }
  async function stash(name, data) {
    const k = await keyOf(name);
    try { await chrome.storage.local.set({ [k]: { data, at: Date.now() } }); } catch { /* storage full: skip */ }
  }

  /* ---------- wording ---------- */
  const STATUS = {
    opened: { label: 'Open detected', tone: 'ok', help: 'Someone opened this email or clicked a link in it.' },
    possible: { label: 'Possible open', tone: 'warn', help: 'Something loaded this email, but it may have been a scanner or a preview. Treat it as uncertain.' },
    none: { label: 'No open detected', tone: 'idle', help: "Nothing has loaded this email yet. That doesn't mean it wasn't read: many people block images." },
  };
  const CONFIDENCE = { high: 'High', medium: 'Medium', low: 'Low' };
  function confidenceText(e) {
    if (e.confidence === 'high') return e.click_count > 0 ? 'A link was clicked, which almost always means a person.' : 'A mail app loaded the image directly.';
    if (e.confidence === 'medium') return "Gmail loaded the image for the reader. It could also be you checking your sent mail on your phone. Use 'That was me' if so.";
    if (e.confidence === 'low') return 'Only scanner-like or preloaded activity so far.';
    return '';
  }

  // Everyone the email went to, once each (an address in both To and Cc is one person).
  const everyone = (e) => [...new Set([...(e.to_recipients || []), ...(e.cc_recipients || []), ...(e.bcc_recipients || [])])];
  function recipientsLabel(e) {
    const all = everyone(e);
    if (!all.length) return 'Recipients not detected';
    const first = (e.to_recipients && e.to_recipients[0]) || all[0];
    return all.length > 1 ? `${first} and ${all.length - 1} more` : first;
  }
  /* ---------- finding an email in Gmail, and the web dashboard ---------- */
  const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
  // A Gmail search that lands on this email: sent mail, to the first recipient, with the subject and a few days around
  // the send date. Phone emails whose subject is still unknown are found by recipient and date alone.
  function gmailSearchUrl(e, account) {
    const parts = ['in:sent'];
    const first = everyone(e)[0];
    if (first) parts.push('to:' + first);
    const subject = (e.subject || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (subject && !/^\(.*\)$/.test(subject)) parts.push(`subject:"${subject}"`);
    const t = Date.parse(e.sent_at);
    if (Number.isFinite(t)) parts.push(`after:${ymd(t - 864e5)}`, `before:${ymd(t + 2 * 864e5)}`);
    const base = account && account.includes('@') ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}` : 'https://mail.google.com/mail/u/0/';
    return `${base}#search/${encodeURIComponent(parts.join(' '))}`;
  }
  // The dashboard that opens in any browser, phone included (served by your Openly server).
  const webDashboardUrl = (s, hash = '') => (s.mode === 'cloud' || backendOf(s) ? backendOf(s) + '/app/' + (hash ? '#' + hash : '') : '');

  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  const formatDate = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const formatDateSec = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const formatTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  /* ---------- tiny DOM helpers (pages only) ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const ICONS = {
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5"/><path d="M20 4v4.5h-4.5"/>',
    settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m4 7.5 8 5.5 8-5.5"/>',
    chart: '<path d="M5 20V11M12 20V5M19 20v-6"/>',
    trash: '<path d="M4 7h16M9.5 11v5.5M14.5 11v5.5M6 7l.8 11.2a1.5 1.5 0 0 0 1.5 1.3h7.4a1.5 1.5 0 0 0 1.5-1.3L18 7M9 7V4.5h6V7"/>',
    back: '<path d="m14.5 6-6 6 6 6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/>',
    external: '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 18V9a1.5 1.5 0 0 1 1.5-1.5H10"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
    logout: '<path d="M10 5H7.5A1.5 1.5 0 0 0 6 6.5v11A1.5 1.5 0 0 0 7.5 19H10M14 8l4 4-4 4M18 12H9.5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    pointer: '<path d="m9 4 1.2 11 2.3-2.6 3.3 5.2 1.8-1.1-3.2-5.1 3.6-.5z"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  };
  function svgBase(size, sw) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', sw);
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    return svg;
  }
  function icon(name, size = 18) {
    const svg = svgBase(size, '1.8');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }
  // The read-receipt mark: one tick = nothing yet, two = opened, dashed second tick = unsure.
  function tick(status, size = 20) {
    const svg = svgBase(size, '2');
    svg.setAttribute('class', `tick tick-${status}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', STATUS[status]?.label || '');
    const first = status === 'none' ? 'M6 12.5l4 4 8-9' : 'M2.5 12.5l4 4 8-9';
    svg.innerHTML = `<path d="${first}"/>` + (status === 'none' ? '' : `<path d="M10.5 15.5l1.5 1.5 9.5-10"${status === 'possible' ? ' stroke-dasharray="2.2 2.6"' : ''}/>`);
    return svg;
  }

  return {
    DEFAULTS, ApiError, cloudAvailable, getSettings, saveSettings, normalizeBase, backendOf, isConfigured,
    requestCode, verifyCode, signInWithHandoff, webHandoffUrl, consumeHandoff, peek, stash, signOut, api,
    STATUS, CONFIDENCE, confidenceText, recipientsLabel, everyone, gmailSearchUrl, webDashboardUrl, timeAgo, formatDate, formatDateSec, formatTime, h, icon, tick,
  };
})();
