import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {config, cookieOf, pool, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';
import {PDF} from './fixtures.js';
import {parseMessage} from '../src/hl7v2.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});
const PDF64 = PDF.toString('base64');

async function facility(kind = 'lab', email = 'lab@example.org', name = 'Al Shifa Laboratory') {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind}));
    const {rows: [f]} = await pool.query(`UPDATE facility_profiles p SET status = 'approved', facility_name = $2 FROM users u
        WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id`, [email, name]);
    return {cookie, id: f.user_id};
}

async function client(facilityId, scopes = ['system/DiagnosticReport.c']) {
    const admin = await signIn(post, 'admin', `admin${Math.random()}@example.org`);
    const res = await post('/api/admin/api-clients', {facility_id: facilityId, name: 'LabSoft 5', scopes}, {cookie: admin});
    assert.equal(res.statusCode, 201, res.body);
    return {...res.json(), admin};
}

const tokenRequest = (id, secret, scope) => app.inject({method: 'POST', url: '/oauth/token',
    headers: {'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')},
    payload: `grant_type=client_credentials${scope ? '&scope=' + encodeURIComponent(scope) : ''}`});
async function token(c, scope) {
    const res = await tokenRequest(c.client.client_id, c.client_secret, scope);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().access_token;
}

// A patient with a health file, a birth date and a SyriaHC number.
async function patient() {
    const cookie = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
    const profile = (await get('/api/file', cookie)).json().profiles[0];
    await post(`/api/file/profiles/${profile.id}/consent`, {}, {cookie});
    await post(`/api/file/profiles/${profile.id}`, {birth_date: '1990-04-02'}, {cookie});
    return {cookie, profile};
}

