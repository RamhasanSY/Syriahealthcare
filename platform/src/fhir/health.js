// HL7 FHIR R4 for the health file (stage 2b): a signed-in patient reads their own profiles and entries.
// Patient, RelatedPerson (children's profiles), DocumentReference and Binary (IHE MHD ITI-67 and ITI-68),
// DiagnosticReport (lab results taken over from a slip), Consent, Appointment and Patient/$everything (IPS-style).
// Read only, over the browser session, through src/access.js. There is no patient search: Patient is read by id only.
// Outside a relationship the answer is 404. Every read of clinical content is recorded with the patient.
import {CATEGORIES, sendFileSandboxed} from '../healthfile.js';
import {patientFor, sharedDocumentIds} from '../access.js';
import {auditEvent} from './audit.js';
import {observationResources} from '../lab-values.js';
import {audit} from '../db.js';
import {PATIENT_NUMBER_SYSTEM} from '../patient-number.js';
import {prune} from './map.js';
import {documentSources} from '../catalog.js';
import {codeSystemUrl, coding} from './terminology.js';
import {HEALTH_RESOURCES} from './registry.js';

const LOINC = 'http://loinc.org';
const V2_0074 = 'http://terminology.hl7.org/CodeSystem/v2-0074';
const V3_ROLE = 'http://terminology.hl7.org/CodeSystem/v3-RoleCode';
const CONSENT_SCOPE = 'http://terminology.hl7.org/CodeSystem/consentscope';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const instant = value => new Date(value).toISOString();

// ---- Mapping ----

export const patientResource = p => prune({
    resourceType: 'Patient', id: p.id, meta: {lastUpdated: instant(p.updated_at)},
    identifier: [{use: 'official', system: PATIENT_NUMBER_SYSTEM, value: p.patient_number}],
    active: true, name: [{text: p.name}], gender: p.sex || 'unknown', birthDate: p.birth_date || undefined
});

// The parent's login as RelatedPerson of a child's profile (one parent per child in this version).
export const relatedPerson = (child, parent) => prune({
    resourceType: 'RelatedPerson', id: child.id, meta: {lastUpdated: instant(child.updated_at)}, active: true,
    patient: {reference: `Patient/${child.id}`},
    relationship: [{coding: [{system: V3_ROLE, code: 'PRN', display: 'parent'}]}],
    name: [{text: parent.name}]
});

const typeConcept = category => {
    const c = CATEGORIES[category];
    return {
        coding: [...(c.loinc ? [{system: LOINC, code: c.loinc[0], display: c.loinc[1]}] : []),
            {system: codeSystemUrl('document-category'), code: category, display: c.label[0]}],
        text: c.label[0]
    };
};

// One entry of the file. Each page is an attachment that points to its Binary.
export function documentReference(base, d, files) {
    return prune({
        resourceType: 'DocumentReference', id: d.id, meta: {lastUpdated: instant(d.updated_at)},
        status: 'current', type: typeConcept(d.category),
        category: [{coding: [coding('document-source', d.source === 'lab_result' ? 'lab-slip' : 'patient-upload',
            documentSources[d.source === 'lab_result' ? 'lab-slip' : 'patient-upload'])]}],
        subject: {reference: `Patient/${d.patient_id}`}, date: instant(d.created_at), description: d.title,
        author: d.source === 'lab_result' && d.facility_id ? [{reference: `Organization/${d.facility_id}`, display: d.lab_name}] : [{reference: `Patient/${d.patient_id}`}],
        content: files.map(f => ({attachment: {contentType: f.mime, url: `${base}/Binary/${f.id}`, size: f.size_bytes, title: f.filename,
            creation: d.document_date || undefined}})),
        context: d.document_date ? {period: {start: d.document_date}} : undefined
    });
}

// A lab result taken over from a slip, as DiagnosticReport with the lab's file as presented form.
export function diagnosticReport(base, d, result) {
    const imaging = d.category === 'imaging';
    const observations = observationResources(result.observations, {subject: {reference: `Patient/${d.patient_id}`}, effective: instant(result.created_at)});
    return prune({
        resourceType: 'DiagnosticReport', id: d.id, meta: {lastUpdated: instant(d.updated_at)}, status: 'final',
        category: [{coding: [{system: V2_0074, code: imaging ? 'RAD' : 'LAB', display: imaging ? 'Radiology' : 'Laboratory'}]}],
        code: {text: d.title}, subject: {reference: `Patient/${d.patient_id}`},
        effectiveDateTime: instant(result.created_at), issued: instant(result.created_at),
        performer: [{reference: `Organization/${result.facility_id}`, display: d.lab_name}],
        contained: observations.length ? observations : undefined,
        result: observations.length ? observations.map(o => ({reference: `#${o.id}`})) : undefined,
        presentedForm: [{contentType: result.mime, url: `${base}/Binary/${result.id}`, size: result.size_bytes, title: result.filename}]
    });
}

