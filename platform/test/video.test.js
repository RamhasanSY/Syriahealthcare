import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {approvedDoctor, confirmSession, pool, setup, signInPatientByEmail, teardown} from './helpers.js';
import {createRooms} from '../src/video.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
    app.config.video.enabled = true;
});
after(async () => {
    app.config.video.enabled = false;
    await teardown(app);
});

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});

// A confirmed video appointment starting in `minutes` (straight in the database, independent of opening hours).
async function videoAppointment(doctorId, patientEmail, minutes = 5, status = 'confirmed') {
    const {rows: [{id: patientId}]} = await pool.query('SELECT id FROM users WHERE email = $1', [patientEmail]);
    const {rows: [a]} = await pool.query(
        `INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at, status, mode)
         VALUES ($1, $2, now() + make_interval(mins => $3), now() + make_interval(mins => $3 + 30), $4, 'video') RETURNING id`,
        [doctorId, patientId, minutes, status]);
    return a.id;
}

describe('video consultations', () => {
    test('patients book a video call only where the platform and the doctor offer it', async () => {
        const doctor = await approvedDoctor(post);
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org');
        const slots = (await get(`/api/doctors/${doctor.id}/slots?days=7`)).json().slots;
        assert.equal((await get(`/api/doctors/${doctor.id}`)).json().doctor.video, false);
        assert.equal((await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[0].starts_at, mode: 'video'}, {cookie: lina})).json().error, 'video_unavailable');

        assert.deepEqual((await get('/api/doctor/video', doctor.cookie)).json(), {available: true, enabled: false});
        await post('/api/doctor/video', {enabled: true}, {cookie: doctor.cookie});
        assert.equal((await get(`/api/doctors/${doctor.id}`)).json().doctor.video, true);
        const booked = await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[0].starts_at, mode: 'video'}, {cookie: lina});
        assert.equal(booked.json().appointment.mode, 'video');
        assert.equal((await get('/api/appointments/mine', lina)).json().appointments[0].mode, 'video');
        assert.equal((await get('/api/doctor/appointments?scope=requests', doctor.cookie)).json().appointments[0].mode, 'video');

        app.config.video.enabled = false;
        assert.equal((await get(`/api/doctors/${doctor.id}`)).json().doctor.video, false, 'off for everyone when the platform switch is off');
        assert.equal((await get('/api/doctor/video', doctor.cookie)).json().available, false);
        assert.equal((await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[1].starts_at, mode: 'video'}, {cookie: lina})).json().error, 'video_unavailable');
        assert.equal((await get(`/api/video/${booked.json().appointment.id}`, lina)).statusCode, 404);
        app.config.video.enabled = true;
    });

    test('only the two people of the appointment join, in its time window; the doctor confirms with the emailed code', async () => {
        const doctor = await approvedDoctor(post);
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org');
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org');
        const id = await videoAppointment(doctor.id, 'lina@example.org');

        const room = (await get(`/api/video/${id}`, lina)).json();
        assert.equal(room.role, 'patient');
        assert.equal(room.open, true);
        assert.equal(room.peer_name, 'Dr. Approved');
        // Our own TURN relay with short-lived credentials (coturn use-auth-secret).
        const turn = room.ice_servers.find(s => s.urls.some(u => u.startsWith('turn:')));
        const [expiry, user] = turn.username.split(':');
        assert.ok(Number(expiry) > Date.now() / 1000 + 3600 && Number(expiry) <= Date.now() / 1000 + 7201);
        assert.equal(turn.credential, createHmac('sha1', 'turn-test-secret').update(turn.username).digest('base64'));
        assert.ok(user.length > 10);

        assert.equal((await get(`/api/video/${id}`, omar)).statusCode, 404);
        assert.equal((await get(`/api/video/${id}`, doctor.cookie)).json().error, 'second_factor_required');
        await confirmSession(doctor.cookie);
        assert.equal((await get(`/api/video/${id}`, doctor.cookie)).json().role, 'doctor');

        const later = await videoAppointment(doctor.id, 'lina@example.org', 24 * 60);
        assert.equal((await get(`/api/video/${later}`, lina)).json().open, false);
        assert.deepEqual((await get(`/api/video/${later}`, lina)).json().ice_servers, [], 'no relay credentials before the window');
        assert.equal((await post(`/api/video/${later}/signal`, {type: 'hello'}, {cookie: lina})).json().error, 'video_not_open');
        const requested = await videoAppointment(doctor.id, 'lina@example.org', 45, 'requested');
        assert.equal((await get(`/api/video/${requested}`, lina)).json().open, false, 'not confirmed: no call');
    });

    test('set-up messages go to the other side only, in order, and a waiting request wakes up at once', async () => {
        const doctor = await approvedDoctor(post);
        await confirmSession(doctor.cookie);
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org');
        const id = await videoAppointment(doctor.id, 'lina@example.org');
        const signal = (cookie, type, data) => post(`/api/video/${id}/signal`, {type, data}, {cookie});

        const hers = (await signal(lina, 'hello')).json();
        assert.equal(hers.peer_present, false);
        const his = (await signal(doctor.cookie, 'hello')).json();
        assert.equal(his.peer_present, true, 'the patient is already waiting: the doctor calls');
        await signal(doctor.cookie, 'offer', {sid: 's1', sdp: {type: 'offer', sdp: 'v=0'}});
        const forHer = (await get(`/api/video/${id}/signal?after=${hers.n}&wait=0`, lina)).json().messages;
        assert.deepEqual(forHer.map(m => [m.from, m.type]), [['doctor', 'hello'], ['doctor', 'offer']]);
        assert.deepEqual((await get(`/api/video/${id}/signal?after=0&wait=0`, doctor.cookie)).json().messages.map(m => m.type), ['hello'], 'never the own messages');

        // Long polling: the patient waits; the doctor's candidate arrives and ends the wait at once.
        const started = Date.now();
        const waiting = get(`/api/video/${id}/signal?after=${forHer.at(-1).n}&wait=10`, lina);
        await new Promise(resolve => setTimeout(resolve, 100));
        await signal(doctor.cookie, 'candidate', {sid: 's1', candidate: {candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0'}});
        const woke = (await waiting).json().messages;
        assert.deepEqual(woke.map(m => m.type), ['candidate']);
        assert.ok(Date.now() - started < 5000, 'did not wait for the timeout');

        assert.equal((await signal(lina, 'offer', {x: 'y'.repeat(25_000)})).json().error, 'too_long');
        assert.equal((await signal(lina, 'video', {})).statusCode, 400);
        await signal(lina, 'bye');
        const {rows} = await pool.query("SELECT details->>'role' AS role FROM audit_log WHERE action = 'video.joined' ORDER BY created_at");
        assert.deepEqual(rows.map(r => r.role), ['patient', 'doctor'], 'joining is recorded once per side');
    });

    test('a room keeps a bounded number of messages and knows who is there', async () => {
        const rooms = createRooms();
        rooms.post('a', 'patient', 'hello', null);
        assert.equal(rooms.present('a', 'doctor'), true);
        rooms.post('a', 'patient', 'bye', null);
        assert.equal(rooms.present('a', 'doctor'), false);
        for (let i = 0; i < 500; i++) rooms.post('a', 'doctor', 'candidate', {i});
        const all = await rooms.read('a', 'patient', 0, 0);
        assert.equal(all.length, 400);
        assert.equal(all.at(-1).data.i, 499);
    });
});
