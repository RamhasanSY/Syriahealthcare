// Lab packages: a lab bundles tests from its own price list into a package with one price, for example a general check-up
// or the tests before marriage. Packages show on the lab's page and on /packages, where patients compare labs; the saving
// against the single prices is worked out from the price list, never typed in.
import {HttpError, requireRole} from './auth.js';
import {governorates, packageTopics} from './catalog.js';
import {audit} from './db.js';

const LAB_KINDS = ['lab', 'imaging'];
export const LIMITS = {packages: 30, minTests: 2, maxTests: 40};
const UUID = {type: 'string', format: 'uuid'};
const idParam = {params: {type: 'object', properties: {id: UUID}}};

// Packages with their tests and the saving. `onlyActive` for the public.
export async function packagesOf(db, labIds, {onlyActive = true} = {}) {
    const {rows} = await db.query(
        `SELECT k.*, coalesce(json_agg(json_build_object('id', t.id, 'name', t.name, 'price_syp', t.price_syp) ORDER BY lower(t.name))
                    FILTER (WHERE t.id IS NOT NULL), '[]') AS tests
         FROM lab_packages k LEFT JOIN lab_package_tests x ON x.package_id = k.id LEFT JOIN lab_tests t ON t.id = x.test_id
         WHERE k.facility_id = ANY($1) ${onlyActive ? 'AND k.active' : ''}
         GROUP BY k.id ORDER BY k.price_syp, lower(k.name)`, [labIds]);
    return rows.map(packageView);
}

export function packageView(k) {
    const priced = k.tests.length && k.tests.every(t => t.price_syp !== null);
    const single = priced ? k.tests.reduce((sum, t) => sum + t.price_syp, 0) : null;
    return {id: k.id, facility_id: k.facility_id, name: k.name, topic: k.topic, description: k.description, price_syp: k.price_syp, active: k.active,
        tests: k.tests, single_total_syp: single, saving_syp: single !== null && single > k.price_syp ? single - k.price_syp : 0, updated_at: k.updated_at};
}

