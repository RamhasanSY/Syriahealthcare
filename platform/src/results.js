// Lab results as QR codes. An approved lab or imaging centre uploads a result for a patient and prints a QR code;
// an approved doctor scans it and the result is added to that doctor's patient file.
// The QR code holds only a random key, never the result, so a lost paper shows nothing to anyone but an approved doctor.
import multipart from '@fastify/multipart';
import qrcode from 'qrcode-generator';
import {randomInt} from 'node:crypto';
import {HttpError, requireRole} from './auth.js';
import {audit} from './db.js';
import {sendDocument} from './doctors.js';
import {MAX_DOCUMENT_BYTES, sniffType} from './documents.js';
import {normalizePhone, resultCodeHash} from './security.js';

const RESULT_KINDS = ['lab', 'imaging'];
const CODE_DAYS = 90;
// 12 characters from 32 (about 60 bits). No 0/O or 1/I, so a code typed from paper is never ambiguous.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const group = code => code.replace(/(.{4})(?!$)/g, '$1-');

export const newResultCode = () => group(Array.from({length: 12}, () => ALPHABET[randomInt(ALPHABET.length)]).join(''));

// Accepts a code as scanned or typed: any case, with or without dashes and spaces.
export function cleanResultCode(raw) {
    const code = String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    return code.length === 12 && [...code].every(c => ALPHABET.includes(c)) ? group(code) : null;
}

function qrSvg(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({cellSize: 4, margin: 4, scalable: true});
}

// The lab sees its own results, never which or how many doctors opened them (that would tell it where the patient goes).
const labView = r => ({id: r.id, patient_name: r.patient_name, patient_phone: r.patient_phone, title: r.title, filename: r.filename,
    created_at: r.created_at, code_expires_at: r.code_expires_at, code_expired: new Date(r.code_expires_at) <= new Date()});

const PAGE = 50;
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
// Paging cursor: the exact creation time (microseconds, as text) and id of the last result shown.
const encodeCursor = row => Buffer.from(JSON.stringify([row.cursor_at, row.id])).toString('base64url');
function decodeCursor(raw) {
    try {
        const [at, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(at) && /^[0-9a-f-]{36}$/.test(id)) return {at, id};
    } catch (_) {}
    return null;
}
const doctorView = r => ({id: r.id, title: r.title, patient_name: r.patient_name, patient_phone: r.patient_phone, lab_name: r.lab_name,
    mime: r.mime, created_at: r.created_at});

// Slips printed while the health file is on tell the patient they can take the result into their own file (version 2).
// Only those can be taken over: a patient holding an older slip was never told about it.
const slipVersion = app => app.config.healthFile ? 2 : 1;

// What the lab prints for the patient. The code is shown only here, right after it is made; the server keeps just its HMAC.
function slip(app, result, code, labName) {
    const url = `${app.config.appOrigin}/scan#${code}`;
    return {result: labView(result), lab_name: labName, code, scan_url: url, qr_svg: qrSvg(url),
        health_file: result.slip_version >= 2 ? {url: `${app.config.appOrigin}/file`, check: result.birth_year ? 'birth_year_or_phone' : 'phone'} : null};
}

