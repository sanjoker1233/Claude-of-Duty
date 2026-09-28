/**
 * OVERWATCH service worker (Android web remix).
 *
 * App-shell strategy: on install, cache the shell (document, manifest,
 * icons). At runtime, cache-first for same-origin GET requests so the game
 * boots offline after one online visit; network-first for navigations so a
 * fresh deploy is picked up while online. Capture/dev queries (`?capture`,
 * `?lockstep`) always bypass the cache.
 */
const CACHE = 'overwatch-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function bypass(url) {
  return (
    url.searchParams.has('capture') ||
    url.searchParams.has('lockstep') ||
    url.searchParams.get('sw') === '0'
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || bypass(url)) return;

  if (request.mode === 'navigate') {
    // Online: fresh document. Offline: last cached shell.
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit ?? caches.match('./')))
    );
    return;
  }

  // Built assets + icons: cache-first, populate in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      });
    })
  );
});
