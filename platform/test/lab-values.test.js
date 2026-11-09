import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, cookieOf, pool, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';
import {PDF} from './fixtures.js';
import {flagOf, observationResources, valueRows} from '../src/lab-values.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});

describe('flags from the reference range', () => {
    test('ranges written in the usual ways', () => {
        assert.equal(flagOf('13.2', '12-16'), 'N');
        assert.equal(flagOf('11,5', '12 - 16'), 'L');
        assert.equal(flagOf('17', '12–16'), 'H');
        assert.equal(flagOf('182', '<200'), 'N');
        assert.equal(flagOf('240', '< 200'), 'H');
        assert.equal(flagOf('35', '>40'), 'L');
        assert.equal(flagOf('positive', '12-16'), null, 'text values get no calculated flag');
        assert.equal(flagOf('5', 'see report'), null);
    });

    test('the sender\'s flag wins, a calculated one is marked as such', () => {
        const rows = valueRows([
            {code: {system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin'}, value: '10.1', unit: 'g/dL', reference_range: '12-16', interpretation: 'LL'},
            {code: {code: 'CHOL', display: 'Cholesterol'}, value: '240', unit: 'mg/dL', reference_range: '<200'}
        ]);
        assert.deepEqual(rows.map(r => [r.name, r.flag, r.flag_calculated, r.loinc]), [['Hemoglobin', 'LL', false, '718-7'], ['Cholesterol', 'H', true, null]]);
    });

    test('FHIR Observations with quantity, interpretation and range', () => {
        const [obs] = observationResources([{code: {system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin'}, value: '13.2', unit: 'g/dL', ucum: 'g/dL', reference_range: '12-16'}],
            {subject: {reference: 'Patient/x'}, effective: '2026-11-09T10:00:00.000Z'});
        assert.deepEqual(obs.valueQuantity, {value: 13.2, unit: 'g/dL', system: 'http://unitsofmeasure.org', code: 'g/dL'});
        assert.equal(obs.interpretation[0].coding[0].code, 'N');
        assert.equal(obs.referenceRange[0].text, '12-16');
        assert.equal(obs.code.coding[0].code, '718-7');
    });
});

async function lab() {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email: 'lab@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
    const {rows: [f]} = await pool.query(`UPDATE facility_profiles p SET status = 'approved', facility_name = 'Al Shifa Laboratory' FROM users u
        WHERE u.id = p.user_id AND u.email = 'lab@example.org' RETURNING p.user_id`);
    const admin = await signIn(post, 'admin', 'admin@example.org');
    const created = (await post('/api/admin/api-clients', {facility_id: f.user_id, name: 'LabSoft', scopes: ['system/DiagnosticReport.c']}, {cookie: admin})).json();
    const token = (await app.inject({method: 'POST', url: '/oauth/token', headers: {'content-type': 'application/x-www-form-urlencoded'},
        payload: `grant_type=client_credentials&client_id=${created.client.client_id}&client_secret=${encodeURIComponent(created.client_secret)}`})).json().access_token;
    return {cookie, token};
}

const oru = (number, labNumber) => [
    `MSH|^~\\&|LabSoft|AlShifa|SyriaHC|SyriaHC|20261109101500||ORU^R01^ORU_R01|M${labNumber}|P|2.5.1`,
    `PID|1||${number}^^^SyriaHC||Haddad^Lina||19900402|F|||||0912345678`,
    `OBR|1||${labNumber}|LIPID^Lipid panel`,
    'OBX|1|NM|2093-3^Cholesterol^LN||240|mg/dL^mg/dL^UCUM|<200||||F',
    'OBX|2|NM|2085-9^HDL cholesterol^LN||52|mg/dL^mg/dL^UCUM|>40|N|||F',
    `OBX|3|ED|PDF^Report^L||^application^pdf^Base64^${PDF.toString('base64')}||||||F`
].join('\r');
const send = (token, text) => app.inject({method: 'POST', url: '/hl7v2', payload: text,
    headers: {'content-type': 'x-application/hl7-v2+er7', authorization: `Bearer ${token}`}});

describe('measured values in the health file and for doctors', () => {
    test('the patient sees the values as a table, each look recorded; FHIR has them as Observations', async () => {
        const {token} = await lab();
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
        const profile = (await get('/api/file', cookie)).json().profiles[0];
        await post(`/api/file/profiles/${profile.id}/consent`, {}, {cookie});
        await post(`/api/file/profiles/${profile.id}`, {birth_date: '1990-04-02'}, {cookie});
        await send(token, oru(profile.patient_number, 'L-1'));

        const [item] = (await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items;
        assert.equal(item.has_values, true);
        const values = (await get(`/api/file/documents/${item.id}/values`, cookie)).json().values;
        assert.deepEqual(values.map(v => [v.name, v.value, v.unit, v.range, v.flag]),
            [['Cholesterol', '240', 'mg/dL', '<200', 'H'], ['HDL cholesterol', '52', 'mg/dL', '>40', 'N']]);
        const {rows} = await pool.query("SELECT details FROM audit_log WHERE action = 'health_document.viewed'");
        assert.equal(rows[0].details.values, true);

        const report = (await get(`/fhir/r4/DiagnosticReport/${item.id}`, cookie)).json();
        assert.equal(report.contained.length, 2);
        assert.deepEqual(report.result.map(r => r.reference), ['#obs1', '#obs2']);
        assert.equal(report.contained[0].interpretation[0].coding[0].code, 'H');

        const other = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Saleh');
        assert.equal((await get(`/api/file/documents/${item.id}/values`, other)).statusCode, 404);
    });

    test('a doctor sees the values of a scanned slip and of a shared entry, nobody else', async () => {
        const {token} = await lab();
        const res = await send(token, oru('', 'L-2'));
        const code = res.body.match(/[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/)[0];
        const doctor = await approvedDoctor(post, undefined, undefined, {confirmed: true});
        const added = (await post('/api/doctor/results/add', {code}, {cookie: doctor.cookie})).json().result;
        assert.equal(added.has_values, true);
        const scanned = (await get(`/api/doctor/results/${added.id}/values`, doctor.cookie)).json().values;
        assert.equal(scanned[0].flag, 'H');
        const stranger = await approvedDoctor(post, 'stranger@example.org', 'Dr. Stranger', {confirmed: true});
        assert.equal((await get(`/api/doctor/results/${added.id}/values`, stranger.cookie)).statusCode, 404, 'not this doctor\'s slip');
        const other = await approvedDoctor(post, 'other@example.org', 'Dr. Other');
        assert.equal((await get(`/api/doctor/results/${added.id}/values`, other.cookie)).json().error, 'second_factor_required');

        // The patient takes the result into her file and shares it with a second doctor.
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
        const profile = (await get('/api/file', cookie)).json().profiles[0];
        await post(`/api/file/profiles/${profile.id}/consent`, {}, {cookie});
        const item = (await post(`/api/file/profiles/${profile.id}/claim`, {code, check: '678'}, {cookie})).json().item;
        await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: other.id, item_ids: [item.id]}, {cookie});
        assert.equal((await get(`/api/doctor/shared/${item.id}/values`, other.cookie)).json().error, 'second_factor_required');
        const challenge = (await post('/api/auth/step-up/request', {}, {cookie: other.cookie})).json().challenge;
        const stepCode = mail.sent.filter(m => m.to === 'other@example.org').at(-1).subject.match(/\d{6}/)[0];
        await post('/api/auth/step-up/verify', {challenge, code: stepCode}, {cookie: other.cookie});
        const shared = (await get(`/api/doctor/patients/${profile.id}`, other.cookie)).json().items;
        assert.equal(shared[0].has_values, true);
        assert.equal((await get(`/api/doctor/shared/${item.id}/values`, other.cookie)).json().values.length, 2);
    });
});
