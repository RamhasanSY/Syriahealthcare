import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {config, cookieOf, origin, pool, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';
import {buildApp} from '../src/app.js';
import {createMail} from '../src/mail.js';
import {createSms} from '../src/sms.js';

let app, mail, post;
beforeEach(async () => {
    await app?.close();
    ({app, mail, post} = await setup());
});
after(() => teardown(app));

const EMAIL = 'lina@example.org';
const request = (email = EMAIL, extra = {}) => post('/api/auth/email/request', {email, ...extra});
const verify = body => post('/api/auth/email/verify', {email: EMAIL, ...body});
const lastCode = (email = EMAIL) => mail.sent.filter(m => m.to === email).at(-1).subject.match(/\d{6}/)[0];
const wrong = code => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('patient sign-in by email', () => {
    test('a new address gets a code by email, then gives name and consent and is signed in', async () => {
        const res = await request(' Lina@Example.ORG ', {language: 'en'});
        assert.equal(res.statusCode, 202);
        assert.deepEqual(res.json(), {sent: true, email: EMAIL, expiresInMinutes: 15});
        const [message] = mail.sent;
        assert.equal(message.to, EMAIL);
        assert.match(message.subject, /^SyriaHC sign-in code: \d{6}$/, 'code in the subject, in the chosen language');
        assert.match(message.text, /valid for 15 minutes/);
        assert.match(message.text, /رمز الدخول الخاص بك/, 'Arabic too');

        const code = lastCode();
        assert.equal((await verify({code})).json().error, 'profile_required', 'new address: name and consent first');
        const done = await verify({code, name: 'Lina Haddad', consent: true, language: 'en'});
        assert.equal(done.statusCode, 200);
        assert.deepEqual([done.json().user.role, done.json().user.email, done.json().user.phone], ['patient', EMAIL, null]);
        const me = await app.inject({url: '/api/me', headers: {cookie: cookieOf(done)}});
        assert.equal(me.json().user.name, 'Lina Haddad');
        const {rows: [row]} = await pool.query('SELECT email_verified_at, language, consented_at FROM users WHERE email = $1', [EMAIL]);
        assert.ok(row.email_verified_at && row.consented_at);
        assert.equal(row.language, 'en');
        const {rows: [logged]} = await pool.query("SELECT details FROM audit_log WHERE action = 'patient.registered'");
        assert.deepEqual(logged.details, {via: 'email'});
    });

    test('a returning patient signs in with the code alone, and each code works once', async () => {
        await signInPatientByEmail(post, mail, EMAIL, 'Lina Haddad');
        await request();
        const code = lastCode();
        const res = await verify({code});
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().user.name, 'Lina Haddad');
        assert.equal((await verify({code})).json().error, 'code_expired', 'single use');
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'patient'")).rows[0].n, 1);
    });

    test('codes are stored only as hashes, different from phone codes', async () => {
        await request();
        const code = lastCode();
        const {rows: [row]} = await pool.query('SELECT code_hash, phone, email FROM otp_codes');
        assert.equal(row.phone, null);
        assert.equal(row.email, EMAIL);
        assert.doesNotMatch(row.code_hash, new RegExp(code));
        assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    });

    test('an older code still works after asking for a new one', async () => {
        await signInPatientByEmail(post, mail, EMAIL);
        await request();
        const first = lastCode();
        await request();
        assert.equal((await verify({code: first})).statusCode, 200, 'the first email arrived late');
        assert.equal((await verify({code: lastCode()})).json().error, 'code_expired', 'the other open code ended with the sign-in');
    });

    test('expired codes and wrong codes are refused; five wrong tries end all open codes', async () => {
        await request();
        const code = lastCode();
        await pool.query("UPDATE otp_codes SET expires_at = now() - interval '1 second'");
        assert.equal((await verify({code})).json().error, 'code_expired');

        await request();
        const fresh = lastCode();
        for (let i = 0; i < 5; i++) assert.equal((await verify({code: wrong(fresh)})).json().error, 'wrong_code');
        assert.equal((await verify({code: fresh})).statusCode, 429, 'the sixth try is refused even with the right code');
        assert.equal((await verify({code: fresh})).json().error, 'code_expired');
    });

    test('at most 3 codes per 15 minutes and 10 per day for one address', async () => {
        for (let i = 0; i < 3; i++) assert.equal((await request()).statusCode, 202);
        assert.equal((await request()).json().error, 'too_many_codes');
        await pool.query("UPDATE otp_codes SET created_at = now() - interval '2 hours'");
        for (let i = 0; i < 3; i++) await request();
        await pool.query("UPDATE otp_codes SET created_at = now() - interval '3 hours' WHERE created_at > now() - interval '1 hour'");
        for (let i = 0; i < 3; i++) await request();
        await pool.query("UPDATE otp_codes SET created_at = now() - interval '4 hours' WHERE created_at > now() - interval '1 hour'");
        assert.equal((await request()).statusCode, 202, 'tenth code of the day');
        await pool.query("UPDATE otp_codes SET created_at = now() - interval '5 hours' WHERE created_at > now() - interval '1 hour'");
        assert.equal((await request()).json().error, 'too_many_codes_today', 'eleventh code of the day');
        assert.equal((await request('other@example.org')).statusCode, 202, 'other addresses are not affected');
    });

    test('a staff address gets a hint to use its password, never a code, and the screen looks the same', async () => {
        await signIn(post, 'doctor', 'dr@example.org', 'Dr. Sara');
        const res = await request('dr@example.org');
        assert.equal(res.statusCode, 202);
        assert.deepEqual(res.json(), {sent: true, email: 'dr@example.org', expiresInMinutes: 15}, 'same answer as for anyone');
        const hint = mail.sent.filter(m => m.to === 'dr@example.org').at(-1);
        assert.doesNotMatch(hint.subject + hint.text, /\b\d{6}\b/, 'no code in the email');
        assert.match(hint.text, /\/staff/);
        // Checking a code must not tell a staff address apart from any other address that asked for a code.
        await request('someone@example.org');
        const answers = async address => {
            const errors = [];
            for (let i = 0; i < 6; i++) errors.push((await post('/api/auth/email/verify', {email: address, code: '123456'})).json().error);
            return errors;
        };
        const expected = [...Array(5).fill('wrong_code'), 'too_many_attempts'];
        assert.deepEqual(await answers('dr@example.org'), expected);
        assert.deepEqual(await answers('someone@example.org'), expected);
        for (let i = 0; i < 2; i++) await request('dr@example.org');
        assert.equal((await request('dr@example.org')).json().error, 'too_many_codes', 'nobody can flood a staff inbox');
    });

    test('a disabled patient cannot sign in', async () => {
        await signInPatientByEmail(post, mail, EMAIL);
        await pool.query('UPDATE users SET disabled_at = now() WHERE email = $1', [EMAIL]);
        await request();
        assert.equal((await verify({code: lastCode()})).json().error, 'disabled');
    });

    test('invalid addresses are refused before anything is sent', async () => {
        assert.equal((await request('not-an-email')).json().error, 'invalid_email');
        assert.equal(mail.sent.length, 0);
    });

    test('parallel requests for one address cannot get past the limit', async () => {
        const answers = await Promise.all(Array.from({length: 12}, () => request()));
        assert.ok(answers.every(res => [202, 429].includes(res.statusCode)));
        const {rows: [{n}]} = await pool.query('SELECT count(*)::int AS n FROM otp_codes WHERE email = $1', [EMAIL]);
        assert.ok(n <= 3, `${n} codes`);
        assert.equal(mail.sent.length, n);
    });

    test('an address written as a list of addresses is refused', async () => {
        for (const address of ['x0,lina@example.org', 'x;lina@example.org', 'x<lina@example.org>', '"x"@example.org', 'x:lina@example.org']) {
            assert.equal((await request(address)).json().error, 'invalid_email', address);
        }
        assert.equal(mail.sent.length, 0);
    });

    test('if the email cannot be sent, the patient is told and the code cannot be used', async () => {
        const failing = {sent: [], async send() { throw new Error('SMTP down'); }};
        const broken = await buildApp({config, pool, sms: createSms(config), mail: failing, logger: false});
        const res = await broken.inject({method: 'POST', url: '/api/auth/email/request', payload: {email: EMAIL}, headers: {origin}});
        assert.equal(res.statusCode, 502);
        assert.equal(res.json().error, 'mail_failed');
        const {rows: [row]} = await pool.query('SELECT consumed_at FROM otp_codes');
        assert.ok(row.consumed_at);
        await broken.close();
    });
});

