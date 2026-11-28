/**
 * SkateWeather — "how should I dress for the rink?" in one glance.
 *
 * Data: Open-Meteo current conditions (free, keyless, CORS-open,
 * CC BY 4.0 attribution — shown in the chip tooltip and Settings).
 * Uses the user's saved 📍 location when set, otherwise central Toronto,
 * so "temperature near you" and "distance to rink" agree with each other.
 *
 * Fetch discipline: 30-min TTL, in-flight dedupe, silent failure (the
 * chip simply doesn't render — weather is a bonus, never a blocker).
 *
 * v3.22, when a request fails (a 429 "too many requests" above all: Open-Meteo
 * counts per IP address, and a campus or a phone carrier shares one):
 *  - the last good reading is kept on the device and shown for up to 3 hours
 *    (its time is in the chip's tooltip once it is more than 45 minutes old);
 *  - the next try waits: what the server asks for (Retry-After), else 2, 5, 15,
 *    then every 30 minutes. No more asking again every minute.
 */
window.SkateWeather = (() => {
    'use strict';

    const API = 'https://api.open-meteo.com/v1/forecast';
    const DEFAULT_SPOT = { lat: 43.7417, lng: -79.3733, label: 'Toronto' };
    const TTL_MS = 30 * 60000;

    // WMO weather codes → glanceable emoji (ranges, first match wins)
    const CODES = [
        [0, 0, '☀️', 'Clear'], [1, 1, '🌤️', 'Mostly clear'], [2, 2, '⛅', 'Partly cloudy'],
        [3, 3, '☁️', 'Overcast'], [45, 48, '🌫️', 'Fog'], [51, 57, '🌦️', 'Drizzle'],
        [61, 67, '🌧️', 'Rain'], [71, 77, '❄️', 'Snow'], [80, 82, '🌦️', 'Showers'],
        [85, 86, '🌨️', 'Snow showers'], [95, 99, '⛈️', 'Thunderstorm']
    ];
    function describe(code) {
        const hit = CODES.find(([a, b]) => code >= a && code <= b);
        return hit ? { emoji: hit[2], text: hit[3] } : { emoji: '🌡️', text: 'Weather' };
    }

    let current = null;      // { temp, feels, code, emoji, text, label, at }
    let lastOkAt = 0;
    let inFlight = null;
    const listeners = [];
    const KEEP_KEY = 'skate_weather_v1';
    const SHOW_FOR_MS = 3 * 3600000;                            // a reading older than this is not shown
    const WAITS_MS = [2, 5, 15, 30].map(m => m * 60000);        // after a failure: 2, 5, 15, then every 30 minutes
    let fails = 0, nextTryAt = 0;
    const spotKey = (s) => `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`;
    const fresh = (c) => !!c && typeof c.temp === 'number' && typeof c.at === 'number' && Date.now() >= c.at && Date.now() - c.at < SHOW_FOR_MS;
    function keep() { try { localStorage.setItem(KEEP_KEY, JSON.stringify({ spot: spotKey(spot()), current })); } catch { /* private mode: nothing kept */ } }
    /** The last good reading for this same spot, if it is recent enough to show. */
    function restore() {
        try {
            const k = JSON.parse(localStorage.getItem(KEEP_KEY) || 'null');
            if (!k || k.spot !== spotKey(spot()) || !fresh(k.current)) return;
            const d = describe(typeof k.current.code === 'number' ? k.current.code : -1);
            current = { temp: Math.round(k.current.temp), feels: Math.round(typeof k.current.feels === 'number' ? k.current.feels : k.current.temp), code: k.current.code ?? null,
                emoji: d.emoji, text: d.text, label: String(k.current.label || spot().label).slice(0, 60), at: k.current.at };
            lastOkAt = current.at;                              // younger than 30 minutes: no request at all
        } catch { /* unreadable: start without it */ }
    }

    function onUpdate(cb) { listeners.push(cb); }

    /** Configured pick-list (SkateConfig.weatherSpots) — tap the chip to choose. */
    function spots() { return (window.SkateConfig?.weatherSpots || []); }

    /** Current selection id: 'auto' (📍 location or Toronto) or a spot id. */
    function selectedId() { return window.SkateSettings?.get('weatherSpot') || 'auto'; }

    function spot() {
        const id = selectedId();
        if (id !== 'auto') {
            const hit = spots().find(x => x.id === id);
            if (hit) return { lat: hit.lat, lng: hit.lng, label: hit.label };
        }
        const user = window.SkateGeo?.getUserLocation?.();
        return user && typeof user.lat === 'number'
            ? { lat: user.lat, lng: user.lng, label: user.label || 'your location' }
            : DEFAULT_SPOT;
    }

    /** Choose a spot ('auto' or a spots() id); persists and refetches. */
    function setSpot(id) {
        window.SkateSettings?.set('weatherSpot', id || 'auto');
        current = null;          // old reading is for another place
        lastOkAt = 0;
        restore();               // unless the kept one is for this very place
        return load(true);
    }

    function load(force = false) {
        if (inFlight) return inFlight;
        if (!force && Date.now() - lastOkAt < TTL_MS) return Promise.resolve();
        // after a failure, wait (a tap on Refresh may try sooner, but not more than three times as fast)
        if (Date.now() < nextTryAt && (!force || nextTryAt - Date.now() > WAITS_MS[0] * 0.66)) return Promise.resolve();

        const s = spot();
        const url = `${API}?latitude=${s.lat.toFixed(4)}&longitude=${s.lng.toFixed(4)}` +
            `&current=temperature_2m,apparent_temperature,weather_code&timezone=America%2FToronto`;
        inFlight = (async () => {
            try {
                const res = await fetch(url);
                if (!res.ok) {
                    const e = new Error(`HTTP ${res.status}`);
                    const ask = Number(res.headers.get('Retry-After'));          // seconds, when the server names its own wait
                    if (res.status === 429 && Number.isFinite(ask) && ask > 0) e.waitMs = Math.min(3600000, Math.max(60000, ask * 1000));
                    throw e;
                }
                const data = await res.json();
                const c = data.current || {};
                if (typeof c.temperature_2m !== 'number') throw new Error('no temperature in response');
                const d = describe(c.weather_code ?? -1);
                current = {
                    temp: Math.round(c.temperature_2m),
                    feels: Math.round(c.apparent_temperature ?? c.temperature_2m),
                    code: c.weather_code ?? null,
                    emoji: d.emoji, text: d.text,
                    label: s.label, at: Date.now()
                };
                lastOkAt = Date.now();
                fails = 0; nextTryAt = 0;
                keep();
                listeners.forEach(cb => { try { cb(current); } catch {} });
            } catch (e) {
                fails++;
                const wait = e.waitMs || WAITS_MS[Math.min(fails, WAITS_MS.length) - 1];
                nextTryAt = Date.now() + wait;
                console.warn(`[SkateWeather] skipped: ${e.message}. Next try in ${Math.round(wait / 60000)} min${current ? '; showing the last reading meanwhile' : ''}.`);
                if (current && !fresh(current)) { current = null; listeners.forEach(cb => { try { cb(null); } catch {} }); }   // too old to show
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    }

    restore();

    return { load, onUpdate, spots, setSpot, selectedId, get current() { return fresh(current) ? current : null; }, get nextTryAt() { return nextTryAt; } };
})();

if (typeof module !== 'undefined') module.exports = window.SkateWeather;
