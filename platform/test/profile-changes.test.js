import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, cookieOf, pool, setup, signIn, teardown, registerStaff} from './helpers.js';
import {splitChanges, DOCTOR_CRITICAL} from '../src/profile-changes.js';

let app, mail, post;
beforeEach(async () => {
    await app?.close();
    ({app, mail, post} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: {cookie}});

async function approvedLab(email = 'lab@example.org') {
    const cookie = cookieOf(await registerStaff(post, 'facility', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind: 'lab'}));
    const {rows: [{id}]} = await pool.query(`UPDATE facility_profiles p SET status = 'approved', facility_name = 'Al Shifa Laboratory',
        governorate = 'aleppo', area = 'Al Aziziyah', address = 'Main street 4', phone = '+963211234567'
        FROM users u WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id AS id`, [email]);
    return {cookie, id};
}

describe('splitting a change', () => {
    test('identifying details and the phone are held, the rest applies at once', () => {
        const {immediate, held} = splitChanges({clinic_address: 'New', bio: 'Hello', clinic_phone: '+963111111111'}, DOCTOR_CRITICAL);
        assert.deepEqual(held, {clinic_address: 'New', clinic_phone: '+963111111111'});
        assert.deepEqual(immediate, {bio: 'Hello'});
    });

    test('before approval nothing is held', () => {
        const {immediate, held} = splitChanges({clinic_address: 'New'}, []);
        assert.deepEqual(held, {});
        assert.deepEqual(immediate, {clinic_address: 'New'});
    });
});

describe('doctor changes after approval', () => {
    test('the bio applies at once, the address waits; the doctor stays approved and bookable', async () => {
        const doctor = await approvedDoctor(post);
        const res = await post('/api/doctor/profile', {bio: 'Heart specialist', clinic_address: 'New address 5'}, {cookie: doctor.cookie});
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().profile.status, 'approved');
        assert.equal(res.json().profile.bio, 'Heart specialist');
        assert.equal(res.json().profile.clinic_address, 'Mezzeh Highway 12', 'address unchanged until reviewed');
        assert.deepEqual(res.json().pending, ['clinic_address']);
        const slots = await app.inject({url: `/api/doctors/${doctor.id}/slots`});
        assert.equal(slots.statusCode, 200, 'patients can still book');
    });

    test('the form sends every field: unchanged details are not held, a new phone number is', async () => {
        const doctor = await approvedDoctor(post);
        const {profile} = (await app.inject({url: '/api/doctor/profile', headers: {cookie: doctor.cookie}})).json();
        const form = Object.fromEntries(['specialty', 'governorate', 'area', 'clinic_name', 'clinic_address', 'clinic_phone', 'licence_number']
            .map(key => [key, profile[key] ?? '']));
        const same = await post('/api/doctor/profile', {...form, bio: 'Only the bio is new'}, {cookie: doctor.cookie});
        assert.deepEqual(same.json().pending, []);
        assert.equal(same.json().profile.bio, 'Only the bio is new');
        const phone = await post('/api/doctor/profile', {...form, clinic_phone: '0113334455'}, {cookie: doctor.cookie});
        assert.deepEqual(phone.json().pending, ['clinic_phone']);
        assert.equal(phone.json().profile.clinic_phone, profile.clinic_phone, 'the listed number stays until an administrator accepts');
    });

    test('admins are told about held changes', async () => {
        await signIn(post, 'admin', 'admin@example.org');
        const doctor = await approvedDoctor(post);
        const before = mail.sent.length;
        await post('/api/doctor/profile', {clinic_name: 'New Heart Clinic'}, {cookie: doctor.cookie});
        assert.ok(mail.sent.slice(before).some(m => m.to === 'admin@example.org'));
    });

    test('the administrator sees current and proposed values, accepts, and the doctor is told', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const doctor = await approvedDoctor(post);
        await post('/api/doctor/profile', {clinic_address: 'New address 5', area: 'Malki'}, {cookie: doctor.cookie});
        const view = (await get(`/api/admin/doctors/${doctor.id}`, admin)).json();
        assert.deepEqual(view.pending.clinic_address, {current: 'Mezzeh Highway 12', proposed: 'New address 5'});
        assert.deepEqual(view.pending.area, {current: 'Mezzeh', proposed: 'Malki'});

        const accepted = await post(`/api/admin/doctors/${doctor.id}/changes/accept`, {}, {cookie: admin});
        assert.equal(accepted.statusCode, 200);
        assert.equal(accepted.json().profile.clinic_address, 'New address 5');
        assert.equal(accepted.json().profile.status, 'approved');
        assert.equal((await get(`/api/admin/doctors/${doctor.id}`, admin)).json().pending, null);
        assert.match(mail.sent.at(-1).subject, /accepted/);
        assert.equal(mail.sent.at(-1).to, 'dr@example.org');
        const listed = (await app.inject({url: '/api/doctors'})).json().doctors[0];
        assert.equal(listed.clinic_address, 'New address 5', 'the public now sees the accepted address');
    });

    test('rejecting needs a reason, drops the change and tells the doctor', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const doctor = await approvedDoctor(post);
        await post('/api/doctor/profile', {specialty: 'pediatrics'}, {cookie: doctor.cookie});
        assert.equal((await post(`/api/admin/doctors/${doctor.id}/changes/reject`, {}, {cookie: admin})).json().error, 'note_required');
        const rejected = await post(`/api/admin/doctors/${doctor.id}/changes/reject`, {note: 'Please send the specialty certificate.'}, {cookie: admin});
        assert.equal(rejected.statusCode, 200);
        assert.equal(rejected.json().profile.specialty, 'cardiology');
        assert.match(mail.sent.at(-1).text, /specialty certificate/);
        const {rows: [row]} = await pool.query('SELECT pending_changes FROM doctor_profiles WHERE user_id = $1', [doctor.id]);
        assert.equal(row.pending_changes, null);
    });

    test('nothing to decide gives 409; only admins can decide', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const doctor = await approvedDoctor(post);
        assert.equal((await post(`/api/admin/doctors/${doctor.id}/changes/accept`, {}, {cookie: admin})).statusCode, 409);
        await post('/api/doctor/profile', {area: 'Malki'}, {cookie: doctor.cookie});
        assert.equal((await post(`/api/admin/doctors/${doctor.id}/changes/accept`, {}, {cookie: doctor.cookie})).statusCode, 403);
    });

    test('two changes in a row are merged, the later value wins', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const doctor = await approvedDoctor(post);
        await post('/api/doctor/profile', {area: 'Malki'}, {cookie: doctor.cookie});
        await post('/api/doctor/profile', {area: 'Abu Rummaneh', clinic_name: 'Heart Centre'}, {cookie: doctor.cookie});
        const view = (await get(`/api/admin/doctors/${doctor.id}`, admin)).json();
        assert.equal(view.pending.area.proposed, 'Abu Rummaneh');
        assert.equal(view.pending.clinic_name.proposed, 'Heart Centre');
    });

    test('the "changes" list shows who is waiting, and the doctor sees which details wait', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const doctor = await approvedDoctor(post);
        await post('/api/doctor/profile', {area: 'Malki'}, {cookie: doctor.cookie});
        assert.deepEqual((await get('/api/doctor/profile', doctor.cookie)).json().profile.pending_fields, ['area']);
        const list = (await get('/api/admin/doctors?status=changes', admin)).json();
        assert.equal(list.counts.changes, 1);
        assert.deepEqual(list.doctors.map(d => d.id), [doctor.id]);
        assert.ok(list.doctors[0].submitted_at, 'when the change was sent');
        await post(`/api/admin/doctors/${doctor.id}/changes/accept`, {}, {cookie: admin});
        assert.equal((await get('/api/admin/doctors?status=changes', admin)).json().doctors.length, 0);
        assert.deepEqual((await get('/api/doctor/profile', doctor.cookie)).json().profile.pending_fields, []);
    });

    test('a doctor still in review changes details directly', async () => {
        const cookie = await signIn(post, 'doctor', 'new@example.org', 'Dr. New');
        const res = await post('/api/doctor/profile', {clinic_address: 'First address 1'}, {cookie});
        assert.equal(res.json().profile.clinic_address, 'First address 1');
        assert.deepEqual(res.json().pending, []);
    });
});

