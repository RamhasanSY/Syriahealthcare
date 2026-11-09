import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, teardown} from './helpers.js';
import {SUMMARIES} from '../src/openapi.js';

let app, doc;
before(async () => {
    ({app} = await setup());
    const res = await app.inject({url: '/api/openapi.json'});
    assert.equal(res.statusCode, 200);
    doc = res.json();
});
after(() => teardown(app));

// A real-looking URL for a path: ids become a UUID, page numbers 1.
const example = path => path.replace('{page}', '1').replace(/\{\w+\}/g, '00000000-0000-4000-8000-000000000000');

const operations = () => Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({key: `${method.toUpperCase()} ${path}`, path, method, op})));

describe('OpenAPI description of /api', () => {
    test('is an OpenAPI 3.1 document for this platform with the session cookie as security scheme', () => {
        assert.equal(doc.openapi, '3.1.0');
        assert.equal(doc.servers[0].url, 'http://127.0.0.1:3000');
        assert.deepEqual(doc.components.securitySchemes.session, {type: 'apiKey', in: 'cookie', name: 'shc_session'});
    });

    test('lists every route exactly as registered, each with its own summary', () => {
        const keys = operations().map(o => o.key);
        assert.ok(keys.length >= 60);
        assert.deepEqual(keys.filter(k => !SUMMARIES[k]), [], 'routes without a summary');
        assert.deepEqual(Object.keys(SUMMARIES).filter(k => !keys.includes(k)), [], 'summaries for routes that no longer exist');
        assert.equal(keys.some(k => k.startsWith('HEAD ')), false);
        assert.equal(keys.some(k => k.includes('/fhir/')), false, 'FHIR has its own CapabilityStatement');
    });

    test('path parameters use {name} and are declared', () => {
        for (const {path, op} of operations()) {
            assert.doesNotMatch(path, /:/);
            for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
                assert.ok(op.parameters?.some(p => p.in === 'path' && p.name === name && p.required), `${path} declares ${name}`);
            }
        }
    });

    test('who may call a route comes from its guard', () => {
        const byKey = Object.fromEntries(operations().map(o => [o.key, o.op]));
        assert.deepEqual(byKey['GET /api/doctors'].tags, ['Public']);
        assert.equal(byKey['GET /api/doctors'].security, undefined);
        assert.deepEqual(byKey['GET /api/lab/results'].tags, ['Facilities']);
        assert.deepEqual(byKey['GET /api/lab/results'].security, [{session: []}]);
        assert.deepEqual(byKey['POST /api/admin/users/{id}/disable'].tags, ['Administrators']);
        assert.deepEqual(byKey['GET /api/appointments/mine'].tags, ['Patients']);
        assert.deepEqual(byKey['GET /api/me'].tags.sort(), ['Administrators', 'Doctors', 'Facilities', 'Patients']);
        assert.ok(byKey['POST /api/lab/results'].requestBody.content['multipart/form-data'], 'uploads are multipart');
        assert.ok(byKey['POST /api/auth/login'].requestBody.content['application/json'].schema.properties.email);
    });

    test('every protected GET route really refuses a request without a session', async () => {
        const protectedGets = operations().filter(o => o.method === 'get' && o.op.security);
        assert.ok(protectedGets.length > 10);
        for (const {path} of protectedGets) {
            const url = example(path);
            assert.equal((await app.inject({url})).statusCode, 401, url);
        }
    });

    test('every public GET route answers without a session', async () => {
        for (const {path, op} of operations().filter(o => o.method === 'get' && !o.op.security)) {
            const url = example(path);
            assert.notEqual((await app.inject({url})).statusCode, 401, `${url} (${op.summary})`);
        }
    });

    test('the developer page links to the description and the FHIR directory', async () => {
        const res = await app.inject({url: '/developers'});
        assert.equal(res.statusCode, 200);
        assert.match(res.body, /\/api\/openapi\.json/);
        assert.match(res.body, /\/fhir\/r4\/metadata/);
    });
});
