import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, config, origin, pool, setup, signInPatient, teardown} from './helpers.js';
import {buildApp} from '../src/app.js';
import {addDays, localDate} from '../src/slots.js';

let app, sms, post;
beforeEach(async () => {
    await app?.close();
    ({app, sms, post} = await setup());
});
after(() => teardown(app));

const tomorrow = () => addDays(localDate(Date.now(), 'Asia/Damascus'), 1);

// A doctor with one requested appointment from a patient.
async function requested() {
    const doctor = await approvedDoctor(post, 'dr@example.org', 'Dr. Sara Haddad');
    const patient = await signInPatient(post, sms, '0912345678', 'Lina Patient');
    const [slot] = (await app.inject({url: `/api/doctors/${doctor.id}/slots?from=${tomorrow()}&days=1`})).json().slots;
    const res = await post('/api/appointments', {doctor_id: doctor.id, starts_at: slot.starts_at, reason: 'Cough'}, {cookie: patient});
    return {doctor, patient, slot, id: res.json().appointment.id};
}
const list = (cookie, scope) => app.inject({url: '/api/doctor/appointments?scope=' + scope, headers: {cookie}}).then(r => r.json());
const act = (cookie, id, action, body = {}) => post(`/api/doctor/appointments/${id}/${action}`, body, {cookie});
const smsTo = phone => sms.sent.filter(m => m.to === phone && !/sign-in code/.test(m.message));

describe('doctor dashboard', () => {
    test('doctor sees requests from their own patients with name, phone and reason', async () => {
        const {doctor} = await requested();
        const view = await list(doctor.cookie, 'requests');
        assert.equal(view.counts.requests, 1);
        assert.equal(view.appointments[0].patient_name, 'Lina Patient');
        assert.equal(view.appointments[0].patient_phone, '+963912345678');
        assert.equal(view.appointments[0].reason, 'Cough');
        const other = await approvedDoctor(post, 'other@example.org', 'Dr. Other');
        assert.equal((await list(other.cookie, 'requests')).appointments.length, 0, 'other doctors see nothing');
    });

    test('confirming moves it to upcoming and texts the patient', async () => {
        const {doctor, patient, id, slot} = await requested();
        const res = await act(doctor.cookie, id, 'confirm');
        assert.equal(res.json().appointment.status, 'confirmed');
        assert.equal((await list(doctor.cookie, 'requests')).appointments.length, 0);
        assert.equal((await list(doctor.cookie, 'upcoming')).appointments.length, 1);
        const [message] = smsTo('+963912345678');
        assert.match(message.message, /تم تأكيد موعدك لدى Dr\. Sara Haddad/);
        assert.match(message.message, new RegExp(`${slot.date} ${slot.time}`), 'date and time in Syria time');
        assert.match(message.message, /Mezzeh Highway 12/, 'includes the clinic address');
        const mine = (await app.inject({url: '/api/appointments/mine', headers: {cookie: patient}})).json().appointments;
        assert.equal(mine[0].status, 'confirmed');
        assert.equal((await act(doctor.cookie, id, 'confirm')).json().error, 'wrong_status', 'cannot confirm twice');
    });

    test('declining frees the time and tells the patient', async () => {
        const {doctor, id, slot} = await requested();
        await act(doctor.cookie, id, 'decline', {note: 'I am away that morning.'});
        assert.match(smsTo('+963912345678')[0].message, /اعتذر/);
        assert.match(smsTo('+963912345678')[0].message, /I am away that morning/, 'includes the doctor\'s message');
        const slots = (await app.inject({url: `/api/doctors/${doctor.id}/slots?from=${tomorrow()}&days=1`})).json().slots;
        assert.ok(slots.some(s => s.starts_at === slot.starts_at));
    });

    test('cancelling a confirmed appointment needs a reason, which the patient receives', async () => {
        const {doctor, id} = await requested();
        await act(doctor.cookie, id, 'confirm');
        assert.equal((await act(doctor.cookie, id, 'cancel')).json().error, 'note_required');
        assert.equal((await act(doctor.cookie, id, 'cancel', {note: 'x'})).json().error, 'note_required');
        assert.equal((await act(doctor.cookie, id, 'cancel', {note: 'Clinic closed for repairs'})).json().appointment.status, 'cancelled_by_doctor');
        assert.match(smsTo('+963912345678').at(-1).message, /Clinic closed for repairs/);
        assert.equal((await list(doctor.cookie, 'past')).appointments[0].status, 'cancelled_by_doctor');
    });

    test('done / missed only after the appointment has started', async () => {
        const {doctor, id} = await requested();
        await act(doctor.cookie, id, 'confirm');
        assert.equal((await act(doctor.cookie, id, 'complete')).json().error, 'not_started');
        const {rows: [{id: patientId}]} = await pool.query("SELECT id FROM users WHERE role = 'patient'");
        const {rows: [earlier]} = await pool.query(
            `INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at, status)
             VALUES ($1, $2, now() - interval '1 hour', now() - interval '30 minutes', 'confirmed') RETURNING id`, [doctor.id, patientId]);
        assert.equal((await act(doctor.cookie, earlier.id, 'complete')).json().appointment.status, 'completed');
        const {rows: [missed]} = await pool.query(
            `INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at, status)
             VALUES ($1, $2, now() - interval '3 hours', now() - interval '150 minutes', 'confirmed') RETURNING id`, [doctor.id, patientId]);
        assert.equal((await act(doctor.cookie, missed.id, 'no-show')).json().appointment.status, 'no_show');
        assert.equal(smsTo('+963912345678').length, 1, 'only the confirmation was texted');
    });

    test('patients and other doctors cannot act on the appointment', async () => {
        const {patient, id} = await requested();
        assert.equal((await act(patient, id, 'confirm')).statusCode, 403);
        const other = await approvedDoctor(post, 'other@example.org', 'Dr. Other');
        assert.equal((await act(other.cookie, id, 'confirm')).statusCode, 404);
        assert.equal((await post(`/api/doctor/appointments/${id}/confirm`, {})).statusCode, 401);
    });

    test('a failed SMS does not undo the confirmation', async () => {
        const {doctor, id} = await requested();
        const broken = await buildApp({config, pool, sms: {send: async () => { throw new Error('gateway down'); }}, logger: false});
        const res = await broken.inject({method: 'POST', url: `/api/doctor/appointments/${id}/confirm`, payload: {}, headers: {origin, cookie: doctor.cookie}});
        assert.equal(res.json().appointment.status, 'confirmed');
        await broken.close();
    });
});
