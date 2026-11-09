// Health file for patients (stage 2b): own profile and children's profiles with a SyriaHC patient number, a timeline of
// entries, uploads of photos and PDFs (several pages), and taking over a lab result from the printed slip.
// Everything is switched off until HEALTH_FILE=on (after the new privacy policy); then every route answers 404.
// Who may open what is decided in src/access.js only.
import multipart from '@fastify/multipart';
import {HttpError, requireRole} from './auth.js';
import {documentCategories} from './catalog.js';
import {audit, transaction} from './db.js';
import {createPatient, ensureSelfProfile, notFound, ownProfiles, patientFor} from './access.js';
import {sendDocument} from './doctors.js';
import {MAX_DOCUMENT_BYTES} from './documents.js';
import {cleanResultCode} from './results.js';
import {resultCodeHash} from './security.js';
import {cleanUpload, UploadError} from './uploads.js';
import {sendEmail} from './notify.js';

// Kinds of entries, with the LOINC document type used in FHIR (src/catalog.js).
export const CATEGORIES = documentCategories;

// Limits (decision 9 in docs/STUFE-2.md).
export const LIMITS = {documentsPerProfile: 100, bytesPerProfile: 200 * 1024 * 1024, pagesPerDay: 30, pagesPerUpload: 10, children: 10, claimAttempts: 5, binDays: 30};
export const POLICY_VERSION = '2026-11-draft';

const UUID = {type: 'string', format: 'uuid'};
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const validDate = d => typeof d === 'string' && new RegExp(DATE).test(d) && new Date(d + 'T00:00:00Z').toISOString().startsWith(d);
const today = () => new Date().toISOString().slice(0, 10);
const yearsBetween = (from, to) => {
    const a = new Date(from + 'T00:00:00Z'), b = new Date(to + 'T00:00:00Z');
    return b.getUTCFullYear() - a.getUTCFullYear() - ((b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate())) ? 1 : 0);
};
const isoDate = value => value ? (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)) : null;

export const profileView = p => ({id: p.id, patient_number: p.patient_number, name: p.name, birth_date: isoDate(p.birth_date),
    sex: p.sex, relationship: p.relationship, consent: Boolean(p.consent)});
export const itemView = i => ({id: i.id, source: i.source, category: i.category, title: i.title, document_date: isoDate(i.document_date),
    created_at: i.created_at, pages: i.pages, size_bytes: i.size_bytes, lab_name: i.lab_name || null, deleted_at: i.deleted_at});

async function hasConsent(db, patientId) {
    const {rows: [c]} = await db.query("SELECT 1 FROM consents WHERE patient_id = $1 AND scope = 'health_file' AND withdrawn_at IS NULL", [patientId]);
    return Boolean(c);
}

