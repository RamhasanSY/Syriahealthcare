// Notifications on the phone or computer ("Web Push", RFC 8030), built on node:crypto alone, without a third-party library:
// each message is encrypted for the one device (RFC 8291, only that browser can read it) and signed with our VAPID key
// (RFC 8292), so the browser's push service knows it comes from this server.
//
// Messages never name a doctor, lab, result or medicine by default: a phone's lock screen can be seen by others. They say
// that something is new and open the page where the signed-in person sees the details.
//
// The server only ever sends to the push services of the browsers (PUSH_HOSTS). An address someone types in is refused,
// so nobody can make the server send requests to other machines.
import {createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign} from 'node:crypto';
import {HttpError, requireRole} from './auth.js';

const b64u = bytes => Buffer.from(bytes).toString('base64url');
const fromB64u = text => Buffer.from(String(text), 'base64url');

// Google (Chrome, Edge on Android, Samsung), Mozilla (Firefox), Apple (Safari, installed apps on iPhone), Microsoft (Edge on Windows).
export const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;
export const LIMITS = {devicesPerUser: 10, payloadBytes: 3000, failuresBeforeRemoval: 5};

export function validEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
    try {
        const url = new URL(endpoint);
        return url.protocol === 'https:' && !url.port && !url.username && !url.password && PUSH_HOSTS.test(url.hostname);
    } catch (_) {
        return false;
    }
}

// A key pair for VAPID: `node -e "import('./src/push.js').then(m => console.log(m.generateVapidKeys()))"`.
export function generateVapidKeys() {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey())};
}

function vapidSigningKey(publicKey, privateKey) {
    const pub = fromB64u(publicKey);
    if (pub.length !== 65 || pub[0] !== 4) throw new Error('PUSH_PUBLIC_KEY must be an uncompressed P-256 public key (base64url)');
    return createPrivateKey({format: 'jwk', key: {kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: privateKey}});
}

// "vapid t=<signed JWT>, k=<public key>" for one push service (the JWT's audience is the service's origin).
export function vapidAuthorization(endpoint, {publicKey, signingKey, subject}, now = Date.now()) {
    const header = b64u(JSON.stringify({typ: 'JWT', alg: 'ES256'}));
    const claims = b64u(JSON.stringify({aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject}));
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {key: signingKey, dsaEncoding: 'ieee-p1363'});
    return `vapid t=${header}.${claims}.${b64u(signature)}, k=${publicKey}`;
}

// RFC 8291 with the "aes128gcm" content coding of RFC 8188: one record, a fresh key pair and salt per message.
export function encryptPayload(payload, {p256dh, auth}) {
    const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth);
    if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('Invalid subscription keys');
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey(), shared = ecdh.computeSecret(uaPublic);
    const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
    const salt = randomBytes(16);
    const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const cipher = createCipheriv('aes-128-gcm', key, nonce);
    // 0x02 marks the last (and only) record.
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(4096, 16);
    header[20] = asPublic.length;
    return Buffer.concat([header, asPublic, body]);
}

// The sender. Without keys (PUSH_PUBLIC_KEY, PUSH_PRIVATE_KEY) push is off and the app hides the switch.
// provider "test" keeps the messages in `sent` (tests); `fail` maps an endpoint to the HTTP status to answer.
export function createPush(config, log) {
    const settings = config.push || {};
    if (settings.provider === 'test') {
        const sent = [], fail = new Map();
        return {available: true, publicKey: 'BTestKey', sent, fail, async send(subscription, message) {
            const status = fail.get(subscription.endpoint) || 201;
            if (status < 300) sent.push({endpoint: subscription.endpoint, message});
            return status;
        }};
    }
    if (!settings.publicKey || !settings.privateKey) return {available: false, async send() { return 0; }};
    const signingKey = vapidSigningKey(settings.publicKey, settings.privateKey);
    const vapid = {publicKey: settings.publicKey, signingKey, subject: settings.subject};
    return {available: true, publicKey: settings.publicKey, async send(subscription, message, {ttl = 86400, urgency = 'normal'} = {}) {
        const body = encryptPayload(JSON.stringify(message), subscription);
        try {
            const response = await fetch(subscription.endpoint, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), body, headers: {
                'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency,
                Authorization: vapidAuthorization(subscription.endpoint, vapid)
            }});
            if (response.status >= 400 && response.status !== 404 && response.status !== 410) log?.warn({status: response.status}, 'Push refused');
            return response.status;
        } catch (error) {
            log?.warn({err: error}, 'Push not delivered');
            return 0;
        }
    }};
}

