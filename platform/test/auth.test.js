// Runs against a real PostgreSQL database: TEST_DATABASE_URL (default: local test server on port 54329).
import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {cookieOf, pool, setup, signInPatientByEmail, teardown, registerStaff} from './helpers.js';
import {hashPassword, normalizePhone} from '../src/security.js';

let app, sms, mail, post;
beforeEach(async () => {
    await app?.close();
    ({app, sms, mail, post} = await setup());
});
after(() => teardown(app));

const codeFrom = message => message.match(/\d{6}/)[0];

describe('phone numbers', () => {
    test('normalizes Syrian and international formats', () => {
        assert.equal(normalizePhone('0912 345 678'), '+963912345678');
        assert.equal(normalizePhone('+963 912-345-678'), '+963912345678');
        assert.equal(normalizePhone('00963912345678'), '+963912345678');
        assert.equal(normalizePhone('٠٩١٢٣٤٥٦٧٨'), '+963912345678');
        assert.equal(normalizePhone('+49 151 23456789'), '+4915123456789');
        assert.equal(normalizePhone('12345'), null);
        assert.equal(normalizePhone('011 234 5678'), null, 'landlines cannot receive SMS codes');
        assert.equal(normalizePhone('011 234 5678', {landline: true}), '+963112345678');
    });
});

describe('patient sign-in with SMS code', () => {
    test('new patient must give name and consent, then gets a session', async () => {
        const sent = await post('/api/auth/otp/request', {phone: '0912345678'});
        assert.equal(sent.statusCode, 202);
        assert.equal(sms.sent.length, 1);
        assert.equal(sms.sent[0].to, '+963912345678');
        const code = codeFrom(sms.sent[0].message);

        const missing = await post('/api/auth/otp/verify', {phone: '0912345678', code});
        assert.equal(missing.statusCode, 409);
        assert.equal(missing.json().error, 'profile_required');

        const ok = await post('/api/auth/otp/verify', {phone: '0912345678', code, name: 'Lina Haddad', consent: true});
        assert.equal(ok.statusCode, 200);
        assert.equal(ok.json().user.role, 'patient');
        const cookie = cookieOf(ok);
        assert.ok(cookie);
        const me = await app.inject({url: '/api/me', headers: {cookie}});
        assert.equal(me.json().user.name, 'Lina Haddad');

        const reused = await post('/api/auth/otp/verify', {phone: '0912345678', code, name: 'Lina Haddad', consent: true});
        assert.equal(reused.statusCode, 400, 'a code works only once');
    });

    test('wrong codes are limited to five attempts', async () => {
        await post('/api/auth/otp/request', {phone: '0912345678'});
        const code = codeFrom(sms.sent[0].message), wrong = code === '000000' ? '111111' : '000000';
        for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/otp/verify', {phone: '0912345678', code: wrong})).statusCode, 400);
        const blocked = await post('/api/auth/otp/verify', {phone: '0912345678', code, name: 'X Y', consent: true});
        assert.equal(blocked.statusCode, 429);
    });

    test('at most three codes per number in 15 minutes', async () => {
        for (let i = 0; i < 3; i++) assert.equal((await post('/api/auth/otp/request', {phone: '0912345678'})).statusCode, 202);
        assert.equal((await post('/api/auth/otp/request', {phone: '0912345678'})).statusCode, 429);
    });

    test('codes are stored hashed, never in plain text', async () => {
        await post('/api/auth/otp/request', {phone: '0912345678'});
        const {rows: [row]} = await pool.query('SELECT code_hash FROM otp_codes');
        assert.notEqual(row.code_hash, codeFrom(sms.sent[0].message));
        assert.match(row.code_hash, /^[0-9a-f]{64}$/);
    });

    test('rejects invalid numbers', async () => {
        assert.equal((await post('/api/auth/otp/request', {phone: '123'})).statusCode, 400);
    });
});

describe('doctor and admin sign-in', () => {
    test('doctor registers, signs out and signs in again', async () => {
        const reg = await registerStaff(post, 'doctor', {name: 'Dr. Sami Khoury', email: 'Sami@Example.org', password: 'correct horse battery', consent: true});
        assert.equal(reg.statusCode, 201);
        assert.equal(reg.json().user.email, 'sami@example.org');
        const cookie = cookieOf(reg);
        assert.equal((await post('/api/auth/logout', {}, {cookie})).statusCode, 200);
        assert.equal((await app.inject({url: '/api/me', headers: {cookie}})).statusCode, 401, 'session ends on sign-out');

        const login = await post('/api/auth/login', {email: 'sami@example.org', password: 'correct horse battery'});
        assert.equal(login.statusCode, 200);
        assert.equal(login.json().user.role, 'doctor');
        const {rows: [user]} = await pool.query('SELECT password_hash FROM users');
        assert.match(user.password_hash, /^scrypt\$/);
    });

    test('weak password and missing consent are refused on the form', async () => {
        assert.equal((await registerStaff(post, 'doctor', {name: 'Dr. C', email: 'c@example.org', password: 'short', consent: true})).json().error, 'weak_password');
        assert.equal((await registerStaff(post, 'doctor', {name: 'Dr. D', email: 'd@example.org', password: 'long enough pw', consent: false})).json().error, 'consent_required');
        assert.equal(mail.sent.length, 0, 'no code for a form with mistakes');
    });
});

