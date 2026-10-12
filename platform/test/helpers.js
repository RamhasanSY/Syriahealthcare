// Shared test setup: a real PostgreSQL database (TEST_DATABASE_URL), a captured SMS outbox and a temporary document folder.
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildApp} from '../src/app.js';
import {createPool} from '../src/db.js';
import {migrate} from '../src/migrate.js';
import {createSms} from '../src/sms.js';
import {hashPassword} from '../src/security.js';

export const origin = 'http://127.0.0.1:3000';
export const pool = createPool(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/shc_test');
const documentDir = await mkdtemp(path.join(tmpdir(), 'shc-docs-'));
export const config = {
    production: false, appOrigin: origin, otpSecret: 'test-secret-test-secret-test-secret', smsProvider: 'test',
    documentKey: 'ab'.repeat(32), documentDir, sessionDays: {patient: 30, doctor: 7, admin: 1}, trustProxy: false
};

let migrated = false;
export async function setup() {
    if (!migrated) {
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
        await migrate(pool);
        migrated = true;
    }
    await pool.query('TRUNCATE users, otp_codes, sessions, login_failures, audit_log RESTART IDENTITY CASCADE');
    const sms = createSms(config);
    const app = await buildApp({config, pool, sms, logger: false});
    const post = (url, payload, headers = {}) => app.inject({method: 'POST', url, payload, headers: {origin, ...headers}});
    return {app, sms, post};
}

export async function teardown(app) {
    await app?.close();
    await pool.end();
    await rm(documentDir, {recursive: true, force: true});
}

export const cookieOf = response => {
    const c = response.cookies.find(x => x.name === 'shc_session');
    return c && `shc_session=${c.value}`;
};

// Creates a staff account directly and returns its session cookie.
export async function signIn(post, role, email, name = 'Test User') {
    if (role === 'admin') {
        await pool.query("INSERT INTO users (role, name, email, password_hash) VALUES ('admin', $1, $2, $3)", [name, email, await hashPassword('admin password 123')]);
        return cookieOf(await post('/api/auth/login', {email, password: 'admin password 123'}));
    }
    return cookieOf(await post('/api/auth/doctor/register', {name, email, password: 'doctor password 123', consent: true}));
}
