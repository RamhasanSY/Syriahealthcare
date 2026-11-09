import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {origin, pool, setup, signInPatientByEmail, teardown} from './helpers.js';
import {multipart, PDF} from './fixtures.js';
import {mergePatients} from '../src/merge-patients.js';
import {resolvePatient} from '../src/access.js';
import {transaction} from '../src/db.js';

let app, post, mail;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: {cookie}});

async function patientWithEntry(email, name, title) {
    const cookie = await signInPatientByEmail(post, mail, email, name);
    const profile = (await get('/api/file', cookie)).json().profiles[0];
    await post(`/api/file/profiles/${profile.id}/consent`, {}, {cookie});
    const form = multipart({category: 'report', title}, [{filename: 'r.pdf', type: 'application/pdf', content: PDF}]);
    await app.inject({method: 'POST', url: `/api/file/profiles/${profile.id}/documents`, payload: form.body, headers: {origin, cookie, 'content-type': form.contentType}});
    return {cookie, profile};
}

describe('merging two profiles of the same person (master patient index)', () => {
    test('moves entries, consent and logins; the old number and id lead to the surviving profile', async () => {
        // The same woman signed up twice, once by phone-less email at home and once at work.
        const home = await patientWithEntry('lina@example.org', 'Lina Haddad', 'Report from home');
        const work = await patientWithEntry('lina.work@example.org', 'Lina Haddad', 'Report from work');
        const moved = await transaction(pool, db => mergePatients(db, work.profile.id, home.profile.id));
        assert.equal(moved.documents, 1);
        assert.equal(moved.logins, 1);

        for (const cookie of [home.cookie, work.cookie]) {
            const file = (await get('/api/file', cookie)).json();
            assert.deepEqual(file.profiles.map(p => p.patient_number), [home.profile.patient_number], 'both logins see the one profile');
            const items = (await get(`/api/file/profiles/${home.profile.id}/items`, cookie)).json().items;
            assert.deepEqual(items.map(i => i.title).sort(), ['Report from home', 'Report from work']);
        }
        assert.equal(await resolvePatient(pool, work.profile.id), home.profile.id, 'old links are followed');
        assert.equal((await get(`/api/file/profiles/${work.profile.id}/items`, work.cookie)).json().profile.id, home.profile.id);
        const {rows: ids} = await pool.query('SELECT value FROM patient_identifiers WHERE patient_id = $1 ORDER BY value', [home.profile.id]);
        assert.deepEqual(ids.map(r => r.value), [home.profile.patient_number, work.profile.patient_number].sort(), 'both numbers find the person');
        const {rows: consents} = await pool.query('SELECT withdrawn_at FROM consents WHERE patient_id = $1', [home.profile.id]);
        assert.equal(consents.filter(c => !c.withdrawn_at).length, 1, 'one active consent');
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'patient.merged'")).rows[0].n, 1);
    });

    test('refuses to merge a profile into itself or twice', async () => {
        const a = await patientWithEntry('a@example.org', 'Person A', 'Entry A');
        const b = await patientWithEntry('b@example.org', 'Person B', 'Entry B');
        await assert.rejects(transaction(pool, db => mergePatients(db, a.profile.id, a.profile.id)), /itself/);
        await transaction(pool, db => mergePatients(db, a.profile.id, b.profile.id));
        await assert.rejects(transaction(pool, db => mergePatients(db, a.profile.id, b.profile.id)), /already merged/);
    });
});
