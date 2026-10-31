// Service worker for the installed website (scripts/build.mjs puts VERSION and SHELL in front of this file).
// Pages and feeds come from the network first, so visitors always see the latest jobs and news when online;
// the saved copy is used only when the connection is down or too slow. Directories are saved on install, so
// hospital phone numbers still open without internet.
/* global VERSION, SHELL */
const CACHE = 'shc-site-' + VERSION;
const SLOW_MS = 6000;

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k.startsWith('shc-site-') && k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

const storable = response => response.ok && response.type === 'basic' && !/no-store/.test(response.headers.get('Cache-Control') || '');

async function networkFirst(event, fallback) {
    const request = event.request, cache = await caches.open(CACHE);
    const network = fetch(request).then(async response => {
        if (storable(response)) await cache.put(request, response.clone()).catch(() => {});
        return response;
    });
    event.waitUntil(network.catch(() => {}));  // keep saving the fresh copy even after a saved one was shown
    const saved = () => cache.match(request, {ignoreSearch: true});
    // A slow network answers from the saved copy; without one, keep waiting for the network.
    const slow = new Promise(resolve => setTimeout(resolve, SLOW_MS)).then(async () => (await saved()) || network);
    try {
        return await Promise.race([network, slow]);
    } catch (_) {
        return (await saved()) || (fallback && await cache.match(fallback)) || Response.error();
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE);
    const saved = await cache.match(request);
    if (saved) return saved;
    const response = await fetch(request);
    if (storable(response)) await cache.put(request, response.clone()).catch(() => {});
    return response;
}

self.addEventListener('fetch', event => {
    const request = event.request, url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;
    if (request.mode === 'navigate') return event.respondWith(networkFirst(event, 'offline.html'));
    // Style and script URLs change with every release (?v=...), so a saved copy is always the right one.
    if (url.searchParams.has('v') && /\.(css|js)$/.test(url.pathname)) return event.respondWith(cacheFirst(request));
    event.respondWith(networkFirst(event));
});
