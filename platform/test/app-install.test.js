// Installing the platform as an app: manifest, icons, service worker and offline page.
import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setup, teardown} from './helpers.js';

let app;
beforeEach(async () => {
    await app?.close();
    ({app} = await setup());
});
after(() => teardown(app));

describe('installable app', () => {
    test('manifest describes a standalone app with its icons', async () => {
        const res = await app.inject({url: '/manifest.webmanifest'});
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^application\/manifest\+json/);
        const manifest = res.json();
        assert.equal(manifest.display, 'standalone');
        assert.equal(manifest.start_url, '/');
        assert.ok(manifest.icons.some(i => i.purpose === 'maskable'));
        for (const icon of [...manifest.icons, {src: '/assets/apple-touch-icon.png'}]) {
            const image = await app.inject({url: icon.src});
            assert.equal(image.statusCode, 200, icon.src);
            assert.equal(image.headers['content-type'], 'image/png');
        }
    });

    test('service worker and offline page are served from the site root with security headers', async () => {
        const worker = await app.inject({url: '/sw.js'});
        assert.equal(worker.statusCode, 200);
        assert.match(worker.headers['content-type'], /javascript/);
        assert.match(worker.headers['content-security-policy'], /default-src 'self'/);
        const offline = await app.inject({url: '/offline'});
        assert.equal(offline.statusCode, 200);
        assert.match(offline.body, /You are offline/);
    });

    test('the service worker never saves personal data from the API', async () => {
        const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
        assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)\) return;/);
        assert.ok(!/['"]\/api\//.test(source.replace(/startsWith\('\/api\/'\)/, '')), 'no API address in the saved list');
        // API answers also tell every cache not to keep them.
        const health = await app.inject({url: '/api/health'});
        assert.equal(health.headers['cache-control'], 'no-store');
    });

    test('every page links the manifest and the iPhone icon', async () => {
        for (const page of ['/', '/login', '/staff', '/account', '/doctors', '/doctor', '/book', '/appointments', '/dashboard', '/schedule', '/facility', '/admin', '/privacy', '/offline']) {
            const res = await app.inject({url: page});
            assert.equal(res.statusCode, 200, page);
            assert.match(res.body, /<link rel="manifest" href="\/manifest\.webmanifest">/, page);
            assert.match(res.body, /<link rel="apple-touch-icon" href="\/assets\/apple-touch-icon\.png">/, page);
        }
    });
});
