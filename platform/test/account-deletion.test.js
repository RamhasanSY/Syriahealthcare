// Deleting the own account (src/account-deletion.js, src/delete-account.js) and the Arabic search folding (migration 031).
import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {approvedDoctor, config, cookieOf, origin, pool, setup, signIn, signInPatientByEmail, teardown, registerStaff} from './helpers.js';
import {multipart, PDF} from './fixtures.js';
import {deleteStaffAccount} from '../src/delete-account.js';
import {addDays, localDate} from '../src/slots.js';

let app, post, mail, push;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail, push} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: {cookie}});
const count = async (sql, args = []) => (await pool.query(sql, args)).rows[0].n;
const files = async () => (await readdir(config.documentDir)).length;
const tomorrow = () => addDays(localDate(new Date()), 1);

async function patientWithFile(email = 'lina@example.org', name = 'Lina Haddad') {
    const cookie = await signInPatientByEmail(post, mail, email, name);
    const self = (await get('/api/file', cookie)).json().profiles.find(p => p.relationship === 'self');
    await post(`/api/file/profiles/${self.id}/consent`, {}, {cookie});
    const {body, contentType} = multipart({category: 'report', title: 'Cardiology report', document_date: '2026-10-01'},
        [{filename: 'report.pdf', type: 'application/pdf', content: PDF}]);
    const upload = await app.inject({method: 'POST', url: `/api/file/profiles/${self.id}/documents`, payload: body, headers: {origin, cookie, 'content-type': contentType}});
    assert.equal(upload.statusCode, 201);
    return {cookie, self};
}

