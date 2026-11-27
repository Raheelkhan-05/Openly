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
| Automatic | Almost. Choosing **Track with Openly** in the compose menu adds tracking in one tap (`ONE_TAP` in `Code.gs`; set it to `false` for the old card with an Add tracking button). Gmail gives add-ons no way to run on its own when you open a compose. |

If you tap it and then never send the email, the empty record is removed automatically after 3 days.
Tapping **Add tracking** twice on the same draft does not add a second image: the card tells you tracking is already there.
Use **This is a new email: add tracking again** only for a different email.

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

Nothing runs on a fixed schedule. After you tap **Add tracking**, one short check is scheduled (after 2, 5, 15, 60,
240 and 720 minutes, and only while that email is still waiting). The add-on also checks when you open any email in
Gmail or open the add-on, and when you tap **Update phone emails now**.

One-time setup, in the Apps Script editor:
1. Replace `Code.gs` and `appsscript.json`, save.
2. Pick `setupSync` in the function list and press Run. This deletes every old trigger (the 5-minute one and any leftovers such as `syncSent`) and asks for Gmail access.
3. Reinstall the test deployment.

It only reads emails sent since you tapped Add tracking, looks for Openly's image, and never stores your messages.

## Using the extension and the add-on on the same email

If you tap **Add tracking** in the add-on while writing in Gmail on a computer, the Chrome extension notices that image
and uses it instead of adding a second one, so you get one record with the real subject and recipients.

The add-on home card shows when the last check ran and why it could not schedule or read Gmail, if it could not.
Scheduled checks can run a few minutes after their time: Google does not run one-off triggers to the second.


## Seeing who opened an email, and the dashboard on your phone

- **Web dashboard:** `https://YOUR-SERVER/app/` is the same dashboard as the extension, in any browser. Sign in once with the
  same email (6-digit code). On a phone, use the browser menu > Add to Home screen to keep it like an app.
- **Summary on the email:** open a tracked sent email in Gmail on a computer and a bar above the message shows opened or not,
  how many times, when and where, with a Details button. In the Gmail app, open the email and then the Openly add-on: it shows
  the same summary and an Open dashboard button.
- **Find in Gmail:** every email in the dashboard has a Find in Gmail button that searches your Sent mail by recipient, subject and date.

After changing `extension/dashboard`, `extension/ui` or `extension/shared.js`, run `npm run build:web` and redeploy the backend.
