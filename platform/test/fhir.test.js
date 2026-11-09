import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, cookieOf, pool, setup, signIn, teardown} from './helpers.js';
import {HEALTH_RESOURCES, RESOURCES} from '../src/fhir/registry.js';
import {addDays, localDate} from '../src/slots.js';

let app, post;
beforeEach(async () => {
    await app?.close();
    ({app, post} = await setup());
});
after(() => teardown(app));

const get = url => app.inject({url});
const tomorrow = () => addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
const SPECIALTY_SYSTEM = 'https://syriahc.com/fhir/CodeSystem/specialty';

async function approvedLab(email = 'lab@example.org', services = ['blood_count', 'pcr']) {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind: 'lab'}));
    await pool.query(`UPDATE facility_profiles p SET status = 'approved', facility_name = 'Al Shifa Laboratory', governorate = 'aleppo',
        area = 'Al Aziziyah', address = 'Main street 4', phone = '+963211234567', services = $2
        FROM users u WHERE u.id = p.user_id AND u.email = $1`, [email, services]);
    return cookie;
}

describe('metadata', () => {
    test('a CapabilityStatement lists exactly the resources of the registry', async () => {
        const res = await get('/fhir/r4/metadata');
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^application\/fhir\+json/);
        assert.equal(res.headers['cache-control'], 'no-store');
        const body = res.json();
        assert.equal(body.resourceType, 'CapabilityStatement');
        assert.equal(body.fhirVersion, '4.0.1');
        assert.deepEqual(body.rest[0].resource.map(r => r.type), [...Object.keys(RESOURCES), ...Object.keys(HEALTH_RESOURCES)], 'the health file is on in tests');
        const practitioner = body.rest[0].resource.find(r => r.type === 'Practitioner');
        assert.deepEqual(practitioner.searchParam, [{name: 'name', type: 'string'}, {name: 'active', type: 'token'}]);
    });

    test('there is no patient search of any kind', async () => {
        const body = (await get('/fhir/r4/metadata')).json();
        const patient = body.rest[0].resource.find(r => r.type === 'Patient');
        assert.deepEqual(patient.interaction, [{code: 'read'}], 'read by id only');
        assert.equal(patient.searchParam, undefined);
        assert.equal((await get('/fhir/r4/Patient?name=Lina')).statusCode, 404, 'no search route exists');
    });
});

describe('practitioners and practices (IHE mCSD style)', () => {
    test('an approved doctor is readable with public fields only', async () => {
        const doctor = await approvedDoctor(post, 'dr@example.org', 'Dr. Approved');
        const res = await get(`/fhir/r4/Practitioner/${doctor.id}`);
        assert.equal(res.statusCode, 200);
        const text = res.body;
        assert.equal(res.json().name[0].text, 'Dr. Approved');
        assert.doesNotMatch(text, /dr@example\.org/, 'no email');
        assert.doesNotMatch(text, /SY-1/, 'no licence number');
        assert.doesNotMatch(text, /password/i);
    });

    test('a doctor waiting for approval is not published, neither by read nor by search', async () => {
        await signIn(post, 'doctor', 'pending@example.org', 'Dr. Waiting');
        const {rows: [{id}]} = await pool.query("SELECT id FROM users WHERE email = 'pending@example.org'");
        assert.equal((await get(`/fhir/r4/Practitioner/${id}`)).statusCode, 404);
        const found = (await get('/fhir/r4/Practitioner?name=Waiting')).json();
        assert.equal(found.total, 0);
    });

    test('search by name finds approved doctors and treats the input as plain text', async () => {
        await approvedDoctor(post, 'dr@example.org', 'Dr. Approved');
        assert.equal((await get('/fhir/r4/Practitioner?name=approved')).json().total, 1);
        assert.equal((await get('/fhir/r4/Practitioner?name=%25')).json().total, 0, 'a percent sign is not a wildcard');
    });

    test('the role carries the specialty from the shared code system and the opening hours', async () => {
        const doctor = await approvedDoctor(post);
        const role = (await get(`/fhir/r4/PractitionerRole/${doctor.id}`)).json();
        assert.equal(role.specialty[0].coding[0].system, SPECIALTY_SYSTEM);
        assert.equal(role.specialty[0].coding[0].code, 'cardiology');
        assert.equal(role.availableTime.length, 1, 'one range for all days');
        assert.equal(role.availableTime[0].daysOfWeek.length, 7);
        assert.equal(role.availableTime[0].availableStartTime, '09:00:00');
        assert.equal(role.availableTime[0].availableEndTime, '12:00:00');
        assert.equal(role.location[0].reference, `Location/${doctor.id}`);
    });

    test('the practice location carries the governorate with its ISO 3166-2 code and Arabic name', async () => {
        const doctor = await approvedDoctor(post);
        const loc = (await get(`/fhir/r4/Location/${doctor.id}`)).json();
        assert.equal(loc.address.state, 'Damascus');
        assert.equal(loc.address.country, 'SY');
        const ext = loc.address._state.extension;
        assert.equal(ext[1].valueCoding.code, 'SY-DI');
        assert.equal(ext[0].extension[1].valueString, 'دمشق');
    });

    test('a practitioner search with an unknown parameter is refused with an OperationOutcome', async () => {
        const res = await get('/fhir/r4/Practitioner?phone=0912345678');
        assert.equal(res.statusCode, 400);
        assert.equal(res.json().resourceType, 'OperationOutcome');
        assert.equal(res.json().issue[0].code, 'invalid');
    });

    test('there is no way to search patients by phone or name', async () => {
        assert.equal((await get('/fhir/r4/Patient?phone=0912345678')).statusCode, 404);
        // Reading a profile by id needs a patient session (stage 2b); without one every id gets the same 401, so nothing is revealed.
        assert.equal((await get('/fhir/r4/Patient/00000000-0000-4000-8000-000000000000')).statusCode, 401);
    });
});