describe('doctor and facility sign-up with an emailed code', () => {
    const form = (email, extra = {}) => post('/api/auth/doctor/register', {name: 'Dr. New', email, password: 'long enough pw', consent: true, ...extra});
    const codeTo = email => mail.sent.filter(m => m.to === email).at(-1)?.subject.match(/\d{6}/)?.[0];
    const users = async () => (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;

    test('the account exists only after the code from the email, with the address confirmed', async () => {
        const res = await form('New@Example.org', {language: 'en'});
        assert.equal(res.statusCode, 202);
        assert.deepEqual(res.json(), {confirm: true, email: 'new@example.org', expires_in_minutes: 30});
        assert.equal(res.cookies.length, 0, 'no session before the code');
        assert.equal(await users(), 0);
        const code = codeTo('new@example.org');
        assert.match(mail.sent.at(-1).subject, /^Your SyriaHC account code: \d{6}$/);
        assert.equal((await post('/api/auth/register/verify', {email: 'new@example.org', code: code === '000000' ? '111111' : '000000'})).json().error, 'wrong_code');
        const done = await post('/api/auth/register/verify', {email: 'NEW@example.org', code});
        assert.equal(done.statusCode, 201);
        assert.equal(done.json().user.role, 'doctor');
        const {rows: [user]} = await pool.query('SELECT name, email_verified_at, consented_at, language FROM users');
        assert.equal(user.name, 'Dr. New');
        assert.equal(user.language, 'en');
        assert.ok(user.email_verified_at && user.consented_at);
        assert.equal((await app.inject({url: '/api/doctor/profile', headers: {cookie: cookieOf(done)}})).json().profile.status, 'draft');
        assert.equal((await post('/api/auth/register/verify', {email: 'new@example.org', code})).json().error, 'code_expired', 'a code works once');
        const {rows: [entry]} = await pool.query("SELECT details FROM audit_log WHERE action = 'doctor.registered'");
        assert.deepEqual(entry.details, {email_confirmed: true});
    });

    test('an address that already has an account gets the same answer, and its owner an email instead of a code', async () => {
        await registerStaff(post, 'doctor', {name: 'Dr. A', email: 'a@example.org', password: 'long enough pw', consent: true});
        await signInPatientByEmail(post, mail, 'patient@example.org');
        const fresh = await form('fresh@example.org');
        for (const [email, page] of [['A@example.org', '/staff'], ['patient@example.org', '/login']]) {
            const res = await form(email, {name: 'Dr. B'});
            assert.equal(res.statusCode, fresh.statusCode, email);
            assert.deepEqual(Object.keys(res.json()), Object.keys(fresh.json()), 'nothing tells the two apart');
            const sent = mail.sent.at(-1);
            assert.equal(sent.to, email.toLowerCase());
            assert.doesNotMatch(sent.subject, /\d/, 'no code');
            assert.match(sent.text, /already has a SyriaHC account/);
            assert.ok(sent.text.includes(page), `points ${email} to ${page}`);
            assert.ok(!sent.text.includes('Dr. B'), 'the form\'s name is not echoed to the owner');
        }
        // Guessing a code for an existing address never works, not even with a code of another address.
        assert.equal((await post('/api/auth/register/verify', {email: 'a@example.org', code: codeTo('fresh@example.org')})).json().error, 'wrong_code');
        const {rows} = await pool.query('SELECT name, role FROM users ORDER BY created_at');
        assert.deepEqual(rows.map(r => r.name), ['Dr. A', 'Test Patient'], 'no account changed or added');
    });

    test('five wrong codes end every open form; three forms per 15 minutes', async () => {
        await form('g@example.org');
        const code = codeTo('g@example.org'), wrong = code === '000000' ? '111111' : '000000';
        for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/register/verify', {email: 'g@example.org', code: wrong})).json().error, 'wrong_code');
        assert.equal((await post('/api/auth/register/verify', {email: 'g@example.org', code: wrong})).json().error, 'too_many_attempts');
        assert.equal((await post('/api/auth/register/verify', {email: 'g@example.org', code})).json().error, 'code_expired', 'the right code is gone too');
        await form('g@example.org');
        await form('g@example.org');
        const limited = await form('g@example.org');
        assert.equal(limited.statusCode, 429);
        assert.equal(limited.json().error, 'too_many_codes');
        assert.equal(await users(), 0);
    });

    test('an earlier code still works after the form was sent again, with the details of its own form', async () => {
        await post('/api/auth/facility/register', {name: 'Rana', email: 'ph@example.org', password: 'long enough pw', consent: true, kind: 'pharmacy'});
        const first = codeTo('ph@example.org');
        await post('/api/auth/facility/register', {name: 'Rana Saleh', email: 'ph@example.org', password: 'long enough pw', consent: true, kind: 'lab'});
        assert.equal((await post('/api/auth/register/verify', {email: 'ph@example.org', code: first})).statusCode, 201);
        const {rows: [row]} = await pool.query('SELECT u.name, f.kind FROM users u JOIN facility_profiles f ON f.user_id = u.id');
        assert.deepEqual(row, {name: 'Rana', kind: 'pharmacy'});
    });

    test('when the code cannot be emailed, the form says so and leaves no usable code', async () => {
        app.mail.send = async () => { throw new Error('SMTP down'); };
        const res = await form('m@example.org');
        assert.equal(res.statusCode, 502);
        assert.equal(res.json().error, 'mail_failed');
        const {rows: [open]} = await pool.query('SELECT count(*)::int AS n FROM staff_signups WHERE consumed_at IS NULL');
        assert.equal(open.n, 0);
    });
});

describe('doctor and admin sign-in, continued', () => {

    test('five wrong passwords lock the account for 15 minutes', async () => {
        await pool.query("INSERT INTO users (role, name, email, password_hash) VALUES ('admin', 'Admin', 'admin@example.org', $1)", [await hashPassword('the right password')]);
        for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/login', {email: 'admin@example.org', password: 'wrong password!'})).statusCode, 401);
        assert.equal((await post('/api/auth/login', {email: 'admin@example.org', password: 'the right password'})).statusCode, 429);
    });

    test('unknown email gets the same answer as a wrong password', async () => {
        const res = await post('/api/auth/login', {email: 'nobody@example.org', password: 'whatever password'});
        assert.equal(res.statusCode, 401);
        assert.equal(res.json().error, 'wrong_credentials');
    });

    test('patients cannot use the staff sign-in, staff numbers cannot use SMS sign-in', async () => {
        await pool.query("INSERT INTO users (role, name, email, phone, password_hash) VALUES ('doctor', 'Dr. P', 'p@example.org', '+963933333333', $1)", [await hashPassword('the right password')]);
        await post('/api/auth/otp/request', {phone: '+963933333333'});
        const res = await post('/api/auth/otp/verify', {phone: '+963933333333', code: codeFrom(sms.sent[0].message)});
        assert.equal(res.statusCode, 403);
    });

    test('disabled accounts lose their sessions', async () => {
        const reg = await registerStaff(post, 'doctor', {name: 'Dr. Z', email: 'z@example.org', password: 'long enough pw', consent: true});
        await pool.query('UPDATE users SET disabled_at = now()');
        assert.equal((await app.inject({url: '/api/me', headers: {cookie: cookieOf(reg)}})).statusCode, 401);
    });
});

describe('local preview mode', () => {
    test('the sign-in code is shown on screen only in development with console SMS', async () => {
        const {buildApp} = await import('../src/app.js');
        const {config} = await import('./helpers.js');
        for (const [production, provider, shown] of [[false, 'console', true], [false, 'test', false]]) {
            const preview = await buildApp({config: {...config, production, smsProvider: provider}, pool, sms: {send: async () => {}}, logger: false});
            const res = await preview.inject({method: 'POST', url: '/api/auth/otp/request', payload: {phone: '0912345678'}, headers: {origin: config.appOrigin}});
            assert.equal('previewCode' in res.json(), shown, `${provider}/${production}`);
            await preview.close();
            await pool.query('DELETE FROM otp_codes');
        }
        // In production the server refuses to start with console SMS at all (see src/config.js).
    });
});

describe('request safety', () => {
    test('requests from other websites are blocked', async () => {
        const res = await post('/api/auth/otp/request', {phone: '0912345678'}, {origin: 'https://evil.example'});
        assert.equal(res.statusCode, 403);
        assert.equal(sms.sent.length, 0);
    });

    test('session cookie is HttpOnly and SameSite', async () => {
        const reg = await registerStaff(post, 'doctor', {name: 'Dr. H', email: 'h@example.org', password: 'long enough pw', consent: true});
        const c = reg.cookies.find(x => x.name === 'shc_session');
        assert.equal(c.httpOnly, true);
        assert.equal(c.sameSite, 'Lax');
        assert.equal(c.path, '/');
    });

    test('API responses carry security headers and are not cached', async () => {
        const res = await app.inject({url: '/api/health'});
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers['x-frame-options'], 'DENY');
        assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    });

    test('sessions store only a hash of the token', async () => {
        const reg = await registerStaff(post, 'doctor', {name: 'Dr. T', email: 't@example.org', password: 'long enough pw', consent: true});
        const token = reg.cookies.find(x => x.name === 'shc_session').value;
        const {rows} = await pool.query('SELECT token_hash FROM sessions');
        assert.notEqual(rows[0].token_hash, token);
    });

    test('audit log records registrations', async () => {
        await registerStaff(post, 'doctor', {name: 'Dr. L', email: 'l@example.org', password: 'long enough pw', consent: true});
        const {rows} = await pool.query('SELECT action FROM audit_log');
        assert.deepEqual(rows.map(r => r.action), ['doctor.registered']);
    });
});
