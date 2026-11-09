// Fetches one example of every FHIR resource the platform produces. With FHIR_EXAMPLES_DIR set (in GitHub Actions),
// each answer is written there and then checked by the official HL7 FHIR validator (see .github/workflows/platform.yml).
import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {approvedDoctor, cookieOf, origin, pool, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';
import {jpegWithExif, multipart, PDF} from './fixtures.js';
import {auditEvent} from '../src/fhir/audit.js';
import {codeSystems, namingSystems, valueSets} from '../src/fhir/terminology.js';
import {addDays, localDate} from '../src/slots.js';

const dir = process.env.FHIR_EXAMPLES_DIR;
let app, post, mail, doctor, facilities = [];
const saved = [];

before(async () => {
    ({app, post, mail} = await setup());
    doctor = await approvedDoctor(post, 'dr@example.org', 'Dr. Approved');
    for (const [kind, email, services] of [['lab', 'lab@example.org', ['blood_count', 'pcr']], ['hospital', 'hospital@example.org', ['emergency_care', 'surgery']]]) {
        await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind});
        const {rows: [f]} = await pool.query(`UPDATE facility_profiles p SET status = 'approved', facility_name = $2, governorate = 'aleppo',
            area = 'Al Aziziyah', address = 'Main street 4', phone = '+963211234567', services = $3, opening_hours = 'Sat-Thu 08:00-20:00',
            emergency = $4 FROM users u WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id`,
            [email, kind === 'lab' ? 'Al Shifa Laboratory' : 'Aleppo University Hospital', services, kind === 'hospital']);
        facilities.push(f.user_id);
    }
    await signIn(post, 'admin', 'admin@example.org');
    if (dir) await mkdir(dir, {recursive: true});
});
after(() => teardown(app));

async function keep(name, url, cookie) {
    const res = await app.inject({url, headers: cookie ? {cookie} : {}});
    assert.ok([200, 400, 404].includes(res.statusCode), `${url} → ${res.statusCode}`);
    const body = res.json();
    assert.ok(body.resourceType, `${url} returns a FHIR resource`);
    assert.doesNotMatch(res.body, /:null|:\[\]|:\{\}|:""/, `${url} has no empty elements`);
    saved.push(name);
    if (dir) await writeFile(path.join(dir, `${name}.json`), JSON.stringify(body, null, 2));
    return body;
}

