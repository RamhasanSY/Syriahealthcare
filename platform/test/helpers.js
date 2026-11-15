// Shared test setup: a real PostgreSQL database (TEST_DATABASE_URL), captured SMS and email outboxes and a temporary document folder.
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildApp} from '../src/app.js';
import {createPool} from '../src/db.js';
import {migrate} from '../src/migrate.js';
import {createMail} from '../src/mail.js';
import {createSms} from '../src/sms.js';
import {createTelegramGateway} from '../src/telegram.js';
import {createWhatsApp, DEFAULT_BLOCKED_PREFIXES, TEMPLATES} from '../src/whatsapp.js';
import {hashPassword, newToken, sha256} from '../src/security.js';

export const origin = 'http://127.0.0.1:3000';
export const pool = createPool(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/shc_test');
const documentDir = await mkdtemp(path.join(tmpdir(), 'shc-docs-'));
export const config = {
    production: false, appOrigin: origin, otpSecret: 'test-secret-test-secret-test-secret', smsProvider: 'test', mailProvider: 'test',
    documentKey: 'ab'.repeat(32), documentDir,
    whatsapp: {provider: '', blockedPrefixes: DEFAULT_BLOCKED_PREFIXES, templates: TEMPLATES}, telegram: {provider: ''}, sessionDays: {patient: 30, doctor: 7, facility: 7, admin: 1}, trustProxy: false, healthFile: true,
    push: {provider: 'test'},
    video: {enabled: false, turnUrls: ['turn:turn.example.org:3478?transport=udp'], turnSecret: 'turn-test-secret', stunUrls: ['stun:turn.example.org:3478']}
};

let migrated = false;
// With {whatsapp: true} or {telegram: true}, patients are reached on those channels (captured in `whatsapp.sent`, `telegram.sent`).
export async function setup({whatsapp: withWhatsApp = false, telegram: withTelegram = false} = {}) {
    if (!migrated) {
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
        await migrate(pool);
        migrated = true;
    }
    await pool.query('TRUNCATE users, otp_codes, sessions, login_failures, audit_log, patients RESTART IDENTITY CASCADE');
    const sms = createSms(config), mail = createMail(config);
    const whatsapp = withWhatsApp ? createWhatsApp({whatsapp: {provider: 'test'}}) : null;
    const telegram = withTelegram ? createTelegramGateway({telegram: {provider: 'test'}}) : null;
    const app = await buildApp({config, pool, sms, whatsapp, telegram, mail, logger: false});
    const post = (url, payload, headers = {}) => app.inject({method: 'POST', url, payload, headers: {origin, ...headers}});
    return {app, sms, whatsapp, telegram, mail, post, push: app.push};
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
        // Admins sign in with password and an emailed code (tested in admin-2fa.test.js); other tests start a session directly.
        const {rows: [admin]} = await pool.query("INSERT INTO users (role, name, email, password_hash) VALUES ('admin', $1, $2, $3) RETURNING id",
            [name, email, await hashPassword('admin password 123')]);
        const token = newToken();
        await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')", [sha256(token), admin.id]);
        return `shc_session=${token}`;
    }
    return cookieOf(await post('/api/auth/doctor/register', {name, email, password: 'doctor password 123', consent: true}));
}

// Signs in a patient through the real SMS-code flow and returns the session cookie.
export async function signInPatient(post, sms, phone, name = 'Test Patient') {
    await post('/api/auth/otp/request', {phone});
    const code = sms.sent.at(-1).message.match(/\d{6}/)[0];
    return cookieOf(await post('/api/auth/otp/verify', {phone, code, name, consent: true}));
}

// Signs in a patient through the real email-code flow and returns the session cookie.
export async function signInPatientByEmail(post, mail, email, name = 'Test Patient') {
    await post('/api/auth/email/request', {email});
    const code = mail.sent.filter(m => m.to === email).at(-1).subject.match(/\d{6}/)[0];
    return cookieOf(await post('/api/auth/email/verify', {email, code, name, consent: true}));
}

// Marks a signed-in session as confirmed with the emailed code (what /api/auth/step-up/verify does), for tests.
export async function confirmSession(cookie) {
    await pool.query('UPDATE sessions SET second_factor_at = now() WHERE token_hash = $1', [sha256(cookie.split('=')[1])]);
    return cookie;
}

// An approved doctor open every day 09:00–12:00 in 30-minute slots, bookable from now on.
// {confirmed: true}: the session already passed the emailed second factor (needed for lab results and shared files).
export async function approvedDoctor(post, email = 'dr@example.org', name = 'Dr. Approved', {confirmed = false} = {}) {
    const cookie = await signIn(post, 'doctor', email, name);
    const hours = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({weekday, starts_at: '09:00', ends_at: '12:00'}));
    await post('/api/doctor/schedule', {slot_minutes: 30, booking_window_days: 30, min_notice_hours: 0, hours}, {cookie});
    const {rows: [{id}]} = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    await pool.query(`UPDATE doctor_profiles SET status = 'approved', specialty = 'cardiology', governorate = 'damascus', area = 'Mezzeh',
        clinic_name = 'Heart Clinic', clinic_address = 'Mezzeh Highway 12', clinic_phone = '+963112345678', licence_number = 'SY-1' WHERE user_id = $1`, [id]);
    if (confirmed) await confirmSession(cookie);
    return {cookie, id};
}
