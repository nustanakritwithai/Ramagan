// Offline shell ONLY: never cache API/auth, ledger, sales or patient information.
const CACHE_NAME = 'ramagan-v1-shell-1';
const scope = self.registration.scope;
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
    cache.addAll([scope, scope + 'index.html']).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((names) =>
    Promise.all(names.filter((name) => name.startsWith('ramagan-v1-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)))));
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const target = new URL(req.url);
  if (req.method !== 'GET' || target.origin !== self.location.origin ||
      /^\/(api|auth|rest)\//.test(target.pathname)) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
      }
      return response;
    }).catch(() => caches.match(req).then((result) =>
      result || caches.match(scope + 'index.html'))));
    return;
  }
  if (!/\.(?:js|css|svg|png|webp|woff2)$/.test(target.pathname)) return;
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req).then((response) => {
    if (response.ok) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
    }
    return response;
  })));
});