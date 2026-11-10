import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, pool, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';
import {shortName} from '../src/reviews.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});

// A completed appointment `daysAgo` days ago (straight in the database: the doctor marks it done after it happened).
async function visit(doctorId, email, name, {daysAgo = 2, status = 'completed'} = {}) {
    const cookie = await signInPatientByEmail(post, mail, email, name);
    const {rows: [{id: patientId}]} = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    const {rows: [a]} = await pool.query(
        `INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at, status)
         VALUES ($1, $2, now() - make_interval(days => $3), now() - make_interval(days => $3) + interval '30 minutes', $4) RETURNING id`,
        [doctorId, patientId, daysAgo, status]);
    return {cookie, appointmentId: a.id};
}

describe('reviews', () => {
    test('a patient reviews a completed visit; it is public after an administrator checks it; the average shows from 3 reviews', async () => {
        const doctor = await approvedDoctor(post);
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const lina = await visit(doctor.id, 'lina@example.org', 'Lina Nasser');
        const res = await post(`/api/appointments/${lina.appointmentId}/review`, {rating: 5, comment: 'Took time to explain everything.', show_name: true}, {cookie: lina.cookie});
        assert.equal(res.statusCode, 201, res.body);
        assert.equal(res.json().review.status, 'pending');
        assert.equal((await post(`/api/appointments/${lina.appointmentId}/review`, {rating: 1}, {cookie: lina.cookie})).json().error, 'already_reviewed');
        assert.equal((await get(`/api/doctors/${doctor.id}/reviews`)).json().reviews.length, 0, 'not public before the check');

        const pending = (await get('/api/admin/reviews', admin)).json().reviews;
        assert.equal(pending.length, 1);
        assert.equal(pending[0].patient_name, 'Lina Nasser', 'the administrator sees who wrote it');
        await post(`/api/admin/reviews/${pending[0].id}/approve`, {}, {cookie: admin});
        const pub = (await get(`/api/doctors/${doctor.id}/reviews`)).json();
        assert.deepEqual(pub.reviews.map(r => [r.rating, r.author, r.comment]), [[5, 'Lina N.', 'Took time to explain everything.']]);
        assert.deepEqual(pub.summary, {count: 1, average: null}, 'no average from one review');
        assert.doesNotMatch(JSON.stringify(pub), /Nasser|lina@example\.org/);

        for (const [email, name, stars] of [['o@example.org', 'Omar Haddad', 4], ['s@example.org', 'Sara Ali', 3]]) {
            const p = await visit(doctor.id, email, name);
            await post(`/api/appointments/${p.appointmentId}/review`, {rating: stars}, {cookie: p.cookie});
        }
        for (const r of (await get('/api/admin/reviews', admin)).json().reviews) await post(`/api/admin/reviews/${r.id}/approve`, {}, {cookie: admin});
        const three = (await get(`/api/doctors/${doctor.id}/reviews`)).json();
        assert.deepEqual(three.summary, {count: 3, average: 4});
        assert.equal(three.reviews.filter(r => r.author === null).length, 2, 'shown as "Patient" unless chosen');
        assert.deepEqual((await get(`/api/doctors/${doctor.id}`)).json().doctor.rating, {count: 3, average: 4});
        assert.deepEqual((await get('/api/doctors')).json().doctors.find(d => d.id === doctor.id).rating, {count: 3, average: 4});
    });

    test('only completed visits of the last 60 days, only by their patient', async () => {
        const doctor = await approvedDoctor(post);
        const confirmed = await visit(doctor.id, 'a@example.org', 'Amal Saleh', {status: 'confirmed'});
        assert.equal((await post(`/api/appointments/${confirmed.appointmentId}/review`, {rating: 4}, {cookie: confirmed.cookie})).json().error, 'not_completed');
        const old = await visit(doctor.id, 'b@example.org', 'Basel Saleh', {daysAgo: 61});
        assert.equal((await post(`/api/appointments/${old.appointmentId}/review`, {rating: 4}, {cookie: old.cookie})).json().error, 'review_too_late');
        const fine = await visit(doctor.id, 'c@example.org', 'Celine Saleh');
        assert.equal((await post(`/api/appointments/${fine.appointmentId}/review`, {rating: 4}, {cookie: confirmed.cookie})).statusCode, 404, 'not her appointment');
        assert.equal((await post(`/api/appointments/${fine.appointmentId}/review`, {rating: 6}, {cookie: fine.cookie})).statusCode, 400);
        assert.equal((await post(`/api/appointments/${fine.appointmentId}/review`, {rating: 4}, {cookie: doctor.cookie})).statusCode, 403);
        assert.deepEqual((await get('/api/reviews/mine', fine.cookie)).json().reviews, []);
    });

    test('the doctor answers publicly or reports a review, which hides it until checked again; rejecting needs a reason', async () => {
        const doctor = await approvedDoctor(post);
        const other = await approvedDoctor(post, 'dr2@example.org', 'Dr. Other');
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const lina = await visit(doctor.id, 'lina@example.org', 'Lina Nasser');
        await post(`/api/appointments/${lina.appointmentId}/review`, {rating: 2, comment: 'Waited two hours.'}, {cookie: lina.cookie});
        const [r] = (await get('/api/admin/reviews', admin)).json().reviews;
        assert.equal((await post(`/api/admin/reviews/${r.id}/reject`, {}, {cookie: admin})).json().error, 'note_required');
        await post(`/api/admin/reviews/${r.id}/approve`, {}, {cookie: admin});

        assert.equal((await post(`/api/doctor/reviews/${r.id}/reply`, {reply: 'Sorry'}, {cookie: other.cookie})).statusCode, 404);
        await post(`/api/doctor/reviews/${r.id}/reply`, {reply: 'We are sorry; we now book fewer patients per hour.'}, {cookie: doctor.cookie});
        assert.equal((await get(`/api/doctors/${doctor.id}/reviews`)).json().reviews[0].reply, 'We are sorry; we now book fewer patients per hour.');
        assert.equal((await get('/api/doctor/reviews', doctor.cookie)).json().reviews.length, 1);

        assert.equal((await post(`/api/doctor/reviews/${r.id}/report`, {reason: 'x'}, {cookie: doctor.cookie})).json().error, 'note_required');
        assert.equal((await post(`/api/doctor/reviews/${r.id}/report`, {reason: 'The patient never came to this clinic.'}, {cookie: doctor.cookie})).json().reported, true);
        assert.equal((await get(`/api/doctors/${doctor.id}/reviews`)).json().reviews.length, 0, 'hidden while checked again');
        const [again] = (await get('/api/admin/reviews', admin)).json().reviews;
        assert.equal(again.report_reason, 'The patient never came to this clinic.');
        assert.equal((await post(`/api/admin/reviews/${r.id}/reject`, {note: 'No visit on record.'}, {cookie: admin})).json().review.status, 'rejected');
        assert.equal((await get('/api/reviews/mine', lina.cookie)).json().reviews[0].status, 'rejected');
        assert.equal((await post(`/api/admin/reviews/${r.id}/approve`, {}, {cookie: admin})).json().error, 'wrong_status');
        assert.equal((await get('/api/admin/reviews', lina.cookie)).statusCode, 403);
    });

    test('names are shortened to first name and initial', () => {
        assert.equal(shortName('Lina Nasser'), 'Lina N.');
        assert.equal(shortName('محمد علي الحسن'), 'محمد ا.');
        assert.equal(shortName('Omar'), 'Omar');
        assert.equal(shortName('  '), null);
    });
});