export const consentResource = (origin, c) => prune({
    resourceType: 'Consent', id: c.id, meta: {lastUpdated: instant(c.withdrawn_at || c.given_at)},
    status: c.withdrawn_at ? 'inactive' : 'active',
    scope: {coding: [{system: CONSENT_SCOPE, code: 'patient-privacy', display: 'Privacy Consent'}]},
    category: [{coding: [{system: LOINC, code: '59284-0', display: 'Patient Consent'}]}],
    patient: {reference: `Patient/${c.patient_id}`}, dateTime: instant(c.given_at),
    policy: [{uri: `${origin}/privacy#${c.policy_version}`}],
    provision: {type: c.withdrawn_at ? 'deny' : 'permit', period: {start: instant(c.given_at), end: c.withdrawn_at ? instant(c.withdrawn_at) : undefined}}
});

const APPOINTMENT_STATUS = {requested: 'pending', confirmed: 'booked', declined: 'cancelled', cancelled_by_patient: 'cancelled',
    cancelled_by_doctor: 'cancelled', completed: 'fulfilled', no_show: 'noshow'};

export const appointmentResource = a => prune({
    resourceType: 'Appointment', id: a.id, meta: {lastUpdated: instant(a.updated_at)}, status: APPOINTMENT_STATUS[a.status],
    description: a.reason || undefined, start: instant(a.starts_at), end: instant(a.ends_at), created: instant(a.created_at),
    participant: [
        {actor: {reference: `Patient/${a.subject_id}`}, status: 'accepted'},
        {actor: {reference: `Practitioner/${a.doctor_id}`, display: a.doctor_name}, status: a.status === 'requested' ? 'needs-action' : a.status === 'confirmed' || a.status === 'completed' ? 'accepted' : 'declined'}
    ]
});

