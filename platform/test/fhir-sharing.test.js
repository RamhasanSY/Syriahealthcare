import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, origin, pool, setup, signInPatientByEmail, teardown} from './helpers.js';
import {multipart, PDF} from './fixtures.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});

async function sharedFile() {
    const cookie = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
    const profile = (await get('/api/file', cookie)).json().profiles[0];
    await post(`/api/file/profiles/${profile.id}/consent`, {}, {cookie});
    const items = [];
    for (const title of ['Shared report', 'Private report']) {
        const form = multipart({category: 'report', title}, [{filename: 'r.pdf', type: 'application/pdf', content: PDF}]);
        items.push((await app.inject({method: 'POST', url: `/api/file/profiles/${profile.id}/documents`, payload: form.body,
            headers: {origin, cookie, 'content-type': form.contentType}})).json().item);
    }
    const doctor = await approvedDoctor(post);
    const share = (await post(`/api/file/profiles/${profile.id}/shares`, {doctor_id: doctor.id, item_ids: [items[0].id], days: 30}, {cookie})).json().share;
    const challenge = (await post('/api/auth/step-up/request', {}, {cookie: doctor.cookie})).json().challenge;
    const code = mail.sent.filter(m => m.to === 'dr@example.org').at(-1).subject.match(/\d{6}/)[0];
    await post('/api/auth/step-up/verify', {challenge, code}, {cookie: doctor.cookie});
    return {cookie, profile, items, doctor, share};
}

describe('FHIR for doctors with a share (stage 2c)', () => {
    test('the doctor reads the patient and exactly the shared entries over FHIR, through the same rules', async () => {
        const {profile, items, doctor} = await sharedFile();
        assert.equal((await get(`/fhir/r4/Patient/${profile.id}`, doctor.cookie)).json().identifier[0].value, profile.patient_number);
        const docs = (await get(`/fhir/r4/DocumentReference?patient=${profile.id}`, doctor.cookie)).json();
        assert.deepEqual(docs.entry.map(e => e.resource.description), ['Shared report']);
        assert.equal((await get(`/fhir/r4/DocumentReference/${items[1].id}`, doctor.cookie)).statusCode, 404, 'the private entry does not exist for the doctor');
        const url = docs.entry[0].resource.content[0].attachment.url.replace(/^https?:\/\/[^/]+/, '');
        assert.equal((await get(url, doctor.cookie)).statusCode, 200);
        assert.equal((await get(`/fhir/r4/Patient/${profile.id}/$everything`, doctor.cookie)).statusCode, 404, 'the whole file is for the patient only');
        assert.equal((await get(`/fhir/r4/RelatedPerson/${profile.id}`, doctor.cookie)).statusCode, 404);
    });

    test('the share is a Consent with the doctor as actor, the entries as data and the period', async () => {
        const {cookie, profile, items, doctor, share} = await sharedFile();
        const patientView = (await get(`/fhir/r4/Consent?patient=${profile.id}`, cookie)).json().entry.map(e => e.resource);
        assert.equal(patientView.length, 2, 'the file consent and the share');
        const consent = patientView.find(c => c.id === share.id);
        assert.equal(consent.status, 'active');
        assert.equal(consent.provision.actor[0].reference.reference, `Practitioner/${doctor.id}`);
        assert.deepEqual(consent.provision.data.map(d => d.reference.reference), [`DocumentReference/${items[0].id}`]);
        assert.ok(consent.provision.period.end);
        assert.ok(consent.policy[0].uri);
        assert.equal(consent.scope.coding[0].code, 'patient-privacy');
        const doctorView = (await get(`/fhir/r4/Consent?patient=${profile.id}`, doctor.cookie)).json().entry.map(e => e.resource.id);
        assert.deepEqual(doctorView, [share.id], 'the doctor sees only their own share');

        await post(`/api/file/shares/${share.id}/revoke`, {}, {cookie});
        assert.equal((await get(`/fhir/r4/Patient/${profile.id}`, doctor.cookie)).statusCode, 404, 'after revoking, the patient is gone for the doctor');
        assert.equal((await get(`/fhir/r4/Consent?patient=${profile.id}`, cookie)).json().entry.find(e => e.resource.id === share.id).resource.status, 'inactive');
    });

    test('"who opened my file" as AuditEvent for the patient, without network addresses', async () => {
        const {cookie, profile, items, doctor} = await sharedFile();
        await get(`/api/doctor/shared/${items[0].id}/pages/1`, doctor.cookie);
        const events = (await get(`/fhir/r4/AuditEvent?patient=${profile.id}`, cookie)).json().entry.map(e => e.resource);
        const opened = events.find(e => e.agent[0].who.reference === `Practitioner/${doctor.id}` && e.subtype[0].code === 'read');
        assert.ok(opened, 'the doctor\'s view is listed');
        assert.equal(opened.entity.find(x => x.role.code === '1').what.reference, `Patient/${profile.id}`);
        assert.equal(JSON.stringify(events).includes('"network"'), false);
        assert.equal((await get(`/fhir/r4/AuditEvent?patient=${profile.id}`, doctor.cookie)).statusCode, 404, 'only the patient');
    });

    test('a doctor without the second factor gets 403; without a share 404', async () => {
        const {profile} = await sharedFile();
        const other = await approvedDoctor(post, 'other@example.org', 'Dr. Other');
        const res = await get(`/fhir/r4/Patient/${profile.id}`, other.cookie);
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().issue[0].code, 'security');
        const challenge = (await post('/api/auth/step-up/request', {}, {cookie: other.cookie})).json().challenge;
        const code = mail.sent.filter(m => m.to === 'other@example.org').at(-1).subject.match(/\d{6}/)[0];
        await post('/api/auth/step-up/verify', {challenge, code}, {cookie: other.cookie});
        assert.equal((await get(`/fhir/r4/Patient/${profile.id}`, other.cookie)).statusCode, 404);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM access_grants WHERE doctor_id = $1", [other.id])).rows[0].n, 0);
    });
});
