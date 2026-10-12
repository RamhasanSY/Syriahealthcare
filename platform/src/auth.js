import {audit, transaction} from './db.js';
import {dummyPasswordHash, hashPassword, newOtp, newToken, normalizeEmail, normalizePhone, otpHash, passwordProblem, sameHash, sha256, verifyPassword} from './security.js';

export const SESSION_COOKIE = 'shc_session';
const OTP_MINUTES = 5, OTP_PER_PHONE = 3, OTP_WINDOW_MINUTES = 15, OTP_MAX_ATTEMPTS = 5;
const LOGIN_MAX_FAILURES = 5, LOGIN_WINDOW_MINUTES = 15;

const publicUser = u => ({id: u.id, role: u.role, name: u.name, phone: u.phone, email: u.email, language: u.language});

class HttpError extends Error {
    constructor(statusCode, code, message) {
        super(message);
        Object.assign(this, {statusCode, code});
    }
}

export async function startSession(app, request, reply, user) {
    const token = newToken(), days = app.config.sessionDays[user.role];
    await app.pg.query('INSERT INTO sessions (token_hash, user_id, expires_at, user_agent, ip) VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)',
        [sha256(token), user.id, days, String(request.headers['user-agent'] || '').slice(0, 300), request.ip]);
    reply.setCookie(SESSION_COOKIE, token, {
        path: '/', httpOnly: true, sameSite: 'lax', secure: app.config.production, maxAge: days * 86400
    });
}

// Loads the signed-in user (if any) on every request.
export async function loadSession(request) {
    request.user = null;
    const token = request.cookies[SESSION_COOKIE];
    if (!token || token.length > 100) return;
    const {rows} = await this.pg.query(
        `UPDATE sessions s SET last_seen = now() FROM users u
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.id = s.user_id AND u.disabled_at IS NULL
         RETURNING u.*, s.token_hash`, [sha256(token)]);
    if (rows[0]) request.user = rows[0];
}

export function requireRole(...roles) {
    return async request => {
        if (!request.user) throw new HttpError(401, 'signin_required', 'Please sign in.');
        if (!roles.includes(request.user.role)) throw new HttpError(403, 'forbidden', 'You do not have access to this page.');
    };
}

// Per network address. Mobile carriers often share one address among many customers, so these are generous;
// the per-phone and per-account limits above do the real protection.
const ipLimit = max => ({rateLimit: {max, timeWindow: '15 minutes'}});

