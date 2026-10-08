const CACHE = 'recipe-deck-v1.4.3-brand-home';
const ASSETS = ['./','./index.html','./style.css','./app.mjs','./model.mjs','./db.mjs','./cloud-snapshot.mjs','./cloud-api.mjs','./cloud-auto.mjs','./cloud-policy.mjs','./cloud-ui.mjs','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE && key.startsWith('recipe-deck-')).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/v1/')) return;
  // Cache only the public app shell. Authentication and private snapshots are
  // always network-only and must never survive logout in Cache Storage.
  const base = new URL('./', self.location.href);
  const paths = ASSETS.map(path => new URL(path, base).pathname);
  if (!paths.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request, {ignoreSearch:true})).then(cached => cached || fetch(event.request)));
});
