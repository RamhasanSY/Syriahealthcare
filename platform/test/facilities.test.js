import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {cookieOf, origin, pool, setup, signIn, teardown} from './helpers.js';

let app, mail, post;
beforeEach(async () => {
    await app?.close();
    ({app, mail, post} = await setup());
});
after(() => teardown(app));

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const complete = {
    facility_name: 'Al Shifa Laboratory', governorate: 'aleppo', area: 'Al Furqan', address: 'Street 4, Building 2',
    phone: '021 234 5678', licence_number: 'LAB-778', services: ['blood_count', 'hormones'], opening_hours: 'Sat–Thu 08:00–20:00',
    description: 'Full blood work and hormone tests.'
};

const register = (kind, email = 'lab@example.org', extra = {}) =>
    post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind, ...extra});

function upload(cookie, kind, content = PDF) {
    const boundary = '----shctest' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="licence.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        content, Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    return app.inject({method: 'POST', url: '/api/facility/documents', payload: body,
        headers: {origin, cookie, 'content-type': `multipart/form-data; boundary=${boundary}`}});
}

async function submittedFacility(kind = 'lab', email = 'lab@example.org', profile = complete) {
    const cookie = cookieOf(await register(kind, email));
    assert.equal((await post('/api/facility/profile', profile, {cookie})).statusCode, 200);
    assert.equal((await upload(cookie, 'licence')).statusCode, 201);
    assert.equal((await post('/api/facility/submit', {}, {cookie})).statusCode, 200);
    const {rows: [{id}]} = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    return {cookie, id};
}

describe('facility accounts', () => {
    test('labs, imaging centres, hospitals and clinics can register and sign in', async () => {
        for (const kind of ['lab', 'imaging', 'hospital', 'clinic']) {
            const res = await register(kind, `${kind}@example.org`);
            assert.equal(res.statusCode, 201, kind);
            assert.equal(res.json().user.role, 'facility');
            const profile = await app.inject({url: '/api/facility/profile', headers: {cookie: cookieOf(res)}});
            assert.deepEqual([profile.json().profile.kind, profile.json().profile.status], [kind, 'draft']);
        }
        const login = await post('/api/auth/login', {email: 'lab@example.org', password: 'facility password 123'});
        assert.equal(login.statusCode, 200);
        assert.equal((await app.inject({url: '/api/me', headers: {cookie: cookieOf(login)}})).json().user.role, 'facility');
        const {rows: [audit]} = await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'facility.registered'");
        assert.equal(audit.n, 4);
    });

    test('registration needs a known kind and a free email', async () => {
        assert.equal((await register('pharmacy')).statusCode, 400);
        assert.equal((await register('lab')).statusCode, 201);
        assert.equal((await register('hospital')).json().error, 'email_taken');
        await signIn(post, 'doctor', 'dr@example.org');
        assert.equal((await register('lab', 'dr@example.org')).json().error, 'email_taken');
    });

    test('facilities and doctors cannot use each other\'s pages', async () => {
        const facility = cookieOf(await register('lab'));
        const doctor = await signIn(post, 'doctor', 'dr@example.org');
        assert.equal((await app.inject({url: '/api/doctor/profile', headers: {cookie: facility}})).statusCode, 403);
        assert.equal((await app.inject({url: '/api/facility/profile', headers: {cookie: doctor}})).statusCode, 403);
        assert.equal((await app.inject({url: '/api/admin/facilities', headers: {cookie: facility}})).statusCode, 403);
    });
});

describe('facility profile', () => {
    test('saves details, normalises the phone and keeps services to the kind', async () => {
        const cookie = cookieOf(await register('lab'));
        const saved = await post('/api/facility/profile', complete, {cookie});
        assert.equal(saved.statusCode, 200);
        assert.equal(saved.json().profile.phone, '+963212345678');
        assert.deepEqual(saved.json().profile.services, ['blood_count', 'hormones']);
        assert.equal((await post('/api/facility/profile', {services: ['mri']}, {cookie})).json().error, 'invalid_service', 'MRI is an imaging service');
        assert.equal((await post('/api/facility/profile', {governorate: 'paris'}, {cookie})).json().error, 'invalid_governorate');
        assert.equal((await post('/api/facility/profile', {phone: '12'}, {cookie})).json().error, 'invalid_phone');
        assert.equal((await post('/api/facility/profile', {status: 'approved', area: 'Al Jamiliyah'}, {cookie})).json().profile.status, 'draft', 'facilities cannot set their own status');
        assert.equal((await post('/api/facility/profile', {emergency: true}, {cookie})).json().profile.emergency, false, 'labs have no emergency department');
    });

    test('hospitals can mark an emergency department', async () => {
        const cookie = cookieOf(await register('hospital', 'h@example.org'));
        const res = await post('/api/facility/profile', {emergency: true, services: ['emergency_care', 'surgery']}, {cookie});
        assert.equal(res.json().profile.emergency, true);
    });

    test('sending for review needs every required field and a licence', async () => {
        const cookie = cookieOf(await register('lab'));
        const empty = await post('/api/facility/submit', {}, {cookie});
        assert.equal(empty.json().error, 'incomplete');
        assert.deepEqual(empty.json().missing, ['facility_name', 'governorate', 'area', 'address', 'phone', 'licence_number']);
        await post('/api/facility/profile', complete, {cookie});
        assert.equal((await post('/api/facility/submit', {}, {cookie})).json().error, 'facility_licence_required');
        assert.equal((await upload(cookie, 'syndicate')).json().error, 'invalid_kind', 'facilities have no syndicate card');
        assert.equal((await upload(cookie, 'licence')).statusCode, 201);
        const sent = await post('/api/facility/submit', {}, {cookie});
        assert.equal(sent.json().profile.status, 'pending');
        assert.equal((await post('/api/facility/submit', {}, {cookie})).json().error, 'already_submitted');
    });
});

