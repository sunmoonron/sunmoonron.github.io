/**
 * SkateAlerts — toronto.ca service alerts, matched to programs.
 *
 * Data: projects/data/alerts.json — a CI snapshot of
 * https://www.toronto.ca/data/parks/live/skate_allupdates.json
 * (toronto.ca sends no CORS headers, so the browser can't hit it live;
 * the refresh-listener workflow re-snapshots it every ~30 min).
 *
 * Matching model:
 *  - Alerts are per-ASSET ("X Arena - Indoor Ice Rink", "Y Park - Outdoor
 *    Artificial Ice Rink") and keyed by the same city locationid the
 *    program records carry ('Location ID').
 *  - Only Category 'Skate' alerts count — a pool sauna closure at the
 *    same community centre must not flag a skate program.
 *  - Status 0  → that asset is CLOSED. If the closed asset kinds cover
 *    every rink kind at the location (via rinks.json), programs there are
 *    flagged 'closed' ("likely cancelled"). If only e.g. the outdoor pad
 *    of an indoor+outdoor site is closed, programs get a 'warning' instead
 *    — we can't know which pad a program uses, so we don't cry wolf.
 *  - Status 2  → service alert. Stays a 'warning' unless the comment text
 *    clearly says the rink/ice/skating itself is closed or cancelled AND
 *    any date range mentioned covers the program's date — then 'closed'.
 *    (Classic counter-example from the live feed: "parking lot will be
 *    unavailable" is a warning, not a cancellation.)
 *  - One pad of many (2026-09-15, the Don Montgomery lesson): a building
 *    with several ice pads whose alert names ONE of them ("Rink 1 is
 *    temporarily closed") keeps running its sessions on the other pad.
 *    That is a 'warning' flagged `padOnly`, never a cancellation, no
 *    matter how loud the closure wording is. Only text about the whole
 *    facility ("arena closed", "both rinks", "all ice") or a single-pad
 *    building can still cancel.
 *
 * This is deterministic on purpose: a static page can't call an LLM per
 * render, and every flag we show can be traced to a rule + the alert text
 * we display alongside it. The full alert text is always shown so the
 * human makes the final call.
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

    /* ---------- classification ---------- */

    const CLOSED_STATUS = 0;

    /** 'indoor' | 'outdoor' | 'any' from the alert's asset Type/name. */
    function alertKind(a) {
        const t = `${a.Type || ''} ${a.AssetName || ''}`.toLowerCase();
        if (t.includes('outdoor')) return 'outdoor';
        if (t.includes('indoor')) return 'indoor';
        return 'any';
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

    const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

    /**
     * Pull explicit date windows out of comment text:
     *   "from Monday, June 8 ... to June 15, 2026", "until July 20",
     *   "for the week of Monday, June 8, 2026", "June 8 - June 15".
     * Returns [{from:'YYYY-MM-DD'|null, to:'YYYY-MM-DD'|null}, …] (best effort).
     */
    function dateWindows(text, refYear) {
        const wins = [];
        const t = String(text || '');
        const monthRe = '(January|February|March|April|May|June|July|August|September|October|November|December)';
        const dRe = new RegExp(`${monthRe}\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?`, 'gi');
        const found = [];
        let m;
        while ((m = dRe.exec(t))) {
            const y = m[3] ? +m[3] : refYear;
            const key = `${y}-${String(MONTHS[m[1].toLowerCase()] + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
            found.push({ key, index: m.index });
        }
        if (!found.length) return wins;

        if (/week of/i.test(t) && found.length >= 1) {
            // "week of <date>" → 7-day window
            const from = found[0].key;
            const [y, mo, d] = from.split('-').map(Number);
            const to = new Date(Date.UTC(y, mo - 1, d + 6)).toISOString().slice(0, 10);
            wins.push({ from, to });
        }
        if (found.length >= 2) {
            wins.push({ from: found[0].key, to: found[found.length - 1].key });
        } else if (/until|through|up to/i.test(t)) {
            wins.push({ from: null, to: found[0].key });
        } else if (wins.length === 0) {
            wins.push({ from: found[0].key, to: found[0].key });
        }
        return wins;
    }

    /** Status-2 alert whose text really says the ice/rink/skating is off? */
    function textSaysRinkClosed(a) {
        const txt = `${a.Reason || ''} ${a.Comments || ''}`.toLowerCase();
        const closedWord = /(closed|closure|cancel+ed|cancel+ation|unavailable|out of service|no ice)/.test(txt);
        const rinkWord = /(rink|ice pad|\bice\b|skat)/.test(txt);
        // Exclude the "amenity, not the ice" pattern: parking, washroom, changeroom, sauna, lobby…
        const amenityOnly = /(parking|washroom|change\s*room|changeroom|sauna|lobby|elevator|locker)/.test(txt)
            && !/(rink|ice pad|skat)/.test(txt);
        return closedWord && rinkWord && !amenityOnly;
    }

    /**
     * Does the alert text single out ONE pad of a multi-pad building?
     * "Rink 1", "Pad B", "the north rink", "rink #2" → that pad only.
     * "both rinks", "all ice", "the arena/facility/building is closed" → no.
     */
    const PAD_RE = /\b(?:rink|pad|ice\s*pad|ice\s*surface|arena)\s*(?:#\s*)?(?:[0-9]{1,2}|[a-d]|one|two|three|north|south|east|west|main|upper|lower|small|big|large|olympic|nhl)\b|\b(?:north|south|east|west|main|upper|lower|small|big|large|olympic|nhl)\s+(?:rink|pad|ice)\b/i;
    const WHOLE_RE = /\b(?:both|all)\s+(?:rinks|pads|ice)|\b(?:arena|facility|building|centre|center|complex)\s+(?:is|will be|remains)?\s*(?:closed|closing)|\bentire\b|\bwhole\b|\bno ice\b/i;
    function namesOnePad(text, pads) {
        if (!(pads > 1)) return false;
        const t = String(text || '');
        return PAD_RE.test(t) && !WHOLE_RE.test(t);
    }

    function cleanComment(s) {
        return String(s || '')
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Alert verdict for one program.
     * → null (no skate alerts at its location) or
     *   { level: 'closed'|'warning', reason, text, postedDate, alerts:[…] }
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

        let level = 'warning';
        let padOnly = false;
        const closedKinds = alerts.filter(a => a.Status === CLOSED_STATUS).map(alertKind);
        const padAlerts = alerts.filter(a => namesOnePad(`${a.Reason || ''} ${cleanComment(a.Comments)}`, pads));
        if (padAlerts.length && padAlerts.length === alerts.length) {
            // every alert here is about one pad of several: the other pad keeps skating
            padOnly = true;
        } else if (closedKinds.length && coversLocation(closedKinds, locationKinds)) {
            level = 'closed';
        } else {
            // Status-2 escalation: text says rink closed + date window covers program
            for (const a of alerts) {
                if (a.Status === CLOSED_STATUS || !textSaysRinkClosed(a)) continue;
                const wins = dateWindows(a.Comments, +(programDate.slice(0, 4) || new Date().getFullYear()));
                if (!wins.length) { level = 'closed'; break; } // no dates given → assume it applies now
                if (programDate && wins.some(w => (!w.from || programDate >= w.from) && (!w.to || programDate <= w.to))) {
                    level = 'closed';
                    break;
                }
            }
        }

        const first = alerts[0];
        // Lead with the asset name so "outdoor pad closed" can't read as
        // "this indoor session is closed" — the reader sees which pad.
        const text = alerts.map(a => {
            const what = cleanComment(a.Comments) || a.Reason || '';
            return a.AssetName ? `${a.AssetName}: ${what}` : what;
        }).filter(Boolean).join(' • ');
        return {
            level,
            padOnly,
            reason: first.Reason || 'Service alert',
            text,
            postedDate: first.PostedDate || '',
            alerts
        };
    }

    /** All skate alerts for a location id (locator modal uses this). */
    function forLocation(locId) {
        return byLocation[String(locId)] || [];
    }

    return {
        load, onUpdate, forProgram, forLocation, liveFor, isDropped,
        get loaded() { return loaded; },
        get fetchedAt() { return fetchedAt; },
        get checkedAt() { return checkedAt; },
        get liveCheckedAt() { return liveCheckedAt; },
        get liveChangedAt() { return liveChangedAt; },
        get liveWindow() { return liveWindow; },
        get liveStats() { return liveStats; },
        get liveExtra() { return liveExtra; },
        // exposed for testing
        _classifyHelpers: { alertKind, coversLocation, dateWindows, textSaysRinkClosed, namesOnePad, index, isSkateAlert }
    };
})();

if (typeof module !== 'undefined') module.exports = window.SkateAlerts;
