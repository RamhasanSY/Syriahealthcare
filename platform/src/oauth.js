// OAuth 2.0 client credentials for lab and clinic software (stage 2d, RFC 6749 section 4.4).
// Scopes use the SMART on FHIR v2 notation: system/DiagnosticReport.c (send results), system/DocumentReference.c
// (send documents). A client always belongs to one approved facility; the sender of every message is that facility,
// never anything written inside the message. Writing over /fhir and /hl7v2 works only with a token, never with a cookie.
import {randomBytes} from 'node:crypto';
import {HttpError, requireRole} from './auth.js';
import {audit} from './db.js';
import {dummyPasswordHash, hashPassword, sha256, verifyPassword} from './security.js';

export const SCOPES = {
    'system/DiagnosticReport.c': ['Send lab and imaging results', 'إرسال نتائج التحاليل والأشعة'],
    'system/DocumentReference.c': ['Send documents such as discharge letters', 'إرسال مستندات مثل تقارير الخروج']
};
export const TOKEN_MINUTES = 15;

const newClientId = () => 'shc_' + Array.from(randomBytes(20), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const newSecret = () => randomBytes(32).toString('base64url');

// The facility must still be approved and active, every time.
const ACTIVE_CLIENT = `c.revoked_at IS NULL AND u.disabled_at IS NULL AND p.status = 'approved'`;

// Reads a Bearer token and returns {client, facility, scopes}, or throws 401/403 with an OAuth-style error.
export async function tokenClient(db, request, scope) {
    const header = String(request.headers.authorization || '');
    const match = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(header);
    if (!match) throw Object.assign(new HttpError(401, 'invalid_token', 'A Bearer access token is required.'), {oauth: true});
    const {rows: [row]} = await db.query(
        `SELECT t.scopes, c.id AS client_id, c.name AS client_name, c.facility_id, p.facility_name, p.kind
         FROM api_tokens t JOIN api_clients c ON c.id = t.client_id JOIN users u ON u.id = c.facility_id JOIN facility_profiles p ON p.user_id = c.facility_id
         WHERE t.token_hash = $1 AND t.expires_at > now() AND ${ACTIVE_CLIENT}`, [sha256(match[1])]);
    if (!row) throw Object.assign(new HttpError(401, 'invalid_token', 'The access token is not valid or has expired.'), {oauth: true});
    if (scope && !row.scopes.includes(scope)) throw Object.assign(new HttpError(403, 'insufficient_scope', `This needs the scope ${scope}.`), {oauth: true, scope});
    await db.query('UPDATE api_clients SET last_used_at = now() WHERE id = $1', [row.client_id]);
    return row;
}

function basicAuth(header) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(String(header || ''));
    if (!m) return null;
    const text = Buffer.from(m[1], 'base64').toString('utf8'), i = text.indexOf(':');
    return i < 0 ? null : {id: decodeURIComponent(text.slice(0, i)), secret: decodeURIComponent(text.slice(i + 1))};
}

const oauthError = (reply, status, error, description) => reply.code(status).header('Cache-Control', 'no-store').send({error, error_description: description});