const reportBundle = ({number, birthDate = '1990-04-02', labNumber = 'LAB-2026-0001', phone = '+963912345678', extraEntries = []} = {}) => ({
    resourceType: 'Bundle', type: 'transaction',
    entry: [
        {fullUrl: 'urn:uuid:11111111-1111-4111-8111-111111111111', resource: {resourceType: 'Patient',
            identifier: number ? [{system: 'https://syriahc.com/fhir/sid/patient-number', value: number}] : [],
            name: [{family: 'Haddad', given: ['Lina']}], telecom: [{system: 'phone', value: phone}], birthDate},
            request: {method: 'POST', url: 'Patient'}},
        {fullUrl: 'urn:uuid:22222222-2222-4222-8222-222222222222', resource: {resourceType: 'Observation', status: 'final',
            code: {coding: [{system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin'}]},
            valueQuantity: {value: 13.2, unit: 'g/dL', system: 'http://unitsofmeasure.org', code: 'g/dL'}}, request: {method: 'POST', url: 'Observation'}},
        {fullUrl: 'urn:uuid:33333333-3333-4333-8333-333333333333', resource: {resourceType: 'DiagnosticReport', status: 'final',
            identifier: [{system: 'urn:labsoft:accession', value: labNumber}],
            category: [{coding: [{system: 'http://terminology.hl7.org/CodeSystem/v2-0074', code: 'LAB'}]}],
            code: {text: 'Complete blood count'}, subject: {reference: 'urn:uuid:11111111-1111-4111-8111-111111111111'},
            result: [{reference: 'urn:uuid:22222222-2222-4222-8222-222222222222'}],
            presentedForm: [{contentType: 'application/pdf', data: PDF64, title: 'cbc.pdf'}]},
            request: {method: 'POST', url: 'DiagnosticReport', ifNoneExist: `identifier=urn:labsoft:accession|${labNumber}`}},
        ...extraEntries
    ]
});
const sendBundle = (bundle, accessToken, cookie) => app.inject({method: 'POST', url: '/fhir/r4', payload: JSON.stringify(bundle),
    headers: {'content-type': 'application/fhir+json', ...(accessToken && {authorization: `Bearer ${accessToken}`}), ...(cookie && {cookie})}});

describe('OAuth 2.0 client credentials', () => {
    test('a token only with the right secret; the secret is shown once and stored as a hash', async () => {
        const lab = await facility();
        const c = await client(lab.id);
        assert.match(c.client.client_id, /^shc_[a-z0-9]{20}$/);
        assert.equal((await tokenRequest(c.client.client_id, 'wrong secret')).statusCode, 401);
        assert.equal((await tokenRequest(c.client.client_id, 'wrong secret')).json().error, 'invalid_client');
        const res = await tokenRequest(c.client.client_id, c.client_secret);
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().token_type, 'Bearer');
        assert.equal(res.json().expires_in, 900);
        assert.equal(res.headers['cache-control'], 'no-store');
        const {rows: [stored]} = await pool.query('SELECT secret_hash FROM api_clients');
        assert.ok(!stored.secret_hash.includes(c.client_secret));
        const list = (await get('/api/admin/api-clients', c.admin)).json();
        assert.doesNotMatch(JSON.stringify(list), new RegExp(c.client_secret), 'never shown again');
        assert.equal((await tokenRequest(c.client.client_id, c.client_secret, 'system/DocumentReference.c')).json().error, 'invalid_scope');
    });

    test('a suspended facility or a revoked client stops working at once, also with a token already issued', async () => {
        const lab = await facility();
        const c = await client(lab.id);
        const accessToken = await token(c);
        await pool.query("UPDATE facility_profiles SET status = 'suspended' WHERE user_id = $1", [lab.id]);
        assert.equal((await sendBundle(reportBundle(), accessToken)).statusCode, 401, 'the token is useless now');
        assert.equal((await tokenRequest(c.client.client_id, c.client_secret)).statusCode, 401);
        await pool.query("UPDATE facility_profiles SET status = 'approved' WHERE user_id = $1", [lab.id]);
        await post(`/api/admin/api-clients/${c.client.id}/revoke`, {}, {cookie: c.admin});
        assert.equal((await tokenRequest(c.client.client_id, c.client_secret)).statusCode, 401);
    });

    test('only administrators create clients, and only labs and imaging centres may send results', async () => {
        const lab = await facility();
        const hospital = await facility('hospital', 'hospital@example.org', 'City Hospital');
        assert.equal((await post('/api/admin/api-clients', {facility_id: lab.id, name: 'X', scopes: ['system/DiagnosticReport.c']}, {cookie: lab.cookie})).statusCode, 403);
        const admin = await signIn(post, 'admin', 'admin@example.org');
        assert.equal((await post('/api/admin/api-clients', {facility_id: hospital.id, name: 'HIS', scopes: ['system/DiagnosticReport.c']}, {cookie: admin})).json().error, 'invalid_scope');
        assert.equal((await post('/api/admin/api-clients', {facility_id: hospital.id, name: 'HIS', scopes: ['system/DocumentReference.c']}, {cookie: admin})).statusCode, 201);
    });
});

describe('FHIR transaction from lab software', () => {
    test('with the right SyriaHC number and birth year the result goes straight into the file', async () => {
        const lab = await facility();
        const accessToken = await token(await client(lab.id));
        const {cookie, profile} = await patient();
        const res = await sendBundle(reportBundle({number: profile.patient_number}), accessToken);
        assert.equal(res.statusCode, 200, res.body);
        const body = res.json();
        assert.equal(body.type, 'transaction-response');
        const report = body.entry[2].response;
        assert.equal(report.status, '201 Created');
        assert.equal(report.outcome.issue[0].details.text, 'delivered');
        assert.doesNotMatch(res.body, /Lina|1990|SHC-/, 'nothing from the file comes back');
        const items = (await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items;
        assert.deepEqual(items.map(i => [i.title, i.lab_name]), [['Complete blood count', 'Al Shifa Laboratory']]);
        const {rows: [stored]} = await pool.query('SELECT source, external_id, observations FROM lab_results');
        assert.equal(stored.source, 'fhir');
        assert.equal(stored.observations[0].code.code, '718-7');
        assert.equal(stored.observations[0].ucum, 'g/dL');
    });

    test('without a matching birth year it stays a slip result, and the lab gets a code to print', async () => {
        const lab = await facility();
        const accessToken = await token(await client(lab.id));
        const {cookie, profile} = await patient();
        const res = await sendBundle(reportBundle({number: profile.patient_number, birthDate: '1991-04-02'}), accessToken);
        const outcome = res.json().entry[2].response.outcome.issue[0];
        assert.equal(outcome.details.text, 'not-delivered');
        const code = outcome.diagnostics.match(/[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/)[0];
        assert.equal((await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items.length, 0);
        const doctor = await signIn(post, 'doctor', 'dr@example.org');
        await pool.query("UPDATE doctor_profiles SET status = 'approved'");
        assert.equal((await post('/api/doctor/results/lookup', {code}, {cookie: doctor})).statusCode, 200, 'the slip code works as always');
    });

    test('the same lab number twice gives one result; the sender comes from the token, not from the message', async () => {
        const lab = await facility();
        const accessToken = await token(await client(lab.id));
        const first = await sendBundle(reportBundle(), accessToken);
        const again = await sendBundle(reportBundle(), accessToken);
        assert.equal(first.json().entry[2].response.status, '201 Created');
        assert.equal(again.json().entry[2].response.status, '200 OK');
        const {rows} = await pool.query('SELECT facility_id FROM lab_results');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].facility_id, lab.id);
    });

    test('no token, a cookie, or the wrong scope is refused; missing parts get an OperationOutcome; over 8 MB is 413', async () => {
        const lab = await facility();
        const c = await client(lab.id);
        const accessToken = await token(c);
        assert.equal((await sendBundle(reportBundle())).statusCode, 401);
        assert.equal((await sendBundle(reportBundle(), null, lab.cookie)).statusCode, 401, 'a browser session never writes');
        const docBundle = {resourceType: 'Bundle', type: 'transaction', entry: [{resource: {resourceType: 'DocumentReference', status: 'current',
            masterIdentifier: {value: 'DOC-1'}, content: [{attachment: {contentType: 'application/pdf', data: PDF64}}]}}]};
        assert.equal((await sendBundle(docBundle, accessToken)).statusCode, 403, 'documents need system/DocumentReference.c');
        const noPhone = await sendBundle(reportBundle({phone: 'none'}), accessToken);
        assert.equal(noPhone.statusCode, 400);
        assert.equal(noPhone.json().resourceType, 'OperationOutcome');
        assert.equal((await sendBundle({resourceType: 'Bundle', type: 'batch', entry: []}, accessToken)).statusCode, 400);
        const huge = await app.inject({method: 'POST', url: '/fhir/r4', payload: '{"x":"' + 'a'.repeat(8 * 1024 * 1024 + 10) + '"}',
            headers: {'content-type': 'application/fhir+json', authorization: `Bearer ${accessToken}`}});
        assert.equal(huge.statusCode, 413);
    });

    test('IHE MHD ITI-65: a discharge letter from a hospital goes into the file', async () => {
        const hospital = await facility('hospital', 'hospital@example.org', 'City Hospital');
        const accessToken = await token(await client(hospital.id, ['system/DocumentReference.c']));
        const {cookie, profile} = await patient();
        const bundle = {resourceType: 'Bundle', type: 'transaction', entry: [
            {fullUrl: 'urn:uuid:aaaaaaaa-1111-4111-8111-111111111111', resource: {resourceType: 'List', status: 'current', mode: 'working',
                code: {coding: [{system: 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes', code: 'submissionset'}]},
                entry: [{item: {reference: 'urn:uuid:aaaaaaaa-2222-4222-8222-222222222222'}}]}, request: {method: 'POST', url: 'List'}},
            {fullUrl: 'urn:uuid:aaaaaaaa-2222-4222-8222-222222222222', resource: {resourceType: 'DocumentReference', status: 'current',
                masterIdentifier: {system: 'urn:ietf:rfc:3986', value: 'urn:oid:1.2.3.4.2026.77'},
                type: {coding: [{system: 'http://loinc.org', code: '18842-5', display: 'Discharge summary'}]}, description: 'Discharge letter, cardiology',
                subject: {reference: 'urn:uuid:aaaaaaaa-3333-4333-8333-333333333333'},
                content: [{attachment: {contentType: 'application/pdf', url: 'urn:uuid:aaaaaaaa-4444-4444-8444-444444444444', title: 'discharge.pdf'}}]},
                request: {method: 'POST', url: 'DocumentReference'}},
            {fullUrl: 'urn:uuid:aaaaaaaa-3333-4333-8333-333333333333', resource: {resourceType: 'Patient',
                identifier: [{system: 'https://syriahc.com/fhir/sid/patient-number', value: profile.patient_number}],
                name: [{text: 'Lina Haddad'}], telecom: [{system: 'phone', value: '0912 345 678'}], birthDate: '1990-04-02'}, request: {method: 'POST', url: 'Patient'}},
            {fullUrl: 'urn:uuid:aaaaaaaa-4444-4444-8444-444444444444', resource: {resourceType: 'Binary', contentType: 'application/pdf', data: PDF64},
                request: {method: 'POST', url: 'Binary'}}
        ]};
        const res = await sendBundle(bundle, accessToken);
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.json().entry[1].response.outcome.issue[0].details.text, 'delivered');
        const items = (await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items;
        assert.deepEqual(items.map(i => [i.category, i.title]), [['discharge', 'Discharge letter, cardiology']]);
    });
});

describe('HL7 v2 over HTTPS', () => {
    const oru = ({number = '', labNumber = 'LAB-77', dob = '19900402', control = 'MSG0001'} = {}) => [
        `MSH|^~\\&|LabSoft|AlShifa|SyriaHC|SyriaHC|20261109101500||ORU^R01^ORU_R01|${control}|P|2.5.1`,
        `PID|1||${number}^^^SyriaHC||Haddad^Lina||${dob}|F|||||0912345678`,
        `OBR|1||${labNumber}|CBC^Complete blood count|||20261109090000`,
        'OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL^grams per decilitre^UCUM|12-16|N|||F',
        `OBX|2|ED|PDF^Report^L||^application^pdf^Base64^${PDF64}||||||F`
    ].join('\r');
    const sendV2 = (text, accessToken) => app.inject({method: 'POST', url: '/hl7v2', payload: text,
        headers: {'content-type': 'x-application/hl7-v2+er7', ...(accessToken && {authorization: `Bearer ${accessToken}`})}});
    const msa = res => parseMessage(res.body).segments.find(s => s.id === 'MSA').fields;

    test('ORU^R01 is stored like the FHIR result, answered with ACK AA', async () => {
        const lab = await facility();
        const accessToken = await token(await client(lab.id));
        const {cookie, profile} = await patient();
        const res = await sendV2(oru({number: profile.patient_number}), accessToken);
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /hl7-v2/);
        const [, code, control, text] = msa(res);
        assert.deepEqual([code, control], ['AA', 'MSG0001']);
        assert.match(text, /Delivered/);
        assert.match(res.body, /^MSH\|\^~\\&\|SyriaHC\|SyriaHC\|LabSoft\|AlShifa\|\d{14}\|\|ACK\^R01\^ACK/);
        const {rows: [stored]} = await pool.query('SELECT source, external_id, title, observations FROM lab_results');
        assert.deepEqual([stored.source, stored.external_id, stored.title], ['hl7v2', 'LAB-77', 'Complete blood count']);
        assert.equal(stored.observations[0].code.system, 'http://loinc.org');
        assert.equal((await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items.length, 1);
        assert.match(msa(await sendV2(oru({number: profile.patient_number, control: 'MSG0002'}), accessToken))[3], /^Received before\. Delivered/, 'the same lab number again');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM lab_results')).rows[0].n, 1);
    });

    test('MDM^T02 brings a document', async () => {
        const hospital = await facility('hospital', 'hospital@example.org', 'City Hospital');
        const accessToken = await token(await client(hospital.id, ['system/DocumentReference.c']));
        const {cookie, profile} = await patient();
        const mdm = [
            'MSH|^~\\&|HIS|CityHospital|SyriaHC|SyriaHC|20261109101500||MDM^T02^MDM_T02|DOC77|P|2.5.1',
            'EVN|T02|20261109101500',
            `PID|1||${profile.patient_number}^^^SyriaHC||Haddad^Lina||19900402|F|||||0912345678`,
            'PV1|1|I',
            'TXA|1|18842-5^Discharge letter|AP|||||||||DOC-2026-77||||||AU',
            `OBX|1|ED|18842-5^Discharge summary^LN||^application^pdf^Base64^${PDF64}||||||F`
        ].join('\r');
        const res = await sendV2(mdm, accessToken);
        assert.equal(msa(res)[1], 'AA', res.body);
        const items = (await get(`/api/file/profiles/${profile.id}/items`, cookie)).json().items;
        assert.deepEqual(items.map(i => [i.category, i.title]), [['discharge', 'Discharge letter']]);
    });

    test('a faulty message gets AE with an ERR segment; no token or the wrong scope gets AR', async () => {
        const lab = await facility();
        const accessToken = await token(await client(lab.id));
        const noObr = oru().split('\r').filter(l => !l.startsWith('OBR')).join('\r');
        const res = await sendV2(noObr, accessToken);
        assert.equal(msa(res)[1], 'AE');
        assert.ok(parseMessage(res.body).segments.some(s => s.id === 'ERR'));
        assert.equal(msa(await sendV2('not hl7 at all', accessToken)) [1], 'AE');
        const refused = await sendV2(oru());
        assert.equal(refused.statusCode, 401);
        assert.equal(msa(refused)[1], 'AR');
        const adt = oru().replace('ORU^R01^ORU_R01', 'ADT^A01^ADT_A01');
        assert.equal(msa(await sendV2(adt, accessToken))[1], 'AR', 'no patient admissions, no patient lookups');
        const docs = await token(await client(lab.id, ['system/DiagnosticReport.c']));
        const mdm = oru().replace('ORU^R01^ORU_R01', 'MDM^T02^MDM_T02') + '\rTXA|1|18842-5^Discharge letter|AP|||||||||DOC-1';
        assert.equal((await sendV2(mdm, docs)).statusCode, 403, 'documents need their own scope');
    });

    test('with the health file off, results are kept as slip results and nothing is delivered', async () => {
        const lab = await facility();
        const accessToken = await token(await client(lab.id));
        const {profile} = await patient();
        config.healthFile = false;
        try {
            const [, code, , text] = msa(await sendV2(oru({number: profile.patient_number}), accessToken));
            assert.equal(code, 'AA');
            assert.match(text, /Not delivered/);
        } finally {
            config.healthFile = true;
        }
    });
});
