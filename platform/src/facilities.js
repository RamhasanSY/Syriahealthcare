// Labs, imaging centres, hospitals and clinics: profile and documents (facility side), review (admin side),
// and the public list of approved facilities that the website copies to its Labs and Hospitals pages.
import multipart from '@fastify/multipart';
import {HttpError, requireRole} from './auth.js';
import {facilityKinds, facilityServices, governorates} from './catalog.js';
import {audit, transaction} from './db.js';
import {deleteDocument, documentView, listDocuments, saveUpload} from './doctors.js';
import {MAX_DOCUMENT_BYTES} from './documents.js';
import {normalizePhone} from './security.js';

const TEXT_FIELDS = {facility_name: 160, area: 120, address: 300, licence_number: 60, opening_hours: 200, description: 600};
const REQUIRED = ['facility_name', 'governorate', 'area', 'address', 'phone', 'licence_number'];
const EDITABLE = new Set(['draft', 'pending', 'rejected', 'approved']);
const DOCS_OPEN = ['draft', 'pending', 'rejected'];
const DOCUMENT_KINDS = ['licence', 'other'];
const APPROVED = "p.status = 'approved' AND u.disabled_at IS NULL";
// Public details only: never the contact person, email, licence number or documents.
const PUBLIC_FACILITY = `u.id, p.kind, p.facility_name, p.governorate, p.area, p.address, p.phone, p.services, p.emergency,
    p.opening_hours, p.description, p.reviewed_at`;

const profileView = p => ({
    kind: p.kind, status: p.status, facility_name: p.facility_name, governorate: p.governorate, area: p.area, address: p.address,
    phone: p.phone, licence_number: p.licence_number, services: p.services, emergency: p.emergency, opening_hours: p.opening_hours,
    description: p.description, submitted_at: p.submitted_at, reviewed_at: p.reviewed_at, review_note: p.review_note, updated_at: p.updated_at
});

// Checks and cleans the fields a facility sends. Empty strings clear a field.
function cleanProfile(body, kind) {
    const out = {};
    for (const [key, max] of Object.entries(TEXT_FIELDS)) {
        if (!(key in body)) continue;
        const value = String(body[key] ?? '').trim();
        if (value.length > max) throw new HttpError(400, 'too_long', `${key} is too long.`);
        out[key] = value || null;
    }
    if ('governorate' in body) {
        if (body.governorate && !governorates[body.governorate]) throw new HttpError(400, 'invalid_governorate', 'Choose a governorate from the list.');
        out.governorate = body.governorate || null;
    }
    if ('phone' in body) {
        const phone = body.phone ? normalizePhone(body.phone, {landline: true}) : null;
        if (body.phone && !phone) throw new HttpError(400, 'invalid_phone', 'Enter a valid phone number.');
        out.phone = phone;
    }
    if ('services' in body) {
        const allowed = facilityServices[kind];
        if (body.services.some(s => !allowed[s])) throw new HttpError(400, 'invalid_service', 'Choose services from the list.');
        out.services = [...new Set(body.services)];
    }
    if ('emergency' in body) out.emergency = body.emergency === true && ['hospital', 'clinic'].includes(kind);
    return out;
}