export default async function oauthRoutes(app) {
    // RFC 6749 sends application/x-www-form-urlencoded.
    app.addContentTypeParser('application/x-www-form-urlencoded', {parseAs: 'string', bodyLimit: 4096}, (request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body)));
    });

    app.post('/oauth/token', {config: {rateLimit: {max: 60, timeWindow: '15 minutes'}}}, async (request, reply) => {
        const body = request.body && typeof request.body === 'object' ? request.body : {};
        if (body.grant_type !== 'client_credentials') return oauthError(reply, 400, 'unsupported_grant_type', 'Only client_credentials is supported.');
        const credentials = basicAuth(request.headers.authorization) || {id: body.client_id, secret: body.client_secret};
        if (!credentials.id || !credentials.secret) return oauthError(reply, 401, 'invalid_client', 'Client authentication failed.');
        const {rows: [client]} = await app.pg.query(
            `SELECT c.* FROM api_clients c JOIN users u ON u.id = c.facility_id JOIN facility_profiles p ON p.user_id = c.facility_id
             WHERE c.client_id = $1 AND ${ACTIVE_CLIENT}`, [String(credentials.id).slice(0, 40)]);
        const valid = await verifyPassword(String(credentials.secret).slice(0, 200), client?.secret_hash || dummyPasswordHash);
        if (!client || !valid) return oauthError(reply, 401, 'invalid_client', 'Client authentication failed.');
        const asked = body.scope ? String(body.scope).split(/\s+/).filter(Boolean) : client.scopes;
        if (asked.some(s => !client.scopes.includes(s))) return oauthError(reply, 400, 'invalid_scope', 'A requested scope is not allowed for this client.');
        const token = randomBytes(32).toString('base64url');
        await app.pg.query(`INSERT INTO api_tokens (token_hash, client_id, scopes, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
            [sha256(token), client.id, asked, TOKEN_MINUTES]);
        reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
        return {access_token: token, token_type: 'Bearer', expires_in: TOKEN_MINUTES * 60, scope: asked.join(' ')};
    });

    // ---- Administrators manage the clients of a facility ----
    const adminOnly = {preHandler: requireRole('admin')};
    const view = c => ({id: c.id, name: c.name, client_id: c.client_id, scopes: c.scopes, facility_id: c.facility_id, facility_name: c.facility_name,
        created_at: c.created_at, last_used_at: c.last_used_at, revoked_at: c.revoked_at});

    app.get('/api/admin/api-clients', adminOnly, async () => {
        const {rows} = await app.pg.query(
            `SELECT c.*, p.facility_name FROM api_clients c JOIN facility_profiles p ON p.user_id = c.facility_id ORDER BY c.created_at DESC`);
        return {clients: rows.map(view), scopes: SCOPES};
    });

    // The secret is in this answer only; afterwards nobody can read it, not even administrators.
    app.post('/api/admin/api-clients', {...adminOnly, schema: {body: {type: 'object', required: ['facility_id', 'name', 'scopes'], additionalProperties: false,
        properties: {facility_id: {type: 'string', format: 'uuid'}, name: {type: 'string', maxLength: 120},
            scopes: {type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: {enum: Object.keys(SCOPES)}}}}}}, async (request, reply) => {
        const name = request.body.name.trim();
        if (name.length < 2) throw new HttpError(400, 'invalid_name', 'Give the connection a name, for example the software\'s name.');
        const {rows: [facility]} = await app.pg.query(
            `SELECT p.user_id, p.facility_name, p.kind FROM facility_profiles p JOIN users u ON u.id = p.user_id
             WHERE p.user_id = $1 AND p.status = 'approved' AND u.disabled_at IS NULL`, [request.body.facility_id]);
        if (!facility) throw new HttpError(404, 'not_found', 'Approved facility not found.');
        if (request.body.scopes.includes('system/DiagnosticReport.c') && !['lab', 'imaging'].includes(facility.kind)) {
            throw new HttpError(400, 'invalid_scope', 'Only laboratories and imaging centres can send results.');
        }
        const secret = newSecret();
        const {rows: [client]} = await app.pg.query(
            `INSERT INTO api_clients (facility_id, name, client_id, secret_hash, scopes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [facility.user_id, name, newClientId(), await hashPassword(secret), request.body.scopes, request.user.id]);
        await audit(app.pg, {actorId: request.user.id, action: 'api_client.created', targetId: client.id, details: {facility_id: facility.user_id, scopes: client.scopes}, ip: request.ip});
        reply.code(201);
        return {client: view({...client, facility_name: facility.facility_name}), client_secret: secret, token_url: `${app.config.appOrigin}/oauth/token`};
    });

    app.post('/api/admin/api-clients/:id/revoke', {...adminOnly, schema: {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}}}, async request => {
        const {rows: [client]} = await app.pg.query('UPDATE api_clients SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING *', [request.params.id]);
        if (!client) throw new HttpError(404, 'not_found', 'Connection not found.');
        await app.pg.query('DELETE FROM api_tokens WHERE client_id = $1', [client.id]);
        await audit(app.pg, {actorId: request.user.id, action: 'api_client.revoked', targetId: client.id, ip: request.ip});
        return {revoked: true};
    });

    // A facility sees its own connections (never secrets) on the "Connect your software" page.
    app.get('/api/facility/api-clients', {preHandler: requireRole('facility')}, async request => {
        const {rows} = await app.pg.query('SELECT c.*, NULL AS facility_name FROM api_clients c WHERE c.facility_id = $1 ORDER BY c.created_at DESC', [request.user.id]);
        return {clients: rows.map(view), scopes: SCOPES, token_url: `${app.config.appOrigin}/oauth/token`,
            fhir_base: `${app.config.appOrigin}/fhir/r4`, hl7v2_url: `${app.config.appOrigin}/hl7v2`};
    });
}

