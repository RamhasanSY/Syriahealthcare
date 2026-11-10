// Blood donation calls. Blood banks and hospitals post what they need (blood groups, how many units, by when); the list
// is public on app.syriahc.com/blood. Patients can register as donors (blood group, governorate, phone); when a call
// matches their group and governorate they get a notification and an email, at most once a day and never within
// 8 weeks after their last donation. A donor who answers "I can donate" shares name and phone with that facility only.
//
// The blood group is health data: the donor register is switched off together with the health file (HEALTH_FILE=off),
// until the new privacy policy is published. The calls themselves hold no personal data and are always shown.
import {HttpError, requireRole} from './auth.js';
import {governorates} from './catalog.js';
import {audit} from './db.js';
import {enqueueEmail} from './outbox.js';
import {pushToUser} from './push.js';
import {normalizePhone} from './security.js';

export const BLOOD_TYPES = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];
// Who can give red cells to whom (donor -> recipients).
export const CAN_GIVE = {
    'O-': BLOOD_TYPES, 'O+': ['O+', 'A+', 'B+', 'AB+'], 'A-': ['A-', 'A+', 'AB-', 'AB+'], 'A+': ['A+', 'AB+'],
    'B-': ['B-', 'B+', 'AB-', 'AB+'], 'B+': ['B+', 'AB+'], 'AB-': ['AB-', 'AB+'], 'AB+': ['AB+']
};
export const LIMITS = {openRequests: 10, daysAhead: 30, restDays: 56, quietHours: 24, responsesPerDay: 5};
const POSTERS = ['blood_bank', 'hospital'];
const TZ = 'Asia/Damascus';
const UUID = {type: 'string', format: 'uuid'};
const idParam = {params: {type: 'object', properties: {id: UUID}}};
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const today = () => new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date());
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const isoDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null;

const requestView = r => ({id: r.id, facility_id: r.facility_id, facility_name: r.facility_name, kind: r.kind, governorate: r.governorate,
    area: r.area, address: r.address, phone: r.contact_phone, blood_types: r.blood_types, units: r.units, urgency: r.urgency,
    needed_by: isoDate(r.needed_by), note: r.note, status: r.status, created_at: r.created_at});
const donorView = d => d && ({blood_type: d.blood_type, governorate: d.governorate, phone: d.phone, notify: d.notify,
    last_donation_date: isoDate(d.last_donation_date), next_possible: d.last_donation_date ? addDays(isoDate(d.last_donation_date), LIMITS.restDays) : null});

const REQUEST_SQL = `SELECT r.*, p.facility_name, p.kind, p.area, p.address FROM blood_requests r JOIN facility_profiles p ON p.user_id = r.facility_id`;

// Tells matching donors about a new call. Returns how many were told. Never throws.
export async function notifyDonors(app, request) {
    if (!app.config.healthFile) return 0;
    try {
        const donorTypes = BLOOD_TYPES.filter(type => CAN_GIVE[type].some(t => request.blood_types.includes(t)));
        const {rows} = await app.pg.query(
            `UPDATE blood_donors d SET last_notified_at = now() FROM users u
             WHERE u.id = d.user_id AND u.disabled_at IS NULL AND d.notify AND d.governorate = $1 AND d.blood_type = ANY($2)
               AND (d.last_donation_date IS NULL OR d.last_donation_date <= $3::date - $4::int)
               AND (d.last_notified_at IS NULL OR d.last_notified_at < now() - make_interval(hours => $5))
               AND d.user_id <> $6
             RETURNING d.user_id, u.email, u.language`,
            [request.governorate, donorTypes, today(), LIMITS.restDays, LIMITS.quietHours, request.facility_id]);
        const place = governorates[request.governorate] || [request.governorate, request.governorate];
        const types = request.blood_types.join(', ');
        for (const donor of rows) {
            await pushToUser(app, donor.user_id, {title: ['Blood is needed near you', 'مطلوب متبرعون بالدم قربك'],
                body: ['Your blood group can help. Open SyriaHC to see where.', 'زمرتك الدموية قد تساعد. افتح صحة تك لمعرفة المكان.'],
                url: '/blood', tag: 'blood', urgency: request.urgency === 'urgent' ? 'high' : 'normal'});
            if (donor.email) {
                const en = `${request.facility_name} in ${place[0]} needs blood (${types})${request.urgency === 'urgent' ? ', urgently' : ''}, by ${isoDate(request.needed_by)}.\n` +
                    `Phone: ${request.contact_phone}\nTell them you can come: ${app.config.appOrigin}/blood\n\n` +
                    `You get this because you registered as a blood donor. Change or stop it on ${app.config.appOrigin}/blood`;
                const ar = `يحتاج ${request.facility_name} في ${place[1]} إلى دم (${types})${request.urgency === 'urgent' ? ' بشكل عاجل' : ''} قبل ${isoDate(request.needed_by)}.\n` +
                    `الهاتف: ${request.contact_phone}\nأخبرهم أنك تستطيع الحضور: ${app.config.appOrigin}/blood\n\n` +
                    `تصلك هذه الرسالة لأنك سجّلت متبرعاً بالدم. يمكنك تعديل ذلك أو إيقافه من ${app.config.appOrigin}/blood`;
                await enqueueEmail(app.pg, {to: donor.email, subject: donor.language === 'en' ? 'Blood donation call — SyriaHC' : 'نداء تبرع بالدم — صحة تك',
                    text: donor.language === 'en' ? `${en}\n\n— — —\n\n${ar}` : `${ar}\n\n— — —\n\n${en}`});
            }
        }
        return rows.length;
    } catch (error) {
        app.log.error({err: error}, 'Notifying donors failed');
        return 0;
    }
}

