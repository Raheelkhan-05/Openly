# Tracking emails you send from your phone

The Chrome extension cannot run inside the Gmail app. The add-on in `addon/` covers that gap: while you write an
email in the Gmail app, you tap **Add tracking** and the tracking image is put into the draft.

## What it can and cannot do

| | |
|---|---|
| Tracks opens | Yes |
| Shows desktop or mobile for each open | Same rules as everywhere (see below) |
| Tracks link clicks | No. Links in a draft cannot be rewritten from an add-on. |
| Tells recipients apart | No. One email has one image. |
| Real subject, recipients and send time | Yes, filled in automatically a few minutes after you send (see "After you send") |
| Automatic | No. You tap **Add tracking** on each email, before you send. |

If you tap it and then do not send the email, it shows in the dashboard as an email nobody opened. Delete the record.

## Set up (about 5 minutes)

1. Go to https://script.google.com and create a new project named `Openly`.
2. Project Settings: tick **Show "appsscript.json" manifest file in editor**.
3. Replace the contents of `Code.gs` with `addon/Code.gs` and `appsscript.json` with `addon/appsscript.json`.
4. Deploy > **Test deployments** > Install. (Your own account only. Publishing to the Marketplace needs Google's review.)
5. Open Gmail on the web once and accept the permissions.
6. In the Gmail app, start a new email. In the compose screen's top-right menu, open **Track with Openly**.
7. First time only: it asks for your email, then the 6-digit code it sends you. Use the same email as in the Chrome
   extension, so phone emails appear in the same dashboard.
8. Write the email, open **Track with Openly**, tap **Add tracking**, then send.

Before step 4, fill in the three values at the top of `Code.gs` (`BACKEND_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`).
They are the same ones as in `extension/config.js`. The add-on signs in the same way as the extension, so there is no
API key. It needs a server running in the signed-in (Supabase) mode.

## Desktop or mobile: what Openly can know

- **Link click:** the reader's own browser or app calls your server, so the device is exact.
- **Image loaded directly** (Outlook, Apple Mail without Privacy Protection, Thunderbird): exact.
- **Image loaded by Gmail, Yahoo or Apple's privacy network:** the device is hidden. Openly says so and does not guess.

## After you send: subject, recipients, send time

Gmail never gives an add-on the subject of a draft, and does not reliably give the recipients. So the add-on finds
your sent email in the Sent folder (by its tracking image) and fills them in. Until then the email shows as
"(sent from phone)".

One-time setup, in the Apps Script editor:
1. Add `gmail.readonly` and `script.scriptapp` (already in `addon/appsscript.json`) and save.
2. Pick `setupSync` in the function list and press Run. Accept the permissions.
3. Reinstall the test deployment.

After that it checks every 5 minutes. You can also open the add-on home screen and tap **Update phone emails now**.
It only reads emails sent since you tapped Add tracking, looks for Openly's image, and never stores your messages.

## Using the extension and the add-on on the same email

If you tap **Add tracking** in the add-on while writing in Gmail on a computer, the Chrome extension notices that image
and uses it instead of adding a second one, so you get one record with the real subject and recipients.