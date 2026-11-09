// HL7 FHIR R4 read and search for the public directory: doctors (IHE mCSD style), facilities, free slots and code systems.
// Only approved, active profiles with public fields. Nothing here identifies a patient: patient search is never offered.
import {facilityKinds, facilityServices, specialties} from '../catalog.js';
import {slotsFor} from '../schedule.js';
import {addDays, localDate} from '../slots.js';
import {
    endpoint, facilityLocation, healthcareService, organization, parseSlotId, practiceLocation, practitioner, practitionerRole, schedule, slot
} from './map.js';
import {capabilityStatement, COMMON_PARAMS, RESOURCES} from './registry.js';
import {codeSystems, namingSystems, valueSets} from './terminology.js';
import healthFhirRoutes from './health.js';
import fhirWriteRoutes from './write.js';

const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_COUNT = 50;

const like = value => '%' + value.replace(/[%_\\]/g, '\\$&') + '%';
// A token may be "code" or "system|code"; only the code matters here.
const tokenCode = value => String(value).split('|').pop();
const count = query => Math.min(Math.max(Number(query._count) || MAX_COUNT, 1), MAX_COUNT);
const first = value => Array.isArray(value) ? value[0] : value;

const outcome = (code, en, ar, severity = 'error') => ({
    resourceType: 'OperationOutcome', issue: [{severity, code, diagnostics: `${en} | ${ar}`}]
});
const send = (reply, status, body) => reply.code(status).type(FHIR_JSON).send(body);
const notFound = (reply, type) => send(reply, 404, outcome('not-found',
    `${type} not found.`, `لم يُعثر على ${type}.`));
const unknownParam = (reply, name) => send(reply, 400, outcome('invalid',
    `Unknown search parameter "${name}".`, `معامل بحث غير معروف: "${name}".`));

function unknownParamIn(resource, query) {
    const allowed = {...RESOURCES[resource].search};
    return Object.keys(query).find(key => !(key.split(':')[0] in allowed) && !COMMON_PARAMS.includes(key)) ?? null;
}

const searchset = (base, type, resources) => ({
    resourceType: 'Bundle', type: 'searchset', total: resources.length,
    entry: resources.map(r => ({fullUrl: `${base}/${type === 'Slot' ? 'Slot' : r.resourceType}/${r.id}`, resource: r, search: {mode: 'match'}}))
});

// ---- Loading approved doctors and facilities (public columns only) ----

const DOCTOR_SQL = `SELECT u.id, u.name, p.specialty, p.governorate, p.area, p.clinic_name, p.clinic_address, p.clinic_phone, p.bio,
        p.updated_at, COALESCE(s.slot_minutes, 20) AS slot_minutes, s.updated_at AS schedule_updated_at,
        COALESCE((SELECT json_agg(json_build_object('weekday', w.weekday, 'starts_at', to_char(w.starts_at, 'HH24:MI'),
                 'ends_at', to_char(w.ends_at, 'HH24:MI')) ORDER BY w.weekday, w.starts_at)
                 FROM weekly_hours w WHERE w.doctor_id = u.id), '[]'::json) AS hours
    FROM users u JOIN doctor_profiles p ON p.user_id = u.id LEFT JOIN doctor_schedules s ON s.doctor_id = u.id
    WHERE u.role = 'doctor' AND p.status = 'approved' AND u.disabled_at IS NULL`;

async function loadDoctors(db, {where = [], args = [], limit = MAX_COUNT} = {}) {
    const sql = `${DOCTOR_SQL}${where.map(w => ` AND ${w}`).join('')} ORDER BY u.name LIMIT ${Number(limit)}`;
    return (await db.query(sql, args)).rows;
}

const FACILITY_SQL = `SELECT u.id, p.kind, p.facility_name, p.governorate, p.area, p.address, p.phone, p.services, p.emergency,
        p.opening_hours, p.description, p.updated_at
    FROM users u JOIN facility_profiles p ON p.user_id = u.id
    WHERE p.status = 'approved' AND u.disabled_at IS NULL`;

