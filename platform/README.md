# Syria Healthcare platform

Accounts and (in later steps) appointment booking for patients and doctors. It runs on the company's own server at `app.syriahealthcare.com`, separately from the public website, which stays on GitHub Pages.

**Status: Stage 1, steps 1–5 of 6 done:** accounts and sign-in, doctor profiles and approval, opening hours, patient booking, and the doctor dashboard. Labs, imaging centres, hospitals and clinics can also register and get listed on syriahealthcare.com after review.

## What works now

| Who | How they sign in | Rules |
|---|---|---|
| Patient | Mobile number and a 6-digit code by WhatsApp or SMS | Max 3 codes per number per 15 min; a code is valid for 5 minutes, works once, and allows 5 tries. New patients give their name and accept the privacy policy. |
| Doctor | Email and password (at least 10 characters), self-registration | Fills in a profile and uploads a licence; must be approved by an admin before patients can see them. |
| Lab, imaging centre, hospital or clinic | Email and password, self-registration (same sign-in page as doctors) | Fills in the facility's details and uploads its operating licence; must be approved by an admin before it is listed on syriahealthcare.com. |
| Admin | Email and password, created on the server only | `npm run create-admin -- you@company.com "Your Name"` |

### Doctor verification (step 2)

1. **Doctor** (`/doctor`) fills in specialty, governorate, area, clinic name, address and phone, licence number and an optional short introduction.
2. **Doctor** uploads their licence to practise (required) and optionally a syndicate card: PDF, JPG or PNG, up to 5 MB and at most 6 files. The file's real content is checked, not its name. Files are encrypted with AES-256-GCM before they touch the disk.
3. **Doctor** sends the profile for review. This only works when every required field is filled and a licence is uploaded.
4. **Admin** (`/admin`) sees doctors by status, opens the documents (every opening is logged), and either approves the doctor or asks for changes with a note the doctor sees.
5. A doctor who changes an approved profile goes back to "waiting for review", so patients only ever see reviewed details. Documents are locked after approval.
6. **Admin** can suspend an approved doctor with a reason, and reinstate them later. Every step appears in the doctor's history.

### Labs, imaging centres, hospitals and clinics

1. **Facility** registers at `/staff` and chooses its type (laboratory, imaging centre, hospital, or medical centre/clinic). The account holder is the contact person; the facility's name goes in its profile. `/staff#register-lab` and `/staff#register-hospital` open the form with the type already chosen.
2. **Facility** (`/facility`) fills in its name, governorate, area, address, phone and licence number, and optionally its services (a fixed list per type, e.g. hormones or PCR for labs, CT or MRI for imaging), an emergency department (hospitals and clinics), opening hours and a short description.
3. **Facility** uploads its operating licence (required) and sends the profile for review. Documents follow the same rules as doctors' documents: PDF, JPG or PNG up to 5 MB, encrypted at rest, locked after approval.
4. **Admin** (`/admin`, tab "Labs, hospitals and clinics") approves, asks for changes or suspends, with the same notes and history as for doctors.
5. Changing an approved profile sends it back for review. `GET /api/facilities` lists approved facilities with public details only: never the contact person, email, licence number or documents.
6. The website's collector copies them to syriahealthcare.com: labs and imaging centres to the Labs page, hospitals and clinics to the Hospitals page, each marked "Verified licence".

### Opening hours (step 3)

Doctors set their hours at `/schedule`:
- **Appointment length:** 10–60 minutes.
- **Booking window:** how far ahead patients may book (7–90 days).
- **Minimum notice:** none, or 1–48 hours.
- **Weekly hours:** up to 3 time ranges per day, e.g. 10:00–14:00 and 17:00–20:00, with a button to copy one day's times to every open day.
- **Days off:** holidays, travel or conferences.

A preview shows exactly which free appointments patients will see over the next 7 days. All times are Syria time (Asia/Damascus); the conversion also handles time zones with daylight saving. Patients only see free slots for approved doctors (`GET /api/doctors/:id/slots`). Changing hours does not need a new review.

### Booking (step 4)

- **Find a doctor** (`/doctors`, public): approved doctors only, searchable by name, clinic or area and filterable by specialty and governorate. Only reviewed public details are shown: never email, licence number or documents.
- **Book** (`/book?doctor=…`): pick a day and a free time, add an optional short reason (only that doctor sees it) and send the request. Visitors who are not signed in sign in with their phone and come straight back with their chosen time still selected.
- **My appointments** (`/appointments`): upcoming and past appointments with the clinic's address and phone. Patients can cancel any upcoming appointment, after confirming on the card, and the time becomes free again.
- **No double bookings:** a database constraint refuses two active bookings that overlap for the same doctor, or for the same patient, even when two people click at the same moment. The losing patient is told the time is gone and sees the updated times.
- **Fair use:** at most 5 upcoming appointments per patient, 2 with the same doctor, and 10 booking requests per hour. A time is accepted only if it is currently one of the doctor's free slots.
- New requests start as "waiting for the doctor to confirm". If the doctor never answers, the patient sees "not confirmed in time" once the time has passed.

