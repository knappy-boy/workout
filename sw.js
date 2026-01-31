// Change this version string EVERY time you update your code
const CACHE = "liftlog-ultra-v21";

const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  // Force the waiting service worker to become the active service worker
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  // Clean up old caches immediately
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((k) => {
          if (k !== CACHE) {
            return caches.delete(k);
          }
        })
      )
    )
  );
  // Tell the active service worker to take control of the page immediately
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Network-first strategy: try network, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Clone and cache the fresh response
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(event.request).then((cached) => {
          return cached || caches.match("./");
        });
      })
  );
});
