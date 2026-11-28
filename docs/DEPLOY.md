# Putting Openly in front of people

## The short answer

The extension alone can't track anything. Tracking works because the email contains an image that loads from **a server on the internet**. So one server has to be online, all the time, with a public https address.

You have two choices:

| | You host one server (Openly Cloud) | Everyone runs their own |
|---|---|---|
| What a user does | Install the extension, type their email, enter the 6-digit code. Done. | Deploy a server and database first, then paste an address and key. |
| Who can use it | Anyone | Developers |
| Your cost | Server and database for everyone | Nothing |
| Best for | A real product you show people | Open-source fans, privacy purists |

**Do both.** Publish the code on GitHub (people who like to self-host use it), and run one hosted server that regular people sign in to. The same code does both.

Vercel is fine for the server. GitHub alone is not enough, because GitHub only stores files; it can't serve the tracking image.

---

## A. Run Openly Cloud (the hosted product)

### 1. Database
1. Create a project at supabase.com.
2. SQL Editor: paste `supabase/schema.sql`, run it.
3. Project settings > API: copy the **URL**, the **anon key** (public) and the **service_role key** (secret).

### 2. Sign-in by emailed code
1. Authentication > Providers > Email: turn it on.
2. Authentication > Email Templates: open **Magic Link** and **Confirm signup**. In both, add this line so the email shows the code: `Your Openly code is {{ .Token }}`
3. Authentication > SMTP Settings: connect a real email sender (Resend, Brevo, Postmark all have free tiers). Supabase's built-in sender only allows a few emails an hour, which will break sign-in for real users.

### 3. Deploy the server on Vercel
1. Push this repo to GitHub. In Vercel, import it and set **Root Directory** to `backend`.
2. Add environment variables:
   - `AUTH_MODE` = `supabase`
   - `SUPABASE_URL` = your project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = the secret key
3. Deploy. Open `https://your-app.vercel.app/healthz`. It should say `{"ok":true}`.

Notes:
- Vercel's free Hobby plan is for personal, non-commercial use. If you charge money, use Pro.
- A server that **sleeps** (Render's free plan does) will miss opens, because the first request after sleeping can take a minute. Vercel does not sleep. Railway and Fly.io (always on) also work.
- Supabase free projects pause after a week with no activity. Fine for a demo, upgrade for real users.

### 4. Point the extension at it
Edit `extension/config.js`:
```js
hostedUrl: 'https://your-app.vercel.app',
supabaseUrl: 'https://xxxx.supabase.co',
supabaseAnonKey: '<the anon key>',
```
The anon key is meant to be public. The `service_role` key must never go in the extension.

### 5. Try it yourself first
Load the extension (see below), sign in, send yourself a tracked email from Gmail to a second address, open it there.

---

## Making it fast

Where the time goes, and what Openly now does about it:

- **Signing in on every request.** Tokens are now checked on the server itself, against Supabase's public keys, so there is no
  round trip to Supabase per request. (Older projects that sign with a shared secret: set `SUPABASE_JWT_SECRET`.)
- **The tracking image.** It answers immediately and saves the open afterwards, so a reader's mail app never waits for your database.
  On Vercel this uses `waitUntil` (package `@vercel/functions`). If you ever see opens go missing, set `DEFER_WRITES=off`.
- **The dashboard.** Lists and details are remembered until something changes, one database round trip fetches everything about one
  email, unchanged lists answer `304 Not Modified`, and the dashboard shows its last copy instantly and refreshes behind it.
- **Redis (optional).** Without it the cache lives inside each server instance, which is fine at small scale. With Upstash Redis
  (free tier) every instance shares it, so repeat requests skip the database entirely. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
- **Put the server next to the database.** This matters more than everything above. Supabase > Project Settings > Infrastructure shows
  your database region. In Vercel > Project Settings > Functions, pick the nearest region (for example Mumbai `bom1` for ap-south-1).
  A server in the US talking to a database in India pays about 200 ms on every database call.

## B. Self-hosting (someone running it just for themselves)
Same steps, but in step 3 set `AUTH_MODE=apikey` and `API_KEY=<long random string>`, and in the extension choose **My own server** and paste the address and key. No sign-in service needed.

---

## Sharing the extension

**GitHub (quickest, rougher):** tag a release (`git tag v1.0.0 && git push --tags`). The included workflow runs the tests and attaches `openly-extension-v1.0.0.zip`. Users unzip it, open `chrome://extensions`, turn on Developer mode, click Load unpacked. Chrome shows a "developer mode" warning each time it starts and never updates it automatically. Fine for early testers, not for the public.

**Chrome Web Store (what real users expect):**
1. Create a developer account (one-time $5 fee).
2. Zip the `extension` folder and upload it.
3. Fill in the listing (`docs/STORE_LISTING.md` has text you can paste) and link a privacy policy (`docs/PRIVACY.md`, host it on any public page).
4. Review usually takes a few days. Extensions that read Gmail pages get a closer look, so be clear and honest in the permission explanations.

## Before you promote it
- Tracking people's emails is regulated in some places (for example the EU). Tell your users to be open with their recipients where the law requires it. Have a lawyer read the privacy policy.
- Keep the first version small: invite 10 to 20 people, read their feedback, then widen.

## Branding and proof of authorship
Run these once, on your own computer:
```bash
node tools/brand.js init     # asks for a passphrase, creates your key, signs everything
node tools/brand.js verify   # anyone can run this to check the code is as you signed it
```
Re-run `node tools/brand.js sign` before each release. Keep `.brand/` private and backed up. See the README for what this does and doesn't prove.
