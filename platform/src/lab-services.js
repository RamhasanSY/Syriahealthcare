// Lab services: each lab's price list (public once approved) and home sample collection.
// Patients ask a lab that offers "home sample collection" to come on a day (morning, midday, afternoon or evening);
// the lab confirms with an arrival time, declines, cancels or marks the visit done. Patients with an email address are told.
import {HttpError, requireRole} from './auth.js';
import {ensureSelfProfile, patientFor} from './access.js';
import {facilityServices} from './catalog.js';
import {audit} from './db.js';
import {sendEmail} from './notify.js';
import {normalizePhone} from './security.js';
import {pushToUser} from './push.js';

const LAB_KINDS = ['lab', 'imaging'];
export const WINDOWS = {morning: ['Morning (8–11)', 'صباحاً (8–11)'], midday: ['Midday (11–14)', 'ظهراً (11–14)'],
    afternoon: ['Afternoon (14–17)', 'بعد الظهر (14–17)'], evening: ['Evening (17–20)', 'مساءً (17–20)']};
export const LIMITS = {tests: 300, activeVisits: 3, daysAhead: 30};
const TZ = 'Asia/Damascus';
const UUID = {type: 'string', format: 'uuid'};
const idParam = {params: {type: 'object', properties: {id: UUID}}};
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date());
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const testView = t => ({id: t.id, name: t.name, service: t.service, price_syp: t.price_syp, turnaround_hours: t.turnaround_hours,
    notes: t.notes, updated_at: t.updated_at});
const visitView = v => ({id: v.id, facility_id: v.facility_id, lab_name: v.lab_name, lab_phone: v.lab_phone, visit_date: v.visit_date,
    time_window: v.time_window, address: v.address, phone: v.phone, tests: v.tests, status: v.status, arrival_time: v.arrival_time,
    lab_note: v.lab_note, patient_name: v.patient_name, subject_name: v.subject_name, created_at: v.created_at});

// Push texts without the lab's name (src/push.js).
const VISIT_PUSH = {
    confirmed: {title: ['Home visit confirmed', 'تم تأكيد الزيارة المنزلية'], body: ['Open SyriaHC to see the arrival time.', 'افتح صحة تك لمعرفة موعد الوصول.']},
    declined: {title: ['Home visit declined', 'تم الاعتذار عن الزيارة المنزلية'], body: ['Open SyriaHC to see why.', 'افتح صحة تك لمعرفة السبب.']},
    cancelled_by_lab: {title: ['Home visit cancelled', 'تم إلغاء الزيارة المنزلية'], body: ['Open SyriaHC to see why.', 'افتح صحة تك لمعرفة السبب.']}
};

const VISIT_SQL = `SELECT v.*, p.facility_name AS lab_name, p.phone AS lab_phone, u.name AS patient_name, s.name AS subject_name
    FROM home_visits v JOIN facility_profiles p ON p.user_id = v.facility_id JOIN users u ON u.id = v.patient_id
    LEFT JOIN patients s ON s.id = v.subject_id`;

// The patient's email about the lab's decision, in the account's language first.
function visitEmail(patient, v, status) {
    const when = `${v.visit_date} (${WINDOWS[v.time_window][0]})${v.arrival_time ? ', ' + v.arrival_time : ''}`;
    const whenAr = `${v.visit_date} (${WINDOWS[v.time_window][1]})${v.arrival_time ? '، ' + v.arrival_time : ''}`;
    const note = v.lab_note ? `\n\n${v.lab_note}` : '';
    const texts = {
        confirmed: [`${v.lab_name} confirmed the home sample collection on ${when}.${note}`, `أكّد ${v.lab_name} سحب العينات من المنزل في ${whenAr}.${note}`],
        declined: [`${v.lab_name} cannot come for the home sample collection on ${when}.${note}`, `اعتذر ${v.lab_name} عن سحب العينات من المنزل في ${whenAr}.${note}`],
        cancelled_by_lab: [`${v.lab_name} cancelled the home sample collection on ${when}.${note}`, `ألغى ${v.lab_name} سحب العينات من المنزل في ${whenAr}.${note}`]
    }[status];
    const [en, ar] = texts;
    return {subject: patient.language === 'en' ? 'Home sample collection — SyriaHC' : 'سحب العينات من المنزل — صحة تك',
        text: patient.language === 'en' ? `${en}\n\n— — —\n\n${ar}` : `${ar}\n\n— — —\n\n${en}`};
}

