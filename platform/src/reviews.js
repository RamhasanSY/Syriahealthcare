// Reviews of doctors. Only a patient whose appointment the doctor marked as done can review it, once, within 60 days.
// Every review waits for an administrator before it is public; the doctor can answer publicly or report a review, which
// sends it back to the administrators. An average is only shown from 3 reviews on, so one opinion is not "the rating".
// Reviewers appear as "Patient" unless they choose to show their first name and initial.
import {HttpError, requireRole} from './auth.js';
import {audit} from './db.js';
import {pushToUser} from './push.js';

export const LIMITS = {days: 60, minForAverage: 3, comment: 500, reply: 500};
const UUID = {type: 'string', format: 'uuid'};
const idParam = {params: {type: 'object', properties: {id: UUID}}};

// "Lina N." from "Lina Nasser"; nothing else of the name is ever shown.
export const shortName = name => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    return parts.length > 1 ? `${parts[0]} ${[...parts.at(-1)][0]}.` : parts[0];
};
const publicView = r => ({id: r.id, rating: r.rating, comment: r.comment, author: r.show_name ? shortName(r.patient_name) : null,
    created_at: r.created_at, reply: r.reply, reply_at: r.reply_at});

// Count and average of the approved reviews, for one or many doctors.
export async function ratingSummaries(db, doctorIds) {
    if (!doctorIds.length) return new Map();
    const {rows} = await db.query(
        `SELECT doctor_id, count(*)::int AS count, round(avg(rating)::numeric, 1)::float AS average
         FROM doctor_reviews WHERE status = 'approved' AND doctor_id = ANY($1) GROUP BY doctor_id`, [doctorIds]);
    return new Map(rows.map(r => [r.doctor_id, {count: r.count, average: r.count >= LIMITS.minForAverage ? r.average : null}]));
}

