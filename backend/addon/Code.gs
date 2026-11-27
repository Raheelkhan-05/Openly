/**
 * Openly for Gmail on your phone.
 *
 * The Chrome extension cannot run inside the Gmail app, so this add-on does the one thing that is possible there:
 * while you write an email in the Gmail app, open the add-on and tap "Add tracking". It registers the email with
 * your Openly server and puts the invisible tracking image into the draft. Then you send as usual.
 *
 * You sign in with the same email as in the Chrome extension (a 6-digit code, no API key), so phone emails show up
 * in the same dashboard. It tracks opens only. It cannot rewrite links, and it cannot tell your recipients apart.
 *
 * Fill in the three values below once. They are the same ones you put in extension/config.js.
 * The Supabase anon key is public by design. Never put the service_role key here.
 */
var BACKEND_URL = 'https://openly-gamma.vercel.app';
var SUPABASE_URL = 'https://woddoqffqarbjrjuytsf.supabase.co';        // https://xxxx.supabase.co
var SUPABASE_ANON_KEY = 'sb_publishable_XiLY546OmTkqd4kckMjF3g_CTv9GoF5';   // the public "anon" key

var PROP_SESSION = 'session';
var PROP_PENDING = 'pendingEmail';
var PROP_LAST = 'lastTracked';
var PROP_WAITING = 'waitingForSend';   // tokens added to drafts, not yet matched to a sent email
var PLACEHOLDER = '(sent from phone)';
var GIVE_UP_MS = 3 * 24 * 3600 * 1000; // a tracked draft never sent within 3 days is removed from the dashboard
var SAME_DRAFT_MS = 10 * 60 * 1000;
var PROP_ATTEMPT = 'syncAttempt';
var PROP_SYNC_AT = 'lastSyncAt';
// After you add tracking, ONE short-lived check is scheduled, and only while an email is still waiting to be matched
// to its sent copy. Gmail gives add-ons no "email sent" event, so it looks again after these waits (minutes), then
// stops. Opening any email or the add-on also checks. Nothing runs on a fixed schedule.
var CHECK_AFTER_MIN = [2, 5, 15, 60, 240, 720];
// The email is registered as "sent" a little in the future. Gmail may load the image once while you are still
// writing, and Openly ignores anything that arrives before the send time.
var SEND_DELAY_MS = 3 * 60 * 1000;

/* ---------- small helpers ---------- */
function backend_() { return BACKEND_URL.replace(/\/+$/, ''); }
function cloudReady_() { return !!(SUPABASE_URL && SUPABASE_ANON_KEY); }
function props_() { return PropertiesService.getUserProperties(); }

function notify_(text, navigation) {
  var b = CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(text));
  if (navigation) b.setNavigation(navigation);
  return b.build();
}
function refreshTo_(card) {
  return CardService.newNavigation().popToRoot().updateCard(card);
}
function formValue_(e, name) {
  var inputs = (e && e.commonEventObject && e.commonEventObject.formInputs) || {};
  var f = inputs[name];
  return f && f.stringInputs && f.stringInputs.value && f.stringInputs.value[0] ? String(f.stringInputs.value[0]).trim() : '';
}

