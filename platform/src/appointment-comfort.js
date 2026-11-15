// Appointment comfort: a reminder before the appointment, a calendar file, moving an appointment to another free time,
// and a waiting list that tells patients when a time with a doctor becomes free.
//
// Reminders go out once, between 24 and 2 hours before a confirmed appointment: a notification on the phone (src/push.js),
// an email through the queue (src/outbox.js) and a text message where a gateway is configured.
// The waiting list: a patient asks to be told; when someone cancels or a doctor declines, everyone waiting for that doctor
// hears about it (at most once every 6 hours). Whoever books first gets the time.
import {HttpError, requireRole} from './auth.js';
import {audit} from './db.js';
import {sendAppointmentUpdate, whatsappReaches} from './messaging.js';
import {enqueueEmail} from './outbox.js';
import {pushToUser} from './push.js';
import {slotsFor} from './schedule.js';
import {BOOKING_DAYS_AFTER} from './sharing.js';
import {localDate} from './slots.js';

const TZ = 'Asia/Damascus';
const ACTIVE = "('requested', 'confirmed')";
export const LIMITS = {reschedules: 3, waitlistDoctors: 3, waitlistDays: 30, waitlistQuietHours: 6, reminderHours: [2, 24]};
const uuidParam = {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}};

// "2026-11-12 10:00", the same in every language.
export const shortTime = date => new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(date)).replace(',', '');
const both = (language, en, ar) => language === 'en' ? `${en}\n\n— — —\n\n${ar}` : `${ar}\n\n— — —\n\n${en}`;

// ---- Reminders (run by src/jobs.js every 10 minutes) ----

export async function sendAppointmentReminders(app) {
    const [soonest, latest] = LIMITS.reminderHours;
    // Claimed in one statement, so two servers or two runs never remind twice.
    const {rows} = await app.pg.query(
        `UPDATE appointments SET reminder_sent_at = now() WHERE id IN (
             SELECT id FROM appointments WHERE status = 'confirmed' AND reminder_sent_at IS NULL
                AND starts_at > now() + make_interval(hours => $1) AND starts_at <= now() + make_interval(hours => $2)
             ORDER BY starts_at LIMIT 200 FOR UPDATE SKIP LOCKED)
         RETURNING id, patient_id, doctor_id, starts_at, mode`, [soonest, latest]);
    for (const a of rows) {
        try {
            const {rows: [info]} = await app.pg.query(
                `SELECT p.name, p.phone, p.email, p.language, d.name AS doctor_name, dp.clinic_name, dp.clinic_address
                 FROM users p, users d, doctor_profiles dp WHERE p.id = $1 AND d.id = $2 AND dp.user_id = $2 AND p.disabled_at IS NULL`,
                [a.patient_id, a.doctor_id]);
            if (!info) continue;
            const video = a.mode === 'video' ? `${app.config.appOrigin}/video?id=${a.id}` : null;
            const when = shortTime(a.starts_at), place = video || [info.clinic_name, info.clinic_address].filter(Boolean).join(', ');
            await pushToUser(app, a.patient_id, {title: ['Appointment reminder', 'تذكير بموعدك'],
                body: ['You have an appointment within 24 hours.', 'لديك موعد خلال 24 ساعة.'], url: '/appointments', tag: `appointment-${a.id}`});
            if (info.email) {
                await enqueueEmail(app.pg, {to: info.email,
                    subject: info.language === 'en' ? `Reminder: appointment on ${when} — SyriaHC` : `تذكير: موعدك في ${when} — صحة تك`,
                    text: both(info.language,
                        `Reminder: your appointment with ${info.doctor_name} is on ${when} (Syria time).\n${video ? 'Video call' : 'Address'}: ${place}\n\nCannot come? Please cancel or move it, so another patient can have the time: ${app.config.appOrigin}/appointments`,
                        `تذكير: موعدك لدى ${info.doctor_name} في ${when} (بتوقيت سوريا).\n${video ? 'مكالمة فيديو' : 'العنوان'}: ${place}\n\nلا تستطيع الحضور؟ يرجى إلغاء الموعد أو نقله ليستفيد مريض آخر من الوقت: ${app.config.appOrigin}/appointments`)});
            }
            if (info.phone && (app.sms.available !== false || whatsappReaches(app, info.phone))) {
                await sendAppointmentUpdate(app, {log: app.log}, info.phone, {status: 'reminder', language: info.language,
                    params: [info.doctor_name, when, place || '-'],
                    smsText: `تذكير: موعدك لدى ${info.doctor_name} في ${when}. العنوان: ${place}\nSyriaHC reminder: appointment ${when}.`});
            }
        } catch (error) {
            app.log.error({err: error, appointment: a.id}, 'Appointment reminder failed');
        }
    }
    return rows.length;
}

