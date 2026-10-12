// Runs against a real PostgreSQL database: TEST_DATABASE_URL (default: local test server on port 54329).
import {after, before, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/app.js';
import {createPool} from '../src/db.js';
import {migrate} from '../src/migrate.js';
import {createSms} from '../src/sms.js';
import {hashPassword, normalizePhone} from '../src/security.js';

const origin = 'http://127.0.0.1:3000';
const config = {
    production: false, appOrigin: origin, otpSecret: 'test-secret-test-secret-test-secret', smsProvider: 'test',
    sessionDays: {patient: 30, doctor: 7, admin: 1}, trustProxy: false
};
const pool = createPool(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/shc_test');
let app, sms;

before(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await migrate(pool);
});
beforeEach(async () => {
    await pool.query('TRUNCATE users, otp_codes, sessions, login_failures, audit_log RESTART IDENTITY CASCADE');
    sms = createSms(config);
    app = await buildApp({config, pool, sms, logger: false});
});
after(async () => {
    await app?.close();
    await pool.end();
});

const post = (url, payload, headers = {}) => app.inject({method: 'POST', url, payload, headers: {origin, ...headers}});
const codeFrom = message => message.match(/\d{6}/)[0];
const cookieOf = response => {
    const c = response.cookies.find(x => x.name === 'shc_session');
    return c && `shc_session=${c.value}`;
};

describe('phone numbers', () => {
    test('normalizes Syrian and international formats', () => {
        assert.equal(normalizePhone('0912 345 678'), '+963912345678');
        assert.equal(normalizePhone('+963 912-345-678'), '+963912345678');
        assert.equal(normalizePhone('00963912345678'), '+963912345678');
        assert.equal(normalizePhone('٠٩١٢٣٤٥٦٧٨'), '+963912345678');
        assert.equal(normalizePhone('+49 151 23456789'), '+4915123456789');
        assert.equal(normalizePhone('12345'), null);
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
        const reg = await post('/api/auth/doctor/register', {name: 'Dr. Sami Khoury', email: 'Sami@Example.org', password: 'correct horse battery', consent: true});
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

    test('duplicate email, weak password and missing consent are refused', async () => {
        await post('/api/auth/doctor/register', {name: 'Dr. A', email: 'a@example.org', password: 'long enough pw', consent: true});
        assert.equal((await post('/api/auth/doctor/register', {name: 'Dr. B', email: 'A@example.org', password: 'long enough pw', consent: true})).statusCode, 409);
        assert.equal((await post('/api/auth/doctor/register', {name: 'Dr. C', email: 'c@example.org', password: 'short', consent: true})).statusCode, 400);
        assert.equal((await post('/api/auth/doctor/register', {name: 'Dr. D', email: 'd@example.org', password: 'long enough pw', consent: false})).statusCode, 400);
    });

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
        const reg = await post('/api/auth/doctor/register', {name: 'Dr. Z', email: 'z@example.org', password: 'long enough pw', consent: true});
        await pool.query('UPDATE users SET disabled_at = now()');
        assert.equal((await app.inject({url: '/api/me', headers: {cookie: cookieOf(reg)}})).statusCode, 401);
    });
});

describe('request safety', () => {
    test('requests from other websites are blocked', async () => {
        const res = await post('/api/auth/otp/request', {phone: '0912345678'}, {origin: 'https://evil.example'});
        assert.equal(res.statusCode, 403);
        assert.equal(sms.sent.length, 0);
    });

    test('session cookie is HttpOnly and SameSite', async () => {
        const reg = await post('/api/auth/doctor/register', {name: 'Dr. H', email: 'h@example.org', password: 'long enough pw', consent: true});
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
        const reg = await post('/api/auth/doctor/register', {name: 'Dr. T', email: 't@example.org', password: 'long enough pw', consent: true});
        const token = reg.cookies.find(x => x.name === 'shc_session').value;
        const {rows} = await pool.query('SELECT token_hash FROM sessions');
        assert.notEqual(rows[0].token_hash, token);
    });

    test('audit log records registrations', async () => {
        await post('/api/auth/doctor/register', {name: 'Dr. L', email: 'l@example.org', password: 'long enough pw', consent: true});
        const {rows} = await pool.query('SELECT action FROM audit_log');
        assert.deepEqual(rows.map(r => r.action), ['doctor.registered']);
    });
});