/* ---------- signing in (emailed code, same as the extension) ---------- */
function authCall_(path, body) {
  var res = UrlFetchApp.fetch(SUPABASE_URL.replace(/\/+$/, '') + path, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_ANON_KEY },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var data = null;
  try { data = JSON.parse(res.getContentText()); } catch (err) { data = null; }
  var code = res.getResponseCode();
  return { ok: code >= 200 && code < 300, code: code, data: data };
}
function getSession_() {
  try { return JSON.parse(props_().getProperty(PROP_SESSION) || 'null'); } catch (err) { return null; }
}
function storeSession_(d, email) {
  props_().setProperty(PROP_SESSION, JSON.stringify({
    access: d.access_token,
    refresh: d.refresh_token,
    expiresAt: Date.now() + (d.expires_in || 3600) * 1000,
    email: (d.user && d.user.email) || email || ''
  }));
}
// A valid access token, refreshed when it is about to run out. Returns null when the person must sign in again.
function accessToken_() {
  var s = getSession_();
  if (!s || !s.access) return null;
  if (s.expiresAt - Date.now() > 60000) return s.access;
  var r;
  try { r = authCall_('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh }); } catch (err) { return null; }
  if (!r.ok || !r.data || !r.data.access_token) { props_().deleteProperty(PROP_SESSION); return null; }
  storeSession_(r.data, s.email);
  return r.data.access_token;
}

function sendCode(e) {
  var email = formValue_(e, 'email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return notify_('Enter a valid email address.');
  var r;
  try { r = authCall_('/auth/v1/otp', { email: email, create_user: true }); } catch (err) { return notify_('Could not reach the sign-in service.'); }
  if (!r.ok) return notify_((r.data && (r.data.msg || r.data.error_description)) || 'Could not send the code. Try again in a minute.');
  props_().setProperty(PROP_PENDING, email);
  return notify_('Code sent. Check your email.', CardService.newNavigation().pushCard(codeCard_(email)));
}

function verifyCode(e) {
  var code = formValue_(e, 'code');
  var email = props_().getProperty(PROP_PENDING) || '';
  if (!code || !email) return notify_('Enter the 6-digit code.');
  var r;
  try { r = authCall_('/auth/v1/verify', { type: 'email', email: email, token: code }); } catch (err) { return notify_('Could not reach the sign-in service.'); }
  if (!r.ok || !r.data || !r.data.access_token) return notify_('That code is not right, or it has expired.');
  storeSession_(r.data, email);
  props_().deleteProperty(PROP_PENDING);
  return notify_('Signed in.', refreshTo_(composeCard_()));
}

function signOut() {
  props_().deleteProperty(PROP_SESSION);
  return notify_('Signed out.', refreshTo_(composeCard_()));
}

/* ---------- cards ---------- */
function onHomepage() {
  syncIfWaiting_();
  var s = getSession_();
  var text = !cloudReady_()
    ? 'Openly is not set up yet. Fill in SUPABASE_URL and SUPABASE_ANON_KEY at the top of Code.gs.'
    : s ? 'Signed in as ' + s.email + '.\n\nTo track an email, start writing it in Gmail, then open "Track with Openly" from the compose menu.'
        : 'Not signed in.\n\nStart writing an email in Gmail, then open "Track with Openly" from the compose menu to sign in.';
  var section = CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(text));
  if (s) {
    section.addWidget(CardService.newTextButton().setText('Update phone emails now')
      .setOnClickAction(CardService.newAction().setFunctionName('syncNow')));
  }
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Openly'))
    .addSection(section)
    .build();
}

function signInCard_() {
  var section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText('Sign in with the same email you use in the Openly Chrome extension. We will email you a 6-digit code.'))
    .addWidget(CardService.newTextInput().setFieldName('email').setTitle('Email'))
    .addWidget(CardService.newTextButton().setText('Send code').setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('sendCode')));
  return CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Sign in to Openly')).addSection(section).build();
}

function codeCard_(email) {
  var section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText('We sent a 6-digit code to ' + email + '.'))
    .addWidget(CardService.newTextInput().setFieldName('code').setTitle('Code'))
    .addWidget(CardService.newTextButton().setText('Sign in').setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('verifyCode')));
  return CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Enter your code')).addSection(section).build();
}

// Recipients the card was opened with. Kept on the button too, in case Gmail does not hand them over on the tap.
function metaParams_(meta) {
  meta = meta || {};
  return {
    to: JSON.stringify(meta.toRecipients || []),
    cc: JSON.stringify(meta.ccRecipients || []),
    bcc: JSON.stringify(meta.bccRecipients || [])
  };
}
function paramList_(e, name) {
  var p = (e && e.commonEventObject && e.commonEventObject.parameters) || (e && e.parameters) || {};
  try { return JSON.parse(p[name] || '[]'); } catch (err) { return []; }
}

function composeCard_(meta) {
  if (!cloudReady_()) {
    return CardService.newCardBuilder()
      .setHeader(CardService.newCardHeader().setTitle('Openly is not set up'))
      .addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(
        'Fill in SUPABASE_URL and SUPABASE_ANON_KEY at the top of Code.gs (the same values as extension/config.js), then try again.')))
      .build();
  }
  var s = getSession_();
  if (!s) return signInCard_();
  var recent = recentTap_(meta);
  var section = CardService.newCardSection();
  if (recent) {
    // The image is already in this draft. Adding it again would put a second image in the email.
    section.addWidget(CardService.newTextParagraph().setText(
      'Tracking is already added to this email. Just send it.\n\nIf this is a different, new email, tap the button below.'))
      .addWidget(CardService.newTextButton().setText('This is a new email: add tracking again')
        .setOnClickAction(CardService.newAction().setFunctionName('addTracking')
          .setParameters(Object.assign({ forceNew: '1' }, metaParams_(meta)))));
  } else {
    section.addWidget(CardService.newTextParagraph().setText(
      'Write your email and add the recipients first, then tap Add tracking. That is all.'))
      .addWidget(CardService.newTextButton().setText('Add tracking').setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOnClickAction(CardService.newAction().setFunctionName('addTracking').setParameters(metaParams_(meta))));
  }
  section
    .addWidget(CardService.newTextParagraph().setText('Signed in as ' + s.email))
    .addWidget(CardService.newTextButton().setText('Sign out')
      .setOnClickAction(CardService.newAction().setFunctionName('signOut')));
  return CardService.newCardBuilder().setHeader(CardService.newCardHeader().setTitle('Track with Openly')).addSection(section).build();
}

