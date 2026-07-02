/**
 * SkateSettings — user preferences, persisted in localStorage.
 *
 *  - timeFormat: '12h' | '24h'  (default 12h; every timestamp in the app goes
 *    through formatClock/formatTime so the toggle applies everywhere at once)
 *  - experience: 'new' | 'regular' | null (drives tab order + default filters)
 *  - displayName: chat name (replaces the random-every-session name)
 */
const SkateSettings = (() => {
    'use strict';

    const KEY = 'skate_settings_v1';
    const defaults = { timeFormat: '12h', experience: null, displayName: null };
    let settings = { ...defaults };
    const cbs = [];

    function load() {
        try {
            const raw = localStorage.getItem(KEY);
            if (raw) settings = { ...defaults, ...JSON.parse(raw) };
        } catch {}
        return settings;
    }

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
        cbs.forEach(cb => { try { cb(settings); } catch {} });
    }

    function get(k) { return k ? settings[k] : { ...settings }; }
    function set(k, v) { settings[k] = v; save(); }
    function onChange(cb) { cbs.push(cb); }

    /** "14:30" or "2:30 PM" from an "HH:MM" string (program times). */
    function formatClock(hhmm) {
        if (!hhmm || !hhmm.includes(':')) return hhmm || '';
        if (settings.timeFormat === '24h') return hhmm;
        const [h, m] = hhmm.split(':').map(Number);
        const suffix = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
    }

    /** Chat timestamp from epoch ms, respecting the 12/24h preference. */
    function formatTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString('en-CA', {
            hour: settings.timeFormat === '24h' ? '2-digit' : 'numeric',
            minute: '2-digit',
            hour12: settings.timeFormat !== '24h'
        });
    }

    /** "today 2:30 PM" / "Jun 12, 2:30 PM" for message headers. */
    function formatWhen(ts) {
        const d = new Date(ts), now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        const time = formatTime(ts);
        if (sameDay) return time;
        return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ', ' + time;
    }

    load();
    return { load, get, set, onChange, formatClock, formatTime, formatWhen };
})();

if (typeof module !== 'undefined') module.exports = SkateSettings;