describe('facility changes after approval', () => {
    test('the name, the phone and an emergency claim wait for review, the description applies at once; accept publishes them', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const lab = await approvedLab();
        const before = (await app.inject({url: '/api/facility/profile', headers: {cookie: lab.cookie}})).json().profile;
        const res = await post('/api/facility/profile', {facility_name: 'Al Shifa Medical Lab', phone: '0212223344', description: 'Open early'}, {cookie: lab.cookie});
        assert.equal(res.json().profile.status, 'approved');
        assert.equal(res.json().profile.facility_name, 'Al Shifa Laboratory');
        assert.equal(res.json().profile.phone, before.phone, 'the number the approval check called stays until reviewed');
        assert.equal(res.json().profile.description, 'Open early');
        assert.deepEqual(res.json().pending.sort(), ['facility_name', 'phone']);
        assert.equal((await app.inject({url: '/api/facilities'})).json().facilities[0].facility_name, 'Al Shifa Laboratory');

        const view = (await get(`/api/admin/facilities/${lab.id}`, admin)).json();
        assert.deepEqual(view.pending.facility_name, {current: 'Al Shifa Laboratory', proposed: 'Al Shifa Medical Lab'});
        await post(`/api/admin/facilities/${lab.id}/changes/accept`, {}, {cookie: admin});
        const listed = (await app.inject({url: '/api/facilities'})).json().facilities[0];
        assert.equal(listed.facility_name, 'Al Shifa Medical Lab');
        assert.equal(listed.phone, '+963212223344');
    });

    test('a lab with a held change can still upload results', async () => {
        const lab = await approvedLab();
        await post('/api/facility/profile', {address: 'New street 9'}, {cookie: lab.cookie});
        const {rows: [p]} = await pool.query('SELECT status FROM facility_profiles WHERE user_id = $1', [lab.id]);
        assert.equal(p.status, 'approved', 'scan, upload and records keep working, since they check for approved');
    });
});
