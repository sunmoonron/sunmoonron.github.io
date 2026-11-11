/**
 * SkateAlerts — toronto.ca service alerts, matched to programs.
 *
 * Data: projects/data/alerts.json — a pipeline snapshot of
 * https://www.toronto.ca/data/parks/live/skate_allupdates.json plus each
 * rink location's own notice feed (toronto.ca sends no CORS headers, so the
 * browser can't hit it live; the pipeline re-snapshots it every ~10 min).
 *
 * How a banner is decided (v3.10):
 *
 *  1. Every alert gets a READING: what it means for skating at that
 *     location ('off' / 'one_pad_off' / 'reduced' / 'on' / unknown), the
 *     days it covers, an optional part-of-day window, and whether it is a
 *     "closed for the season" notice.
 *       - The pipeline has a model read each alert with real sentences once,
 *         checks the answer against the alert's own words, and ships it
 *         inside alerts.json as `Read`. Staff write these by hand, and word
 *         rules kept misreading them (the washroom notice that named a room
 *         "Upper Ice Galaxy", "Arenas both are closed", 2026-11-11).
 *       - When there is no `Read` (no sentences, reader offline, older data
 *         file), the word rules below produce the same shape. They are the
 *         floor, never removed.
 *
 *  2. One function turns the readings at a location plus the session (date,
 *     time, the rink's indoor/outdoor kinds and pad count) into the banner:
 *       closed  — skating is off there on that day, for every kind of ice
 *                 the location has
 *       warning — one pad of several, part of the location, reduced hours,
 *                 or an alert nobody could classify
 *       note    — good to know, not about this session: a building notice,
 *                 an alert for other hours, one that ended in the last four
 *                 days, or last season's closure notice
 *
 *  Standing rules:
 *   - An alert is never dropped for being old. Only its own words end it
 *     ("re-opening on Sep 28", "today", a dated closure). "Closed until
 *     further notice" stays in force for months if the City leaves it up.
 *   - A "closed for the season" notice closes the season it was posted in.
 *     The City leaves those up all summer and lifts each one when the rink
 *     reopens, so for a session in a LATER season it only says the rink has
 *     not reopened yet: a grey note, yellow on the day itself. (Before
 *     2026-11, the previous March's notices struck through every session of
 *     the new outdoor season the moment the City published it.)
 *   - Status 0 on a rink asset is the City's own closed flag; no reading
 *     talks it down to "skating as usual".
 *   - The full alert text is always shown so the human makes the final call.
 */
