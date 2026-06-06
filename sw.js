// occult service worker — cache-first app shell so the PWA is installable and
// works offline. The fetch handler is also what makes Chrome offer "Install".
const CACHE = 'occult-v2';

const ASSETS = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './favicon.svg', './icon-192.png', './icon-512.png',
  './vendor/chart.umd.min.js',
  './js/ble/uuids.js', './js/ble/parser.js', './js/ble/client.js',
  './js/data/schema.js', './js/data/db.js', './js/data/store.js', './js/data/export.js',
  './js/metrics/bodycomp.js',
  './js/ui/charts.js', './js/ui/render.js', './js/ui/profiles-ui.js',
  './js/util/events.js', './js/util/format.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for precached shell; runtime-cache everything else; offline → index.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
