/* Runs inside Gmail. Adds tracking when you send, and tells the server when you look at your own email. */
(() => {
  if (window.__openlyLoaded) return;
  window.__openlyLoaded = true;

  const { h, getSettings, isConfigured, backendOf } = Openly;

  // Gmail's markup changes now and then. Everything that depends on it lives in this block.
  const SEL = {
    sendButton: '.aoO[role="button"], [role="button"][data-tooltip^="Send"]',
    body: 'div[role="textbox"][g_editable="true"]',
    subject: 'input[name="subjectbox"]',
    bottomBar: '.btC',
    threadSubject: 'h2.hP',
  };
  const TOKEN_IN_URL = /\/t\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.gif/i;
  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const REMIND = [['0', 'Off'], ['24', 'In 1 day'], ['72', 'In 3 days'], ['168', 'In 1 week']];

  let settings = { ...Openly.DEFAULTS };
  const loadSettings = () => getSettings().then((s) => { settings = s; });
  loadSettings();
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.settings) loadSettings(); });

  /* ---------- small notice ---------- */
  let toastTimer;
  function toast(message, actionLabel, onAction) {
    document.querySelector('.openly-toast')?.remove();
    const el = h('div', { class: 'openly-toast', role: 'status' }, h('span', {}, message));
    if (actionLabel) el.append(h('button', { type: 'button', onclick: () => { onAction(); el.remove(); } }, actionLabel));
    document.body.append(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 8000);
  }

  /* ---------- per-email choices (fall back to your defaults) ---------- */
  const opt = {
    opens: (root) => (root.dataset.openlyTrack ?? (settings.trackByDefault ? '1' : '0')) === '1',
    clicks: (root) => (root.dataset.openlyClicks ?? (settings.trackClicksByDefault ? '1' : '0')) === '1',
    remind: (root) => Number(root.dataset.openlyRemind ?? settings.remindAfterHours ?? 0) || 0,
  };

  /* ---------- reading the compose window ---------- */
  // Climb from the Send button until we reach the whole compose window (header with subject
  // and recipients included), but stop before reaching something that holds a second compose.
  function findCompose(from) {
    let best = null;
    for (let n = from; n && n !== document.body; n = n.parentElement) {
      if (!n.querySelectorAll) continue;
      const bodies = n.querySelectorAll(SEL.body).length;
      if (bodies === 0) continue;
      if (bodies > 1) break;
      best = n;
      if (n.querySelector(SEL.subject) || n.querySelector('[name="to"]')) break;
    }
    return best;
  }
  function emailsIn(root, name) {
    const found = new Set();
    const add = (text) => (text || '').match(EMAIL)?.forEach((e) => found.add(e.toLowerCase()));
    root.querySelectorAll(`input[name="${name}"], textarea[name="${name}"]`).forEach((el) => add(el.value));
    root.querySelectorAll(`[name="${name}"] [email], [name="${name}"] [data-hovercard-id]`).forEach((el) => {
      add(el.getAttribute('email'));
      add(el.getAttribute('data-hovercard-id'));
    });
    return [...found];
  }
  // Fallback: recipient chips anywhere in the compose window (skips the body and your own address).
  function chipEmails(root) {
    const me = (document.title.match(EMAIL) || [])[0]?.toLowerCase();
    const found = new Set();
    root.querySelectorAll('[email], [data-hovercard-id*="@"]').forEach((el) => {
      if (el.closest(SEL.body) || el.closest('[name="from"]')) return;
      for (const raw of [el.getAttribute('email'), el.getAttribute('data-hovercard-id')]) {
        (raw || '').match(EMAIL)?.forEach((e) => { if (e.toLowerCase() !== me) found.add(e.toLowerCase()); });
      }
    });
    return [...found];
  }
  function readMessage(root) {
    let to = emailsIn(root, 'to');
    const cc = emailsIn(root, 'cc');
    const bcc = emailsIn(root, 'bcc');
    if (!to.length && !cc.length && !bcc.length) to = chipEmails(root);
    const subject =
      root.querySelector(SEL.subject)?.value?.trim() ||
      document.querySelector('[role="dialog"] ' + SEL.subject)?.value?.trim() ||
      document.querySelector(SEL.threadSubject)?.textContent?.trim() ||
      '';
    return { to, cc, bcc, subject };
  }

  /* ---------- the tracking image ---------- */
  function ensurePixel(root, token) {
    const body = root.querySelector(SEL.body);
    if (!body) return false;
    let img = body.querySelector('img[data-openly]');
    if (!img) {
      img = document.createElement('img');
      img.setAttribute('data-openly', '');
      img.alt = '';
      img.width = 1;
      img.height = 1;
      img.style.cssText = 'border:0;width:1px;height:1px;opacity:0;';
      body.append(img);
    }
    const src = `${backendOf(settings)}/t/${token}.gif`;
    if (img.getAttribute('src') !== src) img.src = src;
    return true;
  }
  const removePixel = (root) => root.querySelectorAll('img[data-openly]').forEach((i) => i.remove());

  /* ---------- link tracking: links go through your server, which sends people on ---------- */
  function rewriteLinks(root, token) {
    const base = backendOf(settings);
    const links = [];
    root.querySelector(SEL.body)?.querySelectorAll('a[href]').forEach((a) => {
      const orig = a.getAttribute('data-openly-orig') || a.getAttribute('href');
      if (!/^https?:\/\//i.test(orig) || orig.startsWith(base + '/') || orig.length > 2000) return;
      const n = links.length + 1;
      a.setAttribute('data-openly-orig', orig);
      a.setAttribute('href', `${base}/r/${token}/${n}`);
      links.push({ n, url: orig });
    });
    return links;
  }
  function restoreLinks(root) {
    root.querySelectorAll('a[data-openly-orig]').forEach((a) => {
      a.setAttribute('href', a.getAttribute('data-openly-orig'));
      a.removeAttribute('data-openly-orig');
    });
  }

  function beforeSend(root) {
    const opens = opt.opens(root);
    const clicks = opt.clicks(root);
    if (!opens) removePixel(root);
    if (!clicks) restoreLinks(root);
    if (!opens && !clicks) return;

    if (!isConfigured(settings)) {
      toast(settings.mode === 'cloud' ? 'Sign in to Openly to track this email. It was sent without tracking.' : 'Openly is not set up yet, so this email was sent without tracking.', 'Open Openly', () => chrome.runtime.sendMessage({ type: 'open-settings' }));
      return;
    }
    const token = (root.dataset.openlyToken ||= crypto.randomUUID());
    if (opens && !ensurePixel(root, token)) return;
    const links = clicks ? rewriteLinks(root, token) : [];

    const msg = { ...readMessage(root), links, remindAfterHours: opt.remind(root) };
    const fingerprint = JSON.stringify(msg);
    if (root.dataset.openlySent === fingerprint) return; // already registered this exact message
    root.dataset.openlySent = fingerprint;
    chrome.runtime.sendMessage({ type: 'register', payload: { token, ...msg, sentAt: new Date().toISOString() } });
  }

  /* ---------- hooks: click on Send, or Ctrl/Cmd + Enter ---------- */
  function onPress(e) {
    const btn = e.target.closest?.(SEL.sendButton);
    if (!btn) return;
    const root = findCompose(btn);
    if (root) beforeSend(root);
  }
  document.addEventListener('mousedown', onPress, true);
  document.addEventListener('click', onPress, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    const root = findCompose(e.target);
    if (root) beforeSend(root);
  }, true);

  /* ---------- the Track button and its small menu ---------- */
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target) && !e.target.closest('.openly-toggle')) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);

  function openMenu(root, anchor, repaint) {
    closeMenu();
    const switchRow = (label, hint, checked, onChange) => {
      const input = h('input', { type: 'checkbox' });
      input.checked = checked;
      input.addEventListener('change', () => { onChange(input.checked); repaint(); });
      return h('label', { class: 'openly-row' }, input, h('span', { class: 'openly-track' }), h('span', { class: 'openly-copy' }, h('span', {}, label), hint ? h('small', {}, hint) : null));
    };
    const select = h('select', { class: 'openly-select', 'aria-label': 'Remind me if not opened' }, REMIND.map(([v, l]) => h('option', { value: v }, l)));
    select.value = String(opt.remind(root));
    if (select.value !== String(opt.remind(root))) select.value = '0';
    select.addEventListener('change', () => { root.dataset.openlyRemind = select.value; });

    menu = h('div', { class: 'openly-menu', role: 'dialog', 'aria-label': 'Openly tracking options' },
      switchRow('Track opens', 'Know when this email is opened.', opt.opens(root), (v) => { root.dataset.openlyTrack = v ? '1' : '0'; }),
      switchRow('Track link clicks', 'A click confirms a real person, even with images blocked. Links go through your server.', opt.clicks(root), (v) => { root.dataset.openlyClicks = v ? '1' : '0'; }),
      h('div', { class: 'openly-row stack' }, h('span', { class: 'openly-copy' }, h('span', {}, 'Remind me if not opened'), h('small', {}, 'You get a notification if nobody has opened it by then.')), select)
    );
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.bottom = window.innerHeight - r.top + 8 + 'px';
  }

  function decorate(root) {
    const bar = root.querySelector(SEL.bottomBar);
    if (!bar || bar.querySelector('.openly-toggle')) return;
    const btn = h('button', { type: 'button', class: 'openly-toggle', 'aria-haspopup': 'dialog', title: 'Openly tracking options' }, h('span', { class: 'openly-dot' }), h('span', {}, 'Track'));
    const paint = () => {
      const on = opt.opens(root) || opt.clicks(root);
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('on', on);
    };
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu) closeMenu(); else openMenu(root, btn, paint);
    });
    paint();
    bar.append(btn);
  }

  /* ---------- noticing when you look at your own sent email ---------- */
  const lastPing = new Map();
  function scanForOwnViews() {
    document.querySelectorAll('img[data-surl*="/t/"], img[src*="/t/"]').forEach((img) => {
      if (img.dataset.openlySeen || img.closest(SEL.body)) return;
      const m = TOKEN_IN_URL.exec(img.getAttribute('data-surl') || '') || TOKEN_IN_URL.exec(img.getAttribute('src') || '');
      if (!m) return;
      img.dataset.openlySeen = '1';
      const token = m[1].toLowerCase();
      if (Date.now() - (lastPing.get(token) || 0) < 20000) return;
      lastPing.set(token, Date.now());
      chrome.runtime.sendMessage({ type: 'selfview', token });
    });
  }

  let queued = false;
  function scan() {
    queued = false;
    document.querySelectorAll(SEL.sendButton).forEach((btn) => {
      const root = findCompose(btn);
      if (root) decorate(root);
    });
    scanForOwnViews();
  }
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(scan, 300);
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();