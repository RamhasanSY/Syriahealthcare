// Doctor profiles and documents (doctor side), and the review workflow (admin side).
import multipart from '@fastify/multipart';
import {HttpError, requireRole} from './auth.js';
import {facilityKinds, facilityServices, governorates, specialties} from './catalog.js';
import {audit, transaction} from './db.js';
import {MAX_DOCUMENT_BYTES, sniffType} from './documents.js';
import {normalizePhone} from './security.js';

const MAX_DOCUMENTS = 6;
const TEXT_FIELDS = {area: 120, clinic_name: 160, clinic_address: 300, licence_number: 60, bio: 600};
const REQUIRED = ['specialty', 'governorate', 'area', 'clinic_name', 'clinic_address', 'clinic_phone', 'licence_number'];
const EDITABLE = new Set(['draft', 'pending', 'rejected', 'approved']);

const profileView = p => ({
    status: p.status, specialty: p.specialty, governorate: p.governorate, area: p.area, clinic_name: p.clinic_name,
    clinic_address: p.clinic_address, clinic_phone: p.clinic_phone, licence_number: p.licence_number, bio: p.bio,
    submitted_at: p.submitted_at, reviewed_at: p.reviewed_at, review_note: p.review_note, updated_at: p.updated_at
});
export const documentView = d => ({id: d.id, kind: d.kind, filename: d.filename, mime: d.mime, size_bytes: d.size_bytes, uploaded_at: d.uploaded_at});

// Checks and cleans the fields a doctor sends. Empty strings clear a field.
function cleanProfile(body) {
    const out = {};
    for (const [key, max] of Object.entries(TEXT_FIELDS)) {
        if (!(key in body)) continue;
        const value = String(body[key] ?? '').trim();
        if (value.length > max) throw new HttpError(400, 'too_long', `${key} is too long.`);
        out[key] = value || null;
    }
    if ('specialty' in body) {
        if (body.specialty && !specialties[body.specialty]) throw new HttpError(400, 'invalid_specialty', 'Choose a specialty from the list.');
        out.specialty = body.specialty || null;
    }
    if ('governorate' in body) {
        if (body.governorate && !governorates[body.governorate]) throw new HttpError(400, 'invalid_governorate', 'Choose a governorate from the list.');
        out.governorate = body.governorate || null;
    }
    if ('clinic_phone' in body) {
        const phone = body.clinic_phone ? normalizePhone(body.clinic_phone, {landline: true}) : null;
        if (body.clinic_phone && !phone) throw new HttpError(400, 'invalid_phone', 'Enter a valid clinic phone number.');
        out.clinic_phone = phone;
    }
    return out;
}

async function loadProfile(db, userId, lock = false) {
    const {rows: [profile]} = await db.query(`SELECT * FROM doctor_profiles WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [userId]);
    if (!profile) throw new HttpError(404, 'not_found', 'Doctor profile not found.');
    return profile;
}

export const listDocuments = async (db, doctorId) =>
    (await db.query('SELECT * FROM doctor_documents WHERE doctor_id = $1 ORDER BY uploaded_at', [doctorId])).rows;

// Stores one uploaded file for the signed-in account (doctor or facility). The caller checks the profile status first.
export async function saveUpload(app, request, kinds) {
    if ((await listDocuments(app.pg, request.user.id)).length >= MAX_DOCUMENTS) throw new HttpError(400, 'too_many_documents', `You can upload up to ${MAX_DOCUMENTS} documents.`);
    const part = await request.file().catch(() => null);
    if (!part) throw new HttpError(400, 'no_file', 'Choose a file to upload.');
    const kind = part.fields.kind?.value;
    if (!kinds.includes(kind)) throw new HttpError(400, 'invalid_kind', 'Choose the document type.');
    const buffer = await part.toBuffer().catch(error => {
        if (error.code === 'FST_REQ_FILE_TOO_LARGE') throw new HttpError(413, 'file_too_large', 'The file is larger than 5 MB.');
        throw error;
    });
    const mime = sniffType(buffer);
    if (!mime) throw new HttpError(400, 'invalid_file_type', 'Upload a PDF, JPG or PNG file.');
    const stored = await app.documents.save(buffer);
    const filename = String(part.filename || 'document').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200);
    try {
        const {rows: [doc]} = await app.pg.query(
            `INSERT INTO doctor_documents (doctor_id, kind, filename, mime, size_bytes, sha256, storage_key, iv, auth_tag)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [request.user.id, kind, filename, mime, buffer.length, stored.sha256, stored.storageKey, stored.iv, stored.authTag]);
        await audit(app.pg, {actorId: request.user.id, action: 'document.uploaded', targetId: doc.id, details: {kind, size: buffer.length}, ip: request.ip});
        return documentView(doc);
    } catch (error) {
        await app.documents.remove(stored.storageKey);
        throw error;
    }
}

