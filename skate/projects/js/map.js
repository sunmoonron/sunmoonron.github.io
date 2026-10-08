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
    let markersByKey = {};     // String(locationid) → marker, for focusRink()
    let lastUserKey = null;    // "lat,lng" of the user point last drawn (a change flies the map there)
    let filter = 'all';        // 'all' | 'indoor' | 'outdoor'
    let hooks = {};            // { popupHtml(rink), onOpen(), userPoint(), rinkFilter(rink) }

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

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function renderPins() {
        if (!map) return;
        pinLayer.clearLayers();
        markersByKey = {};
        const rinks = (window.SkateGeo?.rinks || []).filter(r => r.lat != null && rinkMatchesFilter(r) && (!hooks.rinkFilter || hooks.rinkFilter(r)));
        rinks.forEach(r => {
            const marker = L.marker([r.lat, r.lng], { title: r.name });
            marker.bindPopup(() => (hooks.popupHtml ? hooks.popupHtml(r) : r.name), { maxWidth: 260 });
            pinLayer.addLayer(marker);
            markersByKey[String(r.locationid)] = marker;
        });

        // The saved 📍 point: a pulsing ring, a dot and a "You" pill (the old
        // 8 px circle vanished among the pins). A changed point flies the map there.
        const u = hooks.userPoint ? hooks.userPoint() : null;
        if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
        if (u && typeof u.lat === 'number') {
            const icon = L.divIcon({
                className: 'you-pin-wrap',
                html: `<div class="you-pin" aria-label="${esc(u.label || 'Your location')}"><span class="you-ring"></span><span class="you-dot"></span><span class="you-label">You</span></div>`,
                iconSize: [0, 0], iconAnchor: [0, 0]
            });
            userMarker = L.marker([u.lat, u.lng], { icon, zIndexOffset: 1000, title: u.label || 'Your location' })
                .addTo(map).bindPopup(esc(u.label || 'Your location'));
            const key = `${u.lat},${u.lng}`;
            if (lastUserKey !== null && key !== lastUserKey) map.flyTo([u.lat, u.lng], Math.max(map.getZoom(), 12), { duration: 0.8 });
            lastUserKey = key;
        } else {
            lastUserKey = null;
        }
        return rinks.length;
    }

    /**
     * Fly to a rink's pin and open it (the list's rink names call this).
     * A rink hidden by the indoor/outdoor filter shows everything first.
     */
    function focusRink(key) {
        if (!map) return false;
        key = String(key);
        if (!markersByKey[key] && filter !== 'all') setFilter('all');
        const m = markersByKey[key];
        const r = (window.SkateGeo?.rinks || []).find(x => String(x.locationid) === key);
        const target = m ? m.getLatLng() : (r && r.lat != null ? L.latLng(r.lat, r.lng) : null);
        if (!target) return false;
        const canvas = document.getElementById('map-canvas');
        if (canvas && canvas.scrollIntoView) canvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        map.invalidateSize();
        map.flyTo(target, Math.max(map.getZoom(), 14), { duration: 0.8 });
        if (m) setTimeout(() => { if (map) m.openPopup(); }, 850);
        return true;
    }

    function setFilter(f) {
        filter = f;
        document.querySelectorAll('#map-filter-seg button').forEach(b =>
            b.classList.toggle('active', b.dataset.mapfilter === f));
        const n = renderPins();
        const title = document.getElementById('rinks-title');
        if (title) title.textContent = `Rinks${f === 'all' ? '' : `: ${f}`}${n != null ? ` (${n})` : ''}`;
    }

    /**
     * Open the map modal. opts: { filter, center:[lat,lng], zoom }
     * Returns after the map is live (or throws if Leaflet can't load).
     */
    async function open(opts = {}) {
        document.getElementById('rinks-modal').classList.remove('hidden');
        try {
            await ensureLeaflet();
        } catch (e) {
            document.getElementById('rinks-modal').classList.add('hidden');
            throw e;
        }
        initMap();
        // With a saved location the map opens around it (rinks near you), else Toronto-wide.
        const u = hooks.userPoint ? hooks.userPoint() : null;
        if (opts.center) map.setView(opts.center, opts.zoom || 13);
        else if (u && typeof u.lat === 'number') map.setView([u.lat, u.lng], 12);
        lastUserKey = (u && typeof u.lat === 'number') ? `${u.lat},${u.lng}` : null;   // the view was just set: no fly on this render
        setFilter(opts.filter || filter || 'all');
        // modal was display:none during init → recalc dimensions
        requestAnimationFrame(() => map.invalidateSize());
        setTimeout(() => map && map.invalidateSize(), 250);   // rAF can be throttled in bg tabs
        if (hooks.onOpen) hooks.onOpen();
    }

    function close() {
        document.getElementById('rinks-modal').classList.add('hidden');
    }

    /** Re-render pins in place (e.g. after starring a rink from a popup). */
    function refresh() { if (map) renderPins(); }

    return { configure, open, close, setFilter, refresh, focusRink, get isOpen() { return !document.getElementById('rinks-modal').classList.contains('hidden'); } };
})();

if (typeof module !== 'undefined') module.exports = window.SkateMap;