export default async function resultRoutes(app) {
    await app.register(multipart, {limits: {fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 4, fieldSize: 1000}});
    const facilityOnly = {preHandler: requireRole('facility')};
    const doctorOnly = {preHandler: requireRole('doctor')};
    const uuidParam = {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}};
    const codeHash = code => resultCodeHash(app.config.otpSecret, code);

    async function loadLab(userId) {
        const {rows: [lab]} = await app.pg.query('SELECT kind, status, facility_name FROM facility_profiles WHERE user_id = $1', [userId]);
        if (!lab || !RESULT_KINDS.includes(lab.kind)) throw new HttpError(403, 'not_a_lab', 'Only laboratories and imaging centres can send results.');
        if (lab.status !== 'approved') throw new HttpError(403, 'lab_not_approved', 'Your facility must be approved before you can send results.');
        return lab;
    }

    async function checkDoctor(userId) {
        const {rows: [doctor]} = await app.pg.query('SELECT status FROM doctor_profiles WHERE user_id = $1', [userId]);
        if (doctor?.status !== 'approved') throw new HttpError(403, 'doctor_not_approved', 'Your profile must be approved before you can use patient files.');
    }

    // Unknown, mistyped and expired codes get the same answer.
    async function findByCode(raw) {
        const code = cleanResultCode(raw);
        const {rows: [result]} = code ? await app.pg.query(
            `SELECT r.*, p.facility_name AS lab_name FROM lab_results r JOIN facility_profiles p ON p.user_id = r.facility_id
             WHERE r.code_hash = $1 AND r.code_expires_at > now()`, [codeHash(code)]) : {rows: []};
        if (!result) throw new HttpError(404, 'code_invalid', 'This code is not valid. Check it, or ask the lab for a new one.');
        return result;
    }

    // ---- Lab side ----

    // All of the lab's own results, newest first, 50 at a time. q finds a patient's name, the test, or a mobile number
    // (the whole number in any usual form, or its last digits); from/to are days in Syria time.
    app.get('/api/lab/results', {...facilityOnly, schema: {querystring: {type: 'object', additionalProperties: false, properties: {
        q: {type: 'string', maxLength: 80}, from: {type: 'string', pattern: DATE}, to: {type: 'string', pattern: DATE},
        cursor: {type: 'string', maxLength: 200}
    }}}}, async request => {
        const lab = await loadLab(request.user.id);
        const where = ['r.facility_id = $1'], args = [request.user.id];
        const q = (request.query.q || '').trim();
        if (q) {
            const parts = [`r.patient_name ILIKE $${args.push('%' + q.replace(/[%_\\]/g, '\\$&') + '%')}`, `r.title ILIKE $${args.length}`];
            const phone = normalizePhone(q), digits = q.replace(/\D/g, '');
            if (phone) parts.push(`r.patient_phone = $${args.push(phone)}`);
            else if (digits.length >= 4 && digits.length === q.replace(/[\s\-().+]/g, '').length) parts.push(`r.patient_phone LIKE $${args.push('%' + digits)}`);
            where.push(`(${parts.join(' OR ')})`);
        }
        if (request.query.from) where.push(`r.created_at >= ($${args.push(request.query.from)}::date::timestamp AT TIME ZONE 'Asia/Damascus')`);
        if (request.query.to) where.push(`r.created_at < (($${args.push(request.query.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Damascus')`);
        if (request.query.cursor) {
            const cursor = decodeCursor(request.query.cursor);
            if (!cursor) throw new HttpError(400, 'invalid_cursor', 'This list link is not valid. Please search again.');
            where.push(`(r.created_at, r.id) < ($${args.push(cursor.at)}::timestamptz, $${args.push(cursor.id)}::uuid)`);
        }
        const {rows} = await app.pg.query(
            `SELECT r.*, to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
             FROM lab_results r WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT ${PAGE + 1}`, args);
        const more = rows.length > PAGE, page = rows.slice(0, PAGE);
        return {lab_name: lab.facility_name, results: page.map(labView), next_cursor: more ? encodeCursor(page.at(-1)) : null};
    });

    // Multipart form: patient_name, patient_phone and title first, then the file.
    app.post('/api/lab/results', facilityOnly, async (request, reply) => {
        const lab = await loadLab(request.user.id);
        const part = await request.file().catch(() => null);
        if (!part) throw new HttpError(400, 'no_file', 'Choose a file to upload.');
        const field = name => String(part.fields[name]?.value ?? '').trim();
        const patientName = field('patient_name'), title = field('title'), patientPhone = normalizePhone(field('patient_phone'));
        if (patientName.length < 2 || patientName.length > 120) throw new HttpError(400, 'invalid_patient_name', 'Enter the patient\'s full name.');
        if (!patientPhone) throw new HttpError(400, 'invalid_phone', 'Enter a valid mobile number, for example 0912 345 678.');
        if (title.length < 2 || title.length > 120) throw new HttpError(400, 'invalid_title', 'Enter what was tested, for example "Complete blood count".');
        // Optional: the patient's birth year. With the health file on, it lets the patient take the result into their own file.
        const birthYear = field('birth_year') ? Number(field('birth_year')) : null;
        if (birthYear !== null && !(Number.isInteger(birthYear) && birthYear >= 1900 && birthYear <= new Date().getFullYear())) {
            throw new HttpError(400, 'invalid_birth_year', 'Enter the birth year with 4 digits, for example 1985.');
        }
        const buffer = await part.toBuffer().catch(error => {
            if (error.code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, 'file_too_large', 'The file is larger than 5 MB.');
            throw error;
        });
        const mime = sniffType(buffer);
        if (!mime) throw new HttpError(400, 'invalid_file_type', 'Upload a PDF, JPG or PNG file.');
        const stored = await app.documents.save(buffer), code = newResultCode();
        const filename = String(part.filename || 'result').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200);
        try {
            const {rows: [result]} = await app.pg.query(
                `INSERT INTO lab_results (facility_id, patient_name, patient_phone, title, code_hash, code_expires_at,
                     filename, mime, size_bytes, sha256, storage_key, iv, auth_tag, birth_year, slip_version)
                 VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
                [request.user.id, patientName, patientPhone, title, codeHash(code), CODE_DAYS,
                    filename, mime, buffer.length, stored.sha256, stored.storageKey, stored.iv, stored.authTag, birthYear, slipVersion(app)]);
            await audit(app.pg, {actorId: request.user.id, action: 'result.uploaded', targetId: result.id, details: {size: buffer.length}, ip: request.ip});
            reply.code(201);
            return slip(app, result, code, lab.facility_name);
        } catch (error) {
            await app.documents.remove(stored.storageKey);
            throw error;
        }
    });

    // A lost or badly printed QR code: a new one replaces it, and the old one stops working.
    app.post('/api/lab/results/:id/code', {...facilityOnly, schema: uuidParam}, async request => {
        const lab = await loadLab(request.user.id), code = newResultCode();
        const {rows: [result]} = await app.pg.query(
            `UPDATE lab_results r SET code_hash = $3, code_expires_at = now() + make_interval(days => $4), claim_attempts = 0,
                 slip_version = GREATEST(r.slip_version, $5) WHERE r.id = $1 AND r.facility_id = $2
             RETURNING r.*`,
            [request.params.id, request.user.id, codeHash(code), CODE_DAYS, slipVersion(app)]);
        if (!result) throw new HttpError(404, 'not_found', 'Result not found.');
        await audit(app.pg, {actorId: request.user.id, action: 'result.new_code', targetId: result.id, ip: request.ip});
        return slip(app, result, code, lab.facility_name);
    });

    // ---- Doctor side ----

    const codeRoute = {...doctorOnly, config: {rateLimit: {max: 60, timeWindow: '15 minutes'}},
        schema: {body: {type: 'object', required: ['code'], additionalProperties: false, properties: {code: {type: 'string', maxLength: 40}}}}};

    // Shows whose result a scanned code is, so the doctor can check it before adding it.
    app.post('/api/doctor/results/lookup', codeRoute, async request => {
        await checkDoctor(request.user.id);
        const result = await findByCode(request.body.code);
        const {rows: [added]} = await app.pg.query('SELECT 1 FROM patient_file_results WHERE doctor_id = $1 AND result_id = $2', [request.user.id, result.id]);
        return {result: {...doctorView(result), added: Boolean(added)}};
    });

    app.post('/api/doctor/results/add', codeRoute, async request => {
        await checkDoctor(request.user.id);
        const result = await findByCode(request.body.code);
        const {rowCount} = await app.pg.query(
            'INSERT INTO patient_file_results (doctor_id, result_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [request.user.id, result.id]);
        if (rowCount) await audit(app.pg, {actorId: request.user.id, action: 'result.added', targetId: result.id, ip: request.ip});
        return {result: {...doctorView(result), added: true}};
    });

    // The doctor's patient files: every scanned result, grouped by patient (mobile number), newest first.
    app.get('/api/doctor/records', doctorOnly, async request => {
        await checkDoctor(request.user.id);
        const {rows} = await app.pg.query(
            `SELECT r.id, r.title, r.patient_name, r.patient_phone, r.mime, r.created_at, f.added_at, p.facility_name AS lab_name
             FROM patient_file_results f JOIN lab_results r ON r.id = f.result_id JOIN facility_profiles p ON p.user_id = r.facility_id
             WHERE f.doctor_id = $1 ORDER BY r.created_at DESC LIMIT 1000`, [request.user.id]);
        const patients = new Map();
        for (const row of rows) {
            if (!patients.has(row.patient_phone)) patients.set(row.patient_phone, {phone: row.patient_phone, name: row.patient_name, results: []});
            patients.get(row.patient_phone).results.push({...doctorView(row), added_at: row.added_at});
        }
        return {patients: [...patients.values()]};
    });

    // Opens a result from the doctor's own patient files. Every view is recorded.
    app.get('/api/doctor/results/:id/file', {...doctorOnly, schema: uuidParam}, async (request, reply) => {
        await checkDoctor(request.user.id);
        const {rows: [result]} = await app.pg.query(
            `SELECT r.* FROM lab_results r JOIN patient_file_results f ON f.result_id = r.id AND f.doctor_id = $2 WHERE r.id = $1`,
            [request.params.id, request.user.id]);
        if (!result) throw new HttpError(404, 'not_found', 'Result not found.');
        const content = await app.documents.open(result);
        await audit(app.pg, {actorId: request.user.id, action: 'result.viewed', targetId: result.id, ip: request.ip});
        return sendDocument(reply, result, content);
    });
}