### Doctor dashboard (step 5)

At `/dashboard` doctors see three tabs:
- **Requests:** confirm, or decline with an optional message.
- **Upcoming:** grouped by day, with today first. Cancel with a required reason; once an appointment has started, mark it "done" or "patient did not come".
- **Past:** the last 60 days.

Each card shows the patient's name, phone and reason. Doctors only see their own patients. The page checks for new requests every minute (not while the doctor is typing), and "My account" shows the number of new requests.

When the doctor confirms, declines or cancels, the patient gets a bilingual SMS with the date and time in Syria time, plus the clinic address or the doctor's message. If an SMS fails, it is logged and the doctor's decision still stands.

### WhatsApp for patients

Patients get their sign-in code and the doctor's decisions (confirmed, declined, cancelled) by **WhatsApp**, through Meta's official WhatsApp Cloud API. SMS is the fallback:

- **Syrian numbers (+963) get SMS for now.** Meta does not deliver business messages to WhatsApp users in Syria, Cuba, Iran or North Korea ([Meta: WhatsApp support](https://developers.facebook.com/documentation/business-messaging/whatsapp/support)). As soon as Meta allows Syria, remove `+963` from `WHATSAPP_BLOCKED_PREFIXES` in `.env` and restart; no code change is needed.
- If WhatsApp refuses a message, it goes out by SMS. On the sign-in screen, "No WhatsApp message? Send the code by SMS" sends a new code by SMS (for numbers without WhatsApp). Both share the limit of three codes per 15 minutes.
- Unofficial WhatsApp tools (remote-controlling a normal WhatsApp account) are not used: they break WhatsApp's terms, and a blocked number would stop every sign-in.

**Setup at Meta** (once):
1. Create a Meta Business account at business.facebook.com and verify the business (the operator's company documents).
2. At developers.facebook.com, create an app of type "Business" and add the product **WhatsApp**.
3. Add a phone number that is not used in the WhatsApp app (a German number works) and the display name "Syria Healthcare". Add a payment method.
4. In WhatsApp Manager, create these templates, each in **Arabic (ar)** and **English (en)**:

| Template name | Category | Text (Arabic / English) |
|---|---|---|
| `shc_login_code` | Authentication, button "Copy code" | Meta's standard code text, with "expires in 5 minutes" |
| `shc_appointment_confirmed` | Utility | تم تأكيد موعدك لدى {{1}} في {{2}}. العنوان: {{3}}. / Your appointment with {{1}} on {{2}} is confirmed. Address: {{3}}. |
| `shc_appointment_declined` | Utility | نعتذر، لم يتمكن {{1}} من قبول طلبك لموعد {{2}}: {{3}}. يمكنك اختيار وقت آخر. / Sorry, {{1}} could not accept your request for {{2}}: {{3}}. You can choose another time. |
| `shc_appointment_cancelled` | Utility | نعتذر، ألغى {{1}} موعدك في {{2}}: {{3}}. / Sorry, {{1}} cancelled your appointment on {{2}}: {{3}}. |

5. Create a system user with the permission `whatsapp_business_messaging` and a permanent token. Put `WHATSAPP_PROVIDER=cloud`, `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_TOKEN` in `.env`. Keep the token secret: with it, anyone can send messages in the platform's name.

### Forgot password and emails

Doctors, labs, hospitals, clinics and admins who forget their password use **"Forgot your password?"** on the sign-in page (`/forgot`). They get an email with a link to `/reset`, where they choose a new password. Saving it signs out every device and signs them in again.

- The link works once, for 30 minutes, and only the newest link works. At most three links per account per hour.
- The answer is the same whether or not an email has an account, so nobody can find out who is registered.
- The token is in the link's `#` part, which browsers never send to servers or in Referer headers, and the page removes it from the address bar at once. Only its SHA-256 hash is stored.
- A reset also lifts a lockout after too many wrong passwords. Patients do not need it: they sign in with an SMS code.

Emails (Arabic and English, the account's language first, plain text only):

| When | To |
|---|---|
| A doctor or facility creates an account | them: welcome and next steps |
| A profile is sent for review | every admin, with a link to `/admin` |
| Approved, changes needed, suspended | the doctor or facility, with the admin's note |
| Forgot password, password changed | the account holder |

If an email cannot be sent, it is logged and the action still stands. In development the emails appear in the server log as `[development email]`.

Five wrong passwords lock an account for 15 minutes. Sessions last 30 days for patients, 7 for doctors and facilities, and 1 for admins. Every page is in Arabic and English.

### Security built in
- Passwords stored with scrypt; SMS codes and session tokens stored only as hashes.
- Session cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- Requests from other websites are rejected (Origin check); strict security headers (CSP, no framing, HSTS in production).
- Limits per phone, per account and per network address. Address limits are generous because Syrian mobile carriers share addresses between many customers.
- Unknown emails get the same answer and the same delay as wrong passwords.
- An audit log records registrations and admin actions.
- No medical data is stored.
- Installable as an app (`public/manifest.webmanifest`, `public/sw.js`). The service worker saves only page frames, styles, scripts and icons; nothing under `/api/` is ever stored on the phone, so appointments, profiles and licences are always fresh and leave no copy on a shared device. Without internet, the app shows an offline notice.

## Run it on this computer

Requires Node 22 and PostgreSQL.

```sh
cd platform
npm install
# DATABASE_URL defaults to postgres://postgres@127.0.0.1:54329/shc_dev
npm run dev          # http://127.0.0.1:3000
npm test             # uses postgres://postgres@127.0.0.1:54329/shc_test (or TEST_DATABASE_URL); it wipes that database
```

In development, SMS codes and emails are not sent. They appear in the server log as `[development SMS]` and `[development email]`; SMS codes also appear on the sign-in screen ("Test mode") to make testing easy. The server refuses to start in production with these settings.

**Local preview with demo data:** create an empty database (e.g. `shc_preview`), then run:

```sh
DATABASE_URL=postgres://postgres@127.0.0.1:54329/shc_preview npm run seed:demo
DATABASE_URL=postgres://postgres@127.0.0.1:54329/shc_preview npm start
```

Open http://127.0.0.1:3000. The demo data has three approved doctors, an approved lab and hospital, and an imaging centre waiting for review, all marked [DEMO]. The doctor login is `demo-doctor@demo.local` / `demo doctor 123`, the lab login is `demo-lab@demo.local` / `demo facility 123`, and the admin login is `demo-admin@demo.local` / `demo admin 123`. Patients sign in with any mobile number. `seed:demo` refuses to run in production.

## Install on the company server

1. Use a Linux server with Docker, and open ports 80 and 443.
2. Point DNS: add an `A` record for `app.syriahealthcare.com` with the server's IP address.
3. Copy this `platform` folder to the server, then run `cp .env.example .env` and fill in `.env` (see the comments in the file).
4. Run `docker compose up -d --build`. Caddy gets the HTTPS certificate automatically.
5. Create the first admin: `docker compose exec app node src/create-admin.js admin@company.com "Name"`.
6. Check that https://app.syriahealthcare.com/api/health returns `{"ok":true}`.

Backups: a compressed database dump and an archive of the encrypted documents are written to `platform/backups/` every night, and the last 14 days are kept. **Keep `DOCUMENT_KEY` safe and separate from the backups: without it, the document backups cannot be opened, and with it anyone holding the backups can read the licences.** Copy these files off the server regularly (to another machine or storage), because a backup on the same disk does not survive a disk failure.

Updates: `git pull && docker compose up -d --build`. Database changes in `migrations/` are applied automatically on start.

## Before going live
- Create a mailbox for sending (e.g. `noreply@syriahealthcare.com` at STRATO, its own mailbox rather than an alias, with Catchall off) and put its SMTP details in `.env`. The server does not start without them. Check it with `npm run test-mail -- you@example.com` (asks for the password, hidden), or on the server with `docker compose exec app node src/test-mail.js you@example.com`.
- Add the domain's SPF record (`v=spf1 redirect=_spf.strato.com`) and a DMARC record (`_dmarc`: `v=DMARC1; p=none; rua=mailto:webmaster@syriahealthcare.com`), so emails do not land in spam. STRATO's DKIM is already active.
- Choose an SMS provider that delivers to Syrian numbers, and adapt `src/sms.js` to its API if it is not "POST JSON with a bearer token".
- Complete and legally review `public/privacy.html` (it is marked DRAFT).
- Check the Ministry of Health's health-app licensing requirements: https://moh.gov.sy/health-app-licensing
- Decide where the server is hosted (inside or outside Syria) and state it in the privacy policy.
