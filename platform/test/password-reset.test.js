// "Forgot password" for doctors, facilities and admins.
import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {cookieOf, pool, setup, signIn, teardown} from './helpers.js';

let app, mail, post, sms;
beforeEach(async () => {
    await app?.close();
    ({app, mail, post, sms} = await setup());
});
after(() => teardown(app));

const tokenFrom = message => message.text.match(/\/reset#([A-Za-z0-9_-]{43})/)[1];
const forgot = email => post('/api/auth/password/forgot', {email});
const login = (email, password) => post('/api/auth/login', {email, password});

async function doctorWithLink(email = 'dr@example.org') {
    const cookie = await signIn(post, 'doctor', email, 'Dr. Rana Saleh');
    mail.sent.length = 0;
    assert.equal((await forgot(email)).statusCode, 202);
    return {cookie, token: tokenFrom(mail.sent.at(-1))};
}

describe('forgot password', () => {
    test('sends a single-use link to the account email, stored only as a hash', async () => {
        const {token} = await doctorWithLink();
        assert.equal(mail.sent.length, 1);
        assert.equal(mail.sent[0].to, 'dr@example.org');
        assert.match(mail.sent[0].text, /http:\/\/127\.0\.0\.1:3000\/reset#/);
        assert.match(mail.sent[0].text, /30/);
        const {rows: [row]} = await pool.query('SELECT token_hash, expires_at - created_at AS valid FROM password_resets');
        assert.notEqual(row.token_hash, token);
        assert.match(row.token_hash, /^[0-9a-f]{64}$/);
        assert.equal(row.valid.minutes, 30);
    });

    test('unknown emails, patients and disabled accounts get the same answer and no email', async () => {
        const unknown = await forgot('nobody@example.org');
        await signIn(post, 'doctor', 'off@example.org');
        await pool.query("UPDATE users SET disabled_at = now() WHERE email = 'off@example.org'");
        mail.sent.length = 0;
        const disabled = await forgot('off@example.org');
        for (const res of [unknown, disabled]) {
            assert.equal(res.statusCode, 202);
            assert.deepEqual(res.json(), {sent: true});
        }
        assert.equal(mail.sent.length, 0);
        assert.equal((await forgot('not an email')).statusCode, 400);
    });

    test('at most three links per hour, and only the newest one works', async () => {
        const {token: first} = await doctorWithLink();
        await forgot('dr@example.org');
        await forgot('dr@example.org');
        const newest = tokenFrom(mail.sent.at(-1));
        assert.equal(mail.sent.length, 3);
        assert.equal((await forgot('dr@example.org')).statusCode, 202);
        assert.equal(mail.sent.length, 3, 'the fourth request sends nothing');
        assert.equal((await post('/api/auth/password/reset', {token: first, password: 'a brand new password'})).json().error, 'reset_invalid');
        assert.equal((await post('/api/auth/password/reset', {token: newest, password: 'a brand new password'})).statusCode, 200);
    });
});

describe('reset password', () => {
    test('sets the new password, signs out every device, signs in here and confirms by email', async () => {
        const {cookie: oldSession, token} = await doctorWithLink();
        const res = await post('/api/auth/password/reset', {token, password: 'a brand new password'});
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().user.email, 'dr@example.org');
        const newSession = cookieOf(res);
        assert.equal((await app.inject({url: '/api/me', headers: {cookie: newSession}})).statusCode, 200);
        assert.equal((await app.inject({url: '/api/me', headers: {cookie: oldSession}})).statusCode, 401, 'old sessions end');
        assert.equal((await login('dr@example.org', 'doctor password 123')).statusCode, 401);
        assert.equal((await login('dr@example.org', 'a brand new password')).statusCode, 200);
        assert.match(mail.sent.at(-1).subject, /changed|تغيير/);
        assert.equal(mail.sent.at(-1).to, 'dr@example.org');
        const {rows} = await pool.query("SELECT action FROM audit_log WHERE action LIKE 'password.%' ORDER BY id");
        assert.deepEqual(rows.map(r => r.action), ['password.reset_requested', 'password.reset']);
    });

    test('a link works only once', async () => {
        const {token} = await doctorWithLink();
        assert.equal((await post('/api/auth/password/reset', {token, password: 'a brand new password'})).statusCode, 200);
        const again = await post('/api/auth/password/reset', {token, password: 'another new password'});
        assert.equal(again.statusCode, 400);
        assert.equal(again.json().error, 'reset_invalid');
    });

    test('expired and made-up links are refused', async () => {
        const {token} = await doctorWithLink();
        await pool.query("UPDATE password_resets SET expires_at = now() - interval '1 second'");
        assert.equal((await post('/api/auth/password/reset', {token, password: 'a brand new password'})).json().error, 'reset_invalid');
        const madeUp = 'A'.repeat(43);
        assert.equal((await post('/api/auth/password/reset', {token: madeUp, password: 'a brand new password'})).json().error, 'reset_invalid');
        assert.equal((await post('/api/auth/password/reset', {token: 'short', password: 'a brand new password'})).statusCode, 400);
    });

    test('a weak password is refused and the link stays usable', async () => {
        const {token} = await doctorWithLink();
        const weak = await post('/api/auth/password/reset', {token, password: 'short'});
        assert.equal(weak.json().error, 'weak_password');
        assert.equal((await post('/api/auth/password/reset', {token, password: 'a brand new password'})).statusCode, 200);
    });

    test('a reset lifts the lockout after too many wrong passwords', async () => {
        const {token} = await doctorWithLink();
        for (let i = 0; i < 5; i++) await login('dr@example.org', 'wrong password!!');
        assert.equal((await login('dr@example.org', 'doctor password 123')).statusCode, 429);
        await post('/api/auth/password/reset', {token, password: 'a brand new password'});
        assert.equal((await login('dr@example.org', 'a brand new password')).statusCode, 200);
    });

    test('a link stops working when the account is disabled', async () => {
        const {token} = await doctorWithLink();
        await pool.query("UPDATE users SET disabled_at = now() WHERE email = 'dr@example.org'");
        assert.equal((await post('/api/auth/password/reset', {token, password: 'a brand new password'})).json().error, 'reset_invalid');
    });

    test('admins can reset too; requests from other websites are blocked', async () => {
        await signIn(post, 'admin', 'admin@example.org');
        await forgot('admin@example.org');
        const token = tokenFrom(mail.sent.at(-1));
        const foreign = await post('/api/auth/password/reset', {token, password: 'a brand new password'}, {origin: 'https://evil.example'});
        assert.equal(foreign.statusCode, 403);
        assert.equal((await post('/api/auth/password/reset', {token, password: 'a brand new password'})).statusCode, 200);
        assert.equal(sms.sent.length, 0);
    });
});

describe('emails', () => {
    test('new doctors and facilities get a welcome email in their language first', async () => {
        await post('/api/auth/doctor/register', {name: 'Dr. Sami', email: 'sami@example.org', password: 'doctor password 123', consent: true, language: 'en'});
        await post('/api/auth/facility/register', {name: 'Rana', email: 'lab@example.org', password: 'facility password 123', consent: true, kind: 'lab'});
        const [doctor, lab] = mail.sent;
        assert.equal(doctor.to, 'sami@example.org');
        assert.match(doctor.subject, /^Welcome/);
        assert.ok(doctor.text.indexOf('Hello') < doctor.text.indexOf('مرحباً'));
        assert.equal(lab.to, 'lab@example.org');
        assert.match(lab.subject, /^أهلاً/);
        assert.ok(lab.text.indexOf('مرحباً') < lab.text.indexOf('Hello'));
    });

    test('a failed email is logged but never undoes the action', async () => {
        app.mail.send = async () => { throw new Error('SMTP down'); };
        const res = await post('/api/auth/doctor/register', {name: 'Dr. Sami', email: 'sami@example.org', password: 'doctor password 123', consent: true});
        assert.equal(res.statusCode, 201);
        assert.equal((await forgot('sami@example.org')).statusCode, 202);
    });
});
