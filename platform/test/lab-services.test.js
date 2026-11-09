import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {cookieOf, pool, setup, signInPatientByEmail, teardown} from './helpers.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});
const day = n => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', {timeZone: 'Asia/Damascus'});

async function facility({kind = 'lab', email = 'lab@example.org', name = 'Al Shifa Laboratory', status = 'approved', services = ['blood_count', 'home_collection']} = {}) {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind}));
    const {rows: [f]} = await pool.query(`UPDATE facility_profiles p SET status = $2, facility_name = $3, governorate = 'damascus', services = $4
        FROM users u WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id`, [email, status, name, services]);
    return {cookie, id: f.user_id};
}

describe('price list', () => {
    test('a lab keeps its price list; it is public only once the lab is approved', async () => {
        const lab = await facility({status: 'pending'});
        const add = body => post('/api/facility/tests', body, {cookie: lab.cookie});
        const res = await add({name: 'TSH', service: 'thyroid', price_syp: 45000, turnaround_hours: 24, notes: 'No fasting needed'});
        assert.equal(res.statusCode, 201);
        await add({name: 'Lipid panel', service: 'lipids', price_syp: 60000, notes: 'Fasting 12 hours'});
        await add({name: 'Genetic panel', service: 'genetic', price_syp: null});
        assert.equal((await add({name: 'TSH'})).json().error, 'test_exists');
        assert.equal((await add({name: 'X ray', service: 'xray'})).json().error, 'invalid_service', 'a lab cannot list imaging services');
        assert.equal((await get(`/api/labs/${lab.id}`)).statusCode, 404, 'not public before approval');

        await pool.query("UPDATE facility_profiles SET status = 'approved' WHERE user_id = $1", [lab.id]);
        const page = (await get(`/api/labs/${lab.id}`)).json();
        assert.equal(page.lab.facility_name, 'Al Shifa Laboratory');
        assert.equal(page.lab.home_collection, true);
        assert.deepEqual(page.tests.map(t => [t.name, t.price_syp]), [['Genetic panel', null], ['Lipid panel', 60000], ['TSH', 45000]]);
        assert.ok(page.prices_updated_at);
        assert.doesNotMatch(JSON.stringify(page), /lab@example\.org|licence/i);

        const id = page.tests.find(t => t.name === 'TSH').id;
        assert.equal((await post(`/api/facility/tests/${id}`, {price_syp: 50000}, {cookie: lab.cookie})).json().test.price_syp, 50000);
        assert.equal((await post(`/api/facility/tests/${id}/delete`, {}, {cookie: lab.cookie})).statusCode, 200);
        assert.equal((await get(`/api/labs/${lab.id}`)).json().tests.length, 2);
        const listed = (await get('/api/facilities')).json().facilities.find(f => f.id === lab.id);
        assert.equal(listed.tests_count, 2, 'the website learns that there is a price list');
    });

    test('only labs and imaging centres have a price list, and only their own', async () => {
        const lab = await facility();
        const hospital = await facility({kind: 'hospital', email: 'h@example.org', name: 'City Hospital', services: []});
        assert.equal((await post('/api/facility/tests', {name: 'CBC'}, {cookie: hospital.cookie})).json().error, 'not_a_lab');
        const other = await facility({email: 'other@example.org', name: 'Other Lab'});
        const test = (await post('/api/facility/tests', {name: 'CBC', price_syp: 20000}, {cookie: lab.cookie})).json().test;
        assert.equal((await post(`/api/facility/tests/${test.id}`, {price_syp: 1}, {cookie: other.cookie})).statusCode, 404);
        assert.equal((await post(`/api/facility/tests/${test.id}/delete`, {}, {cookie: other.cookie})).statusCode, 404);
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org');
        assert.equal((await post('/api/facility/tests', {name: 'CBC'}, {cookie: patient})).statusCode, 403);
    });
});

