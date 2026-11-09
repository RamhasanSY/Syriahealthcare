import {after, before, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {setup, signIn, teardown} from './helpers.js';
import {versionLinks} from '../src/pages.js';

let app, post;
before(async () => {
    ({app, post} = await setup());
});
after(() => teardown(app));

const get = (url, headers = {}) => app.inject({url, headers});

describe('pages and assets', () => {
    test('pages link to versioned assets, are always revalidated and answer 304 when unchanged', async () => {
        const res = await get('/file');
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^text\/html/);
        assert.equal(res.headers['cache-control'], 'no-cache');
        assert.match(res.body, /src="\/assets\/common\.js\?v=[A-Za-z0-9_-]{12}"/);
        assert.match(res.body, /href="\/assets\/app\.css\?v=[A-Za-z0-9_-]{12}"/);
        assert.equal((await get('/file', {'if-none-match': res.headers.etag})).statusCode, 304);
        assert.equal((await get('/file.html')).body, res.body, '/file.html is the same page');
        assert.equal((await get('/')).statusCode, 200);
        assert.equal((await get('/no-such-page')).statusCode, 404);
        assert.equal((await get('/sw.js')).statusCode, 200, 'other files at the top level are still served');
        assert.equal((await get('/manifest.webmanifest')).statusCode, 200);
    });

    test('versioned assets are kept for a year, unversioned ones for 5 minutes', async () => {
        const page = (await get('/file')).body;
        const url = page.match(/src="(\/assets\/common\.js\?v=[^"]+)"/)[1];
        assert.equal((await get(url)).headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal((await get('/assets/common.js')).headers['cache-control'], 'public, max-age=300');
    });

    test('only existing assets get a version, and only once', () => {
        const versions = new Map([['/assets/a.js', 'v1']]);
        assert.equal(versionLinks('<script src="/assets/a.js"></script><script src="/assets/b.js"></script><a href="/assets/a.js?x=1">',
            versions), '<script src="/assets/a.js?v=v1"></script><script src="/assets/b.js"></script><a href="/assets/a.js?x=1">');
    });
});

describe('API caching and timing', () => {
    test('public lists may be kept briefly, everything personal never; every answer says how long it took', async () => {
        assert.equal((await get('/api/catalog')).headers['cache-control'], 'public, max-age=3600');
        assert.equal((await get('/api/doctors')).headers['cache-control'], 'public, max-age=60');
        assert.equal((await get('/api/facilities')).headers['cache-control'], 'public, max-age=60');
        assert.equal((await get('/api/me')).headers['cache-control'], 'no-store');
        assert.equal((await get('/api/auth/methods')).headers['cache-control'], 'no-store');
        assert.match((await get('/api/health')).headers['server-timing'], /^app;dur=\d+(\.\d)?$/);
    });
});

describe('system status for administrators', () => {
    test('shows speed and health without personal data; only for administrators', async () => {
        await get('/api/doctors');
        const admin = await signIn(post, 'admin', 'admin@example.org');
        const res = await get('/api/admin/status', {cookie: admin});
        assert.equal(res.statusCode, 200);
        const s = res.json();
        assert.ok(s.server.uptime_s >= 0 && s.server.rss_mb > 0);
        assert.ok(s.database.size_mb > 0 && s.database.largest_tables.length > 0);
        assert.ok(s.requests.busiest.some(r => r.route === 'GET /api/doctors'));
        assert.doesNotMatch(res.body, /admin@example\.org/);
        assert.ok('waiting' in s.email && s.disk === null || s.disk.total_gb > 0);
        const doctor = await signIn(post, 'doctor', 'dr@example.org');
        assert.equal((await get('/api/admin/status', {cookie: doctor})).statusCode, 403);
        assert.equal((await get('/api/admin/status')).statusCode, 401);
    });
});
