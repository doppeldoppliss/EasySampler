// MADDAW service worker: the app shell works offline once visited. Hashed
// assets are cached as they are fetched (cache first); the page itself is
// fetched network first so a new release shows up on the next load.
const CACHE = "maddaw-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const fromNetwork = async () => {
        const response = await fetch(request);
        if (response.ok) void cache.put(request, response.clone());
        return response;
      };
      if (request.mode === "navigate") {
        try {
          return await fromNetwork();
        } catch {
          return (await cache.match(request)) ?? (await cache.match("./")) ?? Response.error();
        }
      }
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        return await fromNetwork();
      } catch {
        return Response.error();
      }
    })(),
  );
});
