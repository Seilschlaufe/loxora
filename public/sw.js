/* Only the public app shell is cached. Documents remain in per-account IndexedDB;
   API requests, auth URLs, external requests, and API responses are never cached. */
const CACHE = 'lexora-shell-v2-compact';
const PAGES = ['/', '/library', '/read', '/vocabulary', '/settings'];
const ASSETS = [...PAGES, '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('lexora-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.search || request.headers.has('RSC')) return;
  if (request.mode === 'navigate' && PAGES.includes(url.pathname)) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, copy)));
      }
      return response;
    }).catch(async () => (await caches.match(url.pathname)) || (await caches.match('/')) || new Response('Нет соединения. Откройте Lexora онлайн хотя бы один раз.', {status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8'}})));
  } else if (url.pathname.startsWith('/_next/static/') || (ASSETS.includes(url.pathname) && !PAGES.includes(url.pathname))) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
      }
      return response;
    })));
  }
});
