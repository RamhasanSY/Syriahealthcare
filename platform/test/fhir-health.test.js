import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, config, cookieOf, origin, pool, setup, teardown, signInPatientByEmail} from './helpers.js';
import {jpegWithExif, multipart, PDF} from './fixtures.js';
import {addDays, localDate} from '../src/slots.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});
const NUMBER_SYSTEM = 'https://syriahc.com/fhir/sid/patient-number';

// A patient with consent, one uploaded photo, one lab result taken over from a slip, and a child with a booked appointment.
async function fullFile() {
    const cookie = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
    const self = (await get('/api/file', cookie)).json().profiles[0];
    await post(`/api/file/profiles/${self.id}/consent`, {}, {cookie});
    const upload = multipart({category: 'imaging', title: 'Chest X-ray', document_date: '2026-10-05'}, [{filename: 'xray.jpg', type: 'image/jpeg', content: jpegWithExif()}]);
    const photo = (await app.inject({method: 'POST', url: `/api/file/profiles/${self.id}/documents`, payload: upload.body,
        headers: {origin, cookie, 'content-type': upload.contentType}})).json().item;

    const lab = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email: 'lab@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
    await pool.query("UPDATE facility_profiles SET status = 'approved', facility_name = 'Al Shifa Laboratory'");
    const form = multipart({patient_name: 'Lina Haddad', patient_phone: '0912 345 678', title: 'Complete blood count', birth_year: '1990'},
        [{name: 'file', filename: 'cbc.pdf', type: 'application/pdf', content: PDF}]);
    const slip = (await app.inject({method: 'POST', url: '/api/lab/results', payload: form.body, headers: {origin, cookie: lab, 'content-type': form.contentType}})).json();
    const result = (await post(`/api/file/profiles/${self.id}/claim`, {code: slip.code, check: '1990'}, {cookie})).json().item;

    const child = (await post('/api/file/profiles', {name: 'Sami Haddad', birth_date: '2021-03-01', sex: 'male'}, {cookie})).json().profile;
    const doctor = await approvedDoctor(post);
    const day = addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
    const slots = (await get(`/api/doctors/${doctor.id}/slots?from=${day}&days=1`)).json().slots;
    await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[0].starts_at, subject_id: child.id, reason: 'Fever'}, {cookie});
    return {cookie, self, child, photo, result, doctor, labResultId: slip.result.id};
}

