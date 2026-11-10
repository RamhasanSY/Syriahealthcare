// Medicine reminders: patients enter their medicines (and their children's) with the times of day; at each time the
// phone shows a notification, and the patient ticks the dose as taken. Part of the health file: switched off with it
// (HEALTH_FILE=off), and only for profiles whose health file the patient agreed to keep.
//
// The notification says "Time for your medicine" unless the patient chose to show the name: the lock screen may be seen.
// A dose is reminded once (the database refuses a second row for the same time); after a server pause of more than
// 10 minutes the missed reminders are skipped instead of arriving late.
import {HttpError, requireRole} from './auth.js';
import {audit} from './db.js';
import {notFound, ownProfiles, patientFor} from './access.js';
import {pushToUser} from './push.js';
import {addDays, localDate, localToUtc, weekdayOf} from './slots.js';

const TZ = 'Asia/Damascus';
export const LIMITS = {perProfile: 20, timesPerDay: 6, lateMinutes: 10};
const UUID = {type: 'string', format: 'uuid'};
const idParam = {params: {type: 'object', properties: {id: UUID}}};
const DATE = '^\\d{4}-\\d{2}-\\d{2}$', TIME = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const isoDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null;

const medicationView = m => ({id: m.id, profile_id: m.patient_id, name: m.name, dose: m.dose, times: m.times, weekdays: m.weekdays,
    start_date: isoDate(m.start_date), end_date: isoDate(m.end_date), notes: m.notes, show_name: m.show_name, active: m.active});

// Whether a medicine is taken on a local calendar day.
const takenOn = (m, day) => m.active && isoDate(m.start_date) <= day && (!m.end_date || isoDate(m.end_date) >= day)
    && (!m.weekdays.length || m.weekdays.includes(weekdayOf(day)));

// The doses of a day, as instants.
export const dosesOn = (m, day) => takenOn(m, day) ? m.times.map(t => new Date(localToUtc(day, t, TZ))) : [];

async function hasConsent(db, patientId) {
    const {rows: [c]} = await db.query("SELECT 1 FROM consents WHERE patient_id = $1 AND scope = 'health_file' AND withdrawn_at IS NULL", [patientId]);
    return Boolean(c);
}

// Run every minute by src/jobs.js. Returns how many doses were reminded.
export async function sendMedicationReminders(app, now = Date.now()) {
    if (!app.config.healthFile) return 0;
    const today = localDate(now, TZ), yesterday = addDays(today, -1);
    const {rows: medicines} = await app.pg.query(
        `SELECT m.* FROM medications m WHERE m.active AND m.start_date <= $1 AND (m.end_date IS NULL OR m.end_date >= $2)
           AND EXISTS (SELECT 1 FROM consents c WHERE c.patient_id = m.patient_id AND c.scope = 'health_file' AND c.withdrawn_at IS NULL)`,
        [today, yesterday]);
    let reminded = 0;
    for (const m of medicines) {
        const due = [...dosesOn(m, yesterday), ...dosesOn(m, today)].filter(at => at.getTime() <= now && at.getTime() > now - LIMITS.lateMinutes * 60_000);
        for (const at of due) {
            const {rows: [dose]} = await app.pg.query(
                `INSERT INTO medication_doses (medication_id, scheduled_for, reminded_at) VALUES ($1, $2, now())
                 ON CONFLICT (medication_id, scheduled_for) DO NOTHING RETURNING id`, [m.id, at]);
            if (!dose) continue;
            reminded++;
            const {rows: people} = await app.pg.query('SELECT user_id FROM patient_access WHERE patient_id = $1', [m.patient_id]);
            const title = m.show_name ? [`Time for ${m.name}`, `حان وقت ${m.name}`] : ['Time for your medicine', 'حان وقت الدواء'];
            const body = m.show_name && m.dose ? [m.dose, m.dose] : ['Open SyriaHC to mark it as taken.', 'افتح صحة تك لتسجيل أخذه.'];
            for (const p of people) {
                await pushToUser(app, p.user_id, {title, body, url: '/medications', tag: `medicine-${m.id}`, urgency: 'high'});
            }
        }
    }
    return reminded;
}