describe('facility review and public list', () => {
    test('only approved facilities are public, without private details', async () => {
        const lab = await submittedFacility();
        const admin = await signIn(post, 'admin', 'admin@example.org');
        assert.deepEqual((await app.inject({url: '/api/facilities'})).json().facilities, []);

        const list = await app.inject({url: '/api/admin/facilities', headers: {cookie: admin}});
        assert.equal(list.json().facilities[0].facility_name, 'Al Shifa Laboratory');
        assert.equal(list.json().counts.pending, 1);
        const detail = await app.inject({url: `/api/admin/facilities/${lab.id}`, headers: {cookie: admin}});
        assert.equal(detail.json().documents.length, 1);
        const doc = await app.inject({url: `/api/admin/documents/${detail.json().documents[0].id}`, headers: {cookie: admin}});
        assert.equal(doc.statusCode, 200, 'admins can open facility licences');

        assert.equal((await post(`/api/admin/facilities/${lab.id}/approve`, {}, {cookie: admin})).json().profile.status, 'approved');
        const [facility] = (await app.inject({url: '/api/facilities'})).json().facilities;
        assert.equal(facility.facility_name, 'Al Shifa Laboratory');
        assert.deepEqual(facility.services, ['blood_count', 'hormones']);
        for (const secret of ['email', 'name', 'licence_number', 'review_note']) assert.ok(!(secret in facility), secret);
        assert.equal((await app.inject({url: '/api/facilities?kind=hospital'})).json().facilities.length, 0);
        assert.equal((await app.inject({url: '/api/facilities?kind=lab'})).json().facilities.length, 1);
        assert.equal((await upload(lab.cookie, 'other')).json().error, 'documents_locked');
    });

    test('admins get an email naming the facility; the facility gets the decision', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org');
        mail.sent.length = 0;
        const lab = await submittedFacility();
        const toAdmin = mail.sent.find(m => m.to === 'admin@example.org');
        assert.match(toAdmin.subject, /Medical laboratory/);
        assert.match(toAdmin.text, /Al Shifa Laboratory/);
        await post(`/api/admin/facilities/${lab.id}/approve`, {}, {cookie: admin});
        const approved = mail.sent.at(-1);
        assert.equal(approved.to, 'lab@example.org');
        assert.match(approved.text, /syriahealthcare\.com/);
        await post(`/api/admin/facilities/${lab.id}/suspend`, {note: 'Licence expired in September.'}, {cookie: admin});
        assert.match(mail.sent.at(-1).text, /Licence expired in September\./);
    });

    test('changes after approval go back to review; reject and suspend need a note', async () => {
        const lab = await submittedFacility();
        const admin = await signIn(post, 'admin', 'admin@example.org');
        assert.equal((await post(`/api/admin/facilities/${lab.id}/reject`, {}, {cookie: admin})).json().error, 'note_required');
        await post(`/api/admin/facilities/${lab.id}/approve`, {}, {cookie: admin});
        const edited = await post('/api/facility/profile', {opening_hours: 'Every day 08:00–22:00'}, {cookie: lab.cookie});
        assert.equal(edited.json().profile.status, 'pending');
        assert.equal((await app.inject({url: '/api/facilities'})).json().facilities.length, 0);
        await post(`/api/admin/facilities/${lab.id}/approve`, {}, {cookie: admin});
        const suspended = await post(`/api/admin/facilities/${lab.id}/suspend`, {note: 'Licence expired'}, {cookie: admin});
        assert.equal(suspended.json().profile.status, 'suspended');
        assert.equal((await app.inject({url: '/api/facilities'})).json().facilities.length, 0);
        const own = await app.inject({url: '/api/facility/profile', headers: {cookie: lab.cookie}});
        assert.equal(own.json().profile.review_note, 'Licence expired');
        assert.equal((await post('/api/facility/profile', {area: 'Elsewhere'}, {cookie: lab.cookie})).json().error, 'suspended');
    });

    test('a disabled account disappears from the public list', async () => {
        const lab = await submittedFacility();
        const admin = await signIn(post, 'admin', 'admin@example.org');
        await post(`/api/admin/facilities/${lab.id}/approve`, {}, {cookie: admin});
        await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [lab.id]);
        assert.equal((await app.inject({url: '/api/facilities'})).json().facilities.length, 0);
    });
});