window.SkateAlerts = (() => {
    'use strict';

    const DATA_URL = 'projects/data/alerts.json';
    // v3.1: the pipeline's cross-check of city sessions against toronto.ca's
    // live per-location schedules (the Malvern lesson — the weekly open-data
    // export kept listing a session the City had dropped). Flags are keyed
    // "<LocationID>|<date>|<start>|<normalized title>".
    const LIVE_URL = 'projects/data/live-check.json';
    const dataUrl = (file, bust) => (window.SkateAPI?.dataUrl ? SkateAPI.dataUrl(file, bust) : `${file}?t=${bust}`);

    let byLocation = {};   // locationid(string) → [alert, …]  (skate alerts only)
    let fetchedAt = null;  // when alert CONTENT last changed (CI stamp)
    let checkedAt = null;  // when the CI checker last confirmed the feed (heartbeat)
    let reader = null;     // how the pipeline read the alerts: { by, read, rules, waiting, error }
    let loaded = false;
    let liveFlags = {};    // key → { s:'missing'|'cancelled', t:title, n?:note }
    let liveExtra = [];    // live-only sessions the export lacks (informational)
    let liveCheckedAt = null, liveChangedAt = null, liveWindow = null, liveStats = null;
    let lastOkAt = 0;      // client-side: last successful fetch of alerts.json
    let inFlight = null;
    const listeners = [];

    // Auto-refresh cadence. Alerts are the travel-safety data: the Aug 4
    // Centennial trip happened because clients loaded alerts once and never
    // again. This TTL + the app's ticker/resume hooks keep every open page
    // (tab, phone, installed PWA) within ~5 min of the deployed snapshot.
    // Only GitHub Pages is hit — toronto.ca never sees browsers.
    const TTL_MS = 4.5 * 60000;
    const FORCE_MIN_GAP_MS = 60000;   // even "force" won't spam more than 1/min

    /* ---------- loading ---------- */

    function load(force = false) {
        if (inFlight) return inFlight;
        const since = Date.now() - lastOkAt;
        if (force && since < FORCE_MIN_GAP_MS) force = false;
        if (!force && since < TTL_MS) return Promise.resolve();

        // 5-min URL bucket rides through GH Pages' max-age=600 CDN cache;
        // force uses a unique key so "user just woke the phone" is current.
        const bust = force ? Date.now() : Math.floor(Date.now() / 300000);
        inFlight = (async () => {
            // Both snapshots ride the same TTL/ticker; the live check is a
            // bonus layer — its failure never blocks the alert feed.
            const liveJob = (async () => {
                try {
                    const res = await fetch(dataUrl(LIVE_URL, bust));
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    liveFlags = data.flags || {};
                    liveExtra = Array.isArray(data.extra) ? data.extra : [];
                    liveCheckedAt = data.checkedAt || null;
                    liveChangedAt = data.changedAt || null;
                    liveWindow = data.window || null;
                    liveStats = data.stats || null;
                } catch (e) {
                    console.warn('[SkateAlerts] live-check.json unavailable:', e.message);
                }
            })();
            try {
                const res = await fetch(dataUrl(DATA_URL, bust));
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                index(data.alerts || []);
                fetchedAt = data.fetchedAt || null;
                checkedAt = data.checkedAt || data.fetchedAt || null;
                reader = data.reader || null;
                lastOkAt = Date.now();
            } catch (e) {
                console.warn('[SkateAlerts] could not load alerts.json:', e.message);
            }
            await liveJob;
            loaded = true; // don't block rendering — site just shows no alerts
            listeners.forEach(cb => { try { cb(); } catch {} });
            inFlight = null;
        })();
        return inFlight;
    }

    /* ---------- live schedule cross-check ---------- */

    const normTitle = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

    /** Live-check flag for a city program, or null (ok / not a city row / unchecked). */
    function liveFor(p) {
        if (!p || (p.Source && p.Source !== 'city')) return null;
        const locId = p['Location ID'];
        if (locId == null) return null;
        const date = (p['Start Date Time'] || p['Start Date'] || '').slice(0, 10);
        const key = `${locId}|${date}|${p['Start Time'] || ''}|${normTitle(p['Course Title'] || p.Activity || p['Activity Title'])}`;
        const f = liveFlags[key];
        if (!f) return null;
        return { status: f.s, title: f.t, note: f.n || '', checkedAt: liveCheckedAt };
    }

    /** True when the City's live schedule no longer lists this session. */
    function isDropped(p) {
        const f = liveFor(p);
        return !!f && (f.status === 'missing' || f.status === 'cancelled');
    }

    /**
     * Is this alert about skating? The city's taxonomy drifts between
     * feeds ("Skate" in the aggregate we snapshot, "Indoor Ice Rink" in
     * the per-location feed, DisplayAlertName "Skate" in both) — match
     * on ANY of them so a feed-side rename can't silently blind us again.
     */
    function isSkateAlert(a) {
        if (a.Scope === 'facility') return true;   // the building's own notice (pipeline-tagged)
        const cat = `${a.Category || ''} ${a.Type || ''}`.toLowerCase();
        return (a.DisplayAlertName || '') === 'Skate' ||
               /skat|rink|\bice\b/.test(cat);
    }

    function index(alerts) {
        byLocation = {};
        alerts.forEach(a => {
            if (!a || a.LocationID == null) return;
            if (!isSkateAlert(a)) return;
            (byLocation[String(a.LocationID)] ||= []).push(a);
        });
    }

    function onUpdate(cb) { listeners.push(cb); }

    /* ---------- small helpers ---------- */

    const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
    const isHm = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
    const pad2 = (n) => String(n).padStart(2, '0');
    const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
    const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
    const fmtDay = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', ...(ymd.slice(0, 4) !== String(new Date().getFullYear()) ? { year: 'numeric' } : {}) });
    const minsOf = (hm) => { const m = /^(\d{1,2}):(\d{2})/.exec(hm || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    /** The day the alert was posted ('YYYY-MM-DD'), or null. */
    const postedDay = (a) => { const d = String(a.PostedDate || '').slice(0, 10); return isYmd(d) ? d : null; };
    /** Today in Toronto (the app's clock when it is loaded, the device's otherwise). */
    const todayKey = () => (window.SkateTime && window.SkateTime.todayKey ? window.SkateTime.todayKey()
        : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }));

    function cleanComment(s) {
        return String(s || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** 'indoor' | 'outdoor' | 'any' from the alert's asset Type/name. */
    function alertKind(a) {
        if (a.Scope === 'facility') return 'any';   // the whole building, every pad
        const t = `${a.Type || ''} ${a.AssetName || ''}`.toLowerCase();
        if (t.includes('outdoor')) return 'outdoor';
        if (t.includes('indoor')) return 'indoor';
        return 'any';
    }

    /* ---------- seasons ---------- */

    /** An ice season runs July to June: 2026 is the winter of 2026-27. */
    const seasonOf = (ymd) => { const y = +ymd.slice(0, 4), m = +ymd.slice(5, 7); return m >= 7 ? y : y - 1; };
    const SEASON_RE = /for the (?:remainder of the |rest of the )?season|season(?:al)? clos|closed for (?:the )?(?:winter|summer|year)/i;
    const REST_OF_SEASON_RE = /(?:remainder|rest) of the season/i;

    /**
     * The season a "closed for the season" notice closed.
     *
     * Posted while ice is in: that season. Posted in the lull before the
     * ice comes back, it is the off-season status of the season that already
     * ended (the City re-stamps these in the fall; a batch was re-posted on
     * 2026-09-16). The lull runs from July 1 to December 1 for outdoor rinks
     * (none has opened before the last week of November) and to September 1
     * for indoor ice. A notice that says "remainder of the season" is about
     * the season in progress whenever it was posted.
     *
     * Calendar months only, so this holds every year without upkeep.
     */
    function noticeSeason(a) {
        const posted = postedDay(a);
        if (!posted) return null;
        const s = seasonOf(posted);
        if (REST_OF_SEASON_RE.test(`${a.Reason || ''} ${a.Comments || ''}`)) return s;
        const md = posted.slice(5);
        const lullEnd = alertKind(a) === 'outdoor' ? '12-01' : '09-01';
        return (md >= '07-01' && md < lullEnd) ? s - 1 : s;
    }
    /** Is this session in a later season than the one the notice closed? */
    function laterSeason(a, programDate) {
        const s = noticeSeason(a);
        return s != null && isYmd(programDate) && seasonOf(programDate) > s;
    }
    /** No outdoor rink in Toronto has ice between mid-April and mid-November. */
    const inOutdoorLull = (ymd) => { const md = ymd.slice(5); return md >= '04-15' && md <= '11-14'; };

    /* ---------- reading an alert with word rules (the floor) ---------- */

    const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    // "(?!\d)" after the day: "November 2025" is a month and a year, not November 20.
    const DATE_SRC = '\\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4})(?!\\d))?';
    const WEEKDAY_SRC = '(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\\s+)?';
    const REOPEN_BEFORE_RE = new RegExp('(?:re-?open\\w*|open(?:s|ing)? again|back open|resum\\w*|delayed opening|(?:will|to) open|opens|opening (?:day|date))\\b[^.;]*$', 'i');
    const STAYS_OPEN_RE = /(?:remain\w*|stay\w*) open\b[^.;]*$|open until\s*$/i;
    const UNTIL_BEFORE_RE = new RegExp('(?:until|till|through|thru|up to)\\s+(?:and including\\s+)?(?:the\\s+)?' + WEEKDAY_SRC + '$', 'i');

    /**
     * The days an alert's own words cover, relative to the day it was posted:
     * { starts, ends } as 'YYYY-MM-DD' or null. `ends` null = no end stated.
     *   "from Monday, June 8 ... to June 15, 2026", "until July 20",
     *   "for the week of Monday, June 8", "closed November 4",
     *   "anticipate re-opening on Monday, September 28" (ends the day before),
     *   "delayed opening of Friday October 16" (same),
     *   "cancelled today", "re-opening tomorrow morning".
     */
    function datesIn(text, posted) {
        const t = String(text || '');
        const refYear = posted ? +posted.slice(0, 4) : new Date().getFullYear();
        const re = new RegExp(DATE_SRC, 'gi');
        const found = [];
        let m;
        while ((m = re.exec(t))) {
            const mo = MONTH_NUM[m[1].slice(0, 3).toLowerCase()], d = +m[2];
            if (!mo || d < 1 || d > 31) continue;
            let y = m[3] ? +m[3] : refYear;
            let key = `${y}-${pad2(mo)}-${pad2(d)}`;
            // no year given and it lands months before the posting: it means next year ("closed until January 3", posted in December)
            if (!m[3] && posted && daysBetween(key, posted) > 90) key = `${++y}-${pad2(mo)}-${pad2(d)}`;
            let before = t.slice(Math.max(0, m.index - 70), m.index);
            before = before.slice(before.lastIndexOf('. ') + 1);   // stay inside the sentence
            const role = REOPEN_BEFORE_RE.test(before) && !STAYS_OPEN_RE.test(before) ? 'reopen'
                : UNTIL_BEFORE_RE.test(before) ? 'until' : 'day';
            found.push({ key, role });
        }
        let starts = null, ends = null;
        if (found.length) {
            const reopen = found.filter(f => f.role === 'reopen').map(f => f.key).sort()[0];
            const until = found.filter(f => f.role === 'until').map(f => f.key).sort().pop();
            const days = found.filter(f => f.role === 'day').map(f => f.key).sort();
            if (reopen) {
                ends = addDays(reopen, -1);
                starts = days.filter(k => k < reopen)[0] || null;
            } else if (until) {
                ends = until;
                starts = days.filter(k => k <= until)[0] || null;
            } else if (/week of/i.test(t)) {
                starts = days[0]; ends = addDays(days[0], 6);
            } else {
                starts = days[0]; ends = days[days.length - 1];
            }
            if (starts && ends && ends < starts) starts = null;
            return { starts, ends };
        }
        if (!posted) return { starts: null, ends: null };
        const low = t.toLowerCase();
        if (/\b(?:re-?open\w*|resum\w*|open again|back open)\b[^.;]*\btomorrow\b/.test(low)) return { starts: null, ends: posted };
        if (/\btoday\b|\btonight\b|\bthis (?:morning|afternoon|evening)\b/.test(low)) return { starts: posted, ends: posted };
        if (/\btomorrow\b/.test(low)) return { starts: addDays(posted, 1), ends: addDays(posted, 1) };
        return { starts: null, ends: null };
    }

    /** Legacy shape for callers and tests: [{from, to}] windows found in the text. */
    function dateWindows(text, ref) {
        const posted = isYmd(ref) ? ref : `${ref || new Date().getFullYear()}-01-01`;
        const d = datesIn(text, posted);
        const dated = new RegExp(DATE_SRC, 'i').test(String(text || ''));
        return dated && (d.starts || d.ends) ? [{ from: d.starts, to: d.ends }] : [];
    }

    // A sentence that takes something away: closed, cancelled, out of service, not open yet.
    const CLOSE_RE = /\b(?:closed|closures?|cancel+ed|cancel+ations?|unavailable|not available|out of service|out of order|not operational|not working|no ice|will not open|not yet open|delayed opening|opening (?:is|has been|will be) delayed|shut ?down)\b/i;
    const NOT_CLOSED_RE = /\bnot (?:be |been |expected to be |currently |yet )?(?:closed|cancel+ed)\b|\bno (?:closures?|cancel+ations?)\b/i;
    // The ice itself. A bare "ice" is not enough: rooms get names like "Upper Ice Galaxy".
    // "Arena" counts unless it is only naming where an amenity is ("Habitant Arena parking lot").
    const ICE_RE = /\b(?:rinks?|ice (?:pads?|surfaces?|rinks?|plant)|the ice|skat\w*|shinny|hockey|zamboni)\b|\barenas?\b(?!\s+(?:parking|lobby|washrooms?|change|locker|elevator|lot|viewing)\b)/i;
    const AMENITY_RE = /\b(?:parking|washrooms?|restrooms?|bathrooms?|change ?rooms?|locker ?rooms?|showers?|saunas?|lobby|elevators?|lift|pools?|gym(?:nasium)?|fitness|weight room|viewing|heaters?|hot water|concessions?|snack bar|vending|table tennis|pickleball|fields?|courts?|track|playground|splash pad|library|daycare|camps?|wi-?fi)\b/i;
    const REDUCED_RE = /\b(?:reduc(?:ed|tion)|limited|modified|shortened|fewer)\b[^.]*\b(?:hours?|schedules?|programming|programs?|sessions?|skat\w*)\b|\b(?:hours?|schedules?|programming|sessions?)\b[^.]*\b(?:reduc(?:ed|tion)|limited|modified|shortened)\b|\bclos(?:e|es|ing) early\b|\bearly clos/i;

    /**
     * Does the sentence single out ONE pad of a multi-pad building?
     * "Rink 1", "Pad B", "the north rink", "rink #2" → that pad only.
     * "both rinks", "all ice", "the arena/facility/building is closed" → no.
     */
    const PAD_RE = /\b(?:rink|pad|ice\s*pad|ice\s*surface|arena)\s*(?:#\s*)?(?:[0-9]{1,2}|[a-d]|one|two|three|north|south|east|west|main|upper|lower|small|big|large|olympic|nhl)\b|\b(?:north|south|east|west|main|upper|lower|small|big|large|olympic|nhl)\s+(?:rink|pad|ice)\b/i;
    const WHOLE_RE = /\b(?:both|all)\s+(?:rinks|pads|ice)|\b(?:rinks|pads|arenas)\s+(?:both|all)\b|\b(?:arena|facility|building|centre|center|complex)\s+(?:is|will be|remains)?\s*(?:closed|closing)|\bentire\b|\bwhole\b|\bno ice\b/i;

    /** Split staff prose into sentences ("St." and "a.m." do not end one). */
    function sentences(text) {
        const out = [];
        const re = /[.!?]+(?=\s+[A-Z(]|\s*$)/g;
        let start = 0, m;
        while ((m = re.exec(text))) {
            const end = m.index + m[0].length;
            const piece = text.slice(start, end);
            if (/\b(?:st|dr|ave|rd|blvd|mr|mrs|ms|no|approx|a\.m|p\.m)\.$/i.test(piece)) continue;
            out.push(piece.trim());
            start = end;
        }
        const tail = text.slice(start).trim();
        if (tail) out.push(tail);
        return out.filter(Boolean);
    }

    /**
     * What the words say, sentence by sentence. A closure counts for the ice
     * unless the sentence is plainly about an amenity; one that names a single
     * pad of several stays a pad closure; "hours are reduced" is not a closure.
     * `skating` is null when the rules cannot tell (shown as a plain alert).
     */
    function ruleReading(a, pads) {
        const comments = cleanComment(a.Comments);
        const reason = String(a.Reason || '');
        // Status 0 on an asset is the City's own closed flag. A building notice
        // (Scope 'facility') carries the same field loosely, so its words decide.
        const cityClosed = a.Scope !== 'facility' && String(a.Status) === '0';
        let whole = false, pad = false, reduced = false, amenity = false;
        for (const s of sentences(comments)) {
            if (REDUCED_RE.test(s)) reduced = true;
            if (!CLOSE_RE.test(s) || NOT_CLOSED_RE.test(s)) continue;
            if (AMENITY_RE.test(s) && !ICE_RE.test(s)) { amenity = true; continue; }
            if (pads > 1 && PAD_RE.test(s) && !WHOLE_RE.test(s)) pad = true; else whole = true;
        }
        const skating = whole ? 'off' : pad ? 'one_pad_off' : cityClosed ? 'off' : reduced ? 'reduced' : amenity ? 'on' : null;
        const d = datesIn(comments, postedDay(a));
        return {
            skating, about: skating === 'on' ? 'amenity' : 'ice',
            starts: d.starts, ends: d.ends, timeFrom: null, timeTo: null,
            seasonal: SEASON_RE.test(`${reason} ${comments}`),
            by: 'rules'
        };
    }

    /* ---------- the pipeline's reading ---------- */

    const READ_VERSION = 1;   // the pipeline's READER_VERSION; another version is ignored, not guessed at
    const SKATING = ['off', 'one_pad_off', 'reduced', 'on'];

    function modelReading(a) {
        const r = a && a.Read;
        if (!r || r.v !== READ_VERSION || !SKATING.includes(r.skating)) return null;
        return {
            skating: r.skating, about: r.about || 'other',
            starts: isYmd(r.starts) ? r.starts : null, ends: isYmd(r.ends) ? r.ends : null,
            timeFrom: isHm(r.timeFrom) ? r.timeFrom : null, timeTo: isHm(r.timeTo) ? r.timeTo : null,
            seasonal: !!r.seasonal, by: r.by || 'model', ruleDates: r.dates === 'rules'
        };
    }

    const memo = new WeakMap();
    /** The reading used for an alert: the pipeline's when it shipped one, the word rules otherwise. */
    function readingFor(a, pads) {
        let per = memo.get(a);
        if (!per) memo.set(a, per = {});
        const k = pads > 1 ? 'multi' : 'single';
        if (per[k]) return per[k];
        const rule = ruleReading(a, pads);
        const model = modelReading(a);
        let R = rule;
        if (model) {
            R = model;
            if (R.ruleDates) { R.starts = rule.starts; R.ends = rule.ends; }   // a reader whose dates are not trusted
            if (R.skating === 'one_pad_off' && !(pads > 1)) R.skating = 'off'; // one pad of one is the rink
            // the City's own closed flag on a rink asset is never talked down to "skating as usual"
            if (R.skating === 'on' && a.Scope !== 'facility' && String(a.Status) === '0') R = rule;
        }
        return (per[k] = R);
    }

    /* ---------- one alert against one session ---------- */

    /**
     * Where the session falls against the alert's own window:
     * 'before' it starts, 'active', 'outside' its hours on a covered day,
     * or 'ended' (with the last day it covered).
     */
    function phaseOf(R, a, programDate, p) {
        if (!isYmd(programDate)) return { phase: 'active' };
        const start = R.starts || postedDay(a);
        if (start && programDate < start) return { phase: 'before' };
        if (R.ends && programDate > R.ends) return { phase: 'ended', ended: R.ends };
        // "closed until 2 pm today", "the 11:30 to 1:30 skate is cancelled": only that part of a single day
        if ((R.timeFrom || R.timeTo) && R.ends && (R.starts || start) === R.ends) {
            const ps = minsOf(p['Start Time']);
            if (ps != null) {
                const pe = minsOf(p['End Time']);
                const end = pe != null && pe > ps ? pe : ps + 1;
                const from = R.timeFrom ? minsOf(R.timeFrom) : 0, to = R.timeTo ? minsOf(R.timeTo) : 1440;
                if (end <= from || ps >= to) return { phase: 'outside' };
            }
        }
        return { phase: 'active' };
    }

    /**
     * Does the set of closed kinds cover every pad kind at this location?
     * Unknown location (not in rinks.json — e.g. a community centre whose
     * programs run in a gym while its outdoor pad hibernates): a single-kind
     * closure must NOT hard-cancel; only a total closure ('any', or both
     * kinds) does. Real-world case: "Outdoor rink closed for the season"
     * at a location hosting summer ball hockey indoors.
     */
    function coversLocation(closedKinds, locationKinds) {
        if (closedKinds.includes('any')) return true;
        if (!locationKinds || !locationKinds.length) {
            return closedKinds.includes('indoor') && closedKinds.includes('outdoor');
        }
        return locationKinds.every(k => closedKinds.includes(k));
    }

    /** The kinds of ice a session on this date can be on: outdoor pads have none from mid-April to mid-November. */
    function kindsOn(locationKinds, programDate) {
        if (!locationKinds || locationKinds.length < 2 || !isYmd(programDate) || !inOutdoorLull(programDate)) return locationKinds;
        const indoor = locationKinds.filter(k => k !== 'outdoor');
        return indoor.length ? indoor : locationKinds;
    }

    const lineFor = (a) => {
        const what = cleanComment(a.Comments) || a.Reason || '';
        // Lead with the asset name so "outdoor pad closed" can't read as
        // "this indoor session is closed" — the reader sees which pad.
        return a.AssetName ? `${a.AssetName}: ${what}` : what;
    };

    /**
     * Alert verdict for one program.
     * → null (nothing to say) or
     *   { level: 'closed'|'warning'|'note', kind, lead, reason, text, padOnly, postedDate, alerts:[…] }
     * `lead` is the bold opening of the banner; `kind` names the rule that fired.
     */
    function forProgram(p) {
        const locId = p['Location ID'] != null ? String(p['Location ID']) : null;
        if (!locId) return null;
        const alerts = byLocation[locId] || [];

        // Live-schedule verdict outranks everything: the City itself no
        // longer lists this session (Malvern, 2026-09-14) or cancelled it.
        const live = liveFor(p);
        if (live && (live.status === 'missing' || live.status === 'cancelled')) {
            const missing = live.status === 'missing';
            return {
                level: 'closed',
                kind: 'live',
                live,
                reason: missing ? 'Not on the City\'s live schedule' : 'Cancelled by the City',
                text: missing
                    ? 'toronto.ca\'s live schedule for this rink does not list this session (the City\'s weekly data export still does). Treat it as cancelled — verify on toronto.ca before travelling.'
                    : `toronto.ca lists this session as cancelled${live.note ? ': ' + live.note : ''}.`,
                postedDate: liveChangedAt || '',
                alerts
            };
        }
        if (!alerts.length) return null;

        const rink = window.SkateGeo ? window.SkateGeo.rinkByLocation(locId) : null;
        const locationKinds = rink ? rink.kinds : null;
        const pads = rink && Number.isFinite(rink.pads) ? rink.pads : 1;
        const programDate = (p['Start Date Time'] || p['Start Date'] || '').slice(0, 10);
        const kindsHere = kindsOn(locationKinds, programDate);

        const off = [], padOff = [], reduced = [], unknown = [], season = [], building = [], otherHours = [], ended = [];
        alerts.forEach(a => {
            const R = readingFor(a, pads);
            const ph = phaseOf(R, a, programDate, p);
            if (ph.phase === 'before') return;                       // not in force yet on that day
            if (ph.phase === 'ended') {                              // over by its own words
                if (R.skating !== 'on') ended.push({ a, end: ph.ended });
                return;
            }
            if (ph.phase === 'outside') { otherHours.push(a); return; }
            if (R.skating === 'off' && R.seasonal && laterSeason(a, programDate)) season.push(a);
            else if (R.skating === 'off') off.push(a);
            else if (R.skating === 'one_pad_off') padOff.push(a);
            else if (R.skating === 'reduced') reduced.push(a);
            else if (R.skating === 'on') building.push(a);
            else unknown.push(a);
        });

        const make = (level, kind, lead, list, extra = {}) => ({
            level, kind, lead, padOnly: false,
            reason: list[0].Reason || 'Service alert',
            text: list.map(lineFor).filter(Boolean).join(' • '),
            postedDate: list[0].PostedDate || '',
            alerts,
            ...extra
        });
        const serious = [...off, ...padOff, ...reduced, ...unknown];

        if (off.length) {
            const closedKinds = off.map(alertKind);
            if (coversLocation(closedKinds, kindsHere)) return make('closed', 'closed', 'Likely cancelled, rink alert', serious);
            // one kind of ice is closed at a place that has another (or that we know too little about)
            const which = closedKinds.includes('outdoor') ? 'outdoor' : 'indoor';
            const other = which === 'outdoor' ? 'indoor' : 'outdoor';
            const lead = kindsHere && kindsHere.includes(other)
                ? `The ${which} rink here is closed. Sessions on the ${other} ice are not affected`
                : 'Service alert at this rink';
            return make('warning', 'part', lead, serious);
        }
        if (padOff.length) return make('warning', 'pad', 'One pad is closed here. This session likely runs on the other pad', serious, { padOnly: true });
        if (reduced.length) return make('warning', 'reduced', 'Hours are reduced or some sessions are cancelled here', serious);
        if (unknown.length) return make('warning', 'alert', 'Service alert at this rink', serious);

        if (season.length) {
            // Last season's "closed for the season" notice: the rink has not been marked open again.
            const a = season[0];
            const posted = postedDay(a);
            const when = posted ? ` on ${fmtDay(posted)}` : '';
            const covers = coversLocation(season.map(alertKind), kindsHere);
            if (covers && isYmd(programDate) && programDate <= todayKey()) {
                return make('warning', 'season-today', 'Still marked closed for the season', season, {
                    reason: '',
                    text: `The City posted that notice${when} and has not lifted it. If the rink has not reopened yet, this session will not run.`
                });
            }
            return make('note', 'season', 'Still marked closed for the season', season, {
                reason: '',
                text: covers
                    ? `The City posted that notice${when}, before this season, and lifts it when the rink reopens. Opening day can move with the weather.`
                    : `That notice${when} is for ${season.map(x => x.AssetName).filter(Boolean).join(', ') || 'another rink here'}, from before this season.`
            });
        }
        if (otherHours.length) {
            return make('note', 'other-hours', 'Heads-up', otherHours, {
                text: `An alert here covers other hours that day: “${otherHours.map(a => cleanComment(a.Comments) || a.Reason || '').join(' • ')}”`
            });
        }
        if (building.length) return make('note', 'building', 'Building notice, skating not affected', building, { reason: '' });

        // v3.9: an alert that named its own end is over after that day. For four
        // days after, it is a grey heads-up ("there was an alert, worth a call");
        // later it says nothing about this session.
        const recent = ended.filter(x => daysBetween(x.end, programDate) <= 4).sort((x, y) => y.end.localeCompare(x.end))[0];
        if (!recent) return null;
        const a = recent.a;
        const posted = postedDay(a);
        return make('note', 'ended', 'Heads-up', [a], {
            ended: recent.end,
            text: `A rink alert${posted ? ` posted ${fmtDay(posted)}` : ''} was for ${fmtDay(recent.end)}, before this session: “${cleanComment(a.Comments) || a.Reason || ''}” Worth a quick call to the rink before you go.`,
            alerts: [a]
        });
    }

    /**
     * The alerts that matter at a rink today (rink list, map popups): in
     * force by their own words and about the ice. A building notice or an
     * alert that has not started yet does not flag the rink.
     */
    function forLocation(locId) {
        const today = todayKey();
        const rink = window.SkateGeo ? window.SkateGeo.rinkByLocation(String(locId)) : null;
        const pads = rink && Number.isFinite(rink.pads) ? rink.pads : 1;
        return (byLocation[String(locId)] || []).filter(a => {
            const R = readingFor(a, pads);
            if (R.skating === 'on') return false;
            const start = R.starts || postedDay(a);
            return !(start && today < start) && !(R.ends && today > R.ends);
        });
    }

    return {
        dateWindows,   // exposed for tests
        load, onUpdate, forProgram, forLocation, liveFor, isDropped,
        get loaded() { return loaded; },
        get fetchedAt() { return fetchedAt; },
        get checkedAt() { return checkedAt; },
        get reader() { return reader; },
        get liveCheckedAt() { return liveCheckedAt; },
        get liveChangedAt() { return liveChangedAt; },
        get liveWindow() { return liveWindow; },
        get liveStats() { return liveStats; },
        get liveExtra() { return liveExtra; },
        // exposed for testing
        _classifyHelpers: { alertKind, coversLocation, dateWindows, datesIn, ruleReading, readingFor, noticeSeason, seasonOf, sentences, index, isSkateAlert }
    };
})();

if (typeof module !== 'undefined') module.exports = window.SkateAlerts;