describe('patients delete their own account', () => {
    test('everything goes at once: health file with its files, appointments, children; the doctor is told', async () => {
        const {cookie: doctor, id: doctorId} = await approvedDoctor(post);
        const lina = await patientWithFile();
        const child = (await post('/api/file/profiles', {name: 'Sami Haddad', birth_date: '2021-03-01'}, {cookie: lina.cookie})).json().profile;
        const [slot] = (await app.inject({url: `/api/doctors/${doctorId}/slots?from=${tomorrow()}&days=1`})).json().slots;
        assert.equal((await post('/api/appointments', {doctor_id: doctorId, starts_at: slot.starts_at}, {cookie: lina.cookie})).statusCode, 201);
        const device = {endpoint: 'https://fcm.googleapis.com/fcm/send/doctor-device', keys: {p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg'}};
        assert.equal((await post('/api/push/subscribe', device, {cookie: doctor})).statusCode, 200);
        const filesBefore = await files();

        const res = await post('/api/account/delete', {confirm: true}, {cookie: lina.cookie});
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json(), {deleted: true, profiles: 2, cancelled: 1});
        assert.equal(await count("SELECT count(*)::int AS n FROM users WHERE email = 'lina@example.org'"), 0);
        assert.equal(await count('SELECT count(*)::int AS n FROM patients WHERE id = ANY($1)', [[lina.self.id, child.id]]), 0, 'own and child profile gone');
        assert.equal(await count('SELECT count(*)::int AS n FROM clinical_documents'), 0);
        assert.equal(await files(), filesBefore - 1, 'the encrypted file is removed from disk');
        assert.equal(await count('SELECT count(*)::int AS n FROM appointments'), 0);
        assert.ok(push.sent.some(m => m.endpoint === device.endpoint && m.message.body.includes('حذف المريض حسابه')), 'the doctor hears that the time is free');
        assert.equal((await get('/api/me', lina.cookie)).statusCode, 401, 'signed out');
        assert.match(mail.sent.at(-1).subject, /تم حذف حسابك/);
        const {rows: [entry]} = await pool.query("SELECT actor_id, details FROM audit_log WHERE action = 'account.deleted'");
        assert.equal(entry.actor_id, null);
        assert.equal(entry.details.role, 'patient');
        assert.ok(!JSON.stringify(entry).includes('Lina'), 'the log keeps no name');
    });

    test('a child profile that another parent also has stays, with its entries', async () => {
        const lina = await patientWithFile();
        const child = (await post('/api/file/profiles', {name: 'Sami Haddad', birth_date: '2021-03-01'}, {cookie: lina.cookie})).json().profile;
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Haddad');
        await pool.query("INSERT INTO patient_access (user_id, patient_id, relationship) SELECT id, $1, 'child' FROM users WHERE email = 'omar@example.org'", [child.id]);
        assert.equal((await post('/api/account/delete', {confirm: true}, {cookie: lina.cookie})).json().profiles, 1);
        assert.equal(await count('SELECT count(*)::int AS n FROM patients WHERE id = $1', [child.id]), 1);
        assert.ok((await get('/api/file', omar)).json().profiles.some(p => p.id === child.id), 'the other parent still has the child');
    });

    test('needs a sign-in from the last 15 minutes and an explicit confirmation', async () => {
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org');
        assert.equal((await post('/api/account/delete', {}, {cookie})).statusCode, 400);
        assert.equal((await post('/api/account/delete', {confirm: 'yes'}, {cookie})).statusCode, 400);
        await pool.query("UPDATE sessions SET created_at = now() - interval '20 minutes'");
        const old = await post('/api/account/delete', {confirm: true}, {cookie});
        assert.equal(old.statusCode, 403);
        assert.equal(old.json().error, 'recent_sign_in_required');
        assert.equal(await count("SELECT count(*)::int AS n FROM users WHERE email = 'lina@example.org'"), 1);
        assert.equal((await post('/api/account/delete', {confirm: true})).statusCode, 401);
    });

    test('lab results stay with the lab; only the link to the patient goes', async () => {
        const lab = cookieOf(await registerStaff(post, 'facility', {name: 'Rana Saleh', email: 'lab@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
        await pool.query("UPDATE facility_profiles p SET status = 'approved', facility_name = 'Al Shifa Laboratory' FROM users u WHERE u.id = p.user_id AND u.email = 'lab@example.org'");
        const {body, contentType} = multipart({patient_name: 'Lina Haddad', patient_phone: '0912 345 678', title: 'Complete blood count', birth_year: '1990'},
            [{name: 'file', filename: 'cbc.pdf', type: 'application/pdf', content: PDF}]);
        assert.equal((await app.inject({method: 'POST', url: '/api/lab/results', payload: body, headers: {origin, cookie: lab, 'content-type': contentType}})).statusCode, 201);
        const lina = await patientWithFile();
        await post('/api/account/delete', {confirm: true}, {cookie: lina.cookie});
        assert.equal(await count('SELECT count(*)::int AS n FROM lab_results'), 1);
        assert.equal((await get('/api/lab/results', lab)).json().results.length, 1, 'the lab still finds its result');
    });
});

describe('doctors and facilities ask for deletion', () => {
    test('the account is switched off and unlisted at once, admins are told, and the command removes it later', async () => {
        await signIn(post, 'admin', 'admin@example.org', 'Admin');
        const {cookie: doctor} = await approvedDoctor(post);
        assert.equal((await app.inject({url: '/api/doctors'})).json().doctors.length, 1);
        mail.sent.length = 0;
        const res = await post('/api/account/delete', {confirm: true}, {cookie: doctor});
        assert.deepEqual(res.json(), {deletion_requested: true});
        assert.equal((await get('/api/me', doctor)).statusCode, 401);
        assert.equal((await app.inject({url: '/api/doctors'})).json().doctors.length, 0, 'no longer listed');
        assert.equal((await post('/api/auth/login', {email: 'dr@example.org', password: 'doctor password 123'})).statusCode, 401);
        assert.ok(mail.sent.some(m => m.to === 'admin@example.org' && m.text.includes('delete-account.js dr@example.org')));
        assert.ok(mail.sent.some(m => m.to === 'dr@example.org'));

        const done = await deleteStaffAccount({pool, documents: app.documents}, 'dr@example.org');
        assert.equal(done.role, 'doctor');
        assert.equal(await count("SELECT count(*)::int AS n FROM users WHERE email = 'dr@example.org'"), 0);
    });

    test('the command refuses accounts that did not ask, and labs with results unless told', async () => {
        await approvedDoctor(post, 'other@example.org');
        await assert.rejects(deleteStaffAccount({pool, documents: app.documents}, 'other@example.org'), /did not ask for deletion/);
        const lab = cookieOf(await registerStaff(post, 'facility', {name: 'Rana Saleh', email: 'lab@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
        await pool.query("UPDATE facility_profiles p SET status = 'approved', facility_name = 'Al Shifa Laboratory' FROM users u WHERE u.id = p.user_id AND u.email = 'lab@example.org'");
        const {body, contentType} = multipart({patient_name: 'Lina Haddad', patient_phone: '0912 345 678', title: 'Complete blood count'},
            [{name: 'file', filename: 'cbc.pdf', type: 'application/pdf', content: PDF}]);
        await app.inject({method: 'POST', url: '/api/lab/results', payload: body, headers: {origin, cookie: lab, 'content-type': contentType}});
        await post('/api/account/delete', {confirm: true}, {cookie: lab});
        await assert.rejects(deleteStaffAccount({pool, documents: app.documents}, 'lab@example.org'), /issued 1 lab results/);
        const filesBefore = await files();
        const done = await deleteStaffAccount({pool, documents: app.documents}, 'lab@example.org', {withResults: true});
        assert.equal(done.results, 1);
        assert.equal(await files(), filesBefore - 1, 'the result file is removed');
    });

    test('administrators cannot delete themselves this way', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org');
        assert.equal((await post('/api/account/delete', {confirm: true}, {cookie: admin})).statusCode, 403);
    });
});

describe('search forgives Arabic spelling', () => {
    test('doctors are found with or without hamza, ta marbuta or short vowels', async () => {
        await approvedDoctor(post, 'dr@example.org', 'د. أحمد الحلبي');
        for (const q of ['احمد', 'أحمد', 'أَحْمَد', 'الحلبى']) {
            const found = (await app.inject({url: '/api/doctors?q=' + encodeURIComponent(q)})).json().doctors;
            assert.equal(found.length, 1, q);
        }
        assert.equal((await app.inject({url: '/api/doctors?q=' + encodeURIComponent('محمد')})).json().doctors.length, 0);
    });
});
