// EasyData GH - Service Worker
const CACHE = 'easydata-v1';
const OFFLINE_URLS = [
  '/',
  '/index.html',
  '/icon-192.png',
  '/icon-512.png'
];

// Install - cache core files
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(OFFLINE_URLS);
    })
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch - network first, fallback to cache
self.addEventListener('fetch', function(e) {
  // Skip non-GET and cross-origin requests (Supabase, Paystack)
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    fetch(e.request)
      .then(function(res) {
        // Cache fresh responses
        var clone = res.clone();
        caches.open(CACHE).then(function(cache) {
          cache.put(e.request, clone);
        });
        return res;
      })
      .catch(function() {
        // Offline fallback
        return caches.match(e.request)
          .then(function(cached) {
            return cached || caches.match('/index.html');
          });
      })
  );
});
