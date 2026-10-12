# Syria Healthcare platform

Accounts and (in later steps) appointment booking for patients and doctors. It runs on the company's own server at `app.syriahealthcare.com`, separately from the public website, which stays on GitHub Pages.

**Status: Stage 1, step 1 of 6: accounts and sign-in.** Next: doctor profiles and approval, opening hours, booking, doctor dashboard, public doctor list.

## What works now

| Who | How they sign in | Rules |
|---|---|---|
| Patient | Mobile number and a 6-digit SMS code | Max 3 codes per number per 15 min; a code is valid for 5 minutes, works once, and allows 5 tries. New patients give their name and accept the privacy policy. |
| Doctor | Email and password (at least 10 characters), self-registration | Starts as "waiting for verification"; approval comes in step 2. |
| Admin | Email and password, created on the server only | `npm run create-admin -- you@company.com "Your Name"` |

Five wrong passwords lock an account for 15 minutes. Sessions last 30 days for patients, 7 for doctors and 1 for admins. Every page is in Arabic and English.

### Security built in
- Passwords stored with scrypt; SMS codes and session tokens stored only as hashes.
- Session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- Requests from other websites are rejected (Origin check); strict security headers (CSP, no framing, HSTS in production).
- Limits per phone, per account and per network address. Address limits are generous because Syrian mobile carriers share addresses between many customers.
- Unknown emails get the same answer and the same delay as wrong passwords.
- An audit log records registrations and admin actions.
- No medical data is stored.

## Run it on this computer

Requires Node 22 and PostgreSQL.

```sh
cd platform
npm install
# DATABASE_URL defaults to postgres://postgres@127.0.0.1:54329/shc_dev
npm run dev          # http://127.0.0.1:3000
npm test             # uses postgres://postgres@127.0.0.1:54329/shc_test (or TEST_DATABASE_URL); it wipes that database
```

In development, SMS codes are not sent. They appear in the server log as `[development SMS]`.

## Install on the company server

1. Use a Linux server with Docker, and open ports 80 and 443.
2. Point DNS: add an `A` record for `app.syriahealthcare.com` with the server's IP address.
3. Copy this `platform` folder to the server, then run `cp .env.example .env` and fill in `.env` (see the comments in the file).
4. Run `docker compose up -d --build`. Caddy gets the HTTPS certificate automatically.
5. Create the first admin: `docker compose exec app node src/create-admin.js admin@company.com "Name"`.
6. Check that https://app.syriahealthcare.com/api/health returns `{"ok":true}`.

Backups: a compressed database dump is written to `platform/backups/` every night, and the last 14 days are kept. Copy these files off the server regularly (to another machine or storage), because a backup on the same disk does not survive a disk failure.

Updates: `git pull && docker compose up -d --build`. Database changes in `migrations/` are applied automatically on start.

## Before going live
- Choose an SMS provider that delivers to Syrian numbers, and adapt `src/sms.js` to its API if it is not "POST JSON with a bearer token".
- Complete and legally review `public/privacy.html` (it is marked DRAFT).
- Check the Ministry of Health's health-app licensing requirements: https://moh.gov.sy/health-app-licensing
- Decide where the server is hosted (inside or outside Syria) and state it in the privacy policy.