async function loadFacilities(db, {where = [], args = [], limit = MAX_COUNT} = {}) {
    const sql = `${FACILITY_SQL}${where.map(w => ` AND ${w}`).join('')} ORDER BY p.facility_name NULLS LAST LIMIT ${Number(limit)}`;
    return (await db.query(sql, args)).rows;
}

export default async function fhirRoutes(app) {
    const base = `${app.config.appOrigin}/fhir/r4`;

    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('Cache-Control', 'no-store');
        return payload;
    });
    app.setNotFoundHandler((request, reply) => send(reply, 404, outcome('not-found', 'Unknown FHIR endpoint.', 'نقطة نهاية غير معروفة.')));
    app.setErrorHandler((error, request, reply) => {
        request.log.error({err: error}, 'FHIR request failed');
        send(reply, error.statusCode && error.statusCode < 500 ? error.statusCode : 500,
            outcome('exception', 'The server could not process this request.', 'تعذر على الخادم معالجة هذا الطلب.'));
    });

    app.get('/metadata', async (request, reply) => send(reply, 200, capabilityStatement(base, {health: app.config.healthFile})));

    // ---- Health file of the signed-in patient (stage 2b, src/fhir/health.js) ----
    healthFhirRoutes(app, {base, send, outcome});

    // ---- Results and documents from lab and clinic software (stage 2d, src/fhir/write.js) ----
    fhirWriteRoutes(app, {send, outcome});

    // ---- Fixed resources ----
    app.get('/Endpoint/fhir-r4', async (request, reply) => send(reply, 200, endpoint(base)));
    app.get('/CodeSystem/:id', async (request, reply) => {
        const found = codeSystems().find(c => c.id === request.params.id);
        return found ? send(reply, 200, found) : notFound(reply, 'CodeSystem');
    });
    app.get('/ValueSet/:id', async (request, reply) => {
        const found = valueSets().find(v => v.id === request.params.id);
        return found ? send(reply, 200, found) : notFound(reply, 'ValueSet');
    });
    app.get('/NamingSystem/:id', async (request, reply) => {
        const found = namingSystems().find(n => n.id === request.params.id);
        return found ? send(reply, 200, found) : notFound(reply, 'NamingSystem');
    });

    // ---- Practitioner, PractitionerRole, Schedule ----
    app.get('/Practitioner/:id', async (request, reply) => {
        if (!UUID.test(request.params.id)) return notFound(reply, 'Practitioner');
        const [doctor] = await loadDoctors(app.pg, {where: ['u.id = $1'], args: [request.params.id], limit: 1});
        return doctor ? send(reply, 200, practitioner(doctor)) : notFound(reply, 'Practitioner');
    });
    app.get('/Practitioner', async (request, reply) => {
        const bad = unknownParamIn('Practitioner', request.query);
        if (bad) return unknownParam(reply, bad);
        const where = [], args = [];
        if (request.query.name) where.push(`u.name ILIKE $${args.push(like(first(request.query.name)))}`);
        const rows = await loadDoctors(app.pg, {where, args, limit: count(request.query)});
        return send(reply, 200, searchset(base, 'Practitioner', rows.map(practitioner)));
    });

    app.get('/PractitionerRole/:id', async (request, reply) => {
        if (!UUID.test(request.params.id)) return notFound(reply, 'PractitionerRole');
        const [doctor] = await loadDoctors(app.pg, {where: ['u.id = $1'], args: [request.params.id], limit: 1});
        return doctor ? send(reply, 200, practitionerRole(doctor)) : notFound(reply, 'PractitionerRole');
    });
    app.get('/PractitionerRole', async (request, reply) => {
        const bad = unknownParamIn('PractitionerRole', request.query);
        if (bad) return unknownParam(reply, bad);
        const where = [], args = [];
        if (request.query.specialty) {
            const key = tokenCode(first(request.query.specialty));
            if (!specialties[key]) return send(reply, 200, searchset(base, 'PractitionerRole', []));
            where.push(`p.specialty = $${args.push(key)}`);
        }
        const practitionerRef = request.query.practitioner && tokenOrRef(first(request.query.practitioner), 'Practitioner');
        const locationRef = request.query.location && tokenOrRef(first(request.query.location), 'Location');
        if (practitionerRef) where.push(`u.id = $${args.push(practitionerRef)}`);
        if (locationRef) where.push(`u.id = $${args.push(locationRef)}`);
        const rows = await loadDoctors(app.pg, {where, args, limit: count(request.query)});
        return send(reply, 200, searchset(base, 'PractitionerRole', rows.map(practitionerRole)));
    });

    app.get('/Schedule/:id', async (request, reply) => {
        if (!UUID.test(request.params.id)) return notFound(reply, 'Schedule');
        const [doctor] = await loadDoctors(app.pg, {where: ['u.id = $1'], args: [request.params.id], limit: 1});
        return doctor ? send(reply, 200, schedule(doctor)) : notFound(reply, 'Schedule');
    });

    // Free slots are computed from opening hours, notice, booking window and existing bookings: never stored.
    app.get('/Slot', async (request, reply) => {
        const bad = unknownParamIn('Slot', request.query);
        if (bad) return unknownParam(reply, bad);
        const doctorId = tokenOrRef(first(request.query.schedule || ''), 'Schedule');
        if (!doctorId || !UUID.test(doctorId)) return send(reply, 200, searchset(base, 'Slot', []));
        const [doctor] = await loadDoctors(app.pg, {where: ['u.id = $1'], args: [doctorId], limit: 1});
        if (!doctor) return notFound(reply, 'Schedule');
        if (request.query.status && tokenCode(first(request.query.status)) !== 'free') return send(reply, 200, searchset(base, 'Slot', []));
        const {from, to} = dateRange(request.query.start);
        const days = Math.min(Math.max(Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1, 1), 31);
        const {slots} = await slotsFor(app.pg, doctorId, {from, days});
        const picked = slots.filter(s => s.date <= to).slice(0, count(request.query));
        return send(reply, 200, searchset(base, 'Slot', picked.map(s => slot(doctorId, s))));
    });
    app.get('/Slot/:id', async (request, reply) => {
        const parsed = parseSlotId(request.params.id);
        if (!parsed) return notFound(reply, 'Slot');
        const [doctor] = await loadDoctors(app.pg, {where: ['u.id = $1'], args: [parsed.doctorId], limit: 1});
        if (!doctor) return notFound(reply, 'Slot');
        const day = parsed.startsAt.slice(0, 10);
        const {slots} = await slotsFor(app.pg, parsed.doctorId, {from: day, days: 1});
        const found = slots.find(s => s.starts_at === parsed.startsAt);
        return found ? send(reply, 200, slot(parsed.doctorId, found)) : notFound(reply, 'Slot');
    });

    // ---- Organization, Location, HealthcareService (laboratories, imaging centres, hospitals, clinics, pharmacies, blood banks) ----
    app.get('/Organization/:id', async (request, reply) => {
        if (!UUID.test(request.params.id)) return notFound(reply, 'Organization');
        const [f] = await loadFacilities(app.pg, {where: ['u.id = $1'], args: [request.params.id], limit: 1});
        return f ? send(reply, 200, organization(f)) : notFound(reply, 'Organization');
    });
    app.get('/Organization', async (request, reply) => {
        const bad = unknownParamIn('Organization', request.query);
        if (bad) return unknownParam(reply, bad);
        const {where, args} = facilityFilters(request.query);
        const rows = await loadFacilities(app.pg, {where, args, limit: count(request.query)});
        return send(reply, 200, searchset(base, 'Organization', rows.map(organization)));
    });

    app.get('/Location/:id', async (request, reply) => {
        if (!UUID.test(request.params.id)) return notFound(reply, 'Location');
        const found = await locationById(app.pg, request.params.id);
        return found ? send(reply, 200, found) : notFound(reply, 'Location');
    });
    app.get('/Location', async (request, reply) => {
        const bad = unknownParamIn('Location', request.query);
        if (bad) return unknownParam(reply, bad);
        const {where, args} = facilityFilters(request.query);
        const rows = await loadFacilities(app.pg, {where, args, limit: count(request.query)});
        const doctors = request.query.name || !request.query.type || tokenCode(first(request.query.type)) === 'OF'
            ? await loadDoctors(app.pg, {where: request.query.name ? [`u.name ILIKE $1`] : [], args: request.query.name ? [like(first(request.query.name))] : [], limit: count(request.query)})
            : [];
        const resources = [...doctors.map(practiceLocation), ...rows.map(facilityLocation)].slice(0, count(request.query));
        return send(reply, 200, searchset(base, 'Location', resources));
    });

    app.get('/HealthcareService/:id', async (request, reply) => {
        if (!UUID.test(request.params.id)) return notFound(reply, 'HealthcareService');
        const [f] = await loadFacilities(app.pg, {where: ['u.id = $1'], args: [request.params.id], limit: 1});
        return f ? send(reply, 200, healthcareService(f)) : notFound(reply, 'HealthcareService');
    });
    app.get('/HealthcareService', async (request, reply) => {
        const bad = unknownParamIn('HealthcareService', request.query);
        if (bad) return unknownParam(reply, bad);
        const where = [], args = [];
        if (request.query.name) where.push(`(p.facility_name ILIKE $${args.push(like(first(request.query.name)))})`);
        if (request.query.category) {
            const kind = tokenCode(first(request.query.category));
            if (!facilityKinds[kind]) return send(reply, 200, searchset(base, 'HealthcareService', []));
            where.push(`p.kind = $${args.push(kind)}`);
        }
        if (request.query.type) {
            const [kind, key] = tokenCode(first(request.query.type)).split('.');
            if (!facilityServices[kind]?.[key]) return send(reply, 200, searchset(base, 'HealthcareService', []));
            where.push(`p.kind = $${args.push(kind)} AND $${args.push(key)} = ANY(p.services)`);
        }
        const rows = await loadFacilities(app.pg, {where, args, limit: count(request.query)});
        return send(reply, 200, searchset(base, 'HealthcareService', rows.map(healthcareService)));
    });
}

