// Sharing the health file with doctors (stage 2c), and "My patients" for doctors.
// Patients share single entries: from the directory for 1, 30 or 90 days, when booking until 30 days after the
// appointment, or by showing a QR code that gives the doctor who scans it 15 minutes. They see who has access and who
// opened what, and revoke a share, one entry of it, or a doctor's scan of a lab slip, with immediate effect.
// Doctors see shared entries only when approved and after the second factor (an emailed code) in this session.
// All access decisions are in src/access.js. Like the health file itself, everything here is off until HEALTH_FILE=on.
import qrcode from 'qrcode-generator';
import {randomInt} from 'node:crypto';
import {HttpError, requireRole} from './auth.js';
import {audit, transaction} from './db.js';
import {doctorDocument, notFound, patientFor, requireSharingDoctor, sharedDocumentIds} from './access.js';
import {sendFileSandboxed} from './healthfile.js';
import {sendEmail} from './notify.js';
import {normalizePhone, resultCodeHash} from './security.js';
import {specialties} from './catalog.js';

export const SHARE_DAYS = [1, 30, 90];
export const QR_MINUTES = 15;
export const BOOKING_DAYS_AFTER = 30;
const MAX_ITEMS = 100;
// Share codes: 8 characters (result codes have 12), so the doctor's scan page can tell them apart.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const newShareCode = () => {
    const raw = Array.from({length: 8}, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
};
export function cleanShareCode(input) {
    const code = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    return code.length === 8 && [...code].every(c => ALPHABET.includes(c)) ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
}
const qrSvg = text => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({cellSize: 4, margin: 4, scalable: true});
};

const UUID = {type: 'string', format: 'uuid'};
const idParam = {params: {type: 'object', properties: {id: UUID}}};
const itemIds = {type: 'array', minItems: 1, maxItems: MAX_ITEMS, uniqueItems: true, items: UUID};

// The chosen entries must all belong to this profile and not be in the bin.
async function checkItems(db, patientId, ids) {
    const {rows} = await db.query('SELECT id FROM clinical_documents WHERE patient_id = $1 AND deleted_at IS NULL AND id = ANY($2)', [patientId, ids]);
    if (rows.length !== ids.length) throw new HttpError(400, 'invalid_items', 'Some of the chosen entries no longer exist. Please reload.');
}
async function hasConsent(db, patientId) {
    const {rows: [c]} = await db.query("SELECT 1 FROM consents WHERE patient_id = $1 AND scope = 'health_file' AND withdrawn_at IS NULL", [patientId]);
    return Boolean(c);
}
async function approvedDoctor(db, doctorId) {
    const {rows: [d]} = await db.query(
        `SELECT u.id, u.name, u.email, u.language, p.specialty FROM users u JOIN doctor_profiles p ON p.user_id = u.id
         WHERE u.id = $1 AND u.role = 'doctor' AND u.disabled_at IS NULL AND p.status = 'approved'`, [doctorId]);
    if (!d) throw new HttpError(404, 'not_found', 'Doctor not found.');
    return d;
}

