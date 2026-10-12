// Public doctor directory and patient booking.
import {HttpError, requireRole} from './auth.js';
import {governorates, specialties} from './catalog.js';
import {audit} from './db.js';
import {slotsFor} from './schedule.js';
import {localDate} from './slots.js';

const MAX_ACTIVE = 5;             // upcoming requested/confirmed appointments per patient
const MAX_ACTIVE_PER_DOCTOR = 2;  // ...of which with the same doctor
const MAX_REQUESTS_PER_HOUR = 10;
const ACTIVE = "('requested', 'confirmed')";

// Only reviewed, public details: never email, licence number or documents.
const PUBLIC_DOCTOR = `u.id, u.name, p.specialty, p.governorate, p.area, p.clinic_name, p.clinic_address, p.clinic_phone, p.bio`;
const APPROVED = `p.status = 'approved' AND u.disabled_at IS NULL`;

const uuidParam = {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}};

export default async function appointmentRoutes(app) {
    const patientOnly = requireRole('patient');

    app.get('/api/doctors', {schema: {querystring: {type: 'object', properties: {
        specialty: {type: 'string', maxLength: 40}, governorate: {type: 'string', maxLength: 40}, q: {type: 'string', maxLength: 80}
    }}}}, async request => {
        const {specialty, governorate, q} = request.query;
        const where = [APPROVED], args = [];
        if (specialty && specialties[specialty]) where.push(`p.specialty = $${args.push(specialty)}`);
        if (governorate && governorates[governorate]) where.push(`p.governorate = $${args.push(governorate)}`);
        if (q?.trim()) where.push(`(u.name ILIKE $${args.push('%' + q.trim().replace(/[%_\\]/g, '\\$&') + '%')} OR p.clinic_name ILIKE $${args.length} OR p.area ILIKE $${args.length})`);
        const {rows} = await app.pg.query(
            `SELECT ${PUBLIC_DOCTOR} FROM users u JOIN doctor_profiles p ON p.user_id = u.id WHERE ${where.join(' AND ')} ORDER BY u.name LIMIT 200`, args);
        return {doctors: rows};
    });

    app.get('/api/doctors/:id', {schema: uuidParam}, async request => {
        const {rows: [doctor]} = await app.pg.query(
            `SELECT ${PUBLIC_DOCTOR}, COALESCE(s.slot_minutes, 20) AS slot_minutes
             FROM users u JOIN doctor_profiles p ON p.user_id = u.id LEFT JOIN doctor_schedules s ON s.doctor_id = u.id
             WHERE u.id = $1 AND ${APPROVED}`, [request.params.id]);
        if (!doctor) throw new HttpError(404, 'not_found', 'Doctor not found.');
        return {doctor};
    });

    app.post('/api/appointments', {
        preHandler: patientOnly,
        config: {rateLimit: {max: 30, timeWindow: '15 minutes'}},
        schema: {body: {type: 'object', required: ['doctor_id', 'starts_at'], additionalProperties: false, properties: {
            doctor_id: {type: 'string', format: 'uuid'}, starts_at: {type: 'string', format: 'date-time'}, reason: {type: 'string', maxLength: 300}
        }}}
    }, async (request, reply) => {
        const patientId = request.user.id, doctorId = request.body.doctor_id;
        const start = new Date(request.body.starts_at);
        if (Number.isNaN(start.getTime())) throw new HttpError(400, 'invalid_time', 'Choose a time from the list.');

        const {rows: [doctor]} = await app.pg.query(
            `SELECT u.id FROM users u JOIN doctor_profiles p ON p.user_id = u.id WHERE u.id = $1 AND ${APPROVED}`, [doctorId]);
        if (!doctor) throw new HttpError(404, 'not_found', 'Doctor not found.');

        const {rows: [counts]} = await app.pg.query(
            `SELECT count(*) FILTER (WHERE status IN ${ACTIVE} AND ends_at > now())::int AS active,
                    count(*) FILTER (WHERE status IN ${ACTIVE} AND ends_at > now() AND doctor_id = $2)::int AS with_doctor,
                    count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS last_hour
             FROM appointments WHERE patient_id = $1`, [patientId, doctorId]);
        if (counts.last_hour >= MAX_REQUESTS_PER_HOUR) throw new HttpError(429, 'too_many_bookings', 'Too many bookings in a short time. Please try again later.');
        if (counts.active >= MAX_ACTIVE) throw new HttpError(409, 'too_many_active', `You already have ${MAX_ACTIVE} upcoming appointments. Cancel one before booking another.`);
        if (counts.with_doctor >= MAX_ACTIVE_PER_DOCTOR) throw new HttpError(409, 'too_many_with_doctor', 'You already have upcoming appointments with this doctor.');

        // The time must be one of the doctor's free slots right now (opening hours, notice, window, days off, bookings).
        const available = await slotsFor(app.pg, doctorId, {from: localDate(start.getTime(), 'Asia/Damascus'), days: 1});
        const slot = available.slots.find(s => s.starts_at === start.toISOString());
        if (!slot) throw new HttpError(409, 'slot_taken', 'This time is no longer available. Please choose another.');

        let appointment;
        try {
            ({rows: [appointment]} = await app.pg.query(
                `INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [doctorId, patientId, slot.starts_at, slot.ends_at, request.body.reason?.trim() || null]));
        } catch (error) {
            // Someone else booked it a moment earlier, or the patient already has something at that time.
            if (error.code === '23P01' && error.constraint === 'no_double_booking_patient') throw new HttpError(409, 'patient_busy', 'You already have an appointment at this time.');
            if (error.code === '23P01') throw new HttpError(409, 'slot_taken', 'This time is no longer available. Please choose another.');
            throw error;
        }
        await audit(app.pg, {actorId: patientId, action: 'appointment.requested', targetId: appointment.id, details: {doctor_id: doctorId}, ip: request.ip});
        reply.code(201);
        return {appointment: {id: appointment.id, status: appointment.status, starts_at: appointment.starts_at, ends_at: appointment.ends_at}};
    });

    app.get('/api/appointments/mine', {preHandler: patientOnly}, async request => {
        const {rows} = await app.pg.query(
            `SELECT a.id, a.status, a.starts_at, a.ends_at, a.reason, a.status_note, a.created_at,
                    u.id AS doctor_id, u.name AS doctor_name, p.specialty, p.clinic_name, p.clinic_address, p.clinic_phone, p.area, p.governorate
             FROM appointments a JOIN users u ON u.id = a.doctor_id JOIN doctor_profiles p ON p.user_id = a.doctor_id
             WHERE a.patient_id = $1 ORDER BY a.starts_at DESC LIMIT 100`, [request.user.id]);
        return {appointments: rows};
    });

    app.post('/api/appointments/:id/cancel', {preHandler: patientOnly, schema: {...uuidParam,
        body: {type: 'object', additionalProperties: false, properties: {note: {type: 'string', maxLength: 300}}}}}, async request => {
        const {rows: [appointment]} = await app.pg.query(
            `UPDATE appointments SET status = 'cancelled_by_patient', status_note = $3, updated_at = now()
             WHERE id = $1 AND patient_id = $2 AND status IN ${ACTIVE} AND starts_at > now() RETURNING id, status`,
            [request.params.id, request.user.id, request.body?.note?.trim() || null]);
        if (!appointment) {
            const {rows: [exists]} = await app.pg.query('SELECT 1 FROM appointments WHERE id = $1 AND patient_id = $2', [request.params.id, request.user.id]);
            if (!exists) throw new HttpError(404, 'not_found', 'Appointment not found.');
            throw new HttpError(409, 'cannot_cancel', 'This appointment can no longer be cancelled.');
        }
        await audit(app.pg, {actorId: request.user.id, action: 'appointment.cancelled_by_patient', targetId: appointment.id, ip: request.ip});
        return {appointment};
    });
}
