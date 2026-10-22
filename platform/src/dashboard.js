// Doctor dashboard: incoming requests, upcoming and past appointments, and the decisions on them.
// Patients get an SMS when the doctor confirms, declines or cancels.
import {HttpError, requireRole} from './auth.js';
import {audit} from './db.js';

const TZ = 'Asia/Damascus';
const uuidParam = {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}};
// The note is checked in the handler, so a missing reason gets a clear message instead of a generic one.
const noteBody = {type: 'object', additionalProperties: false, properties: {note: {type: 'string', maxLength: 300}}};

// "2026-10-14 10:00": short and unambiguous in an SMS, whatever the phone's language.
const smsTime = date => new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(date).replace(',', '');

const MESSAGES = {
    confirmed: (a, when) => `تم تأكيد موعدك لدى ${a.doctor_name} في ${when}. العنوان: ${a.clinic_address}\nSyria Healthcare: appointment confirmed, ${when}.`,
    declined: (a, when) => `اعتذر ${a.doctor_name} عن موعد ${when}${a.status_note ? ': ' + a.status_note : ''}. يمكنك اختيار وقت آخر.\nSyria Healthcare: request for ${when} declined.`,
    cancelled_by_doctor: (a, when) => `ألغى ${a.doctor_name} موعدك في ${when}${a.status_note ? ': ' + a.status_note : ''}.\nSyria Healthcare: appointment on ${when} cancelled by the doctor.`
};

// Which change is allowed from which status, and whether the appointment must be in the future or have started.
const ACTIONS = {
    confirm: {from: 'requested', to: 'confirmed', when: 'future'},
    decline: {from: 'requested', to: 'declined', when: 'any'},
    cancel: {from: 'confirmed', to: 'cancelled_by_doctor', when: 'future', note: true},
    complete: {from: 'confirmed', to: 'completed', when: 'started'},
    'no-show': {from: 'confirmed', to: 'no_show', when: 'started'}
};

export default async function dashboardRoutes(app) {
    const doctorOnly = requireRole('doctor');

    app.get('/api/doctor/appointments', {preHandler: doctorOnly, schema: {querystring: {type: 'object', properties: {
        scope: {enum: ['requests', 'upcoming', 'past']}
    }}}}, async request => {
        const scope = request.query.scope || 'upcoming';
        const where = {
            requests: "a.status = 'requested' AND a.starts_at > now()",
            upcoming: "a.status = 'confirmed' AND a.ends_at > now() - interval '12 hours'",
            past: "(a.ends_at <= now() OR a.status NOT IN ('requested', 'confirmed')) AND a.starts_at > now() - interval '60 days'"
        }[scope];
        const order = scope === 'past' ? 'a.starts_at DESC' : 'a.starts_at';
        // Only this doctor's own patients, and only what is needed to see them.
        const {rows} = await app.pg.query(
            `SELECT a.id, a.status, a.starts_at, a.ends_at, a.reason, a.status_note, a.created_at, u.name AS patient_name, u.phone AS patient_phone
             FROM appointments a JOIN users u ON u.id = a.patient_id
             WHERE a.doctor_id = $1 AND ${where} ORDER BY ${order} LIMIT 300`, [request.user.id]);
        const {rows: [counts]} = await app.pg.query(
            `SELECT count(*) FILTER (WHERE status = 'requested' AND starts_at > now())::int AS requests,
                    count(*) FILTER (WHERE status = 'confirmed' AND ends_at > now())::int AS upcoming
             FROM appointments WHERE doctor_id = $1`, [request.user.id]);
        return {scope, appointments: rows, counts};
    });

    for (const [name, rule] of Object.entries(ACTIONS)) {
        app.post(`/api/doctor/appointments/:id/${name}`, {preHandler: doctorOnly, schema: {...uuidParam, body: noteBody}}, async request => {
            const note = request.body?.note?.trim().replace(/[.。]+$/, '') || null;  // SMS texts add their own full stop
            if (rule.note && (!note || note.length < 3)) throw new HttpError(400, 'note_required', 'Please write a short reason for the patient.');
            const timing = {future: 'AND a.starts_at > now()', started: 'AND a.starts_at <= now()', any: ''}[rule.when];
            const {rows: [updated]} = await app.pg.query(
                `UPDATE appointments a SET status = $3, status_note = COALESCE($4, a.status_note), updated_at = now()
                 WHERE a.id = $1 AND a.doctor_id = $2 AND a.status = $5 ${timing} RETURNING a.*`,
                [request.params.id, request.user.id, rule.to, note, rule.from]);
            if (!updated) {
                const {rows: [own]} = await app.pg.query('SELECT status, starts_at FROM appointments WHERE id = $1 AND doctor_id = $2', [request.params.id, request.user.id]);
                if (!own) throw new HttpError(404, 'not_found', 'Appointment not found.');
                if (rule.when === 'started' && own.status === rule.from) throw new HttpError(409, 'not_started', 'You can only mark an appointment after it has started.');
                throw new HttpError(409, 'wrong_status', 'This appointment has changed. Please reload.');
            }
            await audit(app.pg, {actorId: request.user.id, action: `appointment.${rule.to}`, targetId: updated.id, details: note ? {note} : {}, ip: request.ip});
            if (MESSAGES[rule.to]) await notifyPatient(app, request, updated);
            return {appointment: {id: updated.id, status: updated.status, status_note: updated.status_note}};
        });
    }
}

// The decision is already saved; a failed SMS is logged but does not undo it.
async function notifyPatient(app, request, appointment) {
    const {rows: [info]} = await app.pg.query(
        `SELECT p.phone, d.name AS doctor_name, dp.clinic_address FROM users p, users d, doctor_profiles dp
         WHERE p.id = $1 AND d.id = $2 AND dp.user_id = $2`, [appointment.patient_id, appointment.doctor_id]);
    if (!info?.phone) return;
    try {
        await app.sms.send(info.phone, MESSAGES[appointment.status]({...info, status_note: appointment.status_note}, smsTime(appointment.starts_at)));
    } catch (error) {
        request.log.error({err: error, appointment: appointment.id}, 'Patient SMS failed');
    }
}