export default async function authRoutes(app) {
    // Patients: request an SMS code.
    app.post('/api/auth/otp/request', {
        config: ipLimit(30),
        schema: {body: {type: 'object', required: ['phone'], properties: {phone: {type: 'string', maxLength: 30}}}}
    }, async (request, reply) => {
        const phone = normalizePhone(request.body.phone);
        if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a valid mobile number, for example 0912 345 678.');
        const {rows: [recent]} = await app.pg.query(
            'SELECT count(*)::int AS n FROM otp_codes WHERE phone = $1 AND created_at > now() - make_interval(mins => $2)', [phone, OTP_WINDOW_MINUTES]);
        if (recent.n >= OTP_PER_PHONE) throw new HttpError(429, 'too_many_codes', 'Too many codes requested. Please wait 15 minutes and try again.');
        const code = newOtp();
        const {rows: [otp]} = await app.pg.query(
            'INSERT INTO otp_codes (phone, code_hash, expires_at, ip) VALUES ($1, $2, now() + make_interval(mins => $3), $4) RETURNING id',
            [phone, otpHash(app.config.otpSecret, phone, code), OTP_MINUTES, request.ip]);
        try {
            await app.sms.send(phone, `رمز الدخول إلى الرعاية الصحية في سوريا: ${code} (صالح ${OTP_MINUTES} دقائق)\nSyria Healthcare sign-in code: ${code}`);
        } catch (error) {
            request.log.error({err: error}, 'SMS delivery failed');
            await app.pg.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otp.id]);
            throw new HttpError(502, 'sms_failed', 'We could not send the SMS. Please try again in a minute.');
        }
        reply.code(202);
        return {sent: true, phone, expiresInMinutes: OTP_MINUTES};
    });

    // Patients: verify the code. New patients also send their name and consent.
    app.post('/api/auth/otp/verify', {
        config: ipLimit(60),
        schema: {body: {type: 'object', required: ['phone', 'code'], properties: {
            phone: {type: 'string', maxLength: 30}, code: {type: 'string', pattern: '^[0-9]{6}$'},
            name: {type: 'string', maxLength: 120}, consent: {type: 'boolean'}, language: {enum: ['ar', 'en']}
        }}}
    }, async (request, reply) => {
        const phone = normalizePhone(request.body.phone);
        if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a valid mobile number.');
        // Every attempt is counted immediately (outside any transaction), so guessing stops after five tries.
        const {rows: [otp]} = await app.pg.query(
            `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = (
                SELECT id FROM otp_codes WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1)
             RETURNING *`, [phone]);
        if (!otp) throw new HttpError(400, 'code_expired', 'This code has expired. Please request a new one.');
        if (otp.attempts > OTP_MAX_ATTEMPTS) {
            await app.pg.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otp.id]);
            throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Please request a new one.');
        }
        if (!sameHash(otp.code_hash, otpHash(app.config.otpSecret, phone, request.body.code))) {
            throw new HttpError(400, 'wrong_code', 'That code is not correct.');
        }
        const user = await transaction(app.pg, async db => {
            let {rows: [account]} = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
            if (account && account.role !== 'patient') throw new HttpError(403, 'use_email', 'This number belongs to a staff account. Please sign in with your email.');
            if (account?.disabled_at) throw new HttpError(403, 'disabled', 'This account has been disabled. Please contact support.');
            if (!account) {
                const name = String(request.body.name || '').trim();
                // The code stays valid so the patient can resend it together with name and consent.
                if (name.length < 2 || request.body.consent !== true) throw new HttpError(409, 'profile_required', 'Please enter your name and accept the privacy policy.');
                ({rows: [account]} = await db.query(
                    "INSERT INTO users (role, name, phone, language, consented_at) VALUES ('patient', $1, $2, $3, now()) RETURNING *",
                    [name, phone, request.body.language || 'ar']));
                await audit(db, {actorId: account.id, action: 'patient.registered', targetId: account.id, ip: request.ip});
            }
            // Single use: if a parallel request already used this code, this one fails.
            const used = await db.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [otp.id]);
            if (!used.rowCount) throw new HttpError(400, 'code_expired', 'This code has already been used. Please request a new one.');
            return account;
        });
        await startSession(app, request, reply, user);
        return {user: publicUser(user)};
    });

    // Doctors: create an account. Approval (step 2) is required before they appear publicly.
    app.post('/api/auth/doctor/register', {
        config: ipLimit(20),
        schema: {body: {type: 'object', required: ['name', 'email', 'password', 'consent'], properties: {
            name: {type: 'string', maxLength: 120}, email: {type: 'string', maxLength: 254}, password: {type: 'string', maxLength: 200},
            consent: {type: 'boolean'}, language: {enum: ['ar', 'en']}
        }}}
    }, async (request, reply) => {
        const email = normalizeEmail(request.body.email), name = request.body.name.trim();
        if (!email) throw new HttpError(400, 'invalid_email', 'Enter a valid email address.');
        if (name.length < 2) throw new HttpError(400, 'invalid_name', 'Enter your full name.');
        const problem = passwordProblem(request.body.password);
        if (problem) throw new HttpError(400, 'weak_password', problem);
        if (request.body.consent !== true) throw new HttpError(400, 'consent_required', 'Please accept the terms and privacy policy.');
        const hash = await hashPassword(request.body.password);
        const user = await transaction(app.pg, async db => {
            const {rows: [created]} = await db.query(
                `INSERT INTO users (role, name, email, password_hash, language, consented_at) VALUES ('doctor', $1, $2, $3, $4, now())
                 ON CONFLICT (email) DO NOTHING RETURNING *`, [name, email, hash, request.body.language || 'ar']);
            if (!created) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Please sign in.');
            await audit(db, {actorId: created.id, action: 'doctor.registered', targetId: created.id, ip: request.ip});
            return created;
        });
        await startSession(app, request, reply, user);
        reply.code(201);
        return {user: publicUser(user)};
    });

    // Doctors and admins: email and password.
    app.post('/api/auth/login', {
        config: ipLimit(30),
        schema: {body: {type: 'object', required: ['email', 'password'], properties: {
            email: {type: 'string', maxLength: 254}, password: {type: 'string', maxLength: 200}
        }}}
    }, async (request, reply) => {
        const email = normalizeEmail(request.body.email) || '';
        const {rows: [failures]} = await app.pg.query(
            'SELECT count(*)::int AS n FROM login_failures WHERE email = $1 AND created_at > now() - make_interval(mins => $2)', [email, LOGIN_WINDOW_MINUTES]);
        if (failures.n >= LOGIN_MAX_FAILURES) throw new HttpError(429, 'locked', 'Too many failed attempts. Please wait 15 minutes and try again.');
        const {rows: [user]} = await app.pg.query("SELECT * FROM users WHERE email = $1 AND role IN ('doctor', 'admin')", [email]);
        const valid = await verifyPassword(request.body.password, user?.password_hash || dummyPasswordHash);
        if (!user || !valid || user.disabled_at) {
            await app.pg.query('INSERT INTO login_failures (email, ip) VALUES ($1, $2)', [email, request.ip]);
            throw new HttpError(401, 'wrong_credentials', 'Email or password is not correct.');
        }
        await app.pg.query('DELETE FROM login_failures WHERE email = $1', [email]);
        await startSession(app, request, reply, user);
        return {user: publicUser(user)};
    });

    app.post('/api/auth/logout', async (request, reply) => {
        if (request.user) await app.pg.query('DELETE FROM sessions WHERE token_hash = $1', [request.user.token_hash]);
        reply.clearCookie(SESSION_COOKIE, {path: '/'});
        return {signedOut: true};
    });

    app.get('/api/me', {preHandler: requireRole('patient', 'doctor', 'admin')}, async request => ({user: publicUser(request.user)}));
}

export {HttpError};
