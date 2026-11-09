import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, cookieOf, origin, pool, setup, signIn, teardown} from './helpers.js';
import {cleanResultCode, newResultCode} from '../src/results.js';

let app, post;
beforeEach(async () => {
    await app?.close();
    ({app, post} = await setup());
});
after(() => teardown(app));

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const patient = {patient_name: 'Ahmad Khaled', patient_phone: '0912 345 678', title: 'Complete blood count'};

async function lab(kind = 'lab', email = 'lab@example.org', status = 'approved') {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind}));
    await pool.query(`UPDATE facility_profiles p SET status = $2, facility_name = 'Al Shifa Laboratory' FROM users u
        WHERE u.id = p.user_id AND u.email = $1`, [email, status]);
    return cookie;
}

// Fields go first, as the browser form sends them, so the server knows them when the file arrives.
function upload(cookie, fields = patient, content = PDF) {
    const boundary = '----shctest' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
        ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="befund.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
        content, Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    return app.inject({method: 'POST', url: '/api/lab/results', payload: body,
        headers: {origin, cookie, 'content-type': `multipart/form-data; boundary=${boundary}`}});
}

describe('result codes', () => {
    test('are 12 unambiguous characters in groups of four, and typed codes are cleaned', () => {
        const code = newResultCode();
        assert.match(code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
        assert.equal(cleanResultCode(' ' + code.toLowerCase().replaceAll('-', ' ') + ' '), code);
        assert.equal(cleanResultCode('ABCD-EFGH-JKL0'), null);  // 0 is never used
        assert.equal(cleanResultCode('ABCD-EFGH'), null);
    });
});

describe('lab side', () => {
    test('an approved lab uploads a result and gets a QR code that links to the scan page', async () => {
        const cookie = await lab();
        const res = await upload(cookie);
        assert.equal(res.statusCode, 201);
        const body = res.json();
        assert.equal(body.result.patient_phone, '+963912345678');
        assert.equal(body.lab_name, 'Al Shifa Laboratory');
        assert.equal(body.scan_url, `${origin}/scan#${body.code}`);
        assert.match(body.qr_svg, /^<svg /);
        // Only an HMAC of the code is stored, and the file is encrypted on disk.
        const {rows: [row]} = await pool.query('SELECT code_hash, storage_key FROM lab_results');
        assert.notEqual(row.code_hash, body.code);
        assert.doesNotMatch(row.code_hash, new RegExp(body.code));
        const list = (await app.inject({url: '/api/lab/results', headers: {cookie}})).json();
        assert.equal(list.results.length, 1);
        assert.equal(list.results[0].code, undefined);
    });

    test('imaging centres can send results; hospitals, unapproved labs and doctors cannot', async () => {
        assert.equal((await upload(await lab('imaging', 'img@example.org'))).statusCode, 201);
        assert.equal((await upload(await lab('hospital', 'h@example.org'))).json().error, 'not_a_lab');
        assert.equal((await upload(await lab('lab', 'new@example.org', 'pending'))).json().error, 'lab_not_approved');
        const doctor = await signIn(post, 'doctor', 'dr@example.org');
        assert.equal((await app.inject({url: '/api/lab/results', headers: {cookie: doctor}})).statusCode, 403);
    });

    test('approved pharmacies and blood banks cannot send, list or renew lab results', async () => {
        for (const [kind, email] of [['pharmacy', 'ph@example.org'], ['blood_bank', 'bb@example.org']]) {
            const cookie = await lab(kind, email);
            assert.equal((await upload(cookie)).json().error, 'not_a_lab', kind);
            assert.equal((await app.inject({url: '/api/lab/results', headers: {cookie}})).json().error, 'not_a_lab', kind);
            const renew = await post('/api/lab/results/0b6f1d1e-3c55-4a43-9f6e-5d3c2a1b0c9d/code', {}, {cookie});
            assert.equal(renew.json().error, 'not_a_lab', kind);
        }
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM lab_results')).rows[0].n, 0);
    });

    test('checks the patient, the title and the file', async () => {
        const cookie = await lab();
        assert.equal((await upload(cookie, {...patient, patient_name: 'A'})).json().error, 'invalid_patient_name');
        assert.equal((await upload(cookie, {...patient, patient_phone: '123'})).json().error, 'invalid_phone');
        assert.equal((await upload(cookie, {...patient, title: ''})).json().error, 'invalid_title');
        assert.equal((await upload(cookie, patient, Buffer.from('<html>not a pdf</html>'))).json().error, 'invalid_file_type');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM lab_results')).rows[0].n, 0);
    });

    test('a new QR code replaces the old one', async () => {
        const cookie = await lab(), first = (await upload(cookie)).json();
        const {cookie: doctor} = await approvedDoctor(post);
        const renewed = await post(`/api/lab/results/${first.result.id}/code`, {}, {cookie});
        assert.equal(renewed.statusCode, 200);
        assert.notEqual(renewed.json().code, first.code);
        assert.equal((await post('/api/doctor/results/lookup', {code: first.code}, {cookie: doctor})).json().error, 'code_invalid');
        assert.equal((await post('/api/doctor/results/lookup', {code: renewed.json().code}, {cookie: doctor})).statusCode, 200);
        // Another lab cannot touch it.
        const other = await lab('lab', 'other@example.org');
        assert.equal((await post(`/api/lab/results/${first.result.id}/code`, {}, {cookie: other})).statusCode, 404);
    });
});

describe('doctor side', () => {
    test('scanning shows whose result it is, adding puts it in the patient file, and the doctor can open it', async () => {
        const {code, result} = (await upload(await lab())).json();
        const {cookie} = await approvedDoctor(post);
        const lookup = await post('/api/doctor/results/lookup', {code: code.toLowerCase()}, {cookie});
        assert.equal(lookup.statusCode, 200);
        assert.deepEqual([lookup.json().result.patient_name, lookup.json().result.lab_name, lookup.json().result.added], ['Ahmad Khaled', 'Al Shifa Laboratory', false]);
        assert.equal((await app.inject({url: `/api/doctor/results/${result.id}/file`, headers: {cookie}})).statusCode, 404);  // not added yet

        assert.equal((await post('/api/doctor/results/add', {code}, {cookie})).json().result.added, true);
        assert.equal((await post('/api/doctor/results/add', {code}, {cookie})).statusCode, 200);  // scanning twice is harmless
        const records = (await app.inject({url: '/api/doctor/records', headers: {cookie}})).json();
        assert.equal(records.patients.length, 1);
        assert.deepEqual([records.patients[0].phone, records.patients[0].results.length], ['+963912345678', 1]);

        const file = await app.inject({url: `/api/doctor/results/${result.id}/file`, headers: {cookie}});
        assert.equal(file.statusCode, 200);
        assert.equal(file.headers['content-type'], 'application/pdf');
        assert.equal(file.headers['cache-control'], 'no-store');
        assert.deepEqual(file.rawPayload, PDF);
        const {rows} = await pool.query("SELECT action FROM audit_log WHERE action LIKE 'result.%' ORDER BY id");
        assert.deepEqual(rows.map(r => r.action), ['result.uploaded', 'result.added', 'result.viewed']);
    });

    test('results of one patient are grouped, and other doctors see nothing without scanning', async () => {
        const labCookie = await lab();
        const first = (await upload(labCookie)).json(), second = (await upload(labCookie, {...patient, title: 'HbA1c'})).json();
        const third = (await upload(labCookie, {...patient, patient_name: 'Lina Haddad', patient_phone: '0933 111 222'})).json();
        const {cookie} = await approvedDoctor(post);
        for (const s of [first, second, third]) await post('/api/doctor/results/add', {code: s.code}, {cookie});
        const records = (await app.inject({url: '/api/doctor/records', headers: {cookie}})).json();
        assert.deepEqual(records.patients.map(p => [p.name, p.results.length]).sort(), [['Ahmad Khaled', 2], ['Lina Haddad', 1]]);

        const {cookie: other} = await approvedDoctor(post, 'dr2@example.org');
        assert.deepEqual((await app.inject({url: '/api/doctor/records', headers: {cookie: other}})).json().patients, []);
        assert.equal((await app.inject({url: `/api/doctor/results/${first.result.id}/file`, headers: {cookie: other}})).statusCode, 404);
    });

    test('wrong and expired codes are refused, and only approved doctors can scan', async () => {
        const {code} = (await upload(await lab())).json();
        const {cookie} = await approvedDoctor(post);
        assert.equal((await post('/api/doctor/results/lookup', {code: 'ABCD-EFGH-JKLM'}, {cookie})).json().error, 'code_invalid');
        assert.equal((await post('/api/doctor/results/lookup', {code: 'nonsense'}, {cookie})).json().error, 'code_invalid');
        const pending = await signIn(post, 'doctor', 'new@example.org');
        assert.equal((await post('/api/doctor/results/lookup', {code}, {cookie: pending})).json().error, 'doctor_not_approved');
        const lab2 = await lab('lab', 'lab2@example.org');
        assert.equal((await post('/api/doctor/results/lookup', {code}, {cookie: lab2})).statusCode, 403);
        await pool.query("UPDATE lab_results SET code_expires_at = now() - interval '1 minute'");
        assert.equal((await post('/api/doctor/results/add', {code}, {cookie})).json().error, 'code_invalid');
    });
});
