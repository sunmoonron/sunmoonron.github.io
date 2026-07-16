/**
 * SkateTime — every program time on this site is Toronto wall-clock time.
 *
 * Problem this solves: the old code compared program times against the
 * DEVICE clock's local timezone. On a phone set to any other zone (or a
 * traveller checking schedules), "Starting Soon", the past-event filter
 * and the ordering all drifted. These helpers pin all math to
 * America/Toronto, DST-safe, regardless of device settings.
 *
 * Key ideas:
 *  - epoch('2026-07-16','13:00') → the real UTC ms when a Toronto clock
 *    shows that time (offset derived per-date via Intl, so DST "just works").
 *  - status(program) → phase + minute counts that power the
 *    "Starts in 25m" / "On now · 40m left" / "Ended" chips.
 *
 * Fallback: browsers without IANA-zone Intl support (ancient) silently
 * degrade to device-local math — same behaviour as before this module.
 */
window.SkateTime = (() => {
    'use strict';

    const TZ = 'America/Toronto';

    // Feature-detect timezone support once.
    let zoned = true;
    try {
        new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
    } catch {
        zoned = false;
    }

    const offsetFmt = zoned ? new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, timeZoneName: 'longOffset',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }) : null;

    const partsFmt = zoned ? new Intl.DateTimeFormat('en-CA', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }) : null;

    /** Toronto UTC offset in minutes (e.g. -240 in summer) at a given instant. */
    function offsetMinutes(date) {
        if (!zoned) return -date.getTimezoneOffset();
        const tzPart = offsetFmt.formatToParts(date).find(p => p.type === 'timeZoneName');
        const m = /GMT([+-])(\d{2}):(\d{2})/.exec(tzPart ? tzPart.value : '');
        if (!m) return -300; // never in practice; EST fallback
        const sign = m[1] === '-' ? -1 : 1;
        return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
    }

    // date+time → epoch is pure; memoize (called per program per render tick)
    const epochCache = new Map();

    /**
     * Real epoch ms for a Toronto wall-clock date+time.
     * dateStr 'YYYY-MM-DD' (leading match tolerated), timeStr 'HH:MM'.
     * Returns null if the date is unparseable.
     */
    function epoch(dateStr, timeStr) {
        const cacheKey = `${dateStr}|${timeStr}`;
        if (epochCache.has(cacheKey)) return epochCache.get(cacheKey);
        const v = epochUncached(dateStr, timeStr);
        if (epochCache.size < 5000) epochCache.set(cacheKey, v);
        return v;
    }

    function epochUncached(dateStr, timeStr) {
        const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
        if (!dm) return null;
        const tm = /^(\d{1,2}):(\d{2})/.exec(String(timeStr || '')) || [null, '0', '0'];
        const [y, mo, d] = [+dm[1], +dm[2], +dm[3]];
        const [hh, mm] = [+tm[1], +tm[2]];
        if (!zoned) return new Date(y, mo - 1, d, hh, mm).getTime();

        // Guess assuming UTC, correct by the offset in effect at that moment.
        // Second pass handles the rare guess-lands-across-a-DST-jump case.
        const guess = Date.UTC(y, mo - 1, d, hh, mm);
        let off = offsetMinutes(new Date(guess));
        let result = guess - off * 60000;
        const off2 = offsetMinutes(new Date(result));
        if (off2 !== off) result = guess - off2 * 60000;
        return result;
    }

    /** Current Toronto wall-clock as {y,m,d,hh,mm} numbers. */
    function nowParts() {
        const now = new Date();
        if (!zoned) {
            return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate(), hh: now.getHours(), mm: now.getMinutes() };
        }
        const p = {};
        partsFmt.formatToParts(now).forEach(x => { p[x.type] = x.value; });
        return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute };
    }

    /** Today in Toronto as 'YYYY-MM-DD'. */
    function todayKey() {
        const p = nowParts();
        return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    }

    /** 'YYYY-MM-DD' + n days (pure date math, no TZ involvement). */
    function addDays(dateKey, n) {
        const [y, m, d] = dateKey.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    }

    /** 0=Monday … 6=Sunday for a 'YYYY-MM-DD' (calendar weeks start Monday). */
    function mondayIndex(dateKey) {
        const [y, m, d] = dateKey.split('-').map(Number);
        return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    }

    /** Program field access mirrors app.js's P helpers (kept dependency-free). */
    function fields(p) {
        return {
            date: p['Start Date Time'] || p['Start Date'] || '',
            start: p['Start Time'] || '',
            end: p['End Time'] || ''
        };
    }

    /**
     * Live status of a program relative to *Toronto* now.
     * → { phase: 'undated'|'upcoming'|'soon'|'live'|'ended',
     *     minsToStart, minsLeft, startEpoch, endEpoch }
     * Programs without an end time get a 1-hour assumed duration
     * (same assumption the .ics export has always made).
     */
    function status(p, nowMs = Date.now()) {
        const f = fields(p);
        const startEpoch = epoch(f.date, f.start);
        if (startEpoch === null) return { phase: 'undated', minsToStart: null, minsLeft: null, startEpoch: null, endEpoch: null };

        let endEpoch = f.end ? epoch(f.date, f.end) : null;
        if (endEpoch === null || endEpoch <= startEpoch) {
            // missing/garbled end, or a session crossing midnight
            endEpoch = (endEpoch !== null && endEpoch <= startEpoch)
                ? endEpoch + 24 * 3600000
                : startEpoch + 3600000;
        }

        const minsToStart = Math.round((startEpoch - nowMs) / 60000);
        const minsLeft = Math.round((endEpoch - nowMs) / 60000);
        let phase;
        if (nowMs < startEpoch) phase = minsToStart <= 120 ? 'soon' : 'upcoming';
        else if (nowMs <= endEpoch) phase = 'live';
        else phase = 'ended';
        return { phase, minsToStart, minsLeft, startEpoch, endEpoch };
    }

    /** Sort key: undated events sink to the bottom, everything else by real start. */
    function sortEpoch(p) {
        const f = fields(p);
        const e = epoch(f.date, f.start);
        return e === null ? Number.MAX_SAFE_INTEGER : e;
    }

    /** "25m" / "1h 05m" — compact minutes for the status chips. */
    function fmtMins(mins) {
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60), m = mins % 60;
        return m ? `${h}h ${String(m).padStart(2, '0')}m` : `${h}h`;
    }

    return { TZ, zoned, epoch, nowParts, todayKey, addDays, mondayIndex, status, sortEpoch, fmtMins, offsetMinutes };
})();

if (typeof module !== 'undefined') module.exports = window.SkateTime;
