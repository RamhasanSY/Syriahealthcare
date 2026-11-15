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
const nowHere = () => new Date().toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Damascus'});

async function pharmacy({email = 'ph@example.org', name = 'Al Amal Pharmacy', status = 'approved', governorate = 'damascus', services = [], kind = 'pharmacy'} = {}) {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind}));
    const {rows: [f]} = await pool.query(`UPDATE facility_profiles p SET status = $2, facility_name = $3, governorate = $4, area = 'Mezzeh', phone = '+963112223344',
        services = $5 FROM users u WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id`, [email, status, name, governorate, services]);
    return {cookie, id: f.user_id};
}

describe('pharmacies on duty', () => {
    test('a night duty from 20:00 to 08:00 runs into the next morning and shows for both days', async () => {
        const ph = await pharmacy();
        const res = await post('/api/pharmacy/duties', {date: day(1), from: '20:00', to: '08:00', note: 'Ring the bell'}, {cookie: ph.cookie});
        assert.equal(res.statusCode, 201, res.body);
        const [duty] = res.json().duties;
        assert.equal(new Date(duty.starts_at).toISOString(), new Date(`${day(1)}T17:00:00Z`).toISOString(), '20:00 Syria time is 17:00 UTC');
        assert.equal(new Date(duty.ends_at).toISOString(), new Date(`${day(2)}T05:00:00Z`).toISOString());

        for (const d of [day(1), day(2)]) {
            const list = (await get(`/api/pharmacies/on-duty?date=${d}`)).json();
            assert.deepEqual(list.on_duty.map(p => [p.name, p.note, p.phone]), [['Al Amal Pharmacy', 'Ring the bell', '+963112223344']], d);
        }
        assert.equal((await get(`/api/pharmacies/on-duty?date=${day(3)}`)).json().on_duty.length, 0);
        assert.equal((await get(`/api/pharmacies/on-duty?date=${day(1)}&governorate=aleppo`)).json().on_duty.length, 0);
        assert.equal((await get(`/api/pharmacies/on-duty?date=${day(-1)}`)).json().error, 'invalid_date');
    });

    test('"now" shows duties running now, those of the next 24 hours, and 24-hour pharmacies', async () => {
        const ph = await pharmacy();
        await pharmacy({email: 'p24@example.org', name: 'Open Day And Night', services: ['open_24h']});
        await pharmacy({email: 'pend@example.org', name: 'Pending Pharmacy', status: 'pending', services: ['open_24h']});
        // A duty running right now (inserted directly: "from" may not be in the past through the form).
        await pool.query(`INSERT INTO pharmacy_duties (facility_id, starts_at, ends_at) VALUES ($1, now() - interval '1 hour', now() + interval '2 hours')`, [ph.id]);
        const other = await pharmacy({email: 'p2@example.org', name: 'Later Pharmacy'});
        await pool.query(`INSERT INTO pharmacy_duties (facility_id, starts_at, ends_at) VALUES ($1, now() + interval '5 hours', now() + interval '15 hours')`, [other.id]);
        const list = (await get('/api/pharmacies/on-duty')).json();
        assert.equal(list.date, null);
        assert.deepEqual(list.on_duty.map(p => p.name), ['Al Amal Pharmacy']);
        assert.deepEqual(list.later.map(p => p.name), ['Later Pharmacy']);
        assert.deepEqual(list.open_24h.map(p => p.name), ['Open Day And Night'], 'only approved pharmacies');
        assert.doesNotMatch(JSON.stringify(list), /example\.org|Rana/);
    });

    test('weekly duties, overlaps, limits and who may enter them', async () => {
        const ph = await pharmacy();
        const add = body => post('/api/pharmacy/duties', body, {cookie: ph.cookie});
        const weekly = await add({date: day(2), from: '14:00', to: '22:00', repeat_weeks: 3});
        assert.equal(weekly.json().duties.length, 4);
        const days = weekly.json().duties.map(d => new Date(d.starts_at).toLocaleDateString('en-CA', {timeZone: 'Asia/Damascus'}));
        assert.deepEqual(days, [day(2), day(9), day(16), day(23)]);
        assert.equal((await add({date: day(9), from: '21:00', to: '23:00'})).json().error, 'duty_overlap');
        assert.equal((await add({date: day(5), from: '10:00', to: '10:00'})).json().error, 'invalid_duty_time');
        assert.equal((await add({date: day(61), from: '20:00', to: '08:00'})).json().error, 'invalid_date');
        assert.equal((await add({date: day(1), from: '25:00', to: '08:00'})).statusCode, 400);
        if (nowHere() > '00:30') assert.equal((await add({date: day(0), from: '00:00', to: '00:10'})).json().error, 'invalid_date', 'already over');

        const mine = (await get('/api/pharmacy/duties', ph.cookie)).json();
        assert.equal(mine.duties.length, 4);
        const otherPh = await pharmacy({email: 'o@example.org', name: 'Other'});
        assert.equal((await post(`/api/pharmacy/duties/${mine.duties[0].id}/delete`, {}, {cookie: otherPh.cookie})).statusCode, 404);
        assert.equal((await post(`/api/pharmacy/duties/${mine.duties[0].id}/delete`, {}, {cookie: ph.cookie})).json().deleted, true);

        const lab = await pharmacy({email: 'lab@example.org', kind: 'lab', name: 'A Lab'});
        assert.equal((await post('/api/pharmacy/duties', {date: day(1), from: '20:00', to: '08:00'}, {cookie: lab.cookie})).json().error, 'not_a_pharmacy');
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org');
        assert.equal((await post('/api/pharmacy/duties', {date: day(1), from: '20:00', to: '08:00'}, {cookie: patient})).statusCode, 403);

        // A pending pharmacy saves duties, but they are not public.
        const pending = await pharmacy({email: 'pe@example.org', name: 'Pending', status: 'pending'});
        assert.equal((await post('/api/pharmacy/duties', {date: day(3), from: '20:00', to: '08:00'}, {cookie: pending.cookie})).statusCode, 201);
        assert.equal((await get('/api/pharmacy/duties', pending.cookie)).json().approved, false);
        assert.ok(!(await get(`/api/pharmacies/on-duty?date=${day(3)}`)).json().on_duty.some(p => p.name === 'Pending'));
    });
});
