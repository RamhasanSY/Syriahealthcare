import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, config, cookieOf, origin, pool, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';
import {multipart, PDF} from './fixtures.js';
import {addDays, localDate} from '../src/slots.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});

async function patientWithEntries(email = 'lina@example.org', name = 'Lina Haddad', titles = ['Cardiology report', 'Blood test']) {
    const cookie = await signInPatientByEmail(post, mail, email, name);
    const profile = (await get('/api/file', cookie)).json().profiles[0];
    await post(`/api/file/profiles/${profile.id}/consent`, {}, {cookie});
    const items = [];
    for (const title of titles) {
        const form = multipart({category: 'report', title}, [{filename: 'r.pdf', type: 'application/pdf', content: PDF}]);
        items.push((await app.inject({method: 'POST', url: `/api/file/profiles/${profile.id}/documents`, payload: form.body,
            headers: {origin, cookie, 'content-type': form.contentType}})).json().item);
    }
    return {cookie, profile, items};
}

// The doctor confirms with the emailed code (second factor) in this session.
async function confirmDoctor(cookie, email = 'dr@example.org', remember = false) {
    const challenge = (await post('/api/auth/step-up/request', {}, {cookie})).json().challenge;
    const code = mail.sent.filter(m => m.to === email).at(-1).subject.match(/\d{6}/)?.[0] ?? mail.sent.filter(m => m.to === email).at(-1).text.match(/\b\d{6}\b/)[0];
    return post('/api/auth/step-up/verify', {challenge, code, remember}, {cookie});
}

describe('second factor for doctors', () => {
    test('shared entries need an emailed code in this session; it also confirms the email address', async () => {
        const doctor = await approvedDoctor(post);
        const {cookie, profile, items} = await patientWithEntries();
        await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: doctor.id, item_ids: [items[0].id]}, {cookie});
        const before = await get(`/api/doctor/patients/${profile.id}`, doctor.cookie);
        assert.equal(before.statusCode, 403);
        assert.equal(before.json().error, 'second_factor_required');
        assert.equal((await get('/api/doctor/patients', doctor.cookie)).json().second_factor, false);

        const res = await confirmDoctor(doctor.cookie);
        assert.equal(res.statusCode, 200);
        assert.equal((await get(`/api/doctor/patients/${profile.id}`, doctor.cookie)).statusCode, 200);
        assert.ok((await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [doctor.id])).rows[0].email_verified_at);
    });

    test('a wrong code is refused, and "remember this device" skips the code at the next sign-in', async () => {
        const doctor = await approvedDoctor(post);
        const challenge = (await post('/api/auth/step-up/request', {}, {cookie: doctor.cookie})).json().challenge;
        assert.equal((await post('/api/auth/step-up/verify', {challenge, code: '000000'}, {cookie: doctor.cookie})).json().error, 'wrong_code');
        const ok = await confirmDoctor(doctor.cookie, 'dr@example.org', true);
        const device = ok.cookies.find(c => c.name === 'shc_device');
        assert.ok(device, 'device cookie set');
        const login = await post('/api/auth/login', {email: 'dr@example.org', password: 'doctor password 123'}, {cookie: `shc_device=${device.value}`});
        const session = cookieOf(login);
        assert.equal((await get('/api/doctor/patients', session)).json().second_factor, true, 'no code needed on this device');
        const elsewhere = cookieOf(await post('/api/auth/login', {email: 'dr@example.org', password: 'doctor password 123'}));
        assert.equal((await get('/api/doctor/patients', elsewhere)).json().second_factor, false, 'another device needs the code');
    });
});