// Sends one message to every device of a person, in the person's language. Never throws: a notification is a courtesy,
// the action that caused it is already saved. Devices the push service no longer knows (404, 410) are forgotten.
// message: {title: [en, ar], body: [en, ar], url: '/page', tag?, urgency?}
export async function pushToUser(app, userId, message) {
    if (!app.push?.available) return 0;
    try {
        const {rows: [user]} = await app.pg.query('SELECT language FROM users WHERE id = $1 AND disabled_at IS NULL', [userId]);
        if (!user) return 0;
        const {rows: devices} = await app.pg.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
        const pick = pair => user.language === 'en' ? pair[0] : pair[1];
        const payload = {title: pick(message.title), body: pick(message.body), url: message.url || '/account', tag: message.tag || null, lang: user.language};
        if (Buffer.byteLength(JSON.stringify(payload)) > LIMITS.payloadBytes) throw new Error('Push message too long');
        let delivered = 0;
        for (const device of devices) {
            const status = await app.push.send(device, payload, {urgency: message.urgency || 'normal'});
            if (status >= 200 && status < 300) {
                delivered++;
                await app.pg.query('UPDATE push_subscriptions SET last_sent_at = now(), failures = 0 WHERE id = $1', [device.id]);
            } else if (status === 404 || status === 410) {
                await app.pg.query('DELETE FROM push_subscriptions WHERE id = $1', [device.id]);
            } else {
                await app.pg.query(`DELETE FROM push_subscriptions WHERE id = $1 AND failures + 1 >= $2`, [device.id, LIMITS.failuresBeforeRemoval]);
                await app.pg.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [device.id]);
            }
        }
        return delivered;
    } catch (error) {
        app.log.error({err: error}, 'Push to user failed');
        return 0;
    }
}

export default async function pushRoutes(app) {
    const signedIn = requireRole('patient', 'doctor', 'facility', 'admin');

    // Public: whether push is offered, and the key the browser needs to subscribe.
    app.get('/api/push/key', async () => ({available: app.push.available, public_key: app.push.available ? app.push.publicKey : null}));

    app.post('/api/push/subscribe', {preHandler: signedIn, config: {rateLimit: {max: 30, timeWindow: '15 minutes'}}, schema: {body: {type: 'object',
        required: ['endpoint', 'keys'], additionalProperties: false, properties: {
            endpoint: {type: 'string', maxLength: 1000},
            keys: {type: 'object', required: ['p256dh', 'auth'], additionalProperties: false, properties: {
                p256dh: {type: 'string', maxLength: 200}, auth: {type: 'string', maxLength: 100}}},
            expirationTime: {type: ['number', 'null']}
        }}}}, async request => {
        if (!app.push.available) throw new HttpError(404, 'push_unavailable', 'Notifications are not available yet.');
        const {endpoint, keys} = request.body;
        if (!validEndpoint(endpoint)) throw new HttpError(400, 'invalid_endpoint', 'This browser cannot receive notifications from SyriaHC.');
        const p256dh = fromB64u(keys.p256dh), auth = fromB64u(keys.auth);
        if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) throw new HttpError(400, 'invalid_endpoint', 'This browser cannot receive notifications from SyriaHC.');
        // One device, one person: a device that someone else used before now belongs to whoever subscribes now.
        await app.pg.query(
            `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                 user_agent = EXCLUDED.user_agent, failures = 0`,
            [request.user.id, endpoint, b64u(p256dh), b64u(auth), String(request.headers['user-agent'] || '').slice(0, 200)]);
        // At most LIMITS.devicesPerUser devices per person: the oldest go first.
        await app.pg.query(
            `DELETE FROM push_subscriptions WHERE user_id = $1 AND id NOT IN
                (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`, [request.user.id, LIMITS.devicesPerUser]);
        return {subscribed: true};
    });

    app.post('/api/push/unsubscribe', {preHandler: signedIn, schema: {body: {type: 'object', required: ['endpoint'], additionalProperties: false,
        properties: {endpoint: {type: 'string', maxLength: 1000}}}}}, async request => {
        const {rowCount} = await app.pg.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [request.body.endpoint, request.user.id]);
        return {unsubscribed: rowCount > 0};
    });

    // "Send a test notification" on the account page.
    app.post('/api/push/test', {preHandler: signedIn, config: {rateLimit: {max: 5, timeWindow: '15 minutes'}}}, async request => ({
        sent: await pushToUser(app, request.user.id, {title: ['SyriaHC', 'صحة تك'],
            body: ['Notifications are on for this device.', 'الإشعارات مفعّلة على هذا الجهاز.'], url: '/account', tag: 'test'})
    }));
}
