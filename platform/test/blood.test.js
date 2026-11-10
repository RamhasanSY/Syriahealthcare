import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {createECDH, randomBytes} from 'node:crypto';
import {cookieOf, pool, setup, signInPatientByEmail, teardown} from './helpers.js';

let app, post, mail, push;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail, push} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});
const day = n => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', {timeZone: 'Asia/Damascus'});

async function facility({kind = 'blood_bank', email = 'bank@example.org', name = 'Damascus Blood Bank', status = 'approved', governorate = 'damascus'} = {}) {
    const cookie = cookieOf(await post('/api/auth/facility/register', {name: 'Rana Saleh', email, password: 'facility password 123', consent: true, kind}));
    const {rows: [f]} = await pool.query(`UPDATE facility_profiles p SET status = $2, facility_name = $3, governorate = $4, area = 'Mezzeh',
        address = 'Mezzeh Highway 1', phone = '+963112223344' FROM users u WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id`, [email, status, name, governorate]);
    return {cookie, id: f.user_id};
}
async function donor(email, {blood_type, governorate = 'damascus', last_donation_date = null}) {
    const cookie = await signInPatientByEmail(post, mail, email, `Donor ${email.split('@')[0]}`);
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`;
    await post('/api/push/subscribe', {endpoint, keys: {p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url')}}, {cookie});
    const res = await post('/api/donor', {blood_type, governorate, phone: '0944 123 456', last_donation_date, consent: true}, {cookie});
    assert.equal(res.statusCode, 200, res.body);
    return {cookie, endpoint};
}
const told = endpoint => push.sent.filter(m => m.endpoint === endpoint);

describe('blood donation calls', () => {
    test('a blood bank publishes a call; it is public without personal data and can be closed', async () => {
        const bank = await facility();
        const res = await post('/api/facility/blood-requests', {blood_types: ['O-', 'A+'], units: 4, urgency: 'urgent', needed_by: day(3), note: 'Donation room open 8–14'}, {cookie: bank.cookie});
        assert.equal(res.statusCode, 201, res.body);
        const call = res.json().request;
        assert.deepEqual(call.blood_types, ['O-', 'A+']);
        assert.equal(call.phone, '+963112223344', 'the facility phone by default');

        const list = (await get('/api/blood-requests')).json();
        assert.equal(list.requests.length, 1);
        assert.equal(list.requests[0].facility_name, 'Damascus Blood Bank');
        assert.doesNotMatch(JSON.stringify(list), /bank@example\.org|Rana|licence/i);
        assert.equal((await get('/api/blood-requests?governorate=aleppo')).json().requests.length, 0);
        assert.equal((await get('/api/blood-requests?blood_type=O-')).json().requests.length, 1, 'O- can give to everyone');
        assert.equal((await get('/api/blood-requests?blood_type=B%2B')).json().requests.length, 0, 'B+ cannot give to O- or A+');
        assert.equal((await get('/api/blood-requests?blood_type=O%2B')).json().requests.length, 1, 'O+ can give to A+');

        assert.equal((await post(`/api/facility/blood-requests/${call.id}/close`, {}, {cookie: bank.cookie})).statusCode, 200);
        assert.equal((await get('/api/blood-requests')).json().requests.length, 0);
        assert.equal((await get('/api/facility/blood-requests', bank.cookie)).json().requests[0].status, 'closed');
    });

    test('only approved blood banks and hospitals post calls, within limits', async () => {
        const pharmacy = await facility({kind: 'pharmacy', email: 'ph@example.org', name: 'Pharmacy'});
        assert.equal((await post('/api/facility/blood-requests', {blood_types: ['A+'], needed_by: day(1)}, {cookie: pharmacy.cookie})).json().error, 'not_a_blood_bank');
        const pending = await facility({email: 'p@example.org', status: 'pending'});
        assert.equal((await post('/api/facility/blood-requests', {blood_types: ['A+'], needed_by: day(1)}, {cookie: pending.cookie})).json().error, 'facility_not_approved');
        const hospital = await facility({kind: 'hospital', email: 'h@example.org', name: 'City Hospital'});
        const add = body => post('/api/facility/blood-requests', body, {cookie: hospital.cookie});
        assert.equal((await add({blood_types: ['A+'], needed_by: day(-1)})).json().error, 'invalid_date');
        assert.equal((await add({blood_types: ['A+'], needed_by: day(31)})).json().error, 'invalid_date');
        assert.equal((await add({blood_types: ['X+'], needed_by: day(1)})).statusCode, 400);
        assert.equal((await add({blood_types: ['A+'], needed_by: day(1), contact_phone: '12'})).json().error, 'invalid_phone');
        for (let i = 0; i < 10; i++) assert.equal((await add({blood_types: ['A+'], needed_by: day(1)})).statusCode, 201);
        assert.equal((await add({blood_types: ['A+'], needed_by: day(1)})).json().error, 'too_many_requests');
        const patient = await signInPatientByEmail(post, mail, 'lina@example.org');
        assert.equal((await post('/api/facility/blood-requests', {blood_types: ['A+'], needed_by: day(1)}, {cookie: patient})).statusCode, 403);
    });
});

describe('donors', () => {
    test('matching donors in the governorate are told once a day, not soon after a donation', async () => {
        const bank = await facility();
        const oNeg = await donor('o@example.org', {blood_type: 'O-'});
        const bPos = await donor('b@example.org', {blood_type: 'B+'});
        const aleppo = await donor('al@example.org', {blood_type: 'O-', governorate: 'aleppo'});
        const rested = await donor('r@example.org', {blood_type: 'A+', last_donation_date: day(-10)});
        const res = await post('/api/facility/blood-requests', {blood_types: ['A+'], needed_by: day(2), urgency: 'urgent'}, {cookie: bank.cookie});
        assert.equal(res.json().request.notified, 1);
        assert.equal(told(oNeg.endpoint).at(-1).message.title, 'مطلوب متبرعون بالدم قربك');
        assert.equal(told(oNeg.endpoint).at(-1).message.url, '/blood');
        for (const other of [bPos, aleppo, rested]) assert.equal(told(other.endpoint).length, 0);
        const {rows: [email]} = await pool.query("SELECT body FROM email_outbox WHERE to_address = 'o@example.org'");
        assert.match(email.body, /Damascus Blood Bank/);
        assert.match(email.body, /\+963112223344/);
        // A second call the same day does not wake the same donor again.
        assert.equal((await post('/api/facility/blood-requests', {blood_types: ['O-'], needed_by: day(2)}, {cookie: bank.cookie})).json().request.notified, 0);
    });

    test('a donor answers a call; only that facility sees name and phone; leaving removes everything', async () => {
        const bank = await facility(), other = await facility({email: 'x@example.org', name: 'Other Bank'});
        const bankDevice = randomBytes(8).toString('hex');
        const ecdh = createECDH('prime256v1');
        ecdh.generateKeys();
        await post('/api/push/subscribe', {endpoint: `https://fcm.googleapis.com/fcm/send/${bankDevice}`,
            keys: {p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url')}}, {cookie: bank.cookie});
        const call = (await post('/api/facility/blood-requests', {blood_types: ['A+'], needed_by: day(2)}, {cookie: bank.cookie})).json().request;
        const omar = await donor('omar@example.org', {blood_type: 'O+'});
        const bina = await donor('bina@example.org', {blood_type: 'B+'});
        assert.equal((await post(`/api/blood-requests/${call.id}/respond`, {}, {cookie: bina.cookie})).json().error, 'blood_type_mismatch');
        const answer = await post(`/api/blood-requests/${call.id}/respond`, {}, {cookie: omar.cookie});
        assert.equal(answer.json().responded, true);
        await post(`/api/blood-requests/${call.id}/respond`, {}, {cookie: omar.cookie});
        assert.equal(push.sent.filter(m => m.endpoint.endsWith(bankDevice)).at(-1).message.title, 'استجاب متبرع لندائكم');

        const responses = (await get(`/api/facility/blood-requests/${call.id}/responses`, bank.cookie)).json().responses;
        assert.deepEqual(responses.map(r => [r.name, r.phone, r.blood_type]), [['Donor omar', '+963944123456', 'O+']]);
        assert.equal((await get(`/api/facility/blood-requests/${call.id}/responses`, other.cookie)).statusCode, 404);
        const {rows: audits} = await pool.query("SELECT 1 FROM audit_log WHERE action = 'blood_responses.listed'");
        assert.equal(audits.length, 1);

        const stranger = await signInPatientByEmail(post, mail, 's@example.org');
        assert.equal((await post(`/api/blood-requests/${call.id}/respond`, {}, {cookie: stranger})).json().error, 'donor_required');
        assert.equal((await post('/api/donor', {blood_type: 'A+', governorate: 'damascus', phone: '0944 000 111'}, {cookie: stranger})).json().error, 'consent_required');
        assert.equal((await post('/api/donor', {blood_type: 'A+', governorate: 'nowhere', phone: '0944 000 111', consent: true}, {cookie: stranger})).json().error, 'invalid_governorate');

        assert.equal((await post('/api/donor/delete', {}, {cookie: omar.cookie})).json().deleted, true);
        assert.equal((await get(`/api/facility/blood-requests/${call.id}/responses`, bank.cookie)).json().responses.length, 0);
        assert.equal((await get('/api/donor', omar.cookie)).json().donor, null);
    });

    test('with the health file switched off there is no donor register, but the calls are shown', async () => {
        const bank = await facility();
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org');
        app.config.healthFile = false;
        try {
            const call = (await post('/api/facility/blood-requests', {blood_types: ['A+'], needed_by: day(2)}, {cookie: bank.cookie})).json().request;
            assert.equal((await get('/api/blood-requests')).json().donors, false);
            assert.equal((await get('/api/blood-requests')).json().requests.length, 1);
            assert.equal((await get('/api/donor', lina)).statusCode, 404);
            assert.equal((await post('/api/donor', {blood_type: 'A+', governorate: 'damascus', phone: '0944000111', consent: true}, {cookie: lina})).statusCode, 404);
            assert.equal((await post(`/api/blood-requests/${call.id}/respond`, {}, {cookie: lina})).statusCode, 404);
        } finally {
            app.config.healthFile = true;
        }
    });
});