// ---- Waiting list ----

// Called when a time of a doctor becomes free (cancelled, declined, moved). Never throws.
export async function notifyWaitlist(app, doctorId, freedStart) {
    try {
        if (new Date(freedStart).getTime() < Date.now() + 60 * 60_000) return 0;  // too soon to be of use
        const {rows: [doctor]} = await app.pg.query('SELECT name FROM users WHERE id = $1', [doctorId]);
        const {rows} = await app.pg.query(
            `UPDATE waitlist_entries w SET notified_at = now() FROM users u
             WHERE w.doctor_id = $1 AND w.expires_at > now() AND u.id = w.patient_id AND u.disabled_at IS NULL
               AND (w.notified_at IS NULL OR w.notified_at < now() - make_interval(hours => $2))
             RETURNING w.id, w.patient_id, u.email, u.language`, [doctorId, LIMITS.waitlistQuietHours]);
        const link = `${app.config.appOrigin}/book?doctor=${doctorId}`, when = shortTime(freedStart);
        for (const entry of rows) {
            await pushToUser(app, entry.patient_id, {title: ['A time became free', 'أصبح موعد متاحاً'],
                body: ['A doctor you are waiting for has a free time. Book it before someone else does.', 'لدى طبيب تنتظره وقت متاح. احجزه قبل غيرك.'],
                url: `/book?doctor=${doctorId}`, tag: `waitlist-${doctorId}`, urgency: 'high'});
            if (entry.email) {
                await enqueueEmail(app.pg, {to: entry.email,
                    subject: entry.language === 'en' ? 'A time became free — SyriaHC' : 'أصبح موعد متاحاً — صحة تك',
                    text: both(entry.language,
                        `A time with ${doctor.name} became free: ${when} (Syria time). Whoever books first gets it:\n${link}\n\nYou get this because you joined the waiting list. To stop, remove it under My appointments: ${app.config.appOrigin}/appointments`,
                        `أصبح وقت لدى ${doctor.name} متاحاً: ${when} (بتوقيت سوريا). يحصل عليه من يحجز أولاً:\n${link}\n\nتصلك هذه الرسالة لأنك انضممت إلى قائمة الانتظار. لإيقافها احذفها من «مواعيدي»: ${app.config.appOrigin}/appointments`)});
            }
        }
        return rows.length;
    } catch (error) {
        app.log.error({err: error}, 'Waiting list notification failed');
        return 0;
    }
}

// ---- Calendar file (RFC 5545) ----

const icsText = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = date => new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Lines longer than 75 bytes continue on the next line after a space, never inside a UTF-8 character.
export function foldLine(line) {
    const parts = [];
    let current = '', bytes = 0;
    for (const char of line) {
        const size = Buffer.byteLength(char);
        if (bytes + size > (parts.length ? 74 : 75)) {
            parts.push(current);
            current = '';
            bytes = 0;
        }
        current += char;
        bytes += size;
    }
    parts.push(current);
    return parts.join('\r\n ');
}