export default async function healthFileRoutes(app) {
    // Off: the routes do not exist for anyone.
    app.addHook('onRequest', async request => {
        if (!app.config.healthFile && request.url.startsWith('/api/file')) throw notFound();
    });
    await app.register(multipart, {limits: {fileSize: MAX_DOCUMENT_BYTES, files: LIMITS.pagesPerUpload, fields: 5, fieldSize: 200}});
    const patientOnly = requireRole('patient');
    const idParam = {params: {type: 'object', properties: {id: UUID}}};
    const withAudit = (request, action, targetId, patientId, details = {}) =>
        audit(app.pg, {actorId: request.user.id, action, targetId, details: {patient_id: patientId, ...details}, ip: request.ip});

    async function profilesOf(user) {
        await ensureSelfProfile(app.pg, user);
        const rows = await ownProfiles(app.pg, user.id);
        for (const p of rows) p.consent = await hasConsent(app.pg, p.id);
        return rows;
    }

    // Loads an entry and checks, through access.js, that this login may open its profile.
    async function documentFor(request, id, {includeDeleted = false} = {}) {
        const {rows: [d]} = await app.pg.query('SELECT * FROM clinical_documents WHERE id = $1', [id]);
        if (!d || (d.deleted_at && !includeDeleted)) throw notFound();
        await patientFor(app.pg, request.user, d.patient_id);
        return d;
    }

    app.get('/api/file', {preHandler: patientOnly}, async request => ({
        profiles: (await profilesOf(request.user)).map(profileView),
        categories: Object.fromEntries(Object.entries(CATEGORIES).map(([key, c]) => [key, c.label])),
        limits: LIMITS, policy_version: POLICY_VERSION
    }));

    // A child's profile. Only children (under 18); handing a profile over at 18 comes later (decision 3).
    app.post('/api/file/profiles', {preHandler: patientOnly, schema: {body: {type: 'object', required: ['name', 'birth_date'], additionalProperties: false, properties: {
        name: {type: 'string', maxLength: 120}, birth_date: {type: 'string', pattern: DATE}, sex: {enum: ['female', 'male', null]}
    }}}}, async (request, reply) => {
        const name = request.body.name.trim(), birthDate = request.body.birth_date;
        if (name.length < 2) throw new HttpError(400, 'invalid_name', 'Enter the child\'s full name.');
        if (!validDate(birthDate) || birthDate > today() || yearsBetween(birthDate, today()) >= 18) {
            throw new HttpError(400, 'not_a_child', 'Children\'s profiles are for children under 18. Enter the birth date.');
        }
        await ensureSelfProfile(app.pg, request.user);
        const child = await transaction(app.pg, async db => {
            const {rows: [{n}]} = await db.query("SELECT count(*)::int AS n FROM patient_access WHERE user_id = $1 AND relationship = 'child'", [request.user.id]);
            if (n >= LIMITS.children) throw new HttpError(409, 'too_many_children', `At most ${LIMITS.children} children's profiles.`);
            const p = await createPatient(db, {name, birthDate, sex: request.body.sex || null});
            await db.query("INSERT INTO patient_access (user_id, patient_id, relationship) VALUES ($1, $2, 'child')", [request.user.id, p.id]);
            return {...p, relationship: 'child'};
        });
        await withAudit(request, 'patient.profile_created', child.id, child.id);
        reply.code(201);
        return {profile: profileView(child)};
    });

    app.post('/api/file/profiles/:id', {preHandler: patientOnly, schema: {...idParam, body: {type: 'object', additionalProperties: false, properties: {
        name: {type: 'string', maxLength: 120}, birth_date: {type: ['string', 'null'], pattern: DATE}, sex: {enum: ['female', 'male', null]}
    }}}}, async request => {
        const p = await patientFor(app.pg, request.user, request.params.id);
        const body = request.body || {};
        const name = body.name === undefined ? p.name : body.name.trim();
        if (name.length < 2) throw new HttpError(400, 'invalid_name', 'Enter the full name.');
        const birthDate = body.birth_date === undefined ? isoDate(p.birth_date) : body.birth_date;
        if (birthDate && (!validDate(birthDate) || birthDate > today())) throw new HttpError(400, 'invalid_date', 'Enter a valid date.');
        if (p.relationship === 'child' && (!birthDate || yearsBetween(birthDate, today()) >= 18)) {
            throw new HttpError(400, 'not_a_child', 'Children\'s profiles are for children under 18. Enter the birth date.');
        }
        const {rows: [updated]} = await app.pg.query(
            'UPDATE patients SET name = $2, birth_date = $3, sex = $4, updated_at = now() WHERE id = $1 RETURNING *',
            [p.id, name, birthDate, body.sex === undefined ? p.sex : body.sex]);
        await withAudit(request, 'patient.profile_updated', p.id, p.id);
        return {profile: profileView({...updated, relationship: p.relationship, consent: await hasConsent(app.pg, p.id)})};
    });

    // Consent to keep a health file for this profile, under the current privacy policy. Needed before anything is stored.
    app.post('/api/file/profiles/:id/consent', {preHandler: patientOnly, schema: idParam}, async request => {
        const p = await patientFor(app.pg, request.user, request.params.id);
        await app.pg.query(
            `INSERT INTO consents (patient_id, user_id, scope, policy_version) VALUES ($1, $2, 'health_file', $3)
             ON CONFLICT (patient_id, scope) WHERE withdrawn_at IS NULL DO NOTHING`, [p.id, request.user.id, POLICY_VERSION]);
        await withAudit(request, 'health_file.consent_given', p.id, p.id, {policy_version: POLICY_VERSION});
        return {consent: true};
    });

    // Withdrawing stops new entries. Existing entries stay until the patient deletes them (or asks us to delete the account).
    app.post('/api/file/profiles/:id/consent/withdraw', {preHandler: patientOnly, schema: idParam}, async request => {
        const p = await patientFor(app.pg, request.user, request.params.id);
        await app.pg.query("UPDATE consents SET withdrawn_at = now() WHERE patient_id = $1 AND scope = 'health_file' AND withdrawn_at IS NULL", [p.id]);
        await withAudit(request, 'health_file.consent_withdrawn', p.id, p.id);
        return {consent: false};
    });

    // The timeline, newest first. category, from/to (document date) filter; bin=true lists what is in the bin.
    app.get('/api/file/profiles/:id/items', {preHandler: patientOnly, schema: {...idParam, querystring: {type: 'object', additionalProperties: false, properties: {
        category: {enum: Object.keys(CATEGORIES)}, from: {type: 'string', pattern: DATE}, to: {type: 'string', pattern: DATE}, bin: {type: 'boolean'}
    }}}}, async request => {
        const p = await patientFor(app.pg, request.user, request.params.id);
        const where = ['patient_id = $1', request.query.bin ? `deleted_at > now() - interval '${LIMITS.binDays} days'` : 'deleted_at IS NULL'], args = [p.id];
        if (request.query.category) where.push(`category = $${args.push(request.query.category)}`);
        if (request.query.from) where.push(`COALESCE(document_date, created_at::date) >= $${args.push(request.query.from)}`);
        if (request.query.to) where.push(`COALESCE(document_date, created_at::date) <= $${args.push(request.query.to)}`);
        const {rows} = await app.pg.query(
            `SELECT * FROM health_file_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(document_date, created_at::date) DESC, created_at DESC LIMIT 500`, args);
        return {profile: profileView({...p, consent: await hasConsent(app.pg, p.id)}), items: rows.map(itemView)};
    });

    // Upload: fields category, title, document_date, then one file per page (PDF, JPEG or PNG, up to 5 MB each).
    app.post('/api/file/profiles/:id/documents', {preHandler: patientOnly, schema: idParam, config: {rateLimit: {max: 30, timeWindow: '15 minutes'}}},
        async (request, reply) => {
            const p = await patientFor(app.pg, request.user, request.params.id);
            if (!await hasConsent(app.pg, p.id)) throw new HttpError(403, 'consent_required', 'Please agree to keeping a health file first.');
            const pages = [];
            let fields = {};
            try {
                for await (const part of request.files()) {
                    fields = Object.fromEntries(Object.entries(part.fields).filter(([, f]) => f.type === 'field').map(([k, f]) => [k, String(f.value).trim()]));
                    const raw = await part.toBuffer();
                    pages.push({filename: String(part.filename || `page-${pages.length + 1}`).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200), ...cleanUpload(raw)});
                }
            } catch (error) {
                if (error instanceof UploadError) throw new HttpError(400, error.code, error.message);
                if (error.code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, 'file_too_large', 'Each page must be 5 MB or less.');
                if (error.code === 'FST_FILES_LIMIT') throw new HttpError(413, 'too_many_pages', `At most ${LIMITS.pagesPerUpload} pages at once.`);
                throw error;
            }
            if (!pages.length) throw new HttpError(400, 'no_file', 'Choose a photo or PDF to upload.');
            const category = fields.category in CATEGORIES ? fields.category : null;
            if (!category) throw new HttpError(400, 'invalid_category', 'Choose what kind of document this is.');
            const title = fields.title || '';
            if (title.length < 2 || title.length > 120) throw new HttpError(400, 'invalid_title', 'Give the document a short name.');
            const documentDate = fields.document_date || null;
            if (documentDate && (!validDate(documentDate) || documentDate > today())) throw new HttpError(400, 'invalid_date', 'Enter a valid date.');

            const bytes = pages.reduce((sum, page) => sum + page.buffer.length, 0);
            const {rows: [usage]} = await app.pg.query(
                `SELECT (SELECT count(*)::int FROM clinical_documents WHERE patient_id = $1 AND deleted_at IS NULL) AS documents,
                        (SELECT COALESCE(sum(f.size_bytes), 0)::bigint FROM clinical_document_files f JOIN clinical_documents d ON d.id = f.document_id
                          WHERE d.patient_id = $1) AS bytes,
                        (SELECT count(*)::int FROM clinical_document_files f JOIN clinical_documents d ON d.id = f.document_id
                          WHERE d.patient_id = $1 AND f.created_at > now() - interval '1 day') AS pages_today`, [p.id]);
            if (usage.documents >= LIMITS.documentsPerProfile) throw new HttpError(409, 'too_many_documents', `At most ${LIMITS.documentsPerProfile} entries per profile.`);
            if (Number(usage.bytes) + bytes > LIMITS.bytesPerProfile) throw new HttpError(409, 'storage_full', 'This profile has no space left (200 MB). Delete older entries first.');
            if (usage.pages_today + pages.length > LIMITS.pagesPerDay) throw new HttpError(429, 'too_many_pages_today', `At most ${LIMITS.pagesPerDay} pages a day. Please continue tomorrow.`);

            const stored = [];
            try {
                for (const page of pages) stored.push({...page, ...await app.documents.save(page.buffer)});
                const doc = await transaction(app.pg, async db => {
                    const {rows: [d]} = await db.query(
                        `INSERT INTO clinical_documents (patient_id, source, category, title, document_date, created_by)
                         VALUES ($1, 'upload', $2, $3, $4, $5) RETURNING *`, [p.id, category, title, documentDate, request.user.id]);
                    for (const [i, s] of stored.entries()) {
                        await db.query(
                            `INSERT INTO clinical_document_files (document_id, page, filename, mime, size_bytes, sha256, storage_key, iv, auth_tag)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                            [d.id, i + 1, s.filename, s.mime, s.buffer.length, s.sha256, s.storageKey, s.iv, s.authTag]);
                    }
                    return d;
                });
                await withAudit(request, 'health_document.uploaded', doc.id, p.id, {pages: pages.length, size: bytes});
                reply.code(201);
                return {item: itemView({...doc, pages: pages.length, size_bytes: bytes})};
            } catch (error) {
                await Promise.all(stored.map(s => app.documents.remove(s.storageKey)));
                throw error;
            }
        });

    // Opens one page. Taken-over lab results have one page: the lab's own file. Every opening is recorded.
    app.get('/api/file/documents/:id/pages/:page', {preHandler: patientOnly, schema: {params: {type: 'object', properties: {
        id: UUID, page: {type: 'integer', minimum: 1, maximum: 30}
    }}}}, async (request, reply) => {
        const d = await documentFor(request, request.params.id, {includeDeleted: true});
        let file;
        if (d.lab_result_id) {
            if (request.params.page !== 1) throw notFound();
            ({rows: [file]} = await app.pg.query('SELECT * FROM lab_results WHERE id = $1', [d.lab_result_id]));
        } else {
            ({rows: [file]} = await app.pg.query('SELECT * FROM clinical_document_files WHERE document_id = $1 AND page = $2', [d.id, request.params.page]));
        }
        if (!file) throw notFound();
        const content = await app.documents.open(file);
        await withAudit(request, 'health_document.viewed', d.id, d.patient_id, {page: request.params.page});
        return sendFileSandboxed(reply, file, content);
    });

    // Delete moves an entry to the bin for 30 days; restore brings it back. src/jobs.js removes it for good afterwards.
    app.post('/api/file/documents/:id/delete', {preHandler: patientOnly, schema: idParam}, async request => {
        const d = await documentFor(request, request.params.id);
        await app.pg.query('UPDATE clinical_documents SET deleted_at = now(), updated_at = now() WHERE id = $1', [d.id]);
        await withAudit(request, 'health_document.deleted', d.id, d.patient_id);
        return {deleted: true, restore_days: LIMITS.binDays};
    });
    app.post('/api/file/documents/:id/restore', {preHandler: patientOnly, schema: idParam}, async request => {
        const d = await documentFor(request, request.params.id, {includeDeleted: true});
        if (!d.deleted_at || Date.now() - new Date(d.deleted_at).getTime() > LIMITS.binDays * 86400_000) throw notFound();
        await app.pg.query('UPDATE clinical_documents SET deleted_at = NULL, updated_at = now() WHERE id = $1', [d.id]);
        await withAudit(request, 'health_document.restored', d.id, d.patient_id);
        return {restored: true};
    });

    // ---- Taking a lab result over from the printed slip ----

    const claimBody = {type: 'object', required: ['code', 'check'], additionalProperties: false, properties: {
        code: {type: 'string', maxLength: 40}, check: {type: 'string', maxLength: 10}
    }};
    const claimLimit = {rateLimit: {max: 20, timeWindow: '15 minutes'}};

    // The second detail: the birth year the lab entered, or the last 3 digits of the mobile number the lab entered.
    const checkMatches = (result, check) => {
        const digits = String(check).replace(/\D/g, '');
        if (digits.length === 4 && result.birth_year) return Number(digits) === result.birth_year;
        if (digits.length === 3) return result.patient_phone.endsWith(digits);
        return false;
    };

    async function claimableResult(code) {
        const clean = cleanResultCode(code);
        const {rows: [result]} = clean ? await app.pg.query(
            `SELECT r.*, p.facility_name AS lab_name, p.kind AS lab_kind FROM lab_results r JOIN facility_profiles p ON p.user_id = r.facility_id
             WHERE r.code_hash = $1 AND r.code_expires_at > now()`, [resultCodeHash(app.config.otpSecret, clean)]) : {rows: []};
        // Old slips (without the health-file text) cannot be taken over: the patient was never told about it.
        if (!result || result.slip_version < 2) throw new HttpError(404, 'code_invalid', 'This code is not valid for your health file. Check it, or ask the lab for a new slip.');
        return result;
    }

    app.post('/api/file/profiles/:id/claim', {preHandler: patientOnly, config: claimLimit, schema: {...idParam, body: claimBody}}, async (request, reply) => {
        const p = await patientFor(app.pg, request.user, request.params.id);
        if (!await hasConsent(app.pg, p.id)) throw new HttpError(403, 'consent_required', 'Please agree to keeping a health file first.');
        const result = await claimableResult(request.body.code);
        const {rows: [taken]} = await app.pg.query('SELECT patient_id FROM clinical_documents WHERE lab_result_id = $1', [result.id]);
        if (taken) {
            if (taken.patient_id === p.id) return {item: itemView({...(await app.pg.query('SELECT * FROM health_file_items WHERE lab_result_id = $1', [result.id])).rows[0]})};
            throw new HttpError(409, 'already_claimed', 'This result is already in another health file. If it is yours, you can report it.');
        }
        if (result.claim_attempts >= LIMITS.claimAttempts) throw new HttpError(423, 'claim_locked', 'Too many wrong tries. Ask the lab for a new slip.');
        if (!checkMatches(result, request.body.check)) {
            const {rows: [{claim_attempts: attempts}]} = await app.pg.query(
                'UPDATE lab_results SET claim_attempts = claim_attempts + 1 WHERE id = $1 RETURNING claim_attempts', [result.id]);
            await withAudit(request, 'result.claim_failed', result.id, p.id, {attempts});
            throw new HttpError(400, 'wrong_check', attempts >= LIMITS.claimAttempts ? 'Too many wrong tries. Ask the lab for a new slip.'
                : 'The birth year or the last 3 digits do not match what the lab entered.');
        }
        const doc = await transaction(app.pg, async db => {
            const {rows: [d]} = await db.query(
                `INSERT INTO clinical_documents (patient_id, source, lab_result_id, category, title, document_date, created_by)
                 VALUES ($1, 'lab_result', $2, $3, $4, ($5 AT TIME ZONE 'Asia/Damascus')::date, $6)
                 ON CONFLICT (lab_result_id) DO NOTHING RETURNING *`,
                [p.id, result.id, result.lab_kind === 'imaging' ? 'imaging' : 'lab', result.title, result.created_at, request.user.id]);
            if (!d) throw new HttpError(409, 'already_claimed', 'This result is already in another health file. If it is yours, you can report it.');
            return d;
        });
        await withAudit(request, 'result.claimed', result.id, p.id);
        reply.code(201);
        return {item: itemView({...doc, pages: 1, size_bytes: result.size_bytes, lab_name: result.lab_name})};
    });

    // "This result is mine, but someone else took it": recorded and sent to the administrators, who contact the lab.
    // The patient learns nothing about the other file.
    app.post('/api/file/claim/report', {preHandler: patientOnly, config: claimLimit, schema: {body: {type: 'object', required: ['code'], additionalProperties: false,
        properties: {code: {type: 'string', maxLength: 40}, note: {type: 'string', maxLength: 500}}}}}, async request => {
        const result = await claimableResult(request.body.code);
        await app.pg.query('UPDATE lab_results SET claim_reported_at = now() WHERE id = $1', [result.id]);
        await audit(app.pg, {actorId: request.user.id, action: 'result.claim_reported', targetId: result.id, details: {note: request.body.note || ''}, ip: request.ip});
        const {rows: admins} = await app.pg.query("SELECT email FROM users WHERE role = 'admin' AND disabled_at IS NULL AND email IS NOT NULL");
        for (const admin of admins) {
            await sendEmail(app, admin.email, {
                subject: 'SyriaHC: a patient reports a lab result taken by someone else',
                text: `A patient reports that a lab result from ${result.lab_name} (uploaded ${new Date(result.created_at).toISOString().slice(0, 10)}) ` +
                    `is in another person's health file. Result id: ${result.id}. Please check with the lab.\n\nNote from the patient: ${request.body.note || '—'}`
            });
        }
        return {reported: true};
    });
}

// Files from patients are shown in a sandbox: no scripts, no forms, no access to the platform's pages or cookies.
// Browsers do not display PDFs inside a sandbox, so PDFs are downloaded and open in the phone's own PDF app.
export function sendFileSandboxed(reply, file, content) {
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    const result = sendDocument(reply, file, content);
    if (file.mime === 'application/pdf') reply.header('Content-Disposition', String(reply.getHeader('Content-Disposition')).replace(/^inline/, 'attachment'));
    return result;
}
