/**
 * Offline support: cache-first with background refresh for same-origin GETs.
 * The app shell is precached on install; runtime fetches (compiled JS modules)
 * are cached as they load, so after the first visit the app works offline —
 * important in stores with poor reception. Updates arrive one load behind.
 */
const CACHE = "smart-to-do-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./src/ui/theme.css",
  "./src/ui/app.css",
  "./dist/src/ui/app.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => undefined);
      if (cached) {
        network.catch(() => undefined); // refresh in the background
        return cached;
      }
      return (await network) ?? new Response("Offline", { status: 503 });
    })(),
  );
});
