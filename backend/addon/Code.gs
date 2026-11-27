/**
 * Openly for Gmail on your phone.
 *
 * The Chrome extension cannot run inside the Gmail app, so this add-on does the one thing that is possible there:
 * while you write an email in the Gmail app, open the add-on and tap "Add tracking". It registers the email with
 * your Openly server and puts the invisible tracking image into the draft. Then you send as usual.
 *
 * It tracks opens only. It cannot rewrite links, and it cannot tell your recipients apart.
 */

var PROP_URL = 'backendUrl';
var PROP_KEY = 'apiKey';
var PROP_LAST = 'lastTracked';
// The email is registered as "sent" a little in the future. Gmail may load the image once while you are still
// writing, and Openly ignores anything that arrives before the send time.
var SEND_DELAY_MS = 3 * 60 * 1000;

/* ---------- settings ---------- */
function getConfig_() {
  var p = PropertiesService.getUserProperties();
  return { url: (p.getProperty(PROP_URL) || '').replace(/\/+$/, ''), key: p.getProperty(PROP_KEY) || '' };
}
function isConfigured_() {
  var c = getConfig_();
  return !!(c.url && c.key);
}
function notify_(text) {
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .build();
}

function onHomepage() {
  return settingsCard_();
}

function settingsCard_() {
  var c = getConfig_();
  var section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(
      'Enter the address of your Openly server and your API key. They are saved only in your Google account.'))
    .addWidget(CardService.newTextInput().setFieldName('backendUrl').setTitle('Server address')
      .setHint('https://your-openly.vercel.app').setValue(c.url))
    .addWidget(CardService.newTextInput().setFieldName('apiKey').setTitle('API key').setValue(c.key))
    .addWidget(CardService.newTextButton().setText('Save')
      .setOnClickAction(CardService.newAction().setFunctionName('saveSettings')));
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Openly settings'))
    .addSection(section)
    .build();
}

function formValue_(e, name) {
  var inputs = (e && e.commonEventObject && e.commonEventObject.formInputs) || {};
  var f = inputs[name];
  return f && f.stringInputs && f.stringInputs.value && f.stringInputs.value[0] ? String(f.stringInputs.value[0]).trim() : '';
}

function saveSettings(e) {
  var url = formValue_(e, 'backendUrl').replace(/\/+$/, '');
  var key = formValue_(e, 'apiKey');
  if (!/^https:\/\/[^\s]+$/i.test(url)) return notify_('The server address must start with https://');
  if (!key) return notify_('Enter your API key.');
  // Check the details before saving them.
  try {
    var res = UrlFetchApp.fetch(url + '/api/ping', { headers: { 'x-api-key': key }, muteHttpExceptions: true });
    if (res.getResponseCode() === 401) return notify_('The API key is not correct.');
    if (res.getResponseCode() !== 200) return notify_('The server answered with an error (' + res.getResponseCode() + ').');
  } catch (err) {
    return notify_('Could not reach the server. Check the address.');
  }
  var p = PropertiesService.getUserProperties();
  p.setProperty(PROP_URL, url);
  p.setProperty(PROP_KEY, key);
  return notify_('Saved. You can now track emails.');
}

/* ---------- compose ---------- */
function onCompose() {
  if (!isConfigured_()) return settingsCard_();
  var section = CardService.newCardSection()
    .addWidget(CardService.newTextParagraph().setText(
      'Tap once to add the invisible tracking image to this email, then send it as usual. ' +
      'Tracks opens only. It cannot tell your recipients apart.'))
    .addWidget(CardService.newTextInput().setFieldName('label').setTitle('Name for your dashboard (optional)')
      .setHint('Gmail does not share the subject with add-ons'))
    .addWidget(CardService.newSelectionInput().setType(CardService.SelectionInputType.DROPDOWN)
      .setFieldName('remind').setTitle('Remind me if not opened')
      .addItem('Off', '0', true).addItem('In 1 day', '24', false).addItem('In 3 days', '72', false).addItem('In 1 week', '168', false))
    .addWidget(CardService.newTextButton().setText('Add tracking').setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('addTracking')))
    .addWidget(CardService.newTextButton().setText('Settings')
      .setOnClickAction(CardService.newAction().setFunctionName('openSettings')));
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Track with Openly'))
    .addSection(section)
    .build();
}

function openSettings() {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().pushCard(settingsCard_()))
    .build();
}

function list_(v) {
  return (v || []).map(function (x) { return String(x).replace(/^.*<([^>]+)>.*$/, '$1').trim(); }).filter(String);
}

function addTracking(e) {
  var c = getConfig_();
  if (!c.url || !c.key) return notify_('Open Settings and add your server details first.');

  var meta = (e && e.draftMetadata) || {};
  var to = list_(meta.toRecipients), cc = list_(meta.ccRecipients), bcc = list_(meta.bccRecipients);
  var label = formValue_(e, 'label');
  var remind = Number(formValue_(e, 'remind')) || 0;

  // Tapping twice for the same draft must not make two different tracked emails.
  var props = PropertiesService.getUserProperties();
  var signature = JSON.stringify([to, cc, bcc, label]);
  var last = {};
  try { last = JSON.parse(props.getProperty(PROP_LAST) || '{}'); } catch (err) { last = {}; }
  var token = (last.signature === signature && Date.now() - last.at < 10 * 60 * 1000) ? last.token : Utilities.getUuid();

  var res;
  try {
    res = UrlFetchApp.fetch(c.url + '/api/emails', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': c.key },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        token: token,
        to: to, cc: cc, bcc: bcc,
        subject: label ? label : '(sent from phone)',
        links: [],
        remindAfterHours: remind,
        sentAt: new Date(Date.now() + SEND_DELAY_MS).toISOString()
      })
    });
  } catch (err) {
    return notify_('Could not reach your Openly server. Nothing was added.');
  }
  var code = res.getResponseCode();
  if (code === 401) return notify_('The API key is not correct. Open Settings.');
  if (code !== 201) return notify_('Your server refused it (' + code + '). Nothing was added.');

  props.setProperty(PROP_LAST, JSON.stringify({ token: token, signature: signature, at: Date.now() }));

  var pixel = '<img src="' + c.url + '/t/' + token + '.gif" alt="" width="1" height="1" ' +
    'style="border:0;width:1px;height:1px;opacity:0;">';
  return CardService.newUpdateDraftActionResponseBuilder()
    .setUpdateDraftBodyAction(CardService.newUpdateDraftBodyAction()
      .addUpdateContent(pixel, CardService.ContentType.MUTABLE_HTML)
      .setUpdateType(CardService.UpdateDraftBodyType.IN_PLACE_INSERT))
    .build();
}