/**
 * Toronto Skating service worker — deliberately boring.
 *
 * Strategy: NETWORK-FIRST for every same-origin GET, falling back to the
 * last cached copy when offline. That gives:
 *   - zero staleness risk while online (the site's ?v= cache-busting and
 *     the CI-committed data JSONs behave exactly as without a SW),
 *   - a fully browsable last-seen schedule offline (rink-side, bad signal).
 *
 * Never touches cross-origin requests: Nostr websockets aren't fetches,
 * and the DaySmart / Nominatim calls should fail loudly when offline
 * rather than serve stale "live" data.
 *
 * Bump CACHE on releases that must evict old assets immediately;
 * otherwise network-first keeps everything current anyway.
 */
const CACHE = 'skate-v2.7';

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

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;   // cross-origin: hands off

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
