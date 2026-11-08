import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {cookieOf, pool, setup, teardown} from './helpers.js';

let app, post;
beforeEach(async () => {
    await app?.close();
    ({app, post} = await setup());
});
after(() => teardown(app));

async function lab(email = 'lab@example.org') {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind: 'lab'}));
    const {rows: [{id}]} = await pool.query(`UPDATE facility_profiles p SET status = 'approved', facility_name = 'Al Shifa Laboratory'
        FROM users u WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id AS id`, [email]);
    return {cookie, id};
}

// A result row without a stored file: enough for listing and searching.
async function result(facilityId, {name = 'Ahmad Khaled', phone = '+963912345678', title = 'Complete blood count', at = new Date().toISOString(), expires = '90 days'} = {}) {
    const {rows: [row]} = await pool.query(
        `INSERT INTO lab_results (facility_id, patient_name, patient_phone, title, code_hash, code_expires_at, filename, mime, size_bytes,
             sha256, storage_key, iv, auth_tag, created_at)
         VALUES ($1, $2, $3, $4, encode(gen_random_bytes(16), 'hex'), $5::timestamptz + $6::interval, 'r.pdf', 'application/pdf', 10,
             'x', gen_random_uuid()::text, 'iv', 'tag', $5::timestamptz) RETURNING id`, [facilityId, name, phone, title, at, expires]);
    return row.id;
}

const list = (cookie, params = {}) => app.inject({url: '/api/lab/results?' + new URLSearchParams(params), headers: {cookie}});

describe('lab results search', () => {
    test('finds a patient by part of the name, in any case, and a test by its title', async () => {
        const l = await lab();
        await result(l.id, {name: 'Ahmad Khaled', title: 'Complete blood count'});
        await result(l.id, {name: 'Lina Haddad', phone: '+963933111222', title: 'Thyroid hormones'});
        assert.deepEqual((await list(l.cookie, {q: 'ahmad'})).json().results.map(r => r.patient_name), ['Ahmad Khaled']);
        assert.deepEqual((await list(l.cookie, {q: 'THYROID'})).json().results.map(r => r.patient_name), ['Lina Haddad']);
        assert.equal((await list(l.cookie, {q: '%'})).json().results.length, 0, 'a percent sign is not a wildcard');
    });

    test('finds a mobile number written in any usual form, or by its last digits', async () => {
        const l = await lab();
        await result(l.id, {name: 'Ahmad Khaled', phone: '+963912345678'});
        await result(l.id, {name: 'Lina Haddad', phone: '+963933111222'});
        for (const q of ['0912 345 678', '+963 912 345 678', '00963912345678', '5678', '345-678']) {
            assert.deepEqual((await list(l.cookie, {q})).json().results.map(r => r.patient_name), ['Ahmad Khaled'], q);
        }
        assert.equal((await list(l.cookie, {q: '0999 999 999'})).json().results.length, 0);
    });

    test('filters by days in Syria time and keeps results older than 90 days', async () => {
        const l = await lab();
        await result(l.id, {name: 'January', at: '2026-01-10T10:00:00Z'});
        await result(l.id, {name: 'Late March', at: '2026-03-31T21:30:00Z'});  // already 1 April in Damascus (UTC+3)
        await result(l.id, {name: 'Early March', at: '2026-03-05T10:00:00Z'});
        const march = (await list(l.cookie, {from: '2026-03-01', to: '2026-03-31'})).json().results.map(r => r.patient_name);
        assert.deepEqual(march, ['Early March']);
        const all = (await list(l.cookie)).json().results.map(r => r.patient_name);
        assert.deepEqual(all, ['Late March', 'Early March', 'January'], 'no 90-day limit, newest first');
    });

    test('pages through many results, 50 at a time, with nothing lost or repeated, even at the same time', async () => {
        const l = await lab();
        const at = '2026-05-01T08:00:00Z';
        for (let i = 0; i < 120; i++) await result(l.id, {name: `Patient ${i}`, at});
        const seen = [];
        let cursor, pages = 0;
        do {
            const res = (await list(l.cookie, cursor ? {cursor} : {})).json();
            seen.push(...res.results.map(r => r.id));
            cursor = res.next_cursor;
            pages++;
        } while (cursor);
        assert.equal(pages, 3);
        assert.equal(seen.length, 120);
        assert.equal(new Set(seen).size, 120, 'no result twice');
    });

    test('a broken cursor is refused', async () => {
        const l = await lab();
        const res = await list(l.cookie, {cursor: 'not-a-cursor'});
        assert.equal(res.statusCode, 400);
        assert.equal(res.json().error, 'invalid_cursor');
    });

    test('a lab only ever finds its own results', async () => {
        const a = await lab('a@example.org'), b = await lab('b@example.org');
        await result(a.id, {name: 'Ahmad Khaled'});
        assert.equal((await list(b.cookie, {q: 'Ahmad'})).json().results.length, 0);
        assert.equal((await list(b.cookie)).json().results.length, 0);
    });

    test('the list tells whether the code still works, and never how many doctors opened a result', async () => {
        const l = await lab();
        await result(l.id, {name: 'Fresh', expires: '90 days'});
        await result(l.id, {name: 'Old', at: '2025-01-01T10:00:00Z', expires: '90 days'});
        const results = (await list(l.cookie)).json().results;
        assert.deepEqual(results.map(r => [r.patient_name, r.code_expired]), [['Fresh', false], ['Old', true]]);
        assert.ok(results.every(r => !('doctors' in r)));
    });
});
