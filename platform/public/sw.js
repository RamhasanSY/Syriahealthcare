// Service worker for the installed platform app. Only the page frames, styles, scripts and icons are saved,
// so the app opens quickly and shows a clear notice without internet. Nothing under /api/ is ever saved:
// appointments, profiles and licence documents always come fresh from the server and never stay on the phone.
const CACHE = 'shc-app-v1';
const SHELL = ['/', '/offline', '/login', '/staff', '/doctors', '/account', '/assets/app.css', '/assets/common.js',
    '/assets/logo.svg', '/assets/favicon.svg', '/assets/icon-192.png', '/manifest.webmanifest'];
const SLOW_MS = 6000;

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k.startsWith('shc-app-') && k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

const storable = response => response.ok && response.type === 'basic' && !/no-store/.test(response.headers.get('Cache-Control') || '');

async function networkFirst(event, fallback) {
    const request = event.request, cache = await caches.open(CACHE);
    const network = fetch(request).then(async response => {
        if (storable(response)) await cache.put(request, response.clone()).catch(() => {});
        return response;
    });
    event.waitUntil(network.catch(() => {}));
    const saved = () => cache.match(request, {ignoreSearch: true});
    const slow = new Promise(resolve => setTimeout(resolve, SLOW_MS)).then(async () => (await saved()) || network);
    try {
        return await Promise.race([network, slow]);
    } catch (_) {
        return (await saved()) || (fallback && await cache.match(fallback)) || Response.error();
    }
}

self.addEventListener('fetch', event => {
    const request = event.request, url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
    event.respondWith(networkFirst(event, request.mode === 'navigate' ? '/offline' : null));
});