describe('FHIR examples for the HL7 validator', () => {
    test('directory, slots, code systems and errors', async () => {
        const [lab, hospital] = facilities;
        await keep('capability-statement', '/fhir/r4/metadata');
        await keep('endpoint', '/fhir/r4/Endpoint/fhir-r4');
        await keep('practitioner', `/fhir/r4/Practitioner/${doctor.id}`);
        await keep('practitioner-search', '/fhir/r4/Practitioner?name=Approved');
        await keep('practitioner-role', `/fhir/r4/PractitionerRole/${doctor.id}`);
        await keep('practitioner-role-search', '/fhir/r4/PractitionerRole?specialty=cardiology');
        await keep('location-practice', `/fhir/r4/Location/${doctor.id}`);
        await keep('location-facility', `/fhir/r4/Location/${hospital}`);
        await keep('location-search', '/fhir/r4/Location');
        await keep('organization-lab', `/fhir/r4/Organization/${lab}`);
        await keep('organization-hospital', `/fhir/r4/Organization/${hospital}`);
        await keep('organization-search', '/fhir/r4/Organization?type=lab');
        await keep('healthcare-service', `/fhir/r4/HealthcareService/${hospital}`);
        await keep('healthcare-service-search', '/fhir/r4/HealthcareService?category=lab');
        await keep('schedule', `/fhir/r4/Schedule/${doctor.id}`);
        const day = addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
        const slots = await keep('slot-search', `/fhir/r4/Slot?schedule=Schedule/${doctor.id}&start=ge${day}&start=le${day}`);
        assert.ok(slots.entry?.length, 'tomorrow has free slots');
        await keep('slot', `/fhir/r4/Slot/${slots.entry[0].resource.id}`);
        for (const cs of codeSystems()) await keep(`codesystem-${cs.id}`, `/fhir/r4/CodeSystem/${cs.id}`);
        for (const vs of valueSets()) await keep(`valueset-${vs.id}`, `/fhir/r4/ValueSet/${vs.id}`);
        for (const ns of namingSystems()) await keep(`namingsystem-${ns.id}`, `/fhir/r4/NamingSystem/${ns.id}`);
        await keep('operation-outcome-unknown-parameter', '/fhir/r4/Practitioner?colour=blue');
        await keep('operation-outcome-not-found', '/fhir/r4/Practitioner/00000000-0000-4000-8000-000000000000');
    });

    test('the health file of a patient (stage 2b)', async () => {
        const cookie = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
        const self = (await app.inject({url: '/api/file', headers: {cookie}})).json().profiles[0];
        await post(`/api/file/profiles/${self.id}/consent`, {}, {cookie});
        await post(`/api/file/profiles/${self.id}`, {birth_date: '1990-04-02', sex: 'female'}, {cookie});
        const upload = multipart({category: 'discharge', title: 'Discharge letter', document_date: '2026-09-12'},
            [{filename: 'page1.jpg', type: 'image/jpeg', content: jpegWithExif()}, {filename: 'page2.pdf', type: 'application/pdf', content: PDF}]);
        const photo = (await app.inject({method: 'POST', url: `/api/file/profiles/${self.id}/documents`, payload: upload.body,
            headers: {origin, cookie, 'content-type': upload.contentType}})).json().item;
        const lab = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email: 'lab2@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
        await pool.query("UPDATE facility_profiles p SET status = 'approved', facility_name = 'Al Amal Laboratory' FROM users u WHERE u.id = p.user_id AND u.email = 'lab2@example.org'");
        const form = multipart({patient_name: 'Lina Haddad', patient_phone: '0912 345 678', title: 'Complete blood count', birth_year: '1990'},
            [{name: 'file', filename: 'cbc.pdf', type: 'application/pdf', content: PDF}]);
        const slip = (await app.inject({method: 'POST', url: '/api/lab/results', payload: form.body, headers: {origin, cookie: lab, 'content-type': form.contentType}})).json();
        const report = (await post(`/api/file/profiles/${self.id}/claim`, {code: slip.code, check: '1990'}, {cookie})).json().item;
        const child = (await post('/api/file/profiles', {name: 'Sami Haddad', birth_date: '2021-03-01'}, {cookie})).json().profile;
        const day = addDays(localDate(Date.now(), 'Asia/Damascus'), 2);
        const slots = (await app.inject({url: `/api/doctors/${doctor.id}/slots?from=${day}&days=1`})).json().slots;
        await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[0].starts_at, subject_id: child.id, reason: 'Fever'}, {cookie});

        await post(`/api/file/profiles/${self.id}/shares`, {doctor_id: doctor.id, item_ids: [photo.id], days: 30}, {cookie});
        await keep('patient', `/fhir/r4/Patient/${self.id}`, cookie);
        await keep('patient-child', `/fhir/r4/Patient/${child.id}`, cookie);
        await keep('related-person', `/fhir/r4/RelatedPerson/${child.id}`, cookie);
        await keep('document-reference-upload', `/fhir/r4/DocumentReference/${photo.id}`, cookie);
        await keep('document-reference-lab', `/fhir/r4/DocumentReference/${report.id}`, cookie);
        await keep('document-reference-search', `/fhir/r4/DocumentReference?patient=Patient/${self.id}&date=ge2026-01-01`, cookie);
        await keep('diagnostic-report', `/fhir/r4/DiagnosticReport/${report.id}`, cookie);
        await keep('consent-search', `/fhir/r4/Consent?patient=${self.id}`, cookie);
        await keep('appointment-search', `/fhir/r4/Appointment?patient=${child.id}`, cookie);
        await keep('patient-everything', `/fhir/r4/Patient/${self.id}/$everything`, cookie);
        await keep('auditevent-search', `/fhir/r4/AuditEvent?patient=${self.id}`, cookie);
        await keep('patient-everything-child', `/fhir/r4/Patient/${child.id}/$everything`, cookie);
    });

    test('answers to lab software (stage 2d)', async () => {
        const admin = await signIn(post, 'admin', 'connections@example.org', 'Connections Admin');
        const created = (await post('/api/admin/api-clients', {facility_id: facilities[0], name: 'LabSoft', scopes: ['system/DiagnosticReport.c']}, {cookie: admin})).json();
        const token = (await app.inject({method: 'POST', url: '/oauth/token', headers: {'content-type': 'application/x-www-form-urlencoded'},
            payload: `grant_type=client_credentials&client_id=${created.client.client_id}&client_secret=${encodeURIComponent(created.client_secret)}`})).json().access_token;
        const bundle = phone => ({resourceType: 'Bundle', type: 'transaction', entry: [
            {fullUrl: 'urn:uuid:11111111-1111-4111-8111-111111111111', resource: {resourceType: 'Patient', name: [{text: 'Omar Saleh'}],
                telecom: [{system: 'phone', value: phone}], birthDate: '1980-01-01'}, request: {method: 'POST', url: 'Patient'}},
            {resource: {resourceType: 'DiagnosticReport', status: 'final', identifier: [{system: 'urn:labsoft', value: 'L-1'}], code: {text: 'Lipid panel'},
                subject: {reference: 'urn:uuid:11111111-1111-4111-8111-111111111111'}, presentedForm: [{contentType: 'application/pdf', data: PDF.toString('base64')}]},
                request: {method: 'POST', url: 'DiagnosticReport'}}]});
        for (const [name, phone] of [['transaction-response', '0933 222 111'], ['operation-outcome-invalid-bundle', 'none']]) {
            const res = await app.inject({method: 'POST', url: '/fhir/r4', payload: JSON.stringify(bundle(phone)),
                headers: {'content-type': 'application/fhir+json', authorization: `Bearer ${token}`}});
            assert.ok(res.json().resourceType);
            assert.doesNotMatch(res.body, /:null|:\[\]|:\{\}|:""/);
            saved.push(name);
            if (dir) await writeFile(path.join(dir, `${name}.json`), JSON.stringify(res.json(), null, 2));
        }
    });

    test('audit trail entries as AuditEvent', async () => {
        const {rows} = await pool.query(`SELECT a.*, u.role::text AS actor_role, u.name AS actor_name FROM audit_log a
            LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id`);
        const sample = [...new Map(rows.map(r => [r.action, r])).values()];
        assert.ok(sample.length >= 3);
        for (const r of sample) {
            const name = `auditevent-${r.action.replace(/\W+/g, '-')}`;
            saved.push(name);
            if (dir) await writeFile(path.join(dir, `${name}.json`), JSON.stringify(auditEvent(r), null, 2));
        }
        // A doctor opening a lab result, the main case for patients later; without the network address as patients see it.
        const viewed = auditEvent({id: 1, action: 'result.viewed', actor_id: doctor.id, actor_role: 'doctor', actor_name: 'Dr. Approved',
            target_id: facilities[0], ip: '203.0.113.9', created_at: new Date()}, {withNetwork: false});
        saved.push('auditevent-result-viewed-patient-view');
        if (dir) await writeFile(path.join(dir, 'auditevent-result-viewed-patient-view.json'), JSON.stringify(viewed, null, 2));
    });

    test('nothing is missing', () => {
        assert.ok(saved.length >= 40, `${saved.length} examples`);
        if (dir) console.log(`Wrote ${saved.length} FHIR examples to ${dir}`);
    });
});
