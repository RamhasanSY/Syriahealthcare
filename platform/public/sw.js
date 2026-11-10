// Service worker for the installed platform app. Only the page frames, styles, scripts and icons are saved,
// so the app opens quickly and shows a clear notice without internet. Nothing under /api/ is ever saved:
// appointments, profiles and licence documents always come fresh from the server and never stay on the phone.
// The health file page is saved too, so the patient number (kept in localStorage, see common.js) shows without internet.
const CACHE = 'shc-app-v10';
const SHELL = ['/', '/offline', '/login', '/staff', '/doctors', '/account', '/file', '/assets/app.css', '/assets/common.js', '/assets/file.js', '/assets/share.js',
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
        // Stored under the path alone, so search words, doctor ids or booking times never stay on the device.
        if (storable(response)) await cache.put(new URL(request.url).origin + new URL(request.url).pathname, response.clone()).catch(() => {});
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

// Notifications (src/push.js). The message is encrypted for this device; it only says that something is new.
self.addEventListener('push', event => {
    let message = {};
    try { message = event.data ? event.data.json() : {}; } catch (_) {}
    const text = value => typeof value === 'string' ? value : '';
    event.waitUntil(self.registration.showNotification(text(message.title) || 'SyriaHC', {
        body: text(message.body), icon: '/assets/icon-192.png', badge: '/assets/icon-192.png',
        lang: message.lang === 'en' ? 'en' : 'ar', dir: message.lang === 'en' ? 'ltr' : 'rtl',
        tag: text(message.tag) || undefined, data: {url: text(message.url) || '/account'}
    }));
});

// Opens the page the notification is about, in an open window of the app if there is one. Only pages of this site:
// anything but a plain path ("//other.example", "https://...") opens the account page instead.
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const path = event.notification.data?.url || '';
    const url = new URL(/^\/(?![\/\\])/.test(path) ? path : '/account', self.location.origin).href;
    event.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(windows => {
        const open = windows.find(w => new URL(w.url).origin === self.location.origin);
        if (!open) return self.clients.openWindow(url);
        return open.navigate(url).then(w => (w || open).focus()).catch(() => self.clients.openWindow(url));
    }));
});
