// Change this version string EVERY time you update your code
const CACHE = "liftlog-ultra-v1";

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
  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Return cached response if found, otherwise fetch from network
      return cached || fetch(event.request).catch(() => {
        // If both fail (offline & not cached), return main page
        return caches.match("./");
      });
    })
  );
});