describe('sharing single entries', () => {
    test('a doctor without a share finds nothing; with a share exactly the shared entry; after revoking nothing again', async () => {
        const doctor = await approvedDoctor(post);
        await confirmDoctor(doctor.cookie);
        const {cookie, profile, items} = await patientWithEntries();
        const page = id => get(`/api/doctor/shared/${id}/pages/1`, doctor.cookie);
        assert.equal((await get(`/api/doctor/patients/${profile.id}`, doctor.cookie)).statusCode, 404);
        assert.equal((await page(items[0].id)).statusCode, 404);

        mail.sent.length = 0;
        const share = await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: doctor.id, item_ids: [items[0].id], days: 30}, {cookie});
        assert.equal(share.statusCode, 201);
        assert.ok(mail.sent.some(m => m.to === 'dr@example.org'), 'the doctor is told');
        const view = (await get(`/api/doctor/patients/${profile.id}`, doctor.cookie)).json();
        assert.equal(view.patient.patient_number, profile.patient_number);
        assert.deepEqual(view.items.map(i => i.title), ['Cardiology report'], 'only the shared entry');
        assert.equal((await page(items[0].id)).statusCode, 200);
        assert.equal((await page(items[1].id)).statusCode, 404, 'the other entry stays private');

        const access = (await get(`/api/file/profiles/${profile.id}/access`, cookie)).json();
        assert.equal(access.shares[0].active, true);
        assert.ok(access.log.some(l => l.action === 'health_document.viewed' && l.doctor_name === 'Dr. Approved'), 'the patient sees who opened it');
        assert.doesNotMatch(JSON.stringify(access), /127\.0\.0\.1|"ip"/, 'no network addresses');

        await post(`/api/file/shares/${share.json().share.id}/revoke`, {}, {cookie});
        assert.equal((await page(items[0].id)).statusCode, 404, 'revoked at once');
        assert.equal((await get(`/api/doctor/patients/${profile.id}`, doctor.cookie)).statusCode, 404);
    });

    test('one entry can be taken out of a share; the rest stays; an expired share ends by itself', async () => {
        const doctor = await approvedDoctor(post);
        await confirmDoctor(doctor.cookie);
        const {cookie, profile, items} = await patientWithEntries();
        const share = (await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: doctor.id, item_ids: items.map(i => i.id), days: 1}, {cookie})).json().share;
        await post(`/api/file/shares/${share.id}/items/${items[1].id}/revoke`, {}, {cookie});
        assert.equal((await get(`/api/doctor/shared/${items[1].id}/pages/1`, doctor.cookie)).statusCode, 404);
        assert.equal((await get(`/api/doctor/shared/${items[0].id}/pages/1`, doctor.cookie)).statusCode, 200);
        await pool.query("UPDATE access_grants SET starts_at = now() - interval '2 days', expires_at = now() - interval '1 day'");
        assert.equal((await get(`/api/doctor/shared/${items[0].id}/pages/1`, doctor.cookie)).statusCode, 404, 'expired');
    });

    test('labs, administrators, other doctors and other patients never get in', async () => {
        const doctor = await approvedDoctor(post);
        const other = await approvedDoctor(post, 'other@example.org', 'Dr. Other');
        await confirmDoctor(other.cookie, 'other@example.org');
        const {cookie, profile, items} = await patientWithEntries();
        await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: doctor.id, item_ids: [items[0].id]}, {cookie});
        assert.equal((await get(`/api/doctor/shared/${items[0].id}/pages/1`, other.cookie)).statusCode, 404);
        const lab = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email: 'lab@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
        const admin = await signIn(post, 'admin', 'admin@example.org');
        for (const c of [lab, admin]) {
            assert.equal((await get(`/api/doctor/shared/${items[0].id}/pages/1`, c)).statusCode, 403);
            assert.equal((await get(`/api/file/profiles/${profile.id}/access`, c)).statusCode, 403);
        }
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Saleh');
        assert.equal((await get(`/api/file/profiles/${profile.id}/access`, omar)).statusCode, 404);
        assert.equal((await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: doctor.id, item_ids: [items[0].id]}, {cookie: omar})).statusCode, 404);
        const share = (await get(`/api/file/profiles/${profile.id}/access`, cookie)).json().shares[0];
        assert.equal((await post(`/api/file/shares/${share.id}/revoke`, {}, {cookie: omar})).statusCode, 404);
    });

    test('only own, existing entries can be shared, and only with approved doctors', async () => {
        const {cookie, profile, items} = await patientWithEntries();
        const pending = await signIn(post, 'doctor', 'new@example.org', 'Dr. New');
        const {rows: [{id: pendingId}]} = await pool.query("SELECT id FROM users WHERE email = 'new@example.org'");
        assert.equal((await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: pendingId, item_ids: [items[0].id]}, {cookie})).statusCode, 404);
        const doctor = await approvedDoctor(post);
        const omar = await patientWithEntries('omar@example.org', 'Omar Saleh', ['Omar report']);
        assert.equal((await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: doctor.id, item_ids: [omar.items[0].id]}, {cookie})).json().error, 'invalid_items');
        assert.equal((await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: doctor.id, item_ids: [items[0].id], days: 7}, {cookie})).statusCode, 400, 'only 1, 30 or 90 days');
        assert.ok(pending);
    });
});