export default async function bloodRoutes(app) {
    const facilityOnly = requireRole('facility');
    const patientOnly = requireRole('patient');
    // The donor register follows the health file switch: off means the routes do not exist.
    const donorsOn = async () => { if (!app.config.healthFile) throw new HttpError(404, 'not_found', 'Not found.'); };

    async function poster(userId) {
        const {rows: [f]} = await app.pg.query('SELECT user_id, kind, status, facility_name, governorate, phone FROM facility_profiles WHERE user_id = $1', [userId]);
        if (!f || !POSTERS.includes(f.kind)) throw new HttpError(403, 'not_a_blood_bank', 'Only blood banks and hospitals post blood donation calls.');
        if (f.status !== 'approved') throw new HttpError(403, 'facility_not_approved', 'Your facility must be approved first.');
        return f;
    }

    // ---- Public list ----

    app.get('/api/blood-requests', {config: {cache: 'public, max-age=60'}, schema: {querystring: {type: 'object', additionalProperties: false, properties: {
        governorate: {type: 'string', maxLength: 40}, blood_type: {enum: BLOOD_TYPES}
    }}}}, async request => {
        const where = ["r.status = 'open'", 'r.needed_by >= $1', "p.status = 'approved'"], args = [today()];
        if (request.query.governorate && Object.hasOwn(governorates, request.query.governorate)) where.push(`r.governorate = $${args.push(request.query.governorate)}`);
        // "I am A+": the calls an A+ donor can help with.
        if (request.query.blood_type) where.push(`r.blood_types && $${args.push(CAN_GIVE[request.query.blood_type])}`);
        const {rows} = await app.pg.query(`${REQUEST_SQL} WHERE ${where.join(' AND ')}
            ORDER BY r.urgency = 'urgent' DESC, r.needed_by, r.created_at DESC LIMIT 200`, args);
        return {requests: rows.map(requestView), blood_types: BLOOD_TYPES, donors: app.config.healthFile};
    });

    // ---- Blood banks and hospitals ----

    const requestBody = {type: 'object', required: ['blood_types', 'needed_by'], additionalProperties: false, properties: {
        blood_types: {type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: {enum: BLOOD_TYPES}},
        units: {type: ['integer', 'null'], minimum: 1, maximum: 100}, urgency: {enum: ['urgent', 'normal']},
        needed_by: {type: 'string', pattern: DATE}, note: {type: 'string', maxLength: 300}, contact_phone: {type: 'string', maxLength: 30}
    }};

    app.get('/api/facility/blood-requests', {preHandler: facilityOnly}, async request => {
        const f = await poster(request.user.id);
        const {rows} = await app.pg.query(
            `${REQUEST_SQL.replace('SELECT r.*', 'SELECT r.*, (SELECT count(*)::int FROM blood_responses x WHERE x.request_id = r.id) AS responses')}
             WHERE r.facility_id = $1 ORDER BY r.status = 'open' DESC, r.created_at DESC LIMIT 100`, [f.user_id]);
        return {requests: rows.map(r => ({...requestView(r), responses: r.responses, notified: r.notified_count, closed_at: r.closed_at})),
            blood_types: BLOOD_TYPES, limits: LIMITS, default_phone: f.phone};
    });

    app.post('/api/facility/blood-requests', {preHandler: facilityOnly, config: {rateLimit: {max: 20, timeWindow: '1 hour'}}, schema: {body: requestBody}},
        async (request, reply) => {
            const f = await poster(request.user.id);
            const day = request.body.needed_by;
            if (day < today() || day > addDays(today(), LIMITS.daysAhead)) throw new HttpError(400, 'invalid_date', `Choose a day from today to ${LIMITS.daysAhead} days ahead.`);
            const phone = request.body.contact_phone ? normalizePhone(request.body.contact_phone, {landline: true}) : f.phone;
            if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a phone number donors can call.');
            if (!f.governorate) throw new HttpError(400, 'invalid_governorate', 'Add your governorate to the facility profile first.');
            const {rows: [{n}]} = await app.pg.query(
                "SELECT count(*)::int AS n FROM blood_requests WHERE facility_id = $1 AND status = 'open' AND needed_by >= $2", [f.user_id, today()]);
            if (n >= LIMITS.openRequests) throw new HttpError(409, 'too_many_requests', `At most ${LIMITS.openRequests} open calls. Close one first.`);
            const {rows: [row]} = await app.pg.query(
                `INSERT INTO blood_requests (facility_id, blood_types, units, urgency, needed_by, governorate, contact_phone, note)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [f.user_id, BLOOD_TYPES.filter(t => request.body.blood_types.includes(t)), request.body.units ?? null, request.body.urgency || 'normal',
                    day, f.governorate, phone, request.body.note?.trim() || null]);
            await audit(app.pg, {actorId: request.user.id, action: 'blood_request.created', targetId: row.id, details: {blood_types: row.blood_types}, ip: request.ip});
            const notified = await notifyDonors(app, {...row, facility_name: f.facility_name});
            await app.pg.query('UPDATE blood_requests SET notified_count = $2 WHERE id = $1', [row.id, notified]);
            reply.code(201);
            return {request: {...requestView({...row, facility_name: f.facility_name, kind: f.kind}), notified}};
        });

    app.post('/api/facility/blood-requests/:id/close', {preHandler: facilityOnly, schema: idParam}, async request => {
        const f = await poster(request.user.id);
        const {rows: [row]} = await app.pg.query(
            `UPDATE blood_requests SET status = 'closed', closed_at = now() WHERE id = $1 AND facility_id = $2 AND status = 'open' RETURNING id, status`,
            [request.params.id, f.user_id]);
        if (!row) throw new HttpError(404, 'not_found', 'Call not found.');
        await audit(app.pg, {actorId: request.user.id, action: 'blood_request.closed', targetId: row.id, ip: request.ip});
        return {request: row};
    });

    // The donors who said they can come: name, phone and blood group, for this facility only (recorded).
    app.get('/api/facility/blood-requests/:id/responses', {preHandler: facilityOnly, schema: idParam}, async request => {
        const f = await poster(request.user.id);
        const {rows: [own]} = await app.pg.query('SELECT id FROM blood_requests WHERE id = $1 AND facility_id = $2', [request.params.id, f.user_id]);
        if (!own) throw new HttpError(404, 'not_found', 'Call not found.');
        const {rows} = await app.pg.query(
            `SELECT x.created_at, u.name, x.phone, x.blood_type FROM blood_responses x JOIN users u ON u.id = x.donor_id
             WHERE x.request_id = $1 ORDER BY x.created_at`, [own.id]);
        await audit(app.pg, {actorId: request.user.id, action: 'blood_responses.listed', targetId: own.id, details: {donors: rows.length}, ip: request.ip});
        return {responses: rows};
    });

    // ---- Donors (patients; only while HEALTH_FILE=on) ----

    app.get('/api/donor', {preHandler: [donorsOn, patientOnly]}, async request => {
        const {rows: [d]} = await app.pg.query('SELECT * FROM blood_donors WHERE user_id = $1', [request.user.id]);
        return {donor: donorView(d) || null, blood_types: BLOOD_TYPES, rest_days: LIMITS.restDays};
    });

    app.post('/api/donor', {preHandler: [donorsOn, patientOnly], schema: {body: {type: 'object', required: ['blood_type', 'governorate', 'phone'],
        additionalProperties: false, properties: {
            blood_type: {enum: BLOOD_TYPES}, governorate: {type: 'string', maxLength: 40}, phone: {type: 'string', maxLength: 30},
            notify: {type: 'boolean'}, last_donation_date: {type: ['string', 'null'], pattern: DATE}, consent: {type: 'boolean'}
        }}}}, async request => {
        if (!Object.hasOwn(governorates, request.body.governorate)) throw new HttpError(400, 'invalid_governorate', 'Choose a governorate from the list.');
        const phone = normalizePhone(request.body.phone);
        if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a valid mobile number, for example 0912 345 678.');
        const last = request.body.last_donation_date || null;
        if (last && last > today()) throw new HttpError(400, 'invalid_date', 'The last donation cannot be in the future.');
        const {rows: [existing]} = await app.pg.query('SELECT 1 FROM blood_donors WHERE user_id = $1', [request.user.id]);
        if (!existing && request.body.consent !== true) throw new HttpError(400, 'consent_required', 'Please agree to storing your blood group for donation calls.');
        const {rows: [d]} = await app.pg.query(
            `INSERT INTO blood_donors (user_id, blood_type, governorate, phone, notify, last_donation_date) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (user_id) DO UPDATE SET blood_type = EXCLUDED.blood_type, governorate = EXCLUDED.governorate, phone = EXCLUDED.phone,
                 notify = EXCLUDED.notify, last_donation_date = EXCLUDED.last_donation_date, updated_at = now()
             RETURNING *`,
            [request.user.id, request.body.blood_type, request.body.governorate, phone, request.body.notify !== false, last]);
        await audit(app.pg, {actorId: request.user.id, action: existing ? 'blood_donor.updated' : 'blood_donor.registered', targetId: request.user.id, ip: request.ip});
        return {donor: donorView(d)};
    });

    // Leaving the register removes the blood group, phone and own answers.
    app.post('/api/donor/delete', {preHandler: [donorsOn, patientOnly]}, async request => {
        await app.pg.query('DELETE FROM blood_responses WHERE donor_id = $1', [request.user.id]);
        const {rowCount} = await app.pg.query('DELETE FROM blood_donors WHERE user_id = $1', [request.user.id]);
        await audit(app.pg, {actorId: request.user.id, action: 'blood_donor.deleted', targetId: request.user.id, ip: request.ip});
        return {deleted: rowCount > 0};
    });

    app.post('/api/blood-requests/:id/respond', {preHandler: [donorsOn, patientOnly], config: {rateLimit: {max: 20, timeWindow: '1 hour'}}, schema: idParam},
        async request => {
            const {rows: [d]} = await app.pg.query('SELECT * FROM blood_donors WHERE user_id = $1', [request.user.id]);
            if (!d) throw new HttpError(409, 'donor_required', 'Register as a donor first.');
            const {rows: [r]} = await app.pg.query(
                "SELECT * FROM blood_requests WHERE id = $1 AND status = 'open' AND needed_by >= $2", [request.params.id, today()]);
            if (!r) throw new HttpError(404, 'not_found', 'This call is closed.');
            if (!CAN_GIVE[d.blood_type].some(t => r.blood_types.includes(t))) throw new HttpError(409, 'blood_type_mismatch', 'Your blood group does not match this call.');
            const {rows: [{n}]} = await app.pg.query(
                "SELECT count(*)::int AS n FROM blood_responses WHERE donor_id = $1 AND created_at > now() - interval '1 day'", [request.user.id]);
            if (n >= LIMITS.responsesPerDay) throw new HttpError(429, 'too_many_responses', 'You answered many calls today. Please try again tomorrow.');
            const {rows: [x]} = await app.pg.query(
                `INSERT INTO blood_responses (request_id, donor_id, blood_type, phone) VALUES ($1, $2, $3, $4)
                 ON CONFLICT (request_id, donor_id) DO NOTHING RETURNING id`, [r.id, request.user.id, d.blood_type, d.phone]);
            if (x) {
                await audit(app.pg, {actorId: request.user.id, action: 'blood_request.answered', targetId: r.id, ip: request.ip});
                await pushToUser(app, r.facility_id, {title: ['A donor answered your call', 'استجاب متبرع لندائكم'],
                    body: ['Open your blood donation calls to see who can come.', 'افتحوا نداءات التبرع لمعرفة من يستطيع الحضور.'], url: '/blood-requests', tag: `blood-${r.id}`});
            }
            return {responded: true, phone: r.contact_phone};
        });
}
