// Video consultations: a confirmed appointment booked as "video" becomes a call between the doctor's and the patient's
// browser (WebRTC). Picture and sound go directly between the two devices, or through our own TURN relay where a direct
// connection is not possible; they are never recorded and never stored on the server.
//
// The server only passes the setup messages between the two (signalling), from 15 minutes before the appointment until
// 2 hours after its end, and only to the patient and the doctor of this appointment. Doctors confirm it is them with the
// emailed code first, as for lab results. The whole service is off until VIDEO=on (decided by the operator after the
// legal check of remote consultations) and each doctor switches it on for themselves.
//
// The calling order is fixed so both sides never offer at once: each side says "hello" when it joins; the doctor answers
// a patient's hello (or a patient already waiting) with an offer, the patient answers the offer. Each offer starts a new
// session id, and candidates of an older session are ignored.
import {createHmac} from 'node:crypto';
import {HttpError, requireRole} from './auth.js';
import {audit} from './db.js';

export const LIMITS = {earlyMinutes: 15, lateMinutes: 120, messages: 400, messageBytes: 20_000, waitSeconds: 25, roomHours: 4};
const TYPES = ['hello', 'offer', 'answer', 'candidate', 'bye'];
const idParam = {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}};

// Short-lived TURN credentials ("REST API" of coturn, use-auth-secret): valid 2 hours, tied to the person.
export function turnCredentials(secret, userId, now = Date.now()) {
    const username = `${Math.floor(now / 1000) + 2 * 3600}:${userId}`;
    return {username, credential: createHmac('sha1', secret).update(username).digest('base64')};
}

export function iceServers(config, userId) {
    const v = config.video || {};
    const servers = [];
    if (v.stunUrls?.length) servers.push({urls: v.stunUrls});
    if (v.turnUrls?.length && v.turnSecret) servers.push({urls: v.turnUrls, ...turnCredentials(v.turnSecret, userId)});
    return servers;
}

// The rooms live in memory: one server process, and nothing of a call is worth keeping.
export function createRooms() {
    const rooms = new Map();
    const room = id => {
        let r = rooms.get(id);
        if (!r) rooms.set(id, r = {messages: [], next: 1, waiters: new Set(), created: Date.now(), joined: new Set()});
        return r;
    };
    const sweep = () => {
        for (const [id, r] of rooms) if (Date.now() - r.created > LIMITS.roomHours * 3600_000 && !r.waiters.size) rooms.delete(id);
    };
    return {
        room,
        post(id, from, type, data) {
            sweep();
            const r = room(id);
            if (r.messages.length >= LIMITS.messages) r.messages.splice(0, r.messages.length - LIMITS.messages + 1);
            const message = {n: r.next++, from, type, data};
            r.messages.push(message);
            for (const wake of r.waiters) wake();
            return message;
        },
        // Messages of the other side after `after`; waits up to `wait` seconds for the first one.
        async read(id, role, after, wait) {
            const r = room(id);
            const pending = () => r.messages.filter(m => m.n > after && m.from !== role);
            let found = pending();
            if (found.length || !wait) return found;
            await new Promise(resolve => {
                const done = () => { clearTimeout(timer); r.waiters.delete(done); resolve(); };
                const timer = setTimeout(done, wait * 1000);
                r.waiters.add(done);
            });
            return pending();
        },
        // Whether the other side said hello and did not leave since.
        present(id, role) {
            const theirs = room(id).messages.filter(m => m.from !== role && (m.type === 'hello' || m.type === 'bye'));
            return theirs.at(-1)?.type === 'hello';
        },
        size: () => rooms.size
    };
}