function onCompose(e) {
  return composeCard_(e && e.draftMetadata);
}

/* ---------- adding the tracking image ---------- */
function list_(v) {
  return (v || []).map(function (x) { return String(x).replace(/^.*<([^>]+)>.*$/, '$1').trim(); }).filter(String);
}

// The tracked draft this card belongs to, if tracking was added a few minutes ago for the same recipients.
function recentTap_(meta) {
  var last = readJson_(PROP_LAST, {});
  if (!last.token || Date.now() - last.at > SAME_DRAFT_MS) return null;
  return last.signature === signatureOf_(meta || {}) ? last : null;
}
function signatureOf_(meta) {
  return JSON.stringify([list_(meta.toRecipients).sort(), list_(meta.ccRecipients).sort(), list_(meta.bccRecipients).sort()]);
}
function readJson_(key, fallback) {
  try { var v = JSON.parse(props_().getProperty(key) || 'null'); return v == null ? fallback : v; } catch (err) { return fallback; }
}

function addTracking(e) {
  var access = accessToken_();
  if (!access) return notify_('Please sign in again.', refreshTo_(composeCard_()));

  // Gmail does not share the subject with add-ons. It is filled in from the Sent folder after you send (see syncPhoneEmails).
  var meta = (e && e.draftMetadata) || {};
  var to = list_(meta.toRecipients), cc = list_(meta.ccRecipients), bcc = list_(meta.bccRecipients);
  if (!to.length && !cc.length && !bcc.length) { to = list_(paramList_(e, 'to')); cc = list_(paramList_(e, 'cc')); bcc = list_(paramList_(e, 'bcc')); }
  var forceNew = !!(e && e.commonEventObject && e.commonEventObject.parameters && e.commonEventObject.parameters.forceNew) ||
                 !!(e && e.parameters && e.parameters.forceNew);

  // Tapping twice for the same draft must neither add a second image nor create a second tracked email.
  var signature = signatureOf_({ toRecipients: to, ccRecipients: cc, bccRecipients: bcc });
  var last = readJson_(PROP_LAST, {});
  var repeat = !forceNew && last.token && last.signature === signature && Date.now() - last.at < SAME_DRAFT_MS;
  if (repeat) return notify_('Tracking is already added to this email. Just send it.');
  var token = Utilities.getUuid();

  var res;
  try {
    res = UrlFetchApp.fetch(backend_() + '/api/emails', {
      method: 'post',
      contentType: 'application/json',
      headers: { authorization: 'Bearer ' + access },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        token: token,
        to: to, cc: cc, bcc: bcc,
        subject: PLACEHOLDER,
        links: [],
        remindAfterHours: 0,
        sentAt: new Date(Date.now() + SEND_DELAY_MS).toISOString()
      })
    });
  } catch (err) {
    return notify_('Could not reach your Openly server. Nothing was added.');
  }
  var code = res.getResponseCode();
  if (code === 401) { props_().deleteProperty(PROP_SESSION); return notify_('Please sign in again.', refreshTo_(composeCard_())); }
  if (code !== 201) return notify_('Your server refused it (' + code + '). Nothing was added.');

  props_().setProperty(PROP_LAST, JSON.stringify({ token: token, signature: signature, at: Date.now() }));
  var waiting = readJson_(PROP_WAITING, []);
  waiting.push({ token: token, at: Date.now() });
  props_().setProperty(PROP_WAITING, JSON.stringify(waiting.slice(-50)));
  armSync_(true);

  var pixel = '<img src="' + backend_() + '/t/' + token + '.gif" alt="" width="1" height="1" ' +
    'style="border:0;width:1px;height:1px;opacity:0;">';
  return CardService.newUpdateDraftActionResponseBuilder()
    .setUpdateDraftBodyAction(CardService.newUpdateDraftBodyAction()
      .addUpdateContent(pixel, CardService.ContentType.MUTABLE_HTML)
      .setUpdateType(CardService.UpdateDraftBodyType.IN_PLACE_INSERT))
    .build();
}

/* ---------- after you send: fill in the real subject, recipients and send time ----------
   The add-on never sees the subject of a draft, so it finds the sent email by its tracking image and copies the
   subject, recipients and time to Openly. It runs every 5 minutes (run setupSync once), or from the home card. */
