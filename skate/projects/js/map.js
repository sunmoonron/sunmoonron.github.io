/**
 * SkateMap — the interactive rink map (free scroll/pinch, pins, popups).
 *
 * Leaflet is VENDORED (assets/vendor/leaflet/) and lazy-injected the
 * first time the map opens — visitors who never open it download zero
 * map bytes. Tiles come from openstreetmap.org with attribution (their
 * usage policy is fine with a small site; tiles are the ONLY runtime
 * third-party here). Dark mode restyles tiles with a CSS filter — no
 * second tile provider needed.
 *
 * The module owns Leaflet lifecycle only; pin CONTENT and actions come
 * from app.js via `configure()` callbacks, keeping data logic in one
 * place (same pattern as SkateCalendar).
 *
 * Failure modes: Leaflet load failure → toast + modal closes; offline
 * tiles render grey (Leaflet default) while pins/popups still work.
 */
window.SkateMap = (() => {
    'use strict';

    const VENDOR = 'assets/vendor/leaflet/';
    const TORONTO_CENTER = [43.72, -79.38];

    let leafletReady = null;   // promise, memoized
    let map = null;
    let pinLayer = null;
    let userMarker = null;
    let filter = 'all';        // 'all' | 'indoor' | 'outdoor'
    let hooks = {};            // { popupHtml(rink), onOpen(), userPoint() }

    function configure(h) { hooks = { ...hooks, ...h }; }

    function injectOnce(tag, attrs) {
        return new Promise((resolve, reject) => {
            const el = document.createElement(tag);
            Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
            el.onload = resolve;
            el.onerror = () => reject(new Error(`failed to load ${attrs.href || attrs.src}`));
            document.head.appendChild(el);
        });
    }

    function ensureLeaflet() {
        if (leafletReady) return leafletReady;
        leafletReady = (async () => {
            await injectOnce('link', { rel: 'stylesheet', href: `${VENDOR}leaflet.css` });
            await injectOnce('script', { src: `${VENDOR}leaflet.js` });
            if (!window.L) throw new Error('Leaflet missing after load');
        })().catch(e => { leafletReady = null; throw e; });
        return leafletReady;
    }

    function initMap() {
        if (map) return;
        map = L.map('map-canvas', {
            center: TORONTO_CENTER, zoom: 11,
            zoomControl: true, attributionControl: true
        });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
        pinLayer = L.layerGroup().addTo(map);
    }

    function rinkMatchesFilter(r) {
        if (filter === 'all') return true;
        return (r.kinds || []).includes(filter);
    }

    function renderPins() {
        if (!map) return;
        pinLayer.clearLayers();
        const rinks = (window.SkateGeo?.rinks || []).filter(r => r.lat != null && rinkMatchesFilter(r));
        rinks.forEach(r => {
            const marker = L.marker([r.lat, r.lng], { title: r.name });
            marker.bindPopup(() => (hooks.popupHtml ? hooks.popupHtml(r) : r.name), { maxWidth: 260 });
            pinLayer.addLayer(marker);
        });

        // user's saved 📍 point as a blue dot
        const u = hooks.userPoint ? hooks.userPoint() : null;
        if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
        if (u && typeof u.lat === 'number') {
            userMarker = L.circleMarker([u.lat, u.lng], {
                radius: 8, color: '#1673c4', weight: 2, fillColor: '#2f9fc4', fillOpacity: 0.85
            }).addTo(map).bindPopup(`📍 ${u.label || 'Your location'}`);
        }
        return rinks.length;
    }

    function setFilter(f) {
        filter = f;
        document.querySelectorAll('#map-filter-seg button').forEach(b =>
            b.classList.toggle('active', b.dataset.mapfilter === f));
        const n = renderPins();
        const title = document.getElementById('map-title');
        if (title) title.textContent = `🗺️ Rink map${f === 'all' ? '' : ` — ${f}`}${n != null ? ` (${n})` : ''}`;
    }

    /**
     * Open the map modal. opts: { filter, center:[lat,lng], zoom }
     * Returns after the map is live (or throws if Leaflet can't load).
     */
    async function open(opts = {}) {
        document.getElementById('map-modal').classList.remove('hidden');
        try {
            await ensureLeaflet();
        } catch (e) {
            document.getElementById('map-modal').classList.add('hidden');
            throw e;
        }
        initMap();
        setFilter(opts.filter || filter || 'all');
        if (opts.center) map.setView(opts.center, opts.zoom || 13);
        // modal was display:none during init → recalc dimensions
        requestAnimationFrame(() => map.invalidateSize());
        setTimeout(() => map && map.invalidateSize(), 250);   // rAF can be throttled in bg tabs
        if (hooks.onOpen) hooks.onOpen();
    }

    function close() {
        document.getElementById('map-modal').classList.add('hidden');
    }

    /** Re-render pins in place (e.g. after starring a rink from a popup). */
    function refresh() { if (map) renderPins(); }

    return { configure, open, close, setFilter, refresh, get isOpen() { return !document.getElementById('map-modal').classList.contains('hidden'); } };
})();

if (typeof module !== 'undefined') module.exports = window.SkateMap;
