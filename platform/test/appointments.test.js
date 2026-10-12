import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, pool, setup, signIn, signInPatient, teardown} from './helpers.js';
import {addDays, localDate} from '../src/slots.js';

let app, sms, post;
beforeEach(async () => {
    await app?.close();
    ({app, sms, post} = await setup());
});
after(() => teardown(app));

const tomorrow = () => addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
const slotsOf = async (id, from = tomorrow(), days = 1) => (await app.inject({url: `/api/doctors/${id}/slots?from=${from}&days=${days}`})).json().slots;

describe('doctor directory', () => {
    test('lists only approved doctors, with public details only', async () => {
        await approvedDoctor(post);
        await signIn(post, 'doctor', 'pending@example.org', 'Dr. Pending');
        const res = await app.inject({url: '/api/doctors'});
        assert.equal(res.json().doctors.length, 1);
        const doctor = res.json().doctors[0];
        assert.equal(doctor.name, 'Dr. Approved');
        assert.equal(doctor.email, undefined);
        assert.equal(doctor.licence_number, undefined);
    });

    test('filters by specialty, governorate and name', async () => {
        await approvedDoctor(post);
        const count = async q => (await app.inject({url: '/api/doctors?' + q})).json().doctors.length;
        assert.equal(await count('specialty=cardiology'), 1);
        assert.equal(await count('specialty=pediatrics'), 0);
        assert.equal(await count('governorate=aleppo'), 0);
        assert.equal(await count('q=approv'), 1);
        assert.equal(await count('q=%25'), 0, 'wildcards are treated as text');
    });

    test('profile of an unapproved doctor is not public', async () => {
        await signIn(post, 'doctor', 'pending@example.org');
        const {rows: [{id}]} = await pool.query("SELECT id FROM users WHERE email = 'pending@example.org'");
        assert.equal((await app.inject({url: `/api/doctors/${id}`})).statusCode, 404);
    });
});

