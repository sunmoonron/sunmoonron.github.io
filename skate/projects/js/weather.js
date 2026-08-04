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

    function onUpdate(cb) { listeners.push(cb); }

    function spot() {
        const user = window.SkateGeo?.getUserLocation?.();
        return user && typeof user.lat === 'number'
            ? { lat: user.lat, lng: user.lng, label: user.label || 'your location' }
            : DEFAULT_SPOT;
    }

    function load(force = false) {
        if (inFlight) return inFlight;
        if (!force && Date.now() - lastOkAt < TTL_MS) return Promise.resolve();

        const s = spot();
        const url = `${API}?latitude=${s.lat.toFixed(4)}&longitude=${s.lng.toFixed(4)}` +
            `&current=temperature_2m,apparent_temperature,weather_code&timezone=America%2FToronto`;
        inFlight = (async () => {
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
                listeners.forEach(cb => { try { cb(current); } catch {} });
            } catch (e) {
                console.warn('[SkateWeather] skipped:', e.message);
            } finally {
                inFlight = null;
            }
        })();
        return inFlight;
    }

    return { load, onUpdate, get current() { return current; } };
})();

if (typeof module !== 'undefined') module.exports = window.SkateWeather;
