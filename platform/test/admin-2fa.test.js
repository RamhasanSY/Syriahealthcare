import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {cookieOf, pool, setup, teardown} from './helpers.js';
import {buildApp} from '../src/app.js';
import {createSms} from '../src/sms.js';
import {hashPassword} from '../src/security.js';
import {config, origin} from './helpers.js';

let app, mail, post;
beforeEach(async () => {
    await app?.close();
    ({app, mail, post} = await setup());
    await pool.query("INSERT INTO users (role, name, email, password_hash, language) VALUES ('admin', 'Ala Admin', 'admin@example.org', $1, 'en')",
        [await hashPassword('admin password 123')]);
});
after(() => teardown(app));

const login = (password = 'admin password 123') => post('/api/auth/login', {email: 'admin@example.org', password});
const verify = (challenge, code) => post('/api/auth/login/verify', {challenge, code});
const lastCode = () => mail.sent.at(-1).subject.match(/\d{6}/)[0];
const wrong = code => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
const me = cookie => app.inject({url: '/api/me', headers: {cookie}});

describe('admin sign-in with a second factor', () => {
    test('the right password gives no session yet, but an emailed code; code plus challenge signs in', async () => {
        const first = await login();
        assert.equal(first.statusCode, 202);
        assert.equal(cookieOf(first), undefined, 'no session after the password alone');
        const body = first.json();
        assert.equal(body.second_factor, 'email_code');
        assert.equal(body.email_hint, 'a••••••@example.org');
        assert.equal(mail.sent.at(-1).to, 'admin@example.org');
        assert.match(mail.sent.at(-1).subject, /^SyriaHC admin sign-in code: \d{6}$/);

        const done = await verify(body.challenge, lastCode());
        assert.equal(done.statusCode, 200);
        assert.equal(done.json().user.role, 'admin');
        assert.equal((await me(cookieOf(done))).json().user.email, 'admin@example.org');
        const {rows} = await pool.query("SELECT action FROM audit_log WHERE action LIKE 'login.%' ORDER BY id");
        assert.deepEqual(rows.map(r => r.action), ['login.code_sent', 'login.second_factor']);
    });

    test('the code works once, and only with its own challenge', async () => {
        const a = (await login()).json(), codeA = lastCode();
        const b = (await login()).json();
        assert.equal((await verify(b.challenge, codeA)).json().error, 'wrong_code', 'the code of another attempt does not fit');
        assert.equal((await verify(a.challenge, codeA)).statusCode, 200);
        assert.equal((await verify(a.challenge, codeA)).json().error, 'code_expired', 'single use');
    });

    test('five wrong codes end the attempt, even with the right code afterwards', async () => {
        const {challenge} = (await login()).json(), code = lastCode();
        for (let i = 0; i < 5; i++) assert.equal((await verify(challenge, wrong(code))).json().error, 'wrong_code');
        assert.equal((await verify(challenge, code)).statusCode, 429);
        assert.equal((await verify(challenge, code)).json().error, 'code_expired');
    });

    test('an expired code is refused', async () => {
        const {challenge} = (await login()).json(), code = lastCode();
        await pool.query("UPDATE staff_login_codes SET expires_at = now() - interval '1 second'");
        assert.equal((await verify(challenge, code)).json().error, 'code_expired');
    });

    test('at most five codes per 15 minutes', async () => {
        for (let i = 0; i < 5; i++) assert.equal((await login()).statusCode, 202);
        assert.equal((await login()).json().error, 'too_many_codes');
    });

    test('a wrong password still sends no code', async () => {
        const before = mail.sent.length;
        assert.equal((await login('wrong password!')).statusCode, 401);
        assert.equal(mail.sent.length, before);
    });

    test('a disabled admin cannot finish signing in', async () => {
        const {challenge} = (await login()).json(), code = lastCode();
        await pool.query("UPDATE users SET disabled_at = now() WHERE email = 'admin@example.org'");
        assert.equal((await verify(challenge, code)).statusCode, 400);
    });

    test('if the email cannot be sent, the admin is told and the code cannot be used', async () => {
        const failing = {sent: [], async send() { throw new Error('SMTP down'); }};
        const broken = await buildApp({config, pool, sms: createSms(config), mail: failing, logger: false});
        const res = await broken.inject({method: 'POST', url: '/api/auth/login', payload: {email: 'admin@example.org', password: 'admin password 123'}, headers: {origin}});
        assert.equal(res.statusCode, 502);
        assert.equal(res.json().error, 'mail_failed');
        const {rows: [row]} = await pool.query('SELECT consumed_at FROM staff_login_codes');
        assert.ok(row.consumed_at);
        await broken.close();
    });

    test('doctors and facilities still sign in with the password alone', async () => {
        await post('/api/auth/doctor/register', {name: 'Dr. Sami', email: 'sami@example.org', password: 'doctor password 123', consent: true});
        const res = await post('/api/auth/login', {email: 'sami@example.org', password: 'doctor password 123'});
        assert.equal(res.statusCode, 200);
        assert.ok(cookieOf(res));
    });

    test('a password reset does not open an admin session: the admin signs in again with the code', async () => {
        await post('/api/auth/password/forgot', {email: 'admin@example.org'});
        const token = mail.sent.at(-1).text.match(/reset#([A-Za-z0-9_-]{43})/)[1];
        const reset = await post('/api/auth/password/reset', {token, password: 'a brand new password'});
        assert.equal(reset.statusCode, 200);
        assert.equal(reset.json().sign_in_required, true);
        assert.equal(cookieOf(reset), undefined);
        assert.equal((await post('/api/auth/login', {email: 'admin@example.org', password: 'a brand new password'})).statusCode, 202);
    });
});