export default async function videoRoutes(app) {
    const rooms = createRooms();
    app.decorate('videoRooms', rooms);
    const doctorOnly = requireRole('doctor');
    // Off: after the sign-in check, the calls do not exist.
    const videoOn = async () => { if (!app.config.video?.enabled) throw new HttpError(404, 'not_found', 'Not found.'); };
    const either = [requireRole('patient', 'doctor'), videoOn];

    // The appointment, if this person may join its call; with their role in it.
    async function callFor(request) {
        const {rows: [a]} = await app.pg.query(
            `SELECT a.*, d.name AS doctor_name, p.name AS patient_name FROM appointments a JOIN users d ON d.id = a.doctor_id JOIN users p ON p.id = a.patient_id
             WHERE a.id = $1 AND (a.patient_id = $2 OR a.doctor_id = $2) AND a.mode = 'video'`, [request.params.id, request.user.id]);
        if (!a) throw new HttpError(404, 'not_found', 'Video appointment not found.');
        const role = a.doctor_id === request.user.id ? 'doctor' : 'patient';
        if (role === 'doctor' && !request.user.second_factor_at) {
            throw new HttpError(403, 'second_factor_required', 'Please confirm it is you with a code sent to your email.');
        }
        const now = Date.now();
        const open = a.status === 'confirmed' && now >= a.starts_at.getTime() - LIMITS.earlyMinutes * 60_000 && now <= a.ends_at.getTime() + LIMITS.lateMinutes * 60_000;
        return {a, role, open};
    }

    app.get('/api/video/:id', {preHandler: either, schema: idParam}, async request => {
        const {a, role, open} = await callFor(request);
        return {role, open, status: a.status, starts_at: a.starts_at, ends_at: a.ends_at,
            peer_name: role === 'doctor' ? a.patient_name : a.doctor_name, ice_servers: open ? iceServers(app.config, request.user.id) : [],
            opens_at: new Date(a.starts_at.getTime() - LIMITS.earlyMinutes * 60_000)};
    });

    app.post('/api/video/:id/signal', {preHandler: either, config: {rateLimit: {max: 600, timeWindow: '15 minutes'}}, schema: {...idParam, body: {
        type: 'object', required: ['type'], additionalProperties: false, properties: {
            type: {enum: TYPES}, data: {type: ['object', 'string', 'null']}
        }}}}, async request => {
        const {a, role, open} = await callFor(request);
        if (!open) throw new HttpError(409, 'video_not_open', 'The call opens 15 minutes before the appointment.');
        if (Buffer.byteLength(JSON.stringify(request.body.data ?? null)) > LIMITS.messageBytes) throw new HttpError(400, 'too_long', 'Message too long.');
        const peerPresent = rooms.present(a.id, role);
        const message = rooms.post(a.id, role, request.body.type, request.body.data ?? null);
        if (request.body.type === 'hello' && !rooms.room(a.id).joined.has(role)) {
            rooms.room(a.id).joined.add(role);
            await audit(app.pg, {actorId: request.user.id, action: 'video.joined', targetId: a.id, details: {role}, ip: request.ip});
        }
        return {n: message.n, peer_present: peerPresent};
    });

    app.get('/api/video/:id/signal', {preHandler: either, schema: {...idParam, querystring: {type: 'object', additionalProperties: false, properties: {
        after: {type: 'integer', minimum: 0}, wait: {type: 'integer', minimum: 0, maximum: LIMITS.waitSeconds}
    }}}}, async request => {
        const {a, role, open} = await callFor(request);
        if (!open) throw new HttpError(409, 'video_not_open', 'The call opens 15 minutes before the appointment.');
        const wait = request.query.wait ?? LIMITS.waitSeconds;
        const messages = await rooms.read(a.id, role, request.query.after || 0, wait);
        return {messages};
    });

    // Doctors switch video consultations on for themselves (only where the operator offers them).
    app.get('/api/doctor/video', {preHandler: doctorOnly}, async request => {
        const {rows: [p]} = await app.pg.query('SELECT video_enabled FROM doctor_profiles WHERE user_id = $1', [request.user.id]);
        return {available: Boolean(app.config.video?.enabled), enabled: Boolean(p?.video_enabled)};
    });
    app.post('/api/doctor/video', {preHandler: doctorOnly, schema: {body: {type: 'object', required: ['enabled'], additionalProperties: false,
        properties: {enabled: {type: 'boolean'}}}}}, async request => {
        if (!app.config.video?.enabled) throw new HttpError(404, 'not_found', 'Not found.');
        await app.pg.query('UPDATE doctor_profiles SET video_enabled = $2 WHERE user_id = $1', [request.user.id, request.body.enabled]);
        await audit(app.pg, {actorId: request.user.id, action: request.body.enabled ? 'video.enabled' : 'video.disabled', targetId: request.user.id, ip: request.ip});
        return {enabled: request.body.enabled};
    });
}