describe('home sample collection', () => {
    test('a patient asks, the lab confirms with an arrival time, the patient is told by email', async () => {
        const lab = await facility();
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
        mail.sent.length = 0;
        const res = await post('/api/home-visits', {facility_id: lab.id, visit_date: day(2), time_window: 'morning', address: 'Mezzeh, Villas street 12, 3rd floor',
            phone: '0912 345 678', tests: 'CBC and lipid panel'}, {cookie: patient});
        assert.equal(res.statusCode, 201);
        const visit = res.json().visit;
        assert.ok(mail.sent.some(m => m.to === 'lab@example.org'), 'the lab is told');

        const open = (await get('/api/lab/home-visits', lab.cookie)).json();
        assert.equal(open.counts.open, 1);
        assert.equal(open.visits[0].address, 'Mezzeh, Villas street 12, 3rd floor');
        assert.equal(open.visits[0].phone, '+963912345678');
        const confirmed = await post(`/api/lab/home-visits/${visit.id}/confirm`, {arrival_time: '09:30', note: 'Please do not eat after midnight'}, {cookie: lab.cookie});
        assert.equal(confirmed.json().visit.status, 'confirmed');
        assert.match(mail.sent.find(m => m.to === 'lina@example.org').text, /09:30/);
        assert.equal((await get('/api/lab/home-visits?scope=upcoming', lab.cookie)).json().visits.length, 1);

        const mine = (await get('/api/home-visits/mine', patient)).json().visits;
        assert.deepEqual([mine[0].status, mine[0].arrival_time, mine[0].lab_name], ['confirmed', '09:30', 'Al Shifa Laboratory']);
        assert.equal((await post(`/api/lab/home-visits/${visit.id}/done`, {}, {cookie: lab.cookie})).json().visit.status, 'done');
        assert.equal((await post(`/api/home-visits/${visit.id}/cancel`, {}, {cookie: patient})).statusCode, 404, 'done cannot be cancelled');
    });

    test('rules: a lab that offers it, a day from tomorrow to 30 days, at most 3 open, reasons for declining', async () => {
        const lab = await facility();
        const noHome = await facility({email: 'nohome@example.org', name: 'Small Lab', services: ['blood_count']});
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org');
        const ask = (over = {}) => post('/api/home-visits', {facility_id: lab.id, visit_date: day(1), time_window: 'evening', address: 'Abu Rummaneh 5', phone: '0912345678', ...over}, {cookie: patient});
        assert.equal((await ask({facility_id: noHome.id})).statusCode, 404);
        assert.equal((await ask({visit_date: day(0)})).json().error, 'invalid_date');
        assert.equal((await ask({visit_date: day(31)})).json().error, 'invalid_date');
        assert.equal((await ask({phone: '123'})).json().error, 'invalid_phone');
        const visits = [];
        for (let i = 1; i <= 3; i++) visits.push((await ask({visit_date: day(i)})).json().visit);
        assert.equal((await ask({visit_date: day(4)})).json().error, 'too_many_visits');
        assert.equal((await post(`/api/lab/home-visits/${visits[0].id}/decline`, {}, {cookie: lab.cookie})).json().error, 'note_required');
        assert.equal((await post(`/api/lab/home-visits/${visits[0].id}/decline`, {note: 'No staff on that day'}, {cookie: lab.cookie})).json().visit.status, 'declined');
        assert.equal((await post(`/api/home-visits/${visits[1].id}/cancel`, {}, {cookie: patient})).json().visit.status, 'cancelled_by_patient');
        assert.equal((await ask({visit_date: day(5)})).statusCode, 201, 'room again after declining and cancelling');
    });

    test('nobody else sees or changes a home visit', async () => {
        const lab = await facility();
        const other = await facility({email: 'other@example.org', name: 'Other Lab'});
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org');
        const visit = (await post('/api/home-visits', {facility_id: lab.id, visit_date: day(2), time_window: 'midday', address: 'Mezzeh 12', phone: '0912345678'}, {cookie: patient})).json().visit;
        assert.equal((await get('/api/lab/home-visits', other.cookie)).json().visits.length, 0);
        assert.equal((await post(`/api/lab/home-visits/${visit.id}/confirm`, {}, {cookie: other.cookie})).json().error, 'wrong_status');
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Saleh');
        assert.equal((await get('/api/home-visits/mine', omar)).json().visits.length, 0);
        assert.equal((await post(`/api/home-visits/${visit.id}/cancel`, {}, {cookie: omar})).statusCode, 404);
        assert.equal((await post('/api/home-visits', {facility_id: lab.id, visit_date: day(2), time_window: 'midday', address: 'Mezzeh 12', phone: '0912345678'}, {cookie: lab.cookie})).statusCode, 403);
    });
});
