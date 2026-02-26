const CACHE_NAME = 'azimut-cai-v6';
const ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'service-worker.js',
  'app.js'
];

// Install: cache base
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate: pulizia cache vecchie
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve()))
    ))
  );
  self.clients.claim();
});

// Fetch: cache-first per gli asset, network per il resto
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo GET
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});