export default async function labPackageRoutes(app) {
    const facilityOnly = requireRole('facility');

    async function ownLab(userId) {
        const {rows: [lab]} = await app.pg.query('SELECT user_id, kind, status FROM facility_profiles WHERE user_id = $1', [userId]);
        if (!lab || !LAB_KINDS.includes(lab.kind)) throw new HttpError(403, 'not_a_lab', 'Only laboratories and imaging centres have a price list and home visits.');
        return lab;
    }

    // Checks the fields and that every test is on this lab's own price list.
    async function cleanPackage(labId, body, current = {}) {
        const pick = key => body[key] === undefined ? current[key] ?? null : body[key];
        const name = String(pick('name') || '').trim();
        if (name.length < 2) throw new HttpError(400, 'invalid_package_name', 'Give the package a name.');
        const topic = pick('topic') || null;
        if (topic && !Object.hasOwn(packageTopics, topic)) throw new HttpError(400, 'invalid_topic', 'Choose a topic from the list.');
        const price = pick('price_syp');
        if (!Number.isInteger(price)) throw new HttpError(400, 'invalid_price', 'Enter the package price in Syrian pounds.');
        const ids = body.test_ids === undefined ? current.test_ids : [...new Set(body.test_ids)];
        if (!ids || ids.length < LIMITS.minTests) throw new HttpError(400, 'too_few_tests', `Choose at least ${LIMITS.minTests} tests from your price list.`);
        const {rows: [{n}]} = await app.pg.query('SELECT count(*)::int AS n FROM lab_tests WHERE facility_id = $1 AND id = ANY($2)', [labId, ids]);
        if (n !== ids.length) throw new HttpError(400, 'invalid_tests', 'Some tests are not on your price list any more. Please reload.');
        const description = pick('description');
        return {name, topic, price_syp: price, test_ids: ids, description: description ? String(description).trim() || null : null,
            active: body.active === undefined ? current.active ?? true : body.active};
    }

    async function save(labId, k, id = null) {
        const client = await app.pg.connect();
        try {
            await client.query('BEGIN');
            const {rows: [row]} = id
                ? await client.query(`UPDATE lab_packages SET name = $2, topic = $3, description = $4, price_syp = $5, active = $6, updated_at = now()
                                      WHERE id = $1 RETURNING id`, [id, k.name, k.topic, k.description, k.price_syp, k.active])
                : await client.query(`INSERT INTO lab_packages (facility_id, name, topic, description, price_syp, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                    [labId, k.name, k.topic, k.description, k.price_syp, k.active]);
            await client.query('DELETE FROM lab_package_tests WHERE package_id = $1', [row.id]);
            await client.query('INSERT INTO lab_package_tests (package_id, test_id) SELECT $1, unnest($2::uuid[])', [row.id, k.test_ids]);
            await client.query('COMMIT');
            return row.id;
        } catch (error) {
            await client.query('ROLLBACK');
            if (error.code === '23505') throw new HttpError(409, 'package_exists', 'A package with this name already exists.');
            throw error;
        } finally {
            client.release();
        }
    }

    const body = {type: 'object', additionalProperties: false, properties: {
        name: {type: 'string', maxLength: 120}, topic: {type: ['string', 'null'], maxLength: 40}, description: {type: ['string', 'null'], maxLength: 300},
        price_syp: {type: 'integer', minimum: 0, maximum: 100000000}, active: {type: 'boolean'},
        test_ids: {type: 'array', maxItems: LIMITS.maxTests, items: UUID}
    }};

    app.get('/api/facility/packages', {preHandler: facilityOnly}, async request => {
        const lab = await ownLab(request.user.id);
        const {rows: tests} = await app.pg.query('SELECT id, name, price_syp FROM lab_tests WHERE facility_id = $1 ORDER BY lower(name)', [lab.user_id]);
        return {packages: await packagesOf(app.pg, [lab.user_id], {onlyActive: false}), tests, topics: packageTopics, limits: LIMITS};
    });

    app.post('/api/facility/packages', {preHandler: facilityOnly, schema: {body: {...body, required: ['name', 'price_syp', 'test_ids']}}}, async (request, reply) => {
        const lab = await ownLab(request.user.id);
        const {rows: [{n}]} = await app.pg.query('SELECT count(*)::int AS n FROM lab_packages WHERE facility_id = $1', [lab.user_id]);
        if (n >= LIMITS.packages) throw new HttpError(409, 'too_many_packages', `At most ${LIMITS.packages} packages.`);
        const id = await save(lab.user_id, await cleanPackage(lab.user_id, request.body));
        await audit(app.pg, {actorId: request.user.id, action: 'lab_package.created', targetId: id, ip: request.ip});
        reply.code(201);
        return {package: (await packagesOf(app.pg, [lab.user_id], {onlyActive: false})).find(k => k.id === id)};
    });

    app.post('/api/facility/packages/:id', {preHandler: facilityOnly, schema: {...idParam, body}}, async request => {
        const lab = await ownLab(request.user.id);
        const {rows: [current]} = await app.pg.query(
            `SELECT k.*, array(SELECT test_id FROM lab_package_tests WHERE package_id = k.id) AS test_ids FROM lab_packages k WHERE k.id = $1 AND k.facility_id = $2`,
            [request.params.id, lab.user_id]);
        if (!current) throw new HttpError(404, 'not_found', 'Package not found.');
        await save(lab.user_id, await cleanPackage(lab.user_id, request.body || {}, current), current.id);
        return {package: (await packagesOf(app.pg, [lab.user_id], {onlyActive: false})).find(k => k.id === current.id)};
    });

    app.post('/api/facility/packages/:id/delete', {preHandler: facilityOnly, schema: idParam}, async request => {
        const lab = await ownLab(request.user.id);
        const {rowCount} = await app.pg.query('DELETE FROM lab_packages WHERE id = $1 AND facility_id = $2', [request.params.id, lab.user_id]);
        if (!rowCount) throw new HttpError(404, 'not_found', 'Package not found.');
        return {deleted: true};
    });

    // Public: packages of approved labs, to compare.
    app.get('/api/lab-packages', {config: {cache: 'public, max-age=60'}, schema: {querystring: {type: 'object', additionalProperties: false, properties: {
        governorate: {type: 'string', maxLength: 40}, topic: {type: 'string', maxLength: 40}
    }}}}, async request => {
        const args = [LAB_KINDS], where = ["p.status = 'approved'", 'u.disabled_at IS NULL', 'p.kind = ANY($1)'];
        if (request.query.governorate && Object.hasOwn(governorates, request.query.governorate)) where.push(`p.governorate = $${args.push(request.query.governorate)}`);
        const {rows: labs} = await app.pg.query(
            `SELECT u.id, p.facility_name, p.governorate, p.area, p.phone, 'home_collection' = ANY(p.services) AS home_collection
             FROM users u JOIN facility_profiles p ON p.user_id = u.id WHERE ${where.join(' AND ')} LIMIT 1000`, args);
        const byId = new Map(labs.map(l => [l.id, l]));
        let packages = labs.length ? await packagesOf(app.pg, labs.map(l => l.id)) : [];
        if (request.query.topic && Object.hasOwn(packageTopics, request.query.topic)) packages = packages.filter(k => k.topic === request.query.topic);
        return {packages: packages.slice(0, 300).map(k => {
            const lab = byId.get(k.facility_id);
            return {...k, lab: {id: lab.id, name: lab.facility_name, governorate: lab.governorate, area: lab.area, phone: lab.phone, home_collection: lab.home_collection}};
        }), topics: packageTopics};
    });
}