describe('rate limits', () => {
    test('count per IPv4 address and per IPv6 /64 network', async () => {
        const {rateLimitKey} = await import('../src/security.js');
        assert.equal(rateLimitKey('203.0.113.5'), '203.0.113.5');
        assert.equal(rateLimitKey('::ffff:203.0.113.5'), '203.0.113.5');
        assert.equal(rateLimitKey('2a01:239:48f:3900::1'), '2a01:239:48f:3900::/64');
        assert.equal(rateLimitKey('2a01:0239:048f:3900:aaaa:bbbb:cccc:dddd'), '2a01:239:48f:3900::/64');
        assert.equal(rateLimitKey('2001:db8::1'), '2001:db8:0:0::/64');
    });
});

describe('sign-in methods', () => {
    test('with an SMS gateway both methods are offered', async () => {
        assert.deepEqual((await app.inject({url: '/api/auth/methods'})).json(), {email: true, phone: true});
    });

    test('without any phone channel, phone sign-in is switched off and says so', async () => {
        const noSms = {...config, smsProvider: 'none'};
        const emailOnly = await buildApp({config: noSms, pool, sms: createSms(noSms), mail: createMail(config), logger: false});
        assert.deepEqual((await emailOnly.inject({url: '/api/auth/methods'})).json(), {email: true, phone: false});
        const res = await emailOnly.inject({method: 'POST', url: '/api/auth/otp/request', payload: {phone: '0912345678'}, headers: {origin}});
        assert.equal(res.statusCode, 503);
        assert.equal(res.json().error, 'phone_signin_unavailable');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM otp_codes')).rows[0].n, 0, 'no code was created');
        const email = await emailOnly.inject({method: 'POST', url: '/api/auth/email/request', payload: {email: EMAIL}, headers: {origin}});
        assert.equal(email.statusCode, 202, 'email still works');
        await emailOnly.close();
    });
});

describe('email patients use the platform like everyone else', () => {
    test('they can book an appointment and see it', async () => {
        const {approvedDoctor} = await import('./helpers.js');
        const doctor = await approvedDoctor(post);
        const cookie = await signInPatientByEmail(post, mail, EMAIL, 'Lina Haddad');
        const {addDays, localDate} = await import('../src/slots.js');
        const from = addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
        const [slot] = (await app.inject({url: `/api/doctors/${doctor.id}/slots?from=${from}&days=1`})).json().slots;
        const booked = await post('/api/appointments', {doctor_id: doctor.id, starts_at: slot.starts_at, reason: 'Check-up'}, {cookie});
        assert.equal(booked.statusCode, 201);
        const mine = (await app.inject({url: '/api/appointments/mine', headers: {cookie}})).json().appointments;
        assert.equal(mine.length, 1);
    });
});
