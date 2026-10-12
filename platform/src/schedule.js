// Doctors' opening hours and days off, and the free slots patients can choose from.
import {HttpError, requireRole} from './auth.js';
import {audit, transaction} from './db.js';
import {addDays, freeSlots, hoursProblem, localDate} from './slots.js';

const PROBLEMS = {
    invalid_weekday: 'Choose a valid day.',
    invalid_time: 'Enter times like 09:00.',
    range_too_short: 'Each opening time must fit at least one appointment.',
    too_many_ranges: 'Up to 3 opening times per day.',
    overlapping_hours: 'Opening times on the same day must not overlap.'
};
const DEFAULTS = {timezone: 'Asia/Damascus', slot_minutes: 20, booking_window_days: 30, min_notice_hours: 2};

async function loadSchedule(db, doctorId) {
    const {rows: [schedule]} = await db.query('SELECT * FROM doctor_schedules WHERE doctor_id = $1', [doctorId]);
    const {rows: hours} = await db.query(
        `SELECT weekday, to_char(starts_at, 'HH24:MI') AS starts_at, to_char(ends_at, 'HH24:MI') AS ends_at
         FROM weekly_hours WHERE doctor_id = $1 ORDER BY weekday, starts_at`, [doctorId]);
    const {rows: timeOff} = await db.query(
        `SELECT id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on, note
         FROM time_off WHERE doctor_id = $1 AND ends_on >= (now() AT TIME ZONE $2)::date ORDER BY starts_on`,
        [doctorId, schedule?.timezone || DEFAULTS.timezone]);
    const settings = schedule ? {timezone: schedule.timezone, slot_minutes: schedule.slot_minutes,
        booking_window_days: schedule.booking_window_days, min_notice_hours: schedule.min_notice_hours} : {...DEFAULTS};
    return {settings, hours, timeOff, configured: Boolean(schedule)};
}

const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const validDate = d => typeof d === 'string' && new RegExp(DATE).test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().startsWith(d);

// Active bookings (requested or confirmed) block their time for everyone else.
export async function loadBusy(db, doctorId) {
    const {rows} = await db.query(
        `SELECT starts_at, ends_at FROM appointments
         WHERE doctor_id = $1 AND status IN ('requested', 'confirmed') AND ends_at > now()`, [doctorId]);
    return rows.map(r => ({starts_at: r.starts_at.getTime(), ends_at: r.ends_at.getTime()}));
}

export async function slotsFor(db, doctorId, query) {
    const data = await loadSchedule(db, doctorId);
    const today = localDate(Date.now(), data.settings.timezone);
    const from = query.from && validDate(query.from) && query.from >= today ? query.from : today;
    const days = Math.min(Math.max(Number(query.days) || 7, 1), 31);
    return {timezone: data.settings.timezone, slot_minutes: data.settings.slot_minutes, from, days,
        slots: freeSlots({schedule: data.settings, hours: data.hours, timeOff: data.timeOff, busy: await loadBusy(db, doctorId), from, days})};
}

const slotQuery = {querystring: {type: 'object', properties: {from: {type: 'string', pattern: DATE}, days: {type: 'integer', minimum: 1, maximum: 31}}}};