describe('free slots', () => {
    test('slots match the booking page and are readable one by one', async () => {
        const doctor = await approvedDoctor(post);
        const day = tomorrow();
        const api = (await get(`/api/doctors/${doctor.id}/slots?from=${day}&days=1`)).json().slots;
        const res = (await get(`/fhir/r4/Slot?schedule=Schedule/${doctor.id}&start=ge${day}&start=le${day}`)).json();
        assert.equal(res.resourceType, 'Bundle');
        assert.equal(res.total, api.length);
        assert.ok(res.total > 0);
        assert.equal(res.entry[0].resource.status, 'free');
        const one = await get(`/fhir/r4/Slot/${res.entry[0].resource.id}`);
        assert.equal(one.statusCode, 200);
        assert.equal(one.json().start, api[0].starts_at);
    });

    test('a status other than free gives no slots', async () => {
        const doctor = await approvedDoctor(post);
        const res = (await get(`/fhir/r4/Slot?schedule=Schedule/${doctor.id}&status=busy`)).json();
        assert.equal(res.total, 0);
    });

    test('the schedule of a doctor who is not approved is not found', async () => {
        await signIn(post, 'doctor', 'pending@example.org', 'Dr. Waiting');
        const {rows: [{id}]} = await pool.query("SELECT id FROM users WHERE email = 'pending@example.org'");
        assert.equal((await get(`/fhir/r4/Schedule/${id}`)).statusCode, 404);
    });
});

describe('facilities', () => {
    test('an approved laboratory is an Organization, a Location and a HealthcareService', async () => {
        await approvedLab();
        const orgs = (await get('/fhir/r4/Organization?type=lab')).json();
        assert.equal(orgs.total, 1);
        const org = orgs.entry[0].resource;
        assert.equal(org.name, 'Al Shifa Laboratory');
        assert.equal((await get('/fhir/r4/Organization?type=clinic')).json().total, 0);

        const svc = (await get('/fhir/r4/HealthcareService?type=lab.blood_count')).json();
        assert.equal(svc.total, 1);
        assert.equal(svc.entry[0].resource.type[0].coding[0].code, 'lab.blood_count');
        assert.equal((await get('/fhir/r4/HealthcareService?type=lab.mri')).json().total, 0, 'MRI is not an offer of a lab');

        assert.equal((await get(`/fhir/r4/Location/${org.id}`)).json().managingOrganization.reference, `Organization/${org.id}`);
    });

    test('an unapproved facility is not published', async () => {
        const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Waiting Lab', email: 'wait@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
        assert.ok(cookie);
        assert.equal((await get('/fhir/r4/Organization?type=lab')).json().total, 0);
    });

    test('the address of a facility holds no contact person, email or licence', async () => {
        await approvedLab();
        const text = (await get('/fhir/r4/Organization?type=lab')).body;
        assert.doesNotMatch(text, /lab@example\.org/);
        assert.doesNotMatch(text, /Rana Saleh/);
    });
});

describe('code systems', () => {
    test('the specialty code system has every specialty, with Arabic designations', async () => {
        const cs = (await get('/fhir/r4/CodeSystem/specialty')).json();
        assert.equal(cs.resourceType, 'CodeSystem');
        assert.equal(cs.count, Object.keys((await import('../src/catalog.js')).specialties).length);
        const cardiology = cs.concept.find(c => c.code === 'cardiology');
        assert.equal(cardiology.display, 'Cardiology');
        assert.equal(cardiology.designation[0].value, 'أمراض القلب');
    });

    test('a value set expands to the same codes', async () => {
        const cs = (await get('/fhir/r4/CodeSystem/facility-service')).json();
        const vs = (await get('/fhir/r4/ValueSet/facility-service')).json();
        const leaves = cs.concept.flatMap(kind => kind.concept.map(c => c.code));
        assert.equal(vs.expansion.total, leaves.length);
        assert.deepEqual(vs.expansion.contains.map(c => c.code).sort(), leaves.sort());
    });

    test('the governorates carry their ISO 3166-2 codes', async () => {
        const cs = (await get('/fhir/r4/CodeSystem/governorate')).json();
        const aleppo = cs.concept.find(c => c.code === 'aleppo');
        assert.equal(aleppo.property[0].valueCode, 'SY-HL');
    });

    test('the patient-number namingsystem is published under the SyriaHC canonical address', async () => {
        const ns = (await get('/fhir/r4/NamingSystem/patient-number')).json();
        assert.equal(ns.uniqueId[0].value, 'https://syriahc.com/fhir/sid/patient-number');
    });

    test('an unknown resource is a 404 with an OperationOutcome', async () => {
        const res = await get('/fhir/r4/CodeSystem/nope');
        assert.equal(res.statusCode, 404);
        assert.equal(res.json().resourceType, 'OperationOutcome');
    });
});
