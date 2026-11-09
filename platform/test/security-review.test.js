// One test per finding of the security review of 9 November 2026, so none of them can come back unnoticed.
import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, config, confirmSession, cookieOf, origin, pool, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';
import {multipart, PDF} from './fixtures.js';
import {addDays, localDate} from '../src/slots.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});

async function lab(email = 'lab@example.org', {status = 'approved', services = ['blood_count', 'home_collection']} = {}) {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind: 'lab'}));
    const {rows: [f]} = await pool.query(`UPDATE facility_profiles p SET status = $2, facility_name = 'Al Shifa Laboratory', services = $3
        FROM users u WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id`, [email, status, services]);
    return {cookie, id: f.user_id};
}
const slipFor = async (labCookie, fields = {}) => {
    const form = multipart({patient_name: 'Lina Haddad', patient_phone: '0912 345 678', title: 'Complete blood count', birth_year: '1990', ...fields},
        [{name: 'file', filename: 'cbc.pdf', type: 'application/pdf', content: PDF}]);
    return (await app.inject({method: 'POST', url: '/api/lab/results', payload: form.body, headers: {origin, cookie: labCookie, 'content-type': form.contentType}})).json();
};

describe('the health-file switch cannot be bypassed', () => {
    test('percent-encoded paths are switched off too, and personal answers are never stored', async () => {
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org');
        const doctor = await approvedDoctor(post, undefined, undefined, {confirmed: true});
        config.healthFile = false;
        try {
            for (const url of ['/api/file', '/api/%66ile', '/api/fil%65', '/api/%66ile/profiles/00000000-0000-4000-8000-000000000000/items']) {
                assert.equal((await get(url, patient)).statusCode, 404, url);
            }
            assert.equal((await get('/api/doctor/%70atients', doctor.cookie)).statusCode, 404);
        } finally {
            config.healthFile = true;
        }
        assert.equal((await get('/api/%6De', patient)).headers['cache-control'], 'no-store', 'an encoded /api/me is still not stored');
    });
});

describe('doctors and lab results', () => {
    test('scanned results need the emailed second factor; lookups and lists are recorded', async () => {
        const {cookie: labCookie} = await lab();
        const slip = await slipFor(labCookie);
        const doctor = await approvedDoctor(post);
        const lookup = await post('/api/doctor/results/lookup', {code: slip.code}, {cookie: doctor.cookie});
        assert.equal(lookup.statusCode, 403);
        assert.equal(lookup.json().error, 'second_factor_required');
        assert.equal((await get('/api/doctor/records', doctor.cookie)).json().error, 'second_factor_required');
        await confirmSession(doctor.cookie);
        assert.equal((await post('/api/doctor/results/lookup', {code: slip.code}, {cookie: doctor.cookie})).statusCode, 200);
        const added = (await post('/api/doctor/results/add', {code: slip.code}, {cookie: doctor.cookie})).json().result;
        const file = await get(`/api/doctor/results/${added.id}/file`, doctor.cookie);
        assert.match(file.headers['content-security-policy'], /^sandbox/, 'shown in the sandbox');
        assert.match(file.headers['content-disposition'], /^attachment/, 'PDFs download');
        await get('/api/doctor/records', doctor.cookie);
        const {rows} = await pool.query("SELECT action FROM audit_log WHERE action IN ('result.looked_up', 'records.listed')");
        assert.deepEqual(rows.map(r => r.action).sort(), ['records.listed', 'result.looked_up']);
    });

    test('licence documents and lab results get the same file checks as patients\' uploads', async () => {
        const {cookie: labCookie} = await lab();
        const active = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n');
        const form = multipart({patient_name: 'Lina Haddad', patient_phone: '0912 345 678', title: 'CBC'}, [{name: 'file', filename: 'x.pdf', type: 'application/pdf', content: active}]);
        const res = await app.inject({method: 'POST', url: '/api/lab/results', payload: form.body, headers: {origin, cookie: labCookie, 'content-type': form.contentType}});
        assert.equal(res.json().error, 'active_pdf');
        const doctor = await signIn(post, 'doctor', 'new@example.org');
        const doc = multipart({kind: 'licence'}, [{name: 'file', filename: 'licence.pdf', type: 'application/pdf', content: active}]);
        const upload = await app.inject({method: 'POST', url: '/api/doctor/documents', payload: doc.body, headers: {origin, cookie: doctor, 'content-type': doc.contentType}});
        assert.equal(upload.json().error, 'active_pdf');
    });
});

describe('taking a result over: the limit holds under parallel guessing', () => {
    test('50 parallel wrong guesses: at most 5 are evaluated, and the right one comes too late', async () => {
        const {cookie: labCookie} = await lab();
        const slip = await slipFor(labCookie);
        const cookie = await signInPatientByEmail(post, mail, 'thief@example.org', 'Some One');
        const profile = (await get('/api/file', cookie)).json().profiles[0];
        await post(`/api/file/profiles/${profile.id}/consent`, {}, {cookie});
        const guesses = Array.from({length: 50}, (_, i) => String(1940 + i));
        // From 50 different addresses, so the rate limit does not stop them: the database counter itself must hold.
        const answers = await Promise.all(guesses.map((check, i) => app.inject({method: 'POST', url: `/api/file/profiles/${profile.id}/claim`,
            remoteAddress: `10.0.${i}.7`, payload: {code: slip.code, check}, headers: {origin, cookie}})));
        const evaluated = answers.filter(a => a.json().error === 'wrong_check').length;
        assert.ok(evaluated <= 5, `${evaluated} guesses were evaluated`);
        assert.equal(answers.filter(a => a.statusCode === 201).length, 0, 'the right year (1990) was among them but locked out');
        assert.equal((await pool.query('SELECT claim_attempts FROM lab_results')).rows[0].claim_attempts, 5);
    });

    test('"already in another file" is only said after a right answer', async () => {
        const {cookie: labCookie} = await lab();
        const slip = await slipFor(labCookie);
        const owner = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
        const mine = (await get('/api/file', owner)).json().profiles[0];
        await post(`/api/file/profiles/${mine.id}/consent`, {}, {cookie: owner});
        await post(`/api/file/profiles/${mine.id}/claim`, {code: slip.code, check: '1990'}, {cookie: owner});
        const other = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Saleh');
        const theirs = (await get('/api/file', other)).json().profiles[0];
        await post(`/api/file/profiles/${theirs.id}/consent`, {}, {cookie: other});
        assert.equal((await post(`/api/file/profiles/${theirs.id}/claim`, {code: slip.code, check: '1977'}, {cookie: other})).json().error, 'wrong_check');
        assert.equal((await post(`/api/file/profiles/${theirs.id}/claim`, {code: slip.code, check: '1990'}, {cookie: other})).json().error, 'already_claimed');
    });
});

