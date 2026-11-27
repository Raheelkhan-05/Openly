# Openly: email open tracking for Gmail

Built by **Raheelkhan Lohani**. Licensed under AGPL-3.0 (see `LICENSE`).

Openly tells you when the emails you send from Gmail are opened or clicked, **and how sure it is**. Most trackers show a green tick for anything that loads an image, including your own views, scanners and Apple Mail preloads. Openly separates them.

## What makes it different

| | Typical trackers | Openly |
|---|---|---|
| Your own views | Often counted | Excluded on your computer automatically. Pause counting from the popup when you check on your phone. "That was me" fixes any single event |
| Scanners and preloads | Counted as reads | Labelled "Possible", never counted. Apple privacy network and Apple Mail preloads are recognised |
| Images blocked | Opens missed | Optional link-click tracking confirms a real person |
| How sure? | Always a green tick | High, medium or low confidence, with the reason |
| Forwarded emails | Invisible | Shows when it sees more than one device |
| Extras | Paid | Follow-up reminders, send-time insights, export and delete all your data |
| Your emails | Footer ad: "Sent with..." | Nothing added that recipients can see |
| Who sees your data | The vendor | Only you. Open source, and you can run your own |

## Parts

| Folder | What it is |
|---|---|
| `extension/` | Chrome extension (Manifest V3). No build step |
| `backend/` | Node.js + Express server (runs on Vercel, or any always-on host) |
| `supabase/schema.sql` | The database tables |
| `tools/brand.js` | Signs the code and hides your encrypted authorship claim |
| `docs/` | Deploy guide, store listing, privacy policy template |

## Get going

Read `docs/DEPLOY.md`. In short: one hosted server for everyone who signs in, or each person runs their own.

To try it on your own machine without a database:
```bash
cd backend && npm install
API_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") AUTH_MODE=apikey DB_DRIVER=memory npm start
```
Then load `extension/` in `chrome://extensions` (Developer mode, Load unpacked), choose **My own server**, and use a public tunnel address (for example `npx cloudflared tunnel --url http://localhost:8787`) because recipients' mail apps must be able to reach it.

## What it can't do (honest limits)
- **One email to several people** has one tracking image, so an open can't be matched to a person. Send separate emails for that. (A future version could send them for you.)
- **Opening your sent email on your phone** looks like a recipient open. Pause counting first, or use "That was me".
- **Apple Mail Privacy Protection** is recognised when the server can load Apple's address list (`APPLE_RANGES=on`, on a server that stays on) or when Apple Mail loads images right after delivery. It can't be caught every time.
- **Gmail changes its page** now and then. The few selectors that depend on it are at the top of `extension/content/gmail.js`.
- **Link tracking** sends clicks through your server. A few spam filters dislike that, so it is off by default.

## Proof that this is yours

There are two layers:

1. **Visible:** your name is in the license, this README, the manifest, the About card in Settings.
2. **Hidden and cryptographic:** run `node tools/brand.js init` once. It
   - creates an Ed25519 signing key, kept encrypted (scrypt + AES-256-GCM) with your passphrase in `.brand/`,
   - hides an encrypted claim ("Raheelkhan Lohani, original author and owner", with a timestamp) in the extension, the server, and `BRAND.sig.json`,
   - makes every tracking image the server sends carry your key fingerprint inside the GIF,
   - signs a hash of every source file.

   Anyone can run `node tools/brand.js verify` to check that a copy is exactly what you signed. Only you, with the passphrase, can run `reveal`.

**Be realistic about what this proves.** Someone can delete the stamps from a copy. What stays true is that only the holder of your key could have produced a valid signature on the original, and you can show it. For the claim to hold up, also publish the code on GitHub early (the history is a public timestamp), keep the Chrome Web Store account and domain in your name, and back up `.brand/`. If you lose the passphrase, the hidden claim cannot be read again.

## Tests
`npm test` (20 backend tests). The extension has no build step; load it unpacked and try it.
