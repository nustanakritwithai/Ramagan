// Offline shell ONLY: never cache API/auth, ledger, sales or patient information.
const CACHE_NAME = 'ramagan-v1-shell-2';
const scope = self.registration.scope;
const appPath = new URL(scope).pathname;
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
      req.headers.has('Authorization') ||
      /^\/(?:ramagan(?:-test)?-api|api|auth|rest|v1)(?:\/|$)/.test(target.pathname) ||
      !target.pathname.startsWith(appPath)) return;
  const relative = target.pathname.slice(appPath.length);
  if (req.mode === 'navigate' && (relative === '' || relative === 'index.html')) {
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
  // Scope allowlist only: no arbitrary same-origin API or private photo caching.
  if (!/^assets\/[A-Za-z0-9_.-]+\.(?:js|css|svg|png|webp|woff2)$/.test(relative) &&
      !['icon.svg', 'manifest.webmanifest'].includes(relative)) return;
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req).then((response) => {
    if (response.ok) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
    }
    return response;
  })));
});