// "Practitioner/<id>", "Location/<id>", "Schedule/<id>" or a bare id.
function tokenOrRef(value, type) {
    const text = String(value || '');
    if (text.startsWith(`${type}/`)) return text.slice(type.length + 1);
    return text.includes('/') ? null : text;
}

function facilityFilters(query) {
    const where = [], args = [];
    if (query.name) where.push(`p.facility_name ILIKE $${args.push(like(first(query.name)))}`);
    if (query.type) {
        const kind = tokenCode(first(query.type));
        if (facilityKinds[kind]) where.push(`p.kind = $${args.push(kind)}`);
        else if (kind !== 'OF') where.push('FALSE');
    }
    return {where, args};
}

async function locationById(db, id) {
    const [doctor] = await loadDoctors(db, {where: ['u.id = $1'], args: [id], limit: 1});
    if (doctor) return practiceLocation(doctor);
    const [f] = await loadFacilities(db, {where: ['u.id = $1'], args: [id], limit: 1});
    return f ? facilityLocation(f) : null;
}

// slot start parameters: "ge2026-11-09", "le2026-11-15" (both optional, days only).
function dateRange(values) {
    const list = [].concat(values || []).map(String);
    const today = localDate(Date.now(), 'Asia/Damascus');
    let from = today, to = addDays(today, 6);
    for (const value of list) {
        const match = /^(ge|le)?(\d{4}-\d{2}-\d{2})$/.exec(value);
        if (!match || !DATE.test(match[2])) continue;
        if (match[1] === 'le') to = match[2];
        else from = match[2] >= today ? match[2] : today;
    }
    if (to < from) to = from;
    return {from, to: to > addDays(from, 30) ? addDays(from, 30) : to};
}
