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
| Automatic | No. You tap **Add tracking** on each email, before you send. |

If you tap it and then do not send the email, it shows in the dashboard as an email nobody opened. Delete the record.

## Set up (about 5 minutes)

1. Go to https://script.google.com and create a new project named `Openly`.
2. Project Settings: tick **Show "appsscript.json" manifest file in editor**.
3. Replace the contents of `Code.gs` with `addon/Code.gs` and `appsscript.json` with `addon/appsscript.json`.
4. Deploy > **Test deployments** > Install. (Your own account only. Publishing to the Marketplace needs Google's review.)
5. Open Gmail on the web once and accept the permissions.
6. In the Gmail app, start a new email. In the compose screen's top-right menu, open **Track with Openly**.
7. First time only: open Settings, enter your server address and API key, tap Save.
8. Write the email, open **Track with Openly**, tap **Add tracking**, then send.

The add-on uses your server's API key, so it works with a self-hosted server. It does not work with the signed-in
(Supabase) mode yet.

## Desktop or mobile: what Openly can know

- **Link click:** the reader's own browser or app calls your server, so the device is exact.
- **Image loaded directly** (Outlook, Apple Mail without Privacy Protection, Thunderbird): exact.
- **Image loaded by Gmail, Yahoo or Apple's privacy network:** the device is hidden. Openly says so and does not guess.