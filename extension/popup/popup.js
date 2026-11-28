(async () => {
  const O = Openly;
  const { h, icon, tick } = O;
  const $ = (s) => document.querySelector(s);
  const dash = (hash = '') => chrome.runtime.getURL('dashboard/dashboard.html') + hash;
  const open = (hash) => { chrome.tabs.create({ url: dash(hash) }); window.close(); };

  $('#brandMark').append(tick('opened', 16));
  $('#openSettings').append(icon('settings'));
  $('#openWeb').append(icon('phone'));
  $('#openWeb').addEventListener('click', async () => {
    try { chrome.tabs.create({ url: await O.webHandoffUrl() }); window.close(); }
    catch (e) { content.prepend(h('p', { class: 'inline-msg bad', style: 'padding:8px 16px' }, e.message)); }
  });
  $('#openSettings').addEventListener('click', () => open('#settings'));
  $('#openDash').addEventListener('click', () => open(''));
  chrome.runtime.sendMessage({ type: 'clear-unseen' });

  const s = await O.getSettings();
  const track = $('#trackByDefault');
  track.checked = s.trackByDefault;
  track.addEventListener('change', () => O.saveSettings({ trackByDefault: track.checked }));

  const content = $('#content');
  const message = (title, text, action) => content.replaceChildren(h('div', { class: 'message' }, h('h2', {}, title), h('p', {}, text), action || null));

  if (!O.isConfigured(s)) {
    return s.mode === 'cloud'
      ? message('Sign in to Openly', 'Use your email to start tracking. No password needed.', h('button', { class: 'btn', type: 'button', onclick: () => open('#settings') }, 'Sign in'))
      : message('Set up Openly', 'Add your server address and API key to start tracking emails.', h('button', { class: 'btn', type: 'button', onclick: () => open('#settings') }, 'Open settings'));
  }

  /* Pausing: for when you're about to check your own sent mail on your phone. */
  function renderPause(until) {
    const box = $('#pause');
    box.hidden = false;
    box.className = 'pause' + (until ? ' on' : '');
    const set = async (minutes) => {
      try {
        const r = minutes ? await O.api('/api/pause', { method: 'POST', body: { minutes } }) : await O.api('/api/pause', { method: 'DELETE' });
        renderPause(minutes ? r.pause_until : null);
      } catch (e) { box.replaceChildren(h('p', {}, e.message)); }
    };
    box.replaceChildren(
      h('p', {}, until ? `Not counting opens until ${O.formatTime(until)}` : 'Checking your sent mail on your phone?'),
      h('div', { class: 'row' },
        until
          ? h('button', { class: 'btn small', type: 'button', onclick: () => set(0) }, 'Resume now')
          : [h('button', { class: 'btn small', type: 'button', onclick: () => set(10) }, 'Pause 10 min'), h('button', { class: 'btn small', type: 'button', onclick: () => set(60) }, 'Pause 1 hour')])
    );
  }

  const activity = (e) => (e.status === 'opened' ? `Opened ${e.open_count || e.click_count}×${e.last_open_at ? ' · ' + O.timeAgo(e.last_open_at) : ''}` : e.status === 'possible' ? 'Possible open' : 'Not opened');
  function paint(emails) {
    const week = emails.filter((e) => Date.now() - Date.parse(e.sent_at) < 7 * 864e5);
    const opened = week.filter((e) => e.status === 'opened').length;
    const possible = week.filter((e) => e.status === 'possible').length;
    const items = emails.slice().sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at)).slice(0, 7);
    content.replaceChildren(
      h('div', { class: 'week', role: 'group', 'aria-label': 'Last 7 days' },
        h('div', {}, h('b', {}, week.length), h('span', {}, 'Sent this week')),
        h('div', { class: 'ok' }, h('b', {}, opened), h('span', {}, 'Opened')),
        h('div', { class: 'warn' }, h('b', {}, possible), h('span', {}, 'Possible'))),
      items.length
        ? h('ul', { class: 'list' }, items.map((e) =>
            h('li', {}, h('button', { class: 'item', type: 'button', 'data-status': e.status, onclick: () => open('#email=' + e.token) },
              tick(e.status),
              h('span', { class: 'item-main' }, h('span', { class: 'item-subject' }, e.subject || '(no subject)'), h('span', { class: 'item-sub' }, O.recipientsLabel(e)), h('span', { class: 'item-act' }, activity(e))),
              h('span', { class: 'item-time' }, O.timeAgo(e.sent_at))))))
        : h('div', { class: 'message' }, h('p', {}, 'No tracked emails yet. Send one from Gmail and it will show up here.')));
  }

  // The last list appears at once; the fresh one replaces it a moment later.
  const cached = await O.peek('emails');
  if (cached?.data) paint(cached.data);
  else content.replaceChildren(h('div', { class: 'skel' }, h('div', { class: 'skeleton', style: 'height:34px' }), h('div', { class: 'skeleton', style: 'height:14px;width:70%' }), h('div', { class: 'skeleton', style: 'height:14px;width:55%' })));

  try {
    const [{ emails }, ping] = await Promise.all([O.api('/api/emails?limit=200', { timeout: 8000 }), O.api('/api/ping', { timeout: 8000 })]);
    O.stash('emails', emails);
    paint(emails);
    renderPause(ping.pause_until);
  } catch (e) {
    if (cached?.data) { renderPause(null); return; } // keep showing the saved copy when offline
    const bad = e.code === 'unauthorized';
    message(bad ? 'Please sign in again' : "Can't reach your server", e.message, h('button', { class: 'btn', type: 'button', onclick: () => open('#settings') }, 'Open settings'));
  }
})();
