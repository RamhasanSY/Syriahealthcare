// Pharmacies on duty: pharmacies enter their night and holiday duties (once or every week for a few weeks); everyone sees
// which pharmacy in their governorate is open now or on a chosen day. Pharmacies that list "Open 24 hours" always count.
import {HttpError, requireRole} from './auth.js';
import {governorates} from './catalog.js';
import {audit} from './db.js';
import {addDays, localDate, localToUtc} from './slots.js';

const TZ = 'Asia/Damascus';
export const LIMITS = {futureDuties: 120, daysAhead: 60, repeatWeeks: 12, maxHours: 36};
const DATE = '^\\d{4}-\\d{2}-\\d{2}$', TIME = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const idParam = {params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}}};
const today = () => localDate(Date.now(), TZ);

const PUBLIC_PHARMACY = `u.id AS facility_id, p.facility_name, p.governorate, p.area, p.address, p.phone`;
const APPROVED_PHARMACY = `p.kind = 'pharmacy' AND p.status = 'approved' AND u.disabled_at IS NULL`;
const dutyView = d => ({id: d.id, starts_at: d.starts_at, ends_at: d.ends_at, note: d.note});

export default async function pharmacyDutyRoutes(app) {
    const facilityOnly = requireRole('facility');

    async function ownPharmacy(userId) {
        const {rows: [p]} = await app.pg.query('SELECT user_id, kind, status FROM facility_profiles WHERE user_id = $1', [userId]);
        if (!p || p.kind !== 'pharmacy') throw new HttpError(403, 'not_a_pharmacy', 'Only pharmacies enter duty times.');
        return p;
    }

    // ---- Public: who is on duty ----

    app.get('/api/pharmacies/on-duty', {config: {cache: 'public, max-age=60'}, schema: {querystring: {type: 'object', additionalProperties: false, properties: {
        governorate: {type: 'string', maxLength: 40}, date: {type: 'string', pattern: DATE}
    }}}}, async request => {
        const args = [], where = [APPROVED_PHARMACY];
        if (request.query.governorate && Object.hasOwn(governorates, request.query.governorate)) where.push(`p.governorate = $${args.push(request.query.governorate)}`);
        // "Now", or a whole local day (00:00 to 24:00 Syria time).
        const day = request.query.date;
        if (day && (day < today() || day > addDays(today(), LIMITS.daysAhead))) throw new HttpError(400, 'invalid_date', `Choose a day from today to ${LIMITS.daysAhead} days ahead.`);
        const from = day ? new Date(localToUtc(day, '00:00', TZ)) : new Date();
        const to = day ? new Date(localToUtc(addDays(day, 1), '00:00', TZ)) : new Date(from.getTime() + 1000);
        const base = `FROM users u JOIN facility_profiles p ON p.user_id = u.id WHERE ${where.join(' AND ')}`;
        const {rows: onDuty} = await app.pg.query(
            `SELECT ${PUBLIC_PHARMACY}, d.id, d.starts_at, d.ends_at, d.note ${base.replace('WHERE', 'JOIN pharmacy_duties d ON d.facility_id = u.id WHERE')}
               AND d.starts_at < $${args.length + 2} AND d.ends_at > $${args.length + 1}
             ORDER BY d.starts_at, p.facility_name LIMIT 300`, [...args, from, to]);
        const {rows: allDay} = await app.pg.query(`SELECT ${PUBLIC_PHARMACY} ${base} AND 'open_24h' = ANY(p.services) ORDER BY p.facility_name LIMIT 300`, args);
        // Without a day: also the duties of the next 24 hours, so "tonight" is visible in the afternoon.
        let later = [];
        if (!day) {
            ({rows: later} = await app.pg.query(
                `SELECT ${PUBLIC_PHARMACY}, d.id, d.starts_at, d.ends_at, d.note ${base.replace('WHERE', 'JOIN pharmacy_duties d ON d.facility_id = u.id WHERE')}
                   AND d.starts_at >= $${args.length + 1} AND d.starts_at < $${args.length + 1}::timestamptz + interval '24 hours'
                 ORDER BY d.starts_at, p.facility_name LIMIT 300`, [...args, from]));
        }
        const view = r => ({facility_id: r.facility_id, name: r.facility_name, governorate: r.governorate, area: r.area, address: r.address, phone: r.phone,
            ...(r.starts_at && {starts_at: r.starts_at, ends_at: r.ends_at, note: r.note})});
        return {date: day || null, on_duty: onDuty.map(view), open_24h: allDay.map(view), later: later.map(view)};
    });

    // ---- Pharmacies: own duty times ----

    app.get('/api/pharmacy/duties', {preHandler: facilityOnly}, async request => {
        const p = await ownPharmacy(request.user.id);
        const {rows} = await app.pg.query('SELECT * FROM pharmacy_duties WHERE facility_id = $1 AND ends_at > now() ORDER BY starts_at LIMIT 200', [p.user_id]);
        return {duties: rows.map(dutyView), approved: p.status === 'approved', limits: LIMITS};
    });

    app.post('/api/pharmacy/duties', {preHandler: facilityOnly, config: {rateLimit: {max: 60, timeWindow: '15 minutes'}}, schema: {body: {type: 'object',
        required: ['date', 'from', 'to'], additionalProperties: false, properties: {
            date: {type: 'string', pattern: DATE}, from: {type: 'string', pattern: TIME}, to: {type: 'string', pattern: TIME},
            repeat_weeks: {type: 'integer', minimum: 0, maximum: LIMITS.repeatWeeks}, note: {type: 'string', maxLength: 120}
        }}}}, async (request, reply) => {
        const p = await ownPharmacy(request.user.id);
        const {date, from, to} = request.body, weeks = request.body.repeat_weeks || 0;
        if (date < today() || date > addDays(today(), LIMITS.daysAhead)) throw new HttpError(400, 'invalid_date', `Choose a day from today to ${LIMITS.daysAhead} days ahead.`);
        if (from === to) throw new HttpError(400, 'invalid_duty_time', 'The duty must end at another time than it starts.');
        // "20:00 to 08:00" ends the next morning.
        const dates = Array.from({length: weeks + 1}, (_, i) => addDays(date, 7 * i));
        const shifts = dates.map(d => ({starts_at: new Date(localToUtc(d, from, TZ)), ends_at: new Date(localToUtc(to > from ? d : addDays(d, 1), to, TZ))}));
        if (shifts[0].ends_at <= new Date()) throw new HttpError(400, 'invalid_date', 'This duty is already over.');
        const {rows: [{n}]} = await app.pg.query('SELECT count(*)::int AS n FROM pharmacy_duties WHERE facility_id = $1 AND ends_at > now()', [p.user_id]);
        if (n + shifts.length > LIMITS.futureDuties) throw new HttpError(409, 'too_many_duties', `At most ${LIMITS.futureDuties} upcoming duties.`);
        const client = await app.pg.connect();
        try {
            await client.query('BEGIN');
            const rows = [];
            for (const s of shifts) {
                const {rows: [r]} = await client.query(
                    'INSERT INTO pharmacy_duties (facility_id, starts_at, ends_at, note) VALUES ($1, $2, $3, $4) RETURNING *',
                    [p.user_id, s.starts_at, s.ends_at, request.body.note?.trim() || null]);
                rows.push(r);
            }
            await client.query('COMMIT');
            await audit(app.pg, {actorId: request.user.id, action: 'pharmacy_duty.added', targetId: p.user_id, details: {duties: rows.length}, ip: request.ip});
            reply.code(201);
            return {duties: rows.map(dutyView)};
        } catch (error) {
            await client.query('ROLLBACK');
            if (error.code === '23P01') throw new HttpError(409, 'duty_overlap', 'This overlaps a duty you already entered.');
            throw error;
        } finally {
            client.release();
        }
    });

    app.post('/api/pharmacy/duties/:id/delete', {preHandler: facilityOnly, schema: idParam}, async request => {
        const p = await ownPharmacy(request.user.id);
        const {rowCount} = await app.pg.query('DELETE FROM pharmacy_duties WHERE id = $1 AND facility_id = $2', [request.params.id, p.user_id]);
        if (!rowCount) throw new HttpError(404, 'not_found', 'Duty not found.');
        return {deleted: true};
    });
}
