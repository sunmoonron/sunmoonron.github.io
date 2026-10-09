/**
 * Toronto Skating service worker — deliberately boring.
 *
 * Two strategies, chosen per request:
 *   - VERSIONED ASSETS (any same-origin URL carrying ?v=…, plus the vendored
 *     libraries under assets/vendor/): CACHE-FIRST. A version is immutable, so
 *     a cached copy is the latest copy; the first visit fetches it once and
 *     every later load, including the lazily loaded chat stack, is instant.
 *     A release changes the ?v= in index.html, so new code is fetched exactly
 *     once and the old entries go when CACHE is bumped.
 *   - EVERYTHING ELSE (index.html, data JSONs, images): NETWORK-FIRST, falling
 *     back to the last cached copy offline. Zero staleness while online, a
 *     browsable last-seen schedule rink-side.
 *
 * Never touches cross-origin requests: Nostr websockets aren't fetches, and
 * the DaySmart / Nominatim / home-server calls should fail loudly when
 * offline rather than serve stale "live" data.
 *
 * Bump CACHE on releases that must evict old assets immediately.
 */
const CACHE = 'skate-v3.8';

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE)
            .then(c => c.addAll(['./', './index.html']))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

const isVersioned = (url) => /[?&]v=/.test(url.search) || url.pathname.includes('/assets/vendor/');

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;   // cross-origin: hands off

    if (isVersioned(url)) {
        e.respondWith(
            caches.match(req).then(hit => hit || fetch(req).then(res => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
                }
                return res;
            }))
        );
        return;
    }

    e.respondWith(
        fetch(req).then(res => {
            if (res.ok) {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
            }
            return res;
        }).catch(async () => {
            const hit = await caches.match(req);
            if (hit) return hit;
            // offline navigation to an uncached URL → serve the app shell
            if (req.mode === 'navigate') {
                const shell = await caches.match('./index.html');
                if (shell) return shell;
            }
            return Response.error();
        })
    );
});
