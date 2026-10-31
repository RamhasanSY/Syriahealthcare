import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {config, origin, pool, setup, signIn, teardown} from './helpers.js';

let app, mail, post;
beforeEach(async () => {
    await app?.close();
    ({app, mail, post} = await setup());
});
after(() => teardown(app));

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const complete = {
    specialty: 'cardiology', governorate: 'damascus', area: 'Al Mazzeh', clinic_name: 'Heart Clinic',
    clinic_address: 'Mezzeh Highway, Building 12, 3rd floor', clinic_phone: '011 234 5678', licence_number: 'SY-12345', bio: 'Adult cardiology.'
};

function upload(cookie, kind, content, filename = 'licence.pdf', type = 'application/pdf') {
    const boundary = '----shctest' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
        content, Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    return app.inject({method: 'POST', url: '/api/doctor/documents', payload: body,
        headers: {origin, cookie, 'content-type': `multipart/form-data; boundary=${boundary}`}});
}

async function submittedDoctor(email = 'dr@example.org') {
    const cookie = await signIn(post, 'doctor', email, 'Dr. Rana Saleh');
    assert.equal((await post('/api/doctor/profile', complete, {cookie})).statusCode, 200);
    assert.equal((await upload(cookie, 'licence', PDF)).statusCode, 201);
    assert.equal((await post('/api/doctor/submit', {}, {cookie})).statusCode, 200);
    const {rows: [{id}]} = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    return {cookie, id};
}

describe('doctor profile', () => {
    test('new doctors start as draft and can save their profile', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        const first = await app.inject({url: '/api/doctor/profile', headers: {cookie}});
        assert.equal(first.json().profile.status, 'draft');
        const saved = await post('/api/doctor/profile', complete, {cookie});
        assert.equal(saved.statusCode, 200);
        assert.equal(saved.json().profile.clinic_phone, '+963112345678', 'local landline normalised');
        assert.equal(saved.json().profile.status, 'draft');
    });

    test('rejects unknown specialties, governorates and invalid phones', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        assert.equal((await post('/api/doctor/profile', {specialty: 'magic'}, {cookie})).json().error, 'invalid_specialty');
        assert.equal((await post('/api/doctor/profile', {governorate: 'paris'}, {cookie})).json().error, 'invalid_governorate');
        assert.equal((await post('/api/doctor/profile', {clinic_phone: '12'}, {cookie})).json().error, 'invalid_phone');
        assert.equal((await post('/api/doctor/profile', {bio: 'x'.repeat(601)}, {cookie})).statusCode, 400);
        const sneaky = await post('/api/doctor/profile', {status: 'approved', area: 'Mezzeh'}, {cookie});
        assert.equal(sneaky.json().profile.status, 'draft', 'doctors cannot set their own status');
    });

    test('cannot submit until complete and a licence is uploaded', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        const empty = await post('/api/doctor/submit', {}, {cookie});
        assert.equal(empty.json().error, 'incomplete');
        assert.ok(empty.json().missing.includes('licence_number'));
        await post('/api/doctor/profile', complete, {cookie});
        assert.equal((await post('/api/doctor/submit', {}, {cookie})).json().error, 'licence_required');
        await upload(cookie, 'licence', PDF);
        const ok = await post('/api/doctor/submit', {}, {cookie});
        assert.equal(ok.json().profile.status, 'pending');
        assert.equal((await post('/api/doctor/submit', {}, {cookie})).statusCode, 409);
    });

    test('patients and admins cannot use doctor endpoints', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org');
        assert.equal((await app.inject({url: '/api/doctor/profile', headers: {cookie: admin}})).statusCode, 403);
        assert.equal((await app.inject({url: '/api/doctor/profile'})).statusCode, 401);
    });
});

describe('licence documents', () => {
    test('accepts PDF and PNG, stores them encrypted', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        const res = await upload(cookie, 'licence', PDF, 'رخصة.pdf');
        assert.equal(res.statusCode, 201);
        assert.equal(res.json().document.mime, 'application/pdf');
        assert.equal(res.json().document.filename, 'رخصة.pdf');
        assert.equal((await upload(cookie, 'syndicate', PNG, 'card.png', 'image/png')).json().document.mime, 'image/png');
        const files = await readdir(config.documentDir);
        assert.ok(files.length >= 2);
        const stored = await readFile(path.join(config.documentDir, files[0]));
        assert.ok(!stored.includes(Buffer.from('%PDF')) && !stored.includes(Buffer.from('PNG')), 'files on disk are not readable');
    });

    test('rejects files that are not really PDF/JPG/PNG, whatever their name says', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        const res = await upload(cookie, 'licence', Buffer.from('<html><script>alert(1)</script></html>'), 'licence.pdf');
        assert.equal(res.json().error, 'invalid_file_type');
        assert.equal((await upload(cookie, 'passport', PDF)).json().error, 'invalid_kind');
    });

    test('rejects files over 5 MB', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024 + 10)]);
        assert.equal((await upload(cookie, 'licence', big)).statusCode, 413);
    });

    test('doctors can delete their own documents before approval, not others', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        const other = await signIn(post, 'doctor', 'other@example.org');
        const id = (await upload(cookie, 'licence', PDF)).json().document.id;
        const del = id => app.inject({method: 'DELETE', url: `/api/doctor/documents/${id}`, headers: {origin}});
        assert.equal((await app.inject({method: 'DELETE', url: `/api/doctor/documents/${id}`, headers: {origin, cookie: other}})).statusCode, 404);
        assert.equal((await del(id)).statusCode, 401);
        assert.equal((await app.inject({method: 'DELETE', url: `/api/doctor/documents/${id}`, headers: {origin, cookie}})).statusCode, 200);
    });
});