describe('show to the doctor (QR, 15 minutes)', () => {
    test('the code works once, for 15 minutes, and only for the chosen entries', async () => {
        const doctor = await approvedDoctor(post);
        await confirmDoctor(doctor.cookie);
        const second = await approvedDoctor(post, 'second@example.org', 'Dr. Second');
        await confirmDoctor(second.cookie, 'second@example.org');
        const {cookie, profile, items} = await patientWithEntries();
        const code = (await post(`/api/file/profiles/${profile.id}/share-codes`, {item_ids: [items[1].id]}, {cookie})).json();
        assert.match(code.code, /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
        assert.match(code.qr_svg, /^<svg/);
        const redeemed = await post('/api/doctor/share-codes/redeem', {code: code.code.toLowerCase().replace('-', ' ')}, {cookie: doctor.cookie});
        assert.equal(redeemed.statusCode, 200);
        assert.equal(redeemed.json().patient_id, profile.id);
        assert.equal((await get(`/api/doctor/shared/${items[1].id}/pages/1`, doctor.cookie)).statusCode, 200);
        assert.equal((await get(`/api/doctor/shared/${items[0].id}/pages/1`, doctor.cookie)).statusCode, 404);
        assert.equal((await post('/api/doctor/share-codes/redeem', {code: code.code}, {cookie: second.cookie})).json().error, 'share_code_invalid', 'once only');
        const {rows: [g]} = await pool.query("SELECT extract(epoch FROM expires_at - starts_at)::float AS seconds FROM access_grants WHERE source = 'qr'");
        assert.ok(Math.abs(g.seconds - 900) < 5, `${g.seconds} s`);

        const late = (await post(`/api/file/profiles/${profile.id}/share-codes`, {item_ids: [items[0].id]}, {cookie})).json();
        await pool.query("UPDATE share_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL");
        assert.equal((await post('/api/doctor/share-codes/redeem', {code: late.code}, {cookie: second.cookie})).json().error, 'share_code_invalid', 'expired');
    });
});

describe('sharing when booking', () => {
    test('lasts until 30 days after the appointment', async () => {
        const doctor = await approvedDoctor(post);
        await confirmDoctor(doctor.cookie);
        const {cookie, profile, items} = await patientWithEntries();
        const day = addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
        const slots = (await get(`/api/doctors/${doctor.id}/slots?from=${day}&days=1`)).json().slots;
        const res = await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[0].starts_at, share_item_ids: [items[0].id]}, {cookie});
        assert.equal(res.statusCode, 201);
        const {rows: [g]} = await pool.query('SELECT g.source, g.expires_at, a.ends_at FROM access_grants g JOIN appointments a ON a.id = g.appointment_id');
        assert.equal(g.source, 'booking');
        assert.equal(new Date(g.expires_at).getTime() - new Date(g.ends_at).getTime(), 30 * 86400_000);
        assert.equal((await get(`/api/doctor/shared/${items[0].id}/pages/1`, doctor.cookie)).statusCode, 200);
        assert.ok(profile);
    });
});