async function loadProfile(db, userId, lock = false) {
    const {rows: [profile]} = await db.query(`SELECT * FROM facility_profiles WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [userId]);
    if (!profile) throw new HttpError(404, 'not_found', 'Facility not found.');
    return profile;
}

export default async function facilityRoutes(app) {
    await app.register(multipart, {limits: {fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 2, fieldSize: 100}});
    const facilityOnly = {preHandler: requireRole('facility')};
    const adminOnly = {preHandler: requireRole('admin')};
    const uuidParam = {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}};

    // ---- Public ----

    app.get('/api/facilities', {schema: {querystring: {type: 'object', properties: {
        kind: {enum: Object.keys(facilityKinds)}, governorate: {type: 'string', maxLength: 40}
    }}}}, async request => {
        const {kind, governorate} = request.query;
        const where = [APPROVED], args = [];
        if (kind) where.push(`p.kind = $${args.push(kind)}`);
        if (governorate && governorates[governorate]) where.push(`p.governorate = $${args.push(governorate)}`);
        const {rows} = await app.pg.query(
            `SELECT ${PUBLIC_FACILITY} FROM users u JOIN facility_profiles p ON p.user_id = u.id
             WHERE ${where.join(' AND ')} ORDER BY p.facility_name LIMIT 1000`, args);
        return {facilities: rows};
    });

    // ---- Facility side ----

    app.get('/api/facility/profile', facilityOnly, async request => {
        const profile = await loadProfile(app.pg, request.user.id);
        return {profile: profileView(profile), documents: (await listDocuments(app.pg, request.user.id)).map(documentView)};
    });

    app.post('/api/facility/profile', {...facilityOnly, schema: {body: {type: 'object', additionalProperties: false, properties: {
        facility_name: {type: 'string'}, governorate: {type: 'string', maxLength: 40}, area: {type: 'string'}, address: {type: 'string'},
        phone: {type: 'string', maxLength: 30}, licence_number: {type: 'string'}, opening_hours: {type: 'string'}, description: {type: 'string'},
        services: {type: 'array', maxItems: 30, items: {type: 'string', maxLength: 40}}, emergency: {type: 'boolean'}
    }}}}, async request => {
        const profile = await transaction(app.pg, async db => {
            const current = await loadProfile(db, request.user.id, true);
            if (!EDITABLE.has(current.status)) throw new HttpError(403, 'suspended', 'Your profile is suspended. Please contact support.');
            const changes = cleanProfile(request.body, current.kind);
            const keys = Object.keys(changes);
            if (!keys.length) return current;
            // The public only ever sees reviewed details: changing an approved profile sends it back for review.
            const backToReview = current.status === 'approved';
            const {rows: [updated]} = await db.query(
                `UPDATE facility_profiles SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
                 ${backToReview ? ", status = 'pending', submitted_at = now()" : ''}
                 WHERE user_id = $1 RETURNING *`, [request.user.id, ...keys.map(k => changes[k])]);
            if (backToReview) await audit(db, {actorId: request.user.id, action: 'facility.changed_after_approval', targetId: request.user.id, details: {fields: keys}, ip: request.ip});
            return updated;
        });
        return {profile: profileView(profile)};
    });

    app.post('/api/facility/documents', facilityOnly, async (request, reply) => {
        const profile = await loadProfile(app.pg, request.user.id);
        if (!DOCS_OPEN.includes(profile.status)) throw new HttpError(403, 'documents_locked', 'Documents can only be changed before approval. Please contact support.');
        reply.code(201);
        return {document: await saveUpload(app, request, DOCUMENT_KINDS)};
    });

    app.delete('/api/facility/documents/:id', {...facilityOnly, schema: uuidParam}, async request => {
        const profile = await loadProfile(app.pg, request.user.id);
        if (!DOCS_OPEN.includes(profile.status)) throw new HttpError(403, 'documents_locked', 'Documents can only be changed before approval. Please contact support.');
        return deleteDocument(app, request);
    });

    app.post('/api/facility/submit', facilityOnly, async request => {
        const profile = await transaction(app.pg, async db => {
            const current = await loadProfile(db, request.user.id, true);
            if (!['draft', 'rejected'].includes(current.status)) throw new HttpError(409, 'already_submitted', 'Your profile has already been sent for review.');
            const missing = REQUIRED.filter(k => !current[k]);
            if (missing.length) throw Object.assign(new HttpError(400, 'incomplete', 'Please complete all required fields first.'), {missing});
            const docs = await listDocuments(db, request.user.id);
            if (!docs.some(d => d.kind === 'licence')) throw new HttpError(400, 'facility_licence_required', 'Please upload your operating licence first.');
            const {rows: [updated]} = await db.query(
                "UPDATE facility_profiles SET status = 'pending', submitted_at = now(), updated_at = now() WHERE user_id = $1 RETURNING *", [request.user.id]);
            await audit(db, {actorId: request.user.id, action: 'facility.submitted', targetId: request.user.id, ip: request.ip});
            return updated;
        });
        return {profile: profileView(profile)};
    });

    // ---- Admin side ----

    app.get('/api/admin/facilities', {...adminOnly, schema: {querystring: {type: 'object', properties: {
        status: {enum: ['draft', 'pending', 'approved', 'rejected', 'suspended']}
    }}}}, async request => {
        const status = request.query.status || 'pending';
        const {rows} = await app.pg.query(
            `SELECT u.id, u.name, u.email, u.created_at, p.kind, p.facility_name, p.status, p.governorate, p.submitted_at, p.reviewed_at,
                    (SELECT count(*)::int FROM doctor_documents d WHERE d.doctor_id = u.id) AS documents
             FROM users u JOIN facility_profiles p ON p.user_id = u.id
             WHERE p.status = $1 ORDER BY p.submitted_at NULLS LAST, u.created_at`, [status]);
        const {rows: counts} = await app.pg.query('SELECT status, count(*)::int AS n FROM facility_profiles GROUP BY status');
        return {facilities: rows, counts: Object.fromEntries(counts.map(c => [c.status, c.n]))};
    });

    app.get('/api/admin/facilities/:id', {...adminOnly, schema: uuidParam}, async request => {
        const {rows: [user]} = await app.pg.query("SELECT id, name, email, phone, created_at, disabled_at FROM users WHERE id = $1 AND role = 'facility'", [request.params.id]);
        if (!user) throw new HttpError(404, 'not_found', 'Facility not found.');
        const profile = await loadProfile(app.pg, user.id);
        const {rows: history} = await app.pg.query(
            `SELECT a.action, a.details, a.created_at, actor.name AS actor_name FROM audit_log a LEFT JOIN users actor ON actor.id = a.actor_id
             WHERE a.target_id = $1 OR a.target_id IN (SELECT id FROM doctor_documents WHERE doctor_id = $1)
             ORDER BY a.created_at DESC LIMIT 50`, [user.id]);
        return {facility: user, profile: profileView(profile), documents: (await listDocuments(app.pg, user.id)).map(documentView), history};
    });

    const decide = (action, from, to, needsNote) => async request => {
        const note = String(request.body?.note || '').trim();
        if (needsNote && note.length < 3) throw new HttpError(400, 'note_required', 'Please write a short reason for the facility.');
        if (note.length > 1000) throw new HttpError(400, 'too_long', 'The note is too long.');
        const profile = await transaction(app.pg, async db => {
            const current = await loadProfile(db, request.params.id, true);
            if (!from.includes(current.status)) throw new HttpError(409, 'wrong_status', `This facility is ${current.status}; you cannot ${action} now.`);
            const {rows: [updated]} = await db.query(
                `UPDATE facility_profiles SET status = $2, reviewed_at = now(), reviewed_by = $3, review_note = $4, updated_at = now()
                 WHERE user_id = $1 RETURNING *`, [request.params.id, to, request.user.id, note || null]);
            await audit(db, {actorId: request.user.id, action: `facility.${to}`, targetId: request.params.id, details: note ? {note} : {}, ip: request.ip});
            return updated;
        });
        return {profile: profileView(profile)};
    };
    const decisionSchema = {...adminOnly, schema: {...uuidParam, body: {type: 'object', properties: {note: {type: 'string', maxLength: 1000}}}}};
    app.post('/api/admin/facilities/:id/approve', decisionSchema, decide('approve', ['pending', 'suspended'], 'approved', false));
    app.post('/api/admin/facilities/:id/reject', decisionSchema, decide('reject', ['pending'], 'rejected', true));
    app.post('/api/admin/facilities/:id/suspend', decisionSchema, decide('suspend', ['approved'], 'suspended', true));
}