describe('admin review', () => {
    test('admin sees pending doctors, opens the licence and approves', async () => {
        const {id} = await submittedDoctor();
        const admin = await signIn(post, 'admin', 'admin@example.org', 'Review Admin');
        const list = await app.inject({url: '/api/admin/doctors?status=pending', headers: {cookie: admin}});
        assert.equal(list.json().doctors.length, 1);
        assert.equal(list.json().counts.pending, 1);
        const detail = await app.inject({url: `/api/admin/doctors/${id}`, headers: {cookie: admin}});
        const doc = detail.json().documents[0];
        const file = await app.inject({url: `/api/admin/documents/${doc.id}`, headers: {cookie: admin}});
        assert.equal(file.statusCode, 200);
        assert.equal(file.headers['content-type'], 'application/pdf');
        assert.deepEqual(file.rawPayload, PDF, 'decrypts to the original file');
        const ok = await post(`/api/admin/doctors/${id}/approve`, {}, {cookie: admin});
        assert.equal(ok.json().profile.status, 'approved');
        const {rows} = await pool.query('SELECT action FROM audit_log ORDER BY id');
        assert.ok(rows.some(r => r.action === 'document.viewed') && rows.some(r => r.action === 'doctor.approved'));
    });

    test('rejection needs a reason, which the doctor sees; they can fix and resubmit', async () => {
        const {cookie, id} = await submittedDoctor();
        const admin = await signIn(post, 'admin', 'admin@example.org');
        assert.equal((await post(`/api/admin/doctors/${id}/reject`, {}, {cookie: admin})).json().error, 'note_required');
        await post(`/api/admin/doctors/${id}/reject`, {note: 'The licence photo is unreadable.'}, {cookie: admin});
        const mine = await app.inject({url: '/api/doctor/profile', headers: {cookie}});
        assert.equal(mine.json().profile.status, 'rejected');
        assert.equal(mine.json().profile.review_note, 'The licence photo is unreadable.');
        await upload(cookie, 'licence', PNG, 'better.png', 'image/png');
        assert.equal((await post('/api/doctor/submit', {}, {cookie})).json().profile.status, 'pending');
    });

    test('admins get an email for each submission; the doctor for each decision, with the reason', async () => {
        const admin = await signIn(post, 'admin', 'admin@example.org', 'Review Admin');
        mail.sent.length = 0;
        const {cookie, id} = await submittedDoctor();
        const toAdmin = mail.sent.find(m => m.to === 'admin@example.org');
        assert.match(toAdmin.text, /Dr\. Rana Saleh/);
        assert.match(toAdmin.text, /\/admin/);
        await post(`/api/admin/doctors/${id}/reject`, {note: 'The licence photo is unreadable.'}, {cookie: admin});
        const rejected = mail.sent.at(-1);
        assert.equal(rejected.to, 'dr@example.org');
        assert.match(rejected.text, /The licence photo is unreadable\./);
        assert.match(rejected.text, /\/doctor/);
        assert.equal((await post('/api/doctor/submit', {}, {cookie})).statusCode, 200);
        await post(`/api/admin/doctors/${id}/approve`, {}, {cookie: admin});
        assert.match(mail.sent.at(-1).subject, /اعتماد|approved/);
        assert.ok(mail.sent.every(m => !/SY-12345/.test(m.text)), 'licence numbers are never emailed');
    });

    test('editing an approved profile sends it back for review', async () => {
        const {cookie, id} = await submittedDoctor();
        const admin = await signIn(post, 'admin', 'admin@example.org');
        await post(`/api/admin/doctors/${id}/approve`, {}, {cookie: admin});
        assert.equal((await upload(cookie, 'other', PDF)).statusCode, 403, 'documents are locked after approval');
        const changed = await post('/api/doctor/profile', {clinic_address: 'New address 5'}, {cookie});
        assert.equal(changed.json().profile.status, 'pending');
    });

    test('suspended doctors cannot edit; admins can reinstate', async () => {
        const {cookie, id} = await submittedDoctor();
        const admin = await signIn(post, 'admin', 'admin@example.org');
        await post(`/api/admin/doctors/${id}/approve`, {}, {cookie: admin});
        assert.equal((await post(`/api/admin/doctors/${id}/suspend`, {note: 'Complaint under review.'}, {cookie: admin})).json().profile.status, 'suspended');
        assert.equal((await post('/api/doctor/profile', {bio: 'x'}, {cookie})).statusCode, 403);
        assert.equal((await post(`/api/admin/doctors/${id}/approve`, {}, {cookie: admin})).json().profile.status, 'approved');
        assert.equal((await post(`/api/admin/doctors/${id}/reject`, {note: 'too late'}, {cookie: admin})).statusCode, 409, 'only pending profiles can be rejected');
    });

    test('doctors and patients cannot reach admin pages or documents', async () => {
        const {cookie, id} = await submittedDoctor();
        const {rows: [doc]} = await pool.query('SELECT id FROM doctor_documents');
        assert.equal((await app.inject({url: '/api/admin/doctors', headers: {cookie}})).statusCode, 403);
        assert.equal((await app.inject({url: `/api/admin/documents/${doc.id}`, headers: {cookie}})).statusCode, 403);
        assert.equal((await post(`/api/admin/doctors/${id}/approve`, {}, {cookie})).statusCode, 403);
        assert.equal((await app.inject({url: `/api/admin/documents/${doc.id}`})).statusCode, 401);
    });
});
