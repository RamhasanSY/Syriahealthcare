import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify} from 'node:crypto';
import {approvedDoctor, pool, setup, signInPatientByEmail, teardown} from './helpers.js';
import {encryptPayload, generateVapidKeys, validEndpoint, vapidAuthorization} from '../src/push.js';
import {createPrivateKey} from 'node:crypto';

let app, post, mail, push;
beforeEach(async () => {
    await app?.close();
    ({app, post, mail, push} = await setup());
});
after(() => teardown(app));

const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});

// A browser's side of a subscription: its key pair and auth secret.
function browser(host = 'fcm.googleapis.com') {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = randomBytes(16);
    return {ecdh, auth, subscription: {endpoint: `https://${host}/fcm/send/${randomBytes(12).toString('hex')}`,
        keys: {p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url')}}};
}

// What the browser does with a message (RFC 8291 / RFC 8188), written independently of src/push.js.
function decrypt(body, {ecdh, auth}) {
    const salt = body.subarray(0, 16), idLength = body[20], asPublic = body.subarray(21, 21 + idLength);
    assert.equal(body.readUInt32BE(16), 4096);
    const shared = ecdh.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
    const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const data = body.subarray(21 + idLength);
    const decipher = createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    assert.equal(plain.at(-1), 2, 'last record delimiter');
    return plain.subarray(0, -1).toString();
}

describe('Web Push building blocks', () => {
    test('a message can only be read by the browser it was encrypted for', () => {
        const device = browser(), other = browser();
        const body = encryptPayload(JSON.stringify({title: 'تم تأكيد موعدك'}), device.subscription.keys);
        assert.deepEqual(JSON.parse(decrypt(body, device)), {title: 'تم تأكيد موعدك'});
        assert.throws(() => decrypt(body, other));
        assert.notDeepEqual(encryptPayload('same', device.subscription.keys), encryptPayload('same', device.subscription.keys), 'fresh keys every time');
        assert.throws(() => encryptPayload('x', {p256dh: 'short', auth: device.subscription.keys.auth}));
    });

    test('the VAPID header is a JWT for the push service, signed with our key', () => {
        const keys = generateVapidKeys(), pub = Buffer.from(keys.publicKey, 'base64url');
        const jwk = {kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url')};
        const signingKey = createPrivateKey({format: 'jwk', key: {...jwk, d: keys.privateKey}});
        const now = Date.UTC(2026, 10, 10, 12);
        const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', {publicKey: keys.publicKey, signingKey, subject: 'mailto:noreply@syriahc.com'}, now);
        const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
        assert.equal(k, keys.publicKey);
        const [h, c, s] = token.split('.');
        assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), {typ: 'JWT', alg: 'ES256'});
        const claims = JSON.parse(Buffer.from(c, 'base64url'));
        assert.equal(claims.aud, 'https://fcm.googleapis.com');
        assert.equal(claims.exp, now / 1000 + 12 * 3600);
        assert.equal(claims.sub, 'mailto:noreply@syriahc.com');
        assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), {key: createPublicKey({format: 'jwk', key: jwk}), dsaEncoding: 'ieee-p1363'}, Buffer.from(s, 'base64url')));
    });

    test('only the browsers\' push services are accepted as addresses', () => {
        for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x',
            'https://web.push.apple.com/QX', 'https://wns2-db5p.notify.windows.com/w/?token=x']) assert.equal(validEndpoint(ok), true, ok);
        for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://user:pw@fcm.googleapis.com/x',
            'https://127.0.0.1/x', 'https://db:5432/x', 'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com',
            'https://localhost/x', 'javascript:alert(1)', 'x'.repeat(2000), null]) assert.equal(validEndpoint(bad), false, String(bad).slice(0, 60));
    });
});