describe('booking', () => {
    test('a patient books a free slot, which then disappears for everyone', async () => {
        const {id} = await approvedDoctor(post);
        const patient = await signInPatient(post, sms, '0912345678', 'Lina');
        const [first] = await slotsOf(id);
        const res = await post('/api/appointments', {doctor_id: id, starts_at: first.starts_at, reason: 'Chest pain when climbing stairs'}, {cookie: patient});
        assert.equal(res.statusCode, 201);
        assert.equal(res.json().appointment.status, 'requested');
        assert.ok(!(await slotsOf(id)).some(s => s.starts_at === first.starts_at), 'the slot is no longer offered');
        const mine = (await app.inject({url: '/api/appointments/mine', headers: {cookie: patient}})).json().appointments;
        assert.equal(mine.length, 1);
        assert.equal(mine[0].doctor_name, 'Dr. Approved');
        assert.equal(mine[0].clinic_address, 'Mezzeh Highway 12');
        assert.equal(mine[0].reason, 'Chest pain when climbing stairs');
    });

    test('two patients booking the same slot at the same moment: only one wins', async () => {
        const {id} = await approvedDoctor(post);
        const a = await signInPatient(post, sms, '0911111111', 'Amal');
        const b = await signInPatient(post, sms, '0922222222', 'Basel');
        const [slot] = await slotsOf(id);
        const results = await Promise.all([a, b].map(cookie => post('/api/appointments', {doctor_id: id, starts_at: slot.starts_at}, {cookie})));
        assert.deepEqual(results.map(r => r.statusCode).sort(), [201, 409]);
        assert.equal(results.find(r => r.statusCode === 409).json().error, 'slot_taken');
        const {rows} = await pool.query("SELECT count(*)::int AS n FROM appointments WHERE status = 'requested'");
        assert.equal(rows[0].n, 1);
    });

    test('times outside the free slots are refused', async () => {
        const {id} = await approvedDoctor(post);
        const patient = await signInPatient(post, sms, '0912345678');
        const [slot] = await slotsOf(id);
        const offGrid = new Date(Date.parse(slot.starts_at) + 10 * 60000).toISOString();
        assert.equal((await post('/api/appointments', {doctor_id: id, starts_at: offGrid}, {cookie: patient})).json().error, 'slot_taken');
        const night = new Date(Date.parse(slot.starts_at) + 12 * 3600000).toISOString();
        assert.equal((await post('/api/appointments', {doctor_id: id, starts_at: night}, {cookie: patient})).statusCode, 409);
        assert.equal((await post('/api/appointments', {doctor_id: id, starts_at: '2020-01-01T06:00:00Z'}, {cookie: patient})).statusCode, 409);
    });

    test('a patient cannot be in two places at once', async () => {
        const one = await approvedDoctor(post, 'one@example.org', 'Dr. One');
        const two = await approvedDoctor(post, 'two@example.org', 'Dr. Two');
        const patient = await signInPatient(post, sms, '0912345678');
        const [slot] = await slotsOf(one.id);
        assert.equal((await post('/api/appointments', {doctor_id: one.id, starts_at: slot.starts_at}, {cookie: patient})).statusCode, 201);
        assert.equal((await post('/api/appointments', {doctor_id: two.id, starts_at: slot.starts_at}, {cookie: patient})).json().error, 'patient_busy');
    });

    test('limits: 2 upcoming with one doctor, 5 in total', async () => {
        const doctors = [];
        for (let i = 0; i < 4; i++) doctors.push(await approvedDoctor(post, `d${i}@example.org`, `Dr. ${i}`));
        const patient = await signInPatient(post, sms, '0912345678');
        const slots = await slotsOf(doctors[0].id, tomorrow(), 3);
        const book = (doctor, slot) => post('/api/appointments', {doctor_id: doctor.id, starts_at: slot.starts_at}, {cookie: patient});
        assert.equal((await book(doctors[0], slots[0])).statusCode, 201);
        assert.equal((await book(doctors[0], slots[1])).statusCode, 201);
        assert.equal((await book(doctors[0], slots[2])).json().error, 'too_many_with_doctor');
        assert.equal((await book(doctors[1], slots[3])).statusCode, 201);
        assert.equal((await book(doctors[2], slots[4])).statusCode, 201);
        assert.equal((await book(doctors[3], slots[5])).statusCode, 201);
        assert.equal((await book(doctors[3], slots[6])).json().error, 'too_many_active');
    });

    test('only signed-in patients can book; doctors cannot', async () => {
        const {id, cookie} = await approvedDoctor(post);
        const [slot] = await slotsOf(id);
        assert.equal((await post('/api/appointments', {doctor_id: id, starts_at: slot.starts_at})).statusCode, 401);
        assert.equal((await post('/api/appointments', {doctor_id: id, starts_at: slot.starts_at}, {cookie})).statusCode, 403);
    });

    test('suspended doctors cannot be booked', async () => {
        const {id} = await approvedDoctor(post);
        const patient = await signInPatient(post, sms, '0912345678');
        const [slot] = await slotsOf(id);
        await pool.query("UPDATE doctor_profiles SET status = 'suspended'");
        assert.equal((await post('/api/appointments', {doctor_id: id, starts_at: slot.starts_at}, {cookie: patient})).statusCode, 404);
    });
});

describe('cancelling', () => {
    test('patients cancel their own appointment, and the slot is free again', async () => {
        const {id} = await approvedDoctor(post);
        const patient = await signInPatient(post, sms, '0912345678');
        const [slot] = await slotsOf(id);
        const booked = (await post('/api/appointments', {doctor_id: id, starts_at: slot.starts_at}, {cookie: patient})).json().appointment;
        const other = await signInPatient(post, sms, '0933333333');
        assert.equal((await post(`/api/appointments/${booked.id}/cancel`, {}, {cookie: other})).statusCode, 404, 'not someone else\'s');
        const res = await post(`/api/appointments/${booked.id}/cancel`, {note: 'Feeling better'}, {cookie: patient});
        assert.equal(res.json().appointment.status, 'cancelled_by_patient');
        assert.ok((await slotsOf(id)).some(s => s.starts_at === slot.starts_at), 'the slot is offered again');
        assert.equal((await post(`/api/appointments/${booked.id}/cancel`, {}, {cookie: patient})).json().error, 'cannot_cancel');
    });

    test('past appointments cannot be cancelled', async () => {
        const {id} = await approvedDoctor(post);
        const patient = await signInPatient(post, sms, '0912345678');
        const {rows: [{id: patientId}]} = await pool.query("SELECT id FROM users WHERE role = 'patient'");
        const {rows: [past]} = await pool.query(
            "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at, status) VALUES ($1, $2, now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 'confirmed') RETURNING id",
            [id, patientId]);
        assert.equal((await post(`/api/appointments/${past.id}/cancel`, {}, {cookie: patient})).json().error, 'cannot_cancel');
    });
});
