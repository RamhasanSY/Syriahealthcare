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

async function lab({email = 'lab@example.org', name = 'Al Shifa Laboratory', status = 'approved', governorate = 'damascus', kind = 'lab'} = {}) {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind}));
    const {rows: [f]} = await pool.query(`UPDATE facility_profiles p SET status = $2, facility_name = $3, governorate = $4, services = '{home_collection}'
        FROM users u WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id`, [email, status, name, governorate]);
    const tests = {};
    for (const [testName, price] of [['CBC', 20000], ['TSH', 45000], ['Lipid panel', 60000], ['HbA1c', 35000], ['Genetic panel', null]]) {
        tests[testName] = (await post('/api/facility/tests', {name: testName, price_syp: price}, {cookie})).json().test.id;
    }
    return {cookie, id: f.user_id, tests};
}

describe('lab packages', () => {
    test('a lab bundles tests from its price list; the saving is worked out; patients compare packages', async () => {
        const shifa = await lab();
        const res = await post('/api/facility/packages', {name: 'General check-up', topic: 'checkup', price_syp: 100000, description: 'Fasting 8 hours',
            test_ids: [shifa.tests.CBC, shifa.tests.TSH, shifa.tests['Lipid panel']]}, {cookie: shifa.cookie});
        assert.equal(res.statusCode, 201, res.body);
        const pkg = res.json().package;
        assert.equal(pkg.single_total_syp, 125000);
        assert.equal(pkg.saving_syp, 25000);
        assert.deepEqual(pkg.tests.map(t => t.name), ['CBC', 'Lipid panel', 'TSH']);

        const other = await lab({email: 'b@example.org', name: 'Aleppo Lab', governorate: 'aleppo'});
        await post('/api/facility/packages', {name: 'Diabetes', topic: 'diabetes', price_syp: 50000, test_ids: [other.tests.HbA1c, other.tests.CBC]}, {cookie: other.cookie});
        await post('/api/facility/packages', {name: 'Hidden one', price_syp: 1, active: false, test_ids: [other.tests.HbA1c, other.tests.TSH]}, {cookie: other.cookie});

        const all = (await get('/api/lab-packages')).json().packages;
        assert.deepEqual(all.map(k => [k.name, k.lab.name]), [['Diabetes', 'Aleppo Lab'], ['General check-up', 'Al Shifa Laboratory']], 'cheapest first, hidden left out');
        assert.equal(all[1].lab.home_collection, true);
        assert.deepEqual((await get('/api/lab-packages?governorate=damascus')).json().packages.map(k => k.name), ['General check-up']);
        assert.deepEqual((await get('/api/lab-packages?topic=diabetes')).json().packages.map(k => k.name), ['Diabetes']);
        assert.doesNotMatch(JSON.stringify(all), /example\.org|Rana/);

        const page = (await get(`/api/labs/${shifa.id}`)).json();
        assert.deepEqual(page.packages.map(k => k.name), ['General check-up']);
        assert.equal((await get('/api/catalog')).json().packageTopics.checkup[0], 'General check-up');
    });

    test('changing prices changes the saving; a test leaving the price list leaves the package', async () => {
        const shifa = await lab();
        const pkg = (await post('/api/facility/packages', {name: 'Thyroid', price_syp: 50000, test_ids: [shifa.tests.TSH, shifa.tests.CBC, shifa.tests['Genetic panel']]},
            {cookie: shifa.cookie})).json().package;
        assert.equal(pkg.single_total_syp, null, 'a test without price: no total');
        assert.equal(pkg.saving_syp, 0);
        await post(`/api/facility/tests/${shifa.tests['Genetic panel']}/delete`, {}, {cookie: shifa.cookie});
        await post(`/api/facility/tests/${shifa.tests.TSH}`, {price_syp: 40000}, {cookie: shifa.cookie});
        const [now] = (await get('/api/facility/packages', shifa.cookie)).json().packages;
        assert.deepEqual(now.tests.map(t => t.name), ['CBC', 'TSH']);
        assert.equal(now.saving_syp, 10000);
        const changed = await post(`/api/facility/packages/${pkg.id}`, {price_syp: 55000, name: 'Thyroid basic'}, {cookie: shifa.cookie});
        assert.equal(changed.json().package.name, 'Thyroid basic');
        assert.equal(changed.json().package.saving_syp, 5000);
        assert.equal((await post(`/api/facility/packages/${pkg.id}/delete`, {}, {cookie: shifa.cookie})).json().deleted, true);
    });

    test('only own tests, sensible fields, and only the own lab', async () => {
        const shifa = await lab(), other = await lab({email: 'b@example.org', name: 'Other Lab'});
        const add = (body, cookie = shifa.cookie) => post('/api/facility/packages', body, {cookie});
        assert.equal((await add({name: 'Mixed', price_syp: 1, test_ids: [shifa.tests.CBC, other.tests.TSH]})).json().error, 'invalid_tests');
        assert.equal((await add({name: 'One', price_syp: 1, test_ids: [shifa.tests.CBC]})).json().error, 'too_few_tests');
        assert.equal((await add({name: 'X', price_syp: 1, test_ids: [shifa.tests.CBC, shifa.tests.TSH]})).json().error, 'invalid_package_name');
        assert.equal((await add({name: 'Topic', topic: 'astrology', price_syp: 1, test_ids: [shifa.tests.CBC, shifa.tests.TSH]})).json().error, 'invalid_topic');
        const ok = (await add({name: 'Pair', price_syp: 1, test_ids: [shifa.tests.CBC, shifa.tests.TSH]})).json().package;
        assert.equal((await add({name: 'Pair', price_syp: 2, test_ids: [shifa.tests.CBC, shifa.tests.TSH]})).json().error, 'package_exists');
        assert.equal((await post(`/api/facility/packages/${ok.id}`, {price_syp: 5}, {cookie: other.cookie})).statusCode, 404);
        assert.equal((await post(`/api/facility/packages/${ok.id}/delete`, {}, {cookie: other.cookie})).statusCode, 404);
        const hospital = cookieOf(await post('/api/auth/facility/register', {name: 'Hana Haddad', email: 'h@example.org', password: 'facility password 123', consent: true, kind: 'hospital'}));
        assert.equal((await get('/api/facility/packages', hospital)).json().error, 'not_a_lab');
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org');
        assert.equal((await get('/api/facility/packages', patient)).statusCode, 403);
        // A lab that is not approved yet keeps packages, but they are not public.
        const pending = await lab({email: 'p@example.org', name: 'Pending Lab', status: 'pending'});
        await add({name: 'Soon', price_syp: 1, test_ids: [pending.tests.CBC, pending.tests.TSH]}, pending.cookie);
        assert.ok(!(await get('/api/lab-packages')).json().packages.some(k => k.name === 'Soon'));
    });
});