describe('notifications on the account', () => {
    test('a signed-in person turns notifications on and off for a device', async () => {
        assert.deepEqual((await get('/api/push/key')).json(), {available: true, public_key: 'BTestKey'});
        const device = browser();
        assert.equal((await post('/api/push/subscribe', device.subscription)).statusCode, 401);
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina');
        const res = await post('/api/push/subscribe', {...device.subscription, expirationTime: null}, {cookie: lina});
        assert.equal(res.statusCode, 200);
        assert.equal((await post('/api/push/subscribe', {...device.subscription, endpoint: 'https://169.254.169.254/latest'}, {cookie: lina})).json().error, 'invalid_endpoint');
        assert.equal((await post('/api/push/subscribe', {...device.subscription, keys: {p256dh: 'AAAA', auth: 'AAAA'}}, {cookie: lina})).json().error, 'invalid_endpoint');

        assert.equal((await post('/api/push/test', {}, {cookie: lina})).json().sent, 1);
        assert.deepEqual(push.sent.at(-1).message, {title: 'صحة تك', body: 'الإشعارات مفعّلة على هذا الجهاز.', url: '/account', tag: 'test', lang: 'ar'});

        // The same phone, now used by someone else: it belongs to the new person only.
        const omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar');
        await post('/api/push/subscribe', device.subscription, {cookie: omar});
        assert.equal((await post('/api/push/test', {}, {cookie: lina})).json().sent, 0);
        assert.equal((await post('/api/push/test', {}, {cookie: omar})).json().sent, 1);

        assert.equal((await post('/api/push/unsubscribe', {endpoint: device.subscription.endpoint}, {cookie: lina})).json().unsubscribed, false, 'not hers any more');
        assert.equal((await post('/api/push/unsubscribe', {endpoint: device.subscription.endpoint}, {cookie: omar})).json().unsubscribed, true);
        assert.equal((await post('/api/push/test', {}, {cookie: omar})).json().sent, 0);
    });

    test('at most 10 devices per person; devices the push service forgot are removed', async () => {
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org');
        const devices = [];
        for (let i = 0; i < 12; i++) {
            devices.push(browser());
            await post('/api/push/subscribe', devices.at(-1).subscription, {cookie: lina});
        }
        const {rows: [{n}]} = await pool.query('SELECT count(*)::int AS n FROM push_subscriptions');
        assert.equal(n, 10);
        push.fail.set(devices.at(-1).subscription.endpoint, 410);
        push.fail.set(devices.at(-2).subscription.endpoint, 500);
        assert.equal((await post('/api/push/test', {}, {cookie: lina})).json().sent, 8);
        const {rows} = await pool.query('SELECT endpoint, failures FROM push_subscriptions');
        assert.equal(rows.length, 9, 'the 410 device is gone');
        assert.equal(rows.find(r => r.endpoint === devices.at(-2).subscription.endpoint).failures, 1, 'a temporary error is counted, not removed');
    });

    test('appointments and their decisions notify without naming the doctor', async () => {
        const doctor = await approvedDoctor(post, 'dr@example.org', 'Dr. Psychiatrist');
        const lina = await signInPatientByEmail(post, mail, 'lina@example.org');
        const phone = browser(), clinic = browser('updates.push.services.mozilla.com');
        await post('/api/push/subscribe', phone.subscription, {cookie: lina});
        await post('/api/push/subscribe', clinic.subscription, {cookie: doctor.cookie});

        const slots = (await get(`/api/doctors/${doctor.id}/slots?days=7`)).json().slots;
        const booked = (await post('/api/appointments', {doctor_id: doctor.id, starts_at: slots[3].starts_at}, {cookie: lina})).json().appointment;
        const toDoctor = push.sent.filter(m => m.endpoint === clinic.subscription.endpoint);
        assert.equal(toDoctor.at(-1).message.title, 'طلب موعد جديد');
        assert.equal(toDoctor.at(-1).message.url, '/dashboard');

        await post(`/api/doctor/appointments/${booked.id}/confirm`, {}, {cookie: doctor.cookie});
        const toPatient = push.sent.filter(m => m.endpoint === phone.subscription.endpoint).at(-1).message;
        assert.equal(toPatient.title, 'تم تأكيد موعدك');
        assert.equal(toPatient.url, '/appointments');
        assert.doesNotMatch(JSON.stringify(push.sent), /Psychiatrist|Heart Clinic|Mezzeh/, 'no names on the lock screen');

        await post(`/api/appointments/${booked.id}/cancel`, {}, {cookie: lina});
        assert.equal(push.sent.filter(m => m.endpoint === clinic.subscription.endpoint).at(-1).message.title, 'ألغى مريض موعده');
    });
});
