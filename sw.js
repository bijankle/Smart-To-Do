/**
 * Offline support: NETWORK-FIRST with cache fallback for same-origin GETs.
 * Online, every launch gets the newest deployed version immediately; the
 * cache only serves when the network is unavailable or slow (>4s) — i.e. in
 * a store aisle, which is exactly where offline support matters.
 */
const CACHE = "smart-to-do-v3";
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(event.request, { signal: controller.signal });
        clearTimeout(timer);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      } catch {
        clearTimeout(timer);
        const cached = await cache.match(event.request);
        return cached ?? new Response("Offline", { status: 503 });
      }
    })(),
  );
});
