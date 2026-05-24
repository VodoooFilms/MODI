const CACHE_NAME = 'mobmidi-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Install: pre-cache core shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: Network-first for JS/CSS (hot updates), Cache-first for static shell
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always network-first for dev Vite HMR and API calls
  if (url.pathname.startsWith('/@') || url.pathname.startsWith('/src')) {
    return; // Let the browser handle it natively
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache successful GET responses
        if (event.request.method === 'GET' && response.ok) {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