export function calendarFile(a, {forDoctor, origin}) {
    const summary = forDoctor ? `SyriaHC: ${a.patient_name}` : `${a.doctor_name} (SyriaHC)`;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SyriaHC//Appointments//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
        `UID:${a.id}@syriahc.com`, `DTSTAMP:${icsTime(Date.now())}`, `DTSTART:${icsTime(a.starts_at)}`, `DTEND:${icsTime(a.ends_at)}`,
        `SUMMARY:${icsText(summary)}`, `LOCATION:${icsText([a.clinic_name, a.clinic_address].filter(Boolean).join(', '))}`,
        `DESCRIPTION:${icsText(forDoctor ? `${origin}/dashboard` : `${a.clinic_phone ? a.clinic_phone + '\n' : ''}${origin}/appointments`)}`,
        `STATUS:${a.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`,
        'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(summary)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'];
    return lines.map(foldLine).join('\r\n') + '\r\n';
}

export default async function appointmentComfortRoutes(app) {
    const patientOnly = requireRole('patient');

    app.get('/api/appointments/:id/calendar.ics', {preHandler: requireRole('patient', 'doctor'), schema: uuidParam}, async (request, reply) => {
        const {rows: [a]} = await app.pg.query(
            `SELECT a.*, d.name AS doctor_name, p.name AS patient_name, dp.clinic_name, dp.clinic_address, dp.clinic_phone
             FROM appointments a JOIN users d ON d.id = a.doctor_id JOIN users p ON p.id = a.patient_id JOIN doctor_profiles dp ON dp.user_id = a.doctor_id
             WHERE a.id = $1 AND (a.patient_id = $2 OR a.doctor_id = $2) AND a.status IN ${ACTIVE}`, [request.params.id, request.user.id]);
        if (!a) throw new HttpError(404, 'not_found', 'Appointment not found.');
        reply.header('Content-Type', 'text/calendar; charset=utf-8');
        reply.header('Content-Disposition', 'attachment; filename="syriahc-appointment.ics"');
        return calendarFile(a, {forDoctor: a.doctor_id === request.user.id, origin: app.config.appOrigin});
    });

    // Moving an appointment: another free time with the same doctor. The doctor confirms the new time again.
    app.post('/api/appointments/:id/reschedule', {preHandler: patientOnly, config: {rateLimit: {max: 20, timeWindow: '15 minutes'}},
        schema: {...uuidParam, body: {type: 'object', required: ['starts_at'], additionalProperties: false, properties: {starts_at: {type: 'string', format: 'date-time'}}}}},
        async request => {
            const {rows: [current]} = await app.pg.query('SELECT * FROM appointments WHERE id = $1 AND patient_id = $2', [request.params.id, request.user.id]);
            if (!current) throw new HttpError(404, 'not_found', 'Appointment not found.');
            if (!['requested', 'confirmed'].includes(current.status) || current.starts_at <= new Date()) {
                throw new HttpError(409, 'cannot_reschedule', 'This appointment can no longer be moved.');
            }
            if (current.reschedule_count >= LIMITS.reschedules) {
                throw new HttpError(409, 'too_many_reschedules', `An appointment can be moved ${LIMITS.reschedules} times. Cancel it and book a new one.`);
            }
            const start = new Date(request.body.starts_at);
            if (Number.isNaN(start.getTime()) || start.getTime() === current.starts_at.getTime()) throw new HttpError(400, 'invalid_time', 'Choose a time from the list.');
            const available = await slotsFor(app.pg, current.doctor_id, {from: localDate(start.getTime(), TZ), days: 1});
            const slot = available.slots.find(s => s.starts_at === start.toISOString());
            if (!slot) throw new HttpError(409, 'slot_taken', 'This time is no longer available. Please choose another.');
            let moved;
            try {
                ({rows: [moved]} = await app.pg.query(
                    `UPDATE appointments SET starts_at = $3, ends_at = $4, status = 'requested', status_note = NULL, reminder_sent_at = NULL,
                         reschedule_count = reschedule_count + 1, updated_at = now()
                     WHERE id = $1 AND patient_id = $2 AND status IN ${ACTIVE} AND starts_at > now() RETURNING *`,
                    [current.id, request.user.id, slot.starts_at, slot.ends_at]));
            } catch (error) {
                if (error.code === '23P01' && error.constraint === 'no_double_booking_patient') throw new HttpError(409, 'patient_busy', 'You already have an appointment at this time.');
                if (error.code === '23P01') throw new HttpError(409, 'slot_taken', 'This time is no longer available. Please choose another.');
                throw error;
            }
            if (!moved) throw new HttpError(409, 'cannot_reschedule', 'This appointment can no longer be moved.');
            // A share made when booking keeps running until 30 days after the new time.
            await app.pg.query('UPDATE access_grants SET expires_at = $2 WHERE appointment_id = $1 AND revoked_at IS NULL',
                [moved.id, new Date(moved.ends_at.getTime() + BOOKING_DAYS_AFTER * 86400_000)]);
            await audit(app.pg, {actorId: request.user.id, action: 'appointment.rescheduled', targetId: moved.id,
                details: {from: current.starts_at.toISOString(), to: moved.starts_at.toISOString()}, ip: request.ip});
            await pushToUser(app, moved.doctor_id, {title: ['A patient moved an appointment', 'نقل مريض موعده'],
                body: ['Open your appointments to confirm the new time.', 'افتح المواعيد لتأكيد الوقت الجديد.'], url: '/dashboard', tag: 'requests'});
            await notifyWaitlist(app, current.doctor_id, current.starts_at);
            return {appointment: {id: moved.id, status: moved.status, starts_at: moved.starts_at, ends_at: moved.ends_at, reschedule_count: moved.reschedule_count}};
        });

    app.post('/api/waitlist', {preHandler: patientOnly, config: {rateLimit: {max: 20, timeWindow: '15 minutes'}},
        schema: {body: {type: 'object', required: ['doctor_id'], additionalProperties: false, properties: {doctor_id: {type: 'string', format: 'uuid'}}}}},
        async (request, reply) => {
            const {rows: [doctor]} = await app.pg.query(
                `SELECT u.id FROM users u JOIN doctor_profiles p ON p.user_id = u.id WHERE u.id = $1 AND p.status = 'approved' AND u.disabled_at IS NULL`,
                [request.body.doctor_id]);
            if (!doctor) throw new HttpError(404, 'not_found', 'Doctor not found.');
            const {rows: [{n}]} = await app.pg.query(
                'SELECT count(*)::int AS n FROM waitlist_entries WHERE patient_id = $1 AND doctor_id <> $2 AND expires_at > now()', [request.user.id, doctor.id]);
            if (n >= LIMITS.waitlistDoctors) throw new HttpError(409, 'too_many_waitlist', `You can wait for at most ${LIMITS.waitlistDoctors} doctors at a time.`);
            const {rows: [entry]} = await app.pg.query(
                `INSERT INTO waitlist_entries (patient_id, doctor_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))
                 ON CONFLICT (patient_id, doctor_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, notified_at = NULL
                 RETURNING id, doctor_id, created_at, expires_at`, [request.user.id, doctor.id, LIMITS.waitlistDays]);
            reply.code(201);
            return {entry};
        });

    app.get('/api/waitlist/mine', {preHandler: patientOnly}, async request => {
        const {rows} = await app.pg.query(
            `SELECT w.id, w.doctor_id, w.created_at, w.expires_at, w.notified_at, u.name AS doctor_name, p.specialty
             FROM waitlist_entries w JOIN users u ON u.id = w.doctor_id JOIN doctor_profiles p ON p.user_id = w.doctor_id
             WHERE w.patient_id = $1 AND w.expires_at > now() ORDER BY w.created_at`, [request.user.id]);
        return {entries: rows};
    });

    app.post('/api/waitlist/:id/leave', {preHandler: patientOnly, schema: uuidParam}, async request => {
        const {rowCount} = await app.pg.query('DELETE FROM waitlist_entries WHERE id = $1 AND patient_id = $2', [request.params.id, request.user.id]);
        if (!rowCount) throw new HttpError(404, 'not_found', 'Not found.');
        return {left: true};
    });
}
