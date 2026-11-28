/* The Openly dashboard. Runs inside the Chrome extension and, unchanged, as the web dashboard (phones included). */
(() => {
  const O = Openly;
  const { h, icon, tick } = O;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const IS_WEB = document.documentElement.dataset.web === '1';
  const DAY = 864e5;

  const state = {
    emails: [], loaded: false, error: null, stale: false, updatedAt: 0,
    filter: 'all', sort: 'sent', range: 0, query: '',
    selected: null, detail: null, detailError: null, view: 'emails', seen: new Map(), fresh: new Set(), account: '',
  };
  const detailMemo = new Map(); // token -> { at, data }

  /* ---------- small helpers ---------- */
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const subjectOf = (e) => e.subject || '(no subject)';
  const toneOf = (status) => (status === 'opened' ? 'opened' : status === 'possible' ? 'possible' : 'none');
  const when = (iso) => `${O.timeAgo(iso)} · ${O.formatDate(iso)}`;
  function duration(min) {
    if (min == null) return '–';
    if (min < 1) return 'under a minute';
    if (min < 60) return `${Math.round(min)} min`;
    if (min < 1440) { const hh = Math.floor(min / 60); const mm = Math.round(min % 60); return mm ? `${hh} h ${mm} min` : `${hh} h`; }
    return plural(Math.round(min / 1440), 'day');
  }
  function toast(text, tone = '') {
    const el = h('div', { class: 'toast ' + tone, role: 'status' }, text);
    $('#toasts').append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 2600);
  }
  // replaceChildren would print the word "null" for a missing piece; this skips those.
  const put = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  const msgEl = () => h('p', { class: 'inline-msg', role: 'status' });
  const say = (el, text, tone = '') => { el.textContent = text; el.className = 'inline-msg ' + tone; };
  // A button that asks twice before doing something that can't be undone.
  function confirmButton(label, sure, iconName, action, cls = 'btn danger') {
    let armed = null;
    const b = h('button', { class: cls, type: 'button' }, iconName ? icon(iconName, 16) : null, label);
    const reset = () => { armed = null; b.className = cls; b.replaceChildren(...(iconName ? [icon(iconName, 16)] : []), label); };
    b.addEventListener('click', async () => {
      if (!armed) {
        b.className = cls + ' confirm'; b.replaceChildren(sure);
        armed = setTimeout(reset, 4000);
        return;
      }
      clearTimeout(armed); b.disabled = true;
      try { await action(); } catch (e) { toast(e.message, 'bad'); }
      b.disabled = false; reset();
    });
    return b;
  }

  /* ---------- signing in (the gate) ---------- */
  function showGate(note) {
    document.body.dataset.gate = '1';
    $('#gate').hidden = false;
    renderGate(note);
  }
  function hideGate() { delete document.body.dataset.gate; $('#gate').hidden = true; }

  async function renderGate(note) {
    const s = await O.getSettings();
    const body = $('#gateBody');
    const foot = $('#gateFoot');
    const own = s.mode === 'selfhost' || !O.cloudAvailable;
    $('#gateTitle').textContent = own ? 'Connect your own server' : 'Know when your email is read.';
    $('#gateLead').textContent = own
      ? 'Enter the address of your Openly server and its API key. Your data stays on your server.'
      : 'Sign in with your email. We send a six-digit code, so there is no password to remember.';
    body.replaceChildren(own ? selfHostForm(s, finishSignIn) : cloudForm(finishSignIn, note));
    foot.replaceChildren();
    if (O.cloudAvailable) {
      foot.append(own ? 'Prefer the hosted version? ' : 'Running your own server? ',
        h('button', { type: 'button', onclick: async () => { await O.saveSettings({ mode: own ? 'cloud' : 'selfhost' }); renderGate(); } }, own ? 'Sign in with email' : 'Connect it'));
    }
  }
  async function finishSignIn() {
    hideGate();
    state.loaded = false; state.emails = []; detailMemo.clear();
    await renderAccount(); flagSettings();
    await refresh();
    route();
  }

  function cloudForm(done, note) {
    const msg = msgEl();
    if (note) say(msg, note, 'bad');
    const email = h('input', { class: 'input', id: 'signEmail', type: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true, autofocus: true });
    const code = h('input', { class: 'input code-input', id: 'signCode', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '······', maxlength: '8', pattern: '[0-9]*', 'aria-label': 'Code from your email' });
    const step1 = h('form', { class: 'step' });
    const step2 = h('form', { class: 'step', hidden: true });
    const send = h('button', { class: 'btn primary', type: 'submit' }, 'Email me a code');
    const verify = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const again = h('button', { class: 'btn ghost', type: 'button' }, 'Use another email');
    step1.append(h('div', { class: 'field' }, h('label', { for: 'signEmail' }, 'Email'), email), send);
    step2.append(h('div', { class: 'field' }, h('label', { for: 'signCode' }, 'Code from your email'), code), h('div', { class: 'actions' }, verify, again));
    let cooldown = null;
    step1.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!email.value.trim() || !email.validity.valid) return say(msg, 'Enter a valid email address.', 'bad');
      send.disabled = true; say(msg, 'Sending…');
      try {
        await O.requestCode(email.value);
        say(msg, `We sent a code to ${email.value.trim()}. Check spam if it isn't there in a minute.`, 'ok');
        step1.hidden = true; step2.hidden = false; code.focus();
      } catch (e) { say(msg, e.message, 'bad'); }
      send.disabled = false;
    });
    step2.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (!code.value.trim()) return say(msg, 'Enter the code from your email.', 'bad');
      verify.disabled = true; say(msg, 'Checking…');
      try { await O.verifyCode(email.value, code.value); clearTimeout(cooldown); await done(); }
      catch (e) { say(msg, e.message, 'bad'); verify.disabled = false; code.select(); }
    });
    again.addEventListener('click', () => { step2.hidden = true; step1.hidden = false; code.value = ''; say(msg, ''); email.focus(); });
    return h('div', {}, step1, step2, msg);
  }

  function selfHostForm(s, done) {
    const msg = msgEl();
    const url = h('input', { class: 'input', id: 'backendUrl', type: 'url', placeholder: 'https://your-server.example.com', autocomplete: 'off', spellcheck: 'false' });
    const key = h('input', { class: 'input', id: 'apiKey', type: 'password', autocomplete: 'off', spellcheck: 'false' });
    url.value = s.backendUrl; key.value = s.apiKey;
    const draft = () => ({ ...s, mode: 'selfhost', backendUrl: O.normalizeBase(url.value), apiKey: key.value.trim() });
    const problem = (d) => (!d.backendUrl ? 'Enter your server address.' : !/^https?:\/\//i.test(d.backendUrl) ? 'The address must start with https://' : !d.apiKey ? 'Enter your API key.' : null);
    const show = h('button', { class: 'btn', type: 'button', onclick: (e) => { key.type = key.type === 'password' ? 'text' : 'password'; e.currentTarget.textContent = key.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    const form = h('form', { class: 'step selfhost' });
    const test = h('button', {
      class: 'btn', type: 'button', onclick: async () => {
        const d = draft(); const p = problem(d);
        if (p) return say(msg, p, 'bad');
        say(msg, 'Testing…');
        try {
          const r = await O.api('/api/ping', { settings: d, timeout: 8000 });
          const local = !/^https:\/\//i.test(d.backendUrl) || /^https:\/\/(localhost|127\.)/i.test(d.backendUrl);
          say(msg, `Connected. Storing data in ${r.storage}.` + (local ? ' This address is not public, so recipients will not be able to load the tracking image.' : ''), local ? '' : 'ok');
        } catch (e) { say(msg, e.message, 'bad'); }
      },
    }, 'Test connection');
    form.append(
      h('div', { class: 'field' }, h('label', { for: 'backendUrl' }, 'Server address'), url),
      h('div', { class: 'field' }, h('label', { for: 'apiKey' }, 'API key'), h('div', { class: 'row-inline' }, key, show)),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save and continue'), test));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const d = draft(); const p = problem(d);
      if (p) return say(msg, p, 'bad');
      await O.saveSettings({ mode: 'selfhost', backendUrl: d.backendUrl, apiKey: d.apiKey });
      toast('Settings saved'); await done();
    });
    return h('div', {}, form, msg);
  }

  /* ---------- loading data: show the saved copy at once, then refresh it ---------- */
  async function refresh({ silent = false } = {}) {
    const s = await O.getSettings();
    if (!O.isConfigured(s)) { showGate(); return; }
    hideGate();
    if (!state.loaded) {
      const cached = await O.peek('emails');
      if (cached?.data) { state.emails = cached.data; state.loaded = true; state.stale = true; state.updatedAt = cached.at; renderEmails(); }
    }
    try {
      const { emails } = await O.api('/api/emails?limit=200');
      // Mark what changed since the last look, so new opens can be noticed.
      state.fresh = new Set();
      if (state.seen.size) {
        for (const e of emails) {
          const was = state.seen.get(e.token);
          if (was !== undefined && was !== e.open_count + e.click_count) state.fresh.add(e.token);
        }
      }
      state.seen = new Map(emails.map((e) => [e.token, e.open_count + e.click_count]));
      const changed = JSON.stringify(emails) !== JSON.stringify(state.emails);
      state.emails = emails; state.error = null; state.stale = false; state.loaded = true; state.updatedAt = Date.now();
      if (changed) O.stash('emails', emails);
      if (changed || !silent) renderEmails();
      else renderFreshness();
      if (state.selected && changed) loadDetail(state.selected, { quiet: true });
    } catch (e) {
      if (e.code === 'unauthorized') { showGate('Your session ended. Sign in again to continue.'); return; }
      state.error = e.message; state.loaded = true;
      renderEmails();
    }
  }

  async function loadDetail(token, { quiet = false } = {}) {
    const memo = detailMemo.get(token);
    if (memo && Date.now() - memo.at < 15000 && !quiet) { state.detail = memo.data; state.detailError = null; renderDetail(); return; }
    if (!quiet) { state.detail = null; state.detailError = null; renderDetail(); }
    try {
      const { email } = await O.api('/api/emails/' + token);
      detailMemo.set(token, { at: Date.now(), data: email });
      if (state.selected !== token) return;
      state.detail = email; state.detailError = null; renderDetail();
    } catch (e) {
      if (state.selected !== token) return;
      if (e.code === 'unauthorized') return showGate('Your session ended. Sign in again to continue.');
      state.detailError = e.status === 404 ? 'This email is no longer tracked. It may have been deleted.' : e.message;
      renderDetail();
    }
  }
  let hoverTimer = null;
  function prefetch(token) {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(async () => {
      const memo = detailMemo.get(token);
      if (memo && Date.now() - memo.at < 15000) return;
      try { const { email } = await O.api('/api/emails/' + token); detailMemo.set(token, { at: Date.now(), data: email }); } catch { /* the click will show the error */ }
    }, 140);
  }

  /* ---------- the list ---------- */
  const inRange = (e) => !state.range || Date.now() - Date.parse(e.sent_at) < state.range * DAY;
  function matches(e) {
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return subjectOf(e).toLowerCase().includes(q) || O.everyone(e).some((a) => a.includes(q));
  }
  function visible() {
    let list = state.emails.filter(inRange).filter(matches);
    if (state.filter !== 'all') list = list.filter((e) => e.status === state.filter);
    const bySent = (a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at);
    if (state.sort === 'seen') list.sort((a, b) => (Date.parse(b.last_open_at) || 0) - (Date.parse(a.last_open_at) || 0) || bySent(a, b));
    else if (state.sort === 'opens') list.sort((a, b) => b.open_count + b.click_count - (a.open_count + a.click_count) || bySent(a, b));
    else list.sort(bySent);
    return list;
  }
  function dayLabel(iso) {
    const d = new Date(iso); const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / DAY);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return 'This week';
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth()) return 'Earlier this month';
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  function activityText(e) {
    if (e.status === 'opened') {
      const bits = [];
      if (e.open_count) bits.push(`Opened ${e.open_count}×`);
      if (e.click_count) bits.push(e.open_count ? plural(e.click_count, 'click') : `Clicked ${e.click_count}×`);
      if (e.last_open_at) bits.push(O.timeAgo(e.last_open_at));
      if (e.last_device?.label) bits.push(e.last_device.label);
      return bits.join(' · ');
    }
    if (e.status === 'possible') return 'Possible open · unconfirmed';
    return 'Not opened';
  }

  function renderMetrics() {
    const base = state.emails.filter(inRange);
    const n = (st) => base.filter((e) => e.status === st).length;
    const opened = n('opened');
    const stale = base.filter((e) => e.status === 'none' && Date.now() - Date.parse(e.sent_at) > 3 * DAY).length;
    const week = state.emails.filter((e) => Date.now() - Date.parse(e.sent_at) < 7 * DAY).length;
    const items = [
      ['all', 'All', base.length, `${week} this week`, 'all'],
      ['opened', 'Opened', opened, base.length ? `${Math.round((opened / base.length) * 100)}% rate` : '', 'opened'],
      ['possible', 'Possible', n('possible'), 'unconfirmed', 'possible'],
      ['none', 'Not opened', n('none'), stale ? `${stale} over 3 days` : '', 'none'],
    ];
    $('#metrics').replaceChildren(...items.map(([key, label, count, sub, tone]) =>
      h('button', { class: 'metric', type: 'button', 'data-tone': tone, 'aria-pressed': String(state.filter === key), onclick: () => { state.filter = key; renderEmails(); } },
        h('span', { class: 'metric-n' }, count), h('span', { class: 'metric-l' }, label), h('span', { class: 'metric-s' }, sub))));

    const att = $('#attention');
    att.hidden = !(stale && state.filter !== 'none');
    if (!att.hidden) {
      att.replaceChildren(h('span', {}, `${plural(stale, 'email')} sent over 3 days ago still ${stale === 1 ? 'has' : 'have'} no open.`),
        h('button', { type: 'button', onclick: () => { state.filter = 'none'; state.sort = 'sent'; $('#sortBy').value = 'sent'; renderEmails(); } }, 'Show'));
    }
    const nc = $('#navCount');
    nc.hidden = !state.emails.length;
    nc.textContent = state.emails.length;
  }

  function renderFreshness() {
    const el = $('#freshness');
    if (!state.loaded) { el.textContent = 'Loading…'; return; }
    if (state.error) { el.textContent = state.updatedAt ? `Offline. Showing the copy from ${O.timeAgo(new Date(state.updatedAt).toISOString())}.` : 'Could not load.'; return; }
    if (state.stale) { el.textContent = 'Refreshing…'; return; }
    const sec = Math.round((Date.now() - state.updatedAt) / 1000);
    el.textContent = sec < 10 ? 'Up to date' : sec < 90 ? `Updated ${sec}s ago` : `Updated ${O.timeAgo(new Date(state.updatedAt).toISOString())}`;
  }

  function row(e) {
    const el = h('button', { class: 'row' + (state.selected === e.token ? ' selected' : '') + (state.fresh.has(e.token) ? ' fresh' : ''), type: 'button', 'data-token': e.token, 'data-status': e.status, 'aria-current': state.selected === e.token ? 'true' : null,
      onclick: () => select(e.token), onpointerenter: () => prefetch(e.token), onfocus: () => prefetch(e.token) },
      tick(e.status, 20),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-subject' }, subjectOf(e)),
        h('span', { class: 'row-to' }, O.recipientsLabel(e)),
        h('span', { class: 'row-act' }, activityText(e))),
      h('span', { class: 'row-time', title: O.formatDate(e.sent_at) }, O.timeAgo(e.sent_at)));
    return el;
  }

  function renderList() {
    const list = $('#list');
    if (!state.loaded) {
      list.replaceChildren(...Array.from({ length: 7 }, () => h('li', { class: 'skel-row' }, h('div', { class: 'skeleton', style: 'height:14px;width:62%' }), h('div', { class: 'skeleton', style: 'height:11px;width:40%' }), h('div', { class: 'skeleton', style: 'height:11px;width:30%' }))));
      return;
    }
    if (state.error && !state.emails.length) {
      list.replaceChildren(h('li', { class: 'empty' }, h('h3', {}, "Can't reach your server"), h('p', {}, state.error), h('button', { class: 'btn', type: 'button', onclick: () => refresh() }, 'Try again')));
      return;
    }
    const items = visible();
    if (!items.length) {
      const filtered = state.emails.length > 0;
      list.replaceChildren(h('li', { class: 'empty' },
        h('h3', {}, filtered ? 'Nothing matches' : 'No tracked emails yet'),
        h('p', {}, filtered ? 'Try another filter, a longer time range, or clear the search.' : 'Write an email in Gmail with tracking on. It appears here the moment you send it, and again each time it is opened.'),
        filtered ? h('button', { class: 'btn small', type: 'button', onclick: () => { state.filter = 'all'; state.query = ''; state.range = 0; $('#search').value = ''; $('#range').value = '0'; renderEmails(); } }, 'Clear filters') : null));
      return;
    }
    const nodes = [];
    let last = null;
    for (const e of items) {
      if (state.sort === 'sent') {
        const g = dayLabel(e.sent_at);
        if (g !== last) { nodes.push(h('li', { class: 'group-title', 'aria-hidden': 'true' }, g)); last = g; }
      }
      nodes.push(h('li', {}, row(e)));
    }
    list.replaceChildren(...nodes);
  }

  function renderEmails() {
    renderMetrics(); renderList(); renderFreshness();
    if (!state.selected) renderDetail();
  }

  /* ---------- choosing an email ---------- */
  function select(token, { fromHash = false } = {}) {
    state.selected = token;
    $('#split').dataset.mode = 'detail';
    if (!fromHash) history.replaceState(null, '', '#email=' + token);
    $$('.row', $('#list')).forEach((r) => { const on = r.dataset.token === token; r.classList.toggle('selected', on); on ? r.setAttribute('aria-current', 'true') : r.removeAttribute('aria-current'); });
    const known = state.emails.find((e) => e.token === token);
    const memo = detailMemo.get(token);
    state.detail = memo?.data || null; state.detailError = null;
    renderDetail(known);
    loadDetail(token);
  }
  function closeDetail() {
    state.selected = null; state.detail = null;
    $('#split').dataset.mode = 'list';
    history.replaceState(null, '', location.pathname + location.search);
    $$('.row.selected', $('#list')).forEach((r) => r.classList.remove('selected'));
    renderDetail();
  }

  /* ---------- the detail of one email ---------- */
  const FLAG_TEXT = { image_proxy: 'Via an image proxy', just_sent: 'Right after sending', preload: 'Preloaded', scanner: 'Scanner', burst: 'Part of a burst' };
  const DEVICE_COLORS = { mobile: 'w-mobile', desktop: 'w-desktop', tablet: 'w-tablet', hidden: 'w-hidden', unknown: 'w-unknown' };
  const DEVICE_NAMES = { mobile: 'Phone', desktop: 'Computer', tablet: 'Tablet', hidden: 'Hidden by the mail app', unknown: 'Unknown' };

  function verdictOf(e) {
    const sent = `Sent ${O.timeAgo(e.sent_at)}`;
    if (e.status === 'opened') {
      const title = e.open_count ? `Opened ${plural(e.open_count, 'time')}` : `${plural(e.click_count, 'link click')}`;
      const bits = [];
      if (e.first_open_at) bits.push(`First ${O.timeAgo(e.first_open_at)}` + (e.first_open_at !== e.last_open_at && e.last_open_at ? `, last ${O.timeAgo(e.last_open_at)}` : ''));
      if (e.last_device?.label) bits.push(`on ${e.last_device.label}`);
      return { title, line: bits.join(' · ') || sent };
    }
    if (e.status === 'possible') return { title: 'Possible open', line: 'Something loaded this email, but it may have been a scanner or a preview. It is not counted as read.' };
    return { title: 'Not opened yet', line: `${sent}. Nothing has loaded it. Many people block images, so this doesn't prove it wasn't read.` };
  }

  function eventRow(ev) {
    const tone = ev.kind === 'recipient' ? 'opened' : ev.kind === 'possible' ? 'possible' : 'none';
    const title = ev.kind === 'sender' ? (ev.type === 'click' ? 'You clicked a link' : 'You viewed it')
      : ev.type === 'click' ? 'Clicked a link' : ev.open_index ? `Opened (#${ev.open_index})` : 'Image loaded';
    const tags = [...(ev.flags || []).map((f) => FLAG_TEXT[f] || f.replace(/_/g, ' ')), ev.same_open ? 'Same open' : null, ev.marked_mine ? 'Marked as you' : null].filter(Boolean);
    const detail = [ev.link_url ? ev.link_url : null, ev.device_label && ev.device_kind !== 'unknown' ? [ev.device_label, ev.device_detail].filter(Boolean).join(', ') : null].filter(Boolean);
    const canMark = ev.kind !== 'sender' || ev.marked_mine;
    return h('li', { class: 'event' + (ev.same_open ? ' dup' : '') },
      tick(tone, 20),
      h('div', {},
        h('div', { class: 'event-title' }, title, ...tags.map((t) => h('span', { class: 'tag' }, t))),
        h('div', { class: 'event-when', title: O.formatDateSec(ev.occurred_at) }, `${O.formatDateSec(ev.occurred_at)} · ${O.timeAgo(ev.occurred_at)}`),
        ev.reason && ev.kind !== 'sender' ? h('div', { class: 'event-detail' }, ev.reason) : null,
        detail.length ? h('div', { class: 'event-detail' }, detail.join(' · ')) : null),
      canMark ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => markMine(ev) }, ev.marked_mine ? 'Not me' : 'That was me') : h('span'));
  }
  async function markMine(ev) {
    try {
      await O.api(`/api/events/${ev.id}/mine`, { method: 'POST', body: { mine: !ev.marked_mine } });
      detailMemo.delete(state.selected);
      toast(ev.marked_mine ? 'Counted as the recipient again' : 'Marked as you. It no longer counts.');
      await Promise.all([loadDetail(state.selected, { quiet: true }), refresh({ silent: true })]);
    } catch (e) { toast(e.message, 'bad'); }
  }

  function renderDetail(known) {
    const pane = $('#detail');
    if (!state.selected) {
      pane.replaceChildren(h('div', { class: 'placeholder' },
        tick('opened', 34),
        h('h3', {}, 'Pick an email'),
        h('p', {}, 'You will see whether it was opened, how many times, when, and on what kind of device.'),
        h('p', {}, h('kbd', {}, '↑'), ' ', h('kbd', {}, '↓'), ' to move through the list.')));
      return;
    }
    const e = state.detail || known || state.emails.find((x) => x.token === state.selected);
    const back = h('button', { class: 'btn ghost back', type: 'button', onclick: closeDetail }, icon('back', 18), 'All emails');
    if (!e) {
      pane.replaceChildren(h('div', { class: 'detail' }, back,
        state.detailError ? h('div', { class: 'empty' }, h('h3', {}, 'Not available'), h('p', {}, state.detailError)) : h('div', { class: 'skeleton', style: 'height:28px;width:70%' })));
      return;
    }
    const full = !!state.detail && Array.isArray(state.detail.events);
    const v = verdictOf(e);
    const tone = toneOf(e.status);
    const people = O.everyone(e);
    const el = h('div', { class: 'detail' }, back,
      h('header', { class: 'd-head' },
        h('h2', {}, subjectOf(e)),
        h('p', { class: 'd-meta' }, `Sent ${O.formatDate(e.sent_at)} · ${O.recipientsLabel(e)}`),
        h('div', { class: 'd-actions' },
          h('a', { class: 'btn', href: O.gmailSearchUrl(e, state.account), target: '_blank', rel: 'noopener', title: 'Searches your Gmail Sent mail for this email' }, icon('external', 16), 'Find in Gmail'))),

      h('div', { class: 'verdict', 'data-tone': tone },
        tick(e.status, 26),
        h('div', {},
          h('div', { class: 'verdict-title' }, v.title),
          h('div', { class: 'verdict-line' }, v.line),
          e.confidence ? h('div', { class: 'verdict-conf' }, h('b', {}, `${O.CONFIDENCE[e.confidence]} confidence. `), O.confidenceText(e)) : null)),

      h('dl', { class: 'facts' },
        fact('Opens', e.open_count),
        fact('Link clicks', e.click_count),
        fact('First opened', e.first_open_at ? O.timeAgo(e.first_open_at) : '–', true, e.first_open_at ? `after ${duration((Date.parse(e.first_open_at) - Date.parse(e.sent_at)) / 60000)}` : ''),
        fact('Last opened', e.last_open_at ? O.timeAgo(e.last_open_at) : '–', true, e.last_open_at ? O.formatTime(e.last_open_at) : '')),

      people.length > 1 ? note(`Sent to ${people.length} people with one tracking image. Openly can tell that it was opened, but not by which of them.`) : null,
      e.distinct_devices > 1 ? note(`Opened from ${e.distinct_devices} different devices. If you wrote to one person, it may have been forwarded or opened on more than one device.`) : null,

      whereBlock(e),
      h('h3', { class: 'section-title' }, h('span', {}, 'Activity'), full ? h('span', { class: 'num' }, plural(e.events.filter((x) => x.kind !== 'sender').length, 'event')) : null),
      full ? activityBlock(e) : h('div', { class: 'skeleton', style: 'height:64px' }),

      h('h3', { class: 'section-title' }, h('span', {}, 'Recipients')),
      h('div', { class: 'people' }, ...[['To', e.to_recipients], ['Cc', e.cc_recipients], ['Bcc', e.bcc_recipients]].filter(([, l]) => l?.length).map(([k, l]) => h('div', { class: 'person-row' }, h('span', {}, k), h('div', { class: 'chips' }, ...l.map((a) => h('span', { class: 'chip' }, a)))))),
      !people.length ? h('p', { class: 'empty-line' }, 'No recipients were detected for this email.') : null,

      e.link_count ? linksBlock(e) : null,

      h('div', { class: 'danger-zone' },
        h('span', { class: 'token', title: 'Tracking id' }, e.token),
        confirmButton('Delete', 'Click again to delete', 'trash', async () => {
          await O.api('/api/emails/' + e.token, { method: 'DELETE' });
          state.emails = state.emails.filter((x) => x.token !== e.token); detailMemo.delete(e.token); O.stash('emails', state.emails);
          closeDetail(); renderEmails(); toast('Deleted');
        })));
    pane.replaceChildren(el);
  }
  const fact = (label, value, small = false, sub = '') => h('div', {}, h('dt', {}, label), h('dd', { class: small ? 'small' : '' }, value, sub ? h('div', { class: 'hint' }, sub) : null));
  const note = (text) => h('div', { class: 'note' }, icon('info', 16), h('span', {}, text));

  function whereBlock(e) {
    const dc = e.device_counts || {};
    const total = Object.values(dc).reduce((a, b) => a + b, 0);
    if (!total) return null;
    const keys = Object.keys(DEVICE_NAMES).filter((k) => dc[k]);
    return h('div', {}, h('h3', { class: 'section-title' }, h('span', {}, 'Where it was read')),
      h('div', { class: 'where' },
        h('div', { class: 'where-bar', role: 'img', 'aria-label': keys.map((k) => `${DEVICE_NAMES[k]} ${dc[k]}`).join(', ') }, ...keys.map((k) => h('span', { class: DEVICE_COLORS[k], style: `flex:${dc[k]}` }))),
        h('div', { class: 'where-legend' }, ...keys.map((k) => h('span', {}, h('i', { class: DEVICE_COLORS[k] }), `${DEVICE_NAMES[k]} ${dc[k]}`)))));
  }

  function activityBlock(e) {
    const mine = e.events.filter((x) => x.kind === 'sender');
    const rest = e.events.filter((x) => x.kind !== 'sender').slice().reverse();
    return h('div', {},
      rest.length ? h('ol', { class: 'timeline' }, ...rest.map(eventRow)) : h('p', { class: 'empty-line' }, 'Nothing has loaded this email yet.'),
      mine.length ? h('details', { class: 'excluded' }, h('summary', {}, `${plural(mine.length, 'view')} by you, not counted`), h('ol', { class: 'timeline' }, ...mine.slice().reverse().map(eventRow))) : null);
  }

  function linksBlock(e) {
    const clicked = e.clicked_links || [];
    return h('div', {}, h('h3', { class: 'section-title' }, h('span', {}, 'Tracked links'), h('span', { class: 'num' }, `${clicked.length} of ${e.link_count} clicked`)),
      clicked.length ? h('ul', { class: 'links' }, ...clicked.map((l) => h('li', {}, icon('pointer', 15), h('span', { class: 'event-link', title: l.url || '' }, l.url || `Link ${l.n}`), h('span', { class: 'row-count' }, plural(l.count, 'click')))))
        : h('p', { class: 'empty-line' }, `${plural(e.link_count, 'link')} in this email ${e.link_count === 1 ? 'is' : 'are'} tracked. None has been clicked.`));
  }

  /* ---------- insights ---------- */
  async function renderInsights() {
    const box = $('#insights');
    const cached = await O.peek('insights');
    if (cached?.data) paintInsights(box, cached.data); else box.replaceChildren(h('div', { class: 'skeleton', style: 'height:96px' }), h('div', { class: 'skeleton', style: 'height:180px' }));
    try {
      const data = await O.api('/api/insights?tz=' + new Date().getTimezoneOffset());
      O.stash('insights', data);
      if (state.view === 'insights') paintInsights(box, data);
    } catch (e) { if (!cached) box.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, "Can't load insights"), h('p', {}, e.message))); }
  }
  function bars(values, labelFor, tipFor) {
    const max = Math.max(1, ...values); const top = values.indexOf(Math.max(...values));
    return h('div', { class: 'chart' },
      h('div', { class: 'bars' }, ...values.map((v, i) => h('div', { class: 'bar-col', title: tipFor(i, v) }, h('div', { class: 'bar' + (v && i === top ? ' top' : ''), style: `height:${Math.max((v / max) * 100, v ? 4 : 1)}%;animation-delay:${i * 12}ms` })))),
      h('div', { class: 'bar-labels' }, ...values.map((_, i) => h('span', {}, labelFor(i)))));
  }
  function paintInsights(box, d) {
    if (!d.total) { box.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Nothing to analyse yet'), h('p', {}, 'Insights appear once you have tracked a few emails.'))); return; }
    const hour = d.hours.indexOf(Math.max(...d.hours));
    const day = d.weekdays.indexOf(Math.max(...d.weekdays));
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const h12 = (n) => `${n % 12 || 12} ${n < 12 ? 'am' : 'pm'}`;
    const never = state.emails.filter((e) => e.status === 'none').length;
    const recent = state.emails.filter((e) => e.status === 'opened' && e.last_open_at).sort((a, b) => Date.parse(b.last_open_at) - Date.parse(a.last_open_at)).slice(0, 6);
    put(box,
      h('div', { class: 'tiles' },
        tile(d.open_rate == null ? '–' : `${Math.round(d.open_rate * 100)}%`, 'Open rate', `${d.opened} of ${d.total} emails`),
        tile(d.median_minutes_to_first_open == null ? '–' : duration(d.median_minutes_to_first_open), 'Typical time to first open', 'The middle value, so one slow reply does not skew it'),
        tile(d.clicked, 'Emails with a link click', 'Clicks are the strongest sign of a real reader'),
        tile(never, 'Not opened', never ? 'Worth a follow-up if it matters' : 'Everything has been seen')),
      d.opened < 3 ? note('Patterns need a few more opened emails to mean much. These charts will settle as you send more.') : null,
      h('div', { class: 'charts' },
        h('div', { class: 'chart-card' }, h('h3', {}, 'Time of day'), h('p', { class: 'hint' }, d.opened ? `Most first opens happen around ${h12(hour)}.` : 'When first opens happen, in your time zone.'),
          bars(d.hours, (i) => (i % 6 === 0 ? String(i).padStart(2, '0') : ''), (i, v) => `${h12(i)}: ${plural(v, 'first open')}`)),
        h('div', { class: 'chart-card' }, h('h3', {}, 'Day of week'), h('p', { class: 'hint' }, d.opened ? `${days[day]} is your busiest day.` : 'Which days people open.'),
          bars(d.weekdays, (i) => 'SMTWTFS'[i], (i, v) => `${days[i]}: ${plural(v, 'first open')}`))),
      recent.length ? h('div', { class: 'recent' }, h('h3', {}, 'Recently opened'),
        ...recent.map((e) => h('button', { type: 'button', onclick: () => { location.hash = 'email=' + e.token; } }, tick('opened', 20), h('span', { class: 'row-main' }, h('span', { class: 'row-subject' }, subjectOf(e)), h('span', { class: 'row-to' }, O.recipientsLabel(e))), h('span', { class: 'row-time' }, O.timeAgo(e.last_open_at))))) : null);
  }
  const tile = (n, label, hint) => h('div', { class: 'tile' }, h('div', { class: 'tile-n' }, n), h('div', { class: 'tile-l' }, label), h('div', { class: 'hint' }, hint));

  /* ---------- settings ---------- */
  const toggles = ['trackByDefault', 'trackClicksByDefault', 'notifyOpens', 'notifyClicks', 'notifyRepeat', 'notifyPossible'];

  async function fillSettings() {
    const s = await O.getSettings();
    toggles.forEach((k) => { $('#' + k).checked = !!s[k]; });
    $('#remindAfterHours').value = String(s.remindAfterHours || 0);
    await renderAccount(s);
    const b = globalThis.OpenlyBrand || {};
    put($('#about'),
      h('p', {}, h('strong', {}, 'Openly'), ` ${chrome.runtime.getManifest().version}`),
      h('p', { class: 'hint' }, `Built by ${b.author || 'Raheelkhan Lohani'}.`),
      b.fingerprint ? h('p', { class: 'hint' }, `Signed build ${b.fingerprint}`) : null);
    flagSettings();
  }

  async function renderAccount(s) {
    s = s || await O.getSettings();
    state.account = s.accountEmail || '';
    const body = $('#accountBody');
    const modeSwitch = O.cloudAvailable
      ? h('div', { class: 'segmented', role: 'group', 'aria-label': 'Where your data lives' },
        ['cloud', 'selfhost'].map((m) => h('button', { type: 'button', 'aria-pressed': String(s.mode === m), onclick: async () => { await O.saveSettings({ mode: m }); await refresh(); await renderAccount(); flagSettings(); } }, m === 'cloud' ? 'Openly Cloud' : 'My own server')))
      : null;
    $('#accountHint').textContent = s.mode === 'cloud' ? 'Your emails and opens are stored in your private account.' : 'Openly talks to the tracking server you run. It needs a public https address so recipients can load the image.';
    let panel;
    if (s.mode === 'cloud' && s.signedIn) {
      panel = h('div', { class: 'signed-in' }, h('p', {}, 'Signed in as ', h('strong', {}, s.accountEmail || 'your account')),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: signOut }, 'Sign out')));
    } else if (s.mode === 'cloud') {
      panel = cloudForm(finishSignIn);
    } else {
      panel = selfHostForm(s, finishSignIn);
    }
    put(body, modeSwitch, panel);
    renderRail(s);
  }
  function renderRail(s) {
    const box = $('#railAccount');
    if (!O.isConfigured(s)) { box.replaceChildren(); return; }
    box.replaceChildren(
      h('div', { class: 'who' }, h('small', {}, s.mode === 'cloud' ? 'Signed in' : 'Your server'), s.mode === 'cloud' ? (s.accountEmail || 'Your account') : s.backendUrl.replace(/^https?:\/\//, '')),
      h('button', { type: 'button', onclick: signOut }, s.mode === 'cloud' ? 'Sign out' : 'Disconnect'));
  }
  async function signOut() {
    await O.signOut();
    state.emails = []; state.loaded = false; state.selected = null; detailMemo.clear();
    showGate(); toast('Signed out');
  }

  async function exportData() {
    try {
      const data = await O.api('/api/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = h('a', { href: url, download: 'openly-export.json' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Exported');
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function flagSettings() {
    const s = await O.getSettings();
    const { health = 'ok' } = await chrome.storage.local.get('health');
    $('#settingsFlag').hidden = !(O.isConfigured(s) && health !== 'ok') && O.isConfigured(s);
  }

  /* Phone and web: open the web dashboard signed in, or show a QR code to scan with a phone. */
  let qrTimer = null;
  async function webLink(forQr) {
    const msg = $('#webMsg');
    say(msg, 'Making a sign-in link…');
    try {
      const url = await O.webHandoffUrl();
      say(msg, '');
      return url;
    } catch (e) { say(msg, e.message, 'bad'); return null; }
  }
  async function showQr() {
    const url = await webLink(true);
    if (!url) return;
    const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
    $('#qrCode').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); // generated locally from the link above
    $('#qrBox').hidden = false;
    clearTimeout(qrTimer);
    qrTimer = setTimeout(() => { $('#qrBox').hidden = true; $('#qrCode').replaceChildren(); }, 5 * 60000); // not left on screen
  }

  /* ---------- views and routing ---------- */
  function view(name) {
    state.view = name;
    ['emails', 'insights', 'settings'].forEach((v) => { $('#view-' + v).hidden = v !== name; });
    $$('[data-nav]').forEach((b) => (b.dataset.nav === name ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    if (name === 'insights') renderInsights();
    if (name === 'settings') fillSettings();
  }
  function go(name) {
    if (name === 'emails') { if (location.hash) history.replaceState(null, '', location.pathname + location.search); route(); } else location.hash = name;
  }
  function route() {
    const hash = location.hash.replace(/^#/, '');
    if (hash.startsWith('email=')) {
      view('emails');
      const t = hash.slice(6).toLowerCase();
      if (/^[0-9a-f-]{36}$/.test(t) && t !== state.selected) select(t, { fromHash: true });
    } else if (hash === 'insights' || hash === 'settings') view(hash);
    else { view('emails'); if (state.selected && !$('#split').dataset.mode) $('#split').dataset.mode = 'list'; }
  }

  function moveSelection(delta) {
    const items = visible();
    if (!items.length) return;
    const i = items.findIndex((e) => e.token === state.selected);
    const next = items[Math.min(Math.max(i + delta, 0), items.length - 1)];
    if (next && next.token !== state.selected) {
      select(next.token);
      $(`.row[data-token="${next.token}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }

  function bind() {
    $$('[data-mark]').forEach((el) => el.append(tick('opened', 20)));
    $$('[data-icon]').forEach((el) => el.append(icon(el.dataset.icon, 18)));
    $$('[data-tick]').forEach((el) => el.append(tick(el.dataset.tick, 18)));
    $('#refreshBtn').append(icon('refresh', 18));
    $$('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
    $('#refreshBtn').addEventListener('click', async () => { await refresh(); toast('Up to date'); });
    $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
    $('#sortBy').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
    $('#range').addEventListener('change', (e) => { state.range = Number(e.target.value); renderEmails(); });
    toggles.forEach((k) => $('#' + k).addEventListener('change', async (e) => { await O.saveSettings({ [k]: e.target.checked }); toast('Saved'); }));
    $('#remindAfterHours').addEventListener('change', async (e) => { await O.saveSettings({ remindAfterHours: Number(e.target.value) }); toast('Saved'); });
    $('#exportBtn').append(icon('download', 16), 'Export my data');
    $('#exportBtn').addEventListener('click', exportData);
    const wipe = confirmButton('Delete all my data', 'Click again to delete everything', 'trash', async () => {
      await O.api('/api/data', { method: 'DELETE' });
      state.emails = []; state.selected = null; state.detail = null; detailMemo.clear(); O.stash('emails', []);
      renderEmails(); toast('All your data was deleted');
    });
    $('#wipeBtn').replaceWith(Object.assign(wipe, { id: 'wipeBtn' }));

    if (!IS_WEB) {
      $('#testNotif').addEventListener('click', () => chrome.notifications.create('openly|test|0', { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: 'Your email was opened', message: 'This is how notifications will look.' }));
      $('#openWeb').append(icon('external', 16), 'Open web dashboard');
      $('#showQr').append(icon('phone', 16), 'Show QR code for my phone');
      $('#openWeb').addEventListener('click', async () => { const u = await webLink(false); if (u) window.open(u, '_blank', 'noopener'); });
      $('#showQr').addEventListener('click', showQr);
      $('#qrAgain').addEventListener('click', showQr);
    }

    $$('#subnav a').forEach((a) => a.addEventListener('click', (ev) => {
      ev.preventDefault();
      $('#sec-' + a.dataset.sec)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $$('#subnav a').forEach((x) => x.classList.toggle('on', x === a));
    }));

    window.addEventListener('hashchange', route);
    document.addEventListener('keydown', (ev) => {
      if (state.view !== 'emails' || ev.metaKey || ev.ctrlKey || ev.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSelection(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSelection(-1); }
      else if (ev.key === 'Escape' && state.selected) closeDetail();
    });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== 'local' || !(c.settings || c.health)) return;
      flagSettings();
      O.getSettings().then((s) => { if (!O.isConfigured(s) && $('#gate').hidden) showGate(); });
    });
    const quiet = () => !document.hidden && state.view === 'emails' && $('#gate').hidden;
    setInterval(() => { if (quiet()) refresh({ silent: true }); }, 30000);
    setInterval(() => { if (quiet()) renderFreshness(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (quiet()) refresh({ silent: true }); });
  }

  async function start() {
    bind();
    let go = null; let note = null;
    try { go = await O.consumeHandoff(); } catch (e) { note = e.message; }
    if (go) history.replaceState(null, '', location.pathname + '#' + go);
    const s = await O.getSettings();
    await renderAccount(s);
    flagSettings();
    if (!O.isConfigured(s)) { showGate(note); route(); return; }
    route();
    refresh();
  }
  start();
})();