export default async function labServiceRoutes(app) {
    const facilityOnly = requireRole('facility');
    const patientOnly = requireRole('patient');

    // The signed-in lab or imaging centre (any review status for editing; public only when approved).
    async function ownLab(userId, {approved = false} = {}) {
        const {rows: [lab]} = await app.pg.query('SELECT user_id, kind, status, facility_name, services FROM facility_profiles WHERE user_id = $1', [userId]);
        if (!lab || !LAB_KINDS.includes(lab.kind)) throw new HttpError(403, 'not_a_lab', 'Only laboratories and imaging centres have a price list and home visits.');
        // Patients' addresses and phones only for a lab that is approved now (not one that was suspended).
        if (approved && lab.status !== 'approved') throw new HttpError(403, 'lab_not_approved', 'Your facility must be approved to handle home visits.');
        return lab;
    }

    // ---- Price list (lab side) ----

    const testBody = {type: 'object', additionalProperties: false, properties: {
        name: {type: 'string', maxLength: 120}, service: {type: ['string', 'null'], maxLength: 40},
        price_syp: {type: ['integer', 'null'], minimum: 0, maximum: 100000000}, turnaround_hours: {type: ['integer', 'null'], minimum: 0, maximum: 2000},
        notes: {type: ['string', 'null'], maxLength: 200}
    }};
    function cleanTest(lab, body, current = {}) {
        const name = body.name === undefined ? current.name : String(body.name).trim();
        if (!name || name.length < 2) throw new HttpError(400, 'invalid_test_name', 'Give the test a name.');
        const service = body.service === undefined ? current.service ?? null : body.service || null;
        if (service && !Object.hasOwn(facilityServices[lab.kind] || {}, service)) throw new HttpError(400, 'invalid_service', 'Choose the kind of test from the list.');
        const pick = key => body[key] === undefined ? current[key] ?? null : body[key];
        const notes = pick('notes');
        return {name, service, price_syp: pick('price_syp'), turnaround_hours: pick('turnaround_hours'), notes: notes ? String(notes).trim() || null : null};
    }

    app.get('/api/facility/tests', {preHandler: facilityOnly}, async request => {
        const lab = await ownLab(request.user.id);
        const {rows} = await app.pg.query('SELECT * FROM lab_tests WHERE facility_id = $1 ORDER BY lower(name)', [lab.user_id]);
        return {tests: rows.map(testView), services: facilityServices[lab.kind], limit: LIMITS.tests};
    });

    app.post('/api/facility/tests', {preHandler: facilityOnly, schema: {body: {...testBody, required: ['name']}}}, async (request, reply) => {
        const lab = await ownLab(request.user.id);
        const t = cleanTest(lab, request.body);
        const {rows: [{n}]} = await app.pg.query('SELECT count(*)::int AS n FROM lab_tests WHERE facility_id = $1', [lab.user_id]);
        if (n >= LIMITS.tests) throw new HttpError(409, 'too_many_tests', `At most ${LIMITS.tests} tests in the price list.`);
        try {
            const {rows: [row]} = await app.pg.query(
                `INSERT INTO lab_tests (facility_id, name, service, price_syp, turnaround_hours, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [lab.user_id, t.name, t.service, t.price_syp, t.turnaround_hours, t.notes]);
            reply.code(201);
            return {test: testView(row)};
        } catch (error) {
            if (error.code === '23505') throw new HttpError(409, 'test_exists', 'This test is already in the price list.');
            throw error;
        }
    });

    app.post('/api/facility/tests/:id', {preHandler: facilityOnly, schema: {...idParam, body: testBody}}, async request => {
        const lab = await ownLab(request.user.id);
        const {rows: [current]} = await app.pg.query('SELECT * FROM lab_tests WHERE id = $1 AND facility_id = $2', [request.params.id, lab.user_id]);
        if (!current) throw new HttpError(404, 'not_found', 'Test not found.');
        const t = cleanTest(lab, request.body || {}, current);
        try {
            const {rows: [row]} = await app.pg.query(
                `UPDATE lab_tests SET name = $2, service = $3, price_syp = $4, turnaround_hours = $5, notes = $6, updated_at = now() WHERE id = $1 RETURNING *`,
                [current.id, t.name, t.service, t.price_syp, t.turnaround_hours, t.notes]);
            return {test: testView(row)};
        } catch (error) {
            if (error.code === '23505') throw new HttpError(409, 'test_exists', 'This test is already in the price list.');
            throw error;
        }
    });

    app.post('/api/facility/tests/:id/delete', {preHandler: facilityOnly, schema: idParam}, async request => {
        const lab = await ownLab(request.user.id);
        const {rowCount} = await app.pg.query('DELETE FROM lab_tests WHERE id = $1 AND facility_id = $2', [request.params.id, lab.user_id]);
        if (!rowCount) throw new HttpError(404, 'not_found', 'Test not found.');
        return {deleted: true};
    });

    // ---- Public lab page: details, price list, and whether it comes to the home ----

    app.get('/api/labs/:id', {config: {cache: 'public, max-age=60'}, schema: idParam}, async request => {
        const {rows: [lab]} = await app.pg.query(
            `SELECT u.id, p.kind, p.facility_name, p.governorate, p.area, p.address, p.phone, p.services, p.opening_hours
             FROM users u JOIN facility_profiles p ON p.user_id = u.id
             WHERE u.id = $1 AND p.status = 'approved' AND u.disabled_at IS NULL AND p.kind = ANY($2)`, [request.params.id, LAB_KINDS]);
        if (!lab) throw new HttpError(404, 'not_found', 'Lab not found.');
        const {rows: tests} = await app.pg.query('SELECT * FROM lab_tests WHERE facility_id = $1 ORDER BY lower(name)', [lab.id]);
        const updated = tests.reduce((max, t) => (!max || t.updated_at > max ? t.updated_at : max), null);
        return {lab: {...lab, home_collection: (lab.services || []).includes('home_collection')}, tests: tests.map(testView), prices_updated_at: updated, windows: WINDOWS};
    });

    // ---- Home sample collection: patients ----

    app.post('/api/home-visits', {preHandler: patientOnly, config: {rateLimit: {max: 10, timeWindow: '1 hour'}}, schema: {body: {type: 'object',
        required: ['facility_id', 'visit_date', 'time_window', 'address', 'phone'], additionalProperties: false, properties: {
            facility_id: UUID, visit_date: {type: 'string', pattern: DATE}, time_window: {enum: Object.keys(WINDOWS)},
            address: {type: 'string', maxLength: 300}, phone: {type: 'string', maxLength: 30}, tests: {type: 'string', maxLength: 300}, subject_id: UUID
        }}}}, async (request, reply) => {
        const {rows: [lab]} = await app.pg.query(
            `SELECT p.user_id, p.facility_name, u.email, u.name, u.language FROM facility_profiles p JOIN users u ON u.id = p.user_id
             WHERE p.user_id = $1 AND p.status = 'approved' AND u.disabled_at IS NULL AND p.kind = ANY($2) AND 'home_collection' = ANY(p.services)`,
            [request.body.facility_id, LAB_KINDS]);
        if (!lab) throw new HttpError(404, 'not_found', 'This lab does not offer home sample collection.');
        const day = request.body.visit_date, first = addDays(today(), 1), last = addDays(today(), LIMITS.daysAhead);
        if (day < first || day > last) throw new HttpError(400, 'invalid_date', `Choose a day from tomorrow to ${LIMITS.daysAhead} days ahead.`);
        const address = request.body.address.trim();
        if (address.length < 5) throw new HttpError(400, 'invalid_address', 'Write the address so the lab can find you.');
        const phone = normalizePhone(request.body.phone);
        if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a valid mobile number, for example 0912 345 678.');
        const subject = request.body.subject_id ? await patientFor(app.pg, request.user, request.body.subject_id) : await ensureSelfProfile(app.pg, request.user);
        const {rows: [{n}]} = await app.pg.query(
            `SELECT count(*)::int AS n FROM home_visits WHERE patient_id = $1 AND status IN ('requested', 'confirmed') AND visit_date >= $2`, [request.user.id, today()]);
        if (n >= LIMITS.activeVisits) throw new HttpError(409, 'too_many_visits', `You already have ${LIMITS.activeVisits} open home visits. Cancel one first.`);
        const {rows: [visit]} = await app.pg.query(
            `INSERT INTO home_visits (facility_id, patient_id, subject_id, visit_date, time_window, address, phone, tests)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [lab.user_id, request.user.id, subject?.id || null, day, request.body.time_window, address, phone, request.body.tests?.trim() || null]);
        await audit(app.pg, {actorId: request.user.id, action: 'home_visit.requested', targetId: visit.id, details: {facility_id: lab.user_id}, ip: request.ip});
        await sendEmail(app, lab.email, {
            subject: 'New home sample collection request — SyriaHC | طلب سحب عينات من المنزل',
            text: `A patient asks for home sample collection on ${day} (${WINDOWS[visit.time_window][0]}). Open ${app.config.appOrigin}/home-visits to confirm or decline.\n\n` +
                `طلب مريض سحب العينات من المنزل في ${day} (${WINDOWS[visit.time_window][1]}). افتح ${app.config.appOrigin}/home-visits للتأكيد أو الاعتذار.`
        });
        await pushToUser(app, lab.user_id, {title: ['New home visit request', 'طلب زيارة منزلية جديد'], body: ['Open home visits to confirm or decline.', 'افتح الزيارات المنزلية للتأكيد أو الاعتذار.'],
            url: '/home-visits', tag: 'home-visits'});
        reply.code(201);
        return {visit: visitView({...visit, lab_name: lab.facility_name})};
    });

    app.get('/api/home-visits/mine', {preHandler: patientOnly}, async request => {
        const {rows} = await app.pg.query(`${VISIT_SQL} WHERE v.patient_id = $1 ORDER BY v.visit_date DESC, v.created_at DESC LIMIT 100`, [request.user.id]);
        return {visits: rows.map(visitView), windows: WINDOWS};
    });

    app.post('/api/home-visits/:id/cancel', {preHandler: patientOnly, schema: idParam}, async request => {
        const {rows: [visit]} = await app.pg.query(
            `UPDATE home_visits SET status = 'cancelled_by_patient', updated_at = now()
             WHERE id = $1 AND patient_id = $2 AND status IN ('requested', 'confirmed') AND visit_date >= $3 RETURNING *`,
            [request.params.id, request.user.id, today()]);
        if (!visit) throw new HttpError(404, 'not_found', 'This home visit cannot be cancelled any more.');
        await audit(app.pg, {actorId: request.user.id, action: 'home_visit.cancelled_by_patient', targetId: visit.id, ip: request.ip});
        return {visit: {id: visit.id, status: visit.status}};
    });

    // ---- Home sample collection: the lab ----

    app.get('/api/lab/home-visits', {preHandler: facilityOnly, schema: {querystring: {type: 'object', additionalProperties: false, properties: {
        scope: {enum: ['open', 'upcoming', 'past']}
    }}}}, async request => {
        const lab = await ownLab(request.user.id, {approved: true});
        const scope = request.query.scope || 'open';
        const where = {
            open: "v.status = 'requested' AND v.visit_date >= $2",
            upcoming: "v.status = 'confirmed' AND v.visit_date >= $2",
            past: "(v.visit_date < $2 OR v.status NOT IN ('requested', 'confirmed'))"
        }[scope];
        const {rows} = await app.pg.query(
            `${VISIT_SQL} WHERE v.facility_id = $1 AND ${where} ORDER BY v.visit_date ${scope === 'past' ? 'DESC' : 'ASC'}, v.time_window LIMIT 300`, [lab.user_id, today()]);
        const {rows: [counts]} = await app.pg.query(
            `SELECT count(*) FILTER (WHERE status = 'requested' AND visit_date >= $2)::int AS open,
                    count(*) FILTER (WHERE status = 'confirmed' AND visit_date >= $2)::int AS upcoming
             FROM home_visits WHERE facility_id = $1`, [lab.user_id, today()]);
        await audit(app.pg, {actorId: request.user.id, action: 'home_visits.listed', targetId: lab.user_id, details: {scope, visits: rows.length}, ip: request.ip});
        return {scope, visits: rows.map(visitView), counts, windows: WINDOWS, offers_home_collection: (lab.services || []).includes('home_collection')};
    });

    const ACTIONS = {
        confirm: {from: 'requested', to: 'confirmed', note: false},
        decline: {from: 'requested', to: 'declined', note: true},
        cancel: {from: 'confirmed', to: 'cancelled_by_lab', note: true},
        done: {from: 'confirmed', to: 'done', note: false}
    };
    for (const [name, rule] of Object.entries(ACTIONS)) {
        app.post(`/api/lab/home-visits/:id/${name}`, {preHandler: facilityOnly, schema: {...idParam, body: {type: 'object', additionalProperties: false, properties: {
            note: {type: 'string', maxLength: 300}, arrival_time: {type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$'}
        }}}}, async request => {
            const lab = await ownLab(request.user.id, {approved: true});
            const note = request.body?.note?.trim() || null;
            if (rule.note && (!note || note.length < 3)) throw new HttpError(400, 'note_required', 'Please write a short reason for the patient.');
            const {rows: [visit]} = await app.pg.query(
                `UPDATE home_visits SET status = $3, lab_note = COALESCE($4, lab_note), arrival_time = COALESCE($5, arrival_time), updated_at = now()
                 WHERE id = $1 AND facility_id = $2 AND status = $6 RETURNING *`,
                [request.params.id, lab.user_id, rule.to, note, name === 'confirm' ? request.body?.arrival_time || null : null, rule.from]);
            if (!visit) throw new HttpError(409, 'wrong_status', 'This home visit has changed. Please reload.');
            await audit(app.pg, {actorId: request.user.id, action: `home_visit.${rule.to}`, targetId: visit.id, details: note ? {note} : {}, ip: request.ip});
            if (['confirmed', 'declined', 'cancelled_by_lab'].includes(rule.to)) {
                const {rows: [patient]} = await app.pg.query('SELECT email, language FROM users WHERE id = $1', [visit.patient_id]);
                if (patient?.email) await sendEmail(app, patient.email, visitEmail(patient, {...visit, lab_name: lab.facility_name}, rule.to));
                await pushToUser(app, visit.patient_id, {...VISIT_PUSH[rule.to], url: '/appointments', tag: `visit-${visit.id}`});
            }
            return {visit: {id: visit.id, status: visit.status, arrival_time: visit.arrival_time, lab_note: visit.lab_note}};
        });
    }
}