// A share with a doctor (stage 2c) as Consent: who (provision.actor), which entries (provision.data), how long
// (provision.period), under which policy, with scope and category as R4 requires.
export const shareConsent = (origin, g, items) => prune({
    resourceType: 'Consent', id: g.id, meta: {lastUpdated: instant(g.revoked_at || g.created_at)},
    status: g.revoked_at || new Date(g.expires_at) <= new Date() ? 'inactive' : 'active',
    scope: {coding: [{system: CONSENT_SCOPE, code: 'patient-privacy', display: 'Privacy Consent'}]},
    category: [{coding: [{system: LOINC, code: '59284-0', display: 'Patient Consent'}]}],
    patient: {reference: `Patient/${g.patient_id}`}, dateTime: instant(g.created_at),
    policy: [{uri: `${origin}/privacy#sharing`}],
    provision: {
        type: 'permit', period: {start: instant(g.starts_at), end: instant(g.revoked_at || g.expires_at)},
        actor: [{role: {coding: [{system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType', code: 'IRCP', display: 'information recipient'}]},
            reference: {reference: `Practitioner/${g.doctor_id}`, display: g.doctor_name}}],
        action: [{coding: [{system: 'http://terminology.hl7.org/CodeSystem/consentaction', code: 'access', display: 'Access'}]}],
        data: items.filter(i => !i.revoked_at).map(i => ({meaning: 'instance', reference: {reference: `DocumentReference/${i.document_id}`}}))
    }
});

// ---- Routes (called inside the /fhir/r4 plugin, sharing its error handling) ----

export default function healthFhirRoutes(app, {base, send, outcome}) {
    const signInFirst = reply => send(reply, 401, outcome('login', 'Please sign in.', 'يرجى تسجيل الدخول.'));
    const notFound = (reply, type) => send(reply, 404, outcome('not-found', `${type} not found.`, `لم يُعثر على ${type}.`));
    const unknownParam = (reply, name) => send(reply, 400, outcome('invalid', `Unknown search parameter "${name}".`, `معامل بحث غير معروف: "${name}".`));
    const bundle = (resources, type = 'searchset') => ({
        resourceType: 'Bundle', type, total: resources.length,
        entry: resources.map(r => ({fullUrl: `${base}/${r.resourceType}/${r.id}`, resource: r, search: {mode: 'match'}}))
    });
    const record = (request, action, targetId, patientId, details = {}) =>
        audit(app.pg, {actorId: request.user.id, action, targetId, details: {patient_id: patientId, ...details}, ip: request.ip});

    // Runs the handler for a signed-in patient (own profiles) or, where allowed, for an approved doctor who passed the
    // second factor (shared entries only, stage 2c), while the health file is on; otherwise 401, 403 or 404.
    const route = (handler, {doctors = false} = {}) => async (request, reply) => {
        if (!app.config.healthFile) return notFound(reply, 'Resource');
        if (!request.user) return signInFirst(reply);
        if (request.user.role === 'doctor' && doctors) {
            const {rows: [d]} = await app.pg.query('SELECT status FROM doctor_profiles WHERE user_id = $1', [request.user.id]);
            if (d?.status !== 'approved') return notFound(reply, 'Resource');
            if (!request.user.second_factor_at) {
                return send(reply, 403, outcome('security', 'Please confirm it is you with the code sent to your email first.', 'يرجى تأكيد هويتك أولاً بالرمز المرسل إلى بريدك.'));
            }
            return handler(request, reply);
        }
        if (request.user.role !== 'patient') return notFound(reply, 'Resource');
        return handler(request, reply);
    };
    const patientRoute = handler => route(handler);
    const sharedRoute = handler => route(handler, {doctors: true});
    // The profile a search or read is about, or null (then the route answers 404). For a doctor, `shared` lists the
    // entries of an active share; without one the profile does not exist for them.
    const profile = async (request, ref) => {
        const id = String(ref || '').replace(/^Patient\//, '');
        if (!UUID.test(id)) return null;
        if (request.user.role === 'doctor') {
            const shared = await sharedDocumentIds(app.pg, request.user.id, id);
            if (!shared.length) return null;
            const {rows: [p]} = await app.pg.query('SELECT * FROM patients WHERE id = $1', [id]);
            return p ? {...p, relationship: 'shared', shared} : null;
        }
        try {
            return await patientFor(app.pg, request.user, id);
        } catch (_) {
            return null;
        }
    };
    const badParam = (resource, query) => Object.keys(query).find(k => !(k.split(':')[0] in HEALTH_RESOURCES[resource].search) && k !== '_count') ?? null;

    async function documentsOf(patientId, {category, from, to, id, only} = {}) {
        const where = ['d.patient_id = $1', 'd.deleted_at IS NULL'], args = [patientId];
        if (only) where.push(`d.id = ANY($${args.push(only)})`);
        if (id) where.push(`d.id = $${args.push(id)}`);
        if (category) where.push(`d.category = $${args.push(category)}`);
        if (from) where.push(`COALESCE(d.document_date, d.created_at::date) >= $${args.push(from)}`);
        if (to) where.push(`COALESCE(d.document_date, d.created_at::date) <= $${args.push(to)}`);
        const {rows} = await app.pg.query(
            `SELECT d.*, p.facility_name AS lab_name, r.facility_id FROM clinical_documents d
             LEFT JOIN lab_results r ON r.id = d.lab_result_id LEFT JOIN facility_profiles p ON p.user_id = r.facility_id
             WHERE ${where.join(' AND ')} ORDER BY COALESCE(d.document_date, d.created_at::date) DESC, d.created_at DESC LIMIT 200`, args);
        return rows;
    }
    async function filesOf(d) {
        if (d.lab_result_id) {
            const {rows: [r]} = await app.pg.query('SELECT id, mime, size_bytes, filename, created_at, facility_id, observations FROM lab_results WHERE id = $1', [d.lab_result_id]);
            return r ? [r] : [];
        }
        return (await app.pg.query('SELECT id, mime, size_bytes, filename FROM clinical_document_files WHERE document_id = $1 ORDER BY page', [d.id])).rows;
    }
    const docRefs = async docs => Promise.all(docs.map(async d => documentReference(base, d, await filesOf(d))));
    const reports = async docs => Promise.all(docs.filter(d => d.lab_result_id).map(async d => diagnosticReport(base, d, (await filesOf(d))[0])));

    // Date filter "ge2026-01-01" / "le2026-12-31" (as in IHE MHD), on the document date.
    function dateRange(values) {
        const range = {};
        for (const v of [].concat(values || [])) {
            const m = /^(ge|le|eq)?(\d{4}-\d{2}-\d{2})$/.exec(v);
            if (!m) return null;
            if (m[1] !== 'le') range.from = m[2];
            if (m[1] !== 'ge') range.to = m[2];
        }
        return range;
    }
    const categoryOf = type => {
        if (!type) return undefined;
        const code = String([].concat(type)[0]).split('|').pop();
        return Object.entries(CATEGORIES).find(([key, c]) => key === code || c.loinc?.[0] === code)?.[0] ?? 'none';
    };

    app.get('/Patient/:id', sharedRoute(async (request, reply) => {
        const p = await profile(request, request.params.id);
        return p ? send(reply, 200, patientResource(p)) : notFound(reply, 'Patient');
    }));

    app.get('/RelatedPerson/:id', patientRoute(async (request, reply) => {
        const p = await profile(request, request.params.id);
        if (!p || p.relationship !== 'child') return notFound(reply, 'RelatedPerson');
        return send(reply, 200, relatedPerson(p, request.user));
    }));

    // IHE MHD ITI-67 (Find Document References): patient is required, as the profile says.
    app.get('/DocumentReference', sharedRoute(async (request, reply) => {
        const bad = badParam('DocumentReference', request.query);
        if (bad) return unknownParam(reply, bad);
        const p = await profile(request, request.query.patient);
        if (!p) return send(reply, 200, bundle([]));
        const range = dateRange(request.query.date);
        if (!range) return send(reply, 400, outcome('invalid', 'Use date=geYYYY-MM-DD or leYYYY-MM-DD.', 'استخدم date=geYYYY-MM-DD أو leYYYY-MM-DD.'));
        const docs = await documentsOf(p.id, {category: categoryOf(request.query.type), ...range, only: p.shared});
        await record(request, 'health_file.searched', p.id, p.id, {resource: 'DocumentReference'});
        return send(reply, 200, bundle(await docRefs(docs)));
    }));
    app.get('/DocumentReference/:id', sharedRoute(async (request, reply) => {
        const d = await ownDocument(request, request.params.id);
        if (!d) return notFound(reply, 'DocumentReference');
        await record(request, 'health_document.read', d.id, d.patient_id);
        return send(reply, 200, (await docRefs([d]))[0]);
    }));

    app.get('/DiagnosticReport', sharedRoute(async (request, reply) => {
        const bad = badParam('DiagnosticReport', request.query);
        if (bad) return unknownParam(reply, bad);
        const p = await profile(request, request.query.patient);
        if (!p) return send(reply, 200, bundle([]));
        const docs = (await documentsOf(p.id, {only: p.shared})).filter(d => d.lab_result_id);
        await record(request, 'health_file.searched', p.id, p.id, {resource: 'DiagnosticReport'});
        return send(reply, 200, bundle(await reports(docs)));
    }));
    app.get('/DiagnosticReport/:id', sharedRoute(async (request, reply) => {
        const d = await ownDocument(request, request.params.id);
        if (!d?.lab_result_id) return notFound(reply, 'DiagnosticReport');
        await record(request, 'health_document.read', d.id, d.patient_id);
        return send(reply, 200, (await reports([d]))[0]);
    }));

    // IHE MHD ITI-68 (Retrieve Document): the file itself, in its own type, in a sandbox.
    app.get('/Binary/:id', sharedRoute(async (request, reply) => {
        if (!UUID.test(request.params.id)) return notFound(reply, 'Binary');
        let {rows: [file]} = await app.pg.query(
            `SELECT f.*, d.patient_id, d.id AS document_id FROM clinical_document_files f JOIN clinical_documents d ON d.id = f.document_id
             WHERE f.id = $1 AND d.deleted_at IS NULL`, [request.params.id]);
        if (!file) {
            ({rows: [file]} = await app.pg.query(
                `SELECT r.*, d.patient_id, d.id AS document_id FROM lab_results r JOIN clinical_documents d ON d.lab_result_id = r.id
                 WHERE r.id = $1 AND d.deleted_at IS NULL`, [request.params.id]));
        }
        const holder = file && await profile(request, file.patient_id);
        if (!holder || (holder.shared && !holder.shared.includes(file.document_id))) return notFound(reply, 'Binary');
        const content = await app.documents.open(file);
        await record(request, 'health_document.viewed', file.document_id, file.patient_id, {via: 'fhir'});
        return sendFileSandboxed(reply, file, content);
    }));

    // The consent to keep the file (patients only) and the shares (the patient sees all; a doctor only their own).
    app.get('/Consent', sharedRoute(async (request, reply) => {
        const bad = badParam('Consent', request.query);
        if (bad) return unknownParam(reply, bad);
        const p = await profile(request, request.query.patient);
        if (!p) return send(reply, 200, bundle([]));
        return send(reply, 200, bundle(await consentsOf(request, p)));
    }));

    // "Who opened my file?": the audit trail of a profile as AuditEvent (IHE BALP), for the patient, without network addresses.
    app.get('/AuditEvent', patientRoute(async (request, reply) => {
        const bad = badParam('AuditEvent', request.query);
        if (bad) return unknownParam(reply, bad);
        const p = await profile(request, request.query.patient);
        if (!p) return send(reply, 200, bundle([]));
        const {rows} = await app.pg.query(
            `SELECT a.*, u.role::text AS actor_role, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
             WHERE a.details->>'patient_id' = $1::text ORDER BY a.created_at DESC LIMIT 200`, [p.id]);
        return send(reply, 200, bundle(rows.map(r => auditEvent(r, {withNetwork: false}))));
    }));

    app.get('/Appointment', patientRoute(async (request, reply) => {
        const bad = badParam('Appointment', request.query);
        if (bad) return unknownParam(reply, bad);
        const p = await profile(request, request.query.patient);
        if (!p) return send(reply, 200, bundle([]));
        return send(reply, 200, bundle((await appointmentsOf(p.id)).map(appointmentResource)));
    }));

    // The whole file of one profile, as an IPS-style searchset: the basis for "download my file".
    app.get('/Patient/:id/$everything', patientRoute(async (request, reply) => {
        const p = await profile(request, request.params.id);
        if (!p) return notFound(reply, 'Patient');
        const docs = await documentsOf(p.id);
        const resources = [patientResource(p), ...(p.relationship === 'child' ? [relatedPerson(p, request.user)] : []),
            ...await docRefs(docs), ...await reports(docs), ...await consentsOf(request, p),
            ...(await appointmentsOf(p.id)).map(appointmentResource)];
        await record(request, 'health_file.exported', p.id, p.id);
        return send(reply, 200, bundle(resources));
    }));

    async function ownDocument(request, id) {
        if (!UUID.test(id)) return null;
        const {rows: [d]} = await app.pg.query('SELECT patient_id FROM clinical_documents WHERE id = $1 AND deleted_at IS NULL', [id]);
        const holder = d && await profile(request, d.patient_id);
        if (!holder || (holder.shared && !holder.shared.includes(id))) return null;
        return (await documentsOf(d.patient_id, {id}))[0] ?? null;
    }
    async function consentsOf(request, p) {
        const doctor = request.user.role === 'doctor';
        const {rows: own} = doctor ? {rows: []} : await app.pg.query('SELECT * FROM consents WHERE patient_id = $1 ORDER BY given_at DESC', [p.id]);
        const {rows: grants} = await app.pg.query(
            `SELECT g.*, u.name AS doctor_name, COALESCE(json_agg(json_build_object('document_id', i.document_id, 'revoked_at', i.revoked_at))
                    FILTER (WHERE i.document_id IS NOT NULL), '[]') AS items
             FROM access_grants g JOIN users u ON u.id = g.doctor_id LEFT JOIN access_grant_items i ON i.grant_id = g.id
             WHERE g.patient_id = $1 ${doctor ? 'AND g.doctor_id = $2' : ''} GROUP BY g.id, u.name ORDER BY g.created_at DESC LIMIT 200`,
            doctor ? [p.id, request.user.id] : [p.id]);
        return [...own.map(c => consentResource(app.config.appOrigin, c)), ...grants.map(g => shareConsent(app.config.appOrigin, g, g.items))];
    }
    async function appointmentsOf(patientId) {
        const {rows} = await app.pg.query(
            `SELECT a.*, u.name AS doctor_name FROM appointments a JOIN users u ON u.id = a.doctor_id
             WHERE a.subject_id = $1 ORDER BY a.starts_at DESC LIMIT 200`, [patientId]);
        return rows;
    }
}
