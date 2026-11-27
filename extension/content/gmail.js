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
  // Gmail has no hidden "To" input. The chosen recipients are chips, and the address can sit in
  // any of several attributes (email, data-hovercard-id, aria-label...), so every attribute is checked.
  function emailsIn(root, name) {
    const found = new Set();
    const scan = (node, withText) => {
      for (const el of [node, ...node.querySelectorAll('*')]) {
        if (el.closest(SEL.body)) continue;
        for (const a of el.attributes) a.value.match(EMAIL)?.forEach((e) => found.add(e.toLowerCase()));
        if (typeof el.value === 'string') el.value.match(EMAIL)?.forEach((e) => found.add(e.toLowerCase()));
      }
      if (withText) (node.textContent || '').match(EMAIL)?.forEach((e) => found.add(e.toLowerCase()));
    };
    const fields = [...root.querySelectorAll(`[name="${name}"]`)].filter((el) => !el.closest(SEL.body));
    fields.forEach((el) => scan(el, true));
    // If the named box is only a wrapper, look at its row too (attributes only, never the message text).
    if (!found.size) fields.forEach((el) => { const row = el.closest('tr'); if (row && !row.contains(root.querySelector(SEL.body))) scan(row, false); });
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
      root.querySelector('input[name="subject"]')?.value?.trim() ||
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
    // Tell Gmail the message changed, so it includes the image when it builds the email.
    for (const type of ['input', 'keyup']) {
      try { body.dispatchEvent(type === 'input' ? new InputEvent('input', { bubbles: true }) : new KeyboardEvent('keyup', { bubbles: true })); } catch { /* ignore */ }
    }
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

  /* ---------- plain text mode can't carry tracking, so Send is held back ---------- */
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  // In plain text mode Gmail swaps the rich editor for a plain text box.
  function isPlainText(root) {
    const rich = root.querySelector(SEL.body);
    const box = [...root.querySelectorAll('textarea')].find(
      (t) => isVisible(t) && (t.name === 'body' || t.classList.contains('Ak') || /body/i.test(t.getAttribute('aria-label') || ''))
    );
    return !!box && !isVisible(rich);
  }
  const needsRichText = (root) => (opt.opens(root) || opt.clicks(root)) && isConfigured(settings) && isPlainText(root);
  const repaint = (root) => root.__openlyPaint?.();

  function plainTextDialog(root) {
    document.querySelector('.openly-modal')?.remove();
    const close = () => el.remove();
    const el = h('div', { class: 'openly-modal', role: 'alertdialog', 'aria-label': 'Plain text mode cannot be tracked' },
      h('strong', {}, "Plain text mode can't be tracked"),
      h('p', {}, 'Plain text emails cannot hold the tracking image or links. Turn off "Plain text mode" in the ⋮ More options menu of this window, then click Send.'),
      h('div', { class: 'openly-actions' },
        h('button', { type: 'button', class: 'primary', onclick: close }, 'OK, I will switch it'),
        h('button', { type: 'button', onclick: () => {
          root.dataset.openlyTrack = '0';
          root.dataset.openlyClicks = '0';
          repaint(root);
          close();
          toast('Tracking is off for this email. Click Send again to send it.');
        } }, 'Send without tracking'))
    );
    document.body.append(el);
    el.querySelector('button').focus();
  }

  /* ---------- hooks: click on Send, or Ctrl/Cmd + Enter ---------- */
  let blockedUntil = 0;
  const stop = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  function onPress(e) {
    const btn = e.target.closest?.(SEL.sendButton);
    if (!btn) return;
    const root = findCompose(btn);
    if (!root) return;
    if (e.type !== 'mousedown' && Date.now() < blockedUntil) return stop(e); // finish cancelling the same press
    if (needsRichText(root)) {
      blockedUntil = Date.now() + 1500;
      stop(e);
      plainTextDialog(root);
      return;
    }
    beforeSend(root);
  }
  document.addEventListener('mousedown', onPress, true);
  document.addEventListener('mouseup', (e) => { if (Date.now() < blockedUntil && e.target.closest?.(SEL.sendButton)) stop(e); }, true);
  document.addEventListener('click', onPress, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    const root = findCompose(e.target);
    if (!root) return;
    if (needsRichText(root)) { stop(e); plainTextDialog(root); return; }
    beforeSend(root);
  }, true);

  /* ---------- the Track button and its small menu ---------- */
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target) && !e.target.closest('.openly-toggle')) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); document.querySelector('.openly-modal')?.remove(); } }, true);

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
    const label = h('span', {}, 'Track');
    const btn = h('button', { type: 'button', class: 'openly-toggle', 'aria-haspopup': 'dialog', title: 'Openly tracking options' }, h('span', { class: 'openly-dot' }), label);
    const paint = () => {
      const on = opt.opens(root) || opt.clicks(root);
      const plain = on && isConfigured(settings) && isPlainText(root);
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('on', on && !plain);
      btn.classList.toggle('warn', plain);
      label.textContent = plain ? 'Plain text' : 'Track';
      btn.title = plain ? "Plain text mode can't be tracked. Turn it off in the ⋮ More options menu." : 'Openly tracking options';
    };
    root.__openlyPaint = paint;
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
      if (root) { decorate(root); repaint(root); }
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
