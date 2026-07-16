/**
 * SkateGeo — the rink map: coordinates, distances, closest-rink lookup.
 *
 * Data: projects/data/rinks.json (built by fetch-skate-data.js from the
 * city's indoor-ice-rinks + outdoor-artificial-ice-rinks datasets, plus
 * the external venues). Every entry has lat/lng.
 *
 * User location comes from either the browser geolocation API or a typed
 * address / postal code geocoded via Nominatim (OpenStreetMap) — a free,
 * CORS-enabled endpoint; we bias results to the Toronto bounding box and
 * fall back to Canada-wide if nothing matches. The chosen point persists
 * in SkateSettings so distances survive reloads.
 */
window.SkateGeo = (() => {
    'use strict';

    const DATA_URL = 'projects/data/rinks.json';
    const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
    // west,south,east,north around the GTA
    const TORONTO_VIEWBOX = '-79.85,43.45,-79.0,43.95';

    let rinks = [];
    let byLocation = {};      // locationid → rink
    let byName = {};          // normalized name → rink (external/program matching)
    let loaded = false;
    const listeners = [];

    /* ---------- loading ---------- */

    async function load() {
        try {
            const res = await fetch(DATA_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            rinks = data.rinks || [];
            byLocation = {};
            byName = {};
            rinks.forEach(r => {
                byLocation[String(r.locationid)] = r;
                byName[normName(r.name)] = r;
            });
            loaded = true;
            listeners.forEach(cb => { try { cb(); } catch {} });
        } catch (e) {
            console.warn('[SkateGeo] could not load rinks.json:', e.message);
            loaded = true;
        }
    }

    function onUpdate(cb) { listeners.push(cb); }

    function normName(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    /* ---------- lookups ---------- */

    function rinkByLocation(locId) {
        return byLocation[String(locId)] || null;
    }

    /** Coordinates for a program: own Lat/Lng (external) → locationid → name match. */
    function coordsForProgram(p) {
        if (typeof p.Lat === 'number' && typeof p.Lng === 'number') return { lat: p.Lat, lng: p.Lng };
        const locId = p['Location ID'];
        if (locId != null && byLocation[String(locId)]) {
            const r = byLocation[String(locId)];
            if (r.lat != null) return { lat: r.lat, lng: r.lng };
        }
        const name = normName(p.LocationName || p['Location Name']);
        if (name && byName[name] && byName[name].lat != null) {
            return { lat: byName[name].lat, lng: byName[name].lng };
        }
        return null;
    }

    /* ---------- distance ---------- */

    /** Haversine, km. */
    function distanceKm(a, b) {
        const R = 6371;
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLng = (b.lng - a.lng) * Math.PI / 180;
        const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    }

    function fmtKm(km) {
        return km < 1 ? `${Math.round(km * 1000)} m` : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
    }

    /* ---------- user location (persisted) ---------- */

    function getUserLocation() {
        return window.SkateSettings ? window.SkateSettings.get('userLoc') : null;
    }

    function setUserLocation(loc) {
        if (window.SkateSettings) window.SkateSettings.set('userLoc', loc); // {lat, lng, label, ts} or null
        listeners.forEach(cb => { try { cb(); } catch {} });
    }

    /** Browser geolocation → {lat,lng,label}. Rejects with a friendly message. */
    function locateMe() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject(new Error('This browser has no location support'));
            navigator.geolocation.getCurrentPosition(
                pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'My location', ts: Date.now() }),
                err => reject(new Error(err.code === 1 ? 'Location permission denied — type an address instead'
                    : 'Could not get your location — type an address instead')),
                { timeout: 12000, maximumAge: 300000 }
            );
        });
    }

    /**
     * Geocode an address / postal code via Nominatim, biased to Toronto.
     * → {lat, lng, label} (label = the place Nominatim actually matched,
     * shown to the user so a bad match is obvious).
     */
    async function geocode(query) {
        const q = String(query || '').trim();
        if (!q) throw new Error('Type an address or postal code first');
        const params = (bounded) =>
            `format=jsonv2&limit=1&countrycodes=ca&addressdetails=0` +
            `&viewbox=${TORONTO_VIEWBOX}${bounded ? '&bounded=1' : ''}&q=${encodeURIComponent(q)}`;
        let hit = null;
        for (const bounded of [true, false]) {
            const res = await fetch(`${NOMINATIM}?${params(bounded)}`, { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error('Geocoding service is busy — try again in a few seconds');
            const arr = await res.json();
            if (arr && arr.length) { hit = arr[0]; break; }
        }
        if (!hit) throw new Error(`Couldn't find "${q}" — try adding a street or city`);
        return {
            lat: parseFloat(hit.lat), lng: parseFloat(hit.lon),
            label: (hit.display_name || q).split(',').slice(0, 3).join(',').trim(),
            ts: Date.now()
        };
    }

    /* ---------- nearest rinks ---------- */

    /** n nearest rinks to a point → [{...rink, km}], sorted. */
    function nearest(point, n = 12) {
        if (!point) return [];
        return rinks
            .filter(r => r.lat != null)
            .map(r => ({ ...r, km: distanceKm(point, { lat: r.lat, lng: r.lng }) }))
            .sort((a, b) => a.km - b.km)
            .slice(0, n);
    }

    /** Distance from the saved user point to a program's venue, km (or null). */
    function distanceForProgram(p) {
        const user = getUserLocation();
        if (!user) return null;
        const c = coordsForProgram(p);
        return c ? distanceKm(user, c) : null;
    }

    return {
        load, onUpdate, rinkByLocation, coordsForProgram, distanceKm, fmtKm,
        getUserLocation, setUserLocation, locateMe, geocode, nearest, distanceForProgram,
        get loaded() { return loaded; },
        get rinks() { return rinks; }
    };
})();

if (typeof module !== 'undefined') module.exports = window.SkateGeo;