export default async function medicationRoutes(app) {
    // Off together with the health file: the routes do not exist for anyone.
    app.addHook('onRequest', async request => {
        if (!app.config.healthFile && String(request.routeOptions?.url || request.url).startsWith('/api/medications')) throw notFound();
    });
    const patientOnly = requireRole('patient');

    async function ownMedicine(request, id) {
        const {rows: [m]} = await app.pg.query('SELECT * FROM medications WHERE id = $1', [id]);
        if (!m) throw notFound();
        await patientFor(app.pg, request.user, m.patient_id);
        return m;
    }

    function clean(body, current = {}) {
        const pick = key => body[key] === undefined ? current[key] ?? null : body[key];
        const name = String(pick('name') || '').trim();
        if (name.length < 2) throw new HttpError(400, 'invalid_medicine_name', 'Write the name of the medicine.');
        const times = [...new Set(pick('times') || [])].sort();
        if (!times.length) throw new HttpError(400, 'invalid_times', 'Add at least one time of day.');
        const weekdays = [...new Set(pick('weekdays') || [])].sort();
        const start = isoDate(pick('start_date')) || localDate(Date.now(), TZ), end = isoDate(pick('end_date'));
        if (end && end < start) throw new HttpError(400, 'invalid_date', 'The last day cannot be before the first day.');
        const text = key => { const v = pick(key); return v ? String(v).trim() || null : null; };
        return {name, dose: text('dose'), times, weekdays, start_date: start, end_date: end, notes: text('notes'),
            show_name: Boolean(pick('show_name')), active: pick('active') === null ? true : Boolean(pick('active'))};
    }
    const body = {type: 'object', additionalProperties: false, properties: {
        profile_id: UUID, name: {type: 'string', maxLength: 80}, dose: {type: ['string', 'null'], maxLength: 60},
        times: {type: 'array', minItems: 1, maxItems: LIMITS.timesPerDay, items: {type: 'string', pattern: TIME}},
        weekdays: {type: 'array', maxItems: 7, items: {type: 'integer', minimum: 0, maximum: 6}},
        start_date: {type: ['string', 'null'], pattern: DATE}, end_date: {type: ['string', 'null'], pattern: DATE},
        notes: {type: ['string', 'null'], maxLength: 200}, show_name: {type: 'boolean'}, active: {type: 'boolean'}
    }};

    // Every own profile with its medicines and today's doses (taken or not).
    app.get('/api/medications', {preHandler: patientOnly}, async request => {
        const profiles = await ownProfiles(app.pg, request.user.id);
        const today = localDate(Date.now(), TZ);
        const out = [];
        for (const p of profiles) {
            const consent = await hasConsent(app.pg, p.id);
            const {rows: meds} = await app.pg.query('SELECT * FROM medications WHERE patient_id = $1 ORDER BY lower(name)', [p.id]);
            const doses = meds.flatMap(m => dosesOn(m, today).map(at => ({medication_id: m.id, name: m.name, dose: m.dose, scheduled_for: at.toISOString()})));
            const {rows: taken} = doses.length ? await app.pg.query(
                'SELECT medication_id, scheduled_for, taken_at FROM medication_doses WHERE medication_id = ANY($1) AND scheduled_for = ANY($2) AND taken_at IS NOT NULL',
                [meds.map(m => m.id), doses.map(d => d.scheduled_for)]) : {rows: []};
            const isTaken = d => taken.some(t => t.medication_id === d.medication_id && t.scheduled_for.toISOString() === d.scheduled_for);
            out.push({id: p.id, name: p.name, relationship: p.relationship, consent, medications: meds.map(medicationView),
                today: doses.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for)).map(d => ({...d, taken: isTaken(d)}))});
        }
        return {profiles: out, limits: LIMITS};
    });

    app.post('/api/medications', {preHandler: patientOnly, schema: {body: {...body, required: ['profile_id', 'name', 'times']}}}, async (request, reply) => {
        const profile = await patientFor(app.pg, request.user, request.body.profile_id);
        if (!await hasConsent(app.pg, profile.id)) throw new HttpError(403, 'file_consent_required', 'Please agree to keeping a health file first.');
        const {rows: [{n}]} = await app.pg.query('SELECT count(*)::int AS n FROM medications WHERE patient_id = $1', [profile.id]);
        if (n >= LIMITS.perProfile) throw new HttpError(409, 'too_many_medicines', `At most ${LIMITS.perProfile} medicines per profile.`);
        const m = clean(request.body);
        const {rows: [row]} = await app.pg.query(
            `INSERT INTO medications (patient_id, created_by, name, dose, times, weekdays, start_date, end_date, notes, show_name, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [profile.id, request.user.id, m.name, m.dose, m.times, m.weekdays, m.start_date, m.end_date, m.notes, m.show_name, m.active]);
        await audit(app.pg, {actorId: request.user.id, action: 'medication.added', targetId: row.id, details: {patient_id: profile.id}, ip: request.ip});
        reply.code(201);
        return {medication: medicationView(row)};
    });

    app.post('/api/medications/:id', {preHandler: patientOnly, schema: {...idParam, body}}, async request => {
        const current = await ownMedicine(request, request.params.id);
        const m = clean(request.body || {}, {...current, start_date: isoDate(current.start_date), end_date: isoDate(current.end_date)});
        const {rows: [row]} = await app.pg.query(
            `UPDATE medications SET name = $2, dose = $3, times = $4, weekdays = $5, start_date = $6, end_date = $7, notes = $8, show_name = $9,
                 active = $10, updated_at = now() WHERE id = $1 RETURNING *`,
            [current.id, m.name, m.dose, m.times, m.weekdays, m.start_date, m.end_date, m.notes, m.show_name, m.active]);
        await audit(app.pg, {actorId: request.user.id, action: 'medication.changed', targetId: row.id, details: {patient_id: row.patient_id}, ip: request.ip});
        return {medication: medicationView(row)};
    });

    app.post('/api/medications/:id/delete', {preHandler: patientOnly, schema: idParam}, async request => {
        const m = await ownMedicine(request, request.params.id);
        await app.pg.query('DELETE FROM medications WHERE id = $1', [m.id]);
        await audit(app.pg, {actorId: request.user.id, action: 'medication.deleted', targetId: m.id, details: {patient_id: m.patient_id}, ip: request.ip});
        return {deleted: true};
    });

    // Ticking a dose of the last 24 hours as taken (or not taken after all).
    const doseBody = {type: 'object', required: ['scheduled_for'], additionalProperties: false, properties: {
        scheduled_for: {type: 'string', format: 'date-time'}, taken: {type: 'boolean'}}};
    app.post('/api/medications/:id/dose', {preHandler: patientOnly, schema: {...idParam, body: doseBody}}, async request => {
        const m = await ownMedicine(request, request.params.id);
        const at = new Date(request.body.scheduled_for), now = Date.now();
        const day = localDate(at.getTime(), TZ);
        const valid = Math.abs(now - at.getTime()) <= 24 * 3600_000 && dosesOn(m, day).some(d => d.getTime() === at.getTime());
        if (!valid) throw new HttpError(400, 'invalid_dose', 'This is not one of the times of this medicine.');
        const taken = request.body.taken !== false;
        await app.pg.query(
            `INSERT INTO medication_doses (medication_id, scheduled_for, taken_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END)
             ON CONFLICT (medication_id, scheduled_for) DO UPDATE SET taken_at = CASE WHEN $3 THEN now() END`, [m.id, at, taken]);
        return {taken};
    });
}