// Run once after updating: removes the old every-5-minutes trigger and does a first check (which asks for Gmail access).
function setupSync() {
  removeOldTriggers_();
  return syncPhoneEmails();
}
function removeOldTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncPhoneEmails') ScriptApp.deleteTrigger(t); // the old recurring one
  });
}
// Schedules the single next check, or none when nothing is waiting or the checks have run out.
function armSync_(restart) {
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'syncAfterSend') ScriptApp.deleteTrigger(t);
    });
    if (!readJson_(PROP_WAITING, []).length) { props_().deleteProperty(PROP_ATTEMPT); return; }
    var attempt = restart ? 0 : Number(props_().getProperty(PROP_ATTEMPT) || 0);
    if (attempt >= CHECK_AFTER_MIN.length) return;
    props_().setProperty(PROP_ATTEMPT, String(attempt + 1));
    ScriptApp.newTrigger('syncAfterSend').timeBased().after(CHECK_AFTER_MIN[attempt] * 60 * 1000).create();
  } catch (err) { /* tracking itself must never fail because of this */ }
}
function syncAfterSend() {
  syncPhoneEmails();
  armSync_(false);
}
// Checks only when something is waiting, and at most twice a minute.
function syncIfWaiting_() {
  if (!readJson_(PROP_WAITING, []).length) return;
  var last = Number(props_().getProperty(PROP_SYNC_AT) || 0);
  if (Date.now() - last < 30000) return;
  props_().setProperty(PROP_SYNC_AT, String(Date.now()));
  try { syncPhoneEmails(); } catch (err) { /* try again next time */ }
}
// Runs when you open an email in Gmail.
function onMessageOpen() {
  syncIfWaiting_();
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Openly'))
    .addSection(CardService.newCardSection().addWidget(CardService.newTextParagraph().setText(
      'Write an email and open \"Track with Openly\" from the compose menu to track it.')))
    .build();
}

function addresses_(text) {
  return (String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(function (x) { return x.toLowerCase(); });
}

function apiCall_(access, method, path, body) {
  var opts = { method: method, headers: { authorization: 'Bearer ' + access }, muteHttpExceptions: true };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  return UrlFetchApp.fetch(backend_() + path, opts).getResponseCode();
}

function syncPhoneEmails() {
  try { removeOldTriggers_(); } catch (err) { /* ignore */ }
  var lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) return 0;
  try {
    var waiting = readJson_(PROP_WAITING, []);
    if (!waiting.length) return 0;
    var access = accessToken_();
    if (!access) return 0;

    var oldest = waiting.reduce(function (m, w) { return Math.min(m, w.at); }, Date.now());
    var threads;
    try {
      threads = GmailApp.search('in:sent after:' + Math.floor((oldest - 3600 * 1000) / 1000), 0, 50);
    } catch (err) {
      return 0; // no Gmail permission yet: keep everything for the next run
    }
    var byToken = {};
    threads.forEach(function (th) {
      th.getMessages().forEach(function (m) {
        if (m.isDraft()) return;
        var html = m.getBody();
        waiting.forEach(function (w) {
          if (html.indexOf(w.token) !== -1) byToken[w.token] = m;
        });
      });
    });

    var left = [], done = 0;
    waiting.forEach(function (w) {
      var m = byToken[w.token];
      if (m) {
        var status;
        try {
          status = apiCall_(access, 'post', '/api/emails/' + w.token + '/details', {
            subject: m.getSubject() || '(no subject)',
            to: addresses_(m.getTo()), cc: addresses_(m.getCc()), bcc: addresses_(m.getBcc()),
            sentAt: m.getDate().toISOString()
          });
        } catch (err) { left.push(w); return; }
        if (status === 200 || status === 404) { done++; return; } // 404: already removed (for example by the Chrome extension)
        left.push(w);
      } else if (Date.now() - w.at > GIVE_UP_MS) {
        // Tracking was added but the email was never sent: remove the empty record so it does not clutter the dashboard.
        try { apiCall_(access, 'delete', '/api/emails/' + w.token); } catch (err) { left.push(w); }
      } else {
        left.push(w);
      }
    });
    props_().setProperty(PROP_WAITING, JSON.stringify(left));
    return done;
  } finally {
    lock.releaseLock();
  }
}

function syncNow() {
  var n = syncPhoneEmails();
  return notify_(n ? 'Updated ' + n + ' email' + (n === 1 ? '' : 's') + '.' : 'Nothing new to update yet. Sent emails appear here a minute after you send.');
}