export default async function reviewRoutes(app) {
    const patientOnly = requireRole('patient'), doctorOnly = requireRole('doctor'), adminOnly = requireRole('admin');
    const SELECT = `SELECT r.*, p.name AS patient_name, d.name AS doctor_name, a.starts_at
        FROM doctor_reviews r JOIN users p ON p.id = r.patient_id JOIN users d ON d.id = r.doctor_id JOIN appointments a ON a.id = r.appointment_id`;

    // ---- Patients ----

    app.get('/api/reviews/mine', {preHandler: patientOnly}, async request => {
        const {rows} = await app.pg.query('SELECT appointment_id, rating, status FROM doctor_reviews WHERE patient_id = $1', [request.user.id]);
        return {reviews: rows, days: LIMITS.days};
    });

    app.post('/api/appointments/:id/review', {preHandler: patientOnly, config: {rateLimit: {max: 10, timeWindow: '1 hour'}}, schema: {...idParam, body: {
        type: 'object', required: ['rating'], additionalProperties: false, properties: {
            rating: {type: 'integer', minimum: 1, maximum: 5}, comment: {type: 'string', maxLength: LIMITS.comment}, show_name: {type: 'boolean'}
        }}}}, async (request, reply) => {
        const {rows: [a]} = await app.pg.query(
            `SELECT id, doctor_id, status, ends_at FROM appointments WHERE id = $1 AND patient_id = $2`, [request.params.id, request.user.id]);
        if (!a) throw new HttpError(404, 'not_found', 'Appointment not found.');
        if (a.status !== 'completed') throw new HttpError(409, 'not_completed', 'You can review an appointment once the doctor marked it as done.');
        if (a.ends_at < new Date(Date.now() - LIMITS.days * 86400_000)) throw new HttpError(409, 'review_too_late', `Reviews are possible for ${LIMITS.days} days after the appointment.`);
        try {
            const {rows: [r]} = await app.pg.query(
                `INSERT INTO doctor_reviews (appointment_id, doctor_id, patient_id, rating, comment, show_name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, status`,
                [a.id, a.doctor_id, request.user.id, request.body.rating, request.body.comment?.trim() || null, Boolean(request.body.show_name)]);
            await audit(app.pg, {actorId: request.user.id, action: 'review.written', targetId: r.id, details: {doctor_id: a.doctor_id}, ip: request.ip});
            reply.code(201);
            return {review: r};
        } catch (error) {
            if (error.code === '23505') throw new HttpError(409, 'already_reviewed', 'You already reviewed this appointment.');
            throw error;
        }
    });

    // ---- Public ----

    app.get('/api/doctors/:id/reviews', {config: {cache: 'public, max-age=60'}, schema: idParam}, async request => {
        const {rows} = await app.pg.query(`${SELECT} WHERE r.doctor_id = $1 AND r.status = 'approved' ORDER BY r.created_at DESC LIMIT 50`, [request.params.id]);
        const summary = (await ratingSummaries(app.pg, [request.params.id])).get(request.params.id) || {count: 0, average: null};
        return {summary, reviews: rows.map(publicView)};
    });

    // ---- Doctors ----

    app.get('/api/doctor/reviews', {preHandler: doctorOnly}, async request => {
        const {rows} = await app.pg.query(`${SELECT} WHERE r.doctor_id = $1 AND r.status = 'approved' ORDER BY r.created_at DESC LIMIT 200`, [request.user.id]);
        const summary = (await ratingSummaries(app.pg, [request.user.id])).get(request.user.id) || {count: 0, average: null};
        return {summary, reviews: rows.map(publicView)};
    });

    app.post('/api/doctor/reviews/:id/reply', {preHandler: doctorOnly, schema: {...idParam, body: {type: 'object', required: ['reply'], additionalProperties: false,
        properties: {reply: {type: 'string', maxLength: LIMITS.reply}}}}}, async request => {
        const text = request.body.reply.trim() || null;
        const {rows: [r]} = await app.pg.query(
            `UPDATE doctor_reviews SET reply = $3, reply_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
             WHERE id = $1 AND doctor_id = $2 AND status = 'approved' RETURNING id, reply, reply_at`, [request.params.id, request.user.id, text]);
        if (!r) throw new HttpError(404, 'not_found', 'Review not found.');
        await audit(app.pg, {actorId: request.user.id, action: 'review.replied', targetId: r.id, ip: request.ip});
        return {review: r};
    });

    // A doctor who thinks a review breaks the rules sends it back to the administrators (it is hidden meanwhile).
    app.post('/api/doctor/reviews/:id/report', {preHandler: doctorOnly, schema: {...idParam, body: {type: 'object', required: ['reason'], additionalProperties: false,
        properties: {reason: {type: 'string', maxLength: 300}}}}}, async request => {
        const reason = request.body.reason.trim();
        if (reason.length < 5) throw new HttpError(400, 'note_required', 'Please write a short reason.');
        const {rows: [r]} = await app.pg.query(
            `UPDATE doctor_reviews SET status = 'pending', report_reason = $3, reported_at = now()
             WHERE id = $1 AND doctor_id = $2 AND status = 'approved' RETURNING id`, [request.params.id, request.user.id, reason]);
        if (!r) throw new HttpError(404, 'not_found', 'Review not found.');
        await audit(app.pg, {actorId: request.user.id, action: 'review.reported', targetId: r.id, details: {reason}, ip: request.ip});
        return {reported: true};
    });

    // ---- Administrators ----

    app.get('/api/admin/reviews', {preHandler: adminOnly, schema: {querystring: {type: 'object', additionalProperties: false, properties: {
        status: {enum: ['pending', 'approved', 'rejected']}}}}}, async request => {
        const status = request.query.status || 'pending';
        const {rows} = await app.pg.query(`${SELECT} WHERE r.status = $1 ORDER BY r.reported_at DESC NULLS LAST, r.created_at LIMIT 200`, [status]);
        return {status, reviews: rows.map(r => ({...publicView(r), patient_name: r.patient_name, doctor_id: r.doctor_id, doctor_name: r.doctor_name,
            appointment_at: r.starts_at, status: r.status, report_reason: r.report_reason, reported_at: r.reported_at, review_note: r.review_note}))};
    });

    for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
        app.post(`/api/admin/reviews/:id/${action}`, {preHandler: adminOnly, schema: {...idParam, body: {type: 'object', additionalProperties: false,
            properties: {note: {type: 'string', maxLength: 300}}}}}, async request => {
            const note = request.body?.note?.trim() || null;
            if (status === 'rejected' && !note) throw new HttpError(400, 'note_required', 'Please write a short reason.');
            const {rows: [r]} = await app.pg.query(
                `UPDATE doctor_reviews SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 AND status = 'pending'
                 RETURNING id, status, doctor_id, patient_id`, [request.params.id, status, note, request.user.id]);
            if (!r) throw new HttpError(409, 'wrong_status', 'This review has changed. Please reload.');
            await audit(app.pg, {actorId: request.user.id, action: `review.${status}`, targetId: r.id, details: note ? {note} : {}, ip: request.ip});
            if (status === 'approved') {
                await pushToUser(app, r.doctor_id, {title: ['New review', 'تقييم جديد'], body: ['A patient reviewed you. You can answer it.', 'قيّمك مريض. يمكنك الرد.'],
                    url: '/my-reviews', tag: 'reviews'});
            }
            return {review: {id: r.id, status: r.status}};
        });
    }
}
