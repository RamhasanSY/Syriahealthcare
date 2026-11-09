import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {approvedDoctor, config, cookieOf, origin, pool, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';
import {jpegWithExif, multipart, PDF, PDF_SCRIPT} from './fixtures.js';
import {purgeBin} from '../src/jobs.js';
import {LIMITS} from '../src/healthfile.js';
import {addDays, localDate} from '../src/slots.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: {cookie}});
const fileOf = async cookie => (await get('/api/file', cookie)).json();
const self = async cookie => (await fileOf(cookie)).profiles.find(p => p.relationship === 'self');

function uploadTo(cookie, profileId, files, fields = {category: 'report', title: 'Cardiology report', document_date: '2026-10-01'}) {
    const {body, contentType} = multipart(fields, files);
    return app.inject({method: 'POST', url: `/api/file/profiles/${profileId}/documents`, payload: body, headers: {origin, cookie, 'content-type': contentType}});
}
const pdfPage = (content = PDF) => ({filename: 'report.pdf', type: 'application/pdf', content});

async function patientWithConsent(email = 'lina@example.org', name = 'Lina Haddad') {
    const cookie = await signInPatientByEmail(post, mail, email, name);
    const profile = await self(cookie);
    assert.equal((await post(`/api/file/profiles/${profile.id}/consent`, {}, {cookie})).statusCode, 200);
    return {cookie, profile};
}

async function approvedLab(email = 'lab@example.org') {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind: 'lab'}));
    await pool.query(`UPDATE facility_profiles p SET status = 'approved', facility_name = 'Al Shifa Laboratory' FROM users u WHERE u.id = p.user_id AND u.email = $1`, [email]);
    return cookie;
}
function labResult(cookie, fields = {}) {
    const {body, contentType} = multipart({patient_name: 'Lina Haddad', patient_phone: '0912 345 678', title: 'Complete blood count', birth_year: '1990', ...fields},
        [{name: 'file', filename: 'cbc.pdf', type: 'application/pdf', content: PDF}]);
    return app.inject({method: 'POST', url: '/api/lab/results', payload: body, headers: {origin, cookie, 'content-type': contentType}});
}

describe('switch', () => {
    test('with HEALTH_FILE off, the health file does not exist for anyone', async () => {
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org');
        config.healthFile = false;
        try {
            assert.equal((await get('/api/file', cookie)).statusCode, 404);
            assert.equal((await post('/api/file/profiles', {name: 'Sami', birth_date: '2020-01-01'}, {cookie})).statusCode, 404);
            const lab = await approvedLab();
            const slip = (await labResult(lab)).json();
            assert.equal(slip.health_file, null, 'slips do not mention the health file');
        } finally {
            config.healthFile = true;
        }
    });
});

describe('profiles and patient numbers', () => {
    test('every patient gets an own profile with a SyriaHC number at sign-in', async () => {
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
        const {rows} = await pool.query('SELECT p.patient_number, p.name FROM patients p JOIN patient_access a ON a.patient_id = p.id');
        assert.equal(rows.length, 1, 'created at sign-in, before the file is opened');
        const file = await fileOf(cookie);
        assert.equal(file.profiles.length, 1);
        assert.equal(file.profiles[0].relationship, 'self');
        assert.equal(file.profiles[0].patient_number, rows[0].patient_number);
        assert.match(rows[0].patient_number, /^SHC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]$/);
        assert.equal(file.profiles[0].consent, false);
        // Signing in again keeps the same profile.
        await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM patients')).rows[0].n, 1);
    });

    test('children get their own profiles and numbers; adults cannot be added as children', async () => {
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org');
        const year = new Date().getFullYear();
        const res = await post('/api/file/profiles', {name: 'Sami Haddad', birth_date: `${year - 5}-03-01`}, {cookie});
        assert.equal(res.statusCode, 201);
        const child = res.json().profile;
        assert.equal(child.relationship, 'child');
        assert.notEqual(child.patient_number, (await self(cookie)).patient_number);
        assert.equal((await post('/api/file/profiles', {name: 'Grown Up', birth_date: `${year - 30}-01-01`}, {cookie})).json().error, 'not_a_child');
        assert.equal((await post(`/api/file/profiles/${child.id}`, {name: 'Sami K. Haddad'}, {cookie})).json().profile.name, 'Sami K. Haddad');
        assert.equal((await fileOf(cookie)).profiles.length, 2);
    });

    test('another patient finds nothing: every profile and entry route answers 404', async () => {
        const lina = await patientWithConsent();
        const child = (await post('/api/file/profiles', {name: 'Sami Haddad', birth_date: '2021-03-01'}, {cookie: lina.cookie})).json().profile;
        const item = (await uploadTo(lina.cookie, lina.profile.id, [pdfPage()])).json().item;
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Saleh');
        for (const id of [lina.profile.id, child.id]) {
            assert.equal((await get(`/api/file/profiles/${id}/items`, omar)).statusCode, 404);
            assert.equal((await post(`/api/file/profiles/${id}`, {name: 'Taken Over'}, {cookie: omar})).statusCode, 404);
            assert.equal((await post(`/api/file/profiles/${id}/consent`, {}, {cookie: omar})).statusCode, 404);
            assert.equal((await uploadTo(omar, id, [pdfPage()])).statusCode, 404);
        }
        assert.equal((await get(`/api/file/documents/${item.id}/pages/1`, omar)).statusCode, 404);
        assert.equal((await post(`/api/file/documents/${item.id}/delete`, {}, {cookie: omar})).statusCode, 404);
        // Doctors, labs and administrators have no route into a patient's file at all.
        const doctor = await approvedDoctor(post);
        const admin = await signIn(post, 'admin', 'admin@example.org');
        for (const cookie of [doctor.cookie, admin]) {
            assert.equal((await get(`/api/file/profiles/${lina.profile.id}/items`, cookie)).statusCode, 403);
            assert.equal((await get(`/api/file/documents/${item.id}/pages/1`, cookie)).statusCode, 403);
        }
    });
});

