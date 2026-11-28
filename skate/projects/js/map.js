/**
 * SkateMap — the interactive rink map (free scroll/pinch, pins, popups).
 *
 * Leaflet is VENDORED (assets/vendor/leaflet/) and lazy-injected the
 * first time the map opens — visitors who never open it download zero
 * map bytes. Tiles come from openstreetmap.org with attribution (their
 * usage policy is fine with a small site; tiles are the ONLY runtime
 * third-party here). Dark mode restyles tiles with a CSS filter — no
 * second tile provider needed. (v3.23: a lighter tile set was tried.
 * The free ones now need an account and a key; see the changelog.)
 *
 * v3.23: the map is a view of the schedule, not a sheet of its own.
 * The module owns the Leaflet lifecycle only: WHICH rinks show, what a
 * pin looks like, the radius and how much of the canvas the rink list
 * covers all come from app.js through `configure()` callbacks, keeping
 * the data logic in one place (same pattern as SkateCalendar).
 *
 * Failure modes: Leaflet load failure → open() throws and the caller
 * says so (the rink list works without the map); offline tiles render
 * grey (Leaflet default) while pins/popups still work.
 */
window.SkateMap = (() => {
    'use strict';

    const VENDOR = 'assets/vendor/leaflet/';
    const TORONTO_CENTER = [43.72, -79.38];

    let leafletReady = null;   // promise, memoized
    let map = null;
    let pinLayer = null;
    let userMarker = null;
    let circle = null;         // v3.23: the "within N km" ring around the reader's spot
    let circleKey = 'none';    // "lat,lng,km" of the ring now drawn
    let markersByKey = {};     // String(locationid) → marker now on the map, for focusRink() and fitPins()
    let allMarkers = new Map(); // v3.12.1: String(locationid) → marker, built once and kept while the rink list is the same
    let markersFor = null;     // the rink list those markers were built from
    let lastFit = '';          // which pins the map was last framed around
    let lastUserKey = null;    // "lat,lng" of the user point last drawn (a change flies the map there)
    /**
     * { popupHtml(rink), userPoint(), rinkFilter(rink), pinState(rink) → { kind, on, mine, alert },
     *   radiusKm(), inset() → { top, right, bottom, left }, onPin(key) }
     */
    let hooks = {};

    function configure(h) { hooks = { ...hooks, ...h }; }

    function injectOnce(tag, attrs) {
        return new Promise((resolve, reject) => {
            const el = document.createElement(tag);
            Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
            el.setAttribute('data-lazy', '1');   // v3.12.2: not part of the release identity (app.js signatureOf)
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
        const note = document.querySelector('#map-canvas > .loading');
        if (note) note.remove();   // "Loading map…" has done its job (it showed through until the tiles arrived)
        map = L.map('map-canvas', {
            center: TORONTO_CENTER, zoom: 11,
            zoomControl: false, attributionControl: true
        });
        L.control.zoom({ position: 'topright' }).addTo(map);   // top right: the rink list covers the bottom on a phone
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
        pinLayer = L.layerGroup().addTo(map);
    }

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /* ---------- how much of the canvas something else covers (the pull-up rink list on a phone) ---------- */
    function insets() {
        let i = null;
        try { i = hooks.inset ? hooks.inset() : null; } catch {}
        const n = (v) => (typeof v === 'number' && v > 0 ? v : 0);
        const size = map ? map.getSize() : { x: 0, y: 0 };
        // never more than the canvas can spare: a list pulled all the way up leaves the map nothing to frame in
        const bottom = Math.min(n(i && i.bottom), Math.max(0, size.y - 120));
        return { top: n(i && i.top), right: n(i && i.right), bottom, left: n(i && i.left) };
    }
    /** Frame these bounds inside what is left visible. */
    function frame(bounds, { animate = true, maxZoom = 14, pad = 28 } = {}) {
        const i = insets();
        const o = { paddingTopLeft: [pad + i.left, pad + i.top], paddingBottomRight: [pad + i.right, pad + i.bottom], maxZoom };
        if (animate) map.flyToBounds(bounds, { ...o, duration: 0.5 });
        else map.fitBounds(bounds, { ...o, animate: false });
    }
    /** Put a point in the middle of what is left visible (dy: pixels below that middle, for a popup above the pin). */
    function centreOn(latlng, zoom, { animate = true, dy = 0, duration = 0.8 } = {}) {
        const i = insets();
        const shift = L.point((i.right - i.left) / 2, (i.bottom - i.top) / 2 - dy);
        const c = map.unproject(map.project(latlng, zoom).add(shift), zoom);
        if (animate) map.flyTo(c, zoom, { duration });
        else map.setView(c, zoom, { animate: false });
    }

    /* ---------- pins: a dot in the colour of its ice (v3.23; the stock blue teardrops said nothing) ---------- */
    function pinStateOf(r) {
        let st = null;
        try { st = hooks.pinState ? hooks.pinState(r) : null; } catch {}
        const kind = st && st.kind === 'outdoor' ? 'outdoor' : st && st.kind === 'indoor' ? 'indoor'
            : ((r.kinds || []).includes('outdoor') ? 'outdoor' : 'indoor');
        // v3.27: 'closed' (its listed sessions are likely cancelled) or 'warn' (an alert on some of them), as the list has it
        const alert = st && (st.alert === 'closed' || st.alert === 'warn') ? st.alert : '';
        return { kind, on: !st || st.on !== false, mine: !!(st && st.mine), alert };
    }
    const pinSig = (st) => `${st.kind}|${st.on ? 1 : 0}|${st.mine ? 1 : 0}|${st.alert}`;
    function pinIcon(st) {
        return L.divIcon({
            className: 'rink-pin-wrap',
            html: `<span class="rink-pin ${st.kind}${st.on ? '' : ' off'}${st.mine ? ' mine' : ''}${st.alert === 'closed' ? ' shut' : st.alert === 'warn' ? ' warn' : ''}"></span>`,
            iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -9]
        });
    }
    /** A popup opens above its pin: leave it room clear of the rink list. */
    function prepPopup(marker) {
        const pop = marker && marker.getPopup && marker.getPopup();
        if (!pop) return;
        const i = insets();
        pop.options.autoPanPaddingTopLeft = L.point(10 + i.left, 10 + i.top);
        pop.options.autoPanPaddingBottomRight = L.point(10 + i.right, 10 + i.bottom);
    }

    /**
     * Put the right pins on the map. v3.12.1: a pin is built once and kept; a change of
     * filter or search only adds and removes the pins that differ (typing a rink's name
     * used to throw away and rebuild every pin at each pause). `fresh` rebuilds them all,
     * which also closes an open popup: used after an action inside a popup.
     */
    function renderPins(fresh = false) {
        if (!map) return 0;
        const all = window.SkateGeo?.rinks || [];
        if (fresh || markersFor !== all) {
            pinLayer.clearLayers();
            allMarkers = new Map();
            markersByKey = {};
            markersFor = all;
        }
        const want = new Map();
        all.forEach(r => { if (r.lat != null && (!hooks.rinkFilter || hooks.rinkFilter(r))) want.set(String(r.locationid), r); });
        Object.keys(markersByKey).forEach(key => {
            if (want.has(key)) return;
            pinLayer.removeLayer(markersByKey[key]);
            delete markersByKey[key];
        });
        want.forEach((r, key) => {
            const st = pinStateOf(r), sig = pinSig(st);
            let marker = allMarkers.get(key);
            if (!marker) {
                marker = L.marker([r.lat, r.lng], { title: r.name, icon: pinIcon(st), riseOnHover: true });
                marker._skateSig = sig;
                // registered before the popup's own handler: the popup's room is set first, and the list hears about the tap
                marker.on('click', () => { prepPopup(marker); if (hooks.onPin) { try { hooks.onPin(key); } catch {} } });
                marker.bindPopup(() => (hooks.popupHtml ? hooks.popupHtml(r) : r.name), { maxWidth: 260 });
                allMarkers.set(key, marker);
            } else if (marker._skateSig !== sig) {
                marker.setIcon(pinIcon(st));
                marker._skateSig = sig;
            }
            marker.setZIndexOffset((st.on ? 200 : 0) + (st.mine ? 400 : 0));   // what has sessions sits above what has none
            if (!markersByKey[key]) { pinLayer.addLayer(marker); markersByKey[key] = marker; }
        });

        // The saved 📍 point: a pulsing ring, a dot and a "You" pill (the old
        // 8 px circle vanished among the pins). A changed point flies the map there.
        const u = hooks.userPoint ? hooks.userPoint() : null;
        const has = !!(u && typeof u.lat === 'number');
        const uKey = has ? `${u.lat},${u.lng},${u.label || ''}` : 'none';
        if (!userMarker || userMarker._skateKey !== uKey) {
            if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
            if (has) {
                const icon = L.divIcon({
                    className: 'you-pin-wrap',
                    html: `<div class="you-pin" aria-label="${esc(u.label || 'Your location')}"><span class="you-ring"></span><span class="you-dot"></span><span class="you-label">You</span></div>`,
                    iconSize: [0, 0], iconAnchor: [0, 0]
                });
                userMarker = L.marker([u.lat, u.lng], { icon, zIndexOffset: 1000, title: u.label || 'Your location' })
                    .addTo(map).bindPopup(esc(u.label || 'Your location'));
                userMarker._skateKey = uKey;
            }
        }
        // v3.23: the "within N km" ring. A new ring (a new spot, or another distance) is framed whole;
        // a new spot without one flies there, as before (including the very first one granted while the map is open).
        let km = null;
        try { km = hooks.radiusKm ? hooks.radiusKm() : null; } catch {}
        const cKey = has && km ? `${u.lat},${u.lng},${km}` : 'none';
        const key = has ? `${u.lat},${u.lng}` : 'none';
        if (cKey !== circleKey) {
            if (circle) { map.removeLayer(circle); circle = null; }
            if (cKey !== 'none') {
                circle = L.circle([u.lat, u.lng], { radius: km * 1000, className: 'radius-ring', interactive: false, weight: 2 }).addTo(map);
                if (lastUserKey !== null) { lastFit = ''; frame(circle.getBounds(), { maxZoom: 15, pad: 14 }); }
            } else if (has && lastUserKey !== null && circleKey !== 'none' && key === lastUserKey) {
                lastFit = '';      // the ring went away and the spot stayed: back to the neighbourhood
                centreOn(L.latLng(u.lat, u.lng), Math.max(Math.min(map.getZoom(), 13), 12));
            }
            circleKey = cKey;
        }
        if (has && !circle && lastUserKey !== null && key !== lastUserKey) centreOn(L.latLng(u.lat, u.lng), Math.max(map.getZoom(), 12));
        lastUserKey = key;
        return want.size;
    }

    /** Fly to a rink's pin and open it (the list's rink names call this). */
    function focusRink(key) {
        if (!map) return false;
        key = String(key);
        lastFit = '';       // the view is about to leave the framed pins
        const m = markersByKey[key];
        const r = (window.SkateGeo?.rinks || []).find(x => String(x.locationid) === key);
        const target = m ? m.getLatLng() : (r && r.lat != null ? L.latLng(r.lat, r.lng) : null);
        if (!target) return false;
        map.invalidateSize();
        const zoom = Math.max(map.getZoom(), 14);
        // Park the pin a little below the middle of what shows, so the popup (which opens above it)
        // fits even on a phone's short map; open it once the fly-in has settled.
        const i = insets();
        const visible = Math.max(0, map.getSize().y - i.top - i.bottom);
        let opened = false;
        const openIt = () => { if (opened || !map || !m) return; opened = true; prepPopup(m); m.openPopup(); };
        map.once('moveend', openIt);
        centreOn(target, zoom, { dy: Math.round(visible * 0.18) });
        setTimeout(openIt, 1200);   // no move happened (already there) → still open it
        return true;
    }

    /** The pins follow the filters and the search without the list being redrawn a second time. */
    function syncPins() { return renderPins(); }

    /**
     * Bring the map up inside #map-canvas (the caller has already shown it). opts: { center:[lat,lng], zoom }
     * Returns after the map is live (or throws if Leaflet can't load).
     */
    async function open(opts = {}) {
        await ensureLeaflet();
        const first = !map;
        initMap();
        map.invalidateSize();   // the canvas was display:none until a moment ago
        const u = hooks.userPoint ? hooks.userPoint() : null;
        const has = !!(u && typeof u.lat === 'number');
        if (opts.center) {
            lastFit = '';
            map.setView(opts.center, opts.zoom || 13);
            lastUserKey = has ? `${u.lat},${u.lng}` : 'none';
            renderPins();
        } else if (first) {
            // The first look: around your spot (its ring whole, if a distance is set), else every rink in view.
            lastUserKey = null;     // the view is set right here: nothing in renderPins flies or frames by itself
            if (has) centreOn(L.latLng(u.lat, u.lng), 12, { animate: false });
            renderPins();
            if (circle) frame(circle.getBounds(), { animate: false, maxZoom: 15, pad: 14 });
            else if (!has) fitPins({ animate: false });
            lastUserKey = has ? `${u.lat},${u.lng}` : 'none';
        } else {
            // Back on the map: it is where it was left. A spot or a distance changed meanwhile moves it (renderPins sees that).
            renderPins();
        }
        requestAnimationFrame(() => map && map.invalidateSize());
        setTimeout(() => map && map.invalidateSize(), 250);   // rAF can be throttled in bg tabs
        if (hooks.onOpen) hooks.onOpen();
    }

    /** Re-render pins in place (e.g. after starring a rink from a popup). */
    function refresh() { if (map) renderPins(true); }

    /** The canvas changed size (the window, the phone turned): Leaflet has to be told. */
    function resize() { if (map) map.invalidateSize(); }
    /** The list moved from under the map to beside it, or back: the ring is put back in the middle of what shows. */
    function reframe() {
        if (!map || !circle) return;
        map.invalidateSize();
        frame(circle.getBounds(), { animate: false, maxZoom: 15, pad: 14 });
    }

    /**
     * Frame the pins currently on the map (v3.10.2: the rink search calls this as
     * its matches change, so typing "scarborough" shows Scarborough, not all of Toronto).
     */
    function fitPins({ animate = true } = {}) {
        if (!map) return false;
        const keys = Object.keys(markersByKey);
        if (!keys.length) return false;
        // the same pins as the last time the map was framed: it is already there (typing more
        // letters of a name that keeps matching the same rinks must not move the map again)
        const sig = keys.sort().join(',');
        if (sig === lastFit) return true;
        lastFit = sig;
        const pts = keys.map(k => markersByKey[k].getLatLng());
        map.invalidateSize();
        // while someone is typing the map jumps (animate: false): a half-second flight redraws
        // the map for thirty frames under the keyboard
        if (pts.length === 1) centreOn(pts[0], Math.max(map.getZoom(), 14), { animate, duration: 0.5 });
        else frame(L.latLngBounds(pts), { animate });
        return true;
    }

    return {
        configure, open, syncPins, refresh, resize, reframe, focusRink, fitPins,
        get ready() { return !!map; },
        get pinCount() { return Object.keys(markersByKey).length; },
        get hasRing() { return !!circle; }
    };
})();

if (typeof module !== 'undefined') module.exports = window.SkateMap;
