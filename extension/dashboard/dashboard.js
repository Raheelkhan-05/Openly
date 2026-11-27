(() => {
  'use strict';
  const O = Openly;
  const { h, icon, tick, STATUS } = O;
  const $ = (s, r = document) => r.querySelector(s);

  const state = { emails: [], filter: 'all', q: '', selected: null, detail: null, detailError: null, loaded: false, error: null };
  let detailSeq = 0;
  const confirmTimers = new WeakMap();

  /* ---------- small helpers ---------- */
  function toast(message, tone = '') {
    const el = h('div', { class: `toast ${tone}`, role: 'status' }, message);
    $('#toasts').append(el);
    setTimeout(() => el.classList.add('out'), 3200);
    setTimeout(() => el.remove(), 3600);
  }
  const subjectOf = (e) => e.subject || '(no subject)';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const FLAG_TEXT = {
    image_proxy: 'Via image proxy', automated: 'Automated', just_sent: 'Seconds after sending',
    apple_privacy: 'Apple privacy network', preload: 'Apple Mail preload', link_scanner: 'Looks like a scanner',
  };
  // A button that needs a second click, so nothing is deleted by accident.
  function confirmButton(label, confirmLabel, ic, action) {
    const text = h('span', {}, label);
    const btn = h('button', { class: 'btn danger', type: 'button' }, ic ? icon(ic, 16) : null, text);
    btn.addEventListener('click', async () => {
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        text.textContent = confirmLabel;
        clearTimeout(confirmTimers.get(btn));
        confirmTimers.set(btn, setTimeout(() => { btn.classList.remove('confirm'); text.textContent = label; }, 4000));
        return;
      }
      btn.disabled = true;
      try { await action(); } catch (e) { toast(e.message, 'bad'); }
      btn.disabled = false;
      btn.classList.remove('confirm');
      text.textContent = label;
    });
    return btn;
  }

  /* ---------- views ---------- */
  function go(hash) {
    history.replaceState(null, '', location.pathname + (hash ? '#' + hash : ''));
    applyHash();
  }
  function applyHash() {
    const hash = location.hash.slice(1);
    const view = hash === 'settings' ? 'settings' : hash === 'insights' ? 'insights' : 'emails';
    ['emails', 'insights', 'settings'].forEach((v) => { $('#view-' + v).hidden = v !== view; });
    document.querySelectorAll('[data-nav]').forEach((b) => b.setAttribute('aria-current', b.dataset.nav === view ? 'page' : 'false'));
    if (view === 'settings') return fillSettings();
    if (view === 'insights') return loadInsights();
    const m = /^email=([0-9a-f-]{36})$/i.exec(hash);
    if (m) selectEmail(m[1].toLowerCase(), false);
    refresh();
    chrome.runtime.sendMessage({ type: 'clear-unseen' });
  }

  /* ---------- loading ---------- */
  async function refresh({ silent = false } = {}) {
    const s = await O.getSettings();
    if (!O.isConfigured(s)) {
      state.loaded = true;
      state.error = { code: 'not_configured', message: s.mode === 'cloud' ? 'Sign in to start tracking.' : 'Add your server address and API key.' };
      state.emails = [];
      return render();
    }
    try {
      const r = await O.api('/api/emails?limit=200', { settings: s });
      state.emails = r.emails;
      state.error = null;
    } catch (e) {
      if (silent) return;
      state.error = e;
    }
    state.loaded = true;
    render();
    if (state.selected) loadDetail(state.selected);
  }

  async function loadDetail(token) {
    const seq = ++detailSeq;
    try {
      const r = await O.api('/api/emails/' + token);
      if (seq !== detailSeq) return;
      state.detail = r.email;
      state.detailError = null;
    } catch (e) {
      if (seq !== detailSeq) return;
      state.detailError = e;
    }
    renderDetail();
  }

  function selectEmail(token, updateHash = true) {
    state.selected = token;
    state.detail = null;
    state.detailError = null;
    if (updateHash) history.replaceState(null, '', location.pathname + '#email=' + token);
    renderList();
    renderDetail();
    loadDetail(token);
  }
  function deselect() {
    state.selected = null;
    state.detail = null;
    history.replaceState(null, '', location.pathname);
    renderList();
    renderDetail();
  }

  async function markMine(id, mine) {
    try {
      await O.api(`/api/events/${id}/mine`, { method: 'POST', body: { mine } });
      toast(mine ? 'Moved out of the count' : 'Counted again');
      await refresh({ silent: true });
      if (state.selected) await loadDetail(state.selected);
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ---------- emails: rendering ---------- */
  function render() { renderStats(); renderList(); renderDetail(); }

  function renderStats() {
    const c = { all: state.emails.length, opened: 0, possible: 0, none: 0 };
    state.emails.forEach((e) => { c[e.status] += 1; });
    $('#stats').replaceChildren(
      ...[['all', 'All'], ['opened', 'Opened'], ['possible', 'Possible'], ['none', 'No open']].map(([k, label]) =>
        h('button', { class: 'stat', type: 'button', 'data-tone': k, 'aria-pressed': String(state.filter === k), onclick: () => { state.filter = k; renderStats(); renderList(); } },
          h('span', { class: 'stat-n' }, c[k]), h('span', { class: 'stat-l' }, label))
      )
    );
  }

  const visible = () => {
    const q = state.q.trim().toLowerCase();
    return state.emails.filter((e) => {
      if (state.filter !== 'all' && e.status !== state.filter) return false;
      if (!q) return true;
      return [e.subject, ...e.to_recipients, ...e.cc_recipients, ...e.bcc_recipients].join(' ').toLowerCase().includes(q);
    });
  };
  const emptyState = (title, text, action) => h('li', {}, h('div', { class: 'empty' }, h('h3', {}, title), h('p', {}, text), action || null));

  function renderList() {
    const list = $('#list');
    $('#split').dataset.mode = state.selected ? 'detail' : 'list';
    if (!state.loaded) {
      return list.replaceChildren(...[0, 1, 2, 3].map(() => h('li', { class: 'skel-row' }, h('div', { class: 'skeleton', style: 'height:14px;width:60%' }), h('div', { class: 'skeleton', style: 'height:12px;width:40%' }))));
    }
    if (state.error?.code === 'not_configured') {
      return list.replaceChildren(emptyState('Get started', state.error.message, h('button', { class: 'btn primary', type: 'button', onclick: () => go('settings') }, 'Open settings')));
    }
    if (state.error && !state.emails.length) {
      const bad = state.error.code === 'unauthorized';
      return list.replaceChildren(emptyState(bad ? 'Please sign in again' : "Can't load your emails", state.error.message, h('button', { class: 'btn', type: 'button', onclick: () => (bad ? go('settings') : refresh()) }, bad ? 'Open settings' : 'Try again')));
    }
    const items = visible();
    if (!items.length) {
      return list.replaceChildren(state.emails.length ? emptyState('Nothing matches', 'Try another filter or search.') : emptyState('No tracked emails yet', 'Send an email from Gmail. It will appear here a few seconds later.'));
    }
    list.replaceChildren(
      ...items.map((e) =>
        h('li', {},
          h('button', { class: 'row' + (e.token === state.selected ? ' selected' : ''), type: 'button', onclick: () => selectEmail(e.token) },
            tick(e.status),
            h('span', { class: 'row-main' }, h('span', { class: 'row-subject' }, subjectOf(e)), h('span', { class: 'row-sub' }, O.recipientsLabel(e))),
            h('span', { class: 'row-meta' }, h('span', {}, O.timeAgo(e.sent_at)), e.click_count ? h('span', { class: 'row-count' }, plural(e.click_count, 'click', 'clicks')) : e.open_count ? h('span', { class: 'row-count' }, plural(e.open_count, 'open', 'opens')) : null, e.last_device && DEVICE_SHORT[e.last_device.kind] ? h('span', { class: 'row-count' }, DEVICE_SHORT[e.last_device.kind]) : null)
          )
        )
      )
    );
  }

  const DEVICE_SHORT = { mobile: 'Mobile', desktop: 'Desktop', tablet: 'Tablet' };
  // One line on where the counted activity happened. Gmail and Apple hide the device on image loads; a link click shows it.
  function deviceNote(e) {
    const c = e.device_counts;
    if (!c) return null;
    const total = c.desktop + c.mobile + c.tablet + c.hidden + c.unknown;
    if (!total) return null;
    const parts = [
      c.mobile && `mobile phone ${c.mobile}`,
      c.desktop && `desktop / laptop ${c.desktop}`,
      c.tablet && `tablet ${c.tablet}`,
      c.hidden && `device hidden ${c.hidden}`,
      c.unknown && `unknown ${c.unknown}`,
    ].filter(Boolean);
    let text = `Where it was read: ${parts.join(', ')}.`;
    if (c.hidden && !(c.mobile + c.desktop + c.tablet)) text += " Gmail and Apple Mail hide the reader's device when they load images. A link click shows it exactly.";
    return h('div', { class: 'note' }, icon('info', 16), h('span', {}, text));
  }

  function eventItem(ev) {
    const isClick = ev.type === 'click';
    const title =
      ev.kind === 'sender' ? 'Not counted'
        : ev.kind === 'possible' ? (isClick ? 'Possible click' : 'Possible open')
          : isClick ? 'Clicked a link'
            : ev.same_open ? 'Repeat request, same open'
              : ev.open_index === 1 ? 'First open' : `Opened again (open ${ev.open_index})`;
    const where = ev.device_detail ? [ev.device_detail] : [];
    const action = ev.kind === 'sender'
      ? ev.marked_mine ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => markMine(ev.id, false) }, 'Not me') : null
      : h('button', { class: 'btn ghost small', type: 'button', onclick: () => markMine(ev.id, true) }, 'That was me');
    return h('li', { class: 'event' + (ev.same_open ? ' dup' : '') },
      tick(ev.kind === 'sender' ? 'none' : ev.kind === 'recipient' ? 'opened' : 'possible'),
      h('div', { class: 'event-body' },
        h('div', { class: 'event-title' }, title, ev.device_label ? h('span', { class: 'tag' }, ev.device_label) : null, ...ev.flags.map((f) => h('span', { class: 'tag' }, FLAG_TEXT[f] || f))),
        h('div', { class: 'event-when' }, O.formatDateSec(ev.occurred_at)),
        h('div', { class: 'event-detail' }, ev.reason + (where.length ? ' ' + where.join(', ') + '.' : '')),
        ev.link_url ? h('div', { class: 'event-link' }, ev.link_url) : null
      ),
      action
    );
  }

  function renderDetail() {
    const pane = $('#detail');
    if (!state.selected) return pane.replaceChildren(h('div', { class: 'placeholder' }, h('h3', {}, 'Select an email'), h('p', {}, 'Its status and activity will show here.')));
    if (state.detailError?.status === 404) return pane.replaceChildren(h('div', { class: 'placeholder' }, h('h3', {}, 'This email is no longer tracked'), h('button', { class: 'btn', type: 'button', onclick: deselect }, 'Back to list')));
    const e = state.detail || state.emails.find((x) => x.token === state.selected);
    if (!e) return pane.replaceChildren(h('div', { class: 'detail' }, h('div', { class: 'skeleton', style: 'height:24px;width:50%' }), h('div', { class: 'skeleton', style: 'height:70px' })));

    const st = STATUS[e.status];
    const people = [['To', e.to_recipients], ['Cc', e.cc_recipients], ['Bcc', e.bcc_recipients]].filter(([, l]) => l.length);
    const events = state.detail?.events || [];
    const mine = events.filter((x) => x.kind === 'sender');
    const shown = events.filter((x) => x.kind !== 'sender').reverse();
    const reminderLine = e.remind_at && !e.reminded_at ? `Reminder set for ${O.formatDate(e.remind_at)} if nobody opens it.` : e.reminded_at ? 'You were reminded about this email.' : '';

    pane.replaceChildren(
      h('article', { class: 'detail' },
        h('button', { class: 'btn ghost back', type: 'button', onclick: deselect }, icon('back'), 'All emails'),
        h('header', { class: 'd-head' }, h('h2', {}, subjectOf(e)), h('p', {}, 'Sent ' + O.formatDate(e.sent_at))),
        h('div', { class: 'banner', 'data-tone': st.tone },
          tick(e.status, 24),
          h('div', {}, h('strong', {}, st.label), h('p', {}, st.help),
            e.confidence ? h('p', { class: 'confidence' }, h('b', {}, O.CONFIDENCE[e.confidence] + ' confidence. '), O.confidenceText(e)) : null)
        ),
        h('dl', { class: 'facts' },
          h('div', {}, h('dt', {}, 'Opens'), h('dd', {}, e.open_count)),
          h('div', {}, h('dt', {}, 'Link clicks'), h('dd', {}, e.click_count)),
          h('div', {}, h('dt', {}, 'First seen'), h('dd', {}, e.first_open_at ? O.timeAgo(e.first_open_at) : 'None yet')),
          h('div', {}, h('dt', {}, 'Last seen'), h('dd', {}, e.last_open_at ? O.timeAgo(e.last_open_at) : 'None yet'))
        ),
        deviceNote(e),
        e.distinct_devices > 1 ? h('div', { class: 'note' }, icon('info', 16), h('span', {}, `Seen on ${e.distinct_devices} different devices. It may have been opened by more than one person, or forwarded.`)) : null,
        h('section', {},
          h('h3', { class: 'section-title' }, 'Recipients'),
          people.length
            ? h('div', { class: 'people' }, people.map(([label, list]) => h('div', { class: 'person-row' }, h('span', {}, label), h('div', { class: 'chips' }, list.map((a) => h('span', { class: 'chip' }, a))))))
            : h('p', { class: 'empty-line' }, 'Openly could not read the recipients from Gmail.'),
          e.recipient_count > 1 ? h('div', { class: 'note' }, icon('info', 16), h('span', {}, `This email went to ${e.recipient_count} people with one tracking image, so an open can't be matched to a specific person. Send separate emails if you need that.`)) : null,
          reminderLine ? h('div', { class: 'note' }, icon('info', 16), h('span', {}, reminderLine)) : null
        ),
        e.link_count ? h('section', {},
          h('h3', { class: 'section-title' }, 'Links'),
          h('ul', { class: 'links' }, (state.detail ? state.detail.clicked_links : e.clicked_links || []).map((l) => h('li', {}, icon('link', 16), h('span', { class: 'event-link' }, l.url), h('span', { class: 'row-count' }, plural(l.count, 'click', 'clicks')))),
            !(state.detail ? state.detail.clicked_links : e.clicked_links || []).length ? h('li', { class: 'empty-line' }, `${plural(e.link_count, 'link', 'links')} tracked, none clicked yet.`) : null)
        ) : null,
        h('section', {},
          h('h3', { class: 'section-title' }, 'Activity'),
          !state.detail
            ? h('div', { class: 'skeleton', style: 'height:44px' })
            : shown.length ? h('ol', { class: 'timeline' }, shown.map(eventItem)) : h('p', { class: 'empty-line' }, 'Nothing yet. New activity appears here as it happens.')
        ),
        mine.length ? h('details', { class: 'excluded' }, h('summary', {}, `Not counted (${mine.length})`), h('ol', { class: 'timeline' }, mine.reverse().map(eventItem))) : null,
        h('div', { class: 'danger-zone' }, confirmButton('Delete record', 'Click again to delete', 'trash', async () => {
          await O.api('/api/emails/' + e.token, { method: 'DELETE' });
          state.emails = state.emails.filter((x) => x.token !== e.token);
          deselect();
          render();
          toast('Record deleted');
        }))
      )
    );
  }

  /* ---------- insights ---------- */
  const hourLabel = (hr) => `${hr % 12 || 12} ${hr < 12 ? 'am' : 'pm'}`;
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function duration(min) {
    if (min == null) return 'No data yet';
    if (min < 1) return 'Under a minute';
    if (min < 60) return `${Math.round(min)} min`;
    if (min < 1440) return `${(min / 60).toFixed(min < 600 ? 1 : 0).replace(/\.0$/, '')} h`;
    return `${Math.round(min / 1440)} d`;
  }
  function bars(values, labelOf, every, summary) {
    const max = Math.max(...values, 1);
    return h('div', { class: 'chart', role: 'img', 'aria-label': summary },
      h('div', { class: 'bars' }, values.map((v, i) => h('div', { class: 'bar-col', title: `${labelOf(i)}: ${plural(v, 'open', 'opens')}` }, h('div', { class: 'bar' + (v === max && v > 0 ? ' top' : ''), style: `height:${Math.max((v / max) * 100, v ? 4 : 1)}%` })))),
      h('div', { class: 'bar-labels' }, values.map((_, i) => h('span', {}, i % every === 0 ? labelOf(i, true) : '')))
    );
  }
  async function loadInsights() {
    const box = $('#insights');
    const s = await O.getSettings();
    if (!O.isConfigured(s)) return box.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Get started'), h('p', {}, 'Connect your account to see when people open your email.'), h('button', { class: 'btn primary', type: 'button', onclick: () => go('settings') }, 'Open settings')));
    box.replaceChildren(h('div', { class: 'skeleton', style: 'height:96px' }));
    try {
      const i = await O.api('/api/insights?tz=' + new Date().getTimezoneOffset());
      if (!i.total) return box.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'No data yet'), h('p', {}, 'Insights appear after you send a few tracked emails.')));
      const bestHour = i.hours.indexOf(Math.max(...i.hours));
      const bestDay = i.weekdays.indexOf(Math.max(...i.weekdays));
      box.replaceChildren(
        h('div', { class: 'tiles' },
          tile(i.open_rate == null ? '-' : Math.round(i.open_rate * 100) + '%', 'Open rate', `${i.opened} of ${i.total} emails`),
          tile(duration(i.median_minutes_to_first_open), 'Typical time to first open', 'Half of your opens are faster'),
          tile(String(i.clicked), 'Emails with a link click', 'Confirmed by a person')
        ),
        i.opened
          ? h('div', { class: 'charts' },
            h('section', { class: 'chart-card' }, h('h3', {}, 'When people open'), h('p', { class: 'hint' }, `Most first opens happen around ${hourLabel(bestHour)}.`), bars(i.hours, (n, short) => (short ? String(n % 12 || 12) + (n < 12 ? 'a' : 'p') : hourLabel(n)), 3, `Opens by hour. Busiest around ${hourLabel(bestHour)}.`)),
            h('section', { class: 'chart-card' }, h('h3', {}, 'Which days'), h('p', { class: 'hint' }, `${DAYS[bestDay]} is your best day.`), bars(i.weekdays, (n) => DAYS[n], 1, `Opens by weekday. Best day is ${DAYS[bestDay]}.`)))
          : h('div', { class: 'note' }, icon('info', 16), h('span', {}, 'No opens yet. Charts appear when people start opening your emails.'))
      );
    } catch (e) { box.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, "Can't load insights"), h('p', {}, e.message), h('button', { class: 'btn', type: 'button', onclick: loadInsights }, 'Try again'))); }
  }
  const tile = (value, label, sub) => h('div', { class: 'tile' }, h('div', { class: 'tile-n' }, value), h('div', { class: 'tile-l' }, label), h('div', { class: 'hint' }, sub));

  /* ---------- settings ---------- */
  const toggles = ['trackByDefault', 'trackClicksByDefault', 'notifyOpens', 'notifyClicks', 'notifyRepeat', 'notifyPossible'];

  async function fillSettings() {
    const s = await O.getSettings();
    toggles.forEach((k) => { $('#' + k).checked = !!s[k]; });
    $('#remindAfterHours').value = String(s.remindAfterHours || 0);
    renderAccount(s);
    $('#exportBtn').replaceChildren(icon('download', 16), 'Export my data');
    const b = globalThis.OpenlyBrand || {};
    $('#about').replaceChildren(
      h('p', {}, h('strong', {}, 'Openly'), ` ${chrome.runtime.getManifest().version}`),
      h('p', { class: 'hint' }, `Built by ${b.author || 'Raheelkhan Lohani'}.`),
      b.fingerprint ? h('p', { class: 'hint' }, `Signed build ${b.fingerprint}`) : null
    );
    flagSettings();
  }

  function msgEl() { return h('p', { class: 'inline-msg', role: 'status' }); }
  function say(el, text, tone = '') { el.textContent = text; el.className = 'inline-msg ' + tone; }

  function renderAccount(s) {
    const body = $('#accountBody');
    const modeSwitch = O.cloudAvailable
      ? h('div', { class: 'segmented', role: 'group', 'aria-label': 'Where your data lives' },
        ['cloud', 'selfhost'].map((m) => h('button', { type: 'button', 'aria-pressed': String(s.mode === m), onclick: async () => { await O.saveSettings({ mode: m }); renderAccount(await O.getSettings()); flagSettings(); } }, m === 'cloud' ? 'Openly Cloud' : 'My own server')))
      : null;
    $('#accountHint').textContent = s.mode === 'cloud' ? 'Your emails and opens are stored in your private account.' : 'Openly talks to the tracking server you run. It needs a public https address so recipients can load the image.';
    body.replaceChildren(modeSwitch, s.mode === 'cloud' ? cloudPanel(s) : selfHostPanel(s));
  }

  function cloudPanel(s) {
    if (s.signedIn) {
      return h('div', { class: 'signed-in' }, h('p', {}, 'Signed in as ', h('strong', {}, s.accountEmail || 'your account')),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: async () => { await O.signOut(); renderAccount(await O.getSettings()); flagSettings(); toast('Signed out'); } }, 'Sign out')));
    }
    const msg = msgEl();
    const email = h('input', { class: 'input', id: 'signEmail', type: 'email', placeholder: 'you@example.com', autocomplete: 'email' });
    const code = h('input', { class: 'input', id: 'signCode', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6-digit code', maxlength: '8' });
    const codeRow = h('div', { class: 'field', hidden: true }, h('label', { for: 'signCode' }, 'Code from your email'), code);
    const send = h('button', { class: 'btn primary', type: 'button' }, 'Send code');
    const verify = h('button', { class: 'btn primary', type: 'button', hidden: true }, 'Sign in');
    send.addEventListener('click', async () => {
      if (!email.validity.valid || !email.value.trim()) return say(msg, 'Enter a valid email address.', 'bad');
      send.disabled = true; say(msg, 'Sending…');
      try {
        await O.requestCode(email.value);
        say(msg, 'Code sent. Check your inbox (and spam).', 'ok');
        codeRow.hidden = false; verify.hidden = false; send.textContent = 'Send again'; code.focus();
      } catch (e) { say(msg, e.message, 'bad'); }
      send.disabled = false;
    });
    verify.addEventListener('click', async () => {
      if (!code.value.trim()) return say(msg, 'Enter the code from your email.', 'bad');
      verify.disabled = true; say(msg, 'Checking…');
      try {
        await O.verifyCode(email.value, code.value);
        renderAccount(await O.getSettings()); flagSettings(); toast('Signed in'); refresh({ silent: true });
      } catch (e) { say(msg, e.message, 'bad'); verify.disabled = false; }
    });
    return h('div', { class: 'signin' },
      h('div', { class: 'field' }, h('label', { for: 'signEmail' }, 'Email'), email), codeRow, msg,
      h('div', { class: 'actions' }, send, verify));
  }

  function selfHostPanel(s) {
    const msg = msgEl();
    const url = h('input', { class: 'input', id: 'backendUrl', type: 'url', placeholder: 'https://your-server.example.com', autocomplete: 'off', spellcheck: 'false' });
    const key = h('input', { class: 'input', id: 'apiKey', type: 'password', autocomplete: 'off', spellcheck: 'false' });
    url.value = s.backendUrl; key.value = s.apiKey;
    const draft = () => ({ ...s, mode: 'selfhost', backendUrl: O.normalizeBase(url.value), apiKey: key.value.trim() });
    const problem = (d) => (!d.backendUrl ? 'Enter your server address.' : !/^https?:\/\//i.test(d.backendUrl) ? 'The address must start with https://' : !d.apiKey ? 'Enter your API key.' : null);
    const show = h('button', { class: 'btn', type: 'button', onclick: (e) => { key.type = key.type === 'password' ? 'text' : 'password'; e.target.textContent = key.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
    const save = h('button', {
      class: 'btn primary', type: 'button', onclick: async () => {
        const d = draft(); const p = problem(d);
        if (p) return say(msg, p, 'bad');
        await O.saveSettings({ mode: 'selfhost', backendUrl: d.backendUrl, apiKey: d.apiKey });
        say(msg, 'Saved.', 'ok'); toast('Settings saved'); flagSettings();
      }
    }, 'Save changes');
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
      }
    }, 'Test connection');
    return h('div', { class: 'selfhost' },
      h('div', { class: 'field' }, h('label', { for: 'backendUrl' }, 'Server address'), url),
      h('div', { class: 'field' }, h('label', { for: 'apiKey' }, 'API key'), h('div', { class: 'row-inline' }, key, show)),
      msg, h('div', { class: 'actions' }, save, test));
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
    $('#settingsFlag').hidden = O.isConfigured(s) && health === 'ok';
  }

  function bind() {
    $('#brandMark').append(tick('opened', 18));
    document.querySelectorAll('[data-icon]').forEach((el) => el.append(icon(el.dataset.icon)));
    $('#refreshBtn').append(icon('refresh'));
    document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav === 'emails' ? '' : b.dataset.nav)));
    $('#refreshBtn').addEventListener('click', () => { refresh(); toast('Refreshed'); });
    $('#search').addEventListener('input', (e) => { state.q = e.target.value; renderList(); });
    toggles.forEach((k) => $('#' + k).addEventListener('change', async (e) => { await O.saveSettings({ [k]: e.target.checked }); toast('Saved'); }));
    $('#remindAfterHours').addEventListener('change', async (e) => { await O.saveSettings({ remindAfterHours: Number(e.target.value) }); toast('Saved'); });
    $('#testNotif').addEventListener('click', () => chrome.notifications.create('openly|test|0', { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title: 'Your email was opened', message: 'This is how notifications will look.' }));
    $('#exportBtn').addEventListener('click', exportData);
    const wipe = confirmButton('Delete all my data', 'Click again to delete everything', 'trash', async () => {
      await O.api('/api/data', { method: 'DELETE' });
      state.emails = []; state.selected = null; state.detail = null;
      toast('All your data was deleted');
    });
    $('#wipeBtn').replaceWith(Object.assign(wipe, { id: 'wipeBtn' }));
    window.addEventListener('hashchange', applyHash);
    chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.settings || c.health)) flagSettings(); });
    const quiet = () => !document.hidden && !$('#view-emails').hidden;
    setInterval(() => { if (quiet()) refresh({ silent: true }); }, 30000);
    document.addEventListener('visibilitychange', () => { if (quiet()) refresh({ silent: true }); });
  }

  bind();
  flagSettings();
  applyHash();
})();