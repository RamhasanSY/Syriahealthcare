import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {createECDH, randomBytes} from 'node:crypto';
import {approvedDoctor, pool, setup, signInPatient, signInPatientByEmail, teardown} from './helpers.js';
import {foldLine, notifyWaitlist, sendAppointmentReminders} from '../src/appointment-comfort.js';
import {cleanup} from '../src/jobs.js';

let app, post, mail, sms, push;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail, sms, push} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});
const subscribe = async cookie => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`;
    await post('/api/push/subscribe', {endpoint, keys: {p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url')}}, {cookie});
    return endpoint;
};
const userId = async email => (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
const queued = async to => (await pool.query('SELECT subject, body FROM email_outbox WHERE to_address = $1 ORDER BY created_at', [to])).rows;

// An appointment straight in the database, `hours` from now (the reminder window is relative to now, not to opening hours).
async function appointmentIn(hours, {doctorId, patientId, status = 'confirmed'}) {
    const {rows: [a]} = await pool.query(
        `INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at, status)
         VALUES ($1, $2, now() + make_interval(hours => $3), now() + make_interval(hours => $3, mins => 30), $4) RETURNING id`,
        [doctorId, patientId, hours, status]);
    return a.id;
}

describe('reminders', () => {
    test('a confirmed appointment within 24 hours is reminded once, by notification, email and text message', async () => {
        const doctor = await approvedDoctor(post);
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina');
        await pool.query("UPDATE users SET phone = '+963944123456' WHERE email = 'lina@example.org'");
        const endpoint = await subscribe(lina);
        const patientId = await userId('lina@example.org');
        const due = await appointmentIn(20, {doctorId: doctor.id, patientId});
        await appointmentIn(30, {doctorId: doctor.id, patientId});                         // too early
        await appointmentIn(1, {doctorId: doctor.id, patientId});                          // too late to be of use
        await appointmentIn(10, {doctorId: doctor.id, patientId, status: 'requested'});    // not confirmed

        assert.equal(await sendAppointmentReminders(app), 1);
        assert.equal(await sendAppointmentReminders(app), 0, 'only once');
        const {rows: [a]} = await pool.query('SELECT reminder_sent_at FROM appointments WHERE id = $1', [due]);
        assert.ok(a.reminder_sent_at);
        assert.equal(push.sent.filter(m => m.endpoint === endpoint).at(-1).message.title, 'تذكير بموعدك');
        const [email] = await queued('lina@example.org');
        assert.match(email.subject, /تذكير/);
        assert.match(email.body, /Dr\. Approved/);
        assert.match(email.body, /Mezzeh Highway 12/);
        assert.match(email.body, /\/appointments/);
        assert.match(sms.sent.at(-1).message, /تذكير: موعدك لدى Dr\. Approved/);
        assert.equal(sms.sent.at(-1).to, '+963944123456');
    });
});

describe('calendar file', () => {
    test('the patient and the doctor download the appointment for their calendar; nobody else', async () => {
        const doctor = await approvedDoctor(post, 'dr@example.org', 'Dr. Rami Haddad, Cardiology; Damascus');
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Nasser');
        const slots = (await get(`/api/doctors/${doctor.id}/slots?days=7`)).json().slots;
        const id = (await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[0].starts_at}, {cookie: lina})).json().appointment.id;
        const res = await get(`/api/appointments/${id}/calendar.ics`, lina);
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^text\/calendar/);
        assert.match(res.headers['content-disposition'], /attachment/);
        assert.equal(res.headers['cache-control'], 'no-store');
        const ics = res.body;
        assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
        assert.match(ics, new RegExp(`DTSTART:${slots[0].starts_at.replace(/[-:]/g, '').replace('.000', '')}\r\n`));
        assert.match(ics, /SUMMARY:Dr\. Rami Haddad\\, Cardiology\\; Damascus \(SyriaHC\)/);
        assert.match(ics, /STATUS:TENTATIVE/, 'not confirmed yet');
        assert.ok(ics.split('\r\n').every(line => Buffer.byteLength(line) <= 75), 'lines are folded');
        assert.match((await get(`/api/appointments/${id}/calendar.ics`, doctor.cookie)).body, /SUMMARY:SyriaHC: Lina Nasser/);
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org');
        assert.equal((await get(`/api/appointments/${id}/calendar.ics`, omar)).statusCode, 404);
        assert.equal((await get(`/api/appointments/${id}/calendar.ics`)).statusCode, 401);
    });

    test('long Arabic lines are folded without breaking a character', () => {
        const line = 'LOCATION:' + 'عيادة القلب في المزة، دمشق '.repeat(6);
        const folded = foldLine(line);
        assert.ok(folded.split('\r\n').every(part => Buffer.byteLength(part) <= 75));
        assert.equal(folded.split('\r\n ').join(''), line);
    });
});

describe('moving an appointment', () => {
    test('a patient moves an appointment to another free time; the doctor confirms again', async () => {
        const doctor = await approvedDoctor(post);
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org');
        const slots = (await get(`/api/doctors/${doctor.id}/slots?days=7`)).json().slots;
        const id = (await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[0].starts_at}, {cookie: lina})).json().appointment.id;
        await post(`/api/doctor/appointments/${id}/confirm`, {}, {cookie: doctor.cookie});

        const moved = await post(`/api/appointments/${id}/reschedule`, {starts_at: slots[2].starts_at}, {cookie: lina});
        assert.equal(moved.statusCode, 200);
        assert.equal(moved.json().appointment.status, 'requested');
        assert.equal(new Date(moved.json().appointment.starts_at).toISOString(), slots[2].starts_at);
        const free = (await get(`/api/doctors/${doctor.id}/slots?days=7`)).json().slots.map(s => s.starts_at);
        assert.ok(free.includes(slots[0].starts_at), 'the old time is free again');
        assert.ok(!free.includes(slots[2].starts_at));

        // Someone else's time, or a time that is not offered, is refused.
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org');
        await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[4].starts_at}, {cookie: omar});
        assert.equal((await post(`/api/appointments/${id}/reschedule`, {starts_at: slots[4].starts_at}, {cookie: lina})).json().error, 'slot_taken');
        assert.equal((await post(`/api/appointments/${id}/reschedule`, {starts_at: '2020-01-01T09:00:00.000Z'}, {cookie: lina})).json().error, 'slot_taken');
        assert.equal((await post(`/api/appointments/${id}/reschedule`, {starts_at: slots[5].starts_at}, {cookie: omar})).statusCode, 404, 'not his');

        await post(`/api/appointments/${id}/reschedule`, {starts_at: slots[1].starts_at}, {cookie: lina});
        await post(`/api/appointments/${id}/reschedule`, {starts_at: slots[3].starts_at}, {cookie: lina});
        assert.equal((await post(`/api/appointments/${id}/reschedule`, {starts_at: slots[6].starts_at}, {cookie: lina})).json().error, 'too_many_reschedules');
        const {rows: audits} = await pool.query("SELECT details FROM audit_log WHERE action = 'appointment.rescheduled'");
        assert.equal(audits.length, 3);

        await post(`/api/appointments/${id}/cancel`, {}, {cookie: lina});
        assert.equal((await post(`/api/appointments/${id}/reschedule`, {starts_at: slots[6].starts_at}, {cookie: lina})).json().error, 'cannot_reschedule');
    });
});

describe('waiting list', () => {
    test('patients waiting for a doctor hear when a time becomes free, at most every 6 hours', async () => {
        const doctor = await approvedDoctor(post);
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org');
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar');
        const endpoint = await subscribe(omar);
        const joined = await post('/api/waitlist', {doctor_id: doctor.id}, {cookie: omar});
        assert.equal(joined.statusCode, 201);
        assert.equal((await post('/api/waitlist', {doctor_id: doctor.id}, {cookie: omar})).statusCode, 201, 'joining again just renews it');
        assert.equal((await get('/api/waitlist/mine', omar)).json().entries.length, 1);

        const slots = (await get(`/api/doctors/${doctor.id}/slots?days=7`)).json().slots;
        const later = slots.find(s => Date.parse(s.starts_at) > Date.now() + 2 * 3600_000);
        const id = (await post('/api/appointments', {doctor_id: doctor.id, starts_at: later.starts_at}, {cookie: lina})).json().appointment.id;
        await post(`/api/appointments/${id}/cancel`, {}, {cookie: lina});
        const message = push.sent.filter(m => m.endpoint === endpoint).at(-1).message;
        assert.equal(message.title, 'أصبح موعد متاحاً');
        assert.equal(message.url, `/book?doctor=${doctor.id}`);
        const [email] = await queued('omar@example.org');
        assert.match(email.body, new RegExp(`/book\\?doctor=${doctor.id}`));

        assert.equal(await notifyWaitlist(app, doctor.id, later.starts_at), 0, 'quiet for 6 hours');
        await pool.query("UPDATE waitlist_entries SET notified_at = now() - interval '7 hours'");
        assert.equal(await notifyWaitlist(app, doctor.id, later.starts_at), 1);
        assert.equal(await notifyWaitlist(app, doctor.id, new Date(Date.now() + 10 * 60_000)), 0, 'a time in 10 minutes helps nobody');

        // Booking with the doctor ends the wait.
        const free = (await get(`/api/doctors/${doctor.id}/slots?days=7`)).json().slots;
        await post('/api/appointments', {doctor_id: doctor.id, starts_at: free.at(-1).starts_at}, {cookie: omar});
        assert.equal((await get('/api/waitlist/mine', omar)).json().entries.length, 0);
    });

    test('at most 3 doctors at a time; entries can be left and expire', async () => {
        const doctors = [];
        for (let i = 0; i < 4; i++) doctors.push(await approvedDoctor(post, `dr${i}@example.org`, `Dr. ${i}`));
        const lina = await signInPatient(post, sms, '+963944000111');
        for (const d of doctors.slice(0, 3)) assert.equal((await post('/api/waitlist', {doctor_id: d.id}, {cookie: lina})).statusCode, 201);
        assert.equal((await post('/api/waitlist', {doctor_id: doctors[3].id}, {cookie: lina})).json().error, 'too_many_waitlist');
        const [first] = (await get('/api/waitlist/mine', lina)).json().entries;
        assert.equal((await post(`/api/waitlist/${first.id}/leave`, {}, {cookie: lina})).json().left, true);
        assert.equal((await post('/api/waitlist', {doctor_id: doctors[3].id}, {cookie: lina})).statusCode, 201);
        assert.equal((await post('/api/waitlist', {doctor_id: '00000000-0000-4000-8000-000000000000'}, {cookie: lina})).statusCode, 404);
        await pool.query("UPDATE waitlist_entries SET expires_at = now() - interval '1 minute'");
        assert.equal((await get('/api/waitlist/mine', lina)).json().entries.length, 0);
        assert.equal((await cleanup(pool)).waitlist_entries, 3);
    });
});