describe('software interfaces read nothing without a token', () => {
    test('junk to /fhir/r4 and /hl7v2 without a token is refused before it is parsed', async () => {
        const junk = '{"x":' + '['.repeat(200000) + ']'.repeat(200000) + '}';
        const started = Date.now();
        const fhir = await app.inject({method: 'POST', url: '/fhir/r4', payload: junk, headers: {'content-type': 'application/fhir+json'}});
        assert.equal(fhir.statusCode, 401);
        const v2 = await app.inject({method: 'POST', url: '/hl7v2', payload: 'MSH|^~\\&|X\r' + 'OBX|1|ST|A^B||x\r'.repeat(50000), headers: {'content-type': 'x-application/hl7-v2+er7'}});
        assert.equal(v2.statusCode, 401);
        assert.match(v2.body, /MSA\|AR\|/);
        assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    });

    test('a malformed %-escape in client credentials is a wrong client, not a server error', async () => {
        const res = await app.inject({method: 'POST', url: '/oauth/token', payload: 'grant_type=client_credentials',
            headers: {'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from('%:x').toString('base64')}});
        assert.equal(res.statusCode, 401);
        assert.equal(res.json().error, 'invalid_client');
    });
});

describe('access ends when it should', () => {
    test('a share made when booking ends when the doctor declines', async () => {
        const doctor = await approvedDoctor(post, undefined, undefined, {confirmed: true});
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org');
        const profile = (await get('/api/file', cookie)).json().profiles[0];
        await post(`/api/file/profiles/${profile.id}/consent`, {}, {cookie});
        const form = multipart({category: 'report', title: 'Report'}, [{filename: 'r.pdf', type: 'application/pdf', content: PDF}]);
        const item = (await app.inject({method: 'POST', url: `/api/file/profiles/${profile.id}/documents`, payload: form.body,
            headers: {origin, cookie, 'content-type': form.contentType}})).json().item;
        const day = addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
        const slot = (await get(`/api/doctors/${doctor.id}/slots?from=${day}&days=1`)).json().slots[0];
        const booked = (await post('/api/appointments', {doctor_id: doctor.id, starts_at: slot.starts_at, share_item_ids: [item.id]}, {cookie})).json().appointment;
        assert.equal((await get(`/api/doctor/shared/${item.id}/pages/1`, doctor.cookie)).statusCode, 200);
        await post(`/api/doctor/appointments/${booked.id}/decline`, {note: 'Fully booked'}, {cookie: doctor.cookie});
        assert.equal((await get(`/api/doctor/shared/${item.id}/pages/1`, doctor.cookie)).statusCode, 404);
    });

    test('a suspended lab no longer sees home visits', async () => {
        const {cookie, id} = await lab();
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org');
        const day = new Date(Date.now() + 2 * 86400000).toLocaleDateString('en-CA', {timeZone: 'Asia/Damascus'});
        await post('/api/home-visits', {facility_id: id, visit_date: day, time_window: 'morning', address: 'Mezzeh 12', phone: '0912345678'}, {cookie: patient});
        assert.equal((await get('/api/lab/home-visits', cookie)).json().visits.length, 1);
        await pool.query("UPDATE facility_profiles SET status = 'suspended' WHERE user_id = $1", [id]);
        assert.equal((await get('/api/lab/home-visits', cookie)).json().error, 'lab_not_approved');
    });

    test('a password reset forgets remembered devices', async () => {
        const doctor = await approvedDoctor(post);
        const {rows: [{id}]} = await pool.query("SELECT id FROM users WHERE email = 'dr@example.org'");
        await pool.query("INSERT INTO trusted_devices (token_hash, user_id, expires_at) VALUES ('x', $1, now() + interval '30 days')", [id]);
        await post('/api/auth/password/forgot', {email: 'dr@example.org'});
        const token = mail.sent.at(-1).text.match(/#([A-Za-z0-9_-]{43})/)[1];
        assert.equal((await post('/api/auth/password/reset', {token, password: 'a brand new password 42'})).statusCode, 200);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM trusted_devices')).rows[0].n, 0);
        assert.ok(doctor);
    });

    test('catalog checks accept only the lists\' own keys', async () => {
        const doctor = await signIn(post, 'doctor', 'dr@example.org');
        assert.equal((await post('/api/doctor/profile', {specialty: 'constructor'}, {cookie: doctor})).json().error, 'invalid_specialty');
        assert.equal((await post('/api/doctor/profile', {governorate: 'toString'}, {cookie: doctor})).json().error, 'invalid_governorate');
    });
});