export async function deleteDocument(app, request) {
    const {rows: [doc]} = await app.pg.query('DELETE FROM doctor_documents WHERE id = $1 AND doctor_id = $2 RETURNING *', [request.params.id, request.user.id]);
    if (!doc) throw new HttpError(404, 'not_found', 'Document not found.');
    await app.documents.remove(doc.storage_key);
    await audit(app.pg, {actorId: request.user.id, action: 'document.deleted', targetId: doc.id, ip: request.ip});
    return {deleted: true};
}

export default async function doctorRoutes(app) {
    await app.register(multipart, {limits: {fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 2, fieldSize: 100}});
    const doctorOnly = {preHandler: requireRole('doctor')};
    const adminOnly = {preHandler: requireRole('admin')};

    app.get('/api/catalog', async () => ({specialties, governorates, facilityKinds, facilityServices}));

    // ---- Doctor side ----

    app.get('/api/doctor/profile', doctorOnly, async request => {
        const profile = await loadProfile(app.pg, request.user.id);
        return {profile: profileView(profile), documents: (await listDocuments(app.pg, request.user.id)).map(documentView)};
    });

    app.post('/api/doctor/profile', {...doctorOnly, schema: {body: {type: 'object', additionalProperties: false, properties: {
        specialty: {type: 'string', maxLength: 40}, governorate: {type: 'string', maxLength: 40}, area: {type: 'string'},
        clinic_name: {type: 'string'}, clinic_address: {type: 'string'}, clinic_phone: {type: 'string', maxLength: 30},
        licence_number: {type: 'string'}, bio: {type: 'string'}
    }}}}, async request => {
        const changes = cleanProfile(request.body);
        const profile = await transaction(app.pg, async db => {
            const current = await loadProfile(db, request.user.id, true);
            if (!EDITABLE.has(current.status)) throw new HttpError(403, 'suspended', 'Your profile is suspended. Please contact support.');
            const keys = Object.keys(changes);
            if (!keys.length) return current;
            // Patients only ever see reviewed details: changing an approved profile sends it back for review.
            const backToReview = current.status === 'approved';
            const {rows: [updated]} = await db.query(
                `UPDATE doctor_profiles SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
                 ${backToReview ? ", status = 'pending', submitted_at = now()" : ''}
                 WHERE user_id = $1 RETURNING *`, [request.user.id, ...keys.map(k => changes[k])]);
            if (backToReview) await audit(db, {actorId: request.user.id, action: 'doctor.changed_after_approval', targetId: request.user.id, details: {fields: keys}, ip: request.ip});
            return updated;
        });
        return {profile: profileView(profile)};
    });

    app.post('/api/doctor/documents', doctorOnly, async (request, reply) => {
        const profile = await loadProfile(app.pg, request.user.id);
        if (!['draft', 'pending', 'rejected'].includes(profile.status)) throw new HttpError(403, 'documents_locked', 'Documents can only be changed before approval. Please contact support.');
        reply.code(201);
        return {document: await saveUpload(app, request, ['licence', 'syndicate', 'other'])};
    });

    app.delete('/api/doctor/documents/:id', {...doctorOnly, schema: {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}}}, async request => {
        const profile = await loadProfile(app.pg, request.user.id);
        if (!['draft', 'pending', 'rejected'].includes(profile.status)) throw new HttpError(403, 'documents_locked', 'Documents can only be changed before approval. Please contact support.');
        return deleteDocument(app, request);
    });

    app.post('/api/doctor/submit', doctorOnly, async request => {
        const profile = await transaction(app.pg, async db => {
            const current = await loadProfile(db, request.user.id, true);
            if (!['draft', 'rejected'].includes(current.status)) throw new HttpError(409, 'already_submitted', 'Your profile has already been sent for review.');
            const missing = REQUIRED.filter(k => !current[k]);
            if (missing.length) throw Object.assign(new HttpError(400, 'incomplete', 'Please complete all required fields first.'), {missing});
            const docs = await listDocuments(db, request.user.id);
            if (!docs.some(d => d.kind === 'licence')) throw new HttpError(400, 'licence_required', 'Please upload your medical licence first.');
            const {rows: [updated]} = await db.query(
                "UPDATE doctor_profiles SET status = 'pending', submitted_at = now(), updated_at = now() WHERE user_id = $1 RETURNING *", [request.user.id]);
            await audit(db, {actorId: request.user.id, action: 'doctor.submitted', targetId: request.user.id, ip: request.ip});
            return updated;
        });
        return {profile: profileView(profile)};
    });

    // ---- Admin side ----

    app.get('/api/admin/doctors', {...adminOnly, schema: {querystring: {type: 'object', properties: {
        status: {enum: ['draft', 'pending', 'approved', 'rejected', 'suspended']}
    }}}}, async request => {
        const status = request.query.status || 'pending';
        const {rows} = await app.pg.query(
            `SELECT u.id, u.name, u.email, u.created_at, p.status, p.specialty, p.governorate, p.submitted_at, p.reviewed_at,
                    (SELECT count(*)::int FROM doctor_documents d WHERE d.doctor_id = u.id) AS documents
             FROM users u JOIN doctor_profiles p ON p.user_id = u.id
             WHERE p.status = $1 ORDER BY p.submitted_at NULLS LAST, u.created_at`, [status]);
        const {rows: counts} = await app.pg.query('SELECT status, count(*)::int AS n FROM doctor_profiles GROUP BY status');
        return {doctors: rows, counts: Object.fromEntries(counts.map(c => [c.status, c.n]))};
    });

    app.get('/api/admin/doctors/:id', {...adminOnly, schema: {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}}}, async request => {
        const {rows: [user]} = await app.pg.query("SELECT id, name, email, phone, created_at, disabled_at FROM users WHERE id = $1 AND role = 'doctor'", [request.params.id]);
        if (!user) throw new HttpError(404, 'not_found', 'Doctor not found.');
        const profile = await loadProfile(app.pg, user.id);
        const {rows: history} = await app.pg.query(
            `SELECT a.action, a.details, a.created_at, actor.name AS actor_name FROM audit_log a LEFT JOIN users actor ON actor.id = a.actor_id
             WHERE a.target_id = $1 OR a.target_id IN (SELECT id FROM doctor_documents WHERE doctor_id = $1)
             ORDER BY a.created_at DESC LIMIT 50`, [user.id]);
        return {doctor: user, profile: profileView(profile), documents: (await listDocuments(app.pg, user.id)).map(documentView), history};
    });

    // Opens a document for review. Every view is recorded.
    app.get('/api/admin/documents/:id', {...adminOnly, schema: {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}}}, async (request, reply) => {
        const {rows: [doc]} = await app.pg.query('SELECT * FROM doctor_documents WHERE id = $1', [request.params.id]);
        if (!doc) throw new HttpError(404, 'not_found', 'Document not found.');
        const content = await app.documents.open(doc);
        await audit(app.pg, {actorId: request.user.id, action: 'document.viewed', targetId: doc.id, ip: request.ip});
        const ascii = doc.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        reply.header('Content-Type', doc.mime);
        reply.header('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
        reply.header('Cache-Control', 'no-store');
        return content;
    });

    const decide = (action, from, to, needsNote) => async request => {
        const note = String(request.body?.note || '').trim();
        if (needsNote && note.length < 3) throw new HttpError(400, 'note_required', 'Please write a short reason for the doctor.');
        if (note.length > 1000) throw new HttpError(400, 'too_long', 'The note is too long.');
        const profile = await transaction(app.pg, async db => {
            const current = await loadProfile(db, request.params.id, true);
            if (!from.includes(current.status)) throw new HttpError(409, 'wrong_status', `This doctor is ${current.status}; you cannot ${action} now.`);
            const {rows: [updated]} = await db.query(
                `UPDATE doctor_profiles SET status = $2, reviewed_at = now(), reviewed_by = $3, review_note = $4, updated_at = now()
                 WHERE user_id = $1 RETURNING *`, [request.params.id, to, request.user.id, note || null]);
            await audit(db, {actorId: request.user.id, action: `doctor.${to}`, targetId: request.params.id, details: note ? {note} : {}, ip: request.ip});
            return updated;
        });
        return {profile: profileView(profile)};
    };
    const decisionSchema = {...adminOnly, schema: {
        params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}},
        body: {type: 'object', properties: {note: {type: 'string', maxLength: 1000}}}
    }};
    app.post('/api/admin/doctors/:id/approve', decisionSchema, decide('approve', ['pending', 'suspended'], 'approved', false));
    app.post('/api/admin/doctors/:id/reject', decisionSchema, decide('reject', ['pending'], 'rejected', true));
    app.post('/api/admin/doctors/:id/suspend', decisionSchema, decide('suspend', ['approved'], 'suspended', true));
}