describe('FHIR health file for the signed-in patient', () => {
    test('Patient is read by id with the SyriaHC number, never with phone or email', async () => {
        const {cookie, self} = await fullFile();
        const res = await get(`/fhir/r4/Patient/${self.id}`, cookie);
        assert.equal(res.statusCode, 200);
        const patient = res.json();
        assert.deepEqual(patient.identifier, [{use: 'official', system: NUMBER_SYSTEM, value: self.patient_number}]);
        assert.equal(patient.name[0].text, 'Lina Haddad');
        assert.doesNotMatch(res.body, /lina@example\.org|\+963/);
        assert.equal((await get(`/fhir/r4/Patient/${self.id}`)).statusCode, 401, 'needs a session');
    });

    test('DocumentReference search (IHE MHD ITI-67) and Binary (ITI-68), each recorded', async () => {
        const {cookie, self, photo} = await fullFile();
        const all = (await get(`/fhir/r4/DocumentReference?patient=Patient/${self.id}`, cookie)).json();
        assert.equal(all.resourceType, 'Bundle');
        assert.equal(all.total, 2, 'the photo and the lab result');
        const xray = (await get(`/fhir/r4/DocumentReference?patient=${self.id}&type=http://loinc.org|18748-4`, cookie)).json();
        assert.deepEqual(xray.entry.map(e => e.resource.description), ['Chest X-ray']);
        assert.equal((await get(`/fhir/r4/DocumentReference?patient=${self.id}&date=ge2026-10-06`, cookie)).json().entry.every(e => e.resource.description !== 'Chest X-ray'), true);
        const doc = xray.entry[0].resource;
        assert.equal(doc.id, photo.id);
        assert.equal(doc.subject.reference, `Patient/${self.id}`);
        assert.equal(doc.type.coding[0].code, '18748-4');
        const url = doc.content[0].attachment.url;
        assert.match(url, /\/fhir\/r4\/Binary\/[0-9a-f-]{36}$/);
        const binary = await get(url.replace(/^https?:\/\/[^/]+/, ''), cookie);
        assert.equal(binary.statusCode, 200);
        assert.equal(binary.headers['content-type'], 'image/jpeg');
        assert.match(binary.headers['content-security-policy'], /^sandbox/);
        assert.doesNotMatch(binary.rawPayload.toString('latin1'), /GPSLatitude/);
        const {rows} = await pool.query("SELECT action FROM audit_log WHERE action IN ('health_file.searched', 'health_document.viewed') ORDER BY id");
        assert.deepEqual(rows.map(r => r.action), ['health_file.searched', 'health_file.searched', 'health_file.searched', 'health_document.viewed']);
        assert.equal((await get(`/fhir/r4/DocumentReference?patient=${self.id}&colour=red`, cookie)).statusCode, 400);
    });

    test('a lab result taken over is a DiagnosticReport from the lab, with the lab\'s file', async () => {
        const {cookie, self, result, labResultId} = await fullFile();
        const report = (await get(`/fhir/r4/DiagnosticReport/${result.id}`, cookie)).json();
        assert.equal(report.status, 'final');
        assert.equal(report.category[0].coding[0].code, 'LAB');
        assert.equal(report.code.text, 'Complete blood count');
        assert.match(report.performer[0].reference, /^Organization\//);
        assert.equal(report.performer[0].display, 'Al Shifa Laboratory');
        assert.match(report.presentedForm[0].url, new RegExp(`/Binary/${labResultId}$`));
        assert.match((await get(`/fhir/r4/Binary/${labResultId}`, cookie)).rawPayload.toString('latin1'), /^%PDF/);
        assert.equal((await get(`/fhir/r4/DiagnosticReport?patient=${self.id}`, cookie)).json().total, 1);
    });

    test('children, consent and appointments; $everything returns the whole file and is recorded', async () => {
        const {cookie, self, child, doctor} = await fullFile();
        const related = (await get(`/fhir/r4/RelatedPerson/${child.id}`, cookie)).json();
        assert.equal(related.patient.reference, `Patient/${child.id}`);
        assert.equal(related.relationship[0].coding[0].code, 'PRN');
        assert.equal((await get(`/fhir/r4/RelatedPerson/${self.id}`, cookie)).statusCode, 404, 'the own profile has no parent');

        const consent = (await get(`/fhir/r4/Consent?patient=${self.id}`, cookie)).json().entry[0].resource;
        assert.equal(consent.status, 'active');
        assert.equal(consent.provision.type, 'permit');
        assert.ok(consent.policy[0].uri.endsWith('/privacy#2026-11-draft'));

        const visit = (await get(`/fhir/r4/Appointment?patient=${child.id}`, cookie)).json().entry[0].resource;
        assert.equal(visit.status, 'pending');
        assert.deepEqual(visit.participant.map(p => p.actor.reference), [`Patient/${child.id}`, `Practitioner/${doctor.id}`]);
        assert.equal((await get(`/fhir/r4/Appointment?patient=${self.id}`, cookie)).json().total, 0, 'booked for the child, not for the mother');

        const everything = (await get(`/fhir/r4/Patient/${self.id}/$everything`, cookie)).json();
        const types = everything.entry.map(e => e.resource.resourceType);
        assert.deepEqual([...new Set(types)].sort(), ['Consent', 'DiagnosticReport', 'DocumentReference', 'Patient']);
        const childEverything = (await get(`/fhir/r4/Patient/${child.id}/$everything`, cookie)).json();
        assert.deepEqual(childEverything.entry.map(e => e.resource.resourceType).sort(), ['Appointment', 'Patient', 'RelatedPerson']);
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'health_file.exported'")).rows[0].n, 2);
    });

    test('another patient, a doctor and anyone without the file switched on find nothing', async () => {
        const {self, child, photo, labResultId, doctor} = await fullFile();
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Saleh');
        for (const cookie of [omar, doctor.cookie]) {
            for (const url of [`/fhir/r4/Patient/${self.id}`, `/fhir/r4/Patient/${child.id}/$everything`, `/fhir/r4/RelatedPerson/${child.id}`,
                `/fhir/r4/DocumentReference/${photo.id}`, `/fhir/r4/Binary/${labResultId}`]) {
                assert.equal((await get(url, cookie)).statusCode, 404, url);
            }
            const search = (await get(`/fhir/r4/DocumentReference?patient=${self.id}`, cookie)).json();
            assert.equal(search.total ?? 0, 0);
        }
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
        config.healthFile = false;
        try {
            assert.equal((await get(`/fhir/r4/Patient/${self.id}`, lina)).statusCode, 404);
            const types = (await get('/fhir/r4/metadata')).json().rest[0].resource.map(r => r.type);
            assert.equal(types.includes('Patient'), false);
        } finally {
            config.healthFile = true;
        }
    });
});