describe('My patients (doctors)', () => {
    test('one list from appointments, scanned slips and shares, searchable on the server', async () => {
        const doctor = await approvedDoctor(post);
        const {cookie, profile, items} = await patientWithEntries();
        const day = addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
        const slots = (await get(`/api/doctors/${doctor.id}/slots?from=${day}&days=1`)).json().slots;
        await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[0].starts_at}, {cookie});
        await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: doctor.id, item_ids: [items[0].id]}, {cookie});
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Saleh');
        await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[1].starts_at}, {cookie: omar});

        const before = (await get('/api/doctor/patients', doctor.cookie)).json();
        assert.equal(before.patients.length, 2, 'appointments only, shares need the second factor');
        await confirmDoctor(doctor.cookie);
        const list = (await get('/api/doctor/patients', doctor.cookie)).json().patients;
        const lina = list.find(p => p.name === 'Lina Haddad');
        assert.deepEqual(lina.sources, {appointments: 1, scans: 0, shares: 1}, 'one person, both sources');
        assert.equal(lina.patient_number, profile.patient_number);
        assert.deepEqual((await get('/api/doctor/patients?q=omar', doctor.cookie)).json().patients.map(p => p.name), ['Omar Saleh']);
        assert.deepEqual((await get(`/api/doctor/patients?q=${profile.patient_number.slice(4, 8)}`, doctor.cookie)).json().patients.map(p => p.name), ['Lina Haddad']);
    });

    test('a patient can take a scanned lab slip back from a doctor', async () => {
        const doctor = await approvedDoctor(post);
        await confirmDoctor(doctor.cookie);
        const lab = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email: 'lab@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
        await pool.query("UPDATE facility_profiles SET status = 'approved', facility_name = 'Al Shifa Laboratory'");
        const form = multipart({patient_name: 'Lina Haddad', patient_phone: '0912 345 678', title: 'Complete blood count', birth_year: '1990'},
            [{name: 'file', filename: 'cbc.pdf', type: 'application/pdf', content: PDF}]);
        const slip = (await app.inject({method: 'POST', url: '/api/lab/results', payload: form.body, headers: {origin, cookie: lab, 'content-type': form.contentType}})).json();
        await post('/api/doctor/results/add', {code: slip.code}, {cookie: doctor.cookie});
        const {cookie, profile} = await patientWithEntries('lina@example.org', 'Lina Haddad', []);
        const item = (await post(`/api/file/profiles/${profile.id}/claim`, {code: slip.code, check: '1990'}, {cookie})).json().item;
        assert.equal((await get(`/api/doctor/shared/${item.id}/pages/1`, doctor.cookie)).statusCode, 200, 'the scan counts as access');
        const access = (await get(`/api/file/profiles/${profile.id}/access`, cookie)).json();
        assert.equal(access.scans[0].doctor.name, 'Dr. Approved');
        await post(`/api/file/scans/${slip.result.id}/revoke`, {doctor_id: doctor.id}, {cookie});
        assert.equal((await get(`/api/doctor/shared/${item.id}/pages/1`, doctor.cookie)).statusCode, 404);
        assert.equal((await get('/api/doctor/records', doctor.cookie)).json().patients.length, 0, 'gone from the doctor\'s files too');
    });

    test('with HEALTH_FILE off there is no sharing at all', async () => {
        const doctor = await approvedDoctor(post);
        config.healthFile = false;
        try {
            assert.equal((await get('/api/doctor/patients', doctor.cookie)).statusCode, 404);
        } finally {
            config.healthFile = true;
        }
    });
});
