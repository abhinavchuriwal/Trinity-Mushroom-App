// Service worker for the installed phone app.
//
// Deliberately does NOT cache pages or data: every screen is fetched fresh from
// the server, so a supervisor never sees yesterday's readings or saves against
// a stale form. The only thing kept on the phone is a small "no connection"
// page, shown instead of the browser's error screen when signal drops.
const OFFLINE_CACHE = 'trinity-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only page loads. Form submissions (POST) and everything else go straight to
  // the network untouched.
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});
