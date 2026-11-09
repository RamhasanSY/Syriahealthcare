import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, cookieOf, pool, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const me = cookie => app.inject({url: '/api/me', headers: {cookie}});
const login = (email, password = 'doctor password 123') => post('/api/auth/login', {email, password});
const userId = email => pool.query('SELECT id FROM users WHERE email = $1', [email]).then(r => r.rows[0].id);

describe('administrators switch staff accounts off and on', () => {
    test('a switched-off doctor is signed out, cannot sign in, and disappears from the directory', async () => {
        const doctor = await approvedDoctor(post, 'dr@example.org', 'Dr. Approved');
        const admin = await signIn(post, 'admin', 'admin@example.org');
        assert.equal((await app.inject({url: '/api/doctors'})).json().doctors.length, 1);
        mail.sent.length = 0;

        const res = await post(`/api/admin/users/${doctor.id}/disable`, {note: 'Licence withdrawn by the ministry'}, {cookie: admin});
        assert.equal(res.statusCode, 200);
        assert.ok(res.json().account.disabled_at);

        assert.equal((await me(doctor.cookie)).statusCode, 401, 'the running session ends at once');
        assert.equal((await login('dr@example.org')).statusCode, 401, 'no new sign-in');
        assert.equal((await app.inject({url: '/api/doctors'})).json().doctors.length, 0, 'hidden from patients');
        assert.equal((await app.inject({url: `/fhir/r4/Practitioner/${doctor.id}`})).statusCode, 404, 'hidden from FHIR');
        assert.match(mail.sent.find(m => m.to === 'dr@example.org').text, /Licence withdrawn/);

        const {rows: [entry]} = await pool.query("SELECT * FROM audit_log WHERE action = 'account.disabled'");
        assert.equal(entry.target_id, doctor.id);
        const detail = (await app.inject({url: `/api/admin/doctors/${doctor.id}`, headers: {cookie: admin}})).json();
        assert.ok(detail.doctor.disabled_at);
        assert.ok(detail.history.some(h => h.action === 'account.disabled'), 'shown in the review history');

        assert.equal((await post(`/api/admin/users/${doctor.id}/enable`, {}, {cookie: admin})).statusCode, 200);
        assert.equal((await login('dr@example.org')).statusCode, 200, 'can sign in again');
        assert.equal((await app.inject({url: '/api/doctors'})).json().doctors.length, 1, 'listed again');
    });

    test('works for facilities too', async () => {
        const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email: 'lab@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const id = await userId('lab@example.org');
        assert.equal((await post(`/api/admin/users/${id}/disable`, {note: 'Closed down'}, {cookie: admin})).statusCode, 200);
        assert.equal((await me(cookie)).statusCode, 401);
    });

    test('a reason is required, and the same switch twice is refused', async () => {
        const doctor = await approvedDoctor(post);
        const admin = await signIn(post, 'admin', 'admin@example.org');
        assert.equal((await post(`/api/admin/users/${doctor.id}/disable`, {note: ''}, {cookie: admin})).json().error, 'note_required');
        assert.equal((await post(`/api/admin/users/${doctor.id}/enable`, {}, {cookie: admin})).json().error, 'wrong_status');
        await post(`/api/admin/users/${doctor.id}/disable`, {note: 'Fraud'}, {cookie: admin});
        assert.equal((await post(`/api/admin/users/${doctor.id}/disable`, {note: 'Fraud'}, {cookie: admin})).json().error, 'wrong_status');
    });

    test('an administrator cannot switch off their own account, but can switch off another administrator', async () => {
        const first = await signIn(post, 'admin', 'admin@example.org');
        const second = await signIn(post, 'admin', 'second@example.org', 'Second Admin');
        assert.equal((await post(`/api/admin/users/${await userId('admin@example.org')}/disable`, {note: 'Testing'}, {cookie: first})).json().error, 'own_account');
        assert.equal((await post(`/api/admin/users/${await userId('second@example.org')}/disable`, {note: 'Left the team'}, {cookie: first})).statusCode, 200);
        assert.equal((await me(second)).statusCode, 401, 'the other administrator is signed out');
    });

    test('patients cannot be targeted, and only administrators may switch accounts', async () => {
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org');
        const doctor = await approvedDoctor(post);
        const admin = await signIn(post, 'admin', 'admin@example.org');
        assert.equal((await post(`/api/admin/users/${await userId('lina@example.org')}/disable`, {note: 'Spam'}, {cookie: admin})).statusCode, 404);
        assert.equal((await post(`/api/admin/users/${doctor.id}/disable`, {note: 'Spam'}, {cookie: patient})).statusCode, 403);
        assert.equal((await post(`/api/admin/users/${doctor.id}/disable`, {note: 'Spam'}, {cookie: doctor.cookie})).statusCode, 403);
        assert.equal((await post(`/api/admin/users/${doctor.id}/disable`, {note: 'Spam'})).statusCode, 401);
    });
});

describe('suspended doctors', () => {
    test('no longer see their appointments or act on them, but can still open their profile', async () => {
        const doctor = await approvedDoctor(post);
        const appointments = () => app.inject({url: '/api/doctor/appointments', headers: {cookie: doctor.cookie}});
        assert.equal((await appointments()).statusCode, 200);
        await pool.query("UPDATE doctor_profiles SET status = 'suspended' WHERE user_id = $1", [doctor.id]);
        const res = await appointments();
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().error, 'suspended');
        const act = await post('/api/doctor/appointments/00000000-0000-4000-8000-000000000000/confirm', {}, {cookie: doctor.cookie});
        assert.equal(act.json().error, 'suspended');
        assert.equal((await app.inject({url: '/api/doctor/profile', headers: {cookie: doctor.cookie}})).statusCode, 200);
    });
});