export default async function scheduleRoutes(app) {
    const doctorOnly = requireRole('doctor');
    const notSuspended = async request => {
        const {rows: [p]} = await app.pg.query('SELECT status FROM doctor_profiles WHERE user_id = $1', [request.user.id]);
        if (p?.status === 'suspended') throw new HttpError(403, 'suspended', 'Your profile is suspended. Please contact support.');
    };

    app.get('/api/doctor/schedule', {preHandler: doctorOnly}, async request => loadSchedule(app.pg, request.user.id));

    // Replaces settings and all weekly hours at once.
    app.post('/api/doctor/schedule', {preHandler: [doctorOnly, notSuspended], schema: {body: {
        type: 'object', required: ['slot_minutes', 'booking_window_days', 'min_notice_hours', 'hours'], additionalProperties: false,
        properties: {
            slot_minutes: {enum: [10, 15, 20, 30, 45, 60]},
            booking_window_days: {type: 'integer', minimum: 1, maximum: 90},
            min_notice_hours: {type: 'integer', minimum: 0, maximum: 72},
            hours: {type: 'array', maxItems: 21, items: {type: 'object', required: ['weekday', 'starts_at', 'ends_at'], additionalProperties: false,
                properties: {weekday: {type: 'integer'}, starts_at: {type: 'string', maxLength: 5}, ends_at: {type: 'string', maxLength: 5}}}}
        }
    }}}, async request => {
        const {slot_minutes, booking_window_days, min_notice_hours, hours} = request.body;
        const problem = hoursProblem(hours, slot_minutes);
        if (problem) throw new HttpError(400, problem, PROBLEMS[problem]);
        await transaction(app.pg, async db => {
            await db.query(
                `INSERT INTO doctor_schedules (doctor_id, slot_minutes, booking_window_days, min_notice_hours) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (doctor_id) DO UPDATE SET slot_minutes = $2, booking_window_days = $3, min_notice_hours = $4, updated_at = now()`,
                [request.user.id, slot_minutes, booking_window_days, min_notice_hours]);
            await db.query('DELETE FROM weekly_hours WHERE doctor_id = $1', [request.user.id]);
            for (const h of hours) {
                await db.query('INSERT INTO weekly_hours (doctor_id, weekday, starts_at, ends_at) VALUES ($1, $2, $3, $4)',
                    [request.user.id, h.weekday, h.starts_at, h.ends_at]);
            }
            await audit(db, {actorId: request.user.id, action: 'schedule.updated', targetId: request.user.id, details: {ranges: hours.length, slot_minutes}, ip: request.ip});
        });
        return loadSchedule(app.pg, request.user.id);
    });

    app.post('/api/doctor/time-off', {preHandler: [doctorOnly, notSuspended], schema: {body: {
        type: 'object', required: ['starts_on', 'ends_on'], additionalProperties: false,
        properties: {starts_on: {type: 'string', pattern: DATE}, ends_on: {type: 'string', pattern: DATE}, note: {type: 'string', maxLength: 200}}
    }}}, async (request, reply) => {
        const {starts_on, ends_on, note} = request.body;
        if (!validDate(starts_on) || !validDate(ends_on)) throw new HttpError(400, 'invalid_date', 'Enter a valid date.');
        if (ends_on < starts_on) throw new HttpError(400, 'end_before_start', 'The last day cannot be before the first day.');
        const {settings} = await loadSchedule(app.pg, request.user.id);
        const today = localDate(Date.now(), settings.timezone);
        if (ends_on < today) throw new HttpError(400, 'in_the_past', 'Days off must be today or later.');
        if (starts_on > addDays(today, 366)) throw new HttpError(400, 'too_far', 'Days off can be planned up to one year ahead.');
        await app.pg.query('INSERT INTO time_off (doctor_id, starts_on, ends_on, note) VALUES ($1, $2, $3, $4)',
            [request.user.id, starts_on, ends_on, note?.trim() || null]);
        reply.code(201);
        return loadSchedule(app.pg, request.user.id);
    });

    app.delete('/api/doctor/time-off/:id', {preHandler: doctorOnly, schema: {params: {type: 'object', properties: {id: {type: 'integer'}}}}}, async request => {
        const {rowCount} = await app.pg.query('DELETE FROM time_off WHERE id = $1 AND doctor_id = $2', [request.params.id, request.user.id]);
        if (!rowCount) throw new HttpError(404, 'not_found', 'Not found.');
        return loadSchedule(app.pg, request.user.id);
    });

    // The doctor's own preview of what patients will see.
    app.get('/api/doctor/slots', {preHandler: doctorOnly, schema: slotQuery}, async request =>
        slotsFor(app.pg, request.user.id, request.query));

    // Public: free slots of an approved doctor (used by booking in step 4).
    app.get('/api/doctors/:id/slots', {schema: {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}, ...slotQuery}}, async request => {
        const {rows: [doctor]} = await app.pg.query(
            `SELECT p.status FROM doctor_profiles p JOIN users u ON u.id = p.user_id
             WHERE p.user_id = $1 AND u.disabled_at IS NULL`, [request.params.id]);
        if (doctor?.status !== 'approved') throw new HttpError(404, 'not_found', 'Doctor not found.');
        return slotsFor(app.pg, request.params.id, request.query);
    });
}