describe('uploads', () => {
    test('nothing is stored without consent', async () => {
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org');
        const res = await uploadTo(cookie, (await self(cookie)).id, [pdfPage()]);
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().error, 'file_consent_required');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM clinical_documents')).rows[0].n, 0);
    });

    test('a photo of several pages is stored encrypted, without its location, shown in a sandbox and recorded', async () => {
        const {cookie, profile} = await patientWithConsent();
        const photo = jpegWithExif();
        const res = await uploadTo(cookie, profile.id, [{filename: 'page1.jpg', type: 'image/jpeg', content: photo}, pdfPage()],
            {category: 'discharge', title: 'Discharge letter', document_date: '2026-09-12'});
        assert.equal(res.statusCode, 201);
        const item = res.json().item;
        assert.equal(item.pages, 2);

        const items = (await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items;
        assert.deepEqual(items.map(i => [i.title, i.category, i.document_date]), [['Discharge letter', 'discharge', '2026-09-12']]);

        const page = await get(`/api/file/documents/${item.id}/pages/1`, cookie);
        assert.equal(page.statusCode, 200);
        assert.equal(page.headers['content-type'], 'image/jpeg');
        assert.match(page.headers['content-security-policy'], /^sandbox/);
        assert.equal(page.headers['cache-control'], 'no-store');
        assert.match(page.headers['content-disposition'], /^inline/, 'pictures are shown');
        const pdf = await get(`/api/file/documents/${item.id}/pages/2`, cookie);
        assert.match(pdf.headers['content-disposition'], /^attachment/, 'PDFs are downloaded');
        assert.match(pdf.headers['content-security-policy'], /^sandbox/);
        assert.doesNotMatch(page.rawPayload.toString('latin1'), /GPSLatitude|PhoneX/, 'location removed');
        assert.match(page.rawPayload.toString('latin1'), /IMAGEDATA/, 'picture kept');

        // On disk, nothing is readable.
        for (const name of await readdir(config.documentDir)) {
            const raw = (await readFile(path.join(config.documentDir, name))).toString('latin1');
            assert.doesNotMatch(raw, /IMAGEDATA|%PDF/);
        }
        const {rows} = await pool.query("SELECT details FROM audit_log WHERE action = 'health_document.viewed'");
        assert.equal(rows.length, 2);
        assert.equal(rows[0].details.patient_id, profile.id);
    });

    test('active PDFs and other file types are refused', async () => {
        const {cookie, profile} = await patientWithConsent();
        assert.equal((await uploadTo(cookie, profile.id, [pdfPage(PDF_SCRIPT)])).json().error, 'active_pdf');
        assert.equal((await uploadTo(cookie, profile.id, [{filename: 'x.html', type: 'text/html', content: Buffer.from('<html>')}])).json().error, 'invalid_file_type');
        assert.equal((await uploadTo(cookie, profile.id, [pdfPage()], {category: 'secret', title: 'X ray'})).json().error, 'invalid_category');
        assert.equal((await uploadTo(cookie, profile.id, [pdfPage()], {category: 'lab', title: 'Future', document_date: '2999-01-01'})).json().error, 'invalid_date');
    });

    test('limits: entries per profile and pages per day', async () => {
        const {cookie, profile} = await patientWithConsent();
        await pool.query(`INSERT INTO clinical_documents (patient_id, source, category, title)
            SELECT $1, 'upload', 'other', 'Old ' || g FROM generate_series(1, $2) g`, [profile.id, LIMITS.documentsPerProfile]);
        assert.equal((await uploadTo(cookie, profile.id, [pdfPage()])).json().error, 'too_many_documents');
        await pool.query('DELETE FROM clinical_documents');
        const {rows: [d]} = await pool.query(`INSERT INTO clinical_documents (patient_id, source, category, title) VALUES ($1, 'upload', 'other', 'Many pages') RETURNING id`, [profile.id]);
        await pool.query(`INSERT INTO clinical_document_files (document_id, page, filename, mime, size_bytes, sha256, storage_key, iv, auth_tag)
            SELECT $1, g, 'p.pdf', 'application/pdf', 10, 'x', md5(g::text) || 'aaaaaaaaaaaaaaaa', 'x', 'x' FROM generate_series(1, $2) g`, [d.id, LIMITS.pagesPerDay]);
        assert.equal((await uploadTo(cookie, profile.id, [pdfPage()])).json().error, 'too_many_pages_today');
    });

    test('deleted entries wait 30 days in the bin, can be restored, and are then removed for good', async () => {
        const {cookie, profile} = await patientWithConsent();
        const item = (await uploadTo(cookie, profile.id, [pdfPage()])).json().item;
        assert.equal((await post(`/api/file/documents/${item.id}/delete`, {}, {cookie})).statusCode, 200);
        assert.equal((await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items.length, 0);
        assert.equal((await get(`/api/file/profiles/${profile.id}/items?bin=true`, cookie)).json().items.length, 1);
        assert.equal((await post(`/api/file/documents/${item.id}/restore`, {}, {cookie})).statusCode, 200);
        assert.equal((await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items.length, 1);

        await post(`/api/file/documents/${item.id}/delete`, {}, {cookie});
        await pool.query("UPDATE clinical_documents SET deleted_at = now() - interval '31 days'");
        assert.equal((await post(`/api/file/documents/${item.id}/restore`, {}, {cookie})).statusCode, 404, 'too late');
        const filesBefore = (await readdir(config.documentDir)).length;
        assert.deepEqual(await purgeBin({pool, documents: app.documents}), {documents: 1, files: 1});
        assert.equal((await readdir(config.documentDir)).length, filesBefore - 1, 'the encrypted file is gone');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM clinical_document_files')).rows[0].n, 0);
    });
});

describe('taking over a lab result from the slip', () => {
    test('needs the code and the birth year or the last 3 digits; the doctor can still scan the slip', async () => {
        const lab = await approvedLab();
        const slip = (await labResult(lab)).json();
        assert.equal(slip.health_file.check, 'birth_year_or_phone');
        const {cookie, profile} = await patientWithConsent();
        const claim = check => post(`/api/file/profiles/${profile.id}/claim`, {code: slip.code, check}, {cookie});

        assert.equal((await claim('1991')).json().error, 'wrong_check');
        const res = await claim('1990');
        assert.equal(res.statusCode, 201);
        assert.equal(res.json().item.lab_name, 'Al Shifa Laboratory');
        assert.equal((await claim('1990')).statusCode, 200, 'taking it again is harmless');
        const [item] = (await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items;
        assert.deepEqual([item.source, item.category, item.title], ['lab_result', 'lab', 'Complete blood count']);
        const page = await get(`/api/file/documents/${item.id}/pages/1`, cookie);
        assert.equal(page.statusCode, 200);
        assert.match(page.rawPayload.toString('latin1'), /^%PDF/);

        const doctor = await approvedDoctor(post, undefined, undefined, {confirmed: true});
        assert.equal((await post('/api/doctor/results/lookup', {code: slip.code}, {cookie: doctor.cookie})).statusCode, 200, 'the slip still works for doctors');
    });

    test('the last 3 digits of the mobile number work too', async () => {
        const lab = await approvedLab();
        const slip = (await labResult(lab, {birth_year: ''})).json();
        assert.equal(slip.health_file.check, 'phone');
        const {cookie, profile} = await patientWithConsent();
        assert.equal((await post(`/api/file/profiles/${profile.id}/claim`, {code: slip.code, check: '1990'}, {cookie})).json().error, 'wrong_check');
        assert.equal((await post(`/api/file/profiles/${profile.id}/claim`, {code: slip.code, check: '678'}, {cookie})).statusCode, 201);
    });

    test('after 5 wrong tries the slip is locked until the lab prints a new one', async () => {
        const lab = await approvedLab();
        const slip = (await labResult(lab)).json();
        const {cookie, profile} = await patientWithConsent();
        for (let i = 0; i < LIMITS.claimAttempts; i++) {
            assert.equal((await post(`/api/file/profiles/${profile.id}/claim`, {code: slip.code, check: '2000'}, {cookie})).json().error, 'wrong_check');
        }
        const locked = await post(`/api/file/profiles/${profile.id}/claim`, {code: slip.code, check: '1990'}, {cookie});
        assert.equal(locked.statusCode, 423, 'even the right year is refused now');
        const fresh = (await post(`/api/lab/results/${slip.result.id}/code`, {}, {cookie: lab})).json();
        assert.equal((await post(`/api/file/profiles/${profile.id}/claim`, {code: fresh.code, check: '1990'}, {cookie})).statusCode, 201);
    });

    test('a result in someone else\'s file cannot be taken again, but can be reported', async () => {
        const lab = await approvedLab();
        const slip = (await labResult(lab)).json();
        const first = await patientWithConsent();
        await post(`/api/file/profiles/${first.profile.id}/claim`, {code: slip.code, check: '1990'}, {cookie: first.cookie});
        const second = await patientWithConsent('omar@example.org', 'Omar Saleh');
        const res = await post(`/api/file/profiles/${second.profile.id}/claim`, {code: slip.code, check: '1990'}, {cookie: second.cookie});
        assert.equal(res.statusCode, 409);
        assert.equal(res.json().error, 'already_claimed');
        assert.doesNotMatch(res.body, /Lina/, 'nothing about the other file');

        await signIn(post, 'admin', 'admin@example.org');
        mail.sent.length = 0;
        assert.equal((await post('/api/file/claim/report', {code: slip.code, note: 'This is my blood test'}, {cookie: second.cookie})).statusCode, 200);
        assert.match(mail.sent.find(m => m.to === 'admin@example.org').text, /This is my blood test/);
        assert.ok((await pool.query('SELECT claim_reported_at FROM lab_results')).rows[0].claim_reported_at);
    });

    test('older slips (printed before the health file) and unknown codes cannot be taken over', async () => {
        const lab = await approvedLab();
        const slip = (await labResult(lab)).json();
        await pool.query('UPDATE lab_results SET slip_version = 1');
        const {cookie, profile} = await patientWithConsent();
        assert.equal((await post(`/api/file/profiles/${profile.id}/claim`, {code: slip.code, check: '1990'}, {cookie})).json().error, 'code_invalid');
        assert.equal((await post(`/api/file/profiles/${profile.id}/claim`, {code: 'AAAA-BBBB-CCCC', check: '1990'}, {cookie})).json().error, 'code_invalid');
    });

    test('the lab checks the birth year', async () => {
        const lab = await approvedLab();
        assert.equal((await labResult(lab, {birth_year: '85'})).json().error, 'invalid_birth_year');
        assert.equal((await labResult(lab, {birth_year: '2999'})).json().error, 'invalid_birth_year');
    });
});

describe('appointments for a child', () => {
    test('are booked for the child\'s profile; someone else\'s profile is not found', async () => {
        const doctor = await approvedDoctor(post);
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org');
        const child = (await post('/api/file/profiles', {name: 'Sami Haddad', birth_date: '2021-03-01'}, {cookie})).json().profile;
        const day = addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
        const slots = (await get(`/api/doctors/${doctor.id}/slots?from=${day}&days=1`, cookie)).json().slots;
        const res = await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[0].starts_at, subject_id: child.id}, {cookie});
        assert.equal(res.statusCode, 201);
        assert.equal((await pool.query('SELECT subject_id FROM appointments')).rows[0].subject_id, child.id);
        const own = await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[1].starts_at}, {cookie});
        assert.equal((await pool.query('SELECT subject_id FROM appointments WHERE id = $1', [own.json().appointment.id])).rows[0].subject_id, (await self(cookie)).id);

        const omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Saleh');
        assert.equal((await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[2].starts_at, subject_id: child.id}, {cookie: omar})).statusCode, 404);
    });
});
