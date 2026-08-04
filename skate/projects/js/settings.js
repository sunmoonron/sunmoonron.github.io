/**
 * SkateSettings — user preferences, persisted in localStorage.
 *
 *  - timeFormat: '12h' | '24h'  (default 12h; every timestamp in the app goes
 *    through formatClock/formatTime so the toggle applies everywhere at once)
 *  - experience: 'new' | 'regular' | null (drives default filters; asked
 *    lazily the first time someone chats/writes, never as a startup popup)
 *  - displayName: chat name (replaces the random-every-session name)
 *  - paidVisible: show paid/private venues (hidden by default)
 *  - rinkScope: 'all' | 'mine'   + myRinks: [locationKey,…] (personalization)
 *  - sort: 'time' | 'near'      (near requires userLoc)
 *  - calMode: list ↔ week-calendar toggle for the programs panel
 *  - userLoc: {lat,lng,label,ts} from the 📍 locator (null = unset)
 *  - lastSeenVersion: for the 🆕 what's-new dot
 *  - showGuides / showChats: section visibility (Settings → Sections)
 *  - setupDone: the one-time first-visit setup screen has been handled
 */
const SkateSettings = (() => {
    'use strict';

    const KEY = 'skate_settings_v1';
    const defaults = {
        timeFormat: '12h', experience: null, displayName: null,
        paidVisible: false, rinkScope: 'all', myRinks: [],
        sort: 'time', calMode: false, userLoc: null, lastSeenVersion: null,
        // section visibility (⚙️ Settings → Sections; first-visit setup screen)
        showGuides: true, showChats: true, setupDone: false,
        // 'system' | 'light' | 'dark' — null migrates from the old
        // standalone `darkMode` localStorage key on first read; default
        // is 'system' (Auto follows the device).
        theme: null,
        // v3.0: community privacy + one-time tour flag
        invisible: false,      // 👻 skip presence pings (never listed as online)
        dmsAllowed: true,      // ✉️ incoming DMs accepted on this device
        tourDone: false
    };
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

// Expose on window like the other modules — `const` alone doesn't attach to
// window, which left every `window.SkateSettings?.…` caller silently no-oping
// (geo persistence, chat display-name preference).
if (typeof window !== 'undefined') window.SkateSettings = SkateSettings;
if (typeof module !== 'undefined') module.exports = SkateSettings;