export async function createGrant(db, {patientId, doctorId, grantedBy, source, appointmentId = null, expiresAt, ids}) {
    const {rows: [grant]} = await db.query(
        `INSERT INTO access_grants (patient_id, doctor_id, granted_by, source, appointment_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [patientId, doctorId, grantedBy, source, appointmentId, expiresAt]);
    await db.query('INSERT INTO access_grant_items (grant_id, document_id) SELECT $1, unnest($2::uuid[])', [grant.id, ids]);
    return grant;
}

// Used by booking (src/appointments.js): share entries with the doctor until 30 days after the appointment.
export async function shareForAppointment(app, request, {subjectId, doctorId, appointment, ids}) {
    if (!ids?.length) return null;
    if (!app.config.healthFile) throw new HttpError(400, 'sharing_unavailable', 'Sharing is not available yet.');
    if (!await hasConsent(app.pg, subjectId)) throw new HttpError(403, 'file_consent_required', 'Please agree to keeping a health file first.');
    await checkItems(app.pg, subjectId, ids);
    const expiresAt = new Date(new Date(appointment.ends_at).getTime() + BOOKING_DAYS_AFTER * 86400_000);
    const grant = await createGrant(app.pg, {patientId: subjectId, doctorId, grantedBy: request.user.id, source: 'booking',
        appointmentId: appointment.id, expiresAt, ids});
    await audit(app.pg, {actorId: request.user.id, action: 'health_file.shared', targetId: grant.id,
        details: {patient_id: subjectId, doctor_id: doctorId, items: ids.length, source: 'booking'}, ip: request.ip});
    return grant;
}

const doctorLabel = d => ({id: d.doctor_id ?? d.id, name: d.doctor_name ?? d.name, specialty: d.specialty ? specialties[d.specialty] ?? null : null});

export default async function sharingRoutes(app) {
    app.addHook('onRequest', async request => {
        if (!app.config.healthFile && /^\/api\/(file|doctor\/(patients|shared|share-codes))/.test(request.url)) throw notFound();
    });
    const patientOnly = requireRole('patient');
    const doctorOnly = requireRole('doctor');
    const record = (request, action, targetId, details) => audit(app.pg, {actorId: request.user.id, action, targetId, details, ip: request.ip});

    // ---- Patients ----

    app.post('/api/file/profiles/:id/shares', {preHandler: patientOnly, schema: {...idParam, body: {type: 'object', required: ['doctor_id', 'item_ids'],
        additionalProperties: false, properties: {doctor_id: UUID, item_ids: itemIds, days: {enum: SHARE_DAYS}}}}}, async (request, reply) => {
        const p = await patientFor(app.pg, request.user, request.params.id);
        if (!await hasConsent(app.pg, p.id)) throw new HttpError(403, 'file_consent_required', 'Please agree to keeping a health file first.');
        const doctor = await approvedDoctor(app.pg, request.body.doctor_id);
        await checkItems(app.pg, p.id, request.body.item_ids);
        const days = request.body.days ?? 90;
        const grant = await transaction(app.pg, db => createGrant(db, {patientId: p.id, doctorId: doctor.id, grantedBy: request.user.id,
            source: 'directory', expiresAt: new Date(Date.now() + days * 86400_000), ids: request.body.item_ids}));
        await record(request, 'health_file.shared', grant.id, {patient_id: p.id, doctor_id: doctor.id, items: request.body.item_ids.length, days});
        await sendEmail(app, doctor.email, {
            subject: doctor.language === 'en' ? 'A patient shared health file entries with you — SyriaHC' : 'شارك مريض معك مستندات من ملفه الصحي — صحة تك',
            text: `${p.name} shared ${request.body.item_ids.length} entries with you for ${days} days.\nOpen them under "My patients": ${app.config.appOrigin}/patients\n\n` +
                `شارك ${p.name} معك ${request.body.item_ids.length} مستندات لمدة ${days} يوماً.\nافتحها في «مرضاي»: ${app.config.appOrigin}/patients`
        });
        reply.code(201);
        return {share: {id: grant.id, doctor: doctorLabel(doctor), expires_at: grant.expires_at}};
    });

    // "Show to the doctor": a one-time code for 15 minutes, as QR and as text.
    app.post('/api/file/profiles/:id/share-codes', {preHandler: patientOnly, config: {rateLimit: {max: 20, timeWindow: '15 minutes'}},
        schema: {...idParam, body: {type: 'object', required: ['item_ids'], additionalProperties: false, properties: {item_ids: itemIds}}}}, async (request, reply) => {
        const p = await patientFor(app.pg, request.user, request.params.id);
        if (!await hasConsent(app.pg, p.id)) throw new HttpError(403, 'file_consent_required', 'Please agree to keeping a health file first.');
        await checkItems(app.pg, p.id, request.body.item_ids);
        const code = newShareCode();
        const {rows: [row]} = await app.pg.query(
            `INSERT INTO share_codes (patient_id, created_by, code_hash, document_ids, expires_at)
             VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING id, expires_at`,
            [p.id, request.user.id, resultCodeHash(app.config.otpSecret, 'share:' + code), request.body.item_ids, QR_MINUTES]);
        await record(request, 'health_file.share_code_created', row.id, {patient_id: p.id, items: request.body.item_ids.length});
        const url = `${app.config.appOrigin}/scan#${code}`;
        reply.code(201);
        return {code, url, qr_svg: qrSvg(url), expires_at: row.expires_at, minutes: QR_MINUTES};
    });

    // Who has access, and who opened what. Without network addresses.
    app.get('/api/file/profiles/:id/access', {preHandler: patientOnly, schema: idParam}, async request => {
        const p = await patientFor(app.pg, request.user, request.params.id);
        const {rows: grants} = await app.pg.query(
            `SELECT g.*, u.name AS doctor_name, dp.specialty,
                    json_agg(json_build_object('id', d.id, 'title', d.title, 'revoked', i.revoked_at IS NOT NULL) ORDER BY d.created_at) AS items
             FROM access_grants g JOIN users u ON u.id = g.doctor_id LEFT JOIN doctor_profiles dp ON dp.user_id = g.doctor_id
             JOIN access_grant_items i ON i.grant_id = g.id JOIN clinical_documents d ON d.id = i.document_id
             WHERE g.patient_id = $1 AND g.created_at > now() - interval '1 year'
             GROUP BY g.id, u.name, dp.specialty ORDER BY g.created_at DESC`, [p.id]);
        const {rows: scans} = await app.pg.query(
            `SELECT f.doctor_id, u.name AS doctor_name, dp.specialty, f.added_at, f.revoked_at, d.id AS document_id, d.title, f.result_id
             FROM clinical_documents d JOIN patient_file_results f ON f.result_id = d.lab_result_id
             JOIN users u ON u.id = f.doctor_id LEFT JOIN doctor_profiles dp ON dp.user_id = f.doctor_id
             WHERE d.patient_id = $1 ORDER BY f.added_at DESC`, [p.id]);
        const {rows: log} = await app.pg.query(
            `SELECT a.id, a.action, a.created_at, a.target_id, u.name AS actor_name, u.role::text AS actor_role, d.title
             FROM audit_log a JOIN users u ON u.id = a.actor_id LEFT JOIN clinical_documents d ON d.id = a.target_id
             WHERE a.details->>'patient_id' = $1::text AND u.role = 'doctor'
             ORDER BY a.created_at DESC LIMIT 200`, [p.id]);
        const now = Date.now();
        return {
            shares: grants.map(g => ({id: g.id, doctor: doctorLabel(g), source: g.source, starts_at: g.starts_at, expires_at: g.expires_at,
                revoked_at: g.revoked_at, active: !g.revoked_at && new Date(g.expires_at).getTime() > now, items: g.items})),
            scans: scans.map(s => ({result_id: s.result_id, document_id: s.document_id, title: s.title, doctor: doctorLabel(s), added_at: s.added_at, revoked_at: s.revoked_at})),
            log: log.map(l => ({id: l.id, action: l.action, at: l.created_at, doctor_name: l.actor_name, title: l.title}))
        };
    });

    async function ownGrant(request, id) {
        const {rows: [g]} = await app.pg.query('SELECT * FROM access_grants WHERE id = $1', [id]);
        if (!g) throw notFound();
        await patientFor(app.pg, request.user, g.patient_id);
        return g;
    }

    app.post('/api/file/shares/:id/revoke', {preHandler: patientOnly, schema: idParam}, async request => {
        const g = await ownGrant(request, request.params.id);
        await app.pg.query('UPDATE access_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [g.id]);
        await record(request, 'health_file.share_revoked', g.id, {patient_id: g.patient_id, doctor_id: g.doctor_id});
        return {revoked: true};
    });

    app.post('/api/file/shares/:id/items/:item/revoke', {preHandler: patientOnly, schema: {params: {type: 'object', properties: {id: UUID, item: UUID}}}}, async request => {
        const g = await ownGrant(request, request.params.id);
        const {rowCount} = await app.pg.query('UPDATE access_grant_items SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1 AND document_id = $2',
            [g.id, request.params.item]);
        if (!rowCount) throw notFound();
        await record(request, 'health_file.share_revoked', g.id, {patient_id: g.patient_id, doctor_id: g.doctor_id, item: request.params.item});
        return {revoked: true};
    });

    // Takes a scanned lab result back from a doctor's patient files (only for results in the patient's own file).
    app.post('/api/file/scans/:id/revoke', {preHandler: patientOnly, schema: {...idParam, body: {type: 'object', required: ['doctor_id'],
        additionalProperties: false, properties: {doctor_id: UUID}}}}, async request => {
        const {rows: [d]} = await app.pg.query('SELECT patient_id FROM clinical_documents WHERE lab_result_id = $1', [request.params.id]);
        if (!d) throw notFound();
        await patientFor(app.pg, request.user, d.patient_id);
        const {rowCount} = await app.pg.query(
            'UPDATE patient_file_results SET revoked_at = COALESCE(revoked_at, now()) WHERE result_id = $1 AND doctor_id = $2', [request.params.id, request.body.doctor_id]);
        if (!rowCount) throw notFound();
        await record(request, 'health_file.scan_revoked', request.params.id, {patient_id: d.patient_id, doctor_id: request.body.doctor_id});
        return {revoked: true};
    });

    // ---- Doctors ----

    // Redeems a code the patient shows: the first approved doctor who scans it gets 15 minutes.
    app.post('/api/doctor/share-codes/redeem', {preHandler: doctorOnly, config: {rateLimit: {max: 30, timeWindow: '15 minutes'}},
        schema: {body: {type: 'object', required: ['code'], additionalProperties: false, properties: {code: {type: 'string', maxLength: 20}}}}}, async request => {
        await requireSharingDoctor(app.pg, request);
        const code = cleanShareCode(request.body.code);
        const grant = code && await transaction(app.pg, async db => {
            const {rows: [row]} = await db.query(
                `UPDATE share_codes SET used_at = now(), used_by = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`,
                [resultCodeHash(app.config.otpSecret, 'share:' + code), request.user.id]);
            if (!row) return null;
            const {rows: live} = await db.query('SELECT id FROM clinical_documents WHERE id = ANY($1) AND deleted_at IS NULL', [row.document_ids]);
            if (!live.length) return null;
            const g = await createGrant(db, {patientId: row.patient_id, doctorId: request.user.id, grantedBy: row.created_by, source: 'qr',
                expiresAt: new Date(Date.now() + QR_MINUTES * 60_000), ids: live.map(r => r.id)});
            await db.query('UPDATE share_codes SET grant_id = $2 WHERE id = $1', [row.id, g.id]);
            return g;
        });
        if (!grant) throw new HttpError(404, 'share_code_invalid', 'This code is not valid any more. Ask the patient to show a new one.');
        await record(request, 'health_file.share_code_used', grant.id, {patient_id: grant.patient_id});
        return {patient_id: grant.patient_id, expires_at: grant.expires_at};
    });

    // "My patients": everyone this doctor knows from appointments, scanned slips and shares, grouped by person.
    // Shared profiles appear only after the second factor; the response says when it is missing.
    app.get('/api/doctor/patients', {preHandler: doctorOnly, schema: {querystring: {type: 'object', additionalProperties: false,
        properties: {q: {type: 'string', maxLength: 80}}}}}, async request => {
        const {rows: [profile]} = await app.pg.query('SELECT status FROM doctor_profiles WHERE user_id = $1', [request.user.id]);
        if (profile?.status !== 'approved') throw new HttpError(403, 'doctor_not_approved', 'Your profile must be approved before you can see patients.');
        const secondFactor = Boolean(request.user.second_factor_at);
        const q = (request.query.q || '').trim();
        const args = [request.user.id];
        let filter = '';
        if (q) {
            const like = '%' + q.replace(/[%_\\]/g, '\\$&') + '%', phone = normalizePhone(q), digits = q.replace(/\D/g, '');
            args.push(like, phone || (digits.length >= 4 ? '%' + digits : '__none__'), q.toUpperCase().replace(/[^0-9A-Z]/g, ''));
            filter = `WHERE name ILIKE $2 OR phone LIKE $3 OR replace(patient_number, '-', '') LIKE '%' || NULLIF($4, '') || '%'`;
        }
        const {rows} = await app.pg.query(
            `WITH sources AS (
                SELECT COALESCE(a.subject_id::text, 'user:' || a.patient_id) AS key, COALESCE(s.name, u.name) AS name, u.phone,
                       NULL::text AS patient_number, 'appointment' AS source, a.starts_at AS at
                FROM appointments a JOIN users u ON u.id = a.patient_id LEFT JOIN patients s ON s.id = a.subject_id
                WHERE a.doctor_id = $1
                UNION ALL
                SELECT COALESCE(d.patient_id::text, 'phone:' || r.patient_phone), r.patient_name, r.patient_phone, NULL, 'scan', f.added_at
                FROM patient_file_results f JOIN lab_results r ON r.id = f.result_id LEFT JOIN clinical_documents d ON d.lab_result_id = r.id
                WHERE f.doctor_id = $1 AND f.revoked_at IS NULL
                ${secondFactor ? `UNION ALL
                SELECT p.id::text, p.name, NULL, p.patient_number, 'share', g.created_at
                FROM access_grants g JOIN patients p ON p.id = g.patient_id
                WHERE g.doctor_id = $1 AND g.revoked_at IS NULL AND g.expires_at > now()` : ''}
            )
            SELECT key, max(name) AS name, max(phone) AS phone, max(patient_number) AS patient_number, max(at) AS last_contact,
                   count(*) FILTER (WHERE source = 'appointment')::int AS appointments, count(*) FILTER (WHERE source = 'scan')::int AS scans,
                   count(*) FILTER (WHERE source = 'share')::int AS shares
            FROM sources ${filter} GROUP BY key ORDER BY max(at) DESC LIMIT 300`, args);
        return {second_factor: secondFactor, patients: rows.map(r => ({key: r.key, profile_id: /^[0-9a-f-]{36}$/.test(r.key) ? r.key : null,
            name: r.name, phone: r.phone, patient_number: r.patient_number, last_contact: r.last_contact,
            sources: {appointments: r.appointments, scans: r.scans, shares: r.shares}}))};
    });

    // One shared profile: the entries this doctor may open now. 404 without an active share.
    app.get('/api/doctor/patients/:id', {preHandler: doctorOnly, schema: idParam}, async request => {
        await requireSharingDoctor(app.pg, request);
        const ids = await sharedDocumentIds(app.pg, request.user.id, request.params.id);
        if (!ids.length) throw notFound();
        const {rows: [p]} = await app.pg.query('SELECT id, patient_number, name, birth_date, sex FROM patients WHERE id = $1', [request.params.id]);
        const {rows: items} = await app.pg.query(
            `SELECT h.*, (SELECT max(g.expires_at) FROM access_grants g JOIN access_grant_items i ON i.grant_id = g.id
                          WHERE g.doctor_id = $2 AND i.document_id = h.id AND g.revoked_at IS NULL AND i.revoked_at IS NULL) AS shared_until
             FROM health_file_items h WHERE h.id = ANY($1) ORDER BY COALESCE(h.document_date, h.created_at::date) DESC`, [ids, request.user.id]);
        await record(request, 'health_file.opened', p.id, {patient_id: p.id});
        return {patient: p, items: items.map(i => ({id: i.id, source: i.source, category: i.category, title: i.title, document_date: i.document_date,
            created_at: i.created_at, pages: i.pages, lab_name: i.lab_name, shared_until: i.shared_until}))};
    });

    app.get('/api/doctor/shared/:id/pages/:page', {preHandler: doctorOnly, schema: {params: {type: 'object', properties: {
        id: UUID, page: {type: 'integer', minimum: 1, maximum: 30}}}}}, async (request, reply) => {
        await requireSharingDoctor(app.pg, request);
        const d = await doctorDocument(app.pg, request.user.id, request.params.id);
        if (!d) throw notFound();
        const {rows: [file]} = d.lab_result_id
            ? (request.params.page === 1 ? await app.pg.query('SELECT * FROM lab_results WHERE id = $1', [d.lab_result_id]) : {rows: []})
            : await app.pg.query('SELECT * FROM clinical_document_files WHERE document_id = $1 AND page = $2', [d.id, request.params.page]);
        if (!file) throw notFound();
        const content = await app.documents.open(file);
        await record(request, 'health_document.viewed', d.id, {patient_id: d.patient_id, page: request.params.page, via: 'share'});
        return sendFileSandboxed(reply, file, content);
    });
}
