import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {createECDH, randomBytes} from 'node:crypto';
import {pool, setup, signInPatientByEmail, teardown} from './helpers.js';
import {sendMedicationReminders} from '../src/medications.js';

let app, post, mail, push;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail, push} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});
const TZ = 'Asia/Damascus';
const hhmm = ms => new Date(ms).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ});
const today = () => new Date().toLocaleDateString('en-CA', {timeZone: TZ});

// A patient with a health file they agreed to, and notifications on one phone.
async function patient(email = 'lina@example.org') {
    const cookie = await signInPatientByEmail(post, mail, email, 'Lina Nasser');
    const self = (await get('/api/file', cookie)).json().profiles[0];
    await post(`/api/file/profiles/${self.id}/consent`, {}, {cookie});
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`;
    await post('/api/push/subscribe', {endpoint, keys: {p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url')}}, {cookie});
    return {cookie, self, endpoint};
}

describe('medicine reminders', () => {
    test('a medicine is reminded once at its time, without its name unless chosen', async () => {
        const lina = await patient();
        const now = Date.now(), at = now - 2 * 60_000;
        const quiet = await post('/api/medications', {profile_id: lina.self.id, name: 'Sertraline', dose: '50 mg', times: [hhmm(at), '23:59']}, {cookie: lina.cookie});
        assert.equal(quiet.statusCode, 201, quiet.body);
        assert.equal(await sendMedicationReminders(app, now), 1);
        assert.equal(await sendMedicationReminders(app, now + 30_000), 0, 'once');
        const message = push.sent.filter(m => m.endpoint === lina.endpoint).at(-1).message;
        assert.equal(message.title, 'حان وقت الدواء');
        assert.equal(message.url, '/medications');
        assert.doesNotMatch(JSON.stringify(push.sent), /Sertraline|50 mg/);

        await post('/api/medications', {profile_id: lina.self.id, name: 'Vitamin D', dose: '1 tablet', times: [hhmm(at)], show_name: true}, {cookie: lina.cookie});
        assert.equal(await sendMedicationReminders(app, now), 1);
        assert.equal(push.sent.at(-1).message.title, 'حان وقت Vitamin D');
        assert.equal(push.sent.at(-1).message.body, '1 tablet');

        // More than 10 minutes late: skipped, not sent late.
        await post('/api/medications', {profile_id: lina.self.id, name: 'Late one', times: [hhmm(now - 20 * 60_000)]}, {cookie: lina.cookie});
        assert.equal(await sendMedicationReminders(app, now), 0);
    });

    test('days of the week, paused medicines and end dates are respected', async () => {
        const lina = await patient();
        const now = Date.now(), at = hhmm(now - 60_000);
        const weekday = new Date(today() + 'T00:00:00Z').getUTCDay();
        await post('/api/medications', {profile_id: lina.self.id, name: 'Other day', times: [at], weekdays: [(weekday + 1) % 7]}, {cookie: lina.cookie});
        const paused = (await post('/api/medications', {profile_id: lina.self.id, name: 'Paused', times: [at]}, {cookie: lina.cookie})).json().medication;
        await post(`/api/medications/${paused.id}`, {active: false}, {cookie: lina.cookie});
        const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', {timeZone: TZ});
        await pool.query(`INSERT INTO medications (patient_id, name, times, start_date, end_date) VALUES ($1, 'Ended', $2, $3, $3)`,
            [lina.self.id, [at], new Date(Date.now() - 3 * 86400000).toLocaleDateString('en-CA', {timeZone: TZ})]);
        assert.ok(yesterday);
        assert.equal(await sendMedicationReminders(app, now), 0);
        assert.equal((await post('/api/medications', {profile_id: lina.self.id, name: 'Bad', times: ['08:00'], start_date: '2026-12-10', end_date: '2026-12-01'},
            {cookie: lina.cookie})).json().error, 'invalid_date');
    });

    test("today's doses are ticked as taken; a parent is reminded about a child's medicine", async () => {
        const lina = await patient();
        const child = (await post('/api/file/profiles', {name: 'Sami Nasser', birth_date: '2020-05-01'}, {cookie: lina.cookie})).json().profile;
        assert.equal((await post('/api/medications', {profile_id: child.id, name: 'Amoxicillin', times: ['08:00']}, {cookie: lina.cookie})).json().error,
            'file_consent_required', "the child's health file needs agreement first");
        await post(`/api/file/profiles/${child.id}/consent`, {}, {cookie: lina.cookie});
        const now = Date.now();
        const med = (await post('/api/medications', {profile_id: child.id, name: 'Amoxicillin', dose: '5 ml', times: [hhmm(now - 60_000), '23:59']},
            {cookie: lina.cookie})).json().medication;
        assert.equal(await sendMedicationReminders(app, now), 1);
        assert.equal(push.sent.filter(m => m.endpoint === lina.endpoint).length, 1, 'the parent gets it');

        const view = (await get('/api/medications', lina.cookie)).json();
        const kid = view.profiles.find(p => p.id === child.id);
        const dose = kid.today.find(d => d.medication_id === med.id && Date.parse(d.scheduled_for) <= now);
        assert.equal(dose.taken, false);
        assert.equal((await post(`/api/medications/${med.id}/dose`, {scheduled_for: dose.scheduled_for}, {cookie: lina.cookie})).json().taken, true);
        assert.equal((await get('/api/medications', lina.cookie)).json().profiles.find(p => p.id === child.id).today.find(d => d.scheduled_for === dose.scheduled_for).taken, true);
        assert.equal((await post(`/api/medications/${med.id}/dose`, {scheduled_for: dose.scheduled_for, taken: false}, {cookie: lina.cookie})).json().taken, false);
        assert.equal((await post(`/api/medications/${med.id}/dose`, {scheduled_for: new Date(now - 3 * 86400000).toISOString()}, {cookie: lina.cookie})).json().error, 'invalid_dose');
    });

    test("nobody else sees or changes someone's medicines; off with the health file", async () => {
        const lina = await patient();
        const med = (await post('/api/medications', {profile_id: lina.self.id, name: 'Insulin', times: ['08:00', '20:00']}, {cookie: lina.cookie})).json().medication;
        const omar = await patient('omar@example.org');
        assert.equal((await post(`/api/medications/${med.id}`, {name: 'Changed'}, {cookie: omar.cookie})).statusCode, 404);
        assert.equal((await post(`/api/medications/${med.id}/delete`, {}, {cookie: omar.cookie})).statusCode, 404);
        assert.equal((await post('/api/medications', {profile_id: lina.self.id, name: 'X ray', times: ['08:00']}, {cookie: omar.cookie})).statusCode, 404);
        assert.ok(!JSON.stringify((await get('/api/medications', omar.cookie)).json()).includes('Insulin'));
        const {rows} = await pool.query("SELECT details FROM audit_log WHERE action = 'medication.added'");
        assert.equal(rows[0].details.patient_id, lina.self.id, 'recorded in the file history');

        app.config.healthFile = false;
        try {
            assert.equal((await get('/api/medications', lina.cookie)).statusCode, 404);
            assert.equal((await post('/api/medications', {profile_id: lina.self.id, name: 'Insulin', times: ['08:00']}, {cookie: lina.cookie})).statusCode, 404);
            assert.equal(await sendMedicationReminders(app), 0);
        } finally {
            app.config.healthFile = true;
        }
        assert.equal((await post(`/api/medications/${med.id}/delete`, {}, {cookie: lina.cookie})).json().deleted, true);
    });
});
